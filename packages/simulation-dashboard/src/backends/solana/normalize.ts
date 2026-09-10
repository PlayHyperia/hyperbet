import type {
  AgentActionTrace,
  MitigationGate,
  ScenarioResult,
} from "../../solana-scenario-types.js";

import { evaluateScenarioPolicyGates } from "../../scenario-evaluator.js";
import type {
  SolanaProofOutcome,
  SolanaScenarioSummary,
  SolanaSettlementStatus,
} from "./types.js";

function pushGate(
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

const LAMPORTS_PER_SOL = 1_000_000_000;

function lamportsToSol(value: bigint): number {
  return Number(value) / LAMPORTS_PER_SOL;
}

function buildMitigationGates(outcome: SolanaProofOutcome): {
  gates: MitigationGate[];
  scenarioGates: MitigationGate[];
} {
  const gates: MitigationGate[] = [];

  pushGate(
    gates,
    "mmSolvent",
    outcome.mmSolvent,
    "market-maker wallet depleted on Solana proof run",
  );
  pushGate(
    gates,
    "bookNotCrossed",
    outcome.bookNotCrossed,
    "best bid crossed best ask in Solana proof run",
  );
  pushGate(
    gates,
    "noPositiveAttackerPnl",
    outcome.attackerPnl <= 0,
    `attacker pnl peaked at ${outcome.attackerPnl.toFixed(6)} SOL`,
  );
  pushGate(
    gates,
    "settlementConsistent",
    outcome.resolvedCorrectly,
    `expected resolved ${outcome.winner} winner but observed ${outcome.winnerLabel}`,
  );
  pushGate(
    gates,
    "claimsProcessed",
    outcome.claimsProcessed,
    "winning claimable balance did not clear cleanly",
  );

  if (
    outcome.traces.some(
      (trace) =>
        trace.action === "unauthorized_report" ||
        trace.action.endsWith("_rejected"),
    )
  ) {
    pushGate(
      gates,
      "adversarialActionRejected",
      outcome.attackRejected,
      "adversarial Solana action was not rejected",
    );
  }

  const scenarioGates = evaluateScenarioPolicyGates(outcome.preset, {
    attackerPnl: outcome.attackerPnl,
    maxDrawdownBps: outcome.marketMakerDrawdownBps,
    quoteUptimeRatio:
      outcome.quoteChecks > 0
        ? outcome.quoteActiveChecks / outcome.quoteChecks
        : 0,
    orderChurn: outcome.orderChurn,
    degraded: outcome.degraded,
    mmSolvent: outcome.mmSolvent,
    bookNotCrossed: outcome.bookNotCrossed,
    settlementConsistent: outcome.resolvedCorrectly,
    claimsProcessed: outcome.claimsProcessed,
    settlementStatus: outcome.settlementStatus as SolanaSettlementStatus,
    staleStreamGuardTrips: outcome.staleStreamGuardTrips,
    staleOracleGuardTrips: outcome.staleOracleGuardTrips,
    closeGuardTrips: outcome.closeGuardTrips,
  });

  return { gates, scenarioGates };
}

export function normalizeSolanaProofOutcome(outcome: SolanaProofOutcome): {
  result: ScenarioResult;
  state: Record<string, unknown>;
  summary: SolanaScenarioSummary;
} {
  const { gates, scenarioGates } = buildMitigationGates(outcome);
  const passed = [...gates, ...scenarioGates].every((gate) => gate.passed);

  const summary: SolanaScenarioSummary = {
    preset: outcome.preset,
    seed: outcome.seed,
    winner: outcome.winner,
    duelLabel: outcome.duelLabel,
    duelKeyHex: outcome.duelKeyHex,
    marketRef: outcome.marketRef,
    backend: "solana",
    rpcUrl: outcome.rpcUrl,
    contracts: outcome.contracts,
    fees: {
      treasuryBps: outcome.fees.treasuryBps,
      mmBps: outcome.fees.mmBps,
      winningsMmBps: outcome.fees.winningsMmBps,
      treasuryAccruedLamports: outcome.fees.treasuryAccruedLamports,
      mmAccruedLamports: outcome.fees.mmAccruedLamports,
    },
    market: {
      statusCode: outcome.settlementStatusCode,
      statusLabel: outcome.settlementStatus,
      winnerCode: outcome.winnerCode,
      winnerLabel: outcome.winnerLabel,
      bestBid: outcome.bestBid,
      bestAsk: outcome.bestAsk,
      totalAShares: outcome.totalAShares,
      totalBShares: outcome.totalBShares,
    },
    actors: outcome.actors,
    book: outcome.book,
    traces: outcome.traces,
    mitigationGates: gates,
    scenarioGates,
    metrics: {
      attackerPnlCurrent: outcome.attackerPnl,
      attackerPnlPeak: outcome.attackerPnl,
      marketMakerPnl: outcome.marketMakerPnl,
      protocolMarketMakerPnl:
        outcome.fees.mmAccruedLamports === 0n
          ? 0
          : Number(outcome.fees.mmAccruedLamports) / 1_000_000_000,
      marketMakerDrawdownBps: outcome.marketMakerDrawdownBps,
      peakInventory: outcome.peakInventory,
      spreadWidthBps:
        outcome.bestBid > 0 && outcome.bestAsk > 0 && outcome.bestAsk < 1_000
          ? Math.round(
              ((outcome.bestAsk - outcome.bestBid) /
                ((outcome.bestAsk + outcome.bestBid) / 2)) *
                10_000,
            )
          : 0,
      orderChurn: outcome.orderChurn,
      staleStreamGuardTrips: outcome.staleStreamGuardTrips,
      staleOracleGuardTrips: outcome.staleOracleGuardTrips,
      closeGuardTrips: outcome.closeGuardTrips,
      circuitBreakerTrips: 0,
      settlementConsistent: outcome.resolvedCorrectly,
      claimsProcessed: outcome.claimsProcessed,
      settlementStatus: outcome.settlementStatus,
    },
    lockTransitionLatencyMs: outcome.lockTransitionLatencyMs,
    resolvedCorrectly: outcome.resolvedCorrectly,
    claimCorrectly: outcome.claimCorrectly,
    degraded: outcome.degraded,
    debug: outcome.debug,
  };

  const result: ScenarioResult = {
    scenarioId: outcome.preset.id,
    name: outcome.preset.name,
    family: outcome.preset.family,
    seed: outcome.seed,
    chainKey: "solana",
    attackerPnl: outcome.attackerPnl,
    marketMakerPnl: outcome.marketMakerPnl,
    maxDrawdownBps: outcome.marketMakerDrawdownBps,
    peakInventory: outcome.peakInventory,
    quoteUptimeRatio:
      outcome.quoteChecks > 0
        ? outcome.quoteActiveChecks / outcome.quoteChecks
        : 0,
    spreadWidthBps: summary.metrics.spreadWidthBps,
    orderChurn: outcome.orderChurn,
    lockTransitionLatencyMs: outcome.lockTransitionLatencyMs,
    resolvedCorrectly: outcome.resolvedCorrectly,
    claimCorrectly: outcome.claimCorrectly,
    passed,
    degraded: outcome.degraded,
    gates: [...gates, ...scenarioGates],
    traces: outcome.traces,
  };

  const state = {
    backend: "solana",
    tick: 0,
    running: false,
    speed: 0,
    scenario: {
      id: outcome.preset.id,
      name: outcome.preset.name,
      chainKey: "solana",
      seed: outcome.seed,
    },
    duel: {
      label: outcome.duelLabel,
      key: outcome.duelKeyHex,
      counter: 0,
    },
    market: {
      exists: true,
      status: outcome.settlementStatusCode,
      winner: outcome.winnerCode,
      bestBid: outcome.bestBid,
      bestAsk: outcome.bestAsk,
      totalAShares: outcome.totalAShares.toString(),
      totalBShares: outcome.totalBShares.toString(),
    },
    contracts: outcome.contracts,
    fees: {
      treasuryBps: outcome.fees.treasuryBps.toString(),
      mmBps: outcome.fees.mmBps.toString(),
      winningsMmBps: outcome.fees.winningsMmBps.toString(),
      treasuryAccruedWei: outcome.fees.treasuryAccruedLamports.toString(),
      mmAccruedWei: outcome.fees.mmAccruedLamports.toString(),
      treasuryAccruedAtomic: outcome.fees.treasuryAccruedLamports.toString(),
      mmAccruedAtomic: outcome.fees.mmAccruedLamports.toString(),
      accrualUnit: "lamports",
      displaySymbol: "SOL",
      displayDecimals: 9,
    },
    activeRun: null,
    agents: outcome.actors.map((actor) => ({
      enabled: true,
      name: actor.name,
      strategy: actor.role,
      description: actor.description,
      color: actor.color,
      address: actor.address,
      balance: lamportsToSol(actor.balance.lamports),
      pnl: actor.balance.pnlSol,
      tradeCount: actor.tradeCount,
      activeOrders: actor.activeOrders,
      position: {
        aShares: actor.position.aShares.toString(),
        bShares: actor.position.bShares.toString(),
        aStake: lamportsToSol(actor.position.aLockedLamports),
        bStake: lamportsToSol(actor.position.bLockedLamports),
      },
    })),
    book: {
      bids: outcome.book.bids.map((level) => ({
        price: level.price,
        total: level.total.toString(),
      })),
      asks: outcome.book.asks.map((level) => ({
        price: level.price,
        total: level.total.toString(),
      })),
    },
    mitigation: {
      gates,
      scenarioGates,
      metrics: summary.metrics,
    },
    traces: outcome.traces as AgentActionTrace[],
    scenarios: [],
    eventLogCount: outcome.traces.length,
    solana: {
      rpcUrl: outcome.rpcUrl,
      actors: outcome.actors.map((actor) => ({
        ...actor,
        balance: {
          lamports: actor.balance.lamports.toString(),
          pnlSol: actor.balance.pnlSol,
        },
        position: {
          aShares: actor.position.aShares.toString(),
          bShares: actor.position.bShares.toString(),
          aLockedLamports: actor.position.aLockedLamports.toString(),
          bLockedLamports: actor.position.bLockedLamports.toString(),
        },
      })),
      debug: outcome.debug ?? {},
    },
  } satisfies Record<string, unknown>;

  return { result, state, summary };
}
