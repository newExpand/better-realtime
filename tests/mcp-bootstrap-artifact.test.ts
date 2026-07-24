import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("MCP package bootstrap artifact", () => {
  it("creates an inert exact three-file reservation without mutating npm", async () => {
    const output = await mkdtemp(join(tmpdir(), "better-realtime-mcp-bootstrap-test-"));
    try {
      const result = await exec("pnpm", ["exec", "tsx", "scripts/create-mcp-bootstrap-artifact.ts", output], { cwd: resolve(import.meta.dirname, "..") });
      const report = JSON.parse(result.stdout) as { package: string; version: string; artifact: string; sha256: string; files: number; publishTag: string };
      expect(report).toMatchObject({ package: "better-realtime-mcp", version: "0.0.0-bootstrap.0", files: 3, publishTag: "bootstrap" });
      expect(report.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const listing = await exec("tar", ["-tzf", report.artifact]);
      expect(listing.stdout.split("\n").filter(Boolean).sort()).toEqual([
        "package/LICENSE",
        "package/README.md",
        "package/package.json",
      ]);
      const manifest = JSON.parse((await exec("tar", ["-xOzf", report.artifact, "package/package.json"])).stdout) as Record<string, unknown>;
      expect(manifest).not.toHaveProperty("bin");
      expect(manifest).not.toHaveProperty("dependencies");
      expect((await readFile(report.artifact)).byteLength).toBeGreaterThan(0);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);
});
