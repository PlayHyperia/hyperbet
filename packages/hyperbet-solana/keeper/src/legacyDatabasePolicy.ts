import type { Database } from "bun:sqlite";
import { PublicKey } from "@solana/web3.js";

import {
  inspectOpenKeeperDatabaseSnapshot,
  sameKeeperDatabaseInspection,
  type DatabaseInspection,
} from "./keeperBackup";
import { isCanonicalSolanaTransactionSignature } from "./solanaBetAccounting";

export const KEEPER_LAUNCH_SCHEMA_VERSION = 2;

const REQUIRED_CANONICAL_TABLES = [
  "bet_deployment_identities",
  "bet_executions",
  "bets",
  "invite_codes",
  "invited_wallets",
  "keeper_legacy_migrations",
  "keeper_legacy_rows",
  "points_events",
  "referrals",
  "wallet_display",
  "wallet_points",
] as const;

const RETIRED_ACTIVE_TABLES = [
  "agent_ratings",
  "bet_sync_checkpoint",
  "identity_members",
  "referral_fees",
  "wallet_canonical",
] as const;

const DERIVED_WALLET_PREDICATE =
  "(LOWER(CAST(? AS TEXT)) LIKE 'rank/%' OR LOWER(CAST(? AS TEXT)) LIKE 'multiplier/%')";

export type KeeperDatabaseCompatibilityAudit = {
  schemaVersion: number;
  expectedSchemaVersion: number;
  compatible: boolean;
  blockers: string[];
  missingCanonicalTables: string[];
  retiredActiveTables: string[];
  retiredColumns: string[];
  unverifiedBetCount: number;
  invalidCanonicalBetCount: number;
  unboundDeploymentBetCount: number;
  invalidDeploymentIdentityCount: number;
  derivedWalletRowCount: number;
};

export type ApplyKeeperLegacyMigrationInput = {
  backupSha256: string;
  backupInspection: DatabaseInspection;
  releaseSha: string;
  cluster: "devnet" | "mainnet-beta";
  programId: string;
  appliedAt?: number;
};

