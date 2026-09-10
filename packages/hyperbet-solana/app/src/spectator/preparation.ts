export const SPECTATOR_PREPARATION_ACTIVITIES = [
  "planning",
  "gathering",
  "training",
  "crafting",
  "provisioning",
  "questing",
  "exploring",
  "reassessing",
] as const;

export type SpectatorPreparationActivity =
  (typeof SPECTATOR_PREPARATION_ACTIVITIES)[number];
type SpectatorPreparationMode = "working" | "traveling";

type ParsedContestant = Readonly<{
  id: string;
  ready: boolean;
  activity: SpectatorPreparationActivity | null;
  mode: SpectatorPreparationMode | null;
  activityTrail: readonly SpectatorPreparationActivity[];
}>;

export type ParsedSpectatorPreparation = Readonly<{
  schemaVersion: 2;
  status: "preparing" | "ready";
  selectedAt: number;
  expiresAt: number;
  agent1: ParsedContestant;
  agent2: ParsedContestant;
}>;

export type SpectatorPreparationAgent = Readonly<{
  name: string;
  ready: boolean;
  currentLabel: string;
  modeLabel: "Working" | "Traveling" | "Ready";
  trail: readonly Readonly<{
    activity: SpectatorPreparationActivity;
    label: string;
  }>[];
}>;

export type SpectatorPreparationView = Readonly<{
  status: "preparing" | "ready";
  selectedAt: number;
  expiresAt: number;
  agents: readonly [SpectatorPreparationAgent, SpectatorPreparationAgent];
}>;

const SUMMARY_KEYS = [
  "agent1",
  "agent2",
  "expiresAt",
  "schemaVersion",
  "selectedAt",
  "status",
] as const;
const CONTESTANT_KEYS = [
  "activity",
  "activityTrail",
  "id",
  "mode",
  "ready",
] as const;
const ACTIVITY_SET = new Set<string>(SPECTATOR_PREPARATION_ACTIVITIES);
const MODE_SET = new Set<string>(["working", "traveling"]);
const UNSAFE_BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/u;

const TRAIL_LABELS: Record<SpectatorPreparationActivity, string> = {
  planning: "Plan",
  gathering: "Gather",
  training: "Train",
  crafting: "Forge",
  provisioning: "Supplies",
  questing: "Quest",
  exploring: "Explore",
  reassessing: "Reassess",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafePublicText(value: unknown): value is string {
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

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    keys.every((key, index) => actual[index] === key)
  );
}

function parseTrail(
  value: unknown,
): readonly SpectatorPreparationActivity[] | null {
  if (
    !Array.isArray(value) ||
    value.length > SPECTATOR_PREPARATION_ACTIVITIES.length
  ) {
    return null;
  }
  const trail: SpectatorPreparationActivity[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !ACTIVITY_SET.has(entry) ||
      trail.at(-1) === entry
    ) {
      return null;
    }
    trail.push(entry as SpectatorPreparationActivity);
  }
  return Object.freeze(trail);
}

function parseContestant(value: unknown): ParsedContestant | null {
  if (!isRecord(value) || !hasExactKeys(value, CONTESTANT_KEYS)) return null;
  const trail = parseTrail(value.activityTrail);
  const activity = value.activity;
  const mode = value.mode;
  if (
    !isSafePublicText(value.id) ||
    value.id !== value.id.trim() ||
    typeof value.ready !== "boolean" ||
    (activity !== null &&
      (typeof activity !== "string" || !ACTIVITY_SET.has(activity))) ||
    (mode !== null && (typeof mode !== "string" || !MODE_SET.has(mode))) ||
    trail === null ||
    (activity === null) !== (trail.length === 0) ||
    (activity !== null && trail.at(-1) !== activity) ||
    (activity === null) !== (mode === null) ||
    ((activity === "planning" || activity === "reassessing") &&
      mode !== "working")
  ) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    ready: value.ready,
    activity: activity as SpectatorPreparationActivity | null,
    mode: mode as SpectatorPreparationMode | null,
    activityTrail: trail,
  });
}

