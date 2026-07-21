import { NodeWebSocketTransport } from "../packages/transport-reference/src/index.ts";
import type { EventMessage, JsonValue } from "../packages/protocol/src/index.ts";
import { RealtimeClient, type StreamDefinition } from "../packages/core/src/index.ts";
import { ReferenceServer } from "../packages/server-node/src/index.ts";
import { FlightRecorder } from "../packages/diagnostics/src/index.ts";

interface State { messages: JsonValue[]; sequence: number }
const definition: StreamDefinition<{ roomId: string }, State> = { stream: "room", key: ({ roomId }) => `room:${roomId}`, initial: () => ({ messages: [], sequence: 0 }), applyEvent: (state, event: EventMessage) => ({ messages: [...state.messages, event.data], sequence: event.sequence }), applySnapshot: (state) => state as unknown as State, snapshotSequence: (state) => state.sequence };
const waitFor = async (condition: () => boolean) => { const started = Date.now(); while (!condition()) { if (Date.now() - started > 5000) throw new Error("plateau scenario timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } };

const server = new ReferenceServer({ port: 0, contract: { contractId: "plateau", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }); await server.start();
const recorder = new FlightRecorder({ runtimeId: "plateau-client", producerRole: "client", limits: { maxRecords: 1_000, maxBytes: 2_000_000, maxAgeMs: 60_000 } });
const client = new RealtimeClient({ transport: new NodeWebSocketTransport(server.webSocketUrl), contract: { contractId: "plateau", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: () => ({}), streams: [definition as unknown as StreamDefinition<JsonValue, unknown>], recorder, idleReleaseMs: 0 });
const initial = client.stream<{ roomId: string }, State>("room", { roomId: "42" }); const initialRelease = initial.subscribe(() => undefined); await waitFor(() => initial.getSnapshot().status === "live"); initialRelease(); await new Promise((resolve) => setTimeout(resolve, 20));

const cycles = 600;
const warmupCycles = 200;
const samples: Array<{ cycle: number; heapUsed: number; activeResources: number; streams: number; recorderRecords: number; recorderBytes: number; handles: Record<string, number> }> = [];
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const stream = client.stream<{ roomId: string }, State>("room", { roomId: "42" });
  const releaseA = stream.subscribe(() => undefined); releaseA();
  const releaseB = stream.subscribe(() => undefined); releaseB();
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (cycle >= warmupCycles && cycle % 50 === 0) {
    global.gc?.();
    const handles = process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, name) => { counts[name] = (counts[name] ?? 0) + 1; return counts; }, {});
    const recorderStats = recorder.stats();
    samples.push({ cycle, heapUsed: process.memoryUsage().heapUsed, activeResources: client.resources.active().length, streams: client.inspect().streams.length, recorderRecords: recorderStats.records, recorderBytes: recorderStats.bytes, handles });
  }
}
global.gc?.();
const first = samples[0]!; const last = samples.at(-1)!;
const heapPlateau = last.heapUsed <= Math.max(first.heapUsed * 1.15, first.heapUsed + 2_000_000);
const logicalPlateau = samples.every((sample) => sample.activeResources === first.activeResources && sample.streams === 0 && sample.recorderRecords <= recorder.limits.maxRecords && sample.recorderBytes <= recorder.limits.maxBytes);
const handleEntries = (handles: Record<string, number>) => Object.entries(handles).sort(([left], [right]) => left.localeCompare(right));
const expectedHandles = JSON.stringify(handleEntries(first.handles));
const handlePlateau = samples.every((sample) => JSON.stringify(handleEntries(sample.handles)) === expectedHandles);
const report = { schemaVersion: "1.0", cycles, warmupCycles, heapPlateau, logicalPlateau, handlePlateau, recorderEvictions: recorder.stats().evictedRecords, first, last, samples };
console.log(JSON.stringify(report, null, 2));
await client.dispose(); await server.dispose();
if (!heapPlateau || !logicalPlateau || !handlePlateau) process.exitCode = 1;
