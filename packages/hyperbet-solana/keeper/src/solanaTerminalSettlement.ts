import { quoteCostLamports } from "./solanaBetAccounting";
import { allocateFeeByLargestRemainder } from "./solanaClaimAccounting";
import { normalizeLifecycleFact } from "./solanaLifecycleIndexer";
import type {
  BetExecutionBaseline,
  IndexedLifecycleFact,
} from "./solanaBetReconciliation";

export type SolanaTerminalSettlementKind =
  "CLAIM_PAYOUT" | "CANCELLATION_REFUND" | "LOSER_CLEANUP";

export type SolanaBetTerminalAllocation = {
  betId: string;
  orderId: string;
  side: 1 | 2;
  matchedAmountUnits: string;
  grossEntitlementLamports: string;
  payoutLamports: string;
  feeLamports: string;
};

export type SolanaWalletMarketTerminalSettlement = {
  claimSignature: string;
  marketPda: string;
  wallet: string;
  kind: SolanaTerminalSettlementKind;
  status: "resolved" | "cancelled";
  winner: "none" | "a" | "b";
  grossEntitlementLamports: string;
  payoutLamports: string;
  feeLamports: string;
  eligibleOrderCount: number;
  recordedBetCount: number;
  allocations: SolanaBetTerminalAllocation[];
};

type IndexedOrder = {
  marketPda: string;
  orderId: string;
  wallet: string;
  side: 1 | 2;
  limitPrice: number;
  amountUnits: bigint;
  matchedAmountUnits: bigint;
  lockedLamports: bigint;
  tradeFeeLamports: bigint;
};

function unsigned(value: string | undefined, label: string): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return BigInt(value);
}

function orderKey(marketPda: string, orderId: string): string {
  return `${marketPda}:${orderId}`;
}

function walletMarketKey(marketPda: string, wallet: string): string {
  return `${marketPda}:${wallet}`;
}

function compareOrderIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildIndexedOrders(
  facts: IndexedLifecycleFact[],
): Map<string, IndexedOrder> {
  const orders = new Map<string, IndexedOrder>();
  for (const envelope of facts) {
    const fact = envelope.fact;
    if (fact.kind !== "ORDER_PLACED") continue;
    const key = orderKey(fact.marketPda, fact.orderId!);
    if (orders.has(key)) {
      throw new Error("terminal settlement found a duplicate order placement");
    }
    orders.set(key, {
      marketPda: fact.marketPda,
      orderId: fact.orderId!,
      wallet: fact.wallet!,
      side: fact.side!,
      limitPrice: fact.price!,
      amountUnits: unsigned(fact.amountUnits, "placed order amount"),
      matchedAmountUnits: 0n,
      lockedLamports: 0n,
      tradeFeeLamports: 0n,
    });
  }

  const matchTotalsByTakerExecution = new Map<
    string,
    { amountUnits: bigint; amountLamports: bigint }
  >();
  for (const envelope of facts) {
    const fact = envelope.fact;
    if (fact.kind !== "ORDER_MATCHED") continue;
    const maker = orders.get(orderKey(fact.marketPda, fact.makerOrderId!));
    const taker = orders.get(orderKey(fact.marketPda, fact.takerOrderId!));
    const amount = unsigned(fact.amountUnits, "matched order amount");
    if (
      !maker ||
      !taker ||
      maker.orderId === taker.orderId ||
      maker.wallet === taker.wallet ||
      maker.side === taker.side ||
      maker.limitPrice !== fact.price ||
      (taker.side === 1 && taker.limitPrice < fact.price!) ||
      (taker.side === 2 && taker.limitPrice > fact.price!)
    ) {
      throw new Error("terminal settlement found a noncanonical order match");
    }
    const makerCost = quoteCostLamports(maker.side, fact.price!, amount);
    const takerCost = quoteCostLamports(taker.side, fact.price!, amount);
    if (makerCost === null || takerCost === null) {
      throw new Error("terminal settlement match cannot be priced exactly");
    }
    maker.matchedAmountUnits += amount;
    maker.lockedLamports += makerCost;
    taker.matchedAmountUnits += amount;
    taker.lockedLamports += takerCost;
    if (
      maker.matchedAmountUnits > maker.amountUnits ||
      taker.matchedAmountUnits > taker.amountUnits
    ) {
      throw new Error("terminal settlement order is overfilled");
    }
    const takerKey = `${envelope.signature}:${fact.marketPda}:${taker.orderId}`;
    const total = matchTotalsByTakerExecution.get(takerKey) ?? {
      amountUnits: 0n,
      amountLamports: 0n,
    };
    total.amountUnits += amount;
    total.amountLamports += takerCost;
    matchTotalsByTakerExecution.set(takerKey, total);
  }

  const seenTakerExecutions = new Set<string>();
  for (const envelope of facts) {
    const fact = envelope.fact;
    if (fact.kind !== "TAKER_EXECUTION") continue;
    const order = orders.get(orderKey(fact.marketPda, fact.orderId!));
    const executionKey = `${envelope.signature}:${fact.marketPda}:${fact.orderId}`;
    const matched = matchTotalsByTakerExecution.get(executionKey) ?? {
      amountUnits: 0n,
      amountLamports: 0n,
    };
    if (
      !order ||
      seenTakerExecutions.has(executionKey) ||
      order.wallet !== fact.wallet ||
      order.side !== fact.side ||
      order.limitPrice !== fact.price ||
      matched.amountUnits !==
        unsigned(fact.amountUnits, "taker matched amount") ||
      matched.amountLamports !==
        unsigned(fact.amountLamports, "taker executed cost")
    ) {
      throw new Error("terminal settlement taker execution is contradictory");
    }
    seenTakerExecutions.add(executionKey);
    order.tradeFeeLamports += unsigned(
      fact.feeLamports,
      "taker execution trade fee",
    );
  }
  for (const executionKey of matchTotalsByTakerExecution.keys()) {
    if (!seenTakerExecutions.has(executionKey)) {
      throw new Error("terminal settlement match is missing taker execution");
    }
  }
  return orders;
}

