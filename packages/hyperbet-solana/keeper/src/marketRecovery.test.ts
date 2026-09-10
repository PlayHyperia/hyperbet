import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  DUEL_WINNER_MARKET_KIND,
  findDuelStatePda,
  findMarketPda,
  findOrderPda,
  SIDE_ASK,
  SIDE_BID,
} from "./launchCommon";
import {
  discoverDuelMarketRecovery,
  planManagedOrderClosure,
  type DuelMarketRecoveryInput,
  type ProgramAccountSnapshot,
} from "./marketRecovery";
import { buildDuelCancellationMetadata } from "./duelTerminalPolicy";

const fightProgramId = Keypair.generate().publicKey;
const marketProgramId = Keypair.generate().publicKey;
const marketAuthority = Keypair.generate().publicKey;
const marketMaker = Keypair.generate().publicKey;
const duelKeyHex = "42".repeat(32);
const duelKey = Buffer.from(duelKeyHex, "hex");
const duelState = findDuelStatePda(fightProgramId, duelKey);
const marketState = findMarketPda(
  marketProgramId,
  duelState,
  DUEL_WINNER_MARKET_KIND,
);
const expectedFees = {
  tradeTreasuryFeeBps: 100,
  tradeMarketMakerFeeBps: 100,
  winningsMarketMakerFeeBps: 200,
};

function duelSnapshot(
  account: Record<string, unknown> = {},
  publicKey = duelState,
): ProgramAccountSnapshot {
  return {
    publicKey,
    account: {
      duelKey: [...duelKey],
      status: { bettingOpen: {} },
      winner: { none: {} },
      betOpenTs: 1_700_000_000,
      metadataUri: JSON.stringify({ duelId: "duel-42", duelKeyHex }),
      ...account,
    },
  };
}

function marketSnapshot(
  account: Record<string, unknown> = {},
  publicKey = marketState,
): ProgramAccountSnapshot {
  return {
    publicKey,
    account: {
      duelState,
      duelKey: [...duelKey],
      marketKind: DUEL_WINNER_MARKET_KIND,
      status: { open: {} },
      winner: { none: {} },
      authority: marketAuthority,
      marketMaker,
      tradeTreasuryFeeBpsSnapshot: expectedFees.tradeTreasuryFeeBps,
      tradeMarketMakerFeeBpsSnapshot: expectedFees.tradeMarketMakerFeeBps,
      winningsMarketMakerFeeBpsSnapshot: expectedFees.winningsMarketMakerFeeBps,
      ...account,
    },
  };
}

function orderSnapshot(
  orderId: number,
  side: number,
  price: number,
  account: Record<string, unknown> = {},
  publicKey = findOrderPda(marketProgramId, marketState, BigInt(orderId)),
): ProgramAccountSnapshot {
  return {
    publicKey,
    account: {
      marketState,
      id: orderId,
      side,
      price,
      maker: marketMaker,
      amount: 1_000_000,
      filled: 250_000,
      active: true,
      ...account,
    },
  };
}

function input(
  overrides: Partial<DuelMarketRecoveryInput> = {},
): DuelMarketRecoveryInput {
  return {
    fightProgramId,
    marketProgramId,
    duelAccounts: [duelSnapshot()],
    marketAccounts: [marketSnapshot()],
    orderAccounts: [],
    allowedMarketAuthorities: [marketAuthority],
    marketMaker,
    expectedFees,
    observedAt: 1_800_000_000_000,
    ...overrides,
  };
}

