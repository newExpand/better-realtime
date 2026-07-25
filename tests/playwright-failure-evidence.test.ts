import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { preparePlaywrightFailureEvidence } from "../scripts/prepare-playwright-failure-evidence.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const credential = "eyJ2ZXJzaW9uIjoxLCJzdWJqZWN0IjoidGVzdCJ9.abcdefghijklmnopqrstuvwxyz0123456789";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  caseRoot: string;
  input: string;
  output: string;
  root: string;
  traceRoot: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "better-realtime-failure-evidence-test-"));
  roots.push(root);
  const input = join(root, "test-results");
  const output = join(root, "prepared");
  const workspace = join(root, "private-workspace");
  const caseRoot = join(input, "webkit", "failing-case");
  const traceRoot = join(root, "trace");
  await mkdir(caseRoot, { recursive: true });
  await mkdir(join(traceRoot, "resources"), { recursive: true });
  await writeFile(join(caseRoot, "test-failed-1.png"), png);
  await writeFile(join(caseRoot, "video.webm"), webm);
  await writeFile(join(caseRoot, "error-context.md"), `failure at ${workspace}\n`);
  await writeFile(join(caseRoot, "server.log"), `must not upload ${credential}\n`);
  await writeFile(join(traceRoot, "0-trace.trace"), `{"path":"${workspace}","credential":"${credential}"}\n`);
  await writeFile(
    join(traceRoot, "0-trace.network"),
    `${JSON.stringify({
      request: {
        url: `https://${["user", "password"].join(":")}@example.test/api?${[
          "token=query-secret",
          "safe=value",
        ].join("&")}`,
        headers: [
          { name: "Authorization", value: "Bearer header-secret" },
          { name: "Accept", value: "application/json" },
        ],
        payload: {
          password: "password-value",
          accessToken: "access-token-value",
          refresh_token: "refresh-token-value",
          "api-key": "api-key-value",
          privateKey: "private-key-value",
          sessionCookie: "cookie-value",
        },
      },
    })}\n`,
  );
  await writeFile(join(traceRoot, "test.trace"), '{"type":"before","safe":"value"}\n');
  await writeFile(join(traceRoot, "resources", "credential.json"), `{"credential":"${credential}"}\n`);
  await exec("zip", ["-q", "-r", join(caseRoot, "trace.zip"), "."], { cwd: traceRoot });
  const successRoot = join(input, "chromium", "successful-case");
  await mkdir(successRoot, { recursive: true });
  await writeFile(join(successRoot, "video.webm"), "successful video must not upload");
  await writeFile(join(successRoot, "trace.zip"), "successful trace must not upload");
  return { caseRoot, input, output, root, traceRoot, workspace };
}

async function updateTraceArchive(value: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await exec("zip", ["-q", "-y", "-r", join(value.caseRoot, "trace.zip"), "."], { cwd: value.traceRoot });
}

async function replaceZipEntryName(zipPath: string, from: string, to: string): Promise<void> {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error("test zip names must have equal lengths");
  const bytes = await readFile(zipPath);
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  let offset = 0;
  let replacements = 0;
  while ((offset = bytes.indexOf(source, offset)) >= 0) {
    replacement.copy(bytes, offset);
    offset += replacement.length;
    replacements += 1;
  }
  if (replacements < 2) throw new Error(`zip entry not found in both headers: ${from}`);
  await writeFile(zipPath, bytes);
}

