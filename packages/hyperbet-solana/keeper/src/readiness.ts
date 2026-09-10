import {
  isKeeperMarketCircuitBreakerIncident,
  isKeeperMarketRecoveryIncident,
  isKeeperRecoveryIncident,
  type KeeperBotHealthSnapshot,
} from "./launchHealth";
import { isDuelCorrelationId } from "./duelCorrelation";
import {
  normalizeReleaseCommitSha,
  type KeeperReleaseIdentitySource,
} from "./releaseIdentity";
import { parseKeeperOperatorMetrics } from "./keeperOperatorMetrics";
import {
  keeperRuntimeIdentityMatches,
  parseKeeperRuntimeIdentity,
  type KeeperRuntimeIdentity,
} from "./runtimeIdentity";

export type ReadinessParserState = {
  enabled: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
};

export type KeeperReadinessInput = {
  nowMs: number;
  release: {
    required: boolean;
    requireBakedManifest: boolean;
    commitSha: string | null;
    source: KeeperReleaseIdentitySource;
  };
  requireStreamSource: boolean;
  streamMaxAgeMs: number;
  botMaxAgeMs: number;
  parserMaxAgeMs: number;
  stream: {
    sourceConfigured: boolean;
    authoritative: boolean;
    lastUpdatedAt: number | null;
    lastSourceError: string | null;
  };
  bot: KeeperBotHealthSnapshot | null;
  expectedBotRuntimeIdentity?: KeeperRuntimeIdentity;
  parser: ReadinessParserState;
  database: {
    ok: boolean;
    error: string | null;
  };
};

export type KeeperReadinessResult = {
  ready: boolean;
  reasons: string[];
  agesMs: {
    stream: number | null;
    bot: number | null;
    botRpc: number | null;
    parser: number | null;
  };
};

export type KeeperBotReadinessResult = {
  ready: boolean;
  reasons: string[];
  agesMs: {
    bot: number | null;
    botRpc: number | null;
  };
};

/**
 * A freshly polled IDLE frame is authoritative even though it intentionally
 * has no cycle id. This lets the SOL runtime prove source synchronization
 * before the first market opens, while still rejecting the local boot
 * placeholder and malformed active-cycle identities.
 */
export function isAuthoritativeStreamSnapshot(
  cycleId: unknown,
  phase: unknown,
): boolean {
  if (cycleId === "boot-cycle") return false;
  if (phase === "IDLE") {
    return cycleId === null || cycleId === "";
  }
  return (
    typeof cycleId === "string" &&
    cycleId.trim().length > 0 &&
    cycleId !== "boot-cycle"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseKeeperBotHealthSnapshot(
  value: unknown,
): KeeperBotHealthSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    value.chainKey !== "solana" ||
    !(
      value.releaseCommitSha === null ||
      normalizeReleaseCommitSha(value.releaseCommitSha) !== null
    ) ||
    typeof value.updatedAtMs !== "number" ||
    !Number.isFinite(value.updatedAtMs) ||
    typeof value.bootedAtMs !== "number" ||
    !Number.isFinite(value.bootedAtMs) ||
    typeof value.running !== "boolean" ||
    !Array.isArray(value.recovery) ||
    !Array.isArray(value.markets)
  ) {
    return null;
  }
  const runtime = parseKeeperRuntimeIdentity(value.runtime);
  if (!runtime || runtime.role !== "duel-bot") return null;
  if (
    !value.recovery.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.code === "string" &&
        typeof entry.active === "boolean" &&
        (entry.correlationIds === undefined ||
          (Array.isArray(entry.correlationIds) &&
            entry.correlationIds.every(isDuelCorrelationId))),
    )
  ) {
    return null;
  }
  if (
    !value.markets.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.lifecycleStatus === "string" &&
        (entry.circuitBreakerReason === null ||
          typeof entry.circuitBreakerReason === "string") &&
        (entry.correlationId === undefined ||
          entry.correlationId === null ||
          isDuelCorrelationId(entry.correlationId)) &&
        Array.isArray(entry.recovery) &&
        entry.recovery.every((reason) => typeof reason === "string"),
    )
  ) {
    return null;
  }
  const operatorMetrics = parseKeeperOperatorMetrics(value.operatorMetrics);
  if (!operatorMetrics) return null;
  if (
    operatorMetrics.observedAtMs !== value.updatedAtMs ||
    operatorMetrics.markets.retainedCount !== value.markets.length
  ) {
    return null;
  }
  return {
    ...(value as unknown as KeeperBotHealthSnapshot),
    runtime,
    operatorMetrics,
  };
}

function ageMs(nowMs: number, timestamp: number | null): number | null {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  return Math.max(0, nowMs - timestamp);
}

