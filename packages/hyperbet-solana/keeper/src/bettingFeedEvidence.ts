import { createHash } from "node:crypto";

import type { CompetitiveSnapshot, StreamingCycle } from "./game-client";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UINT64_DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const PHASES = new Set([
  "ANNOUNCEMENT",
  "COUNTDOWN",
  "FIGHTING",
  "RESOLUTION",
  "IDLE",
]);

export type BettingFeedEvidenceAgent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  hp: number;
  maxHp: number;
  combatLevel: number;
  wins: number;
  losses: number;
  damageDealtThisFight: number;
  rank: number;
  headToHeadWins: number;
  headToHeadLosses: number;
};

export type BettingFeedEvidenceFramePayload = {
  sourceEpoch: number;
  seq: number;
  emittedAt: number;
  phaseVersion: number;
  cycleId: string;
  duelId: string;
  duelKey: string;
  competitiveSnapshotVersion: number;
  competitiveSnapshotDigest: string;
  phase: string;
  betOpenTime: number;
  betCloseTime: number;
  fightStartTime: number | null;
  duelEndTime: number | null;
  winnerId: string | null;
  outcome: "win" | "draw" | "cancelled" | null;
  cancellationReason: string | null;
  winReason:
    | "kill"
    | "forfeit"
    | "hp_advantage"
    | "damage_advantage"
    | "draw"
    | null;
  seed: string | null;
  replayHash: string | null;
  agent1: BettingFeedEvidenceAgent;
  agent2: BettingFeedEvidenceAgent;
};

export type BettingFeedEvidenceFrame = BettingFeedEvidenceFramePayload & {
  frameDigest: string;
  materialDigest: string;
};

export type BettingFeedCompetitiveSnapshotEvidence = {
  duelId: string;
  duelKey: string;
  competitiveSnapshotDigest: string;
  competitiveSnapshot: CompetitiveSnapshot;
  firstSourceEpoch: number;
  firstSeq: number;
  firstEmittedAt: number;
};

