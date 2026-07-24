import { describe, expect, it } from "vitest";
import {
  planReleaseBundleTransition,
  releaseBundleIdentityDigest,
  type ApprovedReleaseBundle,
  type ObservedReleaseBundleState,
  type ObservedBundleRelease,
} from "../scripts/release-bundle-state-machine.ts";

const sha = (character: string): string => character.repeat(64);
const sourceSha = "a".repeat(40);
const identity: ApprovedReleaseBundle = {
  schemaVersion: "better-realtime.release-bundle.v1",
  repository: "newExpand/better-realtime",
  version: "0.2.0-alpha.1",
  sourceSha,
  tag: "v0.2.0-alpha.1",
  tagMessage: "Better Realtime 0.2.0-alpha.1",
  title: "Better Realtime 0.2.0-alpha.1",
  bodySha256: sha("b"),
  packages: [
    {
      name: "better-realtime",
      artifact: { name: "better-realtime-0.2.0-alpha.1.tgz", sha256: sha("c"), size: 100 },
      checksum: { name: "better-realtime-0.2.0-alpha.1.tgz.sha256", sha256: sha("d"), size: 100 },
      packageFiles: 32,
      unpackedSize: 200,
      npmEnvironment: "npm-alpha",
    },
    {
      name: "better-realtime-mcp",
      artifact: { name: "better-realtime-mcp-0.2.0-alpha.1.tgz", sha256: sha("e"), size: 50 },
      checksum: { name: "better-realtime-mcp-0.2.0-alpha.1.tgz.sha256", sha256: sha("f"), size: 104 },
      packageFiles: 11,
      unpackedSize: 80,
      npmEnvironment: "npm-mcp-alpha",
    },
  ],
  publicIdentity: { name: "better-realtime-0.2.0-alpha.1.bundle.identity.json", sha256: sha("1"), size: 1_000 },
};

const release = (overrides: Partial<ObservedBundleRelease> = {}): ObservedBundleRelease => ({
  id: 77,
  tag: identity.tag,
  target: sourceSha,
  title: identity.title,
  bodySha256: identity.bodySha256,
  draft: false,
  prerelease: true,
  immutable: true,
  assets: [
    ...identity.packages.flatMap(({ artifact, checksum }, packageIndex) =>
      [artifact, checksum].map((asset, assetIndex) => ({ id: 10 + packageIndex * 2 + assetIndex, ...asset, state: "uploaded" as const })),
    ),
    { id: 14, ...identity.publicIdentity!, state: "uploaded" },
  ],
  ...overrides,
});

const state = (overrides: Partial<ObservedReleaseBundleState> = {}): ObservedReleaseBundleState => ({
  tag: { state: "exact", objectSha: "2".repeat(40), targetSha: sourceSha },
  releases: [release()],
  npm: { "better-realtime": { state: "absent" }, "better-realtime-mcp": { state: "absent" } },
  publishIntents: { "better-realtime": { state: "absent" }, "better-realtime-mcp": { state: "absent" } },
  verification: { "better-realtime": "incomplete", "better-realtime-mcp": "incomplete" },
  ...overrides,
});

const intentValue = () => ({
    state: "present" as const,
    runId: "10",
    runAttempt: "1",
    releaseId: 77,
    identityDigest: releaseBundleIdentityDigest(identity, 77),
});
const intent = (packageName: "better-realtime" | "better-realtime-mcp") => ({ [packageName]: intentValue() });

