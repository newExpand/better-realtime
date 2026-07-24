# Product Definition

Status: draft

## Working description

A transport-neutral realtime correctness protocol with a framework-neutral TypeScript reference runtime that helps applications converge after disconnection, reconciles commands with observed events, and produces enough structured evidence for automated diagnosis.

The first product surface targets React developers. The runtime core and wire protocol remain framework-neutral.

The `0.1.x-alpha` public support boundary is React Web, Node.js, native browser WebSocket/Node `ws`, and the PostgreSQL reference profile. The verified recovery path is cursor replay plus stable command-status reconciliation. A protocol-defined feature is not a product claim unless the runtime implements it and the support manifest links executable verification evidence.

## Problem

Opening a WebSocket is easy. Maintaining correct application state through disconnects, retries, duplicate events, out-of-order delivery, expired cursors, multiple server nodes, authentication refresh, and deployment churn is not.

Existing tools generally provide one or more of the following:

- a transport connection;
- event emitters and rooms;
- cache updates driven by external events;
- optimistic mutations;
- infrastructure-specific fan-out;
- human-oriented logs and dashboards.

Applications are still responsible for connecting those pieces into a reliable state-convergence model and diagnosing failures across the complete path.

## Category boundary

- TanStack Query owns server-state cache lifecycle and, when selected, mutation orchestration, invalidation, and optimistic cache updates.
- TanStack DB owns local collections, live queries, and database/sync integrations.
- This runtime owns stable command identity, transport sessions, transmission and durable receipts, cursor resume, gap and ordering checks, replay, command/event causality, capability negotiation, and end-to-end diagnostic evidence.

The runtime integrates through invalidation, cache writes, direct materializer adapters, or as the transport/reconciliation function inside a TanStack mutation. It does not become a general offline-first database, mutation log, or conflict-resolution engine.

Many database synchronization and local-first products replicate database-shaped state into a client-owned local store. This runtime instead coordinates domain streams and commands across an application's existing server and state stack. A sync engine is usually the better choice when the product needs offline writes, a client-side query engine or local database, and built-in conflict resolution. This runtime is appropriate when teams want to preserve their existing server and state stack while adding explicit authorization, command causality, replay, resync, and diagnostic evidence. Readiness validation must test this positioning against representative sync-engine alternatives and real application code rather than treating the distinction as self-evident.

## Core promise

For declared capabilities, the runtime should make the following statement true:

> After a recoverable interruption, subscribed application state eventually converges with server truth, and if convergence fails the runtime provides sufficient evidence to identify the last successful boundary and the first divergent boundary.

The promise is capability-dependent. A server that cannot identify, order, or replay events cannot receive guarantees that require those features.

## Initial proof of value

The first usable delivery is a production-shaped vertical slice, not a transport-only prototype. A reference React application must continue from a forced server interruption, converge through replay or explicit resync, suppress duplicate application effects, and expose structured evidence that identifies the recovery boundaries. The demo is an executable acceptance surface for the product promise, not a separate marketing task.

## Primary users

- React teams building chat, notifications, dashboards, collaboration, operational consoles, multiplayer state, or live business workflows.
- Backend teams that need a consistent realtime contract, beginning with the TypeScript/Node reference implementation and expanding to other language SDKs only through demand gates.
- Platform teams operating multiple gateways, regions, brokers, or event stores.
- AI coding and operations tools that need structured runtime evidence rather than free-form logs.

## Product surfaces

### React

The initial direct API keeps transport and recovery mechanics out of components while exposing distinct settlement boundaries:

```ts
import { command, createRealtimeClient, defineRealtimeContract, stream } from "better-realtime"
import { createRealtimeReact } from "better-realtime/react"

const contract = defineRealtimeContract({
  contractId: "example.chat",
  manifestVersion: "1.0.0",
  streams: { room: stream({ input: roomInput, snapshot: roomState, events: { messageAdded }, key, initial, applyEvent, snapshotSequence }) },
  commands: { sendMessage: command({ input: sendMessageInput, result: sendMessageResult }) },
})
const client = createRealtimeClient(contract, { url, auth })
const realtime = createRealtimeReact(client)
const room = realtime.useStream("room", { roomId })
const sendMessage = realtime.useCommand("sendMessage")

const attempt = sendMessage.execute({ roomId, text })
await attempt.completed
await attempt.observed

room.data
room.status
sendMessage.pendingCount

// The application bootstrap—not a React component—owns terminal cleanup.
const disposeRealtime = () => client.dispose()
if (import.meta.hot) import.meta.hot.dispose(() => { void disposeRealtime() })
```

The referenced `roomInput`, `roomState`, `messageAdded`, `sendMessageInput`, and `sendMessageResult` values are created with `jsonSchema("portable-name@version", draft202012Schema)`. Those explicit identities are part of the portable manifest and are not inferred from the TypeScript property names.

React only subscribes to a framework-neutral external store. It does not own the physical connection.

The application bootstrap owns the physical client for its full lifetime and must await `client.dispose()` during an explicit shutdown or replacement. HMR disposal belongs at that same bootstrap boundary; component unmount releases logical subscriptions but intentionally does not terminate a shared physical connection.

