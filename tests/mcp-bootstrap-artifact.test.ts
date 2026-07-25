import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertExactMcpBootstrapManifest,
  createMcpBootstrapManifest,
  MCP_BOOTSTRAP_NPM_VERSION,
} from "../scripts/lib/mcp-bootstrap-contract.js";

const exec = promisify(execFile);

describe("MCP package bootstrap artifact", () => {
  it("pins acquisition of the approved npm packer to the public registry", async () => {
    const source = await readFile(resolve(import.meta.dirname, "..", "scripts/create-mcp-bootstrap-artifact.ts"), "utf8");
    expect(source).toContain("npm_config_registry: MCP_BOOTSTRAP_REGISTRY");
    expect(source.match(/env: pinnedRegistryEnvironment/gu)).toHaveLength(2);
  });

  it("creates an inert exact three-file reservation without mutating npm", async () => {
    const output = await mkdtemp(join(tmpdir(), "better-realtime-mcp-bootstrap-test-"));
    try {
      const result = await exec("pnpm", ["exec", "tsx", "scripts/create-mcp-bootstrap-artifact.ts", output], { cwd: resolve(import.meta.dirname, "..") });
      const report = JSON.parse(result.stdout) as {
        package: string;
        version: string;
        artifact: string;
        sha256: string;
        files: number;
        publishTag: string;
        npmVersion: string;
      };
      expect(report).toMatchObject({
        package: "better-realtime-mcp",
        version: "0.0.0-bootstrap.0",
        files: 3,
        publishTag: "bootstrap",
        npmVersion: MCP_BOOTSTRAP_NPM_VERSION,
      });
      expect(report.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const listing = await exec("tar", ["-tzf", report.artifact]);
      expect(listing.stdout.split("\n").filter(Boolean).sort()).toEqual([
        "package/LICENSE",
        "package/README.md",
        "package/package.json",
      ]);
      const manifest = JSON.parse((await exec("tar", ["-xOzf", report.artifact, "package/package.json"])).stdout) as Record<string, unknown>;
      expect(manifest).toEqual(createMcpBootstrapManifest());
      expect(() => assertExactMcpBootstrapManifest(manifest)).not.toThrow();
      expect((await readFile(report.artifact)).byteLength).toBeGreaterThan(0);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    ["scripts", { postinstall: "node exploit.js" }],
    ["bin", { "better-realtime-mcp": "index.js" }],
    ["main", "index.js"],
    ["exports", "./index.js"],
    ["man", ["better-realtime-mcp.1"]],
    ["dependencies", { package: "1.0.0" }],
    ["devDependencies", { package: "1.0.0" }],
    ["peerDependencies", { package: "1.0.0" }],
    ["optionalDependencies", { package: "1.0.0" }],
    ["bundledDependencies", ["package"]],
    ["private", true],
  ])("rejects a bootstrap manifest containing %s", (key, value) => {
    expect(() => assertExactMcpBootstrapManifest({
      ...createMcpBootstrapManifest(),
      [key]: value,
    })).toThrowError("RT_MCP_BOOTSTRAP_MANIFEST_INVALID");
  });
});
