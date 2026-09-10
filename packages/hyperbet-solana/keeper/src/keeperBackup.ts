import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

const REQUIRED_LAUNCH_TABLES = [
  "bet_deployment_identities",
  "bet_executions",
  "bet_lifecycle_accounting",
  "bet_terminal_settlements",
  "bets",
  "bets_duplicate_conflicts",
  "betting_feed_checkpoint",
  "betting_feed_competitive_snapshots",
  "betting_feed_evidence_frames",
  "invite_codes",
  "invited_wallets",
  "keeper_legacy_migrations",
  "keeper_legacy_rows",
  "points_events",
  "referrals",
  "solana_indexed_transactions",
  "solana_indexer_checkpoints",
  "solana_lifecycle_facts",
  "solana_terminal_settlements",
  "terminal_operation_conflicts",
  "terminal_operations",
  "terminal_operator_audit_events",
  "wallet_display",
  "wallet_points",
] as const;

const TERMINAL_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "MANUAL_REVIEW",
  "DEAD_LETTER",
] as const;

type LaunchCluster = "devnet" | "mainnet-beta";
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export type DatabaseInspection = {
  integrityCheck: "ok";
  foreignKeyViolations: 0;
  sqliteUserVersion: number;
  schemaSha256: string;
  logicalDataSha256: string;
  tableCounts: Record<string, number>;
  terminalOperationCounts: Record<TerminalStatus, number>;
};

export type KeeperBackupEvidence = DatabaseInspection & {
  schemaVersion: 1;
  createdAt: string;
  releaseSha: string;
  cluster: LaunchCluster;
  sourceDatabaseName: string;
  backupFileName: string;
  backupSha256: string;
  backupBytes: number;
};

type CreateKeeperBackupInput = {
  sourcePath: string;
  backupPath: string;
  evidencePath: string;
  releaseSha: string;
  cluster: LaunchCluster;
  now?: () => Date;
};

type VerifyKeeperBackupInput = {
  backupPath: string;
  evidencePath: string;
  expectedReleaseSha: string;
  expectedCluster: LaunchCluster;
};

function assertReleaseSha(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(
      "release SHA must be one full lowercase 40-character commit SHA",
    );
  }
  return normalized;
}

export function assertLaunchCluster(value: string): LaunchCluster {
  if (value !== "devnet" && value !== "mainnet-beta") {
    throw new Error("cluster must be devnet or mainnet-beta");
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function numberFromRow(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return value;
}

function logicalValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { blobBase64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "bigint") return { integer: value.toString() };
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return value;
  }
  throw new Error("keeper database contains an unsupported SQLite value");
}

function logicalDataSha256(database: Database, tableNames: string[]): string {
  const hash = createHash("sha256");
  for (const tableName of tableNames) {
    const columns = database
      .query(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
      .all() as Array<{ name?: unknown; pk?: unknown }>;
    const columnNames = columns.map((column) => {
      if (typeof column.name !== "string" || !column.name) {
        throw new Error(`${tableName} contains an invalid column name`);
      }
      return column.name;
    });
    const primaryKeyColumns = columns
      .filter(
        (column) =>
          typeof column.pk === "number" &&
          Number.isSafeInteger(column.pk) &&
          column.pk > 0,
      )
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name as string);
    const orderBy =
      primaryKeyColumns.length > 0
        ? primaryKeyColumns.map(quoteIdentifier).join(", ")
        : "rowid";
    const selectColumns = columnNames.map(quoteIdentifier).join(", ");
    hash.update(JSON.stringify([tableName, columnNames]));
    const rows = database
      .query(
        `SELECT ${selectColumns}
           FROM ${quoteIdentifier(tableName)}
          ORDER BY ${orderBy}`,
      )
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      hash.update(
        JSON.stringify(
          columnNames.map((columnName) => logicalValue(row[columnName])),
        ),
      );
    }
  }
  const hasSqliteSequence = database
    .query(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'",
    )
    .get();
  if (hasSqliteSequence) {
    hash.update(JSON.stringify(["sqlite_sequence", ["name", "seq"]]));
    const rows = database
      .query("SELECT name, seq FROM sqlite_sequence ORDER BY name")
      .iterate() as Iterable<{ name: unknown; seq: unknown }>;
    for (const row of rows) {
      hash.update(
        JSON.stringify([logicalValue(row.name), logicalValue(row.seq)]),
      );
    }
  }
  return hash.digest("hex");
}

