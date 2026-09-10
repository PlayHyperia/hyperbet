import { describe, expect, test } from "bun:test";

import type { KeeperMarketHealthRecord } from "./launchHealth";
import {
  buildKeeperOperatorMetrics,
  parseKeeperOperatorMetrics,
} from "./keeperOperatorMetrics";

function market(
  overrides: Partial<KeeperMarketHealthRecord> = {},
): KeeperMarketHealthRecord {
  return {
    chainKey: "solana",
    duelId: "duel-1",
    duelKey: "11".repeat(32),
    marketRef: "market-1",
    lifecycleStatus: "RESOLVED",
    winner: "A",
    fairValue: null,
    bidPrice: null,
    askPrice: null,
    bidUnits: 0,
    askUnits: 0,
    openOrderCount: 2,
    inventoryYes: 0,
    inventoryNo: 0,
    openYes: 0,
    openNo: 0,
    netExposure: 0,
    grossExposure: 0,
    drawdownBps: 0,
    quoteAgeMs: 400,
    lastStreamAtMs: 9_000,
    lastOracleAtMs: 9_100,
    lastRpcAtMs: 9_200,
    circuitBreakerReason: null,
    lastResolvedAtMs: 5_000,
    lastClaimAtMs: 8_000,
    recovery: ["partial-claim"],
    ...overrides,
  };
}

describe("keeper operator metrics", () => {
  test("projects exact feed, market, terminal, settlement, and claim telemetry", () => {
    const metrics = buildKeeperOperatorMetrics({
      nowMs: 10_000,
      checkpoint: {
        sourceEpoch: 3,
        lastAppliedSeq: 7,
        lastEmittedAt: 8_000,
        duelId: "duel-1",
        competitiveSnapshotDigest: "aa".repeat(32),
        phase: "RESOLUTION",
        terminal: true,
        terminalEventKey: "terminal-1",
        degradedReason: null,
        updatedAt: 9_500,
      },
      terminal: {
        summary: {
          PENDING: 1,
          PROCESSING: 0,
          SUCCEEDED: 3,
          MANUAL_REVIEW: 1,
          DEAD_LETTER: 0,
        },
        oldestActionableCreatedAt: 7_000,
        recentSucceededDurationsMs: [900, 100, 400],
      },
      markets: [market(), market({ lifecycleStatus: "OPEN", quoteAgeMs: 900 })],
    });

    expect(metrics).toMatchObject({
      schemaVersion: 1,
      observedAtMs: 10_000,
      feed: {
        checkpointPresent: true,
        sourceEventLagMs: 2_000,
        checkpointWriteLagMs: 500,
        lastAppliedSeq: 7,
        degraded: false,
      },
      markets: {
        retainedCount: 2,
        openOrderCount: 4,
        maxQuoteAgeMs: 900,
      },
      terminal: {
        actionableCount: 2,
        oldestActionableAgeMs: 3_000,
        completionLatency: {
          sampleCount: 3,
          p50Ms: 400,
          p95Ms: 900,
          maxMs: 900,
        },
      },
      claims: {
        pendingMarketMakerCount: 2,
        observedMarketMakerCount: 2,
        invalidTimingCount: 0,
        latencyFromResolution: {
          sampleCount: 2,
          p50Ms: 3_000,
          p95Ms: 3_000,
          maxMs: 3_000,
        },
      },
    });
    expect(metrics.markets.lifecycleCounts).toEqual({
      PENDING: 0,
      OPEN: 1,
      LOCKED: 0,
      PROPOSED: 0,
      CHALLENGED: 0,
      RESOLVED: 1,
      CANCELLED: 0,
      UNKNOWN: 0,
    });
    expect(parseKeeperOperatorMetrics(metrics)).toEqual(metrics);
  });

  test("reports missing checkpoints and invalid claim timing without inventing latency", () => {
    const metrics = buildKeeperOperatorMetrics({
      nowMs: 10_000,
      checkpoint: null,
      terminal: {
        summary: {
          PENDING: 0,
          PROCESSING: 0,
          SUCCEEDED: 0,
          MANUAL_REVIEW: 0,
          DEAD_LETTER: 0,
        },
        oldestActionableCreatedAt: null,
        recentSucceededDurationsMs: [],
      },
      markets: [market({ lastResolvedAtMs: 9_000, lastClaimAtMs: 8_000 })],
    });

    expect(metrics.feed).toEqual({
      checkpointPresent: false,
      sourceEventLagMs: null,
      checkpointWriteLagMs: null,
      lastAppliedSeq: null,
      degraded: false,
    });
    expect(metrics.claims.invalidTimingCount).toBe(1);
    expect(metrics.claims.latencyFromResolution).toEqual({
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });
  });

  test("rejects internally inconsistent serialized projections", () => {
    const metrics = buildKeeperOperatorMetrics({
      nowMs: 1_000,
      checkpoint: null,
      terminal: {
        summary: {
          PENDING: 0,
          PROCESSING: 0,
          SUCCEEDED: 0,
          MANUAL_REVIEW: 0,
          DEAD_LETTER: 0,
        },
        oldestActionableCreatedAt: null,
        recentSucceededDurationsMs: [],
      },
      markets: [],
    });

    expect(
      parseKeeperOperatorMetrics({
        ...metrics,
        markets: { ...metrics.markets, retainedCount: 1 },
      }),
    ).toBeNull();
    expect(
      parseKeeperOperatorMetrics({
        ...metrics,
        feed: { ...metrics.feed, checkpointPresent: true },
      }),
    ).toBeNull();
    expect(
      parseKeeperOperatorMetrics({
        ...metrics,
        terminal: { ...metrics.terminal, actionableCount: 1 },
      }),
    ).toBeNull();
    expect(
      parseKeeperOperatorMetrics({
        ...metrics,
        feed: { ...metrics.feed, degraded: true },
      }),
    ).toBeNull();
    expect(
      parseKeeperOperatorMetrics({
        ...metrics,
        claims: { ...metrics.claims, observedMarketMakerCount: 1 },
      }),
    ).toBeNull();
  });
});
