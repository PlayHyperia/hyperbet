import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createKeeperBackup } from "./keeperBackup";
import {
  createKeeperRecoverySet,
  verifyKeeperRecoverySet,
} from "./keeperRecoverySet";
import { runKeeperRecoverySetCli } from "./keeperRecoverySetCli";
import { createInitialOperatorAlertDurableState } from "./operatorAlertDispatcher";
import { createOperatorAlertStateBackup } from "./operatorAlertStateBackup";
import { persistOperatorAlertDurableState } from "./operatorAlertStateStore";

const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
const ROUTE_ID = "test.primary";
const BOUNDARY_ID = "maintenance-20260826-001";
const RECOVERY_SET_ID = "123e4567-e89b-42d3-a456-426614174000";
const TABLES = [
  "bet_deployment_identities",
  "bet_executions",
  "bet_lifecycle_accounting",
  "bet_terminal_settlements",
  "bets",
  "bets_duplicate_conflicts",
  "betting_feed_checkpoint",
  "betting_feed_competitive_snapshots",
  "betting_feed_evidence_frames",
  "invite_codes",
  "invited_wallets",
  "keeper_legacy_migrations",
  "keeper_legacy_rows",
  "points_events",
  "referrals",
  "solana_indexed_transactions",
  "solana_indexer_checkpoints",
  "solana_lifecycle_facts",
  "solana_terminal_settlements",
  "terminal_operation_conflicts",
  "terminal_operator_audit_events",
  "wallet_display",
  "wallet_points",
] as const;

