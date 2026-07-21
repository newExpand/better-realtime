import { FlightRecorder, LocalDiagnosticQuery, type LocalEvidenceBundleV1 } from "../packages/diagnostics/src/index.ts";

const recorder = new FlightRecorder({ runtimeId: "diagnostic-benchmark", runtimeBootId: "boot-benchmark", producerRole: "tool", limits: { maxRecords: 2_000, maxBytes: 4_000_000, maxAgeMs: 60_000 } });
for (let index = 0; index < 1_000; index += 1) recorder.record({ kind: "benchmark.record", boundary: "benchmark.record", outcome: "success", component: "diagnostic-benchmark", componentVersion: "1.0.0", commandId: `command-${index % 25}`, stream: `stream:${index % 10}`, principalNamespaceId: "principal-benchmark", details: { tenantId: "tenant-benchmark", principalNamespaceId: "principal-benchmark", payload: { secret: `value-${index}` } } });
const bundle: LocalEvidenceBundleV1 = { schemaVersion: "1.0", tenantId: "tenant-benchmark", payloadPolicy: "redacted", pseudonymizationKey: "diagnostic-benchmark-key-32-bytes-long", records: recorder.records().map((record) => ({ tenantId: "tenant-benchmark", record })), resourceCapture: "unavailable", loss: { droppedRecords: 0, evictedRecords: 0 }, expectedProducerInstances: [{ producerRole: "tool", runtimeId: recorder.runtimeId, runtimeBootId: recorder.runtimeBootId }] };
const query = new LocalDiagnosticQuery(bundle);
const iterations = 2_000;
const started = process.hrtime.bigint();
let bytes = 0;
for (let index = 0; index < iterations; index += 1) bytes += JSON.stringify(query.traceCommand({ tenantId: "tenant-benchmark", commandId: `command-${index % 25}`, limit: 25 })).length;
const elapsedNs = Number(process.hrtime.bigint() - started);
process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", records: 1_000, iterations, microsecondsPerQuery: elapsedNs / iterations / 1_000, serializedBytes: bytes, recorder: recorder.stats() })}\n`);
