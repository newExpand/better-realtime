import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertPackageFileManifest, packageReadme, type PackedRuntimeArtifact } from "./pack-runtime.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const companion = join(root, "packages/mcp");
const runtimeManifestPath = join(root, "packages/runtime/package.json");

export function assertMcpRuntimeVersion(companionVersion: unknown, runtimeVersion: string): asserts companionVersion is string {
  if (companionVersion !== runtimeVersion) throw new Error(`RT_MCP_RUNTIME_VERSION_SKEW:${String(companionVersion)}:${runtimeVersion}`);
}

export async function packMcp(outputDirectory: string): Promise<PackedRuntimeArtifact> {
  const staging = await mkdtemp(join(tmpdir(), "better-realtime-mcp-pack-"));
  await mkdir(outputDirectory, { recursive: true });
  let manifest: Record<string, unknown> & { name?: string; version?: string; dependencies?: Record<string, string> };
  try {
    await exec("pnpm", ["--dir", companion, "build"], { cwd: root });
    manifest = JSON.parse(await readFile(join(companion, "package.json"), "utf8")) as typeof manifest;
    const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8")) as { version: string };
    assertMcpRuntimeVersion(manifest.version, runtimeManifest.version);
    manifest.scripts = {};
    delete manifest.devDependencies;
    manifest.dependencies = {
      ...(manifest.dependencies ?? {}),
      "better-realtime": runtimeManifest.version
    };
    await cp(join(companion, "dist"), join(staging, "dist"), { recursive: true });
    await cp(join(root, "LICENSE"), join(staging, "LICENSE"));
    await writeFile(join(staging, "README.md"), packageReadme(await readFile(join(root, "README.md"), "utf8"), String(manifest.version)), "utf8");
    await writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const packed = await exec("npm", ["pack", "--json", "--pack-destination", outputDirectory], { cwd: staging });
    const result = JSON.parse(packed.stdout) as Array<{ filename: string; size: number; unpackedSize: number; files: Array<{ path: string }> }>;
    const artifact = result[0];
    if (!artifact || manifest.name !== "better-realtime-mcp" || typeof manifest.version !== "string") throw new Error("RT_PACKAGE_PACK_FAILED");
    const expectedTarball = `${manifest.name}-${manifest.version}.tgz`;
    if (artifact.filename !== expectedTarball) throw new Error(`RT_PACKAGE_ARTIFACT_IDENTITY_MISMATCH:${artifact.filename}:${expectedTarball}`);
    const fileManifest = JSON.parse(await readFile(join(root, "release/mcp-package-files.json"), "utf8")) as { schemaVersion: "1.0"; package: string; files: string[] };
    assertPackageFileManifest(fileManifest, artifact.files.map(({ path }) => path), manifest.name);
    return {
      schemaVersion: "1.0",
      package: manifest.name,
      version: manifest.version,
      tarball: join(outputDirectory, basename(artifact.filename)),
      size: artifact.size,
      unpackedSize: artifact.unpackedSize,
      files: artifact.files.length
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "better-realtime-mcp-artifact-"));
  process.stdout.write(`${JSON.stringify(await packMcp(outputDirectory))}\n`);
}
