import { command, defineRealtimeContract, jsonSchema, stateStream, stream } from "better-realtime";

const roomInput = jsonSchema("migration.room.input@1", {
  type: "object",
  additionalProperties: false,
  required: ["roomId"],
  properties: { roomId: { type: "string", minLength: 1 } }
});
const legacyState = jsonSchema("migration.legacy.state@1", {
  type: "object",
  additionalProperties: false,
  required: ["messages", "sequence"],
  properties: {
    messages: { type: "array", items: { type: "string" } },
    sequence: { type: "integer", minimum: 0 }
  }
});
const roomState = jsonSchema("migration.room.state.v2@1", {
  type: "object",
  additionalProperties: false,
  required: ["messages"],
  properties: { messages: { type: "array", items: { type: "string" } } }
});
const messageAdded = jsonSchema("migration.message-added@1", {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", minLength: 1 } }
});
const sendInput = jsonSchema("migration.send.input@1", {
  type: "object",
  additionalProperties: false,
  required: ["roomId", "text"],
  properties: {
    roomId: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 }
  }
});
const sendResult = jsonSchema("migration.send.result@1", {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } }
});

export const contract = defineRealtimeContract({
  contractId: "migration.consumer",
  manifestVersion: "2.0.0",
  streams: {
    legacyRoom: stream({
      input: roomInput,
      snapshot: legacyState,
      events: { messageAdded },
      key: ({ roomId }) => `legacy-room:${roomId}`,
      initial: () => ({ messages: [], sequence: 0 }),
      applyEvent: (state, event) => ({
        messages: [...state.messages, event.data.text],
        sequence: event.sequence
      }),
      snapshotSequence: (state) => state.sequence
    }),
    room: stateStream({
      input: roomInput,
      state: roomState,
      key: ({ roomId }) => `room:${roomId}`,
      initial: () => ({ messages: [] }),
      events: {
        messageAdded: {
          data: messageAdded,
          reduce: (state, data) => ({ messages: [...state.messages, data.text] })
        }
      }
    })
  },
  commands: {
    legacySend: command({ input: sendInput, result: sendResult }),
    sendMessage: command({ input: sendInput, result: sendResult })
  }
});
