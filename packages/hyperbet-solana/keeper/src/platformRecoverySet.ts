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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { assertLaunchCluster } from "./keeperBackup";
import {
  verifyHyperiaPostgresBackupArtifact,
  type HyperiaPostgresBoundFile,
} from "./hyperiaPostgresBackupArtifact";
import { verifyKeeperRecoverySet } from "./keeperRecoverySet";
import { assertOperatorAlertRouteId } from "./operatorAlertDispatcher";

type LaunchCluster = "devnet" | "mainnet-beta";

type KeeperRecoveryPaths = {
  keeperBackupPath: string;
  keeperEvidencePath: string;
  operatorAlertBackupPath: string;
  operatorAlertEvidencePath: string;
  keeperRecoverySetManifestPath: string;
};

type HyperiaRecoveryPaths = {
  hyperiaBackupPath: string;
  hyperiaEvidencePath: string;
  hyperiaMigrationsDirectory: string;
};

type PlatformRecoveryIdentity = {
  expectedHyperiaReleaseSha: string;
  expectedHyperiaDatabaseName: string;
  expectedHyperbetReleaseSha: string;
  expectedCluster: LaunchCluster;
  expectedOperatorAlertRouteId: string;
  expectedBoundaryId: string;
};

type PlatformRecoveryPaths = KeeperRecoveryPaths &
  HyperiaRecoveryPaths & { platformManifestPath: string };

export type CreatePlatformRecoverySetInput = PlatformRecoveryPaths &
  PlatformRecoveryIdentity & {
    toolTimeoutMs: number;
    pgRestoreExecutable?: string;
    now?: () => Date;
    createId?: () => string;
  };

export type VerifyPlatformRecoverySetInput = PlatformRecoveryPaths &
  PlatformRecoveryIdentity & {
    toolTimeoutMs: number;
    pgRestoreExecutable?: string;
  };

export type PlatformRecoverySetManifest = {
  schemaVersion: 1;
  createdAt: string;
  platformRecoverySetId: string;
  boundaryId: string;
  verificationScope: "cross_repository_file_binding_only";
  quiescentBoundaryWitnessRequired: true;
  activationRequiresSeparateApproval: true;
  componentCreatedAtSkewMs: number;
  manifestCreatedAfterComponentsMs: number;
  hyperia: {
    releaseSha: string;
    databaseName: string;
    backupId: string;
    evidenceCreatedAt: string;
    sourceMigrationJournalSha256: string;
    schemaSha256: string;
  };
  hyperbet: {
    releaseSha: string;
    cluster: LaunchCluster;
    operatorAlertRouteId: string;
    recoverySetId: string;
    recoverySetCreatedAt: string;
    keeperEvidenceCreatedAt: string;
    operatorAlertEvidenceCreatedAt: string;
  };
  files: {
    hyperiaBackup: HyperiaPostgresBoundFile;
    hyperiaEvidence: HyperiaPostgresBoundFile;
    keeperRecoverySetManifest: HyperiaPostgresBoundFile;
  };
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BOUNDARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,63}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;

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

function assertReleaseSha(value: string, label: string): string {
  const normalized = value.trim();
  if (!RELEASE_SHA_PATTERN.test(normalized)) {
    throw new Error(`${label} must be one full lowercase commit SHA`);
  }
  return normalized;
}

function assertBoundaryId(value: string): string {
  const normalized = value.trim();
  if (!BOUNDARY_ID_PATTERN.test(normalized)) {
    throw new Error("platform recovery boundary ID is invalid");
  }
  return normalized;
}

