import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import bs58 from "bs58";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDuelCorrelationId } from "./duelCorrelation";

const TEST_PROGRAM_ID = bs58.encode(Buffer.alloc(32, 61));

function sleepMs(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function cleanupTempDir(tempDir: string): void {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")) {
        throw error;
      }
      if (attempt === 5) {
        return;
      }
      sleepMs(25 * (attempt + 1));
    }
  }
}

function canonicalSignature(index: number): string {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(index, 0);
  return bs58.encode(bytes);
}

function seedDuplicateBets(dbPath: string): void {
  const seedDb = new Database(dbPath, { create: true });
  seedDb.run(`CREATE TABLE IF NOT EXISTS bets (
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
  const insertBet = seedDb.prepare(
    `INSERT INTO bets (
      id,
      bettor_wallet,
      chain,
      source_asset,
      source_amount,
      fee_bps,
      tx_signature,
      market_pda,
      duel_key,
      duel_id,
      invite_code,
      external_bet_ref,
      recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertBet.run(
    "bet-1",
    "wallet-1",
    "solana",
    "SOL",
    1,
    25,
    "tx-1",
    null,
    "duel-key-1",
    "duel-1",
    null,
    "ext-1",
    10,
  );
  insertBet.run(
    "bet-2",
    "wallet-2",
    "solana",
    "SOL",
    2,
    25,
    "tx-1",
    null,
    "duel-key-1",
    "duel-1",
    null,
    "ext-2",
    20,
  );
  insertBet.run(
    "bet-3",
    "wallet-3",
    "solana",
    "SOL",
    3,
    25,
    "tx-3",
    null,
    "duel-key-2",
    "duel-2",
    null,
    "ext-shared",
    30,
  );
  insertBet.run(
    "bet-4",
    "wallet-4",
    "solana",
    "SOL",
    4,
    25,
    "tx-4",
    null,
    "duel-key-2",
    "duel-2",
    null,
    "ext-shared",
    40,
  );
  seedDb.close(false);
}

describe("keeper db persistence", () => {
  let tempDir = "";
  let loadedModules: Array<{ closeDb(): void }> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "keeper-db-"));
    process.env.KEEPER_DB_PATH = path.join(tempDir, "keeper.sqlite");
    loadedModules = [];
  });

  afterEach(() => {
    delete process.env.KEEPER_DB_PATH;
    for (const module of loadedModules) {
      module.closeDb();
    }
    cleanupTempDir(tempDir);
  });

  test("quarantines duplicate recorded bets before enforcing uniqueness", async () => {
    seedDuplicateBets(process.env.KEEPER_DB_PATH!);

    const db = (await import(
      `./db.ts?case=${Date.now()}-duplicate-bets`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const state = db.loadAll();
    expect(state.bets).toEqual([]);
    expect(db.auditKeeperDatabase()).toMatchObject({
      compatible: false,
      unverifiedBetCount: 2,
    });
    expect(db.auditKeeperDatabase()).toMatchObject({
      compatible: false,
      schemaVersion: 0,
      retiredColumns: ["bets.source_amount"],
      unverifiedBetCount: 2,
    });
    expect(db.checkDatabaseHealth()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Keeper database migration required"),
    });

    const inspectDb = new Database(process.env.KEEPER_DB_PATH!);
    try {
      const conflicts = inspectDb
        .prepare(
          `SELECT original_id AS originalId, reason
             FROM bets_duplicate_conflicts
            ORDER BY original_id ASC`,
        )
        .all() as Array<{ originalId: string; reason: string }>;
      expect(conflicts.map((row) => row.originalId)).toEqual([
        "bet-2",
        "bet-4",
      ]);
      expect(conflicts[0]?.reason).toContain("duplicate chain+tx_signature");
      expect(conflicts[1]?.reason).toContain("duplicate external_bet_ref");
    } finally {
      inspectDb.close(false);
    }
  });

  test("round-trips native SOL amounts as exact lamport integers", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-native-lamports`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    expect(
      db.saveBet({
        id: "native-bet-1",
        cluster: "devnet",
        programId: TEST_PROGRAM_ID,
        bettorWallet: "wallet-1",
        chain: "SOLANA",
        sourceAsset: "SOL",
        sourceAmountLamports: "9007199254740993",
        feeAmountLamports: "22517998136852",
        feeBps: 25,
        txSignature: "native-tx-1",
        marketPda: "market-1",
        duelKey: "duel-key-1",
        duelId: "duel-1",
        inviteCode: null,
        externalBetRef: "solana:native-tx-1",
        recordedAt: 1_700_000_000_000,
      }),
    ).toBe(true);

    const [bet] = db.loadAll().bets;
    expect(bet?.sourceAmountLamports).toBe("9007199254740993");
    expect(bet?.feeAmountLamports).toBe("22517998136852");
    expect(bet?.sourceAsset).toBe("SOL");

    const inspectDb = new Database(process.env.KEEPER_DB_PATH!);
    try {
      const row = inspectDb
        .prepare(
          `SELECT
             CAST(source_amount_lamports AS TEXT) AS sourceAmountLamports,
             CAST(fee_amount_lamports AS TEXT) AS feeAmountLamports
           FROM bets
          WHERE id = ?`,
        )
        .get("native-bet-1") as Record<string, unknown>;
      expect(row.sourceAmountLamports).toBe("9007199254740993");
      expect(row.feeAmountLamports).toBe("22517998136852");
    } finally {
      inspectDb.close(false);
    }
  });

  test("rejects an incomplete duel identity before persisting a bet", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-incomplete-duel-identity`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    expect(() =>
      db.saveBet({
        id: "incomplete-duel-bet",
        cluster: "devnet",
        programId: TEST_PROGRAM_ID,
        bettorWallet: "wallet-1",
        chain: "SOLANA",
        sourceAsset: "SOL",
        sourceAmountLamports: "60000",
        feeAmountLamports: "0",
        feeBps: 0,
        txSignature: "incomplete-duel-tx",
        marketPda: "market-1",
        duelKey: "42".repeat(32),
        duelId: null,
        inviteCode: null,
        externalBetRef: "solana:incomplete-duel-tx",
        recordedAt: 1_700_000_000_000,
      }),
    ).toThrow("bet duel identity is incomplete");

    expect(db.loadAll().bets).toEqual([]);
  });

  test("atomically persists verified fill, collateral, fee, and reward accounting", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-bet-execution`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const bet = {
      id: "verified-bet-1",
      cluster: "devnet",
      programId: TEST_PROGRAM_ID,
      bettorWallet: "wallet-1",
      chain: "SOLANA" as const,
      sourceAsset: "SOL" as const,
      sourceAmountLamports: "56400",
      feeAmountLamports: "400",
      feeBps: 200,
      txSignature: "verified-tx-1",
      marketPda: "market-1",
      duelKey: "42".repeat(32),
      duelId: "duel-1",
      inviteCode: null,
      externalBetRef: "solana:verified-tx-1",
      recordedAt: 1_700_000_000_000,
    };
    const execution = {
      orderId: "7",
      side: 1 as const,
      limitPrice: 600,
      orderBehavior: 0 as const,
      orderAmountUnits: "100000",
      matchedAmountUnits: "40000",
      restingAmountUnits: "60000",
      releasedAmountUnits: "0",
      collateralLamports: "56000",
      executedCostLamports: "20000",
      tradeTreasuryFeeLamports: "200",
      tradeMarketMakerFeeLamports: "200",
      rewardEligibleLamports: "20400",
      verifiedAt: 1_700_000_000_001,
    };

    expect(db.saveBet(bet, execution)).toBe(true);
    expect(db.saveBet({ ...bet, id: "duplicate-id" }, execution)).toBe(false);

    const inspectDb = new Database(process.env.KEEPER_DB_PATH!);
    try {
      const row = inspectDb
        .prepare(
          `SELECT
             order_id AS orderId,
             matched_amount_units AS matchedAmountUnits,
             resting_amount_units AS restingAmountUnits,
             CAST(collateral_lamports AS TEXT) AS collateralLamports,
             CAST(executed_cost_lamports AS TEXT) AS executedCostLamports,
             CAST(reward_eligible_lamports AS TEXT) AS rewardEligibleLamports
           FROM bet_executions
          WHERE bet_id = ?`,
        )
        .get(bet.id) as Record<string, unknown>;
      expect(row).toEqual({
        orderId: "7",
        matchedAmountUnits: "40000",
        restingAmountUnits: "60000",
        collateralLamports: "56000",
        executedCostLamports: "20000",
        rewardEligibleLamports: "20400",
      });
      const count = inspectDb
        .prepare("SELECT COUNT(*) AS count FROM bet_executions")
        .get() as { count: number };
      expect(count.count).toBe(1);
    } finally {
      inspectDb.close(false);
    }
  });

  test("rolls back a bet when verified execution invariants fail", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-bad-bet-execution`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    expect(() =>
      db.saveBet(
        {
          id: "invalid-verified-bet",
          cluster: "devnet",
          programId: TEST_PROGRAM_ID,
          bettorWallet: "wallet-1",
          chain: "SOLANA",
          sourceAsset: "SOL",
          sourceAmountLamports: "56400",
          feeAmountLamports: "400",
          feeBps: 200,
          txSignature: "invalid-verified-tx",
          marketPda: "market-1",
          duelKey: "42".repeat(32),
          duelId: "duel-1",
          inviteCode: null,
          externalBetRef: "solana:invalid-verified-tx",
          recordedAt: 1_700_000_000_000,
        },
        {
          orderId: "7",
          side: 1,
          limitPrice: 600,
          orderBehavior: 0,
          orderAmountUnits: "100000",
          matchedAmountUnits: "40000",
          restingAmountUnits: "50000",
          releasedAmountUnits: "0",
          collateralLamports: "56000",
          executedCostLamports: "20000",
          tradeTreasuryFeeLamports: "200",
          tradeMarketMakerFeeLamports: "200",
          rewardEligibleLamports: "20400",
          verifiedAt: 1_700_000_000_001,
        },
      ),
    ).toThrow("accounting invariant");

    expect(db.loadAll().bets).toEqual([]);
  });

  test("atomically advances an idempotent finalized lifecycle cursor with immutable facts", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-solana-lifecycle-index`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const programId = bs58.encode(Buffer.alloc(32, 7));
    const marketPda = bs58.encode(Buffer.alloc(32, 8));
    const wallet = bs58.encode(Buffer.alloc(32, 9));
    const indexed = {
      cluster: "mainnet-beta",
      programId,
      startSlot: 100,
      signature: canonicalSignature(1),
      slot: 101,
      blockTime: 1_700_000_101,
      succeeded: true,
      instructionNames: ["cancelOrder"],
      transactionDigest: "ab".repeat(32),
      facts: [
        {
          kind: "ORDER_CANCELLED" as const,
          marketPda,
          orderId: "7",
          wallet,
          side: 1 as const,
          price: 600,
          amountUnits: "40000",
          amountLamports: "24000",
        },
      ],
      indexedAt: 1_700_000_000_000,
    };

    expect(
      db.loadSolanaIndexerCheckpoint({ cluster: "mainnet-beta", programId }),
    ).toBeNull();
    expect(db.commitSolanaIndexedTransaction(indexed)).toBe(true);
    expect(db.commitSolanaIndexedTransaction(indexed)).toBe(false);
    expect(
      db.loadSolanaIndexerCheckpoint({ cluster: "mainnet-beta", programId }),
    ).toEqual({
      cluster: "mainnet-beta",
      programId,
      startSlot: 100,
      signature: canonicalSignature(1),
      slot: 101,
      updatedAt: 1_700_000_000_000,
    });

    expect(() =>
      db.commitSolanaIndexedTransaction({
        ...indexed,
        transactionDigest: "cd".repeat(32),
      }),
    ).toThrow("conflicts with immutable persisted evidence");
    expect(() =>
      db.commitSolanaIndexedTransaction({
        ...indexed,
        signature: canonicalSignature(2),
        slot: 100,
      }),
    ).toThrow("regress the checkpoint");
    expect(() =>
      db.commitSolanaIndexedTransaction({
        ...indexed,
        startSlot: 99,
        signature: canonicalSignature(3),
        slot: 102,
      }),
    ).toThrow("start slot drifted");

    const inspectDb = new Database(process.env.KEEPER_DB_PATH!);
    try {
      const transactionCount = inspectDb
        .prepare("SELECT COUNT(*) AS count FROM solana_indexed_transactions")
        .get() as { count: number };
      const facts = inspectDb
        .prepare(
          `SELECT kind, market_pda AS marketPda, payload_json AS payloadJson
             FROM solana_lifecycle_facts`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(transactionCount.count).toBe(1);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.kind).toBe("ORDER_CANCELLED");
      expect(facts[0]?.marketPda).toBe(marketPda);
      expect(JSON.parse(String(facts[0]?.payloadJson))).toMatchObject({
        orderId: "7",
        amountLamports: "24000",
      });
    } finally {
      inspectDb.close(false);
    }
  });

  test("persists ordered duplicate instruction names without weakening exact replay", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-solana-duplicate-instruction-names`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const programId = bs58.encode(Buffer.alloc(32, 10));
    const marketPda = bs58.encode(Buffer.alloc(32, 11));
    const indexed = {
      cluster: "mainnet-beta",
      programId,
      startSlot: 300,
      signature: canonicalSignature(10),
      slot: 301,
      blockTime: 1_700_000_301,
      succeeded: true,
      instructionNames: ["syncMarketFromDuel", "syncMarketFromDuel"],
      transactionDigest: "10".repeat(32),
      facts: [
        {
          kind: "MARKET_SYNCED" as const,
          marketPda,
          status: "open" as const,
          winner: "none" as const,
        },
        {
          kind: "MARKET_SYNCED" as const,
          marketPda,
          status: "open" as const,
          winner: "none" as const,
        },
      ],
      indexedAt: 1_700_000_000_301,
    };

    expect(db.commitSolanaIndexedTransaction(indexed)).toBe(true);
    expect(db.commitSolanaIndexedTransaction(indexed)).toBe(false);
    expect(
      db.loadSolanaLifecycleFacts({
        cluster: "mainnet-beta",
        programId,
        marketPda,
      }),
    ).toHaveLength(2);
    expect(() =>
      db.commitSolanaIndexedTransaction({
        ...indexed,
        instructionNames: ["syncMarketFromDuel"],
      }),
    ).toThrow("conflicts with immutable persisted evidence");
  });

  test("persists loser cleanup as audited non-payout lifecycle evidence", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-solana-loser-cleanup-index`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const programId = bs58.encode(Buffer.alloc(32, 17));
    const marketPda = bs58.encode(Buffer.alloc(32, 18));
    const wallet = bs58.encode(Buffer.alloc(32, 19));
    const signature = canonicalSignature(19);
    expect(
      db.commitSolanaIndexedTransaction({
        cluster: "mainnet-beta",
        programId,
        startSlot: 200,
        signature,
        slot: 201,
        blockTime: 1_700_000_201,
        succeeded: true,
        instructionNames: ["closeLosingBalance"],
        transactionDigest: "19".repeat(32),
        facts: [
          {
            kind: "LOSING_BALANCE_CLOSED",
            marketPda,
            wallet,
            side: 2,
            amountUnits: "40000",
            amountLamports: "16000",
            status: "resolved",
            winner: "a",
          },
        ],
        indexedAt: 1_700_000_000_201,
      }),
    ).toBe(true);

    expect(
      db.loadSolanaLifecycleFacts({
        cluster: "mainnet-beta",
        programId,
        marketPda,
        kind: "LOSING_BALANCE_CLOSED",
      }),
    ).toEqual([
      {
        signature,
        slot: 201,
        factIndex: 0,
        fact: {
          kind: "LOSING_BALANCE_CLOSED",
          marketPda,
          wallet,
          side: 2,
          amountUnits: "40000",
          amountLamports: "16000",
          status: "resolved",
          winner: "a",
        },
      },
    ]);

    const inspectDb = new Database(process.env.KEEPER_DB_PATH!);
    try {
      const terminalCount = inspectDb
        .prepare("SELECT COUNT(*) AS count FROM solana_terminal_settlements")
        .get() as { count: number };
      expect(terminalCount.count).toBe(0);
    } finally {
      inspectDb.close(false);
    }
  });

  test("materializes loser cleanup into durable wallet and bet history", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-solana-loser-cleanup-terminal`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const programId = bs58.encode(Buffer.alloc(32, 21));
    const marketPda = bs58.encode(Buffer.alloc(32, 22));
    const wallet = bs58.encode(Buffer.alloc(32, 23));
    const counterparty = bs58.encode(Buffer.alloc(32, 24));
    const placeSignature = canonicalSignature(21);
    const counterpartySignature = canonicalSignature(22);
    const cleanupSignature = canonicalSignature(23);
    const bet = {
      id: "loser-cleanup-bet",
      cluster: "mainnet-beta",
      programId,
      bettorWallet: wallet,
      chain: "SOLANA" as const,
      sourceAsset: "SOL" as const,
      sourceAmountLamports: "6000",
      feeAmountLamports: "0",
      feeBps: 0,
      txSignature: placeSignature,
      marketPda,
      duelKey: "23".repeat(32),
      duelId: "duel-loser-cleanup",
      inviteCode: null,
      externalBetRef: `solana:${placeSignature}`,
      recordedAt: 1_700_000_100_000,
    };
    const commit = (
      signature: string,
      slot: number,
      instructionNames: string[],
      facts: import("./solanaLifecycleIndexer").SolanaLifecycleFact[],
    ) =>
      db.commitSolanaIndexedTransaction({
        cluster: "mainnet-beta",
        programId,
        startSlot: 300,
        signature,
        slot,
        blockTime: 1_700_000_000 + slot,
        succeeded: true,
        instructionNames,
        transactionDigest: slot.toString(16).padStart(64, "0"),
        facts,
        indexedAt: 1_700_000_100_000 + slot,
      });

    expect(
      commit(
        placeSignature,
        301,
        ["placeOrder"],
        [
          {
            kind: "ORDER_PLACED",
            marketPda,
            orderId: "1",
            wallet,
            side: 2,
            price: 400,
            orderBehavior: 0,
            amountUnits: "10000",
          },
        ],
      ),
    ).toBe(true);
    expect(
      db.saveBet(bet, {
        orderId: "1",
        side: 2,
        limitPrice: 400,
        orderBehavior: 0,
        orderAmountUnits: "10000",
        matchedAmountUnits: "0",
        restingAmountUnits: "10000",
        releasedAmountUnits: "0",
        collateralLamports: "6000",
        executedCostLamports: "0",
        tradeTreasuryFeeLamports: "0",
        tradeMarketMakerFeeLamports: "0",
        rewardEligibleLamports: "0",
        verifiedAt: 1_700_000_100_301,
      }),
    ).toBe(true);
    expect(
      commit(
        counterpartySignature,
        302,
        ["placeOrder"],
        [
          {
            kind: "ORDER_PLACED",
            marketPda,
            orderId: "2",
            wallet: counterparty,
            side: 1,
            price: 500,
            orderBehavior: 0,
            amountUnits: "10000",
          },
          {
            kind: "ORDER_MATCHED",
            marketPda,
            makerOrderId: "1",
            takerOrderId: "2",
            price: 400,
            amountUnits: "10000",
          },
          {
            kind: "TAKER_EXECUTION",
            marketPda,
            orderId: "2",
            wallet: counterparty,
            side: 1,
            price: 500,
            amountUnits: "10000",
            releasedAmountUnits: "0",
            amountLamports: "4000",
            feeLamports: "0",
            refundLamports: "1000",
            treasuryFeeLamports: "0",
            marketMakerFeeLamports: "0",
            selfTradeTriggered: false,
          },
        ],
      ),
    ).toBe(true);
    expect(
      commit(
        cleanupSignature,
        303,
        ["closeLosingBalance"],
        [
          {
            kind: "LOSING_BALANCE_CLOSED",
            marketPda,
            wallet,
            side: 2,
            amountUnits: "10000",
            amountLamports: "6000",
            status: "resolved",
            winner: "a",
          },
          {
            kind: "MARKET_SYNCED",
            marketPda,
            status: "resolved",
            winner: "a",
          },
        ],
      ),
    ).toBe(true);

    expect(
      db.reconcileSolanaBetLifecycleAccounting({
        cluster: "mainnet-beta",
        programId,
        throughSlot: 303,
        throughSignature: cleanupSignature,
        reconciledAt: 1_700_000_110_000,
      }),
    ).toMatchObject({
      reconciledBets: 1,
      pendingBets: 0,
      terminalSettlements: 1,
      settledBets: 1,
    });
    expect(db.loadSolanaBetTerminalSettlement(bet.id)).toMatchObject({
      betId: bet.id,
      claimSignature: cleanupSignature,
      kind: "LOSER_CLEANUP",
      status: "resolved",
      winner: "a",
      matchedAmountUnits: "10000",
      grossEntitlementLamports: "0",
      payoutLamports: "0",
      feeLamports: "0",
    });
    expect(
      db.loadSolanaWalletBetHistory({
        cluster: "mainnet-beta",
        programId,
        wallet,
        marketPda,
        limit: 10,
        offset: 0,
      }).entries[0],
    ).toMatchObject({
      betId: bet.id,
      orderState: "FILLED",
      settlementState: "LOST",
      terminalKind: "LOSER_CLEANUP",
      terminalStatus: "resolved",
      terminalWinner: "a",
      claimSignature: cleanupSignature,
      terminalGrossLamports: "0",
      terminalPayoutLamports: "0",
      terminalFeeLamports: "0",
    });
  });

  test("reconciles later fills and refunds into idempotent bettor and referral rewards", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-bet-lifecycle-reconciliation`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const programId = bs58.encode(Buffer.alloc(32, 7));
    const marketPda = bs58.encode(Buffer.alloc(32, 8));
    const wallet = bs58.encode(Buffer.alloc(32, 9));
    const referrer = bs58.encode(Buffer.alloc(32, 10));
    const placeSignature = canonicalSignature(10);
    const referenceId = `solana:${placeSignature}`;
    const bet = {
      id: "reconciled-bet-1",
      cluster: "mainnet-beta",
      programId,
      bettorWallet: wallet,
      chain: "SOLANA" as const,
      sourceAsset: "SOL" as const,
      sourceAmountLamports: "5640000000",
      feeAmountLamports: "40000000",
      feeBps: 200,
      txSignature: placeSignature,
      marketPda,
      duelKey: "42".repeat(32),
      duelId: "duel-reconcile",
      inviteCode: "REFCODE",
      externalBetRef: referenceId,
      recordedAt: 1_700_000_000_000,
    };
    expect(
      db.saveBet(bet, {
        orderId: "7",
        side: 1,
        limitPrice: 600,
        orderBehavior: 0,
        orderAmountUnits: "10000000000",
        matchedAmountUnits: "4000000000",
        restingAmountUnits: "6000000000",
        releasedAmountUnits: "0",
        collateralLamports: "5600000000",
        executedCostLamports: "2000000000",
        tradeTreasuryFeeLamports: "20000000",
        tradeMarketMakerFeeLamports: "20000000",
        rewardEligibleLamports: "2040000000",
        verifiedAt: 1_700_000_000_001,
      }),
    ).toBe(true);
    db.saveWalletPoints(wallet, {
      selfPoints: 20,
      winPoints: 0,
      referralPoints: 0,
    });
    db.saveWalletPoints(referrer, {
      selfPoints: 0,
      winPoints: 0,
      referralPoints: 4,
    });
    db.saveReferral(wallet, referrer, "REFCODE");
    db.savePointsEvent({
      wallet,
      eventType: "BET_PLACED",
      status: "CONFIRMED",
      totalPoints: 20,
      referenceType: "BET",
      referenceId,
      relatedWallet: null,
      createdAt: 1_700_000_000_000,
    });
    db.savePointsEvent({
      wallet: referrer,
      eventType: "REFERRAL_WIN",
      status: "CONFIRMED",
      totalPoints: 4,
      referenceType: "BET",
      referenceId,
      relatedWallet: wallet,
      createdAt: 1_700_000_000_000,
    });

    expect(
      db.reconcileSolanaBetLifecycleAccounting({
        cluster: "devnet",
        programId,
        throughSlot: 100,
        throughSignature: canonicalSignature(8),
        reconciledAt: 1_700_000_000_400,
      }),
    ).toMatchObject({
      reconciledBets: 0,
      pendingBets: 0,
      oldestPendingBetRecordedAt: null,
      changes: [],
    });
    expect(
      db.reconcileSolanaBetLifecycleAccounting({
        cluster: "mainnet-beta",
        programId,
        throughSlot: 100,
        throughSignature: canonicalSignature(9),
        reconciledAt: 1_700_000_000_500,
      }),
    ).toMatchObject({
      reconciledBets: 0,
      pendingBets: 1,
      oldestPendingBetRecordedAt: bet.recordedAt,
    });

    const commit = (
      signatureIndex: number,
      slot: number,
      facts: import("./solanaLifecycleIndexer").SolanaLifecycleFact[],
    ) =>
      db.commitSolanaIndexedTransaction({
        cluster: "mainnet-beta",
        programId,
        startSlot: 100,
        signature: canonicalSignature(signatureIndex),
        slot,
        blockTime: 1_700_000_000 + slot,
        succeeded: true,
        instructionNames: [
          facts.some((fact) => fact.kind === "ORDER_PLACED")
            ? "placeOrder"
            : facts.some((fact) => fact.kind === "ORDER_CANCELLED")
              ? "cancelOrder"
              : "placeOrder",
        ],
        transactionDigest: signatureIndex.toString(16).padStart(64, "0"),
        facts,
        indexedAt: 1_700_000_000_000 + slot,
      });
    expect(
      commit(10, 101, [
        {
          kind: "ORDER_PLACED",
          marketPda,
          orderId: "7",
          wallet,
          side: 1,
          price: 600,
          orderBehavior: 0,
          amountUnits: "10000000000",
        },
        {
          kind: "TAKER_EXECUTION",
          marketPda,
          orderId: "7",
          wallet,
          side: 1,
          price: 600,
          amountUnits: "4000000000",
          releasedAmountUnits: "0",
          amountLamports: "2000000000",
          feeLamports: "40000000",
          refundLamports: "400000000",
          treasuryFeeLamports: "20000000",
          marketMakerFeeLamports: "20000000",
          selfTradeTriggered: false,
        },
      ]),
    ).toBe(true);
    expect(
      db.loadSolanaIndexedOrderPlacement({
        cluster: "mainnet-beta",
        programId,
        marketPda,
        orderId: "7",
      }),
    ).toMatchObject({
      kind: "ORDER_PLACED",
      wallet,
      side: 1,
      price: 600,
    });
    expect(
      db.loadSolanaIndexedTransactionEvidence({
        cluster: "mainnet-beta",
        programId,
        signature: placeSignature,
      }),
    ).toMatchObject({
      cluster: "mainnet-beta",
      programId,
      signature: placeSignature,
      slot: 101,
      succeeded: true,
      instructionNames: ["placeOrder"],
      facts: [
        {
          kind: "ORDER_PLACED",
          marketPda,
          orderId: "7",
          wallet,
          orderBehavior: 0,
        },
        {
          kind: "TAKER_EXECUTION",
          marketPda,
          orderId: "7",
          wallet,
          treasuryFeeLamports: "20000000",
          marketMakerFeeLamports: "20000000",
          selfTradeTriggered: false,
        },
      ],
    });
    expect(
      commit(11, 102, [
        {
          kind: "ORDER_MATCHED",
          marketPda,
          makerOrderId: "7",
          takerOrderId: "8",
          price: 600,
          amountUnits: "2000000000",
        },
      ]),
    ).toBe(true);
    expect(
      commit(12, 103, [
        {
          kind: "ORDER_CANCELLED",
          marketPda,
          orderId: "7",
          wallet,
          side: 1,
          price: 600,
          amountUnits: "4000000000",
          amountLamports: "2400000000",
        },
      ]),
    ).toBe(true);

    const first = db.reconcileSolanaBetLifecycleAccounting({
      cluster: "mainnet-beta",
      programId,
      throughSlot: 103,
      throughSignature: canonicalSignature(12),
      reconciledAt: 1_700_000_001_000,
    });
    expect(first).toMatchObject({
      reconciledBets: 1,
      pendingBets: 0,
      oldestPendingBetRecordedAt: null,
      changes: [
        {
          betId: bet.id,
          wallet,
          selfPointsDelta: 12,
          referrerWallet: referrer,
          referralPointsDelta: 2,
        },
      ],
    });
    expect(first.changes[0]?.events.map((event) => event.eventType)).toEqual([
      "BET_FILL",
      "REFERRAL_FILL",
    ]);
    expect(
      db.reconcileSolanaBetLifecycleAccounting({
        cluster: "mainnet-beta",
        programId,
        throughSlot: 103,
        throughSignature: canonicalSignature(12),
        reconciledAt: 1_700_000_002_000,
      }).changes,
    ).toEqual([]);

    const state = db.loadAll();
    expect(state.pointsByWallet.get(wallet)?.selfPoints).toBe(32);
    expect(state.pointsByWallet.get(referrer)?.referralPoints).toBe(6);
    const inspectDb = new Database(process.env.KEEPER_DB_PATH!);
    try {
      const accounting = inspectDb
        .prepare(
          `SELECT
             matched_amount_units AS matchedAmountUnits,
             resting_amount_units AS restingAmountUnits,
             released_amount_units AS releasedAmountUnits,
             CAST(executed_cost_lamports AS TEXT) AS executedCostLamports,
             CAST(refund_lamports AS TEXT) AS refundLamports,
             reward_points_total AS rewardPointsTotal,
             reward_points_applied AS rewardPointsApplied,
             referral_points_applied AS referralPointsApplied
           FROM bet_lifecycle_accounting
          WHERE bet_id = ?`,
        )
        .get(bet.id) as Record<string, unknown>;
      expect(accounting).toEqual({
        matchedAmountUnits: "6000000000",
        restingAmountUnits: "0",
        releasedAmountUnits: "4000000000",
        executedCostLamports: "3200000000",
        refundLamports: "2800000000",
        rewardPointsTotal: 32,
        rewardPointsApplied: 32,
        referralPointsApplied: 6,
      });
    } finally {
      inspectDb.close(false);
    }
  });

  test("atomically allocates and persists one wallet claim across its recorded bets", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-terminal-settlement-reconciliation`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    const programId = bs58.encode(Buffer.alloc(32, 51));
    const marketPda = bs58.encode(Buffer.alloc(32, 52));
    const wallet = bs58.encode(Buffer.alloc(32, 53));
    const counterparty = bs58.encode(Buffer.alloc(32, 54));
    const placeSignature = canonicalSignature(51);
    const counterpartySignature = canonicalSignature(52);
    const claimSignature = canonicalSignature(53);
    const bet = {
      id: "terminal-settlement-bet",
      cluster: "mainnet-beta",
      programId,
      bettorWallet: wallet,
      chain: "SOLANA" as const,
      sourceAsset: "SOL" as const,
      sourceAmountLamports: "6000",
      feeAmountLamports: "0",
      feeBps: 0,
      txSignature: placeSignature,
      marketPda,
      duelKey: "53".repeat(32),
      duelId: "duel-terminal-settlement",
      inviteCode: null,
      externalBetRef: `solana:${placeSignature}`,
      recordedAt: 1_700_000_010_000,
    };
    const correlationId = buildDuelCorrelationId({
      duelId: bet.duelId,
      duelKey: bet.duelKey,
    });
    const commit = (
      signature: string,
      slot: number,
      instructionNames: string[],
      facts: import("./solanaLifecycleIndexer").SolanaLifecycleFact[],
    ) =>
      db.commitSolanaIndexedTransaction({
        cluster: "mainnet-beta",
        programId,
        startSlot: 200,
        signature,
        slot,
        blockTime: 1_700_000_000 + slot,
        succeeded: true,
        instructionNames,
        transactionDigest: slot.toString(16).padStart(64, "0"),
        facts,
        indexedAt: 1_700_000_010_000 + slot,
      });
    expect(
      commit(
        placeSignature,
        201,
        ["placeOrder"],
        [
          {
            kind: "ORDER_PLACED",
            marketPda,
            orderId: "1",
            wallet,
            side: 1,
            price: 600,
            orderBehavior: 0,
            amountUnits: "10000",
          },
        ],
      ),
    ).toBe(true);
    expect(
      db.saveBet(bet, {
        orderId: "1",
        side: 1,
        limitPrice: 600,
        orderBehavior: 0,
        orderAmountUnits: "10000",
        matchedAmountUnits: "0",
        restingAmountUnits: "10000",
        releasedAmountUnits: "0",
        collateralLamports: "6000",
        executedCostLamports: "0",
        tradeTreasuryFeeLamports: "0",
        tradeMarketMakerFeeLamports: "0",
        rewardEligibleLamports: "0",
        verifiedAt: 1_700_000_010_001,
      }),
    ).toBe(true);
    expect(
      db.loadSolanaWalletBetHistory({
        cluster: "devnet",
        programId,
        wallet,
        marketPda,
        limit: 10,
        offset: 0,
      }),
    ).toMatchObject({ total: 0, entries: [] });
    expect(
      db.loadSolanaWalletBetHistory({
        cluster: "mainnet-beta",
        programId: bs58.encode(Buffer.alloc(32, 55)),
        wallet,
        marketPda,
        limit: 10,
        offset: 0,
      }),
    ).toMatchObject({ total: 0, entries: [] });
    expect(
      db.loadSolanaWalletBetHistory({
        cluster: "mainnet-beta",
        programId,
        wallet,
        marketPda,
        limit: 10,
        offset: 0,
      }),
    ).toMatchObject({
      wallet,
      total: 1,
      entries: [
        {
          betId: bet.id,
          correlationId,
          orderState: "PENDING_INDEX",
          settlementState: "NOT_READY",
          terminalKind: null,
          terminalStatus: null,
          terminalWinner: null,
          matchedAmountUnits: "0",
          restingAmountUnits: "10000",
        },
      ],
    });

    expect(
      commit(
        counterpartySignature,
        202,
        ["placeOrder"],
        [
          {
            kind: "ORDER_PLACED",
            marketPda,
            orderId: "2",
            wallet: counterparty,
            side: 2,
            price: 500,
            orderBehavior: 0,
            amountUnits: "10000",
          },
          {
            kind: "ORDER_MATCHED",
            marketPda,
            makerOrderId: "1",
            takerOrderId: "2",
            price: 600,
            amountUnits: "10000",
          },
          {
            kind: "TAKER_EXECUTION",
            marketPda,
            orderId: "2",
            wallet: counterparty,
            side: 2,
            price: 500,
            amountUnits: "10000",
            releasedAmountUnits: "0",
            amountLamports: "4000",
            feeLamports: "0",
            refundLamports: "1000",
            treasuryFeeLamports: "0",
            marketMakerFeeLamports: "0",
            selfTradeTriggered: false,
          },
        ],
      ),
    ).toBe(true);
    expect(
      commit(
        claimSignature,
        203,
        ["claim"],
        [
          {
            kind: "CLAIM_PAYOUT",
            marketPda,
            wallet,
            amountLamports: "9800",
            feeLamports: "200",
            status: "resolved",
            winner: "a",
          },
        ],
      ),
    ).toBe(true);

    const first = db.reconcileSolanaBetLifecycleAccounting({
      cluster: "mainnet-beta",
      programId,
      throughSlot: 203,
      throughSignature: claimSignature,
      reconciledAt: 1_700_000_020_000,
    });
    expect(first).toMatchObject({
      reconciledBets: 1,
      pendingBets: 0,
      oldestPendingBetRecordedAt: null,
      terminalSettlements: 1,
      settledBets: 1,
    });
    expect(db.loadSolanaBetTerminalSettlement(bet.id)).toEqual({
      betId: bet.id,
      marketPda,
      wallet,
      orderId: "1",
      side: 1,
      claimSignature,
      kind: "CLAIM_PAYOUT",
      status: "resolved",
      winner: "a",
      matchedAmountUnits: "10000",
      grossEntitlementLamports: "10000",
      payoutLamports: "9800",
      feeLamports: "200",
      settledAt: 1_700_000_020_000,
    });
    expect(
      db.commitSolanaIndexedTransaction({
        cluster: "devnet",
        programId,
        startSlot: 200,
        signature: canonicalSignature(54),
        slot: 500,
        blockTime: 1_700_000_500,
        succeeded: true,
        instructionNames: ["syncMarket"],
        transactionDigest: "54".repeat(32),
        facts: [
          {
            kind: "MARKET_SYNCED",
            marketPda,
            status: "cancelled",
            winner: "none",
          },
        ],
        indexedAt: 1_700_000_500_000,
      }),
    ).toBe(true);
    expect(
      db.loadSolanaWalletBetHistory({
        cluster: "mainnet-beta",
        programId,
        wallet,
        marketPda,
        limit: 10,
        offset: 0,
      }),
    ).toMatchObject({
      wallet,
      total: 1,
      limit: 10,
      offset: 0,
      entries: [
        {
          betId: bet.id,
          correlationId,
          placeSignature,
          orderId: "1",
          side: 1,
          limitPrice: 600,
          orderAmountUnits: "10000",
          matchedAmountUnits: "10000",
          restingAmountUnits: "0",
          releasedAmountUnits: "0",
          sourceAmountLamports: "6000",
          collateralLamports: "6000",
          executedCostLamports: "6000",
          tradeFeeLamports: "0",
          orderRefundLamports: "0",
          rewardEligibleLamports: "6000",
          marketStatus: null,
          winner: null,
          orderState: "FILLED",
          settlementState: "PAID",
          terminalKind: "CLAIM_PAYOUT",
          terminalStatus: "resolved",
          terminalWinner: "a",
          claimSignature,
          terminalGrossLamports: "10000",
          terminalPayoutLamports: "9800",
          terminalFeeLamports: "200",
          reconciledAt: 1_700_000_020_000,
          settledAt: 1_700_000_020_000,
        },
      ],
    });
    expect(commit(canonicalSignature(55), 204, [], [])).toBe(true);
    expect(
      db.reconcileSolanaBetLifecycleAccounting({
        cluster: "mainnet-beta",
        programId,
        throughSlot: 204,
        throughSignature: canonicalSignature(55),
        reconciledAt: 1_700_000_030_000,
      }),
    ).toMatchObject({
      reconciledBets: 1,
      terminalSettlements: 0,
      settledBets: 0,
    });
    expect(
      db.loadSolanaWalletBetHistory({
        cluster: "mainnet-beta",
        programId,
        wallet,
        marketPda,
        limit: 10,
        offset: 0,
      }).entries[0],
    ).toMatchObject({
      reconciledAt: 1_700_000_030_000,
      settledAt: 1_700_000_020_000,
      settlementState: "PAID",
    });

    const inspectDb = new Database(process.env.KEEPER_DB_PATH!);
    try {
      try {
        inspectDb
          .prepare("UPDATE bets SET tx_signature = ? WHERE id = ?")
          .run("not-canonical", bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("placement signature is invalid");
      } finally {
        inspectDb
          .prepare("UPDATE bets SET tx_signature = ? WHERE id = ?")
          .run(placeSignature, bet.id);
      }
      try {
        inspectDb
          .prepare(
            "UPDATE bet_terminal_settlements SET claim_signature = ? WHERE bet_id = ?",
          )
          .run("not-canonical", bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("terminal settlement is contradictory");
      } finally {
        inspectDb
          .prepare(
            "UPDATE bet_terminal_settlements SET claim_signature = ? WHERE bet_id = ?",
          )
          .run(claimSignature, bet.id);
      }
      try {
        inspectDb
          .prepare(
            "UPDATE bet_terminal_settlements SET order_id = ? WHERE bet_id = ?",
          )
          .run("2", bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("terminal settlement is contradictory");
      } finally {
        inspectDb
          .prepare(
            "UPDATE bet_terminal_settlements SET order_id = ? WHERE bet_id = ?",
          )
          .run("1", bet.id);
      }
      try {
        inspectDb
          .prepare(
            "UPDATE bet_terminal_settlements SET matched_amount_units = ? WHERE bet_id = ?",
          )
          .run("9999", bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("terminal settlement is contradictory");
      } finally {
        inspectDb
          .prepare(
            "UPDATE bet_terminal_settlements SET matched_amount_units = ? WHERE bet_id = ?",
          )
          .run("10000", bet.id);
      }
      try {
        inspectDb
          .prepare(
            `UPDATE bet_terminal_settlements
                SET kind = 'CANCELLATION_REFUND', status = 'cancelled', winner = 'none'
              WHERE bet_id = ?`,
          )
          .run(bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("refund settlement is contradictory");
      } finally {
        inspectDb
          .prepare(
            `UPDATE bet_terminal_settlements
                SET kind = 'CLAIM_PAYOUT', status = 'resolved', winner = 'a'
              WHERE bet_id = ?`,
          )
          .run(bet.id);
      }
      try {
        inspectDb
          .prepare("UPDATE bets SET duel_key = NULL WHERE id = ?")
          .run(bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("duel identity is incomplete");
      } finally {
        inspectDb
          .prepare("UPDATE bets SET duel_key = ? WHERE id = ?")
          .run(bet.duelKey, bet.id);
      }
      try {
        inspectDb
          .prepare(
            "UPDATE bets SET source_amount_lamports = source_amount_lamports + 1 WHERE id = ?",
          )
          .run(bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("persisted Solana bet history accounting is invalid");
      } finally {
        inspectDb
          .prepare(
            "UPDATE bets SET source_amount_lamports = source_amount_lamports - 1 WHERE id = ?",
          )
          .run(bet.id);
      }
      try {
        inspectDb
          .prepare(
            "UPDATE bet_executions SET order_amount_units = ? WHERE bet_id = ?",
          )
          .run("18446744073709551616", bet.id);
        expect(() =>
          db.loadSolanaWalletBetHistory({
            cluster: "mainnet-beta",
            programId,
            wallet,
            marketPda,
            limit: 10,
            offset: 0,
          }),
        ).toThrow("persisted order amount is invalid");
      } finally {
        inspectDb
          .prepare(
            "UPDATE bet_executions SET order_amount_units = ? WHERE bet_id = ?",
          )
          .run("10000", bet.id);
      }
      const aggregate = inspectDb
        .prepare(
          `SELECT
             CAST(gross_entitlement_lamports AS TEXT) AS gross,
             CAST(payout_lamports AS TEXT) AS payout,
             CAST(fee_lamports AS TEXT) AS fee,
             eligible_order_count AS eligibleOrders,
             recorded_bet_count AS recordedBets
           FROM solana_terminal_settlements
          WHERE cluster = ? AND program_id = ? AND market_pda = ? AND wallet = ?`,
        )
        .get("mainnet-beta", programId, marketPda, wallet) as Record<
        string,
        unknown
      >;
      expect(aggregate).toEqual({
        gross: "10000",
        payout: "9800",
        fee: "200",
        eligibleOrders: 1,
        recordedBets: 1,
      });
    } finally {
      inspectDb.close(false);
    }
  });

  test("reports SQLite availability for fail-closed readiness", async () => {
    const db = (await import(
      `./db.ts?case=${Date.now()}-health-probe`
    )) as typeof import("./db.ts");
    loadedModules.push(db);

    expect(db.checkDatabaseHealth()).toEqual({ ok: true, error: null });
    expect(db.auditKeeperDatabase()).toMatchObject({
      compatible: true,
      schemaVersion: 2,
      blockers: [],
    });
  });
});
