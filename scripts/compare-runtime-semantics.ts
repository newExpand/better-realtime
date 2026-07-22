import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

interface RuntimeApi {
  jsonSchema(name: string, schema: Record<string, unknown>): unknown;
  stream(value: Record<string, unknown>): unknown;
  command(value: Record<string, unknown>): unknown;
  defineRealtimeContract(value: Record<string, unknown>): { identity: Record<string, string> };
  createRealtimeClient(contract: unknown, options: Record<string, unknown>): {
    connect(): Promise<void>;
    stream(name: string, input: unknown): { subscribe(listener: () => void): () => void; getSnapshot(): Record<string, unknown> };
    execute(name: string, input: unknown): { commandId: string; state: string; completed: Promise<unknown>; observed: Promise<void> };
    runtimeSnapshot(): Record<string, unknown>;
    dispose(): Promise<void>;
  };
}

interface WireRecord { kind: string; messageId?: string; commandId?: string; commandAttemptId?: string; eventId?: string; [key: string]: unknown }

export async function compareRuntimeSemantics(baselinePackage: string, candidatePackage: string): Promise<Record<string, unknown>> {
  const baseline = await scenarioOutcome(baselinePackage);
  if (baseline.status !== "passed") throw new Error(`RT_COMPAT_BASELINE_RUNTIME_SCENARIO_FAILED:${baseline.error}`);
  const candidate = await scenarioOutcome(candidatePackage);
  const baselineSha256 = semanticHash(baseline);
  const candidateSha256 = semanticHash(candidate);
  return {
    baseline,
    candidate,
    ...(baselineSha256 === candidateSha256 ? {} : { change: { surface: "runtimeSemantics", path: "black-box-command-observation", baselineSha256, candidateSha256, ...runtimeSemanticRequirement(candidate.status) } })
  };
}

export function runtimeSemanticRequirement(candidateStatus: "passed" | "failed"): { requiredClassification?: "intentionally_breaking" } { return candidateStatus === "failed" ? { requiredClassification: "intentionally_breaking" } : {}; }

async function scenarioOutcome(packageDirectory: string): Promise<{ status: "passed"; value: Record<string, unknown> } | { status: "failed"; error: string }> {
  try { return { status: "passed", value: await runRuntimeScenario(packageDirectory) }; }
  catch (error) { return { status: "failed", error: normalizeError(error) }; }
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^(RT_[A-Z0-9_]+)/u.exec(message)?.[1];
  return code ?? (error instanceof TypeError ? "TypeError" : "runtime-scenario-failed");
}

function semanticHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runRuntimeScenario(packageDirectory: string): Promise<Record<string, unknown>> {
  const api = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href) as RuntimeApi;
  const object = api.jsonSchema("compat.runtime.object@1", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } });
  const result = api.jsonSchema("compat.runtime.result@1", { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } });
  const contract = api.defineRealtimeContract({
    contractId: "compat.runtime",
    manifestVersion: "1.0.0",
    streams: { item: api.stream({ input: object, snapshot: object, events: { changed: object }, key: ({ id }: { id: string }) => `item:${id}`, initial: ({ id }: { id: string }) => ({ id }), applyEvent: (_state: unknown, event: { data: unknown }) => event.data, snapshotSequence: () => 0 }) },
    commands: { update: api.command({ input: object, result }) }
  });
  const transcript: { sent: WireRecord[]; received: WireRecord[] } = { sent: [], received: [] };
  const WebSocketImpl = scenarioWebSocket(transcript);
  const client = api.createRealtimeClient(contract, { url: "ws://compat.invalid/realtime", auth: () => ({ tenantId: "tenant-compat" }), webSocket: WebSocketImpl, reconnectDelaysMs: [10] });
  let release: () => void = () => undefined;
  try {
    await client.connect();
    await waitFor(() => client.runtimeSnapshot().sessionState === "ready");
    const handle = client.stream("item", { id: "1" });
    release = handle.subscribe(() => undefined);
    await waitFor(() => handle.getSnapshot().status === "live");
    const attempt = client.execute("update", { id: "1" });
    const completed = await attempt.completed;
    await attempt.observed;
    await waitFor(() => handle.getSnapshot().sequence === 1);
    const command = transcript.sent.find((message) => message.kind === "command");
    const receipt = transcript.received.find((message) => message.kind === "command.receipt");
    const completion = transcript.received.find((message) => message.kind === "command.completed");
    const event = transcript.received.find((message) => message.kind === "event");
    const causalEventIds = completion?.causalEventIds as string[] | undefined;
    if (!command?.messageId || !command.commandAttemptId || command.commandId !== attempt.commandId || receipt?.commandId !== attempt.commandId || completion?.commandId !== attempt.commandId || event?.commandId !== attempt.commandId || event.eventId === command.messageId || event.eventId !== causalEventIds?.[0]) throw new Error("RT_COMPAT_RUNTIME_IDENTITY_SEMANTICS_INVALID");
    return {
      sentKinds: transcript.sent.map((message) => message.kind),
      receivedKinds: transcript.received.map((message) => message.kind),
      distinctAttemptIdentity: command.commandAttemptId !== command.commandId && command.messageId !== command.commandAttemptId,
      completion: completed,
      attemptState: attempt.state,
      runtime: client.runtimeSnapshot(),
      stream: handle.getSnapshot()
    };
  } finally {
    release();
    await client.dispose();
  }
}