function assertDatabaseName(value: string): string {
  const normalized = value.trim();
  if (!DATABASE_NAME_PATTERN.test(normalized)) {
    throw new Error("platform Hyperia database name is invalid");
  }
  return normalized;
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
): HyperiaPostgresBoundFile {
  const pathStats = assertPrivateRegularFile(filePath, label);
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
      fileName: path.basename(filePath),
      sha256: hash.digest("hex"),
      bytes,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readPrivateManifest(filePath: string): unknown {
  const pathStats = assertPrivateRegularFile(
    filePath,
    "platform recovery manifest",
    MAX_MANIFEST_BYTES,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor);
    if (
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size !== pathStats.size ||
      (openedStats.mode & 0o777) !== 0o600
    ) {
      throw new Error("platform recovery manifest changed while being read");
    }
    const bytes = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor);
    if (
      bytes.byteLength !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      (finalStats.mode & 0o777) !== 0o600 ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error("platform recovery manifest changed while being read");
    }
    return JSON.parse(bytes.toString("utf8"));
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

function parseManifest(value: unknown): PlatformRecoverySetManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "platformRecoverySetId",
      "boundaryId",
      "verificationScope",
      "quiescentBoundaryWitnessRequired",
      "activationRequiresSeparateApproval",
      "componentCreatedAtSkewMs",
      "manifestCreatedAfterComponentsMs",
      "hyperia",
      "hyperbet",
      "files",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.platformRecoverySetId !== "string" ||
    !UUID_V4_PATTERN.test(value.platformRecoverySetId) ||
    typeof value.boundaryId !== "string" ||
    !BOUNDARY_ID_PATTERN.test(value.boundaryId) ||
    value.verificationScope !== "cross_repository_file_binding_only" ||
    value.quiescentBoundaryWitnessRequired !== true ||
    value.activationRequiresSeparateApproval !== true ||
    !Number.isSafeInteger(value.componentCreatedAtSkewMs) ||
    Number(value.componentCreatedAtSkewMs) < 0 ||
    !Number.isSafeInteger(value.manifestCreatedAfterComponentsMs) ||
    Number(value.manifestCreatedAfterComponentsMs) < 0 ||
    !isRecord(value.hyperia) ||
    !hasExactKeys(value.hyperia, [
      "releaseSha",
      "databaseName",
      "backupId",
      "evidenceCreatedAt",
      "sourceMigrationJournalSha256",
      "schemaSha256",
    ]) ||
    typeof value.hyperia.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.hyperia.releaseSha) ||
    typeof value.hyperia.databaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.hyperia.databaseName) ||
    typeof value.hyperia.backupId !== "string" ||
    !UUID_V4_PATTERN.test(value.hyperia.backupId) ||
    !isCanonicalIsoTimestamp(value.hyperia.evidenceCreatedAt) ||
    typeof value.hyperia.sourceMigrationJournalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.hyperia.sourceMigrationJournalSha256) ||
    typeof value.hyperia.schemaSha256 !== "string" ||
    !SHA256_PATTERN.test(value.hyperia.schemaSha256) ||
    !isRecord(value.hyperbet) ||
    !hasExactKeys(value.hyperbet, [
      "releaseSha",
      "cluster",
      "operatorAlertRouteId",
      "recoverySetId",
      "recoverySetCreatedAt",
      "keeperEvidenceCreatedAt",
      "operatorAlertEvidenceCreatedAt",
    ]) ||
    typeof value.hyperbet.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.hyperbet.releaseSha) ||
    (value.hyperbet.cluster !== "devnet" &&
      value.hyperbet.cluster !== "mainnet-beta") ||
    typeof value.hyperbet.operatorAlertRouteId !== "string" ||
    typeof value.hyperbet.recoverySetId !== "string" ||
    !UUID_V4_PATTERN.test(value.hyperbet.recoverySetId) ||
    !isCanonicalIsoTimestamp(value.hyperbet.recoverySetCreatedAt) ||
    !isCanonicalIsoTimestamp(value.hyperbet.keeperEvidenceCreatedAt) ||
    !isCanonicalIsoTimestamp(value.hyperbet.operatorAlertEvidenceCreatedAt) ||
    !isRecord(value.files) ||
    !hasExactKeys(value.files, [
      "hyperiaBackup",
      "hyperiaEvidence",
      "keeperRecoverySetManifest",
    ])
  ) {
    throw new Error("platform recovery manifest is invalid");
  }
  const files = {
    hyperiaBackup: parseBoundFile(value.files.hyperiaBackup),
    hyperiaEvidence: parseBoundFile(value.files.hyperiaEvidence),
    keeperRecoverySetManifest: parseBoundFile(
      value.files.keeperRecoverySetManifest,
    ),
  };
  if (Object.values(files).some((file) => file === null)) {
    throw new Error("platform recovery manifest is invalid");
  }
  const componentTimes = [
    Date.parse(value.hyperia.evidenceCreatedAt),
    Date.parse(value.hyperbet.recoverySetCreatedAt),
    Date.parse(value.hyperbet.keeperEvidenceCreatedAt),
    Date.parse(value.hyperbet.operatorAlertEvidenceCreatedAt),
  ];
  const componentSkew =
    Math.max(...componentTimes) - Math.min(...componentTimes);
  const createdAfter =
    Date.parse(value.createdAt) - Math.max(...componentTimes);
  if (
    componentSkew !== value.componentCreatedAtSkewMs ||
    createdAfter !== value.manifestCreatedAfterComponentsMs
  ) {
    throw new Error("platform recovery manifest timing is invalid");
  }
  return {
    schemaVersion: 1,
    createdAt: value.createdAt,
    platformRecoverySetId: value.platformRecoverySetId,
    boundaryId: value.boundaryId,
    verificationScope: "cross_repository_file_binding_only",
    quiescentBoundaryWitnessRequired: true,
    activationRequiresSeparateApproval: true,
    componentCreatedAtSkewMs: Number(value.componentCreatedAtSkewMs),
    manifestCreatedAfterComponentsMs: Number(
      value.manifestCreatedAfterComponentsMs,
    ),
    hyperia: value.hyperia as PlatformRecoverySetManifest["hyperia"],
    hyperbet: value.hyperbet as PlatformRecoverySetManifest["hyperbet"],
    files: files as PlatformRecoverySetManifest["files"],
  };
}

