import { PublicKey } from "@solana/web3.js";

export type KeeperRuntimeRole = "service" | "duel-bot";
export type KeeperRuntimeCluster =
  "localnet" | "devnet" | "testnet" | "mainnet-beta";

export interface KeeperRuntimeIdentity {
  schemaVersion: 1;
  role: KeeperRuntimeRole;
  cluster: KeeperRuntimeCluster;
  fightOracleProgramId: string;
  duelMarketProgramId: string;
}

function canonicalProgramId(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new Error(`${label} must be a canonical nonzero Solana public key`);
  }
  try {
    const publicKey = new PublicKey(value);
    if (publicKey.equals(PublicKey.default) || publicKey.toBase58() !== value) {
      throw new Error("noncanonical");
    }
    return value;
  } catch {
    throw new Error(`${label} must be a canonical nonzero Solana public key`);
  }
}

export function resolveKeeperRuntimeIdentity(input: {
  role: unknown;
  cluster: unknown;
  fightOracleProgramId: unknown;
  duelMarketProgramId: unknown;
}): KeeperRuntimeIdentity {
  if (input.role !== "service" && input.role !== "duel-bot") {
    throw new Error("keeper runtime role must be service or duel-bot");
  }
  if (
    input.cluster !== "localnet" &&
    input.cluster !== "devnet" &&
    input.cluster !== "testnet" &&
    input.cluster !== "mainnet-beta"
  ) {
    throw new Error("keeper runtime cluster is unsupported");
  }
  const fightOracleProgramId = canonicalProgramId(
    input.fightOracleProgramId,
    "fight oracle program ID",
  );
  const duelMarketProgramId = canonicalProgramId(
    input.duelMarketProgramId,
    "duel market program ID",
  );
  if (fightOracleProgramId === duelMarketProgramId) {
    throw new Error("keeper runtime program IDs must be distinct");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    role: input.role,
    cluster: input.cluster,
    fightOracleProgramId,
    duelMarketProgramId,
  });
}

export function parseKeeperRuntimeIdentity(
  value: unknown,
): KeeperRuntimeIdentity | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    record.schemaVersion !== 1 ||
    !("role" in record) ||
    !("cluster" in record) ||
    !("fightOracleProgramId" in record) ||
    !("duelMarketProgramId" in record)
  ) {
    return null;
  }
  try {
    return resolveKeeperRuntimeIdentity({
      role: record.role,
      cluster: record.cluster,
      fightOracleProgramId: record.fightOracleProgramId,
      duelMarketProgramId: record.duelMarketProgramId,
    });
  } catch {
    return null;
  }
}

export function keeperRuntimeIdentityMatches(
  actual: KeeperRuntimeIdentity | null | undefined,
  expected: KeeperRuntimeIdentity,
): boolean {
  return (
    actual != null &&
    actual.schemaVersion === expected.schemaVersion &&
    actual.role === expected.role &&
    actual.cluster === expected.cluster &&
    actual.fightOracleProgramId === expected.fightOracleProgramId &&
    actual.duelMarketProgramId === expected.duelMarketProgramId
  );
}
