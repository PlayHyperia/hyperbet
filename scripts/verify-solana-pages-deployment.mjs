import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSolanaDeploymentEvidence,
  resolveDeploymentEvidenceWorkflow,
  writeSolanaDeploymentEvidence,
} from "./solana-deployment-evidence.mjs";

import { resolveSolanaPagesBundleManifest } from "./solana-pages-bundle-manifest.mjs";

const MAX_BUILD_INFO_BYTES = 65_536;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const BUILD_INFO_KEYS = Object.freeze([
  "app",
  "builtAt",
  "bundle",
  "commitHash",
  "deploymentIdentity",
  "mode",
  "schemaVersion",
]);
const DEPLOYMENT_IDENTITY_KEYS = Object.freeze([
  "cluster",
  "configSha256",
  "schemaVersion",
  "target",
  "transactionsEnabled",
  "useGameRpcProxy",
]);
const BUNDLE_KEYS = Object.freeze([
  "artifactCount",
  "manifestSha256",
  "schemaVersion",
]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactKeys(value, expectedKeys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === expectedKeys.join("\0")
  );
}

function validateExpectations(expectations) {
  if (
    !expectations ||
    typeof expectations !== "object" ||
    !COMMIT_SHA.test(expectations.commitSha ?? "") ||
    !SHA256.test(expectations.configSha256 ?? "") ||
    (expectations.target !== "production" && expectations.target !== "staging")
  ) {
    throw new Error("Pages build expectations are invalid");
  }
  const expectedCluster =
    expectations.target === "production" ? "mainnet-beta" : "devnet";
  if (expectations.cluster !== expectedCluster) {
    throw new Error("Pages build expectations are inconsistent");
  }
  return Object.freeze({
    commitSha: expectations.commitSha,
    target: expectations.target,
    cluster: expectations.cluster,
    configSha256: expectations.configSha256,
    transactionsEnabled: expectations.target === "staging",
  });
}

export function parseSolanaPagesBuildInfo(raw, expectationsInput) {
  const expectations = validateExpectations(expectationsInput);
  if (
    typeof raw !== "string" ||
    !raw ||
    Buffer.byteLength(raw, "utf8") > MAX_BUILD_INFO_BYTES
  ) {
    throw new Error("Pages build-info body is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Pages build-info JSON is invalid");
  }
  if (!hasExactKeys(parsed, BUILD_INFO_KEYS)) {
    throw new Error("Pages build-info schema is invalid");
  }
  if (
    parsed.schemaVersion !== 2 ||
    parsed.app !== "hyperbet-solana" ||
    parsed.mode !== expectations.cluster ||
    parsed.commitHash !== expectations.commitSha ||
    typeof parsed.builtAt !== "string" ||
    parsed.builtAt.length > 64 ||
    CONTROL_CHARACTER.test(parsed.builtAt)
  ) {
    throw new Error("Pages build-info identity is invalid");
  }
  const builtAtMs = Date.parse(parsed.builtAt);
  if (
    !Number.isFinite(builtAtMs) ||
    new Date(builtAtMs).toISOString() !== parsed.builtAt
  ) {
    throw new Error("Pages build-info timestamp is invalid");
  }

  const identity = parsed.deploymentIdentity;
  if (
    !hasExactKeys(identity, DEPLOYMENT_IDENTITY_KEYS) ||
    identity.schemaVersion !== 1 ||
    identity.target !== expectations.target ||
    identity.cluster !== expectations.cluster ||
    identity.transactionsEnabled !== expectations.transactionsEnabled ||
    identity.useGameRpcProxy !== true ||
    identity.configSha256 !== expectations.configSha256
  ) {
    throw new Error("Pages deployment identity is invalid");
  }

  const bundle = parsed.bundle;
  if (
    !hasExactKeys(bundle, BUNDLE_KEYS) ||
    bundle.schemaVersion !== 1 ||
    !Number.isSafeInteger(bundle.artifactCount) ||
    bundle.artifactCount < 1 ||
    bundle.artifactCount > 10_000 ||
    !SHA256.test(bundle.manifestSha256 ?? "")
  ) {
    throw new Error("Pages bundle identity is invalid");
  }
  return parsed;
}

export function verifyLocalSolanaPagesBuild(input) {
  const parsed = parseSolanaPagesBuildInfo(
    input.referenceRaw,
    input.expectations,
  );
  const recomputedBundle = resolveSolanaPagesBundleManifest(input.bundleRoot);
  if (
    parsed.bundle.schemaVersion !== recomputedBundle.schemaVersion ||
    parsed.bundle.artifactCount !== recomputedBundle.artifactCount ||
    parsed.bundle.manifestSha256 !== recomputedBundle.manifestSha256
  ) {
    throw new Error("Local Pages bundle does not match its build identity");
  }
  return Object.freeze({
    buildInfoSha256: sha256(input.referenceRaw),
    bundleManifestSha256: parsed.bundle.manifestSha256,
    artifactCount: parsed.bundle.artifactCount,
  });
}

function validateOrigin(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2_048 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
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
    throw new Error(`${name} is invalid`);
  }
  return parsed.origin;
}

