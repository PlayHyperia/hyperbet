import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import {
  HYPERIA_POSTGRES_RECOVERY_TABLES,
  type HyperiaPostgresBoundFile,
  type VerifiedHyperiaPostgresBackupArtifact,
} from "./hyperiaPostgresBackupArtifact";

const RESTORE_EVIDENCE_FILE_NAME = "hyperia-postgres-restore-evidence.json";
const MAX_RESTORE_EVIDENCE_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BOUNDARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,63}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type HyperiaPostgresRestoreEvidenceArtifact = {
  schemaVersion: 1;
  createdAt: string;
  restoreVerificationId: string;
  backupId: string;
  releaseSha: string;
  boundaryId: string;
  sourceDatabaseName: string;
  restoredDatabaseName: string;
  targetServerVersionNum: string;
  sourceBackup: HyperiaPostgresBoundFile;
  sourceEvidence: HyperiaPostgresBoundFile;
  sourceMigrationJournalSha256: string;
  schemaSha256: string;
  recoveryTableCount: number;
  restoredStateSha256: string;
  verificationScope: "isolated_postgres_restore_evidence_only";
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
};

export type VerifiedHyperiaPostgresRestoreEvidenceArtifact = {
  evidence: HyperiaPostgresRestoreEvidenceArtifact;
  evidenceFile: HyperiaPostgresBoundFile;
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

function readAndBindPrivateFile(
  filePath: string,
  label: string,
  maximumBytes: number,
): { binding: HyperiaPostgresBoundFile; bytes: Buffer } {
  const pathStats = lstatSync(filePath);
  if (
    !pathStats.isFile() ||
    pathStats.size <= 0 ||
    pathStats.size > maximumBytes ||
    (pathStats.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
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
      throw new Error(`${label} changed while it was being read`);
    }
    return {
      binding: {
        fileName: path.basename(filePath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      },
      bytes,
    };
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

function parseEvidence(value: unknown): HyperiaPostgresRestoreEvidenceArtifact {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "restoreVerificationId",
      "backupId",
      "releaseSha",
      "boundaryId",
      "sourceDatabaseName",
      "restoredDatabaseName",
      "targetServerVersionNum",
      "sourceBackup",
      "sourceEvidence",
      "sourceMigrationJournalSha256",
      "schemaSha256",
      "recoveryTableCount",
      "restoredStateSha256",
      "verificationScope",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.restoreVerificationId !== "string" ||
    !UUID_V4_PATTERN.test(value.restoreVerificationId) ||
    typeof value.backupId !== "string" ||
    !UUID_V4_PATTERN.test(value.backupId) ||
    typeof value.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.releaseSha) ||
    typeof value.boundaryId !== "string" ||
    !BOUNDARY_ID_PATTERN.test(value.boundaryId) ||
    typeof value.sourceDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.sourceDatabaseName) ||
    typeof value.restoredDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.restoredDatabaseName) ||
    typeof value.targetServerVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(value.targetServerVersionNum) ||
    typeof value.sourceMigrationJournalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sourceMigrationJournalSha256) ||
    typeof value.schemaSha256 !== "string" ||
    !SHA256_PATTERN.test(value.schemaSha256) ||
    value.recoveryTableCount !== HYPERIA_POSTGRES_RECOVERY_TABLES.length ||
    typeof value.restoredStateSha256 !== "string" ||
    !SHA256_PATTERN.test(value.restoredStateSha256) ||
    value.verificationScope !== "isolated_postgres_restore_evidence_only" ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false
  ) {
    throw new Error("Hyperia PostgreSQL restore evidence is invalid");
  }
  const sourceBackup = parseBoundFile(value.sourceBackup);
  const sourceEvidence = parseBoundFile(value.sourceEvidence);
  if (!sourceBackup || !sourceEvidence) {
    throw new Error("Hyperia PostgreSQL restore evidence is invalid");
  }
  return {
    ...(value as Omit<
      HyperiaPostgresRestoreEvidenceArtifact,
      "sourceBackup" | "sourceEvidence"
    >),
    sourceBackup,
    sourceEvidence,
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

function postgresMajor(serverVersionNum: string): number {
  const value = Number(serverVersionNum);
  return value >= 100_000
    ? Math.floor(value / 10_000)
    : Math.floor(value / 100);
}

function expectedRestoredStateSha256(
  hyperia: VerifiedHyperiaPostgresBackupArtifact,
  targetServerVersionNum: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetServerVersionNum,
        inspection: {
          serverVersionNum: targetServerVersionNum,
          databaseEncoding: hyperia.evidence.databaseEncoding,
          databaseMigrationJournalSha256:
            hyperia.evidence.databaseMigrationJournalSha256,
          schemaSha256: hyperia.evidence.schemaSha256,
          schemaObjectCounts: hyperia.evidence.schemaObjectCounts,
          recoveryTableCounts: hyperia.evidence.recoveryTableCounts,
          recoveryTableSha256s: hyperia.evidence.recoveryTableSha256s,
        },
      }),
    )
    .digest("hex");
}

export function verifyHyperiaPostgresRestoreEvidenceArtifact(input: {
  restoreEvidencePath: string;
  hyperia: VerifiedHyperiaPostgresBackupArtifact;
  expectedReleaseSha: string;
  expectedBoundaryId: string;
  expectedDatabaseName: string;
}): VerifiedHyperiaPostgresRestoreEvidenceArtifact {
  const evidencePath = path.resolve(input.restoreEvidencePath);
  if (path.basename(evidencePath) !== RESTORE_EVIDENCE_FILE_NAME) {
    throw new Error("Hyperia PostgreSQL restore evidence filename is invalid");
  }
  const retained = readAndBindPrivateFile(
    evidencePath,
    "Hyperia PostgreSQL restore evidence",
    MAX_RESTORE_EVIDENCE_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(retained.bytes.toString("utf8"));
  } catch {
    throw new Error("Hyperia PostgreSQL restore evidence is invalid");
  }
  const evidence = parseEvidence(parsed);
  if (
    evidence.releaseSha !== input.expectedReleaseSha ||
    evidence.boundaryId !== input.expectedBoundaryId ||
    evidence.sourceDatabaseName !== input.expectedDatabaseName ||
    evidence.backupId !== input.hyperia.evidence.backupId ||
    evidence.sourceMigrationJournalSha256 !==
      input.hyperia.evidence.sourceMigrationJournalSha256 ||
    evidence.schemaSha256 !== input.hyperia.evidence.schemaSha256 ||
    !sameFile(evidence.sourceBackup, input.hyperia.backupFile) ||
    !sameFile(evidence.sourceEvidence, input.hyperia.evidenceFile)
  ) {
    throw new Error(
      "Hyperia PostgreSQL restore evidence identity does not match",
    );
  }
  if (
    Date.parse(evidence.createdAt) <
      Date.parse(input.hyperia.evidence.createdAt) ||
    postgresMajor(evidence.targetServerVersionNum) !==
      postgresMajor(input.hyperia.evidence.serverVersionNum) ||
    evidence.restoredStateSha256 !==
      expectedRestoredStateSha256(
        input.hyperia,
        evidence.targetServerVersionNum,
      )
  ) {
    throw new Error("Hyperia PostgreSQL restore evidence state does not match");
  }
  return { evidence, evidenceFile: retained.binding };
}
