import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyPackedArtifactContent } from "./verify-package-artifact-content.ts";

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

interface PackageFileManifest {
  schemaVersion: "1.0";
  package: string;
  files: string[];
}

export function assertPackageFileManifest(expected: PackageFileManifest, actualPaths: string[], packageName: string): void {
  if (expected.schemaVersion !== "1.0" || expected.package !== packageName || expected.files.length === 0) throw new Error("RT_PACKAGE_FILE_MANIFEST_INVALID");
  if (new Set(expected.files).size !== expected.files.length || expected.files.some((path) => path.startsWith("/") || path.includes("..") || path.includes("\\"))) throw new Error("RT_PACKAGE_FILE_MANIFEST_INVALID");
  const expectedPaths = [...expected.files].sort();
  const actual = [...actualPaths].sort();
  const missing = expectedPaths.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expectedPaths.includes(path));
  if (missing.length || unexpected.length) throw new Error(`RT_PACKAGE_FILE_MANIFEST_DRIFT:missing=${missing.join(",")}:unexpected=${unexpected.join(",")}`);
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
    await writeFile(
      join(staging, "README.md"),
      packageReadme(repositoryReadme, String(manifest.version), await readCurrentPublishedVersion()),
      "utf8"
    );
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
    const fileManifest = JSON.parse(await readFile(join(root, "release/package-files.json"), "utf8")) as PackageFileManifest;
    assertPackageFileManifest(fileManifest, artifact.files.map(({ path }) => path), String(manifest.name));
    const forbidden = artifact.files.filter(({ path }) => path.includes("src/") || path.includes("docs/internal") || path.endsWith(".map") || path.includes("AGENTS.md"));
    if (forbidden.length) throw new Error(`RT_PACKAGE_PRIVATE_CONTENT:${forbidden.map(({ path }) => path).join(",")}`);
    const tarball = join(outputDirectory, basename(artifact.filename));
    await verifyPackedArtifactContent(tarball, [root]);
    return { schemaVersion: "1.0", package: String(manifest.name), version: String(manifest.version), tarball, size: artifact.size, unpackedSize: artifact.unpackedSize, files: artifact.files.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function assertRepositoryReadmeReleaseState(source: string, version: string, currentPublishedVersion: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(currentPublishedVersion)) {
    throw new Error("RT_PACKAGE_VERSION_INVALID");
  }
  const releaseBlock = source.match(/<!-- release-state:begin -->\n([\s\S]*?)\n<!-- release-state:end -->/u);
  const installBlock = source.match(/<!-- install-state:begin -->\n([\s\S]*?)\n<!-- install-state:end -->/u);
  if (!releaseBlock || !installBlock) throw new Error("RT_PACKAGE_README_RELEASE_MARKERS_INVALID");
  const releaseState = releaseBlock[1]!;
  const installState = installBlock[1]!;
  if (version === currentPublishedVersion) {
    if (!releaseState.includes(`\`${version}\` is the current published alpha`) || !installState.includes("## Install the current alpha")) {
      throw new Error("RT_PACKAGE_README_PUBLISHED_STATE_DRIFT");
    }
  } else if (
    !releaseState.includes(`\`${currentPublishedVersion}\` remains the current published alpha`)
    || !releaseState.includes(`\`${version}\` is the release candidate`)
    || !installState.includes("## Install the release candidate")
  ) {
    throw new Error("RT_PACKAGE_README_CANDIDATE_STATE_DRIFT");
  }
  for (const command of [
    `npm install better-realtime@${version} react`,
    `npm install better-realtime@${version} pg ws`,
    `npm install better-realtime-mcp@${version}`
  ]) {
    if (!source.includes(command)) throw new Error(`RT_PACKAGE_README_INSTALL_VERSION_DRIFT:${command}`);
  }
  if (/unpublished `0\.2\.0-alpha\.1` candidate|an npm `E404` is expected|After `0\.2\.0-alpha\.1` appears in the npm version lists/u.test(source)) {
    throw new Error("RT_PACKAGE_README_STALE_RELEASE_STATE");
  }
}

export async function readCurrentPublishedVersion(): Promise<string> {
  const pointer = JSON.parse(await readFile(join(root, "support/current.json"), "utf8")) as {
    schemaVersion?: unknown;
    manifest?: unknown;
    releaseVersion?: unknown;
  };
  if (
    pointer.schemaVersion !== "1.0"
    || typeof pointer.manifest !== "string"
    || !/^alpha-0\.[0-9]+\.json$/u.test(pointer.manifest)
    || typeof pointer.releaseVersion !== "string"
  ) throw new Error("RT_PACKAGE_README_CURRENT_SUPPORT_INVALID");
  const support = JSON.parse(await readFile(join(root, "support", pointer.manifest), "utf8")) as { releaseVersion?: unknown };
  if (support.releaseVersion !== pointer.releaseVersion) throw new Error("RT_PACKAGE_README_CURRENT_SUPPORT_DRIFT");
  return pointer.releaseVersion;
}

export function packageReadme(source: string, version: string, currentPublishedVersion = version): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("RT_PACKAGE_VERSION_INVALID");
  assertRepositoryReadmeReleaseState(source, version, currentPublishedVersion);
  const artifactState = [
    "<!-- release-state:begin -->",
    `> This immutable package artifact is version \`${version}\`. Verify current npm dist-tags and GitHub release status before installation.`,
    "<!-- release-state:end -->"
  ].join("\n");
  const artifactInstall = [
    "<!-- install-state:begin -->",
    "## Install this package version",
    "",
    "Install only the profile each process runs:",
    "<!-- install-state:end -->"
  ].join("\n");
  const repository = "https://github.com/newExpand/better-realtime";
  const tag = `v${version}`;
  const artifactReadme = source
    .replace(/<!-- release-state:begin -->[\s\S]*?<!-- release-state:end -->/u, artifactState)
    .replace(/<!-- install-state:begin -->[\s\S]*?<!-- install-state:end -->/u, artifactInstall);
  const withLicenseTarget = artifactReadme.replaceAll("](LICENSE)", `](${repository}/blob/${tag}/LICENSE)`);
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
