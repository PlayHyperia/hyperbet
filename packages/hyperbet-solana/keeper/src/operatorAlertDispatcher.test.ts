import { describe, expect, test } from "bun:test";

import {
  OperatorAlertDispatcher,
  parseOperatorAlertDurableState,
  resolveOperatorAlertConfig,
  type OperatorAlertConfig,
} from "./operatorAlertDispatcher";
import type { FederatedOperatorReadiness } from "./streamOperatorHealth";

const productionMainnetEnvironment = {
  HYPERBET_OPERATOR_ALERT_WEBHOOK_URL:
    "https://alerts.example/hyperbet?route=private",
  HYPERBET_OPERATOR_ALERT_BEARER_TOKEN: "alert-route-secret",
  HYPERBET_OPERATOR_ALERT_ROUTE_ID: "production.primary",
  HYPERBET_OPERATOR_ALERT_MONITOR_MS: "5000",
  HYPERBET_OPERATOR_ALERT_REMINDER_MS: "300000",
  HYPERBET_OPERATOR_ALERT_RETRY_MS: "10000",
  HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: "2000",
} as const;

function config(
  overrides: Partial<OperatorAlertConfig> = {},
): OperatorAlertConfig {
  return {
    enabled: true,
    webhookUrl: "https://alerts.example/hyperbet?route=private",
    bearerToken: "alert-route-secret",
    routeId: "test.primary",
    monitorIntervalMs: 1_000,
    reminderMs: 10_000,
    retryMs: 1_000,
    timeoutMs: 250,
    ...overrides,
  };
}

function readiness(
  alerts: FederatedOperatorReadiness["alerts"] = [],
): FederatedOperatorReadiness {
  return {
    schemaVersion: 1,
    observedAtMs: 9_500,
    ready: alerts.length === 0,
    sourceAgesMs: { stream: 100, keeper: 200 },
    alerts,
  };
}

const streamUnavailable = {
  code: "stream-operations-unavailable",
  severity: "critical",
  source: "stream",
} as const;

const deadLetter = {
  code: "terminal-dead-letter",
  severity: "critical",
  source: "keeper",
} as const;

