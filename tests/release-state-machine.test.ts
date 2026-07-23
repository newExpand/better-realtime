import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  planReleaseTransition,
  reconcileReleaseState,
  releaseIdentityDigest,
  type ApprovedReleaseIdentity,
  type ObservedRelease,
  type ObservedReleaseState,
  type ReleaseProvider,
} from "../scripts/release-state-machine.ts";

const root = resolve(import.meta.dirname, "..");

const identity: ApprovedReleaseIdentity = {
  repository: "newExpand/better-realtime",
  version: "0.1.0-alpha.5",
  sourceSha: "a".repeat(40),
  tag: "v0.1.0-alpha.5",
  tagMessage: "Better Realtime 0.1.0-alpha.5",
  title: "Better Realtime 0.1.0-alpha.5",
  bodySha256: "b".repeat(64),
  artifact: { name: "better-realtime-0.1.0-alpha.5.tgz", sha256: "c".repeat(64), size: 127_292 },
  checksum: { name: "better-realtime-0.1.0-alpha.5.tgz.sha256", sha256: "d".repeat(64), size: 100 },
  publicIdentity: { name: "better-realtime-0.1.0-alpha.5.identity.json", sha256: "f".repeat(64), size: 1_024 },
  packageFiles: 32,
};
const legacyIdentity: ApprovedReleaseIdentity = structuredClone(identity);
delete legacyIdentity.publicIdentity;

const exactTag = { state: "exact" as const, objectSha: "e".repeat(40), targetSha: identity.sourceSha };
const artifact = { id: 11, name: identity.artifact.name, sha256: identity.artifact.sha256, size: identity.artifact.size, state: "uploaded" as const };
const checksum = { id: 12, name: identity.checksum.name, sha256: identity.checksum.sha256, size: identity.checksum.size, state: "uploaded" as const };
const publicIdentity = { id: 13, name: identity.publicIdentity!.name, sha256: identity.publicIdentity!.sha256, size: identity.publicIdentity!.size, state: "uploaded" as const };
const draft: ObservedRelease = { id: 42, tag: identity.tag, target: identity.sourceSha, title: identity.title, bodySha256: identity.bodySha256, draft: true, prerelease: true, immutable: false, assets: [] };
const immutable: ObservedRelease = { ...draft, draft: false, immutable: true, assets: [artifact, checksum, publicIdentity] };
const intent = { state: "present" as const, runId: "10", runAttempt: "1", releaseId: 42, identityDigest: releaseIdentityDigest(identity, 42) };

function observed(overrides: Partial<ObservedReleaseState> = {}): ObservedReleaseState {
  return {
    tag: { state: "absent" },
    releases: [],
    npm: { state: "absent" },
    publishIntent: { state: "absent" },
    verification: { state: "incomplete" },
    ...overrides,
  };
}

class FakeProvider implements ReleaseProvider {
  state: ObservedReleaseState;
  calls: string[] = [];

  constructor(state = observed()) {
    this.state = structuredClone(state);
  }

  async observe(): Promise<ObservedReleaseState> {
    return structuredClone(this.state);
  }

  async apply(action: Parameters<ReleaseProvider["apply"]>[0]): Promise<void> {
    this.calls.push(action);
    if (action === "create_tag") this.state.tag = exactTag;
    else if (action === "create_release") this.state.releases = [structuredClone(draft)];
    else if (action === "upload_artifact") this.state.releases[0]!.assets = [artifact];
    else if (action === "upload_checksum") this.state.releases[0]!.assets = [artifact, checksum];
    else if (action === "upload_public_identity") this.state.releases[0]!.assets = [artifact, checksum, publicIdentity];
    else if (action === "finalize_release") this.state.releases = [structuredClone(immutable)];
    else if (action === "mark_publish_intent") this.state.publishIntent = intent;
    else if (action === "publish_once") this.state.npm = { state: "exact", sha256: identity.artifact.sha256, size: identity.artifact.size };
  }
}

