import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("browser acceptance isolation", () => {
  it("runs every supported engine through the fresh-process matrix", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const runner = await readFile(resolve(root, "scripts/run-browser-matrix.ts"), "utf8");
    const config = await readFile(resolve(root, "playwright.config.ts"), "utf8");
    const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
    expect(manifest.scripts?.e2e).toBe("tsx scripts/run-browser-matrix.ts");
    expect(runner).toContain('const projects = ["chromium", "firefox", "webkit"] as const;');
    const projectsStart = config.indexOf("projects: [");
    const projectsEnd = config.indexOf("\n  ],", projectsStart);
    expect(projectsStart).toBeGreaterThan(-1);
    expect(projectsEnd).toBeGreaterThan(projectsStart);
    expect([...config.slice(projectsStart, projectsEnd).matchAll(/\{ name: "([^"]+)"/gu)].map((match) => match[1])).toEqual([
      "chromium",
      "firefox",
      "webkit",
    ]);
    expect(workflow.split("\n").map((line) => line.trim()).filter((line) =>
      line.startsWith("- run: pnpm exec playwright install --with-deps")
    )).toEqual(["- run: pnpm exec playwright install --with-deps chromium firefox webkit"]);
    expect(runner).toContain("spawn(");
    expect(runner).toContain("PLAYWRIGHT_OUTPUT_DIR");
  });

  it("keeps the direct single-project harness serialized and non-reusing", async () => {
    const config = await readFile(resolve(root, "playwright.config.ts"), "utf8");
    expect(config).toContain("workers: 1");
    expect(config).toContain("reuseExistingServer: false");
    expect(config).toContain("REALTIME_POSTGRES_CONTAINER_NAME");
    expect(config).toContain("REALTIME_HARNESS_OWNER_TOKEN");
  });

  it("checks unexpected console and page errors in every browser journey", async () => {
    const source = await readFile(resolve(root, "tests/e2e/recovery.spec.ts"), "utf8");
    const gateway = await readFile(resolve(root, "packages/server-node/src/two-gateway-dev.ts"), "utf8");
    const readiness = await readFile(resolve(root, "packages/server-node/src/recovery-readiness.ts"), "utf8");
    const application = await readFile(resolve(root, "examples/recovery-demo/src/App.tsx"), "utf8");
    const crossOriginStart = source.indexOf('test("a real browser cross-origin WebSocket handshake');
    const recoveryStart = source.indexOf('test("a real browser converges');
    const crossOrigin = source.slice(crossOriginStart, recoveryStart);
    expect(crossOrigin).toContain('page.on("console"');
    expect(crossOrigin).toContain('page.on("pageerror"');
    expect(crossOrigin).toContain("unexpectedCrossOriginErrors");
    expect(crossOrigin).toContain("expect(unexpectedCrossOriginErrors).toEqual([])");
    expect(crossOrigin).toContain("The server did not accept the WebSocket handshake");
    expect(gateway).toContain("await startGateway(stoppedId)");
    expect(gateway).not.toContain("void startGateway(stoppedId)");
    const sigkillStart = gateway.indexOf('if (action === "sigkill")');
    const sigkillEnd = gateway.indexOf('\n  if (action === "miss-notify")', sigkillStart);
    const sigkill = gateway.slice(sigkillStart, sigkillEnd);
    expect(sigkill).toContain("const sigkillTarget = previousActive");
    expect(sigkill).toContain('if (!sigkillTarget) throw new Error("RT_RECOVERY_GATEWAY_UNAVAILABLE")');
    expect(sigkill.indexOf("await prepareRecoveryCandidate")).toBeLessThan(sigkill.indexOf("routeEnabled = false"));
    expect(sigkill.indexOf("routeEnabled = false")).toBeLessThan(sigkill.indexOf("await sigkillGateway(sigkillTarget)"));
    expect(sigkill.indexOf("await waitForRecoveryReadiness")).toBeLessThan(sigkill.indexOf('await appendRoomMessage("System", "Recovered after abrupt gateway SIGKILL.")'));
    expect(sigkill.indexOf('await appendRoomMessage("System", "Recovered after abrupt gateway SIGKILL.")')).toBeLessThan(sigkill.indexOf("lastActive = otherId"));
    expect(sigkill.indexOf("lastActive = otherId")).toBeLessThan(sigkill.lastIndexOf("routeEnabled = true"));
    expect(readiness).toContain("RT_RECOVERY_GATEWAY_NOT_READY");
    expect(readiness).toContain("RT_RECOVERY_GATEWAY_UNREADY");
    expect(readiness).toContain("await options.stop(candidate)");
    expect(readiness).toContain("controller.abort()");
    expect(gateway).toContain("json(response, 503, { ok: false, action");
    expect(gateway).toContain("await terminateWithSigkill(gateway.child, gateway.id)");
    expect(source).toContain('fetch("/api/chaos/sigkill", { method: "POST" })');
    expect(source).toContain("expect(secondRecoveryGateway).not.toBe(firstRecoveryGateway)");
    expect(source).toContain('getByText("Recovered after abrupt gateway SIGKILL.")).toHaveCount(2)');
    expect(source).toContain('const sigkillButton = page.getByRole("button", { name: "SIGKILL active" })');
    expect(source).toContain('await expect(sigkillButton).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 })');
    const chaosStart = application.indexOf("async function chaos");
    const chaosEnd = application.indexOf("\n  function submit", chaosStart);
    const chaos = application.slice(chaosStart, chaosEnd);
    expect(chaos.indexOf("await fetch")).toBeLessThan(chaos.indexOf("setSelectedChaos(action)"));
    expect(chaos).toContain("if (!response.ok) throw new Error");
    expect(source).toContain('expect(enableGateway).toHaveAttribute("aria-pressed", "true")');
    expect(source).toContain('getByText("Next command will reconcile by stable command ID")');
    expect(source).toContain('getByText("Next reconnect selects fenced snapshot")');
    expect(source).toContain('expect(reenableGateway).toHaveAttribute("aria-pressed", "true")');
    expect(source).toContain('getByText("State converges; missing producer evidence stays indeterminate")');
  });
});
