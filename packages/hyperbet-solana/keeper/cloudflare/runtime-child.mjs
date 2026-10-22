import { spawn } from "node:child_process";
import { readProcessIdentity } from "./runtime-isolation.mjs";

const identity = readProcessIdentity();
if (identity.group !== process.pid || identity.session !== process.pid || process.pid <= 1 ||
    identity.parent !== Number(process.env.KEEPER_SUPERVISOR_PID)) {
  throw new Error("Keeper child must be a supervised session leader");
}
const command = process.argv.slice(2);
if (!command.length) throw new Error("Keeper child command is missing");
process.env.KEEPER_PROCESS_GROUP_ID = String(process.pid);
const child = spawn(command[0], command.slice(1), { env: process.env, stdio: "inherit" });
// Group signals also reach the application. Keep the leader alive until it exits.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
child.on("error", () => { process.exitCode = 1; });
child.on("close", code => { process.exit(code ?? 1); });
