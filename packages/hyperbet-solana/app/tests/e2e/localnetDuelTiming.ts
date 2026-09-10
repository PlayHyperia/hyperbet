export type CanonicalDuelTiming = {
  betOpenTime: number | null;
  betCloseTime: number | null;
  fightStartTime: number | null;
  competitiveSnapshot?: {
    timing?: { fightStartTime?: unknown };
  } | null;
};

export type LocalnetDuelTiming = {
  betOpenTs: number;
  betCloseTs: number;
  duelStartTs: number;
};

function toUnixSeconds(value: number | null, label: string): number {
  if (!Number.isSafeInteger(value) || value === null || value <= 0) {
    throw new Error(`${label} must be a positive integer timestamp`);
  }
  return Math.floor(value / 1_000);
}

export function resolveLocalnetDuelTiming(
  nowUnixSeconds: number,
  cycle: CanonicalDuelTiming | null,
): LocalnetDuelTiming {
  if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds <= 0) {
    throw new Error("nowUnixSeconds must be a positive integer timestamp");
  }

  if (!cycle) {
    const betCloseTs = nowUnixSeconds + 3_600;
    return {
      betOpenTs: nowUnixSeconds - 30,
      betCloseTs,
      // Explicit one-second local fixture countdown; never a production value.
      duelStartTs: betCloseTs + 1,
    };
  }

  const betOpenTs = toUnixSeconds(cycle.betOpenTime, "betOpenTime");
  const betCloseTs = toUnixSeconds(cycle.betCloseTime, "betCloseTime");
  if (betOpenTs >= betCloseTs) {
    throw new Error("betOpenTime must be before betCloseTime");
  }
  const committedFightStartTime =
    cycle.competitiveSnapshot?.timing?.fightStartTime;
  if (
    !Number.isSafeInteger(committedFightStartTime) ||
    Number(committedFightStartTime) <= 0
  ) {
    throw new Error("schema-v4 timing must commit a positive fightStartTime");
  }
  if (
    cycle.fightStartTime !== null &&
    cycle.fightStartTime !== committedFightStartTime
  ) {
    throw new Error("published fightStartTime must match schema-v4 timing");
  }
  const duelStartTs = toUnixSeconds(
    Number(committedFightStartTime),
    "competitiveSnapshot.timing.fightStartTime",
  );
  if (duelStartTs <= betCloseTs) {
    throw new Error("fightStartTime must be after betCloseTime");
  }

  return { betOpenTs, betCloseTs, duelStartTs };
}
