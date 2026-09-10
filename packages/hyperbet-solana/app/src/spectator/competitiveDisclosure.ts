export const COMPETITIVE_DISCLOSURE_SNAPSHOT_VERSION = 4 as const;

const COMBAT_ROLES = ["melee", "ranged", "mage"] as const;
const ARMOR_SLOTS = [
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
  "amulet",
  "ring",
] as const;
const STRATEGY_APPROACHES = new Set([
  "aggressive",
  "defensive",
  "balanced",
  "outlast",
]);
const TACTICAL_MACROS = new Set([
  "pressure",
  "hold_range",
  "kite",
  "orbit",
  "defensive_reset",
  "finish",
]);
const ATTACK_STYLES = new Set([
  "accurate",
  "aggressive",
  "controlled",
  "defensive",
]);
const PRAYERS = new Set([
  "superhuman_strength",
  "rock_skin",
  "hawk_eye",
  "mystic_lore",
]);
const STRATEGY_SOURCES = new Set(["model", "deterministic", "diagnostic"]);
const SAFE_POLICY_VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UNSAFE_BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/u;

export type CompetitiveDisclosureRole = (typeof COMBAT_ROLES)[number];

export type CompetitiveDisclosureStrategy = Readonly<{
  approach: string;
  tacticalMacro: string;
  attackStyle: string;
  prayer: string | null;
  preferredCombatRole: CompetitiveDisclosureRole | null;
  foodThreshold: number;
  switchDefensiveAt: number;
  source: "model" | "deterministic" | "diagnostic";
  policyVersion: string;
}>;

export type CompetitiveDisclosureLoadout = Readonly<{
  role: CompetitiveDisclosureRole;
  weapon: string;
  ammunition: string | null;
  shield: string | null;
  spell: string | null;
  armorCount: number;
}>;

export type CompetitiveAgentDisclosure = Readonly<{
  id: string;
  name: string;
  fingerprint: string;
  strategy: CompetitiveDisclosureStrategy;
  loadouts: readonly CompetitiveDisclosureLoadout[];
}>;

export type CompetitiveDisclosurePair = Readonly<{
  snapshotVersion: typeof COMPETITIVE_DISCLOSURE_SNAPSHOT_VERSION;
  agents: readonly [CompetitiveAgentDisclosure, CompetitiveAgentDisclosure];
}>;

export type CompetitiveDisclosureCycleAuthority = Readonly<{
  cycleId?: unknown;
  phase?: unknown;
  duelId?: unknown;
  duelKeyHex?: unknown;
  competitiveSnapshotVersion?: unknown;
  competitiveSnapshotDigest?: unknown;
  agent1?: unknown;
  agent2?: unknown;
}>;

export type CompetitiveDisclosureMarketAuthority = Readonly<{
  duelId?: unknown;
  duelKeyHex?: unknown;
}>;

export type CompetitiveDisclosureOnChainCommitment = Readonly<{
  duelKeyHex?: unknown;
  competitiveSnapshotVersion?: unknown;
  competitiveSnapshotDigest?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function isSafeText(value: unknown, maxLength = 256): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
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

function isNullableSafeText(value: unknown, maxLength = 128): boolean {
  return value === null || isSafeText(value, maxLength);
}

function parseStrategy(
  value: unknown,
  availableRoles: readonly CompetitiveDisclosureRole[],
): CompetitiveDisclosureStrategy | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "approach",
      "tacticalMacro",
      "attackStyle",
      "prayer",
      "preferredCombatRole",
      "foodThreshold",
      "switchDefensiveAt",
      "source",
      "policyVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.approach !== "string" ||
    !STRATEGY_APPROACHES.has(value.approach) ||
    typeof value.tacticalMacro !== "string" ||
    !TACTICAL_MACROS.has(value.tacticalMacro) ||
    typeof value.attackStyle !== "string" ||
    !ATTACK_STYLES.has(value.attackStyle) ||
    !(
      value.prayer === null ||
      (typeof value.prayer === "string" && PRAYERS.has(value.prayer))
    ) ||
    !(
      value.preferredCombatRole === null ||
      (typeof value.preferredCombatRole === "string" &&
        availableRoles.includes(
          value.preferredCombatRole as CompetitiveDisclosureRole,
        ))
    ) ||
    !Number.isSafeInteger(value.foodThreshold) ||
    Number(value.foodThreshold) < 20 ||
    Number(value.foodThreshold) > 60 ||
    !Number.isSafeInteger(value.switchDefensiveAt) ||
    Number(value.switchDefensiveAt) < 20 ||
    Number(value.switchDefensiveAt) > 40 ||
    typeof value.source !== "string" ||
    !STRATEGY_SOURCES.has(value.source) ||
    typeof value.policyVersion !== "string" ||
    !SAFE_POLICY_VERSION.test(value.policyVersion)
  ) {
    return null;
  }

  return Object.freeze({
    approach: value.approach,
    tacticalMacro: value.tacticalMacro,
    attackStyle: value.attackStyle,
    prayer: value.prayer as string | null,
    preferredCombatRole:
      value.preferredCombatRole as CompetitiveDisclosureRole | null,
    foodThreshold: Number(value.foodThreshold),
    switchDefensiveAt: Number(value.switchDefensiveAt),
    source: value.source as CompetitiveDisclosureStrategy["source"],
    policyVersion: value.policyVersion,
  });
}

