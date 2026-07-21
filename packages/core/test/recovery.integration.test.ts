import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeWebSocketTransport } from "@realtime/transport-reference";
import { ReferenceServer } from "../../server-node/src/index.ts";
import type { EventMessage, JsonValue } from "@realtime/protocol";
import { RealtimeClient, type StreamDefinition, type StreamSnapshot } from "../src/index.ts";

interface RoomMessage { author: string; text: string; sentAt: string }
interface RoomState { messages: RoomMessage[]; sequence: number }

const room: StreamDefinition<{ roomId: string }, RoomState> = {
  stream: "room",
  key: ({ roomId }) => `room:${roomId}`,
  initial: () => ({ messages: [], sequence: 0 }),
  applyEvent: (state, event: EventMessage) => ({ messages: [...state.messages, event.data as unknown as RoomMessage], sequence: event.sequence }),
  applySnapshot: (state) => state as unknown as RoomState,
  snapshotSequence: (state) => state.sequence
};

const waitFor = async (condition: () => boolean, timeout = 5000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

describe("production-shaped recovery journey", () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, heartbeat: { intervalMs: 1_000, timeoutMs: 1_000 } });
  let client: RealtimeClient;
  let handle: { key: string; subscribe(listener: () => void): () => void; getSnapshot(): StreamSnapshot<RoomState> };
  let unsubscribe: () => void;

  beforeAll(async () => {
    await server.start();
    client = new RealtimeClient({
      transport: new NodeWebSocketTransport(server.webSocketUrl),
      contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      auth: () => ({ type: "test" }),
      streams: [room as unknown as StreamDefinition<JsonValue, unknown>],
      reconnectDelaysMs: [20, 40, 80], idleReleaseMs: 0
    });
    handle = client.stream<{ roomId: string }, RoomState>("room", { roomId: "42" });
    unsubscribe = handle.subscribe(() => undefined);
    await waitFor(() => handle.getSnapshot().status === "live");
  });
  afterAll(async () => { unsubscribe(); await client.dispose(); await server.dispose(); });

  it("loads an atomically fenced initial snapshot and echoes the negotiated application heartbeat", async () => {
    expect(handle.getSnapshot()).toMatchObject({ status: "live", sequence: 3 });
    expect(handle.getSnapshot().data.messages).toHaveLength(3);
    expect(client.recorder.records().some((record) => record.boundary === "snapshot.applied")).toBe(true);
    await waitFor(() => server.recorder.records().some((record) => record.boundary === "heartbeat.pong_received"), 3_000);
  });

  it("reconnects, replays, buffers interleaved live delivery, and converges", async () => {
    server.stopGateway();
    await waitFor(() => client.connectionState === "backing_off");
    server.restartGateway();
    await waitFor(() => handle.getSnapshot().status === "live" && handle.getSnapshot().sequence === 6);
    expect(handle.getSnapshot().data.messages.at(-1)?.text).toContain("replay fence");
    expect(client.recorder.records().some((record) => record.boundary === "client.replay_begin_observed")).toBe(true);
    expect(client.recorder.records().some((record) => record.boundary === "replay.completed" && record.outcome === "success")).toBe(true);
    const replay = server.recorder.records().filter((record) => record.boundary === "replay.selected" && record.stream === "room:42").at(-1)!;
    expect(client.doctor({ producerRecords: server.recorder.records(), producerStats: server.recorder.stats(), scope: { traceId: replay.traceId!, stream: "room:42" } }).verdict).toBe("proven");
  });

  it("deduplicates the same event identity across delivery attempts", async () => {
    const before = handle.getSnapshot().data.messages.length;
    server.injectDuplicate();
    await waitFor(() => client.recorder.records().some((record) => record.boundary === "event.duplicate_detected"));
    expect(handle.getSnapshot().data.messages).toHaveLength(before);
  });

  it("rejects malformed command input without appending a domain event", async () => {
    const before = server.store.head("room:42")?.sequence;
    const attempt = client.execute("sendMessage", { roomId: "42", text: "" });
    await expect(attempt.completed).rejects.toThrow("RT_COMMAND_REJECTED");
    await expect(attempt.observed).rejects.toThrow("RT_COMMAND_REJECTED");
    expect(server.store.head("room:42")?.sequence).toBe(before);
    expect(client.inspect().commands).toHaveLength(0);
  });

  it("reconciles a stable command after ACK loss and applies one domain effect", async () => {
    server.loseNextAck();
    const attempt = client.execute<{ messageId: string; sequence: number }>("sendMessage", { roomId: "42", text: "ACK loss still converges." });
    await expect(attempt.completed).resolves.toMatchObject({ sequence: 7 });
    await expect(attempt.observed).resolves.toBeUndefined();
    expect(attempt.state).toBe("observed");
    expect(handle.getSnapshot().data.messages.filter((message) => message.text === "ACK loss still converges.")).toHaveLength(1);
    const attempts = client.recorder.records().filter((record) => record.commandId === attempt.commandId && record.boundary === "command.sent");
    expect(new Set(attempts.map((record) => record.commandId))).toEqual(new Set([attempt.commandId]));
    expect(client.recorder.records().some((record) => record.commandId === attempt.commandId && record.boundary === "client.command_status_observed")).toBe(true);
    expect(client.inspect().commands).toHaveLength(0);
  });

  it("does not treat another principal's same command ID event as this command's causal observation", async () => {
    server.injectForeignCommandCollisionNextCommand();
    const attempt = client.execute<{ messageId: string; sequence: number }>("sendMessage", { roomId: "42", text: "Only the server-confirmed causal event observes this command." });
    const result = await attempt.completed;
    await attempt.observed;
    const serverCompletion = server.recorder.records().filter((record) => record.boundary === "command.completed" && record.commandId === attempt.commandId).at(-1);
    const clientObservation = client.recorder.records().filter((record) => record.boundary === "command.observed" && record.commandId === attempt.commandId).at(-1);
    expect(serverCompletion?.eventId).toBe(result.messageId);
    expect(clientObservation?.eventId).toBe(result.messageId);
    expect(handle.getSnapshot().data.messages.filter((message) => message.text === "same tenant and command ID, different principal")).toHaveLength(1);
  });

  it("uses a fenced snapshot when the opaque cursor has expired", async () => {
    const priorSnapshots = client.recorder.records().filter((record) => record.boundary === "snapshot.applied").length;
    server.expireCursor(); server.stopGateway(); await waitFor(() => client.connectionState === "backing_off"); server.restartGateway();
    await waitFor(() => client.recorder.records().filter((record) => record.boundary === "snapshot.applied").length > priorSnapshots);
    await waitFor(() => handle.getSnapshot().status === "live");
    expect(handle.getSnapshot().sequence).toBe(server.store.head("room:42")?.sequence);
    expect(client.recorder.records().filter((record) => record.boundary === "snapshot.applied").at(-1)?.details).toMatchObject({ cursor: server.store.head("room:42")?.cursor });
  });

  it("actively requests replay after a live gap and converges", async () => {
    const before = handle.getSnapshot().sequence;
    server.injectGap();
    await waitFor(() => handle.getSnapshot().status === "live" && handle.getSnapshot().sequence === before + 2);
    expect(client.recorder.records().some((record) => record.boundary === "stream.gap_detected" && record.details?.expected === before + 1)).toBe(true);
    expect(client.recorder.records().some((record) => record.boundary === "recovery.selected" && record.details?.reason === "gap_replay")).toBe(true);
  });
});

