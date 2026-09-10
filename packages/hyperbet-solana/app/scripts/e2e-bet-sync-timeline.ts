export function normalizeFightStartTime(args: {
  phase: string | null;
  scheduledFightStartTime: number | null;
  duelEndTime: number | null;
  emittedAt: number;
}): number | null {
  const { phase, scheduledFightStartTime, duelEndTime, emittedAt } = args;
  if (
    (phase !== "FIGHTING" && phase !== "RESOLUTION") ||
    scheduledFightStartTime === null ||
    scheduledFightStartTime > emittedAt ||
    (duelEndTime !== null && duelEndTime < scheduledFightStartTime)
  ) {
    return null;
  }
  return scheduledFightStartTime;
}