export function inspectOpenKeeperDatabaseSnapshot(
  database: Database,
): DatabaseInspection {
  const integrityRows = database.query("PRAGMA integrity_check").all() as Array<
    Record<string, unknown>
  >;
  if (
    integrityRows.length !== 1 ||
    Object.values(integrityRows[0] ?? {})[0] !== "ok"
  ) {
    throw new Error("SQLite integrity_check did not return exactly ok");
  }
  const foreignKeyRows = database.query("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length !== 0) {
    throw new Error("SQLite foreign_key_check found violations");
  }

  const schemaRows = database
    .query(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name, tbl_name`,
    )
    .all() as Array<Record<string, unknown>>;
  const tableNames = schemaRows
    .filter((row) => row.type === "table" && typeof row.name === "string")
    .map((row) => row.name as string)
    .sort();
  const missingTables = REQUIRED_LAUNCH_TABLES.filter(
    (tableName) => !tableNames.includes(tableName),
  );
  if (missingTables.length > 0) {
    throw new Error(
      `keeper database is missing launch tables: ${missingTables.join(", ")}`,
    );
  }

  const tableCounts = Object.fromEntries(
    tableNames.map((tableName) => {
      const row = database
        .query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`)
        .get() as { count?: unknown } | null;
      return [tableName, numberFromRow(row?.count, `${tableName} row count`)];
    }),
  );

  const terminalOperationCounts = Object.fromEntries(
    TERMINAL_STATUSES.map((status) => [status, 0]),
  ) as Record<TerminalStatus, number>;
  const statusRows = database
    .query(
      `SELECT status, COUNT(*) AS count
       FROM terminal_operations
       GROUP BY status
       ORDER BY status`,
    )
    .all() as Array<{ status?: unknown; count?: unknown }>;
  for (const row of statusRows) {
    if (
      typeof row.status !== "string" ||
      !TERMINAL_STATUSES.includes(row.status as TerminalStatus)
    ) {
      throw new Error("terminal_operations contains an unsupported status");
    }
    terminalOperationCounts[row.status as TerminalStatus] = numberFromRow(
      row.count,
      `${row.status} terminal count`,
    );
  }

  const userVersionRow = database.query("PRAGMA user_version").get() as Record<
    string,
    unknown
  > | null;
  return {
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    sqliteUserVersion: numberFromRow(
      Object.values(userVersionRow ?? {})[0],
      "SQLite user_version",
    ),
    schemaSha256: createHash("sha256")
      .update(JSON.stringify(schemaRows))
      .digest("hex"),
    logicalDataSha256: logicalDataSha256(database, tableNames),
    tableCounts,
    terminalOperationCounts,
  };
}

