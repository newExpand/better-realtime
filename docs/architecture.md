# System Architecture

Status: draft

## Architectural shape

```text
React hooks
    ↓
Framework-neutral client runtime
    ↓
Canonical realtime protocol
    ↓
Transport adapter (WebSocket / Socket.IO / SSE+HTTP)
    ↓
Gateway and server runtime
    ↓
Application handlers and state materializers

Server runtime extension points:
EventLog · LiveBus · InterestRouter · PresenceEngine
ChangeSource · SnapshotProvider · IdempotencyStore · TelemetrySink
```

The canonical protocol is independent of React, a transport library, a server language, and backend infrastructure.

Diagnostics are part of this architecture from the first reliability path. Protocol handlers, state machines, resource scopes, persistence boundaries, and adapters emit the versioned facts and explicit causal relationships defined in [diagnostics.md](diagnostics.md). An analyzer, MCP server, or visual UI may be added after the evidence query surface is stable, but correctness-critical evidence is not a later instrumentation layer.

## Main components

### Contract

The contract defines streams, subscription input, snapshot schemas, event schemas, commands, and results.

```ts
const roomInput = jsonSchema("example.chat.room.input@1", { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } }, additionalProperties: false })
const contract = defineRealtimeContract({
  contractId: "example.chat",
  manifestVersion: "1.0.0",
  streams: {
    room: stream({
      input: roomInput,
      snapshot: roomState,
      events: {
        messageAdded,
        messageDeleted,
      },
      key: ({ roomId }) => `room:${roomId}`,
      initial: () => ({ messages: [], sequence: 0 }),
      applyEvent,
      snapshotSequence: (state) => state.sequence,
    }),
  },
  commands: {
    sendMessage: command({
      input: sendMessageInput,
      result: sendMessageResult,
    }),
  },
})
```

Every `jsonSchema(identity, schema)` call supplies an explicit language-neutral identity such as `example.chat.message-added@1`. Stream inputs, snapshots, event data, command inputs, and command results carry independent identities in the manifest. Client and server validation read those manifest identities rather than reconstructing `${member}@1`; changing a durable payload shape therefore requires a new identity version and changes the contract digest.

TypeScript contracts provide first-class inference for primitive, object, array, tuple, `const`/`enum`, nullable type arrays, `oneOf`/`anyOf`, and `allOf` composition. `$ref`/`$defs`, pattern/additional-property projection, conditional schemas, and other Draft 2020-12 keywords still validate at runtime but conservatively infer as the wider JSON value when the convenience layer cannot prove a precise TypeScript type. Every contract member that participates in a cross-language support claim remains the emitted Draft 2020-12 schema; the TypeScript inference layer is not the language-neutral contract itself.

