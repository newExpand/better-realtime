import { describe, expect, it } from "vitest";
import { assertMcpBootstrapRegistryState } from "../scripts/assert-mcp-bootstrap-registry-state.ts";

const bootstrap = "0.0.0-bootstrap.0";

describe("MCP bootstrap registry preservation", () => {
  it("accepts the historical first-release state", () => {
    expect(() => assertMcpBootstrapRegistryState(
      [bootstrap],
      { bootstrap, latest: bootstrap },
      "0.2.0-alpha.1"
    )).not.toThrow();
  });

  it("accepts an established package with coherent alpha/latest tags", () => {
    expect(() => assertMcpBootstrapRegistryState(
      [bootstrap, "0.2.0-alpha.1"],
      { bootstrap, alpha: "0.2.0-alpha.1", latest: "0.2.0-alpha.1" },
      "0.2.0-alpha.2"
    )).not.toThrow();
  });

  it("rejects candidate reuse, bootstrap drift, unknown tags, and incoherent defaults", () => {
    expect(() => assertMcpBootstrapRegistryState(
      [bootstrap, "0.2.0-alpha.1"],
      { bootstrap, alpha: "0.2.0-alpha.1", latest: "0.2.0-alpha.1" },
      "0.2.0-alpha.1"
    )).toThrow("RT_MCP_RELEASE_VERSION_EXISTS");
    expect(() => assertMcpBootstrapRegistryState(
      ["0.2.0-alpha.1"],
      { alpha: "0.2.0-alpha.1", latest: "0.2.0-alpha.1" },
      "0.2.0-alpha.2"
    )).toThrow("RT_MCP_BOOTSTRAP_VERSION_MISSING");
    expect(() => assertMcpBootstrapRegistryState(
      [bootstrap, "0.2.0-alpha.1"],
      { bootstrap, alpha: "0.2.0-alpha.1", latest: "0.2.0-alpha.1", next: "0.2.0-alpha.2" },
      "0.2.0-alpha.2"
    )).toThrow("RT_MCP_REGISTRY_TAGS_UNEXPECTED");
    expect(() => assertMcpBootstrapRegistryState(
      [bootstrap, "0.2.0-alpha.1"],
      { bootstrap, alpha: "0.2.0-alpha.1", latest: bootstrap },
      "0.2.0-alpha.2"
    )).toThrow("RT_MCP_REGISTRY_DEFAULT_TAG_DRIFT");
  });
});