export function parseSpectatorPreparation(
  value: unknown,
): ParsedSpectatorPreparation | null {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS)) return null;
  const agent1 = parseContestant(value.agent1);
  const agent2 = parseContestant(value.agent2);
  if (
    value.schemaVersion !== 2 ||
    (value.status !== "preparing" && value.status !== "ready") ||
    !Number.isSafeInteger(value.selectedAt) ||
    Number(value.selectedAt) < 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) <= Number(value.selectedAt) ||
    !agent1 ||
    !agent2 ||
    agent1.id === agent2.id ||
    (value.status === "ready") !== (agent1.ready && agent2.ready)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 2,
    status: value.status,
    selectedAt: Number(value.selectedAt),
    expiresAt: Number(value.expiresAt),
    agent1,
    agent2,
  });
}

function currentActivityLabel(
  activity: SpectatorPreparationActivity | null,
  mode: SpectatorPreparationMode | null,
  ready: boolean,
): string {
  if (ready) return "Loadout locked";
  if (activity === null || mode === null) return "Assessing the next move";
  if (mode === "traveling") {
    switch (activity) {
      case "gathering":
        return "Traveling to resources";
      case "training":
        return "Traveling to training";
      case "crafting":
        return "Traveling to a workshop";
      case "provisioning":
        return "Traveling for supplies";
      case "questing":
        return "Traveling on a quest";
      case "exploring":
        return "Scouting the preparation grounds";
      default:
        return "Traveling to the next objective";
    }
  }
  switch (activity) {
    case "planning":
      return "Planning a strategy";
    case "gathering":
      return "Gathering resources";
    case "training":
      return "Training combat skills";
    case "crafting":
      return "Forging equipment";
    case "provisioning":
      return "Stocking food and supplies";
    case "questing":
      return "Completing a useful quest";
    case "exploring":
      return "Scouting for an advantage";
    case "reassessing":
      return "Reassessing the plan";
  }
}

function deriveAgent(
  contestant: ParsedContestant,
  identity: { id: string; name: string },
): SpectatorPreparationAgent | null {
  if (
    contestant.id !== identity.id ||
    identity.name !== identity.name.trim() ||
    !isSafePublicText(identity.name)
  ) {
    return null;
  }
  return Object.freeze({
    name: identity.name,
    ready: contestant.ready,
    currentLabel: currentActivityLabel(
      contestant.activity,
      contestant.mode,
      contestant.ready,
    ),
    modeLabel: contestant.ready
      ? "Ready"
      : contestant.mode === "traveling"
        ? "Traveling"
        : "Working",
    trail: Object.freeze(
      contestant.activityTrail.map((activity) =>
        Object.freeze({ activity, label: TRAIL_LABELS[activity] }),
      ),
    ),
  });
}

export function deriveSpectatorPreparation(
  value: unknown,
  identities: readonly [
    { id: string; name: string },
    { id: string; name: string },
  ],
): SpectatorPreparationView | null {
  const parsed = parseSpectatorPreparation(value);
  if (!parsed) return null;
  const agent1 = deriveAgent(parsed.agent1, identities[0]);
  const agent2 = deriveAgent(parsed.agent2, identities[1]);
  if (!agent1 || !agent2) return null;
  return Object.freeze({
    status: parsed.status,
    selectedAt: parsed.selectedAt,
    expiresAt: parsed.expiresAt,
    agents: Object.freeze([agent1, agent2]) as readonly [
      SpectatorPreparationAgent,
      SpectatorPreparationAgent,
    ],
  });
}

export function hasAuthoritativeSpectatorPreparation(input: {
  preparation: unknown;
  cycle: unknown;
  emittedAt?: number;
}): boolean {
  if (!isRecord(input.cycle) || input.cycle.phase !== "IDLE") return false;
  const agent1 = isRecord(input.cycle.agent1) ? input.cycle.agent1 : null;
  const agent2 = isRecord(input.cycle.agent2) ? input.cycle.agent2 : null;
  if (
    !agent1 ||
    !agent2 ||
    typeof agent1.id !== "string" ||
    typeof agent1.name !== "string" ||
    typeof agent2.id !== "string" ||
    typeof agent2.name !== "string"
  ) {
    return false;
  }
  const view = deriveSpectatorPreparation(input.preparation, [
    { id: agent1.id, name: agent1.name },
    { id: agent2.id, name: agent2.name },
  ]);
  return Boolean(
    view &&
    (input.emittedAt === undefined ||
      (Number.isSafeInteger(input.emittedAt) &&
        Number(input.emittedAt) >= view.selectedAt &&
        Number(input.emittedAt) <= view.expiresAt)),
  );
}
