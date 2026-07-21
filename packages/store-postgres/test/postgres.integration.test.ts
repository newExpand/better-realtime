import { DatabaseError, Pool, type PoolClient } from "pg";
import { spawn } from "node:child_process";
import { connect as connectTcp, createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocketClient from "ws";
import { PostgresGatewayServer, type PostgresGatewayDatabase } from "../../server-node/src/postgres-gateway.ts";
import { doctor, LocalDiagnosticQuery } from "../../diagnostics/src/index.ts";
import type { JsonValue } from "../../protocol/src/index.ts";
import { command, defineRealtimeContract, jsonSchema, stream } from "../../runtime/src/index.ts";
import { createRealtimeServer, migratePostgres, postgres } from "../../runtime/src/server.ts";
import { selectTenantEvidenceRecords } from "../../runtime/src/evidence-scope.ts";
import { canonicalCommandIntent, PostgresEventLog } from "../src/index.ts";

const databaseUrl = process.env.POSTGRES_URL;
const suite = databaseUrl ? describe : describe.skip;
const storageContract = { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } as const;

suite("Postgres event log and transactional outbox", () => {
  const testSearchPath = "-c search_path=better_realtime,public";
  const nodeOriginPolicy = { allowedOrigins: [] as string[], allowMissingOrigin: true };
  const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 1_000, options: testSearchPath });
  const log = new PostgresEventLog(pool);
  let domainEffects = 0;

  const identity = { tenantId: "tenant-a", authenticationRealm: "demo", issuer: "https://issuer.example", subject: "user-1" };
  const keys = [{ version: 1, key: "old-identity-key-for-tests" }, { version: 2, key: "current-identity-key-for-tests" }];
  let principalNamespaceId: string;

  beforeAll(async () => {
    await log.migrate(storageContract);
    await log.migrateDemoApplication();
    await pool.query("TRUNCATE realtime_outbox, realtime_commands, realtime_room_messages, realtime_events, realtime_principal_identity_aliases, realtime_principal_namespaces RESTART IDENTITY CASCADE");
    principalNamespaceId = await log.resolvePrincipalNamespace({ ...identity, keys });
  });
  afterAll(async () => { await pool.end(); });

  it("installs the bounded transaction-attempt cleanup index", async () => {
    expect((await pool.query("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'realtime_transaction_attempts_cleanup_idx'")).rowCount).toBe(1);
  });

  it("installs an empty dedicated schema once and rejects a different contract binding", async () => {
    const schema = "better_realtime_binding_test";
    const isolated = new PostgresEventLog(pool, undefined, {}, { schema });
    const binding = { contractId: "contract.alpha", manifestVersion: "1.0.0", manifestDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } as const;
    await isolated.migrate(binding);
    await isolated.assertReady(binding);
    for (const different of [
      { ...binding, contractId: "contract.beta" },
      { ...binding, manifestVersion: "2.0.0" },
      { ...binding, manifestDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const }
    ]) {
      await expect(isolated.assertReady(different)).rejects.toThrow("RT_POSTGRES_STORAGE_BINDING_MISMATCH");
      await expect(isolated.migrate(different)).rejects.toMatchObject({ code: "RT_TRANSACTION_ROLLED_BACK" });
    }
    const metadata = await pool.query(`SELECT storage_version, storage_namespace, contract_id, manifest_version, manifest_digest FROM "${schema}".realtime_schema_metadata`);
    expect(metadata.rows).toEqual([{ storage_version: 1, storage_namespace: `schema:${schema}`, contract_id: "contract.alpha", manifest_version: "1.0.0", manifest_digest: binding.manifestDigest }]);
    expect(isolated.storage.channel).not.toBe(log.storage.channel);
  });

  it("rejects an unbound populated schema without adopting or rewriting it", async () => {
    const schema = "better_realtime_legacy_test";
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE "${schema}".realtime_events (legacy_marker TEXT NOT NULL)`);
    const isolated = new PostgresEventLog(pool, undefined, {}, { schema });
    try {
      await expect(isolated.migrate(storageContract)).rejects.toMatchObject({ code: "RT_TRANSACTION_ROLLED_BACK" });
      const tables = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema]);
      const columns = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'realtime_events' ORDER BY ordinal_position", [schema]);
      expect(tables.rows).toEqual([{ table_name: "realtime_events" }]);
      expect(columns.rows).toEqual([{ column_name: "legacy_marker" }]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it("fails runtime startup on an unmigrated namespace without creating schema objects", async () => {
    const schema = "better_realtime_unmigrated_test";
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const gateway = new PostgresGatewayServer({
      pool, port: 0, runtimeId: "unmigrated-runtime-test", storageSchema: schema,
      originPolicy: nodeOriginPolicy, contract: storageContract, identityKeys: keys,
      authenticate: () => ({ tenantId: "tenant-unmigrated", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] })
    });
    try {
      await expect(gateway.start()).rejects.toThrow("RT_POSTGRES_MIGRATION_REQUIRED");
      expect((await pool.query<{ namespace: string | null }>("SELECT to_regnamespace($1)::text AS namespace", [schema])).rows[0]?.namespace).toBeNull();
      expect((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = $1", [schema])).rowCount).toBe(0);
    } finally {
      await gateway.dispose();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it("isolates DML, locks, notifications, and diagnostic correlation across storage schemas", async () => {
    const unscopedPool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000 });
    const left = new PostgresEventLog(unscopedPool, undefined, {}, { schema: "better_realtime_isolation_left" });
    const right = new PostgresEventLog(unscopedPool, undefined, {}, { schema: "better_realtime_isolation_right" });
    const leftContract = { contractId: "contract.left", manifestVersion: "1.0.0", manifestDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" } as const;
    const rightContract = { contractId: "contract.right", manifestVersion: "1.0.0", manifestDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } as const;
    const leftNotifications: number[] = [];
    const rightNotifications: number[] = [];
    let stopLeft: (() => Promise<void>) | undefined;
    let stopRight: (() => Promise<void>) | undefined;
    let blocker: PoolClient | undefined;
    try {
      await left.migrate(leftContract);
      await right.migrate(rightContract);
      stopLeft = await left.listen(({ outboxId }) => leftNotifications.push(outboxId));
      stopRight = await right.listen(({ outboxId }) => rightNotifications.push(outboxId));
      const append = (store: PostgresEventLog, side: string) => store.appendEvent({ appendId: "same-append", tenantId: "same-tenant", stream: "same-stream", eventType: "changed", schema: "changed@1", data: { side }, effectSchema: "none@1", effect: null });
      blocker = await unscopedPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${left.storage.namespace}:append:same-tenant:same-append`]);
      const rightEvent = await Promise.race([append(right, "right"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("right schema shared the left advisory namespace")), 250))]);
      let leftSettled = false;
      const leftPending = append(left, "left").finally(() => { leftSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(leftSettled).toBe(false);
      await blocker.query("COMMIT");
      blocker.release();
      blocker = undefined;
      const leftEvent = await leftPending;
      expect(leftEvent.sequence).toBe(1);
      expect(rightEvent.sequence).toBe(1);
      expect((await left.latestEvent("same-tenant", "same-stream"))?.data).toEqual({ side: "left" });
      expect((await right.latestEvent("same-tenant", "same-stream"))?.data).toEqual({ side: "right" });
      expect((await unscopedPool.query(`SELECT count(*)::int AS count FROM ${left.storage.outbox}`)).rows[0]?.count).toBe(1);
      expect((await unscopedPool.query(`SELECT count(*)::int AS count FROM ${right.storage.outbox}`)).rows[0]?.count).toBe(1);

      await left.publishOutbox({ limit: 10 });
      await waitForCondition(() => leftNotifications.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(rightNotifications).toEqual([]);
      await right.publishOutbox({ limit: 10 });
      await waitForCondition(() => rightNotifications.length === 1);

      const leftAppendCorrelation = left.recorder.records().find((record) => record.boundary === "outbox.appended")?.operationCorrelationId;
      const rightAppendCorrelation = right.recorder.records().find((record) => record.boundary === "outbox.appended")?.operationCorrelationId;
      const leftPublishCorrelation = left.recorder.records().find((record) => record.boundary === "outbox.notify_committed")?.operationCorrelationId;
      const rightPublishCorrelation = right.recorder.records().find((record) => record.boundary === "outbox.notify_committed")?.operationCorrelationId;
      expect(leftAppendCorrelation).toBeDefined();
      expect(rightAppendCorrelation).toBeDefined();
      expect(leftAppendCorrelation).not.toBe(rightAppendCorrelation);
      expect(leftPublishCorrelation).toBeDefined();
      expect(rightPublishCorrelation).toBeDefined();
      expect(leftPublishCorrelation).not.toBe(rightPublishCorrelation);
    } finally {
      if (blocker) { await blocker.query("ROLLBACK").catch(() => undefined); blocker.release(); }
      await stopLeft?.();
      await stopRight?.();
      await unscopedPool.end();
    }
  });

  it("starts with a DML-only runtime role that cannot execute framework DDL", async () => {
    const role = "better_realtime_runtime_test";
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'runtime-test-password'`);
    await pool.query(`GRANT USAGE ON SCHEMA better_realtime TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA better_realtime TO ${role}`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA better_realtime TO ${role}`);
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = role;
    runtimeUrl.password = ["runtime", "test", "password"].join("-");
    const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), connectionTimeoutMillis: 1_000, options: testSearchPath });
    const gateway = new PostgresGatewayServer({ pool: runtimePool, port: 0, runtimeId: "runtime-role-test", originPolicy: nodeOriginPolicy, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, identityKeys: keys, authenticate: () => ({ tenantId: "tenant-runtime-role", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }) });
    try {
      await gateway.start();
      expect(gateway.ready).toBe(true);
      await expect(runtimePool.query("CREATE TABLE better_realtime.runtime_must_not_create(id integer)")).rejects.toThrow();
    } finally {
      await gateway.dispose();
      await runtimePool.end();
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });

  it("rejects a browser origin before authentication or transport allocation", async () => {
    let authenticationCalls = 0;
    const gateway = new PostgresGatewayServer({
      pool, port: 0, runtimeId: "origin-gate-test", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      originPolicy: { allowedOrigins: ["https://app.example.test"] }, identityKeys: keys,
      authenticate: () => { authenticationCalls += 1; return { tenantId: "tenant-origin", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }; }
    });
    const rejected = (headers?: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const socket = new WebSocketClient(gateway.webSocketUrl, "better-realtime.v1", headers ? { headers } : {});
      socket.once("unexpected-response", (_request: unknown, response: IncomingMessage) => { response.resume(); resolve(response.statusCode ?? 0); });
      socket.once("open", () => reject(new Error("origin unexpectedly accepted")));
      socket.once("error", () => undefined);
    });
    try {
      await gateway.start();
      expect(await rejected({ Origin: "https://app.example.test.evil.invalid" })).toBe(403);
      expect(await rejected()).toBe(403);
      expect(authenticationCalls).toBe(0);
      expect(gateway.recorder.records().some((record) => record.boundary === "transport.opened")).toBe(false);
    } finally { await gateway.dispose(); }
  });

  it("rejects a protocol-defined auth update explicitly in the alpha gateway", async () => {
    const gateway = new PostgresGatewayServer({
      pool, port: 0, runtimeId: "auth-refresh-unsupported", contract: storageContract,
      originPolicy: nodeOriginPolicy, identityKeys: keys,
      authenticate: () => ({ tenantId: "tenant-auth-refresh", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] })
    });
    let socket: WebSocketClient | undefined;
    try {
      await gateway.start();
      socket = new WebSocketClient(gateway.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_auth_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_auth_open", contract: storageContract, auth: {} }));
      await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      const closed = new Promise<number>((resolve) => socket!.once("close", resolve));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.auth.update", messageId: "msg_auth_update", sentAt: new Date().toISOString(), challengeId: "challenge_auth_update", auth: {} }));
      const failure = await waitForWireMessage(messages, (message) => message.kind === "error");
      expect(failure.error).toMatchObject({ code: "RT_AUTH_REFRESH_UNSUPPORTED", scope: "session", disposition: "fail_session", retryable: false });
      expect(await closed).toBe(1008);
      expect(gateway.recorder.records()).toEqual(expect.arrayContaining([expect.objectContaining({ boundary: "session.unsupported_behavior", reasonCode: "RT_AUTH_REFRESH_UNSUPPORTED", details: { kind: "session.auth.update" } })]));
    } finally { socket?.terminate(); await gateway.dispose(); }
  });

  it("preserves Origin and the WebSocket subprotocol through an actual TLS reverse proxy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "better-realtime-wss-"));
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    let gateway: PostgresGatewayServer | undefined;
    const proxy = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) });
    proxy.on("upgrade", (incoming, clientSocket, head) => {
      if (!gateway) { clientSocket.destroy(); return; }
      const upstream = httpRequest({ host: "127.0.0.1", port: gateway.port, path: incoming.url, method: incoming.method, headers: incoming.headers });
      upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
        const headers = response.rawHeaders.reduce((value, item, index, all) => index % 2 === 0 ? `${value}${item}: ${all[index + 1]}\r\n` : value, "");
        clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
        if (head.length) upstreamSocket.write(head);
        if (upstreamHead.length) clientSocket.write(upstreamHead);
        clientSocket.pipe(upstreamSocket).pipe(clientSocket);
      });
      upstream.on("response", (response) => { response.resume(); clientSocket.destroy(); });
      upstream.on("error", () => clientSocket.destroy());
      upstream.end();
    });
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("TLS proxy did not bind");
    const origin = `https://127.0.0.1:${address.port}`;
    gateway = new PostgresGatewayServer({ pool, port: 0, runtimeId: "wss-proxy-test", originPolicy: { allowedOrigins: [origin] }, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, identityKeys: keys, authenticate: () => ({ tenantId: "tenant-wss", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }) });
    let socket: WebSocketClient | undefined;
    try {
      await gateway.start();
      socket = new WebSocketClient(`wss://127.0.0.1:${address.port}/ws`, "better-realtime.v1", { rejectUnauthorized: false, headers: { Origin: origin } });
      await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_wss_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_wss", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: {} }));
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("WSS session.ready timed out")), 2_000); socket!.once("message", (data) => { clearTimeout(timeout); resolve(JSON.parse(data.toString()) as Record<string, unknown>); }); });
      expect(ready.kind).toBe("session.ready");
    } finally {
      socket?.close();
      await gateway?.dispose();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("commits domain mutation, event, command result and outbox without writer-owned NOTIFY", async () => {
    const execute = () => log.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId: "cmd-stable", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { roomId: "42", text: "atomic" }, stream: "room:42", eventType: "messageAdded", schema: "MessageAdded@1", data: { author: "You", text: "atomic", sentAt: "2026-07-18T00:00:00.000Z" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async (client, sequence, eventId) => { domainEffects += 1; await client.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["tenant-a", "room:42", sequence, eventId, "You", "atomic", "2026-07-18T00:00:00.000Z"]); return { ok: true }; } });
    const first = await execute(); const duplicate = await execute();
    expect(first.status).toBe("completed"); expect(duplicate.status).toBe("completed");
    if (first.status !== "completed" || duplicate.status !== "completed") throw new Error("expected completed command");
    expect(first.duplicate).toBe(false); expect(duplicate.duplicate).toBe(true);
    expect(domainEffects).toBe(1); expect(duplicate.event.eventId).toBe(first.event.eventId);
    expect(await log.readAfter("tenant-a", "room:42")).toHaveLength(1);
    expect(await log.pendingOutbox("tenant-a")).toHaveLength(1);
    expect((await pool.query("SELECT notify_committed_at FROM realtime_outbox WHERE tenant_id = 'tenant-a' AND event_id = $1", [first.event.eventId])).rows[0]?.notify_committed_at).toBeNull();
    expect(log.recorder.records().some((record) => record.producerRole === "database" && record.boundary === "db.committed" && record.commandId === "cmd-stable")).toBe(true);
    expect(log.recorder.records().some((record) => record.boundary === "outbox.appended" && record.commandId === "cmd-stable")).toBe(true);
  });

  it("rolls back every durable boundary when the domain mutation fails", async () => {
    await expect(log.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId: "cmd-fail", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { roomId: "42", text: "fail" }, stream: "room:42", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "no commit" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => { throw new Error("injected transaction failure"); } })).rejects.toThrow("injected transaction failure");
    expect((await pool.query("SELECT 1 FROM realtime_commands WHERE tenant_id = 'tenant-a' AND principal_namespace_id = $1 AND command_id = 'cmd-fail'", [principalNamespaceId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM realtime_events WHERE tenant_id = 'tenant-a' AND command_id = 'cmd-fail'")).rowCount).toBe(0);
    expect(log.recorder.records().some((record) => record.boundary === "db.rolled_back" && record.outcome === "failure" && record.commandId === "cmd-fail" && record.details?.proofSource === "commit_not_invoked")).toBe(true);
  });

  it("rejects forged cursors and unbounded read requests", async () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, t: "tenant-a", s: "room:42", q: -1 })).toString("base64url");
    await expect(log.readAfter("tenant-a", "room:42", forged)).rejects.toThrow("RT_CURSOR_EXPIRED");
    await expect(log.readAfter("tenant-b", "room:42", (await log.head("tenant-a", "room:42")))).rejects.toThrow("RT_CURSOR_EXPIRED");
    await expect(log.readAfter("tenant-a", "room:42", null, 1_001)).rejects.toThrow("RT_READ_LIMIT_INVALID");
    await expect(log.pendingOutbox("tenant-a", 0)).rejects.toThrow("RT_READ_LIMIT_INVALID");
  });

  it("isolates sequence, cursor, event data, command identity, and outbox by tenant", async () => {
    const principalA = await log.resolvePrincipalNamespace({ tenantId: "tenant-isolation-a", authenticationRealm: "demo", issuer: "issuer", subject: "same", keys });
    const principalB = await log.resolvePrincipalNamespace({ tenantId: "tenant-isolation-b", authenticationRealm: "demo", issuer: "issuer", subject: "same", keys });
    const execute = (tenantId: string, principal: string, tenant: string) => log.executeCommand({ tenantId, principalNamespaceId: principal, commandId: "same-command", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { tenant }, stream: "room:shared", eventType: "messageAdded", schema: "MessageAdded@1", data: { tenant }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ tenant }) });
    const tenantA = await execute("tenant-isolation-a", principalA, "a");
    const tenantB = await execute("tenant-isolation-b", principalB, "b");
    if (tenantA.status !== "completed" || tenantB.status !== "completed") throw new Error("expected completed command");
    expect(tenantA.event.sequence).toBe(1);
    expect(tenantB.event.sequence).toBe(1);
    expect(tenantA.event.cursor).not.toBe(tenantB.event.cursor);
    expect(await log.readAfter("tenant-isolation-a", "room:shared")).toEqual([tenantA.event]);
    expect(await log.readAfter("tenant-isolation-b", "room:shared")).toEqual([tenantB.event]);
    expect(await log.pendingOutbox("tenant-isolation-a")).toMatchObject([{ tenantId: "tenant-isolation-a", eventId: tenantA.event.eventId }]);
    expect(await log.pendingOutbox("tenant-isolation-b")).toMatchObject([{ tenantId: "tenant-isolation-b", eventId: tenantB.event.eventId }]);
  });

  it("uses NOTIFY only as a wake-up and converges from the event table after a missed notification", async () => {
    const notifications: Array<{ outboxId: number }> = [];
    const stopListening = await log.listen((notification) => notifications.push(notification));
    const execute = (commandId: string, text: string) => log.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId, commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text }, stream: "room:notify", eventType: "messageAdded", schema: "MessageAdded@1", data: { text }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ ok: true }) });
    const first = await execute("cmd-notified", "wake");
    if (first.status !== "completed") throw new Error("expected completed command");
    await log.publishOutbox({ limit: 10 });
    const started = Date.now();
    while (notifications.length === 0) {
      if (Date.now() - started > 2_000) throw new Error("notification timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const notifiedCount = notifications.length;
    await stopListening();

    const missed = await execute("cmd-missed-notify", "catch up from table");
    if (missed.status !== "completed") throw new Error("expected completed command");
    expect(notifications).toHaveLength(notifiedCount);
    expect(await log.readAfter("tenant-a", "room:notify", first.event.cursor)).toEqual([missed.event]);
  });

  it("surfaces a dedicated LISTEN connection failure instead of crashing or staying silently ready", async () => {
    const listenerPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1_000, application_name: "listener-failure-test", options: testSearchPath });
    const listenerLog = new PostgresEventLog(listenerPool);
    let unavailable: Error | undefined;
    const stop = await listenerLog.listen(() => undefined, (error) => { unavailable = error; });
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'listener-failure-test' AND pid <> pg_backend_pid()");
    const started = Date.now();
    while (!unavailable) {
      if (Date.now() - started > 2_000) throw new Error("LISTEN failure was not surfaced");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(unavailable).toBeInstanceOf(Error);
    await stop().catch(() => undefined);
    await listenerPool.end();
  });

  it("keeps startup unready and rejects sessions until the transactional outbox path succeeds", async () => {
    const gateway = new PostgresGatewayServer({
      pool,
      port: 0,
      originPolicy: nodeOriginPolicy,
      runtimeId: "outbox-startup-failure",
      contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      identityKeys: [{ version: 1, key: "startup-test-key" }],
      authenticate: () => ({ tenantId: "tenant-startup", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: ["room:42:read"] }),
      publishOutbox: async () => { throw new Error("injected startup outbox failure"); }
    });
    try {
      await gateway.start();
      expect(gateway.ready).toBe(false);
      const health = await fetch(`${gateway.httpUrl}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({ status: "unready" });
      const upgradeStatus = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("unready gateway did not reject the upgrade")), 2_000);
        const socket = connectTcp(gateway.port, gateway.host, () => socket.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdC1rZXk=\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: better-realtime.v1\r\n\r\n"));
        socket.once("data", (data) => { clearTimeout(timeout); const status = Number(String(data).split(" ")[1]); socket.destroy(); resolve(status); });
        socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
      });
      expect(upgradeStatus).toBe(503);
      expect(gateway.recorder.records().some((record) => record.boundary === "gateway.ready" && record.outcome === "failure" && record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(true);
    } finally { await gateway.dispose(); }
  });

  it("keeps the test control plane disabled unless the harness explicitly enables it", async () => {
    const inherited = Object.create({ enableTestControlPlane: true }) as Record<string, unknown>;
    Object.assign(inherited, { pool, port: 0, originPolicy: nodeOriginPolicy, runtimeId: "control-plane-default-off", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, identityKeys: [{ version: 1, key: "control-plane-default-off-key-32-bytes" }], authenticate: () => ({ tenantId: "tenant-control", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }) });
    const gateway = new PostgresGatewayServer(inherited as never);
    try {
      await gateway.start();
      for (const path of ["/api/inspect", "/internal/evidence", "/internal/chaos/drain"]) {
        const response = await fetch(`${gateway.httpUrl}${path}`, { method: path.endsWith("drain") ? "POST" : "GET" });
        expect(response.status).toBe(404);
      }
      expect(gateway.ready).toBe(true);
      const health = await fetch(`${gateway.httpUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ready" });
    } finally { await gateway.dispose(); }
  });

  it("force-closes a non-cooperating WebSocket at the configured drain deadline", async () => {
    const gateway = new PostgresGatewayServer({
      pool,
      port: 0,
      originPolicy: nodeOriginPolicy,
      runtimeId: "hard-drain-deadline",
      contract: storageContract,
      identityKeys: keys,
      drainTimeoutMs: 25,
      enableTestControlPlane: true,
      authenticate: () => ({ tenantId: "tenant-hard-drain", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] })
    });
    let socket: WebSocketClient | undefined;
    try {
      await gateway.start();
      socket = new WebSocketClient(gateway.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_hard_drain", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_hard_drain", contract: storageContract, auth: {} }));
      await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      (socket as WebSocketClient & { _socket: { pause(): void } })._socket.pause();
      gateway.gracefulDrain("hard_deadline_test");
      let inspect: { runtimeId: string; runtimeBootId: string; resources: { sockets: number; timers: number } } | undefined;
      const deadline = Date.now() + 1_000;
      while (!inspect || inspect.resources.sockets !== 0 || inspect.resources.timers !== 4) {
        if (Date.now() >= deadline) throw new Error("drain deadline did not release the non-cooperating socket");
        await new Promise((resolve) => setTimeout(resolve, 10));
        inspect = await fetch(`${gateway.httpUrl}/api/inspect`).then((response) => response.json()) as typeof inspect;
      }
      expect(inspect).toMatchObject({ runtimeId: "hard-drain-deadline", runtimeBootId: expect.stringMatching(/^boot_/u) });
      expect(inspect.resources).toMatchObject({ sockets: 0, timers: 4 });
    } finally {
      (socket as (WebSocketClient & { _socket?: { resume(): void } }) | undefined)?._socket?.resume();
      socket?.terminate();
      await gateway.dispose();
    }
  });

  it("enforces connection, subscription, and inbound queue limits with bounded cleanup", async () => {
    const base = { pool, port: 0, originPolicy: nodeOriginPolicy, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } as const, identityKeys: [{ version: 1, key: "gateway-resource-limit-key-at-least-32-bytes" }], authenticate: () => ({ tenantId: "tenant-resource-limit", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: ["room:42:read"] }) };
    const capacity = new PostgresGatewayServer({ ...base, runtimeId: "connection-capacity", maxClients: 1, maxSubscriptionsPerClient: 1 });
    let first: WebSocket | undefined;
    let second: WebSocketClient | undefined;
    try {
      await capacity.start();
      first = new WebSocket(capacity.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { first!.addEventListener("open", () => resolve(), { once: true }); first!.addEventListener("error", () => reject(new Error("first websocket open failed")), { once: true }); });
      second = new WebSocketClient(capacity.webSocketUrl, "better-realtime.v1");
      const secondStatus = new Promise<number>((resolve, reject) => {
        second!.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
        second!.once("open", () => reject(new Error("capacity-rejected websocket unexpectedly opened")));
        second!.once("error", () => undefined);
      });
      expect(await secondStatus).toBe(503);
      expect(capacity.recorder.records().some((record) => record.boundary === "connection.rejected" && record.reasonCode === "RT_RESOURCE_LIMIT_EXCEEDED")).toBe(true);
      const messages: Array<Record<string, unknown>> = [];
      first.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      first.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_resource_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_resource", contract: base.contract, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      first.send(JSON.stringify({ protocol: "1.0", kind: "stream.subscribe", messageId: "msg_resource_sub_1", sentAt: new Date().toISOString(), requestId: "req_resource_sub_1", sessionGeneration: ready.sessionGeneration, stream: "room:42", input: { roomId: "42" } }));
      await waitForWireMessage(messages, (message) => message.kind === "stream.replay.complete");
      first.send(JSON.stringify({ protocol: "1.0", kind: "stream.subscribe", messageId: "msg_resource_sub_2", sentAt: new Date().toISOString(), requestId: "req_resource_sub_2", sessionGeneration: ready.sessionGeneration, stream: "room:42", input: { roomId: "42" } }));
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { stream?: string } | undefined)?.stream === "room:42");
      expect(capacity.recorder.records().some((record) => record.boundary === "subscription.rejected" && record.reasonCode === "RT_RESOURCE_LIMIT_EXCEEDED")).toBe(true);
    } finally { first?.close(); second?.close(); await capacity.dispose(); }

    let releaseAuthentication!: () => void;
    const authentication = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
    const inbound = new PostgresGatewayServer({ ...base, runtimeId: "inbound-capacity", maxClients: 1, maxInboundQueueMessages: 1, authenticate: async () => { await authentication; return base.authenticate(); } });
    let socket: WebSocket | undefined;
    let churn: WebSocketClient | undefined;
    try {
      await inbound.start();
      socket = new WebSocket(inbound.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("inbound websocket open failed")), { once: true }); });
      const closed = new Promise<number>((resolve) => socket!.addEventListener("close", (event) => resolve(event.code), { once: true }));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_inbound_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_inbound", contract: base.contract, auth: {} }));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "heartbeat.pong", messageId: "msg_inbound_extra", sentAt: new Date().toISOString(), pingId: "ping-extra" }));
      expect(await closed).toBe(1009);
      expect(inbound.recorder.records().some((record) => record.boundary === "message.rejected" && record.reasonCode === "RT_RESOURCE_LIMIT_EXCEEDED" && record.details?.resourceType === "inbound_queue")).toBe(true);
      churn = new WebSocketClient(inbound.webSocketUrl, "better-realtime.v1");
      const churnStatus = new Promise<number>((resolve, reject) => {
        churn!.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
        churn!.once("open", () => reject(new Error("full inbound gateway unexpectedly upgraded another socket")));
        churn!.once("error", () => undefined);
      });
      expect(await churnStatus).toBe(503);
      expect(inbound.recorder.records().some((record) => record.boundary === "connection.rejected" && record.reasonCode === "RT_RESOURCE_LIMIT_EXCEEDED")).toBe(true);
    } finally { releaseAuthentication(); socket?.close(); churn?.close(); await inbound.dispose(); }

    let hookCalls = 0;
    const unresolvedAuthentication = new Promise<ReturnType<typeof base.authenticate>>(() => undefined);
    const hooks = new PostgresGatewayServer({ ...base, runtimeId: "application-hook-capacity", maxApplicationHooks: 1, transactionOptions: { operationTimeoutMs: 25 }, authenticate: () => { hookCalls += 1; return unresolvedAuthentication; } });
    try {
      await hooks.start();
      const attempt = async (suffix: string): Promise<{ closeCode: number; rejected: Record<string, unknown> }> => {
        const candidate = new WebSocket(hooks.webSocketUrl, "better-realtime.v1");
        await new Promise<void>((resolve, reject) => { candidate.addEventListener("open", () => resolve(), { once: true }); candidate.addEventListener("error", () => reject(new Error("hook-capacity websocket open failed")), { once: true }); });
        const messages: Array<Record<string, unknown>> = [];
        candidate.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
        const closed = new Promise<number>((resolve) => candidate.addEventListener("close", (event) => resolve(event.code), { once: true }));
        candidate.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: `msg_hook_${suffix}`, sentAt: new Date().toISOString(), connectionAttemptId: `attempt_hook_${suffix}`, contract: base.contract, auth: {} }));
        const rejected = await waitForWireMessage(messages, (message) => message.kind === "session.rejected");
        return { closeCode: await closed, rejected };
      };
      for (const suffix of ["first", "second"]) expect(await attempt(suffix)).toMatchObject({ closeCode: 1013, rejected: { error: { code: "RT_OPERATION_UNAVAILABLE", scope: "session", disposition: "retry", retryable: true } } });
      expect(hookCalls).toBe(1);
      expect(hooks.recorder.records().some((record) => record.boundary === "application.hook_rejected" && record.reasonCode === "RT_RESOURCE_LIMIT_EXCEEDED" && record.details?.resourceType === "application_hook")).toBe(true);
    } finally { await hooks.dispose(); }

    let mutationCalls = 0;
    const mutations = new PostgresGatewayServer({
      ...base,
      runtimeId: "application-mutation-capacity",
      maxApplicationHooks: 1,
      transactionOptions: { operationTimeoutMs: 25 },
      application: {
        authorizeCommand: () => true,
        executeCommand: () => ({ stream: "room:hook", eventType: "changed", eventSchema: "changed@1", eventData: { value: "never" }, resultSchema: "changeResult@1", mutate: async () => { mutationCalls += 1; await new Promise<never>(() => undefined); return { ok: true }; } })
      }
    });
    let mutationSocket: WebSocket | undefined;
    try {
      await mutations.start();
      mutationSocket = new WebSocket(mutations.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { mutationSocket!.addEventListener("open", () => resolve(), { once: true }); mutationSocket!.addEventListener("error", () => reject(new Error("mutation-capacity websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      mutationSocket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      mutationSocket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_mutation_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_mutation", contract: base.contract, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      const send = (suffix: string) => mutationSocket!.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: `msg_mutation_${suffix}`, sentAt: new Date().toISOString(), commandAttemptId: `attempt_mutation_${suffix}`, sessionGeneration: ready.sessionGeneration, commandId: `cmd-mutation-${suffix}`, type: "change", schema: "change@1", input: {}, createdAt: new Date().toISOString() }));
      send("first");
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === "cmd-mutation-first");
      send("second");
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === "cmd-mutation-second");
      expect(mutationCalls).toBe(1);
      expect(mutations.recorder.records().some((record) => record.boundary === "application.hook_rejected" && record.details?.resourceType === "application_hook")).toBe(true);
    } finally { mutationSocket?.close(); await mutations.dispose(); }
  });

  it("fully unwinds a failed HTTP bind so the same gateway can start after the port is released", async () => {
    const port = await ephemeralPort();
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(port, "127.0.0.1", resolve); });
    const gateway = new PostgresGatewayServer({ pool, port, originPolicy: nodeOriginPolicy, runtimeId: "bind-retry", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, identityKeys: [{ version: 1, key: "bind-retry-identity-key-at-least-32-bytes" }], authenticate: () => ({ tenantId: "tenant-bind", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }) });
    try {
      await expect(gateway.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(gateway.ready).toBe(false);
      expect(gateway.recorder.records().some((record) => record.boundary === "gateway.start_failed")).toBe(true);
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await gateway.start();
      expect(gateway.ready).toBe(true);
      expect(await fetch(`${gateway.httpUrl}/health`).then((response) => response.status)).toBe(200);
    } finally {
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await gateway.dispose();
    }
  });

  it("single-flights concurrent start and fences terminal dispose", async () => {
    const lifecyclePool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 1_000, application_name: "gateway-lifecycle-test", options: testSearchPath });
    const gateway = new PostgresGatewayServer({
      pool: lifecyclePool,
      port: 0,
      originPolicy: nodeOriginPolicy,
      runtimeId: "gateway-lifecycle-test",
      contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      identityKeys: keys,
      authenticate: () => ({ tenantId: "tenant-lifecycle", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] })
    });
    try {
      const first = gateway.start();
      const second = gateway.start();
      expect(second).toBe(first);
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(gateway.ready).toBe(true);
      expect((await fetch(`${gateway.httpUrl}/health`)).status).toBe(200);
      await gateway.dispose();
      await expect(gateway.start()).rejects.toThrow("RT_SERVER_DISPOSED");
      expect(gateway.ready).toBe(false);
      await expect(fetch(`${gateway.httpUrl}/health`)).rejects.toThrow();
      expect(lifecyclePool.totalCount).toBe(lifecyclePool.idleCount);
    } finally {
      await gateway.dispose();
      await lifecyclePool.end();
    }
  });

  it("rejects contradictory contract IDs and versions at the PostgreSQL gateway handshake", async () => {
    const contract = { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } as const;
    const gateway = new PostgresGatewayServer({
      pool,
      port: 0,
      originPolicy: nodeOriginPolicy,
      runtimeId: "contract-identity-test",
      contract,
      identityKeys: [{ version: 1, key: "contract-identity-test-key-at-least-32-bytes" }],
      authenticate: () => ({ tenantId: "tenant-contract", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] })
    });
    try {
      await gateway.start();
      for (const candidate of [{ ...contract, contractId: "different.contract" }, { ...contract, manifestVersion: "2.0.0" }]) {
        const socket = new WebSocket(gateway.webSocketUrl, "better-realtime.v1");
        const messages: Array<Record<string, unknown>> = [];
        socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
        await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
        socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: `msg_contract_${crypto.randomUUID()}`, sentAt: new Date().toISOString(), connectionAttemptId: `attempt_contract_${crypto.randomUUID()}`, contract: candidate, auth: {} }));
        expect(await waitForWireMessage(messages, (message) => message.kind === "session.rejected")).toMatchObject({ error: { code: "RT_CONTRACT_INCOMPATIBLE" } });
        socket.close();
      }
    } finally { await gateway.dispose(); }
  });

  it("removes LISTEN outage callbacks before returning the dedicated client to its pool", async () => {
    const listenerPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1_000, application_name: "listener-dispose-test", options: testSearchPath });
    const listenerLog = new PostgresEventLog(listenerPool);
    let unavailableCalls = 0;
    const stop = await listenerLog.listen(() => undefined, () => { unavailableCalls += 1; });
    await stop();
    await listenerPool.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unavailableCalls).toBe(0);
  });

  it("converges simultaneous first authentication on one durable namespace", async () => {
    const request = { tenantId: "tenant-first-race", authenticationRealm: "oidc", issuer: "https://issuer.example", subject: "first-shared-subject", keys };
    const namespaces = await Promise.all(Array.from({ length: 20 }, () => log.resolvePrincipalNamespace(request)));
    expect(new Set(namespaces)).toEqual(new Set([namespaces[0]]));
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_principal_namespaces WHERE tenant_id = 'tenant-first-race'")).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_principal_identity_aliases WHERE tenant_id = 'tenant-first-race'")).rows[0]?.count).toBe(keys.length);
    expect(log.recorder.records().some((record) => record.boundary === "principal.alias_upserted" && record.outcome === "success")).toBe(true);
    expect(log.recorder.records().some((record) => record.boundary === "security.identity_redacted" && record.details?.rawIssuerCaptured === false && record.details.rawSubjectCaptured === false)).toBe(true);
  });

  it("converges fresh overlapping first-auth keysets across gateway stores", async () => {
    const gatewayA = new PostgresEventLog(pool);
    const gatewayB = new PostgresEventLog(pool);
    const currentOnly = [keys[1]!];
    for (let index = 0; index < 20; index += 1) {
      const request = { tenantId: `tenant-overlap-first-${index}`, authenticationRealm: "oidc", issuer: "https://issuer.example", subject: "fresh-overlap" };
      const [rotating, current] = await Promise.all([
        gatewayA.resolvePrincipalNamespace({ ...request, keys }),
        gatewayB.resolvePrincipalNamespace({ ...request, keys: currentOnly })
      ]);
      expect(rotating).toBe(current);
      expect((await pool.query<{ count: number }>("SELECT count(DISTINCT principal_namespace_id)::int AS count FROM realtime_principal_identity_aliases WHERE tenant_id = $1", [request.tenantId])).rows[0]?.count).toBe(1);
    }
  });

  it("converges overlapping old/current key rotation on the existing durable namespace", async () => {
    const identityRequest = { tenantId: "tenant-race", authenticationRealm: "oidc", issuer: "https://issuer.example", subject: "shared-subject" };
    const firstNamespace = await log.resolvePrincipalNamespace({ ...identityRequest, keys: [keys[0]!] });
    const namespaces = await Promise.all(Array.from({ length: 20 }, () => log.resolvePrincipalNamespace({ ...identityRequest, keys })));
    expect(new Set([firstNamespace, ...namespaces])).toEqual(new Set([firstNamespace]));
    expect(new Set(namespaces)).toEqual(new Set([namespaces[0]]));
    const rows = await pool.query("SELECT DISTINCT principal_namespace_id FROM realtime_principal_identity_aliases WHERE tenant_id = 'tenant-race'");
    expect(rows.rows).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_principal_identity_aliases WHERE tenant_id = 'tenant-race'")).rows[0]?.count).toBe(keys.length);
  });

  it("keeps command status non-enumerating across principals in the same tenant", async () => {
    const otherPrincipalNamespaceId = await log.resolvePrincipalNamespace({ ...identity, subject: "user-2", keys });
    expect(await log.commandStatus("tenant-a", otherPrincipalNamespaceId, "cmd-stable")).toEqual({ state: "unknown" });
    expect(log.recorder.records().some((record) => record.boundary === "command.outcome_unknown" && record.commandId === "cmd-stable")).toBe(true);
    expect(await log.commandExistsForOtherPrincipal("tenant-a", otherPrincipalNamespaceId, "cmd-stable")).toBe(true);
    const independent = await log.executeCommand({ tenantId: "tenant-a", principalNamespaceId: otherPrincipalNamespaceId, commandId: "cmd-stable", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "other principal" }, stream: "room:principal", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "other principal" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ ok: true }) });
    expect(independent).toMatchObject({ status: "completed", duplicate: false });
  });

  it("uses a versioned language-neutral canonical intent and rejects command ID reuse with a different intent", async () => {
    expect(canonicalCommandIntent({ type: "sendMessage", schema: "sendMessage@1", input: { roomId: "42", nested: { a: 1, b: 2 } } })).toEqual(
      canonicalCommandIntent({ type: "sendMessage", schema: "sendMessage@1", input: { nested: { b: 2, a: 1 }, roomId: "42" } })
    );
    const base = { tenantId: "tenant-a", principalNamespaceId, commandId: "cmd-intent", commandType: "sendMessage", commandSchema: "sendMessage@1", stream: "room:intent", eventType: "messageAdded", schema: "MessageAdded@1", commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ ok: true }) } as const;
    await log.executeCommand({ ...base, commandInput: { roomId: "42", text: "same" }, data: { text: "same" } });
    await expect(log.executeCommand({ ...base, commandInput: { text: "different", roomId: "42" }, data: { text: "different" } })).rejects.toThrow("RT_COMMAND_INTENT_CONFLICT");
    expect(log.recorder.records().some((record) => record.boundary === "command.intent_compared" && record.commandId === "cmd-intent" && record.outcome === "failure" && record.reasonCode === "RT_COMMAND_INTENT_CONFLICT")).toBe(true);
    expect((await log.readAfter("tenant-a", "room:intent")).length).toBe(1);
    expect(() => canonicalCommandIntent({ type: "sendMessage", schema: "sendMessage@1", input: { text: "\ud800" } })).toThrow("RT_CANONICAL_JSON_INVALID_UNICODE");
  });

  it("retains a valid JSON null command result until result expiry", async () => {
    const execute = () => log.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId: "cmd-null-result", commandType: "nullable", commandSchema: "nullable@1", commandInput: { value: null }, stream: "room:null-result", eventType: "nullResult", schema: "NullResult@1", data: null, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => null });
    const first = await execute();
    const duplicate = await execute();
    expect(first).toMatchObject({ status: "completed", duplicate: false, result: null });
    expect(duplicate).toMatchObject({ status: "completed", duplicate: true, result: null });
    expect(await log.commandStatus("tenant-a", principalNamespaceId, "cmd-null-result")).toMatchObject({ state: "completed", result: null });
  });

  it("retains an idempotency tombstone after result expiry and becomes unknown after idempotency expiry", async () => {
    const completed = await log.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId: "cmd-retention", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "bounded" }, stream: "room:retention", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "bounded" }, commandResultRetentionMs: 10_000, idempotencyRetentionMs: 20_000, mutate: async () => ({ ok: true }) });
    expect(completed.status).toBe("completed");
    await pool.query("UPDATE realtime_commands SET result_expires_at = clock_timestamp() - interval '1 second' WHERE tenant_id = 'tenant-a' AND principal_namespace_id = $1 AND command_id = 'cmd-retention'", [principalNamespaceId]);
    await log.cleanupCommandRetention();
    expect(await log.commandStatus("tenant-a", principalNamespaceId, "cmd-retention")).toMatchObject({ state: "expired" });
    const retry = await log.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId: "cmd-retention", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "bounded" }, stream: "room:retention", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "bounded" }, commandResultRetentionMs: 10_000, idempotencyRetentionMs: 20_000, mutate: async () => { throw new Error("must not rerun"); } });
    expect(retry).toMatchObject({ status: "expired", duplicate: true });
    await pool.query("UPDATE realtime_commands SET idempotency_expires_at = clock_timestamp() - interval '1 second' WHERE tenant_id = 'tenant-a' AND principal_namespace_id = $1 AND command_id = 'cmd-retention'", [principalNamespaceId]);
    await log.cleanupCommandRetention();
    expect(await log.commandStatus("tenant-a", principalNamespaceId, "cmd-retention")).toEqual({ state: "unknown" });
  });

  it("keeps retained command and append retries valid after published wake rows are cleaned", async () => {
    const tenantId = "tenant-wake-cleanup-retry";
    const principal = await log.resolvePrincipalNamespace({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", keys });
    let commandEffects = 0;
    const command = () => log.executeCommand({ tenantId, principalNamespaceId: principal, commandId: "cmd-after-wake-cleanup", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "once" }, stream: "room:wake-cleanup", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "once" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => { commandEffects += 1; return { ok: true }; } });
    const firstCommand = await command();
    const firstAppend = await log.appendEvent({ appendId: "append-after-wake-cleanup", tenantId, stream: "room:wake-cleanup", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "append once" }, effectSchema: "none@1", effect: null });
    await log.publishOutbox({ limit: 1_000 });
    await pool.query("UPDATE realtime_outbox SET notify_committed_at = clock_timestamp() - interval '10 seconds' WHERE tenant_id = $1", [tenantId]);
    expect(await log.cleanupPublishedOutbox(1_000)).toBeGreaterThanOrEqual(2);
    const duplicateCommand = await command();
    const duplicateAppend = await log.appendEvent({ appendId: "append-after-wake-cleanup", tenantId, stream: "room:wake-cleanup", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "append once" }, effectSchema: "none@1", effect: null });
    expect(duplicateCommand).toMatchObject({ status: "completed", duplicate: true });
    expect(commandEffects).toBe(1);
    expect(firstCommand.status === "completed" && duplicateCommand.status === "completed" ? duplicateCommand.event.eventId : "").toBe(firstCommand.status === "completed" ? firstCommand.event.eventId : "");
    expect(duplicateAppend.eventId).toBe(firstAppend.eventId);
  });

  it("uses versioned canonical tuples for delimiter-safe operation correlation", async () => {
    const first = await log.appendEvent({ appendId: "c", tenantId: "a:b", stream: "room:correlation", eventType: "messageAdded", schema: "MessageAdded@1", data: { source: 1 }, effectSchema: "none@1", effect: null });
    const second = await log.appendEvent({ appendId: "b:c", tenantId: "a", stream: "room:correlation", eventType: "messageAdded", schema: "MessageAdded@1", data: { source: 2 }, effectSchema: "none@1", effect: null });
    const firstRecord = log.recorder.records().find((record) => record.boundary === "db.committed" && record.eventId === first.eventId);
    const secondRecord = log.recorder.records().find((record) => record.boundary === "db.committed" && record.eventId === second.eventId);
    expect(firstRecord?.operationCorrelationId).toMatch(/^opcorr:sha256:[a-f0-9]{64}$/);
    expect(firstRecord?.operationCorrelationId).not.toBe(secondRecord?.operationCorrelationId);
  });

  it("routes migration and maintenance writes through exact attempt reconciliation", async () => {
    const seedPrincipal = await log.resolvePrincipalNamespace({ tenantId: "tenant-maintenance-ack", authenticationRealm: "test", issuer: "issuer", subject: "subject", keys });
    await log.executeCommand({ tenantId: "tenant-maintenance-ack", principalNamespaceId: seedPrincipal, commandId: "cmd-maintenance-ack", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "expire" }, stream: "room:maintenance-ack", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "expire" }, commandResultRetentionMs: 1, idempotencyRetentionMs: 2, mutate: async () => ({ ok: true }) });
    await log.publishOutbox({ limit: 1_000 });
    await pool.query("UPDATE realtime_outbox SET notify_committed_at = clock_timestamp() - interval '10 seconds' WHERE tenant_id = 'tenant-maintenance-ack'");
    await pool.query("INSERT INTO realtime_transaction_attempts (transaction_id, operation, marker_written_at) VALUES ('tx_expired_test_marker','command',clock_timestamp() - interval '10 minutes')");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const targets = new Set(["schema_migration", "command_retention_cleanup", "outbox_retention_cleanup", "stream_retention"]);
    const ambiguous = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      await client.query("COMMIT");
      if (targets.delete(context.operation)) throw new Error("Connection terminated unexpectedly");
    } });
    await ambiguous.migrate(storageContract);
    expect(await ambiguous.cleanupCommandRetention(10)).toMatchObject({ resultsCleared: expect.any(Number), tombstonesDeleted: expect.any(Number) });
    expect((await pool.query("SELECT 1 FROM realtime_transaction_attempts WHERE transaction_id = 'tx_expired_test_marker'")).rowCount).toBe(0);
    expect(await ambiguous.cleanupPublishedOutbox(1_000, 10)).toEqual(expect.any(Number));
    await ambiguous.expireBeforeCurrentHead("tenant-maintenance-ack", "room:maintenance-ack");
    expect(targets.size).toBe(0);
    for (const operation of ["schema_migration", "command_retention_cleanup", "outbox_retention_cleanup", "stream_retention"] as const) {
      const unknown = ambiguous.recorder.records().find((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.transactionOperation === operation);
      expect(unknown, operation).toBeDefined();
      expect(ambiguous.recorder.records().some((record) => record.boundary === "database.transaction_reconciled" && record.transactionId === unknown?.transactionId && record.details?.resolution === "committed" && record.details.proofSource === "durable_transaction_attempt_marker")).toBe(true);
    }
  });

  it("rolls back notify and marker together at every pre-commit outbox crash point", async () => {
    const created = await log.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId: "cmd-outbox-crash", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "outbox" }, stream: "room:outbox", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "outbox" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ ok: true }) });
    if (created.status !== "completed") throw new Error("expected completed command");
    for (const crashPoint of ["after_claim", "after_notify", "after_mark"] as const) {
      await expect(log.publishOutbox({ limit: 1, crashPoint })).rejects.toThrow(`INJECTED_OUTBOX_${crashPoint.toUpperCase()}`);
      expect((await pool.query("SELECT notify_committed_at FROM realtime_outbox WHERE event_id = $1", [created.event.eventId])).rows[0]?.notify_committed_at).toBeNull();
    }
    expect(await log.publishOutbox({ limit: 100 })).toBeGreaterThan(0);
    expect(log.recorder.records().some((record) => record.boundary === "outbox.claimed" && record.eventId === created.event.eventId)).toBe(true);
    expect((await pool.query("SELECT notify_committed_at FROM realtime_outbox WHERE event_id = $1", [created.event.eventId])).rows[0]?.notify_committed_at).toBeInstanceOf(Date);
    await pool.query("UPDATE realtime_outbox SET notify_committed_at = clock_timestamp() - interval '10 seconds' WHERE event_id = $1", [created.event.eventId]);
    expect(await log.cleanupPublishedOutbox(1_000)).toBeGreaterThan(0);
  });

  it("rejects a projection row whose sequence and event ID refer to different events", async () => {
    const first = await log.appendEvent({ appendId: "append-fk-first", tenantId: "tenant-a", stream: "room:fk", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "first" }, effectSchema: "none@1", effect: null });
    const second = await log.appendEvent({ appendId: "append-fk-second", tenantId: "tenant-a", stream: "room:fk", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "second" }, effectSchema: "none@1", effect: null });
    await expect(pool.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["tenant-a", "room:fk", first.sequence, second.eventId, "Mismatch", "must fail", new Date()])).rejects.toThrow();
  });

  it("returns an atomic snapshot cursor S and a later head H for fenced catch-up", async () => {
    let concurrentEventId: string | undefined;
    const snapshot = await log.atomicSnapshot("tenant-a", "room:42", async () => {
      const concurrent = await log.appendEvent({ appendId: "append-snapshot-concurrent", tenantId: "tenant-a", stream: "room:42", eventType: "messageAdded", schema: "MessageAdded@1", data: { author: "Concurrent", text: "after S before H", sentAt: "2026-07-18T00:00:01.000Z" }, effectSchema: "roomMessageInsert@1", effect: { author: "Concurrent", text: "after S before H" }, mutate: async (database, sequence, eventId) => {
        await database.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["tenant-a", "room:42", sequence, eventId, "Concurrent", "after S before H", "2026-07-18T00:00:01.000Z"]);
      } });
      concurrentEventId = concurrent.eventId;
    });
    expect(snapshot.state.sequence).toBeGreaterThanOrEqual(1);
    expect(snapshot.cursor).toBeTruthy();
    expect(snapshot.head).toBeTruthy();
    expect(snapshot.headSequence).toBe(snapshot.cursorSequence + 1);
    expect(snapshot.state.messages.some((message) => (message as { text?: string }).text === "after S before H")).toBe(false);
    expect((await log.readAfter("tenant-a", "room:42", snapshot.cursor)).filter((event) => event.sequence <= snapshot.headSequence)).toMatchObject([{ eventId: concurrentEventId }]);
  });

  it("runs an application snapshot provider inside the fenced repeatable-read transaction", async () => {
    const snapshot = await log.atomicSnapshotWith("tenant-a", "room:42", async (database, context) => {
      const isolation = await database.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
      const readOnly = await database.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
      const visible = await database.query<{ count: string }>("SELECT count(*) FROM realtime_events WHERE tenant_id = $1 AND stream = $2 AND sequence <= $3", [context.tenantId, context.stream, context.includedSequence]);
      return { includedSequence: context.includedSequence, visibleEvents: Number(visible.rows[0]!.count), isolation: isolation.rows[0]!.transaction_isolation, readOnly: readOnly.rows[0]!.transaction_read_only };
    });
    expect(snapshot.state).toMatchObject({ includedSequence: snapshot.cursorSequence, visibleEvents: snapshot.cursorSequence, isolation: "repeatable read", readOnly: "on" });
    expect(snapshot.headSequence).toBeGreaterThanOrEqual(snapshot.cursorSequence);
  });

  it("bounds a post-commit snapshot head stall without claiming snapshot success", async () => {
    const boundedPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 1_000, options: testSearchPath });
    let connections = 0;
    const stalledPool = new Proxy(boundedPool, { get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await target.connect();
        connections += 1;
        if (connections < 2) return client;
        return new Proxy(client, { get(clientTarget, clientProperty, clientReceiver) {
          if (clientProperty === "query") return (text: string, values?: unknown[]) => text.startsWith("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM") && text.includes("realtime_events") ? new Promise<never>(() => undefined) : clientTarget.query(text, values);
          const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(clientTarget) : value;
        } }) as PoolClient;
      };
    } }) as Pool;
    try {
      await prewarmPool(boundedPool, 2);
      boundedPool.options.connectionTimeoutMillis = 40;
      const bounded = new PostgresEventLog(stalledPool, undefined, { reconciliationTimeoutMs: 40 });
      const started = Date.now();
      await expect(bounded.atomicSnapshot("tenant-a", "room:42")).rejects.toThrow("RT_SNAPSHOT_FENCE_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(500);
      expect(bounded.recorder.records().some((record) => record.boundary === "snapshot.created")).toBe(false);
    } finally {
      await boundedPool.end();
    }
  });

  it("returns committed snapshot connections before concurrent fence-head reads", async () => {
    const poolSize = 4;
    const participantCount = 20;
    const snapshotPool = new Pool({ connectionString: databaseUrl, max: poolSize, connectionTimeoutMillis: 1_000, application_name: "snapshot-release-invariant", options: testSearchPath });
    const snapshotLog = new PostgresEventLog(snapshotPool, undefined, { reconciliationTimeoutMs: 5_000 });
    try {
      await prewarmPool(snapshotPool, poolSize);
      expect(snapshotPool.totalCount).toBe(poolSize);
      expect(snapshotPool.idleCount).toBe(poolSize);

      let reachedFence = 0;
      let resolveAllReached!: () => void;
      let releaseFence!: () => void;
      const allReached = new Promise<void>((resolve) => { resolveAllReached = resolve; });
      const fence = new Promise<void>((resolve) => { releaseFence = resolve; });
      const snapshotsPromise = Promise.all(Array.from({ length: participantCount }, () => snapshotLog.atomicSnapshot("tenant-a", "room:42", async () => {
        reachedFence += 1;
        if (reachedFence === participantCount) resolveAllReached();
        await fence;
      })));
      const snapshotOutcome = snapshotsPromise.then(
        (snapshots) => ({ kind: "completed" as const, snapshots }),
        (error: unknown) => ({ kind: "failed" as const, error })
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const first = await Promise.race([
          allReached.then(() => ({ kind: "fence" as const })),
          snapshotOutcome,
          new Promise<{ kind: "timeout" }>((resolve) => { timeout = setTimeout(() => resolve({ kind: "timeout" }), 5_000); })
        ]);
        if (first.kind === "failed") throw first.error;
        expect(first.kind).toBe("fence");
        expect(reachedFence).toBe(participantCount);
        expect(snapshotPool.totalCount).toBe(poolSize);
        expect(snapshotPool.idleCount).toBe(poolSize);
        expect(snapshotPool.waitingCount).toBe(0);
      } finally {
        if (timeout) clearTimeout(timeout);
        releaseFence();
      }
      const snapshots = await snapshotsPromise;
      expect(snapshots).toHaveLength(participantCount);
      expect(snapshots.every((snapshot) => snapshot.headSequence >= snapshot.cursorSequence)).toBe(true);
      expect(snapshotPool.totalCount).toBe(poolSize);
      expect(snapshotPool.idleCount).toBe(poolSize);
      expect(snapshotPool.waitingCount).toBe(0);
    } finally {
      await snapshotPool.end();
    }
  });

  it("reconciles a committed command when the underlying COMMIT succeeds but its acknowledgement is lost", async () => {
    let injected = false;
    let effects = 0;
    const ambiguous = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      await client.query("COMMIT");
      if (context.operation === "command" && !injected) { injected = true; throw new Error("Connection terminated unexpectedly"); }
    } });
    const execution = await ambiguous.executeCommand({ tenantId: "tenant-ack-command", principalNamespaceId: await ambiguous.resolvePrincipalNamespace({ tenantId: "tenant-ack-command", authenticationRealm: "test", issuer: "issuer", subject: "subject", keys }), commandId: "cmd-ack-loss", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "once" }, stream: "room:ack-command", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "once" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => { effects += 1; return { ok: true }; } });
    expect(execution).toMatchObject({ status: "completed", duplicate: false, result: { ok: true } });
    expect(effects).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = 'tenant-ack-command' AND command_id = 'cmd-ack-loss'")).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_outbox WHERE tenant_id = 'tenant-ack-command'")).rows[0]?.count).toBe(1);
    const records = ambiguous.recorder.records().filter((record) => record.commandId === "cmd-ack-loss");
    expect(records.some((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.outcome === "unknown")).toBe(true);
    expect(records.some((record) => record.boundary === "database.transaction_reconciled" && record.details?.resolution === "committed" && record.details.proofSource === "durable_transaction_attempt_marker")).toBe(true);
    expect(records.some((record) => record.boundary === "db.committed" && record.details?.proofSource === "durable_transaction_attempt_marker")).toBe(true);
    expect(records.some((record) => record.boundary === "db.rolled_back")).toBe(false);
  });

  it("keeps a timed-out serialized reconciliation indeterminate and prevents doctor proof", async () => {
    const reconciliationPool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 1_000, options: testSearchPath });
    let blocker: PoolClient | undefined;
    let blocked = false;
    const commandId = "cmd-reconcile-timeout";
    try {
      blocker = await pool.connect();
      await prewarmPool(reconciliationPool, 4);
      reconciliationPool.options.connectionTimeoutMillis = 25;
      const ambiguous = new PostgresEventLog(reconciliationPool, undefined, { reconciliationTimeoutMs: 25, commit: async (client, context) => {
        await client.query("COMMIT");
        if (context.operation === "command" && !blocked) {
          blocked = true;
          await blocker!.query("BEGIN");
          await blocker!.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`schema:better_realtime:command:tenant-a:${principalNamespaceId}:${commandId}`]);
          throw new Error("Connection terminated unexpectedly");
        }
      } });
      await expect(ambiguous.executeCommand({ tenantId: "tenant-a", principalNamespaceId, commandId, commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "timeout" }, stream: "room:reconcile-timeout", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "timeout" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ ok: true }) })).rejects.toMatchObject({ code: "RT_TRANSACTION_OUTCOME_INDETERMINATE", state: "indeterminate" });
      const durable = await pool.query<{ event_id: string }>("SELECT event_id FROM realtime_commands WHERE tenant_id = 'tenant-a' AND principal_namespace_id = $1 AND command_id = $2", [principalNamespaceId, commandId]);
      expect(durable.rowCount).toBe(1);
      const eventId = durable.rows[0]!.event_id;
      const records = ambiguous.recorder.records();
      expect(records.some((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.commandId === commandId)).toBe(true);
      expect(records.some((record) => record.boundary === "database.transaction_reconciliation_unresolved" && record.commandId === commandId)).toBe(true);
      expect(records.some((record) => record.boundary === "database.transaction_reconciled" && record.commandId === commandId)).toBe(false);
      expect(records.some((record) => record.boundary === "db.committed" && record.commandId === commandId)).toBe(false);
      const report = doctor({ records, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId, eventId }, expectedOutcome: "command commit resolved" });
      expect(report.verdict).toBe("indeterminate");
      expect(report.issues[0]?.code).toBe("RT_TRANSACTION_OUTCOME_INDETERMINATE");
    } finally {
      await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await reconciliationPool.end();
    }
  });

  it("bounds reconciliation while pool acquisition is exhausted", async () => {
    const smallPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 40, options: testSearchPath });
    let blocker: PoolClient | undefined;
    try {
      const setup = new PostgresEventLog(smallPool);
      await setup.migrate(storageContract);
      const tenantId = "tenant-pool-reconcile-timeout";
      const principal = await setup.resolvePrincipalNamespace({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", keys });
      blocker = await smallPool.connect();
      const started = Date.now();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(setup.commandStatus(tenantId, principal, `cmd-pool-timeout-${attempt}`)).rejects.toMatchObject({ code: "RT_TRANSACTION_OUTCOME_INDETERMINATE" });
        const pendingDeadline = Date.now() + 100;
        while (smallPool.waitingCount !== 0 && Date.now() < pendingDeadline) await new Promise((resolve) => setTimeout(resolve, 2));
        expect(smallPool.waitingCount).toBe(0);
      }
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(setup.recorder.records().filter((record) => record.boundary === "database.transaction_reconciliation_unresolved").length).toBeGreaterThanOrEqual(10);
    } finally {
      blocker?.release();
      await smallPool.end();
    }
  });

  it("bounds command pool acquisition and releases every late client without durable effects", async () => {
    const smallPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 40, options: testSearchPath });
    let blocker: PoolClient | undefined;
    try {
      const setup = new PostgresEventLog(smallPool, undefined, { operationTimeoutMs: 25 });
      await setup.migrate(storageContract);
      const tenantId = "tenant-command-pool-timeout";
      const principal = await setup.resolvePrincipalNamespace({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", keys });
      blocker = await smallPool.connect();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const commandId = `cmd-operation-pool-timeout-${attempt}`;
        await expect(setup.executeCommand({ tenantId, principalNamespaceId: principal, commandId, commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { attempt }, stream: "room:pool-timeout", eventType: "messageAdded", schema: "MessageAdded@1", data: { attempt }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ ok: true }) })).rejects.toMatchObject({ code: "RT_TRANSACTION_ROLLED_BACK" });
        const pendingDeadline = Date.now() + 100;
        while (smallPool.waitingCount !== 0 && Date.now() < pendingDeadline) await new Promise((resolve) => setTimeout(resolve, 2));
        expect(smallPool.waitingCount).toBe(0);
      }
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_commands WHERE tenant_id = $1", [tenantId])).rows[0]?.count).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = $1", [tenantId])).rows[0]?.count).toBe(0);
      expect(setup.recorder.records().filter((record) => record.boundary === "db.rolled_back" && record.details?.proofSource === "commit_not_invoked").length).toBe(5);
    } finally { blocker?.release(); await smallPool.end(); }
  });

  it("owns exactly one connection-error sink per shared pool client", async () => {
    const sharedPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 40, options: testSearchPath });
    try {
      await new PostgresEventLog(sharedPool).migrate(storageContract);
      const first = await sharedPool.connect();
      const baseline = first.listenerCount("error");
      first.release();
      for (let index = 0; index < 12; index += 1) await new PostgresEventLog(sharedPool).migrate(storageContract);
      const reused = await sharedPool.connect();
      expect(reused.listenerCount("error")).toBe(baseline);
      reused.release();
    } finally { await sharedPool.end(); }
  });

  it("records an authoritative deferred-COMMIT constraint abort as rolled back", async () => {
    const aborting = new PostgresEventLog(pool);
    const appendId = "append-deferred-abort";
    await expect(aborting.appendEvent({ appendId, tenantId: "tenant-deferred-abort", stream: "room:abort", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "abort" }, effectSchema: "deferredViolation@1", effect: { sequence: "mismatched" }, mutate: async (client, sequence) => {
      await client.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["tenant-deferred-abort", "room:abort", sequence, "evt_missing", "test", "abort", new Date()]);
    } })).rejects.toMatchObject({ code: "RT_TRANSACTION_ROLLED_BACK", originalError: { code: "23503" } });
    expect((await pool.query("SELECT 1 FROM realtime_events WHERE tenant_id = 'tenant-deferred-abort'")).rowCount).toBe(0);
    expect(aborting.recorder.records().some((record) => record.boundary === "db.rolled_back" && record.details?.proofSource === "postgres_error_response" && record.details.sqlstate === "23503")).toBe(true);
    expect(aborting.recorder.records().some((record) => record.boundary === "database.transaction_outcome_indeterminate")).toBe(false);
    const retried = await aborting.appendEvent({ appendId, tenantId: "tenant-deferred-abort", stream: "room:abort", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "abort" }, effectSchema: "none@1", effect: null });
    expect(retried.appendId).toBe(appendId);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = 'tenant-deferred-abort' AND append_operation_id = $1", [appendId])).rows[0]?.count).toBe(1);
  });

  it("reconciles an outbox COMMIT acknowledgement loss from the durable marker without claiming listener delivery", async () => {
    await pool.query("UPDATE realtime_outbox SET notify_committed_at = COALESCE(notify_committed_at, clock_timestamp())");
    const event = await log.appendEvent({ appendId: "append-outbox-ack-source", tenantId: "tenant-outbox-ack", stream: "room:outbox-ack", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "wake" }, effectSchema: "none@1", effect: null });
    let injected = false;
    const ambiguous = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      await client.query("COMMIT");
      if (context.operation === "outbox_publish" && !injected) { injected = true; throw new Error("Connection terminated unexpectedly"); }
    } });
    expect(await ambiguous.publishOutbox({ limit: 1 })).toBe(1);
    expect((await pool.query("SELECT notify_committed_at FROM realtime_outbox WHERE tenant_id = 'tenant-outbox-ack' AND event_id = $1", [event.eventId])).rows[0]?.notify_committed_at).toBeInstanceOf(Date);
    const records = ambiguous.recorder.records().filter((record) => record.eventId === event.eventId || record.boundary === "database.transaction_outcome_indeterminate");
    expect(records.some((record) => record.boundary === "database.transaction_reconciled" && record.details?.resolution === "committed")).toBe(true);
    expect(records.some((record) => record.boundary === "outbox.notify_committed" && record.details?.listenerDeliveryClaimed === false && record.details.proofSource === "durable_transaction_attempt_marker")).toBe(true);
    expect(records.some((record) => record.boundary === "outbox.publish_rolled_back")).toBe(false);
  });

  it("makes append retry safe through a stable append identity after COMMIT acknowledgement loss", async () => {
    let injected = false;
    let effects = 0;
    const ambiguous = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      await client.query("COMMIT");
      if (context.operation === "append_event" && !injected) { injected = true; throw new Error("Connection terminated unexpectedly"); }
    } });
    const append = () => ambiguous.appendEvent({ appendId: "append-stable-ack-loss", tenantId: "tenant-append-ack", stream: "room:append-ack", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "once" }, effectSchema: "counterIncrement@1", effect: { amount: 1 }, mutate: async () => { effects += 1; } });
    const first = await append();
    const retry = await append();
    expect(retry.eventId).toBe(first.eventId);
    expect(effects).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = 'tenant-append-ack' AND append_operation_id = 'append-stable-ack-loss'")).rows[0]?.count).toBe(1);
    await expect(ambiguous.appendEvent({ appendId: "append-stable-ack-loss", tenantId: "tenant-append-ack", stream: "room:append-ack", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "different" }, effectSchema: "counterIncrement@1", effect: { amount: 1 } })).rejects.toThrow("RT_APPEND_INTENT_CONFLICT");
    await expect(ambiguous.appendEvent({ appendId: "append-stable-ack-loss", tenantId: "tenant-append-ack", stream: "room:append-ack", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "once" }, effectSchema: "counterIncrement@2", effect: { amount: 2 } })).rejects.toThrow("RT_APPEND_INTENT_CONFLICT");
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = 'tenant-append-ack' AND append_operation_id = 'append-stable-ack-loss'")).rows[0]?.count).toBe(1);
  });

  it("refreshes the exact attempt proof immediately before bounded COMMIT", async () => {
    let markerAgeMs = Number.POSITIVE_INFINITY;
    const ambiguous = new PostgresEventLog(pool, undefined, { commitTimeoutMs: 100, commit: async (client, context) => {
      if (context.operation === "append_event") {
        const marker = await client.query<{ marker_written_at: Date }>("SELECT marker_written_at FROM realtime_transaction_attempts WHERE transaction_id = $1", [context.transactionId]);
        markerAgeMs = Date.now() - marker.rows[0]!.marker_written_at.getTime();
      }
      await client.query("COMMIT");
      if (context.operation === "append_event") throw new Error("Connection terminated unexpectedly");
    } });
    const event = await ambiguous.appendEvent({ appendId: "append-marker-refresh", tenantId: "tenant-marker-refresh", stream: "room:marker-refresh", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "fresh proof" }, effectSchema: "backdateMarker@1", effect: { testOnly: true }, mutate: async (client) => {
      await client.query("UPDATE realtime_transaction_attempts SET marker_written_at = clock_timestamp() - interval '10 minutes' WHERE transaction_id = (SELECT transaction_id FROM realtime_transaction_attempts WHERE operation = 'append_event' ORDER BY marker_written_at DESC LIMIT 1)");
    } });
    expect(event.appendId).toBe("append-marker-refresh");
    expect(markerAgeMs).toBeLessThan(1_000);
    const unknown = ambiguous.recorder.records().find((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.transactionOperation === "append_event");
    expect(unknown).toBeDefined();
    expect(ambiguous.recorder.records().some((record) => record.boundary === "database.transaction_reconciled" && record.transactionId === unknown?.transactionId && record.details?.resolution === "committed")).toBe(true);
  });

  it("bounds a transport-stalled reconciliation BEGIN and preserves an indeterminate outcome", async () => {
    const boundedPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 1_000, options: testSearchPath });
    let connections = 0;
    const hangingPool = new Proxy(boundedPool, { get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await target.connect();
        connections += 1;
        if (connections < 2) return client;
        return new Proxy(client, { get(clientTarget, clientProperty, clientReceiver) {
          if (clientProperty === "query") return (text: string, values?: unknown[]) => text === "BEGIN" ? new Promise<never>(() => undefined) : clientTarget.query(text, values);
          const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(clientTarget) : value;
        } }) as PoolClient;
      };
    } }) as Pool;
    try {
      await prewarmPool(boundedPool, 2);
      boundedPool.options.connectionTimeoutMillis = 40;
      const ambiguous = new PostgresEventLog(hangingPool, undefined, { reconciliationTimeoutMs: 40, commit: async (client, context) => {
        await client.query("COMMIT");
        if (context.operation === "append_event") throw new Error("Connection terminated unexpectedly");
      } });
      const started = Date.now();
      await expect(ambiguous.appendEvent({ appendId: "append-hanging-reconcile-begin", tenantId: "tenant-hanging-reconcile", stream: "room:hanging-reconcile", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "uncertain" }, effectSchema: "none@1", effect: null })).rejects.toThrow("RT_TRANSACTION_OUTCOME_INDETERMINATE");
      expect(Date.now() - started).toBeLessThan(500);
      const unknown = ambiguous.recorder.records().find((record) => record.boundary === "database.transaction_outcome_indeterminate");
      expect(unknown).toBeDefined();
      expect(ambiguous.recorder.records().some((record) => record.transactionId === unknown?.transactionId && (record.boundary === "db.committed" || record.boundary === "db.rolled_back"))).toBe(false);
      expect(ambiguous.recorder.records().some((record) => record.transactionId === unknown?.transactionId && record.boundary === "database.transaction_reconciliation_unresolved")).toBe(true);
    } finally {
      await boundedPool.end();
    }
  });

  it("does not attribute a competing command or append commit to the original aborted attempt", async () => {
    const competitor = new PostgresEventLog(pool);
    const tenantId = "tenant-attempt-competition";
    const principal = await competitor.resolvePrincipalNamespace({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", keys });
    let commandCompetitorRan = false;
    let commandLog!: PostgresEventLog;
    const commandOptions = { tenantId, principalNamespaceId: principal, commandId: "cmd-competing-attempt", commandType: "sendMessage", commandSchema: "sendMessage@1", commandInput: { text: "one" }, stream: "room:competing-command", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "one" }, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, mutate: async () => ({ ok: true }) };
    commandLog = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      if (context.operation === "command" && !commandCompetitorRan) {
        commandCompetitorRan = true;
        await client.query("ROLLBACK");
        await competitor.executeCommand(commandOptions);
        throw new Error("Connection terminated unexpectedly");
      }
      await client.query("COMMIT");
    } });
    expect(await commandLog.executeCommand(commandOptions)).toMatchObject({ status: "completed", duplicate: true });
    const commandUnknown = commandLog.recorder.records().find((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.commandId === commandOptions.commandId);
    expect(commandUnknown).toBeDefined();
    expect(commandLog.recorder.records().some((record) => record.boundary === "database.transaction_reconciled" && record.transactionId === commandUnknown?.transactionId && record.details?.resolution === "rolled_back")).toBe(true);
    expect(commandLog.recorder.records().some((record) => record.boundary === "db.committed" && record.transactionId === commandUnknown?.transactionId)).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_commands WHERE tenant_id = $1 AND command_id = $2", [tenantId, commandOptions.commandId])).rows[0]?.count).toBe(1);

    let appendCompetitorRan = false;
    const appendOptions = { appendId: "append-competing-attempt", tenantId, stream: "room:competing-append", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "one" }, effectSchema: "none@1", effect: null } as const;
    const appendLog = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      if (context.operation === "append_event" && !appendCompetitorRan) {
        appendCompetitorRan = true;
        await client.query("ROLLBACK");
        await competitor.appendEvent(appendOptions);
        throw new Error("Connection terminated unexpectedly");
      }
      await client.query("COMMIT");
    } });
    const appended = await appendLog.appendEvent(appendOptions);
    const appendUnknown = appendLog.recorder.records().find((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.transactionOperation === "append_event");
    expect(appendUnknown).toBeDefined();
    expect(appendLog.recorder.records().some((record) => record.boundary === "database.transaction_reconciled" && record.transactionId === appendUnknown?.transactionId && record.details?.resolution === "rolled_back")).toBe(true);
    expect(appendLog.recorder.records().some((record) => record.boundary === "db.committed" && record.transactionId === appendUnknown?.transactionId)).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = $1 AND append_operation_id = $2", [tenantId, appendOptions.appendId])).rows[0]?.count).toBe(1);
    expect(appended.appendId).toBe(appendOptions.appendId);
  });

  it("does not attribute competing principal or outbox commits to the original aborted attempt", async () => {
    const competitor = new PostgresEventLog(pool);
    const request = { tenantId: "tenant-principal-attempt-competition", authenticationRealm: "oidc", issuer: "issuer", subject: "subject", keys };
    let principalCompetitorRan = false;
    const principalLog = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      if (context.operation === "principal_namespace" && !principalCompetitorRan) {
        principalCompetitorRan = true;
        await client.query("ROLLBACK");
        await competitor.resolvePrincipalNamespace(request);
        throw new Error("Connection terminated unexpectedly");
      }
      await client.query("COMMIT");
    } });
    const principal = await principalLog.resolvePrincipalNamespace(request);
    const principalUnknown = principalLog.recorder.records().find((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.transactionOperation === "principal_namespace");
    expect(principalUnknown).toBeDefined();
    expect(principalLog.recorder.records().some((record) => record.boundary === "database.transaction_reconciled" && record.transactionId === principalUnknown?.transactionId && record.details?.resolution === "rolled_back")).toBe(true);
    expect((await pool.query("SELECT count(DISTINCT principal_namespace_id)::int AS count FROM realtime_principal_identity_aliases WHERE tenant_id = $1", [request.tenantId])).rows[0]?.count).toBe(1);
    expect(principal).toBe(await competitor.resolvePrincipalNamespace(request));

    await competitor.publishOutbox({ limit: 1_000 });
    const event = await competitor.appendEvent({ appendId: "append-outbox-competing-attempt", tenantId: "tenant-outbox-attempt-competition", stream: "room:outbox-competition", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "wake" }, effectSchema: "none@1", effect: null });
    let outboxCompetitorRan = false;
    const outboxLog = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      if (context.operation === "outbox_publish" && !outboxCompetitorRan) {
        outboxCompetitorRan = true;
        await client.query("ROLLBACK");
        await competitor.publishOutbox({ limit: 1 });
        throw new Error("Connection terminated unexpectedly");
      }
      await client.query("COMMIT");
    } });
    expect(await outboxLog.publishOutbox({ limit: 1 })).toBe(0);
    const outboxUnknown = outboxLog.recorder.records().find((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.transactionOperation === "outbox_publish");
    expect(outboxUnknown).toBeDefined();
    expect(outboxLog.recorder.records().some((record) => record.boundary === "database.transaction_reconciled" && record.transactionId === outboxUnknown?.transactionId && record.details?.resolution === "rolled_back")).toBe(true);
    expect(outboxLog.recorder.records().some((record) => record.boundary === "outbox.notify_committed" && record.transactionId === outboxUnknown?.transactionId)).toBe(false);
    expect((await pool.query("SELECT notify_committed_at FROM realtime_outbox WHERE tenant_id = $1 AND event_id = $2", [event.tenantId, event.eventId])).rows[0]?.notify_committed_at).toBeInstanceOf(Date);
  });

  it("destroys a connection when ROLLBACK cleanup fails", async () => {
    const cleanupFailure = new PostgresEventLog(pool, undefined, { rollback: async () => { throw new Error("injected rollback failure"); } });
    await expect(cleanupFailure.appendEvent({ appendId: "append-cleanup-failure", tenantId: "tenant-cleanup-failure", stream: "room:cleanup", eventType: "messageAdded", schema: "MessageAdded@1", data: { text: "fail" }, effectSchema: "throw@1", effect: { reason: "injected" }, mutate: async () => { throw new Error("injected pre-commit failure"); } })).rejects.toThrow("injected pre-commit failure");
    expect(cleanupFailure.recorder.records().some((record) => record.boundary === "database.transaction_cleanup_attempted" && record.outcome === "failure")).toBe(true);
    expect((await pool.query("SELECT 1 AS healthy")).rows[0]?.healthy).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = 'tenant-cleanup-failure'")).rows[0]?.count).toBe(0);
  });

  it("reconciles principal namespace and safely retries a read-only snapshot after COMMIT acknowledgement loss", async () => {
    let principalAckLost = false;
    let snapshotAckLost = false;
    const ambiguous = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      await client.query("COMMIT");
      if (context.operation === "principal_namespace" && !principalAckLost) { principalAckLost = true; throw new Error("Connection terminated unexpectedly"); }
      if (context.operation === "snapshot_read" && !snapshotAckLost) { snapshotAckLost = true; throw new Error("Connection terminated unexpectedly"); }
    } });
    const competing = new PostgresEventLog(pool);
    const request = { tenantId: "tenant-principal-ack", authenticationRealm: "oidc", issuer: "issuer", subject: "subject", keys };
    const [first, sameGatewayConcurrent, concurrent] = await Promise.all([ambiguous.resolvePrincipalNamespace(request), ambiguous.resolvePrincipalNamespace(request), competing.resolvePrincipalNamespace(request)]);
    expect(sameGatewayConcurrent).toBe(first);
    expect(concurrent).toBe(first);
    let cachedCommitInvoked = false;
    const cached = new PostgresEventLog(pool, undefined, { commit: async (client) => { cachedCommitInvoked = true; await client.query("COMMIT"); } });
    expect(await cached.resolvePrincipalNamespace(request)).toBe(first);
    expect(cachedCommitInvoked).toBe(false);
    let rotationAckLost = false;
    const rotating = new PostgresEventLog(pool, undefined, { commit: async (client, context) => {
      await client.query("COMMIT");
      if (context.operation === "principal_namespace" && !rotationAckLost) { rotationAckLost = true; throw new Error("Connection terminated unexpectedly"); }
    } });
    const rotatedRequest = { ...request, keys: [...keys, { version: 3, key: "next-identity-key-for-tests" }] };
    const [oldAliasConcurrent, rotated, rotationConcurrent] = await Promise.all([rotating.resolvePrincipalNamespace(request), rotating.resolvePrincipalNamespace(rotatedRequest), competing.resolvePrincipalNamespace(rotatedRequest)]);
    expect(oldAliasConcurrent).toBe(first);
    expect(rotated).toBe(first);
    expect(rotationConcurrent).toBe(first);
    expect(rotationAckLost).toBe(true);
    expect((await pool.query("SELECT count(DISTINCT principal_namespace_id)::int AS count FROM realtime_principal_identity_aliases WHERE tenant_id = 'tenant-principal-ack'")).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM realtime_principal_identity_aliases WHERE tenant_id = 'tenant-principal-ack'")).rows[0]?.count).toBe(3);
    const snapshot = await ambiguous.atomicSnapshot("tenant-a", "room:42");
    expect(snapshot.cursorSequence).toBeGreaterThan(0);
    const records = ambiguous.recorder.records();
    const discarded = records.find((record) => record.boundary === "database.transaction_outcome_indeterminate" && record.details?.operation === "snapshot_read");
    expect(discarded).toBeDefined();
    expect(records.some((record) => record.boundary === "database.transaction_reconciled" && record.transactionId === discarded?.transactionId && record.details?.resolution === "no_durable_effect" && record.details.proofSource === "repeatable_read_read_only_discard_and_retry")).toBe(true);
    expect(records.some((record) => record.boundary === "db.rolled_back" && record.transactionId === discarded?.transactionId)).toBe(false);
    expect(records.some((record) => record.boundary === "snapshot.created" && record.outcome === "success")).toBe(true);
  });

  it("runs a generic gateway application through the atomic snapshot and command transaction ports", async () => {
    const tenantId = "tenant-generic-application";
    const stream = "tasks:7";
    const validatedEvents: string[] = [];
    const gateway = new PostgresGatewayServer({
      pool,
      port: 0,
      originPolicy: nodeOriginPolicy,
      runtimeId: "generic-application-test",
      contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      identityKeys: [{ version: 1, key: "generic-application-key" }],
      authenticate: () => ({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: ["tasks:read", "tasks:write"] }),
      application: {
        authorizeStream: (context, message) => context.permissions.has("tasks:read") && message.stream === stream && (message.input as { listId?: JsonValue }).listId === "7",
        snapshot: {
          schema: "TaskSnapshot@1",
          read: async (database, context) => {
            const rows = await database.query<{ body: string }>("SELECT body FROM realtime_room_messages WHERE tenant_id = $1 AND stream = $2 AND sequence <= $3 ORDER BY sequence", [context.tenantId, context.stream, context.includedSequence]);
            return { tasks: rows.rows.map((row) => row.body), includedSequence: context.includedSequence };
          }
        },
        authorizeCommand: (context, message) => context.permissions.has("tasks:write") && message.type === "addTask" && message.schema === "addTask@1",
        executeCommand: (_context, message) => {
          if (typeof message.input !== "object" || message.input === null || Array.isArray(message.input)) return null;
          const input = message.input as Record<string, JsonValue>;
          if (input.listId !== "7" || typeof input.title !== "string") return null;
          const title = input.title;
          const occurredAt = new Date().toISOString();
          return {
            stream,
            eventType: "taskAdded",
            eventSchema: "taskAdded@1",
            eventData: { title, occurredAt },
            resultSchema: "addTaskResult@2",
            mutate: async (database, context) => {
              await database.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [context.tenantId, context.stream, context.sequence, context.eventId, "Task", title, occurredAt]);
              return { taskId: context.eventId, sequence: context.sequence };
            }
          };
        },
        validateOutboundEvent: (_context, event) => { validatedEvents.push(event.eventId); return event.type === "taskAdded" && event.schema === "taskAdded@1"; },
        validateCommandResult: (_context, result) => result.schema === "addTaskResult@2" && typeof (result.result as { taskId?: unknown }).taskId === "string"
      }
    });
    let socket: WebSocket | undefined;
    try {
      await gateway.start();
      socket = new WebSocket(gateway.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_generic_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_generic", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      socket.send(JSON.stringify({ protocol: "1.0", kind: "stream.subscribe", messageId: "msg_generic_subscribe", sentAt: new Date().toISOString(), requestId: "req_generic_subscribe", sessionGeneration: ready.sessionGeneration, stream, input: { listId: "7" } }));
      const snapshot = await waitForWireMessage(messages, (message) => message.kind === "stream.snapshot" && message.stream === stream);
      expect(snapshot).toMatchObject({ schema: "TaskSnapshot@1", state: { tasks: [], includedSequence: 0 } });
      socket.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: "msg_generic_command", sentAt: new Date().toISOString(), commandAttemptId: "attempt_generic_command", sessionGeneration: ready.sessionGeneration, commandId: "cmd-generic-add", type: "addTask", schema: "addTask@1", input: { listId: "7", title: "Generic task" }, createdAt: new Date().toISOString() }));
      const completed = await waitForWireMessage(messages, (message) => message.kind === "command.completed" && message.commandId === "cmd-generic-add");
      expect(completed).toMatchObject({ schema: "addTaskResult@2", result: { sequence: 1 } });
      const event = await waitForWireMessage(messages, (message) => message.kind === "event" && message.stream === stream);
      expect(event).toMatchObject({ type: "taskAdded", schema: "taskAdded@1", data: { title: "Generic task" } });
      expect(validatedEvents).toEqual([event.eventId]);
      socket.send(JSON.stringify({ protocol: "1.0", kind: "command.status.request", messageId: "msg_generic_status", sentAt: new Date().toISOString(), requestId: "req_generic_status", sessionGeneration: ready.sessionGeneration, commandId: "cmd-generic-add" }));
      const status = await waitForWireMessage(messages, (message) => message.kind === "command.status" && message.requestId === "req_generic_status");
      expect(status).toMatchObject({ state: "completed", schema: "addTaskResult@2", result: { sequence: 1 } });
      expect((await pool.query("SELECT body FROM realtime_room_messages WHERE tenant_id = $1 AND stream = $2", [tenantId, stream])).rows).toEqual([{ body: "Generic task" }]);
      expect(await gateway.store.readAfter(tenantId, stream)).toHaveLength(1);
      expect((await pool.query("SELECT notify_committed_at FROM realtime_outbox WHERE tenant_id = $1", [tenantId])).rows).toMatchObject([{ notify_committed_at: expect.any(Date) }]);
    } finally {
      socket?.close();
      await gateway.dispose();
    }
  });

  it("keeps a gateway ready after an authoritative deferred-COMMIT command abort and preserves tenant-scoped proof", async () => {
    const tenantId = "tenant-gateway-authoritative-abort";
    const commandId = "cmd-gateway-authoritative-abort";
    const gateway = new PostgresGatewayServer({
      pool,
      port: 0,
      originPolicy: nodeOriginPolicy,
      runtimeId: "gateway-authoritative-abort-test",
      contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      identityKeys: [{ version: 1, key: "gateway-authoritative-abort-key" }],
      authenticate: () => ({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: ["write"] }),
      application: {
        authorizeCommand: () => true,
        executeCommand: () => ({
          stream: "room:abort",
          eventType: "messageAdded",
          eventSchema: "messageAdded@1",
          eventData: { text: "must roll back" },
          resultSchema: "sendMessageResult@1",
          mutate: async (database, context) => {
            await database.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [context.tenantId, context.stream, context.sequence, "evt_missing", "test", "must roll back", new Date()]);
            return { sequence: context.sequence };
          }
        })
      }
    });
    let socket: WebSocket | undefined;
    try {
      await gateway.start();
      socket = new WebSocket(gateway.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_gateway_abort_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_gateway_abort", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      socket.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: "msg_gateway_abort_command", sentAt: new Date().toISOString(), commandAttemptId: "attempt_gateway_abort_command", sessionGeneration: ready.sessionGeneration, commandId, type: "sendMessage", schema: "sendMessage@1", input: { roomId: "abort", text: "must roll back" }, createdAt: new Date().toISOString() }));
      const failure = await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === commandId);
      expect(failure.error).toMatchObject({ code: "RT_OPERATION_UNAVAILABLE", scope: "command", retryable: false });
      expect(messages.some((message) => message.kind === "command.receipt" && message.commandId === commandId)).toBe(false);
      expect(messages.some((message) => message.kind === "command.completed" && message.commandId === commandId)).toBe(false);
      expect(gateway.ready).toBe(true);
      expect(await fetch(`${gateway.httpUrl}/health`).then((response) => response.status)).toBe(200);
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_commands WHERE tenant_id = $1 AND command_id = $2", [tenantId, commandId])).rows[0]?.count).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = $1 AND command_id = $2", [tenantId, commandId])).rows[0]?.count).toBe(0);
      const databaseProof = gateway.store.recorder.records().find((record) => record.boundary === "db.rolled_back" && record.commandId === commandId);
      expect(databaseProof).toMatchObject({ outcome: "failure", details: { tenantId, proofSource: "postgres_error_response", sqlstate: "23503" } });
      expect(gateway.recorder.records().some((record) => record.boundary === "gateway.transaction_rolled_back_observed" && record.transactionId === databaseProof?.transactionId && record.commandId === commandId && record.details?.tenantId === tenantId)).toBe(true);
      expect(gateway.recorder.records().some((record) => record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(false);
    } finally {
      socket?.close();
      await gateway.dispose();
    }
  });

  it.each(["40001", "40P01"])("marks authoritative %s rollback retryable without changing gateway readiness", async (sqlstate) => {
    let injected = false;
    const commandId = `cmd-gateway-retry-${sqlstate}`;
    const gateway = new PostgresGatewayServer({
      pool, port: 0, originPolicy: nodeOriginPolicy, runtimeId: `gateway-retry-${sqlstate}-test`, contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, identityKeys: [{ version: 1, key: "gateway-serialization-retry-key" }],
      authenticate: () => ({ tenantId: `tenant-gateway-retry-${sqlstate}`, authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: ["room:42:write"] }),
      transactionOptions: { commit: async (client, context) => {
        if (context.operation === "command" && !injected) { injected = true; const error = new DatabaseError("retryable transaction abort", 0, "error"); error.code = sqlstate; throw error; }
        await client.query("COMMIT");
      } }
    });
    let socket: WebSocket | undefined;
    try {
      await gateway.start();
      socket = new WebSocket(gateway.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_serialization_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_serialization", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      socket.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: "msg_serialization_command", sentAt: new Date().toISOString(), commandAttemptId: "attempt_serialization_command", sessionGeneration: ready.sessionGeneration, commandId, type: "sendMessage", schema: "sendMessage@1", input: { roomId: "42", text: "retry safely" }, createdAt: new Date().toISOString() }));
      const failure = await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === commandId);
      expect(failure.error).toMatchObject({ code: "RT_OPERATION_UNAVAILABLE", scope: "command", disposition: "retry", retryable: true, retryAfterMs: 50 });
      expect(gateway.ready).toBe(true);
      expect(gateway.store.recorder.records().some((record) => record.boundary === "db.rolled_back" && record.commandId === commandId && record.details?.sqlstate === sqlstate)).toBe(true);
      expect(gateway.recorder.records().some((record) => record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(false);
    } finally { socket?.close(); await gateway.dispose(); }
  });

  it("keeps ambiguous public stream routing application-scoped without invoking either handler", async () => {
    const input = jsonSchema("test.ambiguous-stream.input@1", { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false });
    const state = jsonSchema("test.ambiguous-stream.snapshot@1", { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } }, additionalProperties: false });
    const ambiguousContract = defineRealtimeContract({
      contractId: "test",
      manifestVersion: "1.0.0",
      streams: {
        alpha: stream({ input, snapshot: state, events: {}, key: ({ id }) => `shared:${id}`, initial: () => ({ sequence: 0 }), applyEvent: (current) => current, snapshotSequence: (current) => current.sequence }),
        beta: stream({ input, snapshot: state, events: {}, key: ({ id }) => `shared:${id}`, initial: () => ({ sequence: 0 }), applyEvent: (current) => current, snapshotSequence: (current) => current.sequence }),
        safe: stream({ input, snapshot: state, events: {}, key: ({ id }) => `safe:${id}`, initial: () => ({ sequence: 0 }), applyEvent: (current) => current, snapshotSequence: (current) => current.sequence })
      },
      commands: {}
    });
    let handlerCalls = 0;
    const profile = postgres({ pool, schema: "better_realtime_ambiguous_fixture", identityKeys: [{ version: 1, key: "ambiguous-stream-identity-key-32-bytes" }] });
    await migratePostgres(ambiguousContract, profile);
    const server = createRealtimeServer(ambiguousContract, {
      profile,
      runtimeId: "ambiguous-stream-test",
      port: 0,
      originPolicy: { allowedOrigins: [], allowMissingOrigin: true },
      authenticate: () => ({ tenantId: "tenant-ambiguous", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }),
      streams: {
        alpha: { authorize: () => { handlerCalls += 1; return true; }, snapshot: () => ({ sequence: 0 }) },
        beta: { authorize: () => { handlerCalls += 1; return true; }, snapshot: () => ({ sequence: 0 }) },
        safe: { authorize: () => { handlerCalls += 1; throw new Error("Connection terminated unexpectedly"); }, snapshot: () => ({ sequence: 0 }) }
      },
      commands: {}
    });
    let socket: WebSocket | undefined;
    try {
      await server.start();
      socket = new WebSocket(server.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_ambiguous_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_ambiguous", contract: ambiguousContract.identity, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      socket.send(JSON.stringify({ protocol: "1.0", kind: "stream.subscribe", messageId: "msg_ambiguous_subscribe", sentAt: new Date().toISOString(), requestId: "req_ambiguous", sessionGeneration: ready.sessionGeneration, stream: "shared:7", input: { id: "7" } }));
      const failure = await waitForWireMessage(messages, (message) => message.kind === "error");
      expect(failure.error).toMatchObject({ code: "RT_OPERATION_UNAVAILABLE", scope: "stream", retryable: false });
      expect(handlerCalls).toBe(0);
      expect(server.ready).toBe(true);
      expect(await fetch(`${server.httpUrl}/health`).then((response) => response.status)).toBe(200);
      socket.send(JSON.stringify({ protocol: "1.0", kind: "stream.subscribe", messageId: "msg_application_error_subscribe", sentAt: new Date().toISOString(), requestId: "req_application_error", sessionGeneration: ready.sessionGeneration, stream: "safe:7", input: { id: "7" } }));
      const applicationFailure = await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { stream?: string } | undefined)?.stream === "safe:7");
      expect(applicationFailure.error).toMatchObject({ code: "RT_OPERATION_UNAVAILABLE", scope: "stream", retryable: false });
      expect(handlerCalls).toBe(1);
      expect(server.ready).toBe(true);
      const bundle = server.evidenceBundle("tenant-ambiguous");
      expect(bundle.records.some(({ record }) => record.boundary === "application.operation_failed" && record.details?.provenance === "application")).toBe(true);
      expect(bundle.records.some(({ record }) => record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(false);
      expect(server.evidenceBundle("tenant-other").records.some(({ record }) => record.boundary === "application.operation_failed")).toBe(false);
    } finally {
      socket?.close();
      await server.dispose();
    }
  });

  it("exports exact tenant-scoped rollback proof through the public facade without false DB outage", async () => {
    const caseId = crypto.randomUUID();
    const publicContract = defineRealtimeContract({
      contractId: "test",
      manifestVersion: "1.0.0",
      streams: { room: stream({ input: jsonSchema("test.public-rollback.room.input@1", { type: "object", required: ["id"], properties: { id: { type: "string" } } }), snapshot: jsonSchema("test.public-rollback.room.snapshot@1", { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } } }), events: { changed: jsonSchema("test.public-rollback.room.changed@1", { type: "object", required: ["text"], properties: { text: { type: "string" } } }) }, key: ({ id }) => `room:${id}`, initial: () => ({ sequence: 0 }), applyEvent: (_current, event) => ({ sequence: event.sequence }), snapshotSequence: (current) => current.sequence }) },
      commands: { fail: command({ input: jsonSchema("test.public-rollback.fail.input@1", { type: "object", required: ["id"], properties: { id: { type: "string" } } }), result: jsonSchema("test.public-rollback.fail.result@1", { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } } }) }) }
    });
    const tenantId = `tenant-public-rollback-${caseId}`;
    const commandId = `cmd-public-rollback-${caseId}`;
    const profile = postgres({ pool, schema: "better_realtime_public_rollback", identityKeys: [{ version: 1, key: "public-rollback-identity-key-32-bytes" }] });
    await migratePostgres(publicContract, profile);
    await pool.query(`CREATE OR REPLACE FUNCTION "better_realtime_public_rollback".raise_connection_message_collision() RETURNS integer LANGUAGE plpgsql AS $function$ BEGIN RAISE EXCEPTION 'Client has encountered a connection error and is not queryable' USING ERRCODE = 'P0001'; END $function$`);
    const server = createRealtimeServer(publicContract, {
      profile, runtimeId: "public-rollback-test", port: 0, originPolicy: { allowedOrigins: [], allowMissingOrigin: true },
      authenticate: () => ({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }),
      streams: { room: { authorize: () => true, snapshot: async (context) => {
        if (context.input.id === "unsafeSnapshotCommit") await context.db.query("COMMIT");
        if (context.input.id === "unsafeSnapshotMulti") await context.db.query("SELECT 1; ROLLBACK");
        if (context.input.id === "unsafeSnapshotSession") await context.db.query("LISTEN leaked_snapshot_channel");
        return { sequence: 0 };
      } } },
      commands: { fail: { authorize: () => true, prepare: (_context, input) => ({ publish: { stream: "room", input, event: "changed", data: { text: "rollback" } }, mutate: async (context) => {
        if (input.id === "message-collision") await context.db.query(`SELECT "better_realtime_public_rollback".raise_connection_message_collision()`);
        else await context.db.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [context.tenantId, context.stream, context.sequence, "evt_missing", "test", "rollback", new Date()]);
        return { sequence: context.sequence };
      } }) } }
    });
    let socket: WebSocket | undefined;
    try {
      await server.start();
      socket = new WebSocket(server.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_public_rollback_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_public_rollback", contract: publicContract.identity, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      socket.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: "msg_public_rollback_command", sentAt: new Date().toISOString(), commandAttemptId: "attempt_public_rollback_command", sessionGeneration: ready.sessionGeneration, commandId, type: "fail", schema: "test.public-rollback.fail.input@1", input: { id: "abort" }, createdAt: new Date().toISOString() }));
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === commandId);
      const bundle = server.evidenceBundle(tenantId);
      expect(bundle.expectedProducerInstances).toEqual([
        expect.objectContaining({ producerRole: "server", runtimeId: "public-rollback-test" }),
        expect.objectContaining({ producerRole: "database", runtimeId: "public-rollback-test:postgres" })
      ]);
      expect(new Set(bundle.expectedProducerInstances.map((producer) => producer.producerRole))).toEqual(new Set(["server", "database"]));
      for (const missingRole of ["server", "database"] as const) {
        const incomplete = new LocalDiagnosticQuery({ ...bundle, records: bundle.records.filter(({ record }) => record.producerRole !== missingRole) }).doctor({
          tenantId,
          expectedBoundaries: [{ producerRole: "database", boundary: "db.rolled_back" }, { producerRole: "server", boundary: "gateway.transaction_rolled_back_observed" }],
          expectedProducers: ["database", "server"],
          scope: { commandId },
          expectedOutcome: "command transaction committed"
        });
        expect(incomplete.report.verdict).not.toBe("proven");
        expect(incomplete.completeness.status).toBe("partial");
        expect(incomplete.completeness.missingProducerInstances.some((producer) => producer.producerRole === missingRole)).toBe(true);
      }
      const rollback = bundle.records.find(({ record }) => record.boundary === "db.rolled_back");
      const observer = bundle.records.find(({ record }) => record.boundary === "gateway.transaction_rolled_back_observed");
      expect(rollback?.record).toMatchObject({ outcome: "failure", reasonCode: "RT_TRANSACTION_ROLLED_BACK", details: { tenantId, proofSource: "postgres_error_response", sqlstate: "23503" } });
      expect(observer?.record.transactionId).toBe(rollback?.record.transactionId);
      expect(bundle.records.some(({ record }) => record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(false);
      expect(server.evidenceBundle("tenant-other").records.some(({ record }) => record.transactionId === rollback?.record.transactionId)).toBe(false);
      const query = new LocalDiagnosticQuery(bundle);
      const trace = query.traceCommand({ tenantId, commandId });
      expect(trace.records.some((record) => record.boundary === "db.rolled_back" && record.principalNamespaceId !== undefined)).toBe(true);
      const diagnosis = query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "db.rolled_back" }, { producerRole: "server", boundary: "gateway.transaction_rolled_back_observed" }], expectedProducers: ["database", "server"], scope: { commandId }, expectedOutcome: "command transaction committed" });
      expect(diagnosis.report.verdict).toBe("disproven");
      expect(diagnosis.report.scope.principalNamespaceId).toMatch(/^pseudonym:sha256:/);
      const collisionCommandId = `cmd-public-message-collision-${crypto.randomUUID()}`;
      socket.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: "msg_public_message_collision", sentAt: new Date().toISOString(), commandAttemptId: "attempt_public_message_collision", sessionGeneration: ready.sessionGeneration, commandId: collisionCommandId, type: "fail", schema: "test.public-rollback.fail.input@1", input: { id: "message-collision" }, createdAt: new Date().toISOString() }));
      const collisionFailure = await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === collisionCommandId);
      expect(collisionFailure.error).toMatchObject({ code: "RT_OPERATION_UNAVAILABLE", scope: "command", disposition: "fail_operation", retryable: false, commandId: collisionCommandId });
      const collisionBundle = server.evidenceBundle(tenantId);
      expect(collisionBundle.records.some(({ record }) => record.boundary === "gateway.transaction_rolled_back_observed" && record.commandId === collisionCommandId && record.details?.sqlstate === "P0001" && record.details.failureProvenance === "authoritative_abort")).toBe(true);
      expect(collisionBundle.records.some(({ record }) => record.commandId === collisionCommandId && record.boundary === "application.operation_failed")).toBe(false);
      expect(collisionBundle.records.some(({ record }) => record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(false);
      expect(server.ready).toBe(true);
      expect(await fetch(`${server.httpUrl}/health`).then((response) => response.status)).toBe(200);
    } finally { socket?.close(); await server.dispose(); }
  });

  it.each(["snapshot", "command"] as const)("tags an actual public %s db.query infrastructure failure and drains readiness", async (operation) => {
    const caseId = crypto.randomUUID();
    const termination = {
      targetPid: undefined as number | undefined,
      managerPid: undefined as number | undefined,
      completed: false,
      backendDisappeared: false,
      staleQueryRejected: false,
      staleQueryError: undefined as { name: string; message: string } | undefined
    };
    const contract = defineRealtimeContract({
      contractId: "test",
      manifestVersion: "1.0.0",
      streams: { room: stream({ input: jsonSchema(`test.public-db-failure-${operation}.room.input@1`, { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }), snapshot: jsonSchema(`test.public-db-failure-${operation}.room.snapshot@1`, { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } }, additionalProperties: false }), events: { changed: jsonSchema(`test.public-db-failure-${operation}.room.changed@1`, { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false }) }, key: ({ id }) => `db-failure:${operation}:${id}`, initial: () => ({ sequence: 0 }), applyEvent: (_current, event) => ({ sequence: event.sequence }), snapshotSequence: (current) => current.sequence }) },
      commands: { change: command({ input: jsonSchema(`test.public-db-failure-${operation}.change.input@1`, { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }), result: jsonSchema(`test.public-db-failure-${operation}.change.result@1`, { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } }, additionalProperties: false }) }) }
    });
    const tenantId = `tenant-public-db-failure-${operation}-${caseId}`;
    const commandId = `cmd-db-failure-${caseId}`;
    const profile = postgres({ pool, schema: `better_realtime_db_failure_${operation}`, identityKeys: [{ version: 1, key: "public-db-failure-identity-key-32-bytes" }], operationTimeoutMs: 5_000 });
    await migratePostgres(contract, profile);
    const terminateCurrentApplicationConnection = async (database: PostgresGatewayDatabase): Promise<never> => {
      const pid = Number((await database.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      termination.targetPid = pid;
      const completion = await pool.query<{ manager_pid: number; terminated: boolean }>("SELECT pg_backend_pid() AS manager_pid, pg_terminate_backend($1, $2::bigint) AS terminated", [pid, 2_000]);
      termination.managerPid = Number(completion.rows[0]!.manager_pid);
      termination.completed = completion.rows[0]?.terminated === true;
      if (!termination.completed) throw new Error(`PostgreSQL backend ${pid} did not terminate within the bounded management timeout`);
      const state = await pool.query<{ active: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS active", [pid]);
      termination.backendDisappeared = state.rows[0]?.active === false;
      if (!termination.backendDisappeared) throw new Error(`PostgreSQL backend ${pid} remained visible after termination completion`);
      return database.query("SELECT 1").then<never>(
        () => { throw new Error("expected terminated application database connection"); },
        (error: unknown) => {
          termination.staleQueryRejected = true;
          termination.staleQueryError = { name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) };
          throw error;
        }
      );
    };
    const server = createRealtimeServer(contract, {
      profile, runtimeId: `public-db-failure-${operation}`, port: 0, originPolicy: { allowedOrigins: [], allowMissingOrigin: true },
      authenticate: () => ({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }),
      streams: { room: { authorize: () => true, snapshot: async (context) => terminateCurrentApplicationConnection(context.db) } },
      commands: { change: { authorize: () => true, prepare: (_context, input) => ({ publish: { stream: "room", input, event: "changed", data: { text: "never committed" } }, mutate: async (context) => terminateCurrentApplicationConnection(context.db) }) } }
    });
    let socket: WebSocket | undefined;
    try {
      await server.start();
      socket = new WebSocket(server.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: `msg_db_failure_${operation}_open`, sentAt: new Date().toISOString(), connectionAttemptId: `attempt_db_failure_${operation}`, contract: contract.identity, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      if (operation === "snapshot") socket.send(JSON.stringify({ protocol: "1.0", kind: "stream.subscribe", messageId: "msg_db_failure_snapshot", sentAt: new Date().toISOString(), requestId: "req_db_failure_snapshot", sessionGeneration: ready.sessionGeneration, stream: `db-failure:snapshot:${caseId}`, input: { id: caseId } }));
      else socket.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: "msg_db_failure_command", sentAt: new Date().toISOString(), commandAttemptId: "attempt_db_failure_command", sessionGeneration: ready.sessionGeneration, commandId, type: "change", schema: `test.public-db-failure-${operation}.change.input@1`, input: { id: caseId }, createdAt: new Date().toISOString() }));
      await waitForCondition(() => termination.staleQueryRejected && server.evidenceBundle(tenantId).records.some(({ record }) => record.boundary === "database.operation_failed" && record.reasonCode === "RT_DATABASE_UNAVAILABLE"), 6_000).catch((error: unknown) => {
        const observed = server.evidenceBundle(tenantId).records.map(({ record }) => ({ boundary: record.boundary, reasonCode: record.reasonCode, details: record.details }));
        throw new Error(`termination proof did not reach database evidence: ${JSON.stringify({ termination, observed, messages })}`, { cause: error });
      });
      expect(termination).toMatchObject({
        targetPid: expect.any(Number),
        managerPid: expect.any(Number),
        completed: true,
        backendDisappeared: true,
        staleQueryRejected: true,
        staleQueryError: { name: "Error", message: "RT_APPLICATION_DATABASE_QUERY_FAILED" }
      });
      expect(termination.managerPid).not.toBe(termination.targetPid);
      const failure = await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { code?: string } | undefined)?.code === "RT_DATABASE_UNAVAILABLE");
      expect(failure.error).toMatchObject({ retryable: true, disposition: "retry" });
      expect(server.ready).toBe(false);
      const health = await fetch(`${server.httpUrl}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({ status: "unready" });
      const bundle = server.evidenceBundle(tenantId);
      expect(bundle.records.some(({ record }) => record.boundary === "database.operation_failed" && record.details?.tenantId === tenantId && record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(true);
      expect(bundle.records.some(({ record }) => record.boundary === "application.operation_failed")).toBe(false);
      expect(bundle.records.some(({ record }) => record.boundary === "gateway.transaction_rolled_back_observed")).toBe(false);
      expect(bundle.records.some(({ record }) => record.boundary === "db.rolled_back" && record.details?.proofSource === "commit_not_invoked")).toBe(true);
      expect(server.evidenceBundle("tenant-other").records.some(({ record }) => record.boundary === "database.operation_failed")).toBe(false);
    } finally { socket?.close(); await server.dispose(); }
  }, 10_000);

  it("revokes the public query port, rejects pending work, and cannot spoof trusted query provenance", async () => {
    const contract = defineRealtimeContract({
      contractId: "test",
      manifestVersion: "1.0.0",
      streams: { room: stream({ input: jsonSchema("test.public-db-port.room.input@1", { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }), snapshot: jsonSchema("test.public-db-port.room.snapshot@1", { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } }, additionalProperties: false }), events: { changed: jsonSchema("test.public-db-port.room.changed@1", { type: "object", required: ["mode"], properties: { mode: { type: "string" } }, additionalProperties: false }) }, key: ({ id }) => `db-port:${id}`, initial: () => ({ sequence: 0 }), applyEvent: (_current, event) => ({ sequence: event.sequence }), snapshotSequence: (current) => current.sequence }) },
      commands: { change: command({ input: jsonSchema("test.public-db-port.change.input@1", { type: "object", required: ["id", "mode"], properties: { id: { type: "string" }, mode: { enum: ["pending", "timeout", "lateDml", "unobservedReject", "unobservedThen", "unobservedFinally", "invalid", "unsafeCommit", "unsafeMulti", "unsafeSession", "capture", "spoof"] } }, additionalProperties: false }), result: jsonSchema("test.public-db-port.change.result@1", { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } }, additionalProperties: false }) }) }
    });
    const tenantId = "tenant-public-db-port";
    const profile = postgres({ pool, schema: "better_realtime_public_db_port", identityKeys: [{ version: 1, key: "public-db-port-identity-key-32-bytes" }], operationTimeoutMs: 25 });
    await migratePostgres(contract, profile);
    let capturedDatabase: PostgresGatewayDatabase | undefined;
    const server = createRealtimeServer(contract, {
      profile, runtimeId: "public-db-port", port: 0, originPolicy: { allowedOrigins: [], allowMissingOrigin: true },
      authenticate: () => ({ tenantId, authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }),
      streams: { room: { authorize: () => true, snapshot: async (context) => {
        if (context.input.id === "unsafeSnapshotCommit") await context.db.query("COMMIT");
        if (context.input.id === "unsafeSnapshotMulti") await context.db.query("SELECT 1; ROLLBACK");
        if (context.input.id === "unsafeSnapshotSession") await context.db.query("LISTEN leaked_snapshot_channel");
        return { sequence: 0 };
      } } },
      commands: { change: { authorize: () => true, prepare: (_context, input) => ({ publish: { stream: "room", input: { id: input.id }, event: "changed", data: { mode: input.mode } }, mutate: async (context) => {
        if (input.mode === "pending") { void context.db.query("SELECT pg_sleep(0.05)"); return { sequence: context.sequence }; }
        if (input.mode === "timeout") await new Promise<never>(() => undefined);
        if (input.mode === "lateDml") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await context.db.query("INSERT INTO realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [context.tenantId, context.stream, context.sequence, context.eventId, "late", "must not commit", new Date()]);
          return { sequence: context.sequence };
        }
        if (input.mode === "unobservedReject") { void context.db.query("SELECT * FROM realtime_deliberately_missing_table"); await new Promise((resolve) => setTimeout(resolve, 10)); return { sequence: context.sequence }; }
        if (input.mode === "unobservedThen") { void context.db.query("SELECT * FROM realtime_deliberately_missing_table").then(); await new Promise((resolve) => setTimeout(resolve, 10)); return { sequence: context.sequence }; }
        if (input.mode === "unobservedFinally") { void context.db.query("SELECT * FROM realtime_deliberately_missing_table").finally(() => undefined); await new Promise((resolve) => setTimeout(resolve, 10)); return { sequence: context.sequence }; }
        if (input.mode === "invalid") { void (context.db.query as (text: unknown, values?: unknown) => Promise<unknown>)(42); return { sequence: context.sequence }; }
        if (input.mode === "unsafeCommit") { await context.db.query("COMMIT"); return { sequence: context.sequence }; }
        if (input.mode === "unsafeMulti") { await context.db.query("SELECT 1; COMMIT"); return { sequence: context.sequence }; }
        if (input.mode === "unsafeSession") { await context.db.query("LISTEN leaked_channel"); return { sequence: context.sequence }; }
        if (input.mode === "capture") { capturedDatabase = context.db; return { sequence: context.sequence }; }
        try { await context.db.query("SELECT * FROM realtime_deliberately_missing_table"); }
        catch (error) {
          Object.defineProperty(error as object, "cause", { value: Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" }), configurable: true });
          Object.defineProperty(error as object, "code", { value: "08006", configurable: true });
          throw error;
        }
        throw new Error("expected missing-table query failure");
      } }) } }
    });
    let socket: WebSocket | undefined;
    try {
      await server.start();
      socket = new WebSocket(server.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_db_port_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_db_port", contract: contract.identity, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      for (const mode of ["unsafeSnapshotCommit", "unsafeSnapshotMulti", "unsafeSnapshotSession"] as const) {
        const streamKey = `db-port:${mode}`;
        socket.send(JSON.stringify({ protocol: "1.0", kind: "stream.subscribe", messageId: `msg_db_port_${mode}`, sentAt: new Date().toISOString(), requestId: `req_db_port_${mode}`, sessionGeneration: ready.sessionGeneration, stream: streamKey, input: { id: mode } }));
        await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { stream?: string } | undefined)?.stream === streamKey);
        expect(server.ready).toBe(true);
      }
      const send = (mode: "pending" | "timeout" | "lateDml" | "unobservedReject" | "unobservedThen" | "unobservedFinally" | "invalid" | "unsafeCommit" | "unsafeMulti" | "unsafeSession" | "capture" | "spoof") => socket!.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: `msg_db_port_${mode}`, sentAt: new Date().toISOString(), commandAttemptId: `attempt_db_port_${mode}`, sessionGeneration: ready.sessionGeneration, commandId: `cmd-db-port-${mode}`, type: "change", schema: "test.public-db-port.change.input@1", input: { id: mode, mode }, createdAt: new Date().toISOString() }));
      send("pending");
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === "cmd-db-port-pending");
      expect(server.ready).toBe(true);
      send("timeout");
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === "cmd-db-port-timeout");
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_commands WHERE tenant_id = $1 AND command_id = $2", [tenantId, "cmd-db-port-timeout"])).rows[0]?.count).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_events WHERE tenant_id = $1 AND command_id = $2", [tenantId, "cmd-db-port-timeout"])).rows[0]?.count).toBe(0);
      expect(server.ready).toBe(true);
      send("lateDml");
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === "cmd-db-port-lateDml");
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_room_messages WHERE tenant_id = $1 AND body = $2", [tenantId, "must not commit"])).rows[0]?.count).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM realtime_commands WHERE tenant_id = $1 AND command_id = $2", [tenantId, "cmd-db-port-lateDml"])).rows[0]?.count).toBe(0);
      expect((await pool.query("SELECT 1 AS safe")).rows[0]?.safe).toBe(1);
      expect(server.ready).toBe(true);
      send("unobservedReject");
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === "cmd-db-port-unobservedReject");
      expect(server.ready).toBe(true);
      for (const mode of ["unobservedThen", "unobservedFinally", "invalid", "unsafeCommit", "unsafeMulti", "unsafeSession"] as const) {
        send(mode);
        await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === `cmd-db-port-${mode}`);
        expect(server.ready).toBe(true);
        expect((await pool.query("SELECT count(*)::int AS count FROM realtime_commands WHERE tenant_id = $1 AND command_id = $2", [tenantId, `cmd-db-port-${mode}`])).rows[0]?.count).toBe(0);
      }
      send("capture");
      await waitForWireMessage(messages, (message) => message.kind === "command.completed" && message.commandId === "cmd-db-port-capture");
      await expect(capturedDatabase!.query("SELECT 1")).rejects.toThrow("RT_APPLICATION_DATABASE_SCOPE_CLOSED");
      send("spoof");
      const spoofFailure = await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { commandId?: string } | undefined)?.commandId === "cmd-db-port-spoof");
      expect(spoofFailure.error).toMatchObject({ retryable: false, disposition: "fail_operation" });
      expect(server.ready).toBe(true);
      const bundle = server.evidenceBundle(tenantId);
      expect(bundle.records.some(({ record }) => record.reasonCode === "RT_DATABASE_UNAVAILABLE")).toBe(false);
      expect(bundle.records.some(({ record }) => record.boundary === "db.rolled_back" && record.commandId === "cmd-db-port-spoof" && record.details?.sqlstate !== undefined)).toBe(false);
      expect(bundle.records.some(({ record }) => record.boundary === "gateway.transaction_rolled_back_observed" && record.commandId === "cmd-db-port-spoof" && record.details?.sqlstate === "42P01" && record.details.failureProvenance === "authoritative_abort")).toBe(true);
    } finally { socket?.close(); await server.dispose(); }
  });

  it("keeps readiness honest without a durable receipt when one command reconciliation remains indeterminate", async () => {
    const gatewayPool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 1_000, options: testSearchPath });
    let blocker: PoolClient | undefined;
    let blockerOpen = false;
    const commandId = "cmd-gateway-indeterminate";
    let gateway: PostgresGatewayServer | undefined;
    let socket: WebSocket | undefined;
    try {
      blocker = await pool.connect();
      await prewarmPool(gatewayPool, 4);
      gatewayPool.options.connectionTimeoutMillis = 25;
      gateway = new PostgresGatewayServer({
        pool: gatewayPool,
        port: 0,
        originPolicy: nodeOriginPolicy,
        runtimeId: "gateway-indeterminate-test",
        contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        identityKeys: [{ version: 1, key: "gateway-indeterminate-key" }],
        authenticate: () => ({ tenantId: "tenant-gateway-indeterminate", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: ["room:42:read", "room:42:write"] }),
        transactionOptions: { reconciliationTimeoutMs: 25, commit: async (client, context) => {
          await client.query("COMMIT");
          if (context.operation === "command" && !blockerOpen) {
            blockerOpen = true;
            await blocker!.query("BEGIN");
            await blocker!.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`schema:better_realtime:command:${context.tenantId}:${context.principalNamespaceId}:${context.commandId}`]);
            throw new Error("Connection terminated unexpectedly");
          }
        } }
      });
      await gateway.start();
      socket = new WebSocket(gateway.webSocketUrl, "better-realtime.v1");
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      const messages: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
      socket.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "msg_gateway_indeterminate_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_gateway_indeterminate", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: {} }));
      const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready");
      socket.send(JSON.stringify({ protocol: "1.0", kind: "command", messageId: "msg_gateway_indeterminate_command", sentAt: new Date().toISOString(), commandAttemptId: "attempt_gateway_indeterminate_command", sessionGeneration: ready.sessionGeneration, commandId, type: "sendMessage", schema: "sendMessage@1", input: { roomId: "42", text: "uncertain" }, createdAt: new Date().toISOString() }));
      await waitForWireMessage(messages, (message) => message.kind === "error" && (message.error as { code?: string } | undefined)?.code === "RT_TRANSACTION_OUTCOME_INDETERMINATE");
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(messages.some((message) => message.kind === "error" && (message.error as { code?: string } | undefined)?.code === "RT_DATABASE_UNAVAILABLE")).toBe(false);
      expect(messages.some((message) => message.kind === "command.receipt" && message.commandId === commandId)).toBe(false);
      expect(messages.some((message) => message.kind === "command.completed" && message.commandId === commandId)).toBe(false);
      expect(gateway.ready).toBe(true);
      expect(await fetch(`${gateway.httpUrl}/health`).then((response) => response.status)).toBe(200);
      expect(gateway.store.recorder.records().some((record) => record.boundary === "database.transaction_reconciliation_unresolved" && record.commandId === commandId)).toBe(true);
      const tenantId = "tenant-gateway-indeterminate";
      const records = selectTenantEvidenceRecords([...gateway.recorder.records(), ...gateway.store.recorder.records()], tenantId);
      const instances = [...new Map(records.map((record) => [`${record.producerRole}:${record.runtimeId}:${record.runtimeBootId}`, { producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId }])).values()];
      const query = new LocalDiagnosticQuery({ schemaVersion: "1.0", tenantId, payloadPolicy: "redacted", pseudonymizationKey: "indeterminate-diagnostic-test-key", records: records.map((record) => ({ tenantId, record })), resourceCapture: "unavailable", loss: { droppedRecords: 0, evictedRecords: 0 }, expectedProducerInstances: instances });
      const trace = query.traceCommand({ tenantId, commandId });
      expect(trace.records.some((record) => record.boundary === "database.transaction_reconciliation_unresolved" && record.principalNamespaceId !== undefined)).toBe(true);
      const diagnosis = query.doctor({ tenantId, expectedBoundaries: [{ producerRole: "database", boundary: "database.transaction_reconciliation_unresolved" }], expectedProducers: ["database"], scope: { commandId }, expectedOutcome: "command status reconciled" });
      expect(diagnosis.report.verdict).toBe("indeterminate");
    } finally {
      socket?.close();
      if (blockerOpen) await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await gateway?.dispose();
      await gatewayPool.end();
    }
  });

  it("cleans the first gateway, database pool, and reserved port when startup fails before gateway B", async () => {
    const port = await ephemeralPort();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../server-node/src/two-gateway-dev.ts", import.meta.url))], {
      env: { ...process.env, POSTGRES_URL: databaseUrl!, REALTIME_SERVER_PORT: String(port), REALTIME_TEST_STARTUP_FAILURE: "after_gateway_a" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`startup failure child timed out: ${stderr}`)); }, 15_000);
      child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    expect(exit.code).not.toBe(0);
    expect(stderr).toContain("RT_TEST_STARTUP_FAILURE_AFTER_GATEWAY_A");
    const started = Date.now();
    while (Date.now() - started < 2_000) {
      const active = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name IN ('gateway-a','gateway-b','two-gateway-harness')");
      if (active.rows[0]?.count === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name IN ('gateway-a','gateway-b','two-gateway-harness')")).rows[0]?.count).toBe(0);
    await expect(new Promise<void>((resolve, reject) => { const server = createNetServer(); server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(() => resolve())); })).resolves.toBeUndefined();
  });

  it("settles an in-flight gateway acquisition before signal-driven startup cleanup", async () => {
    const port = await ephemeralPort();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../server-node/src/two-gateway-dev.ts", import.meta.url))], {
      env: { ...process.env, POSTGRES_URL: databaseUrl!, REALTIME_SERVER_PORT: String(port), REALTIME_TEST_STARTUP_SIGNAL: "before_gateway_spawn" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`startup signal child timed out: ${stderr}`)); }, 15_000);
      child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    expect(exit).toEqual({ code: 0, signal: null });
    const started = Date.now();
    while (Date.now() - started < 2_000) {
      const active = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name IN ('gateway-a','gateway-b','two-gateway-harness')");
      if (active.rows[0]?.count === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name IN ('gateway-a','gateway-b','two-gateway-harness')")).rows[0]?.count).toBe(0);
    await expect(new Promise<void>((resolve, reject) => { const server = createNetServer(); server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(() => resolve())); })).resolves.toBeUndefined();
  });

  it("continues proxy and pool cleanup after a gateway cleanup failure", async () => {
    const port = await ephemeralPort();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../server-node/src/two-gateway-dev.ts", import.meta.url))], {
      env: { ...process.env, POSTGRES_URL: databaseUrl!, REALTIME_SERVER_PORT: String(port), REALTIME_TEST_SHUTDOWN_FAILURE: "after_gateway_exit" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const started = Date.now();
    while (!stdout.includes('"twoGatewayProxyReady":true') && Date.now() - started < 15_000) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!stdout.includes('"twoGatewayProxyReady":true')) { child.kill("SIGKILL"); throw new Error(`startup timed out: ${stderr}`); }
    expect(await fetch(`http://127.0.0.1:${port}/internal/shutdown`, { method: "POST" }).then((response) => response.status)).toBe(202);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`cleanup failure child timed out: ${stderr}`)); }, 15_000);
      child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    expect(exit).toEqual({ code: 1, signal: null });
    expect(stderr).toContain("RT_RUNTIME_SHUTDOWN_INCOMPLETE");
    const cleanupStarted = Date.now();
    while (Date.now() - cleanupStarted < 2_000) {
      const active = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name IN ('gateway-a','gateway-b','two-gateway-harness')");
      if (active.rows[0]?.count === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name IN ('gateway-a','gateway-b','two-gateway-harness')")).rows[0]?.count).toBe(0);
    await expect(new Promise<void>((resolve, reject) => { const server = createNetServer(); server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(() => resolve())); })).resolves.toBeUndefined();
  });
});

async function waitForWireMessage(messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("wire message timed out");
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}

async function prewarmPool(pool: Pool, connectionCount: number): Promise<void> {
  const acquisitions = await Promise.allSettled(Array.from({ length: connectionCount }, () => pool.connect()));
  const warmed = acquisitions.flatMap((acquisition) => acquisition.status === "fulfilled" ? [acquisition.value] : []);
  for (const client of warmed) client.release();
  const failedAcquisition = acquisitions.find((acquisition) => acquisition.status === "rejected");
  if (failedAcquisition?.status === "rejected") throw failedAcquisition.reason;
}

async function ephemeralPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ephemeral port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
