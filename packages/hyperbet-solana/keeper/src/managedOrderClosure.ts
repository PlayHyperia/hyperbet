export type ManagedOrderClosurePlan = {
  instruction: "cancel" | "reclaim";
  adjacentOrderIds: number[];
};

export type ManagedOrderClosurePriceLevel = {
  headOrderId: number;
  tailOrderId: number;
  totalOpen: number;
};

export function resolveManagedOrderClosurePriceLevel(input: {
  continuationPending: boolean;
  priceLevel: ManagedOrderClosurePriceLevel | null;
}): ManagedOrderClosurePriceLevel {
  if (input.priceLevel) {
    return input.priceLevel;
  }
  if (!input.continuationPending) {
    throw new Error("resting order price level is missing or inconsistent");
  }

  return { headOrderId: 0, tailOrderId: 0, totalOpen: 0 };
}

export function planManagedOrderClosure(input: {
  marketIsOpen: boolean;
  orderId: number;
  orderBehavior: number;
  remainingAmount: number;
  previousOrderId: number;
  nextOrderId: number;
  priceLevelHeadOrderId: number;
  priceLevelTailOrderId: number;
  priceLevelTotalOpen: number;
  continuationPending: boolean;
}): ManagedOrderClosurePlan {
  for (const [label, value] of [
    ["order", input.orderId],
    ["order behavior", input.orderBehavior],
    ["previous order", input.previousOrderId],
    ["next order", input.nextOrderId],
    ["price-level head", input.priceLevelHeadOrderId],
    ["price-level tail", input.priceLevelTailOrderId],
    ["remaining amount", input.remainingAmount],
    ["price-level total open", input.priceLevelTotalOpen],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} id is not a non-negative safe integer`);
    }
  }
  if (input.orderId < 1) {
    throw new Error("order id must be positive");
  }
  if (input.remainingAmount < 1) {
    throw new Error("remaining amount must be positive");
  }
  if (
    input.remainingAmount % 1_000 !== 0 ||
    input.priceLevelTotalOpen % 1_000 !== 0
  ) {
    throw new Error(
      "managed order and price level must use exact 1,000-unit lots",
    );
  }
  if (input.orderBehavior !== 0 && input.orderBehavior !== 2) {
    throw new Error("managed order is not resting GTC or post-only");
  }
  if (input.continuationPending) {
    if (input.orderBehavior !== 0) {
      throw new Error("continuation-pending order is not GTC");
    }
    if (input.previousOrderId !== 0 || input.nextOrderId !== 0) {
      throw new Error("continuation-pending order has unexpected book links");
    }
    return {
      instruction: input.marketIsOpen ? "cancel" : "reclaim",
      adjacentOrderIds: [],
    };
  }

  if (
    input.priceLevelHeadOrderId < 1 ||
    input.priceLevelTailOrderId < 1 ||
    input.priceLevelTotalOpen < 1
  ) {
    throw new Error("resting price level is partially empty");
  }

  // A capped-match continuation may join a level after newer global IDs.
  // Reciprocal links and PriceLevel boundaries—not numeric ID order—define FIFO.
  if (
    input.previousOrderId === input.orderId ||
    input.nextOrderId === input.orderId ||
    (input.previousOrderId !== 0 && input.previousOrderId === input.nextOrderId)
  ) {
    throw new Error("resting order has invalid adjacent book links");
  }
  const effectivePreviousOrderId =
    input.priceLevelHeadOrderId === input.orderId ? 0 : input.previousOrderId;
  if (
    effectivePreviousOrderId === 0 &&
    input.priceLevelHeadOrderId !== input.orderId
  ) {
    throw new Error("price-level head does not reference the resting order");
  }
  if (
    input.nextOrderId === 0 &&
    input.priceLevelTailOrderId !== input.orderId
  ) {
    throw new Error("price-level tail does not reference the resting order");
  }
  if (input.priceLevelHeadOrderId === input.priceLevelTailOrderId) {
    if (
      input.priceLevelHeadOrderId !== input.orderId ||
      input.priceLevelTotalOpen !== input.remainingAmount
    ) {
      throw new Error(
        "single-order price level does not conserve its remainder",
      );
    }
  } else if (input.priceLevelTotalOpen <= input.remainingAmount) {
    throw new Error("multi-order price level does not conserve its remainder");
  }

  const adjacentOrderIds = [effectivePreviousOrderId, input.nextOrderId].filter(
    (orderId) => orderId > 0,
  );
  if (
    adjacentOrderIds.includes(input.orderId) ||
    new Set(adjacentOrderIds).size !== adjacentOrderIds.length
  ) {
    throw new Error("resting order has invalid adjacent book links");
  }
  return {
    instruction: input.marketIsOpen ? "cancel" : "reclaim",
    adjacentOrderIds,
  };
}
