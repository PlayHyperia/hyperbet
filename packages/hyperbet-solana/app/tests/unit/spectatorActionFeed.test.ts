import { describe, expect, test } from "bun:test";

import { deriveSpectatorActionFeed } from "../../src/spectator/actionFeed";

function makeObservation(
  sequence: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    sequence,
    tick: sequence,
    observedAt: 1_700_000_000_000 + sequence,
    cycleId: "cycle-1",
    duelId: "duel-1",
    actorId: "astra",
    opponentId: "riven",
    phase: "FIGHTING",
    combatRole: "ranged",
    tacticalMacro: "kite",
    action: "engagement",
    outcome: "accepted",
    value: "initial",
    amount: null,
    ...overrides,
  };
}

const AGENTS = [
  { id: "astra", name: "Astra Vale" },
  { id: "riven", name: "Riven Ash" },
] as const;
const CONTEXT = { cycleId: "cycle-1", duelId: "duel-1", agents: AGENTS };

describe("spectator combat action feed", () => {
  test("turns authoritative combat decisions into a newest-first public feed", () => {
    const feed = deriveSpectatorActionFeed(
      [
        makeObservation(1),
        makeObservation(2, {
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: 7,
        }),
        makeObservation(3, {
          actorId: "riven",
          opponentId: "astra",
          combatRole: "melee",
          tacticalMacro: "pressure",
          action: "style",
          outcome: "accepted",
          value: "aggressive",
        }),
        makeObservation(4, {
          actorId: "riven",
          opponentId: "astra",
          combatRole: "ranged",
          tacticalMacro: "hold_range",
          action: "role_switch",
          outcome: "committed",
          value: "ranged",
        }),
      ],
      CONTEXT,
    );

    expect(feed.map((entry) => entry.badge)).toEqual([
      "ROLE",
      "MOVE",
      "STYLE",
      "MOVE",
      "HIT",
      "MOVE",
    ]);
    expect(feed[0]?.text).toBe("Riven Ash switches to ranged.");
    expect(feed[4]?.text).toBe("Astra Vale lands 7 damage.");
    expect(feed.every((entry) => !entry.text.includes("astra"))).toBe(true);
  });

  test("shows recovery and focus choices without exposing raw contract names", () => {
    const feed = deriveSpectatorActionFeed(
      [
        makeObservation(5, {
          action: "food",
          outcome: "committed",
          value: "consume",
          amount: 9,
        }),
        makeObservation(6, {
          action: "prayer",
          outcome: "committed",
          value: "hawk_eye",
        }),
      ],
      CONTEXT,
    );

    expect(feed[0]).toMatchObject({
      badge: "FOCUS",
      text: "Astra Vale activates Hawk Eye.",
    });
    expect(feed.some((entry) => entry.text.includes("recovers 9 health"))).toBe(
      true,
    );
    expect(JSON.stringify(feed)).not.toContain("hawk_eye");
  });

  test("drops malformed, duplicated, unknown-actor, and unreviewed observations", () => {
    const feed = deriveSpectatorActionFeed(
      [
        makeObservation(1, {
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: 4,
        }),
        makeObservation(1, {
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: 99,
        }),
        makeObservation(2, {
          actorId: "private-wallet-id",
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: 8,
        }),
        makeObservation(3, {
          action: "style",
          outcome: "accepted",
          value: "unreviewed_style",
        }),
        { ...makeObservation(4), privateReasoning: "do not display" },
      ],
      CONTEXT,
    );

    expect(feed.some((entry) => entry.text.includes("4 damage"))).toBe(true);
    expect(feed.some((entry) => entry.text.includes("99 damage"))).toBe(false);
    expect(JSON.stringify(feed)).not.toContain("private-wallet-id");
    expect(JSON.stringify(feed)).not.toContain("unreviewed_style");
    expect(JSON.stringify(feed)).not.toContain("privateReasoning");
  });

  test("bounds the feed after deriving tactic transitions", () => {
    const feed = deriveSpectatorActionFeed(
      [
        makeObservation(1, { tacticalMacro: "pressure" }),
        makeObservation(2, { tacticalMacro: "kite" }),
        makeObservation(3, { tacticalMacro: "finish" }),
      ],
      CONTEXT,
      2,
    );

    expect(feed).toHaveLength(2);
    expect(feed[0]?.text).toContain("push for the finish");
    expect(feed[1]?.text).toContain("kite");
  });

  test("never crosses the current cycle or duel identity boundary", () => {
    const feed = deriveSpectatorActionFeed(
      [
        makeObservation(1, {
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: 4,
        }),
        makeObservation(2, {
          cycleId: "prior-cycle",
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: 99,
        }),
        makeObservation(3, {
          duelId: "prior-duel",
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: 98,
        }),
      ],
      CONTEXT,
    );

    expect(feed.some((entry) => entry.text.includes("4 damage"))).toBe(true);
    expect(JSON.stringify(feed)).not.toContain("99 damage");
    expect(JSON.stringify(feed)).not.toContain("98 damage");
    expect(
      deriveSpectatorActionFeed([makeObservation(1)], {
        ...CONTEXT,
        cycleId: null,
      }),
    ).toEqual([]);
  });
});
