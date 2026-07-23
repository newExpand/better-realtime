import { access, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const releaseAuthority = "Bootstrap GAT authority: packages-all read-write, organizations no-access, bypass-2FA enabled; not package- or version-scoped.";
export const bootstrapClosedContract = "Bootstrap state: closed; GitHub Environment secret absence: independently verified; bootstrap GAT revocation: user-confirmed.";
export const trustedPublisherEvidenceContract =
  "Trusted Publisher state: configuration fields and token-disallow setting user-confirmed in authenticated npm UI; functional OIDC publication unverified until the next separately approved OIDC-only publish.";
export const finalDistTagsContract = "Final registry dist-tags: alpha=0.1.0-alpha.1; latest=0.1.0-alpha.1; alpha-candidate=absent.";
export const historicalReleaseBoundaryContract = "Alpha.1 GitHub boundary: release immutable=false; repository immutable releases was enabled=false at alpha.1 publication and is enabled=true now; npm artifact is non-republishable; annotated tag and checksum assets are preserved by project policy, not GitHub-enforced immutability.";
export const nextReleaseContract =
  "Next release contract: OIDC-only; bounded registry-convergence polling; post-publish verification resumable without republishing; an exact annotated tag or draft may resume only after full identity and artifact proof; an exact immutable prerelease is verification-only and never re-enters publish; an existing npm version or mismatched identity is rejected.";
export const oidcOnlyWorkflowContract = "Next release publishing authentication: GitHub OIDC Trusted Publishing only; no npm token secret.";
export const resumableVerificationContract = "Post-publish verification: bounded registry polling and verification-only resume without npm publish.";
const prohibitedClaims = ["minimal-scope granular access token", "limited to the first publish", "Exact-alpha.1, short-lived"];
const prohibitedWorkflowTokens = ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_ALPHA1_BOOTSTRAP_GAT", "NPM_BOOTSTRAP_TOKEN"];
const closedContracts = [bootstrapClosedContract, trustedPublisherEvidenceContract, finalDistTagsContract, historicalReleaseBoundaryContract, nextReleaseContract];

export async function checkReleaseSecurity(
  root = resolve(import.meta.dirname, ".."),
): Promise<{
  checked: string[];
  privateMode: boolean;
  contractState: "oidc-only-contract" | "bootstrap-closed-oidc-ready";
}> {
  const publishPath = resolve(root, ".github", "workflows", "release.yml");
  const verifyPath = resolve(root, ".github", "workflows", "release-verify.yml");
  const stateMachinePath = resolve(root, "scripts", "release-state-machine-github.ts");
  const runbookPath = resolve(root, "docs", "public", "release.md");
  const publicPaths = [publishPath, verifyPath, stateMachinePath, runbookPath];
  const privateRoot = resolve(root, "docs", "internal");
  const privatePaths = [resolve(privateRoot, "releases", "v0.1.0-alpha.1.md"), resolve(privateRoot, "plan.md")];
  const privateMode = await exists(privateRoot);
  const required = privateMode ? [...publicPaths, ...privatePaths] : publicPaths;
  const checked: string[] = [];
  for (const path of required) {
    if (!(await exists(path))) throw new Error(`RT_RELEASE_AUTHORITY_CONTRACT_MISSING:${relative(root, path)}`);
    const text = await readFile(path, "utf8");
    for (const phrase of prohibitedClaims) if (text.includes(phrase)) throw new Error(`RT_RELEASE_AUTHORITY_OVERCLAIM:${relative(root, path)}`);
    checked.push(relative(root, path));
  }

  const publish = await readFile(publishPath, "utf8");
  const verify = await readFile(verifyPath, "utf8");
  const stateMachine = await readFile(stateMachinePath, "utf8");
  const runbook = await readFile(runbookPath, "utf8");
  for (const token of prohibitedWorkflowTokens) for (const [path, text] of [[publishPath, publish], [verifyPath, verify]] as const) if (text.includes(token)) throw new Error(`RT_RELEASE_BOOTSTRAP_PATH_PRESENT:${relative(root, path)}:${token}`);
  for (const requiredText of ["id-token: write", "npm publish", "scripts/release-state-machine-github.ts observe", "scripts/release-state-machine-github.ts reconcile-github", "scripts/release-state-machine-github.ts plan-publication", "uses: ./.github/workflows/release-verify.yml", "release_id: ${{ needs.stage-release.outputs.release_id }}", "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f", "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131"]) if (!publish.includes(requiredText)) throw new Error(`RT_RELEASE_OIDC_CONTRACT_DRIFT:${relative(root, publishPath)}`);
  const buildJob = workflowJob(publish, "build");
  if (!buildJob.includes("id-token: none") || buildJob.includes("environment: npm-alpha")) throw new Error(`RT_RELEASE_BUILD_OIDC_EXPOSED:${relative(root, publishPath)}`);
  assertReleaseBuildAuditOrder(publish);
  assertReleaseArtifactApproval(publish, stateMachine);
  assertReleaseRecoveryContract(publish, verify, stateMachine);
  assertPublishOidcBoundary(publish);
  const publishJob = workflowJob(publish, "publish");
  if (!publishJob.includes("id-token: write")) throw new Error(`RT_RELEASE_PUBLISH_BOUNDARY_DRIFT:${relative(root, publishPath)}`);
  for (const requiredText of ["id-token: none", "workflow_call:", "workflow_dispatch:", "release_id:", "INPUT_RELEASE_ID: ${{ inputs.release_id }}", "EXPECTED_SIZE: ${{ inputs.expected_size }}", "for attempt in $(seq 1 20)", "sleep 15", "cmp \"$asset\" \"$registry_artifact\"", "npm audit signatures", "jq -r .immutable", "releases/$release_id", "releases/assets/$asset_id", "git/ref/tags/$tag", "git/tags/$tag_object_sha", "wc -c < \"$registry_artifact\""]) if (!verify.includes(requiredText)) throw new Error(`RT_RELEASE_VERIFICATION_CONTRACT_DRIFT:${relative(root, verifyPath)}`);
  assertReleaseVerificationArtifactApproval(verify);
  assertReleaseProvenanceVerification(verify);
  if (/\bnpm publish\b/u.test(verify)) throw new Error(`RT_RELEASE_VERIFICATION_CAN_PUBLISH:${relative(root, verifyPath)}`);
  for (const requiredText of ["OIDC Trusted Publishing only", "verification-only workflow", "required manual reviewers", "disallow tokens", "remains `immutable:false`", "was `enabled:false`", "is now `enabled:true`", "only to future releases"]) if (!runbook.includes(requiredText)) throw new Error(`RT_RELEASE_RUNBOOK_CONTRACT_DRIFT:${relative(root, runbookPath)}`);

  if (privateMode) {
    for (const path of privatePaths) {
      const text = await readFile(path, "utf8");
      if (!text.includes(releaseAuthority)) throw new Error(`RT_RELEASE_AUTHORITY_DRIFT:${relative(root, path)}`);
      for (const contract of closedContracts) if (!text.includes(contract)) throw new Error(`RT_RELEASE_CLOSURE_DRIFT:${relative(root, path)}`);
    }
  }
  return { checked, privateMode, contractState: privateMode ? "bootstrap-closed-oidc-ready" : "oidc-only-contract" };
}

export function assertPublishOidcBoundary(workflow: string): void {
  const prepareJob = workflowJob(workflow, "prepare-publication");
  const publishJob = workflowJob(workflow, "publish");
  if (
    !prepareJob.includes("id-token: none")
    || !prepareJob.includes("checks: read")
    || !prepareJob.includes("ref: ${{ inputs.workflow_sha }}")
    || !prepareJob.includes("persist-credentials: false")
    || !prepareJob.includes("scripts/release-state-machine-github.ts plan-publication")
    || prepareJob.includes("environment: npm-alpha")
    || !publishJob.includes("id-token: write")
    || !publishJob.includes("checks: write")
    || !publishJob.includes("environment: npm-alpha")
    || publishJob.includes("actions/checkout@")
    || publishJob.includes("corepack")
    || /\bpnpm\b/u.test(publishJob)
    || /\bnpm install\b/u.test(publishJob)
    || publishJob.includes("scripts/")
    || publishJob.includes("persist-credentials:")
    || publishJob.includes("ref: ${{ inputs.source_sha }}")
    || !publishJob.includes("Validate the approved identity without repository code")
    || !publishJob.includes('node-version: "24.18.0"')
    || !publishJob.includes('test "$(node --version)" = v24.18.0')
    || !publishJob.includes('test "$(npm --version)" = 11.16.0')
    || !publishJob.includes('const value=JSON.stringify([i.repository,i.version,i.sourceSha,i.tag,i.tagMessage,i.title,i.bodySha256,i.artifact.name,i.artifact.sha256,i.artifact.size,i.checksum.name,i.checksum.sha256,i.checksum.size,i.packageFiles,releaseId])')
    || !publishJob.includes('test "$canonical_digest" = "$EXPECTED_IDENTITY_DIGEST"')
    || !publishJob.includes('"repos/$GITHUB_REPOSITORY/releases/$EXPECTED_RELEASE_ID"')
    || !publishJob.includes('test "$(jq -r .immutable <<<"$release_json")" = true')
    || !publishJob.includes('"repos/$GITHUB_REPOSITORY/git/tags/$tag_object_sha"')
    || !publishJob.includes('"repos/$GITHUB_REPOSITORY/releases/$EXPECTED_RELEASE_ID/assets?per_page=100&page=$page"')
    || !publishJob.includes('cmp "$artifact" remote-artifact.tgz')
    || !publishJob.includes('cmp "$artifact.sha256" remote-artifact.tgz.sha256')
    || !publishJob.includes("Re-observe publication state at the OIDC boundary")
    || !publishJob.includes("Record durable publish intent at the OIDC boundary")
    || !publishJob.includes('"repos/$GITHUB_REPOSITORY/check-runs"')
    || !publishJob.includes('npm publish "$ARTIFACT" --tag alpha --access public --provenance --ignore-scripts')
  ) throw new Error("RT_RELEASE_PUBLISH_BOUNDARY_DRIFT");
}

export function assertReleaseProvenanceVerification(workflow: string): void {
  const required = ["source_sha:", "workflow_sha:", "publish_workflow_sha:", "publish_run_id:", "publish_run_attempt:", 'audit_output="$POST_PUBLISH_ROOT/signatures/audit-signatures.json"', "npm audit signatures --json --include-attestations", "scripts/verify-npm-provenance.ts", "--audit-signatures", "--tarball", "--workflow-sha", "--publish-run-id", "--publish-run-attempt", "dist-tags.alpha", 'actions/runs/$PUBLISH_RUN_ID/attempts/$PUBLISH_RUN_ATTEMPT', 'test "$(jq -r .head_sha <<<"$publish_run")" = "$INPUT_PUBLISH_WORKFLOW_SHA"', 'test "$(jq -r .path <<<"$publish_run")" = .github/workflows/release.yml'];
  const parser = "scripts/verify-npm-provenance.ts";
  const audit = 'npm audit signatures --json --include-attestations > "$audit_output")';
  const compareIndex = workflow.indexOf('cmp "$asset" "$registry_artifact"');
  const auditIndex = workflow.indexOf(audit);
  const parserIndex = workflow.indexOf(parser);
  const distTagIndex = workflow.indexOf("dist-tags.alpha");
  const auditLineEnd = workflow.indexOf("\n", auditIndex);
  const parserCommand = "pnpm tsx scripts/verify-npm-provenance.ts";
  const parserCommandIndex = workflow.indexOf(parserCommand);
  const parserLineStart = workflow.lastIndexOf("\n", parserCommandIndex) + 1;
  const adjacentAuditAndParser = auditLineEnd >= 0 && parserLineStart === auditLineEnd + 1 && workflow.slice(parserLineStart, parserCommandIndex).trim() === "" && workflow.includes('--audit-signatures "$audit_output"');
  if (
    required.some((marker) => !workflow.includes(marker))
    || count(workflow, parser) !== 1
    || count(workflow, audit) !== 1
    || count(workflow, parserCommand) !== 1
    || compareIndex < 0
    || auditIndex < compareIndex
    || parserIndex < auditIndex
    || distTagIndex < parserIndex
    || !adjacentAuditAndParser
    || /(?:\|\||&&)\s*true/u.test(workflow)
    || /continue-on-error:\s*true|if:\s*false/u.test(workflow)
    || !workflow.includes('test "$(git rev-parse HEAD)" = "$INPUT_WORKFLOW_SHA"')
    || !workflow.includes('git merge-base --is-ancestor "$INPUT_SOURCE_SHA" "$INPUT_WORKFLOW_SHA"')
    || !workflow.includes('--workflow-sha "$INPUT_PUBLISH_WORKFLOW_SHA"')
  ) throw new Error("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
}

export function assertReleaseRecoveryContract(publishWorkflow: string, verifyWorkflow: string, adapter: string): void {
  const buildJob = workflowJob(publishWorkflow, "build");
  const stageJob = workflowJob(publishWorkflow, "stage-release");
  const recoverJob = workflowJob(publishWorkflow, "recover-publication");
  const prepareJob = workflowJob(publishWorkflow, "prepare-publication");
  const publishJob = workflowJob(publishWorkflow, "publish");
  const verifyJob = workflowJob(publishWorkflow, "verify");
  const verifyIdentityStep = workflowStep(verifyWorkflow, "Validate remote identity and immutable assets before repository code");
  const verifyCheckout = verifyWorkflow.indexOf("actions/checkout@");
  const verifyIdentity = verifyWorkflow.indexOf("name: Validate remote identity and immutable assets before repository code");
  const exportIndex = buildJob.indexOf("pnpm package:export-public");
  const sourceNotesIndex = buildJob.indexOf("name: Materialize the immutable source release notes");
  const forbiddenGhRelease = /^\s*gh release (?:view|create|edit|download|upload)\b/gmu;
  const attestationCommands = `${publishWorkflow}\n${verifyWorkflow}`.match(/^\s*gh release verify(?:-asset)?\b.*$/gmu) ?? [];
  const adapterMarkers = [
    "per_page=100&page=${page}",
    "listAll<GitHubRelease>(`repos/${identity.repository}/releases`)",
    "/check-runs?filter=all&per_page=100&page=${page}",
    "checks.push(...response.check_runs)",
    "`repos/${identity.repository}/releases/${candidate.id}`",
    "`repos/${identity.repository}/releases/${releaseId}/assets`",
    "`repos/${identity.repository}/releases/assets/${asset.id}`",
    "return release.id",
    "fixedReleaseId",
    "await observe(identity, fixedReleaseId)",
    "await observe(identity, releaseId)",
    "RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED",
    "publish-intent/${identity.version}/",
    "publish-abort/${identity.version}/",
    "resolvePublishIntentLedger",
    "assertLocalArtifactSpecFailureEvidence",
    "actions/jobs/${publishJobs[0]!.id}/logs",
    "expectedArtifactName: identity.artifact.name",
    "recover-local-artifact-spec-failure",
    "releaseIdentityDigest(identity, releaseId)",
    "RT_RELEASE_STATE_AMBIGUOUS_PUBLISH_INTENT",
    "RT_RELEASE_PROVIDER_PUBLISHED_WITHOUT_INTENT",
    "RT_RELEASE_STATE_AMBIGUOUS_PUBLISH",
    "assertReleaseIdentityMutable(identity)",
  ];
  const verifyMarkers = [
    "release_id:",
    "INPUT_RELEASE_ID: ${{ inputs.release_id }}",
    '[[ "$release_id" =~ ^[1-9][0-9]*$ ]]',
    'release_json="$(gh api "repos/${GITHUB_REPOSITORY}/releases/$release_id")"',
    'test "$(jq -r .id <<<"$release_json")" = "$release_id"',
    'test "$(jq -r .target_commitish <<<"$release_json")" = "$source_sha"',
    'test "$(jq -r .object.type <<<"$tag_ref")" = tag',
    'test "$(jq -r .object.sha <<<"$tag_object")" = "$source_sha"',
    '"repos/${GITHUB_REPOSITORY}/releases/assets/$asset_id"',
    '"repos/${GITHUB_REPOSITORY}/releases/assets/$checksum_id"',
  ];
  if (
    !publishWorkflow.includes("concurrency:\n  group: release-${{ inputs.version }}\n  cancel-in-progress: false")
    || !publishWorkflow.includes("workflow_sha:")
    || !buildJob.includes("name: Bind the dispatch to the approved source and workflow revisions")
    || !buildJob.includes('test "$RUN_REF" = refs/heads/main')
    || !buildJob.includes('test "$RUN_SHA" = "$INPUT_WORKFLOW_SHA"')
    || !buildJob.includes('test "$WORKFLOW_SHA" = "$INPUT_WORKFLOW_SHA"')
    || !buildJob.includes('git merge-base --is-ancestor "$INPUT_SOURCE_SHA" "$INPUT_WORKFLOW_SHA"')
    || !buildJob.includes("ref: ${{ inputs.workflow_sha }}")
    || !buildJob.includes("name: Check out the immutable package source")
    || !buildJob.includes("ref: ${{ inputs.source_sha }}")
    || !buildJob.includes("path: release-source")
    || !buildJob.includes("pnpm --dir release-source --silent package:pack")
    || !buildJob.includes("RELEASE_NOTES: approved-CHANGELOG.md")
    || exportIndex < 0
    || sourceNotesIndex <= exportIndex
    || !buildJob.includes("RUN_ATTEMPT: ${{ github.run_attempt }}")
    || !buildJob.includes('[[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]')
    || !buildJob.includes('artifact_name=release-candidate-$INPUT_SOURCE_SHA-$INPUT_VERSION-attempt-$RUN_ATTEMPT')
    || buildJob.indexOf("name: Bind the dispatch to the approved source and workflow revisions") > buildJob.indexOf("actions/checkout@")
    || !buildJob.includes("scripts/release-state-machine-github.ts observe")
    || !stageJob.includes("release_id: ${{ steps.reconcile.outputs.release_id }}")
    || !stageJob.includes("ref: ${{ inputs.workflow_sha }}")
    || !stageJob.includes("scripts/release-state-machine-github.ts reconcile-github")
    || !publishWorkflow.includes("recover_failed_publish:")
    || !recoverJob.includes("needs: [build, stage-release]")
    || !recoverJob.includes("actions: read")
    || !recoverJob.includes("checks: write")
    || !recoverJob.includes("id-token: none")
    || !recoverJob.includes("RECOVER_FAILED_PUBLISH: ${{ inputs.recover_failed_publish }}")
    || !recoverJob.includes("scripts/release-state-machine-github.ts recover-local-artifact-spec-failure")
    || recoverJob.includes("id-token: write")
    || recoverJob.includes("environment: npm-alpha")
    || !prepareJob.includes("needs: [build, stage-release, recover-publication]")
    || !prepareJob.includes("id-token: none")
    || !prepareJob.includes("scripts/release-state-machine-github.ts plan-publication")
    || !prepareJob.includes("ref: ${{ inputs.workflow_sha }}")
    || !prepareJob.includes("EXPECTED_RELEASE_ID: ${{ needs.stage-release.outputs.release_id }}")
    || prepareJob.includes("environment: npm-alpha")
    || !publishJob.includes("needs: [build, stage-release, prepare-publication]")
    || !publishJob.includes("actions: read")
    || !publishJob.includes("checks: write")
    || !publishJob.includes("id-token: write")
    || !publishJob.includes("environment: npm-alpha")
    || publishJob.includes("actions/checkout@")
    || publishJob.includes("corepack")
    || /\bpnpm\b/u.test(publishJob)
    || publishJob.includes("scripts/")
    || !publishJob.includes("if: steps.reobserve.outputs.publish == 'true'")
    || !publishJob.includes("name: Re-observe publication state at the OIDC boundary")
    || !publishJob.includes('"repos/$GITHUB_REPOSITORY/commits/$INPUT_SOURCE_SHA/check-runs?filter=all&per_page=100&page=$page"')
    || publishJob.includes(".check_runs.length")
    || !publishJob.includes("jq -r '.check_runs | length'")
    || !publishJob.includes('test "$intent_count" -le 2')
    || !publishJob.includes('test "$abort_count" -le 1')
    || !publishJob.includes(`test "$(jq -sr '[.[].name] | unique | length' publish-intents.jsonl)" = "$intent_count"`)
    || !publishJob.includes(`test "$(jq -sr '[.[].name] | unique | length' publish-aborts.jsonl)" = "$abort_count"`)
    || !publishJob.includes('test "$active_intent_count" -le 1')
    || !publishJob.includes('test "$active_intent_count" = 0')
    || !publishJob.includes('test "$active_intent_count" = 1')
    || !publishJob.includes('echo "publish_run_id=$GITHUB_RUN_ID" >> "$GITHUB_OUTPUT"')
    || !publishJob.includes('echo "publish_run_attempt=$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"')
    || !publishJob.includes('echo "publish_workflow_sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"')
    || !publishJob.includes('"repos/$GITHUB_REPOSITORY/actions/runs/$original_publish_run_id/attempts/$original_publish_run_attempt"')
    || !publishJob.includes('test "$(jq -r .path <<<"$publish_run")" = .github/workflows/release.yml')
    || !publishJob.includes('echo "publish_workflow_sha=$original_publish_workflow_sha" >> "$GITHUB_OUTPUT"')
    || !publishJob.includes('PUBLISH_RUN_ID: ${{ steps.reobserve.outputs.publish_run_id }}')
    || !publishJob.includes('PUBLISH_RUN_ATTEMPT: ${{ steps.reobserve.outputs.publish_run_attempt }}')
    || !publishJob.includes("Record durable publish intent at the OIDC boundary")
    || !publishJob.includes('"repos/$GITHUB_REPOSITORY/check-runs"')
    || !publishJob.includes("EXPECTED_IDENTITY_DIGEST: ${{ needs.prepare-publication.outputs.identity_digest }}")
    || !publishJob.includes("ARTIFACT: ${{ github.workspace }}/release-assets/${{ needs.build.outputs.artifact }}")
    || !publishJob.includes('test -f "$ARTIFACT"')
    || count(publishJob, "npm publish ") !== 1
    || publishJob.indexOf("Record durable publish intent at the OIDC boundary") > publishJob.indexOf("npm publish ")
    || publishJob.indexOf("Validate the approved identity without repository code") > publishJob.indexOf("Record durable publish intent at the OIDC boundary")
    || !verifyJob.includes("release_id: ${{ needs.stage-release.outputs.release_id }}")
    || !verifyJob.includes("workflow_sha: ${{ inputs.workflow_sha }}")
    || !verifyJob.includes("publish_workflow_sha: ${{ needs.publish.outputs.publish_workflow_sha }}")
    || !verifyJob.includes("publish_run_id: ${{ needs.publish.outputs.publish_run_id }}")
    || !verifyJob.includes("publish_run_attempt: ${{ needs.publish.outputs.publish_run_attempt }}")
    || verifyMarkers.some((marker) => !verifyWorkflow.includes(marker))
    || verifyIdentity < 0
    || verifyCheckout < 0
    || verifyIdentity >= verifyCheckout
    || !verifyWorkflow.includes("ref: ${{ inputs.workflow_sha }}")
    || !verifyWorkflow.includes('test "$(git rev-parse HEAD)" = "$INPUT_WORKFLOW_SHA"')
    || !verifyWorkflow.includes('git merge-base --is-ancestor "$INPUT_SOURCE_SHA" "$INPUT_WORKFLOW_SHA"')
    || verifyWorkflow.includes("ref: ${{ inputs.tag }}")
    || /^\s*npm publish\b/gmu.test(verifyWorkflow + adapter)
    || /releases\/tags\//u.test(publishWorkflow + verifyWorkflow + adapter)
    || forbiddenGhRelease.test(publishWorkflow + verifyWorkflow)
    || attestationCommands.some((command) => !command.includes('--repo "$GITHUB_REPOSITORY"'))
    || adapterMarkers.some((marker) => !adapter.includes(marker))
    || /method:\s*"DELETE"|--clobber|git push .*:(?:refs\/tags\/)?/u.test(publishWorkflow + verifyWorkflow + adapter)
  ) throw new Error("RT_RELEASE_RECOVERY_CONTRACT_DRIFT");
}

function count(value: string, marker: string): number { return value.split(marker).length - 1; }

export function assertReleaseBuildAuditOrder(workflow: string): void {
  const buildJob = workflowJob(workflow, "build");
  const auditCommand = "pnpm audit --audit-level=high";
  const auditStep = `      - run: ${auditCommand}`;
  const sourceAuditCommand = "pnpm --dir release-source audit --audit-level=high";
  const sourceAuditStep = `      - run: ${sourceAuditCommand}`;
  const auditSteps = buildJob.match(/^ {6}- run: pnpm audit --audit-level=high$/gmu) ?? [];
  const sourceAuditSteps = buildJob.match(/^ {6}- run: pnpm --dir release-source audit --audit-level=high$/gmu) ?? [];
  const auditIndex = buildJob.indexOf(auditStep);
  const sourceAuditIndex = buildJob.indexOf(sourceAuditStep);
  const installIndex = buildJob.indexOf("pnpm install --frozen-lockfile");
  const sourceInstallIndex = buildJob.indexOf("pnpm --dir release-source install --frozen-lockfile");
  const artifactMarkers = [
    "pnpm package:export-public",
    "pnpm --dir release-source --silent package:pack",
    "actions/upload-artifact@",
  ];
  const artifactIndexes = artifactMarkers.map((marker) => buildJob.indexOf(marker));
  const isBareStep = (index: number, step: string): boolean => {
    const remainder = index < 0 ? "" : buildJob.slice(index + step.length);
    const nextStepIndex = remainder.search(/^ {6}- /mu);
    return (nextStepIndex < 0 ? remainder : remainder.slice(0, nextStepIndex)).trim() === "";
  };
  if (
    auditSteps.length !== 1
    || sourceAuditSteps.length !== 1
    || !isBareStep(auditIndex, auditStep)
    || !isBareStep(sourceAuditIndex, sourceAuditStep)
    || buildJob.includes("continue-on-error:")
    || installIndex < 0
    || auditIndex < installIndex
    || sourceInstallIndex < 0
    || sourceAuditIndex < sourceInstallIndex
    || artifactIndexes.some((index) => index < 0)
    || artifactIndexes.some((index) => auditIndex > index)
    || sourceAuditIndex > artifactIndexes[1]!
  ) throw new Error("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
}

export function assertReleaseArtifactApproval(workflow: string, adapter: string): void {
  const buildJob = workflowJob(workflow, "build");
  const stageJob = workflowJob(workflow, "stage-release");
  const publishJob = workflowJob(workflow, "publish");
  const publicationValidationStep = workflowStep(workflow, "Validate the approved identity without repository code");
  const publishStep = workflowStep(workflow, "publish_once through npm Trusted Publishing");
  const verifyJob = workflowJob(workflow, "verify");
  const dispatchStart = workflow.indexOf("  workflow_dispatch:");
  const dispatchEnd = workflow.indexOf("\npermissions:", dispatchStart);
  const dispatch = dispatchStart < 0 || dispatchEnd < 0 ? "" : workflow.slice(dispatchStart, dispatchEnd);
  const packIndex = buildJob.indexOf("name: Build the release artifact once");
  const approvalIndex = buildJob.indexOf("name: Verify the approved release artifact identity");
  const identityIndex = buildJob.indexOf("name: Create the canonical release identity record");
  const observeIndex = buildJob.indexOf("name: Observe and fail closed on incompatible external state");
  const cleanRoomIndex = buildJob.indexOf("name: Verify the exact release artifact in a clean room");
  const uploadIndex = buildJob.indexOf("name: Upload the reviewed release candidate");
  const uploadStep = workflowStep(workflow, "Upload the reviewed release candidate");
  const approvalEnd = approvalIndex < 0 ? -1 : buildJob.indexOf("\n      - ", approvalIndex);
  const approvalStep = approvalIndex < 0 ? "" : buildJob.slice(approvalIndex, approvalEnd < 0 ? buildJob.length : approvalEnd);
  const requiredApprovalMarkers = [
    "id: approved",
    "set -euo pipefail",
    "INPUT_EXPECTED_SHA256: ${{ inputs.expected_sha256 }}",
    "INPUT_EXPECTED_SIZE: ${{ inputs.expected_size }}",
    'expected_sha256="$INPUT_EXPECTED_SHA256"',
    'expected_size="$INPUT_EXPECTED_SIZE"',
    '[[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]',
    '[[ "$expected_size" =~ ^[1-9][0-9]*$ ]]',
    'test "$(sha256sum "$artifact" | cut -d\' \' -f1)" = "$expected_sha256"',
    'test "$(wc -c < "$artifact" | tr -d \' \')" = "$expected_size"',
    'test "$(cat "$artifact.sha256")" = "$expected_sha256  $artifact"',
    "report.size!==Number(process.argv[1])",
    "report.files!==manifest.files.length",
    'echo "sha256=$expected_sha256" >> "$GITHUB_OUTPUT"',
    'echo "size=$expected_size" >> "$GITHUB_OUTPUT"',
  ];
  const publishChecks = [
    'test "$(sha256sum "$artifact" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"',
    'test "$(wc -c < "$artifact" | tr -d \' \')" = "$EXPECTED_SIZE"',
    'test "$(cat "$artifact.sha256")" = "$EXPECTED_SHA256  $EXPECTED_ARTIFACT"',
  ];
  const publishSideEffectIndex = publishJob.indexOf('npm publish "$ARTIFACT"');
  const publishCheckIndexes = publishChecks.map((marker) => publishJob.indexOf(marker));
  const publishIntentIndex = publishJob.indexOf("name: Record durable publish intent at the OIDC boundary");
  const registryPreflightIndex = publishJob.indexOf("name: Re-observe publication state at the OIDC boundary");
  const requiredInput = (name: string): boolean => {
    const start = dispatch.indexOf(`      ${name}:`);
    if (start < 0) return false;
    const remainder = dispatch.slice(start + 7);
    const next = remainder.search(/^      [A-Za-z0-9_]+:/mu);
    const block = next < 0 ? remainder : remainder.slice(0, next);
    return block.includes("required: true") && block.includes("type: string");
  };
  if (
    !requiredInput("expected_sha256")
    || !requiredInput("expected_size")
    || count(workflow, "package:pack") !== 1
    || packIndex < 0
    || approvalIndex <= packIndex
    || identityIndex <= approvalIndex
    || observeIndex <= identityIndex
    || cleanRoomIndex <= approvalIndex
    || uploadIndex <= approvalIndex
    || count(buildJob, "name: Verify the approved release artifact identity") !== 1
    || requiredApprovalMarkers.some((marker) => !approvalStep.includes(marker))
    || !buildJob.includes("sha256: ${{ steps.approved.outputs.sha256 }}")
    || !buildJob.includes("size: ${{ steps.approved.outputs.size }}")
    || buildJob.includes("steps.artifact.outputs.sha256")
    || !buildJob.includes("RELEASE_EXPECTED_SHA256: ${{ steps.approved.outputs.sha256 }}")
    || !buildJob.includes("RELEASE_EXPECTED_SIZE: ${{ steps.approved.outputs.size }}")
    || !buildJob.includes("release-identity.json")
    || !uploadStep.includes("release-identity.json")
    || !stageJob.includes("RELEASE_IDENTITY_FILE: release-assets/release-identity.json")
    || !stageJob.includes("RELEASE_ASSET_DIR: release-assets")
    || !adapter.includes("bytes.byteLength !== asset.size || sha256(bytes) !== asset.sha256")
    || !adapter.includes("sha256(remote) !== expected.sha256 || remote.byteLength !== expected.size || Buffer.compare(remote, local) !== 0")
    || !publicationValidationStep.includes("EXPECTED_SHA256: ${{ needs.build.outputs.sha256 }}")
    || !publicationValidationStep.includes("EXPECTED_SIZE: ${{ needs.build.outputs.size }}")
    || publishChecks.some((check) => !publicationValidationStep.includes(check))
    || publishSideEffectIndex < 0
    || publishCheckIndexes.some((index) => index < 0 || index >= publishSideEffectIndex)
    || registryPreflightIndex < 0
    || publishIntentIndex <= registryPreflightIndex
    || publishSideEffectIndex <= publishIntentIndex
    || publishStep.includes("curl ")
    || publishStep.includes("sha256sum")
    || publishStep.includes("wc -c")
    || !verifyJob.includes("expected_sha256: ${{ needs.build.outputs.sha256 }}")
    || !verifyJob.includes("expected_size: ${{ needs.build.outputs.size }}")
    || /set\s+\+e|(?:\|\||&&)\s*true/u.test(approvalStep + publicationValidationStep + publishStep)
    || /continue-on-error:\s*true|if:\s*false/u.test(approvalStep)
  ) throw new Error("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
}

export function assertReleaseVerificationArtifactApproval(workflow: string): void {
  const validationStep = workflowStep(workflow, "Validate remote identity and immutable assets before repository code");
  const compareStep = workflowStep(workflow, "Compare registry bytes and run clean-room verification");
  const validationMarkers = [
    "EXPECTED_SHA256: ${{ inputs.expected_sha256 }}",
    "EXPECTED_SIZE: ${{ inputs.expected_size }}",
    '[[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]',
    '[[ "$expected_size" =~ ^[1-9][0-9]*$ ]]',
    'test "$(sha256sum "$POST_PUBLISH_ROOT/release/$asset" | cut -d\' \' -f1)" = "$expected_sha256"',
    'test "$(wc -c < "$POST_PUBLISH_ROOT/release/$asset" | tr -d \' \')" = "$expected_size"',
    'test "$(jq -r .object.sha <<<"$tag_object")" = "$source_sha"',
    'test "$(jq -r .target_commitish <<<"$release_json")" = "$source_sha"',
    'cmp "$POST_PUBLISH_ROOT/identity/approved.sha256" "$POST_PUBLISH_ROOT/release/$asset.sha256"',
  ];
  const compareMarkers = [
    "EXPECTED_SHA256: ${{ inputs.expected_sha256 }}",
    "EXPECTED_SIZE: ${{ inputs.expected_size }}",
    'test "$(sha256sum "$asset" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"',
    'test "$(wc -c < "$asset" | tr -d \' \')" = "$EXPECTED_SIZE"',
    'test "$(sha256sum "$registry_artifact" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"',
    'test "$(wc -c < "$registry_artifact" | tr -d \' \')" = "$EXPECTED_SIZE"',
    'cmp "$asset" "$registry_artifact"',
    'BETTER_REALTIME_TARBALL="$registry_artifact" pnpm package:clean-room',
  ];
  const compareIndex = compareStep.indexOf('cmp "$asset" "$registry_artifact"');
  const registrySizeIndex = compareStep.indexOf('test "$(wc -c < "$registry_artifact" | tr -d \' \')" = "$EXPECTED_SIZE"');
  const cleanRoomIndex = compareStep.indexOf('BETTER_REALTIME_TARBALL="$registry_artifact" pnpm package:clean-room');
  const requiredInputBlocks = (name: string): string[] => workflow.match(new RegExp(`^      ${name}:\\n(?:^ {8}.*\\n?)+`, "gmu")) ?? [];
  const approvedInputs = ["expected_sha256", "expected_size"].every((name) => {
    const blocks = requiredInputBlocks(name);
    return blocks.length === 2 && blocks.every((block) => block.includes("required: true") && block.includes("type: string"));
  });
  if (
    !approvedInputs
    || validationMarkers.some((marker) => !validationStep.includes(marker))
    || compareMarkers.some((marker) => !compareStep.includes(marker))
    || compareIndex <= registrySizeIndex
    || cleanRoomIndex <= compareIndex
    || !validationStep.includes("set -euo pipefail")
    || !compareStep.includes("set -euo pipefail")
    || /set\s+\+e|(?:\|\||&&)\s*true/u.test(validationStep + compareStep)
    || /continue-on-error:\s*true|if:\s*false/u.test(validationStep + compareStep)
  ) throw new Error("RT_RELEASE_VERIFICATION_ARTIFACT_APPROVAL_DRIFT");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

function workflowJob(workflow: string, name: string): string {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|\\n)  ${escaped}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z][A-Za-z0-9-]*:\\n|$)`, "u").exec(workflow);
  if (!match) throw new Error(`RT_RELEASE_WORKFLOW_JOB_MISSING:${name}`);
  return match[1]!;
}

function workflowStep(workflow: string, name: string): string {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|\\n)      - name: ${escaped}\\n([\\s\\S]*?)(?=\\n      - |$)`, "u").exec(workflow);
  if (!match) throw new Error(`RT_RELEASE_WORKFLOW_STEP_MISSING:${name}`);
  return match[1]!;
}
