# Changelog

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
