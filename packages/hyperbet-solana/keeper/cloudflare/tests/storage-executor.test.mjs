import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createOperations } from "../.runtime/operations.ts";
import { createDurableSqlDatabase } from "../durable-sql.mjs";
import { createStorageExecutor } from "../storage-executor.mjs";

const native = new Database(":memory:");
const storage = {
  sql: {
    exec(sql, ...bindings) {
      const rows = native.query(sql).all(...bindings);
      return { toArray: () => rows, one: () => {
        assert.equal(rows.length, 1); return rows[0];
      } };
    },
  },
  transactionSync: fn => native.transaction(fn)(),
};
try {
  const operations = createOperations(createDurableSqlDatabase(storage));
  let execute = createStorageExecutor(storage, operations);
  const fingerprint = "a".repeat(64);
  const id = crypto.randomUUID();
  const event = { wallet: "wallet", eventType: "fixture", status: "CONFIRMED", totalPoints: 1,
    referenceType: null, referenceId: null, relatedWallet: null, createdAt: 100 };
  const call = () => execute(id, "savePointsEvent", [event], fingerprint);
  assert.throws(call, /inactive/);
  storage.sql.exec("UPDATE _keeper_control SET phase = 'active'");
  assert.throws(call, /inactive/);
  storage.sql.exec("UPDATE _keeper_control SET phase = 'imported',snapshot_sha256 = ?", "b".repeat(64));
  assert.throws(call, /inactive/);
  storage.sql.exec("UPDATE _keeper_control SET phase = 'active'");
  assert.equal(call(), 1);
  assert.equal(call(), 1);
  assert.equal(storage.sql.exec("SELECT COUNT(*) AS n FROM points_events").one().n, 1);
  execute = createStorageExecutor(storage, operations);
  assert.equal(call(), 1, "receipt survives executor reconstruction");
  assert.throws(() => execute(id, "savePointsEvent", [event], "c".repeat(64)), /request-id-conflict/);
  assert.throws(() => execute(id, "saveWalletDisplay", ["wallet", "name"], fingerprint), /request-id-conflict/);
  const membersId = crypto.randomUUID();
  execute(membersId, "saveIdentityMembers", ["canonical", new Set(["a", "b"])], fingerprint);
  assert.equal(storage.sql.exec("SELECT COUNT(*) AS n FROM identity_members").one().n, 2);
  const failing = createStorageExecutor(storage, {
    ...operations,
    saveWalletDisplay(...args) {
      operations.saveWalletDisplay(...args);
      throw new Error("injected failure after write");
    },
  });
  const failureId = crypto.randomUUID();
  assert.throws(() => failing(failureId, "saveWalletDisplay", ["wallet", "name"], fingerprint), /injected failure/);
  assert.equal(storage.sql.exec("SELECT COUNT(*) AS n FROM wallet_display").one().n, 0);
  assert.equal(storage.sql.exec("SELECT COUNT(*) AS n FROM _keeper_receipts WHERE request_id = ?", failureId).one().n, 0);
  const invalidResult = createStorageExecutor(storage, {
    ...operations,
    saveWalletDisplay(...args) { operations.saveWalletDisplay(...args); return () => {}; },
  });
  assert.throws(() => invalidResult(crypto.randomUUID(), "saveWalletDisplay", ["wallet", "name"], fingerprint), /Unsupported/);
  assert.equal(storage.sql.exec("SELECT COUNT(*) AS n FROM wallet_display").one().n, 0);
  storage.sql.exec("UPDATE _keeper_control SET phase = 'frozen'");
  assert.throws(call, /inactive/, "freezing rejects even a replayed receipt");
  console.log("Storage executor: inactive admission, atomic receipts, replay conflicts, nested transactions, rollback, and freeze passed");
} finally { native.close(); }
