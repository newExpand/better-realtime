import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
