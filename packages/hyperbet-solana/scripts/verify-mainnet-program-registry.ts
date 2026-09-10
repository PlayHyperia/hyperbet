import { fileURLToPath } from "node:url";

import {
  SOLANA_V1_DEPLOYMENTS,
  resolveVerifiedSolanaV1MainnetDeployment,
  type SolanaV1DeploymentManifest,
} from "../deployments/v1";

export function verifyMainnetProgramRegistry(input: {
  configuredEvidenceSha256: string | null | undefined;
  manifest?: SolanaV1DeploymentManifest;
}): Readonly<{
  cluster: "mainnet-beta";
  evidenceSha256: string;
}> {
  const verified = resolveVerifiedSolanaV1MainnetDeployment(
    input.manifest ?? SOLANA_V1_DEPLOYMENTS,
  );
  const configured = input.configuredEvidenceSha256?.trim() ?? "";
  if (!configured) {
    throw new Error(
      "SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 is required for a mainnet-capable command",
    );
  }
  if (configured !== verified.evidenceSha256) {
    throw new Error(
      "SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 does not match the approved deployment manifest",
    );
  }
  return Object.freeze({
    cluster: "mainnet-beta",
    evidenceSha256: verified.evidenceSha256,
  });
}

function isMainModule(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const verified = verifyMainnetProgramRegistry({
      configuredEvidenceSha256:
        process.env.SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256,
    });
    console.log(
      JSON.stringify({
        ok: true,
        cluster: verified.cluster,
        programVerificationEvidenceSha256: verified.evidenceSha256,
      }),
    );
  } catch (error) {
    console.error(
      `[solana-mainnet-program-registry] blocked: ${error instanceof Error ? error.message : "verification failed"}`,
    );
    process.exitCode = 1;
  }
}
