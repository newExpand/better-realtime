import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { adoptPublicReleaseBundleIdentity } from "./adopt-public-release-bundle-identity.ts";
import {
  assertReleaseBundleIdentity,
  planReleaseBundleTransition,
  releaseBundleIdentityDigest,
  releasePackageNames,
  type ApprovedBundleAsset,
  type ApprovedReleaseBundle,
  type NpmPackageObservation,
  type ObservedBundleAsset,
  type ObservedBundleRelease,
  type ObservedReleaseBundleState,
  type PackagePublishIntent,
  type ReleasePackageName,
} from "./release-bundle-state-machine.ts";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const apiVersion = "2026-03-10";
const runId = process.env.GITHUB_RUN_ID ?? "local";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, url: string) {
    super(`RT_RELEASE_BUNDLE_PROVIDER_HTTP_${status}:${url}:${body.slice(0, 300)}`);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!token) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_GITHUB_TOKEN_REQUIRED");
  const headers = new Headers(init.headers);
  headers.set("Accept", headers.get("Accept") ?? "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", apiVersion);
  headers.set("User-Agent", "better-realtime-release-bundle");
  const response = await fetch(path.startsWith("https://") ? path : `https://api.github.com/${path}`, { ...init, headers });
  if (!response.ok) throw new HttpError(response.status, await response.text(), response.url);
  if (headers.get("Accept") === "application/octet-stream") return new Uint8Array(await response.arrayBuffer()) as T;
  return await response.json() as T;
}

