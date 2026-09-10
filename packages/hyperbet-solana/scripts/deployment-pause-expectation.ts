export type DeploymentPauseExpectation = {
  oraclePaused: boolean;
  orderPlacementPaused: boolean;
  marketCreationPaused: boolean;
};

function parseExactBoolean(value: string | undefined, label: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${label} must be exactly true or false`);
}

function readEqualsArg(
  args: readonly string[],
  name: string,
): string | undefined {
  const prefix = `${name}=`;
  return args
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

export function resolveDeploymentPauseExpectation(
  args: readonly string[],
): DeploymentPauseExpectation {
  return {
    oraclePaused: parseExactBoolean(
      readEqualsArg(args, "--expect-oracle-paused"),
      "--expect-oracle-paused",
    ),
    orderPlacementPaused: parseExactBoolean(
      readEqualsArg(args, "--expect-order-placement-paused"),
      "--expect-order-placement-paused",
    ),
    marketCreationPaused: parseExactBoolean(
      readEqualsArg(args, "--expect-market-creation-paused"),
      "--expect-market-creation-paused",
    ),
  };
}

export function pauseStateFailures(
  actual: DeploymentPauseExpectation,
  expected: DeploymentPauseExpectation,
): string[] {
  const failures: string[] = [];
  for (const [label, key] of [
    ["oracle pause", "oraclePaused"],
    ["order-placement pause", "orderPlacementPaused"],
    ["market-creation pause", "marketCreationPaused"],
  ] as const) {
    if (actual[key] !== expected[key]) {
      failures.push(
        `${label} expected ${expected[key]} but observed ${actual[key]}`,
      );
    }
  }
  return failures;
}
