import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, type Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import dotenv from "dotenv";

import { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../../account-schema";
import { resolveSolanaV1Deployment } from "../../deployments/v1";
import fightOracleIdl from "./idl/fight_oracle.json";
import type { FightOracle } from "./idl/fight_oracle";
import duelMarketIdl from "./idl/duel_market.json";
import type { DuelMarket as DuelMarketIdl } from "./idl/duel_market";

export type DuelMarket = DuelMarketIdl;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keeperRoot = path.resolve(__dirname, "..");
const demoRootCandidate = path.resolve(__dirname, "../..");
const envRoot = fs.existsSync(path.join(demoRootCandidate, ".env.mainnet"))
  ? demoRootCandidate
  : keeperRoot;
const configuredClusterRaw =
  process.env.SOLANA_CLUSTER ||
  process.env.CLUSTER ||
  process.env.VITE_SOLANA_CLUSTER ||
  "mainnet-beta";
const configuredCluster = configuredClusterRaw.toLowerCase();
const envClusterSuffix =
  configuredCluster === "mainnet" || configuredCluster === "mainnet-beta"
    ? "mainnet"
    : configuredCluster;

dotenv.config({ path: path.join(envRoot, `.env.${envClusterSuffix}`) });
dotenv.config({ path: path.join(envRoot, ".env") });

type SignableTx = Transaction | VersionedTransaction;
type AnchorLikeWallet = Wallet & { payer: Keypair };

function signTx(tx: SignableTx, signer: Keypair): SignableTx {
  if (tx instanceof VersionedTransaction) tx.sign([signer]);
  else tx.partialSign(signer);
  return tx;
}

function toAnchorWallet(signer: Keypair): AnchorLikeWallet {
  return {
    payer: signer,
    publicKey: signer.publicKey,
    signTransaction: async <T extends SignableTx>(tx: T): Promise<T> =>
      signTx(tx, signer) as T,
    signAllTransactions: async <T extends SignableTx[]>(txs: T): Promise<T> => {
      txs.forEach((tx) => signTx(tx, signer));
      return txs;
    },
  };
}

export function getRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (configuredCluster === "localnet") return "http://127.0.0.1:8899";
  if (configuredCluster === "testnet") return "https://api.testnet.solana.com";
  if (configuredCluster === "devnet") return "https://api.devnet.solana.com";
  const heliusApiKey = process.env.HELIUS_API_KEY;
  return heliusApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : "https://api.mainnet-beta.solana.com";
}

export function getRpcWsUrl(): string | undefined {
  return (
    process.env.SOLANA_RPC_WS_URL?.trim() ||
    process.env.SOLANA_WS_URL?.trim() ||
    undefined
  );
}

export function getSenderUrl(): string | null {
  const heliusApiKey = process.env.HELIUS_API_KEY;
  return heliusApiKey
    ? `https://sender.helius-rpc.com/fast?api-key=${heliusApiKey}`
    : null;
}

function redactUrl(url: string): string {
  return url
    .replace(
      /([?&](?:api[-_]?key|token|secret|authorization|credential)=)[^&#\s]*/gi,
      "$1***",
    )
    .replace(/(authorization:\s*bearer\s+)[^\s,;]+/gi, "$1***")
    .replace(
      /((?:api[-_]?key|token|secret|credential)\s*[=:]\s*)[^\s,&;]+/gi,
      "$1***",
    );
}

export function sanitizeErrorMessage(error: unknown): string {
  return redactUrl(error instanceof Error ? error.message : String(error));
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function readKeypair(keypairRef: string): Keypair {
  const trimmed = keypairRef.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(trimmed) as number[]),
    );
  }
  if (trimmed.startsWith("base64:")) {
    return Keypair.fromSecretKey(
      Uint8Array.from(
        Buffer.from(trimmed.slice("base64:".length).trim(), "base64"),
      ),
    );
  }
  const expanded = trimmed.startsWith("~")
    ? path.join(process.env.HOME ?? "", trimmed.slice(1))
    : trimmed;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(expanded, "utf8")) as number[]),
  );
}

