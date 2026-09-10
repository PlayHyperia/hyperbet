import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE58_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ZERO_PUBLIC_KEY = "11111111111111111111111111111111";
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,5}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_EVIDENCE_BYTES = 128 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function base58ByteLength(value) {
  if (typeof value !== "string" || !BASE58_PUBLIC_KEY.test(value)) return -1;
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

function validateRelease(value, surface) {
  if (
    !hasExactKeys(value, ["commitSha", "target", "cluster"]) ||
    !COMMIT_SHA.test(value.commitSha ?? "") ||
    (value.target !== "staging" && value.target !== "production") ||
    (value.cluster !== "devnet" && value.cluster !== "mainnet-beta") ||
    (value.target === "production") !== (value.cluster === "mainnet-beta")
  ) {
    throw new Error(`${surface} deployment evidence release is invalid`);
  }
  return value;
}

function validateWorkflow(value) {
  if (
    !hasExactKeys(value, ["repository", "runId", "runAttempt"]) ||
    !REPOSITORY.test(value.repository ?? "") ||
    !DECIMAL_ID.test(value.runId ?? "") ||
    !RUN_ATTEMPT.test(value.runAttempt ?? "")
  ) {
    throw new Error("deployment evidence workflow identity is invalid");
  }
  return value;
}

function validateRootHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("keeper deployment evidence origin is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error("keeper deployment evidence origin is invalid");
  }
  return value;
}

function validateVerification(surface, value) {
  if (surface === "keeper") {
    if (
      !hasExactKeys(value, [
        "origin",
        "fightOracleProgramId",
        "duelMarketProgramId",
        "verifiedEndpoints",
      ]) ||
      base58ByteLength(value.fightOracleProgramId) !== 32 ||
      base58ByteLength(value.duelMarketProgramId) !== 32 ||
      value.fightOracleProgramId === ZERO_PUBLIC_KEY ||
      value.duelMarketProgramId === ZERO_PUBLIC_KEY ||
      value.fightOracleProgramId === value.duelMarketProgramId ||
      value.verifiedEndpoints !== 9
    ) {
      throw new Error("keeper deployment evidence verification is invalid");
    }
    validateRootHttpsOrigin(value.origin);
    return value;
  }
  if (
    !hasExactKeys(value, [
      "configSha256",
      "buildInfoSha256",
      "bundleManifestSha256",
      "verifiedOrigins",
    ]) ||
    !SHA256.test(value.configSha256 ?? "") ||
    !SHA256.test(value.buildInfoSha256 ?? "") ||
    !SHA256.test(value.bundleManifestSha256 ?? "") ||
    (value.verifiedOrigins !== 1 && value.verifiedOrigins !== 2)
  ) {
    throw new Error("Pages deployment evidence verification is invalid");
  }
  return value;
}

export function parseSolanaDeploymentEvidence(value) {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "evidenceType",
      "classification",
      "verifiedAt",
      "release",
      "workflow",
      "verification",
      "productionActivationAuthorized",
      "payloadSha256",
    ]) ||
    value.schemaVersion !== 1 ||
    value.classification !== "deployment_endpoint_verification_only" ||
    value.productionActivationAuthorized !== false ||
    !canonicalTimestamp(value.verifiedAt)
  ) {
    throw new Error("SOL deployment evidence envelope is invalid");
  }
  const surface =
    value.evidenceType === "solana_keeper_deployment_verification"
      ? "keeper"
      : value.evidenceType === "solana_pages_deployment_verification"
        ? "pages"
        : null;
  if (!surface) throw new Error("SOL deployment evidence type is invalid");
  validateRelease(value.release, surface);
  validateWorkflow(value.workflow);
  validateVerification(surface, value.verification);
  const { payloadSha256, ...payload } = value;
  if (
    !SHA256.test(payloadSha256 ?? "") ||
    sha256(JSON.stringify(payload)) !== payloadSha256
  ) {
    throw new Error("SOL deployment evidence payload digest is invalid");
  }
  return value;
}

