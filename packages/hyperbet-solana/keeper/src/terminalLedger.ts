import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";

import {
  buildBettingFeedDuelEvidence,
  canonicalEvidenceJson,
  normalizeBettingFeedEvidenceFrame,
  type BettingFeedCompetitiveSnapshotEvidence,
  type BettingFeedDuelEvidence,
  type BettingFeedEvidenceFrame,
} from "./bettingFeedEvidence";
import { buildDuelCorrelationId } from "./duelCorrelation";
import type { StreamingCycle } from "./game-client";

export type TerminalOperationOutcome = "WIN" | "DRAW" | "CANCELLED";
export type TerminalOperationStatus =
  "PENDING" | "PROCESSING" | "SUCCEEDED" | "MANUAL_REVIEW" | "DEAD_LETTER";

export type TerminalOperationInput = {
  duelId: string;
  duelKey: string;
  outcome: TerminalOperationOutcome;
  winnerSide: "A" | "B" | null;
  participantAId: string | null;
  participantBId: string | null;
  winnerId: string | null;
  reason: string | null;
  seed: string | null;
  replayHash: string | null;
  event: unknown;
};

export type TerminalOperationRecord = TerminalOperationInput & {
  id: number;
  correlationId: string;
  fingerprint: string;
  status: TerminalOperationStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  requeueCount: number;
  lastRequeuedAt: number | null;
  lastRequeuedBy: string | null;
};

export type TerminalLedgerSummary = Record<TerminalOperationStatus, number>;

export type TerminalLedgerOperationsTelemetry = {
  summary: TerminalLedgerSummary;
  oldestActionableCreatedAt: number | null;
  recentSucceededDurationsMs: number[];
};

export type TerminalOperationCorrelation = {
  status: TerminalOperationStatus;
  correlationId: string;
};

export type TerminalOperatorAuditEvent = {
  id: number;
  operationId: number;
  duelId: string;
  fingerprint: string;
  action: "REQUEUE";
  actor: string;
  reason: string;
  fromStatus: "MANUAL_REVIEW" | "DEAD_LETTER";
  toStatus: "PENDING";
  priorAttempts: number;
  priorLastError: string | null;
  createdAt: number;
};

export type TerminalOperatorRequeueResult = {
  operation: TerminalOperationRecord;
  auditEvent: TerminalOperatorAuditEvent;
};

export type TerminalLedgerOptions = {
  readOnly?: boolean;
};

export type TerminalOperationConflictRecord = {
  id: number;
  operationId: number;
  duelId: string;
  retainedFingerprint: string;
  conflictingFingerprint: string;
  conflictingInput: TerminalOperationInput;
  observedAt: number;
};

export type BettingFeedCheckpoint = {
  sourceEpoch: number;
  lastAppliedSeq: number;
  lastEmittedAt: number;
  duelId: string | null;
  competitiveSnapshotDigest: string | null;
  betOpenTime?: number | null;
  betCloseTime?: number | null;
  fightStartTime?: number | null;
  duelEndTime?: number | null;
  phase: string | null;
  terminal: boolean;
  terminalEventKey: string | null;
  degradedReason: string | null;
  updatedAt: number;
};

type TerminalOperationRow = {
  id: number;
  duelId: string;
  duelKey: string;
  fingerprint: string;
  outcome: TerminalOperationOutcome;
  winnerSide: "A" | "B" | null;
  participantAId: string | null;
  participantBId: string | null;
  winnerId: string | null;
  reason: string | null;
  seed: string | null;
  replayHash: string | null;
  eventJson: string;
  status: TerminalOperationStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  requeueCount: number;
  lastRequeuedAt: number | null;
  lastRequeuedBy: string | null;
};

type TerminalOperatorAuditRow = {
  id: number;
  operationId: number;
  duelId: string;
  fingerprint: string;
  action: "REQUEUE";
  actor: string;
  reason: string;
  fromStatus: "MANUAL_REVIEW" | "DEAD_LETTER";
  toStatus: "PENDING";
  priorAttempts: number;
  priorLastError: string | null;
  createdAt: number;
};

type TerminalOperationConflictRow = {
  id: number;
  operationId: number;
  duelId: string;
  retainedFingerprint: string;
  conflictingFingerprint: string;
  conflictingInputJson: string;
  observedAt: number;
};

type BettingFeedCheckpointRow = {
  sourceEpoch: number;
  lastAppliedSeq: number;
  lastEmittedAt: number;
  duelId: string | null;
  competitiveSnapshotDigest: string | null;
  betOpenTime: number | null;
  betCloseTime: number | null;
  fightStartTime: number | null;
  duelEndTime: number | null;
  phase: string | null;
  terminal: number;
  terminalEventKey: string | null;
  degradedReason: string | null;
  updatedAt: number;
};

type BettingFeedCompetitiveSnapshotRow = {
  duelId: string;
  duelKey: string;
  competitiveSnapshotDigest: string;
  competitiveSnapshotJson: string;
  firstSourceEpoch: number;
  firstSeq: number;
  firstEmittedAt: number;
};

