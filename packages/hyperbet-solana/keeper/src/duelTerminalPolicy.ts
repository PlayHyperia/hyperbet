import { Buffer } from "node:buffer";

export type CanonicalDuelOutcome = "win" | "draw" | "cancelled" | null;

export type DuelTerminalDisposition =
  | {
      action: "settle";
      winnerSide: "A" | "B";
      compatibilityMode: "canonical";
    }
  | {
      action: "cancel";
      outcome: "draw" | "cancelled";
      reason: string;
    }
  | {
      action: "reject";
      reason: string;
    };

export type OracleCancellationState =
  | "missing"
  | "scheduled"
  | "bettingOpen"
  | "locked"
  | "proposed"
  | "challenged"
  | "resolved"
  | "cancelled"
  | "unknown";

export type OracleCancellationDisposition =
  | "cancel"
  | "already_cancelled"
  | "preserve_resolved"
  | "manual_review"
  | "fail_closed";

export type OracleLockDisposition =
  "lock" | "already_locked" | "terminal" | "fail_closed";

export type OracleFinalizeErrorDisposition =
  "not_mature" | "state_race" | "fatal";

export function classifyDuelTerminal(input: {
  outcome: CanonicalDuelOutcome;
  cancellationReason?: string | null;
  winnerId?: string | null;
  agent1Id?: string | null;
  agent2Id?: string | null;
}): DuelTerminalDisposition {
  if (input.outcome === "draw" || input.outcome === "cancelled") {
    return {
      action: "cancel",
      outcome: input.outcome,
      reason:
        input.cancellationReason?.trim() ||
        (input.outcome === "draw" ? "draw" : "cancelled"),
    };
  }

  if (input.outcome !== "win") {
    return {
      action: "reject",
      reason: "canonical_outcome_missing",
    };
  }

  const winnerSide =
    input.winnerId && input.winnerId === input.agent1Id
      ? "A"
      : input.winnerId && input.winnerId === input.agent2Id
        ? "B"
        : null;
  if (!winnerSide) {
    return {
      action: "reject",
      reason: input.winnerId
        ? "winner_id_does_not_match_participants"
        : "winner_id_missing",
    };
  }

  return {
    action: "settle",
    winnerSide,
    compatibilityMode: "canonical",
  };
}

export function classifyOracleCancellation(
  state: OracleCancellationState,
): OracleCancellationDisposition {
  switch (state) {
    case "scheduled":
    case "bettingOpen":
    case "locked":
      return "cancel";
    case "cancelled":
      return "already_cancelled";
    case "resolved":
      return "preserve_resolved";
    case "proposed":
    case "challenged":
      return "manual_review";
    case "missing":
    case "unknown":
      return "fail_closed";
  }
}

export function classifyOracleLock(
  state: OracleCancellationState,
): OracleLockDisposition {
  switch (state) {
    case "bettingOpen":
      return "lock";
    case "locked":
    case "proposed":
    case "challenged":
      return "already_locked";
    case "resolved":
    case "cancelled":
      return "terminal";
    case "missing":
    case "scheduled":
    case "unknown":
      return "fail_closed";
  }
}

export function isOracleTimestampMature(
  chainTimeSecs: number | null,
  targetTimeSecs: number,
): boolean {
  return (
    Number.isSafeInteger(chainTimeSecs) &&
    Number.isSafeInteger(targetTimeSecs) &&
    (chainTimeSecs as number) >= targetTimeSecs
  );
}

export function resolveOracleDuelEndTimestamp(input: {
  duelEndTimeMs: number | null;
  duelStartTs: number;
}): number {
  if (
    !Number.isSafeInteger(input.duelEndTimeMs) ||
    Number(input.duelEndTimeMs) <= 0
  ) {
    throw new Error(
      "terminal feed is missing a valid duelEndTime; refusing to fabricate an oracle timestamp",
    );
  }
  if (!Number.isSafeInteger(input.duelStartTs) || input.duelStartTs <= 0) {
    throw new Error(
      "on-chain duel start is unavailable; refusing to infer an oracle timestamp",
    );
  }
  const duelEndTs = Math.floor(Number(input.duelEndTimeMs) / 1_000);
  if (duelEndTs < input.duelStartTs) {
    throw new Error(
      `terminal timestamp ${duelEndTs} precedes immutable on-chain duel start ${input.duelStartTs}`,
    );
  }
  return duelEndTs;
}

