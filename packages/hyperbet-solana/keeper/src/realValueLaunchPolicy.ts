const TEST_MARKET_CLUSTERS = new Set(["localnet", "devnet", "testnet"]);

export type SolanaMarketCreationPolicy = {
  allowed: boolean;
  rail: "test" | "real-value" | "disabled";
  reason: "real-value-controls-incomplete" | "unsupported-cluster" | null;
};

/** Keep market creation on valueless rails until the audited launch controls land. */
export function resolveSolanaMarketCreationPolicy(
  cluster: string,
): SolanaMarketCreationPolicy {
  const normalizedCluster = cluster.trim().toLowerCase();

  if (TEST_MARKET_CLUSTERS.has(normalizedCluster)) {
    return { allowed: true, rail: "test", reason: null };
  }

  if (normalizedCluster === "mainnet" || normalizedCluster === "mainnet-beta") {
    return {
      allowed: false,
      rail: "real-value",
      reason: "real-value-controls-incomplete",
    };
  }

  return {
    allowed: false,
    rail: "disabled",
    reason: "unsupported-cluster",
  };
}

export function assertSolanaMarketCreationAllowed(cluster: string): void {
  const policy = resolveSolanaMarketCreationPolicy(cluster);
  if (policy.allowed) return;

  const normalizedCluster = cluster.trim() || "<empty>";
  throw new Error(
    `Solana ${policy.rail} market creation is blocked for ${normalizedCluster}: ${policy.reason}`,
  );
}
