import { createHmac, timingSafeEqual } from "node:crypto";
import type { JsonValue } from "@realtime/protocol";

export interface AuthenticatedPrincipal {
  tenantId: string;
  authenticationRealm: string;
  issuer: string;
  subject: string;
  permissions: string[];
}

export function signDemoCredential(principal: AuthenticatedPrincipal, key: string, options: { nowMs?: number; ttlMs?: number } = {}): string {
  const issuedAtMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? 300_000;
  if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("RT_AUTH_CONFIG_INVALID");
  const payload = Buffer.from(JSON.stringify({ version: 1, issuedAtMs, expiresAtMs: issuedAtMs + ttlMs, ...principal })).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

export function verifyDemoCredential(auth: JsonValue, key: string, nowMs = Date.now()): AuthenticatedPrincipal {
  if (typeof auth !== "object" || auth === null || Array.isArray(auth) || auth.type !== "demo" || typeof auth.credential !== "string") throw new Error("RT_AUTH_REQUIRED");
  const [payload, signature, extra] = auth.credential.split(".");
  if (!payload || !signature || extra) throw new Error("RT_AUTH_REQUIRED");
  const expected = createHmac("sha256", key).update(payload).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, "base64url"); } catch { throw new Error("RT_AUTH_REQUIRED"); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("RT_AUTH_REQUIRED");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("RT_AUTH_REQUIRED"); }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("RT_AUTH_REQUIRED");
  const value = decoded as Record<string, unknown>;
  if (value.version !== 1 || !Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs) || (value.issuedAtMs as number) > nowMs + 30_000 || (value.expiresAtMs as number) <= nowMs || (value.expiresAtMs as number) <= (value.issuedAtMs as number) || typeof value.tenantId !== "string" || typeof value.authenticationRealm !== "string" || typeof value.issuer !== "string" || typeof value.subject !== "string" || !Array.isArray(value.permissions) || !value.permissions.every((permission) => typeof permission === "string")) throw new Error("RT_AUTH_REQUIRED");
  return { tenantId: value.tenantId, authenticationRealm: value.authenticationRealm, issuer: value.issuer, subject: value.subject, permissions: value.permissions as string[] };
}
