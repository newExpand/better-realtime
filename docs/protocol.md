# Realtime Protocol

Status: executable readiness draft

## Executable artifacts

- [Wire schema](../spec/protocol/v1/wire.schema.json) is the machine-readable Draft 2020-12 envelope contract.
- [State machines](../spec/protocol/v1/state-machines.json) enumerate valid connection, session, stream, command, and resource transitions.
- [Core conformance scenarios](../conformance/v1/scenarios.json) define black-box behavioral and diagnostic expectations.

These artifacts and this document form one contract. A behavioral change is incomplete until all affected representations and fixtures agree.

## Normative language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe implementation requirements.

## Design requirements

- The protocol is language-neutral and transport-neutral.
- Payloads are runtime validated even when generated types exist.
- Browser-visible cursors are opaque.
- Event identity, per-stream ordering, and command identity are distinct concepts.
- Unsupported capabilities are declared rather than emulated incorrectly.
- Protocol records carry enough correlation data to connect diagnostics across boundaries.

The TypeScript `defineRealtimeContract` builder is a convenience layer over this language-neutral contract, not a TypeScript wire fork. It emits a canonical Draft 2020-12 manifest containing stream input/snapshot/event and command input/result schemas plus stable wire schema names. Its SHA-256 digest is one member of the existing session contract identity. Unknown members, a mismatch in any of `contractId`, `manifestVersion`, or `manifestDigest`, wrong schema names, and invalid runtime payloads fail explicitly at their contract boundary. The builder adds no wire kind and does not change the v1 envelope schema.

## Common envelope

```json
{
  "protocol": "1.0",
  "kind": "event",
  "messageId": "msg_1001",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "causationId": "cmd_119",
  "sentAt": "2026-07-16T12:21:44.192Z"
}
```

`messageId` identifies the wire message. Domain events and commands use their own stable identities.

Examples below may show only kind-specific members for readability. A conforming wire record also includes every required common-envelope member for its kind; generated schemas are the authoritative required/optional field definitions.

Stable semantic identity and transmission-attempt identity are different. An `eventId` or `commandId` remains stable across replay and retry, while each wire attempt has a unique `messageId` plus `deliveryId` or `commandAttemptId`, session generation, and delivery mode. `sentAt` is diagnostic context, never ordering proof.

## Session establishment, resumption, and liveness

A WebSocket client requests the `better-realtime.v1` subprotocol. `session.open` MUST be the first application message, MUST be sent at most once on a physical transport, and MUST arrive within 10 seconds of transport open. Violation fails the session and closes the transport.

A session resolves to `session.ready` or `session.rejected`. Each accepted physical reconnect creates a new positive `sessionGeneration` and re-evaluates authentication, authorization, the complete contract identity, and capabilities. Browser authentication uses a same-origin secure cookie or credentials in `session.open`; bearer credentials MUST NOT be placed in the WebSocket URL.

A `session.rejected` error with `retryable: true` and `disposition: retry` is a recoverable session-establishment failure: the client MUST close the rejected transport, preserve bounded recovery/command state, honor the bounded retry hint, and continue the single jittered reconnect loop. Other session rejection dispositions are terminal for that runtime unless an application explicitly creates a new runtime. Transport upgrade does not establish a session; clients MUST enforce a finite session-open deadline, and reconnect backoff resets only after `session.ready`, not merely after a successful WebSocket upgrade.

Reconnect MAY present an opaque `resumeToken`. The token is a continuity credential, not authentication, and MUST be bound to its principal, tenant, contract, audience, and expiry. The server rotates it after acceptance. Resume failure does not require authentication failure: `session.ready` can report `resumeStatus: "unavailable"`, after which the client explicitly restores every stream using its last applied cursor and reconciles pending commands. The client MUST NOT infer that server rooms or subscriptions survived.

Support note for the TypeScript `0.1.x-alpha` runtime: resume-token restoration, in-session auth refresh, and foreground stale-transport replacement are protocol-defined but unsupported. The server does not issue a resume token and the client does not present one. Reconnect recovery uses each stream's last applied cursor plus stable command-status reconciliation. A peer that sends `session.auth.challenge` or expects `session.auth.update` receives an explicit `RT_AUTH_REFRESH_UNSUPPORTED` session failure; these messages are never silently ignored. Foreground visibility alone does not trigger a transport replacement in this runtime.

