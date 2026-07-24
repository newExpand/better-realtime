import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const projects = ["chromium", "firefox", "webkit"] as const;

for (const project of projects) {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      "pnpm",
      ["exec", "playwright", "test", `--project=${project}`],
      {
        cwd: root,
        env: {
          ...process.env,
          PLAYWRIGHT_OUTPUT_DIR: `output/playwright/test-results/${project}`
        },
        stdio: "inherit"
      }
    );
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`RT_BROWSER_MATRIX_FAILED:${project}:${code ?? signal ?? "unknown"}`));
    });
  });
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: "1.0",
  browserProjects: projects,
  isolation: "fresh-playwright-process-and-owned-postgres-per-project",
  status: "passed"
})}\n`);
