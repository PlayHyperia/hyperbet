import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createOperations, runtimeManifestSha256 } from "../.runtime/operations.ts";
import { operationFixtures } from "./operation-fixtures.mjs";

// This test only targets the disposable local Worker; no live credentials/data.
const base = "http://127.0.0.1:48921";
const adminToken = "fixture_admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const request = (path, body, token = adminToken) => fetch(`${base}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const db = new Database(":memory:");
try {
  const operations = createOperations(db);
  const originalNow = Date.now;
  try {
    Date.now = () => 100;
    for (const [name, args] of Object.entries(operationFixtures)) operations[name](...args);
  } finally { Date.now = originalNow; }
  const snapshot = {
    version: 1, sourceQuiesced: true, runtimeManifestSha256, capturedAt: "2026-10-22T00:00:00.000Z",
    schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").all(),
    tables: db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name}"`).all() })),
  };
  assert.equal((await request("/admin/status", undefined, "wrong")).status, 401);
  assert.equal((await request("/status")).status, 503);
  assert.equal((await request("/rpc", {})).status, 503);
  const imported = await request("/admin/import", snapshot);
  const body = await imported.json();
  assert.equal(imported.status, 200, JSON.stringify(body));
  assert.equal(Object.keys(body.counts).length, 15);
  for (const table of snapshot.tables) assert.equal(body.counts[table.name], table.rows.length);
  assert.equal((await request("/admin/import", snapshot)).status, 200);
  assert.equal((await request("/admin/activate", { snapshotSha256: body.digest })).status, 409);
  const status = await (await request("/admin/status")).json();
  assert.equal(status.phase, "imported");
  assert.equal(status.state, "idle");
  assert.equal(status.running, false);
  assert.equal(status.owner_id, null);
  assert.equal(status.snapshot_sha256, body.digest);
  console.log(JSON.stringify({ result: "passed", tables: 15, phase: status.phase, running: status.running, manifestSha256: runtimeManifestSha256 }));
} finally { db.close(); }
