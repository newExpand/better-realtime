import Ajv2020 from "ajv/dist/2020.js";
import { transactionOperations, type DoctorEvidenceMatch, type DoctorIssue, type DoctorReport, type EvidenceRecord, type ExpectedBoundary, type ProducerInstance, type ProducerRole } from "./types.ts";

export const doctorSchemaDefs = {
  producerRole: { enum: ["client", "server", "database", "tool", "unknown"] },
  producerInstance: { type: "object", additionalProperties: false, required: ["producerRole", "runtimeId", "runtimeBootId"], properties: { producerRole: { $ref: "#/$defs/producerRole" }, runtimeId: { type: "string", minLength: 1 }, runtimeBootId: { type: "string", minLength: 1 } } },
  producerRange: { type: "object", additionalProperties: false, required: ["producerRole", "runtimeId", "runtimeBootId", "first", "last", "count"], properties: { producerRole: { $ref: "#/$defs/producerRole" }, runtimeId: { type: "string", minLength: 1 }, runtimeBootId: { type: "string", minLength: 1 }, first: { type: "integer", minimum: 1 }, last: { type: "integer", minimum: 1 }, count: { type: "integer", minimum: 1 } } },
  boundaryFinding: { oneOf: [
    { type: "object", additionalProperties: false, required: ["status", "value", "evidence"], properties: { status: { const: "known" }, value: { type: "string" }, evidence: { type: "array", minItems: 1, items: { type: "string" } } } },
    { type: "object", additionalProperties: false, required: ["status", "reason"], properties: { status: { const: "unknown" }, reason: { type: "string" } } }
  ] },
  evidenceMatch: { type: "object", additionalProperties: false, required: ["purpose", "recordId", "recordSequence", "producerRole", "runtimeId", "runtimeBootId", "boundary", "component", "componentVersion", "outcome"], properties: {
    purpose: { enum: ["matched_boundary", "divergent_boundary", "transaction_indeterminate", "reconciliation_proof"] }, recordId: { type: "string", minLength: 1 }, recordSequence: { type: "integer", minimum: 1 }, producerRole: { $ref: "#/$defs/producerRole" }, runtimeId: { type: "string", minLength: 1 }, runtimeBootId: { type: "string", minLength: 1 }, boundary: { type: "string", minLength: 1 }, component: { type: "string", minLength: 1 }, componentVersion: { type: "string", minLength: 1 }, outcome: { enum: ["success", "failure", "invariant_violation", "unknown"] }, reasonCode: { type: "string", pattern: "^RT_[A-Z0-9_]{1,96}$" }, transactionId: { type: "string" }, transactionOperation: { enum: transactionOperations }, operationCorrelationId: { type: "string", pattern: "^opcorr:sha256:[a-f0-9]{64}$" }, commandAttemptId: { type: "string" }, eventId: { type: "string" }, causalHandoffId: { type: "string" }, causalParentRecordId: { type: "string" }, proofSource: { enum: ["postgres_error_response", "commit_ack_unavailable", "commit_acknowledgement", "durable_transaction_attempt_marker", "repeatable_read_read_only_discard_and_retry", "commit_not_invoked", "same_connection_rollback"] }, resolution: { enum: ["committed", "rolled_back", "no_durable_effect"] }
  } }
} as const;

