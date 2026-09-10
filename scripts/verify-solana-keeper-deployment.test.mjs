import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveExpectedKeeperReleaseSha,
  validateKeeperBotHealthPayload,
  validateKeeperReadyPayload,
  validateKeeperStatusPayload,
  verifySolanaKeeperDeployment,
} from "./verify-solana-keeper-deployment.mjs";

const EXPECTATIONS = Object.freeze({
  commitSha: "a".repeat(40),
  target: "staging",
  cluster: "devnet",
  fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
  duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
});

function runtime(role) {
  return {
    schemaVersion: 1,
    role,
    cluster: EXPECTATIONS.cluster,
    fightOracleProgramId: EXPECTATIONS.fightOracleProgramId,
    duelMarketProgramId: EXPECTATIONS.duelMarketProgramId,
  };
}

function release(commitSha = EXPECTATIONS.commitSha) {
  return { commitSha, source: "manifest" };
}

function readiness() {
  return {
    ready: true,
    reasons: [],
    agesMs: { stream: 10, bot: 10, botRpc: 10, parser: 10 },
  };
}

function botHealth() {
  return {
    chainKey: "solana",
    releaseCommitSha: EXPECTATIONS.commitSha,
    runtime: runtime("duel-bot"),
    updatedAtMs: 1_800_000_000_000,
    bootedAtMs: 1_799_999_000_000,
    running: true,
    processId: 42,
    lastSuccessfulRpcAtMs: 1_800_000_000_000,
    recovery: [],
    markets: [],
    operatorMetrics: { schemaVersion: 1 },
  };
}

function readyPayload() {
  return {
    ok: true,
    service: "hyperbet-solana-backend",
    now: 1_800_000_000_000,
    release: release(),
    runtime: runtime("service"),
    readiness: readiness(),
    operatorReadiness: { ready: true, alerts: [] },
    correlationIds: [],
  };
}

function statusPayload() {
  return {
    ok: true,
    service: "hyperbet-solana-backend",
    now: 1_800_000_000_000,
    release: release(),
    runtime: runtime("service"),
    readiness: readiness(),
    operatorMetrics: { federated: { ready: true, alerts: [] } },
    parsers: {
      solana: {
        enabled: true,
        lastError: null,
        lastSuccessAt: 1_800_000_000_000,
        snapshot: {
          fightOracleProgram: EXPECTATIONS.fightOracleProgramId,
          marketProgram: EXPECTATIONS.duelMarketProgramId,
        },
      },
    },
    bot: {
      supervision: "dedicated-service",
      runtime: runtime("duel-bot"),
      running: true,
      transport: { source: "remote" },
      health: botHealth(),
    },
  };
}

function botHealthPayload() {
  return {
    ok: true,
    supervision: "dedicated-service",
    runtime: runtime("duel-bot"),
    running: true,
    readiness: readiness(),
    health: botHealth(),
  };
}

function json(value, init = {}) {
  const raw = JSON.stringify(value);
  return new Response(raw, {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(raw)),
      ...init.headers,
    },
  });
}

function responseByPath(overrides = {}) {
  const payloads = {
    "/ready": readyPayload(),
    "/status": statusPayload(),
    "/api/arena/prediction-markets/active": {
      duel: { phase: "IDLE" },
      markets: [],
      updatedAt: 1_800_000_000_000,
    },
    "/api/keeper/bot-health": botHealthPayload(),
    "/api/streaming/duel-context": {
      type: "STREAMING_DUEL_CONTEXT",
      cycle: { phase: "IDLE" },
      leaderboard: [],
      cameraTarget: null,
      updatedAt: 1_800_000_000_000,
    },
    "/api/streaming/leaderboard/details": {
      leaderboard: [],
      cycle: { phase: "IDLE" },
      recentDuels: [],
      historyLimit: 10,
      updatedAt: 1_800_000_000_000,
    },
    ...overrides,
  };
  return async (url, options) => {
    assert.equal(options.redirect, "error");
    const pathname = new URL(url).pathname;
    if (
      pathname === "/api/perps/markets" ||
      pathname === "/api/models/markets" ||
      pathname === "/api/proxy/evm/rpc"
    ) {
      return new Response("not found", { status: 404 });
    }
    if (!(pathname in payloads)) throw new Error(`unexpected path ${pathname}`);
    const payload = payloads[pathname];
    return payload instanceof Response ? payload : json(payload);
  };
}

