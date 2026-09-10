import type { KeeperOperatorMetrics } from "./keeperOperatorMetrics";

const STREAM_RUNTIME_CHECKS = [
  "schedulerAuthority",
  "bettingFeed",
  "renderer",
  "captureClient",
  "encoder",
  "audio",
  "rtmpDelivery",
  "keeper",
  "projectileCostCustody",
] as const;

type StreamRuntimeCheck = (typeof STREAM_RUNTIME_CHECKS)[number];

export type StreamingOperatorMetrics = {
  schemaVersion: 1;
  observedAtMs: number;
  ready: boolean;
  agesMs: Record<StreamRuntimeCheck, number | null>;
  frames: {
    rendererSamples: number;
    rendererEstimatedFps: number | null;
    rendererFrameIntervalP95Ms: number | null;
    rendererFrameWorkP95Ms: number | null;
    rendererLongFrameCount: number;
    captureTargetFps: number | null;
    captureMeasuredFps: number | null;
    encoderReportedFps: number | null;
    droppedFrames: number;
  };
};

export type StreamingOperatorSourceConfig = {
  sourceUrl: string;
  bearerToken: string;
  timeoutMs: number;
};

export type StreamingOperatorFailureCode =
  "http-status" | "invalid-payload" | "network" | "timeout";

export class StreamingOperatorTransportError extends Error {
  readonly code: StreamingOperatorFailureCode;

  constructor(code: StreamingOperatorFailureCode) {
    super(`stream operator health transport failed: ${code}`);
    this.name = "StreamingOperatorTransportError";
    this.code = code;
  }
}

export const FEDERATED_OPERATOR_ALERT_CODES = [
  "service-readiness-failed",
  "stream-operations-unavailable",
  "stream-operations-stale",
  "stream-operations-clock-skew",
  "stream-runtime-unready",
  "keeper-operations-unavailable",
  "keeper-operations-stale",
  "keeper-operations-clock-skew",
  "keeper-feed-unavailable",
  "keeper-feed-degraded",
  "terminal-manual-review",
  "terminal-dead-letter",
  "claim-timing-invalid",
] as const;

export type FederatedOperatorAlertCode =
  (typeof FEDERATED_OPERATOR_ALERT_CODES)[number];

