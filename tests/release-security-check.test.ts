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
  assertReleaseArtifactApproval,
  assertReleaseBuildAuditOrder,
  assertReleaseProvenanceVerification,
  assertReleaseVerificationArtifactApproval,
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

const publishWorkflowContract = `on:
  workflow_dispatch:
    inputs:
      expected_sha256:
        required: true
        type: string
      expected_size:
        required: true
        type: string

permissions:
  id-token: none
jobs:
  build:
    permissions:
      id-token: none
    outputs:
      sha256: \${{ steps.approved.outputs.sha256 }}
      size: \${{ steps.approved.outputs.size }}
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
      - name: Build the release artifact once
        run: pnpm --silent package:pack
      - name: Verify the approved release artifact identity
        id: approved
        env:
          INPUT_EXPECTED_SHA256: \${{ inputs.expected_sha256 }}
          INPUT_EXPECTED_SIZE: \${{ inputs.expected_size }}
        run: |
          set -euo pipefail
          [[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]
          [[ "$expected_size" =~ ^[1-9][0-9]*$ ]]
          test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "$expected_sha256"
          test "$(wc -c < "$artifact" | tr -d ' ')" = "$expected_size"
          test "$(cut -d' ' -f1 "$artifact.sha256")" = "$expected_sha256"
          node -e "if(report.size!==Number(process.argv[1]))throw new Error();if(report.files!==manifest.files.length)throw new Error()"
          echo "sha256=$expected_sha256" >> "$GITHUB_OUTPUT"
          echo "size=$expected_size" >> "$GITHUB_OUTPUT"
      - name: Verify the exact release artifact in a clean room
        run: pnpm package:clean-room
      - name: Upload the reviewed release candidate
      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f
  stage-release:
    steps:
      - name: Create exact annotated tag and asset-complete draft prerelease
        run: |
          set -euo pipefail
          test "$(sha256sum "$ARTIFACT" | cut -d' ' -f1)" = "$EXPECTED_SHA256"
          test "$(wc -c < "$ARTIFACT" | tr -d ' ')" = "$EXPECTED_SIZE"
          test "$(cut -d' ' -f1 "$ARTIFACT.sha256")" = "$EXPECTED_SHA256"
          gh api --method POST "repos/\${GITHUB_REPOSITORY}/git/tags"
        env:
          EXPECTED_SHA256: \${{ needs.build.outputs.sha256 }}
          EXPECTED_SIZE: \${{ needs.build.outputs.size }}
  assert-immutable-release:
    steps:
      - name: Require the published GitHub release to be immutable before npm publication
        run: |
          set -euo pipefail
          test "$(sha256sum "immutable-release-assets/$ARTIFACT" | cut -d' ' -f1)" = "$EXPECTED_SHA256"
          test "$(wc -c < "immutable-release-assets/$ARTIFACT" | tr -d ' ')" = "$EXPECTED_SIZE"
          test "$(cut -d' ' -f1 "immutable-release-assets/$ARTIFACT.sha256")" = "$EXPECTED_SHA256"
        env:
          EXPECTED_SHA256: \${{ needs.build.outputs.sha256 }}
          EXPECTED_SIZE: \${{ needs.build.outputs.size }}
  publish:
    environment: npm-alpha
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131
      - name: Publish the exact artifact through npm Trusted Publishing
        run: |
          set -euo pipefail
          test "$(sha256sum "$ARTIFACT" | cut -d' ' -f1)" = "$EXPECTED_SHA256"
          test "$(wc -c < "$ARTIFACT" | tr -d ' ')" = "$EXPECTED_SIZE"
          test "$(cut -d' ' -f1 "$ARTIFACT.sha256")" = "$EXPECTED_SHA256"
          npm publish "$ARTIFACT"
        env:
          EXPECTED_SHA256: \${{ needs.build.outputs.sha256 }}
          EXPECTED_SIZE: \${{ needs.build.outputs.size }}
  verify:
    uses: ./.github/workflows/release-verify.yml
    with:
      expected_sha256: \${{ needs.build.outputs.sha256 }}
      expected_size: \${{ needs.build.outputs.size }}
`;
const verifyWorkflowContract = `on:
  workflow_call:
    inputs:
      expected_sha256:
        required: true
        type: string
      expected_size:
        required: true
        type: string
  workflow_dispatch:
    inputs:
      expected_sha256:
        required: true
        type: string
      expected_size:
        required: true
        type: string
permissions:
  id-token: none
source_sha:
publish_run_id:
publish_run_attempt:
jobs:
  verify:
    steps:
      - name: Validate verification-only identity and immutable assets
        env:
          EXPECTED_SHA256: \${{ inputs.expected_sha256 }}
          EXPECTED_SIZE: \${{ inputs.expected_size }}
        run: |
          set -euo pipefail
          [[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]
          [[ "$expected_size" =~ ^[1-9][0-9]*$ ]]
          test "$(git rev-parse HEAD)" = "$source_sha"
          jq -r .immutable
          git/ref/tags/$tag
          git/tags/$tag_object_sha
          test "$(sha256sum "post-publish/release/$asset" | cut -d' ' -f1)" = "$expected_sha256"
          test "$(wc -c < "post-publish/release/$asset" | tr -d ' ')" = "$expected_size"
      - name: Wait for bounded npm registry convergence
        run: |
          for attempt in $(seq 1 20)
          sleep 15
      - name: Compare registry bytes and run clean-room verification
        env:
          EXPECTED_SHA256: \${{ inputs.expected_sha256 }}
          EXPECTED_SIZE: \${{ inputs.expected_size }}
        run: |
          set -euo pipefail
          test "$(sha256sum "$asset" | cut -d' ' -f1)" = "$EXPECTED_SHA256"
          test "$(wc -c < "$asset" | tr -d ' ')" = "$EXPECTED_SIZE"
          test "$(sha256sum "$registry_artifact" | cut -d' ' -f1)" = "$EXPECTED_SHA256"
          test "$(wc -c < "$registry_artifact" | tr -d ' ')" = "$EXPECTED_SIZE"
          cmp "$asset" "$registry_artifact"
          BETTER_REALTIME_TARBALL="$registry_artifact" pnpm package:clean-room
      - name: Verify registry signatures, provenance, and dist-tag
        run: |
          audit_output="post-publish/signatures/audit-signatures.json"
          npm audit signatures --json --include-attestations > "$GITHUB_WORKSPACE/$audit_output")
          pnpm tsx scripts/verify-npm-provenance.ts \\
            --audit-signatures "$audit_output" \\
            --tarball \\
            --source-sha \\
            --publish-run-id \\
            --publish-run-attempt
          dist-tags.alpha
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

  it("fails closed when approved artifact identity inputs or the pre-upload gate drift", () => {
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract)).not.toThrow();
    for (const marker of ["      expected_sha256:\n", "      expected_size:\n", "name: Verify the approved release artifact identity\n", "INPUT_EXPECTED_SHA256: ${{ inputs.expected_sha256 }}", "INPUT_EXPECTED_SIZE: ${{ inputs.expected_size }}", "report.files!==manifest.files.length"]) {
      expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace(marker, "removed"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    }
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace("sha256: ${{ steps.approved.outputs.sha256 }}", "sha256: ${{ steps.artifact.outputs.sha256 }}"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace("size: ${{ steps.approved.outputs.size }}", "size: ${{ steps.artifact.outputs.size }}"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace("      - name: Verify the exact release artifact in a clean room\n", "      - run: pnpm --silent package:pack\n      - name: Verify the exact release artifact in a clean room\n"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace('wc -c < "immutable-release-assets/$ARTIFACT"', "removed"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace('test "$(sha256sum "$ARTIFACT" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"', 'sha256sum "$ARTIFACT" >/dev/null'))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    const downstreamChecks = `          test "$(sha256sum "$ARTIFACT" | cut -d' ' -f1)" = "$EXPECTED_SHA256"
          test "$(wc -c < "$ARTIFACT" | tr -d ' ')" = "$EXPECTED_SIZE"
          test "$(cut -d' ' -f1 "$ARTIFACT.sha256")" = "$EXPECTED_SHA256"
