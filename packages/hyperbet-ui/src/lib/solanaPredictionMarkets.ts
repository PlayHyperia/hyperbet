import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  normalizeSolanaPredictionMarketDuelKeyHex as normalizePredictionMarketDuelKeyHexFromRegistry,
  normalizeSolanaPredictionMarketLifecycleRecord as normalizePredictionMarketLifecycleRecord,
  normalizeSolanaPredictionMarketTimestamp as normalizePredictionMarketTimestamp,
  normalizeSolanaPredictionMarketWinner as normalizePredictionMarketWinner,
  type SolanaPredictionMarketLifecycleRecord as PredictionMarketLifecycleRecord,
  type SolanaPredictionMarketWinner as PredictionMarketWinner,
} from "./solanaLifecycle";

import { GAME_API_URL } from "./solanaConfig";

type BettingChainKey = "solana";

const ACTIVE_PREDICTION_MARKETS_URL = `${GAME_API_URL.replace(/\/$/, "")}/api/arena/prediction-markets/active`;
const OVERVIEW_PREDICTION_MARKETS_URL = `${GAME_API_URL.replace(/\/$/, "")}/api/arena/prediction-markets/overview`;
const SYNC_STATUS_URL = `${GAME_API_URL.replace(/\/$/, "")}/api/sync/status`;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const PREDICTION_MARKETS_MAX_FRESHNESS_MS = 30_000;
const PREDICTION_MARKETS_STREAM_MAX_FRESHNESS_MS = 15_000;

export type PredictionMarketsDuelSnapshot = {
  duelKey: string | null;
  duelId: string | null;
  phase: string | null;
  winner: PredictionMarketWinner;
  betCloseTime: number | null;
  syncedAt: number | null;
  agent1Name: string | null;
  agent2Name: string | null;
};

export type PredictionMarketsResponse = {
  duel: PredictionMarketsDuelSnapshot;
  markets: PredictionMarketLifecycleRecord[];
  updatedAt: number | null;
};

export type PredictionMarketsOverviewResponse = {
  live: PredictionMarketsResponse | null;
  recentSettlement: PredictionMarketsResponse | null;
  updatedAt: number | null;
};

export type PredictionMarketRendererHealth = {
  ready: boolean;
  degradedReason: string | null;
  updatedAt: number | null;
};

export type PredictionMarketSyncStatusResponse = {
  sourceEpoch: number | null;
  sourceLatestSeq: number | null;
  lastSeenSeq: number | null;
  lastAppliedSeq: number | null;
  applyLagMs: number | null;
  sourceEventAgeMs: number | null;
  replayMode: string | null;
  degradedReason: string | null;
  rendererHealth: PredictionMarketRendererHealth | null;
  rendererHealthAgeMs: number | null;
  lastEventReceivedAt: number | null;
  lastAppliedAt: number | null;
  connectedAt: number | null;
  enabled: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePredictionMarketInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
}

export const normalizePredictionMarketDuelKeyHex =
  normalizePredictionMarketDuelKeyHexFromRegistry;

