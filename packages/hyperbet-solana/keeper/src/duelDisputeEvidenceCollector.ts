import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BorshAccountsCoder,
  BorshInstructionCoder,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

import { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../../account-schema";
import { canonicalEvidenceJson } from "./bettingFeedEvidence";
import { exactBytes32Hex } from "./exactBytes32";
import {
  buildDuelDisputeEvidence,
  type DuelDisputeBuildComponent,
  type DuelDisputeBuildEvidence,
  type DuelDisputeChainAction,
  type DuelDisputeChainTransaction,
  type DuelDisputeEvidencePackage,
  type DuelDisputeMarketState,
  type DuelDisputeOracleState,
  verifyDuelDisputeEvidencePackage,
} from "./duelDisputeEvidence";
import duelMarketIdl from "./idl/duel_market.json";
import fightOracleIdl from "./idl/fight_oracle.json";
import {
  duelKeyHexToBytes,
  findDuelStatePda,
  findMarketPda,
} from "./launchCommon";
import {
  exactPrimarySolanaTransactionSignature,
  exactSolanaTransactionSignatures,
} from "./solanaBetAccounting";
import {
  exactSolanaPublicKeyAddress,
  exactTransactionSignerAddresses,
} from "./solanaInstructionAccounts";
import { exactTransactionInstructionSequence } from "./solanaInnerInstructions";
import { toU64Like } from "./solanaSafeInteger";
import {
  collectFinalizedSignatureBackfill,
  hasExactSuccessfulFinalizedTransactionMeta,
  MAX_FINALIZED_SIGNATURE_HISTORY_ENTRIES,
  MAX_FINALIZED_SIGNATURE_PAGES,
  MAX_FINALIZED_SIGNATURE_PAGE_SIZE,
  MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE,
  requireExactFinalizedBlockTimeParity,
  requireExactFinalizedTransactionBatch,
} from "./solanaLifecycleIndexer";
import { digestFinalizedSolanaTransaction } from "./solanaTransactionDigest";
import { TerminalLedger } from "./terminalLedger";

const MAX_DISPUTE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_REVISION_HEX = /^[0-9a-f]{40,64}$/;

type FinalizedDisputeSignatureReference = {
  slot: number;
  blockTime: number | null;
  succeeded: boolean;
};

export const DEFAULT_HYPERIA_DISPUTE_SOURCE_FILES = [
  "packages/server/src/duel/DuelCombatAI.ts",
  "packages/server/src/routes/streaming-betting-feed.ts",
  "packages/server/src/routes/streaming-betting-routes.ts",
  "packages/server/src/systems/StreamingDuelScheduler/competitive-snapshot.ts",
  "packages/server/src/systems/StreamingDuelScheduler/index.ts",
  "packages/server/src/systems/StreamingDuelScheduler/preparation.ts",
  "packages/server/src/systems/StreamingDuelScheduler/types.ts",
] as const;

export const DEFAULT_HYPERBET_DISPUTE_SOURCE_FILES = [
  "packages/hyperbet-solana/keeper/src/bettingFeedEvidence.ts",
  "packages/hyperbet-solana/keeper/src/duelBot.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidence.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceCollector.ts",
  "packages/hyperbet-solana/keeper/src/game-client.ts",
  "packages/hyperbet-solana/keeper/src/resultHash.ts",
  "packages/hyperbet-solana/keeper/src/terminalLedger.ts",
] as const;

type UnknownRecord = Record<string, unknown>;

type ParsedInstructionEvidence = {
  programId: string;
  instructionName: string;
  action: DuelDisputeChainAction | null;
  marketSync: boolean;
};

type TransactionDraft = Omit<DuelDisputeChainTransaction, "actions"> & {
  actions: DuelDisputeChainAction[];
  marketSync: boolean;
};

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`duel dispute collector ${label} is invalid`);
  }
  return value as UnknownRecord;
}

function readField(
  value: UnknownRecord,
  snakeName: string,
  camelName: string,
): unknown {
  return value[snakeName] ?? value[camelName];
}

function enumVariant(value: unknown, label: string): string {
  const record = asRecord(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1) {
    throw new Error(`duel dispute collector ${label} is invalid`);
  }
  return keys[0]!;
}

