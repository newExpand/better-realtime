import { createHash } from "node:crypto";

export const releasePackageNames = ["better-realtime", "better-realtime-mcp"] as const;
export type ReleasePackageName = (typeof releasePackageNames)[number];

export interface ApprovedBundleAsset {
  name: string;
  sha256: string;
  size: number;
}

export interface ApprovedPackageRelease {
  name: ReleasePackageName;
  artifact: ApprovedBundleAsset;
  checksum: ApprovedBundleAsset;
  packageFiles: number;
  unpackedSize: number;
  npmEnvironment: "npm-alpha" | "npm-mcp-alpha";
}

export interface ApprovedReleaseBundle {
  schemaVersion: "better-realtime.release-bundle.v1";
  repository: "newExpand/better-realtime";
  version: string;
  sourceSha: string;
  tag: string;
  tagMessage: string;
  title: string;
  bodySha256: string;
  packages: [ApprovedPackageRelease, ApprovedPackageRelease];
  publicIdentity?: ApprovedBundleAsset;
}

export interface ObservedBundleAsset {
  id: number;
  name: string;
  sha256: string;
  size: number;
  state: "uploaded" | "starter";
}

export type BundleTagObservation =
  | { state: "absent" }
  | { state: "exact"; objectSha: string; targetSha: string }
  | { state: "mismatch"; reason: string };

export interface ObservedBundleRelease {
  id: number;
  tag: string;
  target: string;
  title: string;
  bodySha256: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  assets: ObservedBundleAsset[];
}

export type NpmPackageObservation =
  | { state: "absent" }
  | { state: "transient_e404" }
  | { state: "exact"; sha256: string; size: number }
  | { state: "indeterminate"; reason: string };

export type PackagePublishIntent =
  | { state: "absent" }
  | { state: "present"; runId: string; runAttempt: string; releaseId: number; identityDigest: string };

export interface ObservedReleaseBundleState {
  tag: BundleTagObservation;
  releases: ObservedBundleRelease[];
  npm: Record<ReleasePackageName, NpmPackageObservation>;
  publishIntents: Record<ReleasePackageName, PackagePublishIntent>;
  verification: Record<ReleasePackageName, "incomplete" | "complete">;
}

export type ReleaseBundleAction =
  | { action: "create_tag"; reason: string }
  | { action: "create_release"; reason: string }
  | { action: "upload_asset"; releaseId: number; assetName: string; reason: string }
  | { action: "finalize_release"; releaseId: number; reason: string }
  | { action: "wait_for_immutable"; releaseId: number; reason: string }
  | { action: "mark_package_publish_intent"; releaseId: number; packageName: ReleasePackageName; reason: string }
  | { action: "poll_package_registry"; releaseId: number; packageName: ReleasePackageName; reason: string }
  | { action: "verify_package_only"; releaseId: number; packageName: ReleasePackageName; reason: string }
  | { action: "block_ambiguous_publish"; releaseId: number; packageName: ReleasePackageName; reason: string }
  | { action: "complete"; releaseId: number; reason: string };

function fail(code: string): never {
  throw new Error(`RT_RELEASE_BUNDLE_STATE_${code}`);
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail("INVALID_DIGEST");
}

function assertAsset(asset: ApprovedBundleAsset): void {
  assertDigest(asset.sha256);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-z0-9.-]+$/u.test(asset.name)) fail("INVALID_ASSET");
}

export function assertReleaseBundleIdentity(identity: ApprovedReleaseBundle): void {
  if (
    identity.schemaVersion !== "better-realtime.release-bundle.v1"
    || identity.repository !== "newExpand/better-realtime"
    || !/^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u.test(identity.version)
    || identity.tag !== `v${identity.version}`
    || identity.tagMessage !== identity.title
    || !/^[a-f0-9]{40}$/u.test(identity.sourceSha)
  ) fail("INVALID_IDENTITY");
  assertDigest(identity.bodySha256);
  if (identity.packages.length !== releasePackageNames.length) fail("INVALID_PACKAGE_SET");
  for (const [index, packageName] of releasePackageNames.entries()) {
    const candidate = identity.packages[index];
    if (
      !candidate
      || candidate.name !== packageName
      || candidate.artifact.name !== `${packageName}-${identity.version}.tgz`
      || candidate.checksum.name !== `${candidate.artifact.name}.sha256`
      || candidate.npmEnvironment !== (packageName === "better-realtime" ? "npm-alpha" : "npm-mcp-alpha")
      || !Number.isSafeInteger(candidate.packageFiles)
      || candidate.packageFiles <= 0
      || !Number.isSafeInteger(candidate.unpackedSize)
      || candidate.unpackedSize <= 0
    ) fail("INVALID_PACKAGE_SET");
    assertAsset(candidate.artifact);
    assertAsset(candidate.checksum);
  }
  if (identity.publicIdentity) {
    if (identity.publicIdentity.name !== `better-realtime-${identity.version}.bundle.identity.json`) fail("INVALID_ASSET");
    assertAsset(identity.publicIdentity);
  }
}

export function releaseBundleIdentityDigest(identity: ApprovedReleaseBundle, releaseId: number): string {
  assertReleaseBundleIdentity(identity);
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) fail("INVALID_RELEASE_ID");
  const value = JSON.stringify([
    identity.schemaVersion,
    identity.repository,
    identity.version,
    identity.sourceSha,
    identity.tag,
    identity.tagMessage,
    identity.title,
    identity.bodySha256,
    identity.packages.map(({ name, artifact, checksum, packageFiles, unpackedSize, npmEnvironment }) => [
      name,
      artifact.name,
      artifact.sha256,
      artifact.size,
      checksum.name,
      checksum.sha256,
      checksum.size,
      packageFiles,
      unpackedSize,
      npmEnvironment,
    ]),
    identity.publicIdentity?.name ?? null,
    identity.publicIdentity?.sha256 ?? null,
    identity.publicIdentity?.size ?? null,
    releaseId,
  ]);
  return `br-release-bundle-v1-${createHash("sha256").update(value).digest("hex")}`;
}

