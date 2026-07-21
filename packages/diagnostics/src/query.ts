import Ajv2020 from "ajv/dist/2020.js";
import { doctor as runDoctor, doctorReportSchemaV1, doctorSchemaDefs, type DoctorOptions } from "./doctor.ts";
import { keyedStableDigest } from "./hash.ts";
import { transactionOperations, type DoctorReport, type EvidenceRecord, type ProducerInstance, type ProducerRole, type ResourceInventoryItem } from "./types.ts";

export const DIAGNOSTIC_QUERY_VERSION = "1.0" as const;
export const LOCAL_EVIDENCE_BUNDLE_SCHEMA_VERSION = "1.0" as const;
export const DIAGNOSTIC_PRODUCT = "Better Realtime" as const;
export const DIAGNOSTIC_PRODUCT_VERSION: string = "0.1.0-alpha.1";
export const DIAGNOSTIC_COMPONENT = "better-realtime" as const;
const MAX_QUERY_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_STRING_BYTES = 512;
const MAX_CURSOR_BYTES = 4_096;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_PAGE_CONTENT_BYTES = 48 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_DETAIL_DEPTH = 8;
const MAX_DETAIL_ENTRIES = 64;
const MAX_EVIDENCE_CLOSURES = 32;

export interface TenantEvidenceRecord {
  tenantId: string;
  record: EvidenceRecord;
}

export interface LocalEvidenceBundleV1 {
  schemaVersion: "1.0";
  tenantId: string;
  payloadPolicy: "redacted";
  pseudonymizationKey: string;
  records: readonly TenantEvidenceRecord[];
  resources?: readonly ResourceInventoryItem[];
  resourceCapture: "complete" | "unavailable";
  resourceCaptureProof?: ResourceCaptureProof;
  loss: { droppedRecords: number; evictedRecords: number };
  expectedProducerInstances: readonly ProducerInstance[];
  unavailableProducerInstances?: readonly ProducerInstance[];
  defaultDoctorQuery?: Omit<DoctorQueryRequest, "kind" | "tenantId">;
}

export interface ResourceCaptureProof {
  captureId: string;
  capturedAt: string;
  inventoryCount: number;
  inventoryDigest: `sha256:${string}`;
}

export const localEvidenceBundleSchemaV1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "tenantId", "payloadPolicy", "pseudonymizationKey", "records", "resourceCapture", "loss", "expectedProducerInstances"],
  properties: {
    schemaVersion: { const: "1.0" },
    tenantId: { type: "string", minLength: 1, maxLength: 512 },
    payloadPolicy: { const: "redacted" },
    pseudonymizationKey: { type: "string", minLength: 32, maxLength: 512 },
    records: { type: "array", maxItems: 100_000, items: { type: "object", additionalProperties: false, required: ["tenantId", "record"], properties: {
      tenantId: { type: "string", minLength: 1, maxLength: 512 },
      record: { $ref: "#/$defs/evidenceRecord" }
    } } },
    resources: { type: "array", maxItems: 10_000, items: { type: "object", additionalProperties: false, required: ["resourceId", "resourceType", "ownerId", "acquiredAt", "state", "bytes"], properties: { resourceId: { type: "string", minLength: 1, maxLength: 512 }, resourceType: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, ownerId: { type: "string", minLength: 1, maxLength: 512 }, acquiredAt: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" }, state: { enum: ["active", "releasing", "released", "failed"] }, bytes: { type: "number", minimum: 0 } } } },
    resourceCapture: { enum: ["complete", "unavailable"] },
    resourceCaptureProof: { $ref: "#/$defs/resourceCaptureProof" },
    loss: { type: "object", additionalProperties: false, required: ["droppedRecords", "evictedRecords"], properties: { droppedRecords: { type: "integer", minimum: 0 }, evictedRecords: { type: "integer", minimum: 0 } } },
    expectedProducerInstances: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, items: { $ref: "#/$defs/producerInstance" } },
    unavailableProducerInstances: { type: "array", maxItems: 256, uniqueItems: true, items: { $ref: "#/$defs/producerInstance" } },
    defaultDoctorQuery: { $ref: "#/$defs/doctorQuery" }
  },
  $defs: {
    producerInstance: { type: "object", additionalProperties: false, required: ["producerRole", "runtimeId", "runtimeBootId"], properties: { producerRole: { enum: ["client", "server", "database", "tool", "unknown"] }, runtimeId: { type: "string", minLength: 1, maxLength: 512 }, runtimeBootId: { type: "string", minLength: 1, maxLength: 512 } } },
    doctorQuery: { type: "object", additionalProperties: false, required: ["expectedBoundaries", "expectedProducers", "expectedOutcome"], properties: {
      expectedBoundaries: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "object", additionalProperties: false, required: ["producerRole", "boundary"], properties: { producerRole: { enum: ["client", "server", "database", "tool", "unknown"] }, boundary: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, runtimeId: { type: "string", minLength: 1, maxLength: 512 }, runtimeBootId: { type: "string", minLength: 1, maxLength: 512 } } } },
      expectedProducers: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: ["client", "server", "database", "tool", "unknown"] } },
      requireCausalHandoffs: { type: "boolean" },
      expectedOutcome: { type: "string", minLength: 1, maxLength: 256 },
      scope: { type: "object", additionalProperties: false, properties: { traceId: { type: "string", maxLength: 512 }, sessionId: { type: "string", maxLength: 512 }, stream: { type: "string", maxLength: 512 }, transactionId: { type: "string", maxLength: 512 }, operationCorrelationId: { type: "string", pattern: "^opcorr:sha256:[a-f0-9]{64}$" }, principalNamespaceId: { type: "string", maxLength: 512 }, commandId: { type: "string", maxLength: 512 }, commandAttemptId: { type: "string", maxLength: 512 }, eventId: { type: "string", maxLength: 512 }, causalHandoffId: { type: "string", maxLength: 512 } } }
    } },
    resourceCaptureProof: { type: "object", additionalProperties: false, required: ["captureId", "capturedAt", "inventoryCount", "inventoryDigest"], properties: { captureId: { type: "string", pattern: "^capture[-_:][A-Za-z0-9_-]{1,96}$" }, capturedAt: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" }, inventoryCount: { type: "integer", minimum: 0 }, inventoryDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } } },
    evidenceRecord: { type: "object", additionalProperties: false, required: ["schemaVersion", "recordId", "recordSequence", "kind", "timestamp", "monotonicNs", "producerRole", "runtimeId", "runtimeBootId", "component", "componentVersion", "outcome"], properties: { schemaVersion: { const: "1.0" }, recordId: { type: "string", minLength: 1, maxLength: 512 }, recordSequence: { type: "integer", minimum: 1 }, previousRecordHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, kind: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, timestamp: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" }, monotonicNs: { type: "string", pattern: "^[0-9]{1,32}$" }, producerRole: { enum: ["client", "server", "database", "tool", "unknown"] }, runtimeId: { type: "string", minLength: 1, maxLength: 512 }, runtimeBootId: { type: "string", minLength: 1, maxLength: 512 }, component: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, componentVersion: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$" }, boundary: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, outcome: { enum: ["success", "failure", "invariant_violation", "unknown"] }, reasonCode: { type: "string", pattern: "^RT_[A-Z0-9_]{1,96}$" }, connectionId: { type: "string", maxLength: 512 }, sessionId: { type: "string", maxLength: 512 }, stream: { type: "string", maxLength: 512 }, transactionId: { type: "string", maxLength: 512 }, transactionOperation: { enum: transactionOperations }, operationCorrelationId: { type: "string", pattern: "^opcorr:sha256:[a-f0-9]{64}$" }, principalNamespaceId: { type: "string", maxLength: 512 }, commandId: { type: "string", maxLength: 512 }, commandAttemptId: { type: "string", maxLength: 512 }, eventId: { type: "string", maxLength: 512 }, traceId: { type: "string", maxLength: 512 }, causalHandoffId: { type: "string", maxLength: 512 }, causalParentRecordId: { type: "string", maxLength: 512 }, resourceId: { type: "string", maxLength: 512 }, ownerId: { type: "string", maxLength: 512 }, details: { type: "object", maxProperties: 256 } } }
  },
  allOf: [
    { if: { properties: { resourceCapture: { const: "complete" } }, required: ["resourceCapture"] }, then: { required: ["resourceCaptureProof"] } },
    { if: { properties: { resourceCapture: { const: "unavailable" } }, required: ["resourceCapture"] }, then: { not: { required: ["resourceCaptureProof"] } } }
  ]
} as const;

