import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startConsumerTestProxy, type ConsumerTestProxy } from "../scripts/consumer-test-proxy.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dispose) => dispose())); });

it("bounds messages queued while the selected upstream handshake is stalled", async () => {
  const upstreamSockets = new Set<Duplex>();
  const upstream = createServer((request, response) => { response.statusCode = request.url === "/health" ? 200 : 404; response.end(); });
  upstream.on("upgrade", (_request, socket) => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture bind failed");
  const proxy = await startConsumerTestProxy({ staticRoot: process.cwd(), gateways: [`ws://127.0.0.1:${address.port}/ws`] });
  cleanup.push(() => dispose(proxy, upstream, upstreamSockets));

  const socket = new WebSocket(proxy.webSocketUrl);
  await onceOpen(socket);
  const closed = onceClose(socket);
  for (let index = 0; index < 101; index += 1) socket.send("{}");
  await expect(closed).resolves.toMatchObject({ code: 1013, reason: "upstream queue exceeded" });
});

it("enforces a one MiB inbound message bound", async () => {
  const upstreamSockets = new Set<Duplex>();
  const upstream = createServer((request, response) => { response.statusCode = request.url === "/health" ? 200 : 404; response.end(); });
  upstream.on("upgrade", (_request, socket) => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture bind failed");
  const proxy = await startConsumerTestProxy({ staticRoot: process.cwd(), gateways: [`ws://127.0.0.1:${address.port}/ws`] });
  cleanup.push(() => dispose(proxy, upstream, upstreamSockets));

  const socket = new WebSocket(proxy.webSocketUrl);
  await onceOpen(socket);
  const closed = onceClose(socket);
  socket.send("x".repeat(1_048_577));
  await expect(closed).resolves.toMatchObject({ code: 1009 });
});

it("keeps reconnect selection history bounded while preserving a total counter", async () => {
  const upstreamSockets = new Set<Duplex>();
  const upstream = createServer((request, response) => { response.statusCode = request.url === "/health" ? 200 : 404; response.end(); });
  upstream.on("upgrade", (_request, socket) => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture bind failed");
  const gateway = `ws://127.0.0.1:${address.port}/ws`;
  const proxy = await startConsumerTestProxy({ staticRoot: process.cwd(), gateways: [gateway] });
  cleanup.push(() => dispose(proxy, upstream, upstreamSockets));

  for (let index = 0; index < 140; index += 1) {
    const socket = new WebSocket(proxy.webSocketUrl);
    await onceOpen(socket);
    const closed = onceClose(socket);
    socket.close(1000, "fixture complete");
    await closed;
  }
  expect(proxy.state.selectedGatewayTotal).toBe(140);
  expect(proxy.state.selectedGateways).toHaveLength(128);
  expect(new Set(proxy.state.selectedGateways)).toEqual(new Set([gateway]));
});

it("disconnects a downstream consumer before the proxy absorbs an unbounded gateway queue", async () => {
  const upstreamSockets = new Set<Duplex>();
  const upstream = createServer((request, response) => { response.statusCode = request.url === "/health" ? 200 : 404; response.end(); });
  const gateway = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (request, socket, head) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    gateway.handleUpgrade(request, socket, head, (client) => gateway.emit("connection", client, request));
  });
  gateway.on("connection", (client) => client.send("x".repeat(65)));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture bind failed");
  const proxy = await startConsumerTestProxy({ staticRoot: process.cwd(), gateways: [`ws://127.0.0.1:${address.port}/ws`], maxDownstreamQueueBytes: 64 });
  cleanup.push(async () => { await proxy.close(); for (const socket of upstreamSockets) socket.destroy(); await new Promise<void>((resolve) => gateway.close(() => resolve())); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const frontend = new WebSocket(proxy.webSocketUrl);
  const closed = onceClose(frontend);
  await expect(closed).resolves.toMatchObject({ code: 1013, reason: "downstream queue exceeded" });
  expect(proxy.state.downstreamOverflows).toBe(1);
});

it("uses the required realtime subprotocol on the selected gateway connection", async () => {
  const upstreamSockets = new Set<Duplex>();
  const upstream = createServer((request, response) => { response.statusCode = request.url === "/health" ? 200 : 404; response.end(); });
  const gateway = new WebSocketServer({ noServer: true });
  let selectedProtocol: string | undefined;
  upstream.on("upgrade", (request, socket, head) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    selectedProtocol = request.headers["sec-websocket-protocol"];
    if (selectedProtocol !== "better-realtime.v1") { socket.destroy(); return; }
    gateway.handleUpgrade(request, socket, head, (client) => gateway.emit("connection", client, request));
  });
  gateway.on("connection", (client) => client.send("ready"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture bind failed");
  const proxy = await startConsumerTestProxy({ staticRoot: process.cwd(), gateways: [`ws://127.0.0.1:${address.port}/ws`] });
  cleanup.push(async () => { await proxy.close(); for (const socket of upstreamSockets) socket.destroy(); await new Promise<void>((resolve) => gateway.close(() => resolve())); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });

  const frontend = new WebSocket(proxy.webSocketUrl, "better-realtime.v1");
  await onceOpen(frontend);
  await new Promise<void>((resolve, reject) => { frontend.once("message", () => resolve()); frontend.once("error", reject); });
  expect(selectedProtocol).toBe("better-realtime.v1");
  frontend.close(1000, "fixture complete");
});

function onceOpen(socket: WebSocket): Promise<void> { return new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }); }
function onceClose(socket: WebSocket): Promise<{ code: number; reason: string }> { return new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))); }
async function dispose(proxy: ConsumerTestProxy, upstream: ReturnType<typeof createServer>, sockets: Set<Duplex>): Promise<void> {
  await proxy.close();
  for (const socket of sockets) socket.destroy();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
}
