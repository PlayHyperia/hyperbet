import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import * as database from "/app/keeper/src/db.ts";
import { operationFixtures } from "./operation-fixtures.mjs";

if (process.argv[2] === "failure") {
  const directory = process.env.KEEPER_TEST_DIRECTORY;
  spawn(process.execPath, [new URL("./runtime-isolation-fixture.mjs", import.meta.url).pathname, "bot"], { env: process.env, stdio: "inherit" });
  const deadline = Date.now() + 3000;
  while (!existsSync(`${directory}/heartbeat`)) {
    if (Date.now() > deadline) throw new Error("Fixture bot startup timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  database.saveWalletDisplay("uncertain-wallet", "committed-before-error");
  writeFileSync(`${directory}/continued`, "unsafe continuation");
} else {
  for (const [name, args] of Object.entries(operationFixtures)) database[name](...args);
  database.saveIdentityMembers("canonical", new Set(["wallet", "second"]));
  const hydrated = database.loadAll();
  assert(hydrated.walletDisplay instanceof Map);
  assert.deepEqual(hydrated.identityMembers.get("canonical"), new Set(["wallet", "second"]));
  assert.equal(hydrated.walletDisplay.get("wallet"), "Fixture");
  assert.equal(hydrated.bets.length, 1);
  assert.equal(existsSync("/app/keeper/keeper.sqlite"), false, "type-only native module must not open a local database");
  console.log("Built host shim: all 20 database exports and hydrated collection types passed over HTTPS");
}