Application snapshot and command mutation handlers receive a lifetime-bounded, promise-only `query(text, values)` port rather than the transaction-owned PostgreSQL `PoolClient`. The port exposes no release, listener, callback, `Submittable`, or connection-control surface; it is revoked when the callback settles and rejects a callback that returns with unobserved or unsettled database work. Each issued thenable and derived chain has an internal rejection sink, but application code must still join it through `await` or an outcome-complete chain; fire-and-forget queries cannot commit the enclosing operation. The SQL boundary accepts exactly one `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `WITH` statement. Application data must use bind parameters: inline single-quoted and dollar-quoted strings are rejected, while quoted identifiers and comments are parsed only to establish the conservative command boundary. Transaction control, DDL, `LISTEN`/`NOTIFY`, session configuration, session advisory-lock functions, and `SELECT INTO` are rejected before node-postgres sees them. Every accepted query is also submitted in node-postgres extended-query mode, so PostgreSQL itself rejects multiple commands even if the lexical precheck were incomplete. Together these controls preserve the framework-owned transaction and pooled-session resource boundary. At the underlying node-postgres rejection boundary the framework snapshots SQLSTATE and infrastructure classification into an immutable framework-private value and binds that snapshot—not the mutable driver error—to the enclosing application failure. Handler-thrown errors that copy or mutate a SQLSTATE, database-looking message, cause, or constructor cannot forge that provenance. Database-producer SQLSTATE evidence is emitted only for an actual node-postgres `DatabaseError`; gateway-observer evidence can cite the immutable query-boundary snapshot without claiming to be the database producer. A trusted infrastructure/connection failure drives retry and bounded gateway drain, while a trusted authoritative transaction abort retains its rollback/retry classification without claiming database-wide unavailability.

The TypeScript builder produces a language-neutral `ContractManifest` containing stream and command identifiers, subscription inputs, materialization and ordering domains, payload JSON Schemas, and compatibility metadata. Future language SDKs may consume or produce an equivalent manifest after their portability and conformance gates pass. AsyncAPI may be exported for documentation and code generation, but the canonical wire protocol remains the source of recovery, ordering, dedupe, and command semantics.

Protocol, payload schema, diagnostic schema, and package versions are independent compatibility boundaries.

### Client runtime

Responsibilities:

- own the connection resource lifecycle outside React and configure the selected single physical reconnect owner;
- manage authentication and coordinate semantic recovery after physical reconnection;
- multiplex logical stream subscriptions;
- maintain connection, stream, and command state machines;
- detect gaps and duplicates;
- request replay or resync;
- apply snapshots, patches, domain events, or invalidations through explicit materializers;
- expose immutable snapshots to framework bindings;
- enforce bounded buffers and cleanup;
- emit diagnostic evidence at every meaningful boundary.

### React binding

React integrates through `useSyncExternalStore` and reference-counted subscriptions.

```text
Component A subscribes room:42 → local count 1, remote subscription starts
Component B subscribes room:42 → local count 2
Component A unmounts           → local count 1
Component B unmounts           → local count 0, remote subscription stops
```

A short idle grace period may prevent route churn. Strict Mode and HMR must not leave duplicate connections or listeners.

### Server runtime and future language SDKs

Every native server SDK has the same semantic responsibilities:

- validate wire messages and portable payload schemas at runtime;
- authenticate sessions and authorize each stream and command, including refresh and reauthorization;
- create stable event identities and sequences within declared ordering domains;
- execute commands idempotently within declared retention and, where supported, atomically append their resulting events;
- provide replay, cursor-expiry handling, snapshot fencing, subscription multiplexing, and live fan-out;
- enforce backpressure, graceful drain, lease cleanup, and bounded resources;
- emit diagnostic evidence at every correctness boundary.

SDKs adapt ecosystem servers instead of rebuilding their networking stacks: Socket.IO, `ws`, or uWebSockets.js on Node; `net/http`, Gin, or Fiber on Go; Axum or Actix on Rust; FastAPI or Django Channels on Python; and Spring WebSocket or Netty on Java. A native SDK can implement the complete contract. A protocol adapter around an existing server declares only the capabilities it can actually prove.

The TypeScript/Node runtime is the reference implementation. The approved post-alpha roadmap commits to a Go server SDK/runtime and React Native client without promising a version or date; every other native SDK remains demand-gated. Each SDK still must pass protocol, platform, cleanup, diagnostics, security, documentation, and continuous-conformance gates before becoming supported. Language neutrality is an early contract requirement; roadmap status is not runtime support.

### Transport adapter

The transport adapter owns only the selected physical connectivity mechanisms. Application-level reliability semantics remain in the canonical runtime.

```ts
interface TransportAdapter {
  connect(options: ConnectOptions): Promise<TransportSession>
}

