type StreamFixture = Readonly<{
  cycle: Readonly<Record<string, unknown>>;
  leaderboard?: unknown;
  cameraTarget?: unknown;
  preparation?: unknown;
}>;

/**
 * Submit a new local-fixture event, not a replay of the GET response envelope.
 * The publisher must allocate a fresh sequence for every terminal/fault edge.
 */
export function buildWagerAuthorityFixtureUpdate(
  source: StreamFixture,
  cycleChanges: Readonly<Record<string, unknown>>,
  emittedAt: number,
) {
  if (!Number.isSafeInteger(emittedAt) || emittedAt <= 0) {
    throw new Error("Fixture event timestamp must be a positive safe integer");
  }
  return {
    emittedAt,
    cycle: { ...source.cycle, ...cycleChanges },
    leaderboard: source.leaderboard ?? [],
    cameraTarget: source.cameraTarget ?? null,
    preparation: source.preparation ?? null,
  };
}
