import type { MitigationGate } from "./solana-scenario-types.js";

import type {
  ScenarioGatePolicy,
  ScenarioPreset,
  ScenarioSettlementStatus,
} from "./solana-scenario-catalog.js";

export type ScenarioEvaluationMetrics = {
  attackerPnl: number;
  maxDrawdownBps: number;
  quoteUptimeRatio: number;
  orderChurn: number;
  degraded: boolean;
  mmSolvent: boolean;
  bookNotCrossed: boolean;
  settlementConsistent: boolean;
  claimsProcessed: boolean;
  settlementStatus: ScenarioSettlementStatus;
  staleStreamGuardTrips: number;
  staleOracleGuardTrips: number;
  closeGuardTrips: number;
};

function pushPolicyGate(
  gates: MitigationGate[],
  name: string,
  passed: boolean,
  reason: string | null,
): void {
  gates.push({
    name,
    passed,
    reason: passed ? null : reason,
  });
}

export function evaluateScenarioPolicyGates(
  preset: ScenarioPreset,
  metrics: ScenarioEvaluationMetrics,
): MitigationGate[] {
  const policy: ScenarioGatePolicy | undefined = preset.gatePolicy;
  if (!policy) {
    return [];
  }

  const gates: MitigationGate[] = [];

  if (policy.requireDegradationFree) {
    pushPolicyGate(
      gates,
      "degradationFree",
      !metrics.degraded,
      "scenario required a degraded completion path",
    );
  }
  if (policy.requireMmSolvent) {
    pushPolicyGate(
      gates,
      "scenarioMmSolvent",
      metrics.mmSolvent,
      "market-maker wallet depleted during scenario",
    );
  }
  if (policy.requireBookIntegrity) {
    pushPolicyGate(
      gates,
      "scenarioBookIntegrity",
      metrics.bookNotCrossed,
      "crossed book observed during scenario",
    );
  }
  if (policy.requireStaleStreamGuard) {
    pushPolicyGate(
      gates,
      "staleStreamGuardTriggered",
      metrics.staleStreamGuardTrips > 0,
      "stale stream guard never triggered",
    );
  }
  if (policy.requireStaleOracleGuard) {
    pushPolicyGate(
      gates,
      "staleOracleGuardTriggered",
      metrics.staleOracleGuardTrips > 0,
      "stale oracle guard never triggered",
    );
  }
  if (policy.requireCloseGuard) {
    pushPolicyGate(
      gates,
      "closeGuardTriggered",
      metrics.closeGuardTrips > 0,
      "bet close guard never triggered",
    );
  }
  if (policy.requireSettlementConsistency) {
    pushPolicyGate(
      gates,
      "scenarioSettlementConsistent",
      metrics.settlementConsistent,
      "settlement outcome was inconsistent with market state",
    );
  }
  if (policy.requireClaimsProcessed) {
    pushPolicyGate(
      gates,
      "scenarioClaimsProcessed",
      metrics.claimsProcessed,
      "settled market retained claimable or uncleared positions",
    );
  }
  if (policy.expectedSettlementStatus) {
    pushPolicyGate(
      gates,
      "expectedSettlementObserved",
      metrics.settlementStatus === policy.expectedSettlementStatus,
      `expected ${policy.expectedSettlementStatus.toLowerCase()} but observed ${metrics.settlementStatus.toLowerCase()}`,
    );
  }
  if (policy.maxAttackerPnl != null) {
    pushPolicyGate(
      gates,
      "attackerEdgeBounded",
      metrics.attackerPnl <= policy.maxAttackerPnl,
      `attacker pnl peaked at ${metrics.attackerPnl.toFixed(4)} ETH`,
    );
  }
  if (policy.maxDrawdownBps != null) {
    pushPolicyGate(
      gates,
      "drawdownBounded",
      metrics.maxDrawdownBps <= policy.maxDrawdownBps,
      `market-maker drawdown reached ${metrics.maxDrawdownBps} bps`,
    );
  }
  if (policy.minQuoteUptimeRatio != null) {
    pushPolicyGate(
      gates,
      "quoteUptimeFloor",
      metrics.quoteUptimeRatio >= policy.minQuoteUptimeRatio,
      `quote uptime ratio fell to ${metrics.quoteUptimeRatio.toFixed(3)}`,
    );
  }
  if (policy.maxQuoteUptimeRatio != null) {
    pushPolicyGate(
      gates,
      "quoteUptimeCap",
      metrics.quoteUptimeRatio <= policy.maxQuoteUptimeRatio,
      `quote uptime ratio stayed too high at ${metrics.quoteUptimeRatio.toFixed(3)}`,
    );
  }
  if (policy.maxOrderChurn != null) {
    pushPolicyGate(
      gates,
      "orderChurnBounded",
      metrics.orderChurn <= policy.maxOrderChurn,
      `order churn reached ${metrics.orderChurn}`,
    );
  }

  return gates;
}