export type FederatedOperatorReadiness = {
  schemaVersion: 1;
  observedAtMs: number;
  ready: boolean;
  sourceAgesMs: {
    stream: number | null;
    keeper: number | null;
  };
  alerts: Array<{
    code: FederatedOperatorAlertCode;
    severity: "critical";
    source: "service" | "stream" | "keeper";
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableMetric(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function sourceAgeMs(nowMs: number, observedAtMs: number): number {
  return Math.max(0, nowMs - observedAtMs);
}

const MAX_SOURCE_FUTURE_SKEW_MS = 5_000;

export function parseStreamingOperatorMetrics(
  value: unknown,
): StreamingOperatorMetrics | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isCount(value.observedAtMs) ||
    typeof value.ready !== "boolean" ||
    !isRecord(value.agesMs) ||
    !isRecord(value.frames)
  ) {
    return null;
  }

  const agesMs = value.agesMs;
  if (
    STREAM_RUNTIME_CHECKS.some(
      (checkName) => !isNullableMetric(agesMs[checkName]),
    )
  ) {
    return null;
  }

  const frames = value.frames;
  if (
    !isCount(frames.rendererSamples) ||
    !isNullableMetric(frames.rendererEstimatedFps) ||
    !isNullableMetric(frames.rendererFrameIntervalP95Ms) ||
    !isNullableMetric(frames.rendererFrameWorkP95Ms) ||
    !isCount(frames.rendererLongFrameCount) ||
    !isNullableMetric(frames.captureTargetFps) ||
    !isNullableMetric(frames.captureMeasuredFps) ||
    !isNullableMetric(frames.encoderReportedFps) ||
    !isCount(frames.droppedFrames) ||
    (frames.rendererSamples === 0) !== (frames.rendererEstimatedFps === null) ||
    Number(frames.rendererLongFrameCount) > Number(frames.rendererSamples)
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    observedAtMs: value.observedAtMs,
    ready: value.ready,
    agesMs: Object.fromEntries(
      STREAM_RUNTIME_CHECKS.map((checkName) => [
        checkName,
        agesMs[checkName] as number | null,
      ]),
    ) as Record<StreamRuntimeCheck, number | null>,
    frames: {
      rendererSamples: frames.rendererSamples,
      rendererEstimatedFps: frames.rendererEstimatedFps,
      rendererFrameIntervalP95Ms: frames.rendererFrameIntervalP95Ms,
      rendererFrameWorkP95Ms: frames.rendererFrameWorkP95Ms,
      rendererLongFrameCount: frames.rendererLongFrameCount,
      captureTargetFps: frames.captureTargetFps,
      captureMeasuredFps: frames.captureMeasuredFps,
      encoderReportedFps: frames.encoderReportedFps,
      droppedFrames: frames.droppedFrames,
    },
  };
}

export function resolveStreamingOperatorSourceConfig(input: {
  production: boolean;
  streamStateSourceUrl?: string;
  sourceUrl?: string;
  bearerToken?: string;
  timeoutMs?: number;
}): StreamingOperatorSourceConfig | null {
  const streamStateSourceUrl = input.streamStateSourceUrl?.trim() ?? "";
  const explicitSourceUrl = input.sourceUrl?.trim() ?? "";
  const bearerToken = input.bearerToken?.trim() ?? "";
  const timeoutMs = input.timeoutMs ?? 3_000;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error(
      "STREAM_OPERATOR_HEALTH_TIMEOUT_MS must be an integer from 250 to 30000",
    );
  }

  let stateUrl: URL | null = null;
  if (streamStateSourceUrl) {
    try {
      stateUrl = new URL(streamStateSourceUrl);
    } catch {
      throw new Error("STREAM_STATE_SOURCE_URL must be an absolute URL");
    }
  }

  const candidate =
    explicitSourceUrl ||
    (stateUrl ? `${stateUrl.origin}/api/streaming/health` : "");
  if (!candidate) {
    if (input.production) {
      throw new Error(
        "STREAM_OPERATOR_HEALTH_URL is required in production when no stream-state source is configured",
      );
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("STREAM_OPERATOR_HEALTH_URL must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "STREAM_OPERATOR_HEALTH_URL must not contain embedded credentials",
    );
  }
  if (
    parsed.pathname !== "/api/streaming/health" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "STREAM_OPERATOR_HEALTH_URL must target exactly /api/streaming/health without a query or fragment",
    );
  }
  if (stateUrl && parsed.origin !== stateUrl.origin) {
    throw new Error(
      "STREAM_OPERATOR_HEALTH_URL must share the stream-state source origin",
    );
  }

  const isPrivateRailwayHost = parsed.hostname.endsWith(".railway.internal");
  const isLoopback = isLoopbackHostname(parsed.hostname);
  if (input.production) {
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isPrivateRailwayHost)
    ) {
      throw new Error(
        "production STREAM_OPERATOR_HEALTH_URL must use HTTPS or Railway private HTTP",
      );
    }
  } else if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && (isLoopback || isPrivateRailwayHost))
  ) {
    throw new Error(
      "local STREAM_OPERATOR_HEALTH_URL must use HTTPS, loopback HTTP, or Railway private HTTP",
    );
  }

  return {
    sourceUrl: `${parsed.origin}${parsed.pathname}`,
    bearerToken,
    timeoutMs,
  };
}

