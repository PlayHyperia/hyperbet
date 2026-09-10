import { describe, expect, test } from "bun:test";

import {
  SOLANA_V1_DEPLOYMENTS,
  normalizeSolanaV1Cluster,
  resolveSolanaV1Deployment,
  resolveVerifiedSolanaV1MainnetDeployment,
} from "../deployments/v1";

const EXPECTED_FIGHT_ORACLE_PROGRAM_ID =
  "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu";
const EXPECTED_DUEL_MARKET_PROGRAM_ID =
  "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG";

describe("betting deployment manifest", () => {
  test("normalizes build/runtime cluster aliases", () => {
    expect(normalizeSolanaV1Cluster("mainnet")).toBe("mainnet-beta");
    expect(normalizeSolanaV1Cluster("production")).toBe("mainnet-beta");
    expect(normalizeSolanaV1Cluster("e2e")).toBe("localnet");
    expect(normalizeSolanaV1Cluster("stream-ui")).toBe("devnet");
  });

  test("resolves Solana deployments from the dedicated v1 manifest", () => {
    const testnet = resolveSolanaV1Deployment("testnet");
    expect(testnet.fightOracleProgramId).toBe(
      SOLANA_V1_DEPLOYMENTS.solana.testnet.fightOracleProgramId,
    );
    expect(testnet.duelMarketProgramId).toBe(
      SOLANA_V1_DEPLOYMENTS.solana.testnet.duelMarketProgramId,
    );
  });

  test("pins one production program identity set across every cluster", () => {
    for (const deployment of Object.values(SOLANA_V1_DEPLOYMENTS.solana)) {
      expect(deployment.fightOracleProgramId).toBe(
        EXPECTED_FIGHT_ORACLE_PROGRAM_ID,
      );
      expect(deployment.duelMarketProgramId).toBe(
        EXPECTED_DUEL_MARKET_PROGRAM_ID,
      );
    }
  });

  test("fails closed while the canonical mainnet program identities are unverified", () => {
    expect(SOLANA_V1_DEPLOYMENTS.realValueProgramVerification).toEqual({
      status: "unverified",
      evidenceSha256: null,
    });
    expect(() => resolveVerifiedSolanaV1MainnetDeployment()).toThrow(
      "Solana mainnet program identities are not independently verified for real-value launch",
    );
  });

  test("binds a verified mainnet resolution to one exact evidence digest", () => {
    const verified = resolveVerifiedSolanaV1MainnetDeployment({
      ...SOLANA_V1_DEPLOYMENTS,
      realValueProgramVerification: {
        status: "verified",
        evidenceSha256: "a".repeat(64),
      },
    });
    expect(verified).toEqual({
      deployment: SOLANA_V1_DEPLOYMENTS.solana["mainnet-beta"],
      evidenceSha256: "a".repeat(64),
    });
  });

  test("rejects malformed or missing evidence on a claimed verification", () => {
    for (const evidenceSha256 of ["", "A".repeat(64), "0".repeat(63)]) {
      expect(() =>
        resolveVerifiedSolanaV1MainnetDeployment({
          ...SOLANA_V1_DEPLOYMENTS,
          realValueProgramVerification: {
            status: "verified",
            evidenceSha256,
          },
        }),
      ).toThrow(
        "Solana mainnet program identities are not independently verified for real-value launch",
      );
    }
  });
});
