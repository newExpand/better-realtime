import { builtinModules } from "node:module";

const builtins = new Set(builtinModules.flatMap((name) => [name.replace(/^node:/u, ""), `node:${name.replace(/^node:/u, "")}`]));

export interface PackageContentIssue {
  readonly code: "absolute_path" | "secret";
  readonly pattern: string;
}

const secretPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["credential_url", /\b(?:postgres(?:ql)?|https?):\/\/[^\s/:@]+:[^\s/@]+@/iu],
  ["assigned_secret", /\b(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_./+\-=]{20,}["']/iu],
  ["internal_ai_handoff", /<(?:codex_delegation|source_thread_id)>/iu]
];

const absolutePathPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["macos_user_path", /\/Users\/[A-Za-z0-9._-]+\/(?:[^\s"'`/]+\/)*[^\s"'`/]+/u],
  ["linux_user_path", /\/home\/[A-Za-z0-9._-]+\/(?:[^\s"'`/]+\/)*[^\s"'`/]+/u],
  ["macos_temporary_path", /\/var\/folders\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:[^\s"'`/]+\/)*[^\s"'`/]+/u],
  ["temporary_path", /\/(?:private\/)?tmp\/(?:[^\s"'`/]+\/)*[^\s"'`/]+/u],
  ["windows_user_path", /\b[A-Za-z]:\\Users\\[^\s"'`\\]+\\[^\s"'`]+/u]
];

export function packageContentIssues(text: string, forbiddenRoots: readonly string[] = []): PackageContentIssue[] {
  const issues: PackageContentIssue[] = [];
  for (const [pattern, expression] of secretPatterns) if (expression.test(text)) issues.push({ code: "secret", pattern });
  for (const [pattern, expression] of absolutePathPatterns) if (expression.test(text)) issues.push({ code: "absolute_path", pattern });
  for (const root of forbiddenRoots) if (root && text.includes(root)) issues.push({ code: "absolute_path", pattern: "workspace_root" });
  return issues;
}

export function importedSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) specifiers.add(match[1]);
  return [...specifiers].sort();
}

export function importedNodeBuiltins(source: string): readonly string[] {
  return importedSpecifiers(source).filter((specifier) => builtins.has(specifier) || builtins.has(specifier.split("/")[0]!));
}
