import { RealtimeClient, type StreamDefinition } from "@realtime/core";
import { createRealtimeReact } from "@realtime/react";
import { BrowserWebSocketTransport } from "@realtime/transport-reference";
import type { EventMessage, JsonValue } from "@realtime/protocol/types";
import type { DoctorReport } from "@realtime/diagnostics";
import { buildCommandJourneyDoctor } from "./command-doctor.ts";

export interface RoomMessage { author: string; text: string; sentAt: string }
export interface RoomState { messages: RoomMessage[]; sequence: number }

const room: StreamDefinition<{ roomId: string }, RoomState> = {
  stream: "room",
  key: (input) => `room:${input.roomId}`,
  initial: () => ({ messages: [], sequence: 0 }),
  applyEvent: (state, event: EventMessage) => ({ messages: [...state.messages, event.data as unknown as RoomMessage], sequence: event.sequence }),
  applySnapshot: (state: JsonValue) => state as unknown as RoomState,
  snapshotSequence: (state) => state.sequence
};

const protocol = location.protocol === "https:" ? "wss" : "ws";
export const client = new RealtimeClient({
  transport: new BrowserWebSocketTransport(`${protocol}://${location.host}/ws`),
  contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  auth: async () => await (await fetch("/api/credential/team")).json() as JsonValue as { [key: string]: JsonValue },
  streams: [room as unknown as StreamDefinition<JsonValue, unknown>],
  reconnectDelaysMs: [120, 220, 400, 800],
  idleReleaseMs: 25,
  maxDedupeEntries: 500
});

export const realtime = createRealtimeReact(client);

export function commandJourneyDoctor(payload: unknown, commandId: string | undefined): DoctorReport | undefined {
  return buildCommandJourneyDoctor({ payload, commandId, clientRecords: client.recorder.records(), clientStats: client.recorder.stats() });
}

if (import.meta.hot) import.meta.hot.dispose(() => { void client.dispose(); });
