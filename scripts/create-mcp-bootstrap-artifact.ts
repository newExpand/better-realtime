import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const destination = resolve(process.argv[2] ?? "");
if (!process.argv[2] || destination === resolve(".")) throw new Error("RT_MCP_BOOTSTRAP_OUTPUT_REQUIRED");
const staging = await mkdtemp(join(tmpdir(), "better-realtime-mcp-bootstrap-"));
const packageName = "better-realtime-mcp";
const version = "0.0.0-bootstrap.0";

try {
  await mkdir(destination, { recursive: true });
  const manifest = {
    name: packageName,
    version,
    description: "Reserved bootstrap identity for the Better Realtime MCP companion",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/newExpand/better-realtime.git" },
    homepage: "https://github.com/newExpand/better-realtime#readme",
    files: ["README.md", "LICENSE"],
    publishConfig: { access: "public", tag: "bootstrap" },
  };
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
  const packed = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: staging });
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
  })}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
