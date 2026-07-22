import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { packRuntime } from "./pack-runtime.ts";
import type { FixturePool, FixtureRuntimeApi } from "../compatibility/postgres/v1-fixture.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const databaseUrl = process.env.POSTGRES_URL?.trim();
if (!databaseUrl) throw new Error("POSTGRES_URL is required");
const work = await mkdtemp(join(tmpdir(), "better-realtime-postgres-compat-"));

interface MigrationManifest {
  fixtures: Array<{ storageVersion: number; packagePath: string; modulePath: string }>;
  migrations: Array<{ version: number; fromVersions: number[] }>;
}
interface FixtureModule {
  createContract(api: FixtureRuntimeApi): { identity: { contractId: string; manifestVersion: string; manifestDigest: string } };
  seed(pool: FixturePool, schema: string): Promise<void>;
  snapshot(pool: FixturePool, schema: string): Promise<Record<string, unknown[]>>;
}
interface PoolLike extends FixturePool { end(): Promise<void> }
interface ServerApi {
  postgres(value: Record<string, unknown>): { pool: PoolLike; schema: string };
  migratePostgres(contract: unknown, profile: unknown): Promise<void>;
  createRealtimeServer(contract: unknown, options: Record<string, unknown>): { ready: boolean; start(): Promise<void>; dispose(): Promise<void> };
}

try {
  const manifest = JSON.parse(await readFile(join(root, "compatibility/postgres-migrations.json"), "utf8")) as MigrationManifest;
  const targetStorageVersion = manifest.migrations.at(-1)?.version;
  if (!targetStorageVersion) throw new Error("RT_COMPAT_POSTGRES_TARGET_MISSING");
  const targetMigration = manifest.migrations.at(-1)!;
  const edgeVersions = targetStorageVersion === 1 ? [1] : targetMigration.fromVersions;
  if (!edgeVersions.length) throw new Error("RT_COMPAT_POSTGRES_EDGE_MISSING");

  const candidate = await packRuntime(join(work, "candidate-artifact"));
  const candidateDirectory = join(work, "candidate");
  await install(candidate.tarball, candidateDirectory);
  const candidateRuntime = await importPackage<FixtureRuntimeApi>(candidateDirectory, "dist/index.js");
  const candidateServer = await importPackage<ServerApi>(candidateDirectory, "dist/server.js");
  const results = [];

  for (const fromStorageVersion of edgeVersions) {
    const fixture = manifest.fixtures.find((entry) => entry.storageVersion === fromStorageVersion);
    if (!fixture) throw new Error(`RT_COMPAT_POSTGRES_EDGE_FIXTURE_MISSING:${fromStorageVersion}`);
    const predecessorDirectory = join(work, `predecessor-${fromStorageVersion}`);
    await install(join(root, fixture.packagePath), predecessorDirectory);
    const predecessorRuntime = await importPackage<FixtureRuntimeApi>(predecessorDirectory, "dist/index.js");
    const predecessorServer = await importPackage<ServerApi>(predecessorDirectory, "dist/server.js");
    const fixtureModule = await import(pathToFileURL(join(root, fixture.modulePath)).href) as FixtureModule;
    const predecessorContract = fixtureModule.createContract(predecessorRuntime);
    const candidateContract = fixtureModule.createContract(candidateRuntime);
    if (JSON.stringify(predecessorContract.identity) !== JSON.stringify(candidateContract.identity)) throw new Error(`RT_COMPAT_POSTGRES_CONTRACT_IDENTITY_DRIFT:${fromStorageVersion}`);
    const result = await verifyEdge({ fromStorageVersion, targetStorageVersion, schema: `compat_v${fromStorageVersion}_${process.pid}`, predecessorServer, candidateServer, predecessorContract, candidateContract, fixture: fixtureModule });
    results.push(result);
  }

  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", baseline: "better-realtime@0.1.0-alpha.1", candidate: `${candidate.package}@${candidate.version}`, targetStorageVersion, declaredEdges: edgeVersions, verifiedEdges: results })}\n`);
} finally { await rm(work, { recursive: true, force: true }); }

