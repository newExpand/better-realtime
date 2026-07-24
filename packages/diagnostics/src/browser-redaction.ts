import { keyedStableDigest } from "./hash.ts";
import type { EvidenceRecord } from "./types.ts";

const MAX_DETAIL_DEPTH = 8;
const MAX_DETAIL_ENTRIES = 64;
const pseudonymizedFields = [
  "recordId", "runtimeId", "runtimeBootId", "connectionId", "sessionId", "stream",
  "transactionId", "principalNamespaceId", "commandId", "commandAttemptId",
  "eventId", "traceId", "causalHandoffId", "causalParentRecordId", "resourceId",
  "ownerId"
] as const;
const identifierDetailKeys = new Set([
  "causalEventIds", "commandId", "connectionId", "deliveryId", "eventId", "ownerId",
  "principalNamespaceId", "requestId", "resourceId", "sessionId", "stream", "tenantId",
  "traceId", "transactionId"
]);
const numericDetailKeys = new Set([
  "actual", "after", "attempt", "bufferedAmount", "bytes", "causalEventPositions",
  "consumers", "count", "cursorSequence", "delay", "delivered", "eventSequence",
  "expected", "expectedSequence", "first", "from", "head", "headSequence", "index",
  "last", "maxBufferedBytes", "maxBytes", "maxMessageBytes", "maxRecords", "nextBytes",
  "nextMessageBytes", "nextRecords", "projectedSequence", "receivedSequence",
  "recordSequence", "requestedAfter", "sequence", "sessionGeneration", "snapshotBytes",
  "snapshotSequence", "socketWritableBytes", "through", "throughSequence", "timeoutMs",
  "maxRecoveryBufferBytes", "maxRecoveryBufferRecords"
]);
const booleanDetailKeys = new Set([
  "catchup", "claimed", "duplicate", "listenerDeliveryClaimed", "producerClaimed",
  "received", "retryable", "snapshotRequested", "durableReplay", "idempotentCommands",
  "commandReceipts", "fencedSnapshots"
]);
const safeDetailKeys = new Set([
  ...identifierDetailKeys,
  ...numericDetailKeys,
  ...booleanDetailKeys,
  "action", "capabilities", "capability", "code", "deliveryMode", "effectSchema",
  "expectedDirection", "intentHash", "intentHashVersion", "mode", "resumeStatus",
  "schema", "state", "status", "type", "wireState"
]);
const clientStates = new Set([
  "absent", "accepted", "active", "backing_off", "cancelled", "closed", "completed",
  "connecting", "created", "disposed", "disposing", "expired", "failed", "idle", "live",
  "observed", "open", "opening", "queued", "ready", "reauthenticating", "reconciling",
  "rejected", "replaying", "resyncing", "sent", "subscribing", "suspended", "unknown"
]);

export function pseudonymizeIdentifier(value: string, pseudonymizationKey: string): string {
  return `pseudonym:${keyedStableDigest(pseudonymizationKey, value)}`;
}

export function redactBrowserEvidenceRecord(record: EvidenceRecord, pseudonymizationKey: string): EvidenceRecord {
  const output: Record<string, unknown> = { ...record };
  delete output.previousRecordHash;
  for (const field of pseudonymizedFields) {
    if (typeof output[field] === "string") output[field] = pseudonymizeIdentifier(output[field] as string, pseudonymizationKey);
  }
  if (typeof output.operationCorrelationId === "string") {
    output.operationCorrelationId = `opcorr:${keyedStableDigest(pseudonymizationKey, output.operationCorrelationId)}`;
  }
  if (record.details) output.details = redactClientDetails(record.details, pseudonymizationKey);
  return output as unknown as EvidenceRecord;
}

function redactClientDetails(
  value: unknown,
  pseudonymizationKey: string,
  parentKey?: string,
  depth = 0
): unknown {
  if (depth > MAX_DETAIL_DEPTH) return "[REDACTED]";
  if (parentKey && identifierDetailKeys.has(parentKey) && (typeof value === "string" || typeof value === "number")) {
    return pseudonymizeIdentifier(String(value), pseudonymizationKey);
  }
  if (typeof value === "string") return safeClientString(parentKey, value) ? value : "[REDACTED]";
  if (typeof value === "number") {
    return parentKey && numericDetailKeys.has(parentKey) && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      ? value
      : "[REDACTED]";
  }
  if (typeof value === "boolean") return parentKey && booleanDetailKeys.has(parentKey) ? value : "[REDACTED]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ENTRIES).map((entry) =>
      redactClientDetails(entry, pseudonymizationKey, parentKey, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_DETAIL_ENTRIES)) {
    if (!safeDetailKeys.has(key)) continue;
    output[key] = redactClientDetails(entry, pseudonymizationKey, key, depth + 1);
  }
  return output;
}

function safeClientString(key: string | undefined, value: string): boolean {
  if (!key) return false;
  if (key === "code") return /^RT_[A-Z0-9_]{1,96}$/u.test(value);
  if (key === "intentHash") return false;
  if (key === "schema" || key === "effectSchema") return /^[A-Za-z][A-Za-z0-9_.-]{0,79}@[1-9][0-9]*$/u.test(value);
  if (key === "state" || key === "status" || key === "wireState") return clientStates.has(value);
  if (key === "action") return ["replay", "fenced_snapshot", "destroy_connection"].includes(value);
  if (key === "deliveryMode" || key === "mode") return ["live", "replay", "snapshot_catchup"].includes(value);
  return false;
}
