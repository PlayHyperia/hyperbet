import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { superviseKeeper } from "/app/keeper/cloudflare/runtime-supervisor.mjs";
import { failurePath } from "/app/keeper/cloudflare/runtime-isolation.mjs";

const ownerId = crypto.randomUUID();
const directory = mkdtempSync("/tmp/keeper-shim-");
const server = spawn(process.execPath, [new URL("./runtime-shim-server.mjs", import.meta.url).pathname], {
  env: { ...process.env, KEEPER_STORAGE_OWNER_ID: ownerId }, stdio: ["ignore", "pipe", "inherit"],
});
const lines = createInterface({ input: server.stdout });
const [url] = await once(lines, "line");
lines.close();
assert.match(url, /^https:\/\/localhost:\d+\/rpc$/);
const env = { KEEPER_STORAGE_OWNER_ID: ownerId, KEEPER_STORAGE_URL: url,
  KEEPER_STORAGE_TOKEN: "a".repeat(32), KEEPER_TEST_DIRECTORY: directory };
const app = new URL("./runtime-shim-app.mjs", import.meta.url).pathname;
try {
  assert.deepEqual(await superviseKeeper([process.execPath, app], { env }), { exitCode: 0, storageFailure: false });
  const service = superviseKeeper([process.execPath, "--bun", "src/service.ts"], {
    cwd: "/app/keeper", env: { ...env, ENABLE_KEEPER_BOT: "false", PORT: "18879" },
  });
  let serviceResult;
  try {
    const deadline = Date.now() + 10_000;
    let status;
    while (!status && Date.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:18879/status", { signal: AbortSignal.timeout(300) });
        if (response.ok) status = await response.json();
      } catch {}
      if (!status) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status?.ok, true, "original service must boot with remote storage");
    assert.equal(status.bot.enabled, false);
    assert.equal(status.bot.running, false);
    assert.equal(status.stats.trackedBets, 1);
    for (const parser of Object.values(status.parsers)) assert.equal(parser.enabled, false);
  } finally { process.emit("SIGTERM"); serviceResult = await service; }
  assert.deepEqual(serviceResult, { exitCode: 0, storageFailure: false });
  console.log("Built original service: status and hydration passed with bot and chain parsers disabled");
  assert.deepEqual(await superviseKeeper([process.execPath, app, "failure"], { env }), { exitCode: 78, storageFailure: true });
  assert.equal(existsSync(`${directory}/continued`), false);
  const heartbeat = readFileSync(`${directory}/heartbeat`, "utf8");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(readFileSync(`${directory}/heartbeat`, "utf8"), heartbeat);
  const marker = JSON.parse(readFileSync(failurePath(ownerId), "utf8"));
  const receipt = await fetch(new URL(`/fixture/receipt/${marker.requestId}`, url), { headers: { authorization: `Bearer ${env.KEEPER_STORAGE_TOKEN}` } });
  assert.deepEqual(await receipt.json(), { receipts: 1, writes: 1 });
  console.log("Built host shim: committed response failure stopped service and bot; exactly one durable receipt remains");
} finally {
  server.kill(); await once(server, "exit");
  rmSync(directory, { recursive: true, force: true });
  rmSync(failurePath(ownerId), { force: true });
}
