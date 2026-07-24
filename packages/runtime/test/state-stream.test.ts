import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createRealtimeClient,
  defineRealtimeContract,
  jsonSchema,
  stateStream,
  stream,
  type DeepReadonly,
  type RealtimeClient,
  type WebSocketConstructor
} from "../src/index.ts";

const input = jsonSchema("test.state-stream.input@1", {
  type: "object",
  required: ["roomId"],
  properties: { roomId: { type: "string" } },
  additionalProperties: false
});
const message = jsonSchema("test.state-stream.message@1", {
  type: "object",
  required: ["id", "text"],
  properties: { id: { type: "string" }, text: { type: "string" } },
  additionalProperties: false
});
const state = jsonSchema("test.state-stream.state@1", {
  type: "object",
  required: ["messages"],
  properties: { messages: { type: "array", items: message.schema } },
  additionalProperties: false
});

const contract = defineRealtimeContract({
  contractId: "test.state-stream",
  manifestVersion: "1.0.0",
  streams: {
    room: stateStream({
      input,
      state,
      key: ({ roomId }) => `room:${roomId}`,
      initial: () => ({ messages: [] }),
      events: {
        messageAdded: {
          data: message,
          reduce: (current, payload, meta) => {
            expectTypeOf(payload.id).toEqualTypeOf<string>();
            expectTypeOf(payload.text).toEqualTypeOf<string>();
            expectTypeOf(meta.type).toEqualTypeOf<"messageAdded">();
            expectTypeOf(meta.sequence).toEqualTypeOf<number>();
            return { messages: [...current.messages, payload] };
          }
        }
      }
    })
  },
  commands: {}
});

class StateStreamSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static invalidEnvelope = false;
  readonly bufferedAmount = 0;
  readonly readyState = StateStreamSocket.CONNECTING;
  readonly #listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor() { queueMicrotask(() => this.#emit("open", {})); }
  addEventListener(type: string, listener: (...args: any[]) => void): void { const listeners = this.#listeners.get(type) ?? new Set(); listeners.add(listener); this.#listeners.set(type, listeners); }
  removeEventListener(type: string, listener: (...args: any[]) => void): void { this.#listeners.get(type)?.delete(listener); }
  send(data: string): void {
    const sent = JSON.parse(data) as Record<string, unknown>;
    if (sent.kind === "session.open") queueMicrotask(() => this.#message({
      kind: "session.ready",
      sessionId: "session",
      sessionGeneration: 1,
      authGeneration: 1,
      resumeStatus: "fresh",
      capabilities: {
        schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true,
        durableReplay: true, replayRetentionMs: 60_000, snapshotResync: "fenced",
        idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 30_000,
        idempotencyRetentionMs: 60_000, maxMessageBytes: 1_048_576,
        maxRecoveryBufferRecords: 100, maxRecoveryBufferBytes: 1_048_576
      },
      heartbeat: { mode: "application", intervalMs: 60_000, timeoutMs: 60_000 }
    }));
    if (sent.kind === "stream.subscribe") queueMicrotask(() => {
      this.#message({ kind: "stream.subscribed", requestId: sent.requestId, subscriptionId: "sub", stream: sent.stream, mode: "snapshot", baseline: null, head: "cursor_3" });
      this.#message({ kind: "stream.resync.required", subscriptionId: "sub", resyncId: "resync", stream: sent.stream, reason: "client_requested" });
      this.#message({
        kind: "stream.snapshot",
        subscriptionId: "sub",
        resyncId: "resync",
        snapshotId: "snapshot",
        stream: sent.stream,
        cursor: "cursor_2",
        head: "cursor_3",
        schema: contract.manifest.streams.room!.snapshotSchema,
        state: StateStreamSocket.invalidEnvelope
          ? { state: { messages: [] }, includedSequence: -1 }
          : { state: { messages: [] }, includedSequence: 2 }
      });
      if (!StateStreamSocket.invalidEnvelope) {
        this.#message({
          kind: "event", deliveryId: "delivery_3", sessionGeneration: 1, deliveryMode: "snapshot_catchup",
          replayId: "replay", eventId: "event_3", stream: sent.stream, sequence: 3, cursor: "cursor_3",
          type: "messageAdded", schema: message.identity, data: { id: "3", text: "hello" }
        });
        this.#message({ kind: "stream.replay.complete", subscriptionId: "sub", replayId: "replay", stream: sent.stream, through: "cursor_3" });
      }
    });
  }
  close(code = 1000, reason = "closed"): void { this.#emit("close", { code, reason }); }
  #message(value: Record<string, unknown>): void {
    this.#emit("message", { data: JSON.stringify({ protocol: "1.0", messageId: crypto.randomUUID(), sentAt: new Date().toISOString(), ...value }) });
  }
  #emit(type: string, value: unknown): void { for (const listener of this.#listeners.get(type) ?? []) listener(value); }
}

