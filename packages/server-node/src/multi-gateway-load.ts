import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { FlightRecorder } from "@realtime/diagnostics";

const host = "127.0.0.1";
const proxyPort = await ephemeralPort();
const execFileAsync = promisify(execFile);
const loadContainerName = `better-realtime-two-gateway-load-${process.pid}`;
const harnessOwnerToken = randomUUID();
async function main(): Promise<void> {
const ownedClients = new Set<LoadClient>();
const createClient = (index: number, auth: Record<string, unknown>, initialCursor?: string | null) => { const client = new LoadClient(index, proxyPort, auth, initialCursor); ownedClients.add(client); return client; };
const server = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./two-gateway-dev.ts", import.meta.url))], { env: { ...process.env, REALTIME_SERVER_PORT: String(proxyPort), REALTIME_BENCHMARK_GC: "1", REALTIME_BENCHMARK_RETENTION: "1", REALTIME_POSTGRES_CONTAINER_NAME: loadContainerName, REALTIME_HARNESS_OWNER_TOKEN: harnessOwnerToken }, stdio: ["ignore", "pipe", "pipe"] });
let harnessOutput = "";
server.stdout?.on("data", (chunk) => { harnessOutput = `${harnessOutput}${String(chunk)}`.slice(-4_096); });
server.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));
try {
await waitForHarness(server, proxyPort);
const loadAuth = await fetchJson(proxyPort, "/api/credential/load") as Record<string, unknown>;
const teamAuth = await fetchJson(proxyPort, "/api/credential/team") as Record<string, unknown>;

const clientCount = 100;
const clients = Array.from({ length: clientCount }, (_, index) => createClient(index, loadAuth));
const startedConnect = performance.now();
clients.forEach((client) => client.start());
try {
  await Promise.all(clients.map((client) => client.waitForGeneration(1, 20_000)));
} catch (error) {
  const inspect = await fetchJson(proxyPort, "/api/inspect").catch((inspectError) => ({ inspectError: inspectError instanceof Error ? inspectError.message : String(inspectError) }));
  const evidence = await fetchJson(proxyPort, "/api/evidence").catch((evidenceError) => ({ evidenceError: evidenceError instanceof Error ? evidenceError.message : String(evidenceError) }));
  throw new Error(`${error instanceof Error ? error.message : String(error)}; inspect=${JSON.stringify(inspect)}; failureEvidence=${JSON.stringify(summarizeFailureEvidence(evidence))}; harnessOutput=${JSON.stringify(harnessOutput)}`);
}
const connect100Ms = performance.now() - startedConnect;
if (process.env.REALTIME_LOAD_INJECT_FAILURE_AFTER_CONNECT === "1") throw new Error("INJECTED_LOAD_FAILURE_AFTER_CONNECT");

const startedRecovery = performance.now();
await chaos(proxyPort, "stop");
await delay(150);
await chaos(proxyPort, "restart");
await Promise.all(clients.map((client) => client.waitForGeneration(2, 20_000)));
const recovery100Ms = performance.now() - startedRecovery;
const recoveryContinuity = clients.every((client) => !client.gapDetected);
await Promise.all(clients.map((client) => client.stop()));
await waitForLogicalBaseline(proxyPort, 10_000);

await executeBenchmarkCommand(proxyPort, teamAuth);
const commandRetentionObserved = (await gatewaySamples(proxyPort)).some((gateway) => gateway.resources.databaseCommands > 0);
await waitForMaintenanceBaseline(proxyPort, 10_000);

const plateauSamples: GatewaySample[][] = [];
for (let round = 0; round < 10; round += 1) {
  const roundClients = Array.from({ length: clientCount }, (_, index) => createClient(round * clientCount + index, loadAuth));
  roundClients.forEach((client) => client.start());
  await Promise.all(roundClients.map((client) => client.waitForGeneration(1, 20_000)));
  await Promise.all(roundClients.map((client) => client.stop()));
  await waitForLogicalBaseline(proxyPort, 10_000);
  if (round === 4) await waitForMaintenanceBaseline(proxyPort, 15_000);
  await delay(250);
  const sample = await gatewaySamples(proxyPort);
  if (round >= 5) plateauSamples.push(sample);
}

const slow = createClient(10_000, loadAuth);
slow.start();
await slow.waitForGeneration(1, 10_000);
const slowBaselineSequence = slow.sequence;
const slowBaselineCursor = slow.cursor;
slow.pauseReads();
const preBurstSamples = await gatewaySamples(proxyPort);
const burstResourceSamples: GatewaySample[][] = [];
const burstStarted = performance.now();
let burstComplete = false;
let burstFailure: unknown;
const burstOperation = chaos(proxyPort, "burst").catch((error) => { burstFailure = error; }).finally(() => { burstComplete = true; });
while (!burstComplete) {
  await delay(100);
  burstResourceSamples.push(await gatewaySamples(proxyPort));
}
await burstOperation;
if (burstFailure) throw burstFailure;
burstResourceSamples.push(await gatewaySamples(proxyPort));
await delay(2_000);
slow.resumeReads();
await slow.waitForGeneration(2, 20_000);
await slow.waitForSequence(slowBaselineSequence + 2_000, 20_000);
const burstMs = performance.now() - burstStarted;
await slow.stop();
await waitForLogicalBaseline(proxyPort, 10_000);

const targetSequence = slowBaselineSequence + 2_000;
const fresh = createClient(10_001, loadAuth);
fresh.start();
await fresh.waitForGeneration(1, 20_000);
await fresh.waitForSequence(targetSequence, 20_000);
const freshSnapshotRecovery = !fresh.gapDetected;
await fresh.stop();
if (!slowBaselineCursor) throw new Error("slow-consumer baseline cursor was not established");
await chaos(proxyPort, "expire-cursor");
const expired = createClient(10_002, loadAuth, slowBaselineCursor);
expired.start();
await expired.waitForGeneration(1, 20_000);
await expired.waitForSequence(targetSequence, 20_000);
const cursorExpirySnapshotRecovery = !expired.gapDetected;
await expired.stop();
await waitForLogicalBaseline(proxyPort, 10_000);
const postBurstSettledSamples: GatewaySample[][] = [];
for (let sampleIndex = 0; sampleIndex < 4; sampleIndex += 1) { await delay(250); postBurstSettledSamples.push(await gatewaySamples(proxyPort)); }

const evidence = await fetchJson(proxyPort, "/api/evidence") as { live?: Array<{ records?: Array<{ boundary?: string; outcome?: string; details?: { pages?: number } }> }> };
const slowConsumerObserved = (evidence.live ?? []).some((bundle) => (bundle.records ?? []).some((record) => record.boundary === "slow_consumer.disconnected"));
const slowConsumerContinuity = !slow.gapDetected;
const multiPageReplayObserved = (evidence.live ?? []).some((bundle) => (bundle.records ?? []).some((record) => record.boundary === "event.catchup_completed" && record.outcome === "success" && Number(record.details?.pages) >= 2));
const firstPlateau = plateauSamples[0]!;
const lastPlateau = plateauSamples.at(-1)!;
const sessionPlateau = plateauSamples.slice(1).every((sample) => sample.every((gateway) => gateway.resources.sessions === 0));
const socketPlateau = plateauSamples.slice(1).every((sample) => sample.every((gateway) => gateway.resources.sockets === 0));
const subscriptionPlateau = plateauSamples.slice(1).every((sample) => sample.every((gateway) => gateway.resources.subscriptions === 0));
const bufferPlateau = plateauSamples.slice(1).every((sample) => sample.every((gateway) => gateway.resources.buffers === 0));
const commandPlateau = plateauSamples.slice(1).every((sample) => sample.every((gateway) => gateway.resources.commands === 0));
const databaseResourcePlateau = plateauSamples.slice(1).every((sample) => sample.every((gateway) => {
  const baseline = plateauSamples[0]?.find((candidate) => candidate.id === gateway.id && candidate.bootId === gateway.bootId);
  return Boolean(baseline) && gateway.resources.databaseCommands === baseline?.resources.databaseCommands && gateway.resources.outboxRows === baseline.resources.outboxRows && gateway.resources.pendingOutboxRows === baseline.resources.pendingOutboxRows && gateway.resources.transactionAttempts === baseline.resources.transactionAttempts;
}));
const timerPlateau = plateauSamples.slice(1).every((sample) => sample.every((gateway) => {
  const baseline = plateauSamples[0]?.find((candidate) => candidate.id === gateway.id && candidate.bootId === gateway.bootId);
  return Boolean(baseline) && gateway.resources.timers === baseline?.resources.timers;
}));
const logicalPlateau = sessionPlateau && socketPlateau && subscriptionPlateau && timerPlateau && bufferPlateau && commandPlateau && databaseResourcePlateau;
const recorderPlateau = lastPlateau.every((gateway) => {
  const first = firstPlateau.find((candidate) => candidate.id === gateway.id && candidate.bootId === gateway.bootId);
  return !first || (gateway.resources.recorder === first.resources.recorder && gateway.resources.databaseRecorder === first.resources.databaseRecorder && gateway.databaseRecorder.records === gateway.databaseRecorder.limits.maxRecords && gateway.databaseRecorder.bytes <= gateway.databaseRecorder.limits.maxBytes && Math.abs(gateway.databaseRecorder.bytes - first.databaseRecorder.bytes) <= Math.ceil(gateway.databaseRecorder.limits.maxBytes * 0.025) && gateway.databaseRecorder.evictedRecords >= first.databaseRecorder.evictedRecords);
});
const heapPlateau = lastPlateau.every((gateway) => {
  const first = firstPlateau.find((candidate) => candidate.id === gateway.id && candidate.bootId === gateway.bootId);
  return !first || gateway.process.heapUsed <= Math.max(first.process.heapUsed * 1.2, first.process.heapUsed + 3_000_000);
});
const handlePlateau = firstPlateau.every((first) => {
  const samples = plateauSamples.map((sample) => sample.find((candidate) => candidate.id === first.id && candidate.bootId === first.bootId)).filter((sample): sample is GatewaySample => Boolean(sample));
  const fixedKeys = new Set(samples.flatMap((sample) => Object.keys(sample.process.handles)).filter((key) => key !== "TCPSocketWrap" && key !== "Timeout"));
  const fixedStable = samples.every((sample) => [...fixedKeys].every((key) => (sample.process.handles[key] ?? 0) === (first.process.handles[key] ?? 0)));
  const tcpCounts = samples.map((sample) => sample.process.handles.TCPSocketWrap ?? 0);
  const timeoutCounts = samples.map((sample) => sample.process.handles.Timeout ?? 0);
  const boundedNonGrowth = (counts: number[], absoluteLimit: number) => Math.max(...counts) <= absoluteLimit && Math.max(...counts) - Math.min(...counts) <= 2 && counts.at(-1)! <= counts[0]! + 1;
  return fixedStable && boundedNonGrowth(tcpCounts, 10) && boundedNonGrowth(timeoutCounts, 16);
});
const environmentFingerprint = `${platform()}-${arch()}-node${process.versions.node.split(".")[0]}-postgres18.4-${cpus().length}cpu`;
const burstEvents = 2_000;
const burstEventsPerSecond = burstEvents / (burstMs / 1_000);
const allSamples = [...plateauSamples, ...burstResourceSamples].flat();
const lastBurstSamples = burstResourceSamples.at(-1) ?? [];
const maxBurstCpuUserDeltaMicros = Math.max(0, ...lastBurstSamples.map((sample) => sample.process.cpuUsage.user - (preBurstSamples.find((before) => before.id === sample.id && before.bootId === sample.bootId)?.process.cpuUsage.user ?? sample.process.cpuUsage.user)));
const maxBurstCpuSystemDeltaMicros = Math.max(0, ...lastBurstSamples.map((sample) => sample.process.cpuUsage.system - (preBurstSamples.find((before) => before.id === sample.id && before.bootId === sample.bootId)?.process.cpuUsage.system ?? sample.process.cpuUsage.system)));
const flatPostBurstSettledSamples = postBurstSettledSamples.flat();
const maxPostBurstSettledHeapUsedBytes = Math.max(...flatPostBurstSettledSamples.map((sample) => sample.process.heapUsed));
const maxPostBurstSettledRssBytes = Math.max(...flatPostBurstSettledSamples.map((sample) => sample.process.rss));
const maxHeapUsedBytes = Math.max(...allSamples.map((sample) => sample.process.heapUsed));
const maxRssBytes = Math.max(...allSamples.map((sample) => sample.process.rss));
const maxDiagnosticRecords = Math.max(...allSamples.map((sample) => sample.recorder.records + sample.databaseRecorder.records));
const maxDiagnosticBytes = Math.max(...allSamples.map((sample) => sample.recorder.bytes + sample.databaseRecorder.bytes));
const maxTransactionAttempts = Math.max(...allSamples.map((sample) => sample.resources.transactionAttempts));
const maxTransactionAttemptsThreshold = burstEvents + clientCount * 3 + 250;
const maxCpuUserMicros = Math.max(...allSamples.map((sample) => sample.process.cpuUsage.user));
const maxCpuSystemMicros = Math.max(...allSamples.map((sample) => sample.process.cpuUsage.system));
const diagnosticOverhead = measureDiagnosticOverhead();
const thresholds = { connect100Ms: 10_000, recovery100Ms: 10_000, burstMs: 15_000, minBurstEventsPerSecond: 100, maxHeapUsedBytes: 64_000_000, maxRssBytes: 512_000_000, maxPostBurstSettledHeapUsedBytes: 64_000_000, maxPostBurstSettledRssBytes: 512_000_000, maxPostBurstSampleGrowthBytes: 32_000_000, maxCpuUserMicros: 25_000_000, maxCpuSystemMicros: 6_000_000, maxBurstCpuUserDeltaMicros: 12_000_000, maxBurstCpuSystemDeltaMicros: 3_000_000, maxDiagnosticOverheadMicrosPerRecord: 10 };
const thresholdFingerprint = "darwin-arm64-node22-postgres18.4-12cpu";
const performanceThresholdApplicable = environmentFingerprint === thresholdFingerprint;
const postBurstResourceBound = maxPostBurstSettledHeapUsedBytes <= thresholds.maxPostBurstSettledHeapUsedBytes && maxPostBurstSettledRssBytes <= thresholds.maxPostBurstSettledRssBytes && postBurstSettledSamples.at(-1)!.every((last) => {
  const first = postBurstSettledSamples[0]!.find((sample) => sample.id === last.id && sample.bootId === last.bootId);
  return Boolean(first) && last.process.heapUsed <= first!.process.heapUsed + thresholds.maxPostBurstSampleGrowthBytes && last.process.rss <= first!.process.rss + thresholds.maxPostBurstSampleGrowthBytes;
});
const transactionAttemptBound = maxTransactionAttempts <= maxTransactionAttemptsThreshold && postBurstSettledSamples.at(-1)!.every((last) => {
  const first = postBurstSettledSamples[0]!.find((sample) => sample.id === last.id && sample.bootId === last.bootId);
  return Boolean(first) && last.resources.transactionAttempts === first!.resources.transactionAttempts;
});
const performanceRegressionAlarm = !performanceThresholdApplicable || (connect100Ms <= thresholds.connect100Ms && recovery100Ms <= thresholds.recovery100Ms && burstMs <= thresholds.burstMs && burstEventsPerSecond >= thresholds.minBurstEventsPerSecond && maxHeapUsedBytes <= thresholds.maxHeapUsedBytes && maxRssBytes <= thresholds.maxRssBytes && maxPostBurstSettledHeapUsedBytes <= thresholds.maxPostBurstSettledHeapUsedBytes && maxPostBurstSettledRssBytes <= thresholds.maxPostBurstSettledRssBytes && maxCpuUserMicros <= thresholds.maxCpuUserMicros && maxCpuSystemMicros <= thresholds.maxCpuSystemMicros && maxBurstCpuUserDeltaMicros <= thresholds.maxBurstCpuUserDeltaMicros && maxBurstCpuSystemDeltaMicros <= thresholds.maxBurstCpuSystemDeltaMicros && diagnosticOverhead.overheadMicrosPerRecord <= thresholds.maxDiagnosticOverheadMicrosPerRecord);
const report = { schemaVersion: "1.0", environmentFingerprint, profile: { clients: clientCount, transport: "Node ws", gateways: 2, database: "postgres:18.4-alpine", burstEvents }, measurements: { connect100Ms, recovery100Ms, burstMs, burstEventsPerSecond, maxHeapUsedBytes, maxRssBytes, maxPostBurstSettledHeapUsedBytes, maxPostBurstSettledRssBytes, maxCpuUserMicros, maxCpuSystemMicros, maxBurstCpuUserDeltaMicros, maxBurstCpuSystemDeltaMicros, burstResourceSamples: burstResourceSamples.length, postBurstSettledSamples: postBurstSettledSamples.length, maxDiagnosticRecords, maxDiagnosticBytes, maxTransactionAttempts, diagnosticOverhead }, thresholds: { ...thresholds, maxTransactionAttempts: maxTransactionAttemptsThreshold, fingerprint: thresholdFingerprint, applicable: performanceThresholdApplicable, classification: "same-fingerprint initial regression alarm, not a production SLO" }, verdicts: { logicalPlateau, sessionPlateau, socketPlateau, subscriptionPlateau, timerPlateau, bufferPlateau, commandPlateau, databaseResourcePlateau, transactionAttemptBound, commandRetentionObserved, heapPlateau, handlePlateau, recorderPlateau, postBurstResourceBound, recoveryContinuity, slowConsumerObserved, slowConsumerContinuity, multiPageReplayObserved, freshSnapshotRecovery, cursorExpirySnapshotRecovery, performanceRegressionAlarm }, plateauSamples };
console.log(JSON.stringify(report, null, 2));

if (!logicalPlateau || !transactionAttemptBound || !commandRetentionObserved || !heapPlateau || !handlePlateau || !recorderPlateau || !postBurstResourceBound || !recoveryContinuity || !slowConsumerObserved || !slowConsumerContinuity || !multiPageReplayObserved || !freshSnapshotRecovery || !cursorExpirySnapshotRecovery || !performanceRegressionAlarm) process.exitCode = 1;
} finally {
  await Promise.all([...ownedClients].map((client) => client.stop()));
  await stopHarness(server, loadContainerName, harnessOwnerToken);
}
}

