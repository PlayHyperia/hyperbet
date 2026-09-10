export type SolanaMarketAuthoritySnapshot = {
  requireCurrentConfig: boolean;
  canonicalDuelKeyHex: string;
  canonicalDuelState: string;
  canonicalMarketState: string;
  advertisedMarketState: string | null;
  market: {
    duelKeyHex: string;
    duelState: string;
    marketKind: number;
    authority: string;
    treasury: string;
    marketMaker: string;
    tradeTreasuryFeeBps: number;
    tradeMarketMakerFeeBps: number;
    winningsMarketMakerFeeBps: number;
  };
  config: {
    authority: string;
    marketOperator: string;
    treasury: string;
    marketMaker: string;
    tradeTreasuryFeeBps: number;
    tradeMarketMakerFeeBps: number;
    winningsMarketMakerFeeBps: number;
    orderPlacementPaused: boolean | null;
  };
  duelWinnerMarketKind: number;
};

export type SolanaMarketAuthorityState = {
  valid: boolean;
  tradingReady: boolean;
  reason:
    | null
    | "invalid-canonical-identity"
    | "advertised-market-mismatch"
    | "market-duel-mismatch"
    | "market-kind-mismatch"
    | "market-authority-mismatch"
    | "market-recipient-mismatch"
    | "market-fee-mismatch"
    | "market-config-invalid"
    | "order-placement-paused";
};

type RetainableSolanaMarketSnapshot = {
  duelKeyHex: string;
  marketStatus: string;
  winner: string | null;
  tradingReady: boolean;
};

function normalizedText(value: string): string {
  return value.trim();
}

function normalizedDuelKey(value: string): string | null {
  const normalized = value.trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

/**
 * Preserves a previously verified market's exact transaction identity through
 * a transient read gap while making every current-market action fail closed.
 * A real duel rollover still returns null and therefore resets transaction
 * state at the new identity boundary.
 */
export function failClosedSolanaMarketSnapshot<
  T extends RetainableSolanaMarketSnapshot,
>(snapshot: T | null, currentDuelKeyHex: string | null): T | null {
  if (
    !snapshot ||
    !currentDuelKeyHex ||
    normalizedDuelKey(snapshot.duelKeyHex) !==
      normalizedDuelKey(currentDuelKeyHex)
  ) {
    return null;
  }
  return {
    ...snapshot,
    marketStatus: "unavailable",
    winner: null,
    tradingReady: false,
  };
}

function finiteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function result(
  reason: SolanaMarketAuthorityState["reason"],
  valid = false,
): SolanaMarketAuthorityState {
  return {
    valid,
    tradingReady: valid && reason === null,
    reason,
  };
}

/**
 * Verifies the complete immutable identity and fee-recipient snapshot used by
 * the browser before it treats an on-chain duel market as actionable.
 */
export function deriveSolanaMarketAuthorityState(
  input: SolanaMarketAuthoritySnapshot,
): SolanaMarketAuthorityState {
  const canonicalDuelKeyHex = normalizedDuelKey(input.canonicalDuelKeyHex);
  const marketDuelKeyHex = normalizedDuelKey(input.market.duelKeyHex);
  const canonicalDuelState = normalizedText(input.canonicalDuelState);
  const canonicalMarketState = normalizedText(input.canonicalMarketState);
  if (
    canonicalDuelKeyHex === null ||
    marketDuelKeyHex === null ||
    !canonicalDuelState ||
    !canonicalMarketState
  ) {
    return result("invalid-canonical-identity");
  }

  const advertisedMarketState = input.advertisedMarketState?.trim() ?? null;
  if (
    advertisedMarketState !== null &&
    advertisedMarketState !== canonicalMarketState
  ) {
    return result("advertised-market-mismatch");
  }
  if (
    marketDuelKeyHex !== canonicalDuelKeyHex ||
    normalizedText(input.market.duelState) !== canonicalDuelState
  ) {
    return result("market-duel-mismatch");
  }
  if (
    !finiteInteger(input.market.marketKind) ||
    input.market.marketKind !== input.duelWinnerMarketKind
  ) {
    return result("market-kind-mismatch");
  }

  // Once a market stops accepting orders, its immutable authority, recipient,
  // and fee snapshots can legitimately differ from a later config revision.
  // Keep that canonical historical market visible for recovery and claims,
  // while ensuring it can never become trading-ready.
  if (!input.requireCurrentConfig) {
    return {
      valid: true,
      tradingReady: false,
      reason: null,
    };
  }

  const marketAuthority = normalizedText(input.market.authority);
  const configAuthority = normalizedText(input.config.authority);
  const marketOperator = normalizedText(input.config.marketOperator);
  if (
    !marketAuthority ||
    !configAuthority ||
    !marketOperator ||
    (marketAuthority !== configAuthority && marketAuthority !== marketOperator)
  ) {
    return result("market-authority-mismatch");
  }

  if (
    !normalizedText(input.market.treasury) ||
    !normalizedText(input.market.marketMaker) ||
    input.market.treasury !== input.config.treasury ||
    input.market.marketMaker !== input.config.marketMaker
  ) {
    return result("market-recipient-mismatch");
  }

  const marketFees = [
    input.market.tradeTreasuryFeeBps,
    input.market.tradeMarketMakerFeeBps,
    input.market.winningsMarketMakerFeeBps,
  ];
  const configFees = [
    input.config.tradeTreasuryFeeBps,
    input.config.tradeMarketMakerFeeBps,
    input.config.winningsMarketMakerFeeBps,
  ];
  if (
    !marketFees.every(finiteInteger) ||
    !configFees.every(finiteInteger) ||
    marketFees.some((fee, index) => fee !== configFees[index])
  ) {
    return result("market-fee-mismatch");
  }

  if (typeof input.config.orderPlacementPaused !== "boolean") {
    return result("market-config-invalid");
  }
  if (input.config.orderPlacementPaused) {
    return {
      valid: true,
      tradingReady: false,
      reason: "order-placement-paused",
    };
  }
  return result(null, true);
}
