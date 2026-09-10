import { readFileSync } from "node:fs";
import path from "node:path";

import { rootDir } from "./ci-lib";
import {
  findTrackedEnvPolicyErrors,
  FORBIDDEN_NON_SOLANA_ENV,
} from "./ci-env-audit-solana-v1-policy";

type AuditTarget = "ci-shared" | "pages:solana" | "keeper:solana";
type DeploymentMode = "production" | "staging" | "preview";

type Finding = {
  level: "error" | "warning";
  message: string;
};

const TRACKED_ENV_FILES = [
  ".env.example",
  "packages/hyperbet-solana/app/.env.example",
  "packages/hyperbet-solana/keeper/.env.example",
] as const;

const PROVIDER_SECRET_PATTERNS = [
  /[?&](?:api[-_]?key|token)=/i,
  /helius-rpc\.com/i,
  /alchemy\.com\/v2\//i,
  /infura\.io\/v3\//i,
  /quicknode\.(?:com|pro)\//i,
  /quiknode\.pro\//i,
  /drpc\.org\//i,
] as const;

function parseArgs(): {
  target: AuditTarget;
  deployment: DeploymentMode;
  json: boolean;
} {
  const args = process.argv.slice(2);
  const targetArg =
    args
      .find((arg) => arg.startsWith("--target="))
      ?.slice("--target=".length) ?? "ci-shared";
  const deploymentArg =
    args
      .find((arg) => arg.startsWith("--deployment="))
      ?.slice("--deployment=".length) ?? "production";

  if (
    targetArg !== "ci-shared" &&
    targetArg !== "pages:solana" &&
    targetArg !== "keeper:solana"
  ) {
    throw new Error(
      `unsupported SOL-only audit target: ${targetArg}; expected ci-shared, pages:solana, or keeper:solana`,
    );
  }
  if (
    deploymentArg !== "production" &&
    deploymentArg !== "staging" &&
    deploymentArg !== "preview"
  ) {
    throw new Error(`unsupported deployment mode: ${deploymentArg}`);
  }

  return {
    target: targetArg,
    deployment: deploymentArg,
    json: args.includes("--json"),
  };
}

