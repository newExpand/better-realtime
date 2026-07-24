import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adaptLocalDiagnosticSource,
  BoundedEvidenceExporter,
  BoundedLocalEvidenceSink,
  createDiagnosticSourceAdapter,
  type DiagnosticSource,
  type DiagnosticSourceAdapterOptions,
  type EvidenceEnvelopeV1,
  EvidenceCoverageLedger,
  type EvidenceProducerCheckpoint,
  type EvidenceRecord,
  FlightRecorder,
  type ProducerInstance,
  versionedDiagnosticResultV1ProofPolicy
} from "../src/index.ts";

const pseudonym = (digit: string): string => `pseudonym:sha256:${digit.repeat(64)}`;
const TENANT_ID = pseudonym("a");

function producer(role: ProducerInstance["producerRole"] = "server", digit = "b"): ProducerInstance {
  return {
    producerRole: role,
    runtimeId: pseudonym(digit),
    runtimeBootId: pseudonym(role === "server" ? "c" : "d")
  };
}

function record(sequence: number): EvidenceRecord {
  return {
    schemaVersion: "1.0",
    recordId: pseudonym((sequence % 10).toString()),
    recordSequence: sequence,
    kind: "command.completed",
    timestamp: "2026-07-24T00:00:00.000Z",
    monotonicNs: String(sequence),
    ...producer(),
    component: "server",
    componentVersion: "0.2.0-alpha.1",
    boundary: "command.completed",
    outcome: "success",
    commandId: pseudonym("d"),
    details: { tenantId: TENANT_ID }
  };
}

function envelope(sequence: number): EvidenceEnvelopeV1 {
  return { schemaVersion: "1.0", tenantId: TENANT_ID, payloadPolicy: "redacted", record: record(sequence) };
}

function checkpoint(highWaterMark: number, identity = producer()): EvidenceProducerCheckpoint {
  return { ...identity, highWaterMark, closed: true };
}

function sourceRecord(sequence: number): EvidenceRecord {
  return {
    schemaVersion: "1.0",
    recordId: `record-${sequence}`,
    recordSequence: sequence,
    kind: "command.completed",
    timestamp: "2026-07-24T00:00:00.000Z",
    monotonicNs: String(sequence),
    producerRole: "client",
    runtimeId: "browser-runtime",
    runtimeBootId: "browser-boot",
    component: "client",
    componentVersion: "0.2.0-alpha.1",
    boundary: "command.completed",
    outcome: "success",
    commandId: "command-secret",
    details: { tenantId: "tenant-secret", password: "must-not-cross" }
  };
}

function sourceRecordFor(
  sequence: number,
  identity: { producerRole: "client" | "server" | "database"; runtimeId: string; runtimeBootId: string }
): EvidenceRecord {
  return {
    ...sourceRecord(sequence),
    ...identity,
    component: identity.producerRole
  };
}

function completeCoverage(): ReturnType<EvidenceCoverageLedger["snapshot"]> {
  const coverage = new EvidenceCoverageLedger();
  coverage.declareExpectedProducers([producer()]);
  coverage.observe(record(1));
  coverage.closeProducer(checkpoint(1));
  return coverage.snapshot();
}

