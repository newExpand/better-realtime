import { randomUUID } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const devPort = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return value;
};
const serverPort = devPort("REALTIME_SERVER_PORT", 43_170);
const demoPort = devPort("REALTIME_DEMO_PORT", 43_171);
const postgresContainerName = process.env.REALTIME_POSTGRES_CONTAINER_NAME ?? `better-realtime-two-gateway-e2e-${process.pid}`;
const harnessOwnerToken = process.env.REALTIME_HARNESS_OWNER_TOKEN ?? randomUUID();
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(harnessOwnerToken)) throw new Error("REALTIME_HARNESS_OWNER_TOKEN must be a scoped token");
process.env.REALTIME_POSTGRES_CONTAINER_NAME = postgresContainerName;
process.env.REALTIME_HARNESS_OWNER_TOKEN = harnessOwnerToken;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "output/playwright/test-results",
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${demoPort}`,
    trace: "on",
    screenshot: "on",
    video: "on",
    viewport: { width: 1440, height: 1000 }
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: [
    {
      command: "pnpm dev:server",
      url: `http://127.0.0.1:${serverPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      env: { ...process.env, REALTIME_POSTGRES_CONTAINER_NAME: postgresContainerName, REALTIME_HARNESS_OWNER_TOKEN: harnessOwnerToken }
    },
    {
      command: "pnpm dev:demo",
      url: `http://127.0.0.1:${demoPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 }
    }
  ]
});