describe("on-chain duel market recovery", () => {
  test("recovers a canonical market and every active managed order deterministically", () => {
    const result = discoverDuelMarketRecovery(
      input({
        orderAccounts: [
          orderSnapshot(9, SIDE_ASK, 600),
          orderSnapshot(8, SIDE_BID, 400),
          orderSnapshot(10, SIDE_BID, 350, { active: false }),
        ],
      }),
    );

    expect(result.issues).toEqual([]);
    expect(result.markets).toHaveLength(1);
    expect(result.markets[0]).toMatchObject({
      duelId: "duel-42",
      duelKeyHex,
      duelState,
      marketState,
      oracleStatus: "bettingOpen",
      marketStatus: "open",
      winner: "NONE",
      createdAtMs: 1_700_000_000_000,
    });
    expect(result.markets[0]?.managedOrders).toEqual([
      {
        orderId: 8,
        side: SIDE_BID,
        price: 400,
        amountLamports: 750_000,
        placedAtMs: 1_800_000_000_000,
      },
      {
        orderId: 9,
        side: SIDE_ASK,
        price: 600,
        amountLamports: 750_000,
        placedAtMs: 1_800_000_000_000,
      },
    ]);
  });

  test.each([
    [
      "market authority",
      { authority: Keypair.generate().publicKey },
      "market authority mismatch",
    ],
    [
      "market maker",
      { marketMaker: Keypair.generate().publicKey },
      "market maker mismatch",
    ],
    [
      "fee policy",
      { winningsMarketMakerFeeBpsSnapshot: 201 },
      "fee snapshot mismatch",
    ],
  ])("quarantines a market with the wrong %s", (_label, mutation, detail) => {
    const result = discoverDuelMarketRecovery(
      input({ marketAccounts: [marketSnapshot(mutation)] }),
    );

    expect(result.markets).toEqual([]);
    expect(result.issues.some((entry) => entry.details.includes(detail))).toBe(
      true,
    );
    expect(result.issues.some((entry) => entry.code === "missing-market")).toBe(
      true,
    );
  });

  test("rejects duel and market accounts that are not their canonical PDAs", () => {
    const wrongDuel = Keypair.generate().publicKey;
    const wrongMarket = Keypair.generate().publicKey;
    const result = discoverDuelMarketRecovery(
      input({
        duelAccounts: [duelSnapshot({}, wrongDuel)],
        marketAccounts: [marketSnapshot({}, wrongMarket)],
      }),
    );

    expect(result.markets).toEqual([]);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "invalid-duel-account",
    );
    expect(result.issues.map((entry) => entry.code)).toContain(
      "invalid-market-account",
    );
  });

  test("requires metadata to bind the duel ID to the exact duel key", () => {
    const result = discoverDuelMarketRecovery(
      input({
        duelAccounts: [
          duelSnapshot({
            metadataUri: JSON.stringify({
              duelId: "duel-42",
              duelKeyHex: "99".repeat(32),
            }),
          }),
        ],
      }),
    );

    expect(result.markets).toEqual([]);
    expect(
      result.issues.some(
        (entry) =>
          entry.code === "invalid-market-account" &&
          entry.details.includes("missing canonical duelId metadata"),
      ),
    ).toBe(true);
  });

  test("recovers an exact duel ID and key from versioned compact cancellation metadata", () => {
    const duelId = "streaming-580e9afa-4376-4131-9ea5-65e68d81fe53";
    const result = discoverDuelMarketRecovery(
      input({
        duelAccounts: [
          duelSnapshot({
            status: { cancelled: {} },
            metadataUri: buildDuelCancellationMetadata({
              duelId,
              duelKey: duelKeyHex,
              outcome: "cancelled",
              reason: "competitive_snapshot_recovery_window_elapsed",
            }),
          }),
        ],
        marketAccounts: [marketSnapshot({ status: { cancelled: {} } })],
      }),
    );

    expect(result.issues).toEqual([]);
    expect(result.markets).toEqual([
      expect.objectContaining({ duelId, duelKeyHex }),
    ]);
  });

  test("reports every non-scheduled canonical duel with no valid market", () => {
    const result = discoverDuelMarketRecovery(input({ marketAccounts: [] }));

    expect(result.markets).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "missing-market",
        duelRef: duelState.toBase58(),
      }),
    ]);
  });

  test("recovers status drift for fail-closed lifecycle synchronization", () => {
    const result = discoverDuelMarketRecovery(
      input({
        duelAccounts: [duelSnapshot({ status: { locked: {} } })],
        marketAccounts: [marketSnapshot({ status: { open: {} } })],
      }),
    );

    expect(result.markets).toHaveLength(1);
    expect(result.markets[0]).toMatchObject({
      oracleStatus: "locked",
      marketStatus: "open",
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "market-status-drift" }),
    ]);
  });

  test("recovers only lifecycle-consistent terminal winners", () => {
    const recovered = discoverDuelMarketRecovery(
      input({
        duelAccounts: [
          duelSnapshot({ status: { resolved: {} }, winner: { a: {} } }),
        ],
        marketAccounts: [
          marketSnapshot({ status: { resolved: {} }, winner: { a: {} } }),
        ],
      }),
    );
    expect(recovered.issues).toEqual([]);
    expect(recovered.markets[0]?.winner).toBe("A");

    const quarantined = discoverDuelMarketRecovery(
      input({
        duelAccounts: [
          duelSnapshot({ status: { resolved: {} }, winner: { a: {} } }),
        ],
        marketAccounts: [
          marketSnapshot({ status: { resolved: {} }, winner: { b: {} } }),
        ],
      }),
    );
    expect(quarantined.markets).toEqual([]);
    expect(
      quarantined.issues.some((entry) =>
        entry.details.includes("market winner mismatch"),
      ),
    ).toBe(true);
  });

  test("rejects an oracle winner that contradicts its lifecycle", () => {
    const result = discoverDuelMarketRecovery(
      input({ duelAccounts: [duelSnapshot({ winner: { a: {} } })] }),
    );

    expect(result.markets).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "invalid-duel-account" }),
    );
  });

  test("quarantines malformed active managed orders while ignoring inactive history", () => {
    const result = discoverDuelMarketRecovery(
      input({
        orderAccounts: [
          orderSnapshot(12, SIDE_BID, 400, {}, Keypair.generate().publicKey),
          orderSnapshot(
            13,
            SIDE_ASK,
            600,
            { active: false },
            Keypair.generate().publicKey,
          ),
        ],
      }),
    );

    expect(result.markets[0]?.managedOrders).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "invalid-managed-order" }),
    ]);
  });

  test("rejects active orders belonging to an unknown market", () => {
    const unknownMarket = Keypair.generate().publicKey;
    const result = discoverDuelMarketRecovery(
      input({
        orderAccounts: [
          orderSnapshot(
            14,
            SIDE_BID,
            400,
            { marketState: unknownMarket },
            findOrderPda(marketProgramId, unknownMarket, 14n),
          ),
        ],
      }),
    );

    expect(result.markets[0]?.managedOrders).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "invalid-managed-order",
        marketRef: unknownMarket.toBase58(),
      }),
    ]);
  });
});