function ensureIdlAddress(idlJson: unknown, programId: PublicKey): Idl {
  return { ...(idlJson as Idl), address: programId.toBase58() } as Idl;
}

const deployment = resolveSolanaV1Deployment(configuredClusterRaw);
export const FIGHT_ORACLE_PROGRAM_ID = new PublicKey(
  process.env.FIGHT_ORACLE_PROGRAM_ID?.trim() ||
    deployment.fightOracleProgramId,
);
export const DUEL_MARKET_PROGRAM_ID = new PublicKey(
  process.env.DUEL_MARKET_PROGRAM_ID?.trim() || deployment.duelMarketProgramId,
);

export type LaunchPrograms = {
  connection: Connection;
  provider: AnchorProvider;
  fightOracle: Program<FightOracle>;
  duelMarket: Program<DuelMarket>;
};

export function createLaunchPrograms(signer: Keypair): LaunchPrograms {
  const connection = new Connection(getRpcUrl(), {
    commitment: "confirmed",
    wsEndpoint: getRpcWsUrl(),
  });
  const provider = new AnchorProvider(connection, toAnchorWallet(signer), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return {
    connection,
    provider,
    fightOracle: new Program(
      ensureIdlAddress(fightOracleIdl, FIGHT_ORACLE_PROGRAM_ID) as FightOracle,
      provider,
    ),
    duelMarket: new Program(
      ensureIdlAddress(duelMarketIdl, DUEL_MARKET_PROGRAM_ID) as DuelMarket,
      provider,
    ),
  };
}

/**
 * Creates a parser-only client with an ephemeral in-memory wallet. The service
 * never submits transactions, so it must not be given any keeper authority key.
 */
export function createReadOnlyLaunchPrograms(): LaunchPrograms {
  return createLaunchPrograms(Keypair.generate());
}

export function findOracleConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_config")],
    programId,
  )[0];
}

export const DUEL_WINNER_MARKET_KIND = 1;
export { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION };
export const SIDE_BID = 1;
export const SIDE_ASK = 2;
export const ORDER_BEHAVIOR_POST_ONLY = 2;

function u64LeBuffer(value: bigint | number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

export function duelKeyHexToBytes(duelKeyHex: string): Uint8Array {
  const normalized = duelKeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("duelKeyHex must be a 32-byte hex string");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

export function findDuelStatePda(
  programId: PublicKey,
  duelKey: Uint8Array,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("duel"), Buffer.from(duelKey)],
    programId,
  )[0];
}

export function findProposalRecordPda(
  programId: PublicKey,
  duelKey: Uint8Array | readonly number[],
  resultHash: Uint8Array | readonly number[],
  replayHash: Uint8Array | readonly number[],
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("proposal"),
      Buffer.from(duelKey),
      Buffer.from(resultHash),
      Buffer.from(replayHash),
    ],
    programId,
  )[0];
}

export function findMarketPda(
  programId: PublicKey,
  duelStatePda: PublicKey,
  marketKind = DUEL_WINNER_MARKET_KIND,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), duelStatePda.toBuffer(), Uint8Array.of(marketKind)],
    programId,
  )[0];
}

export function findMarketConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  )[0];
}

export function findClobVaultPda(
  programId: PublicKey,
  marketPda: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    programId,
  )[0];
}

export function findUserBalancePda(
  programId: PublicKey,
  marketPda: PublicKey,
  owner: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("balance"), marketPda.toBuffer(), owner.toBuffer()],
    programId,
  )[0];
}

export function findOrderPda(
  programId: PublicKey,
  marketPda: PublicKey,
  orderId: bigint,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), marketPda.toBuffer(), u64LeBuffer(orderId)],
    programId,
  )[0];
}

export function findPriceLevelPda(
  programId: PublicKey,
  marketPda: PublicKey,
  side: number,
  price: number,
): PublicKey {
  const priceBytes = Buffer.alloc(2);
  priceBytes.writeUInt16LE(price);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("level"),
      marketPda.toBuffer(),
      Uint8Array.of(side),
      priceBytes,
    ],
    programId,
  )[0];
}

export function enumIs(value: unknown, variant: string): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value as Record<string, unknown>)[0] === variant;
}
