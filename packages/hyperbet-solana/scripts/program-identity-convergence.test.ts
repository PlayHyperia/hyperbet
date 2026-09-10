import { describe, expect, test } from "bun:test";

import { evaluateProgramIdentityConvergence } from "./program-identity-convergence";

const expected = {
  fightOracleProgramId: "11111111111111111111111111111112",
  duelMarketProgramId: "11111111111111111111111111111113",
} as const;

describe("program identity convergence", () => {
  test("accepts matching independent program identities", () => {
    expect(
      evaluateProgramIdentityConvergence({
        expected,
        observations: [
          {
            label: "durable fight oracle keypair",
            program: "fightOracleProgramId",
            address: expected.fightOracleProgramId,
          },
          {
            label: "duel market IDL",
            program: "duelMarketProgramId",
            address: expected.duelMarketProgramId,
          },
        ],
      }),
    ).toEqual([]);
  });

  test("rejects missing and mismatched observations", () => {
    expect(
      evaluateProgramIdentityConvergence({
        expected,
        observations: [
          {
            label: "fight oracle IDL",
            program: "fightOracleProgramId",
            address: null,
          },
          {
            label: "duel market keypair",
            program: "duelMarketProgramId",
            address: expected.fightOracleProgramId,
          },
        ],
      }),
    ).toEqual([
      `fight oracle IDL: expected ${expected.fightOracleProgramId}; found missing`,
      `duel market keypair: expected ${expected.duelMarketProgramId}; found ${expected.fightOracleProgramId}`,
    ]);
  });

  test("rejects invalid, default, and reused expected identities", () => {
    expect(
      evaluateProgramIdentityConvergence({
        expected: {
          fightOracleProgramId: "not-a-public-key",
          duelMarketProgramId: "not-a-public-key",
        },
        observations: [],
      }),
    ).toEqual([
      "fightOracleProgramId: expected identity is not a valid public key",
      "duelMarketProgramId: expected identity is not a valid public key",
      "fight oracle and duel market identities must differ",
    ]);

    expect(
      evaluateProgramIdentityConvergence({
        expected: {
          fightOracleProgramId: "11111111111111111111111111111111",
          duelMarketProgramId: expected.duelMarketProgramId,
        },
        observations: [],
      }),
    ).toContain(
      "fightOracleProgramId: expected identity is the default public key",
    );
  });
});