type BettingFeedEvidenceFrameRow = {
  sourceEpoch: number;
  seq: number;
  frameJson: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultDbPath(): string {
  return process.env.KEEPER_DB_PATH?.trim()
    ? process.env.KEEPER_DB_PATH.trim()
    : path.resolve(__dirname, "..", "keeper.sqlite");
}

function normalizeInput(input: TerminalOperationInput): TerminalOperationInput {
  const duelId = input.duelId.trim();
  const duelKey = input.duelKey.trim().toLowerCase();
  const participantAId = input.participantAId?.trim() || null;
  const participantBId = input.participantBId?.trim() || null;
  const winnerId = input.winnerId?.trim() || null;
  if (!duelId) throw new Error("terminal operation duelId is required");
  if (!/^[0-9a-f]{64}$/.test(duelKey)) {
    throw new Error("terminal operation duelKey must be 32-byte hex");
  }
  if (input.outcome === "WIN" && !input.winnerSide) {
    throw new Error("WIN terminal operations require a winner side");
  }
  if (
    input.outcome === "WIN" &&
    (!participantAId ||
      !participantBId ||
      !winnerId ||
      (input.winnerSide === "A" && winnerId !== participantAId) ||
      (input.winnerSide === "B" && winnerId !== participantBId))
  ) {
    throw new Error("WIN terminal identity does not match its winner side");
  }
  if (input.outcome !== "WIN" && input.winnerSide) {
    throw new Error("refund terminal operations cannot contain a winner side");
  }
  const replayHash = input.replayHash?.trim().toLowerCase() || null;
  if (
    input.outcome === "WIN" &&
    (!input.seed?.trim() ||
      !replayHash ||
      !/^[0-9a-f]{64}$/.test(replayHash) ||
      replayHash === "0".repeat(64))
  ) {
    throw new Error("WIN terminal operations require seed and replayHash");
  }
  return {
    duelId,
    duelKey,
    outcome: input.outcome,
    winnerSide: input.winnerSide,
    participantAId,
    participantBId,
    winnerId,
    reason: input.reason?.trim() || null,
    seed: input.seed?.trim() || null,
    replayHash,
    event: input.event,
  };
}

function fingerprintInput(input: TerminalOperationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        duelId: input.duelId,
        duelKey: input.duelKey,
        outcome: input.outcome,
        winnerSide: input.winnerSide,
        participantAId: input.participantAId,
        participantBId: input.participantBId,
        winnerId: input.winnerId,
        reason: input.reason,
        seed: input.seed,
        replayHash: input.replayHash,
      }),
    )
    .digest("hex");
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/api-key=[^&\s]+/gi, "api-key=***")
    .replace(/authorization:\s*bearer\s+[^\s]+/gi, "authorization: Bearer ***")
    .slice(0, 2_000);
}

function normalizeOperatorActor(actor: string): string {
  const normalized = actor.trim();
  if (
    normalized.length < 3 ||
    normalized.length > 128 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:@/+\-]*$/.test(normalized)
  ) {
    throw new Error(
      "operator actor must be 3-128 characters using letters, numbers, or ._:@/+-",
    );
  }
  return normalized;
}

function normalizeOperatorReason(reason: string): string {
  const normalized = reason.trim().replace(/\s+/g, " ");
  if (normalized.length < 10 || normalized.length > 500) {
    throw new Error("operator reason must be 10-500 characters");
  }
  return normalized;
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("record limit must be an integer between 1 and 100");
  }
  return limit;
}

function normalizeTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("timestamp must be a non-negative integer");
  }
  return value;
}

export class TerminalOperationConflictError extends Error {
  constructor(duelId: string) {
    super(`conflicting terminal operation for duel ${duelId}`);
    this.name = "TerminalOperationConflictError";
  }
}

export class TerminalLedger {
  private readonly db: Database;

