import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { assertPackageArtifactText, importedNodeBuiltins, packageContentIssues } from "../scripts/package-content-policy.ts";
import { assertRepositoryReadmeReleaseState, packageReadme } from "../scripts/pack-runtime.ts";
import { verifyPackedArtifactContent } from "../scripts/verify-package-artifact-content.ts";

const exec = promisify(execFile);

it.each([
  ["GitHub token", `const value='${["gh", "p_abcdefghijklmnopqrstuvwxyz123456"].join("")}';`, "secret"],
  ["AWS access key", ["AK", "IAABCDEFGHIJKLMNOP"].join(""), "secret"],
  ["credential URL", ["postgresql://runtime:", "super-secret@db.example/realtime"].join(""), "secret"],
  ["assigned secret", ["client_secret", "='", "abcdefghijklmnopqrstuvwxyz123456", "'"].join(""), "secret"],
  ["Codex handoff", ["<", "source_thread_id>", "synthetic-private-thread", "</source_thread_id>"].join(""), "secret"],
  ["macOS path", ["/", "Users/alice/work/customer/private.json"].join(""), "absolute_path"],
  ["Linux path", ["/", "home/alice/work/customer/private.json"].join(""), "absolute_path"],
  ["macOS temp path", ["/var/", "folders/ab/cd/T/realtime-clean-room/private.json"].join(""), "absolute_path"],
  ["Windows path", ["C:\\", "Users\\alice\\work\\private.json"].join(""), "absolute_path"]
] as const)("rejects seeded package content: %s", (_label, source, code) => {
  expect(packageContentIssues(source)).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
});

it("accepts ordinary package code and catches every Node builtin spelling", () => {
  expect(packageContentIssues("export const endpoint='/api/realtime';")).toEqual([]);
  expect(importedNodeBuiltins("import fs from 'fs'; import('node:crypto'); const path=require('node:path'); import x from 'node:child_process';")).toEqual([
    "fs", "node:child_process", "node:crypto", "node:path"
  ]);
});

it("rejects seeded generated MCP output before publication", () => {
  const generated = [
    `export const localEvidence = '${["/", "Users/alice/private/evidence.json"].join("")}';`,
    `export const credential = '${["gh", "p_abcdefghijklmnopqrstuvwxyz123456"].join("")}';`
  ].join("\n");
  expect(() => assertPackageArtifactText("package/dist/bin.js", generated, ["/workspace/private"])).toThrow(
    "RT_PACKAGE_ARTIFACT_SENSITIVE_CONTENT:package/dist/bin.js"
  );
});

it("scans the extracted files from the exact package tarball", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-realtime-content-policy-"));
  try {
    const packageDirectory = join(directory, "package");
    const distributionDirectory = join(packageDirectory, "dist");
    await mkdir(distributionDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0" })}\n`);
    await writeFile(join(distributionDirectory, "bin.js"), "export const endpoint = '/api/realtime';\n");
    const tarball = join(directory, "fixture.tgz");
    await exec("tar", ["-czf", tarball, "package"], { cwd: directory });
    await expect(verifyPackedArtifactContent(tarball)).resolves.toMatchObject({
      artifact: "fixture.tgz",
      files: 2,
      contentScan: "passed"
    });

    await writeFile(
      join(distributionDirectory, "bin.js"),
      `export const evidence = '${["/", "Users/alice/private/evidence.json"].join("")}';\n`
    );
    await exec("tar", ["-czf", tarball, "package"], { cwd: directory });
    await expect(verifyPackedArtifactContent(tarball)).rejects.toThrow(
      "RT_PACKAGE_ARTIFACT_SENSITIVE_CONTENT:package/dist/bin.js"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rewrites repository-relative package README links to the checksum-pinned public tag", () => {
  const transformed = packageReadme([
    "<!-- release-state:begin -->",
    "> `0.1.0-alpha.1` is the current published alpha.",
    "<!-- release-state:end -->",
    "<!-- install-state:begin -->",
    "## Install the current alpha",
    "<!-- install-state:end -->",
    "npm install better-realtime@0.1.0-alpha.1 react",
    "npm install better-realtime@0.1.0-alpha.1 pg ws",
    "npm install better-realtime-mcp@0.1.0-alpha.1",
    "[Quickstart](docs/public/quickstart.md)",
    "![Recovery](docs/public/assets/recovery-demo.gif)",
    "[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)",
    "[Fixture](fixtures/external-consumer)",
    "[Section](#diagnostics)",
    "[npm](https://www.npmjs.com/package/better-realtime)"
  ].join("\n"), "0.1.0-alpha.1");
  expect(transformed).toContain("https://github.com/newExpand/better-realtime/blob/v0.1.0-alpha.1/docs/public/quickstart.md");
  expect(transformed).toContain("https://raw.githubusercontent.com/newExpand/better-realtime/v0.1.0-alpha.1/docs/public/assets/recovery-demo.gif");
  expect(transformed).toContain("https://github.com/newExpand/better-realtime/tree/v0.1.0-alpha.1/fixtures/external-consumer");
  expect(transformed).toContain("https://github.com/newExpand/better-realtime/blob/v0.1.0-alpha.1/LICENSE");
  expect(transformed).toContain("This immutable package artifact is version `0.1.0-alpha.1`");
  expect(transformed).toContain("## Install this package version");
  expect(transformed).not.toContain("is the current published alpha");
  expect(transformed).toContain("[Section](#diagnostics)");
  expect(transformed).toContain("[npm](https://www.npmjs.com/package/better-realtime)");
});

it("binds repository README release and install language to the current support version", () => {
  const published = [
    "<!-- release-state:begin -->",
    "> `0.2.0-alpha.1` is the current published alpha.",
    "<!-- release-state:end -->",
    "<!-- install-state:begin -->",
    "## Install the current alpha",
    "<!-- install-state:end -->",
    "npm install better-realtime@0.2.0-alpha.1 react",
    "npm install better-realtime@0.2.0-alpha.1 pg ws",
    "npm install better-realtime-mcp@0.2.0-alpha.1"
  ].join("\n");
  expect(() => assertRepositoryReadmeReleaseState(published, "0.2.0-alpha.1", "0.2.0-alpha.1")).not.toThrow();

  const candidate = published
    .replace("`0.2.0-alpha.1` is the current published alpha.", "`0.2.0-alpha.1` remains the current published alpha. `0.2.0-alpha.2` is the release candidate.")
    .replace("## Install the current alpha", "## Install the release candidate")
    .replaceAll("0.2.0-alpha.1", "0.2.0-alpha.2")
    .replace("`0.2.0-alpha.2` remains", "`0.2.0-alpha.1` remains");
  expect(() => assertRepositoryReadmeReleaseState(candidate, "0.2.0-alpha.2", "0.2.0-alpha.1")).not.toThrow();

  expect(() => assertRepositoryReadmeReleaseState(
    published.replace("current published alpha", "unpublished `0.2.0-alpha.1` candidate"),
    "0.2.0-alpha.1",
    "0.2.0-alpha.1"
  )).toThrow();
  expect(() => assertRepositoryReadmeReleaseState(
    published.replace("better-realtime-mcp@0.2.0-alpha.1", "better-realtime-mcp@0.1.0-alpha.4"),
    "0.2.0-alpha.1",
    "0.2.0-alpha.1"
  )).toThrow("RT_PACKAGE_README_INSTALL_VERSION_DRIFT");
});
