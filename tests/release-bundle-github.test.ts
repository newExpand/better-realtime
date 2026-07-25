import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovedReleaseBundle } from "../scripts/release-bundle-state-machine.ts";

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

interface FakeProviderOptions {
  tagInitiallyExists?: boolean;
  initialTagStatus?: number;
  tagRefPostStatus?: number;
  tagIdentity?: "exact" | "lightweight" | "wrong_message" | "wrong_target";
  tagReadPattern?: Array<"absent" | "exact">;
  hiddenTagReads?: number;
  hiddenTagObjectReads?: number;
  releasePostStatus?: number;
  hiddenReleaseListReads?: number;
  hiddenReleaseDirectReads?: number;
  releaseIdentityMismatch?: boolean;
  preexistingApprovedAsset?: boolean;
  preexistingCompleteAssets?: boolean;
  preexistingPublicIdentity?: boolean;
  preexistingAssetMismatch?: boolean;
  existingReleaseState?: "draft" | "finalized" | "immutable";
  assetPostStatus?: number;
  hiddenAssetReads?: number;
  regressAssetAfterExact?: boolean;
  crossRegressPinnedAssets?: boolean;
  assetMismatch?: boolean;
}

async function delayedTagProvider(options: FakeProviderOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "better-realtime-release-bundle-provider-"));
  const notes = "Better Realtime 0.2.0-alpha.1 test release\n";
  const packageNames = ["better-realtime", "better-realtime-mcp"] as const;
  const packageEnvironments = ["npm-alpha", "npm-mcp-alpha"] as const;
  const packageBytes = packageNames.map((name) => new TextEncoder().encode(`${name} approved artifact`));
  const packages = packageNames.map((name, index) => {
    const artifactName = `${name}-0.2.0-alpha.1.tgz`;
    const artifactSha = sha256(packageBytes[index]!);
    const checksumBytes = new TextEncoder().encode(`${artifactSha}  ${artifactName}\n`);
    return {
      name,
      artifact: { name: artifactName, sha256: artifactSha, size: packageBytes[index]!.byteLength },
      checksum: { name: `${artifactName}.sha256`, sha256: sha256(checksumBytes), size: checksumBytes.byteLength },
      packageFiles: index === 0 ? 32 : 11,
      unpackedSize: index === 0 ? 200 : 80,
      npmEnvironment: packageEnvironments[index]!,
      checksumBytes,
    };
  });
  const identity: ApprovedReleaseBundle = {
    schemaVersion: "better-realtime.release-bundle.v1",
    repository: "newExpand/better-realtime",
    version: "0.2.0-alpha.1",
    sourceSha: "a".repeat(40),
    tag: "v0.2.0-alpha.1",
    tagMessage: "Better Realtime 0.2.0-alpha.1",
    title: "Better Realtime 0.2.0-alpha.1",
    bodySha256: sha256(notes),
    packages: [
      (({ checksumBytes: _checksumBytes, ...value }) => value)(packages[0]!),
      (({ checksumBytes: _checksumBytes, ...value }) => value)(packages[1]!),
    ],
  };
  const notesPath = join(directory, "release-notes.md");
  await writeFile(notesPath, notes);
  for (const [index, entry] of packages.entries()) {
    await writeFile(join(directory, entry.artifact.name), packageBytes[index]!);
    await writeFile(join(directory, entry.checksum.name), entry.checksumBytes);
  }

  let tagRefCreated = options.tagInitiallyExists ?? false;
  let hiddenTagReads = options.hiddenTagReads ?? 1;
  let tagReadPatternIndex = 0;
  let hiddenTagObjectReads = options.hiddenTagObjectReads ?? 0;
  let releaseCreated = false;
  let hiddenReleaseListReads = options.hiddenReleaseListReads ?? 0;
  let hiddenReleaseDirectReads = options.hiddenReleaseDirectReads ?? 0;
  let tagObjectPosts = 0;
  let tagRefPosts = 0;
  let releasePosts = 0;
  let assetPosts = 0;
  const createdTagObjectSha = "e".repeat(40);
  const visibleTagObjectSha = options.tagRefPostStatus === 422 ? "f".repeat(40) : createdTagObjectSha;
  const assets: Array<{ id: number; name: string; digest: string; size: number; state: string }> = [];
  const assetBytes = new Map<number, Uint8Array>();
  const hiddenAssetReads = new Map<string, number>();
  const assetReadCounts = new Map<string, number>();
  let twoAssetSnapshotReads = 0;
  const publicIdentityBytes = new TextEncoder().encode('{"schemaVersion":"better-realtime.public-release-bundle.v1"}\n');
  const publicIdentityName = `better-realtime-${identity.version}.bundle.identity.json`;
  const approvedBytes = new Map<string, Uint8Array>();
  for (const [index, entry] of packages.entries()) {
    approvedBytes.set(entry.artifact.name, packageBytes[index]!);
    approvedBytes.set(entry.checksum.name, entry.checksumBytes);
  }
  const finalState = options.existingReleaseState ?? "draft";
  const release = {
    id: 42,
    tag_name: identity.tag,
    target_commitish: options.releaseIdentityMismatch ? "9".repeat(40) : identity.sourceSha,
    name: identity.title,
    body: notes,
    draft: finalState === "draft",
    prerelease: true,
    immutable: finalState === "immutable",
    upload_url: "https://uploads.github.test/releases/42/assets{?name,label}",
  };

  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const path = url.pathname;
    if (url.hostname === "registry.npmjs.org") return new Response("not found", { status: 404 });
    if (path.endsWith(`/git/ref/tags/${identity.tag}`) && method === "GET") {
      if (options.initialTagStatus && !tagRefCreated) return new Response("tag read failed", { status: options.initialTagStatus });
      if (!tagRefCreated) return new Response("not found", { status: 404 });
      const patterned = options.tagReadPattern?.[tagReadPatternIndex++];
      if (patterned === "absent" || (patterned === undefined && hiddenTagReads-- > 0)) {
        return new Response("not found", { status: 404 });
      }
      return json({
        object: {
          type: options.tagIdentity === "lightweight" ? "commit" : "tag",
          sha: visibleTagObjectSha,
        },
      });
    }
    if (path.endsWith(`/git/tags/${visibleTagObjectSha}`) && method === "GET") {
      if (hiddenTagObjectReads-- > 0) return new Response("not found", { status: 404 });
      return json({
        tag: identity.tag,
        message: options.tagIdentity === "wrong_message" ? "wrong message" : identity.tagMessage,
        object: {
          type: "commit",
          sha: options.tagIdentity === "wrong_target" ? "9".repeat(40) : identity.sourceSha,
        },
      });
    }
    if (path.endsWith("/git/tags") && method === "POST") {
      tagObjectPosts += 1;
      return json({ sha: createdTagObjectSha }, 201);
    }
    if (path.endsWith("/git/refs") && method === "POST") {
      tagRefPosts += 1;
      tagRefCreated = true;
      if (options.tagRefPostStatus === 422) return json({ message: "Reference already exists" }, 422);
      if (options.tagRefPostStatus && options.tagRefPostStatus !== 201) {
        return json({ message: "tag ref failed" }, options.tagRefPostStatus);
      }
      return json({ ref: `refs/tags/${identity.tag}`, object: { type: "tag", sha: createdTagObjectSha } }, 201);
    }
    if (path.endsWith(`/commits/${identity.sourceSha}/check-runs`) && method === "GET") {
      return json({ total_count: 0, check_runs: [] });
    }
    if (path.endsWith("/releases") && method === "GET") {
      if (releaseCreated && hiddenReleaseListReads-- > 0) return json([]);
      return json(releaseCreated ? [release] : []);
    }
    if (path.endsWith("/releases") && method === "POST") {
      releaseCreated = true;
      releasePosts += 1;
      if (options.releasePostStatus === 422) {
        if (assets.length === 0 && (options.preexistingApprovedAsset || options.preexistingCompleteAssets)) {
          const expectedAssets = options.preexistingCompleteAssets
            ? identity.packages.flatMap(({ artifact, checksum }) => [artifact, checksum])
            : [identity.packages[0].artifact];
          for (const expected of expectedAssets) {
            const id = assets.length + 11;
            assets.push({
              id,
              name: expected.name,
              digest: options.preexistingAssetMismatch ? `sha256:${"9".repeat(64)}` : `sha256:${expected.sha256}`,
              size: expected.size,
              state: options.preexistingAssetMismatch ? "starter" : "uploaded",
            });
            assetBytes.set(id, approvedBytes.get(expected.name)!);
          }
        }
        if (options.preexistingPublicIdentity && !assets.some(({ name }) => name === publicIdentityName)) {
          const id = assets.length + 11;
          assets.push({
            id,
            name: publicIdentityName,
            digest: `sha256:${sha256(publicIdentityBytes)}`,
            size: publicIdentityBytes.byteLength,
            state: "uploaded",
          });
          assetBytes.set(id, publicIdentityBytes);
        }
        return json({ message: "release exists" }, 422);
      }
      if (options.releasePostStatus && options.releasePostStatus !== 201) {
        return json({ message: "release create failed" }, options.releasePostStatus);
      }
      return json(release, 201);
    }
    if (path.endsWith("/releases/42") && method === "GET") {
      if (hiddenReleaseDirectReads-- > 0) return new Response("not found", { status: 404 });
      return json(release);
    }
    if (path.endsWith("/releases/42/assets") && method === "GET") {
      const crossSnapshotRead = options.crossRegressPinnedAssets && assets.length === 2
        ? ++twoAssetSnapshotReads
        : 0;
      return json(assets.filter((asset) => {
        if (crossSnapshotRead === 2 && asset.id !== assets[0]!.id) return false;
        if (crossSnapshotRead === 3 && asset.id !== assets[1]!.id) return false;
        const readCount = (assetReadCounts.get(asset.name) ?? 0) + 1;
        assetReadCounts.set(asset.name, readCount);
        if (options.regressAssetAfterExact && readCount === 2) return false;
        const hidden = hiddenAssetReads.get(asset.name) ?? 0;
        if (hidden <= 0) return true;
        hiddenAssetReads.set(asset.name, hidden - 1);
        return false;
      }));
    }
    if (url.hostname === "uploads.github.test" && path.endsWith("/releases/42/assets") && method === "POST") {
      const name = url.searchParams.get("name");
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      assetPosts += 1;
      const asset = {
        id: assets.length + 11,
        name: name ?? "",
        digest: options.assetMismatch ? `sha256:${"9".repeat(64)}` : `sha256:${sha256(bytes)}`,
        size: bytes.byteLength,
        state: options.assetMismatch ? "starter" : "uploaded",
      };
      assets.push(asset);
      assetBytes.set(asset.id, bytes);
      hiddenAssetReads.set(asset.name, options.hiddenAssetReads ?? 0);
      if (options.assetPostStatus === 422) return json({ message: "asset exists" }, 422);
      if (options.assetPostStatus && options.assetPostStatus !== 201) {
        return json({ message: "asset upload failed" }, options.assetPostStatus);
      }
      return json(asset, 201);
    }
    const assetMatch = path.match(/\/releases\/assets\/([0-9]+)$/u);
    if (assetMatch && method === "GET") {
      const bytes = assetBytes.get(Number(assetMatch[1]));
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    throw new Error(`TEST_UNEXPECTED_REQUEST:${method}:${url}`);
  });

  return {
    directory,
    notesPath,
    identity,
    fetch,
    tagObjectPosts: () => tagObjectPosts,
    tagRefPosts: () => tagRefPosts,
    releasePosts: () => releasePosts,
    assetPosts: () => assetPosts,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function withProvider(
  options: FakeProviderOptions,
  assertion: (
    provider: Awaited<ReturnType<typeof delayedTagProvider>>,
    stage: (
      identity: ApprovedReleaseBundle,
      mode: "stage_github_draft" | "reconcile_github",
    ) => Promise<{ releaseId: number; tagObject: string; existingPublicIdentity: boolean }>,
  ) => Promise<void>,
): Promise<void> {
  const provider = await delayedTagProvider(options);
  const prior = {
    GH_TOKEN: process.env.GH_TOKEN,
    RELEASE_NOTES_FILE: process.env.RELEASE_NOTES_FILE,
    RELEASE_ASSET_DIR: process.env.RELEASE_ASSET_DIR,
    RELEASE_PROVIDER_SETTLE_ATTEMPTS: process.env.RELEASE_PROVIDER_SETTLE_ATTEMPTS,
    RELEASE_PROVIDER_SETTLE_DELAY_MS: process.env.RELEASE_PROVIDER_SETTLE_DELAY_MS,
  };
  process.env.GH_TOKEN = "test-token";
  process.env.RELEASE_NOTES_FILE = provider.notesPath;
  process.env.RELEASE_ASSET_DIR = provider.directory;
  process.env.RELEASE_PROVIDER_SETTLE_ATTEMPTS = "4";
  process.env.RELEASE_PROVIDER_SETTLE_DELAY_MS = "0";
  vi.stubGlobal("fetch", provider.fetch);
  vi.resetModules();
  try {
    const { stageReleaseBundle } = await import("../scripts/release-bundle-github.ts");
    await assertion(provider, stageReleaseBundle);
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(provider.directory, { recursive: true, force: true });
  }
}

describe.sequential("two-package GitHub release visibility reconciliation", () => {
  it("rejects an invalid visibility bound before any mutation", async () => {
    await withProvider({}, async (provider, stage) => {
      process.env.RELEASE_PROVIDER_SETTLE_ATTEMPTS = "0";
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow(
        "RT_RELEASE_BUNDLE_PROVIDER_CONFIGURATION_INVALID:RELEASE_PROVIDER_SETTLE_ATTEMPTS",
      );
      expect(provider.tagObjectPosts()).toBe(0);
      expect(provider.tagRefPosts()).toBe(0);
    });
  });

  it("creates an annotated tag once when GitHub temporarily hides the new ref", async () => {
    await withProvider({}, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({
        releaseId: 42,
        tagObject: "e".repeat(40),
      });
      expect(provider.tagObjectPosts()).toBe(1);
      expect(provider.tagRefPosts()).toBe(1);
    });
  });

  it("reconciles a ref POST 422 only after an exact annotated tag becomes visible", async () => {
    await withProvider({ tagRefPostStatus: 422 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({
        releaseId: 42,
        tagObject: "f".repeat(40),
      });
      expect(provider.tagObjectPosts()).toBe(1);
      expect(provider.tagRefPosts()).toBe(1);
      expect(provider.releasePosts()).toBe(1);
    });
  });

  it("performs no tag mutation when the exact annotated tag already exists", async () => {
    await withProvider({ tagInitiallyExists: true, hiddenTagReads: 0 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({
        releaseId: 42,
        tagObject: "e".repeat(40),
      });
      expect(provider.tagObjectPosts()).toBe(0);
      expect(provider.tagRefPosts()).toBe(0);
    });
  });

  it("waits for a pre-existing annotated object without mutating its visible ref", async () => {
    await withProvider(
      { tagInitiallyExists: true, hiddenTagReads: 0, hiddenTagObjectReads: 1 },
      async (provider, stage) => {
        await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({
          releaseId: 42,
          tagObject: "e".repeat(40),
        });
        expect(provider.tagObjectPosts()).toBe(0);
        expect(provider.tagRefPosts()).toBe(0);
      },
    );
  });

  it("does not repeat a tag mutation after a visible ref regresses to stale absence", async () => {
    await withProvider({ tagReadPattern: ["exact", "absent", "exact"] }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({
        releaseId: 42,
        tagObject: "e".repeat(40),
      });
      expect(provider.tagObjectPosts()).toBe(1);
      expect(provider.tagRefPosts()).toBe(1);
    });
  });

  it.each(["lightweight", "wrong_message", "wrong_target"] as const)(
    "fails closed when a 422 reveals a %s tag",
    async (tagIdentity) => {
      await withProvider({ tagRefPostStatus: 422, tagIdentity }, async (provider, stage) => {
        await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_TAG_MISMATCH");
        expect(provider.tagRefPosts()).toBe(1);
        expect(provider.releasePosts()).toBe(0);
      });
    },
  );

  it("waits for an annotated tag object that lags behind its visible ref", async () => {
    await withProvider({ hiddenTagReads: 0, hiddenTagObjectReads: 1 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ tagObject: "e".repeat(40) });
      expect(provider.tagRefPosts()).toBe(1);
    });
  });

  it("times out without repeating the ref mutation when the tag stays hidden", async () => {
    await withProvider({ hiddenTagReads: 99 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_TAG_VISIBILITY_TIMEOUT");
      expect(provider.tagObjectPosts()).toBe(1);
      expect(provider.tagRefPosts()).toBe(1);
      expect(provider.releasePosts()).toBe(0);
    });
  });

  it("times out after a ref POST 422 when no exact tag becomes observable", async () => {
    await withProvider({ tagRefPostStatus: 422, hiddenTagReads: 99 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_TAG_VISIBILITY_TIMEOUT");
      expect(provider.tagRefPosts()).toBe(1);
      expect(provider.releasePosts()).toBe(0);
    });
  });

  it("does not reconcile a non-422 tag ref API failure", async () => {
    await withProvider({ tagRefPostStatus: 500 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_HTTP_500");
      expect(provider.tagRefPosts()).toBe(1);
      expect(provider.releasePosts()).toBe(0);
    });
  });

  it("propagates a tag observation API failure without mutating", async () => {
    await withProvider({ initialTagStatus: 500 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_HTTP_500");
      expect(provider.tagObjectPosts()).toBe(0);
      expect(provider.tagRefPosts()).toBe(0);
    });
  });

  it("pins and observes the exact created Release through list and direct-read lag", async () => {
    await withProvider({ hiddenReleaseListReads: 1, hiddenReleaseDirectReads: 1 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.releasePosts()).toBe(1);
    });
  });

  it("reconciles a Release POST 422 only through a unique exact draft", async () => {
    await withProvider({ releasePostStatus: 422 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.releasePosts()).toBe(1);
    });
  });

  it("times out after a Release POST 422 while the authoritative list stays absent", async () => {
    await withProvider(
      { releasePostStatus: 422, hiddenReleaseListReads: 99 },
      async (provider, stage) => {
        await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow(
          "RT_RELEASE_BUNDLE_PROVIDER_RELEASE_VISIBILITY_TIMEOUT",
        );
        expect(provider.releasePosts()).toBe(1);
        expect(provider.assetPosts()).toBe(0);
      },
    );
  });

  it("preserves an exact approved asset subset when reconciling an existing partial draft", async () => {
    await withProvider(
      { releasePostStatus: 422, preexistingApprovedAsset: true },
      async (provider, stage) => {
        await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
        expect(provider.releasePosts()).toBe(1);
        expect(provider.assetPosts()).toBe(3);
      },
    );
  });

  it("rejects a mismatched asset in a reconciled partial draft", async () => {
    await withProvider(
      { releasePostStatus: 422, preexistingApprovedAsset: true, preexistingAssetMismatch: true },
      async (provider, stage) => {
        await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow(
          "RT_RELEASE_BUNDLE_PROVIDER_EXISTING_ASSET_MISMATCH",
        );
        expect(provider.releasePosts()).toBe(1);
        expect(provider.assetPosts()).toBe(0);
      },
    );
  });

  it("recovers an existing complete draft and hands its public identity to strict adoption", async () => {
    await withProvider(
      { releasePostStatus: 422, preexistingCompleteAssets: true, preexistingPublicIdentity: true },
      async (provider, stage) => {
        await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({
          releaseId: 42,
          existingPublicIdentity: true,
        });
        expect(provider.assetPosts()).toBe(0);
        await expect(
          readFile(join(provider.directory, `better-realtime-${provider.identity.version}.bundle.identity.json`), "utf8"),
        ).resolves.toContain("better-realtime.public-release-bundle.v1");
      },
    );
  });

  it("recovers a hidden exact immutable Release without repeating Release or asset mutation", async () => {
    await withProvider(
      {
        releasePostStatus: 422,
        preexistingCompleteAssets: true,
        preexistingPublicIdentity: true,
        existingReleaseState: "immutable",
      },
      async (provider, stage) => {
        await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({
          releaseId: 42,
          existingPublicIdentity: true,
        });
        expect(provider.releasePosts()).toBe(1);
        expect(provider.assetPosts()).toBe(0);
      },
    );
  });

  it("uses the created Release ID while the authoritative list remains stale", async () => {
    await withProvider({ hiddenReleaseListReads: 99 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.releasePosts()).toBe(1);
      expect(provider.assetPosts()).toBe(4);
    });
  });

  it("fails closed when the created Release identity differs", async () => {
    await withProvider({ releaseIdentityMismatch: true }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_RELEASE_IDENTITY_MISMATCH");
      expect(provider.releasePosts()).toBe(1);
      expect(provider.assetPosts()).toBe(0);
    });
  });

  it("observes every uploaded asset before allowing the next upload", async () => {
    await withProvider({ hiddenAssetReads: 1 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.assetPosts()).toBe(4);
    });
  });

  it("does not repeat an asset upload after visibility regresses on another replica", async () => {
    await withProvider({ regressAssetAfterExact: true }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.assetPosts()).toBe(4);
    });
  });

  it("requires all pinned assets to be exact in the same provider snapshot", async () => {
    await withProvider({ crossRegressPinnedAssets: true }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.assetPosts()).toBe(4);
    });
  });

  it("reconciles asset POST 422 only when the exact uploaded bytes are observable", async () => {
    await withProvider({ assetPostStatus: 422 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).resolves.toMatchObject({ releaseId: 42 });
      expect(provider.assetPosts()).toBe(4);
    });
  });

  it("times out after an asset mutation without repeating it", async () => {
    await withProvider({ hiddenAssetReads: 99 }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_ASSET_VISIBILITY_TIMEOUT");
      expect(provider.assetPosts()).toBe(1);
    });
  });

  it("rejects a starter or wrong-digest asset after upload", async () => {
    await withProvider({ assetMismatch: true }, async (provider, stage) => {
      await expect(stage(provider.identity, "stage_github_draft")).rejects.toThrow("RT_RELEASE_BUNDLE_PROVIDER_UPLOADED_ASSET_MISMATCH");
      expect(provider.assetPosts()).toBe(1);
    });
  });
});