export function classifyOracleFinalizeError(
  error: unknown,
): OracleFinalizeErrorDisposition {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /DisputeWindowActive|Error Number:\s*6017\b|custom program error:\s*0x1781\b/i.test(
      message,
    )
  ) {
    return "not_mature";
  }
  if (
    /NotProposed|DuelAlreadyFinalized|Error Number:\s*(?:6011|6014)\b|custom program error:\s*0x(?:177b|177e)\b/i.test(
      message,
    )
  ) {
    return "state_race";
  }
  return "fatal";
}

export function buildDuelLifecycleMetadata(input: {
  duelId: string;
  duelKey: string;
  snapshotVersion: number;
  snapshotDigest: string;
  maxBytes?: number;
}): string {
  const maxBytes = Math.max(64, input.maxBytes ?? 200);
  const duelId = input.duelId.trim();
  if (!duelId) {
    throw new Error("Duel metadata requires a duelId");
  }
  const duelKeyHex = input.duelKey.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(duelKeyHex)) {
    throw new Error("Duel metadata requires a 32-byte duel key");
  }
  const snapshotDigest = input.snapshotDigest.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(snapshotDigest)) {
    throw new Error("Duel metadata requires a 32-byte snapshot digest");
  }
  if (
    !Number.isSafeInteger(input.snapshotVersion) ||
    input.snapshotVersion <= 0 ||
    input.snapshotVersion > 0xffff_ffff
  ) {
    throw new Error(
      "Duel metadata requires a positive unsigned 32-bit snapshot version",
    );
  }
  const correlated = JSON.stringify({
    duelId,
    duelKeyHex,
    competitiveSnapshotVersion: input.snapshotVersion,
    snapshotDigest,
  });
  if (Buffer.byteLength(correlated, "utf8") <= maxBytes) return correlated;

  const compact = JSON.stringify({
    v: 2,
    d: duelId,
    k: Buffer.from(duelKeyHex, "hex").toString("base64url"),
    s: input.snapshotVersion,
    h: Buffer.from(snapshotDigest, "hex").toString("base64url"),
  });
  if (Buffer.byteLength(compact, "utf8") > maxBytes) {
    throw new Error(
      `Exact duel lifecycle metadata exceeds ${maxBytes} metadata bytes`,
    );
  }
  return compact;
}

export type ParsedDuelLifecycleMetadata = {
  duelId: string;
  duelKeyHex: string;
  snapshotVersion: number;
  snapshotDigest: string;
};

export function parseDuelLifecycleMetadata(
  metadata: unknown,
): ParsedDuelLifecycleMetadata | null {
  if (typeof metadata !== "string" || !metadata.trim()) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const compact = parsed.v === 2;
    const duelIdValue = compact ? parsed.d : parsed.duelId;
    const keyValue = compact ? parsed.k : parsed.duelKeyHex;
    const snapshotVersionValue = compact
      ? parsed.s
      : parsed.competitiveSnapshotVersion;
    const snapshotDigestValue = compact ? parsed.h : parsed.snapshotDigest;
    const duelId = typeof duelIdValue === "string" ? duelIdValue.trim() : "";
    let duelKeyHex = "";
    let snapshotDigest = "";

    if (compact) {
      if (
        typeof keyValue !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(keyValue) ||
        typeof snapshotDigestValue !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(snapshotDigestValue)
      ) {
        return null;
      }
      const keyBytes = Buffer.from(keyValue, "base64url");
      const digestBytes = Buffer.from(snapshotDigestValue, "base64url");
      if (
        keyBytes.length !== 32 ||
        keyBytes.toString("base64url") !== keyValue ||
        digestBytes.length !== 32 ||
        digestBytes.toString("base64url") !== snapshotDigestValue
      ) {
        return null;
      }
      duelKeyHex = keyBytes.toString("hex");
      snapshotDigest = digestBytes.toString("hex");
    } else {
      duelKeyHex =
        typeof keyValue === "string"
          ? keyValue.trim().replace(/^0x/i, "").toLowerCase()
          : "";
      snapshotDigest =
        typeof snapshotDigestValue === "string"
          ? snapshotDigestValue.trim().toLowerCase()
          : "";
    }

    if (
      !duelId ||
      !/^[0-9a-f]{64}$/.test(duelKeyHex) ||
      !Number.isSafeInteger(snapshotVersionValue) ||
      Number(snapshotVersionValue) <= 0 ||
      Number(snapshotVersionValue) > 0xffff_ffff ||
      !/^[0-9a-f]{64}$/.test(snapshotDigest)
    ) {
      return null;
    }
    return {
      duelId,
      duelKeyHex,
      snapshotVersion: Number(snapshotVersionValue),
      snapshotDigest,
    };
  } catch {
    return null;
  }
}