export const doctorReportSchemaV1 = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "verdict", "expectedOutcome", "actualOutcome", "evidenceClosure", "lastSuccessfulBoundary", "firstDivergentBoundary", "issues", "completeness", "scope", "producerRanges"],
  properties: {
    schemaVersion: { const: "1.0" },
    verdict: { enum: ["proven", "disproven", "indeterminate"] },
    expectedOutcome: { type: "string" },
    actualOutcome: { type: "string" },
    evidenceClosure: { type: "array", maxItems: 256, items: { $ref: "#/$defs/evidenceMatch" } },
    lastSuccessfulBoundary: { $ref: "#/$defs/boundaryFinding" },
    firstDivergentBoundary: { $ref: "#/$defs/boundaryFinding" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "severity", "summary", "lastSuccessfulBoundary", "firstDivergentBoundary", "component", "componentVersion"], properties: {
      code: { type: "string" }, severity: { enum: ["info", "warning", "error"] }, summary: { type: "string" },
      lastSuccessfulBoundary: { $ref: "#/$defs/boundaryFinding" }, firstDivergentBoundary: { $ref: "#/$defs/boundaryFinding" },
      component: { type: ["string", "null"] }, componentVersion: { type: ["string", "null"] }
    } } },
    completeness: { type: "object", additionalProperties: false, required: ["status", "droppedRecords", "evictedRecords", "expectedProducers", "observedProducers", "missingProducers", "expectedProducerInstances", "observedProducerInstances", "missingProducerInstances"], properties: {
      status: { enum: ["complete", "partial"] }, droppedRecords: { type: "integer", minimum: 0 }, evictedRecords: { type: "integer", minimum: 0 },
      expectedProducers: { type: "array", items: { $ref: "#/$defs/producerRole" } }, observedProducers: { type: "array", items: { $ref: "#/$defs/producerRole" } }, missingProducers: { type: "array", items: { $ref: "#/$defs/producerRole" } },
      expectedProducerInstances: { type: "array", items: { $ref: "#/$defs/producerInstance" } }, observedProducerInstances: { type: "array", items: { $ref: "#/$defs/producerInstance" } }, missingProducerInstances: { type: "array", items: { $ref: "#/$defs/producerInstance" } }
    } },
    scope: { type: "object", additionalProperties: false, properties: { traceId: { type: "string" }, sessionId: { type: "string" }, stream: { type: "string" }, transactionId: { type: "string" }, operationCorrelationId: { type: "string", pattern: "^opcorr:sha256:[a-f0-9]{64}$" }, principalNamespaceId: { type: "string" }, commandId: { type: "string" }, commandAttemptId: { type: "string" }, eventId: { type: "string" }, causalHandoffId: { type: "string" } } },
    producerRanges: { type: "array", items: { $ref: "#/$defs/producerRange" } }
  }
} as const;

export const doctorSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...doctorReportSchemaV1,
  $defs: doctorSchemaDefs
} as const;

const validate = new Ajv2020({ strict: false }).compile<DoctorReport>(doctorSchema);
const producerKey = (record: EvidenceRecord) => `${record.producerRole}:${record.runtimeId}:${record.runtimeBootId}`;

export interface DoctorOptions {
  records: readonly EvidenceRecord[];
  expectedBoundaries: ExpectedBoundary[];
  expectedProducers: ProducerRole[];
  expectedProducerInstances?: ProducerInstance[];
  unavailableProducerInstances?: ProducerInstance[];
  requireCausalHandoffs?: boolean;
  scope?: Partial<Pick<EvidenceRecord, "traceId" | "sessionId" | "stream" | "transactionId" | "operationCorrelationId" | "principalNamespaceId" | "commandId" | "commandAttemptId" | "eventId" | "causalHandoffId">>;
  droppedRecords?: number;
  evictedRecords?: number;
  expectedOutcome: string;
}

