import { describe, expect, test } from "bun:test";

import {
  requireCanonicalCancellationAdjacencyAccounts,
  requireCanonicalInstructionAccountCardinality,
  requireClassifiedMarketEvents,
  requireClassifiedMarketInstructions,
  requireExactLifecycleEventCoverage,
  requireExactMarketSyncCoverage,
  requireOwnedLifecycleExecutionEvents,
  requireUniqueLifecycleExecutionIdentities,
} from "./solanaLifecycleInstructionIdentity";

describe("finalized SOL instruction classification", () => {
  test("classifies the complete current market-program instruction surface", () => {
    expect(() =>
      requireClassifiedMarketInstructions([
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
      ]),
    ).not.toThrow();
  });

  test("rejects new, misspelled, or noncanonical instruction names", () => {
    for (const instructionName of [
      "futureInstruction",
      "place_order",
      "PlaceOrder",
      "",
    ]) {
      expect(() =>
        requireClassifiedMarketInstructions([instructionName]),
      ).toThrow("unclassified");
    }
  });
});

describe("finalized SOL event classification", () => {
  test("classifies the complete current market-program event surface", () => {
    expect(() =>
      requireClassifiedMarketEvents([
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
      ]),
    ).not.toThrow();
  });

  test("rejects new, misspelled, or noncanonical event names", () => {
    for (const eventName of [
      "futureEvent",
      "order_matched",
      "OrderMatched",
      "",
    ]) {
      expect(() => requireClassifiedMarketEvents([eventName])).toThrow(
        "unclassified",
      );
    }
  });
});

describe("finalized SOL instruction account cardinality", () => {
  const fixedCounts = new Map([
    ["cancelOrder", 7],
    ["claim", 8],
    ["closeEmptyPriceLevel", 4],
    ["closeEmptyUserBalance", 3],
    ["closeFilledOrder", 3],
    ["closeLosingBalance", 4],
    ["continueOrder", 11],
    ["freezeConfig", 2],
    ["initializeConfig", 5],
    ["initializeMarket", 6],
    ["placeOrder", 11],
    ["reclaimRestingOrder", 7],
    ["setMarketPaused", 2],
    ["syncMarketFromDuel", 2],
    ["updateConfig", 2],
    ["withdrawResolvedTradeFees", 7],
  ]);

  test("accepts exact fixed graphs and intentional matching accounts", () => {
    expect(() =>
      requireCanonicalInstructionAccountCardinality(
        [...fixedCounts].map(([name, accountCount]) => ({
          name,
          accountCount,
        })),
      ),
    ).not.toThrow();
    expect(() =>
      requireCanonicalInstructionAccountCardinality([
        { name: "placeOrder", accountCount: 37 },
        { name: "continueOrder", accountCount: 45 },
        { name: "cancelOrder", accountCount: 8 },
        { name: "cancelOrder", accountCount: 9 },
        { name: "reclaimRestingOrder", accountCount: 8 },
        { name: "reclaimRestingOrder", accountCount: 9 },
      ]),
    ).not.toThrow();
  });

  test("rejects missing fixed accounts and inert extras on nonmatching instructions", () => {
    for (const [name, fixedCount] of fixedCounts) {
      expect(() =>
        requireCanonicalInstructionAccountCardinality([
          { name, accountCount: fixedCount - 1 },
        ]),
      ).toThrow("account count is invalid");
      if (
        name !== "placeOrder" &&
        name !== "continueOrder" &&
        name !== "cancelOrder" &&
        name !== "reclaimRestingOrder"
      ) {
        expect(() =>
          requireCanonicalInstructionAccountCardinality([
            { name, accountCount: fixedCount + 1 },
          ]),
        ).toThrow("account count is invalid");
      }
    }
    for (const invalid of [
      { name: "futureInstruction", accountCount: 1 },
      { name: "claim", accountCount: -1 },
      { name: "claim", accountCount: 8.5 },
      { name: "cancelOrder", accountCount: 10 },
      { name: "reclaimRestingOrder", accountCount: 10 },
    ]) {
      expect(() =>
        requireCanonicalInstructionAccountCardinality([invalid]),
      ).toThrow("account count is invalid");
    }
  });
});