function isCanonicalPredictionMarketPublicKey(value: string | null): boolean {
  if (value === null) return true;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function predictionMarketLifecycleIsCoherent(
  duel: PredictionMarketsDuelSnapshot,
  markets: readonly PredictionMarketLifecycleRecord[],
): boolean {
  if (markets.length > 1) return false;
  const market = markets[0];
  if (!market) return true;

  const requiresCompleteIdentity =
    market.lifecycleStatus !== "PENDING" &&
    market.lifecycleStatus !== "UNKNOWN";
  const resolvedWithWinner =
    market.lifecycleStatus === "RESOLVED"
      ? market.winner !== "NONE"
      : market.winner === "NONE";
  const winnerIsCoherent = (() => {
    if (market.lifecycleStatus === "RESOLVED") {
      return market.winner !== "NONE" && market.winner === duel.winner;
    }
    if (market.winner !== "NONE") return false;

    // The duel feed can publish its observed combat winner while the financial
    // market is locked, proposed, or challenged. The market must continue to
    // expose NONE until final resolution; treating those two truth domains as
    // identical would discard the authoritative dispute-window lifecycle.
    if (["LOCKED", "PROPOSED", "CHALLENGED"].includes(market.lifecycleStatus)) {
      return true;
    }
    return duel.winner === "NONE";
  })();

  return (
    market.duelKey === duel.duelKey &&
    market.duelId === duel.duelId &&
    market.betCloseTime === duel.betCloseTime &&
    market.marketId === market.marketRef &&
    market.contractAddress === null &&
    isCanonicalPredictionMarketPublicKey(market.marketId) &&
    isCanonicalPredictionMarketPublicKey(market.marketRef) &&
    isCanonicalPredictionMarketPublicKey(market.programId) &&
    resolvedWithWinner &&
    winnerIsCoherent &&
    (!requiresCompleteIdentity ||
      (market.duelKey !== null &&
        market.duelId !== null &&
        market.duelId.trim() === market.duelId &&
        market.duelId.length > 0 &&
        market.marketRef !== null &&
        market.programId !== null &&
        market.betCloseTime !== null))
  );
}

export function parsePredictionMarketsResponse(
  payload: unknown,
): PredictionMarketsResponse | null {
  const candidate = asRecord(payload);
  const duel = asRecord(candidate?.duel);
  if (!candidate || !duel || !Array.isArray(candidate.markets)) {
    return null;
  }

  const duelSnapshot: PredictionMarketsDuelSnapshot = {
    duelKey: normalizePredictionMarketDuelKeyHex(
      typeof duel.duelKey === "string" ? duel.duelKey : null,
    ),
    duelId: typeof duel.duelId === "string" ? duel.duelId : null,
    phase: typeof duel.phase === "string" ? duel.phase : null,
    winner: normalizePredictionMarketWinner(duel.winner),
    betCloseTime: normalizePredictionMarketTimestamp(duel.betCloseTime),
    syncedAt: normalizePredictionMarketTimestamp(duel.syncedAt),
    agent1Name: typeof duel.agent1Name === "string" ? duel.agent1Name : null,
    agent2Name: typeof duel.agent2Name === "string" ? duel.agent2Name : null,
  };
  const markets = candidate.markets
    .map((market) => normalizePredictionMarketLifecycleRecord(market))
    .filter(
      (market): market is PredictionMarketLifecycleRecord => market !== null,
    );
  if (!predictionMarketLifecycleIsCoherent(duelSnapshot, markets)) return null;

  return {
    duel: duelSnapshot,
    markets,
    updatedAt: normalizePredictionMarketTimestamp(candidate.updatedAt),
  };
}

function predictionMarketsResponseIsFresh(
  response: PredictionMarketsResponse,
  observedAt: number,
): boolean {
  const updatedAt = response.updatedAt;
  if (
    updatedAt === null ||
    Math.abs(updatedAt - observedAt) > PREDICTION_MARKETS_MAX_FRESHNESS_MS
  ) {
    return false;
  }
  const oldestAcceptedAt = observedAt - PREDICTION_MARKETS_MAX_FRESHNESS_MS;
  if (
    response.duel.syncedAt === null ||
    response.duel.syncedAt <
      observedAt - PREDICTION_MARKETS_STREAM_MAX_FRESHNESS_MS ||
    response.duel.syncedAt > updatedAt
  ) {
    return false;
  }
  return response.markets.every((market) => {
    if (market.syncedAt === null) {
      return (
        market.lifecycleStatus === "PENDING" ||
        market.lifecycleStatus === "UNKNOWN"
      );
    }
    return market.syncedAt >= oldestAcceptedAt && market.syncedAt <= updatedAt;
  });
}

export function parsePredictionMarketsOverviewResponse(
  payload: unknown,
): PredictionMarketsOverviewResponse | null {
  const candidate = asRecord(payload);
  if (!candidate) return null;

  const hasEnvelope =
    Object.prototype.hasOwnProperty.call(candidate, "live") ||
    Object.prototype.hasOwnProperty.call(candidate, "recentSettlement") ||
    Object.prototype.hasOwnProperty.call(candidate, "updatedAt");
  if (!hasEnvelope) return null;

  const live = candidate.live
    ? parsePredictionMarketsResponse(candidate.live)
    : null;
  const recentSettlement = candidate.recentSettlement
    ? parsePredictionMarketsResponse(candidate.recentSettlement)
    : null;

  return {
    live,
    recentSettlement,
    updatedAt: normalizePredictionMarketTimestamp(candidate.updatedAt),
  };
}

function parseRendererHealth(
  payload: unknown,
): PredictionMarketRendererHealth | null {
  const candidate = asRecord(payload);
  if (!candidate) return null;
  return {
    ready: candidate.ready === true,
    degradedReason:
      typeof candidate.degradedReason === "string"
        ? candidate.degradedReason
        : null,
    updatedAt: normalizePredictionMarketTimestamp(candidate.updatedAt),
  };
}

export function parsePredictionMarketSyncStatusResponse(
  payload: unknown,
): PredictionMarketSyncStatusResponse | null {
  const candidate = asRecord(payload);
  if (!candidate) return null;
  return {
    sourceEpoch: normalizePredictionMarketInteger(candidate.sourceEpoch),
    sourceLatestSeq: normalizePredictionMarketInteger(
      candidate.sourceLatestSeq,
    ),
    lastSeenSeq: normalizePredictionMarketInteger(candidate.lastSeenSeq),
    lastAppliedSeq: normalizePredictionMarketInteger(candidate.lastAppliedSeq),
    applyLagMs: normalizePredictionMarketTimestamp(candidate.applyLagMs),
    sourceEventAgeMs: normalizePredictionMarketTimestamp(
      candidate.sourceEventAgeMs,
    ),
    replayMode:
      typeof candidate.replayMode === "string" ? candidate.replayMode : null,
    degradedReason:
      typeof candidate.degradedReason === "string"
        ? candidate.degradedReason
        : null,
    rendererHealth: parseRendererHealth(candidate.rendererHealth),
    rendererHealthAgeMs: normalizePredictionMarketTimestamp(
      candidate.rendererHealthAgeMs,
    ),
    lastEventReceivedAt: normalizePredictionMarketTimestamp(
      candidate.lastEventReceivedAt,
    ),
    lastAppliedAt: normalizePredictionMarketTimestamp(candidate.lastAppliedAt),
    connectedAt: normalizePredictionMarketTimestamp(candidate.connectedAt),
    enabled: candidate.enabled !== false,
  };
}

export async function fetchActivePredictionMarkets(
  signal?: AbortSignal,
): Promise<PredictionMarketsResponse> {
  const response = await fetch(ACTIVE_PREDICTION_MARKETS_URL, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`prediction markets request failed (${response.status})`);
  }

  const parsed = parsePredictionMarketsResponse(await response.json());
  if (!parsed || !predictionMarketsResponseIsFresh(parsed, Date.now())) {
    throw new Error("prediction markets response was invalid");
  }

  return parsed;
}

