import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePublicReleaseIdentity, verifyPublicReleaseIdentityBytes } from "./release-integrity.ts";
import type { ApprovedReleaseIdentity } from "./release-state-machine.ts";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`RT_RELEASE_INTEGRITY_ENV_REQUIRED:${name}`);
  return value;
};

const publicPath = resolve(required("RELEASE_PUBLIC_IDENTITY"));
const publicBytes = new Uint8Array(await readFile(publicPath));
const publicIdentity = validatePublicReleaseIdentity(JSON.parse(Buffer.from(publicBytes).toString("utf8")));
const artifactBytes = new Uint8Array(await readFile(resolve(required("RELEASE_ARTIFACT"))));
verifyPublicReleaseIdentityBytes(publicIdentity, artifactBytes, artifactBytes);
if (
  publicIdentity.packageSource.commit !== required("RELEASE_SOURCE_SHA")
  || publicIdentity.packageSource.annotatedTagObject !== required("RELEASE_TAG_OBJECT")
  || publicIdentity.workflow.commit !== required("RELEASE_WORKFLOW_SHA")
  || publicIdentity.githubRelease.id !== Number(required("RELEASE_ID"))
) throw new Error("RT_RELEASE_INTEGRITY_EXISTING_BINDING_MISMATCH");

const base = JSON.parse(await readFile(resolve(required("RELEASE_BASE_IDENTITY")), "utf8")) as ApprovedReleaseIdentity;
if (
  base.repository !== publicIdentity.packageSource.repository
  || base.version !== publicIdentity.package.version
  || base.sourceSha !== publicIdentity.packageSource.commit
  || base.tag !== publicIdentity.packageSource.tag
  || base.artifact.name !== publicIdentity.artifact.name
  || base.artifact.sha256 !== publicIdentity.artifact.sha256
  || base.artifact.size !== publicIdentity.artifact.size
  || base.packageFiles !== publicIdentity.artifact.fileCount
) throw new Error("RT_RELEASE_INTEGRITY_BASE_IDENTITY_MISMATCH");

const enriched: ApprovedReleaseIdentity = {
  ...base,
  publicIdentity: {
    name: publicIdentity.artifact.name.replace(/\.tgz$/u, ".identity.json"),
    sha256: createHash("sha256").update(publicBytes).digest("hex"),
    size: publicBytes.byteLength,
  },
};
await writeFile(resolve(required("RELEASE_ENRICHED_IDENTITY_OUTPUT")), `${JSON.stringify(enriched, null, 2)}\n`, { flag: "wx" });
