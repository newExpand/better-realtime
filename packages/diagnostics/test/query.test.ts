import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { diagnosticQueryResultSchemaV1, FlightRecorder, LocalDiagnosticQuery, pseudonymizeIdentifier, resourceInventoryDigest, ResourceRegistry, type LocalEvidenceBundleV1 } from "../src/index.ts";

const tenantId = "tenant-a";
const pseudonymizationKey = "tenant-a-diagnostic-key-32-bytes-long";
const seededAwsKey = ["AK", "IAIOSFODNN7EXAMPLE"].join("");
const seededGithubToken = ["gh", "p_1234567890abcdefghijklmnop"].join("");
const seededMacPath = ["/", "Users/alice/private/customer.json"].join("");

function bundle(overrides: Partial<LocalEvidenceBundleV1> = {}): LocalEvidenceBundleV1 {
  const recorder = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "boot-a", producerRole: "server" });
  recorder.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", component: "gateway", componentVersion: "test", commandId: "cmd-a", eventId: "evt-a", stream: "room:42", details: { tenantId, commandId: "nested-command-id", principalNamespaceId: "principal-stable-across-bundles", outboxId: 123, outboxIds: [123, 124], proofSource: seededAwsKey, operation: "sk_live_51NqYExampleCredential", captureId: seededGithubToken, response: "Authorization: Bearer sk-live-secret", reason: seededMacPath, expected: "password=hunter2", actual: "token=secret", capabilities: { proofSource: 4_111_111_111_111_111, response: true }, payload: { secret: "must-not-leak" }, password: "hunter2", email: "private@example.test", nested: { accessToken: "token-value" }, credentials: "plural-leaks", api_key: "underscore-leaks", privateKey: "private-leaks", sessionCookie: "cookie-leaks", clientCertificate: "certificate-leaks", error: "query contained a private value", intentHash: `sha256:${"a".repeat(64)}` } });
  recorder.record({ kind: "event.delivered", boundary: "event.delivery_attempted", outcome: "success", component: "gateway", componentVersion: "test", commandId: "cmd-a", eventId: "evt-a", stream: "room:42", details: { tenantId, principalNamespaceId: "principal-stable-across-bundles", body: "private body" } });
  recorder.record({ kind: "event.delivered", boundary: "event.delivery_attempted", outcome: "success", component: "gateway", componentVersion: "test", commandId: "cmd-b", eventId: "evt-b", stream: "room:42", details: { tenantId, principalNamespaceId: "principal-stable-across-bundles" } });
  return {
    schemaVersion: "1.0",
    tenantId,
    payloadPolicy: "redacted",
    pseudonymizationKey,
    records: recorder.records().map((record) => ({ tenantId, record })),
    resources: [],
    resourceCapture: "unavailable",
    loss: { droppedRecords: 0, evictedRecords: 0 },
    expectedProducerInstances: [{ producerRole: "server", runtimeId: "gateway", runtimeBootId: "boot-a" }],
    ...overrides
  };
}

