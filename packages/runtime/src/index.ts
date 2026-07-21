import { RealtimeClient as CoreRealtimeClient, type StreamDefinition as CoreStreamDefinition } from "@realtime/core";
import { BrowserWebSocketTransport } from "@realtime/transport-reference/browser";
import {
  RealtimeContractError,
  contractRuntime,
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

export { BETTER_REALTIME_COMPONENT_ID, BETTER_REALTIME_PACKAGE, BETTER_REALTIME_PRODUCT, BETTER_REALTIME_VERSION } from "./release.js";

export {
  JSON_SCHEMA_DIALECT,
  RealtimeContractError,
  command,
  defineRealtimeContract,
  jsonSchema,
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

export interface RealtimeClientOptions {
  readonly url: string;
  readonly auth: (signal?: AbortSignal) => JsonObject | Promise<JsonObject>;
  readonly webSocket?: WebSocketConstructor;
  readonly reconnectDelaysMs?: number[];
  readonly connectTimeoutMs?: number;
  readonly sessionOpenTimeoutMs?: number;
  readonly maxPendingCommands?: number;
  readonly maxDedupeEntries?: number;
  readonly idleReleaseMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxRecoveryBufferRecords?: number;
  readonly maxRecoveryBufferBytes?: number;
}

export interface RealtimeClient<TContract extends AnyRealtimeContract> {
  readonly contract: TContract;
  readonly identity: ContractIdentity;
  connect(): Promise<void>;
  stream<TName extends StreamName<TContract>>(name: TName, input: StreamInput<TContract, TName>): StreamHandle<StreamState<TContract, TName>>;
  execute<TName extends CommandName<TContract>>(name: TName, input: CommandInput<TContract, TName>): CommandAttempt<CommandResult<TContract, TName>>;
  subscribeRuntime(listener: () => void): () => void;
  runtimeSnapshot(): RuntimeSnapshot;
  dispose(): Promise<void>;
}

export function createRealtimeClient<TContract extends AnyRealtimeContract>(contract: TContract, options: RealtimeClientOptions): RealtimeClient<TContract> {
  const runtime = contractRuntime(contract);
  const validators = contract as AnyRealtimeContract;
  const WebSocketImpl = options.webSocket ?? globalThis.WebSocket;
  if (!WebSocketImpl) throw new RealtimeContractError("RT_CONTRACT_INVALID", "client.webSocket", ["browser WebSocket implementation is unavailable"]);

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
    applySnapshot: (state) => validators.validateStreamSnapshot(name, state),
    snapshotSequence: (state) => {
      const sequence = member.definition.snapshotSequence(state);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RealtimeContractError("RT_CONTRACT_STREAM_SNAPSHOT_INVALID", name, ["snapshotSequence must return a non-negative safe integer"]);
      return sequence;
    }
  })) as CoreStreamDefinition<JsonValue, unknown>[];

  const internal = new CoreRealtimeClient({
    transport: new BrowserWebSocketTransport(options.url, WebSocketImpl as unknown as typeof WebSocket, { ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }) }),
    contract: contract.identity,
    auth: options.auth,
    streams: definitions,
    commands: Object.fromEntries(Object.entries(contract.manifest.commands).map(([name, command]) => [name, {
      inputSchema: command.schema,
      resultSchema: command.resultSchema,
      validateResult: (value: JsonValue) => validators.validateCommandResult(name, value) as JsonValue
    }])),
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
    dispose: () => internal.dispose()
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
