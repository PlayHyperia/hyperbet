export function exactInnerInstructionGroups(
  value: unknown,
): Map<number, unknown[]> | null {
  try {
    if (value === null) return new Map();
    if (!Array.isArray(value)) return null;
    const groups = new Map<number, unknown[]>();
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) return null;
      const index = (entry as { index?: unknown }).index;
      const instructions = (entry as { instructions?: unknown }).instructions;
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        !Array.isArray(instructions) ||
        groups.has(index as number)
      ) {
        return null;
      }
      groups.set(index as number, [...instructions]);
    }
    return groups;
  } catch {
    return null;
  }
}

export function exactTransactionInstructionSequence(
  topLevelInstructions: unknown,
  innerInstructionGroups: unknown,
): unknown[] | null {
  try {
    if (!Array.isArray(topLevelInstructions)) return null;
    const groups = exactInnerInstructionGroups(innerInstructionGroups);
    if (!groups) return null;
    if (
      [...groups.keys()].some((index) => index >= topLevelInstructions.length)
    ) {
      return null;
    }
    const sequence: unknown[] = [];
    for (const [index, instruction] of topLevelInstructions.entries()) {
      sequence.push(instruction, ...(groups.get(index) ?? []));
    }
    return sequence;
  } catch {
    return null;
  }
}
