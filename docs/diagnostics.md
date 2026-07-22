# AI-Diagnosable Diagnostics

Status: draft

## Objective

Every promised reliability guarantee must emit enough structured evidence for a diagnostic system to determine:

1. what was expected;
2. what actually occurred;
3. the last boundary that succeeded;
4. the first boundary that diverged;
5. the component, version, and source location responsible for that boundary when available.

The goal is not to ask an AI to guess from text logs. The runtime records facts, deterministic analyzers evaluate invariants, and AI tools consume the resulting evidence and source context. Diagnostic sufficiency is the primary requirement: a weak model may fail to interpret sufficient evidence, but the evidence system must not be the reason a supported cause cannot be distinguished.

## First-slice requirement

Diagnostics are designed and implemented with the first production-shaped reliability slice. Its minimum diagnostic foundation includes:

- versioned evidence records at every implemented correctness boundary;
- explicit causal edges and stable semantic, attempt, session, runtime, build, adapter, and schema identities;
- a bounded flight recorder and point-in-time resource ownership inventory;
- a completeness manifest that exposes loss, eviction, disabled capture, and unavailable producers;
- raw evidence queries plus schema-validated `doctor`, `trace`, `inspect`, and `leaks` JSON output;
- deterministic invariant checks for every reliability guarantee included in the slice;
- cleanup lifecycle facts covering scope closure, release requests and outcomes, rejected acquisitions, partial-initialization rollback, and fencing of stale asynchronous completions;
- diagnosability tests that inject competing causes and verify the reported divergence boundary.

This list is a minimum evidence contract, not an artificial cap. Deterministic replay, state hashing, causal analysis, or additional access surfaces should be implemented in the same goal when their prerequisites are present and they can be verified coherently. They must not be deferred solely because a roadmap assigned them a later phase. Conversely, consumers such as MCP, OTLP, and visual Devtools must reuse the evidence/query contract rather than forcing premature alternative representations.

## Diagnostic pipeline

```text
Runtime facts → producer-local bounded evidence store
                         ├→ raw evidence queries ───────────────┐
                         └→ invariant engine and replay         │
                                      ↓                        │
                              derived facts/issues             │
                                      └────────────────────────┤
                                                               ↓
                                CLI · JSON API · read-only MCP · later UI
```

Raw evidence remains immutable and queryable within its declared retention after deterministic analysis. Derived facts add interpretation; they do not replace, discard, or irreversibly summarize source records. Every derived fact links to its complete evidence closure. Retention eviction is explicit coverage loss, never mutation of surviving evidence.

The PostgreSQL two-gateway reference journey performs a bounded in-browser aggregation for one explicitly selected stable command: the database producer's `db.committed`, the exact gateway producer instance's `command.completed` or ACK-loss `command.status_reconciled`, and the browser runtime's `command.observed` share the exact causal event identity and an exact producer runtime/boot manifest. The join and doctor scope both require command ID and event ID; a prior successful command or same-named command from another operation cannot satisfy the selected command. Database recorder loss contributes to completeness just like server or client loss. This is a test-profile evidence join, not a general durable exporter. Gateway A/B recovery topology remains a separate server-side doctor proof, and either proof becomes partial when a required instance is unavailable or its retained evidence is incomplete.

## Diagnostic contract

Each guarantee defines the evidence needed to diagnose its failure.

```ts
defineGuarantee({
  name: "reconnect-convergence",
  expectedOutcome: "state converges through the declared head",
  requiredBoundaries: [
    "disconnect.detected",
    "resume.requested",
    "server.head.read",
    "replay.range.selected",
    "event.delivered",
    "event.applied",
    "client.checkpoint.updated",
  ],
  diagnosableQuestions: [
    "At which boundary did recovery stop?",
    "Which sequences are missing?",
    "Is snapshot resync required?",
  ],
  requiredContext: ["capabilities", "retention", "topology", "build"],
  distinguishableFaults: [
    "replay_range_wrong",
    "live_released_before_replay",
    "event_rejected",
    "reducer_noop",
    "subscriber_not_notified",
  ],
  diagnosticLimits: ["browser evidence may be unavailable"],
})
```

A reliability test is not complete until its corresponding diagnosability test verifies that the expected fault boundary is present in the evidence bundle.

