import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { artifactDigests } from "./release-integrity.ts";
import {
  assertReleaseBundleIdentity,
  type ApprovedReleaseBundle,
  type ReleasePackageName,
} from "./release-bundle-state-machine.ts";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`RT_PUBLIC_RELEASE_BUNDLE_ENV_REQUIRED:${name}`);
  return value;
};

const baseIdentityPath = resolve(required("RELEASE_BUNDLE_BASE_IDENTITY"));
const approved = JSON.parse(await readFile(baseIdentityPath, "utf8")) as ApprovedReleaseBundle;
assertReleaseBundleIdentity(approved);
if (approved.publicIdentity) throw new Error("RT_PUBLIC_RELEASE_BUNDLE_ALREADY_ENRICHED");
const evidenceGeneratedAt = required("RELEASE_EVIDENCE_GENERATED_AT");
const evidenceDate = new Date(evidenceGeneratedAt);
if (!Number.isFinite(evidenceDate.valueOf()) || evidenceDate.toISOString() !== evidenceGeneratedAt) {
  throw new Error("RT_PUBLIC_RELEASE_BUNDLE_EVIDENCE_TIME_INVALID");
}

async function packageRecord(packageName: ReleasePackageName, pathEnvironment: string, latestEnvironment: string) {
  const artifactPath = resolve(required(pathEnvironment));
  const bytes = new Uint8Array(await readFile(artifactPath));
  const approvedPackage = approved.packages.find(({ name }) => name === packageName);
  if (!approvedPackage) throw new Error(`RT_PUBLIC_RELEASE_BUNDLE_PACKAGE_MISSING:${packageName}`);
  const digests = artifactDigests(bytes);
  const expectedLatest = required(latestEnvironment);
  if (expectedLatest !== "absent" && !/^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u.test(expectedLatest)) {
    throw new Error(`RT_PUBLIC_RELEASE_BUNDLE_DIST_TAG_INVALID:${packageName}:latest`);
  }
  if (
    basename(artifactPath) !== approvedPackage.artifact.name
    || bytes.byteLength !== approvedPackage.artifact.size
    || digests.sha256 !== approvedPackage.artifact.sha256
  ) throw new Error(`RT_PUBLIC_RELEASE_BUNDLE_ARTIFACT_MISMATCH:${packageName}`);
  const escapedName = packageName.replace("/", "%2f");
  const distTags = packageName === "better-realtime-mcp"
    ? { alpha: approved.version, latest: expectedLatest === "absent" ? null : expectedLatest, bootstrap: "0.0.0-bootstrap.0" }
    : { alpha: approved.version, latest: expectedLatest === "absent" ? null : expectedLatest };
  return {
    name: packageName,
    version: approved.version,
    artifact: { name: approvedPackage.artifact.name, ...digests, size: bytes.byteLength, unpackedSize: approvedPackage.unpackedSize, fileCount: approvedPackage.packageFiles },
    githubAsset: { name: approvedPackage.artifact.name, sha256: digests.sha256, size: bytes.byteLength },
    expectedNpmRegistry: {
      tarball: `https://registry.npmjs.org/${escapedName}/-/${approvedPackage.artifact.name}`,
      ...digests,
      size: bytes.byteLength,
      fileCount: approvedPackage.packageFiles,
      distTags,
    },
    environment: approvedPackage.npmEnvironment,
  };
}

const publicIdentity = {
  schemaVersion: "better-realtime.public-release-bundle.v1",
  repository: approved.repository,
  version: approved.version,
  packageSource: {
    commit: approved.sourceSha,
    tag: approved.tag,
    annotatedTagObject: required("RELEASE_TAG_OBJECT"),
  },
  workflow: {
    repository: approved.repository,
    path: ".github/workflows/release-bundle.yml",
    ref: "refs/heads/main",
    commit: required("RELEASE_WORKFLOW_SHA"),
    runId: required("RELEASE_RUN_ID"),
    runAttempt: required("RELEASE_RUN_ATTEMPT"),
  },
  githubRelease: { id: Number(required("RELEASE_ID")), tag: approved.tag },
  packages: [
    await packageRecord("better-realtime", "RELEASE_BASE_ARTIFACT", "RELEASE_BASE_EXPECTED_LATEST"),
    await packageRecord("better-realtime-mcp", "RELEASE_MCP_ARTIFACT", "RELEASE_MCP_EXPECTED_LATEST"),
  ],
  evidence: {
    generatedAt: evidenceGeneratedAt,
    verification: {
      status: "prepublication-approved",
      checks: [
        "package-source-tag",
        "reviewed-workflow-revision",
        "approved-package-artifacts",
        "github-draft-assets-approved",
      ],
    },
  },
};
if (!Number.isSafeInteger(publicIdentity.githubRelease.id) || publicIdentity.githubRelease.id <= 0) throw new Error("RT_PUBLIC_RELEASE_BUNDLE_RELEASE_ID_INVALID");
const output = `${JSON.stringify(publicIdentity, null, 2)}\n`;
const outputPath = resolve(required("RELEASE_PUBLIC_BUNDLE_IDENTITY_OUTPUT"));
await writeFile(outputPath, output, { flag: "wx" });
const enriched: ApprovedReleaseBundle = {
  ...approved,
  publicIdentity: {
    name: `better-realtime-${approved.version}.bundle.identity.json`,
    sha256: createHash("sha256").update(output).digest("hex"),
    size: Buffer.byteLength(output),
  },
};
assertReleaseBundleIdentity(enriched);
await writeFile(resolve(required("RELEASE_BUNDLE_ENRICHED_IDENTITY_OUTPUT")), `${JSON.stringify(enriched, null, 2)}\n`, { flag: "wx" });
