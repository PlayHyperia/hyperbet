import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createInitialOperatorAlertDurableState,
  OperatorAlertDispatcher,
  type OperatorAlertDurableState,
} from "./operatorAlertDispatcher";
import {
  createOperatorAlertStateBackup,
  restoreOperatorAlertStateBackup,
  verifyOperatorAlertStateBackup,
} from "./operatorAlertStateBackup";
import { runOperatorAlertStateBackupCli } from "./operatorAlertStateBackupCli";
import {
  loadOperatorAlertDurableState,
  persistOperatorAlertDurableState,
} from "./operatorAlertStateStore";

const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
const ROUTE_ID = "test.primary";

async function alertState(
  responseStatus: 204 | 503,
): Promise<OperatorAlertDurableState> {
  const dispatcher = new OperatorAlertDispatcher(
    {
      enabled: true,
      webhookUrl: "https://alerts.example/operator",
      bearerToken: "must-not-enter-state",
      routeId: ROUTE_ID,
      monitorIntervalMs: 1_000,
      reminderMs: 10_000,
      retryMs: 1_000,
      timeoutMs: 250,
    },
    {
      now: () => 10_000,
      fetchImpl: async () => new Response(null, { status: responseStatus }),
    },
  );
  await dispatcher.observe({
    schemaVersion: 1,
    observedAtMs: 9_500,
    ready: false,
    sourceAgesMs: { stream: 100, keeper: 200 },
    alerts: [
      {
        code: "stream-operations-unavailable",
        severity: "critical",
        source: "stream",
      },
    ],
  });
  return dispatcher.durableState();
}

