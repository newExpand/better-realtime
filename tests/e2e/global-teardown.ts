import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type DockerCommand = (arguments_: string[]) => Promise<{ stdout: string }>;

interface OwnedContainerCleanupOptions {
  containerName: string;
  ownerToken: string;
  command?: DockerCommand;
  commandTimeoutMs?: number;
  settleAttempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

type OwnedContainerCleanupResult =
  | "already-absent"
  | "graceful-removal-observed"
  | "fallback-removed"
  | "concurrent-removal-observed";

export async function reconcileOwnedPostgresContainer({
  containerName,
  ownerToken,
  command,
  commandTimeoutMs = 2_000,
  settleAttempts = 100,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: OwnedContainerCleanupOptions): Promise<OwnedContainerCleanupResult> {
  const dockerCommand = command ?? ((arguments_) => execFileAsync(
    "docker",
    arguments_,
    { timeout: commandTimeoutMs, killSignal: "SIGKILL" },
  ));
  const containerId = await inspectOwnedContainer(
    dockerCommand,
    commandTimeoutMs,
    containerName,
    ownerToken,
  );
  if (containerId === undefined) return "already-absent";

  for (let attempt = 0; attempt < settleAttempts; attempt += 1) {
    await wait(100);
    if (await inspectOwnedContainer(
      dockerCommand,
      commandTimeoutMs,
      containerId,
      ownerToken,
      containerId,
    ) === undefined) {
      return "graceful-removal-observed";
    }
  }

  let removalError: unknown;
  try {
    await withCommandDeadline(
      dockerCommand(["rm", "-f", "-v", "--", containerId]),
      commandTimeoutMs,
    );
  } catch (error) {
    removalError = error;
  }
  for (let attempt = 0; attempt < settleAttempts; attempt += 1) {
    await wait(100);
    if (await inspectOwnedContainer(
      dockerCommand,
      commandTimeoutMs,
      containerId,
      ownerToken,
      containerId,
    ) === undefined) {
      return removalError === undefined ? "fallback-removed" : "concurrent-removal-observed";
    }
  }
  if (removalError !== undefined) throw removalError;
  throw new Error("RT_POSTGRES_CONTAINER_REMOVAL_INCOMPLETE");
}

async function inspectOwnedContainer(
  command: DockerCommand,
  commandTimeoutMs: number,
  containerSelector: string,
  ownerToken: string,
  expectedContainerId?: string,
): Promise<string | undefined> {
  let inspection: string;
  try {
    inspection = (await withCommandDeadline(
      command([
        "inspect",
        "--format",
        "{{.Id}}|{{index .Config.Labels \"better-realtime.harness-owner\"}}",
        containerSelector,
      ]),
      commandTimeoutMs,
    )).stdout.trim();
  } catch (error) {
    if (isMissingContainer(error)) return undefined;
    throw error;
  }
  const [containerId, observedOwner] = inspection.split("|");
  if (
    !containerId
    || !/^[a-f0-9]{12,64}$/u.test(containerId)
    || observedOwner !== ownerToken
    || (expectedContainerId !== undefined && containerId !== expectedContainerId)
  ) {
    throw new Error("refusing to clean a PostgreSQL container not owned by this Playwright invocation");
  }
  return containerId;
}

async function withCommandDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("RT_DOCKER_COMMAND_TIMEOUT")), timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isMissingContainer(error: unknown): boolean {
  const candidate = error as { message?: unknown; stderr?: unknown };
  const details = `${String(candidate.message ?? "")}\n${String(candidate.stderr ?? "")}`;
  return /No such (?:object|container)/iu.test(details);
}

export default async function globalTeardown(): Promise<void> {
  const containerName = process.env.REALTIME_POSTGRES_CONTAINER_NAME;
  if (!containerName) return;
  if (!/^better-realtime-two-gateway-[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(containerName)) throw new Error("refusing to clean an unscoped PostgreSQL container name");
  const ownerToken = process.env.REALTIME_HARNESS_OWNER_TOKEN;
  if (!ownerToken || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(ownerToken)) throw new Error("refusing to clean without a scoped PostgreSQL harness owner token");
  const port = Number(process.env.REALTIME_SERVER_PORT ?? 43_170);
  if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
    await fetch(`http://127.0.0.1:${port}/internal/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const running = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      }).then(() => true).catch(() => false);
      if (!running) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await reconcileOwnedPostgresContainer({ containerName, ownerToken });
}