it("settles causal observation when ACK loss recovery absorbs the command event into an expired-cursor snapshot", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "snapshot-command", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  await server.start();
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "snapshot-command", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [room as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [200] });
  const handle = client.stream<{ roomId: string }, RoomState>("room", { roomId: "42" });
  const release = handle.subscribe(() => undefined);
  try {
    await waitFor(() => handle.getSnapshot().status === "live");
    server.loseNextAck();
    const attempt = client.execute<{ messageId: string; sequence: number }>("sendMessage", { roomId: "42", text: "ACK loss is included by the recovery snapshot." });
    await waitFor(() => client.connectionState === "backing_off");
    server.expireCursor();
    await expect(attempt.completed).resolves.toMatchObject({ sequence: 4 });
    await expect(attempt.observed).resolves.toBeUndefined();
    expect(attempt.state).toBe("observed");
    expect(client.recorder.records().some((record) => record.commandId === attempt.commandId && record.boundary === "command.causal_event_included_by_snapshot" && record.eventId)).toBe(true);
    expect(client.inspect().commands).toHaveLength(0);
  } finally { release(); await client.dispose(); await server.dispose(); }
});

it("restarts a fenced snapshot after negotiated recovery-buffer overflow", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "overflow", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, capabilities: { maxRecoveryBufferRecords: 1 } });
  await server.start();
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "overflow", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [room as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [20, 40] });
  const handle = client.stream<{ roomId: string }, RoomState>("room", { roomId: "42" });
  const release = handle.subscribe(() => undefined);
  try {
    await waitFor(() => handle.getSnapshot().status === "live");
    server.interleaveNextReplay(2);
    server.stopGateway(); await waitFor(() => client.connectionState === "backing_off"); server.restartGateway();
    await waitFor(() => handle.getSnapshot().status === "live" && handle.getSnapshot().sequence === server.store.head("room:42")?.sequence);
    expect(client.recorder.records().some((record) => record.boundary === "buffer.overflowed" && record.reasonCode === "RT_RECOVERY_OVERFLOW")).toBe(true);
    expect(client.recorder.records().some((record) => record.boundary === "recovery.restarted" && record.details?.reason === "recovery_overflow")).toBe(true);
  } finally { release(); await client.dispose(); await server.dispose(); }
});

