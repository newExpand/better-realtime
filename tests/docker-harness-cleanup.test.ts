import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const cleanupOwners = [
  "scripts/test-postgres-docker.sh",
  "scripts/run-two-gateway-dev.sh",
  "scripts/verify-consumer-journey.ts",
  "tests/e2e/global-teardown.ts",
  "packages/server-node/src/two-gateway-dev.ts",
  "packages/server-node/src/multi-gateway-load.ts"
] as const;

it.each(cleanupOwners)("removes anonymous Docker volumes in %s", async (path) => {
  const source = await readFile(resolve(path), "utf8");
  const removalLines = source.split("\n").filter((line) => /docker.*(?:\srm\s|["']rm["'])/u.test(line));
  expect(removalLines.length).toBeGreaterThan(0);
  for (const line of removalLines) expect(line).toMatch(/(?:--volumes|["' ]-v["' ])/u);
});

it.each([
  "scripts/test-postgres-docker.sh",
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
  expect(source).toMatch(/(?:docker\s+rm|["']rm["']).*container_?[Ii]d/u);
  expect(source).not.toMatch(/(?:docker\s+rm|["']rm["']).*container_?[Nn]ame/u);
});
