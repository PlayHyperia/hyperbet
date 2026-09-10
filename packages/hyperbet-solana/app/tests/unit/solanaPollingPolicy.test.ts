import { describe, expect, test } from "bun:test";

import { resolveSolanaPollingPolicy } from "../../src/lib/solanaPollingPolicy";

describe("Solana browser polling policy", () => {
  test("keeps E2E market discovery and deployment checks bounded", () => {
    expect(
      resolveSolanaPollingPolicy({
        configuredRefreshIntervalMs: 1_500,
        programVerificationMaxAgeMs: 15_000,
      }),
    ).toEqual({
      programVerificationIntervalMs: 10_000,
      matchDiscoveryIntervalMs: 10_000,
    });
  });

  test("never lets deployment evidence expire between checks", () => {
    const policy = resolveSolanaPollingPolicy({
      configuredRefreshIntervalMs: 60_000,
      programVerificationMaxAgeMs: 8_000,
    });

    expect(policy.programVerificationIntervalMs).toBe(7_000);
    expect(policy.programVerificationIntervalMs).toBeLessThan(8_000);
    expect(policy.matchDiscoveryIntervalMs).toBe(60_000);
  });

  test("normalizes malformed configuration conservatively", () => {
    expect(
      resolveSolanaPollingPolicy({
        configuredRefreshIntervalMs: Number.NaN,
        programVerificationMaxAgeMs: Number.NaN,
      }),
    ).toEqual({
      programVerificationIntervalMs: 10_000,
      matchDiscoveryIntervalMs: 10_000,
    });
  });
});
