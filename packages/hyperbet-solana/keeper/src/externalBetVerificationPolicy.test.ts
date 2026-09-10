import { describe, expect, test } from "bun:test";

import {
  resolveExternalBetVerificationFailure,
  type ExternalBetVerificationFailureCode,
} from "./externalBetVerificationPolicy";

describe("external finalized-bet verification policy", () => {
  test("keeps every failure retryable while signature finality is pending", () => {
    expect(
      resolveExternalBetVerificationFailure({
        finality: "pending",
        code: "instruction-account-graph",
      }),
    ).toBe("retry");
  });

  test("retries bounded RPC and index visibility races after finality", () => {
    const retryable: ExternalBetVerificationFailureCode[] = [
      "transaction-not-found",
      "transaction-query-failed",
      "market-account-query-failed",
      "indexed-market-query-failed",
      "duel-id-query-failed",
    ];
    for (const code of retryable) {
      expect(
        resolveExternalBetVerificationFailure({
          finality: "finalized",
          code,
        }),
        code,
      ).toBe("retry");
    }
  });

  test("never retries finalized semantic identity or accounting failures", () => {
    const rejected: ExternalBetVerificationFailureCode[] = [
      "transaction-failed",
      "transaction-signature-mismatch",
      "wallet-signature-mismatch",
      "instruction-account-graph",
      "market-pda-identity",
      "indexed-order-identity",
      "duel-id-identity",
      "accounting-failed",
    ];
    for (const code of rejected) {
      expect(
        resolveExternalBetVerificationFailure({
          finality: "finalized",
          code,
        }),
        code,
      ).toBe("reject");
    }
  });
});
