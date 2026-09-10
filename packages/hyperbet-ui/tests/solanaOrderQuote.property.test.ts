import { describe, expect, test } from "bun:test";

import {
  buildSolanaOrderQuote,
  outcomePriceToMarketPrice,
  type SolanaOutcomeSide,
  type SolanaRestingOrderQuote,
} from "../src/lib/solanaOrderQuote";

const PRICE_SCALE = 1_000n;
const BPS_SCALE = 10_000n;

function referenceCost(amount: bigint, outcomePriceMillis: number): bigint {
  return (amount * BigInt(outcomePriceMillis)) / PRICE_SCALE;
}

function referenceFee(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BPS_SCALE;
}

function nextSeed(seed: number): number {
  return (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
}

describe("Solana order quote deterministic properties", () => {
  test("matches every valid selected-outcome probability for both sides", () => {
    const amountLamports = 1_000_000n;
    for (const side of ["YES", "NO"] as const) {
      for (
        let outcomePriceMillis = 1;
        outcomePriceMillis < 1_000;
        outcomePriceMillis += 1
      ) {
        const quote = buildSolanaOrderQuote({
          side,
          amountLamports,
          outcomePriceMillis,
          tradeTreasuryFeeBps: 0,
          tradeMarketMakerFeeBps: 0,
          winningsMarketMakerFeeBps: 0,
          wallet: null,
          restingOrders: [],
        });

        const expectedCost = referenceCost(amountLamports, outcomePriceMillis);
        expect(quote.marketPriceMillis).toBe(
          outcomePriceToMarketPrice(side, outcomePriceMillis),
        );
        expect(quote.limitCollateralLamports).toBe(expectedCost);
        expect(quote.visibleMatchedLamports).toBe(0n);
        expect(quote.visibleRestingCollateralLamports).toBe(expectedCost);
        expect(quote.cancellationRefundLamports).toBe(expectedCost);
      }
    }
  });

  test("matches integer fee, payout, and profit math across a deterministic matrix", () => {
    let seed = 0x48595045;
    for (let index = 0; index < 512; index += 1) {
      seed = nextSeed(seed);
      const amountLamports = BigInt((seed % 2_000_000) + 1) * 1_000n;
      seed = nextSeed(seed);
      const outcomePriceMillis = (seed % 999) + 1;
      seed = nextSeed(seed);
      const tradeTreasuryFeeBps = seed % 251;
      seed = nextSeed(seed);
      const tradeMarketMakerFeeBps = seed % 251;
      seed = nextSeed(seed);
      const winningsMarketMakerFeeBps = seed % 501;
      const side: SolanaOutcomeSide = index % 2 === 0 ? "YES" : "NO";

      const quote = buildSolanaOrderQuote({
        side,
        amountLamports,
        outcomePriceMillis,
        tradeTreasuryFeeBps,
        tradeMarketMakerFeeBps,
        winningsMarketMakerFeeBps,
        wallet: null,
        restingOrders: [],
      });
      const collateral = referenceCost(amountLamports, outcomePriceMillis);
      const treasuryFee = referenceFee(collateral, tradeTreasuryFeeBps);
      const marketMakerFee = referenceFee(collateral, tradeMarketMakerFeeBps);
      const winningsFee = referenceFee(
        amountLamports,
        winningsMarketMakerFeeBps,
      );
      const netPayout = amountLamports - winningsFee;

      expect(quote.limitCollateralLamports).toBe(collateral);
      expect(quote.fullFillTreasuryFeeLamports).toBe(treasuryFee);
      expect(quote.fullFillMarketMakerFeeLamports).toBe(marketMakerFee);
      expect(quote.fullFillTradeFeeLamports).toBe(treasuryFee + marketMakerFee);
      expect(quote.fullFillWinningsFeeLamports).toBe(winningsFee);
      expect(quote.fullFillNetPayoutLamports).toBe(netPayout);
      expect(quote.fullFillNetProfitLamports).toBe(
        netPayout - collateral - treasuryFee - marketMakerFee,
      );
    }
  });

  test("conserves collateral and is input-order independent across generated books", () => {
    let seed = 0x534f4c31;
    for (let index = 0; index < 256; index += 1) {
      seed = nextSeed(seed);
      const side: SolanaOutcomeSide = seed % 2 === 0 ? "YES" : "NO";
      seed = nextSeed(seed);
      const outcomePriceMillis = (seed % 899) + 51;
      seed = nextSeed(seed);
      const amountLamports = BigInt((seed % 100) + 10) * 10_000n;
      const marketPriceMillis = outcomePriceToMarketPrice(
        side,
        outcomePriceMillis,
      );
      const opposingSide: SolanaOutcomeSide = side === "YES" ? "NO" : "YES";
      const restingOrders: SolanaRestingOrderQuote[] = [];

      for (let orderIndex = 0; orderIndex < 8; orderIndex += 1) {
        seed = nextSeed(seed);
        const priceDelta = seed % 60;
        const orderPrice =
          side === "YES"
            ? Math.max(1, marketPriceMillis - priceDelta)
            : Math.min(999, marketPriceMillis + priceDelta);
        seed = nextSeed(seed);
        restingOrders.push({
          id: BigInt(orderIndex + 1),
          side: opposingSide,
          marketPriceMillis: orderPrice,
          amount: BigInt((seed % 25) + 1) * 10_000n,
          filled: 0n,
          maker: `maker-${orderIndex}`,
          active: true,
        });
      }

      const input = {
        side,
        amountLamports,
        outcomePriceMillis,
        tradeTreasuryFeeBps: 137,
        tradeMarketMakerFeeBps: 63,
        winningsMarketMakerFeeBps: 125,
        wallet: "bettor",
      } as const;
      const quote = buildSolanaOrderQuote({ ...input, restingOrders });
      const reversed = buildSolanaOrderQuote({
        ...input,
        restingOrders: [...restingOrders].reverse(),
      });

      expect(quote).toEqual(reversed);
      expect(
        quote.visibleMatchedLamports + quote.visibleRemainingLamports,
      ).toBe(amountLamports);
      expect(
        quote.visibleExecutionCollateralLamports +
          quote.visiblePriceImprovementLamports +
          quote.visibleRestingCollateralLamports,
      ).toBe(quote.limitCollateralLamports);
      expect(quote.visibleTradeFeeLamports).toBe(
        quote.visibleTreasuryFeeLamports + quote.visibleMarketMakerFeeLamports,
      );
      expect(quote.cancellationRefundLamports).toBe(
        quote.visibleExecutionCollateralLamports +
          quote.visibleRestingCollateralLamports +
          quote.visibleTradeFeeLamports,
      );
    }
  });
});
