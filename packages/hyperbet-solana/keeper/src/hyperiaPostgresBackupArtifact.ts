import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const MAX_EVIDENCE_BYTES = 128 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024 * 1024;
const MIN_TOOL_TIMEOUT_MS = 1_000;
const MAX_TOOL_TIMEOUT_MS = 15 * 60 * 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BOUNDARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,63}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;
const MIGRATION_TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PG_TOOL_VERSION_PATTERN =
  /^pg_(?:dump|restore) \(PostgreSQL\) [0-9][0-9A-Za-z.+-]{0,63}(?: \([^\r\n\u0000]{1,128}\))?$/u;

export const HYPERIA_POSTGRES_RECOVERY_TABLES = [
  "action_bar_storage",
  "activity_log",
  "agent_autonomy_checkpoints",
  "agent_autonomy_lifecycle_events",
  "agent_autonomy_lifecycle_heads",
  "agent_autonomy_progression_events",
  "agent_autonomy_progression_heads",
  "agent_bank_operation_items",
  "agent_bank_operations",
  "agent_duel_stats",
  "agent_mappings",
  "agent_store_operations",
  "agent_thoughts",
  "anti_cheat_violations",
  "bank_placeholders",
  "bank_storage",
  "bank_tabs",
  "bone_burial_operations",
  "character_templates",
  "characters",
  "chunk_activity",
  "combat_stat_events",
  "config",
  "duel_settlements",
  "entities",
  "equipment",
  "failed_transactions",
  "friend_requests",
  "friendships",
  "gathering_resource_states",
  "ignore_list",
  "inventory",
  "items",
  "layout_presets",
  "npc_kills",
  "onchain_outbox",
  "operations_log",
  "player_combat_stats",
  "player_deaths",
  "player_sessions",
  "processing_active_fires",
  "quest_audit_log",
  "quest_gathering_progress_receipts",
  "quest_processing_progress_receipts",
  "quest_progress",
  "retired_arena_integration_records",
  "storage",
  "streaming_duel_action_observations",
  "streaming_duel_bank_open_events",
  "streaming_duel_competitive_snapshots",
  "streaming_duel_history",
  "streaming_duel_preparations",
  "streaming_duel_transition_events",
  "streaming_scheduler_leases",
  "trades",
  "user_bans",
  "users",
  "world_chunks",
] as const;

type HyperiaRecoveryTable = (typeof HYPERIA_POSTGRES_RECOVERY_TABLES)[number];

export type HyperiaPostgresBackupEvidenceContract = {
  schemaVersion: 1;
  createdAt: string;
  backupId: string;
  releaseSha: string;
  boundaryId: string;
  databaseName: string;
  serverVersionNum: string;
  databaseEncoding: string;
  snapshotIsolation: "repeatable_read_read_only_exported_snapshot";
  verificationScope: "postgres_snapshot_dump_only";
  quiescentBoundaryWitnessRequired: true;
  restoreCompatibilityApprovalRequired: true;
  sourceMigrationJournalSha256: string;
  sourceMigrationCount: number;
  sourceLatestMigrationTag: string;
  databaseMigrationJournalSha256: string;
  schemaSha256: string;
  schemaObjectCounts: {
    relations: number;
    columns: number;
    constraints: number;
    indexes: number;
    triggers: number;
    functions: number;
  };
  recoveryTableCounts: Record<HyperiaRecoveryTable, string>;
  recoveryTableSha256s: Record<HyperiaRecoveryTable, string>;
  backupFileName: "hyperia-postgres.dump";
  backupSha256: string;
  backupBytes: number;
  tocSha256: string;
  tocEntries: number;
  pgDumpVersion: string;
  pgRestoreVersionAtCreate: string;
};

export type HyperiaPostgresBoundFile = {
  fileName: string;
  sha256: string;
  bytes: number;
};

export type VerifiedHyperiaPostgresBackupArtifact = {
  evidence: HyperiaPostgresBackupEvidenceContract;
  backupFile: HyperiaPostgresBoundFile;
  evidenceFile: HyperiaPostgresBoundFile;
  pgRestoreVersionAtVerify: string;
};

