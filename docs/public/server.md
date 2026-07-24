# Node.js server

Import `better-realtime/server`. Install `pg` and `ws` explicitly in Node gateway projects; they are optional peers of the browser-capable base package so browser-only consumers do not receive them. The application chooses a supported `pg@8.22+` and `ws@8.21+` release.

The alpha package is ESM-only. Use Node.js 22 with `"type": "module"` (or `.mjs`) and `import`; CommonJS `require` has no export condition yet.

The complete, compiled reference application is split along deployment ownership boundaries:

- [`contract.ts`](../../fixtures/external-consumer/src/contract.ts) defines every stream, event, reducer, command, and schema;
- [`migrate.ts`](../../fixtures/external-consumer/src/migrate.ts) runs framework DDL with the migration role;
- [`server.ts`](../../fixtures/external-consumer/src/server.ts) provides authentication, authorization, snapshot reads, and atomic command mutation/event publication;
- [`client.ts`](../../fixtures/external-consumer/src/client.ts) creates the one application-owned physical client.

Run `pnpm e2e:consumer` from the repository root to prove those files against only the generated tarball. The harness deploys the migration, starts two independent gateway processes on PostgreSQL 18.4, builds the React app, interrupts Gateway A, reconciles ACK loss through Gateway B, and compares CLI/MCP diagnosis.

Runtime startup checks migration and exact contract binding but never runs DDL. Application mutation and event/outbox append share the framework transaction. The callback database port is bounded and promise-only; do not start unawaited work or transaction/session control through it.

The optional `diagnostics.evidence` setting connects both gateway and PostgreSQL recorders to an application-owned sink. Supply a secret pseudonymization key and a `systemTenantId` for process-only facts; authenticated operation facts use trusted routing metadata rather than payload fields. Observe failures through `flushEvidence()`/`evidenceSnapshot()` and always await `dispose()` so exact producer checkpoints reach the sink. For a shared multi-gateway sink, use `topology: "shared"` and finalize the complete producer set as described in [Diagnostics](diagnostics.md).

The `0.2` transaction handler declares every possible stream target before `BEGIN`, then uses the framework-owned query/emit context. It supports event-free, one-event, multi-event, and multi-stream commands, including DB-generated payloads and conditional emission. Targets are validated and locked in deterministic physical-stream order. Emission to an undeclared target, DDL, transaction control, session configuration, application advisory locks, or direct access to a reserved framework storage relation fails the command and rolls back every effect. Application tables must not reuse the reserved framework relation names. The alpha.4 `prepare()` handler remains a compatibility adapter; see the [migration guide](migration-0.2.md).

Standalone `start()` remains the implemented server mode. An existing HTTP/Fastify/Nest upgrade attachment API was reviewed but is intentionally not claimed by this candidate: it needs explicit listener ownership, path arbitration, drain, Origin/auth/capacity parity, and host-server shutdown tests before becoming public.

The server speaks `better-realtime.v1`. Deploy behind a WSS reverse proxy.
