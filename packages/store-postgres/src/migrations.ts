import { createHash } from "node:crypto";

export const POSTGRES_STORAGE_VERSION = 1;
export const DEFAULT_POSTGRES_SCHEMA = "better_realtime";

export interface PostgresStorageBinding {
  contractId: string;
  manifestVersion: string;
  manifestDigest: `sha256:${string}`;
}

export interface PostgresStorageNames {
  schema: string;
  namespace: string;
  channel: string;
  metadata: string;
  transactionAttempts: string;
  principalNamespaces: string;
  principalIdentityAliases: string;
  events: string;
  commands: string;
  outbox: string;
  streamRetention: string;
}

export function postgresStorageNames(schema = DEFAULT_POSTGRES_SCHEMA): PostgresStorageNames {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("RT_POSTGRES_SCHEMA_INVALID");
  const q = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  return Object.freeze({
    schema,
    namespace: `schema:${schema}`,
    channel: `better_realtime_${createHash("sha256").update(schema).digest("hex").slice(0, 32)}`,
    metadata: q("realtime_schema_metadata"),
    transactionAttempts: q("realtime_transaction_attempts"),
    principalNamespaces: q("realtime_principal_namespaces"),
    principalIdentityAliases: q("realtime_principal_identity_aliases"),
    events: q("realtime_events"),
    commands: q("realtime_commands"),
    outbox: q("realtime_outbox"),
    streamRetention: q("realtime_stream_retention")
  });
}

export function frameworkMigrationSql(names: PostgresStorageNames): string {
  const schema = quoteIdentifier(names.schema);
  return `
CREATE SCHEMA IF NOT EXISTS ${schema};

CREATE TABLE ${names.metadata} (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  storage_version INTEGER NOT NULL CHECK (storage_version > 0),
  storage_namespace TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE ${names.transactionAttempts} (
  transaction_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('schema_migration','principal_namespace','command','append_event','snapshot_read','outbox_publish','command_retention_cleanup','outbox_retention_cleanup','stream_retention')),
  result JSONB,
  marker_written_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX realtime_transaction_attempts_cleanup_idx ON ${names.transactionAttempts} (marker_written_at);

CREATE TABLE ${names.principalNamespaces} (
  tenant_id TEXT NOT NULL,
  principal_namespace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, principal_namespace_id)
);

CREATE TABLE ${names.principalIdentityAliases} (
  tenant_id TEXT NOT NULL,
  identity_tuple_version INTEGER NOT NULL CHECK (identity_tuple_version > 0),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  identity_fingerprint TEXT NOT NULL CHECK (identity_fingerprint ~ '^hmac-sha256:[a-f0-9]{64}$'),
  principal_namespace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, identity_tuple_version, key_version, identity_fingerprint),
  FOREIGN KEY (tenant_id, principal_namespace_id) REFERENCES ${names.principalNamespaces}(tenant_id, principal_namespace_id) ON DELETE CASCADE
);
CREATE INDEX realtime_principal_alias_namespace_idx ON ${names.principalIdentityAliases} (tenant_id, principal_namespace_id);

CREATE TABLE ${names.events} (
  tenant_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  data JSONB NOT NULL,
  append_operation_id TEXT,
  append_intent_hash_version INTEGER,
  append_intent_hash TEXT,
  command_principal_namespace_id UUID,
  command_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, stream, sequence),
  UNIQUE (tenant_id, event_id),
  UNIQUE (tenant_id, append_operation_id),
  UNIQUE (tenant_id, stream, sequence, event_id),
  CHECK ((append_operation_id IS NULL) = (append_intent_hash_version IS NULL)),
  CHECK ((append_operation_id IS NULL) = (append_intent_hash IS NULL)),
  CHECK (append_operation_id IS NULL OR char_length(append_operation_id) BETWEEN 1 AND 256),
  CHECK (append_intent_hash_version IS NULL OR append_intent_hash_version > 0),
  CHECK (append_intent_hash IS NULL OR append_intent_hash ~ '^sha256:[a-f0-9]{64}$'),
  CHECK ((command_principal_namespace_id IS NULL) = (command_id IS NULL)),
  FOREIGN KEY (tenant_id, command_principal_namespace_id) REFERENCES ${names.principalNamespaces}(tenant_id, principal_namespace_id)
);
CREATE INDEX realtime_events_command_idx ON ${names.events} (tenant_id, command_principal_namespace_id, command_id) WHERE command_id IS NOT NULL;

CREATE TABLE ${names.commands} (
  tenant_id TEXT NOT NULL,
  principal_namespace_id UUID NOT NULL,
  command_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('completed')),
  intent_hash_version INTEGER NOT NULL CHECK (intent_hash_version > 0),
  intent_hash TEXT NOT NULL CHECK (intent_hash ~ '^sha256:[a-f0-9]{64}$'),
  result JSONB,
  result_schema TEXT NOT NULL,
  event_id TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  result_expires_at TIMESTAMPTZ NOT NULL,
  idempotency_expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, principal_namespace_id, command_id),
  CHECK (result_expires_at <= idempotency_expires_at),
  FOREIGN KEY (tenant_id, principal_namespace_id) REFERENCES ${names.principalNamespaces}(tenant_id, principal_namespace_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES ${names.events}(tenant_id, event_id)
);
CREATE INDEX realtime_commands_cleanup_idx ON ${names.commands} (result_expires_at, idempotency_expires_at);

CREATE TABLE ${names.outbox} (
  outbox_id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  notify_committed_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES ${names.events}(tenant_id, event_id)
);
CREATE INDEX realtime_outbox_pending_idx ON ${names.outbox} (outbox_id) WHERE notify_committed_at IS NULL;

CREATE TABLE ${names.streamRetention} (
  tenant_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  minimum_sequence BIGINT NOT NULL CHECK (minimum_sequence > 0),
  PRIMARY KEY (tenant_id, stream)
);
`;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
