const TEST_TRANSACTION_CLUSTERS = new Set(["localnet", "devnet", "testnet"]);

export type SolanaTransactionAuthorityReason =
  | "disabled-by-configuration"
  | "real-value-controls-incomplete"
  | "unsupported-cluster";

export type SolanaTransactionAuthority = {
  enabled: boolean;
  rail: "disabled" | "test" | "real-value";
  reason: SolanaTransactionAuthorityReason | null;
};

/**
 * Resolve whether the browser is allowed to expose transaction capabilities.
 *
 * Test clusters require an explicit opt-in. Mainnet remains fail-closed until
 * the production real-value controls are approved and this policy is replaced
 * by the corresponding audited launch gate.
 */
export function resolveSolanaTransactionAuthority(input: {
  cluster: string;
  requested: boolean;
}): SolanaTransactionAuthority {
  const cluster = input.cluster.trim().toLowerCase();

  if (!input.requested) {
    return {
      enabled: false,
      rail: "disabled",
      reason: "disabled-by-configuration",
    };
  }

  if (TEST_TRANSACTION_CLUSTERS.has(cluster)) {
    return { enabled: true, rail: "test", reason: null };
  }

  if (cluster === "mainnet" || cluster === "mainnet-beta") {
    return {
      enabled: false,
      rail: "real-value",
      reason: "real-value-controls-incomplete",
    };
  }

  return {
    enabled: false,
    rail: "disabled",
    reason: "unsupported-cluster",
  };
}
