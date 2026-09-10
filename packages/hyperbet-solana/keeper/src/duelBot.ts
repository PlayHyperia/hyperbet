import { createHash, randomUUID } from "node:crypto";
import BN from "bn.js";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  buildQuotePlan,
  classifyManagedLiquiditySubmissionError,
  DEFAULT_MARKET_MAKER_CONFIG,
  evaluateQuoteDecision,
  resolveManagedMarketMakerSettlement,
  type MarketSnapshot,
  type QuotePlan,
} from "./solanaMarketMakerPolicy";
import { createKeeperBotHeartbeat } from "./botHeartbeat";
import {
  buildDuelCorrelationId,
  normalizeDuelCorrelationIds,
} from "./duelCorrelation";
import type {
  KeeperBotHealthSnapshot,
  KeeperMarketHealthRecord,
  KeeperRecoveryState,
} from "./launchHealth";
import { buildKeeperOperatorMetrics } from "./keeperOperatorMetrics";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  createLaunchPrograms,
  duelKeyHexToBytes,
  DUEL_WINNER_MARKET_KIND,
  enumIs,
  FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
  findClobVaultPda,
  findDuelStatePda,
  findMarketConfigPda,
  findMarketPda,
  findOracleConfigPda,
  findOrderPda,
  findPriceLevelPda,
  findProposalRecordPda,
  findUserBalancePda,
  getRpcUrl,
  ORDER_BEHAVIOR_POST_ONLY,
  SIDE_ASK,
  SIDE_BID,
  readKeypair,
  sanitizeErrorMessage,
} from "./launchCommon";
import {
  resolveConfiguredLaunchWallet,
  resolveKeeperRoleRefs,
  validateKeeperFeeTreasurySeparation,
  validateKeeperRoleSeparation,
} from "./keeperRoles";
import { resolveClusterLaunchFeePolicy } from "./feePolicy";
import { resolveOracleDisputeWindowSeconds } from "./oracleDisputeWindowPolicy";
import {
  parseManagedLiquiditySolLamports,
  resolveClusterManagedLiquidityRiskPolicy,
} from "./managedLiquidityRiskPolicy";
import {
  buildDuelCancellationMetadata,
  buildDuelLifecycleMetadata,
  classifyDuelTerminal,
  classifyOracleCancellation,
  classifyOracleFinalizeError,
  classifyOracleLock,
  isOracleTimestampMature,
  resolveOracleDuelEndTimestamp,
  type OracleCancellationState,
  type DuelTerminalDisposition,
} from "./duelTerminalPolicy";
import {
  resolveDuelFeedConfig,
  resolveLocalDiagnosticDuelFeed,
} from "./feedConfig";
import type { PredictionMarketWinner } from "./solanaLifecycle";
import { buildResultHash } from "./resultHash";
import {
  TerminalLedger,
  TerminalOperationConflictError,
  type TerminalOperationInput,
  type TerminalOperationRecord,
} from "./terminalLedger";
import { getExponentialBackoffMs } from "./retryBackoff";
import {
  discoverDuelMarketRecovery,
  planManagedOrderClosure,
  requiresRestartMarketReconciliation,
  resolveManagedOrderClosurePriceLevel,
  type ManagedOrderClosurePriceLevel,
  type MarketRecoveryIssue,
  type ProgramAccountSnapshot,
} from "./marketRecovery";
import {
  deriveProgramDataAddress,
  fetchUpgradeableProgramIdentity,
  resolveClusterExpectedUpgradeAuthority,
} from "./solanaProgramIdentity";
import {
  buildClobQuotePlanningSnapshot,
  isConfigRevalidationDue,
  isValidClobOrderLamports,
  quantizeClobOrderLamports,
  resolveManagedClobQuoteTiming,
} from "./clobOrderSizing";
import releaseManifest from "./release-manifest.json";
import { resolveKeeperReleaseIdentity } from "./releaseIdentity";
import {
  resolveDuelBotHealthServerConfig,
  startDuelBotHealthServer,
} from "./botHealthServer";
import {
  assertDuelBotRuntimeRole,
  isProtectedKeeperRuntimeEnvironment,
} from "./runtimeRolePolicy";
import { assertSolanaMarketCreationAllowed } from "./realValueLaunchPolicy";
import { parseKeeperBotHealthSnapshot } from "./readiness";
import { resolveKeeperRuntimeIdentity } from "./runtimeIdentity";
import { ensureIdempotentAccountInitialized } from "./idempotentAccountInitialization";
import { requireAccountU64, requireSafeAccountInteger } from "./accountInteger";
import {
  reconcileTerminalMarketCustody,
  releaseResolvedTradeFeesFailClosed,
} from "./terminalMarketCustody";
import {
  extractRecoverableTransactionSignature,
  waitForConfirmedTransactionSignature,
} from "./transactionRecovery";

const PROTECTED_KEEPER_RUNTIME = isProtectedKeeperRuntimeEnvironment(
  process.env.NODE_ENV,
);
assertDuelBotRuntimeRole({
  production: PROTECTED_KEEPER_RUNTIME,
  runtimeRole: process.env.HYPERBET_RUNTIME_ROLE,
});

function hashParticipant(
  agent: { id?: string; name?: string } | null,
): number[] {
  const id = agent?.id ?? agent?.name ?? "unknown";
  return Array.from(createHash("sha256").update(id).digest());
}

function toByteArray32(value: unknown): number[] | null {
  if (Array.isArray(value) && value.length === 32) {
    const normalized = value.map((entry) => Number(entry));
    return normalized.every(
      (entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255,
    )
      ? normalized
      : null;
  }
  if (value instanceof Uint8Array && value.length === 32) {
    return Array.from(value);
  }
  if (Buffer.isBuffer(value) && value.length === 32) {
    return Array.from(value);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFundingError(error: unknown): boolean {
  const message = ((error as Error)?.message ?? "").toLowerCase();
  return (
    message.includes(
      "attempt to debit an account but found no record of a prior credit",
    ) ||
    message.includes("insufficient funds") ||
    message.includes("insufficient lamports") ||
    message.includes("fee payer")
  );
}

function isRpcConnectivityError(error: unknown): boolean {
  const message = ((error as Error)?.message ?? "").toLowerCase();
  return (
    message.includes("unable to connect") ||
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("connection reset") ||
    message.includes("network request failed") ||
    message.includes("timed out") ||
    message.includes("socket hang up")
  );
}

async function waitForTxBySignature(
  connection: Connection,
  signature: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  return waitForConfirmedTransactionSignature({
    timeoutMs,
    getStatus: async () => {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = statuses.value[0];
      return status
        ? {
            err: status.err,
            confirmationStatus: status.confirmationStatus ?? null,
          }
        : null;
    },
  });
}

async function runWithRecovery<T>(
  fn: () => Promise<T>,
  connection: Connection,
  signatureRecoveryTimeoutMs = 90_000,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const signature = extractRecoverableTransactionSignature(error);
    if (!signature) throw error;
    const ok = await waitForTxBySignature(
      connection,
      signature,
      signatureRecoveryTimeoutMs,
    );
    if (!ok) throw error;
    return undefined as T;
  }
}

const args = await yargs(hideBin(process.argv))
  .option("once", {
    type: "boolean",
    default: process.env.BOT_LOOP !== "true",
    describe: "Run one cycle and exit",
  })
  .option("poll-seconds", {
    type: "number",
    default: Number(process.env.BOT_POLL_SECONDS || 5),
    describe: "Delay between loop cycles",
  })
  .option("bet-window-seconds", {
    type: "number",
    default: Number(process.env.BET_WINDOW_SECONDS || 300),
    describe: "Bet window for newly created rounds",
  })
  .option("auto-seed-delay-seconds", {
    type: "number",
    default: Number(process.env.AUTO_SEED_DELAY_SECONDS || 10),
    describe: "Auto-seed delay for new markets",
  })
  .option("seed-sol", {
    type: "number",
    default: Number(process.env.MARKET_MAKER_SEED_SOL || 1),
    describe: "Target seed SOL on each side",
  })
  .option("trade-treasury-fee-bps", {
    type: "number",
    default: process.env.TRADE_TREASURY_FEE_BPS?.trim()
      ? Number(process.env.TRADE_TREASURY_FEE_BPS)
      : undefined,
    describe: "Trade fee in basis points routed to treasury wallet",
  })
  .option("trade-market-maker-fee-bps", {
    type: "number",
    default: process.env.TRADE_MARKET_MAKER_FEE_BPS?.trim()
      ? Number(process.env.TRADE_MARKET_MAKER_FEE_BPS)
      : undefined,
    describe: "Trade fee in basis points routed to market maker wallet",
  })
  .option("winnings-market-maker-fee-bps", {
    type: "number",
    default: process.env.WINNINGS_MARKET_MAKER_FEE_BPS?.trim()
      ? Number(process.env.WINNINGS_MARKET_MAKER_FEE_BPS)
      : undefined,
    describe: "Winnings fee in basis points routed to market maker wallet",
  })
  .option("game-url", {
    type: "string",
    default: process.env.GAME_URL || "http://localhost:3000",
    describe: "URL of the Hyperia game server",
  })
  .strict()
  .parse();

import { type DuelLifecycleEvent, GameClient } from "./game-client";
import { resolveDuelLifecycleTiming } from "./duelLifecycleTiming";
import {
  isCurrentDuelRendererObservation,
  resolveDuelMarketAdmission,
} from "./marketCreationAdmission";

import path from "node:path";
import fs_node from "node:fs";

const botCluster = (
  process.env.SOLANA_CLUSTER ||
  process.env.CLUSTER ||
  "mainnet-beta"
)
  .toLowerCase()
  .trim();
assertSolanaMarketCreationAllowed(botCluster);
const keeperRoleRefs = resolveKeeperRoleRefs(process.env);
const keeperFeePayerKeypair = readKeypair(keeperRoleRefs.feePayerKeypair);
const oracleReporterKeypair = readKeypair(keeperRoleRefs.oracleReporterKeypair);
const oracleFinalizerKeypair = readKeypair(
  keeperRoleRefs.oracleFinalizerKeypair,
);
const clobMarketOperatorKeypair = readKeypair(
  keeperRoleRefs.clobMarketOperatorKeypair,
);
const marketMakerKeypair = readKeypair(keeperRoleRefs.marketMakerKeypair);
const oracleConfigAuthorityKeypair = keeperRoleRefs.oracleConfigAuthorityKeypair
  ? readKeypair(keeperRoleRefs.oracleConfigAuthorityKeypair)
  : null;
const clobConfigAuthorityKeypair = keeperRoleRefs.clobConfigAuthorityKeypair
  ? readKeypair(keeperRoleRefs.clobConfigAuthorityKeypair)
  : null;
const oracleChallengerWallet = new PublicKey(
  keeperRoleRefs.oracleChallengerWallet,
);
const keeperRolePublicKeys = {
  feePayer: keeperFeePayerKeypair.publicKey,
  oracleReporter: oracleReporterKeypair.publicKey,
  oracleFinalizer: oracleFinalizerKeypair.publicKey,
  oracleChallenger: oracleChallengerWallet,
  clobMarketOperator: clobMarketOperatorKeypair.publicKey,
  marketMaker: marketMakerKeypair.publicKey,
  oracleConfigAuthority: oracleConfigAuthorityKeypair?.publicKey ?? null,
  clobConfigAuthority: clobConfigAuthorityKeypair?.publicKey ?? null,
};
validateKeeperRoleSeparation(botCluster, keeperRolePublicKeys);
const { connection, provider, fightOracle, duelMarket } = createLaunchPrograms(
  keeperFeePayerKeypair,
);
const fightProgram = fightOracle;
const marketProgram = duelMarket;
const DUEL_BOT_RUNTIME_IDENTITY = resolveKeeperRuntimeIdentity({
  role: "duel-bot",
  cluster: botCluster,
  fightOracleProgramId: fightProgram.programId.toBase58(),
  duelMarketProgramId: marketProgram.programId.toBase58(),
});
type DuelStatusArg = Parameters<typeof fightProgram.methods.upsertDuel>[9];
type OracleWinnerArg =
  { a: Record<string, never> } | { b: Record<string, never> };

function hasProgramMethod(
  program: { methods?: Record<string, unknown> },
  method: string,
): boolean {
  return typeof program?.methods?.[method] === "function";
}

const BOT_HEALTH_FILE = (
  process.env.KEEPER_BOT_HEALTH_FILE ||
  path.resolve(__dirname, "..", ".status", "keeper-bot-health.json")
).trim();
const BOT_RELEASE_IDENTITY = resolveKeeperReleaseIdentity(
  releaseManifest,
  process.env.HYPERBET_RELEASE_SHA,
);
const DUEL_BOT_HEALTH_SERVER_ENABLED =
  process.env.HYPERBET_RUNTIME_ROLE === "duel-bot" ||
  process.env.DUEL_BOT_HEALTH_SERVER_ENABLED?.trim().toLowerCase() === "true";
const DUEL_BOT_HEALTH_SERVER_CONFIG = DUEL_BOT_HEALTH_SERVER_ENABLED
  ? resolveDuelBotHealthServerConfig({
      production: PROTECTED_KEEPER_RUNTIME,
      port: process.env.BOT_HEALTH_PORT ?? process.env.PORT,
      bearerToken: process.env.KEEPER_BOT_HEALTH_BEARER_TOKEN,
      maxAgeMs: process.env.READINESS_BOT_MAX_AGE_MS,
    })
  : null;
const BOT_READINESS_MAX_AGE_MS = readPositiveIntegerEnv(
  "READINESS_BOT_MAX_AGE_MS",
  30_000,
  5_000,
);
const BOT_HEALTH_HEARTBEAT_MS = readPositiveIntegerEnv(
  "KEEPER_BOT_HEALTH_HEARTBEAT_MS",
  Math.min(5_000, Math.floor(BOT_READINESS_MAX_AGE_MS / 3)),
  250,
  BOT_READINESS_MAX_AGE_MS - 1_000,
);
const MARKET_HEALTH_RETENTION_MS = Math.max(
  60_000,
  Number(process.env.KEEPER_MARKET_HEALTH_RETENTION_MS || 15 * 60_000),
);

const missingKeeperMethods: string[] = [];
for (const method of [
  "initializeOracle",
  "updateOracleConfig",
  "upsertDuel",
  "cancelDuel",
  "proposeResult",
  "challengeResult",
  "finalizeResult",
]) {
  if (!hasProgramMethod(fightProgram, method)) {
    missingKeeperMethods.push(`fightOracle.${method}`);
  }
}
for (const method of [
  "initializeConfig",
  "updateConfig",
  "initializeMarket",
  "syncMarketFromDuel",
  "placeOrder",
  "continueOrder",
  "cancelOrder",
  "reclaimRestingOrder",
  "claim",
]) {
  if (!hasProgramMethod(marketProgram, method)) {
    missingKeeperMethods.push(`duelMarket.${method}`);
  }
}

const keeperProgramApiReady = missingKeeperMethods.length === 0;
let warnedMissingKeeperMethods = false;

function warnMissingKeeperMethodsOnce(): void {
  if (keeperProgramApiReady || warnedMissingKeeperMethods) return;
  warnedMissingKeeperMethods = true;
  console.warn(
    `[bot] keeper disabled: IDL/program methods missing (${missingKeeperMethods.join(", ")}).`,
  );
}

function readPositiveIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

const configuredDisputeWindowSecs = resolveOracleDisputeWindowSeconds({
  cluster: botCluster,
  configuredValue: process.env.SOLANA_ORACLE_DISPUTE_WINDOW_SECS,
});

const terminalLedger = new TerminalLedger();
const terminalWorkerId = `duel-bot:${process.pid}:${randomUUID()}`;
const terminalLeaseMs = readPositiveIntegerEnv(
  "TERMINAL_OPERATION_LEASE_MS",
  2 * 60_000,
  30_000,
);
const terminalRetryBaseMs = readPositiveIntegerEnv(
  "TERMINAL_RETRY_BASE_MS",
  5_000,
  1_000,
);
const terminalRetryMaxMs = readPositiveIntegerEnv(
  "TERMINAL_RETRY_MAX_MS",
  5 * 60_000,
  terminalRetryBaseMs,
);
const terminalMaxAttempts = readPositiveIntegerEnv(
  "TERMINAL_MAX_ATTEMPTS",
  25,
  1,
  1_000,
);
const terminalReconcileBatchSize = readPositiveIntegerEnv(
  "TERMINAL_RECONCILE_BATCH_SIZE",
  10,
  1,
  50,
);
const marketDiscoveryIntervalMs = readPositiveIntegerEnv(
  "MARKET_DISCOVERY_INTERVAL_MS",
  60_000,
  10_000,
  10 * 60_000,
);
const configRevalidationIntervalMs = readPositiveIntegerEnv(
  "KEEPER_CONFIG_REVALIDATION_INTERVAL_MS",
  60_000,
  10_000,
  10 * 60_000,
);
const marketInitializationRecoveryTimeoutMs = readPositiveIntegerEnv(
  "MARKET_INITIALIZATION_RECOVERY_TIMEOUT_MS",
  15_000,
  1_000,
  90_000,
);
const marketInitializationMaxAttempts = readPositiveIntegerEnv(
  "MARKET_INITIALIZATION_MAX_ATTEMPTS",
  2,
  1,
  3,
);
const marketInitializationRetryDelayMs = readPositiveIntegerEnv(
  "MARKET_INITIALIZATION_RETRY_DELAY_MS",
  1_000,
  0,
  10_000,
);

class ManualReviewTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualReviewTerminalError";
  }
}

