import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapClosedContract,
  checkReleaseSecurity,
  finalDistTagsContract,
  historicalReleaseBoundaryContract,
  nextReleaseContract,
  releaseAuthority,
  trustedPublisherEvidenceContract,
  assertReleaseBuildAuditOrder,
  assertReleaseProvenanceVerification,
} from "../scripts/release-security-contract.ts";

const closedReleaseContract = [
  releaseAuthority,
  bootstrapClosedContract,
  trustedPublisherEvidenceContract,
  finalDistTagsContract,
  historicalReleaseBoundaryContract,
  nextReleaseContract,
].join("\n");
const closureCases = [
  ["bootstrap closure and credential provenance", bootstrapClosedContract],
  ["Trusted Publisher verification limit", trustedPublisherEvidenceContract],
  ["final dist-tags", finalDistTagsContract],
  ["next-release OIDC-only recovery contract", nextReleaseContract],
] as const;

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const publishWorkflowContract = `permissions:
  id-token: none
jobs:
  build:
    permissions:
      id-token: none
    steps:
      - run: npm view "better-realtime@$version"
      - run: git ls-remote --exit-code --tags
      - run: gh release view
      - run: jq -r .immutable
      - run: jq -r .prerelease
      - run: asset_names=; gh release download; sha256sum immutable-release-assets/$ARTIFACT
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --audit-level=high
      - run: pnpm package:export-public
      - run: pnpm --silent package:pack
      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f
  publish:
    environment: npm-alpha
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131
      - run: npm publish
  verify:
    uses: ./.github/workflows/release-verify.yml
`;
const verifyWorkflowContract = `id-token: none
workflow_call:
workflow_dispatch:
source_sha:
publish_run_id:
publish_run_attempt:
for attempt in $(seq 1 20)
sleep 15
cmp "$asset" "$registry_artifact"
audit_output="post-publish/signatures/audit-signatures.json"
npm audit signatures --json --include-attestations > "$GITHUB_WORKSPACE/$audit_output")
pnpm tsx scripts/verify-npm-provenance.ts \\
--audit-signatures "$audit_output" \\
--tarball
--source-sha
--publish-run-id
--publish-run-attempt
test "$(git rev-parse HEAD)" = "$source_sha"
dist-tags.alpha
jq -r .immutable
git/ref/tags/$tag
git/tags/$tag_object_sha
`;
const publicRunbookContract = "OIDC Trusted Publishing only; verification-only workflow; required manual reviewers; disallow tokens; remains `immutable:false`; was `enabled:false`; is now `enabled:true`; immutability applies only to future releases";

