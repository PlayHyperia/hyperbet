import { describe, expect, test } from "bun:test";

import { parsePublicPreparationSummary } from "./publicPreparation";

function summary(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    status: "preparing",
    selectedAt: 1_000,
    expiresAt: 61_000,
    agent1: {
      id: "agent-a",
      ready: false,
      activity: "crafting",
      mode: "working",
      activityTrail: ["planning", "gathering", "crafting"],
    },
    agent2: {
      id: "agent-b",
      ready: true,
      activity: "provisioning",
      mode: "traveling",
      activityTrail: ["training", "provisioning"],
    },
  };
}

describe("public preparation transport", () => {
  test("accepts and freezes the exact category-only schema", () => {
    const parsed = parsePublicPreparationSummary(summary());
    expect(parsed).not.toBeNull();
    expect(parsed?.agent1.activityTrail).toEqual([
      "planning",
      "gathering",
      "crafting",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.agent1)).toBe(true);
    expect(Object.isFrozen(parsed?.agent1.activityTrail)).toBe(true);
  });

  test("rejects private or unknown fields at every boundary", () => {
    expect(
      parsePublicPreparationSummary({ ...summary(), preparationId: "private" }),
    ).toBeNull();
    const contestantExtra = summary();
    contestantExtra.agent1 = {
      ...(contestantExtra.agent1 as Record<string, unknown>),
      itemId: "private_bank_item",
    };
    expect(parsePublicPreparationSummary(contestantExtra)).toBeNull();
  });

  test("rejects identity, timing, trail, mode, and readiness contradictions", () => {
    const duplicateIdentity = summary();
    duplicateIdentity.agent2 = {
      ...(duplicateIdentity.agent2 as Record<string, unknown>),
      id: "agent-a",
    };
    expect(parsePublicPreparationSummary(duplicateIdentity)).toBeNull();

    const expiredBeforeSelection = summary();
    expiredBeforeSelection.expiresAt = 1_000;
    expect(parsePublicPreparationSummary(expiredBeforeSelection)).toBeNull();

    const duplicateTrail = summary();
    duplicateTrail.agent1 = {
      ...(duplicateTrail.agent1 as Record<string, unknown>),
      activityTrail: ["planning", "planning"],
    };
    expect(parsePublicPreparationSummary(duplicateTrail)).toBeNull();

    const unsafeMode = summary();
    unsafeMode.agent1 = {
      ...(unsafeMode.agent1 as Record<string, unknown>),
      activity: "planning",
      mode: "traveling",
      activityTrail: ["planning"],
    };
    expect(parsePublicPreparationSummary(unsafeMode)).toBeNull();

    expect(
      parsePublicPreparationSummary({ ...summary(), status: "ready" }),
    ).toBeNull();
  });
});
