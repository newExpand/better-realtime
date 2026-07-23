import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { artifactDigests, deterministicReleaseIdentityJson, type PublicReleaseIdentity } from "./release-integrity.ts";
import type { ApprovedReleaseIdentity } from "./release-state-machine.ts";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`RT_RELEASE_INTEGRITY_ENV_REQUIRED:${name}`);
  return value;
};

const artifactPath = resolve(required("RELEASE_ARTIFACT"));
const bytes = new Uint8Array(await readFile(artifactPath));
const version = required("RELEASE_VERSION");
const name = `better-realtime-${version}.tgz`;
const size = Number(required("RELEASE_EXPECTED_SIZE"));
const fileCount = Number(required("RELEASE_FILE_COUNT"));
const digests = artifactDigests(bytes);
if (bytes.byteLength !== size || digests.sha256 !== required("RELEASE_EXPECTED_SHA256")) throw new Error("RT_RELEASE_INTEGRITY_APPROVED_ARTIFACT_MISMATCH");

const identity: PublicReleaseIdentity = {
  schemaVersion: "better-realtime.release-identity.v1",
  package: { name: "better-realtime", version },
  packageSource: {
    repository: "newExpand/better-realtime",
    commit: required("RELEASE_SOURCE_SHA"),
    tag: `v${version}`,
    annotatedTagObject: required("RELEASE_TAG_OBJECT"),
  },
  workflow: {
    repository: "newExpand/better-realtime",
    path: ".github/workflows/release.yml",
    ref: "refs/heads/main",
    commit: required("RELEASE_WORKFLOW_SHA"),
    runId: required("RELEASE_RUN_ID"),
    runAttempt: required("RELEASE_RUN_ATTEMPT"),
    environment: "npm-alpha",
  },
  githubRelease: {
    id: Number(required("RELEASE_ID")),
    tag: `v${version}`,
    artifactAsset: { name, sha256: digests.sha256, size },
  },
  artifact: { name, ...digests, size, fileCount },
  npmRegistry: {
    tarball: `https://registry.npmjs.org/better-realtime/-/${name}`,
    ...digests,
    size,
    fileCount,
    distTags: { alpha: version, latest: required("RELEASE_EXPECTED_LATEST") },
  },
  evidence: {
    generatedAt: required("RELEASE_EVIDENCE_GENERATED_AT"),
    verification: {
      status: "prepublication-approved",
      checks: ["package-source-tag", "reviewed-workflow-revision", "approved-artifact", "github-asset-bytes", "npm-registry-bytes"],
    },
  },
};

const publicIdentityPath = resolve(required("RELEASE_PUBLIC_IDENTITY_OUTPUT"));
const publicIdentityJson = deterministicReleaseIdentityJson(identity);
await writeFile(publicIdentityPath, publicIdentityJson, { flag: "wx" });

const baseIdentityPath = process.env.RELEASE_BASE_IDENTITY?.trim();
const enrichedOutput = process.env.RELEASE_ENRICHED_IDENTITY_OUTPUT?.trim();
if ((baseIdentityPath && !enrichedOutput) || (!baseIdentityPath && enrichedOutput)) throw new Error("RT_RELEASE_INTEGRITY_ENRICHED_IDENTITY_ARGUMENT_MISMATCH");
if (baseIdentityPath && enrichedOutput) {
  const base = JSON.parse(await readFile(resolve(baseIdentityPath), "utf8")) as ApprovedReleaseIdentity;
  if (
    base.repository !== "newExpand/better-realtime"
    || base.version !== version
    || base.sourceSha !== identity.packageSource.commit
    || base.tag !== identity.packageSource.tag
    || base.artifact.name !== name
    || base.artifact.sha256 !== digests.sha256
    || base.artifact.size !== size
    || base.packageFiles !== fileCount
  ) throw new Error("RT_RELEASE_INTEGRITY_BASE_IDENTITY_MISMATCH");
  const enriched: ApprovedReleaseIdentity = {
    ...base,
    publicIdentity: {
      name: `${name.slice(0, -4)}.identity.json`,
      sha256: createHash("sha256").update(publicIdentityJson).digest("hex"),
      size: Buffer.byteLength(publicIdentityJson),
    },
  };
  await writeFile(resolve(enrichedOutput), `${JSON.stringify(enriched, null, 2)}\n`, { flag: "wx" });
}
