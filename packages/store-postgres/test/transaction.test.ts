import { DatabaseError, type Pool } from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import { classifyCommitFailure, TRANSACTION_OPERATIONS, TransactionStateMachine } from "../src/transaction.ts";
import { canonicalCommandTransactionIntent, POSTGRES_STORAGE_VERSION, PostgresEventLog, TRANSACTION_ATTEMPT_RETENTION_MS, type ExecuteCommandTransactionOptions } from "../src/index.ts";

describe("PostgreSQL transaction outcome classification", () => {
  it.each([
    ["08007", "transaction resolution unknown"],
    ["40003", "statement completion unknown"]
  ])("classifies SQLSTATE %s as indeterminate", (code, message) => {
    const error = new DatabaseError(message, 0, "error");
    error.code = code;
    expect(classifyCommitFailure(error)).toMatchObject({ state: "indeterminate", proofSource: "commit_ack_unavailable", sqlstate: code });
  });

  it.each([
    new Error("Connection terminated unexpectedly"),
    Object.assign(new Error("timeout expired"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("operation cancelled"), { code: "ABORT_ERR" })
  ])("conservatively classifies client and transport errors as indeterminate", (error) => {
    expect(classifyCommitFailure(error)).toMatchObject({ state: "indeterminate", proofSource: "commit_ack_unavailable" });
  });

  it("accepts an authoritative deferred-constraint abort response as rollback proof", () => {
    const error = new DatabaseError("deferred foreign key violation", 0, "error");
    error.code = "23503";
    expect(classifyCommitFailure(error)).toEqual({ state: "rolled_back", proofSource: "postgres_error_response", sqlstate: "23503" });
  });

  it("enforces the transaction outcome transition graph", () => {
    const transaction = new TransactionStateMachine();
    transaction.transition("commit_in_flight");
    transaction.transition("indeterminate");
    transaction.transition("reconciling");
    transaction.transition("reconciled", "committed");
    expect(transaction.state).toBe("reconciled");
    expect(transaction.resolution).toBe("committed");
    expect(() => transaction.transition("committed")).toThrow("RT_TRANSACTION_STATE_INVALID");
  });

  it("keeps every write-path COMMIT behind the centralized classifier", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const schema = await readFile(new URL("../src/migrations.ts", import.meta.url), "utf8");
    expect(source.match(/query\("COMMIT"\)/g)).toHaveLength(1);
    expect(source).not.toMatch(/this\.pool\.query\("(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/);
    expect(source).not.toMatch(/this\.pool\.query\("WITH[\s\S]{0,500}\b(?:UPDATE|DELETE|INSERT)\b/);
    expect(TRANSACTION_OPERATIONS).toEqual(["schema_migration", "principal_namespace", "command", "append_event", "snapshot_read", "outbox_publish", "command_retention_cleanup", "outbox_retention_cleanup", "stream_retention"]);
    for (const operation of TRANSACTION_OPERATIONS) expect(schema).toContain(`'${operation}'`);
  });

  it("keeps deploy migration, runtime startup, framework SQL, and demo DDL structurally separated", async () => {
    const store = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const frameworkMigration = await readFile(new URL("../src/migrations.ts", import.meta.url), "utf8");
    const demoMigration = await readFile(new URL("../src/demo-migration.ts", import.meta.url), "utf8");
    const gateway = await readFile(new URL("../../server-node/src/postgres-gateway.ts", import.meta.url), "utf8");
    expect(frameworkMigration).not.toContain("realtime_room_messages");
    expect(demoMigration).toContain("realtime_room_messages");
    expect(store).toContain("async migrate(contract: ContractIdentity)");
    expect(store).not.toMatch(/async migrate\(contract: ContractIdentity\s*=/);
    expect(gateway).toContain("await this.store.assertReady(this.options.contract)");
    expect(gateway).not.toContain("await this.store.migrate()");
    expect(store).not.toMatch(/(?:FROM|JOIN|INTO|UPDATE|DELETE FROM) realtime_(?:transaction_attempts|principal_namespaces|principal_identity_aliases|events|commands|outbox|stream_retention)\b/);
  });

  it("defines storage v2 as a data-preserving command-causality migration", async () => {
    const schema = await readFile(new URL("../src/migration-v2.ts", import.meta.url), "utf8");
    const store = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(POSTGRES_STORAGE_VERSION).toBe(2);
    expect(schema).toContain("realtime_command_events");
    expect(schema).toMatch(/ALTER COLUMN event_id DROP NOT NULL/);
    expect(schema).toMatch(/INSERT INTO \$\{names\.commandEvents\}[\s\S]+SELECT [\s\S]+event_id/);
    expect(schema).not.toMatch(/DROP TABLE|TRUNCATE/);
    expect(store).toContain('schema-migration:v1');
    expect(store).not.toContain('schema-migration:v${POSTGRES_STORAGE_VERSION}');
    expect(store).toContain('this.#lockKey(`stream:${options.tenantId}:${stream}`)');
    expect(store).toContain("{ duplicate: true, requireOutboxProof: false }");
    expect(store).toContain("{ duplicate: false, requireOutboxProof: true }");
  });

  it("keeps compatibility intent overrides behind the private legacy adapter", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expectTypeOf<PostgresEventLog["executeCommandTransaction"]>().parameters.toEqualTypeOf<[options: ExecuteCommandTransactionOptions]>();
    expect(source).toContain("async executeCommandTransaction(options: ExecuteCommandTransactionOptions): Promise<CommandTransactionExecution>");
    expect(source).toContain("async #executeCommandTransaction(options: ExecuteCommandTransactionOptions, canonicalIntent: CanonicalIntent)");
    expect(source).not.toMatch(/async executeCommandTransaction\([^)]*canonicalIntent/);
  });

  it("keeps application-visible target order in the stable command intent while sorting only locks", async () => {
    const first = canonicalCommandTransactionIntent({
      commandType: "move",
      commandSchema: "move@1",
      commandInput: { itemId: "item-1" },
      resultSchema: "moveResult@1",
      targets: ["room:b", "room:a"]
    });
    const same = canonicalCommandTransactionIntent({
      commandType: "move",
      commandSchema: "move@1",
      commandInput: { itemId: "item-1" },
      resultSchema: "moveResult@1",
      targets: ["room:b", "room:a"]
    });
    const reordered = canonicalCommandTransactionIntent({
      commandType: "move",
      commandSchema: "move@1",
      commandInput: { itemId: "item-1" },
      resultSchema: "moveResult@1",
      targets: ["room:a", "room:b"]
    });
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(first).toEqual(same);
    expect(reordered.intentHash).not.toBe(first.intentHash);
    expect(first.canonical).toContain('"targets":["room:b","room:a"]');
    expect(source).toContain("const streamLocks = targets.map");
    expect(source).toMatch(/const streamLocks = targets\.map\([\s\S]{0,180}\)\.sort\(\)/u);
  });

  it("keeps store-postgres evidence producer metadata behind one source of truth", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const recordCalls = source.match(/this\.#record\(\{/g) ?? [];
    const metadataUses = source.match(/\.\.\.STORE_POSTGRES_EVIDENCE_COMPONENT/g) ?? [];

    expect(source.match(/component:\s*"store-postgres"/g)).toHaveLength(1);
    expect(source.match(/componentVersion:\s*"[^"]+"/g)).toEqual(['componentVersion: "0.3.0"']);
    expect(metadataUses).toHaveLength(recordCalls.length);
  });

  it("routes every tenant-tagged store record through trusted context instead of payload details", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const recordCalls = [...source.matchAll(/this\.#record\(([\s\S]*?)\);/gu)].map((match) => match[1]!);
    const tenantTaggedCalls = recordCalls.filter((call) =>
      /tenantId\s*:/u.test(call) || /transactionDetails\(context/u.test(call)
    );

    expect(tenantTaggedCalls.length).toBeGreaterThan(15);
    for (const call of tenantTaggedCalls) {
      expect(call).toMatch(/\}\s*,\s*(?:tenantId|options\.tenantId|identity\.tenantId|event\.tenantId|row\.tenant_id|context\.tenantId|options\.context\.tenantId)\s*$/u);
    }
    expect(source).toContain("#record(input: RecordInput, tenantId?: string)");
    expect(source).not.toMatch(/#record\(input:[\s\S]{0,400}input\.details/u);
  });

  it("keeps the reconciliation deadline inside exact-attempt marker retention", () => {
    expect(() => new PostgresEventLog({} as Pool, undefined, { reconciliationTimeoutMs: TRANSACTION_ATTEMPT_RETENTION_MS })).toThrow("RT_TRANSACTION_TIMEOUTS_EXCEED_ATTEMPT_RETENTION");
  });

  it("requires a bounded pg pool acquisition timeout", () => {
    expect(() => new PostgresEventLog({ options: { connectionTimeoutMillis: 0 } } as unknown as Pool)).toThrow("RT_POOL_CONNECTION_TIMEOUT_UNBOUNDED");
    expect(() => new PostgresEventLog({ options: { connectionTimeoutMillis: 101 } } as unknown as Pool, undefined, { reconciliationTimeoutMs: 100 })).toThrow("RT_POOL_CONNECTION_TIMEOUT_UNBOUNDED");
  });
});
