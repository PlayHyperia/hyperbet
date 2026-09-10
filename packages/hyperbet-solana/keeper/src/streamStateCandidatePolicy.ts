type StreamStateCandidate = {
  seq: number;
  emittedAt: number;
};

function isCanonicalCursor(state: StreamStateCandidate): boolean {
  return (
    Number.isSafeInteger(state.seq) &&
    state.seq >= 0 &&
    Number.isSafeInteger(state.emittedAt) &&
    state.emittedAt > 0
  );
}

/**
 * Prevent an available source from rolling the public stream cursor backward.
 * After an explicitly published disconnect, a restarted authority may reset
 * its sequence, but only a strictly newer timestamp can re-establish trust.
 */
export function shouldAcceptStreamStateCandidate(
  current: StreamStateCandidate,
  candidate: StreamStateCandidate,
  options: { sourceAvailable: boolean },
): boolean {
  if (!isCanonicalCursor(candidate)) return false;
  if (!isCanonicalCursor(current)) return true;

  if (!options.sourceAvailable) {
    return candidate.emittedAt > current.emittedAt;
  }

  return (
    candidate.seq >= current.seq && candidate.emittedAt >= current.emittedAt
  );
}

/**
 * Keep the accepted producer cursor byte-for-byte authoritative. A relay that
 * increments this cursor on its own will eventually reject the producer's
 * next valid frame as a regression.
 */
export function resolveAcceptedStreamCursor(
  candidate: StreamStateCandidate,
): StreamStateCandidate {
  if (!isCanonicalCursor(candidate)) {
    throw new Error("Accepted stream state has an invalid canonical cursor");
  }
  return { seq: candidate.seq, emittedAt: candidate.emittedAt };
}
