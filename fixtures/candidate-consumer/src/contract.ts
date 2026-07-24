import { command, defineRealtimeContract, jsonSchema, stateStream } from "better-realtime";

const roomInput = jsonSchema("consumer.room.input@1", {
  type: "object", additionalProperties: false, required: ["roomId"],
  properties: { roomId: { type: "string", minLength: 1 } }
});
const message = jsonSchema("consumer.message@1", {
  type: "object", additionalProperties: false, required: ["id", "text"],
  properties: { id: { type: "string" }, text: { type: "string", minLength: 1 } }
});
const roomState = jsonSchema("consumer.room.state@1", {
  type: "object", additionalProperties: false, required: ["messages"],
  properties: { messages: { type: "array", items: message.schema } }
});
const inboxInput = jsonSchema("consumer.inbox.input@1", {
  type: "object", additionalProperties: false, required: ["userId"],
  properties: { userId: { type: "string", minLength: 1 } }
});
const notification = jsonSchema("consumer.notification@1", {
  type: "object", additionalProperties: false, required: ["id", "read"],
  properties: { id: { type: "string" }, read: { type: "boolean" } }
});
const inboxState = jsonSchema("consumer.inbox.state@1", {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: notification.schema } }
});
const sendInput = jsonSchema("consumer.send.input@1", {
  type: "object", additionalProperties: false, required: ["roomId", "text"],
  properties: { roomId: { type: "string" }, text: { type: "string", minLength: 1 } }
});
const markReadInput = jsonSchema("consumer.mark-read.input@1", {
  type: "object", additionalProperties: false, required: ["userId", "notificationId"],
  properties: { userId: { type: "string" }, notificationId: { type: "string" } }
});
const workflowInput = jsonSchema("consumer.workflow.input@1", {
  type: "object", additionalProperties: false, required: ["roomId", "userId", "silent"],
  properties: { roomId: { type: "string" }, userId: { type: "string" }, silent: { type: "boolean" } }
});
const result = jsonSchema("consumer.result@1", {
  type: "object", additionalProperties: false, required: ["ok"],
  properties: { ok: { type: "boolean" } }
});

export const contract = defineRealtimeContract({
  contractId: "consumer.candidate",
  manifestVersion: "1.0.0",
  streams: {
    room: stateStream({
      input: roomInput,
      state: roomState,
      key: ({ roomId }) => `room:${roomId}`,
      initial: () => ({ messages: [] }),
      events: {
        messageAdded: {
          data: message,
          reduce: (state, value) => ({ messages: [...state.messages, value] })
        }
      }
    }),
    inbox: stateStream({
      input: inboxInput,
      state: inboxState,
      key: ({ userId }) => `inbox:${userId}`,
      initial: () => ({ items: [] }),
      events: {
        notificationAdded: {
          data: notification,
          reduce: (state, value) => ({ items: [...state.items, value] })
        },
        notificationRead: {
          data: notification,
          reduce: (state, value) => ({
            items: state.items.map((item) => item.id === value.id ? value : item)
          })
        }
      }
    })
  },
  commands: {
    sendMessage: command({ input: sendInput, result }),
    markRead: command({ input: markReadInput, result }),
    runWorkflow: command({ input: workflowInput, result })
  }
});
