export const LOCAL_DIAGNOSTIC_DISPUTE_WINDOW_SECONDS = 3_600;
export const MINIMUM_DISPUTE_WINDOW_SECONDS = 60;
export const MAXIMUM_DISPUTE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export function resolveOracleDisputeWindowSeconds(input: {
  cluster: string;
  configuredValue: string | number | undefined;
}): number {
  const cluster = input.cluster.trim().toLowerCase();
  if (
    cluster !== "localnet" &&
    cluster !== "devnet" &&
    cluster !== "testnet" &&
    cluster !== "mainnet" &&
    cluster !== "mainnet-beta"
  ) {
    throw new Error(
      `Unsupported Solana dispute-window cluster '${input.cluster}'`,
    );
  }
  const raw =
    input.configuredValue === undefined
      ? ""
      : String(input.configuredValue).trim();
  if (!raw && cluster !== "localnet") {
    throw new Error(
      "SOLANA_ORACLE_DISPUTE_WINDOW_SECS must be explicitly configured outside localnet",
    );
  }
  const value = raw ? Number(raw) : LOCAL_DIAGNOSTIC_DISPUTE_WINDOW_SECONDS;
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_DISPUTE_WINDOW_SECONDS ||
    value > MAXIMUM_DISPUTE_WINDOW_SECONDS
  ) {
    throw new Error(
      `SOLANA_ORACLE_DISPUTE_WINDOW_SECS must be an integer between ${MINIMUM_DISPUTE_WINDOW_SECONDS} and ${MAXIMUM_DISPUTE_WINDOW_SECONDS}`,
    );
  }
  return value;
}
