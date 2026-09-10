import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  PublicKey,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";

import {
  buildDisputeTransactionEvidence,
  collectBuildComponent,
  collectDuelChainEvidence,
  normalizeMarketAccountEvidence,
  normalizeOracleAccountEvidence,
} from "./duelDisputeEvidenceCollector";
import duelMarketIdl from "./idl/duel_market.json";
import fightOracleIdl from "./idl/fight_oracle.json";

const fightProgramId = new PublicKey(Buffer.alloc(32, 21));
const marketProgramId = new PublicKey(Buffer.alloc(32, 22));
const duelStatePda = new PublicKey(Buffer.alloc(32, 23));
const marketStatePda = new PublicKey(Buffer.alloc(32, 24));
const authority = new PublicKey(Buffer.alloc(32, 25));
const treasury = new PublicKey(Buffer.alloc(32, 26));
const marketMaker = new PublicKey(Buffer.alloc(32, 27));
const duelKey = "41".repeat(32);
const replayHash = "42".repeat(32);
const resultHash = "43".repeat(32);
const zeroBytes = Array(32).fill(0);

function instruction(
  programId: PublicKey,
  data: Buffer,
): { programId: PublicKey; accounts: PublicKey[]; data: string } {
  return { programId, accounts: [], data: bs58.encode(data) };
}

function transaction(
  index: number,
  instructions: Array<{
    programId: PublicKey;
    accounts: PublicKey[];
    data: string;
  }>,
): ParsedTransactionWithMeta {
  const signature = bs58.encode(Buffer.alloc(64, index));
  return {
    slot: index,
    blockTime: 1_700_000_000 + index,
    meta: {
      err: null,
      fee: 5_000,
      innerInstructions: null,
      logMessages: [],
      postBalances: [],
      postTokenBalances: null,
      preBalances: [],
      preTokenBalances: null,
      rewards: null,
      loadedAddresses: undefined,
      computeUnitsConsumed: 1,
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          {
            pubkey: new PublicKey(Buffer.alloc(32, index)),
            signer: true,
            writable: true,
          },
        ],
        instructions,
        recentBlockhash: new PublicKey(Buffer.alloc(32, index)).toBase58(),
      },
    },
    version: "legacy",
  } as unknown as ParsedTransactionWithMeta;
}

