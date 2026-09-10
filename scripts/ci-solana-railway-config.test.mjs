import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditRailwayConfig,
  auditSolanaRailwayConfigs,
  EXPECTED_SOLANA_RAILWAY_CONFIGS,
} from "./ci-solana-railway-config.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = fileURLToPath(
  new URL("./ci-solana-railway-config.mjs", import.meta.url),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("Solana Railway configuration policy", () => {
  it("accepts exactly the two committed launch configurations", () => {
    assert.deepEqual(auditSolanaRailwayConfigs(rootDir), {
      ok: true,
      checkedConfigs: 2,
      violations: [],
    });
    for (const [relativePath, config] of Object.entries(
      EXPECTED_SOLANA_RAILWAY_CONFIGS,
    )) {
      assert.deepEqual(auditRailwayConfig(relativePath, config), {
        ok: true,
        violations: [],
      });
    }
  });

  it("rejects every health, restart, replica, build, and start-command drift", () => {
    const relativePath = "packages/hyperbet-solana/keeper/railway.json";
    const mutations = [
      ["$schema", "https://example.invalid/schema.json"],
      ["build.builder", "NIXPACKS"],
      ["build.dockerfilePath", "Other.Dockerfile"],
      ["deploy.startCommand", "bun src/service.ts"],
      ["deploy.healthcheckPath", "/"],
      ["deploy.healthcheckTimeout", 181],
      ["deploy.restartPolicyType", "ALWAYS"],
      ["deploy.restartPolicyMaxRetries", 4],
      ["deploy.numReplicas", 2],
    ];
    for (const [selector, replacement] of mutations) {
      const config = clone(EXPECTED_SOLANA_RAILWAY_CONFIGS[relativePath]);
      const keys = selector.split(".");
      let target = config;
      for (const key of keys.slice(0, -1)) target = target[key];
      target[keys.at(-1)] = replacement;
      const result = auditRailwayConfig(relativePath, config);
      assert.equal(result.ok, false, selector);
      assert.equal(result.violations.length, 1, selector);
    }
  });

  it("rejects missing, unexpected, and unapproved configuration surfaces", () => {
    const relativePath = "packages/hyperbet-solana/railway.json";
    const extra = clone(EXPECTED_SOLANA_RAILWAY_CONFIGS[relativePath]);
    extra.deploy.region = "us-east4-eqdc4a";
    assert.equal(auditRailwayConfig(relativePath, extra).ok, false);

    const missing = clone(EXPECTED_SOLANA_RAILWAY_CONFIGS[relativePath]);
    delete missing.deploy.healthcheckTimeout;
    assert.equal(auditRailwayConfig(relativePath, missing).ok, false);

    assert.deepEqual(auditRailwayConfig("railway.json", {}), {
      ok: false,
      violations: ["railway.json is not an approved SOL Railway config"],
    });
  });

  it("passes as a dependency-free CLI over the current repository", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      checkedConfigs: 2,
      violations: [],
    });
  });
});
