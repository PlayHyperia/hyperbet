import { describe, expect, test } from "bun:test";

import {
  allocateFeeByLargestRemainder,
  validateClaimLifecycleFact,
  verifyClaimLifecycleAccounting,
  verifyClaimTransferEvidence,
} from "./solanaClaimAccounting";

const VAULT = "vault";
const WALLET = "wallet";
const MARKET_MAKER = "market-maker";

describe("SOL terminal claim accounting", () => {
  test("matches the complete on-chain fee domain including zero payout", () => {
    const grossValues = [1n, 9_999n, 10_000n, 10_001n, 1_000_000_000n];
    let verified = 0;
    for (
      let winningsFeeBps = 0;
      winningsFeeBps <= 10_000;
      winningsFeeBps += 1
    ) {
      for (const gross of grossValues) {
        const fee = (gross * BigInt(winningsFeeBps)) / 10_000n;
        const payout = gross - fee;
        expect(
          verifyClaimLifecycleAccounting({
            status: "resolved",
            winner: verified % 2 === 0 ? "a" : "b",
            payoutLamports: payout,
            feeLamports: fee,
            winningsFeeBps,
          }),
        ).toBe("CLAIM_PAYOUT");
        verified += 1;
      }
    }
    expect(verified).toBe(50_005);
    expect(
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "a",
        payoutLamports: 0n,
        feeLamports: 100_000n,
        winningsFeeBps: 10_000,
      }),
    ).toBe("CLAIM_PAYOUT");
  });

  test("rejects noncanonical terminal classifications and fee partitions", () => {
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "a",
        payoutLamports: 0n,
        feeLamports: 0n,
        winningsFeeBps: 0,
      }),
    ).toThrow("no gross entitlement");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "none",
        payoutLamports: 100n,
        feeLamports: 0n,
        winningsFeeBps: 0,
      }),
    ).toThrow("missing a winner");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "b",
        payoutLamports: 99n,
        feeLamports: 2n,
        winningsFeeBps: 100,
      }),
    ).toThrow("fee snapshot");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "cancelled",
        winner: "none",
        payoutLamports: 0n,
        feeLamports: 0n,
        winningsFeeBps: 0,
      }),
    ).toThrow("fee-free refunds");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "cancelled",
        winner: "none",
        payoutLamports: 100n,
        feeLamports: 1n,
        winningsFeeBps: 0,
      }),
    ).toThrow("fee-free refunds");
  });

  test("accepts a positive gross lifecycle fact when payout is zero", () => {
    expect(() =>
      validateClaimLifecycleFact({
        status: "resolved",
        winner: "b",
        payoutLamports: 0n,
        feeLamports: 100_000n,
      }),
    ).not.toThrow();
    for (const invalid of [
      {
        status: "resolved" as const,
        winner: "a" as const,
        payoutLamports: 0n,
        feeLamports: 0n,
      },
      {
        status: "cancelled" as const,
        winner: "none" as const,
        payoutLamports: 100n,
        feeLamports: 0n,
      },
      {
        status: "resolved" as const,
        winner: "none" as const,
        payoutLamports: 100n,
        feeLamports: 0n,
      },
    ]) {
      expect(() => validateClaimLifecycleFact(invalid)).toThrow(
        "positive resolved gross entitlement",
      );
    }
  });

  test("conserves distinct and aliased zero-payout transfer evidence", () => {
    expect(
      verifyClaimTransferEvidence({
        transfers: [
          {
            source: VAULT,
            destination: MARKET_MAKER,
            lamports: 100_000n,
          },
        ],
        vault: VAULT,
        wallet: WALLET,
        marketMaker: MARKET_MAKER,
        eventPayoutLamports: 0n,
        eventWinningsFeeLamports: 100_000n,
      }),
    ).toEqual({ payoutLamports: 0n, feeLamports: 100_000n });
    expect(
      verifyClaimTransferEvidence({
        transfers: [{ source: VAULT, destination: WALLET, lamports: 100_000n }],
        vault: VAULT,
        wallet: WALLET,
        marketMaker: WALLET,
        eventPayoutLamports: 0n,
        eventWinningsFeeLamports: 100_000n,
      }),
    ).toEqual({ payoutLamports: 0n, feeLamports: 100_000n });
  });

  test("allocates a full-fee claim without inventing residual payout", () => {
    expect(
      allocateFeeByLargestRemainder({
        entitlements: [
          { orderId: "4", gross: 1_000n },
          { orderId: "1", gross: 3_000n },
          { orderId: "2", gross: 2_000n },
        ],
        totalGross: 6_000n,
        totalFee: 6_000n,
      }),
    ).toEqual(
      new Map([
        ["1", 3_000n],
        ["2", 2_000n],
        ["4", 1_000n],
      ]),
    );
  });

  test("rejects missing, redirected, zero, and contradictory transfers", () => {
    const canonical = {
      vault: VAULT,
      wallet: WALLET,
      marketMaker: MARKET_MAKER,
      eventPayoutLamports: 0n,
      eventWinningsFeeLamports: 100_000n,
    };
    expect(() =>
      verifyClaimTransferEvidence({ ...canonical, transfers: [] }),
    ).toThrow("claim transfers do not match");
    expect(() =>
      verifyClaimTransferEvidence({
        ...canonical,
        transfers: [
          { source: VAULT, destination: "attacker", lamports: 100_000n },
        ],
      }),
    ).toThrow("noncanonical");
    expect(() =>
      verifyClaimTransferEvidence({
        ...canonical,
        transfers: [
          { source: VAULT, destination: MARKET_MAKER, lamports: 100_000n },
          { source: "attacker", destination: WALLET, lamports: 1n },
        ],
      }),
    ).toThrow("noncanonical");
    expect(() =>
      verifyClaimTransferEvidence({
        ...canonical,
        transfers: [{ source: VAULT, destination: MARKET_MAKER, lamports: 0n }],
      }),
    ).toThrow("noncanonical");
    expect(() =>
      verifyClaimTransferEvidence({
        ...canonical,
        eventWinningsFeeLamports: 0n,
        transfers: [],
      }),
    ).toThrow("noncanonical");
    expect(() =>
      verifyClaimTransferEvidence({
        ...canonical,
        marketMaker: VAULT,
        transfers: [{ source: VAULT, destination: VAULT, lamports: 100_000n }],
      }),
    ).toThrow("noncanonical");
  });
});
