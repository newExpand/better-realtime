import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FlightRecorder, LocalDiagnosticQuery, redactLocalEvidenceBundle, type LocalEvidenceBundleV1 } from "../packages/diagnostics/src/index.ts";
import { attachClientEvidence, type ClientEvidenceRecord } from "../fixtures/external-consumer/src/evidence.ts";
import { appendBrowserEvidence, browserEvidenceBufferStatus, createBrowserEvidenceBuffer } from "../fixtures/external-consumer/src/browser-evidence-buffer.ts";
import { assertIdempotencyRetry, assertMatrixCapabilityProfiles, canonicalCapabilityProfile } from "../scripts/compatibility-wire-assertions.ts";

describe("external consumer diagnostic closure", () => {
  it("checks observed producer roles at the report completeness boundary", async () => {
    const harness = await readFile(join(import.meta.dirname, "../scripts/verify-consumer-journey.ts"), "utf8");
    expect(harness).toContain('cliResult.report?.completeness?.observedProducers?.includes("client")');
    expect(harness).not.toContain('cliResult.completeness?.observedProducers?.includes("client")');
  });

  it("freezes the full negotiated capability profile and proves same-command retry semantics", async () => {
    const journey = await readFile(join(import.meta.dirname, "../scripts/verify-consumer-journey.ts"), "utf8");
    const matrix = await readFile(join(import.meta.dirname, "../scripts/verify-mixed-version.ts"), "utf8");
    const assertions = await readFile(join(import.meta.dirname, "../scripts/compatibility-wire-assertions.ts"), "utf8");
    for (const field of ["clientApplyAck", "replayRetentionMs", "commandResultRetentionMs", "idempotencyRetentionMs", "maxMessageBytes", "maxRecoveryBufferRecords", "maxRecoveryBufferBytes"]) expect(assertions).toContain(field);
    for (const proof of ["sameCommandRetry", "freshRetryAttemptIds", "duplicateEffectSuppressed", "stableStatusIdentity"]) expect(assertions).toContain(proof);
    expect(journey).toContain("verifyServerIdempotency");
    expect(matrix).toContain("assertMatrixCapabilityProfiles");
    expect(matrix).not.toContain('capabilityProfile: "postgres-v1"');
  });

  it("rejects cross-version capability drift and unstable retry outcomes", () => {
    const capability = canonicalCapabilityProfile({ schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true, durableReplay: true, snapshotResync: "fenced", idempotentCommands: true, commandReceipts: true, clientApplyAck: false, eventDedupeWindowMs: 300_000, replayRetentionMs: 86_400_000, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, maxMessageBytes: 1_048_576, maxRecoveryBufferRecords: 10_000, maxRecoveryBufferBytes: 16_777_216 });
    const profiles = ["alpha4-client-to-candidate-server", "candidate-client-to-alpha4-server", "candidate-client-to-candidate-server"].map((id) => ({ id, capabilityProfile: capability }));
    expect(() => assertMatrixCapabilityProfiles(profiles)).not.toThrow();
    for (const [field, value] of [["clientApplyAck", true], ["commandResultRetentionMs", 30_000], ["maxRecoveryBufferRecords", 5_000], ["extraCapability", true]] as const) {
      const changed = structuredClone(profiles);
      changed[0]!.capabilityProfile = { ...changed[0]!.capabilityProfile, [field]: value };
      expect(() => assertMatrixCapabilityProfiles(changed)).toThrow("RT_COMPAT_CAPABILITY_PROFILE_DRIFT");
    }
    const commandId = "command-stable";
    const outcome = { commandId, schema: "result@1", result: { sequence: 3 }, causalEventIds: ["event-3"], causalEvents: [{ eventId: "event-3", stream: "room:42", sequence: 3 }] };
    const effect = { commandRows: 1, eventRows: 1, domainEffectRows: 1, eventId: "event-3", domainEventId: "event-3" };
    expect(assertIdempotencyRetry(commandId, ["attempt-1", "attempt-2"], outcome, structuredClone(outcome), structuredClone(outcome), effect)).toEqual({ sameCommandRetry: true, freshRetryAttemptIds: true, duplicateEffectSuppressed: true, stableStatusIdentity: true });
    expect(() => assertIdempotencyRetry(commandId, ["attempt-1", "attempt-1"], outcome, outcome, outcome, effect)).toThrow("RT_COMPAT_IDEMPOTENCY_ATTEMPT_IDENTITY_DRIFT");
    expect(() => assertIdempotencyRetry(commandId, ["attempt-1", "attempt-2"], outcome, { ...outcome, commandId: "other" }, outcome, effect)).toThrow("RT_COMPAT_IDEMPOTENCY_COMMAND_ID_DRIFT");
    expect(() => assertIdempotencyRetry(commandId, ["attempt-1", "attempt-2"], outcome, { ...outcome, result: { sequence: 4 } }, outcome, effect)).toThrow("RT_COMPAT_IDEMPOTENCY_RESULT_IDENTITY_DRIFT");
    for (const field of ["commandRows", "eventRows", "domainEffectRows"] as const) expect(() => assertIdempotencyRetry(commandId, ["attempt-1", "attempt-2"], outcome, outcome, outcome, { ...effect, [field]: 2 })).toThrow("RT_COMPAT_IDEMPOTENCY_DUPLICATE_EFFECT");
  });

  it("requires exact browser observation evidence before proving all three producers", () => {
    const tenantId = "tenant-fixture";
    const commandId = "command-dogfood";
    const eventId = "event-dogfood";
    const causalHandoffId = `event:${eventId}`;
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "database-boot", producerRole: "database" });
    const server = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "gateway-boot", producerRole: "server" });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store-postgres", componentVersion: "test", transactionId: "tx-dogfood", transactionOperation: "command", operationCorrelationId: `opcorr:sha256:${"d".repeat(64)}`, commandId, eventId, causalHandoffId, principalNamespaceId: "principal-dogfood", details: { tenantId, principalNamespaceId: "principal-dogfood", proofSource: "commit_acknowledgement" } });
    server.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", component: "gateway", componentVersion: "test", commandId, eventId, causalHandoffId, principalNamespaceId: "principal-dogfood" });
    const bundle = {
      schemaVersion: "1.0", tenantId, payloadPolicy: "redacted", pseudonymizationKey: "compatibility-diagnostic-key-32-bytes-long",
      records: [...database.records(), ...server.records()].map((record) => ({ tenantId, record })), resourceCapture: "unavailable",
      loss: { droppedRecords: 0, evictedRecords: 0 },
      expectedProducerInstances: [{ producerRole: "database", runtimeId: "database", runtimeBootId: "database-boot" }, { producerRole: "server", runtimeId: "gateway", runtimeBootId: "gateway-boot" }]
    };
    const browser: ClientEvidenceRecord = { schemaVersion: "1.0", recordId: "browser-observed-1", recordSequence: 1, kind: "command.observed", timestamp: "2026-07-21T00:00:00.000Z", monotonicNs: "1", producerRole: "client", runtimeId: "browser", runtimeBootId: "browser-boot", component: "external-consumer", componentVersion: "test", boundary: "command.observed", outcome: "success", commandId, eventId, causalHandoffId };
    const capture = { record: browser, buffer: { capacity: 64, retainedRecords: 1, evictedRecords: 0 } };
    expect(() => attachClientEvidence(bundle, { ...capture, record: { ...browser, commandId: "other" } }, commandId)).toThrow("RT_BROWSER_COMMAND_EVIDENCE_INVALID");
    const redacted = redactLocalEvidenceBundle(structuredClone(bundle) as LocalEvidenceBundleV1);
    attachClientEvidence(redacted as unknown as Parameters<typeof attachClientEvidence>[0], capture, commandId);
    const redactedResult = new LocalDiagnosticQuery(redacted).doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }, { producerRole: "server", boundary: "command.completed" }, { producerRole: "client", boundary: "command.observed" }], expectedProducers: ["database", "server", "client"], requireCausalHandoffs: true, expectedOutcome: "browser observed durable command", scope: { commandId } });
    expect(redactedResult.report.verdict).toBe("proven");
    expect(JSON.stringify(redacted)).not.toContain(commandId);
    expect(JSON.stringify(redacted)).not.toContain(eventId);
    attachClientEvidence(bundle, capture, commandId);
    const result = new LocalDiagnosticQuery(bundle as LocalEvidenceBundleV1).doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }, { producerRole: "server", boundary: "command.completed" }, { producerRole: "client", boundary: "command.observed" }], expectedProducers: ["database", "server", "client"], requireCausalHandoffs: true, expectedOutcome: "browser observed durable command", scope: { commandId } });
    expect(result.report.verdict).toBe("proven");
    expect(result.completeness.status).toBe("complete");
    expect([...result.report.completeness.observedProducers].sort()).toEqual(["client", "database", "server"]);
    expect(result.report.evidenceClosure.map((entry) => entry.boundary)).toEqual(["db.committed", "command.completed", "command.observed"]);
    expect(result.evidenceReference.recordCount).toBe(3);
  });

  it("bounds browser evidence across HMR while keeping monotonic identity and exposing loss", () => {
    const buffer = createBrowserEvidenceBuffer<{ recordSequence: number; value: number }>(3);
    for (let value = 0; value < 10; value += 1) appendBrowserEvidence(buffer, (recordSequence) => ({ recordSequence, value }));
    expect(buffer.records).toEqual([{ recordSequence: 8, value: 7 }, { recordSequence: 9, value: 8 }, { recordSequence: 10, value: 9 }]);
    expect(browserEvidenceBufferStatus(buffer)).toEqual({ capacity: 3, retainedRecords: 3, evictedRecords: 7 });
    const commandId = "command-dogfood";
    const browser: ClientEvidenceRecord = { schemaVersion: "1.0", recordId: "browser-observed-10", recordSequence: 10, kind: "command.observed", timestamp: "2026-07-21T00:00:00.000Z", monotonicNs: "1", producerRole: "client", runtimeId: "browser", runtimeBootId: "browser-boot", component: "external-consumer", componentVersion: "test", boundary: "command.observed", outcome: "success", commandId, eventId: "event-dogfood", causalHandoffId: "event:event-dogfood" };
    const bundle = { records: [{ tenantId: "tenant-fixture", record: { commandId, eventId: "event-dogfood", principalNamespaceId: "principal" } }], expectedProducerInstances: [] };
    expect(() => attachClientEvidence(bundle, { record: browser, buffer: browserEvidenceBufferStatus(buffer) }, commandId)).toThrow("RT_BROWSER_COMMAND_EVIDENCE_INCOMPLETE:evicted=7");
  });
});
