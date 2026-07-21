import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default async function globalTeardown(): Promise<void> {
  const containerName = process.env.REALTIME_POSTGRES_CONTAINER_NAME;
  if (!containerName) return;
  if (!/^better-realtime-two-gateway-[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(containerName)) throw new Error("refusing to clean an unscoped PostgreSQL container name");
  const ownerToken = process.env.REALTIME_HARNESS_OWNER_TOKEN;
  if (!ownerToken || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(ownerToken)) throw new Error("refusing to clean without a scoped PostgreSQL harness owner token");
  const port = Number(process.env.REALTIME_SERVER_PORT ?? 43_170);
  if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
    await fetch(`http://127.0.0.1:${port}/internal/shutdown`, { method: "POST" }).catch(() => undefined);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const running = await fetch(`http://127.0.0.1:${port}/health`).then(() => true).catch(() => false);
      if (!running) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let inspection: string;
  try { inspection = (await execFileAsync("docker", ["inspect", "--format", "{{.Id}}|{{index .Config.Labels \"better-realtime.harness-owner\"}}", containerName])).stdout.trim(); }
  catch { return; }
  const [containerId, observedOwner] = inspection.split("|");
  if (!containerId || !/^[a-f0-9]{12,64}$/u.test(containerId) || observedOwner !== ownerToken) throw new Error("refusing to clean a PostgreSQL container not owned by this Playwright invocation");
  await execFileAsync("docker", ["rm", "-f", "-v", "--", containerId]);
}
