import { createHash } from "node:crypto";

import {
  FEDERATED_OPERATOR_ALERT_CODES,
  type FederatedOperatorAlertCode,
  type FederatedOperatorReadiness,
} from "./streamOperatorHealth";

export type OperatorAlertFailureCode =
  "http-status" | "network" | "state" | "timeout";

export type OperatorAlertNotification =
  "initial" | "changed" | "reminder" | "recovered";

export type OperatorAlertConfig = {
  enabled: boolean;
  webhookUrl: string | null;
  bearerToken: string | null;
  routeId: string;
  monitorIntervalMs: number;
  reminderMs: number;
  retryMs: number;
  timeoutMs: number;
};

export type OperatorAlertDeliveryStatus = {
  schemaVersion: 1;
  configured: boolean;
  inFlight: boolean;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  lastFailureCode: OperatorAlertFailureCode | null;
  consecutiveFailures: number;
  deliveredIncidentActive: boolean;
  deliveredIncidentFingerprint: string | null;
  lastDeliveredStatus: "firing" | "recovered" | null;
};

type AlertEnvironment = Readonly<Record<string, string | undefined>>;

type SafeAlert = FederatedOperatorReadiness["alerts"][number];

export type OperatorAlertPendingDelivery = {
  deliveryId: string;
  signature: string;
  status: "firing" | "recovered";
  notification: OperatorAlertNotification;
  emittedAtMs: number;
  incidentStartedAtMs: number;
  incidentFingerprint: string;
  alerts: SafeAlert[];
  resolvedAlerts: SafeAlert[];
  sourceAgesMs: { stream: number | null; keeper: number | null };
  reminderSequence: number;
};

export type OperatorAlertDurableState = {
  schemaVersion: 1;
  routeId: string;
  delivered: {
    signature: string;
    alerts: SafeAlert[];
    incidentStartedAtMs: number;
    lastDeliveredAtMs: number;
    reminderSequence: number;
  } | null;
  pending: OperatorAlertPendingDelivery | null;
  telemetry: {
    lastAttemptAtMs: number | null;
    lastSuccessAtMs: number | null;
    lastFailureAtMs: number | null;
    lastFailureCode: OperatorAlertFailureCode | null;
    consecutiveFailures: number;
    lastDeliveredStatus: "firing" | "recovered" | null;
  };
};

const ALERT_CODE_SET = new Set<string>(FEDERATED_OPERATOR_ALERT_CODES);
const ALERT_SOURCE_BY_CODE: Record<
  FederatedOperatorAlertCode,
  SafeAlert["source"]
> = {
  "service-readiness-failed": "service",
  "stream-operations-unavailable": "stream",
  "stream-operations-stale": "stream",
  "stream-operations-clock-skew": "stream",
  "stream-runtime-unready": "stream",
  "keeper-operations-unavailable": "keeper",
  "keeper-operations-stale": "keeper",
  "keeper-operations-clock-skew": "keeper",
  "keeper-feed-unavailable": "keeper",
  "keeper-feed-degraded": "keeper",
  "terminal-manual-review": "keeper",
  "terminal-dead-letter": "keeper",
  "claim-timing-invalid": "keeper",
};

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function parseBoundedInteger(input: {
  environment: AlertEnvironment;
  key: string;
  fallback: number;
  minimum: number;
  maximum: number;
  required: boolean;
}): number {
  const raw = input.environment[input.key]?.trim();
  if (!raw) {
    if (input.required) {
      throw new Error(`${input.key} is required for a production alert route`);
    }
    return input.fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${input.key} must be a base-10 integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(value) ||
    value < input.minimum ||
    value > input.maximum
  ) {
    throw new Error(
      `${input.key} must be between ${input.minimum} and ${input.maximum}`,
    );
  }
  return value;
}

function validateWebhookUrl(value: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL must be an absolute URL",
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL must not contain URL credentials",
    );
  }
  if (url.hash) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL must not contain a fragment",
    );
  }
  if (production) {
    if (url.protocol !== "https:") {
      throw new Error(
        "production HYPERBET_OPERATOR_ALERT_WEBHOOK_URL must use https:",
      );
    }
  } else if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error(
      "local HYPERBET_OPERATOR_ALERT_WEBHOOK_URL must use HTTPS or loopback HTTP",
    );
  }
  return url.href;
}

