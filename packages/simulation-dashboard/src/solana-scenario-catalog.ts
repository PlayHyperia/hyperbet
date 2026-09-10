export type ScenarioGateTier = "gate" | "diagnostic";
export type ScenarioSettlementMode = "resolve" | "cancel";
export type ScenarioSettlementStatus =
  | "NULL"
  | "OPEN"
  | "LOCKED"
  | "RESOLVED"
  | "CANCELLED";

export type ScenarioRuntimeProfile = {
  settlementMode?: ScenarioSettlementMode;
  staleStreamLagTicks?: number;
  staleOracleLagTicks?: number;
  staleRpcLagTicks?: number;
  betCloseTick?: number;
  marketMakerBetCloseGuardMs?: number;
  signalWeight?: number;
};

export type ScenarioGatePolicy = {
  requireDegradationFree?: boolean;
  requireMmSolvent?: boolean;
  requireBookIntegrity?: boolean;
  requireStaleStreamGuard?: boolean;
  requireStaleOracleGuard?: boolean;
  requireCloseGuard?: boolean;
  requireSettlementConsistency?: boolean;
  requireClaimsProcessed?: boolean;
  expectedSettlementStatus?: ScenarioSettlementStatus;
  maxAttackerPnl?: number;
  maxDrawdownBps?: number;
  minQuoteUptimeRatio?: number;
  maxQuoteUptimeRatio?: number;
  maxOrderChurn?: number;
  maxStaleQuoteUptimeRatio?: number;
  maxOrphanOrderCount?: number;
  maxReconciliationLagMs?: number;
  maxUnresolvedClaimBacklog?: number;
};

export type ScenarioPreset = {
  id: string;
  chainKey: "solana";
  name: string;
  family: string;
  description: string;
  enabledStrategies: string[];
  defaultTicks: number;
  defaultWinner: "A" | "B";
  canonicalSeed: string;
  matrixSeeds: string[];
  tier: ScenarioGateTier;
  runtimeProfile?: ScenarioRuntimeProfile;
  gatePolicy?: ScenarioGatePolicy;
};

function createResolvedGatePolicy(
  overrides: ScenarioGatePolicy = {},
): ScenarioGatePolicy {
  return {
    requireDegradationFree: true,
    requireMmSolvent: true,
    requireBookIntegrity: true,
    requireSettlementConsistency: true,
    requireClaimsProcessed: true,
    expectedSettlementStatus: "RESOLVED",
    maxAttackerPnl: 0,
    ...overrides,
  };
}

export const SCENARIO_PRESETS: readonly ScenarioPreset[] = [
  {
    id: "solana-happy-path",
    chainKey: "solana",
    name: "Solana Happy Path",
    family: "validator-proof",
    description:
      "Validator-backed duel setup, trade, settlement, and claim against the real Solana programs",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "A",
    canonicalSeed: "solana-happy-seed-1",
    matrixSeeds: [],
    tier: "diagnostic",
  },
  {
    id: "solana-unauthorized-oracle-attack",
    chainKey: "solana",
    name: "Solana Unauthorized Oracle Attack",
    family: "validator-proof",
    description:
      "Attempts an unauthorized oracle report before settling and claiming on the real validator-backed market",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "A",
    canonicalSeed: "solana-unauthorized-seed-1",
    matrixSeeds: [],
    tier: "diagnostic",
  },
  {
    id: "solana-stale-resolution-window",
    chainKey: "solana",
    name: "Solana Stale Resolution Window",
    family: "stale-resolution-window",
    description:
      "Attempts to resolve a validator-backed duel with an invalid pre-close end timestamp before settling correctly",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "A",
    canonicalSeed: "solana-stale-resolution-seed-1",
    matrixSeeds: [],
    tier: "gate",
    gatePolicy: createResolvedGatePolicy(),
  },
  {
    id: "solana-lock-race-attempt",
    chainKey: "solana",
    name: "Solana Lock Race Attempt",
    family: "lock-race-attempt",
    description:
      "Locks the duel on the validator-backed market and confirms that a post-lock order race is rejected before clean settlement",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "A",
    canonicalSeed: "solana-lock-race-seed-1",
    matrixSeeds: ["solana-lock-race-seed-2"],
    tier: "gate",
    gatePolicy: createResolvedGatePolicy({
      requireCloseGuard: true,
    }),
  },
  {
    id: "solana-cancel-replace-griefing",
    chainKey: "solana",
    name: "Solana Cancel Replace Griefing",
    family: "cancel-replace-griefing",
    description:
      "Churns real Solana CLOB orders through repeated cancel and replace cycles before matching and settlement",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "B",
    canonicalSeed: "solana-cancel-replace-seed-1",
    matrixSeeds: [],
    tier: "gate",
    gatePolicy: createResolvedGatePolicy({
      maxOrderChurn: 12,
    }),
  },
  {
    id: "solana-inventory-poisoning",
    chainKey: "solana",
    name: "Solana Inventory Poisoning",
    family: "inventory-poisoning",
    description:
      "Pushes repeated one-sided fills through the real Solana market to stress inventory concentration before resolution",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "B",
    canonicalSeed: "solana-inventory-poisoning-seed-1",
    matrixSeeds: [
      "solana-inventory-poisoning-seed-2",
      "solana-inventory-poisoning-seed-3",
    ],
    tier: "gate",
    gatePolicy: createResolvedGatePolicy({
      maxDrawdownBps: 2_500,
    }),
  },
  {
    id: "solana-claim-refund-abuse",
    chainKey: "solana",
    name: "Solana Claim Refund Abuse",
    family: "claim-refund-abuse",
    description:
      "Cancels a real Solana duel, exercises refund cleanup, and rejects repeated claim attempts after balances are cleared",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "A",
    canonicalSeed: "solana-claim-refund-seed-1",
    matrixSeeds: [],
    tier: "gate",
    runtimeProfile: {
      settlementMode: "cancel",
    },
    gatePolicy: createResolvedGatePolicy({
      expectedSettlementStatus: "CANCELLED",
    }),
  },
  {
    id: "solana-cross-market-validation-abuse",
    chainKey: "solana",
    name: "Solana Cross Market Validation Abuse",
    family: "cross-market-validation-abuse",
    description:
      "Attempts to match a validator-backed market using remaining accounts from a different Solana market and expects strict rejection",
    enabledStrategies: [],
    defaultTicks: 1,
    defaultWinner: "A",
    canonicalSeed: "solana-cross-market-seed-1",
    matrixSeeds: ["solana-cross-market-seed-2"],
    tier: "gate",
    gatePolicy: createResolvedGatePolicy(),
  },
];

export function getScenarioPresetByIdOrName(
  nameOrId: string,
): ScenarioPreset | null {
  return (
    SCENARIO_PRESETS.find(
      (preset) => preset.id === nameOrId || preset.name === nameOrId,
    ) ?? null
  );
}
