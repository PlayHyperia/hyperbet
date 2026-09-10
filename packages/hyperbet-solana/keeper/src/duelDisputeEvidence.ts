import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../../account-schema";
import {
  canonicalEvidenceJson,
  digestEvidence,
  type BettingFeedDuelEvidence,
} from "./bettingFeedEvidence";
import { buildDuelCorrelationId } from "./duelCorrelation";
import { buildResultHash } from "./resultHash";
import type { TerminalOperationRecord } from "./terminalLedger";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UINT_DECIMAL = /^(0|[1-9][0-9]*)$/;

export type DuelDisputeChainAction =
  | "oracle_betting_open"
  | "oracle_locked"
  | "oracle_result_proposed"
  | "oracle_result_finalized"
  | "oracle_cancelled"
  | "market_initialized"
  | "market_synced_resolved"
  | "market_synced_cancelled"
  | "market_terminal_claim"
  | "market_terminal_refund"
  | "market_trade_fees_withdrawn";

export type DuelDisputeChainTransaction = {
  signature: string;
  slot: number;
  blockTime: number | null;
  finalized: true;
  succeeded: true;
  transactionDigest: string;
  programIds: string[];
  instructionNames: string[];
  actions: DuelDisputeChainAction[];
};

export type DuelDisputeOracleState = {
  programId: string;
  duelStatePda: string;
  accountSchemaVersion?: number;
  status: "RESOLVED" | "CANCELLED";
  winnerSide: "A" | "B" | null;
  participantAHash: string;
  participantBHash: string;
  competitiveSnapshotVersion: number;
  competitiveSnapshotDigest: string;
  betOpenTs: number;
  betCloseTs: number;
  duelStartTs: number;
  duelEndTs: number;
  seed: string;
  replayHash: string;
  resultHash: string;
  metadataUri: string;
};

export type DuelDisputeMarketState = {
  programId: string;
  marketStatePda: string;
  duelStatePda: string;
  status: "RESOLVED" | "CANCELLED";
  winnerSide: "A" | "B" | null;
  marketKind: number;
  tradeTreasuryFeeBpsSnapshot: number;
  tradeMarketMakerFeeBpsSnapshot: number;
  winningsMarketMakerFeeBpsSnapshot: number;
  nextOrderId: string;
  bestBid: number;
  bestAsk: number;
  bidBitmapHex: string;
  askBitmapHex: string;
  accruedTradeTreasuryFeeLamports: string;
  accruedTradeMarketMakerFeeLamports: string;
  authority: string;
  treasury: string;
  marketMaker: string;
};

export type DuelDisputeSourceFile = {
  path: string;
  sha256: string;
};

export type DuelDisputeBuildComponent = {
  sourceRevision: string;
  workingTreeDirty: boolean;
  files: DuelDisputeSourceFile[];
};

export type DuelDisputeBuildEvidence = {
  hyperia: DuelDisputeBuildComponent;
  hyperbet: DuelDisputeBuildComponent;
  programs: Array<{
    name: "fight_oracle" | "duel_market";
    programId: string;
    binarySha256: string;
    idlSha256: string;
  }>;
};

export type DuelDisputeEvidencePackage = {
  schemaVersion: 1 | 2;
  proof: "hyperia-hyperbet-sol-duel-dispute-evidence";
  generatedAt: number;
  classification: {
    chain: "solana";
    cluster: "localnet" | "devnet" | "testnet" | "mainnet-beta";
    externalValue: boolean;
    productionEquivalentInfrastructure: boolean;
    releaseEligible: boolean;
  };
  identity: {
    duelId: string;
    duelKey: string;
    correlationId?: string;
    competitiveSnapshotVersion: number;
    competitiveSnapshotDigest: string;
    participantAId: string;
    participantBId: string;
  };
  buildEvidence: DuelDisputeBuildEvidence;
  competitiveSnapshot: BettingFeedDuelEvidence["competitiveSnapshot"];
  timeline: BettingFeedDuelEvidence;
  terminal: {
    operationId: number;
    fingerprint: string;
    outcome: "WIN" | "DRAW" | "CANCELLED";
    winnerSide: "A" | "B" | null;
    winnerId: string | null;
    reason: string | null;
    seed: string | null;
    replayHash: string | null;
    resultHash: string | null;
    completedAt: number;
  };
  oracle: DuelDisputeOracleState;
  market: DuelDisputeMarketState;
  transactions: DuelDisputeChainTransaction[];
  packageDigest: string;
};

