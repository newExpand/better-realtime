import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { packageContentIssues } from "./package-content-policy.ts";
import { PUBLIC_TREE_MANIFEST_PATH, type PublicTreeManifest } from "./verify-public-tree.ts";

interface ExportPolicy {
  schemaVersion: "1.0";
  repository: string;
  exactFiles: string[];
  directoryTrees: string[];
  forbiddenPathNames: string[];
  forbiddenContentFragments: string[][];
}

interface PrivateExportPolicy {
  schemaVersion: "1.0";
  forbiddenContentFragments: string[][];
}

export function assertPrivateExportPolicyBoundary(privateMode: boolean, privatePolicy: PrivateExportPolicy | undefined): void {
  if (privateMode && !privatePolicy) throw new Error("RT_PUBLIC_EXPORT_PRIVATE_POLICY_REQUIRED");
}

export interface PublicExportReport {
  schemaVersion: "1.0";
  repository: string;
  outputDirectory: string;
  fileCount: number;
  totalBytes: number;
  treeDigest: `sha256:${string}`;
  files: Array<{ path: string; bytes: number; digest: `sha256:${string}` }>;
  exclusionsVerified: true;
  contentScan: "passed";
  gitHistoryIncluded: false;
  sourceMode: "review_worktree" | "clean_git_index";
}

const root = resolve(import.meta.dirname, "..");
const defaultOutput = join(root, "output/public-export/better-realtime");
const exec = promisify(execFile);
const privateSourceTagPattern = /\bsource(?:-export)?\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u;

