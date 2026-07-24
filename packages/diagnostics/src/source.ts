import type {
  EvidenceCoverageSnapshot,
  EvidenceCoveredRange,
  EvidenceProducerCheckpoint,
  EvidenceSinkCapabilities,
  MissingEvidenceRange
} from "./sink.ts";
import type { ProducerInstance } from "./types.ts";

export const DIAGNOSTIC_SOURCE_SCHEMA_VERSION = "1.0" as const;

export interface DiagnosticSourceCapabilities extends EvidenceSinkCapabilities {
  readonly queryAudit: boolean;
}

export interface DiagnosticSourceResult<TResult> {
  readonly schemaVersion: typeof DIAGNOSTIC_SOURCE_SCHEMA_VERSION;
  readonly proofEligible: boolean;
  readonly coverage: EvidenceCoverageSnapshot;
  readonly value: TResult;
}

export interface DiagnosticSource<TRequest = unknown, TResult = unknown> {
  readonly schemaVersion: typeof DIAGNOSTIC_SOURCE_SCHEMA_VERSION;
  readonly capabilities: DiagnosticSourceCapabilities;
  query(request: TRequest): Promise<DiagnosticSourceResult<TResult>>;
}

/**
 * A diagnostic value and its coverage must be read from one authoritative
 * source snapshot. Keeping them in one return value prevents a later coverage
 * read from certifying a result produced from different evidence.
 */
export interface DiagnosticSourceSnapshot<TResult> {
  readonly value: TResult;
  readonly coverage: EvidenceCoverageSnapshot;
}

export interface DiagnosticSourceAdapterOptions<TRequest, TResult> {
  readonly capabilities: Omit<DiagnosticSourceCapabilities, "queryAudit"> & { readonly queryAudit?: boolean };
  readonly query: (request: TRequest) => DiagnosticSourceSnapshot<TResult> | Promise<DiagnosticSourceSnapshot<TResult>>;
  /**
   * Generic diagnostic results have no universal proof shape. Callers must
   * provide both the downgrade and its validator instead of relying on a
   * shallow best-effort mutation.
   */
  readonly proofPolicy: DiagnosticResultProofPolicy<TResult>;
}

export interface DiagnosticResultProofPolicy<TResult> {
  readonly isValid: (value: TResult) => boolean;
  readonly downgrade: (value: TResult) => TResult;
  readonly isProofSafe: (value: TResult) => boolean;
}

export interface VersionedDiagnosticResultV1 {
  readonly schemaVersion: "1.0";
  readonly completeness: { readonly status: "complete" | "partial" };
  readonly verdict?: "proven" | "disproven" | "indeterminate";
  readonly report?: {
    readonly verdict: "proven" | "disproven" | "indeterminate";
    readonly completeness: { readonly status: "complete" | "partial" };
  };
}

export const versionedDiagnosticResultV1ProofPolicy: DiagnosticResultProofPolicy<VersionedDiagnosticResultV1> = Object.freeze({
  isValid: (value: VersionedDiagnosticResultV1) => Boolean(value
    && value.schemaVersion === "1.0"
    && (value.completeness?.status === "complete" || value.completeness?.status === "partial")
    && (value.verdict === undefined || ["proven", "disproven", "indeterminate"].includes(value.verdict))
    && (!value.report
      || (["proven", "disproven", "indeterminate"].includes(value.report.verdict)
        && (value.report.completeness?.status === "complete" || value.report.completeness?.status === "partial")))),
  downgrade: (value: VersionedDiagnosticResultV1) => {
    const output = structuredClone(value) as {
      schemaVersion: "1.0";
      completeness: { status: "complete" | "partial" };
      verdict?: "proven" | "disproven" | "indeterminate";
      report?: {
        verdict: "proven" | "disproven" | "indeterminate";
        completeness: { status: "complete" | "partial" };
      };
    };
    output.completeness.status = "partial";
    if (output.verdict === "proven") output.verdict = "indeterminate";
    if (output.report) {
      if (output.report.verdict === "proven") output.report.verdict = "indeterminate";
      output.report.completeness.status = "partial";
    }
    return output;
  },
  isProofSafe: (value: VersionedDiagnosticResultV1) => value?.schemaVersion === "1.0"
    && value.completeness?.status === "partial"
    && value.verdict !== "proven"
    && (!value.report || (value.report.verdict !== "proven" && value.report.completeness?.status === "partial"))
});

