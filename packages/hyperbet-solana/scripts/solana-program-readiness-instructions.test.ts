import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import type BN from "bn.js";

import { resolveSolanaV1Deployment } from "../deployments/v1";
import {
  buildSolanaProgramReadinessInstructions,
  deriveUpgradeableProgramDataAddress,
  type SolanaReadinessInitializationConfiguration,
  type SolanaReadinessRolePublicKeys,
} from "./solana-program-readiness-instructions";

function readIdl(name: string): Idl {
  return JSON.parse(
    fs.readFileSync(
      new URL(`../anchor/target/idl/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Idl;
}

describe("Solana program readiness instructions", () => {
  test("builds the two real, signed initializer instruction shapes", () => {
    const payer = Keypair.generate().publicKey;
    const roles: SolanaReadinessRolePublicKeys = {
      reporter: Keypair.generate().publicKey,
      finalizer: Keypair.generate().publicKey,
      challenger: Keypair.generate().publicKey,
      marketOperator: Keypair.generate().publicKey,
      treasury: Keypair.generate().publicKey,
      marketMaker: Keypair.generate().publicKey,
    };
    const deployment = resolveSolanaV1Deployment("localnet");
    const fightOracleIdl = readIdl("fight_oracle");
    const duelMarketIdl = readIdl("duel_market");
    const configuration: SolanaReadinessInitializationConfiguration = {
      oracleDisputeWindowSeconds: 73,
      tradeTreasuryFeeBps: 11,
      tradeMarketMakerFeeBps: 22,
      winningsMarketMakerFeeBps: 33,
    };
    const probes = buildSolanaProgramReadinessInstructions({
      deployment,
      payer,
      roles,
      fightOracleIdl,
      duelMarketIdl,
      configuration,
    });

    expect(
      probes.map(({ label, instructionName }) => [label, instructionName]),
    ).toEqual([
      ["fight-oracle", "initialize_oracle"],
      ["duel-market", "initialize_config"],
    ]);

    for (const probe of probes) {
      const programId = new PublicKey(probe.programId);
      expect(probe.instruction.programId.equals(programId)).toBe(true);
      expect(probe.instruction.keys).toHaveLength(5);
      expect(probe.instruction.keys[0]).toMatchObject({
        isSigner: true,
        isWritable: true,
      });
      expect(probe.instruction.keys[0]?.pubkey.equals(payer)).toBe(true);
      expect(probe.instruction.keys[1]).toMatchObject({
        isSigner: false,
        isWritable: true,
      });
      expect(probe.instruction.keys[2]?.pubkey.equals(programId)).toBe(true);
      expect(
        probe.instruction.keys[3]?.pubkey.equals(
          deriveUpgradeableProgramDataAddress(programId),
        ),
      ).toBe(true);
      expect(
        probe.instruction.keys[4]?.pubkey.equals(SystemProgram.programId),
      ).toBe(true);
    }

    const oracleInstruction = new BorshInstructionCoder(fightOracleIdl).decode(
      probes[0]!.instruction.data,
    );
    const marketInstruction = new BorshInstructionCoder(duelMarketIdl).decode(
      probes[1]!.instruction.data,
    );
    expect(oracleInstruction?.name).toBe("initialize_oracle");
    expect(marketInstruction?.name).toBe("initialize_config");
    expect(
      Number(
        (oracleInstruction?.data as { dispute_window_secs: BN })
          .dispute_window_secs,
      ),
    ).toBe(configuration.oracleDisputeWindowSeconds);
    const oracleData = oracleInstruction?.data as {
      reporter: PublicKey;
      finalizer: PublicKey;
      challenger: PublicKey;
    };
    expect(oracleData.reporter.equals(roles.reporter)).toBe(true);
    expect(oracleData.finalizer.equals(roles.finalizer)).toBe(true);
    expect(oracleData.challenger.equals(roles.challenger)).toBe(true);
    expect(marketInstruction?.data).toMatchObject({
      trade_treasury_fee_bps: configuration.tradeTreasuryFeeBps,
      trade_market_maker_fee_bps: configuration.tradeMarketMakerFeeBps,
      winnings_market_maker_fee_bps: configuration.winningsMarketMakerFeeBps,
    });
    const marketData = marketInstruction?.data as {
      market_operator: PublicKey;
      treasury: PublicKey;
      market_maker: PublicKey;
    };
    expect(marketData.market_operator.equals(roles.marketOperator)).toBe(true);
    expect(marketData.treasury.equals(roles.treasury)).toBe(true);
    expect(marketData.market_maker.equals(roles.marketMaker)).toBe(true);
    expect(probes[0]!.instruction.data).toHaveLength(112);
    expect(probes[1]!.instruction.data).toHaveLength(110);
  });

  test("requires explicit finite initializer configuration", () => {
    const base = {
      deployment: resolveSolanaV1Deployment("localnet"),
      payer: Keypair.generate().publicKey,
      fightOracleIdl: readIdl("fight_oracle"),
      duelMarketIdl: readIdl("duel_market"),
      roles: {
        reporter: Keypair.generate().publicKey,
        finalizer: Keypair.generate().publicKey,
        challenger: Keypair.generate().publicKey,
        marketOperator: Keypair.generate().publicKey,
        treasury: Keypair.generate().publicKey,
        marketMaker: Keypair.generate().publicKey,
      },
    };
    expect(() =>
      buildSolanaProgramReadinessInstructions({
        ...base,
        configuration: undefined as never,
      }),
    ).toThrow(
      "Explicit Solana readiness initialization configuration is required",
    );
    expect(() =>
      buildSolanaProgramReadinessInstructions({
        ...base,
        roles: undefined as never,
        configuration: {
          oracleDisputeWindowSeconds: 60,
          tradeTreasuryFeeBps: 0,
          tradeMarketMakerFeeBps: 0,
          winningsMarketMakerFeeBps: 0,
        },
      }),
    ).toThrow("Explicit Solana readiness role public keys are required");
    expect(() =>
      buildSolanaProgramReadinessInstructions({
        ...base,
        roles: { ...base.roles, treasury: undefined as never },
        configuration: {
          oracleDisputeWindowSeconds: 60,
          tradeTreasuryFeeBps: 0,
          tradeMarketMakerFeeBps: 0,
          winningsMarketMakerFeeBps: 0,
        },
      }),
    ).toThrow("treasury must be a Solana public key");
    expect(() =>
      buildSolanaProgramReadinessInstructions({
        ...base,
        configuration: {
          oracleDisputeWindowSeconds: 60,
          tradeTreasuryFeeBps: 65_536,
          tradeMarketMakerFeeBps: 0,
          winningsMarketMakerFeeBps: 0,
        },
      }),
    ).toThrow("tradeTreasuryFeeBps must be an integer from 0 to 65535");
  });
});