export function buildDuelCancellationMetadata(input: {
  duelId: string;
  duelKey: string;
  outcome: "draw" | "cancelled";
  reason: string;
  maxBytes?: number;
}): string {
  const maxBytes = Math.max(64, input.maxBytes ?? 200);
  const duelId = input.duelId.trim();
  if (!duelId) {
    throw new Error("Cancellation metadata requires a duelId");
  }
  const normalizedKey = input.duelKey.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedKey)) {
    throw new Error("Cancellation metadata requires a 32-byte duel key");
  }
  const reason = input.reason.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(reason)) {
    throw new Error("Cancellation metadata requires an exact canonical reason");
  }

  const verbose = JSON.stringify({
    duelId,
    duelKeyHex: normalizedKey,
    outcome: input.outcome,
    reason,
  });
  if (Buffer.byteLength(verbose, "utf8") <= maxBytes) return verbose;

  const compact = JSON.stringify({
    v: 1,
    d: duelId,
    k: Buffer.from(normalizedKey, "hex").toString("base64url"),
    o: input.outcome === "draw" ? "d" : "c",
    r: reason,
  });
  if (Buffer.byteLength(compact, "utf8") > maxBytes) {
    throw new Error(
      `Exact cancellation metadata exceeds ${maxBytes} metadata bytes`,
    );
  }
  return compact;
}

export type ParsedDuelCancellationMetadata = {
  duelId: string;
  duelKeyHex: string;
  outcome: "draw" | "cancelled";
  reason: string;
};

export function parseDuelCancellationMetadata(
  metadata: unknown,
): ParsedDuelCancellationMetadata | null {
  if (typeof metadata !== "string" || !metadata.trim()) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const compact = parsed.v === 1;
    const duelIdValue = compact ? parsed.d : parsed.duelId;
    const keyValue = compact ? parsed.k : parsed.duelKeyHex;
    const outcomeValue = compact ? parsed.o : parsed.outcome;
    const reasonValue = compact ? parsed.r : parsed.reason;
    const duelId = typeof duelIdValue === "string" ? duelIdValue.trim() : "";
    let duelKeyHex = "";
    if (compact && typeof keyValue === "string") {
      if (!/^[A-Za-z0-9_-]{43}$/.test(keyValue)) return null;
      const keyBytes = Buffer.from(keyValue, "base64url");
      if (
        keyBytes.length !== 32 ||
        keyBytes.toString("base64url") !== keyValue
      ) {
        return null;
      }
      duelKeyHex = keyBytes.toString("hex");
    } else if (typeof keyValue === "string") {
      duelKeyHex = keyValue.trim().replace(/^0x/i, "").toLowerCase();
    }
    const outcome = compact
      ? outcomeValue === "d"
        ? "draw"
        : outcomeValue === "c"
          ? "cancelled"
          : null
      : outcomeValue === "draw" || outcomeValue === "cancelled"
        ? outcomeValue
        : null;
    const reason =
      typeof reasonValue === "string" ? reasonValue.trim().toLowerCase() : "";
    if (
      !duelId ||
      !/^[0-9a-f]{64}$/.test(duelKeyHex) ||
      outcome === null ||
      !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(reason)
    ) {
      return null;
    }
    return { duelId, duelKeyHex, outcome, reason };
  } catch {
    return null;
  }
}