async function fetchJsonWithFallback<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchPredictionMarketsOverview(
  signal?: AbortSignal,
): Promise<PredictionMarketsOverviewResponse> {
  const overviewPayload = await fetchJsonWithFallback<unknown>(
    OVERVIEW_PREDICTION_MARKETS_URL,
    signal,
  );
  const parsedOverview = overviewPayload
    ? parsePredictionMarketsOverviewResponse(overviewPayload)
    : null;
  if (parsedOverview) {
    return parsedOverview;
  }

  const live = await fetchActivePredictionMarkets(signal);
  return {
    live,
    recentSettlement: null,
    updatedAt: live.updatedAt,
  };
}

export async function fetchPredictionMarketSyncStatus(
  signal?: AbortSignal,
): Promise<PredictionMarketSyncStatusResponse | null> {
  const payload = await fetchJsonWithFallback<unknown>(SYNC_STATUS_URL, signal);
  if (!payload) return null;
  return parsePredictionMarketSyncStatusResponse(payload);
}

export function selectPredictionMarketLifecycleRecord(
  payload: PredictionMarketsResponse | null,
  chainKey: BettingChainKey | null,
): PredictionMarketLifecycleRecord | null {
  if (!payload || !chainKey) return null;
  return payload.markets.find((market) => market.chainKey === chainKey) ?? null;
}

export function selectPredictionMarketOverviewRecord(
  payload: PredictionMarketsOverviewResponse | null,
  chainKey: BettingChainKey | null,
  surface: "live" | "recentSettlement" = "live",
): PredictionMarketLifecycleRecord | null {
  if (!payload) return null;
  return selectPredictionMarketLifecycleRecord(payload[surface], chainKey);
}

