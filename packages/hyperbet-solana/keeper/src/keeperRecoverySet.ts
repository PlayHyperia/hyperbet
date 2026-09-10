import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";

import { assertLaunchCluster, verifyKeeperBackup } from "./keeperBackup";
import { assertOperatorAlertRouteId } from "./operatorAlertDispatcher";
import { verifyOperatorAlertStateBackup } from "./operatorAlertStateBackup";

type LaunchCluster = "devnet" | "mainnet-beta";

type BoundFile = {
  fileName: string;
  sha256: string;
  bytes: number;
};

export type KeeperRecoverySetManifest = {
  schemaVersion: 1;
  createdAt: string;
  recoverySetId: string;
  boundaryId: string;
  releaseSha: string;
  cluster: LaunchCluster;
  operatorAlertRouteId: string;
  verificationScope: "file_pair_binding_only";
  quiescentBoundaryWitnessRequired: true;
  keeperEvidenceCreatedAt: string;
  operatorAlertEvidenceCreatedAt: string;
  componentCreatedAtSkewMs: number;
  files: {
    keeperBackup: BoundFile;
    keeperEvidence: BoundFile;
    operatorAlertBackup: BoundFile;
    operatorAlertEvidence: BoundFile;
  };
};

type RecoverySetPaths = {
  keeperBackupPath: string;
  keeperEvidencePath: string;
  operatorAlertBackupPath: string;
  operatorAlertEvidencePath: string;
  manifestPath: string;
};

type RecoverySetIdentity = {
  expectedReleaseSha: string;
  expectedCluster: LaunchCluster;
  expectedOperatorAlertRouteId: string;
};

type CreateKeeperRecoverySetInput = RecoverySetPaths &
  RecoverySetIdentity & {
    boundaryId: string;
    now?: () => Date;
    createId?: () => string;
  };

type VerifyKeeperRecoverySetInput = RecoverySetPaths &
  RecoverySetIdentity & {
    expectedBoundaryId: string;
  };

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RECOVERY_SET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BOUNDARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,63}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;

function assertReleaseSha(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(
      "release SHA must be one full lowercase 40-character commit SHA",
    );
  }
  return normalized;
}

