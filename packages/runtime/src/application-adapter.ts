import type { AnyRealtimeContract, JsonValue } from "./contract.js";

export function validatePreparedEvent(
  contract: AnyRealtimeContract,
  stream: string,
  event: string,
  data: unknown
): { type: string; schema: string; data: JsonValue; sequence: number } {
  const eventManifest = contract.manifest.streams[stream]?.events[event];
  if (!eventManifest) throw new Error(`RT_CONTRACT_STREAM_EVENT_UNKNOWN:${stream}.${event}`);
  return contract.validateStreamEvent(stream, {
    type: event,
    schema: eventManifest.schema,
    data,
    sequence: 1
  }) as { type: string; schema: string; data: JsonValue; sequence: number };
}