describe("local diagnostic query", () => {
  it("paginates immutable raw evidence with redacted payload provenance and covered ranges", () => {
    const query = new LocalDiagnosticQuery(bundle());
    const first = query.rawEvidence({ tenantId, limit: 2 });
    expect(first).toMatchObject({ queryVersion: "1.0", schemaVersion: "1.0", kind: "raw_evidence", tenantId: pseudonymizeIdentifier(tenantId, pseudonymizationKey), hasMore: true, omittedCount: 1, completeness: { status: "partial" }, provenance: { payloadPolicy: "redacted", source: "local_evidence_bundle" } });
    expect(first.coveredRanges).toEqual([{ producerRole: "server", runtimeId: pseudonymizeIdentifier("gateway", pseudonymizationKey), runtimeBootId: pseudonymizeIdentifier("boot-a", pseudonymizationKey), first: 1, last: 2, count: 2 }]);
    expect(first.records[0]?.details).toMatchObject({ commandId: expect.stringMatching(/^pseudonym:sha256:/), principalNamespaceId: expect.stringMatching(/^pseudonym:sha256:/), outboxId: expect.stringMatching(/^pseudonym:sha256:/), outboxIds: [expect.stringMatching(/^pseudonym:sha256:/), expect.stringMatching(/^pseudonym:sha256:/)], intentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect((first.records[0]?.details as { intentHash: string }).intentHash).not.toBe(`sha256:${"a".repeat(64)}`);
    expect(Object.keys(first.records[0]?.details ?? {})).not.toEqual(expect.arrayContaining(["password", "email", "payload", "nested", "api_key", "privateKey"]));
    expect(first.provenance.redactedFields).toBeGreaterThanOrEqual(27);
    for (const forbidden of ["sk-live-secret", seededMacPath, "hunter2", "token=secret", "principal-stable-across-bundles", seededAwsKey, "sk_live_", "ghp_", '"outboxId":123']) expect(JSON.stringify(first)).not.toContain(forbidden);
    expect(JSON.stringify(first)).not.toMatch(/must-not-leak|hunter2|private@example|private value|token-value|plural-leaks|underscore-leaks|private-leaks|cookie-leaks|certificate-leaks/u);
    expect(first.records[0]).toMatchObject({ commandId: pseudonymizeIdentifier("cmd-a", pseudonymizationKey), stream: pseudonymizeIdentifier("room:42", pseudonymizationKey) });
    expect(first.nextCursor).toMatch(/^dq1\./);
    expect(first.nextCursor).toBeDefined();
    const second = query.rawEvidence({ tenantId, limit: 2, cursor: first.nextCursor! });
    expect(second.records.map((record) => record.recordSequence)).toEqual([3]);
    expect(second).toMatchObject({ hasMore: false, omittedCount: 2 });
  });

  it("provides bounded command trace and stream inspection", () => {
    const query = new LocalDiagnosticQuery(bundle());
    const trace = query.traceCommand({ tenantId, commandId: "cmd-a", limit: 1 });
    expect(trace.records).toHaveLength(1);
    expect(trace).toMatchObject({ kind: "trace_command", commandId: pseudonymizeIdentifier("cmd-a", pseudonymizationKey), hasMore: true });
    const stream = query.inspectStream({ tenantId, stream: "room:42", limit: 2 });
    expect(stream).toMatchObject({ kind: "inspect_stream", stream: pseudonymizeIdentifier("room:42", pseudonymizationKey), hasMore: true });
  });

  it("reuses doctor and cannot prove missing producers or unresolved transactions", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-a", producerRole: "database" });
    const operationCorrelationId = `opcorr:sha256:${"a".repeat(64)}` as const;
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-a", transactionOperation: "command", operationCorrelationId, commandId: "cmd-a", details: { tenantId, principalNamespaceId: "principal-stable-across-bundles" } });
    const query = new LocalDiagnosticQuery(bundle({
      records: database.records().map((record) => ({ tenantId, record })),
      expectedProducerInstances: [
        { producerRole: "database", runtimeId: "database", runtimeBootId: "db-a" },
        { producerRole: "server", runtimeId: "gateway", runtimeBootId: "boot-a" }
      ]
    }));
    const result = query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }, { producerRole: "server", boundary: "command.completed" }], expectedProducers: ["database", "server"], scope: { commandId: "cmd-a" }, expectedOutcome: "command committed" });
    expect(result.report.verdict).toBe("indeterminate");
    expect(result.completeness).toMatchObject({ status: "partial", missingProducerInstances: [{ producerRole: "server", runtimeId: pseudonymizeIdentifier("gateway", pseudonymizationKey), runtimeBootId: pseudonymizeIdentifier("boot-a", pseudonymizationKey) }] });
  });

  it("reports leaks honestly and refuses proven when capture is incomplete", () => {
    const recorder = new FlightRecorder({ runtimeId: "client", runtimeBootId: "client-a", producerRole: "client" });
    const registry = new ResourceRegistry(recorder);
    registry.acquire("timer", "owner-a", () => undefined);
    const query = new LocalDiagnosticQuery(bundle({ resources: registry.active(), loss: { droppedRecords: 1, evictedRecords: 0 } }));
    expect(query.leaks({ tenantId })).toMatchObject({ kind: "leaks", verdict: "indeterminate", activeCount: 1, completeness: { status: "partial" } });
    expect(new LocalDiagnosticQuery(bundle({ resourceCapture: "unavailable", resources: [] })).leaks({ tenantId })).toMatchObject({ verdict: "indeterminate", resourceCapture: "unavailable", completeness: { status: "partial" } });

    const capture = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "boot-a", producerRole: "server" });
    const resources = registry.active();
    const proof = { captureId: "capture-a", capturedAt: "2026-07-18T00:00:00.000Z", inventoryCount: resources.length, inventoryDigest: resourceInventoryDigest(resources, pseudonymizationKey) };
    capture.record({ kind: "resource.inventory_captured", boundary: "resource.inventory_captured", outcome: "success", component: "gateway", componentVersion: "test", details: { tenantId, ...proof } });
    const captured = bundle({ records: capture.records().map((record) => ({ tenantId, record })), resources, resourceCapture: "complete", resourceCaptureProof: proof });
    expect(new LocalDiagnosticQuery(captured).leaks({ tenantId })).toMatchObject({ verdict: "indeterminate", captureProof: "proven", activeCount: 1, completeness: { status: "complete" } });
    expect(new LocalDiagnosticQuery({ ...captured, resources: [] })).toBeDefined();
    expect(new LocalDiagnosticQuery({ ...captured, resources: [] }).leaks({ tenantId })).toMatchObject({ verdict: "indeterminate", captureProof: "missing", activeCount: 0 });
    const emptyProof = { ...proof, inventoryCount: 0, inventoryDigest: resourceInventoryDigest([], pseudonymizationKey) };
    const emptyCapture = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "boot-a", producerRole: "server" });
    emptyCapture.record({ kind: "resource.inventory_captured", boundary: "resource.inventory_captured", outcome: "success", component: "gateway", componentVersion: "test", details: { tenantId, ...emptyProof } });
    expect(new LocalDiagnosticQuery(bundle({ records: emptyCapture.records().map((record) => ({ tenantId, record })), resources: [], resourceCapture: "complete", resourceCaptureProof: emptyProof })).leaks({ tenantId })).toMatchObject({ verdict: "proven", captureProof: "proven", activeCount: 0 });
  });

  it("rejects invalid cursor, limit, tenant mismatch, bundle contamination, and unsupported conclusions", () => {
    const query = new LocalDiagnosticQuery(bundle());
    expect(() => query.rawEvidence({ tenantId, cursor: "not-a-cursor" })).toThrow("RT_DIAGNOSTIC_CURSOR_INVALID");
    expect(() => query.rawEvidence({ tenantId, limit: 0 })).toThrow("RT_DIAGNOSTIC_LIMIT_INVALID");
    expect(() => query.rawEvidence({ tenantId: "tenant-b" })).toThrow("RT_DIAGNOSTIC_TENANT_MISMATCH");
    expect(() => new LocalDiagnosticQuery(bundle({ records: bundle().records.map((entry) => ({ ...entry, tenantId: "tenant-b" })) }))).toThrow("RT_DIAGNOSTIC_TENANT_MISMATCH");
    expect(() => query.query({ kind: "prove_ui_paint", tenantId } as never)).toThrow("RT_DIAGNOSTIC_CONCLUSION_UNSUPPORTED");
    expect(() => query.query({ kind: "raw_evidence", tenantId, unexpected: true } as never)).toThrow("RT_DIAGNOSTIC_QUERY_INVALID");
    expect(() => query.query({ kind: "raw_evidence", tenantId, filters: { commandId: 42 } } as never)).toThrow("RT_DIAGNOSTIC_QUERY_INVALID");
    expect(() => new LocalDiagnosticQuery({ ...bundle(), expectedProducerInstances: [] })).toThrow("RT_DIAGNOSTIC_BUNDLE_INVALID");
    expect(() => new LocalDiagnosticQuery(({ ...bundle(), expectedProducerInstances: undefined }) as never)).toThrow("RT_DIAGNOSTIC_BUNDLE_INVALID");
    expect(() => new LocalDiagnosticQuery(({ ...bundle(), resourceCapture: "complete", resourceCaptureProof: undefined }) as never)).toThrow("RT_DIAGNOSTIC_BUNDLE_INVALID");
    expect(() => new LocalDiagnosticQuery(({ ...bundle(), pseudonymizationKey: undefined }) as never)).toThrow("RT_DIAGNOSTIC_BUNDLE_INVALID");
    const duplicateRecordId = bundle();
    duplicateRecordId.records[1]!.record.recordId = duplicateRecordId.records[0]!.record.recordId;
    expect(() => new LocalDiagnosticQuery(duplicateRecordId)).toThrow("RT_DIAGNOSTIC_BUNDLE_INVALID");
    const duplicateSequence = bundle();
    duplicateSequence.records[1]!.record.recordSequence = duplicateSequence.records[0]!.record.recordSequence;
    expect(() => new LocalDiagnosticQuery(duplicateSequence)).toThrow("RT_DIAGNOSTIC_BUNDLE_INVALID");
    const mismatchedPrincipal = bundle();
    mismatchedPrincipal.records[0]!.record.principalNamespaceId = "principal-a";
    mismatchedPrincipal.records[0]!.record.details = { ...mismatchedPrincipal.records[0]!.record.details, principalNamespaceId: "principal-b" };
    expect(() => new LocalDiagnosticQuery(mismatchedPrincipal)).toThrow("RT_DIAGNOSTIC_BUNDLE_INVALID");
    const wrongTopology = new LocalDiagnosticQuery(bundle({ expectedProducerInstances: [{ producerRole: "database", runtimeId: "db", runtimeBootId: "db-boot" }] }));
    expect(() => wrongTopology.doctor({ tenantId, expectedBoundaries: [{ producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server"], expectedOutcome: "command completed" })).toThrow("RT_DIAGNOSTIC_TOPOLOGY_INCOMPLETE");
  });

  it("mechanically rejects malformed kind-specific query results", () => {
    const validate = new Ajv2020({ strict: false }).compile(diagnosticQueryResultSchemaV1);
    expect(validate({ queryVersion: "1.0", schemaVersion: "1.0", tenantId, kind: "doctor", completeness: { status: "complete", droppedRecords: 0, evictedRecords: 0, expectedProducerInstances: ["server"], observedProducerInstances: [], missingProducerInstances: [], sourceCoveredRanges: [null] }, provenance: { source: "local_evidence_bundle", payloadPolicy: "redacted", redactedFields: 0 } })).toBe(false);
    const base = { queryVersion: "1.0", schemaVersion: "1.0", tenantId, completeness: { status: "complete", droppedRecords: 0, evictedRecords: 0, expectedProducerInstances: [], observedProducerInstances: [], missingProducerInstances: [], sourceCoveredRanges: [] }, provenance: { source: "local_evidence_bundle", payloadPolicy: "redacted", redactedFields: 0 } };
    expect(validate({ ...base, kind: "doctor", report: {} })).toBe(false);
    expect(validate({ ...base, kind: "raw_evidence", records: [{ password: "plaintext" }], coveredRanges: [], hasMore: false, omittedCount: 0 })).toBe(false);
    expect(validate({ ...base, kind: "raw_evidence", records: [{ schemaVersion: "1.0", recordId: "record", recordSequence: 1, kind: "test", timestamp: "2026-07-18T00:00:00.000Z", monotonicNs: "1", producerRole: "database", runtimeId: "runtime", runtimeBootId: "boot", component: "store", componentVersion: "test", outcome: "success", transactionOperation: "not_a_real_operation" }], coveredRanges: [], hasMore: false, omittedCount: 0 })).toBe(false);
    expect(validate({ ...base, kind: "doctor", report: {}, records: [] })).toBe(false);
    expect(validate({ ...base, kind: "doctor", report: { schemaVersion: "1.0", verdict: "proven", expectedOutcome: "safe", actualOutcome: "safe", issues: [{ code: "bad", severity: "warning", summary: "bad", lastSuccessfulBoundary: { password: "plaintext" }, firstDivergentBoundary: { status: "unknown", reason: "none" }, component: null, componentVersion: null }], completeness: { status: "bogus", droppedRecords: "0", evictedRecords: 0, expectedProducers: [], observedProducers: [], missingProducers: [], expectedProducerInstances: [], observedProducerInstances: [], missingProducerInstances: [] }, scope: { password: "plaintext" }, producerRanges: [] } })).toBe(false);
    const valid = new LocalDiagnosticQuery(bundle()).rawEvidence({ tenantId });
    expect(validate(valid)).toBe(true);
    const contaminated = structuredClone(valid) as unknown as Record<string, any>;
    contaminated.tenantId = "raw-customer@example.test";
    contaminated.records[0].recordId = "raw-record";
    contaminated.records[0].runtimeId = "raw-runtime";
    contaminated.records[0].previousRecordHash = `sha256:${"f".repeat(64)}`;
    contaminated.records[0].details = { password: "plaintext", payload: { token: "secret" } };
    expect(validate(contaminated)).toBe(false);
  });

  it("binds required boundaries and continuation cursors to the declared topology and source snapshot", () => {
    const unrelated = new FlightRecorder({ runtimeId: "gateway-b", runtimeBootId: "boot-b", producerRole: "server" });
    unrelated.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", component: "gateway", componentVersion: "test", commandId: "cmd-a", details: { tenantId, principalNamespaceId: "principal-stable-across-bundles" } });
    const declared = bundle();
    const query = new LocalDiagnosticQuery({ ...declared, records: [...declared.records.filter((entry) => entry.record.boundary !== "command.completed"), ...unrelated.records().map((record) => ({ tenantId, record }))] });
    const report = query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server"], scope: { commandId: "cmd-a" }, expectedOutcome: "command completed" });
    expect(report.report.verdict).toBe("indeterminate");
    expect(report.report.producerRanges.every((range) => range.runtimeId === pseudonymizeIdentifier("gateway", pseudonymizationKey))).toBe(true);

    const multiRole = new LocalDiagnosticQuery({ ...declared, records: [...declared.records, ...unrelated.records().map((record) => ({ tenantId, record }))], expectedProducerInstances: [...declared.expectedProducerInstances, { producerRole: "server", runtimeId: "gateway-b", runtimeBootId: "boot-b" }] });
    expect(multiRole.doctor({ tenantId, expectedBoundaries: [{ producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server"], scope: { commandId: "cmd-a" }, expectedOutcome: "command completed" }).report).toMatchObject({ verdict: "indeterminate", issues: [{ summary: expect.stringContaining("exactly one expected producer instance") }] });

    const first = new LocalDiagnosticQuery(bundle()).rawEvidence({ tenantId, limit: 1 });
    const changed = bundle({ records: bundle().records.slice(1) });
    expect(() => new LocalDiagnosticQuery(changed).rawEvidence({ tenantId, limit: 1, cursor: first.nextCursor! })).toThrow("RT_DIAGNOSTIC_CURSOR_INVALID");
    const hiddenPayloadChanged = bundle();
    hiddenPayloadChanged.records[0]!.record.details = { ...hiddenPayloadChanged.records[0]!.record.details, payload: { secret: "different-hidden-value" } };
    expect(() => new LocalDiagnosticQuery(hiddenPayloadChanged).rawEvidence({ tenantId, limit: 1, cursor: first.nextCursor! })).toThrow("RT_DIAGNOSTIC_CURSOR_INVALID");
    const cursorParts = first.nextCursor!.split(".");
    cursorParts[1] = `${cursorParts[1]!.slice(0, -1)}${cursorParts[1]!.endsWith("A") ? "B" : "A"}`;
    expect(() => new LocalDiagnosticQuery(bundle()).rawEvidence({ tenantId, limit: 1, cursor: cursorParts.join(".") })).toThrow("RT_DIAGNOSTIC_CURSOR_INVALID");
  });

  it("requires causal command proof and exposes a bounded auditable evidence closure", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-a", producerRole: "database" });
    const server = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "gateway-a", producerRole: "server" });
    const operationCorrelationId = `opcorr:sha256:${"c".repeat(64)}` as const;
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store-postgres", componentVersion: "test", transactionId: "tx-a", transactionOperation: "command", operationCorrelationId, principalNamespaceId: "principal-a", commandId: "cmd-causal", eventId: "event-a", causalHandoffId: "event:event-a", details: { tenantId, principalNamespaceId: "principal-a", proofSource: "commit_acknowledgement" } });
    server.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", component: "gateway", componentVersion: "test", principalNamespaceId: "principal-a", commandId: "cmd-causal", eventId: "event-a", causalHandoffId: "event:event-b", details: { tenantId, principalNamespaceId: "principal-a" } });
    const source = bundle({
      records: [...database.records(), ...server.records()].map((record) => ({ tenantId, record })),
      expectedProducerInstances: [{ producerRole: "database", runtimeId: "database", runtimeBootId: "db-a" }, { producerRole: "server", runtimeId: "gateway", runtimeBootId: "gateway-a" }]
    });
    const query = new LocalDiagnosticQuery(source);
    const request = { tenantId, expectedBoundaries: [{ producerRole: "database" as const, boundary: "db.committed" }, { producerRole: "server" as const, boundary: "command.completed" }], expectedProducers: ["database" as const, "server" as const], scope: { commandId: "cmd-causal" }, expectedOutcome: "command completed", requireCausalHandoffs: true };
    expect(query.doctor(request).report.verdict).toBe("indeterminate");
    expect(query.doctor({ ...request, requireCausalHandoffs: false }).report.verdict).toBe("indeterminate");

    source.records[1]!.record.eventId = "event-a";
    source.records[1]!.record.causalHandoffId = "event:event-a";
    const matching = new LocalDiagnosticQuery(source);
    const result = matching.doctor(request);
    expect(result.report).toMatchObject({ verdict: "proven", lastSuccessfulBoundary: { status: "known", evidence: [expect.any(String)] }, firstDivergentBoundary: { status: "unknown" } });
    expect(result.report.evidenceClosure).toEqual([
      expect.objectContaining({ boundary: "db.committed", transactionId: expect.any(String), operationCorrelationId: expect.any(String), eventId: expect.any(String), causalHandoffId: expect.any(String), proofSource: "commit_acknowledgement" }),
      expect.objectContaining({ boundary: "command.completed", eventId: expect.any(String), causalHandoffId: expect.any(String) })
    ]);
    const closure = matching.evidenceClosure({ tenantId, reference: result.evidenceReference.reference, limit: 1 });
    expect(closure).toMatchObject({ kind: "evidence_closure", evidenceReference: result.evidenceReference, records: [expect.objectContaining({ boundary: "db.committed" })], hasMore: true });
    expect(() => matching.evidenceClosure({ tenantId, reference: `${result.evidenceReference.reference.slice(0, -1)}${result.evidenceReference.reference.endsWith("0") ? "1" : "0"}` })).toThrow("RT_DIAGNOSTIC_EVIDENCE_REFERENCE_INVALID");
    expect(() => new LocalDiagnosticQuery(source).evidenceClosure({ tenantId, reference: result.evidenceReference.reference })).toThrow("RT_DIAGNOSTIC_EVIDENCE_REFERENCE_INVALID");
  });

  it("includes divergence and durable reconciliation dependencies in the expandable closure", () => {
    const operationCorrelationId = `opcorr:sha256:${"d".repeat(64)}` as const;
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-a", producerRole: "database" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store-postgres", componentVersion: "test", transactionId: "tx-a", transactionOperation: "command", operationCorrelationId, principalNamespaceId: "principal-a", commandId: "cmd-a", eventId: "event-a", causalHandoffId: "event:event-a", details: { tenantId, principalNamespaceId: "principal-a", proofSource: "commit_ack_unavailable" } });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store-postgres", componentVersion: "test", transactionId: "tx-a", transactionOperation: "command", operationCorrelationId, principalNamespaceId: "principal-a", commandId: "cmd-a", eventId: "event-a", causalHandoffId: "event:event-a", details: { tenantId, principalNamespaceId: "principal-a", resolution: "committed", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store-postgres", componentVersion: "test", transactionId: "tx-a", transactionOperation: "command", operationCorrelationId, principalNamespaceId: "principal-a", commandId: "cmd-a", eventId: "event-a", causalHandoffId: "event:event-a", details: { tenantId, principalNamespaceId: "principal-a", proofSource: "durable_transaction_attempt_marker" } });
    const source = bundle({ records: database.records().map((record) => ({ tenantId, record })), expectedProducerInstances: [{ producerRole: "database", runtimeId: "database", runtimeBootId: "db-a" }] });
    const query = new LocalDiagnosticQuery(source);
    const result = query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId: "cmd-a" }, expectedOutcome: "committed" });
    expect(result.report.verdict).toBe("proven");
    expect(result.report.evidenceClosure.map((entry) => entry.purpose)).toEqual(["transaction_indeterminate", "reconciliation_proof", "matched_boundary"]);
    const expanded = query.evidenceClosure({ tenantId, reference: result.evidenceReference.reference });
    expect(expanded.records.map((record) => record.recordId)).toEqual(result.report.evidenceClosure.map((entry) => entry.recordId));

    const failed = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-failed", producerRole: "database" });
    failed.record({ kind: "database.transaction_rolled_back", boundary: "db.committed", outcome: "failure", reasonCode: "RT_TRANSACTION_ROLLED_BACK", component: "store-postgres", componentVersion: "test", principalNamespaceId: "principal-a", commandId: "cmd-failed", details: { tenantId, principalNamespaceId: "principal-a", proofSource: "postgres_error_response" } });
    const failedQuery = new LocalDiagnosticQuery(bundle({ records: failed.records().map((record) => ({ tenantId, record })), expectedProducerInstances: [{ producerRole: "database", runtimeId: "database", runtimeBootId: "db-failed" }] }));
    const failedResult = failedQuery.doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId: "cmd-failed" }, expectedOutcome: "committed" });
    expect(failedResult.report).toMatchObject({ verdict: "disproven", firstDivergentBoundary: { status: "known" }, evidenceClosure: [expect.objectContaining({ purpose: "divergent_boundary", outcome: "failure" })] });
    expect(failedQuery.evidenceClosure({ tenantId, reference: failedResult.evidenceReference.reference }).records).toHaveLength(1);

    const reconciledFailure = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-reconciled-failure", producerRole: "database" });
    const reconciledFailureFields = { transactionId: "tx-reconciled-failure", transactionOperation: "command" as const, operationCorrelationId, principalNamespaceId: "principal-a", commandId: "cmd-reconciled-failure", eventId: "event-reconciled-failure", causalHandoffId: "event:event-reconciled-failure" };
    reconciledFailure.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store-postgres", componentVersion: "test", ...reconciledFailureFields, details: { tenantId, principalNamespaceId: "principal-a", proofSource: "commit_ack_unavailable" } });
    reconciledFailure.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store-postgres", componentVersion: "test", ...reconciledFailureFields, details: { tenantId, principalNamespaceId: "principal-a", resolution: "rolled_back", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    reconciledFailure.record({ kind: "database.transaction_rolled_back", boundary: "db.committed", outcome: "failure", reasonCode: "RT_TRANSACTION_ROLLED_BACK", component: "store-postgres", componentVersion: "test", ...reconciledFailureFields, details: { tenantId, principalNamespaceId: "principal-a", resolution: "rolled_back", proofSource: "durable_transaction_attempt_marker" } });
    const reconciledFailureQuery = new LocalDiagnosticQuery(bundle({ records: reconciledFailure.records().map((record) => ({ tenantId, record })), expectedProducerInstances: [{ producerRole: "database", runtimeId: "database", runtimeBootId: "db-reconciled-failure" }] }));
    const reconciledFailureResult = reconciledFailureQuery.doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId: "cmd-reconciled-failure" }, expectedOutcome: "committed" });
    expect(reconciledFailureResult.report.verdict).toBe("disproven");
    expect(reconciledFailureResult.report.evidenceClosure.map((entry) => entry.purpose)).toEqual(["transaction_indeterminate", "reconciliation_proof", "divergent_boundary"]);
    expect(reconciledFailureQuery.evidenceClosure({ tenantId, reference: reconciledFailureResult.evidenceReference.reference }).records.map((record) => record.recordId)).toEqual(reconciledFailureResult.report.evidenceClosure.map((entry) => entry.recordId));
  });

  it("always treats query identifiers as raw and uses a bundle-scoped key", () => {
    const prefixLike = "pseudonym:sha256:victim@example.test";
    const original = bundle();
    const source = bundle({ records: original.records.map((entry, index) => index === 0 ? { ...entry, record: { ...entry.record, commandId: prefixLike, stream: prefixLike } } : entry) });
    const first = new LocalDiagnosticQuery(source).traceCommand({ tenantId, commandId: prefixLike });
    expect(first.records).toHaveLength(1);
    expect(first.commandId).toBe(pseudonymizeIdentifier(prefixLike, pseudonymizationKey));
    expect(JSON.stringify(first)).not.toContain("victim@example.test");
    expect(first.commandId).not.toBe(prefixLike);
    const otherKey = "tenant-a-other-diagnostic-key-32-bytes";
    expect(pseudonymizeIdentifier("cmd-a", pseudonymizationKey)).not.toBe(pseudonymizeIdentifier("cmd-a", otherKey));
    const otherBundle = { ...original, pseudonymizationKey: otherKey };
    const principalA = (new LocalDiagnosticQuery(original).rawEvidence({ tenantId }).records[0]?.details as { principalNamespaceId?: string }).principalNamespaceId;
    const principalB = (new LocalDiagnosticQuery(otherBundle).rawEvidence({ tenantId }).records[0]?.details as { principalNamespaceId?: string }).principalNamespaceId;
    expect(principalA).toMatch(/^pseudonym:sha256:/);
    expect(principalB).toMatch(/^pseudonym:sha256:/);
    expect(principalA).not.toBe(principalB);
  });

  it("key-transforms low-entropy correlation and intent digests without breaking in-bundle linkage", () => {
    const operationCorrelationId = `opcorr:sha256:${"1".repeat(64)}` as const;
    const intentHash = `sha256:${"2".repeat(64)}`;
    const source = bundle();
    source.records = source.records.slice(0, 2).map((entry, index) => ({ ...entry, record: { ...entry.record, recordId: `digest-${index}`, recordSequence: index + 1, operationCorrelationId, details: { tenantId, principalNamespaceId: "principal-stable-across-bundles", intentHash } } }));
    const query = new LocalDiagnosticQuery(source);
    const page = query.rawEvidence({ tenantId, filters: { operationCorrelationId } });
    expect(page.records).toHaveLength(2);
    expect(page.records[0]?.operationCorrelationId).toMatch(/^opcorr:sha256:[a-f0-9]{64}$/);
    expect(page.records[0]?.operationCorrelationId).not.toBe(operationCorrelationId);
    expect(page.records[0]?.operationCorrelationId).toBe(page.records[1]?.operationCorrelationId);
    const publicIntent = (page.records[0]?.details as { intentHash: string }).intentHash;
    expect(publicIntent).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(publicIntent).not.toBe(intentHash);
    expect(publicIntent).toBe((page.records[1]?.details as { intentHash: string }).intentHash);

    const other = { ...source, pseudonymizationKey: "another-tenant-scoped-diagnostic-key" };
    const otherPage = new LocalDiagnosticQuery(other).rawEvidence({ tenantId, filters: { operationCorrelationId } });
    expect(otherPage.records[0]?.operationCorrelationId).not.toBe(page.records[0]?.operationCorrelationId);
    expect((otherPage.records[0]?.details as { intentHash: string }).intentHash).not.toBe(publicIntent);
  });

  it("never promotes normalized detail aliases into authoritative proof fields", () => {
    const source = bundle();
    source.records = source.records.map((entry, index) => index === 0 ? {
      ...entry,
      record: {
        ...entry.record,
        details: {
          tenantId,
          principalNamespaceId: "principal-stable-across-bundles",
          proofSource: "commit_ack_unavailable",
          "proof💣Source": "durable_transaction_attempt_marker"
        }
      }
    } : entry);
    const record = new LocalDiagnosticQuery(source).rawEvidence({ tenantId }).records[0]!;
    expect(record.details).toMatchObject({ proofSource: "commit_ack_unavailable" });
    expect(Object.keys(record.details ?? {})).not.toContain("proof💣Source");
  });

  it("preserves only closed correctness enums and removes private hash linkage", () => {
    const source = bundle();
    source.records = source.records.slice(0, 1);
    source.records[0]!.record.previousRecordHash = `sha256:${"f".repeat(64)}`;
    source.records[0]!.record.details = { tenantId, principalNamespaceId: "principal-stable-across-bundles", action: "rollback", outcomeProof: false, state: "commit_in_flight", deliveryMode: "replay", wireState: "unknown", status: "completed" };
    const record = new LocalDiagnosticQuery(source).rawEvidence({ tenantId }).records[0]!;
    expect(record.previousRecordHash).toBeUndefined();
    expect(record.details).toMatchObject({ action: "rollback", outcomeProof: false, state: "commit_in_flight", deliveryMode: "replay", wireState: "unknown", status: "completed" });
    source.records[0]!.record.details = { tenantId, principalNamespaceId: "principal-stable-across-bundles", action: "customer secret", state: "customer secret", outcomeProof: "false" };
    const rejected = new LocalDiagnosticQuery(source).rawEvidence({ tenantId }).records[0]!.details;
    expect(rejected).toMatchObject({ action: "[REDACTED]", state: "[REDACTED]", outcomeProof: "[REDACTED]" });
  });

  it("pseudonymizes issuer and observer principals independently", () => {
    const source = bundle();
    source.records = source.records.slice(0, 1);
    source.records[0]!.record.principalNamespaceId = "issuer-principal";
    source.records[0]!.record.details = { tenantId, principalNamespaceId: "issuer-principal", observerPrincipalNamespaceId: "observer-principal" };
    const details = new LocalDiagnosticQuery(source).rawEvidence({ tenantId }).records[0]!.details as Record<string, string>;
    expect(details.principalNamespaceId).toMatch(/^pseudonym:sha256:/);
    expect(details.observerPrincipalNamespaceId).toMatch(/^pseudonym:sha256:/);
    expect(details.observerPrincipalNamespaceId).not.toBe(details.principalNamespaceId);
    expect(JSON.stringify(details)).not.toMatch(/issuer-principal|observer-principal/u);
  });

  it("rejects empty or role-incoherent doctor contracts before drawing a conclusion", () => {
    const query = new LocalDiagnosticQuery(bundle());
    expect(() => query.doctor({ tenantId, expectedBoundaries: [], expectedProducers: [], expectedOutcome: "nothing" })).toThrow("RT_DIAGNOSTIC_QUERY_INVALID");
    expect(() => query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server", "database"], expectedOutcome: "command completed" })).toThrow("RT_DIAGNOSTIC_QUERY_INVALID");
    expect(() => query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "server", boundary: "customer-secret@example.test" }], expectedProducers: ["server"], expectedOutcome: "command completed" })).toThrow("RT_DIAGNOSTIC_QUERY_INVALID");
  });

  it("never splices the same command id across principals", () => {
    const recorder = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "boot-a", producerRole: "server" });
    recorder.record({ kind: "command.received", boundary: "command.received", outcome: "success", component: "gateway", componentVersion: "test", commandId: "shared", details: { tenantId, principalNamespaceId: "principal-a" } });
    recorder.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", component: "gateway", componentVersion: "test", commandId: "shared", details: { tenantId, principalNamespaceId: "principal-b" } });
    const query = new LocalDiagnosticQuery(bundle({ records: recorder.records().map((record) => ({ tenantId, record })) }));
    expect(() => query.traceCommand({ tenantId, commandId: "shared" })).toThrow("RT_DIAGNOSTIC_SCOPE_AMBIGUOUS");
    expect(() => query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "server", boundary: "command.received" }, { producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server"], scope: { commandId: "shared" }, expectedOutcome: "command completed" })).toThrow("RT_DIAGNOSTIC_SCOPE_AMBIGUOUS");
  });

  it("normalizes transaction filters and reports pseudonymization provenance for every query kind", () => {
    const source = bundle();
    source.records[0]!.record.transactionId = "transaction-raw";
    const query = new LocalDiagnosticQuery(source);
    const raw = query.rawEvidence({ tenantId, filters: { transactionId: "transaction-raw" } });
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0]?.transactionId).toBe(pseudonymizeIdentifier("transaction-raw", pseudonymizationKey));
    expect(raw.provenance.redactedFields).toBeGreaterThan(0);
    const doctorResult = query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server"], scope: { commandId: "cmd-a" }, expectedOutcome: "secret configured outcome" });
    expect(doctorResult.provenance.redactedFields).toBeGreaterThan(0);
    expect(JSON.stringify(doctorResult)).not.toContain("secret configured outcome");
    expect(query.leaks({ tenantId }).provenance.redactedFields).toBeGreaterThan(0);
  });

  it("bounds query inputs, detail traversal, and serialized evidence pages", () => {
    const seed = bundle().records[0]!.record;
    const { previousRecordHash: _previousRecordHash, ...seedWithoutHash } = seed;
    const records = Array.from({ length: 500 }, (_, index) => ({
      tenantId,
      record: {
        ...seedWithoutHash,
        recordId: `record-${index}`,
        recordSequence: index + 1,
        principalNamespaceId: "principal-a",
        details: {
          tenantId,
          principalNamespaceId: "principal-a",
          causalEventPositions: Array.from({ length: 256 }, (__, position) => position),
          capabilities: { capabilities: { capabilities: { capabilities: { capabilities: { capabilities: { capabilities: { capabilities: { capabilities: { secretBeyondDepth: "must-not-leak" } } } } } } } } }
        }
      }
    }));
    const query = new LocalDiagnosticQuery(bundle({ records }));
    const page = query.rawEvidence({ tenantId, limit: 500 });
    expect(page.hasMore).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.stringify(page)).not.toContain("must-not-leak");
    expect(() => query.rawEvidence({ tenantId, cursor: `dq1.${"a".repeat(5_000)}` })).toThrow("RT_DIAGNOSTIC_CURSOR_INVALID");
    expect(() => query.traceCommand({ tenantId, commandId: "🔥".repeat(300) })).toThrow("RT_DIAGNOSTIC_SCOPE_INVALID");
    expect(() => query.rawEvidence({ tenantId, filters: { commandId: "x".repeat(600) } })).toThrow("RT_DIAGNOSTIC_QUERY_INVALID");
  });

  it("canonicalizes allowlisted detail keys so key names cannot carry payload", () => {
    const source = bundle();
    source.records[0]!.record.details = { ...source.records[0]!.record.details, "command홍길동Id": "raw-command" };
    const result = new LocalDiagnosticQuery(source).rawEvidence({ tenantId });
    expect(JSON.stringify(result)).not.toContain("홍길동");
    expect((result.records[0]?.details as Record<string, unknown>).commandId).toMatch(/^pseudonym:sha256:/);
  });

  it("redacts extreme detail depth before any recursive raw-bundle clone", () => {
    const source = bundle();
    let nested: Record<string, unknown> = { code: "RT_DEEPEST_SECRET" };
    for (let index = 0; index < 20_000; index += 1) nested = { capabilities: nested };
    source.records[0]!.record.details = { tenantId, principalNamespaceId: "principal-stable-across-bundles", capabilities: nested };
    const query = new LocalDiagnosticQuery(source);
    expect(() => query.rawEvidence({ tenantId })).not.toThrow();
  });
});
