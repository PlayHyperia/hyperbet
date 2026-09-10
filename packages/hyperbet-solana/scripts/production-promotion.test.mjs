import { describe, expect, test } from "bun:test";

import {
  evaluateSolProductionPromotion,
  SOL_PRODUCTION_CONFIRMATION,
} from "./production-promotion.mjs";

const releaseSha = "a".repeat(40);

describe("SOL production promotion policy", () => {
  test.each(["preview", "staging"])(
    "allows %s without production credentials",
    (environment) => {
      const result = evaluateSolProductionPromotion({
        environment,
        confirmation: "",
        expectedCommitSha: "",
        ref: "refs/heads/feature",
        actualCommitSha: "",
      });
      expect(result.ok).toBe(true);
      expect(result.production).toBe(false);
    },
  );

  test("allows an exact, main-branch production promotion", () => {
    const result = evaluateSolProductionPromotion({
      environment: "production",
      confirmation: SOL_PRODUCTION_CONFIRMATION,
      expectedCommitSha: releaseSha,
      ref: "refs/heads/main",
      actualCommitSha: releaseSha,
    });
    expect(result.ok).toBe(true);
    expect(result.commitSha).toBe(releaseSha);
  });

  test("rejects an unsupported environment before promotion", () => {
    const result = evaluateSolProductionPromotion({
      environment: "mainnet",
      confirmation: "",
      expectedCommitSha: "",
      ref: "refs/heads/main",
      actualCommitSha: releaseSha,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects confirmation, branch, and SHA drift independently", () => {
    const result = evaluateSolProductionPromotion({
      environment: "production",
      confirmation: "yes",
      expectedCommitSha: "A".repeat(40),
      ref: "refs/heads/release",
      actualCommitSha: "b".repeat(40),
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.filter((check) => !check.ok).map((check) => check.message),
    ).toEqual([
      `production confirmation is exactly ${SOL_PRODUCTION_CONFIRMATION}`,
      "production source ref is refs/heads/main",
      "requested production commit is a full lowercase SHA",
      "requested production commit matches the checked-out commit",
    ]);
  });

  test("rejects a well-formed but different requested SHA", () => {
    const result = evaluateSolProductionPromotion({
      environment: "production",
      confirmation: SOL_PRODUCTION_CONFIRMATION,
      expectedCommitSha: releaseSha,
      ref: "refs/heads/main",
      actualCommitSha: "b".repeat(40),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)?.ok).toBe(false);
  });
});
