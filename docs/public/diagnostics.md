# Diagnostics and local MCP

`better-realtime doctor`, `trace command`, `inspect stream`, `leaks`, and MCP v0 all use the same deterministic query/analyzer API. Current MCP is an offline, stdio, read-only analyzer for a local evidence bundle explicitly extracted by the application. It rejects URL sources, bounds input and pagination, preserves tenant scope, and does not require sensitive payload capture.

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

`complete` means complete for the bundle's declared capture topology. `server.evidenceBundle()` currently includes one gateway's server recorder and that gateway's PostgreSQL store recorder. It does not automatically include a browser, another gateway, PostgreSQL logs, an external exporter, or production-wide context. A missing expected producer instance, record loss, unresolved transaction outcome, or SIGKILL-lost evidence prevents a proven/complete conclusion.

There is no general browser evidence export API, remote durable evidence store, live production MCP endpoint, or production MCP authentication/authorization/audit service in alpha. Sampling-based Sentry or OpenTelemetry data may complement operations but cannot replace unsampled correctness/causality evidence. AI reads derived facts and bounded evidence; the evidence model, not AI judgment, establishes the conclusion.
