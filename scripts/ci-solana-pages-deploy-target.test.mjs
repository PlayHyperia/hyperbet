import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolvePagesDeploymentTarget,
  serializePagesDeploymentTarget,
} from "./ci-solana-pages-deploy-target.mjs";
import { resolveSolanaPagesBuildIdentity } from "./solana-pages-build-identity.mjs";

const scriptPath = fileURLToPath(
  new URL("./ci-solana-pages-deploy-target.mjs", import.meta.url),
);
const accountId = "50ad2052bbc6ca528d6993a689b419a4";

function withBuildIdentity(target) {
  return {
    ...target,
    PAGES_BUILD_IDENTITY_SHA256: resolveSolanaPagesBuildIdentity({
      ...target,
      VITE_USE_GAME_RPC_PROXY: "true",
    }).configSha256,
  };
}

const productionInput = {
  REQUESTED_ENVIRONMENT: "production",
  HYPERBET_CLOUDFLARE_ACCOUNT_ID: "",
  HYPERBET_SOLANA_STREAM_SOURCES:
    "https://stream-a.hyperbet.win/live.m3u8,https://stream-b.hyperbet.win/live.m3u8",
  HYPERBET_SOLANA_PAGES_PROJECT_NAME: "",
  HYPERBET_SOLANA_PAGES_PRODUCTION_URL: "",
  HYPERBET_SOLANA_KEEPER_URL: "",
  HYPERBET_SOLANA_KEEPER_WS_URL: "",
};

const stagingInput = {
  REQUESTED_ENVIRONMENT: "staging",
  HYPERBET_CLOUDFLARE_ACCOUNT_ID: accountId,
  HYPERBET_SOLANA_STAGING_STREAM_SOURCES:
    "https://staging-stream.hyperbet.win/live.m3u8",
  HYPERBET_SOLANA_PAGES_STAGING_PROJECT_NAME: "hyperia-betting-staging",
  HYPERBET_SOLANA_PAGES_STAGING_URL: "https://staging-hyperbet.pages.dev",
  HYPERBET_SOLANA_KEEPER_STAGING_URL: "https://staging-api.hyperbet.win",
  HYPERBET_SOLANA_KEEPER_STAGING_WS_URL: "wss://staging-api.hyperbet.win/ws",
};

