import { describe, expect, test } from "bun:test";

import { resolveDuelLifecycleTiming } from "./duelLifecycleTiming";

describe("duel lifecycle timing", () => {
  test("commits the announcement's scheduled fight boundary on first upsert", () => {
    expect(
      resolveDuelLifecycleTiming({
        existing: null,
        betOpenTimeMs: 1_700_000_000_900,
        betCloseTimeMs: 1_700_000_120_900,
        fightStartTimeMs: 1_700_000_126_900,
        nowMs: 1_700_000_000_950,
      }),
    ).toEqual({
      betOpenTs: 1_700_000_000,
      betCloseTs: 1_700_000_120,
      duelStartTs: 1_700_000_126,
    });
  });

  test("preserves the first on-chain timing across later lock payloads", () => {
    const existing = {
      betOpenTs: 1_700_000_000,
      betCloseTs: 1_700_000_120,
      duelStartTs: 1_700_000_120,
    };

    expect(
      resolveDuelLifecycleTiming({
        existing,
        betOpenTimeMs: 1_700_000_000_000,
        betCloseTimeMs: 1_700_000_120_000,
        fightStartTimeMs: 1_700_000_130_000,
        nowMs: 1_700_000_120_000,
      }),
    ).toEqual(existing);
  });

  test("derives a canonical initial window when fight start is not known", () => {
    expect(
      resolveDuelLifecycleTiming({
        existing: null,
        betOpenTimeMs: 1_700_000_000_900,
        betCloseTimeMs: 1_700_000_120_900,
        fightStartTimeMs: null,
        nowMs: 1_700_000_000_950,
      }),
    ).toEqual({
      betOpenTs: 1_700_000_000,
      betCloseTs: 1_700_000_120,
      duelStartTs: 1_700_000_120,
    });
  });

  test("fails closed instead of replacing malformed existing timing", () => {
    expect(() =>
      resolveDuelLifecycleTiming({
        existing: {
          betOpenTs: 1_700_000_000,
          betCloseTs: 1_700_000_120,
          duelStartTs: 1_700_000_119,
        },
        betOpenTimeMs: 1_700_000_000_000,
        betCloseTimeMs: 1_700_000_120_000,
        fightStartTimeMs: 1_700_000_130_000,
        nowMs: 1_700_000_120_000,
      }),
    ).toThrow("Existing duel contains invalid immutable timing");
  });
});
