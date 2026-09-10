import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { PublicKey } from "@solana/web3.js";
import { Database } from "bun:sqlite";

import { canonicalEvidenceJson } from "../src/bettingFeedEvidence";
import {
  createKeeperBackup,
  inspectKeeperDatabaseSnapshot,
  sameKeeperDatabaseInspection,
  type DatabaseInspection,
} from "../src/keeperBackup";
import { materializeKeeperRecoverySet } from "../src/keeperRecoveryMaterialization";
import { createKeeperRecoverySet } from "../src/keeperRecoverySet";
import { runPlatformRecoveryRehearsalCli } from "../src/platformRecoveryRehearsalCli";
import {
  createPlatformRecoveryRehearsal,
  verifyPlatformRecoveryRehearsal,
} from "../src/platformRecoveryRehearsal";
import { runPlatformRecoverySetCli } from "../src/platformRecoverySetCli";
import {
  createPlatformRecoverySet,
  verifyPlatformRecoverySet,
} from "../src/platformRecoverySet";
import { createInitialOperatorAlertDurableState } from "../src/operatorAlertDispatcher";
import { createOperatorAlertStateBackup } from "../src/operatorAlertStateBackup";
import { persistOperatorAlertDurableState } from "../src/operatorAlertStateStore";
import { runRestoredDuelStateReconciliationCli } from "../src/restoredDuelStateReconciliationCli";
import {
  createRestoredDuelStateReconciliation,
  verifyRestoredDuelStateReconciliation,
} from "../src/restoredDuelStateReconciliation";
import { TerminalLedger } from "../src/terminalLedger";
import { resolveSolanaV1Deployment } from "../../deployments/v1";

const OUTPUT_LIMIT = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180_000;
const ROUTE_ID = "test.platform-recovery";
const RESTORED_BET_WALLET = new PublicKey(
  new Uint8Array(32).fill(7),
).toBase58();
const RESTORED_BET_MARKET = new PublicKey(
  new Uint8Array(32).fill(9),
).toBase58();
const RESTORED_BET_ID = "restored-platform-bet";
const RESTORED_DUEL_MARKET_PROGRAM_ID =
  resolveSolanaV1Deployment("devnet").duelMarketProgramId;

type HyperiaQualification = {
  releaseSha: string;
  boundaryId: string;
  backupId: string;
  backupSha256: string;
  backupBytes: number;
  tocEntries: number;
  schemaSha256: string;
  sourceMigrationCount: number;
  recoveryTableCount: number;
  restoredRecoveryTableSha256sSha256: string;
  restoreVerificationId: string;
  restoreEvidenceSha256: string;
  applicationReadinessId: string;
  applicationReadinessSha256: string;
  applicationRecentDuelCount: number;
  applicationProjectedCompetitiveDuelCount: number;
  applicationProjectedCompetitiveDuelStateSha256: string;
  restoredServerStartupCompatible: true;
  restoredServerStatusCode: 200;
  restoredServerHealthCode: 200;
  restoredServerStreamingStateCode: 200;
  restoredServerStreamingHealthCode: 503;
  restoredServerPublicHistoryDuelCount: 1;
  restoredServerExpectedMutationTables: readonly [
    "storage",
    "streaming_scheduler_leases",
  ];
  restoredServerSourceEpochAdvancedExactlyOnce: true;
  restoredServerGracefulExitCode: 0;
  restoredServerNodeVersion: "v22.23.2";
  restoredServerBundleSha256: string;
  restoredServerLogSha256: string;
  negativeCases: readonly string[];
};

type PlatformQualificationEvidence = {
  schemaVersion: 1;
  createdAt: string;
  sourceState: "dirty_worktrees_test_only";
  hyperiaReleaseSha: string;
  hyperbetReleaseSha: string;
  boundaryId: string;
  hyperiaBackupId: string;
  keeperRecoverySetId: string;
  platformRecoverySetId: string;
  hyperiaRestoreVerificationId: string;
  keeperMaterializationId: string;
  platformRecoveryRehearsalId: string;
  restoredDuelStateReconciliationId: string;
  hyperiaApplicationReadinessId: string;
  hyperiaBackupSha256: string;
  hyperiaBackupBytes: number;
  hyperiaTocEntries: number;
  hyperiaSchemaSha256: string;
  hyperiaMigrationCount: number;
  hyperiaRecoveryTableCount: number;
  hyperiaRecoveryTableSha256sSha256: string;
  hyperiaRestoreEvidenceSha256: string;
  hyperiaApplicationReadinessSha256: string;
  platformManifestSha256: string;
  platformManifestBytes: number;
  platformRehearsalManifestSha256: string;
  platformRehearsalManifestBytes: number;
  reconciliationManifestSha256: string;
  reconciliationManifestBytes: number;
  restoredStateSha256: string;
  reconciledDuelStateSha256: string;
  reconciledDuelCount: number;
  reconciledTerminalCount: number;
  applicationRecentDuelCount: number;
  applicationProjectedCompetitiveDuelCount: number;
  applicationProjectedCompetitiveDuelStateSha256: string;
  restoredServerStartupCompatible: true;
  restoredServerStatusCode: 200;
  restoredServerHealthCode: 200;
  restoredServerStreamingStateCode: 200;
  restoredServerStreamingHealthCode: 503;
  restoredServerPublicHistoryDuelCount: 1;
  restoredServerExpectedMutationTables: readonly [
    "storage",
    "streaming_scheduler_leases",
  ];
  restoredServerSourceEpochAdvancedExactlyOnce: true;
  restoredServerGracefulExitCode: 0;
  restoredServerNodeVersion: "v22.23.2";
  restoredServerBundleSha256: string;
  restoredServerLogSha256: string;
  restoredHyperbetServiceStartupCompatible: true;
  restoredHyperbetServiceStatusCode: 200;
  restoredHyperbetServiceHealthCode: 503;
  restoredHyperbetServiceOperatorReadinessCode: 503;
  restoredHyperbetServiceStreamingStateCode: 503;
  restoredHyperbetServiceSettlementHistoryCode: 200;
  restoredHyperbetServicePublicBetCount: 1;
  restoredHyperbetServiceExactDuelIdentity: true;
  restoredHyperbetServiceWritePublishCode: 404;
  restoredHyperbetServiceLogicalStatePreserved: true;
  restoredHyperbetServiceAlertStatePreserved: true;
  restoredHyperbetServiceTransactionAuthorityAbsent: true;
  restoredHyperbetServiceExternalNetworkDisabled: true;
  restoredHyperbetServiceGracefulExitCode: 0;
  restoredHyperbetServiceBunVersion: "1.3.6";
  restoredHyperbetServiceSourceSha256: string;
  restoredHyperbetServiceLogSha256: string;
  componentCreatedAtSkewMs: number;
  verificationScope: "cross_repository_file_binding_only";
  rehearsalVerificationScope: "cross_repository_restore_evidence_binding_only";
  reconciliationVerificationScope: "cross_repository_restored_duel_state_and_application_read_projection";
  activationRequiresSeparateApproval: true;
  hyperiaNegativeCases: readonly string[];
  negativeCases: readonly string[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("bounded platform qualification command timed out"));
      }
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const observe = (chunk: Buffer, target: Buffer[]): void => {
      bytes += chunk.byteLength;
      if (bytes > OUTPUT_LIMIT) child.kill("SIGKILL");
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => observe(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => observe(chunk, stderr));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error("bounded platform qualification command could not start"),
      );
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || bytes > OUTPUT_LIMIT) {
        const diagnostic = Buffer.concat(stderr)
          .toString("utf8")
          .replace(
            /postgres(?:ql)?:\/\/[^@\s]+@/giu,
            "postgresql://[redacted]@",
          )
          .replace(/(password\s*[=:]\s*)\S+/giu, "$1[redacted]")
          .replace(
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
            "",
          )
          .trim()
          .slice(-4_096);
        reject(
          new Error(
            `bounded platform qualification command failed${diagnostic ? `: ${diagnostic}` : ""}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function docker(arguments_: readonly string[]): Promise<string> {
  try {
    return await runCommand("docker", arguments_);
  } catch (error) {
    throw new Error(
      `owned platform Docker ${arguments_[0] ?? "command"} failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
  }
}

async function waitForOwnedPostgres(
  containerName: string,
  user: string,
  databaseName: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const databaseIdentity = await docker([
        "exec",
        containerName,
        "psql",
        "--username",
        user,
        "--dbname",
        databaseName,
        "--tuples-only",
        "--no-align",
        "--set=ON_ERROR_STOP=1",
        "--command=SELECT current_database()",
      ]);
      if (databaseIdentity.trim() === databaseName) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("owned restored PostgreSQL did not become ready");
}

async function expectRejection(
  operation: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    if (message.includes(expectedMessage)) return;
    throw new Error(
      `unexpected rejection while testing ${expectedMessage}: ${message}`,
    );
  }
  throw new Error(`expected rejection was not observed: ${expectedMessage}`);
}

type RestoredDuelFixture = {
  preparationId: string;
  cycleId: string;
  duelId: string;
  duelKey: string;
  snapshotVersion: number;
  snapshotDigest: string;
  snapshot: Record<string, unknown>;
  frozenAt: number;
  lifecycleStatus: "terminal" | "retired";
  agent1Id: string;
  agent2Id: string;
  terminalOutcome: "win" | "draw" | "cancelled";
  terminalWinnerId: string | null;
  terminalWinReason: string | null;
  terminalCancellationReason: string | null;
  terminalSeed: string | null;
  terminalReplayHash: string | null;
  terminalAt: number;
};

