import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import {
  inspectKeeperDatabaseSnapshot,
  sameKeeperDatabaseInspection,
  verifyKeeperBackup,
} from "./keeperBackup";
import { verifyKeeperRecoverySet } from "./keeperRecoverySet";
import { loadOperatorAlertDurableState } from "./operatorAlertStateStore";

type LaunchCluster = "devnet" | "mainnet-beta";

type RecoverySetSource = {
  keeperBackupPath: string;
  keeperEvidencePath: string;
  operatorAlertBackupPath: string;
  operatorAlertEvidencePath: string;
  manifestPath: string;
  expectedReleaseSha: string;
  expectedCluster: LaunchCluster;
  expectedOperatorAlertRouteId: string;
  expectedBoundaryId: string;
};

type MaterializedFile = {
  relativePath: string;
  sha256: string;
  bytes: number;
};

export type KeeperRecoveryMaterializationRecord = {
  schemaVersion: 1;
  createdAt: string;
  materializationId: string;
  recoverySetId: string;
  boundaryId: string;
  releaseSha: string;
  cluster: LaunchCluster;
  operatorAlertRouteId: string;
  sourceRecoveryManifestSha256: string;
  verificationScope: "isolated_restore_materialization_only";
  activationRequiresSeparateApproval: true;
  files: {
    keeperDatabase: MaterializedFile;
    operatorAlertState: MaterializedFile;
  };
};

type MaterializeKeeperRecoverySetInput = RecoverySetSource & {
  destinationContainerPath: string;
  now?: () => Date;
  createId?: () => string;
  beforePublish?: () => void | Promise<void>;
};

type VerifyMaterializedKeeperRecoverySetInput = RecoverySetSource & {
  materializedRootPath: string;
};

