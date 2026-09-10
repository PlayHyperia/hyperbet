export const SOLANA_PAGES_BUILD_IDENTITY_SCHEMA_VERSION: 1;

export type SolanaPagesBuildIdentity = Readonly<{
  schemaVersion: 1;
  target: "production" | "staging" | "preview";
  cluster: "mainnet-beta" | "devnet";
  transactionsEnabled: boolean;
  useGameRpcProxy: true;
  configSha256: string;
}>;

export function resolveSolanaPagesBuildIdentity(
  environment: Record<string, string | undefined>,
): SolanaPagesBuildIdentity;