export function resolveDeploymentEvidenceWorkflow(environment) {
  return validateWorkflow({
    repository: environment.GITHUB_REPOSITORY,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  });
}

export function buildSolanaDeploymentEvidence(input) {
  if (
    !isRecord(input) ||
    (input.surface !== "keeper" && input.surface !== "pages")
  ) {
    throw new Error("SOL deployment evidence input is invalid");
  }
  const release = validateRelease(
    {
      commitSha: input.expectations?.commitSha,
      target: input.expectations?.target,
      cluster: input.expectations?.cluster,
    },
    input.surface,
  );
  const workflow = validateWorkflow(input.workflow);
  let verification;
  if (input.surface === "keeper") {
    if (
      input.result?.releaseSha !== release.commitSha ||
      input.result?.cluster !== release.cluster
    ) {
      throw new Error("keeper deployment evidence result is inconsistent");
    }
    verification = {
      origin: input.result?.origin,
      fightOracleProgramId: input.expectations?.fightOracleProgramId,
      duelMarketProgramId: input.expectations?.duelMarketProgramId,
      verifiedEndpoints: input.result?.verifiedEndpoints,
    };
  } else {
    verification = {
      configSha256: input.expectations?.configSha256,
      buildInfoSha256: input.result?.buildInfoSha256,
      bundleManifestSha256: input.result?.bundleManifestSha256,
      verifiedOrigins: input.result?.verifiedOrigins,
    };
  }
  validateVerification(input.surface, verification);
  const payload = {
    schemaVersion: 1,
    evidenceType: `solana_${input.surface}_deployment_verification`,
    classification: "deployment_endpoint_verification_only",
    verifiedAt: input.verifiedAt,
    release,
    workflow,
    verification,
    productionActivationAuthorized: false,
  };
  const evidence = Object.freeze({
    ...payload,
    payloadSha256: sha256(JSON.stringify(payload)),
  });
  return parseSolanaDeploymentEvidence(evidence);
}

function validateOutputPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.length > 4_096 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value) ||
    path.extname(value) !== ".json"
  ) {
    throw new Error("deployment evidence output path is invalid");
  }
  const parent = path.dirname(value);
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("deployment evidence output parent is invalid");
  }
  return value;
}

export function writeSolanaDeploymentEvidence(outputPath, evidenceInput) {
  const resolvedOutput = validateOutputPath(outputPath);
  const evidence = parseSolanaDeploymentEvidence(evidenceInput);
  const raw = `${JSON.stringify(evidence, null, 2)}\n`;
  const bytes = Buffer.byteLength(raw);
  if (bytes < 1 || bytes > MAX_EVIDENCE_BYTES) {
    throw new Error("deployment evidence byte length is invalid");
  }
  const parent = path.dirname(resolvedOutput);
  const temporaryPath = path.join(
    parent,
    `.${path.basename(resolvedOutput)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  let published = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, raw, undefined, "utf8");
    fsyncSync(descriptor);
    const stagedStat = fstatSync(descriptor);
    if (!stagedStat.isFile() || (stagedStat.mode & 0o777) !== 0o600) {
      throw new Error("deployment evidence staging file is invalid");
    }
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, resolvedOutput);
    published = true;
    const parentDescriptor = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch {
    throw new Error("deployment evidence could not be published");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The staged file can be absent only after external cleanup or a failed create.
    }
  }
  if (!published) throw new Error("deployment evidence was not published");
  const finalStat = lstatSync(resolvedOutput);
  if (
    !finalStat.isFile() ||
    finalStat.isSymbolicLink() ||
    (finalStat.mode & 0o777) !== 0o600 ||
    finalStat.size !== bytes
  ) {
    throw new Error("published deployment evidence is invalid");
  }
  return Object.freeze({ sha256: sha256(raw), bytes });
}
