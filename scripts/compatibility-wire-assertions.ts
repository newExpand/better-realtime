export interface CommandOutcomeIdentity {
  commandId?: string;
  schema?: string;
  result?: unknown;
  causalEventIds?: string[];
  causalEvents?: Array<{ eventId?: string; stream?: string; sequence?: number }>;
}
export interface IdempotencyEffectObservation { commandRows: number; eventRows: number; domainEffectRows: number; eventId?: string; domainEventId?: string }

const capabilityFields = [
  "schemaValidation", "eventIdentity", "ordering", "gapDetection", "durableReplay", "snapshotResync",
  "idempotentCommands", "commandReceipts", "clientApplyAck", "eventDedupeWindowMs", "replayRetentionMs",
  "commandResultRetentionMs", "idempotencyRetentionMs", "maxMessageBytes", "maxRecoveryBufferRecords",
  "maxRecoveryBufferBytes"
] as const;

export function canonicalCapabilityProfile(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || Object.keys(value).sort().join("\n") !== [...capabilityFields].sort().join("\n")) throw new Error("RT_COMPAT_CAPABILITY_PROFILE_INCOMPLETE");
  const booleanFields = ["schemaValidation", "eventIdentity", "gapDetection", "durableReplay", "idempotentCommands", "commandReceipts", "clientApplyAck"] as const;
  const positiveFields = ["eventDedupeWindowMs", "replayRetentionMs", "commandResultRetentionMs", "idempotencyRetentionMs", "maxMessageBytes", "maxRecoveryBufferRecords", "maxRecoveryBufferBytes"] as const;
  if (booleanFields.some((field) => typeof value[field] !== "boolean") || positiveFields.some((field) => !Number.isSafeInteger(value[field]) || Number(value[field]) <= 0) || value.ordering !== "per_stream" || value.snapshotResync !== "fenced") throw new Error("RT_COMPAT_CAPABILITY_PROFILE_INVALID");
  if (value.schemaValidation !== true || value.eventIdentity !== true || value.gapDetection !== true || value.durableReplay !== true || value.idempotentCommands !== true || value.commandReceipts !== true || value.clientApplyAck !== false) throw new Error("RT_COMPAT_CAPABILITY_SEMANTICS_DRIFT");
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function assertMatrixCapabilityProfiles(profiles: Array<{ id: string; capabilityProfile: Record<string, unknown> }>): void {
  const baseline = profiles.find((entry) => entry.id === "candidate-client-to-alpha1-server")?.capabilityProfile;
  if (!baseline || profiles.length !== 3 || profiles.some((entry) => JSON.stringify(entry.capabilityProfile) !== JSON.stringify(baseline))) throw new Error("RT_COMPAT_CAPABILITY_PROFILE_DRIFT");
}

export function assertIdempotencyRetry(
  commandId: string,
  attemptIds: [string, string],
  first: CommandOutcomeIdentity,
  retry: CommandOutcomeIdentity,
  status: CommandOutcomeIdentity,
  effect: IdempotencyEffectObservation
): Record<string, boolean> {
  if (!commandId || attemptIds[0] === attemptIds[1] || attemptIds.some((attemptId) => !attemptId || attemptId === commandId)) throw new Error("RT_COMPAT_IDEMPOTENCY_ATTEMPT_IDENTITY_DRIFT");
  if ([first, retry, status].some((outcome) => outcome.commandId !== commandId)) throw new Error("RT_COMPAT_IDEMPOTENCY_COMMAND_ID_DRIFT");
  const identity = (outcome: CommandOutcomeIdentity) => canonical({ schema: outcome.schema, result: outcome.result, causalEventIds: outcome.causalEventIds, causalEvents: outcome.causalEvents });
  if (identity(first) !== identity(retry) || identity(first) !== identity(status)) throw new Error(`RT_COMPAT_IDEMPOTENCY_RESULT_IDENTITY_DRIFT:${identity(first)}:${identity(retry)}:${identity(status)}`);
  const sequence = (first.result as { sequence?: unknown } | undefined)?.sequence;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1 || !Array.isArray(first.causalEventIds) || first.causalEventIds.length !== 1 || first.causalEvents?.length !== 1 || first.causalEvents[0]?.eventId !== first.causalEventIds[0] || first.causalEvents[0]?.sequence !== sequence) throw new Error("RT_COMPAT_IDEMPOTENCY_RESULT_INVALID");
  if (effect.commandRows !== 1 || effect.eventRows !== 1 || effect.domainEffectRows !== 1 || effect.eventId !== first.causalEventIds[0] || effect.domainEventId !== first.causalEventIds[0]) throw new Error("RT_COMPAT_IDEMPOTENCY_DUPLICATE_EFFECT");
  return { sameCommandRetry: true, freshRetryAttemptIds: true, duplicateEffectSuppressed: true, stableStatusIdentity: true };
}

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`; return JSON.stringify(value); }
