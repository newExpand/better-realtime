import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { startConsumerTestProxy, type WireTranscriptEntry } from "./consumer-test-proxy.ts";
import { assertIdempotencyRetry, canonicalCapabilityProfile } from "./compatibility-wire-assertions.ts";
import { packMcp } from "./pack-mcp.ts";
import { packRuntime } from "./pack-runtime.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const artifactDirectory = resolve(process.env.BETTER_REALTIME_CONSUMER_OUTPUT ?? join(root, "output/consumer-e2e"));
const packageArtifactDirectory = await mkdtemp(join(tmpdir(), "realtime-consumer-artifact-"));
const suppliedClientTarball = process.env.BETTER_REALTIME_CLIENT_TARBALL?.trim();
const suppliedServerTarball = process.env.BETTER_REALTIME_SERVER_TARBALL?.trim();
const suppliedMcpTarball = process.env.BETTER_REALTIME_MCP_TARBALL?.trim();
const generatedTarball = suppliedClientTarball && suppliedServerTarball ? undefined : (await packRuntime(packageArtifactDirectory)).tarball;
const generatedMcpTarball = generatedTarball && !suppliedMcpTarball ? (await packMcp(packageArtifactDirectory)).tarball : undefined;
const clientTarball = resolve(suppliedClientTarball || generatedTarball!);
const serverTarball = resolve(suppliedServerTarball || generatedTarball!);
const mcpTarball = suppliedMcpTarball ? resolve(suppliedMcpTarball) : generatedMcpTarball;
const clientRoom = await mkdtemp(join(tmpdir(), "realtime-browser-client-"));
const serverRoom = await mkdtemp(join(tmpdir(), "realtime-browser-server-"));
const containerName = `realtime-consumer-pg-${process.pid}`;
let containerId: string | undefined;
const children: ChildProcess[] = [];
let proxy: Awaited<ReturnType<typeof startConsumerTestProxy>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    cp(join(root, "fixtures/external-consumer"), clientRoom, { recursive: true }),
    cp(join(root, "fixtures/external-consumer"), serverRoom, { recursive: true })
  ]);
  await Promise.all([
    exec("npm", ["install", "--ignore-scripts", clientTarball], { cwd: clientRoom, maxBuffer: 20 * 1024 * 1024 }),
    exec("npm", ["install", "--ignore-scripts", serverTarball, ...(mcpTarball ? [mcpTarball] : [])], { cwd: serverRoom, maxBuffer: 20 * 1024 * 1024 })
  ]);
  await exec("npm", ["run", "build"], { cwd: clientRoom, maxBuffer: 20 * 1024 * 1024 });
  progress("clean-room-built");

  const createdContainer = await docker(["run", "--detach", "--name", containerName, "--env", "POSTGRES_PASSWORD=realtime", "--env", "POSTGRES_USER=realtime", "--env", "POSTGRES_DB=realtime", "--publish", "127.0.0.1::5432", "postgres:18.4-alpine"], 30_000);
  const createdContainerId = createdContainer.stdout.trim();
  if (!/^[a-f0-9]{12,64}$/u.test(createdContainerId)) throw new Error("RT_POSTGRES_CONTAINER_ID_INVALID");
  containerId = createdContainerId;
  const portResult = await docker(["port", containerName, "5432/tcp"]);
  const databasePort = Number(portResult.stdout.trim().split(":").at(-1));
  if (!Number.isSafeInteger(databasePort)) throw new Error("RT_POSTGRES_PORT_INVALID");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await docker(["exec", containerName, "pg_isready", "--host", "127.0.0.1", "--port", "5432", "--username", "realtime", "--dbname", "realtime"], 2_000); break; }
    catch { if (attempt === 59) throw new Error("RT_POSTGRES_NOT_READY"); await delay(250); }
  }
  const proxyPort = await ephemeralPort();
  const databaseUrl = ["postgresql://", `realtime:realtime@127.0.0.1:${databasePort}/realtime`].join("");
  const environment = { ...process.env, RUNTIME_DATABASE_URL: databaseUrl, IDENTITY_KEY: "consumer-e2e-stable-identity-key-32-bytes", PORT: "0", APP_ORIGIN: `http://127.0.0.1:${proxyPort}` };
  await exec(process.execPath, ["--import", "tsx", "src/migrate.ts"], { cwd: serverRoom, env: { ...environment, MIGRATION_DATABASE_URL: databaseUrl }, maxBuffer: 20 * 1024 * 1024 });
  progress("deployment-migration-complete");
  const gatewayA = await startGateway(serverRoom, { ...environment, RUNTIME_ID: "consumer-gateway-a" }, (child) => children.push(child));
  const gatewayB = await startGateway(serverRoom, { ...environment, RUNTIME_ID: "consumer-gateway-b" }, (child) => children.push(child));
  progress("gateways-ready");

  proxy = await startConsumerTestProxy({ staticRoot: join(clientRoom, "dist"), gateways: [gatewayA.webSocketUrl, gatewayB.webSocketUrl], port: proxyPort });
  browser = await chromium.launch({ headless: true });
  const videoDirectory = join(artifactDirectory, "video");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: videoDirectory, size: { width: 1440, height: 900 } } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(proxy.baseUrl, { waitUntil: "networkidle" });
  progress("browser-loaded");
  await page.getByTestId("connection").waitFor();
  try { await expectText(page, "connection", /open\/ready/u); }
  catch (error) {
    const evidence = await fetch(gatewayA.webSocketUrl.replace(/^ws:/u, "http:").replace(/\/ws$/u, "/internal/evidence")).then((response) => response.text()).catch((fetchError) => String(fetchError));
    throw new Error(`${error instanceof Error ? error.message : String(error)}:gateway=${evidence.slice(-4000)}:process=${gatewayA.process.exitCode}:${gatewayA.errors()}`);
  }
  await expectText(page, "stream", /live at 0/u);
  progress("initial-live");

  await page.getByRole("textbox", { name: "Message", exact: true }).fill("before gateway interruption");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("before gateway interruption").waitFor();
  if (await page.getByText("before gateway interruption").count() !== 1) throw new Error("RT_CONSUMER_DUPLICATE_EVENT");
  progress("first-command");

  gatewayA.process.kill("SIGKILL");
  await waitUntil(() => proxy!.state.selectedGateways.includes(gatewayB.webSocketUrl), 10_000, "RT_GATEWAY_HANDOFF_TIMEOUT");
  await expectText(page, "connection", /open\/ready/u);
  progress("gateway-handoff");

  proxy.dropNextCommandCompletion();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("after ACK loss");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("after ACK loss").waitFor({ timeout: 15_000 });
  await waitUntil(() => Boolean(proxy!.state.droppedCommandId), 10_000, "RT_ACK_LOSS_NOT_INJECTED");
  if (await page.getByText("after ACK loss").count() !== 1) throw new Error("RT_CONSUMER_ACK_LOSS_DUPLICATE");
  await expectText(page, "stream", /live at 2/u);
  await expectText(page, "command", /^Commandobserved \/ pending 0$/u);
  progress("ack-loss-recovered");
  await page.screenshot({ path: join(artifactDirectory, "desktop.png"), fullPage: true });

  const narrow = await context.newPage();
  narrow.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`narrow:${message.text()}`); });
  narrow.on("pageerror", (error) => consoleErrors.push(`narrow:${error.message}`));
  await narrow.setViewportSize({ width: 390, height: 844 });
  await narrow.goto(proxy.baseUrl, { waitUntil: "networkidle" });
  await expectText(narrow, "stream", /live at 2/u);
  await narrow.screenshot({ path: join(artifactDirectory, "narrow.png"), fullPage: true });
  await narrow.close();
  const commandId = proxy.state.droppedCommandId!;
  const clientEvidence = await page.evaluate((selectedCommandId) => {
    const dogfood = globalThis as typeof globalThis & { __BETTER_REALTIME_DOGFOOD_EVIDENCE__?: Array<{ commandId?: string }>; __BETTER_REALTIME_DOGFOOD_EVIDENCE_STATUS__?: () => { capacity: number; retainedRecords: number; evictedRecords: number } };
    const records = dogfood.__BETTER_REALTIME_DOGFOOD_EVIDENCE__ ?? [];
    const record = records.find((candidate) => candidate.commandId === selectedCommandId);
    return record && dogfood.__BETTER_REALTIME_DOGFOOD_EVIDENCE_STATUS__ ? { record, buffer: dogfood.__BETTER_REALTIME_DOGFOOD_EVIDENCE_STATUS__() } : undefined;
  }, commandId);
  if (!clientEvidence) throw new Error("RT_BROWSER_COMMAND_EVIDENCE_MISSING");
  await context.tracing.stop({ path: join(artifactDirectory, "trace.zip") });
  const video = page.video();
  await context.close();
  progress("browser-artifacts-closed");
  const videoPath = video ? await video.path() : undefined;
  if (!videoPath) throw new Error("RT_BROWSER_VIDEO_MISSING");

  const wireSemantics = assertWireSemantics(proxy.state.transcript, commandId);
  const idempotency = await verifyServerIdempotency(gatewayB.webSocketUrl, proxy.baseUrl, proxy.state.transcript, databaseUrl);
  const serverRejections = await verifyPublicServerRejections(gatewayB.webSocketUrl, proxy.baseUrl);
  const evidencePath = join(artifactDirectory, "evidence.json");
  await requestEvidence(gatewayB.process, evidencePath, commandId, clientEvidence);
  const cli = await exec(join(serverRoom, "node_modules/.bin/better-realtime"), ["doctor", "--format", "json", "--source", evidencePath, "--tenant", "tenant-fixture"], { cwd: serverRoom });
  const cliResult = JSON.parse(cli.stdout);
  const mcpClient = new Client({ name: "consumer-acceptance", version: "1.0.0" });
  const mcpTransport = new StdioClientTransport({ command: join(serverRoom, "node_modules/.bin/better-realtime-mcp"), cwd: serverRoom, env: stringEnvironment({ ...process.env, REALTIME_EVIDENCE_FILE: evidencePath, REALTIME_TENANT_ID: "tenant-fixture" }), stderr: "pipe" });
  await mcpClient.connect(mcpTransport);
  const mcpResponse = await mcpClient.callTool({ name: "realtime_doctor", arguments: {} });
  const content = mcpResponse.content as Array<{ type: string; text?: string }>;
  const mcpResult = JSON.parse(content[0]?.type === "text" ? content[0].text ?? "null" : "null");
  await mcpClient.close();
  if (JSON.stringify(cliResult) !== JSON.stringify(mcpResult)) throw new Error("RT_DIAGNOSTIC_SURFACE_DIVERGED");
  if (cliResult.report?.verdict !== "proven" || cliResult.completeness?.status !== "complete") throw new Error("RT_CONSUMER_DIAGNOSIS_NOT_PROVEN");
  const closure = cliResult.report?.evidenceClosure;
  const databaseProof = closure?.[0];
  const serverProof = closure?.[1];
  const clientProof = closure?.[2];
  if (!Array.isArray(closure) || closure.length !== 3 || databaseProof?.boundary !== "db.committed" || serverProof?.boundary !== "command.completed" || clientProof?.boundary !== "command.observed" || !databaseProof.transactionId || !databaseProof.operationCorrelationId || !databaseProof.eventId || databaseProof.eventId !== serverProof.eventId || databaseProof.eventId !== clientProof.eventId || !databaseProof.causalHandoffId || databaseProof.causalHandoffId !== serverProof.causalHandoffId || databaseProof.causalHandoffId !== clientProof.causalHandoffId || !["commit_acknowledgement", "durable_transaction_attempt_marker"].includes(databaseProof.proofSource) || cliResult.evidenceReference?.recordCount !== 3 || !cliResult.report?.completeness?.observedProducers?.includes("client")) throw new Error("RT_CONSUMER_DIAGNOSTIC_PROVENANCE_INVALID");
  progress("diagnostics-matched");
  if (consoleErrors.length) throw new Error(`RT_BROWSER_CONSOLE_ERROR:${consoleErrors.join("|")}`);
  const [clientPackageBytes, serverPackageBytes] = await Promise.all([
    statFiles(join(clientRoom, "node_modules/better-realtime/dist")).then((entries) => entries.reduce((sum, entry) => sum + entry.bytes, 0)),
    statFiles(join(serverRoom, "node_modules/better-realtime/dist")).then((entries) => entries.reduce((sum, entry) => sum + entry.bytes, 0))
  ]);
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", matrixCase: process.env.BETTER_REALTIME_MATRIX_CASE ?? "candidate-to-candidate", clientArtifact: basename(clientTarball), serverArtifact: basename(serverTarball), postgres: "18.4", gateways: proxy.state.selectedGateways, interruption: "SIGKILL", ackLossCommandId: commandId, messages: 2, wireSemantics: { ...wireSemantics, ...idempotency }, serverRejections, diagnosis: { cli: cliResult.report.verdict, mcp: mcpResult.report.verdict, completeness: cliResult.completeness.status }, browser: { consoleErrors: 0, desktopScreenshot: join(artifactDirectory, "desktop.png"), narrowScreenshot: join(artifactDirectory, "narrow.png"), trace: join(artifactDirectory, "trace.zip"), video: videoPath }, installedBundleBytes: { client: clientPackageBytes, server: serverPackageBytes } })}\n`);
} finally {
  progress("cleanup-start");
  if (browser) await browser.close().catch(() => undefined);
  progress("cleanup-browser");
  if (proxy) await proxy.close().catch(() => undefined);
  progress("cleanup-proxy");
  await Promise.all(children.map((child) => stopChild(child)));
  if (containerId) await docker(["rm", "--force", "--volumes", "--", containerId], 10_000).catch(() => undefined);
  await rm(clientRoom, { recursive: true, force: true });
  await rm(serverRoom, { recursive: true, force: true });
  await rm(packageArtifactDirectory, { recursive: true, force: true });
  progress("cleanup-complete");
}

