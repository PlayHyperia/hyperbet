import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  probeOperatorAlertRoute,
  writeOperatorAlertProbeEvidence,
  type OperatorAlertProbeInput,
} from "./operatorAlertProbe";
import { runOperatorAlertProbeCli } from "./operatorAlertProbeCli";

const temporaryDirectories: string[] = [];
const releaseSha = "a".repeat(40);
const probeId = "12345678-1234-1234-1234-123456789abc";

function input(
  overrides: Partial<OperatorAlertProbeInput> = {},
): OperatorAlertProbeInput {
  let nowCall = 0;
  return {
    approved: true,
    webhookUrl: "https://alerts.example/hyperbet?token=private-route",
    bearerToken: "private-bearer",
    routeId: "staging.primary",
    environment: "staging",
    releaseSha,
    timeoutMs: 2_000,
    probeId: () => probeId,
    now: () => [1_000, 1_125][nowCall++] ?? 1_125,
    fetchImpl: async () => new Response(null, { status: 204 }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operator alert route probe", () => {
  test("sends one bounded non-actionable event and retains no route secret", async () => {
    let receivedUrl = "";
    let receivedAuthorization = "";
    let receivedRequest: RequestInit | null = null;
    const evidence = await probeOperatorAlertRoute(
      input({
        fetchImpl: async (url, init) => {
          receivedUrl = String(url);
          receivedAuthorization =
            new Headers(init?.headers).get("authorization") ?? "";
          receivedRequest = init;
          return new Response("provider-body-must-not-survive", {
            status: 202,
          });
        },
      }),
    );

    expect(receivedUrl).toContain("token=private-route");
    expect(receivedAuthorization).toBe("Bearer private-bearer");
    expect(receivedRequest).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(String(receivedRequest?.body))).toEqual({
      type: "HYPERBET_OPERATOR_ALERT_TEST",
      schemaVersion: 1,
      status: "test",
      actionRequired: false,
      routeId: "staging.primary",
      environment: "staging",
      releaseSha,
      probeId,
      emittedAt: "1970-01-01T00:00:01.000Z",
      externalValue: false,
    });
    expect(evidence).toEqual({
      schemaVersion: 1,
      type: "HYPERBET_OPERATOR_ALERT_TEST",
      deliveryScope: "webhook_http_acceptance_only",
      routeId: "staging.primary",
      environment: "staging",
      releaseSha,
      probeId,
      emittedAt: "1970-01-01T00:00:01.000Z",
      acceptedAt: "1970-01-01T00:00:01.125Z",
      elapsedMs: 125,
      responseStatus: 202,
      webhookAccepted: true,
      providerAcknowledgementRequired: true,
      controlledFiringRecoveryRequired: true,
      externalValue: false,
    });
    const serializedEvidence = JSON.stringify(evidence);
    expect(serializedEvidence).not.toContain("private-route");
    expect(serializedEvidence).not.toContain("private-bearer");
    expect(serializedEvidence).not.toContain("alerts.example");
    expect(serializedEvidence).not.toContain("provider-body");
  });

  test("fails before network access without exact one-run approval", async () => {
    let called = false;
    await expect(
      probeOperatorAlertRoute(
        input({
          approved: false,
          fetchImpl: async () => {
            called = true;
            return new Response(null, { status: 204 });
          },
        }),
      ),
    ).rejects.toThrow(
      "explicit HYPERBET_OPERATOR_ALERT_TEST_APPROVED=true authorization",
    );
    expect(called).toBe(false);
  });

  test("reuses the production route policy for every sensitive input", async () => {
    for (const overrides of [
      { webhookUrl: "http://alerts.example/hyperbet" },
      { webhookUrl: "https://name:secret@alerts.example/hyperbet" },
      { webhookUrl: "https://alerts.example/hyperbet#secret" },
      { bearerToken: `${"a".repeat(512)}x` },
      { routeId: "Production Primary" },
      { environment: "development" },
      { releaseSha: "abc123" },
      { timeoutMs: 249 },
      { timeoutMs: 10_001 },
      { probeId: () => "unsafe probe identity" },
    ]) {
      await expect(probeOperatorAlertRoute(input(overrides))).rejects.toThrow();
    }
  });

  test("does not accept a provider rejection or retain its response body", async () => {
    await expect(
      probeOperatorAlertRoute(
        input({
          fetchImpl: async () =>
            new Response("private-provider-rejection", { status: 503 }),
        }),
      ),
    ).rejects.toThrow("HTTP 503");
  });

  test("bounds a real timeout without exposing the provider exception", async () => {
    await expect(
      probeOperatorAlertRoute(
        input({
          timeoutMs: 250,
          fetchImpl: async (_url, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () =>
                  reject(
                    new DOMException("private-provider-timeout", "AbortError"),
                  ),
                { once: true },
              );
            }),
        }),
      ),
    ).rejects.toThrow("operator alert route probe timed out");
  });

  test("rejects clock regression instead of normalizing false evidence", async () => {
    let nowCall = 0;
    await expect(
      probeOperatorAlertRoute(
        input({
          now: () => [2_000, 1_999][nowCall++] ?? 1_999,
        }),
      ),
    ).rejects.toThrow("clock regressed during delivery");
  });

  test("writes owner-only immutable evidence and refuses replacement", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "hyperbet-alert-probe-"),
    );
    temporaryDirectories.push(directory);
    const output = path.join(directory, "evidence.json");
    const evidence = await probeOperatorAlertRoute(input());

    await expect(
      writeOperatorAlertProbeEvidence(output, evidence),
    ).resolves.toBe(output);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(evidence);
    await expect(
      writeOperatorAlertProbeEvidence(output, evidence),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  test("the CLI requires explicit approval before touching its route", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "hyperbet-alert-probe-cli-"),
    );
    temporaryDirectories.push(directory);
    await expect(
      runOperatorAlertProbeCli(
        [
          "--environment=staging",
          `--release-sha=${releaseSha}`,
          `--output=${path.join(directory, "evidence.json")}`,
        ],
        {
          HYPERBET_OPERATOR_ALERT_WEBHOOK_URL:
            "https://alerts.example/hyperbet?token=private-route",
          HYPERBET_OPERATOR_ALERT_ROUTE_ID: "staging.primary",
        },
      ),
    ).rejects.toThrow(
      "explicit HYPERBET_OPERATOR_ALERT_TEST_APPROVED=true authorization",
    );
  });
});