function terminalFingerprint(fixture: RestoredDuelFixture): string {
  const outcome = fixture.terminalOutcome.toUpperCase();
  const winnerSide =
    fixture.terminalOutcome === "win"
      ? fixture.terminalWinnerId === fixture.agent1Id
        ? "A"
        : "B"
      : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        duelId: fixture.duelId,
        duelKey: fixture.duelKey,
        outcome,
        winnerSide,
        participantAId: fixture.agent1Id,
        participantBId: fixture.agent2Id,
        winnerId: fixture.terminalWinnerId,
        reason:
          fixture.terminalOutcome === "cancelled"
            ? fixture.terminalCancellationReason
            : fixture.terminalWinReason,
        seed: fixture.terminalSeed,
        replayHash: fixture.terminalReplayHash,
      }),
    )
    .digest("hex");
}

function fixtureQueryOutput(
  fixture: RestoredDuelFixture,
  databaseName: string,
  serverVersionNum: string,
  terminalSeed: string,
): string {
  return `${JSON.stringify({
    kind: "meta",
    databaseName,
    serverVersionNum,
    transactionSnapshot: "1:1:",
  })}\n${JSON.stringify({
    kind: "duel",
    preparationId: fixture.preparationId,
    cycleId: fixture.cycleId,
    duelId: fixture.duelId,
    duelKey: fixture.duelKey,
    snapshotVersion: fixture.snapshotVersion,
    snapshotDigest: fixture.snapshotDigest,
    snapshot: fixture.snapshot,
    frozenAt: String(fixture.frozenAt),
    lifecycleStatus: fixture.lifecycleStatus,
    agent1Id: fixture.agent1Id,
    agent2Id: fixture.agent2Id,
    terminalOutcome: fixture.terminalOutcome,
    terminalWinnerId: fixture.terminalWinnerId,
    terminalWinReason: fixture.terminalWinReason,
    terminalCancellationReason: fixture.terminalCancellationReason,
    terminalSeed,
    terminalReplayHash: fixture.terminalReplayHash,
    terminalAt: String(fixture.terminalAt),
  })}\n`;
}

