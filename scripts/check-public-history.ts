import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const canonicalRemote = "https://github.com/newExpand/better-realtime.git";
const publicTag = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const conventionalSubject = /^(?:feat|fix|refactor|chore|docs|test)(?:\([a-z0-9._/-]+\))?!?: [A-Za-z0-9]/u;

export interface PublicHistoryBaseline {
  rootCommit: string;
  tags: Array<{ name: string; object: string; target: string }>;
}

export interface PublicRemoteSnapshot {
  main: string;
  tags: Array<{ name: string; object: string; target: string }>;
}

export interface PublicHistoryReport {
  schemaVersion: "1.1";
  branch: "main";
  commitCount: number;
  appendedCommits: 0 | 1;
  rootCommit: string;
  baseCommit: string | null;
  headCommit: string;
  subject: string;
  body: string;
  authorEmail: string;
  remotes: 0 | 1;
  tags: number;
  unreachableObjects: 0;
  status: "valid";
}

export async function checkPublicHistory(
  directory: string,
  expectedAuthorEmail?: string,
  expectedRootCommit?: string,
  expectedBaseCommit?: string,
  options: { baseline?: PublicHistoryBaseline; remoteSnapshot?: PublicRemoteSnapshot } = {},
): Promise<PublicHistoryReport> {
  const cwd = resolve(directory);
  const git = async (args: string[]) => (await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  if (await git(["status", "--porcelain"])) throw new Error("RT_PUBLIC_HISTORY_DIRTY");
  const branch = await git(["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") throw new Error(`RT_PUBLIC_HISTORY_BRANCH_INVALID:${branch}`);
  if (!expectedAuthorEmail) throw new Error("RT_PUBLIC_HISTORY_AUTHOR_EMAIL_REQUIRED");
  if (!expectedRootCommit || !/^[0-9a-f]{40}$/u.test(expectedRootCommit)) throw new Error("RT_PUBLIC_HISTORY_ROOT_EXPECTATION_REQUIRED");
  if (expectedBaseCommit !== undefined && !/^[0-9a-f]{40}$/u.test(expectedBaseCommit)) throw new Error("RT_PUBLIC_HISTORY_BASE_EXPECTATION_INVALID");
  const baseline = options.baseline ?? await loadBaseline();
  if (expectedRootCommit !== baseline.rootCommit) throw new Error(`RT_PUBLIC_HISTORY_ROOT_EXPECTATION_MISMATCH:${expectedRootCommit}`);

  const localBranches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean);
  if (localBranches.length !== 1 || localBranches[0] !== "main") throw new Error(`RT_PUBLIC_HISTORY_BRANCH_SET_INVALID:${localBranches.join(",")}`);
  const roots = (await git(["rev-list", "--max-parents=0", "HEAD"])).split("\n").filter(Boolean);
  if (roots.length !== 1 || roots[0] !== expectedRootCommit) throw new Error(`RT_PUBLIC_HISTORY_ROOT_INVALID:${roots.join(",")}`);
  const headCommit = await git(["rev-parse", "HEAD"]);
  const commitCount = Number(await git(["rev-list", "--count", "HEAD"]));
  const merges = (await git(["rev-list", "--min-parents=2", "HEAD"])).split("\n").filter(Boolean);
  if (merges.length) throw new Error(`RT_PUBLIC_HISTORY_MERGE_COMMIT:${merges[0]}`);

  let appendedCommits: 0 | 1 = 0;
  if (expectedBaseCommit) {
    const appended = Number(await git(["rev-list", "--count", `${expectedBaseCommit}..HEAD`]));
    const headLine = (await git(["rev-list", "--parents", "-n", "1", "HEAD"])).split(/\s+/u);
    if (appended !== 1 || headLine.length !== 2 || headLine[1] !== expectedBaseCommit) throw new Error(`RT_PUBLIC_HISTORY_APPEND_INVALID:${appended}:${headLine.slice(1).join(",")}`);
    appendedCommits = 1;
  } else if (commitCount !== 1 || headCommit !== expectedRootCommit) {
    throw new Error(`RT_PUBLIC_HISTORY_INITIAL_ROOT_INVALID:${commitCount}:${headCommit}`);
  }

  const records = (await git(["log", "--format=%H%x1f%s%x1f%b%x1f%ae%x1e", "HEAD"]))
    .split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => record.split("\x1f"));
  if (records.length !== commitCount) throw new Error("RT_PUBLIC_HISTORY_LOG_INVALID");
  for (const [commit, subject, body, authorEmail] of records) {
    if (!subject || !conventionalSubject.test(subject)) throw new Error(`RT_PUBLIC_HISTORY_SUBJECT_INVALID:${commit}:${subject ?? ""}`);
    if (!body) throw new Error(`RT_PUBLIC_HISTORY_BODY_REQUIRED:${commit}`);
    if (/[^\x09\x0a\x0d\x20-\x7e]/u.test(`${subject}\n${body}`)) throw new Error(`RT_PUBLIC_HISTORY_MESSAGE_NON_ENGLISH:${commit}`);
    if (authorEmail?.toLocaleLowerCase("en-US") === "support@byteloft.app") throw new Error("RT_PUBLIC_HISTORY_CONDUCT_EMAIL_FORBIDDEN");
    if (authorEmail?.toLocaleLowerCase("en-US") !== expectedAuthorEmail.toLocaleLowerCase("en-US")) throw new Error(`RT_PUBLIC_HISTORY_AUTHOR_EMAIL_MISMATCH:${commit}:${authorEmail ?? ""}`);
  }

  const remotes = (await git(["remote"])).split("\n").filter(Boolean);
  if (remotes.length > 1 || remotes.some((remote) => remote !== "origin")) throw new Error(`RT_PUBLIC_HISTORY_REMOTE_SET_INVALID:${remotes.join(",")}`);
  if (remotes.length === 1) {
    const fetchUrls = (await git(["remote", "get-url", "--all", "origin"])).split("\n").filter(Boolean);
    const pushUrls = (await git(["remote", "get-url", "--push", "--all", "origin"])).split("\n").filter(Boolean);
    if (fetchUrls.length !== 1 || fetchUrls[0] !== canonicalRemote || pushUrls.length !== 1 || pushUrls[0] !== canonicalRemote) throw new Error(`RT_PUBLIC_HISTORY_REMOTE_INVALID:${fetchUrls.join(",")}:${pushUrls.join(",")}`);
  }

  const tags = (await git(["tag", "--list"])).split("\n").filter(Boolean);
  const baselineTags = [...baseline.tags].sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (tags.join("\n") !== baselineTags.map((tag) => tag.name).join("\n")) throw new Error(`RT_PUBLIC_HISTORY_TAG_SET_INVALID:${tags.join(",")}`);
  for (const tag of tags) {
    if (!publicTag.test(tag) || await git(["cat-file", "-t", `refs/tags/${tag}`]) !== "tag") throw new Error(`RT_PUBLIC_HISTORY_TAG_INVALID:${tag}`);
    const expectedTag = baselineTags.find((entry) => entry.name === tag)!;
    const object = await git(["rev-parse", `refs/tags/${tag}`]);
    const target = await git(["rev-parse", `refs/tags/${tag}^{commit}`]);
    if (object !== expectedTag.object || target !== expectedTag.target) throw new Error(`RT_PUBLIC_HISTORY_TAG_IDENTITY_INVALID:${tag}:${object}:${target}`);
    const ancestry = await exec("git", ["merge-base", "--is-ancestor", target, "HEAD"], { cwd }).catch(() => undefined);
    if (!ancestry) throw new Error(`RT_PUBLIC_HISTORY_TAG_TARGET_INVALID:${tag}:${target}`);
  }

  if (remotes.length === 1) {
    if (!expectedBaseCommit) throw new Error("RT_PUBLIC_HISTORY_REMOTE_BASE_REQUIRED");
    const remote = options.remoteSnapshot ?? await queryRemote(git);
    if (remote.main !== expectedBaseCommit) throw new Error(`RT_PUBLIC_HISTORY_REMOTE_MAIN_MISMATCH:${remote.main}:${expectedBaseCommit}`);
    const remoteTags = [...remote.tags].sort((left, right) => left.name.localeCompare(right.name, "en"));
    if (JSON.stringify(remoteTags) !== JSON.stringify(baselineTags)) throw new Error("RT_PUBLIC_HISTORY_REMOTE_TAG_IDENTITY_INVALID");
  }

  const localRefs = (await git(["for-each-ref", "--format=%(refname)%09%(objectname)%09%(objecttype)"]))
    .split("\n").filter(Boolean).map((line) => line.split("\t"));
  const allowedRefs = new Set(["refs/heads/main", ...baselineTags.map((tag) => `refs/tags/${tag.name}`)]);
  if (remotes.length === 1) {
    allowedRefs.add("refs/remotes/origin/HEAD");
    allowedRefs.add("refs/remotes/origin/main");
  }
  for (const [ref, object] of localRefs) {
    if (!ref || !allowedRefs.has(ref)) throw new Error(`RT_PUBLIC_HISTORY_REF_INVALID:${ref ?? ""}`);
    if ((ref === "refs/remotes/origin/HEAD" || ref === "refs/remotes/origin/main") && object !== expectedBaseCommit) throw new Error(`RT_PUBLIC_HISTORY_REMOTE_TRACKING_REF_INVALID:${ref}:${object ?? ""}`);
  }
  const commitsOutsideHead = (await git(["rev-list", "--all", "--not", "HEAD"])).split("\n").filter(Boolean);
  if (commitsOutsideHead.length) throw new Error(`RT_PUBLIC_HISTORY_REF_OUTSIDE_HEAD:${commitsOutsideHead[0]}`);
  const unreachable = (await git(["fsck", "--unreachable", "--no-reflogs"])).split("\n").filter(Boolean);
  if (unreachable.length) throw new Error(`RT_PUBLIC_HISTORY_UNREACHABLE_OBJECTS:${unreachable.length}`);
  const latest = records[0]!;
  return { schemaVersion: "1.1", branch: "main", commitCount, appendedCommits, rootCommit: expectedRootCommit, baseCommit: expectedBaseCommit ?? null, headCommit, subject: latest[1]!, body: latest[2]!, authorEmail: latest[3]!, remotes: remotes.length as 0 | 1, tags: tags.length, unreachableObjects: 0, status: "valid" };
}

