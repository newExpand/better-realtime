import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { FlightRecorder } from "@realtime/diagnostics";
import { BETTER_REALTIME_SUBPROTOCOL, assertCapabilityInvariants, decodeWireMessage, isClientToServerMessage, type Capabilities, type CommandMessage, type CommandStatusRequest, type ContractIdentity, type ErrorInfo, type EventMessage, type JsonValue, type SessionOpen, type StreamSubscribe } from "@realtime/protocol";
import { PostgresEventLog, TransactionOutcomeError, TransactionRolledBackError, type IdentityKey, type PostgresStoredEvent, type PostgresTransactionOptions, type TransactionOperationLease } from "@realtime/store-postgres";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthenticatedPrincipal } from "./demo-auth.ts";
import { compileWebSocketOriginPolicy, verifyWebSocketOrigin, type CompiledWebSocketOriginPolicy, type WebSocketOriginPolicy } from "./origin-policy.ts";

interface SubscriptionState {
  stream: string;
  input: JsonValue;
  cursor: string;
  recovering: boolean;
}

interface GatewayClient {
  socket: WebSocket;
  closed: boolean;
  opened: boolean;
  sessionGeneration: number;
  subscriptions: Map<string, SubscriptionState>;
  openDeadline: ReturnType<typeof setTimeout>;
  processing: Promise<void>;
  queuedMessages: number;
  queuedBytes: number;
  rateWindowStartedAt: number;
  rateWindowMessages: number;
  sessionId?: string;
  traceId?: string;
  tenantId?: string;
  principalNamespaceId?: string;
  permissions?: Set<string>;
  heartbeatInterval?: ReturnType<typeof setInterval>;
  heartbeatTimeout?: ReturnType<typeof setTimeout>;
  pendingPingId?: string;
}

class GatewayApplicationError extends Error {
  constructor(readonly scope: "command" | "stream" | "runtime", readonly originalError: unknown, readonly commandId?: string, readonly stream?: string) { super("RT_APPLICATION_OPERATION_FAILED", { cause: originalError }); }
}

class ApplicationHookUnavailable extends Error {
  constructor(readonly reason: "timeout" | "capacity") { super(reason === "timeout" ? "RT_APPLICATION_OPERATION_TIMEOUT" : "RT_APPLICATION_HOOK_CAPACITY"); }
}

interface TrustedDatabaseQueryFailure { readonly infrastructureFailure: boolean; readonly sqlstate?: string }
const trustedApplicationDatabaseCauses = new WeakMap<GatewayApplicationError, TrustedDatabaseQueryFailure>();

export interface PostgresGatewayDatabase {
  query<TResult extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<TResult>>;
}

export interface PostgresGatewayApplicationContext {
  tenantId: string;
  principalNamespaceId: string;
  permissions: ReadonlySet<string>;
  traceId?: string;
  sessionId?: string;
}

export interface PostgresGatewaySnapshotReadContext {
  tenantId: string;
  principalNamespaceId: string;
  permissions: ReadonlySet<string>;
  traceId?: string;
  sessionId?: string;
  stream: string;
  input: JsonValue;
  includedSequence: number;
}

export interface PostgresGatewayCommandMutationContext {
  tenantId: string;
  principalNamespaceId: string;
  commandId: string;
  stream: string;
  sequence: number;
  eventId: string;
}

export interface PostgresGatewayCommandPlan {
  stream: string;
  eventType: string;
  eventSchema: string;
  eventData: JsonValue;
  resultSchema: string;
  mutate(database: PostgresGatewayDatabase, context: PostgresGatewayCommandMutationContext): Promise<JsonValue>;
}

export interface PostgresGatewayCommandResult {
  commandId: string;
  schema: string;
  result: JsonValue;
  eventId: string;
  stream: string;
  sequence: number;
}

export interface PostgresGatewayApplication {
  authorizeStream?(context: PostgresGatewayApplicationContext, message: StreamSubscribe): boolean | Promise<boolean>;
  snapshot?: {
    schema: string | ((context: PostgresGatewayApplicationContext, message: StreamSubscribe) => string);
    read(database: PostgresGatewayDatabase, context: PostgresGatewaySnapshotReadContext): Promise<JsonValue>;
  };
  authorizeCommand?(context: PostgresGatewayApplicationContext, message: CommandMessage): boolean | Promise<boolean>;
  executeCommand?(context: PostgresGatewayApplicationContext, message: CommandMessage): PostgresGatewayCommandPlan | null | Promise<PostgresGatewayCommandPlan | null>;
  validateOutboundEvent?(context: PostgresGatewayApplicationContext, event: PostgresStoredEvent, subscription: { stream: string; input: JsonValue }): boolean;
  validateCommandResult?(context: PostgresGatewayApplicationContext, result: PostgresGatewayCommandResult): boolean;
}

export interface PostgresGatewayOptions {
  pool: Pool;
  runtimeId: string;
  runtimeBootId?: string;
  port?: number;
  host?: string;
  originPolicy: WebSocketOriginPolicy;
  contract: ContractIdentity;
  storageSchema?: string;
  identityKeys: IdentityKey[];
  commandResultRetentionMs?: number;
  idempotencyRetentionMs?: number;
  replayRetentionMs?: number;
  heartbeat?: { intervalMs: number; timeoutMs: number };
  pollIntervalMs?: number;
  maxOutboundBufferedBytes?: number;
  maxClients?: number;
  maxSubscriptionsPerClient?: number;
  maxInboundQueueMessages?: number;
  maxInboundQueueBytes?: number;
  maxInboundMessagesPerSecond?: number;
  maxApplicationHooks?: number;
  drainTimeoutMs?: number;
  recorderLimits?: { maxRecords: number; maxBytes: number; maxAgeMs: number };
  databaseRecorderLimits?: { maxRecords: number; maxBytes: number; maxAgeMs: number };
  topologyId?: string;
  authenticate(auth: JsonValue): Promise<AuthenticatedPrincipal> | AuthenticatedPrincipal;
  maintenanceIntervalMs?: number;
  outboxRetentionMs?: number;
  publishOutbox?: (store: PostgresEventLog, limit: number) => Promise<number>;
  transactionOptions?: PostgresTransactionOptions;
  application?: PostgresGatewayApplication;
  /** Test-harness-only raw evidence, inspection, and chaos HTTP routes. Disabled by default. */
  enableTestControlPlane?: boolean;
}

const POSTGRES_GATEWAY_EVIDENCE_COMPONENT = {
  component: "postgres-gateway",
  componentVersion: "0.5.0"
} as const;

function sameContractIdentity(actual: ContractIdentity, expected: ContractIdentity): boolean {
  return actual.contractId === expected.contractId && actual.manifestVersion === expected.manifestVersion && actual.manifestDigest === expected.manifestDigest;
}

export class PostgresGatewayServer {
  readonly store: PostgresEventLog;
  readonly recorder: FlightRecorder;
  readonly capabilities: Capabilities;
  readonly host: string;
  readonly heartbeat: { intervalMs: number; timeoutMs: number };
  readonly maxOutboundBufferedBytes: number;
  readonly maxClients: number;
  readonly maxSubscriptionsPerClient: number;
  readonly maxInboundQueueMessages: number;
  readonly maxInboundQueueBytes: number;
  readonly maxInboundMessagesPerSecond: number;
  readonly maxApplicationHooks: number;
  readonly drainTimeoutMs: number;
  #port: number;
  #http: HttpServer | undefined;
  #wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  #clients = new Set<GatewayClient>();
  #sessionGeneration = 0;
  #accepting = false;
  #databaseReady = false;
  #listenerReady = false;
  #outboxReady = false;
  #listenDispose: (() => Promise<void>) | undefined;
  #publisherTimer: ReturnType<typeof setInterval> | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #healthTimer: ReturnType<typeof setInterval> | undefined;
  #maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #publisherActive = false;
  #catchupActive = false;
  #draining = false;
  #loseNextAck = false;
  #dropNextNotification = false;
  #interleaveNextReplay = false;
  #commandsActive = 0;
  #applicationHooks = new Set<object>();
  #startPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #started = false;
  #disposed = false;
  readonly #testControlPlaneEnabled: boolean;
  readonly #originPolicy: CompiledWebSocketOriginPolicy;

