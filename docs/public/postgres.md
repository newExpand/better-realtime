# PostgreSQL reference profile

The default framework schema is `better_realtime`; use one dedicated schema per application contract identity. The schema metadata binds storage version, storage namespace, contract ID, manifest version, and manifest digest. A runtime refuses to start when the migration is missing or any member of that exact binding differs. `0.1.0-alpha.1` supports first installation into an empty dedicated schema only; there is no in-place migration from the private development/public-schema layout.

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