const minSignerLamports = Math.max(
  5_000,
  Number(process.env.BOT_MIN_BALANCE_LAMPORTS || 100_000),
);
const fundingBackoffMs = Math.max(
  10_000,
  Number(process.env.BOT_FUNDING_CHECK_COOLDOWN_MS || 60_000),
);
const airdropRateLimitCooldownMs = Math.max(
  fundingBackoffMs,
  Number(process.env.BOT_AIRDROP_RATE_LIMIT_COOLDOWN_MS || 15 * 60 * 1000),
);
const rpcRetryBaseMs = readPositiveIntegerEnv(
  "BOT_RPC_RETRY_BASE_MS",
  1_000,
  250,
  60_000,
);
const rpcRetryMaxMs = readPositiveIntegerEnv(
  "BOT_RPC_CHECK_COOLDOWN_MS",
  60_000,
  rpcRetryBaseMs,
  10 * 60_000,
);
const chainCheckCooldownMs = readPositiveIntegerEnv(
  "BOT_CHAIN_CHECK_COOLDOWN_MS",
  120_000,
  rpcRetryBaseMs,
  10 * 60_000,
);
const programIdentityCheckIntervalMs = Math.max(
  10_000,
  Number(process.env.PROGRAM_IDENTITY_CHECK_INTERVAL_MS || 60_000),
);
let fundingBlockedUntil = 0;
let lastFundingWarningAt = 0;
let airdropBlockedUntil = 0;
let rpcBlockedUntil = 0;
let rpcConsecutiveFailures = 0;
let lastRpcWarningAt = 0;
let chainCheckBlockedUntil = 0;
let lastChainWarningAt = 0;
let lastSuccessfulProgramIdentityAtMs: number | null = null;
const botBootedAtMs = Date.now();
let botRuntimeRunning = true;
let lastSuccessfulRpcAtMs: number | null = null;
let lastStreamEventAtMs: number | null = null;
let restartRecoveryObservedAtMs: number | null = null;
let restartRecoveryDetails: string | null = null;
let lastCycleErrorAtMs: number | null = null;
let lastCycleErrorDetails: string | null = null;
let lastMarketDiscoveryAtMs = 0;
let lastSuccessfulMarketDiscoveryAtMs: number | null = null;
let marketDiscoveryErrorAtMs: number | null = null;
let marketDiscoveryErrorDetails: string | null = null;
let marketRecoveryIssues: MarketRecoveryIssue[] = [];
let marketRecoveryIssueObservedAtMs: number | null = null;
let marketDiscoveryInFlight: Promise<void> | null = null;

function registerRpcFailure(): number {
  rpcConsecutiveFailures += 1;
  const backoffMs = getExponentialBackoffMs({
    baseMs: rpcRetryBaseMs,
    maxMs: rpcRetryMaxMs,
    consecutiveFailures: rpcConsecutiveFailures,
  });
  rpcBlockedUntil = Date.now() + backoffMs;
  return backoffMs;
}
let lastOracleConfigVerifiedAtMs: number | null = null;
let lastMarketConfigVerifiedAtMs: number | null = null;

const oracleConfigPda = findOracleConfigPda(fightOracle.programId);
const marketConfigPda = findMarketConfigPda(marketProgram.programId);

const {
  tradeTreasuryFeeBps,
  tradeMarketMakerFeeBps,
  winningsMarketMakerFeeBps,
} = resolveClusterLaunchFeePolicy({
  cluster: botCluster,
  approval: process.env.SOLANA_LAUNCH_FEE_POLICY_APPROVED,
  tradeTreasuryFeeBps: args["trade-treasury-fee-bps"],
  tradeMarketMakerFeeBps: args["trade-market-maker-fee-bps"],
  winningsMarketMakerFeeBps: args["winnings-market-maker-fee-bps"],
});
const configuredTradeTreasuryWallet = resolveConfiguredLaunchWallet({
  cluster: botCluster,
  envName: "TRADE_TREASURY_WALLET",
  configuredValue: process.env.TRADE_TREASURY_WALLET,
  localFallback: keeperFeePayerKeypair.publicKey,
});
const configuredTradeMarketMakerWallet = resolveConfiguredLaunchWallet({
  cluster: botCluster,
  envName: "TRADE_MARKET_MAKER_WALLET",
  configuredValue: process.env.TRADE_MARKET_MAKER_WALLET,
  localFallback: marketMakerKeypair.publicKey,
});
validateKeeperFeeTreasurySeparation(
  botCluster,
  keeperRolePublicKeys,
  configuredTradeTreasuryWallet,
);
const managedLiquidityRiskPolicy = resolveClusterManagedLiquidityRiskPolicy({
  cluster: botCluster,
  approval: process.env.SOLANA_LAUNCH_MARKET_MAKER_RISK_APPROVED,
  seedSol: process.env.MARKET_MAKER_SEED_SOL,
  minQuoteSol: process.env.MARKET_MAKER_MIN_QUOTE_SOL,
  referenceBidPriceMillis: process.env.MARKET_MAKER_BID_PRICE,
  referenceAskPriceMillis: process.env.MARKET_MAKER_ASK_PRICE,
  minQuotePriceMillis: process.env.MARKET_MAKER_MIN_QUOTE_PRICE_MILLIS,
  maxQuotePriceMillis: process.env.MARKET_MAKER_MAX_QUOTE_PRICE_MILLIS,
  maxInventorySolPerSide: process.env.MARKET_MAKER_MAX_INVENTORY_SOL_PER_SIDE,
  maxNetExposureSol: process.env.MARKET_MAKER_MAX_NET_EXPOSURE_SOL,
  maxGrossExposureSol: process.env.MARKET_MAKER_MAX_GROSS_EXPOSURE_SOL,
  maxSideImbalanceBps: process.env.MARKET_MAKER_MAX_SIDE_IMBALANCE_BPS,
  maxDrawdownBps: process.env.MARKET_MAKER_MAX_DRAWDOWN_BPS,
});
const marketMakerSeedLamports =
  managedLiquidityRiskPolicy?.seedLamports ??
  parseManagedLiquiditySolLamports(
    "MARKET_MAKER_SEED_SOL",
    process.env.MARKET_MAKER_SEED_SOL?.trim() || String(args["seed-sol"]),
  );
const autoSeedDelayMs = Math.max(
  0,
  Math.floor(Number(args["auto-seed-delay-seconds"]) * 1000),
);
const configuredBidPrice =
  managedLiquidityRiskPolicy?.referenceBidPriceMillis ??
  Math.max(
    1,
    Math.min(
      999,
      Math.floor(Number(process.env.MARKET_MAKER_BID_PRICE || 400)),
    ),
  );
const configuredAskPrice =
  managedLiquidityRiskPolicy?.referenceAskPriceMillis ??
  Math.max(
    configuredBidPrice + 1,
    Math.min(
      999,
      Math.floor(Number(process.env.MARKET_MAKER_ASK_PRICE || 600)),
    ),
  );
const configuredMidPrice = Math.max(
  1,
  Math.round((configuredBidPrice + configuredAskPrice) / 2),
);
const configuredSpreadBps = Math.max(
  DEFAULT_MARKET_MAKER_CONFIG.targetSpreadBps,
  Math.round(
    ((configuredAskPrice - configuredBidPrice) * 10_000) /
      Math.max(1, configuredMidPrice),
  ),
);
const managedClobQuoteTiming = resolveManagedClobQuoteTiming({
  minRefreshIntervalMs: readPositiveIntegerEnv(
    "MARKET_MAKER_MIN_REFRESH_INTERVAL_MS",
    5_000,
    1_000,
    60_000,
  ),
  maxQuoteAgeMs: readPositiveIntegerEnv(
    "MARKET_MAKER_MAX_QUOTE_AGE_MS",
    5 * 60_000,
    30_000,
    15 * 60_000,
  ),
});
const managedClobQuoteConfig = {
  ...DEFAULT_MARKET_MAKER_CONFIG,
  ...managedClobQuoteTiming,
  targetSpreadBps: configuredSpreadBps,
  minQuotePrice:
    managedLiquidityRiskPolicy?.minQuotePriceMillis ??
    DEFAULT_MARKET_MAKER_CONFIG.minQuotePrice,
  maxQuotePrice:
    managedLiquidityRiskPolicy?.maxQuotePriceMillis ??
    DEFAULT_MARKET_MAKER_CONFIG.maxQuotePrice,
  minQuoteUnits:
    managedLiquidityRiskPolicy?.minQuoteLamports ??
    Math.max(1_000, Math.floor(marketMakerSeedLamports / 4 / 1_000) * 1_000),
  maxQuoteUnits: marketMakerSeedLamports,
  maxInventoryPerSide:
    managedLiquidityRiskPolicy?.maxInventoryLamportsPerSide ??
    Math.max(
      DEFAULT_MARKET_MAKER_CONFIG.maxInventoryPerSide,
      marketMakerSeedLamports * 4,
    ),
  maxNetExposure:
    managedLiquidityRiskPolicy?.maxNetExposureLamports ??
    Math.max(
      DEFAULT_MARKET_MAKER_CONFIG.maxNetExposure,
      marketMakerSeedLamports * 2,
    ),
  maxGrossExposure:
    managedLiquidityRiskPolicy?.maxGrossExposureLamports ??
    Math.max(
      DEFAULT_MARKET_MAKER_CONFIG.maxGrossExposure,
      marketMakerSeedLamports * 6,
    ),
  maxSideImbalanceBps:
    managedLiquidityRiskPolicy?.maxSideImbalanceBps ??
    DEFAULT_MARKET_MAKER_CONFIG.maxSideImbalanceBps,
  maxDrawdownBps:
    managedLiquidityRiskPolicy?.maxDrawdownBps ??
    DEFAULT_MARKET_MAKER_CONFIG.maxDrawdownBps,
};

const requiredPrograms = [
  {
    label: "fight oracle",
    programId: fightProgram.programId,
    expectedUpgradeAuthority: resolveClusterExpectedUpgradeAuthority({
      cluster: botCluster,
      value:
        process.env.FIGHT_ORACLE_EXPECTED_UPGRADE_AUTHORITY ||
        process.env.SOLANA_EXPECTED_UPGRADE_AUTHORITY,
      label: "fight oracle",
    }),
  },
  {
    label: "duel market",
    programId: marketProgram.programId,
    expectedUpgradeAuthority: resolveClusterExpectedUpgradeAuthority({
      cluster: botCluster,
      value:
        process.env.DUEL_MARKET_EXPECTED_UPGRADE_AUTHORITY ||
        process.env.SOLANA_EXPECTED_UPGRADE_AUTHORITY,
      label: "duel market",
    }),
  },
];

const canRequestAirdrop =
  botCluster === "testnet" ||
  botCluster === "devnet" ||
  botCluster === "localnet";

const requiredFundedSigners = [
  { label: "fee payer", keypair: keeperFeePayerKeypair },
  { label: "oracle reporter", keypair: oracleReporterKeypair },
  { label: "oracle finalizer", keypair: oracleFinalizerKeypair },
  { label: "CLOB market operator", keypair: clobMarketOperatorKeypair },
  { label: "market maker", keypair: marketMakerKeypair },
  ...(oracleConfigAuthorityKeypair
    ? [
        {
          label: "oracle config authority",
          keypair: oracleConfigAuthorityKeypair,
        },
      ]
    : []),
  ...(clobConfigAuthorityKeypair
    ? [
        {
          label: "CLOB config authority",
          keypair: clobConfigAuthorityKeypair,
        },
      ]
    : []),
].filter(
  (role, index, roles) =>
    roles.findIndex((candidate) =>
      candidate.keypair.publicKey.equals(role.keypair.publicKey),
    ) === index,
);

