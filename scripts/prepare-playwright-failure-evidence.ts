import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const demoCredential = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu;
const unredactedCredentialField = /"credential"\s*:\s*"(?!\[REDACTED_DEMO_CREDENTIAL\])[^"]+"/gu;
const unredactedSensitiveField = /"(?:authorization|cookie|set-cookie|npm_token|node_auth_token|github_token|gh_token|actions_runtime_token)"\s*:\s*"(?!\[REDACTED\])[^"]+"/giu;
const unredactedHeaderArray = /"name"\s*:\s*"(?:authorization|cookie|set-cookie|x-api-key|x-auth-token)"\s*,\s*"value"\s*:\s*"(?!\[REDACTED\])[^"]*"/giu;
const sensitiveMarker = /(?:NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|ACTIONS_RUNTIME_TOKEN|REALTIME_DEMO_AUTH_KEY|(?:^|[/\\])\.env(?:$|[/\\]))/u;
const sensitiveHeaderName = /^(?:authorization|cookie|set-cookie|x-api-key|x-auth-token)$/iu;
const sensitiveQueryKey = /(?:auth|authorization|credential|key|password|secret|signature|token)/iu;
const allowedEvidenceName = /^(?:test-failed-[^/\\]+\.png|video\.webm|trace\.zip|error-context\.md)$/u;
const allowedTraceEntry = /^(?:\d+-trace\.(?:trace|network|stacks)|test\.trace)$/u;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webmSignature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const limits = {
  failedCases: 12,
  screenshotsPerCase: 4,
  screenshotBytes: 15 * 1024 * 1024,
  videoBytes: 75 * 1024 * 1024,
  traceArchiveBytes: 100 * 1024 * 1024,
  traceEntries: 2_048,
  traceUnpackedBytes: 128 * 1024 * 1024,
  traceTextEntryBytes: 16 * 1024 * 1024,
  errorContextBytes: 2 * 1024 * 1024,
  totalOutputBytes: 512 * 1024 * 1024,
} as const;
type EvidenceLimits = { [Key in keyof typeof limits]: number };

interface PreparedEvidence {
  files: string[];
  outputRoot: string;
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`RT_PLAYWRIGHT_EVIDENCE_UNSUPPORTED_ENTRY:${path}`);
  }
  return files;
}

function assertBelow(root: string, path: string): void {
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || child.startsWith(sep)) {
    throw new Error(`RT_PLAYWRIGHT_EVIDENCE_PATH_ESCAPE:${path}`);
  }
}

function sanitizeText(value: string, workspaceRoot: string): string {
  return value
    .replaceAll(workspaceRoot, "$REPOSITORY")
    .replace(demoCredential, "[REDACTED_DEMO_CREDENTIAL]")
    .replace(
      /"((?:authorization|cookie|set-cookie|npm_token|node_auth_token|github_token|gh_token|actions_runtime_token))"\s*:\s*"[^"]*"/giu,
      '"$1":"[REDACTED]"',
    );
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQueryKey.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function isSensitiveJsonKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return /(?:authorization|cookie|credential|password|passphrase|secret|token|apikey|privatekey|clientcertificate)/u
    .test(normalized);
}

function sanitizeStructuredValue(value: unknown, workspaceRoot: string): unknown {
  if (typeof value === "string") {
    return sanitizeText(sanitizeUrl(value), workspaceRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredValue(item, workspaceRoot));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const header = typeof record.name === "string" && sensitiveHeaderName.test(record.name);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      (header && key.toLowerCase() === "value") ||
      isSensitiveJsonKey(key)
    ) {
      sanitized[key] = key.toLowerCase() === "credential"
        ? "[REDACTED_DEMO_CREDENTIAL]"
        : "[REDACTED]";
    } else if (key.toLowerCase() === "url" && typeof item === "string") {
      sanitized[key] = sanitizeText(sanitizeUrl(item), workspaceRoot);
    } else {
      sanitized[key] = sanitizeStructuredValue(item, workspaceRoot);
    }
  }
  return sanitized;
}

