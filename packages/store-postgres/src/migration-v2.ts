import {
  DEFAULT_POSTGRES_SCHEMA,
  frameworkMigrationSql as frameworkMigrationV1Sql,
  postgresStorageNames as postgresStorageV1Names,
  quoteIdentifier,
  type PostgresStorageNames
} from "./migrations.ts";

export const POSTGRES_STORAGE_VERSION = 2;
export const PREVIOUS_POSTGRES_STORAGE_VERSION = 1;

export interface PostgresStorageNamesV2 extends PostgresStorageNames {
  commandEvents: string;
}

export function postgresStorageNames(schema = DEFAULT_POSTGRES_SCHEMA): PostgresStorageNamesV2 {
  const v1 = postgresStorageV1Names(schema);
  return Object.freeze({
    ...v1,
    commandEvents: `${quoteIdentifier(schema)}.${quoteIdentifier("realtime_command_events")}`
  });
}

/** Fresh storage-v2 install. Deployment roles invoke this inside the migration transaction. */
export function frameworkMigrationSql(names: PostgresStorageNamesV2): string {
  return `${frameworkMigrationV1Sql(names)}
${storageV1ToV2MigrationSql(names)}`;
}

/** Deployment-time, data-preserving upgrade from storage v1 to v2. */
export function storageV1ToV2MigrationSql(names: PostgresStorageNamesV2): string {
  return `
ALTER TABLE ${names.commands} ALTER COLUMN event_id DROP NOT NULL;

CREATE TABLE ${names.commandEvents} (
  tenant_id TEXT NOT NULL,
  principal_namespace_id UUID NOT NULL,
  command_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
  event_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_namespace_id, command_id, ordinal),
  UNIQUE (tenant_id, principal_namespace_id, command_id, event_id),
  FOREIGN KEY (tenant_id, principal_namespace_id, command_id) REFERENCES ${names.commands}(tenant_id, principal_namespace_id, command_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, event_id) REFERENCES ${names.events}(tenant_id, event_id)
);
CREATE INDEX realtime_command_events_event_idx ON ${names.commandEvents} (tenant_id, event_id);

INSERT INTO ${names.commandEvents} (tenant_id, principal_namespace_id, command_id, ordinal, event_id)
SELECT tenant_id, principal_namespace_id, command_id, 0, event_id
FROM ${names.commands}
WHERE event_id IS NOT NULL;
`;
}
