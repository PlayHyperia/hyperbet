import { describe, expect, test } from "bun:test";

import { evaluateSolanaProgramDispatchReadiness } from "./solana-program-readiness";

const PROGRAM_ID = "11111111111111111111111111111112";

describe("Solana program dispatch readiness", () => {
  test("rejects an invoked program when the initializer simulation fails", () => {
    expect(
      evaluateSolanaProgramDispatchReadiness({
        programId: PROGRAM_ID,
        simulation: {
          error: { InstructionError: [0, { Custom: 101 }] },
          logs: [
            `Program ${PROGRAM_ID} invoke [1]`,
            "Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound.",
            `Program ${PROGRAM_ID} failed: custom program error: 0x65`,
          ],
        },
      }),
    ).toEqual({
      programId: PROGRAM_ID,
      ready: false,
      invocationObserved: true,
      unsupportedProgramObserved: false,
      simulationReturnedError: true,
      reason: "initializer simulation returned an instruction error",
    });
  });

  test("accepts only a successful target-program invocation", () => {
    expect(
      evaluateSolanaProgramDispatchReadiness({
        programId: PROGRAM_ID,
        simulation: {
          error: null,
          logs: [
            `Program ${PROGRAM_ID} invoke [1]`,
            `Program ${PROGRAM_ID} success`,
          ],
        },
      }).ready,
    ).toBe(true);
  });

  test("rejects unsupported-program responses even if an invocation-like log exists", () => {
    expect(
      evaluateSolanaProgramDispatchReadiness({
        programId: PROGRAM_ID,
        simulation: {
          error: { InstructionError: [0, "UnsupportedProgramId"] },
          logs: [
            `Program ${PROGRAM_ID} invoke [1]`,
            `Program ${PROGRAM_ID} failed: Unsupported program id`,
          ],
        },
      }),
    ).toMatchObject({
      ready: false,
      invocationObserved: true,
      unsupportedProgramObserved: true,
      reason: "validator reported an unsupported program ID",
    });
  });

  test("rejects missing and wrong-program invocation evidence", () => {
    expect(
      evaluateSolanaProgramDispatchReadiness({
        programId: PROGRAM_ID,
        simulation: { error: null, logs: null },
      }),
    ).toMatchObject({
      ready: false,
      invocationObserved: false,
      reason: "simulation returned no program logs",
    });

    expect(
      evaluateSolanaProgramDispatchReadiness({
        programId: PROGRAM_ID,
        simulation: {
          error: null,
          logs: ["Program 11111111111111111111111111111113 invoke [1]"],
        },
      }),
    ).toMatchObject({
      ready: false,
      invocationObserved: false,
      reason: "simulation did not invoke the target program",
    });
  });
});
