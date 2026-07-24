import type { CausalEdge, EvidenceRecord, ProducerRole } from "./types.ts";

const monotonicNanoseconds = (): string => {
  const milliseconds = globalThis.performance?.now?.() ?? Date.now();
  return Math.floor(milliseconds * 1_000_000).toString();
};

const positiveSafeInteger = (value: number, name: keyof RecorderLimits): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RT_DIAGNOSTIC_RECORDER_LIMIT_INVALID:${name}`);
  }
  return value;
};

export interface RecorderLimits { maxRecords: number; maxBytes: number; maxAgeMs: number }
export interface RecordInput extends Omit<EvidenceRecord, "schemaVersion" | "recordId" | "recordSequence" | "timestamp" | "monotonicNs" | "producerRole" | "runtimeId" | "runtimeBootId" | "previousRecordHash"> {}
export interface EvidenceRoutingContext {
  /**
   * Trusted collection metadata. This value is never copied into the evidence
   * record and must come from the authenticated runtime boundary, not payload
   * details supplied by an application.
   */
  readonly tenantId?: string;
}

export class FlightRecorder {
  readonly runtimeId: string;
  readonly runtimeBootId: string;
  readonly producerRole: ProducerRole;
  readonly limits: RecorderLimits;
  #records: EvidenceRecord[] = [];
  #edges: CausalEdge[] = [];
  #bytes = 0;
  #sequence = 0;
  #evicted = 0;
  #dropped = 0;
  readonly #onRecord: ((record: EvidenceRecord, routing: EvidenceRoutingContext) => void) | undefined;

  constructor(options: {
    runtimeId: string;
    runtimeBootId?: string;
    producerRole: ProducerRole;
    limits?: Partial<RecorderLimits>;
    /**
     * Synchronous, non-throwing collection hook. Exporters must enqueue into a
     * bounded structure and account for rejection asynchronously.
     */
    onRecord?: (record: EvidenceRecord, routing: EvidenceRoutingContext) => void;
  }) {
    this.runtimeId = options.runtimeId;
    this.runtimeBootId = options.runtimeBootId ?? `boot_${crypto.randomUUID()}`;
    this.producerRole = options.producerRole;
    const limits = { maxRecords: 10_000, maxBytes: 10 * 1024 * 1024, maxAgeMs: 5 * 60_000, ...options.limits };
    const maxRecords = positiveSafeInteger(limits.maxRecords, "maxRecords");
    if (!Number.isSafeInteger(maxRecords * 2)) {
      throw new Error("RT_DIAGNOSTIC_RECORDER_LIMIT_INVALID:maxRecords");
    }
    this.limits = Object.freeze({
      maxRecords,
      maxBytes: positiveSafeInteger(limits.maxBytes, "maxBytes"),
      maxAgeMs: positiveSafeInteger(limits.maxAgeMs, "maxAgeMs")
    });
    this.#onRecord = options.onRecord;
  }

  record(input: RecordInput, routing: EvidenceRoutingContext = Object.freeze({})): EvidenceRecord {
    const now = new Date();
    const principalNamespaceId = input.principalNamespaceId ?? (typeof input.details?.principalNamespaceId === "string" ? input.details.principalNamespaceId : undefined);
    const base = {
      ...input,
      ...(principalNamespaceId ? { principalNamespaceId } : {}),
      schemaVersion: "1.0" as const,
      recordId: `rec_${crypto.randomUUID()}`,
      recordSequence: ++this.#sequence,
      timestamp: now.toISOString(),
      monotonicNs: monotonicNanoseconds(),
      producerRole: this.producerRole,
      runtimeId: this.runtimeId,
      runtimeBootId: this.runtimeBootId
    };
    const record: EvidenceRecord = base;
    const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (size > this.limits.maxBytes) {
      this.#dropped += 1;
      throw new Error("diagnostic record exceeds maxBytes");
    }
    this.#records.push(record);
    this.#bytes += size;
    this.#evict(now.getTime());
    this.#onRecord?.(record, Object.freeze({ ...routing }));
    return record;
  }

  edge(edge: CausalEdge): void {
    this.#edges.push(edge);
    while (this.#edges.length > this.limits.maxRecords * 2) this.#edges.shift();
  }

  records(): readonly EvidenceRecord[] { return this.#records; }
  edges(): readonly CausalEdge[] { return this.#edges; }
  stats() { return { records: this.#records.length, bytes: this.#bytes, evictedRecords: this.#evicted, droppedRecords: this.#dropped, edges: this.#edges.length, highWaterMark: this.#sequence }; }

  query(filters: Partial<Pick<EvidenceRecord, "stream" | "transactionId" | "operationCorrelationId" | "commandId" | "eventId" | "resourceId" | "boundary">>, limit = 100): { records: EvidenceRecord[]; hasMore: boolean; omittedCount: number } {
    const matches = this.#records.filter((record) => Object.entries(filters).every(([key, value]) => value === undefined || record[key as keyof EvidenceRecord] === value));
    return { records: matches.slice(-limit), hasMore: matches.length > limit, omittedCount: Math.max(0, matches.length - limit) };
  }

  #evict(now: number): void {
    while (this.#records.length > 0) {
      const oldest = this.#records[0]!;
      const overAge = now - Date.parse(oldest.timestamp) > this.limits.maxAgeMs;
      const overCount = this.#records.length > this.limits.maxRecords;
      const overBytes = this.#bytes > this.limits.maxBytes;
      if (!overAge && !overCount && !overBytes) break;
      this.#records.shift();
      this.#bytes -= new TextEncoder().encode(JSON.stringify(oldest)).byteLength;
      this.#evicted += 1;
    }
  }
}
