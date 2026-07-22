import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export interface ConsumerTestProxy {
  readonly baseUrl: string;
  readonly webSocketUrl: string;
  readonly state: { selectedGateways: string[]; selectedGatewayTotal: number; downstreamOverflows: number; transcript: WireTranscriptEntry[]; lastCommandId?: string; droppedCommandId?: string };
  dropNextCommandCompletion(): void;
  close(): Promise<void>;
}

export interface WireTranscriptEntry {
  direction: "client_to_server" | "server_to_client";
  connection: number;
  kind: string;
  messageId?: string;
  commandId?: string;
  commandAttemptId?: string;
  requestId?: string;
  eventId?: string;
  deliveryId?: string;
  sessionGeneration?: number;
  sequence?: number;
  cursor?: string;
  after?: string | null;
  state?: string;
  resumeStatus?: string;
  capabilities?: Record<string, unknown>;
  contract?: Record<string, unknown>;
  causalEventIds?: string[];
}

export async function startConsumerTestProxy(options: { staticRoot: string; gateways: string[]; host?: string; port?: number; maxDownstreamQueueMessages?: number; maxDownstreamQueueBytes?: number }): Promise<ConsumerTestProxy> {
  const maxPayloadBytes = 1_048_576;
  const maxPendingMessages = 100;
  const maxPendingBytes = 1_048_576;
  const maxDownstreamQueueMessages = positiveBound(options.maxDownstreamQueueMessages ?? 100, "RT_TEST_PROXY_DOWNSTREAM_MESSAGES_INVALID");
  const maxDownstreamQueueBytes = positiveBound(options.maxDownstreamQueueBytes ?? 1_048_576, "RT_TEST_PROXY_DOWNSTREAM_BYTES_INVALID");
  const upstreamOpenTimeoutMs = 2_000;
  const host = options.host ?? "127.0.0.1";
  const state: ConsumerTestProxy["state"] = { selectedGateways: [], selectedGatewayTotal: 0, downstreamOverflows: 0, transcript: [] };
  const maxGatewayHistory = 128;
  let dropNextCompletion = false;
  let gatewayOffset = 0;
  const http = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`).pathname;
    if (request.method === "GET" && pathname === "/test/state") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(state)); return; }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const candidate = normalize(join(options.staticRoot, relative));
    if (!candidate.startsWith(normalize(options.staticRoot))) { response.statusCode = 403; response.end(); return; }
    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not file");
      response.setHeader("content-type", contentType(candidate));
      createReadStream(candidate).pipe(response);
    } catch { response.statusCode = 404; response.end("not found"); }
  });
  const frontendServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes, perMessageDeflate: false });
  http.on("upgrade", async (request, socket, head) => {
    if (request.url !== "/realtime") { socket.destroy(); return; }
    const healthy = await healthyGateways(options.gateways);
    if (healthy.length === 0) { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const selected = healthy[gatewayOffset++ % healthy.length]!;
    state.selectedGatewayTotal += 1;
    const connection = state.selectedGatewayTotal;
    state.selectedGateways.push(selected);
    if (state.selectedGateways.length > maxGatewayHistory) state.selectedGateways.splice(0, state.selectedGateways.length - maxGatewayHistory);
    frontendServer.handleUpgrade(request, socket, head, (frontend) => {
      const upstream = new WebSocket(selected, "better-realtime.v1", { maxPayload: maxPayloadBytes, perMessageDeflate: false, ...(request.headers.origin ? { headers: { Origin: request.headers.origin } } : {}) });
      const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
      let pendingBytes = 0;
      let downstreamMessages = 0;
      let downstreamBytes = 0;
      const upstreamOpenTimer = setTimeout(() => {
        pending.length = 0; pendingBytes = 0;
        if (frontend.readyState === WebSocket.OPEN) frontend.close(1013, "upstream open timeout");
        upstream.terminate();
      }, upstreamOpenTimeoutMs);
      frontend.on("error", () => { clearTimeout(upstreamOpenTimer); pending.length = 0; pendingBytes = 0; upstream.terminate(); });
      frontend.on("message", (data, binary) => {
        try {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          recordWire(state.transcript, "client_to_server", connection, message);
          if (message.kind === "command" && typeof message.commandId === "string") state.lastCommandId = message.commandId;
        } catch { /* wire validator owns malformed input */ }
        if (upstream.readyState === WebSocket.OPEN) { upstream.send(data, { binary }); return; }
        const bytes = rawDataBytes(data);
        if (pending.length + 1 > maxPendingMessages || pendingBytes + bytes > maxPendingBytes) {
          pending.length = 0; pendingBytes = 0;
          frontend.close(1013, "upstream queue exceeded");
          upstream.terminate();
          return;
        }
        pending.push({ data, binary });
        pendingBytes += bytes;
      });
      upstream.once("open", () => { clearTimeout(upstreamOpenTimer); for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary }); pendingBytes = 0; });
      upstream.on("message", (data, binary) => {
        try { recordWire(state.transcript, "server_to_client", connection, JSON.parse(data.toString()) as Record<string, unknown>); } catch { /* wire validator owns malformed input */ }
        if (dropNextCompletion) {
          try {
            const message = JSON.parse(data.toString()) as { kind?: string; commandId?: string };
            if (message.kind === "command.completed" && message.commandId) {
              dropNextCompletion = false;
              state.droppedCommandId = message.commandId;
              frontend.close(1012, "injected downstream ACK loss");
              upstream.close(1012, "injected downstream ACK loss");
              return;
            }
          } catch { /* forward non-JSON bytes */ }
        }
        if (frontend.readyState !== WebSocket.OPEN) return;
        const bytes = rawDataBytes(data);
        if (downstreamMessages + 1 > maxDownstreamQueueMessages || downstreamBytes + bytes > maxDownstreamQueueBytes || frontend.bufferedAmount + bytes > maxDownstreamQueueBytes) {
          state.downstreamOverflows += 1;
          frontend.close(1013, "downstream queue exceeded");
          upstream.close(1013, "downstream queue exceeded");
          return;
        }
        downstreamMessages += 1;
        downstreamBytes += bytes;
        try {
          frontend.send(data, { binary }, (error) => {
            downstreamMessages = Math.max(0, downstreamMessages - 1);
            downstreamBytes = Math.max(0, downstreamBytes - bytes);
            if (error && upstream.readyState === WebSocket.OPEN) upstream.close(1012, "downstream send failed");
          });
        } catch {
          downstreamMessages = Math.max(0, downstreamMessages - 1);
          downstreamBytes = Math.max(0, downstreamBytes - bytes);
          frontend.close(1012, "downstream send failed");
          upstream.close(1012, "downstream send failed");
        }
      });
      const closeOther = (target: WebSocket) => (code: number, reason: Buffer) => {
        if (target.readyState !== WebSocket.OPEN && target.readyState !== WebSocket.CONNECTING) return;
        if (forwardableCloseCode(code)) target.close(code, reason.toString().slice(0, 123));
        else target.close();
      };
      frontend.on("close", (code, reason) => { clearTimeout(upstreamOpenTimer); pending.length = 0; pendingBytes = 0; closeOther(upstream)(code, reason); });
      upstream.on("close", (code, reason) => { clearTimeout(upstreamOpenTimer); pending.length = 0; pendingBytes = 0; closeOther(frontend)(code, reason); });
      upstream.on("error", () => { clearTimeout(upstreamOpenTimer); if (frontend.readyState === WebSocket.OPEN) frontend.close(1012, "upstream unavailable"); });
    });
  });
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, host, resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("RT_TEST_PROXY_BIND_FAILED");
  return {
    baseUrl: `http://${host}:${address.port}`,
    webSocketUrl: `ws://${host}:${address.port}/realtime`,
    state,
    dropNextCommandCompletion: () => { dropNextCompletion = true; },
    close: async () => { for (const client of frontendServer.clients) client.terminate(); await new Promise<void>((resolve) => frontendServer.close(() => resolve())); http.closeAllConnections(); await closeServer(http); }
  };
}

