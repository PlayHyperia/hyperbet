export const FORBIDDEN_NON_SOLANA_ENV =
  /^(?:VITE_)?(?:EVM|BSC|BASE|AVAX|AVALANCHE|GOLD|PERPS|AMM)(?:_|$)|(?:^|_)(?:EVM|BSC|AVAX|AVALANCHE|GOLD|PERPS|AMM)(?:_|$)|(?:^|_)HYPERBET_BASE(?:_|$)/i;

export const TRACKED_SENSITIVE_ENV_KEYS = [
  "ARENA_EXTERNAL_BET_WRITE_KEY",
  "STREAM_PUBLISH_KEY",
  "STREAM_STATE_SOURCE_BEARER_TOKEN",
  "BET_SYNC_SOURCE_BEARER_TOKEN",
  "SOURCE_BET_SYNC_BEARER_TOKEN",
  "BETTING_FEED_ACCESS_TOKEN",
  "STREAMING_VIEWER_ACCESS_TOKEN",
  "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL",
  "HYPERBET_OPERATOR_ALERT_BEARER_TOKEN",
  "HELIUS_API_KEY",
  "BIRDEYE_API_KEY",
  "RAILWAY_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "KEEPER_BOT_HEALTH_BEARER_TOKEN",
  "BOT_KEYPAIR",
  "ORACLE_AUTHORITY_KEYPAIR",
  "KEEPER_FEE_PAYER_KEYPAIR",
  "ORACLE_REPORTER_KEYPAIR",
  "ORACLE_FINALIZER_KEYPAIR",
  "CLOB_MARKET_OPERATOR_KEYPAIR",
  "MARKET_MAKER_KEYPAIR",
  "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
  "CLOB_CONFIG_AUTHORITY_KEYPAIR",
  "SOLANA_PRIVATE_KEY",
  "SOLANA_BOOTSTRAP_KEYPAIR",
  "SOLANA_CANARY_KEYPAIR",
  "SOLANA_KEEPER_FEE_PAYER_KEYPAIR",
  "SOLANA_ORACLE_REPORTER_KEYPAIR",
  "SOLANA_ORACLE_FINALIZER_KEYPAIR",
  "SOLANA_CLOB_MARKET_OPERATOR_KEYPAIR",
  "SOLANA_MARKET_MAKER_KEYPAIR",
  "TESTNET_DEPLOYER_PRIVATE_KEY",
  "VITE_ARENA_WRITE_KEY",
  "VITE_HEADLESS_WALLET_SECRET_KEY",
  "VITE_HEADLESS_WALLETS",
  "E2E_ARENA_WRITE_KEY",
  "E2E_HYPERIA_BET_SYNC_BEARER_TOKEN",
  "E2E_SOLANA_BOOTSTRAP_KEYPAIR",
] as const;

const TRACKED_SENSITIVE_ENV_KEY_SET = new Set<string>(
  TRACKED_SENSITIVE_ENV_KEYS,
);
const GENERIC_SENSITIVE_ENV_KEY =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|KEYPAIR|BEARER)(?:_|$)|(?:^|_)(?:API|WRITE|PUBLISH)_KEY(?:_|$)/i;

export function isTrackedEnvPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "changeme" ||
    normalized === "<required>" ||
    normalized === "<placeholder>" ||
    normalized === "your-api-key" ||
    normalized === "your-token" ||
    normalized === "..." ||
    normalized.includes("path/to/") ||
    normalized.includes("~/.config/solana/") ||
    normalized.endsWith("/id.json")
  );
}

export function isTrackedSensitiveEnvKey(key: string): boolean {
  return (
    TRACKED_SENSITIVE_ENV_KEY_SET.has(key) ||
    GENERIC_SENSITIVE_ENV_KEY.test(key)
  );
}

export function findTrackedEnvPolicyErrors(
  relativePath: string,
  environment: Readonly<Record<string, string>>,
): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(environment)) {
    if (FORBIDDEN_NON_SOLANA_ENV.test(key)) {
      errors.push(
        `${relativePath} declares ${key}, which is outside the SOL-only v1 environment surface`,
      );
    }
    if (isTrackedSensitiveEnvKey(key) && !isTrackedEnvPlaceholder(value)) {
      errors.push(
        `${relativePath} contains a non-placeholder value for ${key}`,
      );
    }
  }

  return errors;
}