interface GatewaySample {
  id: string;
  bootId: string;
  resources: { sessions: number; sockets: number; subscriptions: number; timers: number; buffers: number; commands: number; databaseCommands: number; outboxRows: number; pendingOutboxRows: number; transactionAttempts: number; recorder: number; databaseRecorder: number };
  recorder: { records: number; bytes: number; evictedRecords: number; evictedBytes: number; limits: { maxRecords: number; maxBytes: number; maxAgeMs: number } };
  databaseRecorder: { records: number; bytes: number; evictedRecords: number; evictedBytes: number; limits: { maxRecords: number; maxBytes: number; maxAgeMs: number } };
  process: { heapUsed: number; rss: number; cpuUsage: { user: number; system: number }; handles: Record<string, number> };
}

class LoadClient {
  #socket: WebSocket | undefined;
  #stopped = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #cursor: string | null = null;
  #waiters: Array<{ generation: number; resolve: () => void }> = [];
  #sequence = 0;
  #gapDetected = false;
  #sequenceWaiters: Array<{ sequence: number; resolve: () => void }> = [];
  #lastBoundary = "not_connected";
  constructor(private readonly index: number, private readonly port: number, private readonly auth: Record<string, unknown>, initialCursor?: string | null) { this.#cursor = initialCursor ?? null; }

  get sequence(): number { return this.#sequence; }
  get cursor(): string | null { return this.#cursor; }
  get gapDetected(): boolean { return this.#gapDetected; }

  start(): void { this.#connect(); }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => { socket.terminate(); finish(); }, 2_000);
      socket.once("close", finish);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "load lifecycle complete");
    });
  }
  pauseReads(): void { (this.#socket as unknown as { _socket?: { pause(): void } } | undefined)?._socket?.pause(); }
  resumeReads(): void { (this.#socket as unknown as { _socket?: { resume(): void } } | undefined)?._socket?.resume(); }

  waitForGeneration(generation: number, timeoutMs: number): Promise<void> {
    if (this.#generation >= generation) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`client ${this.index} did not reach generation ${generation}; last boundary: ${this.#lastBoundary}`)), timeoutMs);
      this.#waiters.push({ generation, resolve: () => { clearTimeout(timeout); resolve(); } });
    });
  }

  waitForSequence(sequence: number, timeoutMs: number): Promise<void> {
    if (this.#sequence >= sequence) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`client ${this.index} did not reach sequence ${sequence}`)), timeoutMs);
      this.#sequenceWaiters.push({ sequence, resolve: () => { clearTimeout(timeout); resolve(); } });
    });
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(`ws://${host}:${this.port}/ws`, "better-realtime.v1", { perMessageDeflate: false });
    this.#socket = socket;
    socket.on("open", () => { this.#lastBoundary = "transport.open"; socket.send(JSON.stringify(envelope({ kind: "session.open", connectionAttemptId: `load-${this.index}-${crypto.randomUUID()}`, contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: this.auth }))); });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      this.#lastBoundary = typeof message.kind === "string" ? message.kind : "message.unknown";
      if (message.kind === "session.ready") socket.send(JSON.stringify(envelope({ kind: "stream.subscribe", requestId: `request-${this.index}-${crypto.randomUUID()}`, stream: "room:42", input: { roomId: "42" }, after: this.#cursor })));
      else if (message.kind === "heartbeat.ping") socket.send(JSON.stringify(envelope({ kind: "heartbeat.pong", pingId: message.pingId })));
      else if (message.kind === "event" && typeof message.cursor === "string") { this.#cursor = message.cursor; if (typeof message.sequence === "number") this.#advanceSequence(message.sequence); }
      else if (message.kind === "stream.snapshot" && typeof message.cursor === "string") { this.#cursor = message.cursor; if (typeof (message.state as { sequence?: unknown } | undefined)?.sequence === "number") this.#advanceSequence((message.state as { sequence: number }).sequence); }
      else if (message.kind === "stream.replay.complete" || (message.kind === "stream.subscribed" && message.mode === "live")) {
        this.#generation += 1;
        const pending = this.#waiters.filter((waiter) => waiter.generation <= this.#generation);
        this.#waiters = this.#waiters.filter((waiter) => waiter.generation > this.#generation);
        pending.forEach((waiter) => waiter.resolve());
      }
    });
    socket.on("error", (error) => { this.#lastBoundary = `transport.error:${error.message}`; });
    socket.on("close", (code) => {
      this.#lastBoundary = `transport.close:${code}`;
      if (this.#stopped) return;
      this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = undefined; this.#connect(); }, 50 + (this.index % 25));
    });
  }

  #advanceSequence(sequence: number): void {
    if (this.#sequence > 0 && sequence > this.#sequence + 1) this.#gapDetected = true;
    this.#sequence = Math.max(this.#sequence, sequence);
    const pending = this.#sequenceWaiters.filter((waiter) => waiter.sequence <= this.#sequence);
    this.#sequenceWaiters = this.#sequenceWaiters.filter((waiter) => waiter.sequence > this.#sequence);
    pending.forEach((waiter) => waiter.resolve());
  }
}

const envelope = (message: Record<string, unknown>) => ({ protocol: "1.0", messageId: `load-msg-${crypto.randomUUID()}`, sentAt: new Date().toISOString(), ...message });

async function gatewaySamples(port: number): Promise<GatewaySample[]> {
  const inspect = await fetchJson(port, "/api/inspect") as { gateways: GatewaySample[] };
  return inspect.gateways.filter((gateway) => gateway.process && gateway.resources);
}

async function waitForLogicalBaseline(port: number, timeoutMs: number): Promise<void> {
  const started = performance.now();
  while (true) {
    const samples = await gatewaySamples(port);
    if (samples.length > 0 && samples.every((sample) => sample.resources.sessions === 0 && sample.resources.subscriptions === 0 && sample.resources.sockets === 0 && sample.resources.buffers === 0 && (sample.process.handles.TCPSocketWrap ?? 0) <= 10)) return;
    if (performance.now() - started > timeoutMs) throw new Error("gateway resources did not return to baseline");
    await delay(50);
  }
}

async function waitForMaintenanceBaseline(port: number, timeoutMs: number): Promise<void> {
  const started = performance.now();
  while (true) {
    const samples = await gatewaySamples(port);
    if (samples.length > 0 && samples.every((sample) => sample.resources.databaseCommands === 0 && sample.resources.outboxRows === 0 && sample.resources.pendingOutboxRows === 0)) return;
    if (performance.now() - started > timeoutMs) throw new Error("database retention resources did not reach the steady baseline");
    await delay(100);
  }
}

async function chaos(port: number, action: string): Promise<void> {
  const response = await fetch(`http://${host}:${port}/api/chaos/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(`chaos ${action} failed: ${response.status}`);
}

async function executeBenchmarkCommand(port: number, auth: Record<string, unknown>): Promise<void> {
  const socket = new WebSocket(`ws://${host}:${port}/ws`, "better-realtime.v1", { perMessageDeflate: false });
  const commandId = `load-command-${crypto.randomUUID()}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("benchmark command did not complete")), 10_000);
      socket.on("open", () => socket.send(JSON.stringify(envelope({ kind: "session.open", connectionAttemptId: `load-command-open-${crypto.randomUUID()}`, contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth }))));
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.kind === "session.ready") socket.send(JSON.stringify(envelope({ kind: "command", commandAttemptId: `${commandId}:attempt:1`, sessionGeneration: message.sessionGeneration, commandId, type: "sendMessage", schema: "sendMessage@1", input: { roomId: "42", text: "gateway maintenance retention probe" }, createdAt: new Date().toISOString() })));
        else if (message.kind === "heartbeat.ping") socket.send(JSON.stringify(envelope({ kind: "heartbeat.pong", pingId: message.pingId })));
        else if (message.kind === "command.completed" && message.commandId === commandId) { clearTimeout(timeout); resolve(); }
      });
      socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
    });
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "benchmark command complete");
    if (socket.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => { const timeout = setTimeout(() => { socket.terminate(); resolve(); }, 1_000); socket.once("close", () => { clearTimeout(timeout); resolve(); }); });
  }
}

async function fetchJson(port: number, path: string): Promise<unknown> {
  const response = await fetch(`http://${host}:${port}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

async function waitForHarness(child: ChildProcess, port: number): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 30_000) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("two-gateway harness exited before load");
    try { const response = await fetch(`http://${host}:${port}/health`); if (response.ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error("two-gateway harness did not become ready");
}

async function stopHarness(child: ChildProcess, containerName: string, ownerToken: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(5_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const inspection = await execFileAsync("docker", ["inspect", "--format", "{{.Id}}|{{index .Config.Labels \"better-realtime.harness-owner\"}}", containerName]).catch(() => undefined);
  if (!inspection) return;
  const [containerId, observedOwner] = inspection.stdout.trim().split("|");
  if (!containerId || !/^[a-f0-9]{12,64}$/u.test(containerId) || observedOwner !== ownerToken) throw new Error("RT_DOCKER_HARNESS_OWNERSHIP_MISMATCH");
  await execFileAsync("docker", ["rm", "-f", "-v", "--", containerId]);
}

async function ephemeralPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate load port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function summarizeFailureEvidence(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const live = (value as { live?: Array<{ runtime?: unknown; records?: Array<Record<string, unknown>>; databaseRecords?: Array<Record<string, unknown>> }> }).live ?? [];
  const relevant = new Set(["database.operation_failed", "capability.health_changed", "database.transaction_outcome_indeterminate", "database.transaction_reconciliation_unresolved", "db.rolled_back"]);
  return live.map((bundle) => ({ runtime: bundle.runtime, records: [...(bundle.records ?? []), ...(bundle.databaseRecords ?? [])].filter((record) => relevant.has(String(record.boundary))).slice(-12) }));
}
function measureDiagnosticOverhead(): { records: number; baselineMs: number; recorderMs: number; overheadMicrosPerRecord: number } {
  const records = 10_000;
  const baselineStarted = performance.now();
  for (let index = 0; index < records; index += 1) JSON.stringify({ index, boundary: "benchmark" });
  const baselineMs = performance.now() - baselineStarted;
  const recorder = new FlightRecorder({ runtimeId: "diagnostic-overhead", producerRole: "tool", limits: { maxRecords: 1_000, maxBytes: 2_000_000, maxAgeMs: 60_000 } });
  const recorderStarted = performance.now();
  for (let index = 0; index < records; index += 1) recorder.record({ kind: "benchmark", boundary: "benchmark", outcome: "success", component: "load-harness", componentVersion: "1", details: { index } });
  const recorderMs = performance.now() - recorderStarted;
  return { records, baselineMs, recorderMs, overheadMicrosPerRecord: Math.max(0, recorderMs - baselineMs) * 1_000 / records };
}

await main();