function validateRecordedBet(
  baseline: BetExecutionBaseline,
  order: IndexedOrder | undefined,
): IndexedOrder {
  if (
    !order ||
    order.marketPda !== baseline.marketPda ||
    order.orderId !== baseline.orderId ||
    order.wallet !== baseline.wallet ||
    order.side !== baseline.side ||
    order.limitPrice !== baseline.limitPrice ||
    order.amountUnits !==
      unsigned(baseline.orderAmountUnits, "recorded order amount")
  ) {
    throw new Error(
      "terminal settlement recorded bet contradicts its indexed order",
    );
  }
  return order;
}

export function reconcileWalletMarketTerminalSettlements(input: {
  facts: IndexedLifecycleFact[];
  recordedBets: BetExecutionBaseline[];
}): SolanaWalletMarketTerminalSettlement[] {
  const facts = input.facts.map((envelope): IndexedLifecycleFact => ({
    ...envelope,
    fact: normalizeLifecycleFact(envelope.fact),
  }));
  const terminalFacts = facts.filter(
    ({ fact }) =>
      fact.kind === "CLAIM_PAYOUT" ||
      fact.kind === "CANCELLATION_REFUND" ||
      fact.kind === "LOSING_BALANCE_CLOSED",
  );
  if (terminalFacts.length === 0) return [];
  const orders = buildIndexedOrders(facts);
  const ordersByWalletMarket = new Map<string, IndexedOrder[]>();
  for (const order of orders.values()) {
    const key = walletMarketKey(order.marketPda, order.wallet);
    const walletOrders = ordersByWalletMarket.get(key) ?? [];
    walletOrders.push(order);
    ordersByWalletMarket.set(key, walletOrders);
  }
  for (const walletOrders of ordersByWalletMarket.values()) {
    walletOrders.sort((left, right) =>
      compareOrderIds(left.orderId, right.orderId),
    );
  }
  const recordedByWalletMarket = new Map<string, BetExecutionBaseline[]>();
  for (const baseline of input.recordedBets) {
    const key = walletMarketKey(baseline.marketPda, baseline.wallet);
    const records = recordedByWalletMarket.get(key) ?? [];
    records.push(baseline);
    recordedByWalletMarket.set(key, records);
  }

  const settledWalletMarkets = new Set<string>();
  const settlements: SolanaWalletMarketTerminalSettlement[] = [];
  for (const envelope of terminalFacts) {
    const fact = envelope.fact;
    const key = walletMarketKey(fact.marketPda, fact.wallet!);
    if (settledWalletMarkets.has(key)) {
      throw new Error("wallet-market terminal settlement is duplicated");
    }
    settledWalletMarkets.add(key);
    const walletOrders = ordersByWalletMarket.get(key) ?? [];
    const recorded = recordedByWalletMarket.get(key) ?? [];
    const validatedRecorded = recorded.map((baseline) => ({
      baseline,
      order: validateRecordedBet(
        baseline,
        orders.get(orderKey(baseline.marketPda, baseline.orderId)),
      ),
    }));

    if (fact.kind === "LOSING_BALANCE_CLOSED") {
      const losingSide = fact.side!;
      const winningSide = losingSide === 1 ? 2 : 1;
      const expectedLosingSide = fact.winner === "a" ? 2 : 1;
      const winningOrders = walletOrders.filter(
        (order) => order.side === winningSide,
      );
      const losingOrders = walletOrders.filter(
        (order) =>
          order.side === losingSide &&
          (order.matchedAmountUnits > 0n || order.lockedLamports > 0n),
      );
      const losingAmountUnits = losingOrders.reduce(
        (sum, order) => sum + order.matchedAmountUnits,
        0n,
      );
      const losingAmountLamports = losingOrders.reduce(
        (sum, order) => sum + order.lockedLamports,
        0n,
      );
      const hasWinningBalance = winningOrders.some(
        (order) => order.matchedAmountUnits > 0n || order.lockedLamports > 0n,
      );
      if (
        fact.status !== "resolved" ||
        (fact.winner !== "a" && fact.winner !== "b") ||
        losingSide !== expectedLosingSide ||
        hasWinningBalance ||
        losingOrders.length === 0 ||
        losingAmountUnits !==
          unsigned(fact.amountUnits, "loser cleanup amount") ||
        losingAmountLamports !==
          unsigned(fact.amountLamports, "loser cleanup locked amount")
      ) {
        throw new Error(
          "wallet-market loser cleanup contradicts indexed order custody",
        );
      }
      const eligibleOrderIds = new Set(
        losingOrders.map((order) => order.orderId),
      );
      const allocations = validatedRecorded
        .filter(({ order }) => eligibleOrderIds.has(order.orderId))
        .map(({ baseline, order }): SolanaBetTerminalAllocation => ({
          betId: baseline.betId,
          orderId: order.orderId,
          side: order.side,
          matchedAmountUnits: order.matchedAmountUnits.toString(),
          grossEntitlementLamports: "0",
          payoutLamports: "0",
          feeLamports: "0",
        }))
        .sort((left, right) => compareOrderIds(left.orderId, right.orderId));
      settlements.push({
        claimSignature: envelope.signature,
        marketPda: fact.marketPda,
        wallet: fact.wallet!,
        kind: "LOSER_CLEANUP",
        status: "resolved",
        winner: fact.winner,
        grossEntitlementLamports: "0",
        payoutLamports: "0",
        feeLamports: "0",
        eligibleOrderCount: losingOrders.length,
        recordedBetCount: allocations.length,
        allocations,
      });
      continue;
    }

    const entitlementByOrder = new Map<string, bigint>();
    for (const order of walletOrders) {
      const entitlement =
        fact.kind === "CANCELLATION_REFUND"
          ? order.lockedLamports + order.tradeFeeLamports
          : (fact.winner === "a" && order.side === 1) ||
              (fact.winner === "b" && order.side === 2)
            ? order.matchedAmountUnits
            : 0n;
      entitlementByOrder.set(order.orderId, entitlement);
    }
    const entitlements = walletOrders
      .map((order) => ({
        orderId: order.orderId,
        gross: entitlementByOrder.get(order.orderId)!,
      }))
      .filter(({ gross }) => gross > 0n);
    const totalGross = entitlements.reduce((sum, row) => sum + row.gross, 0n);
    const payout = unsigned(fact.amountLamports, "terminal payout");
    const fee = unsigned(fact.feeLamports, "terminal fee");
    const refundedTradeFee =
      fact.kind === "CANCELLATION_REFUND" &&
      fact.treasuryFeeLamports !== undefined &&
      fact.marketMakerFeeLamports !== undefined
        ? unsigned(fact.treasuryFeeLamports, "refunded treasury trade fee") +
          unsigned(
            fact.marketMakerFeeLamports,
            "refunded market-maker trade fee",
          )
        : null;
    const indexedTradeFee = walletOrders.reduce(
      (sum, order) => sum + order.tradeFeeLamports,
      0n,
    );
    if (totalGross <= 0n || totalGross !== payout + fee) {
      throw new Error("wallet-market terminal settlement does not conserve");
    }
    if (refundedTradeFee !== null && refundedTradeFee !== indexedTradeFee) {
      throw new Error(
        "cancellation refund trade-fee attribution does not conserve",
      );
    }
    const feesByOrder = allocateFeeByLargestRemainder({
      entitlements,
      totalGross,
      totalFee: fee,
    });
    const allocations = validatedRecorded
      .map(({ baseline, order }): SolanaBetTerminalAllocation => {
        const gross = entitlementByOrder.get(order.orderId) ?? 0n;
        const allocatedFee = feesByOrder.get(order.orderId) ?? 0n;
        if (allocatedFee > gross) {
          throw new Error(
            "recorded terminal settlement fee exceeds entitlement",
          );
        }
        return {
          betId: baseline.betId,
          orderId: order.orderId,
          side: order.side,
          matchedAmountUnits: order.matchedAmountUnits.toString(),
          grossEntitlementLamports: gross.toString(),
          payoutLamports: (gross - allocatedFee).toString(),
          feeLamports: allocatedFee.toString(),
        };
      })
      .sort((left, right) => compareOrderIds(left.orderId, right.orderId));
    settlements.push({
      claimSignature: envelope.signature,
      marketPda: fact.marketPda,
      wallet: fact.wallet!,
      kind: fact.kind as SolanaTerminalSettlementKind,
      status: fact.status as "resolved" | "cancelled",
      winner: fact.winner!,
      grossEntitlementLamports: totalGross.toString(),
      payoutLamports: payout.toString(),
      feeLamports: fee.toString(),
      eligibleOrderCount: entitlements.length,
      recordedBetCount: allocations.length,
      allocations,
    });
  }
  return settlements;
}
