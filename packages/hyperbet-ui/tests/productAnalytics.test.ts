import { describe, expect, test } from "bun:test";

import {
  buildHyperbetProductAnalyticsDetail,
  emitHyperbetProductEvent,
  HYPERBET_PRODUCT_ANALYTICS_BROWSER_EVENT,
  rememberBoundedProductEventKey,
  type HyperbetProductAnalyticsDetail,
} from "../src/lib/productAnalytics";

describe("Hyperbet product analytics contract", () => {
  test("builds a versioned privacy-bounded event without wallet or market identifiers", () => {
    expect(
      buildHyperbetProductAnalyticsDetail(
        "bet_failure",
        {
          failureKind: "USER_REJECTED",
          stage: "signing",
          side: "NO",
        },
        1_700_000_000_000,
      ),
    ).toEqual({
      schemaVersion: 1,
      event: "bet_failure",
      occurredAt: 1_700_000_000_000,
      properties: {
        failureKind: "USER_REJECTED",
        stage: "signing",
        side: "NO",
      },
    });
  });

  test("emits through the browser event boundary without a network sink", () => {
    const target = new EventTarget();
    const observed: HyperbetProductAnalyticsDetail<"stream_start">[] = [];
    target.addEventListener(
      HYPERBET_PRODUCT_ANALYTICS_BROWSER_EVENT,
      (event) => {
        observed.push((event as CustomEvent).detail);
      },
    );

    expect(
      emitHyperbetProductEvent(
        "stream_start",
        { source: "hls", surface: "spectator" },
        { target, occurredAt: 1234 },
      ),
    ).toBe(true);
    expect(observed[0]).toEqual({
      schemaVersion: 1,
      event: "stream_start",
      occurredAt: 1234,
      properties: { source: "hls", surface: "spectator" },
    });
  });

  test("fails closed during server rendering when no event target exists", () => {
    expect(
      emitHyperbetProductEvent(
        "market_lock",
        { phase: "COUNTDOWN" },
        { target: null },
      ),
    ).toBe(false);
  });

  test("deduplicates lifecycle events with bounded long-session memory", () => {
    const seen = new Set<string>();
    expect(rememberBoundedProductEventKey(seen, "duel-1:lock", 2)).toBe(true);
    expect(rememberBoundedProductEventKey(seen, "duel-1:lock", 2)).toBe(false);
    expect(rememberBoundedProductEventKey(seen, "duel-1:result", 2)).toBe(true);
    expect(rememberBoundedProductEventKey(seen, "duel-2:lock", 2)).toBe(true);
    expect([...seen]).toEqual(["duel-1:result", "duel-2:lock"]);
  });
});
