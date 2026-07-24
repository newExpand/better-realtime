import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("0.2 public migration boundary", () => {
  it("documents every intentionally breaking compatibility record", async () => {
    const guide = await read("docs/public/migration-0.2.md");
    const ledger = JSON.parse(await read("compatibility/changes.json")) as {
      changes: Array<{ id: string; classification: string; migrationGuide?: string }>;
    };
    const breaking = ledger.changes.filter(({ classification }) => classification === "intentionally_breaking");
    expect(breaking).toHaveLength(14);
    expect(breaking.every(({ migrationGuide }) => migrationGuide === "docs/public/migration-0.2.md")).toBe(true);
    for (const { id } of breaking) expect(guide).toContain(`\`${id}\``);
  });

  it("keeps package, React, wire, storage, and unsupported claims explicit", async () => {
    const [guide, quickstart, readme, changelog] = await Promise.all([
      read("docs/public/migration-0.2.md"),
      read("docs/public/quickstart.md"),
      read("README.md"),
      read("CHANGELOG.md")
    ]);
    for (const text of [guide, quickstart, readme]) {
      expect(text).toContain("better-realtime@0.2.0-alpha.1");
      expect(text).toContain("better-realtime-mcp@0.2.0-alpha.1");
    }
    expect(guide).toContain("totalPendingCount");
    expect(guide).toContain("prepare`/`mutate");
    expect(guide).toContain("storage version 2");
    expect(guide).toContain("ordinal zero");
    expect(guide).toContain("RT_CONTRACT_INCOMPATIBLE");
    expect(guide).toContain("must not share one namespace");
    expect(guide).toContain("not downgraded");
    expect(guide).toContain("local, read-only stdio");
    expect(guide).toContain("future, optional, demand-gated");
    expect(quickstart).not.toContain("npm install better-realtime@alpha");
    expect(changelog).toContain("14 intentionally breaking");
    expect(changelog).toContain("no wire-v2 change");
    expect(changelog).toContain("future, optional, and demand-gated");
  });

  it("binds the clean migration verifier to both exact package artifacts and executable fixtures", async () => {
    const [script, beforeReact, beforeServer, afterContract, afterReact, afterServer, afterRuntime] = await Promise.all([
      read("scripts/verify-migration-consumer.ts"),
      read("fixtures/migration-consumer/alpha4/src/react.tsx"),
      read("fixtures/migration-consumer/alpha4/src/server.ts"),
      read("fixtures/migration-consumer/candidate/src/contract.ts"),
      read("fixtures/migration-consumer/candidate/src/react.tsx"),
      read("fixtures/migration-consumer/candidate/src/server.ts"),
      read("fixtures/migration-consumer/candidate/runtime-check.mjs")
    ]);
    expect(script).toContain("803487cf32eca359ac85755b138119bf37c9e9afa476e55684971ed24057a6c2");
    expect(script).toContain("packRuntime");
    expect(script).toContain("packMcp");
    expect(script).toContain('verifyBin(afterDirectory, "better-realtime", runtime.version)');
    expect(script).toContain('verifyBin(afterDirectory, "better-realtime-mcp", runtime.version)');
    expect(script).toContain("npm\", [\"run\", \"typecheck\"");
    expect(script).toContain("npm\", [\"run\", \"build\"");
    expect(script).toContain("npm\", [\"run\", \"run\"");
    expect(beforeReact).toContain("totalPendingCount");
    expect(beforeServer).toContain("prepare:");
    expect(beforeServer).toContain("mutate:");
    expect(afterContract).toContain("stream({");
    expect(afterContract).toContain("stateStream({");
    expect(afterReact).toContain("pendingUntil: \"observed\"");
    expect(afterReact).toContain("@ts-expect-error");
    expect(afterServer).toContain("targets:");
    expect(afterServer).toContain("execute:");
    expect(afterRuntime).toContain('from "better-realtime-mcp"');
  });
});

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(root, relativePath), "utf8");
}
