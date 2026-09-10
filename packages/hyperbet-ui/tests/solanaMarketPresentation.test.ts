import { describe, expect, test } from "bun:test";

import {
  deriveTwoSidedClobProbabilityPercent,
  shouldRenderSolanaClobStatusRow,
} from "../src/lib/solanaMarketPresentation";

describe("Solana CLOB market presentation", () => {
  test("derives the midpoint only from a valid two-sided quote", () => {
    expect(deriveTwoSidedClobProbabilityPercent(550, 650)).toBe(60);
    expect(deriveTwoSidedClobProbabilityPercent(501, 502)).toBe(50.15);
    expect(deriveTwoSidedClobProbabilityPercent(600, 600)).toBe(60);
  });

  test("does not invent a 50/50 price from empty or one-sided books", () => {
    expect(deriveTwoSidedClobProbabilityPercent(0, 1_000)).toBeNull();
    expect(deriveTwoSidedClobProbabilityPercent(550, 1_000)).toBeNull();
    expect(deriveTwoSidedClobProbabilityPercent(0, 650)).toBeNull();
    expect(deriveTwoSidedClobProbabilityPercent(null, null)).toBeNull();
  });

  test("fails closed on crossed, fractional, or out-of-range quotes", () => {
    expect(deriveTwoSidedClobProbabilityPercent(700, 600)).toBeNull();
    expect(deriveTwoSidedClobProbabilityPercent(500.5, 600)).toBeNull();
    expect(deriveTwoSidedClobProbabilityPercent(-1, 600)).toBeNull();
    expect(deriveTwoSidedClobProbabilityPercent(500, 1_001)).toBeNull();
  });

  test("does not repeat an authoritative unavailable message below the market card", () => {
    expect(
      shouldRenderSolanaClobStatusRow({
        orderEntryAvailable: false,
        tradingUnavailableMessage: "Betting is temporarily unavailable.",
      }),
    ).toBe(false);
    expect(
      shouldRenderSolanaClobStatusRow({
        orderEntryAvailable: false,
        tradingUnavailableMessage: "  ",
      }),
    ).toBe(true);
    expect(
      shouldRenderSolanaClobStatusRow({
        orderEntryAvailable: true,
        tradingUnavailableMessage: "Betting is temporarily unavailable.",
      }),
    ).toBe(true);
  });
});
