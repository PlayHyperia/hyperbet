import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertLaunchCluster } from "./keeperBackup";
import {
  materializeKeeperRecoverySet,
  verifyMaterializedKeeperRecoverySet,
} from "./keeperRecoveryMaterialization";
import {
  createKeeperRecoverySet,
  verifyKeeperRecoverySet,
} from "./keeperRecoverySet";

function requireArg(arguments_: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = arguments_.find((argument) => argument.startsWith(prefix));
  if (!value || !value.slice(prefix.length).trim()) {
    throw new Error(`missing required --${name}=<value>`);
  }
  return value.slice(prefix.length).trim();
}

export async function runKeeperRecoverySetCli(arguments_: readonly string[]) {
  const command = arguments_[2];
  const paths = {
    keeperBackupPath: requireArg(arguments_, "keeper-backup"),
    keeperEvidencePath: requireArg(arguments_, "keeper-evidence"),
    operatorAlertBackupPath: requireArg(arguments_, "operator-alert-backup"),
    operatorAlertEvidencePath: requireArg(
      arguments_,
      "operator-alert-evidence",
    ),
    manifestPath: requireArg(arguments_, "manifest"),
  };
  const identity = {
    expectedReleaseSha: requireArg(arguments_, "release-sha"),
    expectedCluster: assertLaunchCluster(requireArg(arguments_, "cluster")),
    expectedOperatorAlertRouteId: requireArg(
      arguments_,
      "operator-alert-route-id",
    ),
  };
  const boundaryId = requireArg(arguments_, "boundary-id");
  if (command === "materialize") {
    const record = await materializeKeeperRecoverySet({
      ...paths,
      ...identity,
      expectedBoundaryId: boundaryId,
      destinationContainerPath: requireArg(arguments_, "destination-container"),
    });
    return {
      ok: true,
      action: command,
      materializationId: record.materializationId,
      recoverySetId: record.recoverySetId,
      boundaryId: record.boundaryId,
      releaseSha: record.releaseSha,
      cluster: record.cluster,
      operatorAlertRouteId: record.operatorAlertRouteId,
      materializedRootName: "active",
      keeperDatabaseRelativePath: record.files.keeperDatabase.relativePath,
      operatorAlertStateRelativePath:
        record.files.operatorAlertState.relativePath,
      verificationScope: record.verificationScope,
      activationRequiresSeparateApproval:
        record.activationRequiresSeparateApproval,
    };
  }
  if (command === "verify-materialized") {
    const record = await verifyMaterializedKeeperRecoverySet({
      ...paths,
      ...identity,
      expectedBoundaryId: boundaryId,
      materializedRootPath: requireArg(arguments_, "materialized-root"),
    });
    return {
      ok: true,
      action: command,
      materializationId: record.materializationId,
      recoverySetId: record.recoverySetId,
      boundaryId: record.boundaryId,
      releaseSha: record.releaseSha,
      cluster: record.cluster,
      operatorAlertRouteId: record.operatorAlertRouteId,
      materializedRootName: "active",
      keeperDatabaseRelativePath: record.files.keeperDatabase.relativePath,
      operatorAlertStateRelativePath:
        record.files.operatorAlertState.relativePath,
      verificationScope: record.verificationScope,
      activationRequiresSeparateApproval:
        record.activationRequiresSeparateApproval,
    };
  }
  const manifest =
    command === "create"
      ? await createKeeperRecoverySet({
          ...paths,
          ...identity,
          boundaryId,
        })
      : command === "verify"
        ? await verifyKeeperRecoverySet({
            ...paths,
            ...identity,
            expectedBoundaryId: boundaryId,
          })
        : null;
  if (!manifest) {
    throw new Error(
      "usage: keeper-recovery-set <create|verify|materialize|verify-materialized> --keeper-backup=... --keeper-evidence=... --operator-alert-backup=... --operator-alert-evidence=... --manifest=... --release-sha=... --cluster=... --operator-alert-route-id=... --boundary-id=... [--destination-container=...|--materialized-root=...]",
    );
  }
  return {
    ok: true,
    action: command,
    recoverySetId: manifest.recoverySetId,
    boundaryId: manifest.boundaryId,
    releaseSha: manifest.releaseSha,
    cluster: manifest.cluster,
    operatorAlertRouteId: manifest.operatorAlertRouteId,
    componentCreatedAtSkewMs: manifest.componentCreatedAtSkewMs,
    verificationScope: manifest.verificationScope,
    quiescentBoundaryWitnessRequired: manifest.quiescentBoundaryWitnessRequired,
  };
}

const isMain =
  import.meta.main ||
  (process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false);
if (isMain) {
  try {
    console.log(JSON.stringify(await runKeeperRecoverySetCli(process.argv)));
  } catch (error) {
    console.error(
      `keeper recovery set failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
    process.exitCode = 1;
  }
}
