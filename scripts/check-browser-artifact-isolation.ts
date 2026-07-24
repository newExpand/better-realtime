import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const forbiddenExternalImports = [
  /^node:/u,
  /^pg(?:\/|$)/u,
  /^ws(?:\/|$)/u,
  /^@modelcontextprotocol\/sdk(?:\/|$)/u
];

const forbiddenContent = [
  "@modelcontextprotocol/sdk",
  "pg_advisory_xact_lock",
  "local_evidence_bundle",
  "evidence_closure",
  "resource.inventory_captured"
];

export interface BrowserArtifactIsolationResult {
  readonly entry: string;
  readonly reachableFiles: readonly string[];
  readonly reachableBytes: number;
}

/**
 * Follows the browser root's emitted import graph and rejects Node/server
 * dependencies plus diagnostic query/doctor/PostgreSQL proof implementation.
 */
export async function assertBrowserArtifactIsolation(
  distDirectory: string,
  entryName = "index.js"
): Promise<BrowserArtifactIsolationResult> {
  const dist = resolve(distDirectory);
  const entry = resolve(dist, entryName);
  assertInside(dist, entry);
  const pending = [entry];
  const visited = new Set<string>();
  let reachableBytes = 0;

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      throw new Error(`RT_BROWSER_ARTIFACT_GRAPH_UNREADABLE:${relative(dist, file)}`, { cause: error });
    }
    reachableBytes += Buffer.byteLength(source);

    for (const marker of forbiddenContent) {
      if (source.includes(marker)) {
        throw new Error(`RT_BROWSER_ARTIFACT_FORBIDDEN_CONTENT:${relative(dist, file)}:${marker}`);
      }
    }

    for (const specifier of moduleSpecifiers(source)) {
      if (forbiddenExternalImports.some((pattern) => pattern.test(specifier))) {
        throw new Error(`RT_BROWSER_ARTIFACT_FORBIDDEN_IMPORT:${relative(dist, file)}:${specifier}`);
      }
      if (!specifier.startsWith(".")) continue;
      const imported = resolve(dirname(file), specifier);
      assertInside(dist, imported);
      pending.push(imported);
    }
  }

  return Object.freeze({
    entry: relative(dist, entry),
    reachableFiles: Object.freeze([...visited].map((file) => relative(dist, file)).sort()),
    reachableBytes
  });
}

function moduleSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const expression = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])([^"'\\]+)\1/gmu;
  for (const match of source.matchAll(expression)) {
    if (match[2]) specifiers.push(match[2]);
  }
  return specifiers;
}

function assertInside(root: string, target: string): void {
  const path = relative(root, target);
  if (path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep)) {
    throw new Error(`RT_BROWSER_ARTIFACT_GRAPH_ESCAPE:${path}`);
  }
}
