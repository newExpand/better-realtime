import { pseudonymizeIdentifier, redactBrowserEvidenceRecord } from "./browser-redaction.ts";
import type { EvidenceRoutingContext } from "./recorder.ts";
import type {
  EvidenceEnvelopeV1,
  EvidenceProducerCheckpoint,
  EvidenceSink
} from "./sink.ts";
import type { EvidenceRecord, ProducerInstance } from "./types.ts";

export interface EvidenceExporterOptions {
  readonly sink: EvidenceSink;
  readonly topology?: "exclusive" | "shared";
  readonly pseudonymizationKey: string;
  readonly tenantId: string | ((record: EvidenceRecord, routing: EvidenceRoutingContext) => string);
  readonly expectedProducers: readonly ProducerInstance[];
  readonly maxPendingRecords?: number;
  readonly redactRecord?: (record: EvidenceRecord, pseudonymizationKey: string) => EvidenceRecord;
}

export interface EvidenceExporterSnapshot {
  readonly pendingRecords: number;
  readonly acceptedRecords: number;
  readonly exportFailedRecords: number;
  readonly closed: boolean;
}

/**
 * Browser-safe bridge from synchronous producer recorders to an asynchronous
 * sink. Server callers may supply the richer diagnostic-query redactor without
 * pulling that analyzer into the browser entry.
 */
export class BoundedEvidenceExporter {
  readonly #sink: EvidenceSink;
  readonly #pseudonymizationKey: string;
  readonly #tenantId: (record: EvidenceRecord, routing: EvidenceRoutingContext) => string;
  readonly #expectedProducers: readonly ProducerInstance[];
  readonly #maxPendingRecords: number;
  readonly #redactRecord: (record: EvidenceRecord, pseudonymizationKey: string) => EvidenceRecord;
  #pendingRecords = 0;
  #acceptedRecords = 0;
  #exportFailedRecords = 0;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: EvidenceExporterOptions) {
    if (!options.sink || typeof options.sink.record !== "function") throw new Error("RT_DIAGNOSTIC_SINK_INVALID");
    if (typeof options.pseudonymizationKey !== "string" || new TextEncoder().encode(options.pseudonymizationKey).byteLength < 32) {
      throw new Error("RT_DIAGNOSTIC_PSEUDONYMIZATION_KEY_INVALID");
    }
    this.#sink = options.sink;
    this.#pseudonymizationKey = options.pseudonymizationKey;
    this.#redactRecord = options.redactRecord ?? redactBrowserEvidenceRecord;
    const tenantId = options.tenantId;
    this.#tenantId = typeof tenantId === "function" ? tenantId : () => tenantId;
    this.#maxPendingRecords = positiveInteger(options.maxPendingRecords ?? 256, "maxPendingRecords");
    const producers = options.expectedProducers.map((instance) => {
      if (!instance || !["client", "server", "database", "tool", "unknown"].includes(instance.producerRole)
        || typeof instance.runtimeId !== "string" || !instance.runtimeId
        || typeof instance.runtimeBootId !== "string" || !instance.runtimeBootId) {
        throw new Error("RT_DIAGNOSTIC_PRODUCER_INVALID");
      }
      return Object.freeze({
        producerRole: instance.producerRole,
        runtimeId: pseudonymizeIdentifier(instance.runtimeId, this.#pseudonymizationKey),
        runtimeBootId: pseudonymizeIdentifier(instance.runtimeBootId, this.#pseudonymizationKey)
      });
    });
    if (producers.length === 0 || new Set(producers.map(producerKey)).size !== producers.length) {
      throw new Error("RT_DIAGNOSTIC_EXPECTED_PRODUCERS_INVALID");
    }
    this.#expectedProducers = Object.freeze(producers);
    if (options.topology === "shared") {
      if (!this.#sink.capabilities.multiProducer
        || typeof this.#sink.registerExpectedProducers !== "function"
        || typeof this.#sink.finalizeExpectedProducers !== "function") {
        throw new Error("RT_DIAGNOSTIC_SHARED_TOPOLOGY_UNSUPPORTED");
      }
      this.#sink.registerExpectedProducers(this.#expectedProducers);
    } else {
      this.#sink.declareExpectedProducers?.(this.#expectedProducers);
    }
  }

  record(record: EvidenceRecord, routing: EvidenceRoutingContext = Object.freeze({})): void {
    if (this.#closed) {
      this.#markFailure();
      return;
    }
    if (this.#pendingRecords >= this.#maxPendingRecords) {
      this.#markFailure();
      return;
    }
    let evidence: EvidenceEnvelopeV1;
    try {
      const tenantId = this.#tenantId(record, routing);
      if (typeof tenantId !== "string" || !tenantId || tenantId.length > 512) throw new Error("RT_DIAGNOSTIC_TENANT_INVALID");
      evidence = {
        schemaVersion: "1.0",
        tenantId: pseudonymizeIdentifier(tenantId, this.#pseudonymizationKey),
        payloadPolicy: "redacted",
        record: this.#redactRecord(record, this.#pseudonymizationKey)
      };
    } catch {
      this.#markFailure();
      return;
    }
    this.#pendingRecords += 1;
    this.#tail = this.#tail
      .then(() => this.#sink.record(evidence))
      .then(() => { this.#acceptedRecords += 1; })
      .catch(() => { this.#markFailure(); })
      .finally(() => { this.#pendingRecords -= 1; });
  }

  snapshot(): EvidenceExporterSnapshot {
    return Object.freeze({
      pendingRecords: this.#pendingRecords,
      acceptedRecords: this.#acceptedRecords,
      exportFailedRecords: this.#exportFailedRecords,
      closed: this.#closed
    });
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#exportFailedRecords > 0) throw new Error("RT_DIAGNOSTIC_EXPORT_FAILED");
  }

  async close(checkpoints: readonly EvidenceProducerCheckpoint[]): Promise<void> {
    if (this.#closed) return this.flush();
    this.#closed = true;
    await this.#tail;
    const normalized = checkpoints.map((checkpoint) => ({
      producerRole: checkpoint.producerRole,
      runtimeId: pseudonymizeIdentifier(checkpoint.runtimeId, this.#pseudonymizationKey),
      runtimeBootId: pseudonymizeIdentifier(checkpoint.runtimeBootId, this.#pseudonymizationKey),
      highWaterMark: checkpoint.highWaterMark,
      closed: true as const
    }));
    if (normalized.length !== this.#expectedProducers.length
      || new Set(normalized.map(producerKey)).size !== normalized.length
      || normalized.some((checkpoint) => !this.#expectedProducers.some((producer) => producerKey(producer) === producerKey(checkpoint)))) {
      this.#markFailure();
    } else {
      try {
        for (const checkpoint of normalized) this.#sink.closeProducer?.(checkpoint);
      } catch {
        this.#markFailure();
      }
    }
    if (this.#exportFailedRecords > 0) throw new Error("RT_DIAGNOSTIC_EXPORT_FAILED");
  }

  #markFailure(): void {
    this.#exportFailedRecords += 1;
    try { this.#sink.recordExportFailure?.(); } catch { /* local counter remains authoritative */ }
  }
}

function producerKey(record: Pick<EvidenceRecord, "producerRole" | "runtimeId" | "runtimeBootId">): string {
  return `${record.producerRole}\u0000${record.runtimeId}\u0000${record.runtimeBootId}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`RT_DIAGNOSTIC_SINK_LIMIT_INVALID:${name}`);
  return value;
}
