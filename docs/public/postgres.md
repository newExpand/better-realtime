# PostgreSQL reference profile

The default framework schema is `better_realtime`; use one dedicated schema per application contract identity. The schema metadata binds storage version, storage namespace, contract ID, manifest version, and manifest digest. A runtime refuses to start when the migration is missing or any member of that exact binding differs. The `0.2` release adds a deployment-only v1-to-v2 migration that preserves events, command results, idempotency identity, and the legacy command/event relation. It never applies runtime DDL.

DDL is a deployment action:

```ts
const migrationProfile = postgres({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  schema: "better_realtime",
  identityKeys: [{ version: 1, key: process.env.IDENTITY_KEY }]
});

await migratePostgres(contract, migrationProfile); // deployment step; then close this pool

const runtimeProfile = postgres({
  connectionString: process.env.RUNTIME_DATABASE_URL,
  schema: "better_realtime",
  identityKeys: [{ version: 1, key: process.env.IDENTITY_KEY }]
});

await createRealtimeServer(contract, { profile: runtimeProfile, originPolicy, /* handlers */ }).start();
```

The migration role needs schema creation/DDL privileges. The runtime role needs schema `USAGE` and only the DML/sequence privileges required by the framework and application handlers; it must not own or alter framework objects. Application/demo tables and migrations remain outside the framework migration.

Framework SQL is schema-qualified. Advisory locks include the storage namespace. The LISTEN/NOTIFY channel is deterministically derived from the schema, and the event/outbox tables—not NOTIFY—remain convergence truth. `notify_committed_at` proves only that a transaction containing `pg_notify` committed; it does not prove listener delivery.

Storage v2 adds ordered `realtime_command_events` rows and permits a command to have zero to 100 causal events. The immutable v1 migration source stays byte-identical; v2 is a separate migration source and edge. Startup against v1 fails closed until the migration role runs `migratePostgres()`.

## v1-to-v2 deployment boundary

Storage v1 and v2 are not a supported rolling mixed-runtime combination. An alpha.4 gateway requires metadata version 1 and a `0.2` gateway requires version 2, so neither runtime silently adapts to the other storage shape. Use this order:

1. take the application's normal database backup and stop every alpha.4 gateway, outbox publisher, and framework cleanup worker that uses the namespace;
2. run `migratePostgres()` once with the migration role;
3. verify the metadata version, framework shape, and application-specific post-migration checks;
4. start only `0.2` gateways and workers.

The migration runs under one PostgreSQL transaction and a namespace-scoped advisory lock. A migration error before commit rolls back its DDL and metadata update; correct the cause and rerun the same v2 migrator. A successful rerun is a validated no-op. Runtime startup rejects an absent namespace, v1, an unsupported future version, or a v2 metadata claim whose required columns, constraints, or index are incomplete.

Do not interpret rollback of a failed migration transaction as a supported storage downgrade. After v2 commits there is no framework downgrade migration to v1. Roll back the application deployment only before the database migration; after it commits, fix forward or restore the whole namespace from a tested backup according to the application's recovery plan. If privileged SQL has created a partial out-of-transaction shape, the migrator fails closed rather than guessing how to repair it; restore or explicitly repair the namespace under DBA control before retrying.

Database owners and superusers can bypass framework constraints, alter metadata, or write application projections outside the transaction-owned API. Better Realtime does not claim to detect every such privileged mutation. Keep migration credentials out of runtime processes, grant the runtime least-privilege DML access, and audit privileged changes. Publishing the npm packages proves only that migration code is present; it does not prove that any production database was migrated.
