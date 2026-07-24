import { jsonSchema, stateStream, stream } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { createRealtimeServer } from "better-realtime/server";
import { createReadOnlyDiagnosticMcp } from "better-realtime-mcp";

if (typeof jsonSchema !== "function" || typeof stream !== "function" || typeof stateStream !== "function") {
  throw new Error("0.2 contract exports unavailable");
}
if (typeof createRealtimeReact !== "function") throw new Error("0.2 React export unavailable");
if (typeof createRealtimeServer !== "function") throw new Error("0.2 server export unavailable");
if (typeof createReadOnlyDiagnosticMcp !== "function") throw new Error("0.2 MCP companion export unavailable");
const [{ contract }, reactExample, serverExample] = await Promise.all([
  import("./dist/contract.js"),
  import("./dist/react.js"),
  import("./dist/server.js")
]);
if (!contract?.identity?.manifestDigest) throw new Error("0.2 contract example did not run");
if (typeof reactExample.CandidateCommand !== "function") throw new Error("0.2 React example did not run");
if (!serverExample.server) throw new Error("0.2 server example did not run");