function integerString(value: unknown, label: string): string {
  const normalized = toU64Like(value);
  if (normalized === null) {
    throw new Error(`duel dispute collector ${label} is invalid`);
  }
  return normalized.toString(10);
}

function safeInteger(value: unknown, label: string): number {
  const normalized = integerString(value, label);
  const result = Number(normalized);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`duel dispute collector ${label} exceeds safe range`);
  }
  return result;
}

function bytesHex(value: unknown, label: string): string {
  const result = exactBytes32Hex(value);
  if (!result) throw new Error(`duel dispute collector ${label} is invalid`);
  return result;
}

function publicKeyString(value: unknown, label: string): string {
  const result = exactSolanaPublicKeyAddress(value);
  if (!result) throw new Error(`duel dispute collector ${label} is invalid`);
  return result;
}

function winnerSide(value: unknown): "A" | "B" | null {
  const variant = enumVariant(value, "winner").toUpperCase();
  if (variant === "A" || variant === "B") return variant;
  if (variant === "NONE") return null;
  throw new Error("duel dispute collector winner is invalid");
}

function bitmapHex(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new Error(`duel dispute collector ${label} is invalid`);
  }
  return value
    .map((word) => {
      const normalized = BigInt(integerString(word, label)).toString(16);
      if (normalized.length > 16) {
        throw new Error(`duel dispute collector ${label} word is invalid`);
      }
      return normalized.padStart(16, "0");
    })
    .join("");
}

export function normalizeOracleAccountEvidence(input: {
  decoded: unknown;
  programId: PublicKey;
  duelStatePda: PublicKey;
  expectedDuelKey: string;
}): DuelDisputeOracleState {
  const decoded = asRecord(input.decoded, "oracle account");
  if (
    bytesHex(readField(decoded, "duel_key", "duelKey"), "oracle duel key") !==
    input.expectedDuelKey
  ) {
    throw new Error("duel dispute collector oracle duel key drifted");
  }
  const status = enumVariant(
    readField(decoded, "status", "status"),
    "oracle status",
  ).toUpperCase();
  if (status !== "RESOLVED" && status !== "CANCELLED") {
    throw new Error("duel dispute collector oracle is not terminal");
  }
  const metadataUri = readField(decoded, "metadata_uri", "metadataUri");
  if (typeof metadataUri !== "string") {
    throw new Error("duel dispute collector oracle metadata is invalid");
  }
  const accountSchemaVersion = safeInteger(
    readField(decoded, "account_schema_version", "accountSchemaVersion"),
    "account schema version",
  );
  if (accountSchemaVersion !== FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION) {
    throw new Error(
      `duel dispute collector oracle account schema v${accountSchemaVersion} is unsupported`,
    );
  }
  return {
    programId: input.programId.toBase58(),
    duelStatePda: input.duelStatePda.toBase58(),
    accountSchemaVersion,
    status,
    winnerSide: winnerSide(readField(decoded, "winner", "winner")),
    participantAHash: bytesHex(
      readField(decoded, "participant_a_hash", "participantAHash"),
      "participant A hash",
    ),
    participantBHash: bytesHex(
      readField(decoded, "participant_b_hash", "participantBHash"),
      "participant B hash",
    ),
    competitiveSnapshotVersion: safeInteger(
      readField(
        decoded,
        "competitive_snapshot_version",
        "competitiveSnapshotVersion",
      ),
      "competitive snapshot version",
    ),
    competitiveSnapshotDigest: bytesHex(
      readField(
        decoded,
        "competitive_snapshot_digest",
        "competitiveSnapshotDigest",
      ),
      "competitive snapshot digest",
    ),
    betOpenTs: safeInteger(
      readField(decoded, "bet_open_ts", "betOpenTs"),
      "bet-open timestamp",
    ),
    betCloseTs: safeInteger(
      readField(decoded, "bet_close_ts", "betCloseTs"),
      "bet-close timestamp",
    ),
    duelStartTs: safeInteger(
      readField(decoded, "duel_start_ts", "duelStartTs"),
      "duel-start timestamp",
    ),
    duelEndTs: safeInteger(
      readField(decoded, "duel_end_ts", "duelEndTs"),
      "duel-end timestamp",
    ),
    seed: integerString(readField(decoded, "seed", "seed"), "oracle seed"),
    replayHash: bytesHex(
      readField(decoded, "replay_hash", "replayHash"),
      "oracle replay hash",
    ),
    resultHash: bytesHex(
      readField(decoded, "result_hash", "resultHash"),
      "oracle result hash",
    ),
    metadataUri,
  };
}

