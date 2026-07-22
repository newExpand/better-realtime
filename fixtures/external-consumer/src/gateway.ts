import { writeFile } from "node:fs/promises";
import type { EvidenceBundleV1 } from "better-realtime/diagnostics";
import { attachClientEvidence } from "./evidence.js";
import { server } from "./server.js";

await server.start();
process.stdout.write(`${JSON.stringify({ kind: "gateway.ready", runtimeId: process.env.RUNTIME_ID, httpUrl: server.httpUrl, webSocketUrl: server.webSocketUrl })}\n`);

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "write-evidence" && "path" in message && typeof message.path === "string" && "commandId" in message && typeof message.commandId === "string" && "clientEvidence" in message) {
    const bundle = server.evidenceBundle("tenant-fixture", {
      expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }, { producerRole: "server", boundary: "command.completed" }, { producerRole: "client", boundary: "command.observed" }],
      expectedProducers: ["database", "server", "client"],
      requireCausalHandoffs: true,
      expectedOutcome: "durable command completed and observed in the browser after ACK loss",
      scope: { commandId: message.commandId }
    }) as EvidenceBundleV1;
    attachClientEvidence(bundle, message.clientEvidence, message.commandId);
    void writeFile(message.path, JSON.stringify(bundle), "utf8").then(() => process.send?.({ type: "evidence-written", path: message.path }));
  }
});

const stop = async () => { await server.dispose(); process.exit(0); };
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
