import { createHash } from "node:crypto";

import type { CompetitiveSnapshot } from "./game-client";

function canonicalJson(value: unknown): string {
  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function contestant(input: {
  side: "agent1" | "agent2";
  id: string;
  name: string;
  provider: string;
  model: string;
  snapshotVersion: 1 | 2 | 3 | 4;
  diagnostic: boolean;
  loadoutFingerprint?: string | null;
}): Record<string, unknown> {
  const availableCombatStyles = ["melee"];
  const provider = input.diagnostic ? "diagnostic" : input.provider;
  const model = input.diagnostic ? "diagnostic" : input.model;
  return {
    side: input.side,
    agentId: input.id,
    name: input.name,
    provider,
    model,
    combatLevel: 42,
    startingHp: 30,
    maxHp: 30,
    wins: input.side === "agent1" ? 12 : 10,
    losses: input.side === "agent1" ? 4 : 6,
    rank: input.side === "agent1" ? 1 : 2,
    headToHeadWins: input.side === "agent1" ? 3 : 2,
    headToHeadLosses: input.side === "agent1" ? 2 : 3,
    loadoutFingerprint:
      input.loadoutFingerprint === undefined
        ? createHash("sha256")
            .update(
              `${input.diagnostic ? "diagnostic-" : ""}test-loadout:${input.id}`,
            )
            .digest("hex")
        : input.loadoutFingerprint,
    equipment: [{ slot: "weapon", itemId: "iron_sword", quantity: 1 }],
    inventory: [{ slot: 0, itemId: "shark", quantity: 3 }],
    selectedSpell: null,
    skillLevels: [
      { skill: "attack", level: 40 },
      { skill: "constitution", level: 30 },
      { skill: "defense", level: 40 },
      { skill: "strength", level: 40 },
    ],
    prayer: {
      pointUnits: 300,
      points: 30,
      maxPoints: 30,
      activePrayers: [],
    },
    initialCombatStyle: "melee",
    availableCombatStyles,
    combatLoadouts: {
      melee: {
        role: "melee",
        weaponId: "iron_sword",
        arrowsId: null,
        shieldId: null,
        spellId: null,
        ...(input.snapshotVersion >= 3
          ? {
              armorIds: {
                helmet: null,
                body: null,
                legs: null,
                boots: null,
                gloves: null,
                cape: null,
                amulet: null,
                ring: null,
              },
            }
          : {}),
      },
    },
    preparation: {
      primaryStyle: "melee",
      availableStyles: availableCombatStyles,
      planningSource: input.diagnostic ? "diagnostic" : "deterministic",
      planningPolicyVersion: input.diagnostic
        ? "diagnostic-v1"
        : "keeper-test-policy-v1",
      agentPolicyFingerprint: input.diagnostic
        ? null
        : createHash("sha256").update(`test-policy:${input.id}`).digest("hex"),
      modelProvider: provider,
      model,
      ...(input.snapshotVersion >= 2
        ? {
            tacticalStrategy: {
              approach: "balanced",
              tacticalMacro: "pressure",
              attackStyle: "aggressive",
              prayer: "superhuman_strength",
              preferredCombatRole: null,
              foodThreshold: 40,
              switchDefensiveAt: 30,
              reasoning: "Use the deterministic competitive test policy.",
            },
          }
        : {}),
    },
  };
}

export function buildTestCompetitiveSnapshot(input: {
  cycleId: string;
  duelId: string;
  duelKey: string;
  betOpenTime: number;
  betCloseTime: number;
  agent1?: { id: string; name: string; provider?: string; model?: string };
  agent2?: { id: string; name: string; provider?: string; model?: string };
  snapshotVersion?: 1 | 2 | 3 | 4;
  countdownDurationMs?: number;
  diagnostic?: boolean;
  loadoutFingerprint?: string | null;
}): {
  competitiveSnapshotVersion: 1 | 2 | 3 | 4;
  competitiveSnapshotDigest: string;
  competitiveSnapshot: CompetitiveSnapshot;
} {
  const agent1 = input.agent1 ?? { id: "agent-a", name: "Agent A" };
  const agent2 = input.agent2 ?? { id: "agent-b", name: "Agent B" };
  const snapshotVersion = input.snapshotVersion ?? 4;
  const diagnostic = input.diagnostic === true;
  const countdownDurationMs = input.countdownDurationMs ?? 10;
  if (!Number.isSafeInteger(countdownDurationMs) || countdownDurationMs <= 0) {
    throw new Error("test snapshot countdown must be a positive safe integer");
  }
  const competitiveSnapshot = {
    snapshotVersion,
    persisted: true,
    diagnostic,
    preparationId: deterministicUuid(`test-preparation:${input.cycleId}`),
    cycleId: input.cycleId,
    duelId: input.duelId,
    duelKey: input.duelKey,
    frozenAt: input.betOpenTime,
    betOpenTime: input.betOpenTime,
    betCloseTime: input.betCloseTime,
    combatPolicyVersion:
      snapshotVersion >= 3 ? "duel-combat-policy-v2" : "duel-combat-policy-v1",
    ...(snapshotVersion >= 4
      ? {
          timing: {
            contractVersion: 2 as const,
            timeoutPolicy: "hp_percentage_then_damage_then_draw_v1" as const,
            countdownDurationMs,
            fightingDurationMs: 30,
            endWarningDurationMs: 5,
            maxFightDurationMs: 35,
            fightStartTime: input.betCloseTime + countdownDurationMs,
            fightDeadline: input.betCloseTime + countdownDurationMs + 35,
          },
        }
      : {}),
    contestants: [
      contestant({
        side: "agent1",
        id: agent1.id,
        name: agent1.name,
        provider: agent1.provider ?? "provider-a",
        model: agent1.model ?? "model-a",
        snapshotVersion,
        diagnostic,
        loadoutFingerprint: input.loadoutFingerprint,
      }),
      contestant({
        side: "agent2",
        id: agent2.id,
        name: agent2.name,
        provider: agent2.provider ?? "provider-b",
        model: agent2.model ?? "model-b",
        snapshotVersion,
        diagnostic,
        loadoutFingerprint: input.loadoutFingerprint,
      }),
    ],
  } as CompetitiveSnapshot;
  return {
    competitiveSnapshotVersion: snapshotVersion,
    competitiveSnapshotDigest: createHash("sha256")
      .update(canonicalJson(competitiveSnapshot))
      .digest("hex"),
    competitiveSnapshot,
  };
}