export function normalizeMarketAccountEvidence(input: {
  decoded: unknown;
  programId: PublicKey;
  marketStatePda: PublicKey;
  expectedDuelStatePda: PublicKey;
  expectedDuelKey: string;
}): DuelDisputeMarketState {
  const decoded = asRecord(input.decoded, "market account");
  const duelStatePda = publicKeyString(
    readField(decoded, "duel_state", "duelState"),
    "market duel-state PDA",
  );
  if (
    duelStatePda !== input.expectedDuelStatePda.toBase58() ||
    bytesHex(readField(decoded, "duel_key", "duelKey"), "market duel key") !==
      input.expectedDuelKey
  ) {
    throw new Error("duel dispute collector market identity drifted");
  }
  const status = enumVariant(
    readField(decoded, "status", "status"),
    "market status",
  ).toUpperCase();
  if (status !== "RESOLVED" && status !== "CANCELLED") {
    throw new Error("duel dispute collector market is not terminal");
  }
  return {
    programId: input.programId.toBase58(),
    marketStatePda: input.marketStatePda.toBase58(),
    duelStatePda,
    status,
    winnerSide: winnerSide(readField(decoded, "winner", "winner")),
    marketKind: safeInteger(
      readField(decoded, "market_kind", "marketKind"),
      "market kind",
    ),
    tradeTreasuryFeeBpsSnapshot: safeInteger(
      readField(
        decoded,
        "trade_treasury_fee_bps_snapshot",
        "tradeTreasuryFeeBpsSnapshot",
      ),
      "treasury fee snapshot",
    ),
    tradeMarketMakerFeeBpsSnapshot: safeInteger(
      readField(
        decoded,
        "trade_market_maker_fee_bps_snapshot",
        "tradeMarketMakerFeeBpsSnapshot",
      ),
      "market-maker fee snapshot",
    ),
    winningsMarketMakerFeeBpsSnapshot: safeInteger(
      readField(
        decoded,
        "winnings_market_maker_fee_bps_snapshot",
        "winningsMarketMakerFeeBpsSnapshot",
      ),
      "winnings fee snapshot",
    ),
    nextOrderId: integerString(
      readField(decoded, "next_order_id", "nextOrderId"),
      "next order ID",
    ),
    bestBid: safeInteger(readField(decoded, "best_bid", "bestBid"), "best bid"),
    bestAsk: safeInteger(readField(decoded, "best_ask", "bestAsk"), "best ask"),
    bidBitmapHex: bitmapHex(
      readField(decoded, "bid_bitmap", "bidBitmap"),
      "bid bitmap",
    ),
    askBitmapHex: bitmapHex(
      readField(decoded, "ask_bitmap", "askBitmap"),
      "ask bitmap",
    ),
    accruedTradeTreasuryFeeLamports: integerString(
      readField(
        decoded,
        "accrued_trade_treasury_fee_lamports",
        "accruedTradeTreasuryFeeLamports",
      ),
      "treasury fee accrual",
    ),
    accruedTradeMarketMakerFeeLamports: integerString(
      readField(
        decoded,
        "accrued_trade_market_maker_fee_lamports",
        "accruedTradeMarketMakerFeeLamports",
      ),
      "market-maker fee accrual",
    ),
    authority: publicKeyString(
      readField(decoded, "authority", "authority"),
      "market authority",
    ),
    treasury: publicKeyString(
      readField(decoded, "treasury", "treasury"),
      "market treasury",
    ),
    marketMaker: publicKeyString(
      readField(decoded, "market_maker", "marketMaker"),
      "market maker",
    ),
  };
}