export function createDiagnosticSourceAdapter<TRequest, TResult>(
  options: DiagnosticSourceAdapterOptions<TRequest, TResult>
): DiagnosticSource<TRequest, TResult> {
  if (!options.proofPolicy
    || typeof options.proofPolicy.isValid !== "function"
    || typeof options.proofPolicy.downgrade !== "function"
    || typeof options.proofPolicy.isProofSafe !== "function") {
    throw new Error("RT_DIAGNOSTIC_PROOF_POLICY_REQUIRED");
  }
  const capabilities = Object.freeze({ queryAudit: false, ...options.capabilities });
  return Object.freeze({
    schemaVersion: DIAGNOSTIC_SOURCE_SCHEMA_VERSION,
    capabilities,
    query: async (request: TRequest): Promise<DiagnosticSourceResult<TResult>> => {
      const sourceSnapshot = structuredClone(await options.query(request));
      if (!sourceSnapshot || typeof sourceSnapshot !== "object" || !("value" in sourceSnapshot) || !("coverage" in sourceSnapshot)) {
        throw new Error("RT_DIAGNOSTIC_SOURCE_SNAPSHOT_INVALID");
      }
      const value = sourceSnapshot.value;
      if (!options.proofPolicy.isValid(value)) throw new Error("RT_DIAGNOSTIC_RESULT_INVALID");
      const coverage = cloneCoverage(sourceSnapshot.coverage);
      const proofEligible = capabilities.authoritative && !capabilities.sampled && coverageIsProofEligible(coverage);
      return Object.freeze({
        schemaVersion: DIAGNOSTIC_SOURCE_SCHEMA_VERSION,
        proofEligible,
        coverage,
        value: proofEligible ? value : assertSafeDowngrade(options.proofPolicy, value)
      });
    }
  });
}

/**
 * Compatibility boundary for the alpha.4 synchronous LocalDiagnosticSource.
 * It preserves local-file behavior while presenting the new async source API.
 */
export function adaptLocalDiagnosticSource<TRequest, TResult extends VersionedDiagnosticResultV1>(
  source: { query(request: TRequest): TResult }
): DiagnosticSource<TRequest, TResult> {
  return createDiagnosticSourceAdapter({
    capabilities: {
      authoritative: true,
      durable: false,
      sampled: false,
      multiProducer: true,
      queryAudit: false
    },
    proofPolicy: {
      isValid: (value) => versionedDiagnosticResultV1ProofPolicy.isValid(value),
      downgrade: (value) => versionedDiagnosticResultV1ProofPolicy.downgrade(value) as TResult,
      isProofSafe: (value) => versionedDiagnosticResultV1ProofPolicy.isProofSafe(value)
    },
    query: (request) => {
      const result = source.query(request);
      return {
        value: result,
        coverage: coverageFromLegacyResult(result)
      };
    }
  });
}

function assertSafeDowngrade<TResult>(policy: DiagnosticResultProofPolicy<TResult>, value: TResult): TResult {
  const downgraded = structuredClone(policy.downgrade(structuredClone(value)));
  if (!policy.isProofSafe(downgraded)) throw new Error("RT_DIAGNOSTIC_DOWNGRADE_INVALID");
  return downgraded;
}

