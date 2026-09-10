import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSolanaDeploymentEvidence,
  resolveDeploymentEvidenceWorkflow,
  writeSolanaDeploymentEvidence,
} from "./solana-deployment-evidence.mjs";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RETIRED_PATHS = Object.freeze([
  "/api/perps/markets",
  "/api/models/markets",
  "/api/proxy/evm/rpc",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function base58ByteLength(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) {
    return -1;
  }
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return -1;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }
  return (
    bytes.length +
    leadingZeroes -
    (bytes.length === 1 && bytes[0] === 0 ? 1 : 0)
  );
}

function validateOrigin(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2_048 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error("HYPERBET_KEEPER_URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("HYPERBET_KEEPER_URL is invalid");
  }
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
    throw new Error("HYPERBET_KEEPER_URL is invalid");
  }
  return parsed.origin;
}

function validateExpectations(input) {
  if (
    !isRecord(input) ||
    !COMMIT_SHA.test(input.commitSha ?? "") ||
    (input.target !== "staging" && input.target !== "production") ||
    (input.cluster !== "devnet" && input.cluster !== "mainnet-beta") ||
    base58ByteLength(input.fightOracleProgramId) !== 32 ||
    base58ByteLength(input.duelMarketProgramId) !== 32 ||
    input.fightOracleProgramId === input.duelMarketProgramId
  ) {
    throw new Error("keeper deployment expectations are invalid");
  }
  const expectedCluster =
    input.target === "production" ? "mainnet-beta" : "devnet";
  if (input.cluster !== expectedCluster) {
    throw new Error("keeper deployment expectations are inconsistent");
  }
  return Object.freeze({
    commitSha: input.commitSha,
    target: input.target,
    cluster: input.cluster,
    fightOracleProgramId: input.fightOracleProgramId,
    duelMarketProgramId: input.duelMarketProgramId,
  });
}

function expectedRuntime(expectations, role) {
  return {
    schemaVersion: 1,
    role,
    cluster: expectations.cluster,
    fightOracleProgramId: expectations.fightOracleProgramId,
    duelMarketProgramId: expectations.duelMarketProgramId,
  };
}

function assertRelease(value, expectations, label) {
  if (
    !hasExactKeys(value, ["commitSha", "source"]) ||
    value.commitSha !== expectations.commitSha ||
    value.source !== "manifest"
  ) {
    throw new Error(`${label} release identity is invalid`);
  }
}

function assertRuntime(value, expectations, role, label) {
  const expected = expectedRuntime(expectations, role);
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "role",
      "cluster",
      "fightOracleProgramId",
      "duelMarketProgramId",
    ]) ||
    Object.entries(expected).some(
      ([key, expectedValue]) => value[key] !== expectedValue,
    )
  ) {
    throw new Error(`${label} runtime identity is invalid`);
  }
}

function assertReady(value, label) {
  if (
    !isRecord(value) ||
    value.ready !== true ||
    !Array.isArray(value.reasons) ||
    value.reasons.length !== 0
  ) {
    throw new Error(`${label} readiness is invalid`);
  }
}

function assertBotHealth(value, expectations, label) {
  if (
    !isRecord(value) ||
    value.chainKey !== "solana" ||
    value.releaseCommitSha !== expectations.commitSha ||
    value.running !== true ||
    !Number.isFinite(value.updatedAtMs) ||
    !Number.isFinite(value.bootedAtMs) ||
    !Number.isFinite(value.lastSuccessfulRpcAtMs) ||
    !Array.isArray(value.recovery) ||
    !Array.isArray(value.markets) ||
    !isRecord(value.operatorMetrics)
  ) {
    throw new Error(`${label} bot health is invalid`);
  }
  assertRuntime(value.runtime, expectations, "duel-bot", `${label} bot`);
}

export function validateKeeperReadyPayload(value, expectationsInput) {
  const expectations = validateExpectations(expectationsInput);
  if (
    !hasExactKeys(value, [
      "ok",
      "service",
      "now",
      "release",
      "runtime",
      "readiness",
      "operatorReadiness",
      "correlationIds",
    ]) ||
    value.ok !== true ||
    value.service !== "hyperbet-solana-backend" ||
    !Number.isFinite(value.now) ||
    !Array.isArray(value.correlationIds) ||
    !isRecord(value.operatorReadiness) ||
    value.operatorReadiness.ready !== true ||
    !Array.isArray(value.operatorReadiness.alerts) ||
    value.operatorReadiness.alerts.length !== 0
  ) {
    throw new Error("keeper ready payload is invalid");
  }
  assertRelease(value.release, expectations, "keeper ready");
  assertRuntime(value.runtime, expectations, "service", "keeper ready");
  assertReady(value.readiness, "keeper service");
  return value;
}

