import { describe, expect, test } from "bun:test";

import { refreshSyntheticStreamHeartbeat } from "./streamStateHeartbeat";

describe("synthetic stream heartbeat", () => {
  test("refreshes liveness without mutating or promoting renderer authority", () => {
    const original = {
      emittedAt: 100,
      cycle: {
        duelId: "duel-1",
        rendererHealth: {
          ready: false,
          degradedReason: "renderer-offline",
          updatedAt: 100,
        },
      },
    };
    const refreshed = refreshSyntheticStreamHeartbeat(original, 200);

    expect(refreshed).toEqual({
      emittedAt: 200,
      cycle: {
        duelId: "duel-1",
        rendererHealth: {
          ready: false,
          degradedReason: "renderer-offline",
          updatedAt: 200,
        },
      },
    });
    expect(original.emittedAt).toBe(100);
    expect(original.cycle.rendererHealth.updatedAt).toBe(100);
  });

  test("does not invent missing renderer health", () => {
    expect(
      refreshSyntheticStreamHeartbeat({ cycle: { rendererHealth: null } }, 200),
    ).toEqual({ emittedAt: 200, cycle: { rendererHealth: null } });
  });

  test("rejects invalid transport time", () => {
    expect(() =>
      refreshSyntheticStreamHeartbeat({ cycle: {} }, Number.NaN),
    ).toThrow("positive integer");
    expect(() => refreshSyntheticStreamHeartbeat({ cycle: {} }, 0)).toThrow(
      "positive integer",
    );
  });
});