describe("bounded local evidence sink", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tracks drop, eviction, rejection, export failure, and missing ranges independently", async () => {
    const sink = new BoundedLocalEvidenceSink({
      maxRecords: 2,
      maxBytes: 8_192,
      maxAgeMs: 60_000,
      maxRecordBytes: 2_048
    });

    await sink.record(envelope(1));
    await sink.record(envelope(3));
    await sink.record(envelope(4));
    sink.coverage.recordDropped(2);
    sink.coverage.recordExportFailure(3);
    await expect(sink.record({
      ...envelope(5),
      record: {
        ...record(5),
        details: {
          tenantId: TENANT_ID,
          causalEventIds: Array.from({ length: 64 }, (_, index) => pseudonym((index % 10).toString()))
        }
      }
    })).rejects.toThrow("RT_DIAGNOSTIC_RECORD_REJECTED");

    expect(sink.records().map(({ record: item }) => item.recordSequence)).toEqual([3, 4]);
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      droppedRecords: 2,
      evictedRecords: 1,
      rejectedRecords: 1,
      exportFailedRecords: 3,
      missingRanges: [{ first: 2, last: 2 }]
    });
  });

  it("is idempotent for exact duplicate envelopes and rejects conflicting producer sequences", async () => {
    const sink = new BoundedLocalEvidenceSink();
    await sink.record(envelope(1));
    await sink.record(structuredClone(envelope(1)));
    expect(sink.records()).toHaveLength(1);

    await expect(sink.record({
      ...envelope(1),
      record: { ...record(1), recordId: pseudonym("e") }
    })).rejects.toThrow("RT_DIAGNOSTIC_SEQUENCE_CONFLICT");
    expect(sink.coverage.snapshot().rejectedRecords).toBe(1);
  });

  it("accepts out-of-order multi-gateway export and merges sequence coverage", async () => {
    const sink = new BoundedLocalEvidenceSink();
    sink.coverage.declareExpectedProducers([producer()]);
    await sink.record(envelope(4));
    await sink.record(envelope(2));
    await sink.record(envelope(3));

    expect(sink.records().map(({ record: item }) => item.recordSequence)).toEqual([4, 2, 3]);
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      rejectedRecords: 0,
      missingRanges: [{ first: 1, last: 1 }]
    });

    await sink.record(envelope(1));
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      openProducerInstances: [producer()],
      missingRanges: []
    });
    sink.coverage.closeProducer(checkpoint(4));
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "complete",
      openProducerInstances: [],
      missingRanges: []
    });
  });

  it("requires declared producers and closed high-water checkpoints before coverage is complete", async () => {
    const sink = new BoundedLocalEvidenceSink();
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      expectedProducerSetDeclared: false
    });

    sink.coverage.declareExpectedProducers([producer()]);
    await sink.record(envelope(1));
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      openProducerInstances: [producer()]
    });

    sink.coverage.closeProducer(checkpoint(2));
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      missingRanges: [{ first: 2, last: 2 }]
    });

    await sink.record(envelope(2));
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "complete",
      coveredRanges: [{ first: 1, last: 2 }]
    });
  });

  it("keeps a missing expected producer and post-checkpoint sequence proof-ineligible", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const database = producer("database", "e");
    sink.coverage.declareExpectedProducers([producer(), database]);
    await sink.record(envelope(1));
    sink.coverage.closeProducer(checkpoint(1));

    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      missingProducerInstances: [database],
      openProducerInstances: [database]
    });
    await expect(sink.record(envelope(2))).rejects.toThrow("RT_DIAGNOSTIC_SEQUENCE_AFTER_CHECKPOINT");
    expect(sink.coverage.snapshot()).toMatchObject({ rejectedRecords: 1, status: "partial" });
  });

  it("accepts an explicitly declared empty producer topology", () => {
    const coverage = new EvidenceCoverageLedger();
    coverage.declareExpectedProducers([]);
    expect(coverage.snapshot()).toMatchObject({
      status: "complete",
      expectedProducerSetDeclared: true,
      expectedProducerInstances: [],
      closedProducerCheckpoints: []
    });
  });

  it("bounds producer and range tracking without mutating accepted coverage", () => {
    const coverage = new EvidenceCoverageLedger({ maxProducers: 1, maxRanges: 1 });
    coverage.observe(record(1));

    expect(() => coverage.observe(record(3))).toThrow("RT_DIAGNOSTIC_COVERAGE_RANGE_LIMIT");
    expect(() => coverage.observe({
      ...record(1),
      ...producer("database", "e")
    })).toThrow("RT_DIAGNOSTIC_COVERAGE_PRODUCER_LIMIT");

    expect(coverage.snapshot()).toMatchObject({
      status: "partial",
      observedProducerInstances: [producer()],
      coveredRanges: [{ ...producer(), first: 1, last: 1 }],
      rejectedRecords: 2
    });
  });

  it("rejects an expected producer topology above the configured bound", () => {
    const coverage = new EvidenceCoverageLedger({ maxProducers: 1 });
    expect(() => coverage.declareExpectedProducers([
      producer(),
      producer("database", "e")
    ])).toThrow("RT_DIAGNOSTIC_COVERAGE_PRODUCER_LIMIT");
    expect(coverage.snapshot()).toMatchObject({
      status: "partial",
      expectedProducerSetDeclared: false,
      rejectedRecords: 1
    });
  });

  it("bounds additive producer registration without mutating the accepted topology", () => {
    const coverage = new EvidenceCoverageLedger({ maxProducers: 1, maxRanges: 1 });
    coverage.registerExpectedProducers([producer()]);
    expect(() => coverage.registerExpectedProducers([
      producer("database", "e")
    ])).toThrow("RT_DIAGNOSTIC_COVERAGE_PRODUCER_LIMIT");
    expect(coverage.snapshot()).toMatchObject({
      status: "partial",
      expectedProducerSetDeclared: false,
      expectedProducerInstances: [producer()],
      rejectedRecords: 1
    });
  });

  it("accounts for malformed, clone, canonicalization, redaction, and tenant failures", async () => {
    const malformed = new BoundedLocalEvidenceSink();
    await expect(malformed.record({
      ...envelope(1),
      record: { ...record(1), recordSequence: 0 }
    })).rejects.toThrow("RT_DIAGNOSTIC_ENVELOPE_INVALID");
    expect(malformed.coverage.snapshot().rejectedRecords).toBe(1);

    const tenantMismatch = new BoundedLocalEvidenceSink();
    await expect(tenantMismatch.record({
      ...envelope(1),
      tenantId: pseudonym("f")
    })).rejects.toThrow("RT_DIAGNOSTIC_ENVELOPE_INVALID");
    expect(tenantMismatch.coverage.snapshot().rejectedRecords).toBe(1);

    const unsafeDetails = new BoundedLocalEvidenceSink();
    await expect(unsafeDetails.record({
      ...envelope(1),
      record: { ...record(1), details: { tenantId: TENANT_ID, password: "secret" } }
    })).rejects.toThrow("RT_DIAGNOSTIC_ENVELOPE_INVALID");
    expect(unsafeDetails.coverage.snapshot().rejectedRecords).toBe(1);

    const unsafeEnvelope = new BoundedLocalEvidenceSink();
    await expect(unsafeEnvelope.record({
      ...envelope(1),
      rawPayload: "secret"
    } as EvidenceEnvelopeV1)).rejects.toThrow("RT_DIAGNOSTIC_ENVELOPE_INVALID");
    expect(unsafeEnvelope.coverage.snapshot().rejectedRecords).toBe(1);

    const cloneFailure = new BoundedLocalEvidenceSink();
    vi.spyOn(globalThis, "structuredClone").mockImplementationOnce(() => {
      throw new DOMException("not cloneable", "DataCloneError");
    });
    await expect(cloneFailure.record(envelope(1))).rejects.toThrow("RT_DIAGNOSTIC_ENVELOPE_INVALID");
    expect(cloneFailure.coverage.snapshot().rejectedRecords).toBe(1);
    vi.restoreAllMocks();

    const canonicalFailure = new BoundedLocalEvidenceSink();
    vi.spyOn(globalThis, "structuredClone").mockImplementationOnce(() => {
      const cyclic: Record<string, unknown> = { ...envelope(1) };
      cyclic.cycle = cyclic;
      return cyclic;
    });
    await expect(canonicalFailure.record(envelope(1))).rejects.toThrow("RT_DIAGNOSTIC_ENVELOPE_INVALID");
    expect(canonicalFailure.coverage.snapshot().rejectedRecords).toBe(1);
  });

  it("applies age eviction during records and stats reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const sink = new BoundedLocalEvidenceSink({ maxAgeMs: 1_000 });
    await sink.record(envelope(1));

    vi.advanceTimersByTime(1_001);
    expect(sink.records()).toEqual([]);
    expect(sink.stats()).toMatchObject({ records: 0, bytes: 0 });
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      evictedRecords: 1
    });
  });

  it("applies age eviction before a direct coverage snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const sink = new BoundedLocalEvidenceSink({ maxAgeMs: 1_000 });
    sink.coverage.declareExpectedProducers([producer()]);
    await sink.record(envelope(1));
    sink.coverage.closeProducer(checkpoint(1));
    expect(sink.coverage.snapshot()).toMatchObject({ status: "complete", evictedRecords: 0 });

    vi.advanceTimersByTime(1_001);
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      evictedRecords: 1
    });
  });
});

