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
  });
});
