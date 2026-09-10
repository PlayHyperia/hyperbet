import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  assertSolanaMarketCreationAllowed,
  resolveSolanaMarketCreationPolicy,
} from "./realValueLaunchPolicy";

describe("Solana keeper market-creation policy", () => {
  test("allows only valueless test rails", () => {
    for (const cluster of ["localnet", "devnet", "testnet"]) {
      expect(resolveSolanaMarketCreationPolicy(cluster)).toEqual({
        allowed: true,
        rail: "test",
        reason: null,
      });
      expect(() => assertSolanaMarketCreationAllowed(cluster)).not.toThrow();
    }
  });

  test("rejects every mainnet spelling without an environment escape hatch", () => {
    for (const cluster of ["mainnet", "mainnet-beta", " MAINNET-BETA "]) {
      expect(resolveSolanaMarketCreationPolicy(cluster)).toEqual({
        allowed: false,
        rail: "real-value",
        reason: "real-value-controls-incomplete",
      });
      expect(() => assertSolanaMarketCreationAllowed(cluster)).toThrow(
        /real-value.*real-value-controls-incomplete/u,
      );
    }
  });

  test("fails closed for empty and unknown clusters", () => {
    for (const cluster of ["", "solana", "unknown"]) {
      expect(resolveSolanaMarketCreationPolicy(cluster).allowed).toBe(false);
      expect(() => assertSolanaMarketCreationAllowed(cluster)).toThrow(
        /unsupported-cluster/u,
      );
    }
  });

  test("stops the real duel bot before signer configuration is read", () => {
    const source = readFileSync(
      new URL("./duelBot.ts", import.meta.url),
      "utf8",
    );
    const clusterIndex = source.indexOf("const botCluster =");
    const gateIndex = source.indexOf(
      "assertSolanaMarketCreationAllowed(botCluster);",
    );
    const signerIndex = source.indexOf(
      "const keeperRoleRefs = resolveKeeperRoleRefs(process.env);",
    );

    expect(clusterIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(clusterIndex);
    expect(signerIndex).toBeGreaterThan(gateIndex);
  });

  test("requires a permanently frozen oracle config before readiness verification", () => {
    const source = readFileSync(
      new URL("./duelBot.ts", import.meta.url),
      "utf8",
    );
    const freezeGateIndex = source.indexOf(
      "is not permanently frozen; run the approved launch configuration freeze",
    );
    const verifiedIndex = source.indexOf(
      "lastOracleConfigVerifiedAtMs = Date.now();",
    );

    expect(freezeGateIndex).toBeGreaterThanOrEqual(0);
    expect(verifiedIndex).toBeGreaterThan(freezeGateIndex);
  });

  test("requires the current oracle account schema before readiness verification", () => {
    const source = readFileSync(
      new URL("./duelBot.ts", import.meta.url),
      "utf8",
    );
    const schemaGateIndex = source.indexOf(
      "uses unsupported account schema",
    );
    const verifiedIndex = source.indexOf(
      "lastOracleConfigVerifiedAtMs = Date.now();",
    );

    expect(schemaGateIndex).toBeGreaterThanOrEqual(0);
    expect(verifiedIndex).toBeGreaterThan(schemaGateIndex);
  });

  test("requires a permanently frozen market config before readiness verification", () => {
    const source = readFileSync(
      new URL("./duelBot.ts", import.meta.url),
      "utf8",
    );
    const freezeGateIndex = source.indexOf(
      "CLOB config ${marketConfigPda.toBase58()} is not permanently frozen",
    );
    const verifiedIndex = source.indexOf(
      "lastMarketConfigVerifiedAtMs = Date.now();",
    );

    expect(freezeGateIndex).toBeGreaterThanOrEqual(0);
    expect(verifiedIndex).toBeGreaterThan(freezeGateIndex);
  });
});
