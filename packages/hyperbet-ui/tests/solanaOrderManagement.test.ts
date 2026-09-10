import { describe, expect, it } from "bun:test";

import {
  assertSolanaManagedOrderBookLinks,
  buildSolanaManagedOrderPlan as buildSolanaManagedOrderPlanWithRent,
  normalizeSolanaManagedOrderPlanForPriceLevel,
  resolveSolanaManagedPriceLevelForClosure,
  sameSolanaManagedOrderQuote,
  selectPresentableSolanaManagedOrders,
  shouldCloseEmptySolanaUserBalance,
  type SolanaManagedOrderSnapshot,
} from "../src/lib/solanaOrderManagement";

const MARKET = "Market1111111111111111111111111111111111111";
const WALLET = "Wallet1111111111111111111111111111111111111";
const ORDER_RENT_LAMPORTS = 1_719n;

function order(
  overrides: Partial<SolanaManagedOrderSnapshot> = {},
): SolanaManagedOrderSnapshot {
  return {
    marketState: MARKET,
    id: 7n,
    side: 1,
    price: 600,
    orderBehavior: 0,
    maker: WALLET,
    amount: 2_000n,
    filled: 1_000n,
    previousOrderId: 6n,
    nextOrderId: 8n,
    active: true,
    continuationPending: false,
    ...overrides,
  };
}

function buildSolanaManagedOrderPlan(
  input: Omit<
    Parameters<typeof buildSolanaManagedOrderPlanWithRent>[0],
    "orderAccountLamports"
  > & { orderAccountLamports?: bigint },
) {
  return buildSolanaManagedOrderPlanWithRent({
    ...input,
    orderAccountLamports: input.orderAccountLamports ?? ORDER_RENT_LAMPORTS,
  });
}

