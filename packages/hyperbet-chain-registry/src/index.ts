export type BettingSolanaCluster =
  | "localnet"
  | "devnet"
  | "testnet"
  | "mainnet-beta";
export type BettingAppEnvironment = BettingSolanaCluster | "e2e" | "stream-ui";
export type BettingEvmNetwork =
  | "bscTestnet"
  | "bsc"
  | "baseSepolia"
  | "base"
  | "avaxFuji"
  | "avax";
export type BettingEvmChain = "bsc" | "base" | "avax";
export type BettingChainKey = "solana" | BettingEvmChain;
export type RecordedBetChain = "SOLANA" | "BSC" | "BASE" | "AVAX";
export type BettingTargetKind = "testnet" | "mainnet";
export const PREDICTION_MARKET_LIFECYCLE_STATUSES = [
  "PENDING",
  "OPEN",
  "LOCKED",
  "PROPOSED",
  "CHALLENGED",
  "RESOLVED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type PredictionMarketLifecycleStatus =
  (typeof PREDICTION_MARKET_LIFECYCLE_STATUSES)[number];
export const PREDICTION_MARKET_TERMINAL_STATUSES = [
  "RESOLVED",
  "CANCELLED",
] as const;
export const PREDICTION_MARKET_IN_FLIGHT_RESOLUTION_STATUSES = [
  "PROPOSED",
  "CHALLENGED",
] as const;
export const PREDICTION_MARKET_RESERVED_METADATA_KEYS = [
  "proposalId",
  "challengeWindowEndsAt",
  "finalizedAt",
  "cancellationReason",
] as const;
export type PredictionMarketWinner = "NONE" | "A" | "B";
export type PredictionMarketType = "clob" | "amm";
export type PredictionMarketReservedMetadataKey =
  (typeof PREDICTION_MARKET_RESERVED_METADATA_KEYS)[number];

export interface PredictionMarketLifecycleMetadata
  extends Record<string, unknown> {
  proposalId?: string | null;
  challengeWindowEndsAt?: number | null;
  finalizedAt?: number | null;
  cancellationReason?: string | null;
}

export interface NativeCurrencyConfig {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainFeatureFlags {
  predictionMarkets: boolean;
  perps: boolean;
  amm: boolean;
}

export interface BettingSolanaDeployment {
  cluster: BettingSolanaCluster;
  fightOracleProgramId: string;
  goldClobMarketProgramId: string;
  goldPerpsMarketProgramId: string;
  goldAmmMarketProgramId: string;
  goldMint: string;
  usdcMint: string;
}

export interface EvmChainUiMeta {
  shortName: string;
  color: string;
  icon: string;
}

export interface BettingEvmDeployment {
  networkKey: BettingEvmNetwork;
  chain: BettingEvmChain;
  chainId: number;
  label: string;
  targetKind: BettingTargetKind;
  rpcEnvVar: string;
  duelOracleAddress: string;
  goldClobAddress: string;
  goldAmmRouterAddress: string;
  mUsdTokenAddress: string;
  adminAddress: string;
  marketOperatorAddress: string;
  treasuryAddress: string;
  marketMakerAddress: string;
  reporterAddress: string;
  finalizerAddress: string;
  challengerAddress: string;
  timelockAddress: string;
  multisigAddress: string;
  emergencyCouncilAddress: string;
  deploymentVersion: string;
  goldTokenAddress: string;
  skillOracleAddress: string;
  perpEngineAddress: string;
  nativeCurrency: NativeCurrencyConfig;
  blockExplorerUrl: string;
  featureFlags: ChainFeatureFlags;
  /** Aliases used by normalizeChainKey / normalizePredictionMarketChainKey */
  aliases: readonly string[];
  /** The native asset symbol for this chain (e.g. "BNB", "ETH", "AVAX") */
  nativeAsset: string;
  /** Default public RPC URL (no API key required) */
  defaultRpcUrl: string;
  /** UI display metadata */
  uiMeta: EvmChainUiMeta;
}

export interface BettingDeploymentManifest {
  solana: Record<BettingSolanaCluster, BettingSolanaDeployment>;
  evm: Record<BettingEvmNetwork, BettingEvmDeployment>;
}

export const BETTING_SOLANA_CANONICAL_FIELDS = [
  "fightOracleProgramId",
  "goldClobMarketProgramId",
] as const;

export type BettingSolanaCanonicalField =
  (typeof BETTING_SOLANA_CANONICAL_FIELDS)[number];

export const BETTING_SOLANA_AMM_FIELDS = [
  "goldAmmMarketProgramId",
  "usdcMint",
] as const;

export type BettingSolanaAmmField =
  (typeof BETTING_SOLANA_AMM_FIELDS)[number];

export const BETTING_SOLANA_PERPS_FIELDS = [
  "goldPerpsMarketProgramId",
  "goldMint",
] as const;

export type BettingSolanaPerpsField =
  (typeof BETTING_SOLANA_PERPS_FIELDS)[number];

export const BETTING_SOLANA_FULL_PRODUCT_FIELDS = [
  ...BETTING_SOLANA_CANONICAL_FIELDS,
  ...BETTING_SOLANA_AMM_FIELDS,
  ...BETTING_SOLANA_PERPS_FIELDS,
] as const;

export type BettingSolanaFullProductField =
  (typeof BETTING_SOLANA_FULL_PRODUCT_FIELDS)[number];

export const BETTING_SOLANA_RELEASE_FIELDS = [
  ...BETTING_SOLANA_FULL_PRODUCT_FIELDS,
] as const;

export type BettingSolanaReleaseField =
  (typeof BETTING_SOLANA_RELEASE_FIELDS)[number];

export const BETTING_EVM_CANONICAL_ADDRESS_FIELDS = [
  "duelOracleAddress",
  "goldClobAddress",
  "adminAddress",
  "marketOperatorAddress",
  "treasuryAddress",
  "marketMakerAddress",
] as const;

export type BettingEvmCanonicalAddressField =
  (typeof BETTING_EVM_CANONICAL_ADDRESS_FIELDS)[number];

export const BETTING_EVM_AMM_ADDRESS_FIELDS = [
  "goldAmmRouterAddress",
  "mUsdTokenAddress",
] as const;

export type BettingEvmAmmAddressField =
  (typeof BETTING_EVM_AMM_ADDRESS_FIELDS)[number];

export const BETTING_EVM_PERPS_ADDRESS_FIELDS = [
  "goldTokenAddress",
  "skillOracleAddress",
  "perpEngineAddress",
] as const;

export type BettingEvmPerpsAddressField =
  (typeof BETTING_EVM_PERPS_ADDRESS_FIELDS)[number];

export const BETTING_EVM_GOVERNANCE_ADDRESS_FIELDS = [
  "reporterAddress",
  "finalizerAddress",
  "challengerAddress",
  "timelockAddress",
  "multisigAddress",
  "emergencyCouncilAddress",
] as const;

export type BettingEvmGovernanceAddressField =
  (typeof BETTING_EVM_GOVERNANCE_ADDRESS_FIELDS)[number];

export const BETTING_EVM_FULL_PRODUCT_ADDRESS_FIELDS = [
  ...BETTING_EVM_CANONICAL_ADDRESS_FIELDS,
  ...BETTING_EVM_AMM_ADDRESS_FIELDS,
  ...BETTING_EVM_PERPS_ADDRESS_FIELDS,
] as const;

export type BettingEvmFullProductAddressField =
  (typeof BETTING_EVM_FULL_PRODUCT_ADDRESS_FIELDS)[number];

export const BETTING_EVM_RELEASE_ADDRESS_FIELDS = [
  ...BETTING_EVM_FULL_PRODUCT_ADDRESS_FIELDS,
  ...BETTING_EVM_GOVERNANCE_ADDRESS_FIELDS,
] as const;

export type BettingEvmReleaseAddressField =
  (typeof BETTING_EVM_RELEASE_ADDRESS_FIELDS)[number];

export interface EvmChainRuntimeConfig {
  chainKey: BettingEvmChain;
  chainId: number;
  rpcUrl: string;
  goldClobAddress: string;
  goldTokenAddress: string;
  deployment: BettingEvmDeployment;
}

export interface ResolvedBettingEvmRuntimeEnv {
  chainKey: BettingEvmChain;
  deployment: BettingEvmDeployment;
  rpcUrl: string;
  duelOracleAddress: string;
  goldClobAddress: string;
  goldAmmRouterAddress: string;
  mUsdTokenAddress: string;
}

export interface ExternalBetRecordPayload {
  bettorWallet: string;
  chain?: string | null;
  chainKey?: string | null;
  sourceAsset?: string | null;
  sourceAmount?: number | string | bigint | null;
  goldAmount?: number | string | bigint | null;
  feeBps?: number | string | bigint | null;
  txSignature?: string | null;
  marketPda?: string | null;
  marketRef?: string | null;
  duelKey?: string | null;
  duelId?: string | null;
  inviteCode?: string | null;
  externalBetRef?: string | null;
}

export interface PredictionMarketLifecycleRecord {
  chainKey: BettingChainKey;
  duelKey: string | null;
  duelId: string | null;
  marketId: string | null;
  marketRef: string | null;
  lifecycleStatus: PredictionMarketLifecycleStatus;
  winner: PredictionMarketWinner;
  betCloseTime: number | null;
  contractAddress: string | null;
  programId: string | null;
  txRef: string | null;
  syncedAt: number | null;
  metadata?: PredictionMarketLifecycleMetadata;
  marketType?: PredictionMarketType;
}

export const BETTING_SOLANA_CLUSTERS: BettingSolanaCluster[] = [
  "localnet",
  "devnet",
  "testnet",
  "mainnet-beta",
] as const;

export const BETTING_EVM_NETWORKS: BettingEvmNetwork[] = [
  "bscTestnet",
  "bsc",
  "baseSepolia",
  "base",
  "avaxFuji",
  "avax",
] as const;

export const BETTING_EVM_CHAIN_ORDER: BettingEvmChain[] = [
  "bsc",
  "base",
  "avax",
] as const;

export const BETTING_LAUNCH_SOLANA_CLUSTER: BettingSolanaCluster =
  "mainnet-beta";

export const BETTING_LAUNCH_EVM_CHAIN_ORDER: BettingEvmChain[] = [
  "bsc",
  "avax",
] as const;

const DEFAULT_FEATURE_FLAGS: ChainFeatureFlags = {
  predictionMarkets: true,
  perps: false,
  amm: false,
};

const SOLANA_DEPLOYMENTS: Record<BettingSolanaCluster, BettingSolanaDeployment> =
  {
    localnet: {
      cluster: "localnet",
      fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
      goldClobMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
      goldPerpsMarketProgramId: "BFbmQbSbf3R6fMDdXKMKQZCTyMhMs9MCcjAhGDBLETXS",
      goldAmmMarketProgramId: "12E8Lz5w8Qxyj8Fh6LgsCgPDQNJMCLMV1y43LhPrH66w",
      goldMint: "DK9nBUMfdu4XprPRWeh8f6KnQiGWD8Z4xz3yzs9gpump",
      usdcMint: "",
    },
    devnet: {
      cluster: "devnet",
      fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
      goldClobMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
      goldPerpsMarketProgramId: "BFbmQbSbf3R6fMDdXKMKQZCTyMhMs9MCcjAhGDBLETXS",
      goldAmmMarketProgramId: "12E8Lz5w8Qxyj8Fh6LgsCgPDQNJMCLMV1y43LhPrH66w",
      goldMint: "DK9nBUMfdu4XprPRWeh8f6KnQiGWD8Z4xz3yzs9gpump",
      usdcMint: "",
    },
    testnet: {
      cluster: "testnet",
      fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
      goldClobMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
      goldPerpsMarketProgramId: "BFbmQbSbf3R6fMDdXKMKQZCTyMhMs9MCcjAhGDBLETXS",
      goldAmmMarketProgramId: "12E8Lz5w8Qxyj8Fh6LgsCgPDQNJMCLMV1y43LhPrH66w",
      goldMint: "",
      usdcMint: "",
    },
    "mainnet-beta": {
      cluster: "mainnet-beta",
      fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
      goldClobMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
      goldPerpsMarketProgramId: "6YjWiway8kaSjwtAinJxqWPvV3DqBVapDWAsSEZjjmbP",
      goldAmmMarketProgramId: "",
      goldMint: "DK9nBUMfdu4XprPRWeh8f6KnQiGWD8Z4xz3yzs9gpump",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  };

const EVM_DEPLOYMENTS: Record<BettingEvmNetwork, BettingEvmDeployment> = {
  bscTestnet: {
    networkKey: "bscTestnet",
    chain: "bsc",
    chainId: 97,
    label: "BSC Testnet",
    targetKind: "testnet",
    rpcEnvVar: "BSC_TESTNET_RPC",
    duelOracleAddress: "0x5B0a0D5cf66F2A725560fCdb3bF74067c8c50A3C",
    goldClobAddress: "0xb7b2833875A17d5E5401C310C694Bb75a21a2582",
    goldAmmRouterAddress: "0xc053e98CC2Ef1CF1328E6c9d467B433E1abcEf6d",
    mUsdTokenAddress: "0x08e621f503aCe8cCCE745fe7441561536AE8445F",
    adminAddress: "0xd75676D9466db83a74E55572e45828751e2e8101",
    marketOperatorAddress: "0x7E82E3553f1baB7964c6dbd760d565be14D566bb",
    treasuryAddress: "0xae6bd4dAC4731995980EEdFF70ccC6B29E8FbD62",
    marketMakerAddress: "0xc2Aac21a8bb955c3D6a76b77A9824C8cd81d6f5B",
    reporterAddress: "0x8FA91419FDC9d25A646c6B9684C148DeFa1C2df0",
    finalizerAddress: "0x67e3078B238F9eAA04C60834ccCc6A4685F704b7",
    challengerAddress: "0x3A123B14bca41E14d12d4854F6a1180ECC38b42b",
    timelockAddress: "",
    multisigAddress: "",
    emergencyCouncilAddress: "0xdeB6a5897C5B2FbB3C7dCe821b5ffe69aeA60d51",
    deploymentVersion: "v3",
    goldTokenAddress: "0xB5e215607565808d00b16c69a8074d35060438DE",
    skillOracleAddress: "0x9064B86E9050bb9C01868B36740D6d9F12a18F0d",
    perpEngineAddress: "0x0c6c9B3A7C374F121a0Ad0bBFB01945d1F567cfc",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    blockExplorerUrl: "https://testnet.bscscan.com",
    featureFlags: DEFAULT_FEATURE_FLAGS,
    aliases: ["bsc", "bnb"],
    nativeAsset: "BNB",
    defaultRpcUrl: "https://data-seed-prebsc-1-s1.binance.org:8545",
    uiMeta: { shortName: "BSC", color: "#F0B90B", icon: "💎" },
  },
  bsc: {
    networkKey: "bsc",
    chain: "bsc",
    chainId: 56,
    label: "BNB Smart Chain",
    targetKind: "mainnet",
    rpcEnvVar: "BSC_MAINNET_RPC",
    duelOracleAddress: "0x8F582bc1D34Ca6dA12ac46B7c7Fdec02f2465961",
    goldClobAddress: "0x443C09B1E7bb7bA3392b02500772B185654A6F33",
    goldAmmRouterAddress: "",
    mUsdTokenAddress: "",
    adminAddress: "0x7908b93DF1A91A5e1B83a4538107Db3c9131eED8",
    marketOperatorAddress: "0x7908b93DF1A91A5e1B83a4538107Db3c9131eED8",
    treasuryAddress: "0x0262dC245f38d614d508D8BD680c69E3B6D26F4c",
    marketMakerAddress: "0x1B6C8799998f0a55CA69E6b2886C489861045cFd",
    reporterAddress: "",
    finalizerAddress: "",
    challengerAddress: "",
    timelockAddress: "",
    multisigAddress: "",
    emergencyCouncilAddress: "",
    deploymentVersion: "v2",
    goldTokenAddress: "",
    skillOracleAddress: "",
    perpEngineAddress: "",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    blockExplorerUrl: "https://bscscan.com",
    featureFlags: DEFAULT_FEATURE_FLAGS,
    aliases: ["bsc", "bnb"],
    nativeAsset: "BNB",
    defaultRpcUrl: "https://bsc-dataseed.binance.org",
    uiMeta: { shortName: "BSC", color: "#F0B90B", icon: "💎" },
  },
  baseSepolia: {
    networkKey: "baseSepolia",
    chain: "base",
    chainId: 84532,
    label: "Base Sepolia",
    targetKind: "testnet",
    rpcEnvVar: "BASE_SEPOLIA_RPC",
    duelOracleAddress: "",
    goldClobAddress: "",
    goldAmmRouterAddress: "",
    mUsdTokenAddress: "",
    adminAddress: "",
    marketOperatorAddress: "",
    treasuryAddress: "",
    marketMakerAddress: "",
    reporterAddress: "",
    finalizerAddress: "",
    challengerAddress: "",
    timelockAddress: "",
    multisigAddress: "",
    emergencyCouncilAddress: "",
    deploymentVersion: "v2",
    goldTokenAddress: "",
    skillOracleAddress: "",
    perpEngineAddress: "",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrl: "https://sepolia.basescan.org",
    featureFlags: DEFAULT_FEATURE_FLAGS,
    aliases: ["base"],
    nativeAsset: "ETH",
    defaultRpcUrl: "https://sepolia.base.org",
    uiMeta: { shortName: "Base", color: "#0052FF", icon: "🔵" },
  },
  base: {
    networkKey: "base",
    chain: "base",
    chainId: 8453,
    label: "Base",
    targetKind: "mainnet",
    rpcEnvVar: "BASE_MAINNET_RPC",
    duelOracleAddress: "0x63BF7f48A2795832C2b5f78172A1C6BE655F3a72",
    goldClobAddress: "0xb8c66D6895Bafd1B0027F2c0865865043064437C",
    goldAmmRouterAddress: "",
    mUsdTokenAddress: "",
    adminAddress: "0x7908b93DF1A91A5e1B83a4538107Db3c9131eED8",
    marketOperatorAddress: "0x7908b93DF1A91A5e1B83a4538107Db3c9131eED8",
    treasuryAddress: "0x0262dC245f38d614d508D8BD680c69E3B6D26F4c",
    marketMakerAddress: "0x1B6C8799998f0a55CA69E6b2886C489861045cFd",
    reporterAddress: "",
    finalizerAddress: "",
    challengerAddress: "",
    timelockAddress: "",
    multisigAddress: "",
    emergencyCouncilAddress: "",
    deploymentVersion: "v2",
    goldTokenAddress: "",
    skillOracleAddress: "",
    perpEngineAddress: "",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrl: "https://basescan.org",
    featureFlags: DEFAULT_FEATURE_FLAGS,
    aliases: ["base"],
    nativeAsset: "ETH",
    defaultRpcUrl: "https://mainnet.base.org",
    uiMeta: { shortName: "Base", color: "#0052FF", icon: "🔵" },
  },
  avaxFuji: {
    networkKey: "avaxFuji",
    chain: "avax",
    chainId: 43113,
    label: "Avalanche Fuji",
    targetKind: "testnet",
    rpcEnvVar: "AVAX_FUJI_RPC",
    duelOracleAddress: "0x5B0a0D5cf66F2A725560fCdb3bF74067c8c50A3C",
    goldClobAddress: "0xb7b2833875A17d5E5401C310C694Bb75a21a2582",
    goldAmmRouterAddress: "0x537b46C2Cd80f18E47f700825d1Bf886701AA8Dd",
    mUsdTokenAddress: "0x08e621f503aCe8cCCE745fe7441561536AE8445F",
    adminAddress: "0xd75676D9466db83a74E55572e45828751e2e8101",
    marketOperatorAddress: "0x7E82E3553f1baB7964c6dbd760d565be14D566bb",
    treasuryAddress: "0xae6bd4dAC4731995980EEdFF70ccC6B29E8FbD62",
    marketMakerAddress: "0xc2Aac21a8bb955c3D6a76b77A9824C8cd81d6f5B",
    reporterAddress: "0x8FA91419FDC9d25A646c6B9684C148DeFa1C2df0",
    finalizerAddress: "0x67e3078B238F9eAA04C60834ccCc6A4685F704b7",
    challengerAddress: "0x3A123B14bca41E14d12d4854F6a1180ECC38b42b",
    timelockAddress: "",
    multisigAddress: "",
    emergencyCouncilAddress: "0xdeB6a5897C5B2FbB3C7dCe821b5ffe69aeA60d51",
    deploymentVersion: "v3",
    goldTokenAddress: "0xB5e215607565808d00b16c69a8074d35060438DE",
    skillOracleAddress: "0x249db7Bf653b4Dfe20201B1d578F1df77b9f2a94",
    perpEngineAddress: "0x9064B86E9050bb9C01868B36740D6d9F12a18F0d",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    blockExplorerUrl: "https://testnet.snowtrace.io",
    featureFlags: DEFAULT_FEATURE_FLAGS,
    aliases: ["avax", "avalanche"],
    nativeAsset: "AVAX",
    defaultRpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
    uiMeta: { shortName: "AVAX", color: "#E84142", icon: "🔺" },
  },
  avax: {
    networkKey: "avax",
    chain: "avax",
    chainId: 43114,
    label: "Avalanche C-Chain",
    targetKind: "mainnet",
    rpcEnvVar: "AVAX_MAINNET_RPC",
    duelOracleAddress: "",
    goldClobAddress: "",
    goldAmmRouterAddress: "",
    mUsdTokenAddress: "",
    adminAddress: "",
    marketOperatorAddress: "",
    treasuryAddress: "",
    marketMakerAddress: "",
    reporterAddress: "",
    finalizerAddress: "",
    challengerAddress: "",
    timelockAddress: "",
    multisigAddress: "",
    emergencyCouncilAddress: "",
    deploymentVersion: "v2",
    goldTokenAddress: "",
    skillOracleAddress: "",
    perpEngineAddress: "",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    blockExplorerUrl: "https://snowtrace.io",
    featureFlags: DEFAULT_FEATURE_FLAGS,
    aliases: ["avax", "avalanche"],
    nativeAsset: "AVAX",
    defaultRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    uiMeta: { shortName: "AVAX", color: "#E84142", icon: "🔺" },
  },
};

/** Alias → BettingEvmChain lookup table, built from deployment data. */
const EVM_CHAIN_ALIAS_MAP: ReadonlyMap<string, BettingEvmChain> = (() => {
  const map = new Map<string, BettingEvmChain>();
  for (const deployment of Object.values(EVM_DEPLOYMENTS)) {
    for (const alias of deployment.aliases) {
      map.set(alias.toLowerCase(), deployment.chain);
    }
  }
  return map;
})();

export const BETTING_DEPLOYMENTS: BettingDeploymentManifest = {
  solana: SOLANA_DEPLOYMENTS,
  evm: EVM_DEPLOYMENTS,
};

export function getMissingBettingSolanaCanonicalFields(
  deployment: BettingSolanaDeployment,
): BettingSolanaCanonicalField[] {
  return BETTING_SOLANA_CANONICAL_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingSolanaDeploymentCanonicalReady(
  deployment: BettingSolanaDeployment,
): boolean {
  return getMissingBettingSolanaCanonicalFields(deployment).length === 0;
}

export function getMissingBettingSolanaAmmFields(
  deployment: BettingSolanaDeployment,
): BettingSolanaAmmField[] {
  return BETTING_SOLANA_AMM_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingSolanaDeploymentAmmReady(
  deployment: BettingSolanaDeployment,
): boolean {
  return getMissingBettingSolanaAmmFields(deployment).length === 0;
}

export function getMissingBettingSolanaPerpsFields(
  deployment: BettingSolanaDeployment,
): BettingSolanaPerpsField[] {
  return BETTING_SOLANA_PERPS_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingSolanaDeploymentPerpsReady(
  deployment: BettingSolanaDeployment,
): boolean {
  return getMissingBettingSolanaPerpsFields(deployment).length === 0;
}

export function getMissingBettingSolanaFullProductFields(
  deployment: BettingSolanaDeployment,
): BettingSolanaFullProductField[] {
  return BETTING_SOLANA_FULL_PRODUCT_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingSolanaDeploymentFullProductReady(
  deployment: BettingSolanaDeployment,
): boolean {
  return getMissingBettingSolanaFullProductFields(deployment).length === 0;
}

export function getMissingBettingSolanaReleaseFields(
  deployment: BettingSolanaDeployment,
): BettingSolanaReleaseField[] {
  return BETTING_SOLANA_RELEASE_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingSolanaDeploymentReleaseReady(
  deployment: BettingSolanaDeployment,
): boolean {
  return getMissingBettingSolanaReleaseFields(deployment).length === 0;
}

export function getMissingBettingEvmCanonicalFields(
  deployment: BettingEvmDeployment,
): BettingEvmCanonicalAddressField[] {
  return BETTING_EVM_CANONICAL_ADDRESS_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingEvmDeploymentCanonicalReady(
  deployment: BettingEvmDeployment,
): boolean {
  return getMissingBettingEvmCanonicalFields(deployment).length === 0;
}

export function getMissingBettingEvmGovernanceFields(
  deployment: BettingEvmDeployment,
): BettingEvmGovernanceAddressField[] {
  return BETTING_EVM_GOVERNANCE_ADDRESS_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingEvmDeploymentGovernanceReady(
  deployment: BettingEvmDeployment,
): boolean {
  return getMissingBettingEvmGovernanceFields(deployment).length === 0;
}

export function getMissingBettingEvmAmmFields(
  deployment: BettingEvmDeployment,
): BettingEvmAmmAddressField[] {
  return BETTING_EVM_AMM_ADDRESS_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingEvmDeploymentAmmReady(
  deployment: BettingEvmDeployment,
): boolean {
  return getMissingBettingEvmAmmFields(deployment).length === 0;
}

export function getMissingBettingEvmPerpsFields(
  deployment: BettingEvmDeployment,
): BettingEvmPerpsAddressField[] {
  return BETTING_EVM_PERPS_ADDRESS_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingEvmDeploymentPerpsReady(
  deployment: BettingEvmDeployment,
): boolean {
  return getMissingBettingEvmPerpsFields(deployment).length === 0;
}

export function getMissingBettingEvmFullProductFields(
  deployment: BettingEvmDeployment,
): BettingEvmFullProductAddressField[] {
  return BETTING_EVM_FULL_PRODUCT_ADDRESS_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingEvmDeploymentFullProductReady(
  deployment: BettingEvmDeployment,
): boolean {
  return getMissingBettingEvmFullProductFields(deployment).length === 0;
}

export function getMissingBettingEvmReleaseFields(
  deployment: BettingEvmDeployment,
): BettingEvmReleaseAddressField[] {
  return BETTING_EVM_RELEASE_ADDRESS_FIELDS.filter(
    (field) => deployment[field].trim().length === 0,
  );
}

export function isBettingEvmDeploymentReleaseReady(
  deployment: BettingEvmDeployment,
): boolean {
  return getMissingBettingEvmReleaseFields(deployment).length === 0;
}

export function normalizeSolanaCluster(cluster: string): BettingSolanaCluster {
  switch (cluster.trim().toLowerCase()) {
    case "local":
    case "localnet":
    case "e2e":
      return "localnet";
    case "dev":
    case "devnet":
    case "stream-ui":
      return "devnet";
    case "test":
    case "testnet":
      return "testnet";
    case "mainnet":
    case "mainnet-beta":
    case "prod":
    case "production":
      return "mainnet-beta";
    default:
      throw new Error(`Unsupported Solana cluster '${cluster}'`);
  }
}

export function resolveBettingSolanaDeployment(
  cluster: string,
): BettingSolanaDeployment {
  return BETTING_DEPLOYMENTS.solana[normalizeSolanaCluster(cluster)];
}

export function resolveBettingEvmDeployment(
  network: BettingEvmNetwork,
): BettingEvmDeployment {
  return BETTING_DEPLOYMENTS.evm[network];
}

export function defaultRpcUrlForEvmNetwork(network: BettingEvmNetwork): string {
  return EVM_DEPLOYMENTS[network].defaultRpcUrl;
}

export function resolveBettingEvmDefaults(environment: BettingAppEnvironment): {
  bsc: BettingEvmDeployment;
  base: BettingEvmDeployment;
  avax: BettingEvmDeployment;
} {
  if (environment === "mainnet-beta") {
    return {
      bsc: BETTING_DEPLOYMENTS.evm.bsc,
      base: BETTING_DEPLOYMENTS.evm.base,
      avax: BETTING_DEPLOYMENTS.evm.avax,
    };
  }

  return {
    bsc: BETTING_DEPLOYMENTS.evm.bscTestnet,
    base: BETTING_DEPLOYMENTS.evm.baseSepolia,
    avax: BETTING_DEPLOYMENTS.evm.avaxFuji,
  };
}

export function resolveBettingEvmDeploymentForChain(
  chainKey: BettingEvmChain,
  environment: BettingAppEnvironment,
): BettingEvmDeployment {
  const defaults = resolveBettingEvmDefaults(environment);
  return defaults[chainKey];
}

export function getEvmRuntimeConfig(
  chainKey: BettingEvmChain,
  environment: BettingAppEnvironment,
  overrides: Partial<
    Pick<EvmChainRuntimeConfig, "chainId" | "rpcUrl" | "goldClobAddress" | "goldTokenAddress">
  > = {},
): EvmChainRuntimeConfig {
  const deployment = resolveBettingEvmDeploymentForChain(chainKey, environment);
  return {
    chainKey,
    chainId: overrides.chainId ?? deployment.chainId,
    rpcUrl: overrides.rpcUrl ?? defaultRpcUrlForEvmNetwork(deployment.networkKey),
    goldClobAddress: overrides.goldClobAddress ?? deployment.goldClobAddress,
    goldTokenAddress: overrides.goldTokenAddress ?? deployment.goldTokenAddress,
    deployment,
  };
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function resolveBettingEvmRuntimeEnv(
  chainKey: BettingEvmChain,
  environment: BettingAppEnvironment,
  env: Record<string, string | undefined> = process.env,
): ResolvedBettingEvmRuntimeEnv {
  const deployment = resolveBettingEvmDeploymentForChain(chainKey, environment);
  const chainUpper = chainKey.toUpperCase();
  if (environment === "mainnet-beta" && !isBettingEvmDeploymentCanonicalReady(deployment)) {
    const missing = getMissingBettingEvmCanonicalFields(deployment).join(", ");
    throw new Error(
      `Canonical ${deployment.label} deployment is incomplete for production runtime resolution: ${missing}`,
    );
  }
  return {
    chainKey,
    deployment,
    rpcUrl:
      firstNonEmptyEnvValue(env, [
        `EVM_${chainUpper}_RPC_URL`,
        `${chainUpper}_RPC_URL`,
        deployment.rpcEnvVar,
      ]) ?? defaultRpcUrlForEvmNetwork(deployment.networkKey),
    duelOracleAddress:
      environment === "mainnet-beta"
        ? deployment.duelOracleAddress
        : firstNonEmptyEnvValue(env, [
            `ORACLE_CONTRACT_ADDRESS_${chainUpper}`,
            `${chainUpper}_DUEL_ORACLE_ADDRESS`,
          ]) ?? deployment.duelOracleAddress,
    goldClobAddress:
      environment === "mainnet-beta"
        ? deployment.goldClobAddress
        : firstNonEmptyEnvValue(env, [
            `CLOB_CONTRACT_ADDRESS_${chainUpper}`,
            `${chainUpper}_GOLD_CLOB_ADDRESS`,
          ]) ?? deployment.goldClobAddress,
    goldAmmRouterAddress:
      firstNonEmptyEnvValue(env, [
        `AMM_ROUTER_ADDRESS_${chainUpper}`,
        `${chainUpper}_GOLD_AMM_ROUTER_ADDRESS`,
      ]) ?? deployment.goldAmmRouterAddress,
    mUsdTokenAddress:
      firstNonEmptyEnvValue(env, [
        `MUSD_TOKEN_ADDRESS_${chainUpper}`,
        `${chainUpper}_MUSD_TOKEN_ADDRESS`,
      ]) ?? deployment.mUsdTokenAddress,
  };
}

export function parseBettingEvmChainList(
  value: string | null | undefined,
  fallback: readonly BettingEvmChain[] = BETTING_EVM_CHAIN_ORDER,
): BettingEvmChain[] {
  const tokens = (value ?? "")
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return [...fallback];
  }

  const chains: BettingEvmChain[] = [];
  for (const token of tokens) {
    const normalized = normalizeChainKey(token, "solana");
    if (isEvmChainKey(normalized) && !chains.includes(normalized)) {
      chains.push(normalized);
    }
  }
  return chains.length > 0 ? chains : [...fallback];
}

export function normalizeChainKey(
  value: string | null | undefined,
  fallback: BettingChainKey = "solana",
): BettingChainKey {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "sol" || normalized === "solana") return "solana";
  return EVM_CHAIN_ALIAS_MAP.get(normalized) ?? fallback;
}

export function isEvmChainKey(
  chainKey: BettingChainKey,
): chainKey is BettingEvmChain {
  return chainKey !== "solana";
}

function asPredictionMarketRecord(
  value: unknown,
): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizePredictionMarketChainKey(
  value: unknown,
): BettingChainKey | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "sol" || normalized === "solana") return "solana";
  return EVM_CHAIN_ALIAS_MAP.get(normalized) ?? null;
}

export function toRecordedBetChain(chainKey: BettingChainKey): RecordedBetChain {
  if (chainKey === "solana") return "SOLANA";
  return chainKey.toUpperCase() as RecordedBetChain;
}

/**
 * Returns the native asset symbol for the given EVM chain.
 * Data-driven: reads from deployment entry, no chain-specific switch.
 */
export function nativeAssetForEvmChain(chainKey: BettingEvmChain): string {
  const mainnet = Object.values(EVM_DEPLOYMENTS).find(
    (d) => d.chain === chainKey && d.targetKind === "mainnet",
  );
  return mainnet?.nativeAsset ?? chainKey.toUpperCase();
}

/**
 * Returns UI metadata for the given EVM chain.
 * Data-driven: reads from deployment entry, no chain-specific switch.
 */
export function uiMetaForEvmChain(chainKey: BettingEvmChain): EvmChainUiMeta {
  const mainnet = Object.values(EVM_DEPLOYMENTS).find(
    (d) => d.chain === chainKey && d.targetKind === "mainnet",
  );
  return mainnet?.uiMeta ?? { shortName: chainKey.toUpperCase(), color: "#71717A", icon: "◌" };
}

export function isPredictionMarketLifecycleStatus(
  value: unknown,
): value is PredictionMarketLifecycleStatus {
  return (
    typeof value === "string" &&
    (PREDICTION_MARKET_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizePredictionMarketLifecycleStatus(
  value: unknown,
): PredictionMarketLifecycleStatus {
  return isPredictionMarketLifecycleStatus(value) ? value : "UNKNOWN";
}

export function normalizePredictionMarketWinner(
  value: unknown,
): PredictionMarketWinner {
  switch (value) {
    case "A":
    case "B":
    case "NONE":
      return value;
    default:
      return "NONE";
  }
}

export function normalizePredictionMarketTimestamp(
  value: unknown,
): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePredictionMarketDuelKeyHex(
  value: string | null | undefined,
  options: { prefix?: boolean } = {},
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const normalized = /^0x[0-9a-f]{64}$/.test(trimmed)
    ? trimmed.slice(2)
    : /^[0-9a-f]{64}$/.test(trimmed)
      ? trimmed
      : null;
  if (!normalized) return null;
  return options.prefix ? `0x${normalized}` : normalized;
}

export function normalizePredictionMarketLifecycleMetadata(
  value: unknown,
): PredictionMarketLifecycleMetadata | undefined {
  const candidate = asPredictionMarketRecord(value);
  if (!candidate) return undefined;
  return {
    ...candidate,
    proposalId:
      typeof candidate.proposalId === "string" ? candidate.proposalId : null,
    challengeWindowEndsAt: normalizePredictionMarketTimestamp(
      candidate.challengeWindowEndsAt,
    ),
    finalizedAt: normalizePredictionMarketTimestamp(candidate.finalizedAt),
    cancellationReason:
      typeof candidate.cancellationReason === "string"
        ? candidate.cancellationReason
        : null,
  };
}

export function normalizePredictionMarketLifecycleRecord(
  value: unknown,
  options: { duelKeyPrefix?: boolean } = {},
): PredictionMarketLifecycleRecord | null {
  const candidate = asPredictionMarketRecord(value);
  const chainKey = normalizePredictionMarketChainKey(candidate?.chainKey);
  if (!candidate || !chainKey) {
    return null;
  }

  return {
    chainKey,
    duelKey: normalizePredictionMarketDuelKeyHex(
      typeof candidate.duelKey === "string" ? candidate.duelKey : null,
      { prefix: options.duelKeyPrefix },
    ),
    duelId: typeof candidate.duelId === "string" ? candidate.duelId : null,
    marketId:
      typeof candidate.marketId === "string" ? candidate.marketId : null,
    marketRef:
      typeof candidate.marketRef === "string" ? candidate.marketRef : null,
    lifecycleStatus: normalizePredictionMarketLifecycleStatus(
      candidate.lifecycleStatus,
    ),
    winner: normalizePredictionMarketWinner(candidate.winner),
    betCloseTime: normalizePredictionMarketTimestamp(candidate.betCloseTime),
    contractAddress:
      typeof candidate.contractAddress === "string"
        ? candidate.contractAddress
        : null,
    programId:
      typeof candidate.programId === "string" ? candidate.programId : null,
    txRef: typeof candidate.txRef === "string" ? candidate.txRef : null,
    syncedAt: normalizePredictionMarketTimestamp(candidate.syncedAt),
    metadata: normalizePredictionMarketLifecycleMetadata(candidate.metadata),
    ...(candidate.marketType === "amm" || candidate.marketType === "clob"
      ? { marketType: candidate.marketType }
      : {}),
  };
}

export function isPredictionMarketQuotableStatus(
  status: PredictionMarketLifecycleStatus,
): boolean {
  return status === "OPEN";
}

export function isPredictionMarketTerminalStatus(
  status: PredictionMarketLifecycleStatus,
): status is (typeof PREDICTION_MARKET_TERMINAL_STATUSES)[number] {
  return (PREDICTION_MARKET_TERMINAL_STATUSES as readonly string[]).includes(
    status,
  );
}

export function isPredictionMarketInFlightResolutionStatus(
  status: PredictionMarketLifecycleStatus,
): status is (typeof PREDICTION_MARKET_IN_FLIGHT_RESOLUTION_STATUSES)[number] {
  return (
    PREDICTION_MARKET_IN_FLIGHT_RESOLUTION_STATUSES as readonly string[]
  ).includes(status);
}

export function resolveLifecycleFromEvmStatus(
  status: number | string | null | undefined,
): PredictionMarketLifecycleStatus {
  const numeric =
    typeof status === "number"
      ? status
      : typeof status === "string"
        ? Number.parseInt(status, 10)
        : Number.NaN;
  switch (numeric) {
    case 1:
      return "OPEN";
    case 2:
      return "LOCKED";
    case 3:
      return "RESOLVED";
    case 4:
      return "CANCELLED";
    case 0:
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

export function resolveLifecycleFromEvmDuelStatus(
  status: number | string | null | undefined,
): PredictionMarketLifecycleStatus {
  const numeric =
    typeof status === "number"
      ? status
      : typeof status === "string"
        ? Number.parseInt(status, 10)
        : Number.NaN;
  switch (numeric) {
    case 2:
      return "OPEN";
    case 3:
      return "LOCKED";
    case 4:
      return "PROPOSED";
    case 5:
      return "CHALLENGED";
    case 6:
      return "RESOLVED";
    case 7:
      return "CANCELLED";
    case 1:
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

export function resolveLifecycleFromStreamPhase(
  phase: string | null | undefined,
): PredictionMarketLifecycleStatus {
  switch (phase?.toUpperCase()) {
    case "ANNOUNCEMENT":
      return "OPEN";
    case "COUNTDOWN":
    case "FIGHTING":
      return "LOCKED";
    case "RESOLUTION":
      return "RESOLVED";
    case "IDLE":
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

export function resolveLifecycleFromSolanaDuelStatus(
  status: string | null | undefined,
): PredictionMarketLifecycleStatus {
  switch (status?.trim().toLowerCase()) {
    case "scheduled":
      return "PENDING";
    case "bettingopen":
    case "betting_open":
      return "OPEN";
    case "locked":
      return "LOCKED";
    case "proposed":
      return "PROPOSED";
    case "challenged":
      return "CHALLENGED";
    case "resolved":
      return "RESOLVED";
    case "cancelled":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

export function resolveLifecycleFromSolanaMarketStatus(
  status: string | null | undefined,
): PredictionMarketLifecycleStatus {
  switch (status?.trim().toLowerCase()) {
    case "open":
      return "OPEN";
    case "locked":
      return "LOCKED";
    case "resolved":
      return "RESOLVED";
    case "cancelled":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

export function resolveWinnerFromEvmStatus(
  winner: number | string | null | undefined,
): PredictionMarketWinner {
  const numeric =
    typeof winner === "number"
      ? winner
      : typeof winner === "string"
        ? Number.parseInt(winner, 10)
        : Number.NaN;
  switch (numeric) {
    case 1:
      return "A";
    case 2:
      return "B";
    default:
      return "NONE";
  }
}