export type KeeperLegacyMigrationResult = {
  migrationId: number;
  backupSha256: string;
  archivedRowCount: number;
  renamedTableCount: number;
  audit: KeeperDatabaseCompatibilityAudit;
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableNames(database: Database): Set<string> {
  return new Set(
    (
      database
        .query(
          `SELECT name
             FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name?: unknown }>
    )
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
}

function columnNames(database: Database, tableName: string): Set<string> {
  return new Set(
    (
      database
        .query(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
        .all() as Array<{ name?: unknown }>
    )
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
}

function nonNegativeSafeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return value;
}

function count(database: Database, sql: string, label: string): number {
  const row = database.query(sql).get() as { count?: unknown } | null;
  return nonNegativeSafeCount(row?.count, label);
}

function userVersion(database: Database): number {
  const row = database.query("PRAGMA user_version").get() as Record<
    string,
    unknown
  > | null;
  return nonNegativeSafeCount(
    Object.values(row ?? {})[0],
    "SQLite user_version",
  );
}

function canonicalPublicKey(value: unknown): boolean {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    return false;
  }
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function countInvalidCanonicalBets(
  database: Database,
  tables: Set<string>,
): number {
  if (!tables.has("bets") || !tables.has("bet_executions")) return 0;
  const rows = database
    .query(
      `SELECT
         bets.bettor_wallet AS wallet,
         bets.chain,
         bets.source_asset AS sourceAsset,
         CAST(bets.source_amount_lamports AS TEXT) AS sourceAmountLamports,
         bets.tx_signature AS txSignature,
         bets.market_pda AS marketPda,
         bets.duel_key AS duelKey
       FROM bets
       WHERE EXISTS (
         SELECT 1 FROM bet_executions WHERE bet_executions.bet_id = bets.id
       )`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.filter((row) => {
    const amount = String(row.sourceAmountLamports ?? "");
    return (
      String(row.chain).toUpperCase() !== "SOLANA" ||
      String(row.sourceAsset).toUpperCase() !== "SOL" ||
      !/^\d+$/u.test(amount) ||
      BigInt(amount) <= 0n ||
      !canonicalPublicKey(row.wallet) ||
      !canonicalPublicKey(row.marketPda) ||
      typeof row.duelKey !== "string" ||
      !/^[0-9a-f]{64}$/u.test(row.duelKey) ||
      !isCanonicalSolanaTransactionSignature(row.txSignature)
    );
  }).length;
}

function countDerivedWalletRows(
  database: Database,
  tables: Set<string>,
): number {
  let total = 0;
  const singleWalletTables = [
    ["wallet_points", "wallet"],
    ["wallet_display", "normalized_wallet"],
    ["invite_codes", "wallet"],
  ] as const;
  for (const [tableName, columnName] of singleWalletTables) {
    if (!tables.has(tableName)) continue;
    const quotedColumn = quoteIdentifier(columnName);
    total += count(
      database,
      `SELECT COUNT(*) AS count
         FROM ${quoteIdentifier(tableName)}
        WHERE ${DERIVED_WALLET_PREDICATE.replaceAll("?", quotedColumn)}`,
      `${tableName} derived-wallet count`,
    );
  }

  const pairedWalletTables = [
    ["points_events", "wallet", "related_wallet"],
    ["referrals", "wallet", "referrer_wallet"],
    ["invited_wallets", "referrer", "invitee"],
  ] as const;
  for (const [tableName, leftColumn, rightColumn] of pairedWalletTables) {
    if (!tables.has(tableName)) continue;
    const left = quoteIdentifier(leftColumn);
    const right = quoteIdentifier(rightColumn);
    total += count(
      database,
      `SELECT COUNT(*) AS count
         FROM ${quoteIdentifier(tableName)}
        WHERE ${DERIVED_WALLET_PREDICATE.replaceAll("?", left)}
           OR ${DERIVED_WALLET_PREDICATE.replaceAll("?", right)}`,
      `${tableName} derived-wallet count`,
    );
  }
  return total;
}

function countUnboundDeploymentBets(
  database: Database,
  tables: Set<string>,
): number {
  if (!tables.has("bets") || !tables.has("bet_executions")) return 0;
  if (!tables.has("bet_deployment_identities")) {
    return count(
      database,
      `SELECT COUNT(*) AS count
         FROM bets
        WHERE EXISTS (
          SELECT 1 FROM bet_executions WHERE bet_executions.bet_id = bets.id
        )`,
      "unbound deployment bet count",
    );
  }
  return count(
    database,
    `SELECT COUNT(*) AS count
       FROM bets
      WHERE EXISTS (
        SELECT 1 FROM bet_executions WHERE bet_executions.bet_id = bets.id
      )
        AND NOT EXISTS (
          SELECT 1
            FROM bet_deployment_identities
           WHERE bet_deployment_identities.bet_id = bets.id
        )`,
    "unbound deployment bet count",
  );
}

function countInvalidDeploymentIdentities(
  database: Database,
  tables: Set<string>,
): number {
  if (!tables.has("bet_deployment_identities")) return 0;
  const rows = database
    .query(
      `SELECT
         deployment.cluster,
         deployment.program_id AS programId,
         deployment.bound_at AS boundAt,
         bets.id AS betId,
         bets.chain,
         bets.source_asset AS sourceAsset
       FROM bet_deployment_identities AS deployment
       LEFT JOIN bets ON bets.id = deployment.bet_id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.filter(
    (row) =>
      !["localnet", "devnet", "testnet", "mainnet-beta"].includes(
        String(row.cluster),
      ) ||
      !canonicalPublicKey(row.programId) ||
      typeof row.betId !== "string" ||
      String(row.chain).toUpperCase() !== "SOLANA" ||
      String(row.sourceAsset).toUpperCase() !== "SOL" ||
      typeof row.boundAt !== "number" ||
      !Number.isSafeInteger(row.boundAt) ||
      row.boundAt < 0,
  ).length;
}

export function inspectKeeperDatabaseCompatibility(
  database: Database,
): KeeperDatabaseCompatibilityAudit {
  const tables = tableNames(database);
  const missingCanonicalTables = REQUIRED_CANONICAL_TABLES.filter(
    (tableName) => !tables.has(tableName),
  );
  const retiredActiveTables = RETIRED_ACTIVE_TABLES.filter((tableName) =>
    tables.has(tableName),
  );
  const retiredColumns: string[] = [];
  if (
    tables.has("bets") &&
    columnNames(database, "bets").has("source_amount")
  ) {
    retiredColumns.push("bets.source_amount");
  }
  if (
    tables.has("wallet_points") &&
    columnNames(database, "wallet_points").has("staking_points")
  ) {
    retiredColumns.push("wallet_points.staking_points");
  }

  const unverifiedBetCount = tables.has("bets")
    ? tables.has("bet_executions")
      ? count(
          database,
          `SELECT COUNT(*) AS count
             FROM bets
            WHERE NOT EXISTS (
              SELECT 1 FROM bet_executions WHERE bet_executions.bet_id = bets.id
            )`,
          "unverified bet count",
        )
      : count(database, "SELECT COUNT(*) AS count FROM bets", "bet count")
    : 0;
  const invalidCanonicalBetCount = countInvalidCanonicalBets(database, tables);
  const unboundDeploymentBetCount = countUnboundDeploymentBets(
    database,
    tables,
  );
  const invalidDeploymentIdentityCount = countInvalidDeploymentIdentities(
    database,
    tables,
  );
  const derivedWalletRowCount = countDerivedWalletRows(database, tables);
  const schemaVersion = userVersion(database);
  const blockers: string[] = [];
  if (missingCanonicalTables.length > 0) {
    blockers.push(
      `missing-canonical-tables:${missingCanonicalTables.join(",")}`,
    );
  }
  if (retiredActiveTables.length > 0) {
    blockers.push(`retired-active-tables:${retiredActiveTables.join(",")}`);
  }
  if (retiredColumns.length > 0) {
    blockers.push(`retired-columns:${retiredColumns.join(",")}`);
  }
  if (unverifiedBetCount > 0) {
    blockers.push(`unverified-bets:${unverifiedBetCount}`);
  }
  if (invalidCanonicalBetCount > 0) {
    blockers.push(`invalid-canonical-bets:${invalidCanonicalBetCount}`);
  }
  if (unboundDeploymentBetCount > 0) {
    blockers.push(`unbound-deployment-bets:${unboundDeploymentBetCount}`);
  }
  if (invalidDeploymentIdentityCount > 0) {
    blockers.push(
      `invalid-deployment-identities:${invalidDeploymentIdentityCount}`,
    );
  }
  if (derivedWalletRowCount > 0) {
    blockers.push(`derived-wallet-rows:${derivedWalletRowCount}`);
  }
  if (schemaVersion !== KEEPER_LAUNCH_SCHEMA_VERSION) {
    blockers.push(
      `schema-version:${schemaVersion};expected:${KEEPER_LAUNCH_SCHEMA_VERSION}`,
    );
  }

  return {
    schemaVersion,
    expectedSchemaVersion: KEEPER_LAUNCH_SCHEMA_VERSION,
    compatible: blockers.length === 0,
    blockers,
    missingCanonicalTables: [...missingCanonicalTables],
    retiredActiveTables: [...retiredActiveTables],
    retiredColumns,
    unverifiedBetCount,
    invalidCanonicalBetCount,
    unboundDeploymentBetCount,
    invalidDeploymentIdentityCount,
    derivedWalletRowCount,
  };
}

export function initializeKeeperLaunchSchemaVersion(
  database: Database,
): KeeperDatabaseCompatibilityAudit {
  const initial = inspectKeeperDatabaseCompatibility(database);
  const onlyVersionIsBlocking =
    initial.schemaVersion === 0 &&
    initial.blockers.length === 1 &&
    initial.blockers[0]?.startsWith("schema-version:");
  if (onlyVersionIsBlocking) {
    database.run(`PRAGMA user_version = ${KEEPER_LAUNCH_SCHEMA_VERSION}`);
    return inspectKeeperDatabaseCompatibility(database);
  }
  return initial;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { blobBase64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "bigint") return { integer: value.toString() };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function assertMigrationIdentity(input: ApplyKeeperLegacyMigrationInput): void {
  if (!/^[0-9a-f]{64}$/u.test(input.backupSha256)) {
    throw new Error("migration backup SHA-256 is invalid");
  }
  if (!/^[0-9a-f]{40}$/u.test(input.releaseSha)) {
    throw new Error("migration release SHA is invalid");
  }
  if (input.cluster !== "devnet" && input.cluster !== "mainnet-beta") {
    throw new Error("migration cluster is invalid");
  }
  if (!canonicalPublicKey(input.programId)) {
    throw new Error("migration program ID is invalid");
  }
  if (
    input.appliedAt !== undefined &&
    (!Number.isSafeInteger(input.appliedAt) || input.appliedAt <= 0)
  ) {
    throw new Error("migration appliedAt must be a positive safe integer");
  }
}

export function applyKeeperLegacyMigration(
  database: Database,
  input: ApplyKeeperLegacyMigrationInput,
): KeeperLegacyMigrationResult {
  assertMigrationIdentity(input);
  database.run("BEGIN IMMEDIATE");
  try {
    const currentInspection = inspectOpenKeeperDatabaseSnapshot(database);
    if (
      !sameKeeperDatabaseInspection(currentInspection, input.backupInspection)
    ) {
      throw new Error(
        "keeper database changed after the verified migration backup",
      );
    }
    const initialAudit = inspectKeeperDatabaseCompatibility(database);
    if (initialAudit.compatible) {
      throw new Error("keeper database does not require legacy migration");
    }
    if (initialAudit.missingCanonicalTables.length > 0) {
      throw new Error(
        `keeper database is missing canonical migration tables: ${initialAudit.missingCanonicalTables.join(", ")}`,
      );
    }
    if (initialAudit.schemaVersion > KEEPER_LAUNCH_SCHEMA_VERSION) {
      throw new Error("keeper database schema is newer than this migrator");
    }
    if (initialAudit.invalidCanonicalBetCount > 0) {
      throw new Error(
        `keeper database contains ${initialAudit.invalidCanonicalBetCount} malformed bet(s) with execution evidence; manual review is required`,
      );
    }
    const priorMigration = database
      .query("SELECT id FROM keeper_legacy_migrations WHERE backup_sha256 = ?")
      .get(input.backupSha256);
    if (priorMigration) {
      throw new Error("migration backup has already been applied");
    }

    const appliedAt = input.appliedAt ?? Date.now();
    const insertMigration = database
      .prepare(
        `INSERT INTO keeper_legacy_migrations (
        schema_version, backup_sha256, release_sha, cluster,
        archived_row_count, renamed_table_count, applied_at
      ) VALUES (?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(
        KEEPER_LAUNCH_SCHEMA_VERSION,
        input.backupSha256,
        input.releaseSha,
        input.cluster,
        appliedAt,
      );
    const migrationId = Number(insertMigration.lastInsertRowid);
    if (!Number.isSafeInteger(migrationId) || migrationId <= 0) {
      throw new Error("legacy migration did not produce an audit identifier");
    }
    const insertArchive = database.prepare(`INSERT INTO keeper_legacy_rows (
      source_table, source_key, row_json, reason, archived_at, migration_id
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    let archivedRowCount = 0;
    const archive = (
      sourceTable: string,
      sourceKey: string,
      payload: unknown,
      reason: string,
    ) => {
      insertArchive.run(
        sourceTable,
        sourceKey,
        JSON.stringify(jsonSafe(payload)),
        reason,
        appliedAt,
        migrationId,
      );
      archivedRowCount += 1;
    };

    const tables = tableNames(database);
    const legacyAmountColumn = columnNames(database, "bets").has(
      "source_amount",
    );
    const unverifiedBets = database
      .query(
        `SELECT bets.*${legacyAmountColumn ? ", CAST(source_amount AS TEXT) AS source_amount_text" : ""}
           FROM bets
          WHERE NOT EXISTS (
            SELECT 1 FROM bet_executions WHERE bet_executions.bet_id = bets.id
          )
          ORDER BY recorded_at ASC, id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    const deleteBet = database.prepare("DELETE FROM bets WHERE id = ?");
    for (const bet of unverifiedBets) {
      const id = String(bet.id);
      const related: Record<string, unknown> = {};
      for (const relatedTable of [
        "bet_lifecycle_accounting",
        "bet_terminal_settlements",
      ]) {
        if (!tables.has(relatedTable)) continue;
        related[relatedTable] = database
          .query(
            `SELECT * FROM ${quoteIdentifier(relatedTable)} WHERE bet_id = ?`,
          )
          .all(id);
      }
      archive(
        "bets",
        id,
        { bet, related },
        "missing-canonical-execution-evidence",
      );
      deleteBet.run(id);
    }

    const conflictingDeploymentRow = database
      .query(
        `SELECT COUNT(*) AS count
           FROM bet_deployment_identities
          WHERE cluster <> ? OR program_id <> ?`,
      )
      .get(input.cluster, input.programId) as { count?: unknown } | null;
    const conflictingDeploymentCount = nonNegativeSafeCount(
      conflictingDeploymentRow?.count,
      "conflicting deployment identity count",
    );
    if (conflictingDeploymentCount > 0) {
      throw new Error(
        "keeper database contains a different bound Solana deployment",
      );
    }
    database
      .prepare(
        `INSERT INTO bet_deployment_identities (
          bet_id, cluster, program_id, bound_at
        )
        SELECT bets.id, ?, ?, ?
          FROM bets
         WHERE EXISTS (
           SELECT 1 FROM bet_executions WHERE bet_executions.bet_id = bets.id
         )
           AND NOT EXISTS (
             SELECT 1
               FROM bet_deployment_identities
              WHERE bet_deployment_identities.bet_id = bets.id
           )`,
      )
      .run(input.cluster, input.programId, appliedAt);

    const archiveMatchingRows = (
      tableName: string,
      whereClause: string,
      reason: string,
    ) => {
      if (!tables.has(tableName)) return;
      const rows = database
        .query(
          `SELECT rowid AS archive_rowid, *
             FROM ${quoteIdentifier(tableName)}
            WHERE ${whereClause}
            ORDER BY rowid ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      const remove = database.prepare(
        `DELETE FROM ${quoteIdentifier(tableName)} WHERE rowid = ?`,
      );
      for (const row of rows) {
        if (
          typeof row.archive_rowid !== "number" &&
          typeof row.archive_rowid !== "bigint"
        ) {
          throw new Error(`${tableName} contains an invalid SQLite rowid`);
        }
        const rowid = String(row.archive_rowid);
        const { archive_rowid: _archiveRowid, ...payload } = row;
        archive(tableName, `rowid:${rowid}`, payload, reason);
        remove.run(row.archive_rowid);
      }
    };
    const derived = (columnName: string) =>
      DERIVED_WALLET_PREDICATE.replaceAll("?", quoteIdentifier(columnName));
    archiveMatchingRows(
      "wallet_points",
      derived("wallet"),
      "retired-derived-wallet-key",
    );
    archiveMatchingRows(
      "wallet_display",
      derived("normalized_wallet"),
      "retired-derived-wallet-key",
    );
    archiveMatchingRows(
      "invite_codes",
      derived("wallet"),
      "retired-derived-wallet-key",
    );
    archiveMatchingRows(
      "points_events",
      `${derived("wallet")} OR ${derived("related_wallet")}`,
      "retired-derived-wallet-key",
    );
    archiveMatchingRows(
      "referrals",
      `${derived("wallet")} OR ${derived("referrer_wallet")}`,
      "retired-derived-wallet-key",
    );
    archiveMatchingRows(
      "invited_wallets",
      `${derived("referrer")} OR ${derived("invitee")}`,
      "retired-derived-wallet-key",
    );

    if (columnNames(database, "wallet_points").has("staking_points")) {
      const rows = database
        .query(
          `SELECT wallet, CAST(staking_points AS TEXT) AS staking_points
             FROM wallet_points
            WHERE staking_points <> 0
            ORDER BY wallet ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        archive(
          "wallet_points.staking_points",
          String(row.wallet),
          row,
          "retired-staking-points",
        );
      }
      database.run("ALTER TABLE wallet_points DROP COLUMN staking_points");
    }
    if (legacyAmountColumn) {
      const rows = database
        .query(
          `SELECT id, CAST(source_amount AS TEXT) AS source_amount
             FROM bets
            WHERE source_amount <> 0
            ORDER BY id ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        archive(
          "bets.source_amount",
          String(row.id),
          row,
          "retired-decimal-source-amount",
        );
      }
      database.run("ALTER TABLE bets DROP COLUMN source_amount");
    }

    let renamedTableCount = 0;
    for (const tableName of RETIRED_ACTIVE_TABLES) {
      if (!tables.has(tableName)) continue;
      const archiveTableName = `keeper_legacy_table_${tableName}`;
      if (tables.has(archiveTableName)) {
        throw new Error(
          `legacy archive table already exists: ${archiveTableName}`,
        );
      }
      database.run(
        `ALTER TABLE ${quoteIdentifier(tableName)} RENAME TO ${quoteIdentifier(archiveTableName)}`,
      );
      renamedTableCount += 1;
    }

    database.run(`PRAGMA user_version = ${KEEPER_LAUNCH_SCHEMA_VERSION}`);
    database
      .prepare(
        `UPDATE keeper_legacy_migrations
        SET archived_row_count = ?, renamed_table_count = ?
        WHERE id = ?`,
      )
      .run(archivedRowCount, renamedTableCount, migrationId);
    const audit = inspectKeeperDatabaseCompatibility(database);
    if (!audit.compatible) {
      throw new Error(
        `legacy migration did not converge: ${audit.blockers.join("; ")}`,
      );
    }
    database.run("COMMIT");
    return {
      migrationId,
      backupSha256: input.backupSha256,
      archivedRowCount,
      renamedTableCount,
      audit,
    };
  } catch (error) {
    try {
      database.run("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}