function sameBoundFile(
  left: HyperiaPostgresBoundFile,
  right: HyperiaPostgresBoundFile,
): boolean {
  return (
    left.fileName === right.fileName &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes
  );
}

function resolvePaths(input: PlatformRecoveryPaths): PlatformRecoveryPaths {
  const paths = {
    keeperBackupPath: path.resolve(input.keeperBackupPath),
    keeperEvidencePath: path.resolve(input.keeperEvidencePath),
    operatorAlertBackupPath: path.resolve(input.operatorAlertBackupPath),
    operatorAlertEvidencePath: path.resolve(input.operatorAlertEvidencePath),
    keeperRecoverySetManifestPath: path.resolve(
      input.keeperRecoverySetManifestPath,
    ),
    hyperiaBackupPath: path.resolve(input.hyperiaBackupPath),
    hyperiaEvidencePath: path.resolve(input.hyperiaEvidencePath),
    hyperiaMigrationsDirectory: path.resolve(input.hyperiaMigrationsDirectory),
    platformManifestPath: path.resolve(input.platformManifestPath),
  };
  const filePaths = [
    paths.keeperBackupPath,
    paths.keeperEvidencePath,
    paths.operatorAlertBackupPath,
    paths.operatorAlertEvidencePath,
    paths.keeperRecoverySetManifestPath,
    paths.hyperiaBackupPath,
    paths.hyperiaEvidencePath,
    paths.platformManifestPath,
  ];
  if (new Set(filePaths).size !== filePaths.length) {
    throw new Error("platform recovery file paths must be distinct");
  }
  return paths;
}

function normalizeIdentity(input: PlatformRecoveryIdentity) {
  return {
    expectedHyperiaReleaseSha: assertReleaseSha(
      input.expectedHyperiaReleaseSha,
      "Hyperia release SHA",
    ),
    expectedHyperiaDatabaseName: assertDatabaseName(
      input.expectedHyperiaDatabaseName,
    ),
    expectedHyperbetReleaseSha: assertReleaseSha(
      input.expectedHyperbetReleaseSha,
      "Hyperbet release SHA",
    ),
    expectedCluster: assertLaunchCluster(input.expectedCluster),
    expectedOperatorAlertRouteId: assertOperatorAlertRouteId(
      input.expectedOperatorAlertRouteId,
    ),
    expectedBoundaryId: assertBoundaryId(input.expectedBoundaryId),
  };
}

