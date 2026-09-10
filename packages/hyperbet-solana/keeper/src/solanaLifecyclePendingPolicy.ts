export type SolanaLifecyclePendingState = Readonly<{
  pendingBets: number;
  oldestPendingBetAgeMs: number | null;
  withinFinalizationGrace: boolean;
}>;

/**
 * A newly submitted transaction can be recorded before the finalized index
 * sees it. Keep that normal finalization interval observable without flapping
 * service readiness, but fail closed once the persisted backlog outlives the
 * configured grace period.
 */
export function evaluateSolanaLifecyclePendingState(input: {
  pendingBets: number;
  oldestPendingBetRecordedAt: number | null;
  nowMs: number;
  maximumPendingAgeMs: number;
}): SolanaLifecyclePendingState {
  if (
    !Number.isSafeInteger(input.pendingBets) ||
    input.pendingBets < 0 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    !Number.isSafeInteger(input.maximumPendingAgeMs) ||
    input.maximumPendingAgeMs < 1
  ) {
    throw new Error("Solana lifecycle pending policy input is invalid");
  }
  if (input.pendingBets === 0) {
    if (input.oldestPendingBetRecordedAt !== null) {
      throw new Error("Solana lifecycle empty backlog retained a timestamp");
    }
    return Object.freeze({
      pendingBets: 0,
      oldestPendingBetAgeMs: null,
      withinFinalizationGrace: true,
    });
  }
  const oldestPendingBetRecordedAt = input.oldestPendingBetRecordedAt;
  if (
    typeof oldestPendingBetRecordedAt !== "number" ||
    !Number.isSafeInteger(oldestPendingBetRecordedAt) ||
    oldestPendingBetRecordedAt < 0 ||
    oldestPendingBetRecordedAt > input.nowMs
  ) {
    throw new Error("Solana lifecycle pending timestamp is invalid");
  }
  const oldestPendingBetAgeMs = input.nowMs - oldestPendingBetRecordedAt;
  return Object.freeze({
    pendingBets: input.pendingBets,
    oldestPendingBetAgeMs,
    withinFinalizationGrace: oldestPendingBetAgeMs <= input.maximumPendingAgeMs,
  });
}
