import { describe, expect, test } from "bun:test";

import { buildResultHash } from "./resultHash";

const duelKey = "ab".repeat(32);
const replayHash = "cd".repeat(32);
const snapshotDigest = "ef".repeat(32);

function result(
  overrides: {
    duelKey?: string;
    winner?: "A" | "B";
    seed?: string;
    replayHash?: string;
    snapshotVersion?: number;
    snapshotDigest?: string;
  } = {},
): string {
  return Buffer.from(
    buildResultHash(
      overrides.duelKey ?? duelKey,
      overrides.winner ?? "A",
      overrides.seed ?? "42",
      overrides.replayHash ?? replayHash,
      overrides.snapshotVersion ?? 3,
      overrides.snapshotDigest ?? snapshotDigest,
    ),
  ).toString("hex");
}

describe("buildResultHash", () => {
  test("matches the canonical v2 binary vector and normalizes hex case", () => {
    expect(result()).toBe(
      "2805eeca8851289e8cedf8917b0158c917a03d0759d8669b41a86aa6beba40d6",
    );
    expect(
      result({
        duelKey: `0x${duelKey.toUpperCase()}`,
        replayHash: replayHash.toUpperCase(),
        snapshotDigest: snapshotDigest.toUpperCase(),
      }),
    ).toBe(result());
  });

  test("changes for every outcome commitment field", () => {
    const canonical = result();
    expect(result({ duelKey: "aa".repeat(32) })).not.toBe(canonical);
    expect(result({ winner: "B" })).not.toBe(canonical);
    expect(result({ seed: "43" })).not.toBe(canonical);
    expect(result({ replayHash: "cc".repeat(32) })).not.toBe(canonical);
    expect(result({ snapshotVersion: 2 })).not.toBe(canonical);
    expect(result({ snapshotDigest: "ee".repeat(32) })).not.toBe(canonical);
  });

  test("rejects non-canonical and out-of-range inputs", () => {
    expect(() => result({ duelKey: "ab" })).toThrow("32-byte hex");
    expect(() => result({ replayHash: ` ${replayHash}` })).toThrow(
      "whitespace",
    );
    expect(() => result({ replayHash: "00".repeat(32) })).toThrow("all zero");
    expect(() => result({ snapshotDigest: "zz".repeat(32) })).toThrow(
      "32-byte hex",
    );
    expect(() => result({ snapshotDigest: "00".repeat(32) })).toThrow(
      "all zero",
    );
    expect(() => result({ seed: "042" })).toThrow("canonical unsigned");
    expect(() => result({ seed: (1n << 64n).toString() })).toThrow(
      "64-bit range",
    );
    expect(() => result({ snapshotVersion: 0 })).toThrow(
      "positive unsigned 32-bit",
    );
    expect(() => result({ snapshotVersion: 0x1_0000_0000 })).toThrow(
      "positive unsigned 32-bit",
    );
    expect(() =>
      buildResultHash(
        duelKey,
        "invalid" as "A",
        "42",
        replayHash,
        3,
        snapshotDigest,
      ),
    ).toThrow("winner side");
  });
});
