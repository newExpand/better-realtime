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
    expect(manifest.scripts?.e2e).toBe("tsx scripts/run-browser-matrix.ts");
    for (const project of ["chromium", "firefox", "webkit"]) {
      expect(runner).toContain(`"${project}"`);
    }
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
});