  constructor(private readonly options: PostgresGatewayOptions) {
    this.#port = options.port ?? 0;
    this.host = options.host ?? "127.0.0.1";
    this.heartbeat = validateHeartbeat(options.heartbeat ?? { intervalMs: 25_000, timeoutMs: 20_000 });
    this.maxOutboundBufferedBytes = positiveBound(options.maxOutboundBufferedBytes ?? 1_048_576, "RT_MAX_OUTBOUND_BUFFER_INVALID");
    this.maxClients = positiveBound(options.maxClients ?? 1_000, "RT_MAX_CLIENTS_INVALID");
    this.maxSubscriptionsPerClient = positiveBound(options.maxSubscriptionsPerClient ?? 100, "RT_MAX_SUBSCRIPTIONS_INVALID");
    this.maxInboundQueueMessages = positiveBound(options.maxInboundQueueMessages ?? 64, "RT_MAX_INBOUND_QUEUE_INVALID");
    this.maxInboundQueueBytes = positiveBound(options.maxInboundQueueBytes ?? 4_194_304, "RT_MAX_INBOUND_QUEUE_BYTES_INVALID");
    this.maxInboundMessagesPerSecond = positiveBound(options.maxInboundMessagesPerSecond ?? 100, "RT_MAX_INBOUND_RATE_INVALID");
    this.maxApplicationHooks = positiveBound(options.maxApplicationHooks ?? this.maxClients, "RT_MAX_APPLICATION_HOOKS_INVALID");
    this.drainTimeoutMs = boundedDuration(options.drainTimeoutMs ?? 250, "RT_DRAIN_TIMEOUT_INVALID");
    this.#testControlPlaneEnabled = Object.hasOwn(options, "enableTestControlPlane") && options.enableTestControlPlane === true;
    this.#originPolicy = compileWebSocketOriginPolicy(options.originPolicy);
    this.recorder = new FlightRecorder({ runtimeId: options.runtimeId, ...(options.runtimeBootId ? { runtimeBootId: options.runtimeBootId } : {}), producerRole: "server", ...(options.recorderLimits ? { limits: options.recorderLimits } : {}) });
    this.store = new PostgresEventLog(options.pool, new FlightRecorder({ runtimeId: `${options.runtimeId}:postgres`, ...(options.runtimeBootId ? { runtimeBootId: options.runtimeBootId } : {}), producerRole: "database", ...(options.databaseRecorderLimits ? { limits: options.databaseRecorderLimits } : options.recorderLimits ? { limits: options.recorderLimits } : {}) }), options.transactionOptions, options.storageSchema ? { schema: options.storageSchema } : {});
    this.capabilities = {
      schemaValidation: true,
      eventIdentity: true,
      ordering: "per_stream",
      gapDetection: true,
      durableReplay: true,
      snapshotResync: "fenced",
      idempotentCommands: true,
      commandReceipts: true,
      clientApplyAck: false,
      eventDedupeWindowMs: 300_000,
      replayRetentionMs: options.replayRetentionMs ?? 86_400_000,
      commandResultRetentionMs: options.commandResultRetentionMs ?? 60_000,
      idempotencyRetentionMs: options.idempotencyRetentionMs ?? 120_000,
      maxMessageBytes: 1_048_576,
      maxRecoveryBufferRecords: 10_000,
      maxRecoveryBufferBytes: 16_777_216
    };
    assertCapabilityInvariants(this.capabilities);
  }

