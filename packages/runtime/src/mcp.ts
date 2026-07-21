import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { diagnosticPublicErrorEnvelope, DIAGNOSTIC_TOOL_PROTOCOL_VERSION, executeDiagnosticQuery, openLocalDiagnosticSource, runStoredDoctor, type LocalDiagnosticSource } from "./diagnostic-io.js";

export interface ReadOnlyDiagnosticMcpOptions {
  sourcePath: string;
  tenantId: string;
}

export async function createReadOnlyDiagnosticMcp(options: ReadOnlyDiagnosticMcpOptions): Promise<Server> {
  const source = await openLocalDiagnosticSource(options.sourcePath, options.tenantId);
  const server = new Server({ name: "better-realtime-diagnostics", version: DIAGNOSTIC_TOOL_PROTOCOL_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = runTool(source, options.tenantId, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(diagnosticPublicErrorEnvelope(error)) }] };
    }
  });
  return server;
}

function runTool(source: LocalDiagnosticSource, tenantId: string, name: string, input: Record<string, unknown>): unknown {
  if (input.tenantId !== undefined && input.tenantId !== tenantId) throw new Error("RT_DIAGNOSTIC_TENANT_MISMATCH");
  assertToolInput(name, input);
  const page = pageArguments(input);
  switch (name) {
    case "realtime_doctor": return runStoredDoctor(source, tenantId);
    case "realtime_trace_command": return executeDiagnosticQuery(source, { kind: "trace_command", tenantId, commandId: requiredString(input, "commandId"), ...page });
    case "realtime_inspect_stream": return executeDiagnosticQuery(source, { kind: "inspect_stream", tenantId, stream: requiredString(input, "stream"), ...page });
    case "realtime_leaks": return executeDiagnosticQuery(source, { kind: "leaks", tenantId, ...page });
    case "realtime_query_evidence": {
      const filters = objectValue(input.filters);
      return executeDiagnosticQuery(source, { kind: "raw_evidence", tenantId, ...page, ...(filters ? { filters } : {}) });
    }
    case "realtime_query_evidence_closure": return executeDiagnosticQuery(source, { kind: "evidence_closure", tenantId, reference: requiredString(input, "reference"), ...page });
    default: throw new Error("RT_DIAGNOSTIC_CONCLUSION_UNSUPPORTED");
  }
}

function assertToolInput(name: string, input: Record<string, unknown>): void {
  const pagination = ["tenantId", "cursor", "limit"];
  const known = new Set(["realtime_doctor", "realtime_trace_command", "realtime_inspect_stream", "realtime_leaks", "realtime_query_evidence", "realtime_query_evidence_closure"]);
  if (!known.has(name)) throw new Error("RT_DIAGNOSTIC_CONCLUSION_UNSUPPORTED");
  const allowed = new Set(name === "realtime_doctor" ? ["tenantId"] : name === "realtime_trace_command" ? [...pagination, "commandId"] : name === "realtime_inspect_stream" ? [...pagination, "stream"] : name === "realtime_leaks" ? pagination : name === "realtime_query_evidence" ? [...pagination, "filters"] : name === "realtime_query_evidence_closure" ? [...pagination, "reference"] : []);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
}

function pageArguments(input: Record<string, unknown>): { cursor?: string; limit?: number } {
  const cursor = input.cursor;
  const limit = input.limit;
  if (cursor !== undefined && typeof cursor !== "string") throw new Error("RT_DIAGNOSTIC_CURSOR_INVALID");
  if (limit !== undefined && typeof limit !== "number") throw new Error("RT_DIAGNOSTIC_LIMIT_INVALID");
  return { ...(typeof cursor === "string" ? { cursor } : {}), ...(typeof limit === "number" ? { limit } : {}) };
}

function requiredString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) throw new Error("RT_DIAGNOSTIC_SCOPE_INVALID");
  return value;
}

function objectValue(value: unknown): Record<string, never> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
  return value as Record<string, never>;
}

const paginationProperties = { tenantId: { type: "string", minLength: 1, maxLength: 512 }, cursor: { type: "string", maxLength: 4096 }, limit: { type: "integer", minimum: 1, maximum: 500 } } as const;
const toolDefinitions = [
  { name: "realtime_doctor", description: "Return derived incident diagnosis from the configured redacted local evidence bundle.", inputSchema: { type: "object", additionalProperties: false, properties: { tenantId: { type: "string", minLength: 1, maxLength: 512 } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "realtime_trace_command", description: "Read a bounded page of evidence for one command and exactly one durable principal namespace.", inputSchema: { type: "object", additionalProperties: false, required: ["commandId"], properties: { ...paginationProperties, commandId: { type: "string", minLength: 1, maxLength: 512 } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "realtime_inspect_stream", description: "Read a bounded page of evidence for one stream.", inputSchema: { type: "object", additionalProperties: false, required: ["stream"], properties: { ...paginationProperties, stream: { type: "string", minLength: 1, maxLength: 512 } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "realtime_leaks", description: "Return derived resource ownership and leak evidence.", inputSchema: { type: "object", additionalProperties: false, properties: paginationProperties }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "realtime_query_evidence", description: "Read a byte- and count-bounded page of redacted raw evidence after derived facts are insufficient.", inputSchema: { type: "object", additionalProperties: false, properties: { ...paginationProperties, filters: { type: "object", additionalProperties: false, properties: { boundary: { type: "string", maxLength: 512 }, stream: { type: "string", maxLength: 512 }, transactionId: { type: "string", maxLength: 512 }, operationCorrelationId: { type: "string", maxLength: 512 }, commandId: { type: "string", maxLength: 512 }, eventId: { type: "string", maxLength: 512 }, resourceId: { type: "string", maxLength: 512 } } } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "realtime_query_evidence_closure", description: "Expand one doctor conclusion into its bounded, source-bound matched evidence closure.", inputSchema: { type: "object", additionalProperties: false, required: ["reference"], properties: { ...paginationProperties, reference: { type: "string", pattern: "^dqc1\\.sha256:[a-f0-9]{64}$" } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
];

export async function runDiagnosticMcpFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const sourcePath = env.REALTIME_EVIDENCE_FILE;
  const tenantId = env.REALTIME_TENANT_ID;
  if (!sourcePath) throw new Error("RT_DIAGNOSTIC_SOURCE_REQUIRED");
  if (!tenantId) throw new Error("RT_DIAGNOSTIC_TENANT_REQUIRED");
  const server = await createReadOnlyDiagnosticMcp({ sourcePath, tenantId });
  await server.connect(new StdioServerTransport());
}
