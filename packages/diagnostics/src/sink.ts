import Ajv2020 from "ajv/dist/2020.js";
import { diagnosticQueryResultSchemaV1 } from "./query.ts";
import type { EvidenceRecord, ProducerInstance } from "./types.ts";

export const EVIDENCE_SINK_SCHEMA_VERSION = "1.0" as const;

export interface EvidenceEnvelopeV1 {
  readonly schemaVersion: typeof EVIDENCE_SINK_SCHEMA_VERSION;
  readonly tenantId: string;
  /**
   * Public sinks accept only policy-redacted records. A runtime may retain a
   * raw producer-local recorder, but that recorder is not an EvidenceSink.
   */
  readonly payloadPolicy: "redacted";
  readonly record: EvidenceRecord;
}

export interface EvidenceSinkCapabilities {
  readonly authoritative: boolean;
  readonly durable: boolean;
  readonly sampled: boolean;
  readonly multiProducer: boolean;
}

export interface EvidenceSink {
  readonly schemaVersion: typeof EVIDENCE_SINK_SCHEMA_VERSION;
  readonly capabilities: EvidenceSinkCapabilities;
  record(evidence: EvidenceEnvelopeV1): Promise<void>;
  /** Add one exporter-owned producer subset before the topology is sealed. */
  registerExpectedProducers?(instances: readonly ProducerInstance[]): void;
  /** Seal the additive producer topology; unsealed coverage is never complete. */
  finalizeExpectedProducers?(): void;
  declareExpectedProducers?(instances: readonly ProducerInstance[]): void;
  closeProducer?(checkpoint: EvidenceProducerCheckpoint): void;
  recordExportFailure?(count?: number): void;
}

export interface MissingEvidenceRange {
  readonly producerRole: EvidenceRecord["producerRole"];
  readonly runtimeId: string;
  readonly runtimeBootId: string;
  readonly first: number;
  readonly last: number;
}

export interface EvidenceCoveredRange extends MissingEvidenceRange {}

export interface EvidenceProducerCheckpoint extends ProducerInstance {
  readonly highWaterMark: number;
  readonly closed: true;
}

export interface EvidenceCoverageSnapshot {
  readonly schemaVersion: typeof EVIDENCE_SINK_SCHEMA_VERSION;
  readonly status: "complete" | "partial";
  readonly expectedProducerSetDeclared: boolean;
  readonly expectedProducerInstances: readonly ProducerInstance[];
  readonly observedProducerInstances: readonly ProducerInstance[];
  readonly missingProducerInstances: readonly ProducerInstance[];
  readonly openProducerInstances: readonly ProducerInstance[];
  readonly unexpectedProducerInstances: readonly ProducerInstance[];
  readonly closedProducerCheckpoints: readonly EvidenceProducerCheckpoint[];
  readonly coveredRanges: readonly EvidenceCoveredRange[];
  readonly droppedRecords: number;
  readonly evictedRecords: number;
  readonly rejectedRecords: number;
  readonly exportFailedRecords: number;
  readonly missingRanges: readonly MissingEvidenceRange[];
}

interface MutableRange {
  first: number;
  last: number;
}

export interface EvidenceCoverageLedgerOptions {
  readonly maxProducers?: number;
  readonly maxRanges?: number;
}

/**
 * Loss accounting is independent from ordinary evidence records. Otherwise a
 * full or failed recorder could silently lose the record describing its own
 * incompleteness.
 */
export class EvidenceCoverageLedger {
  #droppedRecords = 0;
  #evictedRecords = 0;
  #rejectedRecords = 0;
  #exportFailedRecords = 0;
  #expectedProducerSetDeclared = false;
  readonly #expectedProducers = new Map<string, ProducerInstance>();
  readonly #closedCheckpoints = new Map<string, EvidenceProducerCheckpoint>();
  readonly #observedRanges = new Map<string, { identity: Omit<MissingEvidenceRange, "first" | "last">; ranges: MutableRange[] }>();
  readonly maxProducers: number;
  readonly maxRanges: number;
  #rangeCount = 0;

