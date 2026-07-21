import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgresEventLog } from "@realtime/store-postgres";
import { doctor, type EvidenceRecord, type ProducerInstance } from "@realtime/diagnostics";
import { Pool } from "pg";
import { signDemoCredential, type AuthenticatedPrincipal } from "./demo-auth.ts";
import { classifyProducerTermination, type ProducerTermination, waitForProcessExit } from "./process-termination.ts";

const execFileAsync = promisify(execFile);
const host = "127.0.0.1";
const proxyPort = Number(process.env.REALTIME_SERVER_PORT ?? 43_170);
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) throw new Error("REALTIME_SERVER_PORT must be an integer from 1 to 65535");
const browserOriginPort = Number(process.env.REALTIME_DEMO_PORT ?? 43_171);
if (!Number.isSafeInteger(browserOriginPort) || browserOriginPort < 1 || browserOriginPort > 65_535) throw new Error("REALTIME_DEMO_PORT must be an integer from 1 to 65535");

interface GatewayProcess {
  id: "gateway-a" | "gateway-b";
  bootId: string;
  port: number;
  child: ChildProcess;
}

const containerName = process.env.REALTIME_POSTGRES_CONTAINER_NAME ?? `better-realtime-two-gateway-${process.pid}`;
if (!/^better-realtime-two-gateway-[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(containerName)) throw new Error("REALTIME_POSTGRES_CONTAINER_NAME must be a scoped Better Realtime harness name");
const harnessOwnerToken = process.env.REALTIME_HARNESS_OWNER_TOKEN ?? crypto.randomUUID();
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(harnessOwnerToken)) throw new Error("REALTIME_HARNESS_OWNER_TOKEN must be a scoped token");
const topologyId = `topology_${crypto.randomUUID()}`;
const demoAuthKey = crypto.randomUUID() + crypto.randomUUID();
const fixturePrincipals = {
  team: { tenantId: "tenant-demo", authenticationRealm: "demo", issuer: "recovery-demo", subject: "team-incident", permissions: ["room:42:read", "room:42:write"] },
  load: { tenantId: "tenant-demo", authenticationRealm: "demo", issuer: "recovery-demo", subject: "load-principal", permissions: ["room:42:read"] },
  foreign: { tenantId: "tenant-demo", authenticationRealm: "demo", issuer: "recovery-demo", subject: "different-principal", permissions: [] }
} satisfies Record<string, AuthenticatedPrincipal>;
let ownedContainerId: string | undefined;
let postgresUrl = process.env.POSTGRES_URL;
let pool: Pool;
let store: PostgresEventLog;
const gateways = new Map<GatewayProcess["id"], GatewayProcess>();
const evidenceArchive: Array<Record<string, unknown>> = [];
const expectedTopology: Array<{ producerRole: "server"; runtimeId: string; runtimeBootId: string; termination: ProducerTermination }> = [];
const pendingAcquisitions = new Set<Promise<unknown>>();
let routeEnabled = true;
let preferred: GatewayProcess["id"] = "gateway-a";
let lastActive: GatewayProcess["id"] = "gateway-a";
let sigkillEvidenceMissing = false;
let proxy: ReturnType<typeof createServer> | undefined;
let shutdownRequested = false;
let shutdownPromise: Promise<void> | undefined;
let chaosQueue: Promise<void> = Promise.resolve();

function trackAcquisition<T>(operation: Promise<T>): Promise<T> {
  const tracked = operation.finally(() => pendingAcquisitions.delete(tracked));
  pendingAcquisitions.add(tracked);
  return tracked;
}

