export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface MessageBase {
  protocol: "1.0";
  kind: string;
  messageId: string;
  traceId?: string;
  causationId?: string;
  sentAt: string;
}

export interface ContractIdentity {
  contractId: string;
  manifestVersion: string;
  manifestDigest: `sha256:${string}`;
}

export interface Capabilities {
  schemaValidation: boolean;
  eventIdentity: boolean;
  ordering: "none" | "per_stream";
  gapDetection: boolean;
  durableReplay: boolean;
  snapshotResync: "none" | "fenced";
  idempotentCommands: boolean;
  commandReceipts: boolean;
  clientApplyAck?: boolean;
  eventDedupeWindowMs?: number;
  replayRetentionMs?: number;
  idempotencyRetentionMs?: number;
  commandResultRetentionMs?: number;
  maxMessageBytes: number;
  maxRecoveryBufferRecords?: number;
  maxRecoveryBufferBytes?: number;
}

export function assertCapabilityInvariants(capabilities: Capabilities): void {
  if (capabilities.idempotentCommands) {
    const resultRetention = capabilities.commandResultRetentionMs;
    const idempotencyRetention = capabilities.idempotencyRetentionMs;
    if (!Number.isSafeInteger(resultRetention) || !Number.isSafeInteger(idempotencyRetention) || resultRetention! <= 0 || resultRetention! > idempotencyRetention!) {
      throw new Error("RT_CAPABILITY_RETENTION_INVALID: expected 0 < commandResultRetentionMs <= idempotencyRetentionMs");
    }
  }
  if (capabilities.durableReplay && (!Number.isSafeInteger(capabilities.replayRetentionMs) || capabilities.replayRetentionMs! <= 0)) {
    throw new Error("RT_CAPABILITY_REPLAY_RETENTION_INVALID");
  }
  if (capabilities.snapshotResync === "fenced" && (!Number.isSafeInteger(capabilities.maxRecoveryBufferRecords) || capabilities.maxRecoveryBufferRecords! <= 0 || !Number.isSafeInteger(capabilities.maxRecoveryBufferBytes) || capabilities.maxRecoveryBufferBytes! <= 0)) {
    throw new Error("RT_CAPABILITY_RECOVERY_BUFFER_INVALID");
  }
}

export interface ErrorInfo {
  code: `RT_${string}`;
  scope: "connection" | "session" | "stream" | "command" | "message" | "runtime";
  disposition: "retry" | "refresh_auth" | "replay" | "resync" | "fail_operation" | "fail_session" | "none";
  retryable: boolean;
  retryAfterMs?: number;
  stream?: string;
  subscriptionId?: string;
  commandId?: string;
  details?: JsonObject;
}

export interface SessionOpen extends MessageBase {
  kind: "session.open";
  connectionAttemptId: string;
  contract: ContractIdentity;
  auth: JsonObject;
  resume?: { sessionId: string; resumeToken: string };
}

export interface SessionReady extends MessageBase {
  kind: "session.ready";
  sessionId: string;
  sessionGeneration: number;
  authGeneration: number;
  resumeStatus: "fresh" | "resumed" | "unavailable";
  resumeUnavailableReason?: "expired" | "invalid" | "not_found" | "capability_changed" | "principal_changed";
  resumeToken?: string;
  resumeExpiresAt?: string;
  capabilities: Capabilities;
  heartbeat: { mode: "application"; intervalMs: number; timeoutMs: number };
}

export interface SessionRejected extends MessageBase { kind: "session.rejected"; error: ErrorInfo }
export interface AuthChallenge extends MessageBase { kind: "session.auth.challenge"; challengeId: string; reason: "expiring" | "expired" | "revoked" | "policy_changed"; deadlineAt: string }
export interface AuthUpdate extends MessageBase { kind: "session.auth.update"; challengeId: string; auth: JsonObject }
export interface AuthUpdated extends MessageBase { kind: "session.auth.updated"; challengeId: string; authGeneration: number }
export interface HeartbeatPing extends MessageBase { kind: "heartbeat.ping"; pingId: string }
export interface HeartbeatPong extends MessageBase { kind: "heartbeat.pong"; pingId: string }

