export type DiagnosticProducerRole = "client" | "server" | "database" | "tool" | "unknown";
export const diagnosticTransactionOperations = ["schema_migration", "principal_namespace", "command", "append_event", "snapshot_read", "outbox_publish", "command_retention_cleanup", "outbox_retention_cleanup", "stream_retention"] as const;
export type DiagnosticTransactionOperation = (typeof diagnosticTransactionOperations)[number];

export interface DiagnosticProducerInstance {
  producerRole: DiagnosticProducerRole;
  runtimeId: string;
  runtimeBootId: string;
}

export interface SourceDiagnosticEvidenceRecord extends DiagnosticProducerInstance {
  schemaVersion: "1.0";
  recordId: string;
  recordSequence: number;
  previousRecordHash?: `sha256:${string}`;
  kind: string;
  timestamp: string;
  monotonicNs: string;
  component: string;
  componentVersion: string;
  outcome: "success" | "failure" | "invariant_violation" | "unknown";
  boundary?: string;
  reasonCode?: string;
  connectionId?: string;
  sessionId?: string;
  stream?: string;
  transactionId?: string;
  transactionOperation?: DiagnosticTransactionOperation;
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

/** Payload-redacted query output. Source hash chains never cross this boundary. */
export interface DiagnosticEvidenceRecord extends Omit<SourceDiagnosticEvidenceRecord, "previousRecordHash"> {}

export interface DiagnosticResource {
  resourceId: string;
  resourceType: string;
  ownerId: string;
  acquiredAt: string;
  state: "active" | "releasing" | "released" | "failed";
  bytes: number;
}

export interface DoctorQueryDefinition {
  expectedBoundaries: Array<{ producerRole: DiagnosticProducerRole; boundary: string; runtimeId?: string; runtimeBootId?: string }>;
  expectedProducers: DiagnosticProducerRole[];
  requireCausalHandoffs?: boolean;
  expectedOutcome: string;
  scope?: {
    traceId?: string;
    sessionId?: string;
    stream?: string;
    transactionId?: string;
    operationCorrelationId?: `opcorr:sha256:${string}`;
    principalNamespaceId?: string;
    commandId?: string;
    commandAttemptId?: string;
    eventId?: string;
    causalHandoffId?: string;
  };
}

export interface EvidenceBundleV1 {
  schemaVersion: "1.0";
  tenantId: string;
  payloadPolicy: "redacted";
  /** Source-only secret used to pseudonymize identifiers; it is never returned by query results. */
  pseudonymizationKey: string;
  records: Array<{ tenantId: string; record: SourceDiagnosticEvidenceRecord }>;
  resources?: DiagnosticResource[];
  resourceCapture: "complete" | "unavailable";
  resourceCaptureProof?: { captureId: string; capturedAt: string; inventoryCount: number; inventoryDigest: `sha256:${string}` };
  loss: { droppedRecords: number; evictedRecords: number };
  expectedProducerInstances: DiagnosticProducerInstance[];
  unavailableProducerInstances?: DiagnosticProducerInstance[];
  defaultDoctorQuery?: DoctorQueryDefinition;
}

interface DiagnosticPageRequest { tenantId: string; cursor?: string; limit?: number }
export type DiagnosticQueryRequest =
  | ({ kind: "raw_evidence"; filters?: Partial<Record<"boundary" | "stream" | "transactionId" | "operationCorrelationId" | "commandId" | "eventId" | "resourceId", string>> } & DiagnosticPageRequest)
  | ({ kind: "evidence_closure"; reference: string } & DiagnosticPageRequest)
  | ({ kind: "trace_command"; commandId: string } & DiagnosticPageRequest)
  | ({ kind: "inspect_stream"; stream: string } & DiagnosticPageRequest)
  | ({ kind: "leaks" } & DiagnosticPageRequest)
  | ({ kind: "doctor" } & DoctorQueryDefinition & { tenantId: string });

export const diagnosticQueryResultKinds = ["doctor", "trace_command", "inspect_stream", "leaks", "raw_evidence", "evidence_closure"] as const;
export type DiagnosticQueryResultKind = (typeof diagnosticQueryResultKinds)[number];

export interface DiagnosticProducerRange extends DiagnosticProducerInstance { first: number; last: number; count: number }
export interface DiagnosticQueryCompleteness {
  status: "complete" | "partial";
  droppedRecords: number;
  evictedRecords: number;
  expectedProducerInstances: DiagnosticProducerInstance[];
  observedProducerInstances: DiagnosticProducerInstance[];
  missingProducerInstances: DiagnosticProducerInstance[];
  sourceCoveredRanges: DiagnosticProducerRange[];
}
export interface DiagnosticQueryProvenance { source: "local_evidence_bundle"; payloadPolicy: "redacted"; redactedFields: number }
interface DiagnosticQueryResultBase<TKind extends DiagnosticQueryResultKind> {
  product: "Better Realtime";
  productVersion: string;
  component: "better-realtime";
  queryVersion: "1.0";
  schemaVersion: "1.0";
  tenantId: string;
  kind: TKind;
  completeness: DiagnosticQueryCompleteness;
  provenance: DiagnosticQueryProvenance;
}

interface DiagnosticPageResult<TKind extends "raw_evidence" | "trace_command" | "inspect_stream" | "evidence_closure"> extends DiagnosticQueryResultBase<TKind> {
  records: DiagnosticEvidenceRecord[];
  coveredRanges: DiagnosticProducerRange[];
  hasMore: boolean;
  omittedCount: number;
  nextCursor?: string;
}
export interface DiagnosticRawEvidenceResult extends DiagnosticPageResult<"raw_evidence"> {}
export interface DiagnosticTraceCommandResult extends DiagnosticPageResult<"trace_command"> { commandId: string }
export interface DiagnosticInspectStreamResult extends DiagnosticPageResult<"inspect_stream"> { stream: string }
export interface DiagnosticEvidenceReference { reference: string; recordCount: number }
export interface DiagnosticEvidenceClosureResult extends DiagnosticPageResult<"evidence_closure"> { evidenceReference: DiagnosticEvidenceReference }

export interface DiagnosticBoundaryFindingKnown { status: "known"; value: string; evidence: string[] }
export interface DiagnosticBoundaryFindingUnknown { status: "unknown"; reason: string }
export interface DiagnosticDoctorReport {
  schemaVersion: "1.0";
  verdict: "proven" | "disproven" | "indeterminate";
  expectedOutcome: string;
  actualOutcome: string;
  evidenceClosure: Array<DiagnosticProducerInstance & { purpose: "matched_boundary" | "divergent_boundary" | "transaction_indeterminate" | "reconciliation_proof"; recordId: string; recordSequence: number; boundary: string; component: string; componentVersion: string; outcome: "success" | "failure" | "invariant_violation" | "unknown"; reasonCode?: string; transactionId?: string; transactionOperation?: DiagnosticTransactionOperation; operationCorrelationId?: `opcorr:sha256:${string}`; commandAttemptId?: string; eventId?: string; causalHandoffId?: string; causalParentRecordId?: string; proofSource?: "postgres_error_response" | "commit_ack_unavailable" | "commit_acknowledgement" | "durable_transaction_attempt_marker" | "repeatable_read_read_only_discard_and_retry" | "commit_not_invoked" | "same_connection_rollback"; resolution?: "committed" | "rolled_back" | "no_durable_effect" }>;
  lastSuccessfulBoundary: DiagnosticBoundaryFindingKnown | DiagnosticBoundaryFindingUnknown;
  firstDivergentBoundary: DiagnosticBoundaryFindingKnown | DiagnosticBoundaryFindingUnknown;
  issues: Array<{ code: string; severity: "info" | "warning" | "error"; summary: string; lastSuccessfulBoundary: DiagnosticBoundaryFindingKnown | DiagnosticBoundaryFindingUnknown; firstDivergentBoundary: DiagnosticBoundaryFindingKnown | DiagnosticBoundaryFindingUnknown; component: string | null; componentVersion: string | null }>;
  completeness: { status: "complete" | "partial"; droppedRecords: number; evictedRecords: number; expectedProducers: DiagnosticProducerRole[]; observedProducers: DiagnosticProducerRole[]; missingProducers: DiagnosticProducerRole[]; expectedProducerInstances: DiagnosticProducerInstance[]; observedProducerInstances: DiagnosticProducerInstance[]; missingProducerInstances: DiagnosticProducerInstance[] };
  scope: NonNullable<DoctorQueryDefinition["scope"]>;
  producerRanges: DiagnosticProducerRange[];
}
export interface DiagnosticDoctorResult extends DiagnosticQueryResultBase<"doctor"> { report: DiagnosticDoctorReport; evidenceReference: DiagnosticEvidenceReference }
export interface DiagnosticResourceCaptureProof { captureId: string; capturedAt: string; inventoryCount: number; inventoryDigest: `sha256:${string}` }
export interface DiagnosticLeakResult extends DiagnosticQueryResultBase<"leaks"> {
  verdict: "proven" | "disproven" | "indeterminate";
  resourceCapture: "complete" | "unavailable";
  captureProof: "proven" | "missing";
  capture: DiagnosticResourceCaptureProof | null;
  active: DiagnosticResource[];
  failed: DiagnosticResource[];
  activeCount: number;
  failedCount: number;
  hasMore: boolean;
  omittedCount: number;
  nextCursor?: string;
}
export type DiagnosticQueryResult = DiagnosticDoctorResult | DiagnosticRawEvidenceResult | DiagnosticTraceCommandResult | DiagnosticInspectStreamResult | DiagnosticEvidenceClosureResult | DiagnosticLeakResult;
