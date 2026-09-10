import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertLaunchCluster } from "./keeperBackup";
import {
  createOperatorAlertStateBackup,
  restoreOperatorAlertStateBackup,
  verifyOperatorAlertStateBackup,
} from "./operatorAlertStateBackup";

function requireArg(arguments_: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = arguments_.find((argument) => argument.startsWith(prefix));
  if (!value || !value.slice(prefix.length).trim()) {
    throw new Error(`missing required --${name}=<value>`);
  }
  return value.slice(prefix.length).trim();
}

type OperatorAlertStateBackupCliResult = {
  ok: true;
  action: "create" | "restore" | "verify";
  routeId: string;
  backupFileName: string;
  backupSha256: string;
  backupBytes: number;
  deliveredIncidentActive: boolean;
  pendingDeliveryActive: boolean;
};

function result(
  action: "create" | "restore" | "verify",
  evidence: {
    routeId: string;
    backupFileName: string;
    backupSha256: string;
    backupBytes: number;
    deliveredIncidentActive: boolean;
    pendingDeliveryActive: boolean;
  },
): OperatorAlertStateBackupCliResult {
  return {
    ok: true,
    action,
    routeId: evidence.routeId,
    backupFileName: evidence.backupFileName,
    backupSha256: evidence.backupSha256,
    backupBytes: evidence.backupBytes,
    deliveredIncidentActive: evidence.deliveredIncidentActive,
    pendingDeliveryActive: evidence.pendingDeliveryActive,
  };
}

export async function runOperatorAlertStateBackupCli(
  arguments_: readonly string[],
): Promise<OperatorAlertStateBackupCliResult> {
  const command = arguments_[2];
  const common = {
    backupPath: requireArg(arguments_, "backup"),
    evidencePath: requireArg(arguments_, "evidence"),
  };
  if (command === "create") {
    const evidence = await createOperatorAlertStateBackup({
      sourcePath: requireArg(arguments_, "source"),
      ...common,
      releaseSha: requireArg(arguments_, "release-sha"),
      cluster: assertLaunchCluster(requireArg(arguments_, "cluster")),
      routeId: requireArg(arguments_, "route-id"),
    });
    return result("create", evidence);
  }
  const verification = {
    ...common,
    expectedReleaseSha: requireArg(arguments_, "release-sha"),
    expectedCluster: assertLaunchCluster(requireArg(arguments_, "cluster")),
    expectedRouteId: requireArg(arguments_, "route-id"),
  };
  if (command === "verify") {
    return result("verify", await verifyOperatorAlertStateBackup(verification));
  }
  if (command === "restore") {
    return result(
      "restore",
      await restoreOperatorAlertStateBackup({
        ...verification,
        destinationPath: requireArg(arguments_, "destination"),
      }),
    );
  }
  throw new Error(
    "usage: operator-alert-state-backup <create|verify|restore> --backup=... --evidence=... --release-sha=... --cluster=... --route-id=...",
  );
}

const isMain =
  import.meta.main ||
  (process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false);
if (isMain) {
  try {
    console.log(
      JSON.stringify(await runOperatorAlertStateBackupCli(process.argv)),
    );
  } catch (error) {
    console.error(
      `operator alert state backup failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
    process.exitCode = 1;
  }
}
