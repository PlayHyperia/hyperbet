import manifest from "./solana-v1.json";

export type SolanaV1Cluster =
  "localnet" | "devnet" | "testnet" | "mainnet-beta";
export type SolanaV1Environment = SolanaV1Cluster | "e2e" | "stream-ui";

export interface SolanaV1Deployment {
  cluster: SolanaV1Cluster;
  fightOracleProgramId: string;
  duelMarketProgramId: string;
}

export interface SolanaV1DeploymentManifest {
  realValueProgramVerification: SolanaV1RealValueProgramVerification;
  solana: Record<SolanaV1Cluster, SolanaV1Deployment>;
}

export type SolanaV1RealValueProgramVerification =
  | Readonly<{
      status: "unverified";
      evidenceSha256: null;
    }>
  | Readonly<{
      status: "verified";
      evidenceSha256: string;
    }>;

export interface VerifiedSolanaV1MainnetDeployment {
  deployment: SolanaV1Deployment;
  evidenceSha256: string;
}

export const SOLANA_V1_DEPLOYMENTS = manifest as SolanaV1DeploymentManifest;

const SHA256 = /^[0-9a-f]{64}$/u;

export function normalizeSolanaV1Cluster(
  value: string | null | undefined,
): SolanaV1Cluster {
  switch (value?.trim().toLowerCase()) {
    case "local":
    case "localnet":
    case "e2e":
      return "localnet";
    case "testnet":
      return "testnet";
    case "mainnet":
    case "mainnet-beta":
    case "prod":
    case "production":
      return "mainnet-beta";
    case "stream-ui":
    case "dev":
    case "development":
    case "devnet":
    default:
      return "devnet";
  }
}

export function resolveSolanaV1Deployment(
  environment: SolanaV1Environment | string,
): SolanaV1Deployment {
  return SOLANA_V1_DEPLOYMENTS.solana[normalizeSolanaV1Cluster(environment)];
}

/**
 * Resolve the mainnet program identities only after independent deployment
 * evidence has been bound into the canonical manifest. This is intentionally
 * separate from ordinary cluster resolution so deployment probes can inspect
 * an unverified candidate while every real-value launch gate fails closed.
 */
export function resolveVerifiedSolanaV1MainnetDeployment(
  deploymentManifest: SolanaV1DeploymentManifest = SOLANA_V1_DEPLOYMENTS,
): VerifiedSolanaV1MainnetDeployment {
  const verification = deploymentManifest.realValueProgramVerification;
  if (
    verification?.status !== "verified" ||
    !SHA256.test(verification.evidenceSha256)
  ) {
    throw new Error(
      "Solana mainnet program identities are not independently verified for real-value launch",
    );
  }
  const deployment = deploymentManifest.solana?.["mainnet-beta"];
  if (!deployment || deployment.cluster !== "mainnet-beta") {
    throw new Error("Solana mainnet deployment manifest is invalid");
  }
  return {
    deployment,
    evidenceSha256: verification.evidenceSha256,
  };
}