export function inspectKeeperDatabaseSnapshot(
  databasePath: string,
): DatabaseInspection {
  const database = new Database(databasePath, { readonly: true });
  try {
    return inspectOpenKeeperDatabaseSnapshot(database);
  } finally {
    database.close(false);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertPrivateRegularFile(filePath: string, label: string): void {
  const stats = statSync(filePath);
  if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have mode 0600`);
  }
}

function validateOutputPath(filePath: string, label: string): string {
  const absolutePath = path.resolve(filePath);
  if (existsSync(absolutePath)) throw new Error(`${label} already exists`);
  const parent = statSync(path.dirname(absolutePath));
  if (!parent.isDirectory())
    throw new Error(`${label} parent must be a directory`);
  return absolutePath;
}

export function sameKeeperDatabaseInspection(
  left: DatabaseInspection,
  right: DatabaseInspection,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function createKeeperBackup(
  input: CreateKeeperBackupInput,
): Promise<KeeperBackupEvidence> {
  const releaseSha = assertReleaseSha(input.releaseSha);
  const cluster = assertLaunchCluster(input.cluster);
  const sourcePath = path.resolve(input.sourcePath);
  const backupPath = validateOutputPath(input.backupPath, "backup path");
  const evidencePath = validateOutputPath(input.evidencePath, "evidence path");
  if (
    sourcePath === backupPath ||
    sourcePath === evidencePath ||
    backupPath === evidencePath
  ) {
    throw new Error("source, backup, and evidence paths must be distinct");
  }
  const sourceStats = statSync(sourcePath);
  if (!sourceStats.isFile())
    throw new Error("source database must be a regular file");

  const stagingDirectory = mkdtempSync(
    path.join(
      path.dirname(backupPath),
      `.${path.basename(backupPath)}.private-`,
    ),
  );
  const stagedBackupPath = path.join(stagingDirectory, "backup.sqlite");
  let sourceInspection: DatabaseInspection;
  try {
    const source = new Database(sourcePath, { readonly: true });
    try {
      source.run("PRAGMA busy_timeout = 5000");
      sourceInspection = inspectOpenKeeperDatabaseSnapshot(source);
      const beforeVersion = numberFromRow(
        Object.values(
          (source.query("PRAGMA data_version").get() as Record<
            string,
            unknown
          >) ?? {},
        )[0],
        "SQLite data_version",
      );
      source.query("VACUUM INTO ?1").run(stagedBackupPath);
      const afterVersion = numberFromRow(
        Object.values(
          (source.query("PRAGMA data_version").get() as Record<
            string,
            unknown
          >) ?? {},
        )[0],
        "SQLite data_version",
      );
      if (afterVersion !== beforeVersion) {
        throw new Error(
          "source database changed while the backup was being created",
        );
      }
    } finally {
      source.close(false);
    }

    chmodSync(stagedBackupPath, 0o600);
    const backupInspection = inspectKeeperDatabaseSnapshot(stagedBackupPath);
    if (!sameKeeperDatabaseInspection(sourceInspection, backupInspection)) {
      throw new Error(
        "backup snapshot does not match the quiescent source database",
      );
    }
    linkSync(stagedBackupPath, backupPath);

    const backupStats = statSync(backupPath);
    const evidence: KeeperBackupEvidence = {
      schemaVersion: 1,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      releaseSha,
      cluster,
      sourceDatabaseName: path.basename(sourcePath),
      backupFileName: path.basename(backupPath),
      backupSha256: await sha256File(backupPath),
      backupBytes: backupStats.size,
      ...backupInspection,
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(evidencePath, 0o600);
    return evidence;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function parseEvidence(filePath: string): KeeperBackupEvidence {
  assertPrivateRegularFile(filePath, "backup evidence");
  const parsed = JSON.parse(
    readFileSync(filePath, "utf8"),
  ) as Partial<KeeperBackupEvidence>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    typeof parsed.sourceDatabaseName !== "string" ||
    typeof parsed.backupFileName !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.backupSha256 ?? "") ||
    typeof parsed.backupBytes !== "number" ||
    !Number.isSafeInteger(parsed.backupBytes) ||
    parsed.backupBytes <= 0 ||
    typeof parsed.schemaSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.schemaSha256) ||
    typeof parsed.logicalDataSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.logicalDataSha256) ||
    parsed.integrityCheck !== "ok" ||
    parsed.foreignKeyViolations !== 0 ||
    typeof parsed.tableCounts !== "object" ||
    parsed.tableCounts === null ||
    typeof parsed.terminalOperationCounts !== "object" ||
    parsed.terminalOperationCounts === null
  ) {
    throw new Error("backup evidence has an invalid schema");
  }
  return parsed as KeeperBackupEvidence;
}

export async function verifyKeeperBackup(
  input: VerifyKeeperBackupInput,
): Promise<KeeperBackupEvidence> {
  const backupPath = path.resolve(input.backupPath);
  const evidencePath = path.resolve(input.evidencePath);
  assertPrivateRegularFile(backupPath, "keeper backup");
  const evidence = parseEvidence(evidencePath);
  if (evidence.releaseSha !== assertReleaseSha(input.expectedReleaseSha)) {
    throw new Error("backup release SHA does not match the expected release");
  }
  if (evidence.cluster !== assertLaunchCluster(input.expectedCluster)) {
    throw new Error("backup cluster does not match the expected cluster");
  }
  if (evidence.backupFileName !== path.basename(backupPath)) {
    throw new Error("backup filename does not match its evidence");
  }
  const stats = statSync(backupPath);
  if (stats.size !== evidence.backupBytes) {
    throw new Error("backup byte size does not match its evidence");
  }
  if ((await sha256File(backupPath)) !== evidence.backupSha256) {
    throw new Error("backup SHA-256 does not match its evidence");
  }
  const inspection = inspectKeeperDatabaseSnapshot(backupPath);
  const expectedInspection: DatabaseInspection = {
    integrityCheck: evidence.integrityCheck,
    foreignKeyViolations: evidence.foreignKeyViolations,
    sqliteUserVersion: evidence.sqliteUserVersion,
    schemaSha256: evidence.schemaSha256,
    logicalDataSha256: evidence.logicalDataSha256,
    tableCounts: evidence.tableCounts,
    terminalOperationCounts: evidence.terminalOperationCounts,
  };
  if (!sameKeeperDatabaseInspection(inspection, expectedInspection)) {
    throw new Error("backup contents do not match their evidence");
  }
  return evidence;
}
