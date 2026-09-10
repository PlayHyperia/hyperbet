import { describe, expect, test } from "bun:test";

import {
  findTrackedEnvPolicyErrors,
  isTrackedSensitiveEnvKey,
  TRACKED_SENSITIVE_ENV_KEYS,
} from "./ci-env-audit-solana-v1-policy";

describe("SOL-only tracked environment policy", () => {
  test("accepts public SOL configuration and placeholder credential values", () => {
    expect(
      findTrackedEnvPolicyErrors(".env.example", {
        SOLANA_CLUSTER: "localnet",
        STREAM_STATE_SOURCE_URL: "http://localhost:5555/api/streaming/state",
        FIGHT_ORACLE_PROGRAM_ID: "11111111111111111111111111111111",
        STREAM_STATE_SOURCE_BEARER_TOKEN: "",
        KEEPER_FEE_PAYER_KEYPAIR: "path/to/keeper.json",
        HELIUS_API_KEY: "<placeholder>",
      }),
    ).toEqual([]);
  });

  test("rejects every forbidden non-SOL declaration even when its value is blank", () => {
    for (const key of [
      "BSC_RPC_URL",
      "BASE_RPC_URL",
      "AVAX_RPC_URL",
      "VITE_AVALANCHE_CHAIN_ID",
      "EVM_PRIVATE_KEY",
      "GOLD_TOKEN_MINT",
      "PERPS_PROGRAM_ID",
      "AMM_ADDRESS",
      "HYPERBET_AVAX_STAGING_RPC_URL",
      "PM_E2E_HARNESS_BSC_RPC_URL",
      "SOLANA_GOLD_TOKEN_MINT",
      "HYPERBET_BASE_STAGING_RPC_URL",
    ]) {
      expect(findTrackedEnvPolicyErrors("fixture.env", { [key]: "" })).toEqual([
        `fixture.env declares ${key}, which is outside the SOL-only v1 environment surface`,
      ]);
    }
  });

  test("rejects committed values for every explicitly tracked credential", () => {
    for (const key of TRACKED_SENSITIVE_ENV_KEYS) {
      expect(isTrackedSensitiveEnvKey(key)).toBe(true);
      expect(
        findTrackedEnvPolicyErrors("fixture.env", { [key]: "real-secret" }),
      ).toContain(`fixture.env contains a non-placeholder value for ${key}`);
    }
  });

  test("uses a credential-name backstop for newly introduced secret variables", () => {
    for (const key of [
      "FUTURE_PROVIDER_API_KEY",
      "FUTURE_SERVICE_TOKEN",
      "FUTURE_SIGNER_KEYPAIR",
      "FUTURE_ACCOUNT_PRIVATE_KEY",
      "FUTURE_ROUTE_PASSWORD",
      "FUTURE_WRITE_KEY",
    ]) {
      expect(isTrackedSensitiveEnvKey(key)).toBe(true);
      expect(
        findTrackedEnvPolicyErrors("fixture.env", { [key]: "value" }),
      ).toEqual([`fixture.env contains a non-placeholder value for ${key}`]);
    }
  });

  test("treats signed alert URLs and headless-wallet JSON as credentials", () => {
    expect(
      findTrackedEnvPolicyErrors("fixture.env", {
        HYPERBET_OPERATOR_ALERT_WEBHOOK_URL:
          "https://alerts.example.com/route?signature=secret",
        VITE_HEADLESS_WALLETS:
          '[{"name":"test","secretKey":"private-material"}]',
      }),
    ).toEqual([
      "fixture.env contains a non-placeholder value for HYPERBET_OPERATOR_ALERT_WEBHOOK_URL",
      "fixture.env contains a non-placeholder value for VITE_HEADLESS_WALLETS",
    ]);
  });
});