async function createLaunchDatabase(
  databasePath: string,
  fixture: RestoredDuelFixture,
): Promise<Database> {
  assert(!existsSync(databasePath), "keeper fixture database already exists");
  await runCommand(
    process.execPath,
    ["--bun", "-e", 'import { closeDb } from "./src/db.ts"; closeDb();'],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        KEEPER_DB_PATH: databasePath,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      timeoutMs: 30_000,
    },
  );
  const terminalLedger = new TerminalLedger(databasePath);
  terminalLedger.close();
  const database = new Database(databasePath, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  const frozenAt = Number(fixture.snapshot.frozenAt);
  const betOpenTime = Number(fixture.snapshot.betOpenTime);
  const betCloseTime = Number(fixture.snapshot.betCloseTime);
  assert(
    Number.isSafeInteger(frozenAt) &&
      Number.isSafeInteger(betOpenTime) &&
      Number.isSafeInteger(betCloseTime),
    "restored duel fixture timing is invalid",
  );
  database
    .prepare(
      `INSERT INTO bets (
        id, bettor_wallet, chain, source_asset, source_amount_lamports,
        fee_amount_lamports, fee_bps, tx_signature, market_pda, duel_key,
        duel_id, invite_code, external_bet_ref, recorded_at
      ) VALUES (?, ?, 'SOLANA', 'SOL', 500, 0, 0, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      RESTORED_BET_ID,
      RESTORED_BET_WALLET,
      "1".repeat(64),
      RESTORED_BET_MARKET,
      fixture.duelKey,
      fixture.duelId,
      frozenAt,
    );
  database
    .prepare(
      `INSERT INTO bet_deployment_identities (
        bet_id, cluster, program_id, bound_at
      ) VALUES (?, 'devnet', ?, ?)`,
    )
    .run(RESTORED_BET_ID, RESTORED_DUEL_MARKET_PROGRAM_ID, frozenAt);
  database
    .prepare(
      `INSERT INTO bet_executions (
        bet_id, order_id, side, limit_price, order_behavior,
        order_amount_units, matched_amount_units, resting_amount_units,
        released_amount_units, collateral_lamports, executed_cost_lamports,
        trade_treasury_fee_lamports, trade_market_maker_fee_lamports,
        reward_eligible_lamports, verified_at
      ) VALUES (?, 'restored-order-1', 1, 500, 0, '1000', '0', '1000', '0',
        500, 0, 0, 0, 0, ?)`,
    )
    .run(RESTORED_BET_ID, frozenAt);
  database
    .prepare(
      `INSERT INTO betting_feed_competitive_snapshots (
        competitive_snapshot_digest, duel_id, duel_key,
        competitive_snapshot_json, first_source_epoch, first_seq,
        first_emitted_at
      ) VALUES (?, ?, ?, ?, 10, 1, ?)`,
    )
    .run(
      fixture.snapshotDigest,
      fixture.duelId,
      fixture.duelKey,
      canonicalEvidenceJson(fixture.snapshot),
      frozenAt,
    );
  database
    .prepare(
      `INSERT INTO betting_feed_evidence_frames (
        source_epoch, seq, emitted_at, duel_id, duel_key,
        competitive_snapshot_digest, phase, frame_digest, material_digest,
        frame_json, recorded_at
      ) VALUES (10, 1, ?, ?, ?, ?, 'RESOLUTION', ?, ?, '{}', ?)`,
    )
    .run(
      frozenAt,
      fixture.duelId,
      fixture.duelKey,
      fixture.snapshotDigest,
      "44".repeat(32),
      "55".repeat(32),
      frozenAt,
    );
  database
    .prepare(
      `INSERT INTO betting_feed_checkpoint (
        id, source_epoch, last_applied_seq, last_emitted_at, duel_id,
        competitive_snapshot_digest, bet_open_time, bet_close_time,
        fight_start_time, duel_end_time, phase, terminal,
        terminal_event_key, degraded_reason, updated_at
      ) VALUES (1, 10, 1, ?, ?, ?, ?, ?, ?, ?, 'RESOLUTION', 1, ?, NULL, ?)`,
    )
    .run(
      frozenAt,
      fixture.duelId,
      fixture.snapshotDigest,
      betOpenTime,
      betCloseTime,
      betCloseTime + 1_000,
      betCloseTime + 60_000,
      `${fixture.duelId}:terminal`,
      frozenAt,
    );
  const outcome = fixture.terminalOutcome.toUpperCase();
  const winnerSide =
    fixture.terminalOutcome === "win"
      ? fixture.terminalWinnerId === fixture.agent1Id
        ? "A"
        : "B"
      : null;
  const reason =
    fixture.terminalOutcome === "cancelled"
      ? fixture.terminalCancellationReason
      : fixture.terminalWinReason;
  database
    .prepare(
      `INSERT INTO terminal_operations (
        id, duel_id, duel_key, fingerprint, outcome, winner_side,
        participant_a_id, participant_b_id, winner_id, reason, seed,
        replay_hash, event_json, status, attempts, next_attempt_at,
        lease_owner, lease_expires_at, last_error, created_at, updated_at,
        completed_at, requeue_count, last_requeued_at, last_requeued_by
      ) VALUES (
        1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'SUCCEEDED', 1, ?,
        NULL, NULL, NULL, ?, ?, ?, 0, NULL, NULL
      )`,
    )
    .run(
      fixture.duelId,
      fixture.duelKey,
      terminalFingerprint(fixture),
      outcome,
      winnerSide,
      fixture.agent1Id,
      fixture.agent2Id,
      fixture.terminalWinnerId,
      reason,
      fixture.terminalSeed,
      fixture.terminalReplayHash,
      frozenAt,
      frozenAt,
      frozenAt,
      frozenAt,
    );
  return database;
}

function parseHyperiaQualification(stdout: string): HyperiaQualification {
  const lines = stdout.trim().split("\n");
  const parsed: unknown = JSON.parse(lines[lines.length - 1] ?? "null");
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("releaseSha" in parsed) ||
    typeof parsed.releaseSha !== "string" ||
    !("boundaryId" in parsed) ||
    typeof parsed.boundaryId !== "string" ||
    !("backupId" in parsed) ||
    typeof parsed.backupId !== "string" ||
    !("backupSha256" in parsed) ||
    typeof parsed.backupSha256 !== "string" ||
    !("backupBytes" in parsed) ||
    typeof parsed.backupBytes !== "number" ||
    !("tocEntries" in parsed) ||
    typeof parsed.tocEntries !== "number" ||
    !("schemaSha256" in parsed) ||
    typeof parsed.schemaSha256 !== "string" ||
    !("sourceMigrationCount" in parsed) ||
    typeof parsed.sourceMigrationCount !== "number" ||
    !("recoveryTableCount" in parsed) ||
    typeof parsed.recoveryTableCount !== "number" ||
    !("restoredRecoveryTableSha256sSha256" in parsed) ||
    typeof parsed.restoredRecoveryTableSha256sSha256 !== "string" ||
    !("restoreVerificationId" in parsed) ||
    typeof parsed.restoreVerificationId !== "string" ||
    !("restoreEvidenceSha256" in parsed) ||
    typeof parsed.restoreEvidenceSha256 !== "string" ||
    !("applicationReadinessId" in parsed) ||
    typeof parsed.applicationReadinessId !== "string" ||
    !("applicationReadinessSha256" in parsed) ||
    typeof parsed.applicationReadinessSha256 !== "string" ||
    !("applicationRecentDuelCount" in parsed) ||
    typeof parsed.applicationRecentDuelCount !== "number" ||
    !("applicationProjectedCompetitiveDuelCount" in parsed) ||
    typeof parsed.applicationProjectedCompetitiveDuelCount !== "number" ||
    !("applicationProjectedCompetitiveDuelStateSha256" in parsed) ||
    typeof parsed.applicationProjectedCompetitiveDuelStateSha256 !== "string" ||
    !("restoredServerStartupCompatible" in parsed) ||
    parsed.restoredServerStartupCompatible !== true ||
    !("restoredServerStatusCode" in parsed) ||
    parsed.restoredServerStatusCode !== 200 ||
    !("restoredServerHealthCode" in parsed) ||
    parsed.restoredServerHealthCode !== 200 ||
    !("restoredServerStreamingStateCode" in parsed) ||
    parsed.restoredServerStreamingStateCode !== 200 ||
    !("restoredServerStreamingHealthCode" in parsed) ||
    parsed.restoredServerStreamingHealthCode !== 503 ||
    !("restoredServerPublicHistoryDuelCount" in parsed) ||
    parsed.restoredServerPublicHistoryDuelCount !== 1 ||
    !("restoredServerExpectedMutationTables" in parsed) ||
    !Array.isArray(parsed.restoredServerExpectedMutationTables) ||
    canonicalEvidenceJson(parsed.restoredServerExpectedMutationTables) !==
      canonicalEvidenceJson(["storage", "streaming_scheduler_leases"]) ||
    !("restoredServerSourceEpochAdvancedExactlyOnce" in parsed) ||
    parsed.restoredServerSourceEpochAdvancedExactlyOnce !== true ||
    !("restoredServerGracefulExitCode" in parsed) ||
    parsed.restoredServerGracefulExitCode !== 0 ||
    !("restoredServerNodeVersion" in parsed) ||
    parsed.restoredServerNodeVersion !== "v22.23.2" ||
    !("restoredServerBundleSha256" in parsed) ||
    typeof parsed.restoredServerBundleSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.restoredServerBundleSha256) ||
    !("restoredServerLogSha256" in parsed) ||
    typeof parsed.restoredServerLogSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.restoredServerLogSha256) ||
    !("negativeCases" in parsed) ||
    !Array.isArray(parsed.negativeCases) ||
    parsed.negativeCases.length === 0 ||
    parsed.negativeCases.some(
      (negativeCase) => typeof negativeCase !== "string",
    )
  ) {
    throw new Error("Hyperia qualification output is invalid");
  }
  return {
    releaseSha: parsed.releaseSha,
    boundaryId: parsed.boundaryId,
    backupId: parsed.backupId,
    backupSha256: parsed.backupSha256,
    backupBytes: parsed.backupBytes,
    tocEntries: parsed.tocEntries,
    schemaSha256: parsed.schemaSha256,
    sourceMigrationCount: parsed.sourceMigrationCount,
    recoveryTableCount: parsed.recoveryTableCount,
    restoredRecoveryTableSha256sSha256:
      parsed.restoredRecoveryTableSha256sSha256,
    restoreVerificationId: parsed.restoreVerificationId,
    restoreEvidenceSha256: parsed.restoreEvidenceSha256,
    applicationReadinessId: parsed.applicationReadinessId,
    applicationReadinessSha256: parsed.applicationReadinessSha256,
    applicationRecentDuelCount: parsed.applicationRecentDuelCount,
    applicationProjectedCompetitiveDuelCount:
      parsed.applicationProjectedCompetitiveDuelCount,
    applicationProjectedCompetitiveDuelStateSha256:
      parsed.applicationProjectedCompetitiveDuelStateSha256,
    restoredServerStartupCompatible: true,
    restoredServerStatusCode: 200,
    restoredServerHealthCode: 200,
    restoredServerStreamingStateCode: 200,
    restoredServerStreamingHealthCode: 503,
    restoredServerPublicHistoryDuelCount: 1,
    restoredServerExpectedMutationTables: [
      "storage",
      "streaming_scheduler_leases",
    ],
    restoredServerSourceEpochAdvancedExactlyOnce: true,
    restoredServerGracefulExitCode: 0,
    restoredServerNodeVersion: "v22.23.2",
    restoredServerBundleSha256: parsed.restoredServerBundleSha256,
    restoredServerLogSha256: parsed.restoredServerLogSha256,
    negativeCases: parsed.negativeCases as string[],
  };
}

function hashFile(filePath: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

type RestoredHyperbetServiceQualification = {
  restoredHyperbetServiceStartupCompatible: true;
  restoredHyperbetServiceStatusCode: 200;
  restoredHyperbetServiceHealthCode: 503;
  restoredHyperbetServiceOperatorReadinessCode: 503;
  restoredHyperbetServiceStreamingStateCode: 503;
  restoredHyperbetServiceSettlementHistoryCode: 200;
  restoredHyperbetServicePublicBetCount: 1;
  restoredHyperbetServiceExactDuelIdentity: true;
  restoredHyperbetServiceWritePublishCode: 404;
  restoredHyperbetServiceLogicalStatePreserved: true;
  restoredHyperbetServiceAlertStatePreserved: true;
  restoredHyperbetServiceTransactionAuthorityAbsent: true;
  restoredHyperbetServiceExternalNetworkDisabled: true;
  restoredHyperbetServiceGracefulExitCode: 0;
  restoredHyperbetServiceBunVersion: "1.3.6";
  restoredHyperbetServiceSourceSha256: string;
  restoredHyperbetServiceLogSha256: string;
};

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback service port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function safeServiceLogTail(output: Buffer[]): string {
  return Buffer.concat(output)
    .toString("utf8")
    .replace(/(authorization:\s*bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(token\s*[=:]\s*)\S+/giu, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim()
    .slice(-4_096);
}

async function runRestoredHyperbetServiceStartup(input: {
  materializedRootPath: string;
  qualificationContainerPath: string;
  hyperbetReleaseSha: string;
  fixture: RestoredDuelFixture;
}): Promise<RestoredHyperbetServiceQualification> {
  const runtimeRootPath = path.join(input.qualificationContainerPath, "active");
  mkdirSync(input.qualificationContainerPath, { mode: 0o700 });
  chmodSync(input.qualificationContainerPath, 0o700);
  cpSync(input.materializedRootPath, runtimeRootPath, { recursive: true });
  chmodSync(runtimeRootPath, 0o700);
  chmodSync(path.join(runtimeRootPath, "status"), 0o700);

  const sourceDatabasePath = path.join(
    input.materializedRootPath,
    "keeper.sqlite",
  );
  const runtimeDatabasePath = path.join(runtimeRootPath, "keeper.sqlite");
  const sourceAlertPath = path.join(
    input.materializedRootPath,
    "status/operator-alert-state.json",
  );
  const runtimeAlertPath = path.join(
    runtimeRootPath,
    "status/operator-alert-state.json",
  );
  assert(
    hashFile(sourceDatabasePath).sha256 ===
      hashFile(runtimeDatabasePath).sha256 &&
      hashFile(sourceAlertPath).sha256 === hashFile(runtimeAlertPath).sha256,
    "service qualification copy does not match the materialized recovery set",
  );
  const beforeInspection: DatabaseInspection =
    inspectKeeperDatabaseSnapshot(runtimeDatabasePath);
  const beforeAlert = hashFile(runtimeAlertPath);

  const keeperRoot = path.resolve(import.meta.dirname, "..");
  const serviceSourcePath = path.join(keeperRoot, "src/service.ts");
  const serviceSource = hashFile(serviceSourcePath);
  const bunVersion = (
    await runCommand(process.execPath, ["--version"], { timeoutMs: 10_000 })
  ).trim();
  assert(bunVersion === "1.3.6", "service Bun runtime is not release-pinned");
  const servicePort = await reserveLoopbackPort();
  const botBearerToken = "restored-service-bot-health-token-0000000000000000";
  const streamBearerToken = "restored-service-stream-token-000000000000000000";
  const childEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    HYPERBET_RUNTIME_ROLE: "service",
    HYPERBET_RELEASE_SHA: input.hyperbetReleaseSha,
    PORT: String(servicePort),
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: "http://127.0.0.1:1",
    KEEPER_DB_PATH: runtimeDatabasePath,
    KEEPER_BOT_HEALTH_URL: "https://127.0.0.1:1/health/snapshot",
    KEEPER_BOT_HEALTH_BEARER_TOKEN: botBearerToken,
    KEEPER_BOT_HEALTH_TIMEOUT_MS: "500",
    KEEPER_BOT_HEALTH_POLL_MS: "1000",
    KEEPER_STREAM_STATE_FILE: path.join(
      runtimeRootPath,
      "status/service-stream-state.json",
    ),
    STREAM_STATE_SOURCE_URL: "https://127.0.0.1:1/api/streaming/state",
    STREAM_STATE_SOURCE_BEARER_TOKEN: streamBearerToken,
    STREAM_STATE_SOURCE_EVENTS_ENABLED: "false",
    STREAM_STATE_POLL_MS: "1000",
    STREAM_STATE_SOURCE_TIMEOUT_MS: "500",
    STREAM_STATE_SOURCE_MAX_BACKOFF_MS: "1000",
    CONTRACT_POLL_MS: "5000",
    HYPERBET_OPERATOR_ALERT_STATE_FILE: runtimeAlertPath,
    ITEM_MANIFEST_BASE_URL: "https://127.0.0.1:1/manifests/items",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
  const forbiddenAuthorityNames = [
    "KEEPER_FEE_PAYER_KEYPAIR",
    "ORACLE_REPORTER_KEYPAIR",
    "ORACLE_FINALIZER_KEYPAIR",
    "CLOB_MARKET_OPERATOR_KEYPAIR",
    "MARKET_MAKER_KEYPAIR",
    "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
    "CLOB_CONFIG_AUTHORITY_KEYPAIR",
    "HELIUS_API_KEY",
  ] as const;
  assert(
    forbiddenAuthorityNames.every((name) => !childEnvironment[name]),
    "service qualification environment exposed transaction authority",
  );

  const child = spawn(process.execPath, ["--bun", "src/service.ts"], {
    cwd: keeperRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  let outputBytes = 0;
  const observeOutput = (chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    output.push(chunk);
    if (outputBytes > 1024 * 1024) child.kill("SIGKILL");
  };
  child.stdout.on("data", observeOutput);
  child.stderr.on("data", observeOutput);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const request = async (
    pathname: string,
    init?: RequestInit,
  ): Promise<Response> =>
    await fetch(`http://127.0.0.1:${servicePort}${pathname}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
      ...init,
    });

  let gracefulExitCode: number | null = null;
  try {
    const startupDeadline = Date.now() + 30_000;
    let statusResponse: Response | null = null;
    while (Date.now() < startupDeadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `restored Hyperbet service exited during startup: ${safeServiceLogTail(output)}`,
        );
      }
      try {
        const candidate = await request("/status");
        if (candidate.status === 200) {
          statusResponse = candidate;
          break;
        }
      } catch {
        // The port is expected to refuse connections until Bun.serve is ready.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(statusResponse, "restored Hyperbet service startup timed out");
    const statusBody = (await statusResponse.json()) as {
      ok?: unknown;
      service?: unknown;
      release?: { commitSha?: unknown; source?: unknown };
      stream?: { publishEnabled?: unknown };
      parsers?: { solana?: { enabled?: unknown } };
      proxies?: { solanaRpc?: unknown; solanaSender?: unknown };
      stats?: { trackedBets?: unknown };
    };
    assert(
      statusBody.ok === false &&
        statusBody.service === "hyperbet-solana-backend" &&
        statusBody.release?.commitSha === input.hyperbetReleaseSha &&
        statusBody.release.source === "environment" &&
        statusBody.stream?.publishEnabled === false &&
        statusBody.parsers?.solana?.enabled === true &&
        statusBody.proxies?.solanaRpc === true &&
        statusBody.proxies.solanaSender === false &&
        statusBody.stats?.trackedBets === 1,
      "restored Hyperbet status projection is invalid",
    );

    const healthResponse = await request("/health");
    const healthBody = (await healthResponse.json()) as {
      ok?: unknown;
      release?: { commitSha?: unknown };
    };
    assert(
      healthResponse.status === 503 &&
        healthBody.ok === false &&
        healthBody.release?.commitSha === input.hyperbetReleaseSha,
      "restored Hyperbet service did not fail readiness closed",
    );
    const operatorResponse = await request("/api/operator/readiness");
    const operatorBody = (await operatorResponse.json()) as { ok?: unknown };
    assert(
      operatorResponse.status === 503 && operatorBody.ok === false,
      "restored Hyperbet operator readiness did not fail closed",
    );
    const streamResponse = await request("/api/streaming/state");
    const streamBody = (await streamResponse.json()) as {
      retryable?: unknown;
    };
    assert(
      streamResponse.status === 503 && streamBody.retryable === true,
      "restored Hyperbet stream projection did not fail closed",
    );
    const settlementResponse = await request(
      `/api/arena/settlements/${encodeURIComponent(RESTORED_BET_WALLET)}`,
    );
    const settlementBody = (await settlementResponse.json()) as {
      schemaVersion?: unknown;
      chain?: unknown;
      asset?: unknown;
      cluster?: unknown;
      programId?: unknown;
      wallet?: unknown;
      total?: unknown;
      entries?: Array<Record<string, unknown>>;
    };
    const restoredBet = settlementBody.entries?.[0];
    assert(
      settlementResponse.status === 200 &&
        settlementBody.schemaVersion === 2 &&
        settlementBody.chain === "SOLANA" &&
        settlementBody.asset === "SOL" &&
        settlementBody.cluster === "devnet" &&
        settlementBody.programId === RESTORED_DUEL_MARKET_PROGRAM_ID &&
        settlementBody.wallet === RESTORED_BET_WALLET &&
        settlementBody.total === 1 &&
        settlementBody.entries?.length === 1 &&
        restoredBet?.betId === RESTORED_BET_ID &&
        restoredBet.wallet === RESTORED_BET_WALLET &&
        restoredBet.marketPda === RESTORED_BET_MARKET &&
        restoredBet.duelId === input.fixture.duelId &&
        restoredBet.duelKey === input.fixture.duelKey &&
        restoredBet.sourceAmountLamports === "500" &&
        restoredBet.orderState === "PENDING_INDEX" &&
        restoredBet.settlementState === "NOT_READY",
      "restored Hyperbet settlement history is not exact",
    );
    const publishResponse = await request("/api/streaming/state/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert(
      publishResponse.status === 404,
      "production restored service exposed the diagnostic publish route",
    );

    child.kill("SIGTERM");
    gracefulExitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("restored Hyperbet service did not stop")),
          10_000,
        ),
      ),
    ]);
    assert(
      gracefulExitCode === 0,
      "restored Hyperbet service did not exit cleanly",
    );
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  }

  assert(
    outputBytes <= 1024 * 1024,
    "restored Hyperbet service output exceeded its bound",
  );
  const serializedLog = Buffer.concat(output).toString("utf8");
  assert(
    !serializedLog.includes(botBearerToken) &&
      !serializedLog.includes(streamBearerToken) &&
      forbiddenAuthorityNames.every((name) => !serializedLog.includes(name)),
    "restored Hyperbet service log exposed a credential or authority name",
  );
  const allowedRuntimeEntries = new Set([
    "keeper.sqlite",
    "keeper.sqlite-shm",
    "keeper.sqlite-wal",
    "recovery-materialization.json",
    "status",
  ]);
  assert(
    readdirSync(runtimeRootPath).every((entry) =>
      allowedRuntimeEntries.has(entry),
    ) &&
      readdirSync(path.join(runtimeRootPath, "status")).every(
        (entry) => entry === "operator-alert-state.json",
      ),
    "restored Hyperbet service created an unexpected runtime file",
  );
  const afterInspection = inspectKeeperDatabaseSnapshot(runtimeDatabasePath);
  const afterAlert = hashFile(runtimeAlertPath);
  assert(
    sameKeeperDatabaseInspection(beforeInspection, afterInspection),
    "restored Hyperbet service changed logical Keeper state",
  );
  assert(
    beforeAlert.sha256 === afterAlert.sha256 &&
      beforeAlert.bytes === afterAlert.bytes,
    "restored Hyperbet service changed operator-alert custody",
  );
  return {
    restoredHyperbetServiceStartupCompatible: true,
    restoredHyperbetServiceStatusCode: 200,
    restoredHyperbetServiceHealthCode: 503,
    restoredHyperbetServiceOperatorReadinessCode: 503,
    restoredHyperbetServiceStreamingStateCode: 503,
    restoredHyperbetServiceSettlementHistoryCode: 200,
    restoredHyperbetServicePublicBetCount: 1,
    restoredHyperbetServiceExactDuelIdentity: true,
    restoredHyperbetServiceWritePublishCode: 404,
    restoredHyperbetServiceLogicalStatePreserved: true,
    restoredHyperbetServiceAlertStatePreserved: true,
    restoredHyperbetServiceTransactionAuthorityAbsent: true,
    restoredHyperbetServiceExternalNetworkDisabled: true,
    restoredHyperbetServiceGracefulExitCode: 0,
    restoredHyperbetServiceBunVersion: "1.3.6",
    restoredHyperbetServiceSourceSha256: serviceSource.sha256,
    restoredHyperbetServiceLogSha256: createHash("sha256")
      .update(serializedLog)
      .digest("hex"),
  };
}

