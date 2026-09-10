import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  auditKeeperRuntimeEnvironmentPair,
  normalizeRailwayVariablePayload,
} from "./ci-keeper-runtime-env-solana-v1-policy";
import { auditKeeperRuntimeEnvironmentFiles } from "./ci-keeper-runtime-env-solana-v1";
import { resolveSolanaV1Deployment } from "../packages/hyperbet-solana/deployments/v1";

function identity(seed: number): Keypair {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => seed));
}

function secret(seed: number): string {
  return `base64:${Buffer.from(identity(seed).secretKey).toString("base64")}`;
}

function validStagingPair(): {
  service: Record<string, string>;
  duelBot: Record<string, string>;
} {
  const deployment = resolveSolanaV1Deployment("devnet");
  const shared = {
    NODE_ENV: "staging",
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: "https://devnet-rpc.example.com",
    FIGHT_ORACLE_PROGRAM_ID: deployment.fightOracleProgramId,
    DUEL_MARKET_PROGRAM_ID: deployment.duelMarketProgramId,
    FIGHT_ORACLE_EXPECTED_UPGRADE_AUTHORITY: identity(3).publicKey.toBase58(),
    DUEL_MARKET_EXPECTED_UPGRADE_AUTHORITY: identity(4).publicKey.toBase58(),
    KEEPER_BOT_HEALTH_BEARER_TOKEN: "h".repeat(40),
  };
  return {
    service: {
      ...shared,
      HYPERBET_RUNTIME_ROLE: "service",
      STREAM_STATE_SOURCE_URL:
        "https://hyperia.example.com/api/streaming/state",
      STREAM_STATE_SOURCE_BEARER_TOKEN: "s".repeat(40),
      KEEPER_BOT_HEALTH_URL:
        "http://hyperbet-duel-bot.railway.internal/health/snapshot",
      KEEPER_BOT_HEALTH_TIMEOUT_MS: "3000",
      SOLANA_LIFECYCLE_INDEX_START_SLOT: "123456",
      HYPERBET_OPERATOR_ALERT_WEBHOOK_URL:
        "https://alerts.example.com/hyperbet",
      HYPERBET_OPERATOR_ALERT_BEARER_TOKEN: "a".repeat(40),
      HYPERBET_OPERATOR_ALERT_ROUTE_ID: "staging-primary",
      HYPERBET_OPERATOR_ALERT_MONITOR_MS: "5000",
      HYPERBET_OPERATOR_ALERT_REMINDER_MS: "300000",
      HYPERBET_OPERATOR_ALERT_RETRY_MS: "10000",
      HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: "2000",
    },
    duelBot: {
      ...shared,
      HYPERBET_RUNTIME_ROLE: "duel-bot",
      PORT: "8080",
      READINESS_BOT_MAX_AGE_MS: "30000",
      GAME_URL: "https://hyperia.example.com",
      BET_SYNC_SOURCE_BEARER_TOKEN: "b".repeat(40),
      KEEPER_FEE_PAYER_KEYPAIR: secret(10),
      ORACLE_REPORTER_KEYPAIR: secret(11),
      ORACLE_FINALIZER_KEYPAIR: secret(12),
      CLOB_MARKET_OPERATOR_KEYPAIR: secret(13),
      MARKET_MAKER_KEYPAIR: secret(14),
      ORACLE_CHALLENGER_WALLET: identity(15).publicKey.toBase58(),
      TRADE_TREASURY_WALLET: identity(16).publicKey.toBase58(),
      TRADE_MARKET_MAKER_WALLET: identity(17).publicKey.toBase58(),
      SOLANA_LAUNCH_FEE_POLICY_APPROVED: "true",
      SOLANA_ORACLE_DISPUTE_WINDOW_SECS: "3600",
      TRADE_TREASURY_FEE_BPS: "100",
      TRADE_MARKET_MAKER_FEE_BPS: "100",
      WINNINGS_MARKET_MAKER_FEE_BPS: "200",
      SOLANA_LAUNCH_MARKET_MAKER_RISK_APPROVED: "true",
      MARKET_MAKER_SEED_SOL: "1",
      MARKET_MAKER_MIN_QUOTE_SOL: "0.1",
      MARKET_MAKER_BID_PRICE: "400",
      MARKET_MAKER_ASK_PRICE: "600",
      MARKET_MAKER_MIN_QUOTE_PRICE_MILLIS: "100",
      MARKET_MAKER_MAX_QUOTE_PRICE_MILLIS: "900",
      MARKET_MAKER_MAX_INVENTORY_SOL_PER_SIDE: "2",
      MARKET_MAKER_MAX_NET_EXPOSURE_SOL: "2",
      MARKET_MAKER_MAX_GROSS_EXPOSURE_SOL: "5",
      MARKET_MAKER_MAX_SIDE_IMBALANCE_BPS: "5000",
      MARKET_MAKER_MAX_DRAWDOWN_BPS: "5000",
    },
  };
}

