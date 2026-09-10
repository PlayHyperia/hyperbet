import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  resolveConfiguredLaunchWallet,
  resolveKeeperRoleRefs,
  validateKeeperFeeTreasurySeparation,
  validateKeeperRoleSeparation,
  type KeeperRolePublicKeys,
} from "./keeperRoles";

function distinctRoles(): KeeperRolePublicKeys {
  return {
    feePayer: Keypair.generate().publicKey,
    oracleReporter: Keypair.generate().publicKey,
    oracleFinalizer: Keypair.generate().publicKey,
    oracleChallenger: Keypair.generate().publicKey,
    clobMarketOperator: Keypair.generate().publicKey,
    marketMaker: Keypair.generate().publicKey,
    oracleConfigAuthority: Keypair.generate().publicKey,
    clobConfigAuthority: Keypair.generate().publicKey,
  };
}

describe("keeper role policy", () => {
  test("permits signer-derived fee recipients only on exact localnet", () => {
    const fallback = Keypair.generate().publicKey;
    expect(
      resolveConfiguredLaunchWallet({
        cluster: " localnet ",
        envName: "TRADE_TREASURY_WALLET",
        configuredValue: undefined,
        localFallback: fallback,
      }),
    ).toEqual(fallback);

    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(() =>
        resolveConfiguredLaunchWallet({
          cluster,
          envName: "TRADE_TREASURY_WALLET",
          configuredValue: undefined,
          localFallback: fallback,
        }),
      ).toThrow("must be explicitly configured outside localnet");
    }
  });

  test("accepts one explicit canonical wallet on every supported rail", () => {
    const configured = Keypair.generate().publicKey;
    const fallback = Keypair.generate().publicKey;
    for (const cluster of [
      "localnet",
      "devnet",
      "testnet",
      "mainnet",
      "mainnet-beta",
    ]) {
      expect(
        resolveConfiguredLaunchWallet({
          cluster,
          envName: "TRADE_MARKET_MAKER_WALLET",
          configuredValue: ` ${configured.toBase58()} `,
          localFallback: fallback,
        }).toBase58(),
      ).toBe(configured.toBase58());
    }
  });

  test("rejects invalid wallets and unknown rails before launch", () => {
    const fallback = Keypair.generate().publicKey;
    expect(() =>
      resolveConfiguredLaunchWallet({
        cluster: "devnet",
        envName: "TRADE_TREASURY_WALLET",
        configuredValue: "not-a-wallet",
        localFallback: fallback,
      }),
    ).toThrow("must be a canonical Solana public key");
    expect(() =>
      resolveConfiguredLaunchWallet({
        cluster: "devnet",
        envName: "TRADE_TREASURY_WALLET",
        configuredValue: PublicKey.default.toBase58(),
        localFallback: fallback,
      }),
    ).toThrow("must be a canonical Solana public key");
    expect(() =>
      resolveConfiguredLaunchWallet({
        cluster: "solana",
        envName: "TRADE_TREASURY_WALLET",
        configuredValue: Keypair.generate().publicKey.toBase58(),
        localFallback: fallback,
      }),
    ).toThrow("Unsupported Solana keeper-role cluster");
  });

  test("routes both duel-bot fee recipients through the cluster policy", () => {
    const source = readFileSync(
      new URL("./duelBot.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("function readConfiguredWallet");
    for (const envName of [
      "TRADE_TREASURY_WALLET",
      "TRADE_MARKET_MAKER_WALLET",
    ]) {
      const envIndex = source.indexOf(`envName: "${envName}"`);
      const policyIndex = source.lastIndexOf(
        "resolveConfiguredLaunchWallet({",
        envIndex,
      );
      const configuredValueIndex = source.indexOf(
        `configuredValue: process.env.${envName}`,
        envIndex,
      );
      const fallbackIndex = source.indexOf("localFallback:", envIndex);
      expect(envIndex).toBeGreaterThanOrEqual(0);
      expect(policyIndex).toBeGreaterThanOrEqual(0);
      expect(configuredValueIndex).toBeGreaterThan(envIndex);
      expect(fallbackIndex).toBeGreaterThan(configuredValueIndex);
    }
    const marketMakerRecipientIndex = source.indexOf(
      "const configuredTradeMarketMakerWallet =",
    );
    const treasurySeparationIndex = source.lastIndexOf(
      "validateKeeperFeeTreasurySeparation(",
    );
    expect(treasurySeparationIndex).toBeGreaterThan(marketMakerRecipientIndex);
    expect(
      source.slice(treasurySeparationIndex, treasurySeparationIndex + 180),
    ).toContain("configuredTradeTreasuryWallet");
  });

  test("requires every automated role and the public challenger wallet", () => {
    expect(() => resolveKeeperRoleRefs({})).toThrow("KEEPER_FEE_PAYER_KEYPAIR");
    expect(() =>
      resolveKeeperRoleRefs({
        KEEPER_FEE_PAYER_KEYPAIR: "fee-payer.json",
        ORACLE_REPORTER_KEYPAIR: "reporter.json",
        ORACLE_FINALIZER_KEYPAIR: "finalizer.json",
        CLOB_MARKET_OPERATOR_KEYPAIR: "operator.json",
        MARKET_MAKER_KEYPAIR: "maker.json",
      }),
    ).toThrow("ORACLE_CHALLENGER_WALLET");
  });

  test("does not accept the removed broad authority variable as a fallback", () => {
    expect(() =>
      resolveKeeperRoleRefs({ ORACLE_AUTHORITY_KEYPAIR: "legacy.json" }),
    ).toThrow("KEEPER_FEE_PAYER_KEYPAIR");
  });

  test("accepts distinct runtime, challenger, and config roles on every non-local rail", () => {
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(() =>
        validateKeeperRoleSeparation(cluster, distinctRoles()),
      ).not.toThrow();
    }
  });

  test("rejects shared automated wallets on every non-local rail", () => {
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      const roles = distinctRoles();
      roles.oracleReporter = roles.feePayer;
      expect(() => validateKeeperRoleSeparation(cluster, roles)).toThrow(
        "fee payer and oracle reporter",
      );
    }
  });

  test("rejects a mainnet challenger controlled by the keeper", () => {
    const roles = distinctRoles();
    roles.oracleChallenger = roles.oracleFinalizer;
    expect(() => validateKeeperRoleSeparation("mainnet-beta", roles)).toThrow(
      "challenger must be independent",
    );
  });

  test("rejects hot runtime reuse of an optional mainnet config authority", () => {
    const roles = distinctRoles();
    roles.oracleConfigAuthority = roles.marketMaker;
    expect(() => validateKeeperRoleSeparation("mainnet-beta", roles)).toThrow(
      "oracle config authority must be independent",
    );
  });

  test("allows shared roles for local smoke environments", () => {
    const key = Keypair.generate().publicKey;
    expect(() =>
      validateKeeperRoleSeparation("localnet", {
        feePayer: key,
        oracleReporter: key,
        oracleFinalizer: key,
        oracleChallenger: key,
        clobMarketOperator: key,
        marketMaker: key,
        oracleConfigAuthority: key,
        clobConfigAuthority: key,
      }),
    ).not.toThrow();
  });

  test("rejects unknown role-separation rails", () => {
    expect(() =>
      validateKeeperRoleSeparation("solana", distinctRoles()),
    ).toThrow("Unsupported Solana keeper-role cluster");
  });

  test("keeps the non-local fee treasury outside every keeper identity", () => {
    const roles = distinctRoles();
    const reservedRoles = [
      roles.feePayer,
      roles.oracleReporter,
      roles.oracleFinalizer,
      roles.oracleChallenger,
      roles.clobMarketOperator,
      roles.marketMaker,
      roles.oracleConfigAuthority!,
      roles.clobConfigAuthority!,
    ];
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      for (const reservedRole of reservedRoles) {
        expect(() =>
          validateKeeperFeeTreasurySeparation(cluster, roles, reservedRole),
        ).toThrow("fee treasury must be independent");
      }
      expect(() =>
        validateKeeperFeeTreasurySeparation(
          cluster,
          roles,
          Keypair.generate().publicKey,
        ),
      ).not.toThrow();
    }
  });

  test("allows the exact local diagnostic rail to reuse its fee payer", () => {
    const roles = distinctRoles();
    expect(() =>
      validateKeeperFeeTreasurySeparation("localnet", roles, roles.feePayer),
    ).not.toThrow();
  });
});
