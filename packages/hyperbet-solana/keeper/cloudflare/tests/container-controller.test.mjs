import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createStorageExecutor } from "../storage-executor.mjs";
import { createContainerController } from "../container-controller.mjs";

const snapshot = "a".repeat(64);
function fixture() {
  const db = new Database(":memory:");
  const storage = {
    sql: { exec(sql, ...args) {
      const rows = db.query(sql).all(...args);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync: fn => db.transaction(fn)(),
  };
  createStorageExecutor(storage, {});
  storage.sql.exec("UPDATE _keeper_control SET phase='imported',snapshot_sha256=? WHERE id=1", snapshot);
  const tasks = [];
  let resolve, reject;
  let monitoring;
  const container = {
    running: false, starts: 0, destroys: 0, options: null,
    start(options) {
      assert.equal(this.running, false);
      this.options = options; this.starts++; this.running = true;
      monitoring = new Promise((yes, no) => { resolve = yes; reject = no; });
    },
    monitor: () => monitoring,
    inspect: async () => ({ labels: container.options.labels }),
    setInactivityTimeout: async () => {},
    async destroy() { this.destroys++; this.running = false; resolve?.(); },
    exit(error) { this.running = false; error ? reject(error) : resolve(); },
  };
  const make = () => createContainerController({ storage, container, waitUntil: task => tasks.push(task) });
  return { db, storage, container, make, tasks, controller: make(), settle: () => Promise.all(tasks) };
}

{
  const f = fixture();
  try {
    assert.equal(f.controller.canProxy(), false);
    await f.controller.recover();
    assert.equal(f.container.starts, 0);
    const first = await f.controller.activate(snapshot, { KEEPER_STORAGE_OWNER_ID: "untrusted" });
    assert.equal(f.container.options.env.KEEPER_STORAGE_OWNER_ID, first.ownerId);
    assert.equal(f.controller.canProxy(), true);
    await assert.rejects(f.controller.activate(snapshot, {}), /container-not-stopped/);
    const recovered = f.make();
    await recovered.recover();
    assert.equal(f.container.starts, 1, "DO reconstruction must not start another process");
    f.container.exit(Object.assign(new Error("fixture"), { exitCode: 78 }));
    await f.settle();
    assert.equal(recovered.status().phase, "frozen");
    assert.equal(recovered.status().state, "reconcile");
    assert.equal(recovered.canProxy(), false);
    await assert.rejects(recovered.activate(snapshot, {}), /container-not-stopped/);
    await assert.rejects(recovered.reconcile(crypto.randomUUID(), "b".repeat(64)), /not-admitted/);
    await recovered.reconcile(first.ownerId, "b".repeat(64));
    const second = await recovered.activate(snapshot, {});
    assert.notEqual(second.ownerId, first.ownerId);
    await recovered.stop();
    await f.settle();
    assert.equal(recovered.status().phase, "frozen");
    assert.equal(f.container.destroys, 1);
    assert.equal(f.container.starts, 2);
  } finally { f.db.close(); }
}
for (const failure of ["start", "timeout", "lost-process", "wrong-label"]) {
  const f = fixture();
  try {
    if (failure === "start") f.container.start = () => { throw new Error("private value"); };
    if (failure === "timeout") f.container.setInactivityTimeout = async () => { throw new Error("private value"); };
    if (["start", "timeout"].includes(failure)) {
      await assert.rejects(f.controller.activate(snapshot, {}), error => error.message === "Keeper storage admission: container-start-failed");
    } else {
      await f.controller.activate(snapshot, {});
      if (failure === "lost-process") { f.container.exit(); await f.settle(); }
      else f.container.inspect = async () => ({ labels: { owner: crypto.randomUUID() } });
      const recovered = f.make();
      if (failure === "wrong-label") await assert.rejects(recovered.recover(), /recovery-failed/);
      else await recovered.recover();
    }
    assert.equal(f.controller.status().phase, "frozen", failure);
    assert.equal(f.controller.canProxy(), false);
    if (f.container.running) await f.controller.stop();
    await f.settle();
  } finally { f.db.close(); }
}
{
  const f = fixture();
  try {
    let finish;
    f.container.setInactivityTimeout = () => new Promise(resolve => { finish = resolve; });
    const start = f.controller.activate(snapshot, {});
    await assert.rejects(f.controller.stop(), /operation-in-progress/);
    assert.equal(f.controller.status().phase, "active", "RPC storage remains available during startup");
    f.container.exit();
    await f.settle();
    finish();
    await assert.rejects(start, /container-start-failed/);
    assert.equal(f.controller.status().state, "reconcile");
  } finally { f.db.close(); }
}
console.log("Container controller: explicit activation, recovery, fencing, stop, reconciliation, startup failure, and concurrent control passed");
