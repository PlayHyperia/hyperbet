import assert from "node:assert/strict";
import { handleAdminRequest } from "../admin-request.mjs";
const adminToken = "a".repeat(40), storageToken = "s".repeat(40);
let calls = 0;
const options = {
  adminToken, storageToken, enabled: "false", manifestSha256: "b".repeat(64),
  controller: {
    status() { calls++; return { phase: "imported", running: false }; },
    activate() { calls++; return { state: "running" }; },
    stop() { calls++; return { state: "reconcile", running: false }; },
    reconcile() { calls++; return { state: "idle" }; },
  },
  storage: { sql: { exec() { throw new Error("Must not reach storage"); } } },
  runtimeEnv: () => ({}),
};
const request = (path, body, token = adminToken) => new Request(`https://fixture.invalid${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
for (const path of ["status", "import", "activate", "stop", "reconcile"]) {
  assert.equal((await handleAdminRequest(request(`/admin/${path}`, {}, storageToken), options)).status, 401);
}
assert.equal(calls, 0);
assert.equal((await handleAdminRequest(request("/admin/status"), options)).status, 200);
assert.equal((await handleAdminRequest(request("/admin/activate", { snapshotSha256: "b".repeat(64) }), options)).status, 409);
assert.equal(calls, 1, "inactive config cannot invoke activation");
assert.equal((await handleAdminRequest(request("/admin/activate", { snapshotSha256: "b".repeat(64), enabled: true }), options)).status, 400);
assert.equal((await handleAdminRequest(request("/admin/activate", { snapshotSha256: "b".repeat(64) }), { ...options, enabled: "true" })).status, 200);
assert.equal((await handleAdminRequest(request("/admin/stop", {}), options)).status, 200);
assert.equal((await handleAdminRequest(request("/admin/reconcile", { ownerId: "fixture", evidenceSha256: "c".repeat(64) }), options)).status, 200);
assert.equal((await handleAdminRequest(request("/admin/import", { sourceQuiesced: false }), options)).status, 409);
assert.equal((await handleAdminRequest(request("/admin/status"), { ...options, storageToken: adminToken })).status, 503);
const failure = await handleAdminRequest(request("/admin/activate", { snapshotSha256: "b".repeat(64) }), {
  ...options, enabled: "true", runtimeEnv: () => { throw new Error("SECRET MUST NOT LEAK"); },
});
assert.equal(failure.status, 409);
assert.equal((await failure.text()).includes("SECRET"), false);
console.log("Administrative routes: separate authentication, disabled activation, strict request fields, safe failures, and inactive import passed");
