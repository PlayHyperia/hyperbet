import { sha256 } from "@noble/hashes/sha2.js";

const DUEL_KEY = /^[0-9a-f]{64}$/u;
const DUEL_CORRELATION_ID = /^[0-9a-f]{64}$/u;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function buildDuelCorrelationId(input: {
  duelId: string;
  duelKey: string;
}): string {
  const duelId = input.duelId.trim();
  const duelKey = input.duelKey.trim().toLowerCase();
  if (!duelId || duelId !== input.duelId || duelId.length > 256) {
    throw new Error("duel correlation requires a canonical duel ID");
  }
  if (!DUEL_KEY.test(duelKey) || duelKey !== input.duelKey) {
    throw new Error("duel correlation requires a lowercase 32-byte duel key");
  }
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify({ schemaVersion: 1, duelId, duelKey }),
      ),
    ),
  );
}

export function isDuelCorrelationId(value: unknown): value is string {
  return typeof value === "string" && DUEL_CORRELATION_ID.test(value);
}
