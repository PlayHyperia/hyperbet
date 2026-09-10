import { describe, expect, test } from "bun:test";

import { SCENARIO_PRESETS } from "./solana-scenario-catalog.js";

const expectedGateIds = [
  "solana-cancel-replace-griefing",
  "solana-claim-refund-abuse",
  "solana-cross-market-validation-abuse",
  "solana-inventory-poisoning",
  "solana-lock-race-attempt",
  "solana-stale-resolution-window",
];

describe("isolated Solana scenario catalog", () => {
  test("contains only unique Solana presets", () => {
    expect(SCENARIO_PRESETS).toHaveLength(8);
    expect(new Set(SCENARIO_PRESETS.map(({ id }) => id)).size).toBe(8);
    expect(
      SCENARIO_PRESETS.every(({ chainKey }) => chainKey === "solana"),
    ).toBe(true);
  });

  test("pins every required launch gate and its fail-closed settlement policy", () => {
    const gatePresets = SCENARIO_PRESETS.filter(({ tier }) => tier === "gate");
    expect(gatePresets.map(({ id }) => id).sort()).toEqual(expectedGateIds);
    for (const preset of gatePresets) {
      expect(preset.gatePolicy).toMatchObject({
        requireDegradationFree: true,
        requireMmSolvent: true,
        requireBookIntegrity: true,
        requireSettlementConsistency: true,
        requireClaimsProcessed: true,
        maxAttackerPnl: 0,
      });
      expect(preset.gatePolicy?.expectedSettlementStatus).toBe(
        preset.id === "solana-claim-refund-abuse" ? "CANCELLED" : "RESOLVED",
      );
    }

    expect(new Set(gatePresets.map(({ gatePolicy }) => gatePolicy)).size).toBe(
      gatePresets.length,
    );
  });

  test("retains the reviewed canonical and matrix seed coverage", () => {
    const gatePresets = SCENARIO_PRESETS.filter(({ tier }) => tier === "gate");
    const canonicalExecutions = gatePresets.length;
    const matrixExecutions = gatePresets
      .filter(({ matrixSeeds }) => matrixSeeds.length > 0)
      .reduce((total, { matrixSeeds }) => total + 1 + matrixSeeds.length, 0);
    expect({ canonicalExecutions, matrixExecutions }).toEqual({
      canonicalExecutions: 6,
      matrixExecutions: 7,
    });
  });
});
