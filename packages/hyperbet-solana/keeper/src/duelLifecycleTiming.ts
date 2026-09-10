export type DuelLifecycleTiming = {
  betOpenTs: number;
  betCloseTs: number;
  duelStartTs: number;
};

type ResolveDuelLifecycleTimingInput = {
  existing: DuelLifecycleTiming | null;
  betOpenTimeMs: number | null | undefined;
  betCloseTimeMs: number | null | undefined;
  fightStartTimeMs: number | null | undefined;
  nowMs: number;
};

function requireCanonicalTiming(
  timing: DuelLifecycleTiming,
): DuelLifecycleTiming {
  if (
    !Number.isSafeInteger(timing.betOpenTs) ||
    timing.betOpenTs <= 0 ||
    !Number.isSafeInteger(timing.betCloseTs) ||
    timing.betCloseTs <= timing.betOpenTs ||
    !Number.isSafeInteger(timing.duelStartTs) ||
    timing.duelStartTs < timing.betCloseTs
  ) {
    throw new Error("Existing duel contains invalid immutable timing");
  }
  return timing;
}

function finiteMillis(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Resolve the oracle's immutable second-level phase boundaries.
 *
 * The first on-chain upsert fixes these values. The producer publishes the
 * planned fightStartTime during announcement; later lifecycle events must
 * reuse the on-chain values rather than move a window after positions exist.
 */
export function resolveDuelLifecycleTiming(
  input: ResolveDuelLifecycleTimingInput,
): DuelLifecycleTiming {
  if (input.existing) {
    return requireCanonicalTiming({ ...input.existing });
  }

  const nowMs = finiteMillis(input.nowMs);
  if (nowMs === null) {
    throw new Error("Current time is invalid for duel timing");
  }
  const betOpenTimeMs = finiteMillis(input.betOpenTimeMs) ?? nowMs;
  const closeCandidateMs =
    finiteMillis(input.betCloseTimeMs) ??
    finiteMillis(input.fightStartTimeMs) ??
    nowMs + 1_000;
  const betOpenTs = Math.floor(betOpenTimeMs / 1_000);
  const betCloseTs = Math.max(
    betOpenTs + 1,
    Math.floor(closeCandidateMs / 1_000),
  );
  const duelStartCandidateMs =
    finiteMillis(input.fightStartTimeMs) ??
    finiteMillis(input.betCloseTimeMs) ??
    nowMs;
  const duelStartTs = Math.max(
    betCloseTs,
    Math.floor(duelStartCandidateMs / 1_000),
  );

  return requireCanonicalTiming({ betOpenTs, betCloseTs, duelStartTs });
}
