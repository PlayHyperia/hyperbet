import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { failurePath } from "./runtime-isolation.mjs";

export async function superviseKeeper(command, options = {}) {
  if (process.platform !== "linux") throw new Error("Keeper supervisor requires Linux");
  const env = { ...process.env, ...options.env, KEEPER_SUPERVISOR_PID: String(process.pid) };
  const marker = failurePath(env.KEEPER_STORAGE_OWNER_ID);
  if (existsSync(marker)) return { exitCode: 78, storageFailure: true };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./runtime-child.mjs", import.meta.url)), ...command], {
    cwd: options.cwd, env, detached: true, stdio: "inherit",
  });
  let stopping = false;
  let escalation;
  const signalGroup = signal => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 5_000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const watcher = setInterval(() => {
    if (existsSync(marker)) signalGroup("SIGKILL");
  }, 50);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", code => resolveExit(code ?? 1));
    });
    if (existsSync(marker)) {
      const failure = JSON.parse(readFileSync(marker, "utf8"));
      console.error(JSON.stringify({ event: "keeper-storage-failure", code: failure.code, requestId: failure.requestId }));
      return { exitCode: 78, storageFailure: true };
    }
    return { exitCode: stopping ? 0 : code, storageFailure: false };
  } finally {
    clearInterval(watcher);
    clearTimeout(escalation);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    signalGroup("SIGKILL");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await superviseKeeper([process.execPath, "--bun", "src/service.ts"], { cwd: root });
  process.exit(result.exitCode);
}
