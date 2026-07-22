import {
  command,
  createRealtimeClient,
  defineRealtimeContract,
  jsonSchema,
  stream,
  type CommandAttempt,
  type RealtimeClientOptions,
  type RuntimeSnapshot,
  type StreamSnapshot
} from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import {
  createRealtimeServer,
  migratePostgres,
  postgres,
  type AuthenticatedPrincipal,
  type RealtimePostgresDatabase,
  type RealtimeServerOptions
} from "better-realtime/server";
import {
  executeDiagnosticQuery,
  openLocalDiagnosticSource,
  runStoredDoctor,
  type DiagnosticQueryResult,
  type DoctorQueryDefinition,
  type EvidenceBundleV1
} from "better-realtime/diagnostics";
import { createReadOnlyDiagnosticMcp, type ReadOnlyDiagnosticMcpOptions } from "better-realtime/mcp";

const object = jsonSchema("compat.object@1", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } });
const result = jsonSchema("compat.result@1", { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } });
const contract = defineRealtimeContract({
  contractId: "compat.alpha1",
  manifestVersion: "1.0.0",
  streams: { item: stream({ input: object, snapshot: object, events: { changed: object }, key: ({ id }) => `item:${id}`, initial: () => ({ id: "" }), applyEvent: (_state, event) => event.data, snapshotSequence: () => 0 }) },
  commands: { update: command({ input: object, result }) }
});

const clientOptions = {
  url: "ws://127.0.0.1:43170/ws",
  auth: () => ({ tenantId: "tenant-compat" }),
  reconnectDelaysMs: [100, 200],
  maxPendingCommands: 32
} satisfies RealtimeClientOptions;
const client = createRealtimeClient(contract, clientOptions);
const streamHandle = client.stream("item", { id: "1" });
const streamSnapshot: StreamSnapshot<{ id: string }> = streamHandle.getSnapshot();
const attempt: CommandAttempt<{ ok: boolean }> = client.execute("update", { id: "1" });
const runtimeSnapshot: RuntimeSnapshot = client.runtimeSnapshot();
const react = createRealtimeReact(client);
const hookStream: StreamSnapshot<{ id: string }> = react.useStream("item", { id: "1" });
const hookCommand = react.useCommand("update");
const hookAttempt: CommandAttempt<{ ok: boolean }> = hookCommand.execute({ id: "1" });
const hookPending: number = hookCommand.totalPendingCount;
const hookRuntime: RuntimeSnapshot = react.useRuntime();

const profile = postgres({ connectionString: "postgresql://localhost/compat", identityKeys: [{ version: 1, key: "compatibility-fixture-key-32-bytes-long" }] });
const serverOptions = {
  profile,
  runtimeId: "compat-runtime",
  originPolicy: { allowedOrigins: ["https://compat.example"] },
  authenticate: (): AuthenticatedPrincipal => ({ tenantId: "tenant-compat", authenticationRealm: "compat", issuer: "compat", subject: "consumer", permissions: ["item:read", "item:write"] }),
  streams: {
    item: {
      authorize: (context, input) => context.tenantId === "tenant-compat" && input.id.length > 0,
      snapshot: async (context) => {
        const database: RealtimePostgresDatabase = context.db;
        await database.query("SELECT 1");
        return { id: context.input.id };
      }
    }
  },
  commands: {
    update: {
      authorize: (_context, input) => input.id.length > 0,
      prepare: (_context, input) => ({
        publish: { stream: "item", input, event: "changed", data: input },
        mutate: async (context) => {
          await context.db.query("SELECT 1");
          return { ok: true };
        }
      })
    }
  }
} satisfies RealtimeServerOptions<typeof contract>;
const server = createRealtimeServer(contract, serverOptions);
void migratePostgres(contract, profile);

declare const bundle: EvidenceBundleV1;
declare const doctor: DoctorQueryDefinition;
declare const resultValue: DiagnosticQueryResult;
const mcpOptions = { sourcePath: "compat-evidence.json", tenantId: "tenant-compat" } satisfies ReadOnlyDiagnosticMcpOptions;
void bundle;
void doctor;
void resultValue;
void openLocalDiagnosticSource;
void executeDiagnosticQuery;
void runStoredDoctor;
void createReadOnlyDiagnosticMcp(mcpOptions);
void server;
void streamSnapshot;
void attempt;
void runtimeSnapshot;
void hookStream;
void hookAttempt;
void hookPending;
void hookRuntime;
