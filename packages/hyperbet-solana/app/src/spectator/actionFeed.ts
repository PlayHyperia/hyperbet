export type SpectatorActionFeedTone =
  "impact" | "movement" | "recovery" | "strategy";

export interface SpectatorActionFeedEntry {
  id: string;
  sequence: number;
  observedAt: number;
  badge: "HIT" | "MOVE" | "RECOVER" | "ROLE" | "STYLE" | "FOCUS";
  tone: SpectatorActionFeedTone;
  text: string;
}

type ParsedObservation = {
  sequence: number;
  observedAt: number;
  cycleId: string;
  duelId: string;
  actorId: string;
  combatRole: "melee" | "ranged" | "mage";
  tacticalMacro:
    "pressure" | "hold_range" | "kite" | "orbit" | "defensive_reset" | "finish";
  action:
    | "movement"
    | "engagement"
    | "food"
    | "prayer"
    | "style"
    | "role_switch"
    | "damage";
  outcome: "accepted" | "committed" | "deferred" | "rejected" | "error";
  value: string;
  amount: number | null;
};

const COMBAT_ROLES = new Set(["melee", "ranged", "mage"]);
const TACTICAL_MACROS = new Set([
  "pressure",
  "hold_range",
  "kite",
  "orbit",
  "defensive_reset",
  "finish",
]);
const ACTIONS = new Set([
  "movement",
  "engagement",
  "food",
  "prayer",
  "style",
  "role_switch",
  "damage",
]);
const OUTCOMES = new Set([
  "accepted",
  "committed",
  "deferred",
  "rejected",
  "error",
]);
const PRAYERS = new Set([
  "superhuman_strength",
  "rock_skin",
  "hawk_eye",
  "mystic_lore",
]);
const STYLES = new Set([
  "accurate",
  "aggressive",
  "controlled",
  "defensive",
  "rapid",
]);
const EXACT_KEYS = [
  "action",
  "actorId",
  "amount",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "opponentId",
  "outcome",
  "phase",
  "schemaVersion",
  "sequence",
  "tacticalMacro",
  "tick",
  "value",
] as const;
const UNSAFE_BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/u;

const TACTIC_LABELS: Record<ParsedObservation["tacticalMacro"], string> = {
  pressure: "press the attack",
  hold_range: "hold range",
  kite: "kite",
  orbit: "circle for an opening",
  defensive_reset: "reset defensively",
  finish: "push for the finish",
};

function formatLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function hasExactKeys(candidate: Record<string, unknown>): boolean {
  const keys = Object.keys(candidate).sort();
  return (
    keys.length === EXACT_KEYS.length &&
    EXACT_KEYS.every((key, index) => keys[index] === key)
  );
}

function isSafePublicId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    UNSAFE_BIDI_CONTROL.test(value)
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return false;
    }
  }
  return true;
}

function hasValidActionSemantics(candidate: Record<string, unknown>): boolean {
  const amountIsNull = candidate.amount === null;
  const amountIsPositive =
    Number.isSafeInteger(candidate.amount) && Number(candidate.amount) > 0;
  switch (candidate.action) {
    case "movement":
      return (
        candidate.value === "reposition" &&
        amountIsNull &&
        (candidate.outcome === "accepted" ||
          candidate.outcome === "rejected" ||
          candidate.outcome === "error")
      );
    case "engagement":
      return (
        (candidate.value === "initial" || candidate.value === "keep_alive") &&
        amountIsNull &&
        (candidate.outcome === "accepted" ||
          candidate.outcome === "rejected" ||
          candidate.outcome === "error")
      );
    case "food":
      return (
        (candidate.outcome === "deferred" &&
          candidate.value === "disengage" &&
          amountIsNull) ||
        (candidate.outcome === "committed" &&
          candidate.value === "consume" &&
          amountIsPositive) ||
        ((candidate.outcome === "rejected" || candidate.outcome === "error") &&
          candidate.value === "consume" &&
          amountIsNull)
      );
    case "prayer":
      return (
        typeof candidate.value === "string" &&
        PRAYERS.has(candidate.value) &&
        amountIsNull &&
        (candidate.outcome === "committed" ||
          candidate.outcome === "rejected" ||
          candidate.outcome === "error")
      );
    case "style":
      return (
        typeof candidate.value === "string" &&
        STYLES.has(candidate.value) &&
        amountIsNull &&
        (candidate.outcome === "accepted" ||
          candidate.outcome === "rejected" ||
          candidate.outcome === "error")
      );
    case "role_switch":
      return (
        typeof candidate.value === "string" &&
        COMBAT_ROLES.has(candidate.value) &&
        amountIsNull &&
        (candidate.outcome === "committed" ||
          candidate.outcome === "rejected" ||
          candidate.outcome === "error" ||
          candidate.outcome === "deferred")
      );
    case "damage":
      return (
        candidate.outcome === "committed" &&
        candidate.value === "hit" &&
        amountIsPositive
      );
    default:
      return false;
  }
}

