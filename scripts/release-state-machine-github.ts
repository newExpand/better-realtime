import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  assertReleaseIdentityMutable,
  planReleaseTransition,
  releaseIdentityDigest,
  type ApprovedReleaseIdentity,
  type NpmObservation,
  type ObservedAsset,
  type ObservedRelease,
  type ObservedReleaseState,
} from "./release-state-machine.ts";

const apiVersion = "2026-03-10";
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const runId = process.env.GITHUB_RUN_ID ?? "local";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, url: string) {
    super(`RT_RELEASE_PROVIDER_HTTP_${status}:${url}:${body.slice(0, 300)}`);
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  if (!token) throw new Error("RT_RELEASE_PROVIDER_GITHUB_TOKEN_REQUIRED");
  const headers = new Headers(init.headers);
  headers.set("Accept", headers.get("Accept") ?? "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", apiVersion);
  headers.set("User-Agent", "better-realtime-release-state-machine");
  const response = await fetch(url.startsWith("https://") ? url : `https://api.github.com/${url}`, { ...init, headers });
  if (!response.ok) throw new HttpError(response.status, await response.text(), response.url);
  if (headers.get("Accept") === "application/octet-stream") return new Uint8Array(await response.arrayBuffer()) as T;
  return await response.json() as T;
}

