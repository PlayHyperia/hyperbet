import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export const HYPERBET_MARKET_REFRESH_EVENT = "hyperbet:market-refresh";

export type HyperbetConfirmedSettlementRefresh = {
  schemaVersion: 1;
  mutation: "SETTLEMENT_CONFIRMED";
  wallet: string;
  marketPda: string;
  signature: string;
  kind: "CLAIM" | "REFUND" | "CLEANUP";
};

const CONFIRMED_SETTLEMENT_KEYS = new Set([
  "schemaVersion",
  "mutation",
  "wallet",
  "marketPda",
  "signature",
  "kind",
]);

function canonicalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : null;
}

function canonicalPublicKey(value: unknown): string | null {
  const normalized = canonicalNonEmptyString(value);
  if (!normalized) return null;
  try {
    return new PublicKey(normalized).toBase58() === normalized
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function canonicalTransactionSignature(value: unknown): string | null {
  const normalized = canonicalNonEmptyString(value);
  if (!normalized) return null;
  try {
    const decoded = bs58.decode(normalized);
    return decoded.length === 64 && bs58.encode(decoded) === normalized
      ? normalized
      : null;
  } catch {
    return null;
  }
}

export function parseHyperbetConfirmedSettlementRefresh(
  event: Event,
): HyperbetConfirmedSettlementRefresh | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const candidate = detail as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== CONFIRMED_SETTLEMENT_KEYS.size ||
    keys.some((key) => !CONFIRMED_SETTLEMENT_KEYS.has(key))
  ) {
    return null;
  }
  const wallet = canonicalPublicKey(candidate.wallet);
  const marketPda = canonicalPublicKey(candidate.marketPda);
  const signature = canonicalTransactionSignature(candidate.signature);
  if (
    candidate.schemaVersion !== 1 ||
    candidate.mutation !== "SETTLEMENT_CONFIRMED" ||
    (candidate.kind !== "CLAIM" &&
      candidate.kind !== "REFUND" &&
      candidate.kind !== "CLEANUP") ||
    !wallet ||
    !marketPda ||
    !signature
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    mutation: "SETTLEMENT_CONFIRMED",
    wallet,
    marketPda,
    signature,
    kind: candidate.kind,
  };
}

export function dispatchHyperbetMarketRefresh(
  detail?: HyperbetConfirmedSettlementRefresh,
): void {
  window.dispatchEvent(
    new CustomEvent(HYPERBET_MARKET_REFRESH_EVENT, {
      detail,
    }),
  );
}
