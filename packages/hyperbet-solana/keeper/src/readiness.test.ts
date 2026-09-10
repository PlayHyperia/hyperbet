import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { KeeperBotHealthSnapshot } from "./launchHealth";
import { buildDuelCorrelationId } from "./duelCorrelation";
import { buildKeeperOperatorMetrics } from "./keeperOperatorMetrics";

import {
  evaluateKeeperReadiness,
  isAuthoritativeStreamSnapshot,
  parseKeeperBotHealthSnapshot,
  type KeeperReadinessInput,
} from "./readiness";

const NOW = 1_700_000_000_000;
const RELEASE_SHA = "a".repeat(40);
const DUEL_BOT_RUNTIME = {
  schemaVersion: 1,
  role: "duel-bot",
  cluster: "devnet",
  fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
  duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
} as const;

function operatorMetrics(
  nowMs: number,
  markets: KeeperBotHealthSnapshot["markets"],
) {
  return buildKeeperOperatorMetrics({
    nowMs,
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
  });
}

function healthyBot(): KeeperBotHealthSnapshot {
  const updatedAtMs = NOW - 1_000;
  const markets: KeeperBotHealthSnapshot["markets"] = [];
  return {
    chainKey: "solana",
    releaseCommitSha: RELEASE_SHA,
    runtime: DUEL_BOT_RUNTIME,
    updatedAtMs,
    bootedAtMs: NOW - 60_000,
    running: true,
    processId: 123,
    lastSuccessfulRpcAtMs: NOW - 500,
    recovery: [],
    markets,
    operatorMetrics: operatorMetrics(updatedAtMs, markets),
  };
}

function healthyInput(): KeeperReadinessInput {
  return {
    nowMs: NOW,
    release: {
      required: true,
      requireBakedManifest: true,
      commitSha: RELEASE_SHA,
      source: "manifest",
    },
    requireStreamSource: true,
    streamMaxAgeMs: 15_000,
    botMaxAgeMs: 30_000,
    parserMaxAgeMs: 30_000,
    stream: {
      sourceConfigured: true,
      authoritative: true,
      lastUpdatedAt: NOW - 1_000,
      lastSourceError: null,
    },
    bot: healthyBot(),
    expectedBotRuntimeIdentity: DUEL_BOT_RUNTIME,
    parser: {
      enabled: true,
      lastSuccessAt: NOW - 1_000,
      lastError: null,
    },
    database: { ok: true, error: null },
  };
}

