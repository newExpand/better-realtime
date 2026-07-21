import { DatabaseError, type PoolClient } from "pg";

export type TransactionOutcomeState =
  | "pre_commit"
  | "commit_in_flight"
  | "committed"
  | "rolled_back"
  | "indeterminate"
  | "reconciling"
  | "reconciled";

export type TransactionResolution = "committed" | "rolled_back" | "no_durable_effect";
export const TRANSACTION_OPERATIONS = [
  "schema_migration",
  "principal_namespace",
  "command",
  "append_event",
  "snapshot_read",
  "outbox_publish",
  "command_retention_cleanup",
  "outbox_retention_cleanup",
  "stream_retention"
] as const;
export type TransactionOperation = typeof TRANSACTION_OPERATIONS[number];

export interface TransactionContext {
  transactionId: string;
  operation: TransactionOperation;
  /** Non-reversible stable identity for one logical operation namespace. */
  operationCorrelationId?: `opcorr:sha256:${string}`;
  tenantId?: string;
  principalNamespaceId?: string;
  stream?: string;
  commandId?: string;
  eventId?: string;
  appendId?: string;
}

export type CommitExecutor = (client: PoolClient, context: Readonly<TransactionContext>) => Promise<void>;
export type RollbackExecutor = (client: PoolClient, context: Readonly<TransactionContext>) => Promise<void>;

export interface PostgresTransactionOptions {
  commit?: CommitExecutor;
  rollback?: RollbackExecutor;
  reconciliationTimeoutMs?: number;
  commitTimeoutMs?: number;
  operationTimeoutMs?: number;
  snapshotRetryLimit?: number;
}

export interface CommitFailureClassification {
  state: "rolled_back" | "indeterminate";
  proofSource: "postgres_error_response" | "commit_ack_unavailable";
  sqlstate?: string;
}

export class TransactionOutcomeError extends Error {
  readonly code = "RT_TRANSACTION_OUTCOME_INDETERMINATE";
  readonly state = "indeterminate" as const;

  constructor(readonly context: Readonly<TransactionContext>, readonly originalError: unknown) {
    super("RT_TRANSACTION_OUTCOME_INDETERMINATE", { cause: originalError });
    this.name = "TransactionOutcomeError";
  }
}

export class TransactionRolledBackError extends Error {
  readonly code = "RT_TRANSACTION_ROLLED_BACK";
  readonly state = "rolled_back" as const;

  constructor(readonly context: Readonly<TransactionContext>, readonly originalError: unknown) {
    super(errorMessage(originalError), { cause: originalError });
    this.name = "TransactionRolledBackError";
  }
}

export class CommitAttemptError extends Error {
  constructor(readonly classification: CommitFailureClassification, readonly originalError: unknown) {
    super(errorMessage(originalError), { cause: originalError });
    this.name = "CommitAttemptError";
  }
}

export class TransactionStateMachine {
  #state: TransactionOutcomeState = "pre_commit";
  #resolution: TransactionResolution | undefined;

  get state(): TransactionOutcomeState { return this.#state; }
  get resolution(): TransactionResolution | undefined { return this.#resolution; }

  transition(next: TransactionOutcomeState, resolution?: TransactionResolution): void {
    const allowed: Record<TransactionOutcomeState, readonly TransactionOutcomeState[]> = {
      pre_commit: ["commit_in_flight", "rolled_back"],
      commit_in_flight: ["committed", "rolled_back", "indeterminate"],
      committed: [],
      rolled_back: [],
      indeterminate: ["reconciling"],
      reconciling: ["reconciled", "indeterminate"],
      reconciled: []
    };
    if (!allowed[this.#state].includes(next)) throw new Error(`RT_TRANSACTION_STATE_INVALID:${this.#state}->${next}`);
    if (next === "reconciled" && !resolution) throw new Error("RT_TRANSACTION_RESOLUTION_REQUIRED");
    if (next !== "reconciled" && resolution) throw new Error("RT_TRANSACTION_RESOLUTION_UNEXPECTED");
    this.#state = next;
    this.#resolution = resolution;
  }
}

/**
 * Once COMMIT is invoked, pg's public API cannot prove whether a transport error
 * happened before or after PostgreSQL committed. Only a narrow PostgreSQL
 * ErrorResponse class that normatively aborts the transaction is conclusive.
 */
export function classifyCommitFailure(error: unknown): CommitFailureClassification {
  if (error instanceof DatabaseError && isAuthoritativeAbortSqlstate(error.code)) {
    return { state: "rolled_back", proofSource: "postgres_error_response", ...(error.code ? { sqlstate: error.code } : {}) };
  }
  const sqlstate = error instanceof DatabaseError ? error.code : undefined;
  return { state: "indeterminate", proofSource: "commit_ack_unavailable", ...(sqlstate ? { sqlstate } : {}) };
}

function isAuthoritativeAbortSqlstate(code: string | undefined): boolean {
  if (!code || code === "40003") return false;
  return code.startsWith("23") || code.startsWith("40");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