const MATERIALIZED_ROOT_NAME = "active";
const MATERIALIZATION_RECORD_NAME = "recovery-materialization.json";
const KEEPER_DATABASE_RELATIVE_PATH = "keeper.sqlite";
const OPERATOR_ALERT_STATE_RELATIVE_PATH = "status/operator-alert-state.json";
const MAX_RECORD_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertPrivateRegularFile(
  filePath: string,
  label: string,
  maximumBytes: number,
) {
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

function assertPrivateDirectory(directoryPath: string, label: string): void {
  const stats = lstatSync(directoryPath);
  if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be a mode-0700 directory`);
  }
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function bindPrivateFile(
  filePath: string,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Omit<MaterializedFile, "relativePath"> {
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
      throw new Error(`${label} changed while it was being hashed`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      bytes += read;
      hash.update(buffer.subarray(0, read));
    }
    const finalStats = fstatSync(descriptor);
    if (
      bytes !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being hashed`);
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function copyPrivateFile(
  sourcePath: string,
  destinationPath: string,
  label: string,
): Omit<MaterializedFile, "relativePath"> {
  const sourcePathStats = assertPrivateRegularFile(
    sourcePath,
    label,
    Number.MAX_SAFE_INTEGER,
  );
  let sourceDescriptor: number | null = null;
  let destinationDescriptor: number | null = null;
  try {
    sourceDescriptor = openSync(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedSourceStats = fstatSync(sourceDescriptor);
    if (
      !openedSourceStats.isFile() ||
      openedSourceStats.dev !== sourcePathStats.dev ||
      openedSourceStats.ino !== sourcePathStats.ino ||
      openedSourceStats.size !== sourcePathStats.size ||
      (openedSourceStats.mode & 0o777) !== 0o600
    ) {
      throw new Error(`${label} changed before materialization`);
    }
    destinationDescriptor = openSync(destinationPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
      let written = 0;
      while (written < read) {
        const count = writeSync(
          destinationDescriptor,
          buffer,
          written,
          read - written,
        );
        if (count <= 0) throw new Error(`${label} copy did not make progress`);
        written += count;
      }
    }
    chmodSync(destinationPath, 0o600);
    fsyncSync(destinationDescriptor);
    const finalSourceStats = fstatSync(sourceDescriptor);
    if (
      bytes !== openedSourceStats.size ||
      finalSourceStats.dev !== openedSourceStats.dev ||
      finalSourceStats.ino !== openedSourceStats.ino ||
      finalSourceStats.size !== openedSourceStats.size ||
      finalSourceStats.mtimeMs !== openedSourceStats.mtimeMs ||
      finalSourceStats.ctimeMs !== openedSourceStats.ctimeMs
    ) {
      throw new Error(`${label} changed during materialization`);
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    if (destinationDescriptor !== null) closeSync(destinationDescriptor);
    if (sourceDescriptor !== null) closeSync(sourceDescriptor);
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    chmodSync(filePath, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseMaterializedFile(value: unknown): MaterializedFile | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["relativePath", "sha256", "bytes"]) ||
    typeof value.relativePath !== "string" ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) <= 0
  ) {
    return null;
  }
  return {
    relativePath: value.relativePath,
    sha256: value.sha256,
    bytes: Number(value.bytes),
  };
}

function parseMaterializationRecord(
  recordPath: string,
): KeeperRecoveryMaterializationRecord {
  let value: unknown;
  try {
    value = JSON.parse(
      readPrivateRecord(recordPath, MAX_RECORD_BYTES).toString("utf8"),
    );
  } catch {
    throw new Error("recovery materialization record is invalid");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "materializationId",
      "recoverySetId",
      "boundaryId",
      "releaseSha",
      "cluster",
      "operatorAlertRouteId",
      "sourceRecoveryManifestSha256",
      "verificationScope",
      "activationRequiresSeparateApproval",
      "files",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.materializationId !== "string" ||
    !UUID_V4_PATTERN.test(value.materializationId) ||
    typeof value.recoverySetId !== "string" ||
    !UUID_V4_PATTERN.test(value.recoverySetId) ||
    typeof value.boundaryId !== "string" ||
    typeof value.releaseSha !== "string" ||
    typeof value.cluster !== "string" ||
    typeof value.operatorAlertRouteId !== "string" ||
    typeof value.sourceRecoveryManifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sourceRecoveryManifestSha256) ||
    value.verificationScope !== "isolated_restore_materialization_only" ||
    value.activationRequiresSeparateApproval !== true ||
    !isRecord(value.files) ||
    !hasExactKeys(value.files, ["keeperDatabase", "operatorAlertState"])
  ) {
    throw new Error("recovery materialization record is invalid");
  }
  const keeperDatabase = parseMaterializedFile(value.files.keeperDatabase);
  const operatorAlertState = parseMaterializedFile(
    value.files.operatorAlertState,
  );
  if (!keeperDatabase || !operatorAlertState) {
    throw new Error("recovery materialization record is invalid");
  }
  return {
    schemaVersion: 1,
    createdAt: value.createdAt,
    materializationId: value.materializationId,
    recoverySetId: value.recoverySetId,
    boundaryId: value.boundaryId,
    releaseSha: value.releaseSha,
    cluster: value.cluster as LaunchCluster,
    operatorAlertRouteId: value.operatorAlertRouteId,
    sourceRecoveryManifestSha256: value.sourceRecoveryManifestSha256,
    verificationScope: "isolated_restore_materialization_only",
    activationRequiresSeparateApproval: true,
    files: { keeperDatabase, operatorAlertState },
  };
}

function readPrivateRecord(filePath: string, maximumBytes: number): Buffer {
  const pathStats = assertPrivateRegularFile(
    filePath,
    "recovery materialization record",
    maximumBytes,
  );
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
      throw new Error("recovery materialization record is invalid");
    }
    const contents = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor);
    if (
      contents.byteLength !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error("recovery materialization record is invalid");
    }
    return contents;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function requireExactEntries(
  directoryPath: string,
  expected: readonly string[],
  label: string,
): void {
  const observed = readdirSync(directoryPath).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
    throw new Error(`${label} contains unexpected entries`);
  }
}

function resolveDestinationContainer(destinationPath: string): string {
  const absolutePath = path.resolve(destinationPath);
  const baseName = path.basename(absolutePath);
  if (
    !baseName ||
    baseName === "." ||
    baseName === ".." ||
    baseName.length > 128
  ) {
    throw new Error("destination container has an invalid name");
  }
  if (existsSync(absolutePath)) {
    throw new Error("destination container already exists");
  }
  const parentStats = lstatSync(path.dirname(absolutePath));
  if (!parentStats.isDirectory()) {
    throw new Error("destination container parent must be a directory");
  }
  return absolutePath;
}

function pathsInside(materializedRootPath: string) {
  return {
    keeperDatabasePath: path.join(
      materializedRootPath,
      KEEPER_DATABASE_RELATIVE_PATH,
    ),
    operatorAlertStatePath: path.join(
      materializedRootPath,
      OPERATOR_ALERT_STATE_RELATIVE_PATH,
    ),
    recordPath: path.join(materializedRootPath, MATERIALIZATION_RECORD_NAME),
  };
}

