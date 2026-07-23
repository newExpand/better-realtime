export interface ApprovedAssetIdentity {
  name: string;
  sha256: string;
  size: number;
}

export interface ApprovedReleaseIdentity {
  repository: string;
  version: string;
  sourceSha: string;
  tag: string;
  tagMessage: string;
  title: string;
  bodySha256: string;
  artifact: ApprovedAssetIdentity;
  checksum: ApprovedAssetIdentity;
  packageFiles: number;
}

export type TagObservation =
  | { state: "absent" }
  | { state: "exact"; objectSha: string; targetSha: string }
  | { state: "mismatch"; reason: string };

export interface ObservedAsset {
  id: number;
  name: string;
  sha256: string;
  size: number;
  state: "uploaded" | "starter";
}

export interface ObservedRelease {
  id: number;
  tag: string;
  target: string;
  title: string;
  bodySha256: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  assets: ObservedAsset[];
}

export type NpmObservation =
  | { state: "absent" }
  | { state: "transient_e404" }
  | { state: "exact"; sha256: string; size: number }
  | { state: "indeterminate"; reason: string };

export interface ObservedReleaseState {
  tag: TagObservation;
  releases: ObservedRelease[];
  npm: NpmObservation;
  publishIntent: { state: "absent" } | { state: "present"; runId: string; runAttempt: string; releaseId: number; identityDigest: string };
  verification: { state: "incomplete" } | { state: "complete" };
}

export type ReleaseAction =
  | "create_tag"
  | "create_release"
  | "upload_artifact"
  | "upload_checksum"
  | "finalize_release"
  | "wait_for_immutable"
  | "mark_publish_intent"
  | "publish_once"
  | "poll_registry"
  | "verify_only"
  | "complete"
  | "block_ambiguous_publish";

export interface ReleasePlan {
  action: ReleaseAction;
  releaseId?: number;
  reason: string;
}

export interface ReleaseProvider {
  observe(identity: ApprovedReleaseIdentity): Promise<ObservedReleaseState>;
  apply(action: Exclude<ReleaseAction, "complete" | "verify_only" | "poll_registry" | "block_ambiguous_publish" | "wait_for_immutable">, identity: ApprovedReleaseIdentity, state: ObservedReleaseState): Promise<void>;
}

type MutationAction = Parameters<ReleaseProvider["apply"]>[0];
const mutationActions = new Set<ReleaseAction>(["create_tag", "create_release", "upload_artifact", "upload_checksum", "finalize_release", "mark_publish_intent", "publish_once"]);
const preservedReleaseVersions = new Set(["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.3"]);

function isMutationAction(action: ReleaseAction): action is MutationAction {
  return mutationActions.has(action);
}

function fail(code: string): never {
  throw new Error(`RT_RELEASE_STATE_${code}`);
}

export function assertReleaseIdentityMutable(identity: ApprovedReleaseIdentity): void {
  if (preservedReleaseVersions.has(identity.version)) fail("PRESERVED_IDENTITY_MUTATION_FORBIDDEN");
}

function assertIdentity(identity: ApprovedReleaseIdentity): void {
  if (!/^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u.test(identity.version)) fail("INVALID_VERSION");
  if (identity.tag !== `v${identity.version}` || identity.tagMessage !== identity.title) fail("INVALID_RELEASE_IDENTITY");
  if (!/^[a-f0-9]{40}$/u.test(identity.sourceSha)) fail("INVALID_SOURCE_SHA");
  for (const value of [identity.bodySha256, identity.artifact.sha256, identity.checksum.sha256]) if (!/^[a-f0-9]{64}$/u.test(value)) fail("INVALID_DIGEST");
  if (!Number.isSafeInteger(identity.artifact.size) || identity.artifact.size <= 0 || !Number.isSafeInteger(identity.checksum.size) || identity.checksum.size <= 0) fail("INVALID_SIZE");
  if (!Number.isSafeInteger(identity.packageFiles) || identity.packageFiles <= 0) fail("INVALID_FILE_COUNT");
  if (identity.artifact.name !== `better-realtime-${identity.version}.tgz` || identity.checksum.name !== `${identity.artifact.name}.sha256`) fail("INVALID_ASSET_NAME");
}

export function releaseIdentityDigest(identity: ApprovedReleaseIdentity, releaseId = 42): string {
  assertIdentity(identity);
  const value = JSON.stringify([
    identity.repository,
    identity.version,
    identity.sourceSha,
    identity.tag,
    identity.tagMessage,
    identity.title,
    identity.bodySha256,
    identity.artifact.name,
    identity.artifact.sha256,
    identity.artifact.size,
    identity.checksum.name,
    identity.checksum.sha256,
    identity.checksum.size,
    identity.packageFiles,
    releaseId,
  ]);
  return `br-release-v1-${createHash("sha256").update(value).digest("hex")}`;
}

function exactAsset(release: ObservedRelease, expected: ApprovedAssetIdentity): ObservedAsset | undefined {
  const matches = release.assets.filter(({ name }) => name === expected.name);
  if (matches.length > 1) fail("DUPLICATE_ASSET");
  const match = matches[0];
  if (!match) return undefined;
  if (match.state !== "uploaded") fail("INCOMPLETE_ASSET");
  if (match.sha256 !== expected.sha256 || match.size !== expected.size) fail("ASSET_IDENTITY_MISMATCH");
  return match;
}