function recordWire(transcript: WireTranscriptEntry[], direction: WireTranscriptEntry["direction"], connection: number, message: Record<string, unknown>): void {
  if (typeof message.kind !== "string") return;
  const entry: WireTranscriptEntry = { direction, connection, kind: message.kind };
  for (const field of ["messageId", "commandId", "commandAttemptId", "requestId", "eventId", "deliveryId", "cursor", "state", "resumeStatus"] as const) if (typeof message[field] === "string") entry[field] = message[field] as never;
  for (const field of ["sessionGeneration", "sequence"] as const) if (typeof message[field] === "number") entry[field] = message[field];
  if (message.after === null || typeof message.after === "string") entry.after = message.after;
  if (message.capabilities && typeof message.capabilities === "object" && !Array.isArray(message.capabilities)) entry.capabilities = structuredClone(message.capabilities as Record<string, unknown>);
  if (message.contract && typeof message.contract === "object" && !Array.isArray(message.contract)) entry.contract = structuredClone(message.contract as Record<string, unknown>);
  if (Array.isArray(message.causalEventIds) && message.causalEventIds.every((value) => typeof value === "string")) entry.causalEventIds = [...message.causalEventIds];
  transcript.push(entry);
  if (transcript.length > 512) transcript.splice(0, transcript.length - 512);
}

function rawDataBytes(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
}

function positiveBound(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function forwardableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
}

async function healthyGateways(gateways: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const gateway of gateways) {
    const health = gateway.replace(/^ws:/u, "http:").replace(/\/ws$/u, "/health");
    try { if ((await fetch(health, { signal: AbortSignal.timeout(500) })).ok) result.push(gateway); } catch { /* unhealthy */ }
  }
  return result;
}

function contentType(path: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
