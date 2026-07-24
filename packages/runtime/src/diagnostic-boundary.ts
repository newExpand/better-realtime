import {
  BoundedLocalEvidenceSink as InternalBoundedLocalEvidenceSink,
  DIAGNOSTIC_SOURCE_SCHEMA_VERSION as INTERNAL_DIAGNOSTIC_SOURCE_SCHEMA_VERSION,
  EVIDENCE_SINK_SCHEMA_VERSION as INTERNAL_EVIDENCE_SINK_SCHEMA_VERSION,
  EvidenceCoverageLedger as InternalEvidenceCoverageLedger,
  createDiagnosticSourceAdapter as createInternalDiagnosticSourceAdapter,
  type DiagnosticSourceAdapterOptions as InternalDiagnosticSourceAdapterOptions
} from "@realtime/diagnostics";
import type { DiagnosticProducerInstance, SourceDiagnosticEvidenceRecord } from "./diagnostic-types.js";

export const EVIDENCE_SINK_SCHEMA_VERSION = INTERNAL_EVIDENCE_SINK_SCHEMA_VERSION;
export const DIAGNOSTIC_SOURCE_SCHEMA_VERSION = INTERNAL_DIAGNOSTIC_SOURCE_SCHEMA_VERSION;

export interface EvidenceEnvelopeV1 {
  readonly schemaVersion: typeof EVIDENCE_SINK_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly payloadPolicy: "redacted";
  readonly record: SourceDiagnosticEvidenceRecord;
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
  registerExpectedProducers?(instances: readonly DiagnosticProducerInstance[]): void;
  finalizeExpectedProducers?(): void;
  declareExpectedProducers?(instances: readonly DiagnosticProducerInstance[]): void;
  closeProducer?(checkpoint: EvidenceProducerCheckpoint): void;
  recordExportFailure?(count?: number): void;
}

export interface MissingEvidenceRange extends DiagnosticProducerInstance {
  readonly first: number;
  readonly last: number;
}

export interface EvidenceProducerCheckpoint extends DiagnosticProducerInstance {
  readonly highWaterMark: number;
  readonly closed: true;
}

export interface EvidenceCoverageSnapshot {
  readonly schemaVersion: typeof EVIDENCE_SINK_SCHEMA_VERSION;
  readonly status: "complete" | "partial";
  readonly expectedProducerSetDeclared: boolean;
  readonly expectedProducerInstances: readonly DiagnosticProducerInstance[];
  readonly observedProducerInstances: readonly DiagnosticProducerInstance[];
  readonly missingProducerInstances: readonly DiagnosticProducerInstance[];
  readonly openProducerInstances: readonly DiagnosticProducerInstance[];
  readonly unexpectedProducerInstances: readonly DiagnosticProducerInstance[];
  readonly closedProducerCheckpoints: readonly EvidenceProducerCheckpoint[];
  readonly coveredRanges: readonly MissingEvidenceRange[];
  readonly droppedRecords: number;
  readonly evictedRecords: number;
  readonly rejectedRecords: number;
  readonly exportFailedRecords: number;
  readonly missingRanges: readonly MissingEvidenceRange[];
}

export interface EvidenceCoverageLedger {
  readonly maxProducers: number;
  readonly maxRanges: number;
  recordDropped(count?: number): void;
  recordEvicted(count?: number): void;
  recordRejected(count?: number): void;
  recordExportFailure(count?: number): void;
  registerExpectedProducers(instances: readonly DiagnosticProducerInstance[]): void;
  finalizeExpectedProducers(): void;
  declareExpectedProducers(instances: readonly DiagnosticProducerInstance[]): void;
  closeProducer(checkpoint: EvidenceProducerCheckpoint): void;
  observe(record: SourceDiagnosticEvidenceRecord): void;
  snapshot(): EvidenceCoverageSnapshot;
}

export interface EvidenceCoverageLedgerOptions {
  readonly maxProducers?: number;
  readonly maxRanges?: number;
}

export const EvidenceCoverageLedger: {
  new(options?: EvidenceCoverageLedgerOptions): EvidenceCoverageLedger;
} = InternalEvidenceCoverageLedger as unknown as {
  new(options?: EvidenceCoverageLedgerOptions): EvidenceCoverageLedger;
};

export interface BoundedLocalEvidenceSinkOptions {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxCoverageProducers?: number;
  readonly maxCoverageRanges?: number;
}

export interface BoundedLocalEvidenceSink extends EvidenceSink {
  readonly coverage: EvidenceCoverageLedger;
  records(): readonly EvidenceEnvelopeV1[];
  stats(): {
    records: number;
    bytes: number;
    limits: Required<BoundedLocalEvidenceSinkOptions>;
  };
}

export const BoundedLocalEvidenceSink: {
  new(options?: BoundedLocalEvidenceSinkOptions): BoundedLocalEvidenceSink;
} = InternalBoundedLocalEvidenceSink as unknown as {
  new(options?: BoundedLocalEvidenceSinkOptions): BoundedLocalEvidenceSink;
};

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

export interface DiagnosticSourceSnapshot<TResult> {
  readonly value: TResult;
  readonly coverage: EvidenceCoverageSnapshot;
}

export interface DiagnosticResultProofPolicy<TResult> {
  readonly isValid: (value: TResult) => boolean;
  readonly downgrade: (value: TResult) => TResult;
  readonly isProofSafe: (value: TResult) => boolean;
}

export interface DiagnosticSourceAdapterOptions<TRequest, TResult> {
  readonly capabilities: Omit<DiagnosticSourceCapabilities, "queryAudit"> & { readonly queryAudit?: boolean };
  readonly query: (request: TRequest) => DiagnosticSourceSnapshot<TResult> | Promise<DiagnosticSourceSnapshot<TResult>>;
  readonly proofPolicy: DiagnosticResultProofPolicy<TResult>;
}

export function createDiagnosticSourceAdapter<TRequest, TResult>(
  options: DiagnosticSourceAdapterOptions<TRequest, TResult>
): DiagnosticSource<TRequest, TResult> {
  return createInternalDiagnosticSourceAdapter(
    options as unknown as InternalDiagnosticSourceAdapterOptions<TRequest, TResult>
  ) as unknown as DiagnosticSource<TRequest, TResult>;
}