async function ensureKeeperSignerFunding(): Promise<boolean> {
  const now = Date.now();
  if (now < fundingBlockedUntil || now < rpcBlockedUntil) {
    return false;
  }

  for (const role of requiredFundedSigners) {
    let lamports: number;
    try {
      lamports = await connection.getBalance(
        role.keypair.publicKey,
        "confirmed",
      );
    } catch (error) {
      if (isRpcConnectivityError(error)) {
        if (Date.now() - lastRpcWarningAt > 10_000) {
          const message =
            error instanceof Error ? error.message : String(error);
          const backoffMs = registerRpcFailure();
          console.warn(
            `[bot] solana rpc unavailable at ${connection.rpcEndpoint}: ${message}. Backing off for ${Math.round(
              backoffMs / 1000,
            )}s.`,
          );
          lastRpcWarningAt = Date.now();
        } else {
          registerRpcFailure();
        }
        return false;
      }
      throw error;
    }

    if (
      lamports < minSignerLamports &&
      canRequestAirdrop &&
      now >= airdropBlockedUntil
    ) {
      try {
        const airdropSig = await connection.requestAirdrop(
          role.keypair.publicKey,
          1 * LAMPORTS_PER_SOL,
        );
        await connection.confirmTransaction(airdropSig, "confirmed");
        lamports = await connection.getBalance(
          role.keypair.publicKey,
          "confirmed",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isRateLimited =
          message.includes("429") || /too many requests/i.test(message);
        const isRpcError = isRpcConnectivityError(error);
        if (isRateLimited) {
          airdropBlockedUntil = Date.now() + airdropRateLimitCooldownMs;
        }
        if (isRpcError) {
          registerRpcFailure();
        }
        if (Date.now() - lastFundingWarningAt > 10_000) {
          console.warn(
            `[bot] ${role.label} airdrop attempt failed: ${message}`,
          );
          if (isRateLimited) {
            console.warn(
              `[bot] faucet rate-limited; pausing airdrop attempts for ${Math.round(
                airdropRateLimitCooldownMs / 1000,
              )}s`,
            );
          }
          lastFundingWarningAt = Date.now();
        }
      }
    }

    if (lamports < minSignerLamports) {
      if (Date.now() - lastFundingWarningAt > 10_000) {
        console.warn(
          `[bot] ${role.label} wallet ${role.keypair.publicKey.toBase58()} has ${(
            lamports / LAMPORTS_PER_SOL
          ).toFixed(6)} SOL (< ${(minSignerLamports / LAMPORTS_PER_SOL).toFixed(
            6,
          )} required). Skipping keeper cycle for ${Math.round(
            fundingBackoffMs / 1000,
          )}s.`,
        );
        lastFundingWarningAt = Date.now();
      }
      fundingBlockedUntil = Date.now() + fundingBackoffMs;
      return false;
    }
  }

  markRpcSuccess();
  return true;
}

async function ensureKeeperChainReady(): Promise<boolean> {
  const now = Date.now();
  if (now < chainCheckBlockedUntil || now < rpcBlockedUntil) {
    return false;
  }
  if (
    lastSuccessfulProgramIdentityAtMs != null &&
    now - lastSuccessfulProgramIdentityAtMs < programIdentityCheckIntervalMs
  ) {
    return true;
  }

  try {
    await connection.getLatestBlockhash("confirmed");
    await Promise.all(
      requiredPrograms.map((program) =>
        fetchUpgradeableProgramIdentity({
          connection,
          ...program,
        }),
      ),
    );
    lastSuccessfulProgramIdentityAtMs = Date.now();
    markRpcSuccess();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rpcFailure = isRpcConnectivityError(error);
    const backoffMs = rpcFailure ? registerRpcFailure() : chainCheckCooldownMs;
    if (Date.now() - lastChainWarningAt > 10_000) {
      console.warn(
        `[bot] failed keeper chain readiness check against ${connection.rpcEndpoint}: ${message}. Backing off for ${Math.round(
          backoffMs / 1000,
        )}s.`,
      );
      lastChainWarningAt = Date.now();
    }
    if (!rpcFailure) {
      chainCheckBlockedUntil = Date.now() + chainCheckCooldownMs;
    }
    return false;
  }
}

async function ensureWalletAccountReady(
  wallet: PublicKey,
  label: string,
): Promise<void> {
  const existingAccount = await connection.getAccountInfo(wallet, "confirmed");
  if (existingAccount) {
    return;
  }

  if (!canRequestAirdrop) {
    throw new Error(
      `[bot] ${label} wallet ${wallet.toBase58()} does not exist on-chain`,
    );
  }

  const signature = await connection.requestAirdrop(wallet, minSignerLamports);
  await connection.confirmTransaction(signature, "confirmed");
  const fundedAccount = await connection.getAccountInfo(wallet, "confirmed");
  if (!fundedAccount) {
    throw new Error(
      `[bot] failed to initialize ${label} wallet ${wallet.toBase58()} on-chain`,
    );
  }

  console.log(
    `[bot] Initialized ${label} wallet ${wallet.toBase58()} with ${minSignerLamports} lamports`,
  );
}

const ensureOracleReady = async (): Promise<void> => {
  if (
    !isConfigRevalidationDue({
      lastVerifiedAtMs: lastOracleConfigVerifiedAtMs,
      intervalMs: configRevalidationIntervalMs,
    })
  ) {
    return;
  }

  let config =
    await fightProgram.account.oracleConfig.fetchNullable(oracleConfigPda);
  if (!config) {
    if (!oracleConfigAuthorityKeypair) {
      throw new Error(
        `Oracle config ${oracleConfigPda.toBase58()} is missing; ORACLE_CONFIG_AUTHORITY_KEYPAIR is required for explicit initialization`,
      );
    }
    await runWithRecovery(
      () =>
        fightProgram.methods
          .initializeOracle(
            oracleReporterKeypair.publicKey,
            oracleFinalizerKeypair.publicKey,
            oracleChallengerWallet,
            new BN(configuredDisputeWindowSecs),
          )
          .accountsPartial({
            authority: oracleConfigAuthorityKeypair.publicKey,
            oracleConfig: oracleConfigPda,
            program: fightProgram.programId,
            programData: deriveProgramDataAddress(fightProgram.programId),
            systemProgram: SystemProgram.programId,
          })
          .signers([oracleConfigAuthorityKeypair])
          .rpc(),
      connection,
    );
    config =
      await fightProgram.account.oracleConfig.fetchNullable(oracleConfigPda);
  }
  if (!config) {
    throw new Error(
      `Oracle config ${oracleConfigPda.toBase58()} was not created`,
    );
  }
  const accountSchemaVersion = requireSafeAccountInteger(
    config.accountSchemaVersion,
    "oracle account schema version",
    { min: 1 },
  );
  if (accountSchemaVersion !== FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION) {
    throw new Error(
      `Oracle config ${oracleConfigPda.toBase58()} uses unsupported account schema ${accountSchemaVersion}; expected ${FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION}`,
    );
  }
  const onChainAuthority = config.authority as PublicKey;
  if (
    oracleConfigAuthorityKeypair &&
    !onChainAuthority.equals(oracleConfigAuthorityKeypair.publicKey)
  ) {
    throw new Error(
      `ORACLE_CONFIG_AUTHORITY_KEYPAIR ${oracleConfigAuthorityKeypair.publicKey.toBase58()} does not match on-chain oracle authority ${onChainAuthority.toBase58()}`,
    );
  }
  const oracleConfigNeedsUpdate = (
    candidate: NonNullable<typeof config>,
  ): boolean =>
    !(candidate.reporter as PublicKey).equals(
      oracleReporterKeypair.publicKey,
    ) ||
    !(candidate.finalizer as PublicKey).equals(
      oracleFinalizerKeypair.publicKey,
    ) ||
    !(candidate.challenger as PublicKey).equals(oracleChallengerWallet) ||
    requireSafeAccountInteger(
      candidate.disputeWindowSecs,
      "oracle dispute window seconds",
      { min: 1 },
    ) !== configuredDisputeWindowSecs;
  const configNeedsUpdate = oracleConfigNeedsUpdate(config);
  if (configNeedsUpdate) {
    if (Boolean(config.configFrozen)) {
      throw new Error(
        `Oracle config ${oracleConfigPda.toBase58()} is frozen and does not match the required launch roles or dispute window`,
      );
    }
    if (!oracleConfigAuthorityKeypair) {
      throw new Error(
        `Oracle config ${oracleConfigPda.toBase58()} does not match the required launch roles or dispute window; ORACLE_CONFIG_AUTHORITY_KEYPAIR is required for an explicit update`,
      );
    }
    await runWithRecovery(
      () =>
        fightProgram.methods
          .updateOracleConfig(
            onChainAuthority,
            oracleReporterKeypair.publicKey,
            oracleFinalizerKeypair.publicKey,
            oracleChallengerWallet,
            new BN(configuredDisputeWindowSecs),
          )
          .accountsPartial({
            authority: oracleConfigAuthorityKeypair.publicKey,
            oracleConfig: oracleConfigPda,
          })
          .signers([oracleConfigAuthorityKeypair])
          .rpc(),
      connection,
    );
    config =
      await fightProgram.account.oracleConfig.fetchNullable(oracleConfigPda);
    if (!config) {
      throw new Error(
        `Oracle config ${oracleConfigPda.toBase58()} disappeared after update`,
      );
    }
  }
  const verifiedOracleAuthority = config.authority as PublicKey;
  if (
    oracleConfigAuthorityKeypair &&
    !verifiedOracleAuthority.equals(oracleConfigAuthorityKeypair.publicKey)
  ) {
    throw new Error(
      `Oracle config ${oracleConfigPda.toBase58()} authority drifted after verification`,
    );
  }
  if (oracleConfigNeedsUpdate(config)) {
    throw new Error(
      `Oracle config ${oracleConfigPda.toBase58()} did not converge to the required launch roles or dispute window`,
    );
  }
  if (!Boolean(config.configFrozen)) {
    throw new Error(
      `Oracle config ${oracleConfigPda.toBase58()} is not permanently frozen; run the approved launch configuration freeze before starting the duel keeper`,
    );
  }
  lastOracleConfigVerifiedAtMs = Date.now();
  markRpcSuccess();
};

const ensureMarketConfigReady = async (): Promise<void> => {
  if (
    !isConfigRevalidationDue({
      lastVerifiedAtMs: lastMarketConfigVerifiedAtMs,
      intervalMs: configRevalidationIntervalMs,
    })
  ) {
    return;
  }
  const firstVerification = lastMarketConfigVerifiedAtMs == null;

  await Promise.all([
    ensureWalletAccountReady(configuredTradeTreasuryWallet, "trade treasury"),
    ensureWalletAccountReady(
      configuredTradeMarketMakerWallet,
      "trade market maker",
    ),
  ]);

  let existingConfig =
    await marketProgram.account.marketConfig.fetchNullable(marketConfigPda);
  const expectedConfig = {
    marketOperator: clobMarketOperatorKeypair.publicKey,
    treasury: configuredTradeTreasuryWallet,
    marketMaker: configuredTradeMarketMakerWallet,
    tradeTreasuryFeeBps,
    tradeMarketMakerFeeBps,
    winningsMarketMakerFeeBps,
  };

  if (!existingConfig) {
    if (!clobConfigAuthorityKeypair) {
      throw new Error(
        `CLOB config ${marketConfigPda.toBase58()} is missing; CLOB_CONFIG_AUTHORITY_KEYPAIR is required for explicit initialization`,
      );
    }
    await runWithRecovery(
      () =>
        marketProgram.methods
          .initializeConfig(
            expectedConfig.marketOperator,
            expectedConfig.treasury,
            expectedConfig.marketMaker,
            expectedConfig.tradeTreasuryFeeBps,
            expectedConfig.tradeMarketMakerFeeBps,
            expectedConfig.winningsMarketMakerFeeBps,
          )
          .accountsPartial({
            authority: clobConfigAuthorityKeypair.publicKey,
            config: marketConfigPda,
            program: marketProgram.programId,
            programData: deriveProgramDataAddress(marketProgram.programId),
            systemProgram: SystemProgram.programId,
          })
          .signers([clobConfigAuthorityKeypair])
          .rpc(),
      connection,
    );
    console.log(
      `[bot] CLOB market config initialized at ${marketConfigPda.toBase58()}`,
    );
    existingConfig =
      await marketProgram.account.marketConfig.fetchNullable(marketConfigPda);
    if (!existingConfig) {
      throw new Error(
        `CLOB config ${marketConfigPda.toBase58()} was not created`,
      );
    }
  }

  const onChainAuthority = existingConfig.authority as PublicKey;
  if (
    clobConfigAuthorityKeypair &&
    !onChainAuthority.equals(clobConfigAuthorityKeypair.publicKey)
  ) {
    throw new Error(
      `CLOB_CONFIG_AUTHORITY_KEYPAIR ${clobConfigAuthorityKeypair.publicKey.toBase58()} does not match on-chain CLOB authority ${onChainAuthority.toBase58()}`,
    );
  }
  const marketConfigNeedsUpdate = (
    candidate: NonNullable<typeof existingConfig>,
  ): boolean =>
    !(candidate.marketOperator as PublicKey).equals(
      expectedConfig.marketOperator,
    ) ||
    !(candidate.treasury as PublicKey).equals(expectedConfig.treasury) ||
    !(candidate.marketMaker as PublicKey).equals(expectedConfig.marketMaker) ||
    requireSafeAccountInteger(
      candidate.tradeTreasuryFeeBps,
      "market treasury trade fee bps",
      { min: 0, max: 10_000 },
    ) !== expectedConfig.tradeTreasuryFeeBps ||
    requireSafeAccountInteger(
      candidate.tradeMarketMakerFeeBps,
      "market-maker trade fee bps",
      { min: 0, max: 10_000 },
    ) !== expectedConfig.tradeMarketMakerFeeBps ||
    requireSafeAccountInteger(
      candidate.winningsMarketMakerFeeBps,
      "market-maker winnings fee bps",
      { min: 0, max: 10_000 },
    ) !== expectedConfig.winningsMarketMakerFeeBps;
  const configNeedsUpdate = marketConfigNeedsUpdate(existingConfig);

  if (configNeedsUpdate) {
    if (Boolean(existingConfig.configFrozen)) {
      throw new Error(
        `CLOB config ${marketConfigPda.toBase58()} is frozen and does not match the required launch operator, fee wallets, or fee policy`,
      );
    }
    if (!clobConfigAuthorityKeypair) {
      throw new Error(
        `CLOB config ${marketConfigPda.toBase58()} does not match the required launch operator, fee wallets, or fee policy; CLOB_CONFIG_AUTHORITY_KEYPAIR is required for an explicit update`,
      );
    }
    await runWithRecovery(
      () =>
        marketProgram.methods
          .updateConfig(
            onChainAuthority,
            expectedConfig.marketOperator,
            expectedConfig.treasury,
            expectedConfig.marketMaker,
            expectedConfig.tradeTreasuryFeeBps,
            expectedConfig.tradeMarketMakerFeeBps,
            expectedConfig.winningsMarketMakerFeeBps,
          )
          .accountsPartial({
            authority: clobConfigAuthorityKeypair.publicKey,
            config: marketConfigPda,
          })
          .signers([clobConfigAuthorityKeypair])
          .rpc(),
      connection,
    );
    existingConfig =
      await marketProgram.account.marketConfig.fetchNullable(marketConfigPda);
    if (!existingConfig) {
      throw new Error(
        `CLOB config ${marketConfigPda.toBase58()} disappeared after update`,
      );
    }
    console.log(
      `[bot] CLOB market config updated at ${marketConfigPda.toBase58()} treasury=${expectedConfig.treasury.toBase58()} marketMaker=${expectedConfig.marketMaker.toBase58()}`,
    );
  } else if (firstVerification) {
    console.log(
      `[bot] CLOB market config verified at ${marketConfigPda.toBase58()}`,
    );
  }
  const verifiedMarketAuthority = existingConfig.authority as PublicKey;
  if (
    clobConfigAuthorityKeypair &&
    !verifiedMarketAuthority.equals(clobConfigAuthorityKeypair.publicKey)
  ) {
    throw new Error(
      `CLOB config ${marketConfigPda.toBase58()} authority drifted after verification`,
    );
  }
  if (marketConfigNeedsUpdate(existingConfig)) {
    throw new Error(
      `CLOB config ${marketConfigPda.toBase58()} did not converge to the required launch operator, fee recipients, or fee policy`,
    );
  }
  if (!Boolean(existingConfig.configFrozen)) {
    throw new Error(
      `CLOB config ${marketConfigPda.toBase58()} is not permanently frozen; run the approved launch configuration freeze before starting the duel keeper`,
    );
  }
  lastMarketConfigVerifiedAtMs = Date.now();
  markRpcSuccess();
};

async function getDuelState(
  duelStatePda: PublicKey,
): Promise<Record<string, unknown> | null> {
  const duelState =
    await fightProgram.account.duelState.fetchNullable(duelStatePda);
  markRpcSuccess();
  return duelState;
}

async function getOracleConfigState(): Promise<Record<string, unknown> | null> {
  const oracleConfig =
    await fightProgram.account.oracleConfig.fetchNullable(oracleConfigPda);
  markRpcSuccess();
  return oracleConfig;
}

async function getConfirmedChainTimeSecs(): Promise<number | null> {
  const slot = await connection.getSlot("confirmed");
  const chainTimeSecs = await connection.getBlockTime(slot);
  markRpcSuccess();
  return Number.isSafeInteger(chainTimeSecs) ? chainTimeSecs : null;
}

async function waitForConfirmedChainTimestamp(
  targetTimeSecs: number,
  context: string,
  maxWaitMs = 15_000,
): Promise<void> {
  const deadlineMs = Date.now() + maxWaitMs;
  do {
    const chainTimeSecs = await getConfirmedChainTimeSecs();
    if (isOracleTimestampMature(chainTimeSecs, targetTimeSecs)) {
      return;
    }
    if (Date.now() >= deadlineMs) {
      throw new Error(
        `${context}: confirmed Solana time ${chainTimeSecs ?? "unavailable"} has not reached ${targetTimeSecs}`,
      );
    }
    await sleep(500);
  } while (true);
}

async function getClobMarketState(
  marketStatePda: PublicKey,
): Promise<Record<string, unknown> | null> {
  const marketState =
    await marketProgram.account.marketState.fetchNullable(marketStatePda);
  markRpcSuccess();
  return marketState;
}

type ManagedClobOrder = {
  orderId: number;
  side: number;
  price: number;
  amountLamports: number;
  placedAtMs: number;
};

type ActiveClobMatch = {
  duelId: string;
  duelKeyHex: string;
  duelState: PublicKey;
  marketState: PublicKey;
  vault: PublicKey;
  createdAt: number;
  lastStreamAtMs: number | null;
  lastOracleAtMs: number | null;
  lastRpcAtMs: number | null;
  lastSyncedAtMs: number | null;
  lastResolvedAtMs: number | null;
  lastClaimAtMs: number | null;
  lastQuoteSnapshot: MarketSnapshot | null;
  lastQuotePlan: QuotePlan | null;
  winner: PredictionMarketWinner;
  yesBidOrder: ManagedClobOrder | null;
  noAskOrder: ManagedClobOrder | null;
  recoveredManagedOrders: ManagedClobOrder[];
};

type ManagedOrderState = ManagedClobOrder & {
  orderBehavior: number;
  remainingLamports: number;
  previousOrderId: number;
  nextOrderId: number;
  continuationPending: boolean;
};

type ManagedClobQuoteContext = {
  snapshot: MarketSnapshot;
  yesBidOrder: ManagedOrderState | null;
  noAskOrder: ManagedOrderState | null;
};

function markRpcSuccess(trackedMatch?: ActiveClobMatch | null): number {
  const now = Date.now();
  lastSuccessfulRpcAtMs = now;
  rpcConsecutiveFailures = 0;
  rpcBlockedUntil = 0;
  if (trackedMatch) {
    trackedMatch.lastRpcAtMs = now;
  }
  return now;
}

function markStreamEvent(trackedMatch?: ActiveClobMatch | null): number {
  const now = Date.now();
  lastStreamEventAtMs = now;
  if (trackedMatch) {
    trackedMatch.lastStreamAtMs = now;
  }
  return now;
}

function buildManagedClobSignal(_snapshot: MarketSnapshot):
  | {
      signalPrice: number;
      signalWeight: number;
    }
  | {} {
  return {
    signalPrice: configuredMidPrice,
    signalWeight: 1,
  };
}

async function ensureClobVaultReady(vault: PublicKey): Promise<void> {
  const minimumLamports = await connection.getMinimumBalanceForRentExemption(
    0,
    "confirmed",
  );
  const currentLamports = await connection.getBalance(vault, "confirmed");
  if (currentLamports >= minimumLamports) {
    return;
  }

  const topUpLamports = minimumLamports - currentLamports;
  const topUpTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keeperFeePayerKeypair.publicKey,
      toPubkey: vault,
      lamports: topUpLamports,
    }),
  );
  await provider.sendAndConfirm(topUpTx, [keeperFeePayerKeypair]);
}

function buildDuelMetadata(data: DuelLifecycleEvent): string {
  return buildDuelLifecycleMetadata({
    duelId: data.duelId,
    duelKey: data.duelKeyHex,
    snapshotVersion: data.competitiveSnapshotVersion,
    snapshotDigest: data.competitiveSnapshotDigest,
  });
}

function duelStatusEnum(
  status: "scheduled" | "bettingOpen" | "locked",
): DuelStatusArg {
  if (status === "scheduled") {
    return { scheduled: {} } as DuelStatusArg;
  }
  if (status === "locked") {
    return { locked: {} } as DuelStatusArg;
  }
  return { bettingOpen: {} } as DuelStatusArg;
}

function winnerSideEnum(side: "A" | "B"): OracleWinnerArg {
  return side === "A" ? { a: {} } : { b: {} };
}

function resolvedWinnerFromDuelState(
  duelState: Record<string, unknown> | null,
): "A" | "B" | null {
  if (!duelState) {
    return null;
  }
  if (enumIs(duelState.winner, "a")) {
    return "A";
  }
  if (enumIs(duelState.winner, "b")) {
    return "B";
  }
  return null;
}

async function upsertDuelLifecycle(
  data: DuelLifecycleEvent,
  status: "scheduled" | "bettingOpen" | "locked",
): Promise<PublicKey> {
  const duelKey = duelKeyHexToBytes(data.duelKeyHex);
  const duelState = findDuelStatePda(fightProgram.programId, duelKey);
  const existingDuelState = await getDuelState(duelState);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { betOpenTs, betCloseTs, duelStartTs } = resolveDuelLifecycleTiming({
    existing: existingDuelState
      ? {
          betOpenTs: requireSafeAccountInteger(
            existingDuelState.betOpenTs,
            "existing duel bet-open timestamp",
            { min: 1 },
          ),
          betCloseTs: requireSafeAccountInteger(
            existingDuelState.betCloseTs,
            "existing duel bet-close timestamp",
            { min: 1 },
          ),
          duelStartTs: requireSafeAccountInteger(
            existingDuelState.duelStartTs,
            "existing duel start timestamp",
            { min: 1 },
          ),
        }
      : null,
    betOpenTimeMs: data.betOpenTime,
    betCloseTimeMs: data.betCloseTime,
    fightStartTimeMs: data.fightStartTime,
    nowMs: Date.now(),
  });
  const requestedStatus =
    status === "scheduled" && betOpenTs <= nowSeconds ? "bettingOpen" : status;
  const participantAHash =
    toByteArray32(existingDuelState?.participantAHash) ??
    hashParticipant(data.agent1);
  const participantBHash =
    toByteArray32(existingDuelState?.participantBHash) ??
    hashParticipant(data.agent2);
  const competitiveSnapshotDigest = Array.from(
    Buffer.from(data.competitiveSnapshotDigest, "hex"),
  );

  await runWithRecovery(
    () =>
      fightProgram.methods
        .upsertDuel(
          Array.from(duelKey),
          participantAHash,
          participantBHash,
          data.competitiveSnapshotVersion,
          competitiveSnapshotDigest,
          new BN(betOpenTs),
          new BN(betCloseTs),
          new BN(duelStartTs),
          buildDuelMetadata(data),
          duelStatusEnum(requestedStatus),
        )
        .accountsPartial({
          reporter: oracleReporterKeypair.publicKey,
          oracleConfig: oracleConfigPda,
          duelState,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracleReporterKeypair])
        .rpc(),
    connection,
  );
  markRpcSuccess();

  return duelState;
}

