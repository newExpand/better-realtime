import { expect, test } from "@playwright/test";
import { createServer } from "node:http";

const sequence = async (page: import("@playwright/test").Page) =>
  Number(await page.getByTestId("sequence").textContent());

test("a real browser cross-origin WebSocket handshake is rejected before session setup", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const originServer = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>foreign origin</title>"); });
  await new Promise<void>((resolve, reject) => { originServer.once("error", reject); originServer.listen(0, "127.0.0.1", resolve); });
  try {
    const address = originServer.address();
    if (!address || typeof address === "string") throw new Error("foreign origin did not bind");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const serverPort = Number(process.env.REALTIME_SERVER_PORT ?? 43_170);
    const outcome = await page.evaluate((url) => new Promise<{ opened: boolean; closeCode?: number }>((resolve) => {
      const socket = new WebSocket(url, "better-realtime.v1");
      let opened = false;
      socket.addEventListener("open", () => { opened = true; resolve({ opened }); }, { once: true });
      socket.addEventListener("close", (event) => resolve({ opened, closeCode: event.code }), { once: true });
      setTimeout(() => { socket.close(); resolve({ opened, closeCode: -1 }); }, 3_000);
    }), `ws://127.0.0.1:${serverPort}/ws`);
    expect(outcome).toEqual({ opened: false, closeCode: 1006 });
    const expectedCrossOriginError = /^(?:WebSocket connection .*failed: (?:Error during WebSocket handshake: Unexpected response code: 403|Connection closed before receiving a handshake response|There was a bad response from the server\.|The server did not accept the WebSocket handshake\.|The operation couldn’t be completed\..*)|\[JavaScript Error: "Firefox can’t establish a connection to the server at ws:\/\/127\.0\.0\.1:\d+\/ws\.".*\])$/;
    const unexpectedCrossOriginErrors = browserErrors.filter((message) => !expectedCrossOriginError.test(message));
    expect(unexpectedCrossOriginErrors).toEqual([]);
    expect(browserErrors.length).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  }
});