async function verifyEdge(options: { fromStorageVersion: number; targetStorageVersion: number; schema: string; predecessorServer: ServerApi; candidateServer: ServerApi; predecessorContract: unknown; candidateContract: unknown; fixture: FixtureModule }): Promise<Record<string, unknown>> {
  const { fromStorageVersion, targetStorageVersion, schema, predecessorServer, candidateServer, predecessorContract, candidateContract, fixture } = options;
  const identityKeys = [{ version: 1, key: "postgres-compatibility-identity-key-32-bytes" }];
  const predecessorProfile = predecessorServer.postgres({ connectionString: databaseUrl, identityKeys, schema });
  const candidateProfile = candidateServer.postgres({ connectionString: databaseUrl, identityKeys, schema });
  try {
    await predecessorServer.migratePostgres(predecessorContract, predecessorProfile);
    const predecessorMetadata = await storageVersion(predecessorProfile.pool, schema);
    if (predecessorMetadata !== fromStorageVersion) throw new Error(`RT_COMPAT_POSTGRES_FIXTURE_VERSION_DRIFT:${fromStorageVersion}:${predecessorMetadata}`);
    await fixture.seed(predecessorProfile.pool, schema);
    const before = await fixture.snapshot(predecessorProfile.pool, schema);
    const attemptsBefore = await migrationAttemptCount(predecessorProfile.pool, schema);

    await candidateServer.migratePostgres(candidateContract, candidateProfile);
    const after = await fixture.snapshot(candidateProfile.pool, schema);
    const attemptsAfter = await migrationAttemptCount(candidateProfile.pool, schema);
    if (JSON.stringify(before) !== JSON.stringify(after) || await storageVersion(candidateProfile.pool, schema) !== targetStorageVersion || attemptsAfter !== attemptsBefore + 1) throw new Error(`RT_COMPAT_POSTGRES_EDGE_DATA_CHANGED:${fromStorageVersion}:${targetStorageVersion}`);

    await candidateServer.migratePostgres(candidateContract, candidateProfile);
    const rerun = await fixture.snapshot(candidateProfile.pool, schema);
    const attemptsRerun = await migrationAttemptCount(candidateProfile.pool, schema);
    if (JSON.stringify(after) !== JSON.stringify(rerun) || attemptsRerun !== attemptsAfter + 1) throw new Error(`RT_COMPAT_POSTGRES_TARGET_RERUN_NOT_IDEMPOTENT:${fromStorageVersion}:${targetStorageVersion}`);

    await verifyRuntimeReadiness(candidateServer, candidateContract, schema, identityKeys);
    const unsupportedVersion = targetStorageVersion + 1;
    await candidateProfile.pool.query(`UPDATE "${schema}".realtime_schema_metadata SET storage_version=$1`, [unsupportedVersion]);
    const unsupportedBefore = await fixture.snapshot(candidateProfile.pool, schema);
    let unsupportedError = "";
    try { await candidateServer.migratePostgres(candidateContract, candidateProfile); } catch (error) { unsupportedError = error instanceof Error ? error.message : String(error); }
    const unsupportedAfter = await fixture.snapshot(candidateProfile.pool, schema);
    if (!unsupportedError.includes("RT_POSTGRES_STORAGE_BINDING_MISMATCH") || await storageVersion(candidateProfile.pool, schema) !== unsupportedVersion || JSON.stringify(unsupportedBefore) !== JSON.stringify(unsupportedAfter)) throw new Error(`RT_COMPAT_POSTGRES_UNSUPPORTED_VERSION_NOT_FAIL_CLOSED:${unsupportedError}`);
    await candidateProfile.pool.query(`UPDATE "${schema}".realtime_schema_metadata SET storage_version=$1`, [targetStorageVersion]);
    return { fromStorageVersion, targetStorageVersion, dataPreserved: true, allPublishedColumnsCompared: true, targetRerunIdempotent: true, candidateRuntimeReady: true, unsupportedVersionFailClosed: true, migrationEvidenceAppended: { transition: attemptsAfter - attemptsBefore, targetRerun: attemptsRerun - attemptsAfter } };
  } finally {
    await candidateProfile.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await Promise.all([predecessorProfile.pool.end(), candidateProfile.pool.end()]);
  }
}

async function verifyRuntimeReadiness(serverApi: ServerApi, candidateContract: unknown, schema: string, identityKeys: Array<{ version: number; key: string }>): Promise<void> {
  const profile = serverApi.postgres({ connectionString: databaseUrl, identityKeys, schema });
  const server = serverApi.createRealtimeServer(candidateContract, {
    profile, runtimeId: `postgres-compat-readiness-${schema}`, port: 0,
    originPolicy: { allowedOrigins: ["https://compat.example"] },
    authenticate: () => ({ tenantId: "tenant-compat", authenticationRealm: "compat", issuer: "compat", subject: "readiness", permissions: ["item:read"] }),
    streams: { item: { authorize: () => true, snapshot: () => ({ id: "1" }) } },
    commands: { update: { authorize: () => true, prepare: (_context: unknown, input: unknown) => ({ publish: { stream: "item", input, event: "changed", data: input }, mutate: () => ({ ok: true }) }) } }
  });
  try { await server.start(); if (!server.ready) throw new Error("RT_COMPAT_POSTGRES_CANDIDATE_RUNTIME_NOT_READY"); }
  finally { await server.dispose(); }
}

async function storageVersion(pool: PoolLike, schema: string): Promise<number> { return Number((await pool.query<{ storage_version: number }>(`SELECT storage_version FROM "${schema}".realtime_schema_metadata`)).rows[0]?.storage_version); }
async function migrationAttemptCount(pool: PoolLike, schema: string): Promise<number> { return Number((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${schema}".realtime_transaction_attempts WHERE operation='schema_migration'`)).rows[0]?.count ?? -1); }
async function install(tarball: string, directory: string): Promise<void> { await mkdir(directory, { recursive: true }); await writeFile(join(directory, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8"); await exec("npm", ["install", "--ignore-scripts", tarball], { cwd: directory, maxBuffer: 20 * 1024 * 1024 }); }
async function importPackage<T>(directory: string, path: string): Promise<T> { return import(pathToFileURL(join(directory, "node_modules/better-realtime", path)).href) as Promise<T>; }
