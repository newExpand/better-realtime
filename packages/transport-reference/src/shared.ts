export interface TransportConnection {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: (event: { code: number; reason: string }) => void): () => void;
}

export interface TransportFactory {
  connect(signal?: AbortSignal): Promise<TransportConnection>;
}

export const abortError = () => Object.assign(new Error("WebSocket connection aborted"), { name: "AbortError" });

export interface SocketLike {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
}

export class ReferenceTransportConnection implements TransportConnection {
  constructor(private readonly socket: SocketLike) {}
  get bufferedAmount(): number { return this.socket.bufferedAmount; }
  send(data: string): void { this.socket.send(data); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
  onMessage(listener: (data: string) => void): () => void {
    const wrapped = (event: { data: unknown }) => listener(typeof event.data === "string" ? event.data : String(event.data));
    this.socket.addEventListener("message", wrapped);
    return () => this.socket.removeEventListener("message", wrapped);
  }
  onClose(listener: (event: { code: number; reason: string }) => void): () => void {
    this.socket.addEventListener("close", listener);
    return () => this.socket.removeEventListener("close", listener);
  }
}