async function verifyMaterializedPayload(
  input: RecoverySetSource,
  materializedRootPath: string,
): Promise<KeeperRecoveryMaterializationRecord> {
  const sourceManifest = await verifyKeeperRecoverySet(input);
  const keeperEvidence = await verifyKeeperBackup({
    backupPath: input.keeperBackupPath,
    evidencePath: input.keeperEvidencePath,
    expectedReleaseSha: input.expectedReleaseSha,
    expectedCluster: input.expectedCluster,
  });
  assertPrivateDirectory(materializedRootPath, "materialized recovery root");
  const statusPath = path.join(materializedRootPath, "status");
  assertPrivateDirectory(statusPath, "materialized recovery status directory");
  requireExactEntries(
    materializedRootPath,
    [KEEPER_DATABASE_RELATIVE_PATH, MATERIALIZATION_RECORD_NAME, "status"],
    "materialized recovery root",
  );
  requireExactEntries(
    statusPath,
    [path.basename(OPERATOR_ALERT_STATE_RELATIVE_PATH)],
    "materialized recovery status directory",
  );
  const runtimePaths = pathsInside(materializedRootPath);
  const record = parseMaterializationRecord(runtimePaths.recordPath);
  if (
    record.recoverySetId !== sourceManifest.recoverySetId ||
    record.boundaryId !== sourceManifest.boundaryId ||
    record.releaseSha !== sourceManifest.releaseSha ||
    record.cluster !== sourceManifest.cluster ||
    record.operatorAlertRouteId !== sourceManifest.operatorAlertRouteId
  ) {
    throw new Error("recovery materialization identity does not match");
  }
  if (Date.parse(record.createdAt) < Date.parse(sourceManifest.createdAt)) {
    throw new Error("recovery materialization clock regressed");
  }
  const sourceManifestBinding = bindPrivateFile(
    input.manifestPath,
    "source recovery manifest",
    MAX_RECORD_BYTES,
  );
  if (record.sourceRecoveryManifestSha256 !== sourceManifestBinding.sha256) {
    throw new Error("source recovery manifest binding does not match");
  }
  if (
    record.files.keeperDatabase.relativePath !==
      KEEPER_DATABASE_RELATIVE_PATH ||
    record.files.operatorAlertState.relativePath !==
      OPERATOR_ALERT_STATE_RELATIVE_PATH
  ) {
    throw new Error("recovery materialization paths are invalid");
  }
  const keeperDatabase = bindPrivateFile(
    runtimePaths.keeperDatabasePath,
    "materialized keeper database",
  );
  const operatorAlertState = bindPrivateFile(
    runtimePaths.operatorAlertStatePath,
    "materialized operator alert state",
    64 * 1024,
  );
  if (
    keeperDatabase.sha256 !== record.files.keeperDatabase.sha256 ||
    keeperDatabase.bytes !== record.files.keeperDatabase.bytes ||
    keeperDatabase.sha256 !== sourceManifest.files.keeperBackup.sha256 ||
    keeperDatabase.bytes !== sourceManifest.files.keeperBackup.bytes
  ) {
    throw new Error("materialized keeper database binding does not match");
  }
  if (
    operatorAlertState.sha256 !== record.files.operatorAlertState.sha256 ||
    operatorAlertState.bytes !== record.files.operatorAlertState.bytes ||
    operatorAlertState.sha256 !==
      sourceManifest.files.operatorAlertBackup.sha256 ||
    operatorAlertState.bytes !== sourceManifest.files.operatorAlertBackup.bytes
  ) {
    throw new Error("materialized operator alert binding does not match");
  }
  const materializedDatabaseInspection = inspectKeeperDatabaseSnapshot(
    runtimePaths.keeperDatabasePath,
  );
  if (
    !sameKeeperDatabaseInspection(materializedDatabaseInspection, {
      integrityCheck: keeperEvidence.integrityCheck,
      foreignKeyViolations: keeperEvidence.foreignKeyViolations,
      sqliteUserVersion: keeperEvidence.sqliteUserVersion,
      schemaSha256: keeperEvidence.schemaSha256,
      logicalDataSha256: keeperEvidence.logicalDataSha256,
      tableCounts: keeperEvidence.tableCounts,
      terminalOperationCounts: keeperEvidence.terminalOperationCounts,
    })
  ) {
    throw new Error("materialized keeper database inspection does not match");
  }
  if (
    !loadOperatorAlertDurableState({
      statePath: runtimePaths.operatorAlertStatePath,
      routeId: sourceManifest.operatorAlertRouteId,
    })
  ) {
    throw new Error("materialized operator alert state is missing");
  }
  return record;
}