function requiredText(value: unknown, label: string, maxLength = 512): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`duel dispute evidence ${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64).toLowerCase();
  if (!SHA256_HEX.test(normalized)) {
    throw new Error(`duel dispute evidence ${label} is not SHA-256`);
  }
  return normalized;
}

function publicKey(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64);
  try {
    return new PublicKey(normalized).toBase58();
  } catch {
    throw new Error(
      `duel dispute evidence ${label} is not a Solana public key`,
    );
  }
}

function transactionSignature(value: unknown): string {
  const normalized = requiredText(value, "transaction signature", 128);
  try {
    if (bs58.decode(normalized).length !== 64) throw new Error("wrong length");
  } catch {
    throw new Error(
      "duel dispute evidence transaction signature is not canonical",
    );
  }
  return normalized;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`duel dispute evidence ${label} is invalid`);
  }
  return Number(value);
}

function unsignedDecimal(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 32);
  if (!UINT_DECIMAL.test(normalized)) {
    throw new Error(`duel dispute evidence ${label} is invalid`);
  }
  return normalized;
}

function participantHash(participantId: string): string {
  return createHash("sha256").update(participantId).digest("hex");
}

function normalizeBuildComponent(
  value: DuelDisputeBuildComponent,
  label: string,
): DuelDisputeBuildComponent {
  if (!value || typeof value !== "object") {
    throw new Error(`duel dispute evidence ${label} build is missing`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`duel dispute evidence ${label} source files are missing`);
  }
  const paths = new Set<string>();
  const files = value.files.map((file) => {
    const path = requiredText(file.path, `${label} source path`, 512);
    if (path.startsWith("/") || path.includes("..") || paths.has(path)) {
      throw new Error(`duel dispute evidence ${label} source path is unsafe`);
    }
    paths.add(path);
    return { path, sha256: sha256(file.sha256, `${label} source hash`) };
  });
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    sourceRevision: requiredText(
      value.sourceRevision,
      `${label} source revision`,
      128,
    ),
    workingTreeDirty: value.workingTreeDirty === true,
    files,
  };
}

function normalizeBuildEvidence(
  value: DuelDisputeBuildEvidence,
): DuelDisputeBuildEvidence {
  if (!Array.isArray(value.programs) || value.programs.length !== 2) {
    throw new Error("duel dispute evidence requires both SOL program builds");
  }
  const programs = value.programs.map((program) => ({
    name: program.name,
    programId: publicKey(program.programId, `${program.name} program ID`),
    binarySha256: sha256(program.binarySha256, `${program.name} binary hash`),
    idlSha256: sha256(program.idlSha256, `${program.name} IDL hash`),
  }));
  if (
    new Set(programs.map(({ name }) => name)).size !== 2 ||
    new Set(programs.map(({ programId }) => programId)).size !== 2 ||
    !programs.some(({ name }) => name === "fight_oracle") ||
    !programs.some(({ name }) => name === "duel_market")
  ) {
    throw new Error("duel dispute evidence SOL program build names drifted");
  }
  programs.sort((left, right) => (left.name < right.name ? -1 : 1));
  return {
    hyperia: normalizeBuildComponent(value.hyperia, "Hyperia"),
    hyperbet: normalizeBuildComponent(value.hyperbet, "Hyperbet"),
    programs,
  };
}

function normalizeTransactions(
  transactions: DuelDisputeChainTransaction[],
): DuelDisputeChainTransaction[] {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error("duel dispute evidence chain transactions are missing");
  }
  const signatures = new Set<string>();
  return transactions
    .map((transaction) => {
      const signature = transactionSignature(transaction.signature);
      if (signatures.has(signature)) {
        throw new Error("duel dispute evidence has a duplicate transaction");
      }
      signatures.add(signature);
      if (
        transaction.finalized !== true ||
        transaction.succeeded !== true ||
        !Array.isArray(transaction.programIds) ||
        transaction.programIds.length === 0 ||
        !Array.isArray(transaction.instructionNames) ||
        transaction.instructionNames.length === 0 ||
        !Array.isArray(transaction.actions) ||
        transaction.actions.length === 0 ||
        new Set(transaction.actions).size !== transaction.actions.length
      ) {
        throw new Error("duel dispute evidence transaction state is invalid");
      }
      return {
        signature,
        slot: safeInteger(transaction.slot, "transaction slot", 1),
        blockTime:
          transaction.blockTime === null
            ? null
            : safeInteger(transaction.blockTime, "transaction block time", 1),
        finalized: true as const,
        succeeded: true as const,
        transactionDigest: sha256(
          transaction.transactionDigest,
          "transaction digest",
        ),
        programIds: [
          ...new Set(
            transaction.programIds.map((programId) =>
              publicKey(programId, "transaction program ID"),
            ),
          ),
        ].sort(),
        instructionNames: [
          ...new Set(
            transaction.instructionNames.map((name) =>
              requiredText(name, "transaction instruction name", 128),
            ),
          ),
        ].sort(),
        actions: [...transaction.actions].sort(),
      };
    })
    .sort(
      (left, right) =>
        left.slot - right.slot || (left.signature < right.signature ? -1 : 1),
    );
}

function requireActions(
  transactions: DuelDisputeChainTransaction[],
  actions: DuelDisputeChainAction[],
): void {
  const observed = new Set(transactions.flatMap(({ actions }) => actions));
  const missing = actions.filter((action) => !observed.has(action));
  if (missing.length > 0) {
    throw new Error(
      `duel dispute evidence is missing chain action(s): ${missing.join(", ")}`,
    );
  }
}

function normalizeOracle(
  value: DuelDisputeOracleState,
): DuelDisputeOracleState {
  const accountSchemaVersion = safeInteger(
    value.accountSchemaVersion,
    "oracle account schema version",
    1,
  );
  if (accountSchemaVersion !== FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION) {
    throw new Error(
      `duel dispute evidence oracle account schema v${accountSchemaVersion} is unsupported`,
    );
  }
  return {
    programId: publicKey(value.programId, "oracle program ID"),
    duelStatePda: publicKey(value.duelStatePda, "duel-state PDA"),
    accountSchemaVersion,
    status: value.status,
    winnerSide: value.winnerSide,
    participantAHash: sha256(value.participantAHash, "participant A hash"),
    participantBHash: sha256(value.participantBHash, "participant B hash"),
    competitiveSnapshotVersion: safeInteger(
      value.competitiveSnapshotVersion,
      "oracle competitive snapshot version",
      1,
    ),
    competitiveSnapshotDigest: sha256(
      value.competitiveSnapshotDigest,
      "oracle competitive snapshot digest",
    ),
    betOpenTs: safeInteger(value.betOpenTs, "oracle bet-open timestamp", 1),
    betCloseTs: safeInteger(value.betCloseTs, "oracle bet-close timestamp", 1),
    duelStartTs: safeInteger(
      value.duelStartTs,
      "oracle duel-start timestamp",
      1,
    ),
    duelEndTs: safeInteger(value.duelEndTs, "oracle duel-end timestamp"),
    seed: unsignedDecimal(value.seed, "oracle seed"),
    replayHash: sha256(value.replayHash, "oracle replay hash"),
    resultHash: sha256(value.resultHash, "oracle result hash"),
    metadataUri: requiredText(value.metadataUri, "oracle metadata", 512),
  };
}

function normalizeBitmap(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 256).toLowerCase();
  if (!/^[0-9a-f]{256}$/.test(normalized)) {
    throw new Error(`duel dispute evidence ${label} is invalid`);
  }
  return normalized;
}

function normalizeMarket(
  value: DuelDisputeMarketState,
): DuelDisputeMarketState {
  return {
    programId: publicKey(value.programId, "market program ID"),
    marketStatePda: publicKey(value.marketStatePda, "market-state PDA"),
    duelStatePda: publicKey(value.duelStatePda, "market duel-state PDA"),
    status: value.status,
    winnerSide: value.winnerSide,
    marketKind: safeInteger(value.marketKind, "market kind"),
    tradeTreasuryFeeBpsSnapshot: safeInteger(
      value.tradeTreasuryFeeBpsSnapshot,
      "treasury fee snapshot",
    ),
    tradeMarketMakerFeeBpsSnapshot: safeInteger(
      value.tradeMarketMakerFeeBpsSnapshot,
      "market-maker fee snapshot",
    ),
    winningsMarketMakerFeeBpsSnapshot: safeInteger(
      value.winningsMarketMakerFeeBpsSnapshot,
      "winnings fee snapshot",
    ),
    nextOrderId: unsignedDecimal(value.nextOrderId, "next order ID"),
    bestBid: safeInteger(value.bestBid, "best bid"),
    bestAsk: safeInteger(value.bestAsk, "best ask"),
    bidBitmapHex: normalizeBitmap(value.bidBitmapHex, "bid bitmap"),
    askBitmapHex: normalizeBitmap(value.askBitmapHex, "ask bitmap"),
    accruedTradeTreasuryFeeLamports: unsignedDecimal(
      value.accruedTradeTreasuryFeeLamports,
      "treasury fee accrual",
    ),
    accruedTradeMarketMakerFeeLamports: unsignedDecimal(
      value.accruedTradeMarketMakerFeeLamports,
      "market-maker fee accrual",
    ),
    authority: publicKey(value.authority, "market authority"),
    treasury: publicKey(value.treasury, "market treasury"),
    marketMaker: publicKey(value.marketMaker, "market maker"),
  };
}

function assertPhaseCoverage(
  timeline: BettingFeedDuelEvidence,
  outcome: TerminalOperationRecord["outcome"],
): void {
  const phases = timeline.frames.map(({ phase }) => phase);
  const required =
    outcome === "CANCELLED"
      ? ["ANNOUNCEMENT"]
      : ["ANNOUNCEMENT", "COUNTDOWN", "FIGHTING", "RESOLUTION"];
  let previousIndex = -1;
  for (const phase of required) {
    const index = phases.indexOf(phase);
    if (index <= previousIndex) {
      throw new Error(
        `duel dispute evidence timeline is missing ordered ${phase}`,
      );
    }
    previousIndex = index;
  }
}

export function buildDuelDisputeEvidence(input: {
  generatedAt?: number;
  classification: DuelDisputeEvidencePackage["classification"];
  buildEvidence: DuelDisputeBuildEvidence;
  timeline: BettingFeedDuelEvidence;
  terminalOperation: TerminalOperationRecord;
  oracle: DuelDisputeOracleState;
  market: DuelDisputeMarketState;
  transactions: DuelDisputeChainTransaction[];
}): DuelDisputeEvidencePackage {
  const generatedAt = safeInteger(
    input.generatedAt ?? Date.now(),
    "generation timestamp",
    1,
  );
  const timeline = input.timeline;
  if (
    timeline.schemaVersion !== 1 ||
    timeline.proof !== "hyperia-schema-v3-material-duel-timeline" ||
    digestEvidence(timeline.competitiveSnapshot) !==
      timeline.competitiveSnapshotDigest ||
    digestEvidence(timeline.frames.map((frame) => frame.frameDigest)) !==
      timeline.timelineDigest
  ) {
    throw new Error("duel dispute evidence timeline digest drifted");
  }
  const competitiveSnapshotVersion =
    timeline.frames[0]?.competitiveSnapshotVersion;
  if (
    !Number.isSafeInteger(competitiveSnapshotVersion) ||
    Number(competitiveSnapshotVersion) <= 0 ||
    timeline.frames.some(
      (frame) =>
        frame.competitiveSnapshotVersion !== competitiveSnapshotVersion,
    )
  ) {
    throw new Error("duel dispute evidence snapshot version drifted");
  }
  const operation = input.terminalOperation;
  const correlationId = buildDuelCorrelationId({
    duelId: timeline.duelId,
    duelKey: timeline.duelKey,
  });
  if (
    operation.status !== "SUCCEEDED" ||
    operation.completedAt === null ||
    operation.duelId !== timeline.duelId ||
    operation.duelKey !== timeline.duelKey ||
    !SHA256_HEX.test(operation.fingerprint) ||
    operation.correlationId !== correlationId
  ) {
    throw new Error("duel dispute evidence terminal operation is not final");
  }
  assertPhaseCoverage(timeline, operation.outcome);
  const contestants = timeline.competitiveSnapshot.contestants;
  const participantAId = String(contestants[0]?.agentId ?? "");
  const participantBId = String(contestants[1]?.agentId ?? "");
  if (
    operation.participantAId !== participantAId ||
    operation.participantBId !== participantBId ||
    participantAId.length === 0 ||
    participantBId.length === 0
  ) {
    throw new Error("duel dispute evidence participant identity drifted");
  }
  const terminalFrame = timeline.frames.at(-1)!;
  const expectedOutcome =
    operation.outcome === "WIN"
      ? "win"
      : operation.outcome === "DRAW"
        ? "draw"
        : "cancelled";
  if (
    terminalFrame.outcome !== expectedOutcome ||
    terminalFrame.winnerId !== operation.winnerId ||
    terminalFrame.cancellationReason !== operation.reason ||
    terminalFrame.seed !== operation.seed ||
    terminalFrame.replayHash !== operation.replayHash
  ) {
    throw new Error("duel dispute evidence terminal frame drifted");
  }
  const resultHash =
    operation.outcome === "WIN" &&
    operation.winnerSide &&
    operation.seed &&
    operation.replayHash
      ? Buffer.from(
          buildResultHash(
            operation.duelKey,
            operation.winnerSide,
            operation.seed,
            operation.replayHash,
            Number(competitiveSnapshotVersion),
            timeline.competitiveSnapshotDigest,
          ),
        ).toString("hex")
      : null;
  const oracle = normalizeOracle(input.oracle);
  const market = normalizeMarket(input.market);
  if (
    oracle.participantAHash !== participantHash(participantAId) ||
    oracle.participantBHash !== participantHash(participantBId) ||
    oracle.betOpenTs !==
      Math.floor(timeline.competitiveSnapshot.betOpenTime / 1_000) ||
    oracle.betCloseTs !==
      Math.floor(timeline.competitiveSnapshot.betCloseTime / 1_000) ||
    oracle.competitiveSnapshotVersion !== competitiveSnapshotVersion ||
    oracle.competitiveSnapshotDigest !== timeline.competitiveSnapshotDigest ||
    market.duelStatePda !== oracle.duelStatePda
  ) {
    throw new Error("duel dispute evidence on-chain identity/timing drifted");
  }
  if (operation.outcome === "WIN") {
    const driftedFields: string[] = [];
    if (
      terminalFrame.fightStartTime === null ||
      oracle.duelStartTs !== Math.floor(terminalFrame.fightStartTime / 1_000)
    ) {
      driftedFields.push("duelStartTs");
    }
    if (
      terminalFrame.duelEndTime === null ||
      oracle.duelEndTs !== Math.floor(terminalFrame.duelEndTime / 1_000)
    ) {
      driftedFields.push("duelEndTs");
    }
    if (oracle.status !== "RESOLVED") driftedFields.push("oracle.status");
    if (market.status !== "RESOLVED") driftedFields.push("market.status");
    if (oracle.winnerSide !== operation.winnerSide) {
      driftedFields.push("oracle.winnerSide");
    }
    if (market.winnerSide !== operation.winnerSide) {
      driftedFields.push("market.winnerSide");
    }
    if (oracle.seed !== operation.seed) driftedFields.push("seed");
    if (oracle.replayHash !== operation.replayHash) {
      driftedFields.push("replayHash");
    }
    if (oracle.resultHash !== resultHash) driftedFields.push("resultHash");
    if (driftedFields.length > 0) {
      throw new Error(
        `duel dispute evidence resolved result drifted: ${driftedFields.join(", ")}`,
      );
    }
  } else if (
    oracle.status !== "CANCELLED" ||
    market.status !== "CANCELLED" ||
    oracle.winnerSide !== null ||
    market.winnerSide !== null ||
    oracle.duelEndTs !== 0 ||
    oracle.seed !== "0" ||
    oracle.replayHash !== "0".repeat(64) ||
    oracle.resultHash !== "0".repeat(64) ||
    (terminalFrame.fightStartTime !== null &&
      oracle.duelStartTs !== Math.floor(terminalFrame.fightStartTime / 1_000))
  ) {
    throw new Error("duel dispute evidence cancellation state drifted");
  }

  const buildEvidence = normalizeBuildEvidence(input.buildEvidence);
  const fightProgram = buildEvidence.programs.find(
    ({ name }) => name === "fight_oracle",
  )!;
  const marketProgram = buildEvidence.programs.find(
    ({ name }) => name === "duel_market",
  )!;
  if (
    fightProgram.programId !== oracle.programId ||
    marketProgram.programId !== market.programId
  ) {
    throw new Error("duel dispute evidence program build identity drifted");
  }
  const transactions = normalizeTransactions(input.transactions);
  if (
    transactions.some(
      ({ programIds }) =>
        programIds.length === 0 ||
        programIds.some(
          (programId) =>
            programId !== oracle.programId && programId !== market.programId,
        ),
    )
  ) {
    throw new Error("duel dispute evidence transaction program drifted");
  }
  for (const transaction of transactions) {
    if (
      transaction.actions.some((action) => action.startsWith("oracle_")) &&
      !transaction.programIds.includes(oracle.programId)
    ) {
      throw new Error("duel dispute evidence oracle action program drifted");
    }
    if (
      transaction.actions.some((action) => action.startsWith("market_")) &&
      !transaction.programIds.includes(market.programId)
    ) {
      throw new Error("duel dispute evidence market action program drifted");
    }
  }
  requireActions(
    transactions,
    operation.outcome === "WIN"
      ? [
          "oracle_betting_open",
          "oracle_locked",
          "oracle_result_proposed",
          "oracle_result_finalized",
          "market_initialized",
          "market_synced_resolved",
        ]
      : [
          "oracle_betting_open",
          "oracle_cancelled",
          "market_initialized",
          "market_synced_cancelled",
        ],
  );
  const classification = {
    chain: "solana" as const,
    cluster: input.classification.cluster,
    externalValue: input.classification.externalValue === true,
    productionEquivalentInfrastructure:
      input.classification.productionEquivalentInfrastructure === true,
    releaseEligible: input.classification.releaseEligible === true,
  };
  if (
    !["localnet", "devnet", "testnet", "mainnet-beta"].includes(
      classification.cluster,
    )
  ) {
    throw new Error("duel dispute evidence cluster is invalid");
  }
  if (
    classification.releaseEligible &&
    (classification.cluster !== "mainnet-beta" ||
      !classification.externalValue ||
      !classification.productionEquivalentInfrastructure ||
      buildEvidence.hyperia.workingTreeDirty ||
      buildEvidence.hyperbet.workingTreeDirty)
  ) {
    throw new Error(
      "duel dispute evidence cannot mark this build release-eligible",
    );
  }
  const packageWithoutDigest = {
    schemaVersion: 2 as const,
    proof: "hyperia-hyperbet-sol-duel-dispute-evidence" as const,
    generatedAt,
    classification,
    identity: {
      duelId: timeline.duelId,
      duelKey: timeline.duelKey,
      correlationId,
      competitiveSnapshotVersion: Number(competitiveSnapshotVersion),
      competitiveSnapshotDigest: timeline.competitiveSnapshotDigest,
      participantAId,
      participantBId,
    },
    buildEvidence,
    competitiveSnapshot: timeline.competitiveSnapshot,
    timeline,
    terminal: {
      operationId: operation.id,
      fingerprint: operation.fingerprint,
      outcome: operation.outcome,
      winnerSide: operation.winnerSide,
      winnerId: operation.winnerId,
      reason: operation.reason,
      seed: operation.seed,
      replayHash: operation.replayHash,
      resultHash,
      completedAt: operation.completedAt,
    },
    oracle,
    market,
    transactions,
  };
  return {
    ...packageWithoutDigest,
    packageDigest: digestEvidence(packageWithoutDigest),
  };
}

export function verifyDuelDisputeEvidencePackage(
  evidence: DuelDisputeEvidencePackage,
): boolean {
  try {
    if (evidence.schemaVersion !== 1 && evidence.schemaVersion !== 2) {
      return false;
    }
    if (
      (evidence.schemaVersion === 1 &&
        evidence.oracle.accountSchemaVersion !== undefined) ||
      (evidence.schemaVersion === 2 &&
        evidence.oracle.accountSchemaVersion === undefined)
    ) {
      return false;
    }
    const correlationId = buildDuelCorrelationId({
      duelId: evidence.identity.duelId,
      duelKey: evidence.identity.duelKey,
    });
    if (
      evidence.identity.correlationId !== undefined &&
      evidence.identity.correlationId !== correlationId
    ) {
      return false;
    }
    const { packageDigest, ...payload } = evidence;
    if (
      !SHA256_HEX.test(packageDigest) ||
      digestEvidence(payload) !== packageDigest ||
      canonicalEvidenceJson(evidence).length === 0
    ) {
      return false;
    }
    const rebuilt = buildDuelDisputeEvidence({
      generatedAt: evidence.generatedAt,
      classification: evidence.classification,
      buildEvidence: evidence.buildEvidence,
      timeline: evidence.timeline,
      terminalOperation: {
        id: evidence.terminal.operationId,
        duelId: evidence.identity.duelId,
        duelKey: evidence.identity.duelKey,
        correlationId,
        fingerprint: evidence.terminal.fingerprint,
        outcome: evidence.terminal.outcome,
        winnerSide: evidence.terminal.winnerSide,
        participantAId: evidence.identity.participantAId,
        participantBId: evidence.identity.participantBId,
        winnerId: evidence.terminal.winnerId,
        reason: evidence.terminal.reason,
        seed: evidence.terminal.seed,
        replayHash: evidence.terminal.replayHash,
        event: {},
        status: "SUCCEEDED",
        attempts: 1,
        nextAttemptAt: evidence.terminal.completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        createdAt: evidence.terminal.completedAt,
        updatedAt: evidence.terminal.completedAt,
        completedAt: evidence.terminal.completedAt,
        requeueCount: 0,
        lastRequeuedAt: null,
        lastRequeuedBy: null,
      },
      oracle:
        evidence.schemaVersion === 1
          ? {
              ...evidence.oracle,
              accountSchemaVersion: FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
            }
          : evidence.oracle,
      market: evidence.market,
      transactions: evidence.transactions,
    });
    const { packageDigest: _rebuiltDigest, ...rebuiltPayload } = rebuilt;
    const { accountSchemaVersion: _accountSchemaVersion, ...legacyOracle } =
      rebuilt.oracle;
    const { correlationId: _rebuiltCorrelationId, ...legacyIdentity } =
      rebuilt.identity;
    const comparablePayload = {
      ...rebuiltPayload,
      schemaVersion: evidence.schemaVersion,
      oracle: evidence.schemaVersion === 1 ? legacyOracle : rebuilt.oracle,
      identity:
        evidence.identity.correlationId === undefined
          ? legacyIdentity
          : rebuilt.identity,
    };
    const comparable = {
      ...comparablePayload,
      packageDigest: digestEvidence(comparablePayload),
    };
    return (
      canonicalEvidenceJson(comparable) === canonicalEvidenceJson(evidence)
    );
  } catch {
    return false;
  }
}
