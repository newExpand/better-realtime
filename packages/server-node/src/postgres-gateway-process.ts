import { Pool } from "pg";
import { PostgresGatewayServer } from "./postgres-gateway.ts";
import { verifyDemoCredential } from "./demo-auth.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const port = Number(required("REALTIME_GATEWAY_PORT"));
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("REALTIME_GATEWAY_PORT must be a valid port");
const pool = new Pool({ connectionString: required("POSTGRES_URL"), max: 8, connectionTimeoutMillis: 1_000, statement_timeout: 750, query_timeout: 750, application_name: required("REALTIME_GATEWAY_ID") });
const benchmarkRetention = process.env.REALTIME_BENCHMARK_RETENTION === "1";
const gateway = new PostgresGatewayServer({
  pool,
  port,
  runtimeId: required("REALTIME_GATEWAY_ID"),
  runtimeBootId: required("REALTIME_GATEWAY_BOOT_ID"),
  originPolicy: {
    allowedOrigins: (process.env.REALTIME_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    allowMissingOrigin: process.env.REALTIME_ALLOW_MISSING_ORIGIN === "1"
  },
  contract: { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  storageSchema: process.env.REALTIME_POSTGRES_SCHEMA ?? "better_realtime",
  identityKeys: [
    { version: 1, key: required("REALTIME_IDENTITY_KEY_V1") },
    { version: 2, key: required("REALTIME_IDENTITY_KEY_V2") }
  ],
  commandResultRetentionMs: benchmarkRetention ? 750 : 60_000,
  idempotencyRetentionMs: benchmarkRetention ? 1_500 : 120_000,
  pollIntervalMs: 75,
  drainTimeoutMs: 100,
  maxOutboundBufferedBytes: 1_048_576,
  recorderLimits: { maxRecords: 2_000, maxBytes: 5_000_000, maxAgeMs: 300_000 },
  databaseRecorderLimits: { maxRecords: process.env.REALTIME_BENCHMARK_GC === "1" ? 250 : 2_000, maxBytes: 5_000_000, maxAgeMs: 300_000 },
  topologyId: required("REALTIME_TOPOLOGY_ID"),
  authenticate: (auth) => verifyDemoCredential(auth, required("REALTIME_DEMO_AUTH_KEY")),
  maintenanceIntervalMs: 500,
  outboxRetentionMs: benchmarkRetention ? 750 : 5_000,
  enableTestControlPlane: true
});
pool.on("error", (error) => gateway.databaseUnavailable(error));

await gateway.start();
if (!gateway.ready) throw new Error("gateway startup readiness proof failed");
console.log(JSON.stringify({ gatewayReady: true, runtimeId: gateway.recorder.runtimeId, runtimeBootId: gateway.recorder.runtimeBootId, port: gateway.port }));

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  gateway.gracefulDrain("process_signal");
  await new Promise((resolve) => setTimeout(resolve, 125));
  await gateway.dispose();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