function sanitizeTraceText(value: string, workspaceRoot: string): string {
  const hadFinalNewline = value.endsWith("\n");
  const lines = value.split(/\r?\n/u);
  if (hadFinalNewline) lines.pop();
  const sanitized = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      return JSON.stringify(sanitizeStructuredValue(JSON.parse(line) as unknown, workspaceRoot));
    } catch (error) {
      throw new Error(
        `RT_PLAYWRIGHT_EVIDENCE_TRACE_JSON_INVALID:${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }).join("\n");
  return hadFinalNewline ? `${sanitized}\n` : sanitized;
}

function assertNoSensitiveUrl(value: string, path: string): void {
  for (const match of value.matchAll(/https?:\/\/[^"'\s\\]+/gu)) {
    try {
      const url = new URL(match[0]);
      if (
        (url.username && decodeURIComponent(url.username) !== "[REDACTED]") ||
        (url.password && decodeURIComponent(url.password) !== "[REDACTED]")
      ) {
        throw new Error(`RT_PLAYWRIGHT_EVIDENCE_URL_CREDENTIAL:${path}`);
      }
      for (const [key, item] of url.searchParams) {
        if (sensitiveQueryKey.test(key) && item !== "[REDACTED]") {
          throw new Error(`RT_PLAYWRIGHT_EVIDENCE_URL_QUERY:${path}:${key}`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("RT_PLAYWRIGHT_")) throw error;
    }
  }
}

function assertSanitized(bytes: Buffer, workspaceRoot: string, path: string): void {
  const value = bytes.toString("utf8");
  demoCredential.lastIndex = 0;
  if (demoCredential.test(value)) throw new Error(`RT_PLAYWRIGHT_EVIDENCE_CREDENTIAL:${path}`);
  demoCredential.lastIndex = 0;
  unredactedCredentialField.lastIndex = 0;
  if (unredactedCredentialField.test(value)) throw new Error(`RT_PLAYWRIGHT_EVIDENCE_CREDENTIAL_FIELD:${path}`);
  unredactedCredentialField.lastIndex = 0;
  unredactedSensitiveField.lastIndex = 0;
  if (unredactedSensitiveField.test(value)) {
    throw new Error(`RT_PLAYWRIGHT_EVIDENCE_SENSITIVE_FIELD:${path}`);
  }
  unredactedSensitiveField.lastIndex = 0;
  unredactedHeaderArray.lastIndex = 0;
  if (unredactedHeaderArray.test(value)) {
    throw new Error(`RT_PLAYWRIGHT_EVIDENCE_SENSITIVE_HEADER:${path}`);
  }
  unredactedHeaderArray.lastIndex = 0;
  assertNoSensitiveUrl(value, path);
  if (value.includes(workspaceRoot)) throw new Error(`RT_PLAYWRIGHT_EVIDENCE_WORKSPACE_PATH:${path}`);
  if (sensitiveMarker.test(value)) throw new Error(`RT_PLAYWRIGHT_EVIDENCE_SECRET_MARKER:${path}`);
}

async function assertBoundedFile(path: string, maximum: number, code: string): Promise<number> {
  const size = (await stat(path)).size;
  if (size < 1 || size > maximum) throw new Error(`${code}:${path}:${size}`);
  return size;
}

function assertMagic(bytes: Buffer, signature: Buffer, code: string, path: string): void {
  if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error(`${code}:${path}`);
  }
}

async function sanitizeTrace(
  source: string,
  destination: string,
  workspaceRoot: string,
  activeLimits: EvidenceLimits,
): Promise<void> {
  await assertBoundedFile(
    source,
    activeLimits.traceArchiveBytes,
    "RT_PLAYWRIGHT_EVIDENCE_TRACE_ARCHIVE_SIZE",
  );
  const staging = await mkdtemp(join(tmpdir(), "better-realtime-playwright-trace-"));
  try {
    const listing = (await exec("unzip", ["-Z1", source])).stdout.split(/\r?\n/u).filter(Boolean);
    if (listing.length === 0) throw new Error(`RT_PLAYWRIGHT_EVIDENCE_EMPTY_TRACE:${source}`);
    if (listing.length > activeLimits.traceEntries) {
      throw new Error(`RT_PLAYWRIGHT_EVIDENCE_TRACE_ENTRY_LIMIT:${listing.length}`);
    }
    for (const entry of listing) {
      const segments = entry.split(/[\\/]/u);
      if (
        entry.startsWith("/") ||
        entry.startsWith("\\") ||
        /^[A-Za-z]:/u.test(entry) ||
        segments.includes("..")
      ) {
        throw new Error(`RT_PLAYWRIGHT_EVIDENCE_TRACE_PATH_ESCAPE:${entry}`);
      }
    }
    const totals = (await exec("unzip", ["-Z", "-t", source])).stdout;
    const totalMatch = totals.match(/(\d+) files?, (\d+) bytes uncompressed/iu);
    if (!totalMatch) throw new Error(`RT_PLAYWRIGHT_EVIDENCE_TRACE_TOTALS_INVALID:${source}`);
    const reportedEntries = Number(totalMatch[1]);
    const unpackedBytes = Number(totalMatch[2]);
    if (reportedEntries !== listing.length || unpackedBytes > activeLimits.traceUnpackedBytes) {
      throw new Error(
        `RT_PLAYWRIGHT_EVIDENCE_TRACE_EXPANSION_LIMIT:entries=${reportedEntries}:bytes=${unpackedBytes}`,
      );
    }
    await exec("unzip", ["-qq", source, "-d", staging]);
    // Response bodies, source snapshots, and trace screenshots live below
    // resources/. They are not required for the causal event timeline and are
    // removed because arbitrary binary bodies cannot be safely redacted.
    await rm(join(staging, "resources"), { recursive: true, force: true });
    const entries = await filesBelow(staging);
    if (entries.length === 0) throw new Error(`RT_PLAYWRIGHT_EVIDENCE_EMPTY_TRACE:${source}`);
    for (const entry of entries) {
      assertBelow(staging, entry);
      const traceName = relative(staging, entry);
      if (traceName.includes(sep) || !allowedTraceEntry.test(traceName)) {
        throw new Error(`RT_PLAYWRIGHT_EVIDENCE_TRACE_ENTRY_NOT_ALLOWED:${traceName}`);
      }
      await assertBoundedFile(
        entry,
        activeLimits.traceTextEntryBytes,
        "RT_PLAYWRIGHT_EVIDENCE_TRACE_TEXT_SIZE",
      );
      const bytes = await readFile(entry);
      const sanitized = Buffer.from(sanitizeTraceText(bytes.toString("utf8"), workspaceRoot));
      assertSanitized(sanitized, workspaceRoot, entry);
      await writeFile(entry, sanitized);
    }
    await mkdir(dirname(destination), { recursive: true });
    await exec("zip", ["-q", "-r", destination, "."], { cwd: staging });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function preparePlaywrightFailureEvidence(
  inputRoot: string,
  outputRoot: string,
  workspaceRoot = process.cwd(),
  limitOverrides: Partial<EvidenceLimits> = {},
): Promise<PreparedEvidence> {
  const activeLimits: EvidenceLimits = { ...limits, ...limitOverrides };
  for (const [name, value] of Object.entries(activeLimits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`RT_PLAYWRIGHT_EVIDENCE_LIMIT_INVALID:${name}`);
    }
  }
  const sourceRoot = resolve(inputRoot);
  const destinationRoot = resolve(outputRoot);
  if (sourceRoot === destinationRoot || destinationRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("RT_PLAYWRIGHT_EVIDENCE_OUTPUT_INSIDE_INPUT");
  }
  if ((await stat(sourceRoot).catch(() => undefined))?.isDirectory() !== true) {
    throw new Error(`RT_PLAYWRIGHT_EVIDENCE_INPUT_MISSING:${sourceRoot}`);
  }

  const sourceFiles = await filesBelow(sourceRoot);
  const failedCases = [...new Set(sourceFiles
    .filter((path) => basename(path) === "error-context.md" || /^test-failed-[^/\\]+\.png$/u.test(basename(path)))
    .map(dirname))]
    .sort();
  if (failedCases.length === 0) throw new Error("RT_PLAYWRIGHT_FAILURE_EVIDENCE_MISSING");
  if (failedCases.length > activeLimits.failedCases) {
    throw new Error(`RT_PLAYWRIGHT_FAILURE_EVIDENCE_CASE_LIMIT:${failedCases.length}`);
  }
  const candidates: string[] = [];
  for (const failedCase of failedCases) {
    const caseFiles = sourceFiles.filter((path) => dirname(path) === failedCase);
    const screenshots = caseFiles.filter((path) => /^test-failed-[^/\\]+\.png$/u.test(basename(path)));
    const required = ["video.webm", "trace.zip", "error-context.md"]
      .map((name) => caseFiles.find((path) => basename(path) === name));
    if (screenshots.length === 0 || required.some((path) => !path)) {
      throw new Error(`RT_PLAYWRIGHT_FAILURE_EVIDENCE_INCOMPLETE:${relative(sourceRoot, failedCase)}`);
    }
    if (screenshots.length > activeLimits.screenshotsPerCase) {
      throw new Error(
        `RT_PLAYWRIGHT_FAILURE_EVIDENCE_SCREENSHOT_LIMIT:${relative(sourceRoot, failedCase)}`,
      );
    }
    candidates.push(...screenshots, ...(required as string[]));
  }
  candidates.sort();

  const destinationParent = dirname(destinationRoot);
  await mkdir(destinationParent, { recursive: true });
  await rm(destinationRoot, { recursive: true, force: true });
  const stagingRoot = await mkdtemp(join(destinationParent, `.${basename(destinationRoot)}-staging-`));
  const prepared: string[] = [];
  let published = false;
  try {
    for (const source of candidates) {
      if (!allowedEvidenceName.test(basename(source))) {
        throw new Error(`RT_PLAYWRIGHT_FAILURE_EVIDENCE_NOT_ALLOWED:${source}`);
      }
      assertBelow(sourceRoot, source);
      const destination = join(stagingRoot, relative(sourceRoot, source));
      assertBelow(stagingRoot, destination);
      await mkdir(dirname(destination), { recursive: true });
      if (basename(source) === "trace.zip") {
        await sanitizeTrace(source, destination, workspaceRoot, activeLimits);
      } else if (basename(source) === "error-context.md") {
        await assertBoundedFile(
          source,
          activeLimits.errorContextBytes,
          "RT_PLAYWRIGHT_EVIDENCE_ERROR_CONTEXT_SIZE",
        );
        const sanitized = Buffer.from(sanitizeText(await readFile(source, "utf8"), workspaceRoot));
        assertSanitized(sanitized, workspaceRoot, source);
        await writeFile(destination, sanitized);
      } else {
        const maximum = basename(source) === "video.webm"
          ? activeLimits.videoBytes
          : activeLimits.screenshotBytes;
        await assertBoundedFile(
          source,
          maximum,
          basename(source) === "video.webm"
            ? "RT_PLAYWRIGHT_EVIDENCE_VIDEO_SIZE"
            : "RT_PLAYWRIGHT_EVIDENCE_SCREENSHOT_SIZE",
        );
        const bytes = await readFile(source);
        assertMagic(
          bytes,
          basename(source) === "video.webm" ? webmSignature : pngSignature,
          basename(source) === "video.webm"
            ? "RT_PLAYWRIGHT_EVIDENCE_VIDEO_MAGIC"
            : "RT_PLAYWRIGHT_EVIDENCE_SCREENSHOT_MAGIC",
          source,
        );
        assertSanitized(bytes, workspaceRoot, source);
        await copyFile(source, destination);
      }
      prepared.push(relative(stagingRoot, destination));
    }
    const outputFiles = await filesBelow(stagingRoot);
    const totalOutputBytes = (await Promise.all(outputFiles.map(async (path) => (await stat(path)).size)))
      .reduce((total, size) => total + size, 0);
    if (totalOutputBytes > activeLimits.totalOutputBytes) {
      throw new Error(`RT_PLAYWRIGHT_FAILURE_EVIDENCE_TOTAL_SIZE:${totalOutputBytes}`);
    }
    await rename(stagingRoot, destinationRoot);
    published = true;
  } finally {
    if (!published) await rm(stagingRoot, { recursive: true, force: true });
  }
  return { files: prepared, outputRoot: destinationRoot };
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const report = await preparePlaywrightFailureEvidence(
    join(root, "output/playwright/test-results"),
    join(root, "output/playwright/ci-failure-evidence"),
    root,
  );
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...report })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
