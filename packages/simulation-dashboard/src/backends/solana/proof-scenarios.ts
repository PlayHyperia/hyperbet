import { LAMPORTS_PER_SOL } from "@solana/web3.js";

import type { AgentActionTrace } from "../../solana-scenario-types.js";

import type { ScenarioPreset } from "../../solana-scenario-catalog.js";
import type { SolanaActorSnapshot, SolanaProofOutcome } from "./types.js";
import {
  SIDE_ASK,
  SIDE_BID,
  SolanaProgramRuntime,
  buildSeededDuelKey,
  deriveUserBalancePda,
  hasProgramError,
  marketStatusCode,
  marketStatusLabel,
  marketWinnerCode,
  writableAccount,
  type SolanaOpenMarket,
  type SolanaRuntimeActor,
} from "./program-runtime.js";

type ScenarioActors = {
  marketMaker: SolanaRuntimeActor;
  taker: SolanaRuntimeActor;
  attacker: SolanaRuntimeActor;
};

type TradeFlowSummary = {
  makerUserBalancePda: string;
  takerUserBalancePda: string;
  makerSnapshotBeforeSettlement: Record<string, unknown> | null;
  takerSnapshotBeforeSettlement: Record<string, unknown> | null;
  peakInventory: number;
  quoteChecks: number;
  quoteActiveChecks: number;
  orderChurn: number;
  debug?: Record<string, unknown>;
};

type FinalizeScenarioOptions = {
  settlementMode: "resolve" | "cancel";
  winner: "A" | "B";
  tradeFlow: TradeFlowSummary;
  attackRejected: boolean;
  staleStreamGuardTrips?: number;
  staleOracleGuardTrips?: number;
  closeGuardTrips?: number;
  claimants?: SolanaRuntimeActor[];
  repeatClaimant?: SolanaRuntimeActor | null;
  debug?: Record<string, unknown>;
  onStage?: (stage: string) => void;
};

type ClaimRecord = {
  actor: string;
  userBalancePda: string;
  balanceBefore: bigint;
  balanceAfter: bigint;
  aSharesAfter: bigint;
  bSharesAfter: bigint;
  aLockedLamportsAfter: bigint;
  bLockedLamportsAfter: bigint;
};

type LosingCleanupRecord = {
  actor: string;
  userBalancePda: string;
  losingValueBefore: bigint;
  winningValueBefore: bigint;
  rentLamports: bigint;
  walletDeltaLamports: bigint;
  vaultBefore: bigint;
  vaultAfter: bigint;
  innerSystemTransfers: number;
  pdaClosed: boolean;
  winnerCleanupRejected: boolean;
  repeatCleanupRejected: boolean;
};

async function readCleanupTransactionEvidence(
  runtime: SolanaProgramRuntime,
  signature: string,
): Promise<{ accountKeys: string[]; innerSystemTransfers: number }> {
  const transaction = await runtime.connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!transaction) {
    throw new Error(`Cleanup transaction ${signature} was not available`);
  }

  const accountKeys = transaction.transaction.message.accountKeys.map(
    (account) => account.pubkey.toBase58(),
  );
  const innerSystemTransfers =
    transaction.meta?.innerInstructions?.reduce((count, group) => {
      return (
        count +
        group.instructions.filter((instruction) => {
          const parsed = instruction as {
            program?: string;
            parsed?: { type?: string };
          };
          return (
            parsed.program === "system" && parsed.parsed?.type === "transfer"
          );
        }).length
      );
    }, 0) ?? 0;

  return { accountKeys, innerSystemTransfers };
}

function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

function readBigintField(
  value: Record<string, unknown> | null | undefined,
  ...keys: string[]
): bigint {
  if (!value) {
    return 0n;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "bigint") {
      return candidate;
    }
    if (typeof candidate === "number") {
      return BigInt(candidate);
    }
    if (typeof candidate === "string" && candidate.length > 0) {
      return BigInt(candidate);
    }
    if (candidate instanceof Uint8Array) {
      const hex = Buffer.from(candidate).toString("hex");
      return hex.length > 0 ? BigInt(`0x${hex}`) : 0n;
    }
    if (
      typeof candidate === "object" &&
      candidate != null &&
      "toString" in candidate &&
      typeof candidate.toString === "function"
    ) {
      const stringValue = candidate.toString();
      if (/^-?\d+$/.test(stringValue)) {
        return BigInt(stringValue);
      }
    }
  }
  return 0n;
}

function readNumberField(
  value: Record<string, unknown> | null | undefined,
  key: string,
): number {
  if (!value) {
    return 0;
  }
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : Number(candidate ?? 0);
}

function buildTrace(
  action: string,
  market: SolanaOpenMarket,
  input: {
    actor: string;
    ok: boolean;
    txRef?: string | null;
    message?: string;
    price?: number | null;
    units?: number | null;
  },
): AgentActionTrace {
  return {
    actor: input.actor,
    action,
    chainKey: "solana",
    duelKey: Buffer.from(market.duelKey).toString("hex"),
    marketRef: market.marketState.toBase58(),
    price: input.price ?? null,
    units: input.units ?? null,
    txRef: input.txRef ?? null,
    ok: input.ok,
    message: input.message,
  };
}

