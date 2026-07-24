import { describe, expect, expectTypeOf, it } from "vitest";
import {
  command,
  createRealtimeClient,
  defineRealtimeContract,
  jsonSchema,
  stream,
  type InferSchema,
  type DeepReadonly,
  type RealtimeClient,
  type WebSocketConstructor
} from "../src/index.ts";
import { createRealtimeReact } from "../src/react.ts";
import { BoundedLocalEvidenceSink, pseudonymizeIdentifier } from "../../diagnostics/src/index.ts";

const roomInput = jsonSchema("example.chat.room.input@1", {
  type: "object",
  properties: { roomId: { type: "string", minLength: 1 } },
  required: ["roomId"],
  additionalProperties: false
});

const roomMessage = jsonSchema("example.chat.message-added@1", {
  type: "object",
  properties: { author: { type: "string" }, text: { type: "string" } },
  required: ["author", "text"],
  additionalProperties: false
});

const roomState = jsonSchema("example.chat.room.snapshot@1", {
  type: "object",
  properties: {
    messages: { type: "array", items: roomMessage.schema },
    sequence: { type: "integer", minimum: 0 }
  },
  required: ["messages", "sequence"],
  additionalProperties: false
});

const sendMessageInput = jsonSchema("example.chat.send-message.input@1", {
  type: "object",
  properties: { roomId: { type: "string" }, text: { type: "string", minLength: 1 } },
  required: ["roomId", "text"],
  additionalProperties: false
});

const sendMessageResult = jsonSchema("example.chat.send-message.result@1", {
  type: "object",
  properties: { messageId: { type: "string" }, sequence: { type: "integer", minimum: 1 } },
  required: ["messageId", "sequence"],
  additionalProperties: false
});

type RoomInput = InferSchema<typeof roomInput>;
type RoomState = InferSchema<typeof roomState>;
type SendMessageInput = InferSchema<typeof sendMessageInput>;
type SendMessageResult = InferSchema<typeof sendMessageResult>;

const contract = defineRealtimeContract({
  contractId: "example.chat",
  manifestVersion: "1.0.0",
  streams: {
    room: stream({
      input: roomInput,
      snapshot: roomState,
      events: { messageAdded: roomMessage },
      key: ({ roomId }) => `room:${roomId}`,
      initial: () => ({ messages: [], sequence: 0 }),
      applyEvent: (state, event) => event.type === "messageAdded"
        ? { messages: [...state.messages, event.data], sequence: event.sequence }
        : state,
      snapshotSequence: (state) => state.sequence
    })
  },
  commands: {
    sendMessage: command({ input: sendMessageInput, result: sendMessageResult })
  }
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly bufferedAmount = 0;
  readonly readyState = FakeWebSocket.CONNECTING;
  static result: unknown = { messageId: "evt_1", sequence: 1 };
  static resultSchema = "example.chat.send-message.result@1";
  static snapshotSchema = "example.chat.room.snapshot@1";
  static sentCommandIds: string[] = [];
  static lastCommandInput: unknown;
  static lastSubscribeInput: unknown;
  readonly #listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(_url: string | URL, _protocols?: string | string[]) { queueMicrotask(() => this.#emit("open", {})); }
  addEventListener(type: string, listener: (...args: any[]) => void): void { const listeners = this.#listeners.get(type) ?? new Set(); listeners.add(listener); this.#listeners.set(type, listeners); }
  removeEventListener(type: string, listener: (...args: any[]) => void): void { this.#listeners.get(type)?.delete(listener); }
  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.kind === "session.open") queueMicrotask(() => this.#message({
      kind: "session.ready",
      sessionId: "session_test",
      sessionGeneration: 1,
      authGeneration: 1,
      resumeStatus: "fresh",
      capabilities: {
        schemaValidation: true,
        eventIdentity: true,
        ordering: "per_stream",
        gapDetection: true,
        durableReplay: true,
        replayRetentionMs: 60_000,
        snapshotResync: "fenced",
        idempotentCommands: true,
        commandReceipts: true,
        idempotencyRetentionMs: 60_000,
        commandResultRetentionMs: 30_000,
        maxMessageBytes: 1_048_576,
        maxRecoveryBufferRecords: 100,
        maxRecoveryBufferBytes: 1_048_576
      },
      heartbeat: { mode: "application", intervalMs: 60_000, timeoutMs: 60_000 }
    }));
    if (message.kind === "command") {
      FakeWebSocket.sentCommandIds.push(String(message.commandId));
      FakeWebSocket.lastCommandInput = message.input;
      queueMicrotask(() => {
        this.#message({ kind: "command.receipt", commandId: message.commandId, state: "accepted" });
        this.#message({ kind: "command.completed", commandId: message.commandId, schema: FakeWebSocket.resultSchema, result: FakeWebSocket.result, causalEventIds: [] });
      });
    }
    if (message.kind === "stream.subscribe") queueMicrotask(() => {
      FakeWebSocket.lastSubscribeInput = message.input;
      this.#message({ kind: "stream.subscribed", requestId: message.requestId, subscriptionId: "subscription_test", stream: message.stream, mode: "snapshot", baseline: null, head: "cursor_0" });
      this.#message({ kind: "stream.snapshot", subscriptionId: "subscription_test", resyncId: "resync_test", snapshotId: "snapshot_test", stream: message.stream, cursor: "cursor_0", head: "cursor_0", schema: FakeWebSocket.snapshotSchema, state: { messages: [], sequence: 0 } });
    });
  }
  close(code = 1000, reason = "closed"): void { this.#emit("close", { code, reason }); }
  #message(message: Record<string, unknown>): void { this.#emit("message", { data: JSON.stringify({ protocol: "1.0", messageId: `msg_${Math.random()}`, sentAt: new Date().toISOString(), ...message }) }); }
  #emit(type: string, event: unknown): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
}

