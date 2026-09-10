import type { KeeperMarketHealthRecord } from "./launchHealth";
import type { PredictionMarketLifecycleStatus } from "./solanaLifecycle";
import type {
  BettingFeedCheckpoint,
  TerminalLedgerOperationsTelemetry,
  TerminalLedgerSummary,
} from "./terminalLedger";

const LIFECYCLE_STATUSES = [
  "PENDING",
  "OPEN",
  "LOCKED",
  "PROPOSED",
  "CHALLENGED",
  "RESOLVED",
  "CANCELLED",
  "UNKNOWN",
] as const satisfies readonly PredictionMarketLifecycleStatus[];

const TERMINAL_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "MANUAL_REVIEW",
  "DEAD_LETTER",
] as const satisfies readonly (keyof TerminalLedgerSummary)[];

export type KeeperLatencySummary = {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type KeeperOperatorMetrics = {
  schemaVersion: 1;
  observedAtMs: number;
  feed: {
    checkpointPresent: boolean;
    sourceEventLagMs: number | null;
    checkpointWriteLagMs: number | null;
    lastAppliedSeq: number | null;
    degraded: boolean;
  };
  markets: {
    retainedCount: number;
    lifecycleCounts: Record<PredictionMarketLifecycleStatus, number>;
    openOrderCount: number;
    maxQuoteAgeMs: number | null;
  };
  terminal: {
    counts: TerminalLedgerSummary;
    actionableCount: number;
    oldestActionableAgeMs: number | null;
    completionLatency: KeeperLatencySummary;
  };
  claims: {
    pendingMarketMakerCount: number;
    observedMarketMakerCount: number;
    invalidTimingCount: number;
    latencyFromResolution: KeeperLatencySummary;
  };
};

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`);
  }
  return value;
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function ageMs(nowMs: number, timestamp: number | null): number | null {
  return timestamp == null ? null : Math.max(0, nowMs - timestamp);
}

function latencySummary(values: readonly number[]): KeeperLatencySummary {
  const sorted = values
    .map((value, index) => requireCount(value, `latency[${index}]`))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { sampleCount: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const percentile = (fraction: number): number =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

function lifecycleCounts(): Record<PredictionMarketLifecycleStatus, number> {
  return {
    PENDING: 0,
    OPEN: 0,
    LOCKED: 0,
    PROPOSED: 0,
    CHALLENGED: 0,
    RESOLVED: 0,
    CANCELLED: 0,
    UNKNOWN: 0,
  };
}

export function buildKeeperOperatorMetrics(input: {
  nowMs?: number;
  checkpoint: BettingFeedCheckpoint | null;
  terminal: TerminalLedgerOperationsTelemetry;
  markets: readonly KeeperMarketHealthRecord[];
}): KeeperOperatorMetrics {
  const observedAtMs = requireTimestamp(
    input.nowMs ?? Date.now(),
    "operator metrics observation",
  );
  const marketCounts = lifecycleCounts();
  let openOrderCount = 0;
  let maxQuoteAgeMs: number | null = null;
  let pendingMarketMakerCount = 0;
  let observedMarketMakerCount = 0;
  let invalidTimingCount = 0;
  const claimLatencies: number[] = [];

  for (const market of input.markets) {
    marketCounts[market.lifecycleStatus] += 1;
    openOrderCount += requireCount(
      market.openOrderCount,
      "market open-order count",
    );
    if (market.quoteAgeMs != null) {
      const quoteAgeMs = requireCount(market.quoteAgeMs, "market quote age");
      maxQuoteAgeMs = Math.max(maxQuoteAgeMs ?? 0, quoteAgeMs);
    }
    if (market.recovery.includes("partial-claim")) {
      pendingMarketMakerCount += 1;
    }
    if (market.lastClaimAtMs != null) {
      observedMarketMakerCount += 1;
      if (
        market.lastResolvedAtMs == null ||
        market.lastClaimAtMs < market.lastResolvedAtMs
      ) {
        invalidTimingCount += 1;
      } else {
        claimLatencies.push(market.lastClaimAtMs - market.lastResolvedAtMs);
      }
    }
  }

  const terminalCounts = { ...input.terminal.summary };
  for (const status of TERMINAL_STATUSES) {
    requireCount(terminalCounts[status], `terminal ${status} count`);
  }
  const actionableCount =
    terminalCounts.PENDING +
    terminalCounts.PROCESSING +
    terminalCounts.MANUAL_REVIEW +
    terminalCounts.DEAD_LETTER;
  const checkpoint = input.checkpoint;

  return {
    schemaVersion: 1,
    observedAtMs,
    feed: {
      checkpointPresent: checkpoint !== null,
      sourceEventLagMs: ageMs(observedAtMs, checkpoint?.lastEmittedAt ?? null),
      checkpointWriteLagMs: ageMs(observedAtMs, checkpoint?.updatedAt ?? null),
      lastAppliedSeq: checkpoint?.lastAppliedSeq ?? null,
      degraded: Boolean(checkpoint?.degradedReason),
    },
    markets: {
      retainedCount: input.markets.length,
      lifecycleCounts: marketCounts,
      openOrderCount,
      maxQuoteAgeMs,
    },
    terminal: {
      counts: terminalCounts,
      actionableCount,
      oldestActionableAgeMs: ageMs(
        observedAtMs,
        input.terminal.oldestActionableCreatedAt,
      ),
      completionLatency: latencySummary(
        input.terminal.recentSucceededDurationsMs,
      ),
    },
    claims: {
      pendingMarketMakerCount,
      observedMarketMakerCount,
      invalidTimingCount,
      latencyFromResolution: latencySummary(claimLatencies),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isLatencySummary(value: unknown): value is KeeperLatencySummary {
  if (!isRecord(value) || !isCount(value.sampleCount)) return false;
  if (
    !isNullableCount(value.p50Ms) ||
    !isNullableCount(value.p95Ms) ||
    !isNullableCount(value.maxMs)
  ) {
    return false;
  }
  if (value.sampleCount === 0) {
    return value.p50Ms === null && value.p95Ms === null && value.maxMs === null;
  }
  return (
    value.p50Ms !== null &&
    value.p95Ms !== null &&
    value.maxMs !== null &&
    value.p50Ms <= value.p95Ms &&
    value.p95Ms <= value.maxMs
  );
}

export function parseKeeperOperatorMetrics(
  value: unknown,
): KeeperOperatorMetrics | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (!isCount(value.observedAtMs)) return null;
  if (
    !isRecord(value.feed) ||
    typeof value.feed.checkpointPresent !== "boolean" ||
    !isNullableCount(value.feed.sourceEventLagMs) ||
    !isNullableCount(value.feed.checkpointWriteLagMs) ||
    !isNullableCount(value.feed.lastAppliedSeq) ||
    typeof value.feed.degraded !== "boolean"
  ) {
    return null;
  }
  if (
    value.feed.checkpointPresent !==
    (value.feed.lastAppliedSeq !== null &&
      value.feed.sourceEventLagMs !== null &&
      value.feed.checkpointWriteLagMs !== null)
  ) {
    return null;
  }
  if (!value.feed.checkpointPresent && value.feed.degraded) return null;
  if (!isRecord(value.markets)) return null;
  const markets = value.markets;
  if (
    !isCount(markets.retainedCount) ||
    !isRecord(markets.lifecycleCounts) ||
    !isCount(markets.openOrderCount) ||
    !isNullableCount(markets.maxQuoteAgeMs)
  ) {
    return null;
  }
  const marketLifecycleCounts = markets.lifecycleCounts;
  if (
    LIFECYCLE_STATUSES.some(
      (status) => !isCount(marketLifecycleCounts[status]),
    ) ||
    LIFECYCLE_STATUSES.reduce(
      (sum, status) => sum + Number(marketLifecycleCounts[status] ?? 0),
      0,
    ) !== markets.retainedCount
  ) {
    return null;
  }
  if (!isRecord(value.terminal)) return null;
  const terminal = value.terminal;
  if (
    !isRecord(terminal.counts) ||
    !isCount(terminal.actionableCount) ||
    !isNullableCount(terminal.oldestActionableAgeMs) ||
    !isLatencySummary(terminal.completionLatency)
  ) {
    return null;
  }
  const terminalCounts = terminal.counts;
  if (TERMINAL_STATUSES.some((status) => !isCount(terminalCounts[status]))) {
    return null;
  }
  const expectedActionable =
    Number(terminalCounts.PENDING) +
    Number(terminalCounts.PROCESSING) +
    Number(terminalCounts.MANUAL_REVIEW) +
    Number(terminalCounts.DEAD_LETTER);
  if (terminal.actionableCount !== expectedActionable) return null;
  if (
    (terminal.actionableCount === 0) !==
      (terminal.oldestActionableAgeMs === null) ||
    Number(terminal.completionLatency.sampleCount) >
      Math.min(Number(terminalCounts.SUCCEEDED), 100)
  ) {
    return null;
  }
  if (
    !isRecord(value.claims) ||
    !isCount(value.claims.pendingMarketMakerCount) ||
    !isCount(value.claims.observedMarketMakerCount) ||
    !isCount(value.claims.invalidTimingCount) ||
    !isLatencySummary(value.claims.latencyFromResolution)
  ) {
    return null;
  }
  if (
    Number(value.claims.pendingMarketMakerCount) >
      Number(markets.retainedCount) ||
    Number(value.claims.observedMarketMakerCount) >
      Number(markets.retainedCount) ||
    Number(value.claims.invalidTimingCount) >
      Number(value.claims.observedMarketMakerCount) ||
    Number(value.claims.observedMarketMakerCount) !==
      Number(value.claims.invalidTimingCount) +
        Number(value.claims.latencyFromResolution.sampleCount)
  ) {
    return null;
  }
  return value as unknown as KeeperOperatorMetrics;
}