export function assertOperatorAlertRouteId(value: string): string {
  const routeId = value.trim();
  if (!/^[a-z0-9][a-z0-9._:-]{2,63}$/u.test(routeId)) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_ROUTE_ID must be 3-64 lowercase routing characters",
    );
  }
  return routeId;
}

function validateRouteId(value: string | undefined, required: boolean): string {
  return assertOperatorAlertRouteId(value?.trim() || (required ? "" : "local"));
}

function validateBearerToken(
  value: string | undefined,
  webhookConfigured: boolean,
): string | null {
  const token = value?.trim() ?? "";
  if (!token) return null;
  if (!webhookConfigured) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_BEARER_TOKEN requires an alert webhook",
    );
  }
  if (token.length > 512 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_BEARER_TOKEN must be at most 512 visible characters",
    );
  }
  return token;
}

export function resolveOperatorAlertConfig(input: {
  production: boolean;
  cluster: string;
  environment: AlertEnvironment;
}): OperatorAlertConfig {
  const cluster = input.cluster.trim().toLowerCase();
  if (
    cluster !== "localnet" &&
    cluster !== "devnet" &&
    cluster !== "testnet" &&
    cluster !== "mainnet" &&
    cluster !== "mainnet-beta"
  ) {
    throw new Error(
      `Unsupported Solana operator-alert cluster '${input.cluster}'`,
    );
  }
  const rawWebhook =
    input.environment.HYPERBET_OPERATOR_ALERT_WEBHOOK_URL?.trim() ?? "";
  const routeRequired = input.production && cluster !== "localnet";
  const strictProductionRoute =
    input.production && (routeRequired || Boolean(rawWebhook));
  if (routeRequired && !rawWebhook) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL is required for every production non-local service",
    );
  }

  const webhookUrl = rawWebhook
    ? validateWebhookUrl(rawWebhook, input.production)
    : null;
  const bearerToken = validateBearerToken(
    input.environment.HYPERBET_OPERATOR_ALERT_BEARER_TOKEN,
    Boolean(webhookUrl),
  );
  const routeId = validateRouteId(
    input.environment.HYPERBET_OPERATOR_ALERT_ROUTE_ID,
    strictProductionRoute,
  );
  const monitorIntervalMs = parseBoundedInteger({
    environment: input.environment,
    key: "HYPERBET_OPERATOR_ALERT_MONITOR_MS",
    fallback: 5_000,
    minimum: 1_000,
    maximum: 60_000,
    required: strictProductionRoute,
  });
  const reminderMs = parseBoundedInteger({
    environment: input.environment,
    key: "HYPERBET_OPERATOR_ALERT_REMINDER_MS",
    fallback: 300_000,
    minimum: 10_000,
    maximum: 86_400_000,
    required: strictProductionRoute,
  });
  const retryMs = parseBoundedInteger({
    environment: input.environment,
    key: "HYPERBET_OPERATOR_ALERT_RETRY_MS",
    fallback: 10_000,
    minimum: 1_000,
    maximum: 60_000,
    required: strictProductionRoute,
  });
  const timeoutMs = parseBoundedInteger({
    environment: input.environment,
    key: "HYPERBET_OPERATOR_ALERT_TIMEOUT_MS",
    fallback: 2_000,
    minimum: 250,
    maximum: 10_000,
    required: strictProductionRoute,
  });
  if (timeoutMs > monitorIntervalMs) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_TIMEOUT_MS must not exceed the monitor interval",
    );
  }
  if (retryMs > reminderMs) {
    throw new Error(
      "HYPERBET_OPERATOR_ALERT_RETRY_MS must not exceed the reminder interval",
    );
  }

  return {
    enabled: webhookUrl !== null,
    webhookUrl,
    bearerToken,
    routeId,
    monitorIntervalMs,
    reminderMs,
    retryMs,
    timeoutMs,
  };
}

