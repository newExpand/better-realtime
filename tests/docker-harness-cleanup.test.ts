import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { reconcileOwnedPostgresContainer } from "./e2e/global-teardown.ts";

const exec = promisify(execFile);
const cleanupOwners = [
  "scripts/test-postgres-docker.sh",
  "scripts/run-two-gateway-dev.sh",
  "scripts/verify-consumer-journey.ts",
  "tests/e2e/global-teardown.ts",
  "packages/server-node/src/two-gateway-dev.ts",
  "packages/server-node/src/multi-gateway-load.ts"
] as const;

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

it("uses portable Bash for the public two-gateway development path", async () => {
  const source = await readFile(resolve("scripts/run-two-gateway-dev.sh"), "utf8");
  const manifest = JSON.parse(await readFile(resolve("packages/server-node/package.json"), "utf8")) as {
    scripts?: { dev?: string };
  };
  expect(source).toMatch(/^#!\/usr\/bin\/env bash\n/u);
  expect(source).not.toContain("#!/bin/zsh");
  expect(source).not.toContain("${0:A:h}");
  expect(source).not.toContain("uuidgen");
  expect(manifest.scripts?.dev).toBe("bash ../../scripts/run-two-gateway-dev.sh");
  const childAssignment = source.indexOf("child_pid=$!");
  const rememberedSignalForward = source.indexOf('if [[ -n "$requested_signal" ]]', childAssignment);
  expect(childAssignment).toBeGreaterThan(-1);
  expect(rememberedSignalForward).toBeGreaterThan(childAssignment);
  expect(source).toContain("child_ready == 1 && signal_shutdown_started == 0");
  expect(source).toContain("better-realtime-two-gateway-ready.XXXXXX");
  expect(source).toContain("signal_child_group KILL");
  expect(source).toContain("signal_poll_limit=$((signal_grace_seconds * 20))");
  expect(source.indexOf('terminate_child_group "$requested_signal"')).toBeLessThan(source.indexOf('wait "$child_pid"'));
  expect(source).not.toContain("signal_deadline=$((SECONDS");
  await expect(exec("bash", ["-n", resolve("scripts/run-two-gateway-dev.sh")])).resolves.toMatchObject({ stderr: "" });
});

it("lets the runtime finish owned PostgreSQL removal before fallback cleanup", async () => {
  const containerId = "f".repeat(64);
  let inspectionCount = 0;
  let removalCount = 0;
  const inspectionSelectors: string[] = [];
  const result = await reconcileOwnedPostgresContainer({
    containerName: "better-realtime-two-gateway-runtime-removal",
    ownerToken: "runtime-removal-owner",
    settleAttempts: 4,
    wait: async () => undefined,
    command: async (arguments_) => {
      if (arguments_[0] === "inspect") {
        inspectionCount += 1;
        inspectionSelectors.push(arguments_.at(-1) ?? "");
        if (inspectionCount <= 2) return { stdout: `${containerId}|runtime-removal-owner\n` };
        throw Object.assign(new Error("No such object"), { stderr: "Error: No such object" });
      }
      removalCount += 1;
      return { stdout: "" };
    },
  });
  expect(result).toBe("graceful-removal-observed");
  expect(removalCount).toBe(0);
  expect(inspectionSelectors).toEqual([
    "better-realtime-two-gateway-runtime-removal",
    containerId,
    containerId,
  ]);
});

it("accepts a concurrent owned-container removal only after absence is observed", async () => {
  const containerId = "9".repeat(64);
  let removalStarted = false;
  const result = await reconcileOwnedPostgresContainer({
    containerName: "better-realtime-two-gateway-concurrent-removal",
    ownerToken: "concurrent-removal-owner",
    settleAttempts: 1,
    wait: async () => undefined,
    command: async (arguments_) => {
      if (arguments_[0] === "inspect") {
        if (removalStarted) {
          throw Object.assign(new Error("No such container"), { stderr: "Error: No such container" });
        }
        return { stdout: `${containerId}|concurrent-removal-owner\n` };
      }
      removalStarted = true;
      throw Object.assign(new Error("removal is already in progress"), {
        stderr: "Error response from daemon: removal is already in progress",
      });
    },
  });
  expect(result).toBe("concurrent-removal-observed");
});

it("fails a non-responsive Docker command within the configured deadline", async () => {
  const started = Date.now();
  await expect(reconcileOwnedPostgresContainer({
    containerName: "better-realtime-two-gateway-hung-docker",
    ownerToken: "hung-docker-owner",
    commandTimeoutMs: 10,
    settleAttempts: 1,
    wait: async () => undefined,
    command: () => new Promise(() => undefined),
  })).rejects.toThrow("RT_DOCKER_COMMAND_TIMEOUT");
  expect(Date.now() - started).toBeLessThan(500);
});

it("bounds Playwright teardown HTTP and Docker calls", async () => {
  const source = await readFile(resolve("tests/e2e/global-teardown.ts"), "utf8");
  expect(source).toContain("AbortSignal.timeout(2_000)");
  expect(source).toContain("AbortSignal.timeout(1_000)");
  expect(source).toContain("RT_DOCKER_COMMAND_TIMEOUT");
  expect(source).toContain('dockerCommand(["rm", "-f", "-v", "--", containerId])');
});

it("resolves a symlinked path with spaces and preserves owner-scoped cleanup under a restricted PATH", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "better realtime bash harness-"));
  try {
    const bin = join(temporary, "bin");
    const links = join(temporary, "relative links");
    const absoluteHarness = join(temporary, "absolute harness.sh");
    const linkedHarness = join(links, "linked harness.sh");
    const pnpmLog = join(temporary, "pnpm.log");
    const dockerLog = join(temporary, "docker.log");
    await mkdir(bin);
    await mkdir(links);
    await symlink(resolve("scripts/run-two-gateway-dev.sh"), absoluteHarness);
    await symlink("../absolute harness.sh", linkedHarness);
    await executable(join(bin, "node"), '#!/bin/sh\nprintf "%s" "$EXPECTED_OWNER_TOKEN"\n');
    await executable(
      join(bin, "pnpm"),
      '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$PWD" "$REALTIME_POSTGRES_CONTAINER_NAME" "$REALTIME_HARNESS_OWNER_TOKEN" "$*" > "$PNPM_LOG"\n',
    );
    await executable(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = "inspect" ]; then printf "%s|%s\\n" "$EXPECTED_CONTAINER_ID" "$EXPECTED_OWNER_TOKEN"; exit 0; fi\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      EXPECTED_OWNER_TOKEN: "portable-owner-token",
      EXPECTED_CONTAINER_ID: "a".repeat(64),
      PNPM_LOG: pnpmLog,
      DOCKER_LOG: dockerLog,
      REALTIME_POSTGRES_CONTAINER_NAME: "better-realtime-two-gateway-portable",
    };
    delete env.REALTIME_HARNESS_OWNER_TOKEN;
    await exec("bash", [linkedHarness], { cwd: temporary, env });
    expect(await readFile(pnpmLog, "utf8")).toBe(
      `${resolve(".")}|better-realtime-two-gateway-portable|portable-owner-token|exec tsx packages/server-node/src/two-gateway-dev.ts\n`,
    );
    expect(await readFile(dockerLog, "utf8")).toBe(`rm -f -v -- ${"a".repeat(64)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each([
  ["generator failure", "#!/bin/sh\nexit 17\n", "failed to generate a harness owner token"],
  ["empty token", "#!/bin/sh\nexit 0\n", "refusing an invalid PostgreSQL harness owner token"],
  ["malformed token", '#!/bin/sh\nprintf "invalid token"\n', "refusing an invalid PostgreSQL harness owner token"],
] as const)("fails closed before mutation on %s", async (_case, nodeSource, expectedError) => {
  const temporary = await mkdtemp(join(tmpdir(), "better-realtime-owner-token-"));
  try {
    const bin = join(temporary, "bin");
    const pnpmLog = join(temporary, "pnpm.log");
    const dockerLog = join(temporary, "docker.log");
    await mkdir(bin);
    await executable(join(bin, "node"), nodeSource);
    await executable(join(bin, "pnpm"), '#!/bin/sh\nprintf "started\\n" > "$PNPM_LOG"\n');
    await executable(join(bin, "docker"), '#!/bin/sh\nprintf "started\\n" > "$DOCKER_LOG"\n');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      PNPM_LOG: pnpmLog,
      DOCKER_LOG: dockerLog,
      REALTIME_POSTGRES_CONTAINER_NAME: "better-realtime-two-gateway-token-failure",
    };
    delete env.REALTIME_HARNESS_OWNER_TOKEN;
    await expect(exec("bash", [resolve("scripts/run-two-gateway-dev.sh")], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining(expectedError),
    });
    await expect(readFile(pnpmLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(dockerLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each([
  ["matching owner", "match", true],
  ["mismatched owner", "mismatch", false],
  ["invalid container ID", "invalid-id", false],
  ["failed inspection", "inspect-failure", false],
] as const)("preserves child failure and applies owner-scoped cleanup for %s", async (_case, mode, shouldRemove) => {
  const temporary = await mkdtemp(join(tmpdir(), "better-realtime-cleanup-boundary-"));
  try {
    const bin = join(temporary, "bin");
    const dockerLog = join(temporary, "docker.log");
    await mkdir(bin);
    await executable(join(bin, "pnpm"), "#!/bin/sh\nexit 23\n");
    await executable(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = "inspect" ]; then\n  if [ "$DOCKER_MODE" = "inspect-failure" ]; then exit 1; fi\n  if [ "$DOCKER_MODE" = "invalid-id" ]; then printf "invalid|%s\\n" "$REALTIME_HARNESS_OWNER_TOKEN"; exit 0; fi\n  if [ "$DOCKER_MODE" = "mismatch" ]; then printf "%s|other-owner\\n" "$EXPECTED_CONTAINER_ID"; exit 0; fi\n  printf "%s|%s\\n" "$EXPECTED_CONTAINER_ID" "$REALTIME_HARNESS_OWNER_TOKEN"; exit 0\nfi\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      DOCKER_MODE: mode,
      DOCKER_LOG: dockerLog,
      EXPECTED_CONTAINER_ID: "b".repeat(64),
      REALTIME_POSTGRES_CONTAINER_NAME: "better-realtime-two-gateway-cleanup",
      REALTIME_HARNESS_OWNER_TOKEN: "cleanup-owner-token",
    };
    await expect(exec("bash", [resolve("scripts/run-two-gateway-dev.sh")], { env })).rejects.toMatchObject({ code: 23 });
    const removal = await readFile(dockerLog, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(removal).toBe(shouldRemove ? `rm -f -v -- ${"b".repeat(64)}\n` : "");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("forwards %s, reaps the child, preserves status %i, and cleans once", async (signal, expectedStatus) => {
  const temporary = await mkdtemp(join(tmpdir(), "better-realtime-signal-boundary-"));
  try {
    const bin = join(temporary, "bin");
    const readyLog = join(temporary, "ready.log");
    const signalLog = join(temporary, "signal.log");
    const dockerLog = join(temporary, "docker.log");
    await mkdir(bin);
    await executable(
      join(bin, "pnpm"),
      '#!/bin/sh\ntrap \'printf "SIGINT\\n" > "$SIGNAL_LOG"; exit 130\' INT\ntrap \'printf "SIGTERM\\n" > "$SIGNAL_LOG"; exit 143\' TERM\ntrap \'printf "SIGHUP\\n" > "$SIGNAL_LOG"; exit 129\' HUP\nprintf "%s\\n" "$$" > "$READY_LOG"\nwhile :; do sleep 0.05; done\n',
    );
    await executable(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = "inspect" ]; then printf "%s|%s\\n" "$EXPECTED_CONTAINER_ID" "$REALTIME_HARNESS_OWNER_TOKEN"; exit 0; fi\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      READY_LOG: readyLog,
      SIGNAL_LOG: signalLog,
      DOCKER_LOG: dockerLog,
      EXPECTED_CONTAINER_ID: "c".repeat(64),
      REALTIME_POSTGRES_CONTAINER_NAME: "better-realtime-two-gateway-signal",
      REALTIME_HARNESS_OWNER_TOKEN: "signal-owner-token",
    };
    const wrapper = spawn("bash", [resolve("scripts/run-two-gateway-dev.sh")], { env, stdio: "ignore" });
    const childPid = Number((await waitForFile(readyLog)).trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(wrapper.kill(signal)).toBe(true);
    const [status, terminatingSignal] = await once(wrapper, "exit") as [number | null, NodeJS.Signals | null];
    expect({ status, terminatingSignal }).toEqual({ status: expectedStatus, terminatingSignal: null });
    expect(await readFile(signalLog, "utf8")).toBe(`${signal}\n`);
    expect(await readFile(dockerLog, "utf8")).toBe(`rm -f -v -- ${"c".repeat(64)}\n`);
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it("bounds signal escalation when the child process group ignores graceful shutdown", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "better-realtime-signal-escalation-"));
  try {
    const bin = join(temporary, "bin");
    const readyLog = join(temporary, "ready.log");
    const dockerLog = join(temporary, "docker.log");
    await mkdir(bin);
    await executable(
      join(bin, "pnpm"),
      '#!/bin/sh\ntrap "" INT TERM HUP\nprintf "%s\\n" "$$" > "$READY_LOG"\nwhile :; do sleep 0.05; done\n',
    );
    await executable(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = "inspect" ]; then printf "%s|%s\\n" "$EXPECTED_CONTAINER_ID" "$REALTIME_HARNESS_OWNER_TOKEN"; exit 0; fi\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      READY_LOG: readyLog,
      DOCKER_LOG: dockerLog,
      EXPECTED_CONTAINER_ID: "d".repeat(64),
      REALTIME_POSTGRES_CONTAINER_NAME: "better-realtime-two-gateway-escalation",
      REALTIME_HARNESS_OWNER_TOKEN: "escalation-owner-token",
      REALTIME_HARNESS_SIGNAL_GRACE_SECONDS: "1",
    };
    const wrapper = spawn("bash", [resolve("scripts/run-two-gateway-dev.sh")], { env, stdio: "ignore" });
    const childPid = Number((await waitForFile(readyLog)).trim());
    const started = Date.now();
    expect(wrapper.kill("SIGTERM")).toBe(true);
    const [status, terminatingSignal] = await once(wrapper, "exit") as [number | null, NodeJS.Signals | null];
    expect({ status, terminatingSignal }).toEqual({ status: 143, terminatingSignal: null });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3_000);
    expect(await readFile(dockerLog, "utf8")).toBe(`rm -f -v -- ${"d".repeat(64)}\n`);
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it("forwards a signal remembered in the pre-launch child assignment window", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "better-realtime-early-signal-"));
  try {
    const bin = join(temporary, "bin");
    const bashEnvironment = join(temporary, "bash-env.sh");
    const signalLog = join(temporary, "signal.log");
    const dockerLog = join(temporary, "docker.log");
    await mkdir(bin);
    await writeFile(
      bashEnvironment,
      'trap \'if [[ "$BASH_COMMAND" == "set -m" ]]; then trap - DEBUG; kill -TERM $$; fi\' DEBUG\n',
      "utf8",
    );
    await executable(
      join(bin, "pnpm"),
      '#!/bin/sh\ntrap \'printf "SIGTERM\\n" > "$SIGNAL_LOG"; exit 143\' TERM\nwhile :; do sleep 0.05; done\n',
    );
    await executable(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = "inspect" ]; then printf "%s|%s\\n" "$EXPECTED_CONTAINER_ID" "$REALTIME_HARNESS_OWNER_TOKEN"; exit 0; fi\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      BASH_ENV: bashEnvironment,
      SIGNAL_LOG: signalLog,
      DOCKER_LOG: dockerLog,
      EXPECTED_CONTAINER_ID: "e".repeat(64),
      REALTIME_POSTGRES_CONTAINER_NAME: "better-realtime-two-gateway-early-signal",
      REALTIME_HARNESS_OWNER_TOKEN: "early-signal-owner-token",
    };
    await expect(exec("bash", [resolve("scripts/run-two-gateway-dev.sh")], { env })).rejects.toMatchObject({ code: 143 });
    const forwarded = await readFile(signalLog, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(["", "SIGTERM\n"]).toContain(forwarded);
    const processes = await exec("ps", ["-axo", "command="]);
    expect(processes.stdout).not.toContain(join(bin, "pnpm"));
    expect(await readFile(dockerLog, "utf8")).toBe(`rm -f -v -- ${"e".repeat(64)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each(cleanupOwners)("removes anonymous Docker volumes in %s", async (path) => {
  const source = await readFile(resolve(path), "utf8");
  const removalLines = source.split("\n").filter((line) => /(?:docker|command).*(?:\srm\s|["']rm["'])/u.test(line));
  expect(removalLines.length).toBeGreaterThan(0);
  for (const line of removalLines) expect(line).toMatch(/(?:--volumes|["' ]-v["' ])/u);
});

it.each([
  "scripts/test-postgres-docker.sh",
  "scripts/run-two-gateway-dev.sh",
  "scripts/verify-consumer-journey.ts",
  "packages/server-node/src/two-gateway-dev.ts"
] as const)("removes only the container ID acquired by the same process in %s", async (path) => {
  const source = await readFile(resolve(path), "utf8");
  expect(source).toMatch(/container_?[Ii]d|ownedContainerId/u);
  expect(source).toMatch(/\^\[a-f0-9\]\{12,64\}\$/u);
  expect(source).toMatch(/(?:docker\s+rm|["']rm["']).*(?:container_?[Ii]d|ownedContainerId)/u);
  expect(source).not.toMatch(/(?:docker\s+rm|["']rm["']).*container_?[Nn]ame/u);
});

it("does not inherit ambient generic PostgreSQL credentials for the owned PG18.4 harness", async () => {
  const source = await readFile(resolve("scripts/test-postgres-docker.sh"), "utf8");
  expect(source).toContain('database_user="postgres"');
  expect(source).toContain('database_password="realtime"');
  expect(source).toContain('-e "POSTGRES_USER=$database_user"');
  expect(source).toContain('${database_user}:${database_password}');
  expect(source).not.toMatch(/\$\{POSTGRES_(?:USER|PASSWORD)(?::-[^}]*)?\}/u);
});

it.each([
  [
    "scripts/test-postgres-docker.sh",
    'docker exec "$container_name" pg_isready -h 127.0.0.1 -p 5432 -U "$database_user" -d "$database_name"'
  ],
  [
    "scripts/verify-consumer-journey.ts",
    '"pg_isready", "--host", "127.0.0.1", "--port", "5432", "--username", "realtime", "--dbname", "realtime"'
  ],
  [
    "packages/server-node/src/two-gateway-dev.ts",
    '"pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "realtime"'
  ]
] as const)("waits for the final PostgreSQL TCP server instead of the bootstrap Unix socket in %s", async (path, readinessCommand) => {
  const source = await readFile(resolve(path), "utf8");
  expect(source).toContain(readinessCommand);
});

it.each([
  "scripts/run-two-gateway-dev.sh",
  "tests/e2e/global-teardown.ts",
  "packages/server-node/src/multi-gateway-load.ts"
] as const)("requires a matching invocation owner label before fallback cleanup in %s", async (path) => {
  const source = await readFile(resolve(path), "utf8");
  expect(source).toContain("better-realtime.harness-owner");
  expect(source).toMatch(/observed_?[Oo]wner/u);
  expect(source).toMatch(/owner_?[Tt]oken/u);
  expect(source).toMatch(/observed_?[Oo]wner[^\n]*(?:==|!==)[^\n]*owner_?[Tt]oken/u);
  expect(source).toMatch(/(?:(?:docker|command).*(?:\srm\s|["']rm["'])).*container_?[Ii]d/u);
  expect(source).not.toMatch(/(?:docker\s+rm|["']rm["']).*container_?[Nn]ame/u);
});
