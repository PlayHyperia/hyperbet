import { describe, expect, test } from "bun:test";

import type { KeeperBotHealthSnapshot } from "./launchHealth";
import { buildKeeperOperatorMetrics } from "./keeperOperatorMetrics";
import {
  fetchKeeperBotHealthSnapshot,
  resolveKeeperBotHealthSourceConfig,
} from "./botHealthTransport";

const DUEL_BOT_RUNTIME = {
  schemaVersion: 1,
  role: "duel-bot",
  cluster: "devnet",
  fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
  duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
} as const;

const SNAPSHOT: KeeperBotHealthSnapshot = {
  chainKey: "solana",
  releaseCommitSha: "a".repeat(40),
  runtime: DUEL_BOT_RUNTIME,
  updatedAtMs: 1_800_000_000_000,
  bootedAtMs: 1_799_999_000_000,
  running: true,
  processId: 123,
  lastSuccessfulRpcAtMs: 1_800_000_000_000,
  recovery: [],
  markets: [],
  operatorMetrics: buildKeeperOperatorMetrics({
    nowMs: 1_800_000_000_000,
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

describe("dedicated duel-bot health transport", () => {
  test("allows no source only on a nonproduction runtime", () => {
    expect(
      resolveKeeperBotHealthSourceConfig({ production: false }),
    ).toBeNull();
    expect(() =>
      resolveKeeperBotHealthSourceConfig({ production: true }),
    ).toThrow("required in production");
  });

  test("accepts only the exact authenticated production endpoint", () => {
    const token = "t".repeat(32);
    expect(
      resolveKeeperBotHealthSourceConfig({
        production: true,
        sourceUrl: "http://duel-bot.railway.internal/health/snapshot",
        bearerToken: token,
        timeoutMs: 250,
      }),
    ).toEqual({
      sourceUrl: "http://duel-bot.railway.internal/health/snapshot",
      bearerToken: token,
      timeoutMs: 250,
    });
    expect(() =>
      resolveKeeperBotHealthSourceConfig({
        production: true,
        sourceUrl: "http://public.example/health/snapshot",
        bearerToken: token,
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      resolveKeeperBotHealthSourceConfig({
        production: false,
        sourceUrl: "http://127.0.0.1/health/snapshot?debug=1",
      }),
    ).toThrow("without a query or fragment");
  });

  test("accepts a parseable degraded response and sends bearer auth", async () => {
    let authorization = "";
    const result = await fetchKeeperBotHealthSnapshot(
      {
        sourceUrl: "http://127.0.0.1/health/snapshot",
        bearerToken: "local-token",
        timeoutMs: 1_000,
      },
      (async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ health: SNAPSHOT }, { status: 503 });
      }) as typeof fetch,
    );
    expect(result).toEqual(SNAPSHOT);
    expect(authorization).toBe("Bearer local-token");
  });

  test("rejects unexpected status and malformed snapshots", async () => {
    await expect(
      fetchKeeperBotHealthSnapshot(
        {
          sourceUrl: "http://127.0.0.1/health/snapshot",
          bearerToken: "",
          timeoutMs: 1_000,
        },
        (async () =>
          new Response("upstream failure", { status: 500 })) as typeof fetch,
      ),
    ).rejects.toThrow("HTTP 500");
    await expect(
      fetchKeeperBotHealthSnapshot(
        {
          sourceUrl: "http://127.0.0.1/health/snapshot",
          bearerToken: "",
          timeoutMs: 1_000,
        },
        (async () =>
          Response.json({ health: { running: true } })) as typeof fetch,
      ),
    ).rejects.toThrow("invalid snapshot");
    const { operatorMetrics: _omitted, ...legacySnapshot } = SNAPSHOT;
    await expect(
      fetchKeeperBotHealthSnapshot(
        {
          sourceUrl: "http://127.0.0.1/health/snapshot",
          bearerToken: "",
          timeoutMs: 1_000,
        },
        (async () => Response.json({ health: legacySnapshot })) as typeof fetch,
      ),
    ).rejects.toThrow("invalid snapshot");
  });
});