async function optional<T>(path: string): Promise<T | undefined> {
  try {
    return await request<T>(path);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

async function listAll<T>(path: string): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await request<T[]>(`${path}${separator}per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PAGINATION_LIMIT");
}

const jsonBody = (value: unknown): Pick<RequestInit, "body" | "headers"> => ({
  body: JSON.stringify(value),
  headers: { "Content-Type": "application/json" },
});

interface GitHubAsset { id: number; name: string; digest: string | null; size: number; state: string }
interface GitHubRelease { id: number; tag_name: string; target_commitish: string; name: string | null; body: string | null; draft: boolean; prerelease: boolean; immutable: boolean; upload_url: string }
interface GitTagRef { object: { type: string; sha: string } }
interface GitTagObject { tag: string; message: string; object: { type: string; sha: string } }
interface CheckRun { id: number; name: string; head_sha: string; external_id: string | null; status: string; conclusion: string | null }
interface CheckRunsResponse { check_runs: CheckRun[] }
interface ActionsRun { id: number; run_attempt: number; event: string; path: string; head_sha: string }

async function loadIdentity(): Promise<ApprovedReleaseBundle> {
  const path = process.env.RELEASE_BUNDLE_IDENTITY_FILE;
  if (!path) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_IDENTITY_FILE_REQUIRED");
  const identity = JSON.parse(await readFile(resolve(path), "utf8")) as ApprovedReleaseBundle;
  assertReleaseBundleIdentity(identity);
  return identity;
}

async function observeTag(identity: ApprovedReleaseBundle): Promise<ObservedReleaseBundleState["tag"]> {
  const ref = await optional<GitTagRef>(`repos/${identity.repository}/git/ref/tags/${encodeURIComponent(identity.tag)}`);
  if (!ref) return { state: "absent" };
  if (ref.object.type !== "tag") return { state: "mismatch", reason: "lightweight tag" };
  const object = await request<GitTagObject>(`repos/${identity.repository}/git/tags/${ref.object.sha}`);
  if (object.tag !== identity.tag || object.message !== identity.tagMessage || object.object.type !== "commit" || object.object.sha !== identity.sourceSha) {
    return { state: "mismatch", reason: "annotated tag identity" };
  }
  return { state: "exact", objectSha: ref.object.sha, targetSha: object.object.sha };
}

async function releaseAssets(identity: ApprovedReleaseBundle, releaseId: number): Promise<ObservedBundleAsset[]> {
  return (await listAll<GitHubAsset>(`repos/${identity.repository}/releases/${releaseId}/assets`)).map((asset) => ({
    id: asset.id,
    name: asset.name,
    sha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : "",
    size: asset.size,
    state: asset.state === "uploaded" ? "uploaded" : "starter",
  }));
}

async function observeReleases(identity: ApprovedReleaseBundle, fixedReleaseId?: number): Promise<ObservedBundleRelease[]> {
  const releases = await listAll<GitHubRelease>(`repos/${identity.repository}/releases`);
  const matches = releases.filter(({ tag_name }) => tag_name === identity.tag);
  if (fixedReleaseId !== undefined && !matches.some(({ id }) => id === fixedReleaseId)) {
    matches.push(await request<GitHubRelease>(`repos/${identity.repository}/releases/${fixedReleaseId}`));
  }
  return await Promise.all(matches.map(async (candidate) => {
    const release = await request<GitHubRelease>(`repos/${identity.repository}/releases/${candidate.id}`);
    if (release.id !== candidate.id) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_RELEASE_ID_CHANGED");
    return {
      id: release.id,
      tag: release.tag_name,
      target: release.target_commitish,
      title: release.name ?? "",
      bodySha256: sha256(release.body ?? ""),
      draft: release.draft,
      prerelease: release.prerelease,
      immutable: release.immutable,
      assets: await releaseAssets(identity, release.id),
    };
  }));
}

async function listChecks(identity: ApprovedReleaseBundle): Promise<CheckRun[]> {
  const checks: CheckRun[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await request<CheckRunsResponse>(`repos/${identity.repository}/commits/${identity.sourceSha}/check-runs?filter=all&per_page=100&page=${page}`);
    checks.push(...response.check_runs);
    if (response.check_runs.length < 100) return checks;
  }
  throw new Error("RT_RELEASE_BUNDLE_PROVIDER_CHECK_PAGINATION_LIMIT");
}

async function observeIntent(
  identity: ApprovedReleaseBundle,
  packageName: ReleasePackageName,
  releaseId: number | undefined,
): Promise<PackagePublishIntent> {
  const prefix = `publish-intent/${identity.version}/${packageName}/`;
  const checks = (await listChecks(identity)).filter(({ name }) => name.startsWith(prefix));
  if (checks.length === 0) return { state: "absent" };
  if (checks.length !== 1 || !releaseId) throw new Error(`RT_RELEASE_BUNDLE_PROVIDER_AMBIGUOUS_INTENT:${packageName}`);
  const check = checks[0]!;
  const suffix = check.name.slice(prefix.length);
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(suffix);
  const identityDigest = releaseBundleIdentityDigest(identity, releaseId);
  if (
    !match
    || check.head_sha !== identity.sourceSha
    || check.external_id !== identityDigest
    || check.status !== "completed"
    || check.conclusion !== "neutral"
  ) throw new Error(`RT_RELEASE_BUNDLE_PROVIDER_INTENT_MISMATCH:${packageName}`);
  return { state: "present", runId: match[1]!, runAttempt: match[2]!, releaseId, identityDigest };
}

async function observeNpm(
  identity: ApprovedReleaseBundle,
  packageName: ReleasePackageName,
  intent: PackagePublishIntent,
): Promise<NpmPackageObservation> {
  let response: Response;
  try {
    response = await fetch(`https://registry.npmjs.org/${packageName}/${encodeURIComponent(identity.version)}`, { headers: { Accept: "application/json" } });
  } catch (error) {
    return { state: "indeterminate", reason: String(error) };
  }
  if (response.status === 404) return intent.state === "present" ? { state: "transient_e404" } : { state: "absent" };
  if (!response.ok) return { state: "indeterminate", reason: `HTTP ${response.status}` };
  const metadata = await response.json() as { dist?: { tarball?: string } };
  if (!metadata.dist?.tarball) return { state: "indeterminate", reason: "registry tarball URL absent" };
  try {
    const tarball = await fetch(metadata.dist.tarball);
    if (!tarball.ok) return { state: "indeterminate", reason: `tarball HTTP ${tarball.status}` };
    const bytes = new Uint8Array(await tarball.arrayBuffer());
    return { state: "exact", sha256: sha256(bytes), size: bytes.byteLength };
  } catch (error) {
    return { state: "indeterminate", reason: String(error) };
  }
}

async function observe(identity: ApprovedReleaseBundle, fixedReleaseId?: number): Promise<ObservedReleaseBundleState> {
  const [tag, releases] = await Promise.all([observeTag(identity), observeReleases(identity, fixedReleaseId)]);
  const releaseId = releases.length === 1 ? releases[0]!.id : undefined;
  const intents = {
    "better-realtime": await observeIntent(identity, "better-realtime", releaseId),
    "better-realtime-mcp": await observeIntent(identity, "better-realtime-mcp", releaseId),
  };
  const npm = {
    "better-realtime": await observeNpm(identity, "better-realtime", intents["better-realtime"]),
    "better-realtime-mcp": await observeNpm(identity, "better-realtime-mcp", intents["better-realtime-mcp"]),
  };
  const verified = new Set((process.env.RELEASE_VERIFIED_PACKAGES ?? "").split(",").filter(Boolean));
  return {
    tag,
    releases,
    npm,
    publishIntents: intents,
    verification: {
      "better-realtime": verified.has("better-realtime") ? "complete" : "incomplete",
      "better-realtime-mcp": verified.has("better-realtime-mcp") ? "complete" : "incomplete",
    },
  };
}

async function createTag(identity: ApprovedReleaseBundle): Promise<void> {
  const object = await request<{ sha: string }>(`repos/${identity.repository}/git/tags`, {
    method: "POST",
    ...jsonBody({ tag: identity.tag, message: identity.tagMessage, object: identity.sourceSha, type: "commit" }),
  });
  await request(`repos/${identity.repository}/git/refs`, { method: "POST", ...jsonBody({ ref: `refs/tags/${identity.tag}`, sha: object.sha }) });
}

async function createRelease(identity: ApprovedReleaseBundle): Promise<number> {
  const notes = await readFile(resolve(process.env.RELEASE_NOTES_FILE ?? "CHANGELOG.md"), "utf8");
  if (sha256(notes) !== identity.bodySha256) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_NOTES_MISMATCH");
  const release = await request<GitHubRelease>(`repos/${identity.repository}/releases`, {
    method: "POST",
    ...jsonBody({ tag_name: identity.tag, target_commitish: identity.sourceSha, name: identity.title, body: notes, draft: true, prerelease: true, make_latest: "false" }),
  });
  return release.id;
}

function assetPath(name: string): string {
  const root = process.env.RELEASE_ASSET_DIR;
  if (!root) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_ASSET_DIR_REQUIRED");
  return resolve(root, name);
}

async function uploadAsset(identity: ApprovedReleaseBundle, releaseId: number, expected: ApprovedBundleAsset): Promise<void> {
  const release = await request<GitHubRelease>(`repos/${identity.repository}/releases/${releaseId}`);
  if (!release.draft || release.immutable) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_UPLOAD_REQUIRES_DRAFT");
  const bytes = new Uint8Array(await readFile(assetPath(expected.name)));
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_LOCAL_ASSET_MISMATCH");
  const uploaded = await request<GitHubAsset>(`${release.upload_url.replace(/\{.*$/u, "")}?name=${encodeURIComponent(expected.name)}`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (uploaded.name !== expected.name || uploaded.size !== expected.size || uploaded.digest !== `sha256:${expected.sha256}` || uploaded.state !== "uploaded") {
    throw new Error("RT_RELEASE_BUNDLE_PROVIDER_UPLOADED_ASSET_MISMATCH");
  }
}

function findAsset(identity: ApprovedReleaseBundle, name: string): ApprovedBundleAsset {
  const assets = [...identity.packages.flatMap(({ artifact, checksum }) => [artifact, checksum]), ...(identity.publicIdentity ? [identity.publicIdentity] : [])];
  const found = assets.find((asset) => asset.name === name);
  if (!found) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_ASSET_NOT_APPROVED");
  return found;
}

async function download(identity: ApprovedReleaseBundle, asset: ObservedBundleAsset): Promise<Uint8Array> {
  return await request<Uint8Array>(`repos/${identity.repository}/releases/assets/${asset.id}`, { headers: { Accept: "application/octet-stream" } });
}

async function recoverPublicIdentity(identity: ApprovedReleaseBundle): Promise<ApprovedReleaseBundle> {
  if (identity.publicIdentity) return identity;
  const [tag, releases] = await Promise.all([observeTag(identity), observeReleases(identity)]);
  if (tag.state !== "exact" || releases.length !== 1) return identity;
  const release = releases[0]!;
  const publicName = `better-realtime-${identity.version}.bundle.identity.json`;
  const matches = release.assets.filter(({ name }) => name === publicName);
  if (matches.length === 0) return identity;
  if (matches.length !== 1) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PUBLIC_IDENTITY_AMBIGUOUS");
  const observed = matches[0]!;
  if (observed.state !== "uploaded" || !/^[a-f0-9]{64}$/u.test(observed.sha256) || observed.size <= 0) {
    throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PUBLIC_IDENTITY_MISMATCH");
  }
  const bytes = await download(identity, observed);
  if (bytes.byteLength !== observed.size || sha256(bytes) !== observed.sha256) {
    throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PUBLIC_IDENTITY_MISMATCH");
  }
  const workflowSha = process.env.GITHUB_SHA;
  if (!workflowSha || !/^[a-f0-9]{40}$/u.test(workflowSha)) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_WORKFLOW_SHA_INVALID");
  const enriched = adoptPublicReleaseBundleIdentity(identity, bytes, tag.objectSha, release.id, workflowSha);
  if (
    enriched.publicIdentity?.name !== observed.name
    || enriched.publicIdentity.sha256 !== observed.sha256
    || enriched.publicIdentity.size !== observed.size
  ) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PUBLIC_IDENTITY_MISMATCH");
  if (process.env.RELEASE_ASSET_DIR) {
    await writeFile(assetPath(publicName), bytes, { flag: "wx" });
  }
  return enriched;
}

async function finalize(identity: ApprovedReleaseBundle, state: ObservedReleaseBundleState, releaseId: number): Promise<void> {
  const release = state.releases.find(({ id }) => id === releaseId);
  if (!release) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_RELEASE_ID_MISSING");
  for (const expected of [...identity.packages.flatMap(({ artifact, checksum }) => [artifact, checksum]), ...(identity.publicIdentity ? [identity.publicIdentity] : [])]) {
    const observed = release.assets.find(({ name }) => name === expected.name);
    if (!observed) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_ASSET_MISSING");
    const [remote, local] = await Promise.all([download(identity, observed), readFile(assetPath(expected.name))]);
    if (remote.byteLength !== expected.size || sha256(remote) !== expected.sha256 || Buffer.compare(remote, local) !== 0) {
      throw new Error("RT_RELEASE_BUNDLE_PROVIDER_REMOTE_BYTES_MISMATCH");
    }
  }
  const updated = await request<GitHubRelease>(`repos/${identity.repository}/releases/${releaseId}`, {
    method: "PATCH",
    ...jsonBody({ draft: false, prerelease: true, make_latest: "false" }),
  });
  if (updated.id !== releaseId) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_RELEASE_ID_CHANGED");
}

async function stage(
  identity: ApprovedReleaseBundle,
  mode: "stage_github_draft" | "reconcile_github",
): Promise<{ releaseId: number; tagObject: string; existingPublicIdentity: boolean }> {
  let fixedReleaseId: number | undefined;
  for (let transition = 0; transition < 12; transition += 1) {
    let state = await observe(identity, fixedReleaseId);
    if (state.releases.length === 1) fixedReleaseId ??= state.releases[0]!.id;
    const plan = planReleaseBundleTransition(identity, state);
    if (plan.action === "create_tag") {
      if (mode !== "stage_github_draft") throw new Error("RT_RELEASE_BUNDLE_PROVIDER_RECONCILE_REQUIRES_STAGED_DRAFT");
      await createTag(identity);
      continue;
    }
    if (plan.action === "create_release") {
      if (mode !== "stage_github_draft") throw new Error("RT_RELEASE_BUNDLE_PROVIDER_RECONCILE_REQUIRES_STAGED_DRAFT");
      fixedReleaseId = await createRelease(identity);
      continue;
    }
    if (plan.action === "upload_asset") {
      const publicName = `better-realtime-${identity.version}.bundle.identity.json`;
      if (
        mode === "stage_github_draft" && plan.assetName === publicName
        || mode === "reconcile_github" && plan.assetName !== publicName
      ) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_COMMAND_ASSET_BOUNDARY");
      await uploadAsset(identity, plan.releaseId, findAsset(identity, plan.assetName));
      continue;
    }
    if (plan.action === "finalize_release") {
      if (!identity.publicIdentity || mode === "stage_github_draft") {
        if (state.tag.state !== "exact") throw new Error("RT_RELEASE_BUNDLE_PROVIDER_TAG_NOT_EXACT");
        const publicName = `better-realtime-${identity.version}.bundle.identity.json`;
        const existing = state.releases[0]?.assets.find(({ name }) => name === publicName);
        if (existing && !identity.publicIdentity) {
          const bytes = await download(identity, existing);
          if (bytes.byteLength !== existing.size || sha256(bytes) !== existing.sha256) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PUBLIC_IDENTITY_MISMATCH");
          await writeFile(assetPath(publicName), bytes, { flag: "wx" });
        }
        return { releaseId: plan.releaseId, tagObject: state.tag.objectSha, existingPublicIdentity: Boolean(existing) };
      }
      await finalize(identity, state, plan.releaseId);
      continue;
    }
    if (plan.action === "wait_for_immutable") {
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        state = await observe(identity, plan.releaseId);
        const next = planReleaseBundleTransition(identity, state);
        if (next.action !== "wait_for_immutable") break;
        if (attempt === 12) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_IMMUTABLE_TIMEOUT");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
      }
    }
    const finalPlan = planReleaseBundleTransition(identity, state);
    if (!["mark_package_publish_intent", "verify_package_only", "poll_package_registry", "block_ambiguous_publish", "complete"].includes(finalPlan.action)) {
      throw new Error(`RT_RELEASE_BUNDLE_PROVIDER_UNEXPECTED_ACTION:${finalPlan.action}`);
    }
    if (!fixedReleaseId || state.tag.state !== "exact") throw new Error("RT_RELEASE_BUNDLE_PROVIDER_FINAL_IDENTITY_INCOMPLETE");
    const publicName = `better-realtime-${identity.version}.bundle.identity.json`;
    const existing = state.releases[0]?.assets.find(({ name }) => name === publicName);
    if (existing && !identity.publicIdentity) {
      const bytes = await download(identity, existing);
      if (bytes.byteLength !== existing.size || sha256(bytes) !== existing.sha256) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PUBLIC_IDENTITY_MISMATCH");
      await writeFile(assetPath(publicName), bytes, { flag: "wx" });
    }
    return { releaseId: fixedReleaseId, tagObject: state.tag.objectSha, existingPublicIdentity: Boolean(existing) };
  }
  throw new Error("RT_RELEASE_BUNDLE_PROVIDER_TRANSITION_LIMIT");
}

async function preparePackage(identity: ApprovedReleaseBundle, packageName: ReleasePackageName): Promise<void> {
  const state = await observe(identity);
  if (state.releases.length !== 1) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_RELEASE_COUNT_MISMATCH");
  const plan = planReleaseBundleTransition(identity, state);
  const releaseId = state.releases[0]!.id;
  const digest = releaseBundleIdentityDigest(identity, releaseId);
  const workflowSha = process.env.GITHUB_SHA;
  if (!workflowSha || !/^[a-f0-9]{40}$/u.test(workflowSha)) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_WORKFLOW_SHA_INVALID");
  if (plan.action === "mark_package_publish_intent" && plan.packageName === packageName) {
    await output("publish", true);
    await output("publish_run_id", runId);
    await output("publish_run_attempt", runAttempt);
    await output("publish_workflow_sha", workflowSha);
  } else if ((plan.action === "verify_package_only" || plan.action === "poll_package_registry") && plan.packageName === packageName) {
    const intent = state.publishIntents[packageName];
    if (intent.state !== "present") throw new Error("RT_RELEASE_BUNDLE_PROVIDER_INTENT_MISSING");
    const originalRun = await request<ActionsRun>(`repos/${identity.repository}/actions/runs/${intent.runId}/attempts/${intent.runAttempt}`);
    if (
      String(originalRun.id) !== intent.runId
      || String(originalRun.run_attempt) !== intent.runAttempt
      || originalRun.event !== "workflow_dispatch"
      || originalRun.path !== ".github/workflows/release-bundle.yml"
      || !/^[a-f0-9]{40}$/u.test(originalRun.head_sha)
      || originalRun.head_sha !== workflowSha
    ) throw new Error(`RT_RELEASE_BUNDLE_PROVIDER_PUBLISH_RUN_MISMATCH:${packageName}`);
    await output("publish", false);
    await output("publish_run_id", intent.runId);
    await output("publish_run_attempt", intent.runAttempt);
    await output("publish_workflow_sha", originalRun.head_sha);
  } else {
    throw new Error(`RT_RELEASE_BUNDLE_PROVIDER_PACKAGE_NOT_READY:${packageName}:${plan.action}`);
  }
  await output("release_id", releaseId);
  await output("identity_digest", digest);
}

async function output(name: string, value: string | number | boolean): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (path) await appendFile(path, `${name}=${String(value)}\n`);
  else process.stdout.write(`${name}=${String(value)}\n`);
}

