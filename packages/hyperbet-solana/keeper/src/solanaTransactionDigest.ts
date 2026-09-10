import { PublicKey } from "@solana/web3.js";

import { digestEvidence } from "./bettingFeedEvidence";

function normalizeFinalizedSolanaRpcValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) return value.map(normalizeFinalizedSolanaRpcValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeFinalizedSolanaRpcValue(entry),
      ]),
    );
  }
  return value;
}

export function digestFinalizedSolanaTransaction(value: unknown): string {
  return digestEvidence(normalizeFinalizedSolanaRpcValue(value));
}
