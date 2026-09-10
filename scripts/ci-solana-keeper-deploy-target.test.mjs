import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveKeeperDeploymentTarget,
  serializeKeeperDeploymentTarget,
} from "./ci-solana-keeper-deploy-target.mjs";

const scriptPath = fileURLToPath(
  new URL("./ci-solana-keeper-deploy-target.mjs", import.meta.url),
);
const FIGHT_ORACLE_PROGRAM_ID = "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu";
const DUEL_MARKET_PROGRAM_ID = "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG";

const productionInput = {
  REQUESTED_ENVIRONMENT: "production",
  HYPERBET_SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256: "e".repeat(64),
  HYPERBET_SOLANA_KEEPER_URL: "",
  HYPERBET_SOLANA_RAILWAY_PROJECT_ID: "",
  HYPERBET_SOLANA_RAILWAY_PRODUCTION_ENVIRONMENT_ID: "",
  HYPERBET_SOLANA_RAILWAY_KEEPER_SERVICE_ID: "",
  HYPERBET_SOLANA_RAILWAY_DUEL_BOT_SERVICE_ID:
    "d58cb89e-6c56-4c14-ae96-369253eac45f",
};

const verifiedManifest = {
  realValueProgramVerification: {
    status: "verified",
    evidenceSha256:
      productionInput.HYPERBET_SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256,
  },
  solana: {
    "mainnet-beta": {
      cluster: "mainnet-beta",
      fightOracleProgramId: FIGHT_ORACLE_PROGRAM_ID,
      duelMarketProgramId: DUEL_MARKET_PROGRAM_ID,
    },
  },
};

const stagingInput = {
  REQUESTED_ENVIRONMENT: "staging",
  HYPERBET_SOLANA_KEEPER_STAGING_URL: "https://staging-api.hyperbet.win",
  HYPERBET_SOLANA_RAILWAY_PROJECT_ID: "ae2ad883-bc25-417a-9037-1a1ac637910c",
  HYPERBET_SOLANA_RAILWAY_STAGING_PROJECT_ID: "",
  HYPERBET_SOLANA_RAILWAY_STAGING_ENVIRONMENT_ID:
    "c3c4565f-22c5-4986-9964-f3eb56dab722",
  HYPERBET_SOLANA_RAILWAY_STAGING_KEEPER_SERVICE_ID:
    "587237e9-1012-4051-9bd1-95025ca90805",
  HYPERBET_SOLANA_RAILWAY_STAGING_DUEL_BOT_SERVICE_ID:
    "dd9e25f7-9f70-4488-9420-86cf51d0c345",
};

