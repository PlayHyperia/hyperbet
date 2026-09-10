import { resolveSolanaV1Deployment } from "../../../deployments/v1";
import { resolveSolanaTransactionAuthority } from "./realValueLaunchPolicy";
import { buildSolanaRpcProxyUrl } from "./runtimeUrls";

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

function buildSolanaProgramConfig(
  environment: Environment,
): Pick<EnvConfig, "fightOracleProgramId" | "duelMarketProgramId"> {
  const deployment = resolveSolanaV1Deployment(environment);
  return {
    fightOracleProgramId: deployment.fightOracleProgramId,
    duelMarketProgramId: deployment.duelMarketProgramId,
  };
}

export interface EnvConfig {
  cluster: SolanaCluster;
  rpcUrl: string;
  wsUrl?: string;
  fightOracleProgramId: string;
  duelMarketProgramId: string;
  betWindowSeconds: number;
  newRoundBetWindowSeconds: number;
  autoSeedDelaySeconds: number;
  marketMakerSeedSol: number;
  betFeeBps: number;
  binaryMarketMakerWallet?: string;
  binaryTradeTreasuryWallet?: string;
  binaryTradeMarketMakerWallet?: string;
  enableAutoSeed: boolean;
  gameApiUrl: string;
  gameWsUrl: string;
  streamUrl: string;
  transactionsEnabled: boolean;
  uiSyncDelayMs: number;
  refreshIntervalMs: number;
  headlessWalletName: string;
  headlessWalletAutoConnect: boolean;
  headlessWalletSecretKey: string;
  headlessWalletsJson: string;
  jupiterBaseUrl: string;
}

const DEFAULT_STREAM_URL = "";
const DEFAULT_STREAM_FALLBACK_URL = "";
const DEFAULT_GAME_API_URL = "http://127.0.0.1:5555";
const DEFAULT_PRODUCTION_GAME_API_URL = "";

const baseConfig: Partial<EnvConfig> = {
  betWindowSeconds: 300,
  newRoundBetWindowSeconds: 300,
  autoSeedDelaySeconds: 10,
  marketMakerSeedSol: 1,
  betFeeBps: 100,
  binaryMarketMakerWallet: "",
  binaryTradeTreasuryWallet: "",
  binaryTradeMarketMakerWallet: "",
  enableAutoSeed: true,
  gameApiUrl: DEFAULT_GAME_API_URL,
  gameWsUrl: `${DEFAULT_GAME_API_URL.replace(/^http/, "ws")}/ws`,
  streamUrl: DEFAULT_STREAM_URL,
  transactionsEnabled: false,
  refreshIntervalMs: 5000,
  jupiterBaseUrl: "https://lite-api.jup.ag",

  headlessWalletSecretKey:
    import.meta.env.VITE_HEADLESS_WALLET_SECRET_KEY || "",
  headlessWalletsJson: import.meta.env.VITE_HEADLESS_WALLETS || "",
};

const ENV_CONFIGS: Record<Environment, EnvConfig> = {
  devnet: {
    ...baseConfig,
    ...buildSolanaProgramConfig("devnet"),
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
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    wsUrl: "ws://127.0.0.1:8900",
    streamUrl: "",
    uiSyncDelayMs: 0,
    headlessWalletName: "Headless Test Wallet",
    headlessWalletAutoConnect: false,
  } as EnvConfig,
  e2e: {
    ...baseConfig,
    ...buildSolanaProgramConfig("localnet"),
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    wsUrl: "ws://127.0.0.1:8900",
    streamUrl: "",
    enableAutoSeed: false,
    refreshIntervalMs: 1500,
    uiSyncDelayMs: 0,
    headlessWalletName: "E2E Wallet",
    headlessWalletAutoConnect: true,
  } as EnvConfig,
  "stream-ui": {
    ...baseConfig,
    ...buildSolanaProgramConfig("devnet"),
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    fightOracleProgramId: "11111111111111111111111111111111",
    streamUrl: "",
    enableAutoSeed: false,
    refreshIntervalMs: 60000,
    uiSyncDelayMs: 0,
    headlessWalletName: "Stream UI Dev",
    headlessWalletAutoConnect: false,
  } as EnvConfig,
  "mainnet-beta": {
    ...baseConfig,
    ...buildSolanaProgramConfig("mainnet-beta"),
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
  envStreamUrl ??
  (suppressDefaultStreamFallback ? "" : baseEnvConfig.streamUrl);
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

export const CONFIG: EnvConfig = {
  ...baseEnvConfig,
  rpcUrl: readEnvString("VITE_SOLANA_RPC_URL") ?? baseEnvConfig.rpcUrl,
  wsUrl: readEnvString("VITE_SOLANA_WS_URL") ?? baseEnvConfig.wsUrl,
  fightOracleProgramId:
    readEnvString("VITE_FIGHT_ORACLE_PROGRAM_ID") ??
    baseEnvConfig.fightOracleProgramId,
  duelMarketProgramId:
    readEnvString("VITE_DUEL_MARKET_PROGRAM_ID") ??
    baseEnvConfig.duelMarketProgramId,
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
  marketMakerSeedSol: readEnvNumber(
    "VITE_MARKET_MAKER_SEED_SOL",
    baseEnvConfig.marketMakerSeedSol,
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
  enableAutoSeed: readEnvBoolean(
    "VITE_ENABLE_AUTO_SEED",
    baseEnvConfig.enableAutoSeed,
  ),
  gameApiUrl: resolvedGameApiUrl,
  gameWsUrl: resolvedGameWsUrl,
  streamUrl: resolvedStreamUrl,
  transactionsEnabled: resolveSolanaTransactionAuthority({
    cluster: baseEnvConfig.cluster,
    requested: readEnvBoolean(
      "VITE_TRANSACTIONS_ENABLED",
      baseEnvConfig.transactionsEnabled,
    ),
  }).enabled,
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
};

export const DEFAULT_BET_WINDOW_SECONDS = CONFIG.betWindowSeconds;
export const DEFAULT_NEW_ROUND_BET_WINDOW_SECONDS =
  CONFIG.newRoundBetWindowSeconds;
export const DEFAULT_AUTO_SEED_DELAY_SECONDS = CONFIG.autoSeedDelaySeconds;
export const DEFAULT_SEED_SOL_AMOUNT = CONFIG.marketMakerSeedSol;
export const DEFAULT_BET_FEE_BPS = CONFIG.betFeeBps;
export const DEFAULT_REFRESH_INTERVAL_MS = CONFIG.refreshIntervalMs;

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
  return import.meta.env.DEV && isLoopbackRpcUrl(CONFIG.rpcUrl);
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
  return buildSolanaRpcProxyUrl({
    configuredBase: GAME_API_URL,
    browserOrigin:
      typeof window !== "undefined" ? window.location.origin : null,
    cluster: CONFIG.cluster,
  });
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