async function snapshotActor(
  runtime: SolanaProgramRuntime,
  market: SolanaOpenMarket,
  actor: SolanaRuntimeActor,
  initialBalanceLamports: bigint,
): Promise<SolanaActorSnapshot> {
  const balanceLamports = await runtime.getBalanceLamports(
    actor.keypair.publicKey,
  );
  const userBalance = await runtime.fetchUserBalanceNullable(
    deriveUserBalancePda(
      runtime.clobProgram.programId,
      market.marketState,
      actor.keypair.publicKey,
    ),
  );

  return {
    name: actor.name,
    role: actor.role,
    description: actor.description,
    color: actor.color,
    address: actor.keypair.publicKey.toBase58(),
    tradeCount: actor.tradeCount,
    activeOrders: actor.activeOrders,
    balance: {
      lamports: balanceLamports,
      pnlSol: lamportsToSol(balanceLamports - initialBalanceLamports),
    },
    position: {
      aShares: readBigintField(userBalance, "aShares"),
      bShares: readBigintField(userBalance, "bShares"),
      aLockedLamports: readBigintField(
        userBalance,
        "aLockedLamports",
        "aStake",
      ),
      bLockedLamports: readBigintField(
        userBalance,
        "bLockedLamports",
        "bStake",
      ),
    },
  };
}

async function placeAskAndMatchBid(
  runtime: SolanaProgramRuntime,
  market: SolanaOpenMarket,
  marketMaker: SolanaRuntimeActor,
  taker: SolanaRuntimeActor,
  traces: AgentActionTrace[],
  input: {
    makerOrderId: number;
    takerOrderId: number;
    price: number;
    amount: bigint;
    makerMessage: string;
    takerMessage: string;
  },
): Promise<{
  quoteChecks: number;
  quoteActiveChecks: number;
  orderChurn: number;
}> {
  const makerAsk = await runtime.placeOrder({
    market,
    user: marketMaker,
    orderId: input.makerOrderId,
    side: SIDE_ASK,
    price: input.price,
    amount: input.amount,
  });
  traces.push(
    buildTrace("place_order", market, {
      actor: marketMaker.name,
      ok: true,
      txRef: makerAsk.signature,
      message: input.makerMessage,
      price: input.price,
      units: Number(input.amount),
    }),
  );

  const makerOrder = await (runtime.clobProgram.account as any).order.fetch(
    makerAsk.order,
  );
  const quoteChecks = 1;
  const quoteActiveChecks = makerOrder.active ? 1 : 0;

  const takerBid = await runtime.placeOrder({
    market,
    user: taker,
    orderId: input.takerOrderId,
    side: SIDE_BID,
    price: input.price,
    amount: input.amount,
    remainingAccounts: [
      writableAccount(makerAsk.restingLevel),
      writableAccount(makerAsk.order),
      writableAccount(makerAsk.userBalance),
    ],
  });
  traces.push(
    buildTrace("take_quote", market, {
      actor: taker.name,
      ok: true,
      txRef: takerBid.signature,
      message: input.takerMessage,
      price: input.price,
      units: Number(input.amount),
    }),
  );

  marketMaker.activeOrders = 0;
  taker.activeOrders = 0;

  return {
    quoteChecks,
    quoteActiveChecks,
    orderChurn: 2,
  };
}

async function buildTradeFlowSummary(
  runtime: SolanaProgramRuntime,
  market: SolanaOpenMarket,
  actors: ScenarioActors,
  metrics: {
    quoteChecks: number;
    quoteActiveChecks: number;
    orderChurn: number;
  },
  debug?: Record<string, unknown>,
): Promise<TradeFlowSummary> {
  const makerUserBalancePda = deriveUserBalancePda(
    runtime.clobProgram.programId,
    market.marketState,
    actors.marketMaker.keypair.publicKey,
  );
  const takerUserBalancePda = deriveUserBalancePda(
    runtime.clobProgram.programId,
    market.marketState,
    actors.taker.keypair.publicKey,
  );
  const makerSnapshotBeforeSettlement =
    await runtime.fetchUserBalanceNullable(makerUserBalancePda);
  const takerSnapshotBeforeSettlement =
    await runtime.fetchUserBalanceNullable(takerUserBalancePda);
  const peakInventory = Math.max(
    Number(
      readBigintField(makerSnapshotBeforeSettlement, "aShares") +
        readBigintField(makerSnapshotBeforeSettlement, "bShares"),
    ),
    Number(
      readBigintField(takerSnapshotBeforeSettlement, "aShares") +
        readBigintField(takerSnapshotBeforeSettlement, "bShares"),
    ),
  );

  return {
    makerUserBalancePda: makerUserBalancePda.toBase58(),
    takerUserBalancePda: takerUserBalancePda.toBase58(),
    makerSnapshotBeforeSettlement,
    takerSnapshotBeforeSettlement,
    peakInventory,
    quoteChecks: metrics.quoteChecks,
    quoteActiveChecks: metrics.quoteActiveChecks,
    orderChurn: metrics.orderChurn,
    debug,
  };
}

async function executeStandardTradeFlow(
  runtime: SolanaProgramRuntime,
  market: SolanaOpenMarket,
  actors: ScenarioActors,
  traces: AgentActionTrace[],
): Promise<TradeFlowSummary> {
  const metrics = await placeAskAndMatchBid(
    runtime,
    market,
    actors.marketMaker,
    actors.taker,
    traces,
    {
      makerOrderId: 1,
      takerOrderId: 2,
      price: 600,
      amount: 1_000n,
      makerMessage: "resting ask placed",
      takerMessage: "taker matched the resting ask",
    },
  );

  return buildTradeFlowSummary(runtime, market, actors, metrics);
}

