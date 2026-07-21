import { expect, it } from "vitest";
import { FlightRecorder } from "@realtime/diagnostics";
import type { JsonValue } from "@realtime/protocol";
import type { TransportConnection, TransportFactory } from "@realtime/transport-reference";
import { RealtimeClient, type StreamDefinition } from "../src/index.ts";

class NeverOpenTransport implements TransportFactory {
  connect(signal?: AbortSignal): Promise<TransportConnection> {
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  }
}
class RejectingTransport implements TransportFactory {
  connect(): Promise<TransportConnection> { return Promise.reject(new Error("unavailable")); }
}
class OpenTransport implements TransportFactory, TransportConnection {
  readonly bufferedAmount = 0;
  closeCount = 0;
  connectCount = 0;
  sentMessages: Array<Record<string, unknown>> = [];
  messageListeners = new Set<(data: string) => void>();
  closeListeners = new Set<(event: { code: number; reason: string }) => void>();
  async connect(): Promise<TransportConnection> { this.connectCount += 1; return this; }
  send(data: string): void { this.sentMessages.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.closeCount += 1; }
  onMessage(listener: (data: string) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onClose(listener: (event: { code: number; reason: string }) => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  emit(message: Record<string, unknown>): void {
    const envelope = JSON.stringify({ protocol: "1.0", messageId: `msg_${crypto.randomUUID()}`, sentAt: new Date().toISOString(), ...message });
    for (const listener of this.messageListeners) listener(envelope);
  }
  emitClose(event = { code: 1006, reason: "remote close" }): void { for (const listener of this.closeListeners) listener(event); }
}
class ThrowingReleaseTransport extends OpenTransport {
  override close(): void { super.close(); throw new Error("transport close failed"); }
  override onMessage(listener: (data: string) => void): () => void {
    const remove = super.onMessage(listener);
    return () => { remove(); throw new Error("message listener release failed"); };
  }
  override onClose(listener: (event: { code: number; reason: string }) => void): () => void {
    const remove = super.onClose(listener);
    return () => { remove(); throw new Error("close listener release failed"); };
  }
}
class CloseOnlyThrowingTransport extends OpenTransport {
  override close(): void { super.close(); throw new Error("transport close failed"); }
}
class DelayedReleaseTransport extends OpenTransport {
  override onMessage(listener: (data: string) => void): () => Promise<void> {
    const remove = super.onMessage(listener);
    return async () => { await new Promise((resolve) => setTimeout(resolve, 50)); remove(); };
  }
}
const definition: StreamDefinition<{ id: string }, { sequence: number }> = { stream: "test", key: ({ id }) => `test:${id}`, initial: () => ({ sequence: 0 }), applyEvent: (state) => state, applySnapshot: () => ({ sequence: 0 }), snapshotSequence: (state) => state.sequence };
const waitFor = async (predicate: () => boolean, timeoutMs = 500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

it("jitters reconnects within a deterministic bounded window", async () => {
  const create = (random: number) => new RealtimeClient({ transport: new RejectingTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [100], random: () => random });
  const early = create(0);
  const late = create(0.999);
  await early.connect();
  await late.connect();
  expect(early.recorder.records().find((record) => record.boundary === "reconnect.scheduled")?.details).toMatchObject({ ceiling: 100, delay: 50, jitter: "half_to_full" });
  expect(late.recorder.records().find((record) => record.boundary === "reconnect.scheduled")?.details).toMatchObject({ ceiling: 100, delay: 99, jitter: "half_to_full" });
  await early.dispose();
  await late.dispose();
});

it("retries a retryable session rejection without terminally disposing the runtime", async () => {
  const transport = new OpenTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [1], random: () => 0, sessionOpenTimeoutMs: 1_000 });
  await client.connect();
  transport.emit({ kind: "session.rejected", error: { code: "RT_OPERATION_UNAVAILABLE", scope: "session", disposition: "retry", retryable: true, retryAfterMs: 1 } });
  await waitFor(() => transport.connectCount === 2);
  expect(client.inspect()).toMatchObject({ connection: "open", session: "opening" });
  expect(client.recorder.records()).toEqual(expect.arrayContaining([
    expect.objectContaining({ boundary: "client.session_rejected_observed", reasonCode: "RT_OPERATION_UNAVAILABLE", details: expect.objectContaining({ disposition: "retry", retryable: true }) }),
    expect.objectContaining({ boundary: "reconnect.scheduled", details: expect.objectContaining({ delay: 1, retryAfterMs: 1 }) })
  ]));
  await client.dispose();
});

it("keeps exponential backoff progression until a session becomes ready", async () => {
  const transport = new OpenTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: async () => { throw new Error("auth provider unavailable"); }, streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [10, 20, 40], random: () => 0, sessionOpenTimeoutMs: 1_000 });
  await client.connect();
  await waitFor(() => client.recorder.records().filter((record) => record.boundary === "reconnect.scheduled").length >= 3);
  expect(client.recorder.records().filter((record) => record.boundary === "reconnect.scheduled").slice(0, 3).map((record) => record.details?.ceiling)).toEqual([10, 20, 40]);
  await client.dispose();
});

