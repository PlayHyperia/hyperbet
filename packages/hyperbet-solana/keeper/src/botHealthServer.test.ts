import { describe, expect, test } from "bun:test";

import type { KeeperBotHealthSnapshot } from "./launchHealth";
import { buildKeeperOperatorMetrics } from "./keeperOperatorMetrics";
import {
  evaluateDuelBotProcessReadiness,
  resolveDuelBotHealthServerConfig,
} from "./botHealthServer";

const NOW = 1_800_000_000_000;
const RELEASE_SHA = "a".repeat(40);
const DUEL_BOT_RUNTIME = {
  schemaVersion: 1,
  role: "duel-bot",
  cluster: "devnet",
  fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
  duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
} as const;

function healthySnapshot(): KeeperBotHealthSnapshot {
  const updatedAtMs = NOW - 1_000;
  return {
    chainKey: "solana",
    releaseCommitSha: RELEASE_SHA,
    runtime: DUEL_BOT_RUNTIME,
    updatedAtMs,
    bootedAtMs: NOW - 60_000,
    running: true,
    processId: 123,
    lastSuccessfulRpcAtMs: NOW - 500,
    recovery: [],
    markets: [],
    operatorMetrics: buildKeeperOperatorMetrics({
      nowMs: updatedAtMs,
      checkpoint: null,
      terminal: {
        summary: {
          PENDING: 0,
          PROCESSING: 0,
          SUCCEEDED: 0,
          MANUAL_REVIEW: 0,
          DEAD_LETTER: 0,
        },
        oldestActionableCreatedAt: null,
        recentSucceededDurationsMs: [],
      },
      markets: [],
    }),
  };
}

describe("dedicated duel-bot health server", () => {
  test("normalizes bounded local configuration", () => {
    expect(resolveDuelBotHealthServerConfig({ production: false })).toEqual({
      port: 8080,
      bearerToken: "",
      maxAgeMs: 30_000,
    });
    expect(
      resolveDuelBotHealthServerConfig({
        production: false,
        port: "65535",
        maxAgeMs: "1000",
        bearerToken: " local-token ",
      }),
    ).toEqual({
      port: 65_535,
      bearerToken: "local-token",
      maxAgeMs: 1_000,
    });
  });

  test("fails closed on unsafe ports, freshness, and production auth", () => {
    expect(() =>
      resolveDuelBotHealthServerConfig({ production: false, port: "0" }),
    ).toThrow("1 to 65535");
    expect(() =>
      resolveDuelBotHealthServerConfig({
        production: false,
        maxAgeMs: "999",
      }),
    ).toThrow("1000 to 300000");
    expect(() =>
      resolveDuelBotHealthServerConfig({
        production: true,
        bearerToken: "too-short",
      }),
    ).toThrow("at least 32 characters");
  });

  test("requires one fresh, baked release identity in production", () => {
    expect(
      evaluateDuelBotProcessReadiness({
        nowMs: NOW,
        production: true,
        release: { commitSha: RELEASE_SHA, source: "manifest" },
        runtime: DUEL_BOT_RUNTIME,
        maxAgeMs: 30_000,
        snapshot: healthySnapshot(),
      }),
    ).toEqual({
      ready: true,
      reasons: [],
      agesMs: { bot: 1_000, botRpc: 500 },
    });

    expect(
      evaluateDuelBotProcessReadiness({
        nowMs: NOW,
        production: true,
        release: { commitSha: RELEASE_SHA, source: "environment" },
        runtime: DUEL_BOT_RUNTIME,
        maxAgeMs: 30_000,
        snapshot: healthySnapshot(),
      }).reasons,
    ).toContain("release-identity-not-baked");
    expect(
      evaluateDuelBotProcessReadiness({
        nowMs: NOW,
        production: true,
        release: { commitSha: RELEASE_SHA, source: "manifest" },
        maxAgeMs: 30_000,
        snapshot: healthySnapshot(),
      }).reasons,
    ).toContain("runtime-identity-unavailable");
  });
});
