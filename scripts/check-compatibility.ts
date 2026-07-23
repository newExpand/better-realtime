import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Ajv2020 from "ajv/dist/2020.js";
import { acquireCompatibilityFixture } from "./acquire-compatibility-fixture.ts";
import { compareRuntimeSemantics } from "./compare-runtime-semantics.ts";
import { packRuntime } from "./pack-runtime.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const baselinePath = join(root, "compatibility/alpha.1-baseline.json");
const changesPath = join(root, "compatibility/changes.json");
const postgresMigrationsPath = join(root, "compatibility/postgres-migrations.json");
const apiConsumerPath = join(root, "compatibility/consumers/alpha1-api.ts");
const validateDiagnosticResult = new Ajv2020({ strict: false }).compile(JSON.parse(await readFile(join(root, "spec/diagnostics/v1/query-result.schema.json"), "utf8")));

type Classification = "compatible" | "deprecated" | "intentionally_breaking";
export interface Baseline {
  schemaVersion: "1.0";
  package: string;
  webSocketSubprotocol: string;
  protocolVersion: string;
  diagnosticSchemaVersion: string;
  postgresStorageVersion: number;
  sourceFingerprints: Record<string, string>;
  cliCommands: string[];
  mcpTools: string[];
  doctorVerdicts: string[];
  completenessStatuses: string[];
  postgresMigrations: Array<{ version: number; sourcePath: string; sourceSha256: string }>;
  postgresFixtures: Array<{ storageVersion: number; packagePath: string; packageSha256: string; modulePath: string; moduleSha256: string }>;
}
interface DeclaredChange {
  id: string;
  surface: string;
  path: string;
  classification: Classification;
  axis: "package" | "wire" | "postgres" | "diagnostics";
  baselineSha256: string;
  candidateSha256: string;
  minimumVersion: string;
  rationale: string;
  migrationGuide?: string;
  expectedTypeScriptDiagnostics?: Record<string, string[]>;
}
interface Changes { schemaVersion: "1.0"; baseline: string; candidateLine: string; changes: DeclaredChange[] }
interface PostgresMigrations {
  schemaVersion: "1.0";
  storage: string;
  fixtures: Array<{ storageVersion: number; packagePath: string; packageSha256: string; modulePath: string; moduleSha256: string }>;
  migrations: Array<{ version: number; fromVersions: number[]; deploymentTimeOnly: boolean; runtimeDdl: boolean; destructiveInPlace: boolean; sourcePath: string; sourceSha256: string }>;
}

const sourceSurfaces = {
  wireSchema: "spec/protocol/v1/wire.schema.json",
  stateMachines: "spec/protocol/v1/state-machines.json",
  conformanceScenarios: "conformance/v1/scenarios.json",
  diagnosticResultSchema: "spec/diagnostics/v1/query-result.schema.json",
  diagnosticTypes: "packages/runtime/src/diagnostic-types.ts",
  cli: "packages/runtime/src/cli.ts",
  mcp: "packages/runtime/src/mcp.ts",
  runtimeClient: "packages/runtime/src/index.ts",
  runtimeReact: "packages/runtime/src/react.ts",
  runtimeServer: "packages/runtime/src/server.ts",
  coreClient: "packages/core/src/client.ts",
  protocolRuntime: "packages/protocol/src/index.ts",
  protocolTypes: "packages/protocol/src/types.ts",
  protocolConstants: "packages/protocol/src/constants.ts",
  protocolValidator: "packages/protocol/src/validator.ts",
  protocolManifest: "packages/protocol/src/manifest.ts",
  protocolStateMachineRuntime: "packages/protocol/src/state-machines.ts",
  referenceServer: "packages/server-node/src/server.ts",
  postgresGateway: "packages/server-node/src/postgres-gateway.ts",
  postgresMigration: "packages/store-postgres/src/migrations.ts",
  postgresMigrationExecutor: "packages/store-postgres/src/index.ts",
  diagnosticQueryRuntime: "packages/diagnostics/src/query.ts"
} as const;