async function startGateway(cwd: string, env: NodeJS.ProcessEnv, onSpawn: (child: ChildProcess) => void): Promise<{ process: ChildProcess; webSocketUrl: string; errors(): string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], { cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  onSpawn(child);
  let errors = "";
  child.stderr?.on("data", (chunk) => { errors += chunk.toString(); });
  const ready = await new Promise<{ webSocketUrl: string }>((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`RT_GATEWAY_START_TIMEOUT:${errors}`)), 20_000);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`RT_GATEWAY_EXITED:${code}:${errors}`)); });
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        try { const value = JSON.parse(line) as { kind?: string; webSocketUrl?: string }; if (value.kind === "gateway.ready" && value.webSocketUrl) { clearTimeout(timeout); resolveReady({ webSocketUrl: value.webSocketUrl }); } } catch { /* wait for complete JSON line */ }
      }
    });
  });
  return { process: child, webSocketUrl: ready.webSocketUrl, errors: () => errors };
}

async function requestEvidence(child: ChildProcess, path: string, commandId: string, clientEvidence: unknown): Promise<void> {
  await new Promise<void>((resolveEvidence, reject) => {
    const timeout = setTimeout(() => reject(new Error("RT_EVIDENCE_WRITE_TIMEOUT")), 5_000);
    const listener = (message: unknown) => { if (message && typeof message === "object" && "type" in message && message.type === "evidence-written") { clearTimeout(timeout); child.off("message", listener); resolveEvidence(); } };
    child.on("message", listener);
    child.send?.({ type: "write-evidence", path, commandId, clientEvidence });
  });
}

