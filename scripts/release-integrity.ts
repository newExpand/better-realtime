import { createHash } from "node:crypto";

export const publicReleaseIdentitySchemaVersion = "better-realtime.release-identity.v1" as const;

export interface PublicReleaseIdentity {
  schemaVersion: typeof publicReleaseIdentitySchemaVersion;
  package: { name: "better-realtime"; version: string };
  packageSource: { repository: "newExpand/better-realtime"; commit: string; tag: string; annotatedTagObject: string };
  workflow: {
    repository: "newExpand/better-realtime";
    path: ".github/workflows/release.yml";
    ref: "refs/heads/main";
    commit: string;
    runId: string;
    runAttempt: string;
    environment: "npm-alpha";
  };
  githubRelease: { id: number; tag: string; artifactAsset: { name: string; sha256: string; size: number } };
  artifact: { name: string; sha256: string; sha512: string; integrity: string; size: number; fileCount: number };
  npmRegistry: {
    tarball: string;
    sha256: string;
    sha512: string;
    integrity: string;
    size: number;
    fileCount: number;
    distTags: { alpha: string; latest: string };
  };
  evidence: {
    generatedAt: string;
    verification: { status: "prepublication-approved" | "verified"; checks: string[] };
  };
}

const forbiddenPublicKeys = new Set([
  "privateRepository",
  "privateSource",
  "privateCommit",
  "privateTag",
  "privateTagObject",
  "localPath",
  "threadId",
  "credential",
  "token",
]);
const requiredChecks = [
  "package-source-tag",
  "reviewed-workflow-revision",
  "approved-artifact",
  "github-asset-bytes",
  "npm-registry-bytes",
] as const;
const forbiddenPublicValueFragments = [
  ["realtime", "-runtime"].join(""),
  ["source", "-export/"].join(""),
  ["docs", "/internal/"].join(""),
  ["/Users", "/"].join(""),
  [".serena", "/"].join(""),
];

function fail(code: string): never {
  throw new Error(`RT_RELEASE_INTEGRITY_${code}`);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function string(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(code);
  return Number(value);
}

export function validatePublicReleaseIdentity(value: unknown): PublicReleaseIdentity {
  const root = record(value, "INVALID_ROOT");
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (forbiddenPublicKeys.has(key) || forbiddenPublicValueFragments.some((fragment) => String(child).includes(fragment))) fail("PRIVATE_DATA");
      visit(child);
    }
  };
  visit(root);
  exactKeys(root, ["schemaVersion", "package", "packageSource", "workflow", "githubRelease", "artifact", "npmRegistry", "evidence"], "ROOT_KEYS");
  if (root.schemaVersion !== publicReleaseIdentitySchemaVersion) fail("SCHEMA_VERSION");

  const pkg = record(root.package, "PACKAGE");
  exactKeys(pkg, ["name", "version"], "PACKAGE_KEYS");
  if (pkg.name !== "better-realtime") fail("PACKAGE_NAME");
  const version = string(pkg.version, /^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u, "VERSION");
  const tag = `v${version}`;
  const artifactName = `better-realtime-${version}.tgz`;

  const source = record(root.packageSource, "PACKAGE_SOURCE");
  exactKeys(source, ["repository", "commit", "tag", "annotatedTagObject"], "PACKAGE_SOURCE_KEYS");
  if (source.repository !== "newExpand/better-realtime" || source.tag !== tag) fail("PACKAGE_SOURCE_IDENTITY");
  string(source.commit, /^[a-f0-9]{40}$/u, "PACKAGE_SOURCE_COMMIT");
  string(source.annotatedTagObject, /^[a-f0-9]{40}$/u, "PACKAGE_TAG_OBJECT");

  const workflow = record(root.workflow, "WORKFLOW");
  exactKeys(workflow, ["repository", "path", "ref", "commit", "runId", "runAttempt", "environment"], "WORKFLOW_KEYS");
  if (workflow.repository !== "newExpand/better-realtime" || workflow.path !== ".github/workflows/release.yml" || workflow.ref !== "refs/heads/main" || workflow.environment !== "npm-alpha") fail("WORKFLOW_IDENTITY");
  string(workflow.commit, /^[a-f0-9]{40}$/u, "WORKFLOW_COMMIT");
  string(workflow.runId, /^[1-9][0-9]*$/u, "WORKFLOW_RUN");
  string(workflow.runAttempt, /^[1-9][0-9]*$/u, "WORKFLOW_ATTEMPT");

  const release = record(root.githubRelease, "GITHUB_RELEASE");
  exactKeys(release, ["id", "tag", "artifactAsset"], "GITHUB_RELEASE_KEYS");
  positiveInteger(release.id, "RELEASE_ID");
  if (release.tag !== tag) fail("RELEASE_TAG");

  const artifact = record(root.artifact, "ARTIFACT");
  exactKeys(artifact, ["name", "sha256", "sha512", "integrity", "size", "fileCount"], "ARTIFACT_KEYS");
  if (artifact.name !== artifactName) fail("ARTIFACT_NAME");
  const sha256 = string(artifact.sha256, /^[a-f0-9]{64}$/u, "SHA256");
  const sha512 = string(artifact.sha512, /^[a-f0-9]{128}$/u, "SHA512");
  const integrity = string(artifact.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, "INTEGRITY");
  const size = positiveInteger(artifact.size, "SIZE");
  const fileCount = positiveInteger(artifact.fileCount, "FILE_COUNT");
  if (`sha512-${Buffer.from(sha512, "hex").toString("base64")}` !== integrity) fail("INTEGRITY_MISMATCH");

  const asset = record(release.artifactAsset, "GITHUB_ASSET");
  exactKeys(asset, ["name", "sha256", "size"], "GITHUB_ASSET_KEYS");
  if (asset.name !== artifactName || asset.sha256 !== sha256 || asset.size !== size) fail("GITHUB_ASSET_MISMATCH");

  const registry = record(root.npmRegistry, "NPM_REGISTRY");
  exactKeys(registry, ["tarball", "sha256", "sha512", "integrity", "size", "fileCount", "distTags"], "NPM_REGISTRY_KEYS");
  if (registry.tarball !== `https://registry.npmjs.org/better-realtime/-/${artifactName}` || registry.sha256 !== sha256 || registry.sha512 !== sha512 || registry.integrity !== integrity || registry.size !== size || registry.fileCount !== fileCount) fail("NPM_ARTIFACT_MISMATCH");
  const distTags = record(registry.distTags, "DIST_TAGS");
  exactKeys(distTags, ["alpha", "latest"], "DIST_TAG_KEYS");
  if (distTags.alpha !== version || typeof distTags.latest !== "string" || !/^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u.test(distTags.latest)) fail("DIST_TAG_MISMATCH");

  const evidence = record(root.evidence, "EVIDENCE");
  exactKeys(evidence, ["generatedAt", "verification"], "EVIDENCE_KEYS");
  const generatedAt = string(evidence.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u, "GENERATED_AT");
  if (!Number.isFinite(Date.parse(generatedAt))) fail("GENERATED_AT");
  const verification = record(evidence.verification, "VERIFICATION");
  exactKeys(verification, ["status", "checks"], "VERIFICATION_KEYS");
  if (!["prepublication-approved", "verified"].includes(String(verification.status))) fail("VERIFICATION_STATUS");
  const checks = verification.checks;
  if (!Array.isArray(checks) || checks.some((check) => typeof check !== "string") || requiredChecks.some((check) => !checks.includes(check)) || new Set(checks).size !== checks.length) fail("VERIFICATION_CHECKS");

  return value as PublicReleaseIdentity;
}