export async function exportPublic(outputDirectory = defaultOutput): Promise<PublicExportReport> {
  const policy = JSON.parse(await readFile(join(root, "release/public-export.json"), "utf8")) as ExportPolicy;
  if (policy.schemaVersion !== "1.0" || policy.repository !== "newExpand/better-realtime") throw new Error("RT_PUBLIC_EXPORT_POLICY_INVALID");
  const privatePolicyPath = join(root, "release/.private-export-policy.json");
  const privatePolicy = await readFile(privatePolicyPath, "utf8")
    .then((source) => JSON.parse(source) as PrivateExportPolicy)
    .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  const privateMode = await lstat(join(root, "AGENTS.md")).then((entry) => entry.isFile(), (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
  assertPrivateExportPolicyBoundary(privateMode, privatePolicy);
  if (privatePolicy && privatePolicy.schemaVersion !== "1.0") throw new Error("RT_PUBLIC_EXPORT_PRIVATE_POLICY_INVALID");
  const forbiddenContent = [...policy.forbiddenContentFragments, ...(privatePolicy?.forbiddenContentFragments ?? [])].map((fragments) => fragments.join(""));
  if (forbiddenContent.some((value) => !value || value.length < 8)) throw new Error("RT_PUBLIC_EXPORT_POLICY_INVALID");
  const resolvedOutput = resolve(outputDirectory);
  const temporaryRoot = resolve(process.env.TMPDIR ?? "/tmp");
  if (resolvedOutput === root || !resolvedOutput.startsWith(`${root}${sep}`) && resolvedOutput !== temporaryRoot && !resolvedOutput.startsWith(`${temporaryRoot}${sep}`)) throw new Error("RT_PUBLIC_EXPORT_OUTPUT_UNSAFE");
  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(resolvedOutput, { recursive: true });

  for (const path of [...policy.exactFiles, ...policy.directoryTrees]) assertSafeRelative(path);
  const releaseMode = process.env.BETTER_REALTIME_RELEASE_EXPORT === "1";
  if (releaseMode && (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim()) throw new Error("RT_PUBLIC_EXPORT_SOURCE_DIRTY");
  const tracked = (await exec("git", ["ls-files", ...(releaseMode ? ["--cached"] : ["--cached", "--others", "--exclude-standard"]), "-z"], { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout.split("\0").filter(Boolean);
  const exact = new Set(policy.exactFiles);
  const selected = tracked.filter((path) => path !== PUBLIC_TREE_MANIFEST_PATH && (exact.has(path) || policy.directoryTrees.some((directory) => path.startsWith(`${directory}/`)))).sort();
  for (const path of policy.exactFiles) if (!selected.includes(path)) throw new Error(`RT_PUBLIC_EXPORT_SOURCE_MISSING:${path}`);
  for (const directory of policy.directoryTrees) if (!selected.some((path) => path.startsWith(`${directory}/`))) throw new Error(`RT_PUBLIC_EXPORT_SOURCE_MISSING:${directory}`);
  for (const path of selected) {
    if (hasForbiddenPath(path, policy)) continue;
    const source = join(root, path);
    const entry = await lstat(source).catch(() => undefined);
    if (!entry?.isFile()) throw new Error(`RT_PUBLIC_EXPORT_SPECIAL_FILE:${path}`);
    await mkdir(dirname(join(resolvedOutput, path)), { recursive: true });
    await cp(source, join(resolvedOutput, path));
  }

  const paths = (await walk(resolvedOutput)).sort();
  const files: PublicExportReport["files"] = [];
  for (const absolute of paths) {
    const path = relative(resolvedOutput, absolute).split(sep).join("/");
    if (hasForbiddenPath(path, policy)) throw new Error(`RT_PUBLIC_EXPORT_FORBIDDEN_PATH:${path}`);
    const content = await readFile(absolute);
    const text = content.toString("utf8");
    const forbidden = forbiddenContent.find((value) => text.includes(value));
    if (forbidden) throw new Error(`RT_PUBLIC_EXPORT_FORBIDDEN_CONTENT:${path}:${forbidden}`);
    if (privateSourceTagPattern.test(text)) throw new Error(`RT_PUBLIC_EXPORT_PRIVATE_SOURCE_REFERENCE:${path}`);
    const issues = packageContentIssues(text, [root]);
    if (issues.length) throw new Error(`RT_PUBLIC_EXPORT_SENSITIVE_CONTENT:${path}:${JSON.stringify(issues)}`);
    files.push({ path, bytes: content.byteLength, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` });
  }
  const manifest: PublicTreeManifest = { schemaVersion: "1.0", repository: policy.repository, files: [...files] };
  const manifestOutput = join(resolvedOutput, PUBLIC_TREE_MANIFEST_PATH);
  await mkdir(dirname(manifestOutput), { recursive: true });
  await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestContent = await readFile(manifestOutput);
  files.push({ path: PUBLIC_TREE_MANIFEST_PATH, bytes: manifestContent.byteLength, digest: `sha256:${createHash("sha256").update(manifestContent).digest("hex")}` });
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const treeDigest = `sha256:${createHash("sha256").update(files.map((file) => `${file.path}\0${file.bytes}\0${file.digest}\n`).join("")).digest("hex")}` as const;
  const report: PublicExportReport = { schemaVersion: "1.0", repository: policy.repository, outputDirectory: resolvedOutput, fileCount: files.length, totalBytes: files.reduce((total, file) => total + file.bytes, 0), treeDigest, files, exclusionsVerified: true, contentScan: "passed", gitHistoryIncluded: false, sourceMode: releaseMode ? "clean_git_index" : "review_worktree" };
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(join(dirname(resolvedOutput), "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function hasForbiddenPath(path: string, policy: ExportPolicy): boolean {
  const segments = path.split(/[\\/]/u);
  return segments.some((segment) => {
    const folded = segment.toLocaleLowerCase("en-US");
    return folded === ".env" || folded.startsWith(".env.") || policy.forbiddenPathNames.some((name) => folded === name.toLocaleLowerCase("en-US"));
  });
}

function assertSafeRelative(path: string): void {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\\")) throw new Error(`RT_PUBLIC_EXPORT_PATH_INVALID:${path}`);
}

async function walk(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`RT_PUBLIC_EXPORT_SPECIAL_FILE:${path}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await exportPublic(process.argv[2]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
