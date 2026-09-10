export type StreamFailoverDecision = {
  exhausted: boolean;
  failedSourceIndexes: number[];
  nextSourceIndex: number;
};

export type StreamPlaybackTransportInput = {
  telemetryConnected: boolean;
  playbackReady: boolean;
  playbackDateMs: number | null;
};

export type StreamPlaybackReadinessInput = StreamPlaybackTransportInput & {
  rendererReady: boolean;
};

/**
 * Proves only that telemetry and the HLS program-date playhead are advancing.
 *
 * Playback-aligned renderer authority is evaluated from the selected timeline
 * frame. Keeping that check separate from the latest capture-health bit lets a
 * viewer finish the already-buffered result while wagering remains fail-closed
 * against current renderer authority.
 */
export function isStreamPlaybackTransportReady(
  input: StreamPlaybackTransportInput,
): boolean {
  return Boolean(
    input.telemetryConnected &&
    input.playbackReady &&
    input.playbackDateMs !== null &&
    Number.isFinite(input.playbackDateMs),
  );
}

export function isStreamTransportPlaybackReady(
  input: StreamPlaybackReadinessInput,
): boolean {
  return isStreamPlaybackTransportReady(input) && input.rendererReady;
}

export function isAuthoritativeStreamPlaybackReady(
  input: StreamPlaybackReadinessInput & { presentationReady: boolean },
): boolean {
  return isStreamTransportPlaybackReady(input) && input.presentationReady;
}

/**
 * Chooses the next untried source in deterministic configured order. Once a
 * round has tried every source, callers must pause before starting a new round
 * from the primary source rather than hot-looping through dead endpoints.
 */
export function deriveStreamFailoverDecision(input: {
  currentSourceIndex: number;
  failedSourceIndexes: readonly number[];
  sourceCount: number;
}): StreamFailoverDecision {
  const sourceCount = Math.max(0, Math.floor(input.sourceCount));
  if (sourceCount === 0) {
    return {
      exhausted: true,
      failedSourceIndexes: [],
      nextSourceIndex: 0,
    };
  }
  const currentSourceIndex = Math.min(
    sourceCount - 1,
    Math.max(0, Math.floor(input.currentSourceIndex)),
  );
  const failed = new Set(
    input.failedSourceIndexes.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < sourceCount,
    ),
  );
  failed.add(currentSourceIndex);

  for (let offset = 1; offset < sourceCount; offset += 1) {
    const candidate = (currentSourceIndex + offset) % sourceCount;
    if (!failed.has(candidate)) {
      return {
        exhausted: false,
        failedSourceIndexes: [...failed].sort((left, right) => left - right),
        nextSourceIndex: candidate,
      };
    }
  }

  return {
    exhausted: true,
    failedSourceIndexes: [...failed].sort((left, right) => left - right),
    nextSourceIndex: 0,
  };
}