describe("finalized SOL cancellation adjacency accounts", () => {
  const fixedAccounts = [
    "market",
    "duel",
    "order",
    "price-level",
    "vault",
    "wallet",
    "system-program",
  ];

  test("accepts zero, one, or two distinct adjacent orders", () => {
    for (const remaining of [[], ["previous"], ["previous", "next"]]) {
      expect(() =>
        requireCanonicalCancellationAdjacencyAccounts([
          ...fixedAccounts,
          ...remaining,
        ]),
      ).not.toThrow();
    }
  });

  test("rejects missing fixed accounts, inert aliases, duplicates, and extras", () => {
    for (const accounts of [
      fixedAccounts.slice(0, 6),
      [...fixedAccounts, "order"],
      [...fixedAccounts, "previous", "previous"],
      [...fixedAccounts, "previous", "next", "extra"],
      [...fixedAccounts, ""],
    ]) {
      expect(() =>
        requireCanonicalCancellationAdjacencyAccounts(accounts),
      ).toThrow("adjacency graph is invalid");
    }
  });
});

describe("finalized SOL lifecycle execution identity", () => {
  test("accepts distinct orders and the same order ID in distinct markets", () => {
    expect(() =>
      requireUniqueLifecycleExecutionIdentities([
        { name: "placeOrder", marketRef: "market-a", orderId: 1n },
        { name: "continueOrder", marketRef: "market-a", orderId: 2n },
        { name: "placeOrder", marketRef: "market-b", orderId: 1n },
        { name: "claim", marketRef: "market-a", orderId: null },
      ]),
    ).not.toThrow();
  });

  test("rejects place plus continuation for one market order", () => {
    expect(() =>
      requireUniqueLifecycleExecutionIdentities([
        { name: "placeOrder", marketRef: "market-a", orderId: 7n },
        { name: "continueOrder", marketRef: "market-a", orderId: 7n },
      ]),
    ).toThrow("ambiguous");
  });

  test("rejects two continuations for one market order", () => {
    expect(() =>
      requireUniqueLifecycleExecutionIdentities([
        { name: "continueOrder", marketRef: "market-a", orderId: 7n },
        { name: "continueOrder", marketRef: "market-a", orderId: 7n },
      ]),
    ).toThrow("ambiguous");
  });

  test("rejects missing, zero, or negative execution identity fields", () => {
    for (const invalid of [
      { name: "placeOrder", marketRef: null, orderId: 1n },
      { name: "continueOrder", marketRef: "market-a", orderId: null },
      { name: "placeOrder", marketRef: "market-a", orderId: 0n },
      { name: "continueOrder", marketRef: "market-a", orderId: -1n },
    ]) {
      expect(() =>
        requireUniqueLifecycleExecutionIdentities([invalid]),
      ).toThrow("invalid");
    }
  });
});

describe("finalized SOL market-sync coverage", () => {
  test("requires one event for every sync-emitting instruction per market", () => {
    const syncingNames = [
      "syncMarketFromDuel",
      "placeOrder",
      "continueOrder",
      "cancelOrder",
      "reclaimRestingOrder",
      "claim",
      "closeLosingBalance",
      "withdrawResolvedTradeFees",
    ];
    expect(() =>
      requireExactMarketSyncCoverage({
        instructions: [
          ...syncingNames.map((name) => ({ name, marketRef: "market-a" })),
          { name: "closeFilledOrder", marketRef: "market-a" },
          { name: "initializeMarket", marketRef: "market-b" },
        ],
        eventMarketRefs: syncingNames.map(() => "market-a"),
      }),
    ).not.toThrow();
  });

  test("rejects missing, extra, wrong-market, or malformed sync coverage", () => {
    const instruction = {
      instructions: [{ name: "claim", marketRef: "market-a" }],
    };
    for (const eventMarketRefs of [
      [],
      ["market-a", "market-a"],
      ["market-b"],
      [null],
    ]) {
      expect(() =>
        requireExactMarketSyncCoverage({ ...instruction, eventMarketRefs }),
      ).toThrow();
    }
    expect(() =>
      requireExactMarketSyncCoverage({
        instructions: [{ name: "placeOrder", marketRef: null }],
        eventMarketRefs: [],
      }),
    ).toThrow("instruction identity");
  });
});

