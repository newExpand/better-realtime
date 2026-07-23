export interface PublishCheckRun {
  id: number;
  name: string;
  external_id: string | null;
  head_sha: string;
}

export interface PublishAttemptIdentity {
  runId: string;
  runAttempt: string;
}

export interface PublishIntentLedger {
  active: PublishAttemptIdentity | undefined;
  aborted: PublishAttemptIdentity[];
}

export interface ActionsRunEvidence {
  id: number;
  run_attempt: number;
  event: string;
  path: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export interface ActionsJobEvidence {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: Array<{ name: string; status: string; conclusion: string | null }>;
}

export interface LocalArtifactSpecFailureEvidence {
  expectedRunId: string;
  expectedRunAttempt: string;
  expectedArtifactName: string;
  run: ActionsRunEvidence;
  jobs: ActionsJobEvidence[];
  workflowSource: string;
  jobLog: string;
}

const attemptSuffix = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u;

function fail(code: string): never {
  throw new Error(`RT_RELEASE_RECOVERY_${code}`);
}

function parseMarker(
  marker: PublishCheckRun,
  prefix: string,
  sourceSha: string,
  identityDigest: string,
): PublishAttemptIdentity {
  if (marker.head_sha !== sourceSha || marker.external_id !== identityDigest) fail("MARKER_IDENTITY_MISMATCH");
  const match = attemptSuffix.exec(marker.name.slice(prefix.length));
  if (!match) fail("MARKER_NAME_INVALID");
  return { runId: match[1]!, runAttempt: match[2]! };
}

function attemptKey(attempt: PublishAttemptIdentity): string {
  return `${attempt.runId}/${attempt.runAttempt}`;
}

export function resolvePublishIntentLedger(
  checks: PublishCheckRun[],
  version: string,
  sourceSha: string,
  identityDigest: string,
): PublishIntentLedger {
  const intentPrefix = `publish-intent/${version}/`;
  const abortPrefix = `publish-abort/${version}/`;
  const intents = checks.filter(({ name }) => name.startsWith(intentPrefix)).map((marker) => parseMarker(marker, intentPrefix, sourceSha, identityDigest));
  const aborted = checks.filter(({ name }) => name.startsWith(abortPrefix)).map((marker) => parseMarker(marker, abortPrefix, sourceSha, identityDigest));
  if (intents.length > 2 || aborted.length > 1) fail("LEDGER_BOUNDS_EXCEEDED");
  if (new Set(intents.map(attemptKey)).size !== intents.length || new Set(aborted.map(attemptKey)).size !== aborted.length) fail("DUPLICATE_MARKER");
  const intentKeys = new Set(intents.map(attemptKey));
  if (aborted.some((attempt) => !intentKeys.has(attemptKey(attempt)))) fail("ABORT_WITHOUT_INTENT");
  const abortedKeys = new Set(aborted.map(attemptKey));
  const active = intents.filter((attempt) => !abortedKeys.has(attemptKey(attempt)));
  if (active.length > 1) fail("MULTIPLE_ACTIVE_INTENTS");
  return { active: active[0], aborted };
}

function requireStep(job: ActionsJobEvidence, name: string, conclusion: string, code: string): void {
  const matches = job.steps.filter((step) => step.name === name);
  if (matches.length !== 1 || matches[0]!.status !== "completed" || matches[0]!.conclusion !== conclusion) fail(code);
}

export function assertLocalArtifactSpecFailureEvidence(evidence: LocalArtifactSpecFailureEvidence): void {
  if (!attemptSuffix.test(`${evidence.expectedRunId}/${evidence.expectedRunAttempt}`)) fail("ATTEMPT_INVALID");
  if (!/^better-realtime-0\.[0-9]+\.[0-9]+-alpha\.[0-9]+\.tgz$/u.test(evidence.expectedArtifactName)) fail("ARTIFACT_NAME_INVALID");
  const { run } = evidence;
  if (
    String(run.id) !== evidence.expectedRunId
    || String(run.run_attempt) !== evidence.expectedRunAttempt
    || run.event !== "workflow_dispatch"
    || run.path !== ".github/workflows/release.yml"
    || !/^[a-f0-9]{40}$/u.test(run.head_sha)
    || run.status !== "completed"
    || run.conclusion !== "failure"
  ) fail("RUN_EVIDENCE_MISMATCH");
  const publishJobs = evidence.jobs.filter(({ name }) => name === "publish");
  if (publishJobs.length !== 1 || publishJobs[0]!.status !== "completed" || publishJobs[0]!.conclusion !== "failure") fail("PUBLISH_JOB_NOT_FAILED");
  const job = publishJobs[0]!;
  requireStep(job, "Validate the approved identity without repository code", "success", "IDENTITY_STEP_NOT_PROVEN");
  requireStep(job, "Re-observe publication state at the OIDC boundary", "success", "REOBSERVE_STEP_NOT_PROVEN");
  requireStep(job, "Record durable publish intent at the OIDC boundary", "success", "INTENT_STEP_NOT_PROVEN");
  requireStep(job, "publish_once through npm Trusted Publishing", "failure", "PUBLISH_STEP_NOT_FAILED");
  requireStep(job, "Export the publication identity for verification", "skipped", "EXPORT_STEP_NOT_SKIPPED");
  const vulnerableArtifact = "ARTIFACT: release-assets/${{ needs.build.outputs.artifact }}";
  const correctedArtifact = "ARTIFACT: ${{ github.workspace }}/release-assets/${{ needs.build.outputs.artifact }}";
  if (
    !evidence.workflowSource.includes('test "$(npm --version)" = 11.16.0')
    || !evidence.workflowSource.includes(vulnerableArtifact)
    || evidence.workflowSource.includes(correctedArtifact)
    || !evidence.workflowSource.includes('npm publish "$ARTIFACT" --tag alpha --access public --provenance --ignore-scripts')
  ) fail("WORKFLOW_NOT_VULNERABLE");
  const expectedGitSpec = `npm error command git --no-replace-objects ls-remote ssh://git@github.com/release-assets/${evidence.expectedArtifactName}.git`;
  if (
    !evidence.jobLog.includes(`ARTIFACT: release-assets/${evidence.expectedArtifactName}`)
    || !evidence.jobLog.includes("npm error code 128")
    || !evidence.jobLog.includes(expectedGitSpec)
    || !evidence.jobLog.includes("npm error git@github.com: Permission denied (publickey).")
    || !evidence.jobLog.includes("##[error]Process completed with exit code 128.")
    || evidence.jobLog.includes("npm notice Publishing to https://registry.npmjs.org")
  ) fail("JOB_LOG_NOT_PRE_REGISTRY_SPEC_FAILURE");
}
