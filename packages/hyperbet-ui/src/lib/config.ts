import { PublicKey } from "@solana/web3.js";

import {
  type BettingAppEnvironment,
  type BettingEvmDeployment,
  type BettingEvmChain,
  type BettingEvmNetwork,
  BETTING_EVM_CHAIN_ORDER,
  defaultRpcUrlForEvmNetwork,
  getEvmRuntimeConfig,
  resolveBettingEvmDefaults,
  resolveBettingSolanaDeployment,
} from "@hyperbet/chain-registry";

export type SolanaCluster = "localnet" | "devnet" | "testnet" | "mainnet-beta";

// ============================================================================
// Environment Configuration
// ============================================================================

export type Environment =
  | "devnet"
  | "testnet"
  | "mainnet-beta"
  | "localnet"
  | "e2e"
  | "stream-ui";

const ENVIRONMENT_ALIASES: Record<string, Environment> = {
  development: "devnet",
  dev: "devnet",
  devnet: "devnet",
  testnet: "testnet",
  production: "mainnet-beta",
  prod: "mainnet-beta",
  mainnet: "mainnet-beta",
  "mainnet-beta": "mainnet-beta",
  local: "localnet",
  localnet: "localnet",
  e2e: "e2e",
  "stream-ui": "stream-ui",
};