export function validateKeeperStatusPayload(value, expectationsInput) {
  const expectations = validateExpectations(expectationsInput);
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.service !== "hyperbet-solana-backend" ||
    !Number.isFinite(value.now) ||
    !isRecord(value.operatorMetrics) ||
    !isRecord(value.operatorMetrics.federated) ||
    value.operatorMetrics.federated.ready !== true ||
    !Array.isArray(value.operatorMetrics.federated.alerts) ||
    value.operatorMetrics.federated.alerts.length !== 0 ||
    !isRecord(value.bot) ||
    value.bot.supervision !== "dedicated-service" ||
    value.bot.running !== true ||
    !isRecord(value.bot.transport) ||
    value.bot.transport.source !== "remote" ||
    !isRecord(value.parsers) ||
    !isRecord(value.parsers.solana) ||
    value.parsers.solana.enabled !== true ||
    value.parsers.solana.lastError !== null ||
    !Number.isFinite(value.parsers.solana.lastSuccessAt) ||
    !isRecord(value.parsers.solana.snapshot) ||
    value.parsers.solana.snapshot.fightOracleProgram !==
      expectations.fightOracleProgramId ||
    value.parsers.solana.snapshot.marketProgram !==
      expectations.duelMarketProgramId
  ) {
    throw new Error("keeper status payload is invalid");
  }
  assertRelease(value.release, expectations, "keeper status");
  assertRuntime(value.runtime, expectations, "service", "keeper status");
  assertReady(value.readiness, "keeper service");
  assertRuntime(
    value.bot.runtime,
    expectations,
    "duel-bot",
    "keeper status bot",
  );
  assertBotHealth(value.bot.health, expectations, "keeper status");
  return value;
}

export function validateKeeperBotHealthPayload(value, expectationsInput) {
  const expectations = validateExpectations(expectationsInput);
  if (
    !hasExactKeys(value, [
      "ok",
      "supervision",
      "runtime",
      "running",
      "readiness",
      "health",
    ]) ||
    value.ok !== true ||
    value.supervision !== "dedicated-service" ||
    value.running !== true
  ) {
    throw new Error("keeper bot-health payload is invalid");
  }
  assertReady(value.readiness, "keeper bot");
  assertRuntime(value.runtime, expectations, "duel-bot", "keeper bot-health");
  assertBotHealth(value.health, expectations, "keeper bot-health");
  return value;
}

function validateProductPayloads(payloads) {
  if (
    !isRecord(payloads.markets) ||
    !isRecord(payloads.markets.duel) ||
    !Array.isArray(payloads.markets.markets) ||
    !Number.isFinite(payloads.markets.updatedAt)
  ) {
    throw new Error("active prediction-market payload is invalid");
  }
  if (
    !isRecord(payloads.duelContext) ||
    payloads.duelContext.type !== "STREAMING_DUEL_CONTEXT" ||
    !Array.isArray(payloads.duelContext.leaderboard) ||
    !Number.isFinite(payloads.duelContext.updatedAt)
  ) {
    throw new Error("streaming duel-context payload is invalid");
  }
  if (
    !isRecord(payloads.leaderboard) ||
    !Array.isArray(payloads.leaderboard.leaderboard) ||
    !isRecord(payloads.leaderboard.cycle) ||
    !Array.isArray(payloads.leaderboard.recentDuels) ||
    !Number.isFinite(payloads.leaderboard.updatedAt)
  ) {
    throw new Error("streaming leaderboard payload is invalid");
  }
}

async function readJsonResponse(response, label) {
  if (
    !response ||
    response.status !== 200 ||
    response.ok !== true ||
    response.redirected === true
  ) {
    throw new Error(`${label} did not return an unredirected 200`);
  }
  const contentType = response.headers?.get("content-type") ?? "";
  if (!/^application\/(?:json|[^;\s]+\+json)(?:;|$)/iu.test(contentType)) {
    throw new Error(`${label} content type is invalid`);
  }
  const contentLength = response.headers?.get("content-length");
  let declaredBytes = null;
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new Error(`${label} content length is invalid`);
    }
    declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 1 ||
      declaredBytes > MAX_JSON_BYTES
    ) {
      throw new Error(`${label} content length is invalid`);
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_JSON_BYTES ||
    (declaredBytes !== null && declaredBytes !== bytes.byteLength)
  ) {
    throw new Error(`${label} body size is invalid`);
  }
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} body is not UTF-8`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} JSON is invalid`);
  }
}