function normalizedAlerts(readiness: FederatedOperatorReadiness): SafeAlert[] {
  const normalized = new Map<string, SafeAlert>();
  for (const candidate of readiness.alerts) {
    if (
      !ALERT_CODE_SET.has(candidate.code) ||
      candidate.severity !== "critical" ||
      ALERT_SOURCE_BY_CODE[candidate.code] !== candidate.source
    ) {
      continue;
    }
    const alert = {
      code: candidate.code,
      severity: "critical" as const,
      source: candidate.source,
    };
    normalized.set(`${alert.source}:${alert.code}`, alert);
  }
  if (!readiness.ready && normalized.size === 0) {
    normalized.set("service:service-readiness-failed", {
      code: "service-readiness-failed",
      severity: "critical",
      source: "service",
    });
  }
  return [...normalized.values()].sort((left, right) =>
    `${left.source}:${left.code}`.localeCompare(
      `${right.source}:${right.code}`,
    ),
  );
}

function incidentSignature(alerts: readonly SafeAlert[]): string {
  return alerts.length === 0
    ? ""
    : JSON.stringify(alerts.map(({ code, source }) => ({ code, source })));
}

function fingerprint(signature: string): string | null {
  return signature
    ? createHash("sha256").update(signature).digest("hex")
    : null;
}

function safeAge(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isNullableAge(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function parseSafeAlerts(value: unknown): SafeAlert[] | null {
  if (
    !Array.isArray(value) ||
    value.length > FEDERATED_OPERATOR_ALERT_CODES.length
  ) {
    return null;
  }
  const parsed: SafeAlert[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["code", "severity", "source"]) ||
      typeof candidate.code !== "string" ||
      !ALERT_CODE_SET.has(candidate.code) ||
      candidate.severity !== "critical" ||
      ALERT_SOURCE_BY_CODE[candidate.code as FederatedOperatorAlertCode] !==
        candidate.source
    ) {
      return null;
    }
    const alert = {
      code: candidate.code as FederatedOperatorAlertCode,
      severity: "critical" as const,
      source: candidate.source as SafeAlert["source"],
    };
    const key = `${alert.source}:${alert.code}`;
    if (seen.has(key)) return null;
    seen.add(key);
    parsed.push(alert);
  }
  const sorted = [...parsed].sort((left, right) =>
    `${left.source}:${left.code}`.localeCompare(
      `${right.source}:${right.code}`,
    ),
  );
  return JSON.stringify(sorted) === JSON.stringify(parsed) ? parsed : null;
}

