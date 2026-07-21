import { command, defineRealtimeContract, jsonSchema, stream } from "better-realtime";

const roomInput = jsonSchema("fixture.chat.room.input@1", { type: "object", additionalProperties: false, required: ["roomId"], properties: { roomId: { type: "string", minLength: 1 } } });
const message = jsonSchema("fixture.chat.message@1", { type: "object", additionalProperties: false, required: ["id", "author", "text", "sentAt"], properties: { id: { type: "string" }, author: { type: "string" }, text: { type: "string" }, sentAt: { type: "string" } } });
const messageAdded = jsonSchema("fixture.chat.message-added@1", { type: "object", additionalProperties: false, required: ["author", "text", "sentAt"], properties: { author: { type: "string" }, text: { type: "string" }, sentAt: { type: "string" } } });
const roomState = jsonSchema("fixture.chat.room.snapshot@1", { type: "object", additionalProperties: false, required: ["messages", "sequence"], properties: { messages: { type: "array", items: message.schema }, sequence: { type: "integer", minimum: 0 } } });
const sendInput = jsonSchema("fixture.chat.send-message.input@1", { type: "object", additionalProperties: false, required: ["roomId", "text", "sentAt"], properties: { roomId: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4000 }, sentAt: { type: "string" } } });
const sendResult = jsonSchema("fixture.chat.send-message.result@1", { type: "object", additionalProperties: false, required: ["messageId", "sequence"], properties: { messageId: { type: "string" }, sequence: { type: "integer", minimum: 1 } } });

export const contract = defineRealtimeContract({
  contractId: "fixture.chat",
  manifestVersion: "1.0.0",
  streams: {
    room: stream({
      input: roomInput,
      snapshot: roomState,
      events: { messageAdded },
      key: ({ roomId }) => `room:${roomId}`,
      initial: () => ({ messages: [], sequence: 0 }),
      applyEvent: (state, event) => ({ messages: [...state.messages, { id: event.eventId ?? `sequence:${event.sequence}`, ...event.data }], sequence: event.sequence }),
      snapshotSequence: (state) => state.sequence
    })
  },
  commands: { sendMessage: command({ input: sendInput, result: sendResult }) }
});
