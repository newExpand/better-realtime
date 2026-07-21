import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageContentIssues } from "./package-content-policy.ts";

const exec = promisify(execFile);
export const PUBLIC_TREE_MANIFEST_PATH = "release/public-tree.json";

interface PublicPolicy {
  schemaVersion: "1.0";
  repository: string;
  forbiddenPathNames: string[];
  forbiddenContentFragments: string[][];
}

export interface PublicTreeManifest {
  schemaVersion: "1.0";
  repository: "newExpand/better-realtime";
  files: Array<{ path: string; bytes: number; digest: `sha256:${string}` }>;
}

export interface PublicTreeVerification {
  schemaVersion: "1.0";
  repository: "newExpand/better-realtime";
  fileCount: number;
  totalBytes: number;
  treeDigest: `sha256:${string}`;
  trackedFilesExact: true;
  contentScan: "passed";
}

const privateTagPattern = /\bsource(?:-export)?\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u;

export async function verifyPublicTree(directory: string): Promise<PublicTreeVerification> {
  const root = resolve(directory);
  const policy = JSON.parse(await readFile(join(root, "release/public-export.json"), "utf8")) as PublicPolicy;
  const manifest = JSON.parse(await readFile(join(root, PUBLIC_TREE_MANIFEST_PATH), "utf8")) as PublicTreeManifest;
  if (policy.schemaVersion !== "1.0" || policy.repository !== "newExpand/better-realtime") throw new Error("RT_PUBLIC_TREE_POLICY_INVALID");
  if (manifest.schemaVersion !== "1.0" || manifest.repository !== policy.repository) throw new Error("RT_PUBLIC_TREE_MANIFEST_INVALID");
  const expected = [...manifest.files.map(({ path }) => path), PUBLIC_TREE_MANIFEST_PATH].sort();
  const actual = await trackedOrPresentFiles(root);
  if (actual.join("\0") !== expected.join("\0")) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    throw new Error(`RT_PUBLIC_TREE_TRACKED_MISMATCH:${JSON.stringify({ missing: expected.filter((path) => !actualSet.has(path)), extra: actual.filter((path) => !expectedSet.has(path)) })}`);
  }
  const expectedRecords = new Map(manifest.files.map((file) => [file.path, file]));
  const forbiddenContent = policy.forbiddenContentFragments.map((fragments) => fragments.join(""));
  const records: PublicTreeManifest["files"] = [];
  for (const path of actual) {
    if (hasForbiddenPath(path, policy)) throw new Error(`RT_PUBLIC_TREE_FORBIDDEN_PATH:${path}`);
    const absolute = join(root, path);
    const entry = await lstat(absolute);
    if (!entry.isFile()) throw new Error(`RT_PUBLIC_TREE_SPECIAL_FILE:${path}`);
    const content = await readFile(absolute);
    const record = { path, bytes: content.byteLength, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` as const };
    const approved = expectedRecords.get(path);
    if (approved && (approved.bytes !== record.bytes || approved.digest !== record.digest)) throw new Error(`RT_PUBLIC_TREE_CONTENT_MISMATCH:${path}`);
    const text = content.toString("utf8");
    const forbidden = forbiddenContent.find((value) => value && text.includes(value));
    if (forbidden) throw new Error(`RT_PUBLIC_TREE_FORBIDDEN_CONTENT:${path}`);
    if (privateTagPattern.test(text)) throw new Error(`RT_PUBLIC_TREE_PRIVATE_TAG:${path}`);
    const issues = packageContentIssues(text, [root]);
    if (issues.length) throw new Error(`RT_PUBLIC_TREE_SENSITIVE_CONTENT:${path}:${JSON.stringify(issues)}`);
    records.push(record);
  }
  const treeDigest = `sha256:${createHash("sha256").update(records.map((file) => `${file.path}\0${file.bytes}\0${file.digest}\n`).join("")).digest("hex")}` as const;
  return { schemaVersion: "1.0", repository: manifest.repository, fileCount: records.length, totalBytes: records.reduce((total, file) => total + file.bytes, 0), treeDigest, trackedFilesExact: true, contentScan: "passed" };
}

function hasForbiddenPath(path: string, policy: PublicPolicy): boolean {
  return path.split(/[\\/]/u).some((segment) => {
    const folded = segment.toLocaleLowerCase("en-US");
    return folded === ".env" || folded.startsWith(".env.") || policy.forbiddenPathNames.some((name) => folded === name.toLocaleLowerCase("en-US"));
  });
}

async function trackedOrPresentFiles(root: string): Promise<string[]> {
  if ((await lstat(join(root, ".git")).catch(() => undefined))?.isDirectory()) {
    return (await exec("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout.split("\0").filter(Boolean).sort();
  }
  return (await walk(root)).map((path) => relative(root, path).split(sep).join("/")).sort();
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`RT_PUBLIC_TREE_SPECIAL_FILE:${path}`);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await verifyPublicTree(process.argv[2] ?? process.cwd()))}\n`);
}
