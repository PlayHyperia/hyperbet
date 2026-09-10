import { Keypair, PublicKey } from "@solana/web3.js";

import { resolveSolanaV1Deployment } from "../packages/hyperbet-solana/deployments/v1";
import { resolveDuelBotHealthServerConfig } from "../packages/hyperbet-solana/keeper/src/botHealthServer";
import { resolveKeeperBotHealthSourceConfig } from "../packages/hyperbet-solana/keeper/src/botHealthTransport";
import {
  resolveDuelFeedConfig,
  resolveStreamStateSourceConfig,
} from "../packages/hyperbet-solana/keeper/src/feedConfig";
import { resolveClusterLaunchFeePolicy } from "../packages/hyperbet-solana/keeper/src/feePolicy";
import {
  resolveConfiguredLaunchWallet,
  resolveKeeperRoleRefs,
  validateKeeperFeeTreasurySeparation,
  validateKeeperRoleSeparation,
  type KeeperRolePublicKeys,
} from "../packages/hyperbet-solana/keeper/src/keeperRoles";
import { resolveClusterManagedLiquidityRiskPolicy } from "../packages/hyperbet-solana/keeper/src/managedLiquidityRiskPolicy";
import { resolveOperatorAlertConfig } from "../packages/hyperbet-solana/keeper/src/operatorAlertDispatcher";
import { resolveOracleDisputeWindowSeconds } from "../packages/hyperbet-solana/keeper/src/oracleDisputeWindowPolicy";
import {
  assertDuelBotRuntimeRole,
  assertServiceRuntimeIsolation,
} from "../packages/hyperbet-solana/keeper/src/runtimeRolePolicy";
import { resolveServiceHttpPolicy } from "../packages/hyperbet-solana/keeper/src/serviceHttpPolicy";
import { resolveClusterLifecycleIndexStartSlot } from "../packages/hyperbet-solana/keeper/src/solanaLifecycleIndexer";
import { resolveClusterExpectedUpgradeAuthority } from "../packages/hyperbet-solana/keeper/src/solanaProgramIdentity";
import { resolveSolanaProxyRail } from "../packages/hyperbet-solana/keeper/src/solanaProxyRailPolicy";
import { FORBIDDEN_NON_SOLANA_ENV } from "./ci-env-audit-solana-v1-policy";
import { resolveKeeperMainnetProgramVerification } from "./ci-solana-mainnet-program-verification-policy";

export type KeeperDeployment = "staging" | "production";
export type KeeperRuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

const COMMON_MATCHING_ENV_KEYS = [
  "NODE_ENV",
  "SOLANA_CLUSTER",
  "SOLANA_RPC_URL",
  "FIGHT_ORACLE_PROGRAM_ID",
  "DUEL_MARKET_PROGRAM_ID",
  "SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256",
  "KEEPER_BOT_HEALTH_BEARER_TOKEN",
] as const;

const SIGNER_SECRET_ENV_KEYS = [
  "KEEPER_FEE_PAYER_KEYPAIR",
  "ORACLE_REPORTER_KEYPAIR",
  "ORACLE_FINALIZER_KEYPAIR",
  "CLOB_MARKET_OPERATOR_KEYPAIR",
  "MARKET_MAKER_KEYPAIR",
  "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
  "CLOB_CONFIG_AUTHORITY_KEYPAIR",
] as const;

const SERVICE_ONLY_SECRET_ENV_KEYS = [
  "STREAM_STATE_SOURCE_BEARER_TOKEN",
  "HYPERBET_OPERATOR_ALERT_BEARER_TOKEN",
  "HELIUS_API_KEY",
] as const;

const PROHIBITED_DEPLOYED_ENV_KEYS = [
  "ARENA_EXTERNAL_BET_WRITE_KEY",
  "STREAM_PUBLISH_KEY",
  "HYPERBET_RELEASE_SHA",
] as const;

function normalizedValue(
  environment: KeeperRuntimeEnvironment,
  key: string,
): string {
  return environment[key]?.trim() ?? "";
}

function addError(errors: string[], message: string): void {
  if (!errors.includes(message)) errors.push(message);
}

