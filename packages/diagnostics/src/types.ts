export type EvidenceOutcome = "success" | "failure" | "invariant_violation" | "unknown";
export type ProducerRole = "client" | "server" | "database" | "tool" | "unknown";
export const transactionOperations = ["schema_migration", "principal_namespace", "command", "append_event", "snapshot_read", "outbox_publish", "command_retention_cleanup", "outbox_retention_cleanup", "stream_retention"] as const;
export type TransactionOperation = (typeof transactionOperations)[number];

export interface EvidenceRecord {
  schemaVersion: "1.0";
  recordId: string;
  recordSequence: number;
  previousRecordHash?: `sha256:${string}`;
  kind: string;
  timestamp: string;
  monotonicNs: string;
  producerRole: ProducerRole;
  runtimeId: string;
  runtimeBootId: string;
  component: string;
  componentVersion: string;
  boundary?: string;
  outcome: EvidenceOutcome;
  reasonCode?: string;
  connectionId?: string;
  sessionId?: string;
  stream?: string;
  transactionId?: string;
  transactionOperation?: TransactionOperation;
  operationCorrelationId?: `opcorr:sha256:${string}`;
  principalNamespaceId?: string;
  commandId?: string;
  commandAttemptId?: string;
  eventId?: string;
  traceId?: string;
  causalHandoffId?: string;
  causalParentRecordId?: string;
  resourceId?: string;
  ownerId?: string;
  details?: Record<string, unknown>;
}

export interface CausalEdge {
  from: string;
  to: string;
  relation: "caused_by" | "retries" | "replays" | "produced" | "delivered_as" | "deduplicated_as" | "applied_as" | "supersedes" | "acknowledges";
}

export interface ResourceInventoryItem {
  resourceId: string;
  resourceType: string;
  ownerId: string;
  acquiredAt: string;
  state: "active" | "releasing" | "released" | "failed";
  bytes: number;
}

export interface DoctorIssue {
  code: string;
  severity: "info" | "warning" | "error";
  summary: string;
  lastSuccessfulBoundary: { status: "known"; value: string; evidence: string[] } | { status: "unknown"; reason: string };
  firstDivergentBoundary: { status: "known"; value: string; evidence: string[] } | { status: "unknown"; reason: string };
  component: string | null;
  componentVersion: string | null;
}

export interface DoctorEvidenceMatch extends ProducerInstance {
  purpose: "matched_boundary" | "divergent_boundary" | "transaction_indeterminate" | "reconciliation_proof";
  recordId: string;
  recordSequence: number;
  boundary: string;
  component: string;
  componentVersion: string;
  outcome: EvidenceOutcome;
  reasonCode?: string;
  transactionId?: string;
  transactionOperation?: TransactionOperation;
  operationCorrelationId?: `opcorr:sha256:${string}`;
  commandAttemptId?: string;
  eventId?: string;
  causalHandoffId?: string;
  causalParentRecordId?: string;
  proofSource?: string;
  resolution?: string;
}

export interface DoctorReport {
  schemaVersion: "1.0";
  verdict: "proven" | "disproven" | "indeterminate";
  expectedOutcome: string;
  actualOutcome: string;
  evidenceClosure: DoctorEvidenceMatch[];
  lastSuccessfulBoundary: DoctorIssue["lastSuccessfulBoundary"];
  firstDivergentBoundary: DoctorIssue["firstDivergentBoundary"];
  issues: DoctorIssue[];
  completeness: {
    status: "complete" | "partial";
    droppedRecords: number;
    evictedRecords: number;
    expectedProducers: ProducerRole[];
    observedProducers: ProducerRole[];
    missingProducers: ProducerRole[];
    expectedProducerInstances: ProducerInstance[];
    observedProducerInstances: ProducerInstance[];
    missingProducerInstances: ProducerInstance[];
  };
  scope: Partial<Pick<EvidenceRecord, "traceId" | "sessionId" | "stream" | "transactionId" | "operationCorrelationId" | "principalNamespaceId" | "commandId" | "commandAttemptId" | "eventId" | "causalHandoffId">>;
  producerRanges: Array<{ producerRole: ProducerRole; runtimeId: string; runtimeBootId: string; first: number; last: number; count: number }>;
}

export interface ExpectedBoundary {
  producerRole: ProducerRole;
  boundary: string;
  runtimeId?: string;
  runtimeBootId?: string;
}

export interface ProducerInstance {
  producerRole: ProducerRole;
  runtimeId: string;
  runtimeBootId: string;
}