async function expectText(page: import("@playwright/test").Page, testId: string, expected: RegExp): Promise<void> {
  try { await page.getByTestId(testId).filter({ hasText: expected }).waitFor({ timeout: 15_000 }); }
  catch (error) { throw new Error(`RT_BROWSER_STATE_TIMEOUT:${testId}:${await page.getByTestId(testId).textContent()}:${error instanceof Error ? error.message : String(error)}`); }
}

async function waitUntil(condition: () => boolean, timeoutMs: number, code: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (Date.now() >= deadline) throw new Error(code); await delay(50); }
}

async function ephemeralPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RT_EPHEMERAL_PORT_UNAVAILABLE");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function delay(milliseconds: number) { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
function docker(args: string[], timeout = 10_000) { return exec("docker", args, { timeout, maxBuffer: 20 * 1024 * 1024 }); }
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, 2_000)) throw new Error(`RT_GATEWAY_PROCESS_CLEANUP_FAILED:${child.pid ?? "unknown"}`);
}
async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => { child.off("exit", exited); resolveExit(false); }, timeoutMs);
    const exited = () => { clearTimeout(timeout); resolveExit(true); };
    child.once("exit", exited);
  });
}
function progress(stage: string) { process.stderr.write(`[consumer-e2e] ${stage}\n`); }
function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }

