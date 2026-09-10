export interface AgentActionTrace {
  actor: string;
  action: string;
  chainKey: "solana";
  duelKey: string | null;
  marketRef: string | null;
  price: number | null;
  units: number | null;
  txRef: string | null;
  ok: boolean;
  message?: string;
}

export interface MitigationGate {
  name: string;
  passed: boolean;
  reason: string | null;
}

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  family: string;
  seed: string;
  chainKey: "solana";
  attackerPnl: number;
  marketMakerPnl: number;
  maxDrawdownBps: number;
  peakInventory: number;
  quoteUptimeRatio: number;
  spreadWidthBps: number;
  orderChurn: number;
  lockTransitionLatencyMs: number | null;
  resolvedCorrectly: boolean;
  claimCorrectly: boolean;
  passed: boolean;
  degraded: boolean;
  gates: MitigationGate[];
  traces: AgentActionTrace[];
}
