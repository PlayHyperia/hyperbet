function normalizePriceMillis(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000
    ? value
    : null;
}

export function deriveTwoSidedClobProbabilityPercent(
  bestBidMillis: number | null | undefined,
  bestAskMillis: number | null | undefined,
): number | null {
  const bestBid = normalizePriceMillis(bestBidMillis);
  const bestAsk = normalizePriceMillis(bestAskMillis);
  if (
    bestBid === null ||
    bestAsk === null ||
    bestBid <= 0 ||
    bestAsk >= 1_000 ||
    bestBid > bestAsk
  ) {
    return null;
  }
  return (bestBid + bestAsk) / 20;
}

export function shouldRenderSolanaClobStatusRow(input: {
  orderEntryAvailable: boolean;
  tradingUnavailableMessage?: string;
}): boolean {
  return input.orderEntryAvailable || !input.tradingUnavailableMessage?.trim();
}
