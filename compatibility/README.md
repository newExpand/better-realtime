# Compatibility baseline

`fixtures/better-realtime-0.1.0-alpha.1.tgz` is the exact npm registry artifact for the first public alpha. It is not rebuilt from source. Its byte size, SHA-256, SHA-512 integrity, package identity, public exports, and declaration surfaces are checked by `pnpm compatibility:check`.

`fixtures/better-realtime-0.1.0-alpha.4.tgz` is the exact immutable npm/GitHub artifact for the latest published alpha baseline. Its recorded registry URL, 127,291-byte size, SHA-256, SHA-512 integrity, and package identity are verified without rebuilding it. The alpha.1 fixture remains the permanent first-public-contract baseline; alpha.4 supplies the direct clean-room and mixed-version predecessor for the `0.2.0-alpha.1` candidate.

The compatibility gate covers independent release boundaries:

- npm install metadata, package exports, executable bins, and TypeScript declarations, including React 18/19 and contextually inferred React/Node server APIs;
- CLI commands, MCP tool inventory, and diagnostic query result schema;
- `better-realtime.v1` frames, executable client/server implementations, state machines, stable command/attempt identities, cursor restoration, ACK/completion/status reconciliation, and capability semantics;
- PostgreSQL migration graph, executable migrator, storage version, all published alpha.1 columns, candidate runtime readiness, and fail-closed rejection of an unknown storage version;
- diagnostics evidence closure, completeness, and `proven`, `partial`, and `indeterminate` semantics.

Every detected outward or executable-semantic change must have exactly one matching tuple in `changes.json` classified as `compatible`, `deprecated`, or `intentionally_breaking` and assigned exactly one independent `package`, `wire`, `postgres`, or `diagnostics` axis. Duplicate declarations are rejected. The declared minimum is checked against the candidate package's actual version. An intentionally breaking public API/configuration/semantic change requires at least `0.2.0-alpha.1`; only an incompatible wire/capability change requires `better-realtime.v2`; and a PostgreSQL schema change requires a new immutable migration source, predecessor fixture, and declared edge. A wire-breaking ledger entry is fail-closed until a versioned v2 schema, conformance suite, and black-box v2 mixed-version matrix replace the current guard. Version-specific translation belongs in an explicit protocol translator or compatibility adapter, never as conditions spread through the core runtime.

All shipped JavaScript and declaration files are compared from the two tarballs, and protocol constants, validators, manifest logic, and executable state machines are independently fingerprinted, so transitive implementation changes cannot hide behind an unchanged barrel file. A generated TypeScript module checks every alpha.1 value namespace, exact public release literal, named type export, nested public member path, readonly contract, and multi-stream/multi-command generic witness. Optional additions remain compatible while removed or narrowed members are mechanically breaking even when the hand-written consumer does not reference them. Every published export condition target must exist safely inside the tarball; active and inactive runtime targets are directly loaded and must preserve the baseline namespace types or intentional node-only rejection behavior. Expected consumer compilation failures for an intentional package break must be declared and matched separately for the React 18 and React 19 consumer matrices; a missing expected failure is rejected too. Candidate CLI/MCP execution failures and weakening of the fixed doctor schema, evidence reference, proof source, reconciliation resolution, verdict, completeness, or closure semantics are mechanically forced to the intentionally-breaking boundary. The gate executes every existing CLI command and MCP tool, including expansion of the exact doctor evidence reference. Published migration and predecessor-fixture identities are locked in `alpha.1-baseline.json` and cannot be rewritten by updating a self-reported hash.

The vendored artifacts can be independently verified only against their recorded registry URLs:

```sh
pnpm compatibility:acquire -- --verify-external
pnpm compatibility:acquire -- --version 0.1.0-alpha.4 --verify-external
```

The command refuses byte drift. Replacing, regenerating, or deleting either published fixture is not a supported workflow.
