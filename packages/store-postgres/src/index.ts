import { createHash, createHmac, randomUUID } from "node:crypto";
import { DatabaseError, type Notification, type Pool, type PoolClient } from "pg";
import type { ContractIdentity, JsonValue } from "@realtime/protocol";
import { FlightRecorder, type RecordInput } from "@realtime/diagnostics";
import { DEFAULT_POSTGRES_SCHEMA, POSTGRES_STORAGE_VERSION, frameworkMigrationSql, postgresStorageNames, quoteIdentifier, type PostgresStorageNames } from "./migrations.ts";
import { demoApplicationMigrationSql } from "./demo-migration.ts";
import { classifyCommitFailure, CommitAttemptError, TransactionOutcomeError, TransactionRolledBackError, TransactionStateMachine, type PostgresTransactionOptions, type TransactionContext, type TransactionResolution } from "./transaction.ts";

export * from "./transaction.ts";
export * from "./migrations.ts";

const guardedPoolClients = new WeakSet<PoolClient>();
const poolClientErrorSink = () => undefined;

export interface PostgresStoredEvent {
  tenantId: string;
  stream: string;
  sequence: number;
  cursor: string;
  eventId: string;
  type: string;
  schema: string;
  data: JsonValue;
  appendId?: string;
  commandPrincipalNamespaceId?: string;
  commandId?: string;
  occurredAt: string;
}

export interface PostgresNotification { outboxId: number }
export interface IdentityKey { version: number; key: string | Uint8Array }
export interface PrincipalIdentity {
  tenantId: string;
  authenticationRealm: string;
  issuer: string;
  subject: string;
  keys: IdentityKey[];
}

export interface CommandIntent {
  type: string;
  schema: string;
  input: JsonValue;
}

export interface AppendIntent {
  stream: string;
  eventType: string;
  schema: string;
  data: JsonValue;
  effectSchema: string;
  effect: JsonValue;
}

export interface CanonicalIntent {
  intentHashVersion: 1;
  intentHash: `sha256:${string}`;
  canonical: string;
}

export type CommandExecution =
  | { status: "completed"; duplicate: boolean; result: JsonValue; resultSchema: string; event: PostgresStoredEvent }
  | { status: "expired"; duplicate: true };

export type CommandStatus =
  | { state: "completed"; result: JsonValue; resultSchema: string; eventId: string; eventStream: string; eventSequence: number }
  | { state: "expired" }
  | { state: "unknown" };

export interface ExecuteCommandOptions {
  tenantId: string;
  principalNamespaceId: string;
  commandId: string;
  commandType: string;
  commandSchema: string;
  commandInput: JsonValue;
  stream: string;
  eventType: string;
  schema: string;
  data: JsonValue;
  resultSchema?: string;
  commandResultRetentionMs: number;
  idempotencyRetentionMs: number;
  mutate(client: PoolClient, sequence: number, eventId: string, operation: TransactionOperationLease): Promise<JsonValue>;
}

/** Transaction-owned absolute deadline shared with outward application ports. */
export interface TransactionOperationLease {
  readonly deadline: number;
  isActive(): boolean;
}

export interface AppendEventOptions {
  appendId: string;
  tenantId: string;
  stream: string;
  eventType: string;
  schema: string;
  data: JsonValue;
  /** Versioned, language-neutral description of every domain effect performed by mutate. */
  effectSchema: string;
  effect: JsonValue;
  mutate?(client: PoolClient, sequence: number, eventId: string): Promise<void>;
}

interface CommandDurableRow {
  result: JsonValue | null;
  result_available: boolean;
  result_schema: string;
  event_id: string;
  intent_hash_version: number;
  intent_hash: string;
  result_retained: boolean;
  idempotency_retained: boolean;
  outbox_present: boolean;
}

export interface AtomicSnapshotContext {
  tenantId: string;
  stream: string;
  includedSequence: number;
  operation: TransactionOperationLease;
}

export interface RoomSnapshotState extends Record<string, JsonValue> {
  messages: JsonValue[];
  sequence: number;
  windowStartSequence: number;
  truncated: boolean;
}

export interface AtomicSnapshot<TState extends JsonValue = RoomSnapshotState> {
  state: TState;
  cursor: string;
  cursorSequence: number;
  head: string;
  headSequence: number;
}

export type OutboxCrashPoint = "after_claim" | "after_notify" | "after_mark";

const INTENT_HASH_VERSION = 1 as const;
const APPEND_INTENT_HASH_VERSION = 1 as const;
const IDENTITY_TUPLE_VERSION = 1;
const MAX_SNAPSHOT_STATE_BYTES = 524_288;
const STORE_POSTGRES_EVIDENCE_COMPONENT = {
  component: "store-postgres",
  componentVersion: "0.3.0"
} as const;
export const TRANSACTION_ATTEMPT_RETENTION_MS = 300_000;
const FRAMEWORK_TABLES = ["realtime_schema_metadata", "realtime_transaction_attempts", "realtime_principal_namespaces", "realtime_principal_identity_aliases", "realtime_events", "realtime_commands", "realtime_outbox", "realtime_stream_retention"] as const;

const cursor = (tenantId: string, stream: string, sequence: number) =>
  Buffer.from(JSON.stringify({ v: 1, t: tenantId, s: stream, q: sequence })).toString("base64url");

const sequenceFromCursor = (tenantId: string, stream: string, value?: string | null) => {
  if (!value) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { v: number; t: string; s: string; q: number };
    return decoded.v === 1 && decoded.t === tenantId && decoded.s === stream && Number.isSafeInteger(decoded.q) && decoded.q >= 0 ? decoded.q : null;
  } catch {
    return null;
  }
};

/** JSON Canonicalization Scheme compatible serialization for the protocol JSON subset. */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") { assertUnicodeScalarSequence(value); return JSON.stringify(value); }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("RT_CANONICAL_JSON_NON_FINITE");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => { assertUnicodeScalarSequence(key); return `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`; }).join(",")}}`;
}

function assertUnicodeScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("RT_CANONICAL_JSON_INVALID_UNICODE");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("RT_CANONICAL_JSON_INVALID_UNICODE");
  }
}

export function canonicalCommandIntent(intent: CommandIntent): CanonicalIntent {
  const canonical = canonicalJson({ input: intent.input, schema: intent.schema, type: intent.type });
  return { intentHashVersion: INTENT_HASH_VERSION, intentHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`, canonical };
}

export function canonicalAppendIntent(intent: AppendIntent): CanonicalIntent {
  const canonical = canonicalJson({ data: intent.data, effect: intent.effect, effectSchema: intent.effectSchema, eventType: intent.eventType, schema: intent.schema, stream: intent.stream });
  return { intentHashVersion: APPEND_INTENT_HASH_VERSION, intentHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`, canonical };
}

const positiveRetention = (commandResultRetentionMs: number, idempotencyRetentionMs: number): void => {
  if (!Number.isSafeInteger(commandResultRetentionMs) || !Number.isSafeInteger(idempotencyRetentionMs) || commandResultRetentionMs <= 0 || commandResultRetentionMs > idempotencyRetentionMs) {
    throw new Error("RT_CAPABILITY_RETENTION_INVALID");
  }
};

function validateStorageContract(contract: ContractIdentity): void {
  if (!contract || typeof contract.contractId !== "string" || contract.contractId.length === 0 || contract.contractId.length > 256
    || typeof contract.manifestVersion !== "string" || contract.manifestVersion.length === 0 || contract.manifestVersion.length > 256
    || typeof contract.manifestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(contract.manifestDigest)) throw new Error("RT_POSTGRES_CONTRACT_BINDING_INVALID");
}

function sameStorageContract(row: { contract_id: string; manifest_version: string; manifest_digest: string }, contract: ContractIdentity): boolean {
  return row.contract_id === contract.contractId && row.manifest_version === contract.manifestVersion && row.manifest_digest === contract.manifestDigest;
}

export class PostgresEventLog {
  readonly recorder: FlightRecorder;
  readonly transactionOptions: Required<Pick<PostgresTransactionOptions, "reconciliationTimeoutMs" | "commitTimeoutMs" | "operationTimeoutMs" | "snapshotRetryLimit">> & Pick<PostgresTransactionOptions, "commit" | "rollback">;
  readonly storage: PostgresStorageNames;
  readonly #principalResolutionFlights = new Map<string, Promise<string>>();

  constructor(private readonly pool: Pool, recorder = new FlightRecorder({ runtimeId: "postgres-event-log", producerRole: "database" }), transactionOptions: PostgresTransactionOptions = {}, storage: { schema?: string } = {}) {
    this.recorder = recorder;
    this.storage = postgresStorageNames(storage.schema ?? DEFAULT_POSTGRES_SCHEMA);
    this.transactionOptions = { reconciliationTimeoutMs: transactionOptions.reconciliationTimeoutMs ?? 1_000, commitTimeoutMs: transactionOptions.commitTimeoutMs ?? 1_000, operationTimeoutMs: transactionOptions.operationTimeoutMs ?? 2_000, snapshotRetryLimit: transactionOptions.snapshotRetryLimit ?? 2, ...(transactionOptions.commit ? { commit: transactionOptions.commit } : {}), ...(transactionOptions.rollback ? { rollback: transactionOptions.rollback } : {}) };
    if (!Number.isSafeInteger(this.transactionOptions.reconciliationTimeoutMs) || this.transactionOptions.reconciliationTimeoutMs <= 0) throw new Error("RT_RECONCILIATION_TIMEOUT_INVALID");
    if (!Number.isSafeInteger(this.transactionOptions.commitTimeoutMs) || this.transactionOptions.commitTimeoutMs <= 0) throw new Error("RT_COMMIT_TIMEOUT_INVALID");
    if (!Number.isSafeInteger(this.transactionOptions.operationTimeoutMs) || this.transactionOptions.operationTimeoutMs <= 0) throw new Error("RT_OPERATION_TIMEOUT_INVALID");
    if (this.transactionOptions.reconciliationTimeoutMs + this.transactionOptions.commitTimeoutMs + this.transactionOptions.operationTimeoutMs + 1_000 >= TRANSACTION_ATTEMPT_RETENTION_MS) throw new Error("RT_TRANSACTION_TIMEOUTS_EXCEED_ATTEMPT_RETENTION");
    if (!Number.isSafeInteger(this.transactionOptions.snapshotRetryLimit) || this.transactionOptions.snapshotRetryLimit <= 0 || this.transactionOptions.snapshotRetryLimit > 10) throw new Error("RT_SNAPSHOT_RETRY_LIMIT_INVALID");
    const connectionTimeoutMs = (this.pool as Pool & { options?: { connectionTimeoutMillis?: number } }).options?.connectionTimeoutMillis;
    if (!Number.isSafeInteger(connectionTimeoutMs) || Number(connectionTimeoutMs) <= 0 || Number(connectionTimeoutMs) > this.transactionOptions.reconciliationTimeoutMs) throw new Error("RT_POOL_CONNECTION_TIMEOUT_UNBOUNDED");
  }