it("aborts pending authentication when its transport closes and reconnects", async () => {
  const transport = new OpenTransport();
  let authCalls = 0;
  const client = new RealtimeClient({
    transport,
    contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    auth: (signal) => {
      authCalls += 1;
      if (authCalls > 1) return {};
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
    },
    streams: [definition as unknown as StreamDefinition<JsonValue, unknown>],
    reconnectDelaysMs: [1],
    random: () => 0,
    sessionOpenTimeoutMs: 1_000
  });
  const firstConnect = client.connect();
  await waitFor(() => authCalls === 1);
  transport.emitClose();
  await firstConnect;
  await waitFor(() => transport.connectCount === 2 && authCalls === 2);
  expect(client.inspect()).toMatchObject({ connection: "open", session: "opening" });
  await client.dispose();
});

it("bounds a peer that upgrades but never resolves session establishment", async () => {
  const transport = new OpenTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [1_000], random: () => 0, sessionOpenTimeoutMs: 10 });
  await client.connect();
  await waitFor(() => client.recorder.records().some((record) => record.boundary === "session.initialization_timed_out"));
  await waitFor(() => client.resources.active().length === 0);
  expect(client.inspect()).toMatchObject({ connection: "backing_off", session: "absent" });
  expect(transport.closeCount).toBe(1);
  await client.dispose();
});

it("rejects an invalid session establishment deadline", () => {
  for (const sessionOpenTimeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY, 300_001, 1.5]) {
    expect(() => new RealtimeClient({ transport: new OpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], sessionOpenTimeoutMs })).toThrow("sessionOpenTimeoutMs must be an integer between 1 and 300000");
  }
});

it("rejects zero, unbounded, fractional, or decreasing reconnect schedules", () => {
  for (const reconnectDelaysMs of [[0], [Number.POSITIVE_INFINITY], [1.5], [20, 10]]) {
    expect(() => new RealtimeClient({ transport: new OpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs })).toThrow(/reconnectDelaysMs/);
  }
});

it("keeps the effective jitter delay positive at the one-millisecond boundary", async () => {
  const client = new RealtimeClient({ transport: new RejectingTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [1], random: () => 0 });
  await client.connect();
  expect(client.recorder.records().find((record) => record.boundary === "reconnect.scheduled")?.details).toMatchObject({ ceiling: 1, delay: 1 });
  await client.dispose();
});

it("uses fresh alpha sessions without resume or foreground-driven transport replacement", async () => {
  const transport = new OpenTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], sessionOpenTimeoutMs: 1_000 });
  await client.connect();
  expect(transport.sentMessages[0]).toMatchObject({ kind: "session.open" });
  expect(transport.sentMessages[0]).not.toHaveProperty("resume");
  transport.emit({
    kind: "session.ready", sessionId: "session", sessionGeneration: 1, authGeneration: 1, resumeStatus: "fresh",
    capabilities: { schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true, durableReplay: true, replayRetentionMs: 60_000, snapshotResync: "fenced", idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 30_000, idempotencyRetentionMs: 60_000, maxMessageBytes: 1_048_576, maxRecoveryBufferRecords: 100, maxRecoveryBufferBytes: 1_048_576 },
    heartbeat: { mode: "application", intervalMs: 60_000, timeoutMs: 60_000 }
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(transport.connectCount).toBe(1);
  expect(client.inspect()).toMatchObject({ connection: "open", session: "ready" });
  await client.dispose();
});

it("Strict Mode-shaped subscribe/unsubscribe churn plateaus bounded collections", async () => {
  const recorder = new FlightRecorder({ runtimeId: "churn", producerRole: "client", limits: { maxRecords: 200, maxBytes: 500_000, maxAgeMs: 60_000 } });
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], recorder, idleReleaseMs: 0 });
  for (let cycle = 0; cycle < 250; cycle += 1) {
    const handle = client.stream("test", { id: String(cycle) });
    const releaseA = handle.subscribe(() => undefined);
    releaseA();
    const releaseB = handle.subscribe(() => undefined);
    releaseB();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(client.inspect().streams).toHaveLength(0);
  expect(client.resources.active()).toHaveLength(0);
  expect(recorder.records().length).toBeLessThanOrEqual(200);
  expect(recorder.stats().bytes).toBeLessThanOrEqual(500_000);
  await client.dispose();
  expect(client.resources.active()).toHaveLength(0);
});

