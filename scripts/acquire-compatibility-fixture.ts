import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface FixtureManifest {
  schemaVersion: "1.0";
  package: string;
  version: string;
  registryUrl: string;
  releaseAssetUrl: string;
  bytes: number;
  sha256: string;
  integrity: string;
  checksumPinned: true;
  preservationBaseline: true;
  githubReleaseImmutable: boolean;
  unpackedBytes?: number;
  files?: number;
}

const root = resolve(import.meta.dirname, "..");
const DEFAULT_FIXTURE_VERSION = "0.1.0-alpha.1";

export async function acquireCompatibilityFixture(
  verifyExternal = false,
  allowDownload = true,
  version = DEFAULT_FIXTURE_VERSION
): Promise<{ path: string; bytes: number; sha256: string; version: string; externalCopiesVerified: number }> {
  if (!/^0\.1\.0-alpha\.[14]$/u.test(version)) throw new Error("RT_COMPAT_FIXTURE_VERSION_UNSUPPORTED");
  const manifestPath = join(root, `compatibility/fixtures/better-realtime-${version}.json`);
  const fixturePath = join(root, `compatibility/fixtures/better-realtime-${version}.tgz`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
  assertManifest(manifest, version);
  await mkdir(dirname(fixturePath), { recursive: true });
  const existing = await readFile(fixturePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing) assertBytes(existing, manifest, "vendored");
  else if (allowDownload) {
    const registryBytes = await fetchBytes(manifest.registryUrl);
    assertBytes(registryBytes, manifest, "registry");
    const temporary = `${fixturePath}.tmp-${process.pid}`;
    await writeFile(temporary, registryBytes, { flag: "wx" });
    await rename(temporary, fixturePath);
  } else throw new Error("RT_COMPAT_FIXTURE_MISSING");
  let externalCopiesVerified = 0;
  if (verifyExternal) {
    for (const [label, url] of [["registry", manifest.registryUrl], ["release", manifest.releaseAssetUrl]] as const) {
      assertBytes(await fetchBytes(url), manifest, label);
      externalCopiesVerified += 1;
    }
  }
  const info = await stat(fixturePath);
  return { path: fixturePath, bytes: info.size, sha256: manifest.sha256, version, externalCopiesVerified };
}

function assertManifest(manifest: FixtureManifest, version: string): void {
  const expectedImmutable = version === "0.1.0-alpha.4";
  if (manifest.schemaVersion !== "1.0" || manifest.package !== "better-realtime" || manifest.version !== version || manifest.checksumPinned !== true || manifest.preservationBaseline !== true || manifest.githubReleaseImmutable !== expectedImmutable) throw new Error("RT_COMPAT_FIXTURE_MANIFEST_INVALID");
  if (!/^https:\/\//u.test(manifest.registryUrl) || !/^https:\/\//u.test(manifest.releaseAssetUrl) || !/^[a-f0-9]{64}$/u.test(manifest.sha256) || !/^sha512-/u.test(manifest.integrity)) throw new Error("RT_COMPAT_FIXTURE_MANIFEST_INVALID");
}

function assertBytes(bytes: Buffer, manifest: FixtureManifest, source: string): void {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (bytes.byteLength !== manifest.bytes || sha256 !== manifest.sha256 || integrity !== manifest.integrity) throw new Error(`RT_COMPAT_FIXTURE_DRIFT:${source}:${bytes.byteLength}:${sha256}:${integrity}`);
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`RT_COMPAT_FIXTURE_FETCH_FAILED:${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedVersion = process.argv.find((value) => /^0\.1\.0-alpha\.[14]$/u.test(value)) ?? DEFAULT_FIXTURE_VERSION;
  const fixturePath = join(root, `compatibility/fixtures/better-realtime-${requestedVersion}.tgz`);
  try {
    const result = await acquireCompatibilityFixture(process.argv.includes("--verify-external"), true, requestedVersion);
    process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", ...result })}\n`);
  } catch (error) {
    await rm(`${fixturePath}.tmp-${process.pid}`, { force: true }).catch(() => undefined);
    throw error;
  }
}