type VerifyHyperiaPostgresBackupArtifactInput = {
  backupPath: string;
  evidencePath: string;
  migrationsDirectory: string;
  expectedReleaseSha: string;
  expectedBoundaryId: string;
  expectedDatabaseName: string;
  toolTimeoutMs: number;
  pgRestoreExecutable?: string;
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

function assertReleaseSha(value: string): string {
  const normalized = value.trim();
  if (!RELEASE_SHA_PATTERN.test(normalized)) {
    throw new Error(
      "Hyperia release SHA must be one full lowercase commit SHA",
    );
  }
  return normalized;
}

function assertBoundaryId(value: string): string {
  const normalized = value.trim();
  if (!BOUNDARY_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Hyperia boundary ID must be 8-64 lowercase non-secret characters",
    );
  }
  return normalized;
}

function assertDatabaseName(value: string): string {
  const normalized = value.trim();
  if (!DATABASE_NAME_PATTERN.test(normalized)) {
    throw new Error("Hyperia source database name is invalid");
  }
  return normalized;
}

function assertToolTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TOOL_TIMEOUT_MS ||
    value > MAX_TOOL_TIMEOUT_MS
  ) {
    throw new Error(
      "Hyperia archive tool timeout is outside the supported range",
    );
  }
  return value;
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

function readPrivateFile(
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

function parseEvidence(value: unknown): HyperiaPostgresBackupEvidenceContract {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "backupId",
      "releaseSha",
      "boundaryId",
      "databaseName",
      "serverVersionNum",
      "databaseEncoding",
      "snapshotIsolation",
      "verificationScope",
      "quiescentBoundaryWitnessRequired",
      "restoreCompatibilityApprovalRequired",
      "sourceMigrationJournalSha256",
      "sourceMigrationCount",
      "sourceLatestMigrationTag",
      "databaseMigrationJournalSha256",
      "schemaSha256",
      "schemaObjectCounts",
      "recoveryTableCounts",
      "recoveryTableSha256s",
      "backupFileName",
      "backupSha256",
      "backupBytes",
      "tocSha256",
      "tocEntries",
      "pgDumpVersion",
      "pgRestoreVersionAtCreate",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.backupId !== "string" ||
    !UUID_V4_PATTERN.test(value.backupId) ||
    typeof value.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.releaseSha) ||
    typeof value.boundaryId !== "string" ||
    !BOUNDARY_ID_PATTERN.test(value.boundaryId) ||
    typeof value.databaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.databaseName) ||
    typeof value.serverVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(value.serverVersionNum) ||
    typeof value.databaseEncoding !== "string" ||
    !/^[A-Z0-9_-]{1,32}$/u.test(value.databaseEncoding) ||
    value.snapshotIsolation !== "repeatable_read_read_only_exported_snapshot" ||
    value.verificationScope !== "postgres_snapshot_dump_only" ||
    value.quiescentBoundaryWitnessRequired !== true ||
    value.restoreCompatibilityApprovalRequired !== true ||
    typeof value.sourceMigrationJournalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sourceMigrationJournalSha256) ||
    !Number.isSafeInteger(value.sourceMigrationCount) ||
    Number(value.sourceMigrationCount) <= 0 ||
    typeof value.sourceLatestMigrationTag !== "string" ||
    !MIGRATION_TAG_PATTERN.test(value.sourceLatestMigrationTag) ||
    typeof value.databaseMigrationJournalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.databaseMigrationJournalSha256) ||
    typeof value.schemaSha256 !== "string" ||
    !SHA256_PATTERN.test(value.schemaSha256) ||
    !isRecord(value.schemaObjectCounts) ||
    !hasExactKeys(value.schemaObjectCounts, [
      "relations",
      "columns",
      "constraints",
      "indexes",
      "triggers",
      "functions",
    ]) ||
    Object.values(value.schemaObjectCounts).some(
      (count) => !Number.isSafeInteger(count) || Number(count) <= 0,
    ) ||
    !isRecord(value.recoveryTableCounts) ||
    !hasExactKeys(
      value.recoveryTableCounts,
      HYPERIA_POSTGRES_RECOVERY_TABLES,
    ) ||
    Object.values(value.recoveryTableCounts).some(
      (count) =>
        typeof count !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count),
    ) ||
    !isRecord(value.recoveryTableSha256s) ||
    !hasExactKeys(
      value.recoveryTableSha256s,
      HYPERIA_POSTGRES_RECOVERY_TABLES,
    ) ||
    Object.values(value.recoveryTableSha256s).some(
      (hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash),
    ) ||
    value.backupFileName !== "hyperia-postgres.dump" ||
    typeof value.backupSha256 !== "string" ||
    !SHA256_PATTERN.test(value.backupSha256) ||
    !Number.isSafeInteger(value.backupBytes) ||
    Number(value.backupBytes) <= 0 ||
    typeof value.tocSha256 !== "string" ||
    !SHA256_PATTERN.test(value.tocSha256) ||
    !Number.isSafeInteger(value.tocEntries) ||
    Number(value.tocEntries) <= 0 ||
    typeof value.pgDumpVersion !== "string" ||
    !PG_TOOL_VERSION_PATTERN.test(value.pgDumpVersion) ||
    typeof value.pgRestoreVersionAtCreate !== "string" ||
    !PG_TOOL_VERSION_PATTERN.test(value.pgRestoreVersionAtCreate)
  ) {
    throw new Error("Hyperia PostgreSQL backup evidence is invalid");
  }
  return value as HyperiaPostgresBackupEvidenceContract;
}