function assertWireSemantics(transcript: WireTranscriptEntry[], droppedCommandId: string): Record<string, unknown> {
  const messages = transcript.filter((entry) => entry.messageId);
  if (new Set(messages.map((entry) => entry.messageId)).size !== messages.length) throw new Error("RT_COMPAT_WIRE_MESSAGE_ID_REUSED");
  const commands = transcript.filter((entry) => entry.direction === "client_to_server" && entry.kind === "command");
  const commandIds = [...new Set(commands.map((entry) => entry.commandId))];
  if (commands.length !== 2 || commandIds.length !== 2 || commandIds.includes(undefined) || commands.some((entry) => !entry.commandAttemptId || entry.commandAttemptId === entry.commandId)) throw new Error("RT_COMPAT_COMMAND_IDENTITY_DRIFT");
  if (new Set(commands.map((entry) => entry.commandAttemptId)).size !== commands.length) throw new Error("RT_COMPAT_COMMAND_ATTEMPT_ID_REUSED");
  for (const commandId of commandIds as string[]) {
    if (!transcript.some((entry) => entry.kind === "command.receipt" && entry.commandId === commandId && entry.state === "accepted")) throw new Error(`RT_COMPAT_COMMAND_RECEIPT_MISSING:${commandId}`);
    const event = transcript.find((entry) => entry.kind === "event" && entry.commandId === commandId);
    const completion = transcript.find((entry) => entry.kind === "command.completed" && entry.commandId === commandId);
    if (!event?.eventId || completion?.causalEventIds?.[0] !== event.eventId) throw new Error(`RT_COMPAT_COMMAND_CAUSAL_COMPLETION_DRIFT:${commandId}`);
  }
  if (!transcript.some((entry) => entry.kind === "command.status.request" && entry.commandId === droppedCommandId) || !transcript.some((entry) => entry.kind === "command.status" && entry.commandId === droppedCommandId && entry.state === "completed")) throw new Error("RT_COMPAT_COMMAND_RECONCILIATION_MISSING");
  const events = transcript.filter((entry) => entry.kind === "event" && commandIds.includes(entry.commandId));
  const ordered = [...new Map(events.map((entry) => [entry.eventId, entry])).values()].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  if (ordered.length !== 2 || ordered[0]?.sequence !== 1 || ordered[1]?.sequence !== 2 || !ordered.every((entry) => typeof entry.cursor === "string") || ordered[0]?.cursor === ordered[1]?.cursor) throw new Error("RT_COMPAT_CURSOR_SEQUENCE_DRIFT");
  const subscriptions = transcript.filter((entry) => entry.kind === "stream.subscribe");
  if (!subscriptions.some((entry) => entry.after === null) || !subscriptions.some((entry) => entry.after === ordered[0]?.cursor) || (ordered[1]?.sessionGeneration ?? 0) <= (ordered[0]?.sessionGeneration ?? 0)) throw new Error(`RT_COMPAT_CURSOR_RECOVERY_NOT_OBSERVED:${JSON.stringify({ subscriptions, ordered })}`);
  const sessions = transcript.filter((entry) => entry.kind === "session.ready");
  if (sessions.length < 3 || sessions.some((entry) => entry.resumeStatus !== "fresh" && entry.resumeStatus !== "unavailable")) throw new Error("RT_COMPAT_SESSION_RECOVERY_DRIFT");
  const capabilityProfiles = sessions.map((entry) => canonicalCapabilityProfile(entry.capabilities));
  if (new Set(capabilityProfiles.map((profile) => JSON.stringify(profile))).size !== 1) throw new Error("RT_COMPAT_CAPABILITY_SEMANTICS_DRIFT");
  return { transcriptRecords: transcript.length, commands: 2, stableCommandIds: true, freshAttemptIds: true, receiptCompletionObserved: true, statusReconciliation: true, cursorContinuity: [1, 2], capabilityProfile: capabilityProfiles[0] };
}

