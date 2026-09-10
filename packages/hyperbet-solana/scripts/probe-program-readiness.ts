import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";

import {
  resolveSolanaV1Deployment,
  type SolanaV1Cluster,
} from "../deployments/v1";
import { describeRpcEndpoint } from "./solana-deployment-evidence";
import { evaluateSolanaProgramDispatchReadiness } from "./solana-program-readiness";
import { buildSolanaProgramReadinessInstructions } from "./solana-program-readiness-instructions";
import type {
  SolanaReadinessInitializationConfiguration,
  SolanaReadinessRolePublicKeys,
} from "./solana-program-readiness-instructions";
import { resolveStageAWalletPath } from "./stage-a-identity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  console.log(`usage: bun packages/hyperbet-solana/scripts/probe-program-readiness.ts \\
  [--cluster localnet|devnet|testnet|mainnet-beta] [--rpc-url <url>] [--wallet <path>]
  --oracle-dispute-window-secs <integer>
  --trade-treasury-fee-bps <integer>
  --trade-market-maker-fee-bps <integer>
  --winnings-market-maker-fee-bps <integer>
  --reporter <pubkey> --finalizer <pubkey> --challenger <pubkey>
  --market-operator <pubkey> --treasury <pubkey> --market-maker <pubkey>

Simulates each configured SOL duel program's real, signed initializer instruction.
The probe never submits a transaction and succeeds only after both finalized-bank
initializer simulations complete without an instruction error. Configuration and
role values have no built-in defaults; the equivalent SOLANA_* environment values
may be supplied instead.
`);
  process.exit(0);
}

function parseCluster(): SolanaV1Cluster {
  const value = parseArg("--cluster") ?? "localnet";
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

function resolveRpcUrl(cluster: SolanaV1Cluster): string {
  const explicit = parseArg("--rpc-url") ?? process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  if (cluster === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cluster);
}

function readWallet(): Keypair {
  const filepath = parseArg("--wallet") ?? resolveStageAWalletPath();
  const bytes = JSON.parse(fs.readFileSync(filepath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function readRequiredValue(flag: string, environmentName: string): string {
  const value = parseArg(flag) ?? process.env[environmentName]?.trim();
  if (!value) {
    throw new Error(
      `${flag} or ${environmentName} is required; readiness cannot invent launch configuration`,
    );
  }
  return value;
}

function readInteger(
  flag: string,
  environmentName: string,
  minimum: number,
  maximum: number,
): number {
  const raw = readRequiredValue(flag, environmentName);
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be a base-10 integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function readPublicKey(flag: string, environmentName: string): PublicKey {
  const raw = readRequiredValue(flag, environmentName);
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`${flag} must be a valid Solana public key`);
  }
}

function readInitializationConfiguration(): SolanaReadinessInitializationConfiguration {
  return {
    oracleDisputeWindowSeconds: readInteger(
      "--oracle-dispute-window-secs",
      "SOLANA_ORACLE_DISPUTE_WINDOW_SECS",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    tradeTreasuryFeeBps: readInteger(
      "--trade-treasury-fee-bps",
      "TRADE_TREASURY_FEE_BPS",
      0,
      65_535,
    ),
    tradeMarketMakerFeeBps: readInteger(
      "--trade-market-maker-fee-bps",
      "TRADE_MARKET_MAKER_FEE_BPS",
      0,
      65_535,
    ),
    winningsMarketMakerFeeBps: readInteger(
      "--winnings-market-maker-fee-bps",
      "WINNINGS_MARKET_MAKER_FEE_BPS",
      0,
      65_535,
    ),
  };
}

function readRolePublicKeys(): SolanaReadinessRolePublicKeys {
  return {
    reporter: readPublicKey("--reporter", "SOLANA_PM_REPORTER_PUBKEY"),
    finalizer: readPublicKey("--finalizer", "SOLANA_PM_FINALIZER_PUBKEY"),
    challenger: readPublicKey("--challenger", "SOLANA_PM_CHALLENGER_PUBKEY"),
    marketOperator: readPublicKey(
      "--market-operator",
      "SOLANA_PM_MARKET_OPERATOR_PUBKEY",
    ),
    treasury: readPublicKey("--treasury", "SOLANA_PM_TREASURY_PUBKEY"),
    marketMaker: readPublicKey(
      "--market-maker",
      "SOLANA_PM_MARKET_MAKER_PUBKEY",
    ),
  };
}

function readIdl(name: string): Idl {
  return JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "anchor", "target", "idl", `${name}.json`),
      "utf8",
    ),
  ) as Idl;
}

async function simulateProgramDispatch(input: {
  connection: Connection;
  payer: Keypair;
  programId: string;
  instruction: TransactionInstruction;
}) {
  const transaction = new Transaction().add(input.instruction);
  transaction.feePayer = input.payer.publicKey;
  const response = await input.connection.simulateTransaction(transaction, [
    input.payer,
  ]);
  return evaluateSolanaProgramDispatchReadiness({
    programId: input.programId,
    simulation: {
      error: response.value.err,
      logs: response.value.logs,
    },
  });
}

async function main(): Promise<void> {
  if (hasFlag("--help")) usage();

  const cluster = parseCluster();
  const rpcUrl = resolveRpcUrl(cluster);
  const payer = readWallet();
  const configuration = readInitializationConfiguration();
  const roles = readRolePublicKeys();
  const deployment = resolveSolanaV1Deployment(cluster);
  const connection = new Connection(rpcUrl, "finalized");
  const programs = buildSolanaProgramReadinessInstructions({
    deployment,
    payer: payer.publicKey,
    fightOracleIdl: readIdl("fight_oracle"),
    duelMarketIdl: readIdl("duel_market"),
    configuration,
    roles,
  });
  const results = [];
  for (const program of programs) {
    results.push({
      label: program.label,
      instruction: program.instructionName,
      ...(await simulateProgramDispatch({
        connection,
        payer,
        programId: program.programId,
        instruction: program.instruction,
      })),
    });
  }

  const evidence = {
    ready: results.every((result) => result.ready),
    cluster,
    commitment: "finalized",
    rpcEndpoint: describeRpcEndpoint(rpcUrl),
    payer: payer.publicKey.toBase58(),
    initialization: {
      ...configuration,
      reporter: roles.reporter.toBase58(),
      finalizer: roles.finalizer.toBase58(),
      challenger: roles.challenger.toBase58(),
      marketOperator: roles.marketOperator.toBase58(),
      treasury: roles.treasury.toBase58(),
      marketMaker: roles.marketMaker.toBase58(),
    },
    programs: results,
  };
  console.log(JSON.stringify(evidence));
  if (!evidence.ready) {
    const failures = results
      .filter((result) => !result.ready)
      .map((result) => `${result.label}: ${result.reason}`)
      .join("; ");
    throw new Error(`SOL program dispatch is not ready: ${failures}`);
  }
}

void main().catch((error) => {
  console.error(
    `[solana-program-readiness] error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
