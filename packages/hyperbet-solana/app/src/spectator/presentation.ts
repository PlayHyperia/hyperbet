import { normalizePredictionMarketDuelKeyHex } from "@hyperbet/ui/lib/solanaPredictionMarkets";
import { isStreamingRendererHealthReady } from "@hyperbet/ui/spectator/useStreamingState";

import { hasAuthoritativeSpectatorPreparation } from "./preparation";
import type { RendererHealthDerivation, StreamingStateUpdate } from "./types";

export interface SpectatorPresentationInput {
  state: StreamingStateUpdate | null;
  streamConnected: boolean;
  nowMs: number;
  streamMaxAgeMs: number;
  uiSyncDelayMs: number;
}

export interface SpectatorPresentationState {
  rendererReady: boolean;
  hasFreshCycle: boolean;
  hasMatchup: boolean;
  hasPreparation: boolean;
  activityLabel: "LIVE" | "CONNECTED" | "RECONNECTING" | "UNAVAILABLE";
}

interface SpectatorStatusCopyInput {
  phase: string | null | undefined;
  winnerName: string | null | undefined;
  winReason?: string | null | undefined;
  cancellationReason?: string | null | undefined;
  hasFreshCycle: boolean;
  activityLabel: SpectatorPresentationState["activityLabel"];
}

interface SpectatorTerminalOutcomeInput {
  phase: string | null | undefined;
  winnerName: string | null | undefined;
  winReason: string | null | undefined;
  cancellationReason: string | null | undefined;
}

export type SpectatorTerminalOutcome =
  "winner" | "draw" | "cancelled" | "unknown" | null;

export function getSpectatorTerminalMarketFallbackCopy(
  outcome: SpectatorTerminalOutcome,
): { heading: string; detail: string } | null {
  if (outcome === "winner") {
    return {
      heading: "Settlement status updating",
      detail: "Verifying the on-chain result and settlement state.",
    };
  }
  if (outcome === "draw" || outcome === "cancelled") {
    return {
      heading: "Refund status updating",
      detail: "Verifying the on-chain refund and account state.",
    };
  }
  if (outcome === "unknown") {
    return {
      heading: "Result status updating",
      detail: "Verifying the on-chain result before showing account actions.",
    };
  }
  return null;
}

interface StreamRecoveryHeadingInput {
  playbackReady: boolean;
  telemetryConnected: boolean;
  rendererReady: boolean;
  hasStreamState: boolean;
  presentationReady: boolean;
}

export type StreamRecoveryMode = "hidden" | "blocking" | "advisory";

interface StreamReadinessDiagnosticsInput {
  evaluatedNowMs: number;
  recoveryMode: StreamRecoveryMode;
  hookRendererReady: boolean;
  currentPresentationRendererReady: boolean;
  currentConnected: boolean;
  presentationConnected: boolean;
  playbackReady: boolean;
  playbackDateMs: number | null;
  maxAgeMs: number;
  uiSyncDelayMs: number;
  currentState: StreamingStateUpdate | null;
  presentationState: StreamingStateUpdate | null;
}

function diagnosticInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function diagnosticText(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

/** Allowlisted observations only; this must never grant or deny authority. */
function normalizeRendererDerivation(
  value: unknown,
): RendererHealthDerivation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.externalSnapshotPresent !== "boolean" ||
    typeof input.rendererPresent !== "boolean" ||
    typeof input.scenePresent !== "boolean"
  )
    return null;
  const timestamp = (candidate: unknown): number | null =>
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0
      ? candidate
      : null;
  const token = (candidate: unknown, limit: number): string | null =>
    typeof candidate === "string" &&
    candidate.length <= limit &&
    /^[A-Za-z0-9_.:-]+$/.test(candidate)
      ? candidate
      : null;
  const boolean = (candidate: unknown): boolean | null =>
    typeof candidate === "boolean" ? candidate : null;
  return {
    schemaVersion: 1,
    evaluatedAtMs: timestamp(input.evaluatedAtMs),
    canonicalCycleId: token(input.canonicalCycleId, 128),
    canonicalPhase: token(input.canonicalPhase, 32),
    externalSnapshotPresent: input.externalSnapshotPresent === true,
    externalSnapshotUpdatedAt: timestamp(input.externalSnapshotUpdatedAt),
    rendererPresent: input.rendererPresent === true,
    rendererReady: boolean(input.rendererReady),
    rendererPhase: token(input.rendererPhase, 32),
    rendererDegradedReason: token(input.rendererDegradedReason, 128),
    rendererUpdatedAt: timestamp(input.rendererUpdatedAt),
    scenePresent: input.scenePresent === true,
    sceneReady: boolean(input.sceneReady),
    sceneCycleId: token(input.sceneCycleId, 128),
    scenePhase: token(input.scenePhase, 32),
    captureClientConnected: boolean(input.captureClientConnected),
    captureFfmpegRunning: boolean(input.captureFfmpegRunning),
  };
}

