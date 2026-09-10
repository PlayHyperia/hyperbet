import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";

import { assertLaunchCluster } from "./keeperBackup";
import {
  assertOperatorAlertRouteId,
  type OperatorAlertDurableState,
  type OperatorAlertNotification,
} from "./operatorAlertDispatcher";
import {
  loadOperatorAlertDurableState,
  persistOperatorAlertDurableState,
} from "./operatorAlertStateStore";

type LaunchCluster = "devnet" | "mainnet-beta";

type OperatorAlertStateSummary = {
  deliveredIncidentActive: boolean;
  deliveredIncidentFingerprint: string | null;
  pendingDeliveryActive: boolean;
  pendingDeliveryId: string | null;
  pendingStatus: "firing" | "recovered" | null;
  pendingNotification: OperatorAlertNotification | null;
  lastDeliveredStatus: "firing" | "recovered" | null;
};

export type OperatorAlertStateBackupEvidence = OperatorAlertStateSummary & {
  schemaVersion: 1;
  createdAt: string;
  releaseSha: string;
  cluster: LaunchCluster;
  routeId: string;
  stateSchemaVersion: 1;
  sourceStateFileName: string;
  backupFileName: string;
  backupSha256: string;
  backupBytes: number;
};

type CreateOperatorAlertStateBackupInput = {
  sourcePath: string;
  backupPath: string;
  evidencePath: string;
  releaseSha: string;
  cluster: LaunchCluster;
  routeId: string;
  now?: () => Date;
  beforeSourceRecheck?: () => void;
};

type VerifyOperatorAlertStateBackupInput = {
  backupPath: string;
  evidencePath: string;
  expectedReleaseSha: string;
  expectedCluster: LaunchCluster;
  expectedRouteId: string;
};

type RestoreOperatorAlertStateBackupInput =
  VerifyOperatorAlertStateBackupInput & {
    destinationPath: string;
  };

const MAX_EVIDENCE_BYTES = 32 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function assertReleaseSha(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(
      "release SHA must be one full lowercase 40-character commit SHA",
    );
  }
  return normalized;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafeFileName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    path.basename(value) !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertPrivateRegularFile(
  filePath: string,
  label: string,
  maximumBytes: number,
): Stats {
  const stats = lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.size <= 0 ||
    stats.size > maximumBytes ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
  return stats;
}