function loadSourceMigrationIdentity(migrationsDirectory: string): {
  sha256: string;
  count: number;
  latestTag: string;
} {
  const absoluteDirectory = path.resolve(migrationsDirectory);
  const journalBytes = readFileSync(
    path.join(absoluteDirectory, "meta/_journal.json"),
  );
  const parsed: unknown = JSON.parse(journalBytes.toString("utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error("Hyperia source migration journal is invalid");
  }
  const migrations = parsed.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.tag !== "string" ||
      !MIGRATION_TAG_PATTERN.test(entry.tag) ||
      !Number.isSafeInteger(entry.when) ||
      Number(entry.when) <= 0
    ) {
      throw new Error("Hyperia source migration journal is invalid");
    }
    const sql = readFileSync(path.join(absoluteDirectory, `${entry.tag}.sql`));
    return {
      tag: entry.tag,
      when: String(entry.when),
      hash: createHash("sha256").update(sql).digest("hex"),
    };
  });
  const latestTag = migrations[migrations.length - 1]?.tag;
  if (!latestTag) throw new Error("Hyperia source migration journal is empty");
  const journalSha256 = createHash("sha256").update(journalBytes).digest("hex");
  return {
    sha256: createHash("sha256")
      .update(JSON.stringify({ journalSha256, migrations }))
      .digest("hex"),
    count: migrations.length,
    latestTag,
  };
}

