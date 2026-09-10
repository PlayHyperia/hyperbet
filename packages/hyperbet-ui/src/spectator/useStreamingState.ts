import { useCallback, useEffect, useRef, useState } from "react";

import { GAME_API_URL, UI_SYNC_DELAY_MS } from "../lib/solanaConfig";
import type { RendererHealthInfo, StreamingStateUpdate } from "./types";

const DEFAULT_FALLBACK_POLL_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_SSE_FRAME_TIMEOUT_MS = 10_000;
const DEFAULT_RENDERER_HEALTH_MAX_AGE_MS = 15_000;
const DEFAULT_PLAYBACK_PRESENTATION_LAG_MS = 250;
const MAX_TIMELINE_STATES = 512;

type AuthorityState = StreamingStateUpdate & { seq: number; emittedAt: number };
type RendererRevocation = {
  seq: number;
  emittedAt: number;
  healthUpdatedAt: number;
  epoch: number;
};

function isCanonicalTimestamp(
  value: unknown,
  nowMs = Date.now(),
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= nowMs
  );
}

function hasSameDuelIdentity(a: AuthorityState, b: AuthorityState): boolean {
  return (
    typeof a.cycle.cycleId === "string" &&
    a.cycle.cycleId.length > 0 &&
    typeof a.cycle.duelId === "string" &&
    a.cycle.duelId.length > 0 &&
    typeof a.cycle.duelKeyHex === "string" &&
    /^[a-f0-9]{64}$/.test(a.cycle.duelKeyHex) &&
    a.cycle.cycleId === b.cycle.cycleId &&
    a.cycle.duelId === b.cycle.duelId &&
    a.cycle.duelKeyHex === b.cycle.duelKeyHex
  );
}

type SseSource = {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close: () => void;
  addEventListener: (
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ) => void;
};

export interface StreamingStateOptions {
  disabled?: boolean;
  apiUrl?: string;
  uiSyncDelayMs?: number;
  fallbackPollIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  sseFrameTimeoutMs?: number;
  rendererHealthMaxAgeMs?: number;
  presentationTimeMs?: number | null;
  playbackPresentationLagMs?: number;
}

export function selectStreamingStateForPlayback(
  states: readonly StreamingStateUpdate[],
  playbackDateMs: number,
  presentationLagMs = DEFAULT_PLAYBACK_PRESENTATION_LAG_MS,
): StreamingStateUpdate | null {
  if (!Number.isFinite(playbackDateMs)) return null;
  // A source frame is timestamped before it crosses the network, commits to
  // React, paints in Chromium, and enters the capture encoder. Keep the rail a
  // bounded quarter-second behind the HLS program date so it never reveals a hit
  // before that hit is actually visible in the video.
  const cutoff = playbackDateMs - Math.max(0, presentationLagMs);
  let selected: StreamingStateUpdate | null = null;
  for (const state of states) {
    const emittedAt = state.emittedAt;
    if (
      typeof emittedAt !== "number" ||
      !Number.isFinite(emittedAt) ||
      emittedAt > cutoff
    ) {
      continue;
    }
    if (
      !selected ||
      emittedAt > (selected.emittedAt ?? Number.NEGATIVE_INFINITY) ||
      (emittedAt === selected.emittedAt &&
        (state.seq ?? Number.NEGATIVE_INFINITY) >
          (selected.seq ?? Number.NEGATIVE_INFINITY))
    ) {
      selected = state;
    }
  }
  return selected;
}

export function getStreamingReconnectDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_RECONNECT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
  jitterRatio = DEFAULT_RECONNECT_JITTER_RATIO,
  randomValue = Math.random(),
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const safeBase = Math.max(0, baseDelayMs);
  const safeMax = Math.max(safeBase, maxDelayMs);
  const exponentialDelay = Math.min(
    safeMax,
    safeBase * 2 ** Math.min(safeAttempt, 30),
  );
  const safeJitter = Math.min(1, Math.max(0, jitterRatio));
  const normalizedRandom = Math.min(1, Math.max(0, randomValue));
  const jitterMultiplier = 1 + (normalizedRandom * 2 - 1) * safeJitter;
  return Math.max(0, Math.round(exponentialDelay * jitterMultiplier));
}

export function isStreamingRendererHealthReady(
  health: RendererHealthInfo | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_RENDERER_HEALTH_MAX_AGE_MS,
): boolean {
  if (
    health?.ready !== true ||
    health.degradedReason !== null ||
    !isCanonicalTimestamp(health.updatedAt, nowMs)
  ) {
    return false;
  }
  return Math.max(0, nowMs - health.updatedAt) <= Math.max(0, maxAgeMs);
}

