import { describe, expect, it } from "vitest";
import { FlightRecorder } from "../packages/diagnostics/src/index.ts";
import { buildCommandJourneyDoctor } from "../examples/recovery-demo/src/command-doctor.ts";

describe("selected command doctor", () => {
  it("does not reuse an older command proof for a newer pending or divergent command", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "database-boot", producerRole: "database" });
    const server = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "gateway-boot", producerRole: "server" });
    const client = new FlightRecorder({ runtimeId: "browser", runtimeBootId: "browser-boot", producerRole: "client" });
    database.record({ kind: "db", boundary: "db.committed", outcome: "success", component: "database", componentVersion: "test", commandId: "command-a", eventId: "event-a", causalHandoffId: "event:event-a" });
    server.record({ kind: "server", boundary: "command.completed", outcome: "success", component: "gateway", componentVersion: "test", commandId: "command-a", eventId: "event-a", causalHandoffId: "event:event-a" });
    client.record({ kind: "client", boundary: "command.observed", outcome: "success", component: "client", componentVersion: "test", commandId: "command-a", eventId: "event-a", causalHandoffId: "event:event-a" });
    client.record({ kind: "client", boundary: "command.sent", outcome: "failure", reasonCode: "RT_TRANSPORT_SEND_FAILED", component: "client", componentVersion: "test", commandId: "command-b" });
    const payload = { live: [{ records: server.records(), databaseRecords: database.records(), stats: server.stats(), databaseStats: database.stats() }] };
    expect(buildCommandJourneyDoctor({ payload, commandId: "command-a", clientRecords: client.records(), clientStats: client.stats() })?.verdict).toBe("proven");
    expect(buildCommandJourneyDoctor({ payload, commandId: "command-b", clientRecords: client.records(), clientStats: client.stats() })).toBeUndefined();
  });
});