A transport retry or status reconciliation of one returned `CommandAttempt` reuses its stable command ID. Every separate `execute` call, including two distinct clicks, creates a new command ID; the current public surface does not accept a consumer-selected idempotency key and does not guess whether two user actions are duplicates.

The following TanStack Query adapter remains a future convenience and is not exported by the alpha package:

```ts
const mutation = useMutation(
  realtime.commandMutationOptions("sendMessage", { settle: "observed" }),
)
```

Its options default to `retry: false` because canonical stable-ID command retry belongs to this runtime. TanStack Query continues to own optimistic cache updates, rollback, invalidation, and mutation UI state. A retry override requires an explicit stable-attempt policy and otherwise produces a development invariant.

### Server

```ts
const server = createRealtimeServer(contract, {
  profile: postgres({ connectionString, identityKeys }),
  runtimeId: "gateway-a",
  authenticate,
  streams: {
    room: {
      authorize,
      snapshot: async ({ db, tenantId, stream, includedSequence }) =>
        readSnapshot(db, { tenantId, stream, includedSequence }),
    },
  },
  commands: {
    sendMessage: {
      authorize,
      prepare: (_context, input) => ({
        publish: { stream: "room", input: { roomId: input.roomId }, event: "messageAdded", data: eventFrom(input) },
        mutate: async ({ db, tenantId, stream, sequence, eventId }) =>
          mutateAndReturn(db, { tenantId, stream, sequence, eventId, input }),
      }),
    },
  },
})
```

In a supported durable profile, the application mutation and event/outbox append participate in one atomic commit. A `commit` followed by best-effort `publish` is an explicitly weaker escape hatch, not the reference reliability path.

The default product surface should remain small: a contract, a client/React entry point, and a server profile. Internal ports and infrastructure adapters are advanced extension points, and changing infrastructure must not require rewriting React call sites.

### Diagnostics

```bash
better-realtime doctor --format json --source evidence.json --tenant tenant-a
better-realtime trace command cmd_119 --format json --source evidence.json --tenant tenant-a
better-realtime inspect stream room:42 --format json --source evidence.json --tenant tenant-a
better-realtime leaks --format json --source evidence.json --tenant tenant-a
```

The `better-realtime-mcp` stdio server exposes the same local, tenant-scoped, payload-redacted query service through six read-only tools. The sixth tool expands only a doctor-issued, source-bound evidence closure, so a weaker model can move from derived facts to the exact bounded records without guessing or scanning the whole bundle. A visual Devtools UI is a later consumer of that model, not the source of truth.

## Goals

- Simple outward DX despite a technically deep runtime.
- Cursor-based reconnect and missed-event recovery.
- Per-stream gap detection, ordering, and deduplication.
- Idempotent commands and command/event reconciliation.
- Snapshot fallback when replay is unavailable or expired.
- Honest capability negotiation across different servers and adapters.
- Framework-neutral TypeScript core with a first-class React binding.
- Initial reference transport selected by an evidence-backed comparison; an additional Node transport and receive-only SSE plus HTTP commands enter support only through explicit adoption and maintenance gates.
- Initial standalone and Postgres-only deployment profiles, with Redis, NATS, Kafka, and actor-based profiles retained as demand-gated architectural targets.
- Explicit ownership, bounded memory, deterministic cleanup, and leak diagnostics.
- Machine-readable causal evidence sufficient for AI-assisted diagnosis.
- Language-neutral protocol and black-box conformance suite.
- Measured client bundle, runtime CPU, memory, diagnostic storage, and event-throughput budgets with reproducible benchmark commands.

## Non-goals

- Reimplementing raw WebSocket servers in every language.
- Reimplementing databases, brokers, load balancers, or gateway frameworks.
- Replacing TanStack Query, TanStack DB, application databases, or domain reducers.
- Claiming exactly-once network delivery.
- Hiding weak server guarantees behind a stronger client API.
- Requiring Kafka, Redis, or any other external broker for initial adoption.
- Making the visual Devtools UI the primary diagnostic representation.
- Sending application payloads or secrets to an AI provider by default.
- Solving arbitrary collaborative conflict resolution or CRDT semantics in the core runtime.
- Giving an arbitrary existing server replay or idempotency guarantees through a client-only adapter.

## Capability levels

| Level | Capability | Result |
|---|---|---|
| 0 | Ephemeral connection | Reconnect and snapshot refresh only |
| 1 | Stable event identity | Duplicate detection within a declared retention window |
| 2 | Per-stream ordering/cursor | Gap detection |
| 3 | Replay after cursor | Missed-event recovery |
| 4 | Idempotent commands and receipts | Command reconciliation within declared retention limits |

Levels are cumulative onboarding shorthand, not the normative contract. Independent capabilities and their parameters are authoritative because a deployment may support non-contiguous combinations. The runtime must expose active capabilities, scope, and retention limits and must not imply unsupported behavior.

## Open-source distribution

The public project includes the protocol, runtime, supported adapters, conformance suites, and public documentation. npm package versions and public repository tags form the compatibility history; protocol and diagnostic schema versions remain independent.
