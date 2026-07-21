import { createHash } from "node:crypto";
import type { JsonValue } from "./types.ts";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export function manifestDigest(manifest: JsonValue): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}
