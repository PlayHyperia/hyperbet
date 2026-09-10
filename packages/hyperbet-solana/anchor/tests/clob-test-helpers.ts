import crypto from "node:crypto";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  type AccountMeta,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import { FightOracle } from "../target/types/fight_oracle";
import { DuelMarket } from "../target/types/duel_market";
import {
  confirmSignatureByPolling,
  sendVersionedTransactionWithLookupTable,
} from "./test-anchor";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export const DUEL_WINNER_MARKET_KIND = 1;
export const SIDE_BID = 1;
export const SIDE_ASK = 2;
export const ORDER_BEHAVIOR_GTC = 0;
export const ORDER_BEHAVIOR_IOC = 1;
export const ORDER_BEHAVIOR_POST_ONLY = 2;
export const RESULT_HASH_DOMAIN = "hyperia-duel-result-v2";
const duelKeyCounters = new Map<string, number>();

function bnLikeToNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof BN) {
    return value.toNumber();
  }
  if (value && typeof value === "object" && "toNumber" in value) {
    const toNumber = (value as { toNumber?: () => number }).toNumber;
    if (typeof toNumber === "function") {
      return toNumber.call(value);
    }
  }
  return Number(value ?? 0);
}

function u16Le(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u64Le(value: bigint | number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function u32Le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

export function buildCanonicalResultHash(input: {
  duelKey: readonly number[];
  winner: { a: Record<string, never> } | { b: Record<string, never> };
  seed: bigint | number;
  replayHash: readonly number[];
  competitiveSnapshotVersion: number;
  competitiveSnapshotDigest: readonly number[];
}): number[] {
  const winnerTag = "a" in input.winner ? 1 : 2;
  return Array.from(
    crypto
      .createHash("sha256")
      .update(RESULT_HASH_DOMAIN, "ascii")
      .update(Buffer.from(input.duelKey))
      .update(Buffer.from([winnerTag]))
      .update(u64Le(input.seed))
      .update(Buffer.from(input.replayHash))
      .update(u32Le(input.competitiveSnapshotVersion))
      .update(Buffer.from(input.competitiveSnapshotDigest))
      .digest(),
  );
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function currentChainUnixTimestamp(
  connection: anchor.web3.Connection,
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const slot = await connection.getSlot("confirmed");
      const blockTime = await connection.getBlockTime(slot);
      if (
        typeof blockTime === "number" &&
        Number.isFinite(blockTime) &&
        blockTime > 0
      ) {
        return blockTime;
      }
    } catch {
      // Fall back to the local clock below if block time is temporarily unavailable.
    }
    await sleep(250);
  }
  return Math.floor(Date.now() / 1000);
}

export async function waitForChainUnixTimestamp(
  connection: anchor.web3.Connection,
  minimumUnixTimestamp: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await currentChainUnixTimestamp(connection);
    const wallClock = Math.floor(Date.now() / 1000);
    if (current >= minimumUnixTimestamp || wallClock >= minimumUnixTimestamp) {
      return;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for chain time >= ${minimumUnixTimestamp}`,
  );
}

function toBn(value: bigint | number): BN {
  return new BN(BigInt(value).toString());
}

export function uniqueDuelKey(label: string): number[] {
  const next = (duelKeyCounters.get(label) ?? 0) + 1;
  duelKeyCounters.set(label, next);
  const salt = Date.now();
  return Array.from(
    crypto.createHash("sha256").update(`${label}:${next}:${salt}`).digest(),
  );
}

export function hashLabel(label: string): number[] {
  return Array.from(crypto.createHash("sha256").update(label).digest());
}

export function duelStatusScheduled(): { scheduled: Record<string, never> } {
  return { scheduled: {} };
}

export function duelStatusBettingOpen(): {
  bettingOpen: Record<string, never>;
} {
  return { bettingOpen: {} };
}

export function duelStatusLocked(): { locked: Record<string, never> } {
  return { locked: {} };
}

export function marketSideA(): { a: Record<string, never> } {
  return { a: {} };
}

export function marketSideB(): { b: Record<string, never> } {
  return { b: {} };
}

export function deriveProgramDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

export function deriveOracleConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_config")],
    programId,
  )[0];
}

export function deriveDuelStatePda(
  programId: PublicKey,
  duelKey: readonly number[],
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("duel"), Buffer.from(duelKey)],
    programId,
  )[0];
}

export function deriveProposalRecordPda(
  programId: PublicKey,
  duelKey: readonly number[],
  resultHash: readonly number[],
  replayHash: readonly number[],
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

export function deriveMarketConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  )[0];
}

export function deriveMarketStatePda(
  programId: PublicKey,
  duelState: PublicKey,
  marketKind = DUEL_WINNER_MARKET_KIND,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), duelState.toBuffer(), Buffer.from([marketKind])],
    programId,
  )[0];
}

export function deriveClobVaultPda(
  programId: PublicKey,
  marketState: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketState.toBuffer()],
    programId,
  )[0];
}

export function deriveUserBalancePda(
  programId: PublicKey,
  marketState: PublicKey,
  user: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("balance"), marketState.toBuffer(), user.toBuffer()],
    programId,
  )[0];
}

export function deriveOrderPda(
  programId: PublicKey,
  marketState: PublicKey,
  orderId: bigint | number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), marketState.toBuffer(), u64Le(orderId)],
    programId,
  )[0];
}

export function derivePriceLevelPda(
  programId: PublicKey,
  marketState: PublicKey,
  side: number,
  price: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("level"),
      marketState.toBuffer(),
      Buffer.from([side]),
      u16Le(price),
    ],
    programId,
  )[0];
}

export async function airdrop(
  connection: anchor.web3.Connection,
  recipient: PublicKey,
  sol = 5,
): Promise<void> {
  const signature = await connection.requestAirdrop(
    recipient,
    sol * LAMPORTS_PER_SOL,
  );
  await confirmSignatureByPolling(connection, signature);
}

export function hasProgramError(error: unknown, fragment: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(fragment);
}

function enumIs(value: unknown, key: string): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    key in (value as Record<string, unknown>),
  );
}

export function writableAccount(pubkey: PublicKey): AccountMeta {
  return {
    pubkey,
    isSigner: false,
    isWritable: true,
  };
}

export async function ensureOracleReady(
  program: Program<FightOracle>,
  authority: Keypair,
  reporter = authority.publicKey,
  finalizer = authority.publicKey,
  challenger = authority.publicKey,
  disputeWindowSecs = 60,
  freeze = true,
): Promise<PublicKey> {
  const oracleConfig = deriveOracleConfigPda(program.programId);
  const existingConfig =
    await program.account.oracleConfig.fetchNullable(oracleConfig);

  if (!existingConfig) {
    await program.methods
      .initializeOracle(
        reporter,
        finalizer,
        challenger,
        new BN(disputeWindowSecs),
      )
      .accountsPartial({
        authority: authority.publicKey,
        oracleConfig,
        program: program.programId,
        programData: deriveProgramDataAddress(program.programId),
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
  } else {
    try {
      await program.methods
        .updateOracleConfig(
          authority.publicKey,
          reporter,
          finalizer,
          challenger,
          new BN(disputeWindowSecs),
        )
        .accountsPartial({
          authority: authority.publicKey,
          oracleConfig,
        })
        .signers([authority])
        .rpc();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ConfigFrozen/i.test(message)) {
        throw error;
      }
    }
  }

  const currentConfig = await program.account.oracleConfig.fetch(oracleConfig);
  if (freeze && !currentConfig.configFrozen) {
    await program.methods
      .freezeOracleConfig()
      .accountsPartial({
        authority: authority.publicKey,
        oracleConfig,
      })
      .signers([authority])
      .rpc();
  }

  return oracleConfig;
}

export async function ensureClobConfig(
  program: Program<DuelMarket>,
  authority: Keypair,
  options?: {
    marketOperator?: PublicKey;
    treasury?: PublicKey;
    marketMaker?: PublicKey;
    tradeTreasuryFeeBps?: number;
    tradeMarketMakerFeeBps?: number;
    winningsMarketMakerFeeBps?: number;
  },
): Promise<PublicKey> {
  const config = deriveMarketConfigPda(program.programId);
  const marketOperator = options?.marketOperator ?? authority.publicKey;
  const treasury = options?.treasury ?? authority.publicKey;
  const marketMaker = options?.marketMaker ?? authority.publicKey;
  const tradeTreasuryFeeBps = options?.tradeTreasuryFeeBps ?? 100;
  const tradeMarketMakerFeeBps = options?.tradeMarketMakerFeeBps ?? 100;
  const winningsMarketMakerFeeBps = options?.winningsMarketMakerFeeBps ?? 200;
  const existingConfig =
    await program.account.marketConfig.fetchNullable(config);

  if (!existingConfig) {
    await program.methods
      .initializeConfig(
        marketOperator,
        treasury,
        marketMaker,
        tradeTreasuryFeeBps,
        tradeMarketMakerFeeBps,
        winningsMarketMakerFeeBps,
      )
      .accountsPartial({
        authority: authority.publicKey,
        config,
        program: program.programId,
        programData: deriveProgramDataAddress(program.programId),
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    return config;
  }

  await program.methods
    .updateConfig(
      authority.publicKey,
      marketOperator,
      treasury,
      marketMaker,
      tradeTreasuryFeeBps,
      tradeMarketMakerFeeBps,
      winningsMarketMakerFeeBps,
    )
    .accountsPartial({
      authority: authority.publicKey,
      config,
    })
    .signers([authority])
    .rpc();

  return config;
}

export async function upsertDuel(
  program: Program<FightOracle>,
  reporter: Keypair,
  duelKey: readonly number[],
  options: {
    status:
      | { scheduled: Record<string, never> }
      | { bettingOpen: Record<string, never> }
      | { locked: Record<string, never> };
    betOpenTs: number;
    betCloseTs: number;
    duelStartTs?: number;
    participantAHash?: readonly number[];
    participantBHash?: readonly number[];
    competitiveSnapshotVersion?: number;
    competitiveSnapshotDigest?: readonly number[];
    metadataUri?: string;
  },
): Promise<PublicKey> {
  const oracleConfig = deriveOracleConfigPda(program.programId);
  const duelState = deriveDuelStatePda(program.programId, duelKey);

  await program.methods
    .upsertDuel(
      [...duelKey],
      [
        ...(options.participantAHash ??
          hashLabel(`${Buffer.from(duelKey).toString("hex")}:a`)),
      ],
      [
        ...(options.participantBHash ??
          hashLabel(`${Buffer.from(duelKey).toString("hex")}:b`)),
      ],
      options.competitiveSnapshotVersion ?? 3,
      [
        ...(options.competitiveSnapshotDigest ??
          hashLabel(`${Buffer.from(duelKey).toString("hex")}:snapshot`)),
      ],
      toBn(options.betOpenTs),
      toBn(options.betCloseTs),
      toBn(options.duelStartTs ?? options.betCloseTs),
      options.metadataUri ?? "https://hyperia.gg/duels/test",
      options.status,
    )
    .accountsPartial({
      reporter: reporter.publicKey,
      oracleConfig,
      duelState,
      systemProgram: SystemProgram.programId,
    })
    .signers([reporter])
    .rpc();

  return duelState;
}

export async function cancelDuel(
  program: Program<FightOracle>,
  authority: Keypair,
  duelKey: readonly number[],
  metadataUri = "https://hyperia.gg/duels/cancelled",
): Promise<PublicKey> {
  const oracleConfig = deriveOracleConfigPda(program.programId);
  const duelState = deriveDuelStatePda(program.programId, duelKey);

  await program.methods
    .cancelDuel([...duelKey], metadataUri)
    .accountsPartial({
      authority: authority.publicKey,
      oracleConfig,
      duelState,
    })
    .signers([authority])
    .rpc();

  return duelState;
}

export async function proposeDuelResult(
  program: Program<FightOracle>,
  reporter: Keypair,
  duelKey: readonly number[],
  options: {
    winner: { a: Record<string, never> } | { b: Record<string, never> };
    duelEndTs: number;
    seed?: bigint | number;
    replayHash?: readonly number[];
    resultHash?: readonly number[];
    metadataUri?: string;
  },
): Promise<PublicKey> {
  const oracleConfig = deriveOracleConfigPda(program.programId);
  const duelState = deriveDuelStatePda(program.programId, duelKey);
  const replayHash = [
    ...(options.replayHash ??
      hashLabel(`${Buffer.from(duelKey).toString("hex")}:replay`)),
  ];
  const seed = options.seed ?? 42;
  const duelStateAccount = await program.account.duelState.fetch(duelState);
  const resultHash = [
    ...(options.resultHash ??
      buildCanonicalResultHash({
        duelKey,
        winner: options.winner,
        seed,
        replayHash,
        competitiveSnapshotVersion: bnLikeToNumber(
          duelStateAccount.competitiveSnapshotVersion,
        ),
        competitiveSnapshotDigest: duelStateAccount.competitiveSnapshotDigest,
      })),
  ];
  const proposalRecord = deriveProposalRecordPda(
    program.programId,
    duelKey,
    resultHash,
    replayHash,
  );

  await program.methods
    .proposeResult(
      [...duelKey],
      options.winner,
      toBn(seed),
      replayHash,
      resultHash,
      toBn(options.duelEndTs),
      options.metadataUri ?? "https://hyperia.gg/duels/proposal",
    )
    .accountsPartial({
      reporter: reporter.publicKey,
      oracleConfig,
      duelState,
      proposalRecord,
      systemProgram: SystemProgram.programId,
    })
    .signers([reporter])
    .rpc();

  return duelState;
}

export async function challengeDuelResult(
  program: Program<FightOracle>,
  challenger: Keypair,
  duelKey: readonly number[],
  metadataUri = "https://hyperia.gg/duels/challenged",
): Promise<PublicKey> {
  const oracleConfig = deriveOracleConfigPda(program.programId);
  const duelState = deriveDuelStatePda(program.programId, duelKey);
  const duelStateAccount = await program.account.duelState.fetch(duelState);
  const proposalRecord = deriveProposalRecordPda(
    program.programId,
    duelKey,
    duelStateAccount.pendingResultHash,
    duelStateAccount.pendingReplayHash,
  );

  await program.methods
    .challengeResult([...duelKey], metadataUri)
    .accountsPartial({
      challenger: challenger.publicKey,
      oracleConfig,
      duelState,
      proposalRecord,
    })
    .signers([challenger])
    .rpc();

  return duelState;
}

export async function reproposeDuelResult(
  program: Program<FightOracle>,
  reporter: Keypair,
  duelKey: readonly number[],
  options: {
    winner: { a: Record<string, never> } | { b: Record<string, never> };
    duelEndTs: number;
    seed?: bigint | number;
    replayHash: readonly number[];
    resultHash?: readonly number[];
    metadataUri?: string;
  },
): Promise<PublicKey> {
  const oracleConfig = deriveOracleConfigPda(program.programId);
  const duelState = deriveDuelStatePda(program.programId, duelKey);
  const replayHash = [...options.replayHash];
  const seed = options.seed ?? 42;
  const duelStateAccount = await program.account.duelState.fetch(duelState);
  const resultHash = [
    ...(options.resultHash ??
      buildCanonicalResultHash({
        duelKey,
        winner: options.winner,
        seed,
        replayHash,
        competitiveSnapshotVersion: bnLikeToNumber(
          duelStateAccount.competitiveSnapshotVersion,
        ),
        competitiveSnapshotDigest: duelStateAccount.competitiveSnapshotDigest,
      })),
  ];
  const proposalRecord = deriveProposalRecordPda(
    program.programId,
    duelKey,
    resultHash,
    replayHash,
  );

  await program.methods
    .reproposeResult(
      [...duelKey],
      options.winner,
      toBn(seed),
      replayHash,
      resultHash,
      toBn(options.duelEndTs),
      options.metadataUri ?? "https://hyperia.gg/duels/reproposal",
    )
    .accountsPartial({
      reporter: reporter.publicKey,
      oracleConfig,
      duelState,
      proposalRecord,
      systemProgram: SystemProgram.programId,
    })
    .signers([reporter])
    .rpc();

  return duelState;
}

export async function finalizeDuelResult(
  program: Program<FightOracle>,
  finalizer: Keypair,
  duelKey: readonly number[],
  metadataUri = "https://hyperia.gg/duels/final",
  options?: {
    skipDisputeWindowWait?: boolean;
  },
): Promise<PublicKey> {
  const oracleConfig = deriveOracleConfigPda(program.programId);
  const duelState = deriveDuelStatePda(program.programId, duelKey);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await program.methods
        .finalizeResult([...duelKey], metadataUri)
        .accountsPartial({
          finalizer: finalizer.publicKey,
          oracleConfig,
          duelState,
        })
        .signers([finalizer])
        .rpc();
      return duelState;
    } catch (error) {
      lastError = error;
      if (!hasProgramError(error, "DisputeWindowActive")) {
        // A concurrently running finalizer may win the account lock after our
        // transaction was submitted but before its error reaches the client.
        // Confirm canonical state for a bounded window before treating that
        // transport/account-lock race as a failed finalization.
        for (
          let resolutionCheck = 0;
          resolutionCheck < 10;
          resolutionCheck += 1
        ) {
          const duelStateAccount =
            await program.account.duelState.fetch(duelState);
          if (
            enumIs(
              (duelStateAccount as { status?: unknown }).status,
              "resolved",
            )
          ) {
            return duelState;
          }
          await sleep(500);
        }
      }
      if (hasProgramError(error, "NotProposed")) {
        const duelStateAccount =
          await program.account.duelState.fetch(duelState);
        if (
          enumIs((duelStateAccount as { status?: unknown }).status, "resolved")
        ) {
          return duelState;
        }
      }
      if (
        !hasProgramError(error, "DisputeWindowActive") ||
        options?.skipDisputeWindowWait
      ) {
        throw error;
      }
      const [oracleConfigAccount, duelStateAccount] = await Promise.all([
        program.account.oracleConfig.fetch(oracleConfig),
        program.account.duelState.fetch(duelState),
      ]);
      const finalizableAt =
        bnLikeToNumber(
          (duelStateAccount as { pendingProposedAt?: unknown })
            .pendingProposedAt,
        ) +
        bnLikeToNumber(
          (oracleConfigAccount as { disputeWindowSecs?: unknown })
            .disputeWindowSecs,
        );
      const now = await currentChainUnixTimestamp(program.provider.connection);
      const remainingMs = Math.max(500, (finalizableAt - now + 1) * 1_000);
      await sleep(Math.min(remainingMs, 5_000));
    }
  }

  throw lastError;
}

export async function initializeCanonicalMarket(
  program: Program<DuelMarket>,
  operator: Keypair,
  duelState: PublicKey,
  duelKey: readonly number[],
  config = deriveMarketConfigPda(program.programId),
  marketKind = DUEL_WINNER_MARKET_KIND,
): Promise<{ marketState: PublicKey; vault: PublicKey }> {
  const marketState = deriveMarketStatePda(
    program.programId,
    duelState,
    marketKind,
  );
  const vault = deriveClobVaultPda(program.programId, marketState);

  await program.methods
    .initializeMarket([...duelKey], marketKind)
    .accountsPartial({
      operator: operator.publicKey,
      config,
      duelState,
      marketState,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([operator])
    .rpc();

  return { marketState, vault };
}

export async function ensureVaultRentExempt(
  program: Program<DuelMarket>,
  funder: Keypair,
  vault: PublicKey,
): Promise<void> {
  const minimumBalance =
    await program.provider.connection.getMinimumBalanceForRentExemption(0);
  const currentBalance = await program.provider.connection.getBalance(vault);
  if (currentBalance >= minimumBalance) {
    return;
  }

  await (program.provider as anchor.AnchorProvider).sendAndConfirm(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: vault,
        lamports: minimumBalance - currentBalance,
      }),
    ),
    [funder],
  );
}

export async function syncMarketFromDuel(
  program: Program<DuelMarket>,
  marketState: PublicKey,
  duelState: PublicKey,
): Promise<void> {
  await program.methods
    .syncMarketFromDuel()
    .accountsPartial({
      marketState,
      duelState,
    })
    .rpc();
}

export async function placeClobOrder(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    config: PublicKey;
    treasury: PublicKey;
    marketMaker: PublicKey;
    vault: PublicKey;
    user: Keypair;
    orderId: bigint | number;
    side: number;
    price: number;
    amount: bigint | number;
    orderBehavior?: number;
    remainingAccounts?: AccountMeta[];
  },
): Promise<{
  userBalance: PublicKey;
  order: PublicKey;
  restingLevel: PublicKey;
  signature: string;
}> {
  const userBalance = deriveUserBalancePda(
    program.programId,
    args.marketState,
    args.user.publicKey,
  );
  const order = deriveOrderPda(
    program.programId,
    args.marketState,
    args.orderId,
  );
  const restingLevel = derivePriceLevelPda(
    program.programId,
    args.marketState,
    args.side,
    args.price,
  );

  let builder = program.methods
    .placeOrder(
      toBn(args.orderId),
      args.side,
      args.price,
      toBn(args.amount),
      args.orderBehavior ?? ORDER_BEHAVIOR_GTC,
    )
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      userBalance,
      newOrder: order,
      restingLevel,
      config: args.config,
      treasury: args.treasury,
      marketMaker: args.marketMaker,
      vault: args.vault,
      user: args.user.publicKey,
      systemProgram: SystemProgram.programId,
    });

  if (args.remainingAccounts && args.remainingAccounts.length > 0) {
    builder = builder.remainingAccounts(args.remainingAccounts);
  }

  const instruction = await builder.instruction();
  const uniqueAccountCount = new Set(
    instruction.keys.map((accountMeta) => accountMeta.pubkey.toBase58()),
  ).size;
  const signature =
    uniqueAccountCount > 32 || instruction.keys.length > 64
      ? await sendVersionedTransactionWithLookupTable(
          program.provider as anchor.AnchorProvider,
          [instruction],
          [args.user],
        )
      : await (program.provider as anchor.AnchorProvider).sendAndConfirm(
          new anchor.web3.Transaction().add(instruction),
          [args.user],
        );

  return { userBalance, order, restingLevel, signature };
}

export async function continueClobOrder(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    config: PublicKey;
    treasury: PublicKey;
    marketMaker: PublicKey;
    vault: PublicKey;
    user: Keypair;
    orderId: bigint | number;
    side: number;
    price: number;
    remainingAccounts?: AccountMeta[];
  },
): Promise<{ order: PublicKey; restingLevel: PublicKey; signature: string }> {
  const userBalance = deriveUserBalancePda(
    program.programId,
    args.marketState,
    args.user.publicKey,
  );
  const order = deriveOrderPda(
    program.programId,
    args.marketState,
    args.orderId,
  );
  const restingLevel = derivePriceLevelPda(
    program.programId,
    args.marketState,
    args.side,
    args.price,
  );

  let builder = program.methods
    .continueOrder(toBn(args.orderId))
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      userBalance,
      order,
      restingLevel,
      config: args.config,
      treasury: args.treasury,
      marketMaker: args.marketMaker,
      vault: args.vault,
      user: args.user.publicKey,
      systemProgram: SystemProgram.programId,
    });

  if (args.remainingAccounts && args.remainingAccounts.length > 0) {
    builder = builder.remainingAccounts(args.remainingAccounts);
  }

  const instruction = await builder.instruction();
  const uniqueAccountCount = new Set(
    instruction.keys.map((accountMeta) => accountMeta.pubkey.toBase58()),
  ).size;
  const signature =
    uniqueAccountCount > 32 || instruction.keys.length > 64
      ? await sendVersionedTransactionWithLookupTable(
          program.provider as anchor.AnchorProvider,
          [instruction],
          [args.user],
        )
      : await (program.provider as anchor.AnchorProvider).sendAndConfirm(
          new anchor.web3.Transaction().add(instruction),
          [args.user],
        );
  return { order, restingLevel, signature };
}

export async function cancelClobOrder(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    vault: PublicKey;
    user: Keypair;
    orderId: bigint | number;
    side: number;
    price: number;
    remainingAccounts?: AccountMeta[];
  },
): Promise<{ order: PublicKey; priceLevel: PublicKey; signature: string }> {
  const order = deriveOrderPda(
    program.programId,
    args.marketState,
    args.orderId,
  );
  const priceLevel = derivePriceLevelPda(
    program.programId,
    args.marketState,
    args.side,
    args.price,
  );

  let builder = program.methods
    .cancelOrder(toBn(args.orderId), args.side, args.price)
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      order,
      priceLevel,
      vault: args.vault,
      user: args.user.publicKey,
      systemProgram: SystemProgram.programId,
    });

  if (args.remainingAccounts && args.remainingAccounts.length > 0) {
    builder = builder.remainingAccounts(args.remainingAccounts);
  }

  const signature = await builder.signers([args.user]).rpc();

  return { order, priceLevel, signature };
}

export async function closeFilledClobOrder(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    user: Keypair;
    orderId: bigint | number;
  },
): Promise<{ order: PublicKey; signature: string }> {
  const order = deriveOrderPda(
    program.programId,
    args.marketState,
    args.orderId,
  );

  const signature = await program.methods
    .closeFilledOrder(toBn(args.orderId))
    .accountsPartial({
      marketState: args.marketState,
      order,
      user: args.user.publicKey,
    })
    .signers([args.user])
    .rpc();

  return { order, signature };
}

export async function closeEmptyClobUserBalance(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    user: Keypair;
  },
): Promise<{ userBalance: PublicKey; signature: string }> {
  const userBalance = deriveUserBalancePda(
    program.programId,
    args.marketState,
    args.user.publicKey,
  );

  const signature = await program.methods
    .closeEmptyUserBalance()
    .accountsPartial({
      marketState: args.marketState,
      userBalance,
      user: args.user.publicKey,
    })
    .signers([args.user])
    .rpc();

  return { userBalance, signature };
}

export async function closeEmptyClobPriceLevel(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    side: number;
    price: number;
    rentRecipient: PublicKey;
    closer: Keypair;
  },
): Promise<{ priceLevel: PublicKey; signature: string }> {
  const priceLevel = derivePriceLevelPda(
    program.programId,
    args.marketState,
    args.side,
    args.price,
  );

  const signature = await program.methods
    .closeEmptyPriceLevel(args.side, args.price)
    .accountsPartial({
      marketState: args.marketState,
      priceLevel,
      rentRecipient: args.rentRecipient,
      closer: args.closer.publicKey,
    })
    .signers([args.closer])
    .rpc();

  return { priceLevel, signature };
}

export async function reclaimClobOrder(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    vault: PublicKey;
    user: Keypair;
    orderId: bigint | number;
    side: number;
    price: number;
    remainingAccounts?: AccountMeta[];
  },
): Promise<{ order: PublicKey; priceLevel: PublicKey; signature: string }> {
  const order = deriveOrderPda(
    program.programId,
    args.marketState,
    args.orderId,
  );
  const priceLevel = derivePriceLevelPda(
    program.programId,
    args.marketState,
    args.side,
    args.price,
  );

  let builder = (program.methods as any)
    .reclaimRestingOrder(toBn(args.orderId), args.side, args.price)
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      order,
      priceLevel,
      vault: args.vault,
      user: args.user.publicKey,
      systemProgram: SystemProgram.programId,
    });

  if (args.remainingAccounts && args.remainingAccounts.length > 0) {
    builder = builder.remainingAccounts(args.remainingAccounts);
  }

  const signature = await builder.signers([args.user]).rpc();

  return { order, priceLevel, signature };
}

export async function claimClobWinnings(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    config: PublicKey;
    marketMaker: PublicKey;
    vault: PublicKey;
    user: Keypair;
  },
): Promise<PublicKey> {
  const userBalance = deriveUserBalancePda(
    program.programId,
    args.marketState,
    args.user.publicKey,
  );

  await program.methods
    .claim()
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      userBalance,
      config: args.config,
      marketMaker: args.marketMaker,
      vault: args.vault,
      user: args.user.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([args.user])
    .rpc();

  return userBalance;
}

export async function claimClobWinningsWithSignature(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    config: PublicKey;
    marketMaker: PublicKey;
    vault: PublicKey;
    user: Keypair;
  },
): Promise<{ userBalance: PublicKey; signature: string }> {
  const userBalance = deriveUserBalancePda(
    program.programId,
    args.marketState,
    args.user.publicKey,
  );

  const signature = await program.methods
    .claim()
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      userBalance,
      config: args.config,
      marketMaker: args.marketMaker,
      vault: args.vault,
      user: args.user.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([args.user])
    .rpc();

  return { userBalance, signature };
}

export async function closeLosingClobBalance(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    user: Keypair;
  },
): Promise<PublicKey> {
  const userBalance = deriveUserBalancePda(
    program.programId,
    args.marketState,
    args.user.publicKey,
  );

  await program.methods
    .closeLosingBalance()
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      userBalance,
      user: args.user.publicKey,
    })
    .signers([args.user])
    .rpc();

  return userBalance;
}

export async function withdrawResolvedClobTradeFees(
  program: Program<DuelMarket>,
  args: {
    marketState: PublicKey;
    duelState: PublicKey;
    treasury: PublicKey;
    marketMaker: PublicKey;
    vault: PublicKey;
    submitter: Keypair;
  },
): Promise<string> {
  return program.methods
    .withdrawResolvedTradeFees()
    .accountsPartial({
      marketState: args.marketState,
      duelState: args.duelState,
      treasury: args.treasury,
      marketMaker: args.marketMaker,
      vault: args.vault,
      submitter: args.submitter.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([args.submitter])
    .rpc();
}

export async function createOpenMarketFixture(
  fightProgram: Program<FightOracle>,
  clobProgram: Program<DuelMarket>,
  authority: Keypair,
  options?: {
    duelKey?: readonly number[];
    marketOperator?: PublicKey;
    treasury?: PublicKey;
    marketMaker?: PublicKey;
    duelStatus?:
      | { scheduled: Record<string, never> }
      | { bettingOpen: Record<string, never> }
      | { locked: Record<string, never> };
    betOpenTs?: number;
    betCloseTs?: number;
    duelStartTs?: number;
    participantAHash?: readonly number[];
    participantBHash?: readonly number[];
    competitiveSnapshotVersion?: number;
    competitiveSnapshotDigest?: readonly number[];
    metadataUri?: string;
    tradeTreasuryFeeBps?: number;
    tradeMarketMakerFeeBps?: number;
    winningsMarketMakerFeeBps?: number;
  },
): Promise<{
  config: PublicKey;
  duelKey: number[];
  duelState: PublicKey;
  marketState: PublicKey;
  vault: PublicKey;
  treasury: PublicKey;
  marketMaker: PublicKey;
}> {
  const duelKey = [...(options?.duelKey ?? uniqueDuelKey("clob-market"))];
  const now = Math.floor(Date.now() / 1000);
  const treasury = options?.treasury ?? authority.publicKey;
  const marketMaker = options?.marketMaker ?? authority.publicKey;

  await ensureOracleReady(fightProgram, authority, authority.publicKey);
  const config = await ensureClobConfig(clobProgram, authority, {
    marketOperator: options?.marketOperator ?? authority.publicKey,
    treasury,
    marketMaker,
    tradeTreasuryFeeBps: options?.tradeTreasuryFeeBps,
    tradeMarketMakerFeeBps: options?.tradeMarketMakerFeeBps,
    winningsMarketMakerFeeBps: options?.winningsMarketMakerFeeBps,
  });
  const duelState = await upsertDuel(fightProgram, authority, duelKey, {
    status: options?.duelStatus ?? duelStatusBettingOpen(),
    betOpenTs: options?.betOpenTs ?? now - 30,
    betCloseTs: options?.betCloseTs ?? now + 3600,
    duelStartTs:
      options?.duelStartTs ?? (options?.betCloseTs ?? now + 3600) + 60,
    participantAHash: options?.participantAHash,
    participantBHash: options?.participantBHash,
    competitiveSnapshotVersion: options?.competitiveSnapshotVersion,
    competitiveSnapshotDigest: options?.competitiveSnapshotDigest,
    metadataUri: options?.metadataUri,
  });
  const { marketState, vault } = await initializeCanonicalMarket(
    clobProgram,
    authority,
    duelState,
    duelKey,
    config,
  );
  await ensureVaultRentExempt(clobProgram, authority, vault);

  return {
    config,
    duelKey,
    duelState,
    marketState,
    vault,
    treasury,
    marketMaker,
  };
}
