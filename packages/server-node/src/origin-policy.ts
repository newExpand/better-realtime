export interface WebSocketOriginPolicy {
  /** Exact, canonical HTTP(S) origins: scheme://host[:port]. */
  allowedOrigins: readonly string[];
  /** Explicit opt-in for non-browser clients such as Node `ws`, which send no Origin by default. */
  allowMissingOrigin?: boolean;
}

export interface CompiledWebSocketOriginPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowMissingOrigin: boolean;
}

export type WebSocketOriginDecision =
  | { allowed: true; kind: "browser" | "non_browser" }
  | { allowed: false; reasonCode: "RT_ORIGIN_MISSING" | "RT_ORIGIN_MALFORMED" | "RT_ORIGIN_NOT_ALLOWED" };

export function compileWebSocketOriginPolicy(policy: WebSocketOriginPolicy): CompiledWebSocketOriginPolicy {
  if (!policy || !Array.isArray(policy.allowedOrigins)) throw new Error("RT_ORIGIN_POLICY_INVALID");
  const origins = new Set<string>();
  for (const candidate of policy.allowedOrigins) {
    if (!isCanonicalBrowserOrigin(candidate) || origins.has(candidate)) throw new Error("RT_ORIGIN_POLICY_INVALID");
    origins.add(candidate);
  }
  return Object.freeze({ allowedOrigins: origins, allowMissingOrigin: policy.allowMissingOrigin === true });
}

export function verifyWebSocketOrigin(header: string | readonly string[] | undefined, policy: CompiledWebSocketOriginPolicy): WebSocketOriginDecision {
  if (header === undefined) return policy.allowMissingOrigin
    ? { allowed: true, kind: "non_browser" }
    : { allowed: false, reasonCode: "RT_ORIGIN_MISSING" };
  if (typeof header !== "string" || !isCanonicalBrowserOrigin(header)) return { allowed: false, reasonCode: "RT_ORIGIN_MALFORMED" };
  return policy.allowedOrigins.has(header)
    ? { allowed: true, kind: "browser" }
    : { allowed: false, reasonCode: "RT_ORIGIN_NOT_ALLOWED" };
}

function isCanonicalBrowserOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || value === "null" || value.includes("*")) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.origin === value;
  } catch {
    return false;
  }
}