  constructor(options: EvidenceCoverageLedgerOptions = {}) {
    this.maxProducers = positiveInteger(options.maxProducers ?? 256, "maxProducers");
    this.maxRanges = positiveInteger(options.maxRanges ?? 10_000, "maxRanges");
  }

  recordDropped(count = 1): void { this.#droppedRecords = checkedAdd(this.#droppedRecords, count); }
  recordEvicted(count = 1): void { this.#evictedRecords = checkedAdd(this.#evictedRecords, count); }
  recordRejected(count = 1): void { this.#rejectedRecords = checkedAdd(this.#rejectedRecords, count); }
  recordExportFailure(count = 1): void { this.#exportFailedRecords = checkedAdd(this.#exportFailedRecords, count); }

  declareExpectedProducers(instances: readonly ProducerInstance[]): void {
    try {
      const declared = new Map<string, ProducerInstance>();
      for (const instance of instances) {
        assertProducerInstance(instance);
        const key = producerKey(instance);
        if (declared.has(key)) throw new Error("RT_DIAGNOSTIC_EXPECTED_PRODUCER_DUPLICATE");
        declared.set(key, Object.freeze({ ...instance }));
      }
      if (declared.size > this.maxProducers) throw new Error("RT_DIAGNOSTIC_COVERAGE_PRODUCER_LIMIT");
      for (const key of this.#observedRanges.keys()) {
        if (!declared.has(key)) throw new Error("RT_DIAGNOSTIC_UNEXPECTED_PRODUCER");
      }
      if (this.#expectedProducers.size > 0 && !sameKeys(this.#expectedProducers, declared)) {
        throw new Error("RT_DIAGNOSTIC_EXPECTED_PRODUCERS_CONFLICT");
      }
      if (this.#expectedProducerSetDeclared) {
        if (!sameKeys(this.#expectedProducers, declared)) throw new Error("RT_DIAGNOSTIC_EXPECTED_PRODUCERS_CONFLICT");
        return;
      }
      this.#expectedProducerSetDeclared = true;
      for (const [key, instance] of declared) this.#expectedProducers.set(key, instance);
    } catch (error) {
      this.recordRejected();
      throw error;
    }
  }

  registerExpectedProducers(instances: readonly ProducerInstance[]): void {
    try {
      const additions = new Map<string, ProducerInstance>();
      for (const instance of instances) {
        assertProducerInstance(instance);
        const key = producerKey(instance);
        if (additions.has(key)) throw new Error("RT_DIAGNOSTIC_EXPECTED_PRODUCER_DUPLICATE");
        additions.set(key, Object.freeze({ ...instance }));
      }
      if (this.#expectedProducerSetDeclared) {
        if ([...additions.keys()].every((key) => this.#expectedProducers.has(key))) return;
        throw new Error("RT_DIAGNOSTIC_TOPOLOGY_FINALIZED");
      }
      if (this.#expectedProducers.size + [...additions.keys()].filter((key) => !this.#expectedProducers.has(key)).length > this.maxProducers) {
        throw new Error("RT_DIAGNOSTIC_COVERAGE_PRODUCER_LIMIT");
      }
      for (const [key, instance] of additions) this.#expectedProducers.set(key, instance);
    } catch (error) {
      this.recordRejected();
      throw error;
    }
  }

  finalizeExpectedProducers(): void {
    try {
      if (this.#expectedProducerSetDeclared) return;
      if (this.#expectedProducers.size === 0) throw new Error("RT_DIAGNOSTIC_EXPECTED_PRODUCERS_EMPTY");
      for (const key of this.#observedRanges.keys()) {
        if (!this.#expectedProducers.has(key)) throw new Error("RT_DIAGNOSTIC_UNEXPECTED_PRODUCER");
      }
      this.#expectedProducerSetDeclared = true;
    } catch (error) {
      this.recordRejected();
      throw error;
    }
  }

  closeProducer(checkpoint: EvidenceProducerCheckpoint): void {
    try {
      assertProducerInstance(checkpoint);
      if (checkpoint.closed !== true || !Number.isSafeInteger(checkpoint.highWaterMark) || checkpoint.highWaterMark < 0) {
        throw new Error("RT_DIAGNOSTIC_CHECKPOINT_INVALID");
      }
      if (!this.#expectedProducerSetDeclared) throw new Error("RT_DIAGNOSTIC_EXPECTED_PRODUCERS_UNDECLARED");
      const key = producerKey(checkpoint);
      if (!this.#expectedProducers.has(key)) throw new Error("RT_DIAGNOSTIC_UNEXPECTED_PRODUCER");
      const existing = this.#closedCheckpoints.get(key);
      if (existing) {
        if (existing.highWaterMark !== checkpoint.highWaterMark) throw new Error("RT_DIAGNOSTIC_CHECKPOINT_CONFLICT");
        return;
      }
      const observed = this.#observedRanges.get(key)?.ranges.at(-1)?.last ?? 0;
      if (observed > checkpoint.highWaterMark) throw new Error("RT_DIAGNOSTIC_CHECKPOINT_BEHIND_EVIDENCE");
      this.#closedCheckpoints.set(key, Object.freeze({ ...checkpoint }));
    } catch (error) {
      this.recordRejected();
      throw error;
    }
  }

  observe(record: EvidenceRecord): void {
    try {
      assertProducerInstance(record);
      if (!Number.isSafeInteger(record.recordSequence) || record.recordSequence < 1) {
        throw new Error("RT_DIAGNOSTIC_SEQUENCE_INVALID");
      }
      const key = producerKey(record);
      if (this.#expectedProducerSetDeclared && !this.#expectedProducers.has(key)) {
        throw new Error("RT_DIAGNOSTIC_UNEXPECTED_PRODUCER");
      }
      const checkpoint = this.#closedCheckpoints.get(key);
      if (checkpoint && record.recordSequence > checkpoint.highWaterMark) {
        throw new Error("RT_DIAGNOSTIC_SEQUENCE_AFTER_CHECKPOINT");
      }
      const entry = this.#observedRanges.get(key);
      if (!entry && this.#observedRanges.size >= this.maxProducers) {
        throw new Error("RT_DIAGNOSTIC_COVERAGE_PRODUCER_LIMIT");
      }
      const nextRanges = entry?.ranges.map((range) => ({ ...range })) ?? [];
      insertSequence(nextRanges, record.recordSequence);
      const nextRangeCount = this.#rangeCount - (entry?.ranges.length ?? 0) + nextRanges.length;
      if (nextRangeCount > this.maxRanges) {
        throw new Error("RT_DIAGNOSTIC_COVERAGE_RANGE_LIMIT");
      }
      if (entry) {
        entry.ranges.splice(0, entry.ranges.length, ...nextRanges);
      } else {
        this.#observedRanges.set(key, {
          identity: {
            producerRole: record.producerRole,
            runtimeId: record.runtimeId,
            runtimeBootId: record.runtimeBootId
          },
          ranges: nextRanges
        });
      }
      this.#rangeCount = nextRangeCount;
    } catch (error) {
      this.recordRejected();
      throw error;
    }
  }

  snapshot(): EvidenceCoverageSnapshot {
    const expectedProducerInstances = sortedInstances(this.#expectedProducers.values());
    const observedProducerInstances = sortedInstances([...this.#observedRanges.values()].map(({ identity }) => identity));
    const closedProducerCheckpoints = [...this.#closedCheckpoints.values()].sort(compareProducerInstances);
    const missingProducerInstances: ProducerInstance[] = [];
    const openProducerInstances: ProducerInstance[] = [];
    const unexpectedProducerInstances = observedProducerInstances.filter((instance) => !this.#expectedProducers.has(producerKey(instance)));
    const missingRanges: MissingEvidenceRange[] = [];
    const coveredRanges: EvidenceCoveredRange[] = [];
    for (const instance of expectedProducerInstances) {
      const key = producerKey(instance);
      const observed = this.#observedRanges.get(key);
      const ranges = observed?.ranges ?? [];
      const checkpoint = this.#closedCheckpoints.get(key);
      for (const range of ranges) coveredRanges.push({ ...instance, ...range });
      if (!checkpoint) openProducerInstances.push(instance);
      if (ranges.length === 0 && (!checkpoint || checkpoint.highWaterMark > 0)) missingProducerInstances.push(instance);
      const first = ranges[0];
      if (first && first.first > 1) {
        missingRanges.push({ ...instance, first: 1, last: first.first - 1 });
      }
      for (let index = 1; index < ranges.length; index += 1) {
        const previous = ranges[index - 1]!;
        const current = ranges[index]!;
        if (current.first > previous.last + 1) {
          missingRanges.push({ ...instance, first: previous.last + 1, last: current.first - 1 });
        }
      }
      if (checkpoint) {
        const lastObserved = ranges.at(-1)?.last ?? 0;
        if (lastObserved < checkpoint.highWaterMark) {
          missingRanges.push({ ...instance, first: lastObserved + 1, last: checkpoint.highWaterMark });
        }
      }
    }
    for (const instance of unexpectedProducerInstances) {
      const ranges = this.#observedRanges.get(producerKey(instance))?.ranges ?? [];
      for (const range of ranges) coveredRanges.push({ ...instance, ...range });
      const first = ranges[0];
      if (first && first.first > 1) {
        missingRanges.push({ ...instance, first: 1, last: first.first - 1 });
      }
      for (let index = 1; index < ranges.length; index += 1) {
        const previous = ranges[index - 1]!;
        const current = ranges[index]!;
        if (current.first > previous.last + 1) {
          missingRanges.push({ ...instance, first: previous.last + 1, last: current.first - 1 });
        }
      }
    }
    const partial = !this.#expectedProducerSetDeclared
      || this.#droppedRecords > 0
      || this.#evictedRecords > 0
      || this.#rejectedRecords > 0
      || this.#exportFailedRecords > 0
      || missingRanges.length > 0
      || missingProducerInstances.length > 0
      || openProducerInstances.length > 0
      || unexpectedProducerInstances.length > 0;
    return Object.freeze({
      schemaVersion: EVIDENCE_SINK_SCHEMA_VERSION,
      status: partial ? "partial" : "complete",
      expectedProducerSetDeclared: this.#expectedProducerSetDeclared,
      expectedProducerInstances: freezeInstances(expectedProducerInstances),
      observedProducerInstances: freezeInstances(observedProducerInstances),
      missingProducerInstances: freezeInstances(missingProducerInstances),
      openProducerInstances: freezeInstances(openProducerInstances),
      unexpectedProducerInstances: freezeInstances(unexpectedProducerInstances),
      closedProducerCheckpoints: Object.freeze(closedProducerCheckpoints.map((checkpoint) => Object.freeze({ ...checkpoint }))),
      coveredRanges: Object.freeze(coveredRanges.map((range) => Object.freeze(range))),
      droppedRecords: this.#droppedRecords,
      evictedRecords: this.#evictedRecords,
      rejectedRecords: this.#rejectedRecords,
      exportFailedRecords: this.#exportFailedRecords,
      missingRanges: Object.freeze(missingRanges.map((range) => Object.freeze(range)))
    });
  }
}

export interface BoundedLocalEvidenceSinkOptions {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxCoverageProducers?: number;
  readonly maxCoverageRanges?: number;
}

interface StoredEnvelope {
  readonly evidence: EvidenceEnvelopeV1;
  readonly bytes: number;
  readonly receivedAt: number;
  readonly canonical: string;
  readonly sequenceKey: string;
}

/**
 * A bounded, authoritative process-local sink. It is a conformance and local
 * development implementation, not a durable production backend.
 */
export class BoundedLocalEvidenceSink implements EvidenceSink {
  readonly schemaVersion = EVIDENCE_SINK_SCHEMA_VERSION;
  readonly capabilities = Object.freeze({
    authoritative: true,
    durable: false,
    sampled: false,
    multiProducer: true
  });
  readonly coverage: EvidenceCoverageLedger;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #maxRecordBytes: number;
  readonly #stored: StoredEnvelope[] = [];
  readonly #sequenceIndex = new Map<string, StoredEnvelope>();
  #bytes = 0;

  constructor(options: BoundedLocalEvidenceSinkOptions = {}) {
    this.#maxRecords = positiveInteger(options.maxRecords ?? 10_000, "maxRecords");
    this.#maxBytes = positiveInteger(options.maxBytes ?? 10 * 1024 * 1024, "maxBytes");
    this.#maxAgeMs = positiveInteger(options.maxAgeMs ?? 5 * 60_000, "maxAgeMs");
    this.#maxRecordBytes = positiveInteger(options.maxRecordBytes ?? Math.min(this.#maxBytes, 64 * 1024), "maxRecordBytes");
    if (this.#maxRecordBytes > this.#maxBytes) throw new Error("RT_DIAGNOSTIC_SINK_LIMIT_INVALID:maxRecordBytes");
    this.coverage = new RetentionAwareCoverageLedger({
      maxProducers: options.maxCoverageProducers ?? 256,
      maxRanges: options.maxCoverageRanges ?? this.#maxRecords
    }, () => this.#evict(Date.now()));
  }

  async record(evidence: EvidenceEnvelopeV1): Promise<void> {
    let copy: EvidenceEnvelopeV1;
    let canonical: string;
    let bytes: number;
    try {
      assertEnvelope(evidence);
      copy = structuredClone(evidence);
      canonical = stableJson(copy);
      bytes = new TextEncoder().encode(canonical).byteLength;
    } catch (error) {
      this.coverage.recordRejected();
      if (error instanceof Error && error.message.startsWith("RT_DIAGNOSTIC_")) throw error;
      throw new Error("RT_DIAGNOSTIC_ENVELOPE_INVALID", { cause: error });
    }
    if (bytes > this.#maxRecordBytes || bytes > this.#maxBytes) {
      this.coverage.recordRejected();
      throw new Error("RT_DIAGNOSTIC_RECORD_REJECTED");
    }

    this.#evict(Date.now());
    const sequenceKey = producerSequenceKey(copy.record);
    const existing = this.#sequenceIndex.get(sequenceKey);
    if (existing) {
      if (existing.canonical === canonical) return;
      this.coverage.recordRejected();
      throw new Error("RT_DIAGNOSTIC_SEQUENCE_CONFLICT");
    }
    const stored = { evidence: copy, bytes, receivedAt: Date.now(), canonical, sequenceKey };
    this.coverage.observe(copy.record);
    this.#stored.push(stored);
    this.#sequenceIndex.set(sequenceKey, stored);
    this.#bytes += bytes;
    this.#evict(Date.now());
  }

  declareExpectedProducers(instances: readonly ProducerInstance[]): void {
    this.coverage.declareExpectedProducers(instances);
  }

  registerExpectedProducers(instances: readonly ProducerInstance[]): void {
    this.coverage.registerExpectedProducers(instances);
  }

  finalizeExpectedProducers(): void {
    this.coverage.finalizeExpectedProducers();
  }

  closeProducer(checkpoint: EvidenceProducerCheckpoint): void {
    this.coverage.closeProducer(checkpoint);
  }

  recordExportFailure(count = 1): void {
    this.coverage.recordExportFailure(count);
  }

  records(): readonly EvidenceEnvelopeV1[] {
    this.#evict(Date.now());
    return Object.freeze(this.#stored.map(({ evidence }) => Object.freeze(structuredClone(evidence))));
  }

  stats(): { records: number; bytes: number; limits: Required<BoundedLocalEvidenceSinkOptions> } {
    this.#evict(Date.now());
    return {
      records: this.#stored.length,
      bytes: this.#bytes,
      limits: {
        maxRecords: this.#maxRecords,
        maxBytes: this.#maxBytes,
        maxAgeMs: this.#maxAgeMs,
        maxRecordBytes: this.#maxRecordBytes,
        maxCoverageProducers: this.coverage.maxProducers,
        maxCoverageRanges: this.coverage.maxRanges
      }
    };
  }

  #evict(now: number): void {
    while (this.#stored.length > 0) {
      const oldest = this.#stored[0]!;
      const overAge = now - oldest.receivedAt > this.#maxAgeMs;
      const overCount = this.#stored.length > this.#maxRecords;
      const overBytes = this.#bytes > this.#maxBytes;
      if (!overAge && !overCount && !overBytes) break;
      this.#stored.shift();
      this.#sequenceIndex.delete(oldest.sequenceKey);
      this.#bytes -= oldest.bytes;
      this.coverage.recordEvicted();
    }
  }
}

class RetentionAwareCoverageLedger extends EvidenceCoverageLedger {
  readonly #refresh: () => void;

  constructor(
    options: Required<EvidenceCoverageLedgerOptions>,
    refresh: () => void
  ) {
    super(options);
    this.#refresh = refresh;
  }

  override snapshot(): EvidenceCoverageSnapshot {
    this.#refresh();
    return super.snapshot();
  }
}

const validateRedactedEvidenceRecord = new Ajv2020({ strict: false }).compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $ref: "#/$defs/evidenceRecord",
  $defs: diagnosticQueryResultSchemaV1.$defs
});

function assertEnvelope(value: EvidenceEnvelopeV1): void {
  if (!value
    || Object.keys(value).sort().join(",") !== "payloadPolicy,record,schemaVersion,tenantId"
    || value.schemaVersion !== EVIDENCE_SINK_SCHEMA_VERSION
    || value.payloadPolicy !== "redacted"
    || !isPseudonym(value.tenantId)
    || !validateRedactedEvidenceRecord(value.record)
    || (value.record.details?.tenantId !== undefined && value.record.details.tenantId !== value.tenantId)
    || (value.record.principalNamespaceId !== undefined
      && value.record.details?.principalNamespaceId !== undefined
      && value.record.principalNamespaceId !== value.record.details.principalNamespaceId)) {
    throw new Error("RT_DIAGNOSTIC_ENVELOPE_INVALID");
  }
}

function producerKey(record: Pick<EvidenceRecord, "producerRole" | "runtimeId" | "runtimeBootId">): string {
  return `${record.producerRole}\u0000${record.runtimeId}\u0000${record.runtimeBootId}`;
}

function producerSequenceKey(record: EvidenceRecord): string {
  return `${producerKey(record)}\u0000${record.recordSequence}`;
}

function assertProducerInstance(value: ProducerInstance): void {
  if (!value
    || !["client", "server", "database", "tool", "unknown"].includes(value.producerRole)
    || !isPseudonym(value.runtimeId)
    || !isPseudonym(value.runtimeBootId)) {
    throw new Error("RT_DIAGNOSTIC_PRODUCER_INVALID");
  }
}

function isPseudonym(value: unknown): value is string {
  return typeof value === "string" && /^pseudonym:sha256:[a-f0-9]{64}$/u.test(value);
}

function sameKeys(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): boolean {
  return left.size === right.size && [...left.keys()].every((key) => right.has(key));
}

function sortedInstances(instances: Iterable<ProducerInstance>): ProducerInstance[] {
  return [...instances].map((instance) => ({ ...instance })).sort(compareProducerInstances);
}

function freezeInstances(instances: readonly ProducerInstance[]): readonly ProducerInstance[] {
  return Object.freeze(instances.map((instance) => Object.freeze({ ...instance })));
}

function compareProducerInstances(left: ProducerInstance, right: ProducerInstance): number {
  return producerKey(left).localeCompare(producerKey(right));
}

function insertSequence(ranges: MutableRange[], sequence: number): void {
  let insertion = 0;
  while (insertion < ranges.length && ranges[insertion]!.last < sequence - 1) {
    insertion += 1;
  }
  const current = ranges[insertion];
  if (!current) {
    ranges.push({ first: sequence, last: sequence });
    return;
  }
  if (sequence < current.first - 1) {
    ranges.splice(insertion, 0, { first: sequence, last: sequence });
    return;
  }
  current.first = Math.min(current.first, sequence);
  current.last = Math.max(current.last, sequence);
  while (insertion + 1 < ranges.length && ranges[insertion + 1]!.first <= current.last + 1) {
    current.last = Math.max(current.last, ranges[insertion + 1]!.last);
    ranges.splice(insertion + 1, 1);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`RT_DIAGNOSTIC_SINK_LIMIT_INVALID:${name}`);
  return value;
}

function checkedAdd(current: number, count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(current + count)) throw new Error("RT_DIAGNOSTIC_COVERAGE_COUNT_INVALID");
  return current + count;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
