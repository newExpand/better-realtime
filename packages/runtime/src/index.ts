import { RealtimeClient as CoreRealtimeClient, type StreamDefinition as CoreStreamDefinition } from "@realtime/core";
import {
  BoundedEvidenceExporter,
  FlightRecorder,
  type EvidenceSink as InternalEvidenceSink
} from "@realtime/diagnostics/browser";
import { BrowserWebSocketTransport } from "@realtime/transport-reference/browser";
import {
  RealtimeContractError,
  contractRuntime,
  decodeContractStreamSnapshot,
  type AnyRealtimeContract,
  type CommandInput,
  type CommandName,
  type CommandResult,
  type ContractIdentity,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type RealtimeContract,
  type StreamEventFor,
  type StreamInput,
  type StreamName,
  type StreamState
} from "./contract.js";
import type {
  DiagnosticProducerInstance,
  SourceDiagnosticEvidenceRecord
} from "./diagnostic-types.js";

export { BETTER_REALTIME_COMPONENT_ID, BETTER_REALTIME_PACKAGE, BETTER_REALTIME_PRODUCT, BETTER_REALTIME_VERSION } from "./release.js";

export {
  JSON_SCHEMA_DIALECT,
  RealtimeContractError,
  command,
  defineRealtimeContract,
  jsonSchema,
  stateStream,
  stream
} from "./contract.js";
export type {
  AnyRealtimeContract,
  CommandConfig,
  CommandContract,
  CommandInput,
  CommandManifest,
  CommandName,
  CommandResult,
  ContractStreams,
  ContractErrorCode,
  ContractIdentity,
  ContractStreamEvent,
  EventSchemaMap,
  InferSchema,
  InferJsonSchema,
  JsonObject,
  JsonPrimitive,
  JsonSchema,
  JsonValue,
  RealtimeContract,
  RealtimeContractManifest,
  RuntimeSchema,
  StateStreamConfig,
  StateStreamContract,
  StateStreamEventDefinitions,
  StateStreamEventMeta,
  StreamConfig,
  StreamContract,
  StreamEvent,
  StreamEventFor,
  StreamInput,
  StreamManifest,
  StreamName,
  StreamState
} from "./contract.js";

export type ConnectionState = "idle" | "connecting" | "open" | "backing_off" | "disposed";
export type SessionState = "absent" | "opening" | "ready" | "reauthenticating" | "suspended" | "rejected" | "disposed";
export type StreamStatus = "idle" | "subscribing" | "replaying" | "resyncing" | "live" | "suspended" | "failed" | "closed";
export type CommandState = "created" | "queued" | "sent" | "accepted" | "completed" | "observed" | "reconciling" | "rejected" | "expired" | "unknown" | "cancelled";
export type DeepReadonly<T> = T extends JsonPrimitive
  ? T
  : T extends readonly unknown[]
    ? { readonly [TIndex in keyof T]: DeepReadonly<T[TIndex]> }
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

export interface RuntimeSnapshot {
  readonly connectionState: ConnectionState;
  readonly sessionState: SessionState;
  readonly sessionGeneration: number;
  readonly pendingCount: number;
}

export interface StreamSnapshot<TState> {
  readonly data: DeepReadonly<TState>;
  readonly status: StreamStatus;
  readonly cursor: string | null;
  readonly sequence: number;
  readonly error: string | null;
  readonly bufferedRecords: number;
  readonly bufferedBytes: number;
}

export interface StreamHandle<TState> {
  readonly key: string;
  subscribe(listener: () => void): () => void;
  getSnapshot(): StreamSnapshot<TState>;
}

export interface CommandAttempt<TResult> {
  readonly commandId: string;
  readonly state: CommandState;
  readonly completed: Promise<TResult>;
  readonly observed: Promise<void>;
}

export interface CommandAttemptSnapshot {
  readonly commandId: string;
  readonly state: CommandState;
  readonly deliveryAttempt: number;
  readonly createdAt: string;
  readonly completionSettled: boolean;
  readonly observationSettled: boolean;
}

