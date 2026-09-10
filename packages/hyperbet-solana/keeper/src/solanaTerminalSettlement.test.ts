import { describe, expect, test } from "bun:test";
import bs58 from "bs58";

import type { SolanaLifecycleFact } from "./solanaLifecycleIndexer";
import type {
  BetExecutionBaseline,
  IndexedLifecycleFact,
} from "./solanaBetReconciliation";
import { reconcileWalletMarketTerminalSettlements } from "./solanaTerminalSettlement";

const key = (seed: number) => bs58.encode(Buffer.alloc(32, seed));
const signature = (seed: number) => bs58.encode(Buffer.alloc(64, seed));

function envelope(
  signatureSeed: number,
  factIndex: number,
  fact: SolanaLifecycleFact,
): IndexedLifecycleFact {
  let canonicalFact = fact;
  if (fact.kind === "ORDER_PLACED") {
    canonicalFact = {
      ...fact,
      orderBehavior: fact.orderBehavior ?? 0,
    };
  } else if (fact.kind === "TAKER_EXECUTION") {
    const totalFee = BigInt(fact.feeLamports ?? "0");
    const treasuryFee =
      fact.treasuryFeeLamports === undefined
        ? totalFee / 2n
        : BigInt(fact.treasuryFeeLamports);
    const marketMakerFee =
      fact.marketMakerFeeLamports === undefined
        ? totalFee - treasuryFee
        : BigInt(fact.marketMakerFeeLamports);
    canonicalFact = {
      ...fact,
      treasuryFeeLamports: treasuryFee.toString(),
      marketMakerFeeLamports: marketMakerFee.toString(),
      selfTradeTriggered: fact.selfTradeTriggered ?? false,
    };
  }
  return {
    signature: signature(signatureSeed),
    factIndex,
    fact: canonicalFact,
  };
}

function baseline(input: {
  betId: string;
  signatureSeed: number;
  marketPda: string;
  wallet: string;
  orderId: string;
  side: 1 | 2;
  limitPrice: number;
  orderAmountUnits: string;
}): BetExecutionBaseline {
  return {
    betId: input.betId,
    txSignature: signature(input.signatureSeed),
    marketPda: input.marketPda,
    wallet: input.wallet,
    orderId: input.orderId,
    side: input.side,
    limitPrice: input.limitPrice,
    orderAmountUnits: input.orderAmountUnits,
    initialMatchedAmountUnits: "0",
    initialRestingAmountUnits: input.orderAmountUnits,
    initialReleasedAmountUnits: "0",
    initialCollateralLamports: "0",
    initialExecutedCostLamports: "0",
    initialTradeFeeLamports: "0",
    initialRewardEligibleLamports: "0",
  };
}

