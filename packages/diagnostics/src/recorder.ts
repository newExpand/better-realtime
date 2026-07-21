import type { CausalEdge, EvidenceRecord, ProducerRole } from "./types.ts";

const monotonicNanoseconds = (): string => {
  const milliseconds = globalThis.performance?.now?.() ?? Date.now();
  return Math.floor(milliseconds * 1_000_000).toString();
};

export interface RecorderLimits { maxRecords: number; maxBytes: number; maxAgeMs: number }
export interface RecordInput extends Omit<EvidenceRecord, "schemaVersion" | "recordId" | "recordSequence" | "timestamp" | "monotonicNs" | "producerRole" | "runtimeId" | "runtimeBootId" | "previousRecordHash"> {}

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

  constructor(options: { runtimeId: string; runtimeBootId?: string; producerRole: ProducerRole; limits?: Partial<RecorderLimits> }) {
    this.runtimeId = options.runtimeId;
    this.runtimeBootId = options.runtimeBootId ?? `boot_${crypto.randomUUID()}`;
    this.producerRole = options.producerRole;
    this.limits = { maxRecords: 10_000, maxBytes: 10 * 1024 * 1024, maxAgeMs: 5 * 60_000, ...options.limits };
  }

  record(input: RecordInput): EvidenceRecord {
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
    return record;
  }

  edge(edge: CausalEdge): void {
    this.#edges.push(edge);
    while (this.#edges.length > this.limits.maxRecords * 2) this.#edges.shift();
  }

  records(): readonly EvidenceRecord[] { return this.#records; }
  edges(): readonly CausalEdge[] { return this.#edges; }
  stats() { return { records: this.#records.length, bytes: this.#bytes, evictedRecords: this.#evicted, droppedRecords: this.#dropped, edges: this.#edges.length }; }

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
