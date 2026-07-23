import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovedReleaseIdentity } from "../scripts/release-state-machine.ts";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface FakeProviderOptions {
  ambiguousAfterCreate?: boolean;
  existingImmutableIdentity?: boolean;
}

async function fakeProvider(options: FakeProviderOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "better-realtime-release-provider-"));
  const notes = "Better Realtime alpha.5 test release\n";
  const artifactBytes = new TextEncoder().encode("approved alpha.5 artifact");
  const artifactName = "better-realtime-0.1.0-alpha.5.tgz";
  const artifactSha = sha256(artifactBytes);
  const checksumBytes = new TextEncoder().encode(`${artifactSha}  ${artifactName}\n`);
  const identity: ApprovedReleaseIdentity = {
    repository: "newExpand/better-realtime",
    version: "0.1.0-alpha.5",
    sourceSha: "a".repeat(40),
    tag: "v0.1.0-alpha.5",
    tagMessage: "Better Realtime 0.1.0-alpha.5",
    title: "Better Realtime 0.1.0-alpha.5",
    bodySha256: sha256(notes),
    artifact: { name: artifactName, sha256: artifactSha, size: artifactBytes.byteLength },
    checksum: {
      name: `${artifactName}.sha256`,
      sha256: sha256(checksumBytes),
      size: checksumBytes.byteLength,
    },
    packageFiles: 32,
  };
  const notesPath = join(directory, "release-notes.md");
  await writeFile(notesPath, notes);
  await writeFile(join(directory, identity.artifact.name), artifactBytes);
  await writeFile(join(directory, identity.checksum.name), checksumBytes);

  const existingIdentityBytes = new TextEncoder().encode('{"schemaVersion":"better-realtime.release-identity.v1"}\n');
  const existingIdentityName = `better-realtime-${identity.version}.identity.json`;
  const preexisting = options.existingImmutableIdentity === true;
  let created = preexisting;
  let draft = !preexisting;
  let immutable = preexisting;
  let createCalls = 0;
  let directCreatedReleaseReads = 0;
  const mutations: string[] = [];
  const assets: Array<{ id: number; name: string; digest: string; size: number; state: string; bytes: Uint8Array }> = preexisting
    ? [
        { id: 11, name: identity.artifact.name, digest: `sha256:${identity.artifact.sha256}`, size: identity.artifact.size, state: "uploaded", bytes: artifactBytes },
        { id: 12, name: identity.checksum.name, digest: `sha256:${identity.checksum.sha256}`, size: identity.checksum.size, state: "uploaded", bytes: checksumBytes },
        { id: 13, name: existingIdentityName, digest: `sha256:${sha256(existingIdentityBytes)}`, size: existingIdentityBytes.byteLength, state: "uploaded", bytes: existingIdentityBytes },
      ]
    : [];

  const release = (id: number) => ({
    id,
    tag_name: identity.tag,
    target_commitish: identity.sourceSha,
    name: identity.title,
    body: notes,
    draft: id === 42 ? draft : true,
    prerelease: true,
    immutable: id === 42 ? immutable : false,
    upload_url: `https://uploads.github.test/releases/${id}/assets{?name,label}`,
  });

  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const path = url.pathname;
    if (url.hostname === "registry.npmjs.org") return new Response("not found", { status: 404 });
    if (path.endsWith(`/git/ref/tags/${identity.tag}`)) {
      return json({ object: { type: "tag", sha: "e".repeat(40) } });
    }
    if (path.endsWith(`/git/tags/${"e".repeat(40)}`)) {
      return json({ tag: identity.tag, message: identity.tagMessage, object: { type: "commit", sha: identity.sourceSha } });
    }
    if (path.endsWith(`/commits/${identity.sourceSha}/check-runs`)) {
      return json({ total_count: 0, check_runs: [] });
    }
    if (path.endsWith("/releases") && method === "GET") {
      if (preexisting) return json([release(42)]);
      return json(created && options.ambiguousAfterCreate ? [release(43)] : []);
    }
    if (path.endsWith("/releases") && method === "POST") {
      created = true;
      createCalls += 1;
      mutations.push("create_release");
      return json(release(42));
    }
    if (path.endsWith("/releases/42") && method === "GET") {
      directCreatedReleaseReads += 1;
      return json(release(42));
    }
    if (path.endsWith("/releases/43") && method === "GET") return json(release(43));
    if (path.endsWith("/releases/42/assets") && method === "GET") {
      return json(assets.map(({ bytes: _bytes, ...asset }) => asset));
    }
    if (path.endsWith("/releases/43/assets") && method === "GET") return json([]);
    if (url.hostname === "uploads.github.test" && path.endsWith("/releases/42/assets") && method === "POST") {
      const name = url.searchParams.get("name");
      const expected = name === identity.artifact.name ? identity.artifact : identity.checksum;
      const bytes = new Uint8Array(init.body as ArrayBufferLike);
      const asset = { id: assets.length + 11, name, digest: `sha256:${sha256(bytes)}`, size: bytes.byteLength, state: "uploaded", bytes };
      if (name !== expected.name) throw new Error(`TEST_UNEXPECTED_ASSET:${name}`);
      assets.push(asset as typeof assets[number]);
      mutations.push(`upload:${name}`);
      return json(asset);
    }
    const assetMatch = path.match(/\/releases\/assets\/([0-9]+)$/u);
    if (assetMatch && method === "GET") {
      const asset = assets.find(({ id }) => id === Number(assetMatch[1]));
      if (!asset) return new Response("not found", { status: 404 });
      return new Response(asset.bytes.slice().buffer as ArrayBuffer, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    if (path.endsWith("/releases/42") && method === "PATCH") {
      draft = false;
      immutable = true;
      mutations.push("finalize_release");
      return json(release(42));
    }
    throw new Error(`TEST_UNEXPECTED_REQUEST:${method}:${url}`);
  });

  return {
    identity,
    directory,
    notesPath,
    fetch,
    createCalls: () => createCalls,
    directCreatedReleaseReads: () => directCreatedReleaseReads,
    mutations,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe.sequential("GitHub release provider recovery", () => {
  it("stages the exact draft and returns its numeric ID and annotated tag object without finalizing", async () => {
    const provider = await fakeProvider();
    const priorToken = process.env.GH_TOKEN;
    const priorNotes = process.env.RELEASE_NOTES_FILE;
    const priorAssets = process.env.RELEASE_ASSET_DIR;
    process.env.GH_TOKEN = "test-token";
    process.env.RELEASE_NOTES_FILE = provider.notesPath;
    process.env.RELEASE_ASSET_DIR = provider.directory;
    vi.stubGlobal("fetch", provider.fetch);
    vi.resetModules();
    try {
      const { stageGithubDraft } = await import("../scripts/release-state-machine-github.ts");
      await expect(stageGithubDraft(provider.identity)).resolves.toMatchObject({ releaseId: 42, tagObject: "e".repeat(40) });
      expect(provider.mutations).toEqual([
        "create_release",
        `upload:${provider.identity.artifact.name}`,
        `upload:${provider.identity.checksum.name}`,
      ]);
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = priorToken;
      if (priorNotes === undefined) delete process.env.RELEASE_NOTES_FILE; else process.env.RELEASE_NOTES_FILE = priorNotes;
      if (priorAssets === undefined) delete process.env.RELEASE_ASSET_DIR; else process.env.RELEASE_ASSET_DIR = priorAssets;
      await rm(provider.directory, { recursive: true, force: true });
    }
  });

  it("re-adopts the identity asset from an exact immutable Release without repeating a mutation", async () => {
    const provider = await fakeProvider({ existingImmutableIdentity: true });
    const priorToken = process.env.GH_TOKEN;
    const priorNotes = process.env.RELEASE_NOTES_FILE;
    const priorAssets = process.env.RELEASE_ASSET_DIR;
    process.env.GH_TOKEN = "test-token";
    process.env.RELEASE_NOTES_FILE = provider.notesPath;
    process.env.RELEASE_ASSET_DIR = provider.directory;
    vi.stubGlobal("fetch", provider.fetch);
    vi.resetModules();
    try {
      const { stageGithubDraft } = await import("../scripts/release-state-machine-github.ts");
      const result = await stageGithubDraft(provider.identity);
      expect(result).toMatchObject({
        releaseId: 42,
        tagObject: "e".repeat(40),
        existingPublicIdentity: {
          name: `better-realtime-${provider.identity.version}.identity.json`,
          sha256: sha256(new TextEncoder().encode('{"schemaVersion":"better-realtime.release-identity.v1"}\n')),
        },
      });
      expect(provider.mutations).toEqual([]);
      await expect(readFile(join(provider.directory, `better-realtime-${provider.identity.version}.identity.json`), "utf8"))
        .resolves.toBe('{"schemaVersion":"better-realtime.release-identity.v1"}\n');
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = priorToken;
      if (priorNotes === undefined) delete process.env.RELEASE_NOTES_FILE; else process.env.RELEASE_NOTES_FILE = priorNotes;
      if (priorAssets === undefined) delete process.env.RELEASE_ASSET_DIR; else process.env.RELEASE_ASSET_DIR = priorAssets;
      await rm(provider.directory, { recursive: true, force: true });
    }
  });

  it("pins the create response ID and never creates a duplicate while the Release list lags", async () => {
    const provider = await fakeProvider();
    const priorToken = process.env.GH_TOKEN;
    const priorNotes = process.env.RELEASE_NOTES_FILE;
    const priorAssets = process.env.RELEASE_ASSET_DIR;
    process.env.GH_TOKEN = "test-token";
    process.env.RELEASE_NOTES_FILE = provider.notesPath;
    process.env.RELEASE_ASSET_DIR = provider.directory;
    vi.stubGlobal("fetch", provider.fetch);
    vi.resetModules();
    try {
      const { reconcileGithub } = await import("../scripts/release-state-machine-github.ts");
      await expect(reconcileGithub(provider.identity)).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.createCalls()).toBe(1);
      expect(provider.directCreatedReleaseReads()).toBeGreaterThan(0);
      expect(provider.mutations).toEqual([
        "create_release",
        `upload:${provider.identity.artifact.name}`,
        `upload:${provider.identity.checksum.name}`,
        "finalize_release",
      ]);
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = priorToken;
      if (priorNotes === undefined) delete process.env.RELEASE_NOTES_FILE; else process.env.RELEASE_NOTES_FILE = priorNotes;
      if (priorAssets === undefined) delete process.env.RELEASE_ASSET_DIR; else process.env.RELEASE_ASSET_DIR = priorAssets;
      await rm(provider.directory, { recursive: true, force: true });
    }
  });

  it("fails closed before another mutation when the list reveals a second same-tag Release", async () => {
    const provider = await fakeProvider({ ambiguousAfterCreate: true });
    const priorToken = process.env.GH_TOKEN;
    const priorNotes = process.env.RELEASE_NOTES_FILE;
    const priorAssets = process.env.RELEASE_ASSET_DIR;
    process.env.GH_TOKEN = "test-token";
    process.env.RELEASE_NOTES_FILE = provider.notesPath;
    process.env.RELEASE_ASSET_DIR = provider.directory;
    vi.stubGlobal("fetch", provider.fetch);
    vi.resetModules();
    try {
      const { reconcileGithub } = await import("../scripts/release-state-machine-github.ts");
      await expect(reconcileGithub(provider.identity)).rejects.toThrow("RT_RELEASE_STATE_AMBIGUOUS_RELEASE");
      expect(provider.createCalls()).toBe(1);
      expect(provider.mutations).toEqual(["create_release"]);
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = priorToken;
      if (priorNotes === undefined) delete process.env.RELEASE_NOTES_FILE; else process.env.RELEASE_NOTES_FILE = priorNotes;
      if (priorAssets === undefined) delete process.env.RELEASE_ASSET_DIR; else process.env.RELEASE_ASSET_DIR = priorAssets;
      await rm(provider.directory, { recursive: true, force: true });
    }
  });
});
