import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LocalEvidenceBundleV1 } from "@realtime/diagnostics";
import { afterEach, describe, expect, it } from "vitest";
import { runRealtimeCli } from "../src/cli.ts";
import { openLocalDiagnosticSource } from "../src/diagnostic-io.ts";
import { createReadOnlyDiagnosticMcp } from "../src/mcp.ts";

const temporaryDirectories: string[] = [];
const exec = promisify(execFile);
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function evidenceFile(options: { missingExpectedProducer?: boolean; crossPrincipal?: boolean } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "realtime-diagnostics-"));
  temporaryDirectories.push(directory);
  const producer = { producerRole: "server" as const, runtimeId: "gateway-a", runtimeBootId: "boot-a" };
  const records = ["command.received", "command.completed"].map((boundary, index) => ({
    schemaVersion: "1.0" as const,
    recordId: `record-${index + 1}`,
    recordSequence: index + 1,
    kind: boundary,
    timestamp: `2026-07-18T00:00:0${index}.000Z`,
    monotonicNs: String(index + 1),
    ...producer,
    component: "consumer-server",
    componentVersion: "0.1.0",
    boundary,
    outcome: "success" as const,
    commandId: "cmd-42",
    stream: "room:42",
    principalNamespaceId: options.crossPrincipal && index === 1 ? "principal-b" : "principal-a",
    details: { tenantId: "tenant-a", principalNamespaceId: options.crossPrincipal && index === 1 ? "principal-b" : "principal-a", payload: { text: "must-not-leak" } }
  }));
  const bundle: LocalEvidenceBundleV1 = {
    schemaVersion: "1.0",
    tenantId: "tenant-a",
    payloadPolicy: "redacted",
    pseudonymizationKey: "runtime-diagnostic-test-key-32-bytes-long",
    records: records.map((record) => ({ tenantId: "tenant-a", record })),
    resourceCapture: "unavailable",
    loss: { droppedRecords: 0, evictedRecords: 0 },
    expectedProducerInstances: [producer, ...(options.missingExpectedProducer ? [{ producerRole: "database" as const, runtimeId: "db-a", runtimeBootId: "db-boot-a" }] : [])],
    defaultDoctorQuery: {
      expectedBoundaries: [{ ...producer, boundary: "command.received" }, { ...producer, boundary: "command.completed" }],
      expectedProducers: ["server"],
      expectedOutcome: "command completed",
      scope: { commandId: "cmd-42" }
    }
  };
  const path = join(directory, "evidence.json");
  await writeFile(path, JSON.stringify(bundle), "utf8");
  return path;
}

