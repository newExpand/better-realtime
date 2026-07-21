import { expect, it } from "vitest";
import { NodeWebSocketTransport } from "@realtime/transport-reference";
import type { EventMessage, JsonValue } from "@realtime/protocol";
import { ReferenceServer } from "../../server-node/src/index.ts";
import { RealtimeClient, type StreamDefinition } from "../src/index.ts";

interface State { messages: JsonValue[]; sequence: number }
const definition: StreamDefinition<{ roomId: string }, State> = { stream: "room", key: ({ roomId }) => `room:${roomId}`, initial: () => ({ messages: [], sequence: 0 }), applyEvent: (state, event: EventMessage) => ({ messages: [...state.messages, event.data], sequence: event.sequence }), applySnapshot: (state) => state as unknown as State, snapshotSequence: (state) => state.sequence };

it("fences late subscription completions across repeated stream generations", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "fence", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  await server.start();
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "fence", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], idleReleaseMs: 0 });
  try {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const stream = client.stream<{ roomId: string }, State>("room", { roomId: "42" });
      const first = stream.subscribe(() => undefined); first();
      const second = stream.subscribe(() => undefined); second();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.inspect().streams).toHaveLength(0);
    expect(client.recorder.records().filter((record) => record.outcome === "invariant_violation")).toHaveLength(0);
    expect(client.resources.active()).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "transport_connection", state: "active" }),
      expect.objectContaining({ resourceType: "transport_message_listener", state: "active" }),
      expect.objectContaining({ resourceType: "transport_close_listener", state: "active" })
    ]));
    expect(client.resources.active()).toHaveLength(3);
  } finally { await client.dispose(); await server.dispose(); }
});

it("fails queued work and suppresses reconnect after a non-retryable session rejection", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "rejected", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  await server.start();
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "rejected", manifestVersion: "1.0.0", manifestDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [10] });
  const release = client.stream("room", { roomId: "42" }).subscribe(() => undefined);
  const command = client.execute("sendMessage", { roomId: "42", text: "must not hang" });
  try {
    await expect(command.completed).rejects.toThrow("RT_CONTRACT_INCOMPATIBLE");
    await expect(command.observed).rejects.toThrow("RT_CONTRACT_INCOMPATIBLE");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.sessionState).toBe("rejected");
    expect(client.connectionState).toBe("disposed");
    expect(command.state).toBe("cancelled");
    expect(client.recorder.records().filter((record) => record.boundary === "reconnect.scheduled")).toHaveLength(0);
  } finally { release(); await client.dispose(); await server.dispose(); }
});

it("rejects an invalid negotiated capability set before session ready", async () => {
  const server = new ReferenceServer({ port: 0, contract: { contractId: "invalid-capability", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  Object.assign(server.capabilities, { idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 2_000, idempotencyRetentionMs: 1_000 });
  await server.start();
  const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "invalid-capability", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [10] });
  const release = client.stream("room", { roomId: "42" }).subscribe(() => undefined);
  const command = client.execute("sendMessage", { roomId: "42", text: "must fail with the invalid session" });
  const completedRejection = expect(command.completed).rejects.toThrow("RT_CAPABILITY_VIOLATED");
  const observedRejection = expect(command.observed).rejects.toThrow("RT_CAPABILITY_VIOLATED");
  try {
    const started = Date.now();
    while (!client.recorder.records().some((record) => record.boundary === "protocol.capability_violated")) {
      if (Date.now() - started > 2_000) throw new Error("invalid capability was not rejected");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await completedRejection;
    await observedRejection;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.sessionState).toBe("rejected");
    expect(client.connectionState).toBe("disposed");
    expect(command.state).toBe("cancelled");
    expect(client.recorder.records().some((record) => record.reasonCode === "RT_CAPABILITY_VIOLATED")).toBe(true);
    expect(client.recorder.records().filter((record) => record.boundary === "reconnect.scheduled")).toHaveLength(0);
  } finally { release(); await client.dispose(); await server.dispose(); }
});
