import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { assertRuntimeIsolation, failClosed } from "../runtime-isolation.mjs";

assertRuntimeIsolation();
const directory = process.env.KEEPER_TEST_DIRECTORY;
const mode = process.argv[2];
if (mode === "normal") process.exit(0);
if (mode === "bot") {
  writeFileSync(`${directory}/bot.pid`, String(process.pid));
  setInterval(() => appendFileSync(`${directory}/heartbeat`, "."), 20);
} else {
  spawn(process.execPath, [process.argv[1], "bot"], { env: process.env, stdio: "inherit" });
  const deadline = Date.now() + 3000;
  while (!existsSync(`${directory}/heartbeat`)) {
    if (Date.now() > deadline) throw new Error("Fixture bot did not start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  writeFileSync(`${directory}/ready`, "ready");
  if (mode === "failure") failClosed({ requestId: "22222222-2222-4222-8222-222222222222" });
  else setInterval(() => {}, 1000);
}
