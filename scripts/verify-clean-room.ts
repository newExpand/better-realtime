import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { packRuntime } from "./pack-runtime.ts";
import { importedNodeBuiltins, importedSpecifiers, packageContentIssues } from "./package-content-policy.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const sourceManifest = JSON.parse(await readFile(join(root, "packages/runtime/package.json"), "utf8")) as { name: string; version: string };
const artifactDirectory = await mkdtemp(join(tmpdir(), "realtime-clean-room-artifact-"));
const suppliedTarball = process.env.BETTER_REALTIME_TARBALL?.trim();
const packedArtifact = suppliedTarball
  ? await inspectPackedRuntime(resolve(suppliedTarball), artifactDirectory)
  : await packRuntime(artifactDirectory);
const tarball = packedArtifact.tarball;
const expectedManifest = { name: packedArtifact.package, version: packedArtifact.version };
const fixture = join(root, "fixtures/external-consumer");
const directory = await mkdtemp(join(tmpdir(), "realtime-clean-room-"));
const minimalDirectory = await mkdtemp(join(tmpdir(), "realtime-root-only-"));
const serverDirectory = await mkdtemp(join(tmpdir(), "realtime-server-types-"));
const candidateConsumerDirectory = await mkdtemp(join(tmpdir(), "realtime-candidate-consumer-"));