export function doctor(options: DoctorOptions): DoctorReport {
  const boundaryRoles = new Set(options.expectedBoundaries.map((boundary) => boundary.producerRole));
  const expectedRoles = new Set(options.expectedProducers);
  if (options.expectedBoundaries.length === 0 || options.expectedProducers.length === 0 || boundaryRoles.size === 0 || expectedRoles.size !== options.expectedProducers.length || options.expectedBoundaries.some((boundary) => !expectedRoles.has(boundary.producerRole) || !/^[a-z][a-z0-9._-]{0,127}$/u.test(boundary.boundary)) || options.expectedProducers.some((role) => !boundaryRoles.has(role))) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
  const scope = { ...(options.scope ?? {}) };
  const initialScopeEntries = Object.entries(scope).filter((entry): entry is [keyof typeof scope, string] => typeof entry[1] === "string");
  const initiallyScoped = options.records.filter((record) => initialScopeEntries.every(([key, value]) => record[key] === value));
  let commandScopeAmbiguous = false;
  if (typeof scope.commandId === "string" && !scope.principalNamespaceId && !scope.operationCorrelationId && !scope.eventId && !scope.transactionId) {
    const commandRecords = initiallyScoped.filter((record) => record.commandId === scope.commandId);
    const principals = new Set(commandRecords.map((record) => record.principalNamespaceId).filter((value): value is string => typeof value === "string"));
    const principalNamespaceId = [...principals][0];
    if (principals.size === 1 && principalNamespaceId && commandRecords.length > 0 && commandRecords.every((record) => typeof record.principalNamespaceId === "string")) scope.principalNamespaceId = principalNamespaceId;
    else commandScopeAmbiguous = true;
  }
  const scopeEntries = Object.entries(scope).filter((entry): entry is [keyof typeof scope, string] => typeof entry[1] === "string");
  const expectedProducerInstances = options.expectedProducerInstances ?? [];
  const expectedInstanceKeys = new Set(expectedProducerInstances.map(instanceKey));
  const scopedRecords = options.records.filter((record) => scopeEntries.every(([key, value]) => record[key] === value) && (expectedInstanceKeys.size === 0 || expectedInstanceKeys.has(producerKey(record))));
  const observedProducers = [...new Set(scopedRecords.map((record) => record.producerRole))];
  const missingProducers = options.expectedProducers.filter((role) => !observedProducers.includes(role));
  const observedProducerInstances = [...new Map(scopedRecords.map((record) => [producerKey(record), { producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId }])).values()];
  const observedInstanceKeys = new Set(observedProducerInstances.map(instanceKey));
  const unavailableKeys = new Set((options.unavailableProducerInstances ?? []).map(instanceKey));
  const missingProducerInstances = expectedProducerInstances.filter((instance) => !observedInstanceKeys.has(instanceKey(instance)) || unavailableKeys.has(instanceKey(instance)));
  const hasOperationCorrelation = typeof scope.traceId === "string" || typeof scope.sessionId === "string" || typeof scope.transactionId === "string" || typeof scope.operationCorrelationId === "string" || typeof scope.principalNamespaceId === "string" || typeof scope.commandId === "string" || typeof scope.commandAttemptId === "string" || typeof scope.eventId === "string" || typeof scope.causalHandoffId === "string";
  const correlationMissing = commandScopeAmbiguous || (options.expectedProducers.length > 1 && !hasOperationCorrelation);
  const completenessStatus = (options.droppedRecords ?? 0) === 0 && (options.evictedRecords ?? 0) === 0 && missingProducers.length === 0 && missingProducerInstances.length === 0 && !correlationMissing ? "complete" : "partial";
  const selectedInstances = new Map<ProducerRole, string>();
  const lastSequenceByInstance = new Map<string, number>();
  const selectedJourneyIdentity = new Map<"commandAttemptId" | "transactionId" | "operationCorrelationId" | "eventId", string>();
  const latestReconciliationByTransaction = new Map<string, EvidenceRecord>();
  const latestOutcomeAttemptByCorrelation = new Map<string, EvidenceRecord>();
  const correlatedAttemptInstancesByRole = new Map<ProducerRole, Set<string>>();
  for (const record of scopedRecords) {
    if (record.boundary === "database.transaction_reconciled" && record.outcome === "success") {
      const key = transactionProofKey(record);
      if (key) {
        const current = latestReconciliationByTransaction.get(key);
        if (!current || current.recordSequence < record.recordSequence) latestReconciliationByTransaction.set(key, record);
      }
    }
    if (isOutcomeAttemptBoundary(record.boundary) && record.transactionId && record.transactionOperation && record.operationCorrelationId) {
      const correlationKey = transactionCorrelationKey(record);
      const current = latestOutcomeAttemptByCorrelation.get(correlationKey);
      if (!current || current.recordSequence < record.recordSequence) latestOutcomeAttemptByCorrelation.set(correlationKey, record);
      let instances = correlatedAttemptInstancesByRole.get(record.producerRole);
      if (!instances) { instances = new Set<string>(); correlatedAttemptInstancesByRole.set(record.producerRole, instances); }
      instances.add(producerKey(record));
    }
  }
  const isSuperseded = (record: EvidenceRecord): boolean => {
    if (!record.transactionId || !record.transactionOperation || !record.operationCorrelationId) return false;
    const latest = latestOutcomeAttemptByCorrelation.get(transactionCorrelationKey(record));
    return Boolean(latest && latest.transactionId !== record.transactionId && latest.recordSequence > record.recordSequence);
  };
  let lastSuccess: EvidenceRecord | undefined;
  const closureRecords: Array<{ record: EvidenceRecord; purpose: DoctorEvidenceMatch["purpose"] }> = [];
  const resolvedDependencies: Array<{ record: EvidenceRecord; purpose: DoctorEvidenceMatch["purpose"]; proofKey: string }> = [];
  let divergence: { expected: ExpectedBoundary; record?: EvidenceRecord; evidence?: EvidenceRecord[]; ambiguous?: boolean; code: string; reason: string } | undefined;

  const invalidTopologyBoundary = options.expectedBoundaries.find((expected) => {
    if (expectedProducerInstances.length === 0) return false;
    const roleInstances = expectedProducerInstances.filter((instance) => instance.producerRole === expected.producerRole);
    if (!expected.runtimeId && !expected.runtimeBootId) return roleInstances.length !== 1;
    if (!expected.runtimeId || !expected.runtimeBootId) return true;
    return !roleInstances.some((instance) => instance.runtimeId === expected.runtimeId && instance.runtimeBootId === expected.runtimeBootId);
  });

  const unresolvedTransaction = scopedRecords.find((record) => {
    if (record.boundary !== "database.transaction_outcome_indeterminate" || record.outcome !== "unknown") return false;
    const key = transactionProofKey(record);
    const candidate = key ? latestReconciliationByTransaction.get(key) : undefined;
    return !candidate || candidate.recordSequence <= record.recordSequence || !isDurableReconciliationProof(record, candidate);
  });
  for (const record of scopedRecords) {
    if (record.boundary !== "database.transaction_outcome_indeterminate" || record.outcome !== "unknown") continue;
    const key = transactionProofKey(record);
    const candidate = key ? latestReconciliationByTransaction.get(key) : undefined;
    if (key && candidate && candidate.recordSequence > record.recordSequence && isDurableReconciliationProof(record, candidate)) {
      resolvedDependencies.push({ record, purpose: "transaction_indeterminate", proofKey: key });
      resolvedDependencies.push({ record: candidate, purpose: "reconciliation_proof", proofKey: key });
    }
  }

  if (invalidTopologyBoundary) {
    divergence = { expected: invalidTopologyBoundary, code: "RT_DIAGNOSTIC_TOPOLOGY_INCOMPLETE", reason: `required boundary is not bound to exactly one expected producer instance in the topology manifest` };
  } else if (unresolvedTransaction) {
    divergence = { expected: { producerRole: unresolvedTransaction.producerRole, runtimeId: unresolvedTransaction.runtimeId, runtimeBootId: unresolvedTransaction.runtimeBootId, boundary: "database.transaction_outcome_indeterminate" }, record: unresolvedTransaction, code: unresolvedTransaction.reasonCode ?? "RT_TRANSACTION_OUTCOME_INDETERMINATE", reason: "a correlated database transaction outcome remains indeterminate without serialized durable reconciliation" };
  } else if (correlationMissing) {
    divergence = { expected: options.expectedBoundaries[0] ?? { producerRole: options.expectedProducers[0] ?? "unknown", boundary: "correlation.scope" }, code: "RT_EVIDENCE_SCOPE_REQUIRED", reason: "multi-producer evidence requires an explicit trace/session/stream/command scope" };
  } else {
    for (const expected of options.expectedBoundaries) {
      const chosenInstance = selectedInstances.get(expected.producerRole);
      const candidates = scopedRecords.filter((record) => record.producerRole === expected.producerRole && record.boundary === expected.boundary && (!expected.runtimeId || record.runtimeId === expected.runtimeId) && (!expected.runtimeBootId || record.runtimeBootId === expected.runtimeBootId) && (expected.runtimeId || !chosenInstance || producerKey(record) === chosenInstance) && !isSuperseded(record) && record.recordSequence > (lastSequenceByInstance.get(producerKey(record)) ?? 0) && [...selectedJourneyIdentity].every(([field, value]) => record[field] === value || (record[field] === undefined && lastSuccess !== undefined && canOmitJourneyIdentity(lastSuccess, record, field))));
      const correlatedAttemptInstances = correlatedAttemptInstancesByRole.get(expected.producerRole) ?? new Set<string>();
      if ((!expected.runtimeId || !expected.runtimeBootId) && !scope.transactionId && !scope.causalHandoffId && correlatedAttemptInstances.size > 1) {
        divergence = { expected, code: "RT_DIAGNOSTIC_SCOPE_AMBIGUOUS", reason: `multiple producer instances emitted transactions for the correlated operation; select a transaction, producer instance, or causal handoff` };
        break;
      }
      const ambiguousField = (["commandAttemptId", "transactionId", "operationCorrelationId"] as const).find((field) => scope[field] === undefined && new Set(candidates.map((candidate) => candidate[field] ?? "<missing>")).size > 1);
      const conflictingOutcomes = new Set(candidates.map((candidate) => candidate.outcome)).size > 1;
      if (ambiguousField || conflictingOutcomes) {
        const evidence = ambiguityWitnesses(candidates, ambiguousField, conflictingOutcomes);
        divergence = { expected, record: evidence[evidence.length - 1]!, evidence, ambiguous: true, code: "RT_DIAGNOSTIC_SCOPE_AMBIGUOUS", reason: ambiguousField ? `multiple ${ambiguousField} values can satisfy ${expected.producerRole}:${expected.boundary}; select an exact journey scope` : `conflicting outcomes can satisfy ${expected.producerRole}:${expected.boundary}; select an exact attempt, transaction, event, or causal scope` };
        break;
      }
      const record = [...candidates].sort((left, right) => left.recordSequence - right.recordSequence)[0];
      if (!record) { divergence = { expected, code: "RT_BOUNDARY_UNOBSERVED", reason: `missing evidence for ${expected.producerRole}:${expected.boundary} in the selected producer instance` }; break; }
      if (options.requireCausalHandoffs && lastSuccess && producerKey(lastSuccess) !== producerKey(record) && record.causalParentRecordId !== lastSuccess.recordId && (!record.causalHandoffId || record.causalHandoffId !== lastSuccess.causalHandoffId)) {
        divergence = { expected, record, code: "RT_CAUSAL_HANDOFF_REQUIRED", reason: `missing explicit causal handoff from ${producerKey(lastSuccess)} to ${producerKey(record)}` };
        break;
      }
      const key = producerKey(record);
      if (!chosenInstance) selectedInstances.set(expected.producerRole, key);
      if (record.outcome !== "success") { divergence = { expected, record, code: record.reasonCode ?? "RT_BOUNDARY_DIVERGED", reason: `boundary ${expected.boundary} reported ${record.outcome}` }; break; }
      lastSequenceByInstance.set(key, record.recordSequence);
      for (const field of ["commandAttemptId", "transactionId", "operationCorrelationId", "eventId"] as const) if (record[field] !== undefined && !selectedJourneyIdentity.has(field)) selectedJourneyIdentity.set(field, record[field]!);
      lastSuccess = record;
      closureRecords.push({ record, purpose: "matched_boundary" });
    }
  }

  const lastSuccessfulBoundary: DoctorIssue["lastSuccessfulBoundary"] = lastSuccess ? { status: "known", value: `${lastSuccess.producerRole}:${lastSuccess.boundary!}`, evidence: [lastSuccess.recordId] } : { status: "unknown", reason: "no successful correlated boundary captured" };
  const firstDivergentBoundary: DoctorIssue["firstDivergentBoundary"] = divergence?.record ? { status: "known", value: `${divergence.expected.producerRole}:${divergence.expected.boundary}`, evidence: (divergence.evidence ?? [divergence.record]).map((record) => record.recordId) } : { status: "unknown", reason: divergence?.reason ?? "no divergent boundary captured" };
  const issues: DoctorIssue[] = divergence ? [{
    code: divergence.code,
    severity: divergence.record?.outcome === "failure" || divergence.record?.outcome === "invariant_violation" ? "error" : "warning",
    summary: divergence.reason,
    lastSuccessfulBoundary,
    firstDivergentBoundary,
    component: divergence.record?.component ?? null,
    componentVersion: divergence.record?.componentVersion ?? null
  }] : [];

  const ranges = new Map<string, DoctorReport["producerRanges"][number]>();
  for (const record of scopedRecords) {
    const key = producerKey(record);
    const current = ranges.get(key);
    if (current) { current.first = Math.min(current.first, record.recordSequence); current.last = Math.max(current.last, record.recordSequence); current.count += 1; }
    else ranges.set(key, { producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId, first: record.recordSequence, last: record.recordSequence, count: 1 });
  }
  const verdict = divergence ? (completenessStatus === "complete" && !divergence.ambiguous && (divergence.record?.outcome === "failure" || divergence.record?.outcome === "invariant_violation") ? "disproven" : "indeterminate") : (completenessStatus === "complete" ? "proven" : "indeterminate");
  const selectedProofKeys = new Set([...closureRecords.filter((entry) => entry.purpose === "matched_boundary").map((entry) => transactionProofKey(entry.record)), ...(divergence?.evidence ?? (divergence?.record ? [divergence.record] : [])).map(transactionProofKey)].filter((key): key is string => Boolean(key)));
  closureRecords.unshift(...resolvedDependencies.filter((entry) => selectedProofKeys.has(entry.proofKey)).map(({ record, purpose }) => ({ record, purpose })));
  for (const record of divergence?.evidence ?? (divergence?.record ? [divergence.record] : [])) if (!closureRecords.some((entry) => entry.record.recordId === record.recordId)) closureRecords.push({ record, purpose: "divergent_boundary" });
  const uniqueClosure = [...new Map(closureRecords.map((entry) => [entry.record.recordId, entry])).values()];
  const report: DoctorReport = {
    schemaVersion: "1.0", verdict, expectedOutcome: options.expectedOutcome,
    actualOutcome: divergence ? "correlated evidence did not cross every required boundary" : "correlated evidence crossed every required boundary",
    evidenceClosure: uniqueClosure.map(({ record, purpose }) => evidenceMatch(record, purpose)),
    lastSuccessfulBoundary,
    firstDivergentBoundary,
    issues,
    completeness: { status: completenessStatus, droppedRecords: options.droppedRecords ?? 0, evictedRecords: options.evictedRecords ?? 0, expectedProducers: options.expectedProducers, observedProducers, missingProducers, expectedProducerInstances, observedProducerInstances, missingProducerInstances },
    scope,
    producerRanges: [...ranges.values()]
  };
  if (!validate(report)) throw new Error(`doctor report failed schema validation: ${JSON.stringify(validate.errors)}`);
  return report;
}

