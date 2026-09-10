import { describe, expect, test } from "bun:test";

import {
  resolveAcceptedStreamCursor,
  shouldAcceptStreamStateCandidate,
} from "./streamStateCandidatePolicy";

describe("stream-state candidate policy", () => {
  const current = { seq: 40, emittedAt: 1_700_000_000_000 };

  test("accepts stable heartbeats and monotonic advancement", () => {
    expect(
      shouldAcceptStreamStateCandidate(current, current, {
        sourceAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldAcceptStreamStateCandidate(
        current,
        { seq: 41, emittedAt: current.emittedAt + 1 },
        { sourceAvailable: true },
      ),
    ).toBe(true);
  });

  test("rejects sequence, timestamp, and malformed cursor regressions", () => {
    for (const candidate of [
      { seq: 39, emittedAt: current.emittedAt + 1 },
      { seq: 41, emittedAt: current.emittedAt - 1 },
      { seq: Number.NaN, emittedAt: current.emittedAt + 1 },
      { seq: -1, emittedAt: current.emittedAt + 1 },
      { seq: 40.5, emittedAt: current.emittedAt + 1 },
      { seq: 41, emittedAt: 0 },
      { seq: 41, emittedAt: current.emittedAt + 0.5 },
      { seq: 41, emittedAt: Number.MAX_SAFE_INTEGER + 1 },
      { seq: 41, emittedAt: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        shouldAcceptStreamStateCandidate(current, candidate, {
          sourceAvailable: true,
        }),
      ).toBe(false);
    }
  });

  test("permits a sequence reset only after outage and newer authority time", () => {
    expect(
      shouldAcceptStreamStateCandidate(
        current,
        { seq: 1, emittedAt: current.emittedAt + 1 },
        { sourceAvailable: false },
      ),
    ).toBe(true);
    expect(
      shouldAcceptStreamStateCandidate(
        current,
        { seq: 1, emittedAt: current.emittedAt },
        { sourceAvailable: false },
      ),
    ).toBe(false);
  });

  test("re-establishes trust from an invalid local cursor without weakening the candidate", () => {
    expect(
      shouldAcceptStreamStateCandidate(
        { seq: Number.NaN, emittedAt: 0 },
        current,
        { sourceAvailable: true },
      ),
    ).toBe(true);
    expect(
      shouldAcceptStreamStateCandidate(
        { seq: Number.NaN, emittedAt: 0 },
        { seq: 1, emittedAt: current.emittedAt + 0.5 },
        { sourceAvailable: false },
      ),
    ).toBe(false);
  });

  test("preserves an accepted producer cursor exactly and rejects invalid authority", () => {
    expect(resolveAcceptedStreamCursor(current)).toEqual(current);
    expect(resolveAcceptedStreamCursor(current)).not.toBe(current);

    for (const candidate of [
      { seq: -1, emittedAt: current.emittedAt },
      { seq: 1, emittedAt: current.emittedAt + 0.5 },
      { seq: 1, emittedAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => resolveAcceptedStreamCursor(candidate)).toThrow(
        "invalid canonical cursor",
      );
    }
  });
});
