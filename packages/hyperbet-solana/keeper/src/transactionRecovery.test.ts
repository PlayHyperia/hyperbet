import { describe, expect, test } from "bun:test";
import {
  classifyRecoveredSignatureStatus,
  extractRecoverableTransactionSignature,
  waitForConfirmedTransactionSignature,
} from "./transactionRecovery";

const signature = "3".repeat(64);

describe("transaction signature recovery", () => {
  test("extracts only a canonical signature from an ambiguous error", () => {
    expect(
      extractRecoverableTransactionSignature(
        new Error(
          `Transaction was not confirmed; check signature ${signature} using an explorer`,
        ),
      ),
    ).toBe(signature);
    expect(
      extractRecoverableTransactionSignature(
        new Error("Transaction timed out without a transaction identifier"),
      ),
    ).toBeNull();
    expect(
      extractRecoverableTransactionSignature(
        new Error(`signature ${"0".repeat(64)}`),
      ),
    ).toBeNull();
  });

  test("classifies processed and absent status as pending", () => {
    expect(classifyRecoveredSignatureStatus(null)).toBe("pending");
    expect(
      classifyRecoveredSignatureStatus({
        err: null,
        confirmationStatus: "processed",
      }),
    ).toBe("pending");
  });

  test("accepts only confirmed or finalized successful status", () => {
    expect(
      classifyRecoveredSignatureStatus({
        err: null,
        confirmationStatus: "confirmed",
      }),
    ).toBe("confirmed");
    expect(
      classifyRecoveredSignatureStatus({
        err: null,
        confirmationStatus: "finalized",
      }),
    ).toBe("confirmed");
  });

  test("fails immediately on an on-chain transaction error", () => {
    expect(
      classifyRecoveredSignatureStatus({
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "confirmed",
      }),
    ).toBe("failed");
  });

  test("keeps polling through processed status until confirmed", async () => {
    let clock = 0;
    let reads = 0;
    const recovered = await waitForConfirmedTransactionSignature({
      timeoutMs: 5_000,
      pollIntervalMs: 2_000,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      getStatus: async () => {
        reads += 1;
        return {
          err: null,
          confirmationStatus: reads === 1 ? "processed" : "confirmed",
        };
      },
    });

    expect(recovered).toBe(true);
    expect(reads).toBe(2);
    expect(clock).toBe(2_000);
  });

  test("times out without accepting processed status", async () => {
    let clock = 0;
    let reads = 0;
    const recovered = await waitForConfirmedTransactionSignature({
      timeoutMs: 3_000,
      pollIntervalMs: 2_000,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      getStatus: async () => {
        reads += 1;
        return { err: null, confirmationStatus: "processed" };
      },
    });

    expect(recovered).toBe(false);
    expect(reads).toBe(3);
    expect(clock).toBe(3_000);
  });

  test("rejects invalid polling policy", async () => {
    await expect(
      waitForConfirmedTransactionSignature({
        timeoutMs: 0,
        getStatus: async () => null,
      }),
    ).rejects.toThrow("transaction recovery timeout must be positive");
    await expect(
      waitForConfirmedTransactionSignature({
        timeoutMs: 1,
        pollIntervalMs: 0,
        getStatus: async () => null,
      }),
    ).rejects.toThrow("transaction recovery poll interval must be positive");
  });
});
