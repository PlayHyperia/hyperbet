const PRICE_SCALE = 1_000n;
const BPS_SCALE = 10_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_U64 = 18_446_744_073_709_551_615n;

export const SOLANA_CLOB_MAX_MATCHES_PER_TX = 50;

export type SolanaOutcomeSide = "YES" | "NO";

export type SolanaRestingOrderQuote = {
  id: bigint;
  side: SolanaOutcomeSide;
  marketPriceMillis: number;
  amount: bigint;
  filled: bigint;
  maker: string;
  active: boolean;
};

export type SolanaOrderQuote = {
  side: SolanaOutcomeSide;
  amountLamports: bigint;
  outcomePriceMillis: number;
  marketPriceMillis: number;
  limitCollateralLamports: bigint;
  visibleMatchedLamports: bigint;
  visibleRemainingLamports: bigint;
  visibleExecutionCollateralLamports: bigint;
  visibleRestingCollateralLamports: bigint;
  visiblePriceImprovementLamports: bigint;
  visibleTreasuryFeeLamports: bigint;
  visibleMarketMakerFeeLamports: bigint;
  visibleTradeFeeLamports: bigint;
  fullFillTreasuryFeeLamports: bigint;
  fullFillMarketMakerFeeLamports: bigint;
  fullFillTradeFeeLamports: bigint;
  fullFillGrossPayoutLamports: bigint;
  fullFillWinningsFeeLamports: bigint;
  fullFillNetPayoutLamports: bigint;
  fullFillNetProfitLamports: bigint;
  cancellationRefundLamports: bigint;
  refundableExecutionFeeLamports: bigint;
  averageVisibleOutcomePriceMillis: number | null;
  selfTradePrevented: boolean;
  continuationRequired: boolean;
};

function assertU64(value: bigint, label: string): void {
  if (value < 0n || value > MAX_U64) {
    throw new Error(`${label} is outside the program u64 range`);
  }
}

function assertBps(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${label} must be an integer from 0 to 10000 bps`);
  }
}

function mulDivFloorU64(
  left: bigint,
  right: bigint,
  denominator: bigint,
  label: string,
): bigint {
  assertU64(left, `${label} left operand`);
  assertU64(right, `${label} right operand`);
  assertU64(denominator, `${label} denominator`);
  if (denominator <= 0n) {
    throw new Error(`${label} denominator must be positive`);
  }
  const quotient = (left * right) / denominator;
  assertU64(quotient, label);
  return quotient;
}

export function parseSolAmountToLamports(value: string): bigint {
  const normalized = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) {
    throw new Error("SOL amount must use at most 6 decimal places");
  }

  const whole = BigInt(match[1]);
  const fractionalDigits = match[2] ?? "";
  const fractional = BigInt(fractionalDigits.padEnd(9, "0") || "0");
  const lamports = whole * LAMPORTS_PER_SOL + fractional;
  assertU64(lamports, "SOL amount");
  if (lamports <= 0n) {
    throw new Error("SOL amount must be greater than zero");
  }
  return lamports;
}

export function parseOutcomePriceMillis(value: string): number {
  const normalized = value.trim();
  if (!/^\d{1,3}$/.test(normalized)) {
    throw new Error("Limit probability must be an integer from 1 to 999");
  }
  const parsed = Number(normalized);
  if (parsed < 1 || parsed > 999) {
    throw new Error("Limit probability must be an integer from 1 to 999");
  }
  return parsed;
}

export function outcomePriceToMarketPrice(
  side: SolanaOutcomeSide,
  outcomePriceMillis: number,
): number {
  if (
    !Number.isInteger(outcomePriceMillis) ||
    outcomePriceMillis < 1 ||
    outcomePriceMillis > 999
  ) {
    throw new Error("Limit probability must be an integer from 1 to 999");
  }
  return side === "YES" ? outcomePriceMillis : 1_000 - outcomePriceMillis;
}

export function formatSolLamports(
  lamports: bigint,
  maximumFractionDigits = 6,
): string {
  if (
    !Number.isInteger(maximumFractionDigits) ||
    maximumFractionDigits < 0 ||
    maximumFractionDigits > 9
  ) {
    throw new Error("maximumFractionDigits must be between 0 and 9");
  }
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  const visibleFraction = fraction
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${visibleFraction ? `.${visibleFraction}` : ""}`;
}

function quoteCost(amount: bigint, outcomePriceMillis: number): bigint {
  assertU64(amount, "Order amount");
  const price = BigInt(outcomePriceMillis);
  const total = amount * price;
  if (total % PRICE_SCALE !== 0n) {
    throw new Error(
      "Amount and limit probability violate the program's exact precision rule",
    );
  }
  const cost = mulDivFloorU64(amount, price, PRICE_SCALE, "Order collateral");
  if (cost <= 0n) {
    throw new Error("Order collateral is below one lamport");
  }
  return cost;
}

function bpsFee(amount: bigint, bps: number): bigint {
  return mulDivFloorU64(amount, BigInt(bps), BPS_SCALE, "Fee");
}

