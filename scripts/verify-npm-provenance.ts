import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ExpectedProvenance {
  version: string;
  sourceSha: string;
  publishRunId: string;
  publishRunAttempt: string;
  repository?: string;
  workflowPath?: string;
  environment?: string;
  ref?: string;
}

const slsaPredicate = "https://slsa.dev/provenance/v1";
const workflowBuildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const statementType = "https://in-toto.io/Statement/v1";
const bundleMediaType = "application/vnd.dev.sigstore.bundle.v0.3+json";
const githubOidcIssuer = "https://token.actions.githubusercontent.com";
const githubHostedBuilder = "https://github.com/actions/runner/github-hosted";

export function verifyNpmProvenanceAttestation(attestationsValue: unknown, tarball: Uint8Array, expected: ExpectedProvenance): Record<string, string> {
  const repository = expected.repository ?? "newExpand/better-realtime";
  const workflowPath = expected.workflowPath ?? ".github/workflows/release.yml";
  const environment = expected.environment ?? "npm-alpha";
  const ref = expected.ref ?? "refs/heads/main";
  const trigger = "workflow_dispatch";
  if (!/^0\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u.test(expected.version) || !/^[a-f0-9]{40}$/u.test(expected.sourceSha) || !/^[1-9][0-9]*$/u.test(expected.publishRunId) || !/^[1-9][0-9]*$/u.test(expected.publishRunAttempt)) throw new Error("RT_PROVENANCE_EXPECTATION_INVALID");
  const root = requireRecord(attestationsValue, "RT_PROVENANCE_AUDIT_RESPONSE_INVALID");
  if (!Array.isArray(root.invalid) || root.invalid.length !== 0 || !Array.isArray(root.missing) || root.missing.length !== 0 || !Array.isArray(root.verified)) throw new Error("RT_PROVENANCE_AUDIT_NOT_CLEAN");
  const packageEntries = root.verified.filter((entry) => { const record = requireRecord(entry, "RT_PROVENANCE_AUDIT_ENTRY_INVALID"); return record.name === "better-realtime" && record.version === expected.version && record.location === "node_modules/better-realtime" && record.registry === "https://registry.npmjs.org/"; });
  if (packageEntries.length !== 1) throw new Error(`RT_PROVENANCE_VERIFIED_PACKAGE_COUNT:${packageEntries.length}`);
  const packageEntry = requireRecord(packageEntries[0], "RT_PROVENANCE_AUDIT_ENTRY_INVALID");
  const attestationMetadata = requireRecord(packageEntry.attestations, "RT_PROVENANCE_AUDIT_ATTESTATIONS_MISSING");
  const provenanceMetadata = requireRecord(attestationMetadata.provenance, "RT_PROVENANCE_AUDIT_ATTESTATIONS_MISSING");
  if (attestationMetadata.url !== `https://registry.npmjs.org/-/npm/v1/attestations/better-realtime@${expected.version}` || provenanceMetadata.predicateType !== slsaPredicate) throw new Error("RT_PROVENANCE_AUDIT_ATTESTATIONS_MISMATCH");
  const attestations = Array.isArray(packageEntry.attestationBundles) ? packageEntry.attestationBundles : [];
  const matches = attestations.filter((entry) => requireRecord(entry, "RT_PROVENANCE_ENTRY_INVALID").predicateType === slsaPredicate);
  if (matches.length !== 1) throw new Error(`RT_PROVENANCE_SLSA_COUNT:${matches.length}`);
  const bundle = requireRecord(requireRecord(matches[0], "RT_PROVENANCE_ENTRY_INVALID").bundle, "RT_PROVENANCE_BUNDLE_INVALID");
  if (bundle.mediaType !== bundleMediaType) throw new Error("RT_PROVENANCE_BUNDLE_MEDIA_TYPE_MISMATCH");
  const envelope = requireRecord(bundle.dsseEnvelope, "RT_PROVENANCE_ENVELOPE_INVALID");
  if (envelope.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") throw new Error("RT_PROVENANCE_ENVELOPE_INVALID");
  const statement = requireRecord(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")), "RT_PROVENANCE_STATEMENT_INVALID");
  if (statement._type !== statementType) throw new Error("RT_PROVENANCE_STATEMENT_TYPE_MISMATCH");
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const subject = subjects.length === 1 ? requireRecord(subjects[0], "RT_PROVENANCE_SUBJECT_INVALID") : undefined;
  const subjectDigest = subject ? requireRecord(subject.digest, "RT_PROVENANCE_SUBJECT_INVALID") : {};
  const sha512 = createHash("sha512").update(tarball).digest("hex");
  if (subject?.name !== `pkg:npm/better-realtime@${expected.version}` || subjectDigest.sha512 !== sha512) throw new Error("RT_PROVENANCE_SUBJECT_MISMATCH");
  if (statement.predicateType !== slsaPredicate) throw new Error("RT_PROVENANCE_PREDICATE_MISMATCH");
  const predicate = requireRecord(statement.predicate, "RT_PROVENANCE_PREDICATE_INVALID");
  const buildDefinition = requireRecord(predicate.buildDefinition, "RT_PROVENANCE_BUILD_INVALID");
  if (buildDefinition.buildType !== workflowBuildType) throw new Error("RT_PROVENANCE_BUILD_TYPE_MISMATCH");
  const external = requireRecord(buildDefinition.externalParameters, "RT_PROVENANCE_EXTERNAL_PARAMETERS_INVALID");
  const internal = requireRecord(buildDefinition.internalParameters, "RT_PROVENANCE_INTERNAL_PARAMETERS_INVALID");
  const github = requireRecord(internal.github, "RT_PROVENANCE_INTERNAL_PARAMETERS_INVALID");
  if (github.event_name !== trigger) throw new Error("RT_PROVENANCE_TRIGGER_MISMATCH");
  const workflow = requireRecord(external.workflow, "RT_PROVENANCE_WORKFLOW_INVALID");
  const repositoryUrl = `https://github.com/${repository}`;
  if (workflow.repository !== repositoryUrl || workflow.path !== workflowPath || workflow.ref !== ref) throw new Error("RT_PROVENANCE_WORKFLOW_MISMATCH");
  const dependencies = Array.isArray(buildDefinition.resolvedDependencies) ? buildDefinition.resolvedDependencies : [];
  const dependency = dependencies.find((entry) => requireRecord(entry, "RT_PROVENANCE_DEPENDENCY_INVALID").uri === `git+${repositoryUrl}@${ref}`);
  if (!dependency || requireRecord(requireRecord(dependency, "RT_PROVENANCE_DEPENDENCY_INVALID").digest, "RT_PROVENANCE_DEPENDENCY_INVALID").gitCommit !== expected.sourceSha) throw new Error("RT_PROVENANCE_SOURCE_MISMATCH");
  const invocation = `https://github.com/${repository}/actions/runs/${expected.publishRunId}/attempts/${expected.publishRunAttempt}`;
  const runDetails = requireRecord(predicate.runDetails, "RT_PROVENANCE_RUN_INVALID");
  const builder = requireRecord(runDetails.builder, "RT_PROVENANCE_BUILDER_INVALID");
  if (builder.id !== githubHostedBuilder) throw new Error("RT_PROVENANCE_BUILDER_MISMATCH");
  const metadata = requireRecord(runDetails.metadata, "RT_PROVENANCE_RUN_INVALID");
  if (metadata.invocationId !== invocation) throw new Error("RT_PROVENANCE_RUN_MISMATCH");
  const verificationMaterial = requireRecord(bundle.verificationMaterial, "RT_PROVENANCE_CERTIFICATE_MISSING");
  const chain = verificationMaterial.x509CertificateChain ? requireRecord(verificationMaterial.x509CertificateChain, "RT_PROVENANCE_CERTIFICATE_MISSING") : undefined;
  const chainCertificates = chain && Array.isArray(chain.certificates) ? chain.certificates : [];
  const certificate = verificationMaterial.certificate ? requireRecord(verificationMaterial.certificate, "RT_PROVENANCE_CERTIFICATE_MISSING") : requireRecord(chainCertificates[0], "RT_PROVENANCE_CERTIFICATE_MISSING");
  if (typeof certificate.rawBytes !== "string") throw new Error("RT_PROVENANCE_CERTIFICATE_MISSING");
  const extensions = certificateExtensions(Buffer.from(certificate.rawBytes, "base64"));
  const workflowIdentity = `${repositoryUrl}/${workflowPath}@${ref}`;
  const expectedExtensions = new Map([
    ["1.3.6.1.4.1.57264.1.3", expected.sourceSha],
    ["1.3.6.1.4.1.57264.1.5", repository],
    ["1.3.6.1.4.1.57264.1.8", githubOidcIssuer],
    ["1.3.6.1.4.1.57264.1.11", "github-hosted"],
    ["1.3.6.1.4.1.57264.1.12", repositoryUrl],
    ["1.3.6.1.4.1.57264.1.14", ref],
    ["1.3.6.1.4.1.57264.1.18", workflowIdentity],
    ["1.3.6.1.4.1.57264.1.19", expected.sourceSha],
    ["1.3.6.1.4.1.57264.1.20", trigger],
    ["1.3.6.1.4.1.57264.1.21", invocation],
    ["1.3.6.1.4.1.57264.1.22", "public"],
    ["1.3.6.1.4.1.57264.1.23", environment],
    ["1.3.6.1.4.1.57264.1.24", `repo:${repository.split("/")[0]}@`]
  ]);
  for (const [oid, value] of expectedExtensions) {
    const actual = extensions.get(oid);
    if (oid.endsWith(".24") ? !actual?.startsWith(value) || !actual.endsWith(`:environment:${environment}`) : actual !== value) throw new Error(`RT_PROVENANCE_CERTIFICATE_IDENTITY_MISMATCH:${oid}`);
  }
  return { package: `better-realtime@${expected.version}`, sha512, repository, workflow: workflowPath, environment, sourceSha: expected.sourceSha, invocation };
}

interface DerNode { tag: number; valueStart: number; end: number; children: DerNode[] }
function certificateExtensions(der: Uint8Array): Map<string, string> {
  const root = readDerNode(der, 0);
  const nodes: DerNode[] = [];
  const visit = (node: DerNode) => { nodes.push(node); node.children.forEach(visit); };
  visit(root);
  const result = new Map<string, string>();
  for (const node of nodes) {
    if ((node.tag & 0x1f) !== 0x10 || node.children[0]?.tag !== 0x06) continue;
    const oid = decodeOid(der.slice(node.children[0].valueStart, node.children[0].end));
    const valueNode = node.children.find((child, index) => index > 0 && child.tag === 0x04);
    if (!valueNode) continue;
    const wrapped = der.slice(valueNode.valueStart, valueNode.end);
    let inner: DerNode;
    try {
      inner = readDerNode(wrapped, 0);
      if ([0x0c, 0x13, 0x16].includes(inner.tag) && inner.end === wrapped.length) { result.set(oid, Buffer.from(wrapped.slice(inner.valueStart, inner.end)).toString("utf8")); continue; }
    } catch { /* legacy Fulcio claims use the OCTET payload directly */ }
    const direct = Buffer.from(wrapped).toString("utf8");
    if (/^[\x20-\x7e]+$/u.test(direct)) result.set(oid, direct);
  }
  return result;
}

function readDerNode(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) throw new Error("RT_PROVENANCE_CERTIFICATE_DER_INVALID");
  const tag = bytes[offset]!;
  let cursor = offset + 1;
  const firstLength = bytes[cursor++]!;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const count = firstLength & 0x7f;
    if (count < 1 || count > 4 || cursor + count > bytes.length) throw new Error("RT_PROVENANCE_CERTIFICATE_DER_INVALID");
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + bytes[cursor++]!;
  }
  const valueStart = cursor;
  const end = valueStart + length;
  if (end > bytes.length) throw new Error("RT_PROVENANCE_CERTIFICATE_DER_INVALID");
  const children: DerNode[] = [];
  if ((tag & 0x20) !== 0) for (let childOffset = valueStart; childOffset < end;) { const child = readDerNode(bytes, childOffset); children.push(child); childOffset = child.end; }
  return { tag, valueStart, end, children };
}