A contract is sufficient only when it distinguishes the supported competing causes of the same symptom. Recording that a stage ran is insufficient when an internal decision can change the outcome.

## Evidence record

```json
{
  "schemaVersion": "1.0",
  "recordId": "rec_892",
  "recordSequence": 1829,
  "previousRecordHash": "sha256:...",
  "kind": "stream.transition",
  "timestamp": "2026-07-16T12:21:44.192Z",
  "observedTimestamp": "2026-07-16T12:21:44.194Z",
  "monotonicNs": "4481192001",
  "runtimeId": "gateway-3",
  "runtimeBootId": "boot-20260716-7",
  "connectionId": "conn_7",
  "sessionId": "session_82",
  "stream": "room:42",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "commandId": "cmd_119",
  "eventId": "evt_881",
  "transition": {
    "machine": "stream",
    "from": "replaying",
    "event": "stream.replay.complete",
    "to": "live"
  },
  "stateHashBefore": "sha256:...",
  "stateHashAfter": "sha256:...",
  "outcome": "invariant_violation",
  "reasonCode": "RT_GAP_UNRESOLVED"
}
```

Required correlation dimensions include runtime, connection, session, stream, command, event, trace, causation, build, adapter, and schema versions where applicable.

Each producer uses `runtimeId + runtimeBootId + recordSequence` so restarts do not create ambiguous sequences. Stable semantic IDs are separate from delivery and command attempt IDs, session generations, and replay/live delivery modes.

## Causal graph

Chronological proximity is not proof of causation. Explicit edges relate operations.

```json
{
  "edges": [
    { "from": "cmd_119", "to": "db_tx_77", "relation": "committed_as" },
    { "from": "db_tx_77", "to": "evt_881", "relation": "produced" },
    { "from": "evt_881", "to": "delivery_92", "relation": "delivered_as" },
    { "from": "delivery_92", "to": "apply_52", "relation": "applied_as" }
  ]
}
```

Possible relations include `caused_by`, `retries`, `replays`, `produced`, `delivered_as`, `deduplicated_as`, `applied_as`, `supersedes`, and `acknowledges`.

## Boundary evidence

A complete event path may include:

```text
db.committed
→ event.appended
→ bus.accepted
→ router.received
→ gateway.queued
→ transport.written
→ client.received
→ schema.validated
→ dedupe.decided
→ reducer.applied
→ subscribers.notified
```

Each boundary records its own fact. `transport.written` is not evidence of `client.received`, and `client.received` is not evidence of `reducer.applied`.

The initial protocol requires these additional decision boundaries:

| Path | Required evidence |
|---|---|
| Session initialization | transport opened, open deadline started, first-message classification, schema validation, contract comparison, authentication result, session accepted/rejected, resource release |
| Resume | token presence and opaque fingerprint, binding/expiry decision, fresh authentication result, resume status/reason, new session generation, rotated-token storage outcome |
| Authentication refresh | challenge and deadline, single-flight provider start/outcome, credential-update validation without credential capture, auth generation, per-stream reauthorization, paused-operation release/failure |
| Heartbeat | negotiated policy, ping ID and monotonic send time, matching pong receipt, timeout decision, stale-visibility decision, resulting transport close/reconnect |
| Replay and snapshot fence | requested cursor, selected mode and head, atomic snapshot cursor, retained/buffered record and byte counts, each catch-up boundary, continuity decision, live release |
| Recovery overflow | configured count/byte limits, observed values, first rejected attempt, partial-recovery invalidation, new snapshot attempt or explicit terminal failure |
| Command reconciliation | stable command and attempt identities, durable acceptance boundary, lost/uncertain attempt, retention decision, status query/result, retry identity comparison, completion and causal observation |
| Database transaction outcome | transaction ID, typed operation, and non-reversible stable `operationCorrelationId`, command/event/stream correlation, `pre_commit`/`commit_in_flight` state, original COMMIT acknowledgement or authoritative abort provenance, indeterminate classification, cleanup attempt without outcome claim, serialized reconciliation start/result, exact durable attempt-marker proof source |

