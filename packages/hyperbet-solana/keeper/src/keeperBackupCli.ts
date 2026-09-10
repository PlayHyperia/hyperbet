import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLaunchCluster,
  createKeeperBackup,
  verifyKeeperBackup,
} from "./keeperBackup";

function requireArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  if (!value || !value.slice(prefix.length).trim()) {
    throw new Error(`missing required --${name}=<value>`);
  }
  return value.slice(prefix.length).trim();
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "create") {
    const evidence = await createKeeperBackup({
      sourcePath: requireArg("source"),
      backupPath: requireArg("backup"),
      evidencePath: requireArg("evidence"),
      releaseSha: requireArg("release-sha"),
      cluster: assertLaunchCluster(requireArg("cluster")),
    });
    console.log(
      JSON.stringify({
        ok: true,
        action: "create",
        backupFileName: evidence.backupFileName,
        backupSha256: evidence.backupSha256,
        backupBytes: evidence.backupBytes,
      }),
    );
    return;
  }
  if (command === "verify") {
    const evidence = await verifyKeeperBackup({
      backupPath: requireArg("backup"),
      evidencePath: requireArg("evidence"),
      expectedReleaseSha: requireArg("release-sha"),
      expectedCluster: assertLaunchCluster(requireArg("cluster")),
    });
    console.log(
      JSON.stringify({
        ok: true,
        action: "verify",
        backupFileName: evidence.backupFileName,
        backupSha256: evidence.backupSha256,
        backupBytes: evidence.backupBytes,
      }),
    );
    return;
  }
  throw new Error(
    "usage: keeper-backup <create|verify> --backup=... --evidence=...",
  );
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(
      `keeper backup failed: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
    process.exitCode = 1;
  }
}