const validateBundle = new Ajv2020({ strict: false }).compile<LocalEvidenceBundleV1>(localEvidenceBundleSchemaV1);

const safeDetailKeyNames = [
  "action", "actual", "after", "appendId", "attempt", "bufferedAmount", "bytes", "capabilities", "capability", "catchup", "causalEventIds", "causalEventPositions", "captureId", "capturedAt", "claimed", "code", "commandId", "connectionId", "consumers", "count", "crashPoint", "cursor", "cursorSequence", "delay", "delivered", "deliveryId", "deliveryMode", "duplicate", "durableSuccessClaimed", "effectSchema", "event", "eventId", "eventSequence", "existenceExposed", "expected", "expectedDirection", "expectedSequence", "failureProvenance", "first", "from", "handoffReason", "head", "headSequence", "idempotency", "idempotencyRetentionMs", "index", "intentHash", "intentHashVersion", "inventoryCount", "inventoryDigest", "isolation", "kind", "last", "listenerDeliveryClaimed", "maxBufferedBytes", "maxBytes", "maxMessageBytes", "maxOutboundBufferedBytes", "maxRecords", "mode", "nextBytes", "nextMessageBytes", "nextRecords", "observer", "operation", "outboxId", "outboxIds", "outcome", "outcomeProof", "ownerId", "pages", "pingId", "principalNamespaceId", "producerClaimed", "projectedSequence", "proof", "proofSource", "provenance", "rawIdentityCaptured", "rawIssuerCaptured", "rawSubjectCaptured", "reason", "received", "receivedSequence", "recordSequence", "requestId", "requestedAfter", "resolution", "resourceId", "resourceType", "response", "resumeStatus", "retryable", "runtimeBootId", "runtimeId", "schema", "sequence", "serialization", "sessionGeneration", "sessionId", "snapshotBytes", "snapshotRequested", "snapshotSequence", "socketWritableBytes", "sqlstate", "state", "status", "stream", "tenantId", "through", "throughSequence", "timeoutMs", "to", "traceId", "transactionId", "type", "wireState",
  "durableReplay", "idempotentCommands", "commandReceipts", "fencedSnapshots", "commandResultRetentionMs", "replayRetentionMs", "maxRecoveryBufferBytes", "maxRecoveryBufferRecords", "observerPrincipalNamespaceId"
] as const;
const publicPseudonym = { type: "string", pattern: "^pseudonym:sha256:[a-f0-9]{64}$" } as const;
const publicOperationCorrelation = { type: "string", pattern: "^opcorr:sha256:[a-f0-9]{64}$" } as const;
const redactedValue = { const: "[REDACTED]" } as const;
const proofSources = ["postgres_error_response", "commit_ack_unavailable", "commit_acknowledgement", "durable_transaction_attempt_marker", "repeatable_read_read_only_discard_and_retry", "commit_not_invoked", "same_connection_rollback"] as const;
const resolutions = ["committed", "rolled_back", "no_durable_effect"] as const;
const serializations = ["fresh_repeatable_read_read_only_attempt", "outbox_row_lock", "pg_advisory_xact_lock", "command_advisory_lock"] as const;
const diagnosticStates = ["absent", "accepted", "active", "backing_off", "cancelled", "closed", "commit_in_flight", "committed", "completed", "connecting", "created", "disposed", "disposing", "expired", "failed", "idle", "indeterminate", "live", "observed", "open", "opening", "pre_commit", "queued", "ready", "reauthenticating", "reconciled", "reconciling", "rejected", "replaying", "resyncing", "rolled_back", "sent", "subscribing", "suspended", "unknown"] as const;
const publicSafeString = { anyOf: [redactedValue, publicPseudonym, publicOperationCorrelation, { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, { type: "string", pattern: "^RT_[A-Z0-9_]{1,96}$" }, { type: "string", pattern: "^[0-9A-Z]{5}$" }, { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" }, { type: "string", pattern: "^capture[-_:][A-Za-z0-9_-]{1,96}$" }, { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,79}@[1-9][0-9]*$" }, { enum: [...transactionOperations, ...proofSources, ...resolutions, ...serializations, ...diagnosticStates, "command_status", "gateway_health_or_durable_operation", "harness_pool_idle_connection", "authoritative_abort", "application", "database", "gateway_observer", "rollback", "replay", "fenced_snapshot", "destroy_connection", "snapshot_catchup"] }] } as const;
const publicSafeDetailProperties = Object.fromEntries(safeDetailKeyNames.map((key) => [key, { $ref: "#/$defs/safeDetailValue" }])) as Record<string, unknown>;
for (const key of ["proofSource"] as const) publicSafeDetailProperties[key] = { anyOf: [redactedValue, { enum: proofSources }] };
for (const key of ["resolution"] as const) publicSafeDetailProperties[key] = { anyOf: [redactedValue, { enum: resolutions }] };
for (const key of ["serialization"] as const) publicSafeDetailProperties[key] = { anyOf: [redactedValue, { enum: serializations }] };
for (const key of ["operation"] as const) publicSafeDetailProperties[key] = { anyOf: [redactedValue, { enum: [...transactionOperations, "command_status", "gateway_health_or_durable_operation", "harness_pool_idle_connection"] }] };
for (const key of ["state", "status", "wireState"] as const) publicSafeDetailProperties[key] = { anyOf: [redactedValue, { enum: diagnosticStates }] };
publicSafeDetailProperties.action = { anyOf: [redactedValue, { enum: ["rollback", "replay", "fenced_snapshot", "destroy_connection"] }] };
publicSafeDetailProperties.deliveryMode = { anyOf: [redactedValue, { enum: ["live", "replay", "snapshot_catchup"] }] };
publicSafeDetailProperties.outcomeProof = { anyOf: [redactedValue, { type: "boolean" }] };
const publicEvidenceRecordSchema = { type: "object", additionalProperties: false, required: ["schemaVersion", "recordId", "recordSequence", "kind", "timestamp", "monotonicNs", "producerRole", "runtimeId", "runtimeBootId", "component", "componentVersion", "outcome"], properties: { schemaVersion: { const: "1.0" }, recordId: publicPseudonym, recordSequence: { type: "integer", minimum: 1 }, kind: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, timestamp: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" }, monotonicNs: { type: "string", pattern: "^[0-9]{1,32}$" }, producerRole: { enum: ["client", "server", "database", "tool", "unknown"] }, runtimeId: publicPseudonym, runtimeBootId: publicPseudonym, component: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, componentVersion: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$" }, boundary: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" }, outcome: { enum: ["success", "failure", "invariant_violation", "unknown"] }, reasonCode: { type: "string", pattern: "^RT_[A-Z0-9_]{1,96}$" }, connectionId: publicPseudonym, sessionId: publicPseudonym, stream: publicPseudonym, transactionId: publicPseudonym, transactionOperation: { enum: transactionOperations }, operationCorrelationId: publicOperationCorrelation, principalNamespaceId: publicPseudonym, commandId: publicPseudonym, commandAttemptId: publicPseudonym, eventId: publicPseudonym, traceId: publicPseudonym, causalHandoffId: publicPseudonym, causalParentRecordId: publicPseudonym, resourceId: publicPseudonym, ownerId: publicPseudonym, details: { $ref: "#/$defs/safeDetailObject" } } } as const;
const publicProducerInstance = { type: "object", additionalProperties: false, required: ["producerRole", "runtimeId", "runtimeBootId"], properties: { producerRole: { $ref: "#/$defs/producerRole" }, runtimeId: publicPseudonym, runtimeBootId: publicPseudonym } } as const;
const publicBoundaryFinding = { oneOf: [{ type: "object", additionalProperties: false, required: ["status", "value", "evidence"], properties: { status: { const: "known" }, value: { type: "string" }, evidence: { type: "array", minItems: 1, items: publicPseudonym } } }, { type: "object", additionalProperties: false, required: ["status", "reason"], properties: { status: { const: "unknown" }, reason: { type: "string" } } }] } as const;
const publicEvidenceMatch = { ...doctorSchemaDefs.evidenceMatch, properties: { ...doctorSchemaDefs.evidenceMatch.properties, recordId: publicPseudonym, runtimeId: publicPseudonym, runtimeBootId: publicPseudonym, transactionId: publicPseudonym, operationCorrelationId: publicOperationCorrelation, commandAttemptId: publicPseudonym, eventId: publicPseudonym, causalHandoffId: publicPseudonym, causalParentRecordId: publicPseudonym } } as const;
const publicDoctorReportSchema = { ...doctorReportSchemaV1, properties: { ...doctorReportSchemaV1.properties, scope: { type: "object", additionalProperties: false, properties: { traceId: publicPseudonym, sessionId: publicPseudonym, stream: publicPseudonym, transactionId: publicPseudonym, operationCorrelationId: publicOperationCorrelation, principalNamespaceId: publicPseudonym, commandId: publicPseudonym, commandAttemptId: publicPseudonym, eventId: publicPseudonym, causalHandoffId: publicPseudonym } } } } as const;

export const diagnosticQueryResultSchemaV1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["product", "productVersion", "component", "queryVersion", "schemaVersion", "tenantId", "kind", "completeness", "provenance"],
  properties: {
    product: { const: DIAGNOSTIC_PRODUCT },
    productVersion: { type: "string", pattern: "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+(?:[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$" },
    component: { const: DIAGNOSTIC_COMPONENT },
    queryVersion: { const: "1.0" },
    schemaVersion: { const: "1.0" },
    tenantId: publicPseudonym,
    kind: { enum: ["doctor", "trace_command", "inspect_stream", "leaks", "raw_evidence", "evidence_closure"] },
    completeness: { type: "object", additionalProperties: false, required: ["status", "droppedRecords", "evictedRecords", "expectedProducerInstances", "observedProducerInstances", "missingProducerInstances", "sourceCoveredRanges"], properties: { status: { enum: ["complete", "partial"] }, droppedRecords: { type: "integer", minimum: 0 }, evictedRecords: { type: "integer", minimum: 0 }, expectedProducerInstances: { type: "array", items: { $ref: "#/$defs/producerInstance" } }, observedProducerInstances: { type: "array", items: { $ref: "#/$defs/producerInstance" } }, missingProducerInstances: { type: "array", items: { $ref: "#/$defs/producerInstance" } }, sourceCoveredRanges: { type: "array", items: { $ref: "#/$defs/producerRange" } } } },
    provenance: { type: "object", additionalProperties: false, required: ["source", "payloadPolicy", "redactedFields"], properties: { source: { const: "local_evidence_bundle" }, payloadPolicy: { const: "redacted" }, redactedFields: { type: "integer", minimum: 0 } } },
    report: { $ref: "#/$defs/doctorReport" },
    evidenceReference: { type: "object", additionalProperties: false, required: ["reference", "recordCount"], properties: { reference: { type: "string", pattern: "^dqc1\\.sha256:[a-f0-9]{64}$" }, recordCount: { type: "integer", minimum: 0, maximum: 256 } } },
    records: { type: "array", items: { $ref: "#/$defs/evidenceRecord" } },
    coveredRanges: { type: "array", items: { $ref: "#/$defs/producerRange" } },
    hasMore: { type: "boolean" }, omittedCount: { type: "integer", minimum: 0 }, nextCursor: { type: "string", minLength: 1, maxLength: 4096 },
    commandId: publicPseudonym, stream: publicPseudonym,
    verdict: { enum: ["proven", "disproven", "indeterminate"] }, resourceCapture: { enum: ["complete", "unavailable"] }, captureProof: { enum: ["proven", "missing"] }, capture: { oneOf: [{ $ref: "#/$defs/resourceCaptureProof" }, { type: "null" }] },
    active: { type: "array", items: { $ref: "#/$defs/resource" } }, failed: { type: "array", items: { $ref: "#/$defs/resource" } }, activeCount: { type: "integer", minimum: 0 }, failedCount: { type: "integer", minimum: 0 }
  },
  oneOf: [
    { properties: { kind: { const: "doctor" } }, required: ["report", "evidenceReference"], not: { anyOf: [{ required: ["records"] }, { required: ["verdict"] }] } },
    { properties: { kind: { const: "raw_evidence" } }, required: ["records", "coveredRanges", "hasMore", "omittedCount"], not: { anyOf: [{ required: ["report"] }, { required: ["verdict"] }, { required: ["commandId"] }, { required: ["stream"] }] } },
    { properties: { kind: { const: "trace_command" } }, required: ["records", "coveredRanges", "hasMore", "omittedCount", "commandId"], not: { anyOf: [{ required: ["report"] }, { required: ["verdict"] }, { required: ["stream"] }] } },
    { properties: { kind: { const: "inspect_stream" } }, required: ["records", "coveredRanges", "hasMore", "omittedCount", "stream"], not: { anyOf: [{ required: ["report"] }, { required: ["verdict"] }, { required: ["commandId"] }] } },
    { properties: { kind: { const: "evidence_closure" } }, required: ["records", "coveredRanges", "hasMore", "omittedCount", "evidenceReference"], not: { anyOf: [{ required: ["report"] }, { required: ["verdict"] }, { required: ["commandId"] }, { required: ["stream"] }] } },
    { properties: { kind: { const: "leaks" } }, required: ["verdict", "resourceCapture", "captureProof", "capture", "active", "failed", "activeCount", "failedCount", "hasMore", "omittedCount"], not: { anyOf: [{ required: ["report"] }, { required: ["records"] }, { required: ["commandId"] }, { required: ["stream"] }] } }
  ],
  $defs: {
    ...doctorSchemaDefs,
    producerInstance: publicProducerInstance,
    producerRange: { ...doctorSchemaDefs.producerRange, properties: { ...doctorSchemaDefs.producerRange.properties, runtimeId: publicPseudonym, runtimeBootId: publicPseudonym } },
    boundaryFinding: publicBoundaryFinding,
    evidenceMatch: publicEvidenceMatch,
    safeDetailValue: { oneOf: [publicSafeString, { type: "number", minimum: -9007199254740991, maximum: 9007199254740991 }, { type: "boolean" }, { type: "null" }, { type: "array", maxItems: 64, items: { $ref: "#/$defs/safeDetailValue" } }, { $ref: "#/$defs/safeDetailObject" }] },
    safeDetailObject: { type: "object", additionalProperties: false, maxProperties: 64, properties: publicSafeDetailProperties },
    resource: { type: "object", additionalProperties: false, required: ["resourceId", "resourceType", "ownerId", "acquiredAt", "state", "bytes"], properties: { resourceId: publicPseudonym, resourceType: { type: "string", maxLength: 128 }, ownerId: publicPseudonym, acquiredAt: { type: "string", maxLength: 64 }, state: { enum: ["active", "releasing", "released", "failed"] }, bytes: { type: "number", minimum: 0 } } },
    resourceCaptureProof: { type: "object", additionalProperties: false, required: ["captureId", "capturedAt", "inventoryCount", "inventoryDigest"], properties: { captureId: { type: "string", pattern: "^capture[-_:][A-Za-z0-9_-]{1,96}$" }, capturedAt: { type: "string", maxLength: 64 }, inventoryCount: { type: "integer", minimum: 0 }, inventoryDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } } },
    evidenceRecord: publicEvidenceRecordSchema,
    doctorReport: publicDoctorReportSchema
  }
} as const;

