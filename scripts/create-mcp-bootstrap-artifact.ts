import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertExactMcpBootstrapManifest,
  createMcpBootstrapManifest,
  MCP_BOOTSTRAP_NPM_VERSION,
  MCP_BOOTSTRAP_REGISTRY,
} from "./lib/mcp-bootstrap-contract.js";

const exec = promisify(execFile);
const destination = resolve(process.argv[2] ?? "");
if (!process.argv[2] || destination === resolve(".")) throw new Error("RT_MCP_BOOTSTRAP_OUTPUT_REQUIRED");
const staging = await mkdtemp(join(tmpdir(), "better-realtime-mcp-bootstrap-"));
const packageName = "better-realtime-mcp";
const version = "0.0.0-bootstrap.0";

try {
  await mkdir(destination, { recursive: true });
  const manifest = createMcpBootstrapManifest();
  assertExactMcpBootstrapManifest(manifest);
  await Promise.all([
    writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(staging, "README.md"), [
      "# better-realtime-mcp bootstrap reservation",
      "",
      "This inert package version only reserves the npm identity so its Trusted Publisher can be configured.",
      "Install an explicitly supported alpha version for the read-only local MCP diagnostics companion.",
      "",
    ].join("\n")),
    copyFile(resolve(import.meta.dirname, "..", "LICENSE"), join(staging, "LICENSE")),
  ]);
  const npmCommand = ["dlx", `npm@${MCP_BOOTSTRAP_NPM_VERSION}`];
  const pinnedRegistryEnvironment = {
    ...process.env,
    npm_config_registry: MCP_BOOTSTRAP_REGISTRY,
  };
  const observedNpmVersion = (
    await exec("pnpm", [...npmCommand, "--version"], { env: pinnedRegistryEnvironment })
  ).stdout.trim();
  if (observedNpmVersion !== MCP_BOOTSTRAP_NPM_VERSION) throw new Error("RT_MCP_BOOTSTRAP_NPM_VERSION_MISMATCH");
  const packed = await exec(
    "pnpm",
    [...npmCommand, "pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd: staging, env: pinnedRegistryEnvironment },
  );
  const reports = JSON.parse(packed.stdout) as Array<{ filename?: unknown; size?: unknown; unpackedSize?: unknown; files?: Array<{ path?: unknown }> }>;
  const report = reports[0];
  const expectedName = `${packageName}-${version}.tgz`;
  if (
    !report
    || report.filename !== expectedName
    || typeof report.size !== "number"
    || typeof report.unpackedSize !== "number"
    || !Array.isArray(report.files)
    || JSON.stringify(report.files.map(({ path }) => String(path)).sort()) !== JSON.stringify(["LICENSE", "README.md", "package.json"])
  ) throw new Error("RT_MCP_BOOTSTRAP_ARTIFACT_INVALID");
  const artifact = join(destination, expectedName);
  const packedManifest = JSON.parse(
    (await exec("tar", ["-xOzf", artifact, "package/package.json"])).stdout,
  ) as unknown;
  assertExactMcpBootstrapManifest(packedManifest);
  const bytes = await readFile(artifact);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "1.0",
    package: packageName,
    version,
    artifact,
    filename: basename(artifact),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    unpackedSize: report.unpackedSize,
    files: report.files.length,
    publishTag: "bootstrap",
    npmVersion: observedNpmVersion,
  })}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