function deliveryId(input: {
  routeId: string;
  signature: string;
  status: "firing" | "recovered";
  notification: OperatorAlertNotification;
  emittedAtMs: number;
  incidentStartedAtMs: number;
  reminderSequence: number;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createInitialOperatorAlertDurableState(
  routeId: string,
): OperatorAlertDurableState {
  return {
    schemaVersion: 1,
    routeId,
    delivered: null,
    pending: null,
    telemetry: {
      lastAttemptAtMs: null,
      lastSuccessAtMs: null,
      lastFailureAtMs: null,
      lastFailureCode: null,
      consecutiveFailures: 0,
      lastDeliveredStatus: null,
    },
  };
}

export function parseOperatorAlertDurableState(
  value: unknown,
  expectedRouteId: string,
): OperatorAlertDurableState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "routeId",
      "delivered",
      "pending",
      "telemetry",
    ]) ||
    value.schemaVersion !== 1 ||
    value.routeId !== expectedRouteId ||
    !isRecord(value.telemetry) ||
    !hasExactKeys(value.telemetry, [
      "lastAttemptAtMs",
      "lastSuccessAtMs",
      "lastFailureAtMs",
      "lastFailureCode",
      "consecutiveFailures",
      "lastDeliveredStatus",
    ]) ||
    !isNullableTimestamp(value.telemetry.lastAttemptAtMs) ||
    !isNullableTimestamp(value.telemetry.lastSuccessAtMs) ||
    !isNullableTimestamp(value.telemetry.lastFailureAtMs) ||
    ![null, "http-status", "network", "state", "timeout"].includes(
      value.telemetry.lastFailureCode as never,
    ) ||
    !isTimestamp(value.telemetry.consecutiveFailures) ||
    ![null, "firing", "recovered"].includes(
      value.telemetry.lastDeliveredStatus as never,
    )
  ) {
    return null;
  }

  let delivered: OperatorAlertDurableState["delivered"] = null;
  if (value.delivered !== null) {
    if (
      !isRecord(value.delivered) ||
      !hasExactKeys(value.delivered, [
        "signature",
        "alerts",
        "incidentStartedAtMs",
        "lastDeliveredAtMs",
        "reminderSequence",
      ])
    ) {
      return null;
    }
    const alerts = parseSafeAlerts(value.delivered.alerts);
    if (
      !alerts ||
      alerts.length === 0 ||
      value.delivered.signature !== incidentSignature(alerts) ||
      !isTimestamp(value.delivered.incidentStartedAtMs) ||
      !isTimestamp(value.delivered.lastDeliveredAtMs) ||
      value.delivered.lastDeliveredAtMs < value.delivered.incidentStartedAtMs ||
      !isTimestamp(value.delivered.reminderSequence)
    ) {
      return null;
    }
    delivered = {
      signature: value.delivered.signature,
      alerts,
      incidentStartedAtMs: value.delivered.incidentStartedAtMs,
      lastDeliveredAtMs: value.delivered.lastDeliveredAtMs,
      reminderSequence: value.delivered.reminderSequence,
    };
  }

  let pending: OperatorAlertPendingDelivery | null = null;
  if (value.pending !== null) {
    if (
      !isRecord(value.pending) ||
      !hasExactKeys(value.pending, [
        "deliveryId",
        "signature",
        "status",
        "notification",
        "emittedAtMs",
        "incidentStartedAtMs",
        "incidentFingerprint",
        "alerts",
        "resolvedAlerts",
        "sourceAgesMs",
        "reminderSequence",
      ]) ||
      !/^[0-9a-f]{64}$/u.test(String(value.pending.deliveryId)) ||
      !["firing", "recovered"].includes(String(value.pending.status)) ||
      !["initial", "changed", "reminder", "recovered"].includes(
        String(value.pending.notification),
      ) ||
      !isTimestamp(value.pending.emittedAtMs) ||
      !isTimestamp(value.pending.incidentStartedAtMs) ||
      value.pending.emittedAtMs < value.pending.incidentStartedAtMs ||
      !/^[0-9a-f]{64}$/u.test(String(value.pending.incidentFingerprint)) ||
      !isTimestamp(value.pending.reminderSequence) ||
      !isRecord(value.pending.sourceAgesMs) ||
      !hasExactKeys(value.pending.sourceAgesMs, ["stream", "keeper"]) ||
      !isNullableAge(value.pending.sourceAgesMs.stream) ||
      !isNullableAge(value.pending.sourceAgesMs.keeper)
    ) {
      return null;
    }
    const alerts = parseSafeAlerts(value.pending.alerts);
    const resolvedAlerts = parseSafeAlerts(value.pending.resolvedAlerts);
    if (!alerts || !resolvedAlerts) return null;
    const status = value.pending.status as "firing" | "recovered";
    const notification = value.pending
      .notification as OperatorAlertNotification;
    const incidentAlerts = status === "firing" ? alerts : resolvedAlerts;
    if (
      incidentAlerts.length === 0 ||
      (status === "firing" &&
        (resolvedAlerts.length !== 0 || notification === "recovered")) ||
      (status === "recovered" &&
        (alerts.length !== 0 || notification !== "recovered")) ||
      value.pending.signature !== incidentSignature(incidentAlerts) ||
      value.pending.incidentFingerprint !==
        fingerprint(value.pending.signature) ||
      (notification === "reminder") !==
        Number(value.pending.reminderSequence) > 0
    ) {
      return null;
    }
    const expectedDeliveryId = deliveryId({
      routeId: expectedRouteId,
      signature: value.pending.signature,
      status,
      notification,
      emittedAtMs: value.pending.emittedAtMs,
      incidentStartedAtMs: value.pending.incidentStartedAtMs,
      reminderSequence: value.pending.reminderSequence,
    });
    if (value.pending.deliveryId !== expectedDeliveryId) return null;
    pending = {
      deliveryId: expectedDeliveryId,
      signature: value.pending.signature,
      status,
      notification,
      emittedAtMs: value.pending.emittedAtMs,
      incidentStartedAtMs: value.pending.incidentStartedAtMs,
      incidentFingerprint: value.pending.incidentFingerprint as string,
      alerts,
      resolvedAlerts,
      sourceAgesMs: {
        stream: value.pending.sourceAgesMs.stream,
        keeper: value.pending.sourceAgesMs.keeper,
      },
      reminderSequence: value.pending.reminderSequence,
    };
  }
  if (
    pending?.status === "recovered" &&
    delivered?.signature !== pending.signature
  ) {
    return null;
  }

  const telemetry = value.telemetry as OperatorAlertDurableState["telemetry"];
  if (
    (telemetry.lastFailureCode === null) !==
      (telemetry.consecutiveFailures === 0) ||
    (telemetry.lastFailureCode !== null &&
      telemetry.lastFailureAtMs === null) ||
    (telemetry.lastSuccessAtMs === null) !==
      (telemetry.lastDeliveredStatus === null) ||
    (telemetry.lastAttemptAtMs === null &&
      (telemetry.lastSuccessAtMs !== null ||
        telemetry.lastFailureAtMs !== null ||
        pending !== null)) ||
    (telemetry.lastAttemptAtMs !== null &&
      ((telemetry.lastSuccessAtMs !== null &&
        telemetry.lastSuccessAtMs > telemetry.lastAttemptAtMs) ||
        (telemetry.lastFailureAtMs !== null &&
          telemetry.lastFailureAtMs > telemetry.lastAttemptAtMs))) ||
    (pending !== null &&
      (telemetry.lastAttemptAtMs === null ||
        telemetry.lastAttemptAtMs < pending.emittedAtMs)) ||
    (delivered !== null &&
      (telemetry.lastDeliveredStatus !== "firing" ||
        telemetry.lastSuccessAtMs !== delivered.lastDeliveredAtMs ||
        telemetry.lastAttemptAtMs === null ||
        delivered.lastDeliveredAtMs > telemetry.lastAttemptAtMs)) ||
    (pending?.notification === "initial" && delivered !== null) ||
    (pending?.notification === "changed" &&
      (delivered === null || delivered.signature === pending.signature)) ||
    (pending?.notification === "reminder" &&
      (delivered === null ||
        delivered.signature !== pending.signature ||
        pending.reminderSequence !== delivered.reminderSequence + 1)) ||
    (pending?.notification === "recovered" &&
      (delivered === null || delivered.signature !== pending.signature))
  ) {
    return null;
  }

  const parsed: OperatorAlertDurableState = {
    schemaVersion: 1,
    routeId: expectedRouteId,
    delivered,
    pending,
    telemetry: {
      lastAttemptAtMs: telemetry.lastAttemptAtMs,
      lastSuccessAtMs: telemetry.lastSuccessAtMs,
      lastFailureAtMs: telemetry.lastFailureAtMs,
      lastFailureCode:
        telemetry.lastFailureCode as OperatorAlertFailureCode | null,
      consecutiveFailures: telemetry.consecutiveFailures,
      lastDeliveredStatus: telemetry.lastDeliveredStatus as
        "firing" | "recovered" | null,
    },
  };
  return structuredClone(parsed);
}