  get port(): number { return this.#port; }
  get httpUrl(): string { return `http://${this.host}:${this.#port}`; }
  get webSocketUrl(): string { return `ws://${this.host}:${this.#port}/ws`; }
  get ready(): boolean { return this.#accepting && this.#databaseReady && this.#listenerReady && this.#outboxReady && !this.#draining; }

  databaseUnavailable(error: unknown): void { this.#databaseUnavailable(error); }

  start(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("RT_SERVER_DISPOSED"));
    if (this.#startPromise) return this.#startPromise;
    let startPromise: Promise<void>;
    startPromise = this.#startOwned().finally(() => {
      if (!this.#started && this.#startPromise === startPromise) this.#startPromise = undefined;
    });
    this.#startPromise = startPromise;
    return startPromise;
  }

  async #startOwned(): Promise<void> {
    try {
      await this.store.assertReady(this.options.contract);
      this.#assertStartAllowed();
      this.#listenDispose = await this.store.listen(() => {
      if (this.#dropNextNotification) {
        this.#dropNextNotification = false;
        this.recorder.record({ kind: "notification.dropped_injected", boundary: "notification.dropped_injected", outcome: "failure", reasonCode: "RT_NOTIFICATION_MISSED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT });
        return;
      }
      void this.#catchUpAll();
      }, (error) => this.#databaseUnavailable(error));
      this.#assertStartAllowed();
      this.#listenerReady = true;
      this.#databaseReady = await this.store.health();
      this.#assertStartAllowed();
      this.#outboxReady = false;
      this.#accepting = false;
      this.#http = createServer((request, response) => { void this.#httpRequest(request, response); });
      this.#http.on("upgrade", (request, socket, head) => {
      if (!this.ready || request.url !== "/ws") { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      const origin = verifyWebSocketOrigin(request.headers.origin, this.#originPolicy);
      this.recorder.record(origin.allowed
        ? { kind: "security.origin_checked", boundary: "security.origin_checked", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, details: { clientKind: origin.kind, originPresent: request.headers.origin !== undefined } }
        : { kind: "transport.upgrade_rejected", boundary: "transport.upgrade_rejected", outcome: "failure", reasonCode: origin.reasonCode, ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, details: { originPresent: request.headers.origin !== undefined } });
      if (!origin.allowed) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      if (this.#clients.size >= this.maxClients) {
        this.recorder.record({ kind: "resource.limit_exceeded", boundary: "connection.rejected", outcome: "failure", reasonCode: "RT_RESOURCE_LIMIT_EXCEEDED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, details: { resourceType: "session", maxRecords: this.maxClients } });
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n"); socket.destroy(); return;
      }
      this.#wss.handleUpgrade(request, socket, head, (webSocket) => this.#connection(webSocket, request));
      });
      await listenHttp(this.#http, this.#port, this.host);
      this.#assertStartAllowed();
      const address = this.#http.address();
      if (address && typeof address !== "string") this.#port = address.port;
      if (this.#databaseReady) await this.#publishTick();
      this.#accepting = this.#databaseReady && this.#listenerReady && this.#outboxReady && !this.#draining;
      const interval = this.options.pollIntervalMs ?? 100;
      this.#publisherTimer = setInterval(() => { void this.#publishTick(); }, Math.max(25, interval));
      this.#pollTimer = setInterval(() => { void this.#catchUpAll(); }, interval);
      this.#healthTimer = setInterval(() => { void this.#healthTick(); }, Math.max(100, interval));
      this.#maintenanceTimer = setInterval(() => { void this.#maintenanceTick(); }, Math.max(250, this.options.maintenanceIntervalMs ?? 1_000));
      this.recorder.record({ kind: "topology.expected", boundary: "topology.expected", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(this.options.topologyId ? { traceId: this.options.topologyId } : {}), details: { runtimeId: this.recorder.runtimeId, runtimeBootId: this.recorder.runtimeBootId } });
      this.recorder.record(this.ready
      ? { kind: "gateway.ready", boundary: "gateway.ready", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(this.options.topologyId ? { traceId: this.options.topologyId } : {}), details: this.#healthDetails() }
      : { kind: "gateway.unready", boundary: "gateway.ready", outcome: "failure", reasonCode: "RT_DATABASE_UNAVAILABLE", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(this.options.topologyId ? { traceId: this.options.topologyId } : {}), details: this.#healthDetails() });
      this.#started = true;
    } catch (error) {
      await this.#releaseRuntimeAllocations();
      this.recorder.record({ kind: "gateway.start_failed", boundary: "gateway.start_failed", outcome: "failure", reasonCode: "RT_GATEWAY_START_FAILED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT });
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    const pendingStart = this.#startPromise;
    this.#disposePromise = (async () => {
      await pendingStart?.catch(() => undefined);
      await this.#disposeOwned();
    })();
    return this.#disposePromise;
  }

  async #disposeOwned(): Promise<void> {
    await this.#releaseRuntimeAllocations(true);
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    this.#started = false;
  }

  async #releaseRuntimeAllocations(terminal = false): Promise<void> {
    this.#accepting = false;
    this.#draining = terminal;
    if (this.#publisherTimer) clearInterval(this.#publisherTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
    if (this.#drainTimer) clearTimeout(this.#drainTimer);
    this.#publisherTimer = undefined; this.#pollTimer = undefined; this.#healthTimer = undefined; this.#maintenanceTimer = undefined; this.#drainTimer = undefined;
    for (const client of this.#clients) { this.#clearClientTimers(client); client.socket.close(1001, "gateway shutdown"); }
    this.#clients.clear();
    this.#applicationHooks.clear();
    if (this.#listenDispose) await this.#listenDispose().catch(() => undefined);
    this.#listenDispose = undefined;
    this.#listenerReady = false;
    this.#databaseReady = false;
    this.#outboxReady = false;
    if (this.#http?.listening) await new Promise<void>((resolve) => this.#http!.close(() => resolve()));
    this.#http = undefined;
  }

  #assertStartAllowed(): void {
    if (this.#disposed) throw new Error("RT_SERVER_DISPOSED");
  }

  gracefulDrain(handoffReason = "operator_requested"): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#accepting = false;
    for (const client of this.#clients) {
      this.recorder.record({ kind: "session.drain_started", boundary: "session.drain_started", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), ...(client.sessionId ? { sessionId: client.sessionId } : {}), details: { reason: handoffReason } });
      for (const subscription of client.subscriptions.values()) {
        this.recorder.record({ kind: "gateway.drain_started", boundary: "gateway.drain_started", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), stream: subscription.stream, causalHandoffId: handoffId(client.tenantId!, subscription.stream, subscription.cursor), details: { reason: handoffReason, cursor: subscription.cursor } });
      }
      this.#error(client, { code: "RT_SERVER_DRAINING", scope: "session", disposition: "retry", retryable: true, retryAfterMs: 50 });
      client.socket.close(1012, "gateway draining");
    }
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = undefined;
      for (const client of this.#clients) client.socket.terminate();
    }, this.drainTimeoutMs);
  }

  loseNextAck(): void { this.#loseNextAck = true; }
  dropNextNotification(): void { this.#dropNextNotification = true; }
  interleaveNextReplay(): void { this.#interleaveNextReplay = true; }

  async injectDuplicate(tenantId = "tenant-demo", stream = "room:42"): Promise<void> {
    const event = await this.store.latestEvent(tenantId, stream);
    if (!event) return;
    for (const client of this.#clients) {
      for (const [subscriptionId, subscription] of client.subscriptions) if (client.tenantId === tenantId && subscription.stream === stream) this.#sendEvent(client, subscriptionId, event, "live", undefined, `duplicate_${crypto.randomUUID()}`);
    }
  }

  #connection(socket: WebSocket, request: IncomingMessage): void {
    if (request.headers["sec-websocket-protocol"] !== BETTER_REALTIME_SUBPROTOCOL) { socket.close(1002, "subprotocol required"); return; }
    const client: GatewayClient = { socket, closed: false, opened: false, sessionGeneration: 0, subscriptions: new Map(), processing: Promise.resolve(), queuedMessages: 0, queuedBytes: 0, rateWindowStartedAt: Date.now(), rateWindowMessages: 0, openDeadline: setTimeout(() => { this.#error(client, { code: "RT_SESSION_INIT_TIMEOUT", scope: "session", disposition: "fail_session", retryable: false }); socket.close(1008, "session init timeout"); }, 10_000) };
    this.#clients.add(client);
    socket.on("message", (data) => {
      const now = Date.now();
      if (now - client.rateWindowStartedAt >= 1_000) { client.rateWindowStartedAt = now; client.rateWindowMessages = 0; }
      client.rateWindowMessages += 1;
      if (client.rateWindowMessages > this.maxInboundMessagesPerSecond) {
        this.recorder.record({ kind: "resource.limit_exceeded", boundary: "message.rate_limited", outcome: "failure", reasonCode: "RT_RESOURCE_LIMIT_EXCEEDED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.sessionId ? { sessionId: client.sessionId } : {}), details: { resourceType: "inbound_rate", maxMessagesPerSecond: this.maxInboundMessagesPerSecond } });
        socket.close(1013, "message rate exceeded");
        return;
      }
      const raw = data.toString();
      const bytes = Buffer.byteLength(raw);
      if (client.queuedMessages + 1 > this.maxInboundQueueMessages || client.queuedBytes + bytes > this.maxInboundQueueBytes) {
        this.recorder.record({ kind: "resource.limit_exceeded", boundary: "message.rejected", outcome: "failure", reasonCode: "RT_RESOURCE_LIMIT_EXCEEDED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.sessionId ? { sessionId: client.sessionId } : {}), details: { resourceType: "inbound_queue", nextRecords: client.queuedMessages + 1, nextBytes: client.queuedBytes + bytes, maxRecords: this.maxInboundQueueMessages, maxBytes: this.maxInboundQueueBytes } });
        socket.close(1009, "inbound queue capacity exceeded");
        return;
      }
      client.queuedMessages += 1;
      client.queuedBytes += bytes;
      client.processing = client.processing.then(() => client.closed ? undefined : this.#message(client, raw)).catch((error) => this.#operationFailure(client, error)).finally(() => {
        client.queuedMessages -= 1;
        client.queuedBytes -= bytes;
        if (client.closed && client.queuedMessages === 0) this.#clients.delete(client);
      });
    });
    socket.on("error", (error: Error & { code?: string }) => {
      this.recorder.record({ kind: "transport.receive_failed", boundary: "message.rejected", outcome: "failure", reasonCode: error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? "RT_MESSAGE_TOO_LARGE" : "RT_TRANSPORT_RECEIVE_FAILED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, details: { code: error.code ?? "unknown" } });
    });
    socket.on("close", () => {
      client.closed = true;
      client.subscriptions.clear();
      this.#clearClientTimers(client);
      if (client.queuedMessages === 0) this.#clients.delete(client);
    });
    this.recorder.record({ kind: "transport.opened", boundary: "transport.opened", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT });
  }

  async #message(client: GatewayClient, raw: string): Promise<void> {
    const decoded = decodeWireMessage(raw, this.capabilities.maxMessageBytes);
    if (!decoded.ok) { this.#error(client, { code: decoded.code, scope: "message", disposition: "fail_session", retryable: false }); client.socket.close(1008, decoded.code); return; }
    const message = decoded.value;
    if (!client.opened && message.kind !== "session.open") { this.#error(client, { code: "RT_MESSAGE_INVALID", scope: "session", disposition: "fail_session", retryable: false }); client.socket.close(1008, "session.open required"); return; }
    if (client.opened && message.kind === "session.open") { this.#error(client, { code: "RT_MESSAGE_INVALID", scope: "session", disposition: "fail_session", retryable: false }); client.socket.close(1008, "duplicate session.open"); return; }
    if (!isClientToServerMessage(message)) { this.#error(client, { code: "RT_MESSAGE_INVALID", scope: "message", disposition: "fail_session", retryable: false }); client.socket.close(1008, "invalid direction"); return; }
    if (client.opened && (this.#draining || !this.ready)) {
      const reasonCode = this.#databaseReady && this.#listenerReady && this.#outboxReady ? "RT_SERVER_DRAINING" : "RT_DATABASE_UNAVAILABLE";
      this.recorder.record({ kind: "session.operation_rejected", boundary: "session.operation_rejected", outcome: "failure", reasonCode, ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), ...(client.sessionId ? { sessionId: client.sessionId } : {}), ...(client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), ...( "commandId" in message && typeof message.commandId === "string" ? { commandId: message.commandId } : {}), details: { ...(client.tenantId ? { tenantId: client.tenantId } : {}), ...(client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), kind: message.kind, durableSuccessClaimed: false } });
      this.#error(client, { code: reasonCode, scope: "session", disposition: "retry", retryable: true, retryAfterMs: 250 });
      return;
    }
    switch (message.kind) {
      case "session.open": await this.#open(client, message); break;
      case "session.auth.update":
        this.recorder.record({ kind: "session.unsupported_behavior", boundary: "session.unsupported_behavior", outcome: "failure", reasonCode: "RT_AUTH_REFRESH_UNSUPPORTED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), ...(client.sessionId ? { sessionId: client.sessionId } : {}), details: { kind: message.kind } });
        this.#error(client, { code: "RT_AUTH_REFRESH_UNSUPPORTED", scope: "session", disposition: "fail_session", retryable: false });
        client.socket.close(1008, "auth refresh unsupported");
        break;
      case "heartbeat.pong": this.#pong(client, message.pingId); break;
      case "stream.subscribe": await this.#subscribe(client, message); break;
      case "stream.unsubscribe": client.subscriptions.delete(message.subscriptionId); this.#send(client, { kind: "stream.unsubscribed", requestId: message.requestId, subscriptionId: message.subscriptionId }); break;
      case "command": await this.#command(client, message); break;
      case "command.status.request": await this.#commandStatus(client, message); break;
      default: this.#error(client, { code: "RT_MESSAGE_INVALID", scope: "message", disposition: "fail_session", retryable: false });
    }
  }

  async #open(client: GatewayClient, message: SessionOpen): Promise<void> {
    clearTimeout(client.openDeadline);
    if (!this.ready) { this.#error(client, { code: "RT_DATABASE_UNAVAILABLE", scope: "session", disposition: "retry", retryable: true, retryAfterMs: 250 }); client.socket.close(1013, "gateway not ready"); return; }
    if (!sameContractIdentity(message.contract, this.options.contract)) { this.#send(client, { kind: "session.rejected", error: { code: "RT_CONTRACT_INCOMPATIBLE", scope: "session", disposition: "fail_session", retryable: false } }); client.socket.close(1008, "contract incompatible"); return; }
    let principal: AuthenticatedPrincipal;
    try { principal = await this.#runApplicationHook(client, "authentication", () => this.options.authenticate(message.auth)); }
    catch (error) {
      if (error instanceof ApplicationHookUnavailable) {
        this.recorder.record({ kind: "application.hook_unavailable", boundary: "application.hook_unavailable", outcome: "failure", reasonCode: error.reason === "timeout" ? "RT_APPLICATION_OPERATION_TIMEOUT" : "RT_RESOURCE_LIMIT_EXCEEDED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, details: { operation: "authentication", response: "generic_retry" } });
        this.#send(client, { kind: "session.rejected", error: { code: "RT_OPERATION_UNAVAILABLE", scope: "session", disposition: "retry", retryable: true, retryAfterMs: 250 } });
        client.socket.close(1013, "authentication temporarily unavailable");
      } else {
        this.#send(client, { kind: "session.rejected", error: { code: "RT_AUTH_REQUIRED", scope: "session", disposition: "fail_session", retryable: false } });
        client.socket.close(1008, "authentication required");
      }
      return;
    }
    if (client.closed) return;
    const principalNamespaceId = await this.store.resolvePrincipalNamespace({ tenantId: principal.tenantId, authenticationRealm: principal.authenticationRealm, issuer: principal.issuer, subject: principal.subject, keys: this.options.identityKeys });
    if (client.closed) return;
    client.opened = true;
    client.tenantId = principal.tenantId;
    client.principalNamespaceId = principalNamespaceId;
    client.permissions = new Set(principal.permissions);
    client.traceId = message.connectionAttemptId;
    client.sessionId = `session_${crypto.randomUUID()}`;
    client.sessionGeneration = ++this.#sessionGeneration;
    this.#send(client, { kind: "session.ready", sessionId: client.sessionId, sessionGeneration: client.sessionGeneration, authGeneration: 1, resumeStatus: message.resume ? "unavailable" : "fresh", ...(message.resume ? { resumeUnavailableReason: "not_found" } : {}), capabilities: this.capabilities, heartbeat: { mode: "application", ...this.heartbeat } });
    this.recorder.record({ kind: "session.accepted", boundary: "session.accepted", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: client.traceId, sessionId: client.sessionId, details: { tenantId: client.tenantId, principalNamespaceId, sessionGeneration: client.sessionGeneration } });
    client.heartbeatInterval = setInterval(() => this.#ping(client), this.heartbeat.intervalMs);
  }

  async #subscribe(client: GatewayClient, message: StreamSubscribe): Promise<void> {
    this.#requirePrincipal(client);
    if (client.subscriptions.size >= this.maxSubscriptionsPerClient) {
      this.recorder.record({ kind: "resource.limit_exceeded", boundary: "subscription.rejected", outcome: "failure", reasonCode: "RT_RESOURCE_LIMIT_EXCEEDED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.sessionId ? { sessionId: client.sessionId } : {}), stream: message.stream, details: { tenantId: client.tenantId, resourceType: "subscription", nextRecords: client.subscriptions.size + 1, maxRecords: this.maxSubscriptionsPerClient } });
      this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: "stream", disposition: "fail_operation", retryable: false, stream: message.stream });
      return;
    }
    const applicationContext = this.#applicationContext(client);
    let authorized: boolean;
    try {
      authorized = this.options.application?.authorizeStream
        ? await this.#runApplicationHook(client, "stream_authorization", () => this.options.application!.authorizeStream!(applicationContext, message))
        : client.permissions?.has("room:42:read") === true && message.stream === "room:42" && typeof message.input === "object" && message.input !== null && !Array.isArray(message.input) && (message.input as Record<string, JsonValue>).roomId === "42";
    } catch (error) { throw new GatewayApplicationError("stream", error, undefined, message.stream); }
    if (!authorized) {
      this.recorder.record({ kind: "authorization.denied", boundary: "authorization.denied", outcome: "failure", reasonCode: "RT_AUTH_REQUIRED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), stream: message.stream, details: { response: "generic" } });
      this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: "stream", disposition: "fail_operation", retryable: false, stream: message.stream });
      return;
    }
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    const tenantId = client.tenantId!;
    const stream = message.stream;
    const initialCursor = message.after ?? "";
    client.subscriptions.set(subscriptionId, { stream, input: message.input, cursor: initialCursor, recovering: true });
    try {
      if (!message.after) {
        await this.#snapshot(client, subscriptionId, message);
        return;
      }
      const head = await this.store.head(tenantId, stream);
      const state = client.subscriptions.get(subscriptionId)!;
      const first = head ? (await this.store.readAfter(tenantId, stream, message.after, 1))[0] : undefined;
      if (!head || !first || first.sequence > decodeSequence(head)) {
        state.cursor = head ?? message.after;
        state.recovering = false;
        if (!this.#send(client, { kind: "stream.subscribed", requestId: message.requestId, subscriptionId, stream, mode: "live", baseline: message.after, head })) client.subscriptions.delete(subscriptionId);
        return;
      }
      const replayId = `replay_${crypto.randomUUID()}`;
      const causalHandoffId = handoffId(tenantId, stream, message.after);
      if (!this.#send(client, { kind: "stream.subscribed", requestId: message.requestId, subscriptionId, stream, mode: "replay", baseline: message.after, head }) || !this.#send(client, { kind: "stream.replay.begin", subscriptionId, replayId, stream, requestedAfter: message.after, head })) { client.subscriptions.delete(subscriptionId); return; }
      this.recorder.record({ kind: "replay.selected", boundary: "replay.selected", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: replayId, causalHandoffId, stream, details: { tenantId, requestedAfter: message.after, head } });
      this.recorder.record({ kind: "causal.handoff", boundary: "causal.handoff", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: replayId, causalHandoffId, ...(client.sessionId ? { sessionId: client.sessionId } : {}), stream, details: { tenantId, requestedAfter: message.after } });
      const replay = await this.#deliverThroughHead(client, subscriptionId, tenantId, stream, message.after, decodeSequence(head), "replay", replayId, async () => {
        if (!this.#interleaveNextReplay) return;
        this.#interleaveNextReplay = false;
        await this.#appendSystemMessage(tenantId, stream, "Live event held behind the PostgreSQL replay fence.");
        await this.#publishTick();
      });
      if (!replay.complete) { client.subscriptions.delete(subscriptionId); return; }
      state.cursor = head;
      if (!this.#send(client, { kind: "stream.replay.complete", subscriptionId, replayId, stream, through: head })) { client.subscriptions.delete(subscriptionId); return; }
      state.recovering = false;
      await this.#catchUpAll();
    } catch (error) {
      if (error instanceof Error && error.message === "RT_CURSOR_EXPIRED") { await this.#snapshot(client, subscriptionId, message, "cursor_expired"); return; }
      client.subscriptions.delete(subscriptionId);
      throw error;
    }
  }

  async #snapshot(client: GatewayClient, subscriptionId: string, message: StreamSubscribe, reason: "client_requested" | "cursor_expired" = "client_requested"): Promise<void> {
    const tenantId = client.tenantId!;
    const applicationContext = this.#applicationContext(client);
    const applicationSnapshot = this.options.application?.snapshot;
    let snapshotSchema: string;
    try { snapshotSchema = applicationSnapshot ? typeof applicationSnapshot.schema === "function" ? applicationSnapshot.schema(applicationContext, message) : applicationSnapshot.schema : "RoomSnapshot@1"; }
    catch (error) { throw new GatewayApplicationError("stream", error, undefined, message.stream); }
    const snapshot = applicationSnapshot
      ? await this.store.atomicSnapshotWith(tenantId, message.stream, async (database, context) => {
          return withApplicationDatabase(database, context.operation, (error) => new GatewayApplicationError("stream", error, undefined, message.stream), (applicationDatabase) => this.#trackApplicationWork(client, "snapshot_read", () => applicationSnapshot.read(applicationDatabase, { tenantId, principalNamespaceId: applicationContext.principalNamespaceId, permissions: applicationContext.permissions, ...(applicationContext.traceId ? { traceId: applicationContext.traceId } : {}), ...(applicationContext.sessionId ? { sessionId: applicationContext.sessionId } : {}), stream: message.stream, input: message.input, includedSequence: context.includedSequence })));
        })
      : await this.store.atomicSnapshot(tenantId, message.stream);
    const state = client.subscriptions.get(subscriptionId)!;
    state.cursor = snapshot.cursor;
    const resyncId = `resync_${crypto.randomUUID()}`;
    const replayId = `replay_${crypto.randomUUID()}`;
    if (!this.#send(client, { kind: "stream.subscribed", requestId: message.requestId, subscriptionId, stream: message.stream, mode: "snapshot", baseline: message.after ?? null, head: snapshot.head }) || !this.#send(client, { kind: "stream.resync.required", subscriptionId, resyncId, stream: message.stream, reason }) || !this.#send(client, { kind: "stream.snapshot", subscriptionId, resyncId, snapshotId: `snapshot_${crypto.randomUUID()}`, stream: message.stream, cursor: snapshot.cursor, head: snapshot.head, schema: snapshotSchema, state: snapshot.state })) { this.recorder.record({ kind: "snapshot.delivery_failed", boundary: "snapshot.fence_released", outcome: "failure", reasonCode: "RT_RECOVERY_SEND_FAILED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: replayId, ...(client.sessionId ? { sessionId: client.sessionId } : {}), stream: message.stream, details: { tenantId, cursor: snapshot.cursor, head: snapshot.head } }); client.subscriptions.delete(subscriptionId); return; }
    const catchup = await this.#deliverThroughHead(client, subscriptionId, tenantId, message.stream, snapshot.cursor, snapshot.headSequence, "snapshot_catchup", replayId);
    if (!catchup.complete) { client.subscriptions.delete(subscriptionId); return; }
    state.cursor = snapshot.head;
    if (!this.#send(client, { kind: "stream.replay.complete", subscriptionId, replayId, stream: message.stream, through: snapshot.head })) { client.subscriptions.delete(subscriptionId); return; }
    state.recovering = false;
    this.recorder.record({ kind: "snapshot.fence_released", boundary: "snapshot.fence_released", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: replayId, ...(client.sessionId ? { sessionId: client.sessionId } : {}), stream: message.stream, details: { tenantId, cursor: snapshot.cursor, head: snapshot.head, catchup: catchup.count } });
    await this.#catchUpAll();
  }

  async #deliverThroughHead(client: GatewayClient, subscriptionId: string, tenantId: string, stream: string, after: string, headSequence: number, deliveryMode: EventMessage["deliveryMode"], replayId: string, afterFirst?: () => Promise<void>): Promise<{ complete: boolean; count: number }> {
    let current = after;
    let expectedSequence = decodeSequence(after) + 1;
    let count = 0;
    while (expectedSequence <= headSequence) {
      const page = await this.store.readAfter(tenantId, stream, current, 1_000);
      const selected = page.filter((event) => event.sequence <= headSequence);
      if (selected.length === 0) { this.recorder.record({ kind: "recovery.gap_unresolved", boundary: "event.catchup_completed", outcome: "failure", reasonCode: "RT_GAP_UNRESOLVED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: replayId, ...(client.sessionId ? { sessionId: client.sessionId } : {}), stream, details: { tenantId, expectedSequence, headSequence } }); return { complete: false, count }; }
      for (const event of selected) {
        if (event.sequence !== expectedSequence || !this.#sendEvent(client, subscriptionId, event, deliveryMode, replayId)) { this.recorder.record({ kind: "recovery.delivery_failed", boundary: "event.catchup_completed", outcome: "failure", reasonCode: event.sequence !== expectedSequence ? "RT_GAP_UNRESOLVED" : "RT_RECOVERY_SEND_FAILED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: replayId, ...(client.sessionId ? { sessionId: client.sessionId } : {}), stream, eventId: event.eventId, details: { tenantId, expectedSequence, receivedSequence: event.sequence, headSequence } }); return { complete: false, count }; }
        current = event.cursor;
        expectedSequence = event.sequence + 1;
        count += 1;
        if (count === 1) await afterFirst?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.recorder.record({ kind: "event.catchup_completed", boundary: "event.catchup_completed", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, traceId: replayId, ...(client.sessionId ? { sessionId: client.sessionId } : {}), stream, details: { tenantId, throughSequence: headSequence, count, pages: Math.ceil(count / 1_000) } });
    return { complete: true, count };
  }

  async #command(client: GatewayClient, message: CommandMessage): Promise<void> {
    this.#requirePrincipal(client);
    const applicationContext = this.#applicationContext(client);
    let authorized: boolean;
    try { authorized = this.options.application?.authorizeCommand ? await this.#runApplicationHook(client, "command_authorization", () => this.options.application!.authorizeCommand!(applicationContext, message)) : client.permissions?.has("room:42:write") === true; }
    catch (error) { throw new GatewayApplicationError("command", error, message.commandId); }
    if (!authorized) { this.recorder.record({ kind: "authorization.denied", boundary: "authorization.denied", outcome: "failure", reasonCode: "RT_AUTH_REQUIRED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), ...(client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), commandId: message.commandId, details: { tenantId: client.tenantId, principalNamespaceId: client.principalNamespaceId, response: "generic" } }); this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: "command", disposition: "fail_operation", retryable: false, commandId: message.commandId }); return; }
    let plan: PostgresGatewayCommandPlan | null;
    try {
      plan = this.options.application?.executeCommand
        ? await this.#runApplicationHook(client, "command_prepare", () => this.options.application!.executeCommand!(applicationContext, message))
        : this.#defaultCommandPlan(message);
    } catch (error) { throw new GatewayApplicationError("command", error, message.commandId); }
    if (!plan) { this.#rejectCommand(client, message.commandId); return; }
    let execution;
    this.#commandsActive += 1;
    try {
      execution = await this.store.executeCommand({ tenantId: client.tenantId!, principalNamespaceId: client.principalNamespaceId!, commandId: message.commandId, commandType: message.type, commandSchema: message.schema, commandInput: message.input, stream: plan.stream, eventType: plan.eventType, schema: plan.eventSchema, data: plan.eventData, resultSchema: plan.resultSchema, commandResultRetentionMs: this.capabilities.commandResultRetentionMs!, idempotencyRetentionMs: this.capabilities.idempotencyRetentionMs!, mutate: async (database, sequence, eventId, operation) => {
        return withApplicationDatabase(database, operation, (error) => new GatewayApplicationError("command", error, message.commandId), (applicationDatabase) => this.#trackApplicationWork(client, "command_mutation", () => plan.mutate(applicationDatabase, { tenantId: client.tenantId!, principalNamespaceId: client.principalNamespaceId!, commandId: message.commandId, stream: plan.stream, sequence, eventId })));
      } });
    } catch (error) {
      if (error instanceof Error && error.message === "RT_COMMAND_INTENT_CONFLICT") { this.#rejectCommand(client, message.commandId); return; }
      throw error;
    } finally { this.#commandsActive -= 1; }
    if (execution.status === "expired") { this.#send(client, { kind: "command.receipt", commandId: message.commandId, state: "expired", error: { code: "RT_COMMAND_EXPIRED", scope: "command", disposition: "fail_operation", retryable: false, commandId: message.commandId } }); return; }
    if (!this.#validCommandResult(client, { commandId: message.commandId, schema: execution.resultSchema, result: execution.result, eventId: execution.event.eventId, stream: execution.event.stream, sequence: execution.event.sequence })) { this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: "command", disposition: "fail_operation", retryable: false, commandId: message.commandId }); return; }
    if (this.#loseNextAck) { this.#loseNextAck = false; client.socket.close(1012, "injected ACK loss"); return; }
    this.#send(client, { kind: "command.receipt", commandId: message.commandId, state: "accepted" });
    this.#send(client, { kind: "command.completed", commandId: message.commandId, schema: execution.resultSchema, result: execution.result, causalEventIds: [execution.event.eventId], causalEvents: [{ eventId: execution.event.eventId, stream: execution.event.stream, sequence: execution.event.sequence }] });
    this.recorder.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), ...(client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), commandId: message.commandId, eventId: execution.event.eventId, causalHandoffId: `event:${execution.event.eventId}`, details: { tenantId: client.tenantId, principalNamespaceId: client.principalNamespaceId, duplicate: execution.duplicate } });
    await this.#publishTick();
    await this.#catchUpAll();
  }

  async #commandStatus(client: GatewayClient, message: CommandStatusRequest): Promise<void> {
    this.#requirePrincipal(client);
    const status = await this.store.commandStatus(client.tenantId!, client.principalNamespaceId!, message.commandId);
    if (status.state === "unknown") {
      if (await this.store.commandExistsForOtherPrincipal(client.tenantId!, client.principalNamespaceId!, message.commandId)) this.recorder.record({ kind: "authorization.denied", boundary: "authorization.denied", outcome: "failure", reasonCode: "RT_AUTH_REQUIRED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), principalNamespaceId: client.principalNamespaceId!, commandId: message.commandId, details: { tenantId: client.tenantId, principalNamespaceId: client.principalNamespaceId, response: "unknown", existenceExposed: false } });
      this.#send(client, { kind: "command.status", requestId: message.requestId, commandId: message.commandId, state: "unknown" });
    } else if (status.state === "expired") this.#send(client, { kind: "command.status", requestId: message.requestId, commandId: message.commandId, state: "expired" });
    else {
      if (!this.#validCommandResult(client, { commandId: message.commandId, schema: status.resultSchema, result: status.result, eventId: status.eventId, stream: status.eventStream, sequence: status.eventSequence })) { this.#send(client, { kind: "command.status", requestId: message.requestId, commandId: message.commandId, state: "unknown" }); return; }
      this.#send(client, { kind: "command.status", requestId: message.requestId, commandId: message.commandId, state: "completed", schema: status.resultSchema, result: status.result, causalEventIds: [status.eventId], causalEvents: [{ eventId: status.eventId, stream: status.eventStream, sequence: status.eventSequence }] });
      this.recorder.record({ kind: "command.status_reconciled", boundary: "command.status_reconciled", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), principalNamespaceId: client.principalNamespaceId!, commandId: message.commandId, eventId: status.eventId, causalHandoffId: `event:${status.eventId}`, details: { tenantId: client.tenantId, principalNamespaceId: client.principalNamespaceId, state: status.state } });
    }
    this.recorder.record({ kind: "security.non_enumerating_response", boundary: "security.non_enumerating_response", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), principalNamespaceId: client.principalNamespaceId!, commandId: message.commandId, details: { tenantId: client.tenantId, principalNamespaceId: client.principalNamespaceId, wireState: status.state === "unknown" ? "unknown" : status.state } });
    this.recorder.record({ kind: "command.status_queried", boundary: "command.status_queried", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), principalNamespaceId: client.principalNamespaceId!, commandId: message.commandId, details: { tenantId: client.tenantId, principalNamespaceId: client.principalNamespaceId, state: status.state } });
  }

  async #publishTick(): Promise<void> {
    if (this.#publisherActive || this.#draining) return;
    this.#publisherActive = true;
    try { await (this.options.publishOutbox ? this.options.publishOutbox(this.store, 100) : this.store.publishOutbox({ limit: 100 })); this.#outboxReady = true; }
    catch (error) { this.#outboxReady = false; this.#databaseUnavailable(error); }
    finally { this.#publisherActive = false; }
  }

  #applicationOperationTimeoutMs(): number { return this.options.transactionOptions?.operationTimeoutMs ?? 2_000; }

  async #runApplicationHook<T>(client: GatewayClient, operation: string, factory: () => Promise<T> | T): Promise<T> {
    return withApplicationHookTimeout(this.#trackApplicationWork(client, operation, factory), this.#applicationOperationTimeoutMs());
  }

  #trackApplicationWork<T>(client: GatewayClient, operation: string, factory: () => Promise<T> | T): Promise<T> {
    if (this.#applicationHooks.size >= this.maxApplicationHooks) {
      this.recorder.record({ kind: "resource.limit_exceeded", boundary: "application.hook_rejected", outcome: "failure", reasonCode: "RT_RESOURCE_LIMIT_EXCEEDED", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.sessionId ? { sessionId: client.sessionId } : {}), details: { ...(client.tenantId ? { tenantId: client.tenantId } : {}), resourceType: "application_hook", operation, nextRecords: this.#applicationHooks.size + 1, maxRecords: this.maxApplicationHooks } });
      throw new ApplicationHookUnavailable("capacity");
    }
    const registry = this.#applicationHooks;
    const token = Object.freeze({});
    registry.add(token);
    const work = Promise.resolve().then(factory);
    void work.then(() => registry.delete(token), () => registry.delete(token));
    return work;
  }

  async #appendSystemMessage(tenantId: string, stream: string, text: string): Promise<void> {
    const sentAt = new Date().toISOString();
    await this.store.appendEvent({ appendId: `append_${crypto.randomUUID()}`, tenantId, stream, eventType: "messageAdded", schema: "messageAdded@1", data: { author: "System", text, sentAt }, effectSchema: "roomMessageInsert@1", effect: { author: "System", text, sentAt }, mutate: async (database, sequence, eventId) => {
      await database.query(`INSERT INTO "${this.store.storage.schema}".realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, stream, sequence, eventId, "System", text, sentAt]);
    } });
  }

  async #healthTick(): Promise<void> {
    if (this.#draining) return;
    const healthy = await this.store.health();
    if (!healthy) { this.#databaseReady = false; this.#databaseUnavailable(new Error("database health check failed")); }
    else this.#databaseReady = true;
  }

  async #maintenanceTick(): Promise<void> {
    if (this.#draining) return;
    try {
      await this.store.cleanupCommandRetention(250);
      await this.store.cleanupPublishedOutbox(this.options.outboxRetentionMs ?? 300_000, 250);
    } catch (error) { this.#databaseUnavailable(error); }
  }

  async #catchUpAll(): Promise<void> {
    if (this.#catchupActive || this.#draining) return;
    this.#catchupActive = true;
    try {
      for (const client of this.#clients) {
        if (!client.tenantId || client.socket.readyState !== WebSocket.OPEN) continue;
        for (const [subscriptionId, subscription] of client.subscriptions) {
          if (subscription.recovering || !subscription.cursor) continue;
          const events = await this.store.readAfter(client.tenantId, subscription.stream, subscription.cursor);
          for (const event of events) { if (!this.#sendEvent(client, subscriptionId, event, "live")) return; subscription.cursor = event.cursor; }
        }
      }
    } catch (error) { this.#databaseUnavailable(error); }
    finally { this.#catchupActive = false; }
  }

  #sendEvent(client: GatewayClient, subscriptionId: string, event: PostgresStoredEvent, deliveryMode: EventMessage["deliveryMode"], replayId?: string, deliveryId = `delivery_${crypto.randomUUID()}`): boolean {
    const validator = this.options.application?.validateOutboundEvent;
    const subscription = client.subscriptions.get(subscriptionId);
    let valid = true;
    if (validator) {
      try { valid = Boolean(subscription && validator(this.#applicationContext(client), event, { stream: subscription.stream, input: subscription.input })); }
      catch { valid = false; }
    }
    if (!valid) {
      client.subscriptions.delete(subscriptionId);
      this.recorder.record({ kind: "event.outbound_validation_failed", boundary: "event.delivery_attempted", outcome: "failure", reasonCode: "RT_OPERATION_UNAVAILABLE", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(replayId ? { traceId: replayId } : client.traceId ? { traceId: client.traceId } : {}), ...(client.sessionId ? { sessionId: client.sessionId } : {}), ...(event.commandPrincipalNamespaceId ? { principalNamespaceId: event.commandPrincipalNamespaceId } : {}), stream: event.stream, eventId: event.eventId, ...(event.commandId ? { commandId: event.commandId } : {}), details: { tenantId: client.tenantId, ...(event.commandPrincipalNamespaceId ? { principalNamespaceId: event.commandPrincipalNamespaceId } : {}), schema: event.schema, type: event.type, delivered: false } });
      this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: "stream", disposition: "fail_operation", retryable: false, stream: event.stream });
      return false;
    }
    const sent = this.#send(client, { kind: "event", deliveryId, sessionGeneration: client.sessionGeneration, deliveryMode, ...(replayId ? { replayId } : {}), eventId: event.eventId, stream: event.stream, sequence: event.sequence, cursor: event.cursor, type: event.type, schema: event.schema, ...(event.commandId ? { commandId: event.commandId } : {}), occurredAt: event.occurredAt, data: event.data });
    if (sent) this.recorder.record({ kind: "event.delivery_attempted", boundary: "event.delivery_attempted", outcome: "success", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(replayId ? { traceId: replayId } : client.traceId ? { traceId: client.traceId } : {}), ...(event.commandPrincipalNamespaceId ? { principalNamespaceId: event.commandPrincipalNamespaceId } : {}), stream: event.stream, eventId: event.eventId, ...(event.commandId ? { commandId: event.commandId } : {}), details: { ...(client.tenantId ? { tenantId: client.tenantId } : {}), ...(event.commandPrincipalNamespaceId ? { principalNamespaceId: event.commandPrincipalNamespaceId } : {}), ...(client.principalNamespaceId ? { observerPrincipalNamespaceId: client.principalNamespaceId } : {}), deliveryMode, deliveryId } });
    return sent;
  }

  #send(client: GatewayClient, message: Record<string, unknown>): boolean {
    if (client.socket.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify({ protocol: "1.0", messageId: `msg_${crypto.randomUUID()}`, sentAt: new Date().toISOString(), ...message });
    const bytes = Buffer.byteLength(encoded);
    if (bytes > this.capabilities.maxMessageBytes) { client.socket.close(1009, "outbound message too large"); return false; }
    const socketWritableBytes = (client.socket as unknown as { _socket?: { writableLength?: number } })._socket?.writableLength ?? 0;
    const queuedBytes = Math.max(client.socket.bufferedAmount, socketWritableBytes);
    if (queuedBytes + bytes > this.maxOutboundBufferedBytes) {
      this.recorder.record({ kind: "slow_consumer.disconnected", boundary: "slow_consumer.disconnected", outcome: "failure", reasonCode: "RT_SLOW_CONSUMER", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), details: { bufferedAmount: client.socket.bufferedAmount, socketWritableBytes, nextMessageBytes: bytes, maxOutboundBufferedBytes: this.maxOutboundBufferedBytes } });
      client.socket.close(1013, "slow consumer");
      return false;
    }
    client.socket.send(encoded);
    return true;
  }

  #error(client: GatewayClient, error: ErrorInfo): void { this.#send(client, { kind: "error", error }); }
  #rejectCommand(client: GatewayClient, commandId: string): void { this.#send(client, { kind: "command.receipt", commandId, state: "rejected", error: { code: "RT_COMMAND_REJECTED", scope: "command", disposition: "fail_operation", retryable: false, commandId } }); }
  #requirePrincipal(client: GatewayClient): void { if (!client.tenantId || !client.principalNamespaceId) throw new Error("RT_AUTH_REQUIRED"); }

  #applicationContext(client: GatewayClient): PostgresGatewayApplicationContext {
    this.#requirePrincipal(client);
    return { tenantId: client.tenantId!, principalNamespaceId: client.principalNamespaceId!, permissions: client.permissions ?? new Set(), ...(client.traceId ? { traceId: client.traceId } : {}), ...(client.sessionId ? { sessionId: client.sessionId } : {}) };
  }

  #defaultCommandPlan(message: CommandMessage): PostgresGatewayCommandPlan | null {
    if (message.type !== "sendMessage" || message.schema !== "sendMessage@1" || typeof message.input !== "object" || message.input === null || Array.isArray(message.input)) return null;
    const input = message.input as Record<string, JsonValue>;
    if (input.roomId !== "42" || typeof input.text !== "string" || input.text.trim().length === 0 || input.text.length > 4_000) return null;
    const text = input.text;
    const sentAt = new Date().toISOString();
    return { stream: "room:42", eventType: "messageAdded", eventSchema: "messageAdded@1", eventData: { author: "You", text, sentAt }, resultSchema: "sendMessageResult@1", mutate: async (database, context) => {
      await database.query(`INSERT INTO "${this.store.storage.schema}".realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [context.tenantId, context.stream, context.sequence, context.eventId, "You", text, sentAt]);
      return { messageId: context.eventId, sequence: context.sequence };
    } };
  }

  #validCommandResult(client: GatewayClient, result: PostgresGatewayCommandResult): boolean {
    const validator = this.options.application?.validateCommandResult;
    try { if (!validator || validator(this.#applicationContext(client), result)) return true; }
    catch { /* an application validator failure is not database unavailability */ }
    this.recorder.record({ kind: "command.outbound_validation_failed", boundary: "command.completed", outcome: "failure", reasonCode: "RT_OPERATION_UNAVAILABLE", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), ...(client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), commandId: result.commandId, eventId: result.eventId, stream: result.stream, details: { ...(client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), schema: result.schema, delivered: false } });
    return false;
  }

  #ping(client: GatewayClient): void {
    if (client.socket.readyState !== WebSocket.OPEN || client.pendingPingId) return;
    const pingId = `ping_${crypto.randomUUID()}`;
    client.pendingPingId = pingId;
    this.#send(client, { kind: "heartbeat.ping", pingId });
    client.heartbeatTimeout = setTimeout(() => { if (client.pendingPingId === pingId) client.socket.close(4000, "heartbeat timeout"); }, this.heartbeat.timeoutMs);
  }

  #pong(client: GatewayClient, pingId: string): void {
    if (client.pendingPingId !== pingId) return;
    if (client.heartbeatTimeout) clearTimeout(client.heartbeatTimeout);
    delete client.heartbeatTimeout; delete client.pendingPingId;
  }

  #clearClientTimers(client: GatewayClient): void {
    clearTimeout(client.openDeadline);
    if (client.heartbeatInterval) clearInterval(client.heartbeatInterval);
    if (client.heartbeatTimeout) clearTimeout(client.heartbeatTimeout);
    delete client.heartbeatInterval; delete client.heartbeatTimeout; delete client.pendingPingId;
  }

  #operationFailure(client: GatewayClient, error: unknown): void {
    if (error instanceof Error && error.message.startsWith("RT_AUTH")) { this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: "runtime", disposition: "fail_operation", retryable: false }); return; }
    if (error instanceof GatewayApplicationError) {
      const queryFailure = trustedDatabaseQueryCause(error);
      if (queryFailure?.infrastructureFailure) { this.#databaseUnavailable(trustedDatabaseFailureError(queryFailure), client.tenantId); return; }
      this.#applicationFailure(client, error);
      return;
    }
    if (error instanceof TransactionRolledBackError) {
      const applicationError = error.originalError instanceof GatewayApplicationError ? error.originalError : undefined;
      const queryFailure = applicationError ? trustedDatabaseQueryCause(applicationError) : undefined;
      if (applicationError && !queryFailure) { this.#applicationFailure(client, applicationError, error.context.transactionId); return; }
      const authoritativeCause = queryFailure ? trustedDatabaseFailureError(queryFailure) : error.originalError;
      if (queryFailure ? queryFailure.infrastructureFailure : isDatabaseInfrastructureFailure(authoritativeCause)) { this.#databaseUnavailable(authoritativeCause, client.tenantId); return; }
      const sqlstate = queryFailure?.sqlstate ?? errorCode(authoritativeCause);
      const retryable = sqlstate === "40001" || sqlstate === "40P01";
      this.recorder.record({ kind: "gateway.transaction_rolled_back_observed", boundary: "gateway.transaction_rolled_back_observed", outcome: "failure", reasonCode: error.code, ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, transactionId: error.context.transactionId, transactionOperation: error.context.operation, ...(error.context.operationCorrelationId ? { operationCorrelationId: error.context.operationCorrelationId } : {}), ...(error.context.principalNamespaceId ? { principalNamespaceId: error.context.principalNamespaceId } : {}), causalHandoffId: `transaction:${error.context.transactionId}`, ...(error.context.commandId ? { commandId: error.context.commandId } : {}), ...(error.context.eventId ? { eventId: error.context.eventId } : {}), ...(client.traceId ? { traceId: client.traceId } : {}), details: { tenantId: error.context.tenantId ?? client.tenantId, ...(error.context.principalNamespaceId ? { principalNamespaceId: error.context.principalNamespaceId } : {}), observer: "gateway", producerClaimed: false, durableSuccessClaimed: false, failureProvenance: "authoritative_abort", ...(sqlstate ? { sqlstate } : {}), retryable } });
      this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: error.context.commandId ? "command" : "runtime", disposition: retryable ? "retry" : "fail_operation", retryable, ...(retryable ? { retryAfterMs: 50 } : {}), ...(error.context.commandId ? { commandId: error.context.commandId } : {}) });
      return;
    }
    if (error instanceof TransactionOutcomeError) {
      this.recorder.record({ kind: "gateway.transaction_outcome_indeterminate_observed", boundary: "gateway.transaction_outcome_indeterminate_observed", outcome: "unknown", reasonCode: error.code, ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, transactionId: error.context.transactionId, transactionOperation: error.context.operation, ...(error.context.operationCorrelationId ? { operationCorrelationId: error.context.operationCorrelationId } : {}), ...(error.context.principalNamespaceId ? { principalNamespaceId: error.context.principalNamespaceId } : {}), causalHandoffId: `transaction:${error.context.transactionId}`, ...(error.context.commandId ? { commandId: error.context.commandId } : {}), ...(error.context.eventId ? { eventId: error.context.eventId } : {}), ...(client.traceId ? { traceId: client.traceId } : {}), details: { tenantId: error.context.tenantId ?? client.tenantId, ...(error.context.principalNamespaceId ? { principalNamespaceId: error.context.principalNamespaceId } : {}), observer: "gateway", producerClaimed: false, durableSuccessClaimed: false } });
      this.#error(client, { code: error.code, scope: error.context.commandId ? "command" : "runtime", disposition: "retry", retryable: true, retryAfterMs: 250, ...(error.context.commandId ? { commandId: error.context.commandId } : {}) });
      return;
    }
    if (isDatabaseInfrastructureFailure(error)) { this.#databaseUnavailable(error, client.tenantId); return; }
    this.recorder.record({ kind: "operation.failed", boundary: "operation.failed", outcome: "failure", reasonCode: "RT_OPERATION_UNAVAILABLE", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(client.traceId ? { traceId: client.traceId } : {}), details: { tenantId: client.tenantId, errorType: error instanceof Error ? error.name : typeof error, durableSuccessClaimed: false } });
    this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: "runtime", disposition: "fail_operation", retryable: false });
  }

  #applicationFailure(client: GatewayClient, error: GatewayApplicationError, transactionId?: string): void {
    this.recorder.record({ kind: "application.operation_failed", boundary: "application.operation_failed", outcome: "failure", reasonCode: "RT_OPERATION_UNAVAILABLE", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, ...(transactionId ? { transactionId } : {}), ...(client.traceId ? { traceId: client.traceId } : {}), ...(error.commandId && client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), ...(error.commandId ? { commandId: error.commandId } : {}), ...(error.stream ? { stream: error.stream } : {}), details: { tenantId: client.tenantId, ...(error.commandId && client.principalNamespaceId ? { principalNamespaceId: client.principalNamespaceId } : {}), errorType: error.originalError instanceof Error ? error.originalError.name : typeof error.originalError, provenance: "application", durableSuccessClaimed: false } });
    this.#error(client, { code: "RT_OPERATION_UNAVAILABLE", scope: error.scope, disposition: "fail_operation", retryable: false, ...(error.commandId ? { commandId: error.commandId } : {}), ...(error.stream ? { stream: error.stream } : {}) });
  }

  #databaseUnavailable(error: unknown, tenantId?: string): void {
    if (this.#draining) return;
    this.#databaseReady = false;
    this.#listenerReady = false;
    this.#outboxReady = false;
    this.#accepting = false;
    this.recorder.record({ kind: "database.operation_failed", boundary: "database.operation_failed", outcome: "failure", reasonCode: "RT_DATABASE_UNAVAILABLE", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, details: { operation: "gateway_health_or_durable_operation", ...(tenantId ? { tenantId } : {}), error: error instanceof Error ? error.message : String(error) } });
    this.recorder.record({ kind: "capability.health_changed", boundary: "capability.health_changed", outcome: "failure", reasonCode: "RT_DATABASE_UNAVAILABLE", ...POSTGRES_GATEWAY_EVIDENCE_COMPONENT, details: { ...this.#healthDetails(), ...(tenantId ? { tenantId } : {}), error: error instanceof Error ? error.message : String(error) } });
    for (const client of this.#clients) this.#error(client, { code: "RT_DATABASE_UNAVAILABLE", scope: "runtime", disposition: "retry", retryable: true, retryAfterMs: 250 });
    this.gracefulDrain("database_unavailable");
  }

  #healthDetails(): Record<string, JsonValue> { return { accepting: this.#accepting, databaseReady: this.#databaseReady, listenerReady: this.#listenerReady, outboxReady: this.#outboxReady, draining: this.#draining, runtimeId: this.recorder.runtimeId, runtimeBootId: this.recorder.runtimeBootId }; }

  #ownedTimerCount(): number {
    return [this.#publisherTimer, this.#pollTimer, this.#healthTimer, this.#maintenanceTimer, this.#drainTimer].filter(Boolean).length;
  }

  async #httpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") { response.statusCode = this.ready ? 200 : 503; response.end(JSON.stringify({ status: this.ready ? "ready" : "unready" })); return; }
    if (this.#testControlPlaneEnabled && request.method === "GET" && request.url === "/api/inspect") {
      if (process.env.REALTIME_BENCHMARK_GC === "1") (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
      const handles = process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, name) => { counts[name] = (counts[name] ?? 0) + 1; return counts; }, {});
      const databaseResources = await this.store.resourceCounts().catch(() => ({ commands: -1, outbox: -1, pendingOutbox: -1, transactionAttempts: -1 }));
      response.end(JSON.stringify({ ...this.#healthDetails(), clients: this.#clients.size, recorder: { ...this.recorder.stats(), limits: this.recorder.limits }, databaseRecorder: { ...this.store.recorder.stats(), limits: this.store.recorder.limits }, resources: { sessions: this.#clients.size, sockets: this.#clients.size, subscriptions: [...this.#clients].reduce((total, client) => total + client.subscriptions.size, 0), timers: [...this.#clients].reduce((total, client) => total + Number(Boolean(client.heartbeatInterval)) + Number(Boolean(client.heartbeatTimeout)), 0) + this.#ownedTimerCount(), buffers: [...this.#clients].reduce((total, client) => total + client.socket.bufferedAmount, 0), commands: this.#commandsActive, databaseCommands: databaseResources.commands, outboxRows: databaseResources.outbox, pendingOutboxRows: databaseResources.pendingOutbox, transactionAttempts: databaseResources.transactionAttempts, recorder: this.recorder.stats().records, databaseRecorder: this.store.recorder.stats().records }, process: { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, cpuUsage: process.cpuUsage(), handles } }));
      return;
    }
    if (this.#testControlPlaneEnabled && request.method === "GET" && request.url === "/internal/evidence") { response.end(JSON.stringify({ runtime: { runtimeId: this.recorder.runtimeId, runtimeBootId: this.recorder.runtimeBootId }, records: this.recorder.records(), databaseRecords: this.store.recorder.records(), stats: this.recorder.stats(), databaseStats: this.store.recorder.stats() })); return; }
    if (this.#testControlPlaneEnabled && request.method === "POST" && request.url === "/internal/chaos/drain") { this.gracefulDrain(); response.end(JSON.stringify({ ok: true })); return; }
    if (this.#testControlPlaneEnabled && request.method === "POST" && request.url === "/internal/chaos/lose-ack") { this.loseNextAck(); response.end(JSON.stringify({ ok: true })); return; }
    if (this.#testControlPlaneEnabled && request.method === "POST" && request.url === "/internal/chaos/drop-notification") { this.dropNextNotification(); response.end(JSON.stringify({ ok: true })); return; }
    if (this.#testControlPlaneEnabled && request.method === "POST" && request.url === "/internal/chaos/interleave-replay") { this.interleaveNextReplay(); response.end(JSON.stringify({ ok: true })); return; }
    if (this.#testControlPlaneEnabled && request.method === "POST" && request.url === "/internal/chaos/duplicate") { await this.injectDuplicate(); response.end(JSON.stringify({ ok: true })); return; }
    if (this.#testControlPlaneEnabled && request.method === "POST" && request.url === "/internal/chaos/expire-cursor") { await this.store.expireBeforeCurrentHead("tenant-demo", "room:42"); response.end(JSON.stringify({ ok: true })); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: "not found" }));
  }
}

function listenHttp(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    const cleanup = () => { server.off("error", onError); server.off("listening", onListening); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function positiveBound(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function boundedDuration(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new Error(code);
  return value;
}

function validateHeartbeat(heartbeat: { intervalMs: number; timeoutMs: number }): { intervalMs: number; timeoutMs: number } {
  if (!Number.isSafeInteger(heartbeat.intervalMs) || heartbeat.intervalMs < 1_000 || heartbeat.intervalMs > 300_000
    || !Number.isSafeInteger(heartbeat.timeoutMs) || heartbeat.timeoutMs < 1_000 || heartbeat.timeoutMs > 300_000) throw new Error("RT_HEARTBEAT_INVALID");
  return Object.freeze({ intervalMs: heartbeat.intervalMs, timeoutMs: heartbeat.timeoutMs });
}

async function withApplicationDatabase<T>(client: PoolClient, operation: TransactionOperationLease, wrap: (error: unknown) => GatewayApplicationError, work: (database: PostgresGatewayDatabase) => Promise<T>): Promise<T> {
  const scope = { active: true };
  const issued = new Set<{ observed: boolean; settled: boolean }>();
  const trustedQueryCauses = new WeakMap<object, TrustedDatabaseQueryFailure>();
  const database: PostgresGatewayDatabase = Object.freeze({
    query: <TResult extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<TResult>> => {
      const state = { observed: false, settled: false };
      issued.add(state);
      let promise: Promise<QueryResult<TResult>>;
      try {
        if (!scope.active || !operation.isActive()) throw new Error("RT_APPLICATION_DATABASE_SCOPE_CLOSED");
        if (typeof text !== "string" || (values !== undefined && !Array.isArray(values))) throw new Error("RT_APPLICATION_DATABASE_QUERY_INVALID");
        assertApplicationQueryText(text);
        const query = { text, values: values === undefined ? [] : [...values], queryMode: "extended" as const };
        promise = client.query<TResult>(query).catch((error: unknown) => {
          const observed = new Error("RT_APPLICATION_DATABASE_QUERY_FAILED");
          trustedQueryCauses.set(observed, Object.freeze({ infrastructureFailure: isDatabaseInfrastructureFailure(error), ...(errorCode(error) ? { sqlstate: errorCode(error) } : {}) }));
          throw observed;
        });
      } catch (error) { promise = Promise.reject(error); }
      promise = promise.finally(() => { state.settled = true; });
      return new OwnedQueryPromise(promise, state);
    }
  });
  try {
    const result = await withTimeout(work(database), Math.max(1, operation.deadline - Date.now()), "RT_APPLICATION_OPERATION_TIMEOUT");
    if ([...issued].some((query) => !query.observed)) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNOBSERVED");
    if ([...issued].some((query) => !query.settled)) throw new Error("RT_APPLICATION_DATABASE_QUERY_PENDING");
    return result;
  } catch (error) {
    const ownershipError = [...issued].some((query) => !query.observed) ? new Error("RT_APPLICATION_DATABASE_QUERY_UNOBSERVED") : [...issued].some((query) => !query.settled) ? new Error("RT_APPLICATION_DATABASE_QUERY_PENDING") : error;
    const applicationError = wrap(ownershipError);
    if (ownershipError && typeof ownershipError === "object" && trustedQueryCauses.has(ownershipError)) {
      const trusted = trustedQueryCauses.get(ownershipError)!;
      trustedApplicationDatabaseCauses.set(applicationError, trusted);
      if (trusted.sqlstate) Object.defineProperty(applicationError, "code", { value: trusted.sqlstate, enumerable: true, configurable: false, writable: false });
    }
    throw applicationError;
  } finally { scope.active = false; }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    void work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function withApplicationHookTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApplicationHookUnavailable("timeout")), timeoutMs);
    void work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

class OwnedQueryPromise<T> implements Promise<T> {
  readonly [Symbol.toStringTag] = "Promise";
  constructor(private readonly promise: Promise<T>, private readonly state: { observed: boolean; settled: boolean }) { void promise.catch(() => undefined); }
  then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
    if (typeof onfulfilled === "function" && typeof onrejected === "function") this.state.observed = true;
    return new OwnedQueryPromise(this.promise.then(onfulfilled, onrejected), this.state);
  }
  catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> { return new OwnedQueryPromise(this.promise.catch(onrejected), this.state); }
  finally(onfinally?: (() => void) | null): Promise<T> { return new OwnedQueryPromise(this.promise.finally(onfinally), this.state); }
}

/** @internal Executable guard for the transaction-owned application query port. */
export function assertApplicationQueryText(text: string): void {
  const statements = applicationSqlStatements(text);
  if (statements.length !== 1) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
  const tokens = statements[0]!;
  const first = tokens[0]?.value ?? "";
  if (!["select", "insert", "update", "delete", "with"].includes(first)) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
  const prohibited = new Set(["pg_advisory_lock", "pg_advisory_lock_shared", "pg_try_advisory_lock", "pg_try_advisory_lock_shared", "pg_advisory_unlock", "pg_advisory_unlock_shared", "pg_advisory_unlock_all", "set_config"]);
  if (tokens.some((token) => prohibited.has(token.value))) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
  const topLevelCommand = first === "with" ? tokens.slice(1).find((token) => !token.quoted && token.depth === 0 && ["select", "insert", "update", "delete"].includes(token.value)) : tokens[0];
  if (!topLevelCommand) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
  if (topLevelCommand.value === "select" && tokens.some((token) => token.depth === 0 && token.value === "into")) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
}

interface ApplicationSqlToken { value: string; depth: number; quoted: boolean }

function applicationSqlStatements(text: string): ApplicationSqlToken[][] {
  const statements: ApplicationSqlToken[][] = [[]];
  let depth = 0;
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "-" && text[index + 1] === "-") { index = text.indexOf("\n", index + 2); if (index < 0) index = text.length; continue; }
    if (character === "/" && text[index + 1] === "*") {
      let depth = 1; index += 2;
      while (index < text.length && depth > 0) { if (text[index] === "/" && text[index + 1] === "*") { depth += 1; index += 2; } else if (text[index] === "*" && text[index + 1] === "/") { depth -= 1; index += 2; } else index += 1; }
      if (depth !== 0) throw new Error("RT_APPLICATION_DATABASE_QUERY_INVALID");
      continue;
    }
    if (character === "'") throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
    if ((character === "u" || character === "U") && text[index + 1] === "&" && text[index + 2] === '"') throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
    if (character === '"') {
      const parsed = readSqlQuotedIdentifier(text, index);
      statements.at(-1)!.push({ value: parsed.value.toLowerCase(), depth, quoted: true }); index = parsed.next; continue;
    }
    if (character === "$") {
      const delimiter = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(text.slice(index))?.[0];
      if (delimiter) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
    }
    if (character === "(") { depth += 1; index += 1; continue; }
    if (character === ")") { depth -= 1; if (depth < 0) throw new Error("RT_APPLICATION_DATABASE_QUERY_INVALID"); index += 1; continue; }
    if (character === ";") { if (depth !== 0) throw new Error("RT_APPLICATION_DATABASE_QUERY_UNSAFE"); if (statements.at(-1)!.length > 0) statements.push([]); index += 1; continue; }
    const token = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(text.slice(index))?.[0];
    if (token) { statements.at(-1)!.push({ value: token.toLowerCase(), depth, quoted: false }); index += token.length; continue; }
    index += 1;
  }
  if (depth !== 0) throw new Error("RT_APPLICATION_DATABASE_QUERY_INVALID");
  return statements.filter((statement) => statement.length > 0);
}

function readSqlQuotedIdentifier(text: string, start: number): { value: string; next: number } {
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) { if (text[index] === '"') { if (text[index + 1] === '"') { value += '"'; index += 1; continue; } return { value, next: index + 1 }; } value += text[index]; }
  throw new Error("RT_APPLICATION_DATABASE_QUERY_INVALID");
}

function trustedDatabaseQueryCause(error: GatewayApplicationError): TrustedDatabaseQueryFailure | undefined { return trustedApplicationDatabaseCauses.get(error); }
function trustedDatabaseFailureError(failure: TrustedDatabaseQueryFailure): Error {
  const error = new Error("trusted application database query failed");
  if (failure.sqlstate) Object.defineProperty(error, "code", { value: failure.sqlstate, enumerable: true });
  return error;
}

function isDatabaseInfrastructureFailure(error: unknown): boolean {
  const code = errorCode(error);
  if (code) return /^(?:08|53|57P0|58)/u.test(code) || /^(?:ECONN|EPIPE|ETIMEDOUT)/u.test(code);
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Client has encountered a connection error and is not queryable") return true;
  return /connection (?:terminated|ended|closed)|database system is (?:shutting down|starting up)|pool is draining/iu.test(message);
}

function errorCode(error: unknown): string { return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string" ? String((error as Error & { code: string }).code) : ""; }

const decodeSequence = (value: string): number => {
  try { return Number((JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { q: number }).q); }
  catch { return 0; }
};

const handoffId = (tenantId: string, stream: string, cursor: string): string => `handoff:${tenantId}:${stream}:${cursor}`;