const shutdown = async (exitProcess = true) => {
  shutdownRequested = true;
  routeEnabled = false;
  shutdownPromise ??= (async () => {
    const cleanupFailures: unknown[] = [];
    while (pendingAcquisitions.size > 0) await Promise.allSettled([...pendingAcquisitions]);
    for (const result of await Promise.allSettled([...gateways.values()].map((gateway) => stopGateway(gateway, false)))) if (result.status === "rejected") cleanupFailures.push(result.reason);
    if (proxy?.listening) {
      try { await new Promise<void>((resolve, reject) => proxy!.close((error) => error ? reject(error) : resolve())); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (pool) {
      try { await pool.end(); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (ownedContainerId) {
      try { await execFileAsync("docker", ["rm", "-f", "-v", "--", ownedContainerId]); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "RT_RUNTIME_SHUTDOWN_INCOMPLETE");
  })();
  await shutdownPromise;
  if (exitProcess) process.exit(0);
};
const shutdownAndExit = () => { void shutdown().catch((error) => { console.error(error); process.exit(1); }); };
process.on("SIGINT", shutdownAndExit);
process.on("SIGTERM", shutdownAndExit);

if (!postgresUrl) {
  try {
    const created = await trackAcquisition(execFileAsync("docker", ["run", "--rm", "-d", "--name", containerName, "--label", `better-realtime.harness-owner=${harnessOwnerToken}`, "-e", "POSTGRES_PASSWORD=realtime", "-e", "POSTGRES_DB=realtime", "-p", "127.0.0.1::5432", "postgres:18.4-alpine"]));
    const createdContainerId = created.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/.test(createdContainerId)) throw new Error("RT_POSTGRES_CONTAINER_ID_INVALID");
    ownedContainerId = createdContainerId;
    if (shutdownRequested) throw new Error("RT_RUNTIME_SHUTTING_DOWN");
    const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
    const mappedPort = Number(stdout.trim().split(":").at(-1));
    if (!Number.isSafeInteger(mappedPort) || mappedPort < 1) throw new Error("could not resolve PostgreSQL host port");
    postgresUrl = ["postgresql://", `postgres:realtime@127.0.0.1:${mappedPort}/realtime`].join("");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await execFileAsync("docker", ["exec", containerName, "pg_isready", "-U", "postgres", "-d", "realtime"]); break; }
      catch { if (attempt === 39) throw new Error("PostgreSQL 18.4 did not become ready"); await delay(250); }
    }
  } catch (error) {
    await shutdown(false);
    throw error;
  }
}

pool = new Pool({ connectionString: postgresUrl, max: 8, connectionTimeoutMillis: 1_000, statement_timeout: 1_000, query_timeout: 1_000, application_name: "two-gateway-harness" });
store = new PostgresEventLog(pool, undefined, {}, { schema: "better_realtime_demo" });
pool.on("error", (error) => {
  store.recorder.record({
    kind: "database.pool_idle_error",
    boundary: "database.operation_failed",
    outcome: "failure",
    reasonCode: "RT_DATABASE_UNAVAILABLE",
    component: "two-gateway-harness",
    componentVersion: "0.2.0",
    details: { operation: "harness_pool_idle_connection", error: error.message }
  });
});
try {
  await initializeStore();
  await seedRoom();
  await store.publishOutbox({ limit: 100 });
  if (process.env.REALTIME_TEST_STARTUP_FAILURE === "after_gateway_a") {
    await startGateway("gateway-a");
    throw new Error("RT_TEST_STARTUP_FAILURE_AFTER_GATEWAY_A");
  }
  await Promise.all([startGateway("gateway-a"), startGateway("gateway-b")]);
  if (shutdownRequested) throw new Error("RT_RUNTIME_SHUTTING_DOWN");
  proxy = createServer((incoming, response) => { void handleHttp(incoming, response); });
  proxy.on("upgrade", (incoming, clientSocket, head) => { void proxyUpgrade(incoming, clientSocket, head); });
  if (shutdownRequested) throw new Error("RT_RUNTIME_SHUTTING_DOWN");
  await new Promise<void>((resolve, reject) => { proxy!.once("error", reject); proxy!.listen(proxyPort, host, () => { proxy!.off("error", reject); resolve(); }); });
  if (shutdownRequested) throw new Error("RT_RUNTIME_SHUTTING_DOWN");
  console.log(JSON.stringify({ twoGatewayProxyReady: true, port: proxyPort, postgres: "18.4", gateways: [...gateways.values()].map(({ id, bootId, port }) => ({ id, bootId, port })) }));
} catch (error) {
  await shutdown(false);
  throw error;
}

function startGateway(id: GatewayProcess["id"]): Promise<GatewayProcess> {
  return trackAcquisition(startGatewayOwned(id));
}

async function startGatewayOwned(id: GatewayProcess["id"]): Promise<GatewayProcess> {
  if (shutdownRequested) throw new Error("RT_RUNTIME_SHUTTING_DOWN");
  const existing = gateways.get(id);
  if (existing && existing.child.exitCode === null && existing.child.signalCode === null) return existing;
  const port = await ephemeralPort();
  if (process.env.REALTIME_TEST_STARTUP_SIGNAL === "before_gateway_spawn" && id === "gateway-a") {
    process.kill(process.pid, "SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (shutdownRequested) throw new Error("RT_RUNTIME_SHUTTING_DOWN");
  const bootId = `boot_${id}_${crypto.randomUUID()}`;
  const childArguments = [...(process.env.REALTIME_BENCHMARK_GC === "1" ? ["--expose-gc"] : []), "--import", "tsx", fileURLToPath(new URL("./postgres-gateway-process.ts", import.meta.url))];
  const child = spawn(process.execPath, childArguments, {
    env: { ...process.env, POSTGRES_URL: postgresUrl!, REALTIME_GATEWAY_PORT: String(port), REALTIME_GATEWAY_ID: id, REALTIME_GATEWAY_BOOT_ID: bootId, REALTIME_TOPOLOGY_ID: topologyId, REALTIME_IDENTITY_KEY_V1: "demo-identity-key-version-1", REALTIME_IDENTITY_KEY_V2: "demo-identity-key-version-2", REALTIME_DEMO_AUTH_KEY: demoAuthKey, REALTIME_ALLOWED_ORIGINS: `http://${host}:${browserOriginPort}`, REALTIME_ALLOW_MISSING_ORIGIN: "1", REALTIME_POSTGRES_SCHEMA: "better_realtime_demo" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const gateway = { id, bootId, port, child };
  gateways.set(id, gateway);
  expectedTopology.push({ producerRole: "server", runtimeId: id, runtimeBootId: bootId, termination: "running" });
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${id}] ${String(chunk)}`));
  try {
    await waitForReady(child, id, bootId);
    if (shutdownRequested) throw new Error("RT_RUNTIME_SHUTTING_DOWN");
    return gateway;
  } catch (error) {
    await stopGateway(gateway, false).catch(() => undefined);
    throw error;
  }
}

async function stopGateway(gateway: GatewayProcess, captureEvidence: boolean): Promise<void> {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
  let evidenceCaptured = false;
  if (captureEvidence) {
    await post(gateway, "/internal/chaos/drain").catch(() => undefined);
    await delay(75);
    const evidence = await getJson(gateway, "/internal/evidence").catch(() => undefined);
    if (evidence) { evidenceArchive.push(evidence); evidenceCaptured = true; }
  }
  gateway.child.kill("SIGTERM");
  const observation = await waitForProcessExit(gateway.child, 2_000);
  if (!captureEvidence && process.env.REALTIME_TEST_SHUTDOWN_FAILURE === "after_gateway_exit") throw new Error(`RT_TEST_GATEWAY_CLEANUP_FAILURE:${gateway.id}`);
  if (!captureEvidence) return;
  const topology = [...expectedTopology].reverse().find((entry) => entry.runtimeId === gateway.id && entry.runtimeBootId === gateway.bootId);
  const termination = classifyProducerTermination(observation, evidenceCaptured);
  if (topology) topology.termination = termination;
  if (termination !== "graceful") sigkillEvidenceMissing = true;
}

async function sigkillGateway(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
  sigkillEvidenceMissing = true;
  const topology = [...expectedTopology].reverse().find((entry) => entry.runtimeId === gateway.id && entry.runtimeBootId === gateway.bootId);
  if (topology) topology.termination = "sigkill";
  gateway.child.kill("SIGKILL");
  await waitForProcessExit(gateway.child, 2_000);
}

async function handleHttp(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  if (incoming.method === "POST" && incoming.url === "/internal/shutdown") {
    json(response, 202, { accepted: true });
    setImmediate(shutdownAndExit);
    return;
  }
  if (incoming.method === "GET" && incoming.url === "/health") {
    const ready = routeEnabled && Boolean(await selectReadyGateway());
    json(response, ready ? 200 : 503, { status: ready ? "ready" : "unready", active: lastActive, topology: expectedTopology });
    return;
  }
  if (incoming.method === "GET" && incoming.url === "/api/inspect") {
    const inspections = await Promise.all([...gateways.values()].map(async (gateway) => ({ id: gateway.id, bootId: gateway.bootId, ...(await getJson(gateway, "/api/inspect").catch(() => ({ status: "unavailable" }))) })));
    json(response, 200, { accepting: routeEnabled, activeGateway: lastActive, gateways: inspections, topology: expectedTopology, doctor: await assembledDoctor(), resources: { sessions: inspections.reduce((total, item) => total + Number(((item as Record<string, unknown>).resources as { sessions?: number } | undefined)?.sessions ?? 0), 0) } });
    return;
  }
  if (incoming.method === "GET" && incoming.url === "/api/evidence") {
    const live = await Promise.all([...gateways.values()].map((gateway) => getJson(gateway, "/internal/evidence").catch(() => undefined)));
    json(response, 200, { expectedTopology, sigkillEvidenceMissing, archived: evidenceArchive.map(publicEvidenceBundle), live: live.filter((bundle): bundle is Record<string, unknown> => Boolean(bundle)).map(publicEvidenceBundle), database: { runtimeId: store.recorder.runtimeId, runtimeBootId: store.recorder.runtimeBootId, records: store.recorder.records().map(publicEvidenceRecord) }, doctor: await assembledDoctor(live.filter((bundle): bundle is Record<string, unknown> => Boolean(bundle))) });
    return;
  }
  if (incoming.method === "GET" && incoming.url?.startsWith("/api/credential/")) {
    const profile = incoming.url.slice("/api/credential/".length) as keyof typeof fixturePrincipals;
    const principal = fixturePrincipals[profile];
    if (!principal) { json(response, 404, { error: "unknown fixture credential" }); return; }
    json(response, 200, { type: "demo", credential: signDemoCredential(principal, demoAuthKey) });
    return;
  }
  if (incoming.method === "POST" && incoming.url?.startsWith("/api/chaos/")) {
    const action = incoming.url.slice("/api/chaos/".length);
    const operation = chaosQueue.then(() => chaos(action));
    chaosQueue = operation.catch(() => undefined);
    await operation;
    json(response, 200, { ok: true, action, activeGateway: lastActive });
    return;
  }
  json(response, 404, { error: "not found" });
}

async function assembledDoctor(providedLive?: Record<string, unknown>[]) {
  const live = providedLive ?? (await Promise.all([...gateways.values()].map((gateway) => getJson(gateway, "/internal/evidence").catch(() => undefined)))).filter((bundle): bundle is Record<string, unknown> => Boolean(bundle));
  const bundles = [...evidenceArchive, ...live];
  const unique = new Map<string, EvidenceRecord>();
  let droppedRecords = 0;
  let evictedRecords = 0;
  for (const bundle of bundles) {
    for (const record of [...asRecords(bundle.records), ...asRecords(bundle.databaseRecords)]) unique.set(record.recordId, record);
    const stats = bundle.stats as { droppedRecords?: number; evictedRecords?: number } | undefined;
    const databaseStats = bundle.databaseStats as { droppedRecords?: number; evictedRecords?: number } | undefined;
    droppedRecords += (stats?.droppedRecords ?? 0) + (databaseStats?.droppedRecords ?? 0);
    evictedRecords += (stats?.evictedRecords ?? 0) + (databaseStats?.evictedRecords ?? 0);
  }
  const records = [...unique.values()];
  const unavailable = [...expectedTopology].reverse().find((entry) => entry.termination === "sigkill" || entry.termination === "evidence_missing");
  if (unavailable) {
    const recovery = [...expectedTopology].reverse().find((entry) => entry.termination === "running" && entry.runtimeId !== unavailable.runtimeId);
    const expected = [unavailable, ...(recovery ? [recovery] : [])].map(asProducerInstance);
    return doctor({ records, expectedBoundaries: expected.map((instance) => ({ ...instance, boundary: "gateway.ready" })), expectedProducers: ["server"], expectedProducerInstances: expected, unavailableProducerInstances: [asProducerInstance(unavailable)], scope: { traceId: topologyId }, droppedRecords, evictedRecords, expectedOutcome: "state converges without claiming evidence from an unavailable producer instance" });
  }
  const drains = records.filter((record) => record.boundary === "gateway.drain_started" && record.causalHandoffId);
  for (const drain of drains.toReversed()) {
    const replay = records.find((record) => record.boundary === "replay.selected" && record.causalHandoffId === drain.causalHandoffId && producerInstanceKey(record) !== producerInstanceKey(drain));
    if (!replay) continue;
    const expected: ProducerInstance[] = [toInstance(drain), toInstance(replay)];
    return doctor({ records, expectedBoundaries: [{ ...expected[0]!, boundary: "gateway.drain_started" }, { ...expected[1]!, boundary: "replay.selected" }], expectedProducers: ["server"], expectedProducerInstances: expected, scope: { causalHandoffId: drain.causalHandoffId! }, droppedRecords, evictedRecords, expectedOutcome: "Gateway A hands recovery to Gateway B through explicit cursor causality", requireCausalHandoffs: true });
  }
  const running = [...expectedTopology].filter((entry) => entry.termination === "running").slice(-2).map(asProducerInstance);
  return doctor({ records, expectedBoundaries: running.map((instance) => ({ ...instance, boundary: "gateway.ready" })), expectedProducers: ["server"], expectedProducerInstances: running, scope: { traceId: topologyId }, droppedRecords, evictedRecords, expectedOutcome: "both expected gateway instances are ready" });
}

function asRecords(value: unknown): EvidenceRecord[] { return Array.isArray(value) ? value as EvidenceRecord[] : []; }
function publicEvidenceBundle(bundle: Record<string, unknown>): Record<string, unknown> { return { ...bundle, records: asRecords(bundle.records).filter((record) => record.boundary !== "authorization.denied").map(publicEvidenceRecord), databaseRecords: asRecords(bundle.databaseRecords).map(publicEvidenceRecord) }; }
function publicEvidenceRecord(record: EvidenceRecord): EvidenceRecord { const { details: originalDetails, ...rest } = record; const details = originalDetails ? Object.fromEntries(Object.entries(originalDetails).filter(([key]) => key !== "principalNamespaceId")) : undefined; return { ...rest, ...(details ? { details } : {}) }; }
function asProducerInstance(value: { producerRole: "server"; runtimeId: string; runtimeBootId: string }): ProducerInstance { return { producerRole: value.producerRole, runtimeId: value.runtimeId, runtimeBootId: value.runtimeBootId }; }
function toInstance(record: EvidenceRecord): ProducerInstance { return { producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId }; }
function producerInstanceKey(value: EvidenceRecord | ProducerInstance): string { return `${value.producerRole}:${value.runtimeId}:${value.runtimeBootId}`; }

async function chaos(action: string): Promise<void> {
  const active = gateways.get(lastActive) ?? selectGateway();
  if (action === "stop") {
    routeEnabled = false;
    if (active) await stopGateway(active, true);
    await appendRoomMessage("System", "Missed while Gateway A drained: event A.");
    await appendRoomMessage("System", "Missed while Gateway A drained: event B.");
    preferred = active?.id === "gateway-a" ? "gateway-b" : "gateway-a";
    return;
  }
  if (action === "restart") {
    const stoppedId = active?.id ?? (preferred === "gateway-a" ? "gateway-b" : "gateway-a");
    const otherId = stoppedId === "gateway-a" ? "gateway-b" : "gateway-a";
    if (!gateways.get(otherId) || gateways.get(otherId)!.child.exitCode !== null || gateways.get(otherId)!.child.signalCode !== null) await startGateway(otherId);
    preferred = otherId;
    await post(gateways.get(otherId)!, "/internal/chaos/interleave-replay");
    routeEnabled = true;
    void startGateway(stoppedId);
    return;
  }
  if (action === "sigkill") {
    if (active) await sigkillGateway(active);
    await appendRoomMessage("System", "Recovered after abrupt gateway SIGKILL.");
    const otherId = active?.id === "gateway-a" ? "gateway-b" : "gateway-a";
    if (!gateways.get(otherId) || gateways.get(otherId)!.child.exitCode !== null || gateways.get(otherId)!.child.signalCode !== null) await startGateway(otherId);
    preferred = otherId;
    routeEnabled = true;
    return;
  }
  if (action === "miss-notify") {
    if (!active) throw new Error("no active gateway");
    await post(active, "/internal/chaos/drop-notification");
    await appendRoomMessage("System", "Recovered from a deliberately missed NOTIFY wake-up.");
    await store.publishOutbox({ limit: 100 });
    return;
  }
  if (action === "db-outage") {
    if (!ownedContainerId) throw new Error("DB outage injection requires the managed PostgreSQL container");
    await execFileAsync("docker", ["pause", ownedContainerId]);
    setTimeout(() => { void recoverDatabaseOutage(); }, 1_250);
    return;
  }
  if (action === "burst") {
    const payload = "x".repeat(4_000);
    for (let index = 0; index < 2_000; index += 1) await appendRoomMessage("Load", `${index}:${payload}`);
    await store.publishOutbox({ limit: 1_000 });
    return;
  }
  if (!active) throw new Error("no active gateway");
  if (action === "duplicate") await post(active, "/internal/chaos/duplicate");
  else if (action === "expire-cursor") await post(active, "/internal/chaos/expire-cursor");
  else if (action === "lose-ack") await post(active, "/internal/chaos/lose-ack");
}

async function recoverDatabaseOutage(): Promise<void> {
  if (!ownedContainerId) return;
  await execFileAsync("docker", ["unpause", ownedContainerId]).catch(() => undefined);
  await delay(250);
  for (const gateway of [...gateways.values()]) {
    if (gateway.child.exitCode === null && gateway.child.signalCode === null) await stopGateway(gateway, true);
  }
  await Promise.all([startGateway("gateway-a"), startGateway("gateway-b")]);
  preferred = "gateway-a";
  routeEnabled = true;
}

async function proxyUpgrade(incoming: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
  const gateway = await selectReadyGateway();
  if (!routeEnabled || !gateway) { clientSocket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); clientSocket.destroy(); return; }
  lastActive = gateway.id;
  const upstream = httpRequest({ host, port: gateway.port, path: incoming.url, method: incoming.method, headers: incoming.headers });
  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n`;
    const headers = upstreamResponse.rawHeaders.reduce((value, item, index, all) => index % 2 === 0 ? `${value}${item}: ${all[index + 1]}\r\n` : value, "");
    clientSocket.write(`${statusLine}${headers}\r\n`);
    if (upstreamHead.length) clientSocket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    clientSocket.once("close", () => upstreamSocket.destroy());
    clientSocket.once("error", () => upstreamSocket.destroy());
    clientSocket.once("end", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => clientSocket.destroy());
    upstreamSocket.once("error", () => clientSocket.destroy());
    upstreamSocket.once("end", () => clientSocket.destroy());
    clientSocket.pipe(upstreamSocket).pipe(clientSocket);
  });
  upstream.on("response", (upstreamResponse) => { clientSocket.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 503} Service Unavailable\r\nConnection: close\r\n\r\n`); clientSocket.destroy(); });
  upstream.on("error", () => clientSocket.destroy());
  upstream.end();
}

function selectGateway(): GatewayProcess | undefined {
  const first = gateways.get(preferred);
  if (first && first.child.exitCode === null && first.child.signalCode === null) return first;
  return [...gateways.values()].find((gateway) => gateway.child.exitCode === null && gateway.child.signalCode === null);
}

async function selectReadyGateway(): Promise<GatewayProcess | undefined> {
  const candidates = [gateways.get(preferred), ...[...gateways.values()].filter((gateway) => gateway.id !== preferred)].filter((gateway): gateway is GatewayProcess => Boolean(gateway));
  for (const gateway of candidates) {
    if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) continue;
    const health = await getJson(gateway, "/health").catch(() => undefined);
    if (health?.status === "ready") return gateway;
  }
  return undefined;
}

async function seedRoom(): Promise<void> {
  if (await store.head("tenant-demo", "room:42")) return;
  await appendRoomMessage("Ava", "Monitoring the PostgreSQL deployment boundary.");
  await appendRoomMessage("Mateo", "Two gateway replay checkpoint established.");
  await appendRoomMessage("You", "Ready to prove cross-process recovery.");
}

async function initializeStore(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      await store.migrate({ contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
      await store.migrateDemoApplication();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("PostgreSQL initialization did not become stable");
}

async function appendRoomMessage(author: string, text: string): Promise<void> {
  const sentAt = new Date().toISOString();
  await store.appendEvent({ appendId: `append_${crypto.randomUUID()}`, tenantId: "tenant-demo", stream: "room:42", eventType: "messageAdded", schema: "messageAdded@1", data: { author, text, sentAt }, effectSchema: "roomMessageInsert@1", effect: { author, text, sentAt }, mutate: async (database, sequence, eventId) => {
    await database.query(`INSERT INTO "${store.storage.schema}".realtime_room_messages (tenant_id, stream, sequence, event_id, author, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ["tenant-demo", "room:42", sequence, eventId, author, text, sentAt]);
  } });
}

async function post(gateway: GatewayProcess, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://${host}:${gateway.port}${path}`, { method: "POST" });
  if (!response.ok) throw new Error(`${gateway.id} ${path} failed: ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function getJson(gateway: GatewayProcess, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://${host}:${gateway.port}${path}`);
  if (!response.ok) throw new Error(`${gateway.id} ${path} failed: ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function ephemeralPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate gateway port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForReady(child: ChildProcess, id: string, bootId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error(`${id} did not become ready`)), 15_000);
    child.once("exit", (code, signal) => { clearTimeout(timeout); reject(new Error(`${id} exited before ready: ${code ?? signal}`)); });
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split("\n").slice(0, -1)) {
        try {
          const parsed = JSON.parse(line) as { gatewayReady?: boolean; runtimeBootId?: string };
          if (parsed.gatewayReady && parsed.runtimeBootId === bootId) { clearTimeout(timeout); resolve(); }
        } catch { /* child logs are not readiness evidence */ }
      }
      buffer = buffer.includes("\n") ? buffer.slice(buffer.lastIndexOf("\n") + 1) : buffer;
    });
  });
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
