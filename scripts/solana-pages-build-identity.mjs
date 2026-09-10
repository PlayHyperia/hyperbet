import { createHash } from "node:crypto";

export const SOLANA_PAGES_BUILD_IDENTITY_SCHEMA_VERSION = 1;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const PAGES_PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function readValue(environment, key, { allowEmpty = false } = {}) {
  const value = environment[key];
  if (
    typeof value !== "string" ||
    value.length > 4_096 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value) ||
    (!allowEmpty && !value)
  ) {
    throw new Error(`${key} is invalid`);
  }
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
    parsed.port ||
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
    parsed.port ||
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
  return entries.map((entry) => {
    const parsed = parseUrl(key, entry);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
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
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function resolveSolanaPagesBuildIdentity(environment) {
  const target = readValue(environment, "DEPLOY_TARGET");
  if (target !== "production" && target !== "staging" && target !== "preview") {
    throw new Error("DEPLOY_TARGET is invalid");
  }
  const projectName = readValue(environment, "PAGES_PROJECT_NAME");
  if (!PAGES_PROJECT_NAME.test(projectName)) {
    throw new Error("PAGES_PROJECT_NAME is invalid");
  }
  const rawExpectedUrl = readValue(environment, "PAGES_EXPECTED_URL", {
    allowEmpty: target === "preview",
  });
  if ((target === "preview") !== (rawExpectedUrl === "")) {
    throw new Error("PAGES_EXPECTED_URL is inconsistent with DEPLOY_TARGET");
  }
  const expectedUrl = rawExpectedUrl
    ? validateRootHttpsUrl("PAGES_EXPECTED_URL", rawExpectedUrl)
    : "";
  const apiUrl = validateRootHttpsUrl(
    "HYPERBET_API_URL",
    readValue(environment, "HYPERBET_API_URL"),
  );
  const wsUrl = validateWebSocketUrl(
    "HYPERBET_WS_URL",
    readValue(environment, "HYPERBET_WS_URL"),
  );
  const cluster = readValue(environment, "DEPLOY_SOLANA_CLUSTER");
  const transactionsValue = readValue(environment, "VITE_TRANSACTIONS_ENABLED");
  const proxyValue = readValue(environment, "VITE_USE_GAME_RPC_PROXY");
  if (proxyValue !== "true") {
    throw new Error("VITE_USE_GAME_RPC_PROXY must be true");
  }

  const expectedCluster = target === "production" ? "mainnet-beta" : "devnet";
  const expectedTransactions = target === "staging" ? "true" : "false";
  if (
    cluster !== expectedCluster ||
    transactionsValue !== expectedTransactions
  ) {
    throw new Error("Pages target authority is inconsistent");
  }
  const streamSources = validateStreamSources(
    "VITE_STREAM_SOURCES",
    readValue(environment, "VITE_STREAM_SOURCES"),
  );

  const canonicalConfiguration = Object.freeze({
    schemaVersion: SOLANA_PAGES_BUILD_IDENTITY_SCHEMA_VERSION,
    target,
    projectName,
    expectedUrl,
    apiUrl,
    wsUrl,
    cluster,
    streamSources,
    transactionsEnabled: transactionsValue === "true",
    useGameRpcProxy: true,
  });
  return Object.freeze({
    schemaVersion: SOLANA_PAGES_BUILD_IDENTITY_SCHEMA_VERSION,
    target,
    cluster,
    transactionsEnabled: canonicalConfiguration.transactionsEnabled,
    useGameRpcProxy: true,
    configSha256: sha256(JSON.stringify(canonicalConfiguration)),
  });
}