Authentication evidence records credential type, issuer/audience identifiers when allowed, policy version, sanitized claims hash, and decision outcome; they never record raw cookies, bearer tokens, or resume tokens. Resume tokens are correlated through a keyed or otherwise non-reversible diagnostic fingerprint.

Every correctness-relevant branch emits a structured decision record with sanitized decision inputs, selected rule or policy version, outcome, reason code, and affected identities. This applies to authentication, dedupe, replay merge, overflow, retry, snapshot selection, reducer outcome, command reconciliation, and cleanup acquisition, rollback, release, timeout, and stale-completion fencing.

```json
{
  "kind": "decision",
  "operation": "dedupe",
  "eventId": "evt_881",
  "inputs": {
    "indexGeneration": 7,
    "entryPresent": true
  },
  "decision": "discard",
  "reasonCode": "RT_EVENT_ALREADY_APPLIED",
  "policyVersion": "dedupe@2"
}
```

For React, the optional observed path is:

```text
store.applied → subscribers.notified → react.snapshot.read → react.commit.observed
```

Without React commit instrumentation, whether a UI render committed remains `unknown`; subscriber notification is not proof of paint.

## Knowledge and verdicts

Deterministic analysis distinguishes known, contradicted, unknown, and not-applicable facts.

```ts
type Knowledge<T> =
  | { status: "known"; value: T; evidence: RecordId[] }
  | { status: "contradicted"; evidence: RecordId[] }
  | { status: "unknown"; reason: UnknownReason }
  | { status: "not_applicable" }

type Verdict = "proven" | "disproven" | "indeterminate"
```

AI-generated claims must cite evidence record IDs. Claims without supporting evidence, claims that cross an uninstrumented boundary, or claims that treat sampled data as complete are rejected by the diagnostic validator.

An error after COMMIT invocation produces `database.transaction_outcome_indeterminate` with outcome `unknown` unless an authoritative PostgreSQL ErrorResponse proves abort. A later `database.transaction_reconciled` resolves that exact transaction only when it has the same producer runtime/boot identity, transaction ID, typed operation, internal `operationCorrelationId`, a later producer-local sequence, and one of these operation-specific proof sources: the original `durable_transaction_attempt_marker` observed after reacquiring the stable advisory or outbox-row lock for `committed`/`rolled_back`, or a successful fresh retry for a discarded read-only attempt with resolution `no_durable_effect`. The internal correlation ID hashes a versioned canonical JSON tuple with explicit field boundaries for tenant/principal/command, tenant/stable-append, snapshot, maintenance, or exact outbox row/batch identity. At the public query boundary it is transformed again with the source-only bundle key while preserving the `opcorr:sha256:` shape, so equality remains available inside one result bundle without exposing a low-entropy tuple to offline dictionary testing. Principal correlation hashes versioned keyed-HMAC alias fingerprints rather than raw issuer/subject-derived material, preventing offline identity verification from exported evidence. Another retry's command, event, alias, outbox marker, or transaction marker is operation-convergence evidence only and never resolves the original transaction. `database.transaction_cleanup_attempted` records resource cleanup and always carries `outcomeProof: false`; it cannot resolve the prior COMMIT. A cleanup failure or any expired reconciliation query deadline destroys the pool connection rather than returning an uncertain session to another owner.

Doctor evaluates unresolved transaction evidence before declaring required journey boundaries successful. An indeterminate record without a trusted later reconciliation in the exact transaction and operation-correlation scope forces an `indeterminate` verdict even if an older transaction, another tenant/principal command, another transaction operation, or an uncorrelated producer emitted a commit record. Within one producer instance, a later outcome attempt for the same `operationCorrelationId` supersedes every older transaction-derived success boundary, including outbox notification, principal resolution, and snapshot creation; cleanup-only evidence does not. Producer-local sequence is never compared across runtimes. Required boundaries cannot be spliced across different `commandAttemptId`, transaction, or operation-correlation identities. A missing identity is not a wildcard: mixed defined/missing candidates are ambiguous, and a later boundary may omit an already selected identity only through an exact causal link. The sole aggregate exception in v1 is `replay.completed`, which may omit the selected event ID when it has the exact same replay trace and stream as the preceding event boundary. If one boundary has multiple unscoped attempt/transaction candidates or conflicting outcomes, doctor returns `indeterminate` and cites a bounded witness set that includes representatives of each conflicting identity/outcome needed to establish ambiguity. If multiple producer instances emit transactions for one operation correlation, doctor remains indeterminate unless the caller selects a transaction ID, an exact producer instance with both `runtimeId` and `runtimeBootId`, or an explicit causal handoff. Every event in a multi-row outbox batch receives an explicit stable outbox-row correlation and transaction link. A gateway records only `gateway.transaction_outcome_indeterminate_observed`, carrying the same non-secret operation correlation; it never republishes an observer receipt as database-producer evidence. Original COMMIT acknowledgement uses proof source `commit_acknowledgement`; reconciliation uses `durable_transaction_attempt_marker` (or the read-only discard-and-retry proof) so provenance is never conflated.

