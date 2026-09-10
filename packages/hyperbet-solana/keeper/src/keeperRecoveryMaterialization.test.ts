import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createKeeperBackup } from "./keeperBackup";
import {
  materializeKeeperRecoverySet,
  verifyMaterializedKeeperRecoverySet,
} from "./keeperRecoveryMaterialization";
import { createKeeperRecoverySet } from "./keeperRecoverySet";
import { runKeeperRecoverySetCli } from "./keeperRecoverySetCli";
import { createInitialOperatorAlertDurableState } from "./operatorAlertDispatcher";
import { createOperatorAlertStateBackup } from "./operatorAlertStateBackup";
import { persistOperatorAlertDurableState } from "./operatorAlertStateStore";

const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
const ROUTE_ID = "test.primary";
const BOUNDARY_ID = "maintenance-20260826-001";
const RECOVERY_SET_ID = "123e4567-e89b-42d3-a456-426614174000";
const MATERIALIZATION_ID = "123e4567-e89b-42d3-a456-426614174001";
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

describe("keeper recovery materialization", () => {
  let directory: string;
  let sourceDatabasePath: string;
  let sourceAlertPath: string;
  let keeperBackupPath: string;
  let keeperEvidencePath: string;
  let operatorAlertBackupPath: string;
  let operatorAlertEvidencePath: string;
  let manifestPath: string;
  let destinationContainerPath: string;
  let database: Database;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "keeper-materialization-"));
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
    destinationContainerPath = path.join(directory, "isolated-restore");
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
    await createKeeperRecoverySet({
      ...sourcePaths(),
      ...identity(),
      boundaryId: BOUNDARY_ID,
      now: () => new Date("2026-08-26T20:00:04.000Z"),
      createId: () => RECOVERY_SET_ID,
    });
  });

  afterEach(() => {
    database.close(false);
    rmSync(directory, { recursive: true, force: true });
  });

  function sourcePaths() {
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

  function cliSourceArguments() {
    return [
      `--keeper-backup=${keeperBackupPath}`,
      `--keeper-evidence=${keeperEvidencePath}`,
      `--operator-alert-backup=${operatorAlertBackupPath}`,
      `--operator-alert-evidence=${operatorAlertEvidencePath}`,
      `--manifest=${manifestPath}`,
      `--release-sha=${RELEASE_SHA}`,
      "--cluster=devnet",
      `--operator-alert-route-id=${ROUTE_ID}`,
      `--boundary-id=${BOUNDARY_ID}`,
    ];
  }

  async function waitForFile(filePath: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(filePath)) return;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${path.basename(filePath)}`);
  }

  test("publishes and verifies one complete private active root", async () => {
    const createResult = await runKeeperRecoverySetCli([
      "bun",
      "keeperRecoverySetCli.ts",
      "materialize",
      ...cliSourceArguments(),
      `--destination-container=${destinationContainerPath}`,
    ]);
    expect(createResult).toMatchObject({
      ok: true,
      action: "materialize",
      recoverySetId: RECOVERY_SET_ID,
      boundaryId: BOUNDARY_ID,
      materializedRootName: "active",
      keeperDatabaseRelativePath: "keeper.sqlite",
      operatorAlertStateRelativePath: "status/operator-alert-state.json",
      verificationScope: "isolated_restore_materialization_only",
      activationRequiresSeparateApproval: true,
    });
    expect(JSON.stringify(createResult)).not.toContain(directory);

    const activePath = path.join(destinationContainerPath, "active");
    const keeperPath = path.join(activePath, "keeper.sqlite");
    const alertPath = path.join(activePath, "status/operator-alert-state.json");
    const recordPath = path.join(activePath, "recovery-materialization.json");
    expect(readdirSync(destinationContainerPath)).toEqual(["active"]);
    expect(statSync(destinationContainerPath).mode & 0o777).toBe(0o700);
    expect(statSync(activePath).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(activePath, "status")).mode & 0o777).toBe(0o700);
    for (const filePath of [keeperPath, alertPath, recordPath]) {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(keeperPath)).toEqual(readFileSync(keeperBackupPath));
    expect(readFileSync(alertPath)).toEqual(
      readFileSync(operatorAlertBackupPath),
    );
    expect(readFileSync(recordPath, "utf8")).not.toContain(directory);

    const verifyResult = await runKeeperRecoverySetCli([
      "bun",
      "keeperRecoverySetCli.ts",
      "verify-materialized",
      ...cliSourceArguments(),
      `--materialized-root=${activePath}`,
    ]);
    expect(verifyResult).toMatchObject({
      ok: true,
      action: "verify-materialized",
      materializationId: createResult.materializationId,
      recoverySetId: RECOVERY_SET_ID,
      verificationScope: "isolated_restore_materialization_only",
      activationRequiresSeparateApproval: true,
    });
  });

  test("never publishes active state when pre-publication verification fails", async () => {
    await expect(
      materializeKeeperRecoverySet({
        ...sourcePaths(),
        ...identity(),
        expectedBoundaryId: BOUNDARY_ID,
        destinationContainerPath,
        now: () => new Date("2026-08-26T20:00:05.000Z"),
        createId: () => MATERIALIZATION_ID,
        beforePublish: () => {
          throw new Error("injected pre-publication stop");
        },
      }),
    ).rejects.toThrow("injected pre-publication stop");
    expect(existsSync(destinationContainerPath)).toBe(false);

    await expect(
      materializeKeeperRecoverySet({
        ...sourcePaths(),
        ...identity(),
        expectedBoundaryId: BOUNDARY_ID,
        destinationContainerPath,
        now: () => new Date("2026-08-26T19:59:59.000Z"),
      }),
    ).rejects.toThrow("clock regressed");
    expect(existsSync(destinationContainerPath)).toBe(false);

    mkdirSync(destinationContainerPath, { mode: 0o700 });
    await expect(
      materializeKeeperRecoverySet({
        ...sourcePaths(),
        ...identity(),
        expectedBoundaryId: BOUNDARY_ID,
        destinationContainerPath,
      }),
    ).rejects.toThrow("destination container already exists");
  });

  test("a real process kill cannot expose a half-materialized active root", async () => {
    const readyPath = path.join(directory, "child-ready");
    const fixturePath = path.join(
      import.meta.dir,
      "keeperRecoveryMaterializationCrash.fixture.ts",
    );
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--bun",
        fixturePath,
        keeperBackupPath,
        keeperEvidencePath,
        operatorAlertBackupPath,
        operatorAlertEvidencePath,
        manifestPath,
        destinationContainerPath,
        readyPath,
        RELEASE_SHA,
        ROUTE_ID,
        BOUNDARY_ID,
        MATERIALIZATION_ID,
      ],
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForFile(readyPath);
      expect(existsSync(destinationContainerPath)).toBe(true);
      expect(existsSync(path.join(destinationContainerPath, "active"))).toBe(
        false,
      );
      const entries = readdirSync(destinationContainerPath);
      expect(entries).toEqual([`.staging-${MATERIALIZATION_ID}`]);
      child.kill("SIGKILL");
      expect(await child.exited).not.toBe(0);
      expect(existsSync(path.join(destinationContainerPath, "active"))).toBe(
        false,
      );
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("rejects mutation, extra entries, and permissive materialized state", async () => {
    await materializeKeeperRecoverySet({
      ...sourcePaths(),
      ...identity(),
      expectedBoundaryId: BOUNDARY_ID,
      destinationContainerPath,
      now: () => new Date("2026-08-26T20:00:05.000Z"),
      createId: () => MATERIALIZATION_ID,
    });
    const activePath = path.join(destinationContainerPath, "active");
    const alertPath = path.join(activePath, "status/operator-alert-state.json");
    const originalAlert = readFileSync(alertPath);
    writeFileSync(alertPath, Buffer.concat([originalAlert, Buffer.from("\n")]));
    chmodSync(alertPath, 0o600);
    await expect(
      verifyMaterializedKeeperRecoverySet({
        ...sourcePaths(),
        ...identity(),
        expectedBoundaryId: BOUNDARY_ID,
        materializedRootPath: activePath,
      }),
    ).rejects.toThrow("operator alert binding does not match");

    writeFileSync(alertPath, originalAlert);
    chmodSync(alertPath, 0o600);
    writeFileSync(path.join(activePath, "unexpected.txt"), "unexpected", {
      mode: 0o600,
    });
    await expect(
      verifyMaterializedKeeperRecoverySet({
        ...sourcePaths(),
        ...identity(),
        expectedBoundaryId: BOUNDARY_ID,
        materializedRootPath: activePath,
      }),
    ).rejects.toThrow("unexpected entries");
    rmSync(path.join(activePath, "unexpected.txt"));

    chmodSync(path.join(activePath, "recovery-materialization.json"), 0o644);
    await expect(
      verifyMaterializedKeeperRecoverySet({
        ...sourcePaths(),
        ...identity(),
        expectedBoundaryId: BOUNDARY_ID,
        materializedRootPath: activePath,
      }),
    ).rejects.toThrow("materialization record is invalid");
  });
});