function actionForFightInstruction(
  instructionName: string,
  data: unknown,
): DuelDisputeChainAction | null {
  if (instructionName === "upsert_duel") {
    const status = enumVariant(
      asRecord(data, "upsert instruction").status,
      "upsert status",
    ).toUpperCase();
    if (status === "BETTINGOPEN") return "oracle_betting_open";
    if (status === "LOCKED") return "oracle_locked";
    return null;
  }
  if (
    instructionName === "propose_result" ||
    instructionName === "repropose_result"
  ) {
    return "oracle_result_proposed";
  }
  if (instructionName === "finalize_result") {
    return "oracle_result_finalized";
  }
  if (instructionName === "cancel_duel") return "oracle_cancelled";
  return null;
}

export function digestParsedTransaction(
  transaction: ParsedTransactionWithMeta,
): string {
  return digestFinalizedSolanaTransaction(transaction);
}

function instructionProgramId(instruction: unknown): string | null {
  if (!instruction || typeof instruction !== "object") return null;
  const candidate = (instruction as { programId?: unknown }).programId;
  try {
    return candidate ? publicKeyString(candidate, "instruction program") : null;
  } catch {
    return null;
  }
}

function instructionData(instruction: unknown): string | null {
  if (!instruction || typeof instruction !== "object") return null;
  const candidate = (instruction as { data?: unknown }).data;
  return typeof candidate === "string" ? candidate : null;
}

export function decodeDisputeInstruction(input: {
  instruction: unknown;
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
  fightInstructionCoder?: BorshInstructionCoder;
  marketInstructionCoder?: BorshInstructionCoder;
  finalMarketStatus: "RESOLVED" | "CANCELLED";
}): ParsedInstructionEvidence | null {
  const programId = instructionProgramId(input.instruction);
  const data = instructionData(input.instruction);
  if (!programId || !data) return null;
  const fightProgramId = input.fightProgramId.toBase58();
  const marketProgramId = input.marketProgramId.toBase58();
  if (programId === fightProgramId) {
    const coder =
      input.fightInstructionCoder ??
      new BorshInstructionCoder(fightOracleIdl as Idl);
    const decoded = coder.decode(data, "base58");
    if (!decoded) {
      throw new Error(
        "duel dispute collector found an unknown oracle instruction",
      );
    }
    return {
      programId,
      instructionName: `fight_oracle:${decoded.name}`,
      action: actionForFightInstruction(decoded.name, decoded.data),
      marketSync: false,
    };
  }
  if (programId === marketProgramId) {
    const coder =
      input.marketInstructionCoder ??
      new BorshInstructionCoder(duelMarketIdl as Idl);
    const decoded = coder.decode(data, "base58");
    if (!decoded) {
      throw new Error(
        "duel dispute collector found an unknown market instruction",
      );
    }
    let action: DuelDisputeChainAction | null = null;
    if (decoded.name === "initialize_market") action = "market_initialized";
    else if (decoded.name === "claim") {
      action =
        input.finalMarketStatus === "RESOLVED"
          ? "market_terminal_claim"
          : "market_terminal_refund";
    } else if (decoded.name === "withdraw_resolved_trade_fees") {
      action = "market_trade_fees_withdrawn";
    }
    return {
      programId,
      instructionName: `duel_market:${decoded.name}`,
      action,
      marketSync: decoded.name === "sync_market_from_duel",
    };
  }
  return null;
}

function transactionInstructions(
  transaction: ParsedTransactionWithMeta,
): unknown[] {
  const sequence = exactTransactionInstructionSequence(
    transaction.transaction.message.instructions,
    transaction.meta?.innerInstructions ?? null,
  );
  if (!sequence) {
    throw new Error("duel dispute collector instruction graph is invalid");
  }
  return sequence;
}