function scenarioWebSocket(transcript: { sent: WireRecord[]; received: WireRecord[] }) {
  return class ScenarioWebSocket {
    static readonly OPEN = 1;
    readonly bufferedAmount = 0;
    readyState = 0;
    #listeners = new Map<string, Set<(event: unknown) => void>>();
    #subscriptionId = "subscription-compat";
    constructor(_url: string | URL, protocols?: string | string[]) {
      if (protocols !== "better-realtime.v1" && !(Array.isArray(protocols) && protocols.includes("better-realtime.v1"))) throw new Error("RT_COMPAT_SUBPROTOCOL_NOT_REQUESTED");
      queueMicrotask(() => { this.readyState = 1; this.#emit("open", {}); });
    }
    addEventListener(type: string, listener: (event: unknown) => void): void { const listeners = this.#listeners.get(type) ?? new Set(); listeners.add(listener); this.#listeners.set(type, listeners); }
    removeEventListener(type: string, listener: (event: unknown) => void): void { this.#listeners.get(type)?.delete(listener); }
    send(data: string): void {
      const message = JSON.parse(data) as WireRecord;
      transcript.sent.push(message);
      if (message.kind === "session.open") this.#receive({ kind: "session.ready", sessionId: "session-compat", sessionGeneration: 1, authGeneration: 1, resumeStatus: "fresh", capabilities: { schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true, durableReplay: true, replayRetentionMs: 60_000, snapshotResync: "fenced", idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 30_000, idempotencyRetentionMs: 60_000, maxMessageBytes: 1_048_576, maxRecoveryBufferRecords: 100, maxRecoveryBufferBytes: 1_048_576 }, heartbeat: { mode: "application", intervalMs: 60_000, timeoutMs: 60_000 } });
      if (message.kind === "stream.subscribe") this.#receive({ kind: "stream.subscribed", requestId: message.requestId, subscriptionId: this.#subscriptionId, stream: message.stream, mode: "live", baseline: null, head: null });
      if (message.kind === "command") {
        const eventId = "event-compat";
        this.#receive({ kind: "command.receipt", commandId: message.commandId, state: "accepted" });
        this.#receive({ kind: "command.completed", commandId: message.commandId, schema: "compat.runtime.result@1", result: { ok: true }, causalEventIds: [eventId], causalEvents: [{ eventId, stream: "item:1", sequence: 1 }] });
        this.#receive({ kind: "event", deliveryId: "delivery-compat", sessionGeneration: 1, deliveryMode: "live", eventId, stream: "item:1", sequence: 1, cursor: "cursor-1", type: "changed", schema: "compat.runtime.object@1", commandId: message.commandId, data: { id: "1" } });
      }
    }
    close(code = 1000, reason = "closed"): void { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.#emit("close", { code, reason })); }
    #receive(value: Record<string, unknown>): void {
      const record = { protocol: "1.0", messageId: `message-${transcript.received.length + 1}`, sentAt: "2026-07-21T00:00:00.000Z", ...value } as unknown as WireRecord;
      transcript.received.push(record);
      queueMicrotask(() => this.#emit("message", { data: JSON.stringify(record) }));
    }
    #emit(type: string, event: unknown): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("RT_COMPAT_RUNTIME_SCENARIO_TIMEOUT"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