async function verifyComponents(
  paths: PlatformRecoveryPaths,
  identity: ReturnType<typeof normalizeIdentity>,
  input: { toolTimeoutMs: number; pgRestoreExecutable?: string },
) {
  const keeper = await verifyKeeperRecoverySet({
    keeperBackupPath: paths.keeperBackupPath,
    keeperEvidencePath: paths.keeperEvidencePath,
    operatorAlertBackupPath: paths.operatorAlertBackupPath,
    operatorAlertEvidencePath: paths.operatorAlertEvidencePath,
    manifestPath: paths.keeperRecoverySetManifestPath,
    expectedReleaseSha: identity.expectedHyperbetReleaseSha,
    expectedCluster: identity.expectedCluster,
    expectedOperatorAlertRouteId: identity.expectedOperatorAlertRouteId,
    expectedBoundaryId: identity.expectedBoundaryId,
  });
  const hyperia = await verifyHyperiaPostgresBackupArtifact({
    backupPath: paths.hyperiaBackupPath,
    evidencePath: paths.hyperiaEvidencePath,
    migrationsDirectory: paths.hyperiaMigrationsDirectory,
    expectedReleaseSha: identity.expectedHyperiaReleaseSha,
    expectedBoundaryId: identity.expectedBoundaryId,
    expectedDatabaseName: identity.expectedHyperiaDatabaseName,
    toolTimeoutMs: input.toolTimeoutMs,
    pgRestoreExecutable: input.pgRestoreExecutable,
  });
  return { keeper, hyperia };
}

function fsyncParent(filePath: string): void {
  const descriptor = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validateNewManifestPath(filePath: string): string {
  if (existsSync(filePath)) {
    throw new Error("platform recovery manifest already exists");
  }
  const parentStats = lstatSync(path.dirname(filePath));
  if (!parentStats.isDirectory() || (parentStats.mode & 0o777) !== 0o700) {
    throw new Error("platform recovery manifest parent must be mode-0700");
  }
  return filePath;
}

function writeManifest(
  filePath: string,
  manifest: PlatformRecoverySetManifest,
): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fsyncParent(filePath);
}

export async function createPlatformRecoverySet(
  input: CreatePlatformRecoverySetInput,
): Promise<PlatformRecoverySetManifest> {
  const paths = resolvePaths(input);
  const identity = normalizeIdentity(input);
  const platformManifestPath = validateNewManifestPath(
    paths.platformManifestPath,
  );
  const { keeper, hyperia } = await verifyComponents(paths, identity, input);
  const platformRecoverySetId = (input.createId ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(platformRecoverySetId)) {
    throw new Error(
      "platform recovery set ID generator returned an invalid UUID",
    );
  }
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const componentTimes = [
    Date.parse(hyperia.evidence.createdAt),
    Date.parse(keeper.createdAt),
    Date.parse(keeper.keeperEvidenceCreatedAt),
    Date.parse(keeper.operatorAlertEvidenceCreatedAt),
  ];
  const createdAfter = Date.parse(createdAt) - Math.max(...componentTimes);
  if (createdAfter < 0) {
    throw new Error(
      "platform recovery manifest clock precedes component evidence",
    );
  }
  const manifest: PlatformRecoverySetManifest = {
    schemaVersion: 1,
    createdAt,
    platformRecoverySetId,
    boundaryId: identity.expectedBoundaryId,
    verificationScope: "cross_repository_file_binding_only",
    quiescentBoundaryWitnessRequired: true,
    activationRequiresSeparateApproval: true,
    componentCreatedAtSkewMs:
      Math.max(...componentTimes) - Math.min(...componentTimes),
    manifestCreatedAfterComponentsMs: createdAfter,
    hyperia: {
      releaseSha: hyperia.evidence.releaseSha,
      databaseName: hyperia.evidence.databaseName,
      backupId: hyperia.evidence.backupId,
      evidenceCreatedAt: hyperia.evidence.createdAt,
      sourceMigrationJournalSha256:
        hyperia.evidence.sourceMigrationJournalSha256,
      schemaSha256: hyperia.evidence.schemaSha256,
    },
    hyperbet: {
      releaseSha: keeper.releaseSha,
      cluster: keeper.cluster,
      operatorAlertRouteId: keeper.operatorAlertRouteId,
      recoverySetId: keeper.recoverySetId,
      recoverySetCreatedAt: keeper.createdAt,
      keeperEvidenceCreatedAt: keeper.keeperEvidenceCreatedAt,
      operatorAlertEvidenceCreatedAt: keeper.operatorAlertEvidenceCreatedAt,
    },
    files: {
      hyperiaBackup: hyperia.backupFile,
      hyperiaEvidence: hyperia.evidenceFile,
      keeperRecoverySetManifest: bindPrivateFile(
        paths.keeperRecoverySetManifestPath,
        "keeper recovery-set manifest",
      ),
    },
  };
  writeManifest(platformManifestPath, manifest);
  try {
    return await verifyPlatformRecoverySet({ ...input, ...paths });
  } catch (error) {
    unlinkSync(platformManifestPath);
    fsyncParent(platformManifestPath);
    throw error;
  }
}

