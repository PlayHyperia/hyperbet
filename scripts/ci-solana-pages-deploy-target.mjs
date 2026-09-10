import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSolanaPagesBuildIdentity } from "./solana-pages-build-identity.mjs";

const PRODUCTION_DEFAULTS = Object.freeze({
  accountId: "50ad2052bbc6ca528d6993a689b419a4",
  projectName: "hyperia-betting",
  expectedUrl: "https://hyperbet.win",
  apiUrl: "https://api.hyperbet.win",
  wsUrl: "wss://api.hyperbet.win/ws",
});
const OUTPUT_KEYS = Object.freeze([
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
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const PAGES_PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function readInput(environment, key, fallback = "") {
  const raw = environment[key] ?? fallback;
  if (
    typeof raw !== "string" ||
    raw.length > 4_096 ||
    raw !== raw.trim() ||
    CONTROL_CHARACTER.test(raw)
  ) {
    throw new Error(`${key} is invalid`);
  }
  return raw;
}

function requireInput(environment, key, fallback = "") {
  const value = readInput(environment, key, fallback);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function validateAccountId(key, value) {
  if (!CLOUDFLARE_ACCOUNT_ID.test(value)) {
    throw new Error(`${key} is invalid`);
  }
  return value.toLowerCase();
}

function validateProjectName(key, value) {
  if (!PAGES_PROJECT_NAME.test(value)) throw new Error(`${key} is invalid`);
  return value;
}

function parseUrl(key, value) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${key} is invalid`);
  }
}

function validateRootHttpsUrl(key, value) {
  const parsed = parseUrl(key, value);
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} is invalid`);
  }
  return parsed.origin;
}