const safeProofSources = new Set(["postgres_error_response", "commit_ack_unavailable", "commit_acknowledgement", "durable_transaction_attempt_marker", "repeatable_read_read_only_discard_and_retry", "commit_not_invoked", "same_connection_rollback"]);
const safeResolutions = new Set(["committed", "rolled_back", "no_durable_effect"]);
function evidenceMatch(record: EvidenceRecord, purpose: DoctorEvidenceMatch["purpose"]): DoctorEvidenceMatch {
  const proofSource = record.details?.proofSource;
  const resolution = record.details?.resolution;
  return {
    purpose, recordId: record.recordId, recordSequence: record.recordSequence, producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId,
    boundary: record.boundary!, component: record.component, componentVersion: record.componentVersion, outcome: record.outcome, ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
    ...(record.transactionId ? { transactionId: record.transactionId } : {}), ...(record.transactionOperation ? { transactionOperation: record.transactionOperation } : {}), ...(record.operationCorrelationId ? { operationCorrelationId: record.operationCorrelationId } : {}), ...(record.commandAttemptId ? { commandAttemptId: record.commandAttemptId } : {}), ...(record.eventId ? { eventId: record.eventId } : {}), ...(record.causalHandoffId ? { causalHandoffId: record.causalHandoffId } : {}), ...(record.causalParentRecordId ? { causalParentRecordId: record.causalParentRecordId } : {}),
    ...(typeof proofSource === "string" && safeProofSources.has(proofSource) ? { proofSource } : {}), ...(typeof resolution === "string" && safeResolutions.has(resolution) ? { resolution } : {})
  };
}

