import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPackageFileManifest } from "../scripts/pack-runtime.ts";

const root = resolve(import.meta.dirname, "..");

describe("Better Realtime public release identity", () => {
  it("keeps package, executables, repository, license, and publish policy exact", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "packages/runtime/package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "better-realtime",
      version: "0.2.0-alpha.1",
      license: "MIT",
      bin: {
        "better-realtime": "./dist/cli-bin.js"
      },
      repository: { type: "git", url: "git+https://github.com/newExpand/better-realtime.git" },
      homepage: "https://github.com/newExpand/better-realtime#readme",
      bugs: { url: "https://github.com/newExpand/better-realtime/issues" },
      publishConfig: { access: "public", tag: "alpha", provenance: true }
    });
    expect(manifest.private).not.toBe(true);
    expect(manifest).toMatchObject({
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      files: ["dist"],
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./react": { types: "./dist/react.d.ts", import: "./dist/react.js" },
        "./server": { types: "./dist/server.d.ts", browser: "./dist/node-only.js", node: "./dist/server.js" },
        "./diagnostics": { types: "./dist/diagnostic-io.d.ts", browser: "./dist/node-only.js", node: "./dist/diagnostic-io.js" }
      },
      peerDependencies: { pg: ">=8.22.0 <9", react: ">=18.2.0 <20", ws: ">=8.21.1 <9" },
      peerDependenciesMeta: { pg: { optional: true }, react: { optional: true }, ws: { optional: true } }
    });
    expect(manifest).not.toHaveProperty("engines");
    expect(manifest.exports).not.toHaveProperty("./mcp");
    const mcpManifest = JSON.parse(await readFile(resolve(root, "packages/mcp/package.json"), "utf8")) as Record<string, unknown>;
    expect(mcpManifest).toMatchObject({
      name: "better-realtime-mcp",
      version: "0.2.0-alpha.1",
      engines: { node: ">=22.0.0" },
      bin: { "better-realtime-mcp": "./dist/bin.js" }
    });
  });

  it("fails closed on missing or unexpected package files", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "release/package-files.json"), "utf8")) as { schemaVersion: "1.0"; package: string; files: string[] };
    expect(() => assertPackageFileManifest(manifest, manifest.files, "better-realtime")).not.toThrow();
    expect(() => assertPackageFileManifest(manifest, manifest.files.slice(1), "better-realtime")).toThrow("RT_PACKAGE_FILE_MANIFEST_DRIFT:missing=");
    expect(() => assertPackageFileManifest(manifest, [...manifest.files, "dist/unreviewed.js"], "better-realtime")).toThrow("unexpected=dist/unreviewed.js");
  });

  it("contains the approved MIT holder and public subprotocol", async () => {
    expect(await readFile(resolve(root, "LICENSE"), "utf8")).toContain("Copyright (c) 2026 ByteLoft");
    const protocol = await readFile(resolve(root, "packages/protocol/src/constants.ts"), "utf8");
    expect(protocol).toContain('BETTER_REALTIME_SUBPROTOCOL = "better-realtime.v1"');
    const browserTransport = await readFile(resolve(root, "packages/transport-reference/src/browser.ts"), "utf8");
    expect(browserTransport).toContain('from "@realtime/protocol/constants"');
    expect(browserTransport).not.toContain('from "@realtime/protocol"');
    expect(protocol).not.toMatch(/node:/u);
  });

  it("keeps future public history in English Conventional Commits", async () => {
    const contributing = await readFile(resolve(root, "CONTRIBUTING.md"), "utf8");
    expect(contributing).toContain("All public repository commit subjects and pull request titles must use English Conventional Commits");
    expect(contributing).toContain("Public commit bodies and release-facing change notes must also be written in English");
  });

  it("keeps public issue, conduct, and security reporting channels distinct", async () => {
    const conduct = await readFile(resolve(root, "CODE_OF_CONDUCT.md"), "utf8");
    const security = await readFile(resolve(root, "SECURITY.md"), "utf8");
    expect(conduct).toContain("Use GitHub Issues for ordinary bug reports and feature requests.");
    expect(conduct).toContain("Report conduct concerns privately to support@byteloft.app.");
    expect(conduct).toContain("Do not use this address for security vulnerabilities; use GitHub Private Vulnerability Reporting instead.");
    expect(security).toContain("Do not open a public issue for a suspected vulnerability.");
    expect(security).toContain("Use GitHub private vulnerability reporting for `newExpand/better-realtime`.");
  });

  it("keeps the public README install, links, recovery, and evidence path honest", async () => {
    const template = await readFile(resolve(root, "support/README.template.md"), "utf8");
    const readme = await readFile(resolve(root, "README.md"), "utf8");
    const quickstart = await readFile(resolve(root, "docs/public/quickstart.md"), "utf8");
    const diagnostics = await readFile(resolve(root, "docs/public/diagnostics.md"), "utf8");
    const runbook = await readFile(resolve(root, "docs/public/release.md"), "utf8");
    for (const document of [template, readme, quickstart]) {
      expect(document).toContain("npm install better-realtime@0.2.0-alpha.1 react");
      expect(document).toContain("npm install better-realtime@0.2.0-alpha.1 pg ws");
      expect(document).toContain("npm install better-realtime-mcp@0.2.0-alpha.1");
      expect(document).not.toContain("npm install better-realtime react pg ws");
    }
    for (const document of [template, readme]) {
      expect(document).toContain("`0.1.0-alpha.4` is the current published evaluation release");
      expect(document).toContain("unpublished `0.2.0-alpha.1` candidate");
    }
    expect(quickstart).toContain("release candidate for Better Realtime `0.2.0-alpha.1`");
    expect(template).toContain("this is stream recovery, not resume-token session restoration");
    expect(template).toContain("pnpm e2e:consumer");
    expect(template).toContain("npm exec -- better-realtime doctor");
    expect(template).not.toMatch(/^better-realtime doctor/gmu);
    expect(template).toContain("docs/public/assets/recovery-demo.gif");
    expect(template).toContain('import { createRealtimeClient } from "better-realtime"');
    expect(template).not.toContain('import { createRealtimeServer, postgres } from "better-realtime/server"');
    for (const target of [...template.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]!)) {
      if (/^(?:https:\/\/|#)/u.test(target)) continue;
      expect(target).not.toMatch(/(?:^\/|\.\.|\\)/u);
      await expect(access(resolve(root, target))).resolves.toBeUndefined();
    }
    expect(quickstart).toContain("inbox: stateStream({");
    expect(quickstart).toContain("notificationAdded: {");
    expect(quickstart).toContain("reduce: (state, item)");
    expect(quickstart).toContain("export const contract = defineRealtimeContract");
    expect(quickstart).toContain('import { contract } from "./contract.js"');
    expect(diagnostics).toContain('mode: 0o600');
    expect(diagnostics).toContain('flag: "wx"');
    expect(diagnostics).toContain('REALTIME_EVIDENCE_FILE="$PWD/incident.evidence.json"');
    expect(diagnostics).toContain("npm exec -- better-realtime-mcp");
    expect(runbook).not.toMatch(/\bsource\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u);
  });

  it("keeps package SemVer independent from diagnostic schema versioning", async () => {
    const schema = JSON.parse(await readFile(resolve(root, "spec/diagnostics/v1/query-result.schema.json"), "utf8")) as { properties: { productVersion: Record<string, unknown> } };
    expect(schema.properties.productVersion).toMatchObject({ type: "string", pattern: expect.any(String) });
    expect(schema.properties.productVersion).not.toHaveProperty("const");
    const versionPattern = new RegExp(String(schema.properties.productVersion.pattern), "u");
    expect("0.1.0-alpha.1").toMatch(versionPattern);
    for (const invalid of ["1.0.0-.", "1.0.0-01", "01.0.0", "1.0"]) expect(invalid).not.toMatch(versionPattern);
  });

  it("uses OIDC-only publishing with resumable bounded post-publish verification", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const verifyWorkflow = await readFile(resolve(root, ".github/workflows/release-verify.yml"), "utf8");
    const stateMachine = await readFile(resolve(root, "scripts/release-state-machine-github.ts"), "utf8");
    const publicRunbook = await readFile(resolve(root, "docs/public/release.md"), "utf8");
    for (const document of [workflow, verifyWorkflow]) {
      expect(document).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v/u);
      expect(document).not.toContain("npm@latest");
      expect(document).not.toContain("--clobber");
      expect(document).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|NPM_ALPHA1_BOOTSTRAP_GAT/u);
      expect(document).toContain("persist-credentials: false");
    }
    expect(workflow).toContain("workflow_dispatch:");
    expect(verifyWorkflow).toContain("workflow_dispatch:");
    expect(verifyWorkflow).toContain("workflow_call:");
    expect(workflow).toContain("id-token: write");
    expect(verifyWorkflow).toContain("id-token: none");
    expect(workflow).toContain("BETTER_REALTIME_RELEASE_EXPORT: \"1\"");
    expect(workflow).toContain("npm@11.18.0");
    expect(stateMachine).toContain("https://registry.npmjs.org/better-realtime/");
    expect(stateMachine).toContain("observeTag(identity)");
    expect(stateMachine).toContain("listAll<GitHubRelease>");
    expect(stateMachine).not.toContain("releases/tags/");
    expect(workflow).toContain("ARTIFACT: ${{ github.workspace }}/release-assets/${{ needs.build.outputs.artifact }}");
    expect(workflow).toContain('test -f "$ARTIFACT"');
    expect(workflow).toContain("npm publish \"$ARTIFACT\" --tag alpha --access public --provenance");
    expect(workflow).toContain("scripts/release-state-machine-github.ts recover-local-artifact-spec-failure");
    expect(workflow).toContain("scripts/release-state-machine-github.ts plan-publication");
    expect(workflow).toContain("Record durable publish intent at the OIDC boundary");
    expect(workflow).toContain("release_id: ${{ needs.finalize-release.outputs.release_id }}");
    expect(workflow).toContain("scripts/release-state-machine-github.ts stage-github-draft");
    expect(workflow).toContain("scripts/create-public-release-identity.ts");
    expect(workflow).toContain("scripts/adopt-public-release-identity.ts");
    expect(workflow).toContain("actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6");
    expect(verifyWorkflow).toContain("pnpm release:identity:verify --");
    expect(workflow).not.toMatch(/test "\$\(jq -r \.workflow\.run(?:Id|Attempt) [^\\n]+\)" = "\$GITHUB_RUN/u);
    expect(workflow).toContain("workflow_sha:");
    expect(workflow).toContain('test "$RUN_SHA" = "$INPUT_WORKFLOW_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$INPUT_SOURCE_SHA" "$INPUT_WORKFLOW_SHA"');
    expect(workflow).toContain("name: Check out the immutable package source");
    expect(workflow).toContain("path: release-source");
    expect(workflow).toContain("pnpm --dir release-source --silent package:pack");
    expect(workflow).not.toContain(".check_runs.length");
    expect(workflow).toContain("jq -r '.check_runs | length'");
    expect(workflow).toContain("uses: ./.github/workflows/release-verify.yml");
    expect(verifyWorkflow).toContain("for attempt in $(seq 1 20)");
    expect(verifyWorkflow).toContain("sleep 15");
    expect(verifyWorkflow).toContain("cmp \"$asset\" \"$registry_artifact\"");
    expect(verifyWorkflow).toContain("pnpm package:clean-room");
    expect(verifyWorkflow).toContain("npm audit signatures --json --include-attestations");
    expect(verifyWorkflow).toContain("scripts/verify-npm-provenance.ts");
    expect(verifyWorkflow).toContain("ref: ${{ inputs.workflow_sha }}");
    expect(verifyWorkflow).toContain("--workflow-sha");
    for (const input of ["source_sha", "workflow_sha", "identity_workflow_sha", "publish_workflow_sha", "publish_run_id", "publish_run_attempt"]) expect(verifyWorkflow).toContain(`${input}:`);
    const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
    expect(changelog.indexOf("## 0.1.0-alpha.4")).toBeLessThan(changelog.indexOf("## 0.1.0-alpha.2"));
    expect(changelog).toContain("0.1.0-alpha.2 — Unpublished tag-only attempt");
    const publicHistory = JSON.parse(await readFile(resolve("release/public-history.json"), "utf8")) as { rootCommit: string; tags: Array<{ name: string; object: string; target: string }> };
    expect(publicHistory).toEqual({
      schemaVersion: "1.0",
      repository: "newExpand/better-realtime",
      rootCommit: "766a6f45d3e8100d50fcf2aa76cb6f17c440df80",
      tags: [
        { name: "v0.1.0-alpha.1", object: "b4be67cb0d414f6e87f1aa797f86ec074d0b5f6a", target: "766a6f45d3e8100d50fcf2aa76cb6f17c440df80" },
        { name: "v0.1.0-alpha.2", object: "5c47946fa91c9a907abc602e391ffa9fa86e8669", target: "fd10345b9fa2e2fc31598987d856e0a6ed1bc51c" },
        { name: "v0.1.0-alpha.3", object: "fbeffc45ae7f2bdb8920b1a7ad32b7933e15b05b", target: "d51851a94809f6886af3f37639d7fb9b3758d94d" },
        { name: "v0.1.0-alpha.4", object: "e03f223dda3f592605ea51581c825b6fc48e35f3", target: "6de3b93c13fad1eb44a65d5fe31ea13c22e96867" },
        { name: "v0.2.0-alpha.1", object: "0a19477cf4d8ae100260608539da67cb2a3f1d1c", target: "763367845c3ff0fee31431297a6722f8a1d0dc81" },
      ],
    });
    expect(changelog).toContain("`fast-uri 3.1.4`");
    expect(changelog).toContain("No public API, `better-realtime.v1`, diagnostics, or PostgreSQL storage v1 contract is deprecated or intentionally broken");
    expect(publicRunbook).toContain("OIDC Trusted Publishing only");
    expect(publicRunbook).toContain("required manual reviewers");
    expect(publicRunbook).toContain("disallow token-based publishing");
    expect(publicRunbook).toContain("verification-only workflow");
    expect(publicRunbook).toContain('BETTER_REALTIME_RELEASE_EXPORT=1 pnpm package:export-public');
    expect(publicRunbook).toContain('sourceMode: "clean_git_index"');
  });

  it("makes every GitHub release operation repository-explicit and resumes only exact immutable identity", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const verifyWorkflow = await readFile(resolve(root, ".github/workflows/release-verify.yml"), "utf8");
    const stateMachine = await readFile(resolve(root, "scripts/release-state-machine-github.ts"), "utf8");
    expect(`${workflow}\n${verifyWorkflow}\n${stateMachine}`).not.toContain("releases/tags/");
    expect(stateMachine).toContain("release.id !== candidate.id");
    expect(stateMachine).toContain("RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED");
    expect(stateMachine).toContain("ref.object.type !== \"tag\"");
    expect(stateMachine).toContain("object.message !== identity.tagMessage");
    expect(stateMachine).toContain("object.object.sha !== identity.sourceSha");
    expect(stateMachine).not.toMatch(/method:\s*"DELETE"/u);
    expect(workflow.match(/npm publish /gu)).toHaveLength(1);
  });

  it("runs the high-severity dependency audit before creating or uploading a release artifact", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const buildStart = workflow.indexOf("\n  build:\n");
    const stageStart = workflow.indexOf("\n  stage-release:\n");
    const buildJob = workflow.slice(buildStart, stageStart);
    const audit = buildJob.indexOf("pnpm audit --audit-level=high");
    const pack = buildJob.indexOf("pnpm --dir release-source --silent package:pack");
    const sourceInstall = buildJob.indexOf("pnpm --dir release-source install --frozen-lockfile");
    const sourceAudit = buildJob.indexOf("pnpm --dir release-source audit --audit-level=high");
    const upload = buildJob.indexOf("actions/upload-artifact@");
    expect(audit).toBeGreaterThan(-1);
    expect(audit).toBeLessThan(pack);
    expect(sourceAudit).toBeGreaterThan(sourceInstall);
    expect(sourceAudit).toBeLessThan(pack);
    expect(audit).toBeLessThan(upload);
  });

  it("requires the approved artifact digest and size before any release-side effect", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const inputs = workflow.slice(workflow.indexOf("  workflow_dispatch:"), workflow.indexOf("\npermissions:"));
    const buildStart = workflow.indexOf("\n  build:\n");
    const stageStart = workflow.indexOf("\n  stage-release:\n");
    const buildJob = workflow.slice(buildStart, stageStart);
    for (const input of ["expected_sha256", "expected_size"]) {
      expect(inputs).toContain(`${input}:`);
      expect(inputs.slice(inputs.indexOf(`${input}:`), inputs.indexOf(`${input}:`) + 180)).toContain("required: true");
    }
    const pack = buildJob.indexOf("name: Build the release artifact once");
    const approval = buildJob.indexOf("name: Verify the approved release artifact identity");
    const cleanRoom = buildJob.indexOf("name: Verify the exact release artifact in a clean room");
    const upload = buildJob.indexOf("name: Upload the reviewed release candidate");
    expect(pack).toBeGreaterThan(-1);
    expect(approval).toBeGreaterThan(pack);
    expect(approval).toBeLessThan(cleanRoom);
    expect(approval).toBeLessThan(upload);
    expect(buildJob).toContain("INPUT_EXPECTED_SHA256: ${{ inputs.expected_sha256 }}");
    expect(buildJob).toContain("INPUT_EXPECTED_SIZE: ${{ inputs.expected_size }}");
    expect(buildJob).toContain('test "$(sha256sum "$artifact" | cut -d\' \' -f1)" = "$expected_sha256"');
    expect(buildJob).toContain('test "$(wc -c < "$artifact" | tr -d \' \')" = "$expected_size"');
    expect(buildJob).toContain("sha256: ${{ steps.approved.outputs.sha256 }}");
    expect(buildJob).toContain("size: ${{ steps.approved.outputs.size }}");
  });

  it("boots public CI without requiring pnpm before corepack", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const postgresHarness = await readFile(resolve(root, "scripts/test-postgres-docker.sh"), "utf8");
    expect(workflow).not.toContain("cache: pnpm");
    expect(workflow.match(/package-manager-cache: false/gu)).toHaveLength(2);
    expect(workflow.indexOf("actions/setup-node@")).toBeLessThan(workflow.indexOf("corepack enable"));
    expect(workflow.indexOf("corepack enable")).toBeLessThan(workflow.indexOf("pnpm install --frozen-lockfile"));
    expect(workflow).toContain("if: github.repository == 'newExpand/better-realtime'");
    expect(workflow).not.toContain("test ! -f release/public-tree.json");
    expect(workflow.indexOf("pnpm release:verify-public-tree")).toBeLessThan(workflow.indexOf("pnpm check"));
    expect(manifest.scripts["test:postgres:docker"]).toBe("bash scripts/test-postgres-docker.sh");
    expect(postgresHarness.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  it("installs the pinned Playwright browser before the mixed-version CI journey", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const postgresStart = workflow.indexOf("\n  postgres:\n");
    const postgresJob = workflow.slice(postgresStart);
    const installDependencies = postgresJob.indexOf("pnpm install --frozen-lockfile");
    const installBrowser = postgresJob.indexOf("pnpm exec playwright install --with-deps chromium firefox webkit");
    const postgres = postgresJob.indexOf("pnpm test:postgres:docker");
    const matrix = postgresJob.indexOf("pnpm compatibility:matrix");
    expect(installDependencies).toBeGreaterThan(-1);
    expect(installBrowser).toBeGreaterThan(installDependencies);
    expect(installBrowser).toBeLessThan(postgres);
    expect(installBrowser).toBeLessThan(matrix);
  });

  it("does not expose internal diagnostic identity wrapping in public declarations", async () => {
    const source = await readFile(resolve(root, "packages/runtime/src/diagnostic-io.ts"), "utf8");
    expect(source).toContain("function withProductIdentity(");
    expect(source).not.toContain("export function withProductIdentity(");
    expect(source).toMatch(/return \{ \.\.\.result, product: BETTER_REALTIME_PRODUCT, productVersion: BETTER_REALTIME_VERSION, component: BETTER_REALTIME_COMPONENT_ID \}/u);
  });

  it("keeps the MCP companion on stdio and outside the vulnerable Hono static path", async () => {
    const source = await readFile(resolve(root, "packages/mcp/src/index.ts"), "utf8");
    const runtimeSourceRoot = resolve(root, "packages/runtime/src");
    const mcpSourceRoot = resolve(root, "packages/mcp/src");
    const runtimeConfig = await readFile(resolve(root, "packages/runtime/tsconfig.json"), "utf8");
    const runtimeManifest = JSON.parse(await readFile(resolve(root, "packages/runtime/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    const shippedSources = [
      ...((await readdir(runtimeSourceRoot, { recursive: true }))
        .filter((path) => path.endsWith(".ts") && !["mcp.ts", "mcp-stdio.ts"].includes(path))
        .map((path) => readFile(resolve(runtimeSourceRoot, path), "utf8"))),
      ...((await readdir(mcpSourceRoot, { recursive: true }))
        .filter((path) => path.endsWith(".ts"))
        .map((path) => readFile(resolve(mcpSourceRoot, path), "utf8")))
    ];
    expect(source).toContain('from "@modelcontextprotocol/sdk/server/index.js"');
    expect(source).toContain('from "@modelcontextprotocol/sdk/server/stdio.js"');
    expect(runtimeConfig).toContain('"exclude": ["src/mcp.ts", "src/mcp-stdio.ts"]');
    expect(runtimeManifest.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(runtimeManifest.exports).not.toHaveProperty("./mcp");
    expect((await Promise.all(shippedSources)).join("\n")).not.toMatch(/@hono\/node-server|streamableHttp|serveStatic|serve-static/u);
  });
});