async function fetchJson(input, pathname, label) {
  const response = await input.fetchImpl(`${input.origin}${pathname}`, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  return await readJsonResponse(response, label);
}

async function verifyRetiredEndpoint(input, pathname) {
  const response = await input.fetchImpl(`${input.origin}${pathname}`, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response || response.status !== 404 || response.redirected === true) {
    throw new Error(
      `retired endpoint ${pathname} did not return an unredirected 404`,
    );
  }
  await response.body?.cancel();
}

async function verifyAttempt(input) {
  const ready = await fetchJson(input, "/ready", "keeper readiness");
  validateKeeperReadyPayload(ready, input.expectations);

  const [status, markets, botHealth, duelContext, leaderboard] =
    await Promise.all([
      fetchJson(input, "/status", "keeper status"),
      fetchJson(
        input,
        "/api/arena/prediction-markets/active",
        "active prediction markets",
      ),
      fetchJson(input, "/api/keeper/bot-health", "keeper bot health"),
      fetchJson(input, "/api/streaming/duel-context", "duel context"),
      fetchJson(
        input,
        "/api/streaming/leaderboard/details",
        "streaming leaderboard",
      ),
    ]);
  validateKeeperStatusPayload(status, input.expectations);
  validateKeeperBotHealthPayload(botHealth, input.expectations);
  validateProductPayloads({ markets, duelContext, leaderboard });
  await Promise.all(
    RETIRED_PATHS.map((pathname) => verifyRetiredEndpoint(input, pathname)),
  );
}

export async function verifySolanaKeeperDeployment(input) {
  const expectations = validateExpectations(input.expectations);
  const origin = validateOrigin(input.keeperUrl);
  if (
    !Number.isSafeInteger(input.attempts) ||
    input.attempts < 1 ||
    input.attempts > 20 ||
    !Number.isSafeInteger(input.delayMs) ||
    input.delayMs < 0 ||
    input.delayMs > 15_000 ||
    typeof input.fetchImpl !== "function" ||
    typeof input.sleep !== "function"
  ) {
    throw new Error("keeper deployment verification policy is invalid");
  }
  let lastError = new Error("keeper deployment was not checked");
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      await verifyAttempt({ origin, expectations, fetchImpl: input.fetchImpl });
      return Object.freeze({
        origin,
        releaseSha: expectations.commitSha,
        cluster: expectations.cluster,
        verifiedEndpoints: 9,
      });
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("keeper deployment verification failed");
    }
    if (attempt < input.attempts) await input.sleep(input.delayMs);
  }
  throw new Error(
    `keeper deployment verification failed after ${input.attempts} attempts: ${lastError.message}`,
  );
}

export function resolveExpectedKeeperReleaseSha(environment) {
  const explicit = environment.EXPECTED_KEEPER_RELEASE_SHA ?? "";
  const workflow = environment.GITHUB_SHA ?? "";
  if (explicit && workflow && explicit !== workflow) {
    throw new Error(
      "EXPECTED_KEEPER_RELEASE_SHA and GITHUB_SHA must identify the same release",
    );
  }
  return explicit || workflow;
}

function sleep(delayMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const cliArguments = process.argv.slice(2);
    if (
      cliArguments.length > 1 ||
      (cliArguments.length === 1 && !cliArguments[0].startsWith("--output="))
    ) {
      throw new Error(
        "Usage: verify-solana-keeper-deployment.mjs [--output=<absolute-path.json>]",
      );
    }
    const outputPath = cliArguments[0]?.slice("--output=".length) ?? null;
    const expectations = {
      commitSha: resolveExpectedKeeperReleaseSha(process.env),
      target: process.env.DEPLOY_TARGET,
      cluster: process.env.DEPLOY_SOLANA_CLUSTER,
      fightOracleProgramId: process.env.DEPLOY_FIGHT_ORACLE_PROGRAM_ID,
      duelMarketProgramId: process.env.DEPLOY_DUEL_MARKET_PROGRAM_ID,
    };
    const result = await verifySolanaKeeperDeployment({
      keeperUrl: process.env.HYPERBET_KEEPER_URL,
      expectations,
      attempts: 20,
      delayMs: 15_000,
      fetchImpl: globalThis.fetch,
      sleep,
    });
    const evidence = outputPath
      ? writeSolanaDeploymentEvidence(
          outputPath,
          buildSolanaDeploymentEvidence({
            surface: "keeper",
            expectations,
            result,
            workflow: resolveDeploymentEvidenceWorkflow(process.env),
            verifiedAt: new Date().toISOString(),
          }),
        )
      : null;
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...result, evidence })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`keeper deployment verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
