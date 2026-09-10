import path from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, type FetchFn } from "@solana/web3.js";

import {
  createFinalizedSolanaRecoveryQualification,
  verifyFinalizedSolanaRecoveryQualification,
} from "./finalizedSolanaRecoveryQualification";
import { assertLaunchCluster } from "./keeperBackup";
import { sanitizeErrorMessage } from "./launchCommon";

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
  "hyperia-application-readiness",
  "materialized-root",
  "rehearsal-manifest",
  "reconciliation-manifest",
  "hyperia-release-sha",
  "hyperia-database",
  "hyperbet-release-sha",
  "cluster",
  "operator-alert-route-id",
  "boundary-id",
  "tool-timeout-ms",
  "query-timeout-ms",
  "pg-restore-executable",
  "psql-executable",
  "chain-expectation",
  "chain-expectation-sha256",
  "restored-reconciliation-sha256",
  "rpc-url-env",
  "rpc-timeout-ms",
  "finalized-evidence",
] as const;

function validateArguments(arguments_: readonly string[]): "create" | "verify" {
  const command = arguments_[2];
  if (command !== "create" && command !== "verify") {
    throw new Error(
      "usage: finalized-solana-recovery <create|verify> with the exact documented argument set",
    );
  }
  const allowed = new Set<string>(ARGUMENTS);
  const observed = new Set<string>();
  for (const argument of arguments_.slice(3)) {
    const name = /^--([a-z0-9-]+)=/u.exec(argument)?.[1];
    if (!name || !allowed.has(name) || observed.has(name)) {
      throw new Error(
        "finalized Solana recovery has an unknown or duplicate argument",
      );
    }
    observed.add(name);
  }
  if (observed.size !== allowed.size) {
    throw new Error("finalized Solana recovery argument set is incomplete");
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
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive safe integer`);
  }
  return value;
}

function connectionFromEnvironment(arguments_: readonly string[]): {
  connection: Connection;
  environmentName: string;
} {
  const environmentName = requireArg(arguments_, "rpc-url-env");
  if (!/^HYPERBET_[A-Z0-9_]{3,61}$/u.test(environmentName)) {
    throw new Error("--rpc-url-env must name a dedicated HYPERBET_ variable");
  }
  const endpoint = process.env[environmentName]?.trim();
  if (!endpoint) throw new Error(`missing required ${environmentName}`);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${environmentName} is not a valid URL`);
  }
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" &&
      !(loopback && parsed.protocol === "http:")) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(
      `${environmentName} must use HTTPS, or HTTP only on exact loopback, without URL credentials or a fragment`,
    );
  }
  const timeoutMs = requireIntegerArg(arguments_, "rpc-timeout-ms");
  if (timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("--rpc-timeout-ms must be between 1000 and 120000");
  }
  const boundedFetch = Object.assign(
    async (...[resource, options]: Parameters<FetchFn>) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const existingSignal = options?.signal;
      const signal = existingSignal
        ? AbortSignal.any([existingSignal, controller.signal])
        : controller.signal;
      try {
        return await fetch(resource, { ...options, signal });
      } finally {
        clearTimeout(timeout);
      }
    },
    { preconnect: fetch.preconnect },
  ) satisfies FetchFn;
  return {
    connection: new Connection(endpoint, {
      commitment: "finalized",
      confirmTransactionInitialTimeout: 30_000,
      fetch: boundedFetch,
    }),
    environmentName,
  };
}

export async function runFinalizedSolanaRecoveryQualificationCli(
  arguments_: readonly string[],
) {
  const command = validateArguments(arguments_);
  const { connection } = connectionFromEnvironment(arguments_);
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
    applicationReadinessPath: requireArg(
      arguments_,
      "hyperia-application-readiness",
    ),
    materializedRootPath: requireArg(arguments_, "materialized-root"),
    rehearsalManifestPath: requireArg(arguments_, "rehearsal-manifest"),
    reconciliationManifestPath: requireArg(
      arguments_,
      "reconciliation-manifest",
    ),
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
    queryTimeoutMs: requireIntegerArg(arguments_, "query-timeout-ms"),
    pgRestoreExecutable: requireArg(arguments_, "pg-restore-executable"),
    psqlExecutable: requireArg(arguments_, "psql-executable"),
    chainExpectationPath: requireArg(arguments_, "chain-expectation"),
    expectedChainExpectationSha256: requireArg(
      arguments_,
      "chain-expectation-sha256",
    ),
    expectedRestoredReconciliationSha256: requireArg(
      arguments_,
      "restored-reconciliation-sha256",
    ),
    finalizedEvidencePath: requireArg(arguments_, "finalized-evidence"),
    connection,
  };
  const evidence =
    command === "create"
      ? await createFinalizedSolanaRecoveryQualification(input)
      : await verifyFinalizedSolanaRecoveryQualification(input);
  return {
    ok: true,
    action: command,
    reconciliationRunId: evidence.reconciliationRunId,
    restoredReconciliationId: evidence.restored.reconciliationId,
    materializationId: evidence.restored.materializationId,
    boundaryId: evidence.boundaryId,
    cluster: evidence.finalizedChain.cluster,
    finalizedEndSlot: evidence.finalizedChain.finalizedEndSlot,
    duelCount: evidence.reconciliation.duelCount,
    betCount: evidence.reconciliation.betCount,
    reconciledStateSha256: evidence.reconciliation.reconciledStateSha256,
    verificationScope: evidence.verificationScope,
    databaseMutationAuthorized: evidence.databaseMutationAuthorized,
    chainMutationAuthorized: evidence.chainMutationAuthorized,
    activationRequiresSeparateApproval:
      evidence.activationRequiresSeparateApproval,
    productionCutoverAuthorized: evidence.productionCutoverAuthorized,
  };
}

function redactedFailure(
  error: unknown,
  arguments_: readonly string[],
): string {
  let message = sanitizeErrorMessage(error);
  const environmentName = arguments_
    .find((value) => value.startsWith("--rpc-url-env="))
    ?.slice("--rpc-url-env=".length)
    .trim();
  const endpoint = environmentName
    ? process.env[environmentName]?.trim()
    : null;
  if (endpoint)
    message = message.split(endpoint).join("[redacted RPC endpoint]");
  return message;
}

const isMain =
  import.meta.main ||
  (process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false);
if (isMain) {
  try {
    console.log(
      JSON.stringify(
        await runFinalizedSolanaRecoveryQualificationCli(process.argv),
      ),
    );
  } catch (error) {
    console.error(
      `finalized Solana recovery failed: ${redactedFailure(error, process.argv)}`,
    );
    process.exitCode = 1;
  }
}
