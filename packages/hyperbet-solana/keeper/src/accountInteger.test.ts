import { describe, expect, test } from "bun:test";

import {
  accountU64,
  requireAccountU64,
  requireSafeAccountInteger,
  safeAccountInteger,
} from "./accountInteger";

describe("Solana account integer decoding", () => {
  test("accepts the complete JavaScript safe-integer boundary exactly", () => {
    for (const value of [
      Number.MIN_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER + 1,
      -1,
      0,
      1,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(safeAccountInteger(value)).toBe(value);
      expect(safeAccountInteger(BigInt(value))).toBe(value);
      expect(safeAccountInteger({ toString: () => String(value) })).toBe(value);
    }
  });

  test("rejects every lossy, fractional, non-finite, or noncanonical value", () => {
    for (const value of [
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      BigInt(Number.MIN_SAFE_INTEGER) - 1n,
      "1",
      null,
      undefined,
      {},
      { toString: () => "01" },
      { toString: () => "-0" },
      { toString: () => "+1" },
      { toString: () => "1.0" },
      { toString: () => "1e3" },
      { toString: () => " 1" },
      { toString: () => 1 as never },
      {
        toString: () => {
          throw new Error("untrusted decoder");
        },
      },
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("untrusted property access");
          },
        },
      ),
    ]) {
      expect(safeAccountInteger(value)).toBeNull();
    }
  });

  test("enforces custody-specific inclusive bounds", () => {
    expect(requireSafeAccountInteger(1n, "order id", { min: 1 })).toBe(1);
    expect(
      requireSafeAccountInteger({ toString: () => "999" }, "price", {
        min: 1,
        max: 999,
      }),
    ).toBe(999);
    expect(() => requireSafeAccountInteger(0, "order id", { min: 1 })).toThrow(
      "below 1",
    );
    expect(() =>
      requireSafeAccountInteger(1_000, "price", { max: 999 }),
    ).toThrow("exceeds 999");
    expect(() =>
      requireSafeAccountInteger(
        BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        "lamports",
      ),
    ).toThrow("not a safe integer");
    expect(() =>
      requireSafeAccountInteger(1, "price", { min: 2, max: 1 }),
    ).toThrow("invalid safe-integer bounds");
    expect(() =>
      requireSafeAccountInteger(1, "price", { max: Number.POSITIVE_INFINITY }),
    ).toThrow("invalid safe-integer bounds");
  });

  test("decodes the complete unsigned 64-bit custody boundary without loss", () => {
    const maxU64 = (1n << 64n) - 1n;
    for (const value of [0n, 1n, BigInt(Number.MAX_SAFE_INTEGER), maxU64]) {
      expect(accountU64(value)).toBe(value);
      expect(accountU64({ toString: () => value.toString() })).toBe(value);
    }
    expect(accountU64(Number.MAX_SAFE_INTEGER)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );

    let generated = 0x9e37_79b9_7f4a_7c15n;
    for (let index = 0; index < 10_000; index += 1) {
      generated =
        (generated * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) &
        maxU64;
      expect(accountU64(generated)).toBe(generated);
      expect(accountU64({ toString: () => generated.toString() })).toBe(
        generated,
      );
    }
  });

  test("rejects lossy, signed, overflowing, or noncanonical u64 values", () => {
    const maxU64 = (1n << 64n) - 1n;
    for (const value of [
      -1,
      -1n,
      Number.MAX_SAFE_INTEGER + 1,
      maxU64 + 1n,
      "1",
      { toString: () => "01" },
      { toString: () => "-0" },
      { toString: () => "18446744073709551616" },
    ]) {
      expect(accountU64(value)).toBeNull();
    }
    expect(requireAccountU64(maxU64, "escrow lamports")).toBe(maxU64);
    expect(() => requireAccountU64(-1n, "escrow lamports")).toThrow(
      "escrow lamports is not a canonical u64",
    );
  });
});
