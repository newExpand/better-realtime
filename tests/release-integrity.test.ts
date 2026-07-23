import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  deterministicReleaseIdentityJson,
  validatePublicReleaseIdentity,
  verifyPublicReleaseIdentityBindings,
  verifyPublicReleaseIdentityBytes,
} from "../scripts/release-integrity.ts";

const fixtureRoot = resolve(import.meta.dirname, "fixtures/release-identity");

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(fixtureRoot, "public-valid.json"), "utf8")) as Record<string, unknown>;
}

describe("public release identity", () => {
  it("accepts distinct package-source and provenance workflow commits", async () => {
    const identity = await fixture();
    const schema = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "release/public-release-identity.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false, formats: { "date-time": true } });
    const validate = ajv.compile(schema);
    expect(validate(identity), JSON.stringify(validate.errors)).toBe(true);
    const verified = validatePublicReleaseIdentity(identity);
    expect(verified.packageSource.commit).not.toBe(verified.workflow.commit);
    expect(verified.packageSource.commit).toBe("1".repeat(40));
    expect(verified.workflow.commit).toBe("3".repeat(40));
  });

  it("is deterministic and verifies GitHub/npm byte equality", async () => {
    const identity = await fixture();
    const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, "artifact.bin")));
    expect(deterministicReleaseIdentityJson(identity)).toBe(deterministicReleaseIdentityJson(JSON.parse(JSON.stringify(identity))));
    expect(verifyPublicReleaseIdentityBytes(identity, bytes, bytes).package.version).toBe("0.1.0-alpha.5");
    expect(verifyPublicReleaseIdentityBindings(identity, {
      packageSourceCommit: "1".repeat(40),
      annotatedTagObject: "2".repeat(40),
      workflowCommit: "3".repeat(40),
      workflowRunId: "30010000000",
      workflowRunAttempt: "1",
      releaseId: 358_600_000,
    }).workflow.commit).toBe("3".repeat(40));
  });

  it.each([
    ["source", (value: any) => { value.packageSource.commit = "f".repeat(40); value.packageSource.tag = "v0.1.0-alpha.6"; }],
    ["tag", (value: any) => { value.githubRelease.tag = "v0.1.0-alpha.6"; }],
    ["digest", (value: any) => { value.githubRelease.artifactAsset.sha256 = "f".repeat(64); }],
    ["workflow", (value: any) => { value.workflow.path = ".github/workflows/other.yml"; }],
  ])("fails closed when %s identity drifts", async (_name, mutate) => {
    const identity = await fixture();
    mutate(identity);
    expect(() => validatePublicReleaseIdentity(identity)).toThrow("RT_RELEASE_INTEGRITY_");
  });

  it("rejects private identity and byte mismatches", async () => {
    const identity = await fixture();
    (identity as any).privateExport = { privateCommit: "a".repeat(40) };
    expect(() => validatePublicReleaseIdentity(identity)).toThrow("RT_RELEASE_INTEGRITY_PRIVATE_DATA");
    delete (identity as any).privateExport;
    const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, "artifact.bin")));
    expect(() => verifyPublicReleaseIdentityBytes(identity, bytes, new TextEncoder().encode("different bytes"))).toThrow("RT_RELEASE_INTEGRITY_REGISTRY_BYTE_MISMATCH");
    expect(() => verifyPublicReleaseIdentityBindings(identity, {
      packageSourceCommit: "f".repeat(40),
      annotatedTagObject: "2".repeat(40),
      workflowCommit: "3".repeat(40),
      workflowRunId: "30010000000",
      workflowRunAttempt: "1",
      releaseId: 358_600_000,
    })).toThrow("RT_RELEASE_INTEGRITY_BINDING_MISMATCH");
  });

  it("keeps the private overlay schema separate from the public schema", async () => {
    const publicSchema = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "release/public-release-identity.schema.json"), "utf8"));
    expect(publicSchema.additionalProperties).toBe(false);
    const schemaValidate = new Ajv2020({ allErrors: true, strict: false, formats: { "date-time": true } }).compile(publicSchema);
    const invalidPublic = await fixture();
    (invalidPublic as any).privateCommit = "a".repeat(40);
    expect(schemaValidate(invalidPublic)).toBe(false);
    expect(JSON.stringify(publicSchema)).not.toContain("privateExport");
    const privateSchemaPath = resolve(import.meta.dirname, "..", ...["docs", "internal", "schemas", "private-release-identity.schema.json"]);
    const privateSchemaText = await readFile(privateSchemaPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (privateSchemaText === undefined) {
      await expect(readFile(resolve(import.meta.dirname, "..", "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    const privateSchema = JSON.parse(privateSchemaText);
    const privateRecord = JSON.parse(await readFile(resolve(import.meta.dirname, "..", ...["docs", "internal", "releases", "v0.1.0-alpha.4.identity.json"]), "utf8"));
    const privateGenerator = await readFile(resolve(import.meta.dirname, "..", ...["docs", "internal", "tools", "create-private-release-identity.mjs"]), "utf8");
    expect(privateSchema.properties.privateExport).toBeDefined();
    expect(privateGenerator).toContain("PRIVATE_EXPORT_SOURCE_COMMIT");
    expect(privateGenerator).toContain("PRIVATE_EXPORT_TAG_OBJECT");
    expect(privateGenerator).not.toContain("PublicReleaseIdentity");
    const privateValidate = new Ajv2020({ allErrors: true, strict: false }).compile(privateSchema);
    expect(privateValidate(privateRecord), JSON.stringify(privateValidate.errors)).toBe(true);
    expect(privateRecord.privateExport).toEqual({
      sourceCommit: "15e9ccebb68f6eaa18e4def47add69ee7b329757",
      annotatedTag: ["source", "-export/v0.1.0-alpha.4"].join(""),
      annotatedTagObject: "ca666a2363dff2e2ea2ca1eceeb8c91cc4e047be",
    });
    expect(() => validatePublicReleaseIdentity(privateRecord)).toThrow("RT_RELEASE_INTEGRITY_PRIVATE_DATA");
  });

  it("documents identity generation and npm publication as separate workflow executions", async () => {
    const document = await readFile(resolve(import.meta.dirname, "..", "docs/public/release-integrity.md"), "utf8");
    expect(document).toContain("necessarily created before npm publication");
    expect(document).toContain("does not claim to be the later npm provenance run");
    expect(document).toContain("independently proves the npm publication run");
    expect(document).toContain("same reviewed repository, workflow path, ref, commit");
  });
});
