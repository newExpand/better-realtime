import { migratePostgres, postgres } from "better-realtime/server";
import { contract } from "./contract.js";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error("MIGRATION_DATABASE_URL is required");
const profile = postgres({ connectionString: migrationDatabaseUrl, identityKeys: [{ version: 1, key: process.env.IDENTITY_KEY ?? "fixture-identity-key-with-at-least-32-bytes" }] });

try {
  await migratePostgres(contract, profile);
  await profile.pool.query("CREATE TABLE IF NOT EXISTS public.consumer_messages(tenant_id TEXT NOT NULL, stream TEXT NOT NULL, sequence BIGINT NOT NULL, event_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, sent_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(tenant_id,stream,sequence), UNIQUE(tenant_id,event_id), FOREIGN KEY(tenant_id,stream,sequence,event_id) REFERENCES better_realtime.realtime_events(tenant_id,stream,sequence,event_id) DEFERRABLE INITIALLY DEFERRED)");
} finally {
  await profile.pool.end();
}
