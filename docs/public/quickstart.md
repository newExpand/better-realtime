# Quickstart

This source tree is the release candidate for Better Realtime `0.2.0-alpha.1`. The version is not available from npm until the approval-gated release completes. Until then, use the exact candidate tarballs produced by `pnpm package:pack` and `pnpm package:pack:mcp`; an npm `E404` is expected and does not reserve either package name.

Install only the profile the process runs:

```sh
# Browser/React application
npm install better-realtime@0.2.0-alpha.1 react

# Node/PostgreSQL gateway
npm install better-realtime@0.2.0-alpha.1 pg ws

# Local read-only stdio analyzer
npm install better-realtime-mcp@0.2.0-alpha.1
```

The browser-capable base package has no package-wide Node engine constraint. The Node-only companion requires Node.js 22 or newer, and a Node gateway must run on Node.js 22 or newer. `pg`, `ws`, and React are optional peers of the base package so a browser-only install does not receive server or MCP dependencies.

Define one shared contract with explicit Draft 2020-12 payload identities. `stateStream()` keeps transport sequence metadata outside domain state and infers the event payload at its reducer:

```ts
import { command, defineRealtimeContract, jsonSchema, stateStream } from "better-realtime"

const notification = jsonSchema("example.notification@1", {
  type: "object", additionalProperties: false, required: ["id", "title", "read"],
  properties: { id: { type: "string" }, title: { type: "string" }, read: { type: "boolean" } },
})
const inboxInput = jsonSchema("example.inbox.input@1", {
  type: "object", additionalProperties: false, required: ["userId"],
  properties: { userId: { type: "string" } },
})
const inboxState = jsonSchema("example.inbox.state@2", {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: notification.schema } },
})
const markReadInput = jsonSchema("example.mark-read.input@1", {
  type: "object", additionalProperties: false, required: ["userId", "notificationId"],
  properties: { userId: { type: "string" }, notificationId: { type: "string" } },
})
const markReadResult = jsonSchema("example.mark-read.result@1", {
  type: "object", additionalProperties: false, required: ["changed"],
  properties: { changed: { type: "boolean" } },
})

export const contract = defineRealtimeContract({
  contractId: "example.notifications",
  manifestVersion: "2.0.0",
  streams: {
    inbox: stateStream({
      input: inboxInput,
      state: inboxState,
      key: ({ userId }) => `inbox:${userId}`,
      initial: () => ({ items: [] }),
      events: {
        notificationAdded: {
          data: notification,
          reduce: (state, item) => ({ items: [...state.items, item] }),
        },
        notificationRead: {
          data: notification,
          reduce: (state, changed) => ({
            items: state.items.map((item) => item.id === changed.id ? changed : item),
          }),
        },
      },
    }),
  },
  commands: {
    markRead: command({ input: markReadInput, result: markReadResult }),
  },
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
// Streams and commands connect on demand. Use client.connect() only for
// deliberate warm-up/readiness.
```

Components acquire logical subscriptions and command-scoped activity:

```tsx
function NotificationAction({ userId }: { userId: string }) {
  const unread = realtime.useStream("inbox", { userId }, {
    select: (snapshot) => snapshot.data.items.filter((item) => !item.read).length,
  })
  const markRead = realtime.useCommand("markRead", { pendingUntil: "observed" })
  return (
    <button
      disabled={markRead.isPending}
      onClick={() => void markRead.executeAsync({ userId, notificationId: "notification-7" })}
    >
      Mark read ({unread} unread)
    </button>
  )
}
```

`completed` means the durable command result exists; `observed` additionally means this client has applied all causal events. Every `execute()` remains a distinct user intent and receives a distinct stable command identity.

Run storage v2 migration with the migration role before starting any `0.2` gateway. Do not roll `0.2` runtime instances against storage v1 or run alpha.4 and `0.2` gateways against one namespace. Continue with the [server](server.md), [PostgreSQL](postgres.md), and [0.2 migration](migration-0.2.md) guides.

`pnpm migration:verify` installs the exact published alpha.4 fixture and both exact candidate tarballs in isolated consumers, then typechecks, builds, and runs the before/after application surfaces. `pnpm compatibility:matrix` independently verifies wire-v1 compatible combinations and explicit exact-contract rejection.

This candidate does not support an existing HTTP/Fastify/Nest attach mode, React Native, Socket.IO, Go, a durable hosted evidence backend, or production remote MCP. `better-realtime-mcp` is a local read-only stdio analyzer over an explicitly selected evidence file. TanStack Query interoperability is future, optional, demand-gated work—not a feature or required next step of this release.