describe("managed order closure planning", () => {
  test("cancels open-market orders with neighbors in contract order", () => {
    expect(
      planManagedOrderClosure({
        marketIsOpen: true,
        orderId: 8,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 7,
        nextOrderId: 9,
        priceLevelHeadOrderId: 7,
        priceLevelTailOrderId: 9,
        priceLevelTotalOpen: 3_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "cancel", adjacentOrderIds: [7, 9] });
  });

  test("reclaims locked or terminal-market orders", () => {
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 8,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 0,
        nextOrderId: 9,
        priceLevelHeadOrderId: 8,
        priceLevelTailOrderId: 9,
        priceLevelTotalOpen: 2_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [9] });
  });

  test("plans nonmonotonic continued-order links from reciprocal queue position", () => {
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 52,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 54,
        nextOrderId: 0,
        priceLevelHeadOrderId: 54,
        priceLevelTailOrderId: 52,
        priceLevelTotalOpen: 2_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [54] });
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 54,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 0,
        nextOrderId: 52,
        priceLevelHeadOrderId: 54,
        priceLevelTailOrderId: 52,
        priceLevelTotalOpen: 2_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [52] });
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 52,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 54,
        nextOrderId: 0,
        priceLevelHeadOrderId: 52,
        priceLevelTailOrderId: 52,
        priceLevelTotalOpen: 1_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [] });
  });

  test("fails closed on corrupt links and omits links only for continuations", () => {
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 8,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 0,
        nextOrderId: 0,
        priceLevelHeadOrderId: 0,
        priceLevelTailOrderId: 0,
        priceLevelTotalOpen: 0,
        continuationPending: true,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [] });
    expect(() =>
      planManagedOrderClosure({
        marketIsOpen: true,
        orderId: 8,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 8,
        nextOrderId: 0,
        priceLevelHeadOrderId: 8,
        priceLevelTailOrderId: 8,
        priceLevelTotalOpen: 1_000,
        continuationPending: false,
      }),
    ).toThrow("invalid adjacent book links");
    expect(() =>
      planManagedOrderClosure({
        marketIsOpen: true,
        orderId: 8,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 7,
        nextOrderId: 0,
        priceLevelHeadOrderId: 0,
        priceLevelTailOrderId: 0,
        priceLevelTotalOpen: 0,
        continuationPending: true,
      }),
    ).toThrow("unexpected book links");
  });
});