function assertBoundaryId(value: string): string {
  const normalized = value.trim();
  if (!BOUNDARY_ID_PATTERN.test(normalized)) {
    throw new Error(
      "boundary ID must be 8-64 lowercase non-secret routing characters",
    );
  }
  return normalized;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
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
    const contents = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor);
    if (
      contents.byteLength !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      (finalStats.mode & 0o777) !== 0o600 ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return contents;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function safeFileName(filePath: string): string {
  const fileName = path.basename(filePath);
  if (!fileName || fileName === "." || fileName === "..") {
    throw new Error("recovery set contains an invalid filename");
  }
  return fileName;
}

function bindFile(filePath: string, label: string): BoundFile {
  const pathStats = assertPrivateRegularFile(
    filePath,
    label,
    Number.MAX_SAFE_INTEGER,
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
    return {
      fileName: safeFileName(filePath),
      sha256: hash.digest("hex"),
      bytes,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sameBoundFile(left: BoundFile, right: BoundFile): boolean {
  return (
    left.fileName === right.fileName &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes
  );
}

function fsyncParent(filePath: string): void {
  const parentDescriptor = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
}

function validateOutputPath(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  if (existsSync(absolutePath)) {
    throw new Error("recovery set manifest already exists");
  }
  let parent: ReturnType<typeof statSync>;
  try {
    parent = statSync(path.dirname(absolutePath));
  } catch {
    throw new Error("recovery set manifest parent must be a directory");
  }
  if (!parent.isDirectory()) {
    throw new Error("recovery set manifest parent must be a directory");
  }
  return absolutePath;
}

function writeManifest(filePath: string, value: unknown): void {
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

function parseBoundFile(value: unknown): BoundFile | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["fileName", "sha256", "bytes"]) ||
    typeof value.fileName !== "string" ||
    value.fileName.length === 0 ||
    value.fileName.length > 255 ||
    path.basename(value.fileName) !== value.fileName ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) <= 0
  ) {
    return null;
  }
  return {
    fileName: value.fileName,
    sha256: value.sha256,
    bytes: Number(value.bytes),
  };
}

function parseManifest(filePath: string): KeeperRecoverySetManifest {
  let value: unknown;
  try {
    value = JSON.parse(
      readPrivateBytes(
        filePath,
        "recovery set manifest",
        MAX_MANIFEST_BYTES,
      ).toString("utf8"),
    );
  } catch {
    throw new Error("recovery set manifest is invalid");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "recoverySetId",
      "boundaryId",
      "releaseSha",
      "cluster",
      "operatorAlertRouteId",
      "verificationScope",
      "quiescentBoundaryWitnessRequired",
      "keeperEvidenceCreatedAt",
      "operatorAlertEvidenceCreatedAt",
      "componentCreatedAtSkewMs",
      "files",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.recoverySetId !== "string" ||
    !RECOVERY_SET_ID_PATTERN.test(value.recoverySetId) ||
    typeof value.boundaryId !== "string" ||
    typeof value.releaseSha !== "string" ||
    typeof value.cluster !== "string" ||
    typeof value.operatorAlertRouteId !== "string" ||
    value.verificationScope !== "file_pair_binding_only" ||
    value.quiescentBoundaryWitnessRequired !== true ||
    !isCanonicalIsoTimestamp(value.keeperEvidenceCreatedAt) ||
    !isCanonicalIsoTimestamp(value.operatorAlertEvidenceCreatedAt) ||
    !Number.isSafeInteger(value.componentCreatedAtSkewMs) ||
    Number(value.componentCreatedAtSkewMs) < 0 ||
    !isRecord(value.files) ||
    !hasExactKeys(value.files, [
      "keeperBackup",
      "keeperEvidence",
      "operatorAlertBackup",
      "operatorAlertEvidence",
    ])
  ) {
    throw new Error("recovery set manifest is invalid");
  }
  const files = {
    keeperBackup: parseBoundFile(value.files.keeperBackup),
    keeperEvidence: parseBoundFile(value.files.keeperEvidence),
    operatorAlertBackup: parseBoundFile(value.files.operatorAlertBackup),
    operatorAlertEvidence: parseBoundFile(value.files.operatorAlertEvidence),
  };
  if (Object.values(files).some((file) => file === null)) {
    throw new Error("recovery set manifest is invalid");
  }
  const keeperCreatedAt = value.keeperEvidenceCreatedAt;
  const alertCreatedAt = value.operatorAlertEvidenceCreatedAt;
  if (
    Math.abs(Date.parse(keeperCreatedAt) - Date.parse(alertCreatedAt)) !==
    value.componentCreatedAtSkewMs
  ) {
    throw new Error("recovery set manifest has invalid component timing");
  }
  return {
    schemaVersion: 1,
    createdAt: value.createdAt,
    recoverySetId: value.recoverySetId,
    boundaryId: assertBoundaryId(value.boundaryId),
    releaseSha: assertReleaseSha(value.releaseSha),
    cluster: assertLaunchCluster(value.cluster),
    operatorAlertRouteId: assertOperatorAlertRouteId(
      value.operatorAlertRouteId,
    ),
    verificationScope: "file_pair_binding_only",
    quiescentBoundaryWitnessRequired: true,
    keeperEvidenceCreatedAt: keeperCreatedAt,
    operatorAlertEvidenceCreatedAt: alertCreatedAt,
    componentCreatedAtSkewMs: Number(value.componentCreatedAtSkewMs),
    files: files as KeeperRecoverySetManifest["files"],
  };
}

function resolveAndValidatePaths(input: RecoverySetPaths): RecoverySetPaths {
  const paths = {
    keeperBackupPath: path.resolve(input.keeperBackupPath),
    keeperEvidencePath: path.resolve(input.keeperEvidencePath),
    operatorAlertBackupPath: path.resolve(input.operatorAlertBackupPath),
    operatorAlertEvidencePath: path.resolve(input.operatorAlertEvidencePath),
    manifestPath: path.resolve(input.manifestPath),
  };
  if (new Set(Object.values(paths)).size !== Object.keys(paths).length) {
    throw new Error("recovery set paths must all be distinct");
  }
  return paths;
}

async function verifyComponents(
  paths: RecoverySetPaths,
  identity: RecoverySetIdentity,
) {
  const keeperEvidence = await verifyKeeperBackup({
    backupPath: paths.keeperBackupPath,
    evidencePath: paths.keeperEvidencePath,
    expectedReleaseSha: identity.expectedReleaseSha,
    expectedCluster: identity.expectedCluster,
  });
  const operatorAlertEvidence = await verifyOperatorAlertStateBackup({
    backupPath: paths.operatorAlertBackupPath,
    evidencePath: paths.operatorAlertEvidencePath,
    expectedReleaseSha: identity.expectedReleaseSha,
    expectedCluster: identity.expectedCluster,
    expectedRouteId: identity.expectedOperatorAlertRouteId,
  });
  return { keeperEvidence, operatorAlertEvidence };
}

export async function createKeeperRecoverySet(
  input: CreateKeeperRecoverySetInput,
): Promise<KeeperRecoverySetManifest> {
  const paths = resolveAndValidatePaths(input);
  const manifestPath = validateOutputPath(paths.manifestPath);
  const releaseSha = assertReleaseSha(input.expectedReleaseSha);
  const cluster = assertLaunchCluster(input.expectedCluster);
  const routeId = assertOperatorAlertRouteId(
    input.expectedOperatorAlertRouteId,
  );
  const boundaryId = assertBoundaryId(input.boundaryId);
  const { keeperEvidence, operatorAlertEvidence } = await verifyComponents(
    paths,
    input,
  );
  const recoverySetId = (input.createId ?? randomUUID)();
  if (!RECOVERY_SET_ID_PATTERN.test(recoverySetId)) {
    throw new Error("recovery set ID generator returned an invalid UUID");
  }
  const manifest: KeeperRecoverySetManifest = {
    schemaVersion: 1,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    recoverySetId,
    boundaryId,
    releaseSha,
    cluster,
    operatorAlertRouteId: routeId,
    verificationScope: "file_pair_binding_only",
    quiescentBoundaryWitnessRequired: true,
    keeperEvidenceCreatedAt: keeperEvidence.createdAt,
    operatorAlertEvidenceCreatedAt: operatorAlertEvidence.createdAt,
    componentCreatedAtSkewMs: Math.abs(
      Date.parse(keeperEvidence.createdAt) -
        Date.parse(operatorAlertEvidence.createdAt),
    ),
    files: {
      keeperBackup: bindFile(paths.keeperBackupPath, "keeper backup"),
      keeperEvidence: bindFile(paths.keeperEvidencePath, "keeper evidence"),
      operatorAlertBackup: bindFile(
        paths.operatorAlertBackupPath,
        "operator alert backup",
      ),
      operatorAlertEvidence: bindFile(
        paths.operatorAlertEvidencePath,
        "operator alert evidence",
      ),
    },
  };
  writeManifest(manifestPath, manifest);
  try {
    return await verifyKeeperRecoverySet({
      ...paths,
      expectedReleaseSha: releaseSha,
      expectedCluster: cluster,
      expectedOperatorAlertRouteId: routeId,
      expectedBoundaryId: boundaryId,
    });
  } catch (error) {
    unlinkSync(manifestPath);
    fsyncParent(manifestPath);
    throw error;
  }
}

export async function verifyKeeperRecoverySet(
  input: VerifyKeeperRecoverySetInput,
): Promise<KeeperRecoverySetManifest> {
  const paths = resolveAndValidatePaths(input);
  const manifest = parseManifest(paths.manifestPath);
  if (manifest.releaseSha !== assertReleaseSha(input.expectedReleaseSha)) {
    throw new Error("recovery set release SHA does not match");
  }
  if (manifest.cluster !== assertLaunchCluster(input.expectedCluster)) {
    throw new Error("recovery set cluster does not match");
  }
  if (
    manifest.operatorAlertRouteId !==
    assertOperatorAlertRouteId(input.expectedOperatorAlertRouteId)
  ) {
    throw new Error("recovery set operator alert route does not match");
  }
  if (manifest.boundaryId !== assertBoundaryId(input.expectedBoundaryId)) {
    throw new Error("recovery set boundary ID does not match");
  }
  const { keeperEvidence, operatorAlertEvidence } = await verifyComponents(
    paths,
    input,
  );
  if (
    manifest.keeperEvidenceCreatedAt !== keeperEvidence.createdAt ||
    manifest.operatorAlertEvidenceCreatedAt !== operatorAlertEvidence.createdAt
  ) {
    throw new Error("recovery set component timestamps do not match");
  }
  const observedFiles = {
    keeperBackup: bindFile(paths.keeperBackupPath, "keeper backup"),
    keeperEvidence: bindFile(paths.keeperEvidencePath, "keeper evidence"),
    operatorAlertBackup: bindFile(
      paths.operatorAlertBackupPath,
      "operator alert backup",
    ),
    operatorAlertEvidence: bindFile(
      paths.operatorAlertEvidencePath,
      "operator alert evidence",
    ),
  };
  for (const key of Object.keys(observedFiles) as Array<
    keyof typeof observedFiles
  >) {
    if (!sameBoundFile(manifest.files[key], observedFiles[key])) {
      throw new Error(`recovery set file binding changed for ${key}`);
    }
  }
  return manifest;
}
