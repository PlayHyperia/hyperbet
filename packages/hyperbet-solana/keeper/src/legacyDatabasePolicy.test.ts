import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { auditKeeperDatabaseFile } from "./keeperDatabaseAuditCli";
import {
  initializeKeeperLaunchSchemaVersion,
  inspectKeeperDatabaseCompatibility,
  KEEPER_LAUNCH_SCHEMA_VERSION,
} from "./legacyDatabasePolicy";

function createCanonicalSkeleton(database: Database): void {
  database.run(`CREATE TABLE bets (
    id TEXT PRIMARY KEY,
    bettor_wallet TEXT NOT NULL,
    chain TEXT NOT NULL,
    source_asset TEXT NOT NULL,
    source_amount_lamports INTEGER NOT NULL,
    tx_signature TEXT NOT NULL,
    market_pda TEXT,
    duel_key TEXT
  )`);
  database.run(
    "CREATE TABLE bet_executions (bet_id TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE)",
  );
  database.run(`CREATE TABLE bet_deployment_identities (
    bet_id TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    bound_at INTEGER NOT NULL
  )`);
  database.run(
    "CREATE TABLE wallet_points (wallet TEXT PRIMARY KEY, self_points REAL NOT NULL DEFAULT 0)",
  );
  database.run(
    "CREATE TABLE points_events (id INTEGER PRIMARY KEY, wallet TEXT NOT NULL, related_wallet TEXT)",
  );
  database.run(
    "CREATE TABLE wallet_display (normalized_wallet TEXT PRIMARY KEY)",
  );
  database.run("CREATE TABLE invite_codes (wallet TEXT PRIMARY KEY)");
  database.run(
    "CREATE TABLE referrals (wallet TEXT PRIMARY KEY, referrer_wallet TEXT NOT NULL)",
  );
  database.run(
    "CREATE TABLE invited_wallets (referrer TEXT NOT NULL, invitee TEXT NOT NULL)",
  );
  database.run(
    "CREATE TABLE keeper_legacy_rows (source_table TEXT, source_key TEXT)",
  );
  database.run(
    "CREATE TABLE keeper_legacy_migrations (id INTEGER PRIMARY KEY)",
  );
}

describe("keeper legacy database launch policy", () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("versions a fresh canonical database exactly once", () => {
    const database = new Database(":memory:");
    try {
      createCanonicalSkeleton(database);
      expect(initializeKeeperLaunchSchemaVersion(database)).toMatchObject({
        compatible: true,
        schemaVersion: KEEPER_LAUNCH_SCHEMA_VERSION,
        blockers: [],
      });
      expect(initializeKeeperLaunchSchemaVersion(database)).toMatchObject({
        compatible: true,
        schemaVersion: KEEPER_LAUNCH_SCHEMA_VERSION,
        blockers: [],
      });
    } finally {
      database.close(false);
    }
  });

  test("reports every incompatible legacy surface without mutating it", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "keeper-db-audit-"));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, "keeper.sqlite");
    const database = new Database(databasePath, { create: true });
    createCanonicalSkeleton(database);
    database.run("ALTER TABLE bets ADD COLUMN source_amount REAL DEFAULT 0");
    database.run(
      "ALTER TABLE wallet_points ADD COLUMN staking_points REAL DEFAULT 0",
    );
    database.run("CREATE TABLE wallet_canonical (wallet TEXT PRIMARY KEY)");
    database.run(`INSERT INTO bets (
      id, bettor_wallet, chain, source_asset, source_amount_lamports, tx_signature, market_pda, duel_key, source_amount
    ) VALUES ('legacy-bet', 'legacy-wallet', 'SOLANA', 'SOL', 0, '', NULL, NULL, 1.25)`);
    database.run(
      "INSERT INTO wallet_points(wallet, self_points, staking_points) VALUES ('rank/wallet-1', 5, 10)",
    );
    database.close(false);

    const audit = auditKeeperDatabaseFile(databasePath);
    expect(audit.compatible).toBe(false);
    expect(audit.retiredActiveTables).toEqual(["wallet_canonical"]);
    expect(audit.retiredColumns).toEqual([
      "bets.source_amount",
      "wallet_points.staking_points",
    ]);
    expect(audit.unverifiedBetCount).toBe(1);
    expect(audit.derivedWalletRowCount).toBe(1);
    expect(audit.blockers).toContain("unverified-bets:1");

    const verifyReadOnly = new Database(databasePath, { readonly: true });
    try {
      expect(
        Object.values(
          (verifyReadOnly.query("PRAGMA user_version").get() as Record<
            string,
            unknown
          >) ?? {},
        )[0],
      ).toBe(0);
      expect(
        verifyReadOnly.query("SELECT COUNT(*) AS count FROM bets").get() as {
          count: number;
        },
      ).toEqual({ count: 1 });
    } finally {
      verifyReadOnly.close(false);
    }
  });

  test("rejects malformed rows even when an execution row exists", () => {
    const database = new Database(":memory:");
    try {
      createCanonicalSkeleton(database);
      database.run(`PRAGMA user_version = ${KEEPER_LAUNCH_SCHEMA_VERSION}`);
      database.run(`INSERT INTO bets (
        id, bettor_wallet, chain, source_asset, source_amount_lamports, tx_signature, market_pda, duel_key
      ) VALUES ('bad-bet', 'bad-wallet', 'SOLANA', 'SOL', 0, '', NULL, NULL)`);
      database.run("INSERT INTO bet_executions(bet_id) VALUES ('bad-bet')");
      const audit = inspectKeeperDatabaseCompatibility(database);
      expect(audit.compatible).toBe(false);
      expect(audit.unverifiedBetCount).toBe(0);
      expect(audit.invalidCanonicalBetCount).toBe(1);
      expect(audit.unboundDeploymentBetCount).toBe(1);
      expect(audit.blockers).toContain("invalid-canonical-bets:1");
      expect(audit.blockers).toContain("unbound-deployment-bets:1");
    } finally {
      database.close(false);
    }
  });

  test("gates the public bet write before parsing or verification work", () => {
    const source = readFileSync(
      new URL("./service.ts", import.meta.url),
      "utf8",
    );
    const handlerIndex = source.indexOf("async function handleBetRecord(");
    const healthIndex = source.indexOf(
      "const databaseHealth = checkDatabaseHealth();",
      handlerIndex,
    );
    const bodyIndex = source.indexOf(
      "readBoundedJsonObjectBody(req, 32 * 1024)",
      handlerIndex,
    );
    expect(handlerIndex).toBeGreaterThanOrEqual(0);
    expect(healthIndex).toBeGreaterThan(handlerIndex);
    expect(bodyIndex).toBeGreaterThan(healthIndex);
  });
});
