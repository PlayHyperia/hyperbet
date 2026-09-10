import { describe, expect, test } from "bun:test";

import {
  HYPERIA_PREPARATION_FOOD,
  resolveHyperiaAttackSupplyUnits,
  resolveHyperiaCombatFixture,
  resolveHyperiaFullHealthFoodReserve,
} from "../e2e/hyperiaCombatFixture";

describe("Hyperia combat fixture", () => {
  test("matches the authoritative full-health shrimp reserve policy", () => {
    expect(HYPERIA_PREPARATION_FOOD).toEqual({
      itemId: "shrimp",
      healAmount: 3,
    });
    expect(
      resolveHyperiaFullHealthFoodReserve(
        10,
        HYPERIA_PREPARATION_FOOD.healAmount,
      ),
    ).toBe(4);
    expect(resolveHyperiaFullHealthFoodReserve(20, 3)).toBe(7);
    expect(() => resolveHyperiaFullHealthFoodReserve(0, 3)).toThrow(
      "invalid Hyperia full-health food reserve contract",
    );
    expect(() => resolveHyperiaFullHealthFoodReserve(10, 0)).toThrow(
      "invalid Hyperia full-health food reserve contract",
    );
  });

  test("derives the ranged reserve from the frozen maximum fight duration", () => {
    expect(resolveHyperiaAttackSupplyUnits(160_000, 3)).toBe(90);
    expect(resolveHyperiaCombatFixture("ranged", 160_000)).toEqual({
      weaponId: "shortbow",
      ammunition: { itemId: "bronze_arrow", quantity: 90 },
      selectedSpell: null,
      inventorySupplies: [],
    });
  });

  test("derives every conserved mage supply from the same duration", () => {
    expect(resolveHyperiaAttackSupplyUnits(160_000, 5)).toBe(55);
    expect(resolveHyperiaCombatFixture("mage", 160_000)).toEqual({
      weaponId: "staff_of_air",
      ammunition: null,
      selectedSpell: "fire_strike",
      inventorySupplies: [
        { itemId: "fire_rune", quantity: 165 },
        { itemId: "mind_rune", quantity: 55 },
      ],
    });
  });

  test("keeps melee supply-free and rejects an invalid timing contract", () => {
    expect(resolveHyperiaCombatFixture("melee", 160_000)).toEqual({
      weaponId: "bronze_longsword",
      ammunition: null,
      selectedSpell: null,
      inventorySupplies: [],
    });
    expect(() => resolveHyperiaCombatFixture("ranged", Number.NaN)).toThrow(
      "invalid Hyperia attack-supply timing contract",
    );
    expect(() => resolveHyperiaAttackSupplyUnits(0, 3)).toThrow(
      "invalid Hyperia attack-supply timing contract",
    );
    expect(() => resolveHyperiaAttackSupplyUnits(160_000, 0)).toThrow(
      "invalid Hyperia attack-supply timing contract",
    );
  });
});