## Completeness manifest

Every incident bundle describes its own coverage and loss.

```json
{
  "capture": {
    "from": "2026-07-16T12:20:00Z",
    "to": "2026-07-16T12:25:00Z"
  },
  "coverage": {
    "status": "partial",
    "expectedProducers": ["server", "client"],
    "observedProducers": ["server"],
    "missingProducers": ["client"]
  },
  "loss": {
    "droppedRecords": 0,
    "missingRanges": [],
    "exportRejectedRecords": 0
  },
  "sampling": {
    "controlPlane": "none",
    "eventMetadata": "none",
    "payload": "redacted"
  }
}
```

Control-plane state transitions and correctness-critical event metadata must not be silently sampled. If capture is degraded, the runtime emits an explicit observability-compromised record.

Evidence is produced independently by browsers, gateways, routers, servers, and adapters. Incident assembly merges producer streams through explicit trace, command, event, delivery, and resource identities rather than wall-clock proximity. Missing producers, upload failures, overwritten ranges, and process restarts are represented as coverage loss. No client telemetry means client-side boundaries are explicitly unobserved.

Every evidence record carries an immutable producer role, runtime ID, and boot ID assigned by its recorder. A component label describes the code path and cannot establish producer provenance. A client that observes `session.ready`, replay selection, or a command receipt records a `client.*_observed` boundary; it cannot manufacture the corresponding server producer boundary. Multi-producer doctor proofs require an explicit trace, session, stream, or command scope plus records from every expected producer. Sequence order is evaluated only within one producer runtime/boot stream, never by comparing unrelated producer-local sequence numbers.

## Recording tiers

| Tier | Content | Default policy |
|---|---|---|
| Control plane | connection, subscription, cursor, replay, command, cleanup | no sampling |
| Data metadata | event identity, sequence, schema, hash, size, boundary receipts | no silent sampling |
| Expensive context | payload, stack, heap, fine-grained performance | opt-in or incident mode |

Payloads and credentials are not captured by default. Metadata records whether a payload is absent, redacted, hashed, encrypted, or captured through explicit policy.

State hashes prove equality or divergence but do not explain the difference. Materializers should provide a bounded, redacted diagnostic projection and structured diff, explicitly listing omitted and redacted paths. Reducer evidence records its version, base cursor/revision, input event, and outcome such as `changed`, `no_op`, or `rejected`.

## Flight recorder

The diagnostic system must not become an unbounded memory consumer.

```ts
flightRecorder({
  history: {
    maxRecords: 10_000,
    maxBytes: "10mb",
    maxAge: "5m",
  },
  incident: {
    before: "30s",
    after: "10s",
    freezeOn: ["error", "invariant_violation"],
  },
  payloads: "metadata-only",
})
```

The recorder keeps a rolling pre-incident window, freezes it on a qualifying anomaly, captures a bounded post-incident window, and exports a self-describing incident bundle.

Frozen bundles, exporter queues, and history indexes have independent count, byte, age, retention, and overflow policies. Eviction or export failure updates the completeness manifest instead of silently reducing coverage.

## Invariant engine

Initial invariant families:

- per-stream sequence continuity;
- no transition to `live` before replay continuity is verified;
- accepted commands reach observed, rejected, or explicitly unknown state within policy;
- duplicate event IDs do not apply duplicate domain effects;
- disposed owners retain no active child resources after the cleanup grace period;
- zero local consumers eventually release the remote subscription;
- inactive connections retain no active heartbeat or retry work;
- cleanup analysis distinguishes release never requested, release failed, release timed out, rollback failed, and a stale completion correctly fenced from resource resurrection;
- buffers remain within declared limits;
- snapshot state and cursor agree;
- deterministic replay produces the recorded state hash.

