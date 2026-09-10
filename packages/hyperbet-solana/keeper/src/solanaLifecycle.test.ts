import { describe, expect, test } from "bun:test";
import {
  isCurrentSolanaLifecycleSnapshot,
  normalizePredictionMarketLifecycleMetadata,
  resolveCurrentSolanaLifecycleAuthority,
  resolveLifecycleFromSolanaDuelStatus,
  resolveLifecycleFromSolanaMarketStatus,
  resolveLifecycleFromStreamPhase,
  toRecordedBetChain,
} from "./solanaLifecycle";

describe("Solana-only keeper lifecycle", () => {
  test("maps only the native Solana recorded-bet chain", () => {
    expect(toRecordedBetChain("solana")).toBe("SOLANA");
  });

  test("normalizes stream, oracle, and duel-market lifecycle states", () => {
    expect(resolveLifecycleFromStreamPhase("announcement")).toBe("OPEN");
    expect(resolveLifecycleFromStreamPhase("fighting")).toBe("LOCKED");
    expect(resolveLifecycleFromSolanaDuelStatus("betting_open")).toBe("OPEN");
    expect(resolveLifecycleFromSolanaDuelStatus("challenged")).toBe(
      "CHALLENGED",
    );
    expect(resolveLifecycleFromSolanaMarketStatus("resolved")).toBe("RESOLVED");
    expect(resolveLifecycleFromSolanaMarketStatus("amm-open")).toBe("UNKNOWN");
  });

  test("fails optional lifecycle metadata closed to canonical values", () => {
    expect(
      normalizePredictionMarketLifecycleMetadata({
        proposalId: 123,
        challengeWindowEndsAt: Number.NaN,
        finalizedAt: 456,
        cancellationReason: "operator-cancelled",
      }),
    ).toEqual({
      proposalId: null,
      challengeWindowEndsAt: null,
      finalizedAt: 456,
      cancellationReason: "operator-cancelled",
    });
  });

  test("accepts lifecycle authority only for the exact current duel and market PDAs", () => {
    const current = {
      expectedDuelPda: "duel-current",
      expectedMarketPda: "market-current",
      snapshotDuelPda: "duel-current",
      snapshotMarketPda: "market-current",
    };
    expect(isCurrentSolanaLifecycleSnapshot(current)).toBeTrue();
    expect(
      isCurrentSolanaLifecycleSnapshot({
        ...current,
        snapshotDuelPda: "duel-previous",
      }),
    ).toBeFalse();
    expect(
      isCurrentSolanaLifecycleSnapshot({
        ...current,
        snapshotMarketPda: "market-previous",
      }),
    ).toBeFalse();
    expect(
      isCurrentSolanaLifecycleSnapshot({
        ...current,
        expectedDuelPda: null,
      }),
    ).toBeFalse();
    expect(
      isCurrentSolanaLifecycleSnapshot({
        ...current,
        expectedMarketPda: null,
      }),
    ).toBeFalse();
  });

  test("fails cross-duel, missing-account, and impossible winner snapshots closed", () => {
    const current = {
      expectedDuelPda: "duel-current",
      expectedMarketPda: "market-current",
      snapshotDuelPda: "duel-current",
      snapshotMarketPda: "market-current",
      currentDuelAccountExists: true,
      currentMarketAccountExists: true,
      currentDuelStatus: "betting_open",
      currentMarketStatus: "open",
      currentMarketWinner: "none",
      snapshotSyncedAt: 1_000,
    };
    expect(resolveCurrentSolanaLifecycleAuthority(current)).toEqual({
      snapshotMatchesCurrentDuel: true,
      currentMarketObserved: true,
      lifecycleStatus: "OPEN",
      winner: "NONE",
      syncedAt: 1_000,
    });
    expect(
      resolveCurrentSolanaLifecycleAuthority({
        ...current,
        currentDuelStatus: "resolved",
        currentMarketStatus: "resolved",
        currentMarketWinner: "b",
      }),
    ).toMatchObject({ lifecycleStatus: "RESOLVED", winner: "B" });
    expect(
      resolveCurrentSolanaLifecycleAuthority({
        ...current,
        snapshotDuelPda: "duel-previous",
        currentDuelStatus: "resolved",
        currentMarketStatus: "resolved",
        currentMarketWinner: "a",
      }),
    ).toEqual({
      snapshotMatchesCurrentDuel: false,
      currentMarketObserved: false,
      lifecycleStatus: "PENDING",
      winner: "NONE",
      syncedAt: null,
    });
    expect(
      resolveCurrentSolanaLifecycleAuthority({
        ...current,
        currentDuelAccountExists: false,
      }),
    ).toMatchObject({
      currentMarketObserved: false,
      lifecycleStatus: "PENDING",
      winner: "NONE",
      syncedAt: 1_000,
    });
    expect(
      resolveCurrentSolanaLifecycleAuthority({
        ...current,
        currentMarketAccountExists: false,
      }),
    ).toMatchObject({
      currentMarketObserved: false,
      lifecycleStatus: "PENDING",
      winner: "NONE",
      syncedAt: 1_000,
    });
    expect(
      resolveCurrentSolanaLifecycleAuthority({
        ...current,
        currentDuelStatus: "resolved",
        currentMarketStatus: "resolved",
        currentMarketWinner: "none",
      }),
    ).toMatchObject({ lifecycleStatus: "UNKNOWN", winner: "NONE" });
    expect(
      resolveCurrentSolanaLifecycleAuthority({
        ...current,
        currentMarketWinner: "a",
      }),
    ).toMatchObject({ lifecycleStatus: "UNKNOWN", winner: "NONE" });
    expect(
      resolveCurrentSolanaLifecycleAuthority({
        ...current,
        currentMarketWinner: "invalid",
      }),
    ).toMatchObject({ lifecycleStatus: "UNKNOWN", winner: "NONE" });
  });
});