function capturePolicyError(errors: string[], action: () => unknown): void {
  try {
    action();
  } catch (error) {
    addError(
      errors,
      error instanceof Error ? error.message : "runtime policy rejected",
    );
  }
}

function requireValue(
  errors: string[],
  environment: KeeperRuntimeEnvironment,
  key: string,
  role: "service" | "duel-bot",
): string {
  const value = normalizedValue(environment, key);
  if (!value) addError(errors, `${role} is missing required env ${key}`);
  return value;
}

function parseCanonicalPublicKey(value: string, label: string): PublicKey {
  try {
    const publicKey = new PublicKey(value);
    if (publicKey.equals(PublicKey.default) || publicKey.toBase58() !== value) {
      throw new Error("noncanonical");
    }
    return publicKey;
  } catch {
    throw new Error(`${label} must be a canonical nonzero Solana public key`);
  }
}

function inlineKeypairPublicKey(
  reference: string,
  label: string,
): PublicKey | null {
  const normalized = reference.trim();
  try {
    if (normalized.startsWith("[")) {
      const bytes = JSON.parse(normalized) as unknown;
      if (
        !Array.isArray(bytes) ||
        bytes.length !== 64 ||
        bytes.some(
          (byte) =>
            !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255,
        )
      ) {
        throw new Error("invalid JSON secret bytes");
      }
      return Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey;
    }
    if (normalized.startsWith("base64:")) {
      const encoded = normalized.slice("base64:".length).trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
        throw new Error("invalid base64");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== 64) throw new Error("invalid secret length");
      return Keypair.fromSecretKey(bytes).publicKey;
    }
    return null;
  } catch {
    throw new Error(
      `${label} inline keypair must encode one valid 64-byte Solana secret`,
    );
  }
}

function selectedUpgradeAuthority(
  environment: KeeperRuntimeEnvironment,
  program: "fight" | "market",
): string {
  const explicitKey =
    program === "fight"
      ? "FIGHT_ORACLE_EXPECTED_UPGRADE_AUTHORITY"
      : "DUEL_MARKET_EXPECTED_UPGRADE_AUTHORITY";
  return (
    normalizedValue(environment, explicitKey) ||
    normalizedValue(environment, "SOLANA_EXPECTED_UPGRADE_AUTHORITY")
  );
}

