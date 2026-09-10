export type LifecycleInstructionIdentity = {
  name: string;
  marketRef: string | null;
  orderId: bigint | null;
};

const CLASSIFIED_MARKET_INSTRUCTIONS = new Set([
  "cancelOrder",
  "claim",
  "closeEmptyPriceLevel",
  "closeEmptyUserBalance",
  "closeFilledOrder",
  "closeLosingBalance",
  "continueOrder",
  "freezeConfig",
  "initializeConfig",
  "initializeMarket",
  "placeOrder",
  "reclaimRestingOrder",
  "setMarketPaused",
  "syncMarketFromDuel",
  "updateConfig",
  "withdrawResolvedTradeFees",
]);

const CLASSIFIED_MARKET_EVENTS = new Set([
  "claimSettled",
  "emptyUserBalanceClosed",
  "filledOrderClosed",
  "losingBalanceClosed",
  "marketCreated",
  "marketSynced",
  "orderCancelled",
  "orderMatched",
  "orderPlaced",
  "priceLevelClosed",
  "resolvedTradeFeesWithdrawn",
  "restingOrderReclaimed",
  "selfTradePolicyTriggered",
  "tradeFeesEscrowed",
]);

const ACCOUNT_CARDINALITY_BY_INSTRUCTION = new Map<
  string,
  { fixedCount: number; maxCount: number | null }
>([
  ["cancelOrder", { fixedCount: 7, maxCount: 9 }],
  ["claim", { fixedCount: 8, maxCount: 8 }],
  ["closeEmptyPriceLevel", { fixedCount: 4, maxCount: 4 }],
  ["closeEmptyUserBalance", { fixedCount: 3, maxCount: 3 }],
  ["closeFilledOrder", { fixedCount: 3, maxCount: 3 }],
  ["closeLosingBalance", { fixedCount: 4, maxCount: 4 }],
  ["continueOrder", { fixedCount: 11, maxCount: null }],
  ["freezeConfig", { fixedCount: 2, maxCount: 2 }],
  ["initializeConfig", { fixedCount: 5, maxCount: 5 }],
  ["initializeMarket", { fixedCount: 6, maxCount: 6 }],
  ["placeOrder", { fixedCount: 11, maxCount: null }],
  ["reclaimRestingOrder", { fixedCount: 7, maxCount: 9 }],
  ["setMarketPaused", { fixedCount: 2, maxCount: 2 }],
  ["syncMarketFromDuel", { fixedCount: 2, maxCount: 2 }],
  ["updateConfig", { fixedCount: 2, maxCount: 2 }],
  ["withdrawResolvedTradeFees", { fixedCount: 7, maxCount: 7 }],
]);

const MARKET_SYNCING_INSTRUCTIONS = new Set([
  "syncMarketFromDuel",
  "placeOrder",
  "continueOrder",
  "cancelOrder",
  "reclaimRestingOrder",
  "claim",
  "closeLosingBalance",
  "withdrawResolvedTradeFees",
]);

const REQUIRED_EVENT_BY_INSTRUCTION = new Map([
  ["initializeMarket", "marketCreated"],
  ["placeOrder", "orderPlaced"],
  ["cancelOrder", "orderCancelled"],
  ["reclaimRestingOrder", "restingOrderReclaimed"],
  ["closeFilledOrder", "filledOrderClosed"],
  ["closeEmptyUserBalance", "emptyUserBalanceClosed"],
  ["closeEmptyPriceLevel", "priceLevelClosed"],
  ["claim", "claimSettled"],
  ["closeLosingBalance", "losingBalanceClosed"],
  ["withdrawResolvedTradeFees", "resolvedTradeFeesWithdrawn"],
]);

const EXECUTION_EVENT_NAMES = new Set([
  "orderMatched",
  "selfTradePolicyTriggered",
  "tradeFeesEscrowed",
]);

export function requireClassifiedMarketInstructions(
  instructionNames: readonly string[],
): void {
  for (const instructionName of instructionNames) {
    if (!CLASSIFIED_MARKET_INSTRUCTIONS.has(instructionName)) {
      throw new Error("finalized market instruction is unclassified");
    }
  }
}

export function requireClassifiedMarketEvents(
  eventNames: readonly string[],
): void {
  for (const eventName of eventNames) {
    if (!CLASSIFIED_MARKET_EVENTS.has(eventName)) {
      throw new Error("finalized market event is unclassified");
    }
  }
}

export function requireCanonicalInstructionAccountCardinality(
  instructions: readonly { name: string; accountCount: number }[],
): void {
  for (const instruction of instructions) {
    const policy = ACCOUNT_CARDINALITY_BY_INSTRUCTION.get(instruction.name);
    if (
      !policy ||
      !Number.isSafeInteger(instruction.accountCount) ||
      instruction.accountCount < policy.fixedCount ||
      (policy.maxCount !== null && instruction.accountCount > policy.maxCount)
    ) {
      throw new Error("finalized market instruction account count is invalid");
    }
  }
}

export function requireCanonicalCancellationAdjacencyAccounts(
  accounts: readonly string[],
): void {
  const fixedAccountCount = 7;
  if (
    accounts.length < fixedAccountCount ||
    accounts.length > fixedAccountCount + 2
  ) {
    throw new Error("finalized cancellation adjacency graph is invalid");
  }

  const fixedAccounts = new Set(accounts.slice(0, fixedAccountCount));
  const adjacentAccounts = new Set<string>();
  for (const account of accounts.slice(fixedAccountCount)) {
    if (
      account.length === 0 ||
      fixedAccounts.has(account) ||
      adjacentAccounts.has(account)
    ) {
      throw new Error("finalized cancellation adjacency graph is invalid");
    }
    adjacentAccounts.add(account);
  }
}

