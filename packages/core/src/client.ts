import { FlightRecorder, ResourceRegistry, ResourceScope, doctor, type DoctorReport, type EvidenceRecord, type ExpectedBoundary, type OwnedResource } from "@realtime/diagnostics";
import { ProtocolStateMachine } from "@realtime/protocol/state-machines";
import { decodeWireMessage, isServerToClientMessage } from "@realtime/protocol/validator";
import { assertCapabilityInvariants } from "@realtime/protocol/types";
import type { CausalEventPosition, CommandCompleted, CommandStatus, ContractIdentity, ErrorInfo, EventMessage, JsonObject, JsonValue, SessionReady, SnapshotMessage, StreamSubscribed } from "@realtime/protocol/types";
import type { TransportConnection, TransportFactory } from "@realtime/transport-reference";
import { runtimeId } from "./id.ts";

export type ConnectionState = "idle" | "connecting" | "open" | "backing_off" | "disposed";
export type SessionState = "absent" | "opening" | "ready" | "reauthenticating" | "suspended" | "rejected" | "disposed";
export type StreamStatus = "idle" | "subscribing" | "replaying" | "resyncing" | "live" | "suspended" | "failed" | "closed";
export type CommandState = "created" | "queued" | "sent" | "accepted" | "completed" | "observed" | "reconciling" | "rejected" | "expired" | "unknown" | "cancelled";

export interface StreamDefinition<TInput extends JsonValue, TState> {
  stream: string;
  snapshotSchema?: string;
  key(input: TInput): string;
  initial(input: TInput): TState;
  applyEvent(state: TState, event: EventMessage): TState;
  applySnapshot(state: JsonValue): TState;
  snapshotSequence(state: TState): number;
}

function settleBeforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    void work.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export interface StreamSnapshot<TState> {
  data: TState;
  status: StreamStatus;
  cursor: string | null;
  sequence: number;
  error: string | null;
  bufferedRecords: number;
  bufferedBytes: number;
}

interface StreamEntry<TState = unknown> {
  key: string;
  name: string;
  input: JsonValue;
  definition: StreamDefinition<JsonValue, TState>;
  machine: ProtocolStateMachine;
  snapshot: StreamSnapshot<TState>;
  listeners: Set<() => void>;
  consumers: number;
  subscriptionId?: string;
  subscribeRequestId: string | undefined;
  subscribeRequestInFlight: boolean;
  recoveryHead?: string;
  replayId?: string;
  recoveryBuffer: EventMessage[];
  recoveryBytes: number;
  dedupe: Map<string, number>;
  releaseTimer?: ReturnType<typeof setTimeout>;
  releaseTimerResource?: OwnedResource;
}

interface PendingCommand {
  machine: ProtocolStateMachine;
  commandId: string;
  type: string;
  input: JsonValue;
  state: CommandState;
  attempt: number;
  createdAt: string;
  completed: Promise<JsonValue>;
  observed: Promise<void>;
  resolveCompleted: (value: JsonValue) => void;
  rejectCompleted: (reason: unknown) => void;
  resolveObserved: () => void;
  rejectObserved: (reason: unknown) => void;
  result?: JsonValue;
  causalEventIds: Set<string>;
  causalEventPositions: Map<string, CausalEventPosition>;
  appliedCausalEventIds: Set<string>;
}

export interface CommandAttempt<TResult extends JsonValue = JsonValue> {
  commandId: string;
  get state(): CommandState;
  completed: Promise<TResult>;
  observed: Promise<void>;
}

export interface ClientOptions {
  transport: TransportFactory;
  contract: ContractIdentity;
  auth: (signal?: AbortSignal) => JsonObject | Promise<JsonObject>;
  streams: StreamDefinition<JsonValue, unknown>[];
  commands?: Readonly<Record<string, {
    inputSchema: string;
    resultSchema: string;
    validateResult?: (value: JsonValue) => JsonValue;
  }>>;
  recorder?: FlightRecorder;
  reconnectDelaysMs?: number[];
  /** Deterministic test seam for reconnect jitter. Values must be in [0, 1). */
  random?: () => number;
  maxPendingCommands?: number;
  maxDedupeEntries?: number;
  idleReleaseMs?: number;
  maxMessageBytes?: number;
  maxRecoveryBufferRecords?: number;
  maxRecoveryBufferBytes?: number;
  sessionOpenTimeoutMs?: number;
}