export function buildDisputeTransactionEvidence(input: {
  transactions: ParsedTransactionWithMeta[];
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
  finalMarketStatus: "RESOLVED" | "CANCELLED";
}): DuelDisputeChainTransaction[] {
  const fightInstructionCoder = new BorshInstructionCoder(
    fightOracleIdl as Idl,
  );
  const marketInstructionCoder = new BorshInstructionCoder(
    duelMarketIdl as Idl,
  );
  const drafts: TransactionDraft[] = [];
  for (const transaction of input.transactions) {
    if (!hasExactSuccessfulFinalizedTransactionMeta(transaction.meta)) {
      continue;
    }
    const transactionSignatures = exactSolanaTransactionSignatures(
      transaction.transaction.signatures,
    );
    if (
      !transactionSignatures ||
      !exactTransactionSignerAddresses(
        transaction.transaction.message.accountKeys,
        transactionSignatures.length,
      )
    ) {
      throw new Error("duel dispute collector signer authority is invalid");
    }
    const decoded = transactionInstructions(transaction)
      .map((instruction) =>
        decodeDisputeInstruction({
          instruction,
          fightProgramId: input.fightProgramId,
          marketProgramId: input.marketProgramId,
          fightInstructionCoder,
          marketInstructionCoder,
          finalMarketStatus: input.finalMarketStatus,
        }),
      )
      .filter((item): item is ParsedInstructionEvidence => item !== null);
    if (decoded.length === 0) continue;
    const signature = transactionSignatures[0]!;
    drafts.push({
      signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime ?? null,
      finalized: true,
      succeeded: true,
      transactionDigest: digestParsedTransaction(transaction),
      programIds: [...new Set(decoded.map(({ programId }) => programId))],
      instructionNames: [
        ...new Set(decoded.map(({ instructionName }) => instructionName)),
      ],
      actions: [
        ...new Set(
          decoded
            .map(({ action }) => action)
            .filter(
              (action): action is DuelDisputeChainAction => action !== null,
            ),
        ),
      ],
      marketSync: decoded.some(({ marketSync }) => marketSync),
    });
  }
  const latestMarketSync = drafts
    .filter(({ marketSync }) => marketSync)
    .sort(
      (left, right) =>
        right.slot - left.slot || (left.signature < right.signature ? 1 : -1),
    )[0];
  if (latestMarketSync) {
    latestMarketSync.actions.push(
      input.finalMarketStatus === "RESOLVED"
        ? "market_synced_resolved"
        : "market_synced_cancelled",
    );
  }
  return drafts
    .filter(({ actions }) => actions.length > 0)
    .map(({ marketSync: _marketSync, ...transaction }) => transaction);
}

async function collectSignatureReferences(
  connection: Connection,
  address: PublicKey,
): Promise<Map<string, FinalizedDisputeSignatureReference>> {
  const history = await collectFinalizedSignatureBackfill({
    fetchPage: async ({ before, limit }) =>
      connection.getSignaturesForAddress(
        address,
        { before, limit },
        "finalized",
      ),
    checkpointSignature: null,
    checkpointSlot: null,
    startSlot: 0,
    minimumAvailableSlot: 0,
    pageSize: MAX_FINALIZED_SIGNATURE_PAGE_SIZE,
    maxPages: MAX_FINALIZED_SIGNATURE_PAGES,
  });
  if (history.length > MAX_FINALIZED_SIGNATURE_HISTORY_ENTRIES) {
    throw new Error(
      "duel dispute collector signature history exceeds safety bound",
    );
  }
  const references = new Map<string, FinalizedDisputeSignatureReference>();
  for (const entry of history) {
    references.set(entry.signature, {
      slot: entry.slot,
      blockTime: entry.blockTime,
      succeeded: entry.succeeded,
    });
  }
  return references;
}