describe("stateStream", () => {
  it("keeps sequence out of domain state and declares deterministic framework materialization", () => {
    expect(contract.manifest.streams.room).toMatchObject({
      materialization: "state_reducer_v1",
      stateSchema: state.identity,
      events: { messageAdded: { schema: message.identity } }
    });
    expect(contract.manifest.streams.room!.snapshotSchema).toMatch(/^better-realtime\.state-snapshot\.[a-f0-9]{64}@1$/u);
    expect(contract.manifest.streams.room!.snapshot).toMatchObject({
      type: "object",
      required: ["includedSequence", "state"]
    });
    expect(contract.validateStreamSnapshot("room", { messages: [] })).toEqual({ messages: [] });
  });

  it("does not change the legacy stream manifest shape", () => {
    const legacy = defineRealtimeContract({
      contractId: "test.legacy",
      manifestVersion: "1.0.0",
      streams: {
        room: stream({
          input,
          snapshot: jsonSchema("test.legacy.state@1", {
            type: "object",
            required: ["messages", "sequence"],
            properties: { messages: { type: "array", items: message.schema }, sequence: { type: "integer", minimum: 0 } },
            additionalProperties: false
          }),
          events: { messageAdded: message },
          key: ({ roomId }) => `room:${roomId}`,
          initial: () => ({ messages: [], sequence: 0 }),
          applyEvent: (current, event) => ({ messages: [...current.messages, event.data], sequence: event.sequence }),
          snapshotSequence: (current) => current.sequence
        })
      },
      commands: {}
    });
    expect(Object.keys(legacy.manifest.streams.room!).sort()).toEqual([
      "events", "input", "inputSchema", "materialization", "ordering", "snapshot", "snapshotSchema"
    ]);
    expect(legacy.manifest.streams.room!.materialization).toBe("state");
  });

  it("unwraps authoritative sequence metadata and applies typed reducers", async () => {
    StateStreamSocket.invalidEnvelope = false;
    const client = createRealtimeClient(contract, {
      url: "ws://fixture.invalid",
      auth: () => ({}),
      webSocket: StateStreamSocket as unknown as WebSocketConstructor
    });
    const handle = client.stream("room", { roomId: "42" });
    const release = handle.subscribe(() => undefined);
    await eventually(() => handle.getSnapshot().status === "live");
    expect(handle.getSnapshot()).toMatchObject({
      data: { messages: [{ id: "3", text: "hello" }] },
      sequence: 3,
      cursor: "cursor_3"
    });
    expectTypeOf(handle.getSnapshot().data).toEqualTypeOf<DeepReadonly<{ messages: { id: string; text: string }[] }>>();
    release();
    await client.dispose();
  });

  it("fails closed when framework snapshot metadata is invalid", async () => {
    StateStreamSocket.invalidEnvelope = true;
    const client = createRealtimeClient(contract, {
      url: "ws://fixture.invalid",
      auth: () => ({}),
      webSocket: StateStreamSocket as unknown as WebSocketConstructor
    });
    const handle = client.stream("room", { roomId: "42" });
    const release = handle.subscribe(() => undefined);
    await eventually(() => handle.getSnapshot().status === "failed");
    expect(handle.getSnapshot().error).toBe("RT_STREAM_SNAPSHOT_MATERIALIZATION_FAILED");
    release();
    await client.dispose();
    StateStreamSocket.invalidEnvelope = false;
  });

  it("preserves contract inference for clients", () => {
    const client = null as unknown as RealtimeClient<typeof contract>;
    if (client) {
      expectTypeOf(client.stream("room", { roomId: "42" }).getSnapshot().data.messages[0]!.text).toEqualTypeOf<string>();
      // @ts-expect-error stateStream input remains contract inferred
      client.stream("room", { id: "42" });
    }
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
