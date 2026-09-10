import { describe, expect, test } from "bun:test";

import {
  buildDuelCancellationMetadata,
  buildDuelLifecycleMetadata,
  classifyDuelTerminal,
  classifyOracleCancellation,
  classifyOracleFinalizeError,
  classifyOracleLock,
  parseDuelCancellationMetadata,
  parseDuelLifecycleMetadata,
  isOracleTimestampMature,
  resolveOracleDuelEndTimestamp,
} from "./duelTerminalPolicy";

describe("canonical SOL duel terminal policy", () => {
  test("makes refund outcomes dominant over contradictory winner data", () => {
    expect(
      classifyDuelTerminal({
        outcome: "draw",
        cancellationReason: null,
        winnerId: "agent-a",
        agent1Id: "agent-a",
        agent2Id: "agent-b",
      }),
    ).toEqual({ action: "cancel", outcome: "draw", reason: "draw" });
    expect(
      classifyDuelTerminal({
        outcome: "cancelled",
        cancellationReason: "combat_engagement_failed",
        winnerId: "agent-b",
        agent1Id: "agent-a",
        agent2Id: "agent-b",
      }),
    ).toEqual({
      action: "cancel",
      outcome: "cancelled",
      reason: "combat_engagement_failed",
    });
  });

  test("settles only a canonical participant winner", () => {
    expect(
      classifyDuelTerminal({
        outcome: "win",
        winnerId: "agent-a",
        agent1Id: "agent-a",
        agent2Id: "agent-b",
      }),
    ).toEqual({
      action: "settle",
      winnerSide: "A",
      compatibilityMode: "canonical",
    });
  });

  test("rejects missing and mismatched winners", () => {
    expect(
      classifyDuelTerminal({
        outcome: null,
        winnerId: "agent-a",
        agent1Id: "agent-a",
        agent2Id: "agent-b",
      }),
    ).toEqual({ action: "reject", reason: "canonical_outcome_missing" });
    expect(
      classifyDuelTerminal({
        outcome: "win",
        winnerId: null,
        agent1Id: "agent-a",
        agent2Id: "agent-b",
      }),
    ).toEqual({ action: "reject", reason: "winner_id_missing" });
    expect(
      classifyDuelTerminal({
        outcome: "win",
        winnerId: "agent-c",
        agent1Id: "agent-a",
        agent2Id: "agent-b",
      }),
    ).toEqual({
      action: "reject",
      reason: "winner_id_does_not_match_participants",
    });
  });

  test("never overwrites resolved or in-dispute oracle outcomes", () => {
    expect(classifyOracleCancellation("scheduled")).toBe("cancel");
    expect(classifyOracleCancellation("bettingOpen")).toBe("cancel");
    expect(classifyOracleCancellation("locked")).toBe("cancel");
    expect(classifyOracleCancellation("cancelled")).toBe("already_cancelled");
    expect(classifyOracleCancellation("resolved")).toBe("preserve_resolved");
    expect(classifyOracleCancellation("proposed")).toBe("manual_review");
    expect(classifyOracleCancellation("challenged")).toBe("manual_review");
    expect(classifyOracleCancellation("missing")).toBe("fail_closed");
    expect(classifyOracleCancellation("unknown")).toBe("fail_closed");
  });

  test("locks only an open oracle and treats later lifecycle states idempotently", () => {
    expect(classifyOracleLock("bettingOpen")).toBe("lock");
    expect(classifyOracleLock("locked")).toBe("already_locked");
    expect(classifyOracleLock("proposed")).toBe("already_locked");
    expect(classifyOracleLock("challenged")).toBe("already_locked");
    expect(classifyOracleLock("resolved")).toBe("terminal");
    expect(classifyOracleLock("cancelled")).toBe("terminal");
    expect(classifyOracleLock("scheduled")).toBe("fail_closed");
    expect(classifyOracleLock("missing")).toBe("fail_closed");
  });

  test("uses fail-closed Solana chain timestamps for lifecycle deadlines", () => {
    expect(isOracleTimestampMature(null, 100)).toBe(false);
    expect(isOracleTimestampMature(Number.NaN, 100)).toBe(false);
    expect(isOracleTimestampMature(99, 100)).toBe(false);
    expect(isOracleTimestampMature(100, 100)).toBe(true);
    expect(isOracleTimestampMature(101, 100)).toBe(true);
    expect(isOracleTimestampMature(100.5, 100)).toBe(false);
  });

  test("accepts only canonical terminal timestamps at or after duel start", () => {
    expect(
      resolveOracleDuelEndTimestamp({
        duelEndTimeMs: 1_700_000_000_999,
        duelStartTs: 1_700_000_000,
      }),
    ).toBe(1_700_000_000);
    expect(() =>
      resolveOracleDuelEndTimestamp({
        duelEndTimeMs: null,
        duelStartTs: 1_700_000_000,
      }),
    ).toThrow("missing a valid duelEndTime");
    expect(() =>
      resolveOracleDuelEndTimestamp({
        duelEndTimeMs: Number.NaN,
        duelStartTs: 1_700_000_000,
      }),
    ).toThrow("missing a valid duelEndTime");
    expect(() =>
      resolveOracleDuelEndTimestamp({
        duelEndTimeMs: 1_699_999_999_999,
        duelStartTs: 1_700_000_000,
      }),
    ).toThrow("precedes immutable on-chain duel start");
    expect(() =>
      resolveOracleDuelEndTimestamp({
        duelEndTimeMs: 1_700_000_001_000,
        duelStartTs: 0,
      }),
    ).toThrow("on-chain duel start is unavailable");
  });

  test("classifies only expected oracle finalization races as recoverable", () => {
    expect(
      classifyOracleFinalizeError(
        new Error("AnchorError: Error Code: DisputeWindowActive"),
      ),
    ).toBe("not_mature");
    expect(classifyOracleFinalizeError(new Error("Error Number: 6017"))).toBe(
      "not_mature",
    );
    expect(
      classifyOracleFinalizeError(
        new Error("Transaction failed: custom program error: 0x1781"),
      ),
    ).toBe("not_mature");

    for (const message of [
      "AnchorError: Error Code: NotProposed",
      "AnchorError: Error Code: DuelAlreadyFinalized",
      "Error Number: 6014",
      "custom program error: 0x177b",
    ]) {
      expect(classifyOracleFinalizeError(new Error(message))).toBe(
        "state_race",
      );
    }
    expect(
      classifyOracleFinalizeError(new Error("Unauthorized oracle action")),
    ).toBe("fatal");
  });

  test("builds exact bounded cancellation metadata", () => {
    const metadata = buildDuelCancellationMetadata({
      duelId: "duel-42",
      duelKey: `0x${"AB".repeat(32)}`,
      outcome: "cancelled",
      reason: "combat_engagement_failed",
    });
    expect(parseDuelCancellationMetadata(metadata)).toEqual({
      duelId: "duel-42",
      duelKeyHex: "ab".repeat(32),
      outcome: "cancelled",
      reason: "combat_engagement_failed",
    });
    expect(Buffer.byteLength(metadata, "utf8")).toBeLessThanOrEqual(200);
  });

  test("uses versioned compact metadata without truncating a persisted recovery reason", () => {
    const duelId = "streaming-580e9afa-4376-4131-9ea5-65e68d81fe53";
    const duelKeyHex =
      "47173603507bfbc54708f3d822efbc13039010423c2330485a63196cf5033040";
    const reason = "competitive_snapshot_recovery_window_elapsed";
    const metadata = buildDuelCancellationMetadata({
      duelId,
      duelKey: duelKeyHex,
      outcome: "cancelled",
      reason,
    });

    expect(JSON.parse(metadata)).toMatchObject({
      v: 1,
      d: duelId,
      o: "c",
      r: reason,
    });
    expect(parseDuelCancellationMetadata(metadata)).toEqual({
      duelId,
      duelKeyHex,
      outcome: "cancelled",
      reason,
    });
    expect(Buffer.byteLength(metadata, "utf8")).toBeLessThanOrEqual(200);
  });

  test("fails closed instead of truncating an unrepresentable cancellation reason", () => {
    expect(() =>
      buildDuelCancellationMetadata({
        duelId: "streaming-580e9afa-4376-4131-9ea5-65e68d81fe53",
        duelKey: "ab".repeat(32),
        outcome: "cancelled",
        reason: `reason_${"x".repeat(121)}`,
      }),
    ).toThrow("Exact cancellation metadata exceeds 200 metadata bytes");
    expect(() =>
      buildDuelCancellationMetadata({
        duelId: "duel-42",
        duelKey: "ab".repeat(32),
        outcome: "cancelled",
        reason: "not a canonical reason",
      }),
    ).toThrow("exact canonical reason");
  });

  test("builds bounded lifecycle metadata with canonical snapshot correlation", () => {
    const metadata = buildDuelLifecycleMetadata({
      duelId: "duel-42",
      duelKey: `0x${"AB".repeat(32)}`,
      snapshotVersion: 3,
      snapshotDigest: "CD".repeat(32),
    });
    expect(parseDuelLifecycleMetadata(metadata)).toEqual({
      duelId: "duel-42",
      duelKeyHex: "ab".repeat(32),
      snapshotVersion: 3,
      snapshotDigest: "cd".repeat(32),
    });
    expect(Buffer.byteLength(metadata, "utf8")).toBeLessThanOrEqual(200);

    const compact = buildDuelLifecycleMetadata({
      duelId: "x".repeat(70),
      duelKey: "ab".repeat(32),
      snapshotVersion: 9,
      snapshotDigest: "cd".repeat(32),
    });
    expect(JSON.parse(compact).v).toBe(2);
    expect(parseDuelLifecycleMetadata(compact)).toEqual({
      duelId: "x".repeat(70),
      duelKeyHex: "ab".repeat(32),
      snapshotVersion: 9,
      snapshotDigest: "cd".repeat(32),
    });
    expect(Buffer.byteLength(compact, "utf8")).toBeLessThanOrEqual(200);
  });

  test("rejects lifecycle metadata that cannot preserve canonical identity", () => {
    expect(() =>
      buildDuelLifecycleMetadata({
        duelId: "x".repeat(200),
        duelKey: "ab".repeat(32),
        snapshotVersion: 1,
        snapshotDigest: "cd".repeat(32),
      }),
    ).toThrow("Exact duel lifecycle metadata exceeds 200 metadata bytes");
    expect(() =>
      buildDuelLifecycleMetadata({
        duelId: "duel-42",
        duelKey: "invalid",
        snapshotVersion: 1,
        snapshotDigest: "cd".repeat(32),
      }),
    ).toThrow("32-byte duel key");
    expect(() =>
      buildDuelLifecycleMetadata({
        duelId: "duel-42",
        duelKey: "ab".repeat(32),
        snapshotVersion: 1,
        snapshotDigest: "invalid",
      }),
    ).toThrow("32-byte snapshot digest");
    for (const snapshotVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() =>
        buildDuelLifecycleMetadata({
          duelId: "duel-42",
          duelKey: "ab".repeat(32),
          snapshotVersion,
          snapshotDigest: "cd".repeat(32),
        }),
      ).toThrow("positive unsigned 32-bit snapshot version");
    }
  });

  test("rejects cancellation metadata that cannot preserve canonical identity", () => {
    expect(() =>
      buildDuelCancellationMetadata({
        duelId: "x".repeat(200),
        duelKey: "ab".repeat(32),
        outcome: "cancelled",
        reason: "fixture_cancelled",
      }),
    ).toThrow("Exact cancellation metadata exceeds 200 metadata bytes");
  });
});