describe("Solana Pages deployment target resolver", () => {
  it("resolves the existing production defaults and read-only authority", () => {
    assert.deepEqual(
      resolvePagesDeploymentTarget(productionInput),
      withBuildIdentity({
        DEPLOY_TARGET: "production",
        CLOUDFLARE_ACCOUNT_ID: accountId,
        PAGES_PROJECT_NAME: "hyperia-betting",
        PAGES_EXPECTED_URL: "https://hyperbet.win",
        HYPERBET_API_URL: "https://api.hyperbet.win",
        HYPERBET_WS_URL: "wss://api.hyperbet.win/ws",
        DEPLOY_SOLANA_CLUSTER: "mainnet-beta",
        VITE_STREAM_SOURCES:
          "https://stream-a.hyperbet.win/live.m3u8,https://stream-b.hyperbet.win/live.m3u8",
        VITE_TRANSACTIONS_ENABLED: "false",
      }),
    );
  });

  it("resolves staging and preserves its explicitly enabled test authority", () => {
    assert.deepEqual(
      resolvePagesDeploymentTarget(stagingInput),
      withBuildIdentity({
        DEPLOY_TARGET: "staging",
        CLOUDFLARE_ACCOUNT_ID: accountId,
        PAGES_PROJECT_NAME: "hyperia-betting-staging",
        PAGES_EXPECTED_URL: "https://staging-hyperbet.pages.dev",
        HYPERBET_API_URL: "https://staging-api.hyperbet.win",
        HYPERBET_WS_URL: "wss://staging-api.hyperbet.win/ws",
        DEPLOY_SOLANA_CLUSTER: "devnet",
        VITE_STREAM_SOURCES: "https://staging-stream.hyperbet.win/live.m3u8",
        VITE_TRANSACTIONS_ENABLED: "true",
      }),
    );
  });

  it("uses the same staging infrastructure for a read-only preview", () => {
    const target = resolvePagesDeploymentTarget({
      ...stagingInput,
      REQUESTED_ENVIRONMENT: "preview",
    });
    assert.equal(target.DEPLOY_TARGET, "preview");
    assert.equal(target.PAGES_EXPECTED_URL, "");
    assert.equal(target.DEPLOY_SOLANA_CLUSTER, "devnet");
    assert.equal(target.VITE_TRANSACTIONS_ENABLED, "false");
  });

  it("serializes exactly ten validated keys and permits only preview's empty URL", () => {
    const target = resolvePagesDeploymentTarget({
      ...stagingInput,
      REQUESTED_ENVIRONMENT: "preview",
    });
    const serialized = serializePagesDeploymentTarget(target);
    const lines = serialized.trimEnd().split("\n");
    assert.equal(lines.length, 10);
    assert.deepEqual(
      lines.map((line) => line.slice(0, line.indexOf("="))),
      [
        "DEPLOY_TARGET",
        "CLOUDFLARE_ACCOUNT_ID",
        "PAGES_PROJECT_NAME",
        "PAGES_EXPECTED_URL",
        "HYPERBET_API_URL",
        "HYPERBET_WS_URL",
        "DEPLOY_SOLANA_CLUSTER",
        "VITE_STREAM_SOURCES",
        "VITE_TRANSACTIONS_ENABLED",
        "PAGES_BUILD_IDENTITY_SHA256",
      ],
    );
    assert.match(serialized, /^PAGES_EXPECTED_URL=$/m);

    const cli = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, ...stagingInput },
    });
    assert.equal(cli.status, 0);
    assert.equal(cli.stderr, "");
    assert.equal(
      cli.stdout,
      serializePagesDeploymentTarget(
        resolvePagesDeploymentTarget(stagingInput),
      ),
    );
  });

  it("rejects control-character injection without partial CLI output", () => {
    for (const [key, value] of [
      [
        "HYPERBET_SOLANA_PAGES_STAGING_PROJECT_NAME",
        "safe\nNODE_OPTIONS=payload",
      ],
      [
        "HYPERBET_SOLANA_KEEPER_STAGING_URL",
        "https://safe.example\rPATH=/tmp/bin",
      ],
      [
        "HYPERBET_SOLANA_STAGING_STREAM_SOURCES",
        "https://safe.example/live.m3u8\u0000tail",
      ],
    ]) {
      assert.throws(
        () => resolvePagesDeploymentTarget({ ...stagingInput, [key]: value }),
        new RegExp(`${key} is invalid`),
      );
    }
    const cli = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...stagingInput,
        HYPERBET_SOLANA_PAGES_STAGING_PROJECT_NAME:
          "safe\nNODE_OPTIONS=payload",
      },
    });
    assert.notEqual(cli.status, 0);
    assert.equal(cli.stdout, "");
    assert.match(cli.stderr, /Pages deployment target resolution failed/);
    assert.equal(cli.stderr.includes("NODE_OPTIONS"), false);
    assert.equal(cli.stderr.includes("payload"), false);
  });

  it("rejects unsafe identities, endpoints, and HLS source lists", () => {
    for (const [key, value] of [
      ["HYPERBET_CLOUDFLARE_ACCOUNT_ID", "not-an-account"],
      ["HYPERBET_SOLANA_PAGES_STAGING_PROJECT_NAME", "unsafe project"],
      ["HYPERBET_SOLANA_PAGES_STAGING_URL", "http://staging.example"],
      ["HYPERBET_SOLANA_KEEPER_STAGING_URL", "https://user:pass@api.example"],
      ["HYPERBET_SOLANA_KEEPER_STAGING_WS_URL", "https://api.example/ws"],
      [
        "HYPERBET_SOLANA_STAGING_STREAM_SOURCES",
        "https://stream.example/not-hls",
      ],
      [
        "HYPERBET_SOLANA_STAGING_STREAM_SOURCES",
        "https://stream.example/live.m3u8,https://stream.example/live.m3u8",
      ],
      [
        "HYPERBET_SOLANA_STAGING_STREAM_SOURCES",
        "https://a.example/live.m3u8,https://b.example/live.m3u8,https://c.example/live.m3u8,https://d.example/live.m3u8",
      ],
    ]) {
      assert.throws(() =>
        resolvePagesDeploymentTarget({ ...stagingInput, [key]: value }),
      );
    }
    assert.throws(() =>
      resolvePagesDeploymentTarget({
        ...stagingInput,
        REQUESTED_ENVIRONMENT: "development",
      }),
    );
  });

  it("requires every environment-specific staging and stream value", () => {
    for (const key of [
      "HYPERBET_SOLANA_STAGING_STREAM_SOURCES",
      "HYPERBET_SOLANA_PAGES_STAGING_PROJECT_NAME",
      "HYPERBET_SOLANA_PAGES_STAGING_URL",
      "HYPERBET_SOLANA_KEEPER_STAGING_URL",
      "HYPERBET_SOLANA_KEEPER_STAGING_WS_URL",
    ]) {
      assert.throws(
        () => resolvePagesDeploymentTarget({ ...stagingInput, [key]: "" }),
        /is required/,
      );
    }
    assert.throws(
      () =>
        resolvePagesDeploymentTarget({
          ...productionInput,
          HYPERBET_SOLANA_STREAM_SOURCES: "",
        }),
      /HYPERBET_SOLANA_STREAM_SOURCES is required/,
    );
  });
});