describe("operator alert state backup", () => {
  let directory: string;
  let sourcePath: string;
  let backupPath: string;
  let evidencePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "operator-alert-backup-"));
    sourcePath = path.join(directory, "operator-alert-state.json");
    backupPath = path.join(directory, "operator-alert-state.backup.json");
    evidencePath = path.join(directory, "operator-alert-state.evidence.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("creates, verifies, and restores an exact private pending delivery", async () => {
    const state = await alertState(503);
    persistOperatorAlertDurableState(sourcePath, state);
    const evidence = await createOperatorAlertStateBackup({
      sourcePath,
      backupPath,
      evidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      routeId: ROUTE_ID,
      now: () => new Date("2026-08-26T20:00:00.000Z"),
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      createdAt: "2026-08-26T20:00:00.000Z",
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      routeId: ROUTE_ID,
      deliveredIncidentActive: false,
      pendingDeliveryActive: true,
      pendingDeliveryId: state.pending?.deliveryId,
      pendingStatus: "firing",
      pendingNotification: "initial",
    });
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
    const serializedEvidence = readFileSync(evidencePath, "utf8");
    expect(serializedEvidence).not.toContain(directory);
    expect(serializedEvidence).not.toContain("must-not-enter-state");
    expect(serializedEvidence).not.toContain("alerts.example");

    persistOperatorAlertDurableState(
      sourcePath,
      createInitialOperatorAlertDurableState(ROUTE_ID),
    );
    expect(
      await verifyOperatorAlertStateBackup({
        backupPath,
        evidencePath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
        expectedRouteId: ROUTE_ID,
      }),
    ).toEqual(evidence);

    const destinationPath = path.join(directory, "restored", "state.json");
    expect(() => statSync(path.dirname(destinationPath))).toThrow();
    await expect(
      restoreOperatorAlertStateBackup({
        backupPath,
        evidencePath,
        destinationPath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
        expectedRouteId: ROUTE_ID,
      }),
    ).rejects.toThrow("parent must be a directory");

    const restoreDirectory = path.dirname(destinationPath);
    mkdirSync(restoreDirectory);
    await restoreOperatorAlertStateBackup({
      backupPath,
      evidencePath,
      destinationPath,
      expectedReleaseSha: RELEASE_SHA,
      expectedCluster: "devnet",
      expectedRouteId: ROUTE_ID,
    });
    expect(statSync(destinationPath).mode & 0o777).toBe(0o600);
    expect(
      loadOperatorAlertDurableState({
        statePath: destinationPath,
        routeId: ROUTE_ID,
      }),
    ).toEqual(state);
    await expect(
      restoreOperatorAlertStateBackup({
        backupPath,
        evidencePath,
        destinationPath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
        expectedRouteId: ROUTE_ID,
      }),
    ).rejects.toThrow("already exists");
  });

  test("retains accepted incident custody and its redacted fingerprint", async () => {
    const state = await alertState(204);
    persistOperatorAlertDurableState(sourcePath, state);
    const evidence = await createOperatorAlertStateBackup({
      sourcePath,
      backupPath,
      evidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "mainnet-beta",
      routeId: ROUTE_ID,
    });
    expect(evidence).toMatchObject({
      cluster: "mainnet-beta",
      deliveredIncidentActive: true,
      pendingDeliveryActive: false,
      pendingDeliveryId: null,
      pendingStatus: null,
      pendingNotification: null,
      lastDeliveredStatus: "firing",
    });
    expect(evidence.deliveredIncidentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(evidencePath, "utf8")).not.toContain(
      "must-not-enter-state",
    );
  });

  test("refuses overwrite, identity drift, permissive files, and tampering", async () => {
    persistOperatorAlertDurableState(
      sourcePath,
      createInitialOperatorAlertDurableState(ROUTE_ID),
    );
    await createOperatorAlertStateBackup({
      sourcePath,
      backupPath,
      evidencePath,
      releaseSha: RELEASE_SHA,
      cluster: "devnet",
      routeId: ROUTE_ID,
    });

    await expect(
      createOperatorAlertStateBackup({
        sourcePath,
        backupPath,
        evidencePath: path.join(directory, "other-evidence.json"),
        releaseSha: RELEASE_SHA,
        cluster: "devnet",
        routeId: ROUTE_ID,
      }),
    ).rejects.toThrow("backup path already exists");
    for (const drift of [
      {
        expectedReleaseSha: "abcdef1234567890abcdef1234567890abcdef12",
        expectedCluster: "devnet" as const,
        expectedRouteId: ROUTE_ID,
      },
      {
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "mainnet-beta" as const,
        expectedRouteId: ROUTE_ID,
      },
      {
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet" as const,
        expectedRouteId: "different.route",
      },
    ]) {
      await expect(
        verifyOperatorAlertStateBackup({
          backupPath,
          evidencePath,
          ...drift,
        }),
      ).rejects.toThrow(/release SHA|cluster|route ID/u);
    }

    chmodSync(evidencePath, 0o644);
    await expect(
      verifyOperatorAlertStateBackup({
        backupPath,
        evidencePath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
        expectedRouteId: ROUTE_ID,
      }),
    ).rejects.toThrow("mode-0600");
    chmodSync(evidencePath, 0o600);

    const originalEvidence = readFileSync(evidencePath, "utf8");
    const contradictoryEvidence = JSON.parse(originalEvidence) as Record<
      string,
      unknown
    >;
    contradictoryEvidence.pendingDeliveryActive = true;
    writeFileSync(evidencePath, `${JSON.stringify(contradictoryEvidence)}\n`, {
      mode: 0o600,
    });
    await expect(
      verifyOperatorAlertStateBackup({
        backupPath,
        evidencePath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
        expectedRouteId: ROUTE_ID,
      }),
    ).rejects.toThrow("invalid schema");
    writeFileSync(evidencePath, originalEvidence, { mode: 0o600 });

    chmodSync(backupPath, 0o644);
    await expect(
      verifyOperatorAlertStateBackup({
        backupPath,
        evidencePath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
        expectedRouteId: ROUTE_ID,
      }),
    ).rejects.toThrow("mode-0600");
    chmodSync(backupPath, 0o600);
    writeFileSync(backupPath, "{}\n", { mode: 0o600 });
    await expect(
      verifyOperatorAlertStateBackup({
        backupPath,
        evidencePath,
        expectedReleaseSha: RELEASE_SHA,
        expectedCluster: "devnet",
        expectedRouteId: ROUTE_ID,
      }),
    ).rejects.toThrow(/byte size|SHA-256/u);
  });

  test("rejects source mutation without publishing a partial recovery set", async () => {
    persistOperatorAlertDurableState(
      sourcePath,
      createInitialOperatorAlertDurableState(ROUTE_ID),
    );
    const changedState = await alertState(503);
    await expect(
      createOperatorAlertStateBackup({
        sourcePath,
        backupPath,
        evidencePath,
        releaseSha: RELEASE_SHA,
        cluster: "devnet",
        routeId: ROUTE_ID,
        beforeSourceRecheck: () => {
          persistOperatorAlertDurableState(sourcePath, changedState);
        },
      }),
    ).rejects.toThrow("changed while the backup was being created");
    expect(() => statSync(backupPath)).toThrow();
    expect(() => statSync(evidencePath)).toThrow();
    expect(
      readdirSync(directory).some(
        (entry) => entry.includes(".private-") || entry.includes(".restore-"),
      ),
    ).toBe(false);
  });

  test("runs create, verify, and no-overwrite restore through the operator CLI", async () => {
    persistOperatorAlertDurableState(sourcePath, await alertState(503));
    const commonArguments = [
      `--backup=${backupPath}`,
      `--evidence=${evidencePath}`,
      `--release-sha=${RELEASE_SHA}`,
      "--cluster=devnet",
      `--route-id=${ROUTE_ID}`,
    ];
    const created = await runOperatorAlertStateBackupCli([
      "bun",
      "operatorAlertStateBackupCli.ts",
      "create",
      `--source=${sourcePath}`,
      ...commonArguments,
    ]);
    expect(created).toMatchObject({
      ok: true,
      action: "create",
      routeId: ROUTE_ID,
      pendingDeliveryActive: true,
    });
    expect(JSON.stringify(created)).not.toContain(directory);

    const verified = await runOperatorAlertStateBackupCli([
      "bun",
      "operatorAlertStateBackupCli.ts",
      "verify",
      ...commonArguments,
    ]);
    expect(verified).toMatchObject({
      ok: true,
      action: "verify",
      routeId: ROUTE_ID,
    });

    const destinationPath = path.join(directory, "cli-restored.json");
    const restored = await runOperatorAlertStateBackupCli([
      "bun",
      "operatorAlertStateBackupCli.ts",
      "restore",
      `--destination=${destinationPath}`,
      ...commonArguments,
    ]);
    expect(restored).toMatchObject({
      ok: true,
      action: "restore",
      pendingDeliveryActive: true,
    });
    expect(statSync(destinationPath).mode & 0o777).toBe(0o600);

    await expect(
      runOperatorAlertStateBackupCli([
        "bun",
        "operatorAlertStateBackupCli.ts",
        "restore",
        `--destination=${destinationPath}`,
        ...commonArguments,
      ]),
    ).rejects.toThrow("restore destination already exists");
  });
});
