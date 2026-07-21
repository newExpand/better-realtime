import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { FlightRecorder } from "@realtime/diagnostics";
import { BETTER_REALTIME_SUBPROTOCOL, decodeWireMessage, isClientToServerMessage, type Capabilities, type CommandMessage, type CommandStatusRequest, type ContractIdentity, type EventMessage, type JsonValue, type SessionOpen, type StreamSubscribe } from "@realtime/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { decodeCursor, encodeCursor, InMemoryEventStore, type StoredEvent } from "./store.ts";

interface ClientContext {
  socket: WebSocket;
  opened: boolean;
  sessionId?: string;
  sessionGeneration: number;
  subscriptions: Map<string, string>;
  openDeadline: ReturnType<typeof setTimeout>;
  heartbeatInterval?: ReturnType<typeof setInterval>;
  heartbeatTimeout?: ReturnType<typeof setTimeout>;
  pendingPingId?: string;
}

type ReferenceCapabilityLimits = Pick<Capabilities, "maxMessageBytes" | "maxRecoveryBufferRecords" | "maxRecoveryBufferBytes">;
export interface ReferenceServerOptions { port?: number; host?: string; contract: ContractIdentity; heartbeat?: { intervalMs: number; timeoutMs: number }; capabilities?: Partial<ReferenceCapabilityLimits>; maxOutboundBufferedBytes?: number }

function sameContractIdentity(actual: ContractIdentity, expected: ContractIdentity): boolean {
  return actual.contractId === expected.contractId && actual.manifestVersion === expected.manifestVersion && actual.manifestDigest === expected.manifestDigest;
}

export const DEFAULT_REFERENCE_HOST = "127.0.0.1";
export const DEFAULT_REFERENCE_PORT = 43_170;

const defaultCapabilities: Capabilities = {
  schemaValidation: true,
  eventIdentity: true,
  ordering: "per_stream" as const,
  gapDetection: true,
  durableReplay: false,
  snapshotResync: "fenced" as const,
  idempotentCommands: false,
  commandReceipts: false,
  clientApplyAck: false,
  eventDedupeWindowMs: 300_000,
  maxMessageBytes: 1_048_576,
  maxRecoveryBufferRecords: 10_000,
  maxRecoveryBufferBytes: 16_777_216
};

export class ReferenceServer {
  readonly store = new InMemoryEventStore();
  readonly recorder = new FlightRecorder({ runtimeId: "reference-server", producerRole: "server" });
  #http: HttpServer | undefined;
  #wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  #clients = new Set<ClientContext>();
  #accepting = true;
  #sessionGeneration = 0;
  #loseNextAck = false;
  #interleaveNextReplay = 0;
  #interleaveGapNextReplay = false;
  #injectForeignCommandCollision = false;
  #port: number;
  readonly host: string;
  readonly heartbeat: { intervalMs: number; timeoutMs: number };
  readonly capabilities: Capabilities;
  readonly maxOutboundBufferedBytes: number;

  constructor(private readonly options: ReferenceServerOptions) {
    this.#port = options.port ?? DEFAULT_REFERENCE_PORT;
    this.host = options.host ?? DEFAULT_REFERENCE_HOST;
    this.heartbeat = validateHeartbeat(options.heartbeat ?? { intervalMs: 25_000, timeoutMs: 20_000 });
    this.capabilities = { ...defaultCapabilities, ...options.capabilities, maxMessageBytes: Math.min(options.capabilities?.maxMessageBytes ?? defaultCapabilities.maxMessageBytes, defaultCapabilities.maxMessageBytes) };
    this.maxOutboundBufferedBytes = options.maxOutboundBufferedBytes ?? this.capabilities.maxMessageBytes;
    if (!Number.isSafeInteger(this.maxOutboundBufferedBytes) || this.maxOutboundBufferedBytes < 1) throw new Error("outbound buffer policy must be a positive integer");
    this.seed();
  }

