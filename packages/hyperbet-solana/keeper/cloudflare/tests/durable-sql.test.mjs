import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createDurableSqlDatabase } from "../durable-sql.mjs";

const native = new Database(":memory:");
const db = createDurableSqlDatabase({
  sql: {
    exec(sql, ...bindings) {
      const rows = native.query(sql).all(...bindings);
      return { toArray: () => rows, one: () => {
        assert.equal(rows.length, 1); return rows[0];
      } };
    },
  },
  transactionSync: (fn) => native.transaction(fn)(),
});
try {
  db.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, value REAL)");
  const insert = db.prepare("INSERT INTO events (name,value) VALUES ($name,$value)");
  assert.equal(insert.run({ $name: "first", $value: 1.5 }).lastInsertRowid, 1);
  assert.throws(() => insert.run({ $name: "missing" }), /Missing keeper SQL binding/);
  assert.throws(() => insert.run({ $name: "invalid", $value: NaN }), /Invalid keeper SQL binding/);
  const transaction = db.transaction((name) => {
    insert.run({ $name: name, $value: null });
    insert.run({ $name: "first", $value: 2 });
  });
  assert.throws(() => transaction("rolled-back"), /UNIQUE/);
  assert.deepEqual(db.prepare("SELECT * FROM events WHERE id = ?").all(1), [{ id: 1, name: "first", value: 1.5 }]);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM events").all(), [{ count: 1 }]);
  console.log("Durable SQL adapter: bindings, insertion IDs, and transaction rollback passed");
} finally { native.close(); }
