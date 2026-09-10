import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createKeeperBackup, verifyKeeperBackup } from "./keeperBackup";

const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
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
    "INSERT INTO terminal_operations(id, status) VALUES (1, 'SUCCEEDED'), (2, 'MANUAL_REVIEW')",
  );
  return database;
}

describe("keeper backup", () => {
  let directory: string;
  let sourcePath: string;
  let backupPath: string;
  let evidencePath: string;
  let source: Database;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "hyperbet-keeper-backup-"));
    sourcePath = path.join(directory, "keeper.sqlite");
    backupPath = path.join(directory, "keeper-backup.sqlite");
    evidencePath = path.join(directory, "keeper-backup.json");
    source = createLaunchDatabase(sourcePath);
  });

  afterEach(() => {
    source.close(false);
    rmSync(directory, { recursive: true, force: true });
  });

  test("creates and independently verifies a private consistent backup", async () => {
    const evidence = await createKeeperBackup({
      sourcePath,
      backupPath,
      evidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    expect(evidence.tableCounts.bets).toBe(1);
    expect(evidence.terminalOperationCounts).toEqual({
      PENDING: 0,
      PROCESSING: 0,
      SUCCEEDED: 1,
      MANUAL_REVIEW: 1,
      DEAD_LETTER: 0,
    });
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(evidencePath, "utf8")).not.toContain(directory);

    source.run("INSERT INTO bets(id) VALUES (2)");
    const verified = await verifyKeeperBackup({
      backupPath,
      evidencePath,
      expectedReleaseSha: RELEASE_SHA,
      expectedCluster: "devnet",
    });
    expect(verified.tableCounts.bets).toBe(1);
  });

  test("refuses overwrite, identity drift, and post-evidence backup mutation", async () => {
    await createKeeperBackup({
      sourcePath,
      backupPath,
      evidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
    });
    await expect(
      createKeeperBackup({
        sourcePath,
        backupPath,
        evidencePath: path.join(directory, "other-evidence.json"),
        releaseSha: RELEASE_SHA,
        cluster: "devnet",
      }),
    ).rejects.toThrow("backup path already exists");
    await expect(
      verifyKeeperBackup({
        backupPath,
        evidencePath,
        expectedReleaseSha: "abcdef1234567890abcdef1234567890abcdef12",
        expectedCluster: "devnet",
      }),
    ).rejects.toThrow("release SHA");

    const mutated = new Database(backupPath);
    mutated.run("INSERT INTO bets(id) VALUES (99)");
    mutated.close(false);
    chmodSync(backupPath, 0o600);
    await expect(
      verifyKeeperBackup({
        backupPath,
        evidencePath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
      }),
    ).rejects.toThrow(/byte size|SHA-256/u);
  });

  test("rejects an incomplete source before creating a backup", async () => {
    source.close(false);
    rmSync(sourcePath, { force: true });
    source = new Database(sourcePath, { create: true });
    source.run("CREATE TABLE terminal_operations(id INTEGER, status TEXT)");
    await expect(
      createKeeperBackup({
        sourcePath,
        backupPath,
        evidencePath,
        releaseSha: RELEASE_SHA,
        cluster: "devnet",
      }),
    ).rejects.toThrow("missing launch tables");
    expect(() => statSync(backupPath)).toThrow();
    expect(
      readdirSync(directory).some((entry) => entry.includes(".private-")),
    ).toBe(false);
  });
});
