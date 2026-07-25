import { isDeepStrictEqual } from "node:util";

export const MCP_BOOTSTRAP_NPM_VERSION = "11.18.0";
export const MCP_BOOTSTRAP_REGISTRY = "https://registry.npmjs.org";

export function createMcpBootstrapManifest() {
  return {
    name: "better-realtime-mcp",
    version: "0.0.0-bootstrap.0",
    description: "Reserved bootstrap identity for the Better Realtime MCP companion",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/newExpand/better-realtime.git" },
    homepage: "https://github.com/newExpand/better-realtime#readme",
    files: ["README.md", "LICENSE"],
    publishConfig: {
      access: "public",
      tag: "bootstrap",
      registry: MCP_BOOTSTRAP_REGISTRY,
    },
  } as const;
}

export function assertExactMcpBootstrapManifest(value: unknown): void {
  if (!isDeepStrictEqual(value, createMcpBootstrapManifest())) {
    throw new Error("RT_MCP_BOOTSTRAP_MANIFEST_INVALID");
  }
}
