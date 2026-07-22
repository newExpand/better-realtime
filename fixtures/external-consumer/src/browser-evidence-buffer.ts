export interface BrowserEvidenceBuffer<T> {
  readonly capacity: number;
  readonly records: T[];
  nextSequence: number;
  evictedRecords: number;
}

export interface BrowserEvidenceBufferStatus {
  capacity: number;
  retainedRecords: number;
  evictedRecords: number;
}

export function createBrowserEvidenceBuffer<T>(capacity = 64): BrowserEvidenceBuffer<T> {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("RT_BROWSER_EVIDENCE_CAPACITY_INVALID");
  return { capacity, records: [], nextSequence: 1, evictedRecords: 0 };
}

export function appendBrowserEvidence<T extends { recordSequence: number }>(buffer: BrowserEvidenceBuffer<T>, create: (sequence: number) => T): T {
  const record = create(buffer.nextSequence);
  buffer.nextSequence += 1;
  if (buffer.records.length === buffer.capacity) {
    buffer.records.shift();
    buffer.evictedRecords += 1;
  }
  buffer.records.push(record);
  return record;
}

export function browserEvidenceBufferStatus(buffer: BrowserEvidenceBuffer<unknown>): BrowserEvidenceBufferStatus {
  return { capacity: buffer.capacity, retainedRecords: buffer.records.length, evictedRecords: buffer.evictedRecords };
}
