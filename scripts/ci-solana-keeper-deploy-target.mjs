import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const PRODUCTION_DEFAULTS = Object.freeze({
  keeperUrl: "https://api.hyperbet.win",
  projectId: "e5f5ba11-0380-4d71-aa0b-343d89a58c0d",
  environmentId: "194f3565-ba2f-4c98-87d2-85dfc3a5110b",
  keeperServiceId: "330ea18e-b215-4cf9-9fe2-4bb09fc2ec63",
});

const OUTPUT_KEYS = Object.freeze([
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
]);

const RAILWAY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58ByteLength(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) {
    return -1;
  }
  let bytes = [0];
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

function readApprovedManifest() {
  try {
    return JSON.parse(
      readFileSync(
        new URL(
          "../packages/hyperbet-solana/deployments/solana-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  } catch {
    throw new Error("approved Solana deployment manifest is invalid");
  }
}

function approvedPrograms(cluster, environment, manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !==
      "realValueProgramVerification,solana"
  ) {
    throw new Error("approved Solana deployment manifest is invalid");
  }
  const deployment = manifest?.solana?.[cluster];
  if (
    !deployment ||
    typeof deployment !== "object" ||
    Array.isArray(deployment) ||
    Object.keys(deployment).sort().join(",") !==
      "cluster,duelMarketProgramId,fightOracleProgramId" ||
    deployment.cluster !== cluster ||
    base58ByteLength(deployment.fightOracleProgramId) !== 32 ||
    base58ByteLength(deployment.duelMarketProgramId) !== 32 ||
    deployment.fightOracleProgramId === deployment.duelMarketProgramId
  ) {
    throw new Error("approved Solana deployment manifest is invalid");
  }
  if (cluster === "mainnet-beta") {
    const verification = manifest.realValueProgramVerification;
    if (
      !verification ||
      typeof verification !== "object" ||
      Array.isArray(verification) ||
      Object.keys(verification).sort().join(",") !== "evidenceSha256,status" ||
      verification.status !== "verified" ||
      !SHA256.test(verification.evidenceSha256 ?? "")
    ) {
      throw new Error(
        "Solana mainnet program identities are not independently verified for real-value launch",
      );
    }
    const protectedEvidenceSha256 = requireInput(
      environment,
      "HYPERBET_SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256",
    );
    if (protectedEvidenceSha256 !== verification.evidenceSha256) {
      throw new Error(
        "HYPERBET_SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 does not match the approved deployment manifest",
      );
    }
  }
  return deployment;
}

function readInput(environment, key, fallback = "") {
  const raw = environment[key] ?? fallback;
  if (typeof raw !== "string") {
    throw new Error(`${key} is invalid`);
  }
  if (raw.length > 2_048 || raw !== raw.trim() || CONTROL_CHARACTER.test(raw)) {
    throw new Error(`${key} is invalid`);
  }
  return raw;
}

function requireInput(environment, key, fallback = "") {
  const value = readInput(environment, key, fallback);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function validateRailwayId(key, value) {
  if (!RAILWAY_ID.test(value)) throw new Error(`${key} is invalid`);
  return value.toLowerCase();
}

function validateKeeperUrl(key, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(`${key} is invalid`);
  }
  return parsed.origin;
}

export function resolveKeeperDeploymentTarget(
  environment,
  manifest = readApprovedManifest(),
) {
  const requestedEnvironment = requireInput(
    environment,
    "REQUESTED_ENVIRONMENT",
  );
  if (
    requestedEnvironment !== "staging" &&
    requestedEnvironment !== "production"
  ) {
    throw new Error("REQUESTED_ENVIRONMENT is invalid");
  }

  const productionProjectId = readInput(
    environment,
    "HYPERBET_SOLANA_RAILWAY_PROJECT_ID",
  );
  let keeperUrl;
  let projectId;
  let environmentId;
  let keeperServiceId;
  let duelBotServiceId;
  let cluster;
  let rpcUrl;

  if (requestedEnvironment === "staging") {
    keeperUrl = validateKeeperUrl(
      "HYPERBET_SOLANA_KEEPER_STAGING_URL",
      requireInput(environment, "HYPERBET_SOLANA_KEEPER_STAGING_URL"),
    );
    const stagingProjectId = readInput(
      environment,
      "HYPERBET_SOLANA_RAILWAY_STAGING_PROJECT_ID",
    );
    projectId = validateRailwayId(
      stagingProjectId
        ? "HYPERBET_SOLANA_RAILWAY_STAGING_PROJECT_ID"
        : "HYPERBET_SOLANA_RAILWAY_PROJECT_ID",
      stagingProjectId ||
        requireInput(environment, "HYPERBET_SOLANA_RAILWAY_PROJECT_ID"),
    );
    environmentId = validateRailwayId(
      "HYPERBET_SOLANA_RAILWAY_STAGING_ENVIRONMENT_ID",
      requireInput(
        environment,
        "HYPERBET_SOLANA_RAILWAY_STAGING_ENVIRONMENT_ID",
      ),
    );
    keeperServiceId = validateRailwayId(
      "HYPERBET_SOLANA_RAILWAY_STAGING_KEEPER_SERVICE_ID",
      requireInput(
        environment,
        "HYPERBET_SOLANA_RAILWAY_STAGING_KEEPER_SERVICE_ID",
      ),
    );
    duelBotServiceId = validateRailwayId(
      "HYPERBET_SOLANA_RAILWAY_STAGING_DUEL_BOT_SERVICE_ID",
      requireInput(
        environment,
        "HYPERBET_SOLANA_RAILWAY_STAGING_DUEL_BOT_SERVICE_ID",
      ),
    );
    cluster = "devnet";
    rpcUrl = "https://api.devnet.solana.com";
  } else {
    keeperUrl = validateKeeperUrl(
      "HYPERBET_SOLANA_KEEPER_URL",
      readInput(
        environment,
        "HYPERBET_SOLANA_KEEPER_URL",
        PRODUCTION_DEFAULTS.keeperUrl,
      ) || PRODUCTION_DEFAULTS.keeperUrl,
    );
    projectId = validateRailwayId(
      "HYPERBET_SOLANA_RAILWAY_PROJECT_ID",
      productionProjectId || PRODUCTION_DEFAULTS.projectId,
    );
    environmentId = validateRailwayId(
      "HYPERBET_SOLANA_RAILWAY_PRODUCTION_ENVIRONMENT_ID",
      readInput(
        environment,
        "HYPERBET_SOLANA_RAILWAY_PRODUCTION_ENVIRONMENT_ID",
      ) || PRODUCTION_DEFAULTS.environmentId,
    );
    keeperServiceId = validateRailwayId(
      "HYPERBET_SOLANA_RAILWAY_KEEPER_SERVICE_ID",
      readInput(environment, "HYPERBET_SOLANA_RAILWAY_KEEPER_SERVICE_ID") ||
        PRODUCTION_DEFAULTS.keeperServiceId,
    );
    duelBotServiceId = validateRailwayId(
      "HYPERBET_SOLANA_RAILWAY_DUEL_BOT_SERVICE_ID",
      requireInput(environment, "HYPERBET_SOLANA_RAILWAY_DUEL_BOT_SERVICE_ID"),
    );
    cluster = "mainnet-beta";
    rpcUrl = "https://api.mainnet-beta.solana.com";
  }

  if (keeperServiceId === duelBotServiceId) {
    throw new Error("keeper and duel-bot Railway services must be distinct");
  }
  const programs = approvedPrograms(cluster, environment, manifest);

  return Object.freeze({
    DEPLOY_TARGET: requestedEnvironment,
    HYPERBET_KEEPER_URL: keeperUrl,
    RAILWAY_PROJECT_ID: projectId,
    RAILWAY_ENVIRONMENT_ID: environmentId,
    RAILWAY_KEEPER_SERVICE_ID: keeperServiceId,
    RAILWAY_DUEL_BOT_SERVICE_ID: duelBotServiceId,
    DEPLOY_SOLANA_CLUSTER: cluster,
    DEPLOY_SOLANA_RPC_URL: rpcUrl,
    DEPLOY_FIGHT_ORACLE_PROGRAM_ID: programs.fightOracleProgramId,
    DEPLOY_DUEL_MARKET_PROGRAM_ID: programs.duelMarketProgramId,
  });
}

export function serializeKeeperDeploymentTarget(target) {
  const lines = [];
  for (const key of OUTPUT_KEYS) {
    const value = target[key];
    if (
      typeof value !== "string" ||
      !value ||
      value !== value.trim() ||
      CONTROL_CHARACTER.test(value)
    ) {
      throw new Error(`${key} is invalid`);
    }
    lines.push(`${key}=${value}`);
  }
  if (Object.keys(target).length !== OUTPUT_KEYS.length) {
    throw new Error("deployment target output has unexpected keys");
  }
  return `${lines.join("\n")}\n`;
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    process.stdout.write(
      serializeKeeperDeploymentTarget(
        resolveKeeperDeploymentTarget(process.env),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid input";
    process.stderr.write(
      `keeper deployment target resolution failed: ${message}\n`,
    );
    process.exitCode = 1;
  }
}