  async migrate(contract: ContractIdentity): Promise<void> {
    validateStorageContract(contract);
    const lockKey = `${this.storage.namespace}:schema-migration:v${POSTGRES_STORAGE_VERSION}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = transactionContext(this.storage.namespace, "schema_migration", { operationCorrelationId: operationCorrelation(this.storage.namespace, { operation: "schema_migration", lockKey }) });
      const transaction = new TransactionStateMachine();
      const client = await this.#connect();
      let released = false;
      let releaseError: unknown | undefined;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
        const existing = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [this.storage.schema]);
        if (existing.rowCount) {
          const metadata = await client.query<{ storage_version: number; storage_namespace: string; contract_id: string; manifest_version: string; manifest_digest: string }>(`SELECT storage_version, storage_namespace, contract_id, manifest_version, manifest_digest FROM ${this.storage.metadata} WHERE singleton = TRUE`);
          const row = metadata.rows[0];
          const requiredTables = new Set<string>(FRAMEWORK_TABLES);
          for (const { table_name } of existing.rows) requiredTables.delete(table_name);
          if (requiredTables.size !== 0 || !row || row.storage_version !== POSTGRES_STORAGE_VERSION || row.storage_namespace !== this.storage.namespace || !sameStorageContract(row, contract)) throw new Error("RT_POSTGRES_STORAGE_BINDING_MISMATCH");
        } else {
          await client.query(frameworkMigrationSql(this.storage));
          await client.query(`INSERT INTO ${this.storage.metadata} (storage_version, storage_namespace, contract_id, manifest_version, manifest_digest) VALUES ($1,$2,$3,$4,$5)`, [POSTGRES_STORAGE_VERSION, this.storage.namespace, contract.contractId, contract.manifestVersion, contract.manifestDigest]);
        }
        await this.#insertTransactionAttempt(client, context);
        await this.#commit(client, transaction, context);
        break;
      } catch (error) {
        const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        releaseError = await this.#rollbackCleanup(client, context, deadline);
        if (!(error instanceof CommitAttemptError)) {
          if (transaction.state === "pre_commit") this.#recordPreCommitRollback(transaction, context, error);
          throw new TransactionRolledBackError(context, error);
        }
        if (error.classification.state === "rolled_back") throw new TransactionRolledBackError(context, error.originalError);
        client.release(releaseError instanceof Error ? releaseError : true);
        released = true;
        const resolution = await this.#reconcileTransactionMarker(context, transaction, lockKey, deadline, true);
        if (resolution === "committed") break;
        if (attempt === 1) throw new Error("RT_SCHEMA_MIGRATION_RECONCILED_ROLLBACK");
      } finally {
        if (!released) client.release(releaseError ? (releaseError instanceof Error ? releaseError : true) : undefined);
      }
    }
    this.#record({ kind: "database.schema_ready", boundary: "database.schema_ready", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT });
  }

  async migrateDemoApplication(): Promise<void> {
    await this.pool.query(demoApplicationMigrationSql(this.storage));
  }

  async assertReady(contract: ContractIdentity): Promise<void> {
    validateStorageContract(contract);
    try {
      const metadata = await this.pool.query<{ storage_version: number; storage_namespace: string; contract_id: string; manifest_version: string; manifest_digest: string }>(`SELECT storage_version, storage_namespace, contract_id, manifest_version, manifest_digest FROM ${this.storage.metadata} WHERE singleton = TRUE`);
      const tables = await this.pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])", [this.storage.schema, FRAMEWORK_TABLES]);
      const row = metadata.rows[0];
      if (metadata.rowCount !== 1 || tables.rowCount !== FRAMEWORK_TABLES.length || !row || row.storage_version !== POSTGRES_STORAGE_VERSION || row.storage_namespace !== this.storage.namespace || !sameStorageContract(row, contract)) throw new Error("RT_POSTGRES_STORAGE_BINDING_MISMATCH");
    } catch (error) {
      if (error instanceof Error && error.message === "RT_POSTGRES_STORAGE_BINDING_MISMATCH") throw error;
      throw new Error("RT_POSTGRES_MIGRATION_REQUIRED", { cause: error });
    }
  }

  async health(): Promise<boolean> {
    try { await this.pool.query("SELECT 1"); return true; }
    catch { return false; }
  }

  async resolvePrincipalNamespace(identity: PrincipalIdentity): Promise<string> {
    if (!identity.tenantId || !identity.authenticationRealm || !identity.issuer || !identity.subject || identity.keys.length === 0) throw new Error("RT_AUTH_REQUIRED");
    const versions = new Set<number>();
    const tuple = canonicalJson({ authenticationRealm: identity.authenticationRealm, issuer: identity.issuer, subject: identity.subject, tenantId: identity.tenantId, version: IDENTITY_TUPLE_VERSION });
    const aliases = identity.keys.map(({ version, key }) => {
      if (!Number.isSafeInteger(version) || version <= 0 || versions.has(version)) throw new Error("RT_IDENTITY_KEY_VERSION_INVALID");
      versions.add(version);
      return { keyVersion: version, fingerprint: `hmac-sha256:${createHmac("sha256", key).update(tuple).digest("hex")}` };
    }).sort((left, right) => left.keyVersion - right.keyVersion);

    const identityLocks = aliases
      .map((alias) => this.#lockKey(`principal:${identity.tenantId}:${IDENTITY_TUPLE_VERSION}:${alias.keyVersion}:${alias.fingerprint}`))
      .sort();
    const flightKey = `principal-flight:${identity.tenantId}:${createHash("sha256").update(canonicalJson(aliases.map((alias) => ({ fingerprint: alias.fingerprint, keyVersion: alias.keyVersion })))).digest("hex")}`;
    const pending = this.#principalResolutionFlights.get(flightKey);
    if (pending) return pending;
    const resolution = (async () => {
    const existingNamespace = await this.#resolvedPrincipalNamespace(this.pool, identity.tenantId, aliases);
    if (existingNamespace) {
      const context = transactionContext(this.storage.namespace, "principal_namespace", { tenantId: identity.tenantId, operationCorrelationId: operationCorrelation(this.storage.namespace, { operation: "principal_namespace", tenantId: identity.tenantId, identityTupleVersion: IDENTITY_TUPLE_VERSION, aliases: aliases.map((alias) => ({ keyVersion: alias.keyVersion, fingerprint: alias.fingerprint })) }) });
      this.#recordPrincipalResolved(identity, aliases, existingNamespace, context, "durable_alias_lookup", false);
      return existingNamespace;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = transactionContext(this.storage.namespace, "principal_namespace", { tenantId: identity.tenantId, operationCorrelationId: operationCorrelation(this.storage.namespace, { operation: "principal_namespace", tenantId: identity.tenantId, identityTupleVersion: IDENTITY_TUPLE_VERSION, aliases: aliases.map((alias) => ({ keyVersion: alias.keyVersion, fingerprint: alias.fingerprint })) }) });
      const transaction = new TransactionStateMachine();
      const client = await this.#connect();
      const candidate = randomUUID();
      let selected: string | undefined;
      let released = false;
      let releaseError: unknown | undefined;
      try {
        await client.query("BEGIN");
        // Lock every requested alias in one global order. Overlapping keysets
        // such as [old,current] and [current] then serialize on their shared
        // alias without deadlocking or creating competing namespaces.
        for (const identityLock of identityLocks) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identityLock]);
        await this.#insertTransactionAttempt(client, context);
        for (const alias of aliases) {
          const existing = await client.query<{ principal_namespace_id: string }>(`SELECT principal_namespace_id FROM ${this.storage.principalIdentityAliases} WHERE tenant_id = $1 AND identity_tuple_version = $2 AND key_version = $3 AND identity_fingerprint = $4 FOR UPDATE`, [identity.tenantId, IDENTITY_TUPLE_VERSION, alias.keyVersion, alias.fingerprint]);
          if (existing.rowCount) {
            const value = existing.rows[0]!.principal_namespace_id;
            if (selected && selected !== value) throw new Error("RT_PRINCIPAL_ALIAS_CONFLICT");
            selected = value;
          }
        }
        if (!selected) {
          selected = candidate;
          await client.query(`INSERT INTO ${this.storage.principalNamespaces} (tenant_id, principal_namespace_id) VALUES ($1,$2)`, [identity.tenantId, selected]);
        }
        for (const alias of aliases) {
          await client.query(`INSERT INTO ${this.storage.principalIdentityAliases} (tenant_id, identity_tuple_version, key_version, identity_fingerprint, principal_namespace_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [identity.tenantId, IDENTITY_TUPLE_VERSION, alias.keyVersion, alias.fingerprint, selected]);
          const linked = await client.query<{ principal_namespace_id: string }>(`SELECT principal_namespace_id FROM ${this.storage.principalIdentityAliases} WHERE tenant_id = $1 AND identity_tuple_version = $2 AND key_version = $3 AND identity_fingerprint = $4`, [identity.tenantId, IDENTITY_TUPLE_VERSION, alias.keyVersion, alias.fingerprint]);
          if (!linked.rowCount || linked.rows[0]!.principal_namespace_id !== selected) throw new Error("RT_PRINCIPAL_ALIAS_CONFLICT");
        }
        await this.#commit(client, transaction, context);
        this.#recordPrincipalResolved(identity, aliases, selected, context, "commit_acknowledgement");
        return selected;
      } catch (error) {
        const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        const cleanupError = await this.#rollbackCleanup(client, context, deadline);
        releaseError = cleanupError;
        if (!(error instanceof CommitAttemptError)) {
          if (transaction.state === "pre_commit") this.#recordPreCommitRollback(transaction, context, error);
          throw new TransactionRolledBackError(context, error);
        }
        if (error.classification.state === "rolled_back") throw new TransactionRolledBackError(context, error.originalError);
        client.release(cleanupError instanceof Error ? cleanupError : true);
        released = true;
        const reconciled = await this.#withAdvisoryReconciliation<string>({ context, transaction, lockKeys: identityLocks, deadline, inspect: async (database) => {
          const linked = [];
          for (const alias of aliases) linked.push(await database.query<{ principal_namespace_id: string }>(`SELECT principal_namespace_id FROM ${this.storage.principalIdentityAliases} WHERE tenant_id = $1 AND identity_tuple_version = $2 AND key_version = $3 AND identity_fingerprint = $4`, [identity.tenantId, IDENTITY_TUPLE_VERSION, alias.keyVersion, alias.fingerprint]));
          const namespaces = new Set(linked.flatMap((result) => result.rows.map((row) => row.principal_namespace_id)));
          if (linked.every((result) => result.rowCount === 1) && namespaces.size === 1) return { resolution: "committed", value: [...namespaces][0]! };
          if (linked.some((result) => result.rowCount)) throw new Error("RT_PRINCIPAL_RECONCILIATION_INCONSISTENT");
          return { resolution: "rolled_back" };
        } });
        if (reconciled.resolution === "committed" && reconciled.value) {
          this.#recordPrincipalResolved(identity, aliases, reconciled.value, context, "durable_transaction_attempt_marker");
          return reconciled.value;
        }
        if (attempt === 0) continue;
        throw new Error("RT_PRINCIPAL_RECONCILED_ROLLBACK");
      } finally {
        if (!released) client.release(releaseError ? (releaseError instanceof Error ? releaseError : true) : undefined);
      }
    }
    throw new Error("RT_PRINCIPAL_RECONCILIATION_EXHAUSTED");
    })();
    this.#principalResolutionFlights.set(flightKey, resolution);
    try { return await resolution; }
    finally { if (this.#principalResolutionFlights.get(flightKey) === resolution) this.#principalResolutionFlights.delete(flightKey); }
  }

  async executeCommand(options: ExecuteCommandOptions): Promise<CommandExecution> {
    positiveRetention(options.commandResultRetentionMs, options.idempotencyRetentionMs);
    const intent = canonicalCommandIntent({ type: options.commandType, schema: options.commandSchema, input: options.commandInput });
    const commandLock = this.#lockKey(`command:${options.tenantId}:${options.principalNamespaceId}:${options.commandId}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const operationDeadline = Date.now() + this.transactionOptions.operationTimeoutMs;
      const context = transactionContext(this.storage.namespace, "command", { tenantId: options.tenantId, principalNamespaceId: options.principalNamespaceId, stream: options.stream, commandId: options.commandId });
      const transaction = new TransactionStateMachine();
      let client: PoolClient;
      try { client = await this.#connectBefore(operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT"); }
      catch (error) { this.#recordPreCommitRollback(transaction, context, error); throw new TransactionRolledBackError(context, error); }
      let released = false;
      let releaseError: unknown | undefined;
      try {
        await this.#beforeDeadline(client.query("BEGIN"), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        await this.#beforeDeadline(client.query("SELECT set_config('statement_timeout', $1, true)", [String(remainingMs(operationDeadline))]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        await this.#beforeDeadline(client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [commandLock]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        const existing = await this.#beforeDeadline(this.#commandRow(client, options), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        if (existing) {
          if (!existing.idempotency_retained) await this.#beforeDeadline(client.query(`DELETE FROM ${this.storage.commands} WHERE tenant_id = $1 AND principal_namespace_id = $2 AND command_id = $3`, [options.tenantId, options.principalNamespaceId, options.commandId]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
          else {
            this.#assertCommandIntent(options, intent, existing);
            const duplicate = await this.#beforeDeadline(this.#commandExecutionFromRow(client, options, existing, true), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
            releaseError = await this.#rollbackCleanup(client, context);
            return duplicate;
          }
        }
        await this.#beforeDeadline(client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [this.#lockKey(`stream:${options.tenantId}:${options.stream}`)]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        await this.#beforeDeadline(this.#insertTransactionAttempt(client, context), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        const next = await this.#beforeDeadline(client.query<{ sequence: string }>(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2`, [options.tenantId, options.stream]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        const sequence = Number(next.rows[0]!.sequence);
        const eventId = `evt_${randomUUID()}`;
        context.eventId = eventId;
        const operation = operationLease(operationDeadline);
        let result: JsonValue;
        try {
          result = await this.#beforeDeadline(options.mutate(client, sequence, eventId, operation), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT", () => operation.revoke());
        } finally { operation.revoke(); }
        const inserted = await this.#beforeDeadline(client.query<{ occurred_at: Date }>(`INSERT INTO ${this.storage.events} (tenant_id, stream, sequence, event_id, event_type, schema_name, data, command_principal_namespace_id, command_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING occurred_at`, [options.tenantId, options.stream, sequence, eventId, options.eventType, options.schema, JSON.stringify(options.data), options.principalNamespaceId, options.commandId]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        await this.#beforeDeadline(client.query(`INSERT INTO ${this.storage.outbox} (tenant_id, event_id) VALUES ($1,$2)`, [options.tenantId, eventId]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        const resultSchema = options.resultSchema ?? `${options.commandType}Result@1`;
        await this.#beforeDeadline(client.query(`INSERT INTO ${this.storage.commands} (tenant_id, principal_namespace_id, command_id, state, intent_hash_version, intent_hash, result, result_schema, event_id, result_expires_at, idempotency_expires_at) VALUES ($1,$2,$3,'completed',$4,$5,$6::jsonb,$7,$8,clock_timestamp() + ($9::bigint * interval '1 millisecond'),clock_timestamp() + ($10::bigint * interval '1 millisecond'))`, [options.tenantId, options.principalNamespaceId, options.commandId, intent.intentHashVersion, intent.intentHash, JSON.stringify(result), resultSchema, eventId, options.commandResultRetentionMs, options.idempotencyRetentionMs]), operationDeadline, "RT_COMMAND_OPERATION_TIMEOUT");
        if (Date.now() >= operationDeadline) throw new Error("RT_COMMAND_OPERATION_TIMEOUT");
        await this.#commit(client, transaction, context);
        const event: PostgresStoredEvent = { tenantId: options.tenantId, stream: options.stream, sequence, cursor: cursor(options.tenantId, options.stream, sequence), eventId, type: options.eventType, schema: options.schema, data: options.data, commandPrincipalNamespaceId: options.principalNamespaceId, commandId: options.commandId, occurredAt: inserted.rows[0]!.occurred_at.toISOString() };
        this.#recordCommandCommitted(options, intent, context, "commit_acknowledgement");
        return { status: "completed", duplicate: false, result, resultSchema, event };
      } catch (error) {
        const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        const cleanupError = await this.#rollbackCleanup(client, context, deadline);
        releaseError = cleanupError;
        if (!(error instanceof CommitAttemptError)) {
          if (transaction.state === "pre_commit") this.#recordPreCommitRollback(transaction, context, error);
          throw new TransactionRolledBackError(context, error);
        }
        if (error.classification.state === "rolled_back") throw new TransactionRolledBackError(context, error.originalError);
        client.release(cleanupError instanceof Error ? cleanupError : true);
        released = true;
        const reconciled = await this.#withAdvisoryReconciliation<CommandExecution>({ context, transaction, lockKey: commandLock, deadline, inspect: async (database) => {
          const row = await this.#commandRow(database, options);
          if (!row) return { resolution: "rolled_back" };
          this.#assertCommandIntent(options, intent, row);
          const value = await this.#commandExecutionFromRow(database, options, row, false, true);
          if (value.status === "completed") context.eventId = value.event.eventId;
          return { resolution: "committed", value };
        } });
        if (reconciled.resolution === "committed" && reconciled.value) {
          const committed = reconciled.value;
          if (committed.status === "completed") context.eventId = committed.event.eventId;
          this.#recordCommandCommitted(options, intent, context, "durable_transaction_attempt_marker");
          return committed;
        }
        if (attempt === 0) continue;
        throw new Error("RT_COMMAND_RECONCILED_ROLLBACK");
      } finally {
        if (!released) client.release(releaseError ? (releaseError instanceof Error ? releaseError : true) : undefined);
      }
    }
    throw new Error("RT_COMMAND_RECONCILIATION_EXHAUSTED");
  }

  async appendEvent(options: AppendEventOptions): Promise<PostgresStoredEvent> {
    if (!options.appendId || options.appendId.length > 256) throw new Error("RT_APPEND_ID_REQUIRED");
    const intent = canonicalAppendIntent({ stream: options.stream, eventType: options.eventType, schema: options.schema, data: options.data, effectSchema: options.effectSchema, effect: options.effect });
    const appendLock = this.#lockKey(`append:${options.tenantId}:${options.appendId}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = transactionContext(this.storage.namespace, "append_event", { tenantId: options.tenantId, stream: options.stream, appendId: options.appendId });
      const transaction = new TransactionStateMachine();
      const client = await this.#connect();
      let released = false;
      let releaseError: unknown | undefined;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [appendLock]);
        const existing = await this.#appendEventByOperation(client, options.tenantId, options.appendId, intent);
        if (existing) { releaseError = await this.#rollbackCleanup(client, context); return existing; }
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [this.#lockKey(`stream:${options.tenantId}:${options.stream}`)]);
        await this.#insertTransactionAttempt(client, context);
        const next = await client.query<{ sequence: string }>(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2`, [options.tenantId, options.stream]);
        const sequence = Number(next.rows[0]!.sequence);
        const eventId = `evt_${randomUUID()}`;
        context.eventId = eventId;
        await options.mutate?.(client, sequence, eventId);
        const inserted = await client.query<{ occurred_at: Date }>(`INSERT INTO ${this.storage.events} (tenant_id, stream, sequence, event_id, event_type, schema_name, data, append_operation_id, append_intent_hash_version, append_intent_hash) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING occurred_at`, [options.tenantId, options.stream, sequence, eventId, options.eventType, options.schema, JSON.stringify(options.data), options.appendId, intent.intentHashVersion, intent.intentHash]);
        await client.query(`INSERT INTO ${this.storage.outbox} (tenant_id, event_id) VALUES ($1,$2)`, [options.tenantId, eventId]);
        await this.#commit(client, transaction, context);
        const event: PostgresStoredEvent = { tenantId: options.tenantId, stream: options.stream, sequence, cursor: cursor(options.tenantId, options.stream, sequence), eventId, type: options.eventType, schema: options.schema, data: options.data, appendId: options.appendId, occurredAt: inserted.rows[0]!.occurred_at.toISOString() };
        this.#recordAppendCommitted(options, context, "commit_acknowledgement");
        return event;
      } catch (error) {
        const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        const cleanupError = await this.#rollbackCleanup(client, context, deadline);
        releaseError = cleanupError;
        if (!(error instanceof CommitAttemptError)) {
          if (transaction.state === "pre_commit") this.#recordPreCommitRollback(transaction, context, error);
          throw new TransactionRolledBackError(context, error);
        }
        if (error.classification.state === "rolled_back") throw new TransactionRolledBackError(context, error.originalError);
        client.release(cleanupError instanceof Error ? cleanupError : true);
        released = true;
        const reconciled = await this.#withAdvisoryReconciliation<PostgresStoredEvent>({ context, transaction, lockKey: appendLock, deadline, inspect: async (database) => {
          const event = await this.#appendEventByOperation(database, options.tenantId, options.appendId, intent, true);
          if (!event) return { resolution: "rolled_back" };
          context.eventId = event.eventId;
          return { resolution: "committed", value: event };
        } });
        if (reconciled.resolution === "committed" && reconciled.value) {
          this.#recordAppendCommitted(options, context, "durable_transaction_attempt_marker");
          return reconciled.value;
        }
        if (attempt === 0) continue;
        throw new Error("RT_APPEND_RECONCILED_ROLLBACK");
      } finally { if (!released) client.release(releaseError ? (releaseError instanceof Error ? releaseError : true) : undefined); }
    }
    throw new Error("RT_APPEND_RECONCILIATION_EXHAUSTED");
  }

  async commandStatus(tenantId: string, principalNamespaceId: string, commandId: string): Promise<CommandStatus> {
    const context = transactionContext(this.storage.namespace, "command", { tenantId, principalNamespaceId, commandId });
    const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
    let client: PoolClient | undefined;
    let cleanupError: unknown | undefined;
    try {
      client = await this.#connectBefore(deadline);
      await this.#beforeDeadline(client.query("BEGIN"), deadline, "RT_RECONCILIATION_TIMEOUT");
      await this.#beforeDeadline(client.query("SELECT set_config('statement_timeout', $1, true)", [String(remainingMs(deadline))]), deadline, "RT_RECONCILIATION_TIMEOUT");
      await this.#beforeDeadline(client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [this.#lockKey(`command:${tenantId}:${principalNamespaceId}:${commandId}`)]), deadline, "RT_RECONCILIATION_TIMEOUT");
      const result = await this.#beforeDeadline(client.query<{ result: JsonValue | null; result_available: boolean; result_schema: string; event_id: string; event_stream: string; event_sequence: string; result_retained: boolean; idempotency_retained: boolean }>(`SELECT command.result, command.result IS NOT NULL AS result_available, command.result_schema, command.event_id, event.stream AS event_stream, event.sequence AS event_sequence, command.result_expires_at > clock_timestamp() AS result_retained, command.idempotency_expires_at > clock_timestamp() AS idempotency_retained FROM ${this.storage.commands} AS command JOIN ${this.storage.events} AS event ON event.tenant_id = command.tenant_id AND event.event_id = command.event_id WHERE command.tenant_id = $1 AND command.principal_namespace_id = $2 AND command.command_id = $3`, [tenantId, principalNamespaceId, commandId]), deadline, "RT_RECONCILIATION_TIMEOUT");
      if (!result.rowCount || !result.rows[0]!.idempotency_retained) { this.#record({ kind: "command.outcome_unknown", boundary: "command.outcome_unknown", outcome: "unknown", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, commandId, details: { tenantId, principalNamespaceId, serialization: "command_advisory_lock" } }); return { state: "unknown" }; }
      const row = result.rows[0]!;
      if (!row.result_retained || !row.result_available) return { state: "expired" };
      return { state: "completed", result: row.result, resultSchema: row.result_schema, eventId: row.event_id, eventStream: row.event_stream, eventSequence: Number(row.event_sequence) };
    } catch (error) {
      this.#record({ kind: "database.transaction_reconciliation_unresolved", boundary: "database.transaction_reconciliation_unresolved", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, commandId, ...transactionCorrelation(context), details: { tenantId, principalNamespaceId, operation: "command_status", timeoutMs: this.transactionOptions.reconciliationTimeoutMs, error: errorMessage(error) } });
      throw new TransactionOutcomeError(context, error);
    } finally {
      if (client) {
        cleanupError = await this.#rollbackCleanup(client, context, deadline);
        client.release(cleanupError ? (cleanupError instanceof Error ? cleanupError : true) : undefined);
      }
    }
  }

  async commandExistsForOtherPrincipal(tenantId: string, principalNamespaceId: string, commandId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM ${this.storage.commands} WHERE tenant_id = $1 AND command_id = $2 AND principal_namespace_id <> $3 LIMIT 1`, [tenantId, commandId, principalNamespaceId]);
    return Boolean(result.rowCount);
  }

  async cleanupCommandRetention(limit = 1_000): Promise<{ resultsCleared: number; tombstonesDeleted: number }> {
    validateLimit(limit);
    const pending = await this.pool.query<{ work: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${this.storage.commands} WHERE (result IS NOT NULL AND result_expires_at <= clock_timestamp()) OR idempotency_expires_at <= clock_timestamp()) OR EXISTS (SELECT 1 FROM ${this.storage.transactionAttempts} WHERE marker_written_at <= clock_timestamp() - ($1::bigint * interval '1 millisecond')) AS work`, [TRANSACTION_ATTEMPT_RETENTION_MS]);
    if (!pending.rows[0]!.work) return { resultsCleared: 0, tombstonesDeleted: 0 };
    return this.#markedWrite("command_retention_cleanup", "maintenance:command-retention", async (client) => {
      const cleared = await client.query(`WITH selected AS (SELECT tenant_id, principal_namespace_id, command_id FROM ${this.storage.commands} WHERE result IS NOT NULL AND result_expires_at <= clock_timestamp() AND idempotency_expires_at > clock_timestamp() ORDER BY result_expires_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE ${this.storage.commands} AS command SET result = NULL FROM selected WHERE command.tenant_id = selected.tenant_id AND command.principal_namespace_id = selected.principal_namespace_id AND command.command_id = selected.command_id`, [limit]);
      const deleted = await client.query(`WITH selected AS (SELECT tenant_id, principal_namespace_id, command_id FROM ${this.storage.commands} WHERE idempotency_expires_at <= clock_timestamp() ORDER BY idempotency_expires_at FOR UPDATE SKIP LOCKED LIMIT $1) DELETE FROM ${this.storage.commands} AS command USING selected WHERE command.tenant_id = selected.tenant_id AND command.principal_namespace_id = selected.principal_namespace_id AND command.command_id = selected.command_id`, [limit]);
      await client.query(`WITH selected AS (SELECT transaction_id FROM ${this.storage.transactionAttempts} WHERE marker_written_at <= clock_timestamp() - ($1::bigint * interval '1 millisecond') ORDER BY marker_written_at LIMIT $2) DELETE FROM ${this.storage.transactionAttempts} AS attempt USING selected WHERE attempt.transaction_id = selected.transaction_id`, [TRANSACTION_ATTEMPT_RETENTION_MS, limit]);
      return { resultsCleared: cleared.rowCount ?? 0, tombstonesDeleted: deleted.rowCount ?? 0 };
    });
  }

  async cleanupPublishedOutbox(retentionMs: number, limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) throw new Error("RT_RETENTION_INVALID");
    validateLimit(limit);
    const pending = await this.pool.query<{ work: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${this.storage.outbox} WHERE notify_committed_at IS NOT NULL AND notify_committed_at <= clock_timestamp() - ($1::bigint * interval '1 millisecond')) AS work`, [retentionMs]);
    if (!pending.rows[0]!.work) return 0;
    return this.#markedWrite("outbox_retention_cleanup", "maintenance:outbox-retention", async (client) => {
      const deleted = await client.query(`WITH selected AS (SELECT outbox_id FROM ${this.storage.outbox} WHERE notify_committed_at IS NOT NULL AND notify_committed_at <= clock_timestamp() - ($1::bigint * interval '1 millisecond') ORDER BY notify_committed_at FOR UPDATE SKIP LOCKED LIMIT $2) DELETE FROM ${this.storage.outbox} AS outbox USING selected WHERE outbox.outbox_id = selected.outbox_id`, [retentionMs, limit]);
      return deleted.rowCount ?? 0;
    });
  }

  async resourceCounts(): Promise<{ commands: number; outbox: number; pendingOutbox: number; transactionAttempts: number }> {
    const result = await this.pool.query<{ commands: string; outbox: string; pending_outbox: string; transaction_attempts: string }>(`SELECT (SELECT count(*) FROM ${this.storage.commands}) AS commands, (SELECT count(*) FROM ${this.storage.outbox}) AS outbox, (SELECT count(*) FROM ${this.storage.outbox} WHERE notify_committed_at IS NULL) AS pending_outbox, (SELECT count(*) FROM ${this.storage.transactionAttempts}) AS transaction_attempts`);
    return { commands: Number(result.rows[0]!.commands), outbox: Number(result.rows[0]!.outbox), pendingOutbox: Number(result.rows[0]!.pending_outbox), transactionAttempts: Number(result.rows[0]!.transaction_attempts) };
  }

  async readAfter(tenantId: string, stream: string, after?: string | null, limit = 1000): Promise<PostgresStoredEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("RT_READ_LIMIT_INVALID");
    const sequence = sequenceFromCursor(tenantId, stream, after);
    if (sequence === null) throw new Error("RT_CURSOR_EXPIRED");
    const floor = await this.pool.query<{ minimum_sequence: string }>(`SELECT minimum_sequence FROM ${this.storage.streamRetention} WHERE tenant_id = $1 AND stream = $2`, [tenantId, stream]);
    if (floor.rowCount && sequence < Number(floor.rows[0]!.minimum_sequence) - 1) throw new Error("RT_CURSOR_EXPIRED");
    const result = await this.pool.query(`SELECT tenant_id, stream, sequence, event_id, event_type, schema_name, data, append_operation_id, command_principal_namespace_id, command_id, occurred_at FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2 AND sequence > $3 ORDER BY sequence ASC LIMIT $4`, [tenantId, stream, sequence, limit]);
    return result.rows.map(rowToEvent);
  }

  async head(tenantId: string, stream: string): Promise<string | null> {
    const result = await this.pool.query<{ sequence: string }>(`SELECT sequence FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2 ORDER BY sequence DESC LIMIT 1`, [tenantId, stream]);
    return result.rowCount ? cursor(tenantId, stream, Number(result.rows[0]!.sequence)) : null;
  }

  async latestEvent(tenantId: string, stream: string): Promise<PostgresStoredEvent | undefined> {
    const result = await this.pool.query(`SELECT tenant_id, stream, sequence, event_id, event_type, schema_name, data, append_operation_id, command_principal_namespace_id, command_id, occurred_at FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2 ORDER BY sequence DESC LIMIT 1`, [tenantId, stream]);
    return result.rowCount ? rowToEvent(result.rows[0]) : undefined;
  }

  async headSequence(tenantId: string, stream: string): Promise<number> {
    const result = await this.pool.query<{ sequence: string }>(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2`, [tenantId, stream]);
    return Number(result.rows[0]!.sequence);
  }

  async expireBeforeCurrentHead(tenantId: string, stream: string): Promise<void> {
    await this.#markedWrite("stream_retention", `stream-retention:${tenantId}:${stream}`, async (client) => {
      const current = await client.query<{ sequence: string }>(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2`, [tenantId, stream]);
      await client.query(`INSERT INTO ${this.storage.streamRetention} (tenant_id, stream, minimum_sequence) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, stream) DO UPDATE SET minimum_sequence = EXCLUDED.minimum_sequence`, [tenantId, stream, Number(current.rows[0]!.sequence) + 2]);
      return null;
    }, { tenantId, stream });
  }

  async atomicSnapshot(tenantId: string, stream: string, installLiveFence?: () => Promise<void>): Promise<AtomicSnapshot<RoomSnapshotState>> {
    return this.#atomicSnapshotWith(tenantId, stream, async (database, context) => {
      const state = await database.query<{ sequence: string; author: string; body: string; sent_at: Date }>(`SELECT sequence, author, body, sent_at FROM ${quoteIdentifier(this.storage.schema)}.realtime_room_messages WHERE tenant_id = $1 AND stream = $2 AND sequence <= $3 ORDER BY sequence DESC LIMIT 100`, [tenantId, stream, context.includedSequence]);
      const selected = state.rows.toReversed();
      const messages: JsonValue[] = selected.map((row) => ({ author: row.author, text: row.body, sentAt: row.sent_at.toISOString() }));
      let truncated = false;
      while (messages.length > 1 && Buffer.byteLength(JSON.stringify({ messages, sequence: context.includedSequence })) > MAX_SNAPSHOT_STATE_BYTES) { messages.shift(); truncated = true; }
      const windowStartSequence = selected.length > messages.length ? Number(selected[selected.length - messages.length]!.sequence) : Number(selected[0]?.sequence ?? 0);
      truncated ||= context.includedSequence > selected.length;
      return { messages, sequence: context.includedSequence, windowStartSequence, truncated };
    }, installLiveFence, (state) => ({ messages: state.messages.length, truncated: state.truncated }));
  }

  async atomicSnapshotWith<TState extends JsonValue>(tenantId: string, stream: string, provider: (client: PoolClient, context: AtomicSnapshotContext) => Promise<TState> | TState, installLiveFence?: () => Promise<void>): Promise<AtomicSnapshot<TState>> {
    return this.#atomicSnapshotWith(tenantId, stream, provider, installLiveFence, () => ({ provider: "application" }));
  }

  async #atomicSnapshotWith<TState extends JsonValue>(tenantId: string, stream: string, provider: (client: PoolClient, context: AtomicSnapshotContext) => Promise<TState> | TState, installLiveFence?: () => Promise<void>, stateDetails: (state: TState) => Record<string, JsonValue> = () => ({})): Promise<AtomicSnapshot<TState>> {
    const discarded: Array<{ context: TransactionContext; transaction: TransactionStateMachine }> = [];
    for (let attempt = 0; attempt < this.transactionOptions.snapshotRetryLimit; attempt += 1) {
      const attemptDeadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
      const context = transactionContext(this.storage.namespace, "snapshot_read", { tenantId, stream });
      const transaction = new TransactionStateMachine();
      const client = await this.#connectBefore(attemptDeadline);
      let cursorSequence = 0;
      let state: TState | undefined;
      let released = false;
      let releaseError: unknown | undefined;
      try {
        await this.#beforeDeadline(client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"), attemptDeadline, "RT_SNAPSHOT_ATTEMPT_TIMEOUT");
        const head = await this.#beforeDeadline(client.query<{ sequence: string }>(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2`, [tenantId, stream]), attemptDeadline, "RT_SNAPSHOT_ATTEMPT_TIMEOUT");
        cursorSequence = Number(head.rows[0]!.sequence);
        const operation = operationLease(attemptDeadline);
        try {
          state = await this.#beforeDeadline(Promise.resolve(provider(client, { tenantId, stream, includedSequence: cursorSequence, operation })), attemptDeadline, "RT_SNAPSHOT_ATTEMPT_TIMEOUT", () => operation.revoke());
        } finally { operation.revoke(); }
        const snapshotBytes = Buffer.byteLength(JSON.stringify(state));
        if (snapshotBytes > MAX_SNAPSHOT_STATE_BYTES) throw new Error("RT_SNAPSHOT_TOO_LARGE");
        await this.#commit(client, transaction, context);
        client.release();
        released = true;
        for (const prior of discarded) this.#recordReadOnlyDiscardReconciled(prior.context, prior.transaction);
        const fenceDeadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        if (installLiveFence) await this.#beforeDeadline(installLiveFence(), fenceDeadline, "RT_SNAPSHOT_FENCE_TIMEOUT");
        const headSequence = await this.#headSequenceBefore(tenantId, stream, fenceDeadline);
        this.#record({ kind: "snapshot.created", boundary: "snapshot.created", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { tenantId, cursorSequence, headSequence, isolation: "repeatable_read_read_only", snapshotBytes, ...stateDetails(state), proofSource: "commit_acknowledgement" } });
        return { state, cursor: cursor(tenantId, stream, cursorSequence), cursorSequence, head: cursor(tenantId, stream, headSequence), headSequence };
      } catch (error) {
        if (transaction.state === "committed") throw error;
        const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        const cleanupError = await this.#rollbackCleanup(client, context, deadline);
        releaseError = cleanupError;
        if (!(error instanceof CommitAttemptError)) {
          if (transaction.state === "pre_commit") this.#recordPreCommitRollback(transaction, context, error);
          throw new TransactionRolledBackError(context, error);
        }
        if (error.classification.state === "rolled_back") throw new TransactionRolledBackError(context, error.originalError);
        client.release(cleanupError instanceof Error ? cleanupError : true);
        released = true;
        discarded.push({ context, transaction });
        if (attempt + 1 >= this.transactionOptions.snapshotRetryLimit) throw new TransactionOutcomeError(context, error.originalError);
      } finally { if (!released) client.release(releaseError ? (releaseError instanceof Error ? releaseError : true) : undefined); }
    }
    throw new Error("RT_SNAPSHOT_RETRY_EXHAUSTED");
  }

  async pendingOutbox(tenantId?: string, limit = 100): Promise<Array<{ outboxId: number; tenantId: string; eventId: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("RT_READ_LIMIT_INVALID");
    const result = tenantId
      ? await this.pool.query<{ outbox_id: string; tenant_id: string; event_id: string }>(`SELECT outbox_id, tenant_id, event_id FROM ${this.storage.outbox} WHERE tenant_id = $1 AND notify_committed_at IS NULL ORDER BY outbox_id LIMIT $2`, [tenantId, limit])
      : await this.pool.query<{ outbox_id: string; tenant_id: string; event_id: string }>(`SELECT outbox_id, tenant_id, event_id FROM ${this.storage.outbox} WHERE notify_committed_at IS NULL ORDER BY outbox_id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ outboxId: Number(row.outbox_id), tenantId: row.tenant_id, eventId: row.event_id }));
  }

  async publishOutbox(options: { limit?: number; crashPoint?: OutboxCrashPoint } = {}): Promise<number> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("RT_READ_LIMIT_INVALID");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = transactionContext(this.storage.namespace, "outbox_publish");
      const transaction = new TransactionStateMachine();
      const client = await this.#connect();
      let rows: Array<{ outbox_id: string; tenant_id: string; event_id: string }> = [];
      let released = false;
      let releaseError: unknown | undefined;
      try {
        await client.query("BEGIN");
        const claimed = await client.query<{ outbox_id: string; tenant_id: string; event_id: string }>(`SELECT outbox_id, tenant_id, event_id FROM ${this.storage.outbox} WHERE notify_committed_at IS NULL ORDER BY outbox_id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
        rows = claimed.rows;
        context.operationCorrelationId = rows.length === 1 ? operationCorrelation(this.storage.namespace, { operation: "outbox_publish", outboxId: Number(rows[0]!.outbox_id) }) : operationCorrelation(this.storage.namespace, { operation: "outbox_publish", outboxIds: rows.map((row) => Number(row.outbox_id)) });
        if (rows.length === 1) context.eventId = rows[0]!.event_id;
        for (const row of rows) this.#record({ kind: "outbox.claimed", boundary: "outbox.claimed", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), operationCorrelationId: operationCorrelation(this.storage.namespace, { operation: "outbox_publish", outboxId: Number(row.outbox_id) }), eventId: row.event_id, details: { tenantId: row.tenant_id, outboxId: Number(row.outbox_id) } });
        if (rows.length === 0) { releaseError = await this.#rollbackCleanup(client, context); return 0; }
        await this.#insertTransactionAttempt(client, context);
        if (options.crashPoint === "after_claim") throw new Error("INJECTED_OUTBOX_AFTER_CLAIM");
        for (const row of rows) {
          await client.query("SELECT pg_notify($1, $2)", [this.storage.channel, row.outbox_id]);
          if (options.crashPoint === "after_notify") throw new Error("INJECTED_OUTBOX_AFTER_NOTIFY");
          await client.query(`UPDATE ${this.storage.outbox} SET notify_committed_at = clock_timestamp(), publish_attempts = publish_attempts + 1 WHERE outbox_id = $1`, [row.outbox_id]);
          if (options.crashPoint === "after_mark") throw new Error("INJECTED_OUTBOX_AFTER_MARK");
        }
        await this.#commit(client, transaction, context);
        this.#recordOutboxCommitted(rows, context, "commit_acknowledgement");
        return rows.length;
      } catch (error) {
        const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        const cleanupError = await this.#rollbackCleanup(client, context, deadline);
        releaseError = cleanupError;
        if (!(error instanceof CommitAttemptError)) {
          if (transaction.state === "pre_commit") this.#recordPreCommitRollback(transaction, context, error);
          this.#recordOutboxRolledBack(rows, context, options.crashPoint ?? null, "commit_not_invoked");
          throw new TransactionRolledBackError(context, error);
        }
        if (error.classification.state === "rolled_back") {
          this.#recordOutboxRolledBack(rows, context, options.crashPoint ?? null, "postgres_error_response");
          throw new TransactionRolledBackError(context, error.originalError);
        }
        client.release(cleanupError instanceof Error ? cleanupError : true);
        released = true;
        this.#recordOutboxTransactionLinks(rows, context, "database.transaction_outcome_indeterminate", "unknown");
        const reconciled = await this.#reconcileOutbox(context, transaction, rows, deadline);
        if (reconciled === "committed") { this.#recordOutboxCommitted(rows, context, "durable_transaction_attempt_marker"); return rows.length; }
        this.#recordOutboxRolledBack(rows, context, options.crashPoint ?? null, "durable_transaction_attempt_marker");
        if (attempt === 0) continue;
        throw new Error("RT_OUTBOX_RECONCILED_ROLLBACK");
      } finally { if (!released) client.release(releaseError ? (releaseError instanceof Error ? releaseError : true) : undefined); }
    }
    throw new Error("RT_OUTBOX_RECONCILIATION_EXHAUSTED");
  }

  async listen(onEvent: (notification: PostgresNotification) => void, onUnavailable?: (error: Error) => void): Promise<() => Promise<void>> {
    const client = await this.#connect();
    const notification = (message: Notification) => {
      if (message.channel !== this.storage.channel || !message.payload) return;
      try {
        const outboxId = Number(message.payload);
        if (Number.isSafeInteger(outboxId) && outboxId > 0) onEvent({ outboxId });
      } catch { /* a malformed wake hint cannot alter durable state */ }
    };
    const unavailable = (error: Error) => onUnavailable?.(error);
    const ended = () => onUnavailable?.(new Error("PostgreSQL LISTEN connection ended"));
    client.on("notification", notification);
    client.on("error", unavailable);
    client.on("end", ended);
    try {
      await client.query(`LISTEN ${quoteIdentifier(this.storage.channel)}`);
      await client.query("SELECT 1");
    } catch (error) {
      client.off("notification", notification);
      client.off("error", unavailable);
      client.off("end", ended);
      client.release();
      throw error;
    }
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      client.off("notification", notification);
      client.off("error", unavailable);
      client.off("end", ended);
      const ignoreDisposalError = () => undefined;
      client.on("error", ignoreDisposalError);
      try {
        await client.query(`UNLISTEN ${quoteIdentifier(this.storage.channel)}`);
        client.off("error", ignoreDisposalError);
        client.release();
      } catch (error) {
        client.off("error", ignoreDisposalError);
        client.release(error instanceof Error ? error : true);
        throw error;
      }
    };
  }

  async #commit(client: PoolClient, transaction: TransactionStateMachine, context: TransactionContext): Promise<void> {
    const deadline = Date.now() + this.transactionOptions.commitTimeoutMs;
    if (context.operation !== "snapshot_read") {
      await this.#beforeDeadline(client.query(`UPDATE ${this.storage.transactionAttempts} SET marker_written_at = clock_timestamp() WHERE transaction_id = $1`, [context.transactionId]).then(() => undefined), deadline, "RT_COMMIT_PREPARATION_TIMEOUT");
    }
    transaction.transition("commit_in_flight");
    this.#record({ kind: "database.transaction_commit_invoked", boundary: "database.transaction_commit_invoked", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: transactionDetails(context, { operation: context.operation, state: transaction.state }) });
    try {
      const commit = this.transactionOptions.commit ? this.transactionOptions.commit(client, context) : client.query("COMMIT").then(() => undefined);
      await this.#beforeDeadline(commit, deadline, "RT_COMMIT_ACK_TIMEOUT");
      transaction.transition("committed");
      this.#record({ kind: "database.transaction_commit_acknowledged", boundary: "database.transaction_commit_acknowledged", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: transactionDetails(context, { operation: context.operation, state: transaction.state, proofSource: "commit_acknowledgement" }) });
    } catch (error) {
      const classification = classifyCommitFailure(error);
      transaction.transition(classification.state);
      if (classification.state === "rolled_back") {
        this.#record({ kind: "database.transaction_rolled_back", boundary: "db.rolled_back", outcome: "failure", reasonCode: "RT_TRANSACTION_ROLLED_BACK", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: transactionDetails(context, { operation: context.operation, state: transaction.state, proofSource: classification.proofSource, sqlstate: classification.sqlstate ?? null, error: errorMessage(error) }) });
      } else {
        this.#record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: transactionDetails(context, { operation: context.operation, state: transaction.state, proofSource: classification.proofSource, sqlstate: classification.sqlstate ?? null, error: errorMessage(error) }) });
      }
      throw new CommitAttemptError(classification, error);
    }
  }

  async #commandRow(client: PoolClient, options: Pick<ExecuteCommandOptions, "tenantId" | "principalNamespaceId" | "commandId">): Promise<CommandDurableRow | undefined> {
    const result = await client.query<CommandDurableRow>(`SELECT command.result, command.result IS NOT NULL AS result_available, command.result_schema, command.event_id, command.intent_hash_version, command.intent_hash, command.result_expires_at > clock_timestamp() AS result_retained, command.idempotency_expires_at > clock_timestamp() AS idempotency_retained, EXISTS (SELECT 1 FROM ${this.storage.outbox} AS outbox WHERE outbox.tenant_id = command.tenant_id AND outbox.event_id = command.event_id) AS outbox_present FROM ${this.storage.commands} AS command WHERE command.tenant_id = $1 AND command.principal_namespace_id = $2 AND command.command_id = $3`, [options.tenantId, options.principalNamespaceId, options.commandId]);
    return result.rowCount ? result.rows[0] : undefined;
  }

  #assertCommandIntent(options: Pick<ExecuteCommandOptions, "tenantId" | "principalNamespaceId" | "commandId">, intent: CanonicalIntent, row: CommandDurableRow): void {
    const matches = row.intent_hash_version === intent.intentHashVersion && row.intent_hash === intent.intentHash;
    this.#record({ kind: "command.intent_compared", boundary: "command.intent_compared", outcome: matches ? "success" : "failure", ...(matches ? {} : { reasonCode: "RT_COMMAND_INTENT_CONFLICT" }), ...STORE_POSTGRES_EVIDENCE_COMPONENT, commandId: options.commandId, details: { tenantId: options.tenantId, principalNamespaceId: options.principalNamespaceId, intentHashVersion: intent.intentHashVersion } });
    if (!matches) throw new Error("RT_COMMAND_INTENT_CONFLICT");
  }

  async #commandExecutionFromRow(client: PoolClient, options: ExecuteCommandOptions, row: CommandDurableRow, duplicate: boolean, requireOutboxProof = false): Promise<CommandExecution> {
    if (requireOutboxProof && !row.outbox_present) throw new Error("RT_COMMAND_DURABLE_STATE_INCOMPLETE");
    if (!row.result_retained || !row.result_available) {
      this.#record({ kind: "command.retention_checked", boundary: "command.retention_checked", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, commandId: options.commandId, details: { tenantId: options.tenantId, principalNamespaceId: options.principalNamespaceId, result: "expired", idempotency: "retained" } });
      return { status: "expired", duplicate: true };
    }
    const event = await this.#eventById(client, options.tenantId, row.event_id);
    this.#record({ kind: "command.reconciled", boundary: "command.reconciled", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, commandId: options.commandId, eventId: event.eventId, stream: options.stream, details: { tenantId: options.tenantId, principalNamespaceId: options.principalNamespaceId, duplicate, intentHashVersion: row.intent_hash_version } });
    return { status: "completed", duplicate, result: row.result, resultSchema: row.result_schema, event };
  }

  #recordCommandCommitted(options: ExecuteCommandOptions, intent: CanonicalIntent, context: TransactionContext, proofSource: "commit_acknowledgement" | "durable_transaction_attempt_marker"): void {
    this.#record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), ...(context.eventId ? { causalHandoffId: `event:${context.eventId}` } : {}), details: { tenantId: options.tenantId, principalNamespaceId: options.principalNamespaceId, intentHashVersion: intent.intentHashVersion, proofSource } });
    if (context.eventId) this.#record({ kind: "outbox.appended", boundary: "outbox.appended", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), causalHandoffId: `event:${context.eventId}`, details: { tenantId: options.tenantId, proofSource } });
  }

  async #appendEventByOperation(client: PoolClient, tenantId: string, appendId: string, intent: CanonicalIntent, requireOutboxProof = false): Promise<PostgresStoredEvent | undefined> {
    const result = await client.query(`SELECT event.tenant_id, event.stream, event.sequence, event.event_id, event.event_type, event.schema_name, event.data, event.append_operation_id, event.append_intent_hash_version, event.append_intent_hash, event.command_id, event.occurred_at, EXISTS (SELECT 1 FROM ${this.storage.outbox} AS outbox WHERE outbox.tenant_id = event.tenant_id AND outbox.event_id = event.event_id) AS outbox_present FROM ${this.storage.events} AS event WHERE event.tenant_id = $1 AND event.append_operation_id = $2`, [tenantId, appendId]);
    if (!result.rowCount) return undefined;
    const row = result.rows[0] as Record<string, unknown>;
    if (Number(row.append_intent_hash_version) !== intent.intentHashVersion || String(row.append_intent_hash) !== intent.intentHash) throw new Error("RT_APPEND_INTENT_CONFLICT");
    if (requireOutboxProof && row.outbox_present !== true) throw new Error("RT_APPEND_DURABLE_STATE_INCOMPLETE");
    return rowToEvent(row);
  }

  #recordAppendCommitted(options: AppendEventOptions, context: TransactionContext, proofSource: "commit_acknowledgement" | "durable_transaction_attempt_marker"): void {
    this.#record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), ...(context.eventId ? { causalHandoffId: `event:${context.eventId}` } : {}), details: { tenantId: options.tenantId, appendId: options.appendId, effectSchema: options.effectSchema, proofSource } });
    if (context.eventId) this.#record({ kind: "outbox.appended", boundary: "outbox.appended", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), causalHandoffId: `event:${context.eventId}`, details: { tenantId: options.tenantId, appendId: options.appendId, proofSource } });
  }

  async #resolvedPrincipalNamespace(database: Pick<PoolClient, "query">, tenantId: string, aliases: Array<{ keyVersion: number; fingerprint: string }>): Promise<string | undefined> {
    const requested = aliases.map((alias) => ({ key_version: alias.keyVersion, identity_fingerprint: alias.fingerprint }));
    const linked = await database.query<{ principal_namespace_id: string }>(`SELECT identity.principal_namespace_id FROM ${this.storage.principalIdentityAliases} AS identity JOIN jsonb_to_recordset($3::jsonb) AS requested(key_version integer, identity_fingerprint text) ON requested.key_version = identity.key_version AND requested.identity_fingerprint = identity.identity_fingerprint WHERE identity.tenant_id = $1 AND identity.identity_tuple_version = $2`, [tenantId, IDENTITY_TUPLE_VERSION, JSON.stringify(requested)]);
    if (linked.rowCount !== aliases.length) return undefined;
    const namespaces = new Set(linked.rows.map((row) => row.principal_namespace_id));
    if (namespaces.size !== 1) throw new Error("RT_PRINCIPAL_ALIAS_CONFLICT");
    return [...namespaces][0];
  }

  #recordPrincipalResolved(identity: PrincipalIdentity, aliases: Array<{ keyVersion: number; fingerprint: string }>, principalNamespaceId: string, context: TransactionContext, proofSource: string, aliasUpserted = true): void {
    const details = { tenantId: identity.tenantId, principalNamespaceId, identityTupleVersion: IDENTITY_TUPLE_VERSION, keyVersions: aliases.map((alias) => alias.keyVersion), proofSource };
    const transactionCorrelationFields = aliasUpserted ? { transactionId: context.transactionId, ...transactionCorrelation(context) } : {};
    if (aliasUpserted) this.#record({ kind: "principal.alias_upserted", boundary: "principal.alias_upserted", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details });
    this.#record({ kind: "security.identity_redacted", boundary: "security.identity_redacted", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, ...transactionCorrelationFields, details: { tenantId: identity.tenantId, rawIssuerCaptured: false, rawSubjectCaptured: false } });
    this.#record({ kind: "principal.identity_resolved", boundary: "principal.identity_resolved", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, ...transactionCorrelationFields, details: { ...details, rawIdentityCaptured: false } });
  }

  #recordReadOnlyDiscardReconciled(context: TransactionContext, transaction: TransactionStateMachine): void {
    transaction.transition("reconciling");
    this.#record({ kind: "database.transaction_reconciliation_started", boundary: "database.transaction_reconciliation_started", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, serialization: "fresh_repeatable_read_read_only_attempt" } });
    transaction.transition("reconciled", "no_durable_effect");
    this.#record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, resolution: "no_durable_effect", proofSource: "repeatable_read_read_only_discard_and_retry", serialization: "fresh_repeatable_read_read_only_attempt" } });
  }

  async #reconcileOutbox(context: TransactionContext, transaction: TransactionStateMachine, rows: Array<{ outbox_id: string; tenant_id: string; event_id: string }>, deadline: number): Promise<"committed" | "rolled_back"> {
    transaction.transition("reconciling");
    this.#record({ kind: "database.transaction_reconciliation_started", boundary: "database.transaction_reconciliation_started", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, serialization: "outbox_row_lock", outboxIds: rows.map((row) => Number(row.outbox_id)) } });
    let client: PoolClient | undefined;
    let cleanupError: unknown | undefined;
    try {
      client = await this.#connectBefore(deadline);
      await this.#beforeDeadline(client.query("BEGIN"), deadline, "RT_RECONCILIATION_TIMEOUT");
      await this.#beforeDeadline(client.query("SELECT set_config('statement_timeout', $1, true)", [String(remainingMs(deadline))]), deadline, "RT_RECONCILIATION_TIMEOUT");
      const resolved = await this.#beforeDeadline(client.query<{ outbox_id: string; notify_committed_at: Date | null }>(`SELECT outbox_id, notify_committed_at FROM ${this.storage.outbox} WHERE outbox_id = ANY($1::bigint[]) ORDER BY outbox_id FOR UPDATE`, [rows.map((row) => row.outbox_id)]), deadline, "RT_RECONCILIATION_TIMEOUT");
      const marker = await this.#transactionAttempt(client, context, false, deadline);
      let resolution: "committed" | "rolled_back";
      if (!marker) resolution = "rolled_back";
      else {
        if (resolved.rowCount !== rows.length || resolved.rows.some((row) => row.notify_committed_at === null)) throw new Error("RT_OUTBOX_RECONCILIATION_DURABLE_STATE_INCOMPLETE");
        resolution = "committed";
      }
      transaction.transition("reconciled", resolution);
      this.#record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, resolution, proofSource: "durable_transaction_attempt_marker", serialization: "outbox_row_lock", outboxIds: rows.map((row) => Number(row.outbox_id)) } });
      this.#recordOutboxTransactionLinks(rows, context, "database.transaction_reconciled", "success", { resolution, proofSource: "durable_transaction_attempt_marker", serialization: "outbox_row_lock" });
      return resolution;
    } catch (error) {
      if (transaction.state === "reconciling") transaction.transition("indeterminate");
      this.#record({ kind: "database.transaction_reconciliation_unresolved", boundary: "database.transaction_reconciliation_unresolved", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, timeoutMs: this.transactionOptions.reconciliationTimeoutMs, error: errorMessage(error) } });
      throw new TransactionOutcomeError(context, error);
    } finally {
      if (client) {
        cleanupError = await this.#rollbackCleanup(client, context, deadline);
        client.release(cleanupError ? (cleanupError instanceof Error ? cleanupError : true) : undefined);
      }
    }
  }

  #recordOutboxTransactionLinks(rows: Array<{ outbox_id: string; tenant_id: string; event_id: string }>, context: TransactionContext, boundary: "database.transaction_outcome_indeterminate" | "database.transaction_reconciled", outcome: "unknown" | "success", details: Record<string, unknown> = {}): void {
    for (const row of rows) this.#record({ kind: boundary, boundary, outcome, ...(outcome === "unknown" ? { reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE" } : {}), ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), operationCorrelationId: operationCorrelation(this.storage.namespace, { operation: "outbox_publish", outboxId: Number(row.outbox_id) }), eventId: row.event_id, details: { operation: context.operation, tenantId: row.tenant_id, outboxId: Number(row.outbox_id), ...details } });
  }

  #recordOutboxCommitted(rows: Array<{ outbox_id: string; tenant_id: string; event_id: string }>, context: TransactionContext, proofSource: "commit_acknowledgement" | "durable_transaction_attempt_marker"): void {
    for (const row of rows) this.#record({ kind: "outbox.notify_committed", boundary: "outbox.notify_committed", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), operationCorrelationId: operationCorrelation(this.storage.namespace, { operation: "outbox_publish", outboxId: Number(row.outbox_id) }), eventId: row.event_id, details: { tenantId: row.tenant_id, outboxId: Number(row.outbox_id), listenerDeliveryClaimed: false, proofSource } });
  }

  #recordOutboxRolledBack(rows: Array<{ outbox_id: string; tenant_id: string; event_id: string }>, context: TransactionContext, crashPoint: OutboxCrashPoint | null, proofSource: string): void {
    this.#record({ kind: "outbox.publish_rolled_back", boundary: "outbox.publish_rolled_back", outcome: "failure", reasonCode: "RT_OUTBOX_PUBLISH_ROLLED_BACK", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { claimed: rows.length, crashPoint, proofSource } });
  }

  async #rollbackCleanup(client: PoolClient, context: TransactionContext, deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs): Promise<unknown | undefined> {
    try {
      await this.#beforeDeadline(this.transactionOptions.rollback ? this.transactionOptions.rollback(client, context) : client.query("ROLLBACK").then(() => undefined), deadline, "RT_TRANSACTION_CLEANUP_TIMEOUT");
      this.#record({ kind: "database.transaction_cleanup_attempted", boundary: "database.transaction_cleanup_attempted", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: transactionDetails(context, { operation: context.operation, action: "rollback", outcomeProof: false }) });
      return undefined;
    } catch (error) {
      this.#record({ kind: "database.transaction_cleanup_attempted", boundary: "database.transaction_cleanup_attempted", outcome: "failure", reasonCode: "RT_TRANSACTION_CLEANUP_FAILED", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: transactionDetails(context, { operation: context.operation, action: "rollback", outcomeProof: false, error: errorMessage(error) }) });
      return error;
    }
  }

  #recordPreCommitRollback(transaction: TransactionStateMachine, context: TransactionContext, error: unknown): void {
    transaction.transition("rolled_back");
    const sqlstate = postgresSqlstate(error);
    this.#record({ kind: "database.transaction_rolled_back", boundary: "db.rolled_back", outcome: "failure", reasonCode: "RT_TRANSACTION_ROLLED_BACK", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: transactionDetails(context, { operation: context.operation, state: transaction.state, proofSource: "commit_not_invoked", ...(sqlstate ? { sqlstate } : {}), error: errorMessage(error) }) });
  }

  async #withAdvisoryReconciliation<T>(options: {
    context: TransactionContext;
    transaction: TransactionStateMachine;
    lockKey?: string;
    lockKeys?: readonly string[];
    deadline: number;
    inspect(client: PoolClient, markerResult: JsonValue | null): Promise<{ resolution: TransactionResolution; value?: T }>;
  }): Promise<{ resolution: TransactionResolution; value?: T }> {
    options.transaction.transition("reconciling");
    this.#record({ kind: "database.transaction_reconciliation_started", boundary: "database.transaction_reconciliation_started", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: options.context.transactionId, ...transactionCorrelation(options.context), details: { operation: options.context.operation, state: options.transaction.state, serialization: "pg_advisory_xact_lock" } });
    let client: PoolClient | undefined;
    let cleanupError: unknown | undefined;
    try {
      client = await this.#connectBefore(options.deadline);
      await this.#beforeDeadline(client.query("BEGIN"), options.deadline, "RT_RECONCILIATION_TIMEOUT");
      await this.#beforeDeadline(client.query("SELECT set_config('statement_timeout', $1, true)", [String(remainingMs(options.deadline))]), options.deadline, "RT_RECONCILIATION_TIMEOUT");
      const lockKeys = options.lockKeys ?? (options.lockKey ? [options.lockKey] : []);
      if (lockKeys.length === 0) throw new Error("RT_RECONCILIATION_LOCK_REQUIRED");
      for (const lockKey of [...lockKeys].sort()) {
        await this.#beforeDeadline(client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]), options.deadline, "RT_RECONCILIATION_TIMEOUT");
      }
      const marker = await this.#transactionAttempt(client, options.context, false, options.deadline);
      const result = marker ? await this.#beforeDeadline(options.inspect(client, marker.result), options.deadline, "RT_RECONCILIATION_TIMEOUT") : { resolution: "rolled_back" as const };
      if (marker && result.resolution !== "committed") throw new Error("RT_TRANSACTION_MARKER_DURABLE_STATE_INCOMPLETE");
      options.transaction.transition("reconciled", result.resolution);
      this.#record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: options.context.transactionId, ...transactionCorrelation(options.context), details: { operation: options.context.operation, state: options.transaction.state, resolution: result.resolution, proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
      return result;
    } catch (error) {
      if (options.transaction.state === "reconciling") options.transaction.transition("indeterminate");
      this.#record({ kind: "database.transaction_reconciliation_unresolved", boundary: "database.transaction_reconciliation_unresolved", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: options.context.transactionId, ...transactionCorrelation(options.context), details: { operation: options.context.operation, state: options.transaction.state, timeoutMs: this.transactionOptions.reconciliationTimeoutMs, error: errorMessage(error) } });
      throw new TransactionOutcomeError(options.context, error);
    } finally {
      if (client) {
        cleanupError = await this.#rollbackCleanup(client, options.context, options.deadline);
        client.release(cleanupError ? (cleanupError instanceof Error ? cleanupError : true) : undefined);
      }
    }
  }

  async #insertTransactionAttempt(client: PoolClient, context: TransactionContext, result?: JsonValue): Promise<void> {
    await client.query(`INSERT INTO ${this.storage.transactionAttempts} (transaction_id, operation, result) VALUES ($1,$2,$3::jsonb)`, [context.transactionId, context.operation, result === undefined ? null : JSON.stringify(result)]);
  }

  async #transactionAttempt(client: PoolClient, context: TransactionContext, allowMissingTable = false, deadline?: number): Promise<{ result: JsonValue | null } | undefined> {
    try {
      const query = client.query<{ operation: string; result: JsonValue | null }>(`SELECT operation, result FROM ${this.storage.transactionAttempts} WHERE transaction_id = $1`, [context.transactionId]);
      const marker = deadline === undefined ? await query : await this.#beforeDeadline(query, deadline, "RT_RECONCILIATION_TIMEOUT");
      if (!marker.rowCount) return undefined;
      if (marker.rows[0]!.operation !== context.operation) throw new Error("RT_TRANSACTION_MARKER_OPERATION_MISMATCH");
      return { result: marker.rows[0]!.result };
    } catch (error) {
      if (allowMissingTable && errorCode(error, "") === "42P01") return undefined;
      throw error;
    }
  }

  async #reconcileTransactionMarker(context: TransactionContext, transaction: TransactionStateMachine, lockKey: string, deadline: number, allowMissingTable = false): Promise<"committed" | "rolled_back"> {
    transaction.transition("reconciling");
    this.#record({ kind: "database.transaction_reconciliation_started", boundary: "database.transaction_reconciliation_started", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, serialization: "pg_advisory_xact_lock" } });
    let client: PoolClient | undefined;
    let cleanupError: unknown | undefined;
    try {
      client = await this.#connectBefore(deadline);
      await this.#beforeDeadline(client.query("BEGIN"), deadline, "RT_RECONCILIATION_TIMEOUT");
      await this.#beforeDeadline(client.query("SELECT set_config('statement_timeout', $1, true)", [String(remainingMs(deadline))]), deadline, "RT_RECONCILIATION_TIMEOUT");
      await this.#beforeDeadline(client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]), deadline, "RT_RECONCILIATION_TIMEOUT");
      const marker = await this.#transactionAttempt(client, context, allowMissingTable, deadline);
      const resolution = marker ? "committed" : "rolled_back";
      transaction.transition("reconciled", resolution);
      this.#record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, resolution, proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
      return resolution;
    } catch (error) {
      if (transaction.state === "reconciling") transaction.transition("indeterminate");
      this.#record({ kind: "database.transaction_reconciliation_unresolved", boundary: "database.transaction_reconciliation_unresolved", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation: context.operation, state: transaction.state, timeoutMs: this.transactionOptions.reconciliationTimeoutMs, error: errorMessage(error) } });
      throw new TransactionOutcomeError(context, error);
    } finally {
      if (client) {
        cleanupError = await this.#rollbackCleanup(client, context, deadline);
        client.release(cleanupError ? (cleanupError instanceof Error ? cleanupError : true) : undefined);
      }
    }
  }

  async #markedWrite<T>(operation: TransactionContext["operation"], lockKey: string, work: (client: PoolClient) => Promise<T>, fields: Omit<TransactionContext, "transactionId" | "operation"> = {}): Promise<T> {
    lockKey = this.#lockKey(lockKey);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = transactionContext(this.storage.namespace, operation, { ...fields, operationCorrelationId: operationCorrelation(this.storage.namespace, { operation, lockKey }) });
      const transaction = new TransactionStateMachine();
      const client = await this.#connect();
      let released = false;
      let releaseError: unknown | undefined;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
        const value = await work(client);
        await this.#insertTransactionAttempt(client, context, value as JsonValue);
        await this.#commit(client, transaction, context);
        this.#record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation, proofSource: "commit_acknowledgement" } });
        return value;
      } catch (error) {
        const deadline = Date.now() + this.transactionOptions.reconciliationTimeoutMs;
        releaseError = await this.#rollbackCleanup(client, context, deadline);
        if (!(error instanceof CommitAttemptError)) {
          if (transaction.state === "pre_commit") this.#recordPreCommitRollback(transaction, context, error);
          throw new TransactionRolledBackError(context, error);
        }
        if (error.classification.state === "rolled_back") throw new TransactionRolledBackError(context, error.originalError);
        client.release(releaseError instanceof Error ? releaseError : true);
        released = true;
        const reconciled = await this.#withAdvisoryReconciliation<T>({ context, transaction, lockKey, deadline, inspect: async (_database, markerResult) => ({ resolution: "committed", value: markerResult as T }) });
        if (reconciled.resolution === "committed") {
          this.#record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", ...STORE_POSTGRES_EVIDENCE_COMPONENT, transactionId: context.transactionId, ...transactionCorrelation(context), details: { operation, proofSource: "durable_transaction_attempt_marker" } });
          return reconciled.value as T;
        }
        if (attempt === 1) throw new Error(`RT_${operation.toUpperCase()}_RECONCILED_ROLLBACK`);
      } finally {
        if (!released) client.release(releaseError ? (releaseError instanceof Error ? releaseError : true) : undefined);
      }
    }
    throw new Error(`RT_${operation.toUpperCase()}_RECONCILIATION_EXHAUSTED`);
  }

  #lockKey(value: string): string { return `${this.storage.namespace}:${value}`; }

  #connectBefore(deadline: number, code = "RT_RECONCILIATION_TIMEOUT"): Promise<PoolClient> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error(code)); } }, remainingMs(deadline));
      void this.pool.connect().then((rawClient) => {
        const client = this.#guardPoolClient(rawClient);
        if (settled) { client.release(); return; }
        settled = true;
        clearTimeout(timeout);
        resolve(client);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async #connect(): Promise<PoolClient> {
    return this.#guardPoolClient(await this.pool.connect());
  }

  #guardPoolClient(client: PoolClient): PoolClient {
    if (!guardedPoolClients.has(client)) {
      // node-postgres may emit a client-level error after rejecting the query
      // that observed a transport loss. Query provenance remains attached to
      // the rejected operation; this bounded listener only prevents a later
      // EventEmitter notification from becoming an uncaught process error.
      client.on("error", poolClientErrorSink);
      guardedPoolClients.add(client);
    }
    return client;
  }

  async #beforeDeadline<T>(operation: Promise<T>, deadline: number, code: string, onTimeout?: () => void): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => { timeout = setTimeout(() => { onTimeout?.(); reject(new Error(code)); }, remainingMs(deadline)); })]);
    } finally {
      if (timeout) clearTimeout(timeout);
      void operation.catch(() => undefined);
    }
  }

  async #eventById(client: PoolClient, tenantId: string, eventId: string): Promise<PostgresStoredEvent> {
    const result = await client.query(`SELECT tenant_id, stream, sequence, event_id, event_type, schema_name, data, append_operation_id, command_principal_namespace_id, command_id, occurred_at FROM ${this.storage.events} WHERE tenant_id = $1 AND event_id = $2`, [tenantId, eventId]);
    if (!result.rowCount) throw new Error("command points to a missing event");
    return rowToEvent(result.rows[0]);
  }

  async #headSequenceBefore(tenantId: string, stream: string, deadline: number): Promise<number> {
    const client = await this.#connectBefore(deadline);
    let releaseError: unknown | undefined;
    try {
      const result = await this.#beforeDeadline(client.query<{ sequence: string }>(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM ${this.storage.events} WHERE tenant_id = $1 AND stream = $2`, [tenantId, stream]), deadline, "RT_SNAPSHOT_FENCE_TIMEOUT");
      return Number(result.rows[0]!.sequence);
    } catch (error) {
      releaseError = error;
      throw error;
    } finally {
      client.release(releaseError instanceof Error ? releaseError : releaseError ? true : undefined);
    }
  }

  #record(input: RecordInput): void {
    try { this.recorder.record(input); }
    catch { /* stats retain explicit loss without changing an already committed database outcome */ }
  }
}

