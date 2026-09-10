import { describe, expect, test } from "bun:test";

import { exactBytes32, exactBytes32Hex } from "./exactBytes32";

describe("exact finalized SOL bytes32 decoding", () => {
  test("accepts exact byte arrays without changing their identity", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index * 8);
    const expectedHex = Buffer.from(bytes).toString("hex");
    for (const input of [bytes, Buffer.from(bytes), Array.from(bytes)]) {
      expect(exactBytes32(input)).toEqual(bytes);
      expect(exactBytes32Hex(input)).toBe(expectedHex);
    }
  });

  test("rejects coercible, fractional, out-of-range, malformed, and hostile arrays", () => {
    const canonical = Array.from({ length: 32 }, (_, index) => index);
    const mutations: unknown[] = [
      canonical.slice(0, 31),
      [...canonical, 32],
      canonical.map((value, index) => (index === 0 ? "0" : value)),
      canonical.map((value, index) => (index === 0 ? null : value)),
      canonical.map((value, index) => (index === 0 ? true : value)),
      canonical.map((value, index) => (index === 0 ? 1.5 : value)),
      canonical.map((value, index) => (index === 0 ? Number.NaN : value)),
      canonical.map((value, index) => (index === 0 ? -1 : value)),
      canonical.map((value, index) => (index === 0 ? 256 : value)),
      "00".repeat(32),
      null,
      {},
      new Proxy(canonical, {
        get(target, property, receiver) {
          if (property === "length") throw new Error("hostile array");
          return Reflect.get(target, property, receiver);
        },
      }),
    ];
    for (const mutation of mutations) {
      expect(exactBytes32(mutation)).toBeNull();
      expect(exactBytes32Hex(mutation)).toBeNull();
    }
  });
});
