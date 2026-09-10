import { describe, expect, test } from "bun:test";

import {
  deriveStreamFailoverDecision,
  isAuthoritativeStreamPlaybackReady,
  isStreamPlaybackTransportReady,
  isStreamTransportPlaybackReady,
} from "../../src/lib/streamFailover";

describe("stream failover policy", () => {
  test("requires advancing program-date-aligned playback and live authority", () => {
    const ready = {
      telemetryConnected: true,
      playbackReady: true,
      playbackDateMs: 1_800_000_000_000,
      rendererReady: true,
      presentationReady: true,
    };
    expect(isAuthoritativeStreamPlaybackReady(ready)).toBe(true);
    expect(isStreamPlaybackTransportReady(ready)).toBe(true);
    expect(isStreamTransportPlaybackReady(ready)).toBe(true);
    for (const input of [
      { ...ready, telemetryConnected: false },
      { ...ready, playbackReady: false },
      { ...ready, playbackDateMs: null },
      { ...ready, playbackDateMs: Number.NaN },
      { ...ready, rendererReady: false },
      { ...ready, presentationReady: false },
    ]) {
      expect(isAuthoritativeStreamPlaybackReady(input)).toBe(false);
    }
    expect(
      isStreamPlaybackTransportReady({ ...ready, rendererReady: false }),
    ).toBe(true);
    expect(
      isStreamTransportPlaybackReady({ ...ready, rendererReady: false }),
    ).toBe(false);
  });

  test("moves through each configured source once per recovery round", () => {
    const first = deriveStreamFailoverDecision({
      currentSourceIndex: 0,
      failedSourceIndexes: [],
      sourceCount: 3,
    });
    expect(first).toEqual({
      exhausted: false,
      failedSourceIndexes: [0],
      nextSourceIndex: 1,
    });

    const second = deriveStreamFailoverDecision({
      currentSourceIndex: first.nextSourceIndex,
      failedSourceIndexes: first.failedSourceIndexes,
      sourceCount: 3,
    });
    expect(second).toEqual({
      exhausted: false,
      failedSourceIndexes: [0, 1],
      nextSourceIndex: 2,
    });

    expect(
      deriveStreamFailoverDecision({
        currentSourceIndex: second.nextSourceIndex,
        failedSourceIndexes: second.failedSourceIndexes,
        sourceCount: 3,
      }),
    ).toEqual({
      exhausted: true,
      failedSourceIndexes: [0, 1, 2],
      nextSourceIndex: 0,
    });
  });

  test("wraps to an untried primary after a healthy backup later fails", () => {
    expect(
      deriveStreamFailoverDecision({
        currentSourceIndex: 1,
        failedSourceIndexes: [],
        sourceCount: 2,
      }),
    ).toEqual({
      exhausted: false,
      failedSourceIndexes: [1],
      nextSourceIndex: 0,
    });
  });

  test("sanitizes invalid state and fails closed with no source", () => {
    expect(
      deriveStreamFailoverDecision({
        currentSourceIndex: 9,
        failedSourceIndexes: [-1, 0, 99, 0.5],
        sourceCount: 2,
      }),
    ).toEqual({
      exhausted: true,
      failedSourceIndexes: [0, 1],
      nextSourceIndex: 0,
    });
    expect(
      deriveStreamFailoverDecision({
        currentSourceIndex: 0,
        failedSourceIndexes: [],
        sourceCount: 0,
      }),
    ).toEqual({
      exhausted: true,
      failedSourceIndexes: [],
      nextSourceIndex: 0,
    });
  });
});
