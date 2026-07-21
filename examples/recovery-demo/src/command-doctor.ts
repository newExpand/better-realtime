import { doctor, type DoctorReport, type EvidenceRecord, type ProducerInstance } from "@realtime/diagnostics";

export function buildCommandJourneyDoctor(options: {
  payload: unknown;
  commandId: string | undefined;
  clientRecords: readonly EvidenceRecord[];
  clientStats: { droppedRecords: number; evictedRecords: number };
}): DoctorReport | undefined {
  if (!options.commandId) return undefined;
  const clientRecord = [...options.clientRecords].reverse().find((record) => record.boundary === "command.observed" && record.commandId === options.commandId);
  if (!clientRecord?.eventId) return undefined;
  const bundles = evidenceBundles(options.payload);
  const serverRecords = bundles.flatMap((bundle) => records(bundle.records));
  const databaseRecords = bundles.flatMap((bundle) => records(bundle.databaseRecords));
  const serverRecord = serverRecords.find((record) => record.commandId === options.commandId && record.eventId === clientRecord.eventId && (record.boundary === "command.completed" || record.boundary === "command.status_reconciled"));
  const databaseRecord = databaseRecords.find((record) => record.commandId === options.commandId && record.eventId === clientRecord.eventId && record.boundary === "db.committed");
  if (!serverRecord || !databaseRecord) return undefined;
  const expectedProducerInstances: ProducerInstance[] = [instance(databaseRecord), instance(serverRecord), instance(clientRecord)];
  const stats = bundles.reduce<{ dropped: number; evicted: number }>((totals, bundle) => {
    const value = bundle.stats as { droppedRecords?: number; evictedRecords?: number } | undefined;
    const databaseValue = bundle.databaseStats as { droppedRecords?: number; evictedRecords?: number } | undefined;
    return { dropped: totals.dropped + (value?.droppedRecords ?? 0) + (databaseValue?.droppedRecords ?? 0), evicted: totals.evicted + (value?.evictedRecords ?? 0) + (databaseValue?.evictedRecords ?? 0) };
  }, { dropped: options.clientStats.droppedRecords, evicted: options.clientStats.evictedRecords });
  return doctor({
    records: [...databaseRecords, ...serverRecords, ...options.clientRecords],
    expectedBoundaries: [
      { ...expectedProducerInstances[0]!, boundary: "db.committed" },
      { ...expectedProducerInstances[1]!, boundary: serverRecord.boundary! },
      { ...expectedProducerInstances[2]!, boundary: "command.observed" }
    ],
    expectedProducers: ["database", "server", "client"],
    expectedProducerInstances,
    requireCausalHandoffs: true,
    scope: { commandId: options.commandId, eventId: clientRecord.eventId },
    droppedRecords: stats.dropped,
    evictedRecords: stats.evicted,
    expectedOutcome: "database commit, gateway completion, and browser causal observation converge for one stable command"
  });
}

function evidenceBundles(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const root = value as { archived?: unknown[]; live?: unknown[] };
  return [...(root.archived ?? []), ...(root.live ?? [])].filter((bundle): bundle is Record<string, unknown> => typeof bundle === "object" && bundle !== null && !Array.isArray(bundle));
}
function records(value: unknown): EvidenceRecord[] { return Array.isArray(value) ? value as EvidenceRecord[] : []; }
function instance(record: EvidenceRecord): ProducerInstance { return { producerRole: record.producerRole, runtimeId: record.runtimeId, runtimeBootId: record.runtimeBootId }; }