describe("bounded evidence exporter", () => {
  it("routes authenticated tenant evidence out-of-band and keeps system evidence separate", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const exporter = new BoundedEvidenceExporter({
      sink,
      pseudonymizationKey: "trusted-routing-key-material-at-least-32-bytes",
      tenantId: (_record, routing) => routing.tenantId ?? "system",
      expectedProducers: [{
        producerRole: "server",
        runtimeId: "gateway-runtime",
        runtimeBootId: "gateway-boot"
      }]
    });
    const recorder = new FlightRecorder({
      runtimeId: "gateway-runtime",
      runtimeBootId: "gateway-boot",
      producerRole: "server",
      onRecord: (evidence, routing) => exporter.record(evidence, routing)
    });

    recorder.record({
      kind: "authorization.denied",
      component: "server",
      componentVersion: "0.2.0-alpha.1",
      boundary: "stream.authorization",
      outcome: "failure",
      reasonCode: "RT_AUTHORIZATION_DENIED",
      details: { response: "generic_denial" }
    }, { tenantId: "tenant-authenticated" });
    recorder.record({
      kind: "connection.rejected",
      component: "server",
      componentVersion: "0.2.0-alpha.1",
      boundary: "connection.rejected",
      outcome: "failure",
      reasonCode: "RT_RESOURCE_LIMIT_EXCEEDED"
    });
    await exporter.close([{
      producerRole: "server",
      runtimeId: "gateway-runtime",
      runtimeBootId: "gateway-boot",
      highWaterMark: 2,
      closed: true
    }]);

    const exported = sink.records();
    expect(exported).toHaveLength(2);
    expect(exported[0]!.record.kind).toBe("authorization.denied");
    expect(exported[1]!.record.kind).toBe("connection.rejected");
    expect(exported[0]!.tenantId).not.toBe(exported[1]!.tenantId);
    expect(exported[0]!.record.details).not.toHaveProperty("tenantId");
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "complete",
      exportFailedRecords: 0,
      missingRanges: []
    });
  });

  it("does not let spoofable evidence details select the tenant partition", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const exporter = new BoundedEvidenceExporter({
      sink,
      pseudonymizationKey: "trusted-routing-key-material-at-least-32-bytes",
      tenantId: (_record, routing) => routing.tenantId ?? "system",
      expectedProducers: [{
        producerRole: "server",
        runtimeId: "gateway-runtime",
        runtimeBootId: "gateway-boot"
      }]
    });
    const recorder = new FlightRecorder({
      runtimeId: "gateway-runtime",
      runtimeBootId: "gateway-boot",
      producerRole: "server",
      onRecord: (evidence, routing) => exporter.record(evidence, routing)
    });

    recorder.record({
      kind: "authorization.denied",
      component: "server",
      componentVersion: "0.2.0-alpha.1",
      boundary: "stream.authorization",
      outcome: "failure",
      reasonCode: "RT_AUTHORIZATION_DENIED",
      details: { tenantId: "tenant-payload-spoof" }
    }, { tenantId: "tenant-authenticated" });

    await expect(exporter.flush()).rejects.toThrow("RT_DIAGNOSTIC_EXPORT_FAILED");
    expect(sink.records()).toEqual([]);
    expect(exporter.snapshot()).toMatchObject({
      acceptedRecords: 0,
      exportFailedRecords: 1
    });
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      exportFailedRecords: 1
    });
  });

  it("automatically redacts producer evidence and closes exact coverage", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const exporter = new BoundedEvidenceExporter({
      sink,
      pseudonymizationKey: "exporter-test-key-material-at-least-32-bytes",
      tenantId: "tenant-secret",
      expectedProducers: [{
        producerRole: "client",
        runtimeId: "browser-runtime",
        runtimeBootId: "browser-boot"
      }]
    });

    exporter.record(sourceRecord(1));
    await exporter.flush();
    await exporter.close([{
      producerRole: "client",
      runtimeId: "browser-runtime",
      runtimeBootId: "browser-boot",
      highWaterMark: 1,
      closed: true
    }]);

    const exported = sink.records()[0]!;
    expect(exported.tenantId).toMatch(/^pseudonym:sha256:/u);
    expect(exported.record.recordId).toMatch(/^pseudonym:sha256:/u);
    expect(exported.record.commandId).toMatch(/^pseudonym:sha256:/u);
    expect(exported.record.details).toEqual({ tenantId: exported.tenantId });
    expect(JSON.stringify(exported)).not.toContain("must-not-cross");
    expect(sink.coverage.snapshot()).toMatchObject({ status: "complete", exportFailedRecords: 0 });
  });

  it("reports asynchronous sink failure instead of silently dropping proof evidence", async () => {
    let failures = 0;
    const exporter = new BoundedEvidenceExporter({
      sink: {
        schemaVersion: "1.0",
        capabilities: { authoritative: true, durable: true, sampled: false, multiProducer: true },
        record: async () => { throw new Error("offline"); },
        recordExportFailure: () => { failures += 1; }
      },
      pseudonymizationKey: "exporter-test-key-material-at-least-32-bytes",
      tenantId: "tenant-secret",
      expectedProducers: [{
        producerRole: "client",
        runtimeId: "browser-runtime",
        runtimeBootId: "browser-boot"
      }]
    });
    exporter.record(sourceRecord(1));
    await expect(exporter.flush()).rejects.toThrow("RT_DIAGNOSTIC_EXPORT_FAILED");
    expect(exporter.snapshot()).toMatchObject({ exportFailedRecords: 1, acceptedRecords: 0 });
    expect(failures).toBe(1);
  });

  it("rejects shared mode when a sink cannot coordinate an explicit topology", () => {
    expect(() => new BoundedEvidenceExporter({
      sink: {
        schemaVersion: "1.0",
        capabilities: { authoritative: true, durable: true, sampled: false, multiProducer: true },
        record: async () => undefined
      },
      topology: "shared",
      pseudonymizationKey: "shared-exporter-key-material-at-least-32-bytes",
      tenantId: "tenant-secret",
      expectedProducers: [{
        producerRole: "client",
        runtimeId: "browser-runtime",
        runtimeBootId: "browser-boot"
      }]
    })).toThrow("RT_DIAGNOSTIC_SHARED_TOPOLOGY_UNSUPPORTED");
  });

  it("shares one sink through additive registration and explicit topology finalization", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const identities = [
      { producerRole: "client" as const, runtimeId: "browser-runtime", runtimeBootId: "browser-boot" },
      { producerRole: "server" as const, runtimeId: "gateway-a", runtimeBootId: "gateway-a-boot" },
      { producerRole: "database" as const, runtimeId: "gateway-a:postgres", runtimeBootId: "gateway-a-boot" }
    ];
    const exporters = identities.map((identity) => new BoundedEvidenceExporter({
      sink,
      topology: "shared",
      pseudonymizationKey: "shared-exporter-key-material-at-least-32-bytes",
      tenantId: "tenant-secret",
      expectedProducers: [identity]
    }));

    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      expectedProducerSetDeclared: false
    });
    expect(sink.coverage.snapshot().expectedProducerInstances.map(({ producerRole }) => producerRole).sort())
      .toEqual(["client", "database", "server"]);

    sink.finalizeExpectedProducers();
    identities.forEach((identity, index) => exporters[index]!.record(sourceRecordFor(1, identity)));
    await Promise.all(exporters.map((exporter) => exporter.flush()));
    await Promise.all(exporters.map((exporter, index) => exporter.close([{
      ...identities[index]!,
      highWaterMark: 1,
      closed: true
    }])));

    expect(sink.coverage.snapshot()).toMatchObject({
      status: "complete",
      expectedProducerSetDeclared: true,
      openProducerInstances: [],
      missingProducerInstances: [],
      missingRanges: []
    });
  });

  it("keeps shared topology proof-ineligible until finalized and rejects late producers", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const client = { producerRole: "client" as const, runtimeId: "browser-runtime", runtimeBootId: "browser-boot" };
    const exporter = new BoundedEvidenceExporter({
      sink,
      topology: "shared",
      pseudonymizationKey: "shared-exporter-key-material-at-least-32-bytes",
      tenantId: "tenant-secret",
      expectedProducers: [client]
    });
    exporter.record(sourceRecordFor(1, client));
    await exporter.flush();

    const source = createDiagnosticSourceAdapter({
      capabilities: sink.capabilities,
      proofPolicy: versionedDiagnosticResultV1ProofPolicy,
      query: () => ({
        coverage: sink.coverage.snapshot(),
        value: {
          schemaVersion: "1.0" as const,
          verdict: "proven" as const,
          completeness: { status: "complete" as const }
        }
      })
    });
    expect(sink.coverage.snapshot()).toMatchObject({
      status: "partial",
      expectedProducerSetDeclared: false
    });
    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: false,
      value: { verdict: "indeterminate", completeness: { status: "partial" } }
    });
    sink.finalizeExpectedProducers();
    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: false,
      coverage: { openProducerInstances: expect.any(Array) }
    });
    expect(() => new BoundedEvidenceExporter({
      sink,
      topology: "shared",
      pseudonymizationKey: "shared-exporter-key-material-at-least-32-bytes",
      tenantId: "tenant-secret",
      expectedProducers: [{
        producerRole: "server",
        runtimeId: "late-gateway",
        runtimeBootId: "late-gateway-boot"
      }]
    })).toThrow("RT_DIAGNOSTIC_TOPOLOGY_FINALIZED");
    await exporter.close([{ ...client, highWaterMark: 1, closed: true }]);
    expect(sink.coverage.snapshot()).toMatchObject({ status: "partial", rejectedRecords: 1 });
    await expect(source.query({})).resolves.toMatchObject({ proofEligible: false });
  });
});