function projectStreamReadinessState(state: StreamingStateUpdate | null) {
  if (!state) return null;
  const cycle = state.cycle;
  const health = cycle?.rendererHealth;
  return {
    seq: diagnosticInteger(state.seq),
    emittedAt: diagnosticInteger(state.emittedAt),
    cycleId: diagnosticText(cycle?.cycleId, 128),
    duelId: diagnosticText(cycle?.duelId, 128),
    duelKeyHex: diagnosticText(cycle?.duelKeyHex, 64),
    phase: diagnosticText(cycle?.phase, 32),
    rendererHealth: health
      ? {
          ready: typeof health.ready === "boolean" ? health.ready : null,
          degradedReason: diagnosticText(health.degradedReason, 128),
          updatedAt: diagnosticInteger(health.updatedAt),
          ...(health.derivation === undefined
            ? {}
            : {
                derivation: normalizeRendererDerivation(health.derivation),
              }),
        }
      : null,
  };
}

/** Public, bounded observation only; never an input to readiness or wagering. */
export function buildStreamReadinessDiagnostics(
  input: StreamReadinessDiagnosticsInput,
) {
  return {
    schemaVersion: 1 as const,
    evaluatedNowMs: diagnosticInteger(input.evaluatedNowMs),
    recoveryMode: input.recoveryMode,
    hookRendererReady: input.hookRendererReady,
    currentPresentationRendererReady: input.currentPresentationRendererReady,
    currentConnected: input.currentConnected,
    presentationConnected: input.presentationConnected,
    playbackReady: input.playbackReady,
    // HLS/native playheads can carry sub-millisecond precision; unlike public
    // authority cursors, this is an observed playback position, not a counter.
    playbackDateMs:
      typeof input.playbackDateMs === "number" &&
      Number.isFinite(input.playbackDateMs) &&
      input.playbackDateMs >= 0 &&
      input.playbackDateMs <= Number.MAX_SAFE_INTEGER
        ? input.playbackDateMs
        : null,
    maxAgeMs: diagnosticInteger(input.maxAgeMs),
    uiSyncDelayMs: diagnosticInteger(input.uiSyncDelayMs),
    current: projectStreamReadinessState(input.currentState),
    presentation: projectStreamReadinessState(input.presentationState),
  };
}

interface SpectatorMatchupHeadingInput {
  phase: string | null | undefined;
  hasMatchup: boolean;
  hasLiveAuthority: boolean;
}