function parseArmorCount(value: unknown): number | null {
  if (!isRecord(value) || !hasExactKeys(value, ARMOR_SLOTS)) return null;
  let armorCount = 0;
  for (const slot of ARMOR_SLOTS) {
    const itemId = value[slot];
    if (!isNullableSafeText(itemId)) return null;
    if (itemId !== null) armorCount += 1;
  }
  return armorCount;
}

function parseLoadout(
  value: unknown,
  expectedRole: CompetitiveDisclosureRole,
): CompetitiveDisclosureLoadout | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "role",
      "weaponId",
      "arrowsId",
      "shieldId",
      "spellId",
      "armorIds",
    ]) ||
    value.role !== expectedRole ||
    !isSafeText(value.weaponId, 128) ||
    !isNullableSafeText(value.arrowsId) ||
    !isNullableSafeText(value.shieldId) ||
    !isNullableSafeText(value.spellId)
  ) {
    return null;
  }
  const armorCount = parseArmorCount(value.armorIds);
  if (armorCount === null) return null;

  return Object.freeze({
    role: expectedRole,
    weapon: value.weaponId,
    ammunition: value.arrowsId as string | null,
    shield: value.shieldId as string | null,
    spell: value.spellId as string | null,
    armorCount,
  });
}

function parseAgent(value: unknown): CompetitiveAgentDisclosure | null {
  if (!isRecord(value)) return null;
  if (
    !isSafeText(value.id) ||
    !isSafeText(value.name) ||
    value.loadoutFrozen !== true ||
    typeof value.loadoutFingerprint !== "string" ||
    !SHA256_HEX.test(value.loadoutFingerprint) ||
    !Array.isArray(value.availableCombatStyles) ||
    !isRecord(value.combatLoadouts)
  ) {
    return null;
  }

  const roleValues = value.availableCombatStyles;
  if (
    roleValues.length < 1 ||
    roleValues.length > 4 ||
    roleValues.some(
      (role) =>
        role !== "melee" &&
        role !== "ranged" &&
        role !== "mage" &&
        role !== "prayer",
    ) ||
    new Set(roleValues).size !== roleValues.length
  ) {
    return null;
  }
  const availableRoles = COMBAT_ROLES.filter((role) =>
    roleValues.includes(role),
  );
  if (availableRoles.length === 0) return null;
  const combatLoadouts = value.combatLoadouts as Record<string, unknown>;
  if (
    !hasExactKeys(combatLoadouts, availableRoles) ||
    Object.keys(combatLoadouts).some(
      (role) => !availableRoles.includes(role as CompetitiveDisclosureRole),
    )
  ) {
    return null;
  }

  const loadouts = availableRoles.map((role) =>
    parseLoadout(combatLoadouts[role], role),
  );
  if (loadouts.some((loadout) => loadout === null)) return null;
  const strategy = parseStrategy(value.strategySummary, availableRoles);
  if (!strategy) return null;

  return Object.freeze({
    id: value.id,
    name: value.name,
    fingerprint: value.loadoutFingerprint,
    strategy,
    loadouts: Object.freeze(
      loadouts as readonly CompetitiveDisclosureLoadout[],
    ),
  });
}

export function parseCompetitiveDisclosurePair(input: {
  phase: unknown;
  competitiveSnapshotVersion: unknown;
  agent1: unknown;
  agent2: unknown;
}): CompetitiveDisclosurePair | null {
  if (
    input.phase !== "ANNOUNCEMENT" ||
    input.competitiveSnapshotVersion !== COMPETITIVE_DISCLOSURE_SNAPSHOT_VERSION
  ) {
    return null;
  }
  const agent1 = parseAgent(input.agent1);
  const agent2 = parseAgent(input.agent2);
  if (!agent1 || !agent2 || agent1.id === agent2.id) return null;

  return Object.freeze({
    snapshotVersion: COMPETITIVE_DISCLOSURE_SNAPSHOT_VERSION,
    agents: Object.freeze([agent1, agent2]) as readonly [
      CompetitiveAgentDisclosure,
      CompetitiveAgentDisclosure,
    ],
  });
}

function normalizeAuthorityIdentifier(value: unknown): string | null {
  return isSafeText(value) ? value : null;
}

