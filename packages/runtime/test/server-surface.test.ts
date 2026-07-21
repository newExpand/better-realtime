import { describe, expect, expectTypeOf, it } from "vitest";
import type { Pool } from "pg";
import { command, defineRealtimeContract, jsonSchema, stream } from "../src/index.ts";
import { createRealtimeServer, postgres } from "../src/server.ts";
import { validatePreparedEvent } from "../src/application-adapter.ts";

const contract = defineRealtimeContract({
  contractId: "test.server-surface",
  manifestVersion: "1.0.0",
  streams: {
    room: stream({
      input: jsonSchema("test.server.item.input@1", { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }),
      snapshot: jsonSchema("test.server.item.snapshot@1", { type: "object", required: ["sequence"], properties: { sequence: { type: "integer" } }, additionalProperties: false }),
      events: { changed: jsonSchema("test.server.item.changed@1", { type: "object", required: ["value"], properties: { value: { type: "string" } }, additionalProperties: false }) },
      key: ({ id }) => `room:${id}`,
      initial: () => ({ sequence: 0 }),
      applyEvent: (_state, event) => ({ sequence: event.sequence }),
      snapshotSequence: (state) => state.sequence
    })
  },
  commands: {
    change: command({
      input: jsonSchema("test.server.change.input@1", { type: "object", required: ["id", "value"], properties: { id: { type: "string" }, value: { type: "string" } }, additionalProperties: false }),
      result: jsonSchema("test.server.change.result@1", { type: "object", required: ["changed"], properties: { changed: { type: "boolean" } }, additionalProperties: false })
    })
  }
});

const fakePool = { options: { connectionTimeoutMillis: 1_000 } } as Pool;
const profile = () => postgres({ pool: fakePool, identityKeys: [{ version: 1, key: new Uint8Array(32).fill(7) }] });
const validOptions = () => ({
  profile: profile(),
  runtimeId: "test-server",
  originPolicy: { allowedOrigins: ["https://app.example.test"] },
  authenticate: async () => ({ tenantId: "tenant", authenticationRealm: "test", issuer: "issuer", subject: "subject", permissions: [] }),
  streams: { room: { authorize: () => true, snapshot: () => ({ sequence: 0 }) } },
  commands: { change: { authorize: () => true, prepare: (_context: unknown, input: { id: string; value: string }) => ({ publish: { stream: "room" as const, input: { id: input.id }, event: "changed" as const, data: { value: input.value } }, mutate: () => ({ changed: true }) }) } }
});

describe("public server surface", () => {
  it("rejects missing, extra, or incomplete contract handlers before runtime allocation", () => {
    expect(() => createRealtimeServer(contract, { ...validOptions(), streams: {} as never })).toThrow("RT_CONTRACT_INVALID: server.streams");
    expect(() => createRealtimeServer(contract, { ...validOptions(), commands: { change: { authorize: () => true } } as never })).toThrow("RT_CONTRACT_INVALID: server.commands");
    expect(() => createRealtimeServer(contract, { ...validOptions(), streams: { ...validOptions().streams, extra: validOptions().streams.room } } as never)).toThrow("RT_CONTRACT_INVALID: server.streams");
  });

  it("copies identity-key material on input and every public read", () => {
    const original = new Uint8Array(32).fill(11);
    const configured = postgres({ pool: fakePool, identityKeys: [{ version: 1, key: original }] });
    original[0] = 99;
    const first = configured.identityKeys[0]!.key as Uint8Array;
    expect(first[0]).toBe(11);
    first[0] = 88;
    const second = configured.identityKeys[0]!.key as Uint8Array;
    expect(second[0]).toBe(11);
    expect(Object.isFrozen(configured.identityKeys)).toBe(true);
    expect(Object.isFrozen(configured.identityKeys[0])).toBe(true);
  });

  it("rejects weak, duplicate-version, and mutable-sized identity key sets", () => {
    expect(() => postgres({ pool: fakePool, identityKeys: [] })).toThrow("RT_POSTGRES_IDENTITY_KEYS_INVALID");
    expect(() => postgres({ pool: fakePool, identityKeys: [{ version: 1, key: "too-short" }] })).toThrow("RT_POSTGRES_IDENTITY_KEYS_INVALID");
    expect(() => postgres({ pool: fakePool, identityKeys: [{ version: 1, key: "a".repeat(32) }, { version: 1, key: "b".repeat(32) }] })).toThrow("RT_POSTGRES_IDENTITY_KEYS_INVALID");
  });

  it("requires a positive bounded application operation timeout", () => {
    expect(() => postgres({ pool: fakePool, identityKeys: [{ version: 1, key: "a".repeat(32) }], operationTimeoutMs: 0 })).toThrow("RT_OPERATION_TIMEOUT_INVALID");
    expect(() => postgres({ pool: fakePool, identityKeys: [{ version: 1, key: "a".repeat(32) }], operationTimeoutMs: Number.POSITIVE_INFINITY })).toThrow("RT_OPERATION_TIMEOUT_INVALID");
    expect(postgres({ pool: fakePool, identityKeys: [{ version: 1, key: "a".repeat(32) }], operationTimeoutMs: 250 }).operationTimeoutMs).toBe(250);
  });

  it("rejects unsafe PostgreSQL schema identifiers before allocating a server", () => {
    expect(() => postgres({ pool: fakePool, schema: "public;drop schema public", identityKeys: [{ version: 1, key: "a".repeat(32) }] })).toThrow("RT_POSTGRES_SCHEMA_INVALID");
    expect(postgres({ pool: fakePool, identityKeys: [{ version: 1, key: "a".repeat(32) }] }).schema).toBe("better_realtime");
  });

  it("exposes only a promise-based transaction query port to application handlers", async () => {
    const server = createRealtimeServer(contract, {
      ...validOptions(),
      streams: { room: { authorize: () => true, snapshot: async (context) => {
        expectTypeOf(context.db.query).toBeFunction();
        await context.db.query("SELECT 1", []);
        if (false) {
          // @ts-expect-error application code cannot release the transaction-owned connection
          context.db.release();
          // @ts-expect-error callback query overloads are intentionally unsupported
          context.db.query("SELECT 1", () => undefined);
          // @ts-expect-error Submittable/object query overloads are intentionally unsupported
          context.db.query({ submit: () => undefined });
        }
        return { sequence: 0 };
      } } }
    });
    expect(server.ready).toBe(false);
    await server.dispose();
  });

  it("validates a prepared event through a positive wire sequence", () => {
    expect(validatePreparedEvent(contract, "room", "changed", { value: "ready" })).toEqual({
      type: "changed",
      schema: "test.server.item.changed@1",
      data: { value: "ready" },
      sequence: 1
    });
    expect(() => validatePreparedEvent(contract, "room", "changed", { value: 42 })).toThrow("RT_CONTRACT_STREAM_EVENT_INVALID");
  });

  it("uses a fresh privacy domain for every exported evidence bundle", async () => {
    const server = createRealtimeServer(contract, validOptions());
    try {
      const first = server.evidenceBundle("tenant");
      const second = server.evidenceBundle("tenant");
      expect(first.pseudonymizationKey).toHaveLength(72);
      expect(second.pseudonymizationKey).toHaveLength(72);
      expect(first.pseudonymizationKey).not.toBe(second.pseudonymizationKey);
    } finally { await server.dispose(); }
  });
});