async function verifyServerIdempotency(webSocketUrl: string, origin: string, transcript: WireTranscriptEntry[], databaseUrl: string): Promise<Record<string, boolean>> {
  const contract = transcript.find((entry) => entry.kind === "session.open")?.contract;
  if (!contract) throw new Error("RT_COMPAT_IDEMPOTENCY_CONTRACT_MISSING");
  const socket = new WebSocket(webSocketUrl, "better-realtime.v1", { headers: { Origin: origin } });
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    messages.push(message);
    if (message.kind === "heartbeat.ping" && typeof message.pingId === "string") socket.send(JSON.stringify(envelope("heartbeat.pong", { pingId: message.pingId })));
  });
  await new Promise<void>((resolveOpen, reject) => { socket.once("open", resolveOpen); socket.once("error", reject); });
  try {
    socket.send(JSON.stringify(envelope("session.open", { connectionAttemptId: "compat-idempotency-connection", contract, auth: { type: "fixture", tenantId: "tenant-fixture", subject: "browser-user" } })));
    const ready = await waitForWireMessage(messages, (message) => message.kind === "session.ready", "RT_COMPAT_IDEMPOTENCY_SESSION_TIMEOUT");
    const sessionGeneration = ready.sessionGeneration;
    if (!Number.isSafeInteger(sessionGeneration)) throw new Error("RT_COMPAT_IDEMPOTENCY_SESSION_INVALID");
    const commandId = `compat-idempotency-${process.pid}-${Date.now()}`;
    const attemptIds: [string, string] = [`${commandId}:attempt:1`, `${commandId}:attempt:2`];
    const input = { roomId: "42", text: `idempotency probe ${commandId}`, sentAt: new Date().toISOString() };
    const send = (attemptId: string) => socket.send(JSON.stringify(envelope("command", { commandAttemptId: attemptId, sessionGeneration, commandId, type: "sendMessage", schema: "fixture.chat.send-message.input@1", input, createdAt: new Date().toISOString() })));
    send(attemptIds[0]);
    await waitForWireMessage(messages, (message) => message.kind === "command.receipt" && message.commandId === commandId && message.state === "accepted", "RT_COMPAT_IDEMPOTENCY_FIRST_RECEIPT_TIMEOUT");
    const first = await waitForWireMessage(messages, (message) => message.kind === "command.completed" && message.commandId === commandId, "RT_COMPAT_IDEMPOTENCY_FIRST_COMPLETION_TIMEOUT");
    const firstBoundary = messages.length;
    send(attemptIds[1]);
    await waitForWireMessage(messages, (message, index) => index >= firstBoundary && message.kind === "command.receipt" && message.commandId === commandId && message.state === "accepted", "RT_COMPAT_IDEMPOTENCY_RETRY_RECEIPT_TIMEOUT");
    const retry = await waitForWireMessage(messages, (message, index) => index >= firstBoundary && message.kind === "command.completed" && message.commandId === commandId, "RT_COMPAT_IDEMPOTENCY_RETRY_COMPLETION_TIMEOUT");
    const statusBoundary = messages.length;
    socket.send(JSON.stringify(envelope("command.status.request", { requestId: `${commandId}:status`, commandId })));
    const status = await waitForWireMessage(messages, (message, index) => index >= statusBoundary && message.kind === "command.status" && message.commandId === commandId && message.state === "completed", "RT_COMPAT_IDEMPOTENCY_STATUS_TIMEOUT");
    const postgres = createRequire(join(serverRoom, "package.json"))("pg") as {
      Client: new (options: { connectionString: string }) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(query: string, values: unknown[]): Promise<{ rows: Array<{ command_rows: string; event_rows: string; domain_effect_rows: string; event_id: string | null; domain_event_id: string | null }> }>;
      };
    };
    const database = new postgres.Client({ connectionString: databaseUrl });
    await database.connect();
    try {
      const result = await database.query(`SELECT
        (SELECT count(*) FROM better_realtime.realtime_commands WHERE tenant_id=$1 AND command_id=$2) AS command_rows,
        (SELECT count(*) FROM better_realtime.realtime_events WHERE tenant_id=$1 AND command_id=$2) AS event_rows,
        (SELECT count(*) FROM public.consumer_messages WHERE tenant_id=$1 AND body=$3) AS domain_effect_rows,
        (SELECT event_id FROM better_realtime.realtime_events WHERE tenant_id=$1 AND command_id=$2 LIMIT 1) AS event_id,
        (SELECT event_id FROM public.consumer_messages WHERE tenant_id=$1 AND body=$3 LIMIT 1) AS domain_event_id`, ["tenant-fixture", commandId, input.text]);
      const row = result.rows[0];
      if (!row) throw new Error("RT_COMPAT_IDEMPOTENCY_EFFECT_QUERY_EMPTY");
      return assertIdempotencyRetry(commandId, attemptIds, first, retry, status, { commandRows: Number(row.command_rows), eventRows: Number(row.event_rows), domainEffectRows: Number(row.domain_effect_rows), ...(row.event_id ? { eventId: row.event_id } : {}), ...(row.domain_event_id ? { domainEventId: row.domain_event_id } : {}) });
    } finally { await database.end(); }
  } finally { socket.close(1000, "idempotency probe complete"); }
}

