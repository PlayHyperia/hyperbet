import { describe, expect, test } from "bun:test";

import {
  pauseStateFailures,
  resolveDeploymentPauseExpectation,
} from "./deployment-pause-expectation";

describe("deployment pause expectation", () => {
  test("defaults launch verification to fully unpaused", () => {
    expect(resolveDeploymentPauseExpectation([])).toEqual({
      oraclePaused: false,
      orderPlacementPaused: false,
      marketCreationPaused: false,
    });
  });

  test("parses explicit emergency readback expectations", () => {
    expect(
      resolveDeploymentPauseExpectation([
        "--expect-oracle-paused=false",
        "--expect-order-placement-paused=true",
        "--expect-market-creation-paused=true",
      ]),
    ).toEqual({
      oraclePaused: false,
      orderPlacementPaused: true,
      marketCreationPaused: true,
    });
    expect(() =>
      resolveDeploymentPauseExpectation(["--expect-oracle-paused=1"]),
    ).toThrow("exactly true or false");
  });

  test("reports every observed pause mismatch independently", () => {
    expect(
      pauseStateFailures(
        {
          oraclePaused: true,
          orderPlacementPaused: false,
          marketCreationPaused: true,
        },
        {
          oraclePaused: false,
          orderPlacementPaused: true,
          marketCreationPaused: true,
        },
      ),
    ).toEqual([
      "oracle pause expected false but observed true",
      "order-placement pause expected true but observed false",
    ]);
  });
});
