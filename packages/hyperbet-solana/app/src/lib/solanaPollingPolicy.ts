export type SolanaPollingPolicy = {
  programVerificationIntervalMs: number;
  matchDiscoveryIntervalMs: number;
};

const MINIMUM_PROGRAM_VERIFICATION_INTERVAL_MS = 5_000;
const TARGET_PROGRAM_VERIFICATION_INTERVAL_MS = 10_000;
const MINIMUM_MATCH_DISCOVERY_INTERVAL_MS = 10_000;

export function resolveSolanaPollingPolicy(input: {
  configuredRefreshIntervalMs: number;
  programVerificationMaxAgeMs: number;
}): SolanaPollingPolicy {
  const configuredRefreshIntervalMs = Number.isFinite(
    input.configuredRefreshIntervalMs,
  )
    ? Math.max(250, Math.floor(input.configuredRefreshIntervalMs))
    : 5_000;
  const programVerificationMaxAgeMs = Number.isFinite(
    input.programVerificationMaxAgeMs,
  )
    ? Math.max(2_000, Math.floor(input.programVerificationMaxAgeMs))
    : 15_000;
  const latestSafeVerificationIntervalMs = Math.max(
    1_000,
    programVerificationMaxAgeMs - 1_000,
  );

  return {
    programVerificationIntervalMs: Math.min(
      latestSafeVerificationIntervalMs,
      Math.max(
        MINIMUM_PROGRAM_VERIFICATION_INTERVAL_MS,
        TARGET_PROGRAM_VERIFICATION_INTERVAL_MS,
      ),
    ),
    matchDiscoveryIntervalMs: Math.max(
      MINIMUM_MATCH_DISCOVERY_INTERVAL_MS,
      configuredRefreshIntervalMs,
    ),
  };
}
