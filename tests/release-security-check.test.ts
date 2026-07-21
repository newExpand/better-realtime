import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleaseSecurity, releaseAuthority } from "../scripts/release-security-contract.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("release-security contract modes", () => {
  it("requires every public contract file", async () => {
    const root = await fixture({ publicWorkflow: false, privateMode: false });
    await expect(checkReleaseSecurity(root)).rejects.toThrow("RT_RELEASE_AUTHORITY_CONTRACT_MISSING:.github/workflows/release.yml");
  });

  it("requires every internal record when the private root exists", async () => {
    const root = await fixture({ publicWorkflow: true, privateMode: true, privatePlan: false });
    await expect(checkReleaseSecurity(root)).rejects.toThrow(`RT_RELEASE_AUTHORITY_CONTRACT_MISSING:${join("docs", "internal", "plan.md")}`);
  });

  it("accepts a public tree only when the internal root is entirely absent", async () => {
    const root = await fixture({ publicWorkflow: true, privateMode: false });
    await expect(checkReleaseSecurity(root)).resolves.toMatchObject({ privateMode: false, checked: [".github/workflows/release.yml", "docs/public/release.md"] });
  });
});

async function fixture(options: { publicWorkflow: boolean; privateMode: boolean; privatePlan?: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "better-realtime-release-security-"));
  temporaryDirectories.push(root);
  const publicDocs = join(root, "docs", "public");
  await mkdir(publicDocs, { recursive: true });
  await writeFile(join(publicDocs, "release.md"), releaseAuthority, "utf8");
  if (options.publicWorkflow) {
    const workflows = join(root, ".github", "workflows");
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, "release.yml"), releaseAuthority, "utf8");
  }
  if (options.privateMode) {
    const privateRoot = join(root, "docs", "internal");
    await mkdir(join(privateRoot, "releases"), { recursive: true });
    await writeFile(join(privateRoot, "releases", "v0.1.0-alpha.1.md"), releaseAuthority, "utf8");
    if (options.privatePlan !== false) await writeFile(join(privateRoot, "plan.md"), releaseAuthority, "utf8");
  }
  return root;
}
