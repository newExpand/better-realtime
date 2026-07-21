import { describe, expect, it } from "vitest";
import type { SourceDiagnosticEvidenceRecord } from "../src/diagnostic-types.ts";
import { selectTenantEvidenceRecords } from "../src/evidence-scope.ts";

const record = (sequence: number, overrides: Partial<SourceDiagnosticEvidenceRecord>): SourceDiagnosticEvidenceRecord => ({
  schemaVersion: "1.0", recordId: `record-${sequence}`, recordSequence: sequence, kind: "test", timestamp: "2026-07-18T00:00:00.000Z", monotonicNs: String(sequence), producerRole: "server", runtimeId: "runtime", runtimeBootId: "boot", component: "test", componentVersion: "1.0.0", outcome: "success", ...overrides
});

describe("tenant evidence selection", () => {
  it("closes over strong correlation without joining colliding command or stream names", () => {
    const records = [
      record(1, { transactionId: "tx-a", commandId: "shared-command", stream: "room:42", details: { tenantId: "tenant-a" } }),
      record(2, { transactionId: "tx-a", commandId: "shared-command", stream: "room:42", boundary: "database.transaction_commit_acknowledged" }),
      record(3, { transactionId: "tx-b", commandId: "shared-command", stream: "room:42", details: { tenantId: "tenant-b" } }),
      record(4, { commandId: "shared-command", stream: "room:42", boundary: "unscoped-collision" }),
      record(5, { transactionId: "tx-a", details: { tenantId: "tenant-b" }, boundary: "explicit-cross-tenant" }),
      record(6, { traceId: "client-chosen-collision", details: { tenantId: "tenant-a" } }),
      record(7, { traceId: "client-chosen-collision", details: { tenantId: "tenant-b" } }),
      record(8, { traceId: "client-chosen-collision", boundary: "unscoped-trace-collision" })
    ];
    expect(selectTenantEvidenceRecords(records, "tenant-a").map((entry) => entry.recordSequence)).toEqual([1, 2, 6]);
  });
});