async function requestOptional<T>(path: string): Promise<T | undefined> {
  try {
    return await request<T>(path);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

async function listAll<T>(path: string): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await request<T[]>(`${path}${separator}per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}

function jsonBody(value: unknown): Pick<RequestInit, "body" | "headers"> {
  return { body: JSON.stringify(value), headers: { "Content-Type": "application/json" } };
}

interface GitHubAsset { id: number; name: string; digest: string | null; size: number; state: string }
interface GitHubRelease { id: number; tag_name: string; target_commitish: string; name: string | null; body: string | null; draft: boolean; prerelease: boolean; immutable: boolean; upload_url: string }
interface GitTagRef { object: { type: string; sha: string } }
interface GitTagObject { tag: string; message: string; object: { type: string; sha: string } }
interface CheckRun { id: number; name: string; external_id: string | null; head_sha: string }
interface CheckRunsResponse { total_count: number; check_runs: CheckRun[] }

function assertApprovedIdentity(identity: ApprovedReleaseIdentity): void {
  planReleaseTransition(identity, {
    tag: { state: "absent" }, releases: [], npm: { state: "absent" }, publishIntent: { state: "absent" }, verification: { state: "incomplete" },
  });
}

async function loadIdentity(): Promise<ApprovedReleaseIdentity> {
  const path = process.env.RELEASE_IDENTITY_FILE;
  if (!path) throw new Error("RT_RELEASE_PROVIDER_IDENTITY_FILE_REQUIRED");
  const identity = JSON.parse(await readFile(resolve(path), "utf8")) as ApprovedReleaseIdentity;
  assertApprovedIdentity(identity);
  return identity;
}

async function observeTag(identity: ApprovedReleaseIdentity): Promise<ObservedReleaseState["tag"]> {
  const ref = await requestOptional<GitTagRef>(`repos/${identity.repository}/git/ref/tags/${encodeURIComponent(identity.tag)}`);
  if (!ref) return { state: "absent" };
  if (ref.object.type !== "tag") return { state: "mismatch", reason: "lightweight tag" };
  const object = await request<GitTagObject>(`repos/${identity.repository}/git/tags/${ref.object.sha}`);
  if (object.tag !== identity.tag || object.message !== identity.tagMessage || object.object.type !== "commit" || object.object.sha !== identity.sourceSha) {
    return { state: "mismatch", reason: "annotated tag identity" };
  }
  return { state: "exact", objectSha: ref.object.sha, targetSha: object.object.sha };
}

async function releaseAssets(identity: ApprovedReleaseIdentity, releaseId: number): Promise<ObservedAsset[]> {
  const assets = await listAll<GitHubAsset>(`repos/${identity.repository}/releases/${releaseId}/assets`);
  return assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    sha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : "",
    size: asset.size,
    state: asset.state === "uploaded" ? "uploaded" : "starter",
  }));
}

async function materializeRelease(identity: ApprovedReleaseIdentity, candidate: GitHubRelease): Promise<ObservedRelease> {
  const release = await request<GitHubRelease>(`repos/${identity.repository}/releases/${candidate.id}`);
  if (release.id !== candidate.id) throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED");
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
}

export async function observeReleases(identity: ApprovedReleaseIdentity, fixedReleaseId?: number): Promise<ObservedRelease[]> {
  const all = await listAll<GitHubRelease>(`repos/${identity.repository}/releases`);
  const matches = all.filter(({ tag_name }) => tag_name === identity.tag);
  if (fixedReleaseId !== undefined && !matches.some(({ id }) => id === fixedReleaseId)) {
    matches.push(await request<GitHubRelease>(`repos/${identity.repository}/releases/${fixedReleaseId}`));
  }
  return await Promise.all(matches.map(async (candidate) => await materializeRelease(identity, candidate)));
}

async function observePublishIntent(identity: ApprovedReleaseIdentity, releases: ObservedRelease[]): Promise<ObservedReleaseState["publishIntent"]> {
  const prefix = `publish-intent/${identity.version}/`;
  const checks: CheckRun[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request<CheckRunsResponse>(`repos/${identity.repository}/commits/${identity.sourceSha}/check-runs?filter=all&per_page=100&page=${page}`);
    checks.push(...response.check_runs);
    if (response.check_runs.length < 100) break;
  }
  const matches = checks.filter(({ name }) => name.startsWith(prefix));
  if (matches.length === 0) return { state: "absent" };
  if (matches.length !== 1 || releases.length !== 1) throw new Error("RT_RELEASE_STATE_AMBIGUOUS_PUBLISH_INTENT");
  const marker = matches[0]!;
  const segments = marker.name.slice(prefix.length).split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1] || marker.head_sha !== identity.sourceSha || marker.external_id !== releaseIdentityDigest(identity, releases[0]!.id)) {
    throw new Error("RT_RELEASE_STATE_PUBLISH_INTENT_MISMATCH");
  }
  return { state: "present", runId: segments[0], runAttempt: segments[1], releaseId: releases[0]!.id, identityDigest: marker.external_id };
}

async function observeNpm(identity: ApprovedReleaseIdentity, intentPresent: boolean): Promise<NpmObservation> {
  let metadataResponse: Response;
  try {
    metadataResponse = await fetch(`https://registry.npmjs.org/better-realtime/${encodeURIComponent(identity.version)}`, { headers: { Accept: "application/json" } });
  } catch (error) {
    return { state: "indeterminate", reason: String(error) };
  }
  if (metadataResponse.status === 404) return intentPresent ? { state: "transient_e404" } : { state: "absent" };
  if (!metadataResponse.ok) return { state: "indeterminate", reason: `HTTP ${metadataResponse.status}` };
  const metadata = await metadataResponse.json() as { dist?: { tarball?: string } };
  if (!metadata.dist?.tarball) return { state: "indeterminate", reason: "registry tarball URL absent" };
  try {
    const tarballResponse = await fetch(metadata.dist.tarball);
    if (!tarballResponse.ok) return { state: "indeterminate", reason: `tarball HTTP ${tarballResponse.status}` };
    const bytes = new Uint8Array(await tarballResponse.arrayBuffer());
    return { state: "exact", sha256: sha256(bytes), size: bytes.byteLength };
  } catch (error) {
    return { state: "indeterminate", reason: String(error) };
  }
}

async function observe(identity: ApprovedReleaseIdentity, fixedReleaseId?: number): Promise<ObservedReleaseState> {
  const [tag, releases] = await Promise.all([observeTag(identity), observeReleases(identity, fixedReleaseId)]);
  const publishIntent = await observePublishIntent(identity, releases);
  const npm = await observeNpm(identity, publishIntent.state === "present");
  return { tag, releases, npm, publishIntent, verification: { state: "incomplete" } };
}

async function createTag(identity: ApprovedReleaseIdentity): Promise<void> {
  const object = await request<{ sha: string }>(`repos/${identity.repository}/git/tags`, {
    method: "POST", ...jsonBody({ tag: identity.tag, message: identity.tagMessage, object: identity.sourceSha, type: "commit" }),
  });
  await request(`repos/${identity.repository}/git/refs`, { method: "POST", ...jsonBody({ ref: `refs/tags/${identity.tag}`, sha: object.sha }) });
}

async function createRelease(identity: ApprovedReleaseIdentity): Promise<number> {
  const body = await readFile(process.env.RELEASE_NOTES_FILE ?? "CHANGELOG.md", "utf8");
  if (sha256(body) !== identity.bodySha256) throw new Error("RT_RELEASE_PROVIDER_NOTES_MISMATCH");
  const release = await request<GitHubRelease>(`repos/${identity.repository}/releases`, {
    method: "POST",
    ...jsonBody({ tag_name: identity.tag, target_commitish: identity.sourceSha, name: identity.title, body, draft: true, prerelease: true, make_latest: "false" }),
  });
  return release.id;
}

function localAssetPath(name: string): string {
  const root = process.env.RELEASE_ASSET_DIR;
  if (!root) throw new Error("RT_RELEASE_PROVIDER_ASSET_DIR_REQUIRED");
  return resolve(root, name);
}

async function uploadAsset(identity: ApprovedReleaseIdentity, releaseId: number, asset: ApprovedReleaseIdentity["artifact"]): Promise<void> {
  const release = await request<GitHubRelease>(`repos/${identity.repository}/releases/${releaseId}`);
  if (!release.draft || release.immutable) throw new Error("RT_RELEASE_PROVIDER_UPLOAD_REQUIRES_DRAFT");
  const bytes = new Uint8Array(await readFile(localAssetPath(asset.name)));
  if (bytes.byteLength !== asset.size || sha256(bytes) !== asset.sha256) throw new Error("RT_RELEASE_PROVIDER_LOCAL_ASSET_MISMATCH");
  const uploadUrl = release.upload_url.replace(/\{.*$/u, "");
  const uploaded = await request<GitHubAsset>(`${uploadUrl}?name=${encodeURIComponent(asset.name)}`, {
    method: "POST", headers: { Accept: "application/vnd.github+json", "Content-Type": "application/octet-stream" }, body: bytes,
  });
  if (uploaded.name !== asset.name || uploaded.size !== asset.size || uploaded.digest !== `sha256:${asset.sha256}` || uploaded.state !== "uploaded") throw new Error("RT_RELEASE_PROVIDER_UPLOADED_ASSET_MISMATCH");
}

async function downloadAsset(identity: ApprovedReleaseIdentity, asset: ObservedAsset): Promise<Uint8Array> {
  return await request<Uint8Array>(`repos/${identity.repository}/releases/assets/${asset.id}`, { headers: { Accept: "application/octet-stream" } });
}

async function finalizeRelease(identity: ApprovedReleaseIdentity, state: ObservedReleaseState, releaseId: number): Promise<void> {
  const release = state.releases.find(({ id }) => id === releaseId);
  if (!release) throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_MISSING");
  for (const expected of [identity.artifact, identity.checksum]) {
    const asset = release.assets.find(({ name }) => name === expected.name);
    if (!asset) throw new Error("RT_RELEASE_PROVIDER_ASSET_ID_MISSING");
    const remote = await downloadAsset(identity, asset);
    const local = new Uint8Array(await readFile(localAssetPath(expected.name)));
    if (sha256(remote) !== expected.sha256 || remote.byteLength !== expected.size || Buffer.compare(remote, local) !== 0) throw new Error("RT_RELEASE_PROVIDER_REMOTE_BYTES_MISMATCH");
  }
  const updated = await request<GitHubRelease>(`repos/${identity.repository}/releases/${releaseId}`, {
    method: "PATCH", ...jsonBody({ draft: false, prerelease: true, make_latest: "false" }),
  });
  if (updated.id !== releaseId) throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED");
}

async function applyGithubTransition(identity: ApprovedReleaseIdentity, state: ObservedReleaseState): Promise<number | undefined> {
  const plan = planReleaseTransition(identity, state);
  if (plan.action === "create_tag") await createTag(identity);
  else if (plan.action === "create_release") return await createRelease(identity);
  else if (plan.action === "upload_artifact") await uploadAsset(identity, plan.releaseId!, identity.artifact);
  else if (plan.action === "upload_checksum") await uploadAsset(identity, plan.releaseId!, identity.checksum);
  else if (plan.action === "finalize_release") await finalizeRelease(identity, state, plan.releaseId!);
  else return plan.releaseId;
  return undefined;
}

async function waitForImmutable(identity: ApprovedReleaseIdentity, releaseId: number): Promise<ObservedReleaseState> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const state = await observe(identity, releaseId);
    if (state.releases.length !== 1 || state.releases[0]!.id !== releaseId) throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED");
    const plan = planReleaseTransition(identity, state);
    if (plan.action !== "wait_for_immutable") return state;
    if (attempt === 12) throw new Error("RT_RELEASE_PROVIDER_IMMUTABLE_TIMEOUT");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error("RT_RELEASE_PROVIDER_IMMUTABLE_TIMEOUT");
}

export async function reconcileGithub(identity: ApprovedReleaseIdentity): Promise<{ state: ObservedReleaseState; releaseId: number }> {
  let fixedReleaseId: number | undefined;
  for (let transition = 0; transition < 8; transition += 1) {
    let state = await observe(identity, fixedReleaseId);
    if (state.releases.length === 1) {
      fixedReleaseId ??= state.releases[0]!.id;
      if (state.releases[0]!.id !== fixedReleaseId) throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED");
    }
    const plan = planReleaseTransition(identity, state);
    if (plan.action === "wait_for_immutable") state = await waitForImmutable(identity, plan.releaseId!);
    else if (["create_tag", "create_release", "upload_artifact", "upload_checksum", "finalize_release"].includes(plan.action)) {
      const createdId = await applyGithubTransition(identity, state);
      fixedReleaseId ??= createdId;
      continue;
    }
    const finalPlan = planReleaseTransition(identity, state);
    if (!["mark_publish_intent", "verify_only", "poll_registry", "block_ambiguous_publish", "complete"].includes(finalPlan.action)) throw new Error(`RT_RELEASE_PROVIDER_UNEXPECTED_ACTION:${finalPlan.action}`);
    if (!finalPlan.releaseId) throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_MISSING");
    return { state, releaseId: finalPlan.releaseId };
  }
  throw new Error("RT_RELEASE_PROVIDER_TRANSITION_LIMIT");
}

interface PublicationPlan {
  releaseId: number;
  publish: boolean;
  publishRunId: string;
  publishRunAttempt: string;
  identityDigest: string;
}

function assertExpectedReleaseId(releaseId: number): void {
  const expected = process.env.EXPECTED_RELEASE_ID;
  if (!expected || !/^[1-9][0-9]*$/u.test(expected) || Number(expected) !== releaseId) {
    throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_MISMATCH");
  }
}

async function planPublication(identity: ApprovedReleaseIdentity): Promise<PublicationPlan> {
  let state = await observe(identity);
  if (state.releases.length !== 1) throw new Error("RT_RELEASE_STATE_RELEASE_COUNT_MISMATCH");
  const releaseId = state.releases[0]!.id;
  assertExpectedReleaseId(releaseId);
  let plan = planReleaseTransition(identity, state);
  if (plan.action === "verify_only" || plan.action === "complete") {
    if (state.publishIntent.state !== "present") throw new Error("RT_RELEASE_PROVIDER_PUBLISHED_WITHOUT_INTENT");
    return {
      releaseId,
      publish: false,
      publishRunId: state.publishIntent.runId,
      publishRunAttempt: state.publishIntent.runAttempt,
      identityDigest: state.publishIntent.identityDigest,
    };
  }
  if (plan.action === "poll_registry" || plan.action === "block_ambiguous_publish") {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const next = await observe(identity);
      if (next.releases.length !== 1 || next.releases[0]!.id !== releaseId) throw new Error("RT_RELEASE_PROVIDER_RELEASE_ID_CHANGED");
      plan = planReleaseTransition(identity, next);
      if (plan.action === "verify_only" || plan.action === "complete") {
        if (next.publishIntent.state !== "present") throw new Error("RT_RELEASE_PROVIDER_PUBLISHED_WITHOUT_INTENT");
        return {
          releaseId,
          publish: false,
          publishRunId: next.publishIntent.runId,
          publishRunAttempt: next.publishIntent.runAttempt,
          identityDigest: next.publishIntent.identityDigest,
        };
      }
      if (!['poll_registry', 'block_ambiguous_publish'].includes(plan.action)) throw new Error(`RT_RELEASE_PROVIDER_AMBIGUOUS_STATE_CHANGED:${plan.action}`);
      if (attempt === 20) throw new Error("RT_RELEASE_STATE_AMBIGUOUS_PUBLISH");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
    }
  }
  if (plan.action !== "mark_publish_intent") throw new Error(`RT_RELEASE_PROVIDER_PUBLISH_NOT_ALLOWED:${plan.action}`);
  return {
    releaseId,
    publish: true,
    publishRunId: runId,
    publishRunAttempt: runAttempt,
    identityDigest: releaseIdentityDigest(identity, releaseId),
  };
}

