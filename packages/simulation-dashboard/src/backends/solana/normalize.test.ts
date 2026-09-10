import { describe, expect, test } from "bun:test";

import { getScenarioPresetByIdOrName } from "../../solana-scenario-catalog.js";
import { normalizeSolanaProofOutcome } from "./normalize.js";
import type { SolanaProofOutcome } from "./types.js";

describe("normalizeSolanaProofOutcome", () => {
  test("maps a Solana proof summary into the shared ScenarioResult contract", () => {
    const preset = getScenarioPresetByIdOrName(
      "solana-unauthorized-oracle-attack",
    );
    expect(preset).not.toBeNull();

    const outcome: SolanaProofOutcome = {
      preset: preset!,
      seed: "solana-proof-seed",
      winner: "A",
      duelLabel: "solana-unauthorized-oracle-attack:solana-proof-seed",
      duelKeyHex: "abcd".repeat(16),
      marketRef: "Market111111111111111111111111111111111",
      rpcUrl: "http://127.0.0.1:9999",
      contracts: {
        oracle: "Oracle111111111111111111111111111111111",
        clob: "Clob11111111111111111111111111111111111",
      },
      fees: {
        treasuryBps: 100,
        mmBps: 100,
        winningsMmBps: 200,
        treasuryAccruedLamports: 14n,
        mmAccruedLamports: 20n,
      },
      actors: [
        {
          name: "Solana MM",
          role: "market-maker",
          description: "Provides resting liquidity.",
          color: "#22d3ee",
          address: "Actor11111111111111111111111111111111111",
          tradeCount: 2,
          activeOrders: 1,
          balance: {
            lamports: 2_500_000_000n,
            pnlSol: 0.125,
          },
          position: {
            aShares: 3n,
            bShares: 1n,
            aLockedLamports: 400_000_000n,
            bLockedLamports: 100_000_000n,
          },
        },
      ],
      book: {
        bids: [],
        asks: [],
      },
      traces: [
        {
          actor: "Unauthorized Reporter",
          action: "post_lock_order_rejected",
          chainKey: "solana",
          duelKey: "abcd",
          marketRef: "Market111111111111111111111111111111111",
          price: null,
          units: null,
          txRef: null,
          ok: true,
          message: "unauthorized oracle write rejected",
        },
      ],
      attackRejected: true,
      staleStreamGuardTrips: 0,
      staleOracleGuardTrips: 0,
      closeGuardTrips: 1,
      peakInventory: 1_000,
      quoteChecks: 1,
      quoteActiveChecks: 1,
      orderChurn: 2,
      lockTransitionLatencyMs: 750,
      resolvedCorrectly: true,
      claimCorrectly: true,
      settlementStatus: "RESOLVED",
      settlementStatusCode: 3,
      winnerCode: 1,
      winnerLabel: "A",
      totalAShares: 0n,
      totalBShares: 0n,
      bestBid: 0,
      bestAsk: 1_000,
      marketMakerPnl: -0.02,
      attackerPnl: -0.000005,
      treasuryPnl: 0.000014,
      marketMakerDrawdownBps: 25,
      claimsProcessed: true,
      bookNotCrossed: true,
      mmSolvent: true,
      degraded: false,
      debug: {
        claimant: "Solana Taker",
      },
    };

    const normalized = normalizeSolanaProofOutcome(outcome);

    expect(normalized.result.chainKey).toBe("solana");
    expect(normalized.result.resolvedCorrectly).toBeTrue();
    expect(normalized.result.claimCorrectly).toBeTrue();
    expect(normalized.result.passed).toBeTrue();
    expect(
      normalized.result.gates.some(
        (gate) => gate.name === "adversarialActionRejected" && gate.passed,
      ),
    ).toBeTrue();
    expect(normalized.summary.metrics.closeGuardTrips).toBe(1);
    expect(normalized.state.backend).toBe("solana");
    expect(normalized.state.market).toEqual({
      exists: true,
      status: 3,
      winner: 1,
      bestBid: 0,
      bestAsk: 1_000,
      totalAShares: "0",
      totalBShares: "0",
    });
    expect(normalized.state.fees).toMatchObject({
      treasuryAccruedWei: "14",
      mmAccruedWei: "20",
      treasuryAccruedAtomic: "14",
      mmAccruedAtomic: "20",
      accrualUnit: "lamports",
      displaySymbol: "SOL",
      displayDecimals: 9,
    });
    expect(normalized.state.agents).toEqual([
      {
        enabled: true,
        name: "Solana MM",
        strategy: "market-maker",
        description: "Provides resting liquidity.",
        color: "#22d3ee",
        address: "Actor11111111111111111111111111111111111",
        balance: 2.5,
        pnl: 0.125,
        tradeCount: 2,
        activeOrders: 1,
        position: {
          aShares: "3",
          bShares: "1",
          aStake: 0.4,
          bStake: 0.1,
        },
      },
    ]);
  });

  test("keeps the stale-resolution-window gate green when the invalid report is rejected", () => {
    const preset = getScenarioPresetByIdOrName(
      "solana-stale-resolution-window",
    );
    expect(preset).not.toBeNull();

    const outcome: SolanaProofOutcome = {
      preset: preset!,
      seed: "solana-stale-resolution-seed-1",
      winner: "A",
      duelLabel:
        "solana-stale-resolution-window:solana-stale-resolution-seed-1",
      duelKeyHex: "1234".repeat(16),
      marketRef: "Market222222222222222222222222222222222",
      rpcUrl: "http://127.0.0.1:9999",
      contracts: {
        oracle: "Oracle222222222222222222222222222222222",
        clob: "Clob22222222222222222222222222222222222",
      },
      fees: {
        treasuryBps: 100,
        mmBps: 100,
        winningsMmBps: 200,
        treasuryAccruedLamports: 8n,
        mmAccruedLamports: 12n,
      },
      actors: [
        {
          name: "Solana MM",
          role: "market-maker",
          description: "Provides resting liquidity.",
          color: "#22d3ee",
          address: "Actor22222222222222222222222222222222222",
          tradeCount: 2,
          activeOrders: 0,
          balance: {
            lamports: 2_750_000_000n,
            pnlSol: 0.05,
          },
          position: {
            aShares: 2n,
            bShares: 0n,
            aLockedLamports: 250_000_000n,
            bLockedLamports: 0n,
          },
        },
      ],
      book: {
        bids: [],
        asks: [],
      },
      traces: [
        {
          actor: "Authority Reporter",
          action: "invalid_resolution_rejected",
          chainKey: "solana",
          duelKey: "1234",
          marketRef: "Market222222222222222222222222222222222",
          price: null,
          units: null,
          txRef: null,
          ok: true,
          message: "pre-close resolution rejected by oracle lifecycle checks",
        },
      ],
      attackRejected: true,
      staleStreamGuardTrips: 0,
      staleOracleGuardTrips: 1,
      closeGuardTrips: 0,
      peakInventory: 1_000,
      quoteChecks: 1,
      quoteActiveChecks: 1,
      orderChurn: 2,
      lockTransitionLatencyMs: 900,
      resolvedCorrectly: true,
      claimCorrectly: true,
      settlementStatus: "RESOLVED",
      settlementStatusCode: 3,
      winnerCode: 1,
      winnerLabel: "A",
      totalAShares: 0n,
      totalBShares: 0n,
      bestBid: 0,
      bestAsk: 1_000,
      marketMakerPnl: -0.01,
      attackerPnl: 0,
      treasuryPnl: 0.000008,
      marketMakerDrawdownBps: 18,
      claimsProcessed: true,
      bookNotCrossed: true,
      mmSolvent: true,
      degraded: false,
      debug: {
        staleEndTs: 1_700_000_000,
      },
    };

    const normalized = normalizeSolanaProofOutcome(outcome);

    expect(normalized.result.passed).toBeTrue();
    expect(
      normalized.result.gates.some(
        (gate) => gate.name === "adversarialActionRejected" && gate.passed,
      ),
    ).toBeTrue();
    expect(
      normalized.result.gates.some(
        (gate) => gate.name === "scenarioMmSolvent" && gate.passed,
      ),
    ).toBeTrue();
    expect(
      normalized.result.gates.some(
        (gate) => gate.name === "expectedSettlementObserved" && gate.passed,
      ),
    ).toBeTrue();
  });
});