export class OperatorAlertDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private observedSignature = "";
  private observedIncidentStartedAtMs: number | null = null;
  private state: OperatorAlertDurableState;
  private inFlight = false;

  constructor(
    private readonly config: OperatorAlertConfig,
    private readonly dependencies: {
      fetchImpl?: typeof fetch;
      now?: () => number;
      initialState?: OperatorAlertDurableState | null;
      persistState?: (state: OperatorAlertDurableState) => void;
    } = {},
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.state = structuredClone(
      dependencies.initialState ??
        createInitialOperatorAlertDurableState(config.routeId),
    );
    if (!parseOperatorAlertDurableState(this.state, this.config.routeId)) {
      throw new Error("initial operator alert state is invalid");
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  deliveryStatus(): OperatorAlertDeliveryStatus {
    return {
      schemaVersion: 1,
      configured: this.config.enabled,
      inFlight: this.inFlight,
      lastAttemptAtMs: this.state.telemetry.lastAttemptAtMs,
      lastSuccessAtMs: this.state.telemetry.lastSuccessAtMs,
      lastFailureAtMs: this.state.telemetry.lastFailureAtMs,
      lastFailureCode: this.state.telemetry.lastFailureCode,
      consecutiveFailures: this.state.telemetry.consecutiveFailures,
      deliveredIncidentActive: this.state.delivered !== null,
      deliveredIncidentFingerprint: fingerprint(
        this.state.delivered?.signature ?? "",
      ),
      lastDeliveredStatus: this.state.telemetry.lastDeliveredStatus,
    };
  }

  durableState(): OperatorAlertDurableState {
    return structuredClone(this.state);
  }

  async observe(readiness: FederatedOperatorReadiness): Promise<{
    attempted: boolean;
    sent: boolean;
    notification: OperatorAlertNotification | null;
    failureCode: OperatorAlertFailureCode | null;
  }> {
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("operator alert observation time is invalid");
    }
    const alerts = normalizedAlerts(readiness);
    const signature = incidentSignature(alerts);
    if (signature !== this.observedSignature) {
      this.observedSignature = signature;
      this.observedIncidentStartedAtMs = signature ? nowMs : null;
    }

    const delivered = this.state.delivered;
    const isRecovery = signature === "" && delivered !== null;
    const changed = signature !== (delivered?.signature ?? "");
    const reminderDue =
      signature !== "" &&
      !changed &&
      delivered !== null &&
      nowMs - delivered.lastDeliveredAtMs >= this.config.reminderMs;
    const retryReady =
      this.state.telemetry.lastAttemptAtMs === null ||
      nowMs - this.state.telemetry.lastAttemptAtMs >= this.config.retryMs;

    if (
      !this.config.enabled ||
      !this.config.webhookUrl ||
      this.inFlight ||
      (!this.state.pending && !changed && !reminderDue) ||
      !retryReady
    ) {
      return {
        attempted: false,
        sent: false,
        notification: null,
        failureCode: null,
      };
    }
    if (!this.state.pending && signature === "" && !isRecovery) {
      return {
        attempted: false,
        sent: false,
        notification: null,
        failureCode: null,
      };
    }

    let pending = this.state.pending;
    if (!pending) {
      const notification: OperatorAlertNotification = isRecovery
        ? "recovered"
        : reminderDue
          ? "reminder"
          : delivered
            ? "changed"
            : "initial";
      const incidentAlerts = isRecovery ? (delivered?.alerts ?? []) : alerts;
      const incidentStartedAtMs = isRecovery
        ? delivered?.incidentStartedAtMs
        : this.observedIncidentStartedAtMs;
      const pendingSignature = isRecovery
        ? (delivered?.signature ?? "")
        : signature;
      const reminderSequence =
        notification === "reminder"
          ? (delivered?.reminderSequence ?? 0) + 1
          : 0;
      if (
        incidentStartedAtMs === null ||
        incidentStartedAtMs === undefined ||
        !pendingSignature ||
        incidentAlerts.length === 0
      ) {
        throw new Error("operator alert incident state is invalid");
      }
      const status = isRecovery ? "recovered" : "firing";
      pending = {
        deliveryId: deliveryId({
          routeId: this.config.routeId,
          signature: pendingSignature,
          status,
          notification,
          emittedAtMs: nowMs,
          incidentStartedAtMs,
          reminderSequence,
        }),
        signature: pendingSignature,
        status,
        notification,
        emittedAtMs: nowMs,
        incidentStartedAtMs,
        incidentFingerprint: fingerprint(pendingSignature)!,
        alerts: isRecovery ? [] : incidentAlerts,
        resolvedAlerts: isRecovery ? incidentAlerts : [],
        sourceAgesMs: {
          stream: safeAge(readiness.sourceAgesMs.stream),
          keeper: safeAge(readiness.sourceAgesMs.keeper),
        },
        reminderSequence,
      };
    }

    const attemptState: OperatorAlertDurableState = {
      ...this.state,
      pending,
      telemetry: {
        ...this.state.telemetry,
        lastAttemptAtMs: nowMs,
      },
    };
    if (!this.commitState(attemptState)) {
      this.recordStateFailure(attemptState, nowMs);
      return {
        attempted: false,
        sent: false,
        notification: pending.notification,
        failureCode: "state",
      };
    }

    this.inFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let failureCode: OperatorAlertFailureCode | null = null;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.webhookUrl, {
          method: "POST",
          cache: "no-store",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "idempotency-key": pending.deliveryId,
            ...(this.config.bearerToken
              ? { authorization: `Bearer ${this.config.bearerToken}` }
              : {}),
          },
          body: JSON.stringify({
            type: "HYPERBET_OPERATOR_ALERT",
            schemaVersion: 1,
            routeId: this.config.routeId,
            deliveryId: pending.deliveryId,
            status: pending.status,
            notification: pending.notification,
            emittedAtMs: pending.emittedAtMs,
            incidentStartedAtMs: pending.incidentStartedAtMs,
            incidentFingerprint: pending.incidentFingerprint,
            alerts: pending.alerts,
            resolvedAlerts: pending.resolvedAlerts,
            sourceAgesMs: pending.sourceAgesMs,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        failureCode =
          error instanceof Error && error.name === "AbortError"
            ? "timeout"
            : "network";
        throw error;
      }
      try {
        await response.body?.cancel();
      } catch {
        // The status code remains authoritative when the body is already closed.
      }
      if (!response.ok) {
        failureCode = "http-status";
        throw new Error("operator alert webhook rejected the request");
      }

      const successState: OperatorAlertDurableState = {
        ...this.state,
        delivered:
          pending.status === "recovered"
            ? null
            : {
                signature: pending.signature,
                alerts: pending.alerts,
                incidentStartedAtMs: pending.incidentStartedAtMs,
                lastDeliveredAtMs: nowMs,
                reminderSequence: pending.reminderSequence,
              },
        pending: null,
        telemetry: {
          ...this.state.telemetry,
          lastSuccessAtMs: nowMs,
          lastFailureCode: null,
          consecutiveFailures: 0,
          lastDeliveredStatus: pending.status,
        },
      };
      if (!this.commitState(successState)) {
        this.recordStateFailure(this.state, nowMs);
        return {
          attempted: true,
          sent: false,
          notification: pending.notification,
          failureCode: "state",
        };
      }
      return {
        attempted: true,
        sent: true,
        notification: pending.notification,
        failureCode: null,
      };
    } catch {
      const failedState: OperatorAlertDurableState = {
        ...this.state,
        telemetry: {
          ...this.state.telemetry,
          lastFailureAtMs: nowMs,
          lastFailureCode: failureCode ?? "network",
          consecutiveFailures: this.state.telemetry.consecutiveFailures + 1,
        },
      };
      if (!this.commitState(failedState)) {
        this.recordStateFailure(failedState, nowMs);
      }
      return {
        attempted: true,
        sent: false,
        notification: pending.notification,
        failureCode: this.state.telemetry.lastFailureCode,
      };
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }

  private commitState(nextState: OperatorAlertDurableState): boolean {
    try {
      this.dependencies.persistState?.(structuredClone(nextState));
      this.state = structuredClone(nextState);
      return true;
    } catch {
      return false;
    }
  }

  private recordStateFailure(
    baseState: OperatorAlertDurableState,
    nowMs: number,
  ): void {
    this.state = {
      ...structuredClone(baseState),
      telemetry: {
        ...baseState.telemetry,
        lastFailureAtMs: nowMs,
        lastFailureCode: "state",
        consecutiveFailures: baseState.telemetry.consecutiveFailures + 1,
      },
    };
  }
}