Credential expiry produces `session.auth.challenge`. Credential acquisition is single-flight; the client sends `session.auth.update`, and success returns `session.auth.updated` with a new `authGeneration`. New commands and subscriptions pause while refresh is unresolved, while heartbeat continues. Already accepted commands are not undone. Active streams MUST be reauthorized before paused application delivery resumes. Refresh failure and authorization revocation fail affected operations explicitly.

Protocol version, package SemVer, contract manifest version/digest, and payload schema identity are separate. The alpha TypeScript profile implements exact manifest compatibility only and does not negotiate mixed-version rolling deployments. Coordinated deployment or a versioned host/path is required.

Protocol 1.0 uses server-driven application heartbeat because browser WebSocket does not expose control ping/pong. `session.ready` negotiates `intervalMs` and `timeoutMs`; the reference profile uses 25,000 ms and 20,000 ms and accepts only finite integer values from 1,000 through 300,000 ms. The server sends `heartbeat.ping`, and the client MUST promptly echo its `pingId` in `heartbeat.pong`. Any valid incoming server message MAY prove recent server activity to the client, but only the matching pong proves client execution liveness to the server. An implementation that supports foreground stale-transport replacement replaces a stale connection when the document becomes visible and then recovers normally.

A draining server may send structured retry guidance. Physical connection establishment MUST have a finite deadline and release its pending socket when that deadline expires. Effective reconnect attempts MUST follow bounded exponential backoff with jitter owned by exactly one layer; the alpha client samples each configured ceiling in its half-to-full interval. The canonical runtime and transport library MUST NOT schedule competing physical reconnect loops. The runtime always retains ownership of semantic restoration, replay, resync, dedupe, and command reconciliation. Authentication-provider timeout or bounded hook-capacity exhaustion is a retryable non-enumerating session failure, not proof of invalid credentials.

## Capability negotiation

The server MUST declare active capabilities during session establishment.

```json
{
  "kind": "session.ready",
  "sessionId": "session_82",
  "sessionGeneration": 3,
  "authGeneration": 1,
  "resumeStatus": "fresh",
  "capabilities": {
    "schemaValidation": true,
    "eventIdentity": true,
    "ordering": "per_stream",
    "gapDetection": true,
    "durableReplay": true,
    "snapshotResync": "fenced",
    "idempotentCommands": true,
    "commandReceipts": true,
    "clientApplyAck": false,
    "eventDedupeWindowMs": 300000,
    "replayRetentionMs": 86400000,
    "idempotencyRetentionMs": 86400000,
    "commandResultRetentionMs": 86400000,
    "maxMessageBytes": 1048576,
    "maxRecoveryBufferRecords": 10000,
    "maxRecoveryBufferBytes": 16777216
  },
  "heartbeat": {
    "mode": "application",
    "intervalMs": 25000,
    "timeoutMs": 20000
  }
}
```

The protocol floor requires runtime schema validation, contract negotiation, structured error disposition, application heartbeat, stable message/attempt identities, and `maxMessageBytes`. The initial Postgres convergence profile additionally requires the stronger values illustrated above. Retention periods and buffer sizes remain negotiated profile parameters, not universal defaults.

A client MUST NOT infer a stronger guarantee than the declared capabilities. Independent capability fields and parameters, not a product-level numeric level, are normative. Capabilities may later vary by contract member; protocol 1.0 negotiates the session profile and rejects an operation whose declared requirements exceed it.

The client applies negotiated message and recovery-buffer limits subject to its own equal-or-lower safety ceilings. The in-memory reference server is process-local and therefore advertises `durableReplay: false`, `idempotentCommands: false`, and `commandReceipts: false`; its within-process replay, direct completion, and status behavior must not be interpreted as restart durability. The Postgres profile may advertise stronger values only after its storage, snapshot, and retention paths prove them.

