import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { artifactDigests } from "./release-integrity.ts";

const packageNames = ["better-realtime", "better-realtime-mcp"] as const;
type PackageName = (typeof packageNames)[number];

interface ExpectedPackage {
  name: PackageName;
  artifactPath: string;
  checksumPath: string;
  manifestPath: string;
  sha256: string;
  packedSize: number;
  unpackedSize: number;
  fileCount: number;
  latest: string | null;
  environment: "npm-alpha" | "npm-mcp-alpha";
}

export interface ExpectedPublicReleaseBundle {
  version: string;
  sourceSha: string;
  workflowSha: string;
  tag: string;
  tagObject: string;
  releaseId: number;
  evidenceGeneratedAt: string;
  packages: [ExpectedPackage, ExpectedPackage];
}

interface TarballInspection {
  files: string[];
  unpackedSize: number;
  packageJson: Record<string, unknown>;
}

function fail(code: string): never {
  throw new Error(`RT_PUBLIC_RELEASE_BUNDLE_VERIFY_${code}`);
}

function text(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.slice(start, start + length);
  const end = slice.indexOf(0);
  return Buffer.from(end < 0 ? slice : slice.slice(0, end)).toString("utf8");
}

function inspectTarball(bytes: Uint8Array): TarballInspection {
  const tar = new Uint8Array(gunzipSync(bytes));
  const files = new Map<string, Uint8Array>();
  let unpackedSize = 0;
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.slice(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = text(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) fail("TARBALL_HEADER_INVALID");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.byteLength) fail("TARBALL_TRUNCATED");
    if (type === "0") {
      if (!path.startsWith("package/")) fail("TARBALL_PATH_INVALID");
      const relative = path.slice("package/".length);
      if (!relative || relative.startsWith("/") || relative.split("/").includes("..") || files.has(relative)) fail("TARBALL_PATH_INVALID");
      files.set(relative, tar.slice(contentStart, contentEnd));
      unpackedSize += size;
    } else if (!["5", "x", "g"].includes(type)) {
      fail("TARBALL_ENTRY_TYPE_UNSUPPORTED");
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  const manifestBytes = files.get("package.json");
  if (!manifestBytes) fail("PACKAGE_MANIFEST_MISSING");
  let packageJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("PACKAGE_MANIFEST_INVALID");
    packageJson = parsed as Record<string, unknown>;
  } catch {
    fail("PACKAGE_MANIFEST_INVALID");
  }
  return { files: [...files.keys()].sort(), unpackedSize, packageJson };
}