export function usePredictionMarketLifecycle(
  chainKey: BettingChainKey | null,
  options: {
    disabled?: boolean;
    pollIntervalMs?: number;
  } = {},
) {
  const { disabled = false, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } =
    options;
  const [data, setData] = useState<PredictionMarketsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestRevisionRef = useRef(0);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (disabled || !chainKey) return null;
      const requestRevision = ++requestRevisionRef.current;
      setIsLoading(true);
      try {
        const nextData = await fetchActivePredictionMarkets(signal);
        if (signal?.aborted || requestRevision !== requestRevisionRef.current) {
          return null;
        }
        setData(nextData);
        setError(null);
        return nextData;
      } catch (refreshError) {
        if (
          !signal?.aborted &&
          requestRevision === requestRevisionRef.current
        ) {
          setData(null);
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "prediction markets refresh failed",
          );
        }
        return null;
      } finally {
        if (
          !signal?.aborted &&
          requestRevision === requestRevisionRef.current
        ) {
          setIsLoading(false);
        }
      }
    },
    [chainKey, disabled],
  );

  useEffect(() => {
    if (disabled || !chainKey) {
      requestRevisionRef.current += 1;
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    let activePollController = new AbortController();
    void refresh(activePollController.signal);
    const intervalId = window.setInterval(() => {
      activePollController.abort();
      activePollController = new AbortController();
      void refresh(activePollController.signal);
    }, pollIntervalMs);

    return () => {
      activePollController.abort();
      window.clearInterval(intervalId);
    };
  }, [chainKey, disabled, pollIntervalMs, refresh]);

  const market = useMemo(
    () => selectPredictionMarketLifecycleRecord(data, chainKey),
    [chainKey, data],
  );

  return {
    data,
    duel: data?.duel ?? null,
    market,
    isLoading,
    error,
    refresh,
  };
}

export function usePredictionMarketOverview(
  chainKey: BettingChainKey | null,
  options: {
    disabled?: boolean;
    pollIntervalMs?: number;
  } = {},
) {
  const { disabled = false, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } =
    options;
  const [data, setData] = useState<PredictionMarketsOverviewResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (disabled || !chainKey) return null;
      setIsLoading(true);
      try {
        const nextData = await fetchPredictionMarketsOverview(signal);
        setData(nextData);
        setError(null);
        return nextData;
      } catch (refreshError) {
        if (!signal?.aborted) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "prediction markets overview refresh failed",
          );
        }
        return null;
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [chainKey, disabled],
  );

  useEffect(() => {
    if (disabled || !chainKey) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    let activePollController: AbortController | null = null;
    void refresh(controller.signal);
    const intervalId = window.setInterval(() => {
      activePollController?.abort();
      activePollController = new AbortController();
      void refresh(activePollController.signal);
    }, pollIntervalMs);

    return () => {
      controller.abort();
      activePollController?.abort();
      window.clearInterval(intervalId);
    };
  }, [chainKey, disabled, pollIntervalMs, refresh]);

  const live = useMemo(
    () => selectPredictionMarketOverviewRecord(data, chainKey, "live"),
    [chainKey, data],
  );
  const recentSettlement = useMemo(
    () =>
      selectPredictionMarketOverviewRecord(data, chainKey, "recentSettlement"),
    [chainKey, data],
  );

  return {
    data,
    live,
    recentSettlement,
    liveDuel: data?.live?.duel ?? null,
    recentSettlementDuel: data?.recentSettlement?.duel ?? null,
    liveMarket: live,
    recentSettlementMarket: recentSettlement,
    isLoading,
    error,
    refresh,
  };
}

export function usePredictionMarketSyncStatus(
  options: {
    disabled?: boolean;
    pollIntervalMs?: number;
  } = {},
) {
  const { disabled = false, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } =
    options;
  const [data, setData] = useState<PredictionMarketSyncStatusResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (disabled) return null;
      try {
        const nextData = await fetchPredictionMarketSyncStatus(signal);
        setData(nextData);
        setError(null);
        return nextData;
      } catch (refreshError) {
        if (!signal?.aborted) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "prediction market sync status refresh failed",
          );
        }
        return null;
      }
    },
    [disabled],
  );

  useEffect(() => {
    if (disabled) {
      setData(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let activePollController: AbortController | null = null;
    void refresh(controller.signal);
    const intervalId = window.setInterval(() => {
      activePollController?.abort();
      activePollController = new AbortController();
      void refresh(activePollController.signal);
    }, pollIntervalMs);

    return () => {
      controller.abort();
      activePollController?.abort();
      window.clearInterval(intervalId);
    };
  }, [disabled, pollIntervalMs, refresh]);

  return {
    data,
    error,
    refresh,
  };
}
