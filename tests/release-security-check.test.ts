import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assertPublishOidcBoundary,
  assertReleaseProvenanceVerification,
  assertReleaseRecoveryContract,
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
      - run: |
          test "$(jq -r .object.type <<<"$tag_ref")" = tag
          test "$(jq -r .message <<<"$tag_object")" = "$expected_message"
          echo "existing exact annotated tag; resuming"
          echo "existing exact draft release; resuming"
          echo "existing exact immutable release; resuming"
          jq -r .immutable
          jq -r .prerelease
          asset_names=
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
          test "$(cat "$ARTIFACT.sha256")" = "$EXPECTED_SHA256  $ARTIFACT"
          validate_tag() { true; }
          test "$(jq -r .object.type <<<"$tag_ref")" = tag
          test "$(jq -r .tag <<<"$tag_object")" = "$TAG"
          test "$(jq -r .message <<<"$tag_object")" = "Better Realtime \${TAG#v}"
          test "$(jq -r .object.type <<<"$tag_object")" = commit
          test "$(jq -r .object.sha <<<"$tag_object")" = "$INPUT_SOURCE_SHA"
          if tag_ref=true; then
            validate_tag "$tag_ref"
            echo "existing exact annotated tag; resuming"
          elif grep -q 'HTTP 404' "$tag_error"; then
            true
          fi
          gh api --method POST "repos/\${GITHUB_REPOSITORY}/git/tags"
          gh release create "$TAG" --repo "$GITHUB_REPOSITORY"
          test "$(jq -r .draft <<<"$release_json")" = true
          test -z "$unexpected_assets"
          validate_existing_asset "$ARTIFACT" "$EXPECTED_SHA256" "$EXPECTED_SIZE"
          ensure_asset "$ARTIFACT" "$EXPECTED_SHA256" "$EXPECTED_SIZE"
          gh release upload "$TAG" "$ARTIFACT" --repo "$GITHUB_REPOSITORY"
          gh release download "$TAG" --repo "$GITHUB_REPOSITORY"
          echo "existing exact draft release; resuming"
          echo "existing exact immutable release; resuming"
        env:
          EXPECTED_SHA256: \${{ needs.build.outputs.sha256 }}
          EXPECTED_SIZE: \${{ needs.build.outputs.size }}
  finalize-release:
    steps:
      - name: Publish the asset-complete prerelease
        run: |
          gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false --prerelease
          echo "existing exact immutable release; resuming"
  assert-immutable-release:
    steps:
      - name: Require the published GitHub release to be immutable before npm publication
        run: |
          set -euo pipefail
          for attempt in $(seq 1 12)
          test "$(jq -r .immutable <<<"$release_json")" = true
          gh release download "$TAG" --repo "$GITHUB_REPOSITORY"
          test "$(sha256sum "$ARTIFACT" | cut -d' ' -f1)" = "$EXPECTED_SHA256"
          test "$(wc -c < "$ARTIFACT" | tr -d ' ')" = "$EXPECTED_SIZE"
          test "$(cat "$ARTIFACT.sha256")" = "$EXPECTED_SHA256  $ARTIFACT"
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
          test "$(cat "$ARTIFACT.sha256")" = "$EXPECTED_SHA256  $ARTIFACT"
          npm view "better-realtime@$INPUT_VERSION" version
          echo "npm version already exists; use release-verify.yml and do not publish again"
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
      - name: Validate remote identity and immutable assets before repository code
        env:
          EXPECTED_SHA256: \${{ inputs.expected_sha256 }}
          EXPECTED_SIZE: \${{ inputs.expected_size }}
        run: |
          set -euo pipefail
          [[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]
          [[ "$expected_size" =~ ^[1-9][0-9]*$ ]]
          test "$(git rev-parse HEAD)" = "$INPUT_SOURCE_SHA"
          jq -r .immutable
          test "$(jq -r .object.type <<<"$tag_ref")" = tag
          test "$(jq -r .tag <<<"$tag_object")" = "$tag"
          test "$(jq -r .message <<<"$tag_object")" = "Better Realtime \${tag#v}"
          test "$(jq -r .object.type <<<"$tag_object")" = commit
          test "$(jq -r .object.sha <<<"$tag_object")" = "$source_sha"
          git/ref/tags/$tag
          git/tags/$tag_object_sha
          gh release download "$tag" --repo "$GITHUB_REPOSITORY"
          test "$(sha256sum "$POST_PUBLISH_ROOT/release/$asset" | cut -d' ' -f1)" = "$expected_sha256"
          test "$(wc -c < "$POST_PUBLISH_ROOT/release/$asset" | tr -d ' ')" = "$expected_size"
          cmp "$POST_PUBLISH_ROOT/identity/approved.sha256" "$POST_PUBLISH_ROOT/release/$asset.sha256"
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
          audit_output="$POST_PUBLISH_ROOT/signatures/audit-signatures.json"
          npm audit signatures --json --include-attestations > "$audit_output")
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
      checked: [".github/workflows/release.yml", ".github/workflows/release-verify.yml", "scripts/release-state-machine-github.ts", "docs/public/release.md"],
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

  it("fails closed when approved artifact identity or byte checks drift", async () => {
    const publish = await readFile(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8");
    const adapter = await readFile(join(import.meta.dirname, "..", "scripts", "release-state-machine-github.ts"), "utf8");
    expect(() => assertReleaseArtifactApproval(publish, adapter)).not.toThrow();
    const mutations = [
      publish.replace("      expected_sha256:\n", "      removed_sha256:\n"),
      publish.replace("      expected_size:\n", "      removed_size:\n"),
      publish.replace("name: Verify the approved release artifact identity", "name: Removed approval"),
      publish.replace("report.files!==manifest.files.length", "true"),
      publish.replace("RELEASE_EXPECTED_SHA256: ${{ steps.approved.outputs.sha256 }}", "RELEASE_EXPECTED_SHA256: unapproved"),
      publish.replace("RELEASE_EXPECTED_SIZE: ${{ steps.approved.outputs.size }}", "RELEASE_EXPECTED_SIZE: unapproved"),
      publish.replace("            release-identity.json\n", ""),
      publish.replace('test "$(sha256sum "$artifact" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"', "true"),
      publish.replace('test "$(wc -c < "$artifact" | tr -d \' \')" = "$EXPECTED_SIZE"', "true"),
      publish.replace('test "$(cat "$artifact.sha256")" = "$EXPECTED_SHA256  $EXPECTED_ARTIFACT"', "true"),
    ];
    for (const [index, mutation] of mutations.entries()) expect(() => assertReleaseArtifactApproval(mutation, adapter), `artifact mutation ${index}`).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
    for (const marker of [
      "bytes.byteLength !== asset.size || sha256(bytes) !== asset.sha256",
      "sha256(remote) !== expected.sha256 || remote.byteLength !== expected.size || Buffer.compare(remote, local) !== 0",
    ]) expect(() => assertReleaseArtifactApproval(publish, adapter.replace(marker, "false"))).toThrow("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
  });

  it("fails closed on state-machine, numeric-ID, and duplicate-publish mutations", async () => {
    const publish = await readFile(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8");
    const verify = await readFile(join(import.meta.dirname, "..", ".github", "workflows", "release-verify.yml"), "utf8");
    const adapter = await readFile(join(import.meta.dirname, "..", "scripts", "release-state-machine-github.ts"), "utf8");
    expect(() => assertReleaseRecoveryContract(publish, verify, adapter)).not.toThrow();
    const publishMutations = [
      publish.replace("concurrency:\n  group: release-${{ inputs.version }}\n  cancel-in-progress: false\n", ""),
      publish.replace('          test "$WORKFLOW_SHA" = "$INPUT_SOURCE_SHA"\n', ""),
      publish.replace("-attempt-$RUN_ATTEMPT", ""),
      publish.replace("release_id: ${{ steps.reconcile.outputs.release_id }}", "release_id: guessed"),
      publish.replace("scripts/release-state-machine-github.ts reconcile-github", "scripts/release-state-machine-github.ts observe"),
      publish.replace("scripts/release-state-machine-github.ts plan-publication", "scripts/release-state-machine-github.ts observe"),
      publish.replaceAll("if: steps.reobserve.outputs.publish == 'true'", "if: always()"),
      publish.replace('npm publish "$ARTIFACT" --tag alpha --access public --provenance', 'npm publish "$ARTIFACT" --tag alpha --access public --provenance\nnpm publish "$ARTIFACT"'),
      publish.replace("release_id: ${{ needs.stage-release.outputs.release_id }}", "release_id: 1"),
    ];
    for (const [index, mutation] of publishMutations.entries()) expect(() => assertReleaseRecoveryContract(mutation, verify, adapter), `workflow mutation ${index}`).toThrow("RT_RELEASE_RECOVERY_CONTRACT_DRIFT");
    const verifyMutations = [
      verify.replace('[[ "$release_id" =~ ^[1-9][0-9]*$ ]]\n', ""),
      verify.replace('release_json="$(gh api "repos/${GITHUB_REPOSITORY}/releases/$release_id")"', 'release_json="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/$tag")"'),
      verify.replace('test "$(jq -r .id <<<"$release_json")" = "$release_id"\n', ""),
      verify.replace('test "$(jq -r .object.sha <<<"$tag_object")" = "$source_sha"\n', ""),
      verify.replace("          ref: ${{ inputs.source_sha }}", "          ref: ${{ inputs.tag }}"),
    ];
    for (const [index, mutation] of verifyMutations.entries()) expect(() => assertReleaseRecoveryContract(publish, mutation, adapter), `verification mutation ${index}`).toThrow("RT_RELEASE_RECOVERY_CONTRACT_DRIFT");
    const adapterMutations = [
      adapter.replace("listAll<GitHubRelease>(`repos/${identity.repository}/releases`)", "requestOptional<GitHubRelease>(`repos/${identity.repository}/releases/tags/${identity.tag}`)"),
      adapter.replace("`repos/${identity.repository}/releases/${candidate.id}`", "`repos/${identity.repository}/releases/latest`"),
      adapter.replaceAll("fixedReleaseId", "unboundReleaseId"),
      adapter.replace("await observe(identity, fixedReleaseId)", "await observe(identity)"),
      adapter.replace("await observe(identity, releaseId)", "await observe(identity)"),
      adapter.replaceAll("RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED", "RT_RELEASE_PROVIDER_IGNORED_ID_CHANGE"),
      adapter.replaceAll("publish-intent/${identity.version}/", "publish-attempt/"),
      adapter.replace("RT_RELEASE_STATE_AMBIGUOUS_PUBLISH_INTENT", "ignored duplicate intent"),
      adapter.replace("checks.push(...response.check_runs)", "checks.push(...(response as never[]))"),
      adapter.replaceAll("assertReleaseIdentityMutable(identity);", ""),
      `${adapter}\nnpm publish forbidden`,
    ];
    for (const [index, mutation] of adapterMutations.entries()) expect(() => assertReleaseRecoveryContract(publish, verify, mutation), `adapter mutation ${index}`).toThrow("RT_RELEASE_RECOVERY_CONTRACT_DRIFT");
  });

  it("keeps repository code outside the OIDC-capable publish job", async () => {
    const publish = await readFile(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8");
    expect(() => assertPublishOidcBoundary(publish)).not.toThrow();
    const prepareStart = publish.indexOf("\n  prepare-publication:");
    const prepareEnd = publish.indexOf("\n  publish:", prepareStart);
    const publishStart = publish.indexOf("\n  publish:");
    const publishEnd = publish.indexOf("\n  verify:", publishStart);
    const mutatePrepare = (marker: string, replacement: string): string =>
      publish.slice(0, prepareStart) + publish.slice(prepareStart, prepareEnd).replace(marker, replacement) + publish.slice(prepareEnd);
    const mutatePublish = (marker: string, replacement: string): string =>
      publish.slice(0, publishStart) + publish.slice(publishStart, publishEnd).replace(marker, replacement) + publish.slice(publishEnd);
    const mutations = [
      publish.replace("  prepare-publication:\n", "  prepare-publication:\n    environment: npm-alpha\n"),
      mutatePrepare("      id-token: none\n", "      id-token: write\n"),
      mutatePublish("      - uses: actions/setup-node@", "      - uses: actions/checkout@deadbeef\n      - uses: actions/setup-node@"),
      mutatePublish("      - uses: actions/setup-node@", "      - run: pnpm install --frozen-lockfile\n      - uses: actions/setup-node@"),
      mutatePublish("      - uses: actions/setup-node@", "      - run: npm install --global npm@latest\n      - uses: actions/setup-node@"),
      mutatePublish("      - uses: actions/setup-node@", "      - run: pnpm tsx scripts/release-state-machine-github.ts observe\n      - uses: actions/setup-node@"),
      mutatePublish('node-version: "24.18.0"', 'node-version: "24.x"'),
      mutatePublish('test "$(npm --version)" = 11.16.0', 'npm --version'),
      mutatePublish('test "$canonical_digest" = "$EXPECTED_IDENTITY_DIGEST"', "true"),
      mutatePublish("i.checksum.sha256,i.checksum.size,i.packageFiles,releaseId", "i.checksum.sha256,i.checksum.size,releaseId"),
      mutatePublish('test "$(jq -r .immutable <<<"$release_json")" = true', "true"),
      mutatePublish('"repos/$GITHUB_REPOSITORY/releases/$EXPECTED_RELEASE_ID/assets?per_page=100&page=$page"', '"repos/$GITHUB_REPOSITORY/releases/latest/assets"'),
      mutatePublish('cmp "$artifact" remote-artifact.tgz', "true"),
      mutatePublish("      - name: Re-observe publication state at the OIDC boundary\n", ""),
      mutatePublish("      - name: Record durable publish intent at the OIDC boundary\n", ""),
      mutatePublish('"repos/$GITHUB_REPOSITORY/check-runs"', '"repos/$GITHUB_REPOSITORY/statuses"'),
      mutatePublish("--provenance --ignore-scripts", "--provenance"),
    ];
    for (const [index, mutation] of mutations.entries()) {
      expect(() => assertPublishOidcBoundary(mutation), `OIDC boundary mutation ${index}`).toThrow("RT_RELEASE_PUBLISH_BOUNDARY_DRIFT");
    }
  });

  it("fails closed when verification-only stops using the approved digest or size", () => {
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract)).not.toThrow();
    for (const marker of [
      "EXPECTED_SIZE: ${{ inputs.expected_size }}",
      '[[ "$expected_size" =~ ^[1-9][0-9]*$ ]]',
      'wc -c < "$POST_PUBLISH_ROOT/release/$asset"',
      'sha256sum "$registry_artifact"',
      'wc -c < "$registry_artifact"',
    ]) expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace(marker, "removed"))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
    expect(() => assertReleaseVerificationArtifactApproval(verifyWorkflowContract.replace('test "$(sha256sum "$POST_PUBLISH_ROOT/release/$asset" | cut -d\' \' -f1)" = "$expected_sha256"', 'sha256sum "$POST_PUBLISH_ROOT/release/$asset" >/dev/null'))).toThrow("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
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
    expect(() => assertReleaseProvenanceVerification(verifyWorkflowContract.replace("          npm audit signatures --json --include-attestations > \"$audit_output\")\n          pnpm tsx scripts/verify-npm-provenance.ts", "          pnpm tsx scripts/verify-npm-provenance.ts\n          npm audit signatures --json --include-attestations > \"$audit_output\")"))).toThrow("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
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
    await writeFile(join(workflows, "release.yml"), await readFile(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8"), "utf8");
    await writeFile(join(workflows, "release-verify.yml"), await readFile(join(import.meta.dirname, "..", ".github", "workflows", "release-verify.yml"), "utf8"), "utf8");
    const scripts = join(root, "scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, "release-state-machine-github.ts"), await readFile(join(import.meta.dirname, "..", "scripts", "release-state-machine-github.ts"), "utf8"), "utf8");
  }
  if (options.privateMode) {
    const privateRoot = join(root, "docs", "internal");
    await mkdir(join(privateRoot, "releases"), { recursive: true });
    await writeFile(join(privateRoot, "releases", "v0.1.0-alpha.1.md"), options.privateReleaseText ?? closedReleaseContract, "utf8");
    if (options.privatePlan !== false) await writeFile(join(privateRoot, "plan.md"), options.privatePlanText ?? closedReleaseContract, "utf8");
  }
  return root;
}
