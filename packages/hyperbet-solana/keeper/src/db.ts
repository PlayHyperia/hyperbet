/**
 * SQLite persistence for the keeper service.
 *
 * Strategy: load-on-start + write-through.
 * All existing in-memory Maps are populated from the DB at startup.
 * Every mutation calls one of the save* functions below so data survives
 * restarts. Rate-limit buckets, parsers and SSE clients remain ephemeral.
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordedBetChain } from "./solanaLifecycle";
import {
  legacySolAmountToLamports,
  normalizeLamports,
  referralPointsForBetPoints,
} from "./nativeAmount";
import {
  digestLifecycleFacts,
  normalizeLifecycleFact,
  type SolanaLifecycleFact,
} from "./solanaLifecycleIndexer";
import {
  isCanonicalSolanaTransactionSignature,
  quoteCostLamports,
} from "./solanaBetAccounting";
import { PublicKey } from "@solana/web3.js";
import {
  reconcileBetExecutionFromIndexedFacts,
  type BetExecutionBaseline,
  type IndexedLifecycleFact,
} from "./solanaBetReconciliation";
import {
  reconcileWalletMarketTerminalSettlements,
  type SolanaTerminalSettlementKind,
} from "./solanaTerminalSettlement";
import {
  applyKeeperLegacyMigration,
  initializeKeeperLaunchSchemaVersion,
  inspectKeeperDatabaseCompatibility,
  type ApplyKeeperLegacyMigrationInput,
  type KeeperDatabaseCompatibilityAudit,
  type KeeperLegacyMigrationResult,
} from "./legacyDatabasePolicy";
import { buildDuelCorrelationId } from "./duelCorrelation";
import { ensureTerminalSettlementLedgerSchema } from "./terminalSettlementSchema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KEEPER_DB_PATH?.trim()
  ? process.env.KEEPER_DB_PATH.trim()
  : path.resolve(__dirname, "..", "keeper.sqlite");

export type DbBetRecord = {
  id: string;
  cluster: DbSolanaCluster;
  programId: string;
  bettorWallet: string;
  chain: RecordedBetChain;
  sourceAsset: "SOL";
  sourceAmountLamports: string;
  feeAmountLamports: string;
  feeBps: number;
  txSignature: string;
  marketPda: string | null;
  duelKey: string | null;
  duelId: string | null;
  inviteCode: string | null;
  externalBetRef: string | null;
  recordedAt: number;
};

export type DbSolanaCluster =
  "localnet" | "devnet" | "testnet" | "mainnet-beta";

export type DbBetExecutionRecord = {
  orderId: string;
  side: 1 | 2;
  limitPrice: number;
  orderBehavior: 0 | 1 | 2;
  orderAmountUnits: string;
  matchedAmountUnits: string;
  restingAmountUnits: string;
  releasedAmountUnits: string;
  collateralLamports: string;
  executedCostLamports: string;
  tradeTreasuryFeeLamports: string;
  tradeMarketMakerFeeLamports: string;
  rewardEligibleLamports: string;
  verifiedAt: number;
};

export type DbWalletPoints = {
  selfPoints: number;
  winPoints: number;
  referralPoints: number;
};

export type DbPointsEventRecord = {
  id: number;
  wallet: string;
  eventType: string;
  status: string;
  totalPoints: number;
  referenceType: string | null;
  referenceId: string | null;
  relatedWallet: string | null;
  createdAt: number;
};

export type DbSolanaIndexerCheckpoint = {
  cluster: string;
  programId: string;
  startSlot: number;
  signature: string;
  slot: number;
  updatedAt: number;
};

export type DbSolanaIndexedTransaction = {
  cluster: string;
  programId: string;
  startSlot: number;
  signature: string;
  slot: number;
  blockTime: number | null;
  succeeded: boolean;
  instructionNames: string[];
  transactionDigest: string;
  facts: SolanaLifecycleFact[];
  indexedAt: number;
};

export type DbSolanaIndexedTransactionEvidence = Omit<
  DbSolanaIndexedTransaction,
  "startSlot"
>;

export type DbSolanaLifecycleFactRecord = {
  signature: string;
  slot: number;
  factIndex: number;
  fact: SolanaLifecycleFact;
};

export type DbBetLifecycleReconciliationChange = {
  betId: string;
  wallet: string;
  selfPointsDelta: number;
  referrerWallet: string | null;
  referralPointsDelta: number;
  events: DbPointsEventRecord[];
};

export type DbBetTerminalSettlementRecord = {
  betId: string;
  marketPda: string;
  wallet: string;
  orderId: string;
  side: 1 | 2;
  claimSignature: string;
  kind: SolanaTerminalSettlementKind;
  status: "resolved" | "cancelled";
  winner: "none" | "a" | "b";
  matchedAmountUnits: string;
  grossEntitlementLamports: string;
  payoutLamports: string;
  feeLamports: string;
  settledAt: number;
};

export type DbSolanaBetOrderState =
  | "PENDING_INDEX"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CLOSED_PARTIAL"
  | "RELEASED"
  | "RECLAIM_REQUIRED";

export type DbSolanaBetSettlementState =
  | "NOT_READY"
  | "AWAITING_RESULT"
  | "PAYOUT_CLAIMABLE"
  | "REFUND_CLAIMABLE"
  | "PAID"
  | "REFUNDED"
  | "LOST"
  | "NO_ENTITLEMENT";

export type DbSolanaWalletBetHistoryEntry = {
  betId: string;
  wallet: string;
  marketPda: string;
  duelKey: string | null;
  duelId: string | null;
  correlationId: string | null;
  placeSignature: string;
  recordedAt: number;
  orderId: string;
  side: 1 | 2;
  limitPrice: number;
  orderAmountUnits: string;
  matchedAmountUnits: string;
  restingAmountUnits: string;
  releasedAmountUnits: string;
  sourceAmountLamports: string;
  collateralLamports: string;
  executedCostLamports: string;
  tradeFeeLamports: string;
  orderRefundLamports: string;
  rewardEligibleLamports: string;
  marketStatus: "open" | "locked" | "resolved" | "cancelled" | null;
  winner: "none" | "a" | "b" | null;
  orderState: DbSolanaBetOrderState;
  settlementState: DbSolanaBetSettlementState;
  terminalKind: SolanaTerminalSettlementKind | null;
  terminalStatus: "resolved" | "cancelled" | null;
  terminalWinner: "none" | "a" | "b" | null;
  claimSignature: string | null;
  terminalGrossLamports: string;
  terminalPayoutLamports: string;
  terminalFeeLamports: string;
  reconciledAt: number | null;
  settledAt: number | null;
};

export type DbSolanaWalletBetHistory = {
  wallet: string;
  entries: DbSolanaWalletBetHistoryEntry[];
  total: number;
  limit: number;
  offset: number;
};

// ── DB singleton ──────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA busy_timeout = 5000");
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA foreign_keys = ON");

// ── Schema ────────────────────────────────────────────────────────────────────

db.run(`CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  bettor_wallet TEXT NOT NULL,
  chain TEXT NOT NULL,
  source_asset TEXT NOT NULL,
  source_amount_lamports INTEGER NOT NULL CHECK (source_amount_lamports > 0),
  fee_amount_lamports INTEGER NOT NULL DEFAULT 0 CHECK (fee_amount_lamports >= 0),
  fee_bps INTEGER NOT NULL DEFAULT 0,
  tx_signature TEXT NOT NULL DEFAULT '',
  market_pda TEXT,
  duel_key TEXT,
  duel_id TEXT,
  invite_code TEXT,
  external_bet_ref TEXT,
  recorded_at INTEGER NOT NULL
)`);
try {
  db.run("ALTER TABLE bets ADD COLUMN duel_key TEXT");
} catch {
  // Column already exists.
}
try {
  db.run("ALTER TABLE bets ADD COLUMN duel_id TEXT");
} catch {
  // Column already exists.
}
try {
  db.run(
    "ALTER TABLE bets ADD COLUMN source_amount_lamports INTEGER NOT NULL DEFAULT 0 CHECK (source_amount_lamports >= 0)",
  );
} catch {
  // Column already exists.
}
try {
  db.run(
    "ALTER TABLE bets ADD COLUMN fee_amount_lamports INTEGER NOT NULL DEFAULT 0 CHECK (fee_amount_lamports >= 0)",
  );
} catch {
  // Column already exists.
}

db.run(`CREATE TABLE IF NOT EXISTS bet_deployment_identities (
  bet_id TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL
)`);

function tableHasColumn(tableName: string, columnName: string): boolean {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

const legacySourceAmountSelect = tableHasColumn("bets", "source_amount")
  ? "CAST(source_amount AS TEXT)"
  : "'0'";
db.run(`CREATE TABLE IF NOT EXISTS bets_duplicate_conflicts (
  original_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  tx_signature TEXT NOT NULL DEFAULT '',
  external_bet_ref TEXT,
  recorded_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  archived_at INTEGER NOT NULL
)`);

type DuplicateBetKeyRow = {
  value: string;
};

type DuplicateChainTxKeyRow = {
  chain: string;
  txSignature: string;
};

type DuplicateBetCandidate = {
  rowid: number;
  id: string;
  chain: string;
  txSignature: string;
  externalBetRef: string | null;
  recordedAt: number;
};

function resolveDuplicateRecordedBets(): void {
  const quarantinedCount = db.transaction(() => {
    const archivedAt = Date.now();
    let quarantined = 0;
    const archiveConflict = db.prepare(
      `INSERT OR REPLACE INTO bets_duplicate_conflicts (
        original_id,
        chain,
        tx_signature,
        external_bet_ref,
        recorded_at,
        reason,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteBet = db.prepare(`DELETE FROM bets WHERE rowid = ?`);
    const loadRowsByChainTx = db.prepare(
      `SELECT
         rowid,
         id,
         chain,
         tx_signature AS txSignature,
         external_bet_ref AS externalBetRef,
         recorded_at AS recordedAt
       FROM bets
      WHERE chain = ? AND tx_signature = ?
      ORDER BY recorded_at ASC, rowid ASC`,
    );
    const loadRowsByExternalRef = db.prepare(
      `SELECT
         rowid,
         id,
         chain,
         tx_signature AS txSignature,
         external_bet_ref AS externalBetRef,
         recorded_at AS recordedAt
       FROM bets
      WHERE external_bet_ref = ?
      ORDER BY recorded_at ASC, rowid ASC`,
    );
    const quarantineRows = (
      rows: DuplicateBetCandidate[],
      reasonPrefix: string,
    ) => {
      if (rows.length <= 1) return;
      const [canonical, ...duplicates] = rows;
      for (const duplicate of duplicates) {
        archiveConflict.run(
          duplicate.id,
          duplicate.chain,
          duplicate.txSignature,
          duplicate.externalBetRef,
          duplicate.recordedAt,
          `${reasonPrefix}; canonical_id=${canonical.id}`,
          archivedAt,
        );
        deleteBet.run(duplicate.rowid);
        quarantined += 1;
      }
    };

    const duplicateChainTxSignatures = db
      .prepare(
        `SELECT chain, tx_signature AS txSignature
           FROM bets
          WHERE tx_signature <> ''
          GROUP BY chain, tx_signature
         HAVING COUNT(*) > 1`,
      )
      .all() as DuplicateChainTxKeyRow[];
    for (const row of duplicateChainTxSignatures) {
      quarantineRows(
        loadRowsByChainTx.all(
          row.chain,
          row.txSignature,
        ) as DuplicateBetCandidate[],
        `duplicate chain+tx_signature (${row.chain}:${row.txSignature})`,
      );
    }

    const duplicateExternalRefs = db
      .prepare(
        `SELECT external_bet_ref AS value
           FROM bets
          WHERE external_bet_ref IS NOT NULL
          GROUP BY external_bet_ref
         HAVING COUNT(*) > 1`,
      )
      .all() as DuplicateBetKeyRow[];
    for (const row of duplicateExternalRefs) {
      quarantineRows(
        loadRowsByExternalRef.all(row.value) as DuplicateBetCandidate[],
        `duplicate external_bet_ref (${row.value})`,
      );
    }

    return quarantined;
  })();

  if (quarantinedCount > 0) {
    console.warn(
      `[keeper-db] Quarantined ${quarantinedCount} duplicate recorded bet row(s) into bets_duplicate_conflicts before enforcing uniqueness.`,
    );
  }
}

resolveDuplicateRecordedBets();

db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_external_bet_ref_unique
  ON bets (external_bet_ref)
  WHERE external_bet_ref IS NOT NULL`);

db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_chain_tx_signature_unique
  ON bets (chain, tx_signature)
  WHERE tx_signature <> ''`);

db.run(`CREATE TABLE IF NOT EXISTS bet_executions (
  bet_id TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  side INTEGER NOT NULL CHECK (side IN (1, 2)),
  limit_price INTEGER NOT NULL CHECK (limit_price > 0 AND limit_price < 1000),
  order_behavior INTEGER NOT NULL CHECK (order_behavior IN (0, 1, 2)),
  order_amount_units TEXT NOT NULL,
  matched_amount_units TEXT NOT NULL,
  resting_amount_units TEXT NOT NULL,
  released_amount_units TEXT NOT NULL,
  collateral_lamports INTEGER NOT NULL CHECK (collateral_lamports >= 0),
  executed_cost_lamports INTEGER NOT NULL CHECK (executed_cost_lamports >= 0),
  trade_treasury_fee_lamports INTEGER NOT NULL CHECK (trade_treasury_fee_lamports >= 0),
  trade_market_maker_fee_lamports INTEGER NOT NULL CHECK (trade_market_maker_fee_lamports >= 0),
  reward_eligible_lamports INTEGER NOT NULL CHECK (reward_eligible_lamports >= 0),
  verified_at INTEGER NOT NULL
)`);

db.run(`CREATE TABLE IF NOT EXISTS solana_indexer_checkpoints (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  start_slot INTEGER NOT NULL CHECK (start_slot >= 0),
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= start_slot),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (cluster, program_id)
)`);

db.run(`CREATE TABLE IF NOT EXISTS solana_indexed_transactions (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  block_time INTEGER,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  instruction_names_json TEXT NOT NULL,
  transaction_digest TEXT NOT NULL,
  facts_digest TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (cluster, program_id, signature)
)`);

db.run(`CREATE TABLE IF NOT EXISTS solana_lifecycle_facts (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  fact_index INTEGER NOT NULL CHECK (fact_index >= 0),
  kind TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (cluster, program_id, signature, fact_index),
  FOREIGN KEY (cluster, program_id, signature)
    REFERENCES solana_indexed_transactions(cluster, program_id, signature)
    ON DELETE CASCADE
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_solana_lifecycle_facts_market_kind
  ON solana_lifecycle_facts (cluster, program_id, market_pda, kind)`);

db.run(`CREATE TABLE IF NOT EXISTS bet_lifecycle_accounting (
  bet_id TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  matched_amount_units TEXT NOT NULL,
  resting_amount_units TEXT NOT NULL,
  released_amount_units TEXT NOT NULL,
  executed_cost_lamports INTEGER NOT NULL CHECK (executed_cost_lamports >= 0),
  trade_fee_lamports INTEGER NOT NULL CHECK (trade_fee_lamports >= 0),
  refund_lamports INTEGER NOT NULL CHECK (refund_lamports >= 0),
  reward_eligible_lamports INTEGER NOT NULL CHECK (reward_eligible_lamports >= 0),
  reward_points_total INTEGER NOT NULL CHECK (reward_points_total >= 0),
  reward_points_applied INTEGER NOT NULL CHECK (reward_points_applied >= 0),
  referrer_wallet TEXT,
  referral_points_applied INTEGER NOT NULL CHECK (referral_points_applied >= 0),
  through_slot INTEGER NOT NULL CHECK (through_slot >= 0),
  through_signature TEXT NOT NULL,
  reconciled_at INTEGER NOT NULL
)`);
try {
  db.run(
    "ALTER TABLE bet_lifecycle_accounting ADD COLUMN referrer_wallet TEXT",
  );
} catch {
  // Column already exists.
}

db.run(`CREATE TABLE IF NOT EXISTS solana_terminal_settlements (
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
)`);

db.run(`CREATE TABLE IF NOT EXISTS bet_terminal_settlements (
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
)`);

ensureTerminalSettlementLedgerSchema(db);

db.run(`CREATE INDEX IF NOT EXISTS idx_bet_terminal_settlements_wallet_market
  ON bet_terminal_settlements (wallet, market_pda, settled_at DESC)`);
try {
  db.run(
    "ALTER TABLE bet_lifecycle_accounting ADD COLUMN through_signature TEXT NOT NULL DEFAULT ''",
  );
} catch {
  // Column already exists.
}

db.run(`CREATE TABLE IF NOT EXISTS wallet_display (
  normalized_wallet TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
)`);

db.run(`CREATE TABLE IF NOT EXISTS wallet_points (
  wallet TEXT PRIMARY KEY,
  self_points REAL NOT NULL DEFAULT 0,
  win_points REAL NOT NULL DEFAULT 0,
  referral_points REAL NOT NULL DEFAULT 0
)`);

db.run(`CREATE TABLE IF NOT EXISTS points_events (
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

db.run(`CREATE INDEX IF NOT EXISTS idx_points_events_wallet_time
  ON points_events (wallet, created_at DESC)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_points_events_type_time
  ON points_events (event_type, created_at DESC)`);

db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
  wallet TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE
)`);

db.run(`CREATE TABLE IF NOT EXISTS referrals (
  wallet TEXT PRIMARY KEY,
  referrer_wallet TEXT NOT NULL,
  invite_code TEXT NOT NULL
)`);

db.run(`CREATE TABLE IF NOT EXISTS invited_wallets (
  referrer TEXT NOT NULL,
  invitee TEXT NOT NULL,
  PRIMARY KEY (referrer, invitee)
)`);

db.run(`CREATE TABLE IF NOT EXISTS keeper_legacy_rows (
  source_table TEXT NOT NULL,
  source_key TEXT NOT NULL,
  row_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  migration_id INTEGER,
  PRIMARY KEY (source_table, source_key)
)`);

db.run(`CREATE TABLE IF NOT EXISTS keeper_legacy_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  backup_sha256 TEXT NOT NULL UNIQUE,
  release_sha TEXT NOT NULL,
  cluster TEXT NOT NULL,
  archived_row_count INTEGER NOT NULL CHECK (archived_row_count >= 0),
  renamed_table_count INTEGER NOT NULL CHECK (renamed_table_count >= 0),
  applied_at INTEGER NOT NULL
)`);

initializeKeeperLaunchSchemaVersion(db);

// ── Prepared statements ───────────────────────────────────────────────────────

const insertBet = db.prepare(`INSERT OR IGNORE INTO bets
  (id, bettor_wallet, chain, source_asset, source_amount_lamports, fee_amount_lamports,
   fee_bps, tx_signature, market_pda, duel_key, duel_id, invite_code, external_bet_ref, recorded_at)
  VALUES ($id, $bettorWallet, $chain, $sourceAsset, $sourceAmountLamports, $feeAmountLamports,
          $feeBps, $txSignature, $marketPda, $duelKey, $duelId, $inviteCode, $externalBetRef, $recordedAt)`);

const insertBetDeploymentIdentity = db.prepare(
  `INSERT INTO bet_deployment_identities (bet_id, cluster, program_id, bound_at)
   VALUES ($betId, $cluster, $programId, $boundAt)`,
);

const insertBetExecution = db.prepare(`INSERT INTO bet_executions (
  bet_id, order_id, side, limit_price, order_behavior, order_amount_units,
  matched_amount_units, resting_amount_units, released_amount_units,
  collateral_lamports, executed_cost_lamports,
  trade_treasury_fee_lamports, trade_market_maker_fee_lamports,
  reward_eligible_lamports, verified_at
) VALUES (
  $betId, $orderId, $side, $limitPrice, $orderBehavior, $orderAmountUnits,
  $matchedAmountUnits, $restingAmountUnits, $releasedAmountUnits,
  $collateralLamports, $executedCostLamports,
  $tradeTreasuryFeeLamports, $tradeMarketMakerFeeLamports,
  $rewardEligibleLamports, $verifiedAt
)`);

const loadSolanaIndexerCheckpointStatement = db.prepare(`SELECT
  cluster,
  program_id AS programId,
  start_slot AS startSlot,
  signature,
  slot,
  updated_at AS updatedAt
FROM solana_indexer_checkpoints
WHERE cluster = ? AND program_id = ?`);

const loadSolanaIndexedTransactionStatement = db.prepare(`SELECT
  slot,
  block_time AS blockTime,
  succeeded,
  instruction_names_json AS instructionNamesJson,
  transaction_digest AS transactionDigest,
  facts_digest AS factsDigest,
  indexed_at AS indexedAt
FROM solana_indexed_transactions
WHERE cluster = ? AND program_id = ? AND signature = ?`);

const insertSolanaIndexedTransactionStatement =
  db.prepare(`INSERT INTO solana_indexed_transactions (
    cluster, program_id, signature, slot, block_time, succeeded,
    instruction_names_json, transaction_digest, facts_digest, indexed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const insertSolanaLifecycleFactStatement =
  db.prepare(`INSERT INTO solana_lifecycle_facts (
    cluster, program_id, signature, fact_index, kind, market_pda, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);

const upsertSolanaIndexerCheckpointStatement =
  db.prepare(`INSERT INTO solana_indexer_checkpoints (
    cluster, program_id, start_slot, signature, slot, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(cluster, program_id) DO UPDATE SET
    signature = excluded.signature,
    slot = excluded.slot,
    updated_at = excluded.updated_at`);

const loadSolanaLifecycleFactsStatement = db.prepare(`SELECT
  facts.signature,
  transactions.slot,
  facts.fact_index AS factIndex,
  facts.payload_json AS payloadJson
FROM solana_lifecycle_facts AS facts
JOIN solana_indexed_transactions AS transactions
  ON transactions.cluster = facts.cluster
 AND transactions.program_id = facts.program_id
 AND transactions.signature = facts.signature
WHERE facts.cluster = ?
  AND facts.program_id = ?
  AND (? IS NULL OR facts.market_pda = ?)
  AND (? IS NULL OR facts.kind = ?)
ORDER BY transactions.slot ASC, facts.signature ASC, facts.fact_index ASC`);

const loadSolanaLifecycleFactsForTransactionStatement = db.prepare(`SELECT
  fact_index AS factIndex,
  payload_json AS payloadJson
FROM solana_lifecycle_facts
WHERE cluster = ? AND program_id = ? AND signature = ?
ORDER BY fact_index ASC`);

const loadBetExecutionBaselinesStatement = db.prepare(`SELECT
  bets.id AS betId,
  bets.bettor_wallet AS wallet,
  bets.tx_signature AS txSignature,
  bets.market_pda AS marketPda,
  bets.recorded_at AS recordedAt,
  COALESCE(bets.external_bet_ref, bets.tx_signature, bets.id) AS referenceId,
  executions.order_id AS orderId,
  executions.side,
  executions.limit_price AS limitPrice,
  executions.order_amount_units AS orderAmountUnits,
  executions.matched_amount_units AS initialMatchedAmountUnits,
  executions.resting_amount_units AS initialRestingAmountUnits,
  executions.released_amount_units AS initialReleasedAmountUnits,
  CAST(executions.collateral_lamports AS TEXT) AS initialCollateralLamports,
  CAST(executions.executed_cost_lamports AS TEXT) AS initialExecutedCostLamports,
  CAST(executions.trade_treasury_fee_lamports + executions.trade_market_maker_fee_lamports AS TEXT)
    AS initialTradeFeeLamports,
  CAST(executions.reward_eligible_lamports AS TEXT) AS initialRewardEligibleLamports,
  lifecycle.through_slot AS lifecycleThroughSlot,
  lifecycle.through_signature AS lifecycleThroughSignature
FROM bets
JOIN bet_executions AS executions ON executions.bet_id = bets.id
JOIN bet_deployment_identities AS deployment
  ON deployment.bet_id = bets.id
 AND deployment.cluster = ?
 AND deployment.program_id = ?
LEFT JOIN bet_lifecycle_accounting AS lifecycle ON lifecycle.bet_id = bets.id
WHERE UPPER(bets.chain) = 'SOLANA'
  AND UPPER(bets.source_asset) = 'SOL'
  AND bets.market_pda IS NOT NULL
  AND bets.tx_signature <> ''
ORDER BY bets.recorded_at ASC, bets.id ASC`);

const loadBetLifecycleAccountingStatement = db.prepare(`SELECT
  reward_points_applied AS rewardPointsApplied,
  referrer_wallet AS referrerWallet,
  referral_points_applied AS referralPointsApplied,
  through_slot AS throughSlot,
  through_signature AS throughSignature
FROM bet_lifecycle_accounting
WHERE bet_id = ?`);

const sumPointsEventStatement = db.prepare(`SELECT
  COALESCE(SUM(total_points), 0) AS total
FROM points_events
WHERE wallet = ?
  AND event_type = ?
  AND reference_id = ?
  AND (? IS NULL OR related_wallet = ?)`);

const loadReferrerStatement =
  db.prepare(`SELECT referrer_wallet AS referrerWallet
FROM referrals
WHERE wallet = ?`);

const addSelfPointsStatement = db.prepare(`INSERT INTO wallet_points (
  wallet, self_points, win_points, referral_points
) VALUES (?, ?, 0, 0)
ON CONFLICT(wallet) DO UPDATE SET
  self_points = wallet_points.self_points + excluded.self_points`);

const addReferralPointsStatement = db.prepare(`INSERT INTO wallet_points (
  wallet, self_points, win_points, referral_points
) VALUES (?, 0, 0, ?)
ON CONFLICT(wallet) DO UPDATE SET
  referral_points = wallet_points.referral_points + excluded.referral_points`);

const upsertBetLifecycleAccountingStatement =
  db.prepare(`INSERT INTO bet_lifecycle_accounting (
    bet_id, matched_amount_units, resting_amount_units, released_amount_units,
    executed_cost_lamports, trade_fee_lamports, refund_lamports,
    reward_eligible_lamports, reward_points_total, reward_points_applied,
    referrer_wallet, referral_points_applied, through_slot, through_signature,
    reconciled_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(bet_id) DO UPDATE SET
    matched_amount_units = excluded.matched_amount_units,
    resting_amount_units = excluded.resting_amount_units,
    released_amount_units = excluded.released_amount_units,
    executed_cost_lamports = excluded.executed_cost_lamports,
    trade_fee_lamports = excluded.trade_fee_lamports,
    refund_lamports = excluded.refund_lamports,
    reward_eligible_lamports = excluded.reward_eligible_lamports,
    reward_points_total = excluded.reward_points_total,
    reward_points_applied = excluded.reward_points_applied,
    referrer_wallet = excluded.referrer_wallet,
    referral_points_applied = excluded.referral_points_applied,
    through_slot = excluded.through_slot,
    through_signature = excluded.through_signature,
    reconciled_at = excluded.reconciled_at`);

const loadSolanaTerminalSettlementStatement = db.prepare(`SELECT
  claim_signature AS claimSignature,
  kind,
  status,
  winner,
  CAST(gross_entitlement_lamports AS TEXT) AS grossEntitlementLamports,
  CAST(payout_lamports AS TEXT) AS payoutLamports,
  CAST(fee_lamports AS TEXT) AS feeLamports,
  eligible_order_count AS eligibleOrderCount,
  recorded_bet_count AS recordedBetCount
FROM solana_terminal_settlements
WHERE cluster = ? AND program_id = ? AND market_pda = ? AND wallet = ?`);

const insertSolanaTerminalSettlementStatement =
  db.prepare(`INSERT INTO solana_terminal_settlements (
    cluster, program_id, market_pda, wallet, claim_signature,
    kind, status, winner, gross_entitlement_lamports, payout_lamports,
    fee_lamports, eligible_order_count, recorded_bet_count, reconciled_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const updateSolanaTerminalRecordedBetCountStatement = db.prepare(`UPDATE
  solana_terminal_settlements
SET recorded_bet_count = ?, reconciled_at = ?
WHERE cluster = ? AND program_id = ? AND market_pda = ? AND wallet = ?`);

const loadBetTerminalSettlementStatement = db.prepare(`SELECT
  bet_id AS betId,
  market_pda AS marketPda,
  wallet,
  order_id AS orderId,
  side,
  claim_signature AS claimSignature,
  kind,
  status,
  winner,
  matched_amount_units AS matchedAmountUnits,
  CAST(gross_entitlement_lamports AS TEXT) AS grossEntitlementLamports,
  CAST(payout_lamports AS TEXT) AS payoutLamports,
  CAST(fee_lamports AS TEXT) AS feeLamports,
  settled_at AS settledAt
FROM bet_terminal_settlements
WHERE bet_id = ?`);

const insertBetTerminalSettlementStatement =
  db.prepare(`INSERT INTO bet_terminal_settlements (
    bet_id, cluster, program_id, market_pda, wallet, order_id, side,
    claim_signature, kind, status, winner, matched_amount_units,
    gross_entitlement_lamports, payout_lamports, fee_lamports, settled_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const loadSolanaWalletBetHistoryStatement =
  db.prepare(`WITH ranked_market_state AS (
  SELECT
    facts.market_pda AS marketPda,
    facts.payload_json AS payloadJson,
    ROW_NUMBER() OVER (
      PARTITION BY facts.market_pda
      ORDER BY transactions.slot DESC, facts.signature DESC, facts.fact_index DESC
    ) AS stateRank
  FROM solana_lifecycle_facts AS facts
  JOIN solana_indexed_transactions AS transactions
    ON transactions.cluster = facts.cluster
   AND transactions.program_id = facts.program_id
   AND transactions.signature = facts.signature
  WHERE facts.kind = 'MARKET_SYNCED'
    AND facts.cluster = ?
    AND facts.program_id = ?
)
SELECT
  bets.id AS betId,
  bets.bettor_wallet AS wallet,
  bets.market_pda AS marketPda,
  bets.duel_key AS duelKey,
  bets.duel_id AS duelId,
  bets.tx_signature AS placeSignature,
  bets.recorded_at AS recordedAt,
  CAST(bets.source_amount_lamports AS TEXT) AS sourceAmountLamports,
  executions.order_id AS orderId,
  executions.side,
  executions.limit_price AS limitPrice,
  executions.order_amount_units AS orderAmountUnits,
  COALESCE(lifecycle.matched_amount_units, executions.matched_amount_units)
    AS matchedAmountUnits,
  COALESCE(lifecycle.resting_amount_units, executions.resting_amount_units)
    AS restingAmountUnits,
  COALESCE(lifecycle.released_amount_units, executions.released_amount_units)
    AS releasedAmountUnits,
  CAST(executions.collateral_lamports AS TEXT) AS initialCollateralLamports,
  CAST(COALESCE(lifecycle.executed_cost_lamports, executions.executed_cost_lamports) AS TEXT)
    AS executedCostLamports,
  CAST(COALESCE(
    lifecycle.trade_fee_lamports,
    executions.trade_treasury_fee_lamports + executions.trade_market_maker_fee_lamports
  ) AS TEXT) AS tradeFeeLamports,
  CAST(lifecycle.refund_lamports AS TEXT) AS reconciledOrderRefundLamports,
  CAST(COALESCE(lifecycle.reward_eligible_lamports, executions.reward_eligible_lamports) AS TEXT)
    AS rewardEligibleLamports,
  lifecycle.reconciled_at AS reconciledAt,
  market.payloadJson AS marketStatePayloadJson,
  terminal.claim_signature AS claimSignature,
  terminal.kind AS terminalKind,
  terminal.status AS terminalStatus,
  terminal.winner AS terminalWinner,
  terminal.market_pda AS terminalMarketPda,
  terminal.wallet AS terminalWallet,
  terminal.order_id AS terminalOrderId,
  terminal.side AS terminalSide,
  terminal.matched_amount_units AS terminalMatchedAmountUnits,
  CAST(terminal.gross_entitlement_lamports AS TEXT) AS terminalGrossLamports,
  CAST(terminal.payout_lamports AS TEXT) AS terminalPayoutLamports,
  CAST(terminal.fee_lamports AS TEXT) AS terminalFeeLamports,
  terminal.settled_at AS settledAt
FROM bets
JOIN bet_executions AS executions ON executions.bet_id = bets.id
JOIN bet_deployment_identities AS deployment
  ON deployment.bet_id = bets.id
 AND deployment.cluster = ?
 AND deployment.program_id = ?
LEFT JOIN bet_lifecycle_accounting AS lifecycle ON lifecycle.bet_id = bets.id
LEFT JOIN bet_terminal_settlements AS terminal
  ON terminal.bet_id = bets.id
 AND terminal.cluster = ?
 AND terminal.program_id = ?
LEFT JOIN ranked_market_state AS market
  ON market.marketPda = bets.market_pda AND market.stateRank = 1
WHERE bets.bettor_wallet = ?
  AND (? IS NULL OR bets.market_pda = ?)
ORDER BY bets.recorded_at DESC, bets.id DESC
LIMIT ? OFFSET ?`);

const countSolanaWalletBetHistoryStatement =
  db.prepare(`SELECT COUNT(*) AS total
FROM bets
JOIN bet_executions AS executions ON executions.bet_id = bets.id
JOIN bet_deployment_identities AS deployment
  ON deployment.bet_id = bets.id
 AND deployment.cluster = ?
 AND deployment.program_id = ?
WHERE bets.bettor_wallet = ?
  AND (? IS NULL OR bets.market_pda = ?)`);

const upsertWalletDisplay =
  db.prepare(`INSERT INTO wallet_display (normalized_wallet, display_name)
  VALUES ($normalized, $display)
  ON CONFLICT(normalized_wallet) DO UPDATE SET display_name = excluded.display_name`);

const upsertWalletPoints = db.prepare(`INSERT INTO wallet_points
  (wallet, self_points, win_points, referral_points)
  VALUES ($wallet, $selfPoints, $winPoints, $referralPoints)
  ON CONFLICT(wallet) DO UPDATE SET
    self_points = excluded.self_points,
    win_points = excluded.win_points,
    referral_points = excluded.referral_points`);

const insertPointsEvent = db.prepare(`INSERT INTO points_events
  (wallet, event_type, status, total_points, reference_type, reference_id, related_wallet, created_at)
  VALUES ($wallet, $eventType, $status, $totalPoints, $referenceType, $referenceId, $relatedWallet, $createdAt)`);

const upsertInviteCode = db.prepare(`INSERT INTO invite_codes (wallet, code)
  VALUES ($wallet, $code)
  ON CONFLICT(wallet) DO UPDATE SET code = excluded.code`);

const upsertReferral =
  db.prepare(`INSERT INTO referrals (wallet, referrer_wallet, invite_code)
  VALUES ($wallet, $referrerWallet, $inviteCode)
  ON CONFLICT(wallet) DO UPDATE SET
    referrer_wallet = excluded.referrer_wallet,
    invite_code = excluded.invite_code`);

const insertInvitedWallet =
  db.prepare(`INSERT OR IGNORE INTO invited_wallets (referrer, invitee)
  VALUES ($referrer, $invitee)`);

// ── Load (hydrate in-memory state from DB at startup) ─────────────────────────

export type HydratedState = {
  bets: DbBetRecord[];
  walletDisplay: Map<string, string>;
  pointsByWallet: Map<string, DbWalletPoints>;
  pointsEvents: DbPointsEventRecord[];
  inviteCodeByWallet: Map<string, string>;
  walletByInviteCode: Map<string, string>;
  referredByWallet: Map<string, { wallet: string; code: string }>;
  invitedWalletsByWallet: Map<string, Set<string>>;
};

export function loadAll(betLimit = 5000): HydratedState {
  const bets = (
    db
      .prepare(
        `SELECT bets.id, deployment.cluster, deployment.program_id,
          bettor_wallet, chain, source_asset,
          ${legacySourceAmountSelect} AS legacy_source_amount,
          CAST(source_amount_lamports AS TEXT) AS source_amount_lamports,
          CAST(fee_amount_lamports AS TEXT) AS fee_amount_lamports,
          fee_bps, tx_signature, market_pda, duel_key, duel_id, invite_code, external_bet_ref, recorded_at
         FROM bets
         JOIN bet_deployment_identities AS deployment
           ON deployment.bet_id = bets.id
         WHERE UPPER(chain) = 'SOLANA' AND UPPER(source_asset) = 'SOL'
         ORDER BY recorded_at DESC LIMIT ?`,
      )
      .all(betLimit) as Array<Record<string, unknown>>
  ).map((row): DbBetRecord => {
    const deployment = normalizeIndexerIdentity({
      cluster: String(row.cluster),
      programId: String(row.program_id),
    });
    return {
      id: String(row.id),
      ...deployment,
      bettorWallet: String(row.bettor_wallet),
      chain: String(row.chain) as DbBetRecord["chain"],
      sourceAsset: "SOL",
      sourceAmountLamports: (() => {
        const stored = normalizeLamports(row.source_amount_lamports);
        return stored && stored !== "0"
          ? stored
          : legacySolAmountToLamports(row.legacy_source_amount);
      })(),
      feeAmountLamports: normalizeLamports(row.fee_amount_lamports) ?? "0",
      feeBps: Number(row.fee_bps),
      txSignature: String(row.tx_signature),
      marketPda: row.market_pda != null ? String(row.market_pda) : null,
      duelKey: row.duel_key != null ? String(row.duel_key) : null,
      duelId: row.duel_id != null ? String(row.duel_id) : null,
      inviteCode: row.invite_code != null ? String(row.invite_code) : null,
      externalBetRef:
        row.external_bet_ref != null ? String(row.external_bet_ref) : null,
      recordedAt: Number(row.recorded_at),
    };
  });

  const walletDisplay = new Map<string, string>();
  for (const row of db
    .prepare("SELECT normalized_wallet, display_name FROM wallet_display")
    .all() as Array<Record<string, string>>) {
    walletDisplay.set(row.normalized_wallet, row.display_name);
  }

  const pointsByWallet = new Map<string, DbWalletPoints>();
  for (const row of db
    .prepare(
      "SELECT wallet, self_points, win_points, referral_points FROM wallet_points",
    )
    .all() as Array<Record<string, unknown>>) {
    pointsByWallet.set(String(row.wallet), {
      selfPoints: Number(row.self_points),
      winPoints: Number(row.win_points),
      referralPoints: Number(row.referral_points),
    });
  }

  const pointsEvents = (
    db
      .prepare(
        `SELECT id, wallet, event_type, status, total_points, reference_type, reference_id, related_wallet, created_at
         FROM points_events
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row): DbPointsEventRecord => ({
    id: Number(row.id),
    wallet: String(row.wallet),
    eventType: String(row.event_type),
    status: String(row.status),
    totalPoints: Number(row.total_points),
    referenceType:
      row.reference_type == null ? null : String(row.reference_type),
    referenceId: row.reference_id == null ? null : String(row.reference_id),
    relatedWallet:
      row.related_wallet == null ? null : String(row.related_wallet),
    createdAt: Number(row.created_at),
  }));

  const inviteCodeByWallet = new Map<string, string>();
  const walletByInviteCode = new Map<string, string>();
  for (const row of db
    .prepare("SELECT wallet, code FROM invite_codes")
    .all() as Array<Record<string, string>>) {
    inviteCodeByWallet.set(row.wallet, row.code);
    walletByInviteCode.set(row.code, row.wallet);
  }

  const referredByWallet = new Map<string, { wallet: string; code: string }>();
  for (const row of db
    .prepare("SELECT wallet, referrer_wallet, invite_code FROM referrals")
    .all() as Array<Record<string, string>>) {
    referredByWallet.set(row.wallet, {
      wallet: row.referrer_wallet,
      code: row.invite_code,
    });
  }

  const invitedWalletsByWallet = new Map<string, Set<string>>();
  for (const row of db
    .prepare("SELECT referrer, invitee FROM invited_wallets")
    .all() as Array<Record<string, string>>) {
    const set = invitedWalletsByWallet.get(row.referrer) ?? new Set<string>();
    set.add(row.invitee);
    invitedWalletsByWallet.set(row.referrer, set);
  }

  console.log(
    `[db] loaded ${bets.length} bets, ${walletDisplay.size} wallets, ${pointsByWallet.size} point records from ${DB_PATH}`,
  );

  return {
    bets,
    walletDisplay,
    pointsByWallet,
    pointsEvents,
    inviteCodeByWallet,
    walletByInviteCode,
    referredByWallet,
    invitedWalletsByWallet,
  };
}

// ── Save helpers (called after each mutation) ─────────────────────────────────

export function saveBet(
  bet: DbBetRecord,
  execution: DbBetExecutionRecord | null = null,
): boolean {
  if ((bet.duelKey === null) !== (bet.duelId === null)) {
    throw new Error("bet duel identity is incomplete");
  }
  const deployment = normalizeIndexerIdentity(bet);
  const sourceAmountLamports = normalizeLamports(bet.sourceAmountLamports);
  const feeAmountLamports = normalizeLamports(bet.feeAmountLamports);
  if (!sourceAmountLamports || sourceAmountLamports === "0") {
    throw new Error(
      "sourceAmountLamports must be a positive SQLite-safe integer",
    );
  }
  if (!feeAmountLamports) {
    throw new Error(
      "feeAmountLamports must be a non-negative SQLite-safe integer",
    );
  }
  let executionLamports: {
    collateral: string;
    executed: string;
    treasuryFee: string;
    marketMakerFee: string;
    rewardEligible: string;
  } | null = null;
  if (execution) {
    const collateral = normalizeLamports(execution.collateralLamports);
    const executed = normalizeLamports(execution.executedCostLamports);
    const treasuryFee = normalizeLamports(execution.tradeTreasuryFeeLamports);
    const marketMakerFee = normalizeLamports(
      execution.tradeMarketMakerFeeLamports,
    );
    const rewardEligible = normalizeLamports(execution.rewardEligibleLamports);
    if (
      collateral === null ||
      executed === null ||
      treasuryFee === null ||
      marketMakerFee === null ||
      rewardEligible === null
    ) {
      throw new Error(
        "bet execution contains an invalid SQLite lamport amount",
      );
    }
    executionLamports = {
      collateral,
      executed,
      treasuryFee,
      marketMakerFee,
      rewardEligible,
    };
  }
  const unitValues = execution
    ? [
        execution.orderId,
        execution.orderAmountUnits,
        execution.matchedAmountUnits,
        execution.restingAmountUnits,
        execution.releasedAmountUnits,
      ]
    : [];
  if (unitValues.some((value) => !/^\d+$/.test(value))) {
    throw new Error("bet execution contains an invalid unsigned integer");
  }
  if (execution && executionLamports) {
    const orderAmount = BigInt(execution.orderAmountUnits);
    const accountedAmount =
      BigInt(execution.matchedAmountUnits) +
      BigInt(execution.restingAmountUnits) +
      BigInt(execution.releasedAmountUnits);
    const feeTotal =
      BigInt(executionLamports.treasuryFee) +
      BigInt(executionLamports.marketMakerFee);
    if (
      orderAmount <= 0n ||
      accountedAmount !== orderAmount ||
      BigInt(executionLamports.executed) >
        BigInt(executionLamports.collateral) ||
      BigInt(sourceAmountLamports) !==
        BigInt(executionLamports.collateral) + feeTotal ||
      BigInt(feeAmountLamports) !== feeTotal ||
      BigInt(executionLamports.rewardEligible) !==
        BigInt(executionLamports.executed) + feeTotal
    ) {
      throw new Error("bet execution accounting invariant failed");
    }
  }

  const doSave = db.transaction(() => {
    const result = insertBet.run({
      $id: bet.id,
      $bettorWallet: bet.bettorWallet,
      $chain: bet.chain,
      $sourceAsset: bet.sourceAsset,
      $sourceAmountLamports: BigInt(sourceAmountLamports),
      $feeAmountLamports: BigInt(feeAmountLamports),
      $feeBps: bet.feeBps,
      $txSignature: bet.txSignature,
      $marketPda: bet.marketPda,
      $duelKey: bet.duelKey,
      $duelId: bet.duelId,
      $inviteCode: bet.inviteCode,
      $externalBetRef: bet.externalBetRef,
      $recordedAt: bet.recordedAt,
    }) as { changes?: number };
    const inserted = Number(result.changes ?? 0) > 0;
    if (inserted) {
      insertBetDeploymentIdentity.run({
        $betId: bet.id,
        $cluster: deployment.cluster,
        $programId: deployment.programId,
        $boundAt: bet.recordedAt,
      });
    }
    if (inserted && execution && executionLamports) {
      insertBetExecution.run({
        $betId: bet.id,
        $orderId: execution.orderId,
        $side: execution.side,
        $limitPrice: execution.limitPrice,
        $orderBehavior: execution.orderBehavior,
        $orderAmountUnits: execution.orderAmountUnits,
        $matchedAmountUnits: execution.matchedAmountUnits,
        $restingAmountUnits: execution.restingAmountUnits,
        $releasedAmountUnits: execution.releasedAmountUnits,
        $collateralLamports: BigInt(executionLamports.collateral),
        $executedCostLamports: BigInt(executionLamports.executed),
        $tradeTreasuryFeeLamports: BigInt(executionLamports.treasuryFee),
        $tradeMarketMakerFeeLamports: BigInt(executionLamports.marketMakerFee),
        $rewardEligibleLamports: BigInt(executionLamports.rewardEligible),
        $verifiedAt: execution.verifiedAt,
      });
    }
    return inserted;
  });
  return doSave();
}

export function saveWalletDisplay(normalized: string, display: string): void {
  upsertWalletDisplay.run({ $normalized: normalized, $display: display });
}

export function saveWalletPoints(wallet: string, points: DbWalletPoints): void {
  upsertWalletPoints.run({
    $wallet: wallet,
    $selfPoints: points.selfPoints,
    $winPoints: points.winPoints,
    $referralPoints: points.referralPoints,
  });
}

export function savePointsEvent(
  event: Omit<DbPointsEventRecord, "id">,
): number {
  const result = insertPointsEvent.run({
    $wallet: event.wallet,
    $eventType: event.eventType,
    $status: event.status,
    $totalPoints: event.totalPoints,
    $referenceType: event.referenceType,
    $referenceId: event.referenceId,
    $relatedWallet: event.relatedWallet,
    $createdAt: event.createdAt,
  }) as { lastInsertRowid?: number | bigint };

  return Number(result.lastInsertRowid ?? 0);
}

export function saveInviteCode(wallet: string, code: string): void {
  upsertInviteCode.run({ $wallet: wallet, $code: code });
}

export function saveReferral(
  wallet: string,
  referrerWallet: string,
  inviteCode: string,
): void {
  upsertReferral.run({
    $wallet: wallet,
    $referrerWallet: referrerWallet,
    $inviteCode: inviteCode,
  });
}

export function saveInvitedWallet(referrer: string, invitee: string): void {
  insertInvitedWallet.run({ $referrer: referrer, $invitee: invitee });
}

function normalizeIndexerIdentity(input: {
  cluster: string;
  programId: string;
}): { cluster: DbSolanaCluster; programId: string } {
  const cluster = input.cluster.trim().toLowerCase();
  if (
    cluster !== "localnet" &&
    cluster !== "devnet" &&
    cluster !== "testnet" &&
    cluster !== "mainnet-beta"
  ) {
    throw new Error("Solana indexer cluster is invalid");
  }
  let programId: string;
  try {
    programId = new PublicKey(input.programId).toBase58();
  } catch {
    throw new Error("Solana indexer program ID is invalid");
  }
  if (programId !== input.programId) {
    throw new Error("Solana indexer program ID is not canonical");
  }
  return { cluster, programId };
}

export function loadSolanaIndexerCheckpoint(input: {
  cluster: string;
  programId: string;
}): DbSolanaIndexerCheckpoint | null {
  const identity = normalizeIndexerIdentity(input);
  const row = loadSolanaIndexerCheckpointStatement.get(
    identity.cluster,
    identity.programId,
  ) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    cluster: String(row.cluster),
    programId: String(row.programId),
    startSlot: Number(row.startSlot),
    signature: String(row.signature),
    slot: Number(row.slot),
    updatedAt: Number(row.updatedAt),
  };
}

export function loadSolanaLifecycleFacts(input: {
  cluster: string;
  programId: string;
  marketPda?: string;
  kind?: SolanaLifecycleFact["kind"];
}): DbSolanaLifecycleFactRecord[] {
  const identity = normalizeIndexerIdentity(input);
  let marketPda: string | null = null;
  if (input.marketPda !== undefined) {
    try {
      marketPda = new PublicKey(input.marketPda).toBase58();
    } catch {
      throw new Error("Solana lifecycle fact market is invalid");
    }
    if (marketPda !== input.marketPda) {
      throw new Error("Solana lifecycle fact market is not canonical");
    }
  }
  const kind = input.kind ?? null;
  return (
    loadSolanaLifecycleFactsStatement.all(
      identity.cluster,
      identity.programId,
      marketPda,
      marketPda,
      kind,
      kind,
    ) as Array<Record<string, unknown>>
  ).map((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.payloadJson));
    } catch {
      throw new Error("persisted Solana lifecycle fact is invalid JSON");
    }
    return {
      signature: String(row.signature),
      slot: Number(row.slot),
      factIndex: Number(row.factIndex),
      fact: normalizeLifecycleFact(parsed as SolanaLifecycleFact),
    };
  });
}

export function loadSolanaIndexedTransactionEvidence(input: {
  cluster: string;
  programId: string;
  signature: string;
}): DbSolanaIndexedTransactionEvidence | null {
  const identity = normalizeIndexerIdentity(input);
  if (!isCanonicalSolanaTransactionSignature(input.signature)) {
    throw new Error("Solana indexed evidence signature is invalid");
  }
  const row = loadSolanaIndexedTransactionStatement.get(
    identity.cluster,
    identity.programId,
    input.signature,
  ) as Record<string, unknown> | null;
  if (!row) return null;

  let instructionNames: unknown;
  try {
    instructionNames = JSON.parse(String(row.instructionNamesJson));
  } catch {
    throw new Error("persisted Solana instruction names are invalid JSON");
  }
  if (
    !Array.isArray(instructionNames) ||
    instructionNames.some(
      (name) => typeof name !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(name),
    ) ||
    new Set(instructionNames).size !== instructionNames.length
  ) {
    throw new Error("persisted Solana instruction names are invalid");
  }

  const factRows = loadSolanaLifecycleFactsForTransactionStatement.all(
    identity.cluster,
    identity.programId,
    input.signature,
  ) as Array<Record<string, unknown>>;
  const facts = factRows.map((factRow, index) => {
    if (Number(factRow.factIndex) !== index) {
      throw new Error("persisted Solana lifecycle fact order is incomplete");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(factRow.payloadJson));
    } catch {
      throw new Error("persisted Solana lifecycle fact is invalid JSON");
    }
    return normalizeLifecycleFact(parsed as SolanaLifecycleFact);
  });
  const factsDigest = digestLifecycleFacts(facts);
  if (
    String(row.factsDigest) !== factsDigest ||
    !/^[0-9a-f]{64}$/.test(String(row.transactionDigest)) ||
    (Number(row.succeeded) !== 0 && Number(row.succeeded) !== 1) ||
    (!Boolean(row.succeeded) && facts.length > 0)
  ) {
    throw new Error(
      "persisted Solana indexed evidence failed integrity checks",
    );
  }

  const slot = Number(row.slot);
  const blockTime = row.blockTime == null ? null : Number(row.blockTime);
  const indexedAt = Number(row.indexedAt);
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    (blockTime !== null &&
      (!Number.isSafeInteger(blockTime) || blockTime < 0)) ||
    !Number.isSafeInteger(indexedAt) ||
    indexedAt < 0
  ) {
    throw new Error("persisted Solana indexed evidence has invalid timing");
  }

  return {
    cluster: identity.cluster,
    programId: identity.programId,
    signature: input.signature,
    slot,
    blockTime,
    succeeded: Boolean(row.succeeded),
    instructionNames: instructionNames as string[],
    transactionDigest: String(row.transactionDigest),
    facts,
    indexedAt,
  };
}

export function loadSolanaIndexedOrderPlacement(input: {
  cluster: string;
  programId: string;
  marketPda: string;
  orderId: string;
}): SolanaLifecycleFact | null {
  if (!/^\d+$/.test(input.orderId)) {
    throw new Error("Solana indexed order ID is invalid");
  }
  const matches = loadSolanaLifecycleFacts({
    cluster: input.cluster,
    programId: input.programId,
    marketPda: input.marketPda,
    kind: "ORDER_PLACED",
  }).filter(
    (record) => record.fact.orderId === BigInt(input.orderId).toString(),
  );
  if (matches.length > 1) {
    throw new Error("Solana indexed order placement is contradictory");
  }
  return matches[0]?.fact ?? null;
}

function betExecutionBaselineFromRow(
  row: Record<string, unknown>,
): BetExecutionBaseline {
  return {
    betId: String(row.betId),
    txSignature: String(row.txSignature),
    marketPda: String(row.marketPda),
    wallet: String(row.wallet),
    orderId: String(row.orderId),
    side: Number(row.side) as 1 | 2,
    limitPrice: Number(row.limitPrice),
    orderAmountUnits: String(row.orderAmountUnits),
    initialMatchedAmountUnits: String(row.initialMatchedAmountUnits),
    initialRestingAmountUnits: String(row.initialRestingAmountUnits),
    initialReleasedAmountUnits: String(row.initialReleasedAmountUnits),
    initialCollateralLamports: String(row.initialCollateralLamports),
    initialExecutedCostLamports: String(row.initialExecutedCostLamports),
    initialTradeFeeLamports: String(row.initialTradeFeeLamports),
    initialRewardEligibleLamports: String(row.initialRewardEligibleLamports),
  };
}

function betTerminalSettlementFromRow(
  row: Record<string, unknown>,
): DbBetTerminalSettlementRecord {
  return {
    betId: String(row.betId),
    marketPda: String(row.marketPda),
    wallet: String(row.wallet),
    orderId: String(row.orderId),
    side: Number(row.side) as 1 | 2,
    claimSignature: String(row.claimSignature),
    kind: String(row.kind) as SolanaTerminalSettlementKind,
    status: String(row.status) as "resolved" | "cancelled",
    winner: String(row.winner) as "none" | "a" | "b",
    matchedAmountUnits: String(row.matchedAmountUnits),
    grossEntitlementLamports: String(row.grossEntitlementLamports),
    payoutLamports: String(row.payoutLamports),
    feeLamports: String(row.feeLamports),
    settledAt: Number(row.settledAt),
  };
}

export function loadSolanaBetTerminalSettlement(
  betId: string,
): DbBetTerminalSettlementRecord | null {
  if (!betId.trim() || betId !== betId.trim()) {
    throw new Error("Solana terminal settlement bet ID is invalid");
  }
  const row = loadBetTerminalSettlementStatement.get(betId) as Record<
    string,
    unknown
  > | null;
  return row ? betTerminalSettlementFromRow(row) : null;
}

function canonicalPublicKey(value: string, label: string): string {
  if (!value.trim() || value !== value.trim()) {
    throw new Error(`${label} is invalid`);
  }
  let canonical: string;
  try {
    canonical = new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (canonical !== value) {
    throw new Error(`${label} is not canonical`);
  }
  return canonical;
}

const U64_MAX = 18_446_744_073_709_551_615n;

function unsignedHistoryValue(value: unknown, label: string): bigint {
  const normalized = String(value);
  if (
    !/^(0|[1-9]\d*)$/.test(normalized) ||
    normalized.length > 20 ||
    BigInt(normalized) > U64_MAX
  ) {
    throw new Error(`persisted ${label} is invalid`);
  }
  return BigInt(normalized);
}

function marketStateFromHistoryRow(row: Record<string, unknown>): {
  status: "open" | "locked" | "resolved" | "cancelled" | null;
  winner: "none" | "a" | "b" | null;
} {
  if (row.marketStatePayloadJson === null) {
    return { status: null, winner: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.marketStatePayloadJson));
  } catch {
    throw new Error("persisted market lifecycle state is invalid JSON");
  }
  const fact = normalizeLifecycleFact(parsed as SolanaLifecycleFact);
  if (fact.kind !== "MARKET_SYNCED" || fact.marketPda !== row.marketPda) {
    throw new Error("persisted market lifecycle state is contradictory");
  }
  return {
    status: fact.status ?? null,
    winner: fact.winner ?? null,
  };
}

function orderStateForHistory(input: {
  indexed: boolean;
  marketStatus: "open" | "locked" | "resolved" | "cancelled" | null;
  orderAmount: bigint;
  matched: bigint;
  resting: bigint;
  released: bigint;
}): DbSolanaBetOrderState {
  if (!input.indexed) return "PENDING_INDEX";
  if (
    input.resting > 0n &&
    input.marketStatus !== null &&
    input.marketStatus !== "open"
  ) {
    return "RECLAIM_REQUIRED";
  }
  if (input.resting > 0n) {
    return input.matched > 0n ? "PARTIALLY_FILLED" : "OPEN";
  }
  if (input.matched === input.orderAmount) return "FILLED";
  if (input.matched > 0n) return "CLOSED_PARTIAL";
  if (input.released === input.orderAmount) return "RELEASED";
  throw new Error("persisted Solana order state is not classifiable");
}

function settlementStateForHistory(input: {
  terminalKind: unknown;
  terminalStatus: unknown;
  terminalWinner: unknown;
  terminalMarketPda: unknown;
  terminalWallet: unknown;
  terminalOrderId: unknown;
  terminalSide: unknown;
  terminalMatchedAmountUnits: unknown;
  claimSignature: unknown;
  settledAt: unknown;
  terminalGross: bigint;
  terminalPayout: bigint;
  terminalFee: bigint;
  marketStatus: "open" | "locked" | "resolved" | "cancelled" | null;
  winner: "none" | "a" | "b" | null;
  marketPda: string;
  wallet: string;
  orderId: string;
  side: 1 | 2;
  matched: bigint;
  executedCost: bigint;
  rewardEligible: bigint;
}): DbSolanaBetSettlementState {
  if (
    input.terminalKind !== null &&
    input.terminalKind !== "CLAIM_PAYOUT" &&
    input.terminalKind !== "CANCELLATION_REFUND" &&
    input.terminalKind !== "LOSER_CLEANUP"
  ) {
    throw new Error("persisted Solana terminal settlement kind is invalid");
  }
  if (input.terminalKind !== null) {
    const terminalMatched = unsignedHistoryValue(
      input.terminalMatchedAmountUnits,
      "terminal matched amount",
    );
    if (
      (input.terminalStatus !== "resolved" &&
        input.terminalStatus !== "cancelled") ||
      (input.terminalWinner !== "none" &&
        input.terminalWinner !== "a" &&
        input.terminalWinner !== "b") ||
      input.terminalMarketPda !== input.marketPda ||
      input.terminalWallet !== input.wallet ||
      String(input.terminalOrderId) !== input.orderId ||
      Number(input.terminalSide) !== input.side ||
      terminalMatched !== input.matched ||
      typeof input.claimSignature !== "string" ||
      !isCanonicalSolanaTransactionSignature(input.claimSignature) ||
      !Number.isSafeInteger(input.settledAt) ||
      Number(input.settledAt) < 0 ||
      input.terminalGross !== input.terminalPayout + input.terminalFee ||
      (input.marketStatus !== null &&
        (input.marketStatus !== input.terminalStatus ||
          input.winner !== input.terminalWinner))
    ) {
      throw new Error("persisted Solana terminal settlement is contradictory");
    }
    if (input.terminalKind === "CLAIM_PAYOUT") {
      const won =
        (input.terminalWinner === "a" && input.side === 1) ||
        (input.terminalWinner === "b" && input.side === 2);
      const expectedGross = won ? input.matched : 0n;
      if (
        input.terminalStatus !== "resolved" ||
        (input.terminalWinner !== "a" && input.terminalWinner !== "b") ||
        input.terminalGross !== expectedGross
      ) {
        throw new Error("persisted Solana payout settlement is contradictory");
      }
      return input.terminalGross > 0n ? "PAID" : "LOST";
    }
    if (input.terminalKind === "LOSER_CLEANUP") {
      const lost =
        (input.terminalWinner === "a" && input.side === 2) ||
        (input.terminalWinner === "b" && input.side === 1);
      if (
        input.terminalStatus !== "resolved" ||
        (input.terminalWinner !== "a" && input.terminalWinner !== "b") ||
        !lost ||
        input.matched <= 0n ||
        input.terminalGross !== 0n ||
        input.terminalPayout !== 0n ||
        input.terminalFee !== 0n
      ) {
        throw new Error(
          "persisted Solana loser cleanup settlement is contradictory",
        );
      }
      return "LOST";
    }
    if (
      input.terminalStatus !== "cancelled" ||
      input.terminalWinner !== "none" ||
      input.terminalGross !== input.rewardEligible
    ) {
      throw new Error("persisted Solana refund settlement is contradictory");
    }
    return "REFUNDED";
  }
  if (
    input.terminalStatus !== null ||
    input.terminalWinner !== null ||
    input.terminalMarketPda !== null ||
    input.terminalWallet !== null ||
    input.terminalOrderId !== null ||
    input.terminalSide !== null ||
    input.terminalMatchedAmountUnits !== null ||
    input.claimSignature !== null ||
    input.settledAt !== null ||
    input.terminalGross !== 0n ||
    input.terminalPayout !== 0n ||
    input.terminalFee !== 0n
  ) {
    throw new Error("persisted Solana terminal settlement is incomplete");
  }
  if (input.marketStatus === "resolved") {
    if (input.matched === 0n) return "NO_ENTITLEMENT";
    const won =
      (input.winner === "a" && input.side === 1) ||
      (input.winner === "b" && input.side === 2);
    return won ? "PAYOUT_CLAIMABLE" : "LOST";
  }
  if (input.marketStatus === "cancelled") {
    return input.executedCost > 0n ? "REFUND_CLAIMABLE" : "NO_ENTITLEMENT";
  }
  if (input.marketStatus === "locked" && input.matched > 0n) {
    return "AWAITING_RESULT";
  }
  return "NOT_READY";
}

export function loadSolanaWalletBetHistory(input: {
  cluster: string;
  programId: string;
  wallet: string;
  marketPda?: string | null;
  limit: number;
  offset: number;
}): DbSolanaWalletBetHistory {
  const { cluster, programId } = normalizeIndexerIdentity(input);
  const wallet = canonicalPublicKey(input.wallet, "Solana history wallet");
  const marketPda = input.marketPda
    ? canonicalPublicKey(input.marketPda, "Solana history market")
    : null;
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > 10_000
  ) {
    throw new Error("Solana history pagination is invalid");
  }
  const rows = loadSolanaWalletBetHistoryStatement.all(
    cluster,
    programId,
    cluster,
    programId,
    cluster,
    programId,
    wallet,
    marketPda,
    marketPda,
    input.limit,
    input.offset,
  ) as Array<Record<string, unknown>>;
  const entries = rows.map((row): DbSolanaWalletBetHistoryEntry => {
    const rowWallet = canonicalPublicKey(
      String(row.wallet),
      "persisted Solana history wallet",
    );
    const rowMarketPda = canonicalPublicKey(
      String(row.marketPda),
      "persisted Solana history market",
    );
    const orderId = unsignedHistoryValue(row.orderId, "order ID").toString();
    const placeSignature = String(row.placeSignature);
    if (!isCanonicalSolanaTransactionSignature(placeSignature)) {
      throw new Error(
        "persisted Solana history placement signature is invalid",
      );
    }
    const side = Number(row.side) as 1 | 2;
    const limitPrice = Number(row.limitPrice);
    const orderAmount = unsignedHistoryValue(
      row.orderAmountUnits,
      "order amount",
    );
    const matched = unsignedHistoryValue(
      row.matchedAmountUnits,
      "matched amount",
    );
    const resting = unsignedHistoryValue(
      row.restingAmountUnits,
      "resting amount",
    );
    const released = unsignedHistoryValue(
      row.releasedAmountUnits,
      "released amount",
    );
    const initialCollateral = unsignedHistoryValue(
      row.initialCollateralLamports,
      "initial collateral",
    );
    const sourceAmountLamports = unsignedHistoryValue(
      row.sourceAmountLamports,
      "source amount",
    );
    const executedCost = unsignedHistoryValue(
      row.executedCostLamports,
      "executed cost",
    );
    const tradeFee = unsignedHistoryValue(row.tradeFeeLamports, "trade fee");
    const rewardEligible = unsignedHistoryValue(
      row.rewardEligibleLamports,
      "reward eligibility",
    );
    if (
      (side !== 1 && side !== 2) ||
      !Number.isInteger(limitPrice) ||
      limitPrice <= 0 ||
      limitPrice >= 1_000 ||
      orderAmount <= 0n ||
      matched + resting + released !== orderAmount ||
      sourceAmountLamports !== initialCollateral + tradeFee ||
      rewardEligible !== executedCost + tradeFee
    ) {
      throw new Error("persisted Solana bet history accounting is invalid");
    }
    const signedLimitCost = quoteCostLamports(side, limitPrice, orderAmount);
    if (signedLimitCost === null || initialCollateral > signedLimitCost) {
      throw new Error("persisted Solana bet collateral is invalid");
    }
    const orderRefund =
      row.reconciledOrderRefundLamports === null
        ? signedLimitCost - initialCollateral
        : unsignedHistoryValue(
            row.reconciledOrderRefundLamports,
            "order refund",
          );
    const terminalGross =
      row.terminalGrossLamports === null
        ? 0n
        : unsignedHistoryValue(row.terminalGrossLamports, "terminal gross");
    const terminalPayout =
      row.terminalPayoutLamports === null
        ? 0n
        : unsignedHistoryValue(row.terminalPayoutLamports, "terminal payout");
    const terminalFee =
      row.terminalFeeLamports === null
        ? 0n
        : unsignedHistoryValue(row.terminalFeeLamports, "terminal fee");
    if (terminalGross !== terminalPayout + terminalFee) {
      throw new Error("persisted Solana terminal history does not conserve");
    }
    const market = marketStateFromHistoryRow(row);
    const indexed = row.reconciledAt !== null;
    const recordedAt = Number(row.recordedAt);
    const reconciledAt = indexed ? Number(row.reconciledAt) : null;
    const settledAt = row.settledAt === null ? null : Number(row.settledAt);
    if (
      !Number.isSafeInteger(recordedAt) ||
      recordedAt < 0 ||
      (reconciledAt !== null &&
        (!Number.isSafeInteger(reconciledAt) || reconciledAt < 0)) ||
      (settledAt !== null &&
        (!Number.isSafeInteger(settledAt) || settledAt < 0)) ||
      (reconciledAt !== null && reconciledAt < recordedAt) ||
      (settledAt !== null &&
        (settledAt < recordedAt ||
          (reconciledAt !== null && settledAt > reconciledAt)))
    ) {
      throw new Error("persisted Solana history timestamp is invalid");
    }
    const duelKey = row.duelKey === null ? null : String(row.duelKey);
    const duelId = row.duelId === null ? null : String(row.duelId);
    if ((duelKey === null) !== (duelId === null)) {
      throw new Error("persisted Solana bet duel identity is incomplete");
    }
    const correlationId =
      duelKey === null || duelId === null
        ? null
        : buildDuelCorrelationId({ duelId, duelKey });
    const settlementState = settlementStateForHistory({
      terminalKind: row.terminalKind,
      terminalStatus: row.terminalStatus,
      terminalWinner: row.terminalWinner,
      terminalMarketPda: row.terminalMarketPda,
      terminalWallet: row.terminalWallet,
      terminalOrderId: row.terminalOrderId,
      terminalSide: row.terminalSide,
      terminalMatchedAmountUnits: row.terminalMatchedAmountUnits,
      claimSignature: row.claimSignature,
      settledAt,
      terminalGross,
      terminalPayout,
      terminalFee,
      marketStatus: market.status,
      winner: market.winner,
      marketPda: rowMarketPda,
      wallet: rowWallet,
      orderId,
      side,
      matched,
      executedCost,
      rewardEligible,
    });
    return {
      betId: String(row.betId),
      wallet: rowWallet,
      marketPda: rowMarketPda,
      duelKey,
      duelId,
      correlationId,
      placeSignature,
      recordedAt,
      orderId,
      side,
      limitPrice,
      orderAmountUnits: orderAmount.toString(),
      matchedAmountUnits: matched.toString(),
      restingAmountUnits: resting.toString(),
      releasedAmountUnits: released.toString(),
      sourceAmountLamports: sourceAmountLamports.toString(),
      collateralLamports: initialCollateral.toString(),
      executedCostLamports: executedCost.toString(),
      tradeFeeLamports: tradeFee.toString(),
      orderRefundLamports: orderRefund.toString(),
      rewardEligibleLamports: rewardEligible.toString(),
      marketStatus: market.status,
      winner: market.winner,
      orderState: orderStateForHistory({
        indexed,
        marketStatus: market.status,
        orderAmount,
        matched,
        resting,
        released,
      }),
      settlementState,
      terminalKind:
        row.terminalKind === null
          ? null
          : (row.terminalKind as SolanaTerminalSettlementKind),
      terminalStatus:
        row.terminalStatus === null
          ? null
          : (row.terminalStatus as "resolved" | "cancelled"),
      terminalWinner:
        row.terminalWinner === null
          ? null
          : (row.terminalWinner as "none" | "a" | "b"),
      claimSignature:
        row.claimSignature === null ? null : String(row.claimSignature),
      terminalGrossLamports: terminalGross.toString(),
      terminalPayoutLamports: terminalPayout.toString(),
      terminalFeeLamports: terminalFee.toString(),
      reconciledAt,
      settledAt,
    };
  });
  const count = countSolanaWalletBetHistoryStatement.get(
    cluster,
    programId,
    wallet,
    marketPda,
    marketPda,
  ) as { total?: number } | null;
  return {
    wallet,
    entries,
    total: Number(count?.total ?? 0),
    limit: input.limit,
    offset: input.offset,
  };
}

export function reconcileSolanaBetLifecycleAccounting(input: {
  cluster: string;
  programId: string;
  throughSlot: number;
  throughSignature: string;
  reconciledAt: number;
}): {
  reconciledBets: number;
  pendingBets: number;
  oldestPendingBetRecordedAt: number | null;
  terminalSettlements: number;
  settledBets: number;
  changes: DbBetLifecycleReconciliationChange[];
} {
  const identity = normalizeIndexerIdentity(input);
  if (
    !Number.isSafeInteger(input.throughSlot) ||
    input.throughSlot < 0 ||
    typeof input.throughSignature !== "string" ||
    !input.throughSignature.trim() ||
    input.throughSignature !== input.throughSignature.trim() ||
    !Number.isSafeInteger(input.reconciledAt) ||
    input.reconciledAt < 0
  ) {
    throw new Error("Solana bet reconciliation slot/time is invalid");
  }
  const allFacts = loadSolanaLifecycleFacts(identity);
  const factsByMarket = new Map<string, IndexedLifecycleFact[]>();
  for (const record of allFacts) {
    const facts = factsByMarket.get(record.fact.marketPda) ?? [];
    facts.push({
      signature: record.signature,
      factIndex: record.factIndex,
      fact: record.fact,
    });
    factsByMarket.set(record.fact.marketPda, facts);
  }
  const allBaselineRows = loadBetExecutionBaselinesStatement.all(
    identity.cluster,
    identity.programId,
  ) as Array<Record<string, unknown>>;
  const baselines = allBaselineRows.filter((row) => {
    if (row.lifecycleThroughSlot === null) return true;
    const throughSlot = Number(row.lifecycleThroughSlot);
    return (
      throughSlot < input.throughSlot ||
      (throughSlot === input.throughSlot &&
        String(row.lifecycleThroughSignature) !== input.throughSignature)
    );
  });
  const recordedBetBaselines = allBaselineRows.map(betExecutionBaselineFromRow);

  const reconcile = db.transaction(() => {
    const changes: DbBetLifecycleReconciliationChange[] = [];
    let reconciledBets = 0;
    let pendingBets = 0;
    let oldestPendingBetRecordedAt: number | null = null;
    for (const row of baselines) {
      const baseline = betExecutionBaselineFromRow(row);
      const marketFacts = factsByMarket.get(baseline.marketPda) ?? [];
      const hasPlacement = marketFacts.some(
        ({ fact }) =>
          fact.kind === "ORDER_PLACED" && fact.orderId === baseline.orderId,
      );
      if (!hasPlacement) {
        const indexedTransaction = loadSolanaIndexedTransactionStatement.get(
          identity.cluster,
          identity.programId,
          baseline.txSignature,
        );
        if (indexedTransaction) {
          throw new Error(
            `indexed recorded bet ${baseline.betId} has no order placement fact`,
          );
        }
        const recordedAt = Number(row.recordedAt);
        if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) {
          throw new Error("pending recorded bet timestamp is invalid");
        }
        pendingBets += 1;
        oldestPendingBetRecordedAt =
          oldestPendingBetRecordedAt === null
            ? recordedAt
            : Math.min(oldestPendingBetRecordedAt, recordedAt);
        continue;
      }
      const result = reconcileBetExecutionFromIndexedFacts({
        baseline,
        facts: marketFacts,
      });
      const existing = loadBetLifecycleAccountingStatement.get(
        baseline.betId,
      ) as Record<string, unknown> | null;
      if (existing && Number(existing.throughSlot) > input.throughSlot) {
        throw new Error("Solana bet reconciliation would regress its slot");
      }
      const referenceId = String(row.referenceId);
      const initialSelfPoints = Number(
        (
          sumPointsEventStatement.get(
            baseline.wallet,
            "BET_PLACED",
            referenceId,
            null,
            null,
          ) as { total?: number } | null
        )?.total ?? 0,
      );
      const referrerRow = loadReferrerStatement.get(baseline.wallet) as {
        referrerWallet?: string;
      } | null;
      const referrerWallet = referrerRow?.referrerWallet ?? null;
      const initialReferralPoints = referrerWallet
        ? Number(
            (
              sumPointsEventStatement.get(
                referrerWallet,
                "REFERRAL_WIN",
                referenceId,
                baseline.wallet,
                baseline.wallet,
              ) as { total?: number } | null
            )?.total ?? 0,
          )
        : 0;
      const expectedInitialReferralPoints = referrerWallet
        ? referralPointsForBetPoints(result.initialRewardPoints)
        : 0;
      if (
        (initialSelfPoints !== 0 &&
          initialSelfPoints !== result.initialRewardPoints) ||
        (initialReferralPoints !== 0 &&
          initialReferralPoints !== expectedInitialReferralPoints)
      ) {
        throw new Error("initial Solana reward events contradict accounting");
      }
      const appliedSelfPoints = existing
        ? Number(existing.rewardPointsApplied)
        : initialSelfPoints;
      const appliedReferralPoints = existing
        ? Number(existing.referralPointsApplied)
        : initialReferralPoints;
      const persistedReferrer = existing?.referrerWallet
        ? String(existing.referrerWallet)
        : null;
      if (
        !Number.isSafeInteger(appliedSelfPoints) ||
        appliedSelfPoints < 0 ||
        !Number.isSafeInteger(appliedReferralPoints) ||
        appliedReferralPoints < 0 ||
        (existing && persistedReferrer !== referrerWallet)
      ) {
        throw new Error("persisted Solana reward reconciliation is invalid");
      }
      const targetSelfPoints = result.rewardPointsTotal;
      const targetReferralPoints = referrerWallet
        ? referralPointsForBetPoints(targetSelfPoints)
        : 0;
      if (
        appliedSelfPoints > targetSelfPoints ||
        appliedReferralPoints > targetReferralPoints
      ) {
        throw new Error("indexed Solana rewards would regress applied points");
      }
      const selfPointsDelta = targetSelfPoints - appliedSelfPoints;
      const referralPointsDelta = targetReferralPoints - appliedReferralPoints;
      const events: DbPointsEventRecord[] = [];
      if (selfPointsDelta > 0) {
        addSelfPointsStatement.run(baseline.wallet, selfPointsDelta);
        const insert = insertPointsEvent.run({
          $wallet: baseline.wallet,
          $eventType: "BET_FILL",
          $status: "CONFIRMED",
          $totalPoints: selfPointsDelta,
          $referenceType: "BET",
          $referenceId: referenceId,
          $relatedWallet: null,
          $createdAt: input.reconciledAt,
        }) as { lastInsertRowid?: number | bigint };
        events.push({
          id: Number(insert.lastInsertRowid ?? 0),
          wallet: baseline.wallet,
          eventType: "BET_FILL",
          status: "CONFIRMED",
          totalPoints: selfPointsDelta,
          referenceType: "BET",
          referenceId,
          relatedWallet: null,
          createdAt: input.reconciledAt,
        });
      }
      if (referrerWallet && referralPointsDelta > 0) {
        addReferralPointsStatement.run(referrerWallet, referralPointsDelta);
        const insert = insertPointsEvent.run({
          $wallet: referrerWallet,
          $eventType: "REFERRAL_FILL",
          $status: "CONFIRMED",
          $totalPoints: referralPointsDelta,
          $referenceType: "BET",
          $referenceId: referenceId,
          $relatedWallet: baseline.wallet,
          $createdAt: input.reconciledAt,
        }) as { lastInsertRowid?: number | bigint };
        events.push({
          id: Number(insert.lastInsertRowid ?? 0),
          wallet: referrerWallet,
          eventType: "REFERRAL_FILL",
          status: "CONFIRMED",
          totalPoints: referralPointsDelta,
          referenceType: "BET",
          referenceId,
          relatedWallet: baseline.wallet,
          createdAt: input.reconciledAt,
        });
      }

      const lamportValues = [
        result.executedCostLamports,
        result.tradeFeeLamports,
        result.refundLamports,
        result.rewardEligibleLamports,
      ].map(normalizeLamports);
      if (lamportValues.some((value) => value === null)) {
        throw new Error("reconciled Solana lamports exceed SQLite bounds");
      }
      upsertBetLifecycleAccountingStatement.run(
        baseline.betId,
        result.matchedAmountUnits,
        result.restingAmountUnits,
        result.releasedAmountUnits,
        BigInt(lamportValues[0]!),
        BigInt(lamportValues[1]!),
        BigInt(lamportValues[2]!),
        BigInt(lamportValues[3]!),
        targetSelfPoints,
        targetSelfPoints,
        referrerWallet,
        targetReferralPoints,
        input.throughSlot,
        input.throughSignature,
        input.reconciledAt,
      );
      reconciledBets += 1;
      if (selfPointsDelta > 0 || referralPointsDelta > 0) {
        changes.push({
          betId: baseline.betId,
          wallet: baseline.wallet,
          selfPointsDelta,
          referrerWallet,
          referralPointsDelta,
          events,
        });
      }
    }

    let terminalSettlements = 0;
    let settledBets = 0;
    const terminalResults = reconcileWalletMarketTerminalSettlements({
      facts: allFacts.map((record) => ({
        signature: record.signature,
        factIndex: record.factIndex,
        fact: record.fact,
      })),
      recordedBets: recordedBetBaselines,
    });
    for (const settlement of terminalResults) {
      const aggregateLamports = [
        settlement.grossEntitlementLamports,
        settlement.payoutLamports,
        settlement.feeLamports,
      ].map(normalizeLamports);
      if (aggregateLamports.some((value) => value === null)) {
        throw new Error("terminal Solana settlement exceeds SQLite bounds");
      }
      const existing = loadSolanaTerminalSettlementStatement.get(
        identity.cluster,
        identity.programId,
        settlement.marketPda,
        settlement.wallet,
      ) as Record<string, unknown> | null;
      if (existing) {
        if (
          String(existing.claimSignature) !== settlement.claimSignature ||
          String(existing.kind) !== settlement.kind ||
          String(existing.status) !== settlement.status ||
          String(existing.winner) !== settlement.winner ||
          String(existing.grossEntitlementLamports) !==
            settlement.grossEntitlementLamports ||
          String(existing.payoutLamports) !== settlement.payoutLamports ||
          String(existing.feeLamports) !== settlement.feeLamports ||
          Number(existing.eligibleOrderCount) !==
            settlement.eligibleOrderCount ||
          Number(existing.recordedBetCount) > settlement.recordedBetCount
        ) {
          throw new Error("persisted Solana terminal settlement drifted");
        }
        if (Number(existing.recordedBetCount) < settlement.recordedBetCount) {
          updateSolanaTerminalRecordedBetCountStatement.run(
            settlement.recordedBetCount,
            input.reconciledAt,
            identity.cluster,
            identity.programId,
            settlement.marketPda,
            settlement.wallet,
          );
        }
      } else {
        insertSolanaTerminalSettlementStatement.run(
          identity.cluster,
          identity.programId,
          settlement.marketPda,
          settlement.wallet,
          settlement.claimSignature,
          settlement.kind,
          settlement.status,
          settlement.winner,
          BigInt(aggregateLamports[0]!),
          BigInt(aggregateLamports[1]!),
          BigInt(aggregateLamports[2]!),
          settlement.eligibleOrderCount,
          settlement.recordedBetCount,
          input.reconciledAt,
        );
        terminalSettlements += 1;
      }

      for (const allocation of settlement.allocations) {
        const allocationLamports = [
          allocation.grossEntitlementLamports,
          allocation.payoutLamports,
          allocation.feeLamports,
        ].map(normalizeLamports);
        if (allocationLamports.some((value) => value === null)) {
          throw new Error(
            "per-bet Solana terminal settlement exceeds SQLite bounds",
          );
        }
        const desired: DbBetTerminalSettlementRecord = {
          betId: allocation.betId,
          marketPda: settlement.marketPda,
          wallet: settlement.wallet,
          orderId: allocation.orderId,
          side: allocation.side,
          claimSignature: settlement.claimSignature,
          kind: settlement.kind,
          status: settlement.status,
          winner: settlement.winner,
          matchedAmountUnits: allocation.matchedAmountUnits,
          grossEntitlementLamports: allocation.grossEntitlementLamports,
          payoutLamports: allocation.payoutLamports,
          feeLamports: allocation.feeLamports,
          settledAt: input.reconciledAt,
        };
        const existingAllocation = loadBetTerminalSettlementStatement.get(
          allocation.betId,
        ) as Record<string, unknown> | null;
        if (existingAllocation) {
          const persisted = betTerminalSettlementFromRow(existingAllocation);
          const immutableFieldsMatch =
            persisted.betId === desired.betId &&
            persisted.marketPda === desired.marketPda &&
            persisted.wallet === desired.wallet &&
            persisted.orderId === desired.orderId &&
            persisted.side === desired.side &&
            persisted.claimSignature === desired.claimSignature &&
            persisted.kind === desired.kind &&
            persisted.status === desired.status &&
            persisted.winner === desired.winner &&
            persisted.matchedAmountUnits === desired.matchedAmountUnits &&
            persisted.grossEntitlementLamports ===
              desired.grossEntitlementLamports &&
            persisted.payoutLamports === desired.payoutLamports &&
            persisted.feeLamports === desired.feeLamports;
          if (!immutableFieldsMatch) {
            throw new Error("persisted per-bet terminal settlement drifted");
          }
          continue;
        }
        insertBetTerminalSettlementStatement.run(
          desired.betId,
          identity.cluster,
          identity.programId,
          desired.marketPda,
          desired.wallet,
          desired.orderId,
          desired.side,
          desired.claimSignature,
          desired.kind,
          desired.status,
          desired.winner,
          desired.matchedAmountUnits,
          BigInt(allocationLamports[0]!),
          BigInt(allocationLamports[1]!),
          BigInt(allocationLamports[2]!),
          desired.settledAt,
        );
        settledBets += 1;
      }
    }
    return {
      reconciledBets,
      pendingBets,
      oldestPendingBetRecordedAt,
      terminalSettlements,
      settledBets,
      changes,
    };
  });

  return reconcile();
}

export function commitSolanaIndexedTransaction(
  input: DbSolanaIndexedTransaction,
): boolean {
  const identity = normalizeIndexerIdentity(input);
  if (
    !Number.isSafeInteger(input.startSlot) ||
    input.startSlot < 0 ||
    !Number.isSafeInteger(input.slot) ||
    input.slot < input.startSlot ||
    (input.blockTime !== null &&
      (!Number.isSafeInteger(input.blockTime) || input.blockTime < 0)) ||
    !Number.isSafeInteger(input.indexedAt) ||
    input.indexedAt < 0
  ) {
    throw new Error(
      "Solana indexed transaction contains invalid time/slot data",
    );
  }
  if (!isCanonicalSolanaTransactionSignature(input.signature)) {
    throw new Error("Solana indexed transaction signature is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.transactionDigest)) {
    throw new Error("Solana indexed transaction digest is invalid");
  }
  if (
    !Array.isArray(input.instructionNames) ||
    input.instructionNames.some(
      (name) => typeof name !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(name),
    )
  ) {
    throw new Error("Solana indexed transaction instruction names are invalid");
  }
  const facts = input.facts.map(normalizeLifecycleFact);
  if (!input.succeeded && facts.length > 0) {
    throw new Error(
      "failed Solana transactions cannot contain lifecycle facts",
    );
  }
  const instructionNamesJson = JSON.stringify(input.instructionNames);
  const factsDigest = digestLifecycleFacts(facts);

  const commit = db.transaction(() => {
    const checkpoint = loadSolanaIndexerCheckpoint({
      cluster: identity.cluster,
      programId: identity.programId,
    });
    if (checkpoint && checkpoint.startSlot !== input.startSlot) {
      throw new Error("Solana lifecycle index start slot drifted");
    }

    const existing = loadSolanaIndexedTransactionStatement.get(
      identity.cluster,
      identity.programId,
      input.signature,
    ) as Record<string, unknown> | null;
    if (existing) {
      const exactReplay =
        Number(existing.slot) === input.slot &&
        (existing.blockTime == null ? null : Number(existing.blockTime)) ===
          input.blockTime &&
        Boolean(existing.succeeded) === input.succeeded &&
        String(existing.instructionNamesJson) === instructionNamesJson &&
        String(existing.transactionDigest) === input.transactionDigest &&
        String(existing.factsDigest) === factsDigest;
      if (!exactReplay) {
        throw new Error(
          "Solana indexed transaction conflicts with immutable persisted evidence",
        );
      }
      return false;
    }
    if (checkpoint && input.slot < checkpoint.slot) {
      throw new Error(
        "Solana indexed transaction would regress the checkpoint",
      );
    }

    insertSolanaIndexedTransactionStatement.run(
      identity.cluster,
      identity.programId,
      input.signature,
      input.slot,
      input.blockTime,
      input.succeeded ? 1 : 0,
      instructionNamesJson,
      input.transactionDigest,
      factsDigest,
      input.indexedAt,
    );
    facts.forEach((fact, factIndex) => {
      insertSolanaLifecycleFactStatement.run(
        identity.cluster,
        identity.programId,
        input.signature,
        factIndex,
        fact.kind,
        fact.marketPda,
        JSON.stringify(fact),
      );
    });
    upsertSolanaIndexerCheckpointStatement.run(
      identity.cluster,
      identity.programId,
      input.startSlot,
      input.signature,
      input.slot,
      input.indexedAt,
    );
    return true;
  });

  return commit();
}

export function checkDatabaseHealth(): { ok: boolean; error: string | null } {
  try {
    const row = db.query("SELECT 1 AS ok").get() as { ok?: number } | null;
    if (row?.ok !== 1) {
      return { ok: false, error: "SQLite health probe returned no result" };
    }
    const compatibility = inspectKeeperDatabaseCompatibility(db);
    return compatibility.compatible
      ? { ok: true, error: null }
      : {
          ok: false,
          error: `Keeper database migration required (${compatibility.blockers.join("; ")})`,
        };
  } catch {
    return { ok: false, error: "SQLite health probe failed" };
  }
}

export function auditKeeperDatabase(): KeeperDatabaseCompatibilityAudit {
  return inspectKeeperDatabaseCompatibility(db);
}

export function migrateLegacyDatabase(
  input: ApplyKeeperLegacyMigrationInput,
): KeeperLegacyMigrationResult {
  return applyKeeperLegacyMigration(db, input);
}

export function closeDb(): void {
  db.close();
}