test("a real browser converges across interruption, replay, dedupe, ACK loss, and snapshot resync", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveTitle("Better Realtime — Recovery room");
  await expect(page.getByRole("heading", { name: "Recovery room", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/);
  await expect(page.getByTestId("sequence")).toHaveText("3");
  await expect(page.getByTestId("timeline").getByText("Ready to prove cross-process recovery.")).toBeVisible();
  await expect(page.locator(".fact").filter({ hasText: "Gateway" })).toContainText("gateway-a");

  const initialSequence = await sequence(page);
  await page.getByRole("button", { name: "Drain Gateway A" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText(/Reconnecting/, { timeout: 10_000 });
  const enableGateway = page.getByRole("button", { name: "Enable Gateway B" });
  await enableGateway.click();
  await expect(enableGateway).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/, { timeout: 15_000 });
  await expect.poll(() => sequence(page)).toBe(initialSequence + 3);
  await expect(page.getByTestId("timeline").getByText("Missed while Gateway A drained: event A.")).toBeVisible();
  await expect(page.getByTestId("timeline").getByText("Live event held behind the PostgreSQL replay fence.")).toBeVisible();
  await expect(page.locator(".fact").filter({ hasText: "Gateway" })).toContainText("gateway-b");

  const beforeDuplicate = await sequence(page);
  await page.getByRole("button", { name: "Inject duplicate" }).click();
  await expect(page.getByText("Event identity retained; reducer effect unchanged")).toBeVisible();
  await expect.poll(() => sequence(page)).toBe(beforeDuplicate);

  const beforeMissedNotify = await sequence(page);
  await page.getByRole("button", { name: "Miss NOTIFY" }).click();
  await expect.poll(() => sequence(page)).toBe(beforeMissedNotify + 1);
  await expect(page.getByText("Recovered from a deliberately missed NOTIFY wake-up.")).toBeVisible();

  await page.getByRole("button", { name: "Lose ACK" }).click();
  await expect(page.getByText("Next command will reconcile by stable command ID")).toBeVisible();
  await page.getByLabel("Message").fill("Browser ACK loss still converges exactly once.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/, { timeout: 15_000 });
  await expect(page.getByText("Completed and causally observed exactly once")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("timeline").getByText("Browser ACK loss still converges exactly once.")).toHaveCount(1);
  await expect(page.locator(".command-state")).toHaveText("observed");
  await expect(page.locator(".fact").filter({ hasText: "Doctor completeness" })).toContainText("complete");
  await expect(page.locator(".fact").filter({ hasText: "Command doctor verdict" })).toContainText("proven");

  const commandId = await page.locator(".command-row").first().getAttribute("data-command-id");
  expect(commandId).toBeTruthy();
  const foreignResult = await page.evaluate(async (knownCommandId) => {
    const auth = await (await fetch("/api/credential/foreign")).json() as Record<string, unknown>;
    return await new Promise<{ status: Record<string, unknown>; streamError?: Record<string, unknown> }>((resolve, reject) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, "better-realtime.v1");
    const envelope = (message: Record<string, unknown>) => ({ protocol: "1.0", messageId: `e2e-${crypto.randomUUID()}`, sentAt: new Date().toISOString(), ...message });
    const timeout = setTimeout(() => { socket.close(); reject(new Error("foreign-principal status timed out")); }, 5_000);
    let streamError: Record<string, unknown> | undefined;
    socket.addEventListener("open", () => socket.send(JSON.stringify(envelope({ kind: "session.open", connectionAttemptId: `e2e-${crypto.randomUUID()}`, contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth }))));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.kind === "session.ready") socket.send(JSON.stringify(envelope({ kind: "stream.subscribe", requestId: `stream-${crypto.randomUUID()}`, stream: "room:42", input: { roomId: "42" }, after: null })));
      if (message.kind === "error" && (message.error as { scope?: string } | undefined)?.scope === "stream") { streamError = message; socket.send(JSON.stringify(envelope({ kind: "command.status.request", requestId: `status-${crypto.randomUUID()}`, commandId: knownCommandId }))); }
      if (message.kind === "heartbeat.ping") socket.send(JSON.stringify(envelope({ kind: "heartbeat.pong", pingId: message.pingId })));
      if (message.kind === "command.status") { clearTimeout(timeout); socket.close(); resolve({ status: message, ...(streamError ? { streamError } : {}) }); }
    });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("foreign-principal status socket failed")); });
    });
  }, commandId!);
  expect(foreignResult.status).toMatchObject({ kind: "command.status", commandId, state: "unknown" });
  expect(foreignResult.streamError).toMatchObject({ kind: "error", error: { code: "RT_OPERATION_UNAVAILABLE", scope: "stream" } });
  const evidenceText = await page.evaluate(async () => JSON.stringify(await (await fetch("/api/evidence")).json()));
  expect(evidenceText).not.toContain("authorization.denied");
  expect(evidenceText).not.toContain("different-principal");

  const beforeSnapshot = await sequence(page);
  await page.getByRole("button", { name: "Expire cursor" }).click();
  await expect(page.getByText("Next reconnect selects fenced snapshot")).toBeVisible();
  await page.getByRole("button", { name: /Drain Gateway/ }).click();
  await expect(page.getByTestId("connection-status")).toHaveText(/Reconnecting/, { timeout: 10_000 });
  const reenableGateway = page.getByRole("button", { name: /Enable Gateway/ });
  await reenableGateway.click();
  await expect(reenableGateway).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/, { timeout: 15_000 });
  await expect.poll(() => sequence(page)).toBe(beforeSnapshot + 2);
  await expect(page.getByText("snapshot.applied").first()).toBeVisible();
  await expect(page.locator(".fact").filter({ hasText: "Server sessions" })).toContainText("1");

  const beforeSigkill = await sequence(page);
  const sigkillButton = page.getByRole("button", { name: "SIGKILL active" });
  await sigkillButton.click();
  await expect(sigkillButton).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  await expect(page.getByText("State converges; missing producer evidence stays indeterminate")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/, { timeout: 15_000 });
  await expect.poll(() => sequence(page)).toBe(beforeSigkill + 1);
  await expect(page.getByText("Recovered after abrupt gateway SIGKILL.")).toBeVisible();
  await expect(page.locator(".fact").filter({ hasText: "Doctor completeness" })).toContainText("partial");

  const firstRecoveryGateway = await page.evaluate(async () => String((await (await fetch("/api/inspect")).json() as { activeGateway?: unknown }).activeGateway));
  const beforeSecondSigkill = await sequence(page);
  const secondRecoveryGateway = await page.evaluate(async () => {
    const response = await fetch("/api/chaos/sigkill", { method: "POST" });
    if (!response.ok) throw new Error(`second SIGKILL failed:${response.status}`);
    return String((await (await fetch("/api/inspect")).json() as { activeGateway?: unknown }).activeGateway);
  });
  expect(secondRecoveryGateway).not.toBe(firstRecoveryGateway);
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/, { timeout: 15_000 });
  await expect.poll(() => sequence(page)).toBe(beforeSecondSigkill + 1);
  await expect(page.getByTestId("timeline").getByText("Recovered after abrupt gateway SIGKILL.")).toHaveCount(2);

  const beforeDatabaseOutage = await sequence(page);
  await page.evaluate(async () => {
    const auth = await (await fetch("/api/credential/team")).json() as Record<string, unknown>;
    const state = { operationSent: false, closed: false, errors: [] as string[], successKinds: [] as string[] };
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, "better-realtime.v1");
    const commandId = `outage-${crypto.randomUUID()}`;
    let sessionGeneration = 0;
    const envelope = (message: Record<string, unknown>) => ({ protocol: "1.0", messageId: `outage-${crypto.randomUUID()}`, sentAt: new Date().toISOString(), ...message });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("outage probe did not become ready")), 5_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify(envelope({ kind: "session.open", connectionAttemptId: `outage-open-${crypto.randomUUID()}`, contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, auth }))));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.kind === "session.ready") { sessionGeneration = Number(message.sessionGeneration); clearTimeout(timeout); resolve(); }
        if (message.kind === "heartbeat.ping") socket.send(JSON.stringify(envelope({ kind: "heartbeat.pong", pingId: message.pingId })));
        if (message.kind === "error") {
          const code = (message.error as { code?: string } | undefined)?.code;
          if (code) state.errors.push(code);
          if (code === "RT_DATABASE_UNAVAILABLE" && !state.operationSent && socket.readyState === WebSocket.OPEN) {
            state.operationSent = true;
            socket.send(JSON.stringify(envelope({ kind: "command", commandAttemptId: `${commandId}:attempt:1`, sessionGeneration, commandId, type: "sendMessage", schema: "sendMessage@1", input: { roomId: "42", text: "must not commit during database outage" }, createdAt: new Date().toISOString() })));
          }
        }
        if (message.kind === "command.receipt" || message.kind === "command.completed") state.successKinds.push(String(message.kind));
      });
      socket.addEventListener("close", () => { state.closed = true; });
      socket.addEventListener("error", () => undefined);
    });
    const probe = window as unknown as { __outageProbe?: typeof state; __outageSocket?: WebSocket };
    probe.__outageProbe = state;
    probe.__outageSocket = socket;
    await ready;
  });
  await page.getByRole("button", { name: "Pause database" }).click();
  await expect.poll(() => page.evaluate(async () => (await fetch("/health")).status), { timeout: 1_000, intervals: [50] }).toBe(503);
  const outageProbe = await page.evaluate(async () => {
    const probe = window as unknown as { __outageProbe?: { operationSent: boolean; closed: boolean; errors: string[]; successKinds: string[] }; __outageSocket?: WebSocket };
    const state = probe.__outageProbe;
    const socket = probe.__outageSocket;
    if (!state || !socket) throw new Error("outage probe was not installed");
    const started = Date.now();
    while (!state.closed && Date.now() - started < 2_000) await new Promise((resolve) => setTimeout(resolve, 10));
    if (socket.readyState === WebSocket.OPEN) socket.close();
    return state;
  });
  expect(outageProbe.operationSent).toBe(true);
  expect(outageProbe.closed).toBe(true);
  expect(outageProbe.errors).toContain("RT_DATABASE_UNAVAILABLE");
  expect(outageProbe.successKinds).toEqual([]);
  await expect(page.getByTestId("connection-status")).toHaveText(/Reconnecting/, { timeout: 10_000 });
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/, { timeout: 20_000 });
  await expect.poll(() => sequence(page)).toBe(beforeDatabaseOutage);
  // Any browser may locally enqueue the probe after gateway draining has begun,
  // then close before the frame reaches the server. Sending from JavaScript
  // does not prove server receipt, so this fail-closed path cannot truthfully
  // require a server-side operation-rejected record.
  const outageEvidenceText = await page.evaluate(async () => JSON.stringify(await (await fetch("/api/evidence")).json()));
  expect(outageEvidenceText).toContain("capability.health_changed");
  expect(outageEvidenceText).toContain("database.operation_failed");
  expect(outageEvidenceText).toContain("session.drain_started");
  expect(outageEvidenceText).toContain("topology.expected");
  expect(outageEvidenceText).toContain("causal.handoff");
  expect(outageEvidenceText).toContain("event.catchup_completed");
  expect(outageEvidenceText).toContain("security.non_enumerating_response");
  await expect(page.locator(".fact").filter({ hasText: "Server sessions" })).toContainText("1");

  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(desktopOverflow).toBeLessThanOrEqual(1);
  const expectedInjectedOutageError = /^(?:WebSocket connection .*failed: (?:Connection closed before receiving a handshake response|Error during WebSocket handshake: Unexpected response code: 503|Received invalid WebSocket response from the server|The server did not accept the WebSocket handshake\.|There was a bad response from the server\.|The operation couldn’t be completed\. Socket is not connected)|Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)|\[JavaScript Error: "Firefox can’t establish a connection to the server at ws:\/\/127\.0\.0\.1:\d+\/ws\.".*\])$/;
  const unexpectedBrowserErrors = browserErrors.filter((message) => !expectedInjectedOutageError.test(message));
  expect(unexpectedBrowserErrors).toEqual([]);
  expect(browserErrors.length).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("recovery-final.png"), fullPage: true });
});

test("the recovery console remains legible at a narrow browser viewport", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toHaveText(/Live/);
  await expect(page.getByRole("heading", { name: "Recovery room", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Drain Gateway A" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("recovery-mobile.png"), fullPage: true });
});
