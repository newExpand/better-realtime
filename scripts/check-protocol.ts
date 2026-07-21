import { readFile } from "node:fs/promises";
import { stateMachineInventory, validateWireValue } from "../packages/protocol/src/index.ts";
import { diagnosticQueryResultSchemaV1, localEvidenceBundleSchemaV1, transactionOperations } from "../packages/diagnostics/src/index.ts";
import { diagnosticTransactionOperations } from "../packages/runtime/src/diagnostic-types.ts";
import { diagnosticQueryResultKinds } from "../packages/runtime/src/diagnostic-types.ts";

const fixtures = [
  ["valid-session-open.json", true],
  ["valid-session-ready.json", true],
  ["invalid-session-open.json", false]
] as const;

for (const [name, expected] of fixtures) {
  const value = JSON.parse(await readFile(new URL(`../conformance/v1/fixtures/${name}`, import.meta.url), "utf8"));
  const actual = validateWireValue(value).ok;
  if (actual !== expected) throw new Error(`${name}: expected valid=${expected}, received ${actual}`);
}

for (const [name, machine] of Object.entries(stateMachineInventory.machines)) {
  const states = new Set<string>(machine.states);
  if (!states.has(machine.initial)) throw new Error(`${name}: unknown initial state`);
  for (const transition of machine.transitions) {
    if (!states.has(transition.from) || !states.has(transition.to)) throw new Error(`${name}: invalid transition state`);
  }
  if (new Set(machine.invariants).size !== machine.invariants.length) throw new Error(`${name}: duplicate invariant`);
}

const scenarios = JSON.parse(await readFile(new URL("../conformance/v1/scenarios.json", import.meta.url), "utf8")) as { scenarios: Array<{ id: string; then: string[]; diagnostics: string[] }> };
const diagnosticQuerySchema = JSON.parse(await readFile(new URL("../spec/diagnostics/v1/query-result.schema.json", import.meta.url), "utf8"));
if (canonicalJson(diagnosticQuerySchema) !== canonicalJson(diagnosticQueryResultSchemaV1)) throw new Error("diagnostic query schema drift");
const bundleTransactionOperations = (localEvidenceBundleSchemaV1.$defs.evidenceRecord.properties.transactionOperation as { enum: readonly string[] }).enum;
const resultTransactionOperations = (diagnosticQueryResultSchemaV1.$defs.evidenceRecord.properties.transactionOperation as { enum: readonly string[] }).enum;
if (canonicalJson(bundleTransactionOperations) !== canonicalJson(transactionOperations) || canonicalJson(resultTransactionOperations) !== canonicalJson(transactionOperations) || canonicalJson(diagnosticTransactionOperations) !== canonicalJson(transactionOperations)) throw new Error("diagnostic transaction operation schema/type drift");
if (canonicalJson(diagnosticQueryResultKinds) !== canonicalJson(diagnosticQueryResultSchemaV1.properties.kind.enum)) throw new Error("diagnostic query result kind schema/type drift");
const ids = new Set<string>();
for (const scenario of scenarios.scenarios) {
  if (ids.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
  ids.add(scenario.id);
  if (scenario.then.length === 0 || scenario.diagnostics.length === 0) throw new Error(`${scenario.id}: incomplete contract`);
}

console.log(JSON.stringify({ schemaDraft: "2020-12", schemaFixturesValidated: fixtures.length, stateMachineInventoryValidated: Object.keys(stateMachineInventory.machines).length, scenarioInventoryEntriesValidated: ids.size, behavioralScenariosExecuted: 0, diagnosticQuerySchemaValidated: "1.0", inventoryStatus: "valid" }));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
