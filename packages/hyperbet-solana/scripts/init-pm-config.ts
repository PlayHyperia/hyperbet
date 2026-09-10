import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  clusterApiUrl,
} from "@solana/web3.js";

import {
  resolveSolanaV1Deployment,
  type SolanaV1Cluster,
} from "../deployments/v1";
import {
  deriveProgramDataAddress,
  resolveExpectedUpgradeAuthority,
} from "../keeper/src/solanaProgramIdentity";
import { resolveStageAWalletPath } from "./stage-a-identity";
import { describeRpcEndpoint } from "./solana-deployment-evidence";
import { fetchSolanaProgramDeploymentIdentity } from "./solana-deployment-identity";
import { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../account-schema";
import { evaluateFightOracleAccountSchema } from "./solana-account-schema";
import {
  resolveSolanaDuelLaunchConfig,
  serializeSolanaDuelLaunchConfig,
  type SolanaDuelLaunchConfig,
} from "./solana-launch-config";

interface OracleConfigAccount {
  authority: PublicKey;
  reporter: PublicKey;
  finalizer: PublicKey;
  challenger: PublicKey;
  disputeWindowSecs: BN;
  paused: boolean;
  configFrozen: boolean;
  accountSchemaVersion: number;
}

interface MarketConfigAccount {
  authority: PublicKey;
  marketOperator: PublicKey;
  treasury: PublicKey;
  marketMaker: PublicKey;
  tradeTreasuryFeeBps: number;
  tradeMarketMakerFeeBps: number;
  winningsMarketMakerFeeBps: number;
  orderPlacementPaused: boolean;
  marketCreationPaused: boolean;
  configFrozen: boolean;
}

type MutationResult = {
  address: PublicKey;
  initializeTx: string | null;
  updateTx: string | null;
};

function parseArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseCluster(): SolanaV1Cluster {
  const value = parseArg("--cluster") ?? "devnet";
  if (
    value === "localnet" ||
    value === "devnet" ||
    value === "testnet" ||
    value === "mainnet-beta"
  ) {
    return value;
  }
  throw new Error(`Unsupported --cluster value '${value}'`);
}

function usage(): never {
  console.log(`usage: node --import tsx packages/hyperbet-solana/scripts/init-pm-config.ts \\
  [--cluster devnet|testnet|mainnet-beta|localnet] [--freeze] [--out <path>]

required env:
  SOLANA_LAUNCH_FEE_POLICY_APPROVED=true
  SOLANA_ORACLE_DISPUTE_WINDOW_SECS
  TRADE_TREASURY_FEE_BPS
  TRADE_MARKET_MAKER_FEE_BPS
  WINNINGS_MARKET_MAKER_FEE_BPS
  SOLANA_PM_REPORTER_PUBKEY
  SOLANA_PM_FINALIZER_PUBKEY
  SOLANA_PM_CHALLENGER_PUBKEY
  SOLANA_PM_MARKET_OPERATOR_PUBKEY
  SOLANA_PM_TREASURY_PUBKEY
  SOLANA_PM_MARKET_MAKER_PUBKEY

additional freeze env:
  SOLANA_LAUNCH_CONFIG_FREEZE_APPROVED=true

mainnet additionally requires:
  SOLANA_EXPECTED_UPGRADE_AUTHORITY
`);
  process.exit(0);
}

function resolveRpcUrl(cluster: SolanaV1Cluster): string {
  const explicit = process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  if (cluster === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cluster);
}

function readKeypair(filepath: string): Keypair {
  const bytes = JSON.parse(fs.readFileSync(filepath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function deriveOracleConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_config")],
    programId,
  )[0];
}

function deriveMarketConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  )[0];
}

function loadIdlWithAddress(filepath: string, address: PublicKey): Idl {
  const idl = JSON.parse(fs.readFileSync(filepath, "utf8")) as Idl & {
    address?: string;
  };
  idl.address = address.toBase58();
  return idl;
}

