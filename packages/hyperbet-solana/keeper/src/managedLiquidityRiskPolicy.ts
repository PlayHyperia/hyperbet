const LAMPORTS_PER_SOL = 1_000_000_000n;
const ORDER_LOT_LAMPORTS = 1_000n;

export type ApprovedManagedLiquidityRiskPolicyInput = {
  approval: string | undefined;
  seedSol: string | undefined;
  minQuoteSol: string | undefined;
  referenceBidPriceMillis: string | undefined;
  referenceAskPriceMillis: string | undefined;
  minQuotePriceMillis: string | undefined;
  maxQuotePriceMillis: string | undefined;
  maxInventorySolPerSide: string | undefined;
  maxNetExposureSol: string | undefined;
  maxGrossExposureSol: string | undefined;
  maxSideImbalanceBps: string | undefined;
  maxDrawdownBps: string | undefined;
};

export type ClusterManagedLiquidityRiskPolicyInput =
  ApprovedManagedLiquidityRiskPolicyInput & {
    cluster: string;
  };

export type ManagedLiquidityRiskPolicy = {
  seedLamports: number;
  minQuoteLamports: number;
  referenceBidPriceMillis: number;
  referenceAskPriceMillis: number;
  minQuotePriceMillis: number;
  maxQuotePriceMillis: number;
  maxInventoryLamportsPerSide: number;
  maxNetExposureLamports: number;
  maxGrossExposureLamports: number;
  maxSideImbalanceBps: number;
  maxDrawdownBps: number;
};

function requireExplicit(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} must be explicitly configured outside localnet`);
  }
  return normalized;
}

export function parseManagedLiquiditySolLamports(
  name: string,
  value: string,
): number {
  const normalized = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) {
    throw new Error(
      `${name} must be a positive decimal SOL amount with at most 6 decimal places`,
    );
  }
  const lamports =
    BigInt(match[1]) * LAMPORTS_PER_SOL +
    BigInt((match[2] ?? "").padEnd(9, "0") || "0");
  if (
    lamports <= 0n ||
    lamports % ORDER_LOT_LAMPORTS !== 0n ||
    lamports > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      `${name} must resolve to a positive, order-lot-aligned safe lamport integer`,
    );
  }
  return Number(lamports);
}

function parseInteger(
  name: string,
  value: string | undefined,
  minimum: number,
  maximum: number,
): number {
  const normalized = requireExplicit(name, value);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function resolveApprovedManagedLiquidityRiskPolicy(
  input: ApprovedManagedLiquidityRiskPolicyInput,
): ManagedLiquidityRiskPolicy {
  if (input.approval?.trim() !== "true") {
    throw new Error(
      "SOLANA_LAUNCH_MARKET_MAKER_RISK_APPROVED must be exactly 'true' outside localnet",
    );
  }

  const seedLamports = parseManagedLiquiditySolLamports(
    "MARKET_MAKER_SEED_SOL",
    requireExplicit("MARKET_MAKER_SEED_SOL", input.seedSol),
  );
  const minQuoteLamports = parseManagedLiquiditySolLamports(
    "MARKET_MAKER_MIN_QUOTE_SOL",
    requireExplicit("MARKET_MAKER_MIN_QUOTE_SOL", input.minQuoteSol),
  );
  const referenceBidPriceMillis = parseInteger(
    "MARKET_MAKER_BID_PRICE",
    input.referenceBidPriceMillis,
    1,
    998,
  );
  const referenceAskPriceMillis = parseInteger(
    "MARKET_MAKER_ASK_PRICE",
    input.referenceAskPriceMillis,
    2,
    999,
  );
  const minQuotePriceMillis = parseInteger(
    "MARKET_MAKER_MIN_QUOTE_PRICE_MILLIS",
    input.minQuotePriceMillis,
    1,
    998,
  );
  const maxQuotePriceMillis = parseInteger(
    "MARKET_MAKER_MAX_QUOTE_PRICE_MILLIS",
    input.maxQuotePriceMillis,
    2,
    999,
  );
  const maxInventoryLamportsPerSide = parseManagedLiquiditySolLamports(
    "MARKET_MAKER_MAX_INVENTORY_SOL_PER_SIDE",
    requireExplicit(
      "MARKET_MAKER_MAX_INVENTORY_SOL_PER_SIDE",
      input.maxInventorySolPerSide,
    ),
  );
  const maxNetExposureLamports = parseManagedLiquiditySolLamports(
    "MARKET_MAKER_MAX_NET_EXPOSURE_SOL",
    requireExplicit(
      "MARKET_MAKER_MAX_NET_EXPOSURE_SOL",
      input.maxNetExposureSol,
    ),
  );
  const maxGrossExposureLamports = parseManagedLiquiditySolLamports(
    "MARKET_MAKER_MAX_GROSS_EXPOSURE_SOL",
    requireExplicit(
      "MARKET_MAKER_MAX_GROSS_EXPOSURE_SOL",
      input.maxGrossExposureSol,
    ),
  );
  const maxSideImbalanceBps = parseInteger(
    "MARKET_MAKER_MAX_SIDE_IMBALANCE_BPS",
    input.maxSideImbalanceBps,
    1,
    10_000,
  );
  const maxDrawdownBps = parseInteger(
    "MARKET_MAKER_MAX_DRAWDOWN_BPS",
    input.maxDrawdownBps,
    1,
    10_000,
  );

  if (minQuoteLamports > seedLamports) {
    throw new Error("MARKET_MAKER_MIN_QUOTE_SOL must not exceed seed SOL");
  }
  if (minQuotePriceMillis >= maxQuotePriceMillis) {
    throw new Error(
      "MARKET_MAKER_MIN_QUOTE_PRICE_MILLIS must be below the maximum",
    );
  }
  if (
    referenceBidPriceMillis < minQuotePriceMillis ||
    referenceAskPriceMillis > maxQuotePriceMillis ||
    referenceBidPriceMillis >= referenceAskPriceMillis
  ) {
    throw new Error(
      "MARKET_MAKER_BID_PRICE and MARKET_MAKER_ASK_PRICE must be ordered inside the approved quote-price range",
    );
  }
  if (
    maxInventoryLamportsPerSide < seedLamports ||
    maxNetExposureLamports < seedLamports ||
    maxGrossExposureLamports < seedLamports ||
    maxNetExposureLamports > maxGrossExposureLamports ||
    maxInventoryLamportsPerSide > maxGrossExposureLamports
  ) {
    throw new Error(
      "approved market-maker exposure limits must cover one seed quote and remain bounded by gross exposure",
    );
  }

  return {
    seedLamports,
    minQuoteLamports,
    referenceBidPriceMillis,
    referenceAskPriceMillis,
    minQuotePriceMillis,
    maxQuotePriceMillis,
    maxInventoryLamportsPerSide,
    maxNetExposureLamports,
    maxGrossExposureLamports,
    maxSideImbalanceBps,
    maxDrawdownBps,
  };
}

export function resolveClusterManagedLiquidityRiskPolicy(
  input: ClusterManagedLiquidityRiskPolicyInput,
): ManagedLiquidityRiskPolicy | null {
  const cluster = input.cluster.trim().toLowerCase();
  if (cluster === "localnet") return null;
  if (
    cluster !== "devnet" &&
    cluster !== "testnet" &&
    cluster !== "mainnet" &&
    cluster !== "mainnet-beta"
  ) {
    throw new Error(
      `Unsupported Solana managed-liquidity cluster '${input.cluster}'`,
    );
  }
  return resolveApprovedManagedLiquidityRiskPolicy(input);
}
