import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { checkPublicHistory, type PublicHistoryBaseline, type PublicRemoteSnapshot } from "../scripts/check-public-history.ts";

const exec = promisify(execFile);
const temporary: string[] = [];
const author = "120312998+newExpand@users.noreply.github.com";
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function repository(subject = "feat: establish the public alpha baseline", body = "Publish the verified source as one clean root commit.", authorEmail = author): Promise<{ directory: string; root: string }> {
  const directory = await mkdtemp(join(tmpdir(), "better-realtime-public-history-"));
  temporary.push(directory);
  await exec("git", ["init", "-b", "main"], { cwd: directory });
  await exec("git", ["config", "user.name", "newExpand"], { cwd: directory });
  await exec("git", ["config", "user.email", authorEmail], { cwd: directory });
  await writeFile(join(directory, "README.md"), "# Public fixture\n", "utf8");
  await exec("git", ["add", "README.md"], { cwd: directory });
  await exec("git", ["commit", "--no-gpg-sign", "-m", subject, "-m", body], { cwd: directory });
  return { directory, root: (await exec("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim() };
}

async function append(directory: string, sequence: number, subject = "fix: publish a compatible security update", body = "Append one reviewed release commit without rewriting the public root."): Promise<string> {
  await writeFile(join(directory, "CHANGELOG.md"), `release ${sequence}\n`, "utf8");
  await exec("git", ["add", "CHANGELOG.md"], { cwd: directory });
  await exec("git", ["commit", "--no-gpg-sign", "-m", subject, "-m", body], { cwd: directory });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
}

const baseline = (rootCommit: string, tags: PublicHistoryBaseline["tags"] = []): PublicHistoryBaseline => ({ rootCommit, tags });

async function annotatedTag(directory: string, name: string, target: string): Promise<PublicHistoryBaseline["tags"][number]> {
  await exec("git", ["tag", "--annotate", name, "--message", `Better Realtime ${name.slice(1)}`, target], { cwd: directory });
  return {
    name,
    object: (await exec("git", ["rev-parse", `refs/tags/${name}`], { cwd: directory })).stdout.trim(),
    target: (await exec("git", ["rev-parse", `refs/tags/${name}^{commit}`], { cwd: directory })).stdout.trim(),
  };
}

it("accepts the initial unreachable-free English Conventional Commit root", async () => {
  const { directory, root } = await repository();
  await expect(checkPublicHistory(directory, author, root, undefined, { baseline: baseline(root) })).resolves.toMatchObject({ schemaVersion: "1.1", branch: "main", commitCount: 1, appendedCommits: 0, rootCommit: root, headCommit: root, remotes: 0, tags: 0, status: "valid" });
});

it("accepts exactly one linear release commit over the preserved root with the canonical remote and annotated public tag", async () => {
  const { directory, root } = await repository();
  const tag = await annotatedTag(directory, "v0.1.0-alpha.1", root);
  await exec("git", ["remote", "add", "origin", "https://github.com/newExpand/better-realtime.git"], { cwd: directory });
  const head = await append(directory, 2);
  const remoteSnapshot: PublicRemoteSnapshot = { main: root, tags: [tag] };
  await expect(checkPublicHistory(directory, author, root, root, { baseline: baseline(root, [tag]), remoteSnapshot })).resolves.toMatchObject({ commitCount: 2, appendedCommits: 1, rootCommit: root, baseCommit: root, headCommit: head, remotes: 1, tags: 1, status: "valid" });
});

it("rejects root replacement, multiple appended commits, and merge history", async () => {
  const replaced = await repository();
  await expect(checkPublicHistory(replaced.directory, author, "a".repeat(40), undefined, { baseline: baseline("a".repeat(40)) })).rejects.toThrow("RT_PUBLIC_HISTORY_ROOT_INVALID");

  const multiple = await repository();
  await append(multiple.directory, 2);
  await append(multiple.directory, 3);
  await expect(checkPublicHistory(multiple.directory, author, multiple.root, multiple.root, { baseline: baseline(multiple.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_APPEND_INVALID");

  const merged = await repository();
  await exec("git", ["checkout", "-b", "side"], { cwd: merged.directory });
  await writeFile(join(merged.directory, "SIDE.md"), "side\n", "utf8");
  await exec("git", ["add", "SIDE.md"], { cwd: merged.directory });
  await exec("git", ["commit", "--no-gpg-sign", "-m", "docs: add a side record", "-m", "Create a branch record used by the history mutation fixture."], { cwd: merged.directory });
  await exec("git", ["checkout", "main"], { cwd: merged.directory });
  await append(merged.directory, 2);
  await exec("git", ["merge", "--no-ff", "side", "-m", "chore: merge an invalid public branch", "-m", "This merge must be rejected by the append-only public history policy."], { cwd: merged.directory });
  await exec("git", ["branch", "-D", "side"], { cwd: merged.directory });
  await expect(checkPublicHistory(merged.directory, author, merged.root, merged.root, { baseline: baseline(merged.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_MERGE_COMMIT");
});

it("checks every commit message and author against the public identity", async () => {
  const nonEnglish = await repository();
  await append(nonEnglish.directory, 2, "fix: 공개 보안 업데이트", "검증된 변경을 추가합니다.");
  await expect(checkPublicHistory(nonEnglish.directory, author, nonEnglish.root, nonEnglish.root, { baseline: baseline(nonEnglish.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_SUBJECT_INVALID");

  const mismatched = await repository();
  await exec("git", ["config", "user.email", "different@example.invalid"], { cwd: mismatched.directory });
  await append(mismatched.directory, 2);
  await expect(checkPublicHistory(mismatched.directory, author, mismatched.root, mismatched.root, { baseline: baseline(mismatched.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_AUTHOR_EMAIL_MISMATCH");

  const conduct = await repository(undefined, undefined, "support@byteloft.app");
  await expect(checkPublicHistory(conduct.directory, "support@byteloft.app", conduct.root, undefined, { baseline: baseline(conduct.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_CONDUCT_EMAIL_FORBIDDEN");
});

it("rejects non-canonical remotes, push URLs, refs, and private or lightweight tags", async () => {
  const wrongRemote = await repository();
  await exec("git", ["remote", "add", "origin", "https://github.com/example/reused.git"], { cwd: wrongRemote.directory });
  await expect(checkPublicHistory(wrongRemote.directory, author, wrongRemote.root, undefined, { baseline: baseline(wrongRemote.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_REMOTE_INVALID");

  const wrongPush = await repository();
  await exec("git", ["remote", "add", "origin", "https://github.com/newExpand/better-realtime.git"], { cwd: wrongPush.directory });
  await exec("git", ["remote", "set-url", "--add", "--push", "origin", "https://github.com/example/reused.git"], { cwd: wrongPush.directory });
  await expect(checkPublicHistory(wrongPush.directory, author, wrongPush.root, undefined, { baseline: baseline(wrongPush.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_REMOTE_INVALID");

  const outsideRef = await repository();
  await exec("git", ["checkout", "--orphan", "foreign"], { cwd: outsideRef.directory });
  await exec("git", ["rm", "--force", "README.md"], { cwd: outsideRef.directory });
  await writeFile(join(outsideRef.directory, "FOREIGN.md"), "foreign\n", "utf8");
  await exec("git", ["add", "FOREIGN.md"], { cwd: outsideRef.directory });
  await exec("git", ["commit", "--no-gpg-sign", "-m", "docs: create a foreign remote ref", "-m", "This disconnected commit must not be hidden behind another reference."], { cwd: outsideRef.directory });
  const foreign = (await exec("git", ["rev-parse", "HEAD"], { cwd: outsideRef.directory })).stdout.trim();
  await exec("git", ["checkout", "main"], { cwd: outsideRef.directory });
  await exec("git", ["branch", "-D", "foreign"], { cwd: outsideRef.directory });
  await exec("git", ["update-ref", "refs/remotes/origin/foreign", foreign], { cwd: outsideRef.directory });
  await expect(checkPublicHistory(outsideRef.directory, author, outsideRef.root, undefined, { baseline: baseline(outsideRef.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_REF_INVALID");

  const hiddenBlob = await repository();
  const hiddenPath = join(hiddenBlob.directory, "PRIVATE.bin");
  await writeFile(hiddenPath, "private object\n", "utf8");
  const blob = (await exec("git", ["hash-object", "-w", "PRIVATE.bin"], { cwd: hiddenBlob.directory })).stdout.trim();
  await rm(hiddenPath);
  await exec("git", ["update-ref", "refs/archive/private-secret", blob], { cwd: hiddenBlob.directory });
  await expect(checkPublicHistory(hiddenBlob.directory, author, hiddenBlob.root, undefined, { baseline: baseline(hiddenBlob.root) })).rejects.toThrow("RT_PUBLIC_HISTORY_REF_INVALID");

  const privateTag = await repository();
  const privateTagName = ["source", "export/v0.1.0-alpha.3"].join("-");
  await exec("git", ["tag", "--annotate", privateTagName, "--message", "Private tag fixture"], { cwd: privateTag.directory });
  const privateTagObject = (await exec("git", ["rev-parse", `refs/tags/${privateTagName}`], { cwd: privateTag.directory })).stdout.trim();
  await expect(checkPublicHistory(privateTag.directory, author, privateTag.root, undefined, { baseline: baseline(privateTag.root, [{ name: privateTagName, object: privateTagObject, target: privateTag.root }]) })).rejects.toThrow("RT_PUBLIC_HISTORY_TAG_INVALID");

  const lightweight = await repository();
  await exec("git", ["tag", "v0.1.0-alpha.1"], { cwd: lightweight.directory });
  await expect(checkPublicHistory(lightweight.directory, author, lightweight.root, undefined, { baseline: baseline(lightweight.root, [{ name: "v0.1.0-alpha.1", object: lightweight.root, target: lightweight.root }]) })).rejects.toThrow("RT_PUBLIC_HISTORY_TAG_INVALID");
});

it("rejects environment substitution, remote main drift, and existing annotated tag movement", async () => {
  const substituted = await repository();
  await expect(checkPublicHistory(substituted.directory, author, substituted.root, undefined, { baseline: baseline("a".repeat(40)) })).rejects.toThrow("RT_PUBLIC_HISTORY_ROOT_EXPECTATION_MISMATCH");

  const moved = await repository();
  const originalTag = await annotatedTag(moved.directory, "v0.1.0-alpha.1", moved.root);
  await exec("git", ["remote", "add", "origin", "https://github.com/newExpand/better-realtime.git"], { cwd: moved.directory });
  const head = await append(moved.directory, 2);
  await exec("git", ["tag", "--force", "--annotate", "v0.1.0-alpha.1", "--message", "Moved tag fixture", head], { cwd: moved.directory });
  const snapshot: PublicRemoteSnapshot = { main: moved.root, tags: [originalTag] };
  await expect(checkPublicHistory(moved.directory, author, moved.root, moved.root, { baseline: baseline(moved.root, [originalTag]), remoteSnapshot: snapshot })).rejects.toThrow("RT_PUBLIC_HISTORY_TAG_IDENTITY_INVALID");

  const remoteDrift = await repository();
  const tag = await annotatedTag(remoteDrift.directory, "v0.1.0-alpha.1", remoteDrift.root);
  await exec("git", ["remote", "add", "origin", "https://github.com/newExpand/better-realtime.git"], { cwd: remoteDrift.directory });
  await append(remoteDrift.directory, 2);
  const wrongMain: PublicRemoteSnapshot = { main: "b".repeat(40), tags: [tag] };
  await expect(checkPublicHistory(remoteDrift.directory, author, remoteDrift.root, remoteDrift.root, { baseline: baseline(remoteDrift.root, [tag]), remoteSnapshot: wrongMain })).rejects.toThrow("RT_PUBLIC_HISTORY_REMOTE_MAIN_MISMATCH");
});
