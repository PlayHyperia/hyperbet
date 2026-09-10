import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";

import {
  resolveSolanaV1Deployment,
  type SolanaV1Cluster,
} from "../deployments/v1";
import { resolveExpectedUpgradeAuthority } from "../keeper/src/solanaProgramIdentity";
import { readKeypairPubkey, resolveStageAWalletPath } from "./stage-a-identity";
import { describeRpcEndpoint } from "./solana-deployment-evidence";
import { fetchSolanaProgramDeploymentIdentity } from "./solana-deployment-identity";
import { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../account-schema";
import { evaluateFightOracleAccountSchema } from "./solana-account-schema";
import {
  resolveSolanaDuelLaunchConfig,
  serializeSolanaDuelLaunchConfig,
  type SolanaDuelLaunchConfig,
} from "./solana-launch-config";
import {
  pauseStateFailures,
  resolveDeploymentPauseExpectation,
} from "./deployment-pause-expectation";

interface OracleConfigAccount {
  authority: PublicKey;
  reporter: PublicKey;
  finalizer: PublicKey;
  challenger: PublicKey;
  disputeWindowSecs: anchor.BN;
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
  console.log(
    "usage: node --import tsx packages/hyperbet-solana/scripts/verify-deployment.ts [--cluster devnet|testnet|mainnet-beta|localnet] [--out <path>] [--expect-oracle-paused=true|false] [--expect-order-placement-paused=true|false] [--expect-market-creation-paused=true|false]",
  );
  process.exit(0);
}

function resolveRpcUrl(cluster: SolanaV1Cluster): string {
  const explicit = process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  if (cluster === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cluster);
}

function resolveConfigAuthority(): PublicKey {
  const explicit =
    process.env.SOLANA_EXPECTED_CONFIG_AUTHORITY?.trim() ||
    process.env.SOLANA_EXPECTED_AUTHORITY?.trim();
  if (explicit) {
    const value = new PublicKey(explicit);
    if (value.equals(PublicKey.default)) {
      throw new Error("expected config authority cannot be the zero key");
    }
    return value;
  }

  try {
    return new PublicKey(readKeypairPubkey(resolveStageAWalletPath()));
  } catch {
    throw new Error(
      "SOLANA_EXPECTED_CONFIG_AUTHORITY or SOLANA_EXPECTED_AUTHORITY is required when no Stage-A wallet is available",
    );
  }
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

function appendCheck(ok: boolean, message: string, failures: string[]): void {
  console.log(`${ok ? "[ok]" : "[fail]"} ${message}`);
  if (!ok) failures.push(message);
}

function verifyOracleConfig(input: {
  state: OracleConfigAccount | null;
  authority: PublicKey;
  expected: SolanaDuelLaunchConfig;
  failures: string[];
}): void {
  appendCheck(input.state !== null, "oracle config exists", input.failures);
  if (!input.state) return;
  appendCheck(
    input.state.accountSchemaVersion === FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
    `oracle account schema is v${FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION}`,
    input.failures,
  );
  appendCheck(
    input.state.authority.equals(input.authority),
    `oracle authority matches ${input.authority.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.reporter.equals(input.expected.reporter),
    `oracle reporter matches ${input.expected.reporter.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.finalizer.equals(input.expected.finalizer),
    `oracle finalizer matches ${input.expected.finalizer.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.challenger.equals(input.expected.challenger),
    `oracle challenger matches ${input.expected.challenger.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.disputeWindowSecs.toNumber() ===
      input.expected.disputeWindowSecs,
    `oracle dispute window is ${input.expected.disputeWindowSecs} seconds`,
    input.failures,
  );
  appendCheck(
    input.state.configFrozen === true,
    "oracle config is frozen",
    input.failures,
  );
}

function verifyMarketConfig(input: {
  state: MarketConfigAccount | null;
  authority: PublicKey;
  expected: SolanaDuelLaunchConfig;
  failures: string[];
}): void {
  appendCheck(
    input.state !== null,
    "duel market config exists",
    input.failures,
  );
  if (!input.state) return;
  appendCheck(
    input.state.authority.equals(input.authority),
    `market authority matches ${input.authority.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.marketOperator.equals(input.expected.marketOperator),
    `market operator matches ${input.expected.marketOperator.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.treasury.equals(input.expected.treasury),
    `treasury matches ${input.expected.treasury.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.marketMaker.equals(input.expected.marketMaker),
    `market maker matches ${input.expected.marketMaker.toBase58()}`,
    input.failures,
  );
  appendCheck(
    input.state.tradeTreasuryFeeBps === input.expected.tradeTreasuryFeeBps,
    `trade treasury fee is ${input.expected.tradeTreasuryFeeBps} bps`,
    input.failures,
  );
  appendCheck(
    input.state.tradeMarketMakerFeeBps ===
      input.expected.tradeMarketMakerFeeBps,
    `trade market-maker fee is ${input.expected.tradeMarketMakerFeeBps} bps`,
    input.failures,
  );
  appendCheck(
    input.state.winningsMarketMakerFeeBps ===
      input.expected.winningsMarketMakerFeeBps,
    `winnings market-maker fee is ${input.expected.winningsMarketMakerFeeBps} bps`,
    input.failures,
  );
  appendCheck(
    input.state.configFrozen === true,
    "market config is frozen",
    input.failures,
  );
}

async function main(): Promise<void> {
  if (hasFlag("--help")) usage();
  if (hasFlag("--pm-only")) {
    throw new Error(
      "--pm-only is retired because this command is SOL duel-only",
    );
  }

  const cluster = parseCluster();
  const outPath = parseArg("--out");
  const pauseExpectation = resolveDeploymentPauseExpectation(
    process.argv.slice(2),
  );
  const configAuthority = resolveConfigAuthority();
  const expectedConfig = resolveSolanaDuelLaunchConfig({
    env: process.env,
    configAuthority,
  });
  const expectedUpgradeAuthority = resolveExpectedUpgradeAuthority({
    value:
      process.env.SOLANA_EXPECTED_UPGRADE_AUTHORITY?.trim() ||
      (cluster === "mainnet-beta" ? undefined : configAuthority.toBase58()),
    required: cluster === "mainnet-beta",
    label: "Solana v1 deployment verification",
  });
  const deployment = resolveSolanaV1Deployment(cluster);
  const rpcUrl = resolveRpcUrl(cluster);
  const connection = new anchor.web3.Connection(rpcUrl, "finalized");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(Keypair.generate()),
    { commitment: "finalized" },
  );
  const oracleProgramId = new PublicKey(deployment.fightOracleProgramId);
  const marketProgramId = new PublicKey(deployment.duelMarketProgramId);
  const [oracleIdentity, marketIdentity] = await Promise.all([
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
  if (oracleIdentity.mode !== "upgrade" || marketIdentity.mode !== "upgrade") {
    throw new Error("deployment verification requires both programs on-chain");
  }
  const rawOracleSchema = evaluateFightOracleAccountSchema({
    programId: oracleProgramId,
    oracleConfigAccount: await connection.getAccountInfo(
      deriveOracleConfigPda(oracleProgramId),
      "finalized",
    ),
  });
  if (rawOracleSchema.status !== "current") {
    throw new Error(
      "deployment verification requires an initialized v2 oracle config",
    );
  }

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
  const oracleConfigAddress = deriveOracleConfigPda(oracleProgramId);
  const marketConfigAddress = deriveMarketConfigPda(marketProgramId);
  const [oracleState, marketState] = await Promise.all([
    (
      oracleProgram.account as unknown as {
        oracleConfig: {
          fetchNullable: (
            address: PublicKey,
          ) => Promise<OracleConfigAccount | null>;
        };
      }
    ).oracleConfig.fetchNullable(oracleConfigAddress),
    (
      marketProgram.account as unknown as {
        marketConfig: {
          fetchNullable: (
            address: PublicKey,
          ) => Promise<MarketConfigAccount | null>;
        };
      }
    ).marketConfig.fetchNullable(marketConfigAddress),
  ]);

  const failures: string[] = [];
  verifyOracleConfig({
    state: oracleState,
    authority: configAuthority,
    expected: expectedConfig,
    failures,
  });
  verifyMarketConfig({
    state: marketState,
    authority: configAuthority,
    expected: expectedConfig,
    failures,
  });
  if (oracleState && marketState) {
    const pauseFailures = pauseStateFailures(
      {
        oraclePaused: oracleState.paused,
        orderPlacementPaused: marketState.orderPlacementPaused,
        marketCreationPaused: marketState.marketCreationPaused,
      },
      pauseExpectation,
    );
    if (pauseFailures.length === 0) {
      appendCheck(
        true,
        "all pause states match the explicit expectation",
        failures,
      );
    } else {
      for (const failure of pauseFailures)
        appendCheck(false, failure, failures);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    cluster,
    rpcEndpoint: describeRpcEndpoint(rpcUrl),
    scope: "solana-duel-v1",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    configAuthority: configAuthority.toBase58(),
    pauseExpectation,
    observedPauseState: {
      oraclePaused: oracleState?.paused ?? null,
      orderPlacementPaused: marketState?.orderPlacementPaused ?? null,
      marketCreationPaused: marketState?.marketCreationPaused ?? null,
    },
    expectedConfig: serializeSolanaDuelLaunchConfig(expectedConfig),
    programs: {
      fightOracle: {
        programId: oracleProgramId.toBase58(),
        programData: oracleIdentity.programDataAddress.toBase58(),
        deployedSlot: oracleIdentity.deployedSlot.toString(),
        upgradeAuthority:
          oracleIdentity.upgradeAuthority?.toBase58() ?? "immutable",
        config: oracleConfigAddress.toBase58(),
        configFrozen: oracleState?.configFrozen ?? null,
      },
      duelMarket: {
        programId: marketProgramId.toBase58(),
        programData: marketIdentity.programDataAddress.toBase58(),
        deployedSlot: marketIdentity.deployedSlot.toString(),
        upgradeAuthority:
          marketIdentity.upgradeAuthority?.toBase58() ?? "immutable",
        config: marketConfigAddress.toBase58(),
        configFrozen: marketState?.configFrozen ?? null,
      },
    },
  };
  writeSummary(outPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error("[solana-duel-verify] failed:", error);
  process.exitCode = 1;
});
