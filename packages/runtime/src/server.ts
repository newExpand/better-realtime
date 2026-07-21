import { PostgresGatewayServer, type PostgresGatewayApplicationContext } from "@realtime/server-node";
import { PostgresEventLog, postgresStorageNames, type IdentityKey } from "@realtime/store-postgres";
import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import {
  contractRuntime,
  RealtimeContractError,
  type AnyRealtimeContract,
  type CommandInput,
  type CommandName,
  type CommandResult,
  type JsonObject,
  type JsonValue,
  type RealtimeContract,
  type StreamEventFor,
  type StreamInput,
  type StreamName,
  type StreamState
} from "./contract.js";
import type { DoctorQueryDefinition, EvidenceBundleV1 } from "./diagnostic-types.js";
import { selectTenantEvidenceRecords } from "./evidence-scope.js";
import { validatePreparedEvent } from "./application-adapter.js";

export interface PrincipalIdentityKey { version: number; key: string | Uint8Array }

export interface WebSocketOriginPolicy {
  allowedOrigins: readonly string[];
  allowMissingOrigin?: boolean;
}

export interface AuthenticatedPrincipal {
  tenantId: string;
  authenticationRealm: string;
  issuer: string;
  subject: string;
  permissions: string[];
}

export interface PostgresProfileOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, "connectionString">;
  identityKeys: readonly PrincipalIdentityKey[];
  commandResultRetentionMs?: number;
  idempotencyRetentionMs?: number;
  replayRetentionMs?: number;
  operationTimeoutMs?: number;
  schema?: string;
}

export interface PostgresRealtimeProfile {
  readonly kind: "postgres";
  readonly pool: Pool;
  readonly ownsPool: boolean;
  readonly identityKeys: readonly PrincipalIdentityKey[];
  readonly commandResultRetentionMs?: number;
  readonly idempotencyRetentionMs?: number;
  readonly replayRetentionMs?: number;
  readonly operationTimeoutMs?: number;
  readonly schema: string;
}

export function postgres(options: PostgresProfileOptions): PostgresRealtimeProfile {
  if ((options.connectionString ? 1 : 0) + (options.pool ? 1 : 0) !== 1) throw new Error("RT_POSTGRES_PROFILE_SOURCE_INVALID");
  if (options.identityKeys.length === 0 || new Set(options.identityKeys.map((entry) => entry.version)).size !== options.identityKeys.length || options.identityKeys.some((entry) => !Number.isSafeInteger(entry.version) || entry.version < 1 || keyBytes(entry.key) < 32)) throw new Error("RT_POSTGRES_IDENTITY_KEYS_INVALID");
  if (options.operationTimeoutMs !== undefined && (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs <= 0)) throw new Error("RT_OPERATION_TIMEOUT_INVALID");
  const schema = postgresStorageNames(options.schema).schema;
  const pool = options.pool ?? new Pool({ connectionTimeoutMillis: 1_000, ...options.poolConfig, connectionString: options.connectionString });
  const identityKeys = options.identityKeys.map((entry) => ({ version: entry.version, key: typeof entry.key === "string" ? entry.key : new Uint8Array(entry.key) }));
  return Object.freeze({
    kind: "postgres",
    pool,
    ownsPool: options.pool === undefined,
    schema,
    get identityKeys() { return Object.freeze(identityKeys.map((entry) => Object.freeze({ version: entry.version, key: typeof entry.key === "string" ? entry.key : new Uint8Array(entry.key) }))); },
    ...(options.commandResultRetentionMs === undefined ? {} : { commandResultRetentionMs: options.commandResultRetentionMs }),
    ...(options.idempotencyRetentionMs === undefined ? {} : { idempotencyRetentionMs: options.idempotencyRetentionMs }),
    ...(options.replayRetentionMs === undefined ? {} : { replayRetentionMs: options.replayRetentionMs }),
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs })
  });
}