const instanceKey = (instance: ProducerInstance): string => `${instance.producerRole}:${instance.runtimeId}:${instance.runtimeBootId}`;
function isDurableReconciliationProof(original: EvidenceRecord, candidate: EvidenceRecord): boolean {
  if (!original.transactionOperation || candidate.transactionOperation !== original.transactionOperation) return false;
  if (!original.operationCorrelationId || candidate.operationCorrelationId !== original.operationCorrelationId) return false;
  for (const key of ["commandId", "eventId", "stream"] as const) if (original[key] !== undefined && candidate[key] !== original[key]) return false;
  const proofSource = candidate.details?.proofSource;
  const resolution = candidate.details?.resolution;
  const serialization = candidate.details?.serialization;
  if (original.transactionOperation === "snapshot_read") return proofSource === "repeatable_read_read_only_discard_and_retry" && resolution === "no_durable_effect" && serialization === "fresh_repeatable_read_read_only_attempt";
  const expectedSerialization = original.transactionOperation === "outbox_publish" ? "outbox_row_lock" : "pg_advisory_xact_lock";
  return proofSource === "durable_transaction_attempt_marker" && (resolution === "committed" || resolution === "rolled_back") && serialization === expectedSerialization;
}

function transactionCorrelationKey(record: EvidenceRecord): string {
  return `${producerKey(record)}\u0000${record.transactionOperation ?? ""}\u0000${record.operationCorrelationId ?? ""}`;
}

