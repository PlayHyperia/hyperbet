import { describe, expect, test } from "bun:test";

import {
  deriveSolanaMarketAuthorityState,
  failClosedSolanaMarketSnapshot,
  type SolanaMarketAuthoritySnapshot,
} from "../src/lib/solanaMarketAuthority";

const DUEL_KEY = "ab".repeat(32);

function snapshot(
  overrides: Partial<SolanaMarketAuthoritySnapshot> = {},
): SolanaMarketAuthoritySnapshot {
  return {
    requireCurrentConfig: true,
    canonicalDuelKeyHex: DUEL_KEY,
    canonicalDuelState: "duel-state",
    canonicalMarketState: "market-state",
    advertisedMarketState: "market-state",
    market: {
      duelKeyHex: DUEL_KEY,
      duelState: "duel-state",
      marketKind: 0,
      authority: "market-operator",
      treasury: "treasury",
      marketMaker: "market-maker",
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 200,
    },
    config: {
      authority: "config-authority",
      marketOperator: "market-operator",
      treasury: "treasury",
      marketMaker: "market-maker",
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 200,
      orderPlacementPaused: false,
    },
    duelWinnerMarketKind: 0,
    ...overrides,
  };
}

describe("Solana market authority snapshot", () => {
  test("accepts one canonical configured duel market", () => {
    expect(deriveSolanaMarketAuthorityState(snapshot())).toEqual({
      valid: true,
      tradingReady: true,
      reason: null,
    });
  });

  test("rejects an advertised market that is not the canonical duel PDA", () => {
    expect(
      deriveSolanaMarketAuthorityState(
        snapshot({ advertisedMarketState: "other-market" }),
      ),
    ).toMatchObject({
      valid: false,
      tradingReady: false,
      reason: "advertised-market-mismatch",
    });
  });

  test("rejects duel, kind, authority, recipient, and immutable fee drift", () => {
    const cases: Array<{
      input: SolanaMarketAuthoritySnapshot;
      reason: string;
    }> = [
      {
        input: snapshot({
          market: { ...snapshot().market, duelKeyHex: "cd".repeat(32) },
        }),
        reason: "market-duel-mismatch",
      },
      {
        input: snapshot({
          market: { ...snapshot().market, marketKind: 1 },
        }),
        reason: "market-kind-mismatch",
      },
      {
        input: snapshot({
          market: { ...snapshot().market, authority: "unknown" },
        }),
        reason: "market-authority-mismatch",
      },
      {
        input: snapshot({
          market: { ...snapshot().market, treasury: "other-treasury" },
        }),
        reason: "market-recipient-mismatch",
      },
      {
        input: snapshot({
          market: { ...snapshot().market, tradeTreasuryFeeBps: 101 },
        }),
        reason: "market-fee-mismatch",
      },
    ];

    for (const entry of cases) {
      expect(deriveSolanaMarketAuthorityState(entry.input)).toMatchObject({
        valid: false,
        tradingReady: false,
        reason: entry.reason,
      });
    }
  });

  test("keeps a verified paused market visible but never tradeable", () => {
    const input = snapshot();
    input.config.orderPlacementPaused = true;

    expect(deriveSolanaMarketAuthorityState(input)).toEqual({
      valid: true,
      tradingReady: false,
      reason: "order-placement-paused",
    });
  });

  test("retains exact market identity but disables actions through a transient read gap", () => {
    const marketState = { address: "market-state" };
    const loaded = {
      duelKeyHex: DUEL_KEY,
      marketStatus: "open",
      winner: "a" as string | null,
      tradingReady: true,
      marketState,
    };

    const failedClosed = failClosedSolanaMarketSnapshot(loaded, DUEL_KEY);
    expect(failedClosed).toEqual({
      ...loaded,
      marketStatus: "unavailable",
      winner: null,
      tradingReady: false,
    });
    expect(failedClosed?.marketState).toBe(marketState);
    expect(failClosedSolanaMarketSnapshot(loaded, "cd".repeat(32))).toBeNull();
    expect(failClosedSolanaMarketSnapshot(loaded, null)).toBeNull();
  });

  test("keeps a canonical closed market visible after config rotation", () => {
    const input = snapshot({ requireCurrentConfig: false });
    input.config.authority = "rotated-authority";
    input.config.marketOperator = "rotated-operator";
    input.config.treasury = "rotated-treasury";
    input.config.marketMaker = "rotated-market-maker";
    input.config.tradeTreasuryFeeBps = 250;

    expect(deriveSolanaMarketAuthorityState(input)).toEqual({
      valid: true,
      tradingReady: false,
      reason: null,
    });
  });
});
