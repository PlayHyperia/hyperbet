import "./setup";
import { afterEach, describe, expect, test } from "bun:test";
import bs58 from "bs58";

import {
  fetchSolanaSettlementHistory,
  mergeSolanaSettlementHistoryPages,
  parseSolanaSettlementHistoryResponse,
} from "../src/lib/solanaSettlementHistory";

const originalFetch = globalThis.fetch;
const key = (seed: number) => bs58.encode(new Uint8Array(32).fill(seed));
const signature = (seed: number) => bs58.encode(new Uint8Array(64).fill(seed));
const WALLET = key(1);
const OTHER_WALLET = key(2);
const MARKET = key(3);
const OTHER_MARKET = key(4);
const PROGRAM_ID = key(8);
const PLACE_SIGNATURE = signature(5);
const CLAIM_SIGNATURE = signature(6);
const REFUND_SIGNATURE = signature(7);
const RESPONSE_TIME = Date.now();

function payload() {
  return {
    schemaVersion: 2,
    chain: "SOLANA",
    asset: "SOL",
    decimals: 9,
    cluster: "devnet",
    programId: PROGRAM_ID,
    wallet: WALLET,
    ledger: {
      current: true,
      lastIndexedAt: RESPONSE_TIME - 100,
      degradedReason: null,
    },
    entries: [
      {
        betId: "bet-1",
        wallet: WALLET,
        marketPda: MARKET,
        duelKey: "ab".repeat(32),
        duelId: "duel-1",
        correlationId:
          "44f5499b0945eb31d924975ecfffcc56e95317e157e9bfb1a1883e429984f087",
        placeSignature: PLACE_SIGNATURE,
        recordedAt: 1_700_000_000_000,
        orderId: "7",
        side: 1,
        limitPrice: 600,
        orderAmountUnits: "1000000000",
        matchedAmountUnits: "1000000000",
        restingAmountUnits: "0",
        releasedAmountUnits: "0",
        sourceAmountLamports: "620000000",
        collateralLamports: "600000000",
        executedCostLamports: "600000000",
        tradeFeeLamports: "20000000",
        orderRefundLamports: "0",
        rewardEligibleLamports: "620000000",
        marketStatus: "resolved",
        winner: "a",
        orderState: "FILLED",
        settlementState: "PAYOUT_CLAIMABLE",
        terminalKind: null,
        terminalStatus: null,
        terminalWinner: null,
        claimSignature: null,
        terminalGrossLamports: "0",
        terminalPayoutLamports: "0",
        terminalFeeLamports: "0",
        reconciledAt: 1_700_000_000_100,
        settledAt: null,
      },
    ],
    total: 1,
    limit: 5,
    offset: 0,
    updatedAt: RESPONSE_TIME,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Solana settlement history", () => {
  test("parses exact integer order and settlement accounting", () => {
    expect(parseSolanaSettlementHistoryResponse(payload())).toMatchObject({
      wallet: WALLET,
      ledger: { current: true },
      entries: [
        {
          orderState: "FILLED",
          settlementState: "PAYOUT_CLAIMABLE",
          correlationId:
            "44f5499b0945eb31d924975ecfffcc56e95317e157e9bfb1a1883e429984f087",
          executedCostLamports: "600000000",
          tradeFeeLamports: "20000000",
        },
      ],
    });
  });

  test("accepts every keeper-derived order and settlement lifecycle state", () => {
    const cases: Array<{
      name: string;
      entry: Record<string, unknown>;
    }> = [
      {
        name: "pending index",
        entry: {
          matchedAmountUnits: "0",
          restingAmountUnits: "1000000000",
          executedCostLamports: "0",
          tradeFeeLamports: "0",
          sourceAmountLamports: "600000000",
          rewardEligibleLamports: "0",
          marketStatus: "open",
          winner: "none",
          orderState: "PENDING_INDEX",
          settlementState: "NOT_READY",
          reconciledAt: null,
        },
      },
      {
        name: "open",
        entry: {
          matchedAmountUnits: "0",
          restingAmountUnits: "1000000000",
          executedCostLamports: "0",
          tradeFeeLamports: "0",
          sourceAmountLamports: "600000000",
          rewardEligibleLamports: "0",
          marketStatus: "open",
          winner: "none",
          orderState: "OPEN",
          settlementState: "NOT_READY",
        },
      },
      {
        name: "partially filled",
        entry: {
          matchedAmountUnits: "400000000",
          restingAmountUnits: "600000000",
          executedCostLamports: "240000000",
          rewardEligibleLamports: "260000000",
          marketStatus: "open",
          winner: "none",
          orderState: "PARTIALLY_FILLED",
          settlementState: "NOT_READY",
        },
      },
      {
        name: "closed partial awaiting result",
        entry: {
          matchedAmountUnits: "400000000",
          restingAmountUnits: "0",
          releasedAmountUnits: "600000000",
          executedCostLamports: "240000000",
          rewardEligibleLamports: "260000000",
          marketStatus: "locked",
          winner: "none",
          orderState: "CLOSED_PARTIAL",
          settlementState: "AWAITING_RESULT",
        },
      },
      {
        name: "released with no entitlement",
        entry: {
          matchedAmountUnits: "0",
          restingAmountUnits: "0",
          releasedAmountUnits: "1000000000",
          executedCostLamports: "0",
          tradeFeeLamports: "0",
          sourceAmountLamports: "600000000",
          orderRefundLamports: "600000000",
          rewardEligibleLamports: "0",
          marketStatus: "cancelled",
          winner: "none",
          orderState: "RELEASED",
          settlementState: "NO_ENTITLEMENT",
        },
      },
      {
        name: "reclaim and refund claimable",
        entry: {
          matchedAmountUnits: "400000000",
          restingAmountUnits: "600000000",
          executedCostLamports: "240000000",
          rewardEligibleLamports: "260000000",
          marketStatus: "cancelled",
          winner: "none",
          orderState: "RECLAIM_REQUIRED",
          settlementState: "REFUND_CLAIMABLE",
        },
      },
      {
        name: "filled awaiting result",
        entry: {
          marketStatus: "locked",
          winner: "none",
          orderState: "FILLED",
          settlementState: "AWAITING_RESULT",
        },
      },
      {
        name: "resolved payout claimable",
        entry: {},
      },
      {
        name: "resolved loss",
        entry: { winner: "b", settlementState: "LOST" },
      },
      {
        name: "paid winner",
        entry: {
          settlementState: "PAID",
          terminalKind: "CLAIM_PAYOUT",
          terminalStatus: "resolved",
          terminalWinner: "a",
          claimSignature: CLAIM_SIGNATURE,
          terminalGrossLamports: "1000000000",
          terminalPayoutLamports: "980000000",
          terminalFeeLamports: "20000000",
          settledAt: 1_700_000_000_300,
        },
      },
      {
        name: "paid winner before market snapshot",
        entry: {
          marketStatus: null,
          winner: null,
          settlementState: "PAID",
          terminalKind: "CLAIM_PAYOUT",
          terminalStatus: "resolved",
          terminalWinner: "a",
          claimSignature: CLAIM_SIGNATURE,
          terminalGrossLamports: "1000000000",
          terminalPayoutLamports: "980000000",
          terminalFeeLamports: "20000000",
          settledAt: 1_700_000_000_300,
        },
      },
      {
        name: "terminal losing allocation",
        entry: {
          winner: "b",
          settlementState: "LOST",
          terminalKind: "CLAIM_PAYOUT",
          terminalStatus: "resolved",
          terminalWinner: "b",
          claimSignature: CLAIM_SIGNATURE,
          settledAt: 1_700_000_000_300,
        },
      },
      {
        name: "terminal loser cleanup",
        entry: {
          winner: "b",
          settlementState: "LOST",
          terminalKind: "LOSER_CLEANUP",
          terminalStatus: "resolved",
          terminalWinner: "b",
          claimSignature: CLAIM_SIGNATURE,
          settledAt: 1_700_000_000_300,
        },
      },
      {
        name: "terminal cancellation refund",
        entry: {
          marketStatus: "cancelled",
          winner: "none",
          settlementState: "REFUNDED",
          terminalKind: "CANCELLATION_REFUND",
          terminalStatus: "cancelled",
          terminalWinner: "none",
          claimSignature: REFUND_SIGNATURE,
          terminalGrossLamports: "620000000",
          terminalPayoutLamports: "620000000",
          settledAt: 1_700_000_000_300,
        },
      },
    ];

    for (const fixture of cases) {
      const candidate = payload();
      Object.assign(candidate.entries[0]!, fixture.entry);
      expect(
        parseSolanaSettlementHistoryResponse(candidate),
        fixture.name,
      ).not.toBeNull();
    }
  });

  test("rejects lifecycle and terminal-settlement contradictions", () => {
    const cases: Array<{
      name: string;
      mutate: (entry: Record<string, unknown>) => void;
    }> = [
      {
        name: "derived order state drift",
        mutate: (entry) => {
          entry.orderState = "OPEN";
        },
      },
      {
        name: "nonterminal winner before resolution",
        mutate: (entry) => {
          entry.marketStatus = "open";
          entry.winner = "a";
          entry.settlementState = "NOT_READY";
        },
      },
      {
        name: "derived settlement state drift",
        mutate: (entry) => {
          entry.settlementState = "REFUND_CLAIMABLE";
        },
      },
      {
        name: "terminal kind without terminal evidence",
        mutate: (entry) => {
          entry.terminalKind = "CLAIM_PAYOUT";
        },
      },
      {
        name: "claim signature without terminal kind",
        mutate: (entry) => {
          entry.claimSignature = CLAIM_SIGNATURE;
          entry.settledAt = 1_700_000_000_300;
        },
      },
      {
        name: "terminal value without terminal kind",
        mutate: (entry) => {
          entry.terminalGrossLamports = "1";
          entry.terminalPayoutLamports = "1";
        },
      },
      {
        name: "payout kind on a cancelled terminal",
        mutate: (entry) => {
          Object.assign(entry, {
            marketStatus: "cancelled",
            winner: "none",
            settlementState: "PAID",
            terminalKind: "CLAIM_PAYOUT",
            terminalStatus: "cancelled",
            terminalWinner: "none",
            claimSignature: CLAIM_SIGNATURE,
            terminalGrossLamports: "1000000000",
            terminalPayoutLamports: "1000000000",
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "winning payout gross does not equal matched units",
        mutate: (entry) => {
          Object.assign(entry, {
            settlementState: "PAID",
            terminalKind: "CLAIM_PAYOUT",
            terminalStatus: "resolved",
            terminalWinner: "a",
            claimSignature: CLAIM_SIGNATURE,
            terminalGrossLamports: "999999999",
            terminalPayoutLamports: "979999999",
            terminalFeeLamports: "20000000",
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "winning value assigned to the losing side",
        mutate: (entry) => {
          Object.assign(entry, {
            winner: "b",
            settlementState: "PAID",
            terminalKind: "CLAIM_PAYOUT",
            terminalStatus: "resolved",
            terminalWinner: "b",
            claimSignature: CLAIM_SIGNATURE,
            terminalGrossLamports: "1000000000",
            terminalPayoutLamports: "1000000000",
            terminalFeeLamports: "0",
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "loser cleanup assigned to the winning side",
        mutate: (entry) => {
          Object.assign(entry, {
            settlementState: "LOST",
            terminalKind: "LOSER_CLEANUP",
            terminalStatus: "resolved",
            terminalWinner: "a",
            claimSignature: CLAIM_SIGNATURE,
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "loser cleanup invents transferred value",
        mutate: (entry) => {
          Object.assign(entry, {
            winner: "b",
            settlementState: "LOST",
            terminalKind: "LOSER_CLEANUP",
            terminalStatus: "resolved",
            terminalWinner: "b",
            claimSignature: CLAIM_SIGNATURE,
            terminalGrossLamports: "1",
            terminalPayoutLamports: "1",
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "loser cleanup claims a cancelled market",
        mutate: (entry) => {
          Object.assign(entry, {
            marketStatus: "cancelled",
            winner: "none",
            settlementState: "LOST",
            terminalKind: "LOSER_CLEANUP",
            terminalStatus: "cancelled",
            terminalWinner: "none",
            claimSignature: CLAIM_SIGNATURE,
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "refund does not equal reward-eligible custody",
        mutate: (entry) => {
          Object.assign(entry, {
            marketStatus: "cancelled",
            winner: "none",
            settlementState: "REFUNDED",
            terminalKind: "CANCELLATION_REFUND",
            terminalStatus: "cancelled",
            terminalWinner: "none",
            claimSignature: REFUND_SIGNATURE,
            terminalGrossLamports: "619999999",
            terminalPayoutLamports: "619999999",
            terminalFeeLamports: "0",
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "current market contradicts terminal fact",
        mutate: (entry) => {
          Object.assign(entry, {
            settlementState: "REFUNDED",
            terminalKind: "CANCELLATION_REFUND",
            terminalStatus: "cancelled",
            terminalWinner: "none",
            claimSignature: REFUND_SIGNATURE,
            terminalGrossLamports: "620000000",
            terminalPayoutLamports: "620000000",
            settledAt: 1_700_000_000_300,
          });
        },
      },
      {
        name: "pending order refund drift",
        mutate: (entry) => {
          Object.assign(entry, {
            matchedAmountUnits: "0",
            restingAmountUnits: "1000000000",
            executedCostLamports: "0",
            tradeFeeLamports: "0",
            sourceAmountLamports: "600000000",
            rewardEligibleLamports: "0",
            marketStatus: "open",
            winner: "none",
            orderState: "PENDING_INDEX",
            settlementState: "NOT_READY",
            orderRefundLamports: "1",
            reconciledAt: null,
          });
        },
      },
      {
        name: "collateral exceeds signed limit cost",
        mutate: (entry) => {
          entry.collateralLamports = "600000001";
          entry.sourceAmountLamports = "620000001";
        },
      },
    ];

    for (const fixture of cases) {
      const candidate = payload();
      fixture.mutate(candidate.entries[0]!);
      expect(
        parseSolanaSettlementHistoryResponse(candidate),
        fixture.name,
      ).toBeNull();
    }
  });

  test("rejects conservation drift and contradictory index state", () => {
    const badSource = payload();
    badSource.entries[0]!.sourceAmountLamports = "620000001";
    expect(parseSolanaSettlementHistoryResponse(badSource)).toBeNull();

    const aboveU64 = payload();
    aboveU64.entries[0]!.orderId = "18446744073709551616";
    expect(parseSolanaSettlementHistoryResponse(aboveU64)).toBeNull();

    const oversizedInteger = payload();
    oversizedInteger.entries[0]!.orderAmountUnits = "9".repeat(100_000);
    expect(parseSolanaSettlementHistoryResponse(oversizedInteger)).toBeNull();

    const badReward = payload();
    badReward.entries[0]!.rewardEligibleLamports = "620000001";
    expect(parseSolanaSettlementHistoryResponse(badReward)).toBeNull();

    const badPending = payload();
    badPending.entries[0]!.orderState = "PENDING_INDEX";
    expect(parseSolanaSettlementHistoryResponse(badPending)).toBeNull();

    const badCorrelation = payload();
    badCorrelation.entries[0]!.correlationId = "ff".repeat(32);
    expect(parseSolanaSettlementHistoryResponse(badCorrelation)).toBeNull();

    const incompleteIdentity = payload();
    (incompleteIdentity.entries[0] as { duelKey: string | null }).duelKey =
      null;
    expect(parseSolanaSettlementHistoryResponse(incompleteIdentity)).toBeNull();

    expect(
      parseSolanaSettlementHistoryResponse({ ...payload(), asset: "USDC" }),
    ).toBeNull();
  });

  test("rejects cross-wallet and duplicate history rows", () => {
    const wrongWallet = payload();
    wrongWallet.entries[0]!.wallet = OTHER_WALLET;
    expect(parseSolanaSettlementHistoryResponse(wrongWallet)).toBeNull();

    const duplicate = payload();
    duplicate.entries.push({ ...duplicate.entries[0]! });
    duplicate.total = 2;
    expect(parseSolanaSettlementHistoryResponse(duplicate)).toBeNull();
  });

  test("rejects noncanonical Solana identities and signatures", async () => {
    expect(
      parseSolanaSettlementHistoryResponse({
        ...payload(),
        cluster: "mainnet",
      }),
    ).toBeNull();
    expect(
      parseSolanaSettlementHistoryResponse({
        ...payload(),
        programId: "not-canonical",
      }),
    ).toBeNull();
    for (const field of ["wallet", "marketPda", "placeSignature"] as const) {
      const candidate = payload();
      candidate.entries[0]![field] = "not-canonical";
      expect(parseSolanaSettlementHistoryResponse(candidate), field).toBeNull();
    }

    const badClaim = payload();
    Object.assign(badClaim.entries[0]!, {
      settlementState: "PAID",
      terminalKind: "CLAIM_PAYOUT",
      terminalStatus: "resolved",
      terminalWinner: "a",
      claimSignature: "not-canonical",
      terminalGrossLamports: "1000000000",
      terminalPayoutLamports: "1000000000",
      settledAt: 1_700_000_000_300,
    });
    expect(parseSolanaSettlementHistoryResponse(badClaim)).toBeNull();

    let fetchCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCalls += 1;
      return Response.json(payload());
    }) as typeof fetch;
    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: "not-canonical",
      }),
    ).rejects.toThrow("settlement history identity was invalid");
    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: "not-canonical",
        wallet: WALLET,
      }),
    ).rejects.toThrow("settlement history identity was invalid");
    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: WALLET,
        marketPda: "not-canonical",
      }),
    ).rejects.toThrow("settlement history identity was invalid");
    expect(fetchCalls).toBe(0);
  });

  test("rejects incoherent ledger, timestamp, and page metadata", () => {
    const currentWithoutIndex = payload();
    (
      currentWithoutIndex.ledger as { lastIndexedAt: number | null }
    ).lastIndexedAt = null;
    expect(
      parseSolanaSettlementHistoryResponse(currentWithoutIndex),
    ).toBeNull();

    const degradedWithoutReason = payload();
    degradedWithoutReason.ledger.current = false;
    expect(
      parseSolanaSettlementHistoryResponse(degradedWithoutReason),
    ).toBeNull();

    const futureIndex = payload();
    futureIndex.ledger.lastIndexedAt = futureIndex.updatedAt + 1;
    expect(parseSolanaSettlementHistoryResponse(futureIndex)).toBeNull();

    const backwardsSettlement = payload();
    (
      backwardsSettlement.entries[0]! as { settledAt: number | null }
    ).settledAt = backwardsSettlement.entries[0]!.recordedAt - 1;
    expect(
      parseSolanaSettlementHistoryResponse(backwardsSettlement),
    ).toBeNull();

    const impossiblePage = payload();
    impossiblePage.offset = 1;
    expect(parseSolanaSettlementHistoryResponse(impossiblePage)).toBeNull();
  });

  test("merges only one coherent, duplicate-free history snapshot", () => {
    const page = (input: {
      offset: number;
      total: number;
      betId: string;
      orderId: string;
      signatureSeed: number;
      current?: boolean;
    }) => {
      const candidate = payload();
      candidate.offset = input.offset;
      candidate.limit = 1;
      candidate.total = input.total;
      const ledger = candidate.ledger as {
        current: boolean;
        degradedReason: string | null;
      };
      ledger.current = input.current ?? true;
      ledger.degradedReason = ledger.current ? null : "indexer is catching up";
      Object.assign(candidate.entries[0]!, {
        betId: input.betId,
        orderId: input.orderId,
        placeSignature: signature(input.signatureSeed),
        duelKey: null,
        duelId: null,
        correlationId: null,
      });
      return parseSolanaSettlementHistoryResponse(candidate)!;
    };

    const first = page({
      offset: 0,
      total: 2,
      betId: "bet-1",
      orderId: "7",
      signatureSeed: 5,
    });
    const second = page({
      offset: 1,
      total: 2,
      betId: "bet-2",
      orderId: "8",
      signatureSeed: 8,
    });
    expect(mergeSolanaSettlementHistoryPages([first, second], 2)).toMatchObject(
      {
        total: 2,
        limit: 2,
        offset: 0,
        ledger: { current: true },
        entries: [{ betId: "bet-1" }, { betId: "bet-2" }],
      },
    );

    const duplicate = page({
      offset: 1,
      total: 2,
      betId: "bet-1",
      orderId: "8",
      signatureSeed: 8,
    });
    expect(mergeSolanaSettlementHistoryPages([first, duplicate], 2)).toBeNull();

    const changedTotal = page({
      offset: 1,
      total: 3,
      betId: "bet-2",
      orderId: "8",
      signatureSeed: 8,
    });
    expect(
      mergeSolanaSettlementHistoryPages([first, changedTotal], 2),
    ).toBeNull();

    expect(
      mergeSolanaSettlementHistoryPages(
        [first, { ...second, cluster: "testnet" }],
        2,
      ),
    ).toBeNull();
    expect(
      mergeSolanaSettlementHistoryPages(
        [first, { ...second, programId: key(9) }],
        2,
      ),
    ).toBeNull();

    const degraded = page({
      offset: 1,
      total: 2,
      betId: "bet-2",
      orderId: "8",
      signatureSeed: 8,
      current: false,
    });
    expect(mergeSolanaSettlementHistoryPages([first, degraded], 2)).toBeNull();
    expect(
      mergeSolanaSettlementHistoryPages(
        [
          first,
          {
            ...second,
            ledger: {
              ...second.ledger,
              lastIndexedAt: second.ledger.lastIndexedAt! + 1,
            },
          },
        ],
        2,
      ),
    ).toBeNull();
    expect(
      mergeSolanaSettlementHistoryPages(
        [first, { ...second, updatedAt: first.updatedAt + 5_001 }],
        2,
      ),
    ).toBeNull();
    expect(
      mergeSolanaSettlementHistoryPages(
        [first, { ...second, updatedAt: first.updatedAt - 1 }],
        2,
      ),
    ).toBeNull();
  });

  test("requests only the connected wallet and requested history page", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({ ...payload(), total: 11, offset: 10 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const history = await fetchSolanaSettlementHistory({
      cluster: "devnet",
      programId: PROGRAM_ID,
      wallet: WALLET,
      marketPda: MARKET,
      limit: 5,
      offset: 10,
    });
    expect(history.entries).toHaveLength(1);
    expect(requestedUrl).toContain(`/api/arena/settlements/${WALLET}`);
    expect(requestedUrl).toContain(`marketPda=${MARKET}`);
    expect(requestedUrl).toContain("limit=5");
    expect(requestedUrl).toContain("offset=10");
  });

  test("rejects a response for the wrong deployment, page, or market", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json({ ...payload(), programId: key(9) })) as typeof fetch;
    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: WALLET,
      }),
    ).rejects.toThrow("settlement history response was invalid");

    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: WALLET,
        marketPda: OTHER_MARKET,
        limit: 5,
        offset: 10,
      }),
    ).rejects.toThrow("settlement history response was invalid");
  });

  test("rejects replayed, future-dated, and stale-index current responses", async () => {
    const stale = payload();
    stale.updatedAt = Date.now() - 30_001;
    stale.ledger.lastIndexedAt = stale.updatedAt - 100;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json(stale)) as typeof fetch;
    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: WALLET,
      }),
    ).rejects.toThrow("settlement history response was invalid");

    const future = payload();
    future.updatedAt = Date.now() + 31_000;
    future.ledger.lastIndexedAt = future.updatedAt - 100;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json(future)) as typeof fetch;
    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: WALLET,
      }),
    ).rejects.toThrow("settlement history response was invalid");

    const staleIndex = payload();
    staleIndex.updatedAt = Date.now();
    staleIndex.ledger.lastIndexedAt = Date.now() - 30_001;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json(staleIndex)) as typeof fetch;
    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: WALLET,
      }),
    ).rejects.toThrow("settlement history response was invalid");
  });

  test("rejects invalid pagination before issuing a request", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCalls += 1;
      return new Response(JSON.stringify(payload()));
    }) as typeof fetch;

    await expect(
      fetchSolanaSettlementHistory({
        cluster: "devnet",
        programId: PROGRAM_ID,
        wallet: WALLET,
        limit: 101,
      }),
    ).rejects.toThrow("settlement history pagination was invalid");
    expect(fetchCalls).toBe(0);
  });
});