async function executeCancelReplaceGriefingFlow(
  runtime: SolanaProgramRuntime,
  market: SolanaOpenMarket,
  actors: ScenarioActors,
  traces: AgentActionTrace[],
): Promise<TradeFlowSummary> {
  const churner = actors.attacker;
  const anchorAsk = await runtime.placeOrder({
    market,
    user: actors.marketMaker,
    orderId: 1,
    side: SIDE_ASK,
    price: 600,
    amount: 1_000n,
  });
  traces.push(
    buildTrace("place_order", market, {
      actor: actors.marketMaker.name,
      ok: true,
      txRef: anchorAsk.signature,
      message: "persistent resting ask placed for cancel/replace churn",
      price: 600,
      units: 1_000,
    }),
  );
  const anchorOrderAccount = await (
    runtime.clobProgram.account as any
  ).order.fetch(anchorAsk.order);

  const placements = [
    { orderId: 2, amount: 1_000n },
    { orderId: 3, amount: 2_000n },
  ];
  let quoteChecks = 0;
  let quoteActiveChecks = 0;
  let orderChurn = 1;

  quoteChecks += 1;
  quoteActiveChecks += anchorOrderAccount.active ? 1 : 0;

  for (const placement of placements) {
    const placed = await runtime.placeOrder({
      market,
      user: churner,
      orderId: placement.orderId,
      side: SIDE_ASK,
      price: 600,
      amount: placement.amount,
      remainingAccounts: [writableAccount(anchorAsk.order)],
    });
    traces.push(
      buildTrace("place_order", market, {
        actor: churner.name,
        ok: true,
        txRef: placed.signature,
        message: `griefing cycle placed order ${placement.orderId}`,
        price: 600,
        units: Number(placement.amount),
      }),
    );

    const placedOrder = await (runtime.clobProgram.account as any).order.fetch(
      placed.order,
    );
    quoteChecks += 1;
    quoteActiveChecks += placedOrder.active ? 1 : 0;
    orderChurn += 1;

    const cancelSignature = await runtime.cancelOrder({
      market,
      user: churner,
      orderId: placement.orderId,
      side: SIDE_ASK,
      price: 600,
      remainingAccounts: [writableAccount(anchorAsk.order)],
    });
    traces.push(
      buildTrace("cancel_order", market, {
        actor: churner.name,
        ok: true,
        txRef: cancelSignature,
        message: `cancelled churn order ${placement.orderId}`,
        price: 600,
        units: Number(placement.amount),
      }),
    );
    orderChurn += 1;
  }

  const takerBid = await runtime.placeOrder({
    market,
    user: actors.taker,
    orderId: 4,
    side: SIDE_BID,
    price: 600,
    amount: 1_000n,
    remainingAccounts: [
      writableAccount(anchorAsk.restingLevel),
      writableAccount(anchorAsk.order),
      writableAccount(anchorAsk.userBalance),
    ],
  });
  traces.push(
    buildTrace("take_quote", market, {
      actor: actors.taker.name,
      ok: true,
      txRef: takerBid.signature,
      message: "taker matched the persistent ask after churn",
      price: 600,
      units: 1_000,
    }),
  );
  actors.marketMaker.activeOrders = 0;
  actors.taker.activeOrders = 0;

  return buildTradeFlowSummary(
    runtime,
    market,
    actors,
    {
      quoteChecks,
      quoteActiveChecks,
      orderChurn: orderChurn + 1,
    },
    {
      churnCycles: 2,
      anchorOrderId: 1,
    },
  );
}

async function executeInventoryPoisoningFlow(
  runtime: SolanaProgramRuntime,
  market: SolanaOpenMarket,
  actors: ScenarioActors,
  traces: AgentActionTrace[],
): Promise<TradeFlowSummary> {
  let quoteChecks = 0;
  let quoteActiveChecks = 0;
  let orderChurn = 0;
  let nextOrderId = 1;

  for (let index = 0; index < 3; index += 1) {
    const fillMetrics = await placeAskAndMatchBid(
      runtime,
      market,
      actors.marketMaker,
      actors.taker,
      traces,
      {
        makerOrderId: nextOrderId,
        takerOrderId: nextOrderId + 1,
        price: 600,
        amount: 1_000n,
        makerMessage: `inventory poisoning quote ${index + 1} placed`,
        takerMessage: `one-sided toxic fill ${index + 1} matched`,
      },
    );
    quoteChecks += fillMetrics.quoteChecks;
    quoteActiveChecks += fillMetrics.quoteActiveChecks;
    orderChurn += fillMetrics.orderChurn;
    nextOrderId += 2;
  }

  return buildTradeFlowSummary(
    runtime,
    market,
    actors,
    {
      quoteChecks,
      quoteActiveChecks,
      orderChurn,
    },
    {
      toxicFillCount: 3,
    },
  );
}