Deterministic replay requires the exact initial checkpoint, ordered inputs, materializer and schema/migration versions, and all nondeterministic inputs. Replayable materializers are pure or receive recorded clock, random, locale, feature-flag, and external-decision inputs through a replay context. Missing prerequisites produce an explicit `replayUnavailableReason`.

## Resource ownership evidence

All acquired resources emit owner and complete lifecycle records.

```json
{
  "kind": "resource.acquired",
  "resourceId": "sub_81",
  "resourceType": "remote_subscription",
  "ownerId": "stream_room_42",
  "createdBy": {
    "file": "RoomPage.tsx",
    "line": 38
  }
}
```

The minimum lifecycle vocabulary includes:

- `scope.closing`;
- `resource.release_requested`;
- `resource.release_succeeded`, `resource.release_failed`, or `resource.release_timed_out`;
- `acquisition.rejected` after a scope begins closing;
- `rollback.completed` or `rollback.failed` for partial initialization;
- `stale_completion.fenced` when asynchronous work completes after its generation is no longer current.

Each record links the resource, owner, acquisition attempt, cleanup attempt, triggering cause, scope/generation, and failure or timeout reason. The analyzer must distinguish a release that was never requested from one that failed or timed out, a rollback failure from ordinary disposal, and successful fencing from stale work that resurrected a resource.

Orphaned resources, unmatched listener counts, monotonic buffer growth, stale pending commands, and duplicate HMR runtimes become structured diagnostic issues.

`client.inspect()` and `server.inspect()` expose a schema-versioned point-in-time resource inventory and ownership tree: connections, local and remote subscriptions, React subscribers, listeners, timers, iterators, replay tasks, pending commands, dedupe entries, buffered records/bytes, adapter handles, and frozen incidents. Logical ownership evidence and an optional runtime heap retaining-path analysis are reported as different kinds of proof.

## Build and environment context

Incident bundles include:

- Git commit and build identifier;
- runtime, adapter, protocol, and schema versions;
- sanitized configuration hash and relevant policy values;
- declared adapter capabilities;
- deployment topology and runtime identities;
- source location or source map references where available.

An AI must not analyze evidence against an unspecified source revision.

Package version and diagnostic schema version are independent. The alpha.1 evidence/query contract is a permanent compatibility fixture: later analyzers must preserve the meaning of `proven`, `partial`, and `indeterminate`, the completeness manifest, producer identity, and proof-source boundaries or select a new diagnostic schema version. A compatibility adapter may translate a fully understood older record at the diagnostic ingestion boundary, but it must preserve loss and unknown fields as explicit incompleteness. It must never upgrade partial evidence to proven or reinterpret an indeterminate transaction as committed or rolled back.

## Access surfaces

### CLI and JSON

CLI is the first integration because any coding agent can execute it and consume bounded JSON.

The executable v0 commands are `better-realtime doctor --format json`, `better-realtime trace command <commandId> --format json`, `better-realtime inspect stream <stream> --format json`, and `better-realtime leaks --format json`. They require an explicit local evidence file and tenant scope. The file is schema version `1.0` with `payloadPolicy: redacted` and a source-only, minimum-32-byte `pseudonymizationKey`; results use query version `1.0`, provenance source `local_evidence_bundle`, and the executable [query result schema](../spec/diagnostics/v1/query-result.schema.json). The key is never returned by query results or MCP and must be generated per tenant/bundle scope. The reusable source handle is opaque: it exposes query and stored-doctor operations but not the source path, raw bundle, or pseudonymization key. Local input is opened once with nonblocking and no-symlink-follow flags, verified as a regular file, size-checked and read through that same descriptor with a 64 MiB hard limit, and rejected if its identity, size, or modification time changes during capture. FIFOs and other special files therefore cannot block the diagnostic process before the regular-file check. Public CLI/MCP failures use stable non-sensitive codes rather than filesystem paths or raw exception text. Cross-tenant bundles/queries, URL sources, oversized or changing local files, unsupported conclusions, invalid query fields/cursors, and limits outside `1..500` are rejected. Query strings are at most 512 UTF-8 bytes and cursors at most 4096 bytes. Raw pages are bounded by both count and a 256 KiB serialized-result ceiling; detail traversal stops after eight levels and 64 entries per object/array, and oversized records retain correlation metadata with an explicit truncation code. `doctor` requires a nonempty, role-coherent stored diagnostic contract: every expected producer role must own a required boundary, and no conclusion is inferred from an empty contract. The configured expected-outcome prose is treated as source configuration and is replaced with a fixed redacted description in public results.