function writeSummary(outPath: string | undefined, payload: unknown): void {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

function oracleStateMatches(
  existing: OracleConfigAccount,
  authority: PublicKey,
  config: SolanaDuelLaunchConfig,
): boolean {
  return (
    existing.accountSchemaVersion === FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION &&
    existing.authority.equals(authority) &&
    existing.reporter.equals(config.reporter) &&
    existing.finalizer.equals(config.finalizer) &&
    existing.challenger.equals(config.challenger) &&
    existing.disputeWindowSecs.toNumber() === config.disputeWindowSecs
  );
}

function marketStateMatches(
  existing: MarketConfigAccount,
  authority: PublicKey,
  config: SolanaDuelLaunchConfig,
): boolean {
  return (
    existing.authority.equals(authority) &&
    existing.marketOperator.equals(config.marketOperator) &&
    existing.treasury.equals(config.treasury) &&
    existing.marketMaker.equals(config.marketMaker) &&
    existing.tradeTreasuryFeeBps === config.tradeTreasuryFeeBps &&
    existing.tradeMarketMakerFeeBps === config.tradeMarketMakerFeeBps &&
    existing.winningsMarketMakerFeeBps === config.winningsMarketMakerFeeBps
  );
}

async function ensureOracleConfig(input: {
  program: Program;
  authority: Keypair;
  config: SolanaDuelLaunchConfig;
}): Promise<MutationResult> {
  const address = deriveOracleConfigPda(input.program.programId);
  const accountManager = (
    input.program.account as unknown as {
      oracleConfig: {
        fetchNullable: (
          address: PublicKey,
        ) => Promise<OracleConfigAccount | null>;
      };
    }
  ).oracleConfig;
  const existing = await accountManager.fetchNullable(address);
  if (!existing) {
    const initializeTx = await input.program.methods
      .initializeOracle(
        input.config.reporter,
        input.config.finalizer,
        input.config.challenger,
        new BN(input.config.disputeWindowSecs),
      )
      .accountsPartial({
        authority: input.authority.publicKey,
        oracleConfig: address,
        program: input.program.programId,
        programData: deriveProgramDataAddress(input.program.programId),
        systemProgram: SystemProgram.programId,
      })
      .signers([input.authority])
      .rpc();
    return { address, initializeTx, updateTx: null };
  }

  if (!existing.authority.equals(input.authority.publicKey)) {
    throw new Error(
      `oracle config authority ${existing.authority.toBase58()} does not match deploy authority ${input.authority.publicKey.toBase58()}`,
    );
  }
  if (existing.configFrozen) {
    if (
      !oracleStateMatches(existing, input.authority.publicKey, input.config)
    ) {
      throw new Error(
        "frozen oracle config does not match approved launch policy",
      );
    }
    return { address, initializeTx: null, updateTx: null };
  }
  if (oracleStateMatches(existing, input.authority.publicKey, input.config)) {
    return { address, initializeTx: null, updateTx: null };
  }

  const updateTx = await input.program.methods
    .updateOracleConfig(
      input.authority.publicKey,
      input.config.reporter,
      input.config.finalizer,
      input.config.challenger,
      new BN(input.config.disputeWindowSecs),
    )
    .accountsPartial({
      authority: input.authority.publicKey,
      oracleConfig: address,
    })
    .signers([input.authority])
    .rpc();
  return { address, initializeTx: null, updateTx };
}

async function ensureMarketConfig(input: {
  program: Program;
  authority: Keypair;
  config: SolanaDuelLaunchConfig;
}): Promise<MutationResult> {
  const address = deriveMarketConfigPda(input.program.programId);
  const accountManager = (
    input.program.account as unknown as {
      marketConfig: {
        fetchNullable: (
          address: PublicKey,
        ) => Promise<MarketConfigAccount | null>;
      };
    }
  ).marketConfig;
  const existing = await accountManager.fetchNullable(address);
  if (!existing) {
    const initializeTx = await input.program.methods
      .initializeConfig(
        input.config.marketOperator,
        input.config.treasury,
        input.config.marketMaker,
        input.config.tradeTreasuryFeeBps,
        input.config.tradeMarketMakerFeeBps,
        input.config.winningsMarketMakerFeeBps,
      )
      .accountsPartial({
        authority: input.authority.publicKey,
        config: address,
        program: input.program.programId,
        programData: deriveProgramDataAddress(input.program.programId),
        systemProgram: SystemProgram.programId,
      })
      .signers([input.authority])
      .rpc();
    return { address, initializeTx, updateTx: null };
  }

  if (!existing.authority.equals(input.authority.publicKey)) {
    throw new Error(
      `market config authority ${existing.authority.toBase58()} does not match deploy authority ${input.authority.publicKey.toBase58()}`,
    );
  }
  if (existing.configFrozen) {
    if (
      !marketStateMatches(existing, input.authority.publicKey, input.config)
    ) {
      throw new Error(
        "frozen market config does not match approved launch policy",
      );
    }
    return { address, initializeTx: null, updateTx: null };
  }
  if (marketStateMatches(existing, input.authority.publicKey, input.config)) {
    return { address, initializeTx: null, updateTx: null };
  }

  const updateTx = await input.program.methods
    .updateConfig(
      input.authority.publicKey,
      input.config.marketOperator,
      input.config.treasury,
      input.config.marketMaker,
      input.config.tradeTreasuryFeeBps,
      input.config.tradeMarketMakerFeeBps,
      input.config.winningsMarketMakerFeeBps,
    )
    .accountsPartial({
      authority: input.authority.publicKey,
      config: address,
    })
    .signers([input.authority])
    .rpc();
  return { address, initializeTx: null, updateTx };
}

async function freezeOracleConfig(
  program: Program,
  authority: Keypair,
  address: PublicKey,
): Promise<string | null> {
  const account = await (
    program.account as unknown as {
      oracleConfig: {
        fetch: (address: PublicKey) => Promise<OracleConfigAccount>;
      };
    }
  ).oracleConfig.fetch(address);
  if (account.configFrozen) return null;
  return program.methods
    .freezeOracleConfig()
    .accountsPartial({ oracleConfig: address, authority: authority.publicKey })
    .signers([authority])
    .rpc();
}

async function freezeMarketConfig(
  program: Program,
  authority: Keypair,
  address: PublicKey,
): Promise<string | null> {
  const account = await (
    program.account as unknown as {
      marketConfig: {
        fetch: (address: PublicKey) => Promise<MarketConfigAccount>;
      };
    }
  ).marketConfig.fetch(address);
  if (account.configFrozen) return null;
  return program.methods
    .freezeConfig()
    .accountsPartial({ config: address, authority: authority.publicKey })
    .signers([authority])
    .rpc();
}

async function main(): Promise<void> {
  if (hasFlag("--help")) usage();
  if (hasFlag("--pm-only")) {
    throw new Error(
      "--pm-only is retired because this command is SOL duel-only",
    );
  }

  const cluster = parseCluster();
  const freeze = hasFlag("--freeze");
  if (cluster === "mainnet-beta" && !freeze) {
    throw new Error("mainnet configuration must use --freeze");
  }
  if (
    freeze &&
    process.env.SOLANA_LAUNCH_CONFIG_FREEZE_APPROVED?.trim() !== "true"
  ) {
    throw new Error(
      "SOLANA_LAUNCH_CONFIG_FREEZE_APPROVED must be exactly 'true' before freezing configuration",
    );
  }

  const outPath = parseArg("--out");
  const walletPath = resolveStageAWalletPath();
  const authority = readKeypair(walletPath);
  const launchConfig = resolveSolanaDuelLaunchConfig({
    env: process.env,
    configAuthority: authority.publicKey,
  });
  const deployment = resolveSolanaV1Deployment(cluster);
  const rpcUrl = resolveRpcUrl(cluster);
  const connection = new anchor.web3.Connection(rpcUrl, "finalized");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(authority),
    { commitment: "finalized" },
  );
  const expectedUpgradeAuthority = resolveExpectedUpgradeAuthority({
    value:
      process.env.SOLANA_EXPECTED_UPGRADE_AUTHORITY?.trim() ||
      (cluster === "mainnet-beta" ? undefined : authority.publicKey.toBase58()),
    required: cluster === "mainnet-beta",
    label: "Solana v1 configuration",
  });

  const oracleProgramId = new PublicKey(deployment.fightOracleProgramId);
  const marketProgramId = new PublicKey(deployment.duelMarketProgramId);
  const identities = await Promise.all([
    fetchSolanaProgramDeploymentIdentity({
      connection,
      label: "fight oracle",
      programId: oracleProgramId,
      expectedUpgradeAuthority,
      requireDeployed: true,
    }),
    fetchSolanaProgramDeploymentIdentity({
      connection,
      label: "duel market",
      programId: marketProgramId,
      expectedUpgradeAuthority,
      requireDeployed: true,
    }),
  ]);
  evaluateFightOracleAccountSchema({
    programId: oracleProgramId,
    oracleConfigAccount: await connection.getAccountInfo(
      deriveOracleConfigPda(oracleProgramId),
      "finalized",
    ),
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const anchorRoot = path.join(path.resolve(__dirname, ".."), "anchor");
  const oracleProgram = new Program(
    loadIdlWithAddress(
      path.join(anchorRoot, "target", "idl", "fight_oracle.json"),
      oracleProgramId,
    ),
    provider,
  );
  const marketProgram = new Program(
    loadIdlWithAddress(
      path.join(anchorRoot, "target", "idl", "duel_market.json"),
      marketProgramId,
    ),
    provider,
  );

  const oracleMutation = await ensureOracleConfig({
    program: oracleProgram,
    authority,
    config: launchConfig,
  });
  const marketMutation = await ensureMarketConfig({
    program: marketProgram,
    authority,
    config: launchConfig,
  });
  const freezeOracleTx = freeze
    ? await freezeOracleConfig(oracleProgram, authority, oracleMutation.address)
    : null;
  const freezeMarketTx = freeze
    ? await freezeMarketConfig(marketProgram, authority, marketMutation.address)
    : null;

  const oracleState = await (
    oracleProgram.account as unknown as {
      oracleConfig: {
        fetch: (address: PublicKey) => Promise<OracleConfigAccount>;
      };
    }
  ).oracleConfig.fetch(oracleMutation.address);
  const marketState = await (
    marketProgram.account as unknown as {
      marketConfig: {
        fetch: (address: PublicKey) => Promise<MarketConfigAccount>;
      };
    }
  ).marketConfig.fetch(marketMutation.address);
  if (!oracleStateMatches(oracleState, authority.publicKey, launchConfig)) {
    throw new Error("oracle config did not converge to approved launch policy");
  }
  if (!marketStateMatches(marketState, authority.publicKey, launchConfig)) {
    throw new Error("market config did not converge to approved launch policy");
  }
  if (freeze && (!oracleState.configFrozen || !marketState.configFrozen)) {
    throw new Error("configuration freeze did not reach both launch programs");
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    cluster,
    rpcEndpoint: describeRpcEndpoint(rpcUrl),
    scope: "solana-duel-v1",
    freezeRequested: freeze,
    authority: authority.publicKey.toBase58(),
    launchConfig: serializeSolanaDuelLaunchConfig(launchConfig),
    programs: {
      fightOracle: {
        programId: oracleProgramId.toBase58(),
        programData: identities[0].programDataAddress.toBase58(),
        deployedSlot:
          identities[0].mode === "upgrade"
            ? identities[0].deployedSlot.toString()
            : null,
        config: oracleMutation.address.toBase58(),
        initializeTx: oracleMutation.initializeTx,
        updateTx: oracleMutation.updateTx,
        freezeTx: freezeOracleTx,
        frozen: oracleState.configFrozen,
      },
      duelMarket: {
        programId: marketProgramId.toBase58(),
        programData: identities[1].programDataAddress.toBase58(),
        deployedSlot:
          identities[1].mode === "upgrade"
            ? identities[1].deployedSlot.toString()
            : null,
        config: marketMutation.address.toBase58(),
        initializeTx: marketMutation.initializeTx,
        updateTx: marketMutation.updateTx,
        freezeTx: freezeMarketTx,
        frozen: marketState.configFrozen,
      },
    },
  };
  writeSummary(outPath, summary);
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error("[solana-duel-init] failed:", error);
  process.exitCode = 1;
});
