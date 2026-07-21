# Node.js server

Import `better-realtime/server`. `pg` and `ws` are required peers and are resolved by a normal npm install; keeping them as peers lets the application choose a supported `pg@8.22+` and `ws@8.21+` release.

The alpha package is ESM-only. Use Node.js 22 with `"type": "module"` (or `.mjs`) and `import`; CommonJS `require` has no export condition yet.

The complete, compiled reference application is split along deployment ownership boundaries:

- [`contract.ts`](../../fixtures/external-consumer/src/contract.ts) defines every stream, event, reducer, command, and schema;
- [`migrate.ts`](../../fixtures/external-consumer/src/migrate.ts) runs framework DDL with the migration role;
- [`server.ts`](../../fixtures/external-consumer/src/server.ts) provides authentication, authorization, snapshot reads, and atomic command mutation/event publication;
- [`client.ts`](../../fixtures/external-consumer/src/client.ts) creates the one application-owned physical client.

Run `pnpm e2e:consumer` from the repository root to prove those files against only the generated tarball. The harness deploys the migration, starts two independent gateway processes on PostgreSQL 18.4, builds the React app, interrupts Gateway A, reconciles ACK loss through Gateway B, and compares CLI/MCP diagnosis.

Runtime startup checks migration and exact contract binding but never runs DDL. Application mutation and event/outbox append share the framework transaction. The callback database port is bounded and promise-only; do not start unawaited work or transaction/session control through it.

The server speaks `better-realtime.v1`. Deploy behind a WSS reverse proxy.
