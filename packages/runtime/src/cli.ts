#!/usr/bin/env node
import { diagnosticPublicErrorEnvelope, executeDiagnosticQuery, openLocalDiagnosticSource, runStoredDoctor } from "./diagnostic-io.js";
import { BETTER_REALTIME_PRODUCT, BETTER_REALTIME_VERSION } from "./release.js";

export interface CliEnvironment {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

export async function runRealtimeCli(runtime: CliEnvironment): Promise<number> {
  try {
    if (runtime.argv.length === 1 && ["--help", "-h"].includes(runtime.argv[0]!)) { runtime.writeStdout(`${BETTER_REALTIME_PRODUCT} ${BETTER_REALTIME_VERSION}\n\nUsage:\n  better-realtime doctor --format json --source <file> --tenant <tenant>\n  better-realtime trace command <id> --format json --source <file> --tenant <tenant>\n  better-realtime inspect stream <stream> --format json --source <file> --tenant <tenant>\n  better-realtime leaks --format json --source <file> --tenant <tenant>\n`); return 0; }
    if (runtime.argv.length === 1 && ["--version", "-v"].includes(runtime.argv[0]!)) { runtime.writeStdout(`${BETTER_REALTIME_VERSION}\n`); return 0; }
    const parsed = parseArguments(runtime.argv);
    const sourcePath = parsed.options.source ?? runtime.env.REALTIME_EVIDENCE_FILE;
    const tenantId = parsed.options.tenant ?? runtime.env.REALTIME_TENANT_ID;
    if (!sourcePath) throw new Error("RT_DIAGNOSTIC_SOURCE_REQUIRED");
    if (!tenantId) throw new Error("RT_DIAGNOSTIC_TENANT_REQUIRED");
    if ((parsed.options.format ?? "json") !== "json") throw new Error("RT_DIAGNOSTIC_FORMAT_UNSUPPORTED");
    const source = await openLocalDiagnosticSource(sourcePath, tenantId);
    const [top, second, identifier] = parsed.positionals;
    const limit = parsed.options.limit === undefined ? undefined : Number(parsed.options.limit);
    let result: unknown;
    if (top === "doctor" && second === undefined) {
      if (parsed.options.limit !== undefined || parsed.options.cursor !== undefined) throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
      result = runStoredDoctor(source, tenantId);
    }
    else if (top === "trace" && second === "command" && identifier) result = executeDiagnosticQuery(source, { kind: "trace_command", tenantId, commandId: identifier, ...(limit === undefined ? {} : { limit }), ...(parsed.options.cursor ? { cursor: parsed.options.cursor } : {}) });
    else if (top === "inspect" && second === "stream" && identifier) result = executeDiagnosticQuery(source, { kind: "inspect_stream", tenantId, stream: identifier, ...(limit === undefined ? {} : { limit }), ...(parsed.options.cursor ? { cursor: parsed.options.cursor } : {}) });
    else if (top === "leaks" && second === undefined) result = executeDiagnosticQuery(source, { kind: "leaks", tenantId, ...(limit === undefined ? {} : { limit }), ...(parsed.options.cursor ? { cursor: parsed.options.cursor } : {}) });
    else throw new Error("RT_DIAGNOSTIC_QUERY_INVALID");
    runtime.writeStdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    runtime.writeStderr(`${JSON.stringify(diagnosticPublicErrorEnvelope(error))}\n`);
    return 1;
  }
}

function parseArguments(argv: readonly string[]): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const name = value.slice(2);
    if (!["format", "source", "tenant", "cursor", "limit"].includes(name)) throw new Error(`RT_DIAGNOSTIC_OPTION_UNKNOWN:${name}`);
    const optionValue = argv[index + 1];
    if (!optionValue || optionValue.startsWith("--")) throw new Error(`RT_DIAGNOSTIC_OPTION_VALUE_REQUIRED:${name}`);
    options[name] = optionValue;
    index += 1;
  }
  return { positionals, options };
}
