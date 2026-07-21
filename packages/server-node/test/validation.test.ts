import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ReferenceServer } from "../src/index.ts";
import { signDemoCredential, verifyDemoCredential, type AuthenticatedPrincipal } from "../src/demo-auth.ts";

const servers: ReferenceServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.dispose())); });

const open = (url: string) => new Promise<WebSocket>((resolve, reject) => {
  const socket = new WebSocket(url, "better-realtime.v1");
  socket.once("open", () => resolve(socket)); socket.once("error", reject);
});

describe("demo authentication fixture", () => {
  const principal: AuthenticatedPrincipal = { tenantId: "tenant", authenticationRealm: "fixture", issuer: "issuer", subject: "subject", permissions: ["room:42:read"] };

  it("accepts an unexpired server-signed identity and rejects tampering or expiry", () => {
    const credential = signDemoCredential(principal, "test-key", { nowMs: 1_000, ttlMs: 1_000 });
    expect(verifyDemoCredential({ type: "demo", credential }, "test-key", 1_500)).toEqual(principal);
    expect(() => verifyDemoCredential({ type: "demo", credential: `${credential}x` }, "test-key", 1_500)).toThrow("RT_AUTH_REQUIRED");
    expect(() => verifyDemoCredential({ type: "demo", credential }, "test-key", 2_000)).toThrow("RT_AUTH_REQUIRED");
  });
});
const receive = (socket: WebSocket) => new Promise<Record<string, unknown>>((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
const sessionOpen = { protocol: "1.0", kind: "session.open", messageId: "msg_open", sentAt: new Date().toISOString(), connectionAttemptId: "attempt_1", contract: { contractId: "test", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth: {} } as const;
const contract = sessionOpen.contract;

describe("reference server protocol boundaries", () => {
  it.each([
    { intervalMs: Number.NaN, timeoutMs: 1_000 },
    { intervalMs: Number.POSITIVE_INFINITY, timeoutMs: 1_000 },
    { intervalMs: 300_001, timeoutMs: 1_000 },
    { intervalMs: 1_000.5, timeoutMs: 1_000 },
    { intervalMs: 1_000, timeoutMs: 999 }
  ])("rejects a heartbeat outside the wire-schema bounds: %#", (heartbeat) => {
    expect(() => new ReferenceServer({ port: 0, contract, heartbeat })).toThrow("heartbeat policy violates protocol bounds");
  });

  it("rejects malformed JSON with structured evidence before dispatch", async () => {
    const server = new ReferenceServer({ port: 0, contract }); servers.push(server); await server.start();
    const socket = await open(server.webSocketUrl);
    const received = new Promise<Record<string, unknown>>((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
    socket.send("{");
    expect(await received).toMatchObject({ kind: "error", error: { code: "RT_MESSAGE_INVALID", scope: "message" } });
    await new Promise((resolve) => socket.once("close", resolve));
    expect(server.recorder.records().some((record) => record.boundary === "message.rejected" && record.reasonCode === "RT_MESSAGE_INVALID")).toBe(true);
  });

  it.each([
    { ...contract, contractId: "different.contract" },
    { ...contract, manifestVersion: "2.0.0" }
  ])("rejects a contradictory contract identity even when the digest matches: %o", async (candidate) => {
    const server = new ReferenceServer({ port: 0, contract }); servers.push(server); await server.start();
    const socket = await open(server.webSocketUrl);
    socket.send(JSON.stringify({ ...sessionOpen, messageId: `msg_identity_${crypto.randomUUID()}`, connectionAttemptId: `attempt_${crypto.randomUUID()}`, contract: candidate }));
    expect(await receive(socket)).toMatchObject({ kind: "session.rejected", error: { code: "RT_CONTRACT_INCOMPATIBLE" } });
    await new Promise((resolve) => socket.once("close", resolve));
  });

  it("enforces the 1 MiB ws maxPayload before application dispatch", async () => {
    const server = new ReferenceServer({ port: 0, contract }); servers.push(server); await server.start();
    const socket = await open(server.webSocketUrl);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send("x".repeat(1_048_577));
    expect(await closed).toBe(1009);
    expect(server.store.inspect().commands).toBe(0);
    expect(server.recorder.records().some((record) => record.boundary === "message.rejected" && record.reasonCode === "RT_MESSAGE_TOO_LARGE")).toBe(true);
  });

  it("rejects a valid server-only message sent in the client-to-server direction", async () => {
    const server = new ReferenceServer({ port: 0, contract }); servers.push(server); await server.start();
    const socket = await open(server.webSocketUrl);
    const readyPromise = receive(socket); socket.send(JSON.stringify(sessionOpen)); const ready = await readyPromise;
    expect(ready).toMatchObject({ kind: "session.ready", capabilities: { durableReplay: false, idempotentCommands: false, commandReceipts: false } });
    expect(ready).not.toHaveProperty("resumeToken");
    expect(ready).not.toHaveProperty("resumeExpiresAt");
    const errorPromise = receive(socket); const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(JSON.stringify(ready));
    expect(await errorPromise).toMatchObject({ kind: "error", error: { code: "RT_MESSAGE_INVALID", scope: "message" } });
    expect(await closed).toBe(1008);
    expect(server.recorder.records().some((record) => record.kind === "protocol.direction_rejected" && record.details?.kind === "session.ready")).toBe(true);
  });

  it("disconnects an outbound slow consumer before exceeding its byte bound", async () => {
    const server = new ReferenceServer({ port: 0, contract, maxOutboundBufferedBytes: 64 }); servers.push(server); await server.start();
    const socket = await open(server.webSocketUrl);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(JSON.stringify(sessionOpen));
    expect(await closed).toBe(1013);
    expect(server.recorder.records().some((record) => record.boundary === "slow_consumer.disconnected" && record.reasonCode === "RT_SLOW_CONSUMER")).toBe(true);
  });
});