export async function verifyPublicReleaseBundle(
  identityValue: unknown,
  expected: ExpectedPublicReleaseBundle,
): Promise<{ packages: Array<{ name: PackageName; sha256: string; sha512: string; integrity: string; files: number; unpackedSize: number }> }> {
  const evidenceDate = new Date(expected.evidenceGeneratedAt);
  if (
    !/^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u.test(expected.version)
    || expected.tag !== `v${expected.version}`
    || !/^[a-f0-9]{40}$/u.test(expected.sourceSha)
    || !/^[a-f0-9]{40}$/u.test(expected.workflowSha)
    || !/^[a-f0-9]{40}$/u.test(expected.tagObject)
    || !Number.isSafeInteger(expected.releaseId)
    || expected.releaseId <= 0
    || !Number.isFinite(evidenceDate.valueOf())
    || evidenceDate.toISOString() !== expected.evidenceGeneratedAt
  ) fail("EXPECTATION_INVALID");
  const schema = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "release/public-release-bundle.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, formats: { "date-time": true } }).compile(schema);
  if (!validate(identityValue)) fail(`SCHEMA_INVALID:${JSON.stringify(validate.errors)}`);
  const identity = identityValue as {
    schemaVersion: string;
    repository: string;
    version: string;
    packageSource: { commit: string; tag: string; annotatedTagObject: string };
    workflow: { repository: string; path: string; ref: string; commit: string };
    githubRelease: { id: number; tag: string };
    packages: Array<{
      name: PackageName;
      version: string;
      artifact: { name: string; sha256: string; sha512: string; integrity: string; size: number; unpackedSize: number; fileCount: number };
      githubAsset: { name: string; sha256: string; size: number };
      expectedNpmRegistry: {
        tarball: string;
        sha256: string;
        sha512: string;
        integrity: string;
        size: number;
        fileCount: number;
        distTags: { alpha: string; latest: string | null };
      };
      environment: "npm-alpha" | "npm-mcp-alpha";
    }>;
    evidence: { generatedAt: string; verification: { status: string; checks: string[] } };
  };
  const expectedChecks = [
    "package-source-tag",
    "reviewed-workflow-revision",
    "approved-package-artifacts",
    "github-draft-assets-approved",
  ];
  if (
    identity.repository !== "newExpand/better-realtime"
    || identity.version !== expected.version
    || identity.packageSource.commit !== expected.sourceSha
    || identity.packageSource.tag !== expected.tag
    || identity.packageSource.annotatedTagObject !== expected.tagObject
    || identity.workflow.repository !== identity.repository
    || identity.workflow.path !== ".github/workflows/release-bundle.yml"
    || identity.workflow.ref !== "refs/heads/main"
    || identity.workflow.commit !== expected.workflowSha
    || identity.githubRelease.id !== expected.releaseId
    || identity.githubRelease.tag !== expected.tag
    || identity.evidence.generatedAt !== expected.evidenceGeneratedAt
    || identity.evidence.verification.status !== "prepublication-approved"
    || JSON.stringify(identity.evidence.verification.checks) !== JSON.stringify(expectedChecks)
  ) fail("IDENTITY_MISMATCH");

  const reports: Array<{ name: PackageName; sha256: string; sha512: string; integrity: string; files: number; unpackedSize: number }> = [];
  for (const [index, expectedPackage] of expected.packages.entries()) {
    const observed = identity.packages[index];
    if (!observed || observed.name !== expectedPackage.name || observed.version !== expected.version || observed.environment !== expectedPackage.environment) {
      fail(`PACKAGE_IDENTITY_MISMATCH:${expectedPackage.name}`);
    }
    const [artifact, checksum, manifestValue] = await Promise.all([
      readFile(resolve(expectedPackage.artifactPath)),
      readFile(resolve(expectedPackage.checksumPath), "utf8"),
      readFile(resolve(expectedPackage.manifestPath), "utf8").then((value) => JSON.parse(value) as { package?: unknown; files?: unknown }),
    ]);
    const digests = artifactDigests(artifact);
    const inspection = inspectTarball(artifact);
    if (
      digests.sha256 !== expectedPackage.sha256
      || artifact.byteLength !== expectedPackage.packedSize
      || inspection.unpackedSize !== expectedPackage.unpackedSize
      || inspection.files.length !== expectedPackage.fileCount
      || inspection.packageJson.name !== expectedPackage.name
      || inspection.packageJson.version !== expected.version
      || manifestValue.package !== expectedPackage.name
      || !Array.isArray(manifestValue.files)
      || JSON.stringify([...manifestValue.files].sort()) !== JSON.stringify(inspection.files)
      || checksum !== `${expectedPackage.sha256}  ${basename(expectedPackage.artifactPath)}\n`
    ) fail(`PACKAGE_BYTES_MISMATCH:${expectedPackage.name}`);
    const artifactName = `${expectedPackage.name}-${expected.version}.tgz`;
    const registryUrl = `https://registry.npmjs.org/${expectedPackage.name}/-/${artifactName}`;
    if (
      observed.artifact.name !== artifactName
      || observed.artifact.sha256 !== digests.sha256
      || observed.artifact.sha512 !== digests.sha512
      || observed.artifact.integrity !== digests.integrity
      || observed.artifact.size !== artifact.byteLength
      || observed.artifact.unpackedSize !== inspection.unpackedSize
      || observed.artifact.fileCount !== inspection.files.length
      || observed.githubAsset.name !== artifactName
      || observed.githubAsset.sha256 !== digests.sha256
      || observed.githubAsset.size !== artifact.byteLength
      || observed.expectedNpmRegistry.tarball !== registryUrl
      || observed.expectedNpmRegistry.sha256 !== digests.sha256
      || observed.expectedNpmRegistry.sha512 !== digests.sha512
      || observed.expectedNpmRegistry.integrity !== digests.integrity
      || observed.expectedNpmRegistry.size !== artifact.byteLength
      || observed.expectedNpmRegistry.fileCount !== inspection.files.length
      || observed.expectedNpmRegistry.distTags.alpha !== expected.version
      || observed.expectedNpmRegistry.distTags.latest !== expectedPackage.latest
    ) fail(`PUBLIC_PACKAGE_RECORD_MISMATCH:${expectedPackage.name}`);
    reports.push({ name: expectedPackage.name, ...digests, files: inspection.files.length, unpackedSize: inspection.unpackedSize });
  }
  return { packages: reports };
}