async function executeCrossMarketValidationFlow(
  runtime: SolanaProgramRuntime,
  preset: ScenarioPreset,
  seed: string,
  market: SolanaOpenMarket,
  actors: ScenarioActors,
  traces: AgentActionTrace[],
): Promise<{
  tradeFlow: TradeFlowSummary;
  attackRejected: boolean;
}> {
  const foreignDuelKey = buildSeededDuelKey(`${preset.id}:foreign`, seed);
  const foreignMarket = await runtime.createOpenMarket(
    foreignDuelKey,
    actors.marketMaker.keypair.publicKey,
    `https://hyperbet.local/${preset.id}/foreign`,
  );

  const foreignAsk = await runtime.placeOrder({
    market: foreignMarket,
    user: actors.marketMaker,
    orderId: 1,
    side: SIDE_ASK,
    price: 600,
    amount: 1_000n,
  });
  traces.push(
    buildTrace("place_order", foreignMarket, {
      actor: actors.marketMaker.name,
      ok: true,
      txRef: foreignAsk.signature,
      message: "foreign market resting ask placed for validation attack",
      price: 600,
      units: 1_000,
    }),
  );
  const foreignOrder = await (runtime.clobProgram.account as any).order.fetch(
    foreignAsk.order,
  );

  const baseAsk = await runtime.placeOrder({
    market,
    user: actors.marketMaker,
    orderId: 1,
    side: SIDE_ASK,
    price: 600,
    amount: 1_000n,
  });
  traces.push(
    buildTrace("place_order", market, {
      actor: actors.marketMaker.name,
      ok: true,
      txRef: baseAsk.signature,
      message: "base market resting ask placed",
      price: 600,
      units: 1_000,
    }),
  );
  const baseOrder = await (runtime.clobProgram.account as any).order.fetch(
    baseAsk.order,
  );

  let attackRejected = false;
  try {
    await runtime.placeOrder({
      market,
      user: actors.taker,
      orderId: 2,
      side: SIDE_BID,
      price: 600,
      amount: 1_000n,
      remainingAccounts: [
        writableAccount(foreignAsk.restingLevel),
        writableAccount(foreignAsk.order),
        writableAccount(foreignAsk.userBalance),
      ],
    });
    traces.push(
      buildTrace("cross_market_match", market, {
        actor: actors.attacker.name,
        ok: false,
        message: "cross-market remaining accounts unexpectedly matched",
        price: 600,
        units: 1_000,
      }),
    );
  } catch (error) {
    attackRejected = hasProgramError(error, "InvalidRemainingAccount");
    traces.push(
      buildTrace("cross_market_match_rejected", market, {
        actor: actors.attacker.name,
        ok: attackRejected,
        message: attackRejected
          ? "cross-market remaining accounts rejected"
          : error instanceof Error
            ? error.message
            : String(error),
        price: 600,
        units: 1_000,
      }),
    );
  }

  const takerBid = await runtime.placeOrder({
    market,
    user: actors.taker,
    orderId: 2,
    side: SIDE_BID,
    price: 600,
    amount: 1_000n,
    remainingAccounts: [
      writableAccount(baseAsk.restingLevel),
      writableAccount(baseAsk.order),
      writableAccount(baseAsk.userBalance),
    ],
  });
  traces.push(
    buildTrace("take_quote", market, {
      actor: actors.taker.name,
      ok: true,
      txRef: takerBid.signature,
      message: "taker matched the correct base-market quote",
      price: 600,
      units: 1_000,
    }),
  );
  actors.marketMaker.activeOrders = 1;
  actors.taker.activeOrders = 0;

  return {
    tradeFlow: await buildTradeFlowSummary(
      runtime,
      market,
      actors,
      {
        quoteChecks: (foreignOrder.active ? 1 : 0) + (baseOrder.active ? 1 : 0),
        quoteActiveChecks:
          (foreignOrder.active ? 1 : 0) + (baseOrder.active ? 1 : 0),
        orderChurn: 3,
      },
      {
        foreignMarketRef: foreignMarket.marketState.toBase58(),
        foreignUserBalancePda: foreignAsk.userBalance.toBase58(),
        foreignOrderStillOpen: true,
      },
    ),
    attackRejected,
  };
}

