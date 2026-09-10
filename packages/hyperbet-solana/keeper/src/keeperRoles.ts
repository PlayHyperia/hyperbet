import { PublicKey } from "@solana/web3.js";

export type KeeperRoleRefs = {
  feePayerKeypair: string;
  oracleReporterKeypair: string;
  oracleFinalizerKeypair: string;
  oracleChallengerWallet: string;
  clobMarketOperatorKeypair: string;
  marketMakerKeypair: string;
  oracleConfigAuthorityKeypair: string | null;
  clobConfigAuthorityKeypair: string | null;
};

export type KeeperRolePublicKeys = {
  feePayer: PublicKey;
  oracleReporter: PublicKey;
  oracleFinalizer: PublicKey;
  oracleChallenger: PublicKey;
  clobMarketOperator: PublicKey;
  marketMaker: PublicKey;
  oracleConfigAuthority: PublicKey | null;
  clobConfigAuthority: PublicKey | null;
};

const REQUIRED_ROLE_ENV = {
  feePayerKeypair: "KEEPER_FEE_PAYER_KEYPAIR",
  oracleReporterKeypair: "ORACLE_REPORTER_KEYPAIR",
  oracleFinalizerKeypair: "ORACLE_FINALIZER_KEYPAIR",
  oracleChallengerWallet: "ORACLE_CHALLENGER_WALLET",
  clobMarketOperatorKeypair: "CLOB_MARKET_OPERATOR_KEYPAIR",
  marketMakerKeypair: "MARKET_MAKER_KEYPAIR",
} as const;

function requiredValue(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalValue(
  env: Record<string, string | undefined>,
  name: string,
): string | null {
  return env[name]?.trim() || null;
}

export function resolveKeeperRoleRefs(
  env: Record<string, string | undefined>,
): KeeperRoleRefs {
  return {
    feePayerKeypair: requiredValue(env, REQUIRED_ROLE_ENV.feePayerKeypair),
    oracleReporterKeypair: requiredValue(
      env,
      REQUIRED_ROLE_ENV.oracleReporterKeypair,
    ),
    oracleFinalizerKeypair: requiredValue(
      env,
      REQUIRED_ROLE_ENV.oracleFinalizerKeypair,
    ),
    oracleChallengerWallet: requiredValue(
      env,
      REQUIRED_ROLE_ENV.oracleChallengerWallet,
    ),
    clobMarketOperatorKeypair: requiredValue(
      env,
      REQUIRED_ROLE_ENV.clobMarketOperatorKeypair,
    ),
    marketMakerKeypair: requiredValue(
      env,
      REQUIRED_ROLE_ENV.marketMakerKeypair,
    ),
    oracleConfigAuthorityKeypair: optionalValue(
      env,
      "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
    ),
    clobConfigAuthorityKeypair: optionalValue(
      env,
      "CLOB_CONFIG_AUTHORITY_KEYPAIR",
    ),
  };
}

function normalizeLaunchCluster(
  cluster: string,
): "localnet" | "devnet" | "testnet" | "mainnet" | "mainnet-beta" {
  const normalized = cluster.trim().toLowerCase();
  if (
    normalized !== "localnet" &&
    normalized !== "devnet" &&
    normalized !== "testnet" &&
    normalized !== "mainnet" &&
    normalized !== "mainnet-beta"
  ) {
    throw new Error(`Unsupported Solana keeper-role cluster '${cluster}'`);
  }
  return normalized;
}

export function resolveConfiguredLaunchWallet(input: {
  cluster: string;
  envName: string;
  configuredValue: string | undefined;
  localFallback: PublicKey;
}): PublicKey {
  const cluster = normalizeLaunchCluster(input.cluster);

  const configuredValue = input.configuredValue?.trim();
  if (!configuredValue) {
    if (cluster !== "localnet") {
      throw new Error(
        `${input.envName} must be explicitly configured outside localnet`,
      );
    }
    return input.localFallback;
  }

  try {
    const wallet = new PublicKey(configuredValue);
    if (
      wallet.equals(PublicKey.default) ||
      wallet.toBase58() !== configuredValue
    ) {
      throw new Error("noncanonical public key");
    }
    return wallet;
  } catch {
    throw new Error(`${input.envName} must be a canonical Solana public key`);
  }
}

export function validateKeeperRoleSeparation(
  cluster: string,
  roles: KeeperRolePublicKeys,
): void {
  if (normalizeLaunchCluster(cluster) === "localnet") return;

  const automatedRoles: Array<[string, PublicKey]> = [
    ["fee payer", roles.feePayer],
    ["oracle reporter", roles.oracleReporter],
    ["oracle finalizer", roles.oracleFinalizer],
    ["CLOB market operator", roles.clobMarketOperator],
    ["market maker", roles.marketMaker],
  ];
  const seen = new Map<string, string>();
  for (const [label, key] of automatedRoles) {
    const address = key.toBase58();
    const previous = seen.get(address);
    if (previous) {
      throw new Error(
        `Non-local keeper roles must use distinct wallets: ${previous} and ${label} both resolve to ${address}`,
      );
    }
    seen.set(address, label);
  }

  const challengerAddress = roles.oracleChallenger.toBase58();
  const challengerCollision = seen.get(challengerAddress);
  if (challengerCollision) {
    throw new Error(
      `Non-local oracle challenger must be independent from automated keeper roles: it matches ${challengerCollision}`,
    );
  }

  for (const [label, key] of [
    ["oracle config authority", roles.oracleConfigAuthority],
    ["CLOB config authority", roles.clobConfigAuthority],
  ] as Array<[string, PublicKey | null]>) {
    if (!key) continue;
    const address = key.toBase58();
    const runtimeCollision = seen.get(address);
    if (runtimeCollision || address === challengerAddress) {
      throw new Error(
        `Non-local ${label} must be independent from runtime and challenger wallets: it matches ${runtimeCollision ?? "oracle challenger"}`,
      );
    }
  }
}

export function validateKeeperFeeTreasurySeparation(
  cluster: string,
  roles: KeeperRolePublicKeys,
  feeTreasury: PublicKey,
): void {
  if (normalizeLaunchCluster(cluster) === "localnet") return;

  const treasuryAddress = feeTreasury.toBase58();
  const reservedRoles: Array<[string, PublicKey | null]> = [
    ["fee payer", roles.feePayer],
    ["oracle reporter", roles.oracleReporter],
    ["oracle finalizer", roles.oracleFinalizer],
    ["oracle challenger", roles.oracleChallenger],
    ["CLOB market operator", roles.clobMarketOperator],
    ["market maker", roles.marketMaker],
    ["oracle config authority", roles.oracleConfigAuthority],
    ["CLOB config authority", roles.clobConfigAuthority],
  ];
  const collision = reservedRoles.find(
    ([, role]) => role?.toBase58() === treasuryAddress,
  );
  if (collision) {
    throw new Error(
      `Non-local fee treasury must be independent from keeper roles: it matches ${collision[0]}`,
    );
  }
}