async function readBuildInfoResponse(response) {
  if (
    !response ||
    response.ok !== true ||
    response.status !== 200 ||
    response.redirected === true
  ) {
    throw new Error("Pages build-info response is not an unredirected 200");
  }
  const contentType = response.headers?.get("content-type") ?? "";
  if (!/^application\/(?:json|[^;\s]+\+json)(?:;|$)/i.test(contentType)) {
    throw new Error("Pages build-info content type is invalid");
  }
  const contentLength = response.headers?.get("content-length");
  let declaredBytes = null;
  if (contentLength != null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new Error("Pages build-info content length is invalid");
    }
    declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 1 ||
      declaredBytes > MAX_BUILD_INFO_BYTES
    ) {
      throw new Error("Pages build-info content length is invalid");
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_BUILD_INFO_BYTES ||
    (declaredBytes != null && bytes.byteLength !== declaredBytes)
  ) {
    throw new Error("Pages build-info body size is invalid");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Pages build-info body is not UTF-8");
  }
}

async function waitForExactBuildInfo(input) {
  let lastError = new Error("Pages build-info was not checked");
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      const response = await input.fetchImpl(
        `${input.origin}/build-info.json`,
        {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      const raw = await readBuildInfoResponse(response);
      parseSolanaPagesBuildInfo(raw, input.expectations);
      if (sha256(raw) !== input.referenceSha256) {
        throw new Error("Pages build-info does not match the built artifact");
      }
      return;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Pages build-info verification failed");
    }
    if (attempt < input.attempts) await input.sleep(input.delayMs);
  }
  throw new Error(
    `${input.label} Pages build verification failed after ${input.attempts} attempts: ${lastError.message}`,
  );
}

export async function verifySolanaPagesDeployment(input) {
  const expectations = validateExpectations(input.expectations);
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
    throw new Error("Pages deployment verification policy is invalid");
  }
  const deploymentOrigin = validateOrigin(input.deploymentUrl, "DEPLOYED_URL");
  const expectedOrigin = validateOrigin(
    input.expectedUrl,
    "PAGES_EXPECTED_URL",
  );
  const localVerification = input.bundleRoot
    ? verifyLocalSolanaPagesBuild({
        referenceRaw: input.referenceRaw,
        expectations,
        bundleRoot: input.bundleRoot,
      })
    : {
        buildInfoSha256: sha256(input.referenceRaw),
        bundleManifestSha256: parseSolanaPagesBuildInfo(
          input.referenceRaw,
          expectations,
        ).bundle.manifestSha256,
      };
  const referenceSha256 = localVerification.buildInfoSha256;
  const origins = [
    { label: "deployment", origin: deploymentOrigin },
    ...(expectedOrigin === deploymentOrigin
      ? []
      : [{ label: "expected-origin", origin: expectedOrigin }]),
  ];
  for (const origin of origins) {
    await waitForExactBuildInfo({
      ...origin,
      expectations,
      referenceSha256,
      attempts: input.attempts,
      delayMs: input.delayMs,
      fetchImpl: input.fetchImpl,
      sleep: input.sleep,
    });
  }
  return Object.freeze({
    verifiedOrigins: origins.length,
    buildInfoSha256: referenceSha256,
    bundleManifestSha256: localVerification.bundleManifestSha256,
  });
}

function readReferenceBuildInfo(bundleRoot) {
  const path = resolve(bundleRoot, "build-info.json");
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_BUILD_INFO_BYTES
  ) {
    throw new Error("Local Pages build-info artifact is invalid");
  }
  return readFileSync(path, "utf8");
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
    const modeArguments = cliArguments.filter(
      (argument) => argument === "--network" || argument === "--local-only",
    );
    const outputArguments = cliArguments.filter((argument) =>
      argument.startsWith("--output="),
    );
    const unknownArguments = cliArguments.filter(
      (argument) =>
        argument !== "--network" &&
        argument !== "--local-only" &&
        !argument.startsWith("--output="),
    );
    const cliMode = modeArguments[0] ?? "--network";
    const outputPath = outputArguments[0]?.slice("--output=".length) ?? null;
    if (
      modeArguments.length > 1 ||
      outputArguments.length > 1 ||
      unknownArguments.length > 0 ||
      (cliMode === "--local-only" && outputPath)
    ) {
      throw new Error(
        "Usage: verify-solana-pages-deployment.mjs [--local-only] [--output=<absolute-path.json>]",
      );
    }
    const bundleRoot = resolve("packages/hyperbet-solana/app/dist");
    const referenceRaw = readReferenceBuildInfo(bundleRoot);
    const expectations = {
      commitSha: process.env.GITHUB_SHA,
      target: process.env.DEPLOY_TARGET,
      cluster: process.env.DEPLOY_SOLANA_CLUSTER,
      configSha256: process.env.PAGES_BUILD_IDENTITY_SHA256,
    };
    const result =
      cliMode === "--local-only"
        ? verifyLocalSolanaPagesBuild({
            referenceRaw,
            expectations,
            bundleRoot,
          })
        : await verifySolanaPagesDeployment({
            deploymentUrl: process.env.DEPLOYED_URL,
            expectedUrl: process.env.PAGES_EXPECTED_URL,
            referenceRaw,
            expectations,
            bundleRoot,
            attempts: 20,
            delayMs: 15_000,
            fetchImpl: globalThis.fetch,
            sleep,
          });
    const evidence = outputPath
      ? writeSolanaDeploymentEvidence(
          outputPath,
          buildSolanaDeploymentEvidence({
            surface: "pages",
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
    process.stderr.write(`Pages deployment verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
