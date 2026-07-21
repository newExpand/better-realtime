import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { InvalidTransitionError, ProtocolStateMachine, assertCapabilityInvariants, isClientToServerMessage, isServerToClientMessage, manifestDigest, validateWireValue, type Capabilities } from "../src/index.ts";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../../../conformance/v1/fixtures/${name}`, import.meta.url), "utf8"));

describe("wire protocol validator", () => {
  it("accepts the canonical valid fixtures", async () => {
    expect(validateWireValue(await fixture("valid-session-open.json")).ok).toBe(true);
    expect(validateWireValue(await fixture("valid-session-ready.json")).ok).toBe(true);
  });

  it("rejects the red invalid fixture", async () => {
    const result = validateWireValue(await fixture("invalid-session-open.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RT_MESSAGE_INVALID");
  });

  it("returns a validation failure for values that JSON cannot encode", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateWireValue(cyclic)).toMatchObject({ ok: false, code: "RT_MESSAGE_INVALID" });
    expect(validateWireValue({ value: 1n })).toMatchObject({ ok: false, code: "RT_MESSAGE_INVALID" });
    expect(validateWireValue(undefined)).toMatchObject({ ok: false, code: "RT_MESSAGE_INVALID" });
  });

  it("canonicalizes manifest keys before digesting", () => {
    expect(manifestDigest({ b: 2, a: 1 })).toBe(manifestDigest({ a: 1, b: 2 }));
  });

  it("classifies validated messages by wire direction", async () => {
    const clientMessage = validateWireValue(await fixture("valid-session-open.json"));
    const serverMessage = validateWireValue(await fixture("valid-session-ready.json"));
    expect(clientMessage.ok && isClientToServerMessage(clientMessage.value)).toBe(true);
    expect(serverMessage.ok && isServerToClientMessage(serverMessage.value)).toBe(true);
  });

  it("mechanically enforces commandResultRetentionMs not exceeding idempotencyRetentionMs", () => {
    const capabilities: Capabilities = { schemaValidation: true, eventIdentity: true, ordering: "per_stream", gapDetection: true, durableReplay: true, replayRetentionMs: 60_000, snapshotResync: "fenced", idempotentCommands: true, commandReceipts: true, commandResultRetentionMs: 60_000, idempotencyRetentionMs: 120_000, maxMessageBytes: 1_048_576, maxRecoveryBufferRecords: 100, maxRecoveryBufferBytes: 1_048_576 };
    expect(() => assertCapabilityInvariants(capabilities)).not.toThrow();
    expect(() => assertCapabilityInvariants({ ...capabilities, commandResultRetentionMs: 0 })).toThrow("RT_CAPABILITY_RETENTION_INVALID");
    expect(() => assertCapabilityInvariants({ ...capabilities, commandResultRetentionMs: 120_001 })).toThrow("RT_CAPABILITY_RETENTION_INVALID");
  });

  it("validates bounded producer-issued causal event positions for snapshot observation", () => {
    const completed = { protocol: "1.0", kind: "command.completed", messageId: "message", sentAt: new Date().toISOString(), commandId: "command", schema: "result@1", result: { ok: true }, causalEventIds: ["event"], causalEvents: [{ eventId: "event", stream: "room:42", sequence: 4 }] };
    expect(validateWireValue(completed).ok).toBe(true);
    expect(validateWireValue({ ...completed, causalEvents: [{ eventId: "event", stream: "room:42", sequence: 0 }] }).ok).toBe(false);
  });
});

describe("normative state machine", () => {
  it("runs only declared transitions", () => {
    const stream = new ProtocolStateMachine("stream");
    expect(stream.transition("subscribe.requested").to).toBe("subscribing");
    expect(stream.transition("stream.subscribed.replay").to).toBe("replaying");
    expect(stream.transition("stream.replay.begin").to).toBe("replaying");
    expect(stream.transition("stream.replay.complete").to).toBe("live");
    expect(() => stream.transition("stream.replay.complete")).toThrow(InvalidTransitionError);
  });

  it("mechanically permits explicit recovery requests after gap and overflow states", () => {
    const gap = new ProtocolStateMachine("stream", "live");
    expect(gap.transition("gap.detected").to).toBe("replaying");
    expect(gap.transition("recovery.requested").to).toBe("subscribing");
    const overflow = new ProtocolStateMachine("stream", "resyncing");
    expect(overflow.transition("recovery_buffer.overflow").to).toBe("resyncing");
    expect(overflow.transition("recovery.requested").to).toBe("subscribing");
  });
});