it("settles pending commands and clears listener state on dispose", async () => {
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>] });
  let notifications = 0;
  client.subscribeRuntime(() => { notifications += 1; });
  const attempt = client.execute("sendMessage", { roomId: "42", text: "pending" });
  const completed = expect(attempt.completed).rejects.toThrow("RT_CLIENT_DISPOSED");
  const observed = expect(attempt.observed).rejects.toThrow("RT_CLIENT_DISPOSED");
  await client.dispose();
  await completed;
  await observed;
  expect(attempt.state).toBe("cancelled");
  expect(client.inspect()).toMatchObject({ commands: [], runtimeSubscribers: 0 });
  expect(notifications).toBeGreaterThan(0);
  expect(client.resources.active()).toHaveLength(0);
});

it("finishes terminal logical cleanup when physical releases fail", async () => {
  const transport = new ThrowingReleaseTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>] });
  await client.connect();
  client.subscribeRuntime(() => undefined);
  const attempt = client.execute("sendMessage", { roomId: "42", text: "pending" });
  const firstDispose = client.dispose();
  expect(client.dispose()).toBe(firstDispose);
  await expect(firstDispose).rejects.toThrow("client cleanup failed");
  await expect(attempt.completed).rejects.toThrow("RT_CLIENT_DISPOSED");
  await expect(attempt.observed).rejects.toThrow("RT_CLIENT_DISPOSED");
  expect(client.inspect()).toMatchObject({ connection: "disposed", session: "disposed", streams: [], commands: [], runtimeSubscribers: 0 });
  expect(transport.closeCount).toBe(1);
  expect(transport.messageListeners.size).toBe(0);
  expect(transport.closeListeners.size).toBe(0);
  expect(client.resources.active()).toHaveLength(3);
  expect(client.recorder.records().filter((record) => record.boundary === "resource.release_failed")).toHaveLength(3);
  await expect(client.dispose()).rejects.toThrow("client cleanup failed");
});

it("reports a close-only physical transport failure as a failed owned resource", async () => {
  const transport = new CloseOnlyThrowingTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>] });
  await client.connect();
  await expect(client.dispose()).rejects.toThrow("client cleanup failed");
  expect(client.inspect()).toMatchObject({ connection: "disposed", session: "disposed", streams: [], commands: [], runtimeSubscribers: 0 });
  expect(client.resources.active()).toEqual([expect.objectContaining({ resourceType: "transport_connection", state: "failed" })]);
  expect(client.leaks()).toMatchObject({ verdict: "disproven", count: 1, orphaned: [expect.objectContaining({ resourceType: "transport_connection", state: "failed" })] });
  expect(client.recorder.records()).toEqual(expect.arrayContaining([expect.objectContaining({ boundary: "resource.release_failed", reasonCode: "RT_RESOURCE_RELEASE_FAILED" })]));
});

it("awaits an in-flight remote-close scope cleanup during terminal dispose", async () => {
  const transport = new DelayedReleaseTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [1_000] });
  await client.connect();
  transport.emitClose();
  let settled = false;
  const disposal = client.dispose().finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  expect(transport.messageListeners.size).toBe(1);
  await disposal;
  expect(transport.messageListeners.size).toBe(0);
  expect(transport.closeListeners.size).toBe(0);
  expect(client.resources.active()).toHaveLength(0);
  expect(client.inspect()).toMatchObject({ connection: "disposed", session: "disposed" });
});

it("does not emit an unhandled rejection when a consumer selects only completed", async () => {
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>] });
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    const attempt = client.execute("sendMessage", { roomId: "42", text: "pending" });
    const completed = expect(attempt.completed).rejects.toThrow("RT_CLIENT_DISPOSED");
    await client.dispose();
    await completed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