When idempotent commands are advertised, `0 < commandResultRetentionMs <= idempotencyRetentionMs` is a required capability invariant. Within result retention, a completed result remains queryable. After result retention and through idempotency retention, the server retains a versioned canonical-intent tombstone, reports the unavailable result as `expired`, and MUST suppress re-execution of the same intent; reuse of the command ID with a different canonical intent is rejected. After idempotency retention, the server reports `unknown`, makes no claim that it can recognize an old retry, and a conforming client MUST NOT resend. Client-provided time such as `createdAt` is diagnostic context and is not retention proof.

After session establishment, each endpoint validates both the unified wire schema and message direction. A server-only kind sent by a client, or a client-only kind sent by a server, is an explicit `RT_MESSAGE_INVALID` protocol failure rather than an ignored message.

## Subscribe

```json
{
  "kind": "stream.subscribe",
  "requestId": "req_21",
  "stream": "room:42",
  "after": "opaque_cursor_or_null",
  "input": {
    "roomId": "42"
  }
}
```

The server responds with:

- `stream.subscribed`
- a structured `error` scoped to the subscription request.

An accepted subscription receives a stable `subscriptionId`, selected `mode` (`live`, `replay`, or `snapshot`), baseline cursor, and observed head. Replay mode continues with `stream.replay.begin`; snapshot mode continues with `stream.resync.required` and `stream.snapshot`. Later unsubscribe and recovery records use `subscriptionId`, not only a stream string.

## Event

```json
{
  "kind": "event",
  "messageId": "msg_1001",
  "deliveryId": "delivery_92",
  "sessionGeneration": 3,
  "deliveryMode": "live",
  "eventId": "evt_881",
  "stream": "room:42",
  "sequence": 47,
  "cursor": "opaque_cursor",
  "type": "messageAdded",
  "occurredAt": "2026-07-16T12:21:44.101Z",
  "commandId": "cmd_119",
  "schema": "MessageAdded@1",
  "data": {}
}
```

Requirements:

- An event ID MUST remain stable across retries and replay.
- A sequence MUST be monotonic within its declared stream/order domain.
- A client receiving an already-applied event ID MUST not apply the domain effect again.
- A client detecting a non-contiguous sequence MUST leave `live` state and begin recovery.

## Replay

```json
{
  "kind": "stream.replay.begin",
  "stream": "room:42",
  "requestedAfter": "cursor_44",
  "head": "cursor_47"
}
```

Replay events use the normal event envelope with replay metadata.

Every replay has a `replayId`. Its events declare `deliveryMode: "replay"`; live attempts declare `deliveryMode: "live"`. The same domain event keeps its `eventId` while each attempt receives a new delivery identity.

```json
{
  "kind": "stream.replay.complete",
  "stream": "room:42",
  "through": "cursor_47"
}
```

Requirements:

- The server MUST NOT emit `stream.replay.complete` before all selected replay events have been emitted.
- Live events received during replay MUST be buffered or merged without violating per-stream ordering.
- The client MUST enter `live` only after continuity through the declared replay head is verified.
- If the requested cursor is expired or cannot be resolved, the server MUST request resync instead of pretending replay succeeded.

## Snapshot resync

```json
{
  "kind": "stream.snapshot",
  "subscriptionId": "sub_81",
  "resyncId": "resync_7",
  "snapshotId": "snapshot_4",
  "stream": "room:42",
  "cursor": "cursor_90",
  "head": "cursor_96",
  "schema": "RoomSnapshot@3",
  "stateHash": "sha256:...",
  "state": {}
}
```

The cursor represents the event-log position included in the snapshot. Events after that cursor may be applied in sequence.

The snapshot provider MUST obtain state and cursor from one atomically consistent view. Snapshot and live delivery share a fenced boundary: the server captures or declares a recovery head, retains or buffers every event after the snapshot cursor, sends the snapshot, sends `snapshot_catchup` events through the head, and only then emits `stream.replay.complete`. The client buffers concurrent live attempts and enters `live` only after continuity is verified.

Recovery buffering is bounded by negotiated record and byte limits. Overflow emits `RT_RECOVERY_OVERFLOW`, discards the partial recovery attempt, and starts a new fenced snapshot or fails explicitly. It MUST NOT drop records and declare the stream live.

## Commands

```json
{
  "kind": "command",
  "messageId": "msg_1000",
  "commandAttemptId": "cmd_attempt_2",
  "sessionGeneration": 3,
  "commandId": "cmd_119",
  "type": "sendMessage",
  "schema": "SendMessage@1",
  "input": {},
  "createdAt": "2026-07-16T12:21:43.800Z"
}
```