describe("Solana keeper deployment verifier", () => {
  it("binds workflow and manual recovery verification to one exact release", () => {
    assert.equal(
      resolveExpectedKeeperReleaseSha({ GITHUB_SHA: EXPECTATIONS.commitSha }),
      EXPECTATIONS.commitSha,
    );
    assert.equal(
      resolveExpectedKeeperReleaseSha({
        EXPECTED_KEEPER_RELEASE_SHA: EXPECTATIONS.commitSha,
      }),
      EXPECTATIONS.commitSha,
    );
    assert.equal(
      resolveExpectedKeeperReleaseSha({
        EXPECTED_KEEPER_RELEASE_SHA: EXPECTATIONS.commitSha,
        GITHUB_SHA: EXPECTATIONS.commitSha,
      }),
      EXPECTATIONS.commitSha,
    );
    assert.throws(
      () =>
        resolveExpectedKeeperReleaseSha({
          EXPECTED_KEEPER_RELEASE_SHA: EXPECTATIONS.commitSha,
          GITHUB_SHA: "b".repeat(40),
        }),
      /must identify the same release/,
    );
  });

  it("validates the exact live service, duel-bot, release, and program identity", async () => {
    assert.equal(
      validateKeeperReadyPayload(readyPayload(), EXPECTATIONS).ok,
      true,
    );
    assert.equal(
      validateKeeperStatusPayload(statusPayload(), EXPECTATIONS).ok,
      true,
    );
    assert.equal(
      validateKeeperBotHealthPayload(botHealthPayload(), EXPECTATIONS).ok,
      true,
    );

    const result = await verifySolanaKeeperDeployment({
      keeperUrl: "https://staging-api.hyperbet.win",
      expectations: EXPECTATIONS,
      attempts: 1,
      delayMs: 0,
      fetchImpl: responseByPath(),
      sleep: async () => assert.fail("sleep was not expected"),
    });
    assert.deepEqual(result, {
      origin: "https://staging-api.hyperbet.win",
      releaseSha: EXPECTATIONS.commitSha,
      cluster: "devnet",
      verifiedEndpoints: 9,
    });
  });

  it("rejects stale releases and cross-role or cross-program runtime drift", () => {
    assert.throws(
      () =>
        validateKeeperReadyPayload(
          { ...readyPayload(), release: release("b".repeat(40)) },
          EXPECTATIONS,
        ),
      /release identity/,
    );
    assert.throws(
      () =>
        validateKeeperReadyPayload(
          { ...readyPayload(), runtime: runtime("duel-bot") },
          EXPECTATIONS,
        ),
      /runtime identity/,
    );
    const status = statusPayload();
    status.bot.health.runtime.duelMarketProgramId =
      EXPECTATIONS.fightOracleProgramId;
    assert.throws(
      () => validateKeeperStatusPayload(status, EXPECTATIONS),
      /runtime identity/,
    );
  });

  it("retries stale deployment propagation and succeeds only on the exact release", async () => {
    let readyCalls = 0;
    let sleeps = 0;
    const normalFetch = responseByPath();
    const fetchImpl = async (url, options) => {
      if (new URL(url).pathname === "/ready" && readyCalls++ === 0) {
        return json({
          ...readyPayload(),
          release: release("b".repeat(40)),
        });
      }
      return await normalFetch(url, options);
    };
    const result = await verifySolanaKeeperDeployment({
      keeperUrl: "https://staging-api.hyperbet.win",
      expectations: EXPECTATIONS,
      attempts: 2,
      delayMs: 1,
      fetchImpl,
      sleep: async (delay) => {
        assert.equal(delay, 1);
        sleeps += 1;
      },
    });
    assert.equal(result.releaseSha, EXPECTATIONS.commitSha);
    assert.equal(readyCalls, 2);
    assert.equal(sleeps, 1);
  });

  it("fails closed on ambiguous targets, inconsistent rails, and oversized bodies", async () => {
    for (const keeperUrl of [
      "http://staging-api.hyperbet.win",
      "https://user:pass@staging-api.hyperbet.win",
      "https://staging-api.hyperbet.win/base",
      "https://staging-api.hyperbet.win?debug=1",
    ]) {
      await assert.rejects(() =>
        verifySolanaKeeperDeployment({
          keeperUrl,
          expectations: EXPECTATIONS,
          attempts: 1,
          delayMs: 0,
          fetchImpl: responseByPath(),
          sleep: async () => {},
        }),
      );
    }
    await assert.rejects(() =>
      verifySolanaKeeperDeployment({
        keeperUrl: "https://staging-api.hyperbet.win",
        expectations: { ...EXPECTATIONS, cluster: "mainnet-beta" },
        attempts: 1,
        delayMs: 0,
        fetchImpl: responseByPath(),
        sleep: async () => {},
      }),
    );
    await assert.rejects(
      () =>
        verifySolanaKeeperDeployment({
          keeperUrl: "https://staging-api.hyperbet.win",
          expectations: EXPECTATIONS,
          attempts: 1,
          delayMs: 0,
          fetchImpl: responseByPath({
            "/ready": json(readyPayload(), {
              headers: { "content-length": String(3 * 1024 * 1024) },
            }),
          }),
          sleep: async () => {},
        }),
      /content length is invalid/,
    );
  });
});
