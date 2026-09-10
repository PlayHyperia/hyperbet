import { describe, expect, test } from "bun:test";

import { normalizeFightStartTime } from "../../scripts/e2e-bet-sync-timeline";

describe("E2E canonical bet-sync timeline", () => {
  test("preserves a fight start once combat has begun", () => {
    expect(
      normalizeFightStartTime({
        phase: "FIGHTING",
        scheduledFightStartTime: 2_000,
        duelEndTime: null,
        emittedAt: 2_500,
      }),
    ).toBe(2_000);
    expect(
      normalizeFightStartTime({
        phase: "RESOLUTION",
        scheduledFightStartTime: 2_000,
        duelEndTime: 3_000,
        emittedAt: 3_500,
      }),
    ).toBe(2_000);
  });

  test("does not claim combat began when a duel ended before its scheduled start", () => {
    expect(
      normalizeFightStartTime({
        phase: "RESOLUTION",
        scheduledFightStartTime: 2_000,
        duelEndTime: 1_900,
        emittedAt: 2_500,
      }),
    ).toBeNull();
  });

  test("does not publish a future or absent fight start", () => {
    expect(
      normalizeFightStartTime({
        phase: "FIGHTING",
        scheduledFightStartTime: 3_000,
        duelEndTime: null,
        emittedAt: 2_500,
      }),
    ).toBeNull();
    expect(
      normalizeFightStartTime({
        phase: "FIGHTING",
        scheduledFightStartTime: null,
        duelEndTime: null,
        emittedAt: 2_500,
      }),
    ).toBeNull();
  });

  test("does not claim combat began while the feed is still pre-fight", () => {
    expect(
      normalizeFightStartTime({
        phase: "ANNOUNCEMENT",
        scheduledFightStartTime: 2_000,
        duelEndTime: null,
        emittedAt: 2_500,
      }),
    ).toBeNull();
    expect(
      normalizeFightStartTime({
        phase: "COUNTDOWN",
        scheduledFightStartTime: 3_000,
        duelEndTime: null,
        emittedAt: 2_500,
      }),
    ).toBeNull();
  });
});
