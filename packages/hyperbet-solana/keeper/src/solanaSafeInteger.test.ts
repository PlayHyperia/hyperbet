import { describe, expect, test } from "bun:test";

import { toSafeIntegerLike, toU64Like } from "./solanaSafeInteger";

describe("SOL finalized-evidence safe integers", () => {
  test("accepts exact safe integer representations", () => {
    for (const [input, expected] of [
      [0, 0],
      [Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [7n, 7],
      [-7n, -7],
      ["0", 0],
      ["700", 700],
      ["-700", -700],
      [{ toNumber: () => 42 }, 42],
    ] as const) {
      expect(toSafeIntegerLike(input)).toBe(expected);
    }
  });

  test("rejects lossy, noncanonical, fallback, and hostile values", () => {
    for (const input of [
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
      1n << 64n,
      -(1n << 64n),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      "",
      " 7",
      "07",
      "+7",
      "7.0",
      "7e0",
      "-0",
      null,
      undefined,
      {},
      { toNumber: () => "7" },
      { toNumber: () => Number.MAX_SAFE_INTEGER + 1 },
      {
        toNumber: () => {
          throw new Error("hostile conversion");
        },
      },
    ]) {
      expect(toSafeIntegerLike(input)).toBeNull();
    }
  });

  test("accepts the exact canonical u64 evidence domain", () => {
    const u64Max = (1n << 64n) - 1n;
    for (const [input, expected] of [
      [0, 0n],
      [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
      [0n, 0n],
      [u64Max, u64Max],
      ["0", 0n],
      [u64Max.toString(), u64Max],
      [{ toString: () => "42" }, 42n],
    ] as const) {
      expect(toU64Like(input)).toBe(expected);
    }
  });

  test("rejects out-of-domain, noncanonical, and hostile u64 evidence", () => {
    for (const input of [
      -1,
      -1n,
      1n << 64n,
      Number.MAX_SAFE_INTEGER + 1,
      -0,
      "-1",
      "00",
      "+1",
      "1.0",
      " 1",
      null,
      undefined,
      {},
      { toString: () => 1 },
      { toString: () => (1n << 64n).toString() },
      {
        toString: () => {
          throw new Error("hostile conversion");
        },
      },
    ]) {
      expect(toU64Like(input)).toBeNull();
    }
  });
});
