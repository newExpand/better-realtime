import { access, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const releaseAuthority = "Bootstrap GAT authority: packages-all read-write, organizations no-access, bypass-2FA enabled; not package- or version-scoped.";
const prohibited = ["minimal-scope granular access token", "limited to the first publish", "Exact-alpha.1, short-lived"];

export async function checkReleaseSecurity(root = resolve(import.meta.dirname, "..")): Promise<{ checked: string[]; privateMode: boolean }> {
  const publicPaths = [resolve(root, ".github", "workflows", "release.yml"), resolve(root, "docs", "public", "release.md")];
  const privateRoot = resolve(root, "docs", "internal");
  const privatePaths = [resolve(privateRoot, "releases", "v0.1.0-alpha.1.md"), resolve(privateRoot, "plan.md")];
  const privateMode = await exists(privateRoot);
  const required = privateMode ? [...publicPaths, ...privatePaths] : publicPaths;
  const checked: string[] = [];
  for (const path of required) {
    if (!(await exists(path))) throw new Error(`RT_RELEASE_AUTHORITY_CONTRACT_MISSING:${relative(root, path)}`);
    const text = await readFile(path, "utf8");
    if (!text.includes(releaseAuthority)) throw new Error(`RT_RELEASE_AUTHORITY_DRIFT:${relative(root, path)}`);
    for (const phrase of prohibited) if (text.includes(phrase)) throw new Error(`RT_RELEASE_AUTHORITY_OVERCLAIM:${relative(root, path)}`);
    checked.push(relative(root, path));
  }
  return { checked, privateMode };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