A doctor result contains an ordered `evidenceClosure` rather than only a verdict. Matched boundaries, bounded conflicting attempt evidence, the first observed divergence, and the exact indeterminate/reconciliation pair needed by either a successful or rolled-back selected durable transaction carry their record ID, producer instance, component/version, outcome, transaction/operation/command-attempt correlation, causal handoff, and closed proof-source/resolution fields. Conclusion-level `lastSuccessfulBoundary` and `firstDivergentBoundary` cite those record IDs even when `issues` is empty. Global record IDs and each producer-instance-local sequence are unique bundle invariants, so embedded citations and raw expansion cannot resolve to different records. A causal multi-runtime contract must set `requireCausalHandoffs`; sharing only a command or principal scope is insufficient.

Evidence export begins only from records that explicitly carry the requested tenant and may include tenant-neutral records only through trusted transaction, operation, event, causal-handoff, or server-issued session correlation. Client-provided trace IDs are query metadata, never tenancy-establishing join keys. Stream names and command IDs also cannot establish tenancy. A command trace or command-scoped doctor conclusion additionally requires exactly one durable `principalNamespaceId`; missing principal provenance or the same command ID appearing under multiple principals is rejected as `RT_DIAGNOSTIC_SCOPE_AMBIGUOUS` instead of joining those records. Export always treats source and query identifiers as raw—even if an identifier begins with the output pseudonym prefix—and applies a domain-separated keyed digest exactly once at the trusted source-to-result boundary. Tenant, producer runtime/boot, record, transaction, issuing and observing principal, command, stream, event, resource, causal, and operation-correlation identifiers are pseudonymized in public results, preventing prefix injection, low-entropy dictionary recovery without the local source key, and cross-bundle linkage. Every `evidenceBundle()` call creates a fresh key even for the same server and tenant. Versioned canonical command `intentHash` values receive the same bundle-keyed transform while retaining their `sha256:` shape: equal intents remain linkable inside one bundle, but an external payload guess cannot be checked against the exported value and another bundle cannot be linked. Evidence `details` otherwise use default-block redaction with an exact canonical safe-key allowlist; unknown, Unicode-confusable, normalized-alias, and credential-shaped keys are omitted rather than being promoted into correctness fields or becoming a covert payload channel. Correctness values such as transaction state, cleanup `action=rollback`, `outcomeProof=false`, delivery mode, and wire status survive only through closed boolean/enum schemas. The public result schema is separate from the source evidence schema: it requires bundle-keyed pseudonyms, forbids the private `previousRecordHash`, and recursively rejects non-allowlisted detail keys and values. Diagnosis therefore depends on approved correlation and correctness metadata rather than payload capture.

Resource conclusions have a separate `resourceCapture` declaration. A `complete` capture must carry a capture ID, timestamp, inventory count, and SHA-256 digest, and the producer-local `resource.inventory_captured` evidence must bind those exact values. A stale marker or a changed/empty inventory cannot prove leak absence. The current v0 proves an empty inventory only for one expected producer instance; multi-producer bundles and gateways without an inventory snapshot remain `indeterminate`.

Every bounded query reports `hasMore`, a continuation cursor, omitted counts, page-covered sequence ranges, source-covered ranges, and completeness status. The cursor MAC binds the version, query, offset, and a keyed digest of the complete validated source snapshot—including fields removed by public redaction—so hidden-field mutation or token editing is rejected instead of skipping or duplicating records. Truncation is never presented as complete evidence. Required boundaries may be satisfied only by instances in the topology manifest; a role-only boundary is valid only when that role maps to exactly one expected instance.

### Read-only MCP