  get port(): number { return this.#port; }
  get httpUrl(): string { return `http://${this.host}:${this.#port}`; }
  get webSocketUrl(): string { return `ws://${this.host}:${this.#port}/ws`; }

  seed(): void {
    if (this.store.head("room:42")) return;
    this.store.append("room:42", "messageAdded", { author: "Ava", text: "Monitoring the deployment boundary.", sentAt: new Date().toISOString() });
    this.store.append("room:42", "messageAdded", { author: "Mateo", text: "Replay checkpoint established.", sentAt: new Date().toISOString() });
    this.store.append("room:42", "messageAdded", { author: "You", text: "Ready to prove interruption and recovery.", sentAt: new Date().toISOString() });
  }

  async start(): Promise<void> {
    if (this.#http) return;
    this.#http = createServer((request, response) => { void this.#httpRequest(request, response); });
    this.#http.on("upgrade", (request, socket, head) => {
      if (!this.#accepting || request.url !== "/ws") { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); return; }
      this.#wss.handleUpgrade(request, socket, head, (ws) => this.#connection(ws, request));
    });
    await new Promise<void>((resolve) => this.#http!.listen(this.port, this.host, resolve));
    const address = this.#http.address();
    if (address && typeof address !== "string") this.#port = address.port;
  }

  async dispose(): Promise<void> {
    this.#accepting = false;
    for (const client of this.#clients) { this.#clearClientTimers(client); client.socket.close(1001, "server shutdown"); }
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    if (this.#http) await new Promise<void>((resolve, reject) => this.#http!.close((error) => error ? reject(error) : resolve()));
    this.#http = undefined;
  }

  stopGateway(): void {
    this.#accepting = false;
    for (const client of this.#clients) client.socket.close(1012, "server interruption");
    this.store.append("room:42", "messageAdded", { author: "System", text: "Missed while the gateway was stopped: event A.", sentAt: new Date().toISOString() });
    this.store.append("room:42", "messageAdded", { author: "System", text: "Missed while the gateway was stopped: event B.", sentAt: new Date().toISOString() });
    this.#interleaveNextReplay = Math.max(this.#interleaveNextReplay, 1);
    this.recorder.record({ kind: "transport.closed", boundary: "transport.closed", outcome: "success", component: "server", componentVersion: "0.1.0", reasonCode: "RT_SERVER_INTERRUPTED" });
  }

  restartGateway(): void { this.#accepting = true; this.recorder.record({ kind: "gateway.restarted", boundary: "gateway.restarted", outcome: "success", component: "server", componentVersion: "0.1.0" }); }
  loseNextAck(): void { this.#loseNextAck = true; }
  expireCursor(): void { this.store.expireBeforeCurrentHead("room:42"); }
  injectDuplicate(): void { const event = this.store.head("room:42"); if (event) this.#broadcast(event, "live", `duplicate_${crypto.randomUUID()}`); }
  injectForeignCommandCollisionNextCommand(): void { this.#injectForeignCommandCollision = true; }
  injectGap(): void {
    this.store.append("room:42", "messageAdded", { author: "System", text: "Gap event recovered by replay.", sentAt: new Date().toISOString() });
    const visible = this.store.append("room:42", "messageAdded", { author: "System", text: "Out-of-order live event that triggers recovery.", sentAt: new Date().toISOString() });
    this.#broadcast(visible, "live");
  }
  interleaveNextReplay(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > 100) throw new Error("interleave count must be between 0 and 100");
    this.#interleaveNextReplay = count;
  }
  interleaveGapNextReplay(): void { this.#interleaveGapNextReplay = true; }

  #connection(socket: WebSocket, request: IncomingMessage): void {
    if (request.headers["sec-websocket-protocol"] !== BETTER_REALTIME_SUBPROTOCOL) { socket.close(1002, "subprotocol required"); return; }
    const context: ClientContext = { socket, opened: false, sessionGeneration: 0, subscriptions: new Map(), openDeadline: setTimeout(() => { this.#error(context, "RT_SESSION_INIT_TIMEOUT", "session", "fail_session"); socket.close(1008, "session init timeout"); }, 10_000) };
    this.#clients.add(context);
    this.recorder.record({ kind: "transport.opened", boundary: "transport.opened", outcome: "success", component: "server", componentVersion: "0.1.0" });
    socket.on("message", (data) => this.#message(context, data.toString()));
    socket.on("error", (error: Error & { code?: string }) => {
      const tooLarge = error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this.recorder.record({ kind: "transport.receive_failed", boundary: "message.rejected", outcome: "failure", reasonCode: tooLarge ? "RT_MESSAGE_TOO_LARGE" : "RT_TRANSPORT_RECEIVE_FAILED", component: "server", componentVersion: "0.1.0", details: { code: error.code ?? "unknown" } });
    });
    socket.on("close", (code, reason) => {
      this.#clearClientTimers(context);
      this.#clients.delete(context);
      this.recorder.record({ kind: "transport.closed", boundary: "transport.closed", outcome: "success", component: "server", componentVersion: "0.1.0", details: { code, reason: reason.toString() } });
    });
  }

  #message(context: ClientContext, raw: string): void {
    const decoded = decodeWireMessage(raw, this.capabilities.maxMessageBytes);
    if (!decoded.ok) { this.recorder.record({ kind: "message.rejected", boundary: "message.rejected", outcome: "failure", reasonCode: decoded.code, component: "server", componentVersion: "0.1.0" }); this.#error(context, decoded.code, "message", "fail_session"); context.socket.close(1008, decoded.code); return; }
    const message = decoded.value;
    if (!context.opened && message.kind !== "session.open") { this.#error(context, "RT_MESSAGE_INVALID", "session", "fail_session"); context.socket.close(1008, "session.open required"); return; }
    if (context.opened && message.kind === "session.open") { this.#error(context, "RT_MESSAGE_INVALID", "session", "fail_session"); context.socket.close(1008, "duplicate session.open"); return; }
    if (!isClientToServerMessage(message)) { this.#rejectDirection(context, message.kind); return; }
    switch (message.kind) {
      case "session.open": this.#open(context, message); break;
      case "session.auth.update": this.#error(context, "RT_AUTH_REFRESH_UNSUPPORTED", "session", "fail_session"); context.socket.close(1008, "auth refresh unsupported"); break;
      case "heartbeat.pong": this.#pong(context, message.pingId); break;
      case "stream.subscribe": this.#subscribe(context, message); break;
      case "stream.unsubscribe": context.subscriptions.delete(message.subscriptionId); this.#send(context, { kind: "stream.unsubscribed", requestId: message.requestId, subscriptionId: message.subscriptionId }); break;
      case "command": this.#command(context, message); break;
      case "command.status.request": this.#commandStatus(context, message); break;
    }
  }

  #open(context: ClientContext, message: SessionOpen): void {
    clearTimeout(context.openDeadline);
    if (!sameContractIdentity(message.contract, this.options.contract)) { this.#send(context, { kind: "session.rejected", error: { code: "RT_CONTRACT_INCOMPATIBLE", scope: "session", disposition: "fail_session", retryable: false } }); context.socket.close(1008, "contract incompatible"); return; }
    context.opened = true; context.sessionId = `session_${crypto.randomUUID()}`; context.sessionGeneration = ++this.#sessionGeneration;
    this.#send(context, { kind: "session.ready", sessionId: context.sessionId, sessionGeneration: context.sessionGeneration, authGeneration: 1, resumeStatus: message.resume ? "unavailable" : "fresh", ...(message.resume ? { resumeUnavailableReason: "not_found" } : {}), capabilities: this.capabilities, heartbeat: { mode: "application", ...this.heartbeat } });
    this.recorder.record({ kind: "session.accepted", boundary: "session.accepted", outcome: "success", component: "server", componentVersion: "0.1.0", sessionId: context.sessionId, details: { sessionGeneration: context.sessionGeneration } });
    context.heartbeatInterval = setInterval(() => this.#ping(context), this.heartbeat.intervalMs);
  }

  #ping(context: ClientContext): void {
    if (context.socket.readyState !== WebSocket.OPEN || context.pendingPingId) return;
    const pingId = `ping_${crypto.randomUUID()}`;
    context.pendingPingId = pingId;
    this.#send(context, { kind: "heartbeat.ping", pingId });
    this.recorder.record({ kind: "heartbeat.ping_sent", boundary: "heartbeat.ping_sent", outcome: "success", component: "server", componentVersion: "0.1.0", ...(context.sessionId ? { sessionId: context.sessionId } : {}), details: { pingId } });
    context.heartbeatTimeout = setTimeout(() => {
      if (context.pendingPingId !== pingId) return;
      this.recorder.record({ kind: "heartbeat.timeout", boundary: "heartbeat.timeout", outcome: "failure", reasonCode: "RT_HEARTBEAT_TIMEOUT", component: "server", componentVersion: "0.1.0", ...(context.sessionId ? { sessionId: context.sessionId } : {}), details: { pingId } });
      context.socket.close(4000, "heartbeat timeout");
    }, this.heartbeat.timeoutMs);
  }

  #pong(context: ClientContext, pingId: string): void {
    if (context.pendingPingId !== pingId) return;
    if (context.heartbeatTimeout) clearTimeout(context.heartbeatTimeout);
    delete context.heartbeatTimeout;
    delete context.pendingPingId;
    this.recorder.record({ kind: "heartbeat.pong_received", boundary: "heartbeat.pong_received", outcome: "success", component: "server", componentVersion: "0.1.0", ...(context.sessionId ? { sessionId: context.sessionId } : {}), details: { pingId } });
  }

  #clearClientTimers(context: ClientContext): void {
    clearTimeout(context.openDeadline);
    if (context.heartbeatInterval) clearInterval(context.heartbeatInterval);
    if (context.heartbeatTimeout) clearTimeout(context.heartbeatTimeout);
    delete context.heartbeatInterval;
    delete context.heartbeatTimeout;
    delete context.pendingPingId;
  }

  #subscribe(context: ClientContext, message: StreamSubscribe): void {
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    context.subscriptions.set(subscriptionId, message.stream);
    const after = decodeCursor(message.after);
    const snapshotRequested = message.after === null || message.after === undefined;
    const headEvent = this.store.head(message.stream);
    const head = headEvent?.cursor ?? encodeCursor(0);
    if (snapshotRequested || after === null || !this.store.canReplay(message.stream, after)) {
      this.#interleaveNextReplay = 0;
      this.#interleaveGapNextReplay = false;
      const resyncId = `resync_${crypto.randomUUID()}`; const replayId = `replay_${crypto.randomUUID()}`;
      this.#send(context, { kind: "stream.subscribed", requestId: message.requestId, subscriptionId, stream: message.stream, mode: "snapshot", baseline: message.after ?? null, head });
      this.#send(context, { kind: "stream.resync.required", subscriptionId, resyncId, stream: message.stream, reason: snapshotRequested ? "client_requested" : "cursor_expired" });
      const snapshot = this.store.snapshot(message.stream);
      this.#send(context, { kind: "stream.snapshot", subscriptionId, resyncId, snapshotId: `snapshot_${crypto.randomUUID()}`, stream: message.stream, cursor: head, head, schema: "RoomSnapshot@1", state: snapshot });
      this.#send(context, { kind: "stream.replay.complete", subscriptionId, replayId, stream: message.stream, through: head });
      this.recorder.record({ kind: "snapshot.created", boundary: "snapshot.created", outcome: "success", component: "server", componentVersion: "0.1.0", stream: message.stream, details: { cursor: head, reason: snapshotRequested ? "client_requested" : "cursor_expired" } });
      return;
    }
    const replay = this.store.eventsAfter(message.stream, after).filter((event) => event.sequence <= (headEvent?.sequence ?? 0));
    if (replay.length === 0) { this.#send(context, { kind: "stream.subscribed", requestId: message.requestId, subscriptionId, stream: message.stream, mode: "live", baseline: message.after ?? null, head }); return; }
    const replayId = `replay_${crypto.randomUUID()}`;
    this.#send(context, { kind: "stream.subscribed", requestId: message.requestId, subscriptionId, stream: message.stream, mode: "replay", baseline: message.after ?? null, head });
    this.#send(context, { kind: "stream.replay.begin", subscriptionId, replayId, stream: message.stream, requestedAfter: message.after ?? null, head });
    this.recorder.record({ kind: "replay.selected", boundary: "replay.selected", outcome: "success", component: "server", componentVersion: "0.1.0", stream: message.stream, traceId: replayId, details: { requestedAfter: message.after, head, count: replay.length } });
    replay.forEach((event, index) => {
      this.#sendEvent(context, event, "replay", replayId);
      if (index === 0 && this.#interleaveGapNextReplay) {
        this.#interleaveGapNextReplay = false;
        this.#interleaveNextReplay = 0;
        this.store.append(message.stream, "messageAdded", { author: "System", text: "Buffered live gap hidden event.", sentAt: new Date().toISOString() });
        const visible = this.store.append(message.stream, "messageAdded", { author: "System", text: "Buffered live gap visible event.", sentAt: new Date().toISOString() });
        this.#sendEvent(context, visible, "live");
      } else if (index === 0 && this.#interleaveNextReplay > 0) {
        const count = this.#interleaveNextReplay;
        this.#interleaveNextReplay = 0;
        for (let liveIndex = 0; liveIndex < count; liveIndex += 1) {
          const text = count === 1 ? "Live event held behind the replay fence." : `Live event ${liveIndex + 1} held behind the replay fence.`;
          const live = this.store.append(message.stream, "messageAdded", { author: "System", text, sentAt: new Date().toISOString() });
          this.#sendEvent(context, live, "live");
        }
      }
    });
    this.#send(context, { kind: "stream.replay.complete", subscriptionId, replayId, stream: message.stream, through: head });
  }

  #command(context: ClientContext, message: CommandMessage): void {
    const existing = this.store.command(message.commandId);
    if (existing) { this.#send(context, { kind: "command.completed", commandId: existing.commandId, schema: "sendMessageResult@1", result: existing.result, causalEventIds: [existing.eventId], causalEvents: [{ eventId: existing.eventId, stream: existing.eventStream, sequence: existing.eventSequence }] }); return; }
    if (message.type !== "sendMessage" || message.schema !== "sendMessage@1" || typeof message.input !== "object" || message.input === null || Array.isArray(message.input)) { this.#rejectCommand(context, message.commandId); return; }
    const input = message.input as Record<string, JsonValue>;
    if (input.roomId !== "42" || typeof input.text !== "string" || input.text.trim().length === 0 || input.text.length > 4_000) { this.#rejectCommand(context, message.commandId); return; }
    if (this.#injectForeignCommandCollision) {
      this.#injectForeignCommandCollision = false;
      const foreign = this.store.append("room:42", "messageAdded", { author: "Foreign principal", text: "same tenant and command ID, different principal", sentAt: new Date().toISOString() }, message.commandId);
      this.#broadcast(foreign, "live");
    }
    const event = this.store.append("room:42", "messageAdded", { author: "You", text: typeof input.text === "string" ? input.text : "", sentAt: new Date().toISOString() }, message.commandId);
    const result = { messageId: event.eventId, sequence: event.sequence };
    this.store.completeCommand({ commandId: message.commandId, state: "completed", result, eventId: event.eventId, eventStream: event.stream, eventSequence: event.sequence, completedAt: new Date().toISOString() });
    this.recorder.record({ kind: "db.committed", boundary: "db.committed", outcome: "success", component: "server", componentVersion: "0.1.0", commandId: message.commandId, eventId: event.eventId });
    this.recorder.record({ kind: "event.appended", boundary: "event.appended", outcome: "success", component: "server", componentVersion: "0.1.0", commandId: message.commandId, eventId: event.eventId });
    this.recorder.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", component: "server", componentVersion: "0.1.0", commandId: message.commandId, eventId: event.eventId, details: { causalEventIds: [event.eventId] } });
    if (this.#loseNextAck) { this.#loseNextAck = false; context.socket.close(1012, "injected ACK loss"); return; }
    if (this.capabilities.commandReceipts) this.#send(context, { kind: "command.receipt", commandId: message.commandId, state: "accepted" });
    this.#send(context, { kind: "command.completed", commandId: message.commandId, schema: "sendMessageResult@1", result, causalEventIds: [event.eventId], causalEvents: [{ eventId: event.eventId, stream: event.stream, sequence: event.sequence }] });
    this.#broadcast(event, "live");
  }

  #commandStatus(context: ClientContext, message: CommandStatusRequest): void {
    const command = this.store.command(message.commandId);
    if (!command) { this.#send(context, { kind: "command.status", requestId: message.requestId, commandId: message.commandId, state: "unknown" }); return; }
    this.#send(context, { kind: "command.status", requestId: message.requestId, commandId: message.commandId, state: "completed", schema: "sendMessageResult@1", result: command.result, causalEventIds: [command.eventId], causalEvents: [{ eventId: command.eventId, stream: command.eventStream, sequence: command.eventSequence }] });
    this.recorder.record({ kind: "command.status_queried", boundary: "command.status_queried", outcome: "success", component: "server", componentVersion: "0.1.0", commandId: message.commandId });
  }

  #rejectCommand(context: ClientContext, commandId: string): void {
    this.#send(context, { kind: "command.receipt", commandId, state: "rejected", error: { code: "RT_COMMAND_REJECTED", scope: "command", disposition: "fail_operation", retryable: false, commandId } });
    this.recorder.record({ kind: "command.rejected", boundary: "command.rejected", outcome: "failure", reasonCode: "RT_COMMAND_REJECTED", component: "server", componentVersion: "0.1.0", commandId });
  }

  #broadcast(event: StoredEvent, mode: EventMessage["deliveryMode"], deliveryId?: string): void {
    for (const client of this.#clients) if ([...client.subscriptions.values()].includes(event.stream) && client.socket.readyState === WebSocket.OPEN) this.#sendEvent(client, event, mode, undefined, deliveryId);
  }

  #sendEvent(context: ClientContext, event: StoredEvent, deliveryMode: EventMessage["deliveryMode"], replayId?: string, deliveryId = `delivery_${crypto.randomUUID()}`): void {
    const sent = this.#send(context, { kind: "event", deliveryId, sessionGeneration: context.sessionGeneration, deliveryMode, ...(replayId ? { replayId } : {}), eventId: event.eventId, stream: event.stream, sequence: event.sequence, cursor: event.cursor, type: event.type, schema: event.schema, ...(event.commandId ? { commandId: event.commandId } : {}), occurredAt: event.occurredAt, data: event.data });
    if (sent) this.recorder.record({ kind: "event.delivery_attempted", boundary: "event.delivery_attempted", outcome: "success", component: "server", componentVersion: "0.1.0", stream: event.stream, eventId: event.eventId, ...(replayId ? { traceId: replayId } : {}), ...(event.commandId ? { commandId: event.commandId } : {}), details: { deliveryMode, deliveryId } });
  }

  #send(context: ClientContext, message: Record<string, unknown>): boolean {
    if (context.socket.readyState !== WebSocket.OPEN) return false;
    const envelope = { protocol: "1.0", messageId: `msg_${crypto.randomUUID()}`, sentAt: new Date().toISOString(), ...message };
    const encoded = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > this.capabilities.maxMessageBytes) {
      this.recorder.record({ kind: "transport.send_rejected", boundary: "message.rejected", outcome: "failure", reasonCode: "RT_MESSAGE_TOO_LARGE", component: "server", componentVersion: "0.1.0", details: { bytes, maxMessageBytes: this.capabilities.maxMessageBytes } });
      context.socket.close(1009, "outbound message too large");
      return false;
    }
    if (context.socket.bufferedAmount + bytes > this.maxOutboundBufferedBytes) {
      this.recorder.record({ kind: "slow_consumer.disconnected", boundary: "slow_consumer.disconnected", outcome: "failure", reasonCode: "RT_SLOW_CONSUMER", component: "server", componentVersion: "0.1.0", ...(context.sessionId ? { sessionId: context.sessionId } : {}), details: { bufferedAmount: context.socket.bufferedAmount, nextMessageBytes: bytes, maxOutboundBufferedBytes: this.maxOutboundBufferedBytes } });
      context.socket.close(1013, "slow consumer buffer exceeded");
      return false;
    }
    context.socket.send(encoded);
    return true;
  }

  #rejectDirection(context: ClientContext, kind: string): void {
    this.recorder.record({ kind: "protocol.direction_rejected", boundary: "message.rejected", outcome: "failure", reasonCode: "RT_MESSAGE_INVALID", component: "server", componentVersion: "0.1.0", details: { kind, expectedDirection: "client_to_server" } });
    this.#error(context, "RT_MESSAGE_INVALID", "message", "fail_session");
    context.socket.close(1008, "invalid message direction");
  }

  #error(context: ClientContext, code: `RT_${string}`, scope: "connection" | "session" | "stream" | "command" | "message" | "runtime", disposition: "retry" | "refresh_auth" | "replay" | "resync" | "fail_operation" | "fail_session" | "none", commandId?: string): void {
    this.#send(context, { kind: "error", error: { code, scope, disposition, retryable: false, ...(commandId ? { commandId } : {}) } });
  }

  async #httpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") { response.end(JSON.stringify({ status: this.#accepting ? "ready" : "stopped" })); return; }
    if (request.method === "GET" && request.url === "/api/inspect") { response.end(JSON.stringify({ accepting: this.#accepting, clients: this.#clients.size, store: this.store.inspect(), resources: { sessions: this.#clients.size, subscriptions: [...this.#clients].reduce((sum, client) => sum + client.subscriptions.size, 0) }, recorder: this.recorder.stats() })); return; }
    if (request.method === "POST" && request.url?.startsWith("/api/chaos/")) {
      const action = request.url.slice("/api/chaos/".length);
      if (action === "stop") this.stopGateway();
      else if (action === "restart") this.restartGateway();
      else if (action === "duplicate") this.injectDuplicate();
      else if (action === "expire-cursor") this.expireCursor();
      else if (action === "lose-ack") this.loseNextAck();
      response.end(JSON.stringify({ ok: true, action })); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: "not found" }));
  }
}

function validateHeartbeat(heartbeat: { intervalMs: number; timeoutMs: number }): { intervalMs: number; timeoutMs: number } {
  if (!Number.isSafeInteger(heartbeat.intervalMs) || heartbeat.intervalMs < 1_000 || heartbeat.intervalMs > 300_000
    || !Number.isSafeInteger(heartbeat.timeoutMs) || heartbeat.timeoutMs < 1_000 || heartbeat.timeoutMs > 300_000) throw new Error("heartbeat policy violates protocol bounds");
  return Object.freeze({ intervalMs: heartbeat.intervalMs, timeoutMs: heartbeat.timeoutMs });
}