function normalizeDuelKeyHex(value: unknown): string | null {
  if (!isSafeText(value, 66)) return null;
  const normalized = value.toLowerCase().replace(/^0x/u, "");
  return SHA256_HEX.test(normalized) ? normalized : null;
}

function normalizeSnapshotDigest(value: unknown): string | null {
  if (!isSafeText(value, 64)) return null;
  const normalized = value.toLowerCase();
  return SHA256_HEX.test(normalized) ? normalized : null;
}

function isSameCompetitiveDisclosure(
  left: CompetitiveDisclosurePair,
  right: CompetitiveDisclosurePair,
): boolean {
  // Both values are parser-owned canonical projections. Comparing the whole
  // projection prevents a frame with the right contestant IDs but different
  // frozen strategy or loadout copy from authorizing a wager.
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isCompetitiveDisclosureTradeReady(input: {
  shellCanPlaceBet: boolean;
  phase: unknown;
  disclosure: CompetitiveDisclosurePair | null;
  currentCycle: CompetitiveDisclosureCycleAuthority | null;
  displayCycle: CompetitiveDisclosureCycleAuthority | null;
  marketAuthority: CompetitiveDisclosureMarketAuthority;
  onChainCommitment: CompetitiveDisclosureOnChainCommitment;
}): boolean {
  const currentCycle = input.currentCycle;
  const displayCycle = input.displayCycle;
  if (
    !input.shellCanPlaceBet ||
    !currentCycle ||
    !displayCycle ||
    input.phase !== "ANNOUNCEMENT" ||
    currentCycle.phase !== "ANNOUNCEMENT" ||
    displayCycle.phase !== "ANNOUNCEMENT" ||
    currentCycle.competitiveSnapshotVersion !==
      COMPETITIVE_DISCLOSURE_SNAPSHOT_VERSION ||
    displayCycle.competitiveSnapshotVersion !==
      COMPETITIVE_DISCLOSURE_SNAPSHOT_VERSION ||
    input.onChainCommitment.competitiveSnapshotVersion !==
      COMPETITIVE_DISCLOSURE_SNAPSHOT_VERSION ||
    input.disclosure === null
  ) {
    return false;
  }

  const currentCycleId = normalizeAuthorityIdentifier(currentCycle.cycleId);
  const displayCycleId = normalizeAuthorityIdentifier(displayCycle.cycleId);
  const currentDuelId = normalizeAuthorityIdentifier(currentCycle.duelId);
  const displayDuelId = normalizeAuthorityIdentifier(displayCycle.duelId);
  const marketDuelId = normalizeAuthorityIdentifier(
    input.marketAuthority.duelId,
  );
  const currentDuelKey = normalizeDuelKeyHex(currentCycle.duelKeyHex);
  const displayDuelKey = normalizeDuelKeyHex(displayCycle.duelKeyHex);
  const marketDuelKey = normalizeDuelKeyHex(input.marketAuthority.duelKeyHex);
  const onChainDuelKey = normalizeDuelKeyHex(
    input.onChainCommitment.duelKeyHex,
  );
  const currentDigest = normalizeSnapshotDigest(
    currentCycle.competitiveSnapshotDigest,
  );
  const displayDigest = normalizeSnapshotDigest(
    displayCycle.competitiveSnapshotDigest,
  );
  const onChainDigest = normalizeSnapshotDigest(
    input.onChainCommitment.competitiveSnapshotDigest,
  );
  if (
    currentCycleId === null ||
    currentCycleId !== displayCycleId ||
    currentDuelId === null ||
    currentDuelId !== displayDuelId ||
    currentDuelId !== marketDuelId ||
    currentDuelKey === null ||
    currentDuelKey !== displayDuelKey ||
    currentDuelKey !== marketDuelKey ||
    currentDuelKey !== onChainDuelKey ||
    currentDigest === null ||
    currentDigest !== displayDigest ||
    currentDigest !== onChainDigest
  ) {
    return false;
  }

  const currentDisclosure = parseCompetitiveDisclosurePair({
    phase: currentCycle.phase,
    competitiveSnapshotVersion: currentCycle.competitiveSnapshotVersion,
    agent1: currentCycle.agent1,
    agent2: currentCycle.agent2,
  });
  const displayDisclosure = parseCompetitiveDisclosurePair({
    phase: displayCycle.phase,
    competitiveSnapshotVersion: displayCycle.competitiveSnapshotVersion,
    agent1: displayCycle.agent1,
    agent2: displayCycle.agent2,
  });
  return Boolean(
    currentDisclosure &&
    displayDisclosure &&
    isSameCompetitiveDisclosure(currentDisclosure, displayDisclosure) &&
    isSameCompetitiveDisclosure(input.disclosure, displayDisclosure),
  );
}

export function formatCompetitiveDisclosureLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
