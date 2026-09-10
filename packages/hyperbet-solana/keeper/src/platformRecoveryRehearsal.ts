import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  verifyHyperiaPostgresBackupArtifact,
  type HyperiaPostgresBoundFile,
} from "./hyperiaPostgresBackupArtifact";
import { verifyHyperiaPostgresRestoreEvidenceArtifact } from "./hyperiaPostgresRestoreEvidenceArtifact";
import { verifyMaterializedKeeperRecoverySet } from "./keeperRecoveryMaterialization";
import {
  verifyPlatformRecoverySet,
  type VerifyPlatformRecoverySetInput,
} from "./platformRecoverySet";

const MAX_MANIFEST_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BOUNDARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,63}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type PlatformRecoveryRehearsalPaths = {
  hyperiaRestoreEvidencePath: string;
  materializedRootPath: string;
  rehearsalManifestPath: string;
};

export type CreatePlatformRecoveryRehearsalInput =
  VerifyPlatformRecoverySetInput &
    PlatformRecoveryRehearsalPaths & {
      now?: () => Date;
      createId?: () => string;
    };

export type VerifyPlatformRecoveryRehearsalInput =
  VerifyPlatformRecoverySetInput & PlatformRecoveryRehearsalPaths;

export type PlatformRecoveryRehearsalManifest = {
  schemaVersion: 1;
  createdAt: string;
  rehearsalId: string;
  boundaryId: string;
  verificationScope: "cross_repository_restore_evidence_binding_only";
  quiescentBoundaryWitnessRequired: true;
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
  restoredStateReverificationRequiredAtActivation: true;
  componentCreatedAtSkewMs: number;
  manifestCreatedAfterComponentsMs: number;
  platformRecoverySetId: string;
  hyperia: {
    releaseSha: string;
    backupId: string;
    restoreVerificationId: string;
    sourceDatabaseName: string;
    restoredDatabaseName: string;
    targetServerVersionNum: string;
    restoredStateSha256: string;
    restoreEvidenceCreatedAt: string;
  };
  hyperbet: {
    releaseSha: string;
    recoverySetId: string;
    materializationId: string;
    materializationCreatedAt: string;
  };
  files: {
    platformRecoveryManifest: HyperiaPostgresBoundFile;
    hyperiaRestoreEvidence: HyperiaPostgresBoundFile;
    keeperMaterializationRecord: HyperiaPostgresBoundFile;
  };
};

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
  maximumBytes = Number.MAX_SAFE_INTEGER,
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