export async function verifyPlatformRecoverySet(
  input: VerifyPlatformRecoverySetInput,
): Promise<PlatformRecoverySetManifest> {
  const paths = resolvePaths(input);
  const identity = normalizeIdentity(input);
  const manifest = parseManifest(
    readPrivateManifest(paths.platformManifestPath),
  );
  if (
    manifest.boundaryId !== identity.expectedBoundaryId ||
    manifest.hyperia.releaseSha !== identity.expectedHyperiaReleaseSha ||
    manifest.hyperia.databaseName !== identity.expectedHyperiaDatabaseName ||
    manifest.hyperbet.releaseSha !== identity.expectedHyperbetReleaseSha ||
    manifest.hyperbet.cluster !== identity.expectedCluster ||
    manifest.hyperbet.operatorAlertRouteId !==
      identity.expectedOperatorAlertRouteId
  ) {
    throw new Error("platform recovery manifest identity does not match");
  }
  const { keeper, hyperia } = await verifyComponents(paths, identity, input);
  if (
    manifest.hyperia.backupId !== hyperia.evidence.backupId ||
    manifest.hyperia.evidenceCreatedAt !== hyperia.evidence.createdAt ||
    manifest.hyperia.sourceMigrationJournalSha256 !==
      hyperia.evidence.sourceMigrationJournalSha256 ||
    manifest.hyperia.schemaSha256 !== hyperia.evidence.schemaSha256 ||
    manifest.hyperbet.recoverySetId !== keeper.recoverySetId ||
    manifest.hyperbet.recoverySetCreatedAt !== keeper.createdAt ||
    manifest.hyperbet.keeperEvidenceCreatedAt !==
      keeper.keeperEvidenceCreatedAt ||
    manifest.hyperbet.operatorAlertEvidenceCreatedAt !==
      keeper.operatorAlertEvidenceCreatedAt
  ) {
    throw new Error("platform recovery component evidence does not match");
  }
  const observedFiles = {
    hyperiaBackup: hyperia.backupFile,
    hyperiaEvidence: hyperia.evidenceFile,
    keeperRecoverySetManifest: bindPrivateFile(
      paths.keeperRecoverySetManifestPath,
      "keeper recovery-set manifest",
    ),
  };
  for (const key of Object.keys(observedFiles) as Array<
    keyof typeof observedFiles
  >) {
    if (!sameBoundFile(manifest.files[key], observedFiles[key])) {
      throw new Error(`platform recovery file binding changed for ${key}`);
    }
  }
  return manifest;
}
