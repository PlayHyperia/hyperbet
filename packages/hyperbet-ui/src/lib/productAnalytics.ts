export const HYPERBET_PRODUCT_ANALYTICS_BROWSER_EVENT =
  "hyperbet:product-analytics";

export type HyperbetProductAnalyticsPayloads = {
  stream_start: {
    source: "hls";
    surface: "spectator";
  };
  market_view: {
    mode: string;
    phase: string;
  };
  bet_attempt: {
    orderKind: "limit";
    side: "YES" | "NO";
  };
  bet_success: {
    finality: "confirmed";
    side: "YES" | "NO";
  };
  bet_failure: {
    failureKind: string;
    stage: string;
    side: "YES" | "NO";
  };
  market_lock: {
    phase: string;
  };
  result: {
    winner: "A" | "B" | "DRAW" | "UNKNOWN";
  };
  cancellation: {
    outcome: "cancelled";
  };
  refund_attempt: {
    source: "active" | "history";
  };
  refund_success: {
    finality: "confirmed";
  };
  refund_failure: {
    failureKind: string;
    stage: string;
  };
  claim_attempt: {
    source: "active" | "history";
  };
  claim_success: {
    finality: "confirmed";
  };
  claim_failure: {
    failureKind: string;
    stage: string;
  };
};

export type HyperbetProductAnalyticsName =
  keyof HyperbetProductAnalyticsPayloads;

export type HyperbetProductAnalyticsDetail<
  Name extends HyperbetProductAnalyticsName = HyperbetProductAnalyticsName,
> = {
  schemaVersion: 1;
  event: Name;
  occurredAt: number;
  properties: HyperbetProductAnalyticsPayloads[Name];
};

export function buildHyperbetProductAnalyticsDetail<
  Name extends HyperbetProductAnalyticsName,
>(
  event: Name,
  properties: HyperbetProductAnalyticsPayloads[Name],
  occurredAt = Date.now(),
): HyperbetProductAnalyticsDetail<Name> {
  return {
    schemaVersion: 1,
    event,
    occurredAt,
    properties,
  };
}

export function rememberBoundedProductEventKey(
  seen: Set<string>,
  key: string,
  limit = 128,
): boolean {
  if (seen.has(key)) return false;
  while (seen.size >= Math.max(1, limit)) {
    const oldest = seen.values().next().value;
    if (typeof oldest !== "string") break;
    seen.delete(oldest);
  }
  seen.add(key);
  return true;
}

export function emitHyperbetProductEvent<
  Name extends HyperbetProductAnalyticsName,
>(
  event: Name,
  properties: HyperbetProductAnalyticsPayloads[Name],
  options: {
    occurredAt?: number;
    target?: Pick<EventTarget, "dispatchEvent"> | null;
  } = {},
): boolean {
  const target = Object.prototype.hasOwnProperty.call(options, "target")
    ? (options.target ?? null)
    : typeof window !== "undefined"
      ? window
      : null;
  if (!target || typeof CustomEvent === "undefined") return false;
  return target.dispatchEvent(
    new CustomEvent(HYPERBET_PRODUCT_ANALYTICS_BROWSER_EVENT, {
      detail: buildHyperbetProductAnalyticsDetail(
        event,
        properties,
        options.occurredAt,
      ),
    }),
  );
}