Server-issued command receipts are reported independently from client-local `queued` and `sending` states:

```json
{
  "kind": "command.receipt",
  "commandId": "cmd_119",
  "state": "accepted"
}
```

Server states include `accepted`, `completed`, `rejected`, `expired`, and `unknown`. `accepted` means the server has durably accepted responsibility according to the negotiated capability; it is not proof that a domain effect committed. Contract results are returned in a recoverable `command.completed` record or by an explicit result lookup within receipt retention.

After an uncertain delivery or a reconnect, the client sends `command.status.request` with the stable command ID. `command.status` reconciles to `accepted`, `completed`, `rejected`, `expired`, or `unknown`. A completed status MAY repeat the producer-confirmed `causalEventIds` and bounded `causalEvents` positions (`eventId`, `stream`, positive `sequence`) from `command.completed`. The client may derive `observed` only after an exact causal event was applied or an authoritative snapshot for that same stream proves inclusion through at least that producer-issued sequence; a matching command ID in unrelated event data is never proof. The client MAY resend within the negotiated idempotency window, but MUST use the same `commandId` and a new `commandAttemptId`. It MUST NOT blindly retry when the status is beyond provable retention.

A client validates the declared command-result schema identity and payload before transitioning the local attempt to `completed` or recording success evidence. A schema-name or payload mismatch rejects the local attempt as a contract failure; neither `completed` nor `observed` may be claimed from that message. Consumers may await either settlement boundary independently, so an implementation must own rejection handling for the boundary the consumer does not select.

`observed` is a client-derived state: the command's declared causal completion condition has been applied by that client. A command may declare one causal event, several events, or an event-free completion receipt. Causal event identity and any snapshot-inclusion position are producer-issued; application payload metadata such as `commandId` is not causal proof. Each transmission attempt uses a unique `commandAttemptId`, while retry reuses the stable command ID.

Requirements:

- A retry MUST reuse the same command ID.
- Every independent `execute()` invocation MUST create a new command ID unless the application supplies an explicit shared idempotency key.
- A server declaring idempotent command support MUST not apply the same command ID's domain effect more than once.
- A transport acknowledgement MUST NOT be treated as proof that the domain effect committed.
- An accepted receipt MUST NOT be treated as proof that the resulting event was observed by the client.
- Command identity uniqueness is scoped by tenant, the authenticated durable principal namespace, and command ID. The principal namespace is server-derived and cannot be selected by a wire field.
- Intent equality uses a versioned, language-neutral canonical contract over command type, schema/version, and effect-determining input. It MUST NOT depend on object-key insertion order or a language-specific `JSON.stringify` result.
- Idempotency and result lookup are bounded independently. Duplicate suppression is guaranteed only through negotiated `idempotencyRetentionMs`; result lookup is guaranteed only through negotiated `commandResultRetentionMs`.
- A retry within idempotency retention reuses the command ID. The same canonical intent does not create another effect, while a different intent is rejected explicitly.
- After idempotency retention, status is `unknown`, the server does not claim duplicate knowledge, and the client MUST NOT resend.
- If the database commit acknowledgement is unavailable and serialized reconciliation cannot prove an outcome within its bound, the server MUST return `RT_TRANSACTION_OUTCOME_INDETERMINATE` (or an indistinguishable generic retry/failure envelope where enumeration resistance requires it). It MUST NOT issue a durable command receipt, completion, or success claim for that attempt. A later status query is serialized by the same tenant/principal/command namespace before it reports durable state.

Store adapters that expose direct event append outside the command path require a caller-provided stable operation identity. That identity is scoped by tenant and bound to a versioned canonical intent covering stream, event type, schema/version, and effect-determining data. The same identity and intent converge to one event; a different intent under the same identity is rejected. An implementation that cannot provide this durable identity contract MUST return a typed indeterminate result after uncertain commit acknowledgement and mechanically prohibit automatic retry.

## Unsubscribe

```json
{
  "kind": "stream.unsubscribe",
  "requestId": "req_22",
  "subscriptionId": "sub_81"
}
```

