import { pathToFileURL } from "node:url";

const bootstrapVersion = "0.0.0-bootstrap.0";
const releaseVersionPattern = /^0\.[0-9]+\.[0-9]+-alpha\.[1-9][0-9]*$/u;

export function assertMcpBootstrapRegistryState(
  rawVersions: unknown,
  rawTags: unknown,
  releasingVersion: string
): void {
  if (!releaseVersionPattern.test(releasingVersion)) throw new Error("RT_MCP_RELEASE_VERSION_INVALID");
  const versions = Array.isArray(rawVersions) ? rawVersions : [rawVersions];
  if (
    versions.some((version) => typeof version !== "string")
    || new Set(versions).size !== versions.length
  ) throw new Error("RT_MCP_REGISTRY_VERSIONS_INVALID");
  const typedVersions = versions as string[];
  if (!typedVersions.includes(bootstrapVersion)) throw new Error("RT_MCP_BOOTSTRAP_VERSION_MISSING");
  if (typedVersions.includes(releasingVersion)) throw new Error("RT_MCP_RELEASE_VERSION_EXISTS");
  const publishedVersions = typedVersions.filter((version) => version !== bootstrapVersion);
  if (publishedVersions.some((version) => !releaseVersionPattern.test(version))) throw new Error("RT_MCP_REGISTRY_VERSION_UNEXPECTED");

  if (!rawTags || typeof rawTags !== "object" || Array.isArray(rawTags)) throw new Error("RT_MCP_REGISTRY_TAGS_INVALID");
  const tags = rawTags as Record<string, unknown>;
  if (Object.keys(tags).some((tag) => !["alpha", "bootstrap", "latest"].includes(tag))) throw new Error("RT_MCP_REGISTRY_TAGS_UNEXPECTED");
  if (tags.bootstrap !== bootstrapVersion) throw new Error("RT_MCP_BOOTSTRAP_TAG_DRIFT");

  if (publishedVersions.length === 0) {
    if (Object.hasOwn(tags, "alpha")) throw new Error("RT_MCP_REGISTRY_ALPHA_PREMATURE");
    if (tags.latest !== undefined && tags.latest !== bootstrapVersion) throw new Error("RT_MCP_REGISTRY_DEFAULT_TAG_DRIFT");
    return;
  }

  if (
    typeof tags.alpha !== "string"
    || typeof tags.latest !== "string"
    || tags.alpha !== tags.latest
    || tags.alpha === bootstrapVersion
    || !publishedVersions.includes(tags.alpha)
  ) throw new Error("RT_MCP_REGISTRY_DEFAULT_TAG_DRIFT");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertMcpBootstrapRegistryState(
      JSON.parse(process.argv[2] ?? "null"),
      JSON.parse(process.argv[3] ?? "null"),
      process.argv[4] ?? ""
    );
    process.stdout.write(`${JSON.stringify({ bootstrap: bootstrapVersion, state: "verified" })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