function resolvedFacts(): {
  marketPda: string;
  wallet: string;
  facts: IndexedLifecycleFact[];
} {
  const marketPda = key(1);
  const wallet = key(2);
  const counterpart = key(3);
  const placements: Array<{
    orderId: string;
    wallet: string;
    side: 1 | 2;
    price: number;
    amountUnits: string;
    signatureSeed: number;
  }> = [
    {
      orderId: "1",
      wallet,
      side: 1,
      price: 600,
      amountUnits: "3000",
      signatureSeed: 11,
    },
    {
      orderId: "2",
      wallet,
      side: 1,
      price: 600,
      amountUnits: "2000",
      signatureSeed: 12,
    },
    {
      orderId: "3",
      wallet,
      side: 2,
      price: 400,
      amountUnits: "4000",
      signatureSeed: 13,
    },
    {
      orderId: "4",
      wallet,
      side: 1,
      price: 550,
      amountUnits: "1000",
      signatureSeed: 14,
    },
    {
      orderId: "11",
      wallet: counterpart,
      side: 2,
      price: 400,
      amountUnits: "3000",
      signatureSeed: 21,
    },
    {
      orderId: "12",
      wallet: counterpart,
      side: 2,
      price: 500,
      amountUnits: "2000",
      signatureSeed: 22,
    },
    {
      orderId: "13",
      wallet: counterpart,
      side: 1,
      price: 500,
      amountUnits: "4000",
      signatureSeed: 23,
    },
    {
      orderId: "14",
      wallet: counterpart,
      side: 2,
      price: 400,
      amountUnits: "1000",
      signatureSeed: 24,
    },
  ];
  const facts = placements.map((placement, index) =>
    envelope(placement.signatureSeed, index, {
      kind: "ORDER_PLACED",
      marketPda,
      orderId: placement.orderId,
      wallet: placement.wallet,
      side: placement.side,
      price: placement.price,
      amountUnits: placement.amountUnits,
    }),
  );
  facts.push(
    envelope(31, 0, {
      kind: "ORDER_MATCHED",
      marketPda,
      makerOrderId: "1",
      takerOrderId: "11",
      price: 600,
      amountUnits: "3000",
    }),
    envelope(31, 1, {
      kind: "TAKER_EXECUTION",
      marketPda,
      orderId: "11",
      wallet: counterpart,
      side: 2,
      price: 400,
      amountUnits: "3000",
      releasedAmountUnits: "0",
      amountLamports: "1200",
      feeLamports: "0",
      refundLamports: "0",
    }),
    envelope(32, 0, {
      kind: "ORDER_MATCHED",
      marketPda,
      makerOrderId: "12",
      takerOrderId: "2",
      price: 500,
      amountUnits: "2000",
    }),
    envelope(32, 1, {
      kind: "TAKER_EXECUTION",
      marketPda,
      orderId: "2",
      wallet,
      side: 1,
      price: 600,
      amountUnits: "2000",
      releasedAmountUnits: "0",
      amountLamports: "1000",
      feeLamports: "0",
      refundLamports: "0",
    }),
    envelope(33, 0, {
      kind: "ORDER_MATCHED",
      marketPda,
      makerOrderId: "3",
      takerOrderId: "13",
      price: 400,
      amountUnits: "4000",
    }),
    envelope(33, 1, {
      kind: "TAKER_EXECUTION",
      marketPda,
      orderId: "13",
      wallet: counterpart,
      side: 1,
      price: 500,
      amountUnits: "4000",
      releasedAmountUnits: "0",
      amountLamports: "1600",
      feeLamports: "0",
      refundLamports: "0",
    }),
    envelope(34, 0, {
      kind: "ORDER_MATCHED",
      marketPda,
      makerOrderId: "4",
      takerOrderId: "14",
      price: 550,
      amountUnits: "1000",
    }),
    envelope(34, 1, {
      kind: "TAKER_EXECUTION",
      marketPda,
      orderId: "14",
      wallet: counterpart,
      side: 2,
      price: 400,
      amountUnits: "1000",
      releasedAmountUnits: "0",
      amountLamports: "450",
      feeLamports: "0",
      refundLamports: "0",
    }),
    envelope(40, 0, {
      kind: "CLAIM_PAYOUT",
      marketPda,
      wallet,
      amountLamports: "5999",
      feeLamports: "1",
      status: "resolved",
      winner: "a",
    }),
  );
  return { marketPda, wallet, facts };
}

