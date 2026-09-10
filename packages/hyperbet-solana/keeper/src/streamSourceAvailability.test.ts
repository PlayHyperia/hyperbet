import { describe, expect, test } from "bun:test";

import {
  createInitialStreamSourceAvailability,
  isStreamSourceAvailable,
  transitionStreamSourceAvailability,
} from "./streamSourceAvailability";

describe("stream source availability", () => {
  test("requires a configured source to re-establish authority after relay startup", () => {
    expect(createInitialStreamSourceAvailability(true)).toEqual({
      unavailablePublished: true,
    });
    expect(
      isStreamSourceAvailable(createInitialStreamSourceAvailability(true)),
    ).toBe(false);
    expect(createInitialStreamSourceAvailability(false)).toEqual({
      unavailablePublished: false,
    });
  });

  test("publishes one unavailable edge per outage", () => {
    const initial = { unavailablePublished: false };
    const first = transitionStreamSourceAvailability(initial, "disconnected");
    const repeated = transitionStreamSourceAvailability(
      first.state,
      "disconnected",
    );

    expect(first).toEqual({
      state: { unavailablePublished: true },
      publishUnavailable: true,
    });
    expect(repeated).toEqual({
      state: { unavailablePublished: true },
      publishUnavailable: false,
    });
    expect(isStreamSourceAvailable(repeated.state)).toBe(false);
  });

  test("only an authoritative frame restores availability", () => {
    const restored = transitionStreamSourceAvailability(
      { unavailablePublished: true },
      "authoritative-frame",
    );
    expect(restored).toEqual({
      state: { unavailablePublished: false },
      publishUnavailable: false,
    });
    expect(isStreamSourceAvailable(restored.state)).toBe(true);
  });
});
