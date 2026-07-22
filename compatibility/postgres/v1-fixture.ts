export interface FixtureRuntimeApi {
  jsonSchema(name: string, schema: Record<string, unknown>): unknown;
  stream(value: Record<string, unknown>): unknown;
  command(value: Record<string, unknown>): unknown;
  defineRealtimeContract(value: Record<string, unknown>): { identity: { contractId: string; manifestVersion: string; manifestDigest: string } };
}

export interface FixturePool {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export function createContract(api: FixtureRuntimeApi) {
  const object = api.jsonSchema("compat.postgres.object@1", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } });
  const result = api.jsonSchema("compat.postgres.result@1", { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } });
  return api.defineRealtimeContract({
    contractId: "compat.postgres",
    manifestVersion: "1.0.0",
    streams: { item: api.stream({ input: object, snapshot: object, events: { changed: object }, key: ({ id }: { id: string }) => `item:${id}`, initial: () => ({ id: "" }), applyEvent: (_state: unknown, event: { data: unknown }) => event.data, snapshotSequence: () => 0 }) },
    commands: { update: api.command({ input: object, result }) }
  });
}

export async function seed(pool: FixturePool, schema: string): Promise<void> {
  const principal = "00000000-0000-4000-8000-000000000001";
  const fingerprint = `hmac-sha256:${"a".repeat(64)}`;
  const intent = `sha256:${"b".repeat(64)}`;
  await pool.query("BEGIN");
  try {
    await pool.query(`INSERT INTO "${schema}".realtime_principal_namespaces(tenant_id,principal_namespace_id) VALUES($1,$2)`, ["tenant-compat", principal]);
    await pool.query(`INSERT INTO "${schema}".realtime_principal_identity_aliases(tenant_id,identity_tuple_version,key_version,identity_fingerprint,principal_namespace_id) VALUES($1,1,1,$2,$3)`, ["tenant-compat", fingerprint, principal]);
    await pool.query(`INSERT INTO "${schema}".realtime_events(tenant_id,stream,sequence,event_id,event_type,schema_name,data,command_principal_namespace_id,command_id) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`, ["tenant-compat", "item:1", "event-compat", "changed", "compat.postgres.object@1", { id: "1" }, principal, "command-compat"]);
    await pool.query(`INSERT INTO "${schema}".realtime_events(tenant_id,stream,sequence,event_id,event_type,schema_name,data,append_operation_id,append_intent_hash_version,append_intent_hash) VALUES($1,$2,2,$3,$4,$5,$6,$7,1,$8)`, ["tenant-compat", "item:1", "event-standalone", "changed", "compat.postgres.object@1", { id: "2" }, "append-operation-compat", intent]);
    await pool.query(`INSERT INTO "${schema}".realtime_commands(tenant_id,principal_namespace_id,command_id,state,intent_hash_version,intent_hash,result,result_schema,event_id,result_expires_at,idempotency_expires_at) VALUES($1,$2,$3,'completed',1,$4,$5,$6,$7,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')`, ["tenant-compat", principal, "command-compat", intent, { ok: true }, "compat.postgres.result@1", "event-compat"]);
    await pool.query(`INSERT INTO "${schema}".realtime_outbox(tenant_id,event_id,notify_committed_at,publish_attempts) VALUES($1,$2,clock_timestamp(),1)`, ["tenant-compat", "event-compat"]);
    await pool.query(`INSERT INTO "${schema}".realtime_outbox(tenant_id,event_id,notify_committed_at,publish_attempts) VALUES($1,$2,NULL,0)`, ["tenant-compat", "event-standalone"]);
    await pool.query(`INSERT INTO "${schema}".realtime_stream_retention(tenant_id,stream,minimum_sequence) VALUES($1,$2,1)`, ["tenant-compat", "item:1"]);
    await pool.query(`INSERT INTO "${schema}".realtime_transaction_attempts(transaction_id,operation,result) VALUES($1,'command',$2)`, ["transaction-compat", { status: "committed" }]);
    await pool.query("COMMIT");
  } catch (error) { await pool.query("ROLLBACK"); throw error; }
}

export async function snapshot(pool: FixturePool, schema: string): Promise<Record<string, unknown[]>> {
  const queries: Record<string, string> = {
    metadata: `SELECT singleton,storage_namespace,contract_id,manifest_version,manifest_digest,installed_at FROM "${schema}".realtime_schema_metadata ORDER BY singleton`,
    transactionAttempts: `SELECT transaction_id,operation,result,marker_written_at FROM "${schema}".realtime_transaction_attempts WHERE operation <> 'schema_migration' ORDER BY transaction_id`,
    principalNamespaces: `SELECT tenant_id,principal_namespace_id,created_at FROM "${schema}".realtime_principal_namespaces ORDER BY tenant_id,principal_namespace_id`,
    principalAliases: `SELECT tenant_id,identity_tuple_version,key_version,identity_fingerprint,principal_namespace_id,created_at FROM "${schema}".realtime_principal_identity_aliases ORDER BY tenant_id,identity_tuple_version,key_version,identity_fingerprint`,
    events: `SELECT tenant_id,stream,sequence,event_id,event_type,schema_name,data,append_operation_id,append_intent_hash_version,append_intent_hash,command_principal_namespace_id,command_id,occurred_at FROM "${schema}".realtime_events ORDER BY tenant_id,stream,sequence`,
    commands: `SELECT tenant_id,principal_namespace_id,command_id,state,intent_hash_version,intent_hash,result,result_schema,event_id,accepted_at,completed_at,result_expires_at,idempotency_expires_at FROM "${schema}".realtime_commands ORDER BY tenant_id,principal_namespace_id,command_id`,
    outbox: `SELECT outbox_id,tenant_id,event_id,created_at,notify_committed_at,publish_attempts FROM "${schema}".realtime_outbox ORDER BY outbox_id`,
    retention: `SELECT tenant_id,stream,minimum_sequence FROM "${schema}".realtime_stream_retention ORDER BY tenant_id,stream`
  };
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, query]) => [name, (await pool.query(query)).rows])));
}
