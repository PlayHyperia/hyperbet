import { describe, expect, test } from "bun:test";

import { resolveSolanaTransactionAuthority } from "../../src/lib/realValueLaunchPolicy";

describe("Solana browser transaction authority", () => {
  test("enables transactions only after an explicit test-rail opt-in", () => {
    for (const cluster of ["localnet", "devnet", "testnet"]) {
      expect(
        resolveSolanaTransactionAuthority({ cluster, requested: true }),
      ).toEqual({ enabled: true, rail: "test", reason: null });
    }
  });

  test("keeps test rails read-only by default", () => {
    expect(
      resolveSolanaTransactionAuthority({
        cluster: "devnet",
        requested: false,
      }),
    ).toEqual({
      enabled: false,
      rail: "disabled",
      reason: "disabled-by-configuration",
    });
  });

  test("cannot enable mainnet through a browser build variable", () => {
    for (const cluster of ["mainnet", "mainnet-beta", " MAINNET-BETA "]) {
      expect(
        resolveSolanaTransactionAuthority({ cluster, requested: true }),
      ).toEqual({
        enabled: false,
        rail: "real-value",
        reason: "real-value-controls-incomplete",
      });
    }
  });

  test("fails closed for empty and unknown clusters", () => {
    for (const cluster of ["", "solana", "unknown"]) {
      expect(
        resolveSolanaTransactionAuthority({ cluster, requested: true }),
      ).toEqual({
        enabled: false,
        rail: "disabled",
        reason: "unsupported-cluster",
      });
    }
  });
});
