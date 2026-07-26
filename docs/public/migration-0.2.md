# 0.2 API and package migration

`0.2.0-alpha.1` is the published migration boundary for changes that could not honestly ship as an additive alpha.4-compatible patch.

## Package installation

Browser and React applications install only the base package and React:

```bash
npm install better-realtime@0.2.0-alpha.1 react
```

Node/PostgreSQL gateways install the runtime peers they execute:

```bash
npm install better-realtime@0.2.0-alpha.1 pg ws
```

The read-only stdio MCP analyzer has an independent dependency and security boundary:

```bash
npm install better-realtime-mcp@0.2.0-alpha.1
```

Replace `better-realtime/mcp` imports with `better-realtime-mcp`. The executable name stays `better-realtime-mcp`, but it is now installed by the companion package rather than the base package. The `better-realtime` CLI remains in the base package.

The browser-capable base package no longer declares a package-wide Node engine because its root and React exports run in browsers. Node gateways and `better-realtime-mcp` require Node.js 22 or newer. `react`, `pg`, and `ws` are optional base-package peers: browser consumers install React, server consumers install `pg` and `ws`, and neither profile installs the MCP dependency graph unless it selects the companion.

The companion artifact is built only when its version exactly matches the base runtime and pins `better-realtime` to that exact version. Do not override, link, or force-install a different base version under the MCP package. Such a manually skewed installation is outside the supported diagnostic boundary; install both `0.2.0-alpha.1` artifacts from the same approved public source identity.

## Contracts and React

Existing `stream()` contracts remain supported. New stateful streams may use `stateStream()` to keep protocol sequence metadata outside domain state and to colocate each event payload schema with its reducer. The framework encodes snapshots as a validated `{ state, includedSequence }` envelope and preserves the wire-v1 fenced snapshot/replay rules.

```ts
const room = stateStream({
  input: roomInput,
  state: roomState,
  key: ({ roomId }) => `room:${roomId}`,
  initial: () => ({ messages: [] }),
  events: {
    messageAdded: {
      data: message,
      reduce: (state, value) => ({
        ...state,
        messages: [...state.messages, value],
      }),
    },
  },
})
```

`useStream(name, input, { select, isEqual })` limits rerenders to the selected value. `useCommand()` exposes command-name-scoped `isPending`, `pendingCount`, `lastError`, and `lastAttempt`. The alpha.4 `totalPendingCount` command-hook field is removed; use `useRuntime().pendingCount` only in components that intentionally need runtime-wide activity. This keeps command components isolated from unrelated connection and command updates. Every `execute()` still creates a fresh stable command identity. Await `completed` for the durable command result and `observed` when this client must also have applied all causal events. `executeAsync()` inherits the hook's `pendingUntil` boundary unless one invocation supplies `{ until }`.

```tsx
function UnreadCount({ userId }: { userId: string }) {
  const unread = realtime.useStream("inbox", { userId }, {
    select: (snapshot) => snapshot.data.items.filter((item) => !item.read).length,
  })
  const markRead = realtime.useCommand("markRead", { pendingUntil: "observed" })
  return (
    <button
      disabled={markRead.isPending}
      onClick={() => void markRead.executeAsync({ userId, notificationId: "7" })}
    >
      {unread} unread
    </button>
  )
}
```

## Server commands

The alpha.4 `prepare() -> { publish, mutate }` handler remains behind a compatibility adapter. New handlers declare every possible target before the framework begins a transaction:

```ts
commands: {
  sendMessage: {
    authorize: (context, input) => context.permissions.has("message:write"),
    targets: (input) => [{ stream: "room", input: { roomId: input.roomId } }],
    async execute(context, input, tx) {
      const inserted = await tx.db.query(
        "INSERT INTO app_messages (room_id, body) VALUES ($1, $2) RETURNING id, room_id, body",
        [input.roomId, input.text]
      )
      const message = inserted.rows[0]
      tx.emit({
        stream: "room",
        input: { roomId: input.roomId },
        event: "messageAdded",
        data: message,
      })
      return message
    },
  },
}
```

The framework owns `BEGIN`/`COMMIT`, acquires target locks in deterministic order, permits zero to 100 events only for declared physical streams, and atomically commits application writes, events, command result, and outbox rows. The query facade rejects transaction control, DDL, configuration mutation, and every advisory-lock variant. Retry and indeterminate-COMMIT reconciliation preserve the canonical command intent and do not rerun an already committed effect.

Existing low-level `stream()` declarations and `prepare`/`mutate` handlers do not need an immediate source rewrite. Keep them while migrating storage and packages, then adopt `stateStream()` or `targets`/`execute` only where their new behavior is needed. Do not mechanically translate a `prepare` handler if its target set cannot be known before `BEGIN`; redesign that command boundary instead.

## PostgreSQL storage v2

Storage v2 makes the legacy command `event_id` nullable and adds the ordered `realtime_command_events` relation. The deployment migration backfills every v1 command/event link at ordinal zero. Runtime startup never performs this DDL.

