import { describe, expect, test } from "bun:test";

import {
  buildDuelCorrelationId,
  isDuelCorrelationId,
  normalizeDuelCorrelationIds,
} from "./duelCorrelation";

describe("duel correlation identity", () => {
  test("binds one canonical duel ID and key deterministically", () => {
    const input = { duelId: "duel-1", duelKey: "ab".repeat(32) };
    const first = buildDuelCorrelationId(input);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(buildDuelCorrelationId(input)).toBe(first);
    expect(buildDuelCorrelationId({ ...input, duelId: "duel-2" })).not.toBe(
      first,
    );
  });

  test("rejects noncanonical IDs and keys", () => {
    expect(() =>
      buildDuelCorrelationId({ duelId: " duel-1", duelKey: "ab".repeat(32) }),
    ).toThrow("canonical duel ID");
    expect(() =>
      buildDuelCorrelationId({ duelId: "duel-1", duelKey: "AB".repeat(32) }),
    ).toThrow("lowercase 32-byte duel key");
  });

  test("deduplicates, sorts, validates, and bounds incident correlation IDs", () => {
    const ids = Array.from({ length: 70 }, (_, index) =>
      buildDuelCorrelationId({
        duelId: `duel-${index}`,
        duelKey: index.toString(16).padStart(64, "0"),
      }),
    );
    const normalized = normalizeDuelCorrelationIds([
      ...ids,
      ids[0],
      "INVALID",
      null,
    ]);
    expect(normalized).toEqual([...new Set(ids)].sort().slice(0, 64));
    expect(normalized.every(isDuelCorrelationId)).toBe(true);
  });
});
