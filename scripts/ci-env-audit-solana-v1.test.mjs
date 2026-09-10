import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const auditScript = fileURLToPath(
  new URL("./ci-env-audit-solana-v1.ts", import.meta.url),
);

function runPagesAudit({ deployment, overrides = {} }) {
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    VITE_GAME_API_URL: "https://keeper.example.com",
    VITE_GAME_WS_URL: "wss://keeper.example.com/ws",
    VITE_SOLANA_CLUSTER:
      deployment === "production" ? "mainnet-beta" : "devnet",
    VITE_USE_GAME_RPC_PROXY: "true",
    VITE_TRANSACTIONS_ENABLED: deployment === "staging" ? "true" : "false",
    VITE_STREAM_SOURCES:
      "https://stream-a.example.com/live.m3u8,https://stream-b.example.com/live.m3u8",
    ...overrides,
  };
  return spawnSync(
    process.env.HYPERBET_TEST_BUN_PATH?.trim() || "bun",
    [auditScript, "--target=pages:solana", `--deployment=${deployment}`],
    {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 1_000_000,
    },
  );
}

test("pages env audit accepts exact production, staging, and read-only preview rails", () => {
  for (const deployment of ["production", "staging", "preview"]) {
    const result = runPagesAudit({ deployment });
    assert.equal(
      result.status,
      0,
      `${deployment}: ${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout, /ok/u);
  }
});

test("pages env audit requires at least one reviewed stream source", () => {
  const result = runPagesAudit({
    deployment: "production",
    overrides: { VITE_STREAM_SOURCES: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing required env VITE_STREAM_SOURCES/u);
});

test("pages env audit rejects cluster drift and transaction-enabled public releases", () => {
  const staging = runPagesAudit({
    deployment: "staging",
    overrides: { VITE_SOLANA_CLUSTER: "mainnet-beta" },
  });
  assert.equal(staging.status, 1);
  assert.match(
    staging.stdout,
    /staging must build with VITE_SOLANA_CLUSTER=devnet/u,
  );

  const preview = runPagesAudit({
    deployment: "preview",
    overrides: { VITE_TRANSACTIONS_ENABLED: "true" },
  });
  assert.equal(preview.status, 1);
  assert.match(preview.stdout, /preview must disable transaction authority/u);

  const production = runPagesAudit({
    deployment: "production",
    overrides: { VITE_TRANSACTIONS_ENABLED: "true" },
  });
  assert.equal(production.status, 1);
  assert.match(
    production.stdout,
    /production must disable transaction authority/u,
  );
});

function runKeeperAudit(deployment) {
  return spawnSync(
    process.env.HYPERBET_TEST_BUN_PATH?.trim() || "bun",
    [auditScript, "--target=keeper:solana", `--deployment=${deployment}`],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        HYPERBET_KEEPER_URL: "https://keeper.example.com",
        RAILWAY_PROJECT_ID: "project-id",
        RAILWAY_ENVIRONMENT_ID: "environment-id",
        RAILWAY_KEEPER_SERVICE_ID: "keeper-service-id",
        RAILWAY_DUEL_BOT_SERVICE_ID: "duel-bot-service-id",
      },
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 1_000_000,
    },
  );
}

test("keeper deployment audit permits staging and stops production before mutation", () => {
  const staging = runKeeperAudit("staging");
  assert.equal(staging.status, 0, `${staging.stdout}${staging.stderr}`);

  const production = runKeeperAudit("production");
  assert.equal(production.status, 1);
  assert.match(
    production.stdout,
    /production deployment is source-gated off until real-value controls/u,
  );
});

test("pages env audit rejects unsafe, duplicate, or excessive stream sources", () => {
  for (const streamSources of [
    "http://stream.example.com/live.m3u8",
    "https://stream.example.com/channel",
    "https://stream.example.com/live.m3u8,https://stream.example.com/live.m3u8",
    "https://stream.example.com/live.m3u8?token=one,https://stream.example.com/live.m3u8?token=two",
    ["a", "b", "c", "d"]
      .map((entry) => `https://${entry}.example.com/live.m3u8`)
      .join(","),
  ]) {
    const result = runPagesAudit({
      deployment: "production",
      overrides: { VITE_STREAM_SOURCES: streamSources },
    });
    assert.equal(result.status, 1, result.stdout);
  }
});

test("pages env audit rejects a non-SOL runtime environment variable", () => {
  const result = runPagesAudit({
    deployment: "staging",
    overrides: { AVAX_RPC_URL: "https://avalanche.example/rpc" },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /AVAX_RPC_URL is outside the SOL-only v1 environment surface/u,
  );
});
