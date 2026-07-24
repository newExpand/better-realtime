import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function job(workflow: string, name: string, next?: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`missing job ${name}`);
  const end = next ? workflow.indexOf(`\n  ${next}:\n`, start + 1) : workflow.length;
  if (end < 0) throw new Error(`missing next job ${next}`);
  return workflow.slice(start, end);
}

describe("two-package release workflow security", () => {
  it("pins both approved identities before any artifact upload or GitHub mutation", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8");
    const build = job(workflow, "build", "stage-release");
    for (const input of [
      "expected_base_sha256",
      "expected_base_size",
      "expected_base_unpacked_size",
      "expected_base_files",
      "expected_mcp_sha256",
      "expected_mcp_size",
      "expected_mcp_unpacked_size",
      "expected_mcp_files",
    ]) {
      const offset = workflow.indexOf(`${input}:`);
      expect(offset).toBeGreaterThan(-1);
      expect(workflow.slice(offset, offset + 180)).toContain("required: true");
    }
    const pack = build.indexOf("name: Build both release artifacts once");
    const approval = build.indexOf("name: Verify both approved artifact identities before upload");
    const observe = build.indexOf("name: Observe and reject incompatible external state");
    const upload = build.indexOf("actions/upload-artifact@");
    expect(pack).toBeGreaterThan(-1);
    expect(approval).toBeGreaterThan(pack);
    expect(observe).toBeGreaterThan(approval);
    expect(upload).toBeGreaterThan(observe);
    expect(build.match(/package:pack > output\/base-report\.json/gu)).toHaveLength(1);
    expect(build.match(/package:pack:mcp > output\/mcp-report\.json/gu)).toHaveLength(1);
    expect(build).toContain('test "$(jq -r \'.files | length\' release/package-files.json)" = "$EXPECTED_BASE_FILES"');
    expect(build).toContain('test "$(jq -r \'.files | length\' release/mcp-package-files.json)" = "$EXPECTED_MCP_FILES"');
    expect(build).toContain('test "$(jq -r .unpackedSize output/base-report.json)" = "$EXPECTED_BASE_UNPACKED_SIZE"');
    expect(build).toContain('test "$(jq -r .unpackedSize output/mcp-report.json)" = "$EXPECTED_MCP_UNPACKED_SIZE"');
  });

  it("isolates each package OIDC authority and requires verified base bytes/provenance before companion publication", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8");
    const base = job(workflow, "publish-base", "verify-base");
    const verifyBase = job(workflow, "verify-base", "prepare-mcp");
    const prepareMcp = job(workflow, "prepare-mcp", "publish-mcp");
    const mcp = job(workflow, "publish-mcp", "verify");
    expect(base).toContain("environment: npm-alpha");
    expect(mcp).toContain("environment: npm-mcp-alpha");
    for (const oidcJob of [base, mcp]) {
      expect(oidcJob).toContain("id-token: write");
      expect(oidcJob).not.toContain("actions/checkout@");
      expect(oidcJob).not.toMatch(/\bpnpm\b|scripts\//u);
    }
    expect(verifyBase).toContain("cmp \"$ARTIFACT\"");
    expect(verifyBase).toContain("--environment npm-alpha");
    expect(prepareMcp).toContain("needs: [build, stage-release, finalize-release, verify-base]");
    expect(prepareMcp).toContain("RELEASE_VERIFIED_PACKAGES: better-realtime");
    expect(mcp).toContain("--tag alpha --access public --provenance --ignore-scripts");
  });

  it("guards the historical bare-relative npm tarball regression for both packages", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8");
    expect(workflow.match(/npm publish "\.\/\$ARTIFACT" --tag alpha --access public --provenance --ignore-scripts/gu)).toHaveLength(2);
    expect(workflow).not.toMatch(/npm publish "\$ARTIFACT"/u);
    for (const packageName of ["better-realtime", "better-realtime-mcp"]) {
      expect(workflow).toContain(`marker="publish-intent/$VERSION/${packageName}/$GITHUB_RUN_ID/$GITHUB_RUN_ATTEMPT"`);
    }
  });

  it("uses one immutable five-asset Release and a verification-only recovery workflow", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8");
    const verify = await readFile(resolve(root, ".github/workflows/release-bundle-verify.yml"), "utf8");
    expect(workflow).toContain("scripts/release-bundle-github.ts stage-github-draft");
    expect(workflow).toContain("scripts/release-bundle-github.ts reconcile-github");
    expect(workflow).toContain("uses: ./.github/workflows/release-bundle-verify.yml");
    expect(verify).toContain("workflow_call:");
    expect(verify).toContain("workflow_dispatch:");
    expect(verify).toContain("id-token: none");
    expect(verify).not.toMatch(/\bnpm publish\b/u);
    expect(verify).toContain("test \"$(jq -r .immutable <<<\"$release\")\" = true");
    expect(verify).toContain("better-realtime-$VERSION.bundle.identity.json");
    expect(verify.match(/cmp "\$ROOT\/release\/\$package-\$VERSION\.tgz" "\$ROOT\/registry\/\$package-\$VERSION\.tgz"/gu)).toHaveLength(1);
    expect(verify.match(/scripts\/verify-npm-provenance\.ts/gu)).toHaveLength(2);
    expect(verify).toContain("scripts/verify-public-release-bundle.ts");
    expect(verify).toContain("--base-unpacked-size");
    expect(verify).toContain("--mcp-unpacked-size");
    expect(verify).toContain("--base-files");
    expect(verify).toContain("--mcp-files");
    expect(verify.match(/gh attestation verify/gu)).toHaveLength(1);
    expect(verify).toContain('tags="$(npm view "$package" dist-tags --json)"');
    expect(verify).toContain('if (Object.hasOwn(tags, "latest")) process.exit(1)');
    expect(verify).not.toContain("dist-tags.latest 2>/dev/null || true");
  });

  it("keeps draft staging mutation-free after the four approved assets and finalizes only in reconcile mode", async () => {
    const [provider, workflow] = await Promise.all([
      readFile(resolve(root, "scripts/release-bundle-github.ts"), "utf8"),
      readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8"),
    ]);
    expect(provider).toContain('mode: "stage_github_draft" | "reconcile_github"');
    expect(provider).toContain('if (!identity.publicIdentity || mode === "stage_github_draft")');
    expect(provider).toContain('command === "stage-github-draft" ? "stage_github_draft" : "reconcile_github"');
    expect(provider).toContain("RT_RELEASE_BUNDLE_PROVIDER_RECONCILE_REQUIRES_STAGED_DRAFT");
    expect(provider).toContain("RT_RELEASE_BUNDLE_PROVIDER_COMMAND_ASSET_BOUNDARY");
    expect(provider).toContain("RT_RELEASE_BUNDLE_PROVIDER_ATTESTATION_GATE_REQUIRED");
    expect(workflow).toContain('RELEASE_ATTESTATIONS_VERIFIED: "true"');
    expect(provider).not.toContain("const result = await stage(identity);");
  });

  it("requires the exact inert bootstrap and an approved evidence generation time before mutation", async () => {
    const [workflow, runbook] = await Promise.all([
      readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8"),
      readFile(resolve(root, "docs/public/release-bundle.md"), "utf8"),
    ]);
    const build = job(workflow, "build", "stage-release");
    const timestampInput = workflow.indexOf("evidence_generated_at:");
    expect(timestampInput).toBeGreaterThan(-1);
    expect(workflow.slice(timestampInput, timestampInput + 180)).toContain("required: true");
    expect(build).toContain('test "$(node -e');
    expect(build).toContain('echo "evidence_generated_at=$EVIDENCE_GENERATED_AT"');
    expect(build).not.toContain("git show -s --format=%cI");
    const bootstrap = build.indexOf("name: Verify the exact inert companion bootstrap before any external mutation");
    const upload = build.indexOf("actions/upload-artifact@");
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(upload);
    expect(build).toContain("npm pack better-realtime-mcp@0.0.0-bootstrap.0");
    expect(build).toContain('cmp "$(jq -r .artifact "$root/report.json")"');
    expect(build).toContain("tags.bootstrap");
    expect(build).toContain("versions");
    expect(build).toContain("Object.hasOwn(tags, \"alpha\")");
    expect(build).toContain('tags.latest !== undefined && tags.latest !== "0.0.0-bootstrap.0"');
    expect(build).toContain('test "$EXPECTED_MCP_LATEST" = "$VERSION"');
    expect(runbook).toContain("`npm publish --tag bootstrap` adds the `bootstrap` dist-tag");
    expect(runbook).toContain("The expected bootstrap state therefore has no `latest` tag");
    expect(runbook).toContain("defensively permits `latest` only when");
    expect(runbook).not.toContain("mandatory first-package `latest`");
    expect(runbook).toContain("npm dist-tag add better-realtime-mcp@0.2.0-alpha.1 latest");
    expect(runbook).toContain("release-bundle-verify.yml");
  });

  it("validates annotated tag name/message/target and never deletes or resolves a draft by tag", async () => {
    const provider = await readFile(resolve(root, "scripts/release-bundle-github.ts"), "utf8");
    expect(provider).toContain('ref.object.type !== "tag"');
    expect(provider).toContain("object.tag !== identity.tag");
    expect(provider).toContain("object.message !== identity.tagMessage");
    expect(provider).toContain('object.object.type !== "commit"');
    expect(provider).toContain("object.object.sha !== identity.sourceSha");
    expect(provider).toContain("listAll<GitHubRelease>(`repos/${identity.repository}/releases`)");
    expect(provider).not.toContain("releases/tags/");
    expect(provider).not.toMatch(/method:\s*"DELETE"/u);
  });

  it("fails closed on partial publication instead of repeating an existing package", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8");
    const provider = await readFile(resolve(root, "scripts/release-bundle-github.ts"), "utf8");
    expect(workflow).toContain("RELEASE_VERIFIED_PACKAGES: better-realtime");
    expect(provider).toContain('plan.action === "verify_package_only" || plan.action === "poll_package_registry"');
    expect(provider).toContain('await output("publish", false)');
    expect(provider).toContain("RT_RELEASE_BUNDLE_PROVIDER_PACKAGE_NOT_READY");
    expect(workflow.match(/\bnpm publish\b/gu)).toHaveLength(2);
  });

  it("binds verification-only recovery to the original publish workflow attempt", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/release-bundle.yml"), "utf8");
    const provider = await readFile(resolve(root, "scripts/release-bundle-github.ts"), "utf8");
    expect(provider).toContain("recoverPublicIdentity(await loadIdentity())");
    expect(provider).toContain("adoptPublicReleaseBundleIdentity(identity, bytes, tag.objectSha, release.id, workflowSha)");
    expect(provider).toContain("actions/runs/${intent.runId}/attempts/${intent.runAttempt}");
    expect(provider).toContain('originalRun.event !== "workflow_dispatch"');
    expect(provider).toContain('originalRun.path !== ".github/workflows/release-bundle.yml"');
    expect(provider).toContain('await output("publish_workflow_sha", originalRun.head_sha)');
    expect(workflow.match(/echo "publish_workflow_sha=\$ORIGINAL_WORKFLOW_SHA"/gu)).toHaveLength(2);
  });

  it("keeps the alpha.4 single-package history separate while making the 0.2 bundle discoverable", async () => {
    const [historical, bundle, runbook, index, agents] = await Promise.all([
      readFile(resolve(root, "release/package-boundaries.json"), "utf8"),
      readFile(resolve(root, "release/release-bundle-boundaries.json"), "utf8"),
      readFile(resolve(root, "docs/public/release.md"), "utf8"),
      readFile(resolve(root, "docs/public/index.md"), "utf8"),
      readFile(resolve(root, "AGENTS.md"), "utf8").catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error)
      )
    ]);
    expect(historical).toContain("Historical release.yml single-package boundary through 0.1.x");
    expect(historical).toContain('"status": "future-separate-release"');
    expect(bundle).toContain('".github/workflows/release-bundle.yml"');
    expect(bundle).toContain('"better-realtime-mcp"');
    expect(runbook).toContain("Beginning with the `0.2.0-alpha.1` candidate");
    expect(index).toContain("[0.2 two-package release boundary](release-bundle.md)");
    if (agents !== undefined) expect(agents).toContain("`docs/public/release-bundle.md`");
  });
});