function auditBaseEnvironment(input: {
  deployment: KeeperDeployment;
  expectedRole: "service" | "duel-bot";
  environment: KeeperRuntimeEnvironment;
  errors: string[];
}): void {
  const { deployment, expectedRole, environment, errors } = input;
  const expectedCluster =
    deployment === "production" ? "mainnet-beta" : "devnet";
  const expectedPrograms = resolveSolanaV1Deployment(expectedCluster);
  capturePolicyError(errors, () =>
    resolveKeeperMainnetProgramVerification({
      deployment,
      role: expectedRole,
      configuredEvidenceSha256:
        environment.SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256,
    }),
  );

  for (const key of Object.keys(environment)) {
    if (FORBIDDEN_NON_SOLANA_ENV.test(key)) {
      addError(
        errors,
        `${expectedRole} declares ${key}, which is outside the SOL-only v1 environment surface`,
      );
    }
  }
  for (const key of PROHIBITED_DEPLOYED_ENV_KEYS) {
    if (normalizedValue(environment, key)) {
      addError(
        errors,
        `${expectedRole} must not configure deployed env ${key}`,
      );
    }
  }
  for (const key of [
    "HYPERBET_LOCAL_DIAGNOSTIC_FEED",
    "HYPERBET_OPERATOR_ALERT_TEST_APPROVED",
    "DISABLE_RATE_LIMIT",
  ] as const) {
    if (
      ["1", "true"].includes(normalizedValue(environment, key).toLowerCase())
    ) {
      addError(errors, `${expectedRole} must not enable ${key}`);
    }
  }

  const nodeEnv = requireValue(errors, environment, "NODE_ENV", expectedRole);
  if (nodeEnv && nodeEnv !== deployment) {
    addError(errors, `${expectedRole} NODE_ENV must be exactly ${deployment}`);
  }
  const runtimeRole = requireValue(
    errors,
    environment,
    "HYPERBET_RUNTIME_ROLE",
    expectedRole,
  );
  if (runtimeRole && runtimeRole !== expectedRole) {
    addError(
      errors,
      `${expectedRole} HYPERBET_RUNTIME_ROLE must be exactly ${expectedRole}`,
    );
  }
  const cluster = requireValue(
    errors,
    environment,
    "SOLANA_CLUSTER",
    expectedRole,
  );
  if (cluster && cluster !== expectedCluster) {
    addError(
      errors,
      `${expectedRole} SOLANA_CLUSTER must be exactly ${expectedCluster}`,
    );
  }

  const rpcUrl = requireValue(
    errors,
    environment,
    "SOLANA_RPC_URL",
    expectedRole,
  );
  if (rpcUrl) {
    capturePolicyError(errors, () =>
      resolveSolanaProxyRail({
        deployment: true,
        cluster: expectedCluster,
        rpcUrl,
        mainnetSenderUrl:
          expectedCluster === "mainnet-beta"
            ? "https://sender.helius-rpc.com/fast?api-key=redacted"
            : null,
      }),
    );
  }

  const fightProgramId = requireValue(
    errors,
    environment,
    "FIGHT_ORACLE_PROGRAM_ID",
    expectedRole,
  );
  const marketProgramId = requireValue(
    errors,
    environment,
    "DUEL_MARKET_PROGRAM_ID",
    expectedRole,
  );
  let parsedFightProgramId: PublicKey | null = null;
  let parsedMarketProgramId: PublicKey | null = null;
  if (fightProgramId) {
    capturePolicyError(errors, () => {
      parsedFightProgramId = parseCanonicalPublicKey(
        fightProgramId,
        "FIGHT_ORACLE_PROGRAM_ID",
      );
    });
    if (fightProgramId !== expectedPrograms.fightOracleProgramId) {
      addError(
        errors,
        `${expectedRole} FIGHT_ORACLE_PROGRAM_ID must match the approved ${expectedCluster} deployment manifest`,
      );
    }
  }
  if (marketProgramId) {
    capturePolicyError(errors, () => {
      parsedMarketProgramId = parseCanonicalPublicKey(
        marketProgramId,
        "DUEL_MARKET_PROGRAM_ID",
      );
    });
    if (marketProgramId !== expectedPrograms.duelMarketProgramId) {
      addError(
        errors,
        `${expectedRole} DUEL_MARKET_PROGRAM_ID must match the approved ${expectedCluster} deployment manifest`,
      );
    }
  }
  if (
    parsedFightProgramId &&
    parsedMarketProgramId &&
    parsedFightProgramId.equals(parsedMarketProgramId)
  ) {
    addError(errors, "fight-oracle and duel-market program IDs must differ");
  }

  for (const [program, label] of [
    ["fight", "fight oracle"],
    ["market", "duel market"],
  ] as const) {
    capturePolicyError(errors, () =>
      resolveClusterExpectedUpgradeAuthority({
        cluster: expectedCluster,
        value: selectedUpgradeAuthority(environment, program),
        label,
      }),
    );
  }

  const healthToken = requireValue(
    errors,
    environment,
    "KEEPER_BOT_HEALTH_BEARER_TOKEN",
    expectedRole,
  );
  if (healthToken && healthToken.length < 32) {
    addError(
      errors,
      `${expectedRole} KEEPER_BOT_HEALTH_BEARER_TOKEN must contain at least 32 characters`,
    );
  }
}

