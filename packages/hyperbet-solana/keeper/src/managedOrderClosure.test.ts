import { describe, expect, test } from "bun:test";

import {
  planManagedOrderClosure,
  resolveManagedOrderClosurePriceLevel,
} from "./managedOrderClosure";

describe("managed order closure planning", () => {
  test("preserves reciprocal queue order independently of global order IDs", () => {
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 52,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 54,
        nextOrderId: 0,
        priceLevelHeadOrderId: 54,
        priceLevelTailOrderId: 52,
        priceLevelTotalOpen: 2_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [54] });
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 54,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 0,
        nextOrderId: 52,
        priceLevelHeadOrderId: 54,
        priceLevelTailOrderId: 52,
        priceLevelTotalOpen: 2_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [52] });
  });

  test("normalizes any distinct stale predecessor from the canonical head", () => {
    expect(
      planManagedOrderClosure({
        marketIsOpen: false,
        orderId: 52,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 54,
        nextOrderId: 0,
        priceLevelHeadOrderId: 52,
        priceLevelTailOrderId: 52,
        priceLevelTotalOpen: 1_000,
        continuationPending: false,
      }),
    ).toEqual({ instruction: "reclaim", adjacentOrderIds: [] });
  });

  test("requires exact single-order and strict multi-order total conservation", () => {
    const single = {
      marketIsOpen: false,
      orderId: 52,
      orderBehavior: 0,
      remainingAmount: 1_000,
      previousOrderId: 54,
      nextOrderId: 0,
      priceLevelHeadOrderId: 52,
      priceLevelTailOrderId: 52,
      priceLevelTotalOpen: 1_000,
      continuationPending: false,
    };
    expect(planManagedOrderClosure(single)).toEqual({
      instruction: "reclaim",
      adjacentOrderIds: [],
    });
    expect(() =>
      planManagedOrderClosure({ ...single, priceLevelTotalOpen: 2_000 }),
    ).toThrow("single-order");

    const multiple = {
      ...single,
      previousOrderId: 54,
      priceLevelHeadOrderId: 54,
      priceLevelTotalOpen: 2_000,
    };
    expect(planManagedOrderClosure(multiple)).toEqual({
      instruction: "reclaim",
      adjacentOrderIds: [54],
    });
    expect(() =>
      planManagedOrderClosure({ ...multiple, priceLevelTotalOpen: 1_000 }),
    ).toThrow("multi-order");
    expect(() =>
      planManagedOrderClosure({ ...multiple, priceLevelHeadOrderId: 0 }),
    ).toThrow("partially empty");
    expect(() =>
      planManagedOrderClosure({ ...multiple, remainingAmount: 0 }),
    ).toThrow("must be positive");
    expect(() =>
      planManagedOrderClosure({ ...multiple, orderBehavior: 1 }),
    ).toThrow("resting GTC or post-only");
    expect(() =>
      planManagedOrderClosure({
        ...multiple,
        priceLevelTotalOpen: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("safe integer");
  });

  test("recovers only a continuation-pending order when its price level is absent", () => {
    expect(
      resolveManagedOrderClosurePriceLevel({
        continuationPending: true,
        priceLevel: null,
      }),
    ).toEqual({ headOrderId: 0, tailOrderId: 0, totalOpen: 0 });
    expect(() =>
      resolveManagedOrderClosurePriceLevel({
        continuationPending: false,
        priceLevel: null,
      }),
    ).toThrow("price level is missing");

    expect(
      planManagedOrderClosure({
        marketIsOpen: true,
        orderId: 52,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 0,
        nextOrderId: 0,
        priceLevelHeadOrderId: 0,
        priceLevelTailOrderId: 0,
        priceLevelTotalOpen: 0,
        continuationPending: true,
      }),
    ).toEqual({ instruction: "cancel", adjacentOrderIds: [] });
    expect(() =>
      planManagedOrderClosure({
        marketIsOpen: true,
        orderId: 52,
        orderBehavior: 0,
        remainingAmount: 1_000,
        previousOrderId: 54,
        nextOrderId: 0,
        priceLevelHeadOrderId: 54,
        priceLevelTailOrderId: 52,
        priceLevelTotalOpen: 2_000,
        continuationPending: true,
      }),
    ).toThrow("unexpected book links");
    expect(() =>
      planManagedOrderClosure({
        marketIsOpen: true,
        orderId: 52,
        orderBehavior: 2,
        remainingAmount: 1_000,
        previousOrderId: 0,
        nextOrderId: 0,
        priceLevelHeadOrderId: 0,
        priceLevelTailOrderId: 0,
        priceLevelTotalOpen: 0,
        continuationPending: true,
      }),
    ).toThrow("not GTC");
  });

  test("rejects every noncanonical managed-order or price-level lot", () => {
    const canonical = {
      marketIsOpen: false,
      orderId: 52,
      orderBehavior: 0,
      remainingAmount: 1_000,
      previousOrderId: 54,
      nextOrderId: 0,
      priceLevelHeadOrderId: 54,
      priceLevelTailOrderId: 52,
      priceLevelTotalOpen: 2_000,
      continuationPending: false,
    };
    expect(() =>
      planManagedOrderClosure({ ...canonical, remainingAmount: 1_500 }),
    ).toThrow("1,000-unit lots");
    expect(() =>
      planManagedOrderClosure({ ...canonical, priceLevelTotalOpen: 2_500 }),
    ).toThrow("1,000-unit lots");
  });

  test("rejects self-links, duplicate neighbors, and boundary drift", () => {
    const base = {
      marketIsOpen: false,
      orderId: 52,
      orderBehavior: 0,
      remainingAmount: 1_000,
      previousOrderId: 54,
      nextOrderId: 0,
      priceLevelHeadOrderId: 54,
      priceLevelTailOrderId: 52,
      priceLevelTotalOpen: 2_000,
      continuationPending: false,
    };
    expect(() =>
      planManagedOrderClosure({ ...base, previousOrderId: 52 }),
    ).toThrow("invalid adjacent book links");
    expect(() => planManagedOrderClosure({ ...base, nextOrderId: 52 })).toThrow(
      "invalid adjacent book links",
    );
    expect(() =>
      planManagedOrderClosure({
        ...base,
        previousOrderId: 54,
        nextOrderId: 54,
      }),
    ).toThrow("invalid adjacent book links");
    expect(() =>
      planManagedOrderClosure({ ...base, priceLevelTailOrderId: 99 }),
    ).toThrow("tail");
    expect(() =>
      planManagedOrderClosure({
        ...base,
        previousOrderId: 0,
        priceLevelHeadOrderId: 99,
      }),
    ).toThrow("head");
  });
});
