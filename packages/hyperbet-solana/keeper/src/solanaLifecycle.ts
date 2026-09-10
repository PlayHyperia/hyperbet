export type RecordedBetChain = "SOLANA";

export type PredictionMarketLifecycleStatus =
  | "PENDING"
  | "OPEN"
  | "LOCKED"
  | "PROPOSED"
  | "CHALLENGED"
  | "RESOLVED"
  | "CANCELLED"
  | "UNKNOWN";

export type PredictionMarketWinner = "NONE" | "A" | "B";

export interface PredictionMarketLifecycleMetadata extends Record<
  string,
  unknown
> {
  proposalId?: string | null;
  challengeWindowEndsAt?: number | null;
  finalizedAt?: number | null;
  cancellationReason?: string | null;
}

export interface PredictionMarketLifecycleRecord {
  chainKey: "solana";
  duelKey: string | null;
  duelId: string | null;
  marketId: string | null;
  marketRef: string | null;
  lifecycleStatus: PredictionMarketLifecycleStatus;
  winner: PredictionMarketWinner;
  betCloseTime: number | null;
  contractAddress: null;
  programId: string | null;
  txRef: string | null;
  syncedAt: number | null;
  metadata?: PredictionMarketLifecycleMetadata;
  marketType?: "clob";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePredictionMarketLifecycleMetadata(
  value: unknown,
): PredictionMarketLifecycleMetadata | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;
  return {
    ...candidate,
    proposalId:
      typeof candidate.proposalId === "string" ? candidate.proposalId : null,
    challengeWindowEndsAt: normalizeTimestamp(candidate.challengeWindowEndsAt),
    finalizedAt: normalizeTimestamp(candidate.finalizedAt),
    cancellationReason:
      typeof candidate.cancellationReason === "string"
        ? candidate.cancellationReason
        : null,
  };
}

export function toRecordedBetChain(chainKey: "solana"): RecordedBetChain {
  void chainKey;
  return "SOLANA";
}

export function resolveLifecycleFromStreamPhase(
  phase: string | null | undefined,
): PredictionMarketLifecycleStatus {
  switch (phase?.toUpperCase()) {
    case "ANNOUNCEMENT":
      return "OPEN";
    case "COUNTDOWN":
    case "FIGHTING":
      return "LOCKED";
    case "RESOLUTION":
      return "RESOLVED";
    case "IDLE":
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

export function resolveLifecycleFromSolanaDuelStatus(
  status: string | null | undefined,
): PredictionMarketLifecycleStatus {
  switch (status?.trim().toLowerCase()) {
    case "scheduled":
      return "PENDING";
    case "bettingopen":
    case "betting_open":
      return "OPEN";
    case "locked":
      return "LOCKED";
    case "proposed":
      return "PROPOSED";
    case "challenged":
      return "CHALLENGED";
    case "resolved":
      return "RESOLVED";
    case "cancelled":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

export function resolveLifecycleFromSolanaMarketStatus(
  status: string | null | undefined,
): PredictionMarketLifecycleStatus {
  switch (status?.trim().toLowerCase()) {
    case "open":
      return "OPEN";
    case "locked":
      return "LOCKED";
    case "resolved":
      return "RESOLVED";
    case "cancelled":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

export function isCurrentSolanaLifecycleSnapshot(input: {
  expectedDuelPda: string | null;
  expectedMarketPda: string | null;
  snapshotDuelPda: unknown;
  snapshotMarketPda: unknown;
}): boolean {
  return (
    input.expectedDuelPda !== null &&
    input.expectedMarketPda !== null &&
    input.snapshotDuelPda === input.expectedDuelPda &&
    input.snapshotMarketPda === input.expectedMarketPda
  );
}

export function resolveCurrentSolanaLifecycleAuthority(input: {
  expectedDuelPda: string | null;
  expectedMarketPda: string | null;
  snapshotDuelPda: unknown;
  snapshotMarketPda: unknown;
  currentDuelAccountExists: unknown;
  currentMarketAccountExists: unknown;
  currentDuelStatus: unknown;
  currentMarketStatus: unknown;
  currentMarketWinner: unknown;
  snapshotSyncedAt: number | null;
}): {
  snapshotMatchesCurrentDuel: boolean;
  currentMarketObserved: boolean;
  lifecycleStatus: PredictionMarketLifecycleStatus;
  winner: PredictionMarketWinner;
  syncedAt: number | null;
} {
  const snapshotMatchesCurrentDuel = isCurrentSolanaLifecycleSnapshot(input);
  const currentMarketObserved =
    snapshotMatchesCurrentDuel &&
    input.currentDuelAccountExists === true &&
    input.currentMarketAccountExists === true;
  if (!currentMarketObserved) {
    return {
      snapshotMatchesCurrentDuel,
      currentMarketObserved,
      lifecycleStatus: "PENDING",
      winner: "NONE",
      syncedAt: snapshotMatchesCurrentDuel ? input.snapshotSyncedAt : null,
    };
  }

  const duelStatus = resolveLifecycleFromSolanaDuelStatus(
    typeof input.currentDuelStatus === "string"
      ? input.currentDuelStatus
      : null,
  );
  const marketStatus = resolveLifecycleFromSolanaMarketStatus(
    typeof input.currentMarketStatus === "string"
      ? input.currentMarketStatus
      : null,
  );
  const lifecycleStatus = duelStatus !== "UNKNOWN" ? duelStatus : marketStatus;
  const normalizedWinner =
    typeof input.currentMarketWinner === "string"
      ? input.currentMarketWinner.toUpperCase()
      : null;
  const winnerIsCanonical =
    normalizedWinner === "NONE" ||
    normalizedWinner === "A" ||
    normalizedWinner === "B";
  const winner: PredictionMarketWinner =
    normalizedWinner === "A" || normalizedWinner === "B"
      ? normalizedWinner
      : "NONE";
  const winnerIsCoherent =
    winnerIsCanonical && lifecycleStatus === "RESOLVED"
      ? winner !== "NONE"
      : winnerIsCanonical && winner === "NONE";

  return {
    snapshotMatchesCurrentDuel,
    currentMarketObserved,
    lifecycleStatus: winnerIsCoherent ? lifecycleStatus : "UNKNOWN",
    winner: winnerIsCoherent ? winner : "NONE",
    syncedAt: input.snapshotSyncedAt,
  };
}
