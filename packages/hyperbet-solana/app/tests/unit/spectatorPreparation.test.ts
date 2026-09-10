import { describe, expect, test } from "bun:test";

import {
  deriveSpectatorPreparation,
  hasAuthoritativeSpectatorPreparation,
  parseSpectatorPreparation,
} from "../../src/spectator/preparation";

function preparation(): Record<string, unknown> {
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

const identities = [
  { id: "agent-a", name: "Astra" },
  { id: "agent-b", name: "Bram" },
] as const;

describe("spectator preparation", () => {
  test("derives readable current activity and a bounded category recap", () => {
    const view = deriveSpectatorPreparation(preparation(), identities);
    expect(view?.agents[0]).toMatchObject({
      name: "Astra",
      ready: false,
      currentLabel: "Forging equipment",
      modeLabel: "Working",
    });
    expect(view?.agents[0].trail.map((entry) => entry.label)).toEqual([
      "Plan",
      "Gather",
      "Forge",
    ]);
    expect(view?.agents[1]).toMatchObject({
      name: "Bram",
      ready: true,
      currentLabel: "Loadout locked",
      modeLabel: "Ready",
    });
  });

  test("does not expose raw identities or private preparation fields", () => {
    const withPrivateField = { ...preparation(), goal: "private model output" };
    expect(parseSpectatorPreparation(withPrivateField)).toBeNull();
    const nestedPrivateField = preparation();
    nestedPrivateField.agent1 = {
      ...(nestedPrivateField.agent1 as Record<string, unknown>),
      bankItemId: "private_item",
    };
    expect(parseSpectatorPreparation(nestedPrivateField)).toBeNull();
    expect(
      JSON.stringify(deriveSpectatorPreparation(preparation(), identities)),
    ).not.toContain("agent-a");
  });

  test("rejects mismatched contestants and contradictory state", () => {
    expect(
      deriveSpectatorPreparation(preparation(), [
        { id: "other", name: "Astra" },
        identities[1],
      ]),
    ).toBeNull();

    const invalidReady = { ...preparation(), status: "ready" };
    expect(parseSpectatorPreparation(invalidReady)).toBeNull();

    const invalidTrail = preparation();
    invalidTrail.agent1 = {
      ...(invalidTrail.agent1 as Record<string, unknown>),
      activityTrail: ["planning", "planning"],
    };
    expect(parseSpectatorPreparation(invalidTrail)).toBeNull();
  });

  test("recognizes only a fresh IDLE preparation bound to visible agents", () => {
    const cycle = {
      phase: "IDLE",
      agent1: identities[0],
      agent2: identities[1],
    };
    expect(
      hasAuthoritativeSpectatorPreparation({
        preparation: preparation(),
        cycle,
        emittedAt: 30_000,
      }),
    ).toBe(true);
    expect(
      hasAuthoritativeSpectatorPreparation({
        preparation: preparation(),
        cycle: { ...cycle, phase: "FIGHTING" },
        emittedAt: 30_000,
      }),
    ).toBe(false);
    expect(
      hasAuthoritativeSpectatorPreparation({
        preparation: preparation(),
        cycle,
        emittedAt: 61_001,
      }),
    ).toBe(false);
  });
});