function validateWebSocketUrl(key, value) {
  const parsed = parseUrl(key, value);
  if (
    parsed.protocol !== "wss:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    !parsed.pathname.startsWith("/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} is invalid`);
  }
  return parsed.toString();
}

function validateStreamSources(key, value) {
  const entries = value.split(",").map((entry) => entry.trim());
  if (
    entries.length < 1 ||
    entries.length > 3 ||
    entries.some((entry) => !entry)
  ) {
    throw new Error(`${key} is invalid`);
  }
  const identities = new Set();
  const normalized = entries.map((entry) => {
    const parsed = parseUrl(key, entry);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      !/\.m3u8$/i.test(parsed.pathname) ||
      parsed.hash
    ) {
      throw new Error(`${key} is invalid`);
    }
    const identity = `${parsed.origin}${parsed.pathname}`;
    if (identities.has(identity)) throw new Error(`${key} is invalid`);
    identities.add(identity);
    return parsed.toString();
  });
  return normalized.join(",");
}

export function resolvePagesDeploymentTarget(environment) {
  const requestedEnvironment = requireInput(
    environment,
    "REQUESTED_ENVIRONMENT",
  );
  if (
    requestedEnvironment !== "staging" &&
    requestedEnvironment !== "preview" &&
    requestedEnvironment !== "production"
  ) {
    throw new Error("REQUESTED_ENVIRONMENT is invalid");
  }
  const accountId = validateAccountId(
    "HYPERBET_CLOUDFLARE_ACCOUNT_ID",
    readInput(environment, "HYPERBET_CLOUDFLARE_ACCOUNT_ID") ||
      PRODUCTION_DEFAULTS.accountId,
  );

  let projectName;
  let expectedUrl;
  let apiUrl;
  let wsUrl;
  let streamSources;
  let cluster;
  let transactionsEnabled;
  if (requestedEnvironment === "production") {
    projectName = validateProjectName(
      "HYPERBET_SOLANA_PAGES_PROJECT_NAME",
      readInput(environment, "HYPERBET_SOLANA_PAGES_PROJECT_NAME") ||
        PRODUCTION_DEFAULTS.projectName,
    );
    expectedUrl = validateRootHttpsUrl(
      "HYPERBET_SOLANA_PAGES_PRODUCTION_URL",
      readInput(environment, "HYPERBET_SOLANA_PAGES_PRODUCTION_URL") ||
        PRODUCTION_DEFAULTS.expectedUrl,
    );
    apiUrl = validateRootHttpsUrl(
      "HYPERBET_SOLANA_KEEPER_URL",
      readInput(environment, "HYPERBET_SOLANA_KEEPER_URL") ||
        PRODUCTION_DEFAULTS.apiUrl,
    );
    wsUrl = validateWebSocketUrl(
      "HYPERBET_SOLANA_KEEPER_WS_URL",
      readInput(environment, "HYPERBET_SOLANA_KEEPER_WS_URL") ||
        PRODUCTION_DEFAULTS.wsUrl,
    );
    streamSources = validateStreamSources(
      "HYPERBET_SOLANA_STREAM_SOURCES",
      requireInput(environment, "HYPERBET_SOLANA_STREAM_SOURCES"),
    );
    cluster = "mainnet-beta";
    transactionsEnabled = "false";
  } else {
    projectName = validateProjectName(
      "HYPERBET_SOLANA_PAGES_STAGING_PROJECT_NAME",
      requireInput(environment, "HYPERBET_SOLANA_PAGES_STAGING_PROJECT_NAME"),
    );
    expectedUrl =
      requestedEnvironment === "preview"
        ? ""
        : validateRootHttpsUrl(
            "HYPERBET_SOLANA_PAGES_STAGING_URL",
            requireInput(environment, "HYPERBET_SOLANA_PAGES_STAGING_URL"),
          );
    apiUrl = validateRootHttpsUrl(
      "HYPERBET_SOLANA_KEEPER_STAGING_URL",
      requireInput(environment, "HYPERBET_SOLANA_KEEPER_STAGING_URL"),
    );
    wsUrl = validateWebSocketUrl(
      "HYPERBET_SOLANA_KEEPER_STAGING_WS_URL",
      requireInput(environment, "HYPERBET_SOLANA_KEEPER_STAGING_WS_URL"),
    );
    streamSources = validateStreamSources(
      "HYPERBET_SOLANA_STAGING_STREAM_SOURCES",
      requireInput(environment, "HYPERBET_SOLANA_STAGING_STREAM_SOURCES"),
    );
    cluster = "devnet";
    transactionsEnabled = requestedEnvironment === "staging" ? "true" : "false";
  }

  const target = {
    DEPLOY_TARGET: requestedEnvironment,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    PAGES_PROJECT_NAME: projectName,
    PAGES_EXPECTED_URL: expectedUrl,
    HYPERBET_API_URL: apiUrl,
    HYPERBET_WS_URL: wsUrl,
    DEPLOY_SOLANA_CLUSTER: cluster,
    VITE_STREAM_SOURCES: streamSources,
    VITE_TRANSACTIONS_ENABLED: transactionsEnabled,
  };
  const buildIdentity = resolveSolanaPagesBuildIdentity({
    ...target,
    VITE_USE_GAME_RPC_PROXY: "true",
  });
  return Object.freeze({
    ...target,
    PAGES_BUILD_IDENTITY_SHA256: buildIdentity.configSha256,
  });
}

export function serializePagesDeploymentTarget(target) {
  if (Object.keys(target).length !== OUTPUT_KEYS.length) {
    throw new Error("Pages deployment target output has unexpected keys");
  }
  const lines = [];
  for (const key of OUTPUT_KEYS) {
    const value = target[key];
    const allowedEmpty =
      key === "PAGES_EXPECTED_URL" && target.DEPLOY_TARGET === "preview";
    if (
      typeof value !== "string" ||
      (!value && !allowedEmpty) ||
      value !== value.trim() ||
      CONTROL_CHARACTER.test(value)
    ) {
      throw new Error(`${key} is invalid`);
    }
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    process.stdout.write(
      serializePagesDeploymentTarget(resolvePagesDeploymentTarget(process.env)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid input";
    process.stderr.write(
      `Pages deployment target resolution failed: ${message}\n`,
    );
    process.exitCode = 1;
  }
}
