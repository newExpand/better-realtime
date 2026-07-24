import { describe, expect, it } from "vitest";
import { runDiagnosticMcpFromEnvironment } from "../src/index.ts";
import { assertSupportedNodeRuntime } from "../src/node-runtime.ts";

describe("Better Realtime MCP companion", () => {
  it("keeps required source and tenant failures stable", async () => {
    await expect(runDiagnosticMcpFromEnvironment({})).rejects.toThrow("RT_DIAGNOSTIC_SOURCE_REQUIRED");
    await expect(runDiagnosticMcpFromEnvironment({ REALTIME_EVIDENCE_FILE: "evidence.json" })).rejects.toThrow("RT_DIAGNOSTIC_TENANT_REQUIRED");
  });

  it("enforces the Node-only runtime boundary", () => {
    expect(() => assertSupportedNodeRuntime("21.9.0")).toThrow("RT_NODE_VERSION_UNSUPPORTED");
    expect(() => assertSupportedNodeRuntime("22.0.0")).not.toThrow();
  });
});
