import { describe, expect, it, vi } from "vitest";
import { FlightRecorder, ResourceRegistry, ResourceScope, doctor } from "../src/index.ts";

describe("bounded diagnostics", () => {
  const commandOperation = `opcorr:sha256:${"a".repeat(64)}` as const;
  const outboxOperation = `opcorr:sha256:${"b".repeat(64)}` as const;
  it("evicts explicitly at record bounds", () => {
    const recorder = new FlightRecorder({ runtimeId: "test", producerRole: "client", limits: { maxRecords: 2, maxBytes: 50_000, maxAgeMs: 60_000 } });
    for (const boundary of ["transport.opened", "session.accepted", "client.event_applied"]) recorder.record({ kind: "boundary", boundary, outcome: "success", component: "client", componentVersion: "test" });
    expect(recorder.records()).toHaveLength(2);
    expect(recorder.stats().evictedRecords).toBe(1);
  });

  it("reports the last success and first divergent boundary without guessing", () => {
    const client = new FlightRecorder({ runtimeId: "client-test", runtimeBootId: "client-boot", producerRole: "client" });
    const server = new FlightRecorder({ runtimeId: "server-test", runtimeBootId: "server-boot", producerRole: "server" });
    client.record({ kind: "boundary", boundary: "transport.opened", outcome: "success", component: "client", componentVersion: "test", traceId: "recovery-1" });
    server.record({ kind: "boundary", boundary: "session.accepted", outcome: "failure", reasonCode: "RT_AUTH_REQUIRED", component: "gateway", componentVersion: "test", traceId: "recovery-1" });
    const report = doctor({ records: [...client.records(), ...server.records()], expectedBoundaries: [{ producerRole: "client", boundary: "transport.opened" }, { producerRole: "server", boundary: "session.accepted" }, { producerRole: "client", boundary: "client.event_applied" }], expectedProducers: ["client", "server"], scope: { traceId: "recovery-1" }, expectedOutcome: "converged" });
    expect(report.verdict).toBe("disproven");
    expect(report.issues[0]?.lastSuccessfulBoundary).toMatchObject({ status: "known", value: "client:transport.opened" });
    expect(report.issues[0]?.firstDivergentBoundary).toMatchObject({ status: "known", value: "server:session.accepted" });
  });

  it("does not prove an out-of-order boundary chain", () => {
    const recorder = new FlightRecorder({ runtimeId: "test", producerRole: "client" });
    recorder.record({ kind: "boundary", boundary: "session.accepted", outcome: "success", component: "server", componentVersion: "test" });
    recorder.record({ kind: "boundary", boundary: "transport.opened", outcome: "success", component: "client", componentVersion: "test" });
    recorder.record({ kind: "boundary", boundary: "client.event_applied", outcome: "success", component: "client", componentVersion: "test" });
    const report = doctor({ records: recorder.records(), expectedBoundaries: [{ producerRole: "client", boundary: "transport.opened" }, { producerRole: "client", boundary: "session.accepted" }, { producerRole: "client", boundary: "client.event_applied" }], expectedProducers: ["client"], expectedOutcome: "converged" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.lastSuccessfulBoundary).toMatchObject({ status: "known", value: "client:transport.opened" });
    expect(report.issues[0]?.firstDivergentBoundary).toMatchObject({ status: "unknown" });
  });

  it("does not treat a client-observed server component label as server producer evidence", () => {
    const client = new FlightRecorder({ runtimeId: "client-test", producerRole: "client" });
    client.record({ kind: "wire.received", boundary: "client.session_ready_observed", outcome: "success", component: "server", componentVersion: "test", traceId: "recovery-2" });
    const report = doctor({ records: client.records(), expectedBoundaries: [{ producerRole: "client", boundary: "client.session_ready_observed" }, { producerRole: "server", boundary: "session.accepted" }], expectedProducers: ["client", "server"], scope: { traceId: "recovery-2" }, expectedOutcome: "accepted" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.completeness).toMatchObject({ status: "partial", observedProducers: ["client"], missingProducers: ["server"] });
  });

  it("does not join boundaries from different correlation scopes", () => {
    const client = new FlightRecorder({ runtimeId: "client-test", producerRole: "client" });
    const server = new FlightRecorder({ runtimeId: "server-test", producerRole: "server" });
    server.record({ kind: "replay.selected", boundary: "replay.selected", outcome: "success", component: "gateway", componentVersion: "test", traceId: "replay-a", stream: "room:42" });
    client.record({ kind: "event.applied", boundary: "client.event_applied", outcome: "success", component: "client", componentVersion: "test", traceId: "replay-b", stream: "room:42" });
    const report = doctor({ records: [...server.records(), ...client.records()], expectedBoundaries: [{ producerRole: "server", boundary: "replay.selected" }, { producerRole: "client", boundary: "client.event_applied" }], expectedProducers: ["server", "client"], scope: { traceId: "replay-a", stream: "room:42" }, expectedOutcome: "converged" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.completeness.missingProducers).toEqual(["client"]);
  });

  it("requires explicit correlation scope for multi-producer proof", () => {
    const client = new FlightRecorder({ runtimeId: "client-test", producerRole: "client" });
    const server = new FlightRecorder({ runtimeId: "server-test", producerRole: "server" });
    server.record({ kind: "replay.selected", boundary: "replay.selected", outcome: "success", component: "gateway", componentVersion: "test" });
    client.record({ kind: "event.applied", boundary: "client.event_applied", outcome: "success", component: "client", componentVersion: "test" });
    const report = doctor({ records: [...server.records(), ...client.records()], expectedBoundaries: [{ producerRole: "server", boundary: "replay.selected" }, { producerRole: "client", boundary: "client.event_applied" }], expectedProducers: ["server", "client"], scope: { stream: "room:42" }, expectedOutcome: "converged" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.code).toBe("RT_EVIDENCE_SCOPE_REQUIRED");
  });

  it("does not stitch one producer role across different runtime boots", () => {
    const firstBoot = new FlightRecorder({ runtimeId: "server-test", runtimeBootId: "boot-a", producerRole: "server" });
    const secondBoot = new FlightRecorder({ runtimeId: "server-test", runtimeBootId: "boot-b", producerRole: "server" });
    firstBoot.record({ kind: "replay.selected", boundary: "replay.selected", outcome: "success", component: "gateway", componentVersion: "test", traceId: "replay-c" });
    secondBoot.record({ kind: "event.delivery_attempted", boundary: "event.delivery_attempted", outcome: "success", component: "gateway", componentVersion: "test", traceId: "replay-c" });
    const report = doctor({ records: [...firstBoot.records(), ...secondBoot.records()], expectedBoundaries: [{ producerRole: "server", boundary: "replay.selected" }, { producerRole: "server", boundary: "event.delivery_attempted" }], expectedProducers: ["server"], scope: { traceId: "replay-c" }, expectedOutcome: "delivered" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.firstDivergentBoundary).toMatchObject({ status: "unknown" });
  });

  it("requires every exact producer instance in a two-gateway topology", () => {
    const gatewayA = new FlightRecorder({ runtimeId: "gateway-a", runtimeBootId: "boot-a", producerRole: "server" });
    gatewayA.record({ kind: "boundary", boundary: "session.accepted", outcome: "success", component: "gateway", componentVersion: "test", traceId: "handoff-1" });
    const report = doctor({ records: gatewayA.records(), expectedBoundaries: [{ producerRole: "server", runtimeId: "gateway-a", runtimeBootId: "boot-a", boundary: "session.accepted" }], expectedProducers: ["server"], expectedProducerInstances: [{ producerRole: "server", runtimeId: "gateway-a", runtimeBootId: "boot-a" }, { producerRole: "server", runtimeId: "gateway-b", runtimeBootId: "boot-b" }], scope: { traceId: "handoff-1" }, expectedOutcome: "two gateway recovery" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.completeness.missingProducerInstances).toEqual([{ producerRole: "server", runtimeId: "gateway-b", runtimeBootId: "boot-b" }]);
  });

  it("does not join the same command ID across different event-scoped operations", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    const server = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "gateway-boot", producerRole: "server" });
    const client = new FlightRecorder({ runtimeId: "browser", runtimeBootId: "browser-boot", producerRole: "client" });
    database.record({ kind: "db", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", commandId: "same-command", eventId: "event-a", causalHandoffId: "event:event-a" });
    server.record({ kind: "server", boundary: "command.completed", outcome: "success", component: "gateway", componentVersion: "test", commandId: "same-command", eventId: "event-b", causalHandoffId: "event:event-b" });
    client.record({ kind: "client", boundary: "command.observed", outcome: "success", component: "client", componentVersion: "test", commandId: "same-command", eventId: "event-a", causalHandoffId: "event:event-a" });
    const report = doctor({ records: [...database.records(), ...server.records(), ...client.records()], expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }, { producerRole: "server", boundary: "command.completed" }, { producerRole: "client", boundary: "command.observed" }], expectedProducers: ["database", "server", "client"], scope: { eventId: "event-a" }, expectedOutcome: "one command operation", requireCausalHandoffs: true });
    expect(report.verdict).toBe("indeterminate");
    expect(report.completeness.missingProducers).toEqual(["server"]);
  });

  it("does not splice required boundaries across conflicting command attempts", () => {
    const server = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "gateway-boot", producerRole: "server" });
    const shared = { component: "gateway", componentVersion: "test", principalNamespaceId: "principal-a", commandId: "command-retried" } as const;
    server.record({ kind: "command.received", boundary: "command.received", outcome: "success", commandAttemptId: "attempt-1", ...shared });
    server.record({ kind: "command.received", boundary: "command.received", outcome: "failure", reasonCode: "RT_LATE_FAILURE", commandAttemptId: "attempt-2", ...shared });
    server.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", commandAttemptId: "attempt-2", ...shared });

    const report = doctor({
      records: server.records(),
      expectedBoundaries: [{ producerRole: "server", boundary: "command.received" }, { producerRole: "server", boundary: "command.completed" }],
      expectedProducers: ["server"],
      scope: { commandId: "command-retried" },
      expectedOutcome: "one command attempt completed"
    });

    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.summary).toContain("commandAttemptId");
  });

  it("treats missing attempt identity as ambiguous and retains distinct bounded witnesses", () => {
    const server = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "gateway-boot", producerRole: "server" });
    const shared = { component: "gateway", componentVersion: "test", principalNamespaceId: "principal-a", commandId: "command-mixed-identity" } as const;
    server.record({ kind: "command.received", boundary: "command.received", outcome: "success", ...shared });
    for (let index = 0; index < 16; index += 1) server.record({ kind: "command.received", boundary: "command.received", outcome: "success", commandAttemptId: "attempt-1", ...shared });
    server.record({ kind: "command.received", boundary: "command.received", outcome: "failure", reasonCode: "RT_LATE_FAILURE", commandAttemptId: "attempt-2", ...shared });
    server.record({ kind: "command.completed", boundary: "command.completed", outcome: "success", commandAttemptId: "attempt-2", ...shared });

    const report = doctor({ records: server.records(), expectedBoundaries: [{ producerRole: "server", boundary: "command.received" }, { producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server"], scope: { commandId: "command-mixed-identity" }, expectedOutcome: "one command attempt completed" });

    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.code).toBe("RT_DIAGNOSTIC_SCOPE_AMBIGUOUS");
    const witnessedAttempts = new Set(report.evidenceClosure.map((entry) => entry.commandAttemptId ?? "<missing>"));
    expect(witnessedAttempts.has("<missing>")).toBe(true);
    expect(witnessedAttempts.has("attempt-2")).toBe(true);
    expect(new Set(report.evidenceClosure.map((entry) => entry.outcome))).toEqual(new Set(["success", "failure"]));
    expect(report.evidenceClosure.length).toBeLessThanOrEqual(4);
  });

  it("requires an explicit cross-runtime causal handoff and never compares local sequences globally", () => {
    const gatewayA = new FlightRecorder({ runtimeId: "gateway-a", runtimeBootId: "boot-a", producerRole: "server" });
    const gatewayB = new FlightRecorder({ runtimeId: "gateway-b", runtimeBootId: "boot-b", producerRole: "server" });
    gatewayA.record({ kind: "boundary", boundary: "gateway.drain_started", outcome: "success", component: "gateway", componentVersion: "test", traceId: "handoff-2", causalHandoffId: "handoff:a-to-b" });
    gatewayB.record({ kind: "boundary", boundary: "replay.selected", outcome: "success", component: "gateway", componentVersion: "test", traceId: "handoff-2", causalHandoffId: "handoff:a-to-b" });
    const options = { records: [...gatewayA.records(), ...gatewayB.records()], expectedBoundaries: [{ producerRole: "server" as const, runtimeId: "gateway-a", runtimeBootId: "boot-a", boundary: "gateway.drain_started" }, { producerRole: "server" as const, runtimeId: "gateway-b", runtimeBootId: "boot-b", boundary: "replay.selected" }], expectedProducers: ["server" as const], expectedProducerInstances: [{ producerRole: "server" as const, runtimeId: "gateway-a", runtimeBootId: "boot-a" }, { producerRole: "server" as const, runtimeId: "gateway-b", runtimeBootId: "boot-b" }], scope: { traceId: "handoff-2" }, expectedOutcome: "handoff", requireCausalHandoffs: true };
    expect(doctor(options).verdict).toBe("proven");
    const withoutHandoff = options.records.map(({ causalHandoffId: _causalHandoffId, ...record }) => record);
    expect(doctor({ ...options, records: withoutHandoff }).verdict).toBe("indeterminate");
  });

  it("reports SIGKILL producer evidence loss as partial and indeterminate", () => {
    const gatewayA = new FlightRecorder({ runtimeId: "gateway-a", runtimeBootId: "boot-a", producerRole: "server" });
    gatewayA.record({ kind: "boundary", boundary: "transport.opened", outcome: "success", component: "gateway", componentVersion: "test", traceId: "kill-1" });
    const instance = { producerRole: "server" as const, runtimeId: "gateway-a", runtimeBootId: "boot-a" };
    const report = doctor({ records: gatewayA.records(), expectedBoundaries: [{ ...instance, boundary: "transport.opened" }], expectedProducers: ["server"], expectedProducerInstances: [instance], unavailableProducerInstances: [instance], scope: { traceId: "kill-1" }, expectedOutcome: "abrupt recovery" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.completeness.status).toBe("partial");
  });

  it("does not prove a journey with an unresolved indeterminate database transaction", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", commandId: "command-current", eventId: "event-current" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", commandId: "command-current", eventId: "event-current", details: { resolution: "rolled_back", proofSource: "same_connection_rollback" } });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-other", commandId: "command-current", eventId: "event-current" });
    const report = doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId: "command-current", eventId: "event-current" }, expectedOutcome: "current transaction committed" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.code).toBe("RT_TRANSACTION_OUTCOME_INDETERMINATE");
  });

  it("accepts serialized durable reconciliation for the exact indeterminate transaction", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-current", eventId: "event-current" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-current", eventId: "event-current", details: { resolution: "committed", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-current", eventId: "event-current", details: { proofSource: "durable_transaction_attempt_marker" } });
    const report = doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId: "command-current", eventId: "event-current" }, expectedOutcome: "current transaction committed" });
    expect(report.verdict).toBe("proven");
  });

  it("does not use another producer instance to resolve an indeterminate transaction", () => {
    const original = new FlightRecorder({ runtimeId: "database-a", runtimeBootId: "db-a-boot", producerRole: "database" });
    const unrelated = new FlightRecorder({ runtimeId: "database-b", runtimeBootId: "db-b-boot", producerRole: "database" });
    original.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-shared", transactionOperation: "command", commandId: "command-shared" });
    unrelated.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-shared", transactionOperation: "command", commandId: "command-shared", details: { resolution: "committed", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    unrelated.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-shared", commandId: "command-shared" });
    const report = doctor({ records: [...original.records(), ...unrelated.records()], expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId: "command-shared" }, expectedOutcome: "exact producer transaction resolved" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.code).toBe("RT_TRANSACTION_OUTCOME_INDETERMINATE");
  });

  it("does not use an older transaction commit after the selected operation reconciles rolled back", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-old", transactionOperation: "command", commandId: "command-current", eventId: "event-current" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", commandId: "command-current", eventId: "event-current" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", commandId: "command-current", eventId: "event-current", details: { resolution: "rolled_back", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    const report = doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { commandId: "command-current", eventId: "event-current" }, expectedOutcome: "current transaction committed" });
    expect(report.verdict).toBe("indeterminate");
  });

  it("does not use an older command success when the current correlated operation rolled back with another event", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-old", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-current", eventId: "event-old", stream: "room" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-current", eventId: "event-new", stream: "room" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-current", eventId: "event-new", stream: "room", details: { resolution: "rolled_back", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    expect(doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: commandOperation }, expectedOutcome: "latest command committed" }).verdict).toBe("indeterminate");
  });

  it("does not use an older outbox notification when the current correlated publication rolled back", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "outbox.notify_committed", boundary: "outbox.notify_committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-old", transactionOperation: "outbox_publish", operationCorrelationId: outboxOperation, eventId: "event" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "outbox_publish", operationCorrelationId: outboxOperation, eventId: "event" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "outbox_publish", operationCorrelationId: outboxOperation, eventId: "event", details: { resolution: "rolled_back", proofSource: "durable_transaction_attempt_marker", serialization: "outbox_row_lock" } });
    expect(doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "outbox.notify_committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: outboxOperation }, expectedOutcome: "latest publication committed" }).verdict).toBe("indeterminate");
  });

  it("selects only the current notification after current durable reconciliation", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "outbox.notify_committed", boundary: "outbox.notify_committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-old", transactionOperation: "outbox_publish", operationCorrelationId: outboxOperation, eventId: "event" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "outbox_publish", operationCorrelationId: outboxOperation, eventId: "event" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "outbox_publish", operationCorrelationId: outboxOperation, eventId: "event", details: { resolution: "committed", proofSource: "durable_transaction_attempt_marker", serialization: "outbox_row_lock" } });
    const current = database.record({ kind: "outbox.notify_committed", boundary: "outbox.notify_committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "outbox_publish", operationCorrelationId: outboxOperation, eventId: "event" });
    const report = doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "outbox.notify_committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: outboxOperation }, expectedOutcome: "latest publication committed" });
    expect(report.verdict).toBe("proven");
    expect(report.issues).toEqual([]);
    expect(current.transactionId).toBe("tx-current");
  });

  it("does not supersede a same command ID in another tenant/principal operation namespace", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    const otherOperation = `opcorr:sha256:${"c".repeat(64)}` as const;
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-a", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-b", transactionOperation: "command", operationCorrelationId: otherOperation, commandId: "same" });
    expect(doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: commandOperation }, expectedOutcome: "tenant A command committed" }).verdict).toBe("proven");
  });

  it("does not choose an unscoped transaction across producer instances for one operation", () => {
    const first = new FlightRecorder({ runtimeId: "gateway-a:postgres", runtimeBootId: "db-a", producerRole: "database" });
    const second = new FlightRecorder({ runtimeId: "gateway-b:postgres", runtimeBootId: "db-b", producerRole: "database" });
    first.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-old", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same" });
    second.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same" });
    second.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-current", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same", details: { resolution: "rolled_back", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    const records = [...first.records(), ...second.records()];
    expect(doctor({ records, expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: commandOperation }, expectedOutcome: "selected transaction committed" }).verdict).toBe("indeterminate");
    expect(doctor({ records, expectedBoundaries: [{ producerRole: "database", runtimeId: "gateway-a:postgres", runtimeBootId: "db-a", boundary: "db.committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: commandOperation }, expectedOutcome: "explicit old transaction committed" }).verdict).toBe("proven");
  });

  it("requires a runtime boot ID when one runtime has multiple boots for an operation", () => {
    const oldBoot = new FlightRecorder({ runtimeId: "gateway:postgres", runtimeBootId: "old-boot", producerRole: "database" });
    const newBoot = new FlightRecorder({ runtimeId: "gateway:postgres", runtimeBootId: "new-boot", producerRole: "database" });
    oldBoot.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-old", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same" });
    newBoot.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-new", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same" });
    newBoot.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-new", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same", details: { resolution: "rolled_back", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    const records = [...oldBoot.records(), ...newBoot.records()];
    expect(doctor({ records, expectedBoundaries: [{ producerRole: "database", runtimeId: "gateway:postgres", boundary: "db.committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: commandOperation }, expectedOutcome: "selected boot committed" }).verdict).toBe("indeterminate");
    expect(doctor({ records, expectedBoundaries: [{ producerRole: "database", runtimeId: "gateway:postgres", runtimeBootId: "old-boot", boundary: "db.committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: commandOperation }, expectedOutcome: "explicit old boot committed" }).verdict).toBe("proven");
  });

  it("does not treat a later duplicate-read cleanup as a new outcome attempt", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-committed", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same", eventId: "event" });
    database.record({ kind: "database.transaction_cleanup_attempted", boundary: "database.transaction_cleanup_attempted", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-duplicate-read", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "same", details: { outcomeProof: false } });
    expect(doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { operationCorrelationId: commandOperation }, expectedOutcome: "durable command remains committed" }).verdict).toBe("proven");
  });

  it("rejects reconciliation proof from another operation even with the same transaction ID", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-shared", transactionOperation: "command", commandId: "command-current", eventId: "event-current" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-shared", transactionOperation: "snapshot_read", commandId: "command-current", eventId: "event-current", details: { resolution: "no_durable_effect", proofSource: "repeatable_read_read_only_discard_and_retry", serialization: "fresh_repeatable_read_read_only_attempt" } });
    const report = doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { transactionId: "tx-shared", commandId: "command-current", eventId: "event-current" }, expectedOutcome: "command committed" });
    expect(report.verdict).toBe("indeterminate");
  });

  it("keeps every event in an unresolved outbox batch indeterminate", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    for (const eventId of ["event-a", "event-b"]) database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-batch", transactionOperation: "outbox_publish", eventId, causalHandoffId: "transaction:tx-batch" });
    database.record({ kind: "outbox.notify_committed", boundary: "outbox.notify_committed", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-old", transactionOperation: "outbox_publish", eventId: "event-b" });
    const report = doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "outbox.notify_committed" }], expectedProducers: ["database"], scope: { eventId: "event-b" }, expectedOutcome: "outbox commit resolved" });
    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.code).toBe("RT_TRANSACTION_OUTCOME_INDETERMINATE");
  });

  it("keeps a gateway observation separate while following the exact database transaction handoff", () => {
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database" });
    const gateway = new FlightRecorder({ runtimeId: "gateway", runtimeBootId: "gateway-boot", producerRole: "server" });
    database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: "tx-observed", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-observed", causalHandoffId: "transaction:tx-observed" });
    database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: "tx-observed", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-observed", causalHandoffId: "transaction:tx-observed", details: { resolution: "committed", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    gateway.record({ kind: "gateway.transaction_outcome_indeterminate_observed", boundary: "gateway.transaction_outcome_indeterminate_observed", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "gateway", componentVersion: "test", transactionId: "tx-observed", transactionOperation: "command", operationCorrelationId: commandOperation, commandId: "command-observed", causalHandoffId: "transaction:tx-observed", details: { observer: "gateway", producerClaimed: false } });
    const report = doctor({ records: [...database.records(), ...gateway.records()], expectedBoundaries: [{ producerRole: "database", boundary: "database.transaction_reconciled" }, { producerRole: "server", boundary: "gateway.transaction_outcome_indeterminate_observed" }], expectedProducers: ["database", "server"], scope: { transactionId: "tx-observed", commandId: "command-observed" }, expectedOutcome: "exact transaction observed", requireCausalHandoffs: true });
    expect(report.verdict).toBe("indeterminate");
    expect(report.issues[0]?.firstDivergentBoundary).toMatchObject({ status: "known", value: "server:gateway.transaction_outcome_indeterminate_observed" });
  });

  it("indexes large reconciliation journeys instead of rescanning evidence quadratically", () => {
    const count = 6_000;
    const database = new FlightRecorder({ runtimeId: "database", runtimeBootId: "db-boot", producerRole: "database", limits: { maxRecords: count * 2 + 1, maxBytes: 64 * 1024 * 1024, maxAgeMs: 60_000 } });
    const correlations: Array<`opcorr:sha256:${string}`> = [];
    for (let index = 0; index < count; index += 1) {
      const correlation = `opcorr:sha256:${index.toString(16).padStart(64, "0")}` as const;
      correlations.push(correlation);
      database.record({ kind: "database.transaction_outcome_indeterminate", boundary: "database.transaction_outcome_indeterminate", outcome: "unknown", reasonCode: "RT_TRANSACTION_OUTCOME_INDETERMINATE", component: "store", componentVersion: "test", transactionId: `tx-${index}`, transactionOperation: "command", operationCorrelationId: correlation, commandId: `command-${index}`, stream: "performance" });
    }
    for (let index = 0; index < count; index += 1) database.record({ kind: "database.transaction_reconciled", boundary: "database.transaction_reconciled", outcome: "success", component: "store", componentVersion: "test", transactionId: `tx-${index}`, transactionOperation: "command", operationCorrelationId: correlations[index]!, commandId: `command-${index}`, stream: "performance", details: { resolution: "committed", proofSource: "durable_transaction_attempt_marker", serialization: "pg_advisory_xact_lock" } });
    database.record({ kind: "database.transaction_committed", boundary: "db.committed", outcome: "success", component: "store", componentVersion: "test", stream: "performance" });
    const startedAt = performance.now();
    const report = doctor({ records: database.records(), expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }], expectedProducers: ["database"], scope: { stream: "performance" }, expectedOutcome: "all reconciled" });
    expect(report.verdict).toBe("proven");
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });
});

describe("resource ownership", () => {
  it("releases in reverse order and is idempotent", async () => {
    const recorder = new FlightRecorder({ runtimeId: "test", producerRole: "client" });
    const registry = new ResourceRegistry(recorder);
    const scope = new ResourceScope(registry, "owner");
    const order: number[] = [];
    scope.acquire("listener", () => { order.push(1); });
    scope.acquire("timer", () => { order.push(2); });
    await scope.dispose();
    await scope.dispose();
    expect(order).toEqual([2, 1]);
    expect(registry.active()).toHaveLength(0);
  });

  it("records release failures", async () => {
    const recorder = new FlightRecorder({ runtimeId: "test", producerRole: "client" });
    const registry = new ResourceRegistry(recorder);
    const scope = new ResourceScope(registry);
    scope.acquire("adapter", vi.fn(() => { throw new Error("boom"); }));
    await expect(scope.dispose()).rejects.toThrow("resource scope cleanup failed");
    await expect(scope.dispose()).rejects.toThrow("resource scope cleanup failed");
    expect(scope.machine.state).toBe("disposing");
    expect(registry.active()).toMatchObject([{ state: "failed" }]);
    expect(recorder.records().some((record) => record.boundary === "resource.release_failed")).toBe(true);
  });
});
