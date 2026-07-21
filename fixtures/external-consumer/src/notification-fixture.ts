import { command, defineRealtimeContract, jsonSchema, stream } from "better-realtime";

export const notificationContract = defineRealtimeContract({
  contractId: "fixture.notifications",
  manifestVersion: "1.0.0",
  streams: {
    feed: stream({
      input: jsonSchema("fixture.notifications.feed.input@1", { type: "object", required: ["userId"], properties: { userId: { type: "string" } }, additionalProperties: false }),
      snapshot: jsonSchema("fixture.notifications.feed.snapshot@1", { type: "object", required: ["items", "sequence"], properties: { items: { type: "array", items: { type: "object", required: ["id", "title", "read"], properties: { id: { type: "string" }, title: { type: "string" }, read: { type: "boolean" } }, additionalProperties: false } }, sequence: { type: "integer" } }, additionalProperties: false }),
      events: {
        notificationAdded: jsonSchema("fixture.notifications.notification-added@1", { type: "object", required: ["id", "title", "read"], properties: { id: { type: "string" }, title: { type: "string" }, read: { type: "boolean" } }, additionalProperties: false }),
        notificationRead: jsonSchema("fixture.notifications.notification-read@1", { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false })
      },
      key: ({ userId }) => `notifications:${userId}`,
      initial: () => ({ items: [], sequence: 0 }),
      applyEvent: (state, event) => event.type === "notificationAdded"
        ? { items: [...state.items, event.data], sequence: event.sequence }
        : { items: state.items.map((item) => item.id === event.data.id ? { ...item, read: true } : item), sequence: event.sequence },
      snapshotSequence: (state) => state.sequence
    })
  },
  commands: { markRead: command({ input: jsonSchema("fixture.notifications.mark-read.input@1", { type: "object", required: ["id"], properties: { id: { type: "string" } } }), result: jsonSchema("fixture.notifications.mark-read.result@1", { type: "object", required: ["changed"], properties: { changed: { type: "boolean" } } }) }) }
});
