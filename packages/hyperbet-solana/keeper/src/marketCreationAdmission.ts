export type DuelMarketAdmission =
  | { action: "recover"; reason: null }
  | { action: "create"; reason: null }
  | {
      action: "reject";
      reason:
        | "renderer-unready"
        | "renderer-observation-predates-market"
        | "betting-window-closed"
        | "market-creation-phase-invalid";
    };

/**
 * Existing on-chain markets remain recoverable while the renderer is degraded
 * so locks, cancellations, and settlement cannot strand funds. First creation
 * is stricter: it requires an authoritative ready renderer and an announcement
 * frame strictly inside the immutable betting window.
 */
export function resolveDuelMarketAdmission(input: {
  existingMarket: boolean;
  rendererReady: boolean;
  rendererUpdatedAt: number;
  phase: string;
  emittedAt: number;
  betOpenTime: number | null;
  betCloseTime: number | null;
}): DuelMarketAdmission {
  if (input.existingMarket) {
    return { action: "recover", reason: null };
  }
  if (!input.rendererReady) {
    return { action: "reject", reason: "renderer-unready" };
  }
  if (input.phase !== "ANNOUNCEMENT") {
    return { action: "reject", reason: "market-creation-phase-invalid" };
  }
  if (
    input.betOpenTime === null ||
    !Number.isSafeInteger(input.betOpenTime) ||
    input.betCloseTime === null ||
    !Number.isSafeInteger(input.betCloseTime) ||
    input.betOpenTime >= input.betCloseTime ||
    input.emittedAt >= input.betCloseTime
  ) {
    return { action: "reject", reason: "betting-window-closed" };
  }
  if (
    !Number.isSafeInteger(input.rendererUpdatedAt) ||
    input.rendererUpdatedAt < input.betOpenTime ||
    input.rendererUpdatedAt > input.emittedAt
  ) {
    return {
      action: "reject",
      reason: "renderer-observation-predates-market",
    };
  }
  return { action: "create", reason: null };
}

export function isCurrentDuelRendererObservation(input: {
  rendererReady: boolean;
  rendererUpdatedAt: number;
  emittedAt: number;
  betOpenTime: number | null;
}): boolean {
  return Boolean(
    input.rendererReady &&
    input.betOpenTime !== null &&
    Number.isSafeInteger(input.betOpenTime) &&
    Number.isSafeInteger(input.rendererUpdatedAt) &&
    input.rendererUpdatedAt >= input.betOpenTime &&
    input.rendererUpdatedAt <= input.emittedAt,
  );
}
