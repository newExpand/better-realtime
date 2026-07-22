export interface ClientEvidenceRecord {
  schemaVersion: "1.0"; producerRole: "client"; boundary: "command.observed"; outcome: "success"; commandId: string;
  eventId: string; causalHandoffId: string; runtimeId: string; runtimeBootId: string;
  recordId: string; recordSequence: number; kind: string; timestamp: string; monotonicNs: string; component: string; componentVersion: string;
  principalNamespaceId?: string;
}

export interface ClientEvidenceCapture {
  record: ClientEvidenceRecord;
  buffer: { capacity: number; retainedRecords: number; evictedRecords: number };
}

interface DogfoodEvidenceBundle {
  records: Array<{ tenantId: string; record: unknown }>;
  expectedProducerInstances: Array<{ producerRole: string; runtimeId: string; runtimeBootId: string }>;
}

export function attachClientEvidence(bundle: DogfoodEvidenceBundle, value: unknown, commandId: string): asserts value is ClientEvidenceCapture {
  if (!isClientEvidenceCapture(value, commandId)) throw new Error("RT_BROWSER_COMMAND_EVIDENCE_INVALID");
  if (value.buffer.evictedRecords !== 0) throw new Error(`RT_BROWSER_COMMAND_EVIDENCE_INCOMPLETE:evicted=${value.buffer.evictedRecords}`);
  const record = value.record;
  const principalNamespaces = new Set(bundle.records.flatMap(({ record: bundleRecord }) => {
    if (!bundleRecord || typeof bundleRecord !== "object") return [];
    const candidate = bundleRecord as { commandId?: unknown; eventId?: unknown; principalNamespaceId?: unknown };
    return candidate.commandId === commandId && candidate.eventId === record.eventId && typeof candidate.principalNamespaceId === "string" ? [candidate.principalNamespaceId] : [];
  }));
  if (principalNamespaces.size !== 1) throw new Error("RT_BROWSER_COMMAND_EVIDENCE_PRINCIPAL_AMBIGUOUS");
  const principalNamespaceId = [...principalNamespaces][0]!;
  bundle.records.push({ tenantId: "tenant-fixture", record: { ...record, principalNamespaceId } });
  bundle.expectedProducerInstances.push({ producerRole: "client", runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId });
}

function isClientEvidenceCapture(value: unknown, commandId: string): value is ClientEvidenceCapture {
  if (!value || typeof value !== "object") return false;
  const capture = value as Partial<ClientEvidenceCapture>;
  const buffer = capture.buffer;
  return isClientEvidence(capture.record, commandId) && Boolean(buffer) && Number.isSafeInteger(buffer!.capacity) && buffer!.capacity > 0 && Number.isSafeInteger(buffer!.retainedRecords) && buffer!.retainedRecords >= 0 && buffer!.retainedRecords <= buffer!.capacity && Number.isSafeInteger(buffer!.evictedRecords) && buffer!.evictedRecords >= 0;
}

function isClientEvidence(value: unknown, commandId: string): value is ClientEvidenceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ClientEvidenceRecord>;
  return record.schemaVersion === "1.0" && record.producerRole === "client" && record.boundary === "command.observed" && record.outcome === "success" && record.commandId === commandId && typeof record.eventId === "string" && record.causalHandoffId === `event:${record.eventId}` && typeof record.runtimeId === "string" && typeof record.runtimeBootId === "string";
}