describe("read-only diagnostic CLI and MCP", () => {
  it("returns the same proven derived incident result through CLI and MCP", async () => {
    const source = await evidenceFile();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runRealtimeCli({ argv: ["doctor", "--format", "json", "--source", source, "--tenant", "tenant-a"], env: {}, writeStdout: (value) => stdout.push(value), writeStderr: (value) => stderr.push(value) });
    expect(exit).toBe(0);
    expect(stderr).toEqual([]);
    const cliResult = JSON.parse(stdout.join(""));
    expect(cliResult).toMatchObject({ queryVersion: "1.0", schemaVersion: "1.0", completeness: { status: "complete" }, report: { verdict: "proven" }, provenance: { payloadPolicy: "redacted" } });

    const server = await createReadOnlyDiagnosticMcp({ sourcePath: source, tenantId: "tenant-a" });
    const client = new Client({ name: "diagnostic-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["realtime_doctor", "realtime_trace_command", "realtime_inspect_stream", "realtime_leaks", "realtime_query_evidence", "realtime_query_evidence_closure"]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false)).toBe(true);
    const response = await client.callTool({ name: "realtime_doctor", arguments: {} });
    const content = response.content as Array<{ type: string; text?: string }>;
    const mcpResult = JSON.parse(content[0]?.type === "text" ? content[0].text ?? "null" : "null");
    expect(mcpResult).toEqual(cliResult);
    const closureResponse = await client.callTool({ name: "realtime_query_evidence_closure", arguments: { reference: mcpResult.evidenceReference.reference, limit: 1 } });
    const closureContent = closureResponse.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(closureContent[0]?.type === "text" ? closureContent[0].text ?? "null" : "null")).toMatchObject({ kind: "evidence_closure", evidenceReference: mcpResult.evidenceReference, records: [expect.objectContaining({ recordId: mcpResult.report.evidenceClosure[0].recordId })] });
    const invalid = await client.callTool({ name: "realtime_doctor", arguments: { unexpected: true } });
    expect(invalid.isError).toBe(true);
    const invalidContent = invalid.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(invalidContent[0]?.type === "text" ? invalidContent[0].text ?? "null" : "null")).toEqual({ product: "Better Realtime", productVersion: "0.1.0-alpha.4", component: "better-realtime", schemaVersion: "1.0", kind: "diagnostic_error", code: "RT_DIAGNOSTIC_QUERY_INVALID", message: "RT_DIAGNOSTIC_QUERY_INVALID" });
    await client.close();
    await server.close();
  });

  it("never upgrades incomplete evidence to proven and rejects cross-tenant queries", async () => {
    const source = await evidenceFile({ missingExpectedProducer: true });
    const output: string[] = [];
    expect(await runRealtimeCli({ argv: ["doctor", "--source", source, "--tenant", "tenant-a"], env: {}, writeStdout: (value) => output.push(value), writeStderr: () => undefined })).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ completeness: { status: "partial" }, report: { verdict: "indeterminate" } });

    const errors: string[] = [];
    expect(await runRealtimeCli({ argv: ["trace", "command", "cmd-42", "--source", source, "--tenant", "tenant-b"], env: {}, writeStdout: () => undefined, writeStderr: (value) => errors.push(value) })).toBe(1);
    expect(JSON.parse(errors.join(""))).toMatchObject({ code: "RT_DIAGNOSTIC_TENANT_MISMATCH" });
  });

  it("redacts payloads and enforces bounded pagination and invalid cursor rejection", async () => {
    const source = await evidenceFile();
    const output: string[] = [];
    expect(await runRealtimeCli({ argv: ["trace", "command", "cmd-42", "--source", source, "--tenant", "tenant-a", "--limit", "1"], env: {}, writeStdout: (value) => output.push(value), writeStderr: () => undefined })).toBe(0);
    const page = JSON.parse(output.join(""));
    expect(page).toMatchObject({ hasMore: true, omittedCount: 1, provenance: { redactedFields: expect.any(Number) } });
    expect(page.provenance.redactedFields).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(page)).not.toContain("must-not-leak");
    expect(page.nextCursor).toMatch(/^dq1\./);

    const changed = JSON.parse(await readFile(source, "utf8")) as { records: unknown[] };
    changed.records = changed.records.slice(1);
    await writeFile(source, JSON.stringify(changed), "utf8");
    const staleCursorErrors: string[] = [];
    expect(await runRealtimeCli({ argv: ["trace", "command", "cmd-42", "--source", source, "--tenant", "tenant-a", "--limit", "1", "--cursor", page.nextCursor], env: {}, writeStdout: () => undefined, writeStderr: (value) => staleCursorErrors.push(value) })).toBe(1);
    expect(JSON.parse(staleCursorErrors.join(""))).toMatchObject({ code: "RT_DIAGNOSTIC_CURSOR_INVALID" });

    const errors: string[] = [];
    expect(await runRealtimeCli({ argv: ["trace", "command", "cmd-42", "--source", source, "--tenant", "tenant-a", "--cursor", "invalid"], env: {}, writeStdout: () => undefined, writeStderr: (value) => errors.push(value) })).toBe(1);
    expect(JSON.parse(errors.join(""))).toMatchObject({ code: "RT_DIAGNOSTIC_CURSOR_INVALID" });
  });

  it("keeps the raw bundle, key, and path behind an opaque source and sanitizes file failures", async () => {
    const source = await evidenceFile();
    const opened = await openLocalDiagnosticSource(source, "tenant-a");
    expect(Object.keys(opened).sort()).toEqual(["query", "runStoredDoctor", "sourceKind"]);
    expect((opened as unknown as { bundle?: unknown }).bundle).toBeUndefined();
    expect((opened as unknown as { sourcePath?: unknown }).sourcePath).toBeUndefined();
    expect(JSON.stringify(opened)).not.toMatch(/pseudonymizationKey|runtime-diagnostic-test-key|evidence\.json/u);

    const leakedContract = (opened as unknown as { defaultDoctorRequest?: (tenantId: string) => unknown }).defaultDoctorRequest?.("tenant-a");
    expect(leakedContract).toBeUndefined();

    const missing = join(dirname(source), "private-customer-evidence.json");
    const missingErrors: string[] = [];
    expect(await runRealtimeCli({ argv: ["doctor", "--source", missing, "--tenant", "tenant-a"], env: {}, writeStdout: () => undefined, writeStderr: (value) => missingErrors.push(value) })).toBe(1);
    expect(JSON.parse(missingErrors.join(""))).toEqual({ product: "Better Realtime", productVersion: "0.1.0-alpha.4", component: "better-realtime", schemaVersion: "1.0", kind: "diagnostic_error", code: "RT_DIAGNOSTIC_SOURCE_UNAVAILABLE", message: "RT_DIAGNOSTIC_SOURCE_UNAVAILABLE" });
    expect(missingErrors.join("")).not.toContain(missing);

    const oversized = join(dirname(source), "oversized.json");
    await writeFile(oversized, "{}", "utf8");
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    await expect(openLocalDiagnosticSource(oversized)).rejects.toThrow("RT_DIAGNOSTIC_SOURCE_BOUNDS_EXCEEDED");

    const fifo = join(dirname(source), "evidence.fifo");
    await exec("mkfifo", [fifo]);
    await expect(openLocalDiagnosticSource(fifo)).rejects.toThrow("RT_DIAGNOSTIC_SOURCE_BOUNDS_EXCEEDED");
  });

  it("rejects pagination options for doctor consistently with MCP", async () => {
    const source = await evidenceFile();
    for (const option of [["--limit", "1"], ["--cursor", "dq1.invalid"]]) {
      const errors: string[] = [];
      expect(await runRealtimeCli({ argv: ["doctor", "--source", source, "--tenant", "tenant-a", ...option], env: {}, writeStdout: () => undefined, writeStderr: (value) => errors.push(value) })).toBe(1);
      expect(JSON.parse(errors.join(""))).toMatchObject({ code: "RT_DIAGNOSTIC_QUERY_INVALID" });
    }
  });

  it("returns the same principal-scope refusal through CLI and MCP", async () => {
    const source = await evidenceFile({ crossPrincipal: true });
    const errors: string[] = [];
    expect(await runRealtimeCli({ argv: ["trace", "command", "cmd-42", "--source", source, "--tenant", "tenant-a"], env: {}, writeStdout: () => undefined, writeStderr: (value) => errors.push(value) })).toBe(1);
    expect(JSON.parse(errors.join(""))).toMatchObject({ code: "RT_DIAGNOSTIC_SCOPE_AMBIGUOUS" });

    const server = await createReadOnlyDiagnosticMcp({ sourcePath: source, tenantId: "tenant-a" });
    const client = new Client({ name: "diagnostic-scope-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "realtime_trace_command", arguments: { commandId: "cmd-42" } });
    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(content[0]?.type === "text" ? content[0].text ?? "null" : "null")).toEqual({ product: "Better Realtime", productVersion: "0.1.0-alpha.4", component: "better-realtime", schemaVersion: "1.0", kind: "diagnostic_error", code: "RT_DIAGNOSTIC_SCOPE_AMBIGUOUS", message: "RT_DIAGNOSTIC_SCOPE_AMBIGUOUS" });
    await client.close();
    await server.close();
  });
});
