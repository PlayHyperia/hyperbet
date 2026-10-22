import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createStorageTransport } from "../storage-transport.mjs";

if (!process.env.KEEPER_TRANSPORT_TEST_CERTS) {
  const directory = mkdtempSync(join(tmpdir(), "keeper-transport-"));
  try {
    const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", `${directory}/key.pem`, "-out", `${directory}/cert.pem`,
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    assert.equal(cert.status, 0, "test certificate generation");
    const run = spawnSync(process.execPath, [process.argv[1]], {
      env: { ...process.env, KEEPER_TRANSPORT_TEST_CERTS: directory, NODE_EXTRA_CA_CERTS: `${directory}/cert.pem` },
      stdio: "inherit",
    });
    assert.equal(run.status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else {
  const child = spawn(process.execPath, [new URL("./storage-server.mjs", import.meta.url).pathname,
    process.env.KEEPER_TRANSPORT_TEST_CERTS], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const [url] = await once(lines, "line");
  lines.close();
  const clients = [];
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const make = (timeoutMs = 2000) => {
    const client = createStorageTransport({ url, token: "a".repeat(32), ownerId, timeoutMs });
    clients.push(client); return client;
  };
  try {
    assert.throws(() => createStorageTransport({ url: "http://localhost/", token: "a".repeat(32) }), /invalid-endpoint/);
    assert.throws(() => createStorageTransport({ url, token: "bad" }), /invalid-credential/);
    const client = make();
    assert.throws(() => client.call("write", {}), /invalid-request/);
    for (const value of [undefined, NaN, Infinity, 1n, new Map(), new Date()]) {
      assert.throws(() => client.call("write", [value]), /invalid-json-value/);
    }
    const cyclic = {}; cyclic.self = cyclic;
    assert.throws(() => client.call("write", [cyclic]), /invalid-json-value/);
    const unauthorized = createStorageTransport({ url, token: "b".repeat(32), ownerId });
    clients.push(unauthorized);
    assert.throws(() => unauthorized.call("write", []), /outcome-unconfirmed/);
    for (let i = 1; i <= 100; i++) assert.equal(client.call("write", []), i);
    for (const operation of ["reject", "redirect", "wrongId"]) {
      const bad = make();
      assert.throws(() => bad.call(operation, []), /outcome-unconfirmed/);
      assert.throws(() => bad.call("write", []), /outcome-unconfirmed/);
    }
    const slow = make(150);
    assert.throws(() => slow.call("delayedWrite", []), /outcome-unconfirmed/);
    assert.throws(() => slow.call("write", []), /outcome-unconfirmed/);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(client.call("read", []), 101, "one uncertain write and no retries or later writes");
    const moduleUrl = new URL("../storage-transport.mjs", import.meta.url).href;
    const isolated = spawnSync(process.execPath, ["-e",
      `import(${JSON.stringify(moduleUrl)}).then(({createStorageTransport}) => {
        const client = createStorageTransport(${JSON.stringify({ url, token: "a".repeat(32), ownerId })});
        if (client.call("read", []) !== 101) process.exitCode = 1;
      });`,
    ], { env: process.env, encoding: "utf8", timeout: 3000 });
    assert.equal(isolated.status, 0, "storage thread must not keep a completed command alive");
    await client.close();
    assert.throws(() => client.call("read", []), /closed/);
    console.log("HTTPS transport: ordering, authentication, redirects, response correlation, uncertain writes, and close passed");
  } finally {
    await Promise.all(clients.map(client => client.close()));
    child.kill();
    await once(child, "exit");
  }
}
