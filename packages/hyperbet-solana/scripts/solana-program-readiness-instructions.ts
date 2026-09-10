import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import type { SolanaV1Deployment } from "../deployments/v1";

const UPGRADEABLE_LOADER_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export interface SolanaReadinessRolePublicKeys {
  reporter: PublicKey;
  finalizer: PublicKey;
  challenger: PublicKey;
  marketOperator: PublicKey;
  treasury: PublicKey;
  marketMaker: PublicKey;
}

export interface SolanaReadinessInitializationConfiguration {
  oracleDisputeWindowSeconds: number;
  tradeTreasuryFeeBps: number;
  tradeMarketMakerFeeBps: number;
  winningsMarketMakerFeeBps: number;
}

export interface SolanaProgramReadinessInstruction {
  label: "fight-oracle" | "duel-market";
  programId: string;
  instructionName: "initialize_oracle" | "initialize_config";
  instruction: TransactionInstruction;
}

export function deriveUpgradeableProgramDataAddress(
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    UPGRADEABLE_LOADER_PROGRAM_ID,
  )[0];
}

function encodeInstruction(
  idl: Idl,
  name: string,
  values: Record<string, unknown>,
): Buffer {
  return new BorshInstructionCoder(idl).encode(name, values);
}

function assertIntegerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

function validateInitializationConfiguration(
  configuration: SolanaReadinessInitializationConfiguration,
): SolanaReadinessInitializationConfiguration {
  if (!configuration || typeof configuration !== "object") {
    throw new Error(
      "Explicit Solana readiness initialization configuration is required",
    );
  }
  assertIntegerInRange(
    configuration.oracleDisputeWindowSeconds,
    "oracleDisputeWindowSeconds",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  for (const [label, value] of [
    ["tradeTreasuryFeeBps", configuration.tradeTreasuryFeeBps],
    ["tradeMarketMakerFeeBps", configuration.tradeMarketMakerFeeBps],
    ["winningsMarketMakerFeeBps", configuration.winningsMarketMakerFeeBps],
  ] as const) {
    assertIntegerInRange(value, label, 0, 65_535);
  }
  return configuration;
}

function validateRolePublicKeys(
  roles: SolanaReadinessRolePublicKeys,
): SolanaReadinessRolePublicKeys {
  if (!roles || typeof roles !== "object") {
    throw new Error("Explicit Solana readiness role public keys are required");
  }
  for (const label of [
    "reporter",
    "finalizer",
    "challenger",
    "marketOperator",
    "treasury",
    "marketMaker",
  ] as const) {
    const value = roles[label];
    if (!(value instanceof PublicKey)) {
      throw new Error(`${label} must be a Solana public key`);
    }
  }
  return roles;
}

export function buildSolanaProgramReadinessInstructions(input: {
  deployment: SolanaV1Deployment;
  payer: PublicKey;
  fightOracleIdl: Idl;
  duelMarketIdl: Idl;
  configuration: SolanaReadinessInitializationConfiguration;
  roles: SolanaReadinessRolePublicKeys;
}): SolanaProgramReadinessInstruction[] {
  const roles = validateRolePublicKeys(input.roles);
  const configuration = validateInitializationConfiguration(
    input.configuration,
  );
  const fightOracleProgramId = new PublicKey(
    input.deployment.fightOracleProgramId,
  );
  const duelMarketProgramId = new PublicKey(
    input.deployment.duelMarketProgramId,
  );
  const oracleConfig = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_config")],
    fightOracleProgramId,
  )[0];
  const marketConfig = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    duelMarketProgramId,
  )[0];

  return [
    {
      label: "fight-oracle",
      programId: fightOracleProgramId.toBase58(),
      instructionName: "initialize_oracle",
      instruction: new TransactionInstruction({
        programId: fightOracleProgramId,
        keys: [
          { pubkey: input.payer, isSigner: true, isWritable: true },
          { pubkey: oracleConfig, isSigner: false, isWritable: true },
          {
            pubkey: fightOracleProgramId,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: deriveUpgradeableProgramDataAddress(fightOracleProgramId),
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeInstruction(input.fightOracleIdl, "initialize_oracle", {
          reporter: roles.reporter,
          finalizer: roles.finalizer,
          challenger: roles.challenger,
          dispute_window_secs: new BN(configuration.oracleDisputeWindowSeconds),
        }),
      }),
    },
    {
      label: "duel-market",
      programId: duelMarketProgramId.toBase58(),
      instructionName: "initialize_config",
      instruction: new TransactionInstruction({
        programId: duelMarketProgramId,
        keys: [
          { pubkey: input.payer, isSigner: true, isWritable: true },
          { pubkey: marketConfig, isSigner: false, isWritable: true },
          {
            pubkey: duelMarketProgramId,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: deriveUpgradeableProgramDataAddress(duelMarketProgramId),
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeInstruction(input.duelMarketIdl, "initialize_config", {
          market_operator: roles.marketOperator,
          treasury: roles.treasury,
          market_maker: roles.marketMaker,
          trade_treasury_fee_bps: configuration.tradeTreasuryFeeBps,
          trade_market_maker_fee_bps: configuration.tradeMarketMakerFeeBps,
          winnings_market_maker_fee_bps:
            configuration.winningsMarketMakerFeeBps,
        }),
      }),
    },
  ];
}