async function run(): Promise<PlatformQualificationEvidence> {
  const testRoot = mkdtempSync(path.join(tmpdir(), "platform-recovery-"));
  chmodSync(testRoot, 0o700);
  const workspaceRoot = path.resolve(import.meta.dirname, "../../../../..");
  const hyperiaRepository = path.join(workspaceRoot, "hyperia-implementation");
  const hyperiaBun = path.join(
    workspaceRoot,
    ".toolchains/bun-v1.3.14/bun-darwin-aarch64/bun",
  );
  const retainedHyperiaContainer = path.join(testRoot, "hyperia-backup");
  const retainedHyperiaRestoreEvidence = path.join(
    testRoot,
    "hyperia-postgres-restore-evidence.json",
  );
  const retainedHyperiaApplicationReadiness = path.join(
    testRoot,
    "hyperia-restored-duel-application-readiness.json",
  );
  const toolContainer = `platform-pg-tools-${randomUUID()}`;
  const pgRestoreWrapper = path.join(testRoot, "pg_restore");
  const psqlWrapper = path.join(testRoot, "psql");
  const pgpassPath = path.join(testRoot, "pgpass");
  const postgresEnvironmentPath = path.join(testRoot, "postgres.env");
  const restoredPostgresUser = "platform_recovery_test";
  const restoredPostgresPassword = `local-${randomUUID()}-${randomUUID()}`;
  const managedPgNames = [
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSFILE",
    "PGSSLMODE",
    "PGPASSWORD",
    "DATABASE_URL",
    "POSTGRES_URL",
    "PGSERVICE",
    "PGOPTIONS",
  ] as const;
  const originalPgEnvironment = Object.fromEntries(
    managedPgNames.map((name) => [name, process.env[name]]),
  ) as Record<(typeof managedPgNames)[number], string | undefined>;
  let toolContainerStarted = false;
  let database: Database | null = null;

  try {
    assert(existsSync(hyperiaRepository), "Hyperia repository is missing");
    assert(existsSync(hyperiaBun), "pinned Hyperia Bun runtime is missing");
    const hyperiaStdout = await runCommand(
      hyperiaBun,
      [
        "run",
        "--cwd",
        "packages/server",
        "db:test-backup-recovery",
        `--retained-backup-container=${retainedHyperiaContainer}`,
        `--retained-restore-evidence=${retainedHyperiaRestoreEvidence}`,
        `--retained-application-readiness=${retainedHyperiaApplicationReadiness}`,
      ],
      { cwd: hyperiaRepository },
    );
    const hyperia = parseHyperiaQualification(hyperiaStdout);
    const retainedApplicationReadinessFile = hashFile(
      retainedHyperiaApplicationReadiness,
    );
    assert(
      retainedApplicationReadinessFile.sha256 ===
        hyperia.applicationReadinessSha256 &&
        (lstatSync(retainedHyperiaApplicationReadiness).mode & 0o777) === 0o600,
      "retained Hyperia application readiness binding is invalid",
    );

    const retainedRestoreValue: unknown = JSON.parse(
      readFileSync(retainedHyperiaRestoreEvidence, "utf8"),
    );
    assert(
      retainedRestoreValue !== null &&
        typeof retainedRestoreValue === "object" &&
        !Array.isArray(retainedRestoreValue) &&
        "createdAt" in retainedRestoreValue &&
        typeof retainedRestoreValue.createdAt === "string" &&
        "restoredStateSha256" in retainedRestoreValue &&
        typeof retainedRestoreValue.restoredStateSha256 === "string" &&
        "restoredDatabaseName" in retainedRestoreValue &&
        typeof retainedRestoreValue.restoredDatabaseName === "string" &&
        "targetServerVersionNum" in retainedRestoreValue &&
        typeof retainedRestoreValue.targetServerVersionNum === "string",
      "retained Hyperia restore evidence is invalid",
    );
    const restoredDatabaseName = retainedRestoreValue.restoredDatabaseName;
    const restoredServerVersionNum =
      retainedRestoreValue.targetServerVersionNum;

    writeFileSync(
      postgresEnvironmentPath,
      `POSTGRES_USER=${restoredPostgresUser}\nPOSTGRES_PASSWORD=${restoredPostgresPassword}\nPOSTGRES_DB=${restoredDatabaseName}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(postgresEnvironmentPath, 0o600);

    await docker([
      "run",
      "--detach",
      "--name",
      toolContainer,
      "--env-file",
      postgresEnvironmentPath,
      "postgres:16-alpine",
    ]);
    toolContainerStarted = true;
    await waitForOwnedPostgres(
      toolContainer,
      restoredPostgresUser,
      restoredDatabaseName,
    );
    const restoreContainerPath = `/tmp/platform-restore-${randomUUID()}.dump`;
    try {
      await docker([
        "cp",
        path.join(retainedHyperiaContainer, "active/hyperia-postgres.dump"),
        `${toolContainer}:${restoreContainerPath}`,
      ]);
      await docker([
        "exec",
        "--env",
        `PGPASSWORD=${restoredPostgresPassword}`,
        toolContainer,
        "pg_restore",
        "--username",
        restoredPostgresUser,
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        `--dbname=${restoredDatabaseName}`,
        restoreContainerPath,
      ]);
    } finally {
      await docker([
        "exec",
        toolContainer,
        "rm",
        "-f",
        restoreContainerPath,
      ]).catch(() => undefined);
    }
    writeFileSync(
      pgRestoreWrapper,
      `#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  exec docker exec ${toolContainer} pg_restore --version
fi
if [ "$1" = "--list" ] && [ "$#" = "2" ]; then
  archive="/tmp/platform-archive.dump"
  docker cp "$2" ${toolContainer}:"$archive" >/dev/null
  status=0
  docker exec ${toolContainer} pg_restore --list "$archive" || status=$?
  docker exec ${toolContainer} rm -f "$archive" >/dev/null || true
  exit "$status"
fi
exit 64
`,
      { encoding: "utf8", flag: "wx", mode: 0o700 },
    );
    chmodSync(pgRestoreWrapper, 0o700);
    writeFileSync(
      psqlWrapper,
      `#!/bin/sh
set -eu
exec docker exec \
  -e PGHOST=127.0.0.1 \
  -e PGPORT=5432 \
  -e PGUSER=${restoredPostgresUser} \
  -e PGPASSWORD=${restoredPostgresPassword} \
  -e PGSSLMODE=disable \
  ${toolContainer} psql "$@"
`,
      { encoding: "utf8", flag: "wx", mode: 0o700 },
    );
    chmodSync(psqlWrapper, 0o700);
    writeFileSync(
      pgpassPath,
      `127.0.0.1:5432:${restoredDatabaseName}:${restoredPostgresUser}:${restoredPostgresPassword}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(pgpassPath, 0o600);
    for (const name of managedPgNames) delete process.env[name];
    process.env.PGHOST = "127.0.0.1";
    process.env.PGPORT = "5432";
    process.env.PGDATABASE = restoredDatabaseName;
    process.env.PGUSER = restoredPostgresUser;
    process.env.PGPASSFILE = pgpassPath;
    process.env.PGSSLMODE = "disable";

    const restoredDuelStdout = await runCommand(
      psqlWrapper,
      [
        "--no-psqlrc",
        "--quiet",
        "--tuples-only",
        "--no-align",
        "--set=ON_ERROR_STOP=1",
        `--dbname=${restoredDatabaseName}`,
        `--command=SELECT jsonb_build_object(
          'preparationId', snapshot."preparationId",
          'cycleId', snapshot."cycleId",
          'duelId', snapshot."duelId",
          'duelKey', snapshot."duelKey",
          'snapshotVersion', snapshot."snapshotVersion",
          'snapshotDigest', snapshot."snapshotDigest",
          'snapshot', snapshot."snapshot",
          'frozenAt', snapshot."frozenAt",
          'lifecycleStatus', snapshot."lifecycleStatus",
          'agent1Id', preparation."agent1Id",
          'agent2Id', preparation."agent2Id",
          'terminalOutcome', snapshot."terminalOutcome",
          'terminalWinnerId', snapshot."terminalWinnerId",
          'terminalWinReason', snapshot."terminalWinReason",
          'terminalCancellationReason', snapshot."terminalCancellationReason",
          'terminalSeed', snapshot."terminalSeed",
          'terminalReplayHash', snapshot."terminalReplayHash",
          'terminalAt', snapshot."terminalAt"
        )::text
        FROM "streaming_duel_competitive_snapshots" AS snapshot
        JOIN "streaming_duel_preparations" AS preparation
          ON preparation."preparationId" = snapshot."preparationId"
        WHERE snapshot."terminalAt" IS NOT NULL
        ORDER BY snapshot."duelId"`,
      ],
      { timeoutMs: 30_000 },
    );
    const restoredDuelLines = restoredDuelStdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    assert(
      restoredDuelLines.length === 1,
      "restored PostgreSQL must contain one non-vacuous terminal duel fixture",
    );
    const restoredDuelFixture = JSON.parse(
      restoredDuelLines[0]!,
    ) as RestoredDuelFixture;
    assert(
      restoredDuelFixture !== null &&
        typeof restoredDuelFixture === "object" &&
        restoredDuelFixture.terminalOutcome === "win" &&
        restoredDuelFixture.terminalWinnerId === restoredDuelFixture.agent1Id,
      "restored terminal duel fixture is invalid",
    );

    const hyperbetReleaseSha = (
      await runCommand("git", ["rev-parse", "HEAD"], {
        cwd: path.resolve(import.meta.dirname, "../../../.."),
        timeoutMs: 10_000,
      })
    ).trim();
    const keeperSourcePath = path.join(testRoot, "keeper.sqlite");
    const alertSourcePath = path.join(testRoot, "operator-alert-state.json");
    const keeperBackupPath = path.join(testRoot, "keeper.backup.sqlite");
    const keeperEvidencePath = path.join(testRoot, "keeper.evidence.json");
    const alertBackupPath = path.join(testRoot, "operator-alert.backup.json");
    const alertEvidencePath = path.join(
      testRoot,
      "operator-alert.evidence.json",
    );
    const keeperManifestPath = path.join(testRoot, "keeper-recovery-set.json");
    const platformManifestPath = path.join(
      testRoot,
      "platform-recovery-set.json",
    );
    const materializedContainerPath = path.join(
      testRoot,
      "materialized-keeper",
    );
    const materializedRootPath = path.join(materializedContainerPath, "active");
    const rehearsalManifestPath = path.join(
      testRoot,
      "platform-recovery-rehearsal.json",
    );
    const reconciliationManifestPath = path.join(
      testRoot,
      "restored-duel-state-reconciliation.json",
    );
    database = await createLaunchDatabase(
      keeperSourcePath,
      restoredDuelFixture,
    );
    persistOperatorAlertDurableState(
      alertSourcePath,
      createInitialOperatorAlertDurableState(ROUTE_ID),
    );
    const hyperiaEvidenceValue: unknown = JSON.parse(
      readFileSync(
        path.join(retainedHyperiaContainer, "active/evidence.json"),
        "utf8",
      ),
    );
    assert(
      hyperiaEvidenceValue !== null &&
        typeof hyperiaEvidenceValue === "object" &&
        !Array.isArray(hyperiaEvidenceValue) &&
        "createdAt" in hyperiaEvidenceValue &&
        typeof hyperiaEvidenceValue.createdAt === "string",
      "retained Hyperia evidence timestamp is invalid",
    );
    const baseTime = Date.parse(hyperiaEvidenceValue.createdAt);
    await createKeeperBackup({
      sourcePath: keeperSourcePath,
      backupPath: keeperBackupPath,
      evidencePath: keeperEvidencePath,
      releaseSha: hyperbetReleaseSha,
      cluster: "devnet",
      now: () => new Date(baseTime + 1_000),
    });
    await createOperatorAlertStateBackup({
      sourcePath: alertSourcePath,
      backupPath: alertBackupPath,
      evidencePath: alertEvidencePath,
      releaseSha: hyperbetReleaseSha,
      cluster: "devnet",
      routeId: ROUTE_ID,
      now: () => new Date(baseTime + 2_000),
    });
    const keeperManifest = await createKeeperRecoverySet({
      keeperBackupPath,
      keeperEvidencePath,
      operatorAlertBackupPath: alertBackupPath,
      operatorAlertEvidencePath: alertEvidencePath,
      manifestPath: keeperManifestPath,
      expectedReleaseSha: hyperbetReleaseSha,
      expectedCluster: "devnet",
      expectedOperatorAlertRouteId: ROUTE_ID,
      boundaryId: hyperia.boundaryId,
      now: () => new Date(baseTime + 3_000),
    });
    const commonInput = {
      keeperBackupPath,
      keeperEvidencePath,
      operatorAlertBackupPath: alertBackupPath,
      operatorAlertEvidencePath: alertEvidencePath,
      keeperRecoverySetManifestPath: keeperManifestPath,
      hyperiaBackupPath: path.join(
        retainedHyperiaContainer,
        "active/hyperia-postgres.dump",
      ),
      hyperiaEvidencePath: path.join(
        retainedHyperiaContainer,
        "active/evidence.json",
      ),
      hyperiaMigrationsDirectory: path.join(
        hyperiaRepository,
        "packages/server/src/database/migrations",
      ),
      platformManifestPath,
      expectedHyperiaReleaseSha: hyperia.releaseSha,
      expectedHyperiaDatabaseName: "hyperia_backup_test",
      expectedHyperbetReleaseSha: hyperbetReleaseSha,
      expectedCluster: "devnet" as const,
      expectedOperatorAlertRouteId: ROUTE_ID,
      expectedBoundaryId: hyperia.boundaryId,
      toolTimeoutMs: 30_000,
      pgRestoreExecutable: pgRestoreWrapper,
    };
    const platformManifest = await createPlatformRecoverySet({
      ...commonInput,
      now: () => new Date(baseTime + 4_000),
    });
    const verified = await verifyPlatformRecoverySet(commonInput);
    assert(
      JSON.stringify(verified) === JSON.stringify(platformManifest),
      "platform verification changed the manifest",
    );
    const cliArguments = [
      "bun",
      "platformRecoverySetCli.ts",
      "verify",
      `--keeper-backup=${keeperBackupPath}`,
      `--keeper-evidence=${keeperEvidencePath}`,
      `--operator-alert-backup=${alertBackupPath}`,
      `--operator-alert-evidence=${alertEvidencePath}`,
      `--keeper-recovery-set-manifest=${keeperManifestPath}`,
      `--hyperia-backup=${commonInput.hyperiaBackupPath}`,
      `--hyperia-evidence=${commonInput.hyperiaEvidencePath}`,
      `--hyperia-migrations-directory=${commonInput.hyperiaMigrationsDirectory}`,
      `--platform-manifest=${platformManifestPath}`,
      `--hyperia-release-sha=${hyperia.releaseSha}`,
      "--hyperia-database=hyperia_backup_test",
      `--hyperbet-release-sha=${hyperbetReleaseSha}`,
      "--cluster=devnet",
      `--operator-alert-route-id=${ROUTE_ID}`,
      `--boundary-id=${hyperia.boundaryId}`,
      "--tool-timeout-ms=30000",
      `--pg-restore-executable=${pgRestoreWrapper}`,
    ];
    const cliResult = await runPlatformRecoverySetCli(cliArguments);
    assert(
      cliResult.platformRecoverySetId ===
        platformManifest.platformRecoverySetId &&
        cliResult.activationRequiresSeparateApproval === true,
      "platform CLI verification result is invalid",
    );
    assert(
      (lstatSync(platformManifestPath).mode & 0o777) === 0o600,
      "platform manifest is not private",
    );
    const serializedManifest = readFileSync(platformManifestPath, "utf8");
    assert(
      !serializedManifest.includes(testRoot) &&
        !serializedManifest.includes(hyperiaRepository),
      "platform manifest leaked a source path",
    );
    const recoverySource = {
      keeperBackupPath,
      keeperEvidencePath,
      operatorAlertBackupPath: alertBackupPath,
      operatorAlertEvidencePath: alertEvidencePath,
      manifestPath: keeperManifestPath,
      expectedReleaseSha: hyperbetReleaseSha,
      expectedCluster: "devnet" as const,
      expectedOperatorAlertRouteId: ROUTE_ID,
      expectedBoundaryId: hyperia.boundaryId,
    };
    const rehearsalBaseTime = Math.max(
      Date.parse(retainedRestoreValue.createdAt),
      baseTime + 4_000,
    );
    const materialization = await materializeKeeperRecoverySet({
      ...recoverySource,
      destinationContainerPath: materializedContainerPath,
      now: () => new Date(rehearsalBaseTime + 1_000),
    });
    const rehearsalInput = {
      ...commonInput,
      hyperiaRestoreEvidencePath: retainedHyperiaRestoreEvidence,
      materializedRootPath,
      rehearsalManifestPath,
    };
    const rehearsalManifest = await createPlatformRecoveryRehearsal({
      ...rehearsalInput,
      now: () => new Date(rehearsalBaseTime + 2_000),
    });
    const verifiedRehearsal =
      await verifyPlatformRecoveryRehearsal(rehearsalInput);
    assert(
      JSON.stringify(rehearsalManifest) === JSON.stringify(verifiedRehearsal) &&
        rehearsalManifest.hyperbet.materializationId ===
          materialization.materializationId &&
        rehearsalManifest.hyperia.restoreVerificationId ===
          hyperia.restoreVerificationId &&
        rehearsalManifest.productionCutoverAuthorized === false,
      "platform recovery rehearsal verification changed its manifest",
    );
    const rehearsalCliArguments = [
      "bun",
      "platformRecoveryRehearsalCli.ts",
      "verify",
      ...cliArguments.slice(3),
      `--hyperia-restore-evidence=${retainedHyperiaRestoreEvidence}`,
      `--materialized-root=${materializedRootPath}`,
      `--rehearsal-manifest=${rehearsalManifestPath}`,
    ];
    const rehearsalCli = await runPlatformRecoveryRehearsalCli(
      rehearsalCliArguments,
    );
    assert(
      rehearsalCli.rehearsalId === rehearsalManifest.rehearsalId &&
        rehearsalCli.productionCutoverAuthorized === false &&
        rehearsalCli.restoredStateReverificationRequiredAtActivation === true,
      "platform recovery rehearsal CLI verification is invalid",
    );
    assert(
      (lstatSync(rehearsalManifestPath).mode & 0o777) === 0o600 &&
        !readFileSync(rehearsalManifestPath, "utf8").includes(testRoot) &&
        !readFileSync(rehearsalManifestPath, "utf8").includes(
          hyperiaRepository,
        ),
      "platform recovery rehearsal manifest is not private or path-free",
    );

    const reconciliationInput = {
      ...rehearsalInput,
      reconciliationManifestPath,
      applicationReadinessPath: retainedHyperiaApplicationReadiness,
      queryTimeoutMs: 30_000,
      psqlExecutable: psqlWrapper,
    };
    const reconciliationManifest = await createRestoredDuelStateReconciliation({
      ...reconciliationInput,
      now: () => new Date(rehearsalBaseTime + 3_000),
    });
    const verifiedReconciliation =
      await verifyRestoredDuelStateReconciliation(reconciliationInput);
    assert(
      JSON.stringify(reconciliationManifest) ===
        JSON.stringify(verifiedReconciliation) &&
        reconciliationManifest.matchedDuelCount === 1 &&
        reconciliationManifest.matchedTerminalCount === 1 &&
        reconciliationManifest.hyperia.applicationReadiness
          .applicationReadinessId === hyperia.applicationReadinessId &&
        reconciliationManifest.hyperia.applicationReadiness.recentDuelCount ===
          1 &&
        reconciliationManifest.hyperia.applicationReadiness
          .projectedCompetitiveDuelCount === 1 &&
        reconciliationManifest.hyperia.applicationReadiness
          .projectedCompetitiveDuelStateSha256 ===
          hyperia.applicationProjectedCompetitiveDuelStateSha256 &&
        reconciliationManifest.files.hyperiaApplicationReadiness.sha256 ===
          hyperia.applicationReadinessSha256 &&
        reconciliationManifest.hyperbet.evidenceFrameCount === 1 &&
        reconciliationManifest.productionCutoverAuthorized === false,
      "restored duel state did not reconcile non-vacuously",
    );
    const reconciliationCliArguments = [
      "bun",
      "restoredDuelStateReconciliationCli.ts",
      "verify",
      ...rehearsalCliArguments.slice(3),
      `--hyperia-application-readiness=${retainedHyperiaApplicationReadiness}`,
      `--reconciliation-manifest=${reconciliationManifestPath}`,
      "--query-timeout-ms=30000",
      `--psql-executable=${psqlWrapper}`,
    ];
    const reconciliationCli = await runRestoredDuelStateReconciliationCli(
      reconciliationCliArguments,
    );
    assert(
      reconciliationCli.reconciliationId ===
        reconciliationManifest.reconciliationId &&
        reconciliationCli.matchedDuelCount === 1 &&
        reconciliationCli.matchedTerminalCount === 1 &&
        reconciliationCli.applicationReadinessId ===
          hyperia.applicationReadinessId &&
        reconciliationCli.applicationRecentDuelCount === 1 &&
        reconciliationCli.applicationProjectedCompetitiveDuelCount === 1 &&
        reconciliationCli.productionCutoverAuthorized === false,
      "restored duel reconciliation CLI result is invalid",
    );
    assert(
      (lstatSync(reconciliationManifestPath).mode & 0o777) === 0o600 &&
        !readFileSync(reconciliationManifestPath, "utf8").includes(testRoot) &&
        !readFileSync(reconciliationManifestPath, "utf8").includes(
          restoredPostgresPassword,
        ),
      "restored duel reconciliation manifest is not private or secret-free",
    );

    const negativeCases: string[] = [];
    await expectRejection(
      () => createPlatformRecoverySet(commonInput),
      "manifest already exists",
    );
    negativeCases.push("overwrite_rejected");
    await expectRejection(
      () =>
        verifyPlatformRecoverySet({
          ...commonInput,
          expectedBoundaryId: "platform-boundary-drift",
        }),
      "manifest identity does not match",
    );
    negativeCases.push("boundary_drift_rejected");
    await expectRejection(
      () => runPlatformRecoverySetCli([...cliArguments, "--unknown=value"]),
      "unknown or duplicate argument",
    );
    negativeCases.push("strict_cli_arguments_enforced");
    await expectRejection(
      () => createPlatformRecoveryRehearsal(rehearsalInput),
      "rehearsal manifest already exists",
    );
    negativeCases.push("rehearsal_overwrite_rejected");
    await expectRejection(
      () =>
        runPlatformRecoveryRehearsalCli([
          ...rehearsalCliArguments,
          "--unknown=value",
        ]),
      "unknown or duplicate argument",
    );
    negativeCases.push("strict_rehearsal_cli_arguments_enforced");
    await expectRejection(
      () => createRestoredDuelStateReconciliation(reconciliationInput),
      "reconciliation manifest already exists",
    );
    negativeCases.push("reconciliation_overwrite_rejected");
    await expectRejection(
      () =>
        runRestoredDuelStateReconciliationCli([
          ...reconciliationCliArguments,
          "--unknown=value",
        ]),
      "unknown or duplicate argument",
    );
    negativeCases.push("strict_reconciliation_cli_arguments_enforced");

    chmodSync(retainedHyperiaApplicationReadiness, 0o644);
    await expectRejection(
      () => verifyRestoredDuelStateReconciliation(reconciliationInput),
      "mode-0600 regular file",
    );
    chmodSync(retainedHyperiaApplicationReadiness, 0o600);
    negativeCases.push("permissive_application_readiness_rejected");

    const originalApplicationReadiness = readFileSync(
      retainedHyperiaApplicationReadiness,
      "utf8",
    );
    const driftedApplicationReadiness: unknown = JSON.parse(
      originalApplicationReadiness,
    );
    assert(
      driftedApplicationReadiness !== null &&
        typeof driftedApplicationReadiness === "object" &&
        !Array.isArray(driftedApplicationReadiness),
      "retained application readiness fixture is invalid",
    );
    (driftedApplicationReadiness as Record<string, unknown>).boundaryId =
      "platform-boundary-readiness-drift";
    writeFileSync(
      retainedHyperiaApplicationReadiness,
      `${JSON.stringify(driftedApplicationReadiness, null, 2)}\n`,
      "utf8",
    );
    chmodSync(retainedHyperiaApplicationReadiness, 0o600);
    await expectRejection(
      () => verifyRestoredDuelStateReconciliation(reconciliationInput),
      "does not match the reconciled restored state",
    );
    writeFileSync(
      retainedHyperiaApplicationReadiness,
      originalApplicationReadiness,
      "utf8",
    );
    chmodSync(retainedHyperiaApplicationReadiness, 0o600);
    negativeCases.push("application_readiness_identity_drift_rejected");

    const factDriftedApplicationReadiness: unknown = JSON.parse(
      originalApplicationReadiness,
    );
    assert(
      factDriftedApplicationReadiness !== null &&
        typeof factDriftedApplicationReadiness === "object" &&
        !Array.isArray(factDriftedApplicationReadiness),
      "retained application fact-drift fixture is invalid",
    );
    const factDriftedReadinessRecord =
      factDriftedApplicationReadiness as Record<string, unknown>;
    assert(
      Array.isArray(factDriftedReadinessRecord.projectedCompetitiveDuels) &&
        factDriftedReadinessRecord.projectedCompetitiveDuels.length === 1,
      "retained application projected-fact fixture is invalid",
    );
    (
      factDriftedReadinessRecord.projectedCompetitiveDuels[0] as Record<
        string,
        unknown
      >
    ).winnerId = restoredDuelFixture.agent2Id;
    factDriftedReadinessRecord.projectedCompetitiveDuelStateSha256 = createHash(
      "sha256",
    )
      .update(
        canonicalEvidenceJson(
          factDriftedReadinessRecord.projectedCompetitiveDuels,
        ),
      )
      .digest("hex");
    writeFileSync(
      retainedHyperiaApplicationReadiness,
      `${JSON.stringify(factDriftedApplicationReadiness, null, 2)}\n`,
      "utf8",
    );
    chmodSync(retainedHyperiaApplicationReadiness, 0o600);
    await expectRejection(
      () => verifyRestoredDuelStateReconciliation(reconciliationInput),
      "application projected duel does not match the reconciled restored state",
    );
    writeFileSync(
      retainedHyperiaApplicationReadiness,
      originalApplicationReadiness,
      "utf8",
    );
    chmodSync(retainedHyperiaApplicationReadiness, 0o600);
    negativeCases.push(
      "application_readiness_self_consistent_fact_drift_rejected",
    );

    const clockRegressionDirectory = path.join(
      testRoot,
      "clock-regression-reconciliation",
    );
    mkdirSync(clockRegressionDirectory, { mode: 0o700 });
    chmodSync(clockRegressionDirectory, 0o700);
    const clockRegressionManifestPath = path.join(
      clockRegressionDirectory,
      "restored-duel-state-reconciliation.json",
    );
    await expectRejection(
      () =>
        createRestoredDuelStateReconciliation({
          ...reconciliationInput,
          reconciliationManifestPath: clockRegressionManifestPath,
          now: () => new Date(Date.parse(rehearsalManifest.createdAt) - 1),
        }),
      "clock regressed",
    );
    assert(
      !existsSync(clockRegressionManifestPath),
      "clock regression left a partial reconciliation manifest",
    );
    negativeCases.push("reconciliation_clock_regression_rejected");

    await runCommand(
      psqlWrapper,
      [
        "--no-psqlrc",
        "--quiet",
        "--set=ON_ERROR_STOP=1",
        `--dbname=${restoredDatabaseName}`,
        `--command=UPDATE "streaming_duel_competitive_snapshots"
          SET "terminalSeed" = '43'
          WHERE "duelId" = '${restoredDuelFixture.duelId}'`,
      ],
      { timeoutMs: 30_000 },
    );
    await expectRejection(
      () => verifyRestoredDuelStateReconciliation(reconciliationInput),
      "restored terminal truth does not match",
    );
    await runCommand(
      psqlWrapper,
      [
        "--no-psqlrc",
        "--quiet",
        "--set=ON_ERROR_STOP=1",
        `--dbname=${restoredDatabaseName}`,
        `--command=UPDATE "streaming_duel_competitive_snapshots"
          SET "terminalSeed" = '42'
          WHERE "duelId" = '${restoredDuelFixture.duelId}'`,
      ],
      { timeoutMs: 30_000 },
    );
    await verifyRestoredDuelStateReconciliation(reconciliationInput);
    negativeCases.push("restored_postgres_terminal_drift_rejected");

    let queryObservation = 0;
    await expectRejection(
      () =>
        verifyRestoredDuelStateReconciliation({
          ...reconciliationInput,
          hyperiaQueryTool: {
            query: async () =>
              fixtureQueryOutput(
                restoredDuelFixture,
                restoredDatabaseName,
                restoredServerVersionNum,
                queryObservation++ === 0 ? "42" : "43",
              ),
          },
        }),
      "changed during cross-store reconciliation",
    );
    negativeCases.push("concurrent_hyperia_duel_state_drift_rejected");

    process.env.PGPASSWORD = restoredPostgresPassword;
    await expectRejection(
      () => verifyRestoredDuelStateReconciliation(reconciliationInput),
      "password-bearing aliases",
    );
    delete process.env.PGPASSWORD;
    negativeCases.push("reconciliation_password_alias_rejected");

    chmodSync(reconciliationManifestPath, 0o644);
    await expectRejection(
      () => verifyRestoredDuelStateReconciliation(reconciliationInput),
      "mode-0600 regular file",
    );
    chmodSync(reconciliationManifestPath, 0o600);
    negativeCases.push("permissive_reconciliation_manifest_rejected");

    const originalRestoreEvidence = readFileSync(
      retainedHyperiaRestoreEvidence,
      "utf8",
    );
    const driftedRestoreEvidence: unknown = JSON.parse(originalRestoreEvidence);
    assert(
      driftedRestoreEvidence !== null &&
        typeof driftedRestoreEvidence === "object" &&
        !Array.isArray(driftedRestoreEvidence),
      "retained restore evidence fixture is invalid",
    );
    (driftedRestoreEvidence as Record<string, unknown>).restoredStateSha256 =
      "0".repeat(64);
    writeFileSync(
      retainedHyperiaRestoreEvidence,
      `${JSON.stringify(driftedRestoreEvidence, null, 2)}\n`,
      "utf8",
    );
    chmodSync(retainedHyperiaRestoreEvidence, 0o600);
    await expectRejection(
      () => verifyPlatformRecoveryRehearsal(rehearsalInput),
      "restore evidence state does not match",
    );
    writeFileSync(
      retainedHyperiaRestoreEvidence,
      originalRestoreEvidence,
      "utf8",
    );
    chmodSync(retainedHyperiaRestoreEvidence, 0o600);
    negativeCases.push("restore_state_digest_drift_rejected");

    const materializationRecordPath = path.join(
      materializedRootPath,
      "recovery-materialization.json",
    );
    const originalMaterializationRecord = readFileSync(
      materializationRecordPath,
      "utf8",
    );
    writeFileSync(
      materializationRecordPath,
      `${originalMaterializationRecord}\n`,
      "utf8",
    );
    chmodSync(materializationRecordPath, 0o600);
    await expectRejection(
      () => verifyPlatformRecoveryRehearsal(rehearsalInput),
      "file changed for keeperMaterializationRecord",
    );
    writeFileSync(
      materializationRecordPath,
      originalMaterializationRecord,
      "utf8",
    );
    chmodSync(materializationRecordPath, 0o600);
    negativeCases.push("materialization_record_byte_drift_rejected");

    chmodSync(rehearsalManifestPath, 0o644);
    await expectRejection(
      () => verifyPlatformRecoveryRehearsal(rehearsalInput),
      "mode-0600 regular file",
    );
    chmodSync(rehearsalManifestPath, 0o600);
    negativeCases.push("permissive_rehearsal_manifest_rejected");

    const unexpectedMaterializedEntry = path.join(
      materializedRootPath,
      "unexpected",
    );
    writeFileSync(unexpectedMaterializedEntry, "x", {
      mode: 0o600,
      flag: "wx",
    });
    await expectRejection(
      () => verifyPlatformRecoveryRehearsal(rehearsalInput),
      "contains unexpected entries",
    );
    rmSync(unexpectedMaterializedEntry);
    negativeCases.push("materialized_layout_contamination_rejected");

    const originalHyperiaEvidence = readFileSync(
      commonInput.hyperiaEvidencePath,
      "utf8",
    );
    writeFileSync(
      commonInput.hyperiaEvidencePath,
      `${originalHyperiaEvidence}\n`,
      "utf8",
    );
    chmodSync(commonInput.hyperiaEvidencePath, 0o600);
    await expectRejection(
      () => verifyPlatformRecoverySet(commonInput),
      "file binding changed for hyperiaEvidence",
    );
    writeFileSync(
      commonInput.hyperiaEvidencePath,
      originalHyperiaEvidence,
      "utf8",
    );
    chmodSync(commonInput.hyperiaEvidencePath, 0o600);
    negativeCases.push("hyperia_evidence_byte_drift_rejected");

    const unexpectedHyperiaEntry = path.join(
      path.dirname(commonInput.hyperiaBackupPath),
      "unexpected",
    );
    writeFileSync(unexpectedHyperiaEntry, "x", { mode: 0o600, flag: "wx" });
    await expectRejection(
      () => verifyPlatformRecoverySet(commonInput),
      "published backup layout is invalid",
    );
    rmSync(unexpectedHyperiaEntry);
    negativeCases.push("hyperia_layout_contamination_rejected");

    const originalKeeperManifest = readFileSync(keeperManifestPath, "utf8");
    writeFileSync(keeperManifestPath, `${originalKeeperManifest}\n`, "utf8");
    chmodSync(keeperManifestPath, 0o600);
    await expectRejection(
      () => verifyPlatformRecoverySet(commonInput),
      "file binding changed for keeperRecoverySetManifest",
    );
    writeFileSync(keeperManifestPath, originalKeeperManifest, "utf8");
    chmodSync(keeperManifestPath, 0o600);
    negativeCases.push("keeper_manifest_byte_drift_rejected");

    chmodSync(platformManifestPath, 0o644);
    await expectRejection(
      () => verifyPlatformRecoverySet(commonInput),
      "mode-0600 regular file",
    );
    chmodSync(platformManifestPath, 0o600);
    negativeCases.push("permissive_platform_manifest_rejected");

    const driftedMigrations = path.join(testRoot, "drifted-migrations");
    cpSync(commonInput.hyperiaMigrationsDirectory, driftedMigrations, {
      recursive: true,
    });
    const latestMigration = path.join(
      driftedMigrations,
      "0088_allow_zero_effect_committed_duel_food_observations.sql",
    );
    writeFileSync(
      latestMigration,
      `${readFileSync(latestMigration, "utf8")}\n-- platform drift\n`,
      "utf8",
    );
    await expectRejection(
      () =>
        verifyPlatformRecoverySet({
          ...commonInput,
          hyperiaMigrationsDirectory: driftedMigrations,
        }),
      "source migration evidence does not match",
    );
    negativeCases.push("hyperia_migration_byte_drift_rejected");

    const restoredHyperbetService = await runRestoredHyperbetServiceStartup({
      materializedRootPath,
      qualificationContainerPath: path.join(
        testRoot,
        "restored-hyperbet-service",
      ),
      hyperbetReleaseSha,
      fixture: restoredDuelFixture,
    });
    await verifyPlatformRecoveryRehearsal(rehearsalInput);
    await verifyRestoredDuelStateReconciliation(reconciliationInput);

    const manifestFile = hashFile(platformManifestPath);
    const rehearsalManifestFile = hashFile(rehearsalManifestPath);
    const reconciliationManifestFile = hashFile(reconciliationManifestPath);
    return {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      sourceState: "dirty_worktrees_test_only",
      hyperiaReleaseSha: hyperia.releaseSha,
      hyperbetReleaseSha,
      boundaryId: hyperia.boundaryId,
      hyperiaBackupId: hyperia.backupId,
      keeperRecoverySetId: keeperManifest.recoverySetId,
      platformRecoverySetId: platformManifest.platformRecoverySetId,
      hyperiaRestoreVerificationId: hyperia.restoreVerificationId,
      keeperMaterializationId: materialization.materializationId,
      platformRecoveryRehearsalId: rehearsalManifest.rehearsalId,
      restoredDuelStateReconciliationId:
        reconciliationManifest.reconciliationId,
      hyperiaApplicationReadinessId: hyperia.applicationReadinessId,
      hyperiaBackupSha256: hyperia.backupSha256,
      hyperiaBackupBytes: hyperia.backupBytes,
      hyperiaTocEntries: hyperia.tocEntries,
      hyperiaSchemaSha256: hyperia.schemaSha256,
      hyperiaMigrationCount: hyperia.sourceMigrationCount,
      hyperiaRecoveryTableCount: hyperia.recoveryTableCount,
      hyperiaRecoveryTableSha256sSha256:
        hyperia.restoredRecoveryTableSha256sSha256,
      hyperiaRestoreEvidenceSha256: hyperia.restoreEvidenceSha256,
      hyperiaApplicationReadinessSha256: hyperia.applicationReadinessSha256,
      platformManifestSha256: manifestFile.sha256,
      platformManifestBytes: manifestFile.bytes,
      platformRehearsalManifestSha256: rehearsalManifestFile.sha256,
      platformRehearsalManifestBytes: rehearsalManifestFile.bytes,
      reconciliationManifestSha256: reconciliationManifestFile.sha256,
      reconciliationManifestBytes: reconciliationManifestFile.bytes,
      restoredStateSha256: retainedRestoreValue.restoredStateSha256,
      reconciledDuelStateSha256: reconciliationManifest.reconciledStateSha256,
      reconciledDuelCount: reconciliationManifest.matchedDuelCount,
      reconciledTerminalCount: reconciliationManifest.matchedTerminalCount,
      applicationRecentDuelCount:
        reconciliationManifest.hyperia.applicationReadiness.recentDuelCount,
      applicationProjectedCompetitiveDuelCount:
        reconciliationManifest.hyperia.applicationReadiness
          .projectedCompetitiveDuelCount,
      applicationProjectedCompetitiveDuelStateSha256:
        reconciliationManifest.hyperia.applicationReadiness
          .projectedCompetitiveDuelStateSha256,
      restoredServerStartupCompatible: true,
      restoredServerStatusCode: hyperia.restoredServerStatusCode,
      restoredServerHealthCode: hyperia.restoredServerHealthCode,
      restoredServerStreamingStateCode:
        hyperia.restoredServerStreamingStateCode,
      restoredServerStreamingHealthCode:
        hyperia.restoredServerStreamingHealthCode,
      restoredServerPublicHistoryDuelCount:
        hyperia.restoredServerPublicHistoryDuelCount,
      restoredServerExpectedMutationTables:
        hyperia.restoredServerExpectedMutationTables,
      restoredServerSourceEpochAdvancedExactlyOnce: true,
      restoredServerGracefulExitCode: hyperia.restoredServerGracefulExitCode,
      restoredServerNodeVersion: hyperia.restoredServerNodeVersion,
      restoredServerBundleSha256: hyperia.restoredServerBundleSha256,
      restoredServerLogSha256: hyperia.restoredServerLogSha256,
      ...restoredHyperbetService,
      componentCreatedAtSkewMs: platformManifest.componentCreatedAtSkewMs,
      verificationScope: platformManifest.verificationScope,
      rehearsalVerificationScope: rehearsalManifest.verificationScope,
      reconciliationVerificationScope: reconciliationManifest.verificationScope,
      activationRequiresSeparateApproval: true,
      hyperiaNegativeCases: hyperia.negativeCases,
      negativeCases,
    };
  } finally {
    database?.close(false);
    for (const name of managedPgNames) {
      const value = originalPgEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (toolContainerStarted) {
      await docker(["rm", "--force", toolContainer]).catch(() => undefined);
    }
    rmSync(testRoot, { recursive: true, force: true });
  }
}

try {
  const argument = process.argv[2];
  if (
    process.argv.length > 3 ||
    (argument !== undefined && !argument.startsWith("--evidence-output="))
  ) {
    throw new Error(
      "usage: test-platform-recovery-set [--evidence-output=PATH]",
    );
  }
  const result = await run();
  if (argument) {
    const outputPath = path.resolve(
      argument.slice("--evidence-output=".length),
    );
    const parentStats = lstatSync(path.dirname(outputPath));
    if (
      path.basename(outputPath) !== "evidence.json" ||
      !parentStats.isDirectory() ||
      (parentStats.mode & 0o777) !== 0o700 ||
      existsSync(outputPath)
    ) {
      throw new Error(
        "platform evidence output must be new under a mode-0700 directory",
      );
    }
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(outputPath, 0o600);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    `platform recovery qualification failed: ${
      error instanceof Error ? error.message : "unknown failure"
    }`,
  );
  process.exitCode = 1;
}
