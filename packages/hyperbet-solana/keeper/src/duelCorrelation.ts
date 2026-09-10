import { createHash } from "node:crypto";

const DUEL_CORRELATION_ID = /^[0-9a-f]{64}$/u;

export function buildDuelCorrelationId(input: {
  duelId: string;
  duelKey: string;
}): string {
  const duelId = input.duelId.trim();
  const duelKey = input.duelKey.trim().toLowerCase();
  if (!duelId || duelId !== input.duelId || duelId.length > 256) {
    throw new Error("duel correlation requires a canonical duel ID");
  }
  if (!DUEL_CORRELATION_ID.test(duelKey) || duelKey !== input.duelKey) {
    throw new Error("duel correlation requires a lowercase 32-byte duel key");
  }
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, duelId, duelKey }))
    .digest("hex");
}

export function isDuelCorrelationId(value: unknown): value is string {
  return typeof value === "string" && DUEL_CORRELATION_ID.test(value);
}

export function normalizeDuelCorrelationIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(isDuelCorrelationId))].sort().slice(0, 64);
}