export function planReleaseTransition(identity: ApprovedReleaseIdentity, observed: ObservedReleaseState): ReleasePlan {
  assertIdentity(identity);
  if (observed.npm.state === "indeterminate") fail("NPM_INDETERMINATE");
  if (observed.npm.state === "transient_e404" && observed.publishIntent.state === "absent") fail("NPM_ABSENCE_UNPROVEN");
  if (observed.tag.state === "mismatch") fail("TAG_MISMATCH");
  if (observed.tag.state === "absent") {
    if (observed.releases.length > 0 || observed.npm.state === "exact" || observed.publishIntent.state === "present") fail("IMPOSSIBLE_ORDER");
    return { action: "create_tag", reason: "approved annotated tag is absent" };
  }
  if (observed.tag.targetSha !== identity.sourceSha) fail("TAG_TARGET_MISMATCH");
  if (observed.releases.length > 1) fail("AMBIGUOUS_RELEASE");
  const release = observed.releases[0];
  if (!release) {
    if (observed.npm.state === "exact" || observed.publishIntent.state === "present") fail("IMPOSSIBLE_ORDER");
    return { action: "create_release", reason: "approved annotated tag exists without a release" };
  }
  if (
    release.tag !== identity.tag
    || release.target !== identity.sourceSha
    || release.title !== identity.title
    || release.bodySha256 !== identity.bodySha256
    || !release.prerelease
  ) fail("RELEASE_IDENTITY_MISMATCH");
  if (observed.publishIntent.state === "present" && (observed.publishIntent.releaseId !== release.id || observed.publishIntent.identityDigest !== releaseIdentityDigest(identity, release.id))) fail("PUBLISH_INTENT_MISMATCH");
  const allowedNames = new Set([identity.artifact.name, identity.checksum.name]);
  if (release.assets.some(({ name }) => !allowedNames.has(name))) fail("UNEXPECTED_ASSET");
  const artifact = exactAsset(release, identity.artifact);
  const checksum = exactAsset(release, identity.checksum);
  if (release.draft) {
    if (release.immutable || observed.npm.state === "exact" || observed.publishIntent.state === "present") fail("IMPOSSIBLE_ORDER");
    if (!artifact) return { action: "upload_artifact", releaseId: release.id, reason: "approved package asset is missing" };
    if (!checksum) return { action: "upload_checksum", releaseId: release.id, reason: "approved checksum asset is missing" };
    return { action: "finalize_release", releaseId: release.id, reason: "asset-complete draft is ready to finalize" };
  }
  if (!artifact || !checksum) fail("FINAL_RELEASE_ASSET_MISMATCH");
  if (!release.immutable) {
    if (observed.npm.state === "exact" || observed.publishIntent.state === "present") fail("IMPOSSIBLE_ORDER");
    return { action: "wait_for_immutable", releaseId: release.id, reason: "finalized release is awaiting immutable enforcement" };
  }
  if (observed.npm.state === "transient_e404") {
    if (observed.publishIntent.state !== "present") fail("NPM_ABSENCE_UNPROVEN");
    return { action: "poll_registry", releaseId: release.id, reason: "publish intent exists while the registry converges" };
  }
  if (observed.npm.state === "exact") {
    if (observed.npm.sha256 !== identity.artifact.sha256 || observed.npm.size !== identity.artifact.size) fail("NPM_ARTIFACT_MISMATCH");
    if (observed.publishIntent.state !== "present") fail("PUBLISHED_WITHOUT_INTENT");
    return observed.verification.state === "complete"
      ? { action: "complete", releaseId: release.id, reason: "all approved identities are verified" }
      : { action: "verify_only", releaseId: release.id, reason: "published bytes exist; publication must not be repeated" };
  }
  if (observed.publishIntent.state === "present") {
    return { action: "block_ambiguous_publish", releaseId: release.id, reason: "publish intent exists but the registry version is absent" };
  }
  return { action: "mark_publish_intent", releaseId: release.id, reason: "immutable release is exact and no publish has been attempted" };
}

export async function reconcileReleaseState(
  identity: ApprovedReleaseIdentity,
  provider: ReleaseProvider,
  options: { stopAfterMutations?: number } = {},
): Promise<ReleasePlan> {
  assertReleaseIdentityMutable(identity);
  let mutations = 0;
  let intentCreatedInThisInvocation = false;
  while (true) {
    const state = await provider.observe(identity);
    const plan = planReleaseTransition(identity, state);
    if (plan.action === "block_ambiguous_publish" && intentCreatedInThisInvocation) {
      await provider.apply("publish_once", identity, state);
      return plan.releaseId === undefined
        ? { action: "publish_once", reason: "publish invoked once after recording durable intent; continue with observation only" }
        : { action: "publish_once", releaseId: plan.releaseId, reason: "publish invoked once after recording durable intent; continue with observation only" };
    }
    if (["complete", "verify_only", "poll_registry", "block_ambiguous_publish", "wait_for_immutable"].includes(plan.action)) return plan;
    if (!isMutationAction(plan.action)) fail("UNSUPPORTED_TRANSITION");
    await provider.apply(plan.action, identity, state);
    intentCreatedInThisInvocation = plan.action === "mark_publish_intent";
    mutations += 1;
    if (options.stopAfterMutations !== undefined && mutations >= options.stopAfterMutations) return plan;
  }
}
import { createHash } from "node:crypto";
