import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export interface SupportFeature {
  id: string;
  title: string;
  protocolStatus: "defined" | "not-applicable" | "not-defined";
  runtimeStatus: "implemented" | "unsupported" | "internal-fixture" | "not-implemented";
  roadmapStatus: "current-alpha" | "committed-post-alpha" | "demand-gated-candidate" | "not-planned";
  verifiedEnvironments: string[];
  protocolEvidence: string[];
  runtimeEvidence: string[];
  verificationEvidence: string[];
}

export interface SupportManifest { releaseVersion: string; packageName: string; webSocketSubprotocol: string; features: SupportFeature[] }

const root = new URL("../", import.meta.url);
const begin = "<!-- support:alpha-0.1:begin -->";
const end = "<!-- support:alpha-0.1:end -->";

export function assertStatusEvidence(feature: SupportFeature): void {
  if (feature.protocolStatus === "defined" && feature.protocolEvidence.length === 0) throw new Error(`RT_SUPPORT_PROTOCOL_WITHOUT_EVIDENCE:${feature.id}`);
  if (feature.protocolStatus !== "defined" && feature.protocolEvidence.length > 0) throw new Error(`RT_SUPPORT_PROTOCOL_EVIDENCE_FOR_UNDEFINED_STATUS:${feature.id}`);
  const evidencedRuntimeStatus = ["implemented", "internal-fixture", "unsupported"].includes(feature.runtimeStatus);
  if (evidencedRuntimeStatus && feature.runtimeEvidence.length === 0) throw new Error(`RT_SUPPORT_RUNTIME_STATUS_WITHOUT_IMPLEMENTATION_EVIDENCE:${feature.id}`);
  if (evidencedRuntimeStatus && feature.verificationEvidence.length === 0) throw new Error(`RT_SUPPORT_RUNTIME_STATUS_WITHOUT_VERIFICATION:${feature.id}`);
  if (feature.runtimeStatus === "not-implemented" && (feature.runtimeEvidence.length > 0 || feature.verificationEvidence.length > 0)) throw new Error(`RT_SUPPORT_NOT_IMPLEMENTED_WITH_RUNTIME_EVIDENCE:${feature.id}`);
  if (feature.verifiedEnvironments.length > 0 && feature.verificationEvidence.length === 0) throw new Error(`RT_SUPPORT_ENVIRONMENT_WITHOUT_VERIFICATION:${feature.id}`);
  if (["unsupported", "not-implemented"].includes(feature.runtimeStatus) && feature.verifiedEnvironments.length > 0) throw new Error(`RT_SUPPORT_UNIMPLEMENTED_ENVIRONMENT_CLAIM:${feature.id}`);
  if (feature.runtimeStatus !== "implemented" && feature.roadmapStatus === "current-alpha") throw new Error(`RT_SUPPORT_ALPHA_NOT_IMPLEMENTED:${feature.id}`);
}

export function renderSupportBlock(features: SupportFeature[]): string {
  const current = features.filter((feature) => feature.runtimeStatus === "implemented" && feature.roadmapStatus === "current-alpha").map((feature) => `\`${feature.id}\``).join(", ");
  const unsupported = features.filter((feature) => feature.protocolStatus === "defined" && feature.runtimeStatus === "unsupported").map((feature) => `\`${feature.id}\``).join(", ");
  const committed = features.filter((feature) => feature.roadmapStatus === "committed-post-alpha").map((feature) => `\`${feature.id}\``).join(", ");
  const candidates = features.filter((feature) => feature.roadmapStatus === "demand-gated-candidate").map((feature) => `\`${feature.id}\``).join(", ");
  const rows = features.map((feature) => `| \`${feature.id}\` | ${feature.protocolStatus} | ${feature.runtimeStatus} | ${feature.roadmapStatus} | ${feature.verifiedEnvironments.join("; ") || "—"} |`);
  return [
    begin,
    `Current alpha runtime: ${current}.`,
    `Protocol-defined but runtime-unsupported: ${unsupported}.`,
    `Committed post-alpha roadmap: ${committed}.`,
    `Demand-gated architectural candidates: ${candidates}.`,
    "",
    "| Feature ID | Protocol | Runtime | Roadmap | Verified environments |",
    "|---|---|---|---|---|",
    ...rows,
    end
  ].join("\n");
}

export async function checkSupport(): Promise<void> {
  const schema = JSON.parse(await readFile(new URL("support/schema.json", root), "utf8"));
  const support = JSON.parse(await readFile(new URL("support/alpha-0.1.json", root), "utf8")) as SupportManifest;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  if (!validate(support)) throw new Error(`RT_SUPPORT_MANIFEST_INVALID:${JSON.stringify(validate.errors)}`);
  if (support.releaseVersion !== "0.1.0-alpha.1" || support.packageName !== "better-realtime" || support.webSocketSubprotocol !== "better-realtime.v1") throw new Error("RT_SUPPORT_RELEASE_IDENTITY_DRIFT");
  const ids = new Set<string>();
  for (const feature of support.features) {
    if (ids.has(feature.id)) throw new Error(`RT_SUPPORT_FEATURE_DUPLICATE:${feature.id}`);
    ids.add(feature.id);
    assertStatusEvidence(feature);
    for (const evidence of [...feature.protocolEvidence, ...feature.runtimeEvidence, ...feature.verificationEvidence]) {
      const evidenceUrl = new URL(evidence, root);
      await access(evidenceUrl);
      const resolved = relative(fileURLToPath(root), await realpath(evidenceUrl)).split(sep).join("/");
      if (resolved !== evidence) throw new Error(`RT_SUPPORT_EVIDENCE_PATH_CASE_MISMATCH:${evidence}:${resolved}`);
    }
  }
  const readme = await readFile(new URL("README.md", root), "utf8");
  if (readme.split(begin).length !== 2 || readme.split(end).length !== 2 || readme.indexOf(begin) > readme.indexOf(end)) throw new Error("RT_SUPPORT_README_MARKERS_INVALID");
  const expected = renderSupportBlock(support.features);
  const actual = readme.slice(readme.indexOf(begin), readme.indexOf(end) + end.length);
  if (actual !== expected) throw new Error("RT_SUPPORT_README_DRIFT");
  const template = await readFile(new URL("support/README.template.md", root), "utf8");
  const expectedReadme = template.replace("{{SUPPORT_BLOCK}}", expected);
  if (readme !== expectedReadme) throw new Error("RT_SUPPORT_README_TEMPLATE_DRIFT");
  console.log(JSON.stringify({ supportSchema: "valid", releaseLine: "0.1.x-alpha", featureCount: ids.size, implementedWithEvidence: support.features.filter((feature) => feature.runtimeStatus === "implemented").length, readmeDrift: false }));
}

export async function renderReadme(): Promise<void> {
  const support = JSON.parse(await readFile(new URL("support/alpha-0.1.json", root), "utf8")) as SupportManifest;
  const template = await readFile(new URL("support/README.template.md", root), "utf8");
  await writeFile(new URL("README.md", root), template.replace("{{SUPPORT_BLOCK}}", renderSupportBlock(support.features)), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (process.argv.includes("--write") ? renderReadme().then(checkSupport) : checkSupport()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