/** Deployment-time DDL. Invoke with a migration role before starting runtime processes. */
export async function migratePostgres<TContract extends AnyRealtimeContract>(contract: TContract, profile: PostgresRealtimeProfile): Promise<void> {
  const store = new PostgresEventLog(profile.pool, undefined, {}, { schema: profile.schema });
  await store.migrate(contract.identity);
}

export interface ServerOperationContext {
  tenantId: string;
  principalNamespaceId: string;
  permissions: ReadonlySet<string>;
  traceId?: string;
  sessionId?: string;
}

export interface RealtimePostgresDatabase {
  query<TResult extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<TResult>>;
}

export interface SnapshotContext<TInput> extends ServerOperationContext {
  db: RealtimePostgresDatabase;
  stream: string;
  input: TInput;
  includedSequence: number;
}

export interface CommandMutationContext<TInput> extends ServerOperationContext {
  db: RealtimePostgresDatabase;
  commandId: string;
  input: TInput;
  stream: string;
  sequence: number;
  eventId: string;
}

type StreamEventName<TContract extends AnyRealtimeContract, TName extends StreamName<TContract>> = StreamEventFor<TContract, TName>["type"];
type StreamEventData<TContract extends AnyRealtimeContract, TName extends StreamName<TContract>, TEvent extends StreamEventName<TContract, TName>> = Extract<StreamEventFor<TContract, TName>, { type: TEvent }>["data"];

export type ContractPublish<TContract extends AnyRealtimeContract> = {
  [TStream in StreamName<TContract>]: {
    [TEvent in StreamEventName<TContract, TStream>]: {
      stream: TStream;
      input: StreamInput<TContract, TStream>;
      event: TEvent;
      data: StreamEventData<TContract, TStream, TEvent>;
    }
  }[StreamEventName<TContract, TStream>]
}[StreamName<TContract>];

export type StreamHandlers<TContract extends AnyRealtimeContract> = {
  [TName in StreamName<TContract>]: {
    authorize(context: ServerOperationContext, input: StreamInput<TContract, TName>): boolean | Promise<boolean>;
    snapshot(context: SnapshotContext<StreamInput<TContract, TName>>): StreamState<TContract, TName> | Promise<StreamState<TContract, TName>>;
  }
};

export type CommandHandlers<TContract extends AnyRealtimeContract> = {
  [TName in CommandName<TContract>]: {
    authorize(context: ServerOperationContext, input: CommandInput<TContract, TName>): boolean | Promise<boolean>;
    prepare(context: ServerOperationContext, input: CommandInput<TContract, TName>): {
      publish: ContractPublish<TContract>;
      mutate(context: CommandMutationContext<CommandInput<TContract, TName>>): CommandResult<TContract, TName> | Promise<CommandResult<TContract, TName>>;
    } | Promise<{
      publish: ContractPublish<TContract>;
      mutate(context: CommandMutationContext<CommandInput<TContract, TName>>): CommandResult<TContract, TName> | Promise<CommandResult<TContract, TName>>;
    }>;
  }
};

export interface RealtimeServerOptions<TContract extends AnyRealtimeContract> {
  profile: PostgresRealtimeProfile;
  runtimeId: string;
  runtimeBootId?: string;
  host?: string;
  port?: number;
  originPolicy: WebSocketOriginPolicy;
  heartbeat?: { intervalMs: number; timeoutMs: number };
  capacity?: {
    maxConnections?: number;
    maxSubscriptionsPerConnection?: number;
    maxInboundQueueMessages?: number;
    maxInboundQueueBytes?: number;
    maxInboundMessagesPerSecond?: number;
    maxApplicationHooks?: number;
    maxOutboundBufferedBytes?: number;
    drainTimeoutMs?: number;
  };
  authenticate(auth: JsonValue): AuthenticatedPrincipal | Promise<AuthenticatedPrincipal>;
  streams: StreamHandlers<TContract>;
  commands: CommandHandlers<TContract>;
  diagnostics?: { defaultDoctorQuery?: DoctorQueryDefinition };
}