async function output(name: string, value: string | number | boolean): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) await appendFile(outputPath, `${name}=${String(value)}\n`);
  else process.stdout.write(`${name}=${String(value)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const identity = await loadIdentity();
  if (command === "observe") {
    const state = await observe(identity);
    process.stdout.write(`${JSON.stringify({ state, plan: planReleaseTransition(identity, state) }, null, 2)}\n`);
    return;
  }
  if (command === "reconcile-github") {
    assertReleaseIdentityMutable(identity);
    const result = await reconcileGithub(identity);
    await output("release_id", result.releaseId);
    await output("next_action", planReleaseTransition(identity, result.state).action);
    return;
  }
  if (command === "plan-publication") {
    assertReleaseIdentityMutable(identity);
    const result = await planPublication(identity);
    await output("release_id", result.releaseId);
    await output("publish", result.publish);
    await output("publish_run_id", result.publishRunId);
    await output("publish_run_attempt", result.publishRunAttempt);
    await output("identity_digest", result.identityDigest);
    return;
  }
  if (command === "write-identity") {
    const destination = process.env.RELEASE_IDENTITY_OUTPUT;
    if (!destination) throw new Error("RT_RELEASE_PROVIDER_IDENTITY_OUTPUT_REQUIRED");
    await writeFile(destination, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
    return;
  }
  throw new Error(`RT_RELEASE_PROVIDER_UNKNOWN_COMMAND:${command ?? ""}`);
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) await main();