const validateQueryResult = new Ajv2020({ strict: false }).compile(diagnosticQueryResultSchemaV1);

export interface QueryCompleteness {
  status: "complete" | "partial";
  droppedRecords: number;
  evictedRecords: number;
  expectedProducerInstances: ProducerInstance[];
  observedProducerInstances: ProducerInstance[];
  missingProducerInstances: ProducerInstance[];
  sourceCoveredRanges: ProducerRange[];
}

export interface ProducerRange extends ProducerInstance { first: number; last: number; count: number }
export interface QueryProvenance { source: "local_evidence_bundle"; payloadPolicy: "redacted"; redactedFields: number }

interface QueryBase {
  product: typeof DIAGNOSTIC_PRODUCT;
  productVersion: string;
  component: typeof DIAGNOSTIC_COMPONENT;
  queryVersion: "1.0";
  schemaVersion: "1.0";
  tenantId: string;
  kind: string;
  completeness: QueryCompleteness;
  provenance: QueryProvenance;
}

interface PageRequest { tenantId: string; cursor?: string; limit?: number }
export interface RawEvidenceRequest extends PageRequest { kind?: "raw_evidence"; filters?: Partial<Pick<EvidenceRecord, "boundary" | "stream" | "transactionId" | "operationCorrelationId" | "commandId" | "eventId" | "resourceId">> }
export interface EvidenceClosureRequest extends PageRequest { kind?: "evidence_closure"; reference: string }
export interface TraceCommandRequest extends PageRequest { kind?: "trace_command"; commandId: string }
export interface InspectStreamRequest extends PageRequest { kind?: "inspect_stream"; stream: string }
export interface LeaksRequest extends PageRequest { kind?: "leaks" }
export interface DoctorQueryRequest extends Omit<DoctorOptions, "records" | "droppedRecords" | "evictedRecords" | "expectedProducerInstances" | "unavailableProducerInstances"> { kind?: "doctor"; tenantId: string }

