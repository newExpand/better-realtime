import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyPublicReleaseIdentityBindings, verifyPublicReleaseIdentityBytes } from "./release-integrity.ts";

const argumentsMap = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error("RT_RELEASE_INTEGRITY_ARGUMENT_INVALID");
  argumentsMap.set(key.slice(2), value);
}
const required = (name: string): string => {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`RT_RELEASE_INTEGRITY_ARGUMENT_REQUIRED:${name}`);
  return value;
};
const identity = JSON.parse(await readFile(resolve(required("identity")), "utf8"));
const githubAsset = new Uint8Array(await readFile(resolve(required("github-asset"))));
const npmTarball = new Uint8Array(await readFile(resolve(required("npm-tarball"))));
const verified = verifyPublicReleaseIdentityBytes(identity, githubAsset, npmTarball);
verifyPublicReleaseIdentityBindings(verified, {
  packageSourceCommit: required("source-commit"),
  annotatedTagObject: required("tag-object"),
  workflowCommit: required("workflow-commit"),
  workflowRunId: required("workflow-run-id"),
  workflowRunAttempt: required("workflow-run-attempt"),
  releaseId: Number(required("release-id")),
});
process.stdout.write(`${JSON.stringify({ schemaVersion: verified.schemaVersion, package: `${verified.package.name}@${verified.package.version}`, result: "verified" })}\n`);
