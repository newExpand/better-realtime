import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  LocalDiagnosticQuery,
  type LocalEvidenceBundleV1
} from "@realtime/diagnostics";
import type { DiagnosticQueryRequest, DiagnosticQueryResult, DoctorQueryDefinition, EvidenceBundleV1 } from "./diagnostic-types.js";
import { BETTER_REALTIME_COMPONENT_ID, BETTER_REALTIME_PRODUCT, BETTER_REALTIME_VERSION } from "./release.js";

export type { DiagnosticQueryRequest, DiagnosticQueryResult, DoctorQueryDefinition, EvidenceBundleV1 } from "./diagnostic-types.js";

export const DIAGNOSTIC_TOOL_PROTOCOL_VERSION = "0.1" as const;
const MAX_LOCAL_EVIDENCE_BYTES = 64 * 1024 * 1024;

export interface LocalDiagnosticSource {
  readonly sourceKind: "local_file";
  query(request: DiagnosticQueryRequest): DiagnosticQueryResult;
  runStoredDoctor(tenantId: string): DiagnosticQueryResult;
}

export async function openLocalDiagnosticSource(sourcePath: string, expectedTenantId?: string): Promise<LocalDiagnosticSource> {
  if (!sourcePath || /^(?:https?|ftp|data):/iu.test(sourcePath)) throw new Error("RT_DIAGNOSTIC_SOURCE_LOCAL_ONLY");
  const absolutePath = isAbsolute(sourcePath) ? sourcePath : resolve(process.cwd(), sourcePath);
  const value: unknown = JSON.parse(await readBoundedFile(absolutePath));
  const bundle = value as EvidenceBundleV1;
  if (expectedTenantId && bundle.tenantId !== expectedTenantId) throw new Error("RT_DIAGNOSTIC_TENANT_MISMATCH");
  const query = new LocalDiagnosticQuery(bundle as LocalEvidenceBundleV1);
  const configured = bundle.defaultDoctorQuery ? structuredClone(bundle.defaultDoctorQuery) : undefined;
  return Object.freeze({
    sourceKind: "local_file" as const,
    query: (request: DiagnosticQueryRequest) => withProductIdentity(query.query(request as never) as unknown as DiagnosticQueryResult),
    runStoredDoctor: (tenantId: string): DiagnosticQueryResult => {
      if (!configured) throw new Error("RT_DIAGNOSTIC_CONCLUSION_UNSUPPORTED:default doctor contract is absent");
      return withProductIdentity(query.query({ kind: "doctor", tenantId, ...structuredClone(configured) } as never) as unknown as DiagnosticQueryResult);
    }
  });
}

function withProductIdentity(result: DiagnosticQueryResult): DiagnosticQueryResult {
  return { ...result, product: BETTER_REALTIME_PRODUCT, productVersion: BETTER_REALTIME_VERSION, component: BETTER_REALTIME_COMPONENT_ID } as DiagnosticQueryResult;
}

export function runStoredDoctor(source: LocalDiagnosticSource, tenantId: string): DiagnosticQueryResult {
  return source.runStoredDoctor(tenantId);
}

export function executeDiagnosticQuery(source: LocalDiagnosticSource, request: DiagnosticQueryRequest): DiagnosticQueryResult {
  return source.query(request);
}

export function diagnosticPublicError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const realtimeCode = /^(RT_[A-Z0-9_]+)/u.exec(message)?.[1];
  if (realtimeCode) return { code: realtimeCode, message: realtimeCode };
  if (error instanceof SyntaxError) return { code: "RT_DIAGNOSTIC_BUNDLE_INVALID", message: "RT_DIAGNOSTIC_BUNDLE_INVALID" };
  if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR", "ELOOP"].includes(String(error.code))) return { code: "RT_DIAGNOSTIC_SOURCE_UNAVAILABLE", message: "RT_DIAGNOSTIC_SOURCE_UNAVAILABLE" };
  return { code: "RT_DIAGNOSTIC_INTERNAL_ERROR", message: "RT_DIAGNOSTIC_INTERNAL_ERROR" };
}

export function diagnosticPublicErrorEnvelope(error: unknown): {
  product: typeof BETTER_REALTIME_PRODUCT;
  productVersion: typeof BETTER_REALTIME_VERSION;
  component: typeof BETTER_REALTIME_COMPONENT_ID;
  schemaVersion: "1.0";
  kind: "diagnostic_error";
  code: string;
  message: string;
} {
  return { product: BETTER_REALTIME_PRODUCT, productVersion: BETTER_REALTIME_VERSION, component: BETTER_REALTIME_COMPONENT_ID, schemaVersion: "1.0", kind: "diagnostic_error", ...diagnosticPublicError(error) };
}

async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_LOCAL_EVIDENCE_BYTES) throw new Error("RT_DIAGNOSTIC_SOURCE_BOUNDS_EXCEEDED");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total <= MAX_LOCAL_EVIDENCE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_LOCAL_EVIDENCE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await handle.stat();
    if (total > MAX_LOCAL_EVIDENCE_BYTES || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.size !== total || before.mtimeMs !== after.mtimeMs) throw new Error("RT_DIAGNOSTIC_SOURCE_BOUNDS_EXCEEDED");
    return Buffer.concat(chunks, total).toString("utf8");
  } finally { await handle.close(); }
}