const installManifestFields = ["main", "types", "sideEffects", "engines", "bin", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"] as const;

export async function checkCompatibility(): Promise<Record<string, unknown>> {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
  const changes = JSON.parse(await readFile(changesPath, "utf8")) as Changes;
  const postgresMigrations = JSON.parse(await readFile(postgresMigrationsPath, "utf8")) as PostgresMigrations;
  assertControlFiles(baseline, changes);
  const candidatePostgresVersion = await assertPostgresMigrations(postgresMigrations, baseline);
  const fixture = await acquireCompatibilityFixture(false, false);
  const work = await mkdtemp(join(tmpdir(), "better-realtime-compat-"));
  const candidateArtifacts = join(work, "candidate-artifact");
  const candidate = await packRuntime(candidateArtifacts);
  const baselineDirectory = join(work, "baseline");
  const candidateDirectory = join(work, "candidate");
  try {
    await Promise.all([
      extract(fixture.path, baselineDirectory),
      extract(candidate.tarball, candidateDirectory)
    ]);
    const baselinePackage = join(baselineDirectory, "package");
    const candidatePackage = join(candidateDirectory, "package");
    const baselineManifest = JSON.parse(await readFile(join(baselinePackage, "package.json"), "utf8")) as PackageManifest;
    const candidateManifest = JSON.parse(await readFile(join(candidatePackage, "package.json"), "utf8")) as PackageManifest;
    assertPackageFixture(baselineManifest);
    const manifestChanges = compareInstallManifest(baselineManifest, candidateManifest);
    for (const change of manifestChanges) requireDeclaredChange(changes, change);
    const exportChanges = compareExports(baselineManifest.exports, candidateManifest.exports);
    for (const change of exportChanges) requireDeclaredChange(changes, change);

    const declarationChanges = await compareDeclarationFiles(baselinePackage, candidatePackage);
    for (const change of declarationChanges) requireDeclaredChange(changes, change);

    const runtimeJavaScriptChanges = await compareRuntimeJavaScript(baselinePackage, candidatePackage);
    for (const change of runtimeJavaScriptChanges) requireDeclaredChange(changes, change);
    const sourceChanges: SurfaceChange[] = [];
    for (const [surface, path] of Object.entries(sourceSurfaces)) {
      const candidateSha256 = await hashFile(join(root, path));
      const baselineSha256 = baseline.sourceFingerprints[surface];
      if (!baselineSha256) throw new Error(`RT_COMPAT_BASELINE_SURFACE_MISSING:${surface}`);
      if (candidateSha256 !== baselineSha256) sourceChanges.push({ surface, path, baselineSha256, candidateSha256 });
    }
    for (const change of sourceChanges) requireDeclaredChange(changes, change);
    const runtimeSemantics = await compareRuntimeSemantics(baselinePackage, candidatePackage) as { change?: SurfaceChange; [key: string]: unknown };
    const semanticChanges = runtimeSemantics.change ? [runtimeSemantics.change] : [];
    for (const change of semanticChanges) requireDeclaredChange(changes, change);
    const baseDetectedChanges = [...manifestChanges, ...exportChanges, ...declarationChanges, ...runtimeJavaScriptChanges, ...sourceChanges, ...semanticChanges];
    const candidateProtocol = await candidateProtocolIdentity(candidatePackage);

    const [baselineInstall, candidateInstall] = await Promise.all([
      compileConsumer(fixture.path, join(work, "consumer-baseline")),
      compileConsumer(candidate.tarball, join(work, "consumer-candidate"))
    ]);
    assertConsumerResult("baseline", baselineInstall.results, false, changes);
    assertConsumerResult("candidate", candidateInstall.results, true, changes);
    const typescriptShapeExclusions: string[] = [];
    const declarationApiChanges = await compareTypeScriptApiCompatibility(baselineInstall.packageDirectory, candidateInstall.packageDirectory, baselineManifest.exports, candidateManifest.exports, work, typescriptShapeExclusions);
    for (const change of declarationApiChanges) requireDeclaredChange(changes, change);
    const diagnosticResults = await compareDiagnostics(baselineInstall.packageDirectory, candidateInstall.packageDirectory, baseline);
    const mcpResults = await compareMcp(baselineInstall.room, candidateInstall.room, baseline);
    const dynamicChanges = [diagnosticResults.change, mcpResults.change].filter((change): change is SurfaceChange => Boolean(change));
    for (const change of dynamicChanges) requireDeclaredChange(changes, change);
    const detectedChanges = [...baseDetectedChanges, ...declarationApiChanges, ...dynamicChanges];
    assertVersionBoundaries(changes, detectedChanges, candidateManifest.version, baseline, candidatePostgresVersion, candidateProtocol);
    const undeclared = changes.changes.filter((change) => !detectedChanges.some((detected) => sameChange(detected, change)));
    if (undeclared.length) throw new Error(`RT_COMPAT_STALE_CHANGE_DECLARATION:${undeclared.map((change) => change.id).join(",")}`);

    return {
      schemaVersion: "1.0",
      baseline: baseline.package,
      fixture: { bytes: fixture.bytes, sha256: fixture.sha256, checksumPinned: true, preservationBaseline: true, githubReleaseImmutable: false },
      candidate: `${candidateManifest.name}@${candidateManifest.version}`,
      detectedChanges: detectedChanges.map((change) => ({ ...change, declaration: declarationFor(changes, change)?.classification })),
      classifications: counts(changes.changes),
      packageExports: summarizeSurface(exportChanges, changes),
      installManifest: manifestChanges.length ? "declared-change" : "identical",
      declarations: declarationChanges.length || declarationApiChanges.length ? "declared-change" : "identical",
      typescriptShapeExclusions,
      apiConsumer: { alpha1: baselineInstall.results, candidate: candidateInstall.results },
      runtimeSemantics,
      cli: diagnosticResults.cli,
      mcp: { tools: baseline.mcpTools, baseline: mcpResults.baseline, candidate: mcpResults.candidate },
      protocol: { subprotocol: candidateProtocol.subprotocol, version: candidateProtocol.version, changes: countsByAxis(changes.changes).wire },
      diagnostics: diagnosticResults.doctor,
      postgres: { storageVersion: candidatePostgresVersion, schemaSource: sourceChanges.some((change) => ["postgresMigration", "postgresMigrationExecutor"].includes(change.surface)) ? "declared-change" : "identical" }
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface PackageManifest {
  name?: string;
  version?: string;
  main?: string;
  types?: string;
  sideEffects?: unknown;
  engines?: Record<string, string>;
  exports?: Record<string, unknown>;
  bin?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface SurfaceChange { surface: string; path: string; baselineSha256: string; candidateSha256: string; requiredClassification?: Classification }

function assertControlFiles(baseline: Baseline, changes: Changes): void {
  if (baseline.schemaVersion !== "1.0" || baseline.package !== "better-realtime@0.1.0-alpha.1" || baseline.webSocketSubprotocol !== "better-realtime.v1" || baseline.protocolVersion !== "1.0" || baseline.diagnosticSchemaVersion !== "1.0" || baseline.postgresStorageVersion !== 1 || baseline.postgresMigrations.length !== 1 || baseline.postgresFixtures.length !== 1) throw new Error("RT_COMPAT_BASELINE_INVALID");
  if (changes.schemaVersion !== "1.0" || changes.baseline !== baseline.package || changes.candidateLine !== "0.1.x-alpha" || !Array.isArray(changes.changes)) throw new Error("RT_COMPAT_CHANGE_LEDGER_INVALID");
  const ids = new Set<string>();
  assertUniqueChangeDeclarations(changes.changes);
  for (const change of changes.changes) {
    if (!change.id || ids.has(change.id) || !["compatible", "deprecated", "intentionally_breaking"].includes(change.classification) || !["package", "wire", "postgres", "diagnostics"].includes(change.axis) || !/^[a-f0-9]{64}$/u.test(change.baselineSha256) || !/^[a-f0-9]{64}$/u.test(change.candidateSha256) || change.rationale.length < 12) throw new Error(`RT_COMPAT_CHANGE_LEDGER_INVALID:${change.id}`);
    if (change.classification === "intentionally_breaking" && !change.migrationGuide) throw new Error(`RT_COMPAT_MIGRATION_GUIDE_REQUIRED:${change.id}`);
    if (change.expectedTypeScriptDiagnostics !== undefined && (change.classification !== "intentionally_breaking" || change.axis !== "package" || Object.keys(change.expectedTypeScriptDiagnostics).length === 0 || Object.entries(change.expectedTypeScriptDiagnostics).some(([matrix, codes]) => !["react18", "react19"].includes(matrix) || codes.length === 0 || codes.some((code) => !/^TS\d{4}$/u.test(code))))) throw new Error(`RT_COMPAT_EXPECTED_TYPESCRIPT_DIAGNOSTIC_INVALID:${change.id}`);
    ids.add(change.id);
  }
}

export function assertUniqueChangeDeclarations(entries: Array<Pick<DeclaredChange, "id" | "surface" | "path" | "baselineSha256" | "candidateSha256">>): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = canonical([entry.surface, entry.path, entry.baselineSha256, entry.candidateSha256]);
    if (keys.has(key)) throw new Error(`RT_COMPAT_DUPLICATE_CHANGE_DECLARATION:${entry.id}`);
    keys.add(key);
  }
}

function assertPackageFixture(manifest: PackageManifest): void {
  if (manifest.name !== "better-realtime" || manifest.version !== "0.1.0-alpha.1") throw new Error(`RT_COMPAT_FIXTURE_PACKAGE_IDENTITY:${manifest.name}@${manifest.version}`);
  const bins = manifest.bin ?? {};
  if (bins["better-realtime"]?.replace(/^\.\//u, "") !== "dist/cli-bin.js" || bins["better-realtime-mcp"]?.replace(/^\.\//u, "") !== "dist/mcp-stdio.js") throw new Error("RT_COMPAT_FIXTURE_BIN_DRIFT");
}

export function compareExports(baseline: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  for (const [path, baselineValue] of Object.entries(baseline)) {
    const candidateValue = candidate[path];
    const missingCondition = candidateValue !== undefined && typeof baselineValue === "object" && baselineValue !== null && typeof candidateValue === "object" && candidateValue !== null
      ? Object.keys(baselineValue).some((condition) => !(condition in candidateValue))
      : false;
    if (candidateValue === undefined || canonical(candidateValue) !== canonical(baselineValue)) changes.push({ ...surfaceChange("packageExports", path, baselineValue, candidateValue), ...(candidateValue === undefined || missingCondition ? { requiredClassification: "intentionally_breaking" as const } : {}) });
  }
  for (const [path, candidateValue] of Object.entries(candidate)) if (!(path in baseline)) changes.push(surfaceChange("packageExports", path, undefined, candidateValue));
  return changes;
}

function compareInstallManifest(baseline: PackageManifest, candidate: PackageManifest): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  for (const field of installManifestFields) {
    if (canonical(baseline[field]) !== canonical(candidate[field])) changes.push(surfaceChange("packageManifest", field, baseline[field], candidate[field]));
  }
  return changes;
}

async function compareDeclarationFiles(baselinePackage: string, candidatePackage: string): Promise<SurfaceChange[]> {
  const baselineFiles = (await walk(join(baselinePackage, "dist"))).filter((path) => path.endsWith(".d.ts"));
  const candidateFiles = (await walk(join(candidatePackage, "dist"))).filter((path) => path.endsWith(".d.ts"));
  const names = new Set([...baselineFiles.map((path) => relative(join(baselinePackage, "dist"), path)), ...candidateFiles.map((path) => relative(join(candidatePackage, "dist"), path))]);
  const changes: SurfaceChange[] = [];
  for (const name of [...names].sort()) {
    const baselineSha256 = await hashFile(join(baselinePackage, "dist", name)).catch(() => hash(undefined));
    const candidateSha256 = await hashFile(join(candidatePackage, "dist", name)).catch(() => hash(undefined));
    if (baselineSha256 !== candidateSha256) changes.push({ surface: "typescriptDeclarations", path: `dist/${name}`, baselineSha256, candidateSha256 });
  }
  return changes;
}

export async function compareTypeScriptApiCompatibility(baselinePackage: string, candidatePackage: string, baselineExports: Record<string, unknown> = {}, candidateExports: Record<string, unknown> = {}, work: string, shapeExclusions: string[] = []): Promise<SurfaceChange[]> {
  const actualEntries = Object.entries(baselineExports).flatMap(([subpath, value]) => {
    const baselineTarget = declarationTarget(value);
    const candidateTarget = declarationTarget(candidateExports[subpath]);
    return baselineTarget ? [{ subpath, baselinePath: join(baselinePackage, baselineTarget), candidatePath: candidateTarget ? join(candidatePackage, candidateTarget) : undefined }] : [];
  });
  const candidateVersion = await assertCandidateReleaseIdentity(candidatePackage);
  const baselineManifest = JSON.parse(await readFile(join(baselinePackage, "package.json"), "utf8")) as { version?: unknown };
  if (typeof baselineManifest.version !== "string") throw new Error("RT_COMPAT_BASELINE_VERSION_MISSING");
  const restoreCandidateReleaseIdentity = await normalizeCandidateReleaseIdentityDeclarations(candidatePackage, candidateVersion, baselineManifest.version);
  const entries = actualEntries;
  const declarations = await Promise.all(entries.map(async (entry) => ({ ...entry, source: await readFile(entry.baselinePath, "utf8") })));
  const allBaselineDeclarations = (await Promise.all((await walk(join(baselinePackage, "dist"))).filter((path) => path.endsWith(".d.ts")).map((path) => readFile(path, "utf8")))).join("\n");
  const rootEntry = entries.find((entry) => entry.subpath === ".") ?? entries[0];
  if (!rootEntry?.candidatePath) throw new Error("RT_COMPAT_TYPESCRIPT_ROOT_EXPORT_MISSING");
  const witnessPrelude = genericWitnessPrelude(rootEntry.baselinePath.replace(/\.d\.ts$/u, ".js"));
  const concreteArguments = await supportedGenericWitnesses(entries, declarations, allBaselineDeclarations, witnessPrelude, work);
  const shapeSupport = await supportedShapeComparisons(entries, declarations, allBaselineDeclarations, witnessPrelude, concreteArguments, work);
  const supportedShapes = shapeSupport.supported;
  shapeExclusions.push(...shapeSupport.excluded.map((key) => `${key}:baseline-self-probe:TS2589`));
  if ("./diagnostics" in baselineExports) for (const required of ["./diagnostics:DoctorQueryDefinition:0", "./diagnostics:DiagnosticQueryRequest:0"]) if (!supportedShapes.has(required)) throw new Error(`RT_COMPAT_REQUIRED_PUBLIC_SHAPE_UNSUPPORTED:${required}`);
  const shapeUtilities = publicShapeUtilityPrelude();
  const candidateShapeLineKeys: Record<string, string> = {};
  const lines = [
    "type Assert<T extends true> = T;",
    "type Exact<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? (<T>() => T extends Y ? 1 : 2) extends (<T>() => T extends X ? 1 : 2) ? true : false : false;",
    ...shapeUtilities,
    ...witnessPrelude
  ];
  for (const entry of entries) {
    if (!entry.candidatePath) continue;
    const baselineSpecifier = entry.baselinePath.replace(/\.d\.ts$/u, ".js");
    const candidateSpecifier = entry.candidatePath.replace(/\.d\.ts$/u, ".js");
    const suffix = hash(entry.subpath).slice(0, 8);
    lines.push(`declare const candidateValues_${suffix}: Omit<typeof import(${JSON.stringify(candidateSpecifier)}), "BETTER_REALTIME_VERSION">;`);
    lines.push(`const baselineValues_${suffix}: Omit<typeof import(${JSON.stringify(baselineSpecifier)}), "BETTER_REALTIME_VERSION"> = candidateValues_${suffix};`);
    const source = declarations.find((value) => value.subpath === entry.subpath)!.source;
    if (entry.subpath === "." && /\bBETTER_REALTIME_VERSION\b/u.test(source)) {
      lines.push(`type CandidateVersionExport_${suffix} = typeof import(${JSON.stringify(candidateSpecifier)}).BETTER_REALTIME_VERSION;`);
      lines.push(`type CandidateVersionExact_${suffix} = Assert<Exact<CandidateVersionExport_${suffix}, ${JSON.stringify(baselineManifest.version)}>>;`);
    }
    for (const exported of exportedTypeNames(source)) {
      const arity = exportedTypeArity(allBaselineDeclarations, exported.original);
      const safe = `${suffix}_${exported.publicName.replaceAll(/[^A-Za-z0-9_$]/gu, "_")}`;
      const argumentSets = arity ? [Array.from({ length: arity }, () => "any"), ...(concreteArguments.get(`${entry.subpath}:${exported.publicName}`) ?? [])] : [[]];
      for (const [index, argumentsSet] of argumentSets.entries()) {
        const argumentsList = argumentsSet.length ? `<${argumentsSet.join(",")}>` : "";
        lines.push(`type Baseline_${safe}_${index} = import(${JSON.stringify(baselineSpecifier)}).${exported.publicName}${argumentsList};`);
        lines.push(`type Candidate_${safe}_${index} = import(${JSON.stringify(candidateSpecifier)}).${exported.publicName}${argumentsList};`);
        if (supportedShapes.has(`${entry.subpath}:${exported.publicName}:${index}`)) {
          const shapeLine = `type PreservedShape_${safe}_${index} = Assert<PreservesPublicShape<Baseline_${safe}_${index}, Candidate_${safe}_${index}>>;`;
          lines.push(shapeLine);
          candidateShapeLineKeys[shapeLine] = `${entry.subpath}:${exported.publicName}:${index}`;
        }
        const comparison = exported.publicName === "DeepReadonly"
          ? `Exact<Candidate_${safe}_${index}, Baseline_${safe}_${index}>`
          : `Candidate_${safe}_${index} extends Baseline_${safe}_${index} ? Baseline_${safe}_${index} extends Candidate_${safe}_${index} ? true : false : false`;
        lines.push(`type Compatible_${safe}_${index} = Assert<${comparison}>;`);
      }
    }
  }
  const checkPath = join(work, "typescript-api-compatibility.ts");
  let checkLines = [...lines];
  let compileError: unknown;
  while (true) {
    await writeFile(checkPath, `${checkLines.join("\n")}\n`, "utf8");
    compileError = undefined;
    try { await runTypeScriptCheck(checkPath, work); }
    catch (error) { compileError = error; }
    if (!compileError) break;
    const candidateRecursion = candidateShapeRecursionExclusions(typescriptOutput(compileError), checkLines, candidateShapeLineKeys);
    const deepLines = candidateRecursion.lines;
    if (!deepLines.length || !deepLines.every((line) => checkLines[line - 1]?.startsWith("type PreservedShape_"))) break;
    for (const key of candidateRecursion.excluded) {
      const exclusion = `${key}:candidate-comparison:TS2589`;
      if (!shapeExclusions.includes(exclusion)) shapeExclusions.push(exclusion);
    }
    const omitted = new Set(deepLines);
    checkLines = checkLines.filter((_line, index) => !omitted.has(index + 1));
  }
  if (compileError) {
    const diagnostics = typescriptDiagnostics(compileError);
    if (!diagnostics.length) throw new Error(`RT_COMPAT_TYPESCRIPT_API_CHECK_FAILED:${boundedError(compileError)}`);
    const baselineSha256 = await declarationTreeHash(baselinePackage);
    await restoreCandidateReleaseIdentity();
    const candidateSha256 = await declarationTreeHash(candidatePackage);
    if (baselineSha256 === candidateSha256) throw new Error(`RT_COMPAT_TYPESCRIPT_API_SELF_DRIFT:${typescriptOutput(compileError).replaceAll(/\s+/gu, " ").slice(0, 2000)}`);
    return [{ surface: "typescriptApiCompatibility", path: "all-alpha1-named-exports-and-assignability", baselineSha256, candidateSha256, requiredClassification: "intentionally_breaking" }];
  }
  await restoreCandidateReleaseIdentity();
  await assertCandidateRuntimeReleaseIdentity(candidatePackage);
  return compareRuntimeExportConditions(baselinePackage, candidatePackage, baselineExports, candidateExports);
}

async function normalizeCandidateReleaseIdentityDeclarations(candidatePackage: string, candidateVersion: string, baselineVersion: string): Promise<() => Promise<void>> {
  if (candidateVersion === baselineVersion) return async () => {};
  const manifestPath = join(candidatePackage, "package.json");
  const manifestSource = await readFile(manifestPath, "utf8");
  const declarations = await Promise.all((await walk(join(candidatePackage, "dist"))).filter((entry) => entry.endsWith(".d.ts")).map(async (path) => ({ path, source: await readFile(path, "utf8") })));
  const normalizedManifest = { ...(JSON.parse(manifestSource) as Record<string, unknown>), version: baselineVersion };
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(normalizedManifest, null, 2)}\n`, "utf8"),
    ...declarations.map(({ path, source }) => writeFile(path, /BETTER_REALTIME_VERSION\s*:/u.test(source) ? source.replaceAll(JSON.stringify(candidateVersion), JSON.stringify(baselineVersion)) : source, "utf8")),
  ]);
  return async () => { await Promise.all([writeFile(manifestPath, manifestSource, "utf8"), ...declarations.map(({ path, source }) => writeFile(path, source, "utf8"))]); };
}

function publicShapeUtilityPrelude(): string[] {
  return [
    "type AllTrue<T> = Exclude<T, true> extends never ? true : false;",
    "type CandidateBranchPreserves<B, C, D extends 1[]> = C extends unknown ? B extends C ? C extends B ? PreservesPublicBranch<B, C, D> : never : never : never;",
    "type PreservesPublicShape<B, C, D extends 1[] = []> = AllTrue<NonNullable<B> extends infer BB ? BB extends unknown ? true extends CandidateBranchPreserves<BB, NonNullable<C>, D> ? true : false : never : never>;",
    "type PreservesPublicBranch<B, C, D extends 1[]> = D['length'] extends 8 ? true : B extends (...args: any[]) => any ? true : B extends readonly (infer BE)[] ? C extends readonly (infer CE)[] ? PreservesPublicShape<BE, CE, [1, ...D]> : false : B extends object ? C extends object ? Exclude<keyof B, keyof C> extends never ? AllTrue<{ [K in keyof B & keyof C]-?: PreservesPublicShape<B[K], C[K], [1, ...D]> }[keyof B & keyof C]> : false : false : true;"
  ];
}

async function supportedShapeComparisons(
  entries: Array<{ subpath: string; baselinePath: string; candidatePath: string | undefined }>,
  declarations: Array<{ subpath: string; baselinePath: string; candidatePath: string | undefined; source: string }>,
  allBaselineDeclarations: string,
  witnessPrelude: string[],
  concreteArguments: Map<string, string[][]>,
  work: string
): Promise<{ supported: Set<string>; excluded: string[] }> {
  const lines = ["type Assert<T extends true> = T;", ...publicShapeUtilityPrelude(), ...witnessPrelude];
  const probes = new Map<number, string>();
  for (const entry of entries) {
    const baselineSpecifier = entry.baselinePath.replace(/\.d\.ts$/u, ".js");
    const source = declarations.find((value) => value.subpath === entry.subpath)!.source;
    const suffix = hash(entry.subpath).slice(0, 8);
    for (const exported of exportedTypeNames(source)) {
      const arity = exportedTypeArity(allBaselineDeclarations, exported.original);
      const argumentSets = arity ? [Array.from({ length: arity }, () => "any"), ...(concreteArguments.get(`${entry.subpath}:${exported.publicName}`) ?? [])] : [[]];
      for (const [index, argumentsSet] of argumentSets.entries()) {
        const argumentsList = argumentsSet.length ? `<${argumentsSet.join(",")}>` : "";
        const safe = `${suffix}_${exported.publicName.replaceAll(/[^A-Za-z0-9_$]/gu, "_")}_${index}`;
        lines.push(`type ShapeBaseline_${safe} = import(${JSON.stringify(baselineSpecifier)}).${exported.publicName}${argumentsList};`);
        lines.push(`type ShapeProbe_${safe} = Assert<PreservesPublicShape<ShapeBaseline_${safe}, ShapeBaseline_${safe}>>;`);
        probes.set(lines.length, `${entry.subpath}:${exported.publicName}:${index}`);
      }
    }
  }
  const probePath = join(work, "typescript-api-shape-probes.ts");
  await writeFile(probePath, `${lines.join("\n")}\n`, "utf8");
  const invalidLines = new Set<number>();
  try { await runTypeScriptCheck(probePath, work); }
  catch (error) {
    for (const line of shapeProbeRecursionLines(typescriptOutput(error))) invalidLines.add(line);
  }
  return {
    supported: new Set([...probes].flatMap(([line, key]) => invalidLines.has(line) ? [] : [key])),
    excluded: [...probes].flatMap(([line, key]) => invalidLines.has(line) ? [key] : [])
  };
}

export function shapeProbeRecursionLines(output: string): number[] {
  const diagnostics = [...output.matchAll(/typescript-api-shape-probes\.ts\((\d+),\d+\): error (TS\d+)/gu)].map((match) => ({ line: Number(match[1]), code: match[2] }));
  if (!diagnostics.length || diagnostics.some(({ code }) => code !== "TS2589")) throw new Error(`RT_COMPAT_TYPESCRIPT_SHAPE_PROBE_FAILED:${output.replaceAll(/\s+/gu, " ").slice(0, 2000)}`);
  return [...new Set(diagnostics.map(({ line }) => line))];
}

export function candidateShapeRecursionExclusions(output: string, checkLines: readonly string[], shapeLineKeys: Readonly<Record<string, string>>): { lines: number[]; excluded: string[] } {
  const lines = [...new Set([...output.matchAll(/typescript-api-compatibility\.ts\((\d+),\d+\): error TS2589/gu)].map((match) => Number(match[1])))];
  const excluded = lines.flatMap((line) => {
    const key = shapeLineKeys[checkLines[line - 1] ?? ""];
    return key ? [key] : [];
  });
  if (excluded.length !== lines.length) return { lines: [], excluded: [] };
  return { lines, excluded };
}

interface RuntimeExportConditionSnapshot { target: string; status: "loaded" | "throws" | "non-runtime" | "invalid"; category?: "types" | "json"; namespace?: Record<string, string>; error?: string }

export async function compareRuntimeExportConditions(baselinePackage: string, candidatePackage: string, baselineExports: Record<string, unknown>, candidateExports: Record<string, unknown>): Promise<SurfaceChange[]> {
  const baseline = await runtimeExportConditionSnapshot(baselinePackage, baselineExports, true);
  const candidate = await runtimeExportConditionSnapshot(candidatePackage, candidateExports, false);
  const candidateTypeSurfaceError = await candidatePackageTypeSurfaceError(candidatePackage, candidateExports);
  if (candidateTypeSurfaceError) candidate["<package>:types-resolution"] = { target: "<package-specifiers>", status: "invalid", error: candidateTypeSurfaceError };
  let incompatible = Object.values(candidate).some((condition) => condition.status === "invalid");
  for (const [key, baselineCondition] of Object.entries(baseline)) {
    const candidateCondition = candidate[key];
    if (!candidateCondition || candidateCondition.status === "invalid") { incompatible = true; continue; }
    if (baselineCondition.status === "loaded") {
      if (candidateCondition.status !== "loaded") { incompatible = true; continue; }
      for (const [exported, kind] of Object.entries(baselineCondition.namespace ?? {})) if (candidateCondition.namespace?.[exported] !== kind) incompatible = true;
    } else if (baselineCondition.status === "throws" && (candidateCondition.status !== "throws" || candidateCondition.error !== baselineCondition.error)) incompatible = true;
    else if (baselineCondition.status === "non-runtime") {
      if (candidateCondition.status !== "non-runtime" || candidateCondition.category !== baselineCondition.category) { incompatible = true; continue; }
      if (baselineCondition.category === "json") for (const [field, kind] of Object.entries(baselineCondition.namespace ?? {})) if (candidateCondition.namespace?.[field] !== kind) incompatible = true;
    }
  }
  return incompatible ? [{ surface: "runtimeExportCompatibility", path: "all-alpha1-subpaths-and-conditions", baselineSha256: hash(baseline), candidateSha256: hash(candidate), requiredClassification: "intentionally_breaking" }] : [];
}

async function candidatePackageTypeSurfaceError(packageDirectory: string, exportsMap: Record<string, unknown>): Promise<string | undefined> {
  const runtimeSubpaths: string[] = [];
  for (const [subpath, value] of Object.entries(exportsMap)) {
    if (subpath === "./package.json") continue;
    const conditions = typeof value === "object" && value !== null ? Object.keys(value) : [];
    const runtimeConditions = conditions.filter((condition) => condition !== "types");
    const hasRuntime = typeof value === "string" ? !value.endsWith(".json") && !/\.d\.(?:ts|mts|cts)$/u.test(value) : runtimeConditions.length > 0;
    if (!hasRuntime) continue;
    const types = declarationTarget(value);
    if (!types) return `runtime-subpath-missing-types-condition:${subpath}`;
    if (conditions.indexOf("types") > Math.min(...runtimeConditions.map((condition) => conditions.indexOf(condition)))) return `types-condition-must-precede-runtime-conditions:${subpath}`;
    runtimeSubpaths.push(subpath);
  }
  if (!runtimeSubpaths.length) return undefined;

  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest & { type?: string };
  if (!manifest.name) return "package-name-missing";
  const installedRoot = resolve(packageDirectory, "../..");
  const installedPath = resolve(installedRoot, "node_modules", manifest.name);
  const canUseInstalledPackage = installedPath === resolve(packageDirectory) && canonical(manifest.exports) === canonical(exportsMap);
  const room = canUseInstalledPackage ? await mkdtemp(join(installedRoot, "compatibility-package-types-")) : await mkdtemp(join(tmpdir(), "compatibility-package-types-"));
  try {
    if (!canUseInstalledPackage) {
      const stagedPackage = join(room, "node_modules", manifest.name);
      await mkdir(resolve(stagedPackage, ".."), { recursive: true });
      await cp(packageDirectory, stagedPackage, { recursive: true });
      await writeFile(join(stagedPackage, "package.json"), `${JSON.stringify({ ...manifest, exports: exportsMap })}\n`, "utf8");
    }
    const specifiers = runtimeSubpaths.map((subpath) => subpath === "." ? manifest.name! : `${manifest.name}${subpath.slice(1)}`);
    const runtimeProbe = await exec(process.execPath, ["--input-type=module", "--eval", "const result = {}; for (const specifier of process.argv.slice(1)) { const module = await import(specifier); result[specifier] = Object.fromEntries(Object.keys(module).sort().map((name) => [name, typeof module[name]])); } process.stdout.write(JSON.stringify(result));", ...specifiers], { cwd: room, maxBuffer: 20 * 1024 * 1024 });
    const runtimeNamespaces = JSON.parse(runtimeProbe.stdout) as Record<string, Record<string, string>>;
    const lines = ["type AssertNever<T extends never> = T;", "type AssertTrue<T extends true> = T;", ...specifiers.map((specifier, index) => {
      const runtimeNamespace = runtimeNamespaces[specifier];
      if (typeof runtimeNamespace !== "object" || runtimeNamespace === null || Array.isArray(runtimeNamespace) || Object.entries(runtimeNamespace).some(([name, kind]) => !name || typeof kind !== "string")) throw new Error(`runtime-namespace-invalid:${specifier}`);
      const runtimeNames = Object.keys(runtimeNamespace);
      const runtimeUnion = runtimeNames.length ? runtimeNames.map((name) => JSON.stringify(name)).join(" | ") : "never";
      const typeChecks = Object.entries(runtimeNamespace).map(([name, kind], valueIndex) => `type RuntimeKind_${index}_${valueIndex} = AssertTrue<(typeof import(${JSON.stringify(specifier)}))[${JSON.stringify(name)}] extends ${runtimeTypeFor(kind)} ? true : false>;`).join(" ");
      return `type RuntimeNames_${index} = ${runtimeUnion}; type DeclaredNames_${index} = keyof typeof import(${JSON.stringify(specifier)}); type MissingDeclaredName_${index} = AssertNever<Exclude<RuntimeNames_${index}, DeclaredNames_${index}>>; type MissingRuntimeName_${index} = AssertNever<Exclude<DeclaredNames_${index}, RuntimeNames_${index}>>; ${typeChecks}`;
    })];
    const probe = join(room, "package-types.ts");
    await writeFile(probe, `${lines.join("\n")}\n`, "utf8");
    await runTypeScriptCheck(probe, room);
    return undefined;
  } catch (error) {
    return `package-name-types-probe-failed:${(typescriptOutput(error).trim() || boundedError(error)).replaceAll(/\s+/gu, " ").slice(0, 1000)}`;
  } finally {
    await rm(room, { recursive: true, force: true });
  }
}

function runtimeTypeFor(kind: string): string {
  const types: Record<string, string> = { string: "string", number: "number", bigint: "bigint", boolean: "boolean", symbol: "symbol", undefined: "undefined", object: "object | null", function: "((...args: any[]) => any) | (abstract new (...args: any[]) => any)" };
  const type = types[kind];
  if (!type) throw new Error(`unsupported-runtime-export-kind:${kind}`);
  return type;
}

async function runtimeExportConditionSnapshot(packageDirectory: string, exportsMap: Record<string, unknown>, strictBaseline: boolean): Promise<Record<string, RuntimeExportConditionSnapshot>> {
  const snapshot: Record<string, RuntimeExportConditionSnapshot> = {};
  for (const [subpath, value] of Object.entries(exportsMap)) {
    const conditions = typeof value === "string" ? { default: value } : typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    for (const [condition, targetValue] of Object.entries(conditions)) {
      const key = `${subpath}:${condition}`;
      if (typeof targetValue !== "string" || !targetValue.startsWith("./") || targetValue.includes("..") || targetValue.includes("\\")) {
        snapshot[key] = { target: String(targetValue), status: "invalid", error: "unsafe-or-non-string-target" };
        continue;
      }
      const target = resolve(packageDirectory, targetValue);
      if (!target.startsWith(`${resolve(packageDirectory)}/`)) {
        snapshot[key] = { target: targetValue, status: "invalid", error: "target-escape" };
        continue;
      }
      try { await access(target); }
      catch {
        snapshot[key] = { target: targetValue, status: "invalid", error: "target-missing" };
        continue;
      }
      if (condition === "types" || /\.d\.(?:ts|mts|cts)$/u.test(targetValue)) {
        if (!/\.d\.(?:ts|mts|cts)$/u.test(targetValue)) {
          snapshot[key] = { target: targetValue, status: "invalid", error: "types-target-must-be-a-declaration" };
          continue;
        }
        const declarationError = await declarationTargetError(target, packageDirectory);
        snapshot[key] = declarationError
          ? { target: targetValue, status: "invalid", error: `types-target-invalid:${declarationError}` }
          : { target: targetValue, status: "non-runtime", category: "types" };
        continue;
      }
      if (targetValue.endsWith(".json")) {
        try {
          if (subpath === "./package.json" && targetValue !== "./package.json") throw new Error("package-manifest-must-target-root-manifest");
          const value = JSON.parse(await readFile(target, "utf8")) as unknown;
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("json-export-must-be-an-object");
          if (subpath === "./package.json") {
            const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
            const exportedManifest = value as { name?: unknown; version?: unknown };
            if (exportedManifest.name !== manifest.name || exportedManifest.version !== manifest.version) throw new Error("package-manifest-identity-mismatch");
          }
          snapshot[key] = { target: targetValue, status: "non-runtime", category: "json", namespace: jsonPublicShape(value) };
        } catch (error) {
          snapshot[key] = { target: targetValue, status: "invalid", error: error instanceof Error ? error.message : String(error) };
        }
        continue;
      }
      try {
        const module = await import(`${pathToFileURL(target).href}?compat-condition=${hash([packageDirectory, subpath, condition]).slice(0, 12)}`) as Record<string, unknown>;
        snapshot[key] = { target: targetValue, status: "loaded", namespace: Object.fromEntries(Object.keys(module).sort().map((name) => [name, typeof module[name]])) };
      } catch (error) {
        snapshot[key] = { target: targetValue, status: "throws", error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  if (strictBaseline) {
    const invalid = Object.entries(snapshot).filter(([, condition]) => condition.status === "invalid");
    if (invalid.length) throw new Error(`RT_COMPAT_BASELINE_EXPORT_TARGET_INVALID:${invalid.map(([key, value]) => `${key}:${value.error}`).join(",")}`);
  }
  return snapshot;
}

async function declarationTargetError(target: string, packageDirectory: string): Promise<string | undefined> {
  const work = await mkdtemp(join(tmpdir(), "compatibility-types-target-"));
  const runtimeSpecifier = target.replace(/\.d\.mts$/u, ".mjs").replace(/\.d\.cts$/u, ".cjs").replace(/\.d\.ts$/u, ".js");
  const probe = join(work, "types-target.ts");
  try {
    await writeFile(probe, `type ExportedTypes = typeof import(${JSON.stringify(runtimeSpecifier)});\ntype ExportedNames = keyof ExportedTypes;\n`, "utf8");
    await runTypeScriptCheck(probe, packageDirectory);
    return undefined;
  } catch (error) {
    return (typescriptOutput(error).trim() || boundedError(error)).replaceAll(/\s+/gu, " ").slice(0, 1000);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function jsonPublicShape(value: unknown, path = "$", result: Record<string, string> = {}): Record<string, string> {
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  result[path] = [...new Set([...(result[path]?.split("|") ?? []), kind])].sort().join("|");
  if (Array.isArray(value)) for (const item of value) jsonPublicShape(item, `${path}[]`, result);
  else if (typeof value === "object" && value !== null) for (const [key, field] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) jsonPublicShape(field, `${path}.${key}`, result);
  return result;
}

export async function assertCandidateReleaseIdentity(candidatePackage: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(candidatePackage, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("RT_COMPAT_CANDIDATE_VERSION_MISSING");
  const declarations = await Promise.all((await walk(join(candidatePackage, "dist"))).filter((path) => path.endsWith(".d.ts")).map((path) => readFile(path, "utf8")));
  const identities = declarations.flatMap((source) => [...source.matchAll(/BETTER_REALTIME_VERSION\s*:\s*"([^"]+)"/gu)].map((match) => match[1]!));
  if (!identities.length || identities.some((version) => version !== manifest.version)) throw new Error(`RT_COMPAT_RELEASE_IDENTITY_MISMATCH:${manifest.version}:${identities.join(",") || "missing"}`);
  return manifest.version;
}

export async function assertCandidateRuntimeReleaseIdentity(candidatePackage: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(candidatePackage, "package.json"), "utf8")) as { name?: unknown; version?: unknown; exports?: Record<string, unknown>; bin?: Record<string, string> };
  if (typeof manifest.version !== "string") throw new Error("RT_COMPAT_CANDIDATE_VERSION_MISSING");
  const rootImport = typeof manifest.exports?.["."] === "object" && manifest.exports["."] !== null && "import" in manifest.exports["."] ? (manifest.exports["."] as { import?: unknown }).import : undefined;
  if (typeof rootImport === "string") {
    const runtime = await import(`${pathToFileURL(join(candidatePackage, rootImport.replace(/^\.\//u, ""))).href}?compat=${Date.now()}`) as { BETTER_REALTIME_VERSION?: unknown };
    if (runtime.BETTER_REALTIME_VERSION !== manifest.version) throw new Error(`RT_COMPAT_RUNTIME_RELEASE_IDENTITY_MISMATCH:${String(runtime.BETTER_REALTIME_VERSION)}:${manifest.version}`);
  }
  const cli = manifest.bin?.["better-realtime"];
  if (typeof cli === "string") {
    const result = await exec(process.execPath, [join(candidatePackage, cli.replace(/^\.\//u, "")), "--version"], { cwd: candidatePackage, maxBuffer: 1024 * 1024 });
    if (result.stdout.trim() !== manifest.version || result.stderr.trim()) throw new Error(`RT_COMPAT_CLI_RELEASE_IDENTITY_MISMATCH:${result.stdout.trim()}:${manifest.version}`);
  }
  if (manifest.name === "better-realtime") {
    const packageRoot = resolve(candidatePackage, "../..");
    const specifiers = Object.keys(manifest.exports ?? {}).filter((subpath) => !subpath.endsWith(".json")).map((subpath) => subpath === "." ? "better-realtime" : `better-realtime${subpath.slice(1)}`);
    const smoke = await exec(process.execPath, ["--input-type=module", "--eval", "await Promise.all(process.argv.slice(1).map((specifier) => import(specifier)))", ...specifiers], { cwd: packageRoot, maxBuffer: 20 * 1024 * 1024 });
    if (smoke.stderr.trim()) throw new Error(`RT_COMPAT_PACKAGE_IMPORT_SMOKE_FAILED:${smoke.stderr.trim()}`);
  }
}

function genericWitnessPrelude(rootSpecifier: string): string[] {
  return [
    "type CompatNested = { id: string; nested: { count: number; tuple: [\"compat\", 42] }; brand: \"compat\" };",
    "type CompatTuple = [\"compat\", 42, { ok: true }];",
    `type CompatSchema<T> = import(${JSON.stringify(rootSpecifier)}).RuntimeSchema<T>;`,
    "type CompatEvents = { readonly changed: CompatSchema<{ readonly count: number }> };",
    "type CompatFeedEvents = { readonly appended: CompatSchema<{ readonly text: string; readonly ordinal: number }> };",
    `type CompatStreams = { readonly room: import(${JSON.stringify(rootSpecifier)}).StreamContract<{ readonly room: string }, { readonly count: number }, CompatEvents>; readonly feed: import(${JSON.stringify(rootSpecifier)}).StreamContract<{ readonly channel: number }, { readonly entries: readonly string[] }, CompatFeedEvents> };`,
    `type CompatCommands = { readonly ping: import(${JSON.stringify(rootSpecifier)}).CommandContract<{ readonly id: string }, { readonly ok: true }>; readonly rename: import(${JSON.stringify(rootSpecifier)}).CommandContract<{ readonly name: string; readonly force: boolean }, { readonly revision: number }> };`,
    `type CompatContract = import(${JSON.stringify(rootSpecifier)}).RealtimeContract<CompatStreams, CompatCommands>;`
  ];
}

async function supportedGenericWitnesses(
  entries: Array<{ subpath: string; baselinePath: string; candidatePath: string | undefined }>,
  declarations: Array<{ subpath: string; baselinePath: string; candidatePath: string | undefined; source: string }>,
  allBaselineDeclarations: string,
  witnessPrelude: string[],
  work: string
): Promise<Map<string, string[][]>> {
  const lines = [...witnessPrelude];
  const probes = new Map<number, { key: string; argumentsSet: string[] }>();
  for (const entry of entries) {
    const baselineSpecifier = entry.baselinePath.replace(/\.d\.ts$/u, ".js");
    const source = declarations.find((value) => value.subpath === entry.subpath)!.source;
    for (const exported of exportedTypeNames(source)) {
      const arity = exportedTypeArity(allBaselineDeclarations, exported.original);
      if (!arity) continue;
      for (const argumentsSet of genericWitnessArguments(arity)) {
        lines.push(`type Probe_${lines.length} = import(${JSON.stringify(baselineSpecifier)}).${exported.publicName}<${argumentsSet.join(",")}>;`);
        probes.set(lines.length, { key: `${entry.subpath}:${exported.publicName}`, argumentsSet });
      }
    }
  }
  const probePath = join(work, "typescript-api-witness-probes.ts");
  await writeFile(probePath, `${lines.join("\n")}\n`, "utf8");
  const invalidLines = new Set<number>();
  try { await runTypeScriptCheck(probePath, work); }
  catch (error) {
    for (const match of typescriptOutput(error).matchAll(/typescript-api-witness-probes\.ts\((\d+),\d+\): error TS\d+/gu)) invalidLines.add(Number(match[1]));
    if (!invalidLines.size) throw new Error(`RT_COMPAT_TYPESCRIPT_WITNESS_PROBE_FAILED:${boundedError(error)}`);
  }
  const supported = new Map<string, string[][]>();
  for (const [line, probe] of probes) if (!invalidLines.has(line)) supported.set(probe.key, [...(supported.get(probe.key) ?? []), probe.argumentsSet]);
  return supported;
}

function genericWitnessArguments(arity: number): string[][] {
  const repeat = (value: string) => Array.from({ length: arity }, () => value);
  const values = [repeat("CompatNested"), repeat("CompatTuple"), repeat("string"), repeat("CompatSchema<CompatNested>"), repeat("CompatContract")];
  if (arity === 2) values.push(["CompatContract", '"room"'], ["CompatContract", '"feed"'], ["CompatContract", '"ping"'], ["CompatContract", '"rename"'], ["CompatStreams", "CompatCommands"]);
  if (arity === 3) values.push(["CompatNested", "CompatNested", "CompatEvents"], ["CompatNested", '{ readonly type: "object" }', '"compat.schema"']);
  return values;
}

async function runTypeScriptCheck(path: string, cwd: string): Promise<void> {
  await exec(process.execPath, [join(root, "node_modules/typescript/lib/tsc.js"), "--ignoreConfig", "--pretty", "false", "--strict", "--noEmit", "--skipLibCheck", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", path], { cwd, maxBuffer: 20 * 1024 * 1024 });
}

function declarationTarget(value: unknown): string | undefined {
  const target = typeof value === "object" && value !== null && "types" in value ? (value as { types?: unknown }).types : undefined;
  return typeof target === "string" ? target.replace(/^\.\//u, "") : undefined;
}

function exportedTypeNames(source: string): Array<{ original: string; publicName: string }> {
  const result = new Map<string, { original: string; publicName: string }>();
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/gu)) result.set(match[1]!, { original: match[1]!, publicName: match[1]! });
  for (const match of source.matchAll(/export\s+type\s*\{([^}]+)\}/gu)) {
    for (const item of match[1]!.split(",")) {
      const names = item.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u).map((name) => name.trim());
      if (names[0] && /^[A-Za-z_$][\w$]*$/u.test(names[0])) result.set(names[1] ?? names[0], { original: names[0], publicName: names[1] ?? names[0] });
    }
  }
  return [...result.values()].sort((left, right) => left.publicName.localeCompare(right.publicName));
}

function exportedTypeArity(allDeclarations: string, name: string): number {
  const escaped = name.replaceAll(/[$]/gu, "\\$");
  const start = new RegExp(`(?:interface|type|class)\\s+${escaped}\\s*<`, "u").exec(allDeclarations);
  if (!start) return 0;
  const open = allDeclarations.indexOf("<", start.index);
  let depth = 0; let commas = 0;
  for (let index = open; index < allDeclarations.length; index += 1) {
    const character = allDeclarations[index]!;
    if (character === "<" || character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ">" || character === ")" || character === "]" || character === "}") { depth -= 1; if (depth === 0) return commas + 1; }
    else if (character === "," && depth === 1) commas += 1;
  }
  return 0;
}

async function declarationTreeHash(packageDirectory: string): Promise<string> {
  const files = (await walk(join(packageDirectory, "dist"))).filter((path) => path.endsWith(".d.ts")).sort();
  return hash(await Promise.all(files.map(async (path) => [relative(packageDirectory, path), await readFile(path, "utf8")])));
}

async function compareRuntimeJavaScript(baselinePackage: string, candidatePackage: string): Promise<SurfaceChange[]> {
  const baselineFiles = (await walk(join(baselinePackage, "dist"))).filter((path) => path.endsWith(".js"));
  const candidateFiles = (await walk(join(candidatePackage, "dist"))).filter((path) => path.endsWith(".js"));
  const names = new Set([...baselineFiles.map((path) => relative(join(baselinePackage, "dist"), path)), ...candidateFiles.map((path) => relative(join(candidatePackage, "dist"), path))]);
  const changes: SurfaceChange[] = [];
  for (const name of [...names].sort()) {
    const baselineSha256 = await hashFile(join(baselinePackage, "dist", name)).catch(() => hash(undefined));
    const candidateSha256 = await hashFile(join(candidatePackage, "dist", name)).catch(() => hash(undefined));
    if (baselineSha256 !== candidateSha256) changes.push({ surface: "runtimeJavaScript", path: `dist/${name}`, baselineSha256, candidateSha256 });
  }
  return changes;
}

function requireDeclaredChange(changes: Changes, detected: SurfaceChange): void {
  const declaration = declarationFor(changes, detected);
  if (!declaration) throw new Error(`RT_COMPAT_UNDECLARED_CHANGE:${detected.surface}:${detected.path}:${detected.baselineSha256}:${detected.candidateSha256}`);
  if (!allowedAxes(detected).includes(declaration.axis)) throw new Error(`RT_COMPAT_CHANGE_AXIS_INVALID:${declaration.id}:${detected.surface}:${declaration.axis}`);
  if (detected.requiredClassification && declaration.classification !== detected.requiredClassification) throw new Error(`RT_COMPAT_CHANGE_CLASSIFICATION_TOO_WEAK:${declaration.id}:${detected.requiredClassification}`);
}

function declarationFor(changes: Changes, detected: SurfaceChange): DeclaredChange | undefined {
  return changes.changes.find((change) => sameChange(detected, change));
}

function sameChange(left: SurfaceChange, right: Pick<DeclaredChange, "surface" | "path" | "baselineSha256" | "candidateSha256">): boolean {
  return left.surface === right.surface && left.path === right.path && left.baselineSha256 === right.baselineSha256 && left.candidateSha256 === right.candidateSha256;
}

function allowedAxes(change: SurfaceChange): DeclaredChange["axis"][] {
  const fixed: Partial<Record<string, DeclaredChange["axis"]>> = {
    packageManifest: "package", packageExports: "package", typescriptDeclarations: "package", typescriptApiCompatibility: "package", runtimeExportCompatibility: "package",
    wireSchema: "wire", stateMachines: "wire", conformanceScenarios: "wire", protocolTypes: "wire", protocolRuntime: "wire", protocolConstants: "wire", protocolValidator: "wire", protocolManifest: "wire", protocolStateMachineRuntime: "wire",
    diagnosticResultSchema: "diagnostics", diagnosticTypes: "diagnostics", diagnosticQueryRuntime: "diagnostics", cli: "diagnostics", mcp: "diagnostics", diagnosticSemantics: "diagnostics", mcpSemantics: "diagnostics",
    postgresMigration: "postgres", postgresMigrationExecutor: "postgres"
  };
  const axis = fixed[change.surface];
  if (axis) return [axis];
  if (["runtimeClient", "runtimeReact", "runtimeServer"].includes(change.surface)) return ["package"];
  if (["coreClient", "referenceServer"].includes(change.surface)) return ["package", "wire"];
  if (change.surface === "postgresGateway") return ["package", "wire", "postgres"];
  return ["package", "wire", "postgres", "diagnostics"];
}

async function candidateProtocolIdentity(candidatePackage: string): Promise<{ subprotocol: string; version: string }> {
  const constants = await readFile(join(root, "packages/protocol/src/constants.ts"), "utf8");
  const subprotocol = /BETTER_REALTIME_SUBPROTOCOL\s*=\s*"([^"]+)"/u.exec(constants)?.[1];
  if (!subprotocol || !/^better-realtime\.v\d+$/u.test(subprotocol)) throw new Error("RT_COMPAT_CANDIDATE_SUBPROTOCOL_INVALID");
  const major = Number(subprotocol.split("v").at(-1));
  const schemaPath = join(root, `spec/protocol/v${major}/wire.schema.json`);
  const scenariosPath = join(root, `conformance/v${major}/scenarios.json`);
  const machinesPath = join(root, `spec/protocol/v${major}/state-machines.json`);
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as { $defs?: { messageBase?: { properties?: { protocol?: { const?: string } } } } };
  await Promise.all([access(scenariosPath), access(machinesPath)]);
  const version = schema.$defs?.messageBase?.properties?.protocol?.const;
  if (version !== `${major}.0`) throw new Error(`RT_COMPAT_CANDIDATE_PROTOCOL_ENVELOPE_INVALID:${version ?? "missing"}`);
  const shippedJavaScript = await Promise.all((await walk(join(candidatePackage, "dist"))).filter((path) => path.endsWith(".js")).map((path) => readFile(path, "utf8")));
  if (!shippedJavaScript.some((source) => source.includes(subprotocol))) throw new Error(`RT_COMPAT_CANDIDATE_SUBPROTOCOL_NOT_SHIPPED:${subprotocol}`);
  return { subprotocol, version };
}

function assertVersionBoundaries(changes: Changes, detected: SurfaceChange[], candidateVersion: string | undefined, baseline: Baseline, candidatePostgresVersion: number, candidateProtocol: { subprotocol: string; version: string }): void {
  if (!candidateVersion) throw new Error("RT_COMPAT_CANDIDATE_VERSION_MISSING");
  assertCandidateAdvanced(candidateVersion, baseline.package.split("@").at(-1)!, detected.length);
  for (const change of detected) {
    const declaration = declarationFor(changes, change)!;
    if (declaration.classification === "intentionally_breaking" && declaration.axis === "wire" && declaration.minimumVersion !== "better-realtime.v2") throw new Error(`RT_COMPAT_PROTOCOL_MAJOR_REQUIRED:${declaration.id}`);
    if (declaration.classification === "intentionally_breaking" && declaration.axis !== "wire" && declaration.minimumVersion !== "0.2.0-alpha.1") throw new Error(`RT_COMPAT_PACKAGE_BOUNDARY_REQUIRED:${declaration.id}`);
    if (change.surface === "postgresMigration" && candidatePostgresVersion <= baseline.postgresStorageVersion) throw new Error(`RT_COMPAT_VERSIONED_POSTGRES_MIGRATION_REQUIRED:${declaration.id}`);
    if (declaration.classification !== "intentionally_breaking" && declaration.minimumVersion !== "0.1.0-alpha.3") throw new Error(`RT_COMPAT_ALPHA3_BOUNDARY_REQUIRED:${declaration.id}`);
    assertCandidateVersion(candidateVersion, declaration.minimumVersion, declaration.id);
  }
  const wireBreaking = detected.some((change) => { const declaration = declarationFor(changes, change)!; return declaration.axis === "wire" && declaration.classification === "intentionally_breaking"; });
  assertWireCandidateIdentity(wireBreaking, candidateProtocol);
  assertWireConformanceHarness(wireBreaking);
}

async function assertPostgresMigrations(manifest: PostgresMigrations, baseline: Baseline): Promise<number> {
  if (manifest.schemaVersion !== "1.0" || manifest.storage !== "better-realtime-postgres" || manifest.migrations.length === 0) throw new Error("RT_COMPAT_POSTGRES_MIGRATION_MANIFEST_INVALID");
  const versions = manifest.migrations.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length || versions.some((version, index) => version !== index + 1)) throw new Error("RT_COMPAT_POSTGRES_MIGRATION_SEQUENCE_INVALID");
  if (new Set(manifest.migrations.map((migration) => migration.sourcePath)).size !== manifest.migrations.length) throw new Error("RT_COMPAT_POSTGRES_MIGRATION_SOURCE_REUSED");
  const fixtureVersions = manifest.fixtures.map((fixture) => fixture.storageVersion);
  if (new Set(fixtureVersions).size !== fixtureVersions.length) throw new Error("RT_COMPAT_POSTGRES_FIXTURE_VERSION_REUSED");
  const requiredFixtures = new Set([baseline.postgresStorageVersion, ...manifest.migrations.flatMap((migration) => migration.fromVersions)]);
  for (const version of requiredFixtures) if (!fixtureVersions.includes(version)) throw new Error(`RT_COMPAT_POSTGRES_EDGE_FIXTURE_MISSING:${version}`);
  for (const fixture of manifest.fixtures) {
    if (!/^[a-f0-9]{64}$/u.test(fixture.packageSha256) || !/^[a-f0-9]{64}$/u.test(fixture.moduleSha256) || await hashFile(join(root, fixture.packagePath)) !== fixture.packageSha256 || await hashFile(join(root, fixture.modulePath)) !== fixture.moduleSha256) throw new Error(`RT_COMPAT_POSTGRES_FIXTURE_DRIFT:${fixture.storageVersion}`);
  }
  for (const published of baseline.postgresFixtures) {
    const current = manifest.fixtures.find((fixture) => fixture.storageVersion === published.storageVersion);
    if (!current || canonical(current) !== canonical(published)) throw new Error(`RT_COMPAT_PUBLISHED_POSTGRES_FIXTURE_MUTATED:${published.storageVersion}`);
  }
  for (const published of baseline.postgresMigrations) {
    const current = manifest.migrations.find((migration) => migration.version === published.version);
    if (!current || current.sourcePath !== published.sourcePath || current.sourceSha256 !== published.sourceSha256) throw new Error(`RT_COMPAT_PUBLISHED_POSTGRES_MIGRATION_MUTATED:${published.version}`);
  }
  for (const migration of manifest.migrations) {
    if (migration.deploymentTimeOnly !== true || migration.runtimeDdl !== false || migration.destructiveInPlace !== false || !migration.sourcePath.startsWith("packages/store-postgres/src/") || !/^[a-f0-9]{64}$/u.test(migration.sourceSha256)) throw new Error(`RT_COMPAT_POSTGRES_MIGRATION_POLICY_INVALID:${migration.version}`);
    if (migration.version === 1 ? migration.fromVersions.length !== 0 : migration.fromVersions.length === 0) throw new Error(`RT_COMPAT_POSTGRES_MIGRATION_EDGE_REQUIRED:${migration.version}`);
    if (new Set(migration.fromVersions).size !== migration.fromVersions.length || migration.fromVersions.some((from) => !Number.isSafeInteger(from) || from < 1 || from >= migration.version || !versions.includes(from))) throw new Error(`RT_COMPAT_POSTGRES_MIGRATION_EDGE_INVALID:${migration.version}`);
    if (await hashFile(join(root, migration.sourcePath)) !== migration.sourceSha256) throw new Error(`RT_COMPAT_POSTGRES_MIGRATION_SOURCE_DRIFT:${migration.version}`);
  }
  const latest = manifest.migrations.at(-1);
  if (!latest) throw new Error("RT_COMPAT_POSTGRES_MIGRATION_MANIFEST_DRIFT");
  return latest.version;
}

interface ConsumerStages { install: "passed"; typecheck: "passed" | { status: "failed"; diagnostics: string[] }; cliBin: "passed"; mcpBin: "passed" }
async function compileConsumer(tarball: string, directory: string): Promise<{ results: Record<string, ConsumerStages>; room: string; packageDirectory: string }> {
  const matrix = [
    { id: "react18", packages: ["react@18.3.1", "react-dom@18.3.1", "@types/react@18.3.31", "@types/react-dom@18.3.7"] },
    { id: "react19", packages: ["react@19.2.7", "react-dom@19.2.7", "@types/react@19.2.17", "@types/react-dom@19.2.3"] }
  ];
  const results: Record<string, ConsumerStages> = {};
  for (const entry of matrix) {
    const room = join(directory, entry.id);
    await mkdir(room, { recursive: true });
    await cp(apiConsumerPath, join(room, "alpha1-api.ts"));
    await writeFile(join(room, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, "utf8");
    await writeFile(join(room, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: false }, files: ["alpha1-api.ts"] })}\n`, "utf8");
    await exec("npm", ["install", "--ignore-scripts", tarball, "pg@8.22.0", "ws@8.21.1", ...entry.packages], { cwd: room, maxBuffer: 20 * 1024 * 1024 }).catch((error) => { throw new Error(`RT_COMPAT_CONSUMER_INSTALL_FAILED:${entry.id}:${boundedError(error)}`); });
    let typecheck: ConsumerStages["typecheck"] = "passed";
    try { await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--pretty", "false"], { cwd: room, maxBuffer: 20 * 1024 * 1024 }); }
    catch (error) { const diagnostics = typescriptDiagnostics(error); if (!diagnostics.length) throw new Error(`RT_COMPAT_CONSUMER_TYPECHECK_UNCLASSIFIED:${entry.id}:${boundedError(error)}`); typecheck = { status: "failed", diagnostics }; }
    await exec(join(room, "node_modules/.bin/better-realtime"), ["--help"], { cwd: room, maxBuffer: 20 * 1024 * 1024 }).catch((error) => { throw new Error(`RT_COMPAT_CONSUMER_CLI_BIN_FAILED:${entry.id}:${boundedError(error)}`); });
    await access(join(room, "node_modules/.bin/better-realtime-mcp")).catch((error) => { throw new Error(`RT_COMPAT_CONSUMER_MCP_BIN_FAILED:${entry.id}:${boundedError(error)}`); });
    results[entry.id] = { install: "passed", typecheck, cliBin: "passed", mcpBin: "passed" };
  }
  const room = join(directory, "react19");
  return { results, room, packageDirectory: join(room, "node_modules/better-realtime") };
}

interface ExecutionOutcome { status: "passed" | "failed"; value?: unknown; error?: string }
async function compareDiagnostics(baselinePackage: string, candidatePackage: string, baseline: Baseline): Promise<{ cli: Record<string, unknown>; doctor: Record<string, unknown>; change?: SurfaceChange }> {
  const baselineOutcome = await diagnosticOutcome(baselinePackage, baseline, true);
  if (baselineOutcome.status !== "passed") throw new Error(`RT_COMPAT_BASELINE_DIAGNOSTICS_FAILED:${baselineOutcome.error}`);
  const candidateOutcome = await diagnosticOutcome(candidatePackage, baseline, false);
  const baselineSha256 = hash(baselineOutcome);
  const candidateSha256 = hash(candidateOutcome);
  const candidateValue = candidateOutcome.value as { help?: string; cases?: Record<string, DiagnosticSummary> } | undefined;
  const baselineValue = baselineOutcome.value as { cases?: Record<string, DiagnosticSummary> } | undefined;
  const summaries = Object.fromEntries(diagnosticCases.map(({ name }) => [name, candidateValue?.cases?.[name] ? diagnosticCaseSummary(candidateValue.cases[name]!) : { outcome: candidateOutcome.error ?? "failed" }]));
  const breaking = candidateOutcome.status !== "passed" || baseline.cliCommands.some((command) => !candidateValue?.help?.includes(`better-realtime ${command}`)) || diagnosticCases.some(({ name }) => {
    const value = candidateValue?.cases?.[name];
    return !value || !diagnosticInvariant(name, value, baseline, baselineValue?.cases?.[name]);
  });
  return {
    cli: { commands: baseline.cliCommands, outcome: candidateOutcome.status },
    doctor: summaries,
    ...(baselineSha256 === candidateSha256 ? {} : { change: { surface: "diagnosticSemantics", path: "cli-help-and-doctor", baselineSha256, candidateSha256, ...(breaking ? { requiredClassification: "intentionally_breaking" as const } : {}) } })
  };
}

async function diagnosticOutcome(packageDirectory: string, baseline: Baseline, enforceBaseline: boolean): Promise<ExecutionOutcome> {
  try {
    const help = await runCli(packageDirectory, ["--help"]);
    if (help.stderr) throw new Error("RT_COMPAT_DIAGNOSTIC_HELP_FAILED");
    if (enforceBaseline) for (const command of baseline.cliCommands) if (!help.stdout.includes(`better-realtime ${command}`)) throw new Error(`RT_COMPAT_CLI_COMMAND_MISSING:${command}`);
    const cases: Record<string, DiagnosticSummary> = {};
    for (const { name } of diagnosticCases) {
      const source = join(root, `compatibility/diagnostics/${name}.json`);
      const run = await runCli(packageDirectory, ["doctor", "--format", "json", "--source", source, "--tenant", "tenant-compat"]);
      if (run.stderr || !run.stdout) throw new Error(`RT_COMPAT_DIAGNOSTIC_CLI_FAILED:${name}`);
      const result = JSON.parse(run.stdout) as DiagnosticSummary;
      if (!validateDiagnosticResult(result) || result.kind !== "doctor") throw new Error(`RT_COMPAT_DIAGNOSTIC_CLI_SCHEMA_DRIFT:${name}`);
      if (enforceBaseline) assertDiagnosticSummary(name, result, baseline);
      cases[name] = normalizeDiagnostic(result);
    }
    const source = join(root, "compatibility/diagnostics/proven.json");
    const commandCases = [
      { name: "trace_command", args: ["trace", "command", "command-compat", "--format", "json", "--source", source, "--tenant", "tenant-compat"] },
      { name: "inspect_stream", args: ["inspect", "stream", "room:compat", "--format", "json", "--source", source, "--tenant", "tenant-compat"] },
      { name: "leaks", args: ["leaks", "--format", "json", "--source", source, "--tenant", "tenant-compat"] }
    ] as const;
    const commands: Record<string, unknown> = {};
    for (const command of commandCases) {
      const run = await runCli(packageDirectory, [...command.args]);
      if (run.stderr || !run.stdout) throw new Error(`RT_COMPAT_DIAGNOSTIC_CLI_FAILED:${command.name}`);
      const value = JSON.parse(run.stdout) as Record<string, unknown>;
      if (!validateDiagnosticResult(value) || value.kind !== command.name) throw new Error(`RT_COMPAT_DIAGNOSTIC_CLI_SCHEMA_DRIFT:${command.name}`);
      commands[command.name] = normalizeDiagnostic(value);
    }
    return { status: "passed", value: { help: help.stdout.replace(/^Better Realtime \S+/u, "Better Realtime <version>"), cases, commands } };
  } catch (error) { return { status: "failed", error: executionError(error) }; }
}

interface DiagnosticProducerInstance { producerRole: string; runtimeId: string; runtimeBootId: string }
interface DiagnosticCompletenessSummary {
  status: string;
  droppedRecords: number;
  evictedRecords: number;
  expectedProducers: string[];
  observedProducers: string[];
  missingProducers: string[];
  expectedProducerInstances: DiagnosticProducerInstance[];
  observedProducerInstances: DiagnosticProducerInstance[];
  missingProducerInstances: DiagnosticProducerInstance[];
}
export interface DiagnosticSummary {
  productVersion?: string;
  queryVersion: string;
  schemaVersion: string;
  kind: string;
  completeness: Omit<DiagnosticCompletenessSummary, "expectedProducers" | "observedProducers" | "missingProducers">;
  evidenceReference?: { reference?: string; recordCount?: number };
  report: { verdict: string; completeness: DiagnosticCompletenessSummary; evidenceClosure?: Array<{ recordId?: string; purpose?: string; proofSource?: string; resolution?: string }> };
}
const diagnosticCases = [
  { name: "proven", verdict: "proven", completeness: "complete", expectedProducers: ["server"], observedProducers: ["server"], missingProducers: [], closure: [{ purpose: "matched_boundary" }, { purpose: "matched_boundary" }] },
  { name: "partial", verdict: "indeterminate", completeness: "partial", expectedProducers: ["server", "database"], observedProducers: ["server"], missingProducers: ["database"], closure: [{ purpose: "matched_boundary" }] },
  { name: "disproven-complete", verdict: "disproven", completeness: "complete", expectedProducers: ["database"], observedProducers: ["database"], missingProducers: [], closure: [{ purpose: "divergent_boundary", proofSource: "postgres_error_response" }] },
  { name: "transaction-indeterminate-complete", verdict: "indeterminate", completeness: "complete", expectedProducers: ["database"], observedProducers: ["database"], missingProducers: [], closure: [{ purpose: "divergent_boundary", proofSource: "commit_ack_unavailable" }] },
  { name: "transaction-reconciled-proven", verdict: "proven", completeness: "complete", expectedProducers: ["database"], observedProducers: ["database"], missingProducers: [], closure: [{ purpose: "transaction_indeterminate", proofSource: "commit_ack_unavailable" }, { purpose: "reconciliation_proof", proofSource: "durable_transaction_attempt_marker", resolution: "committed" }, { purpose: "matched_boundary", proofSource: "durable_transaction_attempt_marker" }] },
  { name: "transaction-reconciled-disproven", verdict: "disproven", completeness: "complete", expectedProducers: ["database"], observedProducers: ["database"], missingProducers: [], closure: [{ purpose: "transaction_indeterminate", proofSource: "commit_ack_unavailable" }, { purpose: "reconciliation_proof", proofSource: "durable_transaction_attempt_marker", resolution: "rolled_back" }, { purpose: "divergent_boundary", proofSource: "durable_transaction_attempt_marker", resolution: "rolled_back" }] }
] as const;
function assertDiagnosticSummary(name: (typeof diagnosticCases)[number]["name"], value: DiagnosticSummary, baseline: Baseline): void {
  if (!diagnosticInvariant(name, value, baseline)) throw new Error(`RT_COMPAT_DIAGNOSTIC_INVARIANT_DRIFT:${name}`);
}
export function diagnosticInvariant(name: (typeof diagnosticCases)[number]["name"], value: DiagnosticSummary, baseline: Baseline, baselineValue?: DiagnosticSummary): boolean {
  const expected = diagnosticCases.find((entry) => entry.name === name)!;
  const closure = value.report?.evidenceClosure ?? [];
  const projection = closure.map((entry) => ({ purpose: entry.purpose, ...(entry.proofSource ? { proofSource: entry.proofSource } : {}), ...(entry.resolution ? { resolution: entry.resolution } : {}) }));
  const reportCompleteness = value.report?.completeness;
  const instanceFields = ["expectedProducerInstances", "observedProducerInstances", "missingProducerInstances"] as const;
  const roleFields = ["expectedProducers", "observedProducers", "missingProducers"] as const;
  const instancesValid = instanceFields.every((field) => Array.isArray(reportCompleteness?.[field]) && reportCompleteness[field].every(validDiagnosticProducerInstance) && canonicalSorted(reportCompleteness[field]) === canonicalSorted(value.completeness?.[field] ?? []));
  const baselineInstancesMatch = !baselineValue || instanceFields.every((field) => canonicalSorted(reportCompleteness?.[field] ?? []) === canonicalSorted(baselineValue.report?.completeness?.[field] ?? []));
  const expectedRoles = { expectedProducers: expected.expectedProducers, observedProducers: expected.observedProducers, missingProducers: expected.missingProducers } as const;
  const rolesMatch = roleFields.every((field) => canonicalSorted(reportCompleteness?.[field] ?? []) === canonicalSorted(expectedRoles[field]));
  const instanceRolesMatch = instanceFields.every((field, index) => canonicalSorted((reportCompleteness?.[field] ?? []).map((entry) => entry.producerRole)) === canonicalSorted(expectedRoles[roleFields[index]!]));
  return Boolean(value.productVersion === undefined || validateDiagnosticResult(value)) && value.queryVersion === baseline.diagnosticSchemaVersion && value.schemaVersion === baseline.diagnosticSchemaVersion && value.kind === "doctor" && value.report.verdict === expected.verdict && value.completeness.status === expected.completeness && value.report.completeness.status === expected.completeness && value.completeness.droppedRecords === 0 && value.completeness.evictedRecords === 0 && value.report.completeness.droppedRecords === 0 && value.report.completeness.evictedRecords === 0 && rolesMatch && instancesValid && instanceRolesMatch && baselineInstancesMatch && baseline.doctorVerdicts.includes(value.report.verdict) && baseline.completenessStatuses.includes(value.completeness.status) && canonical(projection) === canonical(expected.closure) && typeof value.evidenceReference?.reference === "string" && /^dqc1\.sha256:[a-f0-9]{64}$/u.test(value.evidenceReference.reference) && value.evidenceReference.recordCount === closure.length && closure.every((entry) => typeof entry.recordId === "string");
}
function validDiagnosticProducerInstance(value: DiagnosticProducerInstance): boolean { return typeof value?.producerRole === "string" && /^pseudonym:sha256:[a-f0-9]{64}$/u.test(value.runtimeId) && /^pseudonym:sha256:[a-f0-9]{64}$/u.test(value.runtimeBootId); }
function canonicalSorted(value: readonly unknown[]): string { return canonical([...value].sort((left, right) => canonical(left).localeCompare(canonical(right)))); }
function diagnosticCaseSummary(value: DiagnosticSummary): Record<string, unknown> { return { verdict: value.report.verdict, completeness: value.completeness.status, reportCompleteness: value.report.completeness, evidenceReference: value.evidenceReference, closure: value.report.evidenceClosure?.map((entry) => ({ purpose: entry.purpose, ...(entry.proofSource ? { proofSource: entry.proofSource } : {}), ...(entry.resolution ? { resolution: entry.resolution } : {}) })) ?? [] }; }
function normalizeDiagnostic<T extends object>(value: T): T { const copy = structuredClone(value); delete (copy as { productVersion?: unknown }).productVersion; return copy; }

async function compareMcp(baselineRoom: string, candidateRoom: string, contract: Baseline): Promise<{ baseline: Record<string, unknown>; candidate: Record<string, unknown>; change?: SurfaceChange }> {
  const baseline = await mcpInventory(baselineRoom, "baseline", contract, true);
  if (baseline.status !== "passed") throw new Error(`RT_COMPAT_BASELINE_MCP_FAILED:${baseline.error}`);
  const candidate = await mcpInventory(candidateRoom, "candidate", contract, false);
  const baselineSha256 = hash(baseline); const candidateSha256 = hash(candidate);
  const candidateValue = candidate.value as { tools?: Array<{ name?: string }>; cases?: Record<string, DiagnosticSummary> } | undefined;
  const baselineValue = baseline.value as { cases?: Record<string, DiagnosticSummary> } | undefined;
  const candidateToolNames = candidateValue?.tools?.map((tool) => tool.name) ?? [];
  const breaking = candidate.status !== "passed" || contract.mcpTools.some((name) => !candidateToolNames.includes(name)) || diagnosticCases.some(({ name }) => {
    const value = candidateValue?.cases?.[name];
    return !value || !diagnosticInvariant(name, value, contract, baselineValue?.cases?.[name]);
  });
  return { baseline: summarizeMcpOutcome(baseline), candidate: summarizeMcpOutcome(candidate), ...(baselineSha256 === candidateSha256 ? {} : { change: { surface: "mcpSemantics", path: "tools-and-doctor", baselineSha256, candidateSha256, ...(breaking ? { requiredClassification: "intentionally_breaking" as const } : {}) } }) };
}

function summarizeMcpOutcome(outcome: ExecutionOutcome): Record<string, unknown> { if (outcome.status === "failed") return { status: "failed", error: outcome.error }; const value = outcome.value as { tools?: Array<{ name?: string }>; cases?: Record<string, DiagnosticSummary> }; return { status: "passed", tools: value.tools?.map((tool) => tool.name), cases: Object.fromEntries(diagnosticCases.map(({ name }) => [name, value.cases?.[name] ? diagnosticCaseSummary(value.cases[name]!) : { outcome: "missing" }])) }; }

async function mcpInventory(consumerRoom: string, label: string, baseline: Baseline, enforceBaseline: boolean): Promise<ExecutionOutcome> {
  try {
    let inventory: Array<{ name: string; annotations: unknown; inputSchema: unknown }> | undefined;
    const cases: Record<string, DiagnosticSummary> = {};
    const exercises: Record<string, unknown> = {};
    for (const { name } of diagnosticCases) {
      const client = new Client({ name: `compatibility-${label}-${name}`, version: "1.0.0" });
      const transport = new StdioClientTransport({ command: join(consumerRoom, "node_modules/.bin/better-realtime-mcp"), cwd: consumerRoom, env: stringEnvironment({ ...process.env, REALTIME_EVIDENCE_FILE: join(root, `compatibility/diagnostics/${name}.json`), REALTIME_TENANT_ID: "tenant-compat" }), stderr: "pipe" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        if ((enforceBaseline ? canonical(names) !== canonical(baseline.mcpTools) : baseline.mcpTools.some((tool) => !names.includes(tool))) || tools.tools.some((tool) => tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false || tool.annotations?.idempotentHint !== true || tool.annotations?.openWorldHint !== false)) throw new Error(`RT_COMPAT_MCP_TOOL_DRIFT:${label}:${name}`);
        inventory ??= tools.tools.map((tool) => ({ name: tool.name, annotations: tool.annotations, inputSchema: tool.inputSchema }));
        const result = await callMcpDiagnostic(client, "realtime_doctor", {}) as DiagnosticSummary;
        if (!validateDiagnosticResult(result) || result.kind !== "doctor") throw new Error(`RT_COMPAT_MCP_RESULT_SCHEMA_DRIFT:realtime_doctor:${name}`);
        if (enforceBaseline) assertDiagnosticSummary(name, result, baseline);
        cases[name] = normalizeDiagnostic(result);
        if (name === "proven") {
          const calls = [
            { name: "realtime_trace_command", kind: "trace_command", arguments: { commandId: "command-compat" } },
            { name: "realtime_inspect_stream", kind: "inspect_stream", arguments: { stream: "room:compat" } },
            { name: "realtime_leaks", kind: "leaks", arguments: {} },
            { name: "realtime_query_evidence", kind: "raw_evidence", arguments: { filters: { commandId: "command-compat" } } },
            { name: "realtime_query_evidence_closure", kind: "evidence_closure", arguments: { reference: result.evidenceReference?.reference } }
          ];
          for (const call of calls) {
            const value = await callMcpDiagnostic(client, call.name, call.arguments) as Record<string, unknown>;
            if (!validateDiagnosticResult(value) || value.kind !== call.kind) throw new Error(`RT_COMPAT_MCP_RESULT_SCHEMA_DRIFT:${call.name}`);
            if (call.kind === "evidence_closure") {
              const records = value.records as Array<{ recordId?: string }> | undefined;
              if (canonical(records?.map((record) => record.recordId) ?? []) !== canonical(result.report.evidenceClosure?.map((entry) => entry.recordId) ?? [])) throw new Error("RT_COMPAT_MCP_CLOSURE_EXPANSION_DRIFT");
            }
            exercises[call.name] = normalizeDiagnostic(value);
          }
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    return { status: "passed", value: { tools: inventory, cases, exercises } };
  } catch (error) {
    return { status: "failed", error: executionError(error) };
  }
}

async function callMcpDiagnostic(client: Client, name: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
  const response = await client.callTool({ name, arguments: argumentsValue });
  if (response.isError) throw new Error(`RT_COMPAT_MCP_TOOL_EXECUTION_FAILED:${name}`);
  const content = response.content as Array<{ type: string; text?: string }>;
  if (content.length !== 1 || content[0]?.type !== "text" || !content[0].text) throw new Error(`RT_COMPAT_MCP_TOOL_RESULT_INVALID:${name}`);
  return JSON.parse(content[0].text);
}

function executionError(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return /^(RT_[A-Z0-9_]+)/u.exec(message)?.[1] ?? (error instanceof SyntaxError ? "SyntaxError" : error instanceof TypeError ? "TypeError" : "execution-failed"); }

async function runCli(packageDirectory: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await exec(process.execPath, [join(packageDirectory, "dist/cli-bin.js"), ...args], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function extract(tarball: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await exec("tar", ["-xzf", tarball, "-C", directory]);
}
async function hashFile(path: string): Promise<string> { return hash(await readFile(path)); }
function hash(value: unknown): string { return createHash("sha256").update(value === undefined ? "<absent>" : Buffer.isBuffer(value) ? value : canonical(value)).digest("hex"); }
function surfaceChange(surface: string, path: string, baseline: unknown, candidate: unknown): SurfaceChange { return { surface, path, baselineSha256: hash(baseline), candidateSha256: hash(candidate) }; }
function canonical(value: unknown): string { if (value === undefined) return "<absent>"; if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; }
async function walk(directory: string): Promise<string[]> { const result: string[] = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) result.push(...await walk(path)); else if (entry.isFile()) result.push(path); } return result; }
function counts(changes: DeclaredChange[]): Record<Classification, number> { return { compatible: changes.filter((change) => change.classification === "compatible").length, deprecated: changes.filter((change) => change.classification === "deprecated").length, intentionally_breaking: changes.filter((change) => change.classification === "intentionally_breaking").length }; }
function countsByAxis(changes: DeclaredChange[]): Record<DeclaredChange["axis"], number> { return { package: changes.filter((change) => change.axis === "package").length, wire: changes.filter((change) => change.axis === "wire").length, postgres: changes.filter((change) => change.axis === "postgres").length, diagnostics: changes.filter((change) => change.axis === "diagnostics").length }; }
function summarizeSurface(surfaceChanges: SurfaceChange[], changes: Changes): string { if (!surfaceChanges.length) return "identical"; const classes = new Set(surfaceChanges.map((change) => declarationFor(changes, change)?.classification)); return classes.has("intentionally_breaking") ? "intentionally-breaking" : classes.has("deprecated") ? "deprecated-compatible" : "compatible"; }
function assertConsumerResult(label: string, results: Record<string, ConsumerStages>, candidate: boolean, changes: Changes): void {
  for (const [matrix, result] of Object.entries(results)) {
    const actual = result.typecheck === "passed" ? [] : result.typecheck.diagnostics;
    if (!candidate && actual.length) throw new Error(`RT_COMPAT_BASELINE_CONSUMER_TYPECHECK_FAILED:${label}:${matrix}:${actual.join(",")}`);
    if (!candidate) continue;
    const expected = [...new Set(changes.changes.flatMap((change) => change.classification === "intentionally_breaking" && change.axis === "package" ? change.expectedTypeScriptDiagnostics?.[matrix] ?? [] : []))].sort();
    assertTypeScriptDiagnosticSet(`${label}:${matrix}`, actual, expected);
  }
}
function typescriptDiagnostics(error: unknown): string[] { const value = error as { stdout?: string; stderr?: string }; return [...new Set(`${value.stdout ?? ""}\n${value.stderr ?? ""}`.match(/TS\d{4}/gu) ?? [])].sort(); }
function typescriptOutput(error: unknown): string { const value = error as { stdout?: string; stderr?: string }; return `${value.stdout ?? ""}\n${value.stderr ?? ""}`; }
function boundedError(error: unknown): string { const value = error as { stderr?: string; message?: string }; return String(value.stderr || value.message || error).replaceAll(/\s+/gu, " ").slice(0, 300); }
function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }

export function assertCandidateVersion(candidateVersion: string, minimumVersion: string, changeId: string): void {
  if (/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(minimumVersion) && compareAlphaVersions(candidateVersion, minimumVersion) < 0) throw new Error(`RT_COMPAT_CANDIDATE_VERSION_TOO_LOW:${changeId}:${candidateVersion}:${minimumVersion}`);
}

export function assertCandidateAdvanced(candidateVersion: string, baselineVersion: string, detectedChangeCount: number): void { if (detectedChangeCount > 0 && compareAlphaVersions(candidateVersion, baselineVersion) <= 0) throw new Error(`RT_COMPAT_CANDIDATE_VERSION_NOT_ADVANCED:${candidateVersion}`); }
export function assertWireCandidateIdentity(wireBreaking: boolean, candidate: { subprotocol: string; version: string }): void { if (wireBreaking && (candidate.subprotocol !== "better-realtime.v2" || candidate.version !== "2.0")) throw new Error(`RT_COMPAT_WIRE_V2_IDENTITY_REQUIRED:${candidate.subprotocol}:${candidate.version}`); }
export function assertWireConformanceHarness(wireBreaking: boolean): void { if (wireBreaking) throw new Error("RT_COMPAT_WIRE_V2_CONFORMANCE_HARNESS_REQUIRED"); }
export function assertTypeScriptDiagnosticSet(label: string, actual: readonly string[], expected: readonly string[]): void { if (canonical([...actual].sort()) !== canonical([...expected].sort())) throw new Error(`RT_COMPAT_CANDIDATE_TYPESCRIPT_DIAGNOSTICS_UNEXPECTED:${label}:actual=${[...actual].sort()}:expected=${[...expected].sort()}`); }

export function compareAlphaVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number, number] => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/u);
    if (!match) throw new Error(`RT_COMPAT_VERSION_INVALID:${value}`);
    return match.slice(1).map(Number) as [number, number, number, number];
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(`${JSON.stringify(await checkCompatibility())}\n`);
