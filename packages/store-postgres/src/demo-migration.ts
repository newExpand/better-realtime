import { quoteIdentifier, type PostgresStorageNames } from "./migrations.ts";

/** Repository demo/application DDL. This is never part of the framework migration or runtime startup. */
export function demoApplicationMigrationSql(names: PostgresStorageNames): string {
  return `
CREATE TABLE IF NOT EXISTS ${quoteIdentifier(names.schema)}.realtime_room_messages (
  tenant_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, stream, sequence),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, stream, sequence, event_id) REFERENCES ${names.events}(tenant_id, stream, sequence, event_id) DEFERRABLE INITIALLY DEFERRED
);
`;
}
