import type { JsonValue } from "@realtime/protocol";

export interface StoredEvent {
  eventId: string;
  stream: string;
  sequence: number;
  cursor: string;
  type: string;
  schema: string;
  data: JsonValue;
  commandId?: string;
  occurredAt: string;
}

export interface CommandRecord {
  commandId: string;
  state: "completed";
  result: JsonValue;
  eventId: string;
  eventStream: string;
  eventSequence: number;
  completedAt: string;
}

export function encodeCursor(sequence: number): string {
  return Buffer.from(`v1:${sequence}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const value = Buffer.from(cursor, "base64url").toString("utf8");
    if (!value.startsWith("v1:")) return null;
    const sequence = Number(value.slice(3));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
  } catch { return null; }
}

export class InMemoryEventStore {
  #events = new Map<string, StoredEvent[]>();
  #commands = new Map<string, CommandRecord>();
  #retentionFloor = new Map<string, number>();

  append(stream: string, type: string, data: JsonValue, commandId?: string): StoredEvent {
    const events = this.#events.get(stream) ?? [];
    const sequence = (events.at(-1)?.sequence ?? 0) + 1;
    const event: StoredEvent = { eventId: `evt_${crypto.randomUUID()}`, stream, sequence, cursor: encodeCursor(sequence), type, schema: `${type}@1`, data, ...(commandId ? { commandId } : {}), occurredAt: new Date().toISOString() };
    events.push(event);
    this.#events.set(stream, events);
    return event;
  }

  eventsAfter(stream: string, after: number): StoredEvent[] { return (this.#events.get(stream) ?? []).filter((event) => event.sequence > after); }
  head(stream: string): StoredEvent | undefined { return this.#events.get(stream)?.at(-1); }
  all(stream: string): StoredEvent[] { return [...(this.#events.get(stream) ?? [])]; }
  snapshot(stream: string): { messages: JsonValue[]; sequence: number } {
    const events = this.#events.get(stream) ?? [];
    return { messages: events.map((event) => event.data), sequence: events.at(-1)?.sequence ?? 0 };
  }
  expireBeforeCurrentHead(stream: string): void { this.#retentionFloor.set(stream, (this.head(stream)?.sequence ?? 0) + 2); }
  canReplay(stream: string, sequence: number): boolean { return sequence >= (this.#retentionFloor.get(stream) ?? 1) - 1; }
  command(commandId: string): CommandRecord | undefined { return this.#commands.get(commandId); }
  completeCommand(record: CommandRecord): void { this.#commands.set(record.commandId, record); }
  inspect() { return { streams: [...this.#events].map(([stream, events]) => ({ stream, events: events.length, head: events.at(-1)?.cursor ?? null, retentionFloor: this.#retentionFloor.get(stream) ?? 1 })), commands: this.#commands.size }; }
}