async function fetchFinalizedTransactions(input: {
  connection: Connection;
  references: Map<string, FinalizedDisputeSignatureReference>;
}): Promise<ParsedTransactionWithMeta[]> {
  const signatures = [...input.references.keys()];
  const transactions: ParsedTransactionWithMeta[] = [];
  for (
    let offset = 0;
    offset < signatures.length;
    offset += MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE
  ) {
    const batch = signatures.slice(
      offset,
      offset + MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE,
    );
    const parsed =
      requireExactFinalizedTransactionBatch<ParsedTransactionWithMeta | null>({
        requestedSignatures: batch,
        transactions: await input.connection.getParsedTransactions(batch, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        }),
      });
    for (let index = 0; index < batch.length; index += 1) {
      const signature = batch[index]!;
      const transaction = parsed[index];
      const reference = input.references.get(signature)!;
      if (
        !transaction ||
        !reference.succeeded ||
        !hasExactSuccessfulFinalizedTransactionMeta(transaction.meta) ||
        transaction.slot !== reference.slot ||
        exactPrimarySolanaTransactionSignature(
          transaction.transaction.signatures,
        ) !== signature
      ) {
        throw new Error(
          `duel dispute collector finalized transaction drifted for ${signature}`,
        );
      }
      try {
        requireExactFinalizedBlockTimeParity({
          referenceBlockTime: reference.blockTime,
          transactionBlockTime: transaction.blockTime,
        });
      } catch (error) {
        throw new Error(
          `duel dispute collector finalized transaction drifted for ${signature}`,
          { cause: error },
        );
      }
      transactions.push(transaction);
    }
  }
  return transactions;
}

export async function collectDuelChainEvidence(input: {
  connection: Connection;
  duelStatePda: PublicKey;
  marketStatePda: PublicKey;
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
  finalMarketStatus: "RESOLVED" | "CANCELLED";
}): Promise<DuelDisputeChainTransaction[]> {
  const [duelReferences, marketReferences] = await Promise.all([
    collectSignatureReferences(input.connection, input.duelStatePda),
    collectSignatureReferences(input.connection, input.marketStatePda),
  ]);
  const references = new Map(duelReferences);
  for (const [signature, reference] of marketReferences) {
    const previous = references.get(signature);
    if (
      previous &&
      (previous.slot !== reference.slot ||
        previous.blockTime !== reference.blockTime ||
        previous.succeeded !== reference.succeeded)
    ) {
      throw new Error("duel dispute collector cross-account signature drifted");
    }
    references.set(signature, reference);
  }
  const successfulReferences = new Map(
    [...references].filter(([, reference]) => reference.succeeded),
  );
  if (successfulReferences.size === 0) {
    throw new Error(
      "duel dispute collector found no chain transaction history",
    );
  }
  return buildDisputeTransactionEvidence({
    transactions: await fetchFinalizedTransactions({
      connection: input.connection,
      references: successfulReferences,
    }),
    fightProgramId: input.fightProgramId,
    marketProgramId: input.marketProgramId,
    finalMarketStatus: input.finalMarketStatus,
  });
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function collectBuildComponent(input: {
  root: string;
  files: readonly string[];
  sourceRevision?: string;
  workingTreeDirty?: boolean;
}): DuelDisputeBuildComponent {
  const root = path.resolve(input.root);
  const hasExplicitRevision = input.sourceRevision !== undefined;
  const hasExplicitDirtyState = input.workingTreeDirty !== undefined;
  if (hasExplicitRevision !== hasExplicitDirtyState) {
    throw new Error(
      "duel dispute collector source revision and dirty state must be supplied together",
    );
  }
  const sourceRevision = hasExplicitRevision
    ? String(input.sourceRevision).trim().toLowerCase()
    : git(root, ["rev-parse", "HEAD"]);
  if (!GIT_REVISION_HEX.test(sourceRevision)) {
    throw new Error("duel dispute collector source revision is invalid");
  }
  const workingTreeDirty = hasExplicitDirtyState
    ? input.workingTreeDirty === true
    : git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length >
      0;
  const files = input.files.map((relativePath) => {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error("duel dispute collector source path is unsafe");
    }
    const absolutePath = path.resolve(root, relativePath);
    if (!fs.statSync(absolutePath).isFile()) {
      throw new Error(
        `duel dispute collector source file is missing: ${relativePath}`,
      );
    }
    return { path: relativePath, sha256: sha256File(absolutePath) };
  });
  return { sourceRevision, workingTreeDirty, files };
}

