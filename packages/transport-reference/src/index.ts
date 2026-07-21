import WebSocketNode from "ws";
import { BETTER_REALTIME_SUBPROTOCOL } from "@realtime/protocol/constants";
import { ReferenceTransportConnection, abortError, type SocketLike, type TransportConnection, type TransportFactory } from "./shared.js";

export { BrowserWebSocketTransport } from "./browser.js";
export type { TransportConnection, TransportFactory } from "./shared.js";

export class NodeWebSocketTransport implements TransportFactory {
  readonly #connectTimeoutMs: number;
  constructor(private readonly url: string, options: { connectTimeoutMs?: number } = {}) {
    this.#connectTimeoutMs = connectTimeout(options.connectTimeoutMs);
  }
  connect(signal?: AbortSignal): Promise<TransportConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketNode(this.url, BETTER_REALTIME_SUBPROTOCOL, { handshakeTimeout: this.#connectTimeoutMs });
      const timer = setTimeout(timedOut, this.#connectTimeoutMs);
      const cleanup = () => { clearTimeout(timer); socket.off("open", opened); socket.off("error", failed); signal?.removeEventListener("abort", aborted); };
      const opened = () => { cleanup(); resolve(new ReferenceTransportConnection(socket as unknown as SocketLike)); };
      const failed = (error: Error) => { cleanup(); socket.once("error", () => undefined); socket.terminate(); reject(error); };
      const aborted = () => { cleanup(); socket.once("error", () => undefined); socket.terminate(); reject(abortError()); };
      function timedOut() { cleanup(); socket.once("error", () => undefined); socket.terminate(); reject(new Error("RT_TRANSPORT_CONNECT_TIMEOUT")); }
      socket.once("open", opened);
      socket.once("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
}

function connectTimeout(value = 10_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new Error("RT_TRANSPORT_CONNECT_TIMEOUT_INVALID");
  return value;
}