export function buildSolanaOrderQuote(input: {
  side: SolanaOutcomeSide;
  amountLamports: bigint;
  outcomePriceMillis: number;
  tradeTreasuryFeeBps: number;
  tradeMarketMakerFeeBps: number;
  winningsMarketMakerFeeBps: number;
  wallet: string | null;
  restingOrders: readonly SolanaRestingOrderQuote[];
}): SolanaOrderQuote {
  assertBps(input.tradeTreasuryFeeBps, "Treasury trade fee");
  assertBps(input.tradeMarketMakerFeeBps, "Market-maker trade fee");
  assertBps(input.winningsMarketMakerFeeBps, "Winnings fee");
  if (input.tradeTreasuryFeeBps + input.tradeMarketMakerFeeBps > 10_000) {
    throw new Error("Combined trade fee exceeds the program cap");
  }

  const marketPriceMillis = outcomePriceToMarketPrice(
    input.side,
    input.outcomePriceMillis,
  );
  const limitCollateralLamports = quoteCost(
    input.amountLamports,
    input.outcomePriceMillis,
  );
  const opposingSide = input.side === "YES" ? "NO" : "YES";
  const sortedOpposingOrders = input.restingOrders
    .filter((order) => {
      if (!order.active || order.side !== opposingSide) return false;
      if (order.amount <= order.filled) return false;
      return input.side === "YES"
        ? order.marketPriceMillis <= marketPriceMillis
        : order.marketPriceMillis >= marketPriceMillis;
    })
    .sort((left, right) => {
      const priceOrder =
        input.side === "YES"
          ? left.marketPriceMillis - right.marketPriceMillis
          : right.marketPriceMillis - left.marketPriceMillis;
      if (priceOrder !== 0) return priceOrder;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  let visibleRemainingLamports = input.amountLamports;
  let visibleMatchedLamports = 0n;
  let visibleExecutionCollateralLamports = 0n;
  let visiblePriceImprovementLamports = 0n;
  let selfTradePrevented = false;
  let matches = 0;

  for (const order of sortedOpposingOrders) {
    if (
      visibleRemainingLamports <= 0n ||
      matches >= SOLANA_CLOB_MAX_MATCHES_PER_TX
    ) {
      break;
    }
    if (input.wallet && order.maker === input.wallet) {
      selfTradePrevented = true;
      break;
    }

    const orderRemaining = order.amount - order.filled;
    const fill =
      orderRemaining < visibleRemainingLamports
        ? orderRemaining
        : visibleRemainingLamports;
    const executionOutcomePriceMillis =
      input.side === "YES"
        ? order.marketPriceMillis
        : 1_000 - order.marketPriceMillis;
    const executionCost = quoteCost(fill, executionOutcomePriceMillis);
    const fillAtLimitCost = quoteCost(fill, input.outcomePriceMillis);

    visibleMatchedLamports += fill;
    visibleRemainingLamports -= fill;
    visibleExecutionCollateralLamports += executionCost;
    visiblePriceImprovementLamports += fillAtLimitCost - executionCost;
    matches += 1;
  }

  const continuationRequired =
    visibleRemainingLamports > 0n &&
    matches >= SOLANA_CLOB_MAX_MATCHES_PER_TX &&
    !selfTradePrevented;
  const visibleRestingCollateralLamports = selfTradePrevented
    ? 0n
    : visibleRemainingLamports > 0n
      ? quoteCost(visibleRemainingLamports, input.outcomePriceMillis)
      : 0n;
  const visibleTreasuryFeeLamports = bpsFee(
    visibleExecutionCollateralLamports,
    input.tradeTreasuryFeeBps,
  );
  const visibleMarketMakerFeeLamports = bpsFee(
    visibleExecutionCollateralLamports,
    input.tradeMarketMakerFeeBps,
  );
  const visibleTradeFeeLamports =
    visibleTreasuryFeeLamports + visibleMarketMakerFeeLamports;
  const fullFillTreasuryFeeLamports = bpsFee(
    limitCollateralLamports,
    input.tradeTreasuryFeeBps,
  );
  const fullFillMarketMakerFeeLamports = bpsFee(
    limitCollateralLamports,
    input.tradeMarketMakerFeeBps,
  );
  const fullFillTradeFeeLamports =
    fullFillTreasuryFeeLamports + fullFillMarketMakerFeeLamports;
  const fullFillWinningsFeeLamports = bpsFee(
    input.amountLamports,
    input.winningsMarketMakerFeeBps,
  );
  const fullFillNetPayoutLamports =
    input.amountLamports - fullFillWinningsFeeLamports;

  return {
    side: input.side,
    amountLamports: input.amountLamports,
    outcomePriceMillis: input.outcomePriceMillis,
    marketPriceMillis,
    limitCollateralLamports,
    visibleMatchedLamports,
    visibleRemainingLamports,
    visibleExecutionCollateralLamports,
    visibleRestingCollateralLamports,
    visiblePriceImprovementLamports,
    visibleTreasuryFeeLamports,
    visibleMarketMakerFeeLamports,
    visibleTradeFeeLamports,
    fullFillTreasuryFeeLamports,
    fullFillMarketMakerFeeLamports,
    fullFillTradeFeeLamports,
    fullFillGrossPayoutLamports: input.amountLamports,
    fullFillWinningsFeeLamports,
    fullFillNetPayoutLamports,
    fullFillNetProfitLamports:
      fullFillNetPayoutLamports -
      limitCollateralLamports -
      fullFillTradeFeeLamports,
    cancellationRefundLamports:
      visibleExecutionCollateralLamports +
      visibleRestingCollateralLamports +
      visibleTradeFeeLamports,
    refundableExecutionFeeLamports: visibleTradeFeeLamports,
    averageVisibleOutcomePriceMillis:
      visibleMatchedLamports > 0n
        ? Number(
            (visibleExecutionCollateralLamports * PRICE_SCALE) /
              visibleMatchedLamports,
          )
        : null,
    selfTradePrevented,
    continuationRequired,
  };
}