function operationLease(deadline: number): TransactionOperationLease & { revoke(): void } {
  let active = true;
  return Object.freeze({ deadline, isActive: () => active && Date.now() < deadline, revoke: () => { active = false; } });
}

function rowToEvent(row: Record<string, unknown>): PostgresStoredEvent {
  const tenantId = String(row.tenant_id);
  const stream = String(row.stream);
  const sequence = Number(row.sequence);
  const commandId = row.command_id ? String(row.command_id) : undefined;
  const commandPrincipalNamespaceId = row.command_principal_namespace_id ? String(row.command_principal_namespace_id) : undefined;
  const appendId = row.append_operation_id ? String(row.append_operation_id) : undefined;
  const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : new Date(String(row.occurred_at));
  return { tenantId, stream, sequence, cursor: cursor(tenantId, stream, sequence), eventId: String(row.event_id), type: String(row.event_type), schema: String(row.schema_name), data: row.data as JsonValue, ...(appendId ? { appendId } : {}), ...(commandPrincipalNamespaceId ? { commandPrincipalNamespaceId } : {}), ...(commandId ? { commandId } : {}), occurredAt: occurredAt.toISOString() };
}

function validateLimit(limit: number): void { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("RT_READ_LIMIT_INVALID"); }
function remainingMs(deadline: number): number { return Math.max(1, deadline - Date.now()); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown, fallback: string): string { return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string" ? String((error as Error & { code: string }).code) : error instanceof Error && error.message.startsWith("RT_") ? error.message : fallback; }
function postgresSqlstate(error: unknown): string | undefined { return error instanceof DatabaseError && typeof error.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : undefined; }
function transactionDetails(context: TransactionContext, details: Record<string, unknown>): Record<string, unknown> { return { ...(context.tenantId ? { tenantId: context.tenantId } : {}), ...details }; }
function transactionCorrelation(context: TransactionContext): Pick<RecordInput, "transactionOperation" | "operationCorrelationId" | "principalNamespaceId" | "commandId" | "eventId" | "stream" | "causalHandoffId"> {
  return { transactionOperation: context.operation, ...(context.operationCorrelationId ? { operationCorrelationId: context.operationCorrelationId } : {}), ...(context.principalNamespaceId ? { principalNamespaceId: context.principalNamespaceId } : {}), ...(context.commandId ? { commandId: context.commandId } : {}), ...(context.eventId ? { eventId: context.eventId } : {}), ...(context.stream ? { stream: context.stream } : {}), causalHandoffId: `transaction:${context.transactionId}` };
}
function operationCorrelation(storageNamespace: string, value: JsonValue): `opcorr:sha256:${string}` { return `opcorr:sha256:${createHash("sha256").update(canonicalJson({ storageNamespace, v: 1, value })).digest("hex")}`; }
function transactionContext(storageNamespace: string, operation: TransactionContext["operation"], fields: Omit<TransactionContext, "transactionId" | "operation"> = {}): TransactionContext {
  let derived = fields.operationCorrelationId;
  if (!derived && operation === "command" && fields.tenantId && fields.principalNamespaceId && fields.commandId) derived = operationCorrelation(storageNamespace, { operation, tenantId: fields.tenantId, principalNamespaceId: fields.principalNamespaceId, commandId: fields.commandId });
  if (!derived && operation === "append_event" && fields.tenantId && fields.appendId) derived = operationCorrelation(storageNamespace, { operation, tenantId: fields.tenantId, appendId: fields.appendId });
  if (!derived && operation === "snapshot_read" && fields.tenantId && fields.stream) derived = operationCorrelation(storageNamespace, { operation, tenantId: fields.tenantId, stream: fields.stream });
  return { transactionId: `tx_${randomUUID()}`, operation, ...fields, ...(derived ? { operationCorrelationId: derived } : {}) };
}