function readPrivateBytes(
  filePath: string,
  label: string,
  maximumBytes: number,
): Buffer {
  const pathStats = assertPrivateRegularFile(filePath, label, maximumBytes);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size !== pathStats.size ||
      (openedStats.mode & 0o777) !== 0o600
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return readFileSync(descriptor);
  } catch {
    throw new Error(`${label} has invalid file identity`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readPrivateJson(filePath: string, label: string): unknown {
  const bytes = readPrivateBytes(filePath, label, MAX_EVIDENCE_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} has invalid JSON`);
  }
}

function validateOutputPath(filePath: string, label: string): string {
  const absolutePath = path.resolve(filePath);
  if (existsSync(absolutePath)) throw new Error(`${label} already exists`);
  let parent: ReturnType<typeof statSync>;
  try {
    parent = statSync(path.dirname(absolutePath));
  } catch {
    throw new Error(`${label} parent must be a directory`);
  }
  if (!parent.isDirectory()) {
    throw new Error(`${label} parent must be a directory`);
  }
  return absolutePath;
}

function fsyncParent(filePath: string): void {
  const descriptor = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateJsonExclusive(filePath: string, value: unknown): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    fsyncParent(filePath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sha256File(filePath: string): string {
  return createHash("sha256")
    .update(
      readPrivateBytes(filePath, "operator alert state backup", 64 * 1024),
    )
    .digest("hex");
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function summarizeState(
  state: OperatorAlertDurableState,
): OperatorAlertStateSummary {
  return {
    deliveredIncidentActive: state.delivered !== null,
    deliveredIncidentFingerprint: state.delivered
      ? createHash("sha256").update(state.delivered.signature).digest("hex")
      : null,
    pendingDeliveryActive: state.pending !== null,
    pendingDeliveryId: state.pending?.deliveryId ?? null,
    pendingStatus: state.pending?.status ?? null,
    pendingNotification: state.pending?.notification ?? null,
    lastDeliveredStatus: state.telemetry.lastDeliveredStatus,
  };
}

function loadRequiredState(
  statePath: string,
  routeId: string,
): OperatorAlertDurableState {
  const state = loadOperatorAlertDurableState({ statePath, routeId });
  if (!state) throw new Error("operator alert state file does not exist");
  return state;
}

function parseEvidence(filePath: string): OperatorAlertStateBackupEvidence {
  const value = readPrivateJson(filePath, "operator alert backup evidence");
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "releaseSha",
      "cluster",
      "routeId",
      "stateSchemaVersion",
      "sourceStateFileName",
      "backupFileName",
      "backupSha256",
      "backupBytes",
      "deliveredIncidentActive",
      "deliveredIncidentFingerprint",
      "pendingDeliveryActive",
      "pendingDeliveryId",
      "pendingStatus",
      "pendingNotification",
      "lastDeliveredStatus",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.releaseSha !== "string" ||
    typeof value.cluster !== "string" ||
    typeof value.routeId !== "string" ||
    value.stateSchemaVersion !== 1 ||
    typeof value.backupSha256 !== "string" ||
    !SHA256_PATTERN.test(String(value.backupSha256)) ||
    !Number.isSafeInteger(value.backupBytes) ||
    Number(value.backupBytes) <= 0 ||
    typeof value.deliveredIncidentActive !== "boolean" ||
    !(
      value.deliveredIncidentFingerprint === null ||
      SHA256_PATTERN.test(String(value.deliveredIncidentFingerprint))
    ) ||
    typeof value.pendingDeliveryActive !== "boolean" ||
    !(
      value.pendingDeliveryId === null ||
      SHA256_PATTERN.test(String(value.pendingDeliveryId))
    ) ||
    ![null, "firing", "recovered"].includes(value.pendingStatus as never) ||
    ![null, "initial", "changed", "reminder", "recovered"].includes(
      value.pendingNotification as never,
    ) ||
    ![null, "firing", "recovered"].includes(
      value.lastDeliveredStatus as never,
    ) ||
    value.deliveredIncidentActive !==
      (value.deliveredIncidentFingerprint !== null) ||
    value.pendingDeliveryActive !== (value.pendingDeliveryId !== null) ||
    value.pendingDeliveryActive !== (value.pendingStatus !== null) ||
    value.pendingDeliveryActive !== (value.pendingNotification !== null)
  ) {
    throw new Error("operator alert backup evidence has an invalid schema");
  }
  const releaseSha = assertReleaseSha(String(value.releaseSha));
  const cluster = assertLaunchCluster(String(value.cluster));
  const routeId = assertOperatorAlertRouteId(String(value.routeId));
  const sourceStateFileName = assertSafeFileName(
    value.sourceStateFileName,
    "source state filename",
  );
  const backupFileName = assertSafeFileName(
    value.backupFileName,
    "backup filename",
  );
  return {
    ...(value as OperatorAlertStateBackupEvidence),
    releaseSha,
    cluster,
    routeId,
    sourceStateFileName,
    backupFileName,
  };
}

export async function createOperatorAlertStateBackup(
  input: CreateOperatorAlertStateBackupInput,
): Promise<OperatorAlertStateBackupEvidence> {
  const releaseSha = assertReleaseSha(input.releaseSha);
  const cluster = assertLaunchCluster(input.cluster);
  const routeId = assertOperatorAlertRouteId(input.routeId);
  const sourcePath = path.resolve(input.sourcePath);
  const backupPath = validateOutputPath(input.backupPath, "backup path");
  const evidencePath = validateOutputPath(input.evidencePath, "evidence path");
  if (new Set([sourcePath, backupPath, evidencePath]).size !== 3) {
    throw new Error("source, backup, and evidence paths must be distinct");
  }

  const sourceState = loadRequiredState(sourcePath, routeId);
  const stagingDirectory = mkdtempSync(
    path.join(
      path.dirname(backupPath),
      `.${path.basename(backupPath)}.private-`,
    ),
  );
  const stagedBackupPath = path.join(stagingDirectory, "alert-state.json");
  let backupPublished = false;
  let evidencePublished = false;
  try {
    persistOperatorAlertDurableState(stagedBackupPath, sourceState);
    const stagedState = loadRequiredState(stagedBackupPath, routeId);
    if (JSON.stringify(stagedState) !== JSON.stringify(sourceState)) {
      throw new Error("operator alert backup does not match its source state");
    }

    input.beforeSourceRecheck?.();
    const recheckedSource = loadRequiredState(sourcePath, routeId);
    if (JSON.stringify(recheckedSource) !== JSON.stringify(sourceState)) {
      throw new Error(
        "operator alert state changed while the backup was being created",
      );
    }

    linkSync(stagedBackupPath, backupPath);
    backupPublished = true;
    fsyncParent(backupPath);
    const backupStats = assertPrivateRegularFile(
      backupPath,
      "operator alert state backup",
      64 * 1024,
    );
    const evidence: OperatorAlertStateBackupEvidence = {
      schemaVersion: 1,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      releaseSha,
      cluster,
      routeId,
      stateSchemaVersion: 1,
      sourceStateFileName: path.basename(sourcePath),
      backupFileName: path.basename(backupPath),
      backupSha256: sha256File(backupPath),
      backupBytes: backupStats.size,
      ...summarizeState(stagedState),
    };
    writePrivateJsonExclusive(evidencePath, evidence);
    evidencePublished = true;
    return await verifyOperatorAlertStateBackup({
      backupPath,
      evidencePath,
      expectedReleaseSha: releaseSha,
      expectedCluster: cluster,
      expectedRouteId: routeId,
    });
  } catch (error) {
    if (evidencePublished) unlinkSync(evidencePath);
    if (backupPublished) unlinkSync(backupPath);
    throw error;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

export async function verifyOperatorAlertStateBackup(
  input: VerifyOperatorAlertStateBackupInput,
): Promise<OperatorAlertStateBackupEvidence> {
  const backupPath = path.resolve(input.backupPath);
  const evidencePath = path.resolve(input.evidencePath);
  const evidence = parseEvidence(evidencePath);
  if (evidence.releaseSha !== assertReleaseSha(input.expectedReleaseSha)) {
    throw new Error("backup release SHA does not match the expected release");
  }
  if (evidence.cluster !== assertLaunchCluster(input.expectedCluster)) {
    throw new Error("backup cluster does not match the expected cluster");
  }
  const routeId = assertOperatorAlertRouteId(input.expectedRouteId);
  if (evidence.routeId !== routeId) {
    throw new Error("backup route ID does not match the expected route");
  }
  if (evidence.backupFileName !== path.basename(backupPath)) {
    throw new Error("backup filename does not match its evidence");
  }
  const backupStats = assertPrivateRegularFile(
    backupPath,
    "operator alert state backup",
    64 * 1024,
  );
  if (backupStats.size !== evidence.backupBytes) {
    throw new Error("backup byte size does not match its evidence");
  }
  if (sha256File(backupPath) !== evidence.backupSha256) {
    throw new Error("backup SHA-256 does not match its evidence");
  }
  const state = loadRequiredState(backupPath, routeId);
  if (
    JSON.stringify(summarizeState(state)) !==
    JSON.stringify({
      deliveredIncidentActive: evidence.deliveredIncidentActive,
      deliveredIncidentFingerprint: evidence.deliveredIncidentFingerprint,
      pendingDeliveryActive: evidence.pendingDeliveryActive,
      pendingDeliveryId: evidence.pendingDeliveryId,
      pendingStatus: evidence.pendingStatus,
      pendingNotification: evidence.pendingNotification,
      lastDeliveredStatus: evidence.lastDeliveredStatus,
    })
  ) {
    throw new Error("backup state does not match its evidence");
  }
  return evidence;
}

export async function restoreOperatorAlertStateBackup(
  input: RestoreOperatorAlertStateBackupInput,
): Promise<OperatorAlertStateBackupEvidence> {
  const evidence = await verifyOperatorAlertStateBackup(input);
  const destinationPath = validateOutputPath(
    input.destinationPath,
    "restore destination",
  );
  const state = loadRequiredState(
    path.resolve(input.backupPath),
    evidence.routeId,
  );
  const stagingDirectory = mkdtempSync(
    path.join(
      path.dirname(destinationPath),
      `.${path.basename(destinationPath)}.restore-`,
    ),
  );
  const stagedStatePath = path.join(stagingDirectory, "alert-state.json");
  let destinationPublished = false;
  try {
    persistOperatorAlertDurableState(stagedStatePath, state);
    linkSync(stagedStatePath, destinationPath);
    destinationPublished = true;
    fsyncParent(destinationPath);
    const restoredState = loadRequiredState(destinationPath, evidence.routeId);
    if (JSON.stringify(restoredState) !== JSON.stringify(state)) {
      throw new Error(
        "restored operator alert state does not match its backup",
      );
    }
    return evidence;
  } catch (error) {
    if (destinationPublished) unlinkSync(destinationPath);
    throw error;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