describe("operator alert configuration", () => {
  test("requires one complete explicit HTTPS route for every production non-local rail", () => {
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(
        resolveOperatorAlertConfig({
          production: true,
          cluster,
          environment: productionMainnetEnvironment,
        }),
      ).toEqual({
        enabled: true,
        webhookUrl: "https://alerts.example/hyperbet?route=private",
        bearerToken: "alert-route-secret",
        routeId: "production.primary",
        monitorIntervalMs: 5_000,
        reminderMs: 300_000,
        retryMs: 10_000,
        timeoutMs: 2_000,
      });
      expect(() =>
        resolveOperatorAlertConfig({
          production: true,
          cluster,
          environment: {},
        }),
      ).toThrow("required for every production non-local service");
    }

    for (const missing of [
      "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL",
      "HYPERBET_OPERATOR_ALERT_ROUTE_ID",
      "HYPERBET_OPERATOR_ALERT_MONITOR_MS",
      "HYPERBET_OPERATOR_ALERT_REMINDER_MS",
      "HYPERBET_OPERATOR_ALERT_RETRY_MS",
      "HYPERBET_OPERATOR_ALERT_TIMEOUT_MS",
    ]) {
      expect(() =>
        resolveOperatorAlertConfig({
          production: true,
          cluster: "devnet",
          environment: {
            ...productionMainnetEnvironment,
            [missing]: undefined,
          },
        }),
      ).toThrow(/required|routing characters/u);
    }
  });

  test("rejects unsafe routes, credentials, and incoherent timing", () => {
    for (const webhook of [
      "http://alerts.example/hyperbet",
      "https://name:secret@alerts.example/hyperbet",
      "https://alerts.example/hyperbet#secret",
      "not-a-url",
    ]) {
      expect(() =>
        resolveOperatorAlertConfig({
          production: true,
          cluster: "testnet",
          environment: {
            ...productionMainnetEnvironment,
            HYPERBET_OPERATOR_ALERT_WEBHOOK_URL: webhook,
          },
        }),
      ).toThrow();
    }
    expect(() =>
      resolveOperatorAlertConfig({
        production: false,
        cluster: "localnet",
        environment: {
          HYPERBET_OPERATOR_ALERT_BEARER_TOKEN: "orphaned-secret",
        },
      }),
    ).toThrow("requires an alert webhook");
    expect(() =>
      resolveOperatorAlertConfig({
        production: true,
        cluster: "mainnet-beta",
        environment: {
          ...productionMainnetEnvironment,
          HYPERBET_OPERATOR_ALERT_MONITOR_MS: "1000",
          HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: "2000",
        },
      }),
    ).toThrow("must not exceed the monitor interval");
    expect(() =>
      resolveOperatorAlertConfig({
        production: true,
        cluster: "mainnet-beta",
        environment: {
          ...productionMainnetEnvironment,
          HYPERBET_OPERATOR_ALERT_REMINDER_MS: "10000",
          HYPERBET_OPERATOR_ALERT_RETRY_MS: "11000",
        },
      }),
    ).toThrow("must not exceed the reminder interval");
  });

  test("supports disabled local defaults and loopback delivery only outside production", () => {
    expect(
      resolveOperatorAlertConfig({
        production: false,
        cluster: "localnet",
        environment: {},
      }),
    ).toEqual({
      enabled: false,
      webhookUrl: null,
      bearerToken: null,
      routeId: "local",
      monitorIntervalMs: 5_000,
      reminderMs: 300_000,
      retryMs: 10_000,
      timeoutMs: 2_000,
    });
    expect(
      resolveOperatorAlertConfig({
        production: false,
        cluster: "localnet",
        environment: {
          HYPERBET_OPERATOR_ALERT_WEBHOOK_URL:
            "http://127.0.0.1:9000/operator-alert",
        },
      }).enabled,
    ).toBe(true);
    expect(() =>
      resolveOperatorAlertConfig({
        production: false,
        cluster: "localnet",
        environment: {
          HYPERBET_OPERATOR_ALERT_WEBHOOK_URL:
            "http://alerts.example/operator-alert",
        },
      }),
    ).toThrow("loopback HTTP");
    expect(() =>
      resolveOperatorAlertConfig({
        production: false,
        cluster: "solana",
        environment: {},
      }),
    ).toThrow("Unsupported Solana operator-alert cluster");
  });
});