function auditServiceEnvironment(
  deployment: KeeperDeployment,
  environment: KeeperRuntimeEnvironment,
  errors: string[],
): void {
  const cluster = deployment === "production" ? "mainnet-beta" : "devnet";
  auditBaseEnvironment({
    deployment,
    expectedRole: "service",
    environment,
    errors,
  });
  capturePolicyError(errors, () =>
    assertServiceRuntimeIsolation({
      production: true,
      runtimeRole: normalizedValue(environment, "HYPERBET_RUNTIME_ROLE"),
      environment: { ...environment },
    }),
  );
  for (const key of SIGNER_SECRET_ENV_KEYS) {
    if (normalizedValue(environment, key)) {
      addError(errors, `service must not receive duel-bot secret ${key}`);
    }
  }
  for (const key of ["BET_SYNC_SOURCE_BEARER_TOKEN"] as const) {
    if (normalizedValue(environment, key)) {
      addError(errors, `service must not receive duel-bot secret ${key}`);
    }
  }

  capturePolicyError(errors, () =>
    resolveServiceHttpPolicy({ ...environment } as NodeJS.ProcessEnv),
  );
  capturePolicyError(errors, () =>
    resolveStreamStateSourceConfig({
      production: true,
      sourceUrl: environment.STREAM_STATE_SOURCE_URL,
      bearerToken: environment.STREAM_STATE_SOURCE_BEARER_TOKEN,
    }),
  );
  capturePolicyError(errors, () =>
    resolveKeeperBotHealthSourceConfig({
      production: true,
      sourceUrl: environment.KEEPER_BOT_HEALTH_URL,
      bearerToken: environment.KEEPER_BOT_HEALTH_BEARER_TOKEN,
      timeoutMs: Number(environment.KEEPER_BOT_HEALTH_TIMEOUT_MS ?? "3000"),
    }),
  );
  capturePolicyError(errors, () =>
    resolveOperatorAlertConfig({
      production: true,
      cluster,
      environment,
    }),
  );
  capturePolicyError(errors, () =>
    resolveClusterLifecycleIndexStartSlot({
      cluster,
      value: environment.SOLANA_LIFECYCLE_INDEX_START_SLOT,
    }),
  );

  if (deployment === "production") {
    requireValue(errors, environment, "HELIUS_API_KEY", "service");
  }
}

