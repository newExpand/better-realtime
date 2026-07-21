import { createServer } from "node:net";
import { expect, it } from "vitest";
import { NodeWebSocketTransport } from "../src/index.ts";

it("bounds and closes a Node WebSocket handshake that never responds", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.resume(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  try {
    const transport = new NodeWebSocketTransport(`ws://127.0.0.1:${address.port}`, { connectTimeoutMs: 25 });
    await expect(transport.connect()).rejects.toThrow(/timed out|RT_TRANSPORT_CONNECT_TIMEOUT/u);
    const started = Date.now();
    while (sockets.size > 0 && Date.now() - started < 500) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets.size).toBe(0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("rejects invalid Node connect deadlines", () => {
  for (const connectTimeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY, 300_001]) expect(() => new NodeWebSocketTransport("ws://fixture.invalid", { connectTimeoutMs })).toThrow("RT_TRANSPORT_CONNECT_TIMEOUT_INVALID");
});