Deploy in this order:

1. stop or drain all alpha.4 gateways that use the namespace;
2. back up according to the application's database policy;
3. run `migratePostgres()` once with the migration role and exact `0.2` contract;
4. verify storage version 2 and exact contract binding;
5. start only `0.2` gateways using the non-DDL runtime role.

Migration runs transactionally and may be retried after a rolled-back failure; its DDL and metadata update roll back together. A rerun after successful upgrade validates the installed v2 shape and is otherwise a no-op. A successfully upgraded namespace is not downgraded by this package; fix forward or restore the complete namespace from a tested pre-migration backup if application rollback requires storage v1. An unmigrated, partially migrated, malformed-v2, differently bound, or future-version namespace fails closed. A partial shape created outside the migration transaction is not guessed or automatically repaired: restore it or repair it explicitly under DBA control before retrying.

Alpha.4 and `0.2` gateways must not share one namespace during rolling deployment because alpha.4 does not understand the storage-v2 command causality relation and `0.2` refuses storage v1. Database owners with unrestricted DDL/DML can bypass framework invariants; production role separation must prevent that. Publishing these packages proves only that migration code is present, not that a production database was migrated.

Wire protocol `better-realtime.v1`, capability semantics, cursor format, snapshot fencing, diagnostics schema v1, and the alpha.4 low-level stream behavior remain unchanged. A peer using a new `stateStream()` contract has a distinct exact contract digest, so an alpha.4 peer rejects it explicitly instead of silently downgrading.

## Classified breaking changes

The compatibility ledger contains 14 intentionally breaking records. Several records describe different artifact layers of one user-visible migration; none implies a wire-v2 change.

| Ledger record | User impact | Required action |
|---|---|---|
| `candidate-03-packagemanifest-bin` | MCP bin leaves the base manifest | install `better-realtime-mcp` |
| `candidate-04-packagemanifest-dependencies` | Node/MCP dependencies leave the base install | install the selected profile explicitly |
| `candidate-05-packagemanifest-peerdependenciesmeta` | server peers become optional | server projects install `pg` and `ws` |
| `candidate-06-packageexports-mcp` | `better-realtime/mcp` export is removed | import `better-realtime-mcp` |
| `candidate-typescript-mcp-stdio-remove` | base MCP stdio declaration is removed | compile against the companion |
| `candidate-12-typescriptdeclarations-dist-mcp-d-ts` | base MCP declaration is removed | compile against the companion |
| `candidate-15-typescriptdeclarations-dist-react-d-ts` | `totalPendingCount` leaves command hooks | use command `pendingCount` or runtime `pendingCount` |
| `candidate-29-runtimejavascript-dist-mcp-stdio-js` | base MCP stdio runtime is removed | execute the companion bin |
| `candidate-30-runtimejavascript-dist-mcp-js` | base MCP runtime is removed | execute/import the companion |
| `candidate-33-runtimejavascript-dist-react-js` | command activity and `executeAsync` settlement become command-scoped | choose `pendingUntil`/`until` explicitly |
| `candidate-40-runtimereact-packages-runtime-src-react-ts` | runtime-wide pending alias is removed | call `useRuntime()` only for runtime-wide UI |
| `candidate-47-postgresgateway-packages-server-node-src-postgres-gateway-ts` | gateway requires storage-v2 causality | migrate before runtime startup |
| `candidate-48-postgresmigrationexecutor-packages-store-postgres-src-index-ts` | storage migration executor adds v1→v2 | run the deployment migration role |
| `candidate-typescript-api-compatibility` | the aggregate public TypeScript surface is intentionally non-assignable | follow the package, React, and storage steps above |

## Mechanical migration evidence

Run:

```bash
pnpm migration:verify
```

The verifier installs the immutable published alpha.4 tarball, compiles and runs its `stream()`, `prepare`/`mutate`, `totalPendingCount`, and base-package MCP paths, then installs both locally generated `0.2` worktree tarballs and compiles/runs the migrated low-level compatibility path, `stateStream()`, command-scoped React state, framework-owned transaction path, and MCP companion. The executable fixtures are in `fixtures/migration-consumer`; this worktree verifier tests local source rather than substituting registry contents for the code under review.

Run `pnpm compatibility:matrix` for real wire-v1 mixed-version coverage. It proves supported alpha.4/0.2 low-level combinations and verifies that a `stateStream()` exact-contract mismatch returns `RT_CONTRACT_INCOMPATIBLE` with no command or snapshot side effect.

## Unsupported and deferred

This release does not claim an existing HTTP/Fastify/Nest attach API, React Native, Socket.IO, Go, Redis/NATS/Kafka, a durable hosted evidence backend, or production remote MCP. The companion MCP process is local, read-only stdio over an explicitly selected evidence file. TanStack Query remains a future, optional, demand-gated independent track: Better Realtime would not replace its cache/mutation UI role, and this release neither implements nor requires that adapter.