describe("keeper service readiness", () => {
  test("accepts a fresh authoritative idle frame before the first cycle", () => {
    expect(isAuthoritativeStreamSnapshot("", "IDLE")).toBe(true);
    expect(isAuthoritativeStreamSnapshot(null, "IDLE")).toBe(true);
    expect(isAuthoritativeStreamSnapshot("cycle-1", "ANNOUNCEMENT")).toBe(true);
    expect(isAuthoritativeStreamSnapshot("boot-cycle", "IDLE")).toBe(false);
    expect(isAuthoritativeStreamSnapshot("", "ANNOUNCEMENT")).toBe(false);
  });

  test("rejects malformed or partial persisted bot-health snapshots", () => {
    expect(parseKeeperBotHealthSnapshot(null)).toBeNull();
    expect(
      parseKeeperBotHealthSnapshot({
        ...healthyBot(),
        markets: [{ lifecycleStatus: "OPEN" }],
      }),
    ).toBeNull();
    expect(parseKeeperBotHealthSnapshot(healthyBot())).toEqual(healthyBot());

    const withMetrics = healthyBot();
    expect(parseKeeperBotHealthSnapshot(withMetrics)).toEqual(withMetrics);
    const { operatorMetrics: _omitted, ...withoutMetrics } = withMetrics;
    expect(parseKeeperBotHealthSnapshot(withoutMetrics)).toBeNull();
    expect(
      parseKeeperBotHealthSnapshot({
        ...withMetrics,
        updatedAtMs: NOW + 1,
      }),
    ).toBeNull();
    expect(
      parseKeeperBotHealthSnapshot({
        ...withMetrics,
        markets: [{ lifecycleStatus: "OPEN", recovery: [] }],
      }),
    ).toBeNull();
    expect(
      parseKeeperBotHealthSnapshot({
        ...withMetrics,
        operatorMetrics: {
          ...withMetrics.operatorMetrics,
          schemaVersion: 2,
        },
      }),
    ).toBeNull();
  });

  test("accepts only canonical optional duel correlation identifiers", () => {
    const correlationId = buildDuelCorrelationId({
      duelId: "duel-1",
      duelKey: "11".repeat(32),
    });
    const correlated = healthyBot();
    correlated.recovery = [
      {
        code: "terminal-queue",
        active: true,
        sinceMs: NOW,
        untilMs: null,
        details: "one operation",
        correlationIds: [correlationId],
      },
    ];
    correlated.markets = [
      {
        chainKey: "solana",
        duelId: "duel-1",
        duelKey: "11".repeat(32),
        correlationId,
        marketRef: "market-1",
        lifecycleStatus: "OPEN",
        winner: "NONE",
        fairValue: null,
        bidPrice: null,
        askPrice: null,
        bidUnits: 0,
        askUnits: 0,
        openOrderCount: 0,
        inventoryYes: 0,
        inventoryNo: 0,
        openYes: 0,
        openNo: 0,
        netExposure: 0,
        grossExposure: 0,
        drawdownBps: 0,
        quoteAgeMs: null,
        lastStreamAtMs: NOW,
        lastOracleAtMs: NOW,
        lastRpcAtMs: NOW,
        circuitBreakerReason: null,
        lastResolvedAtMs: null,
        lastClaimAtMs: null,
        recovery: [],
      },
    ];
    correlated.operatorMetrics = operatorMetrics(
      correlated.updatedAtMs,
      correlated.markets,
    );
    expect(parseKeeperBotHealthSnapshot(correlated)).toEqual(correlated);
    expect(
      parseKeeperBotHealthSnapshot({
        ...correlated,
        recovery: [{ ...correlated.recovery[0], correlationIds: ["BAD"] }],
      }),
    ).toBeNull();
    expect(
      parseKeeperBotHealthSnapshot({
        ...correlated,
        markets: [{ ...correlated.markets[0], correlationId: "BAD" }],
      }),
    ).toBeNull();
  });

  test("never synthesizes keeper health from the service parser and validates restart state", () => {
    const serviceSource = readFileSync(
      new URL("./service.ts", import.meta.url),
      "utf8",
    );
    const duelBotSource = readFileSync(
      new URL("./duelBot.ts", import.meta.url),
      "utf8",
    );

    expect(serviceSource).not.toContain("toFallbackKeeperMarketHealthRecord");
    expect(serviceSource).not.toContain("resolveKeeperBotHealthSnapshot");
    const previousHealthReader = duelBotSource.indexOf(
      "function loadPreviousBotHealthSnapshot()",
    );
    const previousHealthParser = duelBotSource.indexOf(
      "parseKeeperBotHealthSnapshot(",
      previousHealthReader,
    );
    const openOrderRecovery = duelBotSource.indexOf(
      "previousBotHealthSnapshot?.markets.some",
      previousHealthReader,
    );
    expect(previousHealthReader).toBeGreaterThanOrEqual(0);
    expect(previousHealthParser).toBeGreaterThan(previousHealthReader);
    expect(openOrderRecovery).toBeGreaterThan(previousHealthParser);
  });

  test("is ready only when every launch dependency is current and healthy", () => {
    expect(evaluateKeeperReadiness(healthyInput())).toEqual({
      ready: true,
      reasons: [],
      agesMs: { stream: 1_000, bot: 1_000, botRpc: 500, parser: 1_000 },
    });
  });

  test("fails closed on stale stream, bot, or parser state", () => {
    const input = healthyInput();
    input.stream.lastUpdatedAt = NOW - 15_001;
    input.bot!.updatedAtMs = NOW - 30_001;
    input.bot!.lastSuccessfulRpcAtMs = NOW - 30_001;
    input.parser.lastSuccessAt = NOW - 30_001;
    expect(evaluateKeeperReadiness(input).reasons).toEqual([
      "stream-state-stale",
      "bot-health-stale",
      "bot-rpc-stale",
      "solana-parser-stale",
    ]);
  });

  test("fails closed on source, bot recovery, market, parser, and database errors", () => {
    const input = healthyInput();
    input.stream.lastSourceError = "upstream unavailable";
    input.bot!.recovery = [
      {
        code: "terminal-manual-review",
        active: true,
        sinceMs: NOW,
        untilMs: null,
        details: "one operation",
      },
    ];
    input.bot!.markets = [
      {
        chainKey: "solana",
        duelId: "duel-1",
        duelKey: null,
        marketRef: "market-1",
        lifecycleStatus: "CHALLENGED",
        winner: "NONE",
        fairValue: null,
        bidPrice: null,
        askPrice: null,
        bidUnits: 0,
        askUnits: 0,
        openOrderCount: 0,
        inventoryYes: 0,
        inventoryNo: 0,
        openYes: 0,
        openNo: 0,
        netExposure: 0,
        grossExposure: 0,
        drawdownBps: 0,
        quoteAgeMs: null,
        lastStreamAtMs: NOW,
        lastOracleAtMs: NOW,
        lastRpcAtMs: NOW,
        circuitBreakerReason: "stale stream",
        lastResolvedAtMs: null,
        lastClaimAtMs: null,
        recovery: ["position-reconcile-pending"],
      },
    ];
    input.parser.lastError = "RPC failed";
    input.database = { ok: false, error: "disk I/O" };

    expect(evaluateKeeperReadiness(input).reasons).toEqual([
      "stream-source-error",
      "bot-recovery:terminal-manual-review",
      "market-circuit-breaker",
      "market-result-challenged",
      "market-recovery-active",
      "solana-parser-error",
      "database-unhealthy",
    ]);
  });

  test("requires the production stream source and bot snapshot", () => {
    const input = healthyInput();
    input.stream.sourceConfigured = false;
    input.stream.authoritative = false;
    input.bot = null;
    expect(evaluateKeeperReadiness(input).reasons).toEqual([
      "stream-source-missing",
      "stream-state-unverified",
      "bot-health-missing",
    ]);
  });

  test("requires one baked release identity across the service and bot", () => {
    const input = healthyInput();
    input.release.commitSha = null;
    input.release.source = "unavailable";
    expect(evaluateKeeperReadiness(input).reasons).toEqual([
      "release-identity-unavailable",
      "bot-release-mismatch",
    ]);

    input.release.commitSha = RELEASE_SHA;
    input.release.source = "environment";
    expect(evaluateKeeperReadiness(input).reasons).toEqual([
      "release-identity-not-baked",
    ]);

    input.release.source = "manifest";
    input.bot!.releaseCommitSha = "b".repeat(40);
    expect(evaluateKeeperReadiness(input).reasons).toEqual([
      "bot-release-mismatch",
    ]);
  });

  test("fails readiness when the dedicated bot drifts from the service runtime identity", () => {
    const input = healthyInput();
    input.bot!.runtime = {
      ...DUEL_BOT_RUNTIME,
      cluster: "mainnet-beta",
    };
    expect(evaluateKeeperReadiness(input).reasons).toContain(
      "bot-runtime-identity-mismatch",
    );
  });

  test("does not treat expected terminal market markers as active circuit breakers", () => {
    const input = healthyInput();
    input.bot!.markets = [
      {
        chainKey: "solana",
        duelId: "duel-cancelled",
        duelKey: "ab".repeat(32),
        marketRef: "market-cancelled",
        lifecycleStatus: "CANCELLED",
        winner: "NONE",
        fairValue: 500,
        bidPrice: null,
        askPrice: null,
        bidUnits: 0,
        askUnits: 0,
        openOrderCount: 0,
        inventoryYes: 0,
        inventoryNo: 0,
        openYes: 0,
        openNo: 0,
        netExposure: 0,
        grossExposure: 0,
        drawdownBps: 0,
        quoteAgeMs: null,
        lastStreamAtMs: NOW,
        lastOracleAtMs: NOW,
        lastRpcAtMs: NOW,
        circuitBreakerReason: "market:cancelled",
        lastResolvedAtMs: NOW,
        lastClaimAtMs: null,
        recovery: [],
      },
    ];

    expect(evaluateKeeperReadiness(input)).toEqual({
      ready: true,
      reasons: [],
      agesMs: { stream: 1_000, bot: 1_000, botRpc: 500, parser: 1_000 },
    });
  });

  test("keeps expected bet-close and authoritative-result waits ready during a normal fight", () => {
    const input = healthyInput();
    input.bot!.recovery = [
      {
        code: "awaiting-result",
        active: true,
        sinceMs: NOW,
        untilMs: null,
        details: "1 locked duel waiting on authoritative result",
      },
    ];
    input.bot!.markets = [
      {
        ...input.bot!.markets[0]!,
        lifecycleStatus: "LOCKED",
        circuitBreakerReason: "market:locked",
        recovery: ["awaiting-authoritative-result"],
      },
      {
        ...input.bot!.markets[0]!,
        duelId: "duel-closing",
        duelKey: "22".repeat(32),
        marketRef: "market-closing",
        circuitBreakerReason: "bet-close-guard",
        recovery: [],
      },
    ];

    expect(evaluateKeeperReadiness(input)).toMatchObject({
      ready: true,
      reasons: [],
    });
  });

  test("keeps a healthy pending or processing terminal operation ready", () => {
    const input = healthyInput();
    input.bot!.recovery = [
      {
        code: "terminal-queue",
        active: true,
        sinceMs: NOW,
        untilMs: null,
        details: "1 pending and 0 processing terminal operations",
      },
    ];

    expect(evaluateKeeperReadiness(input)).toMatchObject({
      ready: true,
      reasons: [],
    });
  });

  test("keeps a pending terminal claim ready only while the durable queue owns it", () => {
    const input = healthyInput();
    input.bot!.recovery = [
      {
        code: "terminal-queue",
        active: true,
        sinceMs: NOW,
        untilMs: null,
        details: "1 pending and 0 processing terminal operations",
      },
    ];
    input.bot!.markets = [
      {
        ...input.bot!.markets[0]!,
        lifecycleStatus: "RESOLVED",
        recovery: ["partial-claim"],
      },
    ];

    expect(evaluateKeeperReadiness(input)).toMatchObject({
      ready: true,
      reasons: [],
    });

    input.bot!.recovery = [];
    expect(evaluateKeeperReadiness(input)).toMatchObject({
      ready: false,
      reasons: ["market-recovery-active"],
    });
  });

  test("continues to fail closed on a real restart reconciliation", () => {
    const input = healthyInput();
    input.bot!.recovery = [
      {
        code: "restart-reconcile",
        active: true,
        sinceMs: NOW,
        untilMs: null,
        details: "recovered an untracked active order",
      },
    ];

    expect(evaluateKeeperReadiness(input)).toMatchObject({
      ready: false,
      reasons: ["bot-recovery:restart-reconcile"],
    });
  });
});