  constructor(dbPath = defaultDbPath(), options: TerminalLedgerOptions = {}) {
    this.db = new Database(
      dbPath,
      options.readOnly ? { readonly: true } : { create: true },
    );
    if (options.readOnly) return;
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`CREATE TABLE IF NOT EXISTS terminal_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duel_id TEXT NOT NULL UNIQUE,
      duel_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'DRAW', 'CANCELLED')),
      winner_side TEXT CHECK (winner_side IS NULL OR winner_side IN ('A', 'B')),
      participant_a_id TEXT,
      participant_b_id TEXT,
      winner_id TEXT,
      reason TEXT,
      seed TEXT,
      replay_hash TEXT,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'MANUAL_REVIEW', 'DEAD_LETTER')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      requeue_count INTEGER NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
      last_requeued_at INTEGER,
      last_requeued_by TEXT
    )`);
    const operationColumns = new Set(
      (
        this.db.query("PRAGMA table_info(terminal_operations)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    for (const migration of [
      {
        column: "requeue_count",
        sql: "ALTER TABLE terminal_operations ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0 CHECK (requeue_count >= 0)",
      },
      {
        column: "last_requeued_at",
        sql: "ALTER TABLE terminal_operations ADD COLUMN last_requeued_at INTEGER",
      },
      {
        column: "last_requeued_by",
        sql: "ALTER TABLE terminal_operations ADD COLUMN last_requeued_by TEXT",
      },
    ]) {
      if (!operationColumns.has(migration.column)) this.db.run(migration.sql);
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_terminal_operations_due
      ON terminal_operations (status, next_attempt_at)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS terminal_operator_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL,
      duel_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('REQUEUE')),
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      from_status TEXT NOT NULL CHECK (from_status IN ('MANUAL_REVIEW', 'DEAD_LETTER')),
      to_status TEXT NOT NULL CHECK (to_status IN ('PENDING')),
      prior_attempts INTEGER NOT NULL CHECK (prior_attempts >= 0),
      prior_last_error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (operation_id) REFERENCES terminal_operations(id)
    )`);
    this.db
      .run(`CREATE INDEX IF NOT EXISTS idx_terminal_operator_audit_operation
      ON terminal_operator_audit_events (operation_id, created_at DESC, id DESC)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS terminal_operation_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL,
      duel_id TEXT NOT NULL,
      retained_fingerprint TEXT NOT NULL,
      conflicting_fingerprint TEXT NOT NULL,
      conflicting_input_json TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      FOREIGN KEY (operation_id) REFERENCES terminal_operations(id)
    )`);
    this.db
      .run(`CREATE INDEX IF NOT EXISTS idx_terminal_operation_conflicts_operation
      ON terminal_operation_conflicts (operation_id, observed_at DESC, id DESC)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS betting_feed_checkpoint (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source_epoch INTEGER NOT NULL CHECK (source_epoch >= 0),
      last_applied_seq INTEGER NOT NULL CHECK (last_applied_seq >= 0),
      last_emitted_at INTEGER NOT NULL CHECK (last_emitted_at >= 0),
      duel_id TEXT,
      competitive_snapshot_digest TEXT,
      bet_open_time INTEGER CHECK (bet_open_time IS NULL OR bet_open_time >= 0),
      bet_close_time INTEGER CHECK (bet_close_time IS NULL OR bet_close_time >= 0),
      fight_start_time INTEGER CHECK (fight_start_time IS NULL OR fight_start_time >= 0),
      duel_end_time INTEGER CHECK (duel_end_time IS NULL OR duel_end_time >= 0),
      phase TEXT,
      terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
      terminal_event_key TEXT,
      degraded_reason TEXT,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    )`);
    const bettingFeedColumns = new Set(
      (
        this.db
          .query("PRAGMA table_info(betting_feed_checkpoint)")
          .all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    if (!bettingFeedColumns.has("competitive_snapshot_digest")) {
      this.db.run(
        "ALTER TABLE betting_feed_checkpoint ADD COLUMN competitive_snapshot_digest TEXT",
      );
    }
    if (!bettingFeedColumns.has("terminal_event_key")) {
      this.db.run(
        "ALTER TABLE betting_feed_checkpoint ADD COLUMN terminal_event_key TEXT",
      );
    }
    for (const column of [
      "bet_open_time",
      "bet_close_time",
      "fight_start_time",
      "duel_end_time",
    ]) {
      if (!bettingFeedColumns.has(column)) {
        this.db.run(
          `ALTER TABLE betting_feed_checkpoint ADD COLUMN ${column} INTEGER`,
        );
      }
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS betting_feed_competitive_snapshots (
      competitive_snapshot_digest TEXT PRIMARY KEY,
      duel_id TEXT NOT NULL UNIQUE,
      duel_key TEXT NOT NULL UNIQUE,
      competitive_snapshot_json TEXT NOT NULL,
      first_source_epoch INTEGER NOT NULL CHECK (first_source_epoch >= 0),
      first_seq INTEGER NOT NULL CHECK (first_seq >= 0),
      first_emitted_at INTEGER NOT NULL CHECK (first_emitted_at > 0)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS betting_feed_evidence_frames (
      source_epoch INTEGER NOT NULL CHECK (source_epoch >= 0),
      seq INTEGER NOT NULL CHECK (seq >= 0),
      emitted_at INTEGER NOT NULL CHECK (emitted_at > 0),
      duel_id TEXT NOT NULL,
      duel_key TEXT NOT NULL,
      competitive_snapshot_digest TEXT NOT NULL,
      phase TEXT NOT NULL,
      frame_digest TEXT NOT NULL,
      material_digest TEXT NOT NULL,
      frame_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL CHECK (recorded_at > 0),
      PRIMARY KEY (source_epoch, seq),
      UNIQUE (duel_id, frame_digest),
      FOREIGN KEY (competitive_snapshot_digest)
        REFERENCES betting_feed_competitive_snapshots(competitive_snapshot_digest)
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_betting_feed_evidence_duel
      ON betting_feed_evidence_frames (duel_id, source_epoch, seq)`);
  }

  close(): void {
    this.db.close(false);
  }

  private fromRow(row: TerminalOperationRow): TerminalOperationRecord {
    return {
      id: row.id,
      duelId: row.duelId,
      duelKey: row.duelKey,
      correlationId: buildDuelCorrelationId({
        duelId: row.duelId,
        duelKey: row.duelKey,
      }),
      fingerprint: row.fingerprint,
      outcome: row.outcome,
      winnerSide: row.winnerSide,
      participantAId: row.participantAId,
      participantBId: row.participantBId,
      winnerId: row.winnerId,
      reason: row.reason,
      seed: row.seed,
      replayHash: row.replayHash,
      event: JSON.parse(row.eventJson) as unknown,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt,
      lastError: row.lastError ? truncateError(row.lastError) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      requeueCount: row.requeueCount,
      lastRequeuedAt: row.lastRequeuedAt,
      lastRequeuedBy: row.lastRequeuedBy,
    };
  }

  private fromAuditRow(
    row: TerminalOperatorAuditRow,
  ): TerminalOperatorAuditEvent {
    return {
      id: row.id,
      operationId: row.operationId,
      duelId: row.duelId,
      fingerprint: row.fingerprint,
      action: row.action,
      actor: row.actor,
      reason: row.reason,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      priorAttempts: row.priorAttempts,
      priorLastError: row.priorLastError
        ? truncateError(row.priorLastError)
        : null,
      createdAt: row.createdAt,
    };
  }

  private fromConflictRow(
    row: TerminalOperationConflictRow,
  ): TerminalOperationConflictRecord {
    return {
      id: row.id,
      operationId: row.operationId,
      duelId: row.duelId,
      retainedFingerprint: row.retainedFingerprint,
      conflictingFingerprint: row.conflictingFingerprint,
      conflictingInput: JSON.parse(
        row.conflictingInputJson,
      ) as TerminalOperationInput,
      observedAt: row.observedAt,
    };
  }

  private selectByDuelId(duelId: string): TerminalOperationRecord | null {
    const row = this.db
      .query(
        `SELECT
          id,
          duel_id AS duelId,
          duel_key AS duelKey,
          fingerprint,
          outcome,
          winner_side AS winnerSide,
          participant_a_id AS participantAId,
          participant_b_id AS participantBId,
          winner_id AS winnerId,
          reason,
          seed,
          replay_hash AS replayHash,
          event_json AS eventJson,
          status,
          attempts,
          next_attempt_at AS nextAttemptAt,
          lease_owner AS leaseOwner,
          lease_expires_at AS leaseExpiresAt,
          last_error AS lastError,
          created_at AS createdAt,
          updated_at AS updatedAt,
          completed_at AS completedAt,
          requeue_count AS requeueCount,
          last_requeued_at AS lastRequeuedAt,
          last_requeued_by AS lastRequeuedBy
        FROM terminal_operations
        WHERE duel_id = ?`,
      )
      .get(duelId) as TerminalOperationRow | null;
    return row ? this.fromRow(row) : null;
  }

  private selectById(id: number): TerminalOperationRecord | null {
    const row = this.db
      .query(
        `SELECT
          id,
          duel_id AS duelId,
          duel_key AS duelKey,
          fingerprint,
          outcome,
          winner_side AS winnerSide,
          participant_a_id AS participantAId,
          participant_b_id AS participantBId,
          winner_id AS winnerId,
          reason,
          seed,
          replay_hash AS replayHash,
          event_json AS eventJson,
          status,
          attempts,
          next_attempt_at AS nextAttemptAt,
          lease_owner AS leaseOwner,
          lease_expires_at AS leaseExpiresAt,
          last_error AS lastError,
          created_at AS createdAt,
          updated_at AS updatedAt,
          completed_at AS completedAt,
          requeue_count AS requeueCount,
          last_requeued_at AS lastRequeuedAt,
          last_requeued_by AS lastRequeuedBy
        FROM terminal_operations
        WHERE id = ?`,
      )
      .get(id) as TerminalOperationRow | null;
    return row ? this.fromRow(row) : null;
  }

  enqueue(
    input: TerminalOperationInput,
    now = Date.now(),
  ): TerminalOperationRecord {
    const normalized = normalizeInput(input);
    const fingerprint = fingerprintInput(normalized);
    const eventJson = JSON.stringify(normalized.event);
    if (eventJson === undefined) {
      throw new Error("terminal operation event must be JSON serializable");
    }
    const normalizedInputJson = JSON.stringify(normalized);

    const existing = this.selectByDuelId(normalized.duelId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.db.transaction(() => {
          this.db
            .prepare(
              `UPDATE terminal_operations
                SET status = 'MANUAL_REVIEW',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    last_error = ?,
                    updated_at = ?
              WHERE id = ?`,
            )
            .run(
              truncateError(
                `conflicting fingerprint ${fingerprint}; retained ${existing.fingerprint}`,
              ),
              now,
              existing.id,
            );
          this.db
            .prepare(
              `INSERT INTO terminal_operation_conflicts (
                operation_id,
                duel_id,
                retained_fingerprint,
                conflicting_fingerprint,
                conflicting_input_json,
                observed_at
              ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              existing.id,
              existing.duelId,
              existing.fingerprint,
              fingerprint,
              normalizedInputJson,
              now,
            );
        })();
        throw new TerminalOperationConflictError(normalized.duelId);
      }
      return existing;
    }

    this.db
      .prepare(
        `INSERT INTO terminal_operations (
          duel_id,
          duel_key,
          fingerprint,
          outcome,
          winner_side,
          participant_a_id,
          participant_b_id,
          winner_id,
          reason,
          seed,
          replay_hash,
          event_json,
          status,
          attempts,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
      )
      .run(
        normalized.duelId,
        normalized.duelKey,
        fingerprint,
        normalized.outcome,
        normalized.winnerSide,
        normalized.participantAId,
        normalized.participantBId,
        normalized.winnerId,
        normalized.reason,
        normalized.seed,
        normalized.replayHash,
        eventJson,
        now,
        now,
        now,
      );
    const record = this.selectByDuelId(normalized.duelId);
    if (!record) throw new Error("failed to read inserted terminal operation");
    return record;
  }

  releaseExpiredLeases(now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE terminal_operations
            SET status = 'PENDING',
                lease_owner = NULL,
                lease_expires_at = NULL,
                next_attempt_at = ?,
                updated_at = ?
          WHERE status = 'PROCESSING'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    return Number(result.changes);
  }

  private claimIds(
    ids: number[],
    ownerId: string,
    now: number,
    leaseMs: number,
  ): TerminalOperationRecord[] {
    if (ids.length === 0) return [];
    const leaseExpiresAt = now + Math.max(1_000, leaseMs);
    const claim = this.db.prepare(
      `UPDATE terminal_operations
          SET status = 'PROCESSING',
              attempts = attempts + 1,
              lease_owner = ?,
              lease_expires_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'PENDING'
          AND next_attempt_at <= ?`,
    );
    const records: TerminalOperationRecord[] = [];
    for (const id of ids) {
      const result = claim.run(ownerId, leaseExpiresAt, now, id, now);
      if (Number(result.changes) !== 1) continue;
      const row = this.db
        .query(`SELECT duel_id AS duelId FROM terminal_operations WHERE id = ?`)
        .get(id) as { duelId: string } | null;
      if (!row) continue;
      const record = this.selectByDuelId(row.duelId);
      if (record) records.push(record);
    }
    return records;
  }

  claimByDuelId(input: {
    duelId: string;
    ownerId: string;
    now?: number;
    leaseMs?: number;
  }): TerminalOperationRecord | null {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      this.releaseExpiredLeases(now);
      const row = this.db
        .query(
          `SELECT id FROM terminal_operations
            WHERE duel_id = ? AND status = 'PENDING' AND next_attempt_at <= ?`,
        )
        .get(input.duelId, now) as { id: number } | null;
      return row
        ? (this.claimIds(
            [row.id],
            input.ownerId,
            now,
            input.leaseMs ?? 60_000,
          )[0] ?? null)
        : null;
    })();
  }

  claimDue(input: {
    ownerId: string;
    now?: number;
    leaseMs?: number;
    limit?: number;
  }): TerminalOperationRecord[] {
    const now = input.now ?? Date.now();
    const limit = Math.max(1, Math.min(100, input.limit ?? 10));
    return this.db.transaction(() => {
      this.releaseExpiredLeases(now);
      const rows = this.db
        .query(
          `SELECT id FROM terminal_operations
            WHERE status = 'PENDING' AND next_attempt_at <= ?
            ORDER BY next_attempt_at ASC, id ASC
            LIMIT ?`,
        )
        .all(now, limit) as Array<{ id: number }>;
      return this.claimIds(
        rows.map((row) => row.id),
        input.ownerId,
        now,
        input.leaseMs ?? 60_000,
      );
    })();
  }

  markSucceeded(id: number, ownerId: string, now = Date.now()): void {
    const result = this.db
      .prepare(
        `UPDATE terminal_operations
            SET status = 'SUCCEEDED',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                completed_at = ?,
                updated_at = ?
          WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?`,
      )
      .run(now, now, id, ownerId);
    if (Number(result.changes) !== 1) {
      throw new Error(`terminal operation ${id} lease was lost before success`);
    }
  }

  markManualReview(
    id: number,
    ownerId: string,
    error: unknown,
    now = Date.now(),
  ): void {
    const result = this.db
      .prepare(
        `UPDATE terminal_operations
            SET status = 'MANUAL_REVIEW',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = ?,
                updated_at = ?
          WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?`,
      )
      .run(truncateError(error), now, id, ownerId);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `terminal operation ${id} lease was lost before manual review`,
      );
    }
  }

  markRetry(input: {
    id: number;
    ownerId: string;
    error: unknown;
    nextAttemptAt: number;
    maxAttempts: number;
    now?: number;
  }): TerminalOperationStatus {
    const now = input.now ?? Date.now();
    const row = this.db
      .query(
        `SELECT attempts FROM terminal_operations
          WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?`,
      )
      .get(input.id, input.ownerId) as { attempts: number } | null;
    if (!row) {
      throw new Error(
        `terminal operation ${input.id} lease was lost before retry`,
      );
    }
    const status: TerminalOperationStatus =
      row.attempts >= Math.max(1, input.maxAttempts)
        ? "DEAD_LETTER"
        : "PENDING";
    this.db
      .prepare(
        `UPDATE terminal_operations
            SET status = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                next_attempt_at = ?,
                last_error = ?,
                updated_at = ?
          WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?`,
      )
      .run(
        status,
        input.nextAttemptAt,
        truncateError(input.error),
        now,
        input.id,
        input.ownerId,
      );
    return status;
  }

  listOperations(
    input: {
      statuses?: TerminalOperationStatus[];
      limit?: number;
    } = {},
  ): TerminalOperationRecord[] {
    const allowedStatuses = new Set<TerminalOperationStatus>([
      "PENDING",
      "PROCESSING",
      "SUCCEEDED",
      "MANUAL_REVIEW",
      "DEAD_LETTER",
    ]);
    const statuses = [
      ...new Set(input.statuses?.length ? input.statuses : allowedStatuses),
    ];
    if (statuses.some((status) => !allowedStatuses.has(status))) {
      throw new Error("invalid terminal operation status filter");
    }
    const limit = normalizeLimit(input.limit, 50);
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT id
           FROM terminal_operations
          WHERE status IN (${placeholders})
          ORDER BY updated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...statuses, limit) as Array<{ id: number }>;
    return rows
      .map((row) => this.selectById(row.id))
      .filter((record): record is TerminalOperationRecord => record !== null);
  }

  listOperationCorrelations(
    statuses: TerminalOperationStatus[],
    limit = 64,
  ): TerminalOperationCorrelation[] {
    const allowedStatuses = new Set<TerminalOperationStatus>([
      "PENDING",
      "PROCESSING",
      "SUCCEEDED",
      "MANUAL_REVIEW",
      "DEAD_LETTER",
    ]);
    const normalizedStatuses = [...new Set(statuses)];
    if (
      normalizedStatuses.length === 0 ||
      normalizedStatuses.some((status) => !allowedStatuses.has(status))
    ) {
      throw new Error("invalid terminal correlation status filter");
    }
    const normalizedLimit = normalizeLimit(limit, 64);
    const placeholders = normalizedStatuses.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT
           duel_id AS duelId,
           duel_key AS duelKey,
           status
         FROM terminal_operations
         WHERE status IN (${placeholders})
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...normalizedStatuses, normalizedLimit) as Array<{
      duelId: string;
      duelKey: string;
      status: TerminalOperationStatus;
    }>;
    return rows.map((row) => ({
      status: row.status,
      correlationId: buildDuelCorrelationId({
        duelId: row.duelId,
        duelKey: row.duelKey,
      }),
    }));
  }

  getOperatorAuditEvents(
    input: {
      operationId?: number;
      limit?: number;
    } = {},
  ): TerminalOperatorAuditEvent[] {
    const limit = normalizeLimit(input.limit, 50);
    if (input.operationId != null) {
      normalizePositiveInteger(input.operationId, "terminal operation id");
    }
    const rows =
      input.operationId == null
        ? (this.db
            .query(
              `SELECT
                id,
                operation_id AS operationId,
                duel_id AS duelId,
                fingerprint,
                action,
                actor,
                reason,
                from_status AS fromStatus,
                to_status AS toStatus,
                prior_attempts AS priorAttempts,
                prior_last_error AS priorLastError,
                created_at AS createdAt
               FROM terminal_operator_audit_events
               ORDER BY created_at DESC, id DESC
               LIMIT ?`,
            )
            .all(limit) as TerminalOperatorAuditRow[])
        : (this.db
            .query(
              `SELECT
                id,
                operation_id AS operationId,
                duel_id AS duelId,
                fingerprint,
                action,
                actor,
                reason,
                from_status AS fromStatus,
                to_status AS toStatus,
                prior_attempts AS priorAttempts,
                prior_last_error AS priorLastError,
                created_at AS createdAt
               FROM terminal_operator_audit_events
               WHERE operation_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?`,
            )
            .all(input.operationId, limit) as TerminalOperatorAuditRow[]);
    return rows.map((row) => this.fromAuditRow(row));
  }

  getConflictRecords(operationId: number): TerminalOperationConflictRecord[] {
    normalizePositiveInteger(operationId, "terminal operation id");
    const rows = this.db
      .query(
        `SELECT
          id,
          operation_id AS operationId,
          duel_id AS duelId,
          retained_fingerprint AS retainedFingerprint,
          conflicting_fingerprint AS conflictingFingerprint,
          conflicting_input_json AS conflictingInputJson,
          observed_at AS observedAt
         FROM terminal_operation_conflicts
         WHERE operation_id = ?
         ORDER BY observed_at DESC, id DESC`,
      )
      .all(operationId) as TerminalOperationConflictRow[];
    return rows.map((row) => this.fromConflictRow(row));
  }

  private persistBettingFeedEvidenceFrame(cycle: StreamingCycle): void {
    const normalized = normalizeBettingFeedEvidenceFrame(cycle);
    if (!normalized) return;
    const { frame, snapshot } = normalized;
    const competitiveSnapshotJson = canonicalEvidenceJson(
      snapshot.competitiveSnapshot,
    );
    const existingSnapshot = this.db
      .query(
        `SELECT
          duel_id AS duelId,
          duel_key AS duelKey,
          competitive_snapshot_digest AS competitiveSnapshotDigest,
          competitive_snapshot_json AS competitiveSnapshotJson,
          first_source_epoch AS firstSourceEpoch,
          first_seq AS firstSeq,
          first_emitted_at AS firstEmittedAt
         FROM betting_feed_competitive_snapshots
         WHERE competitive_snapshot_digest = ?
            OR duel_id = ?
            OR duel_key = ?
         LIMIT 1`,
      )
      .get(
        snapshot.competitiveSnapshotDigest,
        snapshot.duelId,
        snapshot.duelKey,
      ) as BettingFeedCompetitiveSnapshotRow | null;
    if (existingSnapshot) {
      if (
        existingSnapshot.duelId !== snapshot.duelId ||
        existingSnapshot.duelKey !== snapshot.duelKey ||
        existingSnapshot.competitiveSnapshotDigest !==
          snapshot.competitiveSnapshotDigest ||
        existingSnapshot.competitiveSnapshotJson !== competitiveSnapshotJson
      ) {
        throw new Error("betting feed competitive snapshot evidence drifted");
      }
    } else {
      this.db
        .prepare(
          `INSERT INTO betting_feed_competitive_snapshots (
            competitive_snapshot_digest,
            duel_id,
            duel_key,
            competitive_snapshot_json,
            first_source_epoch,
            first_seq,
            first_emitted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.competitiveSnapshotDigest,
          snapshot.duelId,
          snapshot.duelKey,
          competitiveSnapshotJson,
          snapshot.firstSourceEpoch,
          snapshot.firstSeq,
          snapshot.firstEmittedAt,
        );
    }

    const frameJson = canonicalEvidenceJson(frame);
    const existingFrame = this.db
      .query(
        `SELECT
          source_epoch AS sourceEpoch,
          seq,
          frame_json AS frameJson
         FROM betting_feed_evidence_frames
         WHERE source_epoch = ? AND seq = ?`,
      )
      .get(frame.sourceEpoch, frame.seq) as
      (BettingFeedEvidenceFrameRow & { frameJson: string }) | null;
    if (existingFrame) {
      if (existingFrame.frameJson !== frameJson) {
        throw new Error("betting feed evidence sequence drifted");
      }
      return;
    }

    const latestMaterial = this.db
      .query(
        `SELECT material_digest AS materialDigest
           FROM betting_feed_evidence_frames
          WHERE duel_id = ?
          ORDER BY source_epoch DESC, seq DESC
          LIMIT 1`,
      )
      .get(frame.duelId) as { materialDigest: string } | null;
    if (latestMaterial?.materialDigest === frame.materialDigest) return;

    this.db
      .prepare(
        `INSERT INTO betting_feed_evidence_frames (
          source_epoch,
          seq,
          emitted_at,
          duel_id,
          duel_key,
          competitive_snapshot_digest,
          phase,
          frame_digest,
          material_digest,
          frame_json,
          recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        frame.sourceEpoch,
        frame.seq,
        frame.emittedAt,
        frame.duelId,
        frame.duelKey,
        frame.competitiveSnapshotDigest,
        frame.phase,
        frame.frameDigest,
        frame.materialDigest,
        frameJson,
        Date.now(),
      );
  }

  getBettingFeedDuelEvidence(duelId: string): BettingFeedDuelEvidence | null {
    const normalizedDuelId = duelId.trim();
    if (!normalizedDuelId) {
      throw new Error("betting feed duel evidence requires a duel ID");
    }
    const snapshotRow = this.db
      .query(
        `SELECT
          duel_id AS duelId,
          duel_key AS duelKey,
          competitive_snapshot_digest AS competitiveSnapshotDigest,
          competitive_snapshot_json AS competitiveSnapshotJson,
          first_source_epoch AS firstSourceEpoch,
          first_seq AS firstSeq,
          first_emitted_at AS firstEmittedAt
         FROM betting_feed_competitive_snapshots
         WHERE duel_id = ?`,
      )
      .get(normalizedDuelId) as BettingFeedCompetitiveSnapshotRow | null;
    if (!snapshotRow) return null;
    const frameRows = this.db
      .query(
        `SELECT
          source_epoch AS sourceEpoch,
          seq,
          frame_json AS frameJson
         FROM betting_feed_evidence_frames
         WHERE duel_id = ?
         ORDER BY source_epoch ASC, seq ASC`,
      )
      .all(normalizedDuelId) as BettingFeedEvidenceFrameRow[];
    let competitiveSnapshot: unknown;
    const frames: BettingFeedEvidenceFrame[] = [];
    try {
      competitiveSnapshot = JSON.parse(snapshotRow.competitiveSnapshotJson);
      for (const row of frameRows) {
        frames.push(JSON.parse(row.frameJson) as BettingFeedEvidenceFrame);
      }
    } catch {
      throw new Error("persisted betting feed duel evidence is invalid JSON");
    }
    return buildBettingFeedDuelEvidence({
      snapshot: {
        duelId: snapshotRow.duelId,
        duelKey: snapshotRow.duelKey,
        competitiveSnapshotDigest: snapshotRow.competitiveSnapshotDigest,
        competitiveSnapshot:
          competitiveSnapshot as BettingFeedCompetitiveSnapshotEvidence["competitiveSnapshot"],
        firstSourceEpoch: snapshotRow.firstSourceEpoch,
        firstSeq: snapshotRow.firstSeq,
        firstEmittedAt: snapshotRow.firstEmittedAt,
      },
      frames,
    });
  }

  getBettingFeedCheckpoint(): BettingFeedCheckpoint | null {
    const row = this.db
      .query(
        `SELECT
          source_epoch AS sourceEpoch,
          last_applied_seq AS lastAppliedSeq,
          last_emitted_at AS lastEmittedAt,
          duel_id AS duelId,
          competitive_snapshot_digest AS competitiveSnapshotDigest,
          bet_open_time AS betOpenTime,
          bet_close_time AS betCloseTime,
          fight_start_time AS fightStartTime,
          duel_end_time AS duelEndTime,
          phase,
          terminal,
          terminal_event_key AS terminalEventKey,
          degraded_reason AS degradedReason,
          updated_at AS updatedAt
         FROM betting_feed_checkpoint
         WHERE id = 1`,
      )
      .get() as BettingFeedCheckpointRow | null;
    if (!row) return null;
    return {
      sourceEpoch: row.sourceEpoch,
      lastAppliedSeq: row.lastAppliedSeq,
      lastEmittedAt: row.lastEmittedAt,
      duelId: row.duelId,
      competitiveSnapshotDigest: row.competitiveSnapshotDigest,
      betOpenTime: row.betOpenTime,
      betCloseTime: row.betCloseTime,
      fightStartTime: row.fightStartTime,
      duelEndTime: row.duelEndTime,
      phase: row.phase,
      terminal: row.terminal === 1,
      terminalEventKey: row.terminalEventKey,
      degradedReason: row.degradedReason
        ? truncateError(row.degradedReason)
        : null,
      updatedAt: row.updatedAt,
    };
  }

  saveBettingFeedCheckpoint(
    checkpoint: Omit<BettingFeedCheckpoint, "degradedReason" | "updatedAt"> & {
      updatedAt?: number;
    },
    evidenceFrame?: StreamingCycle,
  ): BettingFeedCheckpoint {
    return this.db.transaction(() => {
      if (evidenceFrame) this.persistBettingFeedEvidenceFrame(evidenceFrame);
      return this.saveBettingFeedCheckpointTransaction(checkpoint);
    })();
  }

  private saveBettingFeedCheckpointTransaction(
    checkpoint: Omit<BettingFeedCheckpoint, "degradedReason" | "updatedAt"> & {
      updatedAt?: number;
    },
  ): BettingFeedCheckpoint {
    const sourceEpoch = normalizeTimestamp(checkpoint.sourceEpoch);
    const lastAppliedSeq = normalizeTimestamp(checkpoint.lastAppliedSeq);
    const lastEmittedAt = normalizeTimestamp(checkpoint.lastEmittedAt);
    const duelId = checkpoint.duelId?.trim() || null;
    const competitiveSnapshotDigest =
      checkpoint.competitiveSnapshotDigest?.trim() || null;
    const normalizeOptionalTimestamp = (
      value: number | null | undefined,
    ): number | null => (value == null ? null : normalizeTimestamp(value));
    const betOpenTime = normalizeOptionalTimestamp(checkpoint.betOpenTime);
    const betCloseTime = normalizeOptionalTimestamp(checkpoint.betCloseTime);
    const fightStartTime = normalizeOptionalTimestamp(
      checkpoint.fightStartTime,
    );
    const duelEndTime = normalizeOptionalTimestamp(checkpoint.duelEndTime);
    if (
      (duelId === null) !== (competitiveSnapshotDigest === null) ||
      (competitiveSnapshotDigest !== null &&
        !/^[0-9a-f]{64}$/.test(competitiveSnapshotDigest))
    ) {
      throw new Error(
        "betting feed competitive snapshot checkpoint is invalid",
      );
    }
    const phase = checkpoint.phase?.trim() || null;
    const terminalEventKey = checkpoint.terminalEventKey?.trim() || null;
    if (
      (terminalEventKey !== null && !checkpoint.terminal) ||
      (terminalEventKey !== null && !/^[0-9a-f]{64}$/.test(terminalEventKey)) ||
      (duelId === null && terminalEventKey !== null) ||
      (duelId !== null && checkpoint.terminal && terminalEventKey === null)
    ) {
      throw new Error("betting feed terminal event checkpoint is invalid");
    }
    const updatedAt = normalizeTimestamp(checkpoint.updatedAt ?? Date.now());
    this.db
      .prepare(
        `INSERT INTO betting_feed_checkpoint (
          id,
          source_epoch,
          last_applied_seq,
          last_emitted_at,
          duel_id,
          competitive_snapshot_digest,
          phase,
          bet_open_time,
          bet_close_time,
          fight_start_time,
          duel_end_time,
          terminal,
          terminal_event_key,
          degraded_reason,
          updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_epoch = excluded.source_epoch,
          last_applied_seq = excluded.last_applied_seq,
          last_emitted_at = excluded.last_emitted_at,
          duel_id = excluded.duel_id,
          competitive_snapshot_digest = excluded.competitive_snapshot_digest,
          phase = excluded.phase,
          bet_open_time = excluded.bet_open_time,
          bet_close_time = excluded.bet_close_time,
          fight_start_time = excluded.fight_start_time,
          duel_end_time = excluded.duel_end_time,
          terminal = excluded.terminal,
          terminal_event_key = excluded.terminal_event_key,
          degraded_reason = NULL,
          updated_at = excluded.updated_at`,
      )
      .run(
        sourceEpoch,
        lastAppliedSeq,
        lastEmittedAt,
        duelId,
        competitiveSnapshotDigest,
        phase,
        betOpenTime,
        betCloseTime,
        fightStartTime,
        duelEndTime,
        checkpoint.terminal ? 1 : 0,
        terminalEventKey,
        updatedAt,
      );
    const saved = this.getBettingFeedCheckpoint();
    if (!saved) throw new Error("failed to persist betting feed checkpoint");
    return saved;
  }

  markBettingFeedDegraded(reason: unknown, now = Date.now()): void {
    const updatedAt = normalizeTimestamp(now);
    const degradedReason = truncateError(reason);
    this.db
      .prepare(
        `INSERT INTO betting_feed_checkpoint (
          id,
          source_epoch,
          last_applied_seq,
          last_emitted_at,
          duel_id,
          competitive_snapshot_digest,
          phase,
          terminal,
          terminal_event_key,
          degraded_reason,
          updated_at
        ) VALUES (1, 0, 0, 0, NULL, NULL, NULL, 1, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          degraded_reason = excluded.degraded_reason,
          updated_at = CASE
            WHEN betting_feed_checkpoint.degraded_reason IS NULL
              OR betting_feed_checkpoint.degraded_reason <> excluded.degraded_reason
            THEN excluded.updated_at
            ELSE betting_feed_checkpoint.updated_at
          END`,
      )
      .run(degradedReason, updatedAt);
  }

  requeueForOperator(input: {
    id: number;
    expectedFingerprint: string;
    actor: string;
    reason: string;
    now?: number;
  }): TerminalOperatorRequeueResult {
    normalizePositiveInteger(input.id, "terminal operation id");
    const expectedFingerprint = input.expectedFingerprint.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
      throw new Error("expected fingerprint must be 32-byte hex");
    }
    const actor = normalizeOperatorActor(input.actor);
    const reason = normalizeOperatorReason(input.reason);
    const now = normalizeTimestamp(input.now ?? Date.now());

    return this.db.transaction(() => {
      const existing = this.selectById(input.id);
      if (!existing) {
        throw new Error(`terminal operation ${input.id} does not exist`);
      }
      if (existing.fingerprint !== expectedFingerprint) {
        throw new Error(
          `terminal operation ${input.id} fingerprint confirmation failed`,
        );
      }
      if (
        existing.status !== "MANUAL_REVIEW" &&
        existing.status !== "DEAD_LETTER"
      ) {
        throw new Error(
          `terminal operation ${input.id} cannot be requeued from ${existing.status}`,
        );
      }

      const result = this.db
        .prepare(
          `UPDATE terminal_operations
              SET status = 'PENDING',
                  attempts = 0,
                  next_attempt_at = ?,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  last_error = NULL,
                  completed_at = NULL,
                  requeue_count = requeue_count + 1,
                  last_requeued_at = ?,
                  last_requeued_by = ?,
                  updated_at = ?
            WHERE id = ?
              AND fingerprint = ?
              AND status = ?`,
        )
        .run(
          now,
          now,
          actor,
          now,
          existing.id,
          expectedFingerprint,
          existing.status,
        );
      if (Number(result.changes) !== 1) {
        throw new Error(
          `terminal operation ${input.id} changed concurrently; inspect it again before retrying`,
        );
      }

      const auditInsert = this.db
        .prepare(
          `INSERT INTO terminal_operator_audit_events (
            operation_id,
            duel_id,
            fingerprint,
            action,
            actor,
            reason,
            from_status,
            to_status,
            prior_attempts,
            prior_last_error,
            created_at
          ) VALUES (?, ?, ?, 'REQUEUE', ?, ?, ?, 'PENDING', ?, ?, ?)`,
        )
        .run(
          existing.id,
          existing.duelId,
          existing.fingerprint,
          actor,
          reason,
          existing.status,
          existing.attempts,
          existing.lastError ? truncateError(existing.lastError) : null,
          now,
        ) as { lastInsertRowid?: number | bigint };
      const auditId = Number(auditInsert.lastInsertRowid ?? 0);
      const operation = this.selectById(existing.id);
      const auditRow = this.db
        .query(
          `SELECT
            id,
            operation_id AS operationId,
            duel_id AS duelId,
            fingerprint,
            action,
            actor,
            reason,
            from_status AS fromStatus,
            to_status AS toStatus,
            prior_attempts AS priorAttempts,
            prior_last_error AS priorLastError,
            created_at AS createdAt
           FROM terminal_operator_audit_events
           WHERE id = ?`,
        )
        .get(auditId) as TerminalOperatorAuditRow | null;
      if (!operation || !auditRow) {
        throw new Error(
          `terminal operation ${input.id} requeue audit could not be verified`,
        );
      }
      return { operation, auditEvent: this.fromAuditRow(auditRow) };
    })();
  }

  getSummary(): TerminalLedgerSummary {
    const summary: TerminalLedgerSummary = {
      PENDING: 0,
      PROCESSING: 0,
      SUCCEEDED: 0,
      MANUAL_REVIEW: 0,
      DEAD_LETTER: 0,
    };
    const rows = this.db
      .query(
        `SELECT status, COUNT(*) AS count
           FROM terminal_operations
          GROUP BY status`,
      )
      .all() as Array<{ status: TerminalOperationStatus; count: number }>;
    for (const row of rows) summary[row.status] = Number(row.count);
    return summary;
  }

  getOperationsTelemetry(
    recentSuccessLimit = 100,
  ): TerminalLedgerOperationsTelemetry {
    const limit = normalizeLimit(recentSuccessLimit, 100);
    const oldestActionable = this.db
      .query(
        `SELECT MIN(created_at) AS createdAt
           FROM terminal_operations
          WHERE status IN ('PENDING', 'PROCESSING', 'MANUAL_REVIEW', 'DEAD_LETTER')`,
      )
      .get() as { createdAt: number | null } | null;
    const recentSucceeded = this.db
      .query(
        `SELECT created_at AS createdAt, completed_at AS completedAt
           FROM terminal_operations
          WHERE status = 'SUCCEEDED' AND completed_at IS NOT NULL
          ORDER BY completed_at DESC, id DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{ createdAt: number; completedAt: number }>;

    return {
      summary: this.getSummary(),
      oldestActionableCreatedAt: oldestActionable?.createdAt ?? null,
      recentSucceededDurationsMs: recentSucceeded.map((record) =>
        Math.max(0, Number(record.completedAt) - Number(record.createdAt)),
      ),
    };
  }

  getByDuelId(duelId: string): TerminalOperationRecord | null {
    return this.selectByDuelId(duelId.trim());
  }

  getById(id: number): TerminalOperationRecord | null {
    if (!Number.isInteger(id) || id <= 0) return null;
    return this.selectById(id);
  }
}
