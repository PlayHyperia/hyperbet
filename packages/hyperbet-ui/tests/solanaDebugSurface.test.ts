import { describe, expect, test } from "bun:test";

import { shouldExposeSolanaDebugSurface } from "../src/lib/solanaDebugSurface";

describe("Solana diagnostic surface", () => {
  test("stays absent from ordinary development and E2E previews", () => {
    expect(
      shouldExposeSolanaDebugSurface({ isE2eMode: false, search: "" }),
    ).toBe(false);
    expect(
      shouldExposeSolanaDebugSurface({ isE2eMode: true, search: "" }),
    ).toBe(false);
    expect(
      shouldExposeSolanaDebugSurface({
        isE2eMode: true,
        search: "?e2eSolanaDuelId=duel-1",
      }),
    ).toBe(false);
  });

  test("appears only after an explicit E2E debug request", () => {
    expect(
      shouldExposeSolanaDebugSurface({
        isE2eMode: true,
        search: "?debug=1",
      }),
    ).toBe(true);
    expect(
      shouldExposeSolanaDebugSurface({
        isE2eMode: false,
        search: "?debug=1",
      }),
    ).toBe(false);
  });
});
