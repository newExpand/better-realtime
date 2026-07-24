import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { adoptPublicReleaseBundleIdentity } from "../scripts/adopt-public-release-bundle-identity.ts";
import { artifactDigests } from "../scripts/release-integrity.ts";
import { assertReleaseBundleIdentity, releaseBundleIdentityDigest, type ApprovedReleaseBundle } from "../scripts/release-bundle-state-machine.ts";
import { verifyPublicReleaseBundle, type ExpectedPublicReleaseBundle } from "../scripts/verify-public-release-bundle.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));
const sha = (character: string): string => character.repeat(64);

const identity = (): ApprovedReleaseBundle => ({
  schemaVersion: "better-realtime.release-bundle.v1",
  repository: "newExpand/better-realtime",
  version: "0.2.0-alpha.1",
  sourceSha: "a".repeat(40),
  tag: "v0.2.0-alpha.1",
  tagMessage: "Better Realtime 0.2.0-alpha.1",
  title: "Better Realtime 0.2.0-alpha.1",
  bodySha256: sha("b"),
  packages: [
    {
      name: "better-realtime",
      artifact: { name: "better-realtime-0.2.0-alpha.1.tgz", sha256: sha("c"), size: 1 },
      checksum: { name: "better-realtime-0.2.0-alpha.1.tgz.sha256", sha256: sha("d"), size: 100 },
      packageFiles: 32,
      unpackedSize: 2,
      npmEnvironment: "npm-alpha",
    },
    {
      name: "better-realtime-mcp",
      artifact: { name: "better-realtime-mcp-0.2.0-alpha.1.tgz", sha256: sha("e"), size: 1 },
      checksum: { name: "better-realtime-mcp-0.2.0-alpha.1.tgz.sha256", sha256: sha("f"), size: 104 },
      packageFiles: 11,
      unpackedSize: 2,
      npmEnvironment: "npm-mcp-alpha",
    },
  ],
});

