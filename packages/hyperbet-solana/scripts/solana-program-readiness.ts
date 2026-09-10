export interface SolanaProgramSimulation {
  logs: readonly string[] | null | undefined;
  error: unknown;
}

export interface SolanaProgramDispatchReadiness {
  programId: string;
  ready: boolean;
  invocationObserved: boolean;
  unsupportedProgramObserved: boolean;
  simulationReturnedError: boolean;
  reason: string | null;
}

export function evaluateSolanaProgramDispatchReadiness(input: {
  programId: string;
  simulation: SolanaProgramSimulation;
}): SolanaProgramDispatchReadiness {
  const logs = input.simulation.logs ?? [];
  const invocationPrefix = `Program ${input.programId} invoke [`;
  const invocationObserved = logs.some((line) =>
    line.startsWith(invocationPrefix),
  );
  const unsupportedProgramObserved = logs.some((line) =>
    line.toLowerCase().includes("unsupported program id"),
  );
  const simulationReturnedError = input.simulation.error !== null;

  let reason: string | null = null;
  if (unsupportedProgramObserved) {
    reason = "validator reported an unsupported program ID";
  } else if (!invocationObserved) {
    reason =
      logs.length === 0
        ? "simulation returned no program logs"
        : "simulation did not invoke the target program";
  } else if (simulationReturnedError) {
    reason = "initializer simulation returned an instruction error";
  }

  return {
    programId: input.programId,
    ready: reason === null,
    invocationObserved,
    unsupportedProgramObserved,
    simulationReturnedError,
    reason,
  };
}
