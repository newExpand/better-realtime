import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { acquireCompatibilityFixture } from "./acquire-compatibility-fixture.ts";
import { packRuntime } from "./pack-runtime.ts";
import { ReferenceServer } from "../packages/server-node/src/server.ts";
import WebSocket from "ws";
import { assertMatrixCapabilityProfiles } from "./compatibility-wire-assertions.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

export async function verifyMixedVersionMatrix(): Promise<Record<string, unknown>> {
  const ledger = JSON.parse(await readFile(join(root, "compatibility/changes.json"), "utf8")) as { changes: Array<{ axis: string; classification: string }> };
  if (ledger.changes.some((change) => change.axis === "wire" && change.classification === "intentionally_breaking")) throw new Error("RT_COMPAT_WIRE_BREAK_REQUIRES_VERSIONED_V2_MATRIX");
  const work = await mkdtemp(join(tmpdir(), "better-realtime-matrix-"));
  const fixture = await acquireCompatibilityFixture(false, false);
  const candidate = await packRuntime(join(work, "candidate"));
  const cases = [
    { id: "alpha1-client-to-candidate-server", client: fixture.path, server: candidate.tarball },
    { id: "candidate-client-to-alpha1-server", client: candidate.tarball, server: fixture.path },
    { id: "candidate-client-to-candidate-server", client: candidate.tarball, server: candidate.tarball }
  ];
  try {
    const results = [];
    for (const matrixCase of cases) {
      const output = join(root, "output/compatibility-matrix", matrixCase.id);
      const run = await exec(process.execPath, ["--import", "tsx", "scripts/verify-consumer-journey.ts"], {
        cwd: root,
        env: {
          ...process.env,
          BETTER_REALTIME_MATRIX_CASE: matrixCase.id,
          BETTER_REALTIME_CLIENT_TARBALL: matrixCase.client,
          BETTER_REALTIME_SERVER_TARBALL: matrixCase.server,
          BETTER_REALTIME_CONSUMER_OUTPUT: output
        },
        timeout: 240_000,
        maxBuffer: 30 * 1024 * 1024
      });
      process.stderr.write(run.stderr);
      const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as { matrixCase?: string; messages?: number; wireSemantics?: { stableCommandIds?: boolean; freshAttemptIds?: boolean; receiptCompletionObserved?: boolean; statusReconciliation?: boolean; cursorContinuity?: number[]; capabilityProfile?: Record<string, unknown>; sameCommandRetry?: boolean; freshRetryAttemptIds?: boolean; duplicateEffectSuppressed?: boolean; stableStatusIdentity?: boolean }; serverRejections?: Array<Record<string, string | number>>; diagnosis?: { cli?: string; mcp?: string; completeness?: string }; browser?: { consoleErrors?: number } };
      const wire = result.wireSemantics;
      if (result.matrixCase !== matrixCase.id || result.messages !== 2 || wire?.stableCommandIds !== true || wire.freshAttemptIds !== true || wire.receiptCompletionObserved !== true || wire.statusReconciliation !== true || wire.sameCommandRetry !== true || wire.freshRetryAttemptIds !== true || wire.duplicateEffectSuppressed !== true || wire.stableStatusIdentity !== true || JSON.stringify(wire.cursorContinuity) !== "[1,2]" || !wire.capabilityProfile || result.serverRejections?.length !== 2 || result.diagnosis?.cli !== "proven" || result.diagnosis.mcp !== "proven" || result.diagnosis.completeness !== "complete" || result.browser?.consoleErrors !== 0) throw new Error(`RT_COMPAT_MATRIX_CASE_FAILED:${matrixCase.id}`);
      results.push({ id: matrixCase.id, status: "passed", messages: result.messages, wireSemantics: wire, serverRejections: result.serverRejections, diagnosis: result.diagnosis, browser: result.browser });
    }
    assertMatrixCapabilityProfiles(results.map((result) => ({ id: result.id, capabilityProfile: result.wireSemantics.capabilityProfile as Record<string, unknown> })));
    const capabilityRejection = await verifyCapabilityRejection(candidate.tarball, join(work, "rejection-candidate"));
    const rejected = [
      ...results.flatMap((result) => result.serverRejections.map((rejection) => ({ matrixCase: result.id, serverArtifact: result.id === "candidate-client-to-alpha1-server" ? "better-realtime@0.1.0-alpha.1" : `${candidate.package}@${candidate.version}`, ...rejection }))),
      capabilityRejection
    ];
    return {
      schemaVersion: "1.0",
      baseline: { package: "better-realtime@0.1.0-alpha.1", sha256: fixture.sha256 },
      candidate: `${candidate.package}@${candidate.version}`,
      supported: results,
      rejected
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function verifyCapabilityRejection(candidateTarball: string, directory: string): Promise<Record<string, string>> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8");
  await exec("npm", ["install", "--ignore-scripts", candidateTarball, "ws@8.21.1", "pg@8.22.0"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  const runtime = await import(pathToFileURL(join(directory, "node_modules/better-realtime/dist/index.js")).href) as {
    jsonSchema(name: string, schema: Record<string, unknown>): unknown;
    stream(value: Record<string, unknown>): unknown;
    command(value: Record<string, unknown>): unknown;
    defineRealtimeContract(value: Record<string, unknown>): { identity: { contractId: string; manifestVersion: string; manifestDigest: `sha256:${string}` } };
    createRealtimeClient(contract: unknown, options: Record<string, unknown>): { connect(): Promise<void>; execute(name: string, input: unknown): { completed: Promise<unknown>; observed: Promise<void> }; dispose(): Promise<void> };
  };
  const object = runtime.jsonSchema("compat.reject.object@1", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } });
  const result = runtime.jsonSchema("compat.reject.result@1", { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } });
  const contract = runtime.defineRealtimeContract({ contractId: "compat.reject", manifestVersion: "1.0.0", streams: { item: runtime.stream({ input: object, snapshot: object, events: { changed: object }, key: ({ id }: { id: string }) => `item:${id}`, initial: ({ id }: { id: string }) => ({ id }), applyEvent: (_state: unknown, event: { data: unknown }) => event.data, snapshotSequence: () => 0 }) }, commands: { update: runtime.command({ input: object, result }) } });
  const invalidServer = new ReferenceServer({ port: 0, contract: contract.identity });
  Object.assign(invalidServer.capabilities, { idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 2_000, idempotencyRetentionMs: 1_000 });
  await invalidServer.start();
  const client = runtime.createRealtimeClient(contract, { url: invalidServer.webSocketUrl, auth: () => ({}), webSocket: WebSocket, reconnectDelaysMs: [10] });
  try {
    await client.connect();
    const attempt = client.execute("update", { id: "1" });
    const completed = await attempt.completed.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    const observed = await attempt.observed.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    if (completed !== "RT_CAPABILITY_VIOLATED" || observed !== "RT_CAPABILITY_VIOLATED") throw new Error(`RT_COMPAT_CAPABILITY_REJECTION_DRIFT:${completed}:${observed}`);
  } finally { await client.dispose(); await invalidServer.dispose(); }
  return { combination: "invalid-v1-capability-set-to-candidate-client", outcome: "RT_CAPABILITY_VIOLATED", execution: "candidate-client-artifact-with-reference-invalid-peer" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(`${JSON.stringify(await verifyMixedVersionMatrix())}\n`);
