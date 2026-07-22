import { access, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const releaseAuthority = "Bootstrap GAT authority: packages-all read-write, organizations no-access, bypass-2FA enabled; not package- or version-scoped.";
export const bootstrapClosedContract = "Bootstrap state: closed; GitHub Environment secret absence: independently verified; bootstrap GAT revocation: user-confirmed.";
export const trustedPublisherEvidenceContract =
  "Trusted Publisher state: configuration fields and token-disallow setting user-confirmed in authenticated npm UI; functional OIDC publication unverified until the next separately approved OIDC-only publish.";
export const finalDistTagsContract = "Final registry dist-tags: alpha=0.1.0-alpha.1; latest=0.1.0-alpha.1; alpha-candidate=absent.";
export const historicalReleaseBoundaryContract = "Alpha.1 GitHub boundary: release immutable=false; repository immutable releases was enabled=false at alpha.1 publication and is enabled=true now; npm artifact is non-republishable; annotated tag and checksum assets are preserved by project policy, not GitHub-enforced immutability.";
export const nextReleaseContract =
  "Next release contract: OIDC-only; bounded registry-convergence polling; post-publish verification resumable without republishing; reject existing version or immutable release assets.";
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
  const runbookPath = resolve(root, "docs", "public", "release.md");
  const publicPaths = [publishPath, verifyPath, runbookPath];
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
  const runbook = await readFile(runbookPath, "utf8");
  for (const token of prohibitedWorkflowTokens) for (const [path, text] of [[publishPath, publish], [verifyPath, verify]] as const) if (text.includes(token)) throw new Error(`RT_RELEASE_BOOTSTRAP_PATH_PRESENT:${relative(root, path)}:${token}`);
  for (const requiredText of ["id-token: write", "npm publish", "npm view \"better-realtime@$version\"", "git ls-remote --exit-code --tags", "gh release view", "uses: ./.github/workflows/release-verify.yml", "jq -r .immutable", "jq -r .prerelease", "asset_names=", "gh release download", "immutable-release-assets/$ARTIFACT", "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f", "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131"]) if (!publish.includes(requiredText)) throw new Error(`RT_RELEASE_OIDC_CONTRACT_DRIFT:${relative(root, publishPath)}`);
  const buildJob = workflowJob(publish, "build");
  const publishJob = workflowJob(publish, "publish");
  if (!buildJob.includes("id-token: none") || buildJob.includes("environment: npm-alpha")) throw new Error(`RT_RELEASE_BUILD_OIDC_EXPOSED:${relative(root, publishPath)}`);
  assertReleaseBuildAuditOrder(publish);
  assertReleaseArtifactApproval(publish);
  if (!publishJob.includes("id-token: write") || !publishJob.includes("environment: npm-alpha") || publishJob.includes("actions/checkout@") || publishJob.includes("pnpm ") || publishJob.includes("corepack")) throw new Error(`RT_RELEASE_PUBLISH_BOUNDARY_DRIFT:${relative(root, publishPath)}`);
  for (const requiredText of ["id-token: none", "workflow_call:", "workflow_dispatch:", "expected_size:", "EXPECTED_SIZE: ${{ inputs.expected_size }}", "for attempt in $(seq 1 20)", "sleep 15", "cmp \"$asset\" \"$registry_artifact\"", "npm audit signatures", "jq -r .immutable", "git/ref/tags/$tag", "git/tags/$tag_object_sha", "wc -c < \"$registry_artifact\""]) if (!verify.includes(requiredText)) throw new Error(`RT_RELEASE_VERIFICATION_CONTRACT_DRIFT:${relative(root, verifyPath)}`);
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

export function assertReleaseProvenanceVerification(workflow: string): void {
  const required = ["source_sha:", "publish_run_id:", "publish_run_attempt:", 'audit_output="post-publish/signatures/audit-signatures.json"', "npm audit signatures --json --include-attestations", "scripts/verify-npm-provenance.ts", "--audit-signatures", "--tarball", "--source-sha", "--publish-run-id", "--publish-run-attempt", "dist-tags.alpha"];
  const parser = "scripts/verify-npm-provenance.ts";
  const audit = 'npm audit signatures --json --include-attestations > "$GITHUB_WORKSPACE/$audit_output")';
  const compareIndex = workflow.indexOf('cmp "$asset" "$registry_artifact"');
  const auditIndex = workflow.indexOf(audit);
  const parserIndex = workflow.indexOf(parser);
  const distTagIndex = workflow.indexOf("dist-tags.alpha");
  const auditLineEnd = workflow.indexOf("\n", auditIndex);
  const parserCommand = "pnpm tsx scripts/verify-npm-provenance.ts";
  const parserCommandIndex = workflow.indexOf(parserCommand);
  const parserLineStart = workflow.lastIndexOf("\n", parserCommandIndex) + 1;
  const adjacentAuditAndParser = auditLineEnd >= 0 && parserLineStart === auditLineEnd + 1 && workflow.slice(parserLineStart, parserCommandIndex).trim() === "" && workflow.includes('--audit-signatures "$audit_output"');
  if (required.some((marker) => !workflow.includes(marker)) || count(workflow, parser) !== 1 || count(workflow, audit) !== 1 || count(workflow, parserCommand) !== 1 || compareIndex < 0 || auditIndex < compareIndex || parserIndex < auditIndex || distTagIndex < parserIndex || !adjacentAuditAndParser || /(?:\|\||&&)\s*true/u.test(workflow) || /continue-on-error:\s*true|if:\s*false/u.test(workflow) || !workflow.includes('test "$(git rev-parse HEAD)" = "$source_sha"')) throw new Error("RT_RELEASE_PROVENANCE_VERIFICATION_DRIFT");
}

function count(value: string, marker: string): number { return value.split(marker).length - 1; }

export function assertReleaseBuildAuditOrder(workflow: string): void {
  const buildJob = workflowJob(workflow, "build");
  const auditCommand = "pnpm audit --audit-level=high";
  const auditStep = `      - run: ${auditCommand}`;
  const auditSteps = buildJob.match(/^ {6}- run: pnpm audit --audit-level=high$/gmu) ?? [];
  const auditIndex = buildJob.indexOf(auditStep);
  const installIndex = buildJob.indexOf("pnpm install --frozen-lockfile");
  const artifactMarkers = [
    "pnpm package:export-public",
    "pnpm --silent package:pack",
    "actions/upload-artifact@",
  ];
  const artifactIndexes = artifactMarkers.map((marker) => buildJob.indexOf(marker));
  const auditStepRemainder = auditIndex < 0 ? "" : buildJob.slice(auditIndex + auditStep.length);
  const nextStepIndex = auditStepRemainder.search(/^ {6}- /mu);
  const auditStepTail = nextStepIndex < 0 ? auditStepRemainder : auditStepRemainder.slice(0, nextStepIndex);
  if (auditSteps.length !== 1 || auditStepTail.trim() || buildJob.includes("continue-on-error:") || installIndex < 0 || auditIndex < installIndex || artifactIndexes.some((index) => index < 0) || artifactIndexes.some((index) => auditIndex > index)) throw new Error("RT_RELEASE_BUILD_AUDIT_GATE_ORDER");
}

export function assertReleaseArtifactApproval(workflow: string): void {
  const buildJob = workflowJob(workflow, "build");
  const dispatchStart = workflow.indexOf("  workflow_dispatch:");
  const dispatchEnd = workflow.indexOf("\npermissions:", dispatchStart);
  const dispatch = dispatchStart < 0 || dispatchEnd < 0 ? "" : workflow.slice(dispatchStart, dispatchEnd);
  const packIndex = buildJob.indexOf("name: Build the release artifact once");
  const approvalIndex = buildJob.indexOf("name: Verify the approved release artifact identity");
  const cleanRoomIndex = buildJob.indexOf("name: Verify the exact release artifact in a clean room");
  const uploadIndex = buildJob.indexOf("name: Upload the reviewed release candidate");
  const approvalEnd = approvalIndex < 0 ? -1 : buildJob.indexOf("\n      - ", approvalIndex);
  const approvalStep = approvalIndex < 0 ? "" : buildJob.slice(approvalIndex, approvalEnd < 0 ? buildJob.length : approvalEnd);
  const requiredApprovalMarkers = [
    "id: approved",
    "set -euo pipefail",
    "INPUT_EXPECTED_SHA256: ${{ inputs.expected_sha256 }}",
    "INPUT_EXPECTED_SIZE: ${{ inputs.expected_size }}",
    '[[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]',
    '[[ "$expected_size" =~ ^[1-9][0-9]*$ ]]',
    'test "$(sha256sum "$artifact" | cut -d\' \' -f1)" = "$expected_sha256"',
    'test "$(wc -c < "$artifact" | tr -d \' \')" = "$expected_size"',
    'test "$(cut -d\' \' -f1 "$artifact.sha256")" = "$expected_sha256"',
    "report.size!==Number(process.argv[1])",
    "report.files!==manifest.files.length",
    'echo "sha256=$expected_sha256" >> "$GITHUB_OUTPUT"',
    'echo "size=$expected_size" >> "$GITHUB_OUTPUT"',
  ];
  const stageStep = workflowStep(workflow, "Create exact annotated tag and asset-complete draft prerelease");
  const immutableStep = workflowStep(workflow, "Require the published GitHub release to be immutable before npm publication");
  const publishStep = workflowStep(workflow, "Publish the exact artifact through npm Trusted Publishing");
  const downstreamJobs = [
    [stageStep, 'test "$(sha256sum "$ARTIFACT" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"', 'test "$(wc -c < "$ARTIFACT" | tr -d \' \')" = "$EXPECTED_SIZE"', 'test "$(cut -d\' \' -f1 "$ARTIFACT.sha256")" = "$EXPECTED_SHA256"'],
    [immutableStep, 'test "$(sha256sum "immutable-release-assets/$ARTIFACT" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"', 'test "$(wc -c < "immutable-release-assets/$ARTIFACT" | tr -d \' \')" = "$EXPECTED_SIZE"', 'test "$(cut -d\' \' -f1 "immutable-release-assets/$ARTIFACT.sha256")" = "$EXPECTED_SHA256"'],
    [publishStep, 'test "$(sha256sum "$ARTIFACT" | cut -d\' \' -f1)" = "$EXPECTED_SHA256"', 'test "$(wc -c < "$ARTIFACT" | tr -d \' \')" = "$EXPECTED_SIZE"', 'test "$(cut -d\' \' -f1 "$ARTIFACT.sha256")" = "$EXPECTED_SHA256"'],
  ] as const;
  const stageSideEffectIndex = stageStep.indexOf('gh api --method POST "repos/${GITHUB_REPOSITORY}/git/tags"');
  const stageCheckIndexes = downstreamJobs[0].slice(1).map((marker) => stageStep.indexOf(marker));
  const publishSideEffectIndex = publishStep.indexOf('npm publish "$ARTIFACT"');
  const publishCheckIndexes = downstreamJobs[2].slice(1).map((marker) => publishStep.indexOf(marker));
  const downstreamBypass = downstreamJobs.some(([step]) => !step.includes("set -euo pipefail") || /set\s+\+e|(?:\|\||&&)\s*true|continue-on-error:\s*true|if:\s*false/u.test(step));
  const verifyJob = workflowJob(workflow, "verify");
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
    || count(workflow, "pnpm --silent package:pack") !== 1
    || packIndex < 0
    || approvalIndex <= packIndex
    || cleanRoomIndex <= approvalIndex
    || uploadIndex <= approvalIndex
    || count(buildJob, "name: Verify the approved release artifact identity") !== 1
    || requiredApprovalMarkers.some((marker) => !approvalStep.includes(marker))
    || !buildJob.includes("sha256: ${{ steps.approved.outputs.sha256 }}")
    || !buildJob.includes("size: ${{ steps.approved.outputs.size }}")
    || buildJob.includes("steps.artifact.outputs.sha256")
    || downstreamJobs.some(([job, ...checks]) => !job.includes("EXPECTED_SHA256: ${{ needs.build.outputs.sha256 }}") || !job.includes("EXPECTED_SIZE: ${{ needs.build.outputs.size }}") || checks.some((check) => !job.includes(check)))
    || stageSideEffectIndex < 0
    || stageCheckIndexes.some((index) => index < 0 || index >= stageSideEffectIndex)
    || publishSideEffectIndex < 0
    || publishCheckIndexes.some((index) => index < 0 || index >= publishSideEffectIndex)
    || downstreamBypass
    || !verifyJob.includes("expected_sha256: ${{ needs.build.outputs.sha256 }}")
    || !verifyJob.includes("expected_size: ${{ needs.build.outputs.size }}")
    || /set\s+\+e|(?:\|\||&&)\s*true/u.test(approvalStep)
    || /continue-on-error:\s*true|if:\s*false/u.test(approvalStep)
  ) throw new Error("RT_RELEASE_ARTIFACT_APPROVAL_DRIFT");
}

export function assertReleaseVerificationArtifactApproval(workflow: string): void {
  const validationStep = workflowStep(workflow, "Validate verification-only identity and immutable assets");
  const compareStep = workflowStep(workflow, "Compare registry bytes and run clean-room verification");
  const validationMarkers = [
    "EXPECTED_SHA256: ${{ inputs.expected_sha256 }}",
    "EXPECTED_SIZE: ${{ inputs.expected_size }}",
    '[[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]',
    '[[ "$expected_size" =~ ^[1-9][0-9]*$ ]]',
    'test "$(sha256sum "post-publish/release/$asset" | cut -d\' \' -f1)" = "$expected_sha256"',
    'test "$(wc -c < "post-publish/release/$asset" | tr -d \' \')" = "$expected_size"',
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
