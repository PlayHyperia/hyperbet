export type StreamingPhase =
  "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";

export interface AgentInfo {
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
  equipment?: Readonly<Record<string, string>>;
  inventory?: ReadonlyArray<{
    slot?: number;
    itemId: string;
    quantity: number;
  } | null>;
  loadoutFingerprint?: unknown;
  availableCombatStyles?: unknown;
  combatLoadouts?: unknown;
  loadoutFrozen?: unknown;
  strategySummary?: unknown;
}

export type { RendererHealthDerivation } from "@hyperbet/ui/spectator/types";
import type { RendererHealthDerivation } from "@hyperbet/ui/spectator/types";

export interface RendererHealthInfo {
  ready: boolean;
  degradedReason: string | null;
  updatedAt: number | null;
  derivation?: RendererHealthDerivation | null;
}

export interface StreamingDuelActionObservation {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly tick: number;
  readonly observedAt: number;
  readonly cycleId: string;
  readonly duelId: string;
  readonly actorId: string;
  readonly opponentId: string;
  readonly phase: "FIGHTING";
  readonly combatRole: "melee" | "ranged" | "mage";
  readonly tacticalMacro:
    "pressure" | "hold_range" | "kite" | "orbit" | "defensive_reset" | "finish";
  readonly action:
    | "movement"
    | "engagement"
    | "food"
    | "prayer"
    | "style"
    | "role_switch"
    | "damage";
  readonly outcome:
    "accepted" | "committed" | "deferred" | "rejected" | "error";
  readonly value: string;
  readonly amount: number | null;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  provider: string;
  model: string;
  wins: number;
  losses: number;
  winRate: number;
  currentStreak: number;
}

export interface StreamingCycle {
  cycleId: string;
  phase: StreamingPhase;
  cycleStartTime: number;
  phaseStartTime: number;
  phaseEndTime: number;
  timeRemaining: number;
  agent1: AgentInfo | null;
  agent2: AgentInfo | null;
  duelId?: string | null;
  duelKeyHex?: string | null;
  competitiveSnapshotVersion?: number | null;
  competitiveSnapshotDigest?: string | null;
  betOpenTime?: number | null;
  betCloseTime?: number | null;
  countdown: number | null;
  fightStartTime?: number | null;
  duelEndTime?: number | null;
  winnerId: string | null;
  winnerName: string | null;
  winReason: string | null;
  cancellationReason?: string | null;
  actionObservations?: readonly StreamingDuelActionObservation[];
  rendererHealth?: RendererHealthInfo | null;
  seed?: string | null;
  replayHash?: string | null;
}

export interface StreamingStateUpdate {
  type: "STREAMING_STATE_UPDATE";
  cycle: StreamingCycle;
  leaderboard: LeaderboardEntry[];
  cameraTarget: string | null;
  /** Strictly parsed by the spectator before any preparation copy is shown. */
  preparation?: unknown;
  seq?: number;
  emittedAt?: number;
}