describe("resumable release state planner", () => {
  it.each([
    ["1. tag, Release, and npm version all absent", observed(), "create_tag", undefined],
    ["2. annotated tag only", observed({ tag: exactTag }), "create_release", undefined],
    ["3. tag plus empty draft", observed({ tag: exactTag, releases: [draft] }), "upload_artifact", 42],
    ["4. draft with only the package asset", observed({ tag: exactTag, releases: [{ ...draft, assets: [artifact] }] }), "upload_checksum", 42],
    ["5a. package-asset-complete draft", observed({ tag: exactTag, releases: [{ ...draft, assets: [artifact, checksum] }] }), "upload_public_identity", 42],
    ["5b. identity-complete draft", observed({ tag: exactTag, releases: [{ ...draft, assets: [artifact, checksum, publicIdentity] }] }), "finalize_release", 42],
    ["6. immutable Release with no npm version", observed({ tag: exactTag, releases: [immutable] }), "mark_publish_intent", 42],
    ["7. ambiguous publish result with exact registry version", observed({ tag: exactTag, releases: [immutable], npm: { state: "exact", sha256: identity.artifact.sha256, size: identity.artifact.size }, publishIntent: intent }), "verify_only", 42],
    ["8. npm version with incomplete post-publish verification", observed({ tag: exactTag, releases: [immutable], npm: { state: "exact", sha256: identity.artifact.sha256, size: identity.artifact.size }, publishIntent: intent }), "verify_only", 42],
    ["9. transient registry E404 after publish intent", observed({ tag: exactTag, releases: [immutable], npm: { state: "transient_e404" }, publishIntent: intent }), "poll_registry", 42],
    ["10. a new dispatch resumes an identity-complete draft", observed({ tag: exactTag, releases: [{ ...draft, assets: [artifact, checksum, publicIdentity] }] }), "finalize_release", 42],
  ] as const)("plans %s", (_name, state, action, releaseId) => {
    expect(planReleaseTransition(identity, state)).toMatchObject({ action, ...(releaseId === undefined ? {} : { releaseId }) });
  });

  it("11. fails closed on every approved identity component", () => {
    const mismatches: Array<[string, ObservedReleaseState]> = [
      ["lightweight or malformed tag", observed({ tag: { state: "mismatch", reason: "not an annotated tag" } })],
      ["tag target", observed({ tag: { ...exactTag, targetSha: "f".repeat(40) } })],
      ["ambiguous Release ID", observed({ tag: exactTag, releases: [draft, { ...draft, id: 43 }] })],
      ["Release target", observed({ tag: exactTag, releases: [{ ...draft, target: "f".repeat(40) }] })],
      ["Release title", observed({ tag: exactTag, releases: [{ ...draft, title: "wrong" }] })],
      ["Release asset digest", observed({ tag: exactTag, releases: [{ ...draft, assets: [{ ...artifact, sha256: "0".repeat(64) }] }] })],
      ["npm artifact digest", observed({ tag: exactTag, releases: [immutable], npm: { state: "exact", sha256: "0".repeat(64), size: identity.artifact.size }, publishIntent: intent })],
      ["publish-intent Release ID", observed({ tag: exactTag, releases: [immutable], publishIntent: { ...intent, releaseId: 43 } })],
      ["publish-intent identity digest", observed({ tag: exactTag, releases: [immutable], publishIntent: { ...intent, identityDigest: "br-release-v1-deadbeef" } })],
    ];
    for (const [boundary, state] of mismatches) {
      expect(() => planReleaseTransition(identity, state), boundary).toThrow(/RT_RELEASE_STATE_/u);
    }
  });

  it("rejects impossible and indeterminate ordering instead of guessing", () => {
    const invalid: ObservedReleaseState[] = [
      observed({ tag: exactTag, npm: { state: "exact", sha256: identity.artifact.sha256, size: identity.artifact.size } }),
      observed({ tag: exactTag, releases: [immutable], npm: { state: "indeterminate", reason: "timeout" }, publishIntent: intent }),
      observed({ tag: exactTag, releases: [immutable], npm: { state: "transient_e404" } }),
      observed({ tag: exactTag, releases: [immutable], npm: { state: "exact", sha256: identity.artifact.sha256, size: identity.artifact.size } }),
      observed({ tag: exactTag, releases: [{ ...draft, assets: [{ ...artifact, id: 13, name: "extra" }] }] }),
    ];
    for (const state of invalid) expect(() => planReleaseTransition(identity, state)).toThrow(/RT_RELEASE_STATE_/u);
  });

  it("binds durable publish intent to the numeric Release ID", () => {
    expect(releaseIdentityDigest(identity, 42)).not.toBe(releaseIdentityDigest(identity, 43));
    expect(planReleaseTransition(identity, observed({ tag: exactTag, releases: [immutable] }))).toMatchObject({ action: "mark_publish_intent", releaseId: 42 });
  });

  it("never repeats a successful mutation after a crash and re-observation", async () => {
    const provider = new FakeProvider();
    for (let crash = 0; crash < 6; crash += 1) {
      await reconcileReleaseState(identity, provider, { stopAfterMutations: 1 });
    }
    expect(await reconcileReleaseState(identity, provider)).toMatchObject({ action: "publish_once", releaseId: 42 });
    expect(await reconcileReleaseState(identity, provider)).toMatchObject({ action: "verify_only", releaseId: 42 });
    expect(provider.calls).toEqual(["create_tag", "create_release", "upload_artifact", "upload_checksum", "upload_public_identity", "finalize_release", "mark_publish_intent", "publish_once"]);
  });

  it("blocks rather than republishing when a prior invocation left durable intent", () => {
    expect(planReleaseTransition(identity, observed({ tag: exactTag, releases: [immutable], publishIntent: intent })).action).toBe("block_ambiguous_publish");
  });

  it("blocks a new invocation that starts after durable publish intent", async () => {
    const provider = new FakeProvider(observed({ tag: exactTag, releases: [immutable] }));
    await reconcileReleaseState(identity, provider, { stopAfterMutations: 1 });
    expect(await reconcileReleaseState(identity, provider)).toMatchObject({ action: "block_ambiguous_publish", releaseId: 42 });
    expect(provider.calls).toEqual(["mark_publish_intent"]);
  });

  it("invokes npm publish at most once even while registry absence remains observable", async () => {
    class LaggingRegistryProvider extends FakeProvider {
      override async apply(action: Parameters<ReleaseProvider["apply"]>[0]): Promise<void> {
        if (action === "publish_once" && this.calls.includes("publish_once")) throw new Error("TEST_DUPLICATE_PUBLISH");
        await super.apply(action);
        if (action === "publish_once") this.state.npm = { state: "absent" };
      }
    }
    const provider = new LaggingRegistryProvider(observed({ tag: exactTag, releases: [immutable] }));
    const result = await reconcileReleaseState(identity, provider);
    expect(result).toMatchObject({ action: "publish_once", releaseId: 42 });
    expect(provider.calls.filter((action) => action === "publish_once")).toHaveLength(1);
  });
});

