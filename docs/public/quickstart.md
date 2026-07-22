# Quickstart

Better Realtime `0.1.0-alpha.2` supports React Web clients and Node.js servers using PostgreSQL.

```sh
npm install better-realtime@alpha react pg ws
```

Alpha releases use the npm `alpha` dist-tag. Run the command only after `0.1.0-alpha.2` appears in [npm package versions](https://www.npmjs.com/package/better-realtime?activeTab=versions); an `E404` means the approval-gated publication has not completed.

Define one shared contract with explicit Draft 2020-12 payload identities in `contract.ts`. This example is complete; every identifier used by the reducer is declared here:

```ts
import { command, defineRealtimeContract, jsonSchema, stream } from "better-realtime"

const notification = jsonSchema("example.notification@1", {
  type: "object", additionalProperties: false, required: ["id", "title", "read"],
  properties: { id: { type: "string" }, title: { type: "string" }, read: { type: "boolean" } },
})
const inboxInput = jsonSchema("example.inbox.input@1", {
  type: "object", additionalProperties: false, required: ["userId"],
  properties: { userId: { type: "string" } },
})
const inboxState = jsonSchema("example.inbox.state@1", {
  type: "object", additionalProperties: false, required: ["items", "sequence"],
  properties: { items: { type: "array", items: notification.schema }, sequence: { type: "integer", minimum: 0 } },
})
const markReadInput = jsonSchema("example.mark-read.input@1", {
  type: "object", additionalProperties: false, required: ["userId", "notificationId"],
  properties: { userId: { type: "string" }, notificationId: { type: "string" } },
})
const notificationRead = jsonSchema("example.notification-read@1", {
  type: "object", additionalProperties: false, required: ["id"],
  properties: { id: { type: "string" } },
})
const markReadResult = jsonSchema("example.mark-read.result@1", {
  type: "object", additionalProperties: false, required: ["changed"],
  properties: { changed: { type: "boolean" } },
})

export const contract = defineRealtimeContract({
  contractId: "example.notifications",
  manifestVersion: "1.0.0",
  streams: { inbox: stream({
    input: inboxInput,
    snapshot: inboxState,
    events: { notificationAdded: notification, notificationRead },
    key: ({ userId }) => `inbox:${userId}`,
    initial: () => ({ items: [], sequence: 0 }),
    applyEvent: (state, event) => event.type === "notificationAdded"
      ? { items: [...state.items, event.data], sequence: event.sequence }
      : {
          items: state.items.map((item) => item.id === event.data.id ? { ...item, read: true } : item),
          sequence: event.sequence,
        },
    snapshotSequence: (state) => state.sequence,
  }) },
  commands: { markRead: command({ input: markReadInput, result: markReadResult }) },
})
```

Create the physical client once in browser application bootstrap, not in the shared contract module, a React component, or SSR/RSC render:

```ts
import { createRealtimeClient } from "better-realtime"
import { createRealtimeReact } from "better-realtime/react"
import { contract } from "./contract.js"

const client = createRealtimeClient(contract, {
  url: "wss://app.example/ws",
  auth: () => ({ accessToken: sessionStorage.getItem("access-token") }),
})
export const realtime = createRealtimeReact(client)
await client.connect()
```

Components acquire logical subscriptions, not physical connections:

```tsx
function NotificationAction({ userId }: { userId: string }) {
  const inbox = realtime.useStream("inbox", { userId })
  const markRead = realtime.useCommand("markRead")
  const submit = async () => {
    const attempt = markRead.execute({ userId, notificationId: "notification-7" })
    await attempt.completed
    await attempt.observed
  }
  return <button onClick={submit}>Mark read ({inbox.data.items.length})</button>
}
```

Deploy the PostgreSQL migration before server startup. Continue with the [server](server.md) and [PostgreSQL](postgres.md) guides.

For a complete application with contract, migration, server handlers, React UI, two gateways, PostgreSQL 18.4, ACK-loss recovery, and CLI/MCP diagnosis, use the public [`fixtures/external-consumer`](../../fixtures/external-consumer) source. `pnpm e2e:consumer` packs `better-realtime`, installs only that tarball outside the workspace, builds the fixture, and runs the full browser journey.
