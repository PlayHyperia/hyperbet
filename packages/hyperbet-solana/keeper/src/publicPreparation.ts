export const PUBLIC_PREPARATION_ACTIVITIES = [
  "planning",
  "gathering",
  "training",
  "crafting",
  "provisioning",
  "questing",
  "exploring",
  "reassessing",
] as const;

export type PublicPreparationActivity =
  (typeof PUBLIC_PREPARATION_ACTIVITIES)[number];
export type PublicPreparationMode = "working" | "traveling";

export type PublicPreparationContestant = Readonly<{
  id: string;
  ready: boolean;
  activity: PublicPreparationActivity | null;
  mode: PublicPreparationMode | null;
  activityTrail: readonly PublicPreparationActivity[];
}>;

export type PublicPreparationSummary = Readonly<{
  schemaVersion: 2;
  status: "preparing" | "ready";
  selectedAt: number;
  expiresAt: number;
  agent1: PublicPreparationContestant;
  agent2: PublicPreparationContestant;
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
const ACTIVITY_SET = new Set<string>(PUBLIC_PREPARATION_ACTIVITIES);
const MODE_SET = new Set<string>(["working", "traveling"]);
const UNSAFE_BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function parseActivityTrail(
  value: unknown,
): readonly PublicPreparationActivity[] | null {
  if (
    !Array.isArray(value) ||
    value.length > PUBLIC_PREPARATION_ACTIVITIES.length
  ) {
    return null;
  }
  const trail: PublicPreparationActivity[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !ACTIVITY_SET.has(entry) ||
      trail.at(-1) === entry
    ) {
      return null;
    }
    trail.push(entry as PublicPreparationActivity);
  }
  return Object.freeze(trail);
}

function parseContestant(value: unknown): PublicPreparationContestant | null {
  if (!isRecord(value) || !hasExactKeys(value, CONTESTANT_KEYS)) return null;
  const activityTrail = parseActivityTrail(value.activityTrail);
  const activity = value.activity;
  const mode = value.mode;
  if (
    !isSafePublicId(value.id) ||
    value.id !== value.id.trim() ||
    typeof value.ready !== "boolean" ||
    (activity !== null &&
      (typeof activity !== "string" || !ACTIVITY_SET.has(activity))) ||
    (mode !== null && (typeof mode !== "string" || !MODE_SET.has(mode))) ||
    activityTrail === null ||
    (activity === null) !== (activityTrail.length === 0) ||
    (activity !== null && activityTrail.at(-1) !== activity) ||
    (activity === null) !== (mode === null) ||
    ((activity === "planning" || activity === "reassessing") &&
      mode !== "working")
  ) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    ready: value.ready,
    activity: activity as PublicPreparationActivity | null,
    mode: mode as PublicPreparationMode | null,
    activityTrail,
  });
}

/**
 * Enforces the exact privacy-safe Hyperia preparation schema before the keeper
 * persists or relays it. Unknown fields are dropped by rejecting the summary.
 */
export function parsePublicPreparationSummary(
  value: unknown,
): PublicPreparationSummary | null {
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