export function requireUniqueLifecycleExecutionIdentities(
  instructions: readonly LifecycleInstructionIdentity[],
): void {
  const seen = new Set<string>();
  for (const instruction of instructions) {
    if (
      instruction.name !== "placeOrder" &&
      instruction.name !== "continueOrder"
    ) {
      continue;
    }
    if (
      !instruction.marketRef ||
      !instruction.orderId ||
      instruction.orderId < 1n
    ) {
      throw new Error("finalized lifecycle execution identity is invalid");
    }
    const identity = `${instruction.marketRef}:${instruction.orderId}`;
    if (seen.has(identity)) {
      throw new Error("finalized lifecycle execution identity is ambiguous");
    }
    seen.add(identity);
  }
}

export function requireExactMarketSyncCoverage(input: {
  instructions: readonly { name: string; marketRef: string | null }[];
  eventMarketRefs: readonly (string | null)[];
}): void {
  const expected = new Map<string, number>();
  for (const instruction of input.instructions) {
    if (!MARKET_SYNCING_INSTRUCTIONS.has(instruction.name)) continue;
    if (!instruction.marketRef) {
      throw new Error("finalized market sync instruction identity is invalid");
    }
    expected.set(
      instruction.marketRef,
      (expected.get(instruction.marketRef) ?? 0) + 1,
    );
  }

  const actual = new Map<string, number>();
  for (const marketRef of input.eventMarketRefs) {
    if (!marketRef) {
      throw new Error("finalized market sync event identity is invalid");
    }
    actual.set(marketRef, (actual.get(marketRef) ?? 0) + 1);
  }

  const markets = new Set([...expected.keys(), ...actual.keys()]);
  for (const marketRef of markets) {
    if ((expected.get(marketRef) ?? 0) !== (actual.get(marketRef) ?? 0)) {
      throw new Error("finalized market sync coverage is inconsistent");
    }
  }
}

export function requireExactLifecycleEventCoverage(input: {
  instructions: readonly { name: string; marketRef: string | null }[];
  events: readonly { name: string; marketRef: string | null }[];
}): void {
  const expected = new Map<string, number>();
  const optionalPriceLevelCloseOwners = new Map<string, number>();
  for (const instruction of input.instructions) {
    if (
      instruction.name === "cancelOrder" ||
      instruction.name === "reclaimRestingOrder"
    ) {
      if (!instruction.marketRef) {
        throw new Error(
          "finalized optional price-level close owner identity is invalid",
        );
      }
      optionalPriceLevelCloseOwners.set(
        instruction.marketRef,
        (optionalPriceLevelCloseOwners.get(instruction.marketRef) ?? 0) + 1,
      );
    }
    const eventName = REQUIRED_EVENT_BY_INSTRUCTION.get(instruction.name);
    if (!eventName) continue;
    if (!instruction.marketRef) {
      throw new Error(
        "finalized lifecycle instruction event identity is invalid",
      );
    }
    const identity = `${eventName}:${instruction.marketRef}`;
    expected.set(identity, (expected.get(identity) ?? 0) + 1);
  }

  const requiredEventNames = new Set(REQUIRED_EVENT_BY_INSTRUCTION.values());
  const actual = new Map<string, number>();
  for (const event of input.events) {
    if (!requiredEventNames.has(event.name)) continue;
    if (!event.marketRef) {
      throw new Error("finalized lifecycle event identity is invalid");
    }
    const identity = `${event.name}:${event.marketRef}`;
    actual.set(identity, (actual.get(identity) ?? 0) + 1);
  }

  const identities = new Set([...expected.keys(), ...actual.keys()]);
  for (const identity of identities) {
    const requiredCount = expected.get(identity) ?? 0;
    const actualCount = actual.get(identity) ?? 0;
    if (identity.startsWith("priceLevelClosed:")) {
      const marketRef = identity.slice("priceLevelClosed:".length);
      const optionalOwnerCount =
        optionalPriceLevelCloseOwners.get(marketRef) ?? 0;
      if (
        actualCount < requiredCount ||
        actualCount > requiredCount + optionalOwnerCount
      ) {
        throw new Error("finalized lifecycle event coverage is inconsistent");
      }
      continue;
    }
    if (requiredCount !== actualCount) {
      throw new Error("finalized lifecycle event coverage is inconsistent");
    }
  }
}

export function requireOwnedLifecycleExecutionEvents(input: {
  instructions: readonly LifecycleInstructionIdentity[];
  events: readonly LifecycleInstructionIdentity[];
}): void {
  const owners = new Set<string>();
  for (const instruction of input.instructions) {
    if (
      instruction.name !== "placeOrder" &&
      instruction.name !== "continueOrder"
    ) {
      continue;
    }
    if (
      !instruction.marketRef ||
      !instruction.orderId ||
      instruction.orderId < 1n
    ) {
      throw new Error("finalized lifecycle execution owner is invalid");
    }
    owners.add(`${instruction.marketRef}:${instruction.orderId}`);
  }

  for (const event of input.events) {
    if (!EXECUTION_EVENT_NAMES.has(event.name)) continue;
    if (!event.marketRef || !event.orderId || event.orderId < 1n) {
      throw new Error("finalized lifecycle execution event is invalid");
    }
    if (!owners.has(`${event.marketRef}:${event.orderId}`)) {
      throw new Error("finalized lifecycle execution event has no owner");
    }
  }
}