export async function materializeKeeperRecoverySet(
  input: MaterializeKeeperRecoverySetInput,
): Promise<KeeperRecoveryMaterializationRecord> {
  const destinationContainerPath = resolveDestinationContainer(
    input.destinationContainerPath,
  );
  const sourceManifest = await verifyKeeperRecoverySet(input);
  const materializationId = (input.createId ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(materializationId)) {
    throw new Error("materialization ID generator returned an invalid UUID");
  }
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  if (Date.parse(createdAt) < Date.parse(sourceManifest.createdAt)) {
    throw new Error("recovery materialization clock regressed");
  }
  const stagingName = `.staging-${materializationId}`;
  const stagingPath = path.join(destinationContainerPath, stagingName);
  const activePath = path.join(
    destinationContainerPath,
    MATERIALIZED_ROOT_NAME,
  );
  let ownsDestination = false;
  try {
    mkdirSync(destinationContainerPath, { mode: 0o700 });
    ownsDestination = true;
    chmodSync(destinationContainerPath, 0o700);
    mkdirSync(stagingPath, { mode: 0o700 });
    chmodSync(stagingPath, 0o700);
    const statusPath = path.join(stagingPath, "status");
    mkdirSync(statusPath, { mode: 0o700 });
    chmodSync(statusPath, 0o700);

    const runtimePaths = pathsInside(stagingPath);
    const keeperDatabase = copyPrivateFile(
      input.keeperBackupPath,
      runtimePaths.keeperDatabasePath,
      "keeper backup",
    );
    const operatorAlertState = copyPrivateFile(
      input.operatorAlertBackupPath,
      runtimePaths.operatorAlertStatePath,
      "operator alert backup",
    );
    if (
      keeperDatabase.sha256 !== sourceManifest.files.keeperBackup.sha256 ||
      keeperDatabase.bytes !== sourceManifest.files.keeperBackup.bytes ||
      operatorAlertState.sha256 !==
        sourceManifest.files.operatorAlertBackup.sha256 ||
      operatorAlertState.bytes !==
        sourceManifest.files.operatorAlertBackup.bytes
    ) {
      throw new Error("recovery source changed during materialization");
    }
    const sourceRecoveryManifest = bindPrivateFile(
      input.manifestPath,
      "source recovery manifest",
      MAX_RECORD_BYTES,
    );
    const record: KeeperRecoveryMaterializationRecord = {
      schemaVersion: 1,
      createdAt,
      materializationId,
      recoverySetId: sourceManifest.recoverySetId,
      boundaryId: sourceManifest.boundaryId,
      releaseSha: sourceManifest.releaseSha,
      cluster: sourceManifest.cluster,
      operatorAlertRouteId: sourceManifest.operatorAlertRouteId,
      sourceRecoveryManifestSha256: sourceRecoveryManifest.sha256,
      verificationScope: "isolated_restore_materialization_only",
      activationRequiresSeparateApproval: true,
      files: {
        keeperDatabase: {
          relativePath: KEEPER_DATABASE_RELATIVE_PATH,
          ...keeperDatabase,
        },
        operatorAlertState: {
          relativePath: OPERATOR_ALERT_STATE_RELATIVE_PATH,
          ...operatorAlertState,
        },
      },
    };
    writePrivateJson(runtimePaths.recordPath, record);
    fsyncDirectory(statusPath);
    fsyncDirectory(stagingPath);
    const verified = await verifyMaterializedPayload(input, stagingPath);
    await input.beforePublish?.();
    const prePublishSourceManifest = await verifyKeeperRecoverySet(input);
    if (
      JSON.stringify(prePublishSourceManifest) !==
      JSON.stringify(sourceManifest)
    ) {
      throw new Error("recovery source changed before publication");
    }
    if (existsSync(activePath)) {
      throw new Error("materialized active root already exists");
    }
    renameSync(stagingPath, activePath);
    fsyncDirectory(destinationContainerPath);
    fsyncDirectory(path.dirname(destinationContainerPath));
    return verified;
  } catch (error) {
    if (ownsDestination) {
      rmSync(destinationContainerPath, { recursive: true, force: true });
      fsyncDirectory(path.dirname(destinationContainerPath));
    }
    throw error;
  }
}

export async function verifyMaterializedKeeperRecoverySet(
  input: VerifyMaterializedKeeperRecoverySetInput,
): Promise<KeeperRecoveryMaterializationRecord> {
  const materializedRootPath = path.resolve(input.materializedRootPath);
  if (path.basename(materializedRootPath) !== MATERIALIZED_ROOT_NAME) {
    throw new Error("materialized recovery root must be the active directory");
  }
  const destinationContainerPath = path.dirname(materializedRootPath);
  assertPrivateDirectory(
    destinationContainerPath,
    "recovery destination container",
  );
  requireExactEntries(
    destinationContainerPath,
    [MATERIALIZED_ROOT_NAME],
    "recovery destination container",
  );
  return verifyMaterializedPayload(input, materializedRootPath);
}