describe("operator alert dispatcher", () => {
  test("rejects semantically corrupted pending delivery state", async () => {
    const dispatcher = new OperatorAlertDispatcher(config(), {
      now: () => 10_000,
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    await dispatcher.observe(readiness([streamUnavailable]));
    const state = dispatcher.durableState();
    expect(state.pending).not.toBeNull();
    state.pending!.sourceAgesMs.stream = -1;
    expect(parseOperatorAlertDurableState(state, "test.primary")).toBeNull();
  });

  test("does not notify on initial health or when the route is disabled", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };
    const enabled = new OperatorAlertDispatcher(config(), {
      fetchImpl,
      now: () => 10_000,
    });
    expect(await enabled.observe(readiness())).toMatchObject({
      attempted: false,
      sent: false,
    });
    const disabled = new OperatorAlertDispatcher(
      config({ enabled: false, webhookUrl: null, bearerToken: null }),
      { fetchImpl, now: () => 10_000 },
    );
    expect(
      await disabled.observe(readiness([streamUnavailable])),
    ).toMatchObject({ attempted: false, sent: false });
    expect(calls).toBe(0);
  });

  test("sends only allowlisted incident data and never leaks routing secrets", async () => {
    let requestUrl = "";
    let authorization = "";
    let idempotencyKey = "";
    let payload = "";
    let redirect: RequestRedirect | undefined;
    const dispatcher = new OperatorAlertDispatcher(config(), {
      now: () => 10_000,
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        idempotencyKey =
          new Headers(init?.headers).get("idempotency-key") ?? "";
        payload = String(init?.body);
        redirect = init?.redirect;
        return new Response("ignored-provider-body", { status: 202 });
      },
    });
    const unsafe = readiness([deadLetter]);
    unsafe.alerts.push({
      code: "https://rpc.example/?token=must-not-leak",
      source: "keeper",
      severity: "critical",
    } as never);
    unsafe.sourceAgesMs.stream = Number.NaN;

    expect(await dispatcher.observe(unsafe)).toMatchObject({
      attempted: true,
      sent: true,
      notification: "initial",
    });
    expect(requestUrl).toBe("https://alerts.example/hyperbet?route=private");
    expect(authorization).toBe("Bearer alert-route-secret");
    expect(idempotencyKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(redirect).toBe("error");
    expect(payload).not.toContain("must-not-leak");
    expect(payload).not.toContain("alert-route-secret");
    expect(JSON.parse(payload)).toEqual({
      type: "HYPERBET_OPERATOR_ALERT",
      schemaVersion: 1,
      routeId: "test.primary",
      deliveryId: idempotencyKey,
      status: "firing",
      notification: "initial",
      emittedAtMs: 10_000,
      incidentStartedAtMs: 10_000,
      incidentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      alerts: [deadLetter],
      resolvedAlerts: [],
      sourceAgesMs: { stream: null, keeper: 200 },
    });
    expect(dispatcher.deliveryStatus()).toMatchObject({
      configured: true,
      consecutiveFailures: 0,
      deliveredIncidentActive: true,
      lastDeliveredStatus: "firing",
    });
  });

  test("deduplicates, reminds, reports changed incidents, and recovers", async () => {
    let nowMs = 10_000;
    const payloads: Array<Record<string, unknown>> = [];
    const dispatcher = new OperatorAlertDispatcher(config(), {
      now: () => nowMs,
      fetchImpl: async (_url, init) => {
        payloads.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(null, { status: 204 });
      },
    });

    expect(
      (await dispatcher.observe(readiness([streamUnavailable]))).notification,
    ).toBe("initial");
    nowMs += 5_000;
    expect(
      (await dispatcher.observe(readiness([streamUnavailable]))).attempted,
    ).toBe(false);
    nowMs += 5_000;
    expect(
      (await dispatcher.observe(readiness([streamUnavailable]))).notification,
    ).toBe("reminder");
    nowMs += 1_000;
    expect(
      (await dispatcher.observe(readiness([streamUnavailable, deadLetter])))
        .notification,
    ).toBe("changed");
    nowMs += 1_000;
    expect((await dispatcher.observe(readiness())).notification).toBe(
      "recovered",
    );

    expect(payloads.map((payload) => payload.notification)).toEqual([
      "initial",
      "reminder",
      "changed",
      "recovered",
    ]);
    expect(payloads.at(-1)).toMatchObject({
      status: "recovered",
      alerts: [],
      resolvedAlerts: [deadLetter, streamUnavailable],
    });
    expect(dispatcher.deliveryStatus()).toMatchObject({
      deliveredIncidentActive: false,
      deliveredIncidentFingerprint: null,
      lastDeliveredStatus: "recovered",
    });
  });

  test("retries rejected delivery without acknowledging the incident", async () => {
    let nowMs = 10_000;
    let calls = 0;
    const dispatcher = new OperatorAlertDispatcher(config(), {
      now: () => nowMs,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: calls === 1 ? 503 : 204 });
      },
    });
    expect(
      await dispatcher.observe(readiness([streamUnavailable])),
    ).toMatchObject({ sent: false, failureCode: "http-status" });
    expect(dispatcher.deliveryStatus()).toMatchObject({
      consecutiveFailures: 1,
      deliveredIncidentActive: false,
      lastFailureCode: "http-status",
    });
    nowMs += 999;
    expect(
      (await dispatcher.observe(readiness([streamUnavailable]))).attempted,
    ).toBe(false);
    nowMs += 1;
    expect(
      await dispatcher.observe(readiness([streamUnavailable])),
    ).toMatchObject({ sent: true, notification: "initial" });
    expect(calls).toBe(2);
    expect(dispatcher.deliveryStatus()).toMatchObject({
      consecutiveFailures: 0,
      lastFailureCode: null,
      deliveredIncidentActive: true,
    });
  });

  test("bounds a real delivery timeout and exposes only its fixed code", async () => {
    const dispatcher = new OperatorAlertDispatcher(config(), {
      now: () => 10_000,
      fetchImpl: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(new DOMException("private-provider-detail", "AbortError")),
            { once: true },
          );
        }),
    });
    expect(
      await dispatcher.observe(readiness([streamUnavailable])),
    ).toMatchObject({ sent: false, failureCode: "timeout" });
    expect(JSON.stringify(dispatcher.deliveryStatus())).not.toContain(
      "private-provider-detail",
    );
    expect(dispatcher.deliveryStatus()).toMatchObject({
      inFlight: false,
      consecutiveFailures: 1,
      lastFailureCode: "timeout",
    });
  });

  test("hydrates an accepted incident and emits recovery after restart", async () => {
    let nowMs = 10_000;
    let durableState = null as ReturnType<
      OperatorAlertDispatcher["durableState"]
    > | null;
    const first = new OperatorAlertDispatcher(config(), {
      now: () => nowMs,
      fetchImpl: async () => new Response(null, { status: 204 }),
      persistState: (state) => {
        durableState = structuredClone(state);
      },
    });
    expect(await first.observe(readiness([streamUnavailable]))).toMatchObject({
      sent: true,
      notification: "initial",
    });
    expect(durableState?.delivered).not.toBeNull();
    expect(durableState?.pending).toBeNull();

    nowMs += 1_000;
    let recoveryPayload: Record<string, unknown> | null = null;
    const replacement = new OperatorAlertDispatcher(config(), {
      now: () => nowMs,
      initialState: durableState,
      persistState: (state) => {
        durableState = structuredClone(state);
      },
      fetchImpl: async (_url, init) => {
        recoveryPayload = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return new Response(null, { status: 204 });
      },
    });
    expect(await replacement.observe(readiness())).toMatchObject({
      sent: true,
      notification: "recovered",
    });
    expect(recoveryPayload).toMatchObject({
      status: "recovered",
      alerts: [],
      resolvedAlerts: [streamUnavailable],
    });
    expect(durableState?.delivered).toBeNull();
    expect(durableState?.pending).toBeNull();
  });

  test("replays one stable delivery ID when acceptance cannot be persisted", async () => {
    let nowMs = 10_000;
    let durableState = null as ReturnType<
      OperatorAlertDispatcher["durableState"]
    > | null;
    let rejectAcceptedState = true;
    const deliveryIds: string[] = [];
    const first = new OperatorAlertDispatcher(config(), {
      now: () => nowMs,
      fetchImpl: async (_url, init) => {
        deliveryIds.push(
          new Headers(init?.headers).get("idempotency-key") ?? "",
        );
        return new Response(null, { status: 204 });
      },
      persistState: (state) => {
        if (
          rejectAcceptedState &&
          state.delivered !== null &&
          state.pending === null
        ) {
          rejectAcceptedState = false;
          throw new Error("simulated post-acceptance state outage");
        }
        durableState = structuredClone(state);
      },
    });
    expect(await first.observe(readiness([streamUnavailable]))).toMatchObject({
      sent: false,
      failureCode: "state",
    });
    expect(durableState?.pending).not.toBeNull();
    expect(durableState?.delivered).toBeNull();

    nowMs += 1_000;
    const replacement = new OperatorAlertDispatcher(config(), {
      now: () => nowMs,
      initialState: durableState,
      fetchImpl: async (_url, init) => {
        deliveryIds.push(
          new Headers(init?.headers).get("idempotency-key") ?? "",
        );
        return new Response(null, { status: 204 });
      },
      persistState: (state) => {
        durableState = structuredClone(state);
      },
    });
    expect(
      await replacement.observe(readiness([streamUnavailable])),
    ).toMatchObject({ sent: true, notification: "initial" });
    expect(deliveryIds).toHaveLength(2);
    expect(deliveryIds[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(deliveryIds[1]).toBe(deliveryIds[0]);
    expect(durableState?.pending).toBeNull();
    expect(durableState?.delivered).not.toBeNull();
  });
});