export function evaluateKeeperBotReadiness(input: {
  nowMs: number;
  botMaxAgeMs: number;
  requireReleaseIdentity: boolean;
  expectedReleaseCommitSha: string | null;
  expectedRuntimeIdentity?: KeeperRuntimeIdentity;
  bot: KeeperBotHealthSnapshot | null;
}): KeeperBotReadinessResult {
  const reasons = new Set<string>();
  const botAge = ageMs(input.nowMs, input.bot?.updatedAtMs ?? null);
  const botRpcAge = ageMs(
    input.nowMs,
    input.bot?.lastSuccessfulRpcAtMs ?? null,
  );

  if (!input.bot) {
    reasons.add("bot-health-missing");
  } else {
    if (
      input.requireReleaseIdentity &&
      input.bot.releaseCommitSha !== input.expectedReleaseCommitSha
    ) {
      reasons.add("bot-release-mismatch");
    }
    if (
      input.expectedRuntimeIdentity &&
      !keeperRuntimeIdentityMatches(
        input.bot.runtime,
        input.expectedRuntimeIdentity,
      )
    ) {
      reasons.add("bot-runtime-identity-mismatch");
    }
    if (!input.bot.running) reasons.add("bot-not-running");
    if (botAge == null || botAge > input.botMaxAgeMs) {
      reasons.add("bot-health-stale");
    }
    if (botRpcAge == null || botRpcAge > input.botMaxAgeMs) {
      reasons.add("bot-rpc-stale");
    }
    for (const recovery of input.bot.recovery) {
      if (isKeeperRecoveryIncident(recovery)) {
        reasons.add(`bot-recovery:${recovery.code}`);
      }
    }
    const terminalWorkActive = input.bot.recovery.some(
      (recovery) => recovery.active && recovery.code === "terminal-queue",
    );
    for (const market of input.bot.markets) {
      if (isKeeperMarketCircuitBreakerIncident(market)) {
        reasons.add("market-circuit-breaker");
      }
      if (market.lifecycleStatus === "CHALLENGED") {
        reasons.add("market-result-challenged");
      }
      // A resolved market with unclaimed market-maker inventory is an
      // expected intermediate state only while the durable terminal queue
      // owns that work. Once the queue drains, the same marker fails
      // readiness so a stranded claim cannot be hidden.
      if (isKeeperMarketRecoveryIncident(market, terminalWorkActive)) {
        reasons.add("market-recovery-active");
      }
    }
  }

  return {
    ready: reasons.size === 0,
    reasons: [...reasons],
    agesMs: { bot: botAge, botRpc: botRpcAge },
  };
}

export function evaluateKeeperReadiness(
  input: KeeperReadinessInput,
): KeeperReadinessResult {
  const reasons = new Set<string>();
  const streamAge = ageMs(input.nowMs, input.stream.lastUpdatedAt);
  const parserAge = ageMs(input.nowMs, input.parser.lastSuccessAt);

  if (input.release.required && !input.release.commitSha) {
    reasons.add("release-identity-unavailable");
  } else if (
    input.release.required &&
    input.release.requireBakedManifest &&
    input.release.source !== "manifest"
  ) {
    reasons.add("release-identity-not-baked");
  }

  if (input.requireStreamSource && !input.stream.sourceConfigured) {
    reasons.add("stream-source-missing");
  }
  if (!input.stream.authoritative) reasons.add("stream-state-unverified");
  if (streamAge == null || streamAge > input.streamMaxAgeMs) {
    reasons.add("stream-state-stale");
  }
  if (input.stream.lastSourceError) reasons.add("stream-source-error");

  const botReadiness = evaluateKeeperBotReadiness({
    nowMs: input.nowMs,
    botMaxAgeMs: input.botMaxAgeMs,
    requireReleaseIdentity: input.release.required,
    expectedReleaseCommitSha: input.release.commitSha,
    expectedRuntimeIdentity: input.expectedBotRuntimeIdentity,
    bot: input.bot,
  });
  for (const reason of botReadiness.reasons) {
    reasons.add(reason);
  }

  if (!input.parser.enabled) reasons.add("solana-parser-disabled");
  if (input.parser.lastError) reasons.add("solana-parser-error");
  if (parserAge == null || parserAge > input.parserMaxAgeMs) {
    reasons.add("solana-parser-stale");
  }
  if (!input.database.ok) reasons.add("database-unhealthy");

  return {
    ready: reasons.size === 0,
    reasons: [...reasons],
    agesMs: {
      stream: streamAge,
      bot: botReadiness.agesMs.bot,
      botRpc: botReadiness.agesMs.botRpc,
      parser: parserAge,
    },
  };
}
