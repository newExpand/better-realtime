import { expect, it } from "vitest";
import {
  assertLocalArtifactSpecFailureEvidence,
  resolvePublishIntentLedger,
  type PublishCheckRun,
} from "../scripts/release-publish-recovery.ts";

const version = "0.1.0-alpha.4";
const sourceSha = "a".repeat(40);
const identityDigest = `br-release-v1-${"b".repeat(64)}`;

function check(name: string, overrides: Partial<PublishCheckRun> = {}): PublishCheckRun {
  return {
    id: 1,
    name,
    external_id: identityDigest,
    head_sha: sourceSha,
    ...overrides,
  };
}

it("closes exactly one proven local-spec failure without deleting its publish intent", () => {
  const prior = check(`publish-intent/${version}/30007435675/1`);
  const abort = check(`publish-abort/${version}/30007435675/1`, { id: 2 });
  expect(resolvePublishIntentLedger([prior, abort], version, sourceSha, identityDigest)).toEqual({
    active: undefined,
    aborted: [{ runId: "30007435675", runAttempt: "1" }],
  });

  const retry = check(`publish-intent/${version}/30010000000/1`, { id: 3 });
  expect(resolvePublishIntentLedger([prior, abort, retry], version, sourceSha, identityDigest)).toEqual({
    active: { runId: "30010000000", runAttempt: "1" },
    aborted: [{ runId: "30007435675", runAttempt: "1" }],
  });
});

it("fails closed on an unpaired, mismatched, or multiply active abort ledger", () => {
  const prior = check(`publish-intent/${version}/30007435675/1`);
  expect(() => resolvePublishIntentLedger(
    [check(`publish-abort/${version}/30007435675/1`)],
    version,
    sourceSha,
    identityDigest,
  )).toThrow("RT_RELEASE_RECOVERY_ABORT_WITHOUT_INTENT");
  expect(() => resolvePublishIntentLedger(
    [prior, check(`publish-abort/${version}/30007435675/1`, { external_id: `br-release-v1-${"c".repeat(64)}` })],
    version,
    sourceSha,
    identityDigest,
  )).toThrow("RT_RELEASE_RECOVERY_MARKER_IDENTITY_MISMATCH");
  expect(() => resolvePublishIntentLedger(
    [prior, check(`publish-intent/${version}/30010000000/1`)],
    version,
    sourceSha,
    identityDigest,
  )).toThrow("RT_RELEASE_RECOVERY_MULTIPLE_ACTIVE_INTENTS");
});

it("accepts only the exact failed local tarball-spec workflow boundary", () => {
  const evidence = {
    expectedRunId: "30007435675",
    expectedRunAttempt: "1",
    expectedArtifactName: "better-realtime-0.1.0-alpha.4.tgz",
    run: {
      id: 30007435675,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: ".github/workflows/release.yml",
      head_sha: "7".repeat(40),
      status: "completed",
      conclusion: "failure",
    },
    jobs: [{
      id: 89207470903,
      name: "publish",
      status: "completed",
      conclusion: "failure",
      steps: [
        { name: "Validate the approved identity without repository code", status: "completed", conclusion: "success" },
        { name: "Re-observe publication state at the OIDC boundary", status: "completed", conclusion: "success" },
        { name: "Record durable publish intent at the OIDC boundary", status: "completed", conclusion: "success" },
        { name: "publish_once through npm Trusted Publishing", status: "completed", conclusion: "failure" },
        { name: "Export the publication identity for verification", status: "completed", conclusion: "skipped" },
      ],
    }],
    workflowSource: [
      'test "$(npm --version)" = 11.16.0',
      "ARTIFACT: release-assets/${{ needs.build.outputs.artifact }}",
      'npm publish "$ARTIFACT" --tag alpha --access public --provenance --ignore-scripts',
    ].join("\n"),
    jobLog: [
      "ARTIFACT: release-assets/better-realtime-0.1.0-alpha.4.tgz",
      "npm error code 128",
      "npm error command git --no-replace-objects ls-remote ssh://git@github.com/release-assets/better-realtime-0.1.0-alpha.4.tgz.git",
      "npm error git@github.com: Permission denied (publickey).",
      "##[error]Process completed with exit code 128.",
    ].join("\n"),
  };
  expect(() => assertLocalArtifactSpecFailureEvidence(evidence)).not.toThrow();
  expect(() => assertLocalArtifactSpecFailureEvidence({
    ...evidence,
    workflowSource: evidence.workflowSource.replace("ARTIFACT: release-assets/", "ARTIFACT: ${{ github.workspace }}/release-assets/"),
  })).toThrow("RT_RELEASE_RECOVERY_WORKFLOW_NOT_VULNERABLE");
  expect(() => assertLocalArtifactSpecFailureEvidence({
    ...evidence,
    jobs: [{ ...evidence.jobs[0]!, steps: evidence.jobs[0]!.steps.map((step) => step.name.startsWith("publish_once") ? { ...step, conclusion: "success" } : step) }],
  })).toThrow("RT_RELEASE_RECOVERY_PUBLISH_STEP_NOT_FAILED");
  expect(() => assertLocalArtifactSpecFailureEvidence({
    ...evidence,
    jobLog: evidence.jobLog.replace("npm error code 128", "npm notice Publishing to https://registry.npmjs.org"),
  })).toThrow("RT_RELEASE_RECOVERY_JOB_LOG_NOT_PRE_REGISTRY_SPEC_FAILURE");
});
