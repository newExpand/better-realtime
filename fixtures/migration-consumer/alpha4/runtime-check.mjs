import { jsonSchema, stream } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { createRealtimeServer } from "better-realtime/server";
import { createReadOnlyDiagnosticMcp } from "better-realtime/mcp";

if (typeof jsonSchema !== "function" || typeof stream !== "function") throw new Error("alpha.4 root exports unavailable");
if (typeof createRealtimeReact !== "function") throw new Error("alpha.4 React export unavailable");
if (typeof createRealtimeServer !== "function") throw new Error("alpha.4 server export unavailable");
if (typeof createReadOnlyDiagnosticMcp !== "function") throw new Error("alpha.4 MCP export unavailable");
const [{ contract }, reactExample, serverExample] = await Promise.all([
  import("./dist/contract.js"),
  import("./dist/react.js"),
  import("./dist/server.js")
]);
if (!contract?.identity?.manifestDigest) throw new Error("alpha.4 contract example did not run");
if (typeof reactExample.Alpha4Command !== "function") throw new Error("alpha.4 React example did not run");
if (!serverExample.server) throw new Error("alpha.4 server example did not run");
