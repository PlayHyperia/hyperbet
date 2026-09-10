import {
  SOLANA_V1_DEPLOYMENTS,
  resolveVerifiedSolanaV1MainnetDeployment,
  type SolanaV1DeploymentManifest,
} from "../packages/hyperbet-solana/deployments/v1";

export type SolanaKeeperDeployment = "staging" | "production";
export type SolanaKeeperRuntimeRole = "service" | "duel-bot";

export function resolveKeeperMainnetProgramVerification(input: {
  deployment: SolanaKeeperDeployment;
  role: SolanaKeeperRuntimeRole;
  configuredEvidenceSha256: string | null | undefined;
  manifest?: SolanaV1DeploymentManifest;
}): string | null {
  if (input.deployment !== "production") return null;

  const verified = resolveVerifiedSolanaV1MainnetDeployment(
    input.manifest ?? SOLANA_V1_DEPLOYMENTS,
  );
  const configured = input.configuredEvidenceSha256?.trim() ?? "";
  if (!configured) {
    throw new Error(
      `${input.role} is missing required env SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256`,
    );
  }
  if (configured !== verified.evidenceSha256) {
    throw new Error(
      `${input.role} SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 must match the approved deployment manifest`,
    );
  }
  return verified.evidenceSha256;
}
