import { NodeWebSocketTransport } from "../packages/transport-reference/src/index.ts";
import type { EventMessage, JsonValue } from "../packages/protocol/src/index.ts";
import { RealtimeClient, type StreamDefinition } from "../packages/core/src/index.ts";
import { doctor } from "../packages/diagnostics/src/index.ts";
import { ReferenceServer } from "../packages/server-node/src/index.ts";

interface RoomState { messages: JsonValue[]; sequence: number }
const room: StreamDefinition<{ roomId: string }, RoomState> = { stream: "room", key: ({ roomId }) => `room:${roomId}`, initial: () => ({ messages: [], sequence: 0 }), applyEvent: (state, event: EventMessage) => ({ messages: [...state.messages, event.data], sequence: event.sequence }), applySnapshot: (state) => state as unknown as RoomState, snapshotSequence: (state) => state.sequence };
const waitFor = async (condition: () => boolean) => { const started = Date.now(); while (!condition()) { if (Date.now() - started > 5000) throw new Error("doctor scenario timed out"); await new Promise((resolve) => setTimeout(resolve, 15)); } };

const server = new ReferenceServer({ port: 0, contract: { contractId: "doctor.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
await server.start();
const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "doctor.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({ type: "doctor" }), streams: [room as unknown as StreamDefinition<JsonValue, unknown>], reconnectDelaysMs: [20, 40, 80] });
const stream = client.stream<{ roomId: string }, RoomState>("room", { roomId: "42" });
const release = stream.subscribe(() => undefined);
await waitFor(() => stream.getSnapshot().status === "live");
server.stopGateway(); await waitFor(() => client.connectionState === "backing_off"); server.restartGateway();
await waitFor(() => stream.getSnapshot().status === "live" && stream.getSnapshot().sequence >= 6);
const replay = server.recorder.records().filter((record) => record.boundary === "replay.selected" && record.stream === "room:42").at(-1);
if (!replay?.traceId) throw new Error("server replay evidence did not expose a correlation trace");
const clientStats = client.recorder.stats();
const serverStats = server.recorder.stats();
console.log(JSON.stringify(doctor({
  records: [...client.recorder.records(), ...server.recorder.records()],
  expectedBoundaries: [{ producerRole: "server", boundary: "replay.selected" }, { producerRole: "server", boundary: "event.delivery_attempted" }, { producerRole: "client", boundary: "client.event_applied" }, { producerRole: "client", boundary: "replay.completed" }],
  expectedProducers: ["client", "server"],
  scope: { traceId: replay.traceId, stream: "room:42" },
  droppedRecords: clientStats.droppedRecords + serverStats.droppedRecords,
  evictedRecords: clientStats.evictedRecords + serverStats.evictedRecords,
  expectedOutcome: "subscribed application state converges through the declared recovery head"
}), null, 2));
release(); await client.dispose(); await server.dispose();