function coverageFromLegacyResult(value: unknown): EvidenceCoverageSnapshot {
  const completeness = value && typeof value === "object"
    ? (value as {
      completeness?: {
        status?: unknown;
        droppedRecords?: unknown;
        evictedRecords?: unknown;
        expectedProducerInstances?: unknown;
        observedProducerInstances?: unknown;
        missingProducerInstances?: unknown;
        sourceCoveredRanges?: unknown;
      };
    }).completeness
    : undefined;
  const droppedRecords = nonNegativeInteger(completeness?.droppedRecords);
  const evictedRecords = nonNegativeInteger(completeness?.evictedRecords);
  const expectedProducerInstances = producerInstances(completeness?.expectedProducerInstances);
  const observedProducerInstances = producerInstances(completeness?.observedProducerInstances);
  const missingProducerInstances = producerInstances(completeness?.missingProducerInstances);
  const missingRanges = initialAndInteriorGaps(completeness?.sourceCoveredRanges);
  const coveredRanges = sourceCoveredRanges(completeness?.sourceCoveredRanges);
  return Object.freeze({
    schemaVersion: "1.0",
    status: "partial",
    expectedProducerSetDeclared: Array.isArray(completeness?.expectedProducerInstances),
    expectedProducerInstances: freezeInstances(expectedProducerInstances),
    observedProducerInstances: freezeInstances(observedProducerInstances),
    missingProducerInstances: freezeInstances(missingProducerInstances),
    openProducerInstances: freezeInstances(expectedProducerInstances),
    unexpectedProducerInstances: Object.freeze([]),
    closedProducerCheckpoints: Object.freeze([]),
    coveredRanges: Object.freeze(coveredRanges.map((range) => Object.freeze(range))),
    droppedRecords,
    evictedRecords,
    rejectedRecords: 0,
    exportFailedRecords: 0,
    missingRanges: Object.freeze(missingRanges.map((range) => Object.freeze(range)))
  });
}

function cloneCoverage(value: EvidenceCoverageSnapshot): EvidenceCoverageSnapshot {
  if (!isCoverageSnapshot(value)) throw new Error("RT_DIAGNOSTIC_COVERAGE_INVALID");
  const clone = Object.freeze({
    ...value,
    expectedProducerInstances: freezeInstances(value.expectedProducerInstances),
    observedProducerInstances: freezeInstances(value.observedProducerInstances),
    missingProducerInstances: freezeInstances(value.missingProducerInstances),
    openProducerInstances: freezeInstances(value.openProducerInstances),
    unexpectedProducerInstances: freezeInstances(value.unexpectedProducerInstances),
    closedProducerCheckpoints: Object.freeze(value.closedProducerCheckpoints.map((checkpoint) => Object.freeze({ ...checkpoint }))),
    coveredRanges: Object.freeze(value.coveredRanges.map((range) => Object.freeze({ ...range }))),
    missingRanges: Object.freeze(value.missingRanges.map((range) => Object.freeze({ ...range })))
  });
  if (clone.status === "complete" && !coverageIsComplete(clone)) throw new Error("RT_DIAGNOSTIC_COVERAGE_INVALID");
  return clone;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function isCoverageSnapshot(value: EvidenceCoverageSnapshot): boolean {
  return Boolean(value
    && value.schemaVersion === "1.0"
    && (value.status === "complete" || value.status === "partial")
    && typeof value.expectedProducerSetDeclared === "boolean"
    && Array.isArray(value.expectedProducerInstances)
    && Array.isArray(value.observedProducerInstances)
    && Array.isArray(value.missingProducerInstances)
    && Array.isArray(value.openProducerInstances)
    && Array.isArray(value.unexpectedProducerInstances)
    && Array.isArray(value.closedProducerCheckpoints)
    && Array.isArray(value.coveredRanges)
    && Array.isArray(value.missingRanges)
    && [value.droppedRecords, value.evictedRecords, value.rejectedRecords, value.exportFailedRecords]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
    && [
      ...value.expectedProducerInstances,
      ...value.observedProducerInstances,
      ...value.missingProducerInstances,
      ...value.openProducerInstances,
      ...value.unexpectedProducerInstances
    ].every(isProducerInstance)
    && value.closedProducerCheckpoints.every(isCheckpoint)
    && value.coveredRanges.every(isMissingRange)
    && value.missingRanges.every(isMissingRange));
}

function coverageIsComplete(value: EvidenceCoverageSnapshot): boolean {
  if (value.status !== "complete"
    || !value.expectedProducerSetDeclared
    || value.droppedRecords !== 0
    || value.evictedRecords !== 0
    || value.rejectedRecords !== 0
    || value.exportFailedRecords !== 0
    || value.missingProducerInstances.length !== 0
    || value.openProducerInstances.length !== 0
    || value.unexpectedProducerInstances.length !== 0
    || value.missingRanges.length !== 0) {
    return false;
  }
  const expected = new Set(value.expectedProducerInstances.map(producerKey));
  const observed = new Set(value.observedProducerInstances.map(producerKey));
  const checkpoints = new Set(value.closedProducerCheckpoints.map(producerKey));
  if (expected.size !== value.expectedProducerInstances.length
    || observed.size !== value.observedProducerInstances.length
    || checkpoints.size !== value.closedProducerCheckpoints.length
    || expected.size !== checkpoints.size
    || [...expected].some((key) => !checkpoints.has(key))
    || [...observed].some((key) => !expected.has(key))) {
    return false;
  }
  const ranges = new Map<string, EvidenceCoveredRange[]>();
  for (const range of value.coveredRanges) {
    const key = producerKey(range);
    if (!expected.has(key)) return false;
    const entries = ranges.get(key) ?? [];
    entries.push(range);
    ranges.set(key, entries);
  }
  return value.closedProducerCheckpoints.every((checkpoint) => {
    const key = producerKey(checkpoint);
    const entries = ranges.get(producerKey(checkpoint)) ?? [];
    return checkpoint.highWaterMark === 0
      ? entries.length === 0 && !observed.has(key)
      : observed.has(key) && entries.length === 1 && entries[0]!.first === 1 && entries[0]!.last === checkpoint.highWaterMark;
  });
}

function coverageIsProofEligible(value: EvidenceCoverageSnapshot): boolean {
  return coverageIsComplete(value)
    && value.expectedProducerInstances.length > 0
    && value.closedProducerCheckpoints.every((checkpoint) => checkpoint.highWaterMark > 0);
}

function producerInstances(value: unknown): ProducerInstance[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isProducerInstance).map((instance) => ({ ...instance }));
}

