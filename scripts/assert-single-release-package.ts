import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

interface ActivePackageBoundary {
  readonly manifest: string;
  readonly artifactCommand: string;
  readonly workflow: string;
  readonly environment: string;
  readonly status: "active";
}

interface FuturePackageBoundary {
  readonly manifest: string;
  readonly artifactCommand: string;
  readonly workflow: null;
  readonly environment: null;
  readonly status: "future-separate-release";
  readonly activationRequirements: readonly string[];
}

interface ReleasePackagePolicy {
  readonly schemaVersion: "1.0";
  readonly packages: Readonly<Record<string, ActivePackageBoundary | FuturePackageBoundary>>;
}

export interface ReleasePackageSelection {
  readonly packageName: string;
  readonly manifest: string;
  readonly artifactCommand: string;
  readonly workflow: string;
  readonly environment: string;
}

export async function assertReleasePackageBoundary(selection: ReleasePackageSelection): Promise<void> {
  const policy = JSON.parse(await readFile(resolve(root, "release/package-boundaries.json"), "utf8")) as ReleasePackagePolicy;
  if (policy.schemaVersion !== "1.0" || !policy.packages || Object.keys(policy.packages).length < 2) {
    throw new Error("RT_RELEASE_PACKAGE_POLICY_INVALID");
  }
  const manifests = new Set<string>();
  const activeIdentities = new Set<string>();
  for (const [packageName, boundary] of Object.entries(policy.packages)) {
    if (
      !packageName
      || !boundary.manifest.startsWith("packages/")
      || !boundary.manifest.endsWith("/package.json")
      || !/^[a-z][a-z0-9:-]*$/u.test(boundary.artifactCommand)
      || manifests.has(boundary.manifest)
    ) throw new Error("RT_RELEASE_PACKAGE_POLICY_INVALID");
    manifests.add(boundary.manifest);
    const manifest = JSON.parse(await readFile(resolve(root, boundary.manifest), "utf8")) as {
      name?: unknown;
      private?: unknown;
    };
    if (manifest.name !== packageName || manifest.private === true) throw new Error(`RT_RELEASE_PACKAGE_MANIFEST_MISMATCH:${packageName}`);
    if (boundary.status === "active") {
      if (!boundary.workflow.startsWith(".github/workflows/") || !boundary.workflow.endsWith(".yml") || !boundary.environment) {
        throw new Error("RT_RELEASE_PACKAGE_POLICY_INVALID");
      }
      const identity = `${boundary.workflow}\0${boundary.environment}`;
      if (activeIdentities.has(identity)) throw new Error("RT_RELEASE_PACKAGE_IDENTITY_REUSED");
      activeIdentities.add(identity);
    } else if (
      boundary.status !== "future-separate-release"
      || boundary.workflow !== null
      || boundary.environment !== null
      || !Array.isArray(boundary.activationRequirements)
      || boundary.activationRequirements.length < 3
      || boundary.activationRequirements.some((requirement) => typeof requirement !== "string" || requirement.length < 12)
    ) throw new Error("RT_RELEASE_PACKAGE_POLICY_INVALID");
  }

  const selected = policy.packages[selection.packageName];
  if (!selected) throw new Error(`RT_RELEASE_PACKAGE_NOT_APPROVED:${selection.packageName}`);
  if (selected.status !== "active") throw new Error(`RT_RELEASE_PACKAGE_REQUIRES_SEPARATE_IDENTITY:${selection.packageName}`);
  if (
    selection.manifest !== selected.manifest
    || selection.artifactCommand !== selected.artifactCommand
    || selection.workflow !== selected.workflow
    || selection.environment !== selected.environment
  ) throw new Error(`RT_RELEASE_PACKAGE_BOUNDARY_MISMATCH:${selection.packageName}`);
}

export async function assertSingleReleasePackage(): Promise<void> {
  const names = [
    "RELEASE_PACKAGE_NAME",
    "RELEASE_PACKAGE_MANIFEST",
    "RELEASE_ARTIFACT_COMMAND",
    "RELEASE_WORKFLOW_PATH",
    "RELEASE_NPM_ENVIRONMENT"
  ] as const;
  const explicit = names.some((name) => process.env[name] !== undefined);
  await assertReleasePackageBoundary(explicit ? {
    packageName: required("RELEASE_PACKAGE_NAME"),
    manifest: required("RELEASE_PACKAGE_MANIFEST"),
    artifactCommand: required("RELEASE_ARTIFACT_COMMAND"),
    workflow: required("RELEASE_WORKFLOW_PATH"),
    environment: required("RELEASE_NPM_ENVIRONMENT")
  } : {
    packageName: "better-realtime",
    manifest: "packages/runtime/package.json",
    artifactCommand: "package:pack",
    workflow: ".github/workflows/release.yml",
    environment: "npm-alpha"
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`RT_RELEASE_PACKAGE_SELECTION_REQUIRED:${name}`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await assertSingleReleasePackage();
}