describe("historical failed release preservation", () => {
  it("refuses every mutation of the preserved alpha.2 tag-only identity", async () => {
    const alpha2: ApprovedReleaseIdentity = {
      ...legacyIdentity,
      version: "0.1.0-alpha.2",
      sourceSha: "fd10345b9fa2e2fc31598987d856e0a6ed1bc51c",
      tag: "v0.1.0-alpha.2",
      tagMessage: "Better Realtime 0.1.0-alpha.2",
      title: "Better Realtime 0.1.0-alpha.2",
      artifact: { name: "better-realtime-0.1.0-alpha.2.tgz", sha256: "d40350df536603fd799e22525485985669ae7aa2f543ac2d77a09d03d6b4c7f7", size: 127_290 },
      checksum: { name: "better-realtime-0.1.0-alpha.2.tgz.sha256", sha256: "e63fabbed7a5beacc57858f9dab6b533f6752b73f2420fb18b05ce3793576e74", size: 100 },
    };
    const alpha2Tag = { state: "exact" as const, objectSha: "5c47946fa91c9a907abc602e391ffa9fa86e8669", targetSha: alpha2.sourceSha };
    const provider: ReleaseProvider & { calls: string[] } = {
      calls: [],
      async observe() { return observed({ tag: alpha2Tag }); },
      async apply(action) { this.calls.push(action); },
    };
    await expect(reconcileReleaseState(alpha2, provider, { stopAfterMutations: 1 })).rejects.toThrow("RT_RELEASE_STATE_PRESERVED_IDENTITY_MUTATION_FORBIDDEN");
    expect(provider.calls).toEqual([]);
  });

  it("refuses to finalize the preserved alpha.3 draft Release ID", async () => {
    const alpha3: ApprovedReleaseIdentity = {
      ...legacyIdentity,
      version: "0.1.0-alpha.3",
      sourceSha: "d51851a94809f6886af3f37639d7fb9b3758d94d",
      tag: "v0.1.0-alpha.3",
      tagMessage: "Better Realtime 0.1.0-alpha.3",
      title: "Better Realtime 0.1.0-alpha.3",
      artifact: { name: "better-realtime-0.1.0-alpha.3.tgz", sha256: "684d7f714031b506f35e33d5bb440165d94a24b9460e18a768a3b06c27075a22", size: 127_291 },
      checksum: { name: "better-realtime-0.1.0-alpha.3.tgz.sha256", sha256: "f113658ea2d071415881d793b05e0f5203af30d19c595ab42b05b0d25ef2f811", size: 100 },
    };
    const alpha3Release: ObservedRelease = {
      id: 358_418_104,
      tag: alpha3.tag,
      target: alpha3.sourceSha,
      title: alpha3.title,
      bodySha256: alpha3.bodySha256,
      draft: true,
      prerelease: true,
      immutable: false,
      assets: [
        { id: 486_646_251, name: alpha3.artifact.name, sha256: alpha3.artifact.sha256, size: alpha3.artifact.size, state: "uploaded" },
        { id: 486_646_250, name: alpha3.checksum.name, sha256: alpha3.checksum.sha256, size: alpha3.checksum.size, state: "uploaded" },
      ],
    };
    const alpha3Tag = { state: "exact" as const, objectSha: "fbeffc45ae7f2bdb8920b1a7ad32b7933e15b05b", targetSha: alpha3.sourceSha };
    const provider: ReleaseProvider & { calls: string[] } = {
      calls: [],
      async observe() { return observed({ tag: alpha3Tag, releases: [alpha3Release] }); },
      async apply(action) { this.calls.push(action); },
    };
    await expect(reconcileReleaseState(alpha3, provider, { stopAfterMutations: 1 })).rejects.toThrow("RT_RELEASE_STATE_PRESERVED_IDENTITY_MUTATION_FORBIDDEN");
    expect(provider.calls).toEqual([]);
  });

  it("refuses every mutation against the completed alpha.4 identity", async () => {
    const alpha4: ApprovedReleaseIdentity = {
      ...legacyIdentity,
      version: "0.1.0-alpha.4",
      tag: "v0.1.0-alpha.4",
      tagMessage: "Better Realtime 0.1.0-alpha.4",
      title: "Better Realtime 0.1.0-alpha.4",
      artifact: { ...identity.artifact, name: "better-realtime-0.1.0-alpha.4.tgz" },
      checksum: { ...identity.checksum, name: "better-realtime-0.1.0-alpha.4.tgz.sha256" },
    };
    const provider = new FakeProvider();
    await expect(reconcileReleaseState(alpha4, provider, { stopAfterMutations: 1 })).rejects.toThrow("RT_RELEASE_STATE_PRESERVED_IDENTITY_MUTATION_FORBIDDEN");
    expect(provider.calls).toEqual([]);
  });
});

