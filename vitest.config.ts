import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^better-realtime\/diagnostics$/,
        replacement: fileURLToPath(new URL("./packages/runtime/src/diagnostic-io.ts", import.meta.url))
      },
      {
        find: /^better-realtime$/,
        replacement: fileURLToPath(new URL("./packages/runtime/src/index.ts", import.meta.url))
      }
    ]
  },
  test: {
    include: ["packages/**/test/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
