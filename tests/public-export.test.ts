import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPrivateExportPolicyBoundary, exportPublic } from "../scripts/export-public.ts";
import { verifyPublicTree } from "../scripts/verify-public-tree.ts";
import { promisify } from "node:util";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("deterministic clean-history public export", () => {
  it("exports only the allowlisted, scanned Better Realtime tree", async () => {
    const ignoredEnvironment = resolve("packages/protocol/.env.public-export-test");
    const reviewWorktreeFile = resolve("packages/protocol/public-export-untracked-test.txt");
    await writeFile(ignoredEnvironment, "SHORT_LOCAL_VALUE=not-public\n", "utf8");
    await writeFile(reviewWorktreeFile, "reviewed public worktree input\n", "utf8");
    temporary.push(ignoredEnvironment, reviewWorktreeFile);
    const parent = await mkdtemp(join(tmpdir(), "better-realtime-public-export-test-"));
    temporary.push(parent);
    const report = await exportPublic(join(parent, "tree"));
    expect(report.repository).toBe("newExpand/better-realtime");
    expect(report.exclusionsVerified).toBe(true);
    expect(report.gitHistoryIncluded).toBe(false);
    expect(report.files.map(({ path }) => path)).toContain("packages/runtime/package.json");
    expect(report.files.map(({ path }) => path)).toContain("release/public-export.json");
    expect(report.files.map(({ path }) => path)).toContain("release/public-release-identity.schema.json");
    expect(report.files.map(({ path }) => path)).not.toContain("release/.private-export-policy.json");
    expect(report.files.map(({ path }) => path)).not.toContain(["docs", "internal", "schemas", "private-release-identity.schema.json"].join("/"));
    expect(report.files.map(({ path }) => path)).not.toContain(["docs", "internal", "releases", "v0.1.0-alpha.4.identity.json"].join("/"));
    expect(report.files.map(({ path }) => path)).not.toContain(["docs", "internal", "tools", "create-private-release-identity.mjs"].join("/"));
    expect(report.files.map(({ path }) => path)).toContain("docs/public/assets/recovery-demo.gif");
    expect(report.files.some(({ path }) => /(^|\/)(?:AGENTS|CLAUDE)(?:\.override)?\.md$/iu.test(path))).toBe(false);
    expect(report.files.some(({ path }) => path.startsWith(["docs", "internal", ""].join("/")))).toBe(false);
    expect(report.files.some(({ path }) => path.includes(".env"))).toBe(false);
    expect(report.files.map(({ path }) => path)).toContain("packages/protocol/public-export-untracked-test.txt");
    expect(report.sourceMode).toBe("review_worktree");
    expect(await readFile(join(parent, "tree/LICENSE"), "utf8")).toContain("Copyright (c) 2026 ByteLoft");
  });

  it("rejects a path that only shares the temporary-root string prefix", async () => {
    await expect(exportPublic(`${resolve(process.env.TMPDIR ?? "/tmp")}-victim/tree`)).rejects.toThrow("RT_PUBLIC_EXPORT_OUTPUT_UNSAFE");
  });

  it("verifies every public tracked file against the generated approved manifest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "better-realtime-public-tree-test-"));
    temporary.push(parent);
    const tree = join(parent, "tree");
    const report = await exportPublic(tree);
    await exec("git", ["init", "-b", "main"], { cwd: tree });
    await exec("git", ["add", "."], { cwd: tree });
    await expect(verifyPublicTree(tree)).resolves.toMatchObject({ fileCount: report.fileCount, treeDigest: report.treeDigest, trackedFilesExact: true, contentScan: "passed" });
    await writeFile(join(tree, "UNAPPROVED.txt"), "not in the approved public manifest\n", "utf8");
    await exec("git", ["add", "UNAPPROVED.txt"], { cwd: tree });
    await expect(verifyPublicTree(tree)).rejects.toThrow("RT_PUBLIC_TREE_TRACKED_MISMATCH");
  });

  it.each(["source/", "source-export/"])("rejects %sversioned private tag references without exporting a real tag", async (namespace) => {
    const seededReference = resolve("packages/protocol/public-export-private-source-reference.txt");
    await writeFile(seededReference, [namespace, "v9.8.7-alpha.6"].join(""), "utf8");
    temporary.push(seededReference);
    const parent = await mkdtemp(join(tmpdir(), "better-realtime-public-export-private-source-test-"));
    temporary.push(parent);
    await expect(exportPublic(join(parent, "tree"))).rejects.toThrow("RT_PUBLIC_EXPORT_PRIVATE_SOURCE_REFERENCE");
  });

  it("rejects private release-state wording from the public export", async () => {
    const privatePolicy = resolve("release/.private-export-policy.json");
    const hasPrivatePolicy = await readFile(privatePolicy, "utf8").then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!hasPrivatePolicy) {
      const privateMode = await readFile(resolve("AGENTS.md"), "utf8").then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      expect(privateMode).toBe(false);
      return;
    }
    const seededReference = resolve("packages/protocol/public-export-private-release-state.txt");
    await writeFile(seededReference, ["The existing private and ", "public alpha.2 tags are preserved.\n"].join(""), "utf8");
    temporary.push(seededReference);
    const parent = await mkdtemp(join(tmpdir(), "better-realtime-public-export-private-release-state-test-"));
    temporary.push(parent);
    await expect(exportPublic(join(parent, "tree"))).rejects.toThrow("RT_PUBLIC_EXPORT_FORBIDDEN_CONTENT");
  });

  it("requires the private overlay whenever the private repository sentinel exists", () => {
    expect(() => assertPrivateExportPolicyBoundary(true, undefined)).toThrow("RT_PUBLIC_EXPORT_PRIVATE_POLICY_REQUIRED");
    expect(() => assertPrivateExportPolicyBoundary(false, undefined)).not.toThrow();
  });
});