function readEnvString(name: string): string | undefined {
  const rawValue = import.meta.env[name];
  if (typeof rawValue !== "string") return undefined;
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnvNumber(name: string, fallback: number): number {
  const rawValue = readEnvString(name);
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readEnvBoolean(name: string, fallback: boolean): boolean {
  const rawValue = readEnvString(name);
  if (!rawValue) return fallback;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  return fallback;
}

function parseEnvList(rawValue: string | undefined): string[] {
  if (!rawValue) return [];
  return rawValue
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function resolveEnvironment(): Environment {
  const explicitCluster = readEnvString("VITE_SOLANA_CLUSTER")?.toLowerCase();
  if (explicitCluster && ENVIRONMENT_ALIASES[explicitCluster]) {
    return ENVIRONMENT_ALIASES[explicitCluster];
  }

  const viteMode = readEnvString("MODE")?.toLowerCase();
  if (viteMode && ENVIRONMENT_ALIASES[viteMode]) {
    return ENVIRONMENT_ALIASES[viteMode];
  }

  return "devnet";
}

export const ACTIVE_ENV: Environment = resolveEnvironment();

function isPrivateIpv4Host(hostname: string): boolean {
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  const match = hostname.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const octet = Number.parseInt(match[1], 10);
  return Number.isFinite(octet) && octet >= 16 && octet <= 31;
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    isPrivateIpv4Host(hostname)
  );
}

function isPublicBrowserRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname.toLowerCase();
  return !isLocalHostname(hostname);
}

function resolveRuntimeEnvironment(buildEnv: Environment): Environment {
  if (!isPublicBrowserRuntime()) {
    return buildEnv;
  }
  if (buildEnv === "localnet" || buildEnv === "e2e") {
    return "mainnet-beta";
  }
  return buildEnv;
}

export const RUNTIME_ENV: Environment = resolveRuntimeEnvironment(ACTIVE_ENV);

function asDeploymentEnvironment(
  environment: Environment,
): BettingAppEnvironment {
  return environment;
}

type EvmChainEnvConfig = {
  chainId: number;
  rpcUrl: string;
  goldClobAddress: string;
  goldTokenAddress: string;
  networkKey: BettingEvmNetwork;
  deployment: BettingEvmDeployment;
};

function buildSolanaProgramConfig(
  environment: Environment,
): Pick<
  EnvConfig,
  | "fightOracleProgramId"
  | "goldClobMarketProgramId"
  | "goldPerpsMarketProgramId"
  | "goldMint"
  | "usdcMint"
> {
  const deployment = resolveBettingSolanaDeployment(environment);
  return {
    fightOracleProgramId: deployment.fightOracleProgramId,
    goldClobMarketProgramId: deployment.goldClobMarketProgramId,
    goldPerpsMarketProgramId: deployment.goldPerpsMarketProgramId,
    goldMint: deployment.goldMint,
    usdcMint: deployment.usdcMint,
  };
}

function buildEvmConfig(
  environment: Environment,
): Pick<
  EnvConfig,
  | "evmChains"
  | "bscRpcUrl"
  | "bscChainId"
  | "bscGoldClobAddress"
  | "bscGoldTokenAddress"
  | "baseRpcUrl"
  | "baseChainId"
  | "baseGoldClobAddress"
  | "baseGoldTokenAddress"
  | "avaxRpcUrl"
  | "avaxChainId"
  | "avaxGoldClobAddress"
  | "avaxGoldTokenAddress"
> {
  const defaults = resolveBettingEvmDefaults(
    asDeploymentEnvironment(environment),
  );
  const evmChains = {
    bsc: getEvmRuntimeConfig("bsc", asDeploymentEnvironment(environment)),
    base: getEvmRuntimeConfig("base", asDeploymentEnvironment(environment)),
    avax: getEvmRuntimeConfig("avax", asDeploymentEnvironment(environment)),
  } satisfies Record<BettingEvmChain, ReturnType<typeof getEvmRuntimeConfig>>;
  return {
    evmChains: {
      bsc: {
        chainId: evmChains.bsc.chainId,
        rpcUrl: evmChains.bsc.rpcUrl,
        goldClobAddress: evmChains.bsc.goldClobAddress,
        goldTokenAddress: evmChains.bsc.goldTokenAddress,
        networkKey: defaults.bsc.networkKey,
        deployment: evmChains.bsc.deployment,
      },
      base: {
        chainId: evmChains.base.chainId,
        rpcUrl: evmChains.base.rpcUrl,
        goldClobAddress: evmChains.base.goldClobAddress,
        goldTokenAddress: evmChains.base.goldTokenAddress,
        networkKey: defaults.base.networkKey,
        deployment: evmChains.base.deployment,
      },
      avax: {
        chainId: evmChains.avax.chainId,
        rpcUrl: evmChains.avax.rpcUrl,
        goldClobAddress: evmChains.avax.goldClobAddress,
        goldTokenAddress: evmChains.avax.goldTokenAddress,
        networkKey: defaults.avax.networkKey,
        deployment: evmChains.avax.deployment,
      },
    },
    bscRpcUrl: evmChains.bsc.rpcUrl,
    bscChainId: evmChains.bsc.chainId,
    bscGoldClobAddress: evmChains.bsc.goldClobAddress,
    bscGoldTokenAddress: evmChains.bsc.goldTokenAddress,
    baseRpcUrl: evmChains.base.rpcUrl,
    baseChainId: evmChains.base.chainId,
    baseGoldClobAddress: evmChains.base.goldClobAddress,
    baseGoldTokenAddress: evmChains.base.goldTokenAddress,
    avaxRpcUrl: evmChains.avax.rpcUrl,
    avaxChainId: evmChains.avax.chainId,
    avaxGoldClobAddress: evmChains.avax.goldClobAddress,
    avaxGoldTokenAddress: evmChains.avax.goldTokenAddress,
  };
}

export interface EnvConfig {
  cluster: SolanaCluster;
  rpcUrl: string;
  wsUrl?: string;
  fightOracleProgramId: string;
  goldClobMarketProgramId: string;
  goldPerpsMarketProgramId: string;
  goldMint: string;
  usdcMint?: string;
  betWindowSeconds: number;
  newRoundBetWindowSeconds: number;
  autoSeedDelaySeconds: number;
  marketMakerSeedGold: number;
  betFeeBps: number;
  binaryMarketMakerWallet?: string;
  binaryTradeTreasuryWallet?: string;
  binaryTradeMarketMakerWallet?: string;
  goldDecimals: number;
  enableAutoSeed: boolean;
  gameApiUrl: string;
  gameWsUrl: string;
  streamUrl: string;
  uiSyncDelayMs: number;
  refreshIntervalMs: number;
  headlessWalletName: string;
  headlessWalletAutoConnect: boolean;
  headlessWalletSecretKey: string;
  headlessWalletsJson: string;
  jupiterBaseUrl: string;

  // EVM
  evmChains: Partial<Record<BettingEvmChain, EvmChainEnvConfig>>;
  bscRpcUrl: string;
  bscChainId: number;
  bscGoldClobAddress: string;
  bscGoldTokenAddress: string;
  baseRpcUrl: string;
  baseChainId: number;
  baseGoldClobAddress: string;
  baseGoldTokenAddress: string;
  avaxRpcUrl: string;
  avaxChainId: number;
  avaxGoldClobAddress: string;
  avaxGoldTokenAddress: string;

  walletConnectProjectId: string;
}

const DEFAULT_STREAM_URL = "https://www.twitch.tv/hyperscapeai";
const DEFAULT_STREAM_FALLBACK_URL = "";
const DEFAULT_GAME_API_URL = "http://127.0.0.1:5555";
const DEFAULT_PRODUCTION_GAME_API_URL = "https://hyperbet-keeper.square-rain-7251.workers.dev";
const DEFAULT_LOCAL_STREAM_URL =
  "http://127.0.0.1:3333/stream.html?disableBridgeCapture=1";

const baseConfig: Partial<EnvConfig> = {
  betWindowSeconds: 300,
  newRoundBetWindowSeconds: 300,
  autoSeedDelaySeconds: 10,
  marketMakerSeedGold: 1,
  betFeeBps: 100,
  binaryMarketMakerWallet: "",
  binaryTradeTreasuryWallet: "",
  binaryTradeMarketMakerWallet: "",
  goldDecimals: 6,
  enableAutoSeed: true,
  gameApiUrl: DEFAULT_GAME_API_URL,
  gameWsUrl: `${DEFAULT_GAME_API_URL.replace(/^http/, "ws")}/ws`,
  streamUrl: DEFAULT_STREAM_URL,
  refreshIntervalMs: 5000,
  jupiterBaseUrl: "https://lite-api.jup.ag",

  headlessWalletSecretKey:
    import.meta.env.VITE_HEADLESS_WALLET_SECRET_KEY || "",
  headlessWalletsJson: import.meta.env.VITE_HEADLESS_WALLETS || "",

  walletConnectProjectId: (
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || ""
  ).trim(),
};

export const ENV_CONFIGS: Record<Environment, EnvConfig> = {
  devnet: {
    ...baseConfig,
    ...buildSolanaProgramConfig("devnet"),
    ...buildEvmConfig("devnet"),
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    wsUrl: "wss://api.devnet.solana.com/",
    uiSyncDelayMs: 0,
    headlessWalletName: "Headless Test Wallet",
    headlessWalletAutoConnect: false,
  } as EnvConfig,
  testnet: {
    ...baseConfig,
    ...buildSolanaProgramConfig("testnet"),
    ...buildEvmConfig("testnet"),
    cluster: "testnet",
    rpcUrl: "https://api.testnet.solana.com",
    wsUrl: "wss://api.testnet.solana.com/",
    uiSyncDelayMs: 0,
    headlessWalletName: "Headless Test Wallet",
    headlessWalletAutoConnect: false,
  } as EnvConfig,
  localnet: {
    ...baseConfig,
    ...buildSolanaProgramConfig("localnet"),
    ...buildEvmConfig("localnet"),
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    wsUrl: "ws://127.0.0.1:8900",
    streamUrl: DEFAULT_LOCAL_STREAM_URL,
    uiSyncDelayMs: 0,
    headlessWalletName: "Headless Test Wallet",
    headlessWalletAutoConnect: false,
  } as EnvConfig,
  e2e: {
    ...baseConfig,
    ...buildSolanaProgramConfig("localnet"),
    ...buildEvmConfig("e2e"),
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    wsUrl: "ws://127.0.0.1:8900",
    goldMint: "XeYyjz6Y351cyYDJAyghh6gJja9NF1ssiAXuem8YDyx",
    streamUrl: DEFAULT_LOCAL_STREAM_URL,
    enableAutoSeed: false,
    refreshIntervalMs: 1500,
    uiSyncDelayMs: 0,
    headlessWalletName: "E2E Wallet",
    headlessWalletAutoConnect: true,
  } as EnvConfig,
  "stream-ui": {
    ...baseConfig,
    ...buildSolanaProgramConfig("devnet"),
    ...buildEvmConfig("stream-ui"),
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    fightOracleProgramId: "11111111111111111111111111111111",
    streamUrl: DEFAULT_LOCAL_STREAM_URL,
    enableAutoSeed: false,
    refreshIntervalMs: 60000,
    uiSyncDelayMs: 0,
    headlessWalletName: "Stream UI Dev",
    headlessWalletAutoConnect: false,
  } as EnvConfig,
  "mainnet-beta": {
    ...baseConfig,
    ...buildSolanaProgramConfig("mainnet-beta"),
    ...buildEvmConfig("mainnet-beta"),
    cluster: "mainnet-beta",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    wsUrl: "wss://api.mainnet-beta.solana.com/",
    gameApiUrl: DEFAULT_PRODUCTION_GAME_API_URL,
    gameWsUrl: `${DEFAULT_PRODUCTION_GAME_API_URL.replace(/^http/, "ws")}/ws`,
    uiSyncDelayMs: 0,
    headlessWalletName: "Headless Test Wallet",
    headlessWalletAutoConnect: false,
  } as EnvConfig,
};

if (
  typeof window !== "undefined" &&
  ACTIVE_ENV !== RUNTIME_ENV &&
  typeof console !== "undefined"
) {
  console.warn(
    `[config] forcing runtime env '${RUNTIME_ENV}' on public host (build env '${ACTIVE_ENV}')`,
  );
}

const baseEnvConfig = ENV_CONFIGS[RUNTIME_ENV];
const envGameApiUrl = readEnvString("VITE_GAME_API_URL");
const resolvedGameApiUrl = envGameApiUrl ?? baseEnvConfig.gameApiUrl;
const envGameWsUrl = readEnvString("VITE_GAME_WS_URL");
const resolvedGameWsUrl =
  envGameWsUrl ?? `${resolvedGameApiUrl.replace(/^http/, "ws")}/ws`;
const envStreamUrl = readEnvString("VITE_STREAM_URL");
const envStreamSources = parseEnvList(readEnvString("VITE_STREAM_SOURCES"));
const suppressDefaultStreamFallback =
  envStreamUrl == null &&
  envStreamSources.length === 0 &&
  envGameApiUrl != null &&
  envGameApiUrl !== baseEnvConfig.gameApiUrl;
const defaultPrimaryStreamUrl =
  envStreamUrl ?? (suppressDefaultStreamFallback ? "" : baseEnvConfig.streamUrl);
const resolvedStreamSources = (() => {
  if (envStreamSources.length > 0) {
    return uniqueList(envStreamSources);
  }
  const envFallbackUrl = readEnvString("VITE_STREAM_FALLBACK_URL");
  const fallbackUrl =
    envFallbackUrl ??
    (defaultPrimaryStreamUrl && !suppressDefaultStreamFallback
      ? DEFAULT_STREAM_FALLBACK_URL
      : "");
  return uniqueList([defaultPrimaryStreamUrl, fallbackUrl ?? ""]).filter(
    (value) => value.length > 0,
  );
})();
const resolvedStreamUrl = resolvedStreamSources[0] ?? "";
const resolvedEvmChains = BETTING_EVM_CHAIN_ORDER.reduce<
  Record<BettingEvmChain, EvmChainEnvConfig>
>((acc, chainKey) => {
  const baseChainConfig = baseEnvConfig.evmChains[chainKey];
  if (!baseChainConfig) {
    return acc;
  }

  const envPrefix = chainKey.toUpperCase();
  acc[chainKey] = {
    chainId: readEnvNumber(
      `VITE_${envPrefix}_CHAIN_ID`,
      baseChainConfig.chainId,
    ),
    rpcUrl:
      readEnvString(`VITE_${envPrefix}_RPC_URL`) ?? baseChainConfig.rpcUrl,
    goldClobAddress:
      readEnvString(`VITE_${envPrefix}_GOLD_CLOB_ADDRESS`) ??
      baseChainConfig.goldClobAddress,
    goldTokenAddress:
      readEnvString(`VITE_${envPrefix}_GOLD_TOKEN_ADDRESS`) ??
      baseChainConfig.goldTokenAddress,
    networkKey: resolvedEvmNetworkKey(
      chainKey,
      readEnvNumber(`VITE_${envPrefix}_CHAIN_ID`, baseChainConfig.chainId),
    ),
    deployment: baseChainConfig.deployment,
  };
  return acc;
}, {} as Record<BettingEvmChain, EvmChainEnvConfig>);

export const CONFIG: EnvConfig = {
  ...baseEnvConfig,
  rpcUrl: readEnvString("VITE_SOLANA_RPC_URL") ?? baseEnvConfig.rpcUrl,
  wsUrl: readEnvString("VITE_SOLANA_WS_URL") ?? baseEnvConfig.wsUrl,
  fightOracleProgramId:
    readEnvString("VITE_FIGHT_ORACLE_PROGRAM_ID") ??
    baseEnvConfig.fightOracleProgramId,
  goldClobMarketProgramId:
    readEnvString("VITE_GOLD_CLOB_MARKET_PROGRAM_ID") ??
    baseEnvConfig.goldClobMarketProgramId,
  goldPerpsMarketProgramId:
    readEnvString("VITE_GOLD_PERPS_MARKET_PROGRAM_ID") ??
    baseEnvConfig.goldPerpsMarketProgramId,
  goldMint: readEnvString("VITE_GOLD_MINT") ?? baseEnvConfig.goldMint,
  usdcMint: readEnvString("VITE_USDC_MINT") ?? baseEnvConfig.usdcMint,
  betWindowSeconds: readEnvNumber(
    "VITE_BET_WINDOW_SECONDS",
    baseEnvConfig.betWindowSeconds,
  ),
  newRoundBetWindowSeconds: readEnvNumber(
    "VITE_NEW_ROUND_BET_WINDOW_SECONDS",
    baseEnvConfig.newRoundBetWindowSeconds,
  ),
  autoSeedDelaySeconds: readEnvNumber(
    "VITE_AUTO_SEED_DELAY_SECONDS",
    baseEnvConfig.autoSeedDelaySeconds,
  ),
  marketMakerSeedGold: readEnvNumber(
    "VITE_MARKET_MAKER_SEED_GOLD",
    baseEnvConfig.marketMakerSeedGold,
  ),
  betFeeBps: readEnvNumber("VITE_BET_FEE_BPS", baseEnvConfig.betFeeBps),
  binaryMarketMakerWallet:
    readEnvString("VITE_BINARY_MARKET_MAKER_WALLET") ??
    baseEnvConfig.binaryMarketMakerWallet,
  binaryTradeTreasuryWallet:
    readEnvString("VITE_BINARY_TRADE_TREASURY_WALLET") ??
    baseEnvConfig.binaryTradeTreasuryWallet,
  binaryTradeMarketMakerWallet:
    readEnvString("VITE_BINARY_TRADE_MARKET_MAKER_WALLET") ??
    baseEnvConfig.binaryTradeMarketMakerWallet,
  goldDecimals: readEnvNumber("VITE_GOLD_DECIMALS", baseEnvConfig.goldDecimals),
  enableAutoSeed: readEnvBoolean(
    "VITE_ENABLE_AUTO_SEED",
    baseEnvConfig.enableAutoSeed,
  ),
  gameApiUrl: resolvedGameApiUrl,
  gameWsUrl: resolvedGameWsUrl,
  streamUrl: resolvedStreamUrl,
  uiSyncDelayMs: readEnvNumber(
    "VITE_UI_SYNC_DELAY_MS",
    baseEnvConfig.uiSyncDelayMs,
  ),
  refreshIntervalMs: readEnvNumber(
    "VITE_REFRESH_INTERVAL_MS",
    baseEnvConfig.refreshIntervalMs,
  ),
  headlessWalletName:
    readEnvString("VITE_HEADLESS_WALLET_NAME") ??
    baseEnvConfig.headlessWalletName,
  headlessWalletAutoConnect: readEnvBoolean(
    "VITE_HEADLESS_WALLET_AUTO_CONNECT",
    baseEnvConfig.headlessWalletAutoConnect,
  ),
  headlessWalletSecretKey:
    readEnvString("VITE_HEADLESS_WALLET_SECRET_KEY") ??
    baseEnvConfig.headlessWalletSecretKey,
  headlessWalletsJson:
    readEnvString("VITE_HEADLESS_WALLETS") ?? baseEnvConfig.headlessWalletsJson,
  jupiterBaseUrl:
    readEnvString("VITE_JUPITER_BASE_URL") ?? baseEnvConfig.jupiterBaseUrl,
  evmChains: resolvedEvmChains,
  bscRpcUrl: resolvedEvmChains.bsc.rpcUrl,
  bscChainId: resolvedEvmChains.bsc.chainId,
  bscGoldClobAddress: resolvedEvmChains.bsc.goldClobAddress,
  bscGoldTokenAddress: resolvedEvmChains.bsc.goldTokenAddress,
  baseRpcUrl: resolvedEvmChains.base.rpcUrl,
  baseChainId: resolvedEvmChains.base.chainId,
  baseGoldClobAddress: resolvedEvmChains.base.goldClobAddress,
  baseGoldTokenAddress: resolvedEvmChains.base.goldTokenAddress,
  avaxRpcUrl: resolvedEvmChains.avax.rpcUrl,
  avaxChainId: resolvedEvmChains.avax.chainId,
  avaxGoldClobAddress: resolvedEvmChains.avax.goldClobAddress,
  avaxGoldTokenAddress: resolvedEvmChains.avax.goldTokenAddress,
  walletConnectProjectId:
    readEnvString("VITE_WALLETCONNECT_PROJECT_ID") ??
    baseEnvConfig.walletConnectProjectId,
};

// Legacy Exports mapping to CONFIG
export const GOLD_MAINNET_MINT = new PublicKey(
  "DK9nBUMfdu4XprPRWeh8f6KnQiGWD8Z4xz3yzs9gpump",
);

export const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

export const DEFAULT_BET_WINDOW_SECONDS = CONFIG.betWindowSeconds;
export const DEFAULT_NEW_ROUND_BET_WINDOW_SECONDS =
  CONFIG.newRoundBetWindowSeconds;
export const DEFAULT_AUTO_SEED_DELAY_SECONDS = CONFIG.autoSeedDelaySeconds;
export const DEFAULT_SEED_GOLD_AMOUNT = CONFIG.marketMakerSeedGold;
export const DEFAULT_BET_FEE_BPS = CONFIG.betFeeBps;
export const GOLD_DECIMALS = CONFIG.goldDecimals;
export const DEFAULT_REFRESH_INTERVAL_MS = CONFIG.refreshIntervalMs;

export function toBaseUnits(amount: number, decimals = GOLD_DECIMALS): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

export const STREAM_URL: string = CONFIG.streamUrl;
export const STREAM_URLS: string[] = resolvedStreamSources;
export const GAME_API_URL: string = CONFIG.gameApiUrl;
export const GAME_WS_URL: string = CONFIG.gameWsUrl;
export const UI_SYNC_DELAY_MS: number = CONFIG.uiSyncDelayMs;
// Mainnet must route through backend RPC proxy so we can use server-side
// Helius credentials and avoid browser-origin RPC blocking.
const USE_GAME_RPC_PROXY =
  CONFIG.cluster === "mainnet-beta"
    ? true
    : readEnvBoolean("VITE_USE_GAME_RPC_PROXY", false);
const USE_GAME_EVM_RPC_PROXY =
  CONFIG.cluster === "mainnet-beta"
    ? true
    : readEnvBoolean("VITE_USE_GAME_EVM_RPC_PROXY", false);
const LOCAL_SOLANA_RPC_PROXY_PREFIX = "/__solana";

function isLoopbackRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

const configuredManualMarketControls = readEnvBoolean(
  "VITE_ENABLE_MANUAL_MARKET_ADMIN_CONTROLS",
  RUNTIME_ENV === "localnet" || RUNTIME_ENV === "e2e",
);
export const ENABLE_MANUAL_MARKET_ADMIN_CONTROLS = isPublicBrowserRuntime()
  ? false
  : configuredManualMarketControls;

export function buildArenaWriteHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
  };
}

