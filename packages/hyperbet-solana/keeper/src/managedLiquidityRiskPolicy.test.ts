import { describe, expect, test } from "bun:test";

import {
  parseManagedLiquiditySolLamports,
  resolveApprovedManagedLiquidityRiskPolicy,
  resolveClusterManagedLiquidityRiskPolicy,
  type ApprovedManagedLiquidityRiskPolicyInput,
} from "./managedLiquidityRiskPolicy";

function approvedInput(): ApprovedManagedLiquidityRiskPolicyInput {
  return {
    approval: "true",
    seedSol: "0.5",
    minQuoteSol: "0.05",
    referenceBidPriceMillis: "450",
    referenceAskPriceMillis: "550",
    minQuotePriceMillis: "100",
    maxQuotePriceMillis: "900",
    maxInventorySolPerSide: "2",
    maxNetExposureSol: "3",
    maxGrossExposureSol: "5",
    maxSideImbalanceBps: "7500",
    maxDrawdownBps: "2000",
  };
}

describe("approved managed-liquidity risk policy", () => {
  test("parses exact lot-aligned native SOL amounts", () => {
    expect(parseManagedLiquiditySolLamports("SEED", "0.000001")).toBe(1_000);
    expect(parseManagedLiquiditySolLamports("SEED", "1.25")).toBe(
      1_250_000_000,
    );
    expect(() => parseManagedLiquiditySolLamports("SEED", "0")).toThrow(
      "positive",
    );
    expect(() => parseManagedLiquiditySolLamports("SEED", "0.0000001")).toThrow(
      "at most 6 decimal places",
    );
  });

  test("materializes one explicitly approved and internally bounded policy", () => {
    expect(resolveApprovedManagedLiquidityRiskPolicy(approvedInput())).toEqual({
      seedLamports: 500_000_000,
      minQuoteLamports: 50_000_000,
      referenceBidPriceMillis: 450,
      referenceAskPriceMillis: 550,
      minQuotePriceMillis: 100,
      maxQuotePriceMillis: 900,
      maxInventoryLamportsPerSide: 2_000_000_000,
      maxNetExposureLamports: 3_000_000_000,
      maxGrossExposureLamports: 5_000_000_000,
      maxSideImbalanceBps: 7_500,
      maxDrawdownBps: 2_000,
    });
  });

  test("keeps defaults on exact localnet and requires the full envelope on every other rail", () => {
    expect(
      resolveClusterManagedLiquidityRiskPolicy({
        cluster: " localnet ",
        ...approvedInput(),
        approval: undefined,
      }),
    ).toBeNull();

    const expected = resolveApprovedManagedLiquidityRiskPolicy(approvedInput());
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(
        resolveClusterManagedLiquidityRiskPolicy({
          cluster,
          ...approvedInput(),
        }),
      ).toEqual(expected);
      expect(() =>
        resolveClusterManagedLiquidityRiskPolicy({
          cluster,
          ...approvedInput(),
          approval: undefined,
        }),
      ).toThrow("exactly 'true' outside localnet");
      expect(() =>
        resolveClusterManagedLiquidityRiskPolicy({
          cluster,
          ...approvedInput(),
          maxGrossExposureSol: undefined,
        }),
      ).toThrow("must be explicitly configured outside localnet");
    }
  });

  test("rejects an unknown managed-liquidity rail", () => {
    expect(() =>
      resolveClusterManagedLiquidityRiskPolicy({
        cluster: "solana",
        ...approvedInput(),
      }),
    ).toThrow("Unsupported Solana managed-liquidity cluster");
  });

  test("wires the duel bot through the cluster-aware envelope", async () => {
    const source = await Bun.file(
      new URL("./duelBot.ts", import.meta.url),
    ).text();
    expect(source).toContain("resolveClusterManagedLiquidityRiskPolicy({");
    expect(source).not.toContain(
      "const approvedManagedLiquidityRiskPolicy = isMainnetBot",
    );
    for (const field of [
      "seedLamports",
      "minQuoteLamports",
      "referenceBidPriceMillis",
      "referenceAskPriceMillis",
      "minQuotePriceMillis",
      "maxQuotePriceMillis",
      "maxInventoryLamportsPerSide",
      "maxNetExposureLamports",
      "maxGrossExposureLamports",
      "maxSideImbalanceBps",
      "maxDrawdownBps",
    ]) {
      expect(source).toContain(`managedLiquidityRiskPolicy?.${field}`);
    }
  });

  test("fails closed on missing approval, crossed prices, and unsafe exposure", () => {
    expect(() =>
      resolveApprovedManagedLiquidityRiskPolicy({
        ...approvedInput(),
        approval: "TRUE",
      }),
    ).toThrow("exactly 'true'");
    expect(() =>
      resolveApprovedManagedLiquidityRiskPolicy({
        ...approvedInput(),
        referenceBidPriceMillis: "600",
      }),
    ).toThrow("must be ordered");
    expect(() =>
      resolveApprovedManagedLiquidityRiskPolicy({
        ...approvedInput(),
        maxGrossExposureSol: "1",
      }),
    ).toThrow("exposure limits");
  });
});
