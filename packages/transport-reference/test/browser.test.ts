import { expect, it } from "vitest";
import { BrowserWebSocketTransport } from "../src/browser.ts";

class FailingWebSocket {
  static instances: FailingWebSocket[] = [];
  readonly bufferedAmount = 0;
  readyState = 0;
  closeCount = 0;
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor() {
    FailingWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("error", {}));
  }

  addEventListener(type: string, listener: (...args: any[]) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (...args: any[]) => void): void { this.listeners.get(type)?.delete(listener); }
  send(): void {}
  close(): void { this.closeCount += 1; this.readyState = 3; }
  emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

class HangingWebSocket {
  static instances: HangingWebSocket[] = [];
  readonly bufferedAmount = 0;
  readyState = 0;
  closeCount = 0;
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  constructor() {
    HangingWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (...args: any[]) => void): void { const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners); }
  removeEventListener(type: string, listener: (...args: any[]) => void): void { this.listeners.get(type)?.delete(listener); }
  send(): void {}
  close(): void { this.closeCount += 1; this.readyState = 3; }
}

class ThrowingCloseWebSocket extends HangingWebSocket {
  override close(): void {
    this.closeCount += 1;
    if (this.readyState === 0) throw new Error("close while connecting");
    this.readyState = 2;
  }
  emit(type: string, event: unknown): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

it("closes and detaches every physical socket after repeated open failures", async () => {
  FailingWebSocket.instances = [];
  const transport = new BrowserWebSocketTransport("ws://fixture.invalid", FailingWebSocket as unknown as typeof WebSocket);
  for (let attempt = 0; attempt < 100; attempt += 1) await expect(transport.connect()).rejects.toThrow("failed to open");
  expect(FailingWebSocket.instances).toHaveLength(100);
  for (const socket of FailingWebSocket.instances) {
    expect(socket.closeCount).toBe(1);
    expect([...socket.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)).toBe(0);
  }
});

it("bounds a browser handshake that never opens", async () => {
  HangingWebSocket.instances = [];
  const transport = new BrowserWebSocketTransport("ws://fixture.invalid", HangingWebSocket as unknown as typeof WebSocket, { connectTimeoutMs: 10 });
  await expect(transport.connect()).rejects.toThrow("RT_TRANSPORT_CONNECT_TIMEOUT");
  expect(HangingWebSocket.instances[0]?.closeCount).toBe(1);
  expect([...HangingWebSocket.instances[0]!.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)).toBe(0);
});

it("rejects invalid browser connect deadlines", () => {
  for (const connectTimeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY, 300_001]) expect(() => new BrowserWebSocketTransport("ws://fixture.invalid", HangingWebSocket as unknown as typeof WebSocket, { connectTimeoutMs })).toThrow("RT_TRANSPORT_CONNECT_TIMEOUT_INVALID");
});

it("quarantines one CONNECTING close failure until a delayed open is closed", async () => {
  HangingWebSocket.instances = [];
  const transport = new BrowserWebSocketTransport("ws://fixture.invalid", ThrowingCloseWebSocket as unknown as typeof WebSocket, { connectTimeoutMs: 10 });
  const pending = transport.connect();
  await expect(pending).rejects.toThrow("RT_TRANSPORT_CONNECT_TIMEOUT");
  const socket = HangingWebSocket.instances.at(-1) as ThrowingCloseWebSocket;
  await expect(transport.connect()).rejects.toThrow("RT_TRANSPORT_CLOSE_PENDING");
  expect(HangingWebSocket.instances).toHaveLength(1);
  socket.emit("open", {});
  expect(socket.closeCount).toBe(2);
  socket.emit("close", {});
  expect([...socket.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)).toBe(0);
});
