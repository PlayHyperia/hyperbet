import { createHash } from "node:crypto";

import { buildTestCompetitiveSnapshot } from "../../../keeper/src/testCompetitiveSnapshot";

export const E2E_INITIAL_CYCLE_ID = "e2e-cycle-active";

export const E2E_AGENT_A_IDENTITY = {
  id: "e2e-solana-agent-a",
  name: "Agent A",
  provider: "Hyperia",
  model: "alpha-local",
} as const;

export const E2E_AGENT_B_IDENTITY = {
  id: "e2e-solana-agent-b",
  name: "Agent B",
  provider: "OpenRouter",
  model: "beta-local",
} as const;

type SyntheticAgentIdentity = {
  id: string;
  name: string;
  provider?: string;
  model?: string;
};

type SyntheticCompetitiveSnapshot = ReturnType<
  typeof buildTestCompetitiveSnapshot
>["competitiveSnapshot"];

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Synthetic ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Mirror Hyperia's public streaming projection for local browser tests. The
 * private competitive snapshot remains the commitment source; only the exact
 * frozen loadout fields and the reasoning-free strategy summary reach the
 * bettor-facing agent object.
 */
export function buildSyntheticPublicAgent<T extends Record<string, unknown>>(
  agent: T,
  competitiveSnapshot: SyntheticCompetitiveSnapshot,
  side: "agent1" | "agent2",
): T & {
  loadoutFingerprint: string;
  availableCombatStyles: unknown[];
  combatLoadouts: Record<string, unknown>;
  loadoutFrozen: true;
  strategySummary: Record<string, unknown>;
} {
  const contestant = competitiveSnapshot.contestants.find(
    (candidate) => candidate.side === side,
  );
  if (!contestant) {
    throw new Error(`Synthetic competitive snapshot is missing ${side}`);
  }
  const expectedAgentId = contestant.agentId;
  if (expectedAgentId !== agent.id) {
    throw new Error(
      `Synthetic ${side} identity ${String(agent.id)} does not match ${String(expectedAgentId)}`,
    );
  }
  if (
    typeof contestant.loadoutFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(contestant.loadoutFingerprint) ||
    !Array.isArray(contestant.availableCombatStyles)
  ) {
    throw new Error(
      `Synthetic ${side} is missing a frozen competitive loadout`,
    );
  }
  const combatLoadouts = requireRecord(
    contestant.combatLoadouts,
    `${side} combat loadouts`,
  );
  const preparation = requireRecord(
    contestant.preparation,
    `${side} preparation`,
  );
  const tacticalStrategy = requireRecord(
    preparation.tacticalStrategy,
    `${side} tactical strategy`,
  );
  const strategySummary = {
    schemaVersion: 1,
    approach: tacticalStrategy.approach,
    tacticalMacro: tacticalStrategy.tacticalMacro,
    attackStyle: tacticalStrategy.attackStyle,
    prayer: tacticalStrategy.prayer,
    preferredCombatRole: tacticalStrategy.preferredCombatRole,
    foodThreshold: tacticalStrategy.foodThreshold,
    switchDefensiveAt: tacticalStrategy.switchDefensiveAt,
    source: preparation.planningSource,
    policyVersion: preparation.planningPolicyVersion,
  };

  return {
    ...agent,
    loadoutFingerprint: contestant.loadoutFingerprint,
    availableCombatStyles: [...contestant.availableCombatStyles],
    combatLoadouts: structuredClone(combatLoadouts),
    loadoutFrozen: true,
    strategySummary,
  };
}

export function syntheticParticipantHash(agentId: string): number[] {
  const normalized = agentId.trim();
  if (!normalized) {
    throw new Error("Synthetic duel participant id must not be empty");
  }
  return Array.from(createHash("sha256").update(normalized).digest());
}

export function buildSyntheticRendererHealth(nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("Synthetic renderer timestamp must be a positive integer");
  }
  return {
    ready: true,
    degradedReason: null,
    updatedAt: nowMs,
  } as const;
}

export function buildSyntheticDuelCommitment(input: {
  cycleId: string;
  duelId: string;
  duelKeyHex: string;
  betOpenTs: number;
  betCloseTs: number;
  duelStartTs: number;
  agent1?: SyntheticAgentIdentity;
  agent2?: SyntheticAgentIdentity;
}) {
  const agent1 = input.agent1 ?? E2E_AGENT_A_IDENTITY;
  const agent2 = input.agent2 ?? E2E_AGENT_B_IDENTITY;
  const countdownDurationMs = (input.duelStartTs - input.betCloseTs) * 1_000;
  if (
    !Number.isSafeInteger(input.duelStartTs) ||
    !Number.isSafeInteger(countdownDurationMs) ||
    countdownDurationMs <= 0
  ) {
    throw new Error(
      "Synthetic duel start must be an integer second after betting closes",
    );
  }
  const snapshot = buildTestCompetitiveSnapshot({
    cycleId: input.cycleId,
    duelId: input.duelId,
    duelKey: input.duelKeyHex,
    betOpenTime: input.betOpenTs * 1_000,
    betCloseTime: input.betCloseTs * 1_000,
    countdownDurationMs,
    agent1,
    agent2,
  });

  return {
    ...snapshot,
    competitiveSnapshotDigestBytes: Array.from(
      Buffer.from(snapshot.competitiveSnapshotDigest, "hex"),
    ),
    participantAHash: syntheticParticipantHash(agent1.id),
    participantBHash: syntheticParticipantHash(agent2.id),
  };
}
