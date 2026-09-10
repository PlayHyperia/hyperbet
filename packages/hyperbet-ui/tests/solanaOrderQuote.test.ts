import { describe, expect, test } from "bun:test";

import {
  buildSolanaOrderQuote,
  formatSolLamports,
  outcomePriceToMarketPrice,
  parseOutcomePriceMillis,
  parseSolAmountToLamports,
  type SolanaRestingOrderQuote,
} from "../src/lib/solanaOrderQuote";

const WALLET = "bettor";

function restingOrder(
  input: Partial<SolanaRestingOrderQuote> &
    Pick<
      SolanaRestingOrderQuote,
      "id" | "side" | "marketPriceMillis" | "amount"
    >,
): SolanaRestingOrderQuote {
  return {
    filled: 0n,
    maker: "maker",
    active: true,
    ...input,
  };
}

describe("Solana order quote", () => {
  test("parses SOL and probability inputs without floating-point rounding", () => {
    expect(parseSolAmountToLamports("1")).toBe(1_000_000_000n);
    expect(parseSolAmountToLamports("0.000001")).toBe(1_000n);
    expect(parseSolAmountToLamports("18446744073.709551")).toBe(
      18_446_744_073_709_551_000n,
    );
    expect(() => parseSolAmountToLamports("0.0000001")).toThrow(
      "at most 6 decimal places",
    );
    expect(() => parseSolAmountToLamports("1e-3")).toThrow();
    expect(() => parseSolAmountToLamports("18446744073.709552")).toThrow("u64");
    expect(parseOutcomePriceMillis("600")).toBe(600);
    expect(() => parseOutcomePriceMillis("0")).toThrow();
    expect(() => parseOutcomePriceMillis("1000")).toThrow();
    expect(outcomePriceToMarketPrice("YES", 600)).toBe(600);
    expect(outcomePriceToMarketPrice("NO", 600)).toBe(400);
    expect(formatSolLamports(1_234_567_890n)).toBe("1.234567");
    expect(formatSolLamports(-10_000_000n, 3)).toBe("-0.01");
  });

  test("reproduces YES limit collateral, visible fills, split fees, payout, and refund math", () => {
    const quote = buildSolanaOrderQuote({
      side: "YES",
      amountLamports: 1_000_000_000n,
      outcomePriceMillis: 600,
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 200,
      wallet: WALLET,
      restingOrders: [
        restingOrder({
          id: 2n,
          side: "NO",
          marketPriceMillis: 600,
          amount: 300_000_000n,
        }),
        restingOrder({
          id: 1n,
          side: "NO",
          marketPriceMillis: 550,
          amount: 400_000_000n,
        }),
        restingOrder({
          id: 3n,
          side: "NO",
          marketPriceMillis: 650,
          amount: 1_000_000_000n,
        }),
      ],
    });

    expect(quote.marketPriceMillis).toBe(600);
    expect(quote.limitCollateralLamports).toBe(600_000_000n);
    expect(quote.visibleMatchedLamports).toBe(700_000_000n);
    expect(quote.visibleRemainingLamports).toBe(300_000_000n);
    expect(quote.visibleExecutionCollateralLamports).toBe(400_000_000n);
    expect(quote.visibleRestingCollateralLamports).toBe(180_000_000n);
    expect(quote.visiblePriceImprovementLamports).toBe(20_000_000n);
    expect(quote.visibleTreasuryFeeLamports).toBe(4_000_000n);
    expect(quote.visibleMarketMakerFeeLamports).toBe(4_000_000n);
    expect(quote.fullFillTradeFeeLamports).toBe(12_000_000n);
    expect(quote.fullFillGrossPayoutLamports).toBe(1_000_000_000n);
    expect(quote.fullFillWinningsFeeLamports).toBe(20_000_000n);
    expect(quote.fullFillNetPayoutLamports).toBe(980_000_000n);
    expect(quote.fullFillNetProfitLamports).toBe(368_000_000n);
    expect(quote.cancellationRefundLamports).toBe(588_000_000n);
    expect(quote.refundableExecutionFeeLamports).toBe(8_000_000n);
    expect(quote.averageVisibleOutcomePriceMillis).toBe(571);
  });

  test("quotes NO in selected-outcome probability while converting to the program market price", () => {
    const quote = buildSolanaOrderQuote({
      side: "NO",
      amountLamports: 1_000_000_000n,
      outcomePriceMillis: 700,
      tradeTreasuryFeeBps: 0,
      tradeMarketMakerFeeBps: 0,
      winningsMarketMakerFeeBps: 0,
      wallet: WALLET,
      restingOrders: [
        restingOrder({
          id: 1n,
          side: "YES",
          marketPriceMillis: 400,
          amount: 1_000_000_000n,
        }),
      ],
    });

    expect(quote.marketPriceMillis).toBe(300);
    expect(quote.limitCollateralLamports).toBe(700_000_000n);
    expect(quote.visibleExecutionCollateralLamports).toBe(600_000_000n);
    expect(quote.visiblePriceImprovementLamports).toBe(100_000_000n);
    expect(quote.averageVisibleOutcomePriceMillis).toBe(600);
  });

  test("stops at self-trade and exposes the exact refundable execution fee", () => {
    const quote = buildSolanaOrderQuote({
      side: "YES",
      amountLamports: 1_000_000_000n,
      outcomePriceMillis: 500,
      tradeTreasuryFeeBps: 125,
      tradeMarketMakerFeeBps: 75,
      winningsMarketMakerFeeBps: 0,
      wallet: WALLET,
      restingOrders: [
        restingOrder({
          id: 1n,
          side: "NO",
          marketPriceMillis: 400,
          amount: 250_000_000n,
        }),
        restingOrder({
          id: 2n,
          side: "NO",
          marketPriceMillis: 450,
          amount: 500_000_000n,
          maker: WALLET,
        }),
      ],
    });

    expect(quote.selfTradePrevented).toBeTrue();
    expect(quote.visibleMatchedLamports).toBe(250_000_000n);
    expect(quote.visibleRemainingLamports).toBe(750_000_000n);
    expect(quote.visibleRestingCollateralLamports).toBe(0n);
    expect(quote.visibleExecutionCollateralLamports).toBe(100_000_000n);
    expect(quote.visibleTreasuryFeeLamports).toBe(1_250_000n);
    expect(quote.visibleMarketMakerFeeLamports).toBe(750_000n);
    expect(quote.cancellationRefundLamports).toBe(102_000_000n);
    expect(quote.refundableExecutionFeeLamports).toBe(2_000_000n);
  });

  test("matches the program's 50-fill transaction bound", () => {
    const quote = buildSolanaOrderQuote({
      side: "YES",
      amountLamports: 60_000n,
      outcomePriceMillis: 500,
      tradeTreasuryFeeBps: 0,
      tradeMarketMakerFeeBps: 0,
      winningsMarketMakerFeeBps: 0,
      wallet: WALLET,
      restingOrders: Array.from({ length: 60 }, (_, index) =>
        restingOrder({
          id: BigInt(index + 1),
          side: "NO",
          marketPriceMillis: 500,
          amount: 1_000n,
        }),
      ),
    });

    expect(quote.visibleMatchedLamports).toBe(50_000n);
    expect(quote.visibleRemainingLamports).toBe(10_000n);
    expect(quote.continuationRequired).toBeTrue();
    expect(quote.visibleRestingCollateralLamports).toBe(5_000n);
  });

  test("fails closed on program precision and fee-cap violations", () => {
    expect(() =>
      buildSolanaOrderQuote({
        side: "YES",
        amountLamports: 1n,
        outcomePriceMillis: 500,
        tradeTreasuryFeeBps: 0,
        tradeMarketMakerFeeBps: 0,
        winningsMarketMakerFeeBps: 0,
        wallet: null,
        restingOrders: [],
      }),
    ).toThrow("exact precision rule");

    expect(() =>
      buildSolanaOrderQuote({
        side: "YES",
        amountLamports: 1_000n,
        outcomePriceMillis: 500,
        tradeTreasuryFeeBps: 6_000,
        tradeMarketMakerFeeBps: 5_000,
        winningsMarketMakerFeeBps: 0,
        wallet: null,
        restingOrders: [],
      }),
    ).toThrow("Combined trade fee exceeds");
  });

  test("matches the program's widened arithmetic across valid large u64 amounts", () => {
    const largeExactAmount = 18_446_744_073_709_551_000n;
    const quote = buildSolanaOrderQuote({
      side: "YES",
      amountLamports: largeExactAmount,
      outcomePriceMillis: 999,
      tradeTreasuryFeeBps: 1_001,
      tradeMarketMakerFeeBps: 0,
      winningsMarketMakerFeeBps: 9_999,
      wallet: null,
      restingOrders: [],
    });

    const expectedCollateral = (largeExactAmount * 999n) / 1_000n;
    expect(quote.limitCollateralLamports).toBe(expectedCollateral);
    expect(quote.visibleRestingCollateralLamports).toBe(expectedCollateral);
    expect(quote.fullFillTreasuryFeeLamports).toBe(
      (expectedCollateral * 1_001n) / 10_000n,
    );
    expect(quote.fullFillWinningsFeeLamports).toBe(
      (largeExactAmount * 9_999n) / 10_000n,
    );
  });
});