async function loadBaseline(): Promise<PublicHistoryBaseline> {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "release", "public-history.json"), "utf8")) as Record<string, unknown>;
  const rootCommit = manifest.rootCommit;
  const tags = manifest.tags;
  if (manifest.schemaVersion !== "1.0" || manifest.repository !== "newExpand/better-realtime" || typeof rootCommit !== "string" || !/^[0-9a-f]{40}$/u.test(rootCommit) || !Array.isArray(tags) || tags.length === 0) throw new Error("RT_PUBLIC_HISTORY_BASELINE_INVALID");
  const parsedTags = tags.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("RT_PUBLIC_HISTORY_BASELINE_INVALID");
    const { name, object, target } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !publicTag.test(name) || typeof object !== "string" || !/^[0-9a-f]{40}$/u.test(object) || typeof target !== "string" || !/^[0-9a-f]{40}$/u.test(target)) throw new Error("RT_PUBLIC_HISTORY_BASELINE_INVALID");
    return { name, object, target };
  });
  if (new Set(parsedTags.map(({ name }) => name)).size !== parsedTags.length) throw new Error("RT_PUBLIC_HISTORY_BASELINE_INVALID");
  return { rootCommit, tags: parsedTags };
}

async function queryRemote(git: (args: string[]) => Promise<string>): Promise<PublicRemoteSnapshot> {
  const output = await git(["ls-remote", "--heads", "--tags", "origin"]).catch(() => { throw new Error("RT_PUBLIC_HISTORY_REMOTE_QUERY_FAILED"); });
  const refs = new Map(output.split("\n").filter(Boolean).map((line) => {
    const [object, ref] = line.split(/\s+/u);
    if (!object || !ref || !/^[0-9a-f]{40}$/u.test(object)) throw new Error("RT_PUBLIC_HISTORY_REMOTE_RESPONSE_INVALID");
    return [ref, object] as const;
  }));
  const allowed = new Set(["refs/heads/main"]);
  const tagNames = new Set<string>();
  for (const ref of refs.keys()) {
    const match = /^refs\/tags\/(.+?)(?:\^\{\})?$/u.exec(ref);
    if (match) { tagNames.add(match[1]!); allowed.add(ref); }
  }
  if ([...refs.keys()].some((ref) => !allowed.has(ref))) throw new Error("RT_PUBLIC_HISTORY_REMOTE_REF_SET_INVALID");
  const main = refs.get("refs/heads/main");
  if (!main) throw new Error("RT_PUBLIC_HISTORY_REMOTE_MAIN_MISSING");
  const tags = [...tagNames].map((name) => {
    const object = refs.get(`refs/tags/${name}`);
    const target = refs.get(`refs/tags/${name}^{}`);
    if (!object || !target) throw new Error(`RT_PUBLIC_HISTORY_REMOTE_TAG_NOT_ANNOTATED:${name}`);
    return { name, object, target };
  });
  return { main, tags };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await checkPublicHistory(process.argv[2] ?? process.cwd(), process.env.BETTER_REALTIME_PUBLIC_AUTHOR_EMAIL, process.env.BETTER_REALTIME_PUBLIC_ROOT_COMMIT, process.env.BETTER_REALTIME_PUBLIC_BASE_COMMIT))}\n`);
}