it("rejects an invalid command result before success state or evidence", async () => {
  const transport = new OpenTransport();
  const client = new RealtimeClient({
    transport,
    contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    auth: () => ({}),
    streams: [definition as unknown as StreamDefinition<JsonValue, unknown>],
    commands: {
      sendMessage: {
        inputSchema: "test.send.input@1",
        resultSchema: "test.send.result@1",
        validateResult: (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value) || value.sequence !== 1) throw new Error("RT_CONTRACT_COMMAND_RESULT_INVALID");
          return value;
        }
      }
    }
  });
  await client.connect();
  transport.emit({
    kind: "session.ready", sessionId: "session", sessionGeneration: 1, authGeneration: 1, resumeStatus: "fresh",
    capabilities: { schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true, durableReplay: true, replayRetentionMs: 60_000, snapshotResync: "fenced", idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 30_000, idempotencyRetentionMs: 60_000, maxMessageBytes: 1_048_576, maxRecoveryBufferRecords: 100, maxRecoveryBufferBytes: 1_048_576 },
    heartbeat: { mode: "application", intervalMs: 60_000, timeoutMs: 60_000 }
  });
  const attempt = client.execute("sendMessage", {});
  transport.emit({ kind: "command.receipt", commandId: attempt.commandId, state: "accepted" });
  transport.emit({ kind: "command.completed", commandId: attempt.commandId, schema: "test.send.result@1", result: { sequence: 0 }, causalEventIds: [] });
  await expect(attempt.completed).rejects.toThrow("RT_CONTRACT_COMMAND_RESULT_INVALID");
  await expect(attempt.observed).rejects.toThrow("RT_CONTRACT_COMMAND_RESULT_INVALID");
  expect(attempt.state).toBe("rejected");
  expect(client.pendingCount).toBe(0);
  expect(client.recorder.records()).toEqual(expect.arrayContaining([expect.objectContaining({ commandId: attempt.commandId, reasonCode: "RT_CONTRACT_COMMAND_RESULT_INVALID", outcome: "failure" })]));
  expect(client.recorder.records()).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ commandId: attempt.commandId, boundary: "client.command_completed_observed", outcome: "success" }),
    expect.objectContaining({ commandId: attempt.commandId, boundary: "command.observed", outcome: "success" })
  ]));
  await client.dispose();
});

it("fails the session explicitly when a protocol-defined auth refresh arrives in the alpha runtime", async () => {
  const transport = new OpenTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>] });
  await client.connect();
  transport.emit({
    kind: "session.ready", sessionId: "session", sessionGeneration: 1, authGeneration: 1, resumeStatus: "fresh",
    capabilities: { schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true, durableReplay: true, replayRetentionMs: 60_000, snapshotResync: "fenced", idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 30_000, idempotencyRetentionMs: 60_000, maxMessageBytes: 1_048_576 },
    heartbeat: { mode: "application", intervalMs: 60_000, timeoutMs: 60_000 }
  });
  transport.emit({ kind: "session.auth.challenge", challengeId: "challenge-1", reason: "expired", deadlineAt: new Date(Date.now() + 1_000).toISOString() });
  await new Promise((resolve) => setImmediate(resolve));
  expect(client.inspect()).toMatchObject({ connection: "disposed", session: "rejected" });
  expect(transport.closeCount).toBe(1);
  expect(client.recorder.records()).toEqual(expect.arrayContaining([expect.objectContaining({ boundary: "client.session_rejected_observed", reasonCode: "RT_AUTH_REFRESH_UNSUPPORTED" })]));
  await client.dispose();
});

it("rolls back an opened transport when session initialization fails", async () => {
  const transport = new OpenTransport();
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: async () => { throw new Error("credential provider failed"); }, streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [60_000] });
  await client.connect();
  expect(client.inspect()).toMatchObject({ connection: "backing_off", session: "suspended" });
  expect(transport.closeCount).toBe(1);
  expect(transport.messageListeners.size).toBe(0);
  expect(transport.closeListeners.size).toBe(0);
  expect(client.resources.active()).toHaveLength(0);
  expect(client.recorder.records()).toEqual(expect.arrayContaining([expect.objectContaining({ boundary: "session.initialization_failed", reasonCode: "RT_SESSION_INITIALIZATION_FAILED" })]));
  await client.dispose();
});

it("does not retain zero-consumer handles from abandoned renders and rejects wire-key collisions", async () => {
  const other: StreamDefinition<{ id: string }, { total: number }> = { stream: "other", key: () => "shared", initial: () => ({ total: 0 }), applyEvent: (state) => state, applySnapshot: () => ({ total: 0 }), snapshotSequence: () => 0 };
  const shared: StreamDefinition<{ id: string }, { sequence: number }> = { ...definition, key: () => "shared" };
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [shared as unknown as StreamDefinition<JsonValue, unknown>, other as unknown as StreamDefinition<JsonValue, unknown>] });
  for (let index = 0; index < 1_000; index += 1) client.stream("test", { id: String(index) }).getSnapshot();
  expect(client.inspect().streams).toHaveLength(0);
  const first = client.stream("test", { id: "a" });
  const second = client.stream("other", { id: "b" });
  const release = first.subscribe(() => undefined);
  expect(() => second.subscribe(() => undefined)).toThrow("RT_STREAM_KEY_COLLISION");
  release();
  await client.dispose();
});