function parseObservation(value: unknown): ParsedObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !hasExactKeys(candidate) ||
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.sequence) ||
    Number(candidate.sequence) < 1 ||
    !Number.isSafeInteger(candidate.tick) ||
    Number(candidate.tick) < 0 ||
    !Number.isSafeInteger(candidate.observedAt) ||
    Number(candidate.observedAt) <= 0 ||
    !isSafePublicId(candidate.cycleId) ||
    !isSafePublicId(candidate.duelId) ||
    !isSafePublicId(candidate.actorId) ||
    !isSafePublicId(candidate.opponentId) ||
    candidate.actorId === candidate.opponentId ||
    candidate.phase !== "FIGHTING" ||
    typeof candidate.combatRole !== "string" ||
    !COMBAT_ROLES.has(candidate.combatRole) ||
    typeof candidate.tacticalMacro !== "string" ||
    !TACTICAL_MACROS.has(candidate.tacticalMacro) ||
    typeof candidate.action !== "string" ||
    !ACTIONS.has(candidate.action) ||
    typeof candidate.outcome !== "string" ||
    !OUTCOMES.has(candidate.outcome) ||
    typeof candidate.value !== "string" ||
    !(
      candidate.amount === null ||
      (Number.isSafeInteger(candidate.amount) && Number(candidate.amount) > 0)
    ) ||
    !hasValidActionSemantics(candidate)
  ) {
    return null;
  }

  return {
    sequence: Number(candidate.sequence),
    observedAt: Number(candidate.observedAt),
    cycleId: candidate.cycleId,
    duelId: candidate.duelId,
    actorId: candidate.actorId,
    combatRole: candidate.combatRole as ParsedObservation["combatRole"],
    tacticalMacro:
      candidate.tacticalMacro as ParsedObservation["tacticalMacro"],
    action: candidate.action as ParsedObservation["action"],
    outcome: candidate.outcome as ParsedObservation["outcome"],
    value: candidate.value,
    amount: candidate.amount === null ? null : Number(candidate.amount),
  };
}

function describeAction(
  observation: ParsedObservation,
  actorName: string,
): Omit<SpectatorActionFeedEntry, "id" | "sequence" | "observedAt"> | null {
  if (
    observation.action === "damage" &&
    observation.outcome === "committed" &&
    observation.value === "hit" &&
    observation.amount !== null
  ) {
    return {
      badge: "HIT",
      tone: "impact",
      text: `${actorName} lands ${observation.amount} damage.`,
    };
  }
  if (
    observation.action === "food" &&
    observation.outcome === "committed" &&
    observation.value === "consume" &&
    observation.amount !== null
  ) {
    return {
      badge: "RECOVER",
      tone: "recovery",
      text: `${actorName} recovers ${observation.amount} health with food.`,
    };
  }
  if (
    observation.action === "food" &&
    observation.outcome === "deferred" &&
    observation.value === "disengage"
  ) {
    return {
      badge: "MOVE",
      tone: "movement",
      text: `${actorName} creates space before recovering.`,
    };
  }
  if (
    observation.action === "role_switch" &&
    observation.outcome === "committed" &&
    COMBAT_ROLES.has(observation.value)
  ) {
    return {
      badge: "ROLE",
      tone: "strategy",
      text: `${actorName} switches to ${formatLabel(observation.value).toLowerCase()}.`,
    };
  }
  if (observation.action === "style" && observation.outcome === "accepted") {
    return {
      badge: "STYLE",
      tone: "strategy",
      text: `${actorName} adopts the ${formatLabel(observation.value).toLowerCase()} attack style.`,
    };
  }
  if (observation.action === "prayer" && observation.outcome === "committed") {
    return {
      badge: "FOCUS",
      tone: "strategy",
      text: `${actorName} activates ${formatLabel(observation.value)}.`,
    };
  }
  return null;
}

/**
 * Converts the strict public combat contract into a small, human-readable feed.
 * Unknown actors and unrecognized values are dropped so internal IDs or future
 * unreviewed server fields can never leak directly into the spectator UI.
 */
export function deriveSpectatorActionFeed(
  observations: unknown,
  context: {
    cycleId: string | null | undefined;
    duelId: string | null | undefined;
    agents: readonly { id: string; name: string }[];
  },
  limit = 12,
): SpectatorActionFeedEntry[] {
  if (
    !Array.isArray(observations) ||
    limit <= 0 ||
    !context.cycleId ||
    !context.duelId
  ) {
    return [];
  }
  const namesById = new Map(
    context.agents
      .filter((agent) => agent.id.length > 0 && agent.name.trim().length > 0)
      .map((agent) => [agent.id, agent.name.trim()]),
  );
  const seenSequences = new Set<number>();
  const parsed = observations
    .map(parseObservation)
    .filter((entry): entry is ParsedObservation => entry !== null)
    .filter(
      (entry) =>
        entry.cycleId === context.cycleId && entry.duelId === context.duelId,
    )
    .filter((entry) => {
      if (seenSequences.has(entry.sequence)) return false;
      seenSequences.add(entry.sequence);
      return true;
    })
    .sort((a, b) => a.sequence - b.sequence);
  const lastTacticByActor = new Map<
    string,
    ParsedObservation["tacticalMacro"]
  >();
  const entries: SpectatorActionFeedEntry[] = [];

  for (const observation of parsed) {
    const actorName = namesById.get(observation.actorId);
    if (!actorName) continue;
    const priorTactic = lastTacticByActor.get(observation.actorId);
    if (priorTactic !== observation.tacticalMacro) {
      lastTacticByActor.set(observation.actorId, observation.tacticalMacro);
      entries.push({
        id: `${observation.sequence}:tactic`,
        sequence: observation.sequence,
        observedAt: observation.observedAt,
        badge: "MOVE",
        tone: "movement",
        text: `${actorName} shifts to ${TACTIC_LABELS[observation.tacticalMacro]}.`,
      });
    }
    const action = describeAction(observation, actorName);
    if (action) {
      entries.push({
        id: `${observation.sequence}:action`,
        sequence: observation.sequence,
        observedAt: observation.observedAt,
        ...action,
      });
    }
  }

  return entries.slice(-Math.max(0, Math.floor(limit))).reverse();
}