function decodeOid(bytes: Uint8Array): string {
  if (!bytes.length) throw new Error("RT_PROVENANCE_CERTIFICATE_DER_INVALID");
  const values = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let current = 0;
  for (const byte of bytes.slice(1)) { current = current * 128 + (byte & 0x7f); if ((byte & 0x80) === 0) { values.push(current); current = 0; } }
  if (current !== 0) throw new Error("RT_PROVENANCE_CERTIFICATE_DER_INVALID");
  return values.join(".");
}

function requireRecord(value: unknown, code: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code); return value as Record<string, unknown>; }

async function main(): Promise<void> {
  const argumentsMap = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) { const key = process.argv[index]; const value = process.argv[index + 1]; if (!key?.startsWith("--") || !value) throw new Error("RT_PROVENANCE_ARGUMENT_INVALID"); argumentsMap.set(key.slice(2), value); }
  const required = (name: string) => { const value = argumentsMap.get(name); if (!value) throw new Error(`RT_PROVENANCE_ARGUMENT_MISSING:${name}`); return value; };
  const attestations = JSON.parse(await readFile(resolve(required("audit-signatures")), "utf8"));
  const tarball = await readFile(resolve(required("tarball")));
  const result = verifyNpmProvenanceAttestation(attestations, tarball, { version: required("version"), sourceSha: required("source-sha"), publishRunId: required("publish-run-id"), publishRunAttempt: required("publish-run-attempt") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