describe("protected keeper runtime environment policy", () => {
  test("accepts one complete role-separated staging pair", () => {
    expect(
      auditKeeperRuntimeEnvironmentPair({
        deployment: "staging",
        ...validStagingPair(),
      }),
    ).toEqual([]);
  });

  test("rejects missing role configuration and shared-identity drift", () => {
    const pair = validStagingPair();
    delete pair.duelBot.BET_SYNC_SOURCE_BEARER_TOKEN;
    pair.duelBot.FIGHT_ORACLE_PROGRAM_ID = identity(20).publicKey.toBase58();
    pair.service.KEEPER_BOT_HEALTH_BEARER_TOKEN = "x".repeat(40);
    const errors = auditKeeperRuntimeEnvironmentPair({
      deployment: "staging",
      ...pair,
    });
    expect(errors).toContain(
      "BET_SYNC_SOURCE_BEARER_TOKEN is required on every non-local launch rail",
    );
    expect(errors).toContain(
      "duel-bot is missing required env BET_SYNC_SOURCE_BEARER_TOKEN",
    );
    expect(errors).toContain(
      "FIGHT_ORACLE_PROGRAM_ID must match across service and duel-bot",
    );
    expect(errors).toContain(
      "KEEPER_BOT_HEALTH_BEARER_TOKEN must match across service and duel-bot",
    );
  });

  test("rejects canonical program IDs outside the approved deployment manifest", () => {
    const pair = validStagingPair();
    pair.service.FIGHT_ORACLE_PROGRAM_ID = identity(20).publicKey.toBase58();
    pair.duelBot.FIGHT_ORACLE_PROGRAM_ID = identity(20).publicKey.toBase58();
    const errors = auditKeeperRuntimeEnvironmentPair({
      deployment: "staging",
      ...pair,
    });
    expect(errors).toContain(
      "service FIGHT_ORACLE_PROGRAM_ID must match the approved devnet deployment manifest",
    );
    expect(errors).toContain(
      "duel-bot FIGHT_ORACLE_PROGRAM_ID must match the approved devnet deployment manifest",
    );
  });

  test("rejects cross-role secret leakage and diagnostic authority", () => {
    const pair = validStagingPair();
    pair.service.KEEPER_FEE_PAYER_KEYPAIR = secret(30);
    pair.service.BET_SYNC_SOURCE_BEARER_TOKEN = "leaked";
    pair.duelBot.HYPERBET_OPERATOR_ALERT_BEARER_TOKEN = "leaked";
    pair.duelBot.HELIUS_API_KEY = "leaked";
    pair.duelBot.HYPERBET_LOCAL_DIAGNOSTIC_FEED = "true";
    const errors = auditKeeperRuntimeEnvironmentPair({
      deployment: "staging",
      ...pair,
    });
    expect(errors).toContain(
      "service must not receive duel-bot secret KEEPER_FEE_PAYER_KEYPAIR",
    );
    expect(errors).toContain(
      "service must not receive duel-bot secret BET_SYNC_SOURCE_BEARER_TOKEN",
    );
    expect(errors).toContain(
      "duel-bot must not receive service-only secret HYPERBET_OPERATOR_ALERT_BEARER_TOKEN",
    );
    expect(errors).toContain(
      "duel-bot must not receive service-only secret HELIUS_API_KEY",
    );
    expect(errors).toContain(
      "duel-bot must not enable HYPERBET_LOCAL_DIAGNOSTIC_FEED",
    );
  });

  test("rejects forbidden chain declarations and invalid approved risk values", () => {
    const pair = validStagingPair();
    pair.service.HYPERBET_AVAX_STAGING_RPC_URL = "";
    pair.duelBot.MARKET_MAKER_MAX_GROSS_EXPOSURE_SOL = "0.5";
    const errors = auditKeeperRuntimeEnvironmentPair({
      deployment: "staging",
      ...pair,
    });
    expect(errors).toContain(
      "service declares HYPERBET_AVAX_STAGING_RPC_URL, which is outside the SOL-only v1 environment surface",
    );
    expect(errors).toContain(
      "approved market-maker exposure limits must cover one seed quote and remain bounded by gross exposure",
    );
  });

  test("rejects duplicated inline signer identities and fee-treasury custody", () => {
    const pair = validStagingPair();
    pair.duelBot.ORACLE_REPORTER_KEYPAIR =
      pair.duelBot.KEEPER_FEE_PAYER_KEYPAIR;
    pair.duelBot.TRADE_TREASURY_WALLET = identity(10).publicKey.toBase58();
    const errors = auditKeeperRuntimeEnvironmentPair({
      deployment: "staging",
      ...pair,
    });
    expect(errors).toContain(
      "non-local duel-bot keypair references must differ: KEEPER_FEE_PAYER_KEYPAIR and ORACLE_REPORTER_KEYPAIR",
    );
    expect(errors.some((error) => error.includes("distinct wallets"))).toBe(
      true,
    );
    expect(errors.some((error) => error.includes("fee treasury"))).toBe(true);
  });

  test("requires production-only sender custody without printing its value", () => {
    const pair = validStagingPair();
    for (const environment of [pair.service, pair.duelBot]) {
      environment.NODE_ENV = "production";
      environment.SOLANA_CLUSTER = "mainnet-beta";
    }
    const errors = auditKeeperRuntimeEnvironmentPair({
      deployment: "production",
      ...pair,
    });
    expect(errors).toContain(
      "Solana mainnet program identities are not independently verified for real-value launch",
    );
    expect(errors).toContain("service is missing required env HELIUS_API_KEY");
    expect(errors.join("\n")).not.toContain("redacted");
  });

  test("normalizes supported Railway JSON shapes without exposing metadata", () => {
    expect(
      normalizeRailwayVariablePayload({
        NODE_ENV: "staging",
        SOLANA_CLUSTER: { value: "devnet", isSecret: false },
      }),
    ).toEqual({ NODE_ENV: "staging", SOLANA_CLUSTER: "devnet" });
    expect(
      normalizeRailwayVariablePayload({
        variables: [
          { name: "NODE_ENV", value: "staging" },
          { key: "SOLANA_CLUSTER", value: "devnet" },
        ],
      }),
    ).toEqual({ NODE_ENV: "staging", SOLANA_CLUSTER: "devnet" });
    expect(() =>
      normalizeRailwayVariablePayload([
        { name: "NODE_ENV", value: "staging" },
        { name: "NODE_ENV", value: "production" },
      ]),
    ).toThrow("duplicate key");
  });

  test("file audit consumes both Railway snapshots without returning inspected values", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "keeper-env-audit-"));
    const servicePath = path.join(directory, "service.json");
    const duelBotPath = path.join(directory, "duel-bot.json");
    try {
      const pair = validStagingPair();
      writeFileSync(servicePath, JSON.stringify(pair.service), { mode: 0o600 });
      writeFileSync(duelBotPath, JSON.stringify(pair.duelBot), { mode: 0o600 });
      const passing = auditKeeperRuntimeEnvironmentFiles([
        "--deployment=staging",
        `--service-env-file=${servicePath}`,
        `--duel-bot-env-file=${duelBotPath}`,
      ]);
      expect(passing).toEqual({ deployment: "staging", errors: [] });
      expect(JSON.stringify(passing)).not.toContain("h".repeat(40));

      pair.duelBot.HYPERBET_OPERATOR_ALERT_BEARER_TOKEN =
        "do-not-print-this-secret";
      writeFileSync(duelBotPath, JSON.stringify(pair.duelBot), { mode: 0o600 });
      const failing = auditKeeperRuntimeEnvironmentFiles([
        "--deployment=staging",
        `--service-env-file=${servicePath}`,
        `--duel-bot-env-file=${duelBotPath}`,
      ]);
      expect(failing.errors).toContain(
        "duel-bot must not receive service-only secret HYPERBET_OPERATOR_ALERT_BEARER_TOKEN",
      );
      expect(JSON.stringify(failing)).not.toContain("do-not-print-this-secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
