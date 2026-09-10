import type { Database } from "bun:sqlite";

const AGGREGATE_TABLE = "solana_terminal_settlements";
const BET_TABLE = "bet_terminal_settlements";
const AGGREGATE_MIGRATION_TABLE =
  "solana_terminal_settlements_schema_migration";
const BET_MIGRATION_TABLE = "bet_terminal_settlements_schema_migration";

const TWO_TERMINAL_KINDS =
  /kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*kind\s+IN\s*\(\s*'CLAIM_PAYOUT'\s*,\s*'CANCELLATION_REFUND'\s*\)\s*\)/i;
const THREE_TERMINAL_KINDS =
  /kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*kind\s+IN\s*\(\s*'CLAIM_PAYOUT'\s*,\s*'CANCELLATION_REFUND'\s*,\s*'LOSER_CLEANUP'\s*\)\s*\)/i;
const POSITIVE_GROSS =
  /gross_entitlement_lamports\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*gross_entitlement_lamports\s*>\s*0\s*\)/i;
const NONNEGATIVE_GROSS =
  /gross_entitlement_lamports\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*gross_entitlement_lamports\s*>=\s*0\s*\)/i;
const POSITIVE_PAYOUT =
  /payout_lamports\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*payout_lamports\s*>\s*0\s*\)/i;
const NONNEGATIVE_PAYOUT =
  /payout_lamports\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*payout_lamports\s*>=\s*0\s*\)/i;

const CANONICAL_AGGREGATE_TABLE_SQL = `CREATE TABLE ${AGGREGATE_MIGRATION_TABLE} (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  wallet TEXT NOT NULL,
  claim_signature TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CLAIM_PAYOUT', 'CANCELLATION_REFUND', 'LOSER_CLEANUP')),
  status TEXT NOT NULL CHECK (status IN ('resolved', 'cancelled')),
  winner TEXT NOT NULL CHECK (winner IN ('none', 'a', 'b')),
  gross_entitlement_lamports INTEGER NOT NULL CHECK (gross_entitlement_lamports >= 0),
  payout_lamports INTEGER NOT NULL CHECK (payout_lamports >= 0),
  fee_lamports INTEGER NOT NULL CHECK (fee_lamports >= 0),
  eligible_order_count INTEGER NOT NULL CHECK (eligible_order_count > 0),
  recorded_bet_count INTEGER NOT NULL CHECK (recorded_bet_count >= 0),
  reconciled_at INTEGER NOT NULL,
  PRIMARY KEY (cluster, program_id, market_pda, wallet)
)`;

const CANONICAL_BET_TABLE_SQL = `CREATE TABLE ${BET_MIGRATION_TABLE} (
  bet_id TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  wallet TEXT NOT NULL,
  order_id TEXT NOT NULL,
  side INTEGER NOT NULL CHECK (side IN (1, 2)),
  claim_signature TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CLAIM_PAYOUT', 'CANCELLATION_REFUND', 'LOSER_CLEANUP')),
  status TEXT NOT NULL CHECK (status IN ('resolved', 'cancelled')),
  winner TEXT NOT NULL CHECK (winner IN ('none', 'a', 'b')),
  matched_amount_units TEXT NOT NULL,
  gross_entitlement_lamports INTEGER NOT NULL CHECK (gross_entitlement_lamports >= 0),
  payout_lamports INTEGER NOT NULL CHECK (payout_lamports >= 0),
  fee_lamports INTEGER NOT NULL CHECK (fee_lamports >= 0),
  settled_at INTEGER NOT NULL
)`;

const AGGREGATE_COLUMNS = `
  cluster, program_id, market_pda, wallet, claim_signature,
  kind, status, winner, gross_entitlement_lamports, payout_lamports,
  fee_lamports, eligible_order_count, recorded_bet_count, reconciled_at
`;
const BET_COLUMNS = `
  bet_id, cluster, program_id, market_pda, wallet, order_id, side,
  claim_signature, kind, status, winner, matched_amount_units,
  gross_entitlement_lamports, payout_lamports, fee_lamports, settled_at
`;

function tableSql(db: Database, table: string): string {
  const row = db
    .query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(table) as { sql?: unknown } | null;
  if (!row || typeof row.sql !== "string") {
    throw new Error(`${table} is missing`);
  }
  return row.sql;
}

function aggregateNeedsMigration(sql: string): boolean {
  const hasLegacyKinds = TWO_TERMINAL_KINDS.test(sql);
  const hasCanonicalKinds = THREE_TERMINAL_KINDS.test(sql);
  if (!hasLegacyKinds && !hasCanonicalKinds) {
    throw new Error(
      "Solana terminal settlement kind constraint is unsupported",
    );
  }
  const hasPositiveGross = POSITIVE_GROSS.test(sql);
  const hasNonnegativeGross = NONNEGATIVE_GROSS.test(sql);
  if (!hasPositiveGross && !hasNonnegativeGross) {
    throw new Error(
      "Solana terminal settlement gross constraint is unsupported",
    );
  }
  const hasPositivePayout = POSITIVE_PAYOUT.test(sql);
  const hasNonnegativePayout = NONNEGATIVE_PAYOUT.test(sql);
  if (!hasPositivePayout && !hasNonnegativePayout) {
    throw new Error(
      "Solana terminal settlement payout constraint is unsupported",
    );
  }
  return !(hasCanonicalKinds && hasNonnegativeGross && hasNonnegativePayout);
}

function betNeedsMigration(sql: string): boolean {
  if (THREE_TERMINAL_KINDS.test(sql)) return false;
  if (TWO_TERMINAL_KINDS.test(sql)) return true;
  throw new Error("Per-bet terminal settlement kind constraint is unsupported");
}

export function ensureTerminalSettlementLedgerSchema(db: Database): void {
  const migrateAggregate = aggregateNeedsMigration(
    tableSql(db, AGGREGATE_TABLE),
  );
  const migrateBet = betNeedsMigration(tableSql(db, BET_TABLE));
  if (!migrateAggregate && !migrateBet) return;

  db.run("BEGIN IMMEDIATE");
  try {
    if (migrateAggregate) {
      db.run(CANONICAL_AGGREGATE_TABLE_SQL);
      db.run(
        `INSERT INTO ${AGGREGATE_MIGRATION_TABLE} (${AGGREGATE_COLUMNS})
         SELECT ${AGGREGATE_COLUMNS} FROM ${AGGREGATE_TABLE}`,
      );
      db.run(`DROP TABLE ${AGGREGATE_TABLE}`);
      db.run(
        `ALTER TABLE ${AGGREGATE_MIGRATION_TABLE} RENAME TO ${AGGREGATE_TABLE}`,
      );
    }
    if (migrateBet) {
      db.run(CANONICAL_BET_TABLE_SQL);
      db.run(
        `INSERT INTO ${BET_MIGRATION_TABLE} (${BET_COLUMNS})
         SELECT ${BET_COLUMNS} FROM ${BET_TABLE}`,
      );
      db.run(`DROP TABLE ${BET_TABLE}`);
      db.run(`ALTER TABLE ${BET_MIGRATION_TABLE} RENAME TO ${BET_TABLE}`);
    }
    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the original migration error if SQLite already rolled back.
    }
    throw error;
  }
}
