import { describe, expect, test } from "bun:test";

import { SOLANA_V1_DEPLOYMENTS } from "../deployments/v1";
import { verifyMainnetProgramRegistry } from "./verify-mainnet-program-registry";

const evidenceSha256 = "c".repeat(64);
const verifiedManifest = {
  ...SOLANA_V1_DEPLOYMENTS,
  realValueProgramVerification: {
    status: "verified" as const,
    evidenceSha256,
  },
};

describe("mainnet-capable command registry preflight", () => {
  test("fails closed against the current unverified canonical registry", () => {
    expect(() =>
      verifyMainnetProgramRegistry({
        configuredEvidenceSha256: evidenceSha256,
      }),
    ).toThrow(
      "Solana mainnet program identities are not independently verified for real-value launch",
    );
  });

  test("requires the independently configured digest", () => {
    expect(() =>
      verifyMainnetProgramRegistry({
        configuredEvidenceSha256: null,
        manifest: verifiedManifest,
      }),
    ).toThrow(
      "SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 is required for a mainnet-capable command",
    );
  });

  test("rejects protected-value drift", () => {
    expect(() =>
      verifyMainnetProgramRegistry({
        configuredEvidenceSha256: "d".repeat(64),
        manifest: verifiedManifest,
      }),
    ).toThrow(
      "SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256 does not match the approved deployment manifest",
    );
  });

  test("returns only the exact cluster and verified digest", () => {
    expect(
      verifyMainnetProgramRegistry({
        configuredEvidenceSha256: evidenceSha256,
        manifest: verifiedManifest,
      }),
    ).toEqual({
      cluster: "mainnet-beta",
      evidenceSha256,
    });
  });
});
