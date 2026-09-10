import { describe, expect, test } from "bun:test";

import {
  formatCompetitiveDisclosureLabel,
  isCompetitiveDisclosureTradeReady,
  parseCompetitiveDisclosurePair,
} from "../../src/spectator/competitiveDisclosure";

const armorIds = {
  helmet: "iron_helmet",
  body: "iron_body",
  legs: "iron_legs",
  boots: null,
  gloves: null,
  cape: null,
  amulet: null,
  ring: null,
};

function agent(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    loadoutFrozen: true,
    loadoutFingerprint: id === "agent-a" ? "a".repeat(64) : "b".repeat(64),
    availableCombatStyles: ["melee", "ranged", "mage", "prayer"],
    combatLoadouts: {
      melee: {
        role: "melee",
        weaponId: "iron_sword",
        arrowsId: null,
        shieldId: "iron_shield",
        spellId: null,
        armorIds,
      },
      ranged: {
        role: "ranged",
        weaponId: "shortbow",
        arrowsId: "iron_arrow",
        shieldId: null,
        spellId: null,
        armorIds,
      },
      mage: {
        role: "mage",
        weaponId: "air_staff",
        arrowsId: null,
        shieldId: null,
        spellId: "air_strike",
        armorIds,
      },
    },
    strategySummary: {
      schemaVersion: 1,
      approach: "balanced",
      tacticalMacro: "orbit",
      attackStyle: "controlled",
      prayer: "rock_skin",
      preferredCombatRole: "ranged",
      foodThreshold: 40,
      switchDefensiveAt: 30,
      source: "model",
      policyVersion: "duel-preparation-role-v3",
    },
  };
}

function pair() {
  return {
    phase: "ANNOUNCEMENT",
    competitiveSnapshotVersion: 4,
    agent1: agent("agent-a", "Astra Vale"),
    agent2: agent("agent-b", "Riven Ash"),
  };
}

const DUEL_KEY = "a".repeat(64);
const SNAPSHOT_DIGEST = "c".repeat(64);

function authorityCycle() {
  return {
    ...pair(),
    cycleId: "cycle-a",
    duelId: "duel-a",
    duelKeyHex: DUEL_KEY,
    competitiveSnapshotDigest: SNAPSHOT_DIGEST,
  };
}

function tradeReadyInput() {
  const currentCycle = authorityCycle();
  const displayCycle = authorityCycle();
  return {
    shellCanPlaceBet: true,
    phase: displayCycle.phase,
    disclosure: parseCompetitiveDisclosurePair(displayCycle),
    currentCycle,
    displayCycle,
    marketAuthority: {
      duelId: currentCycle.duelId,
      duelKeyHex: currentCycle.duelKeyHex,
    },
    onChainCommitment: {
      duelKeyHex: currentCycle.duelKeyHex,
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: currentCycle.competitiveSnapshotDigest,
    },
  };
}