describe("diagnostic source proof eligibility", () => {
  it("rejects the old split value and coverage adapter shape", async () => {
    const splitShape = {
      capabilities: {
        authoritative: true,
        durable: false,
        sampled: false,
        multiProducer: false
      },
      coverage: completeCoverage(),
      proofPolicy: versionedDiagnosticResultV1ProofPolicy,
      query: () => ({
        schemaVersion: "1.0" as const,
        verdict: "proven" as const,
        completeness: { status: "complete" as const }
      })
    } as unknown as DiagnosticSourceAdapterOptions<unknown, {
      schemaVersion: "1.0";
      verdict: "proven";
      completeness: { status: "complete" };
    }>;

    await expect(createDiagnosticSourceAdapter(splitShape).query({}))
      .rejects.toThrow("RT_DIAGNOSTIC_SOURCE_SNAPSHOT_INVALID");
  });

  it("keeps the alpha.4 synchronous source behind a proof-ineligible legacy adapter", async () => {
    const source = adaptLocalDiagnosticSource({
      query: () => ({
        schemaVersion: "1.0" as const,
        verdict: "indeterminate" as const,
        completeness: { status: "partial" as const }
      })
    });

    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: false,
      coverage: { status: "partial" },
      value: {
        verdict: "indeterminate",
        completeness: { status: "partial" }
      }
    });
  });

  it("requires an explicitly complete coverage status for proof eligibility", async () => {
    const source = createDiagnosticSourceAdapter({
      capabilities: {
        authoritative: true,
        durable: false,
        sampled: false,
        multiProducer: false
      },
      proofPolicy: versionedDiagnosticResultV1ProofPolicy,
      query: () => ({
        coverage: {
          ...completeCoverage(),
          status: "partial" as const
        },
        value: {
          schemaVersion: "1.0" as const,
          verdict: "proven" as const,
          completeness: { status: "complete" as const }
        }
      })
    });

    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: false,
      value: {
        verdict: "indeterminate",
        completeness: { status: "partial" }
      }
    });
  });

  it("downgrades a visible proven result when export failure makes evidence incomplete", async () => {
    const source = createDiagnosticSourceAdapter({
      capabilities: {
        authoritative: true,
        durable: false,
        sampled: false,
        multiProducer: false
      },
      proofPolicy: versionedDiagnosticResultV1ProofPolicy,
      query: () => ({
        coverage: {
          schemaVersion: "1.0" as const,
          status: "partial" as const,
          expectedProducerSetDeclared: true,
          expectedProducerInstances: [producer()],
          observedProducerInstances: [producer()],
          missingProducerInstances: [],
          openProducerInstances: [],
          unexpectedProducerInstances: [],
          closedProducerCheckpoints: [checkpoint(1)],
          coveredRanges: [{ ...producer(), first: 1, last: 1 }],
          droppedRecords: 0,
          evictedRecords: 0,
          rejectedRecords: 0,
          exportFailedRecords: 1,
          missingRanges: []
        },
        value: {
          schemaVersion: "1.0" as const,
          kind: "doctor",
          completeness: { status: "complete" as const },
          report: {
            verdict: "proven" as const,
            completeness: { status: "complete" as const }
          }
        }
      })
    });

    const result = await source.query({ kind: "doctor" });
    expect(result.proofEligible).toBe(false);
    expect(result.value).toMatchObject({
      completeness: { status: "partial" },
      report: {
        verdict: "indeterminate",
        completeness: { status: "partial" }
      }
    });
  });

  it("never treats sampled telemetry as authoritative proof", async () => {
    const source: DiagnosticSource<{ kind: string }, { kind: string; verdict: string }> = createDiagnosticSourceAdapter({
      capabilities: {
        authoritative: false,
        durable: true,
        sampled: true,
        multiProducer: true
      },
      proofPolicy: {
        isValid: (value) => value.kind === "doctor" && ["proven", "disproven", "indeterminate"].includes(value.verdict),
        downgrade: (value) => ({ ...value, verdict: "indeterminate" as const }),
        isProofSafe: (value) => value.verdict !== "proven"
      },
      query: () => ({
        coverage: completeCoverage(),
        value: { kind: "doctor", verdict: "proven" }
      })
    });

    const result = await source.query({ kind: "doctor" });
    expect(result.proofEligible).toBe(false);
    expect(result.value.verdict).toBe("indeterminate");
  });

  it("does not treat empty, prefix-only, or open producer coverage as proof eligible", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const source = createDiagnosticSourceAdapter({
      capabilities: {
        authoritative: true,
        durable: false,
        sampled: false,
        multiProducer: true
      },
      proofPolicy: versionedDiagnosticResultV1ProofPolicy,
      query: () => ({
        coverage: sink.coverage.snapshot(),
        value: {
          schemaVersion: "1.0" as const,
          verdict: "proven" as const,
          completeness: { status: "complete" as const }
        }
      })
    });

    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: false,
      value: { verdict: "indeterminate", completeness: { status: "partial" } }
    });

    sink.coverage.declareExpectedProducers([producer()]);
    await sink.record(envelope(1));
    await expect(source.query({})).resolves.toMatchObject({ proofEligible: false });

    sink.coverage.closeProducer(checkpoint(2));
    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: false,
      coverage: { missingRanges: [{ first: 2, last: 2 }] }
    });

    await sink.record(envelope(2));
    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: true,
      value: { verdict: "proven", completeness: { status: "complete" } }
    });
  });

  it("does not treat a closed zero-record producer as proof eligible", async () => {
    const sink = new BoundedLocalEvidenceSink();
    sink.coverage.declareExpectedProducers([producer()]);
    sink.coverage.closeProducer(checkpoint(0));
    const source = createDiagnosticSourceAdapter({
      capabilities: {
        authoritative: true,
        durable: false,
        sampled: false,
        multiProducer: true
      },
      proofPolicy: versionedDiagnosticResultV1ProofPolicy,
      query: () => ({
        coverage: sink.coverage.snapshot(),
        value: {
          schemaVersion: "1.0" as const,
          verdict: "proven" as const,
          completeness: { status: "complete" as const }
        }
      })
    });

    await expect(source.query({})).resolves.toMatchObject({
      proofEligible: false,
      coverage: {
        status: "complete",
        observedProducerInstances: [],
        coveredRanges: []
      },
      value: { verdict: "indeterminate", completeness: { status: "partial" } }
    });
  });

  it("fails closed when a generic result downgrade does not remove its proof claim", async () => {
    const source = createDiagnosticSourceAdapter({
      capabilities: {
        authoritative: false,
        durable: false,
        sampled: true,
        multiProducer: false
      },
      proofPolicy: {
        isValid: (value) => value.conclusion === "proven" && Array.isArray(value.nested),
        downgrade: (value) => value,
        isProofSafe: (value) => value.conclusion !== "proven"
      },
      query: () => ({
        coverage: completeCoverage(),
        value: { conclusion: "proven" as const, nested: [{ conclusion: "proven" as const }] }
      })
    });

    await expect(source.query({})).rejects.toThrow("RT_DIAGNOSTIC_DOWNGRADE_INVALID");
  });
});