export type BettingFeedDuelEvidence = {
  schemaVersion: 1;
  proof: "hyperia-schema-v3-material-duel-timeline";
  duelId: string;
  duelKey: string;
  competitiveSnapshotDigest: string;
  competitiveSnapshot: CompetitiveSnapshot;
  firstSourceEpoch: number;
  lastSourceEpoch: number;
  firstSeq: number;
  lastSeq: number;
  firstEmittedAt: number;
  lastEmittedAt: number;
  frames: BettingFeedEvidenceFrame[];
  timelineDigest: string;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalEvidenceJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

export function digestEvidence(value: unknown): string {
  return createHash("sha256").update(canonicalEvidenceJson(value)).digest("hex");
}

function requiredText(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`betting feed evidence ${label} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`betting feed evidence ${label} is invalid`);
  }
  return Number(value);
}

function optionalTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label, 1);
}

function normalizeAgent(
  value: StreamingCycle["agent1"],
  label: "agent1" | "agent2",
): BettingFeedEvidenceAgent {
  if (!value) throw new Error(`betting feed evidence ${label} is missing`);
  return {
    id: requiredText(value.id, `${label}.id`, 128),
    name: requiredText(value.name, `${label}.name`, 128),
    provider: requiredText(value.provider, `${label}.provider`, 128),
    model: requiredText(value.model, `${label}.model`, 128),
    hp: safeInteger(value.hp, `${label}.hp`),
    maxHp: safeInteger(value.maxHp, `${label}.maxHp`, 1),
    combatLevel: safeInteger(value.combatLevel, `${label}.combatLevel`, 1),
    wins: safeInteger(value.wins, `${label}.wins`),
    losses: safeInteger(value.losses, `${label}.losses`),
    damageDealtThisFight: safeInteger(
      value.damageDealtThisFight,
      `${label}.damageDealtThisFight`,
    ),
    rank: safeInteger(value.rank, `${label}.rank`),
    headToHeadWins: safeInteger(value.headToHeadWins, `${label}.headToHeadWins`),
    headToHeadLosses: safeInteger(
      value.headToHeadLosses,
      `${label}.headToHeadLosses`,
    ),
  };
}

function materialPayload(
  frame: BettingFeedEvidenceFramePayload,
): Omit<BettingFeedEvidenceFramePayload, "sourceEpoch" | "seq" | "emittedAt"> {
  const { sourceEpoch: _sourceEpoch, seq: _seq, emittedAt: _emittedAt, ...material } =
    frame;
  return material;
}

export function normalizeBettingFeedEvidenceFrame(
  cycle: StreamingCycle,
): {
  frame: BettingFeedEvidenceFrame;
  snapshot: BettingFeedCompetitiveSnapshotEvidence;
} | null {
  if (cycle.duelId === null) return null;
  const duelId = requiredText(cycle.duelId, "duelId", 256);
  if (!cycle.duelKeyHex || !SHA256_HEX.test(cycle.duelKeyHex)) {
    throw new Error("betting feed evidence duelKey is invalid");
  }
  if (
    !Number.isSafeInteger(cycle.competitiveSnapshotVersion) ||
    !cycle.competitiveSnapshotDigest ||
    !SHA256_HEX.test(cycle.competitiveSnapshotDigest) ||
    !cycle.competitiveSnapshot
  ) {
    throw new Error("betting feed evidence competitive snapshot is missing");
  }
  const snapshotDigest = digestEvidence(cycle.competitiveSnapshot);
  if (snapshotDigest !== cycle.competitiveSnapshotDigest) {
    throw new Error("betting feed evidence competitive snapshot digest drifted");
  }
  if (
    cycle.competitiveSnapshot.duelId !== duelId ||
    cycle.competitiveSnapshot.duelKey !== cycle.duelKeyHex
  ) {
    throw new Error("betting feed evidence competitive snapshot identity drifted");
  }
  if (!PHASES.has(cycle.phase)) {
    throw new Error("betting feed evidence phase is invalid");
  }
  const sourceEpoch = safeInteger(cycle.sourceEpoch, "sourceEpoch");
  const seq = safeInteger(cycle.seq, "seq");
  const emittedAt = safeInteger(cycle.emittedAt, "emittedAt", 1);
  const phaseVersion = safeInteger(cycle.phaseVersion, "phaseVersion");
  const betOpenTime = safeInteger(cycle.betOpenTime, "betOpenTime", 1);
  const betCloseTime = safeInteger(cycle.betCloseTime, "betCloseTime", 1);
  if (betCloseTime <= betOpenTime || emittedAt < betOpenTime) {
    throw new Error("betting feed evidence timeline is invalid");
  }
  if (
    cycle.seed !== null &&
    (typeof cycle.seed !== "string" || !UINT64_DECIMAL.test(cycle.seed))
  ) {
    throw new Error("betting feed evidence seed is invalid");
  }
  if (
    cycle.replayHash !== null &&
    (typeof cycle.replayHash !== "string" || !SHA256_HEX.test(cycle.replayHash))
  ) {
    throw new Error("betting feed evidence replayHash is invalid");
  }
  const payload: BettingFeedEvidenceFramePayload = {
    sourceEpoch,
    seq,
    emittedAt,
    phaseVersion,
    cycleId: requiredText(cycle.cycleId, "cycleId", 256),
    duelId,
    duelKey: cycle.duelKeyHex,
    competitiveSnapshotVersion: Number(cycle.competitiveSnapshotVersion),
    competitiveSnapshotDigest: cycle.competitiveSnapshotDigest,
    phase: cycle.phase,
    betOpenTime,
    betCloseTime,
    fightStartTime: optionalTimestamp(cycle.fightStartTime, "fightStartTime"),
    duelEndTime: optionalTimestamp(cycle.duelEndTime, "duelEndTime"),
    winnerId:
      cycle.winnerId === null
        ? null
        : requiredText(cycle.winnerId, "winnerId", 128),
    outcome: cycle.outcome,
    cancellationReason:
      cycle.cancellationReason === null
        ? null
        : requiredText(cycle.cancellationReason, "cancellationReason", 128),
    winReason: cycle.winReason,
    seed: cycle.seed,
    replayHash: cycle.replayHash,
    agent1: normalizeAgent(cycle.agent1, "agent1"),
    agent2: normalizeAgent(cycle.agent2, "agent2"),
  };
  const frame: BettingFeedEvidenceFrame = {
    ...payload,
    frameDigest: digestEvidence(payload),
    materialDigest: digestEvidence(materialPayload(payload)),
  };
  return {
    frame,
    snapshot: {
      duelId,
      duelKey: cycle.duelKeyHex,
      competitiveSnapshotDigest: cycle.competitiveSnapshotDigest,
      competitiveSnapshot: cycle.competitiveSnapshot,
      firstSourceEpoch: sourceEpoch,
      firstSeq: seq,
      firstEmittedAt: emittedAt,
    },
  };
}

export function buildBettingFeedDuelEvidence(input: {
  snapshot: BettingFeedCompetitiveSnapshotEvidence;
  frames: BettingFeedEvidenceFrame[];
}): BettingFeedDuelEvidence {
  if (input.frames.length === 0) {
    throw new Error("betting feed duel evidence has no material frames");
  }
  const frames = [...input.frames].sort(
    (left, right) =>
      left.sourceEpoch - right.sourceEpoch ||
      left.seq - right.seq ||
      left.emittedAt - right.emittedAt,
  );
  let previous: BettingFeedEvidenceFrame | null = null;
  for (const frame of frames) {
    if (
      frame.duelId !== input.snapshot.duelId ||
      frame.duelKey !== input.snapshot.duelKey ||
      frame.competitiveSnapshotDigest !==
        input.snapshot.competitiveSnapshotDigest
    ) {
      throw new Error("betting feed duel evidence identity drifted");
    }
    const { frameDigest, materialDigest, ...payload } = frame;
    if (
      digestEvidence(payload) !== frameDigest ||
      digestEvidence(materialPayload(payload)) !== materialDigest
    ) {
      throw new Error("betting feed duel evidence frame digest drifted");
    }
    if (
      previous &&
      (frame.sourceEpoch < previous.sourceEpoch ||
        (frame.sourceEpoch === previous.sourceEpoch &&
          frame.seq <= previous.seq) ||
        frame.emittedAt < previous.emittedAt)
    ) {
      throw new Error("betting feed duel evidence ordering drifted");
    }
    previous = frame;
  }
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  return {
    schemaVersion: 1,
    proof: "hyperia-schema-v3-material-duel-timeline",
    duelId: input.snapshot.duelId,
    duelKey: input.snapshot.duelKey,
    competitiveSnapshotDigest: input.snapshot.competitiveSnapshotDigest,
    competitiveSnapshot: input.snapshot.competitiveSnapshot,
    firstSourceEpoch: first.sourceEpoch,
    lastSourceEpoch: last.sourceEpoch,
    firstSeq: first.seq,
    lastSeq: last.seq,
    firstEmittedAt: first.emittedAt,
    lastEmittedAt: last.emittedAt,
    frames,
    timelineDigest: digestEvidence(frames.map((frame) => frame.frameDigest)),
  };
}
