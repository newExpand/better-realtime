import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { packMcp } from "./pack-mcp.ts";
import { packRuntime } from "./pack-runtime.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const alpha4Tarball = join(root, "compatibility/fixtures/better-realtime-0.1.0-alpha.4.tgz");
const alpha4Identity = {
  bytes: 127_291,
  sha256: "803487cf32eca359ac85755b138119bf37c9e9afa476e55684971ed24057a6c2"
} as const;
const artifactDirectory = await mkdtemp(join(tmpdir(), "better-realtime-migration-artifacts-"));
const beforeDirectory = await mkdtemp(join(tmpdir(), "better-realtime-migration-before-"));
const afterDirectory = await mkdtemp(join(tmpdir(), "better-realtime-migration-after-"));

try {
  const alpha4Bytes = await readFile(alpha4Tarball);
  const alpha4Sha256 = createHash("sha256").update(alpha4Bytes).digest("hex");
  if (alpha4Bytes.length !== alpha4Identity.bytes || alpha4Sha256 !== alpha4Identity.sha256) {
    throw new Error(`RT_MIGRATION_ALPHA4_FIXTURE_IDENTITY:${alpha4Bytes.length}:${alpha4Sha256}`);
  }

  const runtime = await packRuntime(artifactDirectory);
  const mcp = await packMcp(artifactDirectory);
  if (runtime.version !== "0.2.0-alpha.1" || mcp.version !== runtime.version) {
    throw new Error(`RT_MIGRATION_CANDIDATE_IDENTITY:${runtime.version}:${mcp.version}`);
  }

  await cp(join(root, "fixtures/migration-consumer/alpha4"), beforeDirectory, { recursive: true });
  await install(beforeDirectory, [alpha4Tarball]);
  await verifyConsumer(beforeDirectory);
  const beforeManifest = await packageManifest(join(beforeDirectory, "node_modules/better-realtime/package.json"));
  if (beforeManifest.engines?.node !== ">=22.0.0") throw new Error("RT_MIGRATION_ALPHA4_ENGINE_BASELINE");
  if (beforeManifest.bin?.["better-realtime-mcp"] === undefined || beforeManifest.exports?.["./mcp"] === undefined) {
    throw new Error("RT_MIGRATION_ALPHA4_MCP_BASELINE");
  }
  await verifyBin(beforeDirectory, "better-realtime", "0.1.0-alpha.4");
  await verifyBin(beforeDirectory, "better-realtime-mcp", "0.1.0-alpha.4");

  await cp(join(root, "fixtures/migration-consumer/candidate"), afterDirectory, { recursive: true });
  await install(afterDirectory, [runtime.tarball, mcp.tarball]);
  await verifyConsumer(afterDirectory);
  const afterManifest = await packageManifest(join(afterDirectory, "node_modules/better-realtime/package.json"));
  const companionManifest = await packageManifest(join(afterDirectory, "node_modules/better-realtime-mcp/package.json"));
  if (afterManifest.engines !== undefined) throw new Error("RT_MIGRATION_BASE_ENGINE_NOT_REMOVED");
  if (afterManifest.bin?.["better-realtime-mcp"] !== undefined || afterManifest.exports?.["./mcp"] !== undefined) {
    throw new Error("RT_MIGRATION_MCP_BASE_BOUNDARY");
  }
  for (const peer of ["pg", "react", "ws"]) {
    if (afterManifest.peerDependenciesMeta?.[peer]?.optional !== true) throw new Error(`RT_MIGRATION_OPTIONAL_PEER:${peer}`);
  }
  if (companionManifest.engines?.node !== ">=22.0.0") throw new Error("RT_MIGRATION_MCP_ENGINE");
  if (companionManifest.dependencies?.["better-realtime"] !== runtime.version) {
    throw new Error(`RT_MIGRATION_MCP_VERSION_BINDING:${companionManifest.dependencies?.["better-realtime"]}`);
  }
  await access(join(afterDirectory, "node_modules/.bin/better-realtime-mcp"));
  await verifyBin(afterDirectory, "better-realtime", runtime.version);
  await verifyBin(afterDirectory, "better-realtime-mcp", runtime.version);

  const beforeContract = await import(pathToFileURL(join(beforeDirectory, "dist/contract.js")).href) as {
    contract: { identity: { manifestDigest: string } };
  };
  const afterContract = await import(pathToFileURL(join(afterDirectory, "dist/contract.js")).href) as {
    contract: { identity: { manifestDigest: string } };
  };
  if (beforeContract.contract.identity.manifestDigest === afterContract.contract.identity.manifestDigest) {
    throw new Error("RT_MIGRATION_EXACT_CONTRACT_IDENTITY_NOT_CHANGED");
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "1.0",
    alpha4: {
      package: "better-realtime@0.1.0-alpha.4",
      bytes: alpha4Bytes.length,
      sha256: alpha4Sha256,
      typecheck: "passed",
      build: "passed",
      runtime: "passed",
      legacyStream: "passed",
      legacyPrepareMutate: "passed",
      totalPendingCount: "baseline-confirmed",
      mcpLocation: "base-package"
    },
    candidate: {
      packages: [`${runtime.package}@${runtime.version}`, `${mcp.package}@${mcp.version}`],
      typecheck: "passed",
      build: "passed",
      runtime: "passed",
      legacyStream: "passed",
      legacyPrepareMutate: "passed",
      stateStream: "passed",
      commandScopedActivity: "passed",
      totalPendingCount: "removed-with-compile-assertion",
      mcpLocation: "companion-package",
      baseEngineConstraint: "removed",
      serverPeers: "optional-and-explicit"
    },
    exactContract: {
      alpha4: beforeContract.contract.identity.manifestDigest,
      candidate: afterContract.contract.identity.manifestDigest,
      mismatch: "distinct; runtime rejection covered by compatibility:matrix"
    }
  })}\n`);
} finally {
  await rm(artifactDirectory, { recursive: true, force: true });
  await rm(beforeDirectory, { recursive: true, force: true });
  await rm(afterDirectory, { recursive: true, force: true });
}

async function install(directory: string, tarballs: string[]): Promise<void> {
  await exec("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...tarballs,
    "react@19.2.7",
    "pg@8.22.0",
    "ws@8.21.1",
    "@types/react@19.2.17",
    "typescript@7.0.2"
  ], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
}

async function verifyConsumer(directory: string): Promise<void> {
  await exec("npm", ["run", "typecheck"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  await exec("npm", ["run", "build"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  await exec("npm", ["run", "run"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
}

async function verifyBin(directory: string, name: string, expectedVersion: string): Promise<void> {
  const result = await exec("npm", ["exec", "--offline", "--", name, "--version"], {
    cwd: directory,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.stdout.trim() !== expectedVersion || result.stderr !== "") {
    throw new Error(`RT_MIGRATION_BIN_IDENTITY:${name}:${result.stdout.trim()}:${result.stderr.trim()}`);
  }
}

interface Manifest {
  engines?: Record<string, string>;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function packageManifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}