it("does not emit replay success for a discontinuous buffered-live release", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "buffer-gap", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  await server.start();
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "buffer-gap", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [room as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [20, 40] });
  const handle = client.stream<{ roomId: string }, RoomState>("room", { roomId: "42" });
  const release = handle.subscribe(() => undefined);
  try {
    await waitFor(() => handle.getSnapshot().status === "live");
    server.interleaveGapNextReplay();
    server.stopGateway(); await waitFor(() => client.connectionState === "backing_off"); server.restartGateway();
    await waitFor(() => client.recorder.records().some((record) => record.kind === "replay.buffer_continuity_failed"));
    const failure = client.recorder.records().find((record) => record.kind === "replay.buffer_continuity_failed")!;
    expect(client.recorder.records().some((record) => record.boundary === "replay.completed" && record.outcome === "success" && record.traceId === failure.traceId)).toBe(false);
    await waitFor(() => handle.getSnapshot().status === "live" && handle.getSnapshot().sequence === server.store.head("room:42")?.sequence);
    expect(client.recorder.records().some((record) => record.boundary === "recovery.restarted" && record.details?.reason === "buffer_continuity_failed")).toBe(true);
  } finally { release(); await client.dispose(); await server.dispose(); }
});

it("contains snapshot materializer failures as an agent-readable terminal stream error", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "broken-snapshot", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  await server.start();
  const brokenSnapshot: StreamDefinition<{ roomId: string }, RoomState> = { ...room, applySnapshot: () => { throw new TypeError("fixture snapshot rejected"); } };
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "broken-snapshot", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [brokenSnapshot as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [20] });
  const handle = client.stream<{ roomId: string }, RoomState>("room", { roomId: "42" });
  const release = handle.subscribe(() => undefined);
  try {
    await waitFor(() => handle.getSnapshot().status === "failed");
    expect(handle.getSnapshot().error).toBe("RT_STREAM_SNAPSHOT_MATERIALIZATION_FAILED");
    expect(client.recorder.records()).toEqual(expect.arrayContaining([expect.objectContaining({ boundary: "stream.materialization_failed", reasonCode: "RT_STREAM_SNAPSHOT_MATERIALIZATION_FAILED", details: expect.objectContaining({ phase: "snapshot", errorType: "TypeError" }) })]));
  } finally { release(); await client.dispose(); await server.dispose(); }
});

it("contains event reducer failures and never records a successful replay release", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "broken-event", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  await server.start();
  const brokenEvent: StreamDefinition<{ roomId: string }, RoomState> = { ...room, applyEvent: () => { throw new TypeError("fixture event rejected"); } };
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "broken-event", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [brokenEvent as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [20] });
  const handle = client.stream<{ roomId: string }, RoomState>("room", { roomId: "42" });
  const release = handle.subscribe(() => undefined);
  try {
    await waitFor(() => handle.getSnapshot().status === "live");
    const attempt = client.execute("sendMessage", { roomId: "42", text: "materializer failure" });
    void attempt.observed.catch(() => undefined);
    await attempt.completed;
    await waitFor(() => handle.getSnapshot().status === "failed");
    expect(handle.getSnapshot().error).toBe("RT_STREAM_EVENT_MATERIALIZATION_FAILED");
    const failure = client.recorder.records().find((record) => record.boundary === "stream.materialization_failed" && record.details?.phase === "event");
    expect(failure).toMatchObject({ reasonCode: "RT_STREAM_EVENT_MATERIALIZATION_FAILED", eventId: expect.any(String) });
    expect(client.recorder.records().some((record) => record.boundary === "replay.completed" && record.outcome === "success" && record.recordSequence > failure!.recordSequence)).toBe(false);
  } finally { release(); await client.dispose(); await server.dispose(); }
});
