import { describe, expect, test } from "bun:test";

import {
  exactInnerInstructionGroups,
  exactTransactionInstructionSequence,
} from "./solanaInnerInstructions";

describe("finalized SOL inner-instruction grouping", () => {
  test("preserves every instruction position under one unique numeric index", () => {
    const first = { parsed: { type: "transfer" } };
    const second = { programId: "program" };
    const groups = exactInnerInstructionGroups([
      { index: 3, instructions: [first, null, second] },
      { index: 0, instructions: [] },
    ]);
    expect(groups?.size).toBe(2);
    expect(groups?.get(3)).toEqual([first, null, second]);
    expect(groups?.get(0)).toEqual([]);
    expect(exactInnerInstructionGroups(null)?.size).toBe(0);
  });

  test("rejects duplicate, malformed, coercible, and hostile groups", () => {
    const valid = { index: 1, instructions: [] };
    for (const malformed of [
      undefined,
      {},
      [valid, valid],
      [{ index: "1", instructions: [] }],
      [{ index: 1.5, instructions: [] }],
      [{ index: -1, instructions: [] }],
      [{ index: 1 }],
      [{ index: 1, instructions: {} }],
      [
        {
          get index() {
            throw new Error("hostile index");
          },
          instructions: [],
        },
      ],
      new Proxy([], {
        get: () => {
          throw new Error("hostile groups");
        },
      }),
    ]) {
      expect(exactInnerInstructionGroups(malformed)).toBeNull();
    }
  });

  test("interleaves each unique inner group after its owning instruction", () => {
    expect(
      exactTransactionInstructionSequence(
        ["top-0", "top-1"],
        [
          { index: 1, instructions: ["inner-1a", "inner-1b"] },
          { index: 0, instructions: ["inner-0"] },
        ],
      ),
    ).toEqual(["top-0", "inner-0", "top-1", "inner-1a", "inner-1b"]);
    expect(
      exactTransactionInstructionSequence(
        ["top-0"],
        [{ index: 1, instructions: [] }],
      ),
    ).toBeNull();
    expect(exactTransactionInstructionSequence(null, [])).toBeNull();
  });
});
