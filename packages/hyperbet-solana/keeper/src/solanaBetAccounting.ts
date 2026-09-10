import { createHash } from "node:crypto";

import bs58 from "bs58";

const PLACE_ORDER_DISCRIMINATOR = createHash("sha256")
  .update("global:place_order")
  .digest()
  .subarray(0, 8);
const PLACE_ORDER_DATA_LENGTH = 28;

export type DecodedPlaceOrder = {
  orderId: bigint;
  side: 1 | 2;
  price: number;
  amount: bigint;
  orderBehavior: 0 | 1 | 2;
};

export type PlacedOrderEvidence = {
  marketRef: string;
  orderId: bigint;
  maker: string;
  side: number;
  price: number;
  amount: bigint;
};

export type MatchedOrderEvidence = {
  marketRef: string;
  takerOrderId: bigint;
  matchedAmount: bigint;
  price: number;
};

export type SelfTradeEvidence = {
  marketRef: string;
  takerOrderId: bigint;
};

export type TradeFeeEscrowEvidence = {
  marketRef: string;
  orderId: bigint;
  payer: string;
  executedCostLamports: bigint;
  treasuryFeeLamports: bigint;
  marketMakerFeeLamports: bigint;
};

export type NativeTransferEvidence = {
  source: string;
  destination: string;
  lamports: bigint;
};

export type NativeTransferEdge = {
  source: string;
  destination: string;
};

export type VerifiedPlaceOrderAccounting = {
  orderId: string;
  side: 1 | 2;
  limitPrice: number;
  orderBehavior: 0 | 1 | 2;
  orderAmountUnits: string;
  matchedAmountUnits: string;
  restingAmountUnits: string;
  releasedAmountUnits: string;
  collateralLamports: string;
  executedCostLamports: string;
  tradeTreasuryFeeLamports: string;
  tradeMarketMakerFeeLamports: string;
  feeAmountLamports: string;
  sourceAmountLamports: string;
  rewardEligibleLamports: string;
};

export type IndexedPlaceOrderAccountingEvidence = {
  orderId: string;
  side: 1 | 2;
  limitPrice: number;
  orderBehavior: 0 | 1 | 2;
  orderAmountUnits: string;
  matchedAmountUnits: string;
  releasedAmountUnits: string;
  executedCostLamports: string;
  refundLamports: string;
  tradeTreasuryFeeLamports: string;
  tradeMarketMakerFeeLamports: string;
  selfTradeTriggered: boolean;
  tradeTreasuryFeeBps: number;
  tradeMarketMakerFeeBps: number;
};

export function isCanonicalSolanaTransactionSignature(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value !== value.trim() || !value) {
    return false;
  }
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 64 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

export function exactSolanaTransactionSignatures(
  signatures: unknown,
): string[] | null {
  try {
    if (!Array.isArray(signatures) || signatures.length === 0) return null;
    const exactSignatures: string[] = [];
    for (const signature of signatures) {
      if (!isCanonicalSolanaTransactionSignature(signature)) return null;
      exactSignatures.push(signature);
    }
    return exactSignatures;
  } catch {
    return null;
  }
}

export function exactPrimarySolanaTransactionSignature(
  signatures: unknown,
): string | null {
  return exactSolanaTransactionSignatures(signatures)?.[0] ?? null;
}

export function classifySignatureFinality(
  status:
    | {
        err: unknown;
        confirmationStatus?: string | null;
      }
    | null
    | undefined,
): "finalized" | "pending" | "rejected" {
  if (!status) return "pending";
  if (status.err != null) return "rejected";
  return status.confirmationStatus === "finalized" ? "finalized" : "pending";
}

