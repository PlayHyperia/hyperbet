import { describe, expect, test } from "bun:test";

import {
  isCurrentDuelRendererObservation,
  resolveDuelMarketAdmission,
} from "./marketCreationAdmission";

describe("duel market creation admission", () => {
  test("creates only from a ready announcement strictly before close", () => {
    expect(
      resolveDuelMarketAdmission({
        existingMarket: false,
        rendererReady: true,
        rendererUpdatedAt: 1_099,
        phase: "ANNOUNCEMENT",
        emittedAt: 1_099,
        betOpenTime: 1_000,
        betCloseTime: 1_100,
      }),
    ).toEqual({ action: "create", reason: null });
  });

  test("rejects an unready renderer without widening the betting window", () => {
    expect(
      resolveDuelMarketAdmission({
        existingMarket: false,
        rendererReady: false,
        rendererUpdatedAt: 1_050,
        phase: "ANNOUNCEMENT",
        emittedAt: 1_050,
        betOpenTime: 1_000,
        betCloseTime: 1_100,
      }),
    ).toEqual({ action: "reject", reason: "renderer-unready" });
    expect(
      resolveDuelMarketAdmission({
        existingMarket: false,
        rendererReady: true,
        rendererUpdatedAt: 1_100,
        phase: "ANNOUNCEMENT",
        emittedAt: 1_100,
        betOpenTime: 1_000,
        betCloseTime: 1_100,
      }),
    ).toEqual({ action: "reject", reason: "betting-window-closed" });
  });

  test("rejects late first creation but recovers the exact existing market", () => {
    expect(
      resolveDuelMarketAdmission({
        existingMarket: false,
        rendererReady: true,
        rendererUpdatedAt: 1_200,
        phase: "FIGHTING",
        emittedAt: 1_200,
        betOpenTime: 1_000,
        betCloseTime: 1_100,
      }),
    ).toEqual({
      action: "reject",
      reason: "market-creation-phase-invalid",
    });
    expect(
      resolveDuelMarketAdmission({
        existingMarket: true,
        rendererReady: false,
        rendererUpdatedAt: 1_200,
        phase: "FIGHTING",
        emittedAt: 1_200,
        betOpenTime: 1_000,
        betCloseTime: 1_100,
      }),
    ).toEqual({ action: "recover", reason: null });
  });

  test("rejects renderer evidence that does not belong to the market window", () => {
    expect(
      resolveDuelMarketAdmission({
        existingMarket: false,
        rendererReady: true,
        rendererUpdatedAt: 999,
        phase: "ANNOUNCEMENT",
        emittedAt: 1_050,
        betOpenTime: 1_000,
        betCloseTime: 1_100,
      }),
    ).toEqual({
      action: "reject",
      reason: "renderer-observation-predates-market",
    });
    expect(
      isCurrentDuelRendererObservation({
        rendererReady: true,
        rendererUpdatedAt: 1_000,
        emittedAt: 1_050,
        betOpenTime: 1_000,
      }),
    ).toBeTrue();
    expect(
      isCurrentDuelRendererObservation({
        rendererReady: true,
        rendererUpdatedAt: 999,
        emittedAt: 1_050,
        betOpenTime: 1_000,
      }),
    ).toBeFalse();
  });
});