it("recreates an idle stream entry when the same handle subscribes after idle release", async () => {
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], idleReleaseMs: 0 });
  const handle = client.stream("test", { id: "reusable" });
  const listener = () => undefined;
  const firstRelease = handle.subscribe(listener);
  firstRelease();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.inspect().streams).toHaveLength(0);
  expect(handle.getSnapshot().status).toBe("idle");
  const secondRelease = handle.subscribe(listener);
  firstRelease();
  expect(client.inspect().streams).toMatchObject([{ key: "test:reusable", status: "idle", consumers: 1 }]);
  secondRelease();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.inspect().streams).toHaveLength(0);
  await client.dispose();
});

it("owns concurrent subscriptions independently even when they share one listener function", async () => {
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], idleReleaseMs: 0 });
  const handle = client.stream("test", { id: "same-listener" });
  const listener = () => undefined;
  const releaseFirst = handle.subscribe(listener);
  const releaseSecond = handle.subscribe(listener);
  const releaseRuntimeFirst = client.subscribeRuntime(listener);
  const releaseRuntimeSecond = client.subscribeRuntime(listener);
  expect(client.inspect().streams).toMatchObject([{ consumers: 2 }]);
  expect(client.inspect().runtimeSubscribers).toBe(2);
  releaseFirst();
  releaseRuntimeFirst();
  expect(client.inspect().streams).toMatchObject([{ consumers: 1 }]);
  expect(client.inspect().runtimeSubscribers).toBe(1);
  releaseSecond();
  releaseRuntimeSecond();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.inspect().streams).toHaveLength(0);
  await client.dispose();
});

it("settles connect and rolls back transport ownership when dispose aborts pending auth", async () => {
  const transport = new OpenTransport();
  let receivedSignal: AbortSignal | undefined;
  const client = new RealtimeClient({ transport, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: async (signal) => { receivedSignal = signal; await new Promise<never>(() => undefined); return {}; }, streams: [definition as unknown as StreamDefinition<JsonValue, unknown>] });
  const connecting = client.connect();
  while (!receivedSignal) await new Promise((resolve) => setTimeout(resolve, 0));
  const firstDispose = client.dispose();
  const secondDispose = client.dispose();
  expect(secondDispose).toBe(firstDispose);
  await secondDispose;
  await expect(connecting).resolves.toBeUndefined();
  expect(receivedSignal!.aborted).toBe(true);
  expect(transport.closeCount).toBe(1);
  expect(transport.messageListeners.size).toBe(0);
  expect(transport.closeListeners.size).toBe(0);
  expect(client.resources.active()).toHaveLength(0);
});

it("fences every resource-allocating public operation after terminal dispose", async () => {
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>] });
  const staleHandle = client.stream("test", { id: "stale" });
  await client.dispose();
  expect(() => staleHandle.subscribe(() => undefined)).toThrow("RT_CLIENT_DISPOSED");
  expect(() => client.stream("test", { id: "disposed" })).toThrow("RT_CLIENT_DISPOSED");
  expect(() => client.execute("sendMessage", {})).toThrow("RT_CLIENT_DISPOSED");
  expect(() => client.subscribeRuntime(() => undefined)).toThrow("RT_CLIENT_DISPOSED");
  expect(client.inspect()).toMatchObject({ streams: [], commands: [], runtimeSubscribers: 0, connection: "disposed", session: "disposed" });
  expect(client.resources.active()).toHaveLength(0);
});

it("invalidates active subscriber tokens so a late disposer cannot resurrect a timer", async () => {
  const client = new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], idleReleaseMs: 60_000 });
  const release = client.stream("test", { id: "late-cleanup" }).subscribe(() => undefined);
  await client.dispose();
  expect(client.resources.active()).toHaveLength(0);
  release();
  expect(client.resources.active()).toHaveLength(0);
  expect(client.inspect().streams).toHaveLength(0);
});

it.each([
  { maxPendingCommands: -1 }, { maxDedupeEntries: -1 }, { maxDedupeEntries: Number.NaN }, { idleReleaseMs: -1 }, { reconnectDelaysMs: [] }, { reconnectDelaysMs: [Number.NaN] }
])("rejects invalid bounded client options: %j", (invalid) => {
  expect(() => new RealtimeClient({ transport: new NeverOpenTransport(), contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], ...invalid })).toThrow();
});
