import { PostgresGatewayServer, type PostgresGatewayApplicationContext } from "@realtime/server-node";
import { PostgresEventLog, postgresStorageNames, type IdentityKey } from "@realtime/store-postgres";
import {
  BoundedEvidenceExporter,
  redactEvidenceRecord,
  redactLocalEvidenceBundle,
  type EvidenceRecord,
  type EvidenceRoutingContext,
  type EvidenceSink as InternalEvidenceSink
} from "@realtime/diagnostics";
import { Pool, type PoolConfig } from "pg";
import {
  contractRuntime,
  encodeContractStreamSnapshot,
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

/**
 * Structural boundary for an application-supplied node-postgres pool. The
 * package does not export node-postgres declarations into browser consumers,
 * and command callbacks never receive this raw object.
 */
export interface RealtimePostgresPool {
  connect(...arguments_: any[]): any;
  query(...arguments_: any[]): any;
  end(...arguments_: any[]): any;
}

export interface RealtimePostgresPoolConfig {
  readonly [option: string]: unknown;
}

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
  pool?: RealtimePostgresPool;
  poolConfig?: RealtimePostgresPoolConfig;
  identityKeys: readonly PrincipalIdentityKey[];
  commandResultRetentionMs?: number;
  idempotencyRetentionMs?: number;
  replayRetentionMs?: number;
  operationTimeoutMs?: number;
  schema?: string;
}

export interface PostgresRealtimeProfile {
  readonly kind: "postgres";
  readonly pool: RealtimePostgresPool;
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
  const pool = options.pool ?? new Pool({ connectionTimeoutMillis: 1_000, ...options.poolConfig, connectionString: options.connectionString } as PoolConfig);
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
  const store = new PostgresEventLog(asNodePostgresPool(profile.pool), undefined, {}, { schema: profile.schema });
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
  query<TResult extends RealtimePostgresQueryResultRow = RealtimePostgresQueryResultRow>(text: string, values?: readonly unknown[]): Promise<RealtimePostgresQueryResult<TResult>>;
}

export interface RealtimePostgresQueryResultRow {
  readonly [column: string]: unknown;
}

export interface RealtimePostgresField {
  readonly name: string;
  readonly tableID: number;
  readonly columnID: number;
  readonly dataTypeID: number;
  readonly dataTypeSize: number;
  readonly dataTypeModifier: number;
  readonly format: string;
}