export function collectDuelBuildEvidence(input: {
  hyperiaRoot: string;
  hyperbetRoot: string;
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
  fightProgramBinary: string;
  marketProgramBinary: string;
  fightProgramIdl: string;
  marketProgramIdl: string;
  hyperiaFiles?: readonly string[];
  hyperbetFiles?: readonly string[];
  hyperbetSourceRevision?: string;
  hyperbetWorkingTreeDirty?: boolean;
}): DuelDisputeBuildEvidence {
  return {
    hyperia: collectBuildComponent({
      root: input.hyperiaRoot,
      files: input.hyperiaFiles ?? DEFAULT_HYPERIA_DISPUTE_SOURCE_FILES,
    }),
    hyperbet: collectBuildComponent({
      root: input.hyperbetRoot,
      files: input.hyperbetFiles ?? DEFAULT_HYPERBET_DISPUTE_SOURCE_FILES,
      sourceRevision: input.hyperbetSourceRevision,
      workingTreeDirty: input.hyperbetWorkingTreeDirty,
    }),
    programs: [
      {
        name: "fight_oracle",
        programId: input.fightProgramId.toBase58(),
        binarySha256: sha256File(input.fightProgramBinary),
        idlSha256: sha256File(input.fightProgramIdl),
      },
      {
        name: "duel_market",
        programId: input.marketProgramId.toBase58(),
        binarySha256: sha256File(input.marketProgramBinary),
        idlSha256: sha256File(input.marketProgramIdl),
      },
    ],
  };
}

async function fetchOwnedAccount(input: {
  connection: Connection;
  address: PublicKey;
  expectedOwner: PublicKey;
  label: string;
}): Promise<Buffer> {
  const account = await input.connection.getAccountInfo(
    input.address,
    "finalized",
  );
  if (!account) {
    throw new Error(`duel dispute collector ${input.label} account is missing`);
  }
  if (!account.owner.equals(input.expectedOwner) || account.executable) {
    throw new Error(`duel dispute collector ${input.label} owner drifted`);
  }
  return account.data;
}

export async function collectDuelDisputeEvidence(input: {
  connection: Connection;
  dbPath: string;
  duelId: string;
  classification: DuelDisputeEvidencePackage["classification"];
  buildEvidence: DuelDisputeBuildEvidence;
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
  generatedAt?: number;
}): Promise<DuelDisputeEvidencePackage> {
  const ledger = new TerminalLedger(input.dbPath, { readOnly: true });
  try {
    const timeline = ledger.getBettingFeedDuelEvidence(input.duelId);
    const terminalOperation = ledger.getByDuelId(input.duelId);
    if (!timeline || !terminalOperation) {
      throw new Error(
        "duel dispute collector local custody evidence is incomplete",
      );
    }
    const duelKey = duelKeyHexToBytes(terminalOperation.duelKey);
    const duelStatePda = findDuelStatePda(input.fightProgramId, duelKey);
    const marketStatePda = findMarketPda(input.marketProgramId, duelStatePda);
    const [oracleData, marketData] = await Promise.all([
      fetchOwnedAccount({
        connection: input.connection,
        address: duelStatePda,
        expectedOwner: input.fightProgramId,
        label: "oracle",
      }),
      fetchOwnedAccount({
        connection: input.connection,
        address: marketStatePda,
        expectedOwner: input.marketProgramId,
        label: "market",
      }),
    ]);
    const oracle = normalizeOracleAccountEvidence({
      decoded: new BorshAccountsCoder(fightOracleIdl as Idl).decode(
        "DuelState",
        oracleData,
      ),
      programId: input.fightProgramId,
      duelStatePda,
      expectedDuelKey: terminalOperation.duelKey,
    });
    const market = normalizeMarketAccountEvidence({
      decoded: new BorshAccountsCoder(duelMarketIdl as Idl).decode(
        "MarketState",
        marketData,
      ),
      programId: input.marketProgramId,
      marketStatePda,
      expectedDuelStatePda: duelStatePda,
      expectedDuelKey: terminalOperation.duelKey,
    });
    const transactions = await collectDuelChainEvidence({
      connection: input.connection,
      duelStatePda,
      marketStatePda,
      fightProgramId: input.fightProgramId,
      marketProgramId: input.marketProgramId,
      finalMarketStatus: market.status,
    });
    return buildDuelDisputeEvidence({
      generatedAt: input.generatedAt,
      classification: input.classification,
      buildEvidence: input.buildEvidence,
      timeline,
      terminalOperation,
      oracle,
      market,
      transactions,
    });
  } finally {
    ledger.close();
  }
}

