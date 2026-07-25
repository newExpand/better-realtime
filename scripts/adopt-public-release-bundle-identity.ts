import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { assertReleaseBundleIdentity, type ApprovedReleaseBundle } from "./release-bundle-state-machine.ts";

export function adoptPublicReleaseBundleIdentity(
  base: ApprovedReleaseBundle,
  bytes: Uint8Array,
  tagObject: string,
  releaseId: number,
  workflowSha: string,
): ApprovedReleaseBundle {
  assertReleaseBundleIdentity(base);
  if (base.publicIdentity) throw new Error("RT_RELEASE_BUNDLE_ADOPT_BASE_ALREADY_ENRICHED");
  const publicIdentity = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
    schemaVersion?: unknown;
    repository?: unknown;
    version?: unknown;
    packageSource?: { commit?: unknown; tag?: unknown; annotatedTagObject?: unknown };
    workflow?: { repository?: unknown; path?: unknown; ref?: unknown; commit?: unknown; runId?: unknown; runAttempt?: unknown };
    githubRelease?: { id?: unknown; tag?: unknown };
    packages?: Array<{
      name?: unknown;
      version?: unknown;
      artifact?: { name?: unknown; sha256?: unknown; sha512?: unknown; integrity?: unknown; size?: unknown; unpackedSize?: unknown; fileCount?: unknown };
      githubAsset?: { name?: unknown; sha256?: unknown; size?: unknown };
      expectedNpmRegistry?: {
        tarball?: unknown;
        sha256?: unknown;
        sha512?: unknown;
        integrity?: unknown;
        size?: unknown;
        fileCount?: unknown;
        distTags?: { alpha?: unknown; latest?: unknown; bootstrap?: unknown };
      };
      environment?: unknown;
    }>;
    evidence?: { verification?: { status?: unknown; checks?: unknown } };
  };
  const expectedChecks = [
    "package-source-tag",
    "reviewed-workflow-revision",
    "approved-package-artifacts",
    "github-draft-assets-approved",
  ];
  if (
    publicIdentity.schemaVersion !== "better-realtime.public-release-bundle.v1"
    || publicIdentity.repository !== base.repository
    || publicIdentity.version !== base.version
    || publicIdentity.packageSource?.commit !== base.sourceSha
    || publicIdentity.packageSource.tag !== base.tag
    || publicIdentity.packageSource.annotatedTagObject !== tagObject
    || publicIdentity.workflow?.repository !== base.repository
    || publicIdentity.workflow.path !== ".github/workflows/release-bundle.yml"
    || publicIdentity.workflow.ref !== "refs/heads/main"
    || publicIdentity.workflow.commit !== workflowSha
    || typeof publicIdentity.workflow.runId !== "string"
    || !/^[1-9][0-9]*$/u.test(publicIdentity.workflow.runId)
    || typeof publicIdentity.workflow.runAttempt !== "string"
    || !/^[1-9][0-9]*$/u.test(publicIdentity.workflow.runAttempt)
    || publicIdentity.githubRelease?.id !== releaseId
    || publicIdentity.githubRelease.tag !== base.tag
    || publicIdentity.packages?.length !== base.packages.length
    || publicIdentity.evidence?.verification?.status !== "prepublication-approved"
    || JSON.stringify(publicIdentity.evidence.verification.checks) !== JSON.stringify(expectedChecks)
  ) throw new Error("RT_RELEASE_BUNDLE_ADOPT_PUBLIC_IDENTITY_MISMATCH");
  for (const [index, approvedPackage] of base.packages.entries()) {
    const observed = publicIdentity.packages[index];
    const expectedTarball = `https://registry.npmjs.org/${approvedPackage.name}/-/${approvedPackage.artifact.name}`;
    if (
      observed?.name !== approvedPackage.name
      || observed.version !== base.version
      || observed.artifact?.name !== approvedPackage.artifact.name
      || observed.artifact.sha256 !== approvedPackage.artifact.sha256
      || typeof observed.artifact.sha512 !== "string"
      || !/^[a-f0-9]{128}$/u.test(observed.artifact.sha512)
      || observed.artifact.integrity !== `sha512-${Buffer.from(observed.artifact.sha512, "hex").toString("base64")}`
      || observed.artifact.size !== approvedPackage.artifact.size
      || observed.artifact.unpackedSize !== approvedPackage.unpackedSize
      || observed.artifact.fileCount !== approvedPackage.packageFiles
      || observed.githubAsset?.name !== approvedPackage.artifact.name
      || observed.githubAsset.sha256 !== approvedPackage.artifact.sha256
      || observed.githubAsset.size !== approvedPackage.artifact.size
      || observed.expectedNpmRegistry?.tarball !== expectedTarball
      || observed.expectedNpmRegistry.sha256 !== approvedPackage.artifact.sha256
      || observed.expectedNpmRegistry.sha512 !== observed.artifact.sha512
      || observed.expectedNpmRegistry.integrity !== observed.artifact.integrity
      || observed.expectedNpmRegistry.size !== approvedPackage.artifact.size
      || observed.expectedNpmRegistry.fileCount !== approvedPackage.packageFiles
      || observed.expectedNpmRegistry.distTags?.alpha !== base.version
      || (observed.expectedNpmRegistry.distTags.latest !== null
        && (typeof observed.expectedNpmRegistry.distTags.latest !== "string"
          || !/^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u.test(observed.expectedNpmRegistry.distTags.latest)))
      || (approvedPackage.name === "better-realtime-mcp"
        ? observed.expectedNpmRegistry.distTags.bootstrap !== "0.0.0-bootstrap.0"
        : Object.hasOwn(observed.expectedNpmRegistry.distTags, "bootstrap"))
      || observed.environment !== approvedPackage.npmEnvironment
    ) throw new Error(`RT_RELEASE_BUNDLE_ADOPT_PACKAGE_MISMATCH:${approvedPackage.name}`);
  }
  const enriched: ApprovedReleaseBundle = {
    ...base,
    publicIdentity: {
      name: `better-realtime-${base.version}.bundle.identity.json`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    },
  };
  assertReleaseBundleIdentity(enriched);
  return enriched;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`RT_RELEASE_BUNDLE_ADOPT_ENV_REQUIRED:${name}`);
  return value;
};

async function main(): Promise<void> {
  const base = JSON.parse(await readFile(resolve(required("RELEASE_BUNDLE_BASE_IDENTITY")), "utf8")) as ApprovedReleaseBundle;
  const bytes = await readFile(resolve(required("RELEASE_PUBLIC_BUNDLE_IDENTITY")));
  const enriched = adoptPublicReleaseBundleIdentity(
    base,
    bytes,
    required("RELEASE_TAG_OBJECT"),
    Number(required("RELEASE_ID")),
    required("RELEASE_WORKFLOW_SHA"),
  );
  await writeFile(resolve(required("RELEASE_BUNDLE_ENRICHED_IDENTITY_OUTPUT")), `${JSON.stringify(enriched, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) await main();