function required(argumentsMap: Map<string, string>, name: string): string {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`RT_PUBLIC_RELEASE_BUNDLE_VERIFY_ARGUMENT_MISSING:${name}`);
  return value;
}

function positive(argumentsMap: Map<string, string>, name: string): number {
  const value = Number(required(argumentsMap, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`RT_PUBLIC_RELEASE_BUNDLE_VERIFY_ARGUMENT_INVALID:${name}`);
  return value;
}

async function main(): Promise<void> {
  const argumentsMap = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("RT_PUBLIC_RELEASE_BUNDLE_VERIFY_ARGUMENT_INVALID");
    argumentsMap.set(key.slice(2), value);
  }
  const latest = (name: string): string | null => {
    const value = required(argumentsMap, name);
    return value === "absent" ? null : value;
  };
  const expected: ExpectedPublicReleaseBundle = {
    version: required(argumentsMap, "version"),
    sourceSha: required(argumentsMap, "source-sha"),
    workflowSha: required(argumentsMap, "workflow-sha"),
    tag: required(argumentsMap, "tag"),
    tagObject: required(argumentsMap, "tag-object"),
    releaseId: positive(argumentsMap, "release-id"),
    evidenceGeneratedAt: required(argumentsMap, "evidence-generated-at"),
    packages: [
      {
        name: "better-realtime",
        artifactPath: required(argumentsMap, "base-artifact"),
        checksumPath: required(argumentsMap, "base-checksum"),
        manifestPath: required(argumentsMap, "base-manifest"),
        sha256: required(argumentsMap, "base-sha256"),
        packedSize: positive(argumentsMap, "base-size"),
        unpackedSize: positive(argumentsMap, "base-unpacked-size"),
        fileCount: positive(argumentsMap, "base-files"),
        latest: latest("base-latest"),
        environment: "npm-alpha",
      },
      {
        name: "better-realtime-mcp",
        artifactPath: required(argumentsMap, "mcp-artifact"),
        checksumPath: required(argumentsMap, "mcp-checksum"),
        manifestPath: required(argumentsMap, "mcp-manifest"),
        sha256: required(argumentsMap, "mcp-sha256"),
        packedSize: positive(argumentsMap, "mcp-size"),
        unpackedSize: positive(argumentsMap, "mcp-unpacked-size"),
        fileCount: positive(argumentsMap, "mcp-files"),
        latest: latest("mcp-latest"),
        environment: "npm-mcp-alpha",
      },
    ],
  };
  const identity = JSON.parse(await readFile(resolve(required(argumentsMap, "identity")), "utf8"));
  process.stdout.write(`${JSON.stringify(await verifyPublicReleaseBundle(identity, expected))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