async function finalizeOutcome(
  runtime: SolanaProgramRuntime,
  preset: ScenarioPreset,
  seed: string,
  market: SolanaOpenMarket,
  actors: ScenarioActors,
  initialBalances: {
    authority: bigint;
    marketMaker: bigint;
    taker: bigint;
    attacker: bigint;
  },
  traces: AgentActionTrace[],
  options: FinalizeScenarioOptions,
): Promise<SolanaProofOutcome> {
  const claimants =
    options.claimants ??
    (options.settlementMode === "cancel"
      ? [actors.marketMaker, actors.taker]
      : [options.winner === "B" ? actors.marketMaker : actors.taker]);

  let settlementSignature: string;
  let syncSignature: string;
  const settlementStartedAt = Date.now();
  if (options.settlementMode === "cancel") {
    options.onStage?.("cancel");
    settlementSignature = await runtime.cancelDuel(
      market,
      `https://hyperbet.local/${preset.id}/cancel`,
    );
    traces.push(
      buildTrace("cancel_duel", market, {
        actor: "Authority Reporter",
        ok: true,
        txRef: settlementSignature,
        message: "authoritative market cancellation reported",
      }),
    );
  } else {
    options.onStage?.("resolve");
    const duelState = await runtime.fetchDuelState(market.duelState);
    const duelStatus = ((duelState?.status as Record<string, unknown> | null) ??
      {}) as Record<string, unknown>;
    if ("bettingOpen" in duelStatus) {
      const lockSignature = await runtime.lockDuel(
        market,
        `https://hyperbet.local/${preset.id}/locked`,
      );
      traces.push(
        buildTrace("lock_duel", market, {
          actor: "Authority Reporter",
          ok: true,
          txRef: lockSignature,
          message: "duel locked before authoritative resolution",
        }),
      );
    }
    settlementSignature = await runtime.reportResult({
      reporter: runtime.authority,
      duelKey: market.duelKey,
      winner: options.winner,
      seed: `${preset.id}:${options.winner}`,
      metadataUri: `https://hyperbet.local/${preset.id}/result`,
    });
    traces.push(
      buildTrace("report_result", market, {
        actor: "Authority Reporter",
        ok: true,
        txRef: settlementSignature,
        message: `authoritative ${options.winner}-winner result reported`,
      }),
    );
  }

  syncSignature = await runtime.syncMarketFromDuel(market);
  const lockTransitionLatencyMs = Date.now() - settlementStartedAt;
  traces.push(
    buildTrace("sync_market", market, {
      actor: "Authority Reporter",
      ok: true,
      txRef: syncSignature,
      message: "market synced from duel state",
    }),
  );

  const winnerActor =
    options.winner === "B" ? actors.marketMaker : actors.taker;
  const loserActor = options.winner === "B" ? actors.taker : actors.marketMaker;
  let winnerCleanupRejected = false;
  if (options.settlementMode === "resolve") {
    try {
      await runtime.closeLosingBalance(market, winnerActor);
      traces.push(
        buildTrace("winning_balance_cleanup", market, {
          actor: winnerActor.name,
          ok: false,
          message: "winning balance cleanup unexpectedly succeeded",
        }),
      );
    } catch (error) {
      winnerCleanupRejected = hasProgramError(
        error,
        "WinningBalanceCannotBeClosed",
      );
      traces.push(
        buildTrace("winning_balance_cleanup_rejected", market, {
          actor: winnerActor.name,
          ok: winnerCleanupRejected,
          message: winnerCleanupRejected
            ? "winner value was protected from the loser-only cleanup path"
            : error instanceof Error
              ? error.message
              : String(error),
        }),
      );
    }
  }

  const claimRecords: ClaimRecord[] = [];
  options.onStage?.("claim");
  for (const claimant of claimants) {
    const balanceBefore = await runtime.getBalanceLamports(
      claimant.keypair.publicKey,
    );
    const claimResult = await runtime.claim(market, claimant);
    traces.push(
      buildTrace(
        options.settlementMode === "cancel" ? "refund_claim" : "claim",
        market,
        {
          actor: claimant.name,
          ok: true,
          txRef: claimResult.signature,
          message:
            options.settlementMode === "cancel"
              ? "refund claim executed against cancelled market"
              : "claim executed against the resolved market",
        },
      ),
    );

    const balanceAfter = await runtime.getBalanceLamports(
      claimant.keypair.publicKey,
    );
    const userBalanceAfter = await runtime.fetchUserBalanceNullable(
      claimResult.userBalance,
    );
    claimRecords.push({
      actor: claimant.name,
      userBalancePda: claimResult.userBalance.toBase58(),
      balanceBefore,
      balanceAfter,
      aSharesAfter: readBigintField(userBalanceAfter, "aShares"),
      bSharesAfter: readBigintField(userBalanceAfter, "bShares"),
      aLockedLamportsAfter: readBigintField(
        userBalanceAfter,
        "aLockedLamports",
        "aStake",
      ),
      bLockedLamportsAfter: readBigintField(
        userBalanceAfter,
        "bLockedLamports",
        "bStake",
      ),
    });
  }

  let losingCleanupRecord: LosingCleanupRecord | null = null;
  if (options.settlementMode === "resolve") {
    const userBalancePda = deriveUserBalancePda(
      runtime.clobProgram.programId,
      market.marketState,
      loserActor.keypair.publicKey,
    );
    const userBalanceBefore = await runtime.fetchUserBalance(userBalancePda);
    const aValueBefore =
      readBigintField(userBalanceBefore, "aShares") +
      readBigintField(userBalanceBefore, "aLockedLamports", "aStake");
    const bValueBefore =
      readBigintField(userBalanceBefore, "bShares") +
      readBigintField(userBalanceBefore, "bLockedLamports", "bStake");
    const winningValueBefore =
      options.winner === "A" ? aValueBefore : bValueBefore;
    const losingValueBefore =
      options.winner === "A" ? bValueBefore : aValueBefore;
    const accountInfoBefore = await runtime.connection.getAccountInfo(
      userBalancePda,
      "confirmed",
    );
    if (!accountInfoBefore) {
      throw new Error("Losing user-balance account was absent before cleanup");
    }

    const walletBefore = await runtime.getBalanceLamports(
      loserActor.keypair.publicKey,
    );
    const vaultBefore = await runtime.getBalanceLamports(market.vault);
    const cleanupResult = await runtime.closeLosingBalance(market, loserActor);
    const evidence = await readCleanupTransactionEvidence(
      runtime,
      cleanupResult.signature,
    );
    const walletAfter = await runtime.getBalanceLamports(
      loserActor.keypair.publicKey,
    );
    const vaultAfter = await runtime.getBalanceLamports(market.vault);
    const pdaClosed =
      (await runtime.fetchUserBalanceNullable(userBalancePda)) === null;

    traces.push(
      buildTrace("losing_balance_cleanup", market, {
        actor: loserActor.name,
        ok:
          losingValueBefore > 0n &&
          winningValueBefore === 0n &&
          pdaClosed &&
          vaultAfter === vaultBefore &&
          evidence.innerSystemTransfers === 0 &&
          !evidence.accountKeys.includes(market.vault.toBase58()),
        txRef: cleanupResult.signature,
        message:
          "loser-only balance cleanup closed the PDA; the payout vault was excluded and unchanged; zero inner system transfers were emitted",
      }),
    );

    let repeatCleanupRejected = false;
    try {
      await runtime.closeLosingBalance(market, loserActor);
      traces.push(
        buildTrace("repeat_losing_balance_cleanup", market, {
          actor: loserActor.name,
          ok: false,
          message: "repeat losing-balance cleanup unexpectedly succeeded",
        }),
      );
    } catch (error) {
      repeatCleanupRejected = hasProgramError(error, "AccountNotInitialized");
      traces.push(
        buildTrace("repeat_losing_balance_cleanup_rejected", market, {
          actor: loserActor.name,
          ok: repeatCleanupRejected,
          message: repeatCleanupRejected
            ? "repeat cleanup rejected after the balance PDA was closed"
            : error instanceof Error
              ? error.message
              : String(error),
        }),
      );
    }

    losingCleanupRecord = {
      actor: loserActor.name,
      userBalancePda: userBalancePda.toBase58(),
      losingValueBefore,
      winningValueBefore,
      rentLamports: BigInt(accountInfoBefore.lamports),
      walletDeltaLamports: walletAfter - walletBefore,
      vaultBefore,
      vaultAfter,
      innerSystemTransfers: evidence.innerSystemTransfers,
      pdaClosed,
      winnerCleanupRejected,
      repeatCleanupRejected,
    };

    if (evidence.accountKeys.includes(market.vault.toBase58())) {
      throw new Error(
        "Loser cleanup transaction unexpectedly included the vault",
      );
    }
  }

  let repeatClaimRejected = false;
  if (options.repeatClaimant) {
    try {
      await runtime.claim(market, options.repeatClaimant);
      traces.push(
        buildTrace("repeat_claim", market, {
          actor: options.repeatClaimant.name,
          ok: false,
          message: "repeat claim unexpectedly succeeded",
        }),
      );
    } catch (error) {
      repeatClaimRejected =
        hasProgramError(error, "NothingToClaim") ||
        hasProgramError(error, "AccountNotInitialized");
      traces.push(
        buildTrace("repeat_claim_rejected", market, {
          actor: options.repeatClaimant.name,
          ok: repeatClaimRejected,
          message: repeatClaimRejected
            ? "repeat claim rejected after balance cleanup"
            : error instanceof Error
              ? error.message
              : String(error),
        }),
      );
    }
  }

  const marketState = await runtime.fetchMarketState(market.marketState);
  const config = await runtime.fetchConfig(market.config);
  const treasuryDeltaLamports =
    (await runtime.getBalanceLamports(runtime.authority.publicKey)) -
    initialBalances.authority;

  const actorSnapshots = await Promise.all([
    snapshotActor(
      runtime,
      market,
      actors.marketMaker,
      initialBalances.marketMaker,
    ),
    snapshotActor(runtime, market, actors.taker, initialBalances.taker),
    snapshotActor(runtime, market, actors.attacker, initialBalances.attacker),
  ]);

  const totalAShares = actorSnapshots.reduce(
    (total, actor) => total + actor.position.aShares,
    0n,
  );
  const totalBShares = actorSnapshots.reduce(
    (total, actor) => total + actor.position.bShares,
    0n,
  );

  const marketMakerSnapshot = actorSnapshots.find(
    (actor) => actor.role === "market_maker",
  );
  const attackerSnapshot = actorSnapshots.find(
    (actor) => actor.role === "attacker",
  );
  const marketMakerPnl = marketMakerSnapshot?.balance.pnlSol ?? 0;
  const attackerPnl = attackerSnapshot?.balance.pnlSol ?? 0;
  const marketMakerDrawdownBps = Math.round(
    (Math.abs(Math.min(0, marketMakerPnl)) /
      Math.max(lamportsToSol(initialBalances.marketMaker), 0.0001)) *
      10_000,
  );
  const settlementStatusCode = marketStatusCode(
    marketState.status as Record<string, unknown>,
  );
  const settlementStatus = marketStatusLabel(
    marketState.status as Record<string, unknown>,
  );
  const winnerCode = marketWinnerCode(
    marketState.winner as Record<string, unknown>,
  );
  const winnerLabel =
    winnerCode === 1 ? "A" : winnerCode === 2 ? "B" : ("NONE" as const);
  const resolvedCorrectly =
    options.settlementMode === "cancel"
      ? settlementStatus === "CANCELLED"
      : settlementStatus === "RESOLVED" && winnerLabel === options.winner;
  const claimCorrectly =
    options.settlementMode === "cancel"
      ? claimRecords.length > 0 &&
        claimRecords.every(
          (record) =>
            record.balanceAfter > record.balanceBefore &&
            record.aSharesAfter === 0n &&
            record.bSharesAfter === 0n &&
            record.aLockedLamportsAfter === 0n &&
            record.bLockedLamportsAfter === 0n,
        ) &&
        repeatClaimRejected
      : claimRecords.length > 0 &&
        claimRecords.every((record) => {
          if (options.winner === "A") {
            return (
              record.balanceAfter > record.balanceBefore &&
              record.aSharesAfter === 0n &&
              record.aLockedLamportsAfter === 0n
            );
          }
          return (
            record.balanceAfter > record.balanceBefore &&
            record.bSharesAfter === 0n &&
            record.bLockedLamportsAfter === 0n
          );
        });
  const losingCleanupVerified =
    options.settlementMode === "cancel" ||
    (losingCleanupRecord != null &&
      losingCleanupRecord.losingValueBefore > 0n &&
      losingCleanupRecord.winningValueBefore === 0n &&
      losingCleanupRecord.pdaClosed &&
      losingCleanupRecord.vaultAfter === losingCleanupRecord.vaultBefore &&
      losingCleanupRecord.innerSystemTransfers === 0 &&
      losingCleanupRecord.winnerCleanupRejected &&
      losingCleanupRecord.repeatCleanupRejected);
  const claimsProcessed = claimCorrectly && losingCleanupVerified;
  const bestBid = readNumberField(marketState, "bestBid");
  const bestAsk = readNumberField(marketState, "bestAsk");
  const bookNotCrossed = bestAsk <= 0 || bestAsk === 1_000 || bestBid < bestAsk;

  return {
    preset,
    seed,
    winner: options.winner,
    duelLabel: `${preset.id}:${seed}`,
    duelKeyHex: Buffer.from(market.duelKey).toString("hex"),
    marketRef: market.marketState.toBase58(),
    rpcUrl: runtime.rpcUrl,
    contracts: {
      oracle: runtime.fightProgram.programId.toBase58(),
      clob: runtime.clobProgram.programId.toBase58(),
    },
    fees: {
      treasuryBps: readNumberField(config, "tradeTreasuryFeeBps"),
      mmBps: readNumberField(config, "tradeMarketMakerFeeBps"),
      winningsMmBps: readNumberField(config, "winningsMarketMakerFeeBps"),
      treasuryAccruedLamports: treasuryDeltaLamports,
      mmAccruedLamports:
        (await runtime.getBalanceLamports(
          actors.marketMaker.keypair.publicKey,
        )) - initialBalances.marketMaker,
    },
    actors: actorSnapshots,
    book: {
      bids: [],
      asks: [],
    },
    traces,
    attackRejected:
      options.attackRejected ||
      repeatClaimRejected ||
      (winnerCleanupRejected &&
        (losingCleanupRecord?.repeatCleanupRejected ?? false)),
    staleStreamGuardTrips: options.staleStreamGuardTrips ?? 0,
    staleOracleGuardTrips: options.staleOracleGuardTrips ?? 0,
    closeGuardTrips: options.closeGuardTrips ?? 0,
    peakInventory: options.tradeFlow.peakInventory,
    quoteChecks: options.tradeFlow.quoteChecks,
    quoteActiveChecks: options.tradeFlow.quoteActiveChecks,
    orderChurn: options.tradeFlow.orderChurn,
    lockTransitionLatencyMs,
    resolvedCorrectly,
    claimCorrectly,
    settlementStatus,
    settlementStatusCode,
    winnerCode,
    winnerLabel,
    totalAShares,
    totalBShares,
    bestBid,
    bestAsk,
    marketMakerPnl,
    attackerPnl,
    treasuryPnl: lamportsToSol(treasuryDeltaLamports),
    marketMakerDrawdownBps,
    claimsProcessed,
    bookNotCrossed,
    mmSolvent: (marketMakerSnapshot?.balance.lamports ?? 0n) > 0n,
    degraded: false,
    debug: {
      makerUserBalancePda: options.tradeFlow.makerUserBalancePda,
      takerUserBalancePda: options.tradeFlow.takerUserBalancePda,
      makerSharesBeforeSettlement: {
        aShares: readBigintField(
          options.tradeFlow.makerSnapshotBeforeSettlement,
          "aShares",
        ).toString(),
        bShares: readBigintField(
          options.tradeFlow.makerSnapshotBeforeSettlement,
          "bShares",
        ).toString(),
      },
      takerSharesBeforeSettlement: {
        aShares: readBigintField(
          options.tradeFlow.takerSnapshotBeforeSettlement,
          "aShares",
        ).toString(),
        bShares: readBigintField(
          options.tradeFlow.takerSnapshotBeforeSettlement,
          "bShares",
        ).toString(),
      },
      settlementSignature,
      syncSignature,
      claimRecords: claimRecords.map((record) => ({
        actor: record.actor,
        userBalancePda: record.userBalancePda,
        balanceBefore: record.balanceBefore.toString(),
        balanceAfter: record.balanceAfter.toString(),
        aSharesAfter: record.aSharesAfter.toString(),
        bSharesAfter: record.bSharesAfter.toString(),
        aLockedLamportsAfter: record.aLockedLamportsAfter.toString(),
        bLockedLamportsAfter: record.bLockedLamportsAfter.toString(),
      })),
      repeatClaimRejected,
      losingCleanupVerified,
      losingCleanupRecord:
        losingCleanupRecord == null
          ? null
          : {
              actor: losingCleanupRecord.actor,
              userBalancePda: losingCleanupRecord.userBalancePda,
              losingValueBefore:
                losingCleanupRecord.losingValueBefore.toString(),
              winningValueBefore:
                losingCleanupRecord.winningValueBefore.toString(),
              rentLamports: losingCleanupRecord.rentLamports.toString(),
              walletDeltaLamports:
                losingCleanupRecord.walletDeltaLamports.toString(),
              vaultBefore: losingCleanupRecord.vaultBefore.toString(),
              vaultAfter: losingCleanupRecord.vaultAfter.toString(),
              innerSystemTransfers: losingCleanupRecord.innerSystemTransfers,
              pdaClosed: losingCleanupRecord.pdaClosed,
              winnerCleanupRejected: losingCleanupRecord.winnerCleanupRejected,
              repeatCleanupRejected: losingCleanupRecord.repeatCleanupRejected,
            },
      ...(options.tradeFlow.debug ?? {}),
      ...(options.debug ?? {}),
    },
  };
}