export interface RealtimePostgresQueryResult<TResult extends RealtimePostgresQueryResultRow = RealtimePostgresQueryResultRow> {
  readonly command: string;
  readonly rowCount: number | null;
  readonly oid: number;
  readonly fields: readonly RealtimePostgresField[];
  readonly rows: TResult[];
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

export type ContractStreamTarget<TContract extends AnyRealtimeContract> = {
  [TStream in StreamName<TContract>]: {
    stream: TStream;
    input: StreamInput<TContract, TStream>;
  }
}[StreamName<TContract>];

export interface CommandEventReference {
  readonly stream: string;
  readonly sequence: number;
  readonly eventId: string;
}

export interface CommandExecutionContext<TContract extends AnyRealtimeContract, TInput> extends ServerOperationContext {
  readonly db: RealtimePostgresDatabase;
  readonly commandId: string;
  readonly input: TInput;
  readonly targets: readonly ContractStreamTarget<TContract>[];
  emit(event: ContractPublish<TContract>): CommandEventReference;
}

export type StreamHandlers<TContract extends AnyRealtimeContract> = {
  [TName in StreamName<TContract>]: {
    authorize(context: ServerOperationContext, input: StreamInput<TContract, TName>): boolean | Promise<boolean>;
    snapshot(context: SnapshotContext<StreamInput<TContract, TName>>): StreamState<TContract, TName> | Promise<StreamState<TContract, TName>>;
  }
};

type LegacyCommandHandler<TContract extends AnyRealtimeContract, TName extends CommandName<TContract>> = {
  authorize(context: ServerOperationContext, input: CommandInput<TContract, TName>): boolean | Promise<boolean>;
  prepare(context: ServerOperationContext, input: CommandInput<TContract, TName>): {
    publish: ContractPublish<TContract>;
    mutate(context: CommandMutationContext<CommandInput<TContract, TName>>): CommandResult<TContract, TName> | Promise<CommandResult<TContract, TName>>;
  } | Promise<{
    publish: ContractPublish<TContract>;
    mutate(context: CommandMutationContext<CommandInput<TContract, TName>>): CommandResult<TContract, TName> | Promise<CommandResult<TContract, TName>>;
  }>;
  targets?: never;
  execute?: never;
};

type TransactionCommandHandler<TContract extends AnyRealtimeContract, TName extends CommandName<TContract>> = {
  authorize(context: ServerOperationContext, input: CommandInput<TContract, TName>): boolean | Promise<boolean>;
  targets(input: CommandInput<TContract, TName>, context: ServerOperationContext): readonly ContractStreamTarget<TContract>[] | Promise<readonly ContractStreamTarget<TContract>[]>;
  execute(context: ServerOperationContext, input: CommandInput<TContract, TName>, transaction: CommandExecutionContext<TContract, CommandInput<TContract, TName>>): CommandResult<TContract, TName> | Promise<CommandResult<TContract, TName>>;
  prepare?: never;
};

export type CommandHandlers<TContract extends AnyRealtimeContract> = {
  [TName in CommandName<TContract>]:
    | LegacyCommandHandler<TContract, TName>
    | TransactionCommandHandler<TContract, TName>;
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
  diagnostics?: {
    defaultDoctorQuery?: DoctorQueryDefinition;
    evidence?: RealtimeServerEvidenceOptions;
  };
}

export interface RealtimeServerEvidenceSink {
  readonly schemaVersion: "1.0";
  readonly capabilities: {
    readonly authoritative: boolean;
    readonly durable: boolean;
    readonly sampled: boolean;
    readonly multiProducer: boolean;
  };
  record(evidence: {
    readonly schemaVersion: "1.0";
    readonly tenantId: string;
    readonly payloadPolicy: "redacted";
    readonly record: import("./diagnostic-types.js").SourceDiagnosticEvidenceRecord;
  }): Promise<void>;
  registerExpectedProducers?(instances: readonly import("./diagnostic-types.js").DiagnosticProducerInstance[]): void;
  finalizeExpectedProducers?(): void;
  declareExpectedProducers?(instances: readonly import("./diagnostic-types.js").DiagnosticProducerInstance[]): void;
  closeProducer?(checkpoint: import("./diagnostic-types.js").DiagnosticProducerInstance & { readonly highWaterMark: number; readonly closed: true }): void;
  recordExportFailure?(count?: number): void;
}

export interface RealtimeServerEvidenceOptions {
  readonly sink: RealtimeServerEvidenceSink;
  /**
   * Shared mode registers this server's gateway and database producers
   * additively. The topology owner must finalize the sink after every server
   * is constructed and before any server is disposed.
   */
  readonly topology?: "exclusive" | "shared";
  /** Secret key material used only to pseudonymize evidence before export. */
  readonly pseudonymizationKey: string;
  /** Tenant used for process-level records that are not attributable to an authenticated tenant. */
  readonly systemTenantId: string;
  readonly maxPendingRecords?: number;
}

export interface RealtimeServerEvidenceExportSnapshot {
  readonly pendingRecords: number;
  readonly acceptedRecords: number;
  readonly exportFailedRecords: number;
  readonly closed: boolean;
}

export interface RealtimeServer<TContract extends AnyRealtimeContract> {
  readonly contract: TContract;
  readonly webSocketUrl: string;
  readonly httpUrl: string;
  readonly ready: boolean;
  start(): Promise<void>;
  gracefulDrain(reason?: string): void;
  evidenceBundle(tenantId: string, doctorQuery?: DoctorQueryDefinition): EvidenceBundleV1;
  flushEvidence(): Promise<void>;
  evidenceSnapshot(): RealtimeServerEvidenceExportSnapshot;
  dispose(): Promise<void>;
}

export function createRealtimeServer<TContract extends AnyRealtimeContract>(contract: TContract, options: RealtimeServerOptions<TContract>): RealtimeServer<TContract> {
  const runtime = contractRuntime(contract);
  assertHandlerMap("streams", Object.keys(contract.manifest.streams), options.streams, ["authorize", "snapshot"]);
  assertCommandHandlerMap(Object.keys(contract.manifest.commands), options.commands);
  const streamHandlers = options.streams as Record<string, { authorize(context: ServerOperationContext, input: JsonValue): boolean | Promise<boolean>; snapshot(context: SnapshotContext<JsonValue>): JsonValue | Promise<JsonValue> }>;
  const commandHandlers = options.commands as Record<string,
    | { authorize(context: ServerOperationContext, input: JsonValue): boolean | Promise<boolean>; prepare(context: ServerOperationContext, input: JsonValue): { publish: { stream: string; input: JsonValue; event: string; data: JsonValue }; mutate(context: CommandMutationContext<JsonValue>): JsonValue | Promise<JsonValue> } | Promise<{ publish: { stream: string; input: JsonValue; event: string; data: JsonValue }; mutate(context: CommandMutationContext<JsonValue>): JsonValue | Promise<JsonValue> }> }
    | { authorize(context: ServerOperationContext, input: JsonValue): boolean | Promise<boolean>; targets(input: JsonValue, context: ServerOperationContext): readonly { stream: string; input: JsonValue }[] | Promise<readonly { stream: string; input: JsonValue }[]>; execute(context: ServerOperationContext, input: JsonValue, transaction: CommandExecutionContext<TContract, JsonValue>): JsonValue | Promise<JsonValue> }>;

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
  const resolveContractTarget = (target: { stream: string; input: unknown }) => {
    const member = runtime.streams.get(target.stream);
    if (!member) throw new RealtimeContractError("RT_CONTRACT_STREAM_UNKNOWN", target.stream);
    const input = contract.validateStreamInput(target.stream, target.input) as JsonValue;
    const stream = member.definition.key(input);
    if (!nonEmpty(stream)) throw new RealtimeContractError("RT_CONTRACT_STREAM_INPUT_INVALID", target.stream, ["stream key must be a non-empty bounded string"]);
    return { member: target.stream, input, stream };
  };

  const applicationContext = (context: PostgresGatewayApplicationContext): ServerOperationContext => ({ ...context });
  const profile = options.profile;
  if (options.diagnostics?.evidence && !nonEmpty(options.diagnostics.evidence.systemTenantId)) {
    throw new RealtimeContractError("RT_CONTRACT_INVALID", "server.diagnostics.evidence.systemTenantId", ["expected a non-empty bounded tenant identifier"]);
  }
  let evidenceExporter: BoundedEvidenceExporter | undefined;
  const exportEvidence = (record: EvidenceRecord, routing: EvidenceRoutingContext): void => {
    evidenceExporter?.record(record, routing);
  };
  const gateway = new PostgresGatewayServer({
    pool: asNodePostgresPool(profile.pool),
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
    ...(options.diagnostics?.evidence ? { onEvidenceRecord: exportEvidence } : {}),
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
          return encodeContractStreamSnapshot(contract, resolved.name, state, context.includedSequence);
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
        if ("targets" in handler && typeof handler.targets === "function" && typeof handler.execute === "function") {
          const operationContext = applicationContext(context);
          const declared: unknown = await handler.targets(input, operationContext);
          if (!Array.isArray(declared) || declared.length > 100) throw new RealtimeContractError("RT_CONTRACT_INVALID", `command:${message.type}:targets`, ["expected an array with at most 100 stream targets"]);
          const targets = declared.map((target) => {
            if (!isRecord(target) || typeof target.stream !== "string" || !("input" in target)) throw new RealtimeContractError("RT_CONTRACT_INVALID", `command:${message.type}:targets`, ["expected {stream,input}"]);
            return resolveContractTarget({ stream: target.stream, input: target.input });
          });
          if (new Set(targets.map((target) => target.stream)).size !== targets.length) throw new RealtimeContractError("RT_CONTRACT_INVALID", `command:${message.type}:targets`, ["duplicate physical stream target"]);
          const publicTargets = Object.freeze(targets.map((target) => Object.freeze({ stream: target.member, input: target.input }))) as readonly ContractStreamTarget<TContract>[];
          return {
            targets: targets.map((target) => target.stream),
            resultSchema: commandManifest.resultSchema,
            execute: async (database, transaction) => {
              const result = await handler.execute(operationContext, input, {
                ...operationContext,
                db: database,
                commandId: transaction.commandId,
                input,
                targets: publicTargets,
                emit: (publish) => {
                  const resolved = resolveContractTarget({ stream: publish.stream, input: publish.input });
                  const validated = validatePreparedEvent(contract, publish.stream, publish.event, publish.data);
                  const event = transaction.emit(resolved.stream, validated.type, validated.schema, validated.data);
                  return { stream: event.stream, sequence: event.sequence, eventId: event.eventId };
                }
              });
              return contract.validateCommandResult(message.type, result) as JsonValue;
            }
          };
        }
        if (!("prepare" in handler) || typeof handler.prepare !== "function") throw new RealtimeContractError("RT_CONTRACT_INVALID", `command:${message.type}`, ["expected prepare or targets/execute handler"]);
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
  const configuredEvidence = options.diagnostics?.evidence;
  if (configuredEvidence) {
    evidenceExporter = new BoundedEvidenceExporter({
      sink: configuredEvidence.sink as unknown as InternalEvidenceSink,
      ...(configuredEvidence.topology === undefined ? {} : { topology: configuredEvidence.topology }),
      pseudonymizationKey: configuredEvidence.pseudonymizationKey,
      tenantId: (_record, routing) => typeof routing.tenantId === "string" && nonEmpty(routing.tenantId)
        ? routing.tenantId
        : configuredEvidence.systemTenantId,
      expectedProducers: [
        {
          producerRole: gateway.recorder.producerRole,
          runtimeId: gateway.recorder.runtimeId,
          runtimeBootId: gateway.recorder.runtimeBootId
        },
        {
          producerRole: gateway.store.recorder.producerRole,
          runtimeId: gateway.store.recorder.runtimeId,
          runtimeBootId: gateway.store.recorder.runtimeBootId
        }
      ],
      redactRecord: redactEvidenceRecord,
      ...(configuredEvidence.maxPendingRecords === undefined ? {} : { maxPendingRecords: configuredEvidence.maxPendingRecords })
    });
  }

  let disposePromise: Promise<void> | undefined;
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
      const sourceBundle: EvidenceBundleV1 = {
        schemaVersion: "1.0",
        tenantId,
        payloadPolicy: "redacted",
        identifierPolicy: "source",
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
      return redactLocalEvidenceBundle(sourceBundle as Parameters<typeof redactLocalEvidenceBundle>[0]) as EvidenceBundleV1;
    },
    flushEvidence: () => evidenceExporter?.flush() ?? Promise.resolve(),
    evidenceSnapshot: () => evidenceExporter?.snapshot() ?? {
      pendingRecords: 0,
      acceptedRecords: 0,
      exportFailedRecords: 0,
      closed: false
    },
    dispose: () => {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        let failure: unknown;
        try {
          await gateway.dispose();
        } catch (error) {
          failure = error;
        }
        if (evidenceExporter) {
          try {
            await evidenceExporter.close([
              {
                producerRole: gateway.recorder.producerRole,
                runtimeId: gateway.recorder.runtimeId,
                runtimeBootId: gateway.recorder.runtimeBootId,
                highWaterMark: gateway.recorder.stats().highWaterMark,
                closed: true
              },
              {
                producerRole: gateway.store.recorder.producerRole,
                runtimeId: gateway.store.recorder.runtimeId,
                runtimeBootId: gateway.store.recorder.runtimeBootId,
                highWaterMark: gateway.store.recorder.stats().highWaterMark,
                closed: true
              }
            ]);
          } catch (error) {
            failure ??= error;
          }
        }
        if (profile.ownsPool) {
          try {
            await profile.pool.end();
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
      })();
      return disposePromise;
    }
  };
}

function validateAuthenticatedPrincipal(value: AuthenticatedPrincipal): AuthenticatedPrincipal {
  if (!value || typeof value !== "object" || !nonEmpty(value.tenantId) || !nonEmpty(value.authenticationRealm) || !nonEmpty(value.issuer) || !nonEmpty(value.subject) || !Array.isArray(value.permissions) || value.permissions.some((permission) => !nonEmpty(permission))) throw new Error("RT_AUTH_PRINCIPAL_INVALID");
  return { ...value, permissions: [...new Set(value.permissions)] };
}

function asNodePostgresPool(pool: RealtimePostgresPool): Pool {
  return pool as Pool;
}

function keyBytes(value: string | Uint8Array): number { return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function assertHandlerMap(kind: string, expected: string[], value: unknown, methods: string[]): void {
  if (!isRecord(value) || expected.length !== Object.keys(value).length || expected.some((name) => !Object.hasOwn(value, name)) || Object.values(value).some((handler) => !isRecord(handler) || methods.some((method) => typeof handler[method] !== "function"))) throw new RealtimeContractError("RT_CONTRACT_INVALID", `server.${kind}`, [`expected exactly ${expected.join(",") || "no handlers"} with ${methods.join("/")}`]);
}
function assertCommandHandlerMap(expected: string[], value: unknown): void {
  if (!isRecord(value) || expected.length !== Object.keys(value).length || expected.some((name) => !Object.hasOwn(value, name))) throw new RealtimeContractError("RT_CONTRACT_INVALID", "server.commands", [`expected exactly ${expected.join(",") || "no handlers"}`]);
  for (const handler of Object.values(value)) {
    if (!isRecord(handler) || typeof handler.authorize !== "function") throw new RealtimeContractError("RT_CONTRACT_INVALID", "server.commands", ["each handler requires authorize"]);
    const legacy = typeof handler.prepare === "function" && handler.targets === undefined && handler.execute === undefined;
    const transaction = handler.prepare === undefined && typeof handler.targets === "function" && typeof handler.execute === "function";
    if (!legacy && !transaction) throw new RealtimeContractError("RT_CONTRACT_INVALID", "server.commands", ["expected either prepare or targets/execute"]);
  }
}
