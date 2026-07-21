import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { startConsumerTestProxy } from "./consumer-test-proxy.ts";
import { packRuntime } from "./pack-runtime.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const artifactDirectory = join(root, "output/consumer-e2e");
const packageArtifactDirectory = await mkdtemp(join(tmpdir(), "realtime-consumer-artifact-"));
const tarball = (await packRuntime(packageArtifactDirectory)).tarball;
const cleanRoom = await mkdtemp(join(tmpdir(), "realtime-browser-consumer-"));
const containerName = `realtime-consumer-pg-${process.pid}`;
let containerId: string | undefined;
const children: ChildProcess[] = [];
let proxy: Awaited<ReturnType<typeof startConsumerTestProxy>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  await cp(join(root, "fixtures/external-consumer"), cleanRoom, { recursive: true });
  await exec("npm", ["install", "--ignore-scripts", tarball], { cwd: cleanRoom, maxBuffer: 20 * 1024 * 1024 });
  await exec("npm", ["run", "build"], { cwd: cleanRoom, maxBuffer: 20 * 1024 * 1024 });
  progress("clean-room-built");

  const createdContainer = await docker(["run", "--detach", "--name", containerName, "--env", "POSTGRES_PASSWORD=realtime", "--env", "POSTGRES_USER=realtime", "--env", "POSTGRES_DB=realtime", "--publish", "127.0.0.1::5432", "postgres:18.4-alpine"], 30_000);
  const createdContainerId = createdContainer.stdout.trim();
  if (!/^[a-f0-9]{12,64}$/u.test(createdContainerId)) throw new Error("RT_POSTGRES_CONTAINER_ID_INVALID");
  containerId = createdContainerId;
  const portResult = await docker(["port", containerName, "5432/tcp"]);
  const databasePort = Number(portResult.stdout.trim().split(":").at(-1));
  if (!Number.isSafeInteger(databasePort)) throw new Error("RT_POSTGRES_PORT_INVALID");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await docker(["exec", containerName, "pg_isready", "--username", "realtime", "--dbname", "realtime"], 2_000); break; }
    catch { if (attempt === 59) throw new Error("RT_POSTGRES_NOT_READY"); await delay(250); }
  }
  const proxyPort = await ephemeralPort();
  const databaseUrl = ["postgresql://", `realtime:realtime@127.0.0.1:${databasePort}/realtime`].join("");
  const environment = { ...process.env, RUNTIME_DATABASE_URL: databaseUrl, IDENTITY_KEY: "consumer-e2e-stable-identity-key-32-bytes", PORT: "0", APP_ORIGIN: `http://127.0.0.1:${proxyPort}` };
  await exec(process.execPath, ["--import", "tsx", "src/migrate.ts"], { cwd: cleanRoom, env: { ...environment, MIGRATION_DATABASE_URL: databaseUrl }, maxBuffer: 20 * 1024 * 1024 });
  progress("deployment-migration-complete");
  const gatewayA = await startGateway(cleanRoom, { ...environment, RUNTIME_ID: "consumer-gateway-a" }, (child) => children.push(child));
  const gatewayB = await startGateway(cleanRoom, { ...environment, RUNTIME_ID: "consumer-gateway-b" }, (child) => children.push(child));
  progress("gateways-ready");

  proxy = await startConsumerTestProxy({ staticRoot: join(cleanRoom, "dist"), gateways: [gatewayA.webSocketUrl, gatewayB.webSocketUrl], port: proxyPort });
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
  await context.tracing.stop({ path: join(artifactDirectory, "trace.zip") });
  const video = page.video();
  await context.close();
  progress("browser-artifacts-closed");
  const videoPath = video ? await video.path() : undefined;
  if (!videoPath) throw new Error("RT_BROWSER_VIDEO_MISSING");

  const commandId = proxy.state.droppedCommandId!;
  const evidencePath = join(artifactDirectory, "evidence.json");
  await requestEvidence(gatewayB.process, evidencePath, commandId);
  const cli = await exec(join(cleanRoom, "node_modules/.bin/better-realtime"), ["doctor", "--format", "json", "--source", evidencePath, "--tenant", "tenant-fixture"], { cwd: cleanRoom });
  const cliResult = JSON.parse(cli.stdout);
  const mcpClient = new Client({ name: "consumer-acceptance", version: "1.0.0" });
  const mcpTransport = new StdioClientTransport({ command: join(cleanRoom, "node_modules/.bin/better-realtime-mcp"), cwd: cleanRoom, env: stringEnvironment({ ...process.env, REALTIME_EVIDENCE_FILE: evidencePath, REALTIME_TENANT_ID: "tenant-fixture" }), stderr: "pipe" });
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
  if (!Array.isArray(closure) || closure.length !== 2 || databaseProof?.boundary !== "db.committed" || serverProof?.boundary !== "command.completed" || !databaseProof.transactionId || !databaseProof.operationCorrelationId || !databaseProof.eventId || databaseProof.eventId !== serverProof.eventId || !databaseProof.causalHandoffId || databaseProof.causalHandoffId !== serverProof.causalHandoffId || !["commit_acknowledgement", "durable_transaction_attempt_marker"].includes(databaseProof.proofSource) || cliResult.evidenceReference?.recordCount !== 2) throw new Error("RT_CONSUMER_DIAGNOSTIC_PROVENANCE_INVALID");
  progress("diagnostics-matched");
  if (consoleErrors.length) throw new Error(`RT_BROWSER_CONSOLE_ERROR:${consoleErrors.join("|")}`);
  const packageBytes = (await statFiles(join(cleanRoom, "node_modules/better-realtime/dist"))).reduce((sum, entry) => sum + entry.bytes, 0);
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", postgres: "18.4", gateways: proxy.state.selectedGateways, interruption: "SIGKILL", ackLossCommandId: commandId, messages: 2, diagnosis: { cli: cliResult.report.verdict, mcp: mcpResult.report.verdict, completeness: cliResult.completeness.status }, browser: { consoleErrors: 0, desktopScreenshot: join(artifactDirectory, "desktop.png"), narrowScreenshot: join(artifactDirectory, "narrow.png"), trace: join(artifactDirectory, "trace.zip"), video: videoPath }, installedBundleBytes: packageBytes })}\n`);
} finally {
  progress("cleanup-start");
  if (browser) await browser.close().catch(() => undefined);
  progress("cleanup-browser");
  if (proxy) await proxy.close().catch(() => undefined);
  progress("cleanup-proxy");
  await Promise.all(children.map((child) => stopChild(child)));
  if (containerId) await docker(["rm", "--force", "--volumes", "--", containerId], 10_000).catch(() => undefined);
  await rm(cleanRoom, { recursive: true, force: true });
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

async function requestEvidence(child: ChildProcess, path: string, commandId: string): Promise<void> {
  await new Promise<void>((resolveEvidence, reject) => {
    const timeout = setTimeout(() => reject(new Error("RT_EVIDENCE_WRITE_TIMEOUT")), 5_000);
    const listener = (message: unknown) => { if (message && typeof message === "object" && "type" in message && message.type === "evidence-written") { clearTimeout(timeout); child.off("message", listener); resolveEvidence(); } };
    child.on("message", listener);
    child.send?.({ type: "write-evidence", path, commandId });
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
async function statFiles(directory: string): Promise<Array<{ path: string; bytes: number }>> {
  const { readdir, stat } = await import("node:fs/promises");
  const result: Array<{ path: string; bytes: number }> = [];
  for (const name of await readdir(directory)) { const path = join(directory, name); const info = await stat(path); if (info.isDirectory()) result.push(...await statFiles(path)); else result.push({ path, bytes: info.size }); }
  return result;
}
