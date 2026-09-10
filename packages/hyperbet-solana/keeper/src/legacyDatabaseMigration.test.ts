import { Database } from "bun:sqlite";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { auditKeeperDatabaseFile } from "./keeperDatabaseAuditCli";
import {
  createKeeperBackup,
  type DatabaseInspection,
  type KeeperBackupEvidence,
} from "./keeperBackup";
import { TerminalLedger } from "./terminalLedger";

const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
const PROGRAM_ID = bs58.encode(Buffer.alloc(32, 15));
const OTHER_PROGRAM_ID = bs58.encode(Buffer.alloc(32, 16));

function inspectionFromEvidence(
  evidence: KeeperBackupEvidence,
): DatabaseInspection {
  return {
    integrityCheck: evidence.integrityCheck,
    foreignKeyViolations: evidence.foreignKeyViolations,
    sqliteUserVersion: evidence.sqliteUserVersion,
    schemaSha256: evidence.schemaSha256,
    logicalDataSha256: evidence.logicalDataSha256,
    tableCounts: evidence.tableCounts,
    terminalOperationCounts: evidence.terminalOperationCounts,
  };
}

function seedLegacyDatabase(databasePath: string): void {
  const database = new Database(databasePath, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  database.run(`CREATE TABLE bets (
    id TEXT PRIMARY KEY,
    bettor_wallet TEXT NOT NULL,
    chain TEXT NOT NULL,
    source_asset TEXT NOT NULL,
    source_amount REAL NOT NULL DEFAULT 0,
    fee_bps INTEGER NOT NULL DEFAULT 0,
    tx_signature TEXT NOT NULL DEFAULT '',
    market_pda TEXT,
    duel_key TEXT,
    duel_id TEXT,
    invite_code TEXT,
    external_bet_ref TEXT,
    recorded_at INTEGER NOT NULL
  )`);
  database.run(`INSERT INTO bets (
    id, bettor_wallet, chain, source_asset, source_amount, fee_bps,
    tx_signature, market_pda, duel_key, duel_id, invite_code,
    external_bet_ref, recorded_at
  ) VALUES (
    'legacy-bet', 'legacy-wallet', 'SOLANA', 'SOL', 1.25, 25,
    'legacy-signature', NULL, NULL, 'legacy-duel', NULL,
    'legacy-ref', 1700000000000
  )`);
  database.run(`CREATE TABLE wallet_display (
    normalized_wallet TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
  )`);
  database.run(`CREATE TABLE wallet_points (
    wallet TEXT PRIMARY KEY,
    self_points REAL NOT NULL DEFAULT 0,
    win_points REAL NOT NULL DEFAULT 0,
    referral_points REAL NOT NULL DEFAULT 0,
    staking_points REAL NOT NULL DEFAULT 0
  )`);
  database.run(
    "INSERT INTO wallet_points VALUES ('base-wallet', 3, 2, 1, 9), ('rank/legacy-wallet', 8, 0, 0, 7)",
  );
  database.run(`CREATE TABLE points_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    total_points REAL NOT NULL DEFAULT 0,
    reference_type TEXT,
    reference_id TEXT,
    related_wallet TEXT,
    created_at INTEGER NOT NULL
  )`);
  database.run(
    "CREATE TABLE invite_codes (wallet TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE)",
  );
  database.run(
    "CREATE TABLE referrals (wallet TEXT PRIMARY KEY, referrer_wallet TEXT NOT NULL, invite_code TEXT NOT NULL)",
  );
  database.run(
    "CREATE TABLE invited_wallets (referrer TEXT NOT NULL, invitee TEXT NOT NULL, PRIMARY KEY (referrer, invitee))",
  );
  database.run(
    "CREATE TABLE wallet_canonical (wallet TEXT PRIMARY KEY, canonical TEXT NOT NULL)",
  );
  database.run(
    "CREATE TABLE identity_members (canonical TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (canonical, member))",
  );
  database.run(
    "CREATE TABLE referral_fees (wallet TEXT PRIMARY KEY, fee_share_sol REAL NOT NULL DEFAULT 0, treasury_fees REAL NOT NULL DEFAULT 0)",
  );
  database.run(
    "CREATE TABLE agent_ratings (agent_id TEXT PRIMARY KEY, mu REAL NOT NULL, sigma REAL NOT NULL, games_played INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  database.run(
    "CREATE TABLE bet_sync_checkpoint (id INTEGER PRIMARY KEY, source_epoch INTEGER NOT NULL, last_seen_seq INTEGER NOT NULL, last_applied_seq INTEGER NOT NULL, replay_mode TEXT, degraded_reason TEXT, updated_at INTEGER NOT NULL)",
  );
  database.run(
    "INSERT INTO wallet_canonical VALUES ('legacy-wallet', 'canonical-wallet')",
  );
  database.run(
    "INSERT INTO identity_members VALUES ('canonical-wallet', 'legacy-wallet')",
  );
  database.run("INSERT INTO referral_fees VALUES ('legacy-wallet', 0.1, 0.2)");
  database.run(
    "INSERT INTO agent_ratings VALUES ('legacy-agent', 25, 8.333, 4, 1700000000000)",
  );
  database.run(
    "INSERT INTO bet_sync_checkpoint VALUES (1, 1, 2, 2, NULL, NULL, 1700000000000)",
  );
  database.close(false);
}

describe("backup-bound keeper legacy migration", () => {
  const cliPath = path.resolve(import.meta.dir, "keeperDatabaseAuditCli.ts");
  let directory = "";
  let databasePath = "";
  let loadedModules: Array<{ closeDb(): void }> = [];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "keeper-legacy-migration-"));
    databasePath = path.join(directory, "keeper.sqlite");
    seedLegacyDatabase(databasePath);
    process.env.KEEPER_DB_PATH = databasePath;
    loadedModules = [];
  });

  afterEach(() => {
    delete process.env.KEEPER_DB_PATH;
    for (const module of loadedModules) module.closeDb();
    rmSync(directory, { recursive: true, force: true });
  });

  async function prepareMigration(existingDeployment?: {
    cluster: "devnet" | "mainnet-beta";
    programId: string;
  }) {
    const keeperDb = (await import(
      `./db.ts?legacy-migration=${Date.now()}-${Math.random()}`
    )) as typeof import("./db.ts");
    loadedModules.push(keeperDb);
    const terminalLedger = new TerminalLedger(databasePath);
    terminalLedger.close();

    const wallet = Keypair.generate().publicKey.toBase58();
    const marketPda = Keypair.generate().publicKey.toBase58();
    const signature = bs58.encode(Buffer.alloc(64, 7));
    expect(
      keeperDb.saveBet(
        {
          id: "canonical-bet",
          cluster: "devnet",
          programId: PROGRAM_ID,
          bettorWallet: wallet,
          chain: "SOLANA",
          sourceAsset: "SOL",
          sourceAmountLamports: "60000",
          feeAmountLamports: "0",
          feeBps: 0,
          txSignature: signature,
          marketPda,
          duelKey: "42".repeat(32),
          duelId: "canonical-duel",
          inviteCode: null,
          externalBetRef: `solana:${signature}`,
          recordedAt: 1_700_000_100_000,
        },
        {
          orderId: "1",
          side: 1,
          limitPrice: 600,
          orderBehavior: 0,
          orderAmountUnits: "100000",
          matchedAmountUnits: "0",
          restingAmountUnits: "100000",
          releasedAmountUnits: "0",
          collateralLamports: "60000",
          executedCostLamports: "0",
          tradeTreasuryFeeLamports: "0",
          tradeMarketMakerFeeLamports: "0",
          rewardEligibleLamports: "0",
          verifiedAt: 1_700_000_100_000,
        },
      ),
    ).toBe(true);

    const unbind = new Database(databasePath);
    try {
      unbind
        .prepare("DELETE FROM bet_deployment_identities WHERE bet_id = ?")
        .run("canonical-bet");
      if (existingDeployment) {
        unbind
          .prepare(
            `INSERT INTO bet_deployment_identities (
              bet_id, cluster, program_id, bound_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            "canonical-bet",
            existingDeployment.cluster,
            existingDeployment.programId,
            1_700_000_100_000,
          );
      }
    } finally {
      unbind.close(false);
    }

    const backupPath = path.join(directory, "pre-migration.sqlite");
    const evidencePath = path.join(directory, "pre-migration.json");
    const evidence = await createKeeperBackup({
      sourcePath: databasePath,
      backupPath,
      evidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      now: () => new Date("2026-08-21T20:00:00.000Z"),
    });
    return { keeperDb, evidence };
  }

  test("archives incompatible state and preserves canonical rows exactly", async () => {
    const { keeperDb, evidence } = await prepareMigration();
    expect(keeperDb.checkDatabaseHealth().ok).toBe(false);
    const result = keeperDb.migrateLegacyDatabase({
      backupSha256: evidence.backupSha256,
      backupInspection: inspectionFromEvidence(evidence),
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      programId: PROGRAM_ID,
      appliedAt: 1_700_000_200_000,
    });
    expect(result).toMatchObject({
      migrationId: 1,
      backupSha256: evidence.backupSha256,
      archivedRowCount: 3,
      renamedTableCount: 5,
      audit: { compatible: true, schemaVersion: 2, blockers: [] },
    });
    expect(keeperDb.checkDatabaseHealth()).toEqual({ ok: true, error: null });

    keeperDb.closeDb();
    loadedModules = loadedModules.filter((module) => module !== keeperDb);
    const reopened = (await import(
      `./db.ts?legacy-migration-reopen=${Date.now()}-${Math.random()}`
    )) as typeof import("./db.ts");
    loadedModules.push(reopened);
    expect(reopened.loadAll().bets.map((bet) => bet.id)).toEqual([
      "canonical-bet",
    ]);
    expect(reopened.auditKeeperDatabase()).toMatchObject({
      compatible: true,
      schemaVersion: 2,
      blockers: [],
    });

    const inspect = new Database(databasePath, { readonly: true });
    try {
      const archived = inspect
        .query(
          "SELECT source_table AS sourceTable, source_key AS sourceKey, migration_id AS migrationId FROM keeper_legacy_rows ORDER BY source_table, source_key",
        )
        .all();
      expect(archived).toEqual([
        {
          sourceTable: "bets",
          sourceKey: "legacy-bet",
          migrationId: 1,
        },
        {
          sourceTable: "wallet_points",
          sourceKey: "rowid:2",
          migrationId: 1,
        },
        {
          sourceTable: "wallet_points.staking_points",
          sourceKey: "base-wallet",
          migrationId: 1,
        },
      ]);
      expect(
        inspect
          .query(
            "SELECT self_points AS selfPoints, win_points AS winPoints, referral_points AS referralPoints FROM wallet_points WHERE wallet = 'base-wallet'",
          )
          .get(),
      ).toEqual({ selfPoints: 3, winPoints: 2, referralPoints: 1 });
      const tables = inspect
        .query(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'keeper_legacy_table_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "keeper_legacy_table_agent_ratings",
        "keeper_legacy_table_bet_sync_checkpoint",
        "keeper_legacy_table_identity_members",
        "keeper_legacy_table_referral_fees",
        "keeper_legacy_table_wallet_canonical",
      ]);
      expect(
        inspect
          .query(
            `SELECT cluster, program_id AS programId
               FROM bet_deployment_identities
              WHERE bet_id = 'canonical-bet'`,
          )
          .get(),
      ).toEqual({ cluster: "devnet", programId: PROGRAM_ID });
    } finally {
      inspect.close(false);
    }
  });

  test("rejects a same-count source mutation after backup", async () => {
    const { keeperDb, evidence } = await prepareMigration();
    const mutate = new Database(databasePath);
    mutate.run(
      "UPDATE wallet_points SET self_points = self_points + 1 WHERE wallet = 'base-wallet'",
    );
    mutate.close(false);
    expect(() =>
      keeperDb.migrateLegacyDatabase({
        backupSha256: evidence.backupSha256,
        backupInspection: inspectionFromEvidence(evidence),
        releaseSha: RELEASE_SHA,
        cluster: "devnet",
        programId: PROGRAM_ID,
      }),
    ).toThrow("changed after the verified migration backup");
    expect(keeperDb.auditKeeperDatabase().compatible).toBe(false);
  });

  test("rejects and atomically rolls back a conflicting deployment binding", async () => {
    const { keeperDb, evidence } = await prepareMigration({
      cluster: "mainnet-beta",
      programId: OTHER_PROGRAM_ID,
    });
    expect(() =>
      keeperDb.migrateLegacyDatabase({
        backupSha256: evidence.backupSha256,
        backupInspection: inspectionFromEvidence(evidence),
        releaseSha: RELEASE_SHA,
        cluster: "devnet",
        programId: PROGRAM_ID,
        appliedAt: 1_700_000_200_000,
      }),
    ).toThrow("different bound Solana deployment");

    const inspect = new Database(databasePath, { readonly: true });
    try {
      expect(
        inspect
          .query("SELECT COUNT(*) AS count FROM keeper_legacy_migrations")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        inspect
          .query(
            `SELECT cluster, program_id AS programId
               FROM bet_deployment_identities
              WHERE bet_id = 'canonical-bet'`,
          )
          .get(),
      ).toEqual({ cluster: "mainnet-beta", programId: OTHER_PROGRAM_ID });
    } finally {
      inspect.close(false);
    }
  });

  test("runs the audited migration through the operator CLI", async () => {
    const { keeperDb } = await prepareMigration();
    keeperDb.closeDb();
    loadedModules = loadedModules.filter((module) => module !== keeperDb);
    let cliRun = 0;
    const runCli = (args: string[]) => {
      cliRun += 1;
      const stdoutPath = path.join(directory, `cli-${cliRun}.stdout`);
      const stderrPath = path.join(directory, `cli-${cliRun}.stderr`);
      const stdoutFd = openSync(stdoutPath, "w");
      const stderrFd = openSync(stderrPath, "w");
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, ["--bun", cliPath, ...args], {
          cwd: import.meta.dir,
          env: { ...process.env, KEEPER_DB_PATH: databasePath },
          stdio: ["ignore", stdoutFd, stderrFd],
        });
      } finally {
        closeSync(stdoutFd);
        closeSync(stderrFd);
      }
      return {
        exitCode: result.status,
        stdout: readFileSync(stdoutPath),
        stderr: readFileSync(stderrPath),
      };
    };
    const before = runCli(["audit", `--database=${databasePath}`]);
    expect(before.exitCode).toBe(2);
    expect(before.stderr.toString()).toBe("");

    const applied = runCli([
      "apply",
      `--database=${databasePath}`,
      `--backup=${path.join(directory, "pre-migration.sqlite")}`,
      `--evidence=${path.join(directory, "pre-migration.json")}`,
      `--release-sha=${RELEASE_SHA}`,
      "--cluster=devnet",
      `--program-id=${PROGRAM_ID}`,
    ]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr.toString()).toBe("");

    const after = runCli(["audit", `--database=${databasePath}`]);
    expect(after.exitCode).toBe(0);
    expect(after.stderr.toString()).toBe("");
    expect(auditKeeperDatabaseFile(databasePath)).toMatchObject({
      compatible: true,
      schemaVersion: 2,
      blockers: [],
    });
  });
});