describe("release-security contract modes", () => {
  it("requires every public contract file", async () => {
    const root = await fixture({ publicWorkflow: false, privateMode: false });
    await expect(checkReleaseSecurity(root)).rejects.toThrow("RT_RELEASE_AUTHORITY_CONTRACT_MISSING:.github/workflows/release.yml");
  });

  it("requires every internal record when the private root exists", async () => {
    const root = await fixture({ publicWorkflow: true, privateMode: true, privatePlan: false });
    await expect(checkReleaseSecurity(root)).rejects.toThrow(`RT_RELEASE_AUTHORITY_CONTRACT_MISSING:${join("docs", "internal", "plan.md")}`);
  });

  it("accepts a public tree only when the internal root is entirely absent", async () => {
    const root = await fixture({ publicWorkflow: true, privateMode: false });
    await expect(checkReleaseSecurity(root)).resolves.toMatchObject({
      privateMode: false,
      contractState: "oidc-only-contract",
      checked: [".github/workflows/release.yml", ".github/workflows/release-verify.yml", "docs/public/release.md"],
    });
  });

  it.each(closureCases)("requires completed private release evidence to preserve %s", async (_name, missingContract) => {
    const root = await fixture({
      publicWorkflow: true,
      privateMode: true,
      privateReleaseText: closedReleaseContract.replace(missingContract, ""),
    });
    await expect(checkReleaseSecurity(root)).rejects.toThrow(
      `RT_RELEASE_CLOSURE_DRIFT:${join("docs", "internal", "releases", "v0.1.0-alpha.1.md")}`,
    );
  });

  it("requires the private plan to preserve the same completion boundaries", async () => {
    const root = await fixture({ publicWorkflow: true, privateMode: true, privatePlanText: releaseAuthority });
    await expect(checkReleaseSecurity(root)).rejects.toThrow(`RT_RELEASE_CLOSURE_DRIFT:${join("docs", "internal", "plan.md")}`);
  });

  it("reports the bootstrap path closed when all private completion contracts are present", async () => {
    const root = await fixture({ publicWorkflow: true, privateMode: true });
    await expect(checkReleaseSecurity(root)).resolves.toMatchObject({ privateMode: true, contractState: "bootstrap-closed-oidc-ready" });
  });

  it("fails closed when the release build audit is removed or moved behind artifact creation", () => {
    expect(() => assertReleaseBuildAuditOrder(publishWorkflowContract)).not.toThrow();
    expect(() => assertReleaseBuildAuditOrder(publishWorkflowContract.replace("      - run: pnpm audit --audit-level=high\n", ""))).toThrow("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
    const moved = publishWorkflowContract.replace("      - run: pnpm audit --audit-level=high\n", "").replace("      - uses: actions/upload-artifact@", "      - run: pnpm audit --audit-level=high\n      - uses: actions/upload-artifact@");
    expect(() => assertReleaseBuildAuditOrder(moved)).toThrow("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
    const beforeInstall = publishWorkflowContract.replace("      - run: pnpm audit --audit-level=high\n", "").replace("    steps:\n", "    steps:\n      - run: pnpm audit --audit-level=high\n");
    expect(() => assertReleaseBuildAuditOrder(beforeInstall)).toThrow("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
    expect(() => assertReleaseBuildAuditOrder(publishWorkflowContract.replace("pnpm audit --audit-level=high", "pnpm audit --audit-level=high || true"))).toThrow("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
    expect(() => assertReleaseBuildAuditOrder(publishWorkflowContract.replace("      - run: pnpm audit --audit-level=high\n", "      - run: pnpm audit --audit-level=high\n        if: false\n"))).toThrow("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
    expect(() => assertReleaseBuildAuditOrder(publishWorkflowContract.replace("      - run: pnpm audit --audit-level=high\n", "      - run: pnpm audit --audit-level=high\n        continue-on-error: true\n"))).toThrow("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
  });

  it("fails closed when provenance identity verification is absent or bypassed", () => {
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract)).not.toThrow();
    for (const marker of ["scripts/verify-npm-provenance.ts", "--audit-signatures", "--source-sha", "--publish-run-id", "publish_run_attempt:", "--include-attestations"]) expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace(marker, "removed"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("scripts/verify-npm-provenance.ts", "scripts/verify-npm-provenance.ts || true"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("npm audit signatures --json --include-attestations", "npm audit signatures --json --include-attestations && true"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(`${verifyWorkflowContract}\ncontinue-on-error: true`)).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("pnpm tsx scripts/verify-npm-provenance.ts \\\n", "").replace("dist-tags.alpha", "dist-tags.alpha\npnpm tsx scripts/verify-npm-provenance.ts \\\n"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("npm audit signatures --json --include-attestations > \"$GITHUB_WORKSPACE/$audit_output\")\npnpm tsx scripts/verify-npm-provenance.ts", "pnpm tsx scripts/verify-npm-provenance.ts\nnpm audit signatures --json --include-attestations > \"$GITHUB_WORKSPACE/$audit_output\")"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("pnpm tsx scripts/verify-npm-provenance.ts", "node mutate-audit.js\npnpm tsx scripts/verify-npm-provenance.ts"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace('--audit-signatures "$audit_output"', '--audit-signatures "stale.json"'))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
  });
});

async function fixture(options: {
  publicWorkflow: boolean;
  privateMode: boolean;
  privatePlan?: boolean;
  privatePlanText?: string;
  privateReleaseText?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "better-realtime-release-security-"));
  temporaryDirectories.push(root);
  const publicDocs = join(root, "docs", "public");
  await mkdir(publicDocs, { recursive: true });
  await writeFile(join(publicDocs, "release.md"), publicRunbookContract, "utf8");
  if (options.publicWorkflow) {
    const workflows = join(root, ".github", "workflows");
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, "release.yml"), publishWorkflowContract, "utf8");
    await writeFile(join(workflows, "release-verify.yml"), verifyWorkflowContract, "utf8");
  }
  if (options.privateMode) {
    const privateRoot = join(root, "docs", "internal");
    await mkdir(join(privateRoot, "releases"), { recursive: true });
    await writeFile(join(privateRoot, "releases", "v0.1.0-alpha.1.md"), options.privateReleaseText ?? closedReleaseContract, "utf8");
    if (options.privatePlan !== false) await writeFile(join(privateRoot, "plan.md"), options.privatePlanText ?? closedReleaseContract, "utf8");
  }
  return root;
}