describe("wallet-market terminal settlement reconciliation", () => {
  test("allocates one resolved claim across recorded and untracked orders", () => {
    const fixture = resolvedFacts();
    const settlements = reconcileWalletMarketTerminalSettlements({
      facts: fixture.facts,
      recordedBets: [
        baseline({
          betId: "winner-maker",
          signatureSeed: 11,
          marketPda: fixture.marketPda,
          wallet: fixture.wallet,
          orderId: "1",
          side: 1,
          limitPrice: 600,
          orderAmountUnits: "3000",
        }),
        baseline({
          betId: "winner-taker",
          signatureSeed: 12,
          marketPda: fixture.marketPda,
          wallet: fixture.wallet,
          orderId: "2",
          side: 1,
          limitPrice: 600,
          orderAmountUnits: "2000",
        }),
        baseline({
          betId: "loser",
          signatureSeed: 13,
          marketPda: fixture.marketPda,
          wallet: fixture.wallet,
          orderId: "3",
          side: 2,
          limitPrice: 400,
          orderAmountUnits: "4000",
        }),
      ],
    });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      claimSignature: signature(40),
      kind: "CLAIM_PAYOUT",
      grossEntitlementLamports: "6000",
      payoutLamports: "5999",
      feeLamports: "1",
      eligibleOrderCount: 3,
      recordedBetCount: 3,
      allocations: [
        {
          betId: "winner-maker",
          matchedAmountUnits: "3000",
          grossEntitlementLamports: "3000",
          payoutLamports: "2999",
          feeLamports: "1",
        },
        {
          betId: "winner-taker",
          matchedAmountUnits: "2000",
          grossEntitlementLamports: "2000",
          payoutLamports: "2000",
          feeLamports: "0",
        },
        {
          betId: "loser",
          matchedAmountUnits: "4000",
          grossEntitlementLamports: "0",
          payoutLamports: "0",
          feeLamports: "0",
        },
      ],
    });
  });

  test("allocates a valid zero-payout claim across every winning entitlement", () => {
    const fixture = resolvedFacts();
    const claimEnvelope = fixture.facts.find(
      ({ fact }) => fact.kind === "CLAIM_PAYOUT",
    )!;
    claimEnvelope.fact = {
      ...claimEnvelope.fact,
      amountLamports: "0",
      feeLamports: "6000",
    };

    const settlements = reconcileWalletMarketTerminalSettlements({
      facts: fixture.facts,
      recordedBets: [
        baseline({
          betId: "winner-maker",
          signatureSeed: 11,
          marketPda: fixture.marketPda,
          wallet: fixture.wallet,
          orderId: "1",
          side: 1,
          limitPrice: 600,
          orderAmountUnits: "3000",
        }),
        baseline({
          betId: "winner-taker",
          signatureSeed: 12,
          marketPda: fixture.marketPda,
          wallet: fixture.wallet,
          orderId: "2",
          side: 1,
          limitPrice: 600,
          orderAmountUnits: "2000",
        }),
      ],
    });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      kind: "CLAIM_PAYOUT",
      grossEntitlementLamports: "6000",
      payoutLamports: "0",
      feeLamports: "6000",
      allocations: [
        {
          betId: "winner-maker",
          grossEntitlementLamports: "3000",
          payoutLamports: "0",
          feeLamports: "3000",
        },
        {
          betId: "winner-taker",
          grossEntitlementLamports: "2000",
          payoutLamports: "0",
          feeLamports: "2000",
        },
      ],
    });
  });

  test("records an exact losing-balance cleanup without inventing payout value", () => {
    const marketPda = key(61);
    const wallet = key(62);
    const counterpart = key(63);
    const facts: IndexedLifecycleFact[] = [
      envelope(61, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "1",
        wallet,
        side: 2,
        price: 400,
        amountUnits: "4000",
      }),
      envelope(62, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "2",
        wallet: counterpart,
        side: 1,
        price: 500,
        amountUnits: "4000",
      }),
      envelope(63, 0, {
        kind: "ORDER_MATCHED",
        marketPda,
        makerOrderId: "1",
        takerOrderId: "2",
        price: 400,
        amountUnits: "4000",
      }),
      envelope(63, 1, {
        kind: "TAKER_EXECUTION",
        marketPda,
        orderId: "2",
        wallet: counterpart,
        side: 1,
        price: 500,
        amountUnits: "4000",
        releasedAmountUnits: "0",
        amountLamports: "1600",
        feeLamports: "0",
        refundLamports: "0",
      }),
      envelope(64, 0, {
        kind: "LOSING_BALANCE_CLOSED",
        marketPda,
        wallet,
        side: 2,
        amountUnits: "4000",
        amountLamports: "2400",
        status: "resolved",
        winner: "a",
      }),
    ];

    expect(
      reconcileWalletMarketTerminalSettlements({
        facts,
        recordedBets: [
          baseline({
            betId: "loser-only",
            signatureSeed: 61,
            marketPda,
            wallet,
            orderId: "1",
            side: 2,
            limitPrice: 400,
            orderAmountUnits: "4000",
          }),
        ],
      }),
    ).toEqual([
      {
        claimSignature: signature(64),
        marketPda,
        wallet,
        kind: "LOSER_CLEANUP",
        status: "resolved",
        winner: "a",
        grossEntitlementLamports: "0",
        payoutLamports: "0",
        feeLamports: "0",
        eligibleOrderCount: 1,
        recordedBetCount: 1,
        allocations: [
          {
            betId: "loser-only",
            orderId: "1",
            side: 2,
            matchedAmountUnits: "4000",
            grossEntitlementLamports: "0",
            payoutLamports: "0",
            feeLamports: "0",
          },
        ],
      },
    ]);

    expect(() =>
      reconcileWalletMarketTerminalSettlements({
        facts: facts.map((entry) =>
          entry.fact.kind === "LOSING_BALANCE_CLOSED"
            ? {
                ...entry,
                fact: { ...entry.fact, amountLamports: "2399" },
              }
            : entry,
        ),
        recordedBets: [],
      }),
    ).toThrow("contradicts indexed order custody");
    expect(() =>
      reconcileWalletMarketTerminalSettlements({
        facts: [
          ...facts,
          {
            ...facts.at(-1)!,
            signature: signature(65),
          },
        ],
        recordedBets: [],
      }),
    ).toThrow("terminal settlement is duplicated");
  });

  test("allocates a cancellation refund from exact matched collateral", () => {
    const marketPda = key(41);
    const wallet = key(42);
    const counterpart = key(43);
    const facts: IndexedLifecycleFact[] = [
      envelope(41, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "1",
        wallet,
        side: 1,
        price: 600,
        amountUnits: "3000",
      }),
      envelope(42, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "2",
        wallet,
        side: 2,
        price: 400,
        amountUnits: "2000",
      }),
      envelope(43, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "11",
        wallet: counterpart,
        side: 2,
        price: 400,
        amountUnits: "3000",
      }),
      envelope(44, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "12",
        wallet: counterpart,
        side: 1,
        price: 500,
        amountUnits: "2000",
      }),
      envelope(45, 0, {
        kind: "ORDER_MATCHED",
        marketPda,
        makerOrderId: "1",
        takerOrderId: "11",
        price: 600,
        amountUnits: "3000",
      }),
      envelope(45, 1, {
        kind: "TAKER_EXECUTION",
        marketPda,
        orderId: "11",
        wallet: counterpart,
        side: 2,
        price: 400,
        amountUnits: "3000",
        releasedAmountUnits: "0",
        amountLamports: "1200",
        feeLamports: "0",
        refundLamports: "0",
      }),
      envelope(46, 0, {
        kind: "ORDER_MATCHED",
        marketPda,
        makerOrderId: "2",
        takerOrderId: "12",
        price: 400,
        amountUnits: "2000",
      }),
      envelope(46, 1, {
        kind: "TAKER_EXECUTION",
        marketPda,
        orderId: "12",
        wallet: counterpart,
        side: 1,
        price: 500,
        amountUnits: "2000",
        releasedAmountUnits: "0",
        amountLamports: "800",
        feeLamports: "0",
        refundLamports: "0",
      }),
      envelope(47, 0, {
        kind: "CANCELLATION_REFUND",
        marketPda,
        wallet,
        amountLamports: "3000",
        feeLamports: "0",
        status: "cancelled",
        winner: "none",
      }),
    ];

    const settlement = reconcileWalletMarketTerminalSettlements({
      facts,
      recordedBets: [
        baseline({
          betId: "cancelled-a",
          signatureSeed: 41,
          marketPda,
          wallet,
          orderId: "1",
          side: 1,
          limitPrice: 600,
          orderAmountUnits: "3000",
        }),
        baseline({
          betId: "cancelled-b",
          signatureSeed: 42,
          marketPda,
          wallet,
          orderId: "2",
          side: 2,
          limitPrice: 400,
          orderAmountUnits: "2000",
        }),
      ],
    })[0]!;

    expect(settlement).toMatchObject({
      kind: "CANCELLATION_REFUND",
      grossEntitlementLamports: "3000",
      payoutLamports: "3000",
      feeLamports: "0",
      eligibleOrderCount: 2,
      allocations: [
        {
          betId: "cancelled-a",
          grossEntitlementLamports: "1800",
          payoutLamports: "1800",
        },
        {
          betId: "cancelled-b",
          grossEntitlementLamports: "1200",
          payoutLamports: "1200",
        },
      ],
    });
  });

  test("attributes an escrowed taker fee back to the exact cancelled order", () => {
    const marketPda = key(21);
    const wallet = key(22);
    const counterpart = key(23);
    const facts: IndexedLifecycleFact[] = [
      envelope(50, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "1",
        wallet: counterpart,
        side: 2,
        price: 600,
        amountUnits: "1000",
      }),
      envelope(51, 0, {
        kind: "ORDER_PLACED",
        marketPda,
        orderId: "2",
        wallet,
        side: 1,
        price: 600,
        amountUnits: "1000",
      }),
      envelope(51, 1, {
        kind: "ORDER_MATCHED",
        marketPda,
        makerOrderId: "1",
        takerOrderId: "2",
        price: 600,
        amountUnits: "1000",
      }),
      envelope(51, 2, {
        kind: "TAKER_EXECUTION",
        marketPda,
        orderId: "2",
        wallet,
        side: 1,
        price: 600,
        amountUnits: "1000",
        releasedAmountUnits: "0",
        amountLamports: "600",
        feeLamports: "12",
        refundLamports: "0",
      }),
      envelope(52, 0, {
        kind: "CANCELLATION_REFUND",
        marketPda,
        wallet,
        amountLamports: "612",
        feeLamports: "0",
        treasuryFeeLamports: "6",
        marketMakerFeeLamports: "6",
        status: "cancelled",
        winner: "none",
      }),
    ];

    const settlement = reconcileWalletMarketTerminalSettlements({
      facts,
      recordedBets: [
        baseline({
          betId: "cancelled-taker",
          signatureSeed: 51,
          marketPda,
          wallet,
          orderId: "2",
          side: 1,
          limitPrice: 600,
          orderAmountUnits: "1000",
        }),
      ],
    })[0]!;

    expect(settlement).toMatchObject({
      kind: "CANCELLATION_REFUND",
      grossEntitlementLamports: "612",
      payoutLamports: "612",
      feeLamports: "0",
      allocations: [
        {
          betId: "cancelled-taker",
          grossEntitlementLamports: "612",
          payoutLamports: "612",
        },
      ],
    });

    expect(() =>
      reconcileWalletMarketTerminalSettlements({
        facts: facts.map((entry) =>
          entry.fact.kind === "CANCELLATION_REFUND"
            ? {
                ...entry,
                fact: { ...entry.fact, treasuryFeeLamports: "5" },
              }
            : entry,
        ),
        recordedBets: [],
      }),
    ).toThrow("trade-fee attribution does not conserve");
  });

  test("rejects payout drift and duplicate wallet-market claims", () => {
    const fixture = resolvedFacts();
    const claim = fixture.facts.at(-1)!;
    expect(() =>
      reconcileWalletMarketTerminalSettlements({
        facts: [
          ...fixture.facts.slice(0, -1),
          {
            ...claim,
            fact: { ...claim.fact, amountLamports: "5998" },
          },
        ],
        recordedBets: [],
      }),
    ).toThrow("does not conserve");
    expect(() =>
      reconcileWalletMarketTerminalSettlements({
        facts: [...fixture.facts, { ...claim, signature: signature(41) }],
        recordedBets: [],
      }),
    ).toThrow("duplicated");
  });

  test("rejects missing taker evidence and recorded-order drift", () => {
    const fixture = resolvedFacts();
    expect(() =>
      reconcileWalletMarketTerminalSettlements({
        facts: fixture.facts.filter(
          (envelope) =>
            !(
              envelope.signature === signature(31) &&
              envelope.fact.kind === "TAKER_EXECUTION"
            ),
        ),
        recordedBets: [],
      }),
    ).toThrow("missing taker execution");
    expect(() =>
      reconcileWalletMarketTerminalSettlements({
        facts: fixture.facts,
        recordedBets: [
          baseline({
            betId: "drifted",
            signatureSeed: 11,
            marketPda: fixture.marketPda,
            wallet: fixture.wallet,
            orderId: "1",
            side: 2,
            limitPrice: 600,
            orderAmountUnits: "3000",
          }),
        ],
      }),
    ).toThrow("contradicts its indexed order");
  });
});
