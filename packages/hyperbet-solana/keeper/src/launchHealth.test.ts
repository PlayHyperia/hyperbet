import { describe, expect, test } from "bun:test";

import {
  collectActiveKeeperCorrelationIds,
  mergePredictionMarketsWithHealth,
  type KeeperBotHealthSnapshot,
} from "./launchHealth";
import { buildDuelCorrelationId } from "./duelCorrelation";
import { buildKeeperOperatorMetrics } from "./keeperOperatorMetrics";
import type { PredictionMarketLifecycleRecord } from "./solanaLifecycle";

const DUEL_BOT_RUNTIME = {
  schemaVersion: 1,
  role: "duel-bot",
  cluster: "devnet",
  fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
  duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
} as const;

function lifecycleRecord(): PredictionMarketLifecycleRecord {
  return {
    chainKey: "solana",
    duelKey: "duel-key",
    duelId: "duel-1",
    marketId: "market-1",
    marketRef: "market-1",
    lifecycleStatus: "OPEN",
    winner: "NONE",
    betCloseTime: null,
    contractAddress: null,
    programId: "program-1",
    txRef: null,
    syncedAt: 1,
  };
}

function health(): KeeperBotHealthSnapshot {
  const markets: KeeperBotHealthSnapshot["markets"] = [
    {
      chainKey: "solana",
      duelId: "duel-1",
      duelKey: "duel-key",
      marketRef: "market-1",
      lifecycleStatus: "OPEN",
      winner: "NONE",
      fairValue: 500,
      bidPrice: 490,
      askPrice: 510,
      bidUnits: 50,
      askUnits: 50,
      openOrderCount: 2,
      inventoryYes: 10,
      inventoryNo: 5,
      openYes: 40,
      openNo: 40,
      netExposure: 5,
      grossExposure: 95,
      drawdownBps: 0,
      quoteAgeMs: 1_000,
      lastStreamAtMs: 900,
      lastOracleAtMs: 901,
      lastRpcAtMs: 902,
      circuitBreakerReason: null,
      lastResolvedAtMs: null,
      lastClaimAtMs: null,
      recovery: [],
    },
  ];
  return {
    chainKey: "solana",
    releaseCommitSha: null,
    runtime: DUEL_BOT_RUNTIME,
    updatedAtMs: 1_000,
    bootedAtMs: 100,
    running: true,
    processId: 123,
    lastSuccessfulRpcAtMs: 999,
    recovery: [],
    markets,
    operatorMetrics: buildKeeperOperatorMetrics({
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
      markets,
    }),
  };
}

describe("SOL launch health projection", () => {
  test("merges by canonical market reference", () => {
    const result = mergePredictionMarketsWithHealth(
      [lifecycleRecord()],
      health(),
    );
    expect(result[0].health?.marketRef).toBe("market-1");
    expect(result[0].health?.openOrderCount).toBe(2);
  });

  test("falls back to the canonical duel key and never invents health", () => {
    const record = lifecycleRecord();
    record.marketRef = "reindexed-market";
    expect(
      mergePredictionMarketsWithHealth([record], health())[0].health?.duelKey,
    ).toBe("duel-key");
    expect(
      mergePredictionMarketsWithHealth([record], null)[0].health,
    ).toBeNull();
  });

  test("projects only active incident correlations", () => {
    const snapshot = health();
    const terminalCorrelation = buildDuelCorrelationId({
      duelId: "duel-terminal",
      duelKey: "11".repeat(32),
    });
    const healthyCorrelation = buildDuelCorrelationId({
      duelId: "duel-healthy",
      duelKey: "22".repeat(32),
    });
    snapshot.recovery = [
      {
        code: "terminal-manual-review",
        active: true,
        sinceMs: 1,
        untilMs: null,
        details: "operator review",
        correlationIds: [terminalCorrelation],
      },
      {
        code: "resolved",
        active: false,
        sinceMs: null,
        untilMs: null,
        details: null,
        correlationIds: [healthyCorrelation],
      },
    ];
    snapshot.markets[0]!.correlationId = healthyCorrelation;
    expect(collectActiveKeeperCorrelationIds(snapshot)).toEqual([
      terminalCorrelation,
    ]);
    snapshot.markets[0]!.recovery = ["orphan-order"];
    expect(collectActiveKeeperCorrelationIds(snapshot)).toEqual(
      [healthyCorrelation, terminalCorrelation].sort(),
    );
  });

  test("does not churn correlations for expected queue and market turnover", () => {
    const snapshot = health();
    const correlationId = buildDuelCorrelationId({
      duelId: "duel-expected",
      duelKey: "33".repeat(32),
    });
    snapshot.recovery = [
      {
        code: "terminal-queue",
        active: true,
        sinceMs: 1,
        untilMs: null,
        details: "one pending operation",
        correlationIds: [correlationId],
      },
    ];
    snapshot.markets[0]!.correlationId = correlationId;
    snapshot.markets[0]!.lifecycleStatus = "LOCKED";
    snapshot.markets[0]!.circuitBreakerReason = "market:locked";
    snapshot.markets[0]!.recovery = ["awaiting-authoritative-result"];
    expect(collectActiveKeeperCorrelationIds(snapshot)).toEqual([]);

    snapshot.markets[0]!.lifecycleStatus = "RESOLVED";
    snapshot.markets[0]!.circuitBreakerReason = "market:resolved";
    snapshot.markets[0]!.recovery = ["partial-claim"];
    expect(collectActiveKeeperCorrelationIds(snapshot)).toEqual([]);

    snapshot.recovery = [];
    expect(collectActiveKeeperCorrelationIds(snapshot)).toEqual([
      correlationId,
    ]);
  });
});