function parseEnvFile(filePath: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    parsed[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return parsed;
}

function requireEnv(findings: Finding[], key: string): string {
  const value = process.env[key]?.trim() ?? "";
  if (!value) {
    findings.push({ level: "error", message: `missing required env ${key}` });
  }
  return value;
}

function requireHttpUrl(
  findings: Finding[],
  key: string,
  allowedProtocols: readonly string[],
): void {
  const value = requireEnv(findings, key);
  if (!value) return;
  try {
    const url = new URL(value);
    if (!allowedProtocols.includes(url.protocol)) {
      findings.push({
        level: "error",
        message: `${key} must use ${allowedProtocols.join(" or ")}`,
      });
    }
    if (url.username || url.password) {
      findings.push({
        level: "error",
        message: `${key} must not contain URL credentials`,
      });
    }
  } catch {
    findings.push({ level: "error", message: `${key} must be a valid URL` });
  }
}

function auditTrackedEnvFiles(findings: Finding[]): void {
  for (const relativePath of TRACKED_ENV_FILES) {
    const env = parseEnvFile(path.join(rootDir, relativePath));
    for (const message of findTrackedEnvPolicyErrors(relativePath, env)) {
      findings.push({ level: "error", message });
    }
  }
}

function auditInjectedEnvironment(findings: Finding[]): void {
  for (const [key, rawValue] of Object.entries(process.env)) {
    const value = rawValue?.trim() ?? "";
    if (!value) continue;
    if (FORBIDDEN_NON_SOLANA_ENV.test(key)) {
      findings.push({
        level: "error",
        message: `${key} is outside the SOL-only v1 environment surface`,
      });
    }
    if (
      key.startsWith("VITE_") &&
      key.endsWith("RPC_URL") &&
      PROVIDER_SECRET_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      findings.push({
        level: "error",
        message: `${key} contains a provider-keyed public RPC URL`,
      });
    }
  }
}

function auditPages(findings: Finding[]): void {
  requireHttpUrl(findings, "VITE_GAME_API_URL", ["https:"]);
  requireHttpUrl(findings, "VITE_GAME_WS_URL", ["wss:"]);
  const cluster = requireEnv(findings, "VITE_SOLANA_CLUSTER");
  const expectedCluster =
    deployment === "production" ? "mainnet-beta" : "devnet";
  if (cluster && cluster !== expectedCluster) {
    findings.push({
      level: "error",
      message: `pages:solana ${deployment} must build with VITE_SOLANA_CLUSTER=${expectedCluster}`,
    });
  }
  if ((process.env.VITE_USE_GAME_RPC_PROXY ?? "").trim() !== "true") {
    findings.push({
      level: "error",
      message: "pages:solana must enable VITE_USE_GAME_RPC_PROXY=true",
    });
  }
  const transactionsEnabled = requireEnv(findings, "VITE_TRANSACTIONS_ENABLED");
  if (
    transactionsEnabled &&
    transactionsEnabled !== "true" &&
    transactionsEnabled !== "false"
  ) {
    findings.push({
      level: "error",
      message: "VITE_TRANSACTIONS_ENABLED must be exactly true or false",
    });
  }
  if (
    (deployment === "preview" || deployment === "production") &&
    transactionsEnabled !== "false"
  ) {
    findings.push({
      level: "error",
      message: `pages:solana ${deployment} must disable transaction authority`,
    });
  }

  const rawStreamSources = requireEnv(findings, "VITE_STREAM_SOURCES");
  const streamSources = rawStreamSources
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (streamSources.length > 3) {
    findings.push({
      level: "error",
      message: "VITE_STREAM_SOURCES supports at most three reviewed sources",
    });
  }
  const streamSourceIdentities: string[] = [];
  for (const source of streamSources) {
    try {
      const url = new URL(source);
      if (url.protocol !== "https:") {
        findings.push({
          level: "error",
          message: "every VITE_STREAM_SOURCES entry must use https:",
        });
      }
      if (url.username || url.password) {
        findings.push({
          level: "error",
          message: "VITE_STREAM_SOURCES must not contain URL credentials",
        });
      }
      if (!/\.m3u8$/i.test(url.pathname)) {
        findings.push({
          level: "error",
          message: "every VITE_STREAM_SOURCES entry must be an HLS .m3u8 URL",
        });
      }
      streamSourceIdentities.push(`${url.origin}${url.pathname}`);
    } catch {
      findings.push({
        level: "error",
        message: "every VITE_STREAM_SOURCES entry must be an absolute URL",
      });
    }
  }
  if (new Set(streamSourceIdentities).size !== streamSourceIdentities.length) {
    findings.push({
      level: "error",
      message:
        "VITE_STREAM_SOURCES must not contain duplicate origins and paths",
    });
  }
}

function auditKeeper(findings: Finding[]): void {
  if (deployment === "production") {
    findings.push({
      level: "error",
      message:
        "keeper:solana production deployment is source-gated off until real-value controls are implemented and approved",
    });
  }
  requireHttpUrl(findings, "HYPERBET_KEEPER_URL", ["https:"]);
  requireEnv(findings, "RAILWAY_PROJECT_ID");
  requireEnv(findings, "RAILWAY_ENVIRONMENT_ID");
  requireEnv(findings, "RAILWAY_KEEPER_SERVICE_ID");
  requireEnv(findings, "RAILWAY_DUEL_BOT_SERVICE_ID");

  if ((process.env.CI_AUDIT_REQUIRE_RUNTIME ?? "").trim() === "true") {
    requireHttpUrl(findings, "SOLANA_RPC_URL", ["https:"]);
  }
}

const { target, deployment, json } = parseArgs();
const findings: Finding[] = [];
auditTrackedEnvFiles(findings);
auditInjectedEnvironment(findings);

if (target === "pages:solana") auditPages(findings);
if (target === "keeper:solana") auditKeeper(findings);

const result = {
  target,
  deployment,
  ok: findings.every((finding) => finding.level !== "error"),
  findings,
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`SOL-only v1 env audit: ${target} (${deployment})`);
  if (findings.length === 0) console.log("ok");
  for (const finding of findings) {
    console.log(`${finding.level}: ${finding.message}`);
  }
}

if (!result.ok) process.exit(1);
