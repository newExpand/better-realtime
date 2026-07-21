import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { checkPublicHistory } from "../scripts/check-public-history.ts";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function repository(subject: string, body: string, authorEmail = "release-fixture@example.invalid"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "better-realtime-public-history-"));
  temporary.push(directory);
  await exec("git", ["init", "-b", "main"], { cwd: directory });
  await exec("git", ["config", "user.name", "Release Fixture"], { cwd: directory });
  await exec("git", ["config", "user.email", authorEmail], { cwd: directory });
  await writeFile(join(directory, "README.md"), "# Public fixture\n", "utf8");
  await exec("git", ["add", "README.md"], { cwd: directory });
  await exec("git", ["commit", "--no-gpg-sign", "-m", subject, "-m", body], { cwd: directory });
  return directory;
}

it("accepts one unreachable-free English Conventional Commit root with no remote or tag", async () => {
  const directory = await repository("feat: establish the public alpha baseline", "Publish the verified source as one clean root commit.");
  await expect(checkPublicHistory(directory, "release-fixture@example.invalid")).resolves.toMatchObject({ branch: "main", commitCount: 1, authorEmail: "release-fixture@example.invalid", remotes: 0, tags: 0, unreachableObjects: 0, status: "valid" });
});

it("rejects a non-English public root message", async () => {
  const directory = await repository("feat: 공개 알파 기준선을 확정", "검증된 공개 소스를 하나의 root commit으로 구성합니다.");
  await expect(checkPublicHistory(directory, "release-fixture@example.invalid")).rejects.toThrow("RT_PUBLIC_HISTORY_SUBJECT_INVALID");
});

it("rejects a reused repository with a remote even when its visible history has one commit", async () => {
  const directory = await repository("feat: establish the public alpha baseline", "Publish the verified source as one clean root commit.");
  await exec("git", ["remote", "add", "origin", "https://github.com/example/reused.git"], { cwd: directory });
  await expect(checkPublicHistory(directory, "release-fixture@example.invalid")).rejects.toThrow("RT_PUBLIC_HISTORY_REMOTE_PRESENT");
});

it("requires the user-approved author email and rejects the conduct address", async () => {
  const mismatched = await repository("feat: establish the public alpha baseline", "Publish the verified source as one clean root commit.");
  await expect(checkPublicHistory(mismatched, "verified-user@users.noreply.github.com")).rejects.toThrow("RT_PUBLIC_HISTORY_AUTHOR_EMAIL_MISMATCH");
  const conduct = await repository("feat: establish the public alpha baseline", "Publish the verified source as one clean root commit.", "support@byteloft.app");
  await expect(checkPublicHistory(conduct, "support@byteloft.app")).rejects.toThrow("RT_PUBLIC_HISTORY_CONDUCT_EMAIL_FORBIDDEN");
});
