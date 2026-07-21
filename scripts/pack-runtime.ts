import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const runtime = join(root, "packages/runtime");
const outputRoot = join(root, "output/packages");
const buildLock = join(outputRoot, ".runtime-pack-build-lock");

export interface PackedRuntimeArtifact {
  schemaVersion: "1.0";
  package: string;
  version: string;
  tarball: string;
  size: number;
  unpackedSize: number;
  files: number;
}

export async function packRuntime(outputDirectory: string): Promise<PackedRuntimeArtifact> {
  const staging = await mkdtemp(join(tmpdir(), "better-realtime-pack-"));
  await mkdir(outputDirectory, { recursive: true });
  const releaseBuildLock = await acquireBuildLock();
  let manifest: Record<string, unknown> & { dependencies?: Record<string, string> };
  try {
    await exec("pnpm", ["--dir", runtime, "build"], { cwd: root });
    manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8")) as Record<string, unknown> & { dependencies?: Record<string, string> };
    manifest.scripts = {};
    delete manifest.devDependencies;
    manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => !name.startsWith("@realtime/")));
    await cp(join(runtime, "dist"), join(staging, "dist"), { recursive: true });
    await rm(join(staging, "dist/evidence-scope.d.ts"), { force: true });
    const repositoryReadme = await readFile(join(root, "README.md"), "utf8");
    await writeFile(join(staging, "README.md"), packageReadme(repositoryReadme, String(manifest.version)), "utf8");
    await cp(join(root, "LICENSE"), join(staging, "LICENSE"));
    await writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await releaseBuildLock();
  }

  try {
    const expectedTarball = packageTarballName(String(manifest.name), String(manifest.version));
    const packed = await exec("npm", ["pack", "--json", "--pack-destination", outputDirectory], { cwd: staging });
    const result = JSON.parse(packed.stdout) as Array<{ filename: string; size: number; unpackedSize: number; files: Array<{ path: string }> }>;
    const artifact = result[0];
    if (!artifact) throw new Error("RT_PACKAGE_PACK_FAILED");
    if (artifact.filename !== expectedTarball) throw new Error(`RT_PACKAGE_ARTIFACT_IDENTITY_MISMATCH:${artifact.filename}:${expectedTarball}`);
    const forbidden = artifact.files.filter(({ path }) => path.includes("src/") || path.includes("docs/internal") || path.endsWith(".map") || path.includes("AGENTS.md"));
    if (forbidden.length) throw new Error(`RT_PACKAGE_PRIVATE_CONTENT:${forbidden.map(({ path }) => path).join(",")}`);
    return { schemaVersion: "1.0", package: String(manifest.name), version: String(manifest.version), tarball: join(outputDirectory, basename(artifact.filename)), size: artifact.size, unpackedSize: artifact.unpackedSize, files: artifact.files.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function packageReadme(source: string, version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("RT_PACKAGE_VERSION_INVALID");
  const repository = "https://github.com/newExpand/better-realtime";
  const tag = `v${version}`;
  const withLicenseTarget = source.replaceAll("](LICENSE)", `](${repository}/blob/${tag}/LICENSE)`);
  return withLicenseTarget.replace(/(!?)\[([^\]]*)\]\(([^)]+)\)/gu, (whole, image: string, label: string, target: string) => {
    if (/^(?:https:\/\/|#|mailto:)/u.test(target)) return whole;
    if (target.startsWith("/") || target.includes("..") || target.includes("\\")) throw new Error(`RT_PACKAGE_README_LINK_INVALID:${target}`);
    const base = image === "!"
      ? `https://raw.githubusercontent.com/newExpand/better-realtime/${tag}`
      : target === "fixtures/external-consumer"
        ? `${repository}/tree/${tag}`
        : `${repository}/blob/${tag}`;
    return `${image}[${label}](${base}/${target})`;
  });
}

async function acquireBuildLock(): Promise<() => Promise<void>> {
  await mkdir(outputRoot, { recursive: true });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(buildLock);
      await writeFile(join(buildLock, "owner"), `${process.pid}\n`, "utf8");
      return async () => { await rm(buildLock, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(buildLock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 120_000) { await rm(buildLock, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error("RT_PACKAGE_BUILD_LOCK_TIMEOUT");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
}

function packageTarballName(name: string, version: string): string {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(outputRoot, { recursive: true });
  const outputDirectory = await mkdtemp(join(outputRoot, "pack-"));
  process.stdout.write(`${JSON.stringify(await packRuntime(outputDirectory))}\n`);
}