async function runPgRestore(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("Hyperia PostgreSQL archive tool timed out"));
      }
    }, timeoutMs);
    const observe = (chunk: Buffer, retain: boolean): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_TOOL_OUTPUT_BYTES) child.kill("SIGKILL");
      if (retain) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => observe(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => observe(chunk, false));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("Hyperia PostgreSQL archive tool could not start"));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || bytes > MAX_TOOL_OUTPUT_BYTES) {
        reject(new Error("Hyperia PostgreSQL archive tool failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function canonicalizeToc(value: string): { sha256: string; entries: number } {
  const lines = value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith(";"));
  if (lines.length === 0 || lines.length > 100_000) {
    throw new Error("Hyperia PostgreSQL archive TOC is empty or excessive");
  }
  return {
    sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
    entries: lines.length,
  };
}

export async function verifyHyperiaPostgresBackupArtifact(
  input: VerifyHyperiaPostgresBackupArtifactInput,
): Promise<VerifiedHyperiaPostgresBackupArtifact> {
  const expectedReleaseSha = assertReleaseSha(input.expectedReleaseSha);
  const expectedBoundaryId = assertBoundaryId(input.expectedBoundaryId);
  const expectedDatabaseName = assertDatabaseName(input.expectedDatabaseName);
  const timeoutMs = assertToolTimeout(input.toolTimeoutMs);
  const backupPath = path.resolve(input.backupPath);
  const evidencePath = path.resolve(input.evidencePath);
  if (
    backupPath === evidencePath ||
    path.basename(backupPath) !== "hyperia-postgres.dump" ||
    path.basename(evidencePath) !== "evidence.json" ||
    path.dirname(backupPath) !== path.dirname(evidencePath)
  ) {
    throw new Error("Hyperia PostgreSQL backup pair layout is invalid");
  }
  const activeRoot = path.dirname(backupPath);
  const backupContainer = path.dirname(activeRoot);
  const activeStats = lstatSync(activeRoot);
  const containerStats = lstatSync(backupContainer);
  if (
    path.basename(activeRoot) !== "active" ||
    !activeStats.isDirectory() ||
    (activeStats.mode & 0o777) !== 0o700 ||
    !containerStats.isDirectory() ||
    (containerStats.mode & 0o777) !== 0o700 ||
    JSON.stringify(readdirSync(activeRoot).sort()) !==
      JSON.stringify(["evidence.json", "hyperia-postgres.dump"]) ||
    JSON.stringify(readdirSync(backupContainer).sort()) !==
      JSON.stringify(["active"])
  ) {
    throw new Error("Hyperia PostgreSQL published backup layout is invalid");
  }
  const migrationsStats = lstatSync(path.resolve(input.migrationsDirectory));
  if (!migrationsStats.isDirectory()) {
    throw new Error("Hyperia migrations path must be a directory");
  }
  const evidence = parseEvidence(
    JSON.parse(
      readPrivateFile(
        evidencePath,
        "Hyperia PostgreSQL backup evidence",
        MAX_EVIDENCE_BYTES,
      ).toString("utf8"),
    ),
  );
  if (
    evidence.releaseSha !== expectedReleaseSha ||
    evidence.boundaryId !== expectedBoundaryId ||
    evidence.databaseName !== expectedDatabaseName
  ) {
    throw new Error("Hyperia PostgreSQL backup identity does not match");
  }
  const migrationIdentity = loadSourceMigrationIdentity(
    input.migrationsDirectory,
  );
  if (
    evidence.sourceMigrationJournalSha256 !== migrationIdentity.sha256 ||
    evidence.sourceMigrationCount !== migrationIdentity.count ||
    evidence.sourceLatestMigrationTag !== migrationIdentity.latestTag
  ) {
    throw new Error(
      "Hyperia PostgreSQL source migration evidence does not match",
    );
  }
  const backupFile = bindPrivateFile(backupPath, "Hyperia PostgreSQL backup");
  if (
    backupFile.sha256 !== evidence.backupSha256 ||
    backupFile.bytes !== evidence.backupBytes ||
    backupFile.fileName !== evidence.backupFileName
  ) {
    throw new Error("Hyperia PostgreSQL backup file binding does not match");
  }
  const executable = input.pgRestoreExecutable ?? "pg_restore";
  const version = (
    await runPgRestore(executable, ["--version"], timeoutMs)
  ).trim();
  if (!PG_TOOL_VERSION_PATTERN.test(version)) {
    throw new Error("Hyperia PostgreSQL archive tool version is invalid");
  }
  const toc = canonicalizeToc(
    await runPgRestore(executable, ["--list", backupPath], timeoutMs),
  );
  if (
    toc.sha256 !== evidence.tocSha256 ||
    toc.entries !== evidence.tocEntries
  ) {
    throw new Error("Hyperia PostgreSQL archive TOC does not match evidence");
  }
  return {
    evidence,
    backupFile,
    evidenceFile: bindPrivateFile(
      evidencePath,
      "Hyperia PostgreSQL backup evidence",
    ),
    pgRestoreVersionAtVerify: version,
  };
}
