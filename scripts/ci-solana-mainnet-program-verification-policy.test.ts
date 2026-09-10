import { describe, expect, test } from "bun:test";

import { SOLANA_V1_DEPLOYMENTS } from "../packages/hyperbet-solana/deployments/v1";
import { resolveKeeperMainnetProgramVerification } from "./ci-solana-mainnet-program-verification-policy";

const evidenceSha256 = "a".repeat(64);
const verifiedManifest = {
  ...SOLANA_V1_DEPLOYMENTS,
  realValueProgramVerification: {
    status: "verified" as const,
    evidenceSha256,
  },
};

describe("keeper mainnet program-verification policy", () => {
  test("does not impose a real-value evidence boundary on staging", () => {
    expect(
      resolveKeeperMainnetProgramVerification({
        deployment: "staging",
        role: "service",
        configuredEvidenceSha256: null,
      }),
    ).toBeNull();
  });

  test("fails closed against the current unverified canonical mainnet registry", () => {
    expect(() =>
      resolveKeeperMainnetProgramVerification({
        deployment: "production",
        role: "service",
        configuredEvidenceSha256: evidenceSha256,
      }),
    ).toThrow(
      "Solana mainnet program identities are not independently verified for real-value launch",
    );
  });

  test("requires both keeper roles to carry the exact independently protected digest", () => {
    for (const role of ["service", "duel-bot"] as const) {
      expect(
        resolveKeeperMainnetProgramVerification({
          deployment: "production",
          role,
          configuredEvidenceSha256: evidenceSha256,
          manifest: verifiedManifest,
        }),
      ).toBe(evidenceSha256);
      expect(() =>
        resolveKeeperMainnetProgramVerification({
          deployment: "production",
          role,
          configuredEvidenceSha256: null,
          manifest: verifiedManifest,
        }),
      ).toThrow(
        `${role} is missing required env SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256`,
      );
      expect(() =>
        resolveKeeperMainnetProgramVerification({
          deployment: "production",
          role,
          configuredEvidenceSha256: "b".repeat(64),
          manifest: verifiedManifest,
        }),
      ).toThrow(
        `${role} SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 must match the approved deployment manifest`,
      );
    }
  });
});
