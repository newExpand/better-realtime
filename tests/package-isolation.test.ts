import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReleasePackageBoundary, assertSingleReleasePackage } from "../scripts/assert-single-release-package.ts";
import { assertBrowserArtifactIsolation } from "../scripts/check-browser-artifact-isolation.ts";
import { assertMcpRuntimeVersion } from "../scripts/pack-mcp.ts";

const root = resolve(import.meta.dirname, "..");

describe("browser and Node dependency isolation", () => {
  it("keeps the browser root on the diagnostics browser subpath", async () => {
    const [runtime, diagnosticsManifest, vite] = await Promise.all([
      readFile(resolve(root, "packages/runtime/src/index.ts"), "utf8"),
      readFile(resolve(root, "packages/diagnostics/package.json"), "utf8"),
      readFile(resolve(root, "packages/runtime/vite.config.ts"), "utf8")
    ]);
    expect(runtime).toContain('from "@realtime/diagnostics/browser"');
    expect(runtime).not.toContain('from "@realtime/diagnostics";');
    expect(JSON.parse(diagnosticsManifest).exports).toHaveProperty("./browser", "./src/browser.ts");
    expect(vite).toContain('{ find: "@realtime/diagnostics/browser", replacement: workspaceSource("../diagnostics/src/browser.ts") }');
  });

  it("walks emitted browser chunks and rejects diagnostic query or Node proof code", async () => {
    const room = await mkdtemp(join(tmpdir(), "better-realtime-browser-graph-"));
    try {
      await mkdir(join(room, "chunks"));
      await writeFile(join(room, "index.js"), 'import "./chunks/shared.js"; export const ok = true;\n', "utf8");
      await writeFile(join(room, "chunks/shared.js"), 'export const proof = "pg_advisory_xact_lock";\n', "utf8");
      await expect(assertBrowserArtifactIsolation(room)).rejects.toThrow(
        "RT_BROWSER_ARTIFACT_FORBIDDEN_CONTENT:chunks/shared.js:pg_advisory_xact_lock"
      );
      await writeFile(join(room, "chunks/shared.js"), 'import "node:fs";\n', "utf8");
      await expect(assertBrowserArtifactIsolation(room)).rejects.toThrow(
        "RT_BROWSER_ARTIFACT_FORBIDDEN_IMPORT:chunks/shared.js:node:fs"
      );
      await writeFile(join(room, "chunks/shared.js"), "export const browserSafe = true;\n", "utf8");
      await expect(assertBrowserArtifactIsolation(room)).resolves.toMatchObject({
        entry: "index.js",
        reachableFiles: ["chunks/shared.js", "index.js"]
      });
    } finally {
      await rm(room, { recursive: true, force: true });
    }
  });

  it("keeps the base package free of MCP and auto-installed server peers", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "packages/runtime/package.json"), "utf8")) as {
      engines?: unknown;
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
      dependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(manifest.engines).toBeUndefined();
    expect(manifest.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(manifest.dependencies).not.toHaveProperty("@types/pg");
    expect(manifest.dependencies).not.toHaveProperty("@types/node");
    expect(manifest.dependencies).not.toHaveProperty("pg-protocol");
    expect(manifest.dependencies).not.toHaveProperty("pg-types");
    expect(manifest.bin).not.toHaveProperty("better-realtime-mcp");
    expect(manifest.exports).not.toHaveProperty("./mcp");
    expect(manifest.peerDependenciesMeta).toMatchObject({
      pg: { optional: true },
      react: { optional: true },
      ws: { optional: true }
    });
  });

  it("declares only shipped Node entrypoints as side-effectful", async () => {
    const [manifestSource, fileManifestSource] = await Promise.all([
      readFile(resolve(root, "packages/runtime/package.json"), "utf8"),
      readFile(resolve(root, "release/package-files.json"), "utf8")
    ]);
    const manifest = JSON.parse(manifestSource) as { sideEffects?: string[] };
    const fileManifest = JSON.parse(fileManifestSource) as { files?: string[] };
    const shipped = new Set(fileManifest.files ?? []);

    expect(manifest.sideEffects).toEqual([
      "./dist/node-only.js",
      "./dist/cli-bin.js",
      "./dist/server.js",
      "./dist/diagnostic-io.js"
    ]);
    for (const entry of manifest.sideEffects ?? []) {
      expect(shipped.has(entry.replace(/^\.\//u, "")), entry).toBe(true);
    }
  });

  it("isolates the MCP SDK and executable in its own publishable package", async () => {
    const [manifestSource, runtimeManifestSource, rootTsconfigSource, mcpTsconfigSource, vitestConfig] = await Promise.all([
      readFile(resolve(root, "packages/mcp/package.json"), "utf8"),
      readFile(resolve(root, "packages/runtime/package.json"), "utf8"),
      readFile(resolve(root, "tsconfig.json"), "utf8"),
      readFile(resolve(root, "packages/mcp/tsconfig.json"), "utf8"),
      readFile(resolve(root, "vitest.config.ts"), "utf8")
    ]);
    const typedManifest = JSON.parse(manifestSource) as {
      name?: string;
      version?: string;
      engines?: Record<string, string>;
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const runtimeManifest = JSON.parse(runtimeManifestSource) as { version: string };
    const rootTsconfig = JSON.parse(rootTsconfigSource) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    const mcpTsconfig = JSON.parse(mcpTsconfigSource) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    expect(typedManifest.dependencies?.["better-realtime"]).toBe("workspace:*");
    expect(rootTsconfig.compilerOptions?.paths).toEqual({
      "better-realtime": ["./packages/runtime/src/index.ts"],
      "better-realtime/diagnostics": ["./packages/runtime/src/diagnostic-io.ts"]
    });
    expect(mcpTsconfig.compilerOptions?.paths).toEqual({});
    expect(vitestConfig).toContain("find: /^better-realtime\\/diagnostics$/");
    expect(vitestConfig).toContain(
      'replacement: fileURLToPath(new URL("./packages/runtime/src/diagnostic-io.ts", import.meta.url))'
    );
    expect(vitestConfig).toContain("find: /^better-realtime$/");
    expect(vitestConfig).toContain('replacement: fileURLToPath(new URL("./packages/runtime/src/index.ts", import.meta.url))');
    expect(typedManifest).toMatchObject({
      name: "better-realtime-mcp",
      engines: { node: ">=22.0.0" },
      bin: { "better-realtime-mcp": "./dist/bin.js" }
    });
    expect(typedManifest.dependencies).toHaveProperty("@modelcontextprotocol/sdk");
    expect(typedManifest.dependencies).toHaveProperty("better-realtime");
    expect(typedManifest.dependencies).not.toHaveProperty("pg");
    expect(typedManifest.dependencies).not.toHaveProperty("ws");
    expect(() => assertMcpRuntimeVersion(typedManifest.version, runtimeManifest.version)).not.toThrow();
    expect(() => assertMcpRuntimeVersion("0.2.0-alpha.2", runtimeManifest.version)).toThrow("RT_MCP_RUNTIME_VERSION_SKEW");
  });

  it("preserves the historical single-package boundary and selects the two-package bundle for 0.2", async () => {
    const [policy, workflow, bundlePolicy, bundleWorkflow, ci, runbook, bundleRunbook] = await Promise.all([
      readFile(resolve(root, "release/package-boundaries.json"), "utf8"),
      readFile(resolve(root, ".github/workflows/release.yml"), "utf8"),
      readFile(resolve(root, "release/release-bundle-boundaries.json"), "utf8"),
      readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8"),
      readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(root, "docs/public/release.md"), "utf8"),
      readFile(resolve(root, "docs/public/release-bundle.md"), "utf8")
    ]);
    expect(JSON.parse(policy)).toMatchObject({
      schemaVersion: "1.0",
      scope: expect.stringContaining("Historical release.yml single-package boundary through 0.1.x"),
      packages: {
        "better-realtime": {
          artifactCommand: "package:pack",
          workflow: ".github/workflows/release.yml",
          environment: "npm-alpha",
          versionPolicy: "0.1.x-alpha",
          status: "active"
        },
        "better-realtime-mcp": {
          artifactCommand: "package:pack:mcp",
          workflow: null,
          environment: null,
          status: "future-separate-release"
        }
      }
    });
    await expect(assertReleasePackageBoundary({
      packageName: "better-realtime",
      manifest: "packages/runtime/package.json",
      artifactCommand: "package:pack",
      workflow: ".github/workflows/release.yml",
      environment: "npm-alpha",
      version: "0.1.0-alpha.4"
    })).resolves.toBeUndefined();
    await expect(assertSingleReleasePackage({
      packageName: "better-realtime",
      manifest: "packages/runtime/package.json",
      artifactCommand: "package:pack",
      workflow: ".github/workflows/release.yml",
      environment: "npm-alpha",
      version: "0.1.0-alpha.4"
    })).resolves.toBeUndefined();
    await expect(assertReleasePackageBoundary({
      packageName: "better-realtime",
      manifest: "packages/runtime/package.json",
      artifactCommand: "package:pack",
      workflow: ".github/workflows/release.yml",
      environment: "npm-alpha",
      version: "0.2.0-alpha.1"
    })).rejects.toThrow("RT_RELEASE_PACKAGE_VERSION_BOUNDARY_MISMATCH:0.2.0-alpha.1");
    await expect(assertReleasePackageBoundary({
      packageName: "better-realtime-mcp",
      manifest: "packages/mcp/package.json",
      artifactCommand: "package:pack:mcp",
      workflow: ".github/workflows/release-mcp.yml",
      environment: "npm-mcp-alpha",
      version: "0.1.0-alpha.4"
    })).rejects.toThrow("RT_RELEASE_PACKAGE_REQUIRES_SEPARATE_IDENTITY");
    await expect(assertReleasePackageBoundary({
      packageName: "better-realtime",
      manifest: "packages/runtime/package.json",
      artifactCommand: "package:pack:mcp",
      workflow: ".github/workflows/release.yml",
      environment: "npm-alpha",
      version: "0.1.0-alpha.4"
    })).rejects.toThrow("RT_RELEASE_PACKAGE_BOUNDARY_MISMATCH");
    expect(workflow).toContain("pnpm --dir release-source release:single-package:check");
    expect(workflow).toContain("RELEASE_PACKAGE_NAME: better-realtime");
    expect(workflow).toContain("RELEASE_VERSION: ${{ inputs.version }}");
    expect(workflow).toContain('[[ "$INPUT_VERSION" =~ ^0\\.1\\.[0-9]+-alpha\\.[1-9][0-9]*$ ]]');
    expect(workflow).toContain("pnpm --dir release-source --silent package:pack");
    expect(workflow).not.toContain("package:pack:mcp");
    expect(runbook).toContain("The historical `0.1.x` release boundary published only `better-realtime`.");
    expect(runbook).toContain("Beginning with the published `0.2.0-alpha.1` release");
    expect(JSON.parse(bundlePolicy)).toMatchObject({
      schemaVersion: "1.0",
      workflow: ".github/workflows/release-bundle.yml",
      packages: [
        { name: "better-realtime", environment: "npm-alpha" },
        { name: "better-realtime-mcp", environment: "npm-mcp-alpha" }
      ]
    });
    expect(bundleWorkflow).toContain("pnpm --dir release-source --silent package:pack");
    expect(bundleWorkflow).toContain("pnpm --dir release-source --silent package:pack:mcp");
    expect(bundleRunbook).toContain("two independently published npm packages");
    const isolation = workflow.indexOf("pnpm --dir release-source package:clean-room:isolation");
    const artifact = workflow.indexOf("name: Build the release artifact once");
    expect(isolation).toBeGreaterThan(-1);
    expect(isolation).toBeLessThan(artifact);
    expect(ci).toContain("pnpm package:clean-room:isolation");
  });

  it("installs the MCP companion in the default candidate dogfood journey", async () => {
    const journey = await readFile(resolve(root, "scripts/verify-consumer-journey.ts"), "utf8");
    expect(journey).toContain('import { packMcp } from "./pack-mcp.ts"');
    expect(journey).toContain("generatedMcpTarball");
    expect(journey).toContain("...(mcpTarball ? [mcpTarball] : [])");
  });

  it("guards every Node-only executable entry at runtime", async () => {
    const sources = await Promise.all([
      "packages/runtime/src/server-entry.ts",
      "packages/runtime/src/diagnostics-entry.ts",
      "packages/runtime/src/cli-bin.ts",
      "packages/mcp/src/bin.ts"
    ].map((path) => readFile(resolve(root, path), "utf8")));
    for (const source of sources) expect(source).toContain("assertSupportedNodeRuntime");
  });

  it("scans both exact tarballs in pack and verification-only paths", async () => {
    const [runtimePack, mcpPack, isolation] = await Promise.all([
      readFile(resolve(root, "scripts/pack-runtime.ts"), "utf8"),
      readFile(resolve(root, "scripts/pack-mcp.ts"), "utf8"),
      readFile(resolve(root, "scripts/verify-package-isolation.ts"), "utf8")
    ]);
    for (const source of [runtimePack, mcpPack, isolation]) {
      expect(source).toContain("verifyPackedArtifactContent");
    }
  });
});