export function writeDuelDisputeEvidenceArtifact(input: {
  outputPath: string;
  evidence: DuelDisputeEvidencePackage;
}): { outputPath: string; artifactSha256: string; packageDigest: string } {
  const outputPath = path.resolve(input.outputPath);
  if (!verifyDuelDisputeEvidencePackage(input.evidence)) {
    throw new Error(
      "duel dispute collector refused an invalid evidence package",
    );
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const payload = `${canonicalEvidenceJson(input.evidence)}\n`;
  const tempPath = `${outputPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(tempPath, outputPath);
    fs.unlinkSync(tempPath);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp file may not have been created or may already be renamed.
    }
    throw error;
  }
  return {
    outputPath,
    artifactSha256: createHash("sha256").update(payload).digest("hex"),
    packageDigest: input.evidence.packageDigest,
  };
}

export function verifyDuelDisputeEvidenceArtifact(input: {
  inputPath: string;
  expectedArtifactSha256?: string;
  expectedPackageDigest?: string;
  expectedDuelId?: string;
  expectedDuelKey?: string;
  expectedCluster?: DuelDisputeEvidencePackage["classification"]["cluster"];
  requireReleaseEligible?: boolean;
}): {
  inputPath: string;
  artifactSha256: string;
  packageDigest: string;
  duelId: string;
  duelKey: string;
  classification: DuelDisputeEvidencePackage["classification"];
  transactionCount: number;
} {
  const inputPath = path.resolve(input.inputPath);
  const metadata = fs.lstatSync(inputPath);
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > MAX_DISPUTE_ARTIFACT_BYTES
  ) {
    throw new Error("duel dispute evidence artifact is not a bounded file");
  }
  const payload = fs.readFileSync(inputPath);
  const artifactSha256 = createHash("sha256").update(payload).digest("hex");
  const expectedArtifactSha256 = input.expectedArtifactSha256?.toLowerCase();
  if (
    expectedArtifactSha256 !== undefined &&
    (!SHA256_HEX.test(expectedArtifactSha256) ||
      expectedArtifactSha256 !== artifactSha256)
  ) {
    throw new Error("duel dispute evidence artifact SHA-256 mismatch");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("duel dispute evidence artifact is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("duel dispute evidence artifact root is invalid");
  }
  const evidence = parsed as DuelDisputeEvidencePackage;
  if (!verifyDuelDisputeEvidencePackage(evidence)) {
    throw new Error("duel dispute evidence package verification failed");
  }
  const canonicalPayload = Buffer.from(
    `${canonicalEvidenceJson(evidence)}\n`,
    "utf8",
  );
  if (!payload.equals(canonicalPayload)) {
    throw new Error("duel dispute evidence artifact is not canonical");
  }

  const expectedPackageDigest = input.expectedPackageDigest?.toLowerCase();
  if (
    expectedPackageDigest !== undefined &&
    (!SHA256_HEX.test(expectedPackageDigest) ||
      expectedPackageDigest !== evidence.packageDigest)
  ) {
    throw new Error("duel dispute evidence package digest mismatch");
  }
  if (
    input.expectedDuelId !== undefined &&
    input.expectedDuelId !== evidence.identity.duelId
  ) {
    throw new Error("duel dispute evidence duel ID mismatch");
  }
  if (
    input.expectedDuelKey !== undefined &&
    input.expectedDuelKey.toLowerCase() !== evidence.identity.duelKey
  ) {
    throw new Error("duel dispute evidence duel key mismatch");
  }
  if (
    input.expectedCluster !== undefined &&
    input.expectedCluster !== evidence.classification.cluster
  ) {
    throw new Error("duel dispute evidence cluster mismatch");
  }
  if (
    input.requireReleaseEligible &&
    !evidence.classification.releaseEligible
  ) {
    throw new Error("duel dispute evidence package is not release-eligible");
  }

  return {
    inputPath,
    artifactSha256,
    packageDigest: evidence.packageDigest,
    duelId: evidence.identity.duelId,
    duelKey: evidence.identity.duelKey,
    classification: evidence.classification,
    transactionCount: evidence.transactions.length,
  };
}