try {
  await cp(fixture, directory, { recursive: true });
  await exec("npm", ["install", "--ignore-scripts", tarball], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  await exec("npm", ["run", "typecheck"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  await exec("npm", ["run", "build"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  const browserOutput = (await Promise.all((await walk(join(directory, "dist"))).filter((path) => path.endsWith(".js")).map((path) => readFile(path, "utf8")))).join("\n");
  const rootNodeBuiltins = importedNodeBuiltins(browserOutput);
  const rootNodePackages = importedSpecifiers(browserOutput).filter((specifier) => ["pg", "ws", "@modelcontextprotocol/sdk"].some((name) => specifier === name || specifier.startsWith(`${name}/`)));
  if (rootNodeBuiltins.length || rootNodePackages.length) throw new Error(`RT_BROWSER_ROOT_NODE_DEPENDENCY:${[...rootNodeBuiltins, ...rootNodePackages].join(",")}`);
  const packedManifest = JSON.parse(await readFile(join(directory, "node_modules/better-realtime/package.json"), "utf8")) as {
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
  };
  const nodeOnlySubpaths = ["server", "diagnostics", ...(packedManifest.exports?.["./mcp"] ? ["mcp"] : [])];
  for (const subpath of nodeOnlySubpaths) {
    await writeFile(join(directory, "browser-boundary.ts"), `import 'better-realtime/${subpath}';\n`, "utf8");
    await writeFile(join(directory, "browser-boundary.vite.config.ts"), `import {defineConfig} from 'vite'; export default defineConfig({build:{outDir:'boundary-${subpath}',emptyOutDir:true,lib:{entry:'browser-boundary.ts',formats:['es'],fileName:()=> 'boundary.js'}}});\n`, "utf8");
    await exec("npx", ["vite", "build", "--config", "browser-boundary.vite.config.ts"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
    const browserBoundary = await readFile(join(directory, `boundary-${subpath}/boundary.js`), "utf8");
    const boundaryImports = importedSpecifiers(browserBoundary);
    if (!browserBoundary.includes("RT_SERVER_ENTRYPOINT_NODE_ONLY") || boundaryImports.length > 0) throw new Error(`RT_BROWSER_NODE_BOUNDARY_UNENFORCED:${subpath}:${boundaryImports.join(",")}:${browserBoundary.slice(0, 500)}`);
  }
  const run = await exec("npm", ["run", "run", "--silent"], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  const installed = join(directory, "node_modules/better-realtime");
  const files = await walk(installed);
  const forbidden = files.filter((path) => path.includes("/src/") || path.endsWith(".map") || path.includes("docs/internal") || path.endsWith("/AGENTS.md"));
  if (forbidden.length) throw new Error(`RT_CLEAN_ROOM_PRIVATE_PATH:${forbidden.join(",")}`);
  const textFiles = files.filter((path) => /\.(?:c?js|d\.ts|json)$/u.test(path));
  const text = (await Promise.all(textFiles.map((path) => readFile(path, "utf8")))).join("\n");
  const contentIssues = packageContentIssues(text, [root]);
  if (contentIssues.some((issue) => issue.code === "absolute_path")) throw new Error(`RT_CLEAN_ROOM_PRIVATE_PATH_CONTENT:${JSON.stringify(contentIssues)}`);
  if (/(?:\.\.\/)+(?:core|diagnostics|protocol|server-node|store-postgres|transport-reference)\/src\//u.test(text) || /\/\/#(?:region|endregion)\s+\.\.\//u.test(text)) throw new Error("RT_CLEAN_ROOM_WORKSPACE_SOURCE_PATH_CONTENT");
  if (contentIssues.some((issue) => issue.code === "secret")) throw new Error(`RT_CLEAN_ROOM_SECRET_CONTENT:${JSON.stringify(contentIssues)}`);
  const installedReadme = await readFile(join(installed, "README.md"), "utf8");
  const installedReadmeTargets = [...installedReadme.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]!);
  const nonPublicReadmeTargets = installedReadmeTargets.filter((target) => !/^(?:https:\/\/|#|mailto:)/u.test(target));
  if (nonPublicReadmeTargets.length) throw new Error(`RT_CLEAN_ROOM_PACKAGE_README_LINK:${nonPublicReadmeTargets.join(",")}`);
  const pinnedTag = `v${expectedManifest.version}`;
  for (const target of [
    `https://github.com/newExpand/better-realtime/blob/${pinnedTag}/docs/public/quickstart.md`,
    `https://github.com/newExpand/better-realtime/tree/${pinnedTag}/fixtures/external-consumer`,
    `https://raw.githubusercontent.com/newExpand/better-realtime/${pinnedTag}/docs/public/assets/recovery-demo.gif`
  ]) {
    if (!installedReadmeTargets.includes(target)) throw new Error(`RT_CLEAN_ROOM_PACKAGE_README_PINNED_LINK_MISSING:${target}`);
  }
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as { name: string; version: string; private?: boolean; dependencies?: Record<string, string> };
  if (installedManifest.name !== expectedManifest.name || installedManifest.version !== expectedManifest.version) throw new Error(`RT_CLEAN_ROOM_PACKAGE_IDENTITY:${installedManifest.name}@${installedManifest.version}`);
  if (installedManifest.private === true) throw new Error("RT_CLEAN_ROOM_PACKAGE_NOT_PUBLISHABLE");
  if (Object.keys(installedManifest.dependencies ?? {}).some((name) => name.startsWith("@realtime/"))) throw new Error("RT_CLEAN_ROOM_WORKSPACE_DEPENDENCY");
  const sourceFiles = (await walk(join(directory, "src"))).filter((path) => /\.[cm]?[jt]sx?$/u.test(path));
  const lines = (await Promise.all(sourceFiles.map((path) => readFile(path, "utf8")))).reduce((total, source) => total + source.split("\n").length, 0);
  await writeFile(join(minimalDirectory, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8");
  await exec("npm", ["install", "--ignore-scripts", "--omit=optional", tarball], { cwd: minimalDirectory, maxBuffer: 20 * 1024 * 1024 });
  await writeFile(join(minimalDirectory, "index.mjs"), "import {jsonSchema} from 'better-realtime'; const schema=jsonSchema('clean-room.value@1',{type:'string'}); if(schema.schema.type!=='string') throw new Error('root runtime failed');\n", "utf8");
  await writeFile(join(minimalDirectory, "index.ts"), "import {jsonSchema, type InferSchema} from 'better-realtime'; const schema=jsonSchema('clean-room.value@1',{type:'string'}); const value: InferSchema<typeof schema>='ready'; void value;\n", "utf8");
  await writeFile(join(minimalDirectory, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", skipLibCheck: false }, files: ["index.ts"] })}\n`, "utf8");
  await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.json"], { cwd: minimalDirectory, maxBuffer: 20 * 1024 * 1024 });
  await exec(process.execPath, ["index.mjs"], { cwd: minimalDirectory, maxBuffer: 20 * 1024 * 1024 });
  let minimalMcpBoundary: "base-bin-passed" | "companion-required";
  if (packedManifest.bin?.["better-realtime-mcp"]) {
    let minimalMcpGuard = false;
    try { await exec("npm", ["exec", "--", "better-realtime-mcp"], { cwd: minimalDirectory, env: { ...process.env, REALTIME_EVIDENCE_FILE: "", REALTIME_TENANT_ID: "" } }); }
    catch (error) { const failure = error as { code?: number; stdout?: string; stderr?: string }; minimalMcpGuard = failure.code === 1 && failure.stdout === "" && Boolean(failure.stderr && JSON.parse(failure.stderr).code === "RT_DIAGNOSTIC_SOURCE_REQUIRED"); }
    if (!minimalMcpGuard) throw new Error("RT_CLEAN_ROOM_MCP_BIN_INACTIVE");
    minimalMcpBoundary = "base-bin-passed";
  } else {
    await access(join(minimalDirectory, "node_modules/.bin/better-realtime-mcp")).then(() => { throw new Error("RT_CLEAN_ROOM_MCP_BIN_LEAKED"); }, () => undefined);
    minimalMcpBoundary = "companion-required";
  }

  await writeFile(join(serverDirectory, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8");
  await exec("npm", ["install", "--ignore-scripts", tarball, "pg@8.22.0", "ws@8.21.1"], { cwd: serverDirectory, maxBuffer: 20 * 1024 * 1024 });
  await writeFile(join(serverDirectory, "server.ts"), "import {postgres} from 'better-realtime/server'; const profile=postgres({connectionString:'postgres://example.invalid/database',identityKeys:[{version:1,key:'01234567890123456789012345678901'}]}); void profile;\n", "utf8");
  await writeFile(join(serverDirectory, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", skipLibCheck: false }, files: ["server.ts"] })}\n`, "utf8");
  await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.json"], { cwd: serverDirectory, maxBuffer: 20 * 1024 * 1024 });
  await writeFile(join(serverDirectory, "server.mjs"), "import {postgres} from 'better-realtime/server'; if(typeof postgres!=='function') throw new Error('server runtime import failed');\n", "utf8");
  await exec(process.execPath, ["server.mjs"], { cwd: serverDirectory, maxBuffer: 20 * 1024 * 1024 });
  let candidateConsumer: Record<string, unknown> | "not-applicable" = "not-applicable";
  if (packedArtifact.version.startsWith("0.2.")) {
    await cp(join(root, "fixtures/candidate-consumer"), candidateConsumerDirectory, { recursive: true });
    await exec("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
      tarball, "react@19.2.7", "pg@8.22.0", "ws@8.21.1", "@types/react@19.2.17", "typescript@7.0.2"
    ], { cwd: candidateConsumerDirectory, maxBuffer: 20 * 1024 * 1024 });
    await exec("npm", ["run", "typecheck"], { cwd: candidateConsumerDirectory, maxBuffer: 20 * 1024 * 1024 });
    const candidateSources = (await walk(join(candidateConsumerDirectory, "src"))).filter((path) => /\.[cm]?[jt]sx?$/u.test(path));
    const candidateText = (await Promise.all(candidateSources.map((path) => readFile(path, "utf8")))).join("\n");
    candidateConsumer = {
      typecheck: "passed",
      files: candidateSources.length,
      handwrittenNonblankLines: candidateText.split("\n").filter((line) => line.trim()).length,
      genericArguments: (candidateText.match(/\w+<[^>]+>/gu) ?? []).length,
      typeCasts: (candidateText.match(/\bas\s+(?!const\b)[A-Za-z_{]/gu) ?? []).length,
      paths: ["chat-db-generated-id", "notification-selector", "event-free-or-multi-stream-workflow"]
    };
  }
  let cliGuard = false;
  try { await exec("npm", ["exec", "--", "better-realtime"], { cwd: directory, env: { ...process.env, REALTIME_EVIDENCE_FILE: "", REALTIME_TENANT_ID: "" } }); }
  catch (error) { const failure = error as { code?: number; stdout?: string; stderr?: string }; cliGuard = failure.code === 1 && failure.stdout === "" && Boolean(failure.stderr && JSON.parse(failure.stderr).code === "RT_DIAGNOSTIC_SOURCE_REQUIRED"); }
  if (!cliGuard) throw new Error("RT_CLEAN_ROOM_CLI_BIN_INACTIVE");
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", cleanRoom: directory, packageIdentity: `${installedManifest.name}@${installedManifest.version}`, install: "tarball", tarball: { bytes: packedArtifact.size, unpackedBytes: packedArtifact.unpackedSize, files: packedArtifact.files }, typecheck: "passed", build: "passed", rootImportWithoutExplicitPeerArguments: "passed", minimalMcpBoundary, serverTypesWithRuntimePeers: "passed", candidateConsumer, cliBin: "passed", documentedBinInvocation: "npm_exec", publishable: true, packageReadmeLinks: "checksum_pinned_public_tag", browserRootNodeDependencyScan: "passed", browserNodeOnlyBoundaries: nodeOnlySubpaths, runtime: JSON.parse(run.stdout), installedFiles: files.length, sourceFiles: sourceFiles.length, sourceLines: lines, absolutePathPolicy: "passed", knownSecretPatternPolicy: "passed" })}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(minimalDirectory, { recursive: true, force: true });
  await rm(serverDirectory, { recursive: true, force: true });
  await rm(candidateConsumerDirectory, { recursive: true, force: true });
  await rm(artifactDirectory, { recursive: true, force: true });
}

async function walk(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

async function inspectPackedRuntime(tarball: string, inspectionDirectory: string): Promise<Awaited<ReturnType<typeof packRuntime>>> {
  const archive = await stat(tarball).catch(() => undefined);
  if (!archive?.isFile()) throw new Error(`RT_CLEAN_ROOM_TARBALL_MISSING:${tarball}`);
  const unpacked = join(inspectionDirectory, "unpacked");
  await mkdir(unpacked, { recursive: true });
  await exec("tar", ["-xzf", tarball, "-C", unpacked]);
  const packageDirectory = join(unpacked, "package");
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (manifest.name !== "better-realtime" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) throw new Error("RT_CLEAN_ROOM_TARBALL_MANIFEST_INVALID");
  if (manifest.version !== sourceManifest.version) {
    const publishedFixtures = {
      "0.1.0-alpha.1": { bytes: 127_197, sha256: "037aeab6cb79d891135026489f6e42595e231bf623b0032b4110472adf444d33" },
      "0.1.0-alpha.4": { bytes: 127_291, sha256: "803487cf32eca359ac85755b138119bf37c9e9afa476e55684971ed24057a6c2" }
    } as const;
    const expected = publishedFixtures[manifest.version as keyof typeof publishedFixtures];
    const exactFixture = join(root, `compatibility/fixtures/better-realtime-${manifest.version}.tgz`);
    const bytes = await readFile(tarball);
    if (!expected || resolve(tarball) !== exactFixture || bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error(`RT_CLEAN_ROOM_TARBALL_SOURCE_IDENTITY:${manifest.version}:${sourceManifest.version}`);
  }
  const expectedName = `${manifest.name}-${manifest.version}.tgz`;
  if (basename(tarball) !== expectedName) throw new Error(`RT_CLEAN_ROOM_TARBALL_IDENTITY:${basename(tarball)}:${expectedName}`);
  const files = await walk(packageDirectory);
  const unpackedSize = (await Promise.all(files.map((path) => stat(path)))).reduce((total, item) => total + item.size, 0);
  return {
    schemaVersion: "1.0",
    package: manifest.name,
    version: manifest.version,
    tarball,
    size: archive.size,
    unpackedSize,
    files: files.length
  };
}
