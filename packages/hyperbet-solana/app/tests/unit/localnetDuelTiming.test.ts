import { describe, expect, test } from "bun:test";

import { resolveLocalnetDuelTiming } from "../e2e/localnetDuelTiming";

describe("local-validator prepared duel timing", () => {
  test("matches the keeper projection for a synthetic announcement", () => {
    expect(resolveLocalnetDuelTiming(1_800_000_000, null)).toEqual({
      betOpenTs: 1_799_999_970,
      betCloseTs: 1_800_003_600,
      duelStartTs: 1_800_003_601,
    });
  });

  test("uses the schema-v4 commitment while an announcement withholds fight start", () => {
    expect(
      resolveLocalnetDuelTiming(1_800_000_000, {
        betOpenTime: 1_799_999_000_000,
        betCloseTime: 1_800_001_000_000,
        fightStartTime: null,
        competitiveSnapshot: {
          timing: { fightStartTime: 1_800_001_004_000 },
        },
      }),
    ).toEqual({
      betOpenTs: 1_799_999_000,
      betCloseTs: 1_800_001_000,
      duelStartTs: 1_800_001_004,
    });
  });

  test("preserves a canonical countdown fight-start boundary", () => {
    expect(
      resolveLocalnetDuelTiming(1_800_000_000, {
        betOpenTime: 1_799_999_000_000,
        betCloseTime: 1_800_001_000_000,
        fightStartTime: 1_800_001_030_000,
        competitiveSnapshot: {
          timing: { fightStartTime: 1_800_001_030_000 },
        },
      }),
    ).toEqual({
      betOpenTs: 1_799_999_000,
      betCloseTs: 1_800_001_000,
      duelStartTs: 1_800_001_030,
    });
  });

  test("rejects malformed or contradictory canonical timing", () => {
    expect(() =>
      resolveLocalnetDuelTiming(1_800_000_000, {
        betOpenTime: 1_800_001_000_000,
        betCloseTime: 1_800_000_000_000,
        fightStartTime: null,
        competitiveSnapshot: {
          timing: { fightStartTime: 1_800_000_004_000 },
        },
      }),
    ).toThrow("betOpenTime must be before betCloseTime");

    expect(() =>
      resolveLocalnetDuelTiming(1_800_000_000, {
        betOpenTime: 1_799_999_000_000,
        betCloseTime: 1_800_001_000_000,
        fightStartTime: 1_800_000_000_000,
        competitiveSnapshot: {
          timing: { fightStartTime: 1_800_000_000_000 },
        },
      }),
    ).toThrow("fightStartTime must be after betCloseTime");

    expect(() =>
      resolveLocalnetDuelTiming(1_800_000_000, {
        betOpenTime: 1_799_999_000_000,
        betCloseTime: 1_800_001_000_000,
        fightStartTime: null,
      }),
    ).toThrow("schema-v4 timing must commit a positive fightStartTime");

    expect(() =>
      resolveLocalnetDuelTiming(1_800_000_000, {
        betOpenTime: 1_799_999_000_000,
        betCloseTime: 1_800_001_000_000,
        fightStartTime: 1_800_001_005_000,
        competitiveSnapshot: {
          timing: { fightStartTime: 1_800_001_004_000 },
        },
      }),
    ).toThrow("published fightStartTime must match schema-v4 timing");
  });
});
