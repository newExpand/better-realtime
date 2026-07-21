import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface PublicHistoryReport {
  schemaVersion: "1.0";
  branch: "main";
  commitCount: 1;
  rootCommit: string;
  subject: string;
  body: string;
  authorEmail: string;
  remotes: 0;
  tags: 0;
  unreachableObjects: 0;
  status: "valid";
}

export async function checkPublicHistory(directory: string, expectedAuthorEmail?: string): Promise<PublicHistoryReport> {
  const cwd = resolve(directory);
  const git = async (args: string[]) => (await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  if (await git(["status", "--porcelain"])) throw new Error("RT_PUBLIC_HISTORY_DIRTY");
  const branch = await git(["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") throw new Error(`RT_PUBLIC_HISTORY_BRANCH_INVALID:${branch}`);
  const commitCount = Number(await git(["rev-list", "--count", "--all"]));
  if (commitCount !== 1) throw new Error(`RT_PUBLIC_HISTORY_COMMIT_COUNT_INVALID:${commitCount}`);
  const rootLine = (await git(["rev-list", "--parents", "-n", "1", "HEAD"])).split(/\s+/u);
  if (rootLine.length !== 1 || !/^[0-9a-f]{40}$/u.test(rootLine[0]!)) throw new Error("RT_PUBLIC_HISTORY_ROOT_INVALID");
  const subject = await git(["log", "-1", "--format=%s"]);
  const body = await git(["log", "-1", "--format=%b"]);
  const authorEmail = await git(["log", "-1", "--format=%ae"]);
  if (!/^(?:feat|fix|refactor|chore|docs|test)(?:\([a-z0-9._/-]+\))?!?: [A-Za-z0-9]/u.test(subject)) throw new Error(`RT_PUBLIC_HISTORY_SUBJECT_INVALID:${subject}`);
  if (!body) throw new Error("RT_PUBLIC_HISTORY_BODY_REQUIRED");
  if (/[^\x09\x0a\x0d\x20-\x7e]/u.test(`${subject}\n${body}`)) throw new Error("RT_PUBLIC_HISTORY_MESSAGE_NON_ENGLISH");
  if (!expectedAuthorEmail) throw new Error("RT_PUBLIC_HISTORY_AUTHOR_EMAIL_REQUIRED");
  if (authorEmail.toLocaleLowerCase("en-US") === "support@byteloft.app") throw new Error("RT_PUBLIC_HISTORY_CONDUCT_EMAIL_FORBIDDEN");
  if (authorEmail.toLocaleLowerCase("en-US") !== expectedAuthorEmail.toLocaleLowerCase("en-US")) throw new Error(`RT_PUBLIC_HISTORY_AUTHOR_EMAIL_MISMATCH:${authorEmail}`);
  const remotes = (await git(["remote"])).split("\n").filter(Boolean);
  if (remotes.length) throw new Error(`RT_PUBLIC_HISTORY_REMOTE_PRESENT:${remotes.join(",")}`);
  const tags = (await git(["tag", "--list"])).split("\n").filter(Boolean);
  if (tags.length) throw new Error(`RT_PUBLIC_HISTORY_TAG_PRESENT:${tags.join(",")}`);
  const unreachable = (await git(["fsck", "--unreachable", "--no-reflogs"])).split("\n").filter(Boolean);
  if (unreachable.length) throw new Error(`RT_PUBLIC_HISTORY_UNREACHABLE_OBJECTS:${unreachable.length}`);
  return { schemaVersion: "1.0", branch: "main", commitCount: 1, rootCommit: rootLine[0]!, subject, body, authorEmail, remotes: 0, tags: 0, unreachableObjects: 0, status: "valid" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await checkPublicHistory(process.argv[2] ?? process.cwd(), process.env.BETTER_REALTIME_PUBLIC_AUTHOR_EMAIL))}\n`);
}