export type DiagnosticQueryRequest =
  | ({ kind: "raw_evidence" } & RawEvidenceRequest)
  | ({ kind: "evidence_closure" } & EvidenceClosureRequest)
  | ({ kind: "trace_command" } & TraceCommandRequest)
  | ({ kind: "inspect_stream" } & InspectStreamRequest)
  | ({ kind: "leaks" } & LeaksRequest)
  | ({ kind: "doctor" } & DoctorQueryRequest);

export interface EvidencePage extends QueryBase {
  records: EvidenceRecord[];
  coveredRanges: ProducerRange[];
  hasMore: boolean;
  omittedCount: number;
  nextCursor?: string;
}

export interface LeakReport extends QueryBase {
  verdict: "proven" | "disproven" | "indeterminate";
  resourceCapture: "complete" | "unavailable";
  captureProof: "proven" | "missing";
  capture: ResourceCaptureProof | null;
  active: ResourceInventoryItem[];
  failed: ResourceInventoryItem[];
  activeCount: number;
  failedCount: number;
  hasMore: boolean;
  omittedCount: number;
  nextCursor?: string;
}

export interface EvidenceReference { reference: string; recordCount: number }
export interface DoctorQueryResult extends QueryBase { report: DoctorReport; evidenceReference: EvidenceReference }

export class LocalDiagnosticQuery {
  readonly #bundle: LocalEvidenceBundleV1;
  readonly #records: EvidenceRecord[];
  readonly #resources: ResourceInventoryItem[];
  readonly #sourceDigest: `sha256:${string}`;
  readonly #pseudonymizationKey: string;
  readonly #tenantId: string;
  readonly #hiddenRedactions = new Map<string, number>();
  readonly #evidenceClosures = new Map<string, readonly EvidenceRecord[]>();

