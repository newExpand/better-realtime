import { createRealtimeClient, type ContractStreams, type RealtimeClientOptions } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { createRealtimeServer, type CommandHandlers, type ContractPublish, type RealtimeServerOptions } from "better-realtime/server";
import type { DiagnosticQueryResult, DoctorQueryDefinition, EvidenceBundleV1 } from "better-realtime/diagnostics";
import { contract } from "./contract.js";
import { notificationContract } from "./notification-fixture.js";

declare const client: ReturnType<typeof createRealtimeClient<typeof contract>>;
// @ts-expect-error nonexistent stream name
client.stream("missing", {});
// @ts-expect-error invalid inferred stream input
client.stream("room", { id: "42" });
// @ts-expect-error nonexistent command name
client.execute("missing", {});
// @ts-expect-error invalid inferred command input
client.execute("sendMessage", { roomId: "42" });

declare const notificationClientOptions: RealtimeClientOptions;
declare const notificationServerOptions: RealtimeServerOptions<typeof notificationContract>;
function verifySecondFacadeTypes() {
  const notificationClient = createRealtimeClient(notificationContract, notificationClientOptions);
  notificationClient.stream("feed", { userId: "user-1" });
  notificationClient.execute("markRead", { id: "notification-1" });
  const notificationReact = createRealtimeReact(notificationClient);
  notificationReact.useStream("feed", { userId: "user-1" });
  notificationReact.useCommand("markRead");
  createRealtimeServer(notificationContract, notificationServerOptions);
  // @ts-expect-error the notification fixture has no room stream
  notificationClient.stream("room", { roomId: "42" });
  // @ts-expect-error markRead requires a notification id
  notificationClient.execute("markRead", { userId: "user-1" });
  // @ts-expect-error the second server must implement the notification command map
  createRealtimeServer(notificationContract, { ...notificationServerOptions, commands: {} });
}
void verifySecondFacadeTypes;

type RoomDefinition = ContractStreams<typeof contract>["room"];
// @ts-expect-error materializers must return the declared snapshot shape
const invalidMaterializer: RoomDefinition["applyEvent"] = () => ({ messages: [], sequence: "wrong" });
// @ts-expect-error prepared event data must match the selected stream event schema
const invalidPreparedEvent: ContractPublish<typeof contract> = { stream: "room", input: { roomId: "42" }, event: "messageAdded", data: { author: 42, text: "hello", sentAt: new Date(0).toISOString() } };
// @ts-expect-error command mutation results must match the declared result schema
const invalidCommandMutation: Awaited<ReturnType<CommandHandlers<typeof contract>["sendMessage"]["prepare"]>>["mutate"] = async () => ({ messageId: "evt", sequence: "wrong" });
void invalidMaterializer;
void invalidPreparedEvent;
void invalidCommandMutation;

const externalEvidence: EvidenceBundleV1 = {
  schemaVersion: "1.0",
  tenantId: "tenant-external",
  payloadPolicy: "redacted",
  pseudonymizationKey: "fixture-only-not-a-production-secret",
  records: [{ tenantId: "tenant-external", record: { schemaVersion: "1.0", recordId: "record-1", recordSequence: 1, kind: "command.completed", timestamp: new Date(0).toISOString(), monotonicNs: "1", component: "consumer", componentVersion: "1", outcome: "success", producerRole: "server", runtimeId: "gateway", runtimeBootId: "boot", commandId: "command-1", principalNamespaceId: "principal-1" } }],
  resourceCapture: "unavailable",
  loss: { droppedRecords: 0, evictedRecords: 0 },
  expectedProducerInstances: [{ producerRole: "server", runtimeId: "gateway", runtimeBootId: "boot" }]
};
const externalDoctor: DoctorQueryDefinition = { expectedBoundaries: [{ producerRole: "server", boundary: "command.completed" }], expectedProducers: ["server"], expectedOutcome: "completed", scope: { commandId: "command-1", principalNamespaceId: "principal-1" } };
externalEvidence.records[0]!.record.transactionOperation = "command";
// @ts-expect-error details-only operation names cannot become top-level transaction proof
externalEvidence.records[0]!.record.transactionOperation = "command_status";
void externalEvidence;
void externalDoctor;

declare const externalDiagnosticResult: DiagnosticQueryResult;
if (externalDiagnosticResult.kind === "doctor") externalDiagnosticResult.report.verdict satisfies "proven" | "disproven" | "indeterminate";
else if (externalDiagnosticResult.kind === "trace_command") externalDiagnosticResult.records[0]?.principalNamespaceId;
else if (externalDiagnosticResult.kind === "inspect_stream") externalDiagnosticResult.stream;
else if (externalDiagnosticResult.kind === "leaks") externalDiagnosticResult.activeCount;
else externalDiagnosticResult.coveredRanges;
