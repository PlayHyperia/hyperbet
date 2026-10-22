import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { superviseKeeper } from "../runtime-supervisor.mjs";
import { assertRuntimeIsolation, failurePath } from "../runtime-isolation.mjs";

if (process.platform !== "linux") throw new Error("Run this process-isolation test in the pinned Linux container");
const root = mkdtempSync(join(tmpdir(), "keeper-supervisor-"));
const owners = [];
const fixture = new URL("./runtime-isolation-fixture.mjs", import.meta.url).pathname;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function verifyStopped(directory) {
  const before = readFileSync(`${directory}/heartbeat`, "utf8");
  await sleep(100);
  assert.equal(readFileSync(`${directory}/heartbeat`, "utf8"), before, "bot must stop producing effects");
  const pid = readFileSync(`${directory}/bot.pid`, "utf8");
  if (existsSync(`/proc/${pid}/stat`)) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0], "Z", "remaining bot process must be exited");
  }
}
function options(directory) {
  const owner = crypto.randomUUID(); owners.push(owner);
  return { env: { KEEPER_TEST_DIRECTORY: directory, KEEPER_STORAGE_OWNER_ID: owner } };
}
try {
  assert.throws(() => assertRuntimeIsolation(), /not isolated/);
  const failed = options(root);
  assert.deepEqual(await superviseKeeper([process.execPath, fixture, "failure"], failed), { exitCode: 78, storageFailure: true });
  await verifyStopped(root);
  const marker = JSON.parse(readFileSync(failurePath(failed.env.KEEPER_STORAGE_OWNER_ID), "utf8"));
  assert.equal(marker.requestId, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(await superviseKeeper([process.execPath, fixture, "normal"], failed), { exitCode: 78, storageFailure: true }, "same failed owner cannot restart");
  assert.deepEqual(await superviseKeeper([process.execPath, fixture, "normal"], options(root)), { exitCode: 0, storageFailure: false });
  rmSync(`${root}/ready`);
  rmSync(`${root}/heartbeat`);
  rmSync(`${root}/bot.pid`);
  const stopping = superviseKeeper([process.execPath, fixture, "wait"], options(root));
  const deadline = Date.now() + 3000;
  while (!existsSync(`${root}/ready`)) {
    if (Date.now() > deadline) throw new Error("Fixture service did not start");
    await sleep(10);
  }
  process.emit("SIGTERM");
  assert.deepEqual(await stopping, { exitCode: 0, storageFailure: false });
  await verifyStopped(root);
  console.log("Linux supervisor: group isolation, sibling shutdown, request receipt marker, restart rejection, and graceful stop passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  for (const owner of owners) rmSync(failurePath(owner), { force: true });
}
