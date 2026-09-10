import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildKeeperOperatorMetrics } from "./keeperOperatorMetrics";

const ownedChildren = new Set<ReturnType<typeof Bun.spawn>>();
const ownedServers = new Set<ReturnType<typeof Bun.serve>>();
const ownedDirectories = new Set<string>();

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve an isolated test port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForOperatorProjection(
  url: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const body = (await response.json()) as Record<string, unknown>;
      const projection = body.operatorMetrics as
        Record<string, unknown> | undefined;
      if (projection?.stream) return body;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `operator projection did not become available: ${String(lastError)}`,
  );
}

async function waitForServiceResponse(
  url: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`service did not become available: ${String(lastError)}`);
}

async function waitForCondition(
  description: string,
  condition: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

afterEach(async () => {
  for (const child of ownedChildren) {
    child.kill("SIGTERM");
    await child.exited;
  }
  ownedChildren.clear();
  for (const server of ownedServers) server.stop(true);
  ownedServers.clear();
  for (const directory of ownedDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  ownedDirectories.clear();
});

describe("keeper service operator readiness", () => {
  test("publishes only normalized cross-service telemetry and fails closed on a missing parser", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "hyperbet-operator-readiness-"),
    );
    ownedDirectories.add(directory);
    const sourcePort = await reservePort();
    const servicePort = await reservePort();
    const bearerToken = "operator-source-secret";
    const alertBearerToken = "operator-alert-secret";
    const alertQuerySecret = "operator-route-secret";
    let authorizedHealthRequests = 0;
    let authorizedAlertRequests = 0;
    let alertPayload: Record<string, unknown> | null = null;

    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: sourcePort,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/streaming/state") {
          return Response.json({
            type: "STREAMING_STATE_UPDATE",
            cycle: { cycleId: null, phase: "IDLE" },
            leaderboard: [],
            cameraTarget: null,
            preparation: null,
            seq: 2,
            emittedAt: Date.now(),
          });
        }
        if (url.pathname === "/api/streaming/health") {
          if (
            request.headers.get("authorization") === `Bearer ${bearerToken}`
          ) {
            authorizedHealthRequests += 1;
          }
          return Response.json({
            type: "STREAMING_RUNTIME_HEALTH",
            ready: true,
            privateCredential: "must-not-leak",
            operatorMetrics: {
              schemaVersion: 1,
              observedAtMs: Date.now(),
              ready: true,
              agesMs: {
                schedulerAuthority: 10,
                bettingFeed: 10,
                renderer: 10,
                captureClient: 10,
                encoder: 10,
                audio: 10,
                rtmpDelivery: 10,
                keeper: 10,
                projectileCostCustody: 10,
                privateCredential: "must-not-leak",
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
                privateCredential: "must-not-leak",
              },
            },
          });
        }
        if (url.pathname === "/operator-alert") {
          if (
            request.headers.get("authorization") ===
            `Bearer ${alertBearerToken}`
          ) {
            authorizedAlertRequests += 1;
          }
          alertPayload = (await request.json()) as Record<string, unknown>;
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    ownedServers.add(source);

    const observedAtMs = Date.now();
    const keeperMetrics = buildKeeperOperatorMetrics({
      nowMs: observedAtMs,
      checkpoint: {
        sourceEpoch: 1,
        lastAppliedSeq: 2,
        lastEmittedAt: observedAtMs,
        duelId: null,
        competitiveSnapshotDigest: null,
        phase: "IDLE",
        terminal: false,
        terminalEventKey: null,
        degradedReason: null,
        updatedAt: observedAtMs,
      },
      terminal: {
        summary: {
          PENDING: 0,
          PROCESSING: 0,
          SUCCEEDED: 0,
          MANUAL_REVIEW: 0,
          DEAD_LETTER: 0,
        },
        oldestActionableCreatedAt: null,
        recentSucceededDurationsMs: [],
      },
      markets: [],
    });
    const botHealthFile = path.join(directory, "bot-health.json");
    const streamStateFile = path.join(directory, "stream-state.json");
    writeFileSync(
      botHealthFile,
      JSON.stringify({
        chainKey: "solana",
        releaseCommitSha: null,
        runtime: {
          schemaVersion: 1,
          role: "duel-bot",
          cluster: "localnet",
          fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
          duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
        },
        updatedAtMs: observedAtMs,
        bootedAtMs: observedAtMs,
        running: true,
        processId: null,
        lastSuccessfulRpcAtMs: observedAtMs,
        recovery: [],
        markets: [],
        operatorMetrics: keeperMetrics,
        privateCredential: "must-not-leak",
      }),
    );
    writeFileSync(
      streamStateFile,
      JSON.stringify({
        type: "STREAMING_STATE_UPDATE",
        cycle: { cycleId: null, phase: "IDLE" },
        leaderboard: [],
        cameraTarget: null,
        preparation: null,
        seq: 1,
        emittedAt: observedAtMs,
      }),
    );

    const child = Bun.spawn([process.execPath, "--bun", "src/service.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        NODE_ENV: "development",
        HYPERBET_RUNTIME_ROLE: "service",
        PORT: String(servicePort),
        SOLANA_CLUSTER: "localnet",
        SOLANA_RPC_URL: "http://127.0.0.1:1",
        KEEPER_DB_PATH: path.join(directory, "keeper.sqlite"),
        KEEPER_BOT_HEALTH_FILE: botHealthFile,
        KEEPER_STREAM_STATE_FILE: streamStateFile,
        HYPERBET_OPERATOR_ALERT_STATE_FILE: path.join(
          directory,
          "operator-alert-state.json",
        ),
        STREAM_STATE_SOURCE_URL: `http://127.0.0.1:${sourcePort}/api/streaming/state`,
        STREAM_STATE_SOURCE_BEARER_TOKEN: bearerToken,
        STREAM_STATE_SOURCE_EVENTS_ENABLED: "false",
        STREAM_STATE_POLL_MS: "1000",
        CONTRACT_POLL_MS: "5000",
        HYPERBET_OPERATOR_ALERT_WEBHOOK_URL: `http://127.0.0.1:${sourcePort}/operator-alert?token=${alertQuerySecret}`,
        HYPERBET_OPERATOR_ALERT_BEARER_TOKEN: alertBearerToken,
        HYPERBET_OPERATOR_ALERT_ROUTE_ID: "test.primary",
        HYPERBET_OPERATOR_ALERT_MONITOR_MS: "1000",
        HYPERBET_OPERATOR_ALERT_REMINDER_MS: "10000",
        HYPERBET_OPERATOR_ALERT_RETRY_MS: "1000",
        HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: "500",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    ownedChildren.add(child);

    const body = await waitForOperatorProjection(
      `http://127.0.0.1:${servicePort}/api/operator/readiness`,
    );
    expect(body.ok).toBe(false);
    expect(authorizedHealthRequests).toBeGreaterThan(0);
    expect(body).toMatchObject({
      service: "hyperbet-solana-backend",
      operatorMetrics: {
        schemaVersion: 1,
        stream: { schemaVersion: 1, ready: true },
        keeper: { schemaVersion: 1 },
        federated: {
          schemaVersion: 1,
          ready: false,
          alerts: [
            {
              code: "service-readiness-failed",
              severity: "critical",
              source: "service",
            },
          ],
        },
        transport: {
          configured: true,
          lastFailureCode: null,
        },
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain("SOLANA_RPC_URL");

    await waitForCondition(
      "operator alert delivery",
      () => alertPayload !== null,
    );
    expect(authorizedAlertRequests).toBe(1);
    expect(alertPayload).toMatchObject({
      type: "HYPERBET_OPERATOR_ALERT",
      schemaVersion: 1,
      routeId: "test.primary",
      status: "firing",
      notification: "initial",
      alerts: [
        {
          code: "service-readiness-failed",
          severity: "critical",
          source: "service",
        },
      ],
      resolvedAlerts: [],
    });
    const serializedAlert = JSON.stringify(alertPayload);
    expect(serializedAlert).not.toContain(bearerToken);
    expect(serializedAlert).not.toContain(alertBearerToken);
    expect(serializedAlert).not.toContain(alertQuerySecret);
    expect(serializedAlert).not.toContain("must-not-leak");

    const postDeliveryResponse = await fetch(
      `http://127.0.0.1:${servicePort}/api/operator/readiness`,
      { cache: "no-store" },
    );
    const postDeliveryBody = (await postDeliveryResponse.json()) as Record<
      string,
      unknown
    >;
    expect(postDeliveryBody).toMatchObject({
      operatorMetrics: {
        alertDelivery: {
          schemaVersion: 1,
          configured: true,
          inFlight: false,
          lastFailureCode: null,
          consecutiveFailures: 0,
          deliveredIncidentActive: true,
          lastDeliveredStatus: "firing",
        },
      },
    });
    const serializedPostDelivery = JSON.stringify(postDeliveryBody);
    expect(serializedPostDelivery).not.toContain(alertBearerToken);
    expect(serializedPostDelivery).not.toContain(alertQuerySecret);
  }, 30_000);

  test("waits for an in-flight operator alert before a clean SIGTERM exit", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "hyperbet-operator-alert-shutdown-"),
    );
    ownedDirectories.add(directory);
    const alertPort = await reservePort();
    const servicePort = await reservePort();
    let deliveryStartedResolve: (() => void) | null = null;
    const deliveryStarted = new Promise<void>((resolve) => {
      deliveryStartedResolve = resolve;
    });
    let releaseDeliveryResolve: (() => void) | null = null;
    const releaseDelivery = new Promise<void>((resolve) => {
      releaseDeliveryResolve = resolve;
    });
    let completedDeliveries = 0;

    const receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: alertPort,
      async fetch(request) {
        await request.json();
        deliveryStartedResolve?.();
        await releaseDelivery;
        completedDeliveries += 1;
        return new Response(null, { status: 204 });
      },
    });
    ownedServers.add(receiver);

    const child = Bun.spawn([process.execPath, "--bun", "src/service.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        NODE_ENV: "development",
        HYPERBET_RUNTIME_ROLE: "service",
        PORT: String(servicePort),
        SOLANA_CLUSTER: "localnet",
        SOLANA_RPC_URL: "http://127.0.0.1:1",
        KEEPER_DB_PATH: path.join(directory, "keeper.sqlite"),
        KEEPER_BOT_HEALTH_FILE: path.join(directory, "missing-health.json"),
        KEEPER_STREAM_STATE_FILE: path.join(directory, "missing-stream.json"),
        HYPERBET_OPERATOR_ALERT_STATE_FILE: path.join(
          directory,
          "operator-alert-state.json",
        ),
        CONTRACT_POLL_MS: "5000",
        HYPERBET_OPERATOR_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertPort}/operator-alert`,
        HYPERBET_OPERATOR_ALERT_ROUTE_ID: "test.shutdown",
        HYPERBET_OPERATOR_ALERT_MONITOR_MS: "1000",
        HYPERBET_OPERATOR_ALERT_REMINDER_MS: "10000",
        HYPERBET_OPERATOR_ALERT_RETRY_MS: "1000",
        HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: "1000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    ownedChildren.add(child);

    await deliveryStarted;
    child.kill("SIGTERM");
    const exitedBeforeDelivery = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(100).then(() => false),
    ]);
    expect(exitedBeforeDelivery).toBe(false);
    releaseDeliveryResolve?.();
    expect(await child.exited).toBe(0);
    ownedChildren.delete(child);
    expect(completedDeliveries).toBe(1);
  }, 30_000);

  test("hydrates accepted alert custody without duplicating after restart", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "hyperbet-operator-alert-restart-"),
    );
    ownedDirectories.add(directory);
    const alertPort = await reservePort();
    const servicePort = await reservePort();
    const statePath = path.join(directory, "operator-alert-state.json");
    let deliveries = 0;

    const receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: alertPort,
      async fetch(request) {
        await request.json();
        deliveries += 1;
        return new Response(null, { status: 204 });
      },
    });
    ownedServers.add(receiver);

    const childEnvironment = {
      NODE_ENV: "development",
      HYPERBET_RUNTIME_ROLE: "service",
      PORT: String(servicePort),
      SOLANA_CLUSTER: "localnet",
      SOLANA_RPC_URL: "http://127.0.0.1:1",
      KEEPER_DB_PATH: path.join(directory, "keeper.sqlite"),
      KEEPER_BOT_HEALTH_FILE: path.join(directory, "missing-health.json"),
      KEEPER_STREAM_STATE_FILE: path.join(directory, "missing-stream.json"),
      HYPERBET_OPERATOR_ALERT_STATE_FILE: statePath,
      CONTRACT_POLL_MS: "5000",
      HYPERBET_OPERATOR_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertPort}/operator-alert`,
      HYPERBET_OPERATOR_ALERT_ROUTE_ID: "test.restart",
      HYPERBET_OPERATOR_ALERT_MONITOR_MS: "1000",
      HYPERBET_OPERATOR_ALERT_REMINDER_MS: "10000",
      HYPERBET_OPERATOR_ALERT_RETRY_MS: "1000",
      HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: "500",
    } as const;
    const spawnService = () => {
      const child = Bun.spawn([process.execPath, "--bun", "src/service.ts"], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: childEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      });
      ownedChildren.add(child);
      return child;
    };

    const first = spawnService();
    await waitForCondition("first durable alert delivery", () => {
      if (deliveries !== 1) return false;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as {
          delivered?: unknown;
          pending?: unknown;
        };
        return state.delivered != null && state.pending === null;
      } catch {
        return false;
      }
    });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const serializedState = readFileSync(statePath, "utf8");
    expect(serializedState).not.toContain("operator-alert-secret");
    expect(serializedState).not.toContain("127.0.0.1");
    first.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    ownedChildren.delete(first);

    const replacement = spawnService();
    await waitForServiceResponse(
      `http://127.0.0.1:${servicePort}/api/operator/readiness`,
    );
    await Bun.sleep(1_500);
    expect(deliveries).toBe(1);
    const response = await fetch(
      `http://127.0.0.1:${servicePort}/api/operator/readiness`,
      { cache: "no-store" },
    );
    expect(await response.json()).toMatchObject({
      operatorMetrics: {
        alertDelivery: {
          configured: true,
          deliveredIncidentActive: true,
          lastDeliveredStatus: "firing",
        },
      },
    });
    replacement.kill("SIGTERM");
    expect(await replacement.exited).toBe(0);
    ownedChildren.delete(replacement);
  }, 30_000);

  test("replays the same durable delivery ID after an ambiguous process crash", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "hyperbet-operator-alert-crash-"),
    );
    ownedDirectories.add(directory);
    const alertPort = await reservePort();
    const servicePort = await reservePort();
    const statePath = path.join(directory, "operator-alert-state.json");
    const deliveryIds: string[] = [];
    const idempotencyKeys: string[] = [];
    let releaseFirstResponse: (() => void) | null = null;
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });

    const receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: alertPort,
      async fetch(request) {
        const payload = (await request.json()) as { deliveryId?: unknown };
        deliveryIds.push(String(payload.deliveryId));
        idempotencyKeys.push(
          request.headers.get("idempotency-key") ?? "missing",
        );
        if (deliveryIds.length === 1) await firstResponseGate;
        return new Response(null, { status: 204 });
      },
    });
    ownedServers.add(receiver);

    const childEnvironment = {
      NODE_ENV: "development",
      HYPERBET_RUNTIME_ROLE: "service",
      PORT: String(servicePort),
      SOLANA_CLUSTER: "localnet",
      SOLANA_RPC_URL: "http://127.0.0.1:1",
      KEEPER_DB_PATH: path.join(directory, "keeper.sqlite"),
      KEEPER_BOT_HEALTH_FILE: path.join(directory, "missing-health.json"),
      KEEPER_STREAM_STATE_FILE: path.join(directory, "missing-stream.json"),
      HYPERBET_OPERATOR_ALERT_STATE_FILE: statePath,
      CONTRACT_POLL_MS: "5000",
      HYPERBET_OPERATOR_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertPort}/operator-alert`,
      HYPERBET_OPERATOR_ALERT_ROUTE_ID: "test.crash",
      HYPERBET_OPERATOR_ALERT_MONITOR_MS: "1000",
      HYPERBET_OPERATOR_ALERT_REMINDER_MS: "10000",
      HYPERBET_OPERATOR_ALERT_RETRY_MS: "1000",
      HYPERBET_OPERATOR_ALERT_TIMEOUT_MS: "1000",
    } as const;
    const spawnService = () => {
      const child = Bun.spawn([process.execPath, "--bun", "src/service.ts"], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: childEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      });
      ownedChildren.add(child);
      return child;
    };

    const first = spawnService();
    await waitForCondition("persisted in-flight alert delivery", () => {
      if (deliveryIds.length !== 1) return false;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as {
          pending?: { deliveryId?: unknown } | null;
        };
        return state.pending?.deliveryId === deliveryIds[0];
      } catch {
        return false;
      }
    });
    first.kill("SIGKILL");
    expect(await first.exited).not.toBe(0);
    ownedChildren.delete(first);
    releaseFirstResponse?.();

    const replacement = spawnService();
    await waitForCondition("replayed alert delivery", () => {
      if (deliveryIds.length !== 2) return false;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as {
          delivered?: unknown;
          pending?: unknown;
        };
        return state.delivered != null && state.pending === null;
      } catch {
        return false;
      }
    });
    expect(deliveryIds).toHaveLength(2);
    expect(deliveryIds[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(deliveryIds[1]).toBe(deliveryIds[0]);
    expect(idempotencyKeys).toEqual(deliveryIds);

    replacement.kill("SIGTERM");
    expect(await replacement.exited).toBe(0);
    ownedChildren.delete(replacement);
  }, 30_000);
});
