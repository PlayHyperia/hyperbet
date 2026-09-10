import { describe, expect, test } from "bun:test";

import { evaluateSolanaLifecyclePendingState } from "./solanaLifecyclePendingPolicy";

describe("Solana lifecycle pending policy", () => {
  test("keeps a fresh finalized-index lag healthy and observable", () => {
    expect(
      evaluateSolanaLifecyclePendingState({
        pendingBets: 2,
        oldestPendingBetRecordedAt: 1_000,
        nowMs: 4_000,
        maximumPendingAgeMs: 5_000,
      }),
    ).toEqual({
      pendingBets: 2,
      oldestPendingBetAgeMs: 3_000,
      withinFinalizationGrace: true,
    });
  });

  test("fails the grace verdict once a persisted transaction is stranded", () => {
    expect(
      evaluateSolanaLifecyclePendingState({
        pendingBets: 1,
        oldestPendingBetRecordedAt: 1_000,
        nowMs: 6_001,
        maximumPendingAgeMs: 5_000,
      }).withinFinalizationGrace,
    ).toBe(false);
  });

  test("requires exact count and timestamp consistency", () => {
    expect(
      evaluateSolanaLifecyclePendingState({
        pendingBets: 0,
        oldestPendingBetRecordedAt: null,
        nowMs: 1_000,
        maximumPendingAgeMs: 5_000,
      }),
    ).toEqual({
      pendingBets: 0,
      oldestPendingBetAgeMs: null,
      withinFinalizationGrace: true,
    });
    expect(() =>
      evaluateSolanaLifecyclePendingState({
        pendingBets: 0,
        oldestPendingBetRecordedAt: 1,
        nowMs: 1_000,
        maximumPendingAgeMs: 5_000,
      }),
    ).toThrow("empty backlog retained a timestamp");
    expect(() =>
      evaluateSolanaLifecyclePendingState({
        pendingBets: 1,
        oldestPendingBetRecordedAt: null,
        nowMs: 1_000,
        maximumPendingAgeMs: 5_000,
      }),
    ).toThrow("pending timestamp is invalid");
  });
});