function createLaunchDatabase(databasePath: string): Database {
  const database = new Database(databasePath, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  for (const table of TABLES) {
    database.run(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY)`);
  }
  database.run(`CREATE TABLE terminal_operations (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'MANUAL_REVIEW', 'DEAD_LETTER'))
  )`);
  database.run("INSERT INTO bets(id) VALUES (1)");
  database.run(
    "INSERT INTO terminal_operations(id, status) VALUES (1, 'SUCCEEDED')",
  );
  return database;
}

describe("keeper recovery set", () => {
  let directory: string;
  let sourceDatabasePath: string;
  let sourceAlertPath: string;
  let keeperBackupPath: string;
  let keeperEvidencePath: string;
  let operatorAlertBackupPath: string;
  let operatorAlertEvidencePath: string;
  let manifestPath: string;
  let database: Database;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "keeper-recovery-set-"));
    sourceDatabasePath = path.join(directory, "keeper.sqlite");
    sourceAlertPath = path.join(directory, "operator-alert-state.json");
    keeperBackupPath = path.join(directory, "keeper.backup.sqlite");
    keeperEvidencePath = path.join(directory, "keeper.evidence.json");
    operatorAlertBackupPath = path.join(
      directory,
      "operator-alert.backup.json",
    );
    operatorAlertEvidencePath = path.join(
      directory,
      "operator-alert.evidence.json",
    );
    manifestPath = path.join(directory, "recovery-set.json");
    database = createLaunchDatabase(sourceDatabasePath);
    persistOperatorAlertDurableState(
      sourceAlertPath,
      createInitialOperatorAlertDurableState(ROUTE_ID),
    );
    await createKeeperBackup({
      sourcePath: sourceDatabasePath,
      backupPath: keeperBackupPath,
      evidencePath: keeperEvidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      now: () => new Date("2026-08-26T20:00:00.000Z"),
    });
    await createOperatorAlertStateBackup({
      sourcePath: sourceAlertPath,
      backupPath: operatorAlertBackupPath,
      evidencePath: operatorAlertEvidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      routeId: ROUTE_ID,
      now: () => new Date("2026-08-26T20:00:03.000Z"),
    });
  });

  afterEach(() => {
    database.close(false);
    rmSync(directory, { recursive: true, force: true });
  });

  function paths() {
    return {
      keeperBackupPath,
      keeperEvidencePath,
      operatorAlertBackupPath,
      operatorAlertEvidencePath,
      manifestPath,
    };
  }

  function identity() {
    return {
      expectedReleaseSha: RELEASE_SHA,
      expectedCluster: "devnet" as const,
      expectedOperatorAlertRouteId: ROUTE_ID,
    };
  }

  test("binds both verified pairs to one private boundary manifest", async () => {
    const createResult = await runKeeperRecoverySetCli([
      "bun",
      "keeperRecoverySetCli.ts",
      "create",
      `--keeper-backup=${keeperBackupPath}`,
      `--keeper-evidence=${keeperEvidencePath}`,
      `--operator-alert-backup=${operatorAlertBackupPath}`,
      `--operator-alert-evidence=${operatorAlertEvidencePath}`,
      `--manifest=${manifestPath}`,
      `--release-sha=${RELEASE_SHA}`,
      "--cluster=devnet",
      `--operator-alert-route-id=${ROUTE_ID}`,
      `--boundary-id=${BOUNDARY_ID}`,
    ]);
    expect(createResult).toMatchObject({
      ok: true,
      action: "create",
      boundaryId: BOUNDARY_ID,
      verificationScope: "file_pair_binding_only",
      quiescentBoundaryWitnessRequired: true,
    });
    const manifest = await verifyKeeperRecoverySet({
      ...paths(),
      ...identity(),
      expectedBoundaryId: BOUNDARY_ID,
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      boundaryId: BOUNDARY_ID,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      operatorAlertRouteId: ROUTE_ID,
      verificationScope: "file_pair_binding_only",
      quiescentBoundaryWitnessRequired: true,
      componentCreatedAtSkewMs: 3_000,
    });
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    const serialized = readFileSync(manifestPath, "utf8");
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain("keeper.sqlite");
    expect(serialized).not.toContain("operator-alert-state.json");
    const cliResult = await runKeeperRecoverySetCli([
      "bun",
      "keeperRecoverySetCli.ts",
      "verify",
      `--keeper-backup=${keeperBackupPath}`,
      `--keeper-evidence=${keeperEvidencePath}`,
      `--operator-alert-backup=${operatorAlertBackupPath}`,
      `--operator-alert-evidence=${operatorAlertEvidencePath}`,
      `--manifest=${manifestPath}`,
      `--release-sha=${RELEASE_SHA}`,
      "--cluster=devnet",
      `--operator-alert-route-id=${ROUTE_ID}`,
      `--boundary-id=${BOUNDARY_ID}`,
    ]);
    expect(cliResult).toMatchObject({
      ok: true,
      action: "verify",
      recoverySetId: manifest.recoverySetId,
      boundaryId: BOUNDARY_ID,
      componentCreatedAtSkewMs: 3_000,
      verificationScope: "file_pair_binding_only",
      quiescentBoundaryWitnessRequired: true,
    });
  });

  test("rejects overwrite, boundary drift, and any changed component", async () => {
    await createKeeperRecoverySet({
      ...paths(),
      ...identity(),
      boundaryId: BOUNDARY_ID,
      createId: () => RECOVERY_SET_ID,
    });
    await expect(
      createKeeperRecoverySet({
        ...paths(),
        ...identity(),
        boundaryId: BOUNDARY_ID,
      }),
    ).rejects.toThrow("manifest already exists");
    await expect(
      verifyKeeperRecoverySet({
        ...paths(),
        ...identity(),
        expectedBoundaryId: "maintenance-20260826-002",
      }),
    ).rejects.toThrow("boundary ID does not match");

    const originalAlertEvidence = readFileSync(
      operatorAlertEvidencePath,
      "utf8",
    );
    writeFileSync(operatorAlertEvidencePath, `${originalAlertEvidence}\n`, {
      mode: 0o600,
    });
    await expect(
      verifyKeeperRecoverySet({
        ...paths(),
        ...identity(),
        expectedBoundaryId: BOUNDARY_ID,
      }),
    ).rejects.toThrow("file binding changed for operatorAlertEvidence");
  });
});
