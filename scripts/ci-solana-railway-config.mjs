#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAILWAY_SCHEMA = "https://railway.app/railway.schema.json";

export const EXPECTED_SOLANA_RAILWAY_CONFIGS = Object.freeze({
  "packages/hyperbet-solana/railway.json": Object.freeze({
    $schema: RAILWAY_SCHEMA,
    build: Object.freeze({
      builder: "DOCKERFILE",
      dockerfilePath: "keeper/Dockerfile",
    }),
    deploy: Object.freeze({
      startCommand: "bun --bun src/service.ts",
      healthcheckPath: "/ready",
      healthcheckTimeout: 180,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
      numReplicas: 1,
    }),
  }),
  "packages/hyperbet-solana/keeper/railway.json": Object.freeze({
    $schema: RAILWAY_SCHEMA,
    build: Object.freeze({
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    }),
    deploy: Object.freeze({
      startCommand: "bash start.sh",
      healthcheckPath: "/ready",
      healthcheckTimeout: 180,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
      numReplicas: 1,
    }),
  }),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") ===
      Object.keys(expected).sort().join("\0")
  );
}

function auditExactObject(actual, expected, location, violations) {
  if (!hasExactKeys(actual, expected)) {
    violations.push(`${location} must contain exactly the approved keys`);
    return;
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (isRecord(expectedValue)) {
      auditExactObject(
        actualValue,
        expectedValue,
        `${location}.${key}`,
        violations,
      );
    } else if (actualValue !== expectedValue) {
      violations.push(`${location}.${key} must equal ${String(expectedValue)}`);
    }
  }
}

export function auditRailwayConfig(relativePath, config) {
  const expected = EXPECTED_SOLANA_RAILWAY_CONFIGS[relativePath];
  if (!expected) {
    return {
      ok: false,
      violations: [`${relativePath} is not an approved SOL Railway config`],
    };
  }
  const violations = [];
  auditExactObject(config, expected, relativePath, violations);
  return { ok: violations.length === 0, violations };
}

export function auditSolanaRailwayConfigs(rootDir) {
  const violations = [];
  for (const relativePath of Object.keys(EXPECTED_SOLANA_RAILWAY_CONFIGS)) {
    const absolutePath = path.resolve(rootDir, relativePath);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    } catch (error) {
      violations.push(
        `${relativePath} could not be read as JSON: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      continue;
    }
    violations.push(...auditRailwayConfig(relativePath, config).violations);
  }
  return {
    ok: violations.length === 0,
    checkedConfigs: Object.keys(EXPECTED_SOLANA_RAILWAY_CONFIGS).length,
    violations,
  };
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = auditSolanaRailwayConfigs(rootDir);
  const writer = result.ok ? console.log : console.error;
  writer(JSON.stringify(result, null, result.ok ? 0 : 2));
  if (!result.ok) process.exitCode = 1;
}