function auditDuelBotEnvironment(
  deployment: KeeperDeployment,
  environment: KeeperRuntimeEnvironment,
  errors: string[],
): void {
  const cluster = deployment === "production" ? "mainnet-beta" : "devnet";
  auditBaseEnvironment({
    deployment,
    expectedRole: "duel-bot",
    environment,
    errors,
  });
  capturePolicyError(errors, () =>
    assertDuelBotRuntimeRole({
      production: true,
      runtimeRole: normalizedValue(environment, "HYPERBET_RUNTIME_ROLE"),
    }),
  );
  for (const key of SERVICE_ONLY_SECRET_ENV_KEYS) {
    if (normalizedValue(environment, key)) {
      addError(errors, `duel-bot must not receive service-only secret ${key}`);
    }
  }

  capturePolicyError(errors, () =>
    resolveDuelBotHealthServerConfig({
      production: true,
      port: environment.BOT_HEALTH_PORT ?? environment.PORT ?? "8080",
      bearerToken: environment.KEEPER_BOT_HEALTH_BEARER_TOKEN,
      maxAgeMs: environment.READINESS_BOT_MAX_AGE_MS,
    }),
  );
  capturePolicyError(errors, () =>
    resolveDuelFeedConfig({
      cluster,
      gameUrl: normalizedValue(environment, "GAME_URL"),
      bearerToken: environment.BET_SYNC_SOURCE_BEARER_TOKEN,
    }),
  );
  const feedToken = requireValue(
    errors,
    environment,
    "BET_SYNC_SOURCE_BEARER_TOKEN",
    "duel-bot",
  );
  if (feedToken && feedToken.length < 32) {
    addError(
      errors,
      "duel-bot BET_SYNC_SOURCE_BEARER_TOKEN must contain at least 32 characters",
    );
  }

  let roleRefs: ReturnType<typeof resolveKeeperRoleRefs> | null = null;
  capturePolicyError(errors, () => {
    roleRefs = resolveKeeperRoleRefs({ ...environment });
  });
  if (roleRefs) {
    const refs = roleRefs;
    const requiredRuntimeRefs = [
      ["KEEPER_FEE_PAYER_KEYPAIR", refs.feePayerKeypair],
      ["ORACLE_REPORTER_KEYPAIR", refs.oracleReporterKeypair],
      ["ORACLE_FINALIZER_KEYPAIR", refs.oracleFinalizerKeypair],
      ["CLOB_MARKET_OPERATOR_KEYPAIR", refs.clobMarketOperatorKeypair],
      ["MARKET_MAKER_KEYPAIR", refs.marketMakerKeypair],
    ] as const;
    const seenRefs = new Map<string, string>();
    for (const [label, reference] of requiredRuntimeRefs) {
      const previous = seenRefs.get(reference);
      if (previous) {
        addError(
          errors,
          `non-local duel-bot keypair references must differ: ${previous} and ${label}`,
        );
      }
      seenRefs.set(reference, label);
    }

    let challenger: PublicKey | null = null;
    capturePolicyError(errors, () => {
      challenger = parseCanonicalPublicKey(
        refs.oracleChallengerWallet,
        "ORACLE_CHALLENGER_WALLET",
      );
    });
    const inlineRoles: Array<[string, PublicKey | null]> = [];
    for (const [label, reference] of [
      ...requiredRuntimeRefs,
      ["ORACLE_CONFIG_AUTHORITY_KEYPAIR", refs.oracleConfigAuthorityKeypair],
      ["CLOB_CONFIG_AUTHORITY_KEYPAIR", refs.clobConfigAuthorityKeypair],
    ] as const) {
      if (!reference) {
        inlineRoles.push([label, null]);
        continue;
      }
      let publicKey: PublicKey | null = null;
      capturePolicyError(errors, () => {
        publicKey = inlineKeypairPublicKey(reference, label);
      });
      inlineRoles.push([label, publicKey]);
    }
    const requiredInline = inlineRoles.slice(0, 5).map(([, key]) => key);
    if (challenger && requiredInline.every(Boolean)) {
      const rolePublicKeys: KeeperRolePublicKeys = {
        feePayer: requiredInline[0]!,
        oracleReporter: requiredInline[1]!,
        oracleFinalizer: requiredInline[2]!,
        oracleChallenger: challenger,
        clobMarketOperator: requiredInline[3]!,
        marketMaker: requiredInline[4]!,
        oracleConfigAuthority: inlineRoles[5]?.[1] ?? null,
        clobConfigAuthority: inlineRoles[6]?.[1] ?? null,
      };
      capturePolicyError(errors, () =>
        validateKeeperRoleSeparation(cluster, rolePublicKeys),
      );
      let feeTreasury: PublicKey | null = null;
      capturePolicyError(errors, () => {
        feeTreasury = resolveConfiguredLaunchWallet({
          cluster,
          envName: "TRADE_TREASURY_WALLET",
          configuredValue: environment.TRADE_TREASURY_WALLET,
          localFallback: PublicKey.default,
        });
      });
      if (feeTreasury) {
        capturePolicyError(errors, () =>
          validateKeeperFeeTreasurySeparation(
            cluster,
            rolePublicKeys,
            feeTreasury!,
          ),
        );
      }
    }
  }

  capturePolicyError(errors, () =>
    resolveConfiguredLaunchWallet({
      cluster,
      envName: "TRADE_TREASURY_WALLET",
      configuredValue: environment.TRADE_TREASURY_WALLET,
      localFallback: PublicKey.default,
    }),
  );
  capturePolicyError(errors, () =>
    resolveConfiguredLaunchWallet({
      cluster,
      envName: "TRADE_MARKET_MAKER_WALLET",
      configuredValue: environment.TRADE_MARKET_MAKER_WALLET,
      localFallback: PublicKey.default,
    }),
  );
  capturePolicyError(errors, () =>
    resolveOracleDisputeWindowSeconds({
      cluster,
      configuredValue: environment.SOLANA_ORACLE_DISPUTE_WINDOW_SECS,
    }),
  );
  capturePolicyError(errors, () =>
    resolveClusterLaunchFeePolicy({
      cluster,
      approval: environment.SOLANA_LAUNCH_FEE_POLICY_APPROVED,
      tradeTreasuryFeeBps: environment.TRADE_TREASURY_FEE_BPS,
      tradeMarketMakerFeeBps: environment.TRADE_MARKET_MAKER_FEE_BPS,
      winningsMarketMakerFeeBps: environment.WINNINGS_MARKET_MAKER_FEE_BPS,
    }),
  );
  capturePolicyError(errors, () =>
    resolveClusterManagedLiquidityRiskPolicy({
      cluster,
      approval: environment.SOLANA_LAUNCH_MARKET_MAKER_RISK_APPROVED,
      seedSol: environment.MARKET_MAKER_SEED_SOL,
      minQuoteSol: environment.MARKET_MAKER_MIN_QUOTE_SOL,
      referenceBidPriceMillis: environment.MARKET_MAKER_BID_PRICE,
      referenceAskPriceMillis: environment.MARKET_MAKER_ASK_PRICE,
      minQuotePriceMillis: environment.MARKET_MAKER_MIN_QUOTE_PRICE_MILLIS,
      maxQuotePriceMillis: environment.MARKET_MAKER_MAX_QUOTE_PRICE_MILLIS,
      maxInventorySolPerSide:
        environment.MARKET_MAKER_MAX_INVENTORY_SOL_PER_SIDE,
      maxNetExposureSol: environment.MARKET_MAKER_MAX_NET_EXPOSURE_SOL,
      maxGrossExposureSol: environment.MARKET_MAKER_MAX_GROSS_EXPOSURE_SOL,
      maxSideImbalanceBps: environment.MARKET_MAKER_MAX_SIDE_IMBALANCE_BPS,
      maxDrawdownBps: environment.MARKET_MAKER_MAX_DRAWDOWN_BPS,
    }),
  );
}