describe("spectator competitive disclosure", () => {
  test("accepts and freezes an exact two-agent schema-v4 disclosure", () => {
    const parsed = parseCompetitiveDisclosurePair(pair());
    expect(parsed?.agents[0]).toMatchObject({
      id: "agent-a",
      name: "Astra Vale",
      fingerprint: "a".repeat(64),
      strategy: {
        approach: "balanced",
        tacticalMacro: "orbit",
        preferredCombatRole: "ranged",
        foodThreshold: 40,
      },
    });
    expect(parsed?.agents[0].loadouts).toEqual([
      {
        role: "melee",
        weapon: "iron_sword",
        ammunition: null,
        shield: "iron_shield",
        spell: null,
        armorCount: 3,
      },
      {
        role: "ranged",
        weapon: "shortbow",
        ammunition: "iron_arrow",
        shield: null,
        spell: null,
        armorCount: 3,
      },
      {
        role: "mage",
        weapon: "air_staff",
        ammunition: null,
        shield: null,
        spell: "air_strike",
        armorCount: 3,
      },
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.agents[0].strategy)).toBe(true);
    expect(Object.isFrozen(parsed?.agents[0].loadouts)).toBe(true);
  });

  test("fails closed on missing, private, contradictory, or legacy data", () => {
    const cases: unknown[] = [];

    const privateStrategy = pair();
    (
      privateStrategy.agent1.strategySummary as Record<string, unknown>
    ).reasoning = "private model output";
    cases.push(privateStrategy);

    const badRole = pair();
    (
      (badRole.agent1.combatLoadouts as Record<string, unknown>)
        .ranged as Record<string, unknown>
    ).role = "melee";
    cases.push(badRole);

    const missingRole = pair();
    delete (missingRole.agent1.combatLoadouts as Record<string, unknown>).mage;
    cases.push(missingRole);

    const extraLoadout = pair();
    (extraLoadout.agent1.combatLoadouts as Record<string, unknown>).private =
      {};
    cases.push(extraLoadout);

    const badFingerprint = pair();
    badFingerprint.agent1.loadoutFingerprint = "not-a-digest";
    cases.push(badFingerprint);

    cases.push({ ...pair(), phase: "COUNTDOWN" });
    cases.push({ ...pair(), competitiveSnapshotVersion: 2 });
    cases.push({ ...pair(), competitiveSnapshotVersion: 3 });
    cases.push({ ...pair(), agent2: agent("agent-a", "Duplicate") });

    for (const candidate of cases) {
      expect(
        parseCompetitiveDisclosurePair(candidate as ReturnType<typeof pair>),
      ).toBeNull();
    }
  });

  test("requires the exact verified announcement disclosure for trading", () => {
    const ready = tradeReadyInput();
    expect(isCompetitiveDisclosureTradeReady(ready)).toBe(true);
    expect(
      isCompetitiveDisclosureTradeReady({
        ...ready,
        disclosure: null,
      }),
    ).toBe(false);
    expect(
      isCompetitiveDisclosureTradeReady({
        ...ready,
        phase: "COUNTDOWN",
      }),
    ).toBe(false);
    expect(
      isCompetitiveDisclosureTradeReady({
        ...ready,
        shellCanPlaceBet: false,
      }),
    ).toBe(false);
  });

  test("requires one exact current, displayed, market, and on-chain commitment", () => {
    const base = tradeReadyInput();
    const changedAgentId = agent("other-agent", "Astra Vale");
    const changedFingerprint = {
      ...base.displayCycle.agent1,
      loadoutFingerprint: "e".repeat(64),
    };
    const cases = [
      [
        "current cycle",
        {
          ...base,
          currentCycle: { ...base.currentCycle, cycleId: "cycle-b" },
        },
      ],
      [
        "display cycle",
        {
          ...base,
          displayCycle: { ...base.displayCycle, cycleId: "cycle-b" },
        },
      ],
      [
        "current duel",
        {
          ...base,
          currentCycle: { ...base.currentCycle, duelId: "duel-b" },
        },
      ],
      [
        "display duel",
        {
          ...base,
          displayCycle: { ...base.displayCycle, duelId: "duel-b" },
        },
      ],
      [
        "market duel",
        {
          ...base,
          marketAuthority: { ...base.marketAuthority, duelId: "duel-b" },
        },
      ],
      [
        "current duel key",
        {
          ...base,
          currentCycle: {
            ...base.currentCycle,
            duelKeyHex: "b".repeat(64),
          },
        },
      ],
      [
        "display duel key",
        {
          ...base,
          displayCycle: {
            ...base.displayCycle,
            duelKeyHex: "b".repeat(64),
          },
        },
      ],
      [
        "market duel key",
        {
          ...base,
          marketAuthority: {
            ...base.marketAuthority,
            duelKeyHex: "b".repeat(64),
          },
        },
      ],
      [
        "on-chain duel key",
        {
          ...base,
          onChainCommitment: {
            ...base.onChainCommitment,
            duelKeyHex: "b".repeat(64),
          },
        },
      ],
      [
        "current phase",
        {
          ...base,
          currentCycle: { ...base.currentCycle, phase: "COUNTDOWN" },
        },
      ],
      [
        "display phase",
        {
          ...base,
          displayCycle: { ...base.displayCycle, phase: "COUNTDOWN" },
        },
      ],
      [
        "current version",
        {
          ...base,
          currentCycle: {
            ...base.currentCycle,
            competitiveSnapshotVersion: 3,
          },
        },
      ],
      [
        "display version",
        {
          ...base,
          displayCycle: {
            ...base.displayCycle,
            competitiveSnapshotVersion: 3,
          },
        },
      ],
      [
        "on-chain version",
        {
          ...base,
          onChainCommitment: {
            ...base.onChainCommitment,
            competitiveSnapshotVersion: 3,
          },
        },
      ],
      [
        "current digest",
        {
          ...base,
          currentCycle: {
            ...base.currentCycle,
            competitiveSnapshotDigest: "d".repeat(64),
          },
        },
      ],
      [
        "display digest",
        {
          ...base,
          displayCycle: {
            ...base.displayCycle,
            competitiveSnapshotDigest: "d".repeat(64),
          },
        },
      ],
      [
        "on-chain digest",
        {
          ...base,
          onChainCommitment: {
            ...base.onChainCommitment,
            competitiveSnapshotDigest: "d".repeat(64),
          },
        },
      ],
      [
        "current contestant",
        {
          ...base,
          currentCycle: { ...base.currentCycle, agent1: changedAgentId },
        },
      ],
      [
        "display contestant",
        {
          ...base,
          displayCycle: { ...base.displayCycle, agent1: changedAgentId },
        },
      ],
      [
        "display loadout fingerprint",
        {
          ...base,
          displayCycle: {
            ...base.displayCycle,
            agent1: changedFingerprint,
          },
        },
      ],
      [
        "current loadout fingerprint",
        {
          ...base,
          currentCycle: {
            ...base.currentCycle,
            agent1: {
              ...base.currentCycle.agent1,
              loadoutFingerprint: "e".repeat(64),
            },
          },
        },
      ],
      [
        "missing digest",
        {
          ...base,
          displayCycle: {
            ...base.displayCycle,
            competitiveSnapshotDigest: null,
          },
        },
      ],
      [
        "missing on-chain commitment",
        {
          ...base,
          onChainCommitment: {
            ...base.onChainCommitment,
            competitiveSnapshotDigest: null,
          },
        },
      ],
    ] as const;

    for (const [label, candidate] of cases) {
      expect({
        label,
        ready: isCompetitiveDisclosureTradeReady(candidate),
      }).toEqual({ label, ready: false });
    }
  });

  test("compares canonical duel keys while keeping textual identities exact", () => {
    const ready = tradeReadyInput();
    expect(
      isCompetitiveDisclosureTradeReady({
        ...ready,
        currentCycle: {
          ...ready.currentCycle,
          duelKeyHex: `0x${DUEL_KEY.toUpperCase()}`,
        },
        displayCycle: {
          ...ready.displayCycle,
          duelKeyHex: DUEL_KEY.toUpperCase(),
        },
      }),
    ).toBe(true);
    expect(
      isCompetitiveDisclosureTradeReady({
        ...ready,
        currentCycle: { ...ready.currentCycle, duelId: " duel-a" },
      }),
    ).toBe(false);
  });

  test("never combines current market authority with a buffered disclosure from another duel", () => {
    const disclosure = parseCompetitiveDisclosurePair(pair());
    expect(
      isCompetitiveDisclosureTradeReady({
        shellCanPlaceBet: true,
        phase: "ANNOUNCEMENT",
        disclosure,
        currentCycle: {
          ...pair(),
          cycleId: "cycle-b",
          duelId: "duel-b",
          duelKeyHex: "b".repeat(64),
          competitiveSnapshotDigest: "d".repeat(64),
        },
        displayCycle: {
          ...pair(),
          cycleId: "cycle-a",
          duelId: "duel-a",
          duelKeyHex: "a".repeat(64),
          competitiveSnapshotDigest: "c".repeat(64),
        },
        marketAuthority: {
          duelId: "duel-b",
          duelKeyHex: "b".repeat(64),
        },
        onChainCommitment: {
          duelKeyHex: "b".repeat(64),
          competitiveSnapshotVersion: 4,
          competitiveSnapshotDigest: "d".repeat(64),
        },
      }),
    ).toBe(false);
  });

  test("formats allowlisted identifiers for bettor-facing copy", () => {
    expect(formatCompetitiveDisclosureLabel("defensive_reset")).toBe(
      "Defensive Reset",
    );
    expect(formatCompetitiveDisclosureLabel("iron-arrow")).toBe("Iron Arrow");
  });
});