export interface CommandActivitySnapshot {
  readonly completionPendingCount: number;
  readonly observationPendingCount: number;
  readonly lastAttempt: CommandAttemptSnapshot | null;
  readonly lastError: Error | null;
}

export interface RealtimeWebSocketEventMap {
  readonly open: unknown;
  readonly error: unknown;
  readonly message: { readonly data: unknown };
  readonly close: { readonly code: number; readonly reason: string };
}

export interface WebSocketLike {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<TType extends keyof RealtimeWebSocketEventMap>(type: TType, listener: (event: RealtimeWebSocketEventMap[TType]) => void, options?: { readonly once?: boolean } | boolean): void;
  removeEventListener<TType extends keyof RealtimeWebSocketEventMap>(type: TType, listener: (event: RealtimeWebSocketEventMap[TType]) => void, options?: { readonly once?: boolean } | boolean): void;
}

export interface WebSocketConstructor {
  new(url: string | URL, protocols?: string | string[]): WebSocketLike;
}

export interface RealtimeTransportConnection {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: (event: { readonly code: number; readonly reason: string }) => void): () => void;
}

export interface RealtimeTransportFactory {
  connect(signal?: AbortSignal): Promise<RealtimeTransportConnection>;
}

interface RealtimeClientCommonOptions {
  readonly auth: (signal?: AbortSignal) => JsonObject | Promise<JsonObject>;
  readonly diagnostics?: RealtimeClientDiagnosticsOptions;
  readonly reconnectDelaysMs?: number[];
  readonly sessionOpenTimeoutMs?: number;
  readonly maxPendingCommands?: number;
  readonly maxDedupeEntries?: number;
  readonly idleReleaseMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxRecoveryBufferRecords?: number;
  readonly maxRecoveryBufferBytes?: number;
}

export interface RealtimeEvidenceEnvelope {
  readonly schemaVersion: "1.0";
  readonly tenantId: string;
  readonly payloadPolicy: "redacted";
  readonly record: SourceDiagnosticEvidenceRecord;
}

export interface RealtimeEvidenceSink {
  readonly schemaVersion: "1.0";
  readonly capabilities: {
    readonly authoritative: boolean;
    readonly durable: boolean;
    readonly sampled: boolean;
    readonly multiProducer: boolean;
  };
  record(evidence: RealtimeEvidenceEnvelope): Promise<void>;
  registerExpectedProducers?(instances: readonly DiagnosticProducerInstance[]): void;
  finalizeExpectedProducers?(): void;
  declareExpectedProducers?(instances: readonly DiagnosticProducerInstance[]): void;
  closeProducer?(checkpoint: DiagnosticProducerInstance & { readonly highWaterMark: number; readonly closed: true }): void;
  recordExportFailure?(count?: number): void;
}

export interface RealtimeClientDiagnosticsOptions {
  readonly sink: RealtimeEvidenceSink;
  /**
   * Shared mode registers this client's producer additively. The topology
   * owner must call sink.finalizeExpectedProducers() after every producer is
   * registered and before any producer is disposed.
   */
  readonly topology?: "exclusive" | "shared";
  /** Secret key material used only to pseudonymize evidence before export. */
  readonly pseudonymizationKey: string;
  readonly tenantId: string;
  readonly maxPendingRecords?: number;
}

export interface RealtimeEvidenceExportSnapshot {
  readonly pendingRecords: number;
  readonly acceptedRecords: number;
  readonly exportFailedRecords: number;
  readonly closed: boolean;
}

export type RealtimeClientOptions = RealtimeClientCommonOptions & (
  | {
      readonly url: string;
      readonly webSocket?: WebSocketConstructor;
      readonly connectTimeoutMs?: number;
      readonly transport?: never;
    }
  | {
      readonly transport: RealtimeTransportFactory;
      readonly url?: never;
      readonly webSocket?: never;
      readonly connectTimeoutMs?: never;
    }
);