The server acknowledges release. Abrupt connection loss still triggers server-side lease expiration and session cleanup.

## Errors

Errors use stable machine codes and may include retry and recovery instructions.

```json
{
  "kind": "error",
  "error": {
    "code": "RT_CURSOR_EXPIRED",
    "scope": "stream",
    "disposition": "resync",
    "retryable": false,
    "stream": "room:42",
    "details": {}
  }
}
```

`code`, `scope`, `disposition`, and `retryable` are required. `retryAfterMs` and correlation identifiers are optional. The structured error is authoritative; a WebSocket close code and reason are only fallback transport evidence because the browser-visible reason is bounded to 123 UTF-8 bytes. If the structured record is absent, the cause remains unknown and the client applies normal reconnect policy rather than guessing from text.

Initial stable codes include `RT_SESSION_INIT_TIMEOUT`, `RT_CONTRACT_INCOMPATIBLE`, `RT_AUTH_REQUIRED`, `RT_AUTH_EXPIRED`, `RT_MESSAGE_INVALID`, `RT_MESSAGE_TOO_LARGE`, `RT_CURSOR_EXPIRED`, `RT_GAP_DETECTED`, `RT_RECOVERY_OVERFLOW`, `RT_SLOW_CONSUMER`, `RT_COMMAND_REJECTED`, `RT_COMMAND_EXPIRED`, `RT_COMMAND_OUTCOME_UNKNOWN`, and `RT_TRANSACTION_OUTCOME_INDETERMINATE`.

`RT_TRANSACTION_OUTCOME_INDETERMINATE` means the server cannot prove whether a database transaction committed. It is not equivalent to rollback and is not, by itself, authorization for a blind domain retry. A successful competing retry proves only convergence of the stable operation; it MUST NOT be presented as proof that the original database transaction committed. Durable success may be claimed only after exact-attempt reconciliation or a later independently identified operation succeeds. The existing extensible error envelope is sufficient; protocol 1.0 adds this normative code meaning without changing the wire schema shape.

## Ordering model

- The core guarantee is per declared stream/order domain, not global ordering.
- Cross-stream events are concurrent unless a causal edge explicitly relates them.
- Wall-clock timestamps MUST NOT be used as the sole ordering mechanism.
- Infrastructure-specific offsets remain internal to adapters.

## Delivery model

The protocol does not claim exactly-once network delivery. It combines retryable transport, stable identity, deduplication, idempotent commands, cursor replay, and snapshot reconciliation to make application effects converge.

Dedupe is bounded. Within the negotiated replay/dedupe window, duplicate event IDs MUST NOT reapply a domain effect. Outside that provable range, the client recovers through a checkpoint or snapshot instead of asserting indefinite duplicate knowledge.

## Compatibility

- Every envelope includes a protocol version.
- Payload schemas have independent, explicit identities in the form `portable-name@positive-integer-version`. Stream inputs, snapshots, each event payload, command inputs, and command results MUST declare their own identity; a builder MUST NOT derive it from a stream, event, or command member name.
- One contract manifest MUST NOT bind the same payload schema identity to different canonical Draft 2020-12 shapes. Reusing an identity for an identical shape is allowed, but a breaking shape change requires a new schema version. Durable replay is validated against the declared event schema identity, not against the TypeScript member name.
- Session establishment identifies the contract with `contractId`, SemVer `manifestVersion`, and `manifestDigest` formatted as `sha256:<64 lowercase hex characters>`.
- Protocol 1.0 requires the server and client to use the exact canonical manifest digest. A mismatch returns `RT_CONTRACT_INCOMPATIBLE`; future member-level compatibility rules require an explicit protocol addition.
- Canonical portable payload schemas use JSON Schema Draft 2020-12. The supported subset includes JSON primitives, objects, arrays, properties/required/additionalProperties, enum/const, oneOf/anyOf, local `$defs`/`$ref`, bounds, patterns, and annotations. Remote references, `$dynamicRef`, `unevaluated*`, custom keywords, function refinements, transforms, coercion, default mutation, and unspecified format assertions are non-portable.
- Unknown optional fields SHOULD be ignored.
- Unknown required message kinds or incompatible major protocol versions MUST fail explicitly.
- Adapter capability changes MUST be observable during session establishment or reconnection.
