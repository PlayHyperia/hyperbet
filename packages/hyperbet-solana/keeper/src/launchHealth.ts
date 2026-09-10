import type {
  PredictionMarketLifecycleRecord,
  PredictionMarketLifecycleStatus,
  PredictionMarketWinner,
} from "./solanaLifecycle";
import { normalizeDuelCorrelationIds } from "./duelCorrelation";
import type { KeeperOperatorMetrics } from "./keeperOperatorMetrics";
import type { KeeperRuntimeIdentity } from "./runtimeIdentity";

export interface KeeperRecoveryState {
  code: string;
  active: boolean;
  sinceMs: number | null;
  untilMs: number | null;
  details: string | null;
  correlationIds?: string[];
}

export interface KeeperMarketHealthRecord {
  chainKey: "solana";
  duelId: string | null;
  duelKey: string | null;
  correlationId?: string | null;
  marketRef: string | null;
  lifecycleStatus: PredictionMarketLifecycleStatus;
  winner: PredictionMarketWinner;
  fairValue: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidUnits: number;
  askUnits: number;
  openOrderCount: number;
  inventoryYes: number;
  inventoryNo: number;
  openYes: number;
  openNo: number;
  netExposure: number;
  grossExposure: number;
  drawdownBps: number;
  quoteAgeMs: number | null;
  lastStreamAtMs: number | null;
  lastOracleAtMs: number | null;
  lastRpcAtMs: number | null;
  circuitBreakerReason: string | null;
  lastResolvedAtMs: number | null;
  lastClaimAtMs: number | null;
  recovery: string[];
}

// A non-empty terminal queue is normal while finalized work is durably
// crossing the dispute window. Correlation projection must use the exact same
// incident policy as readiness so normal duel turnover cannot churn alerts.
const EXPECTED_ACTIVE_RECOVERY_CODES = new Set([
  "awaiting-result",
  "terminal-queue",
]);
const EXPECTED_MARKET_CIRCUIT_BREAKERS = new Set([
  "bet-close-guard",
  "market:locked",
]);
const EXPECTED_MARKET_RECOVERY_MARKERS = new Set([
  "awaiting-authoritative-result",
]);

export function isKeeperRecoveryIncident(state: KeeperRecoveryState): boolean {
  return state.active && !EXPECTED_ACTIVE_RECOVERY_CODES.has(state.code);
}

export function isKeeperMarketCircuitBreakerIncident(
  market: KeeperMarketHealthRecord,
): boolean {
  const isTerminalMarket =
    market.lifecycleStatus === "RESOLVED" ||
    market.lifecycleStatus === "CANCELLED";
  return Boolean(
    market.circuitBreakerReason &&
    !isTerminalMarket &&
    !EXPECTED_MARKET_CIRCUIT_BREAKERS.has(market.circuitBreakerReason),
  );
}

export function isKeeperMarketRecoveryIncident(
  market: KeeperMarketHealthRecord,
  terminalWorkActive: boolean,
): boolean {
  return market.recovery.some(
    (marker) =>
      !EXPECTED_MARKET_RECOVERY_MARKERS.has(marker) &&
      !(marker === "partial-claim" && terminalWorkActive),
  );
}

export function isKeeperMarketIncident(
  market: KeeperMarketHealthRecord,
  terminalWorkActive: boolean,
): boolean {
  return (
    isKeeperMarketCircuitBreakerIncident(market) ||
    market.lifecycleStatus === "CHALLENGED" ||
    isKeeperMarketRecoveryIncident(market, terminalWorkActive)
  );
}

export function collectActiveKeeperCorrelationIds(
  snapshot: KeeperBotHealthSnapshot | null,
): string[] {
  if (!snapshot) return [];
  const terminalWorkActive = snapshot.recovery.some(
    (state) => state.active && state.code === "terminal-queue",
  );
  return normalizeDuelCorrelationIds([
    ...snapshot.recovery
      .filter(isKeeperRecoveryIncident)
      .flatMap((state) => state.correlationIds ?? []),
    ...snapshot.markets
      .filter((market) => isKeeperMarketIncident(market, terminalWorkActive))
      .map((market) => market.correlationId),
  ]);
}

export interface KeeperBotHealthSnapshot {
  chainKey: "solana";
  releaseCommitSha: string | null;
  runtime?: KeeperRuntimeIdentity;
  updatedAtMs: number;
  bootedAtMs: number;
  running: boolean;
  processId: number | null;
  lastSuccessfulRpcAtMs: number | null;
  recovery: KeeperRecoveryState[];
  markets: KeeperMarketHealthRecord[];
  operatorMetrics: KeeperOperatorMetrics;
}

export interface PredictionMarketStatusRecord extends PredictionMarketLifecycleRecord {
  health: KeeperMarketHealthRecord | null;
}

export function mergePredictionMarketsWithHealth(
  records: readonly PredictionMarketLifecycleRecord[],
  botHealth: KeeperBotHealthSnapshot | null,
): PredictionMarketStatusRecord[] {
  return records.map((record) => {
    const health =
      botHealth?.markets.find(
        (candidate) =>
          (candidate.marketRef != null &&
            record.marketRef != null &&
            candidate.marketRef === record.marketRef) ||
          (candidate.duelKey != null &&
            record.duelKey != null &&
            candidate.duelKey === record.duelKey),
      ) ?? null;
    return { ...record, health };
  });
}