function normalizeState(payload: unknown): AuthorityState | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Partial<StreamingStateUpdate> & {
    cycle?: unknown;
    leaderboard?: unknown;
  };
  if (
    !candidate.cycle ||
    typeof candidate.cycle !== "object" ||
    Array.isArray(candidate.cycle) ||
    !Array.isArray(candidate.leaderboard) ||
    typeof candidate.seq !== "number" ||
    !Number.isSafeInteger(candidate.seq) ||
    candidate.seq < 0 ||
    !isCanonicalTimestamp(candidate.emittedAt)
  )
    return null;
  return {
    type: "STREAMING_STATE_UPDATE",
    cycle: candidate.cycle as StreamingStateUpdate["cycle"],
    leaderboard: candidate.leaderboard as StreamingStateUpdate["leaderboard"],
    cameraTarget:
      typeof candidate.cameraTarget === "string" ||
      candidate.cameraTarget === null
        ? candidate.cameraTarget
        : null,
    preparation: candidate.preparation ?? null,
    seq: candidate.seq,
    emittedAt: candidate.emittedAt,
  };
}

export function useStreamingState(options: StreamingStateOptions = {}) {
  const {
    disabled = false,
    apiUrl = GAME_API_URL,
    uiSyncDelayMs = UI_SYNC_DELAY_MS,
    fallbackPollIntervalMs = DEFAULT_FALLBACK_POLL_INTERVAL_MS,
    reconnectBaseDelayMs = DEFAULT_RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
    reconnectJitterRatio = DEFAULT_RECONNECT_JITTER_RATIO,
    sseFrameTimeoutMs = DEFAULT_SSE_FRAME_TIMEOUT_MS,
    rendererHealthMaxAgeMs = DEFAULT_RENDERER_HEALTH_MAX_AGE_MS,
    presentationTimeMs = null,
    playbackPresentationLagMs = DEFAULT_PLAYBACK_PRESENTATION_LAG_MS,
  } = options;
  const normalizedApiUrl = apiUrl.replace(/\/$/, "");
  const sseUrl = `${normalizedApiUrl}/api/streaming/state/events`;
  const pollUrl = `${normalizedApiUrl}/api/streaming/state`;

  const [state, setState] = useState<StreamingStateUpdate | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [currentState, setCurrentState] = useState<StreamingStateUpdate | null>(
    null,
  );
  const [isCurrentConnected, setIsCurrentConnected] = useState(false);
  const [isRendererReady, setIsRendererReady] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseFrameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSourceRef = useRef<SseSource | null>(null);
  const lastEventIdRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const connectionEpochRef = useRef(0);
  const authorityStateRef = useRef<AuthorityState | null>(null);
  const authorityStateEpochRef = useRef(0);
  const authorityHealthUpdatedAtRef = useRef<number | null>(null);
  const authorityAvailableRef = useRef(false);
  const authorityRevisionRef = useRef(0);
  const rendererRevocationRef = useRef<RendererRevocation | null>(null);
  const closedRef = useRef(false);
  const connectSseRef = useRef<() => void>(() => {});
  const delayedUpdatesRef = useRef<Set<ReturnType<typeof setTimeout>>>(
    new Set(),
  );
  const timelineStatesRef = useRef<StreamingStateUpdate[]>([]);
  const presentationTimeRef = useRef<number | null>(null);
  const presentationEpochRef = useRef(0);

  presentationTimeRef.current =
    typeof presentationTimeMs === "number" &&
    Number.isFinite(presentationTimeMs) &&
    presentationTimeMs > 0
      ? presentationTimeMs
      : null;

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearSseFrameTimer = useCallback(() => {
    if (sseFrameTimerRef.current) {
      clearTimeout(sseFrameTimerRef.current);
      sseFrameTimerRef.current = null;
    }
  }, []);

  const clearDelayedUpdates = useCallback(() => {
    for (const timer of delayedUpdatesRef.current) {
      clearTimeout(timer);
    }
    delayedUpdatesRef.current.clear();
  }, []);

  const markDisconnected = useCallback(() => {
    connectionEpochRef.current += 1;
    authorityAvailableRef.current = false;
    presentationEpochRef.current = connectionEpochRef.current;
    clearDelayedUpdates();
    setIsConnected(false);
    setIsCurrentConnected(false);
    setIsRendererReady(false);
  }, [clearDelayedUpdates]);

  const commitPlaybackSynchronizedState = useCallback(() => {
    const playbackDateMs = presentationTimeRef.current;
    if (playbackDateMs === null) return false;
    const selected = selectStreamingStateForPlayback(
      timelineStatesRef.current,
      playbackDateMs,
      playbackPresentationLagMs,
    );
    if (!selected) return false;
    if (
      closedRef.current ||
      presentationEpochRef.current !== connectionEpochRef.current
    ) {
      return false;
    }
    setState(selected);
    setIsConnected(true);
    return true;
  }, [playbackPresentationLagMs]);

  const appendTimelineState = useCallback(
    (nextState: StreamingStateUpdate) => {
      const epoch = connectionEpochRef.current;
      presentationEpochRef.current = epoch;
      timelineStatesRef.current.push(nextState);
      if (timelineStatesRef.current.length > MAX_TIMELINE_STATES) {
        timelineStatesRef.current =
          timelineStatesRef.current.slice(-MAX_TIMELINE_STATES);
      }
      if (presentationTimeRef.current === null) return;
      clearDelayedUpdates();
      commitPlaybackSynchronizedState();
    },
    [clearDelayedUpdates, commitPlaybackSynchronizedState],
  );

  useEffect(() => {
    if (presentationTimeRef.current === null) return;
    clearDelayedUpdates();
    commitPlaybackSynchronizedState();
  }, [
    clearDelayedUpdates,
    commitPlaybackSynchronizedState,
    presentationTimeMs,
  ]);

  const applyState = useCallback(
    (nextState: AuthorityState) => {
      if (closedRef.current) return false;
      const current = authorityStateRef.current;
      const wasAvailable = authorityAvailableRef.current;
      // Match the producer's epoch contract: only an observed disconnect plus
      // strictly newer time permits a restarted sequence. A reset event alone
      // does not authorize a rollback, nor does a late REST response.
      if (
        current &&
        (wasAvailable
          ? nextState.seq < current.seq ||
            nextState.emittedAt < current.emittedAt
          : nextState.emittedAt <= current.emittedAt)
      )
        return false;
      let revocation = rendererRevocationRef.current;
      let sameRevocationEpoch =
        revocation?.epoch === connectionEpochRef.current;
      if (
        revocation &&
        (nextState.emittedAt < revocation.emittedAt ||
          (sameRevocationEpoch && nextState.seq < revocation.seq))
      )
        return false;
      if (
        current &&
        wasAvailable &&
        nextState.seq === current.seq &&
        nextState.emittedAt === current.emittedAt
      ) {
        // Duplicate heartbeats may keep transport alive, but conflicting data
        // with the same cursor cannot mutate or restore current authority.
        return true;
      }
      const health = nextState.cycle.rendererHealth;
      const currentHealthAt = authorityHealthUpdatedAtRef.current;
      if (
        isCanonicalTimestamp(currentHealthAt) &&
        isCanonicalTimestamp(health?.updatedAt) &&
        health.updatedAt < currentHealthAt
      )
        return false;
      lastEventIdRef.current = wasAvailable
        ? Math.max(lastEventIdRef.current, nextState.seq)
        : nextState.seq;
      authorityStateRef.current = nextState;
      authorityStateEpochRef.current = connectionEpochRef.current;
      authorityAvailableRef.current = true;
      authorityRevisionRef.current += 1;
      const rendererHealthReady = isStreamingRendererHealthReady(
        health,
        Date.now(),
        rendererHealthMaxAgeMs,
      );
      // A missing/malformed health field must not erase the last canonical
      // freshness floor. It revokes confidence, but cannot supply a timestamp
      // that poisons recovery. Reuse the last known floor until new health is
      // positively verified; retain it across producer/transport restarts.
      if (isCanonicalTimestamp(health?.updatedAt)) {
        authorityHealthUpdatedAtRef.current = health.updatedAt;
      }
      const revokedHealthAt = authorityHealthUpdatedAtRef.current;
      // Semantically unready current authority (including contradictory ready
      // flags) has the same recovery barrier as a negative timeline frame.
      if (
        !rendererHealthReady &&
        isCanonicalTimestamp(revokedHealthAt) &&
        (!revocation || revokedHealthAt >= revocation.healthUpdatedAt)
      ) {
        revocation = {
          seq: nextState.seq,
          emittedAt: nextState.emittedAt,
          healthUpdatedAt: revokedHealthAt,
          epoch: connectionEpochRef.current,
        };
        rendererRevocationRef.current = revocation;
        sameRevocationEpoch = true;
      }

      setIsRendererReady(
        rendererHealthReady &&
          (!revocation ||
            (nextState.emittedAt > revocation.emittedAt &&
              (!sameRevocationEpoch || nextState.seq > revocation.seq) &&
              isCanonicalTimestamp(health?.updatedAt) &&
              health.updatedAt > revocation.healthUpdatedAt)),
      );
      // Keep the latest accepted authority separate from the HLS-aligned
      // presentation state below. Wagering must use this wall-clock source;
      // replaying an older decoded frame must never make a current quote stale
      // or, conversely, reopen a market that has already closed.
      setCurrentState(nextState);
      setIsCurrentConnected(true);

      const epoch = connectionEpochRef.current;
      appendTimelineState(nextState);
      if (presentationTimeRef.current !== null) {
        return true;
      }
      const commit = () => {
        if (closedRef.current || epoch !== connectionEpochRef.current) return;
        setState(nextState);
        setIsConnected(true);
      };

      if (uiSyncDelayMs <= 0) {
        commit();
        return true;
      }

      const timer = setTimeout(() => {
        delayedUpdatesRef.current.delete(timer);
        commit();
      }, uiSyncDelayMs);
      delayedUpdatesRef.current.add(timer);
      return true;
    },
    [appendTimelineState, rendererHealthMaxAgeMs, uiSyncDelayMs],
  );

  const poll = useCallback(async () => {
    if (closedRef.current) return;
    const epoch = connectionEpochRef.current;
    const revision = authorityRevisionRef.current;
    const isCurrentRequest = () =>
      !closedRef.current && epoch === connectionEpochRef.current;
    try {
      const response = await fetch(pollUrl, { cache: "no-store" });
      if (!isCurrentRequest()) return;
      if (!response.ok) throw new Error("stream state unavailable");
      const nextState = normalizeState(await response.json());
      if (!isCurrentRequest()) return;
      if (!nextState) throw new Error("stream state malformed");
      applyState(nextState);
    } catch {
      // A subsequently accepted SSE frame supersedes this request's liveness
      // evidence too: an old failed poll must not disconnect a recovered feed.
      if (isCurrentRequest() && revision === authorityRevisionRef.current)
        markDisconnected();
    }
  }, [applyState, markDisconnected, pollUrl]);

  const startFallbackPolling = useCallback(() => {
    if (pollTimerRef.current || closedRef.current) return;
    void poll();
    pollTimerRef.current = setInterval(
      () => {
        void poll();
      },
      Math.max(50, fallbackPollIntervalMs),
    );
  }, [fallbackPollIntervalMs, poll]);

  const scheduleReconnect = useCallback(() => {
    if (closedRef.current || reconnectTimerRef.current) return;
    const delayMs = getStreamingReconnectDelayMs(
      reconnectAttemptRef.current,
      reconnectBaseDelayMs,
      reconnectMaxDelayMs,
      reconnectJitterRatio,
    );
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectSseRef.current();
    }, delayMs);
  }, [reconnectBaseDelayMs, reconnectJitterRatio, reconnectMaxDelayMs]);

  const connectSse = useCallback(() => {
    if (
      closedRef.current ||
      eventSourceRef.current ||
      typeof window === "undefined" ||
      typeof window.EventSource === "undefined"
    ) {
      if (
        !closedRef.current &&
        (typeof window === "undefined" ||
          typeof window.EventSource === "undefined")
      ) {
        startFallbackPolling();
      }
      return;
    }

    clearReconnectTimer();
    const sseBaseUrl =
      window.location.origin && window.location.origin !== "null"
        ? window.location.origin
        : window.location.href;
    const url = new URL(sseUrl, sseBaseUrl);
    if (lastEventIdRef.current > 0) {
      url.searchParams.set("since", String(lastEventIdRef.current));
    }

    let source: SseSource;
    try {
      source = new window.EventSource(url.toString()) as unknown as SseSource;
    } catch {
      markDisconnected();
      startFallbackPolling();
      scheduleReconnect();
      return;
    }
    eventSourceRef.current = source;

    const failSource = () => {
      if (eventSourceRef.current !== source) return;
      clearSseFrameTimer();
      source.close();
      eventSourceRef.current = null;
      markDisconnected();
      startFallbackPolling();
      scheduleReconnect();
    };

    const armSseFrameTimeout = () => {
      clearSseFrameTimer();
      sseFrameTimerRef.current = setTimeout(
        failSource,
        Math.max(250, sseFrameTimeoutMs),
      );
    };

    const acceptEvent = (event: MessageEvent<string>) => {
      if (eventSourceRef.current !== source) return;
      try {
        const nextState = normalizeState(JSON.parse(event.data));
        if (!nextState) return;
        if (!applyState(nextState)) return;
        armSseFrameTimeout();
        reconnectAttemptRef.current = 0;
        clearPollTimer();
      } catch {
        // A malformed frame has no authority. Keep waiting for a valid frame.
      }
    };

    const acceptTimelineEvent = (event: MessageEvent<string>) => {
      if (eventSourceRef.current !== source) return;
      try {
        const nextState = normalizeState(JSON.parse(event.data));
        if (!nextState) return;
        lastEventIdRef.current = Math.max(
          lastEventIdRef.current,
          nextState.seq,
        );
        const current = authorityStateRef.current;
        const health = nextState.cycle.rendererHealth;
        const currentHealth = current?.cycle.rendererHealth;
        const currentHealthAt = authorityHealthUpdatedAtRef.current;
        const previous = rendererRevocationRef.current;
        // Replay can withdraw confidence, never grant it. Only forward,
        // explicitly negative health for the exact current duel may latch.
        // Missing optional identity is presentation-only, not authority.
        if (
          current &&
          hasSameDuelIdentity(current, nextState) &&
          nextState.seq >= current.seq &&
          nextState.emittedAt >= current.emittedAt &&
          (nextState.seq > current.seq ||
            nextState.emittedAt > current.emittedAt) &&
          health?.ready === false &&
          isCanonicalTimestamp(health.updatedAt) &&
          (health.degradedReason === null ||
            typeof health.degradedReason === "string") &&
          (!isCanonicalTimestamp(currentHealthAt) ||
            (currentHealth?.ready === true
              ? health.updatedAt > currentHealthAt
              : health.updatedAt >= currentHealthAt)) &&
          (!previous ||
            (nextState.emittedAt >= previous.emittedAt &&
              health.updatedAt >= previous.healthUpdatedAt &&
              (previous.epoch !== authorityStateEpochRef.current ||
                nextState.seq >= previous.seq)))
        ) {
          rendererRevocationRef.current = {
            seq: nextState.seq,
            emittedAt: nextState.emittedAt,
            healthUpdatedAt: health.updatedAt,
            // A replay before the new authority reset still belongs to the
            // matched old producer epoch, not the replacement transport.
            epoch: authorityStateEpochRef.current,
          };
          authorityRevisionRef.current += 1;
          setIsRendererReady(false);
        }
        armSseFrameTimeout();
        reconnectAttemptRef.current = 0;
        clearPollTimer();
        appendTimelineState(nextState);
      } catch {
        // A malformed timeline frame has no presentation authority.
      }
    };

    source.onopen = () => {
      // Transport establishment alone does not authorize stale duel state.
      // A valid state/reset frame below is the readiness boundary.
    };
    source.addEventListener("state", acceptEvent);
    source.addEventListener("reset", acceptEvent);
    source.addEventListener("timeline", acceptTimelineEvent);
    source.addEventListener("unavailable", () => {
      if (eventSourceRef.current !== source) return;
      armSseFrameTimeout();
      reconnectAttemptRef.current = 0;
      markDisconnected();
      startFallbackPolling();
    });
    source.onerror = failSource;

    armSseFrameTimeout();
  }, [
    appendTimelineState,
    applyState,
    clearPollTimer,
    clearReconnectTimer,
    clearSseFrameTimer,
    markDisconnected,
    scheduleReconnect,
    sseFrameTimeoutMs,
    sseUrl,
    startFallbackPolling,
  ]);
  connectSseRef.current = connectSse;

  useEffect(() => {
    closedRef.current = false;
    markDisconnected();
    if (!disabled) {
      connectSse();
    } else {
      clearPollTimer();
      clearReconnectTimer();
      clearSseFrameTimer();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }

    return () => {
      closedRef.current = true;
      connectionEpochRef.current += 1;
      authorityAvailableRef.current = false;
      clearDelayedUpdates();
      clearPollTimer();
      clearReconnectTimer();
      clearSseFrameTimer();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [
    clearDelayedUpdates,
    clearPollTimer,
    clearReconnectTimer,
    clearSseFrameTimer,
    connectSse,
    disabled,
    markDisconnected,
  ]);

  return {
    state,
    isConnected,
    currentState,
    isCurrentConnected,
    isRendererReady,
  };
}
