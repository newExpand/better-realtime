import type { SourceDiagnosticEvidenceRecord } from "./diagnostic-types.js";

const correlationFields = ["transactionId", "operationCorrelationId", "eventId", "causalHandoffId", "sessionId"] as const;

export function selectTenantEvidenceRecords(records: readonly SourceDiagnosticEvidenceRecord[], tenantId: string): SourceDiagnosticEvidenceRecord[] {
  const selected = new Set(records.filter((record) => record.details?.tenantId === tenantId));
  const correlation = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of selected) for (const field of correlationFields) {
      const value = record[field];
      if (typeof value === "string" && !correlation.has(`${field}:${value}`)) { correlation.add(`${field}:${value}`); changed = true; }
    }
    for (const record of records) {
      if (selected.has(record) || (typeof record.details?.tenantId === "string" && record.details.tenantId !== tenantId)) continue;
      if (correlationFields.some((field) => typeof record[field] === "string" && correlation.has(`${field}:${record[field]}`))) { selected.add(record); changed = true; }
    }
  }
  return records.filter((record) => selected.has(record));
}