async function syncTrackedMarketFromOracle(
  trackedMatch: ActiveClobMatch,
): Promise<void> {
  await runWithRecovery(
    () =>
      marketProgram.methods
        .syncMarketFromDuel()
        .accountsPartial({
          marketState: trackedMatch.marketState,
          duelState: trackedMatch.duelState,
        })
        .rpc(),
    connection,
  );
  const now = markRpcSuccess(trackedMatch);
  trackedMatch.lastOracleAtMs = now;
  trackedMatch.lastSyncedAtMs = now;
}

function toManagedClobOrder(order: ManagedOrderState): ManagedClobOrder {
  return {
    orderId: order.orderId,
    side: order.side,
    price: order.price,
    amountLamports: order.amountLamports,
    placedAtMs: order.placedAtMs,
  };
}

function mapClobLifecycleStatus(
  marketState: Record<string, unknown> | null,
): MarketSnapshot["lifecycleStatus"] {
  if (!marketState) return "UNKNOWN";
  if (enumIs(marketState.status, "open")) return "OPEN";
  if (enumIs(marketState.status, "locked")) return "LOCKED";
  if (enumIs(marketState.status, "resolved")) return "RESOLVED";
  if (enumIs(marketState.status, "cancelled")) return "CANCELLED";
  return "UNKNOWN";
}

function normalizeClobBestBid(value: number): number | null {
  return value > 0 ? value : null;
}

function normalizeClobBestAsk(value: number): number | null {
  if (value <= 0 || value >= 1_000) {
    return null;
  }
  return value;
}

async function getManagedOrderState(
  trackedMatch: ActiveClobMatch,
  trackedOrder: ManagedClobOrder | null,
): Promise<ManagedOrderState | null> {
  if (!trackedOrder) {
    return null;
  }

  const orderPda = findOrderPda(
    marketProgram.programId,
    trackedMatch.marketState,
    BigInt(trackedOrder.orderId),
  );
  const orderAccount =
    await marketProgram.account.order.fetchNullable(orderPda);
  markRpcSuccess(trackedMatch);
  if (!orderAccount || !Boolean(orderAccount.active)) {
    return null;
  }

  const accountOrderId = requireSafeAccountInteger(
    orderAccount.id,
    "managed order id",
    { min: 1 },
  );
  const accountSide = requireSafeAccountInteger(
    orderAccount.side,
    "managed order side",
    { min: SIDE_BID, max: SIDE_ASK },
  );
  if (
    !(orderAccount.marketState as PublicKey).equals(trackedMatch.marketState) ||
    !(orderAccount.maker as PublicKey).equals(marketMakerKeypair.publicKey) ||
    accountOrderId !== trackedOrder.orderId ||
    accountSide !== trackedOrder.side
  ) {
    throw new Error(`managed order identity drift for ${orderPda.toBase58()}`);
  }

  const amountLamports = requireSafeAccountInteger(
    orderAccount.amount,
    "managed order amount",
    { min: 1 },
  );
  const filledLamports = requireSafeAccountInteger(
    orderAccount.filled,
    "managed order filled amount",
    { min: 0, max: amountLamports },
  );
  const remainingLamports = amountLamports - filledLamports;
  if (remainingLamports <= 0) {
    return null;
  }
  if (amountLamports % 1_000 !== 0 || filledLamports % 1_000 !== 0) {
    throw new Error(`managed order lot-size drift for ${orderPda.toBase58()}`);
  }
  const price = requireSafeAccountInteger(
    orderAccount.price,
    "managed order price",
    { min: 1, max: 999 },
  );
  if (price !== trackedOrder.price) {
    throw new Error(`managed order price drift for ${orderPda.toBase58()}`);
  }
  const orderBehavior = requireSafeAccountInteger(
    orderAccount.orderBehavior,
    "managed order behavior",
    { min: 0, max: 2 },
  );
  const previousOrderId = requireSafeAccountInteger(
    orderAccount.prevOrderId,
    "managed previous order id",
    { min: 0 },
  );
  const nextOrderId = requireSafeAccountInteger(
    orderAccount.nextOrderId,
    "managed next order id",
    { min: 0 },
  );
  const continuationPending = Boolean(orderAccount.continuationPending);
  if (continuationPending && filledLamports !== 0) {
    throw new Error(
      `managed continuation order retained fills for ${orderPda.toBase58()}`,
    );
  }

  return {
    orderId: trackedOrder.orderId,
    side: trackedOrder.side,
    price,
    orderBehavior,
    amountLamports,
    placedAtMs: trackedOrder.placedAtMs,
    remainingLamports,
    previousOrderId,
    nextOrderId,
    continuationPending,
  };
}

async function buildManagedClobQuoteContext(
  trackedMatch: ActiveClobMatch,
  marketState: Record<string, unknown> | null,
  now = Date.now(),
): Promise<ManagedClobQuoteContext> {
  const [duelState, userBalance, yesBidOrder, noAskOrder] = await Promise.all([
    getDuelState(trackedMatch.duelState),
    marketProgram.account.userBalance.fetchNullable(
      findUserBalancePda(
        marketProgram.programId,
        trackedMatch.marketState,
        marketMakerKeypair.publicKey,
      ),
    ),
    getManagedOrderState(trackedMatch, trackedMatch.yesBidOrder),
    getManagedOrderState(trackedMatch, trackedMatch.noAskOrder),
  ]);

  const activeOrders = [yesBidOrder, noAskOrder].filter(
    (order): order is ManagedOrderState => order !== null,
  );
  const quoteAgeMs =
    activeOrders.length > 0
      ? now - Math.min(...activeOrders.map((order) => order.placedAtMs))
      : null;
  const bestBid = marketState
    ? requireSafeAccountInteger(marketState.bestBid, "market best bid", {
        min: 0,
        max: 999,
      })
    : 0;
  const bestAsk = marketState
    ? requireSafeAccountInteger(marketState.bestAsk, "market best ask", {
        min: 1,
        max: 1_000,
      })
    : 1_000;
  const betCloseTs = duelState
    ? requireSafeAccountInteger(
        duelState.betCloseTs,
        "managed quote duel bet-close timestamp",
        { min: 1, max: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) },
      )
    : null;
  const yesExposure = userBalance
    ? requireSafeAccountInteger(
        userBalance.aShares,
        "market-maker A-share exposure",
        { min: 0 },
      )
    : 0;
  const noExposure = userBalance
    ? requireSafeAccountInteger(
        userBalance.bShares,
        "market-maker B-share exposure",
        { min: 0 },
      )
    : 0;

  return {
    snapshot: {
      chainKey: "solana",
      lifecycleStatus: mapClobLifecycleStatus(marketState),
      duelKey: trackedMatch.duelKeyHex,
      marketRef: trackedMatch.marketState.toBase58(),
      bestBid: normalizeClobBestBid(bestBid),
      bestAsk: normalizeClobBestAsk(bestAsk),
      betCloseTimeMs: betCloseTs === null ? null : betCloseTs * 1_000,
      lastStreamAtMs: trackedMatch.lastStreamAtMs ?? lastStreamEventAtMs ?? now,
      lastOracleAtMs: trackedMatch.lastOracleAtMs ?? now,
      lastRpcAtMs: trackedMatch.lastRpcAtMs ?? lastSuccessfulRpcAtMs ?? now,
      quoteAgeMs,
      exposure: {
        yes: yesExposure,
        no: noExposure,
        openYes: yesBidOrder?.remainingLamports ?? 0,
        openNo: noAskOrder?.remainingLamports ?? 0,
      },
    },
    yesBidOrder,
    noAskOrder,
  };
}

async function refreshManagedClobHealth(
  trackedMatch: ActiveClobMatch,
  marketState: Record<string, unknown> | null,
  now = Date.now(),
): Promise<{ quoteContext: ManagedClobQuoteContext; plan: QuotePlan }> {
  const quoteContext = await buildManagedClobQuoteContext(
    trackedMatch,
    marketState,
    now,
  );
  const planningSnapshot = buildClobQuotePlanningSnapshot(
    quoteContext.snapshot,
  );
  const rawPlan = buildQuotePlan(
    planningSnapshot,
    buildManagedClobSignal(quoteContext.snapshot),
    managedClobQuoteConfig,
    now,
  );
  const plan: QuotePlan = {
    ...rawPlan,
    bidUnits: quantizeClobOrderLamports(rawPlan.bidUnits),
    askUnits: quantizeClobOrderLamports(rawPlan.askUnits),
  };
  trackedMatch.lastQuoteSnapshot = quoteContext.snapshot;
  trackedMatch.lastQuotePlan = plan;
  trackedMatch.lastSyncedAtMs = now;
  trackedMatch.lastStreamAtMs =
    quoteContext.snapshot.lastStreamAtMs ?? trackedMatch.lastStreamAtMs;
  trackedMatch.lastOracleAtMs =
    quoteContext.snapshot.lastOracleAtMs ?? trackedMatch.lastOracleAtMs;
  trackedMatch.lastRpcAtMs =
    quoteContext.snapshot.lastRpcAtMs ?? trackedMatch.lastRpcAtMs;
  return { quoteContext, plan };
}