function transactionProofKey(record: EvidenceRecord): string | undefined {
  if (!record.transactionId || !record.transactionOperation || !record.operationCorrelationId) return undefined;
  return `${transactionCorrelationKey(record)}\u0000${record.transactionId}\u0000${record.commandId ?? ""}\u0000${record.eventId ?? ""}\u0000${record.stream ?? ""}`;
}

function isOutcomeAttemptBoundary(boundary: string | undefined): boolean {
  return boundary === "db.committed" || boundary === "db.rolled_back" || boundary === "database.transaction_commit_invoked" || boundary === "database.transaction_outcome_indeterminate" || boundary === "database.transaction_reconciled" || boundary === "database.transaction_reconciliation_unresolved";
}

function hasExplicitCausalLink(previous: EvidenceRecord, current: EvidenceRecord): boolean {
  return current.causalParentRecordId === previous.recordId || (typeof current.causalHandoffId === "string" && current.causalHandoffId === previous.causalHandoffId);
}

function canOmitJourneyIdentity(previous: EvidenceRecord, current: EvidenceRecord, field: "commandAttemptId" | "transactionId" | "operationCorrelationId" | "eventId"): boolean {
  if (hasExplicitCausalLink(previous, current)) return true;
  return field === "eventId" && current.boundary === "replay.completed" && typeof current.traceId === "string" && current.traceId === previous.traceId && typeof current.stream === "string" && current.stream === previous.stream;
}

function ambiguityWitnesses(candidates: EvidenceRecord[], ambiguousField: "commandAttemptId" | "transactionId" | "operationCorrelationId" | undefined, conflictingOutcomes: boolean): EvidenceRecord[] {
  const ordered = [...candidates].sort((left, right) => left.recordSequence - right.recordSequence);
  const first = ordered[0]!;
  const witnesses = new Map([[first.recordId, first]]);
  if (ambiguousField) {
    const firstValue = first[ambiguousField] ?? "<missing>";
    const distinct = ordered.find((record) => (record[ambiguousField] ?? "<missing>") !== firstValue);
    if (distinct) witnesses.set(distinct.recordId, distinct);
  }
  if (conflictingOutcomes) {
    const distinct = ordered.find((record) => record.outcome !== first.outcome);
    if (distinct) witnesses.set(distinct.recordId, distinct);
  }
  const last = ordered[ordered.length - 1]!;
  witnesses.set(last.recordId, last);
  return [...witnesses.values()].sort((left, right) => left.recordSequence - right.recordSequence);
}