export function deterministicReleaseIdentityJson(value: unknown): string {
  return `${JSON.stringify(validatePublicReleaseIdentity(value), null, 2)}\n`;
}

export function artifactDigests(bytes: Uint8Array): { sha256: string; sha512: string; integrity: string } {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  return { sha256, sha512, integrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}` };
}

export function verifyPublicReleaseIdentityBytes(
  identityValue: unknown,
  githubAsset: Uint8Array,
  npmTarball: Uint8Array,
): PublicReleaseIdentity {
  const identity = validatePublicReleaseIdentity(identityValue);
  const github = artifactDigests(githubAsset);
  const npm = artifactDigests(npmTarball);
  if (Buffer.compare(githubAsset, npmTarball) !== 0) fail("REGISTRY_BYTE_MISMATCH");
  if (github.sha256 !== identity.artifact.sha256 || github.sha512 !== identity.artifact.sha512 || github.integrity !== identity.artifact.integrity || githubAsset.byteLength !== identity.artifact.size) fail("ARTIFACT_BYTES_MISMATCH");
  if (npm.sha256 !== identity.npmRegistry.sha256 || npm.sha512 !== identity.npmRegistry.sha512 || npm.integrity !== identity.npmRegistry.integrity || npmTarball.byteLength !== identity.npmRegistry.size) fail("NPM_BYTES_MISMATCH");
  return identity;
}

export function verifyPublicReleaseIdentityBindings(
  identityValue: unknown,
  expected: {
    packageSourceCommit: string;
    annotatedTagObject: string;
    workflowCommit: string;
    workflowRunId: string;
    workflowRunAttempt: string;
    releaseId: number;
  },
): PublicReleaseIdentity {
  const identity = validatePublicReleaseIdentity(identityValue);
  if (
    identity.packageSource.commit !== expected.packageSourceCommit
    || identity.packageSource.annotatedTagObject !== expected.annotatedTagObject
    || identity.workflow.commit !== expected.workflowCommit
    || identity.workflow.runId !== expected.workflowRunId
    || identity.workflow.runAttempt !== expected.workflowRunAttempt
    || identity.githubRelease.id !== expected.releaseId
  ) fail("BINDING_MISMATCH");
  return identity;
}
