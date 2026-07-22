import { BETTER_REALTIME_VERSION, createRealtimeClient } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { appendBrowserEvidence, browserEvidenceBufferStatus, createBrowserEvidenceBuffer, type BrowserEvidenceBuffer } from "./browser-evidence-buffer.js";
import { contract } from "./contract.js";

export const client = createRealtimeClient(contract, {
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/realtime`,
  auth: () => ({ type: "fixture", tenantId: "tenant-fixture", subject: "browser-user" })
});

export const { useStream, useCommand, useRuntime } = createRealtimeReact(client);

const browserRuntimeBootId = crypto.randomUUID();
export interface BrowserCommandEvidence {
  schemaVersion: "1.0";
  recordId: string;
  recordSequence: number;
  kind: string;
  timestamp: string;
  monotonicNs: string;
  producerRole: "client";
  runtimeId: string;
  runtimeBootId: string;
  component: string;
  componentVersion: string;
  boundary: "command.observed";
  outcome: "success";
  commandId: string;
  eventId: string;
  causalHandoffId: string;
}

type DogfoodGlobal = typeof globalThis & {
  __BETTER_REALTIME_DOGFOOD_EVIDENCE__?: BrowserCommandEvidence[];
  __BETTER_REALTIME_DOGFOOD_EVIDENCE_BUFFER__?: BrowserEvidenceBuffer<BrowserCommandEvidence>;
  __BETTER_REALTIME_DOGFOOD_EVIDENCE_STATUS__?: () => ReturnType<typeof browserEvidenceBufferStatus>;
};
const dogfoodGlobal = globalThis as DogfoodGlobal;
const browserEvidenceBuffer = dogfoodGlobal.__BETTER_REALTIME_DOGFOOD_EVIDENCE_BUFFER__ ?? createBrowserEvidenceBuffer<BrowserCommandEvidence>();
if (!dogfoodGlobal.__BETTER_REALTIME_DOGFOOD_EVIDENCE_BUFFER__) {
  Object.defineProperties(dogfoodGlobal, {
    __BETTER_REALTIME_DOGFOOD_EVIDENCE__: { value: browserEvidenceBuffer.records, configurable: false, enumerable: false, writable: false },
    __BETTER_REALTIME_DOGFOOD_EVIDENCE_BUFFER__: { value: browserEvidenceBuffer, configurable: false, enumerable: false, writable: false },
    __BETTER_REALTIME_DOGFOOD_EVIDENCE_STATUS__: { value: () => browserEvidenceBufferStatus(browserEvidenceBuffer), configurable: false, enumerable: false, writable: false }
  });
}

export function recordBrowserCommandObserved(commandId: string, eventId: string): void {
  appendBrowserEvidence<BrowserCommandEvidence>(browserEvidenceBuffer, (recordSequence) => ({
    schemaVersion: "1.0",
    recordId: `browser-observed-${recordSequence}`,
    recordSequence,
    kind: "command.observed",
    timestamp: new Date().toISOString(),
    monotonicNs: String(Math.floor(performance.now() * 1_000_000)),
    producerRole: "client",
    runtimeId: "external-consumer-browser",
    runtimeBootId: browserRuntimeBootId,
    component: "external-consumer",
    componentVersion: BETTER_REALTIME_VERSION,
    boundary: "command.observed",
    outcome: "success",
    commandId,
    eventId,
    causalHandoffId: `event:${eventId}`
  }));
}

/** Application bootstrap owns terminal physical-runtime cleanup. */
export const disposeRealtimeClient = () => client.dispose();
