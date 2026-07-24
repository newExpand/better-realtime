# Changelog

## Unreleased — 0.2.0-alpha.1 candidate

Adds the typed `stateStream()` materializer, selector-aware React subscriptions, command-scoped activity, framework-owned zero/multi-event and multi-stream transactions, versioned diagnostic sink/source boundaries, and browser/server/MCP dependency isolation. The low-level `stream()` surface and alpha.4 `prepare` transaction path remain explicit compatibility boundaries.

This candidate intentionally separates the local stdio analyzer as `better-realtime-mcp`, deploys PostgreSQL storage v2 through an additive versioned migration, and removes the package-wide Node engine constraint. Those package and storage changes are intentionally breaking and require the published [0.2 migration guide](docs/public/migration-0.2.md). The wire protocol remains `better-realtime.v1`; diagnostics verdict/completeness semantics remain unchanged.

User-visible migration boundaries:

- install browser/React, Node/PostgreSQL, and local MCP profiles separately; Node servers install `pg` and `ws` explicitly;
- replace `better-realtime/mcp` with the same-version `better-realtime-mcp` companion;
- replace command-hook `totalPendingCount` with command-scoped `pendingCount`/`isPending`, or use `useRuntime().pendingCount` only for deliberately runtime-wide UI;
- choose the `completed` or `observed` settlement boundary explicitly when using `executeAsync`;
- drain alpha.4 gateways, run the versioned storage v1→v2 migration with the migration role, and start only `0.2` gateways against that namespace.

The compatibility ledger records 14 intentionally breaking artifact/API/storage changes and no wire-v2 change. Exact-contract mismatches still fail with `RT_CONTRACT_INCOMPATIBLE`; there is no silent downgrade. Existing `stream()` and `prepare`/`mutate` applications can migrate packages and storage before adopting `stateStream()` or the new transaction API.

Not included: an existing HTTP/Fastify/Nest attach mode, React Native, Socket.IO, Go, Redis/NATS/Kafka, a durable hosted evidence backend, or production remote MCP. The MCP companion is local, read-only stdio only. TanStack Query remains future, optional, and demand-gated rather than a feature or mandatory follow-up of this release.

## 0.1.0-alpha.4 — 2026-07-23

Fix-forward security release: updates the bundled URI parser to `fast-uri 3.1.4` for CVE-2026-16221, preserves the alpha.1 public contract with all 20 detected artifact changes classified compatible, and replaces one-shot release scripting with a resumable, fail-closed state machine. Draft discovery, asset operations, finalization, and verification are bound to one numeric GitHub Release ID, while a durable identity-bound publish-intent marker prevents an ambiguous npm result from being published twice.

No public API, `better-realtime.v1`, diagnostics, or PostgreSQL storage v1 contract is deprecated or intentionally broken. The remaining moderate `@hono/node-server` advisory is limited to its Windows `serveStatic` path; Better Realtime's shipped MCP server is stdio-only and does not import that path.

## 0.1.0-alpha.3 — Unpublished tag-and-draft attempt, 2026-07-22

The approved release run created the annotated public `v0.1.0-alpha.3` tag and draft GitHub Release ID `358418104` with both exact assets, then failed because the workflow tried to rediscover that draft through GitHub's published-release tag endpoint. The draft and its assets remain preserved as failure evidence. No `0.1.0-alpha.3` npm package exists, and the tag, draft, or assets are never moved, deleted, finalized, or reused; publication fixes forward as `0.1.0-alpha.4`.

## 0.1.0-alpha.2 — Unpublished tag-only attempt, 2026-07-22

The approved release run created the annotated public `v0.1.0-alpha.2` tag, then failed before GitHub Release creation because a checkout-free job invoked `gh release create --verify-tag` without an explicit repository. No `0.1.0-alpha.2` GitHub Release or npm package was created. The existing public alpha.2 tag is preserved as immutable-by-policy failure evidence and is never moved, deleted, or reused.

## 0.1.0-alpha.1 — 2026-07-20

First public alpha baseline: contract-first React Web and Node.js APIs, native WebSocket recovery, the PostgreSQL 18.4 reference profile, and local payload-redacted CLI/MCP diagnostics.

This alpha does not promise rolling contract compatibility, production SLOs, non-Chromium browser support, production identity-provider refresh/revocation, PostgreSQL failover, or general exactly-once delivery.