describe("two-package release bundle state machine", () => {
  it("requires every approved asset before immutable finalization", () => {
    const missingMcp = release({ draft: true, immutable: false, assets: release().assets.filter(({ name }) => !name.startsWith("better-realtime-mcp-")) });
    expect(planReleaseBundleTransition(identity, state({ releases: [missingMcp] }))).toMatchObject({
      action: "upload_asset",
      assetName: "better-realtime-mcp-0.2.0-alpha.1.tgz",
    });
  });

  it("fails closed when an annotated tag provider reports a lightweight or wrong-message tag", () => {
    expect(() => planReleaseBundleTransition(identity, state({ tag: { state: "mismatch", reason: "lightweight tag" } }))).toThrow("RT_RELEASE_BUNDLE_STATE_TAG_MISMATCH");
    expect(() => planReleaseBundleTransition(identity, state({ tag: { state: "mismatch", reason: "annotated tag identity" } }))).toThrow("RT_RELEASE_BUNDLE_STATE_TAG_MISMATCH");
  });

  it("allows the canonical public identity to be re-adopted without weakening other asset names", () => {
    const baseIdentity = structuredClone(identity);
    delete baseIdentity.publicIdentity;
    expect(planReleaseBundleTransition(baseIdentity, state())).toMatchObject({ action: "mark_package_publish_intent", packageName: "better-realtime" });
    expect(() => planReleaseBundleTransition(baseIdentity, state({
      releases: [release({ assets: [...release().assets, { id: 99, name: "unexpected.txt", sha256: sha("9"), size: 1, state: "uploaded" }] })],
    }))).toThrow("RT_RELEASE_BUNDLE_STATE_UNEXPECTED_ASSET");
  });

  it("publishes packages in the approved order and never repeats an exact publication", () => {
    expect(planReleaseBundleTransition(identity, state())).toMatchObject({ action: "mark_package_publish_intent", packageName: "better-realtime" });
    const baseExact = state({
      npm: {
        "better-realtime": { state: "exact", sha256: identity.packages[0].artifact.sha256, size: identity.packages[0].artifact.size },
        "better-realtime-mcp": { state: "absent" },
      },
      publishIntents: { ...state().publishIntents, ...intent("better-realtime") },
    });
    expect(planReleaseBundleTransition(identity, baseExact)).toMatchObject({ action: "verify_package_only", packageName: "better-realtime" });
    expect(planReleaseBundleTransition(identity, { ...baseExact, verification: { ...baseExact.verification, "better-realtime": "complete" } })).toMatchObject({
      action: "mark_package_publish_intent",
      packageName: "better-realtime-mcp",
    });
  });

  it("detects and safely resumes one-package partial success", () => {
    const partial = state({
      npm: {
        "better-realtime": { state: "exact", sha256: identity.packages[0].artifact.sha256, size: identity.packages[0].artifact.size },
        "better-realtime-mcp": { state: "absent" },
      },
      publishIntents: { ...state().publishIntents, ...intent("better-realtime") },
      verification: { "better-realtime": "complete", "better-realtime-mcp": "incomplete" },
    });
    expect(planReleaseBundleTransition(identity, partial)).toMatchObject({ action: "mark_package_publish_intent", packageName: "better-realtime-mcp" });
  });

  it("uses verification-only after a package is visible and polls a transient E404", () => {
    const basePublished = {
      npm: {
        "better-realtime": { state: "exact" as const, sha256: identity.packages[0].artifact.sha256, size: identity.packages[0].artifact.size },
        "better-realtime-mcp": { state: "absent" as const },
      },
      publishIntents: { ...state().publishIntents, ...intent("better-realtime") },
    };
    expect(planReleaseBundleTransition(identity, state(basePublished))).toMatchObject({ action: "verify_package_only", packageName: "better-realtime" });
    expect(planReleaseBundleTransition(identity, state({
      npm: { ...basePublished.npm, "better-realtime": { state: "transient_e404" } },
      publishIntents: basePublished.publishIntents,
    }))).toMatchObject({ action: "poll_package_registry", packageName: "better-realtime" });
  });

  it("fails closed on mismatched package bytes, intent, or untracked publication", () => {
    expect(() => planReleaseBundleTransition(identity, state({
      npm: {
        "better-realtime": { state: "exact", sha256: sha("9"), size: identity.packages[0].artifact.size },
        "better-realtime-mcp": { state: "absent" },
      },
      publishIntents: { ...state().publishIntents, ...intent("better-realtime") },
    }))).toThrow("RT_RELEASE_BUNDLE_STATE_NPM_ARTIFACT_MISMATCH:better-realtime");
    expect(() => planReleaseBundleTransition(identity, state({
      npm: {
        "better-realtime": { state: "exact", sha256: identity.packages[0].artifact.sha256, size: identity.packages[0].artifact.size },
        "better-realtime-mcp": { state: "absent" },
      },
    }))).toThrow("RT_RELEASE_BUNDLE_STATE_PUBLISHED_WITHOUT_INTENT:better-realtime");
    expect(() => planReleaseBundleTransition(identity, state({
      publishIntents: {
        ...state().publishIntents,
        "better-realtime": { ...intentValue(), identityDigest: "br-release-bundle-v1-" + sha("9") },
      },
    }))).toThrow("RT_RELEASE_BUNDLE_STATE_PUBLISH_INTENT_MISMATCH:better-realtime");
  });

  it("blocks an ambiguous absent result after an intent instead of republishing", () => {
    expect(planReleaseBundleTransition(identity, state({
      publishIntents: { ...state().publishIntents, ...intent("better-realtime") },
    }))).toMatchObject({ action: "block_ambiguous_publish", packageName: "better-realtime" });
  });

  it("completes only after both packages are exact and independently verified", () => {
    expect(planReleaseBundleTransition(identity, state({
      npm: {
        "better-realtime": { state: "exact", sha256: identity.packages[0].artifact.sha256, size: identity.packages[0].artifact.size },
        "better-realtime-mcp": { state: "exact", sha256: identity.packages[1].artifact.sha256, size: identity.packages[1].artifact.size },
      },
      publishIntents: {
        "better-realtime": intentValue(),
        "better-realtime-mcp": intentValue(),
      },
      verification: { "better-realtime": "complete", "better-realtime-mcp": "complete" },
    }))).toMatchObject({ action: "complete" });
  });
});