describe("Solana managed-order planning", () => {
  it("closes only an exact empty user balance after matching stops", () => {
    const emptyBalance = {
      aShares: 0n,
      bShares: 0n,
      aLockedLamports: 0n,
      bLockedLamports: 0n,
      tradeTreasuryFeeLamports: 0n,
      tradeMarketMakerFeeLamports: 0n,
    };
    expect(
      shouldCloseEmptySolanaUserBalance({
        marketStatus: "locked",
        balance: emptyBalance,
      }),
    ).toBe(true);
    expect(
      shouldCloseEmptySolanaUserBalance({
        marketStatus: "open",
        balance: emptyBalance,
      }),
    ).toBe(false);
    for (const field of Object.keys(emptyBalance) as Array<
      keyof typeof emptyBalance
    >) {
      expect(
        shouldCloseEmptySolanaUserBalance({
          marketStatus: "cancelled",
          balance: { ...emptyBalance, [field]: 1n },
        }),
      ).toBe(false);
    }
    expect(() =>
      shouldCloseEmptySolanaUserBalance({
        marketStatus: "resolved",
        balance: { ...emptyBalance, aLockedLamports: -1n },
      }),
    ).toThrow("invalid custody");
  });

  it("plans an exact open-market cancellation with neighbors in program order", () => {
    expect(
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order(),
      }),
    ).toEqual({
      action: "CANCEL",
      marketState: MARKET,
      orderId: 7n,
      side: 1,
      outcomeSide: "YES",
      outcomePriceMillis: 600,
      programPriceMillis: 600,
      originalUnits: 2_000n,
      filledUnits: 1_000n,
      remainingUnits: 1_000n,
      refundableCollateralLamports: 600n,
      returnedOrderAccountRentLamports: ORDER_RENT_LAMPORTS,
      grossWalletCreditLamports: 2_319n,
      previousOrderId: 6n,
      nextOrderId: 8n,
      adjacentOrderIds: [6n, 8n],
      continuationPending: false,
    });
  });

  it("plans and validates queue links independently of global order IDs", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "locked",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        id: 7n,
        previousOrderId: 9n,
        nextOrderId: 5n,
      }),
    });
    expect(plan).toMatchObject({
      action: "RECLAIM",
      orderId: 7n,
      previousOrderId: 9n,
      nextOrderId: 5n,
      adjacentOrderIds: [9n, 5n],
    });
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan,
        priceLevel: {
          marketState: MARKET,
          side: 1,
          price: 600,
          headOrderId: 9n,
          tailOrderId: 5n,
          totalOpen: 3_000n,
        },
        adjacentOrders: [
          order({
            id: 9n,
            previousOrderId: 0n,
            nextOrderId: 7n,
          }),
          order({
            id: 5n,
            previousOrderId: 7n,
            nextOrderId: 0n,
          }),
        ],
      }),
    ).not.toThrow();
  });

  it("routes non-open ask orders to reclaim using the complementary price", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "resolved",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        side: 2,
        price: 650,
        amount: 2_000n,
        filled: 1_000n,
      }),
    });
    expect(plan.action).toBe("RECLAIM");
    expect(plan.outcomeSide).toBe("NO");
    expect(plan.outcomePriceMillis).toBe(350);
    expect(plan.refundableCollateralLamports).toBe(350n);
  });

  it("supports continuation-pending orders without linked book accounts", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "locked",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        previousOrderId: 0n,
        nextOrderId: 0n,
        filled: 0n,
        continuationPending: true,
      }),
    });
    expect(plan.action).toBe("RECLAIM");
    expect(plan.adjacentOrderIds).toEqual([]);
  });

  it("reconstructs only a missing continuation level for atomic closure", () => {
    const pendingPlan = buildSolanaManagedOrderPlan({
      marketStatus: "locked",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        previousOrderId: 0n,
        nextOrderId: 0n,
        filled: 0n,
        continuationPending: true,
      }),
    });
    expect(
      resolveSolanaManagedPriceLevelForClosure({
        plan: pendingPlan,
        priceLevel: null,
      }),
    ).toEqual({
      marketState: MARKET,
      side: 1,
      price: 600,
      headOrderId: 0n,
      tailOrderId: 0n,
      totalOpen: 0n,
    });

    const restingPlan = buildSolanaManagedOrderPlan({
      marketStatus: "locked",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    expect(() =>
      resolveSolanaManagedPriceLevelForClosure({
        plan: restingPlan,
        priceLevel: null,
      }),
    ).toThrow("price level no longer exists");
  });

  it("plans maker-only rent cleanup for an inactive fully filled order in any lifecycle", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "unknown",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        active: false,
        filled: 2_000n,
        previousOrderId: 0n,
        nextOrderId: 0n,
      }),
    });
    expect(plan).toMatchObject({
      action: "CLOSE_FILLED",
      remainingUnits: 0n,
      refundableCollateralLamports: 0n,
      returnedOrderAccountRentLamports: ORDER_RENT_LAMPORTS,
      grossWalletCreditLamports: ORDER_RENT_LAMPORTS,
      adjacentOrderIds: [],
    });
  });

  it("defers filled-order rent until a terminal market has no primary settlement", () => {
    const filled = buildSolanaManagedOrderPlan({
      marketStatus: "resolved",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        active: false,
        filled: 2_000n,
        previousOrderId: 0n,
        nextOrderId: 0n,
      }),
    });
    const reclaim = buildSolanaManagedOrderPlan({
      marketStatus: "resolved",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });

    expect(
      selectPresentableSolanaManagedOrders({
        orders: [filled, reclaim],
        lifecycleStatus: "LOCKED",
        primarySettlementRequired: false,
      }),
    ).toEqual([reclaim]);
    expect(
      selectPresentableSolanaManagedOrders({
        orders: [filled, reclaim],
        lifecycleStatus: "RESOLVED",
        primarySettlementRequired: true,
      }),
    ).toEqual([reclaim]);
    expect(
      selectPresentableSolanaManagedOrders({
        orders: [filled, reclaim],
        lifecycleStatus: "RESOLVED",
        primarySettlementRequired: false,
      }),
    ).toEqual([filled, reclaim]);
  });

  it("rejects ownership, market, lifecycle, and inactive-order drift", () => {
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: "DifferentWallet",
        order: order(),
      }),
    ).toThrow("Only the order maker");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: "DifferentMarket",
        wallet: WALLET,
        order: order(),
      }),
    ).toThrow("active market");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "unknown",
        marketState: MARKET,
        wallet: WALLET,
        order: order(),
      }),
    ).toThrow("not safe");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({ active: false }),
      }),
    ).toThrow("Inactive order is not fully filled");
  });

  it("rejects noncanonical IDs, order/fill lots, and imprecise remainder states", () => {
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({ id: 0n }),
      }),
    ).toThrow("must be positive");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order(),
        orderAccountLamports: 0n,
      }),
    ).toThrow("positive lamport");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({ filled: 2_000n }),
      }),
    ).toThrow("no remaining amount");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({ previousOrderId: 7n }),
      }),
    ).toThrow("invalid linked-list");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({ amount: 2_001n }),
      }),
    ).toThrow("1,000-unit lots");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({ filled: 500n }),
      }),
    ).toThrow("1,000-unit lots");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({
          previousOrderId: 0n,
          nextOrderId: 0n,
          continuationPending: true,
        }),
      }),
    ).toThrow("cannot retain a filled amount");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({
          active: false,
          filled: 2_000n,
          previousOrderId: 6n,
          nextOrderId: 0n,
        }),
      }),
    ).toThrow("still linked");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({ orderBehavior: 1 }),
      }),
    ).toThrow("resting GTC or post-only");
    expect(() =>
      buildSolanaManagedOrderPlan({
        marketStatus: "open",
        marketState: MARKET,
        wallet: WALLET,
        order: order({
          orderBehavior: 2,
          continuationPending: true,
          previousOrderId: 0n,
          nextOrderId: 0n,
        }),
      }),
    ).toThrow("must be GTC");
  });

  it("detects any user-visible or account-graph change before signature", () => {
    const original = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    const unchanged = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    const partiallyFilled = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order({ filled: 0n }),
    });
    const locked = buildSolanaManagedOrderPlan({
      marketStatus: "locked",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    const rentChanged = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
      orderAccountLamports: ORDER_RENT_LAMPORTS + 1n,
    });
    expect(sameSolanaManagedOrderQuote(original, unchanged)).toBe(true);
    expect(sameSolanaManagedOrderQuote(original, partiallyFilled)).toBe(false);
    expect(sameSolanaManagedOrderQuote(original, locked)).toBe(false);
    expect(sameSolanaManagedOrderQuote(original, rentChanged)).toBe(false);
  });

  it("validates the complete linked price level before mutation", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan,
        priceLevel: {
          marketState: MARKET,
          side: 1,
          price: 600,
          headOrderId: 6n,
          tailOrderId: 8n,
          totalOpen: 3_000n,
        },
        adjacentOrders: [
          order({ id: 6n, previousOrderId: 0n, nextOrderId: 7n }),
          order({ id: 8n, previousOrderId: 7n, nextOrderId: 0n }),
        ],
      }),
    ).not.toThrow();
  });

  it("enforces exact single-order and strict multi-order conservation", () => {
    const singlePlan = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order({ previousOrderId: 0n, nextOrderId: 0n }),
    });
    const singleLevel = {
      marketState: MARKET,
      side: 1 as const,
      price: 600,
      headOrderId: 7n,
      tailOrderId: 7n,
      totalOpen: 1_000n,
    };
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: singlePlan,
        priceLevel: singleLevel,
        adjacentOrders: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: singlePlan,
        priceLevel: { ...singleLevel, totalOpen: 2_000n },
        adjacentOrders: [],
      }),
    ).toThrow("Single-order");

    const multiplePlan = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    const adjacentOrders = [
      order({ id: 6n, previousOrderId: 0n, nextOrderId: 7n }),
      order({ id: 8n, previousOrderId: 7n, nextOrderId: 0n }),
    ];
    const multipleLevel = {
      marketState: MARKET,
      side: 1 as const,
      price: 600,
      headOrderId: 6n,
      tailOrderId: 8n,
      totalOpen: 3_000n,
    };
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: multiplePlan,
        priceLevel: multipleLevel,
        adjacentOrders,
      }),
    ).not.toThrow();
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: multiplePlan,
        priceLevel: { ...multipleLevel, totalOpen: 1_000n },
        adjacentOrders,
      }),
    ).toThrow("Multi-order");
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: multiplePlan,
        priceLevel: { ...multipleLevel, headOrderId: 0n },
        adjacentOrders,
      }),
    ).toThrow("partially empty");
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: multiplePlan,
        priceLevel: { ...multipleLevel, totalOpen: 2_500n },
        adjacentOrders,
      }),
    ).toThrow("1,000-unit lots");
  });

  it("rejects nonresting, exhausted, or self-linked adjacent orders", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "locked",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    const priceLevel = {
      marketState: MARKET,
      side: 1 as const,
      price: 600,
      headOrderId: 6n,
      tailOrderId: 8n,
      totalOpen: 3_000n,
    };
    const validPrevious = order({
      id: 6n,
      previousOrderId: 0n,
      nextOrderId: 7n,
    });
    const validNext = order({
      id: 8n,
      previousOrderId: 7n,
      nextOrderId: 0n,
    });

    for (const invalidPrevious of [
      { ...validPrevious, orderBehavior: 1 as const },
      { ...validPrevious, filled: validPrevious.amount },
      { ...validPrevious, filled: 500n },
      { ...validPrevious, previousOrderId: validPrevious.id },
      { ...validPrevious, nextOrderId: validPrevious.id },
    ]) {
      expect(() =>
        assertSolanaManagedOrderBookLinks({
          plan,
          priceLevel,
          adjacentOrders: [invalidPrevious, validNext],
        }),
      ).toThrow("linked order account");
    }
  });

  it("omits only a matched-out predecessor from the canonical head instruction", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    const normalized = normalizeSolanaManagedOrderPlanForPriceLevel({
      plan,
      priceLevel: {
        marketState: MARKET,
        side: 1,
        price: 600,
        headOrderId: 7n,
        tailOrderId: 8n,
        totalOpen: 3_000n,
      },
    });
    expect(normalized).toMatchObject({
      previousOrderId: 0n,
      nextOrderId: 8n,
      adjacentOrderIds: [8n],
    });
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: normalized,
        priceLevel: {
          marketState: MARKET,
          side: 1,
          price: 600,
          headOrderId: 7n,
          tailOrderId: 8n,
          totalOpen: 3_000n,
        },
        adjacentOrders: [
          order({ id: 8n, previousOrderId: 7n, nextOrderId: 0n }),
        ],
      }),
    ).not.toThrow();
  });

  it("normalizes a newer stale predecessor from an older canonical head", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "cancelled",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        id: 7n,
        previousOrderId: 9n,
        nextOrderId: 0n,
      }),
    });
    const priceLevel = {
      marketState: MARKET,
      side: 1 as const,
      price: 600,
      headOrderId: 7n,
      tailOrderId: 7n,
      totalOpen: 1_000n,
    };
    const normalized = normalizeSolanaManagedOrderPlanForPriceLevel({
      plan,
      priceLevel,
    });
    expect(normalized).toMatchObject({
      previousOrderId: 0n,
      nextOrderId: 0n,
      adjacentOrderIds: [],
    });
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: normalized,
        priceLevel,
        adjacentOrders: [],
      }),
    ).not.toThrow();
  });

  it("fails closed when a price-level boundary or neighbor link drifts", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order(),
    });
    const headPlan = buildSolanaManagedOrderPlan({
      marketStatus: "open",
      marketState: MARKET,
      wallet: WALLET,
      order: order({ previousOrderId: 0n }),
    });
    const priceLevel = {
      marketState: MARKET,
      side: 1 as const,
      price: 600,
      headOrderId: 6n,
      tailOrderId: 8n,
      totalOpen: 3_000n,
    };
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan: headPlan,
        priceLevel,
        adjacentOrders: [order({ id: 8n, previousOrderId: 7n })],
      }),
    ).toThrow("head");
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan,
        priceLevel,
        adjacentOrders: [
          order({ id: 6n, previousOrderId: 0n, nextOrderId: 8n }),
          order({ id: 8n, previousOrderId: 7n, nextOrderId: 0n }),
        ],
      }),
    ).toThrow("Previous order");
  });

  it("accepts a continuation-pending order without linked accounts", () => {
    const plan = buildSolanaManagedOrderPlan({
      marketStatus: "locked",
      marketState: MARKET,
      wallet: WALLET,
      order: order({
        previousOrderId: 0n,
        nextOrderId: 0n,
        filled: 0n,
        continuationPending: true,
      }),
    });
    expect(() =>
      assertSolanaManagedOrderBookLinks({
        plan,
        priceLevel: {
          marketState: MARKET,
          side: 1,
          price: 600,
          headOrderId: 0n,
          tailOrderId: 0n,
          totalOpen: 0n,
        },
        adjacentOrders: [],
      }),
    ).not.toThrow();
  });
});