export async function fetchStreamingOperatorMetrics(
  config: StreamingOperatorSourceConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<StreamingOperatorMetrics> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImplementation(config.sourceUrl, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: config.bearerToken
          ? { authorization: `Bearer ${config.bearerToken}` }
          : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new StreamingOperatorTransportError("timeout");
      }
      throw new StreamingOperatorTransportError("network");
    }
    if (!response.ok && response.status !== 503) {
      try {
        await response.body?.cancel();
      } catch {
        // The response may already be closed; its status still fails closed.
      }
      throw new StreamingOperatorTransportError("http-status");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new StreamingOperatorTransportError("invalid-payload");
    }
    if (
      !isRecord(body) ||
      body.type !== "STREAMING_RUNTIME_HEALTH" ||
      typeof body.ready !== "boolean"
    ) {
      throw new StreamingOperatorTransportError("invalid-payload");
    }
    const metrics = parseStreamingOperatorMetrics(body.operatorMetrics);
    if (!metrics || metrics.ready !== body.ready) {
      throw new StreamingOperatorTransportError("invalid-payload");
    }
    return metrics;
  } finally {
    clearTimeout(timeout);
  }
}

export function classifyStreamingOperatorFailure(
  error: unknown,
): StreamingOperatorFailureCode {
  return error instanceof StreamingOperatorTransportError
    ? error.code
    : "network";
}

export function buildFederatedOperatorReadiness(input: {
  nowMs: number;
  serviceReady: boolean;
  streamMaxAgeMs: number;
  keeperMaxAgeMs: number;
  stream: StreamingOperatorMetrics | null;
  keeper: KeeperOperatorMetrics | null;
}): FederatedOperatorReadiness {
  if (!isCount(input.nowMs)) {
    throw new Error("federated operator observation time is invalid");
  }
  if (!isCount(input.streamMaxAgeMs) || !isCount(input.keeperMaxAgeMs)) {
    throw new Error("federated operator source ages must be non-negative");
  }

  const alerts: FederatedOperatorReadiness["alerts"] = [];
  const addAlert = (
    code: FederatedOperatorAlertCode,
    source: "service" | "stream" | "keeper",
  ): void => {
    alerts.push({ code, severity: "critical", source });
  };

  if (!input.serviceReady) {
    addAlert("service-readiness-failed", "service");
  }

  const streamAge = input.stream
    ? sourceAgeMs(input.nowMs, input.stream.observedAtMs)
    : null;
  if (!input.stream) {
    addAlert("stream-operations-unavailable", "stream");
  } else {
    if (input.stream.observedAtMs > input.nowMs + MAX_SOURCE_FUTURE_SKEW_MS) {
      addAlert("stream-operations-clock-skew", "stream");
    } else if (streamAge === null || streamAge > input.streamMaxAgeMs) {
      addAlert("stream-operations-stale", "stream");
    }
    if (!input.stream.ready) {
      addAlert("stream-runtime-unready", "stream");
    }
  }

  const keeperAge = input.keeper
    ? sourceAgeMs(input.nowMs, input.keeper.observedAtMs)
    : null;
  if (!input.keeper) {
    addAlert("keeper-operations-unavailable", "keeper");
  } else {
    if (input.keeper.observedAtMs > input.nowMs + MAX_SOURCE_FUTURE_SKEW_MS) {
      addAlert("keeper-operations-clock-skew", "keeper");
    } else if (keeperAge === null || keeperAge > input.keeperMaxAgeMs) {
      addAlert("keeper-operations-stale", "keeper");
    }
    if (!input.keeper.feed.checkpointPresent) {
      addAlert("keeper-feed-unavailable", "keeper");
    } else if (input.keeper.feed.degraded) {
      addAlert("keeper-feed-degraded", "keeper");
    }
    if (input.keeper.terminal.counts.MANUAL_REVIEW > 0) {
      addAlert("terminal-manual-review", "keeper");
    }
    if (input.keeper.terminal.counts.DEAD_LETTER > 0) {
      addAlert("terminal-dead-letter", "keeper");
    }
    if (input.keeper.claims.invalidTimingCount > 0) {
      addAlert("claim-timing-invalid", "keeper");
    }
  }

  return {
    schemaVersion: 1,
    observedAtMs: input.nowMs,
    ready: alerts.length === 0,
    sourceAgesMs: { stream: streamAge, keeper: keeperAge },
    alerts,
  };
}
