import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createOperations } from "../.runtime/operations.ts";
import { createDurableSqlDatabase } from "../durable-sql.mjs";
import { createStorageExecutor } from "../storage-executor.mjs";
import { prepareStorageImport, importPreparedStorage } from "../storage-import.mjs";
import { operationFixtures } from "./operation-fixtures.mjs";

const databases = [];
function database() {
  const native = new Database(":memory:");
  databases.push(native);
  const storage = {
    sql: { exec(sql, ...bindings) {
      const statement = native.query(sql);
      const rows = statement.all(...bindings);
      return { columnNames: statement.columnNames, toArray: () => rows,
        one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync: fn => native.transaction(fn)(),
  };
  const operations = createOperations(createDurableSqlDatabase(storage));
  return { storage, operations };
}
const manifest = "a".repeat(64);
try {
  const source = database();
  for (const [operation, args] of Object.entries(operationFixtures)) source.operations[operation](...args);
  source.storage.sql.exec("UPDATE sqlite_sequence SET seq=100 WHERE name='points_events'");
  const snapshot = {
    version: 1, sourceQuiesced: true, runtimeManifestSha256: manifest, capturedAt: new Date().toISOString(),
    schema: source.storage.sql.exec("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").toArray(),
    tables: source.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray()
      .map(({ name }) => ({ name, rows: source.storage.sql.exec(`SELECT * FROM "${name}"`).toArray() })),
  };
  assert.equal(snapshot.tables.length, 15);
  const prepared = await prepareStorageImport(snapshot, manifest);
  const target = database();
  const execute = createStorageExecutor(target.storage, target.operations);
  assert.throws(() => importPreparedStorage(target.storage, { ...prepared }), /unverified-import/);
  assert.throws(() => { prepared.snapshot.tables[0].rows.push({}); });
  const imported = importPreparedStorage(target.storage, prepared);
  assert.equal(imported.phase, "imported");
  for (const table of snapshot.tables) assert.equal(imported.counts[table.name], table.rows.length);
  assert.deepEqual(importPreparedStorage(target.storage, prepared), imported);
  assert.deepEqual(target.operations.loadAll(), source.operations.loadAll());
  assert.throws(() => execute(crypto.randomUUID(), "loadAll", [], "b".repeat(64)), /inactive/);
  target.storage.sql.exec("UPDATE _keeper_control SET phase='active'");
  assert.equal(execute(crypto.randomUUID(), "savePointsEvent", operationFixtures.savePointsEvent, "b".repeat(64)), 101);
  assert.throws(() => importPreparedStorage(target.storage, prepared), /import-not-admitted/);
  await assert.rejects(prepareStorageImport({ ...snapshot, sourceQuiesced: false }, manifest), /invalid-snapshot/);
  await assert.rejects(prepareStorageImport(snapshot, "c".repeat(64)), /invalid-snapshot/);
  await assert.rejects(prepareStorageImport({ ...snapshot, tables: snapshot.tables.slice(1) }, manifest), /incomplete-snapshot/);
  const unsafe = structuredClone(snapshot);
  unsafe.tables.find(table => table.name === "points_events").rows[0].id = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(prepareStorageImport(unsafe, manifest), /invalid-row/);
  const other = database();
  createStorageExecutor(other.storage, other.operations);
  const mismatch = await prepareStorageImport({ ...snapshot, schema: snapshot.schema.slice(1) }, manifest);
  assert.throws(() => importPreparedStorage(other.storage, mismatch), /schema-mismatch/);
  const broken = structuredClone(snapshot);
  // Fail late, after earlier tables have been inserted, to prove atomic rollback.
  broken.tables.find(table => table.name === "wallet_points").rows[0].self_points = null;
  const invalid = await prepareStorageImport(broken, manifest);
  assert.throws(() => importPreparedStorage(other.storage, invalid), /NOT NULL/);
  assert.equal(other.storage.sql.exec("SELECT COUNT(*) AS n FROM points_events").one().n, 0);
  assert.equal(other.storage.sql.exec("SELECT phase FROM _keeper_control").one().phase, "prepared");
  other.operations.saveWalletDisplay("existing", "Retain");
  assert.throws(() => importPreparedStorage(other.storage, prepared), /target-not-empty/);
  assert.equal(other.storage.sql.exec("SELECT COUNT(*) AS n FROM wallet_display").one().n, 1);
  const extra = database();
  createStorageExecutor(extra.storage, extra.operations);
  extra.storage.sql.exec("CREATE TABLE unexpected_data (value TEXT)");
  assert.throws(() => importPreparedStorage(extra.storage, prepared), /schema-mismatch/);
  console.log("Storage import: 15-table round trip, sequence counters, replay, activation gate, source checks, and atomic rollback passed");
} finally { for (const native of databases) native.close(); }
