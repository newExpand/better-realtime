import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const currentVersion = "0.2.0-alpha.1";

async function read(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

async function markdownFiles(path: string): Promise<string[]> {
  const absolute = resolve(root, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = `${path}/${entry.name}`;
    if (entry.isDirectory()) return markdownFiles(relative);
    return extname(entry.name) === ".md" ? [relative] : [];
  }));
  return nested.flat();
}

describe("published documentation state", () => {
  it("describes the published 0.2 alpha instead of the pre-release candidate state", async () => {
    const [readme, template, quickstart, migration, supportMatrix, diagnostics, server] = await Promise.all([
      read("README.md"),
      read("support/README.template.md"),
      read("docs/public/quickstart.md"),
      read("docs/public/migration-0.2.md"),
      read("docs/public/support-matrix.md"),
      read("docs/public/diagnostics.md"),
      read("docs/public/server.md")
    ]);

    for (const document of [readme, template]) {
      expect(document).toContain(`\`${currentVersion}\` is the current published alpha`);
      expect(document).toContain("## Install the current alpha");
      expect(document).not.toContain("`0.1.0-alpha.4` is the current published evaluation release");
      expect(document).not.toContain("unpublished `0.2.0-alpha.1` candidate");
      expect(document).not.toContain("an npm `E404` is expected");
    }
    expect(quickstart).toContain(`The current published release is Better Realtime \`${currentVersion}\``);
    expect(quickstart).not.toContain("The version is not available from npm");
    expect(migration).toContain(`\`${currentVersion}\` is the published migration boundary`);
    expect(migration).not.toContain("It is not published by this repository state");
    expect(supportMatrix).toContain("Chromium, Firefox, and WebKit");
    expect(supportMatrix).not.toContain("private 0.2 candidate");
    expect(diagnostics).toContain("The `0.2` release moves MCP");
    expect(server).not.toContain("not claimed by this candidate");
  });

  it("uses a current support pointer while preserving the historical 0.1 manifest", async () => {
    const [pointerSource, currentSource, historicalSource] = await Promise.all([
      read("support/current.json"),
      read("support/alpha-0.2.json"),
      read("support/alpha-0.1.json")
    ]);
    const pointer = JSON.parse(pointerSource) as { manifest: string; releaseVersion: string };
    const current = JSON.parse(currentSource) as { releaseLine: string; releaseVersion: string };
    const historical = JSON.parse(historicalSource) as { releaseLine: string; releaseVersion: string };

    expect(pointer).toEqual({
      schemaVersion: "1.0",
      manifest: "alpha-0.2.json",
      releaseVersion: currentVersion
    });
    expect(current).toMatchObject({ releaseLine: "0.2.x-alpha", releaseVersion: currentVersion });
    expect(historical).toMatchObject({ releaseLine: "0.1.x-alpha", releaseVersion: "0.1.0-alpha.1" });
  });

  it("records completed bootstrap and both interactive latest commands", async () => {
    const [releaseBundle, releaseIntegrity] = await Promise.all([
      read("docs/public/release-bundle.md"),
      read("docs/public/release-integrity.md")
    ]);
    expect(releaseBundle).toContain("The one-time companion bootstrap is complete and must not be repeated.");
    expect(releaseBundle).toContain(`npm dist-tag add better-realtime@${currentVersion} latest`);
    expect(releaseBundle).toContain(`npm dist-tag add better-realtime-mcp@${currentVersion} latest`);
    expect(releaseBundle).not.toContain("does not yet exist in the public npm registry");
    expect(releaseIntegrity).toContain("Verify a two-package release");
    expect(releaseIntegrity).toContain("using each record's own workflow commit, run ID, and attempt");
    expect(releaseIntegrity).toContain("npm-mcp-alpha");
  });

  it("advances compatible and breaking changes from the published 0.2 baseline", async () => {
    const [release, stability] = await Promise.all([
      read("docs/public/release.md"),
      read("docs/public/stability.md")
    ]);
    for (const document of [release, stability]) {
      expect(document).toContain("next unused prerelease on the current `0.2.0-alpha.N` line");
      expect(document).toContain("new minor alpha line");
      expect(document).not.toContain("compatible fixes/additions use the next unused `0.1.x-alpha` identity");
    }
  });

  it("keeps public relative Markdown links inside the exported surface", async () => {
    const documents = [
      "README.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "ROADMAP.md",
      "SECURITY.md",
      ...(await markdownFiles("docs/public"))
    ];

    for (const document of documents) {
      const source = await read(document);
      const links = [...source.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)].map((match) => match[1]!.trim());
      for (const rawLink of links) {
        const link = rawLink.startsWith("<") && rawLink.endsWith(">") ? rawLink.slice(1, -1) : rawLink.split(/\s+/, 1)[0]!;
        if (/^(?:https?:|mailto:|#)/.test(link)) continue;
        const path = link.split("#", 1)[0]!;
        expect(path, `${document} must not link to private documentation`).not.toMatch(/(?:^|\/)internal(?:\/|$)/);
        await expect(access(resolve(root, dirname(document), decodeURIComponent(path))), `${document} -> ${link}`).resolves.toBeUndefined();
      }
    }
  });
});
