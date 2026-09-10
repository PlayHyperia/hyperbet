import { describe, expect, test } from "bun:test";

import { buildKeeperOperatorMetrics } from "./keeperOperatorMetrics";
import {
  buildFederatedOperatorReadiness,
  classifyStreamingOperatorFailure,
  fetchStreamingOperatorMetrics,
  parseStreamingOperatorMetrics,
  resolveStreamingOperatorSourceConfig,
} from "./streamOperatorHealth";

const NOW_MS = 10_000;

function streamMetrics(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    observedAtMs: 9_500,
    ready: true,
    agesMs: {
      schedulerAuthority: 100,
      bettingFeed: 100,
      renderer: 100,
      captureClient: 100,
      encoder: 100,
      audio: 100,
      rtmpDelivery: 100,
      keeper: 100,
      projectileCostCustody: 100,
    },
    frames: {
      rendererSamples: 600,
      rendererEstimatedFps: 60,
      rendererFrameIntervalP95Ms: 18,
      rendererFrameWorkP95Ms: 7,
      rendererLongFrameCount: 0,
      captureTargetFps: 30,
      captureMeasuredFps: 30,
      encoderReportedFps: 30,
      droppedFrames: 0,
    },
    ...overrides,
  };
}

function keeperMetrics() {
  return buildKeeperOperatorMetrics({
    nowMs: 9_500,
    checkpoint: {
      sourceEpoch: 1,
      lastAppliedSeq: 2,
      lastEmittedAt: 9_400,
      duelId: "duel-1",
      competitiveSnapshotDigest: "aa".repeat(32),
      phase: "FIGHTING",
      terminal: false,
      terminalEventKey: null,
      degradedReason: null,
      updatedAt: 9_450,
    },
    terminal: {
      summary: {
        PENDING: 0,
        PROCESSING: 0,
        SUCCEEDED: 1,
        MANUAL_REVIEW: 0,
        DEAD_LETTER: 0,
      },
      oldestActionableCreatedAt: null,
      recentSucceededDurationsMs: [500],
    },
    markets: [],
  });
}

describe("stream operator health transport", () => {
  test("derives the exact same-origin health endpoint and rejects unsafe URLs", () => {
    expect(
      resolveStreamingOperatorSourceConfig({
        production: true,
        streamStateSourceUrl:
          "https://game.example/api/streaming/state?ignored-by-source-config=true",
        bearerToken: "secret",
        timeoutMs: 250,
      }),
    ).toEqual({
      sourceUrl: "https://game.example/api/streaming/health",
      bearerToken: "secret",
      timeoutMs: 250,
    });
    expect(() =>
      resolveStreamingOperatorSourceConfig({
        production: true,
        streamStateSourceUrl: "https://game.example/api/streaming/state",
        sourceUrl: "https://other.example/api/streaming/health",
      }),
    ).toThrow("share the stream-state source origin");
    expect(() =>
      resolveStreamingOperatorSourceConfig({
        production: false,
        sourceUrl: "http://public.example/api/streaming/health",
      }),
    ).toThrow("loopback HTTP");
    expect(
      resolveStreamingOperatorSourceConfig({ production: false }),
    ).toBeNull();
  });

  test("accepts healthy and degraded runtime responses and normalizes safe fields", async () => {
    const metrics = streamMetrics({ privateDebug: "must-not-survive" });
    const result = await fetchStreamingOperatorMetrics(
      {
        sourceUrl: "http://127.0.0.1/api/streaming/health",
        bearerToken: "local-token",
        timeoutMs: 1_000,
      },
      (async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer local-token",
        );
        return Response.json(
          {
            type: "STREAMING_RUNTIME_HEALTH",
            ready: true,
            operatorMetrics: metrics,
            secret: "must-not-survive",
          },
          { status: 200 },
        );
      }) as typeof fetch,
    );
    expect(result).toEqual(streamMetrics());
    expect(result).not.toHaveProperty("privateDebug");

    const degraded = streamMetrics({ ready: false });
    await expect(
      fetchStreamingOperatorMetrics(
        {
          sourceUrl: "http://127.0.0.1/api/streaming/health",
          bearerToken: "",
          timeoutMs: 1_000,
        },
        (async () =>
          Response.json(
            {
              type: "STREAMING_RUNTIME_HEALTH",
              ready: false,
              operatorMetrics: degraded,
            },
            { status: 503 },
          )) as typeof fetch,
      ),
    ).resolves.toEqual(degraded);
  });

  test("rejects contradictory, malformed, and unexpected responses with bounded codes", async () => {
    expect(
      parseStreamingOperatorMetrics(
        streamMetrics({
          frames: {
            ...streamMetrics().frames,
            rendererSamples: 0,
            rendererEstimatedFps: 60,
          },
        }),
      ),
    ).toBeNull();

    const config = {
      sourceUrl: "http://127.0.0.1/api/streaming/health",
      bearerToken: "",
      timeoutMs: 1_000,
    };
    for (const [response, expectedCode] of [
      [new Response("failure", { status: 500 }), "http-status"],
      [Response.json({ ready: true }), "invalid-payload"],
      [
        Response.json({
          type: "STREAMING_RUNTIME_HEALTH",
          ready: false,
          operatorMetrics: streamMetrics(),
        }),
        "invalid-payload",
      ],
    ] as const) {
      try {
        await fetchStreamingOperatorMetrics(
          config,
          (async () => response) as typeof fetch,
        );
        throw new Error("expected transport failure");
      } catch (error) {
        expect(classifyStreamingOperatorFailure(error)).toBe(expectedCode);
      }
    }
  });

  test("bounds a real timeout without exposing the upstream exception", async () => {
    const error = await fetchStreamingOperatorMetrics(
      {
        sourceUrl: "http://127.0.0.1/api/streaming/health",
        bearerToken: "",
        timeoutMs: 250,
      },
      ((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("private upstream detail", "AbortError"));
          });
        })) as typeof fetch,
    ).catch((cause: unknown) => cause);
    expect(classifyStreamingOperatorFailure(error)).toBe("timeout");
    expect(String(error)).not.toContain("private upstream detail");
  });
});

