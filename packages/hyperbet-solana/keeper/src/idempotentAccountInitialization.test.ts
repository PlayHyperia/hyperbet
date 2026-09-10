import { describe, expect, test } from "bun:test";

import { ensureIdempotentAccountInitialized } from "./idempotentAccountInitialization";

describe("idempotent deterministic account initialization", () => {
  test("does not submit when the account already exists", async () => {
    let submissions = 0;
    await ensureIdempotentAccountInitialized({
      isInitialized: async () => true,
      submit: async () => {
        submissions += 1;
      },
    });
    expect(submissions).toBe(0);
  });

  test("treats on-chain state as success after a late-confirmed error", async () => {
    let initialized = false;
    await ensureIdempotentAccountInitialized({
      isInitialized: async () => initialized,
      submit: async () => {
        initialized = true;
        throw new Error("confirmation timed out");
      },
    });
    expect(initialized).toBe(true);
  });

  test("retries a missing account once and exposes the exact retry context", async () => {
    let initialized = false;
    let submissions = 0;
    const sleeps: number[] = [];
    const retries: number[] = [];
    await ensureIdempotentAccountInitialized({
      isInitialized: async () => initialized,
      submit: async () => {
        submissions += 1;
        if (submissions === 1) throw new Error("transient RPC failure");
        initialized = true;
      },
      retryDelayMs: 25,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
      onRetry: ({ attempt }) => retries.push(attempt),
    });
    expect({ submissions, sleeps, retries }).toEqual({
      submissions: 2,
      sleeps: [25],
      retries: [1],
    });
  });

  test("fails closed when successful submissions create no account", async () => {
    await expect(
      ensureIdempotentAccountInitialized({
        isInitialized: async () => false,
        submit: async () => undefined,
        maxAttempts: 1,
      }),
    ).rejects.toThrow("deterministic account is unavailable");
  });
});