export interface RealtimeServer<TContract extends AnyRealtimeContract> {
  readonly contract: TContract;
  readonly webSocketUrl: string;
  readonly httpUrl: string;
  readonly ready: boolean;
  start(): Promise<void>;
  gracefulDrain(reason?: string): void;
  evidenceBundle(tenantId: string, doctorQuery?: DoctorQueryDefinition): EvidenceBundleV1;
  dispose(): Promise<void>;
}

export function createRealtimeServer<TContract extends AnyRealtimeContract>(contract: TContract, options: RealtimeServerOptions<TContract>): RealtimeServer<TContract> {
  const runtime = contractRuntime(contract);
  assertHandlerMap("streams", Object.keys(contract.manifest.streams), options.streams, ["authorize", "snapshot"]);
  assertHandlerMap("commands", Object.keys(contract.manifest.commands), options.commands, ["authorize", "prepare"]);
  const streamHandlers = options.streams as Record<string, { authorize(context: ServerOperationContext, input: JsonValue): boolean | Promise<boolean>; snapshot(context: SnapshotContext<JsonValue>): JsonValue | Promise<JsonValue> }>;
  const commandHandlers = options.commands as Record<string, { authorize(context: ServerOperationContext, input: JsonValue): boolean | Promise<boolean>; prepare(context: ServerOperationContext, input: JsonValue): { publish: { stream: string; input: JsonValue; event: string; data: JsonValue }; mutate(context: CommandMutationContext<JsonValue>): JsonValue | Promise<JsonValue> } | Promise<{ publish: { stream: string; input: JsonValue; event: string; data: JsonValue }; mutate(context: CommandMutationContext<JsonValue>): JsonValue | Promise<JsonValue> }> }>;

  const resolveStream = (stream: string, input: unknown) => {
    const matches = [];
    for (const [name, member] of runtime.streams) {
      try {
        const validated = contract.validateStreamInput(name, input) as JsonValue;
        if (member.definition.key(validated) === stream) matches.push({ name, input: validated, member, handler: streamHandlers[name]! });
      } catch { /* authorization and validation failures share the generic wire response */ }
    }
    if (matches.length > 1) throw new RealtimeContractError("RT_CONTRACT_INVALID", "streams", [`RT_STREAM_KEY_COLLISION:${stream}:${matches.map((match) => match.name).join(",")}`]);
    return matches[0];
  };

  const applicationContext = (context: PostgresGatewayApplicationContext): ServerOperationContext => ({ ...context });
  const profile = options.profile;
  const gateway = new PostgresGatewayServer({
    pool: profile.pool,
    runtimeId: options.runtimeId,
    ...(options.runtimeBootId ? { runtimeBootId: options.runtimeBootId } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.port === undefined ? {} : { port: options.port }),
    originPolicy: options.originPolicy,
    ...(options.heartbeat ? { heartbeat: options.heartbeat } : {}),
    ...(options.capacity?.maxConnections === undefined ? {} : { maxClients: options.capacity.maxConnections }),
    ...(options.capacity?.maxSubscriptionsPerConnection === undefined ? {} : { maxSubscriptionsPerClient: options.capacity.maxSubscriptionsPerConnection }),
    ...(options.capacity?.maxInboundQueueMessages === undefined ? {} : { maxInboundQueueMessages: options.capacity.maxInboundQueueMessages }),
    ...(options.capacity?.maxInboundQueueBytes === undefined ? {} : { maxInboundQueueBytes: options.capacity.maxInboundQueueBytes }),
    ...(options.capacity?.maxInboundMessagesPerSecond === undefined ? {} : { maxInboundMessagesPerSecond: options.capacity.maxInboundMessagesPerSecond }),
    ...(options.capacity?.maxApplicationHooks === undefined ? {} : { maxApplicationHooks: options.capacity.maxApplicationHooks }),
    ...(options.capacity?.maxOutboundBufferedBytes === undefined ? {} : { maxOutboundBufferedBytes: options.capacity.maxOutboundBufferedBytes }),
    ...(options.capacity?.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.capacity.drainTimeoutMs }),
    contract: contract.identity,
    storageSchema: profile.schema,
    identityKeys: [...profile.identityKeys] as IdentityKey[],
    ...(profile.commandResultRetentionMs === undefined ? {} : { commandResultRetentionMs: profile.commandResultRetentionMs }),
    ...(profile.idempotencyRetentionMs === undefined ? {} : { idempotencyRetentionMs: profile.idempotencyRetentionMs }),
    ...(profile.replayRetentionMs === undefined ? {} : { replayRetentionMs: profile.replayRetentionMs }),
    ...(profile.operationTimeoutMs === undefined ? {} : { transactionOptions: { operationTimeoutMs: profile.operationTimeoutMs } }),
    enableTestControlPlane: false,
    authenticate: async (auth) => validateAuthenticatedPrincipal(await options.authenticate(auth)),
    application: {
      authorizeStream: async (context, message) => {
        const resolved = resolveStream(message.stream, message.input);
        return resolved ? (await resolved.handler.authorize(applicationContext(context), resolved.input)) === true : false;
      },
      snapshot: {
        schema: (_context, message) => {
          const resolved = resolveStream(message.stream, message.input);
          if (!resolved) return "unknownSnapshot@1";
          return contract.manifest.streams[resolved.name]!.snapshotSchema;
        },
        read: async (database, context) => {
          const resolved = resolveStream(context.stream, context.input);
          if (!resolved) throw new Error("RT_CONTRACT_STREAM_UNKNOWN");
          const state = await resolved.handler.snapshot({ tenantId: context.tenantId, principalNamespaceId: context.principalNamespaceId, permissions: context.permissions, ...(context.traceId ? { traceId: context.traceId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), db: database, stream: context.stream, input: resolved.input, includedSequence: context.includedSequence });
          return contract.validateStreamSnapshot(resolved.name, state) as JsonValue;
        }
      },
      authorizeCommand: async (context, message) => {
        const handler = commandHandlers[message.type];
        if (!handler || contract.manifest.commands[message.type]?.schema !== message.schema) return false;
        try { return (await handler.authorize(applicationContext(context), contract.validateCommandInput(message.type, message.input) as JsonValue)) === true; } catch { return false; }
      },
      executeCommand: async (context, message) => {
        const handler = commandHandlers[message.type];
        const commandManifest = contract.manifest.commands[message.type];
        if (!handler || !commandManifest || commandManifest.schema !== message.schema) return null;
        const input = contract.validateCommandInput(message.type, message.input) as JsonValue;
        const prepared: unknown = await handler.prepare(applicationContext(context), input);
        if (!isRecord(prepared) || !isRecord(prepared.publish) || typeof prepared.mutate !== "function" || typeof prepared.publish.stream !== "string" || typeof prepared.publish.event !== "string" || !("input" in prepared.publish) || !("data" in prepared.publish)) throw new RealtimeContractError("RT_CONTRACT_INVALID", `command:${message.type}:prepare`, ["expected publish {stream,input,event,data} and mutate function"]);
        const mutate = prepared.mutate as (context: CommandMutationContext<JsonValue>) => JsonValue | Promise<JsonValue>;
        const streamMember = runtime.streams.get(prepared.publish.stream);
        if (!streamMember) throw new RealtimeContractError("RT_CONTRACT_STREAM_UNKNOWN", prepared.publish.stream);
        const publishInput = prepared.publish.input as JsonValue;
        const resolvedStream = resolveStream(streamMember.definition.key(publishInput), publishInput);
        if (!resolvedStream || resolvedStream.name !== prepared.publish.stream) throw new RealtimeContractError("RT_CONTRACT_STREAM_INPUT_INVALID", prepared.publish.stream);
        const validatedEvent = validatePreparedEvent(contract, prepared.publish.stream, prepared.publish.event, prepared.publish.data);
        return {
          stream: resolvedStream.member.definition.key(resolvedStream.input),
          eventType: validatedEvent.type,
          eventSchema: validatedEvent.schema,
          eventData: validatedEvent.data,
          resultSchema: commandManifest.resultSchema,
          mutate: async (database, mutation) => {
            const result = await mutate({ ...applicationContext(context), db: database, commandId: mutation.commandId, input, stream: mutation.stream, sequence: mutation.sequence, eventId: mutation.eventId });
            return contract.validateCommandResult(message.type, result) as JsonValue;
          }
        };
      },
      validateOutboundEvent: (_context, event, subscription) => {
        const resolved = resolveStream(subscription.stream, subscription.input);
        if (!resolved) return false;
        try { contract.validateStreamEvent(resolved.name, { type: event.type, schema: event.schema, data: event.data, sequence: event.sequence }); return true; } catch { return false; }
      },
      validateCommandResult: (_context, result) => {
        const name = Object.keys(contract.manifest.commands).find((candidate) => contract.manifest.commands[candidate]!.resultSchema === result.schema);
        if (!name) return false;
        try { contract.validateCommandResult(name, result.result); return true; } catch { return false; }
      }
    }
  });

  let disposed = false;
  return {
    contract,
    get webSocketUrl() { return gateway.webSocketUrl; },
    get httpUrl() { return gateway.httpUrl; },
    get ready() { return gateway.ready; },
    start: () => gateway.start(),
    gracefulDrain: (reason) => gateway.gracefulDrain(reason),
    evidenceBundle: (tenantId, doctorQuery) => {
      const serverStats = gateway.recorder.stats();
      const databaseStats = gateway.store.recorder.stats();
      const resolvedDoctorQuery = doctorQuery ?? options.diagnostics?.defaultDoctorQuery;
      const tenantRecords = selectTenantEvidenceRecords(
        [...gateway.recorder.records(), ...gateway.store.recorder.records()] as EvidenceBundleV1["records"][number]["record"][],
        tenantId
      );
      return {
        schemaVersion: "1.0",
        tenantId,
        payloadPolicy: "redacted",
        // Each exported bundle is its own privacy domain. Reusing a server- or
        // tenant-stable key would make identifiers linkable across incidents.
        pseudonymizationKey: `${crypto.randomUUID()}${crypto.randomUUID()}`,
        records: tenantRecords.map((record) => ({ tenantId, record })),
        resources: [],
        resourceCapture: "unavailable",
        loss: { droppedRecords: serverStats.droppedRecords + databaseStats.droppedRecords, evictedRecords: serverStats.evictedRecords + databaseStats.evictedRecords },
        expectedProducerInstances: [
          { producerRole: "server", runtimeId: gateway.recorder.runtimeId, runtimeBootId: gateway.recorder.runtimeBootId },
          { producerRole: "database", runtimeId: gateway.store.recorder.runtimeId, runtimeBootId: gateway.store.recorder.runtimeBootId }
        ],
        ...(resolvedDoctorQuery ? { defaultDoctorQuery: resolvedDoctorQuery } : {})
      };
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await gateway.dispose();
      if (profile.ownsPool) await profile.pool.end();
    }
  };
}

function validateAuthenticatedPrincipal(value: AuthenticatedPrincipal): AuthenticatedPrincipal {
  if (!value || typeof value !== "object" || !nonEmpty(value.tenantId) || !nonEmpty(value.authenticationRealm) || !nonEmpty(value.issuer) || !nonEmpty(value.subject) || !Array.isArray(value.permissions) || value.permissions.some((permission) => !nonEmpty(permission))) throw new Error("RT_AUTH_PRINCIPAL_INVALID");
  return { ...value, permissions: [...new Set(value.permissions)] };
}

function keyBytes(value: string | Uint8Array): number { return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function assertHandlerMap(kind: string, expected: string[], value: unknown, methods: string[]): void {
  if (!isRecord(value) || expected.length !== Object.keys(value).length || expected.some((name) => !Object.hasOwn(value, name)) || Object.values(value).some((handler) => !isRecord(handler) || methods.some((method) => typeof handler[method] !== "function"))) throw new RealtimeContractError("RT_CONTRACT_INVALID", `server.${kind}`, [`expected exactly ${expected.join(",") || "no handlers"} with ${methods.join("/")}`]);
}