The local stdio MCP v0 implements six tools: `realtime_doctor`, `realtime_trace_command`, `realtime_inspect_stream`, `realtime_leaks`, bounded `realtime_query_evidence`, and `realtime_query_evidence_closure`. All tools declare read-only, non-destructive, idempotent, closed-world annotations. Derived facts come first. Doctor returns a short opaque reference that expands only the selected conclusion closure through the same source handle; the handle retains at most 32 closures and evicts the oldest, so an evicted, altered, cross-handle, cross-source, or cross-query reference fails with `RT_DIAGNOSTIC_EVIDENCE_REFERENCE_INVALID`. Closure pages use the same count/byte bounds, authenticated cursor, tenant validation, redaction, completeness, and analyzer as other raw pages. The server reads only the evidence file explicitly supplied to its local process and exposes no mutation, disconnect, chaos, network-fetch, export, or admin operation.

The following larger resource/tool inventory remains a future extension rather than a v0 claim.

Potential resources:

```text
realtime://runtime/summary
realtime://incidents/latest
realtime://incidents/{incidentId}/manifest
realtime://incidents/{incidentId}/records
realtime://incidents/{incidentId}/causal-graph
realtime://incidents/{incidentId}/resource-graph
realtime://incidents/{incidentId}/state-transitions
realtime://incidents/{incidentId}/context
realtime://records/{recordId}
realtime://streams/{stream}
realtime://commands/{commandId}
realtime://resources/orphaned
realtime://schemas/diagnostics
```

Potential tools:

```text
diagnose_runtime
trace_command
explain_stream_gap
find_resource_leaks
compare_snapshots
export_incident
```

State-changing operations such as disconnecting clients or running chaos scenarios are outside the default read-only capability and require explicit authorization.

### OTLP

OTLP integration exports compatible traces, logs, and metrics to existing collectors. The realtime evidence schema remains authoritative because generic telemetry does not express all application-level guarantees.

OTLP sampling, queue overflow, collector rejection, retry exhaustion, and partial success update incident coverage. Generic telemetry sampling must not silently remove records required by an active diagnostic contract.

### Visual Devtools

The visual UI is implemented later as another consumer of the same diagnostic query API. UI-only state must not contain evidence unavailable to CLI or AI clients.

## Incident bundle contract

A self-describing bundle contains a manifest, source records, causal edges, derived facts, issues, resource graph, state transitions, topology, capabilities, sanitized configuration, build/source references, schema definitions, redaction manifest, and coverage/loss report. Every reference resolves inside the bundle or through an explicit stable external locator.

## Privacy and access control

- Tokens, cookies, credentials, and authorization headers are never captured by default.
- Payload and state capture uses field-level allowlists and redactors; identifiers must not encode personal data.
- Evidence is isolated by tenant and environment.
- Production MCP access is disabled by default. CLI, MCP, queries, and exports require authorization and produce audit records.
- Export runs a sensitive-data check and preserves a redaction manifest.
- Evidence is never sent automatically to an external AI provider.

## Diagnosability completion test

For every injected fault, the evidence must answer:

1. What outcome was expected?
2. What outcome occurred?
3. What was the last successful boundary?
4. What was the first divergent boundary?
5. Which component and version owned that boundary?

If those questions cannot be answered, the feature is insufficiently instrumented even when its normal-path tests pass.

The suite also uses fault pairs: different injected causes that produce the same visible symptom must yield distinguishable evidence. Cleanup pairs include release never requested versus failed versus timed out, partial-initialization rollback failure, and a stale completion that was fenced versus one that resurrected a resource. Sufficiency is asserted from evidence schemas and facts independently of any particular AI model.

## Alpha capture topology boundary

For the alpha CLI/MCP surface, completeness is **complete for the declared capture topology**, not production-global completeness. `server.evidenceBundle()` declares and captures one gateway server producer and that gateway's PostgreSQL store producer. Browser records, another gateway, PostgreSQL general logs, an exporter, and any producer not declared in the bundle are not implied.

The current MCP is local stdio/read-only analysis of an explicitly extracted file. General browser evidence export, a remote durable evidence store, and a live authenticated production MCP service are unsupported. Sampling-based Sentry or OpenTelemetry data may complement operations but cannot replace unsampled correctness/causality evidence.