`;
    const stageAfterSideEffect = publishWorkflowContract.replace(downstreamChecks, "").replace('          gh api --method POST "repos/${GITHUB_REPOSITORY}/git/tags"\n', `          gh api --method POST "repos/\${GITHUB_REPOSITORY}/git/tags"
${downstreamChecks}`);
    expect(() => assertReleaseArtifactApproval(stageAfterSideEffect)).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    const publishStart = publishWorkflowContract.indexOf("\n  publish:\n");
    const publishPrefix = publishWorkflowContract.slice(0, publishStart);
    const publishSuffix = publishWorkflowContract.slice(publishStart).replace(downstreamChecks, "").replace('          npm publish "$ARTIFACT"\n', `          npm publish "$ARTIFACT"
${downstreamChecks}`);
    expect(() => assertReleaseArtifactApproval(publishPrefix + publishSuffix)).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    const stageStepStart = publishWorkflowContract.indexOf("      - name: Create exact annotated tag and asset-complete draft prerelease\n");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.slice(0, stageStepStart) + publishWorkflowContract.slice(stageStepStart).replace("          set -euo pipefail", "          set +e"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace("      - name: Create exact annotated tag and asset-complete draft prerelease\n", "      - name: Create exact annotated tag and asset-complete draft prerelease\n        continue-on-error: true\n"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    const movedAfterUpload = publishWorkflowContract
      .replace(/      - name: Verify the approved release artifact identity[\s\S]*?(?=      - name: Verify the exact release artifact)/u, "")
      .replace("      - uses: actions/upload-artifact@", `${publishWorkflowContract.match(/      - name: Verify the approved release artifact identity[\s\S]*?(?=      - name: Verify the exact release artifact)/u)?.[0] ?? ""}      - uses: actions/upload-artifact@`);
    expect(() => assertReleaseArtifactApproval(movedAfterUpload)).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace('echo "size=$expected_size" >> "$GITHUB_OUTPUT"', 'echo "size=$expected_size" >> "$GITHUB_OUTPUT" || true'))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace("        id: approved\n", "        id: approved\n        if: false\n"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.replace("        id: approved\n", "        id: approved\n        continue-on-error: true\n"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    const approvalStart = publishWorkflowContract.indexOf("      - name: Verify the approved release artifact identity\n");
    expect(() => assertReleaseArtifactApproval(publishWorkflowContract.slice(0, approvalStart) + publishWorkflowContract.slice(approvalStart).replace("          [[", "          set +e\n          [["))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
  });

  it("fails closed when verification-only stops using the approved digest or size", () => {
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract)).not.toThrow();
    for (const marker of [
      "EXPECTED_SIZE: ${{ inputs.expected_size }}",
      '[[ "$expected_size" =~ ^[1-9][0-9]*$ ]]',
      'wc -c < "post-publish/release/$asset"',
      'sha256sum "$registry_artifact"',
      'wc -c < "$registry_artifact"',
    ]) expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace(marker, "removed"))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace('test "$(sha256sum "post-publish/release/$asset" | cut -d\' \' -f1)" = "$expected_sha256"', 'sha256sum "post-publish/release/$asset" >/dev/null'))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace('test "$(wc -c < "$registry_artifact" | tr -d \' \')" = "$EXPECTED_SIZE"', 'wc -c < "$registry_artifact" >/dev/null'))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace("        required: true", "        required: false"))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    const compareBeforeApproval = verifyWorkflowContract
      .replace('          cmp "$asset" "$registry_artifact"\n', "")
      .replace('          test "$(sha256sum "$asset" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"\n', '          cmp "$asset" "$registry_artifact"\n          test "$(sha256sum "$asset" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"\n');
    expect(() => assertReleaseVerificationArtifactApproval(compareBeforeApproval)).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace('          cmp "$asset" "$registry_artifact"', '          cmp "$asset" "$registry_artifact" || true'))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace("      - name: Compare registry bytes and run clean-room verification\n", "      - name: Compare registry bytes and run clean-room verification\n        if: false\n"))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    const compareStepStart = verifyWorkflowContract.indexOf("      - name: Compare registry bytes and run clean-room verification\n");
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.slice(0, compareStepStart) + verifyWorkflowContract.slice(compareStepStart).replace("          set -euo pipefail", "          set +e"))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
  });

  it("fails closed when provenance identity verification is absent or bypassed", () => {
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract)).not.toThrow();
    for (const marker of ["scripts/verify-npm-provenance.ts", "--audit-signatures", "--source-sha", "--publish-run-id", "publish_run_attempt:", "--include-attestations"]) expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace(marker, "removed"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("scripts/verify-npm-provenance.ts", "scripts/verify-npm-provenance.ts || true"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("npm audit signatures --json --include-attestations", "npm audit signatures --json --include-attestations && true"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(`${verifyWorkflowContract}\ncontinue-on-error: true`)).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("pnpm tsx scripts/verify-npm-provenance.ts \\\n", "").replace("dist-tags.alpha", "dist-tags.alpha\npnpm tsx scripts/verify-npm-provenance.ts \\\n"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("          npm audit signatures --json --include-attestations > \"$GITHUB_WORKSPACE/$audit_output\")\n          pnpm tsx scripts/verify-npm-provenance.ts", "          pnpm tsx scripts/verify-npm-provenance.ts\n          npm audit signatures --json --include-attestations > \"$GITHUB_WORKSPACE/$audit_output\")"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
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