  constructor(bundle: LocalEvidenceBundleV1) {
    if (!validateBundle(bundle)) throw new Error(`RT_DIAGNOSTIC_BUNDLE_INVALID:${JSON.stringify(validateBundle.errors)}`);
    const recordIds = new Set<string>();
    const producerSequences = new Set<string>();
    for (const entry of bundle.records) {
      if (entry.tenantId !== bundle.tenantId) throw new Error("RT_DIAGNOSTIC_TENANT_MISMATCH");
      if (typeof entry.record.details?.tenantId === "string" && entry.record.details.tenantId !== bundle.tenantId) throw new Error("RT_DIAGNOSTIC_TENANT_MISMATCH");
      if (typeof entry.record.principalNamespaceId === "string" && typeof entry.record.details?.principalNamespaceId === "string" && entry.record.principalNamespaceId !== entry.record.details.principalNamespaceId) throw new Error("RT_DIAGNOSTIC_BUNDLE_INVALID");
      const sequenceKey = `${instanceKey(entry.record)}\u0000${entry.record.recordSequence}`;
      if (recordIds.has(entry.record.recordId) || producerSequences.has(sequenceKey)) throw new Error("RT_DIAGNOSTIC_BUNDLE_INVALID");
      recordIds.add(entry.record.recordId);
      producerSequences.add(sequenceKey);
    }
    this.#tenantId = bundle.tenantId;
    this.#pseudonymizationKey = bundle.pseudonymizationKey;
    this.#bundle = {
      schemaVersion: bundle.schemaVersion,
      tenantId: pseudonymizeIdentifier(bundle.tenantId, this.#pseudonymizationKey),
      payloadPolicy: bundle.payloadPolicy,
      pseudonymizationKey: bundle.pseudonymizationKey,
      records: [],
      ...(bundle.resources ? { resources: bundle.resources.map((resource) => ({ ...resource })) } : {}),
      resourceCapture: bundle.resourceCapture,
      ...(bundle.resourceCaptureProof ? { resourceCaptureProof: { ...bundle.resourceCaptureProof } } : {}),
      loss: { ...bundle.loss },
      expectedProducerInstances: bundle.expectedProducerInstances.map((instance) => normalizeProducerInstance(instance, this.#pseudonymizationKey)),
      ...(bundle.unavailableProducerInstances ? { unavailableProducerInstances: bundle.unavailableProducerInstances.map((instance) => normalizeProducerInstance(instance, this.#pseudonymizationKey)) } : {}),
      ...(bundle.defaultDoctorQuery ? { defaultDoctorQuery: { ...bundle.defaultDoctorQuery, expectedBoundaries: bundle.defaultDoctorQuery.expectedBoundaries.map((boundary) => ({ ...boundary })), expectedProducers: [...bundle.defaultDoctorQuery.expectedProducers], ...(bundle.defaultDoctorQuery.scope ? { scope: { ...bundle.defaultDoctorQuery.scope } } : {}) } } : {})
    };
    this.#records = [...bundle.records.map((entry) => {
      const redaction = { count: 0 };
      const record = redactEvidenceRecord(entry.record, this.#pseudonymizationKey, redaction);
      this.#hiddenRedactions.set(record.recordId, Math.max(0, redaction.count - countRedactedFields(record)));
      return record;
    })].sort(compareRecords);
    this.#resources = [...(bundle.resources ?? []).map((resource) => redactResource(resource, this.#pseudonymizationKey))].sort((left, right) => left.resourceId.localeCompare(right.resourceId));
    this.#sourceDigest = sourceSnapshotDigest(bundle, this.#pseudonymizationKey);
  }

  query(request: DiagnosticQueryRequest): EvidencePage | LeakReport | DoctorQueryResult {
    if (!request || typeof request !== "object" || !("kind" in request)) throw new Error("RT_DIAGNOSTIC_CONCLUSION_UNSUPPORTED");
    switch (request.kind) {
      case "raw_evidence": assertQueryShape(request, ["kind", "tenantId", "cursor", "limit", "filters"]); assertFilters(request.filters); return this.rawEvidence(request);
      case "evidence_closure": assertQueryShape(request, ["kind", "tenantId", "cursor", "limit", "reference"]); return this.evidenceClosure(request);
      case "trace_command": assertQueryShape(request, ["kind", "tenantId", "cursor", "limit", "commandId"]); return this.traceCommand(request);
      case "inspect_stream": assertQueryShape(request, ["kind", "tenantId", "cursor", "limit", "stream"]); return this.inspectStream(request);
      case "leaks": assertQueryShape(request, ["kind", "tenantId", "cursor", "limit"]); return this.leaks(request);
      case "doctor": assertQueryShape(request, ["kind", "tenantId", "expectedBoundaries", "expectedProducers", "requireCausalHandoffs", "expectedOutcome", "scope"]); return this.doctor(request);
      default: throw new Error("RT_DIAGNOSTIC_CONCLUSION_UNSUPPORTED");
    }
  }

  rawEvidence(request: RawEvidenceRequest): EvidencePage {
    this.#assertTenant(request.tenantId);
    assertFilters(request.filters);
    const filters = normalizeFilters(request.filters ?? {}, this.#pseudonymizationKey);
    const records = this.#records.filter((record) => Object.entries(filters).every(([key, value]) => value === undefined || record[key as keyof EvidenceRecord] === value));
    return assertQueryResult(this.#evidencePage("raw_evidence", request, records, stableSignature("raw_evidence", filters, this.#sourceDigest)));
  }

  evidenceClosure(request: EvidenceClosureRequest): EvidencePage & { evidenceReference: EvidenceReference } {
    this.#assertTenant(request.tenantId);
    assertQueryString(request.reference, "RT_DIAGNOSTIC_EVIDENCE_REFERENCE_INVALID");
    const records = this.#evidenceClosures.get(request.reference);
    if (!records) throw new Error("RT_DIAGNOSTIC_EVIDENCE_REFERENCE_INVALID");
    return assertQueryResult({ ...this.#evidencePage("evidence_closure", request, records, stableSignature("evidence_closure", { reference: request.reference }, this.#sourceDigest)), evidenceReference: { reference: request.reference, recordCount: records.length } });
  }

  traceCommand(request: TraceCommandRequest): EvidencePage & { commandId: string } {
    this.#assertTenant(request.tenantId);
    assertQueryString(request.commandId, "RT_DIAGNOSTIC_SCOPE_INVALID");
    const commandId = pseudonymizeIdentifier(request.commandId, this.#pseudonymizationKey);
    const records = scopeCommandRecords(this.#records, commandId);
    return assertQueryResult({ ...this.#evidencePage("trace_command", request, records, stableSignature("trace_command", { commandId, principalNamespaceId: records[0]?.principalNamespaceId }, this.#sourceDigest)), commandId });
  }

  inspectStream(request: InspectStreamRequest): EvidencePage & { stream: string } {
    this.#assertTenant(request.tenantId);
    assertQueryString(request.stream, "RT_DIAGNOSTIC_SCOPE_INVALID");
    const stream = pseudonymizeIdentifier(request.stream, this.#pseudonymizationKey);
    return assertQueryResult({ ...this.#evidencePage("inspect_stream", request, this.#records.filter((record) => record.stream === stream), stableSignature("inspect_stream", { stream }, this.#sourceDigest)), stream });
  }

  leaks(request: LeaksRequest): LeakReport {
    this.#assertTenant(request.tenantId);
    const limit = queryLimit(request.limit);
    const signature = stableSignature("leaks", {}, this.#sourceDigest);
    const activeAll = this.#resources.filter((resource) => resource.state !== "released");
    const offset = decodeCursor(request.cursor, signature, activeAll.length, this.#pseudonymizationKey);
    const active = selectBoundedPage(activeAll, offset, limit, MAX_PAGE_CONTENT_BYTES);
    const failed = active.filter((resource) => resource.state === "failed");
    const hasMore = offset + active.length < activeAll.length;
    const captureProof = this.#resourceCaptureProven() ? "proven" as const : "missing" as const;
    const baseCompleteness = this.#completeness();
    const completeness = captureProof === "proven" ? baseCompleteness : { ...baseCompleteness, status: "partial" as const };
    return assertQueryResult({
      ...this.#base("leaks", completeness, 0),
      verdict: completeness.status === "partial" ? "indeterminate" : activeAll.some((resource) => resource.state === "failed") ? "disproven" : activeAll.length > 0 ? "indeterminate" : "proven",
      resourceCapture: this.#bundle.resourceCapture,
      captureProof, capture: captureProof === "proven" ? clone(this.#bundle.resourceCaptureProof!) : null,
      active: clone(active), failed: clone(failed), activeCount: activeAll.length, failedCount: activeAll.filter((resource) => resource.state === "failed").length,
      hasMore, omittedCount: activeAll.length - active.length,
      ...(hasMore ? { nextCursor: encodeCursor(signature, offset + active.length, this.#pseudonymizationKey) } : {})
    });
  }

  doctor(request: DoctorQueryRequest): DoctorQueryResult {
    this.#assertTenant(request.tenantId);
    assertDoctorQuery(request);
    if (request.expectedProducers.some((role) => !this.#bundle.expectedProducerInstances.some((instance) => instance.producerRole === role))) throw new Error("RT_DIAGNOSTIC_TOPOLOGY_INCOMPLETE");
    const normalizedScope: NonNullable<DoctorQueryRequest["scope"]> = request.scope ? normalizeScope(request.scope, this.#pseudonymizationKey)! : {};
    if (normalizedScope.commandId && !normalizedScope.principalNamespaceId && !normalizedScope.operationCorrelationId && !normalizedScope.eventId && !normalizedScope.transactionId) {
      const principalNamespaceId = scopeCommandRecords(this.#records, normalizedScope.commandId)[0]?.principalNamespaceId;
      if (principalNamespaceId) normalizedScope.principalNamespaceId = principalNamespaceId;
    }
    const report = runDoctor({
      records: this.#records,
      expectedBoundaries: request.expectedBoundaries.map((boundary) => normalizeExpectedBoundary(boundary, this.#pseudonymizationKey)),
      expectedProducers: request.expectedProducers,
      ...(request.requireCausalHandoffs === undefined ? {} : { requireCausalHandoffs: request.requireCausalHandoffs }),
      ...(Object.keys(normalizedScope).length > 0 ? { scope: normalizedScope } : {}),
      droppedRecords: this.#bundle.loss.droppedRecords,
      evictedRecords: this.#bundle.loss.evictedRecords,
      expectedProducerInstances: [...(this.#bundle.expectedProducerInstances ?? [])],
      unavailableProducerInstances: [...(this.#bundle.unavailableProducerInstances ?? [])],
      expectedOutcome: "configured expected outcome (redacted)"
    });
    const completeness = this.#completeness(report.completeness.status);
    const recordsById = new Map(this.#records.map((record) => [record.recordId, record]));
    const closure = report.evidenceClosure.map((match) => recordsById.get(match.recordId)).filter((record): record is EvidenceRecord => Boolean(record));
    if (closure.length !== report.evidenceClosure.length || closure.some((record, index) => record.recordId !== report.evidenceClosure[index]!.recordId)) throw new Error("RT_DIAGNOSTIC_BUNDLE_INVALID");
    const reference = `dqc1.${keyedStableDigest(this.#pseudonymizationKey, ["evidence-closure-v1", this.#sourceDigest, report.scope, report.evidenceClosure])}`;
    this.#evidenceClosures.delete(reference);
    this.#evidenceClosures.set(reference, closure);
    while (this.#evidenceClosures.size > MAX_EVIDENCE_CLOSURES) this.#evidenceClosures.delete(this.#evidenceClosures.keys().next().value!);
    return assertQueryResult({ ...this.#base("doctor", completeness, 1), report, evidenceReference: { reference, recordCount: closure.length } });
  }

  #evidencePage(kind: string, request: PageRequest, records: readonly EvidenceRecord[], signature: string): EvidencePage {
    const limit = queryLimit(request.limit);
    const offset = decodeCursor(request.cursor, signature, records.length, this.#pseudonymizationKey);
    const selected = selectBoundedEvidencePage(records, offset, limit);
    const redactionCount = selected.reduce((count, record) => count + (this.#hiddenRedactions.get(record.recordId) ?? 0) + (record.details?.code === "RT_DIAGNOSTIC_RECORD_TRUNCATED" ? 1 : 0), 0);
    const hasMore = offset + selected.length < records.length;
    const coveredRanges = producerRanges(selected);
    const sourceCompleteness = this.#completeness();
    const completeness = selected.length === records.length ? sourceCompleteness : { ...sourceCompleteness, status: "partial" as const };
    return {
      ...this.#base(kind, completeness, redactionCount), records: clone(selected), coveredRanges,
      hasMore, omittedCount: records.length - selected.length,
      ...(hasMore ? { nextCursor: encodeCursor(signature, offset + selected.length, this.#pseudonymizationKey) } : {})
    };
  }

  #base(kind: string, completeness: QueryCompleteness, redactedFields: number): QueryBase {
    return { product: DIAGNOSTIC_PRODUCT, productVersion: DIAGNOSTIC_PRODUCT_VERSION, component: DIAGNOSTIC_COMPONENT, queryVersion: DIAGNOSTIC_QUERY_VERSION, schemaVersion: LOCAL_EVIDENCE_BUNDLE_SCHEMA_VERSION, tenantId: this.#bundle.tenantId, kind, completeness, provenance: { source: "local_evidence_bundle", payloadPolicy: "redacted", redactedFields } };
  }

  #completeness(forcedStatus?: "complete" | "partial"): QueryCompleteness {
    const expected = [...this.#bundle.expectedProducerInstances];
    const expectedKeys = new Set(expected.map(instanceKey));
    const topologyRecords = this.#records.filter((record) => expectedKeys.has(instanceKey(record)));
    const observed = uniqueInstances(topologyRecords);
    const observedKeys = new Set(observed.map(instanceKey));
    const unavailable = new Set((this.#bundle.unavailableProducerInstances ?? []).map(instanceKey));
    const missing = expected.filter((instance) => !observedKeys.has(instanceKey(instance)) || unavailable.has(instanceKey(instance)));
    const status = forcedStatus === "partial" || this.#bundle.loss.droppedRecords > 0 || this.#bundle.loss.evictedRecords > 0 || missing.length > 0 ? "partial" : "complete";
    return { status, ...this.#bundle.loss, expectedProducerInstances: expected, observedProducerInstances: observed, missingProducerInstances: missing, sourceCoveredRanges: producerRanges(topologyRecords) };
  }

  #resourceCaptureProven(): boolean {
    const proof = this.#bundle.resourceCaptureProof;
    if (this.#bundle.resourceCapture !== "complete" || !proof || this.#bundle.expectedProducerInstances.length !== 1 || proof.inventoryCount !== this.#resources.length || proof.inventoryDigest !== resourceInventoryDigest(this.#bundle.resources ?? [], this.#pseudonymizationKey)) return false;
    const expected = this.#bundle.expectedProducerInstances[0]!;
    return this.#records.some((record) => instanceKey(record) === instanceKey(expected) && record.boundary === "resource.inventory_captured" && record.outcome === "success" && record.details?.captureId === proof.captureId && record.details?.capturedAt === proof.capturedAt && record.details?.inventoryCount === proof.inventoryCount && record.details?.inventoryDigest === proof.inventoryDigest);
  }

  #assertTenant(tenantId: string): void { assertQueryString(tenantId, "RT_DIAGNOSTIC_TENANT_MISMATCH"); if (tenantId !== this.#tenantId) throw new Error("RT_DIAGNOSTIC_TENANT_MISMATCH"); }
}

function queryLimit(value = DEFAULT_QUERY_LIMIT): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_QUERY_LIMIT) throw new Error("RT_DIAGNOSTIC_LIMIT_INVALID");
  return value;
}

function assertQueryShape(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
}

function assertFilters(value: RawEvidenceRequest["filters"]): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
  const allowed = new Set(["boundary", "stream", "transactionId", "operationCorrelationId", "commandId", "eventId", "resourceId"]);
  if (Object.entries(value).some(([key, entry]) => !allowed.has(key) || typeof entry !== "string" || utf8Bytes(entry) > MAX_QUERY_STRING_BYTES || (key === "operationCorrelationId" && !/^opcorr:sha256:[a-f0-9]{64}$/u.test(entry)))) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
}

function assertDoctorQuery(request: DoctorQueryRequest): void {
  if (!Array.isArray(request.expectedBoundaries) || !Array.isArray(request.expectedProducers) || request.expectedBoundaries.length === 0 || request.expectedProducers.length === 0) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
  const producerRoles = new Set(request.expectedProducers);
  const boundaryRoles = new Set(request.expectedBoundaries.map((boundary) => boundary.producerRole));
  if (producerRoles.size !== request.expectedProducers.length || request.expectedBoundaries.some((boundary) => !producerRoles.has(boundary.producerRole)) || request.expectedProducers.some((role) => !boundaryRoles.has(role))) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
  assertQueryString(request.expectedOutcome, "RT_DIAGNOSTIC_QUERY_INVALID");
  for (const boundary of request.expectedBoundaries) {
    assertQueryString(boundary.boundary, "RT_DIAGNOSTIC_QUERY_INVALID");
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(boundary.boundary)) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
    if (boundary.runtimeId !== undefined) assertQueryString(boundary.runtimeId, "RT_DIAGNOSTIC_QUERY_INVALID");
    if (boundary.runtimeBootId !== undefined) assertQueryString(boundary.runtimeBootId, "RT_DIAGNOSTIC_QUERY_INVALID");
  }
  for (const value of Object.values(request.scope ?? {})) if (typeof value === "string") assertQueryString(value, "RT_DIAGNOSTIC_QUERY_INVALID");
  if (request.scope?.operationCorrelationId && !/^opcorr:sha256:[a-f0-9]{64}$/u.test(request.scope.operationCorrelationId)) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
}

function assertQueryString(value: string, code: string): void {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > MAX_QUERY_STRING_BYTES) throw new Error(code);
}

function utf8Bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

function selectBoundedPage<T>(values: readonly T[], offset: number, limit: number, byteLimit: number): T[] {
  const selected: T[] = [];
  let bytes = 2;
  for (let index = offset; index < values.length && selected.length < limit; index += 1) {
    const entry = values[index]!;
    const nextBytes = utf8Bytes(entry) + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && bytes + nextBytes > byteLimit) break;
    if (nextBytes > byteLimit) continue;
    selected.push(entry);
    bytes += nextBytes;
  }
  return selected;
}

function selectBoundedEvidencePage(records: readonly EvidenceRecord[], offset: number, limit: number): EvidenceRecord[] {
  const bounded = records.slice(offset, offset + limit).map(boundedEvidenceRecord);
  return selectBoundedPage(bounded, 0, limit, MAX_PAGE_CONTENT_BYTES);
}

function boundedEvidenceRecord(record: EvidenceRecord): EvidenceRecord {
  if (utf8Bytes(record) <= MAX_RECORD_BYTES) return record;
  return { ...record, details: { code: "RT_DIAGNOSTIC_RECORD_TRUNCATED" } };
}

function scopeCommandRecords(records: readonly EvidenceRecord[], commandId: string): EvidenceRecord[] {
  const matching = records.filter((record) => record.commandId === commandId);
  if (matching.length === 0) return [];
  const principals = new Set(matching.map((record) => record.principalNamespaceId).filter((value): value is string => typeof value === "string"));
  if (principals.size !== 1 || matching.some((record) => typeof record.principalNamespaceId !== "string")) throw new Error("RT_DIAGNOSTIC_SCOPE_AMBIGUOUS");
  const principalNamespaceId = [...principals][0]!;
  return matching.filter((record) => record.principalNamespaceId === principalNamespaceId);
}

function assertQueryResult<T extends EvidencePage | LeakReport | DoctorQueryResult>(result: T): T {
  const normalized = { ...result, provenance: { ...result.provenance, redactedFields: result.provenance.redactedFields + countRedactedFields({ ...result, provenance: { ...result.provenance, redactedFields: 0 } }) } } as T;
  if (utf8Bytes(normalized) > MAX_PAGE_BYTES) throw new Error("RT_DIAGNOSTIC_RESULT_BOUNDS_EXCEEDED");
  if (!validateQueryResult(normalized)) throw new Error(`RT_DIAGNOSTIC_QUERY_RESULT_INVALID:${JSON.stringify(validateQueryResult.errors)}`);
  return normalized;
}

function compareRecords(left: EvidenceRecord, right: EvidenceRecord): number {
  return instanceKey(left).localeCompare(instanceKey(right)) || left.recordSequence - right.recordSequence || left.recordId.localeCompare(right.recordId);
}

function instanceKey(instance: Pick<EvidenceRecord, "producerRole" | "runtimeId" | "runtimeBootId"> | ProducerInstance): string { return `${instance.producerRole}:${instance.runtimeId}:${instance.runtimeBootId}`; }
function uniqueInstances(records: readonly EvidenceRecord[]): ProducerInstance[] { return [...new Map(records.map((record) => [instanceKey(record), { producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId }])).values()]; }

function producerRanges(records: readonly EvidenceRecord[]): ProducerRange[] {
  const ranges = new Map<string, ProducerRange>();
  for (const record of records) {
    const key = instanceKey(record);
    const range = ranges.get(key);
    if (range) { range.first = Math.min(range.first, record.recordSequence); range.last = Math.max(range.last, record.recordSequence); range.count += 1; }
    else ranges.set(key, { producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId, first: record.recordSequence, last: record.recordSequence, count: 1 });
  }
  return [...ranges.values()];
}

function stableSignature(kind: string, filters: object, sourceDigest: string): string { return JSON.stringify([DIAGNOSTIC_QUERY_VERSION, sourceDigest, kind, Object.entries(filters).sort(([left], [right]) => left.localeCompare(right))]); }

function sourceSnapshotDigest(value: unknown, key: string): `sha256:${string}` {
  const tokens: string[] = [];
  const stack: Array<{ kind: "value"; value: unknown } | { kind: "token"; value: string } | { kind: "leave"; value: object }> = [{ kind: "value", value }];
  const active = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === "token") { tokens.push(current.value); continue; }
    if (current.kind === "leave") { active.delete(current.value); continue; }
    if (current.value === null || typeof current.value !== "object") { tokens.push(`value:${JSON.stringify(current.value)}`); continue; }
    if (active.has(current.value)) throw new Error("RT_DIAGNOSTIC_BUNDLE_INVALID");
    active.add(current.value);
    if (Array.isArray(current.value)) {
      tokens.push(`array:${current.value.length}`);
      stack.push({ kind: "leave", value: current.value });
      stack.push({ kind: "token", value: "end-array" });
      for (let index = current.value.length - 1; index >= 0; index -= 1) stack.push({ kind: "value", value: current.value[index] });
    } else {
      const entries = Object.entries(current.value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
      tokens.push(`object:${entries.length}`);
      stack.push({ kind: "leave", value: current.value });
      stack.push({ kind: "token", value: "end-object" });
      for (let index = entries.length - 1; index >= 0; index -= 1) { const [name, entry] = entries[index]!; stack.push({ kind: "value", value: entry }); stack.push({ kind: "token", value: `key:${JSON.stringify(name)}` }); }
    }
  }
  return keyedStableDigest(key, ["local-evidence-source-v1", tokens]);
}

function encodeCursor(signature: string, offset: number, key: string): string {
  const body = base64UrlEncode(JSON.stringify({ queryVersion: DIAGNOSTIC_QUERY_VERSION, signature, offset }));
  return `dq1.${body}.${keyedStableDigest(key, ["diagnostic-cursor-v1", body])}`;
}

function decodeCursor(cursor: string | undefined, signature: string, total: number, key: string): number {
  if (!cursor) return 0;
  try {
    if (utf8Bytes(cursor) > MAX_CURSOR_BYTES) throw new Error();
    if (!cursor.startsWith("dq1.")) throw new Error();
    const [body, mac, extra] = cursor.slice(4).split(".");
    if (!body || !mac || extra || mac !== keyedStableDigest(key, ["diagnostic-cursor-v1", body])) throw new Error();
    const decoded = JSON.parse(base64UrlDecode(body)) as { queryVersion?: unknown; signature?: unknown; offset?: unknown };
    if (decoded.queryVersion !== DIAGNOSTIC_QUERY_VERSION || decoded.signature !== signature || !Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 1 || Number(decoded.offset) >= total) throw new Error();
    return Number(decoded.offset);
  } catch { throw new Error("RT_DIAGNOSTIC_CURSOR_INVALID"); }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

const safeDetailKeys = new Map<string, string>(safeDetailKeyNames.map((key) => [key, key]));
const pseudonymizedDetailValueKeys = new Set([
  "appendId", "causalEventIds", "commandId", "connectionId", "deliveryId", "eventId", "outboxId", "outboxIds", "ownerId", "principalNamespaceId", "observerPrincipalNamespaceId", "requestId", "resourceId", "sessionId", "stream", "traceId", "transactionId"
].map(normalizeDetailKey));
const safeNumericDetailKeys = new Set([
  "actual", "after", "attempt", "bufferedAmount", "bytes", "causalEventPositions", "consumers", "count", "cursor", "cursorSequence", "delay", "delivered", "eventSequence", "expected", "expectedSequence", "first", "from", "head", "headSequence", "idempotencyRetentionMs", "index", "intentHashVersion", "inventoryCount", "last", "maxBufferedBytes", "maxBytes", "maxMessageBytes", "maxOutboundBufferedBytes", "maxRecords", "nextBytes", "nextMessageBytes", "nextRecords", "pages", "projectedSequence", "receivedSequence", "recordSequence", "replayRetentionMs", "requestedAfter", "sequence", "sessionGeneration", "snapshotBytes", "snapshotSequence", "socketWritableBytes", "through", "throughSequence", "timeoutMs", "commandResultRetentionMs", "maxRecoveryBufferBytes", "maxRecoveryBufferRecords"
].map(normalizeDetailKey));
const safeBooleanDetailKeys = new Set([
  "catchup", "claimed", "duplicate", "durableSuccessClaimed", "existenceExposed", "listenerDeliveryClaimed", "outcomeProof", "producerClaimed", "rawIdentityCaptured", "rawIssuerCaptured", "rawSubjectCaptured", "received", "retryable", "snapshotRequested", "durableReplay", "idempotentCommands", "commandReceipts", "fencedSnapshots"
].map(normalizeDetailKey));
const pseudonymizedFields = ["recordId", "runtimeId", "runtimeBootId", "connectionId", "sessionId", "stream", "transactionId", "principalNamespaceId", "commandId", "commandAttemptId", "eventId", "traceId", "causalHandoffId", "causalParentRecordId", "resourceId", "ownerId"] as const;
export function redactEvidenceRecord<T extends { details?: Record<string, unknown> }>(record: T, pseudonymizationKey: string, redaction: { count: number } = { count: 0 }): T {
  const output: Record<string, unknown> = { ...record };
  delete output.previousRecordHash;
  for (const field of pseudonymizedFields) if (typeof output[field] === "string") { output[field] = pseudonymizeIdentifier(output[field] as string, pseudonymizationKey); redaction.count += 1; }
  if (typeof output.operationCorrelationId === "string") { output.operationCorrelationId = pseudonymizeOperationCorrelation(output.operationCorrelationId, pseudonymizationKey); redaction.count += 1; }
  if (record.details) output.details = redactObject(record.details, redaction, pseudonymizationKey) as Record<string, unknown>;
  return output as T;
}

export function pseudonymizeIdentifier(value: string, pseudonymizationKey: string): string {
  return `pseudonym:${keyedStableDigest(pseudonymizationKey, value)}`;
}

function pseudonymizeOperationCorrelation(value: string, pseudonymizationKey: string): `opcorr:sha256:${string}` {
  return `opcorr:${keyedStableDigest(pseudonymizationKey, value)}`;
}

export function resourceInventoryDigest(resources: readonly ResourceInventoryItem[], pseudonymizationKey: string): `sha256:${string}` {
  return keyedStableDigest(pseudonymizationKey, [...resources].sort((left, right) => left.resourceId.localeCompare(right.resourceId)));
}

function redactResource(resource: ResourceInventoryItem, pseudonymizationKey: string): ResourceInventoryItem {
  return { ...resource, resourceId: pseudonymizeIdentifier(resource.resourceId, pseudonymizationKey), ownerId: pseudonymizeIdentifier(resource.ownerId, pseudonymizationKey) };
}

function normalizeFilters(filters: RawEvidenceRequest["filters"], pseudonymizationKey: string): NonNullable<RawEvidenceRequest["filters"]> {
  const output = { ...filters };
  for (const field of ["stream", "transactionId", "commandId", "eventId", "resourceId"] as const) if (typeof output[field] === "string") output[field] = pseudonymizeIdentifier(output[field]!, pseudonymizationKey);
  if (typeof output.operationCorrelationId === "string") output.operationCorrelationId = pseudonymizeOperationCorrelation(output.operationCorrelationId, pseudonymizationKey);
  return output;
}

function normalizeScope(scope: DoctorQueryRequest["scope"], pseudonymizationKey: string): DoctorQueryRequest["scope"] {
  if (!scope) return scope;
  const output = { ...scope };
  for (const field of ["traceId", "sessionId", "stream", "transactionId", "principalNamespaceId", "commandId", "commandAttemptId", "eventId", "causalHandoffId"] as const) if (typeof output[field] === "string") output[field] = pseudonymizeIdentifier(output[field]!, pseudonymizationKey);
  if (typeof output.operationCorrelationId === "string") output.operationCorrelationId = pseudonymizeOperationCorrelation(output.operationCorrelationId, pseudonymizationKey);
  return output;
}

function normalizeProducerInstance(instance: ProducerInstance, pseudonymizationKey: string): ProducerInstance {
  return { ...instance, runtimeId: pseudonymizeIdentifier(instance.runtimeId, pseudonymizationKey), runtimeBootId: pseudonymizeIdentifier(instance.runtimeBootId, pseudonymizationKey) };
}

function normalizeExpectedBoundary(boundary: DoctorOptions["expectedBoundaries"][number], pseudonymizationKey: string): DoctorOptions["expectedBoundaries"][number] {
  return {
    ...boundary,
    ...(boundary.runtimeId ? { runtimeId: pseudonymizeIdentifier(boundary.runtimeId, pseudonymizationKey) } : {}),
    ...(boundary.runtimeBootId ? { runtimeBootId: pseudonymizeIdentifier(boundary.runtimeBootId, pseudonymizationKey) } : {})
  };
}

function countRedactedFields(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, entry) => count + countRedactedFields(entry), 0);
  if (typeof value === "string") return value === "[REDACTED]" || value.startsWith("pseudonym:sha256:") ? 1 : 0;
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((count, entry) => count + countRedactedFields(entry), 0);
}

function redactObject(value: unknown, redaction: { count: number }, pseudonymizationKey: string, parentKey?: string, depth = 0): unknown {
  if (depth > MAX_DETAIL_DEPTH) { redaction.count += 1; return "[REDACTED]"; }
  const normalized = normalizeDetailKey(parentKey ?? "");
  if (pseudonymizedDetailValueKeys.has(normalized) && (typeof value === "string" || typeof value === "number")) { redaction.count += 1; return pseudonymizeIdentifier(String(value), pseudonymizationKey); }
  if (typeof value === "string") {
    if (normalized === "intenthash" && /^sha256:[a-f0-9]{64}$/u.test(value)) { redaction.count += 1; return keyedStableDigest(pseudonymizationKey, value); }
    if (isSafeDetailString(normalized, value)) return value;
    redaction.count += 1;
    return "[REDACTED]";
  }
  if (typeof value === "number") {
    if (safeNumericDetailKeys.has(normalized) && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;
    redaction.count += 1;
    return "[REDACTED]";
  }
  if (typeof value === "boolean") {
    if (safeBooleanDetailKeys.has(normalized)) return value;
    redaction.count += 1;
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    const selected = value.slice(0, MAX_DETAIL_ENTRIES).map((entry) => redactObject(entry, redaction, pseudonymizationKey, parentKey, depth + 1));
    if (value.length > selected.length) redaction.count += value.length - selected.length;
    return selected;
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entry] of entries.slice(0, MAX_DETAIL_ENTRIES)) {
    // Semantic evidence fields are accepted only under their exact canonical
    // spelling. Normalizing attacker-controlled aliases (for example
    // `proof💣Source`) could otherwise overwrite an authoritative proof field.
    const canonicalKey = safeDetailKeys.get(key);
    if (!canonicalKey) { redaction.count += 1; continue; }
    output[canonicalKey] = redactObject(entry, redaction, pseudonymizationKey, canonicalKey, depth + 1);
  }
  if (entries.length > MAX_DETAIL_ENTRIES) redaction.count += entries.length - MAX_DETAIL_ENTRIES;
  return output;
}

function isSafeDetailString(normalizedKey: string, value: string): boolean {
  if (normalizedKey === "inventorydigest") return /^sha256:[a-f0-9]{64}$/u.test(value);
  if (normalizedKey === "sqlstate") return /^[0-9A-Z]{5}$/u.test(value);
  if (normalizedKey === "code") return /^RT_[A-Z0-9_]{1,96}$/u.test(value);
  if (normalizedKey === "capturedat") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
  if (normalizedKey === "captureid") return /^capture[-_:][A-Za-z0-9_-]{1,96}$/u.test(value);
  if (["schema", "effectschema"].includes(normalizedKey)) return /^[A-Za-z][A-Za-z0-9_.-]{0,79}@[1-9][0-9]*$/u.test(value);
  if (normalizedKey === "operation") return new Set(["schema_migration", "principal_namespace", "command", "append_event", "snapshot_read", "outbox_publish", "command_retention_cleanup", "outbox_retention_cleanup", "stream_retention", "command_status", "gateway_health_or_durable_operation", "harness_pool_idle_connection"]).has(value);
  if (normalizedKey === "proofsource") return new Set(["postgres_error_response", "commit_ack_unavailable", "commit_acknowledgement", "durable_transaction_attempt_marker", "repeatable_read_read_only_discard_and_retry", "commit_not_invoked", "same_connection_rollback"]).has(value);
  if (normalizedKey === "resolution") return new Set(["committed", "rolled_back", "no_durable_effect"]).has(value);
  if (normalizedKey === "serialization") return new Set(["fresh_repeatable_read_read_only_attempt", "outbox_row_lock", "pg_advisory_xact_lock", "command_advisory_lock"]).has(value);
  if (normalizedKey === "failureprovenance") return value === "authoritative_abort";
  if (normalizedKey === "provenance") return new Set(["application", "database", "gateway_observer"]).has(value);
  if (normalizedKey === "action") return new Set(["rollback", "replay", "fenced_snapshot", "destroy_connection"]).has(value);
  if (normalizedKey === "deliverymode") return new Set(["live", "replay", "snapshot_catchup"]).has(value);
  if (["state", "status", "wirestate"].includes(normalizedKey)) return new Set(["absent", "accepted", "active", "backing_off", "cancelled", "closed", "commit_in_flight", "committed", "completed", "connecting", "created", "disposed", "disposing", "expired", "failed", "idle", "indeterminate", "live", "observed", "open", "opening", "pre_commit", "queued", "ready", "reauthenticating", "reconciled", "reconciling", "rejected", "replaying", "resyncing", "rolled_back", "sent", "subscribing", "suspended", "unknown"]).has(value);
  return false;
}

function normalizeDetailKey(value: string): string { return value.replace(/[^a-z0-9]/giu, "").toLowerCase(); }

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
