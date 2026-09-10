import { describe, expect, test } from "bun:test";

import { buildSyntheticDuelCommitment } from "../e2e/syntheticDuelFixture";

const baseInput = {
  cycleId: "synthetic-clock-cycle",
  duelId: "synthetic-clock-duel",
  duelKeyHex: "12".repeat(32),
  betOpenTs: 1_000,
  betCloseTs: 1_060,
  duelStartTs: 1_064,
};

describe("synthetic duel commitment clock", () => {
  test("binds the exact on-chain duel start into the schema-v4 snapshot", () => {
    const commitment = buildSyntheticDuelCommitment(baseInput);

    expect(commitment.competitiveSnapshotVersion).toBe(4);
    expect(commitment.competitiveSnapshot.timing).toEqual({
      contractVersion: 2,
      timeoutPolicy: "hp_percentage_then_damage_then_draw_v1",
      countdownDurationMs: 4_000,
      fightingDurationMs: 30,
      endWarningDurationMs: 5,
      maxFightDurationMs: 35,
      fightStartTime: 1_064_000,
      fightDeadline: 1_064_035,
    });
    expect(commitment.competitiveSnapshotDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes the commitment when the on-chain start changes", () => {
    const first = buildSyntheticDuelCommitment(baseInput);
    const second = buildSyntheticDuelCommitment({
      ...baseInput,
      duelStartTs: baseInput.duelStartTs + 1,
    });

    expect(second.competitiveSnapshotDigest).not.toBe(
      first.competitiveSnapshotDigest,
    );
  });

  test.each([1_060, 1_059, 1_064.5])(
    "rejects an invalid on-chain duel start %s",
    (duelStartTs) => {
      expect(() =>
        buildSyntheticDuelCommitment({ ...baseInput, duelStartTs }),
      ).toThrow(/after betting closes/u);
    },
  );
});
