import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { assertApplicationQueryText, PostgresGatewayServer } from "../src/postgres-gateway.ts";
import { POSTGRES_FRAMEWORK_TABLES } from "../../store-postgres/src/index.ts";

describe("transaction-owned application SQL boundary", () => {
  it.each([
    "COMMIT",
    "ROLLBACK",
    "BEGIN",
    "SET search_path = public",
    "LISTEN realtime_events",
    "CREATE TEMP TABLE leaked(id int)",
    "SELECT 1; COMMIT",
    "SELECT pg_advisory_lock(42)",
    "SELECT pg_try_advisory_lock(42)",
    "SELECT pg_try_advisory_lock_shared(42)",
    "SELECT pg_advisory_xact_lock(42)",
    "SELECT pg_advisory_xact_lock_shared(42)",
    "SELECT pg_try_advisory_xact_lock(42)",
    "SELECT pg_try_advisory_xact_lock_shared(42)",
    "SELECT pg_catalog.\"pg_advisory_lock_shared\"(42)",
    "SELECT pg_catalog.\"pg_advisory_xact_lock\"(42)",
    "SELECT U&\"pg\\005fadvisory\\005flock\"(42)",
    "SELECT U&\"pg\\005fadvisory\\005fxact\\005flock\"(42)",
    "SELECT U&\"pg\\005ftry\\005fadvisory\\005flock\"(42)",
    "SELECT U&\"pg\\005fadvisory\\005funlock\"(42)",
    "SELECT U&\"set\\005fconfig\"($1,$2,false)",
    "SELECT set_config('search_path','private',false)",
    "SELECT 1 INTO TEMP TABLE leaked_resource",
    "WITH x AS (SELECT 1) SELECT * INTO TEMP TABLE leaked_cte FROM x",
    "WITH \"insert\" AS (SELECT 1) SELECT * INTO TEMP TABLE leaked_resource FROM \"insert\"",
    "SELECT E'abc\\\''; COMMIT; SELECT 1; -- '",
    "SELECT E'abc\\\''; ROLLBACK; SELECT 1; -- '",
    "SELECT E'abc\\\''; SET search_path=private; SELECT 1; -- '",
    "/* hidden */ COMMIT",
    "SELECT 1; -- boundary\nROLLBACK"
  ])("rejects transaction, multi-statement, and session-control SQL: %s", (sql) => {
    expect(() => assertApplicationQueryText(sql)).toThrow("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
  });

  it.each(POSTGRES_FRAMEWORK_TABLES.flatMap((table) => [
    `SELECT * FROM ${table}`,
    `DELETE FROM better_realtime.${table} WHERE tenant_id = $1`,
    `WITH removed AS (DELETE FROM "better_realtime"."${table}" RETURNING *) SELECT * FROM removed`
  ]))("rejects every reserved framework relation through unqualified, schema-qualified, and quoted CTE syntax: %s", (sql) => {
    expect(() => assertApplicationQueryText(sql)).toThrow("RT_APPLICATION_DATABASE_QUERY_UNSAFE");
  });

  it.each([
    "SELECT body FROM messages WHERE tenant_id = $1",
    "INSERT INTO messages(tenant_id, body) VALUES($1, $2)",
    "UPDATE messages SET body = $2 WHERE tenant_id = $1",
    "DELETE FROM messages WHERE tenant_id = $1",
    "WITH selected AS (SELECT id FROM messages WHERE tenant_id = $1) SELECT id FROM selected",
    "WITH selected AS (SELECT id FROM messages WHERE tenant_id = $1) INSERT INTO archive(id) SELECT id FROM selected",
    "WITH selected AS (SELECT id FROM messages WHERE tenant_id = $1) UPDATE messages SET body = $2 WHERE id IN (SELECT id FROM selected)",
    "WITH selected AS (SELECT id FROM messages WHERE tenant_id = $1) DELETE FROM messages WHERE id IN (SELECT id FROM selected)",
    "SELECT 1 /* ; COMMIT */"
  ])("accepts one transactional DML/read statement: %s", (sql) => {
    expect(() => assertApplicationQueryText(sql)).not.toThrow();
  });
});

describe("PostgreSQL gateway resource bounds", () => {
  const base = { pool: { options: { connectionTimeoutMillis: 1_000 } } as Pool, runtimeId: "resource-test", originPolicy: { allowedOrigins: [] as string[], allowMissingOrigin: true }, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: `sha256:${"a".repeat(64)}` as const }, identityKeys: [{ version: 1, key: new Uint8Array(32) }], authenticate: () => ({ tenantId: "tenant", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }) };
  it.each([
    ["maxClients", "RT_MAX_CLIENTS_INVALID"],
    ["maxSubscriptionsPerClient", "RT_MAX_SUBSCRIPTIONS_INVALID"],
    ["maxInboundQueueMessages", "RT_MAX_INBOUND_QUEUE_INVALID"],
    ["maxInboundQueueBytes", "RT_MAX_INBOUND_QUEUE_BYTES_INVALID"],
    ["maxInboundMessagesPerSecond", "RT_MAX_INBOUND_RATE_INVALID"],
    ["maxApplicationHooks", "RT_MAX_APPLICATION_HOOKS_INVALID"],
    ["maxOutboundBufferedBytes", "RT_MAX_OUTBOUND_BUFFER_INVALID"],
    ["drainTimeoutMs", "RT_DRAIN_TIMEOUT_INVALID"]
  ] as const)("rejects an unbounded or disabled %s configuration", (field, code) => {
    expect(() => new PostgresGatewayServer({ ...base, [field]: 0 })).toThrow(code);
  });

  it.each([
    { intervalMs: 0, timeoutMs: 1_000 },
    { intervalMs: Number.NaN, timeoutMs: 1_000 },
    { intervalMs: 1_000, timeoutMs: Number.POSITIVE_INFINITY },
    { intervalMs: 300_001, timeoutMs: 1_000 },
    { intervalMs: 1_000, timeoutMs: 999 }
  ])("rejects an invalid heartbeat %#", (heartbeat) => {
    expect(() => new PostgresGatewayServer({ ...base, heartbeat })).toThrow("RT_HEARTBEAT_INVALID");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects a non-finite or negative outbound buffer bound: %s", (maxOutboundBufferedBytes) => {
    expect(() => new PostgresGatewayServer({ ...base, maxOutboundBufferedBytes })).toThrow("RT_MAX_OUTBOUND_BUFFER_INVALID");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 300_001, 1.5])("rejects an invalid drain timeout: %s", (drainTimeoutMs) => {
    expect(() => new PostgresGatewayServer({ ...base, drainTimeoutMs })).toThrow("RT_DRAIN_TIMEOUT_INVALID");
  });

  it("preserves an explicitly configured drain timeout", () => {
    const server = new PostgresGatewayServer({ ...base, drainTimeoutMs: 5_000 });
    expect(server.drainTimeoutMs).toBe(5_000);
  });

  it("keeps gateway evidence revision metadata behind one source of truth", async () => {
    const source = await readFile(new URL("../src/postgres-gateway.ts", import.meta.url), "utf8");
    expect(source.match(/component:\s*"postgres-gateway"/g)).toHaveLength(1);
    expect(source.match(/componentVersion:\s*"[^\"]+"/g)).toEqual(['componentVersion: "0.5.0"']);
    expect(source.match(/\.\.\.POSTGRES_GATEWAY_EVIDENCE_COMPONENT/g)?.length).toBeGreaterThan(30);
  });

  it("routes authenticated gateway failures through the trusted client context", async () => {
    const source = await readFile(new URL("../src/postgres-gateway.ts", import.meta.url), "utf8");
    const sensitiveCalls = [...source.matchAll(
      /this\.(#recordForClient|recorder\.record)\(client,\s*\{\s*kind:\s*"(authorization\.denied|event\.outbound_validation_failed|command\.outbound_validation_failed|slow_consumer\.disconnected)"/gu
    )];

    expect(sensitiveCalls).toHaveLength(6);
    expect(sensitiveCalls.every((match) => match[1] === "#recordForClient")).toBe(true);
    expect(source).toContain("this.recorder.record(input, tenantId ? { tenantId } : {})");
  });

  it("emits one bounded causal evidence record for every command event", async () => {
    const source = await readFile(new URL("../src/postgres-gateway.ts", import.meta.url), "utf8");

    expect(source.match(/this\.#recordCommandCausalEvents\(client,/gu)).toHaveLength(2);
    expect(source).toContain("for (let index = 0; index < events.length; index += 1)");
    expect(source).toContain('boundary: "command.causal_event_linked"');
    expect(source).toContain("causalHandoffId: `event:${event.eventId}`");
    expect(source).toContain("eventSequence: event.sequence");
  });

  it("forwards both gateway and database recorder evidence through one configured boundary", async () => {
    const observed: Array<{ producerRole: string; boundary: string; tenantId?: string }> = [];
    const server = new PostgresGatewayServer({
      ...base,
      onEvidenceRecord: (record, routing) => observed.push({
        producerRole: record.producerRole,
        boundary: record.boundary ?? "unknown",
        ...(routing.tenantId ? { tenantId: routing.tenantId } : {})
      })
    });
    server.recorder.record({
      kind: "test.gateway",
      boundary: "test.gateway",
      outcome: "success",
      component: "test",
      componentVersion: "1.0.0"
    }, { tenantId: "gateway-tenant" });
    server.store.recorder.record({
      kind: "test.database",
      boundary: "test.database",
      outcome: "success",
      component: "test",
      componentVersion: "1.0.0"
    }, { tenantId: "database-tenant" });
    expect(observed).toEqual([
      { producerRole: "server", boundary: "test.gateway", tenantId: "gateway-tenant" },
      { producerRole: "database", boundary: "test.database", tenantId: "database-tenant" }
    ]);
    await server.dispose();
  });
});
