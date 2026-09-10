import { Database } from "bun:sqlite";
import { statSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLaunchCluster,
  inspectKeeperDatabaseSnapshot,
  sameKeeperDatabaseInspection,
  verifyKeeperBackup,
  type DatabaseInspection,
  type KeeperBackupEvidence,
} from "./keeperBackup";
import { inspectKeeperDatabaseCompatibility } from "./legacyDatabasePolicy";

function requireArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  if (!value || !value.slice(prefix.length).trim()) {
    throw new Error(`missing required --${name}=<value>`);
  }
  return value.slice(prefix.length).trim();
}

export function auditKeeperDatabaseFile(databasePath: string) {
  const absolutePath = path.resolve(databasePath);
  if (!statSync(absolutePath).isFile()) {
    throw new Error("database must be a regular file");
  }
  const database = new Database(absolutePath, {
    readonly: true,
    strict: true,
  });
  try {
    const integrity = database.query("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0] ?? {})[0] !== "ok"
    ) {
      throw new Error("SQLite integrity_check did not return exactly ok");
    }
    if (database.query("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("SQLite foreign_key_check found violations");
    }
    return inspectKeeperDatabaseCompatibility(database);
  } finally {
    database.close(false);
  }
}

function inspectionFromEvidence(
  evidence: KeeperBackupEvidence,
): DatabaseInspection {
  return {
    integrityCheck: evidence.integrityCheck,
    foreignKeyViolations: evidence.foreignKeyViolations,
    sqliteUserVersion: evidence.sqliteUserVersion,
    schemaSha256: evidence.schemaSha256,
    logicalDataSha256: evidence.logicalDataSha256,
    tableCounts: evidence.tableCounts,
    terminalOperationCounts: evidence.terminalOperationCounts,
  };
}

async function applyMigration(): Promise<void> {
  const databasePath = path.resolve(requireArg("database"));
  const releaseSha = requireArg("release-sha");
  const cluster = assertLaunchCluster(requireArg("cluster"));
  const programId = requireArg("program-id");
  const evidence = await verifyKeeperBackup({
    backupPath: requireArg("backup"),
    evidencePath: requireArg("evidence"),
    expectedReleaseSha: releaseSha,
    expectedCluster: cluster,
  });
  if (evidence.sourceDatabaseName !== path.basename(databasePath)) {
    throw new Error("backup evidence names a different source database");
  }
  const backupInspection = inspectionFromEvidence(evidence);
  if (
    !sameKeeperDatabaseInspection(
      inspectKeeperDatabaseSnapshot(databasePath),
      backupInspection,
    )
  ) {
    throw new Error("source database no longer matches the verified backup");
  }

  const previousDatabasePath = process.env.KEEPER_DB_PATH;
  process.env.KEEPER_DB_PATH = databasePath;
  let keeperDb: typeof import("./db.ts") | null = null;
  try {
    keeperDb = (await import(
      `./db.ts?legacy-migration=${Date.now()}`
    )) as typeof import("./db.ts");
    const result = keeperDb.migrateLegacyDatabase({
      backupSha256: evidence.backupSha256,
      backupInspection,
      releaseSha,
      cluster,
      programId,
    });
    writeSync(
      process.stdout.fd,
      `${JSON.stringify({ ok: true, action: "apply", result }, null, 2)}\n`,
    );
  } finally {
    keeperDb?.closeDb();
    if (previousDatabasePath === undefined) {
      delete process.env.KEEPER_DB_PATH;
    } else {
      process.env.KEEPER_DB_PATH = previousDatabasePath;
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "apply") {
    await applyMigration();
    return;
  }
  if (command !== "audit") {
    throw new Error(
      "usage: keeper-db audit --database=/absolute/path/to/keeper.sqlite | keeper-db apply --database=/absolute/path/to/keeper.sqlite --backup=/absolute/path/to/backup.sqlite --evidence=/absolute/path/to/evidence.json --release-sha=<40-lowercase-hex> --cluster=<devnet|mainnet-beta> --program-id=<canonical-public-key>",
    );
  }
  const audit = auditKeeperDatabaseFile(requireArg("database"));
  writeSync(
    process.stdout.fd,
    `${JSON.stringify({ ok: audit.compatible, action: "audit", audit }, null, 2)}\n`,
  );
  if (!audit.compatible) process.exitCode = 2;
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    await main();
  } catch (error) {
    writeSync(
      process.stderr.fd,
      `keeper database audit failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    process.exitCode = 1;
  }
}