export async function runSolanaProofScenario(
  runtime: SolanaProgramRuntime,
  input: {
    preset: ScenarioPreset;
    seed: string;
    winner: "A" | "B";
    attackUnauthorizedReporter: boolean;
    onLog?: (message: string) => void;
    onStage?: (stage: string) => void;
  },
): Promise<SolanaProofOutcome> {
  const actors = runtime.createActors();
  await runtime.fundActors(Object.values(actors));

  const initialBalances = {
    authority: await runtime.getBalanceLamports(runtime.authority.publicKey),
    marketMaker: await runtime.getBalanceLamports(
      actors.marketMaker.keypair.publicKey,
    ),
    taker: await runtime.getBalanceLamports(actors.taker.keypair.publicKey),
    attacker: await runtime.getBalanceLamports(
      actors.attacker.keypair.publicKey,
    ),
  };

  const duelKey = buildSeededDuelKey(input.preset.id, input.seed);
  const market = await runtime.createOpenMarket(
    duelKey,
    actors.marketMaker.keypair.publicKey,
    `https://hyperbet.local/${input.preset.id}`,
  );
  input.onLog?.(
    `Solana proof market ready: ${market.marketState.toBase58()} on ${runtime.rpcUrl}`,
  );

  const traces: AgentActionTrace[] = [];
  let tradeFlow: TradeFlowSummary;
  let attackRejected = false;
  let closeGuardTrips = 0;
  let settlementMode: "resolve" | "cancel" =
    input.preset.runtimeProfile?.settlementMode === "cancel"
      ? "cancel"
      : "resolve";
  let finalizeDebug: Record<string, unknown> | undefined;
  let claimants: SolanaRuntimeActor[] | undefined;
  let repeatClaimant: SolanaRuntimeActor | null = null;

  switch (input.preset.id) {
    case "solana-cancel-replace-griefing":
      tradeFlow = await executeCancelReplaceGriefingFlow(
        runtime,
        market,
        actors,
        traces,
      );
      break;
    case "solana-inventory-poisoning":
      tradeFlow = await executeInventoryPoisoningFlow(
        runtime,
        market,
        actors,
        traces,
      );
      break;
    case "solana-cross-market-validation-abuse": {
      const result = await executeCrossMarketValidationFlow(
        runtime,
        input.preset,
        input.seed,
        market,
        actors,
        traces,
      );
      tradeFlow = result.tradeFlow;
      attackRejected = result.attackRejected;
      break;
    }
    default:
      tradeFlow = await executeStandardTradeFlow(
        runtime,
        market,
        actors,
        traces,
      );
      break;
  }

  switch (input.preset.id) {
    case "solana-unauthorized-oracle-attack":
      try {
        await runtime.reportResult({
          reporter: actors.attacker.keypair,
          duelKey,
          winner: input.winner,
          seed: `${input.seed}:attacker`,
          metadataUri: `https://hyperbet.local/${input.preset.id}/unauthorized`,
        });
        traces.push(
          buildTrace("unauthorized_report", market, {
            actor: actors.attacker.name,
            ok: false,
            message: "unauthorized result unexpectedly succeeded",
          }),
        );
      } catch (error) {
        attackRejected = hasProgramError(error, "Unauthorized");
        traces.push(
          buildTrace("unauthorized_report", market, {
            actor: actors.attacker.name,
            ok: attackRejected,
            message: attackRejected
              ? "unauthorized oracle write rejected"
              : error instanceof Error
                ? error.message
                : String(error),
          }),
        );
      }
      break;
    case "solana-stale-resolution-window": {
      const duelState = await runtime.fetchDuelState(market.duelState);
      const staleEndTs = Number(readBigintField(duelState, "betCloseTs")) - 1;
      try {
        await runtime.reportResult({
          reporter: runtime.authority,
          duelKey,
          winner: input.winner,
          seed: `${input.seed}:stale`,
          metadataUri: `https://hyperbet.local/${input.preset.id}/invalid`,
          duelEndTs: staleEndTs,
        });
        traces.push(
          buildTrace("invalid_resolution", market, {
            actor: "Authority Reporter",
            ok: false,
            message: "invalid stale resolution unexpectedly succeeded",
          }),
        );
      } catch (error) {
        attackRejected = hasProgramError(error, "Invalid result time");
        traces.push(
          buildTrace("invalid_resolution_rejected", market, {
            actor: "Authority Reporter",
            ok: attackRejected,
            message: attackRejected
              ? "pre-close resolution rejected by oracle lifecycle checks"
              : error instanceof Error
                ? error.message
                : String(error),
          }),
        );
      }
      break;
    }
    case "solana-lock-race-attempt": {
      const lockSignature = await runtime.lockDuel(
        market,
        `https://hyperbet.local/${input.preset.id}/locked`,
      );
      traces.push(
        buildTrace("lock_duel", market, {
          actor: "Authority Reporter",
          ok: true,
          txRef: lockSignature,
          message: "duel locked before post-close race attempt",
        }),
      );

      try {
        await runtime.placeOrder({
          market,
          user: actors.attacker,
          orderId: 3,
          side: SIDE_BID,
          price: 600,
          amount: 1000n,
        });
        traces.push(
          buildTrace("post_lock_order", market, {
            actor: actors.attacker.name,
            ok: false,
            message: "post-lock order unexpectedly succeeded",
            price: 600,
            units: 500,
          }),
        );
      } catch (error) {
        attackRejected =
          hasProgramError(error, "MarketNotOpen") ||
          hasProgramError(error, "BettingClosed");
        closeGuardTrips = attackRejected ? 1 : 0;
        traces.push(
          buildTrace("post_lock_order_rejected", market, {
            actor: actors.attacker.name,
            ok: attackRejected,
            message: attackRejected
              ? "post-lock order rejected by market close checks"
              : error instanceof Error
                ? error.message
                : String(error),
            price: 600,
            units: 500,
          }),
        );
      }
      break;
    }
    case "solana-claim-refund-abuse":
      settlementMode = "cancel";
      claimants = [actors.marketMaker, actors.taker];
      repeatClaimant = actors.taker;
      finalizeDebug = {
        refundScenario: true,
      };
      break;
    default:
      break;
  }

  return finalizeOutcome(
    runtime,
    input.preset,
    input.seed,
    market,
    actors,
    initialBalances,
    traces,
    {
      settlementMode,
      winner: input.winner,
      tradeFlow,
      attackRejected,
      closeGuardTrips,
      claimants,
      repeatClaimant,
      debug: finalizeDebug,
      onStage: input.onStage,
    },
  );
}