describe("contract-first public runtime", () => {
  it("emits a deterministic Draft 2020-12 manifest and wire identity", () => {
    expect(contract.identity).toEqual({
      contractId: "example.chat",
      manifestVersion: "1.0.0",
      manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    expect(contract.manifest).toMatchObject({
      protocol: "1.0",
      schemaDialect: "https://json-schema.org/draft/2020-12/schema",
      streams: {
        room: {
          input: { $schema: "https://json-schema.org/draft/2020-12/schema" },
          snapshot: { $schema: "https://json-schema.org/draft/2020-12/schema" },
          inputSchema: "example.chat.room.input@1",
          snapshotSchema: "example.chat.room.snapshot@1",
          events: { messageAdded: { schema: "example.chat.message-added@1" } }
        }
      },
      commands: { sendMessage: { schema: "example.chat.send-message.input@1", resultSchema: "example.chat.send-message.result@1" } }
    });

    const reordered = defineRealtimeContract({
      manifestVersion: "1.0.0",
      contractId: "example.chat",
      commands: { sendMessage: command({ result: sendMessageResult, input: sendMessageInput }) },
      streams: {
        room: stream({
          snapshot: roomState,
          input: roomInput,
          events: { messageAdded: roomMessage },
          key: ({ roomId }) => `room:${roomId}`,
          initial: () => ({ messages: [], sequence: 0 }),
          applyEvent: (state, event) => ({ messages: [...state.messages, event.data], sequence: event.sequence }),
          snapshotSequence: (state) => state.sequence
        })
      }
    });
    expect(reordered.identity.manifestDigest).toBe(contract.identity.manifestDigest);
  });

  it("keeps schema identities explicit across streams and payload versions", () => {
    const createVersioned = (version: 1 | 2) => defineRealtimeContract({
      contractId: "test.versioned-events",
      manifestVersion: `${version}.0.0`,
      streams: {
        alpha: stream({
          input: jsonSchema(`test.alpha.input@${version}`, { type: "null" }),
          snapshot: jsonSchema(`test.alpha.snapshot@${version}`, { type: "null" }),
          events: { changed: jsonSchema(`test.alpha.changed@${version}`, version === 1 ? { type: "string" } : { type: "integer" }) },
          key: () => "alpha",
          initial: () => null,
          applyEvent: (state) => state,
          snapshotSequence: () => 0
        }),
        beta: stream({
          input: jsonSchema(`test.beta.input@${version}`, { type: "null" }),
          snapshot: jsonSchema(`test.beta.snapshot@${version}`, { type: "null" }),
          events: { changed: jsonSchema(`test.beta.changed@${version}`, { type: "boolean" }) },
          key: () => "beta",
          initial: () => null,
          applyEvent: (state) => state,
          snapshotSequence: () => 0
        })
      },
      commands: {}
    });
    const v1 = createVersioned(1);
    const v2 = createVersioned(2);
    expect(v1.manifest.streams.alpha!.events.changed!.schema).toBe("test.alpha.changed@1");
    expect(v1.manifest.streams.beta!.events.changed!.schema).toBe("test.beta.changed@1");
    expect(v2.identity.manifestDigest).not.toBe(v1.identity.manifestDigest);
    expect(() => v2.validateStreamEvent("alpha", { type: "changed", schema: "test.alpha.changed@1", sequence: 1, data: "durable-v1" })).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
    expect(v2.validateStreamEvent("alpha", { type: "changed", schema: "test.alpha.changed@2", sequence: 1, data: 2 })).toMatchObject({ data: 2 });

    expect(() => defineRealtimeContract({
      contractId: "test.schema-reuse",
      manifestVersion: "1.0.0",
      streams: {},
      commands: {
        first: command({ input: jsonSchema("test.reused@1", { type: "string" }), result: jsonSchema("test.first.result@1", { type: "null" }) }),
        second: command({ input: jsonSchema("test.reused@1", { type: "number" }), result: jsonSchema("test.second.result@1", { type: "null" }) })
      }
    })).toThrow("schema identity test.reused@1 is already bound to a different payload shape");
  });

  it("validates every application payload boundary with explicit contract errors", () => {
    expect(contract.validateStreamInput("room", { roomId: "42" })).toEqual({ roomId: "42" });
    expect(() => contract.validateStreamInput("room", { roomId: "" })).toThrow("RT_CONTRACT_STREAM_INPUT_INVALID");
    expect(() => contract.validateStreamInput("missing" as never, {})).toThrow("RT_CONTRACT_STREAM_UNKNOWN");

    expect(contract.validateStreamSnapshot("room", { messages: [], sequence: 2 })).toMatchObject({ sequence: 2 });
    expect(() => contract.validateStreamSnapshot("room", { messages: [], sequence: -1 })).toThrow("RT_CONTRACT_STREAM_SNAPSHOT_INVALID");
    expect(contract.validateStreamEvent("room", { type: "messageAdded", schema: "example.chat.message-added@1", sequence: 1, data: { author: "A", text: "hello" } })).toMatchObject({ type: "messageAdded", sequence: 1 });
    expect(() => contract.validateStreamEvent("room", { type: "messageAdded", schema: "example.chat.message-added@1", data: { author: "A", text: "hello" } } as never)).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
    expect(() => contract.validateStreamEvent("room", { type: "messageAdded", schema: "example.chat.message-added@1", sequence: 1, eventId: 42, data: { author: "A", text: "hello" } } as never)).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
    expect(() => contract.validateStreamEvent("room", { type: "messageAdded", schema: "example.chat.message-added@1", sequence: 1, data: { author: "A" } })).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
    expect(() => contract.validateStreamEvent("room", { type: "messageAdded", schema: "wrong@1", sequence: 1, data: { author: "A", text: "hello" } })).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
    expect(() => contract.validateStreamEvent("room", { type: "unknown", schema: "unknown@1", sequence: 1, data: {} } as never)).toThrow("RT_CONTRACT_STREAM_EVENT_UNKNOWN");

    expect(contract.validateCommandInput("sendMessage", { roomId: "42", text: "hello" })).toMatchObject({ text: "hello" });
    expect(() => contract.validateCommandInput("sendMessage", { roomId: "42", text: "" })).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
    expect(contract.validateCommandResult("sendMessage", { messageId: "evt_1", sequence: 1 })).toMatchObject({ sequence: 1 });
    expect(() => contract.validateCommandResult("sendMessage", { messageId: "evt_1", sequence: 0 })).toThrow("RT_CONTRACT_COMMAND_RESULT_INVALID");
    expect(() => contract.validateCommandInput("missing" as never, {})).toThrow("RT_CONTRACT_COMMAND_UNKNOWN");
  });

  it("requires an explicit JSON data field even under a permissive event schema", () => {
    const permissive = defineRealtimeContract({
      contractId: "test.permissive-event",
      manifestVersion: "1.0.0",
      streams: { feed: stream({ input: jsonSchema("test.permissive-event.feed.input@1", { type: "null" }), snapshot: jsonSchema("test.permissive-event.feed.snapshot@1", { type: "null" }), events: { changed: jsonSchema("test.permissive-event.changed@1", true) }, key: () => "feed", initial: () => null, applyEvent: (state) => state, snapshotSequence: () => 0 }) },
      commands: {}
    });
    expect(() => permissive.validateStreamEvent("feed", { type: "changed", schema: "test.permissive-event.changed@1", sequence: 1 } as never)).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
    expect(() => permissive.validateStreamEvent("feed", { type: "changed", schema: "test.permissive-event.changed@1", sequence: 1, data: undefined } as never)).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
    expect(permissive.validateStreamEvent("feed", { type: "changed", schema: "test.permissive-event.changed@1", sequence: 1, data: null })).toMatchObject({ data: null });
  });

  it("rejects invalid schemas while defining the contract", () => {
    expect(jsonSchema(`A@${"1".repeat(254)}`, { type: "null" }).identity).toHaveLength(256);
    expect(() => jsonSchema(`A@${"1".repeat(255)}`, { type: "null" })).toThrow("RT_CONTRACT_INVALID");
    expect(() => defineRealtimeContract({
      contractId: "invalid.schema",
      manifestVersion: "1.0.0",
      streams: {},
      commands: { broken: command({ input: jsonSchema("invalid.schema.broken.input@1", { type: "not-a-json-schema-type" }), result: jsonSchema("invalid.schema.broken.result@1", { type: "null" }) }) }
    })).toThrow("RT_CONTRACT_SCHEMA_INVALID");
  });

  it("never narrows non-JSON JavaScript values through a permissive schema", () => {
    const permissive = defineRealtimeContract({
      contractId: "test.json-domain",
      manifestVersion: "1.0.0",
      streams: {},
      commands: { run: command({ input: jsonSchema("test.json-domain.run.input@1", true), result: jsonSchema("test.json-domain.run.result@1", {}) }) }
    });
    for (const value of [undefined, () => undefined, Symbol("not-json"), 1n, Number.NaN, new Date()]) {
      expect(() => permissive.validateCommandInput("run", value)).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
      expect(() => permissive.validateCommandResult("run", value)).toThrow("RT_CONTRACT_COMMAND_RESULT_INVALID");
    }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => permissive.validateCommandInput("run", cyclic)).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
    expect(() => permissive.validateCommandInput("run", new Array(1))).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
    expect(() => permissive.validateCommandInput("run", { nested: new Array(1) })).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
    expect(permissive.validateCommandInput("run", { nested: [null, true, 1, "json"] })).toMatchObject({ nested: [null, true, 1, "json"] });
  });

  it("validates facade inputs before allocating transport or command state", () => {
    const client = createRealtimeClient(contract, {
      url: "ws://example.invalid/realtime",
      auth: () => ({}),
      webSocket: FakeWebSocket as unknown as WebSocketConstructor
    });
    expect(() => client.execute("sendMessage", { roomId: "42", text: "" })).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
    expect(() => (client as RealtimeClient<any>).execute("missing", {})).toThrow("RT_CONTRACT_COMMAND_UNKNOWN");
    expect(() => client.stream("room", { roomId: "" })).toThrow("RT_CONTRACT_STREAM_INPUT_INVALID");
    expect(client.runtimeSnapshot().pendingCount).toBe(0);
  });

  it("requires injected WebSockets to expose the event payloads used by the transport", () => {
    class InvalidWebSocket {
      readonly bufferedAmount = 0;
      readonly readyState = 0;
      send(): void {}
      close(): void {}
      addEventListener(_type: "message", _listener: (event: { payload: string }) => void): void {}
      removeEventListener(_type: "message", _listener: (event: { payload: string }) => void): void {}
    }
    if (false) {
      createRealtimeClient(contract, {
        url: "ws://example.invalid",
        auth: () => ({}),
        // @ts-expect-error message/close event payloads are part of the injected transport contract
        webSocket: InvalidWebSocket
      });
    }
    expect(true).toBe(true);
  });

  it("accepts a framework-neutral transport and rejects ambiguous transport ownership", async () => {
    const transport = {
      connect: async () => ({
        bufferedAmount: 0,
        send: () => undefined,
        close: () => undefined,
        onMessage: () => () => undefined,
        onClose: () => () => undefined
      })
    };
    const client = createRealtimeClient(contract, { transport, auth: () => ({}) });
    expect(client.identity).toEqual(contract.identity);
    await client.dispose();
    expect(() => createRealtimeClient(contract, {
      transport,
      url: "ws://ambiguous.invalid",
      auth: () => ({})
    } as never)).toThrow("RT_CONTRACT_INVALID");
  });

  it("automatically exports redacted client evidence and closes an exact producer checkpoint", async () => {
    const sink = new BoundedLocalEvidenceSink();
    const pseudonymizationKey = "client-evidence-pseudonymization-key";
    const client = createRealtimeClient(contract, {
      url: "ws://example.invalid/realtime",
      auth: () => ({}),
      webSocket: FakeWebSocket as unknown as WebSocketConstructor,
      diagnostics: {
        sink,
        tenantId: "tenant-client-secret",
        pseudonymizationKey
      }
    });
    await client.connect();
    await client.flushEvidence();
    expect(client.evidenceSnapshot()).toMatchObject({ acceptedRecords: expect.any(Number), exportFailedRecords: 0, closed: false });
    expect(client.evidenceSnapshot().acceptedRecords).toBeGreaterThan(0);
    expect(sink.records().every((entry) => entry.tenantId === pseudonymizeIdentifier("tenant-client-secret", pseudonymizationKey))).toBe(true);
    expect(JSON.stringify(sink.records())).not.toContain("tenant-client-secret");
    await client.dispose();
    expect(client.evidenceSnapshot()).toMatchObject({ exportFailedRecords: 0, closed: true });
    expect(sink.coverage.snapshot()).toMatchObject({ status: "complete", openProducerInstances: [], missingRanges: [] });
  });

  it("validates command results without replacing the stable command attempt identity", async () => {
    FakeWebSocket.sentCommandIds = [];
    FakeWebSocket.result = { messageId: "evt_valid", sequence: 1 };
    FakeWebSocket.resultSchema = "example.chat.send-message.result@1";
    const client = createRealtimeClient(contract, { url: "ws://example.invalid/realtime", auth: () => ({}), webSocket: FakeWebSocket as unknown as WebSocketConstructor });
    const ownedInput = { roomId: "42", text: "hello" };
    const attempt = client.execute("sendMessage", ownedInput);
    ownedInput.text = "mutated-after-execute";
    await expect(attempt.completed).resolves.toEqual({ messageId: "evt_valid", sequence: 1 });
    await expect(attempt.observed).resolves.toBeUndefined();
    expect(new Set(FakeWebSocket.sentCommandIds)).toEqual(new Set([attempt.commandId]));
    expect(FakeWebSocket.lastCommandInput).toEqual({ roomId: "42", text: "hello" });
    await client.dispose();

    FakeWebSocket.result = { messageId: "evt_invalid", sequence: 0 };
    const invalidClient = createRealtimeClient(contract, { url: "ws://example.invalid/realtime", auth: () => ({}), webSocket: FakeWebSocket as unknown as WebSocketConstructor });
    const invalid = invalidClient.execute("sendMessage", { roomId: "42", text: "hello" });
    await expect(invalid.completed).rejects.toThrow("RT_CONTRACT_COMMAND_RESULT_INVALID");
    await expect(invalid.observed).rejects.toThrow("RT_CONTRACT_COMMAND_RESULT_INVALID");
    expect(invalid.state).toBe("rejected");
    expect(invalidClient.runtimeSnapshot().pendingCount).toBe(0);
    await invalidClient.dispose();

    FakeWebSocket.result = { messageId: "evt_wrong_schema", sequence: 1 };
    FakeWebSocket.resultSchema = "sendMessage@1";
    const wrongSchemaClient = createRealtimeClient(contract, { url: "ws://example.invalid/realtime", auth: () => ({}), webSocket: FakeWebSocket as unknown as WebSocketConstructor });
    const wrongSchema = wrongSchemaClient.execute("sendMessage", { roomId: "42", text: "hello" });
    await expect(wrongSchema.completed).rejects.toThrow("RT_CONTRACT_COMMAND_RESULT_SCHEMA_MISMATCH");
    await expect(wrongSchema.observed).rejects.toThrow("RT_CONTRACT_COMMAND_RESULT_SCHEMA_MISMATCH");
    expect(wrongSchema.state).toBe("rejected");
    expect(wrongSchemaClient.runtimeSnapshot().pendingCount).toBe(0);
    await wrongSchemaClient.dispose();
  });

  it("publishes bounded command-scoped activity without merging user intent", async () => {
    FakeWebSocket.result = { messageId: "evt_activity", sequence: 1 };
    FakeWebSocket.resultSchema = "example.chat.send-message.result@1";
    FakeWebSocket.sentCommandIds = [];
    const client = createRealtimeClient(contract, { url: "ws://example.invalid/realtime", auth: () => ({}), webSocket: FakeWebSocket as unknown as WebSocketConstructor });
    const snapshots: ReturnType<typeof client.commandSnapshot>[] = [];
    const release = client.subscribeCommand("sendMessage", () => snapshots.push(client.commandSnapshot("sendMessage")));
    const first = client.execute("sendMessage", { roomId: "42", text: "first" });
    const second = client.execute("sendMessage", { roomId: "42", text: "second" });
    expect(first.commandId).not.toBe(second.commandId);
    expect(client.commandSnapshot("sendMessage")).toMatchObject({
      completionPendingCount: 2,
      observationPendingCount: 2,
      lastAttempt: { commandId: second.commandId, completionSettled: false, observationSettled: false },
      lastError: null
    });
    await Promise.all([first.completed, second.completed, first.observed, second.observed]);
    expect(client.commandSnapshot("sendMessage")).toMatchObject({
      completionPendingCount: 0,
      observationPendingCount: 0,
      lastAttempt: { commandId: second.commandId, state: "observed", completionSettled: true, observationSettled: true },
      lastError: null
    });
    expect(new Set(FakeWebSocket.sentCommandIds)).toEqual(new Set([first.commandId, second.commandId]));
    expect(snapshots.length).toBeGreaterThan(0);
    release();
    await client.dispose();
  });

  it("fails a stream explicitly when the snapshot schema name drifts", async () => {
    FakeWebSocket.snapshotSchema = "wrongSnapshot@1";
    const client = createRealtimeClient(contract, { url: "ws://example.invalid/realtime", auth: () => ({}), webSocket: FakeWebSocket as unknown as WebSocketConstructor });
    const handle = client.stream("room", { roomId: "42" });
    const release = handle.subscribe(() => undefined);
    const deadline = Date.now() + 1_000;
    while (handle.getSnapshot().status !== "failed" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(handle.getSnapshot()).toMatchObject({ status: "failed", error: "RT_CONTRACT_STREAM_SNAPSHOT_SCHEMA_MISMATCH" });
    release();
    await client.dispose();
    FakeWebSocket.snapshotSchema = "example.chat.room.snapshot@1";
  });

  it("owns subscription input and exposes an immutable snapshot projection", async () => {
    FakeWebSocket.lastSubscribeInput = undefined;
    const client = createRealtimeClient(contract, { url: "ws://example.invalid/realtime", auth: () => ({}), webSocket: FakeWebSocket as unknown as WebSocketConstructor });
    const input = { roomId: "42" };
    const handle = client.stream("room", input);
    input.roomId = "mutated-after-stream";
    const release = handle.subscribe(() => undefined);
    const deadline = Date.now() + 1_000;
    while (handle.getSnapshot().status !== "live" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(FakeWebSocket.lastSubscribeInput).toEqual({ roomId: "42" });
    const snapshot = handle.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.data)).toBe(true);
    expect(Object.isFrozen(snapshot.data.messages)).toBe(true);
    expect(() => (snapshot.data.messages as unknown as Array<unknown>).push({ author: "attacker", text: "mutate" })).toThrow();
    expect(handle.getSnapshot().data.messages).toEqual([]);
    release();
    await client.dispose();
  });

  it("infers stream and command inputs, state, event, and result types", () => {
    expectTypeOf(contract.validateStreamInput("room", { roomId: "42" })).toEqualTypeOf<RoomInput>();
    expectTypeOf(contract.validateStreamSnapshot("room", { messages: [], sequence: 0 })).toEqualTypeOf<RoomState>();
    expectTypeOf(contract.validateCommandResult("sendMessage", { messageId: "evt", sequence: 1 })).toEqualTypeOf<SendMessageResult>();

    const client = null as unknown as RealtimeClient<typeof contract>;
    if (client) {
      expectTypeOf(client.stream("room", { roomId: "42" }).getSnapshot().data).toEqualTypeOf<DeepReadonly<RoomState>>();
      expectTypeOf(client.execute("sendMessage", { roomId: "42", text: "hello" }).completed).toEqualTypeOf<Promise<SendMessageResult>>();
      // @ts-expect-error unknown stream names are rejected by the contract
      client.stream("notifications", {});
      // @ts-expect-error stream input is contract-inferred
      client.stream("room", { id: "42" });
      // @ts-expect-error unknown command names are rejected by the contract
      client.execute("deleteMessage", {});
      // @ts-expect-error command input is contract-inferred
      client.execute("sendMessage", { roomId: "42" });
      const realtime = createRealtimeReact(client);
      expectTypeOf(realtime.useStream("room", { roomId: "42" }).data).toEqualTypeOf<DeepReadonly<RoomState>>();
      const sendMessage = realtime.useCommand("sendMessage");
      expectTypeOf(sendMessage.execute).parameter(0).toEqualTypeOf<SendMessageInput>();
      expectTypeOf(sendMessage.execute({ roomId: "42", text: "hello" }).completed).toEqualTypeOf<Promise<SendMessageResult>>();
      // @ts-expect-error React hooks reject unknown contract members
      realtime.useCommand("deleteMessage");
      // @ts-expect-error React stream input is contract-inferred
      realtime.useStream("room", { id: "42" });
    }
  });

  it("derives TypeScript values from the runtime schema without a manual cast", () => {
    const schema = jsonSchema("test.inference.role@1", {
      type: "object",
      properties: { role: { type: "integer" } },
      required: ["role"],
      additionalProperties: false
    });
    expectTypeOf<InferSchema<typeof schema>["role"]>().toEqualTypeOf<number>();
    const acceptsSchemaValue = (_value: InferSchema<typeof schema>) => undefined;
    acceptsSchemaValue({ role: 1 });
    // @ts-expect-error the Draft 2020-12 schema declares role as an integer
    acceptsSchemaValue({ role: "administrator" });

    const closedEmpty = jsonSchema("test.inference.closed-empty@1", { type: "object", properties: {}, additionalProperties: false });
    const acceptsClosedEmpty = (_value: InferSchema<typeof closedEmpty>) => undefined;
    acceptsClosedEmpty({});
    // @ts-expect-error a closed empty object cannot be a primitive
    acceptsClosedEmpty(1);

    const openTuple = jsonSchema("test.inference.open-tuple@1", { type: "array", prefixItems: [{ type: "number" }, { type: "string" }] });
    const acceptsOpenTuple = (_value: InferSchema<typeof openTuple>) => undefined;
    acceptsOpenTuple([]);
    acceptsOpenTuple([1]);
    acceptsOpenTuple([1, "north", true]);
    // @ts-expect-error the second prefix item is a string when present
    acceptsOpenTuple([1, true]);

    const openObject = jsonSchema("test.inference.open-object@1", { type: "object", properties: {} });
    const acceptsOpenObject = (_value: InferSchema<typeof openObject>) => undefined;
    acceptsOpenObject({ arbitrary: "json" });

    const typedAdditional = jsonSchema("test.additional.run.input@1", { type: "object", properties: { fixed: { type: "string" } }, additionalProperties: { type: "integer" } });
    const acceptsTypedAdditional = (_value: InferSchema<typeof typedAdditional>) => undefined;
    acceptsTypedAdditional({ fixed: "known", count: 2 });
    // @ts-expect-error declared required fields retain their schema type
    acceptsTypedAdditional({ fixed: 2 });
    const additionalContract = defineRealtimeContract({ contractId: "test.additional", manifestVersion: "1.0.0", streams: {}, commands: { run: command({ input: typedAdditional, result: jsonSchema("test.additional.run.result@1", { type: "null" }) }) } });
    expect(additionalContract.validateCommandInput("run", { fixed: "known", count: 2 })).toMatchObject({ count: 2 });
    expect(() => additionalContract.validateCommandInput("run", { fixed: "known", count: "wrong" })).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");

    const explicitOpen = jsonSchema("test.inference.explicit-open@1", { type: "object", required: ["fixed"], properties: { fixed: { type: "string" } }, additionalProperties: true });
    const acceptsExplicitOpen = (_value: InferSchema<typeof explicitOpen>) => undefined;
    acceptsExplicitOpen({ fixed: "known", extra: true });
    // @ts-expect-error explicit additional properties do not erase declared field types
    acceptsExplicitOpen({ fixed: 2 });

    const openTupleContract = defineRealtimeContract({ contractId: "test.open-tuple", manifestVersion: "1.0.0", streams: {}, commands: { locate: command({ input: openTuple, result: jsonSchema("test.open-tuple.locate.result@1", { type: "null" }) }) } });
    expect(openTupleContract.validateCommandInput("locate", [])).toEqual([]);
    expect(openTupleContract.validateCommandInput("locate", [1])).toEqual([1]);
    expect(openTupleContract.validateCommandInput("locate", [1, "north", true])).toEqual([1, "north", true]);
    expect(() => openTupleContract.validateCommandInput("locate", [1, true])).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");

    const common = jsonSchema("test.tuple.locate.input@1", {
      type: "object",
      properties: {
        state: { const: "ready" },
        note: { type: ["string", "null"] },
        choice: { oneOf: [{ type: "integer" }, { type: "string" }] },
        position: { type: "array", prefixItems: [{ type: "number" }, { type: "string" }], items: false, minItems: 2, maxItems: 2 }
      },
      required: ["state", "note", "choice", "position"],
      additionalProperties: false
    });
    type Common = InferSchema<typeof common>;
    expectTypeOf<Common["state"]>().toEqualTypeOf<"ready">();
    expectTypeOf<Common["note"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Common["choice"]>().toEqualTypeOf<number | string>();
    expectTypeOf<Common["position"]>().toEqualTypeOf<[number, string]>();
    const tupleContract = defineRealtimeContract({
      contractId: "test.tuple",
      manifestVersion: "1.0.0",
      streams: {},
      commands: { locate: command({ input: common, result: jsonSchema("test.tuple.locate.result@1", { type: "boolean" }) }) }
    });
    expect(tupleContract.validateCommandInput("locate", { state: "ready", note: null, choice: 1, position: [1, "north"] })).toMatchObject({ position: [1, "north"] });
    expect(() => tupleContract.validateCommandInput("locate", { state: "ready", note: null, choice: 1, position: [1] })).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
    expect(() => tupleContract.validateCommandInput("locate", { state: "ready", note: null, choice: 1, position: [1, "north", true] })).toThrow("RT_CONTRACT_COMMAND_INPUT_INVALID");
  });
});
