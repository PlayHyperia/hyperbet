import { describe, expect, test } from "bun:test";

import {
  LOCAL_DIAGNOSTIC_DISPUTE_WINDOW_SECONDS,
  MAXIMUM_DISPUTE_WINDOW_SECONDS,
  MINIMUM_DISPUTE_WINDOW_SECONDS,
  resolveOracleDisputeWindowSeconds,
} from "./oracleDisputeWindowPolicy";

describe("SOL oracle dispute-window policy", () => {
  test("keeps the fallback inside exact localnet", () => {
    expect(
      resolveOracleDisputeWindowSeconds({
        cluster: "localnet",
        configuredValue: undefined,
      }),
    ).toBe(LOCAL_DIAGNOSTIC_DISPUTE_WINDOW_SECONDS);
  });

  test("requires an explicit value on every non-local cluster", () => {
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(() =>
        resolveOracleDisputeWindowSeconds({
          cluster,
          configuredValue: undefined,
        }),
      ).toThrow(
        "SOLANA_ORACLE_DISPUTE_WINDOW_SECS must be explicitly configured outside localnet",
      );
    }
  });

  test("accepts exact bounds and rejects malformed or unsupported input", () => {
    for (const configuredValue of [
      MINIMUM_DISPUTE_WINDOW_SECONDS,
      MAXIMUM_DISPUTE_WINDOW_SECONDS,
    ]) {
      expect(
        resolveOracleDisputeWindowSeconds({
          cluster: "devnet",
          configuredValue,
        }),
      ).toBe(configuredValue);
    }
    for (const configuredValue of [
      MINIMUM_DISPUTE_WINDOW_SECONDS - 1,
      MAXIMUM_DISPUTE_WINDOW_SECONDS + 1,
      "1.5",
      "not-a-number",
    ]) {
      expect(() =>
        resolveOracleDisputeWindowSeconds({
          cluster: "devnet",
          configuredValue,
        }),
      ).toThrow("must be an integer between");
    }
    expect(() =>
      resolveOracleDisputeWindowSeconds({
        cluster: "customnet",
        configuredValue: MINIMUM_DISPUTE_WINDOW_SECONDS,
      }),
    ).toThrow("Unsupported Solana dispute-window cluster 'customnet'");
  });
});
