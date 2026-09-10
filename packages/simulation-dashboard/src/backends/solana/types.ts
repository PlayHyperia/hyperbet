import type {
  AgentActionTrace,
  MitigationGate,
} from "../../solana-scenario-types.js";

import type { ScenarioPreset } from "../../solana-scenario-catalog.js";

export type SolanaSettlementStatus =
  | "NULL"
  | "OPEN"
  | "LOCKED"
  | "RESOLVED"
  | "CANCELLED";

export type SolanaBalanceSnapshot = {
  lamports: bigint;
  pnlSol: number;
};

export type SolanaPositionSnapshot = {
  aShares: bigint;
  bShares: bigint;
  aLockedLamports: bigint;
  bLockedLamports: bigint;
};

export type SolanaActorSnapshot = {
  name: string;
  role: string;
  description: string;
  color: string;
  address: string;
  tradeCount: number;
  activeOrders: number;
  balance: SolanaBalanceSnapshot;
  position: SolanaPositionSnapshot;
};

export type SolanaBookLevel = {
  price: number;
  total: bigint;
};

export type SolanaProofOutcome = {
  preset: ScenarioPreset;
  seed: string;
  winner: "A" | "B";
  duelLabel: string;
  duelKeyHex: string;
  marketRef: string;
  rpcUrl: string;
  contracts: {
    oracle: string;
    clob: string;
  };
  fees: {
    treasuryBps: number;
    mmBps: number;
    winningsMmBps: number;
    treasuryAccruedLamports: bigint;
    mmAccruedLamports: bigint;
  };
  actors: SolanaActorSnapshot[];
  book: {
    bids: SolanaBookLevel[];
    asks: SolanaBookLevel[];
  };
  traces: AgentActionTrace[];
  attackRejected: boolean;
  staleStreamGuardTrips: number;
  staleOracleGuardTrips: number;
  closeGuardTrips: number;
  peakInventory: number;
  quoteChecks: number;
  quoteActiveChecks: number;
  orderChurn: number;
  lockTransitionLatencyMs: number | null;
  resolvedCorrectly: boolean;
  claimCorrectly: boolean;
  settlementStatus: SolanaSettlementStatus;
  settlementStatusCode: number;
  winnerCode: number;
  winnerLabel: "A" | "B" | "NONE";
  totalAShares: bigint;
  totalBShares: bigint;
  bestBid: number;
  bestAsk: number;
  marketMakerPnl: number;
  attackerPnl: number;
  treasuryPnl: number;
  marketMakerDrawdownBps: number;
  claimsProcessed: boolean;
  bookNotCrossed: boolean;
  mmSolvent: boolean;
  degraded: boolean;
  debug?: Record<string, unknown>;
};

export type SolanaMitigationMetrics = {
  attackerPnlCurrent: number;
  attackerPnlPeak: number;
  marketMakerPnl: number;
  protocolMarketMakerPnl: number;
  marketMakerDrawdownBps: number;
  peakInventory: number;
  spreadWidthBps: number;
  orderChurn: number;
  staleStreamGuardTrips: number;
  staleOracleGuardTrips: number;
  closeGuardTrips: number;
  circuitBreakerTrips: number;
  settlementConsistent: boolean;
  claimsProcessed: boolean;
  settlementStatus: SolanaSettlementStatus;
};

export type SolanaScenarioSummary = {
  preset: ScenarioPreset;
  seed: string;
  winner: "A" | "B";
  duelLabel: string;
  duelKeyHex: string;
  marketRef: string;
  backend: "solana";
  rpcUrl: string;
  contracts: {
    oracle: string;
    clob: string;
  };
  fees: {
    treasuryBps: number;
    mmBps: number;
    winningsMmBps: number;
    treasuryAccruedLamports: bigint;
    mmAccruedLamports: bigint;
  };
  market: {
    statusCode: number;
    statusLabel: SolanaSettlementStatus;
    winnerCode: number;
    winnerLabel: "A" | "B" | "NONE";
    bestBid: number;
    bestAsk: number;
    totalAShares: bigint;
    totalBShares: bigint;
  };
  actors: SolanaActorSnapshot[];
  book: {
    bids: SolanaBookLevel[];
    asks: SolanaBookLevel[];
  };
  traces: AgentActionTrace[];
  mitigationGates: MitigationGate[];
  scenarioGates: MitigationGate[];
  metrics: SolanaMitigationMetrics;
  lockTransitionLatencyMs: number | null;
  resolvedCorrectly: boolean;
  claimCorrectly: boolean;
  degraded: boolean;
  debug?: Record<string, unknown>;
};
