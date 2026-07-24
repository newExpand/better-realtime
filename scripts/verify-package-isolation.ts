import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertBrowserArtifactIsolation } from "./check-browser-artifact-isolation.ts";
import { packMcp } from "./pack-mcp.ts";
import { packRuntime } from "./pack-runtime.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const artifacts = await mkdtemp(join(tmpdir(), "better-realtime-isolation-artifacts-"));
const browserRoom = await mkdtemp(join(tmpdir(), "better-realtime-browser-install-"));
const serverRoom = await mkdtemp(join(tmpdir(), "better-realtime-server-install-"));
const mcpRoom = await mkdtemp(join(tmpdir(), "better-realtime-mcp-install-"));

try {
  const runtime = process.env.BETTER_REALTIME_TARBALL
    ? await exactArtifact(resolve(process.env.BETTER_REALTIME_TARBALL), "better-realtime")
    : await packRuntime(artifacts);
  const mcp = process.env.BETTER_REALTIME_MCP_TARBALL
    ? await exactArtifact(resolve(process.env.BETTER_REALTIME_MCP_TARBALL), "better-realtime-mcp")
    : await packMcp(artifacts);

  await writeFile(join(browserRoom, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8");
  await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", runtime.tarball, "react@19.2.7"], { cwd: browserRoom, maxBuffer: 20 * 1024 * 1024 });
  await assertAbsent(browserRoom, ["pg", "ws", "@types/pg", "@types/node", "pg-protocol", "pg-types", "@modelcontextprotocol/sdk", "@hono/node-server"]);
  const browserArtifact = await assertBrowserArtifactIsolation(join(browserRoom, "node_modules/better-realtime/dist"));
  await writeFile(join(browserRoom, "index.mjs"), "import {jsonSchema} from 'better-realtime'; import {createRealtimeReact} from 'better-realtime/react'; if(typeof jsonSchema!=='function'||typeof createRealtimeReact!=='function')throw new Error('RT_BROWSER_PACKAGE_IMPORT_FAILED');\n", "utf8");
  await exec(process.execPath, ["index.mjs"], { cwd: browserRoom });

  await writeFile(join(serverRoom, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8");
  await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", runtime.tarball, "pg@8.22.0", "ws@8.21.1"], { cwd: serverRoom, maxBuffer: 20 * 1024 * 1024 });
  await assertAbsent(serverRoom, ["@modelcontextprotocol/sdk", "@hono/node-server"]);
  await writeFile(join(serverRoom, "index.mjs"), "import {createRealtimeServer,postgres} from 'better-realtime/server'; if(typeof createRealtimeServer!=='function'||typeof postgres!=='function')throw new Error('RT_SERVER_PACKAGE_IMPORT_FAILED');\n", "utf8");
  await exec(process.execPath, ["index.mjs"], { cwd: serverRoom });
  await writeFile(join(serverRoom, "index.ts"), [
    "import { postgres, type RealtimePostgresDatabase } from 'better-realtime/server';",
    "declare const database: RealtimePostgresDatabase;",
    "const result = await database.query<{ id: string }>('select 1 as id');",
    "result.rows[0]?.id satisfies string | undefined;",
    "postgres({ connectionString: 'postgres://example.invalid/database', identityKeys: [{ version: 1, key: '01234567890123456789012345678901' }] });",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(serverRoom, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: false,
      types: []
    },
    include: ["index.ts"]
  }, null, 2)}\n`, "utf8");
  await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"], {
    cwd: serverRoom,
    maxBuffer: 20 * 1024 * 1024
  });

  await writeFile(join(mcpRoom, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8");
  await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", runtime.tarball, mcp.tarball], { cwd: mcpRoom, maxBuffer: 20 * 1024 * 1024 });
  await assertAbsent(mcpRoom, ["pg"]);
  await exec("npm", ["ls", "@modelcontextprotocol/sdk", "--all"], { cwd: mcpRoom });
  let guarded = false;
  try {
    await exec(join(mcpRoom, "node_modules/.bin/better-realtime-mcp"), [], {
      cwd: mcpRoom,
      env: { ...process.env, REALTIME_EVIDENCE_FILE: "", REALTIME_TENANT_ID: "" }
    });
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    guarded = failure.code === 1
      && failure.stdout === ""
      && Boolean(failure.stderr && JSON.parse(failure.stderr).code === "RT_DIAGNOSTIC_SOURCE_REQUIRED");
  }
  if (!guarded) throw new Error("RT_MCP_COMPANION_GUARD_FAILED");

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "1.0",
    runtime: { package: runtime.package, version: runtime.version, files: runtime.files },
    mcp: { package: mcp.package, version: mcp.version, files: mcp.files },
    browserInstall: "node-server-dependencies-absent",
    browserArtifact,
    serverInstall: "explicit-server-peers-passed",
    mcpInstall: "companion-boundary-passed"
  })}\n`);
} finally {
  await Promise.all([artifacts, browserRoom, serverRoom, mcpRoom].map((path) => rm(path, { recursive: true, force: true })));
}

async function assertAbsent(directory: string, packageNames: string[]): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, "node_modules/better-realtime/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const name of packageNames) {
    if (Object.hasOwn(manifest.dependencies ?? {}, name)) throw new Error(`RT_BROWSER_PACKAGE_DEPENDENCY_PRESENT:${name}`);
    try {
      await exec("npm", ["ls", name, "--all"], { cwd: directory });
      throw new Error(`RT_BROWSER_PACKAGE_DEPENDENCY_PRESENT:${name}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("RT_BROWSER_PACKAGE_DEPENDENCY_PRESENT")) throw error;
    }
  }
}

async function exactArtifact(tarball: string, expectedPackage: string): Promise<Awaited<ReturnType<typeof packRuntime>>> {
  const [archive, metadata] = await Promise.all([
    exec("tar", ["-tzf", tarball]),
    exec("tar", ["-xOzf", tarball, "package/package.json"]),
  ]);
  const manifest = JSON.parse(metadata.stdout) as { name?: unknown; version?: unknown };
  if (manifest.name !== expectedPackage || typeof manifest.version !== "string") throw new Error(`RT_PACKAGE_EXACT_ARTIFACT_IDENTITY_MISMATCH:${expectedPackage}`);
  const details = await stat(tarball);
  return {
    schemaVersion: "1.0",
    package: expectedPackage,
    version: manifest.version,
    tarball,
    size: details.size,
    unpackedSize: 0,
    files: archive.stdout.split("\n").filter((path) => path.startsWith("package/") && path !== "package/").length,
  };
}
