# Diagnostics and local MCP

`better-realtime doctor`, `trace command`, `inspect stream`, `leaks`, and MCP v0 all use the same deterministic query/analyzer API. The `0.2` candidate moves MCP to the separately installed `better-realtime-mcp` package. Current MCP is an offline, stdio, read-only analyzer for a local evidence bundle explicitly extracted by the application. It rejects URL sources, bounds input and pagination, preserves tenant scope, and does not require sensitive payload capture.

The released companion pins the exact same-version `better-realtime` analyzer dependency, and its pack gate rejects a companion/base version mismatch. Do not use dependency overrides or manual links to combine different versions: diagnostic schema compatibility is checked independently, but the executable and analyzer implementation are approved and verified as one package pair.

The versioned `EvidenceSink` and `DiagnosticSource` interfaces separate collection from querying. `createRealtimeClient({ diagnostics })` and `createRealtimeServer(..., { diagnostics: { evidence } })` connect their bounded flight recorders to an application-owned sink: the framework redacts and pseudonymizes every accepted record, bounds the asynchronous export queue, declares producer identities, and closes exact high-water checkpoints. `flushEvidence()` and `evidenceSnapshot()` make rejection or exporter failure visible instead of silently sampling correctness evidence.

```ts
const client = createRealtimeClient(contract, {
  url,
  auth,
  diagnostics: {
    sink: browserToEvidenceGateway,
    tenantId,
    pseudonymizationKey,
  },
})

const server = createRealtimeServer(contract, {
  // profile, auth, streams, commands, Origin policy...
  diagnostics: {
    evidence: {
      sink: durableEvidenceSink,
      pseudonymizationKey,
      systemTenantId: "better-realtime-system",
    },
  },
})
```

The browser sink is an application transport to a protected ingestion service; it is not a public MCP endpoint. The server uses the authenticated tenant recorded at the operation boundary and reserves `systemTenantId` for process-level facts that cannot belong to an authenticated tenant. Export keys are secret application configuration and must not be reused as public identifiers.

One exporter owns an exact producer set by default. When several clients, servers, or gateways share one multi-producer sink, configure each exporter with `topology: "shared"`, register every producer, and have the deployment topology owner call `sink.finalizeExpectedProducers()` once. Before finalization coverage is partial; after finalization a new producer is rejected. Closing every declared producer at its exact recorder high-water mark is required for complete coverage.

`BoundedLocalEvidenceSink` from `better-realtime/diagnostics` is an authoritative process-local conformance implementation, not durable production storage. Its independent coverage ledger records dropped, evicted, rejected, export-failed, and missing producer sequences. Retention expiry is applied before every coverage snapshot, and producer/range bookkeeping is bounded. Any loss, open producer, undeclared topology, or incomplete range makes coverage partial and prevents a `proven` result. Producer streams may arrive out of order; conflicting reuse of the same producer sequence fails closed.

The application—not an unauthenticated network endpoint—chooses the tenant, query scope, destination, and retention for each export. Create the file in an owner-only incident directory and fail if the destination already exists:

```ts
import { writeFile } from "node:fs/promises"

const tenantId = "tenant-a"
const commandId = "cmd_119"
const bundle = server.evidenceBundle(tenantId, {
  expectedBoundaries: [
    { producerRole: "database", boundary: "db.committed" },
    { producerRole: "server", boundary: "command.completed" },
  ],
  expectedProducers: ["database", "server"],
  requireCausalHandoffs: true,
  expectedOutcome: "durable command completed",
  scope: { commandId },
})

await writeFile("incident.evidence.json", JSON.stringify(bundle), {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
})
```

Run the CLI against that local file:

```sh
npm exec -- better-realtime doctor --format json --source incident.evidence.json --tenant tenant-a
npm exec -- better-realtime trace command cmd_119 --format json --source incident.evidence.json --tenant tenant-a
```

The stdio MCP process reads the same source and tenant from explicit environment variables:

```sh
REALTIME_EVIDENCE_FILE="$PWD/incident.evidence.json" \
REALTIME_TENANT_ID="tenant-a" \
npm exec -- better-realtime-mcp
```

Do not expose this extraction path as a public route, accept a tenant identifier directly from an untrusted caller, or place bundles in a web root. The bundle is payload-redacted but still contains incident metadata and a per-bundle pseudonymization key; protect and delete it according to the application's incident-retention policy.

`complete` means complete for the declared capture topology. The sink path can aggregate explicitly declared browser, gateway, and database producer instances, but it never infers an unregistered process. The incident-oriented `server.evidenceBundle()` still includes only one gateway's server recorder and that gateway's PostgreSQL store recorder. A missing expected producer instance, record loss, unresolved transaction outcome, export failure, or SIGKILL-lost evidence prevents a proven/complete conclusion.

The candidate provides the browser/server collection port and bounded local implementation, but not a hosted durable evidence backend, live production MCP endpoint, or production MCP authentication/authorization/audit service. A production deployment must supply a tenant-authorized ingestion adapter, durable retention, and an authenticated query service. Sampling-based Sentry or OpenTelemetry data may complement operations but cannot replace unsampled correctness/causality evidence. AI reads derived facts and bounded evidence; the evidence model, not AI judgment, establishes the conclusion.
