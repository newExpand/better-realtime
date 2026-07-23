import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { releaseIdentityDigest, type ApprovedReleaseIdentity } from "./release-state-machine.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`RT_RELEASE_IDENTITY_ENV_REQUIRED:${name}`);
  return value;
}

const version = required("RELEASE_VERSION");
const sourceSha = required("RELEASE_SOURCE_SHA");
const artifactPath = resolve(required("RELEASE_ARTIFACT"));
const checksumPath = resolve(required("RELEASE_CHECKSUM"));
const notesPath = resolve(required("RELEASE_NOTES"));
const outputPath = resolve(required("RELEASE_IDENTITY_OUTPUT"));
const manifestPath = resolve(process.env.RELEASE_PACKAGE_MANIFEST ?? "release/package-files.json");

const [artifact, checksum, notes, manifestText] = await Promise.all([
  readFile(artifactPath), readFile(checksumPath), readFile(notesPath), readFile(manifestPath, "utf8"),
]);
const manifest = JSON.parse(manifestText) as { files: string[] };
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const identity: ApprovedReleaseIdentity = {
  repository: "newExpand/better-realtime",
  version,
  sourceSha,
  tag: `v${version}`,
  tagMessage: `Better Realtime ${version}`,
  title: `Better Realtime ${version}`,
  bodySha256: hash(notes),
  artifact: { name: artifactPath.split("/").at(-1)!, sha256: hash(artifact), size: artifact.byteLength },
  checksum: { name: checksumPath.split("/").at(-1)!, sha256: hash(checksum), size: checksum.byteLength },
  packageFiles: manifest.files.length,
};
releaseIdentityDigest(identity, 1);
if (identity.artifact.sha256 !== required("RELEASE_EXPECTED_SHA256") || identity.artifact.size !== Number(required("RELEASE_EXPECTED_SIZE"))) throw new Error("RT_RELEASE_IDENTITY_APPROVAL_MISMATCH");
await writeFile(outputPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
