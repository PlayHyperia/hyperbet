import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureTerminalSettlementLedgerSchema } from "./terminalSettlementSchema";

const LEGACY_SCHEMA = `CREATE TABLE solana_terminal_settlements (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  wallet TEXT NOT NULL,
  claim_signature TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CLAIM_PAYOUT', 'CANCELLATION_REFUND')),
  status TEXT NOT NULL CHECK (status IN ('resolved', 'cancelled')),
  winner TEXT NOT NULL CHECK (winner IN ('none', 'a', 'b')),
  gross_entitlement_lamports INTEGER NOT NULL CHECK (gross_entitlement_lamports > 0),
  payout_lamports INTEGER NOT NULL CHECK (payout_lamports > 0),
  fee_lamports INTEGER NOT NULL CHECK (fee_lamports >= 0),
  eligible_order_count INTEGER NOT NULL CHECK (eligible_order_count > 0),
  recorded_bet_count INTEGER NOT NULL CHECK (recorded_bet_count >= 0),
  reconciled_at INTEGER NOT NULL,
  PRIMARY KEY (cluster, program_id, market_pda, wallet)
)`;

const LEGACY_BET_SCHEMA = `CREATE TABLE bet_terminal_settlements (
  bet_id TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  wallet TEXT NOT NULL,
  order_id TEXT NOT NULL,
  side INTEGER NOT NULL CHECK (side IN (1, 2)),
  claim_signature TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CLAIM_PAYOUT', 'CANCELLATION_REFUND')),
  status TEXT NOT NULL CHECK (status IN ('resolved', 'cancelled')),
  winner TEXT NOT NULL CHECK (winner IN ('none', 'a', 'b')),
  matched_amount_units TEXT NOT NULL,
  gross_entitlement_lamports INTEGER NOT NULL CHECK (gross_entitlement_lamports >= 0),
  payout_lamports INTEGER NOT NULL CHECK (payout_lamports >= 0),
  fee_lamports INTEGER NOT NULL CHECK (fee_lamports >= 0),
  settled_at INTEGER NOT NULL
)`;

function insertSettlement(
  db: Database,
  input: { wallet: string; payout: number; fee: number },
): void {
  db.run(
    `INSERT INTO solana_terminal_settlements (
      cluster, program_id, market_pda, wallet, claim_signature,
      kind, status, winner, gross_entitlement_lamports, payout_lamports,
      fee_lamports, eligible_order_count, recorded_bet_count, reconciled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "localnet",
      "program",
      `market-${input.wallet}`,
      input.wallet,
      `signature-${input.wallet}`,
      "CLAIM_PAYOUT",
      "resolved",
      "a",
      input.payout + input.fee,
      input.payout,
      input.fee,
      1,
      1,
      1,
    ],
  );
}

describe("SOL terminal settlement schema", () => {
  test("preserves legacy rows and admits zero-payout claims and loser cleanup", () => {
    const db = new Database(":memory:", { strict: true });
    try {
      db.run("CREATE TABLE bets (id TEXT PRIMARY KEY)");
      db.run(LEGACY_SCHEMA);
      db.run(LEGACY_BET_SCHEMA);
      insertSettlement(db, { wallet: "legacy", payout: 99, fee: 1 });
      db.run("INSERT INTO bets (id) VALUES ('legacy-bet')");
      db.run(
        `INSERT INTO bet_terminal_settlements VALUES (
          'legacy-bet', 'localnet', 'program', 'market-legacy', 'legacy', '1', 1,
          'signature-legacy', 'CLAIM_PAYOUT', 'resolved', 'a', '100', 100, 99, 1, 1
        )`,
      );

      ensureTerminalSettlementLedgerSchema(db);
      ensureTerminalSettlementLedgerSchema(db);
      insertSettlement(db, { wallet: "zero-payout", payout: 0, fee: 100 });
      db.run(
        `INSERT INTO solana_terminal_settlements VALUES (
          'localnet', 'program', 'market-cleanup', 'cleanup', 'signature-cleanup',
          'LOSER_CLEANUP', 'resolved', 'a', 0, 0, 0, 1, 1, 2
        )`,
      );
      db.run("INSERT INTO bets (id) VALUES ('cleanup-bet')");
      db.run(
        `INSERT INTO bet_terminal_settlements VALUES (
          'cleanup-bet', 'localnet', 'program', 'market-cleanup', 'cleanup', '2', 2,
          'signature-cleanup', 'LOSER_CLEANUP', 'resolved', 'a', '100', 0, 0, 0, 2
        )`,
      );

      const rows = db
        .query(
          `SELECT wallet, kind, payout_lamports AS payout, fee_lamports AS fee
           FROM solana_terminal_settlements ORDER BY wallet`,
        )
        .all();
      expect(rows).toEqual([
        {
          wallet: "cleanup",
          kind: "LOSER_CLEANUP",
          payout: 0,
          fee: 0,
        },
        { wallet: "legacy", kind: "CLAIM_PAYOUT", payout: 99, fee: 1 },
        {
          wallet: "zero-payout",
          kind: "CLAIM_PAYOUT",
          payout: 0,
          fee: 100,
        },
      ]);
      const schema = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'solana_terminal_settlements'",
        )
        .get() as { sql: string };
      expect(schema.sql).toContain("CHECK (payout_lamports >= 0)");
      expect(schema.sql).toContain("CHECK (gross_entitlement_lamports >= 0)");
      expect(schema.sql).toContain("'LOSER_CLEANUP'");
      const betSchema = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bet_terminal_settlements'",
        )
        .get() as { sql: string };
      expect(betSchema.sql).toContain("'LOSER_CLEANUP'");
      expect(
        db
          .query("SELECT kind FROM bet_terminal_settlements ORDER BY bet_id")
          .all(),
      ).toEqual([{ kind: "LOSER_CLEANUP" }, { kind: "CLAIM_PAYOUT" }]);
      expect(
        db
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('solana_terminal_settlements_schema_migration', 'bet_terminal_settlements_schema_migration')",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("fails closed on an unknown payout constraint", () => {
    const db = new Database(":memory:", { strict: true });
    try {
      db.run(
        LEGACY_SCHEMA.replace("payout_lamports > 0", "payout_lamports <> 0"),
      );
      expect(() => ensureTerminalSettlementLedgerSchema(db)).toThrow(
        "payout constraint is unsupported",
      );
      expect(
        db
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'solana_terminal_settlements'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("fails closed before mutation on an unknown per-bet kind constraint", () => {
    const db = new Database(":memory:", { strict: true });
    try {
      db.run("CREATE TABLE bets (id TEXT PRIMARY KEY)");
      db.run(LEGACY_SCHEMA);
      db.run(
        LEGACY_BET_SCHEMA.replace(
          "kind IN ('CLAIM_PAYOUT', 'CANCELLATION_REFUND')",
          "kind <> ''",
        ),
      );
      expect(() => ensureTerminalSettlementLedgerSchema(db)).toThrow(
        "Per-bet terminal settlement kind constraint is unsupported",
      );
      const aggregateSchema = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'solana_terminal_settlements'",
        )
        .get() as { sql: string };
      expect(aggregateSchema.sql).toContain(
        "CHECK (gross_entitlement_lamports > 0)",
      );
    } finally {
      db.close();
    }
  });
});