export function selectSpectatorPresentationUpdate(
  current: StreamingStateUpdate | null,
  lastMatch: StreamingStateUpdate | null,
  streamConnected: boolean,
): StreamingStateUpdate | null {
  const currentHasPreparation = current
    ? hasAuthoritativeSpectatorPreparation({
        preparation: current.preparation,
        cycle: current.cycle,
        emittedAt: current.emittedAt,
      })
    : false;
  if (
    streamConnected &&
    current?.cycle.phase === "IDLE" &&
    !currentHasPreparation &&
    lastMatch?.cycle.phase === "RESOLUTION" &&
    lastMatch?.cycle.agent1 &&
    lastMatch.cycle.agent2
  ) {
    return lastMatch;
  }
  return current;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Selects the phase shown in the spectator rail.
 *
 * Market lifecycle state is intentionally excluded here. A market may remain
 * locked while live renderer authority is unavailable; presenting that stale
 * lifecycle as the stream phase would contradict the fail-closed recovery UI.
 */
export function selectSpectatorDisplayPhase(
  cyclePhase: string | null | undefined,
  hasFreshCycle: boolean,
): string {
  return hasFreshCycle && hasText(cyclePhase) ? cyclePhase : "UNAVAILABLE";
}

export function classifySpectatorTerminalOutcome(
  input: SpectatorTerminalOutcomeInput,
): SpectatorTerminalOutcome {
  if (
    input.phase !== "RESOLUTION" &&
    input.phase !== "RESOLVED" &&
    input.phase !== "CANCELLED"
  ) {
    return null;
  }

  const winnerName = hasText(input.winnerName) ? input.winnerName.trim() : null;
  const winReason = hasText(input.winReason) ? input.winReason.trim() : null;
  const cancellationReason = hasText(input.cancellationReason)
    ? input.cancellationReason.trim()
    : null;

  if (
    winnerName !== null &&
    winReason !== null &&
    winReason !== "draw" &&
    cancellationReason === null
  ) {
    return "winner";
  }
  if (
    winnerName === null &&
    winReason === "draw" &&
    cancellationReason === "draw"
  ) {
    return "draw";
  }
  if (
    winnerName === null &&
    winReason === null &&
    cancellationReason !== null &&
    cancellationReason !== "draw"
  ) {
    return "cancelled";
  }
  return "unknown";
}

export function getSpectatorStatusCopy(
  input: SpectatorStatusCopyInput,
): string {
  if (!input.hasFreshCycle) {
    return input.activityLabel === "RECONNECTING"
      ? "Reconnecting to verified live arena telemetry."
      : "Waiting for verified live arena telemetry.";
  }

  switch (input.phase) {
    case "ANNOUNCEMENT":
      return "Matchup locked — fighters are preparing in the arena.";
    case "COUNTDOWN":
      return "Loadouts locked — the fight is about to begin.";
    case "FIGHTING":
      return "Round in progress — live combat telemetry is updating.";
    case "RESOLUTION": {
      const outcome = classifySpectatorTerminalOutcome({
        phase: input.phase,
        winnerName: input.winnerName,
        winReason: input.winReason,
        cancellationReason: input.cancellationReason,
      });
      if (outcome === "winner") {
        return `${input.winnerName?.trim()} wins the round.`;
      }
      if (outcome === "draw") {
        return "The round ended in a draw. No winner was declared.";
      }
      if (outcome === "cancelled") {
        return "The round was cancelled. No winner was declared.";
      }
      return "The round is complete.";
    }
    default:
      return "Waiting for the next matchup.";
  }
}

export function getStreamRecoveryHeading(
  input: StreamRecoveryHeadingInput,
): string | null {
  if (!input.playbackReady) {
    return input.hasStreamState
      ? "Reconnecting to the live arena"
      : "Connecting to the live arena";
  }
  if (!input.telemetryConnected) {
    return "Live match data temporarily unavailable";
  }
  if (!input.rendererReady) {
    return "Live arena view temporarily unavailable";
  }
  if (!input.presentationReady) {
    return "Live match data temporarily unavailable";
  }
  return null;
}

/**
 * Keeps healthy live video visible through telemetry-only interruptions while
 * still obscuring video that has not started or is not renderer-authoritative.
 * Transaction controls remain fail-closed independently of this presentation
 * choice.
 */
export function getStreamRecoveryMode(
  input: StreamRecoveryHeadingInput,
): StreamRecoveryMode {
  if (getStreamRecoveryHeading(input) === null) return "hidden";
  return input.playbackReady && input.rendererReady ? "advisory" : "blocking";
}

export function getStreamRecoveryDetail(mode: StreamRecoveryMode): string {
  return mode === "advisory"
    ? "The arena stays live. Match data and market actions remain paused while telemetry reconnects."
    : "Match and market actions stay unavailable until live playback and the arena camera are verified.";
}

export function getSpectatorMatchupHeading(
  input: SpectatorMatchupHeadingInput,
): string {
  if (!input.hasMatchup) {
    return input.hasLiveAuthority ? "Between rounds" : "Waiting for stream";
  }

  switch (input.phase) {
    case "ANNOUNCEMENT":
      return "Upcoming Match";
    case "COUNTDOWN":
      return "Fight Starting";
    case "RESOLUTION":
    case "RESOLVED":
    case "CANCELLED":
      return "Match Result";
    default:
      return "Current Match";
  }
}

/**
 * Derives presentation authority from the delayed public stream itself.
 *
 * The wagering gate intentionally compares the public stream with the latest
 * market lifecycle. The spectator rail must not do that: during a lifecycle
 * rollover, the buffered video is still showing the preceding duel. Keeping
 * these concerns separate prevents the visible fighters from disappearing
 * while all transaction controls remain fail-closed against current state.
 */
export function deriveSpectatorPresentationState(
  input: SpectatorPresentationInput,
): SpectatorPresentationState {
  const emittedAt = input.state?.emittedAt;
  const ageMs =
    typeof emittedAt === "number" && Number.isFinite(emittedAt) && emittedAt > 0
      ? Math.max(0, input.nowMs - emittedAt)
      : null;
  const allowedAgeMs =
    Math.max(0, input.streamMaxAgeMs) + Math.max(0, input.uiSyncDelayMs);
  const cycle = input.state?.cycle ?? null;
  const hasPreparation = input.state
    ? hasAuthoritativeSpectatorPreparation({
        preparation: input.state.preparation,
        cycle: input.state.cycle,
        emittedAt: input.state.emittedAt,
      })
    : false;
  const rendererReady = isStreamingRendererHealthReady(
    cycle?.rendererHealth,
    input.nowMs,
    allowedAgeMs,
  );
  const hasFreshCycle =
    input.streamConnected &&
    rendererReady &&
    ageMs !== null &&
    ageMs <= allowedAgeMs &&
    ((hasText(cycle?.cycleId) && cycle.cycleId !== "cycle-0") ||
      hasPreparation);
  const hasMatchup =
    hasFreshCycle &&
    hasText(cycle?.duelId) &&
    normalizePredictionMarketDuelKeyHex(cycle?.duelKeyHex) !== null &&
    hasText(cycle?.agent1?.name) &&
    hasText(cycle?.agent2?.name);

  const activityLabel =
    hasMatchup && cycle?.phase === "FIGHTING"
      ? "LIVE"
      : hasFreshCycle
        ? "CONNECTED"
        : input.state &&
            (!input.streamConnected ||
              !rendererReady ||
              ageMs === null ||
              ageMs > allowedAgeMs)
          ? "RECONNECTING"
          : "UNAVAILABLE";

  return {
    rendererReady,
    hasFreshCycle,
    hasMatchup,
    hasPreparation: hasFreshCycle && hasPreparation,
    activityLabel,
  };
}
