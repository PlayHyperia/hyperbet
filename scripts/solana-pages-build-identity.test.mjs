import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveSolanaPagesBuildIdentity,
  SOLANA_PAGES_BUILD_IDENTITY_SCHEMA_VERSION,
} from "./solana-pages-build-identity.mjs";

const productionEnvironment = {
  DEPLOY_TARGET: "production",
  PAGES_PROJECT_NAME: "hyperia-betting",
  PAGES_EXPECTED_URL: "https://hyperbet.win",
  HYPERBET_API_URL: "https://api.hyperbet.win",
  HYPERBET_WS_URL: "wss://api.hyperbet.win/ws",
  DEPLOY_SOLANA_CLUSTER: "mainnet-beta",
  VITE_STREAM_SOURCES:
    "https://stream-a.hyperbet.win/live.m3u8,https://stream-b.hyperbet.win/live.m3u8?version=2",
  VITE_TRANSACTIONS_ENABLED: "false",
  VITE_USE_GAME_RPC_PROXY: "true",
};

describe("Solana Pages build identity", () => {
  it("derives a deterministic public identity without exposing endpoints", () => {
    const first = resolveSolanaPagesBuildIdentity(productionEnvironment);
    const second = resolveSolanaPagesBuildIdentity({
      ...productionEnvironment,
    });
    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first), [
      "schemaVersion",
      "target",
      "cluster",
      "transactionsEnabled",
      "useGameRpcProxy",
      "configSha256",
    ]);
    assert.equal(
      first.schemaVersion,
      SOLANA_PAGES_BUILD_IDENTITY_SCHEMA_VERSION,
    );
    assert.equal(first.target, "production");
    assert.equal(first.cluster, "mainnet-beta");
    assert.equal(first.transactionsEnabled, false);
    assert.equal(first.useGameRpcProxy, true);
    assert.match(first.configSha256, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(first);
    for (const secretBearingValue of [
      productionEnvironment.HYPERBET_API_URL,
      productionEnvironment.HYPERBET_WS_URL,
      productionEnvironment.VITE_STREAM_SOURCES,
    ]) {
      assert.equal(serialized.includes(secretBearingValue), false);
    }
  });

  it("changes the digest for every deployment-affecting field", () => {
    const baseline = resolveSolanaPagesBuildIdentity(productionEnvironment);
    for (const [key, value] of [
      ["PAGES_PROJECT_NAME", "hyperia-betting-next"],
      ["PAGES_EXPECTED_URL", "https://next.hyperbet.win"],
      ["HYPERBET_API_URL", "https://next-api.hyperbet.win"],
      ["HYPERBET_WS_URL", "wss://next-api.hyperbet.win/ws"],
      ["VITE_STREAM_SOURCES", "https://next-stream.hyperbet.win/live.m3u8"],
    ]) {
      const changed = resolveSolanaPagesBuildIdentity({
        ...productionEnvironment,
        [key]: value,
      });
      assert.notEqual(changed.configSha256, baseline.configSha256, key);
    }
  });

  it("accepts the exact staging and preview authority combinations", () => {
    const stagingBase = {
      ...productionEnvironment,
      PAGES_PROJECT_NAME: "hyperia-betting-staging",
      PAGES_EXPECTED_URL: "https://staging-hyperbet.pages.dev",
      HYPERBET_API_URL: "https://staging-api.hyperbet.win",
      HYPERBET_WS_URL: "wss://staging-api.hyperbet.win/ws",
      DEPLOY_SOLANA_CLUSTER: "devnet",
      VITE_STREAM_SOURCES: "https://staging-stream.hyperbet.win/live.m3u8",
      VITE_TRANSACTIONS_ENABLED: "true",
    };
    const staging = resolveSolanaPagesBuildIdentity({
      ...stagingBase,
      DEPLOY_TARGET: "staging",
    });
    assert.equal(staging.target, "staging");
    assert.equal(staging.transactionsEnabled, true);

    const preview = resolveSolanaPagesBuildIdentity({
      ...stagingBase,
      DEPLOY_TARGET: "preview",
      PAGES_EXPECTED_URL: "",
      VITE_TRANSACTIONS_ENABLED: "false",
    });
    assert.equal(preview.target, "preview");
    assert.equal(preview.transactionsEnabled, false);
    assert.notEqual(preview.configSha256, staging.configSha256);
  });

  it("rejects target, cluster, transaction, and proxy contradictions", () => {
    for (const overrides of [
      { DEPLOY_TARGET: "development" },
      { DEPLOY_SOLANA_CLUSTER: "devnet" },
      { VITE_TRANSACTIONS_ENABLED: "true" },
      { VITE_USE_GAME_RPC_PROXY: "false" },
      { PAGES_EXPECTED_URL: "" },
    ]) {
      assert.throws(() =>
        resolveSolanaPagesBuildIdentity({
          ...productionEnvironment,
          ...overrides,
        }),
      );
    }
  });

  it("rejects unsafe endpoints, streams, projects, and control characters", () => {
    for (const [key, value] of [
      ["PAGES_PROJECT_NAME", "unsafe project"],
      ["PAGES_EXPECTED_URL", "http://hyperbet.win"],
      ["HYPERBET_API_URL", "https://user:secret@api.hyperbet.win"],
      ["HYPERBET_WS_URL", "https://api.hyperbet.win/ws"],
      ["VITE_STREAM_SOURCES", "https://stream.hyperbet.win/not-hls"],
      [
        "VITE_STREAM_SOURCES",
        "https://stream.hyperbet.win/live.m3u8,https://stream.hyperbet.win/live.m3u8",
      ],
      ["HYPERBET_API_URL", "https://api.hyperbet.win\nTOKEN=payload"],
    ]) {
      assert.throws(() =>
        resolveSolanaPagesBuildIdentity({
          ...productionEnvironment,
          [key]: value,
        }),
      );
    }
  });

  it("requires every input and ignores unrelated environment values", () => {
    for (const key of Object.keys(productionEnvironment)) {
      assert.throws(() =>
        resolveSolanaPagesBuildIdentity({
          ...productionEnvironment,
          [key]: undefined,
        }),
      );
    }
    assert.deepEqual(
      resolveSolanaPagesBuildIdentity({
        ...productionEnvironment,
        UNRELATED_SECRET: "must-not-affect-build-identity",
      }),
      resolveSolanaPagesBuildIdentity(productionEnvironment),
    );
  });
});
