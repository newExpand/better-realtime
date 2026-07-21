import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("Better Realtime public release identity", () => {
  it("keeps package, executables, repository, license, and publish policy exact", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "packages/runtime/package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "better-realtime",
      version: "0.1.0-alpha.1",
      license: "MIT",
      bin: {
        "better-realtime": "./dist/cli-bin.js",
        "better-realtime-mcp": "./dist/mcp-stdio.js"
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
      engines: { node: ">=22.0.0" },
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./react": { types: "./dist/react.d.ts", import: "./dist/react.js" },
        "./server": { types: "./dist/server.d.ts", browser: "./dist/node-only.js", node: "./dist/server.js" },
        "./diagnostics": { types: "./dist/diagnostic-io.d.ts", browser: "./dist/node-only.js", node: "./dist/diagnostic-io.js" },
        "./mcp": { types: "./dist/mcp.d.ts", browser: "./dist/node-only.js", node: "./dist/mcp.js" }
      },
      peerDependencies: { pg: ">=8.22.0 <9", react: ">=18.2.0 <20", ws: ">=8.21.1 <9" },
      peerDependenciesMeta: { react: { optional: true } }
    });
    expect(manifest.peerDependenciesMeta).not.toHaveProperty("pg");
    expect(manifest.peerDependenciesMeta).not.toHaveProperty("ws");
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
      expect(document).toContain("npm install better-realtime@alpha react pg ws");
      expect(document).not.toContain("npm install better-realtime react pg ws");
    }
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
    expect(quickstart).toContain("events: { notificationAdded: notification, notificationRead }");
    expect(quickstart).toContain('event.type === "notificationAdded"');
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

  it("pins release actions and promotes alpha only after exact registry verification", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const publicRunbook = await readFile(resolve(root, "docs/public/release.md"), "utf8");
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v/u);
    expect(workflow).not.toContain("npm@latest");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("types: [published]");
    expect(workflow).toContain("BETTER_REALTIME_RELEASE_EXPORT: \"1\"");
    expect(workflow.indexOf("gh release create v0.1.0-alpha.1")).toBeLessThan(workflow.indexOf("gh release edit v0.1.0-alpha.1 --draft=false"));
    expect(workflow.indexOf("gh release edit v0.1.0-alpha.1 --draft=false")).toBeLessThan(workflow.indexOf("--tag alpha-candidate"));
    expect(workflow).toContain("npm@11.18.0");
    expect(workflow.indexOf("mkdir -p output")).toBeLessThan(workflow.indexOf("> output/package-report.json"));
    expect(workflow.indexOf("--tag alpha-candidate")).toBeLessThan(workflow.indexOf("cmp better-realtime-0.1.0-alpha.1.tgz"));
    expect(workflow.indexOf("cmp better-realtime-0.1.0-alpha.1.tgz")).toBeLessThan(workflow.indexOf("npm dist-tag add better-realtime@0.1.0-alpha.1 alpha"));
    expect(workflow).toContain("NPM_ALPHA1_BOOTSTRAP_GAT");
    expect(workflow).not.toContain("NPM_BOOTSTRAP_TOKEN");
    const authority = "Bootstrap GAT authority: packages-all read-write, organizations no-access, bypass-2FA enabled; not package- or version-scoped.";
    for (const document of [workflow, publicRunbook]) expect(document).toContain(authority);
    for (const document of [workflow, publicRunbook]) {
      expect(document).not.toContain("minimal-scope granular access token");
      expect(document).not.toContain("limited to the first publish");
      expect(document).not.toContain("Exact-alpha.1, short-lived");
    }
    expect(publicRunbook).toContain("shortest available expiration");
    expect(publicRunbook).toContain("required manual reviewers");
    expect(publicRunbook).toContain("disallow token-based publishing");
    expect(publicRunbook).toContain('BETTER_REALTIME_RELEASE_EXPORT=1 pnpm package:export-public');
    expect(publicRunbook).toContain('sourceMode: "clean_git_index"');
    expect(publicRunbook.indexOf("public CI `verify` and `postgres` to succeed")).toBeLessThan(publicRunbook.indexOf("Push public tag `v0.1.0-alpha.1`"));
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

  it("does not expose internal diagnostic identity wrapping in public declarations", async () => {
    const source = await readFile(resolve(root, "packages/runtime/src/diagnostic-io.ts"), "utf8");
    expect(source).toContain("function withProductIdentity(");
    expect(source).not.toContain("export function withProductIdentity(");
    expect(source).toMatch(/return \{ \.\.\.result, product: BETTER_REALTIME_PRODUCT, productVersion: BETTER_REALTIME_VERSION, component: BETTER_REALTIME_COMPONENT_ID \}/u);
  });
});