function bindPrivateFile(
  filePath: string,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): HyperiaPostgresBoundFile {
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
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
    const finalStats = fstatSync(descriptor);
    if (
      bytes !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      (finalStats.mode & 0o777) !== 0o600 ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being hashed`);
    }
    return {
      fileName: path.basename(filePath),
      sha256: hash.digest("hex"),
      bytes,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readPrivateManifest(filePath: string): unknown {
  const stats = assertPrivateRegularFile(
    filePath,
    "platform recovery rehearsal manifest",
    MAX_MANIFEST_BYTES,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "platform recovery rehearsal manifest changed while read",
      );
    }
    const bytes = readFileSync(descriptor);
    const final = fstatSync(descriptor);
    if (
      bytes.byteLength !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      (final.mode & 0o777) !== 0o600 ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(
        "platform recovery rehearsal manifest changed while read",
      );
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("platform recovery rehearsal manifest is invalid");
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseBoundFile(value: unknown): HyperiaPostgresBoundFile | null {
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

function parseManifest(value: unknown): PlatformRecoveryRehearsalManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "rehearsalId",
      "boundaryId",
      "verificationScope",
      "quiescentBoundaryWitnessRequired",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
      "restoredStateReverificationRequiredAtActivation",
      "componentCreatedAtSkewMs",
      "manifestCreatedAfterComponentsMs",
      "platformRecoverySetId",
      "hyperia",
      "hyperbet",
      "files",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.rehearsalId !== "string" ||
    !UUID_V4_PATTERN.test(value.rehearsalId) ||
    typeof value.boundaryId !== "string" ||
    !BOUNDARY_ID_PATTERN.test(value.boundaryId) ||
    value.verificationScope !==
      "cross_repository_restore_evidence_binding_only" ||
    value.quiescentBoundaryWitnessRequired !== true ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false ||
    value.restoredStateReverificationRequiredAtActivation !== true ||
    !Number.isSafeInteger(value.componentCreatedAtSkewMs) ||
    Number(value.componentCreatedAtSkewMs) < 0 ||
    !Number.isSafeInteger(value.manifestCreatedAfterComponentsMs) ||
    Number(value.manifestCreatedAfterComponentsMs) < 0 ||
    typeof value.platformRecoverySetId !== "string" ||
    !UUID_V4_PATTERN.test(value.platformRecoverySetId) ||
    !isRecord(value.hyperia) ||
    !hasExactKeys(value.hyperia, [
      "releaseSha",
      "backupId",
      "restoreVerificationId",
      "sourceDatabaseName",
      "restoredDatabaseName",
      "targetServerVersionNum",
      "restoredStateSha256",
      "restoreEvidenceCreatedAt",
    ]) ||
    typeof value.hyperia.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.hyperia.releaseSha) ||
    typeof value.hyperia.backupId !== "string" ||
    !UUID_V4_PATTERN.test(value.hyperia.backupId) ||
    typeof value.hyperia.restoreVerificationId !== "string" ||
    !UUID_V4_PATTERN.test(value.hyperia.restoreVerificationId) ||
    typeof value.hyperia.sourceDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.hyperia.sourceDatabaseName) ||
    typeof value.hyperia.restoredDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.hyperia.restoredDatabaseName) ||
    typeof value.hyperia.targetServerVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(value.hyperia.targetServerVersionNum) ||
    typeof value.hyperia.restoredStateSha256 !== "string" ||
    !SHA256_PATTERN.test(value.hyperia.restoredStateSha256) ||
    !isCanonicalIsoTimestamp(value.hyperia.restoreEvidenceCreatedAt) ||
    !isRecord(value.hyperbet) ||
    !hasExactKeys(value.hyperbet, [
      "releaseSha",
      "recoverySetId",
      "materializationId",
      "materializationCreatedAt",
    ]) ||
    typeof value.hyperbet.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.hyperbet.releaseSha) ||
    typeof value.hyperbet.recoverySetId !== "string" ||
    !UUID_V4_PATTERN.test(value.hyperbet.recoverySetId) ||
    typeof value.hyperbet.materializationId !== "string" ||
    !UUID_V4_PATTERN.test(value.hyperbet.materializationId) ||
    !isCanonicalIsoTimestamp(value.hyperbet.materializationCreatedAt) ||
    !isRecord(value.files) ||
    !hasExactKeys(value.files, [
      "platformRecoveryManifest",
      "hyperiaRestoreEvidence",
      "keeperMaterializationRecord",
    ])
  ) {
    throw new Error("platform recovery rehearsal manifest is invalid");
  }
  const files = {
    platformRecoveryManifest: parseBoundFile(
      value.files.platformRecoveryManifest,
    ),
    hyperiaRestoreEvidence: parseBoundFile(value.files.hyperiaRestoreEvidence),
    keeperMaterializationRecord: parseBoundFile(
      value.files.keeperMaterializationRecord,
    ),
  };
  if (Object.values(files).some((file) => file === null)) {
    throw new Error("platform recovery rehearsal manifest is invalid");
  }
  const componentTimes = [
    Date.parse(value.hyperia.restoreEvidenceCreatedAt),
    Date.parse(value.hyperbet.materializationCreatedAt),
  ];
  const componentSkew =
    Math.max(...componentTimes) - Math.min(...componentTimes);
  const createdAfter =
    Date.parse(value.createdAt) - Math.max(...componentTimes);
  if (
    componentSkew !== value.componentCreatedAtSkewMs ||
    createdAfter !== value.manifestCreatedAfterComponentsMs
  ) {
    throw new Error("platform recovery rehearsal manifest timing is invalid");
  }
  return {
    schemaVersion: 1,
    createdAt: value.createdAt,
    rehearsalId: value.rehearsalId,
    boundaryId: value.boundaryId,
    verificationScope: "cross_repository_restore_evidence_binding_only",
    quiescentBoundaryWitnessRequired: true,
    activationRequiresSeparateApproval: true,
    productionCutoverAuthorized: false,
    restoredStateReverificationRequiredAtActivation: true,
    componentCreatedAtSkewMs: Number(value.componentCreatedAtSkewMs),
    manifestCreatedAfterComponentsMs: Number(
      value.manifestCreatedAfterComponentsMs,
    ),
    platformRecoverySetId: value.platformRecoverySetId,
    hyperia: value.hyperia as PlatformRecoveryRehearsalManifest["hyperia"],
    hyperbet: value.hyperbet as PlatformRecoveryRehearsalManifest["hyperbet"],
    files: files as PlatformRecoveryRehearsalManifest["files"],
  };
}

function sameFile(
  left: HyperiaPostgresBoundFile,
  right: HyperiaPostgresBoundFile,
): boolean {
  return (
    left.fileName === right.fileName &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes
  );
}

function resolvedPaths(input: PlatformRecoveryRehearsalPaths) {
  const paths = {
    hyperiaRestoreEvidencePath: path.resolve(input.hyperiaRestoreEvidencePath),
    materializedRootPath: path.resolve(input.materializedRootPath),
    rehearsalManifestPath: path.resolve(input.rehearsalManifestPath),
  };
  if (new Set(Object.values(paths)).size !== Object.keys(paths).length) {
    throw new Error("platform recovery rehearsal paths must be distinct");
  }
  return paths;
}

async function verifyComponents(input: VerifyPlatformRecoveryRehearsalInput) {
  const paths = resolvedPaths(input);
  const platform = await verifyPlatformRecoverySet(input);
  const hyperia = await verifyHyperiaPostgresBackupArtifact({
    backupPath: input.hyperiaBackupPath,
    evidencePath: input.hyperiaEvidencePath,
    migrationsDirectory: input.hyperiaMigrationsDirectory,
    expectedReleaseSha: platform.hyperia.releaseSha,
    expectedBoundaryId: platform.boundaryId,
    expectedDatabaseName: platform.hyperia.databaseName,
    toolTimeoutMs: input.toolTimeoutMs,
    pgRestoreExecutable: input.pgRestoreExecutable,
  });
  const restore = verifyHyperiaPostgresRestoreEvidenceArtifact({
    restoreEvidencePath: paths.hyperiaRestoreEvidencePath,
    hyperia,
    expectedReleaseSha: platform.hyperia.releaseSha,
    expectedBoundaryId: platform.boundaryId,
    expectedDatabaseName: platform.hyperia.databaseName,
  });
  const materialization = await verifyMaterializedKeeperRecoverySet({
    keeperBackupPath: input.keeperBackupPath,
    keeperEvidencePath: input.keeperEvidencePath,
    operatorAlertBackupPath: input.operatorAlertBackupPath,
    operatorAlertEvidencePath: input.operatorAlertEvidencePath,
    manifestPath: input.keeperRecoverySetManifestPath,
    expectedReleaseSha: platform.hyperbet.releaseSha,
    expectedCluster: platform.hyperbet.cluster,
    expectedOperatorAlertRouteId: platform.hyperbet.operatorAlertRouteId,
    expectedBoundaryId: platform.boundaryId,
    materializedRootPath: paths.materializedRootPath,
  });
  const files = {
    platformRecoveryManifest: bindPrivateFile(
      input.platformManifestPath,
      "platform recovery manifest",
      MAX_MANIFEST_BYTES,
    ),
    hyperiaRestoreEvidence: restore.evidenceFile,
    keeperMaterializationRecord: bindPrivateFile(
      path.join(paths.materializedRootPath, "recovery-materialization.json"),
      "keeper materialization record",
      MAX_MANIFEST_BYTES,
    ),
  };
  return { paths, platform, restore, materialization, files };
}

function fsyncParent(filePath: string): void {
  const descriptor = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function resolveNewManifest(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  if (path.basename(absolutePath) !== "platform-recovery-rehearsal.json") {
    throw new Error("platform recovery rehearsal manifest filename is invalid");
  }
  if (existsSync(absolutePath)) {
    throw new Error("platform recovery rehearsal manifest already exists");
  }
  const parent = lstatSync(path.dirname(absolutePath));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
    throw new Error("platform recovery rehearsal parent must be mode-0700");
  }
  return absolutePath;
}

function writeManifest(
  filePath: string,
  manifest: PlatformRecoveryRehearsalManifest,
): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    chmodSync(filePath, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fsyncParent(filePath);
}

export async function createPlatformRecoveryRehearsal(
  input: CreatePlatformRecoveryRehearsalInput,
): Promise<PlatformRecoveryRehearsalManifest> {
  const rehearsalManifestPath = resolveNewManifest(input.rehearsalManifestPath);
  const components = await verifyComponents(input);
  const rehearsalId = (input.createId ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(rehearsalId)) {
    throw new Error("platform recovery rehearsal ID is invalid");
  }
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const componentTimes = [
    Date.parse(components.restore.evidence.createdAt),
    Date.parse(components.materialization.createdAt),
  ];
  const createdAfter = Date.parse(createdAt) - Math.max(...componentTimes);
  if (createdAfter < 0) {
    throw new Error("platform recovery rehearsal clock regressed");
  }
  const manifest: PlatformRecoveryRehearsalManifest = {
    schemaVersion: 1,
    createdAt,
    rehearsalId,
    boundaryId: components.platform.boundaryId,
    verificationScope: "cross_repository_restore_evidence_binding_only",
    quiescentBoundaryWitnessRequired: true,
    activationRequiresSeparateApproval: true,
    productionCutoverAuthorized: false,
    restoredStateReverificationRequiredAtActivation: true,
    componentCreatedAtSkewMs:
      Math.max(...componentTimes) - Math.min(...componentTimes),
    manifestCreatedAfterComponentsMs: createdAfter,
    platformRecoverySetId: components.platform.platformRecoverySetId,
    hyperia: {
      releaseSha: components.restore.evidence.releaseSha,
      backupId: components.restore.evidence.backupId,
      restoreVerificationId: components.restore.evidence.restoreVerificationId,
      sourceDatabaseName: components.restore.evidence.sourceDatabaseName,
      restoredDatabaseName: components.restore.evidence.restoredDatabaseName,
      targetServerVersionNum:
        components.restore.evidence.targetServerVersionNum,
      restoredStateSha256: components.restore.evidence.restoredStateSha256,
      restoreEvidenceCreatedAt: components.restore.evidence.createdAt,
    },
    hyperbet: {
      releaseSha: components.materialization.releaseSha,
      recoverySetId: components.materialization.recoverySetId,
      materializationId: components.materialization.materializationId,
      materializationCreatedAt: components.materialization.createdAt,
    },
    files: components.files,
  };
  writeManifest(rehearsalManifestPath, manifest);
  try {
    return await verifyPlatformRecoveryRehearsal(input);
  } catch (error) {
    unlinkSync(rehearsalManifestPath);
    fsyncParent(rehearsalManifestPath);
    throw error;
  }
}

export async function verifyPlatformRecoveryRehearsal(
  input: VerifyPlatformRecoveryRehearsalInput,
): Promise<PlatformRecoveryRehearsalManifest> {
  const paths = resolvedPaths(input);
  const manifest = parseManifest(
    readPrivateManifest(paths.rehearsalManifestPath),
  );
  const components = await verifyComponents(input);
  if (
    manifest.boundaryId !== components.platform.boundaryId ||
    manifest.platformRecoverySetId !==
      components.platform.platformRecoverySetId ||
    manifest.hyperia.releaseSha !== components.restore.evidence.releaseSha ||
    manifest.hyperia.backupId !== components.restore.evidence.backupId ||
    manifest.hyperia.restoreVerificationId !==
      components.restore.evidence.restoreVerificationId ||
    manifest.hyperia.sourceDatabaseName !==
      components.restore.evidence.sourceDatabaseName ||
    manifest.hyperia.restoredDatabaseName !==
      components.restore.evidence.restoredDatabaseName ||
    manifest.hyperia.targetServerVersionNum !==
      components.restore.evidence.targetServerVersionNum ||
    manifest.hyperia.restoredStateSha256 !==
      components.restore.evidence.restoredStateSha256 ||
    manifest.hyperia.restoreEvidenceCreatedAt !==
      components.restore.evidence.createdAt ||
    manifest.hyperbet.releaseSha !== components.materialization.releaseSha ||
    manifest.hyperbet.recoverySetId !==
      components.materialization.recoverySetId ||
    manifest.hyperbet.materializationId !==
      components.materialization.materializationId ||
    manifest.hyperbet.materializationCreatedAt !==
      components.materialization.createdAt
  ) {
    throw new Error("platform recovery rehearsal component identity changed");
  }
  for (const key of Object.keys(components.files) as Array<
    keyof typeof components.files
  >) {
    if (!sameFile(manifest.files[key], components.files[key])) {
      throw new Error(`platform recovery rehearsal file changed for ${key}`);
    }
  }
  return manifest;
}