export function requiresFinalizedBetVerification(input: {
  nodeEnv: string | undefined;
  cluster: string | undefined;
}): boolean {
  const nodeEnv = input.nodeEnv?.trim().toLowerCase() ?? "";
  const cluster = input.cluster?.trim().toLowerCase() || "mainnet-beta";
  return (
    nodeEnv === "production" ||
    cluster === "mainnet" ||
    cluster === "mainnet-beta"
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function decodePlaceOrderInstructionData(
  data: unknown,
): DecodedPlaceOrder | null {
  if (typeof data !== "string") return null;
  try {
    const raw = Buffer.from(bs58.decode(data));
    if (
      raw.length !== PLACE_ORDER_DATA_LENGTH ||
      !bytesEqual(raw.subarray(0, 8), PLACE_ORDER_DISCRIMINATOR)
    ) {
      return null;
    }
    const side = raw.readUInt8(16);
    const price = raw.readUInt16LE(17);
    const amount = raw.readBigUInt64LE(19);
    const orderBehavior = raw.readUInt8(27);
    if (
      (side !== 1 && side !== 2) ||
      price < 1 ||
      price > 999 ||
      amount <= 0n ||
      amount % 1_000n !== 0n ||
      (orderBehavior !== 0 && orderBehavior !== 1 && orderBehavior !== 2)
    ) {
      return null;
    }
    return {
      orderId: raw.readBigUInt64LE(8),
      side,
      price,
      amount,
      orderBehavior,
    };
  } catch {
    return null;
  }
}

export function quoteCostLamports(
  side: number,
  price: number,
  amount: bigint,
): bigint | null {
  if ((side !== 1 && side !== 2) || price < 1 || price > 999 || amount <= 0n) {
    return null;
  }
  const priceComponent = BigInt(side === 1 ? price : 1_000 - price);
  const numerator = amount * priceComponent;
  if (numerator % 1_000n !== 0n) return null;
  const cost = numerator / 1_000n;
  return cost > 0n ? cost : null;
}

function bpsFee(amount: bigint, bps: number): bigint {
  if (amount < 0n || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error("invalid fee accounting input");
  }
  return (amount * BigInt(bps)) / 10_000n;
}

function sumTransfers(
  transfers: NativeTransferEvidence[],
  source: string,
  destination: string,
): bigint {
  return transfers.reduce(
    (sum, transfer) =>
      transfer.source === source && transfer.destination === destination
        ? sum + transfer.lamports
        : sum,
    0n,
  );
}

export function hasOnlyAllowedNativeTransferEdges(
  transfers: NativeTransferEvidence[],
  allowedEdges: readonly NativeTransferEdge[],
): boolean {
  return transfers.every(
    (transfer) =>
      transfer.lamports > 0n &&
      allowedEdges.some(
        (edge) =>
          transfer.source === edge.source &&
          transfer.destination === edge.destination,
      ),
  );
}

export function verifyPlaceOrderAccounting(input: {
  order: DecodedPlaceOrder;
  wallet: string;
  marketRef: string;
  vault: string;
  treasury: string;
  marketMaker: string;
  tradeTreasuryFeeBps: number;
  tradeMarketMakerFeeBps: number;
  placedEvents: PlacedOrderEvidence[];
  matchedEvents: MatchedOrderEvidence[];
  selfTradeEvents: SelfTradeEvidence[];
  tradeFeeEscrowEvents: TradeFeeEscrowEvidence[];
  transfers: NativeTransferEvidence[];
}): VerifiedPlaceOrderAccounting {
  const { order } = input;
  if (input.placedEvents.length !== 1) {
    throw new Error("transaction must contain exactly one order-placed event");
  }
  const placed = input.placedEvents[0];
  if (
    !placed ||
    placed.marketRef !== input.marketRef ||
    placed.orderId !== order.orderId ||
    placed.maker !== input.wallet ||
    placed.side !== order.side ||
    placed.price !== order.price ||
    placed.amount !== order.amount
  ) {
    throw new Error("order-placed event does not match the signed instruction");
  }

  if (
    input.matchedEvents.some(
      (event) =>
        event.marketRef !== input.marketRef ||
        event.takerOrderId !== order.orderId,
    ) ||
    input.selfTradeEvents.some(
      (event) =>
        event.marketRef !== input.marketRef ||
        event.takerOrderId !== order.orderId,
    )
  ) {
    throw new Error("transaction contains ambiguous market events");
  }

  let matchedAmount = 0n;
  let executedCost = 0n;
  for (const event of input.matchedEvents) {
    if (
      event.matchedAmount <= 0n ||
      event.matchedAmount % 1_000n !== 0n ||
      event.price < 1 ||
      event.price > 999
    ) {
      throw new Error("order-matched event has invalid amount or price");
    }
    const matchCost = quoteCostLamports(
      order.side,
      event.price,
      event.matchedAmount,
    );
    if (matchCost === null) {
      throw new Error("order-matched event cannot be priced exactly");
    }
    matchedAmount += event.matchedAmount;
    executedCost += matchCost;
  }
  if (matchedAmount > order.amount) {
    throw new Error("matched amount exceeds the signed order amount");
  }

  if (
    !hasOnlyAllowedNativeTransferEdges(input.transfers, [
      { source: input.wallet, destination: input.vault },
      { source: input.vault, destination: input.wallet },
    ])
  ) {
    throw new Error("transaction contains an unexplained native transfer");
  }

  const signedLimitCost = quoteCostLamports(
    order.side,
    order.price,
    order.amount,
  );
  if (signedLimitCost === null) {
    throw new Error("signed order cost is not exactly representable");
  }
  const treasuryFee = bpsFee(executedCost, input.tradeTreasuryFeeBps);
  const marketMakerFee = bpsFee(executedCost, input.tradeMarketMakerFeeBps);
  const feeAmount = treasuryFee + marketMakerFee;
  if (
    input.tradeFeeEscrowEvents.length !== (executedCost > 0n ? 1 : 0) ||
    (input.tradeFeeEscrowEvents[0] !== undefined &&
      (input.tradeFeeEscrowEvents[0].marketRef !== input.marketRef ||
        input.tradeFeeEscrowEvents[0].orderId !== order.orderId ||
        input.tradeFeeEscrowEvents[0].payer !== input.wallet ||
        input.tradeFeeEscrowEvents[0].executedCostLamports !== executedCost ||
        input.tradeFeeEscrowEvents[0].treasuryFeeLamports !== treasuryFee ||
        input.tradeFeeEscrowEvents[0].marketMakerFeeLamports !==
          marketMakerFee))
  ) {
    throw new Error(
      "trade-fee escrow event does not match executed fill value",
    );
  }

  const walletToVault = sumTransfers(
    input.transfers,
    input.wallet,
    input.vault,
  );
  const vaultRefund = sumTransfers(input.transfers, input.vault, input.wallet);
  if (
    walletToVault !== signedLimitCost + feeAmount ||
    vaultRefund > signedLimitCost
  ) {
    throw new Error("vault transfers do not match the signed limit order");
  }
  const collateral = signedLimitCost - vaultRefund;
  if (collateral < executedCost) {
    throw new Error("vault collateral is below executed match cost");
  }

  const restingCollateral = collateral - executedCost;
  const limitComponent = BigInt(
    order.side === 1 ? order.price : 1_000 - order.price,
  );
  const restingNumerator = restingCollateral * 1_000n;
  if (restingNumerator % limitComponent !== 0n) {
    throw new Error("resting collateral cannot be mapped to exact order units");
  }
  const restingAmount = restingNumerator / limitComponent;
  if (
    restingAmount % 1_000n !== 0n ||
    matchedAmount + restingAmount > order.amount
  ) {
    throw new Error("resting and matched amounts exceed the signed order");
  }
  const releasedAmount = order.amount - matchedAmount - restingAmount;
  const selfTradeTriggered = input.selfTradeEvents.length > 0;
  if (order.orderBehavior === 1 && restingAmount !== 0n) {
    throw new Error("IOC order left resting collateral");
  }
  if (
    order.orderBehavior === 2 &&
    (matchedAmount !== 0n || releasedAmount !== 0n)
  ) {
    throw new Error("post-only order unexpectedly matched or released");
  }
  if (order.orderBehavior === 0) {
    if (selfTradeTriggered) {
      if (releasedAmount <= 0n || restingAmount !== 0n) {
        throw new Error("self-trade policy outcome is inconsistent");
      }
    } else if (releasedAmount !== 0n) {
      throw new Error("GTC order released units without self-trade evidence");
    }
  }

  return {
    orderId: order.orderId.toString(),
    side: order.side,
    limitPrice: order.price,
    orderBehavior: order.orderBehavior,
    orderAmountUnits: order.amount.toString(),
    matchedAmountUnits: matchedAmount.toString(),
    restingAmountUnits: restingAmount.toString(),
    releasedAmountUnits: releasedAmount.toString(),
    collateralLamports: collateral.toString(),
    executedCostLamports: executedCost.toString(),
    tradeTreasuryFeeLamports: treasuryFee.toString(),
    tradeMarketMakerFeeLamports: marketMakerFee.toString(),
    feeAmountLamports: feeAmount.toString(),
    sourceAmountLamports: (collateral + feeAmount).toString(),
    rewardEligibleLamports: (executedCost + feeAmount).toString(),
  };
}

function indexedUnsignedInteger(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return BigInt(value);
}

export function verifyIndexedPlaceOrderAccounting(
  input: IndexedPlaceOrderAccountingEvidence,
): VerifiedPlaceOrderAccounting {
  if (
    !/^\d+$/.test(input.orderId) ||
    (input.side !== 1 && input.side !== 2) ||
    !Number.isInteger(input.limitPrice) ||
    input.limitPrice < 1 ||
    input.limitPrice > 999 ||
    (input.orderBehavior !== 0 &&
      input.orderBehavior !== 1 &&
      input.orderBehavior !== 2) ||
    !Number.isInteger(input.tradeTreasuryFeeBps) ||
    input.tradeTreasuryFeeBps < 0 ||
    input.tradeTreasuryFeeBps > 10_000 ||
    !Number.isInteger(input.tradeMarketMakerFeeBps) ||
    input.tradeMarketMakerFeeBps < 0 ||
    input.tradeMarketMakerFeeBps > 10_000 ||
    typeof input.selfTradeTriggered !== "boolean"
  ) {
    throw new Error("indexed order accounting identity is invalid");
  }

  const orderAmount = indexedUnsignedInteger(
    input.orderAmountUnits,
    "indexed order amount",
  );
  const matchedAmount = indexedUnsignedInteger(
    input.matchedAmountUnits,
    "indexed matched amount",
  );
  const releasedAmount = indexedUnsignedInteger(
    input.releasedAmountUnits,
    "indexed released amount",
  );
  const executedCost = indexedUnsignedInteger(
    input.executedCostLamports,
    "indexed executed cost",
  );
  const refund = indexedUnsignedInteger(input.refundLamports, "indexed refund");
  const treasuryFee = indexedUnsignedInteger(
    input.tradeTreasuryFeeLamports,
    "indexed treasury fee",
  );
  const marketMakerFee = indexedUnsignedInteger(
    input.tradeMarketMakerFeeLamports,
    "indexed market-maker fee",
  );
  if (
    orderAmount <= 0n ||
    orderAmount % 1_000n !== 0n ||
    matchedAmount % 1_000n !== 0n ||
    releasedAmount % 1_000n !== 0n ||
    matchedAmount + releasedAmount > orderAmount
  ) {
    throw new Error("indexed order unit conservation failed");
  }
  const restingAmount = orderAmount - matchedAmount - releasedAmount;
  if (
    (input.orderBehavior === 1 && restingAmount !== 0n) ||
    (input.orderBehavior === 2 &&
      (matchedAmount !== 0n || releasedAmount !== 0n)) ||
    (input.orderBehavior === 0 &&
      ((input.selfTradeTriggered &&
        (releasedAmount === 0n || restingAmount !== 0n)) ||
        (!input.selfTradeTriggered && releasedAmount !== 0n)))
  ) {
    throw new Error("indexed order behavior is inconsistent");
  }

  const signedLimitCost = quoteCostLamports(
    input.side,
    input.limitPrice,
    orderAmount,
  );
  const matchedLimitCost =
    matchedAmount === 0n
      ? 0n
      : quoteCostLamports(input.side, input.limitPrice, matchedAmount);
  const restingLimitCost =
    restingAmount === 0n
      ? 0n
      : quoteCostLamports(input.side, input.limitPrice, restingAmount);
  if (
    signedLimitCost === null ||
    matchedLimitCost === null ||
    restingLimitCost === null ||
    executedCost > matchedLimitCost ||
    (executedCost === 0n) !== (matchedAmount === 0n) ||
    refund > signedLimitCost
  ) {
    throw new Error("indexed order value conservation failed");
  }
  const expectedTreasuryFee = bpsFee(executedCost, input.tradeTreasuryFeeBps);
  const expectedMarketMakerFee = bpsFee(
    executedCost,
    input.tradeMarketMakerFeeBps,
  );
  if (
    treasuryFee !== expectedTreasuryFee ||
    marketMakerFee !== expectedMarketMakerFee
  ) {
    throw new Error("indexed order fee split is invalid");
  }

  const collateral = signedLimitCost - refund;
  if (
    collateral < executedCost ||
    collateral - executedCost !== restingLimitCost
  ) {
    throw new Error("indexed order collateral conservation failed");
  }
  const feeAmount = treasuryFee + marketMakerFee;
  return {
    orderId: BigInt(input.orderId).toString(),
    side: input.side,
    limitPrice: input.limitPrice,
    orderBehavior: input.orderBehavior,
    orderAmountUnits: orderAmount.toString(),
    matchedAmountUnits: matchedAmount.toString(),
    restingAmountUnits: restingAmount.toString(),
    releasedAmountUnits: releasedAmount.toString(),
    collateralLamports: collateral.toString(),
    executedCostLamports: executedCost.toString(),
    tradeTreasuryFeeLamports: treasuryFee.toString(),
    tradeMarketMakerFeeLamports: marketMakerFee.toString(),
    feeAmountLamports: feeAmount.toString(),
    sourceAmountLamports: (collateral + feeAmount).toString(),
    rewardEligibleLamports: (executedCost + feeAmount).toString(),
  };
}