export function getFixedMatchId(): number | null {
  const id = import.meta.env.VITE_ACTIVE_MATCH_ID;
  if (!id) return null;
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getCluster(): SolanaCluster {
  return CONFIG.cluster;
}

function shouldUseLocalSolanaRpcProxy(): boolean {
  if (isPublicBrowserRuntime()) return false;
  const explicitOverride = readEnvString("VITE_USE_LOCAL_SOLANA_RPC_PROXY");
  if (explicitOverride === "true") return true;
  if (explicitOverride === "false") return false;
  if (import.meta.env.MODE === "e2e") return true;
  return Boolean(import.meta.env.DEV && isLoopbackRpcUrl(CONFIG.rpcUrl));
}

function buildLocalSolanaProxyUrl(
  pathname: string,
  protocol: "http" | "ws",
): string {
  if (typeof window === "undefined") {
    return `${LOCAL_SOLANA_RPC_PROXY_PREFIX}${pathname}`;
  }
  const resolvedProtocol =
    protocol === "ws"
      ? window.location.protocol === "https:"
        ? "wss:"
        : "ws:"
      : window.location.protocol;
  return `${resolvedProtocol}//${window.location.host}${LOCAL_SOLANA_RPC_PROXY_PREFIX}${pathname}`;
}

export function getRpcUrl(): string {
  if (shouldUseLocalSolanaRpcProxy()) {
    return buildLocalSolanaProxyUrl("/rpc", "http");
  }
  // Non-proxy environments (for example standalone dev) use direct RPC.
  if (!USE_GAME_RPC_PROXY || CONFIG.cluster === "localnet") {
    return CONFIG.rpcUrl;
  }
  return `${GAME_API_URL}/api/proxy/solana/rpc?cluster=${encodeURIComponent(CONFIG.cluster)}`;
}

export function getWsUrl(): string | undefined {
  if (shouldUseLocalSolanaRpcProxy() && typeof window !== "undefined") {
    return buildLocalSolanaProxyUrl("/ws", "ws");
  }
  if (!USE_GAME_RPC_PROXY) {
    return CONFIG.wsUrl;
  }
  if (CONFIG.cluster === "localnet" && CONFIG.wsUrl) {
    return CONFIG.wsUrl;
  }
  // Public builds proxy HTTP RPC through the keeper; websocket stays direct.
  return undefined;
}

// ============================================================================
// EVM Chain Configuration
// ============================================================================

function shouldUseGameEvmRpcProxy(): boolean {
  return USE_GAME_EVM_RPC_PROXY && CONFIG.cluster !== "localnet";
}

function resolvedEvmNetworkKey(
  chainKey: BettingEvmChain,
  chainId: number,
): BettingEvmNetwork {
  if (chainKey === "bsc") {
    return chainId === 56 ? "bsc" : "bscTestnet";
  }
  if (chainKey === "base") {
    return chainId === 8453 ? "base" : "baseSepolia";
  }
  return chainId === 43114 ? "avax" : "avaxFuji";
}

function getDirectEvmRpcUrl(chain: BettingEvmChain): string {
  return CONFIG.evmChains[chain]?.rpcUrl ?? defaultRpcUrlForEvmNetwork(
    resolveBettingEvmDefaults(asDeploymentEnvironment(RUNTIME_ENV))[chain]
      .networkKey,
  );
}

export function getEvmReadRpcUrl(chain: BettingEvmChain): string {
  if (shouldUseGameEvmRpcProxy()) {
    return `${GAME_API_URL}/api/proxy/evm/rpc?chain=${encodeURIComponent(chain)}`;
  }
  return getDirectEvmRpcUrl(chain);
}

export function getEvmSubmitRpcUrl(chain: BettingEvmChain): string {
  return getDirectEvmRpcUrl(chain);
}

export function getEvmRpcUrl(chain: BettingEvmChain): string {
  return getEvmReadRpcUrl(chain);
}

export const BSC_RPC_URL: string = getEvmReadRpcUrl("bsc");
export const BSC_CHAIN_ID: number = CONFIG.bscChainId;
export const BSC_GOLD_CLOB_ADDRESS: string = CONFIG.bscGoldClobAddress;
export const BSC_GOLD_TOKEN_ADDRESS: string = CONFIG.bscGoldTokenAddress;

export const BASE_RPC_URL: string = getEvmReadRpcUrl("base");
export const BASE_CHAIN_ID: number = CONFIG.baseChainId;
export const BASE_GOLD_CLOB_ADDRESS: string = CONFIG.baseGoldClobAddress;
export const BASE_GOLD_TOKEN_ADDRESS: string = CONFIG.baseGoldTokenAddress;

export const AVAX_RPC_URL: string = getEvmReadRpcUrl("avax");
export const AVAX_CHAIN_ID: number = CONFIG.avaxChainId;
export const AVAX_GOLD_CLOB_ADDRESS: string = CONFIG.avaxGoldClobAddress;
export const AVAX_GOLD_TOKEN_ADDRESS: string = CONFIG.avaxGoldTokenAddress;
