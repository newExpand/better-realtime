import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import wireSchema from "../../../spec/protocol/v1/wire.schema.json" with { type: "json" };
import type { ClientToServerMessage, ServerToClientMessage, WireKind, WireMessage } from "./types.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validateWire = ajv.compile<WireMessage>(wireSchema);
const clientToServerKinds = new Set<WireKind>(["session.open", "session.auth.update", "heartbeat.pong", "stream.subscribe", "stream.unsubscribe", "command", "command.status.request"]);

export interface ValidationFailure {
  ok: false;
  code: "RT_MESSAGE_INVALID" | "RT_MESSAGE_TOO_LARGE";
  errors: ErrorObject[];
}

export interface ValidationSuccess {
  ok: true;
  value: WireMessage;
  byteLength: number;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateWireValue(value: unknown): ValidationResult {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return { ok: false, code: "RT_MESSAGE_INVALID", errors: [] }; }
  if (serialized === undefined) return { ok: false, code: "RT_MESSAGE_INVALID", errors: [] };
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (!validateWire(value)) {
    return { ok: false, code: "RT_MESSAGE_INVALID", errors: [...(validateWire.errors ?? [])] };
  }
  return { ok: true, value, byteLength };
}

export function decodeWireMessage(raw: string | ArrayBuffer | Uint8Array, maxBytes = 1_048_576): ValidationResult {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
  if (bytes.byteLength > maxBytes) return { ok: false, code: "RT_MESSAGE_TOO_LARGE", errors: [] };
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, code: "RT_MESSAGE_INVALID", errors: [] };
  }
  return validateWireValue(value);
}

export function assertWireMessage(value: unknown): asserts value is WireMessage {
  const result = validateWireValue(value);
  if (!result.ok) {
    throw new Error(`${result.code}: ${ajv.errorsText(result.errors)}`);
  }
}

export function isClientToServerMessage(message: WireMessage): message is ClientToServerMessage { return clientToServerKinds.has(message.kind); }
export function isServerToClientMessage(message: WireMessage): message is ServerToClientMessage { return !clientToServerKinds.has(message.kind); }