export interface RealtimeClient<TContract extends AnyRealtimeContract> {
  readonly contract: TContract;
  readonly identity: ContractIdentity;
  connect(): Promise<void>;
  stream<TName extends StreamName<TContract>>(name: TName, input: StreamInput<TContract, TName>): StreamHandle<StreamState<TContract, TName>>;
  execute<TName extends CommandName<TContract>>(name: TName, input: CommandInput<TContract, TName>): CommandAttempt<CommandResult<TContract, TName>>;
  subscribeRuntime(listener: () => void): () => void;
  runtimeSnapshot(): RuntimeSnapshot;
  subscribeCommand<TName extends CommandName<TContract>>(name: TName, listener: () => void): () => void;
  commandSnapshot<TName extends CommandName<TContract>>(name: TName): CommandActivitySnapshot;
  flushEvidence(): Promise<void>;
  evidenceSnapshot(): RealtimeEvidenceExportSnapshot;
  dispose(): Promise<void>;
}

export function createRealtimeClient<TContract extends AnyRealtimeContract>(contract: TContract, options: RealtimeClientOptions): RealtimeClient<TContract> {
  const runtime = contractRuntime(contract);
  const validators = contract as AnyRealtimeContract;
  const usesCustomTransport = "transport" in options && options.transport !== undefined;
  if (usesCustomTransport && ("url" in options || "webSocket" in options || "connectTimeoutMs" in options)) {
    throw new RealtimeContractError("RT_CONTRACT_INVALID", "client.transport", ["transport cannot be combined with url, webSocket, or connectTimeoutMs"]);
  }
  const WebSocketImpl = !usesCustomTransport ? options.webSocket ?? globalThis.WebSocket : undefined;
  if (!usesCustomTransport && !WebSocketImpl) throw new RealtimeContractError("RT_CONTRACT_INVALID", "client.webSocket", ["browser WebSocket implementation is unavailable"]);
  const transport = usesCustomTransport
    ? options.transport
    : new BrowserWebSocketTransport(options.url, WebSocketImpl as unknown as typeof WebSocket, { ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }) });

  const definitions: CoreStreamDefinition<JsonValue, unknown>[] = [...runtime.streams].map(([name, member]) => ({
    stream: name,
    snapshotSchema: contract.manifest.streams[name]!.snapshotSchema,
    key: (input) => {
      const validated = validators.validateStreamInput(name, input);
      const key = member.definition.key(validated);
      if (typeof key !== "string" || key.length === 0 || key.length > 512) throw new RealtimeContractError("RT_CONTRACT_STREAM_INPUT_INVALID", name, ["key must return 1..512 characters"]);
      return key;
    },
    initial: (input) => {
      const validated = validators.validateStreamInput(name, input);
      return validators.validateStreamSnapshot(name, member.definition.initial(validated));
    },
    applyEvent: (state, event) => {
      const validated = validators.validateStreamEvent(name, event);
      return validators.validateStreamSnapshot(name, member.definition.applyEvent(state, validated));
    },
    decodeSnapshot: (state) => decodeContractStreamSnapshot(contract, name, state),
    applySnapshot: (state) => validators.validateStreamSnapshot(name, state),
    snapshotSequence: (state) => decodeContractStreamSnapshot(contract, name, state).sequence
  })) as CoreStreamDefinition<JsonValue, unknown>[];

  let evidenceExporter: BoundedEvidenceExporter | undefined;
  const evidenceRecorder = options.diagnostics
    ? new FlightRecorder({
        runtimeId: `client_${crypto.randomUUID()}`,
        producerRole: "client",
        onRecord: (record) => evidenceExporter?.record(record)
      })
    : undefined;
  if (options.diagnostics && evidenceRecorder) {
    evidenceExporter = new BoundedEvidenceExporter({
      sink: options.diagnostics.sink as unknown as InternalEvidenceSink,
      ...(options.diagnostics.topology === undefined ? {} : { topology: options.diagnostics.topology }),
      pseudonymizationKey: options.diagnostics.pseudonymizationKey,
      tenantId: options.diagnostics.tenantId,
      expectedProducers: [{
        producerRole: evidenceRecorder.producerRole,
        runtimeId: evidenceRecorder.runtimeId,
        runtimeBootId: evidenceRecorder.runtimeBootId
      }],
      ...(options.diagnostics.maxPendingRecords === undefined ? {} : { maxPendingRecords: options.diagnostics.maxPendingRecords })
    });
  }

  const internal = new CoreRealtimeClient({
    transport,
    contract: contract.identity,
    auth: options.auth,
    streams: definitions,
    commands: Object.fromEntries(Object.entries(contract.manifest.commands).map(([name, command]) => [name, {
      inputSchema: command.schema,
      resultSchema: command.resultSchema,
      validateResult: (value: JsonValue) => validators.validateCommandResult(name, value) as JsonValue
    }])),
    ...(evidenceRecorder ? { recorder: evidenceRecorder } : {}),
    ...(options.reconnectDelaysMs ? { reconnectDelaysMs: options.reconnectDelaysMs } : {}),
    ...(options.sessionOpenTimeoutMs === undefined ? {} : { sessionOpenTimeoutMs: options.sessionOpenTimeoutMs }),
    ...(options.maxPendingCommands !== undefined ? { maxPendingCommands: options.maxPendingCommands } : {}),
    ...(options.maxDedupeEntries !== undefined ? { maxDedupeEntries: options.maxDedupeEntries } : {}),
    ...(options.idleReleaseMs !== undefined ? { idleReleaseMs: options.idleReleaseMs } : {}),
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
    ...(options.maxRecoveryBufferRecords !== undefined ? { maxRecoveryBufferRecords: options.maxRecoveryBufferRecords } : {}),
    ...(options.maxRecoveryBufferBytes !== undefined ? { maxRecoveryBufferBytes: options.maxRecoveryBufferBytes } : {})
  });

  return Object.freeze({
    contract,
    identity: contract.identity,
    connect: () => internal.connect(),
    stream: (name: string, input: unknown) => {
      const validated = validators.validateStreamInput(name, input);
      const handle = internal.stream(name, validated as JsonValue);
      let sourceSnapshot: ReturnType<typeof handle.getSnapshot> | undefined;
      let publicSnapshot: StreamSnapshot<unknown> | undefined;
      const getSnapshot = (): StreamSnapshot<unknown> => {
        const current = handle.getSnapshot();
        if (current !== sourceSnapshot) {
          sourceSnapshot = current;
          publicSnapshot = Object.freeze({ ...current, data: freezeJson(cloneOwnedJson(current.data as JsonValue)) });
        }
        return publicSnapshot!;
      };
      return { key: handle.key, subscribe: handle.subscribe, getSnapshot };
    },
    execute: (name: string, input: unknown) => {
      const validated = validators.validateCommandInput(name, input);
      const attempt = internal.execute(name, validated as JsonValue);
      return {
        commandId: attempt.commandId,
        get state() { return attempt.state; },
        completed: attempt.completed,
        observed: attempt.observed
      };
    },
    subscribeRuntime: (listener: () => void) => internal.subscribeRuntime(listener),
    runtimeSnapshot: () => internal.runtimeSnapshot(),
    subscribeCommand: (name: string, listener: () => void) => internal.subscribeCommand(name, listener),
    commandSnapshot: (name: string) => internal.commandSnapshot(name),
    flushEvidence: () => evidenceExporter?.flush() ?? Promise.resolve(),
    evidenceSnapshot: () => evidenceExporter?.snapshot() ?? {
      pendingRecords: 0,
      acceptedRecords: 0,
      exportFailedRecords: 0,
      closed: false
    },
    dispose: async () => {
      try {
        await internal.dispose();
      } finally {
        if (evidenceExporter && evidenceRecorder) {
          await evidenceExporter.close([{
            producerRole: evidenceRecorder.producerRole,
            runtimeId: evidenceRecorder.runtimeId,
            runtimeBootId: evidenceRecorder.runtimeBootId,
            highWaterMark: evidenceRecorder.stats().highWaterMark,
            closed: true
          }]);
        }
      }
    }
  }) as RealtimeClient<TContract>;
}

function cloneOwnedJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneOwnedJson(entry)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneOwnedJson(entry)])) as T;
  return value;
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
  }
  return Object.freeze(value) as JsonValue;
}