describe("finalized SOL mandatory lifecycle-event coverage", () => {
  test("requires one canonical event for every event-emitting instruction", () => {
    const pairs = [
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
    ] as const;
    expect(() =>
      requireExactLifecycleEventCoverage({
        instructions: [
          ...pairs.map(([name]) => ({ name, marketRef: "market-a" })),
          { name: "continueOrder", marketRef: "market-a" },
        ],
        events: [
          ...pairs.map(([, name]) => ({ name, marketRef: "market-a" })),
          { name: "orderMatched", marketRef: "market-a" },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects missing, extra, wrong-market, or malformed mandatory events", () => {
    const instruction = {
      instructions: [{ name: "claim", marketRef: "market-a" }],
    };
    for (const events of [
      [],
      [
        { name: "claimSettled", marketRef: "market-a" },
        { name: "claimSettled", marketRef: "market-a" },
      ],
      [{ name: "claimSettled", marketRef: "market-b" }],
      [{ name: "claimSettled", marketRef: null }],
    ]) {
      expect(() =>
        requireExactLifecycleEventCoverage({ ...instruction, events }),
      ).toThrow();
    }
    expect(() =>
      requireExactLifecycleEventCoverage({
        instructions: [{ name: "placeOrder", marketRef: null }],
        events: [],
      }),
    ).toThrow("instruction event identity");
  });

  test("allows at most one optional price-level close per cancellation or reclaim", () => {
    const mandatoryEvents = [
      { name: "orderCancelled", marketRef: "market-a" },
      { name: "restingOrderReclaimed", marketRef: "market-a" },
    ];
    const instructions = [
      { name: "cancelOrder", marketRef: "market-a" },
      { name: "reclaimRestingOrder", marketRef: "market-a" },
    ];

    for (const optionalCloseCount of [0, 1, 2]) {
      expect(() =>
        requireExactLifecycleEventCoverage({
          instructions,
          events: [
            ...mandatoryEvents,
            ...Array.from({ length: optionalCloseCount }, () => ({
              name: "priceLevelClosed",
              marketRef: "market-a",
            })),
          ],
        }),
      ).not.toThrow();
    }
    expect(() =>
      requireExactLifecycleEventCoverage({
        instructions,
        events: [
          ...mandatoryEvents,
          ...Array.from({ length: 3 }, () => ({
            name: "priceLevelClosed",
            marketRef: "market-a",
          })),
        ],
      }),
    ).toThrow("coverage is inconsistent");
    expect(() =>
      requireExactLifecycleEventCoverage({
        instructions: [],
        events: [{ name: "priceLevelClosed", marketRef: "market-a" }],
      }),
    ).toThrow("coverage is inconsistent");
  });
});

describe("finalized SOL optional execution-event ownership", () => {
  test("binds every match, self-trade, and fee event to one execution identity", () => {
    expect(() =>
      requireOwnedLifecycleExecutionEvents({
        instructions: [
          { name: "placeOrder", marketRef: "market-a", orderId: 7n },
        ],
        events: [
          { name: "orderMatched", marketRef: "market-a", orderId: 7n },
          { name: "orderMatched", marketRef: "market-a", orderId: 7n },
          {
            name: "selfTradePolicyTriggered",
            marketRef: "market-a",
            orderId: 7n,
          },
          {
            name: "tradeFeesEscrowed",
            marketRef: "market-a",
            orderId: 7n,
          },
          { name: "marketSynced", marketRef: "market-b", orderId: null },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects stray or malformed optional execution events", () => {
    const instructions = [
      { name: "continueOrder", marketRef: "market-a", orderId: 7n },
    ];
    for (const event of [
      { name: "orderMatched", marketRef: "market-a", orderId: 8n },
      {
        name: "selfTradePolicyTriggered",
        marketRef: "market-b",
        orderId: 7n,
      },
      { name: "tradeFeesEscrowed", marketRef: null, orderId: 7n },
      { name: "tradeFeesEscrowed", marketRef: "market-a", orderId: 0n },
    ]) {
      expect(() =>
        requireOwnedLifecycleExecutionEvents({
          instructions,
          events: [event],
        }),
      ).toThrow();
    }
  });
});
