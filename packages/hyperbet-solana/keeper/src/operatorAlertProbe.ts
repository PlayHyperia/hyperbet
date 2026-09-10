import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { resolveOperatorAlertConfig } from "./operatorAlertDispatcher";

export type OperatorAlertProbeEnvironment = "staging" | "production";

export type OperatorAlertProbeEvidence = {
  schemaVersion: 1;
  type: "HYPERBET_OPERATOR_ALERT_TEST";
  deliveryScope: "webhook_http_acceptance_only";
  routeId: string;
  environment: OperatorAlertProbeEnvironment;
  releaseSha: string;
  probeId: string;
  emittedAt: string;
  acceptedAt: string;
  elapsedMs: number;
  responseStatus: number;
  webhookAccepted: true;
  providerAcknowledgementRequired: true;
  controlledFiringRecoveryRequired: true;
  externalValue: false;
};

export type OperatorAlertProbeInput = {
  approved: boolean;
  webhookUrl: string;
  bearerToken?: string;
  routeId: string;
  environment: string;
  releaseSha: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  probeId?: () => string;
};

function requireEnvironment(value: string): OperatorAlertProbeEnvironment {
  const environment = value.trim();
  if (environment !== "staging" && environment !== "production") {
    throw new Error(
      "operator alert probe environment must be staging or production",
    );
  }
  return environment;
}

function requireReleaseSha(value: string): string {
  const releaseSha = value.trim();
  if (!/^[a-f0-9]{40}$/u.test(releaseSha)) {
    throw new Error(
      "operator alert probe release SHA must be 40 lowercase hex characters",
    );
  }
  return releaseSha;
}

function requireTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 10_000) {
    throw new Error(
      "operator alert probe timeout must be an integer from 250 to 10000 ms",
    );
  }
  return value;
}

function requireProbeId(value: string): string {
  if (!/^[a-f0-9-]{16,64}$/u.test(value)) {
    throw new Error("operator alert probe ID is invalid");
  }
  return value;
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("operator alert probe clock is invalid");
  }
  return value;
}

export async function probeOperatorAlertRoute(
  input: OperatorAlertProbeInput,
): Promise<OperatorAlertProbeEvidence> {
  if (!input.approved) {
    throw new Error(
      "operator alert probing requires explicit HYPERBET_OPERATOR_ALERT_TEST_APPROVED=true authorization",
    );
  }
  const environment = requireEnvironment(input.environment);
  const releaseSha = requireReleaseSha(input.releaseSha);
  const timeoutMs = requireTimeoutMs(input.timeoutMs);
  const routeConfig = resolveOperatorAlertConfig({
    production: true,
    cluster: "mainnet-beta",
    environment: {
      HYPERBET_OPERATOR_ALERT_WEBHOOK_URL: input.webhookUrl,
      HYPERBET_OPERATOR_ALERT_BEARER_TOKEN: input.bearerToken,
      HYPERBET_OPERATOR_ALERT_ROUTE_ID: input.routeId,
      HYPERBET_OPERATOR_ALERT_MONITOR_MS: String(Math.max(1_000, timeoutMs)),
      HYPERBET_OPERATOR_ALERT_REMINDER_MS: "10000",
      HYPERBET_OPERATOR_ALERT_RETRY_MS: "1000",
      HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: String(timeoutMs),
    },
  });
  if (!routeConfig.webhookUrl) {
    throw new Error("operator alert probe route is unavailable");
  }

  const probeId = requireProbeId((input.probeId ?? randomUUID)());
  const now = input.now ?? Date.now;
  const emittedAtMs = requireTimestamp(now());
  const emittedAt = new Date(emittedAtMs).toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    try {
      response = await (input.fetchImpl ?? fetch)(routeConfig.webhookUrl, {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(routeConfig.bearerToken
            ? { authorization: `Bearer ${routeConfig.bearerToken}` }
            : {}),
        },
        body: JSON.stringify({
          type: "HYPERBET_OPERATOR_ALERT_TEST",
          schemaVersion: 1,
          status: "test",
          actionRequired: false,
          routeId: routeConfig.routeId,
          environment,
          releaseSha,
          probeId,
          emittedAt,
          externalValue: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("operator alert route probe timed out");
      }
      throw new Error(
        "operator alert route probe did not receive HTTP acceptance",
      );
    }
  } finally {
    clearTimeout(timeout);
  }

  try {
    await response.body?.cancel();
  } catch {
    // HTTP status remains authoritative if the response body is already closed.
  }
  if (!response.ok) {
    throw new Error(
      `operator alert route rejected the test event with HTTP ${response.status}`,
    );
  }

  const acceptedAtMs = requireTimestamp(now());
  if (acceptedAtMs < emittedAtMs) {
    throw new Error("operator alert probe clock regressed during delivery");
  }
  return {
    schemaVersion: 1,
    type: "HYPERBET_OPERATOR_ALERT_TEST",
    deliveryScope: "webhook_http_acceptance_only",
    routeId: routeConfig.routeId,
    environment,
    releaseSha,
    probeId,
    emittedAt,
    acceptedAt: new Date(acceptedAtMs).toISOString(),
    elapsedMs: acceptedAtMs - emittedAtMs,
    responseStatus: response.status,
    webhookAccepted: true,
    providerAcknowledgementRequired: true,
    controlledFiringRecoveryRequired: true,
    externalValue: false,
  };
}

export async function writeOperatorAlertProbeEvidence(
  outputPath: string,
  evidence: OperatorAlertProbeEvidence,
): Promise<string> {
  const resolvedOutputPath = path.resolve(outputPath);
  const parent = path.dirname(resolvedOutputPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    parent,
    `.${path.basename(resolvedOutputPath)}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, resolvedOutputPath);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
  return resolvedOutputPath;
}