describe("federated operator readiness", () => {
  test("is ready only when both validated projections and service readiness agree", () => {
    expect(
      buildFederatedOperatorReadiness({
        nowMs: NOW_MS,
        serviceReady: true,
        streamMaxAgeMs: 2_000,
        keeperMaxAgeMs: 2_000,
        stream: parseStreamingOperatorMetrics(streamMetrics()),
        keeper: keeperMetrics(),
      }),
    ).toEqual({
      schemaVersion: 1,
      observedAtMs: NOW_MS,
      ready: true,
      sourceAgesMs: { stream: 500, keeper: 500 },
      alerts: [],
    });
  });

  test("reports deterministic critical alerts for stale, unavailable, and unsafe custody states", () => {
    const keeper = keeperMetrics();
    keeper.observedAtMs = 1_000;
    keeper.feed.degraded = true;
    keeper.terminal.counts.MANUAL_REVIEW = 1;
    keeper.terminal.actionableCount = 1;
    keeper.terminal.oldestActionableAgeMs = 100;
    keeper.claims.invalidTimingCount = 1;
    keeper.claims.observedMarketMakerCount = 1;

    const result = buildFederatedOperatorReadiness({
      nowMs: NOW_MS,
      serviceReady: false,
      streamMaxAgeMs: 2_000,
      keeperMaxAgeMs: 2_000,
      stream: null,
      keeper,
    });
    expect(result.ready).toBe(false);
    expect(result.alerts.map((alert) => alert.code)).toEqual([
      "service-readiness-failed",
      "stream-operations-unavailable",
      "keeper-operations-stale",
      "keeper-feed-degraded",
      "terminal-manual-review",
      "claim-timing-invalid",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("fails closed when either source clock is implausibly ahead", () => {
    const stream = parseStreamingOperatorMetrics(
      streamMetrics({ observedAtMs: NOW_MS + 5_001 }),
    );
    const keeper = keeperMetrics();
    keeper.observedAtMs = NOW_MS + 5_001;
    expect(
      buildFederatedOperatorReadiness({
        nowMs: NOW_MS,
        serviceReady: true,
        streamMaxAgeMs: 2_000,
        keeperMaxAgeMs: 2_000,
        stream,
        keeper,
      }).alerts.map((alert) => alert.code),
    ).toEqual(["stream-operations-clock-skew", "keeper-operations-clock-skew"]);
  });
});
