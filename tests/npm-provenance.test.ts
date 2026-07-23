import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyNpmProvenanceAttestation } from "../scripts/verify-npm-provenance.ts";

const expected = { version: "0.1.0-alpha.3", sourceSha: "a".repeat(40), publishRunId: "12345", publishRunAttempt: "2" };
const tarball = Buffer.from("reviewed alpha.3 tarball");

describe("npm provenance identity", () => {
  it("requires the exact subject, public workflow, environment, source, and publish run", () => {
    expect(verifyNpmProvenanceAttestation(attestation(), tarball, expected)).toMatchObject({ package: "better-realtime@0.1.0-alpha.3", repository: "newExpand/better-realtime", workflow: ".github/workflows/release.yml", environment: "npm-alpha", sourceSha: expected.sourceSha, invocation: "https://github.com/newExpand/better-realtime/actions/runs/12345/attempts/2" });
    expect(() => verifyNpmProvenanceAttestation({ invalid: [], missing: [], verified: [] }, tarball, expected)).toThrow("RT_PROVENANCE_VERIFIED_PACKAGE_COUNT:0");
    expect(() => verifyNpmProvenanceAttestation({ invalid: [{ name: "better-realtime" }], missing: [], verified: [] }, tarball, expected)).toThrow("RT_PROVENANCE_AUDIT_NOT_CLEAN");
    expect(() => verifyNpmProvenanceAttestation(attestation({ subjectSha512: "b".repeat(128) }), tarball, expected)).toThrow("RT_PROVENANCE_SUBJECT_MISMATCH");
    expect(() => verifyNpmProvenanceAttestation(attestation({ environment: "different" }), tarball, expected)).toThrow("RT_PROVENANCE_CERTIFICATE_IDENTITY_MISMATCH:1.3.6.1.4.1.57264.1.23");
    expect(() => verifyNpmProvenanceAttestation(attestation({ sourceSha: "b".repeat(40) }), tarball, expected)).toThrow(/RT_PROVENANCE_(SOURCE_MISMATCH|CERTIFICATE_IDENTITY_MISMATCH)/u);
    expect(() => verifyNpmProvenanceAttestation(attestation({ invocation: "https://github.com/newExpand/better-realtime/actions/runs/999/attempts/1" }), tarball, expected)).toThrow("RT_PROVENANCE_RUN_MISMATCH");
    for (const [override, error] of [
      [{ issuer: "https://issuer.invalid" }, "RT_PROVENANCE_CERTIFICATE_IDENTITY_MISMATCH:1.3.6.1.4.1.57264.1.8"],
      [{ builder: "https://github.com/actions/runner/self-hosted" }, "RT_PROVENANCE_BUILDER_MISMATCH"],
      [{ trigger: "push" }, "RT_PROVENANCE_TRIGGER_MISMATCH"],
      [{ visibility: "private" }, "RT_PROVENANCE_CERTIFICATE_IDENTITY_MISMATCH:1.3.6.1.4.1.57264.1.22"],
      [{ statementType: "https://in-toto.io/Statement/v0.1" }, "RT_PROVENANCE_STATEMENT_TYPE_MISMATCH"],
      [{ bundleMediaType: "application/json" }, "RT_PROVENANCE_BUNDLE_MEDIA_TYPE_MISMATCH"]
    ] as const) expect(() => verifyNpmProvenanceAttestation(attestation(override), tarball, expected)).toThrow(error);
  });
});

function attestation(overrides: { subjectSha512?: string; environment?: string; sourceSha?: string; invocation?: string; issuer?: string; builder?: string; trigger?: string; visibility?: string; statementType?: string; bundleMediaType?: string } = {}): Record<string, unknown> {
  const repository = "newExpand/better-realtime";
  const repositoryUrl = `https://github.com/${repository}`;
  const ref = "refs/heads/main";
  const sourceSha = overrides.sourceSha ?? expected.sourceSha;
  const invocation = overrides.invocation ?? `${repositoryUrl}/actions/runs/${expected.publishRunId}/attempts/${expected.publishRunAttempt}`;
  const workflowIdentity = `${repositoryUrl}/.github/workflows/release.yml@${ref}`;
  const certificate = sequence([
    extension("1.3.6.1.4.1.57264.1.3", sourceSha),
    extension("1.3.6.1.4.1.57264.1.5", repository),
    extension("1.3.6.1.4.1.57264.1.8", overrides.issuer ?? "https://token.actions.githubusercontent.com"),
    extension("1.3.6.1.4.1.57264.1.11", "github-hosted"),
    extension("1.3.6.1.4.1.57264.1.12", repositoryUrl),
    extension("1.3.6.1.4.1.57264.1.14", ref),
    extension("1.3.6.1.4.1.57264.1.18", workflowIdentity),
    extension("1.3.6.1.4.1.57264.1.19", sourceSha),
    extension("1.3.6.1.4.1.57264.1.20", overrides.trigger ?? "workflow_dispatch"),
    extension("1.3.6.1.4.1.57264.1.21", invocation),
    extension("1.3.6.1.4.1.57264.1.22", overrides.visibility ?? "public"),
    extension("1.3.6.1.4.1.57264.1.23", overrides.environment ?? "npm-alpha"),
    extension("1.3.6.1.4.1.57264.1.24", "repo:newExpand@1/better-realtime@2:environment:npm-alpha")
  ]);
  const statement = {
    _type: overrides.statementType ?? "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/better-realtime@${expected.version}`, digest: { sha512: overrides.subjectSha512 ?? createHash("sha512").update(tarball).digest("hex") } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: { buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1", externalParameters: { workflow: { ref, repository: repositoryUrl, path: ".github/workflows/release.yml" } }, internalParameters: { github: { event_name: overrides.trigger ?? "workflow_dispatch" } }, resolvedDependencies: [{ uri: `git+${repositoryUrl}@${ref}`, digest: { gitCommit: sourceSha } }] },
      runDetails: { builder: { id: overrides.builder ?? "https://github.com/actions/runner/github-hosted" }, metadata: { invocationId: invocation } }
    }
  };
  return { invalid: [], missing: [], verified: [{ name: "better-realtime", version: expected.version, location: "node_modules/better-realtime", registry: "https://registry.npmjs.org/", attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/better-realtime@${expected.version}`, provenance: { predicateType: "https://slsa.dev/provenance/v1" } }, attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { mediaType: overrides.bundleMediaType ?? "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { certificate: { rawBytes: certificate.toString("base64") } }, dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ sig: "verified-by-npm-audit-signatures" }] } } }] }] };
}

function extension(oid: string, value: string): Buffer { return sequence([der(0x06, encodeOid(oid)), der(0x04, der(0x0c, Buffer.from(value)))]); }
function sequence(children: Buffer[]): Buffer { return der(0x30, Buffer.concat(children)); }
function der(tag: number, value: Buffer): Buffer { return Buffer.concat([Buffer.from([tag]), length(value.length), value]); }
function length(value: number): Buffer { if (value < 128) return Buffer.from([value]); const bytes: number[] = []; for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining % 256); return Buffer.from([0x80 | bytes.length, ...bytes]); }
function encodeOid(value: string): Buffer {
  const arcs = value.split(".").map(Number);
  const output = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) { const bytes = [arc & 0x7f]; for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) bytes.unshift((remaining & 0x7f) | 0x80); output.push(...bytes); }
  return Buffer.from(output);
}
