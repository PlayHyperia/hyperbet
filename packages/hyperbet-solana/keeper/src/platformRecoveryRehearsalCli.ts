import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertLaunchCluster } from "./keeperBackup";
import {
  createPlatformRecoveryRehearsal,
  verifyPlatformRecoveryRehearsal,
} from "./platformRecoveryRehearsal";

const ARGUMENTS = [
  "keeper-backup",
  "keeper-evidence",
  "operator-alert-backup",
  "operator-alert-evidence",
  "keeper-recovery-set-manifest",
  "hyperia-backup",
  "hyperia-evidence",
  "hyperia-migrations-directory",
  "platform-manifest",
  "hyperia-restore-evidence",
  "materialized-root",
  "rehearsal-manifest",
  "hyperia-release-sha",
  "hyperia-database",
  "hyperbet-release-sha",
  "cluster",
  "operator-alert-route-id",
  "boundary-id",
  "tool-timeout-ms",
  "pg-restore-executable",
] as const;

function validateArguments(arguments_: readonly string[]): "create" | "verify" {
  const command = arguments_[2];
  if (command !== "create" && command !== "verify") {
    throw new Error(
      "usage: platform-recovery-rehearsal <create|verify> with the exact documented argument set",
    );
  }
  const allowed = new Set<string>(ARGUMENTS);
  const observed = new Set<string>();
  for (const argument of arguments_.slice(3)) {
    const name = /^--([a-z-]+)=/u.exec(argument)?.[1];
    if (!name || !allowed.has(name) || observed.has(name)) {
      throw new Error(
        "platform recovery rehearsal has an unknown or duplicate argument",
      );
    }
    observed.add(name);
  }
  if (observed.size !== allowed.size) {
    throw new Error("platform recovery rehearsal argument set is incomplete");
  }
  return command;
}

function requireArg(arguments_: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const argument = arguments_.find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length).trim();
  if (!value) throw new Error(`missing required --${name}=<value>`);
  return value;
}

function requireIntegerArg(
  arguments_: readonly string[],
  name: string,
): number {
  const value = Number(requireArg(arguments_, name));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${name} must be a safe integer`);
  }
  return value;
}

export async function runPlatformRecoveryRehearsalCli(
  arguments_: readonly string[],
) {
  const command = validateArguments(arguments_);
  const input = {
    keeperBackupPath: requireArg(arguments_, "keeper-backup"),
    keeperEvidencePath: requireArg(arguments_, "keeper-evidence"),
    operatorAlertBackupPath: requireArg(arguments_, "operator-alert-backup"),
    operatorAlertEvidencePath: requireArg(
      arguments_,
      "operator-alert-evidence",
    ),
    keeperRecoverySetManifestPath: requireArg(
      arguments_,
      "keeper-recovery-set-manifest",
    ),
    hyperiaBackupPath: requireArg(arguments_, "hyperia-backup"),
    hyperiaEvidencePath: requireArg(arguments_, "hyperia-evidence"),
    hyperiaMigrationsDirectory: requireArg(
      arguments_,
      "hyperia-migrations-directory",
    ),
    platformManifestPath: requireArg(arguments_, "platform-manifest"),
    hyperiaRestoreEvidencePath: requireArg(
      arguments_,
      "hyperia-restore-evidence",
    ),
    materializedRootPath: requireArg(arguments_, "materialized-root"),
    rehearsalManifestPath: requireArg(arguments_, "rehearsal-manifest"),
    expectedHyperiaReleaseSha: requireArg(arguments_, "hyperia-release-sha"),
    expectedHyperiaDatabaseName: requireArg(arguments_, "hyperia-database"),
    expectedHyperbetReleaseSha: requireArg(arguments_, "hyperbet-release-sha"),
    expectedCluster: assertLaunchCluster(requireArg(arguments_, "cluster")),
    expectedOperatorAlertRouteId: requireArg(
      arguments_,
      "operator-alert-route-id",
    ),
    expectedBoundaryId: requireArg(arguments_, "boundary-id"),
    toolTimeoutMs: requireIntegerArg(arguments_, "tool-timeout-ms"),
    pgRestoreExecutable: requireArg(arguments_, "pg-restore-executable"),
  };
  const manifest =
    command === "create"
      ? await createPlatformRecoveryRehearsal(input)
      : await verifyPlatformRecoveryRehearsal(input);
  return {
    ok: true,
    action: command,
    rehearsalId: manifest.rehearsalId,
    platformRecoverySetId: manifest.platformRecoverySetId,
    boundaryId: manifest.boundaryId,
    hyperiaReleaseSha: manifest.hyperia.releaseSha,
    hyperbetReleaseSha: manifest.hyperbet.releaseSha,
    restoreVerificationId: manifest.hyperia.restoreVerificationId,
    materializationId: manifest.hyperbet.materializationId,
    componentCreatedAtSkewMs: manifest.componentCreatedAtSkewMs,
    verificationScope: manifest.verificationScope,
    quiescentBoundaryWitnessRequired: manifest.quiescentBoundaryWitnessRequired,
    activationRequiresSeparateApproval:
      manifest.activationRequiresSeparateApproval,
    productionCutoverAuthorized: manifest.productionCutoverAuthorized,
    restoredStateReverificationRequiredAtActivation:
      manifest.restoredStateReverificationRequiredAtActivation,
  };
}

const isMain =
  import.meta.main ||
  (process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false);
if (isMain) {
  try {
    console.log(
      JSON.stringify(await runPlatformRecoveryRehearsalCli(process.argv)),
    );
  } catch (error) {
    console.error(
      `platform recovery rehearsal failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
    process.exitCode = 1;
  }
}