interface TransportSession extends AsyncDisposable {
  readonly incoming: AsyncIterable<WireMessage>
  send(message: WireMessage): Promise<SendReceipt>
  close(reason?: CloseReason): Promise<void>
}
```

`SendReceipt` is named and typed by its boundary, such as local queue acceptance, socket write, or transport-level acknowledgement. It is never evidence of command acceptance, domain commit, peer receipt, or client application unless a separate protocol record proves that boundary.

The initial reference transport is browser-native WebSocket with subprotocol `better-realtime.v1` and Node `ws`. The reference server explicitly uses `maxPayload: 1_048_576` and `perMessageDeflate: false`. Browser authentication uses a same-origin secure cookie or canonical `session.open`; bearer tokens are never encoded in the URL. The protocol's application heartbeat is the single reference liveness loop because browsers cannot emit WebSocket control ping frames.

Socket.IO is an approved post-alpha compatibility adapter for existing applications, without a promised version or date. Its Manager may own physical reconnect, but its retry queue, disconnected-send buffer, ACK, and connection-state recovery MUST NOT be translated into durable command acceptance, replay, or current authorization without canonical protocol evidence. Connection-state recovery may optimize continuity; explicit stream resubscribe, cursor recovery, and command status reconciliation remain correctness fallbacks. SSE and other transport candidates remain demand-gated.

Exactly one layer owns each physical connection mechanism: connect/disconnect, reconnection scheduling, liveness, disconnected-send buffering, and transport acknowledgement. If a transport library provides one of these behaviors, its adapter must disable it, delegate ownership to it explicitly, or translate its state and evidence into the canonical runtime contract. Two layers must not independently reconnect or report the same transport guarantee. The canonical runtime still owns semantic recovery above the connection: stable command retry identity, subscription restoration, replay, dedupe, resync, and command reconciliation.

### EventLog

Provides durable append, cursor-based replay, and head discovery.

```ts
interface EventLog {
  append(event: NewEvent): Promise<StoredEvent>
  readAfter(stream: StreamKey, cursor: OpaqueCursor): AsyncIterable<StoredEvent>
  head(stream: StreamKey): Promise<OpaqueCursor>
}
```

Potential implementations include memory for development, Postgres, Redis Streams, Kafka, and custom stores.

### LiveBus

Provides low-latency server-to-server fan-out. It is deliberately separate from durable replay.

```ts
interface LiveBus {
  publish(event: StoredEvent): Promise<void>
  subscribe(
    interests: StreamKey[],
    handler: (event: StoredEvent) => Promise<void>,
  ): Promise<AsyncDisposable>
}
```

Potential implementations include in-process dispatch, process IPC, Postgres `LISTEN/NOTIFY`, Redis Pub/Sub, NATS Core, and cloud Pub/Sub systems.

### InterestRouter

Tracks which gateway currently has subscribers for a logical stream so large event backbones do not broadcast every event to every gateway.

```ts
interface InterestRouter {
  registerGateway(gateway: GatewayId, lease: Lease): Promise<void>
  renewGateway(gateway: GatewayId, lease: Lease): Promise<void>
  add(gateway: GatewayId, stream: StreamKey): Promise<void>
  remove(gateway: GatewayId, stream: StreamKey): Promise<void>
  locate(stream: StreamKey): Promise<GatewayId[]>
}
```

Gateway registrations and interests expire with their lease after abrupt failure. A restarted gateway reconstructs interests from its active local subscriptions.

### PresenceEngine

Presence is separate from subscriptions and durable application state. Implementations may use leases in Redis, database state, or CRDT/gossip-based replication.

Tabs and devices are separate sessions. User-level online state is derived from the set of active leases: a clean disconnect may release immediately, while abrupt loss disappears only after lease expiry.

### ChangeSource

Turns committed database changes into realtime events through transactional outbox, CDC, MongoDB Change Streams, or a custom source.

```ts
interface ChangeSource {
  subscribe(options: {
    after?: OpaqueCursor
    signal: AbortSignal
    onChange(change: SourceChange): Promise<void>
  }): Promise<AsyncDisposable>
}
```

### Commit-to-event consistency

For a profile that declares durable convergence, an application mutation and its outbox/event append share an atomic transaction or an equivalently provable commit boundary. Delivery to an external LiveBus happens from the committed log/outbox and is retryable. `database commit → best-effort publish` is not a supported strong path and must downgrade capabilities and emit diagnostic evidence when used.

PostgreSQL transaction outcomes use an independent state machine: `pre_commit → commit_in_flight → committed | rolled_back | indeterminate`, with `indeterminate → reconciling → reconciled | indeterminate`. The node-postgres public API cannot generally prove whether a connection/timeout error occurred before or after the server committed. Therefore every COMMIT flows through one classifier. Only a PostgreSQL ErrorResponse whose semantics prove abort can enter `rolled_back`; connection termination, cancellation, timeout, SQLSTATE `08007`/`40003`, and other unproven outcomes enter `indeterminate`. A ROLLBACK attempted on the old connection is resource cleanup, not transaction-outcome evidence.

Every write transaction also inserts its unique transaction ID and operation into `realtime_transaction_attempts` in the same atomic unit. Immediately before the bounded COMMIT call, the marker lease timestamp is refreshed; the configured COMMIT plus reconciliation deadlines and a safety margin must fit inside its five-minute retention. The cleanup index on `marker_written_at` bounds the age scan. Reconciliation opens a fresh connection from a pool whose acquisition timeout cannot exceed the reconciliation deadline, applies one JavaScript deadline to `BEGIN`, timeout setup, serialization locks, inspection queries, and cleanup, then uses the exact durable attempt marker. A row created by a competing retry can therefore prove operation convergence but can never be attributed to the original attempt. Command reconciliation uses tenant/principal/command advisory ownership and requires matching intent plus command, result, event, and outbox rows. Direct append uses tenant/stable-append identity plus a versioned canonical intent that includes an explicit effect schema and effect-defining payload. Principal resolution uses the canonical-identity advisory namespace and unique aliases. Outbox reconciliation waits on every claimed row lock, checks the exact attempt marker, and reads `notify_committed_at`; batch evidence links the transaction to every event. Schema migration, command retention, outbox retention, and stream-retention writes use the same marked transaction contract rather than implicit autocommit. Each path may safely rerun only after serialized marker absence proves that the original transaction had no durable effect. A published outbox row is an expiring wake hint: ordinary retained command and stable-append duplicate lookup relies on the durable command/event identity, while only exact ACK-loss reconciliation requires the still-atomic event/outbox proof. Read-only snapshots create no durable effect, so an ambiguous attempt is discarded and its original outcome is resolved as `no_durable_effect` only after a fresh bounded snapshot transaction succeeds. The subsequent live-fence callback and separate recovery-head query share another bounded fence deadline; a stalled head query destroys its connection and cannot emit `snapshot.created`.

### SnapshotProvider

Returns authoritative state when replay cannot restore continuity. State and included cursor come from one atomically consistent view. The recovery coordinator captures a head, preserves every later event behind count and byte bounds, applies the snapshot and catch-up, and releases live delivery only after continuity through that head is proved. Overflow restarts fenced recovery or fails explicitly. The recovery-demo projection is itself a bounded state contract: the PostgreSQL provider returns at most the latest 100 messages and at most 512 KiB of serialized state, and exposes `windowStartSequence` plus `truncated` instead of pretending the compact projection is full history. The strong PostgreSQL profile requires domain projection mutation and event/outbox append to use the same writer transaction port; composite deferred foreign keys prevent a projection row without its event, rollback tests prove the shared boundary, and concurrent-writer conformance proves that an event committed after `S` and through `H` appears only in `(S,H]`. Arbitrary database owners that can mutate projection rows outside that port are outside this guarantee and must be prevented with deployment permissions.

### IdempotencyStore

Tracks command identity, accepted execution, completion, and recoverable results. It prevents a retry after an uncertain acknowledgement from applying the same domain effect twice.

## Independent state machines

The normative transition inventory is [machine-readable](../spec/protocol/v1/state-machines.json). Connection, session, stream, command, transaction-outcome, and resource-scope state remain independent and MUST NOT collapse into one generic loading or error flag. In particular, transport `open` does not imply session `ready`; stream `replaying` does not imply connection failure; command `accepted`, `completed`, and client-derived `observed` are separate evidence boundaries; and a failed COMMIT acknowledgement does not imply rollback.

Client-local command states such as `queued` and `sending` are distinct from server-issued receipts. `accepted` means the server has durably accepted responsibility according to the negotiated contract; `observed` means the declared causal completion condition has been applied by this client. Event-free and multi-event commands must declare their own completion condition.

## Materialization modes

- Snapshot: replace local state at a declared cursor.
- Patch: apply JSON Patch or an application-defined patcher.
- Domain event: apply an explicit reducer.
- Invalidation: notify TanStack Query or another cache to refetch.

The runtime coordinates ordering and recovery but does not invent domain semantics.

## Gateway topology and lifecycle

- Each gateway has a boot-scoped identity and owns its live sessions.
- A browser-native WebSocket remains on the gateway that accepted that physical connection; a reconnect may select another healthy gateway. The Postgres profile therefore does not require application-session affinity. Socket.IO and its long-polling affinity concerns are outside this profile.
- The selected single physical reconnect owner uses bounded exponential backoff and jitter to limit storms; the canonical runtime separately drives semantic subscription restoration, replay/resync, and command reconciliation after connection recovery.
- Graceful drain stops new sessions, advertises `server_draining` and retry guidance, fences stale work, and releases subscriptions within a bounded deadline.
- Abrupt loss is recovered through replay and lease expiry for presence and interest records.
- Region affinity or redirect is a future negotiated capability rather than an implicit guarantee.

## Deployment profiles

A profile is a convenience composition of ports, not a guarantee level. Its final capabilities are computed from the configured durable log, live bus, snapshot, idempotency, transport, and retention policies.

Standalone and Postgres-only are the initial supported profile targets. Redis, NATS, Kafka, and actor/edge sections describe demand-gated architectural targets, not current support claims; each becomes supported only after its capability and continuous-conformance gates pass.

### Local development endpoints

Local development binds only to `127.0.0.1` and opens ports only while the corresponding process is running. The reference server defaults to `43170` and the recovery demo defaults to `43171`, avoiding common framework defaults. Override them together when needed:

```sh
REALTIME_SERVER_PORT=43270 REALTIME_DEMO_PORT=43271 pnpm dev
```

The same variables configure Playwright's server, proxy, health check, and browser base URL. Invalid values and occupied ports fail explicitly instead of silently selecting a mismatched endpoint. Integration tests, doctor, and plateau checks request OS-assigned ephemeral ports; the Docker PostgreSQL harness maps its container port to a random loopback host port so concurrent projects and test runs do not depend on a shared fixed port.

The health-aware browser test proxy is harness infrastructure rather than a product load balancer. It keeps one native WebSocket on one selected gateway for that connection and may select another healthy gateway only on reconnect. Both directions have message and byte bounds: client messages waiting for the upstream handshake and gateway messages waiting for the browser are count/byte limited, and downstream `bufferedAmount` overflow closes both sides with an explicit retryable slow-consumer boundary instead of absorbing gateway backpressure.

### Standalone

One server process, in-memory subscriptions, optional persistent application database.

### Postgres-only

An event table provides replay and `LISTEN/NOTIFY` wakes gateways after commit. This is the preferred low-infrastructure adoption path.

The event table/outbox is the durable source of truth. `NOTIFY` carries only a wake-up hint such as a row ID or head; lost notifications and gateway restarts converge through cursor-based table catch-up.

The transactional outbox worker is the only `pg_notify` producer. It claims pending rows with `FOR UPDATE SKIP LOCKED`, calls `pg_notify`, and sets `notify_committed_at` in the same short transaction. A visible non-null marker proves that some publishing transaction committed; the exact `realtime_transaction_attempts` marker proves whether it was the original attempt. Neither proves that a listener existed, received the notification, or processed the event, and `notify_committed_at` is a pre-commit clock sample rather than PostgreSQL's exact commit timestamp. If the worker loses the COMMIT acknowledgement, a fresh transaction locks every exact claimed row and checks both markers before recording a resolution; a competing worker's marker never becomes proof for the original transaction. Domain writers append the event and outbox row atomically but do not notify directly. A gateway remains unready and rejects WebSocket upgrades until a startup invocation of this exact publisher path succeeds; generic `SELECT 1` health is not outbox readiness proof.

The alpha PostgreSQL profile uses one exact-contract-identity-bound dedicated schema (default `better_realtime`). A deployment migration creates only framework objects and binding metadata (contract ID, manifest version, and manifest digest) in an empty schema; runtime startup performs read-only version/binding checks and never DDL. All framework SQL is schema-qualified, advisory locks include the storage namespace, and the NOTIFY channel is deterministically schema-derived. Demo/application tables use a separate application migration. Migration and runtime database roles are distinct operational boundaries.

The public WebSocket server evaluates an exact canonical Origin policy during HTTP upgrade before authentication, client slots, or per-connection resources. Browser Origin is an additional CSWSH defense and does not replace authentication/authorization. Direct TLS is outside the alpha server; WSS termination, forwarded upgrade headers, and proxy timeout/heartbeat alignment belong to the deployment proxy.

Authenticated identities resolve to a durable, opaque `principalNamespaceId` shared by every gateway. A versioned canonical identity tuple is looked up through versioned keyed fingerprints, while transaction/upsert uniqueness makes simultaneous first authentication converge on one namespace. Key rotation adds current-key aliases to the same durable namespace before an old key is retired. Command identity, locks, lookup, and cleanup are scoped by tenant, durable principal namespace, and command ID.

The gateway accepts identity only through an injected authentication port. The executable loopback demo uses server-signed, short-lived fixture bearer credentials so the browser cannot select its tenant, subject, or permissions; its credential issuance endpoint and shared signing key are test-harness facilities, not a production authentication implementation. Refresh, revocation, and a general identity provider integration remain explicitly outside this profile.

### Redis

Postgres or another durable log provides replay. Redis provides live fan-out, presence, interest routing, rate limits, and short-lived coordination. Redis Streams may also provide a moderate-scale replay log.

### NATS

NATS Core provides subject-based fan-out. JetStream optionally provides persistence, replay, acknowledgements, and consumer progress.

### Kafka plus live router

Kafka provides the durable event backbone. A realtime router consumes relevant partitions and forwards events only to interested gateways, often through Redis or NATS. Kafka offsets are not exposed to browsers.

Events in one ordering domain map to the same partition or shard. An adapter must define how per-stream replay is served from shared partitions, a secondary index, and snapshots; if it cannot do so, it declares durable replay unsupported. Gateways do not each consume the full topic as an independent broadcast mechanism.

### Actor/edge

A room, user, document, or tenant can be owned by a virtual actor or Durable Object. The adapter maps actor-local sequencing and storage onto the canonical protocol.

Single logical ownership can serialize commands and state transitions for that key. The actor adapter still translates actor-local sequence and snapshot rules into canonical stream semantics rather than changing the public protocol.

## Cursor abstraction

Browser cursors are opaque and backend-independent. An adapter may internally map a cursor to a Postgres sequence, Redis Stream ID, Kafka partition/offset, or actor-local revision.

Backend coordinates must not appear in the public wire contract because doing so would make infrastructure migration a client protocol breaking change.

## Lifecycle and memory safety

Every resource has an owner, explicit disposal, and bounded lifetime or capacity.

Resource-scope disposal is idempotent and closes children in reverse acquisition order. Partial initialization rolls back already-acquired resources; closing scopes reject new acquisitions; asynchronous release has a bounded timeout and reports each failure. Client authentication receives the connection `AbortSignal`, and the initialization await also races that signal so `dispose()` settles `connect()` even when a provider ignores cancellation. Every stream subscribe call owns a unique token even when callers reuse the same listener function, and every resource-allocating client operation rejects after terminal disposal. `AbortSignal` requests cancellation but does not prove release. Connection, session, and subscription generations fence stale asynchronous completions so disposed work cannot resurrect state or resources.

If transport opening succeeds but authentication or the first `session.open` send fails, the client detaches the connection listeners, closes that transport, suspends the partial session, and enters bounded reconnect backoff before exposing the failure. The physical transport and both transport listeners belong to one connection `ResourceScope`; remote close, initialization rollback, and terminal client disposal share one in-flight cleanup promise. Reconnect and terminal disposal wait for that cleanup. Release failures are aggregated only after logical streams, commands, state machines, and runtime subscribers reach terminal cleanup, while a failed physical close remains a failed owned resource so leak diagnosis cannot report a false proven absence. Snapshot validators, event validators, and application materializers execute behind the stream operation boundary; an exception produces a terminal, agent-readable stream error and cannot escape a WebSocket listener or be followed by false replay-success evidence.

Resources include:

- connections and sessions;
- listeners and logical subscriptions;
- heartbeat, retry, lease, and idle timers;
- async iterators and replay tasks;
- broker/database subscriptions;
- pending commands and acknowledgement callbacks;
- dedupe indexes, event buffers, snapshot caches, and traces.

Disconnect cleanup is not sufficient because abrupt failures may omit callbacks. Presence and distributed ownership use leases or expiration. `AbortSignal` should propagate session cancellation, while explicit `dispose()` remains the authoritative release operation.

## Backpressure

Every client and inter-service boundary must define:

- maximum buffered records and bytes;
- coalescing rules for replaceable events;
- events that may be dropped;
- events that require resync instead of dropping;
- slow-consumer disconnect policy;
- observable buffer metrics and diagnostic events.

These rules apply to the per-client outgoing queue, replay-during-live buffer, EventLog reader, LiveBus subscriber, router-to-gateway queue, client materializer queue, and diagnostic exporter. Coalescing or dropping is allowed only when the contract declares an event replaceable and defines an equivalence rule. Otherwise overflow moves the stream to resync or terminates the slow session explicitly.

No queue, cache, trace list, or dedupe collection may grow without an explicit bound.

Each bounded structure declares limit dimensions, eviction/overflow action, the resulting correctness state, and a diagnostic record. Dedupe and idempotency bounds must agree with the negotiated replay and command-retention windows.

## Repository and package boundaries

The TypeScript reference starts as one monorepo with separate boundaries for the protocol/spec, conformance harness, framework-neutral core, React binding, Node server, testing, diagnostics/devtools, transports, stores, and TanStack integrations. Public installation should expose a small set of packages or subpath exports even when the internal package graph is larger.

The public `better-realtime` tarball packages that graph behind browser-safe root and `/react` exports. `/server`, `/diagnostics`, and `/mcp` are explicitly Node-only and resolve to an agent-readable failure module under the browser condition. The server facade accepts a contract, PostgreSQL profile, authentication callback, typed stream authorization/snapshot callbacks, and typed command preparation/mutation callbacks. The diagnostic facade separates source evidence from the recursively closed, pseudonym-only public result schema; CLI and MCP share one analyzer, and MCP can expand only a doctor-issued bounded evidence closure rather than accepting public pseudonyms as fresh raw query identifiers. `PostgresGatewayServer`, `PostgresEventLog`, transport factories, transaction state machines, and recorder internals remain internal ports.

The PostgreSQL profile gives every application snapshot/mutation callback a positive bounded `operationTimeoutMs` (2 seconds by default). The store owns one absolute deadline and revocable lease spanning pool acquisition, transaction setup, the public application database port, event/command/outbox writes, and cleanup; the facade cannot restart a fresh relative timeout inside that transaction. Timeout revokes the public database scope before rollback/release, so delayed handler code cannot issue autocommit work through a returned connection or claim a durable receipt/completion. The original authentication, authorization, preparation, snapshot, and mutation promises remain owned in a global `maxApplicationHooks` registry until their real settlement even after the caller-facing timeout; a never-settling consumer hook therefore consumes bounded capacity instead of permitting unbounded retry accumulation. Gateways also bound concurrent clients, subscriptions per client, queued inbound message count/bytes, outbound buffered bytes, and message size; a closed socket with in-flight application work retains its capacity ownership until that work settles or reaches its deadline. Exceeding a bound emits structured resource evidence and rejects or disconnects the scoped consumer. The default `GET /health` surface discloses only `status: ready|unready` with HTTP 200/503. Runtime identity, dependency flags, raw evidence, process inspection, and chaos routes are test-control-plane capabilities disabled by an own-property, exact-boolean boundary and are not reachable through `createRealtimeServer`. Only repository harness processes opt in explicitly, and those endpoints are not a production management API.

Command `prepare` defines the versioned canonical intent before the transaction. Its `mutate` executes inside the same existing transaction as the command row, event, and outbox append. The facade validates stream input/snapshot/event and command input/result payloads and schema names against the contract. It does not add a best-effort publish escape hatch to the durable profile; nondeterministic intent on a stable-ID retry is rejected as an intent conflict rather than becoming a second effect.

The Go server SDK/runtime is committed post-alpha work without a promised version or date; repository topology remains undecided. Any future SDK may begin in this monorepo or a separate repository according to ownership, tooling, release cadence, and continuous-conformance needs; protocol stability alone does not trigger a split.

Committed post-alpha work comprises the Socket.IO adapter, vendor-neutral telemetry contract, Sentry and OpenTelemetry integrations, React Native client, Go server SDK/runtime, durable diagnostic exporter/store, and authenticated/authorized/audited production MCP query service. This commitment has no version or date and does not make them supported before their platform, lifecycle, diagnostics, security, and conformance gates pass. Presence, Redis, NATS, Kafka, other infrastructure adapters, and other language SDKs remain demand-gated candidates. Extension ports and fixtures never create a public support claim by themselves.
