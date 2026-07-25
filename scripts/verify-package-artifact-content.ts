import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertPackageArtifactText } from "./package-content-policy.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

export interface PackageArtifactContentReport {
  readonly schemaVersion: "1.0";
  readonly artifact: string;
  readonly files: number;
  readonly contentScan: "passed";
}

export async function verifyPackedArtifactContent(
  tarball: string,
  forbiddenRoots: readonly string[] = [root],
): Promise<PackageArtifactContentReport> {
  const artifact = resolve(tarball);
  const archive = (await exec("tar", ["-tzf", artifact], { maxBuffer: 20 * 1024 * 1024 })).stdout
    .split("\n")
    .filter(Boolean);
  if (
    archive.length === 0
    || archive.some((path) =>
      path.startsWith("/")
      || path.includes("\\")
      || path.split("/").includes("..")
      || path !== "package"
        && path !== "package/"
        && !path.startsWith("package/")
    )
  ) throw new Error("RT_PACKAGE_ARTIFACT_ARCHIVE_PATH_INVALID");

  const extraction = await mkdtemp(join(tmpdir(), "better-realtime-artifact-content-"));
  try {
    await exec("tar", ["-xzf", artifact, "-C", extraction], { maxBuffer: 20 * 1024 * 1024 });
    const packageRoot = join(extraction, "package");
    const files = await walkFiles(packageRoot);
    if (files.length === 0) throw new Error("RT_PACKAGE_ARTIFACT_CONTENT_EMPTY");
    for (const file of files) {
      const path = `package/${relative(packageRoot, file).split("\\").join("/")}`;
      assertPackageArtifactText(path, (await readFile(file)).toString("utf8"), forbiddenRoots);
    }
    return { schemaVersion: "1.0", artifact: basename(artifact), files: files.length, contentScan: "passed" };
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`RT_PACKAGE_ARTIFACT_SPECIAL_FILE:${entry.name}`);
  }
  return files.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifacts = process.argv.slice(2);
  if (artifacts.length === 0) throw new Error("RT_PACKAGE_ARTIFACT_REQUIRED");
  for (const artifact of artifacts) {
    process.stdout.write(`${JSON.stringify(await verifyPackedArtifactContent(artifact))}\n`);
  }
}
