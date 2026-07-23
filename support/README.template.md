# Better Realtime

[![CI](https://github.com/newExpand/better-realtime/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/newExpand/better-realtime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Contract-first realtime for React and Node. Recovery you can prove.

Build typed live streams and commands on native WebSocket without rewriting replay, deduplication, snapshot recovery, and command reconciliation for every feature. For declared capabilities, the verified PostgreSQL profile restores React state after recoverable interruptions and emits machine-readable evidence when recovery cannot be proven.

> `0.1.0-alpha.4` is an evaluation release, not a production-ready declaration. Check the [alpha support matrix](docs/public/support-matrix.md) and [stability policy](docs/public/stability.md) before production use.

[Read the quickstart](docs/public/quickstart.md) · [Run the verified journey](#run-the-verified-recovery-journey) · [Check alpha support](#alpha-support-matrix) · [Review production boundaries](docs/public/production-deployment.md)

## Choose the right layer

| Need | Use |
|---|---|
| Ordered application streams, cursor replay, command reconciliation, and causal evidence while keeping an existing React/Node/PostgreSQL stack | Better Realtime |
| Transport fallback, reconnect, rooms, and event-emitter conveniences | Socket.IO |
| Server-state cache, invalidation, optimistic UI, and mutation presentation | TanStack Query alongside Better Realtime |
| Offline writes, a client-side database/query engine, or conflict resolution | A sync engine |

Better Realtime is not a cache, local database, general synchronization engine, or exactly-once network transport.

## Install the alpha

Alpha releases use the npm `alpha` dist-tag. Run this only after `0.1.0-alpha.4` appears in [npm package versions](https://www.npmjs.com/package/better-realtime?activeTab=versions). An npm `E404` means the approval-gated publication has not completed; it does not reserve the name.

```sh
npm install better-realtime@alpha react pg ws
```

This is the full React + Node/PostgreSQL profile. The package is ESM-only and requires Node.js 22 or newer. Accepted peer ranges are React `>=18.2 <20`, `pg >=8.22 <9`, and `ws >=8.21.1 <9`; the actual alpha evidence covers React 19, Node 22.19, PostgreSQL 18.4, and Chromium. Deploy the PostgreSQL migration before runtime startup and configure an exact browser Origin allowlist.

## Contract and client example

The shared contract carries both TypeScript inference and Draft 2020-12 runtime validation:

```ts
import { command, defineRealtimeContract, jsonSchema, stream } from "better-realtime"

const roomInput = jsonSchema("example.room.input@1", {
  type: "object", additionalProperties: false, required: ["roomId"],
  properties: { roomId: { type: "string", minLength: 1 } },
})
const roomState = jsonSchema("example.room.state@1", {
  type: "object", additionalProperties: false, required: ["messages", "sequence"],
  properties: {
    messages: { type: "array", items: { type: "string" } },
    sequence: { type: "integer", minimum: 0 },
  },
})
const messageAdded = jsonSchema("example.message-added@1", {
  type: "object", additionalProperties: false, required: ["text"],
  properties: { text: { type: "string", minLength: 1 } },
})
const sendInput = jsonSchema("example.send.input@1", {
  type: "object", additionalProperties: false, required: ["roomId", "text"],
  properties: { roomId: { type: "string" }, text: { type: "string", minLength: 1 } },
})
const sendResult = jsonSchema("example.send.result@1", {
  type: "object", additionalProperties: false, required: ["sequence"],
  properties: { sequence: { type: "integer", minimum: 1 } },
})

export const contract = defineRealtimeContract({
  contractId: "example.chat",
  manifestVersion: "1.0.0",
  streams: { room: stream({
    input: roomInput,
    snapshot: roomState,
    events: { messageAdded },
    key: ({ roomId }) => `room:${roomId}`,
    initial: () => ({ messages: [], sequence: 0 }),
    applyEvent: (state, event) => ({
      messages: [...state.messages, event.data.text], sequence: event.sequence,
    }),
    snapshotSequence: (state) => state.sequence,
  }) },
  commands: { sendMessage: command({ input: sendInput, result: sendResult }) },
})
```

Browser application bootstrap—not a React component or SSR/RSC render—owns the physical client:

```tsx
import { createRealtimeClient } from "better-realtime"
import { createRealtimeReact } from "better-realtime/react"
import { contract } from "./contract.js"

const client = createRealtimeClient(contract, {
  url: "wss://app.example/realtime",
  auth: () => ({ accessToken: sessionStorage.getItem("access-token") }),
})
export const realtime = createRealtimeReact(client)
await client.connect()

function Room({ roomId }: { roomId: string }) {
  const room = realtime.useStream("room", { roomId })
  const sendMessage = realtime.useCommand("sendMessage")
  const send = async () => {
    const attempt = sendMessage.execute({ roomId, text: "Hello" })
    await attempt.completed // durable command result
    await attempt.observed  // causal stream event applied locally
  }
  return <button onClick={send}>Send ({room.data.messages.length})</button>
}
```

The Node gateway imports `createRealtimeServer` and `postgres` from `better-realtime/server` and implements the same contract. See the copy-paste [quickstart](docs/public/quickstart.md), [server handlers](docs/public/server.md), and [PostgreSQL deployment](docs/public/postgres.md).

## Why recovery is different

- after reconnect, active subscriptions request cursor replay from their last opaque cursor; this is stream recovery, not resume-token session restoration;
- replay and live delivery share a continuity fence;
- duplicate event IDs do not repeat reducer effects;
- within negotiated idempotency retention, ACK loss reconciles the same command identity instead of guessing from transport state;
- cursor expiry falls back to an atomic PostgreSQL snapshot and `(snapshot cursor, recovery head]` catch-up;
- diagnostic conclusions cite bounded, payload-redacted evidence and refuse unsupported proof outside the declared capture topology.

The protocol does not claim exactly-once network delivery. It combines bounded identities, replay, dedupe, idempotency, and explicit unknown states so application state converges honestly.

## Run the verified recovery journey

![The React recovery demo reconnects after a gateway interruption and converges to two messages after command ACK loss.](docs/public/assets/recovery-demo.gif)

The GIF shows the browser-visible transition from recovery to the converged two-message state. A successful executable journey additionally installs only the generated tarball in a workspace-external consumer, starts PostgreSQL 18.4 and two independent gateways, kills Gateway A, reconnects through Gateway B, reconciles a dropped command completion, verifies one final event effect, compares the CLI and MCP doctor result, and produces trace, screenshot, video, and payload-redacted evidence artifacts.

Prerequisites: Node.js 22+, Corepack, Docker, and Playwright Chromium.

```sh
git clone https://github.com/newExpand/better-realtime.git
cd better-realtime
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm e2e:consumer
```

The complete consumer is in [`fixtures/external-consumer`](fixtures/external-consumer).

## Diagnostics

Export a tenant-scoped evidence bundle from application-controlled server code before running the read-only tools; see the [evidence export guide](docs/public/diagnostics.md).

```sh
npm exec -- better-realtime doctor --format json --source evidence.json --tenant tenant-a
npm exec -- better-realtime trace command cmd_119 --format json --source evidence.json --tenant tenant-a
npm exec -- better-realtime inspect stream room:42 --format json --source evidence.json --tenant tenant-a
npm exec -- better-realtime leaks --format json --source evidence.json --tenant tenant-a
```

A trimmed excerpt from the schema-valid result of the verified ACK-loss journey looks like this:

```json
{
  "schemaVersion": "1.0",
  "report": {
    "verdict": "proven",
    "lastSuccessfulBoundary": {
      "status": "known",
      "value": "server:command.completed"
    },
    "firstDivergentBoundary": {
      "status": "unknown",
      "reason": "no divergent boundary captured"
    }
  },
  "completeness": {
    "status": "complete",
    "missingProducerInstances": []
  },
  "evidenceReference": { "recordCount": 2 }
}
```

Here, `complete` means complete only for the declared capture topology: one gateway server recorder and its colocated PostgreSQL store recorder. It does not imply browser, other-gateway, PostgreSQL-log, or production-global completeness.

`better-realtime-mcp` is a local, stdio, read-only analyzer over the same explicitly extracted file. AI consumes deterministic evidence; AI is not the source of correctness. Live production MCP and a durable exporter/store are not in this alpha.

## Alpha support matrix

Verified in this alpha:

- React Web using one application-owned physical client;
- Node.js ESM gateways with native browser WebSocket and Node `ws`;
- the PostgreSQL reference profile, cursor replay, fenced snapshot fallback, bounded command reconciliation, and two-gateway recovery;
- local CLI/MCP analysis of an explicitly extracted evidence bundle.

The generated details below come from `support/alpha-0.1.json`. `defined` means the language-neutral protocol describes a feature; it does not mean the TypeScript runtime implements or verifies it.

<details>
<summary>View the generated protocol/runtime/verification matrix</summary>

{{SUPPORT_BLOCK}}

</details>

## Documentation and project links

| Start here | Operate and evaluate | Project |
|---|---|---|
| [Quickstart](docs/public/quickstart.md) | [Production deployment](docs/public/production-deployment.md) | [Changelog](CHANGELOG.md) |
| [Typed contracts](docs/public/typed-contracts.md) | [Recovery](docs/public/recovery.md) | [Roadmap](ROADMAP.md) |
| [React client](docs/public/react.md) | [Diagnostics](docs/public/diagnostics.md) | [Security](SECURITY.md) |
| [Node server](docs/public/server.md) | [Troubleshooting](docs/public/troubleshooting.md) | [Contributing](CONTRIBUTING.md) |
| [PostgreSQL](docs/public/postgres.md) | [Contracts and upgrades](docs/public/contracts-and-upgrades.md) | [Code of Conduct](CODE_OF_CONDUCT.md) |

Current actual-browser acceptance is Chromium desktop and a narrow Chromium viewport. The 100-client Node `ws` workload is a same-environment regression alarm, not an SLO or capacity promise. Production IdP refresh/revocation, PostgreSQL replication/failover, mixed-manifest rolling deployment, and comprehensive exactly-once behavior remain unverified.

Better Realtime is available under the [MIT License](LICENSE).