export class RealtimeClient {
  readonly recorder: FlightRecorder;
  readonly resources: ResourceRegistry;
  readonly runtimeId: string;
  #scope: ResourceScope;
  #connectionScope: ResourceScope | undefined;
  #connectionCleanupPromise: Promise<void> | undefined;
  #connectionMachine = new ProtocolStateMachine("connection");
  #sessionMachine = new ProtocolStateMachine("session");
  #transport: TransportConnection | undefined;
  #streams = new Map<string, StreamEntry>();
  #definitions = new Map<string, StreamDefinition<JsonValue, unknown>>();
  #commandSchemas: Readonly<Record<string, {
    inputSchema: string;
    resultSchema: string;
    validateResult?: (value: JsonValue) => JsonValue;
  }>>;
  #commands = new Map<string, PendingCommand>();
  #appliedEvents = new Set<string>();
  #sessionGeneration = 0;
  #sessionId: string | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #connecting = false;
  #connectAbort: AbortController | undefined;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #sessionOpenDeadlineResource: OwnedResource | undefined;
  #globalListeners = new Set<() => void>();
  #maxMessageBytes: number;
  #maxRecoveryBufferRecords: number;
  #maxRecoveryBufferBytes: number;
  readonly #maxPendingCommands: number;
  readonly #maxDedupeEntries: number;
  readonly #idleReleaseMs: number;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #random: () => number;
  readonly #sessionOpenTimeoutMs: number;
  #commandReceipts = false;
  #runtimeSnapshot: { connectionState: ConnectionState; sessionState: SessionState; sessionGeneration: number; pendingCount: number } = {
    connectionState: "idle",
    sessionState: "absent",
    sessionGeneration: 0,
    pendingCount: 0
  };

  constructor(private readonly options: ClientOptions) {
    this.runtimeId = runtimeId("client");
    this.recorder = options.recorder ?? new FlightRecorder({ runtimeId: this.runtimeId, producerRole: "client" });
    this.resources = new ResourceRegistry(this.recorder);
    this.#scope = new ResourceScope(this.resources, this.runtimeId);
    this.#commandSchemas = options.commands ?? {};
    this.#maxMessageBytes = this.#positiveLimit(options.maxMessageBytes ?? 1_048_576, "maxMessageBytes");
    this.#maxRecoveryBufferRecords = this.#positiveLimit(options.maxRecoveryBufferRecords ?? 10_000, "maxRecoveryBufferRecords");
    this.#maxRecoveryBufferBytes = this.#positiveLimit(options.maxRecoveryBufferBytes ?? 16_777_216, "maxRecoveryBufferBytes");
    this.#maxPendingCommands = this.#positiveLimit(options.maxPendingCommands ?? 1_000, "maxPendingCommands");
    this.#maxDedupeEntries = this.#positiveLimit(options.maxDedupeEntries ?? 10_000, "maxDedupeEntries");
    this.#idleReleaseMs = this.#nonNegativeLimit(options.idleReleaseMs ?? 0, "idleReleaseMs");
    this.#sessionOpenTimeoutMs = this.#boundedDuration(options.sessionOpenTimeoutMs ?? 10_000, "sessionOpenTimeoutMs");
    const reconnectDelays = options.reconnectDelaysMs ?? [100, 250, 500, 1_000, 2_000];
    if (reconnectDelays.length === 0) throw new Error("reconnectDelaysMs must contain at least one delay");
    this.#reconnectDelaysMs = Object.freeze(reconnectDelays.map((delay) => this.#boundedDuration(delay, "reconnectDelaysMs")));
    if (this.#reconnectDelaysMs.some((delay, index) => index > 0 && delay < this.#reconnectDelaysMs[index - 1]!)) throw new Error("reconnectDelaysMs must be non-decreasing");
    this.#random = options.random ?? Math.random;
    for (const definition of options.streams) this.#definitions.set(definition.stream, definition);
  }

  get connectionState(): ConnectionState { return this.#connectionMachine.state as ConnectionState; }
  get sessionState(): SessionState { return this.#sessionMachine.state as SessionState; }
  get pendingCount(): number { return [...this.#commands.values()].filter((command) => !["observed", "rejected", "expired", "unknown", "cancelled"].includes(command.state)).length; }

  subscribeRuntime(listener: () => void): () => void {
    if (this.#disposed) throw new Error("RT_CLIENT_DISPOSED");
    const subscriptionListener = () => listener();
    this.#globalListeners.add(subscriptionListener);
    return () => this.#globalListeners.delete(subscriptionListener);
  }
  runtimeSnapshot() { return this.#runtimeSnapshot; }

  async connect(): Promise<void> {
    if (this.#disposed || this.connectionState === "disposed" || this.#connecting || this.#transport) return;
    this.#connecting = true;
    const connectAbort = new AbortController();
    this.#connectAbort = connectAbort;
    let transportOpened = false;
    if (this.#connectionMachine.state === "idle") this.#transition("connection", this.#connectionMachine, "connect.requested");
    else if (this.#connectionMachine.state === "backing_off") this.#transition("connection", this.#connectionMachine, "backoff.elapsed");
    try {
      if (this.#connectionCleanupPromise) await this.#connectionCleanupPromise;
      if (this.#disposed) return;
      const transport = await this.options.transport.connect(connectAbort.signal);
      if (this.#disposed) { transport.close(1000, "disposed"); return; }
      this.#transport = transport;
      this.#connectionScope = new ResourceScope(this.resources, `${this.runtimeId}:connection:${this.#sessionGeneration + 1}`);
      this.#connectionScope.acquire("transport_connection", () => transport.close(1000, "connection scope disposed"));
      this.#transition("connection", this.#connectionMachine, "transport.opened");
      transportOpened = true;
      this.recorder.record({ kind: "transport.opened", boundary: "transport.opened", outcome: "success", component: "client", componentVersion: "0.1.0" });
      if (this.#sessionMachine.state === "absent") this.#transition("session", this.#sessionMachine, "transport.opened");
      else if (this.#sessionMachine.state === "suspended") this.#transition("session", this.#sessionMachine, "transport.opened");
      const removeMessage = transport.onMessage((raw) => this.#receive(raw));
      const removeClose = transport.onClose((event) => this.#closed(event, transport, connectAbort));
      this.#connectionScope.acquire("transport_message_listener", removeMessage);
      this.#connectionScope.acquire("transport_close_listener", removeClose);
      this.#armSessionOpenDeadline(connectAbort, transport);
      const auth = await settleBeforeAbort(Promise.resolve().then(() => this.options.auth(connectAbort.signal)), connectAbort.signal);
      if (!this.#send({ kind: "session.open", connectionAttemptId: runtimeId("conn_attempt"), contract: this.options.contract, auth })) throw new Error("RT_SESSION_OPEN_SEND_FAILED");
    } catch (error) {
      if (this.#disposed || (error instanceof Error && error.name === "AbortError")) return;
      const opened = transportOpened;
      if (opened) await this.#rollbackOpenedTransport();
      this.recorder.record({ kind: opened ? "session.initialization_failed" : "transport.failed", boundary: opened ? "session.initialization_failed" : "transport.failed", outcome: "failure", reasonCode: opened ? "RT_SESSION_INITIALIZATION_FAILED" : "RT_TRANSPORT_OPEN_FAILED", component: "client", componentVersion: "0.1.0", details: { error: error instanceof Error ? error.message : String(error) } });
      if (this.#connectionMachine.state === "connecting") this.#transition("connection", this.#connectionMachine, "transport.failed");
      this.#scheduleReconnect();
    } finally {
      if (this.#connectAbort === connectAbort) this.#connectAbort = undefined;
      this.#connecting = false;
      this.#notifyGlobal();
    }
  }

  stream<TInput extends JsonValue, TState>(name: string, input: TInput): { key: string; subscribe(listener: () => void): () => void; getSnapshot(): StreamSnapshot<TState> } {
    if (this.#disposed) throw new Error("RT_CLIENT_DISPOSED");
    const definition = this.#definitions.get(name) as StreamDefinition<TInput, TState> | undefined;
    if (!definition) throw new Error(`Unknown stream definition: ${name}`);
    const key = definition.key(input);
    const createEntry = (): StreamEntry<TState> => ({ key, name, input, definition: definition as unknown as StreamDefinition<JsonValue, TState>, machine: new ProtocolStateMachine("stream"), snapshot: { data: definition.initial(input), status: "idle", cursor: null, sequence: 0, error: null, bufferedRecords: 0, bufferedBytes: 0 }, listeners: new Set(), consumers: 0, subscribeRequestInFlight: false, subscribeRequestId: undefined, recoveryBuffer: [], recoveryBytes: 0, dedupe: new Map() });
    let entry = createEntry();
    const committedEntry = (): StreamEntry<TState> | undefined => {
      const existing = this.#streams.get(key) as StreamEntry<TState> | undefined;
      if (existing && existing.name !== name) throw new Error(`RT_STREAM_KEY_COLLISION:${key}:${existing.name}:${name}`);
      return existing;
    };
    return {
      key,
      subscribe: (listener) => {
        if (this.#disposed) throw new Error("RT_CLIENT_DISPOSED");
        const existing = committedEntry();
        if (existing) entry = existing;
        else {
          if (entry.machine.state === "closed") entry = createEntry();
          this.#streams.set(key, entry);
        }
        const subscribedEntry = entry;
        const subscriptionListener = () => listener();
        subscribedEntry.listeners.add(subscriptionListener);
        subscribedEntry.consumers += 1;
        this.#cancelReleaseTimer(subscribedEntry);
        if (subscribedEntry.consumers === 1) {
          void this.connect();
          if (this.sessionState === "ready") this.#subscribeEntry(subscribedEntry);
        }
        this.recorder.record({ kind: "resource.acquired", boundary: "react.subscriber.acquired", outcome: "success", component: "client", componentVersion: "0.1.0", stream: key, ownerId: key, details: { consumers: subscribedEntry.consumers } });
        return () => {
          if (!subscribedEntry.listeners.delete(subscriptionListener)) return;
          subscribedEntry.consumers = Math.max(0, subscribedEntry.consumers - 1);
          this.recorder.record({ kind: "resource.release_succeeded", boundary: "react.subscriber.released", outcome: "success", component: "client", componentVersion: "0.1.0", stream: key, ownerId: key, details: { consumers: subscribedEntry.consumers } });
          if (subscribedEntry.consumers === 0) {
            const timer = setTimeout(() => {
              delete subscribedEntry.releaseTimer;
              const resource = subscribedEntry.releaseTimerResource;
              delete subscribedEntry.releaseTimerResource;
              void resource?.dispose();
              if (subscribedEntry.consumers === 0) this.#releaseEntry(subscribedEntry);
            }, this.#idleReleaseMs);
            subscribedEntry.releaseTimer = timer;
            subscribedEntry.releaseTimerResource = this.resources.acquire("stream_idle_release_timer", subscribedEntry.key, () => clearTimeout(timer));
          }
        };
      },
      getSnapshot: () => {
        const existing = committedEntry();
        if (existing) return existing.snapshot;
        if (entry.machine.state === "closed") entry = createEntry();
        return entry.snapshot;
      }
    };
  }

  execute<TResult extends JsonValue = JsonValue>(type: string, input: JsonValue): CommandAttempt<TResult> {
    if (this.#disposed) throw new Error("RT_CLIENT_DISPOSED");
    if (this.#commands.size >= this.#maxPendingCommands) throw new Error("RT_COMMAND_BUFFER_FULL");
    const commandId = runtimeId("cmd");
    let resolveCompleted!: (value: JsonValue) => void;
    let rejectCompleted!: (reason: unknown) => void;
    let resolveObserved!: () => void;
    let rejectObserved!: (reason: unknown) => void;
    const pending: PendingCommand = {
      commandId, type, input, machine: new ProtocolStateMachine("command"), state: "created", attempt: 0, createdAt: new Date().toISOString(),
      completed: new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; }),
      observed: new Promise((resolve, reject) => { resolveObserved = resolve; rejectObserved = reject; }),
      resolveCompleted, rejectCompleted, resolveObserved, rejectObserved, causalEventIds: new Set(), causalEventPositions: new Map(), appliedCausalEventIds: new Set()
    };
    // Consumers intentionally choose either settlement boundary. Mark both
    // promises as observed without changing what callers receive from await.
    void pending.completed.catch(() => undefined);
    void pending.observed.catch(() => undefined);
    this.#commands.set(commandId, pending);
    this.#commandTransition(pending, "execute");
    this.recorder.record({ kind: "command.created", boundary: "command.created", outcome: "success", component: "client", componentVersion: "0.1.0", commandId });
    void this.connect();
    if (this.sessionState === "ready") this.#sendCommand(pending);
    this.#notifyGlobal();
    return { commandId, get state() { return pending.state; }, completed: pending.completed as Promise<TResult>, observed: pending.observed };
  }

  inspect() {
    return {
      schemaVersion: "1.0",
      connection: this.connectionState,
      session: this.sessionState,
      streams: [...this.#streams.values()].map((entry) => ({ key: entry.key, status: entry.snapshot.status, consumers: entry.consumers, cursor: entry.snapshot.cursor, sequence: entry.snapshot.sequence, bufferedRecords: entry.recoveryBuffer.length, bufferedBytes: entry.recoveryBytes, dedupeEntries: entry.dedupe.size, releaseScheduled: Boolean(entry.releaseTimer) })),
      commands: [...this.#commands.values()].map((command) => ({ commandId: command.commandId, type: command.type, state: command.state, attempt: command.attempt })),
      resources: this.resources.inventory(),
      recorder: this.recorder.stats(),
      runtimeSubscribers: this.#globalListeners.size
    };
  }

  traceCommand(commandId: string) { return { schemaVersion: "1.0", commandId, ...this.recorder.query({ commandId }, 500) }; }
  inspectStream(stream: string) { return { schemaVersion: "1.0", stream, ...this.recorder.query({ stream }, 500) }; }
  leaks() { const active = this.resources.active(); const orphaned = active.filter((resource) => resource.state === "failed"); return { schemaVersion: "1.0", verdict: orphaned.length === 0 ? "proven" : "disproven", active, orphaned, count: orphaned.length }; }
  doctor(options: { producerRecords?: readonly EvidenceRecord[]; producerStats?: { droppedRecords: number; evictedRecords: number }; scope?: Partial<Pick<EvidenceRecord, "traceId" | "sessionId" | "stream" | "commandId">>; expectedBoundaries?: ExpectedBoundary[] } = {}): DoctorReport {
    const stats = this.recorder.stats();
    return doctor({
      records: [...this.recorder.records(), ...(options.producerRecords ?? [])],
      expectedBoundaries: options.expectedBoundaries ?? [{ producerRole: "server", boundary: "replay.selected" }, { producerRole: "server", boundary: "event.delivery_attempted" }, { producerRole: "client", boundary: "client.event_applied" }, { producerRole: "client", boundary: "replay.completed" }],
      expectedProducers: ["client", "server"], ...(options.scope ? { scope: options.scope } : {}),
      droppedRecords: stats.droppedRecords + (options.producerStats?.droppedRecords ?? 0),
      evictedRecords: stats.evictedRecords + (options.producerStats?.evictedRecords ?? 0),
      expectedOutcome: "subscribed application state converges through the declared recovery head"
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#disposeOwned();
    return this.#disposePromise;
  }

  async #disposeOwned(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (release: () => void | Promise<void>): Promise<void> => {
      try { await release(); } catch (error) { errors.push(error); }
    };
    this.#connectAbort?.abort();
    this.#connectAbort = undefined;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#clearSessionOpenDeadline();
    this.#transport = undefined;
    await attempt(() => this.#disposeConnectionScope());
    for (const entry of this.#streams.values()) {
      entry.listeners.clear();
      entry.consumers = 0;
      await attempt(() => this.#releaseEntry(entry));
    }
    const disposeError = new Error("RT_CLIENT_DISPOSED");
    for (const command of this.#commands.values()) {
      if (command.machine.can("dispose")) await attempt(() => this.#commandTransition(command, "dispose"));
      command.rejectCompleted(disposeError);
      command.rejectObserved(disposeError);
    }
    this.#commands.clear();
    this.#appliedEvents.clear();
    if (this.#connectionMachine.can("dispose")) await attempt(() => this.#transition("connection", this.#connectionMachine, "dispose"));
    if (this.#sessionMachine.can("dispose")) await attempt(() => this.#transition("session", this.#sessionMachine, "dispose"));
    await attempt(() => this.#scope.dispose());
    try { this.#notifyGlobal(); } catch (error) { errors.push(error); }
    finally { this.#globalListeners.clear(); }
    if (errors.length > 0) throw new AggregateError(errors, "client cleanup failed");
  }

  #receive(raw: string): void {
    const result = decodeWireMessage(raw, this.#maxMessageBytes);
    if (!result.ok) {
      this.recorder.record({ kind: "protocol.validation_failed", boundary: "protocol.validation_failed", outcome: "failure", reasonCode: result.code, component: "client", componentVersion: "0.1.0" });
      return;
    }
    const message = result.value;
    if (!isServerToClientMessage(message)) {
      this.recorder.record({ kind: "protocol.direction_rejected", boundary: "protocol.direction_rejected", outcome: "failure", reasonCode: "RT_MESSAGE_INVALID", component: "client", componentVersion: "0.1.0", details: { kind: message.kind, expectedDirection: "server_to_client" } });
      this.#transport?.close(1008, "server sent a client-only message");
      return;
    }
    this.recorder.record({ kind: "protocol.message.validated", boundary: "protocol.message.validated", outcome: "success", component: "client", componentVersion: "0.1.0", ...( "stream" in message && typeof message.stream === "string" ? { stream: message.stream } : {}), ...( "commandId" in message && typeof message.commandId === "string" ? { commandId: message.commandId } : {}), ...(message.kind === "event" ? { eventId: message.eventId } : {}) });
    switch (message.kind) {
      case "session.ready": this.#ready(message); break;
      case "session.rejected": this.#sessionRejected(message.error); break;
      case "session.auth.challenge":
      case "session.auth.updated": this.#sessionRejected({ code: "RT_AUTH_REFRESH_UNSUPPORTED", scope: "session", disposition: "fail_session", retryable: false }); break;
      case "heartbeat.ping": this.#send({ kind: "heartbeat.pong", pingId: message.pingId }); break;
      case "stream.subscribed": this.#subscribed(message); break;
      case "stream.replay.begin": this.#replayBegin(message.stream, message.subscriptionId, message.replayId, message.head); break;
      case "stream.resync.required": this.#setStreamState(message.stream, message.subscriptionId, "stream.resync.required"); break;
      case "stream.snapshot": this.#snapshot(message); break;
      case "event": this.#event(message); break;
      case "stream.replay.complete": this.#replayComplete(message.stream, message.subscriptionId, message.through); break;
      case "command.receipt": this.#receipt(message.commandId, message.state, message.error?.code); break;
      case "command.completed": this.#completed(message); break;
      case "command.status": this.#status(message); break;
      case "error": this.recorder.record({ kind: "server.error_observed", boundary: "client.error_observed", outcome: "failure", reasonCode: message.error.code, component: "client", componentVersion: "0.1.0", ...(message.error.stream ? { stream: message.error.stream } : {}), ...(message.error.commandId ? { commandId: message.error.commandId } : {}) }); break;
    }
  }

  #ready(message: SessionReady): void {
    try {
      assertCapabilityInvariants(message.capabilities);
      if (!Number.isSafeInteger(message.capabilities.maxMessageBytes) || message.capabilities.maxMessageBytes <= 0) throw new Error("capability floor not satisfied: maxMessageBytes");
      if (message.capabilities.maxRecoveryBufferRecords !== undefined) this.#positiveLimit(message.capabilities.maxRecoveryBufferRecords, "negotiated maxRecoveryBufferRecords");
      if (message.capabilities.maxRecoveryBufferBytes !== undefined) this.#positiveLimit(message.capabilities.maxRecoveryBufferBytes, "negotiated maxRecoveryBufferBytes");
    }
    catch (error) {
      this.recorder.record({ kind: "capability.invalid", boundary: "protocol.capability_violated", outcome: "invariant_violation", reasonCode: "RT_CAPABILITY_VIOLATED", component: "client", componentVersion: "0.1.0", details: { error: error instanceof Error ? error.message : String(error) } });
      this.#sessionRejected({ code: "RT_CAPABILITY_VIOLATED", scope: "session", disposition: "fail_session", retryable: false });
      return;
    }
    this.#maxMessageBytes = Math.min(this.#maxMessageBytes, message.capabilities.maxMessageBytes);
    if (message.capabilities.maxRecoveryBufferRecords !== undefined) this.#maxRecoveryBufferRecords = Math.min(this.#maxRecoveryBufferRecords, this.#positiveLimit(message.capabilities.maxRecoveryBufferRecords, "negotiated maxRecoveryBufferRecords"));
    if (message.capabilities.maxRecoveryBufferBytes !== undefined) this.#maxRecoveryBufferBytes = Math.min(this.#maxRecoveryBufferBytes, this.#positiveLimit(message.capabilities.maxRecoveryBufferBytes, "negotiated maxRecoveryBufferBytes"));
    this.#commandReceipts = message.capabilities.commandReceipts;
    this.#clearSessionOpenDeadline();
    this.#reconnectAttempt = 0;
    this.#sessionGeneration = message.sessionGeneration;
    this.#sessionId = message.sessionId;
    this.#transition("session", this.#sessionMachine, "session.ready");
    this.recorder.record({ kind: "session.ready_observed", boundary: "client.session_ready_observed", outcome: "success", component: "client", componentVersion: "0.1.0", sessionId: message.sessionId, details: { resumeStatus: message.resumeStatus, capabilities: message.capabilities } });
    for (const entry of this.#streams.values()) if (entry.consumers > 0) this.#subscribeEntry(entry);
    for (const command of this.#commands.values()) {
      if (command.state === "reconciling") { this.#commandTransition(command, "session.ready"); this.#send({ kind: "command.status.request", requestId: runtimeId("req"), commandId: command.commandId }); }
      else if (command.state === "queued") this.#sendCommand(command);
    }
    this.#notifyGlobal();
  }

  #sessionRejected(errorInfo: ErrorInfo): void {
    const { code, disposition, retryable, retryAfterMs } = errorInfo;
    this.#clearSessionOpenDeadline();
    if (retryable && disposition === "retry") {
      if (this.#sessionMachine.can("session.rejected.retry")) this.#transition("session", this.#sessionMachine, "session.rejected.retry");
      this.recorder.record({ kind: "session.rejected_observed", boundary: "client.session_rejected_observed", outcome: "failure", reasonCode: code, component: "client", componentVersion: "0.1.0", details: { disposition, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });
      this.#suspendOperations();
      if (this.#connectionMachine.can("protocol.reconnect_required")) this.#transition("connection", this.#connectionMachine, "protocol.reconnect_required");
      this.#connectAbort?.abort();
      this.#transport = undefined;
      void this.#disposeConnectionScope().catch((releaseError) => this.recorder.record({ kind: "resource.release_failed", boundary: "resource.release_failed", outcome: "failure", reasonCode: "RT_RESOURCE_RELEASE_FAILED", component: "client", componentVersion: "0.2.0", details: { error: releaseError instanceof Error ? releaseError.message : String(releaseError) } }));
      this.#scheduleReconnect(retryAfterMs);
      this.#notifyGlobal();
      return;
    }
    if (this.#sessionMachine.can("session.rejected")) this.#transition("session", this.#sessionMachine, "session.rejected");
    this.recorder.record({ kind: "session.rejected_observed", boundary: "client.session_rejected_observed", outcome: "failure", reasonCode: code, component: "client", componentVersion: "0.1.0" });
    for (const command of this.#commands.values()) {
      const error = new Error(code);
      if (command.machine.can("dispose")) this.#commandTransition(command, "dispose");
      command.rejectCompleted(error); command.rejectObserved(error);
      this.#commands.delete(command.commandId);
    }
    if (this.#connectionMachine.can("dispose")) this.#transition("connection", this.#connectionMachine, "dispose");
    this.#transport = undefined;
    void this.#disposeConnectionScope().catch((error) => this.recorder.record({ kind: "resource.release_failed", boundary: "resource.release_failed", outcome: "failure", reasonCode: "RT_RESOURCE_RELEASE_FAILED", component: "client", componentVersion: "0.2.0", details: { error: error instanceof Error ? error.message : String(error) } }));
    this.#notifyGlobal();
  }

  #subscribeEntry(entry: StreamEntry): void {
    if (entry.subscribeRequestInFlight) return;
    if (entry.machine.state === "idle") this.#streamTransition(entry, "subscribe.requested");
    else if (entry.machine.state === "suspended") this.#streamTransition(entry, "session.ready");
    else if (entry.machine.state !== "subscribing") return;
    entry.subscribeRequestInFlight = true;
    entry.subscribeRequestId = runtimeId("req");
    this.#send({ kind: "stream.subscribe", requestId: entry.subscribeRequestId, stream: entry.key, input: entry.input, after: entry.snapshot.cursor });
    this.recorder.record({ kind: "stream.restore_requested", boundary: "stream.restore_requested", outcome: "success", component: "client", componentVersion: "0.1.0", stream: entry.key, details: { after: entry.snapshot.cursor } });
  }

  #subscribed(message: StreamSubscribed): void {
    const entry = this.#streams.get(message.stream);
    if (!entry) return;
    if (message.requestId !== entry.subscribeRequestId) { this.#staleStreamMessage(entry, "stream.subscribed", { requestId: message.requestId }); return; }
    entry.subscribeRequestInFlight = false;
    entry.subscribeRequestId = undefined;
    entry.subscriptionId = message.subscriptionId;
    this.#streamTransition(entry, `stream.subscribed.${message.mode}`);
    if (message.mode === "live") entry.snapshot = { ...entry.snapshot, cursor: message.head ?? entry.snapshot.cursor };
    entry.listeners.forEach((listener) => listener());
  }

  #replayBegin(stream: string, subscriptionId: string, replayId: string, head: string): void {
    const entry = this.#streams.get(stream); if (!entry) return;
    if (entry.subscriptionId !== subscriptionId) { this.#staleStreamMessage(entry, "stream.replay.begin", { subscriptionId }); return; }
    entry.replayId = replayId; entry.recoveryHead = head;
    this.#streamTransition(entry, "stream.replay.begin");
    this.recorder.record({ kind: "replay.begin_observed", boundary: "client.replay_begin_observed", outcome: "success", component: "client", componentVersion: "0.1.0", stream, traceId: replayId, details: { head } });
  }

  #setStreamState(stream: string, subscriptionId: string, event: string): void { const entry = this.#streams.get(stream); if (entry) { if (entry.subscriptionId !== subscriptionId) this.#staleStreamMessage(entry, event, { subscriptionId }); else this.#streamTransition(entry, event); } }

  #snapshot(message: SnapshotMessage): void {
    const entry = this.#streams.get(message.stream); if (!entry) return;
    if (entry.subscriptionId !== message.subscriptionId) { this.#staleStreamMessage(entry, "stream.snapshot", { subscriptionId: message.subscriptionId }); return; }
    if (entry.definition.snapshotSchema && message.schema !== entry.definition.snapshotSchema) {
      this.#streamTransition(entry, "operation.error.fail");
      entry.snapshot = { ...entry.snapshot, status: "failed", error: "RT_CONTRACT_STREAM_SNAPSHOT_SCHEMA_MISMATCH" };
      this.recorder.record({ kind: "contract.schema_mismatch", boundary: "protocol.contract_mismatch", outcome: "failure", reasonCode: "RT_CONTRACT_STREAM_SNAPSHOT_SCHEMA_MISMATCH", component: "client", componentVersion: "0.2.0", stream: message.stream, details: { expected: entry.definition.snapshotSchema, actual: message.schema } });
      entry.listeners.forEach((listener) => listener());
      return;
    }
    this.#streamTransition(entry, "stream.snapshot");
    let data: unknown;
    let sequence: number;
    try {
      data = entry.definition.applySnapshot(message.state);
      sequence = entry.definition.snapshotSequence(data);
    } catch (error) {
      this.#failStreamMaterialization(entry, "snapshot", error);
      return;
    }
    entry.snapshot = { ...entry.snapshot, data, cursor: message.cursor, sequence };
    this.recorder.record({ kind: "snapshot.applied", boundary: "snapshot.applied", outcome: "success", component: "client", componentVersion: "0.1.0", stream: message.stream, details: { cursor: message.cursor, head: message.head } });
    for (const command of this.#commands.values()) {
      for (const position of command.causalEventPositions.values()) {
        if (position.stream === message.stream && position.sequence <= entry.snapshot.sequence) this.#observeCommandFromSnapshot(command, position, entry.snapshot.sequence);
      }
    }
    entry.listeners.forEach((listener) => listener());
  }

  #event(message: EventMessage): void {
    const entry = this.#streams.get(message.stream); if (!entry) return;
    if (message.sessionGeneration !== this.#sessionGeneration) { this.#staleStreamMessage(entry, "event", { eventSessionGeneration: message.sessionGeneration, currentSessionGeneration: this.#sessionGeneration }); return; }
    if ((entry.machine.state === "replaying" || entry.machine.state === "resyncing") && message.deliveryMode === "live") {
      const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
      this.recorder.record({ kind: "buffer.limit_checked", boundary: "buffer.limit_checked", outcome: "success", component: "client", componentVersion: "0.1.0", stream: message.stream, eventId: message.eventId, details: { nextRecords: entry.recoveryBuffer.length + 1, nextBytes: entry.recoveryBytes + bytes, maxRecords: this.#maxRecoveryBufferRecords, maxBytes: this.#maxRecoveryBufferBytes } });
      if (entry.recoveryBuffer.length + 1 > this.#maxRecoveryBufferRecords || entry.recoveryBytes + bytes > this.#maxRecoveryBufferBytes) {
        this.recorder.record({ kind: "buffer.overflowed", boundary: "buffer.overflowed", outcome: "invariant_violation", reasonCode: "RT_RECOVERY_OVERFLOW", component: "client", componentVersion: "0.1.0", stream: message.stream });
        this.#streamTransition(entry, "recovery_buffer.overflow");
        entry.recoveryBuffer = []; entry.recoveryBytes = 0;
        entry.snapshot = { ...entry.snapshot, bufferedRecords: 0, bufferedBytes: 0 };
        this.#requestRecovery(entry, null, "recovery_overflow");
        return;
      }
      entry.recoveryBuffer.push(message); entry.recoveryBytes += bytes;
      entry.snapshot = { ...entry.snapshot, bufferedRecords: entry.recoveryBuffer.length, bufferedBytes: entry.recoveryBytes };
      entry.listeners.forEach((listener) => listener());
      return;
    }
    const event = entry.machine.state === "live" ? "event.live" : message.deliveryMode === "snapshot_catchup" ? "event.snapshot_catchup" : "event.replay";
    if (!entry.machine.can(event)) return;
    this.#applyEvent(entry, message, event);
  }

  #applyEvent(entry: StreamEntry, message: EventMessage, transitionEvent: string): boolean {
    if (entry.dedupe.has(message.eventId)) {
      this.recorder.record({ kind: "event.duplicate_detected", boundary: "event.duplicate_detected", outcome: "success", component: "client", componentVersion: "0.1.0", stream: entry.key, eventId: message.eventId, details: { deliveryId: message.deliveryId } });
      return true;
    }
    this.recorder.record({ kind: "event.sequence_checked", boundary: "event.sequence_checked", outcome: "success", component: "client", componentVersion: "0.1.0", stream: entry.key, eventId: message.eventId, details: { expected: entry.snapshot.sequence + 1, received: message.sequence } });
    if (entry.snapshot.sequence > 0 && message.sequence !== entry.snapshot.sequence + 1) {
      this.recorder.record({ kind: "stream.gap_detected", boundary: "stream.gap_detected", outcome: "failure", reasonCode: "RT_GAP_DETECTED", component: "client", componentVersion: "0.1.0", stream: entry.key, eventId: message.eventId, details: { expected: entry.snapshot.sequence + 1, received: message.sequence } });
      const replayAfter = entry.machine.state === "live" ? entry.snapshot.cursor : null;
      if (entry.machine.can("gap.detected")) this.#streamTransition(entry, "gap.detected");
      this.#requestRecovery(entry, replayAfter, replayAfter ? "gap_replay" : "gap_snapshot");
      return false;
    }
    this.#streamTransition(entry, transitionEvent);
    let data: unknown;
    try { data = entry.definition.applyEvent(entry.snapshot.data, message); }
    catch (error) {
      this.#failStreamMaterialization(entry, "event", error, message.eventId);
      return false;
    }
    entry.snapshot = { ...entry.snapshot, data, cursor: message.cursor, sequence: message.sequence, error: null };
    entry.dedupe.set(message.eventId, message.sequence);
    this.#appliedEvents.add(message.eventId);
    while (entry.dedupe.size > this.#maxDedupeEntries) entry.dedupe.delete(entry.dedupe.keys().next().value!);
    while (this.#appliedEvents.size > this.#maxDedupeEntries) this.#appliedEvents.delete(this.#appliedEvents.values().next().value!);
    this.recorder.record({ kind: "client.event_applied", boundary: "client.event_applied", outcome: "success", component: "client", componentVersion: "0.1.0", stream: entry.key, eventId: message.eventId, ...(message.replayId ? { traceId: message.replayId } : {}), ...(message.commandId ? { commandId: message.commandId } : {}), details: { sequence: message.sequence, cursor: message.cursor, mode: message.deliveryMode } });
    for (const command of this.#commands.values()) if (command.causalEventIds.has(message.eventId)) this.#observeCommand(command.commandId, message.eventId);
    entry.listeners.forEach((listener) => listener());
    return true;
  }

  #replayComplete(stream: string, subscriptionId: string, through: string): void {
    const entry = this.#streams.get(stream); if (!entry) return;
    if (entry.subscriptionId !== subscriptionId) { this.#staleStreamMessage(entry, "stream.replay.complete", { subscriptionId }); return; }
    if (entry.snapshot.cursor !== through) {
      this.recorder.record({ kind: "replay.continuity_failed", boundary: "replay.completed", outcome: "invariant_violation", reasonCode: "RT_GAP_UNRESOLVED", component: "client", componentVersion: "0.1.0", stream, details: { cursor: entry.snapshot.cursor, through } });
      if (entry.machine.can("gap.detected")) this.#streamTransition(entry, "gap.detected");
      this.#requestRecovery(entry, null, "replay_fence_failed");
      return;
    }
    const buffered = [...entry.recoveryBuffer].sort((a, b) => a.sequence - b.sequence);
    const selected: EventMessage[] = [];
    const seen = new Set(entry.dedupe.keys());
    let projectedSequence = entry.snapshot.sequence;
    for (const message of buffered) {
      if (seen.has(message.eventId)) continue;
      if (message.sequence !== projectedSequence + 1) {
        this.recorder.record({ kind: "replay.buffer_continuity_failed", boundary: "replay.completed", outcome: "invariant_violation", reasonCode: "RT_GAP_UNRESOLVED", component: "client", componentVersion: "0.1.0", stream, ...(entry.replayId ? { traceId: entry.replayId } : {}), details: { expected: projectedSequence + 1, received: message.sequence, eventId: message.eventId } });
        if (entry.machine.can("gap.detected")) this.#streamTransition(entry, "gap.detected");
        this.#requestRecovery(entry, null, "buffer_continuity_failed");
        return;
      }
      seen.add(message.eventId);
      projectedSequence = message.sequence;
      selected.push(message);
    }
    entry.recoveryBuffer = []; entry.recoveryBytes = 0;
    this.#streamTransition(entry, "stream.replay.complete");
    entry.snapshot = { ...entry.snapshot, bufferedRecords: 0, bufferedBytes: 0 };
    for (const message of selected) if (!this.#applyEvent(entry, message, "event.live")) return;
    this.recorder.record({ kind: "replay.completed", boundary: "replay.completed", outcome: "success", component: "client", componentVersion: "0.1.0", stream, ...(entry.replayId ? { traceId: entry.replayId } : {}), details: { through } });
    entry.listeners.forEach((listener) => listener());
  }

  #receipt(commandId: string, state: string, code?: string): void {
    const command = this.#commands.get(commandId); if (!command) return;
    if (state === "accepted" && !this.#commandReceipts) {
      this.recorder.record({ kind: "capability.violation", boundary: "protocol.capability_violated", outcome: "invariant_violation", reasonCode: "RT_CAPABILITY_VIOLATED", component: "client", componentVersion: "0.1.0", commandId, details: { capability: "commandReceipts", received: state } });
      this.#transport?.close(1008, "unnegotiated command receipt");
      return;
    }
    if (state === "accepted") { this.#commandTransition(command, "command.receipt.accepted"); this.recorder.record({ kind: "command.receipt_observed", boundary: "client.command_receipt_observed", outcome: "success", component: "client", componentVersion: "0.1.0", commandId }); }
    else { this.#commandTransition(command, "command.receipt.rejected"); const error = new Error(code ?? `command ${state}`); command.rejectCompleted(error); command.rejectObserved(error); this.#commands.delete(commandId); }
    this.#notifyGlobal();
  }

  #completed(message: CommandCompleted): void {
    const command = this.#commands.get(message.commandId); if (!command) return;
    if (command.state === "sent" && this.#commandReceipts) {
      this.recorder.record({ kind: "capability.violation", boundary: "protocol.capability_violated", outcome: "invariant_violation", reasonCode: "RT_CAPABILITY_VIOLATED", component: "client", componentVersion: "0.1.0", commandId: message.commandId, details: { capability: "commandReceipts", expected: "command.receipt.accepted" } });
      this.#transport?.close(1008, "required command receipt missing");
      return;
    }
    const expectedSchema = this.#commandSchemas[command.type]?.resultSchema ?? `${command.type}Result@1`;
    if (message.schema !== expectedSchema) { this.#rejectCommandSchema(command, message.schema, expectedSchema); return; }
    const result = this.#validateCommandResult(command, message.result);
    if (result === undefined) return;
    this.#commandTransition(command, "command.completed"); command.result = result; command.resolveCompleted(result);
    this.#linkCausalEvents(command, message.causalEventIds, message.causalEvents);
    this.recorder.record({ kind: "command.completed_observed", boundary: "client.command_completed_observed", outcome: "success", component: "client", componentVersion: "0.1.0", commandId: message.commandId, details: { causalEventIds: message.causalEventIds ?? [], causalEventPositions: message.causalEvents?.length ?? 0 } });
    this.#reconcileCausalObservation(command);
    this.#notifyGlobal();
  }

  #status(message: CommandStatus): void {
    const command = this.#commands.get(message.commandId); if (!command) return;
    this.recorder.record({ kind: "command.status_observed", boundary: "client.command_status_observed", outcome: "success", component: "client", componentVersion: "0.1.0", commandId: command.commandId, details: { state: message.state } });
    if (message.state === "completed") {
      const expectedSchema = this.#commandSchemas[command.type]?.resultSchema ?? `${command.type}Result@1`;
      if (message.schema !== expectedSchema) { this.#rejectCommandSchema(command, message.schema ?? "missing", expectedSchema); return; }
      const result = this.#validateCommandResult(command, message.result ?? null);
      if (result === undefined) return;
      this.#commandTransition(command, "command.status.completed"); command.result = result; command.resolveCompleted(result);
      this.#linkCausalEvents(command, message.causalEventIds, message.causalEvents);
      this.#reconcileCausalObservation(command);
    } else if (message.state === "accepted") this.#commandTransition(command, "command.status.accepted");
    else { this.#commandTransition(command, `command.status.${message.state}`); const error = new Error(`command outcome ${message.state}`); command.rejectCompleted(error); command.rejectObserved(error); this.#commands.delete(command.commandId); }
    this.#notifyGlobal();
  }

  #observeCommand(commandId: string, eventId?: string): void {
    const command = this.#commands.get(commandId); if (!command || command.state === "observed") return;
    if (eventId) command.appliedCausalEventIds.add(eventId);
    if (eventId) command.causalEventIds.delete(eventId);
    if (command.causalEventIds.size > 0) return;
    if (command.state !== "completed") return;
    this.#commandTransition(command, "causal_events.applied"); command.resolveObserved();
    const observedEventId = command.appliedCausalEventIds.values().next().value as string | undefined;
    this.recorder.record({ kind: "command.observed", boundary: "command.observed", outcome: "success", component: "client", componentVersion: "0.1.0", commandId, ...(observedEventId ? { eventId: observedEventId, causalHandoffId: `event:${observedEventId}` } : {}) });
    this.#commands.delete(commandId);
    this.#notifyGlobal();
  }

  #linkCausalEvents(command: PendingCommand, eventIds: string[] | undefined, positions: CausalEventPosition[] | undefined): void {
    for (const eventId of eventIds ?? []) command.causalEventIds.add(eventId);
    for (const position of positions ?? []) {
      command.causalEventIds.add(position.eventId);
      command.causalEventPositions.set(position.eventId, position);
    }
  }

  #reconcileCausalObservation(command: PendingCommand): void {
    if (command.causalEventIds.size === 0) { this.#observeCommand(command.commandId); return; }
    for (const eventId of [...command.causalEventIds]) {
      if (this.#appliedEvents.has(eventId)) { this.#observeCommand(command.commandId, eventId); continue; }
      const position = command.causalEventPositions.get(eventId);
      if (!position) continue;
      const stream = this.#streams.get(position.stream);
      if (stream?.snapshot.cursor && position.sequence <= stream.snapshot.sequence) this.#observeCommandFromSnapshot(command, position, stream.snapshot.sequence);
    }
  }

  #observeCommandFromSnapshot(command: PendingCommand, position: CausalEventPosition, snapshotSequence: number): void {
    this.recorder.record({ kind: "command.causal_event_included_by_snapshot", boundary: "command.causal_event_included_by_snapshot", outcome: "success", component: "client", componentVersion: "0.1.0", commandId: command.commandId, eventId: position.eventId, stream: position.stream, causalHandoffId: `event:${position.eventId}`, details: { eventSequence: position.sequence, snapshotSequence } });
    this.#observeCommand(command.commandId, position.eventId);
  }

  #sendCommand(command: PendingCommand): void {
    command.attempt += 1; this.#commandTransition(command, command.state === "queued" ? "session.ready" : "retry.allowed");
    const sent = this.#send({ kind: "command", commandAttemptId: `${command.commandId}:attempt:${command.attempt}`, sessionGeneration: this.#sessionGeneration, commandId: command.commandId, type: command.type, schema: this.#commandSchemas[command.type]?.inputSchema ?? `${command.type}@1`, input: command.input, createdAt: command.createdAt });
    this.recorder.record({ kind: "command.sent", boundary: "command.sent", outcome: sent ? "success" : "failure", ...(sent ? {} : { reasonCode: "RT_TRANSPORT_SEND_FAILED" }), component: "client", componentVersion: "0.1.0", commandId: command.commandId, commandAttemptId: `${command.commandId}:attempt:${command.attempt}` });
  }

  #rejectCommandSchema(command: PendingCommand, actual: string, expected: string): void {
    const error = new Error(`RT_CONTRACT_COMMAND_RESULT_SCHEMA_MISMATCH: expected ${expected}, received ${actual}`);
    if (command.machine.can("command.result.invalid")) this.#commandTransition(command, "command.result.invalid");
    this.recorder.record({ kind: "contract.schema_mismatch", boundary: "protocol.contract_mismatch", outcome: "failure", reasonCode: "RT_CONTRACT_COMMAND_RESULT_SCHEMA_MISMATCH", component: "client", componentVersion: "0.2.0", commandId: command.commandId, details: { expected, actual } });
    command.rejectCompleted(error);
    command.rejectObserved(error);
    this.#commands.delete(command.commandId);
    this.#notifyGlobal();
  }

  #validateCommandResult(command: PendingCommand, value: JsonValue): JsonValue | undefined {
    const validate = this.#commandSchemas[command.type]?.validateResult;
    if (!validate) return value;
    try { return validate(value); }
    catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (command.machine.can("command.result.invalid")) this.#commandTransition(command, "command.result.invalid");
      this.recorder.record({
        kind: "contract.command_result_invalid",
        boundary: "protocol.contract_mismatch",
        outcome: "failure",
        reasonCode: "RT_CONTRACT_COMMAND_RESULT_INVALID",
        component: "client",
        componentVersion: "0.2.0",
        commandId: command.commandId,
        details: { error: error.message }
      });
      command.rejectCompleted(error);
      command.rejectObserved(error);
      this.#commands.delete(command.commandId);
      this.#notifyGlobal();
      return undefined;
    }
  }

  #send(message: Record<string, unknown>): boolean {
    if (!this.#transport) return false;
    const envelope = { protocol: "1.0", messageId: runtimeId("msg"), sentAt: new Date().toISOString(), ...message };
    const encoded = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > this.#maxMessageBytes) {
      this.recorder.record({ kind: "transport.send_rejected", boundary: "message.rejected", outcome: "failure", reasonCode: "RT_MESSAGE_TOO_LARGE", component: "client", componentVersion: "0.1.0", details: { bytes, maxMessageBytes: this.#maxMessageBytes } });
      this.#transport.close(1009, "outbound message too large");
      return false;
    }
    if (this.#transport.bufferedAmount + bytes > this.#maxMessageBytes) {
      this.recorder.record({ kind: "transport.send_rejected", boundary: "client.outbound_buffer_exceeded", outcome: "failure", reasonCode: "RT_SLOW_CONSUMER", component: "client", componentVersion: "0.1.0", details: { bufferedAmount: this.#transport.bufferedAmount, nextMessageBytes: bytes, maxBufferedBytes: this.#maxMessageBytes } });
      this.#transport.close(1013, "outbound buffer exceeded");
      return false;
    }
    try { this.#transport.send(encoded); return true; }
    catch (error) {
      this.recorder.record({ kind: "transport.send_failed", boundary: "transport.send_failed", outcome: "failure", reasonCode: "RT_TRANSPORT_SEND_FAILED", component: "client", componentVersion: "0.1.0", details: { error: error instanceof Error ? error.message : String(error) } });
      this.#transport.close(1011, "transport send failed");
      return false;
    }
  }

  #closed(event: { code: number; reason: string }, closedTransport: TransportConnection, connectAbort: AbortController): void {
    if (this.#transport !== closedTransport) return;
    if (this.#connectAbort === connectAbort) connectAbort.abort();
    this.#clearSessionOpenDeadline();
    this.#transport = undefined;
    void this.#disposeConnectionScope().catch(() => undefined);
    if (this.#disposed) return;
    if (this.sessionState === "rejected" || this.connectionState === "disposed") { this.#notifyGlobal(); return; }
    this.recorder.record({ kind: "disconnect.detected", boundary: "disconnect.detected", outcome: "success", component: "client", componentVersion: "0.1.0", details: event });
    if (this.#connectionMachine.state === "open") this.#transition("connection", this.#connectionMachine, "transport.closed_unexpectedly");
    if (["opening", "ready", "reauthenticating"].includes(this.#sessionMachine.state)) this.#transition("session", this.#sessionMachine, "transport.closed_unexpectedly");
    this.#suspendOperations();
    this.#scheduleReconnect();
    this.#notifyGlobal();
  }

  #scheduleReconnect(retryAfterMs?: number): void {
    if (this.#disposed || this.#reconnectTimer) return;
    const ceiling = this.#reconnectDelaysMs[Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1)]!;
    const sample = this.#random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error("RT_RECONNECT_RANDOM_INVALID");
    const jitteredDelay = Math.max(1, Math.floor(ceiling * (0.5 + sample * 0.5)));
    const retryFloor = retryAfterMs === undefined ? 0 : Math.min(retryAfterMs, 300_000);
    const delay = Math.max(jitteredDelay, retryFloor);
    this.#reconnectAttempt += 1;
    this.recorder.record({ kind: "reconnect.scheduled", boundary: "reconnect.scheduled", outcome: "success", component: "client", componentVersion: "0.1.0", details: { delay, ceiling, jitter: "half_to_full", attempt: this.#reconnectAttempt, ...(retryAfterMs === undefined ? {} : { retryAfterMs: retryFloor }) } });
    this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = undefined; void this.connect(); }, delay);
  }

  async #rollbackOpenedTransport(): Promise<void> {
    this.#clearSessionOpenDeadline();
    this.#transport = undefined;
    await this.#disposeConnectionScope().catch(() => undefined);
    if (this.#connectionMachine.state === "open") this.#transition("connection", this.#connectionMachine, "transport.closed_unexpectedly");
    if (["opening", "ready", "reauthenticating"].includes(this.#sessionMachine.state)) this.#transition("session", this.#sessionMachine, "transport.closed_unexpectedly");
  }

  #armSessionOpenDeadline(connectAbort: AbortController, transport: TransportConnection): void {
    this.#clearSessionOpenDeadline();
    const timer = setTimeout(() => {
      if (this.#disposed || this.#transport !== transport || this.sessionState !== "opening") return;
      this.#clearSessionOpenDeadline();
      this.recorder.record({ kind: "session.initialization_timed_out", boundary: "session.initialization_timed_out", outcome: "failure", reasonCode: "RT_SESSION_INIT_TIMEOUT", component: "client", componentVersion: "0.2.0", details: { timeoutMs: this.#sessionOpenTimeoutMs } });
      if (this.#connectAbort === connectAbort) connectAbort.abort();
      if (this.#sessionMachine.can("open_deadline.elapsed")) this.#transition("session", this.#sessionMachine, "open_deadline.elapsed");
      if (this.#sessionMachine.can("retry_authorized")) this.#transition("session", this.#sessionMachine, "retry_authorized");
      if (this.#connectionMachine.can("protocol.reconnect_required")) this.#transition("connection", this.#connectionMachine, "protocol.reconnect_required");
      this.#transport = undefined;
      void this.#disposeConnectionScope().catch(() => undefined);
      this.#scheduleReconnect();
      this.#notifyGlobal();
    }, this.#sessionOpenTimeoutMs);
    this.#sessionOpenDeadlineResource = this.#connectionScope?.acquire("session_open_deadline", () => clearTimeout(timer));
  }

  #clearSessionOpenDeadline(): void {
    const resource = this.#sessionOpenDeadlineResource;
    this.#sessionOpenDeadlineResource = undefined;
    if (resource) void resource.dispose().catch(() => undefined);
  }

  #suspendOperations(): void {
    for (const entry of this.#streams.values()) if (["subscribing", "replaying", "resyncing", "live"].includes(entry.machine.state)) { entry.subscribeRequestInFlight = false; entry.subscribeRequestId = undefined; this.#streamTransition(entry, "transport.closed_unexpectedly"); }
    for (const command of this.#commands.values()) {
      if (command.state === "sent") this.#commandTransition(command, "transport.closed_before_receipt");
      else if (command.state === "accepted") this.#commandTransition(command, "transport.closed");
      else if (command.state === "completed") this.#commandTransition(command, "transport.closed_before_observed");
    }
  }

  #disposeConnectionScope(): Promise<void> {
    const scope = this.#connectionScope;
    if (!scope) return this.#connectionCleanupPromise ?? Promise.resolve();
    this.#connectionScope = undefined;
    let tracked!: Promise<void>;
    tracked = scope.dispose().finally(() => { if (this.#connectionCleanupPromise === tracked) this.#connectionCleanupPromise = undefined; });
    this.#connectionCleanupPromise = tracked;
    return tracked;
  }

  #boundedDuration(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new Error(`${name} must be an integer between 1 and 300000`);
    return value;
  }

  #failStreamMaterialization(entry: StreamEntry, phase: "snapshot" | "event", error: unknown, eventId?: string): void {
    if (entry.machine.can("operation.error.fail")) this.#streamTransition(entry, "operation.error.fail");
    entry.recoveryBuffer = [];
    entry.recoveryBytes = 0;
    entry.snapshot = { ...entry.snapshot, status: "failed", error: phase === "snapshot" ? "RT_STREAM_SNAPSHOT_MATERIALIZATION_FAILED" : "RT_STREAM_EVENT_MATERIALIZATION_FAILED", bufferedRecords: 0, bufferedBytes: 0 };
    this.recorder.record({ kind: "stream.materialization_failed", boundary: "stream.materialization_failed", outcome: "failure", reasonCode: entry.snapshot.error ?? "RT_STREAM_MATERIALIZATION_FAILED", component: "client", componentVersion: "0.2.0", stream: entry.key, ...(eventId ? { eventId } : {}), details: { phase, errorType: error instanceof Error ? error.name : typeof error } });
    entry.listeners.forEach((listener) => listener());
  }

  #releaseEntry(entry: StreamEntry): void {
    this.#cancelReleaseTimer(entry);
    if (entry.subscriptionId && this.sessionState === "ready") this.#send({ kind: "stream.unsubscribe", requestId: runtimeId("req"), subscriptionId: entry.subscriptionId });
    if (entry.machine.can("unsubscribe")) this.#streamTransition(entry, "unsubscribe");
    entry.recoveryBuffer = []; entry.recoveryBytes = 0; entry.dedupe.clear();
    if (this.#streams.get(entry.key) === entry) this.#streams.delete(entry.key);
  }

  #staleStreamMessage(entry: StreamEntry, kind: string, details: Record<string, unknown>): void {
    this.recorder.record({ kind: "stale_completion.fenced", boundary: "stale_completion.fenced", outcome: "success", component: "client", componentVersion: "0.1.0", stream: entry.key, details: { kind, ...details } });
  }

  #requestRecovery(entry: StreamEntry, after: string | null, reason: string): void {
    if (!entry.machine.can("recovery.requested")) {
      this.recorder.record({ kind: "recovery.request_rejected", boundary: "recovery.requested", outcome: "invariant_violation", reasonCode: "RT_RECOVERY_STATE_INVALID", component: "client", componentVersion: "0.1.0", stream: entry.key, details: { state: entry.machine.state, reason } });
      return;
    }
    if (entry.subscriptionId && this.sessionState === "ready") this.#send({ kind: "stream.unsubscribe", requestId: runtimeId("req"), subscriptionId: entry.subscriptionId });
    this.#streamTransition(entry, "recovery.requested");
    delete entry.subscriptionId;
    delete entry.recoveryHead;
    delete entry.replayId;
    entry.recoveryBuffer = [];
    entry.recoveryBytes = 0;
    entry.snapshot = { ...entry.snapshot, bufferedRecords: 0, bufferedBytes: 0 };
    entry.subscribeRequestInFlight = true;
    entry.subscribeRequestId = runtimeId("req");
    this.#send({ kind: "stream.subscribe", requestId: entry.subscribeRequestId, stream: entry.key, input: entry.input, after });
    const boundary = reason === "gap_replay" ? "recovery.selected" : "recovery.restarted";
    this.recorder.record({ kind: "recovery.requested", boundary, outcome: "success", component: "client", componentVersion: "0.1.0", stream: entry.key, details: { after, reason, action: after ? "replay" : "fenced_snapshot" } });
  }

  #cancelReleaseTimer(entry: StreamEntry): void {
    if (entry.releaseTimer) { clearTimeout(entry.releaseTimer); delete entry.releaseTimer; }
    if (entry.releaseTimerResource) { const resource = entry.releaseTimerResource; delete entry.releaseTimerResource; void resource.dispose(); }
  }

  #transition(machineName: string, machine: ProtocolStateMachine, event: string): void {
    const transition = machine.transition(event);
    this.recorder.record({ kind: `${machineName}.transition`, boundary: `${machineName}.transition`, outcome: "success", component: "client", componentVersion: "0.1.0", details: transition });
  }

  #streamTransition(entry: StreamEntry, event: string): void {
    const transition = entry.machine.transition(event);
    entry.snapshot = { ...entry.snapshot, status: transition.to as StreamStatus };
    this.recorder.record({ kind: "stream.transition", boundary: "stream.transition", outcome: "success", component: "client", componentVersion: "0.1.0", stream: entry.key, details: transition });
    entry.listeners.forEach((listener) => listener());
  }

  #commandTransition(command: PendingCommand, event: string): void {
    const transition = command.machine.transition(event);
    command.state = transition.to as CommandState;
    this.recorder.record({ kind: "command.transition", boundary: "command.transition", outcome: "success", component: "client", componentVersion: "0.1.0", commandId: command.commandId, details: transition });
  }

  #notifyGlobal(): void {
    this.#runtimeSnapshot = { connectionState: this.connectionState, sessionState: this.sessionState, sessionGeneration: this.#sessionGeneration, pendingCount: this.pendingCount };
    this.#globalListeners.forEach((listener) => listener());
  }

  #positiveLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
    return value;
  }

  #nonNegativeLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
    return value;
  }
}