describe("Playwright failure evidence preparation", () => {
  it("selects the narrow allowlist and redacts credentials and workspace paths inside trace archives", async () => {
    const value = await fixture();
    const report = await preparePlaywrightFailureEvidence(value.input, value.output, value.workspace);
    expect(report.files).toEqual([
      "webkit/failing-case/error-context.md",
      "webkit/failing-case/test-failed-1.png",
      "webkit/failing-case/trace.zip",
      "webkit/failing-case/video.webm",
    ]);
    expect(await readFile(join(value.output, "webkit/failing-case/error-context.md"), "utf8"))
      .toBe("failure at $REPOSITORY\n");

    const extracted = join(value.root, "extracted");
    await mkdir(extracted);
    await exec("unzip", ["-qq", join(value.output, "webkit/failing-case/trace.zip"), "-d", extracted]);
    const trace = await readFile(join(extracted, "0-trace.trace"), "utf8");
    const network = await readFile(join(extracted, "0-trace.network"), "utf8");
    expect(trace).toContain("$REPOSITORY");
    expect(trace).toContain("[REDACTED_DEMO_CREDENTIAL]");
    expect(network).toContain("[REDACTED]");
    expect(`${trace}\n${network}`).not.toContain(value.workspace);
    expect(`${trace}\n${network}`).not.toContain(credential);
    expect(network).not.toContain("header-secret");
    expect(network).not.toContain("query-secret");
    expect(network).not.toContain("password-value");
    expect(network).not.toContain("access-token-value");
    expect(network).not.toContain("refresh-token-value");
    expect(network).not.toContain("api-key-value");
    expect(network).not.toContain("private-key-value");
    expect(network).not.toContain("cookie-value");
    await expect(stat(join(extracted, "resources"))).rejects.toThrow();
  });

  it("fails closed when a failed run produced none of the required evidence files", async () => {
    const root = await mkdtemp(join(tmpdir(), "better-realtime-failure-evidence-empty-"));
    roots.push(root);
    const input = join(root, "test-results");
    await mkdir(input);
    await writeFile(join(input, "server.log"), "no browser artifacts");
    await expect(preparePlaywrightFailureEvidence(input, join(root, "prepared"), root))
      .rejects.toThrow("RT_PLAYWRIGHT_FAILURE_EVIDENCE_MISSING");
  });

  it("fails closed when any required failure evidence is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "better-realtime-failure-evidence-incomplete-"));
    roots.push(root);
    const input = join(root, "test-results", "webkit", "incomplete");
    await mkdir(input, { recursive: true });
    await writeFile(join(input, "test-failed-1.png"), "screenshot only");
    await expect(preparePlaywrightFailureEvidence(
      join(root, "test-results"),
      join(root, "prepared"),
      root,
    )).rejects.toThrow("RT_PLAYWRIGHT_FAILURE_EVIDENCE_INCOMPLETE:webkit/incomplete");
  });

  it("removes stale output and fails closed before publishing partial evidence", async () => {
    const value = await fixture();
    await mkdir(value.output, { recursive: true });
    await writeFile(join(value.output, "stale-secret.txt"), credential);
    await writeFile(join(value.input, "webkit", "failing-case", "video.webm"), "not webm");
    await expect(preparePlaywrightFailureEvidence(value.input, value.output, value.workspace))
      .rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_VIDEO_MAGIC");
    await expect(stat(value.output)).rejects.toThrow();
  });

  it("rejects sensitive values embedded in otherwise allowed media files", async () => {
    const value = await fixture();
    await writeFile(
      join(value.input, "webkit", "failing-case", "video.webm"),
      Buffer.concat([webm, Buffer.from(credential)]),
    );
    await expect(preparePlaywrightFailureEvidence(value.input, value.output, value.workspace))
      .rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_CREDENTIAL:");
    await expect(stat(value.output)).rejects.toThrow();
  });

  it("rejects a malformed nonblank Playwright JSONL entry", async () => {
    const value = await fixture();
    await writeFile(join(value.traceRoot, "test.trace"), '{"type":\n');
    await updateTraceArchive(value);
    await expect(preparePlaywrightFailureEvidence(value.input, value.output, value.workspace))
      .rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_TRACE_JSON_INVALID");
  });

  for (const maliciousName of ["../bad.txt", "/evil.txtx", "..\\bad.txt"]) {
    it(`rejects a trace archive path escape (${maliciousName})`, async () => {
      const value = await fixture();
      await replaceZipEntryName(join(value.caseRoot, "trace.zip"), "test.trace", maliciousName);
      await expect(preparePlaywrightFailureEvidence(value.input, value.output, value.workspace))
        .rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_TRACE_PATH_ESCAPE");
    });
  }

  it("rejects a symlink restored from a trace archive", async () => {
    const value = await fixture();
    await rm(join(value.traceRoot, "test.trace"));
    await symlink("0-trace.network", join(value.traceRoot, "test.trace"));
    await updateTraceArchive(value);
    await expect(preparePlaywrightFailureEvidence(value.input, value.output, value.workspace))
      .rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_UNSUPPORTED_ENTRY");
  });

  it("enforces archive packed, entry, and expansion limits before publication", async () => {
    const value = await fixture();
    await expect(preparePlaywrightFailureEvidence(
      value.input,
      value.output,
      value.workspace,
      { traceArchiveBytes: 1 },
    )).rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_TRACE_ARCHIVE_SIZE");
    await expect(preparePlaywrightFailureEvidence(
      value.input,
      value.output,
      value.workspace,
      { traceEntries: 1 },
    )).rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_TRACE_ENTRY_LIMIT");
    await expect(preparePlaywrightFailureEvidence(
      value.input,
      value.output,
      value.workspace,
      { traceUnpackedBytes: 1 },
    )).rejects.toThrow("RT_PLAYWRIGHT_EVIDENCE_TRACE_EXPANSION_LIMIT");
  });

  it("enforces failed-case, screenshot, and total-output limits", async () => {
    const value = await fixture();
    const secondCase = join(value.input, "chromium", "second-failure");
    await cp(value.caseRoot, secondCase, { recursive: true });
    await expect(preparePlaywrightFailureEvidence(
      value.input,
      value.output,
      value.workspace,
      { failedCases: 1 },
    )).rejects.toThrow("RT_PLAYWRIGHT_FAILURE_EVIDENCE_CASE_LIMIT");
    await rm(secondCase, { recursive: true, force: true });
    await writeFile(join(value.caseRoot, "test-failed-2.png"), png);
    await expect(preparePlaywrightFailureEvidence(
      value.input,
      value.output,
      value.workspace,
      { screenshotsPerCase: 1 },
    )).rejects.toThrow("RT_PLAYWRIGHT_FAILURE_EVIDENCE_SCREENSHOT_LIMIT");
    await rm(join(value.caseRoot, "test-failed-2.png"));
    await expect(preparePlaywrightFailureEvidence(
      value.input,
      value.output,
      value.workspace,
      { totalOutputBytes: 1 },
    )).rejects.toThrow("RT_PLAYWRIGHT_FAILURE_EVIDENCE_TOTAL_SIZE");
  });
});