describe("release workflow state-machine structure", () => {
  it("uses the create response ID while the authoritative Release list is eventually consistent", async () => {
    const priorToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "test-token";
    vi.resetModules();
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/releases?per_page=100&page=1")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/releases/42")) {
        return new Response(JSON.stringify({
          id: 42,
          tag_name: identity.tag,
          target_commitish: identity.sourceSha,
          name: identity.title,
          body: "release notes",
          draft: true,
          prerelease: true,
          immutable: false,
          upload_url: "https://uploads.github.com/releases/42/assets{?name,label}",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/releases/42/assets?per_page=100&page=1")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`TEST_UNEXPECTED_REQUEST:${url}`);
    });
    try {
      const { observeReleases } = await import("../scripts/release-state-machine-github.ts");
      await expect(observeReleases(identity, 42)).resolves.toMatchObject([
        { id: 42, tag: identity.tag, target: identity.sourceSha, draft: true },
      ]);
      expect(requested).toContain("https://api.github.com/repos/newExpand/better-realtime/releases/42");
    } finally {
      vi.unstubAllGlobals();
      if (priorToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = priorToken;
      vi.resetModules();
    }
  });

  it("never uses the tag endpoint that omits draft Releases", async () => {
    const publish = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const verify = await readFile(resolve(root, ".github/workflows/release-verify.yml"), "utf8");
    const adapter = await readFile(resolve(root, "scripts/release-state-machine-github.ts"), "utf8");
    const implementation = `${publish}\n${verify}\n${adapter}`;
    expect(implementation).not.toMatch(/releases\/tags\//u);
    const workflows = `${publish}\n${verify}`;
    expect(workflows).not.toMatch(/^\s*gh release (?:create|edit|upload|download|view)\b/gmu);
    for (const command of workflows.match(/^\s*gh release verify(?:-asset)?\b.*$/gmu) ?? []) {
      expect(command).toContain('--repo "$GITHUB_REPOSITORY"');
    }
    expect(adapter).toContain("per_page=100&page=${page}");
    expect(adapter).toContain("listAll<GitHubRelease>(`repos/${identity.repository}/releases`)");
    expect(adapter).toContain("/check-runs?filter=all&per_page=100&page=${page}");
    expect(adapter).toContain("checks.push(...response.check_runs)");
    expect(adapter).toContain("`repos/${identity.repository}/releases/${candidate.id}`");
    expect(adapter).toContain("return release.id");
    expect(adapter).toContain("`repos/${identity.repository}/releases/${releaseId}/assets`");
    expect(adapter).toContain("`repos/${identity.repository}/releases/assets/${asset.id}`");
    expect(adapter).toContain("`repos/${identity.repository}/releases/${releaseId}`");
    expect(adapter).not.toMatch(/method:\s*"DELETE"|--clobber/u);
  });

  it("passes a numeric Release ID from staging through finalization and verification", async () => {
    const publish = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const verify = await readFile(resolve(root, ".github/workflows/release-verify.yml"), "utf8");
    const adapter = await readFile(resolve(root, "scripts/release-state-machine-github.ts"), "utf8");
    expect(publish).toContain("release_id:");
    expect(publish).toMatch(/release_id:\s*\$\{\{\s*(?:steps|needs)\.[^}]+\.outputs\.release_id\s*\}\}/u);
    expect(publish).toContain("release_id: ${{ needs.finalize-release.outputs.release_id }}");
    expect(verify).toMatch(/release_id:\s*\n\s+required:\s*true/u);
    expect(`${publish}\n${verify}`).toMatch(/repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$release_id/u);
    expect(adapter).toContain("await observe(identity, fixedReleaseId)");
    expect(adapter).toContain("await observe(identity, releaseId)");
  });

  it("keeps publish intent and the single npm mutation mechanically distinct", async () => {
    const publish = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
    const adapter = await readFile(resolve(root, "scripts/release-state-machine-github.ts"), "utf8");
    expect(adapter).toContain("publish-intent/");
    expect(adapter).toContain("plan-publication");
    expect(publish).toContain("scripts/release-state-machine-github.ts plan-publication");
    const oidcJob = publish.slice(publish.indexOf("\n  publish:"), publish.indexOf("\n  verify:"));
    expect(oidcJob).not.toContain("actions/checkout@");
    expect(oidcJob).not.toContain("pnpm");
    expect(oidcJob).not.toContain("scripts/");
    expect(oidcJob).toContain("Re-observe publication state at the OIDC boundary");
    expect(oidcJob).toContain('"repos/$GITHUB_REPOSITORY/commits/$INPUT_SOURCE_SHA/check-runs?filter=all&per_page=100&page=$page"');
    expect(oidcJob).toContain('echo "publish_run_id=$GITHUB_RUN_ID" >> "$GITHUB_OUTPUT"');
    expect(oidcJob).toContain('echo "publish_run_attempt=$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"');
    expect(oidcJob).toContain("if: steps.reobserve.outputs.publish == 'true'");
    expect(oidcJob).toContain("Record durable publish intent at the OIDC boundary");
    expect(publish.match(/npm publish /gu)).toHaveLength(1);
    expect(publish).not.toMatch(/(?:rerun|run_attempt)[^\n]*npm publish/iu);
  });
});
