import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TerminalLedger,
  TerminalOperationConflictError,
  type TerminalOperationInput,
} from "./terminalLedger";
import { buildDuelCorrelationId } from "./duelCorrelation";
import type { StreamingCycle } from "./game-client";
import { buildTestCompetitiveSnapshot } from "./testCompetitiveSnapshot";

function terminalInput(
  overrides: Partial<TerminalOperationInput> = {},
): TerminalOperationInput {
  const input: TerminalOperationInput = {
    duelId: "duel-1",
    duelKey: "11".repeat(32),
    outcome: "WIN",
    winnerSide: "A",
    participantAId: "agent-a",
    participantBId: "agent-b",
    winnerId: "agent-a",
    reason: null,
    seed: "42",
    replayHash: "ab".repeat(32),
    event: { schemaVersion: 3, duelId: "duel-1", outcome: "win" },
  };
  return { ...input, ...overrides };
}

function evidenceCycle(
  overrides: Partial<StreamingCycle> = {},
): StreamingCycle {
  const identity = {
    cycleId: "cycle-evidence-1",
    duelId: "duel-evidence-1",
    duelKeyHex: "31".repeat(32),
    betOpenTime: 1_700_000_000_000,
    betCloseTime: 1_700_000_060_000,
  };
  const snapshot = buildTestCompetitiveSnapshot({
    cycleId: identity.cycleId,
    duelId: identity.duelId,
    duelKey: identity.duelKeyHex,
    betOpenTime: identity.betOpenTime,
    betCloseTime: identity.betCloseTime,
  });
  return {
    sourceEpoch: 7,
    seq: 1,
    emittedAt: identity.betOpenTime,
    phaseVersion: 1,
    cycleId: identity.cycleId,
    phase: "ANNOUNCEMENT",
    duelId: identity.duelId,
    duelKeyHex: identity.duelKeyHex,
    competitiveSnapshotVersion: snapshot.competitiveSnapshotVersion,
    competitiveSnapshotDigest: snapshot.competitiveSnapshotDigest,
    competitiveSnapshot: snapshot.competitiveSnapshot,
    betOpenTime: identity.betOpenTime,
    betCloseTime: identity.betCloseTime,
    fightStartTime: null,
    duelEndTime: null,
    winnerId: null,
    outcome: null,
    cancellationReason: null,
    winReason: null,
    seed: null,
    replayHash: null,
    agent1: {
      id: "agent-a",
      name: "Agent A",
      provider: "provider-a",
      model: "model-a",
      hp: 30,
      maxHp: 30,
      combatLevel: 42,
      wins: 12,
      losses: 4,
      damageDealtThisFight: 0,
      rank: 1,
      headToHeadWins: 3,
      headToHeadLosses: 2,
      strategySummary: {
        schemaVersion: 1,
        approach: "balanced",
        tacticalMacro: "pressure",
        attackStyle: "aggressive",
        prayer: "superhuman_strength",
        preferredCombatRole: null,
        foodThreshold: 40,
        switchDefensiveAt: 30,
        source: "deterministic",
        policyVersion: "keeper-test-policy-v1",
      },
    },
    agent2: {
      id: "agent-b",
      name: "Agent B",
      provider: "provider-b",
      model: "model-b",
      hp: 30,
      maxHp: 30,
      combatLevel: 42,
      wins: 10,
      losses: 6,
      damageDealtThisFight: 0,
      rank: 2,
      headToHeadWins: 2,
      headToHeadLosses: 3,
      strategySummary: {
        schemaVersion: 1,
        approach: "balanced",
        tacticalMacro: "pressure",
        attackStyle: "aggressive",
        prayer: "superhuman_strength",
        preferredCombatRole: null,
        foodThreshold: 40,
        switchDefensiveAt: 30,
        source: "deterministic",
        policyVersion: "keeper-test-policy-v1",
      },
    },
    ...overrides,
  };
}

function evidenceCheckpoint(
  cycle: StreamingCycle,
  terminalEventKey: string | null = null,
) {
  return {
    sourceEpoch: cycle.sourceEpoch,
    lastAppliedSeq: cycle.seq,
    lastEmittedAt: cycle.emittedAt,
    duelId: cycle.duelId,
    competitiveSnapshotDigest: cycle.competitiveSnapshotDigest,
    betOpenTime: cycle.betOpenTime,
    betCloseTime: cycle.betCloseTime,
    fightStartTime: cycle.fightStartTime,
    duelEndTime: cycle.duelEndTime,
    phase: cycle.phase,
    terminal: cycle.outcome !== null,
    terminalEventKey,
    updatedAt: cycle.emittedAt,
  };
}

