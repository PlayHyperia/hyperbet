export type HyperiaCombatRole = "melee" | "ranged" | "mage";

const HYPERIA_COMBAT_TICK_DURATION_MS = 600;
const HYPERIA_ATTACK_SUPPLY_BOUNDARY_UNITS = 1;
export const HYPERIA_PREPARATION_FOOD = {
  itemId: "shrimp",
  healAmount: 3,
} as const;

const HYPERIA_COMBAT_LOADOUTS = {
  melee: {
    weaponId: "bronze_longsword",
    ammunitionItemId: null,
    selectedSpell: null,
    effectiveAttackSpeedTicks: null,
    inventoryCostPerAttack: [],
  },
  ranged: {
    weaponId: "shortbow",
    ammunitionItemId: "bronze_arrow",
    selectedSpell: null,
    // The fastest authoritative ranged stance reduces the base four-tick
    // shortbow cadence by one tick. Preparation must cover that worst case.
    effectiveAttackSpeedTicks: 3,
    inventoryCostPerAttack: [],
  },
  mage: {
    weaponId: "staff_of_air",
    ammunitionItemId: null,
    selectedSpell: "fire_strike",
    effectiveAttackSpeedTicks: 5,
    // The equipped air staff supplies air runes; only conserved inventory
    // costs belong in the frozen loadout.
    inventoryCostPerAttack: [
      { itemId: "fire_rune", quantity: 3 },
      { itemId: "mind_rune", quantity: 1 },
    ],
  },
} as const;

export function resolveHyperiaAttackSupplyUnits(
  maxFightDurationMs: number,
  effectiveAttackSpeedTicks: number,
): number {
  if (
    !Number.isSafeInteger(maxFightDurationMs) ||
    maxFightDurationMs <= 0 ||
    !Number.isSafeInteger(effectiveAttackSpeedTicks) ||
    effectiveAttackSpeedTicks <= 0
  ) {
    throw new Error("invalid Hyperia attack-supply timing contract");
  }
  const attackIntervalMs =
    effectiveAttackSpeedTicks * HYPERIA_COMBAT_TICK_DURATION_MS;
  const attackSupplyUnits =
    Math.ceil(maxFightDurationMs / attackIntervalMs) +
    HYPERIA_ATTACK_SUPPLY_BOUNDARY_UNITS;
  if (!Number.isSafeInteger(attackSupplyUnits) || attackSupplyUnits <= 0) {
    throw new Error("invalid Hyperia attack-supply result");
  }
  return attackSupplyUnits;
}

export function resolveHyperiaFullHealthFoodReserve(
  maxHealth: number,
  healAmount: number,
): number {
  if (
    !Number.isFinite(maxHealth) ||
    maxHealth <= 0 ||
    !Number.isFinite(healAmount) ||
    healAmount <= 0
  ) {
    throw new Error("invalid Hyperia full-health food reserve contract");
  }
  const quantity = Math.ceil(maxHealth / healAmount);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("invalid Hyperia full-health food reserve result");
  }
  return quantity;
}

export function resolveHyperiaCombatFixture(
  role: HyperiaCombatRole,
  maxFightDurationMs: number,
): {
  weaponId: string;
  ammunition: { itemId: string; quantity: number } | null;
  selectedSpell: string | null;
  inventorySupplies: Array<{ itemId: string; quantity: number }>;
} {
  const loadout = HYPERIA_COMBAT_LOADOUTS[role];
  if (loadout.effectiveAttackSpeedTicks === null) {
    return {
      weaponId: loadout.weaponId,
      ammunition: null,
      selectedSpell: loadout.selectedSpell,
      inventorySupplies: [],
    };
  }

  const attackSupplyUnits = resolveHyperiaAttackSupplyUnits(
    maxFightDurationMs,
    loadout.effectiveAttackSpeedTicks,
  );
  return {
    weaponId: loadout.weaponId,
    ammunition:
      loadout.ammunitionItemId === null
        ? null
        : {
            itemId: loadout.ammunitionItemId,
            quantity: attackSupplyUnits,
          },
    selectedSpell: loadout.selectedSpell,
    inventorySupplies: loadout.inventoryCostPerAttack.map((cost) => ({
      itemId: cost.itemId,
      quantity: cost.quantity * attackSupplyUnits,
    })),
  };
}
