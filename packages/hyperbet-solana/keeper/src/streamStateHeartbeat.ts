type RendererHealth = {
  updatedAt?: unknown;
  [key: string]: unknown;
};

type HeartbeatStreamState = {
  emittedAt?: unknown;
  cycle: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Refreshes only transport-liveness timestamps for the synthetic E2E stream.
 * Existing renderer authority is carried forward, but missing or degraded
 * renderer health is never promoted to ready by a heartbeat.
 */
export function refreshSyntheticStreamHeartbeat<
  State extends HeartbeatStreamState,
>(state: State, nowMs = Date.now()): State {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("synthetic stream heartbeat time must be a positive integer");
  }

  const rendererHealth = state.cycle.rendererHealth;
  const refreshedRendererHealth =
    rendererHealth && typeof rendererHealth === "object"
      ? {
          ...(rendererHealth as RendererHealth),
          updatedAt: nowMs,
        }
      : rendererHealth;

  return {
    ...state,
    emittedAt: nowMs,
    cycle: {
      ...state.cycle,
      rendererHealth: refreshedRendererHealth,
    },
  };
}