function envelope(kind: string, body: Record<string, unknown>): Record<string, unknown> { return { protocol: "1.0", kind, messageId: `compat-msg-${crypto.randomUUID()}`, sentAt: new Date().toISOString(), ...body }; }
async function waitForWireMessage(messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>, index: number) => boolean, code: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages[index]!;
    if (Date.now() - started > 15_000) throw new Error(code);
    await delay(25);
  }
}

async function verifyPublicServerRejections(webSocketUrl: string, origin: string): Promise<Array<Record<string, string | number>>> {
  const v2 = new WebSocket(webSocketUrl, "better-realtime.v2", { headers: { Origin: origin } });
  const v2Closed = new Promise<{ code: number; reason: string }>((resolveClose, reject) => { v2.once("close", (code, reason) => resolveClose({ code, reason: reason.toString() })); v2.once("error", reject); });
  await new Promise<void>((resolveOpen, reject) => { v2.once("open", resolveOpen); v2.once("error", reject); });
  const v2Result = await v2Closed;
  if (v2Result.code !== 1002 || v2Result.reason !== "subprotocol required") throw new Error(`RT_COMPAT_PUBLIC_SERVER_V2_REJECTION_DRIFT:${JSON.stringify(v2Result)}`);

  const mismatch = new WebSocket(webSocketUrl, "better-realtime.v1", { headers: { Origin: origin } });
  await new Promise<void>((resolveOpen, reject) => { mismatch.once("open", resolveOpen); mismatch.once("error", reject); });
  mismatch.send(JSON.stringify({ protocol: "1.0", kind: "session.open", messageId: "message-compat-mismatch", sentAt: new Date().toISOString(), connectionAttemptId: "attempt-compat-mismatch", contract: { contractId: "different.contract", manifestVersion: "1.0.0", manifestDigest: `sha256:${"a".repeat(64)}` }, auth: { type: "fixture", tenantId: "tenant-fixture", subject: "browser-user" } }));
  const mismatchResult = await new Promise<Record<string, unknown>>((resolveMessage, reject) => { mismatch.once("message", (data) => resolveMessage(JSON.parse(data.toString()) as Record<string, unknown>)); mismatch.once("error", reject); });
  const error = mismatchResult.error as Record<string, unknown> | undefined;
  if (mismatchResult.kind !== "session.rejected" || error?.code !== "RT_CONTRACT_INCOMPATIBLE") throw new Error(`RT_COMPAT_PUBLIC_SERVER_CONTRACT_REJECTION_DRIFT:${JSON.stringify(mismatchResult)}`);
  mismatch.close();
  return [
    { combination: "better-realtime.v2-to-v1-public-server", outcome: "close-1002-subprotocol-required", closeCode: 1002 },
    { combination: "different-contract-to-v1-public-server", outcome: "RT_CONTRACT_INCOMPATIBLE" }
  ];
}
async function statFiles(directory: string): Promise<Array<{ path: string; bytes: number }>> {
  const { readdir, stat } = await import("node:fs/promises");
  const result: Array<{ path: string; bytes: number }> = [];
  for (const name of await readdir(directory)) { const path = join(directory, name); const info = await stat(path); if (info.isDirectory()) result.push(...await statFiles(path)); else result.push({ path, bytes: info.size }); }
  return result;
}
