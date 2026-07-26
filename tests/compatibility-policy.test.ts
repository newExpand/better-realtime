import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCandidateAdvanced, assertCandidateRuntimeReleaseIdentity, assertCandidateVersion, assertTypeScriptDiagnosticSet, assertUniqueChangeDeclarations, assertWireCandidateIdentity, assertWireConformanceHarness, candidateShapeRecursionExclusions, compareAlphaVersions, compareExports, compareRuntimeExportConditions, compareTypeScriptApiCompatibility, diagnosticInvariant, shapeProbeRecursionLines, type Baseline, type DiagnosticSummary } from "../scripts/check-compatibility.ts";
import { runtimeSemanticRequirement } from "../scripts/compare-runtime-semantics.ts";

const root = resolve(import.meta.dirname, "..");

describe("published alpha compatibility policy", () => {
  it("keeps the exact npm alpha.1 artifact as a checksum-pinned preservation fixture", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "compatibility/fixtures/better-realtime-0.1.0-alpha.1.json"), "utf8")) as { bytes: number; sha256: string; integrity: string; checksumPinned: boolean; preservationBaseline: boolean; githubReleaseImmutable: boolean };
    const artifact = await readFile(resolve(root, "compatibility/fixtures/better-realtime-0.1.0-alpha.1.tgz"));
    expect(artifact.byteLength).toBe(manifest.bytes);
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(manifest.sha256);
    expect(`sha512-${createHash("sha512").update(artifact).digest("base64")}`).toBe(manifest.integrity);
    expect(manifest).toMatchObject({ checksumPinned: true, preservationBaseline: true, githubReleaseImmutable: false });
  });

  it("keeps alpha.1 and exact alpha.4 as independent storage-v1 migration fixtures", async () => {
    const [manifestSource, harness] = await Promise.all([
      readFile(resolve(root, "compatibility/postgres-migrations.json"), "utf8"),
      readFile(resolve(root, "scripts/verify-postgres-compatibility.ts"), "utf8")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      fixtures: Array<{ storageVersion: number; publishedBaseline: string; packagePath: string; packageSha256: string }>;
    };
    expect(manifest.fixtures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storageVersion: 1,
        publishedBaseline: "better-realtime@0.1.0-alpha.1",
        packagePath: "compatibility/fixtures/better-realtime-0.1.0-alpha.1.tgz",
        packageSha256: "037aeab6cb79d891135026489f6e42595e231bf623b0032b4110472adf444d33"
      }),
      expect.objectContaining({
        storageVersion: 1,
        publishedBaseline: "better-realtime@0.1.0-alpha.4",
        packagePath: "compatibility/fixtures/better-realtime-0.1.0-alpha.4.tgz",
        packageSha256: "803487cf32eca359ac85755b138119bf37c9e9afa476e55684971ed24057a6c2"
      })
    ]));
    expect(harness).toContain("manifest.fixtures.filter");
    expect(harness).toContain("for (const [fixtureIndex, fixture] of edgeFixtures.entries())");
    expect(harness).toContain("publishedBaseline");
    expect(harness).toContain("RT_COMPAT_POSTGRES_FIXTURE_PACKAGE_IDENTITY");
    expect(harness).not.toContain("manifest.fixtures.find((entry) => entry.storageVersion");
  });

  it("accepts only the three explicit change classifications and independent version boundaries", async () => {
    const changes = JSON.parse(await readFile(resolve(root, "compatibility/changes.json"), "utf8")) as { changes: Array<{ id: string; classification: string; minimumVersion: string }> };
    for (const change of changes.changes) {
      expect(["compatible", "deprecated", "intentionally_breaking"]).toContain(change.classification);
      expect(change.id).toMatch(/^(?:candidate|alpha4)-/u);
      expect(change.minimumVersion).toBe(change.classification === "intentionally_breaking" ? "0.2.0-alpha.1" : "0.1.0-alpha.4");
    }
    const stability = await readFile(resolve(root, "docs/public/stability.md"), "utf8");
    expect(stability).toContain("`0.2.0-alpha.1`");
    expect(stability).toContain("next unused prerelease on the current `0.2.0-alpha.N` line");
    expect(stability).toContain("new minor alpha line");
    expect(stability).not.toContain("compatible fixes/additions use the next unused `0.1.x-alpha` identity");
    expect(stability).toContain("`better-realtime.v2`");
    expect(stability).toContain("versioned deployment migration");
  });

  it("keeps compatibility branches out of core runtime and runs the gates in CI", async () => {
    const corePaths = [
      "packages/core/src/index.ts",
      "packages/protocol/src/index.ts",
      "packages/react/src/index.ts",
      "packages/server-node/src/postgres-gateway.ts",
      "packages/store-postgres/src/index.ts",
      "packages/transport-reference/src/index.ts"
    ];
    for (const path of corePaths) expect(await readFile(resolve(root, path), "utf8")).not.toMatch(/0\.1\.0-alpha\.1|packageVersion\s*[=!]==?/u);
    const ci = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("pnpm compatibility:check");
    expect(ci).toContain("pnpm compatibility:matrix");
    const postgresHarness = await readFile(resolve(root, "scripts/test-postgres-docker.sh"), "utf8");
    expect(postgresHarness).toContain("pnpm compatibility:postgres");
  });

  it("fails a declared alpha.4 or 0.2 change when the actual candidate package version is too low", () => {
    expect(compareAlphaVersions("0.1.0-alpha.4", "0.1.0-alpha.1")).toBeGreaterThan(0);
    expect(() => assertCandidateVersion("0.1.0-alpha.2", "0.1.0-alpha.4", "compatible-change")).toThrow("RT_COMPAT_CANDIDATE_VERSION_TOO_LOW");
    expect(() => assertCandidateVersion("0.1.0-alpha.2", "0.2.0-alpha.1", "breaking-change")).toThrow("RT_COMPAT_CANDIDATE_VERSION_TOO_LOW");
    expect(() => assertCandidateVersion("0.2.0-alpha.1", "0.2.0-alpha.1", "breaking-change")).not.toThrow();
    expect(() => assertCandidateVersion("0.1.0-alpha.1", "better-realtime.v2", "wire-change")).not.toThrow();
    expect(() => assertCandidateAdvanced("0.1.0-alpha.1", "0.1.0-alpha.1", 1)).toThrow("RT_COMPAT_CANDIDATE_VERSION_NOT_ADVANCED");
    expect(() => assertCandidateAdvanced("0.1.0-alpha.4", "0.1.0-alpha.1", 1)).not.toThrow();
    expect(() => assertWireCandidateIdentity(true, { subprotocol: "better-realtime.v1", version: "1.0" })).toThrow("RT_COMPAT_WIRE_V2_IDENTITY_REQUIRED");
    expect(() => assertWireCandidateIdentity(true, { subprotocol: "better-realtime.v2", version: "2.0" })).not.toThrow();
    expect(() => assertWireConformanceHarness(true)).toThrow("RT_COMPAT_WIRE_V2_CONFORMANCE_HARNESS_REQUIRED");
    expect(() => assertTypeScriptDiagnosticSet("react18", [], ["TS2305"])).toThrow("RT_COMPAT_CANDIDATE_TYPESCRIPT_DIAGNOSTICS_UNEXPECTED");
    expect(() => assertTypeScriptDiagnosticSet("react19", ["TS2305"], ["TS2305"])).not.toThrow();
    const tuple = { surface: "wireSchema", path: "spec/protocol/v1/wire.schema.json", baselineSha256: "a".repeat(64), candidateSha256: "b".repeat(64) };
    expect(() => assertUniqueChangeDeclarations([{ id: "first", ...tuple }, { id: "second", ...tuple }])).toThrow("RT_COMPAT_DUPLICATE_CHANGE_DECLARATION:second");
  });

  it("fingerprints executable public, protocol, diagnostic, and migration surfaces", async () => {
    const checker = await readFile(resolve(root, "scripts/check-compatibility.ts"), "utf8");
    for (const surface of ["runtimeClient", "runtimeReact", "runtimeServer", "coreClient", "protocolRuntime", "protocolConstants", "protocolValidator", "protocolManifest", "protocolStateMachineRuntime", "referenceServer", "postgresGateway", "postgresMigrationExecutor", "diagnosticQueryRuntime"]) expect(checker).toContain(surface);
    for (const field of ["sideEffects", "engines", "bin", "peerDependencies", "peerDependenciesMeta"]) expect(checker).toContain(field);
    expect(checker).toContain("RT_COMPAT_DUPLICATE_CHANGE_DECLARATION");
    for (const fixture of ["disproven-complete", "transaction-indeterminate-complete", "transaction-reconciled-proven", "transaction-reconciled-disproven"]) expect(checker).toContain(fixture);
    for (const field of ["report.completeness.status", "expectedProducers", "observedProducers", "missingProducers", "expectedProducerInstances", "observedProducerInstances", "missingProducerInstances"]) expect(checker).toContain(field);
  });

  it("rejects a diagnostic report whose completeness or producer provenance weakens", () => {
    const instance = { producerRole: "server", runtimeId: `pseudonym:sha256:${"a".repeat(64)}`, runtimeBootId: `pseudonym:sha256:${"b".repeat(64)}` };
    const completeness = { status: "complete", droppedRecords: 0, evictedRecords: 0, expectedProducers: ["server"], observedProducers: ["server"], missingProducers: [], expectedProducerInstances: [instance], observedProducerInstances: [instance], missingProducerInstances: [] };
    const value: DiagnosticSummary = { queryVersion: "1.0", schemaVersion: "1.0", kind: "doctor", completeness: { status: "complete", droppedRecords: 0, evictedRecords: 0, expectedProducerInstances: [instance], observedProducerInstances: [instance], missingProducerInstances: [] }, evidenceReference: { reference: `dqc1.sha256:${"c".repeat(64)}`, recordCount: 2 }, report: { verdict: "proven", completeness, evidenceClosure: [{ recordId: "one", purpose: "matched_boundary" }, { recordId: "two", purpose: "matched_boundary" }] } };
    const baseline = { diagnosticSchemaVersion: "1.0", doctorVerdicts: ["proven", "disproven", "indeterminate"], completenessStatuses: ["complete", "partial"] } as Baseline;
    expect(diagnosticInvariant("proven", value, baseline, value)).toBe(true);
    for (const mutate of [
      (copy: DiagnosticSummary) => { copy.report.completeness.status = "partial"; },
      (copy: DiagnosticSummary) => { copy.report.completeness.observedProducers = []; },
      (copy: DiagnosticSummary) => { copy.report.completeness.observedProducerInstances = []; },
      (copy: DiagnosticSummary) => { copy.report.completeness.observedProducerInstances[0]!.runtimeBootId = `pseudonym:sha256:${"d".repeat(64)}`; }
    ]) {
      const changed = structuredClone(value);
      mutate(changed);
      expect(diagnosticInvariant("proven", changed, baseline, value)).toBe(false);
    }
  });

  it("forces runtime failure and removal of any named alpha.1 type export to a breaking boundary", async () => {
    expect(runtimeSemanticRequirement("failed")).toEqual({ requiredClassification: "intentionally_breaking" });
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-api-mutation-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\nexport interface Stable { value: string }\nexport interface Removed { id: string }\nexport declare function use(value: Stable): void;\n`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\nexport interface Stable { value: string }\nexport declare function use(value: Stable): void;\n`)
      ]);
      const exports = { ".": { types: "./dist/index.d.ts" } };
      const changes = await compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work);
      expect(changes).toEqual([expect.objectContaining({ surface: "typescriptApiCompatibility", requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("treats an exact release identity bump as compatible but catches concrete generic regressions", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-generic-mutation-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" })),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\nexport type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;\n`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.2";\nexport type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;\n`)
      ]);
      const exports = { ".": { types: "./dist/index.d.ts" } };
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([]);
      await writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.2";\nexport type DeepReadonly<T> = T;\n`);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ surface: "typescriptApiCompatibility", requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("allows optional API additions while rejecting public version export removal", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-additive-api-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    const exports = { ".": { types: "./dist/index.d.ts" } };
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" })),
        writeFile(resolve(baseline, "dist/release.d.ts"), 'export declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\n'),
        writeFile(resolve(candidate, "dist/release.d.ts"), 'export declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.2";\n'),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nimport { BETTER_REALTIME_VERSION } from "./release.js";\nexport { BETTER_REALTIME_VERSION };\nexport interface DiagnosticIdentity { productVersion: typeof BETTER_REALTIME_VERSION }\nexport interface Options { url: string }\n`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nimport { BETTER_REALTIME_VERSION } from "./release.js";\nexport { BETTER_REALTIME_VERSION };\nexport interface DiagnosticIdentity { productVersion: typeof BETTER_REALTIME_VERSION }\nexport interface Options { url: string; timeoutMs?: number }\n`)
      ]);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([]);
      await writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport { BETTER_REALTIME_VERSION } from "./release.js";\nexport interface Options { url: string; timeoutMs?: number }\n`);
      await writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport { BETTER_REALTIME_VERSION } from "./release.js";\nexport interface Options { url: string }\n`);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport { BETTER_REALTIME_VERSION } from "./release.js";\nexport interface Options { url: string }\n`);
      await writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport interface Options { url: string; timeoutMs?: number }\n`);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ surface: "typescriptApiCompatibility", requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("forces removal of any existing package export condition to a breaking boundary", () => {
    const [change] = compareExports({ ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }, { ".": { types: "./dist/index.d.ts" } });
    expect(change).toMatchObject({ surface: "packageExports", path: ".", requiredClassification: "intentionally_breaking" });
  });

  it("rejects widening the public version literal even when internal identity is exact", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-version-widening-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    const exports = { ".": { types: "./dist/index.d.ts" } };
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" })),
        writeFile(resolve(baseline, "dist/release.d.ts"), 'export declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\n'),
        writeFile(resolve(candidate, "dist/release.d.ts"), 'export declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.2";\n'),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport { BETTER_REALTIME_VERSION } from "./release.js";\n`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: string;\n`)
      ]);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("does not normalize unrelated public literals that happen to match the package version", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-unrelated-version-literal-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    const exports = { ".": { types: "./dist/index.d.ts" } };
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" })),
        writeFile(resolve(baseline, "dist/release.d.ts"), 'export declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\n'),
        writeFile(resolve(candidate, "dist/release.d.ts"), 'export declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.2";\n'),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport { BETTER_REALTIME_VERSION } from "./release.js";\nexport interface IndependentIdentity { protocolVersion: "0.1.0-alpha.1" }\n`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport { BETTER_REALTIME_VERSION } from "./release.js";\nexport interface IndependentIdentity { protocolVersion: "0.1.0-alpha.2" }\n`),
      ]);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("recursively preserves nested optional public members", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-nested-option-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    const exports = { ".": { types: "./dist/index.d.ts" } };
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\nexport interface Options { capacity?: { maxConnections?: number; maxStreams?: number } }\n`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";\nexport interface Options { capacity?: { maxStreams?: number } }\n`)
      ]);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("excludes only TypeScript recursion-limit diagnostics from shape probes", () => {
    expect(shapeProbeRecursionLines("typescript-api-shape-probes.ts(42,7): error TS2589: Type instantiation is excessively deep and possibly infinite.")).toEqual([42]);
    expect(() => shapeProbeRecursionLines("typescript-api-shape-probes.ts(42,7): error TS2344: Type 'false' does not satisfy the constraint 'true'.")).toThrow("RT_COMPAT_TYPESCRIPT_SHAPE_PROBE_FAILED");
    expect(() => shapeProbeRecursionLines("unexpected compiler output")).toThrow("RT_COMPAT_TYPESCRIPT_SHAPE_PROBE_FAILED");
    const shapeLine = "type PreservedShape_fixture = Assert<true>;";
    expect(candidateShapeRecursionExclusions("typescript-api-compatibility.ts(2,7): error TS2589: Type instantiation is excessively deep.", ["type Prelude = true;", shapeLine], { [shapeLine]: "./react:UseRealtimeResult:0" })).toEqual({ lines: [2], excluded: ["./react:UseRealtimeResult:0"] });
  });

  it("preserves runtime namespace keys for active and inactive export conditions", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-runtime-conditions-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "dist/react.js"), "export function createRealtimeReact() {}\n"),
        writeFile(resolve(baseline, "dist/node-only.js"), "export function nodeOnly() {}\n"),
        writeFile(resolve(candidate, "dist/index.js"), "export function createRealtimeClient() {}\n"),
        writeFile(resolve(candidate, "dist/node-only.js"), "export function nodeOnly() {}\n")
      ]);
      const baselineExports = { "./react": { import: "./dist/react.js", browser: "./dist/node-only.js" } };
      const wrongRuntime = { "./react": { import: "./dist/index.js", browser: "./dist/node-only.js" } };
      await expect(compareRuntimeExportConditions(baseline, candidate, baselineExports, wrongRuntime)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      const missingBrowser = { "./react": { import: "./dist/index.js", browser: "./dist/missing.js" } };
      await expect(compareRuntimeExportConditions(baseline, candidate, baselineExports, missingBrowser)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      const validBaselineRoot = { ".": { import: "./dist/index.js" } };
      const invalidAdditiveCondition = { ".": { import: "./dist/index.js", browser: "./dist/missing.js" } };
      await expect(compareRuntimeExportConditions(candidate, candidate, validBaselineRoot, invalidAdditiveCondition)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("validates JSON export identity and rejects non-runtime condition category drift", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-non-runtime-conditions-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ name: "better-realtime", version: "0.1.0-alpha.1", license: "MIT", repository: { type: "git", url: "https://example.test/source" }, bugs: { url: "https://example.test/issues" } })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ name: "better-realtime", version: "0.1.0-alpha.2", license: "MIT", repository: { type: "git", url: "https://example.test/source" }, bugs: { url: "https://example.test/issues" } })),
        writeFile(resolve(candidate, "dist/other.d.ts"), "export interface Other {}\n"),
        writeFile(resolve(candidate, "dist/other.json"), JSON.stringify({ name: "other", version: "0.1.0-alpha.2" }))
      ]);
      const baselineExports = { "./package.json": { default: "./package.json" } };
      await expect(compareRuntimeExportConditions(baseline, candidate, baselineExports, { "./package.json": { default: "./dist/other.d.ts" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await expect(compareRuntimeExportConditions(baseline, candidate, baselineExports, { "./package.json": { default: "./dist/other.json" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await expect(compareRuntimeExportConditions(baseline, candidate, baselineExports, { "./package.json": { default: "./package.json" } })).resolves.toEqual([]);
      await writeFile(resolve(candidate, "package.json"), JSON.stringify({ name: "better-realtime", version: "0.1.0-alpha.2", license: "MIT", repository: { type: "git" }, bugs: { url: "https://example.test/issues" } }));
      await expect(compareRuntimeExportConditions(baseline, candidate, baselineExports, { "./package.json": { default: "./package.json" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("rejects invalid declaration targets on candidate-added package subpaths", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-added-types-"));
    const candidate = resolve(work, "candidate");
    try {
      await mkdir(resolve(candidate, "dist"), { recursive: true });
      await Promise.all([
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ name: "better-realtime", version: "0.1.0-alpha.2" })),
        writeFile(resolve(candidate, "dist/addon.js"), "export const addon = true;\n"),
        writeFile(resolve(candidate, "dist/addon.json"), JSON.stringify({ addon: true })),
        writeFile(resolve(candidate, "dist/addon.d.ts"), "export interface Broken { value: MissingPublicType }\n")
      ]);
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { types: "./dist/addon.json", import: "./dist/addon.js" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { types: "./dist/addon.d.ts", import: "./dist/addon.js" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await writeFile(resolve(candidate, "dist/addon.d.ts"), "export declare const addon: boolean;\n");
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { import: "./dist/addon.js" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { import: "./dist/addon.js", types: "./dist/addon.d.ts" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { types: "./dist/addon.d.ts", import: "./dist/addon.js" } })).resolves.toEqual([]);
      await writeFile(resolve(candidate, "dist/addon.d.ts"), "export declare const other: string;\n");
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { types: "./dist/addon.d.ts", import: "./dist/addon.js" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await writeFile(resolve(candidate, "dist/addon.d.ts"), "export declare const addon: string;\n");
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { types: "./dist/addon.d.ts", import: "./dist/addon.js" } })).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
      await writeFile(resolve(candidate, "dist/addon.js"), "export class Widget {}\n");
      await writeFile(resolve(candidate, "dist/addon.d.ts"), "export declare class Widget {}\n");
      await expect(compareRuntimeExportConditions(candidate, candidate, {}, { "./addon": { types: "./dist/addon.d.ts", import: "./dist/addon.js" } })).resolves.toEqual([]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("preserves public members inside array elements and discriminated union branches", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-array-union-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    const exports = { ".": { types: "./dist/index.d.ts" } };
    const baselineTypes = `
export interface DoctorQueryDefinition { expectedBoundaries: Array<{ boundary: string; runtimeId?: string; runtimeBootId?: string }> }
export type DiagnosticQueryRequest = { kind: "raw_evidence"; filters?: { runtimeId?: string; boundary?: string } } | { kind: "doctor"; expectedOutcome: string };
`;
    const candidateTypes = `
export interface DoctorQueryDefinition { expectedBoundaries: Array<{ boundary: string; runtimeBootId?: string }> }
export type DiagnosticQueryRequest = { kind: "raw_evidence" } | { kind: "doctor"; expectedOutcome: string };
`;
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";${baselineTypes}`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";${candidateTypes}`)
      ]);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it("requires packed runtime and CLI version identity to match package.json", async () => {
    const candidate = await mkdtemp(resolve(tmpdir(), "compatibility-runtime-version-"));
    try {
      await mkdir(resolve(candidate, "dist"), { recursive: true });
      await Promise.all([
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2", exports: { ".": { import: "./dist/index.js" } }, bin: { "better-realtime": "./dist/cli-bin.js" } })),
        writeFile(resolve(candidate, "dist/index.js"), 'export const BETTER_REALTIME_VERSION = "0.1.0-alpha.1";\n'),
        writeFile(resolve(candidate, "dist/cli-bin.js"), 'process.stdout.write("0.1.0-alpha.2\\n");\n')
      ]);
      await expect(assertCandidateRuntimeReleaseIdentity(candidate)).rejects.toThrow("RT_COMPAT_RUNTIME_RELEASE_IDENTITY_MISMATCH");
      await writeFile(resolve(candidate, "dist/index.js"), 'export const BETTER_REALTIME_VERSION = "0.1.0-alpha.2";\n');
      await writeFile(resolve(candidate, "dist/cli-bin.js"), 'process.stdout.write("0.1.0-alpha.1\\n");\n');
      await expect(assertCandidateRuntimeReleaseIdentity(candidate)).rejects.toThrow("RT_COMPAT_CLI_RELEASE_IDENTITY_MISMATCH");
    } finally { await rm(candidate, { recursive: true, force: true }); }
  });

  it("detects loss of TName precision with a multi-command contract witness", async () => {
    const work = await mkdtemp(resolve(tmpdir(), "compatibility-contract-alias-"));
    const baseline = resolve(work, "baseline");
    const candidate = resolve(work, "candidate");
    const exports = { ".": { types: "./dist/index.d.ts" } };
    const common = `${syntheticContractTypes}\nexport declare const BETTER_REALTIME_VERSION: "0.1.0-alpha.1";`;
    try {
      await Promise.all([mkdir(resolve(baseline, "dist"), { recursive: true }), mkdir(resolve(candidate, "dist"), { recursive: true })]);
      await Promise.all([
        writeFile(resolve(baseline, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(candidate, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" })),
        writeFile(resolve(baseline, "dist/index.d.ts"), `${common}\nexport type CommandInput<TContract extends RealtimeContract<any, any>, TName extends keyof TContract["commands"]> = TContract["commands"][TName] extends CommandContract<infer TInput, any> ? TInput : never;\n`),
        writeFile(resolve(candidate, "dist/index.d.ts"), `${common}\nexport type CommandInput<TContract extends RealtimeContract<any, any>, TName extends keyof TContract["commands"]> = TContract["commands"][keyof TContract["commands"]] extends CommandContract<infer TInput, any> ? TInput : never;\n`)
      ]);
      await expect(compareTypeScriptApiCompatibility(baseline, candidate, exports, exports, work)).resolves.toEqual([expect.objectContaining({ surface: "typescriptApiCompatibility", requiredClassification: "intentionally_breaking" })]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});

const syntheticContractTypes = `
export interface RuntimeSchema<T, TSchema = unknown, TIdentity extends string = string> { readonly value: T; readonly schema: TSchema; readonly identity: TIdentity }
export interface StreamContract<TInput, TSnapshot, TEvents> { readonly input: TInput; readonly snapshot: TSnapshot; readonly events: TEvents }
export interface CommandContract<TInput, TResult> { readonly input: TInput; readonly result: TResult }
export interface RealtimeContract<TStreams, TCommands> { readonly streams: TStreams; readonly commands: TCommands }
`;
