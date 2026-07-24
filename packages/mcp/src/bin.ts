#!/usr/bin/env node
import { BETTER_REALTIME_PRODUCT, BETTER_REALTIME_VERSION } from "better-realtime";
import { diagnosticPublicErrorEnvelope } from "better-realtime/diagnostics";
import { runDiagnosticMcpFromEnvironment } from "./index.js";
import { assertSupportedNodeRuntime } from "./node-runtime.js";

assertSupportedNodeRuntime();
if (process.argv.slice(2).some((value) => value === "--help" || value === "-h")) process.stdout.write(`${BETTER_REALTIME_PRODUCT} MCP ${BETTER_REALTIME_VERSION}\n\nLocal stdio read-only analyzer. Set REALTIME_EVIDENCE_FILE and REALTIME_TENANT_ID.\n`);
else if (process.argv.slice(2).some((value) => value === "--version" || value === "-v")) process.stdout.write(`${BETTER_REALTIME_VERSION}\n`);
else try { await runDiagnosticMcpFromEnvironment(); }
catch (error) { process.stderr.write(`${JSON.stringify(diagnosticPublicErrorEnvelope(error))}\n`); process.exitCode = 1; }
