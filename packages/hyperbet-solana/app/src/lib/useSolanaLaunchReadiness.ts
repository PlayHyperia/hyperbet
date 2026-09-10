import { useCallback, useEffect, useState } from "react";

import { GAME_API_URL } from "./config";

const READINESS_URL = `${GAME_API_URL.replace(/\/$/, "")}/ready`;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_AGE_MS = 15_000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 5_000;

type SolanaLaunchReadinessState = {
  checked: boolean;
  ready: boolean;
};

type SolanaLaunchReadinessTiming = {
  nowMs: number;
  maxAgeMs: number;
  maxFutureSkewMs: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseSolanaLaunchReadiness(
  payload: unknown,
  timing?: SolanaLaunchReadinessTiming,
): boolean {
  const envelope = asRecord(payload);
  const readiness = asRecord(envelope?.readiness);
  const emittedAtMs = envelope?.now;
  const structurallyReady =
    envelope?.ok === true &&
    envelope.service === "hyperbet-solana-backend" &&
    typeof emittedAtMs === "number" &&
    Number.isFinite(emittedAtMs) &&
    emittedAtMs > 0 &&
    readiness?.ready === true;

  if (!structurallyReady) return false;
  if (!timing) return true;
  if (
    !Number.isFinite(timing.nowMs) ||
    !Number.isFinite(timing.maxAgeMs) ||
    !Number.isFinite(timing.maxFutureSkewMs) ||
    timing.maxAgeMs < 0 ||
    timing.maxFutureSkewMs < 0
  ) {
    return false;
  }

  const ageMs = timing.nowMs - emittedAtMs;
  return ageMs <= timing.maxAgeMs && ageMs >= -timing.maxFutureSkewMs;
}

export function useSolanaLaunchReadiness(
  options: {
    pollIntervalMs?: number;
    requestTimeoutMs?: number;
    enabled?: boolean;
  } = {},
): SolanaLaunchReadinessState {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = Math.max(
    1,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const [state, setState] = useState<SolanaLaunchReadinessState>({
    checked: !enabled,
    ready: false,
  });

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      signal?.addEventListener("abort", abortRequest, { once: true });
      const timeoutId = window.setTimeout(abortRequest, requestTimeoutMs);

      try {
        const response = await fetch(READINESS_URL, {
          cache: "no-store",
          signal: requestController.signal,
        });
        const payload = await response.json();
        if (!signal?.aborted && !requestController.signal.aborted) {
          setState({
            checked: true,
            ready:
              response.ok &&
              parseSolanaLaunchReadiness(payload, {
                nowMs: Date.now(),
                maxAgeMs: DEFAULT_MAX_AGE_MS,
                maxFutureSkewMs: DEFAULT_MAX_FUTURE_SKEW_MS,
              }),
          });
        }
      } catch {
        if (!signal?.aborted) {
          setState({ checked: true, ready: false });
        }
      } finally {
        window.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortRequest);
      }
    },
    [requestTimeoutMs],
  );

  useEffect(() => {
    if (!enabled) {
      setState({ checked: true, ready: false });
      return;
    }

    let activeController: AbortController | null = null;
    const poll = () => {
      activeController?.abort();
      activeController = new AbortController();
      void refresh(activeController.signal);
    };

    poll();
    const intervalId = window.setInterval(() => {
      poll();
    }, pollIntervalMs);

    return () => {
      activeController?.abort();
      window.clearInterval(intervalId);
    };
  }, [enabled, pollIntervalMs, refresh]);

  return state;
}