export interface StreamSubscribe extends MessageBase { kind: "stream.subscribe"; requestId: string; stream: string; input: JsonValue; after?: string | null }
export interface StreamSubscribed extends MessageBase { kind: "stream.subscribed"; requestId: string; subscriptionId: string; stream: string; mode: "live" | "replay" | "snapshot"; baseline?: string | null; head: string | null }
export interface ReplayBegin extends MessageBase { kind: "stream.replay.begin"; subscriptionId: string; replayId: string; stream: string; requestedAfter: string | null; head: string }
export interface EventMessage extends MessageBase { kind: "event"; deliveryId: string; sessionGeneration: number; deliveryMode: "live" | "replay" | "snapshot_catchup"; replayId?: string; eventId: string; stream: string; sequence: number; cursor: string; type: string; schema: string; commandId?: string; occurredAt?: string; data: JsonValue }
export interface ReplayComplete extends MessageBase { kind: "stream.replay.complete"; subscriptionId: string; replayId: string; stream: string; through: string }
export interface ResyncRequired extends MessageBase { kind: "stream.resync.required"; subscriptionId: string; resyncId: string; stream: string; reason: "cursor_expired" | "gap_unrecoverable" | "recovery_overflow" | "capability_changed" | "client_requested" }
export interface SnapshotMessage extends MessageBase { kind: "stream.snapshot"; subscriptionId: string; resyncId: string; snapshotId: string; stream: string; cursor: string; head: string; schema: string; stateHash?: `sha256:${string}`; state: JsonValue }
export interface StreamUnsubscribe extends MessageBase { kind: "stream.unsubscribe"; requestId: string; subscriptionId: string }
export interface StreamUnsubscribed extends MessageBase { kind: "stream.unsubscribed"; requestId: string; subscriptionId: string }

export interface CommandMessage extends MessageBase { kind: "command"; commandAttemptId: string; sessionGeneration: number; commandId: string; idempotencyKey?: string; type: string; schema: string; input: JsonValue; createdAt: string }
export interface CommandReceipt extends MessageBase { kind: "command.receipt"; commandId: string; state: "accepted" | "rejected" | "expired" | "unknown"; error?: ErrorInfo }
export interface CausalEventPosition { eventId: string; stream: string; sequence: number }
export interface CommandCompleted extends MessageBase { kind: "command.completed"; commandId: string; schema: string; result: JsonValue; causalEventIds?: string[]; causalEvents?: CausalEventPosition[] }
export interface CommandStatusRequest extends MessageBase { kind: "command.status.request"; requestId: string; commandId: string }
export interface CommandStatus extends MessageBase { kind: "command.status"; requestId: string; commandId: string; state: "accepted" | "completed" | "rejected" | "expired" | "unknown"; schema?: string; result?: JsonValue; causalEventIds?: string[]; causalEvents?: CausalEventPosition[]; error?: ErrorInfo }
export interface ErrorMessage extends MessageBase { kind: "error"; error: ErrorInfo }

export type WireMessage =
  | SessionOpen | SessionReady | SessionRejected | AuthChallenge | AuthUpdate | AuthUpdated
  | HeartbeatPing | HeartbeatPong | StreamSubscribe | StreamSubscribed | ReplayBegin
  | EventMessage | ReplayComplete | ResyncRequired | SnapshotMessage | StreamUnsubscribe
  | StreamUnsubscribed | CommandMessage | CommandReceipt | CommandCompleted
  | CommandStatusRequest | CommandStatus | ErrorMessage;

export type ClientToServerMessage = SessionOpen | AuthUpdate | HeartbeatPong | StreamSubscribe | StreamUnsubscribe | CommandMessage | CommandStatusRequest;
export type ServerToClientMessage = Exclude<WireMessage, ClientToServerMessage>;

export type WireKind = WireMessage["kind"];
