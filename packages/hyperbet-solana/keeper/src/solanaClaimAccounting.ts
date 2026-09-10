export type ClaimTransferEvidence = {
  source: string;
  destination: string;
  lamports: bigint;
};

export type ClaimLifecycleKind = "CLAIM_PAYOUT" | "CANCELLATION_REFUND";

function compareOrderIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function allocateFeeByLargestRemainder(input: {
  entitlements: Array<{ orderId: string; gross: bigint }>;
  totalGross: bigint;
  totalFee: bigint;
}): Map<string, bigint> {
  if (
    input.totalGross <= 0n ||
    input.totalFee < 0n ||
    input.totalFee > input.totalGross
  ) {
    throw new Error("terminal settlement fee allocation input is invalid");
  }
  const rows = input.entitlements.map(({ orderId, gross }) => {
    if (gross <= 0n) {
      throw new Error("terminal settlement entitlement must be positive");
    }
    const numerator = gross * input.totalFee;
    return {
      orderId,
      fee: numerator / input.totalGross,
      remainder: numerator % input.totalGross,
    };
  });
  let allocated = rows.reduce((sum, row) => sum + row.fee, 0n);
  const residual = input.totalFee - allocated;
  if (residual < 0n || residual >= BigInt(Math.max(1, rows.length))) {
    throw new Error("terminal settlement fee residual is invalid");
  }
  rows.sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return compareOrderIds(left.orderId, right.orderId);
  });
  for (let index = 0; index < Number(residual); index += 1) {
    rows[index]!.fee += 1n;
    allocated += 1n;
  }
  if (allocated !== input.totalFee) {
    throw new Error("terminal settlement fees do not conserve");
  }
  return new Map(rows.map((row) => [row.orderId, row.fee]));
}

export function validateClaimLifecycleFact(input: {
  status: "open" | "locked" | "resolved" | "cancelled";
  winner: "none" | "a" | "b";
  payoutLamports: bigint;
  feeLamports: bigint;
}): void {
  if (
    input.payoutLamports < 0n ||
    input.feeLamports < 0n ||
    input.payoutLamports + input.feeLamports <= 0n ||
    input.status !== "resolved" ||
    (input.winner !== "a" && input.winner !== "b")
  ) {
    throw new Error(
      "CLAIM_PAYOUT must describe a positive resolved gross entitlement",
    );
  }
}

export function verifyClaimLifecycleAccounting(input: {
  status: "resolved" | "cancelled";
  winner: "none" | "a" | "b";
  payoutLamports: bigint;
  feeLamports: bigint;
  winningsFeeBps: number;
}): ClaimLifecycleKind {
  if (
    input.payoutLamports < 0n ||
    input.feeLamports < 0n ||
    !Number.isInteger(input.winningsFeeBps) ||
    input.winningsFeeBps < 0 ||
    input.winningsFeeBps > 10_000
  ) {
    throw new Error("claim transfer accounting input is invalid");
  }
  if (input.status === "cancelled") {
    if (
      input.winner !== "none" ||
      input.payoutLamports <= 0n ||
      input.feeLamports !== 0n
    ) {
      throw new Error("cancelled market claims must be fee-free refunds");
    }
    return "CANCELLATION_REFUND";
  }
  if (input.winner !== "a" && input.winner !== "b") {
    throw new Error("resolved market claim is missing a winner");
  }
  const gross = input.payoutLamports + input.feeLamports;
  if (gross <= 0n) {
    throw new Error("resolved market claim has no gross entitlement");
  }
  const expectedFee = (gross * BigInt(input.winningsFeeBps)) / 10_000n;
  if (input.feeLamports !== expectedFee) {
    throw new Error(
      "claim fee transfer does not match the market fee snapshot",
    );
  }
  return "CLAIM_PAYOUT";
}

export function verifyClaimTransferEvidence(input: {
  transfers: ClaimTransferEvidence[];
  vault: string;
  wallet: string;
  marketMaker: string;
  eventPayoutLamports: bigint;
  eventWinningsFeeLamports: bigint;
}): { payoutLamports: bigint; feeLamports: bigint } {
  if (
    input.eventPayoutLamports < 0n ||
    input.eventWinningsFeeLamports < 0n ||
    input.eventPayoutLamports + input.eventWinningsFeeLamports <= 0n ||
    (input.eventWinningsFeeLamports > 0n &&
      input.vault === input.marketMaker) ||
    input.transfers.some(
      (transfer) =>
        transfer.lamports <= 0n ||
        transfer.source !== input.vault ||
        (transfer.destination !== input.wallet &&
          transfer.destination !== input.marketMaker),
    )
  ) {
    throw new Error("claim transfer evidence is noncanonical");
  }
  const transferredToWallet = input.transfers.reduce(
    (sum, transfer) =>
      transfer.source === input.vault && transfer.destination === input.wallet
        ? sum + transfer.lamports
        : sum,
    0n,
  );
  const transferredToMarketMaker = input.transfers.reduce(
    (sum, transfer) =>
      transfer.source === input.vault &&
      transfer.destination === input.marketMaker
        ? sum + transfer.lamports
        : sum,
    0n,
  );

  if (input.wallet === input.marketMaker) {
    if (
      transferredToWallet !==
      input.eventPayoutLamports + input.eventWinningsFeeLamports
    ) {
      throw new Error("aliased claim transfer does not match event accounting");
    }
  } else if (
    transferredToWallet !== input.eventPayoutLamports ||
    transferredToMarketMaker !== input.eventWinningsFeeLamports
  ) {
    throw new Error("claim transfers do not match event accounting");
  }

  return {
    payoutLamports: input.eventPayoutLamports,
    feeLamports: input.eventWinningsFeeLamports,
  };
}