describe("persistent terminal operation ledger", () => {
  let tempDir: string;
  let dbPath: string;
  let ledgers: TerminalLedger[];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "terminal-ledger-"));
    dbPath = path.join(tempDir, "keeper.sqlite");
    ledgers = [];
  });

  afterEach(() => {
    for (const ledger of ledgers) ledger.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function openLedger(): TerminalLedger {
    const ledger = new TerminalLedger(dbPath);
    ledgers.push(ledger);
    return ledger;
  }

  test("rejects an absent all-zero winning replay commitment", () => {
    const ledger = openLedger();
    expect(() =>
      ledger.enqueue(terminalInput({ replayHash: "00".repeat(32) }), 1_000),
    ).toThrow("require seed and replayHash");
    expect(ledger.getSummary().PENDING).toBe(0);
  });

  test("enqueues idempotently and persists across reopen", () => {
    const firstLedger = openLedger();
    const first = firstLedger.enqueue(terminalInput(), 1_000);
    const duplicate = firstLedger.enqueue(terminalInput(), 2_000);
    expect(duplicate.id).toBe(first.id);
    expect(firstLedger.getSummary().PENDING).toBe(1);
    firstLedger.close();
    ledgers.splice(ledgers.indexOf(firstLedger), 1);

    const reopened = openLedger();
    expect(reopened.getByDuelId("duel-1")).toMatchObject({
      correlationId: buildDuelCorrelationId({
        duelId: "duel-1",
        duelKey: "11".repeat(32),
      }),
      status: "PENDING",
      attempts: 0,
      outcome: "WIN",
      winnerSide: "A",
    });
    expect(reopened.listOperationCorrelations(["PENDING"])).toEqual([
      { status: "PENDING", correlationId: first.correlationId },
    ]);
  });

  test("quarantines contradictory terminal truth for manual review", () => {
    const ledger = openLedger();
    const retained = ledger.enqueue(terminalInput(), 1_000);

    const conflicting = terminalInput({
      winnerSide: "B",
      winnerId: "agent-b",
      replayHash: "cd".repeat(32),
      event: {
        schemaVersion: 3,
        duelId: "duel-1",
        outcome: "win",
        winnerSide: "B",
      },
    });

    expect(() => ledger.enqueue(conflicting, 2_000)).toThrow(
      TerminalOperationConflictError,
    );
    expect(ledger.getByDuelId("duel-1")).toMatchObject({
      status: "MANUAL_REVIEW",
    });
    expect(ledger.getConflictRecords(retained.id)).toEqual([
      expect.objectContaining({
        operationId: retained.id,
        duelId: retained.duelId,
        retainedFingerprint: retained.fingerprint,
        conflictingInput: conflicting,
        observedAt: 2_000,
      }),
    ]);
    expect(
      ledger.getConflictRecords(retained.id)[0]?.conflictingFingerprint,
    ).not.toBe(retained.fingerprint);
  });

  test("leases each due operation to one owner and marks success", () => {
    const ledger = openLedger();
    const queued = ledger.enqueue(terminalInput(), 1_000);
    const [claimed] = ledger.claimDue({
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 5_000,
    });
    expect(claimed).toMatchObject({
      id: queued.id,
      status: "PROCESSING",
      attempts: 1,
      leaseOwner: "worker-a",
    });
    expect(
      ledger.claimByDuelId({
        duelId: "duel-1",
        ownerId: "worker-b",
        now: 1_001,
      }),
    ).toBeNull();

    ledger.markSucceeded(queued.id, "worker-a", 1_100);
    expect(ledger.getByDuelId("duel-1")).toMatchObject({
      status: "SUCCEEDED",
      completedAt: 1_100,
      leaseOwner: null,
    });
  });

  test("recovers expired leases after a process crash", () => {
    const ledger = openLedger();
    ledger.enqueue(terminalInput(), 1_000);
    ledger.claimDue({ ownerId: "crashed-worker", now: 1_000, leaseMs: 1_000 });

    expect(ledger.releaseExpiredLeases(1_999)).toBe(0);
    expect(ledger.releaseExpiredLeases(2_000)).toBe(1);
    expect(
      ledger.claimByDuelId({
        duelId: "duel-1",
        ownerId: "replacement",
        now: 2_000,
      }),
    ).toMatchObject({ status: "PROCESSING", attempts: 2 });
  });

  test("uses bounded retries and dead-letters exhausted operations", () => {
    const ledger = openLedger();
    const queued = ledger.enqueue(terminalInput(), 1_000);
    ledger.claimByDuelId({ duelId: "duel-1", ownerId: "worker", now: 1_000 });
    expect(
      ledger.markRetry({
        id: queued.id,
        ownerId: "worker",
        error: new Error("RPC unavailable"),
        nextAttemptAt: 2_000,
        maxAttempts: 2,
        now: 1_100,
      }),
    ).toBe("PENDING");
    expect(
      ledger.claimByDuelId({ duelId: "duel-1", ownerId: "worker", now: 1_999 }),
    ).toBeNull();
    ledger.claimByDuelId({ duelId: "duel-1", ownerId: "worker", now: 2_000 });
    expect(
      ledger.markRetry({
        id: queued.id,
        ownerId: "worker",
        error: "still unavailable",
        nextAttemptAt: 4_000,
        maxAttempts: 2,
        now: 2_100,
      }),
    ).toBe("DEAD_LETTER");
    expect(ledger.getByDuelId("duel-1")).toMatchObject({
      status: "DEAD_LETTER",
      attempts: 2,
      lastError: "still unavailable",
    });
  });

  test("records manual review only while the worker owns the lease", () => {
    const ledger = openLedger();
    const queued = ledger.enqueue(
      terminalInput({
        outcome: "DRAW",
        winnerSide: null,
        reason: "draw",
        seed: null,
        replayHash: null,
      }),
      1_000,
    );
    ledger.claimByDuelId({ duelId: "duel-1", ownerId: "worker", now: 1_000 });
    ledger.markManualReview(queued.id, "worker", "challenged oracle", 1_100);
    expect(ledger.getByDuelId("duel-1")).toMatchObject({
      status: "MANUAL_REVIEW",
      lastError: "challenged oracle",
    });
  });

  test("lists recovery work by status without mutating it", () => {
    const ledger = openLedger();
    ledger.enqueue(terminalInput({ duelId: "duel-pending" }), 1_000);
    const manual = ledger.enqueue(
      terminalInput({ duelId: "duel-manual", duelKey: "22".repeat(32) }),
      2_000,
    );
    ledger.claimByDuelId({
      duelId: "duel-manual",
      ownerId: "worker",
      now: 2_000,
    });
    ledger.markManualReview(manual.id, "worker", "oracle challenged", 2_100);

    expect(
      ledger.listOperations({ statuses: ["MANUAL_REVIEW"] }).map((record) => ({
        duelId: record.duelId,
        status: record.status,
      })),
    ).toEqual([{ duelId: "duel-manual", status: "MANUAL_REVIEW" }]);
    expect(ledger.getSummary()).toMatchObject({
      PENDING: 1,
      MANUAL_REVIEW: 1,
    });
  });

  test("reports exact actionable age authority and recent completion durations", () => {
    const ledger = openLedger();
    const succeeded = ledger.enqueue(terminalInput(), 1_000);
    ledger.claimByDuelId({
      duelId: succeeded.duelId,
      ownerId: "worker",
      now: 1_100,
    });
    ledger.markSucceeded(succeeded.id, "worker", 1_450);
    ledger.enqueue(
      terminalInput({ duelId: "duel-pending", duelKey: "22".repeat(32) }),
      2_000,
    );
    const manual = ledger.enqueue(
      terminalInput({ duelId: "duel-manual", duelKey: "33".repeat(32) }),
      3_000,
    );
    ledger.claimByDuelId({
      duelId: manual.duelId,
      ownerId: "worker",
      now: 3_100,
    });
    ledger.markManualReview(manual.id, "worker", "operator review", 3_200);

    expect(ledger.getOperationsTelemetry()).toEqual({
      summary: {
        PENDING: 1,
        PROCESSING: 0,
        SUCCEEDED: 1,
        MANUAL_REVIEW: 1,
        DEAD_LETTER: 0,
      },
      oldestActionableCreatedAt: 2_000,
      recentSucceededDurationsMs: [450],
    });
    expect(() => ledger.getOperationsTelemetry(101)).toThrow("record limit");
  });

  test("requires exact fingerprint confirmation and records an atomic requeue audit", () => {
    const firstLedger = openLedger();
    const queued = firstLedger.enqueue(terminalInput(), 1_000);
    firstLedger.claimByDuelId({
      duelId: queued.duelId,
      ownerId: "worker",
      now: 1_000,
    });
    firstLedger.markManualReview(
      queued.id,
      "worker",
      "RPC api-key=super-secret unavailable",
      1_100,
    );
    const secondLedger = openLedger();

    expect(() =>
      firstLedger.requeueForOperator({
        id: queued.id,
        expectedFingerprint: "ff".repeat(32),
        actor: "ops@example.com",
        reason: "Verified oracle state and RPC recovery",
        now: 2_000,
      }),
    ).toThrow("fingerprint confirmation failed");
    expect(firstLedger.getOperatorAuditEvents()).toHaveLength(0);

    const result = firstLedger.requeueForOperator({
      id: queued.id,
      expectedFingerprint: queued.fingerprint,
      actor: "ops@example.com",
      reason: "Verified oracle state and RPC recovery",
      now: 2_000,
    });
    expect(result.operation).toMatchObject({
      id: queued.id,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: 2_000,
      lastError: null,
      requeueCount: 1,
      lastRequeuedAt: 2_000,
      lastRequeuedBy: "ops@example.com",
    });
    expect(result.auditEvent).toMatchObject({
      operationId: queued.id,
      duelId: queued.duelId,
      fingerprint: queued.fingerprint,
      action: "REQUEUE",
      actor: "ops@example.com",
      reason: "Verified oracle state and RPC recovery",
      fromStatus: "MANUAL_REVIEW",
      toStatus: "PENDING",
      priorAttempts: 1,
      priorLastError: "RPC api-key=*** unavailable",
      createdAt: 2_000,
    });

    expect(() =>
      secondLedger.requeueForOperator({
        id: queued.id,
        expectedFingerprint: queued.fingerprint,
        actor: "second-operator",
        reason: "Attempting a concurrent duplicate recovery",
        now: 2_001,
      }),
    ).toThrow("cannot be requeued from PENDING");
    expect(
      secondLedger.getOperatorAuditEvents({ operationId: queued.id }),
    ).toHaveLength(1);
  });

  test("requeues dead letters with a fresh bounded-attempt budget", () => {
    const ledger = openLedger();
    const queued = ledger.enqueue(terminalInput(), 1_000);
    ledger.claimByDuelId({
      duelId: queued.duelId,
      ownerId: "worker",
      now: 1_000,
    });
    expect(
      ledger.markRetry({
        id: queued.id,
        ownerId: "worker",
        error: "permanent RPC failure",
        nextAttemptAt: 1_500,
        maxAttempts: 1,
        now: 1_100,
      }),
    ).toBe("DEAD_LETTER");

    ledger.requeueForOperator({
      id: queued.id,
      expectedFingerprint: queued.fingerprint,
      actor: "incident-commander",
      reason: "RPC incident resolved and state independently checked",
      now: 2_000,
    });
    expect(
      ledger.claimByDuelId({
        duelId: queued.duelId,
        ownerId: "replacement-worker",
        now: 2_000,
      }),
    ).toMatchObject({ attempts: 1, requeueCount: 1 });
  });

  test("refuses unsafe operator identities, reasons, and terminal states", () => {
    const ledger = openLedger();
    const queued = ledger.enqueue(terminalInput(), 1_000);
    expect(() =>
      ledger.requeueForOperator({
        id: queued.id,
        expectedFingerprint: queued.fingerprint,
        actor: "x",
        reason: "Verified safe retry state",
      }),
    ).toThrow("operator actor");
    expect(() =>
      ledger.requeueForOperator({
        id: queued.id,
        expectedFingerprint: queued.fingerprint,
        actor: "operator-one",
        reason: "too short",
      }),
    ).toThrow("operator reason");
    expect(() =>
      ledger.requeueForOperator({
        id: queued.id,
        expectedFingerprint: queued.fingerprint,
        actor: "operator-one",
        reason: "Confirmed state but record is still pending",
      }),
    ).toThrow("cannot be requeued from PENDING");
    expect(ledger.getOperatorAuditEvents()).toHaveLength(0);
    expect(() =>
      ledger.listOperations({ statuses: ["PENDING"], limit: Number.NaN }),
    ).toThrow("record limit");
    expect(() => ledger.getOperatorAuditEvents({ operationId: 0 })).toThrow(
      "positive integer",
    );
    expect(() =>
      ledger.requeueForOperator({
        id: queued.id,
        expectedFingerprint: queued.fingerprint,
        actor: "operator-one",
        reason: "Confirmed state but supplied an invalid timestamp",
        now: Number.NaN,
      }),
    ).toThrow("timestamp");
  });

  test("migrates an existing terminal ledger for auditable recovery", () => {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`CREATE TABLE terminal_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duel_id TEXT NOT NULL UNIQUE,
      duel_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      outcome TEXT NOT NULL,
      winner_side TEXT,
      participant_a_id TEXT,
      participant_b_id TEXT,
      winner_id TEXT,
      reason TEXT,
      seed TEXT,
      replay_hash TEXT,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`);
    legacy.run(`CREATE TABLE betting_feed_checkpoint (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source_epoch INTEGER NOT NULL,
      last_applied_seq INTEGER NOT NULL,
      last_emitted_at INTEGER NOT NULL,
      duel_id TEXT,
      competitive_snapshot_digest TEXT,
      phase TEXT,
      terminal INTEGER NOT NULL,
      degraded_reason TEXT,
      updated_at INTEGER NOT NULL
    )`);
    legacy.run(
      `INSERT INTO betting_feed_checkpoint (
        id, source_epoch, last_applied_seq, last_emitted_at, duel_id,
        competitive_snapshot_digest, phase, terminal, degraded_reason,
        updated_at
      ) VALUES (1, 8, 13, 1700000000000, 'legacy-duel', ?, 'RESOLUTION', 1, NULL, 1700000000000)`,
      ["88".repeat(32)],
    );
    legacy.close(false);

    const ledger = openLedger();
    expect(ledger.getBettingFeedCheckpoint()).toMatchObject({
      duelId: "legacy-duel",
      terminal: true,
      terminalEventKey: null,
    });
    expect(ledger.enqueue(terminalInput(), 1_000)).toMatchObject({
      requeueCount: 0,
      lastRequeuedAt: null,
      lastRequeuedBy: null,
    });
    expect(ledger.getOperatorAuditEvents()).toEqual([]);
  });

  test("persists and clears fail-closed betting feed continuity state", () => {
    const ledger = openLedger();
    expect(ledger.getBettingFeedCheckpoint()).toBeNull();

    ledger.markBettingFeedDegraded(
      "gap contains api-key=feed-secret and requires review",
      1_000,
    );
    expect(ledger.getBettingFeedCheckpoint()).toMatchObject({
      sourceEpoch: 0,
      lastAppliedSeq: 0,
      terminal: true,
      degradedReason: "gap contains api-key=*** and requires review",
      updatedAt: 1_000,
    });

    expect(
      ledger.saveBettingFeedCheckpoint({
        sourceEpoch: 100,
        lastAppliedSeq: 9,
        lastEmittedAt: 1_700_000_000_000,
        duelId: "duel-9",
        competitiveSnapshotDigest: "99".repeat(32),
        betOpenTime: 1_700_000_000_000,
        betCloseTime: 1_700_000_060_000,
        fightStartTime: 1_700_000_064_000,
        duelEndTime: null,
        phase: "FIGHTING",
        terminal: false,
        terminalEventKey: null,
        updatedAt: 2_000,
      }),
    ).toMatchObject({
      sourceEpoch: 100,
      lastAppliedSeq: 9,
      duelId: "duel-9",
      betOpenTime: 1_700_000_000_000,
      betCloseTime: 1_700_000_060_000,
      fightStartTime: 1_700_000_064_000,
      duelEndTime: null,
      phase: "FIGHTING",
      terminal: false,
      degradedReason: null,
      updatedAt: 2_000,
    });

    const terminalEventKey = "aa".repeat(32);
    expect(
      ledger.saveBettingFeedCheckpoint({
        sourceEpoch: 100,
        lastAppliedSeq: 10,
        lastEmittedAt: 1_700_000_001_000,
        duelId: "duel-9",
        competitiveSnapshotDigest: "99".repeat(32),
        betOpenTime: 1_700_000_000_000,
        betCloseTime: 1_700_000_060_000,
        fightStartTime: 1_700_000_064_000,
        duelEndTime: 1_700_000_120_000,
        phase: "RESOLUTION",
        terminal: true,
        terminalEventKey,
        updatedAt: 3_000,
      }),
    ).toMatchObject({
      lastAppliedSeq: 10,
      fightStartTime: 1_700_000_064_000,
      duelEndTime: 1_700_000_120_000,
      terminal: true,
      terminalEventKey,
      degradedReason: null,
      updatedAt: 3_000,
    });

    expect(
      ledger.saveBettingFeedCheckpoint({
        sourceEpoch: 100,
        lastAppliedSeq: 11,
        lastEmittedAt: 1_700_000_122_000,
        duelId: "duel-9",
        competitiveSnapshotDigest: "99".repeat(32),
        betOpenTime: 1_700_000_000_000,
        betCloseTime: 1_700_000_060_000,
        fightStartTime: 1_700_000_064_000,
        duelEndTime: 1_700_000_120_000,
        phase: "IDLE",
        terminal: true,
        terminalEventKey,
        updatedAt: 3_500,
      }),
    ).toMatchObject({
      lastAppliedSeq: 11,
      duelId: "duel-9",
      phase: "IDLE",
      terminal: true,
      terminalEventKey,
    });
    ledger.close();
    ledgers.splice(ledgers.indexOf(ledger), 1);
    const reopened = openLedger();
    expect(reopened.getBettingFeedCheckpoint()).toMatchObject({
      lastAppliedSeq: 11,
      duelId: "duel-9",
      duelEndTime: 1_700_000_120_000,
      phase: "IDLE",
      terminal: true,
      terminalEventKey,
      degradedReason: null,
    });

    expect(() =>
      reopened.saveBettingFeedCheckpoint({
        sourceEpoch: 100,
        lastAppliedSeq: 12,
        lastEmittedAt: 1_700_000_123_000,
        duelId: "duel-9",
        competitiveSnapshotDigest: "99".repeat(32),
        phase: "RESOLUTION",
        terminal: true,
        terminalEventKey: null,
        updatedAt: 4_000,
      }),
    ).toThrow("terminal event checkpoint is invalid");
  });

  test("atomically retains one compact material timeline and immutable snapshot per duel", () => {
    const ledger = openLedger();
    const announcement = evidenceCycle();
    ledger.saveBettingFeedCheckpoint(
      evidenceCheckpoint(announcement),
      announcement,
    );

    const repeatedAnnouncement = evidenceCycle({
      seq: 2,
      emittedAt: announcement.emittedAt + 250,
    });
    ledger.saveBettingFeedCheckpoint(
      evidenceCheckpoint(repeatedAnnouncement),
      repeatedAnnouncement,
    );

    const fightStartTime = announcement.betCloseTime! + 4_000;
    const fighting = evidenceCycle({
      seq: 3,
      emittedAt: fightStartTime + 3_000,
      phase: "FIGHTING",
      fightStartTime,
      agent1: { ...announcement.agent1!, hp: 24, damageDealtThisFight: 4 },
      agent2: { ...announcement.agent2!, hp: 26, damageDealtThisFight: 6 },
    });
    ledger.saveBettingFeedCheckpoint(evidenceCheckpoint(fighting), fighting);

    const resolution = evidenceCycle({
      seq: 4,
      emittedAt: fightStartTime + 15_000,
      phase: "RESOLUTION",
      fightStartTime,
      duelEndTime: fightStartTime + 15_000,
      winnerId: "agent-a",
      outcome: "win",
      winReason: "kill",
      seed: "42",
      replayHash: "ab".repeat(32),
      agent1: { ...announcement.agent1!, hp: 18, damageDealtThisFight: 30 },
      agent2: { ...announcement.agent2!, hp: 0, damageDealtThisFight: 12 },
    });
    ledger.saveBettingFeedCheckpoint(
      evidenceCheckpoint(resolution, "cd".repeat(32)),
      resolution,
    );

    const evidence = ledger.getBettingFeedDuelEvidence("duel-evidence-1");
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      proof: "hyperia-schema-v3-material-duel-timeline",
      duelId: "duel-evidence-1",
      duelKey: "31".repeat(32),
      competitiveSnapshotDigest: announcement.competitiveSnapshotDigest,
      firstSeq: 1,
      lastSeq: 4,
    });
    expect(evidence?.frames.map(({ seq, phase }) => ({ seq, phase }))).toEqual([
      { seq: 1, phase: "ANNOUNCEMENT" },
      { seq: 3, phase: "FIGHTING" },
      { seq: 4, phase: "RESOLUTION" },
    ]);
    expect(evidence?.timelineDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence?.competitiveSnapshot).toEqual(
      announcement.competitiveSnapshot,
    );

    ledger.close();
    ledgers.splice(ledgers.indexOf(ledger), 1);
    expect(openLedger().getBettingFeedDuelEvidence("duel-evidence-1")).toEqual(
      evidence,
    );
  });

  test("opens retained custody evidence without mutating or locking the live writer", () => {
    const writer = openLedger();
    const announcement = evidenceCycle();
    writer.saveBettingFeedCheckpoint(
      evidenceCheckpoint(announcement),
      announcement,
    );
    const reader = new TerminalLedger(dbPath, { readOnly: true });
    ledgers.push(reader);
    expect(reader.getBettingFeedDuelEvidence("duel-evidence-1")).toMatchObject({
      duelId: "duel-evidence-1",
      firstSeq: 1,
      lastSeq: 1,
    });

    const repeated = evidenceCycle({
      seq: 2,
      emittedAt: announcement.emittedAt + 250,
    });
    expect(() =>
      writer.saveBettingFeedCheckpoint(evidenceCheckpoint(repeated), repeated),
    ).not.toThrow();
    expect(reader.getBettingFeedCheckpoint()).toMatchObject({
      lastAppliedSeq: 2,
    });
    expect(() =>
      reader.saveBettingFeedCheckpoint(evidenceCheckpoint(repeated), repeated),
    ).toThrow();
  });

  test("rejects a changed accepted sequence without advancing its checkpoint", () => {
    const ledger = openLedger();
    const first = evidenceCycle();
    ledger.saveBettingFeedCheckpoint(evidenceCheckpoint(first), first);
    const contradictory = evidenceCycle({
      agent1: { ...first.agent1!, hp: 29 },
    });
    expect(() =>
      ledger.saveBettingFeedCheckpoint(
        {
          ...evidenceCheckpoint(contradictory),
          updatedAt: first.emittedAt + 500,
        },
        contradictory,
      ),
    ).toThrow("evidence sequence drifted");
    expect(ledger.getBettingFeedCheckpoint()).toMatchObject({
      lastAppliedSeq: 1,
      updatedAt: first.emittedAt,
    });
    expect(
      ledger.getBettingFeedDuelEvidence("duel-evidence-1")?.frames,
    ).toHaveLength(1);
  });

  test("rejects a second competitive snapshot for one duel without partial evidence", () => {
    const ledger = openLedger();
    const first = evidenceCycle();
    ledger.saveBettingFeedCheckpoint(evidenceCheckpoint(first), first);
    const changedSnapshot = buildTestCompetitiveSnapshot({
      cycleId: first.cycleId,
      duelId: first.duelId!,
      duelKey: first.duelKeyHex!,
      betOpenTime: first.betOpenTime!,
      betCloseTime: first.betCloseTime!,
      agent1: { id: "agent-a", name: "Changed Agent A" },
    });
    const drifted = evidenceCycle({
      seq: 2,
      emittedAt: first.emittedAt + 250,
      competitiveSnapshotVersion: changedSnapshot.competitiveSnapshotVersion,
      competitiveSnapshotDigest: changedSnapshot.competitiveSnapshotDigest,
      competitiveSnapshot: changedSnapshot.competitiveSnapshot,
      agent1: { ...first.agent1!, name: "Changed Agent A" },
    });
    expect(() =>
      ledger.saveBettingFeedCheckpoint(evidenceCheckpoint(drifted), drifted),
    ).toThrow("competitive snapshot evidence drifted");
    expect(ledger.getBettingFeedCheckpoint()).toMatchObject({
      lastAppliedSeq: 1,
      competitiveSnapshotDigest: first.competitiveSnapshotDigest,
    });
    expect(
      ledger.getBettingFeedDuelEvidence("duel-evidence-1")?.frames,
    ).toHaveLength(1);
  });
});
