export type ResolvedTradeFeeEscrow = {
  treasuryLamports: bigint;
  marketMakerLamports: bigint;
};

export type ResolvedTradeFeeReleaseResult = {
  attempted: boolean;
  before: ResolvedTradeFeeEscrow;
};

function validateEscrow(
  escrow: ResolvedTradeFeeEscrow,
): ResolvedTradeFeeEscrow {
  if (escrow.treasuryLamports < 0n || escrow.marketMakerLamports < 0n) {
    throw new Error("Resolved trade-fee escrow cannot be negative");
  }
  return escrow;
}

function hasOutstandingFees(escrow: ResolvedTradeFeeEscrow): boolean {
  return escrow.treasuryLamports > 0n || escrow.marketMakerLamports > 0n;
}

/**
 * Releases resolved fee escrow idempotently. Neither a successful RPC return
 * nor an error string proves custody moved; only a zeroed on-chain escrow does.
 */
export async function releaseResolvedTradeFeesFailClosed(input: {
  readEscrow: () => Promise<ResolvedTradeFeeEscrow>;
  submitRelease: () => Promise<void>;
}): Promise<ResolvedTradeFeeReleaseResult> {
  const before = validateEscrow(await input.readEscrow());
  if (!hasOutstandingFees(before)) return { attempted: false, before };

  let submissionError: unknown = null;
  try {
    await input.submitRelease();
  } catch (error) {
    submissionError = error;
  }

  const after = validateEscrow(await input.readEscrow());
  if (!hasOutstandingFees(after)) return { attempted: true, before };
  if (submissionError !== null) throw submissionError;
  throw new Error(
    "Resolved trade-fee release completed, but on-chain escrow remains outstanding",
  );
}

/**
 * Keeps terminal custody cleanup ordered. Health may be captured only after
 * the keeper-owned balance and any resolved fee escrow are safely settled.
 */
export async function reconcileTerminalMarketCustody(input: {
  lifecycleStatus: "RESOLVED" | "CANCELLED";
  settleMarketMakerBalance: () => Promise<void>;
  releaseResolvedTradeFees: () => Promise<void>;
  captureSettledHealth: () => Promise<void>;
}): Promise<void> {
  await input.settleMarketMakerBalance();
  if (input.lifecycleStatus === "RESOLVED") {
    await input.releaseResolvedTradeFees();
  }
  await input.captureSettledHealth();
}