async function cancelManagedClobOrder(
  trackedMatch: ActiveClobMatch,
  trackedOrder: ManagedOrderState,
  reason: string,
): Promise<void> {
  const order = findOrderPda(
    marketProgram.programId,
    trackedMatch.marketState,
    BigInt(trackedOrder.orderId),
  );
  const priceLevel = findPriceLevelPda(
    marketProgram.programId,
    trackedMatch.marketState,
    trackedOrder.side,
    trackedOrder.price,
  );
  const [marketState, priceLevelAccount] = await Promise.all([
    getClobMarketState(trackedMatch.marketState),
    marketProgram.account.priceLevel.fetchNullable(priceLevel),
  ]);
  if (!marketState) {
    throw new Error(
      `cannot recover managed order ${trackedOrder.orderId}: market is missing`,
    );
  }
  let decodedPriceLevel: ManagedOrderClosurePriceLevel | null = null;
  if (priceLevelAccount) {
    const levelSide = requireSafeAccountInteger(
      priceLevelAccount.side,
      "managed price-level side",
      { min: SIDE_BID, max: SIDE_ASK },
    );
    const levelPrice = requireSafeAccountInteger(
      priceLevelAccount.price,
      "managed price-level price",
      { min: 1, max: 999 },
    );
    const priceLevelTotalOpen = requireSafeAccountInteger(
      priceLevelAccount.totalOpen,
      "managed price-level open amount",
      { min: 0 },
    );
    if (
      !(priceLevelAccount.marketState as PublicKey).equals(
        trackedMatch.marketState,
      ) ||
      levelSide !== trackedOrder.side ||
      levelPrice !== trackedOrder.price
    ) {
      throw new Error(
        `cannot recover managed order ${trackedOrder.orderId}: price level is missing or inconsistent`,
      );
    }
    decodedPriceLevel = {
      headOrderId: requireSafeAccountInteger(
        priceLevelAccount.headOrderId,
        "managed price-level head order id",
        { min: 0 },
      ),
      tailOrderId: requireSafeAccountInteger(
        priceLevelAccount.tailOrderId,
        "managed price-level tail order id",
        { min: 0 },
      ),
      totalOpen: priceLevelTotalOpen,
    };
  }
  const closurePriceLevel = resolveManagedOrderClosurePriceLevel({
    continuationPending: trackedOrder.continuationPending,
    priceLevel: decodedPriceLevel,
  });
  const marketIsOpen = enumIs(marketState.status, "open");
  const closurePlan = planManagedOrderClosure({
    marketIsOpen,
    orderId: trackedOrder.orderId,
    orderBehavior: trackedOrder.orderBehavior,
    remainingAmount: trackedOrder.remainingLamports,
    previousOrderId: trackedOrder.previousOrderId,
    nextOrderId: trackedOrder.nextOrderId,
    priceLevelHeadOrderId: closurePriceLevel.headOrderId,
    priceLevelTailOrderId: closurePriceLevel.tailOrderId,
    priceLevelTotalOpen: closurePriceLevel.totalOpen,
    continuationPending: trackedOrder.continuationPending,
  });
  const remainingAccounts = closurePlan.adjacentOrderIds.map((orderId) => ({
    pubkey: findOrderPda(
      marketProgram.programId,
      trackedMatch.marketState,
      BigInt(orderId),
    ),
    isSigner: false,
    isWritable: true,
  }));

  await runWithRecovery(() => {
    const method =
      closurePlan.instruction === "cancel"
        ? marketProgram.methods.cancelOrder(
            new BN(trackedOrder.orderId),
            trackedOrder.side,
            trackedOrder.price,
          )
        : marketProgram.methods.reclaimRestingOrder(
            new BN(trackedOrder.orderId),
            trackedOrder.side,
            trackedOrder.price,
          );
    return method
      .accountsPartial({
        marketState: trackedMatch.marketState,
        duelState: trackedMatch.duelState,
        order,
        priceLevel,
        vault: trackedMatch.vault,
        user: marketMakerKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .signers([marketMakerKeypair])
      .rpc();
  }, connection);

  console.log(
    `[bot] ${marketIsOpen ? "Cancelled" : "Reclaimed"} ${
      trackedOrder.side === SIDE_BID ? "A-bid" : "B-ask"
    } liquidity for ${trackedMatch.marketState.toBase58()} orderId=${
      trackedOrder.orderId
    } price=${trackedOrder.price} reason=${reason}`,
  );
}

async function cancelManagedClobQuotes(
  trackedMatch: ActiveClobMatch,
  reason: string,
): Promise<void> {
  const candidates = [
    ...trackedMatch.recoveredManagedOrders,
    trackedMatch.yesBidOrder,
    trackedMatch.noAskOrder,
  ].filter((order): order is ManagedClobOrder => order !== null);
  const processedOrderIds = new Set<number>();

  for (const candidate of candidates) {
    if (processedOrderIds.has(candidate.orderId)) continue;
    processedOrderIds.add(candidate.orderId);

    const activeOrder = await getManagedOrderState(trackedMatch, candidate);
    if (activeOrder) {
      await cancelManagedClobOrder(trackedMatch, activeOrder, reason);
    }
    trackedMatch.recoveredManagedOrders =
      trackedMatch.recoveredManagedOrders.filter(
        (order) => order.orderId !== candidate.orderId,
      );
    if (trackedMatch.yesBidOrder?.orderId === candidate.orderId) {
      trackedMatch.yesBidOrder = null;
    }
    if (trackedMatch.noAskOrder?.orderId === candidate.orderId) {
      trackedMatch.noAskOrder = null;
    }
  }
}

async function placeManagedClobOrder(
  trackedMatch: ActiveClobMatch,
  side: number,
  price: number,
  amountLamports: number,
): Promise<ManagedClobOrder> {
  if (!isValidClobOrderLamports(amountLamports)) {
    throw new Error(
      `refusing non-executable CLOB order amount ${amountLamports}`,
    );
  }
  const marketState = await getClobMarketState(trackedMatch.marketState);
  if (!marketState || !enumIs(marketState.status, "open")) {
    throw new Error(
      `Cannot seed closed market ${trackedMatch.marketState.toBase58()}`,
    );
  }

  const orderId = requireSafeAccountInteger(
    marketState.nextOrderId,
    "market next order id",
    { min: 1 },
  );
  const userBalance = findUserBalancePda(
    marketProgram.programId,
    trackedMatch.marketState,
    marketMakerKeypair.publicKey,
  );
  const newOrder = findOrderPda(
    marketProgram.programId,
    trackedMatch.marketState,
    BigInt(orderId),
  );
  const restingLevel = findPriceLevelPda(
    marketProgram.programId,
    trackedMatch.marketState,
    side,
    price,
  );
  const restingLevelAccount =
    await marketProgram.account.priceLevel.fetchNullable(restingLevel);
  markRpcSuccess(trackedMatch);
  let restingTailOrderId = 0;
  if (restingLevelAccount) {
    const restingLevelSide = requireSafeAccountInteger(
      restingLevelAccount.side,
      "resting price-level side",
      { min: SIDE_BID, max: SIDE_ASK },
    );
    const restingLevelPrice = requireSafeAccountInteger(
      restingLevelAccount.price,
      "resting price-level price",
      { min: 1, max: 999 },
    );
    if (
      !(restingLevelAccount.marketState as PublicKey).equals(
        trackedMatch.marketState,
      ) ||
      restingLevelSide !== side ||
      restingLevelPrice !== price
    ) {
      throw new Error(
        `refusing to place managed order ${orderId}: resting price level is inconsistent`,
      );
    }
    restingTailOrderId = requireSafeAccountInteger(
      restingLevelAccount.tailOrderId,
      "resting price-level tail order id",
      { min: 0 },
    );
  }
  const remainingAccounts =
    restingTailOrderId > 0
      ? [
          {
            pubkey: findOrderPda(
              marketProgram.programId,
              trackedMatch.marketState,
              BigInt(restingTailOrderId),
            ),
            isSigner: false,
            isWritable: true,
          },
        ]
      : [];

  await runWithRecovery(
    () =>
      marketProgram.methods
        .placeOrder(
          new BN(orderId),
          side,
          price,
          new BN(amountLamports),
          ORDER_BEHAVIOR_POST_ONLY,
        )
        .accountsPartial({
          marketState: trackedMatch.marketState,
          duelState: trackedMatch.duelState,
          userBalance,
          newOrder,
          restingLevel,
          config: marketConfigPda,
          treasury: marketState.treasury as PublicKey,
          marketMaker: marketState.marketMaker as PublicKey,
          vault: trackedMatch.vault,
          user: marketMakerKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(remainingAccounts)
        .signers([marketMakerKeypair])
        .rpc(),
    connection,
  );

  console.log(
    `[bot] Seeded ${side === SIDE_BID ? "A-bid" : "B-ask"} liquidity for ${trackedMatch.marketState.toBase58()} orderId=${orderId} price=${price} amountLamports=${amountLamports}`,
  );

  return {
    orderId,
    side,
    price,
    amountLamports,
    placedAtMs: Date.now(),
  };
}

async function ensureManagedClobOrder(
  trackedMatch: ActiveClobMatch,
  side: "yesBidOrder" | "noAskOrder",
): Promise<void> {
  const marketState = await getClobMarketState(trackedMatch.marketState);
  if (!marketState || !enumIs(marketState.status, "open")) {
    trackedMatch[side] = null;
    return;
  }

  const now = Date.now();
  const { quoteContext, plan } = await refreshManagedClobHealth(
    trackedMatch,
    marketState,
    now,
  );
  trackedMatch.yesBidOrder = quoteContext.yesBidOrder
    ? toManagedClobOrder(quoteContext.yesBidOrder)
    : null;
  trackedMatch.noAskOrder = quoteContext.noAskOrder
    ? toManagedClobOrder(quoteContext.noAskOrder)
    : null;
  const activeOrder =
    side === "yesBidOrder" ? quoteContext.yesBidOrder : quoteContext.noAskOrder;
  const decision = evaluateQuoteDecision(
    side === "yesBidOrder" ? "BID" : "ASK",
    plan,
    activeOrder
      ? {
          price: activeOrder.price,
          units: activeOrder.remainingLamports,
          placedAtMs: activeOrder.placedAtMs,
        }
      : null,
    managedClobQuoteConfig,
    now,
  );

  if (activeOrder && decision.shouldCancel) {
    await cancelManagedClobOrder(
      trackedMatch,
      activeOrder,
      decision.reason ?? "quote-refresh",
    );
    trackedMatch[side] = null;
  } else if (activeOrder && decision.shouldKeep) {
    trackedMatch[side] = toManagedClobOrder(activeOrder);
    return;
  }

  if (
    !decision.shouldPlace ||
    decision.targetPrice == null ||
    decision.targetUnits <= 0
  ) {
    trackedMatch[side] = null;
    return;
  }

  try {
    trackedMatch[side] = await placeManagedClobOrder(
      trackedMatch,
      side === "yesBidOrder" ? SIDE_BID : SIDE_ASK,
      decision.targetPrice,
      decision.targetUnits,
    );
  } catch (error) {
    const disposition = classifyManagedLiquiditySubmissionError(error);
    if (!disposition) throw error;
    trackedMatch[side] = null;
    console.info(
      `[bot] Skipped stale managed ${side === "yesBidOrder" ? "A-bid" : "B-ask"} for ${trackedMatch.marketState.toBase58()} (${disposition}); refreshing next cycle`,
    );
  }
}

async function createOrSyncRound(
  data: DuelLifecycleEvent,
): Promise<ActiveClobMatch> {
  const duelState = await upsertDuelLifecycle(data, "bettingOpen");
  const marketState = findMarketPda(
    marketProgram.programId,
    duelState,
    DUEL_WINNER_MARKET_KIND,
  );
  const vault = findClobVaultPda(marketProgram.programId, marketState);
  const duelKey = duelKeyHexToBytes(data.duelKeyHex);

  await ensureIdempotentAccountInitialized({
    isInitialized: async () =>
      (await connection.getAccountInfo(marketState, "confirmed")) != null,
    submit: async () => {
      await runWithRecovery(
        () =>
          marketProgram.methods
            .initializeMarket(Array.from(duelKey), DUEL_WINNER_MARKET_KIND)
            .accountsPartial({
              operator: clobMarketOperatorKeypair.publicKey,
              config: marketConfigPda,
              duelState,
              marketState,
              vault,
              systemProgram: SystemProgram.programId,
            })
            .signers([clobMarketOperatorKeypair])
            .rpc(),
        connection,
        marketInitializationRecoveryTimeoutMs,
      );
    },
    maxAttempts: marketInitializationMaxAttempts,
    retryDelayMs: marketInitializationRetryDelayMs,
    onRetry: ({ attempt, maxAttempts, error }) => {
      console.warn(
        `[bot] Market initialization was not confirmed for duel ${data.duelId}; retrying deterministic account initialization (${attempt + 1}/${maxAttempts}): ${sanitizeErrorMessage(error)}`,
      );
    },
  });

  const trackedMatch: ActiveClobMatch = {
    duelId: data.duelId,
    duelKeyHex: data.duelKeyHex,
    duelState,
    marketState,
    vault,
    createdAt: Date.now(),
    lastStreamAtMs: Date.now(),
    lastOracleAtMs: null,
    lastRpcAtMs: null,
    lastSyncedAtMs: null,
    lastResolvedAtMs: null,
    lastClaimAtMs: null,
    lastQuoteSnapshot: null,
    lastQuotePlan: null,
    winner: "NONE",
    yesBidOrder: null,
    noAskOrder: null,
    recoveredManagedOrders: [],
  };
  await syncTrackedMarketFromOracle(trackedMatch);

  console.log(
    `[bot] Duel market ready duel=${data.duelId} duelState=${duelState.toBase58()} market=${marketState.toBase58()}`,
  );
  return trackedMatch;
}

async function lockRound(data: DuelLifecycleEvent): Promise<void> {
  const trackedMatch = activeClobMatches.get(data.duelId);
  if (!trackedMatch) {
    if (
      data.outcome === "win" ||
      data.outcome === "draw" ||
      data.outcome === "cancelled"
    ) {
      return;
    }
    throw new Error(`cannot lock untracked duel ${data.duelId}`);
  }

  const duelState = await getDuelState(trackedMatch.duelState);
  const oracleState = solanaOracleCancellationState(duelState);
  const lockAction = classifyOracleLock(oracleState);
  if (lockAction === "fail_closed") {
    throw new Error(
      `cannot safely lock duel ${data.duelId}: Solana oracle state is ${oracleState}`,
    );
  }
  if (lockAction === "lock") {
    if (!duelState) {
      throw new Error(
        `cannot safely lock duel ${data.duelId}: Solana oracle account is missing`,
      );
    }
    await waitForConfirmedChainTimestamp(
      requireSafeAccountInteger(
        duelState.betCloseTs,
        "duel lock bet-close timestamp",
        { min: 1 },
      ),
      `cannot lock duel ${data.duelId}`,
    );
    await upsertDuelLifecycle(data, "locked");
  }
  await syncTrackedMarketFromOracle(trackedMatch);
}

async function maybeWarnUnresolvedDuel(
  trackedMatch: ActiveClobMatch,
): Promise<void> {
  const duelState = await getDuelState(trackedMatch.duelState);
  if (!duelState || !enumIs(duelState.status, "locked")) {
    unresolvedOracleWarningMatches.delete(trackedMatch.duelId);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const betCloseTs = requireSafeAccountInteger(
    duelState.betCloseTs,
    "unresolved duel bet-close timestamp",
    { min: 1 },
  );
  if (now < betCloseTs) {
    return;
  }
  if (unresolvedOracleWarningMatches.has(trackedMatch.duelId)) {
    return;
  }

  unresolvedOracleWarningMatches.add(trackedMatch.duelId);
  console.warn(
    `[Keeper] Duel ${trackedMatch.duelId} is locked and past bet close but unresolved. Waiting for authoritative game result.`,
  );
}

async function maybeSeedMarket(trackedMatch: ActiveClobMatch): Promise<void> {
  if (trackedMatch.recoveredManagedOrders.length > 0) {
    await cancelManagedClobQuotes(trackedMatch, "restart-recovery");
  }
  if (
    lastSuccessfulMarketDiscoveryAtMs == null ||
    marketDiscoveryErrorAtMs != null ||
    marketRecoveryIssues.length > 0
  ) {
    return;
  }
  if (Date.now() - trackedMatch.createdAt < autoSeedDelayMs) {
    return;
  }

  const marketState = await getClobMarketState(trackedMatch.marketState);
  if (!marketState || !enumIs(marketState.status, "open")) {
    return;
  }

  await ensureClobVaultReady(trackedMatch.vault);
  await ensureManagedClobOrder(trackedMatch, "noAskOrder");
  await ensureManagedClobOrder(trackedMatch, "yesBidOrder");
}

const activeClobMatches = new Map<string, ActiveClobMatch>();
const unresolvedOracleWarningMatches = new Set<string>();
const settledClobHealth = new Map<string, KeeperMarketHealthRecord>();
const ORDER_MAKER_MEMCMP_OFFSET = 52;
const ORDER_ACTIVE_MEMCMP_OFFSET = 116;
const ACTIVE_ORDER_MEMCMP_BYTES = bs58.encode(Uint8Array.of(1));

function summarizeMarketRecoveryIssues(
  issues: MarketRecoveryIssue[],
): string | null {
  if (issues.length === 0) return null;
  const preview = issues
    .slice(0, 5)
    .map(
      (entry) =>
        `${entry.code}:${entry.duelRef ?? entry.marketRef ?? "unknown"} (${entry.details})`,
    )
    .join("; ");
  return issues.length > 5
    ? `${preview}; ${issues.length - 5} additional issue(s)`
    : preview;
}

function hydrateRecoveredMarket(
  recovered: ReturnType<typeof discoverDuelMarketRecovery>["markets"][number],
  observedAt: number,
): number {
  const existing = activeClobMatches.get(recovered.duelId);
  if (existing) {
    if (
      existing.duelKeyHex !== recovered.duelKeyHex ||
      !existing.duelState.equals(recovered.duelState) ||
      !existing.marketState.equals(recovered.marketState)
    ) {
      throw new Error(
        `on-chain discovery conflicts with tracked duel ${recovered.duelId}`,
      );
    }
    const knownOrderIds = new Set(
      [
        existing.yesBidOrder,
        existing.noAskOrder,
        ...existing.recoveredManagedOrders,
      ]
        .filter((order): order is ManagedClobOrder => order !== null)
        .map((order) => order.orderId),
    );
    const newlyRecovered = recovered.managedOrders.filter(
      (order) => !knownOrderIds.has(order.orderId),
    );
    existing.recoveredManagedOrders.push(...newlyRecovered);
    existing.lastOracleAtMs = observedAt;
    existing.lastRpcAtMs = observedAt;
    return newlyRecovered.length;
  }

  activeClobMatches.set(recovered.duelId, {
    duelId: recovered.duelId,
    duelKeyHex: recovered.duelKeyHex,
    duelState: recovered.duelState,
    marketState: recovered.marketState,
    vault: recovered.vault,
    createdAt: recovered.createdAtMs,
    lastStreamAtMs: null,
    lastOracleAtMs: observedAt,
    lastRpcAtMs: observedAt,
    lastSyncedAtMs: null,
    lastResolvedAtMs:
      recovered.oracleStatus === "resolved" ||
      recovered.oracleStatus === "cancelled"
        ? observedAt
        : null,
    lastClaimAtMs: null,
    lastQuoteSnapshot: null,
    lastQuotePlan: null,
    winner: recovered.winner,
    yesBidOrder: null,
    noAskOrder: null,
    recoveredManagedOrders: [...recovered.managedOrders],
  });
  return recovered.managedOrders.length;
}

async function performOnChainMarketDiscovery(): Promise<void> {
  const observedAt = Date.now();
  lastMarketDiscoveryAtMs = observedAt;
  try {
    const [duelAccounts, marketAccounts, orderAccounts] = await Promise.all([
      fightProgram.account.duelState.all(),
      marketProgram.account.marketState.all(),
      marketProgram.account.order.all([
        {
          memcmp: {
            offset: ORDER_MAKER_MEMCMP_OFFSET,
            bytes: marketMakerKeypair.publicKey.toBase58(),
          },
        },
        {
          memcmp: {
            offset: ORDER_ACTIVE_MEMCMP_OFFSET,
            bytes: ACTIVE_ORDER_MEMCMP_BYTES,
          },
        },
      ]),
    ]);
    const result = discoverDuelMarketRecovery({
      fightProgramId: fightProgram.programId,
      marketProgramId: marketProgram.programId,
      duelAccounts: duelAccounts as unknown as ProgramAccountSnapshot[],
      marketAccounts: marketAccounts as unknown as ProgramAccountSnapshot[],
      orderAccounts: orderAccounts as unknown as ProgramAccountSnapshot[],
      allowedMarketAuthorities: [clobMarketOperatorKeypair.publicKey],
      marketMaker: marketMakerKeypair.publicKey,
      expectedFees: {
        tradeTreasuryFeeBps,
        tradeMarketMakerFeeBps,
        winningsMarketMakerFeeBps,
      },
      observedAt,
    });

    let recoveredMarketCount = 0;
    let restartRecoveredMarketCount = 0;
    let recoveredOrderCount = 0;
    for (const recovered of result.markets) {
      const alreadyTracked = activeClobMatches.has(recovered.duelId);
      if (!alreadyTracked) {
        recoveredMarketCount += 1;
      }
      if (requiresRestartMarketReconciliation(recovered, alreadyTracked)) {
        restartRecoveredMarketCount += 1;
      }
      recoveredOrderCount += hydrateRecoveredMarket(recovered, observedAt);
    }
    marketRecoveryIssues = result.issues;
    marketRecoveryIssueObservedAtMs =
      result.issues.length > 0
        ? (marketRecoveryIssueObservedAtMs ?? observedAt)
        : null;
    lastSuccessfulMarketDiscoveryAtMs = observedAt;
    marketDiscoveryErrorAtMs = null;
    marketDiscoveryErrorDetails = null;
    markRpcSuccess();

    if (restartRecoveredMarketCount > 0 || recoveredOrderCount > 0) {
      restartRecoveryObservedAtMs = restartRecoveryObservedAtMs ?? observedAt;
      restartRecoveryDetails = `recovered ${restartRecoveredMarketCount} active canonical on-chain duel market(s) and ${recoveredOrderCount} previously untracked active market-maker order(s)`;
    }
    console.log(
      `[bot] On-chain market discovery found ${result.markets.length} canonical market(s), ${recoveredOrderCount} untracked active order(s), and ${result.issues.length} issue(s)`,
    );
  } catch (error) {
    marketDiscoveryErrorAtMs = observedAt;
    marketDiscoveryErrorDetails = sanitizeErrorMessage(error);
    throw error;
  }
}

async function ensureOnChainMarketDiscovery(force = false): Promise<void> {
  if (marketDiscoveryInFlight) {
    await marketDiscoveryInFlight;
    return;
  }
  if (
    !force &&
    lastMarketDiscoveryAtMs > 0 &&
    Date.now() - lastMarketDiscoveryAtMs < marketDiscoveryIntervalMs
  ) {
    return;
  }
  marketDiscoveryInFlight = performOnChainMarketDiscovery();
  try {
    await marketDiscoveryInFlight;
  } finally {
    marketDiscoveryInFlight = null;
  }
}

function clearCompletedRestartRecovery(): void {
  if (
    lastSuccessfulMarketDiscoveryAtMs != null &&
    marketDiscoveryErrorAtMs == null &&
    marketRecoveryIssues.length === 0 &&
    Array.from(activeClobMatches.values()).every(
      (trackedMatch) => trackedMatch.recoveredManagedOrders.length === 0,
    )
  ) {
    restartRecoveryObservedAtMs = null;
    restartRecoveryDetails = null;
  }
}

function loadPreviousBotHealthSnapshot(): KeeperBotHealthSnapshot | null {
  if (!BOT_HEALTH_FILE || !fs_node.existsSync(BOT_HEALTH_FILE)) {
    return null;
  }
  try {
    const snapshot = parseKeeperBotHealthSnapshot(
      JSON.parse(fs_node.readFileSync(BOT_HEALTH_FILE, "utf8")),
    );
    if (!snapshot) {
      console.warn("[bot] Ignoring invalid previous bot health snapshot");
    }
    return snapshot;
  } catch (error) {
    console.warn("[bot] Failed to read previous bot health snapshot:", error);
    return null;
  }
}

const previousBotHealthSnapshot = loadPreviousBotHealthSnapshot();
if (
  previousBotHealthSnapshot?.markets.some((market) => market.openOrderCount > 0)
) {
  restartRecoveryObservedAtMs = Date.now();
  restartRecoveryDetails = `previous snapshot recorded open orders in ${previousBotHealthSnapshot.markets
    .filter((market) => market.openOrderCount > 0)
    .map(
      (market) =>
        market.marketRef ?? market.duelKey ?? market.duelId ?? "unknown",
    )
    .join(", ")}`;
}

function trimSettledClobHealth(now = Date.now()): void {
  for (const [duelId, record] of settledClobHealth.entries()) {
    const referenceTime =
      record.lastClaimAtMs ??
      record.lastResolvedAtMs ??
      record.lastOracleAtMs ??
      0;
    if (referenceTime > 0 && now - referenceTime > MARKET_HEALTH_RETENTION_MS) {
      settledClobHealth.delete(duelId);
    }
  }
}

function buildTrackedMatchRecovery(
  trackedMatch: ActiveClobMatch,
  snapshot: MarketSnapshot | null,
  grossExposure: number,
): string[] {
  const recovery: string[] = [];
  if (unresolvedOracleWarningMatches.has(trackedMatch.duelId)) {
    recovery.push("awaiting-authoritative-result");
  }
  if (
    trackedMatch.lastResolvedAtMs != null &&
    trackedMatch.lastClaimAtMs == null &&
    grossExposure > 0
  ) {
    recovery.push("partial-claim");
  }
  if (
    restartRecoveryObservedAtMs != null &&
    (trackedMatch.yesBidOrder != null ||
      trackedMatch.noAskOrder != null ||
      trackedMatch.recoveredManagedOrders.length > 0)
  ) {
    recovery.push("restart-open-orders");
  }
  if (snapshot?.lifecycleStatus === "LOCKED" && grossExposure > 0) {
    recovery.push("position-reconcile-pending");
  }
  return recovery;
}

function buildManagedClobHealthRecord(
  trackedMatch: ActiveClobMatch,
  lifecycleStatusOverride?: MarketSnapshot["lifecycleStatus"],
): KeeperMarketHealthRecord {
  const snapshot = trackedMatch.lastQuoteSnapshot;
  const plan = trackedMatch.lastQuotePlan;
  const inventoryYes = snapshot?.exposure.yes ?? 0;
  const inventoryNo = snapshot?.exposure.no ?? 0;
  const recoveredOpenYes = trackedMatch.recoveredManagedOrders
    .filter((order) => order.side === SIDE_BID)
    .reduce((sum, order) => sum + order.amountLamports, 0);
  const recoveredOpenNo = trackedMatch.recoveredManagedOrders
    .filter((order) => order.side === SIDE_ASK)
    .reduce((sum, order) => sum + order.amountLamports, 0);
  const openYes = (snapshot?.exposure.openYes ?? 0) + recoveredOpenYes;
  const openNo = (snapshot?.exposure.openNo ?? 0) + recoveredOpenNo;
  const grossExposure = inventoryYes + inventoryNo + openYes + openNo;
  const openOrderIds = new Set(
    [
      trackedMatch.yesBidOrder,
      trackedMatch.noAskOrder,
      ...trackedMatch.recoveredManagedOrders,
    ]
      .filter((order): order is ManagedClobOrder => order !== null)
      .map((order) => order.orderId),
  );
  return {
    chainKey: "solana",
    duelId: trackedMatch.duelId,
    duelKey: trackedMatch.duelKeyHex,
    correlationId: buildDuelCorrelationId({
      duelId: trackedMatch.duelId,
      duelKey: trackedMatch.duelKeyHex,
    }),
    marketRef: trackedMatch.marketState.toBase58(),
    lifecycleStatus:
      lifecycleStatusOverride ?? snapshot?.lifecycleStatus ?? "UNKNOWN",
    winner: trackedMatch.winner,
    fairValue: plan?.fairValue ?? null,
    bidPrice: plan?.bidPrice ?? null,
    askPrice: plan?.askPrice ?? null,
    bidUnits: plan?.bidUnits ?? 0,
    askUnits: plan?.askUnits ?? 0,
    openOrderCount: openOrderIds.size,
    inventoryYes,
    inventoryNo,
    openYes,
    openNo,
    netExposure: inventoryYes + openYes - (inventoryNo + openNo),
    grossExposure,
    drawdownBps: plan?.risk.drawdownBps ?? snapshot?.exposure.drawdownBps ?? 0,
    quoteAgeMs: snapshot?.quoteAgeMs ?? null,
    lastStreamAtMs: trackedMatch.lastStreamAtMs ?? lastStreamEventAtMs ?? null,
    lastOracleAtMs: trackedMatch.lastOracleAtMs,
    lastRpcAtMs: trackedMatch.lastRpcAtMs ?? lastSuccessfulRpcAtMs,
    circuitBreakerReason: plan?.risk.circuitBreaker.reason ?? null,
    lastResolvedAtMs: trackedMatch.lastResolvedAtMs,
    lastClaimAtMs: trackedMatch.lastClaimAtMs,
    recovery: buildTrackedMatchRecovery(trackedMatch, snapshot, grossExposure),
  };
}

async function captureSettledClobHealth(
  trackedMatch: ActiveClobMatch,
  lifecycleStatus: MarketSnapshot["lifecycleStatus"],
): Promise<void> {
  const marketState = await getClobMarketState(trackedMatch.marketState);
  const now = Date.now();
  await refreshManagedClobHealth(trackedMatch, marketState, now);
  trackedMatch.lastResolvedAtMs = now;
  trackedMatch.yesBidOrder = null;
  trackedMatch.noAskOrder = null;
  trackedMatch.recoveredManagedOrders = [];
  settledClobHealth.set(
    trackedMatch.duelId,
    buildManagedClobHealthRecord(trackedMatch, lifecycleStatus),
  );
  trimSettledClobHealth(now);
}

function buildBotRecoveryStates(now = Date.now()): KeeperRecoveryState[] {
  const terminalSummary = terminalLedger.getSummary();
  const feedCheckpoint = terminalLedger.getBettingFeedCheckpoint();
  const pendingTerminalCount =
    terminalSummary.PENDING + terminalSummary.PROCESSING;
  const terminalOperations = terminalLedger.listOperationCorrelations(
    ["PENDING", "PROCESSING", "MANUAL_REVIEW", "DEAD_LETTER"],
    64,
  );
  const terminalCorrelations = (
    ...statuses: TerminalOperationRecord["status"][]
  ) =>
    normalizeDuelCorrelationIds(
      terminalOperations
        .filter((operation) => statuses.includes(operation.status))
        .map((operation) => operation.correlationId),
    );
  const correlationForDuel = (duelId: string): string | null => {
    const trackedMatch = activeClobMatches.get(duelId);
    if (trackedMatch) {
      return buildDuelCorrelationId({
        duelId: trackedMatch.duelId,
        duelKey: trackedMatch.duelKeyHex,
      });
    }
    return terminalLedger.getByDuelId(duelId)?.correlationId ?? null;
  };
  const recoveryDuelRefs = new Set(
    marketRecoveryIssues.map((issue) => issue.duelRef),
  );
  const marketRecoveryCorrelations = normalizeDuelCorrelationIds(
    [...activeClobMatches.values()]
      .filter((trackedMatch) =>
        recoveryDuelRefs.has(trackedMatch.duelState.toBase58()),
      )
      .map((trackedMatch) =>
        buildDuelCorrelationId({
          duelId: trackedMatch.duelId,
          duelKey: trackedMatch.duelKeyHex,
        }),
      ),
  );
  const awaitingResultCorrelations = normalizeDuelCorrelationIds(
    [...unresolvedOracleWarningMatches]
      .map(correlationForDuel)
      .filter((value): value is string => value !== null),
  );
  return [
    {
      code: "feed-continuity",
      active: Boolean(feedCheckpoint?.degradedReason),
      sinceMs: feedCheckpoint?.degradedReason ? feedCheckpoint.updatedAt : null,
      untilMs: null,
      details: feedCheckpoint?.degradedReason ?? null,
    },
    {
      code: "market-discovery",
      active:
        lastSuccessfulMarketDiscoveryAtMs == null ||
        marketDiscoveryErrorAtMs != null,
      sinceMs:
        marketDiscoveryErrorAtMs ??
        (lastSuccessfulMarketDiscoveryAtMs == null ? botBootedAtMs : null),
      untilMs: null,
      details:
        marketDiscoveryErrorDetails ??
        (lastSuccessfulMarketDiscoveryAtMs == null
          ? "initial on-chain duel market discovery has not completed"
          : null),
    },
    {
      code: "on-chain-market-recovery",
      active: marketRecoveryIssues.length > 0,
      sinceMs: marketRecoveryIssueObservedAtMs,
      untilMs: null,
      details: summarizeMarketRecoveryIssues(marketRecoveryIssues),
      correlationIds: marketRecoveryCorrelations,
    },
    {
      code: "program-api-missing",
      active: !keeperProgramApiReady,
      sinceMs: !keeperProgramApiReady ? botBootedAtMs : null,
      untilMs: null,
      details: !keeperProgramApiReady
        ? `missing required IDL methods: ${missingKeeperMethods.join(", ")}`
        : null,
    },
    {
      code: "cycle-error",
      active: lastCycleErrorAtMs != null,
      sinceMs: lastCycleErrorAtMs,
      untilMs: null,
      details: lastCycleErrorDetails,
    },
    {
      code: "rpc-backoff",
      active: rpcBlockedUntil > now,
      sinceMs: rpcBlockedUntil > now ? now : null,
      untilMs: rpcBlockedUntil > now ? rpcBlockedUntil : null,
      details: rpcBlockedUntil > now ? "waiting for RPC backoff window" : null,
    },
    {
      code: "funding-backoff",
      active: fundingBlockedUntil > now,
      sinceMs: fundingBlockedUntil > now ? now : null,
      untilMs: fundingBlockedUntil > now ? fundingBlockedUntil : null,
      details:
        fundingBlockedUntil > now ? "bot signer funding below threshold" : null,
    },
    {
      code: "chain-backoff",
      active: chainCheckBlockedUntil > now,
      sinceMs: chainCheckBlockedUntil > now ? now : null,
      untilMs: chainCheckBlockedUntil > now ? chainCheckBlockedUntil : null,
      details:
        chainCheckBlockedUntil > now
          ? "keeper chain readiness check cooling down"
          : null,
    },
    {
      code: "restart-reconcile",
      active: restartRecoveryObservedAtMs != null,
      sinceMs: restartRecoveryObservedAtMs,
      untilMs: null,
      details: restartRecoveryDetails,
    },
    {
      code: "awaiting-result",
      active: unresolvedOracleWarningMatches.size > 0,
      sinceMs: unresolvedOracleWarningMatches.size > 0 ? now : null,
      untilMs: null,
      details:
        unresolvedOracleWarningMatches.size > 0
          ? `${unresolvedOracleWarningMatches.size} locked duel(s) waiting on authoritative result`
          : null,
      correlationIds: awaitingResultCorrelations,
    },
    {
      code: "terminal-queue",
      active: pendingTerminalCount > 0,
      sinceMs: pendingTerminalCount > 0 ? now : null,
      untilMs: null,
      details:
        pendingTerminalCount > 0
          ? `${terminalSummary.PENDING} pending and ${terminalSummary.PROCESSING} processing terminal operation(s)`
          : null,
      correlationIds: terminalCorrelations("PENDING", "PROCESSING"),
    },
    {
      code: "terminal-manual-review",
      active: terminalSummary.MANUAL_REVIEW > 0,
      sinceMs: terminalSummary.MANUAL_REVIEW > 0 ? now : null,
      untilMs: null,
      details:
        terminalSummary.MANUAL_REVIEW > 0
          ? `${terminalSummary.MANUAL_REVIEW} terminal operation(s) require manual review`
          : null,
      correlationIds: terminalCorrelations("MANUAL_REVIEW"),
    },
    {
      code: "terminal-dead-letter",
      active: terminalSummary.DEAD_LETTER > 0,
      sinceMs: terminalSummary.DEAD_LETTER > 0 ? now : null,
      untilMs: null,
      details:
        terminalSummary.DEAD_LETTER > 0
          ? `${terminalSummary.DEAD_LETTER} terminal operation(s) exhausted automatic retries`
          : null,
      correlationIds: terminalCorrelations("DEAD_LETTER"),
    },
  ];
}

let latestBotHealthSnapshot: KeeperBotHealthSnapshot | null = null;
let duelBotHealthServer: ReturnType<typeof Bun.serve> | null = null;

function writeBotHealthSnapshot(): void {
  try {
    const nowMs = Date.now();
    trimSettledClobHealth();
    const activeRecords = Array.from(activeClobMatches.values()).map(
      (trackedMatch) => buildManagedClobHealthRecord(trackedMatch),
    );
    const recentSettledRecords = Array.from(settledClobHealth.entries())
      .filter(([duelId]) => !activeClobMatches.has(duelId))
      .map(([, record]) => record);
    const markets = [...activeRecords, ...recentSettledRecords];
    const snapshot: KeeperBotHealthSnapshot = {
      chainKey: "solana",
      releaseCommitSha: BOT_RELEASE_IDENTITY.commitSha,
      runtime: DUEL_BOT_RUNTIME_IDENTITY,
      updatedAtMs: nowMs,
      bootedAtMs: botBootedAtMs,
      running: botRuntimeRunning,
      processId: typeof process.pid === "number" ? process.pid : null,
      lastSuccessfulRpcAtMs,
      recovery: buildBotRecoveryStates(),
      markets,
      operatorMetrics: buildKeeperOperatorMetrics({
        nowMs,
        checkpoint: terminalLedger.getBettingFeedCheckpoint(),
        terminal: terminalLedger.getOperationsTelemetry(),
        markets,
      }),
    };
    latestBotHealthSnapshot = snapshot;
    if (!BOT_HEALTH_FILE) return;
    fs_node.mkdirSync(path.dirname(BOT_HEALTH_FILE), { recursive: true });
    fs_node.writeFileSync(BOT_HEALTH_FILE, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.warn("[bot] Failed to write bot health snapshot:", error);
  }
}

let lastBotHeartbeatWarningAtMs = 0;
const botHealthHeartbeat = createKeeperBotHeartbeat({
  intervalMs: BOT_HEALTH_HEARTBEAT_MS,
  probe: async () => {
    await connection.getSlot("confirmed");
  },
  onRpcSuccess: () => {
    markRpcSuccess();
  },
  writeSnapshot: writeBotHealthSnapshot,
  onProbeError: (error) => {
    const now = Date.now();
    if (now - lastBotHeartbeatWarningAtMs < BOT_READINESS_MAX_AGE_MS) return;
    lastBotHeartbeatWarningAtMs = now;
    console.warn(
      `[bot] health RPC probe failed: ${sanitizeErrorMessage(error)}`,
    );
  },
});

async function settleTrackedMatchFromResolvedState(
  trackedMatch: ActiveClobMatch,
  duelId: string,
  winnerSide: "A" | "B" | null,
): Promise<void> {
  await syncTrackedMarketFromOracle(trackedMatch);
  await cancelManagedClobQuotes(trackedMatch, "market-resolved");
  if (winnerSide) {
    trackedMatch.winner = winnerSide;
  }
  await settleTrackedMarketCustody(trackedMatch, "RESOLVED");
  trackedMatch.lastResolvedAtMs = Date.now();
  activeClobMatches.delete(duelId);
  unresolvedOracleWarningMatches.delete(duelId);
  writeBotHealthSnapshot();
}

async function settleManagedMarketMakerBalance(
  trackedMatch: ActiveClobMatch,
  lifecycleStatus: "RESOLVED" | "CANCELLED",
): Promise<void> {
  const marketState = await getClobMarketState(trackedMatch.marketState);
  if (
    !marketState ||
    !enumIs(
      marketState.status,
      lifecycleStatus === "RESOLVED" ? "resolved" : "cancelled",
    )
  ) {
    throw new Error(
      `Cannot settle market-maker balance for non-${lifecycleStatus.toLowerCase()} market ${trackedMatch.marketState.toBase58()}`,
    );
  }
  const userBalance = findUserBalancePda(
    marketProgram.programId,
    trackedMatch.marketState,
    marketMakerKeypair.publicKey,
  );
  const balance =
    await marketProgram.account.userBalance.fetchNullable(userBalance);
  const action = resolveManagedMarketMakerSettlement({
    lifecycleStatus,
    winner:
      lifecycleStatus === "RESOLVED"
        ? enumIs(marketState.winner, "a")
          ? "A"
          : enumIs(marketState.winner, "b")
            ? "B"
            : null
        : null,
    balance: balance
      ? {
          aShares: requireAccountU64(balance.aShares, "A-share balance"),
          bShares: requireAccountU64(balance.bShares, "B-share balance"),
          aLockedLamports: requireAccountU64(
            balance.aLockedLamports,
            "A-side locked lamports",
          ),
          bLockedLamports: requireAccountU64(
            balance.bLockedLamports,
            "B-side locked lamports",
          ),
          tradeTreasuryFeeLamports: requireAccountU64(
            balance.tradeTreasuryFeeLamports,
            "user treasury-fee lamports",
          ),
          tradeMarketMakerFeeLamports: requireAccountU64(
            balance.tradeMarketMakerFeeLamports,
            "user market-maker-fee lamports",
          ),
        }
      : null,
  });
  if (action === "none") return;

  await runWithRecovery(
    () =>
      action === "claim"
        ? marketProgram.methods
            .claim()
            .accountsPartial({
              marketState: trackedMatch.marketState,
              duelState: trackedMatch.duelState,
              userBalance,
              config: marketConfigPda,
              marketMaker: marketState.marketMaker as PublicKey,
              vault: trackedMatch.vault,
              user: marketMakerKeypair.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([marketMakerKeypair])
            .rpc()
        : action === "close-losing-balance"
          ? marketProgram.methods
              .closeLosingBalance()
              .accountsPartial({
                marketState: trackedMatch.marketState,
                duelState: trackedMatch.duelState,
                userBalance,
                user: marketMakerKeypair.publicKey,
              })
              .signers([marketMakerKeypair])
              .rpc()
          : marketProgram.methods
              .closeEmptyUserBalance()
              .accountsPartial({
                marketState: trackedMatch.marketState,
                userBalance,
                user: marketMakerKeypair.publicKey,
              })
              .signers([marketMakerKeypair])
              .rpc(),
    connection,
  );
  trackedMatch.lastClaimAtMs = markRpcSuccess(trackedMatch);
  console.log(
    `[Keeper] Settled market-maker balance for ${trackedMatch.duelId}: ${action}`,
  );
}

async function withdrawResolvedTradeFees(
  trackedMatch: ActiveClobMatch,
): Promise<void> {
  const result = await releaseResolvedTradeFeesFailClosed({
    readEscrow: async () => {
      const marketState = await getClobMarketState(trackedMatch.marketState);
      if (!marketState || !enumIs(marketState.status, "resolved")) {
        throw new Error(
          `Cannot release execution-fee escrow for unresolved market ${trackedMatch.marketState.toBase58()}`,
        );
      }
      return {
        treasuryLamports: requireAccountU64(
          marketState.accruedTradeTreasuryFeeLamports,
          "accrued treasury-fee lamports",
        ),
        marketMakerLamports: requireAccountU64(
          marketState.accruedTradeMarketMakerFeeLamports,
          "accrued market-maker-fee lamports",
        ),
      };
    },
    submitRelease: async () => {
      const marketState = await getClobMarketState(trackedMatch.marketState);
      if (!marketState || !enumIs(marketState.status, "resolved")) {
        throw new Error(
          `Cannot release execution-fee escrow for unresolved market ${trackedMatch.marketState.toBase58()}`,
        );
      }
      await runWithRecovery(
        () =>
          marketProgram.methods
            .withdrawResolvedTradeFees()
            .accountsPartial({
              marketState: trackedMatch.marketState,
              duelState: trackedMatch.duelState,
              treasury: marketState.treasury as PublicKey,
              marketMaker: marketState.marketMaker as PublicKey,
              vault: trackedMatch.vault,
              submitter: marketMakerKeypair.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([marketMakerKeypair])
            .rpc(),
        connection,
      );
    },
  });
  if (!result.attempted) return;
  markRpcSuccess(trackedMatch);
  console.log(
    `[Keeper] Released resolved execution-fee escrow for ${trackedMatch.duelId}: treasury=${result.before.treasuryLamports} marketMaker=${result.before.marketMakerLamports}`,
  );
}

async function settleTrackedMarketCustody(
  trackedMatch: ActiveClobMatch,
  lifecycleStatus: "RESOLVED" | "CANCELLED",
): Promise<void> {
  await reconcileTerminalMarketCustody({
    lifecycleStatus,
    settleMarketMakerBalance: () =>
      settleManagedMarketMakerBalance(trackedMatch, lifecycleStatus),
    releaseResolvedTradeFees: () => withdrawResolvedTradeFees(trackedMatch),
    captureSettledHealth: () =>
      captureSettledClobHealth(trackedMatch, lifecycleStatus),
  });
}

async function maybeFinalizeTrackedProposal(
  trackedMatch: ActiveClobMatch,
  duelState: Record<string, unknown>,
  metadataUri: string,
): Promise<boolean> {
  if (
    !enumIs(duelState.status, "proposed") ||
    Boolean(duelState.pendingChallenged)
  ) {
    return false;
  }

  const oracleConfig = await getOracleConfigState();
  if (!oracleConfig) {
    throw new Error(`Missing oracle config ${oracleConfigPda.toBase58()}`);
  }

  const pendingProposedAt = requireSafeAccountInteger(
    duelState.pendingProposedAt,
    "pending proposal timestamp",
    { min: 1 },
  );
  const disputeWindowSecs = requireSafeAccountInteger(
    oracleConfig.disputeWindowSecs,
    "proposal dispute window seconds",
    { min: 1 },
  );
  const finalizableAt = pendingProposedAt + disputeWindowSecs;
  if (!Number.isSafeInteger(finalizableAt)) {
    throw new Error(
      "proposal finalization timestamp exceeds safe integer range",
    );
  }
  const chainTimeSecs = await getConfirmedChainTimeSecs();
  if (!isOracleTimestampMature(chainTimeSecs, finalizableAt)) {
    return false;
  }

  try {
    await runWithRecovery(
      () =>
        fightProgram.methods
          .finalizeResult(
            Array.from(duelKeyHexToBytes(trackedMatch.duelKeyHex)),
            metadataUri,
          )
          .accountsPartial({
            finalizer: oracleFinalizerKeypair.publicKey,
            oracleConfig: oracleConfigPda,
            duelState: trackedMatch.duelState,
          })
          .signers([oracleFinalizerKeypair])
          .rpc(),
      connection,
    );
  } catch (error) {
    const disposition = classifyOracleFinalizeError(error);
    if (disposition === "not_mature") {
      return false;
    }
    if (disposition === "state_race") {
      const refreshedDuelState = await getDuelState(trackedMatch.duelState);
      return Boolean(
        refreshedDuelState && enumIs(refreshedDuelState.status, "resolved"),
      );
    }
    throw error;
  }
  markRpcSuccess(trackedMatch);
  return true;
}

async function reportRoundResult(
  data: DuelLifecycleEvent,
  winnerSide: "A" | "B",
): Promise<"resolved" | "proposed" | "challenged"> {
  const trackedMatch = activeClobMatches.get(data.duelId);
  if (!trackedMatch) {
    throw new Error(
      `cannot settle untracked duel ${data.duelId}; startup reconciliation is required`,
    );
  }

  if (!data.seed || !data.replayHash) {
    throw new Error(
      `[Keeper] duel:completed for ${data.duelId} is missing seed or replayHash; refusing to post an unverifiable oracle result.`,
    );
  }

  const replayHashHex = data.replayHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(replayHashHex)) {
    throw new Error(
      `[Keeper] duel:completed for ${data.duelId} supplied an invalid replayHash; refusing to post oracle result.`,
    );
  }

  const resolvedSeed = data.seed;

  let duelState = await getDuelState(trackedMatch.duelState);
  if (duelState && enumIs(duelState.status, "resolved")) {
    await settleTrackedMatchFromResolvedState(
      trackedMatch,
      data.duelId,
      winnerSide,
    );
    return "resolved";
  }
  if (duelState && enumIs(duelState.status, "challenged")) {
    await syncTrackedMarketFromOracle(trackedMatch);
    unresolvedOracleWarningMatches.add(data.duelId);
    console.warn(
      `[Keeper] Duel ${data.duelId} result proposal is challenged; leaving the market fail-closed until manual resolution.`,
    );
    return "challenged";
  }

  const duelKey = duelKeyHexToBytes(data.duelKeyHex);
  if (!duelState) {
    throw new Error(
      `[Keeper] duel:completed for ${data.duelId} has no canonical on-chain duel state; startup reconciliation is required.`,
    );
  }
  let duelEndTs: number;
  try {
    duelEndTs = resolveOracleDuelEndTimestamp({
      duelEndTimeMs: data.duelEndTime,
      duelStartTs: requireSafeAccountInteger(
        duelState.duelStartTs,
        "completed duel start timestamp",
        { min: 1 },
      ),
    });
  } catch (error) {
    throw new Error(
      `[Keeper] duel:completed for ${data.duelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(
    `[Keeper] Waiting 15s before proposing result for duel ${data.duelId} to sync with stream...`,
  );
  await sleep(15_000);

  duelState = await getDuelState(trackedMatch.duelState);
  if (duelState && enumIs(duelState.status, "locked")) {
    const duelStartTs = requireSafeAccountInteger(
      duelState.duelStartTs,
      "locked duel start timestamp",
      { min: 1 },
    );
    if (duelEndTs < duelStartTs) {
      throw new Error(
        `[Keeper] duel:completed for ${data.duelId} ended at ${duelEndTs}, before its immutable on-chain start ${duelStartTs}; refusing to post an inconsistent result.`,
      );
    }
    await waitForConfirmedChainTimestamp(
      duelEndTs,
      `[Keeper] duel:completed for ${data.duelId}`,
    );
    const replayHash = Array.from(Buffer.from(replayHashHex, "hex"));
    const resultHash = buildResultHash(
      data.duelKeyHex,
      winnerSide,
      resolvedSeed,
      replayHashHex,
      data.competitiveSnapshotVersion,
      data.competitiveSnapshotDigest,
    );
    const proposalRecord = findProposalRecordPda(
      fightProgram.programId,
      duelKey,
      resultHash,
      replayHash,
    );
    await runWithRecovery(
      () =>
        fightProgram.methods
          .proposeResult(
            Array.from(duelKey),
            winnerSideEnum(winnerSide),
            new BN(resolvedSeed),
            replayHash,
            resultHash,
            new BN(duelEndTs),
            buildDuelMetadata(data),
          )
          .accountsPartial({
            reporter: oracleReporterKeypair.publicKey,
            oracleConfig: oracleConfigPda,
            duelState: trackedMatch.duelState,
            proposalRecord,
            systemProgram: SystemProgram.programId,
          })
          .signers([oracleReporterKeypair])
          .rpc(),
      connection,
    );
    trackedMatch.lastOracleAtMs = markRpcSuccess(trackedMatch);
    duelState = await getDuelState(trackedMatch.duelState);
  }

  if (duelState && enumIs(duelState.status, "challenged")) {
    await syncTrackedMarketFromOracle(trackedMatch);
    unresolvedOracleWarningMatches.add(data.duelId);
    console.warn(
      `[Keeper] Duel ${data.duelId} result proposal is challenged; leaving the market fail-closed until manual resolution.`,
    );
    return "challenged";
  }

  if (
    duelState &&
    enumIs(duelState.status, "proposed") &&
    (await maybeFinalizeTrackedProposal(
      trackedMatch,
      duelState,
      buildDuelMetadata(data),
    ))
  ) {
    duelState = await getDuelState(trackedMatch.duelState);
  }

  if (duelState && enumIs(duelState.status, "resolved")) {
    await settleTrackedMatchFromResolvedState(
      trackedMatch,
      data.duelId,
      winnerSide,
    );
    console.log(
      JSON.stringify(
        {
          action: "clob_resolved",
          duelId: data.duelId,
          duelState: trackedMatch.duelState.toBase58(),
          marketState: trackedMatch.marketState.toBase58(),
          winner: winnerSide,
        },
        null,
        2,
      ),
    );
    return "resolved";
  }

  unresolvedOracleWarningMatches.add(data.duelId);
  await syncTrackedMarketFromOracle(trackedMatch);

  console.log(
    JSON.stringify(
      {
        action: "clob_result_proposed",
        duelId: data.duelId,
        duelState: trackedMatch.duelState.toBase58(),
        marketState: trackedMatch.marketState.toBase58(),
        winner: winnerSide,
        finalizationPending: true,
      },
      null,
      2,
    ),
  );
  writeBotHealthSnapshot();
  return "proposed";
}

function solanaOracleCancellationState(
  duelState: Record<string, unknown> | null,
): OracleCancellationState {
  if (!duelState) return "missing";
  for (const state of [
    "scheduled",
    "bettingOpen",
    "locked",
    "proposed",
    "challenged",
    "resolved",
    "cancelled",
  ] as const) {
    if (enumIs(duelState.status, state)) return state;
  }
  return "unknown";
}

function deriveTrackedMatchForTerminalEvent(
  data: DuelLifecycleEvent,
): ActiveClobMatch {
  const duelKey = duelKeyHexToBytes(data.duelKeyHex);
  const duelState = findDuelStatePda(fightProgram.programId, duelKey);
  const marketState = findMarketPda(
    marketProgram.programId,
    duelState,
    DUEL_WINNER_MARKET_KIND,
  );
  return {
    duelId: data.duelId,
    duelKeyHex: data.duelKeyHex,
    duelState,
    marketState,
    vault: findClobVaultPda(marketProgram.programId, marketState),
    createdAt: Date.now(),
    lastStreamAtMs: Date.now(),
    lastOracleAtMs: null,
    lastRpcAtMs: null,
    lastSyncedAtMs: null,
    lastResolvedAtMs: null,
    lastClaimAtMs: null,
    lastQuoteSnapshot: null,
    lastQuotePlan: null,
    winner: "NONE",
    yesBidOrder: null,
    noAskOrder: null,
    recoveredManagedOrders: [],
  };
}

async function cancelRoundForTerminalOutcome(
  data: DuelLifecycleEvent,
  outcome: "draw" | "cancelled",
  reason: string,
): Promise<void> {
  const trackedMatch =
    activeClobMatches.get(data.duelId) ??
    deriveTrackedMatchForTerminalEvent(data);

  await cancelManagedClobQuotes(trackedMatch, `terminal-${outcome}`);
  const duelState = await getDuelState(trackedMatch.duelState);
  const oracleState = solanaOracleCancellationState(duelState);
  const cancellationAction = classifyOracleCancellation(oracleState);

  if (cancellationAction === "preserve_resolved") {
    unresolvedOracleWarningMatches.add(data.duelId);
    await syncTrackedMarketFromOracle(trackedMatch);
    throw new ManualReviewTerminalError(
      `refusing to cancel duel ${data.duelId}: Solana oracle is already resolved`,
    );
  }
  if (cancellationAction === "manual_review") {
    unresolvedOracleWarningMatches.add(data.duelId);
    await syncTrackedMarketFromOracle(trackedMatch);
    throw new ManualReviewTerminalError(
      `refusing to cancel duel ${data.duelId}: Solana oracle is ${oracleState} and requires operator review`,
    );
  }
  if (cancellationAction === "fail_closed") {
    unresolvedOracleWarningMatches.add(data.duelId);
    throw new Error(
      `cannot safely cancel duel ${data.duelId}: Solana oracle state is ${oracleState}`,
    );
  }

  if (cancellationAction === "cancel") {
    const metadata = buildDuelCancellationMetadata({
      duelId: data.duelId,
      duelKey: data.duelKeyHex,
      outcome,
      reason,
    });
    await runWithRecovery(
      () =>
        fightProgram.methods
          .cancelDuel(Array.from(duelKeyHexToBytes(data.duelKeyHex)), metadata)
          .accountsPartial({
            authority: oracleReporterKeypair.publicKey,
            oracleConfig: oracleConfigPda,
            duelState: trackedMatch.duelState,
          })
          .signers([oracleReporterKeypair])
          .rpc(),
      connection,
    );
    trackedMatch.lastOracleAtMs = markRpcSuccess(trackedMatch);
    const cancelledState = await getDuelState(trackedMatch.duelState);
    if (!cancelledState || !enumIs(cancelledState.status, "cancelled")) {
      unresolvedOracleWarningMatches.add(data.duelId);
      throw new Error(
        `Solana oracle cancellation readback failed for duel ${data.duelId}`,
      );
    }
  }

  await syncTrackedMarketFromOracle(trackedMatch);
  await settleTrackedMarketCustody(trackedMatch, "CANCELLED");
  unresolvedOracleWarningMatches.delete(data.duelId);
  activeClobMatches.delete(data.duelId);
}

type AcceptedTerminalDisposition = Exclude<
  DuelTerminalDisposition,
  { action: "reject" }
>;

function terminalOperationInputFromEvent(
  data: DuelLifecycleEvent,
  terminal: AcceptedTerminalDisposition,
): TerminalOperationInput {
  return {
    duelId: data.duelId,
    duelKey: data.duelKeyHex,
    outcome:
      terminal.action === "settle"
        ? "WIN"
        : terminal.outcome === "draw"
          ? "DRAW"
          : "CANCELLED",
    winnerSide: terminal.action === "settle" ? terminal.winnerSide : null,
    participantAId: data.agent1?.id ?? null,
    participantBId: data.agent2?.id ?? null,
    winnerId: data.winnerId,
    reason: terminal.action === "cancel" ? terminal.reason : null,
    seed: data.seed,
    replayHash: data.replayHash,
    event: data,
  };
}

function terminalDispositionFromRecord(
  record: TerminalOperationRecord,
  data: DuelLifecycleEvent,
): AcceptedTerminalDisposition {
  if (data.duelId !== record.duelId || data.duelKeyHex !== record.duelKey) {
    throw new ManualReviewTerminalError(
      `terminal ledger identity mismatch for duel ${record.duelId}`,
    );
  }
  if (
    (data.agent1?.id ?? null) !== record.participantAId ||
    (data.agent2?.id ?? null) !== record.participantBId ||
    data.winnerId !== record.winnerId
  ) {
    throw new ManualReviewTerminalError(
      `terminal ledger participant identity mismatch for duel ${record.duelId}`,
    );
  }
  const terminal = classifyDuelTerminal({
    outcome: data.outcome,
    cancellationReason: data.cancellationReason,
    winnerId: data.winnerId,
    agent1Id: data.agent1?.id,
    agent2Id: data.agent2?.id,
  });
  if (terminal.action === "reject") {
    throw new ManualReviewTerminalError(
      `persisted terminal event is no longer valid: ${terminal.reason}`,
    );
  }
  const expectedOutcome =
    terminal.action === "settle"
      ? "WIN"
      : terminal.outcome === "draw"
        ? "DRAW"
        : "CANCELLED";
  const expectedWinner =
    terminal.action === "settle" ? terminal.winnerSide : null;
  if (
    record.outcome !== expectedOutcome ||
    record.winnerSide !== expectedWinner
  ) {
    throw new ManualReviewTerminalError(
      `terminal ledger disposition mismatch for duel ${record.duelId}`,
    );
  }
  return terminal;
}

async function ensureTrackedMatchForTerminalEvent(
  data: DuelLifecycleEvent,
): Promise<ActiveClobMatch> {
  const existing = activeClobMatches.get(data.duelId);
  if (existing) return existing;

  const recovered = deriveTrackedMatchForTerminalEvent(data);
  const duelState = await getDuelState(recovered.duelState);
  if (!duelState) {
    throw new Error(
      `cannot reconcile terminal duel ${data.duelId}: oracle account is missing`,
    );
  }
  activeClobMatches.set(data.duelId, recovered);
  // Terminal operations are intentionally processed from the durable ledger
  // after the dispute window. Rehydrating that expected work is not a keeper
  // restart condition; the terminal queue and partial-claim market marker
  // expose its bounded progress until the claim completes.
  return recovered;
}

function assertTerminalMarketRecoveryIsSafe(data: DuelLifecycleEvent): void {
  if (marketDiscoveryErrorAtMs != null) {
    throw new Error(
      `cannot reconcile terminal duel ${data.duelId}: on-chain market discovery is degraded`,
    );
  }
  const duelRef = findDuelStatePda(
    fightProgram.programId,
    duelKeyHexToBytes(data.duelKeyHex),
  ).toBase58();
  const relatedIssues = marketRecoveryIssues.filter(
    (entry) => entry.duelRef === duelRef,
  );
  if (relatedIssues.length > 0) {
    throw new ManualReviewTerminalError(
      `cannot safely reconcile terminal duel ${data.duelId}: ${summarizeMarketRecoveryIssues(relatedIssues)}`,
    );
  }
}

function terminalRetryDelayMs(attempts: number): number {
  const exponent = Math.min(10, Math.max(0, attempts - 1));
  return Math.min(terminalRetryMaxMs, terminalRetryBaseMs * 2 ** exponent);
}

async function processClaimedTerminalOperation(
  record: TerminalOperationRecord,
): Promise<void> {
  try {
    const data = record.event as DuelLifecycleEvent;
    const terminal = terminalDispositionFromRecord(record, data);
    if (!keeperProgramApiReady) {
      warnMissingKeeperMethodsOnce();
      throw new Error("keeper program API is not ready");
    }
    if (!(await ensureKeeperChainReady())) {
      throw new Error("keeper chain is not ready");
    }
    if (!(await ensureKeeperSignerFunding())) {
      throw new Error("bot signer funding is below threshold");
    }
    await ensureOracleReady();
    await ensureMarketConfigReady();
    await ensureOnChainMarketDiscovery(marketDiscoveryErrorAtMs != null);
    assertTerminalMarketRecoveryIsSafe(data);

    if (terminal.action === "cancel") {
      await cancelRoundForTerminalOutcome(
        data,
        terminal.outcome,
        terminal.reason,
      );
    } else {
      await ensureTrackedMatchForTerminalEvent(data);
      const resultStatus = await reportRoundResult(data, terminal.winnerSide);
      if (resultStatus === "challenged") {
        throw new ManualReviewTerminalError(
          `duel ${data.duelId} has a challenged oracle proposal`,
        );
      }
      if (resultStatus === "proposed") {
        throw new Error(
          `duel ${data.duelId} result is proposed and awaiting finalization`,
        );
      }
    }

    terminalLedger.markSucceeded(record.id, terminalWorkerId);
    unresolvedOracleWarningMatches.delete(record.duelId);
    console.log(
      `[bot] terminal operation succeeded duel=${record.duelId} attempt=${record.attempts}`,
    );
  } catch (error) {
    unresolvedOracleWarningMatches.add(record.duelId);
    if (error instanceof ManualReviewTerminalError) {
      terminalLedger.markManualReview(record.id, terminalWorkerId, error);
      console.error(
        `[bot] terminal operation requires manual review duel=${record.duelId}: ${sanitizeErrorMessage(error)}`,
      );
    } else {
      const retryStatus = terminalLedger.markRetry({
        id: record.id,
        ownerId: terminalWorkerId,
        error,
        nextAttemptAt: Date.now() + terminalRetryDelayMs(record.attempts),
        maxAttempts: terminalMaxAttempts,
      });
      console.error(
        `[bot] terminal operation ${retryStatus.toLowerCase()} duel=${record.duelId} attempt=${record.attempts}: ${sanitizeErrorMessage(error)}`,
      );
    }
  } finally {
    writeBotHealthSnapshot();
  }
}

async function processTerminalOperationForDuel(duelId: string): Promise<void> {
  const record = terminalLedger.claimByDuelId({
    duelId,
    ownerId: terminalWorkerId,
    leaseMs: terminalLeaseMs,
  });
  if (record) await processClaimedTerminalOperation(record);
}

async function reconcileTerminalOperations(): Promise<void> {
  const records = terminalLedger.claimDue({
    ownerId: terminalWorkerId,
    leaseMs: terminalLeaseMs,
    limit: terminalReconcileBatchSize,
  });
  for (const record of records) {
    await processClaimedTerminalOperation(record);
  }
}

// Event-driven Logic
const duelFeedConfig = resolveDuelFeedConfig({
  cluster: botCluster,
  gameUrl: args["game-url"],
  bearerToken: process.env.BET_SYNC_SOURCE_BEARER_TOKEN,
});
const allowLocalDiagnosticFeed = resolveLocalDiagnosticDuelFeed({
  requested: process.env.HYPERBET_LOCAL_DIAGNOSTIC_FEED === "true",
  cluster: botCluster,
  gameUrl: duelFeedConfig.gameUrl,
  rpcUrl: getRpcUrl(),
});
const gameClient = new GameClient(duelFeedConfig.gameUrl, terminalLedger, {
  allowDiagnosticSnapshot: allowLocalDiagnosticFeed,
  bearerToken: duelFeedConfig.bearerToken,
});
let shutdownRequested = false;
let keeperMutationTail: Promise<void> = Promise.resolve();

async function withKeeperMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = keeperMutationTail;
  let release!: () => void;
  keeperMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function recordBotRuntimeError(error: unknown): void {
  lastCycleErrorAtMs = Date.now();
  lastCycleErrorDetails = sanitizeErrorMessage(error);
}

function closeKeeperRuntime(): void {
  botHealthHeartbeat.stop();
  botRuntimeRunning = false;
  writeBotHealthSnapshot();
  duelBotHealthServer?.stop(true);
  duelBotHealthServer = null;
  gameClient.disconnect();
  terminalLedger.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log(`[bot] received ${signal}; closing duel keeper runtime`);
    closeKeeperRuntime();
    process.exit(0);
  });
}

gameClient.onDuelStart((data) =>
  withKeeperMutationLock(async () => {
    const rendererObservationCurrent = isCurrentDuelRendererObservation({
      rendererReady: data.rendererHealth.ready,
      rendererUpdatedAt: data.rendererHealth.updatedAt,
      emittedAt: data.emittedAt,
      betOpenTime: data.betOpenTime,
    });
    if (rendererObservationCurrent) {
      markStreamEvent();
    }
    if (!keeperProgramApiReady) {
      warnMissingKeeperMethodsOnce();
      throw new Error("keeper program API is not ready for duel start");
    }

    if (!(await ensureKeeperChainReady())) {
      console.warn(
        "[bot] Skipping duel-start market creation because keeper chain is not ready.",
      );
      throw new Error("keeper chain is not ready for duel start");
    }

    if (!(await ensureKeeperSignerFunding())) {
      console.warn(
        "[bot] Skipping duel-start market creation because bot signer funding is below threshold.",
      );
      throw new Error("bot signer funding is below threshold for duel start");
    }

    console.log("Duel Started:", data);
    try {
      await ensureMarketConfigReady();
      await ensureOnChainMarketDiscovery(marketDiscoveryErrorAtMs != null);
      let trackedMatch = activeClobMatches.get(data.duelId) ?? null;
      const admission = resolveDuelMarketAdmission({
        existingMarket: trackedMatch !== null,
        rendererReady: data.rendererHealth.ready,
        rendererUpdatedAt: data.rendererHealth.updatedAt,
        phase: data.phase,
        emittedAt: data.emittedAt,
        betOpenTime: data.betOpenTime,
        betCloseTime: data.betCloseTime,
      });
      if (admission.action === "reject") {
        throw new Error(
          `refusing first market creation for duel ${data.duelId}: ${admission.reason}`,
        );
      }
      if (trackedMatch) {
        const duelState = await upsertDuelLifecycle(data, "bettingOpen");
        if (!duelState.equals(trackedMatch.duelState)) {
          throw new Error(
            `authoritative duel-start identity conflicts with recovered duel ${data.duelId}`,
          );
        }
        markStreamEvent(trackedMatch);
        await syncTrackedMarketFromOracle(trackedMatch);
      } else {
        trackedMatch = await createOrSyncRound(data);
      }
      activeClobMatches.set(data.duelId, trackedMatch);
      await maybeSeedMarket(trackedMatch);
      console.log(`Created canonical CLOB market for duel ${data.duelId}`);
    } catch (err) {
      recordBotRuntimeError(err);
      console.error("Failed to create market for duel:", err);
      writeBotHealthSnapshot();
      throw err;
    }
    writeBotHealthSnapshot();
  }),
);

// A duplicate sequence must not replay lifecycle callbacks, but a successful
// authenticated and continuity-checked poll is still an authoritative source
// heartbeat for the market-maker stale-stream circuit breaker.
gameClient.onSourceObservation((data) => {
  const trackedMatch = data.duelId
    ? (activeClobMatches.get(data.duelId) ?? null)
    : null;
  if (
    isCurrentDuelRendererObservation({
      rendererReady: data.rendererHealth.ready,
      rendererUpdatedAt: data.rendererHealth.updatedAt,
      emittedAt: data.emittedAt,
      betOpenTime: data.betOpenTime,
    })
  ) {
    markStreamEvent(trackedMatch);
  }
  writeBotHealthSnapshot();
});

gameClient.onBettingLocked((data) =>
  withKeeperMutationLock(async () => {
    if (
      isCurrentDuelRendererObservation({
        rendererReady: data.rendererHealth.ready,
        rendererUpdatedAt: data.rendererHealth.updatedAt,
        emittedAt: data.emittedAt,
        betOpenTime: data.betOpenTime,
      })
    ) {
      markStreamEvent(activeClobMatches.get(data.duelId) ?? null);
    }
    if (!keeperProgramApiReady) {
      warnMissingKeeperMethodsOnce();
      throw new Error("keeper program API is not ready for betting lock");
    }

    if (
      !(await ensureKeeperChainReady()) ||
      !(await ensureKeeperSignerFunding())
    ) {
      throw new Error(
        "keeper chain or signer funding is not ready for betting lock",
      );
    }

    try {
      await ensureMarketConfigReady();
      await ensureOnChainMarketDiscovery(marketDiscoveryErrorAtMs != null);
      await lockRound(data);
      console.log(`Locked duel market for ${data.duelId}`);
    } catch (error) {
      recordBotRuntimeError(error);
      console.error("Failed to lock market for duel:", error);
      writeBotHealthSnapshot();
      throw error;
    }
    writeBotHealthSnapshot();
  }),
);

gameClient.onDuelEnd((data) =>
  withKeeperMutationLock(async () => {
    if (
      isCurrentDuelRendererObservation({
        rendererReady: data.rendererHealth.ready,
        rendererUpdatedAt: data.rendererHealth.updatedAt,
        emittedAt: data.emittedAt,
        betOpenTime: data.betOpenTime,
      })
    ) {
      markStreamEvent(activeClobMatches.get(data.duelId) ?? null);
    }
    console.log("Duel Ended:", data);
    const terminal = classifyDuelTerminal({
      outcome: data.outcome,
      cancellationReason: data.cancellationReason,
      winnerId: data.winnerId,
      agent1Id: data.agent1?.id,
      agent2Id: data.agent2?.id,
    });
    if (terminal.action === "reject") {
      const error = new Error(
        `refusing terminal mutation for duel ${data.duelId}: ${terminal.reason}`,
      );
      recordBotRuntimeError(error);
      writeBotHealthSnapshot();
      throw error;
    }

    try {
      terminalLedger.enqueue(terminalOperationInputFromEvent(data, terminal));
    } catch (error) {
      if (!(error instanceof TerminalOperationConflictError)) throw error;
      unresolvedOracleWarningMatches.add(data.duelId);
      console.error(
        `[bot] contradictory terminal event quarantined for duel ${data.duelId}`,
      );
      writeBotHealthSnapshot();
      return;
    }

    await processTerminalOperationForDuel(data.duelId);
  }),
);

// Maintenance Loop (Seeding & Cleanup)
async function runMaintenance(): Promise<void> {
  if (!keeperProgramApiReady) {
    warnMissingKeeperMethodsOnce();
    return;
  }

  if (!(await ensureKeeperChainReady())) {
    return;
  }

  if (!(await ensureKeeperSignerFunding())) {
    return;
  }
  await ensureOracleReady();
  await ensureMarketConfigReady();
  await ensureOnChainMarketDiscovery();
  await reconcileTerminalOperations();

  const shouldRefreshStatusDrift = marketRecoveryIssues.some(
    (entry) => entry.code === "market-status-drift",
  );

  // Poll every canonical market restored from the on-chain account graph.
  for (const [duelId, trackedMatch] of activeClobMatches.entries()) {
    const duelState = await getDuelState(trackedMatch.duelState);
    if (!duelState) {
      throw new Error(
        `tracked duel account disappeared during reconciliation: ${trackedMatch.duelState.toBase58()}`,
      );
    }

    await syncTrackedMarketFromOracle(trackedMatch);

    if (enumIs(duelState.status, "bettingOpen")) {
      await maybeSeedMarket(trackedMatch);
      continue;
    }

    if (enumIs(duelState.status, "locked")) {
      await cancelManagedClobQuotes(trackedMatch, "market-locked");
      await maybeWarnUnresolvedDuel(trackedMatch);
      continue;
    }

    if (enumIs(duelState.status, "proposed")) {
      await cancelManagedClobQuotes(trackedMatch, "result-proposed");
      if (
        await maybeFinalizeTrackedProposal(
          trackedMatch,
          duelState,
          JSON.stringify({
            duelId,
            duelKeyHex: trackedMatch.duelKeyHex,
            action: "keeper_auto_finalize",
          }),
        )
      ) {
        const refreshedDuelState = await getDuelState(trackedMatch.duelState);
        if (
          refreshedDuelState &&
          enumIs(refreshedDuelState.status, "resolved")
        ) {
          await settleTrackedMatchFromResolvedState(
            trackedMatch,
            duelId,
            resolvedWinnerFromDuelState(refreshedDuelState),
          );
        }
      }
      unresolvedOracleWarningMatches.delete(duelId);
      continue;
    }

    if (enumIs(duelState.status, "challenged")) {
      await cancelManagedClobQuotes(trackedMatch, "result-challenged");
      unresolvedOracleWarningMatches.add(duelId);
      continue;
    }

    if (enumIs(duelState.status, "resolved")) {
      await cancelManagedClobQuotes(trackedMatch, "market-terminal");
      const recoveredWinner = resolvedWinnerFromDuelState(duelState);
      if (!recoveredWinner) {
        throw new Error(
          `Resolved duel ${duelId} is missing a canonical participant winner`,
        );
      }
      trackedMatch.winner = recoveredWinner;
      await settleTrackedMarketCustody(trackedMatch, "RESOLVED");
      unresolvedOracleWarningMatches.delete(duelId);
      activeClobMatches.delete(duelId);
      continue;
    }

    if (enumIs(duelState.status, "cancelled")) {
      await cancelManagedClobQuotes(trackedMatch, "market-terminal");
      await settleTrackedMarketCustody(trackedMatch, "CANCELLED");
      unresolvedOracleWarningMatches.delete(duelId);
      activeClobMatches.delete(duelId);
      continue;
    }
  }

  if (shouldRefreshStatusDrift) {
    await ensureOnChainMarketDiscovery(true);
  }
  clearCompletedRestartRecovery();
  // Brand-new rounds are still created only from authoritative duel-start events.
}

botHealthHeartbeat.start();
void botHealthHeartbeat.tick();
writeBotHealthSnapshot();
if (DUEL_BOT_HEALTH_SERVER_CONFIG) {
  duelBotHealthServer = startDuelBotHealthServer({
    config: DUEL_BOT_HEALTH_SERVER_CONFIG,
    production: PROTECTED_KEEPER_RUNTIME,
    release: BOT_RELEASE_IDENTITY,
    runtime: DUEL_BOT_RUNTIME_IDENTITY,
    getSnapshot: () => latestBotHealthSnapshot,
  });
  console.log(
    `[bot] private health server listening on ${duelBotHealthServer.url.origin}`,
  );
}

try {
  if (
    keeperProgramApiReady &&
    (await ensureKeeperChainReady()) &&
    (await ensureKeeperSignerFunding())
  ) {
    await ensureOracleReady();
    await ensureMarketConfigReady();
    await ensureOnChainMarketDiscovery(true);
  }
} catch (error) {
  recordBotRuntimeError(error);
  console.error(
    `[bot] startup reconciliation failed: ${sanitizeErrorMessage(error)}`,
  );
}
writeBotHealthSnapshot();
gameClient.connect();

for (; !shutdownRequested;) {
  try {
    await withKeeperMutationLock(runMaintenance);
    lastCycleErrorAtMs = null;
    lastCycleErrorDetails = null;
  } catch (error) {
    if (isFundingError(error)) {
      fundingBlockedUntil = Date.now() + fundingBackoffMs;
    }
    recordBotRuntimeError(error);
    console.error(`[bot] cycle failed: ${sanitizeErrorMessage(error)}`);
  } finally {
    writeBotHealthSnapshot();
  }

  if (args.once) break;
  await sleep(args["poll-seconds"] * 1_000);
}

if (args.once) closeKeeperRuntime();