function initialAndInteriorGaps(value: unknown): MissingEvidenceRange[] {
  if (!Array.isArray(value)) return [];
  const output: MissingEvidenceRange[] = [];
  for (const entry of value) {
    if (!isMissingRange(entry)) continue;
    if (entry.first > 1) output.push({ ...entry, first: 1, last: entry.first - 1 });
  }
  return output;
}

function sourceCoveredRanges(value: unknown): EvidenceCoveredRange[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is EvidenceCoveredRange => isMissingRange(entry))
    .map(({ producerRole, runtimeId, runtimeBootId, first, last }) => ({ producerRole, runtimeId, runtimeBootId, first, last }));
}

function freezeInstances(instances: readonly ProducerInstance[]): readonly ProducerInstance[] {
  return Object.freeze(instances.map((instance) => Object.freeze({ ...instance })));
}

function isProducerInstance(value: unknown): value is ProducerInstance {
  if (!value || typeof value !== "object") return false;
  const instance = value as Partial<ProducerInstance>;
  return ["client", "server", "database", "tool", "unknown"].includes(String(instance.producerRole))
    && typeof instance.runtimeId === "string"
    && typeof instance.runtimeBootId === "string";
}

function isCheckpoint(value: unknown): value is EvidenceProducerCheckpoint {
  return isProducerInstance(value)
    && (value as Partial<EvidenceProducerCheckpoint>).closed === true
    && Number.isSafeInteger((value as Partial<EvidenceProducerCheckpoint>).highWaterMark)
    && Number((value as Partial<EvidenceProducerCheckpoint>).highWaterMark) >= 0;
}

function isMissingRange(value: unknown): value is MissingEvidenceRange {
  return isProducerInstance(value)
    && Number.isSafeInteger((value as Partial<MissingEvidenceRange>).first)
    && Number((value as Partial<MissingEvidenceRange>).first) >= 1
    && Number.isSafeInteger((value as Partial<MissingEvidenceRange>).last)
    && Number((value as Partial<MissingEvidenceRange>).last) >= Number((value as Partial<MissingEvidenceRange>).first);
}

function producerKey(value: ProducerInstance): string {
  return `${value.producerRole}\u0000${value.runtimeId}\u0000${value.runtimeBootId}`;
}