async function main(): Promise<void> {
  const identity = await recoverPublicIdentity(await loadIdentity());
  const command = process.argv[2];
  if (command === "observe") {
    const state = await observe(identity);
    process.stdout.write(`${JSON.stringify({ state, plan: planReleaseBundleTransition(identity, state) }, null, 2)}\n`);
    return;
  }
  if (command === "stage-github-draft" || command === "reconcile-github") {
    if (command === "reconcile-github" && process.env.RELEASE_ATTESTATIONS_VERIFIED !== "true") {
      throw new Error("RT_RELEASE_BUNDLE_PROVIDER_ATTESTATION_GATE_REQUIRED");
    }
    const result = await stage(identity, command === "stage-github-draft" ? "stage_github_draft" : "reconcile_github");
    await output("release_id", result.releaseId);
    await output("tag_object", result.tagObject);
    await output("existing_identity", result.existingPublicIdentity);
    return;
  }
  if (command === "prepare-package") {
    const packageName = process.env.RELEASE_PACKAGE_NAME as ReleasePackageName | undefined;
    if (!packageName || !releasePackageNames.includes(packageName)) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_PACKAGE_REQUIRED");
    await preparePackage(identity, packageName);
    return;
  }
  if (command === "write-identity") {
    const destination = process.env.RELEASE_BUNDLE_IDENTITY_OUTPUT;
    if (!destination) throw new Error("RT_RELEASE_BUNDLE_PROVIDER_OUTPUT_REQUIRED");
    await writeFile(resolve(destination), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
    return;
  }
  throw new Error(`RT_RELEASE_BUNDLE_PROVIDER_UNKNOWN_COMMAND:${command ?? ""}`);
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) await main();
