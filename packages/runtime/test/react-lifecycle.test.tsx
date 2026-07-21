// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { command, createRealtimeClient, defineRealtimeContract, jsonSchema, stream, type RealtimeClient, type WebSocketConstructor } from "../src/index.ts";
import { createRealtimeReact } from "../src/react.ts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const contract = defineRealtimeContract({
  contractId: "test.lifecycle",
  manifestVersion: "1.0.0",
  streams: { room: stream({ input: jsonSchema("test.react.room.input@1", { type: "object", required: ["roomId"], properties: { roomId: { type: "string", minLength: 1 } }, additionalProperties: false }), snapshot: jsonSchema("test.react.room.snapshot@1", { type: "object", required: ["sequence"], properties: { sequence: { type: "integer", minimum: 0 } }, additionalProperties: false }), events: {}, key: ({ roomId }) => `room:${roomId}`, initial: () => ({ sequence: 0 }), applyEvent: (state) => state, snapshotSequence: (state) => state.sequence }) },
  commands: { noop: command({ input: jsonSchema("test.react.noop.input@1", { type: "null" }), result: jsonSchema("test.react.noop.result@1", { type: "null" }) }) }
});

class LifecycleWebSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  static constructed = 0; static subscribeMessages = 0; static unsubscribeMessages = 0;
  readonly bufferedAmount = 0; readyState = LifecycleWebSocket.CONNECTING;
  readonly #listeners = new Map<string, Set<(...args: any[]) => void>>();
  constructor() { LifecycleWebSocket.constructed += 1; queueMicrotask(() => { this.readyState = LifecycleWebSocket.OPEN; this.#emit("open", {}); }); }
  addEventListener(type: string, listener: (...args: any[]) => void): void { const set = this.#listeners.get(type) ?? new Set(); set.add(listener); this.#listeners.set(type, set); }
  removeEventListener(type: string, listener: (...args: any[]) => void): void { this.#listeners.get(type)?.delete(listener); }
  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.kind === "session.open") queueMicrotask(() => this.#message({ kind: "session.ready", sessionId: "session", sessionGeneration: 1, authGeneration: 1, resumeStatus: "fresh", capabilities: { schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true, durableReplay: true, replayRetentionMs: 60_000, snapshotResync: "fenced", idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 30_000, idempotencyRetentionMs: 60_000, maxMessageBytes: 1_048_576, maxRecoveryBufferRecords: 100, maxRecoveryBufferBytes: 1_048_576 }, heartbeat: { mode: "application", intervalMs: 60_000, timeoutMs: 60_000 } }));
    if (message.kind === "stream.subscribe") { LifecycleWebSocket.subscribeMessages += 1; queueMicrotask(() => { this.#message({ kind: "stream.subscribed", requestId: message.requestId, subscriptionId: "sub", stream: message.stream, mode: "snapshot", baseline: null, head: "cursor_0" }); this.#message({ kind: "stream.resync.required", subscriptionId: "sub", resyncId: "resync", stream: message.stream, reason: "client_requested" }); this.#message({ kind: "stream.snapshot", subscriptionId: "sub", resyncId: "resync", snapshotId: "snapshot", stream: message.stream, cursor: "cursor_0", head: "cursor_0", schema: "test.react.room.snapshot@1", state: { sequence: 0 } }); this.#message({ kind: "stream.replay.complete", subscriptionId: "sub", replayId: "replay", stream: message.stream, through: "cursor_0" }); }); }
    if (message.kind === "stream.unsubscribe") LifecycleWebSocket.unsubscribeMessages += 1;
  }
  close(code = 1000, reason = "closed"): void { this.readyState = LifecycleWebSocket.CLOSED; this.#emit("close", { code, reason }); }
  #message(message: Record<string, unknown>): void { this.#emit("message", { data: JSON.stringify({ protocol: "1.0", messageId: crypto.randomUUID(), sentAt: new Date().toISOString(), ...message }) }); }
  #emit(type: string, event: unknown): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
}

afterEach(() => { document.body.innerHTML = ""; });

describe("contract React lifecycle", () => {
  it("coalesces Strict Mode and semantically stable rerenders and cleans the subscription", async () => {
    LifecycleWebSocket.constructed = 0; LifecycleWebSocket.subscribeMessages = 0; LifecycleWebSocket.unsubscribeMessages = 0;
    const client = createRealtimeClient(contract, { url: "ws://fixture.invalid", auth: () => ({}), webSocket: LifecycleWebSocket as unknown as WebSocketConstructor, idleReleaseMs: 5 });
    const realtime = createRealtimeReact(client);
    const element = document.createElement("div"); document.body.append(element);
    const root = createRoot(element);
    const App = ({ revision }: { revision: number }) => <span>{revision}:{realtime.useStream("room", { roomId: "42" }).status}</span>;
    await act(async () => { root.render(<StrictMode><App revision={0} /></StrictMode>); await delay(30); });
    for (let revision = 1; revision <= 20; revision += 1) await act(async () => { root.render(<StrictMode><App revision={revision} /></StrictMode>); });
    expect(LifecycleWebSocket.constructed).toBe(1);
    expect(LifecycleWebSocket.subscribeMessages).toBe(1);
    await act(async () => { root.unmount(); await delay(20); });
    expect(LifecycleWebSocket.unsubscribeMessages).toBe(1);
    await client.dispose();
  });

  it("rolls back invalid hook initialization before allocating a connection", async () => {
    LifecycleWebSocket.constructed = 0;
    const client = createRealtimeClient(contract, { url: "ws://fixture.invalid", auth: () => ({}), webSocket: LifecycleWebSocket as unknown as WebSocketConstructor });
    const realtime = createRealtimeReact(client);
    const element = document.createElement("div"); document.body.append(element);
    const root = createRoot(element);
    function Invalid() { realtime.useStream("room", { roomId: "" }); return null; }
    await expect(act(async () => root.render(<Invalid />))).rejects.toThrow("RT_CONTRACT_STREAM_INPUT_INVALID");
    expect(LifecycleWebSocket.constructed).toBe(0);
    expect(client.runtimeSnapshot().pendingCount).toBe(0);
    await client.dispose();
  });

  it("rejects cyclic hook input with a contract error before stable-key traversal", async () => {
    LifecycleWebSocket.constructed = 0;
    const client = createRealtimeClient(contract, { url: "ws://fixture.invalid", auth: () => ({}), webSocket: LifecycleWebSocket as unknown as WebSocketConstructor });
    const realtime = createRealtimeReact(client);
    const element = document.createElement("div"); document.body.append(element);
    const root = createRoot(element);
    const cyclic: Record<string, unknown> = { roomId: "42" };
    cyclic.self = cyclic;
    function Invalid() { realtime.useStream("room", cyclic as never); return null; }
    await expect(act(async () => root.render(<Invalid />))).rejects.toThrow("RT_CONTRACT_STREAM_INPUT_INVALID");
    expect(LifecycleWebSocket.constructed).toBe(0);
    await client.dispose();
  });

  it("recreates a released stream cleanly after a React remount", async () => {
    LifecycleWebSocket.constructed = 0; LifecycleWebSocket.subscribeMessages = 0; LifecycleWebSocket.unsubscribeMessages = 0;
    const client = createRealtimeClient(contract, { url: "ws://fixture.invalid", auth: () => ({}), webSocket: LifecycleWebSocket as unknown as WebSocketConstructor, idleReleaseMs: 0 });
    const realtime = createRealtimeReact(client);
    const App = () => <span>{realtime.useStream("room", { roomId: "42" }).status}</span>;
    const firstElement = document.createElement("div"); document.body.append(firstElement);
    const firstRoot = createRoot(firstElement);
    await act(async () => { firstRoot.render(<App />); await delay(20); });
    await act(async () => { firstRoot.unmount(); await delay(10); });
    expect(client.runtimeSnapshot().sessionState).toBe("ready");
    const secondElement = document.createElement("div"); document.body.append(secondElement);
    const secondRoot = createRoot(secondElement);
    await act(async () => { secondRoot.render(<App />); await delay(20); });
    expect(LifecycleWebSocket.constructed).toBe(1);
    expect(LifecycleWebSocket.subscribeMessages).toBe(2);
    await act(async () => { secondRoot.unmount(); await delay(10); });
    expect(LifecycleWebSocket.unsubscribeMessages).toBe(2);
    await client.dispose();
  });

  it("keeps the runtime external-store subscription stable across ordinary rerenders", async () => {
    let subscriptions = 0;
    let active = 0;
    const snapshot = { connectionState: "idle", sessionState: "absent", sessionGeneration: 0, pendingCount: 0 } as const;
    const fakeClient = {
      subscribeRuntime: () => { subscriptions += 1; active += 1; return () => { active -= 1; }; },
      runtimeSnapshot: () => snapshot
    } as unknown as RealtimeClient<typeof contract>;
    const realtime = createRealtimeReact(fakeClient);
    const element = document.createElement("div"); document.body.append(element);
    const root = createRoot(element);
    const App = ({ revision }: { revision: number }) => <span>{revision}:{realtime.useRuntime().connectionState}</span>;
    await act(async () => { root.render(<StrictMode><App revision={0} /></StrictMode>); });
    const afterMount = subscriptions;
    expect(active).toBe(1);
    for (let revision = 1; revision <= 20; revision += 1) await act(async () => { root.render(<StrictMode><App revision={revision} /></StrictMode>); });
    expect(subscriptions).toBe(afterMount);
    expect(active).toBe(1);
    await act(async () => root.unmount());
    expect(active).toBe(0);
  });
});

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