export function auditKeeperRuntimeEnvironmentPair(input: {
  deployment: KeeperDeployment;
  service: KeeperRuntimeEnvironment;
  duelBot: KeeperRuntimeEnvironment;
}): string[] {
  const errors: string[] = [];
  auditServiceEnvironment(input.deployment, input.service, errors);
  auditDuelBotEnvironment(input.deployment, input.duelBot, errors);

  for (const key of COMMON_MATCHING_ENV_KEYS) {
    const serviceValue = normalizedValue(input.service, key);
    const duelBotValue = normalizedValue(input.duelBot, key);
    if (serviceValue && duelBotValue && serviceValue !== duelBotValue) {
      addError(errors, `${key} must match across service and duel-bot`);
    }
  }
  for (const program of ["fight", "market"] as const) {
    const serviceAuthority = selectedUpgradeAuthority(input.service, program);
    const duelBotAuthority = selectedUpgradeAuthority(input.duelBot, program);
    if (
      serviceAuthority &&
      duelBotAuthority &&
      serviceAuthority !== duelBotAuthority
    ) {
      addError(
        errors,
        `${program} expected upgrade authority must match across service and duel-bot`,
      );
    }
  }

  return errors;
}

function readRailwayVariableValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "";
  if (value && typeof value === "object" && "value" in value) {
    return readRailwayVariableValue((value as { value: unknown }).value);
  }
  return null;
}

export function normalizeRailwayVariablePayload(
  payload: unknown,
): Record<string, string> {
  if (payload && typeof payload === "object" && "variables" in payload) {
    return normalizeRailwayVariablePayload(
      (payload as { variables: unknown }).variables,
    );
  }
  const environment: Record<string, string> = {};
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") {
        throw new Error(
          "Railway variable JSON array contains an invalid entry",
        );
      }
      const record = entry as Record<string, unknown>;
      const key =
        typeof record.name === "string"
          ? record.name
          : typeof record.key === "string"
            ? record.key
            : "";
      const value = readRailwayVariableValue(record.value);
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || value === null) {
        throw new Error(
          "Railway variable JSON array contains an invalid entry",
        );
      }
      if (Object.hasOwn(environment, key)) {
        throw new Error("Railway variable JSON contains a duplicate key");
      }
      environment[key] = value;
    }
    return environment;
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Railway variable JSON must be an object or array");
  }
  for (const [key, rawValue] of Object.entries(payload)) {
    const value = readRailwayVariableValue(rawValue);
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || value === null) {
      throw new Error("Railway variable JSON object contains an invalid entry");
    }
    environment[key] = value;
  }
  return environment;
}
