import { ReferenceTransportConnection, abortError, type SocketLike, type TransportConnection, type TransportFactory } from "./shared.js";
import { BETTER_REALTIME_SUBPROTOCOL } from "@realtime/protocol/constants";

export type { TransportConnection, TransportFactory } from "./shared.js";

export class BrowserWebSocketTransport implements TransportFactory {
  readonly #connectTimeoutMs: number;
  #quarantinedSocket: WebSocket | undefined;
  constructor(private readonly url: string, private readonly WebSocketImpl: typeof WebSocket = WebSocket, options: { connectTimeoutMs?: number } = {}) {
    const timeout = options.connectTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) throw new Error("RT_TRANSPORT_CONNECT_TIMEOUT_INVALID");
    this.#connectTimeoutMs = timeout;
  }
  connect(signal?: AbortSignal): Promise<TransportConnection> {
    if (this.#quarantinedSocket) return Promise.reject(new Error("RT_TRANSPORT_CLOSE_PENDING"));
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url, BETTER_REALTIME_SUBPROTOCOL);
      let lateCloseArmed = false;
      const timer = setTimeout(timedOut, this.#connectTimeoutMs);
      const releaseLateClose = () => {
        if (!lateCloseArmed) return;
        lateCloseArmed = false;
        socket.removeEventListener("open", closeOnLateOpen);
        socket.removeEventListener("error", releaseLateClose);
        socket.removeEventListener("close", releaseLateClose);
        if (this.#quarantinedSocket === socket) this.#quarantinedSocket = undefined;
      };
      const cleanup = () => { clearTimeout(timer); socket.removeEventListener("open", opened); socket.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted); };
      const opened = () => { cleanup(); resolve(new ReferenceTransportConnection(socket as unknown as SocketLike)); };
      const closeOnLateOpen = () => {
        try { socket.close(1000, "late connection closed"); } catch { /* retain quarantine until the implementation reports close or error */ }
      };
      const closePendingSocket = (reason: string) => {
        try { socket.close(1000, reason); }
        catch {
          lateCloseArmed = true;
          this.#quarantinedSocket = socket;
          socket.addEventListener("open", closeOnLateOpen, { once: true });
          socket.addEventListener("error", releaseLateClose, { once: true });
          socket.addEventListener("close", releaseLateClose, { once: true });
        }
      };
      const failed = () => { cleanup(); closePendingSocket("connection failed"); reject(new Error("WebSocket transport failed to open")); };
      const aborted = () => { cleanup(); closePendingSocket("connection aborted"); reject(abortError()); };
      function timedOut() { cleanup(); closePendingSocket("connection timeout"); reject(new Error("RT_TRANSPORT_CONNECT_TIMEOUT")); }
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
}
