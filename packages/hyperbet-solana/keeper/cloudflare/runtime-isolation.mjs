import { readFileSync, writeFileSync } from "node:fs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

export function readProcessIdentity(pid = process.pid) {
  if (process.platform !== "linux") throw new Error("Keeper host requires Linux process isolation");
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]) };
}

export function failurePath(ownerId = process.env.KEEPER_STORAGE_OWNER_ID) {
  if (!uuid(ownerId)) throw new Error("Invalid keeper storage owner");
  return `/tmp/keeper-storage-failure-${ownerId}.json`;
}

export function assertRuntimeIsolation() {
  const group = Number(process.env.KEEPER_PROCESS_GROUP_ID);
  const supervisor = Number(process.env.KEEPER_SUPERVISOR_PID);
  const current = readProcessIdentity();
  if (!Number.isSafeInteger(group) || group <= 1 || !Number.isSafeInteger(supervisor) || supervisor < 1 ||
      group === supervisor || current.group !== group || current.session !== group) {
    throw new Error("Keeper process group is not isolated");
  }
  const leader = readProcessIdentity(group);
  if (leader.parent !== supervisor || leader.group !== group || leader.session !== group) {
    throw new Error("Keeper process group has no supervising parent");
  }
  failurePath();
  return group;
}

/** Stop the service and bot together; only their verified isolated group is signaled. */
export function failClosed(error) {
  const group = assertRuntimeIsolation();
  const requestId = uuid(error?.requestId) ? error.requestId : null;
  const failure = { code: "storage-outcome-unconfirmed", requestId, recordedAt: new Date().toISOString() };
  try {
    writeFileSync(failurePath(), JSON.stringify(failure), { mode: 0o600, flag: "wx" });
  } catch (failureWriteError) {
    if (failureWriteError?.code !== "EEXIST") console.error("Keeper could not persist storage failure marker");
  }
  // The supervisor is outside this group and reports exit code 78 to the host.
  process.kill(-group, "SIGKILL");
  process.exit(78);
}