describe("Solana keeper deployment target resolver", () => {
  it("resolves the production defaults without accepting a default duel-bot service", () => {
    const target = resolveKeeperDeploymentTarget(
      productionInput,
      verifiedManifest,
    );
    assert.deepEqual(target, {
      DEPLOY_TARGET: "production",
      HYPERBET_KEEPER_URL: "https://api.hyperbet.win",
      RAILWAY_PROJECT_ID: "e5f5ba11-0380-4d71-aa0b-343d89a58c0d",
      RAILWAY_ENVIRONMENT_ID: "194f3565-ba2f-4c98-87d2-85dfc3a5110b",
      RAILWAY_KEEPER_SERVICE_ID: "330ea18e-b215-4cf9-9fe2-4bb09fc2ec63",
      RAILWAY_DUEL_BOT_SERVICE_ID: "d58cb89e-6c56-4c14-ae96-369253eac45f",
      DEPLOY_SOLANA_CLUSTER: "mainnet-beta",
      DEPLOY_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      DEPLOY_FIGHT_ORACLE_PROGRAM_ID: FIGHT_ORACLE_PROGRAM_ID,
      DEPLOY_DUEL_MARKET_PROGRAM_ID: DUEL_MARKET_PROGRAM_ID,
    });
  });

  it("fails closed against the current unverified canonical mainnet registry", () => {
    assert.throws(
      () => resolveKeeperDeploymentTarget(productionInput),
      /mainnet program identities are not independently verified for real-value launch/,
    );

    const cli = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, ...productionInput },
    });
    assert.notEqual(cli.status, 0);
    assert.equal(cli.stdout, "");
    assert.match(cli.stderr, /deployment target resolution failed/);
    assert.equal(cli.stderr.includes(FIGHT_ORACLE_PROGRAM_ID), false);
    assert.equal(cli.stderr.includes(DUEL_MARKET_PROGRAM_ID), false);
  });

  it("requires protected evidence to match a verified manifest exactly", () => {
    for (const protectedEvidenceSha256 of ["", "f".repeat(64)]) {
      assert.throws(
        () =>
          resolveKeeperDeploymentTarget(
            {
              ...productionInput,
              HYPERBET_SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256:
                protectedEvidenceSha256,
            },
            verifiedManifest,
          ),
        protectedEvidenceSha256
          ? /does not match the approved deployment manifest/
          : /HYPERBET_SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 is required/,
      );
    }
  });

  it("resolves staging with the explicit production-project fallback", () => {
    assert.deepEqual(resolveKeeperDeploymentTarget(stagingInput), {
      DEPLOY_TARGET: "staging",
      HYPERBET_KEEPER_URL: "https://staging-api.hyperbet.win",
      RAILWAY_PROJECT_ID: "ae2ad883-bc25-417a-9037-1a1ac637910c",
      RAILWAY_ENVIRONMENT_ID: "c3c4565f-22c5-4986-9964-f3eb56dab722",
      RAILWAY_KEEPER_SERVICE_ID: "587237e9-1012-4051-9bd1-95025ca90805",
      RAILWAY_DUEL_BOT_SERVICE_ID: "dd9e25f7-9f70-4488-9420-86cf51d0c345",
      DEPLOY_SOLANA_CLUSTER: "devnet",
      DEPLOY_SOLANA_RPC_URL: "https://api.devnet.solana.com",
      DEPLOY_FIGHT_ORACLE_PROGRAM_ID: FIGHT_ORACLE_PROGRAM_ID,
      DEPLOY_DUEL_MARKET_PROGRAM_ID: DUEL_MARKET_PROGRAM_ID,
    });
  });

  it("serializes only the exact validated GitHub environment keys", () => {
    const serialized = serializeKeeperDeploymentTarget(
      resolveKeeperDeploymentTarget(stagingInput),
    );
    const lines = serialized.trimEnd().split("\n");
    assert.equal(lines.length, 10);
    assert.deepEqual(
      lines.map((line) => line.slice(0, line.indexOf("="))),
      [
        "DEPLOY_TARGET",
        "HYPERBET_KEEPER_URL",
        "RAILWAY_PROJECT_ID",
        "RAILWAY_ENVIRONMENT_ID",
        "RAILWAY_KEEPER_SERVICE_ID",
        "RAILWAY_DUEL_BOT_SERVICE_ID",
        "DEPLOY_SOLANA_CLUSTER",
        "DEPLOY_SOLANA_RPC_URL",
        "DEPLOY_FIGHT_ORACLE_PROGRAM_ID",
        "DEPLOY_DUEL_MARKET_PROGRAM_ID",
      ],
    );
    assert.equal(serialized.includes("\r"), false);

    const cli = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, ...stagingInput },
    });
    assert.equal(cli.status, 0);
    assert.equal(cli.stderr, "");
    assert.equal(cli.stdout, serialized);
  });

  it("rejects control characters before any GitHub environment output", () => {
    for (const [key, value] of [
      [
        "HYPERBET_SOLANA_KEEPER_STAGING_URL",
        "https://safe.example\nNODE_OPTIONS=--import=payload",
      ],
      [
        "HYPERBET_SOLANA_RAILWAY_STAGING_PROJECT_ID",
        "ae2ad883-bc25-417a-9037-1a1ac637910c\rPATH=/tmp/override",
      ],
      [
        "HYPERBET_SOLANA_RAILWAY_STAGING_ENVIRONMENT_ID",
        "c3c4565f-22c5-4986-9964-f3eb56dab722\u0000tail",
      ],
    ]) {
      assert.throws(
        () => resolveKeeperDeploymentTarget({ ...stagingInput, [key]: value }),
        new RegExp(`${key} is invalid`),
      );
    }

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...stagingInput,
        HYPERBET_SOLANA_KEEPER_STAGING_URL:
          "https://safe.example\nNODE_OPTIONS=--import=payload",
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /deployment target resolution failed/);
    assert.equal(result.stderr.includes("NODE_OPTIONS"), false);
    assert.equal(result.stderr.includes("payload"), false);
  });

  it("rejects ambiguous URLs and malformed or duplicate Railway identities", () => {
    for (const value of [
      "http://staging-api.hyperbet.win",
      "https://user:pass@staging-api.hyperbet.win",
      "https://staging-api.hyperbet.win/base",
      "https://staging-api.hyperbet.win?token=secret",
      "https://staging-api.hyperbet.win/#fragment",
      " https://staging-api.hyperbet.win",
    ]) {
      assert.throws(() =>
        resolveKeeperDeploymentTarget({
          ...stagingInput,
          HYPERBET_SOLANA_KEEPER_STAGING_URL: value,
        }),
      );
    }
    assert.throws(() =>
      resolveKeeperDeploymentTarget({
        ...stagingInput,
        HYPERBET_SOLANA_RAILWAY_STAGING_PROJECT_ID: "not-a-railway-id",
      }),
    );
    assert.throws(
      () =>
        resolveKeeperDeploymentTarget({
          ...stagingInput,
          HYPERBET_SOLANA_RAILWAY_STAGING_DUEL_BOT_SERVICE_ID:
            stagingInput.HYPERBET_SOLANA_RAILWAY_STAGING_KEEPER_SERVICE_ID,
        }),
      /keeper and duel-bot Railway services must be distinct/,
    );
    assert.throws(() =>
      resolveKeeperDeploymentTarget({
        ...stagingInput,
        REQUESTED_ENVIRONMENT: "preview",
      }),
    );
  });

  it("fails closed when any required environment-specific value is absent", () => {
    for (const key of [
      "HYPERBET_SOLANA_KEEPER_STAGING_URL",
      "HYPERBET_SOLANA_RAILWAY_PROJECT_ID",
      "HYPERBET_SOLANA_RAILWAY_STAGING_ENVIRONMENT_ID",
      "HYPERBET_SOLANA_RAILWAY_STAGING_KEEPER_SERVICE_ID",
      "HYPERBET_SOLANA_RAILWAY_STAGING_DUEL_BOT_SERVICE_ID",
    ]) {
      assert.throws(
        () => resolveKeeperDeploymentTarget({ ...stagingInput, [key]: "" }),
        /is required/,
      );
    }
    assert.throws(
      () =>
        resolveKeeperDeploymentTarget(
          {
            ...productionInput,
            HYPERBET_SOLANA_RAILWAY_DUEL_BOT_SERVICE_ID: "",
          },
          verifiedManifest,
        ),
      /HYPERBET_SOLANA_RAILWAY_DUEL_BOT_SERVICE_ID is required/,
    );
  });
});