describe("SOL duel dispute evidence collector", () => {
  test("attests a materialized non-Git source tree conservatively", () => {
    const root = mkdtempSync(path.join(tmpdir(), "duel-build-evidence-"));
    try {
      writeFileSync(
        path.join(root, "runtime.ts"),
        "export const ready = true;\n",
      );
      expect(
        collectBuildComponent({
          root,
          files: ["runtime.ts"],
          sourceRevision: "a".repeat(40),
          workingTreeDirty: true,
        }),
      ).toMatchObject({
        sourceRevision: "a".repeat(40),
        workingTreeDirty: true,
        files: [{ path: "runtime.ts" }],
      });
      expect(() =>
        collectBuildComponent({
          root,
          files: ["runtime.ts"],
          sourceRevision: "a".repeat(40),
        }),
      ).toThrow("revision and dirty state must be supplied together");
      expect(() =>
        collectBuildComponent({
          root,
          files: ["runtime.ts"],
          sourceRevision: "not-a-revision",
          workingTreeDirty: true,
        }),
      ).toThrow("source revision is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalizes exact terminal oracle and market account state", () => {
    const oracle = normalizeOracleAccountEvidence({
      decoded: {
        duel_key: [...Buffer.from(duelKey, "hex")],
        participant_a_hash: Array(32).fill(1),
        participant_b_hash: Array(32).fill(2),
        competitive_snapshot_version: 3,
        competitive_snapshot_digest: Array(32).fill(3),
        account_schema_version: 2,
        status: { Resolved: {} },
        winner: { A: {} },
        bet_open_ts: new BN(100),
        bet_close_ts: new BN(110),
        duel_start_ts: new BN(115),
        duel_end_ts: new BN(140),
        seed: new BN(42),
        result_hash: [...Buffer.from(resultHash, "hex")],
        replay_hash: [...Buffer.from(replayHash, "hex")],
        metadata_uri: "hyperia://duel-1",
      },
      programId: fightProgramId,
      duelStatePda,
      expectedDuelKey: duelKey,
    });
    expect(oracle).toMatchObject({
      programId: fightProgramId.toBase58(),
      duelStatePda: duelStatePda.toBase58(),
      accountSchemaVersion: 2,
      status: "RESOLVED",
      winnerSide: "A",
      competitiveSnapshotVersion: 3,
      competitiveSnapshotDigest: "03".repeat(32),
      seed: "42",
      replayHash,
      resultHash,
    });

    const market = normalizeMarketAccountEvidence({
      decoded: {
        duel_state: duelStatePda,
        duel_key: [...Buffer.from(duelKey, "hex")],
        market_kind: 1,
        status: { Resolved: {} },
        winner: { A: {} },
        trade_treasury_fee_bps_snapshot: 100,
        trade_market_maker_fee_bps_snapshot: 50,
        winnings_market_maker_fee_bps_snapshot: 200,
        next_order_id: new BN(9),
        best_bid: 0,
        best_ask: 0,
        authority,
        treasury,
        market_maker: marketMaker,
        accrued_trade_treasury_fee_lamports: new BN(12),
        accrued_trade_market_maker_fee_lamports: new BN(6),
        bid_bitmap: Array.from({ length: 16 }, (_, index) => new BN(index)),
        ask_bitmap: Array(16).fill(new BN(0)),
      },
      programId: marketProgramId,
      marketStatePda,
      expectedDuelStatePda: duelStatePda,
      expectedDuelKey: duelKey,
    });
    expect(market).toMatchObject({
      status: "RESOLVED",
      winnerSide: "A",
      nextOrderId: "9",
      accruedTradeTreasuryFeeLamports: "12",
      accruedTradeMarketMakerFeeLamports: "6",
      authority: authority.toBase58(),
      treasury: treasury.toBase58(),
      marketMaker: marketMaker.toBase58(),
    });
    expect(market.bidBitmapHex).toHaveLength(256);
    expect(market.bidBitmapHex.endsWith("000000000000000f")).toBe(true);
  });

  test("retains only material finalized lifecycle actions and labels the last market sync", () => {
    const fightCoder = new BorshInstructionCoder(fightOracleIdl as Idl);
    const marketCoder = new BorshInstructionCoder(duelMarketIdl as Idl);
    const upsert = (status: "BettingOpen" | "Locked") =>
      instruction(
        fightProgramId,
        fightCoder.encode("upsert_duel", {
          duel_key: zeroBytes,
          participant_a_hash: zeroBytes,
          participant_b_hash: zeroBytes,
          bet_open_ts: new BN(100),
          bet_close_ts: new BN(110),
          duel_start_ts: new BN(115),
          metadata_uri: "hyperia://duel-1",
          status: { [status]: {} },
        }),
      );
    const proposed = instruction(
      fightProgramId,
      fightCoder.encode("propose_result", {
        _duel_key: zeroBytes,
        winner: { A: {} },
        seed: new BN(42),
        replay_hash: zeroBytes,
        result_hash: zeroBytes,
        duel_end_ts: new BN(140),
        metadata_uri: "hyperia://duel-1",
      }),
    );
    const finalized = instruction(
      fightProgramId,
      fightCoder.encode("finalize_result", {
        _duel_key: zeroBytes,
        metadata_uri: "hyperia://duel-1",
      }),
    );
    const initialized = instruction(
      marketProgramId,
      marketCoder.encode("initialize_market", {
        duel_key: zeroBytes,
        market_kind: 1,
      }),
    );
    const synced = instruction(
      marketProgramId,
      marketCoder.encode("sync_market_from_duel", {}),
    );
    const irrelevantOrder = instruction(
      marketProgramId,
      marketCoder.encode("cancel_order", { order_id: new BN(1) }),
    );
    const evidence = buildDisputeTransactionEvidence({
      transactions: [
        transaction(1, [upsert("BettingOpen")]),
        transaction(2, [initialized]),
        transaction(3, [upsert("Locked")]),
        transaction(4, [synced]),
        transaction(5, [irrelevantOrder]),
        transaction(6, [proposed]),
        transaction(7, [finalized]),
        transaction(8, [synced]),
      ],
      fightProgramId,
      marketProgramId,
      finalMarketStatus: "RESOLVED",
    });
    expect(evidence.flatMap(({ actions }) => actions)).toEqual([
      "oracle_betting_open",
      "market_initialized",
      "oracle_locked",
      "oracle_result_proposed",
      "oracle_result_finalized",
      "market_synced_resolved",
    ]);
    expect(evidence.map(({ slot }) => slot)).toEqual([1, 2, 3, 6, 7, 8]);
    expect(
      evidence.every(({ transactionDigest }) =>
        /^[0-9a-f]{64}$/.test(transactionDigest),
      ),
    ).toBe(true);
  });

  test("fails closed on a non-terminal account or identity drift", () => {
    expect(() =>
      normalizeOracleAccountEvidence({
        decoded: {
          duel_key: [...Buffer.from(duelKey, "hex")],
          status: { Locked: {} },
        },
        programId: fightProgramId,
        duelStatePda,
        expectedDuelKey: duelKey,
      }),
    ).toThrow("oracle is not terminal");
    expect(() =>
      normalizeMarketAccountEvidence({
        decoded: {
          duel_state: new PublicKey(Buffer.alloc(32, 31)),
          duel_key: [...Buffer.from(duelKey, "hex")],
        },
        programId: marketProgramId,
        marketStatePda,
        expectedDuelStatePda: duelStatePda,
        expectedDuelKey: duelKey,
      }),
    ).toThrow("market identity drifted");
  });

  test("requires cross-account finalized success parity before transaction fetch", async () => {
    const marketCoder = new BorshInstructionCoder(duelMarketIdl as Idl);
    const parsedTransaction = transaction(9, [
      instruction(
        marketProgramId,
        marketCoder.encode("sync_market_from_duel", {}),
      ),
    ]);
    const signature = parsedTransaction.transaction.signatures[0]!;
    let transactionFetches = 0;
    let marketError: unknown = {
      InstructionError: [0, "InvalidArgument"],
    };
    const connection = {
      getSignaturesForAddress: async (
        address: PublicKey,
        options: { before?: string },
      ) => {
        if (options.before) return [];
        return [
          {
            signature,
            slot: parsedTransaction.slot,
            blockTime: parsedTransaction.blockTime,
            err: address.equals(duelStatePda) ? null : marketError,
            confirmationStatus: "finalized",
          },
        ];
      },
      getParsedTransactions: async () => {
        transactionFetches += 1;
        return [parsedTransaction];
      },
    } as unknown as Connection;

    await expect(
      collectDuelChainEvidence({
        connection,
        duelStatePda,
        marketStatePda,
        fightProgramId,
        marketProgramId,
        finalMarketStatus: "RESOLVED",
      }),
    ).rejects.toThrow("cross-account signature drifted");
    expect(transactionFetches).toBe(0);

    marketError = null;
    await expect(
      collectDuelChainEvidence({
        connection,
        duelStatePda,
        marketStatePda,
        fightProgramId,
        marketProgramId,
        finalMarketStatus: "RESOLVED",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        signature,
        actions: ["market_synced_resolved"],
      }),
    ]);
    expect(transactionFetches).toBe(1);
  });
});
