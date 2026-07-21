import { expect, it } from "vitest";
import { importedNodeBuiltins, packageContentIssues } from "../scripts/package-content-policy.ts";
import { packageReadme } from "../scripts/pack-runtime.ts";

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

it("rewrites repository-relative package README links to the immutable public tag", () => {
  const transformed = packageReadme([
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
  expect(transformed).toContain("[Section](#diagnostics)");
  expect(transformed).toContain("[npm](https://www.npmjs.com/package/better-realtime)");
});