function approvedAssets(identity: ApprovedReleaseBundle): ApprovedBundleAsset[] {
  return [
    ...identity.packages.flatMap(({ artifact, checksum }) => [artifact, checksum]),
    ...(identity.publicIdentity ? [identity.publicIdentity] : []),
  ];
}

function exactAsset(release: ObservedBundleRelease, expected: ApprovedBundleAsset): ObservedBundleAsset | undefined {
  const matches = release.assets.filter(({ name }) => name === expected.name);
  if (matches.length > 1) fail("DUPLICATE_ASSET");
  const match = matches[0];
  if (!match) return undefined;
  if (match.state !== "uploaded") fail("INCOMPLETE_ASSET");
  if (match.sha256 !== expected.sha256 || match.size !== expected.size) fail("ASSET_IDENTITY_MISMATCH");
  return match;
}

export function planReleaseBundleTransition(
  identity: ApprovedReleaseBundle,
  observed: ObservedReleaseBundleState,
): ReleaseBundleAction {
  assertReleaseBundleIdentity(identity);
  if (observed.tag.state === "mismatch") fail("TAG_MISMATCH");
  if (observed.tag.state === "absent") {
    const hasNpmState = releasePackageNames.some((name) => observed.npm[name].state !== "absent" || observed.publishIntents[name].state !== "absent");
    if (observed.releases.length > 0 || hasNpmState) fail("IMPOSSIBLE_ORDER");
    return { action: "create_tag", reason: "approved annotated tag is absent" };
  }
  if (observed.tag.targetSha !== identity.sourceSha) fail("TAG_TARGET_MISMATCH");
  if (observed.releases.length > 1) fail("AMBIGUOUS_RELEASE");
  const release = observed.releases[0];
  if (!release) {
    const hasNpmState = releasePackageNames.some((name) => observed.npm[name].state !== "absent" || observed.publishIntents[name].state !== "absent");
    if (hasNpmState) fail("IMPOSSIBLE_ORDER");
    return { action: "create_release", reason: "approved annotated tag exists without a release" };
  }
  if (
    release.tag !== identity.tag
    || release.target !== identity.sourceSha
    || release.title !== identity.title
    || release.bodySha256 !== identity.bodySha256
    || !release.prerelease
  ) fail("RELEASE_IDENTITY_MISMATCH");
  const assets = approvedAssets(identity);
  const allowedNames = new Set([
    ...assets.map(({ name }) => name),
    `better-realtime-${identity.version}.bundle.identity.json`,
  ]);
  if (release.assets.some(({ name }) => !allowedNames.has(name))) fail("UNEXPECTED_ASSET");
  if (release.draft) {
    if (release.immutable || releasePackageNames.some((name) => observed.npm[name].state !== "absent" || observed.publishIntents[name].state !== "absent")) fail("IMPOSSIBLE_ORDER");
    for (const asset of assets) {
      if (!exactAsset(release, asset)) {
        return { action: "upload_asset", releaseId: release.id, assetName: asset.name, reason: "an approved bundle asset is missing" };
      }
    }
    return { action: "finalize_release", releaseId: release.id, reason: "the complete approved bundle is ready to finalize" };
  }
  for (const asset of assets) if (!exactAsset(release, asset)) fail("FINAL_RELEASE_ASSET_MISMATCH");
  if (!release.immutable) {
    if (releasePackageNames.some((name) => observed.npm[name].state !== "absent" || observed.publishIntents[name].state !== "absent")) fail("IMPOSSIBLE_ORDER");
    return { action: "wait_for_immutable", releaseId: release.id, reason: "finalized release is awaiting immutable enforcement" };
  }

  const identityDigest = releaseBundleIdentityDigest(identity, release.id);
  for (const packageIdentity of identity.packages) {
    const packageName = packageIdentity.name;
    const npm = observed.npm[packageName];
    const intent = observed.publishIntents[packageName];
    if (npm.state === "indeterminate") fail(`NPM_INDETERMINATE:${packageName}`);
    if (intent.state === "present" && (intent.releaseId !== release.id || intent.identityDigest !== identityDigest)) fail(`PUBLISH_INTENT_MISMATCH:${packageName}`);
    if (npm.state === "transient_e404") {
      if (intent.state !== "present") fail(`NPM_ABSENCE_UNPROVEN:${packageName}`);
      return { action: "poll_package_registry", releaseId: release.id, packageName, reason: "registry convergence is pending for an attempted package" };
    }
    if (npm.state === "exact") {
      if (npm.sha256 !== packageIdentity.artifact.sha256 || npm.size !== packageIdentity.artifact.size) fail(`NPM_ARTIFACT_MISMATCH:${packageName}`);
      if (intent.state !== "present") fail(`PUBLISHED_WITHOUT_INTENT:${packageName}`);
      if (observed.verification[packageName] !== "complete") {
        return { action: "verify_package_only", releaseId: release.id, packageName, reason: "published package bytes exist; publication must not be repeated" };
      }
      continue;
    }
    if (intent.state === "present") {
      return { action: "block_ambiguous_publish", releaseId: release.id, packageName, reason: "publish intent exists while the registry version is absent" };
    }
    return { action: "mark_package_publish_intent", releaseId: release.id, packageName, reason: "the next unpublished package is approved for one publish attempt" };
  }
  return { action: "complete", releaseId: release.id, reason: "both package artifacts and verification records are complete" };
}