describe("two-package release identity", () => {
  it("is deterministic and binds package order, bytes, manifests, environments, and Release ID", () => {
    const value = identity();
    const first = releaseBundleIdentityDigest(value, 17);
    expect(releaseBundleIdentityDigest(structuredClone(value), 17)).toBe(first);
    expect(releaseBundleIdentityDigest(value, 18)).not.toBe(first);
    const changed = structuredClone(value);
    changed.packages[1].artifact.sha256 = sha("9");
    expect(releaseBundleIdentityDigest(changed, 17)).not.toBe(first);
  });

  it("rejects package skew, swapped order, reused environment, and the wrong companion artifact", () => {
    const mutations: ApprovedReleaseBundle[] = [];
    const swapped = identity();
    swapped.packages.reverse();
    mutations.push(swapped);
    const reusedEnvironment = identity();
    reusedEnvironment.packages[1].npmEnvironment = "npm-alpha" as "npm-mcp-alpha";
    mutations.push(reusedEnvironment);
    const wrongName = identity();
    wrongName.packages[1].artifact.name = "better-realtime-0.2.0-alpha.1.tgz";
    mutations.push(wrongName);
    for (const mutation of mutations) expect(() => assertReleaseBundleIdentity(mutation)).toThrow(/RT_RELEASE_BUNDLE_STATE_/u);
  });

  it("validates positive and negative schema fixtures", async () => {
    const schema = JSON.parse(await readFile(resolve("release/public-release-bundle-identity.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(identity())).toBe(true);
    expect(validate({ ...identity(), privateRepository: "private/example" })).toBe(false);
  });

  it("creates both identities only from exact approved bytes and manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-bundle-identity-"));
    roots.push(root);
    const base = join(root, "better-realtime-0.2.0-alpha.1.tgz");
    const mcp = join(root, "better-realtime-mcp-0.2.0-alpha.1.tgz");
    const notes = join(root, "notes.md");
    const baseManifest = join(root, "base.json");
    const mcpManifest = join(root, "mcp.json");
    await Promise.all([
      writeFile(base, "base"),
      writeFile(mcp, "mcp"),
      writeFile(notes, "notes"),
      writeFile(baseManifest, JSON.stringify({ files: ["package.json"] })),
      writeFile(mcpManifest, JSON.stringify({ files: ["package.json", "dist/bin.js"] })),
    ]);
    const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
    await Promise.all([
      writeFile(`${base}.sha256`, `${digest("base")}  ${base.split("/").at(-1)}\n`),
      writeFile(`${mcp}.sha256`, `${digest("mcp")}  ${mcp.split("/").at(-1)}\n`),
    ]);
    const output = join(root, "identity.json");
    const command = [
      "RELEASE_VERSION=0.2.0-alpha.1",
      `RELEASE_SOURCE_SHA=${"a".repeat(40)}`,
      `RELEASE_NOTES=${notes}`,
      `RELEASE_BASE_ARTIFACT=${base}`,
      `RELEASE_BASE_CHECKSUM=${base}.sha256`,
      `RELEASE_BASE_FILE_MANIFEST=${baseManifest}`,
      `RELEASE_BASE_EXPECTED_SHA256=${digest("base")}`,
      "RELEASE_BASE_EXPECTED_SIZE=4",
      "RELEASE_BASE_EXPECTED_UNPACKED_SIZE=4",
      `RELEASE_MCP_ARTIFACT=${mcp}`,
      `RELEASE_MCP_CHECKSUM=${mcp}.sha256`,
      `RELEASE_MCP_FILE_MANIFEST=${mcpManifest}`,
      `RELEASE_MCP_EXPECTED_SHA256=${digest("mcp")}`,
      "RELEASE_MCP_EXPECTED_SIZE=3",
      "RELEASE_MCP_EXPECTED_UNPACKED_SIZE=3",
      `RELEASE_BUNDLE_IDENTITY_OUTPUT=${output}`,
      "pnpm exec tsx scripts/create-release-bundle-identity.ts",
    ].join(" ");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("bash", ["-lc", command], { cwd: resolve(".") });
    const created = JSON.parse(await readFile(output, "utf8")) as ApprovedReleaseBundle;
    expect(created.packages.map(({ name, packageFiles }) => [name, packageFiles])).toEqual([
      ["better-realtime", 1],
      ["better-realtime-mcp", 2],
    ]);
    const publicOutput = join(root, "public.json");
    const enrichedOutput = join(root, "enriched.json");
    const publicCommand = [
      `RELEASE_BUNDLE_BASE_IDENTITY=${output}`,
      `RELEASE_BASE_ARTIFACT=${base}`,
      `RELEASE_MCP_ARTIFACT=${mcp}`,
      `RELEASE_TAG_OBJECT=${"b".repeat(40)}`,
      `RELEASE_WORKFLOW_SHA=${"c".repeat(40)}`,
      "RELEASE_RUN_ID=123",
      "RELEASE_RUN_ATTEMPT=1",
      "RELEASE_ID=456",
      "RELEASE_BASE_EXPECTED_LATEST=0.1.0-alpha.4",
      "RELEASE_MCP_EXPECTED_LATEST=absent",
      "RELEASE_EVIDENCE_GENERATED_AT=2026-07-24T00:00:00.000Z",
      `RELEASE_PUBLIC_BUNDLE_IDENTITY_OUTPUT=${publicOutput}`,
      `RELEASE_BUNDLE_ENRICHED_IDENTITY_OUTPUT=${enrichedOutput}`,
      "pnpm exec tsx scripts/create-public-release-bundle-identity.ts",
    ].join(" ");
    await promisify(execFile)("bash", ["-lc", publicCommand], { cwd: resolve(".") });
    const publicBytes = await readFile(publicOutput);
    const publicIdentity = JSON.parse(publicBytes.toString("utf8")) as {
      packages: Array<{ artifact: { unpackedSize: number }; expectedNpmRegistry: { distTags: { latest: string | null } } }>;
      evidence: { verification: { checks: string[] } };
    };
    const publicSchema = JSON.parse(await readFile(resolve("release/public-release-bundle.schema.json"), "utf8"));
    const validatePublic = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, formats: {
      "date-time": true,
    } }).compile(publicSchema);
    expect(validatePublic(publicIdentity), JSON.stringify(validatePublic.errors)).toBe(true);
    expect(validatePublic({ ...publicIdentity, privateRepository: "private/example" })).toBe(false);
    expect(publicIdentity.packages.map(({ artifact }) => artifact.unpackedSize)).toEqual([4, 3]);
    expect(publicIdentity.packages.map(({ expectedNpmRegistry }) => expectedNpmRegistry.distTags.latest)).toEqual(["0.1.0-alpha.4", null]);
    expect(publicIdentity.evidence.verification.checks).not.toContain("npm-registry-byte-equality");
    expect(() => adoptPublicReleaseBundleIdentity(created, publicBytes, "b".repeat(40), 456, "d".repeat(40))).toThrow(
      "RT_RELEASE_BUNDLE_ADOPT_PUBLIC_IDENTITY_MISMATCH",
    );
    const enriched = JSON.parse(await readFile(enrichedOutput, "utf8")) as ApprovedReleaseBundle;
    expect(enriched.publicIdentity?.name).toBe("better-realtime-0.2.0-alpha.1.bundle.identity.json");
    const adoptedOutput = join(root, "adopted.json");
    await promisify(execFile)("bash", ["-lc", [
      `RELEASE_BUNDLE_BASE_IDENTITY=${output}`,
      `RELEASE_PUBLIC_BUNDLE_IDENTITY=${publicOutput}`,
      `RELEASE_TAG_OBJECT=${"b".repeat(40)}`,
      "RELEASE_ID=456",
      `RELEASE_WORKFLOW_SHA=${"c".repeat(40)}`,
      `RELEASE_BUNDLE_ENRICHED_IDENTITY_OUTPUT=${adoptedOutput}`,
      "pnpm exec tsx scripts/adopt-public-release-bundle-identity.ts",
    ].join(" ")], { cwd: resolve(".") });
    const adopted = JSON.parse(await readFile(adoptedOutput, "utf8")) as ApprovedReleaseBundle;
    expect(adopted).toEqual(enriched);
    expect(releaseBundleIdentityDigest(adopted, 456)).not.toBe(releaseBundleIdentityDigest(created, 456));
  });

  it("keeps immutable public evidence prepublication-honest", async () => {
    const generator = await readFile(resolve("scripts/create-public-release-bundle-identity.ts"), "utf8");
    expect(generator).toContain("expectedNpmRegistry");
    expect(generator).not.toMatch(/\bnpmRegistry:\s*\{/u);
    expect(generator).not.toContain('"npm-registry-byte-equality"');
    expect(generator).not.toContain('"per-package-provenance"');
    expect(generator).toContain('"github-draft-assets-approved"');
  });

  it("independently verifies the public identity, exact manifests, checksums and tarball metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-bundle-verifier-"));
    roots.push(root);
    const artifacts = join(root, "artifacts");
    await mkdir(artifacts);
    const version = "0.2.0-alpha.1";
    const createPackage = async (name: "better-realtime" | "better-realtime-mcp") => {
      const staging = join(root, name);
      await mkdir(staging);
      await Promise.all([
        writeFile(join(staging, "package.json"), `${JSON.stringify({ name, version, files: ["README.md", "LICENSE"] })}\n`),
        writeFile(join(staging, "README.md"), `${name}\n`),
        writeFile(join(staging, "LICENSE"), "MIT\n"),
      ]);
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const packed = await promisify(execFile)("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], { cwd: staging });
      const report = (JSON.parse(packed.stdout) as Array<{ filename: string; size: number; unpackedSize: number; files: Array<{ path: string }> }>)[0]!;
      const artifactPath = join(artifacts, report.filename);
      const bytes = await readFile(artifactPath);
      const digests = artifactDigests(bytes);
      const checksumPath = `${artifactPath}.sha256`;
      const manifestPath = join(root, `${name}.manifest.json`);
      await Promise.all([
        writeFile(checksumPath, `${digests.sha256}  ${report.filename}\n`),
        writeFile(manifestPath, `${JSON.stringify({ package: name, files: report.files.map(({ path }) => path).sort() })}\n`),
      ]);
      return { name, report, artifactPath, checksumPath, manifestPath, digests };
    };
    const [base, mcp] = await Promise.all([createPackage("better-realtime"), createPackage("better-realtime-mcp")]);
    const tag = `v${version}`;
    const sourceSha = "a".repeat(40);
    const workflowSha = "b".repeat(40);
    const tagObject = "c".repeat(40);
    const generatedAt = "2026-07-24T06:00:00.000Z";
    const packageRecord = (
      value: Awaited<ReturnType<typeof createPackage>>,
      environment: "npm-alpha" | "npm-mcp-alpha",
      latest: string | null,
    ) => ({
      name: value.name,
      version,
      artifact: {
        name: value.report.filename,
        ...value.digests,
        size: value.report.size,
        unpackedSize: value.report.unpackedSize,
        fileCount: value.report.files.length,
      },
      githubAsset: { name: value.report.filename, sha256: value.digests.sha256, size: value.report.size },
      expectedNpmRegistry: {
        tarball: `https://registry.npmjs.org/${value.name}/-/${value.report.filename}`,
        ...value.digests,
        size: value.report.size,
        fileCount: value.report.files.length,
        distTags: { alpha: version, latest },
      },
      environment,
    });
    const publicIdentity = {
      schemaVersion: "better-realtime.public-release-bundle.v1",
      repository: "newExpand/better-realtime",
      version,
      packageSource: { commit: sourceSha, tag, annotatedTagObject: tagObject },
      workflow: { repository: "newExpand/better-realtime", path: ".github/workflows/release-bundle.yml", ref: "refs/heads/main", commit: workflowSha, runId: "1", runAttempt: "1" },
      githubRelease: { id: 7, tag },
      packages: [packageRecord(base, "npm-alpha", "0.1.0-alpha.4"), packageRecord(mcp, "npm-mcp-alpha", null)],
      evidence: { generatedAt, verification: { status: "prepublication-approved", checks: ["package-source-tag", "reviewed-workflow-revision", "approved-package-artifacts", "github-draft-assets-approved"] } },
    };
    const packageExpectation = (
      value: Awaited<ReturnType<typeof createPackage>>,
      environment: "npm-alpha" | "npm-mcp-alpha",
      latest: string | null,
    ) => ({
      name: value.name,
      artifactPath: value.artifactPath,
      checksumPath: value.checksumPath,
      manifestPath: value.manifestPath,
      sha256: value.digests.sha256,
      packedSize: value.report.size,
      unpackedSize: value.report.unpackedSize,
      fileCount: value.report.files.length,
      latest,
      environment,
    });
    const expected = {
      version,
      sourceSha,
      workflowSha,
      tag,
      tagObject,
      releaseId: 7,
      evidenceGeneratedAt: generatedAt,
      packages: [
        packageExpectation(base, "npm-alpha", "0.1.0-alpha.4"),
        packageExpectation(mcp, "npm-mcp-alpha", null),
      ],
    } as ExpectedPublicReleaseBundle;
    await expect(verifyPublicReleaseBundle(publicIdentity, expected)).resolves.toMatchObject({
      packages: [{ name: "better-realtime" }, { name: "better-realtime-mcp" }],
    });
    const changed = structuredClone(publicIdentity);
    changed.packages[1]!.expectedNpmRegistry.sha512 = "0".repeat(128);
    await expect(verifyPublicReleaseBundle(changed, expected)).rejects.toThrow("RT_PUBLIC_RELEASE_BUNDLE_VERIFY_PUBLIC_PACKAGE_RECORD_MISMATCH:better-realtime-mcp");
    await expect(verifyPublicReleaseBundle(publicIdentity, { ...expected, evidenceGeneratedAt: "2026-07-24T06:00:00+00:00" })).rejects.toThrow(
      "RT_PUBLIC_RELEASE_BUNDLE_VERIFY_EXPECTATION_INVALID",
    );
    await writeFile(base.checksumPath, "wrong\n");
    await expect(verifyPublicReleaseBundle(publicIdentity, expected)).rejects.toThrow("RT_PUBLIC_RELEASE_BUNDLE_VERIFY_PACKAGE_BYTES_MISMATCH:better-realtime");
  });
});
