import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  assertReleaseBundleIdentity,
  releaseBundleIdentityDigest,
  type ApprovedPackageRelease,
  type ApprovedReleaseBundle,
  type ReleasePackageName,
} from "./release-bundle-state-machine.ts";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`RT_RELEASE_BUNDLE_ENV_REQUIRED:${name}`);
  return value;
};
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

async function packageIdentity(
  packageName: ReleasePackageName,
  prefix: "BASE" | "MCP",
  expectedEnvironment: "npm-alpha" | "npm-mcp-alpha",
): Promise<ApprovedPackageRelease> {
  const artifactPath = resolve(required(`RELEASE_${prefix}_ARTIFACT`));
  const checksumPath = resolve(required(`RELEASE_${prefix}_CHECKSUM`));
  const manifestPath = resolve(required(`RELEASE_${prefix}_FILE_MANIFEST`));
  const [artifact, checksum, manifestText] = await Promise.all([
    readFile(artifactPath),
    readFile(checksumPath),
    readFile(manifestPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as { files?: unknown };
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.some((file) => typeof file !== "string")) {
    throw new Error(`RT_RELEASE_BUNDLE_FILE_MANIFEST_INVALID:${packageName}`);
  }
  const expectedSha256 = required(`RELEASE_${prefix}_EXPECTED_SHA256`);
  const expectedSize = Number(required(`RELEASE_${prefix}_EXPECTED_SIZE`));
  const expectedUnpackedSize = Number(required(`RELEASE_${prefix}_EXPECTED_UNPACKED_SIZE`));
  if (
    sha256(artifact) !== expectedSha256
    || artifact.byteLength !== expectedSize
    || !Number.isSafeInteger(expectedUnpackedSize)
    || expectedUnpackedSize <= 0
  ) {
    throw new Error(`RT_RELEASE_BUNDLE_APPROVAL_MISMATCH:${packageName}`);
  }
  const expectedChecksum = `${expectedSha256}  ${basename(artifactPath)}\n`;
  if (checksum.toString("utf8") !== expectedChecksum) throw new Error(`RT_RELEASE_BUNDLE_CHECKSUM_MISMATCH:${packageName}`);
  return {
    name: packageName,
    artifact: { name: basename(artifactPath), sha256: expectedSha256, size: expectedSize },
    checksum: { name: basename(checksumPath), sha256: sha256(checksum), size: checksum.byteLength },
    packageFiles: manifest.files.length,
    unpackedSize: expectedUnpackedSize,
    npmEnvironment: expectedEnvironment,
  };
}

const version = required("RELEASE_VERSION");
const notes = await readFile(resolve(required("RELEASE_NOTES")));
const identity: ApprovedReleaseBundle = {
  schemaVersion: "better-realtime.release-bundle.v1",
  repository: "newExpand/better-realtime",
  version,
  sourceSha: required("RELEASE_SOURCE_SHA"),
  tag: `v${version}`,
  tagMessage: `Better Realtime ${version}`,
  title: `Better Realtime ${version}`,
  bodySha256: sha256(notes),
  packages: [
    await packageIdentity("better-realtime", "BASE", "npm-alpha"),
    await packageIdentity("better-realtime-mcp", "MCP", "npm-mcp-alpha"),
  ],
};
assertReleaseBundleIdentity(identity);
releaseBundleIdentityDigest(identity, 1);
await writeFile(resolve(required("RELEASE_BUNDLE_IDENTITY_OUTPUT")), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
