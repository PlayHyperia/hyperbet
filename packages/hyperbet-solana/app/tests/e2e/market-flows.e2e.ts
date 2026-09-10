import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import BN from "bn.js";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Response,
  type Route,
} from "@playwright/test";
import {
  type AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  cancelDuel,
  deriveClobVaultPda,
  deriveDuelStatePda,
  deriveMarketStatePda,
  deriveOracleConfigPda,
  ensureOracleReady,
  initializeCanonicalMarket,
  ORDER_BEHAVIOR_GTC,
  SIDE_ASK,
  SIDE_BID,
  deriveOrderPda,
  derivePriceLevelPda,
  deriveUserBalancePda,
  duelStatusBettingOpen,
  duelStatusLocked,
  finalizeDuelResult,
  marketSideA,
  proposeDuelResult,
  syncMarketFromDuel,
  upsertDuel,
  uniqueDuelKey,
  currentChainUnixTimestamp,
} from "../../../anchor/tests/clob-test-helpers";
import { confirmSignatureByPolling } from "../../../anchor/tests/test-anchor";
import {
  parseDuelCancellationMetadata,
  parseDuelLifecycleMetadata,
} from "../../../keeper/src/duelTerminalPolicy";
import {
  formatSolLamports,
  parseSolAmountToLamports,
} from "../../../../hyperbet-ui/src/lib/solanaOrderQuote";
import {
  buildSyntheticDuelCommitment,
  buildSyntheticPublicAgent,
  buildSyntheticRendererHealth,
  E2E_AGENT_A_IDENTITY,
  E2E_AGENT_B_IDENTITY,
  E2E_INITIAL_CYCLE_ID,
} from "./syntheticDuelFixture";
import {
  HYPERIA_PREPARATION_FOOD,
  resolveHyperiaCombatFixture,
  resolveHyperiaFullHealthFoodReserve,
  type HyperiaCombatRole,
} from "./hyperiaCombatFixture";

type E2eState = {
  solanaRpcUrl?: string;
  solanaWsUrl?: string;
  bootstrapWalletPath?: string;
  clobUserBalance?: string;
  clobConfig?: string;
  clobMarketState?: string;
  clobDuelState?: string;
  clobTreasury?: string;
  clobMarketMaker?: string;
  clobVault?: string;
  currentDuelId?: string;
  currentDuelKeyHex?: string;
  currentBetOpenTimeMs?: number;
  currentBetCloseTimeMs?: number;
  currentFightStartTimeMs?: number;
  currentPhase?: string;
  currentDuelSource?: "synthetic_publish" | "real_hyperia";
  solanaTraderPublicKey?: string;
};

type UserBalanceAccount = {
  aShares?: unknown;
  bShares?: unknown;
  aLockedLamports?: unknown;
  bLockedLamports?: unknown;
  tradeTreasuryFeeLamports?: unknown;
  tradeMarketMakerFeeLamports?: unknown;
};

type MarketStateAccount = {
  nextOrderId?: unknown;
  bestBid?: unknown;
  bestAsk?: unknown;
};

type PriceLevelAccount = {
  totalOpen?: unknown;
  headOrderId?: unknown;
  tailOrderId?: unknown;
};

type OrderAccount = {
  id?: unknown;
  marketState?: PublicKey;
  maker?: PublicKey;
  side?: unknown;
  price?: unknown;
  amount?: unknown;
  filled?: unknown;
  prevOrderId?: unknown;
  nextOrderId?: unknown;
  active?: boolean;
  continuationPending?: boolean;
};

type AccountNamespaceFetcher = {
  fetch: (pubkey: PublicKey) => Promise<Record<string, unknown>>;
};

type PredictionMarketsResponse = {
  duel: {
    duelKey: string | null;
    duelId: string | null;
    phase: string | null;
    winner: string;
    betCloseTime: number | null;
    syncedAt: number | null;
  };
  markets: Array<{
    chainKey: string;
    duelKey: string | null;
    duelId: string | null;
    marketId: string | null;
    marketRef: string | null;
    lifecycleStatus: string;
    winner: string;
    betCloseTime: number | null;
    contractAddress: string | null;
    programId: string | null;
    txRef: string | null;
    syncedAt: number | null;
  }>;
  updatedAt: number | null;
};

type KeeperBotHealthResponse = {
  ok: boolean;
  running: boolean;
  health: {
    chainKey: string;
    updatedAtMs: number;
    running: boolean;
    recovery: Array<{
      code: string;
      active: boolean;
    }>;
    markets: Array<{
      lifecycleStatus: string;
      marketRef: string | null;
    }>;
  } | null;
};

type SolanaCyclePhase = "ANNOUNCEMENT" | "COUNTDOWN" | "RESOLUTION";

type StreamingStateResponse = {
  cycle?: {
    cycleId?: string | null;
    duelId?: string | number | null;
    duelKeyHex?: string | null;
    competitiveSnapshotVersion?: number | null;
    competitiveSnapshotDigest?: string | null;
    betOpenTime?: number | null;
    betCloseTime?: number | null;
    fightStartTime?: number | null;
    competitiveSnapshot?: {
      snapshotVersion?: number;
      timing?: {
        contractVersion?: number;
        timeoutPolicy?: string;
        countdownDurationMs?: number;
        fightingDurationMs?: number;
        endWarningDurationMs?: number;
        maxFightDurationMs?: number;
        fightStartTime?: number;
        fightDeadline?: number;
      };
    } | null;
  } | null;
};

type DuelStateAccountSnapshot = {
  duelKey?: readonly number[];
  status?: unknown;
  winner?: unknown;
  betOpenTs?: unknown;
  betCloseTs?: unknown;
  duelStartTs?: unknown;
  competitiveSnapshotVersion?: unknown;
  competitiveSnapshotDigest?: readonly number[];
  metadataUri?: unknown;
};

type SolanaTraderFixture = {
  userBalanceAddress: PublicKey;
  duelKey: number[];
  duelKeyHex: string;
  duelId: string;
  duelState: PublicKey;
  marketState: PublicKey;
  marketStatus: string | null;
  marketWinner: string | null;
  duelStatus: string | null;
  pendingWinner: string | null;
  pendingDuelEndTs: number;
  pendingProposedAt: number;
  finalizableAt: number | null;
  betOpenTs: number;
  betCloseTs: number;
  duelStartTs: number;
  duelEndTs: number;
  aShares: bigint;
  bShares: bigint;
  aLockedLamports: bigint;
  bLockedLamports: bigint;
};

type HarnessControl = {
  controlPath: string;
  launchPath: string;
  services: {
    keeper: {
      healthUrl: string;
      botHealthUrl: string;
    };
    solanaProxy: {
      faultControlPath: string;
    };
    hyperia?: {
      pidFile: string;
      healthUrl: string;
      authorityHealthUrl: string;
      streamStateUrl: string;
      logPath: string;
      runtime?: "compact" | "full_3d";
      combatRole?: "melee" | "ranged" | "mage";
      terminalExpectation?: "natural_kill" | "short_kill" | "exact_timeout";
      rendererStatusPath?: string | null;
      captureStatusPath?: string | null;
      preparationEvidencePath?: string | null;
      preparationFramePath?: string | null;
      startCommand?: string;
    };
  };
};

type HyperiaRendererStatus = {
  source?: string;
  updatedAt?: number;
  rendererHealth?: {
    ready?: boolean;
    degradedReason?: string | null;
    phase?: string;
    diagnostics?: {
      sceneReadiness?: {
        ready?: boolean;
        cycleId?: string | null;
        phase?: string;
        equipmentVisualsReady?: boolean;
        equipmentRequiredCount?: number;
        equipmentReadyCount?: number;
        equipmentRequiredPlayerCount?: number;
        equipmentExpectedPlayerCount?: number;
        equipmentActivePlayerCount?: number;
        equipmentAttachmentMismatchCount?: number;
        expectedAgentCount?: number;
        loadedExpectedAgentCount?: number;
        visibleExpectedAgentCount?: number;
        damagePresentationAvailable?: boolean;
        activeDamageSplatCount?: number | null;
        renderedAgentCount?: number;
        visibleAgentFramingCount?: number;
        fullyFramedAgentSlots?: Array<"agent1" | "agent2">;
        croppedVisibleAgentBodyCount?: number;
        unobstructedVisibleAgentSlots?: Array<"agent1" | "agent2">;
        occludedVisibleAgentBodyCount?: number;
        missingVisibleAgentLineOfSightCount?: number;
        minimumVisibleAgentHorizontalNdcSeparation?: number | null;
        minimumVisibleAgentBodyNdcSpan?: number | null;
        maximumVisibleAgentBodyNdcSpan?: number | null;
        cameraTargetSlot?: "agent1" | "agent2" | null;
        cameraTargetMatchesExpected?: boolean;
        preparationActive?: boolean;
        preparationShotActive?: boolean;
        preparationPairShotActive?: boolean;
      };
    };
  };
  stats?: {
    bytesReceived?: number;
    droppedFrames?: number;
    ffmpegRunning?: boolean;
    audioSource?: string;
    audioHealthy?: boolean;
    audioChunks?: number;
    audioDroppedChunks?: number;
    audioTrimmedChunks?: number;
  };
  captureHealth?: {
    targetFps?: number;
    measuredFps?: number;
    sourceFrames?: number;
    emittedFrames?: number;
    repeatedFrames?: number;
    rejectedFrames?: number;
    skippedFrames?: number;
  };
  browserAudioCaptureHealth?: {
    contextState?: string | null;
    sourceContextState?: string | null;
    trackState?: string | null;
    sampleRate?: number | null;
    channels?: number | null;
    chunks?: number;
    contentChunks?: number;
    droppedChunks?: number;
    pendingWrites?: number;
  };
};

type HyperiaAuthorityHealth = {
  ready?: boolean;
  sourceEpoch?: number;
  duelId?: string | null;
  duelKeyHex?: string | null;
  snapshotDigest?: string | null;
  phase?: string | null;
  outcome?: string | null;
  cancellationReason?: string | null;
  competitiveSnapshotPersisted?: boolean;
  competitiveSnapshotDiagnostic?: boolean | null;
};

type HyperiaShutdownEvidence = {
  event: "shutdown-complete";
  sourceEpoch: number;
  terminalFrameSeq: number;
  duelId: string;
  duelKeyHex: string;
  competitiveSnapshotDigest: string;
  outcome: "cancelled";
  cancellationReason: "scheduler_shutdown";
  downstreamAcknowledged: true;
};

type HyperiaStreamingState = {
  type?: string;
  seq?: number;
  emittedAt?: number;
  cycle?: {
    cycleId?: string;
    duelId?: string | null;
    duelKeyHex?: string | null;
    competitiveSnapshotDigest?: string | null;
    phase?: string;
    phaseVersion?: number;
    agent1?: { id?: string | null; name?: string | null; hp?: number } | null;
    agent2?: { id?: string | null; name?: string | null; hp?: number } | null;
    winnerId?: string | null;
    winnerName?: string | null;
    loserId?: string | null;
    outcome?: string | null;
    winReason?: string | null;
    seed?: string | null;
    replayHash?: string | null;
    duelEndTime?: number | null;
    actionObservations?: HyperiaDuelActionObservation[];
    competitiveSnapshot?: {
      persisted?: boolean;
      diagnostic?: boolean;
      preparationId?: string | null;
      frozenAt?: number;
      contestants?: Array<{ agentId?: string }>;
    } | null;
  };
  cameraTarget?: string | null;
  preparation?: {
    schemaVersion?: number;
    status?: "preparing" | "ready";
    selectedAt?: number;
    expiresAt?: number;
    agent1?: {
      id?: string;
      ready?: boolean;
      activity?: string | null;
      mode?: string | null;
      activityTrail?: string[];
    };
    agent2?: {
      id?: string;
      ready?: boolean;
      activity?: string | null;
      mode?: string | null;
      activityTrail?: string[];
    };
  } | null;
};

type HyperiaDuelActionObservation = {
  schemaVersion: number;
  sequence: number;
  tick: number;
  observedAt: number;
  cycleId: string;
  duelId: string;
  actorId: string;
  opponentId: string;
  phase: "FIGHTING";
  combatRole: "melee" | "ranged" | "mage";
  tacticalMacro:
    "pressure" | "hold_range" | "kite" | "orbit" | "defensive_reset" | "finish";
  action:
    | "movement"
    | "engagement"
    | "food"
    | "prayer"
    | "style"
    | "role_switch"
    | "damage";
  outcome: "accepted" | "committed" | "deferred" | "rejected" | "error";
  value: string;
  amount: number | null;
};

type HyperiaCombatAIDiagnostic = {
  characterId: string;
  cycleId: string | null;
  duelId: string | null;
  active: boolean;
  capturedAtMs: number;
  combatRole: "melee" | "ranged" | "mage" | "prayer";
  tickCount: number;
  prayerToggleAttempts: number;
  prayerToggleCommits: number;
  prayerToggleRejects: number;
  lastPrayerToggleFailureReason: string | null;
};

type HyperiaCombatAIDiagnosticsEvidence = {
  schemaVersion: 1;
  diagnosticScope: "operator_private";
  trigger: "terminal_snapshot";
  capturedAtMs: number;
  cycleId: string;
  duelId: string;
  duelKeyHex: string;
  competitiveSnapshotDigest: string;
  combatAIs: HyperiaCombatAIDiagnostic[];
};

type Full3DPreparationEvidence = {
  schemaVersion: 1;
  capturedAtMs: number;
  publicState: HyperiaStreamingState;
  ordinaryPreparation: {
    schemaVersion: 3;
    status: "passed";
    multiStyle: boolean;
    availableCombatRoles: Array<"melee" | "ranged" | "mage">;
    samePersistentAgentIds: string[];
    agents: Array<{
      agentId: string;
      fishingXp: number;
      fishingLevel: number;
      cookingXp: number;
      cookingLevel: number;
      cookedFood: number;
      rawFood: number;
      burntFood: number;
      toolCount: number;
      gatheringOperations: number;
      processingOperations: number;
      ordinaryBankOperations: number;
      progressionStarts: number;
      progressionTerminals: number;
    }>;
    totals: {
      gatheringOperations: number;
      processingOperations: number;
      ordinaryBankOperations: number;
    };
    liveWorldReports: Array<{
      agentId: string;
      path: string;
      sha256: string;
      preparationVerticalSlice: {
        status?: string;
        exactFinalCustodyAndXp?: boolean;
        quiescent?: boolean;
        movement?: { diagonalStep?: boolean };
        presentation?: {
          rotationPackets?: number;
          processingRejections?: number;
        };
        cooking?: {
          forcedBurnObserved?: boolean;
          recoveryGatherActions?: number;
        };
      };
    }>;
    processDeathRecoveryCovered: boolean;
    ordinaryAutonomySelectionCovered: boolean;
    liveWorldNavigationCovered: boolean;
    livePreparationPresentationCovered: boolean;
    realPostgresqlCustodyCovered: boolean;
    fullTopologySeedContractCovered: boolean;
    ownedMultiStylePreparationCovered: boolean;
    ordinaryForgingQuestCovered: boolean;
    workerDatabaseSessionsDrained: boolean;
    workerDatabaseSessionDrainElapsedMs: number;
    remainingWorkerDatabaseSessionPids: number[];
    scriptedCustodyBridgeCovered: boolean;
    externalModelProviderCovered: boolean;
  };
  privateAuthority: {
    preparationId: string;
    agent1Id: string;
    agent2Id: string;
    status: "ready";
    selectedAt: number;
    expiresAt: number;
    agent1ReadyAt: number;
    agent2ReadyAt: number;
    activityRows: Array<{
      agentId: string;
      activity: string;
      mode: string;
      occurredAt: number;
      revision: number;
    }>;
    bankOpenCount: number;
    planOperationCount: number;
    planOperations: Array<{
      agentId: string;
      committedInventory: Array<{ itemId: string; quantity: number }>;
      committedBank: Array<{ itemId: string; quantity: number }>;
    }>;
  };
  frozenBettingSource: {
    schemaVersion: number;
    duelId: string;
    duelKey: string;
    competitiveSnapshotVersion: number;
    competitiveSnapshotDigest: string;
    competitiveSnapshot: {
      persisted: boolean;
      diagnostic: boolean;
      preparationId: string;
      frozenAt: number;
      timing?: {
        contractVersion?: number;
        timeoutPolicy?: string;
        countdownDurationMs?: number;
        fightingDurationMs?: number;
        endWarningDurationMs?: number;
        maxFightDurationMs?: number;
        fightStartTime?: number;
        fightDeadline?: number;
      };
      contestants: Array<{
        agentId: string;
        maxHp: number;
        equipment: Array<{ slot: string; itemId: string; quantity: number }>;
        skillLevels: Array<{ skill: string; level: number }>;
        inventory: Array<{ itemId: string; quantity: number }>;
        selectedSpell: string | null;
        initialCombatStyle: "melee" | "ranged" | "mage" | "prayer";
        availableCombatStyles: Array<"melee" | "ranged" | "mage" | "prayer">;
        preparation: {
          planningSource: string;
          tacticalStrategy: { prayer: string | null };
        };
      }>;
    };
  };
  rendererStatus: HyperiaRendererStatus;
  preparationCoverage: {
    mode: "pair" | "directed_cuts";
    shots: Array<{
      slot: "agent1" | "agent2";
      publicState: HyperiaStreamingState;
      rendererStatus: HyperiaRendererStatus;
      frame: {
        source: "capture_browser";
        path: string;
        sha256: string;
        width: number;
        height: number;
      };
    }>;
  };
  hls: {
    framePath: string;
    frameSha256: string;
    width: number;
    height: number;
    segmentName: string;
    segmentSha256: string;
  };
};

type ForwardedSolanaTransactionHold = {
  version: 1;
  mode: "hold_send_transaction_after_forward";
  state: "armed" | "observed";
  faultId: string;
  requiredAccount: string;
  requiredProgramId: string;
  armedAtMs: number;
  signature?: string;
  observedAtMs?: number;
  holdUntilMs?: number;
};

type FinalizedTransactionVisibilityGap = {
  version: 1;
  mode: "hide_get_transaction_after_forward";
  state: "armed" | "observed" | "released";
  faultId: string;
  requiredAccount: string;
  requiredProgramId: string;
  armedAtMs: number;
  signature?: string;
  observedAtMs?: number;
  hiddenLookupCount?: 0 | 1;
  hiddenAtMs?: number;
  releasedAtMs?: number;
  requestedCommitment?: "finalized";
  requestedLane?: "verifier";
};

type SolanaRpcFaultControl =
  ForwardedSolanaTransactionHold | FinalizedTransactionVisibilityGap;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.resolve(__dirname, "./state.json");
const controlPath = path.resolve(__dirname, "./control.json");
const processControlScriptPath = path.resolve(
  __dirname,
  "../../../../../scripts/e2e-process-control.sh",
);
const GAME_API_URL = (process.env.E2E_GAME_API_URL || "http://127.0.0.1:5555")
  .trim()
  .replace(/\/$/, "");
const E2E_ARENA_WRITE_KEY =
  process.env.E2E_ARENA_WRITE_KEY?.trim() ||
  process.env.ARENA_EXTERNAL_BET_WRITE_KEY?.trim() ||
  process.env.VITE_ARENA_WRITE_KEY?.trim() ||
  "";
const E2E_DUEL_SOURCE =
  process.env.E2E_DUEL_SOURCE?.trim().toLowerCase() || "synthetic_publish";
const E2E_HYPERIA_RUNTIME =
  process.env.E2E_HYPERIA_RUNTIME?.trim().toLowerCase() || "compact";
const HYPERIA_COMBAT_ROLE =
  process.env.E2E_HYPERIA_COMBAT_ROLE?.trim().toLowerCase() || "ranged";
const HYPERIA_MULTI_STYLE =
  process.env.AGENT_DUEL_3D_E2E_MULTI_STYLE?.trim().toLowerCase() === "true";
const EXPECT_KEEPER_BOT =
  (process.env.E2E_EXPECT_KEEPER_BOT?.trim().toLowerCase() ?? "true") !==
  "false";
const REQUIRE_MATURED_SOLANA_WIN_CLAIM =
  (process.env.E2E_REQUIRE_MATURED_SOLANA_WIN_CLAIM?.trim().toLowerCase() ??
    "false") === "true";
const REQUIRE_NATURAL_HYPERIA_TERMINAL =
  (process.env.E2E_HYPERIA_NATURAL_TERMINAL?.trim().toLowerCase() ??
    "false") === "true";
const HYPERIA_TERMINAL_EXPECTATION =
  process.env.E2E_HYPERIA_TERMINAL_EXPECTATION?.trim().toLowerCase() ||
  "natural_kill";
const EXPECT_EXACT_HYPERIA_TIMEOUT =
  HYPERIA_TERMINAL_EXPECTATION === "exact_timeout";
const EXPECT_SHORT_HYPERIA_KILL = HYPERIA_TERMINAL_EXPECTATION === "short_kill";
const SHORT_HYPERIA_KILL_MAX_DURATION_MS = 45_000;
const anchorIdlDir = path.resolve(__dirname, "../../../anchor/target/idl");
const fightOracleIdl = JSON.parse(
  fs.readFileSync(path.join(anchorIdlDir, "fight_oracle.json"), "utf8"),
) as Idl;
const duelMarketIdl = JSON.parse(
  fs.readFileSync(path.join(anchorIdlDir, "duel_market.json"), "utf8"),
) as Idl;
const duelMarketProgramId = duelMarketIdl.address;
const PREPARED_LIVE_DUEL_MIN_OPEN_WINDOW_MS = 60_000;
const COMPETITIVE_SNAPSHOT_RECOVERY_WINDOW_ELAPSED_REASON =
  "competitive_snapshot_recovery_window_elapsed";

function loadState(): E2eState {
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as E2eState;
}

function loadControl(): HarnessControl {
  return JSON.parse(fs.readFileSync(controlPath, "utf8")) as HarnessControl;
}

function readOwnedProcessId(pidFile: string, label: string): number {
  if (!path.isAbsolute(pidFile)) {
    throw new Error(`${label} PID file must be absolute`);
  }
  const processId = Number(fs.readFileSync(pidFile, "utf8").trim());
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error(`${label} PID file does not contain a positive integer`);
  }
  process.kill(processId, 0);
  return processId;
}

function readProcessCommand(processId: number): string {
  const command = execFileSync(
    "/bin/ps",
    ["-p", String(processId), "-o", "command="],
    { encoding: "utf8" },
  ).trim();
  if (!command) throw new Error(`process ${processId} has no command`);
  return command;
}

function readHyperiaRendererStatus(
  control: HarnessControl,
): HyperiaRendererStatus | null {
  const statusPath = control.services.hyperia?.rendererStatusPath?.trim() || "";
  if (!path.isAbsolute(statusPath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(statusPath, "utf8"),
    ) as HyperiaRendererStatus;
  } catch {
    return null;
  }
}

function readFull3DPreparationEvidence(
  control: HarnessControl,
): Full3DPreparationEvidence {
  const evidencePath =
    control.services.hyperia?.preparationEvidencePath?.trim() || "";
  const framePath =
    control.services.hyperia?.preparationFramePath?.trim() || "";
  if (
    !path.isAbsolute(evidencePath) ||
    !path.isAbsolute(framePath) ||
    !fs.existsSync(evidencePath) ||
    !fs.existsSync(framePath)
  ) {
    throw new Error(
      "full 3D preparation evidence requires absolute existing evidence and frame paths",
    );
  }
  const evidence = JSON.parse(
    fs.readFileSync(evidencePath, "utf8"),
  ) as Full3DPreparationEvidence;
  if (evidence.hls?.framePath !== framePath) {
    throw new Error("full 3D preparation frame identity drifted");
  }
  return evidence;
}

function armForwardedSolanaTransactionHold(
  control: HarnessControl,
  input: {
    faultId: string;
    requiredAccount: PublicKey;
    requiredProgramId: PublicKey;
  },
): void {
  const faultControlPath = control.services.solanaProxy.faultControlPath;
  if (!path.isAbsolute(faultControlPath)) {
    throw new Error("Solana RPC fault-control path must be absolute");
  }
  const payload: SolanaRpcFaultControl = {
    version: 1,
    mode: "hold_send_transaction_after_forward",
    state: "armed",
    faultId: input.faultId,
    requiredAccount: input.requiredAccount.toBase58(),
    requiredProgramId: input.requiredProgramId.toBase58(),
    armedAtMs: Date.now(),
  };
  fs.writeFileSync(faultControlPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

function armFinalizedTransactionVisibilityGap(
  control: HarnessControl,
  input: {
    faultId: string;
    requiredAccount: PublicKey;
    requiredProgramId: PublicKey;
  },
): void {
  const faultControlPath = control.services.solanaProxy.faultControlPath;
  if (!path.isAbsolute(faultControlPath)) {
    throw new Error("Solana RPC fault-control path must be absolute");
  }
  const payload: FinalizedTransactionVisibilityGap = {
    version: 1,
    mode: "hide_get_transaction_after_forward",
    state: "armed",
    faultId: input.faultId,
    requiredAccount: input.requiredAccount.toBase58(),
    requiredProgramId: input.requiredProgramId.toBase58(),
    armedAtMs: Date.now(),
  };
  fs.writeFileSync(faultControlPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

function readSolanaRpcFaultControl(
  control: HarnessControl,
): SolanaRpcFaultControl | null {
  try {
    return JSON.parse(
      fs.readFileSync(control.services.solanaProxy.faultControlPath, "utf8"),
    ) as SolanaRpcFaultControl;
  } catch {
    return null;
  }
}

function runProcessControl(
  control: HarnessControl,
  action: "start" | "stop" | "kill" | "restart",
  service: "keeper" | "keeperBot" | "solanaProxy" | "hyperia" | "hyperiaClient",
): void {
  execFileSync(
    "bash",
    [processControlScriptPath, action, control.controlPath, service],
    {
      stdio: "inherit",
    },
  );
}

function readHyperiaShutdownEvidence(
  control: HarnessControl,
): HyperiaShutdownEvidence {
  const logPath = control.services.hyperia?.logPath?.trim() || "";
  if (!path.isAbsolute(logPath)) {
    throw new Error("real Hyperia authority log path is missing or relative");
  }
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith("{") || !line.includes('"shutdown-complete"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Partial<HyperiaShutdownEvidence>;
      if (parsed.event === "shutdown-complete") {
        return parsed as HyperiaShutdownEvidence;
      }
    } catch {
      // Ignore unrelated structured-log fragments and keep scanning.
    }
  }
  throw new Error("Hyperia did not emit graceful shutdown completion evidence");
}

async function fetchHyperiaAuthorityHealth(
  request: APIRequestContext,
  control: HarnessControl,
): Promise<HyperiaAuthorityHealth> {
  const healthUrl = control.services.hyperia?.authorityHealthUrl?.trim() || "";
  if (!healthUrl) {
    throw new Error("real Hyperia authority health URL is missing");
  }
  const bearerToken =
    process.env.E2E_HYPERIA_BET_SYNC_BEARER_TOKEN?.trim() || "";
  const response = await request.get(healthUrl, {
    failOnStatusCode: false,
    headers: bearerToken
      ? { authorization: `Bearer ${bearerToken}` }
      : undefined,
  });
  if (!response.ok()) {
    throw new Error(
      `Hyperia authority health returned HTTP ${response.status()}`,
    );
  }
  return parseHyperiaAuthorityHealth(await response.json());
}

function parseHyperiaAuthorityHealth(value: unknown): HyperiaAuthorityHealth {
  if (!value || typeof value !== "object") {
    throw new Error("Hyperia authority health is not an object");
  }
  const health = value as Record<string, unknown>;
  const nullableStringKeys = [
    "duelId",
    "duelKeyHex",
    "snapshotDigest",
    "phase",
    "outcome",
    "cancellationReason",
  ] as const;
  if (
    typeof health.ready !== "boolean" ||
    typeof health.sourceEpoch !== "number" ||
    !Number.isSafeInteger(health.sourceEpoch) ||
    typeof health.competitiveSnapshotPersisted !== "boolean" ||
    !nullableStringKeys.every(
      (key) => health[key] === null || typeof health[key] === "string",
    ) ||
    !(
      health.competitiveSnapshotDiagnostic === null ||
      typeof health.competitiveSnapshotDiagnostic === "boolean"
    )
  ) {
    throw new Error("Hyperia authority health contract is malformed");
  }
  return health as HyperiaAuthorityHealth;
}

async function fetchHyperiaStreamingState(
  request: APIRequestContext,
  control: HarnessControl,
): Promise<HyperiaStreamingState> {
  const streamStateUrl = control.services.hyperia?.streamStateUrl?.trim() || "";
  if (!streamStateUrl) {
    throw new Error("real Hyperia streaming-state URL is missing");
  }
  const response = await request.get(streamStateUrl, {
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    throw new Error(
      `Hyperia streaming state returned HTTP ${response.status()}`,
    );
  }
  return (await response.json()) as HyperiaStreamingState;
}

async function fetchHyperiaCombatAIDiagnostics(
  request: APIRequestContext,
  control: HarnessControl,
): Promise<HyperiaCombatAIDiagnostic[]> {
  const healthUrl = control.services.hyperia?.healthUrl?.trim() || "";
  const adminCode = process.env.E2E_HYPERIA_ADMIN_CODE?.trim() || "";
  if (!healthUrl || !adminCode) {
    throw new Error(
      "real Hyperia combat diagnostics require a health URL and private admin credential",
    );
  }
  const diagnosticUrl = new URL("/admin/duels/combat-ai", healthUrl);
  if (
    diagnosticUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(diagnosticUrl.hostname)
  ) {
    throw new Error(
      "Hyperia combat diagnostics are restricted to the owned loopback E2E authority",
    );
  }
  const response = await request.get(diagnosticUrl.toString(), {
    failOnStatusCode: false,
    headers: { "x-admin-code": adminCode },
  });
  if (!response.ok()) {
    throw new Error(
      `Hyperia combat diagnostics returned HTTP ${response.status()}`,
    );
  }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Hyperia combat diagnostics payload is not an object");
  }
  const entries = (payload as Record<string, unknown>).combatAIs;
  if (!Array.isArray(entries)) {
    throw new Error(
      "Hyperia combat diagnostics payload has no combatAIs array",
    );
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Hyperia combat diagnostic ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const combatRole = record.combatRole;
    const lastFailure = record.lastPrayerToggleFailureReason;
    const integerKeys = [
      "capturedAtMs",
      "tickCount",
      "prayerToggleAttempts",
      "prayerToggleCommits",
      "prayerToggleRejects",
    ] as const;
    if (
      typeof record.characterId !== "string" ||
      !(record.cycleId === null || typeof record.cycleId === "string") ||
      !(record.duelId === null || typeof record.duelId === "string") ||
      typeof record.active !== "boolean" ||
      !/^(melee|ranged|mage|prayer)$/.test(String(combatRole)) ||
      !integerKeys.every(
        (key) =>
          typeof record[key] === "number" &&
          Number.isSafeInteger(record[key]) &&
          record[key] >= 0,
      ) ||
      !(lastFailure === null || typeof lastFailure === "string")
    ) {
      throw new Error(`Hyperia combat diagnostic ${index} is malformed`);
    }
    return {
      characterId: record.characterId,
      cycleId: record.cycleId as string | null,
      duelId: record.duelId as string | null,
      active: record.active,
      capturedAtMs: record.capturedAtMs as number,
      combatRole: combatRole as HyperiaCombatAIDiagnostic["combatRole"],
      tickCount: record.tickCount as number,
      prayerToggleAttempts: record.prayerToggleAttempts as number,
      prayerToggleCommits: record.prayerToggleCommits as number,
      prayerToggleRejects: record.prayerToggleRejects as number,
      lastPrayerToggleFailureReason: lastFailure as string | null,
    };
  });
}

async function currentHyperiaAuthorityEpoch(
  control: HarnessControl,
): Promise<number | null> {
  const healthUrl = control.services.hyperia?.authorityHealthUrl?.trim() || "";
  if (!healthUrl) {
    throw new Error("real Hyperia authority health URL is missing");
  }
  let response: Response;
  try {
    const bearerToken =
      process.env.E2E_HYPERIA_BET_SYNC_BEARER_TOKEN?.trim() || "";
    response = await fetch(healthUrl, {
      cache: "no-store",
      headers: {
        connection: "close",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return parseHyperiaAuthorityHealth(await response.json()).sourceEpoch ?? null;
}

type SignableTx = Transaction | VersionedTransaction;
type AnchorLikeWallet = Wallet & { payer: Keypair };
const ORDER_PRICE = 500;
const SOLANA_PREDICTION_AMOUNT = "0.05";
const SEEDED_LIQUIDITY_LAMPORTS = 60_000_000n;
const MIN_LIQUIDITY_MAKER_LAMPORTS = SEEDED_LIQUIDITY_LAMPORTS;
const MIN_BOOTSTRAP_AUTHORITY_LAMPORTS = 20_000_000n;
const MIN_STAGE_A_PRIVILEGED_RESERVE_LAMPORTS = 15_000_000n;
const SOLANA_LAMPORT_TOP_UP_CUSHION = 5_000_000n;
const MAX_MATCH_ACCOUNTS = 100;
const E2E_TRADER_SEED = Uint8Array.from([
  88, 41, 190, 12, 77, 164, 231, 5, 199, 118, 43, 91, 16, 220, 58, 147, 9, 175,
  63, 204, 132, 54, 241, 28, 115, 67, 154, 210, 36, 143, 80, 11,
]);
const ASK_LIQUIDITY_MAKER_SEED = Uint8Array.from([
  14, 22, 189, 71, 203, 44, 97, 156, 18, 240, 85, 132, 53, 199, 4, 220, 91, 11,
  144, 201, 32, 77, 165, 118, 246, 17, 63, 154, 208, 39, 121, 6,
]);
const BID_LIQUIDITY_MAKER_SEED = Uint8Array.from([
  101, 33, 174, 9, 57, 218, 66, 140, 211, 45, 87, 16, 193, 24, 129, 204, 73,
  188, 12, 240, 61, 109, 173, 28, 142, 215, 54, 167, 80, 31, 199, 114,
]);
const E2E_SOLANA_AGENT_A = {
  ...E2E_AGENT_A_IDENTITY,
  hp: 80,
  maxHp: 100,
  combatLevel: 88,
  wins: 12,
  losses: 4,
  damageDealtThisFight: 148,
  rank: 1,
  headToHeadWins: 3,
  headToHeadLosses: 2,
  inventory: [],
  monologues: [],
};
const E2E_SOLANA_AGENT_B = {
  ...E2E_AGENT_B_IDENTITY,
  hp: 76,
  maxHp: 100,
  combatLevel: 84,
  wins: 10,
  losses: 5,
  damageDealtThisFight: 131,
  rank: 2,
  headToHeadWins: 2,
  headToHeadLosses: 3,
  inventory: [],
  monologues: [],
};

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return httpUrl.replace(/^https:\/\//, "wss://");
  }
  if (httpUrl.startsWith("http://")) {
    return httpUrl.replace(/^http:\/\//, "ws://");
  }
  return httpUrl;
}

function resolveSolanaRpcWsUrl(rpcUrl: string, stateWsUrl?: string): string {
  return (
    stateWsUrl?.trim() ||
    process.env.SOLANA_ALCHEMY_WS_URL?.trim() ||
    process.env.ALCHEMY_SOLANA_WS_URL?.trim() ||
    process.env.SOLANA_RPC_WS_URL?.trim() ||
    process.env.SOLANA_WS_URL?.trim() ||
    process.env.ANCHOR_WS_URL?.trim() ||
    deriveWsUrl(rpcUrl)
  );
}

function createConfirmedConnection(
  rpcUrl: string,
  stateWsUrl?: string,
): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: resolveSolanaRpcWsUrl(rpcUrl, stateWsUrl),
  });
}

function loadKeypairFromPath(filepath: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(filepath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadBootstrapAuthority(state: E2eState): Keypair {
  const walletPath = state.bootstrapWalletPath?.trim() || "";
  if (!walletPath) {
    throw new Error("Missing bootstrapWalletPath in e2e state");
  }
  return loadKeypairFromPath(walletPath);
}

async function ensureStageASolanaRecipientLamportBuffer(
  connection: Connection,
  state: E2eState,
  recipient: PublicKey,
  minimumLamports: bigint,
): Promise<void> {
  const targetLamports = minimumLamports + SOLANA_LAMPORT_TOP_UP_CUSHION;
  let currentBalance = BigInt(
    await connection.getBalance(recipient, "confirmed"),
  );
  if (currentBalance >= targetLamports) {
    return;
  }

  const authority = loadBootstrapAuthority(state);
  const candidateEntries: Array<{
    label: string;
    signer: Keypair;
    reserveLamports: bigint;
  }> = [
    {
      label: "bootstrap-authority",
      signer: authority,
      reserveLamports: MIN_STAGE_A_PRIVILEGED_RESERVE_LAMPORTS,
    },
  ];
  const canaryPath = process.env.SOLANA_CANARY_KEYPAIR?.trim() || "";
  if (canaryPath && canaryPath !== state.bootstrapWalletPath?.trim()) {
    candidateEntries.push({
      label: "canary",
      signer: loadKeypairFromPath(canaryPath),
      reserveLamports: 100_000_000n,
    });
  }
  const marketMakerPath = process.env.MARKET_MAKER_KEYPAIR?.trim() || "";
  if (
    marketMakerPath &&
    marketMakerPath !== state.bootstrapWalletPath?.trim() &&
    marketMakerPath !== canaryPath
  ) {
    candidateEntries.push({
      label: "market-maker",
      signer: loadKeypairFromPath(marketMakerPath),
      reserveLamports: 10_000_000n,
    });
  }
  const oracleReporterPath = process.env.ORACLE_REPORTER_KEYPAIR?.trim() || "";
  if (
    oracleReporterPath &&
    oracleReporterPath !== state.bootstrapWalletPath?.trim() &&
    oracleReporterPath !== canaryPath &&
    oracleReporterPath !== marketMakerPath
  ) {
    candidateEntries.push({
      label: "oracle-reporter",
      signer: loadKeypairFromPath(oracleReporterPath),
      reserveLamports: 5_000_000n,
    });
  }
  candidateEntries.push({
    label: "seeded-ask-maker",
    signer: seededLiquidityMaker(SIDE_ASK),
    reserveLamports: MIN_LIQUIDITY_MAKER_LAMPORTS / 2n,
  });

  for (const candidate of candidateEntries) {
    if (currentBalance >= targetLamports) {
      break;
    }
    if (candidate.signer.publicKey.equals(recipient)) {
      continue;
    }
    const candidateBalance = BigInt(
      await connection.getBalance(candidate.signer.publicKey, "confirmed"),
    );
    const transferableLamports =
      candidateBalance > candidate.reserveLamports
        ? candidateBalance - candidate.reserveLamports
        : 0n;
    if (transferableLamports <= 0n) {
      continue;
    }
    const requiredLamports = targetLamports - currentBalance;
    const transferLamports =
      transferableLamports < requiredLamports
        ? transferableLamports
        : requiredLamports;
    const provider = createPollingProvider(connection, candidate.signer);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: candidate.signer.publicKey,
          toPubkey: recipient,
          lamports: Number(transferLamports),
        }),
      ),
      [],
    );
    currentBalance = BigInt(
      await connection.getBalance(recipient, "confirmed"),
    );
  }

  if (currentBalance < targetLamports) {
    throw new Error(
      `Stage-A recipient underfunded: recipient=${recipient.toBase58()} balance=${currentBalance.toString()} minimum=${minimumLamports.toString()} target=${targetLamports.toString()}`,
    );
  }
}

async function ensureBootstrapAuthorityLamportBuffer(
  connection: Connection,
  state: E2eState,
  minimumLamports = MIN_BOOTSTRAP_AUTHORITY_LAMPORTS,
): Promise<void> {
  const authority = loadBootstrapAuthority(state);
  await ensureStageASolanaRecipientLamportBuffer(
    connection,
    state,
    authority.publicKey,
    minimumLamports,
  );
}

function bnLikeToBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  return 0n;
}

function enumName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const [key] = Object.keys(value as Record<string, unknown>);
  return typeof key === "string" && key.length > 0 ? key : null;
}

function seededLiquidityMaker(side: number): Keypair {
  return Keypair.fromSeed(
    side === SIDE_ASK ? ASK_LIQUIDITY_MAKER_SEED : BID_LIQUIDITY_MAKER_SEED,
  );
}

function cloneTransaction(transaction: Transaction): Transaction {
  const clone = new Transaction();
  clone.instructions = [...transaction.instructions];
  clone.feePayer = transaction.feePayer;
  clone.nonceInfo = transaction.nonceInfo;
  clone.minNonceContextSlot = transaction.minNonceContextSlot;
  return clone;
}

async function sendAndConfirmWithPolling(
  provider: AnchorProvider,
  transaction: Transaction,
  signers: Array<Keypair> = [],
  options?: {
    commitment?: "processed" | "confirmed" | "finalized";
    preflightCommitment?: "processed" | "confirmed" | "finalized";
    skipPreflight?: boolean;
  },
): Promise<string> {
  const opts = {
    ...provider.opts,
    ...options,
  };
  const commitment = opts.preflightCommitment ?? opts.commitment ?? "confirmed";
  const tx = cloneTransaction(transaction);
  tx.feePayer = tx.feePayer ?? provider.wallet.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await provider.connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = blockhash;
  if (signers.length > 0) {
    tx.partialSign(...signers);
  }
  const signedTransaction = await provider.wallet.signTransaction(tx);
  const signature = await provider.connection.sendRawTransaction(
    signedTransaction.serialize(),
    {
      maxRetries: 8,
      preflightCommitment: commitment,
      skipPreflight: opts.skipPreflight ?? false,
    },
  );
  await confirmSignatureByPolling(
    provider.connection,
    signature,
    lastValidBlockHeight,
  );
  return signature;
}

function createPollingProvider(
  connection: Connection,
  keypair: Keypair,
): AnchorProvider {
  const provider = new AnchorProvider(connection, toWallet(keypair), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const defaultSendAndConfirm = provider.sendAndConfirm.bind(provider);
  provider.sendAndConfirm = async (tx, signers, options) => {
    if (tx instanceof VersionedTransaction) {
      return defaultSendAndConfirm(tx, signers, options);
    }
    return sendAndConfirmWithPolling(
      provider,
      tx,
      (signers ?? []) as Array<Keypair>,
      options,
    );
  };
  return provider;
}

async function fetchJson<T>(
  request: APIRequestContext,
  pathname: string,
): Promise<T> {
  const response = await request.get(`${GAME_API_URL}${pathname}`);
  expect(response.ok(), `GET ${pathname} should succeed`).toBeTruthy();
  return (await response.json()) as T;
}

async function postJson<T>(
  request: APIRequestContext,
  pathname: string,
  body: unknown,
): Promise<T> {
  const response = await request.post(`${GAME_API_URL}${pathname}`, {
    data: body,
    headers: E2E_ARENA_WRITE_KEY
      ? { "x-arena-write-key": E2E_ARENA_WRITE_KEY }
      : undefined,
  });
  expect(response.ok(), `POST ${pathname} should succeed`).toBeTruthy();
  return (await response.json()) as T;
}

async function fetchPredictionMarkets(
  request: APIRequestContext,
): Promise<PredictionMarketsResponse> {
  return fetchJson<PredictionMarketsResponse>(
    request,
    "/api/arena/prediction-markets/active",
  );
}

async function fetchBotHealth(
  request: APIRequestContext,
): Promise<KeeperBotHealthResponse> {
  const response = await request.get(`${GAME_API_URL}/api/keeper/bot-health`);
  return (await response.json()) as KeeperBotHealthResponse;
}

async function waitForKeeperBotHealth(
  request: APIRequestContext,
  chainKey: string,
  marketRef: string | null,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const payload = await fetchBotHealth(request);
          return {
            ready: payload.ok,
            running: payload.running,
            chainKey: payload.health?.chainKey ?? null,
            hasRecovery: Array.isArray(payload.health?.recovery),
            hasSnapshot: payload.health != null,
            recoveredMarket:
              marketRef == null ||
              Boolean(
                payload.health?.markets.some(
                  (market) =>
                    market.marketRef === marketRef &&
                    market.lifecycleStatus === "OPEN",
                ),
              ),
          };
        } catch {
          return {
            ready: false,
            running: false,
            chainKey: null,
            hasRecovery: false,
            hasSnapshot: false,
            recoveredMarket: false,
          };
        }
      },
      {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toEqual({
      ready: true,
      running: EXPECT_KEEPER_BOT,
      chainKey,
      hasRecovery: true,
      hasSnapshot: true,
      recoveredMarket: true,
    });
}

function findPredictionMarket(
  payload: PredictionMarketsResponse,
  chainKey: string,
) {
  return payload.markets.find((market) => market.chainKey === chainKey) ?? null;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmedSolanaTimestamp(
  connection: Connection,
  minimumUnixTimestamp: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastObservedTimestamp: number | null = null;
  while (Date.now() < deadline) {
    const slot = await connection.getSlot("confirmed");
    lastObservedTimestamp = await connection.getBlockTime(slot);
    if (
      lastObservedTimestamp != null &&
      lastObservedTimestamp >= minimumUnixTimestamp
    ) {
      return lastObservedTimestamp;
    }
    await sleepMs(250);
  }
  throw new Error(
    `Timed out waiting for confirmed Solana time >= ${minimumUnixTimestamp}; last observed ${lastObservedTimestamp ?? "unavailable"}`,
  );
}

function normalizePreparedSolanaDuelKey(
  duelKeyHex: string | undefined,
): string {
  const normalized = duelKeyHex?.trim().replace(/^0x/i, "").toLowerCase() || "";
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Missing or invalid currentDuelKeyHex in Solana e2e state`);
  }
  return normalized;
}

async function waitForPreparedRealSolanaOpenMarket(
  request: APIRequestContext,
  state: E2eState,
): Promise<{
  duelKey: number[];
  duelKeyHex: string;
  duelId: string;
  duelState: PublicKey;
  marketState: PublicKey;
  betOpenTs: number;
  betCloseTs: number;
  duelStartTs: number;
}> {
  if (E2E_DUEL_SOURCE !== "real_hyperia") {
    throw new Error(
      `Prepared Solana live market requires real_hyperia duel source, got ${E2E_DUEL_SOURCE}`,
    );
  }
  const duelId = (state.currentDuelId || "").trim();
  if (!duelId) {
    throw new Error("Missing currentDuelId in Solana e2e state");
  }
  const duelKeyHex = normalizePreparedSolanaDuelKey(state.currentDuelKeyHex);
  const duelState = new PublicKey(state.clobDuelState || "");
  const marketState = new PublicKey(state.clobMarketState || "");
  const betOpenTs =
    typeof state.currentBetOpenTimeMs === "number"
      ? Math.floor(state.currentBetOpenTimeMs / 1000)
      : Math.floor(Date.now() / 1000) - 60;
  const betCloseTs =
    typeof state.currentBetCloseTimeMs === "number"
      ? Math.floor(state.currentBetCloseTimeMs / 1000)
      : Math.floor(Date.now() / 1000) + 600;
  const duelStartTs =
    typeof state.currentFightStartTimeMs === "number"
      ? Math.floor(state.currentFightStartTimeMs / 1000)
      : betCloseTs + 60;
  const deadline = Date.now() + 180_000;
  let lastError = `prepared solana duel ${duelId} is not active yet`;

  while (Date.now() < deadline) {
    try {
      const predictionMarkets = await fetchPredictionMarkets(request);
      const solanaMarket = findPredictionMarket(predictionMarkets, "solana");
      if (!solanaMarket) {
        lastError =
          "active Solana market is missing from prediction-markets API";
        await sleepMs(1_000);
        continue;
      }
      if ((predictionMarkets.duel.duelId || "").trim() !== duelId) {
        lastError = `prepared Solana duel drifted to ${predictionMarkets.duel.duelId || "missing duel id"}`;
        await sleepMs(1_000);
        continue;
      }
      if (
        (predictionMarkets.duel.duelKey || "").trim().toLowerCase() !==
        duelKeyHex
      ) {
        lastError = `prepared Solana duel key drifted to ${predictionMarkets.duel.duelKey || "missing duel key"}`;
        await sleepMs(1_000);
        continue;
      }
      if ((solanaMarket.marketRef || "").trim() !== marketState.toBase58()) {
        lastError = `prepared Solana market drifted to ${solanaMarket.marketRef || "missing market ref"}`;
        await sleepMs(1_000);
        continue;
      }
      if (solanaMarket.lifecycleStatus !== "OPEN") {
        lastError = `prepared Solana market ${duelId} is ${solanaMarket.lifecycleStatus || "missing lifecycle"}`;
        await sleepMs(1_000);
        continue;
      }
      const betCloseTimeMs =
        typeof predictionMarkets.duel.betCloseTime === "number"
          ? predictionMarkets.duel.betCloseTime
          : (state.currentBetCloseTimeMs ?? null);
      if (
        betCloseTimeMs != null &&
        betCloseTimeMs - Date.now() < PREPARED_LIVE_DUEL_MIN_OPEN_WINDOW_MS
      ) {
        lastError = `prepared Solana duel ${duelId} has less than ${PREPARED_LIVE_DUEL_MIN_OPEN_WINDOW_MS}ms left in the betting window`;
        await sleepMs(1_000);
        continue;
      }
      return {
        duelKey: Array.from(Buffer.from(duelKeyHex, "hex")),
        duelKeyHex,
        duelId,
        duelState,
        marketState,
        betOpenTs,
        betCloseTs,
        duelStartTs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleepMs(1_000);
    }
  }

  throw new Error(
    `Timed out waiting for the prepared live Solana duel on the keeper API: ${lastError}`,
  );
}

async function retireSyntheticSolanaOpenMarkets(
  request: APIRequestContext,
  authority: Keypair,
  fightProgram: Program<Idl>,
  clobProgram: Program<Idl>,
): Promise<void> {
  assertSyntheticDuelSource("retireSyntheticSolanaOpenMarkets");
  const streamState = await fetchJson<StreamingStateResponse>(
    request,
    "/api/streaming/state",
  );
  const currentDuelKeyHex =
    streamState.cycle?.duelKeyHex?.trim().replace(/^0x/i, "").toLowerCase() ??
    null;
  const duelAccounts = (await fightProgram.account.duelState.all()) as Array<{
    publicKey: PublicKey;
    account: DuelStateAccountSnapshot;
  }>;
  const retired: Array<{
    duelKey: number[];
    duelKeyHex: string;
    betOpenTs: number;
    betCloseTs: number;
    duelStartTs: number;
    marketState: PublicKey | null;
  }> = [];

  for (const { publicKey: duelState, account } of duelAccounts) {
    const status = enumName(account.status);
    if (!status || !["scheduled", "bettingOpen", "locked"].includes(status)) {
      continue;
    }
    const duelKey = Array.from(account.duelKey ?? []);
    if (duelKey.length !== 32) {
      throw new Error(
        `Synthetic duel ${duelState.toBase58()} has an invalid on-chain key`,
      );
    }
    const duelKeyHex = Buffer.from(duelKey).toString("hex");
    const derivedDuelState = deriveDuelStatePda(
      fightProgram.programId,
      duelKey,
    );
    if (!derivedDuelState.equals(duelState)) {
      throw new Error(
        `Synthetic duel ${duelKeyHex} is not stored at its canonical PDA`,
      );
    }
    const marketState = deriveMarketStatePda(clobProgram.programId, duelState);
    const marketAccount =
      await clobProgram.account.marketState.fetchNullable(marketState);
    if (duelKeyHex !== currentDuelKeyHex) {
      await cancelDuel(
        fightProgram as never,
        authority,
        duelKey,
        canonicalDuelMetadata(
          `fixture-retired-${duelKeyHex.slice(0, 12)}`,
          duelKeyHex,
          "cancelled",
        ),
      );
      if (marketAccount) {
        await syncMarketFromDuel(clobProgram as never, marketState, duelState);
      }
    }
    retired.push({
      duelKey,
      duelKeyHex,
      betOpenTs: Number(bnLikeToBigInt(account.betOpenTs)),
      betCloseTs: Number(bnLikeToBigInt(account.betCloseTs)),
      duelStartTs: Number(bnLikeToBigInt(account.duelStartTs)),
      marketState: marketAccount ? marketState : null,
    });
  }

  const retiredCurrent = retired.find(
    (duel) => duel.duelKeyHex === currentDuelKeyHex,
  );
  if (retiredCurrent) {
    const duelId =
      streamState.cycle?.duelId != null
        ? String(streamState.cycle.duelId)
        : `fixture-retired-${retiredCurrent.duelKeyHex.slice(0, 12)}`;
    await publishSolanaCycleState(request, {
      cycleId:
        streamState.cycle?.cycleId?.trim() || `fixture-retired-${duelId}`,
      duelId,
      duelKeyHex: retiredCurrent.duelKeyHex,
      betOpenTs: retiredCurrent.betOpenTs,
      betCloseTs: retiredCurrent.betCloseTs,
      duelStartTs: retiredCurrent.duelStartTs,
      phase: "RESOLUTION",
      winner: "NONE",
      duelEndTs: await currentChainUnixTimestamp(
        fightProgram.provider.connection,
      ),
      cancellationReason: "fixture_cancelled",
    });
  }

  if (retired.length === 0) {
    return;
  }
  const retiredMarketRefs = new Set(
    retired
      .map((duel) => duel.marketState?.toBase58() ?? null)
      .filter((marketRef): marketRef is string => marketRef != null),
  );
  await expect
    .poll(
      async () => {
        const payload = await fetchBotHealth(request);
        const activeRetiredMarkets =
          payload.health?.markets.filter(
            (market) =>
              market.marketRef != null &&
              retiredMarketRefs.has(market.marketRef) &&
              !["CANCELLED", "RESOLVED"].includes(market.lifecycleStatus),
          ).length ?? retiredMarketRefs.size;
        const activeRecovery = payload.health?.recovery
          .filter((entry) => entry.active)
          .map((entry) => entry.code)
          .sort() ?? ["missing-health"];
        return {
          running: payload.running,
          activeRetiredMarkets,
          activeRecovery,
        };
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toEqual({
      running: EXPECT_KEEPER_BOT,
      activeRetiredMarkets: 0,
      activeRecovery: [],
    });
}

async function createFreshSolanaOpenMarket(
  request: APIRequestContext,
  state: E2eState,
  authority: Keypair,
  fightProgram: Program<Idl>,
  clobProgram: Program<Idl>,
  label: string,
  options?: {
    betCloseOffsetSeconds?: number;
    duelStartOffsetSeconds?: number;
  },
): Promise<{
  duelKey: number[];
  duelKeyHex: string;
  duelId: string;
  duelState: PublicKey;
  marketState: PublicKey;
  betOpenTs: number;
  betCloseTs: number;
  duelStartTs: number;
}> {
  if (E2E_DUEL_SOURCE === "real_hyperia") {
    return waitForPreparedRealSolanaOpenMarket(request, state);
  }
  await retireSyntheticSolanaOpenMarkets(
    request,
    authority,
    fightProgram,
    clobProgram,
  );
  const duelKey = uniqueDuelKey(label);
  const duelKeyHex = Buffer.from(duelKey).toString("hex");
  const duelId = `${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const betOpenTs = now - 60;
  const betCloseTs = now + (options?.betCloseOffsetSeconds ?? 600);
  const duelStartTs = Math.max(
    betCloseTs + 1,
    now + (options?.duelStartOffsetSeconds ?? 660),
  );
  const cycleId = `gate10-solana-${duelId}`;
  const competitiveCommitment = buildSyntheticDuelCommitment({
    cycleId,
    duelId,
    duelKeyHex,
    betOpenTs,
    betCloseTs,
    duelStartTs,
  });
  await ensureOracleReady(
    fightProgram as never,
    authority,
    authority.publicKey,
    authority.publicKey,
    authority.publicKey,
    60,
  );
  const duelState = await upsertDuel(
    fightProgram as never,
    authority,
    duelKey,
    {
      status: duelStatusBettingOpen(),
      betOpenTs,
      betCloseTs,
      duelStartTs,
      participantAHash: competitiveCommitment.participantAHash,
      participantBHash: competitiveCommitment.participantBHash,
      competitiveSnapshotVersion:
        competitiveCommitment.competitiveSnapshotVersion,
      competitiveSnapshotDigest:
        competitiveCommitment.competitiveSnapshotDigestBytes,
      metadataUri: canonicalDuelMetadata(duelId, duelKeyHex, "open"),
    },
  );
  const derivedMarketState = deriveMarketStatePda(
    clobProgram.programId,
    duelState,
  );
  let marketState: PublicKey;
  try {
    ({ marketState } = await initializeCanonicalMarket(
      clobProgram as never,
      authority,
      duelState,
      duelKey,
      new PublicKey(state.clobConfig || ""),
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already in use/i.test(message)) {
      throw error;
    }
    marketState = derivedMarketState;
  }
  await syncMarketFromDuel(clobProgram as never, marketState, duelState);
  await publishSolanaCycleState(request, {
    cycleId,
    duelId,
    duelKeyHex,
    betOpenTs,
    betCloseTs,
    duelStartTs,
    phase: "ANNOUNCEMENT",
    winner: "NONE",
  });
  await waitForKeeperBotHealth(request, "solana", marketState.toBase58());

  return {
    duelKey,
    duelKeyHex,
    duelId,
    duelState,
    marketState,
    betOpenTs,
    betCloseTs,
    duelStartTs,
  };
}

function canonicalDuelMetadata(
  duelId: string,
  duelKeyHex: string,
  lifecycleEvent: string,
): string {
  return JSON.stringify({
    duelId,
    duelKeyHex,
    lifecycleEvent,
    source: "hyperia-e2e",
  });
}

function buildMockSolanaPredictionMarketsResponse(
  state: E2eState,
  lifecycleStatus: string,
  winner: string,
): PredictionMarketsResponse {
  const duelKey = state.currentDuelKeyHex ?? null;
  const duelId = state.currentDuelId ?? null;
  const updatedAt = Date.now();
  const phase =
    lifecycleStatus === "OPEN"
      ? "ANNOUNCEMENT"
      : lifecycleStatus === "LOCKED"
        ? "COUNTDOWN"
        : "RESOLUTION";

  return {
    duel: {
      duelKey,
      duelId,
      phase,
      winner,
      betCloseTime: updatedAt,
      syncedAt: updatedAt,
    },
    markets: [
      {
        chainKey: "solana",
        duelKey,
        duelId,
        marketId: state.clobMarketState ?? null,
        marketRef: state.clobMarketState ?? null,
        lifecycleStatus,
        winner,
        betCloseTime: updatedAt,
        contractAddress: null,
        programId: duelMarketProgramId,
        txRef: null,
        syncedAt: updatedAt,
      },
    ],
    updatedAt,
  };
}

function canonicalDuelIdFromMetadata(
  metadata: unknown,
  duelKeyHex: string,
): string {
  const lifecycle = parseDuelLifecycleMetadata(metadata);
  if (lifecycle?.duelKeyHex === duelKeyHex) return lifecycle.duelId;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as Record<string, unknown>;
      const duelId =
        typeof parsed.duelId === "string" ? parsed.duelId.trim() : "";
      const metadataDuelKey =
        typeof parsed.duelKeyHex === "string"
          ? parsed.duelKeyHex.trim().replace(/^0x/i, "").toLowerCase()
          : "";
      if (duelId && metadataDuelKey === duelKeyHex) {
        return duelId;
      }
    } catch {
      // The explicit error below keeps fixture identity fail-closed.
    }
  }
  throw new Error(
    `Solana fixture ${duelKeyHex} is missing canonical duelId metadata`,
  );
}

function assertSyntheticDuelSource(action: string): void {
  if (E2E_DUEL_SOURCE === "synthetic_publish") {
    return;
  }
  throw new Error(
    `${action} requires synthetic_publish duel source, got ${E2E_DUEL_SOURCE}`,
  );
}

async function publishSolanaCycleState(
  request: APIRequestContext,
  args: {
    cycleId: string;
    duelId: string;
    duelKeyHex: string;
    betOpenTs: number;
    betCloseTs: number;
    duelStartTs: number;
    phase: SolanaCyclePhase;
    winner: "A" | "B" | "NONE";
    duelEndTs?: number | null;
    duelEndTimeMs?: number | null;
    outcome?: "win" | "draw" | "cancelled" | null;
    cancellationReason?: string | null;
  },
): Promise<void> {
  assertSyntheticDuelSource("publishSolanaCycleState");
  const nowMs = Date.now();
  if (args.duelEndTs != null && args.duelEndTimeMs != null) {
    throw new Error(
      `Synthetic terminal cycle ${args.cycleId} cannot supply two duel end timestamps`,
    );
  }
  const duelEndTimeMs =
    args.duelEndTimeMs ??
    (args.duelEndTs != null ? args.duelEndTs * 1_000 : null);
  if (
    args.phase === "RESOLUTION" &&
    (!Number.isSafeInteger(duelEndTimeMs) || Number(duelEndTimeMs) <= 0)
  ) {
    throw new Error(
      `Synthetic terminal cycle ${args.cycleId} requires a positive authoritative duel end timestamp`,
    );
  }
  const countdownSeconds =
    args.phase === "ANNOUNCEMENT"
      ? Math.max(0, args.betCloseTs - Math.floor(nowMs / 1000))
      : args.phase === "COUNTDOWN"
        ? Math.max(0, args.duelStartTs - Math.floor(nowMs / 1000))
        : 0;
  const isDraw = args.outcome === "draw";
  const competitiveSnapshot = buildSyntheticDuelCommitment({
    cycleId: args.cycleId,
    duelId: args.duelId,
    duelKeyHex: args.duelKeyHex,
    betOpenTs: args.betOpenTs,
    betCloseTs: args.betCloseTs,
    duelStartTs: args.duelStartTs,
    agent1: E2E_SOLANA_AGENT_A,
    agent2: E2E_SOLANA_AGENT_B,
  });
  const publicAgent1 = buildSyntheticPublicAgent(
    E2E_SOLANA_AGENT_A,
    competitiveSnapshot.competitiveSnapshot,
    "agent1",
  );
  const publicAgent2 = buildSyntheticPublicAgent(
    E2E_SOLANA_AGENT_B,
    competitiveSnapshot.competitiveSnapshot,
    "agent2",
  );
  const winnerAgent =
    args.winner === "A"
      ? publicAgent1
      : args.winner === "B"
        ? publicAgent2
        : null;

  await postJson<{ ok: boolean; seq: number }>(
    request,
    "/api/streaming/state/publish",
    {
      cycle: {
        cycleId: args.cycleId,
        phase: args.phase,
        duelId: args.duelId,
        duelKeyHex: args.duelKeyHex,
        cycleStartTime: nowMs - 90_000,
        phaseStartTime: nowMs - 5_000,
        phaseEndTime:
          args.phase === "RESOLUTION"
            ? nowMs + 5_000
            : (args.phase === "ANNOUNCEMENT"
                ? args.betCloseTs
                : args.duelStartTs) * 1000,
        betOpenTime: args.betOpenTs * 1000,
        betCloseTime: args.betCloseTs * 1000,
        fightStartTime:
          competitiveSnapshot.competitiveSnapshot.timing?.fightStartTime ??
          null,
        duelEndTime: duelEndTimeMs,
        competitiveSnapshotVersion:
          competitiveSnapshot.competitiveSnapshotVersion,
        competitiveSnapshotDigest:
          competitiveSnapshot.competitiveSnapshotDigest,
        competitiveSnapshot: competitiveSnapshot.competitiveSnapshot,
        countdown: countdownSeconds,
        timeRemaining: countdownSeconds * 1000,
        winnerId: winnerAgent?.id ?? null,
        winnerName: winnerAgent?.name ?? null,
        outcome:
          args.outcome !== undefined
            ? args.outcome
            : args.cancellationReason
              ? "cancelled"
              : winnerAgent
                ? "win"
                : null,
        cancellationReason: args.cancellationReason ?? (isDraw ? "draw" : null),
        winReason: winnerAgent ? "kill" : isDraw ? "draw" : null,
        seed: winnerAgent || isDraw ? "42" : null,
        replayHash: winnerAgent || isDraw ? "ab".repeat(32) : null,
        agent1: publicAgent1,
        agent2: publicAgent2,
        arenaPositions: {
          agent1: [-1, 0, 0],
          agent2: [1, 0, 0],
        },
        rendererHealth: buildSyntheticRendererHealth(nowMs),
      },
      leaderboard: [],
      cameraTarget: null,
    },
  );
}

function toWallet(keypair: Keypair): AnchorLikeWallet {
  const sign = <T extends SignableTx>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([keypair]);
    else tx.partialSign(keypair);
    return tx;
  };

  return {
    payer: keypair,
    publicKey: keypair.publicKey,
    signTransaction: async <T extends SignableTx>(tx: T): Promise<T> =>
      sign(tx),
    signAllTransactions: async <T extends SignableTx[]>(txs: T): Promise<T> => {
      txs.forEach((tx) => sign(tx));
      return txs;
    },
  };
}

async function readText(page: Page, testId: string): Promise<string> {
  const locator = page.getByTestId(testId).first();
  const count = await locator.count().catch(() => 0);
  if (count === 0) return "";
  return ((await locator.textContent().catch(() => "")) || "").trim();
}

function settlementEntriesForDuel(page: Page, duelId: string): Locator {
  return page.getByTestId("solana-settlement-entry").filter({
    has: page.getByTitle(duelId, { exact: true }),
  });
}

type SolanaOrderTrackingEvidence = {
  terminalStatus: 200;
  attempts: string[];
};

async function confirmSolanaOrder(
  page: Page,
): Promise<SolanaOrderTrackingEvidence> {
  for (let quoteAttempt = 0; quoteAttempt < 2; quoteAttempt += 1) {
    const confirmation = page.getByRole("dialog", {
      name: /confirm sol order/i,
    });
    await expect(confirmation).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("hidden");
    await expect
      .poll(() => page.evaluate(() => document.body.style.overscrollBehavior))
      .toBe("none");
    const confirmationViewportPolicy = await confirmation.evaluate(
      (element) => ({
        maxHeight: getComputedStyle(element).maxHeight,
        overscrollBehavior: getComputedStyle(element).overscrollBehavior,
        boxSizing: getComputedStyle(element).boxSizing,
      }),
    );
    expect(
      Number.parseFloat(confirmationViewportPolicy.maxHeight),
    ).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight - 32));
    expect(confirmationViewportPolicy.overscrollBehavior).toBe("contain");
    expect(confirmationViewportPolicy.boxSizing).toBe("border-box");
    const yesSelected =
      (await page
        .getByTestId("prediction-select-yes")
        .first()
        .getAttribute("aria-pressed")) === "true";
    const selectedSide = yesSelected ? "YES" : "NO";
    const selectedFighter = (
      (await page
        .getByTestId(
          yesSelected ? "prediction-select-yes" : "prediction-select-no",
        )
        .first()
        .locator("div")
        .first()
        .textContent()) ?? ""
    ).trim();
    expect(selectedFighter).not.toBe("");
    const grossPayoutInput = await page
      .getByTestId("prediction-amount-input")
      .first()
      .inputValue();
    const expectedGrossPayout = formatSolLamports(
      parseSolAmountToLamports(grossPayoutInput),
    );
    const confirmationSummary = confirmation.getByTestId(
      "solana-order-confirmation-summary",
    );
    await expect(confirmationSummary).toContainText(
      `Buy ${selectedFighter} (${selectedSide})`,
    );
    await expect(confirmationSummary).toContainText(
      `${expectedGrossPayout} SOL`,
    );
    await expect(confirmation).toContainText("Maximum wallet funding required");
    await expect(confirmation).toContainText("not automatically resubmitted");
    const confirmButton = confirmation.getByRole("button", {
      name: /confirm and sign/i,
    });
    const backButton = confirmation.getByRole("button", {
      name: /back to edit/i,
    });
    await expect(confirmButton).toBeEnabled();
    await expect(backButton).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirmButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(backButton).toBeFocused();

    const trackingAttempts: string[] = [];
    const pendingTrackingReads = new Set<Promise<void>>();
    let trackingResponse: Response | null = null;
    const recordTrackingAttempt = (response: Response): void => {
      if (!response.url().includes("/api/arena/bet/record-external")) return;
      if (response.status() !== 425 && response.status() !== 503) {
        trackingResponse ??= response;
      }
      const trackingRead = response
        .json()
        .then(
          (payload: {
            verificationCode?: unknown;
            verificationRpc?: unknown;
            verificationIndex?: unknown;
          }) => {
            const verificationCode =
              typeof payload.verificationCode === "string"
                ? payload.verificationCode
                : "none";
            const verificationRpc =
              typeof payload.verificationRpc === "string"
                ? payload.verificationRpc
                : "none";
            const verificationIndex =
              payload.verificationIndex &&
              typeof payload.verificationIndex === "object"
                ? JSON.stringify(payload.verificationIndex)
                : "none";
            trackingAttempts.push(
              `${response.status()}:${verificationCode}@${verificationRpc}#${verificationIndex}`,
            );
            if (trackingAttempts.length > 12) trackingAttempts.shift();
          },
        )
        .catch(() => {
          trackingAttempts.push(`${response.status()}:unreadable`);
          if (trackingAttempts.length > 12) trackingAttempts.shift();
        });
      pendingTrackingReads.add(trackingRead);
      void trackingRead.then(() => {
        pendingTrackingReads.delete(trackingRead);
      });
    };
    page.on("response", recordTrackingAttempt);

    try {
      await confirmButton.click();
      await expect(confirmation).toHaveCount(0, { timeout: 45_000 });
      const feedback = page
        .getByTestId("solana-order-transaction-feedback")
        .first();
      const readSubmissionOutcome = async (): Promise<string> => {
        const text = ((await feedback.textContent().catch(() => "")) || "")
          .trim()
          .replace(/\s+/g, " ");
        if (/Order confirmed on-chain/i.test(text)) return "confirmed";
        if (/order book or fee terms changed/i.test(text)) return "stale";
        const state = await feedback
          .getAttribute("data-state")
          .catch(() => null);
        return state === "error" && text ? `error:${text}` : "pending";
      };
      await expect
        .poll(readSubmissionOutcome, {
          timeout: 30_000,
          intervals: [100, 250, 500],
        })
        .not.toBe("pending");
      const submissionOutcome = await readSubmissionOutcome();
      if (submissionOutcome === "stale") {
        await expect(
          feedback.getByTestId("solana-order-transaction-signature"),
          "a stale quote must be rejected before signature or submission",
        ).toHaveCount(0);
      } else {
        if (submissionOutcome.startsWith("error:")) {
          throw new Error(submissionOutcome.slice("error:".length));
        }
        await expect(
          feedback.getByTestId("solana-order-transaction-signature"),
        ).toHaveText(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
        try {
          await expect
            .poll(() => trackingResponse?.status() ?? null, {
              timeout: 70_000,
              intervals: [100, 250, 500, 1_000],
            })
            .not.toBeNull();
        } catch (error) {
          throw new Error(
            `Timed out waiting for a terminal external-bet record response; recent attempts: ${trackingAttempts.join(", ") || "none"}`,
            { cause: error },
          );
        }
        const terminalResponse = trackingResponse;
        if (!terminalResponse) {
          throw new Error("External-bet tracking completed without a response");
        }
        await Promise.allSettled([...pendingTrackingReads]);
        const trackingPayload = (await terminalResponse.json()) as {
          ok?: unknown;
          error?: unknown;
        };
        const terminalTrackingResult = {
          status: terminalResponse.status(),
          ok: trackingPayload.ok ?? null,
          error: trackingPayload.error ?? null,
        };
        if (
          terminalTrackingResult.status !== 200 ||
          terminalTrackingResult.ok !== true ||
          terminalTrackingResult.error !== null
        ) {
          throw new Error(
            `External-bet tracking failed: ${JSON.stringify(terminalTrackingResult)}; recent attempts: ${trackingAttempts.join(", ") || "none"}`,
          );
        }
        return {
          terminalStatus: 200,
          attempts: [...trackingAttempts],
        };
      }
    } finally {
      page.off("response", recordTrackingAttempt);
    }

    if (quoteAttempt > 0) {
      throw new Error("The refreshed Solana order quote did not remain stable");
    }
    const feedback = page
      .getByTestId("solana-order-transaction-feedback")
      .first();
    await feedback
      .getByRole("button", { name: /review latest quote/i })
      .click();
    await expect(feedback).toHaveCount(0, { timeout: 30_000 });
    const submitButton = page.getByTestId("prediction-submit");
    await expect(submitButton).toBeEnabled({ timeout: 60_000 });
    await submitButton.click();
  }
  throw new Error("The Solana order did not reach a terminal tracking state");
}

async function openSolanaBuyOrderEntry(
  page: Page,
  clobPanel: Locator,
): Promise<void> {
  await expect(page.locator(".hm-root")).toHaveAttribute(
    "data-market-can-place-bet",
    "true",
    { timeout: 120_000 },
  );
  const buyTab = clobPanel.getByTestId("prediction-tab-buy");
  await expect(buyTab).toBeVisible({ timeout: 120_000 });
  await expect(buyTab).toBeEnabled();
  await buyTab.click();
}

async function selectSolanaPredictionSide(
  clobPanel: Locator,
  side: "yes" | "no",
): Promise<void> {
  const sideButton = clobPanel.getByTestId(`prediction-select-${side}`);
  await expect(sideButton).toBeVisible({ timeout: 120_000 });
  await expect(sideButton).toBeEnabled();
  await sideButton.click();
  await expect(sideButton).toHaveAttribute("aria-pressed", "true");
}

async function confirmSolanaManagedOrder(
  page: Page,
  input: {
    orderId: bigint;
    action: "CANCEL" | "RECLAIM" | "CLOSE_FILLED";
    outcomeText: string;
    remainingText: string;
    refundText?: string;
    rentText: string;
    grossCreditText: string;
    historyEntry?: Locator;
    auditDismissal?: boolean;
  },
): Promise<string> {
  const isCancellation = input.action === "CANCEL";
  const isFilledCleanup = input.action === "CLOSE_FILLED";
  let actionButton: Locator;
  if (input.historyEntry) {
    await expect(input.historyEntry).toBeVisible({ timeout: 30_000 });
    await expect(input.historyEntry).toContainText(
      `Order #${input.orderId.toString()}`,
    );
    actionButton = input.historyEntry.getByRole("button", {
      name: isFilledCleanup
        ? /recover order rent/i
        : isCancellation
          ? /manage open order/i
          : /reclaim resting order/i,
    });
  } else {
    const managedOrderCard = page.getByTestId(
      `solana-managed-order-${input.orderId.toString()}`,
    );
    await expect(managedOrderCard).toBeVisible({ timeout: 30_000 });
    await expect(managedOrderCard).toContainText(input.outcomeText);
    await expect(managedOrderCard).toContainText(input.remainingText);
    if (input.refundText) {
      await expect(managedOrderCard).toContainText(input.refundText);
    }
    await expect(managedOrderCard).toContainText(input.rentText);
    await expect(managedOrderCard).toContainText(input.grossCreditText);
    await expect(page.getByTestId("solana-managed-orders")).toContainText(
      "this Order account's rent return to the original maker",
    );
    await expect(page.getByTestId("solana-managed-orders")).toContainText(
      "shared PriceLevel rent is excluded",
    );

    const actionLabel = isCancellation
      ? `cancel order #${input.orderId}`
      : isFilledCleanup
        ? `recover filled-order rent #${input.orderId}`
        : `reclaim resting order #${input.orderId}`;
    actionButton = managedOrderCard.getByRole("button", {
      name: new RegExp(actionLabel, "i"),
    });
  }
  await expect(actionButton).toBeVisible();
  expect(
    await actionButton.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeGreaterThanOrEqual(44);
  await actionButton.click();

  const confirmation = page.getByRole("dialog", {
    name: isCancellation
      ? /confirm order cancellation/i
      : isFilledCleanup
        ? /confirm filled-order rent recovery/i
        : /confirm resting-order reclaim/i,
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(`#${input.orderId}`);
  await expect(confirmation).toContainText(input.outcomeText);
  await expect(confirmation).toContainText(input.remainingText);
  if (input.refundText) {
    await expect(confirmation).toContainText(input.refundText);
  }
  await expect(confirmation).toContainText(input.rentText);
  await expect(confirmation).toContainText(input.grossCreditText);
  await expect(confirmation).toContainText(
    "rent returns only to its original maker",
  );
  await expect(confirmation).toContainText(
    "shared PriceLevel rent is excluded",
  );
  const confirmButton = confirmation.getByRole("button", {
    name: isCancellation
      ? /confirm cancellation and sign/i
      : isFilledCleanup
        ? /confirm rent recovery and sign/i
        : /confirm reclaim and sign/i,
  });
  const backButton = confirmation.getByRole("button", {
    name: /back to orders/i,
  });
  await expect(backButton).toBeFocused();
  await expect(confirmButton).toBeInViewport({ ratio: 1 });
  await expect(backButton).toBeInViewport({ ratio: 1 });
  expect(
    await confirmButton.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await backButton.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeGreaterThanOrEqual(44);
  if (input.auditDismissal) {
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(actionButton).toBeFocused();
    await actionButton.click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(`#${input.orderId}`);
    await expect(backButton).toBeFocused();
  }
  await page.keyboard.press("Shift+Tab");
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(backButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirmButton).toBeFocused();
  await confirmButton.click();
  await expect(confirmation).toHaveCount(0, { timeout: 45_000 });

  const feedback = page
    .getByTestId("solana-managed-order-transaction-feedback")
    .first();
  await expect(feedback).toContainText(
    isCancellation
      ? "Order cancellation confirmed on-chain"
      : isFilledCleanup
        ? "Filled-order rent recovery confirmed on-chain"
        : "Resting-order reclaim confirmed on-chain",
    { timeout: 45_000 },
  );
  const signature = (
    (await feedback
      .getByTestId("solana-managed-order-transaction-signature")
      .textContent()) ?? ""
  ).trim();
  expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  return signature;
}

async function expectSolanaSettlementReceipt(
  page: Page,
  expectedLabel: RegExp,
): Promise<string> {
  const feedback = page
    .getByTestId("solana-settlement-transaction-feedback")
    .first();
  await expect(feedback).toContainText(expectedLabel, { timeout: 45_000 });
  const signatureLocator = feedback.getByTestId(
    "solana-settlement-transaction-signature",
  );
  await expect(signatureLocator).toHaveText(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  return ((await signatureLocator.textContent()) ?? "").trim();
}

async function gotoApp(
  page: Page,
  options: {
    e2eSolanaDuelKey?: string | null;
    e2eSolanaDuelId?: string | null;
    e2eSolanaMarketRef?: string | null;
    debug?: boolean;
  } = {},
): Promise<void> {
  const params = new URLSearchParams();
  if (options.debug !== false) {
    params.set("debug", "1");
  }
  if (options.e2eSolanaDuelKey) {
    params.set(
      "e2eSolanaDuelKey",
      options.e2eSolanaDuelKey.replace(/^0x/i, ""),
    );
  }
  if (options.e2eSolanaDuelId) {
    params.set("e2eSolanaDuelId", options.e2eSolanaDuelId);
  }
  if (options.e2eSolanaMarketRef) {
    params.set("e2eSolanaMarketRef", options.e2eSolanaMarketRef);
  }
  const appUrl = `/?${params.toString()}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    try {
      await expect
        .poll(
          async () => {
            const bodyText = (
              (await page
                .locator("body")
                .textContent()
                .catch(() => "")) || ""
            )
              .trim()
              .toUpperCase();
            if (
              bodyText.includes("HYPERIA DUEL ARENA") ||
              bodyText.includes("ULTRA SIMPLE FIGHT BET")
            ) {
              return bodyText;
            }
            return "";
          },
          {
            timeout: 20_000,
            intervals: [500, 1_000, 2_000, 5_000],
          },
        )
        .not.toBe("");

      const appRoot = page.locator(".hm-root").first();
      await expect(appRoot).toHaveAttribute(
        "data-stream-sync-mode",
        "program-date-time",
        { timeout: 45_000 },
      );
      await expect
        .poll(
          async () => {
            const video = page.locator("video").first();
            if ((await video.count()) === 0) return 0;
            return video.evaluate(
              (element) => (element as HTMLVideoElement).currentTime,
            );
          },
          { timeout: 45_000, intervals: [250, 500, 1_000, 2_000] },
        )
        .toBeGreaterThan(0);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.goto("about:blank");
    }
  }
}

async function ensureWalletConnected(page: Page): Promise<void> {
  const hasConnectedSolanaWallet = async (): Promise<boolean> => {
    const desktopWalletChip = page
      .getByRole("button", { name: /^SOL\s+[A-Za-z0-9].*/i })
      .first();
    if (await desktopWalletChip.isVisible().catch(() => false)) return true;

    const mobileWalletChip = page
      .getByRole("button", { name: /^◎\s*[A-Za-z0-9].*/i })
      .first();
    if (await mobileWalletChip.isVisible().catch(() => false)) return true;

    return false;
  };

  const selectHeadlessWallet = async (): Promise<boolean> => {
    const walletOption = page
      .getByRole("button", { name: /E2E Trader/i })
      .first();
    if (!(await walletOption.isVisible().catch(() => false))) return false;
    await walletOption.click();
    await expect(
      page.getByRole("dialog", {
        name: /Connect a wallet on Solana to continue/i,
      }),
    )
      .toBeHidden({ timeout: 30_000 })
      .catch(() => undefined);
    return true;
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await hasConnectedSolanaWallet()) return;

    if (await selectHeadlessWallet()) {
      await page.waitForTimeout(1_500);
      continue;
    }

    const connectButton = page
      .getByRole("button", {
        name: /connect wallet|select wallet|connect|add sol wallet|connect sol/i,
      })
      .first();
    if (await connectButton.isVisible().catch(() => false)) {
      await connectButton.click();
    }
    await selectHeadlessWallet();
    await page.waitForTimeout(1_500);
  }

  await expect.poll(hasConnectedSolanaWallet, { timeout: 60_000 }).toBe(true);
}

async function selectChain(_page: Page, _chain: "solana"): Promise<void> {
  // Solana is the only supported runtime for this package.
}

async function placeE2eTraderRestingOrder(
  connection: Connection,
  state: E2eState,
  input: {
    marketState: PublicKey;
    duelState: PublicKey;
    side: number;
    price: number;
    amount: bigint;
  },
): Promise<{
  orderId: bigint;
  orderAddress: PublicKey;
  priceLevel: PublicKey;
}> {
  const trader = Keypair.fromSeed(E2E_TRADER_SEED);
  if (trader.publicKey.toBase58() !== state.solanaTraderPublicKey) {
    throw new Error("E2E trader fixture does not match the connected wallet");
  }
  const provider = createPollingProvider(connection, trader);
  const clobProgram = new Program(duelMarketIdl, provider);
  const marketAccount = (await clobProgram.account.marketState.fetch(
    input.marketState,
  )) as MarketStateAccount;
  const orderId = bnLikeToBigInt(marketAccount.nextOrderId);
  if (orderId <= 0n)
    throw new Error("Missing next order id for trader fixture");
  const orderAddress = deriveOrderPda(
    clobProgram.programId,
    input.marketState,
    orderId,
  );
  const priceLevel = derivePriceLevelPda(
    clobProgram.programId,
    input.marketState,
    input.side,
    input.price,
  );
  const level = (await clobProgram.account.priceLevel.fetchNullable(
    priceLevel,
  )) as PriceLevelAccount | null;
  const tailOrderId = bnLikeToBigInt(level?.tailOrderId);
  const remainingAccounts: AccountMeta[] =
    tailOrderId > 0n
      ? [
          {
            pubkey: deriveOrderPda(
              clobProgram.programId,
              input.marketState,
              tailOrderId,
            ),
            isSigner: false,
            isWritable: true,
          },
        ]
      : [];

  await clobProgram.methods
    .placeOrder(
      new BN(orderId.toString()),
      input.side,
      input.price,
      new BN(input.amount.toString()),
      ORDER_BEHAVIOR_GTC,
    )
    .accountsPartial({
      marketState: input.marketState,
      duelState: input.duelState,
      userBalance: deriveUserBalancePda(
        clobProgram.programId,
        input.marketState,
        trader.publicKey,
      ),
      newOrder: orderAddress,
      restingLevel: priceLevel,
      config: new PublicKey(state.clobConfig || ""),
      treasury: new PublicKey(state.clobTreasury || ""),
      marketMaker: new PublicKey(state.clobMarketMaker || ""),
      vault: deriveClobVaultPda(clobProgram.programId, input.marketState),
      user: trader.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .signers([trader])
    .rpc();

  return { orderId, orderAddress, priceLevel };
}

async function seedClobLiquidity(
  connection: Connection,
  state: E2eState,
  side: number,
  overrides?: {
    marketState?: PublicKey;
    duelState?: PublicKey;
    vault?: PublicKey;
  },
): Promise<void> {
  const authority = loadBootstrapAuthority(state);
  const authorityProvider = createPollingProvider(connection, authority);
  const maker = seededLiquidityMaker(side);
  const provider = createPollingProvider(connection, maker);
  const clobProgram = new Program(duelMarketIdl, provider);
  const marketState =
    overrides?.marketState ?? new PublicKey(state.clobMarketState || "");
  const duelState =
    overrides?.duelState ?? new PublicKey(state.clobDuelState || "");
  const vault =
    overrides?.vault ?? deriveClobVaultPda(clobProgram.programId, marketState);
  const clobAccounts = clobProgram.account as Record<
    string,
    AccountNamespaceFetcher
  >;
  const hasExecutableLiquidity = (
    marketAccount: MarketStateAccount,
  ): boolean => {
    const bestBid = Number(marketAccount.bestBid ?? 0);
    const bestAsk = Number(marketAccount.bestAsk ?? 1000);
    if (side === SIDE_ASK) {
      return bestAsk > 0 && bestAsk <= ORDER_PRICE;
    }
    return bestBid >= ORDER_PRICE && bestBid < 1000;
  };

  const buildPlaceOrderRemainingAccounts = async (
    amount: bigint,
  ): Promise<AccountMeta[]> => {
    const metas: AccountMeta[] = [];
    const marketAccount = (await clobAccounts.marketState.fetch(
      marketState,
    )) as MarketStateAccount;
    const oppositeSide = side === SIDE_BID ? SIDE_ASK : SIDE_BID;
    let remaining = amount;
    let boundary =
      side === SIDE_BID
        ? Number(marketAccount.bestAsk ?? 1000)
        : Number(marketAccount.bestBid ?? 0);
    let matches = 0;

    while (remaining > 0n && matches < MAX_MATCH_ACCOUNTS) {
      const crosses =
        side === SIDE_BID
          ? boundary <= ORDER_PRICE && boundary > 0 && boundary < 1000
          : boundary >= ORDER_PRICE && boundary > 0 && boundary < 1000;
      if (!crosses) break;

      const levelPda = derivePriceLevelPda(
        clobProgram.programId,
        marketState,
        oppositeSide,
        boundary,
      );
      const level = (await clobProgram.account.priceLevel.fetchNullable(
        levelPda,
      )) as PriceLevelAccount | null;
      if (!level) break;

      metas.push({
        pubkey: levelPda,
        isSigner: false,
        isWritable: true,
      });

      const levelOpen = bnLikeToBigInt(level.totalOpen);
      let currentHead = bnLikeToBigInt(level.headOrderId);
      let currentLevelOpen = levelOpen;
      if (levelOpen === 0n || currentHead === 0n) {
        boundary = side === SIDE_BID ? boundary + 1 : boundary - 1;
        matches += 1;
        continue;
      }

      while (remaining > 0n && currentHead > 0n && currentLevelOpen > 0n) {
        const orderPda = deriveOrderPda(
          clobProgram.programId,
          marketState,
          currentHead,
        );
        const order = (await clobProgram.account.order.fetch(
          orderPda,
        )) as OrderAccount;
        const makerBalancePda = deriveUserBalancePda(
          clobProgram.programId,
          marketState,
          order.maker as PublicKey,
        );

        metas.push(
          {
            pubkey: orderPda,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: makerBalancePda,
            isSigner: false,
            isWritable: true,
          },
        );

        const orderRemaining =
          bnLikeToBigInt(order.amount) - bnLikeToBigInt(order.filled);
        if (orderRemaining <= 0n || !order.active) break;

        if (orderRemaining >= remaining) {
          remaining = 0n;
          break;
        }

        remaining -= orderRemaining;
        currentLevelOpen -= orderRemaining;
        currentHead = bnLikeToBigInt(order.nextOrderId);
        matches += 1;
        if (remaining > 0n && currentHead > 0n && currentLevelOpen > 0n) {
          metas.push({
            pubkey: levelPda,
            isSigner: false,
            isWritable: true,
          });
        }
      }

      boundary = side === SIDE_BID ? boundary + 1 : boundary - 1;
      matches += 1;
    }

    const restingLevelPda = derivePriceLevelPda(
      clobProgram.programId,
      marketState,
      side,
      ORDER_PRICE,
    );
    const restingLevel =
      await clobProgram.account.priceLevel.fetchNullable(restingLevelPda);
    if (restingLevel && bnLikeToBigInt(restingLevel.tailOrderId) > 0n) {
      metas.push({
        pubkey: deriveOrderPda(
          clobProgram.programId,
          marketState,
          bnLikeToBigInt(restingLevel.tailOrderId),
        ),
        isSigner: false,
        isWritable: true,
      });
    }

    return metas;
  };

  const maxPlacementAttempts = 8;
  for (let attempt = 0; attempt < maxPlacementAttempts; attempt += 1) {
    const marketAccount = (await clobAccounts.marketState.fetch(
      marketState,
    )) as MarketStateAccount;
    if (hasExecutableLiquidity(marketAccount)) {
      return;
    }

    const makerBalance = BigInt(
      await connection.getBalance(maker.publicKey, "confirmed"),
    );
    if (makerBalance < MIN_LIQUIDITY_MAKER_LAMPORTS) {
      const topUpLamports = MIN_LIQUIDITY_MAKER_LAMPORTS - makerBalance;
      await ensureBootstrapAuthorityLamportBuffer(
        connection,
        state,
        MIN_BOOTSTRAP_AUTHORITY_LAMPORTS + topUpLamports,
      );
      await authorityProvider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: authority.publicKey,
            toPubkey: maker.publicKey,
            lamports: Number(topUpLamports),
          }),
        ),
        [],
      );
    }

    const nextOrderId = bnLikeToBigInt(marketAccount.nextOrderId);
    if (nextOrderId <= 0n) {
      throw new Error("Missing next order id for seeded CLOB market");
    }

    const remainingAccounts = await buildPlaceOrderRemainingAccounts(
      SEEDED_LIQUIDITY_LAMPORTS,
    );

    try {
      await clobProgram.methods
        .placeOrder(
          new BN(nextOrderId.toString()),
          side,
          ORDER_PRICE,
          new BN(SEEDED_LIQUIDITY_LAMPORTS.toString()),
          ORDER_BEHAVIOR_GTC,
        )
        .accountsPartial({
          marketState,
          duelState,
          userBalance: deriveUserBalancePda(
            clobProgram.programId,
            marketState,
            maker.publicKey,
          ),
          newOrder: deriveOrderPda(
            clobProgram.programId,
            marketState,
            nextOrderId,
          ),
          restingLevel: derivePriceLevelPda(
            clobProgram.programId,
            marketState,
            side,
            ORDER_PRICE,
          ),
          config: new PublicKey(state.clobConfig || ""),
          treasury: new PublicKey(state.clobTreasury || ""),
          marketMaker: new PublicKey(state.clobMarketMaker || ""),
          vault,
          user: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(remainingAccounts)
        .signers([maker])
        .rpc();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === maxPlacementAttempts - 1 ||
        (!/MissingMatchAccounts|InvalidRemainingAccount|custom program error: 0x0|"Custom":0/i.test(
          message,
        ) &&
          !/Required maker match accounts were not supplied/i.test(message))
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      continue;
    }

    const refreshedMarketAccount = (await clobAccounts.marketState.fetch(
      marketState,
    )) as MarketStateAccount;
    if (hasExecutableLiquidity(refreshedMarketAccount)) {
      return;
    }
  }

  throw new Error(
    `Failed to seed executable ${side === SIDE_ASK ? "ask" : "bid"} liquidity`,
  );
}

async function loadMarketBalances(
  connection: Connection,
  state: E2eState,
  overrides?: {
    marketState?: PublicKey;
  },
): Promise<
  Array<{
    pubkey: string;
    user: string;
    aShares: string;
    bShares: string;
  }>
> {
  const walletPath = state.bootstrapWalletPath?.trim() || "";
  if (!walletPath) return [];
  const authority = loadBootstrapAuthority(state);
  const provider = createPollingProvider(connection, authority);
  const clobProgram = new Program(duelMarketIdl, provider);
  const marketState =
    overrides?.marketState ?? new PublicKey(state.clobMarketState || "");
  const balances = await clobProgram.account.userBalance.all();
  return balances
    .filter((entry) => entry.account.marketState.equals(marketState))
    .map((entry) => ({
      pubkey: entry.publicKey.toBase58(),
      user: entry.account.user.toBase58(),
      aShares: bnLikeToBigInt(entry.account.aShares).toString(),
      bShares: bnLikeToBigInt(entry.account.bShares).toString(),
    }));
}

function createReadonlyClobProgram(
  connection: Connection,
  state: E2eState,
): Program<Idl> {
  const authority = loadBootstrapAuthority(state);
  const provider = createPollingProvider(connection, authority);
  return new Program(duelMarketIdl, provider);
}

function createReadonlyFightProgram(
  connection: Connection,
  state: E2eState,
): Program<Idl> {
  const authority = loadBootstrapAuthority(state);
  const provider = createPollingProvider(connection, authority);
  return new Program(fightOracleIdl, provider);
}

async function createWritablePrograms(
  connection: Connection,
  state: E2eState,
): Promise<{
  authority: Keypair;
  fightProgram: Program<Idl>;
  clobProgram: Program<Idl>;
}> {
  await ensureBootstrapAuthorityLamportBuffer(connection, state);
  const authority = loadBootstrapAuthority(state);
  const provider = createPollingProvider(connection, authority);

  return {
    authority,
    fightProgram: new Program(fightOracleIdl, provider),
    clobProgram: new Program(duelMarketIdl, provider),
  };
}

async function listSolanaTraderFixtures(
  connection: Connection,
  state: E2eState,
): Promise<SolanaTraderFixture[]> {
  const trader = new PublicKey(state.solanaTraderPublicKey || "");
  const clobProgram = createReadonlyClobProgram(connection, state);
  const fightProgram = createReadonlyFightProgram(connection, state);
  const oracleConfigAccount = (await fightProgram.account.oracleConfig.fetch(
    deriveOracleConfigPda(fightProgram.programId),
  )) as {
    disputeWindowSecs?: unknown;
  };
  const disputeWindowSecs = Number(
    bnLikeToBigInt(oracleConfigAccount.disputeWindowSecs),
  );
  const fixtures: SolanaTraderFixture[] = [];

  for (const entry of await clobProgram.account.userBalance.all()) {
    if (!entry.account.user.equals(trader)) continue;
    const aShares = bnLikeToBigInt(entry.account.aShares);
    const bShares = bnLikeToBigInt(entry.account.bShares);
    const aLockedLamports = bnLikeToBigInt(entry.account.aLockedLamports);
    const bLockedLamports = bnLikeToBigInt(entry.account.bLockedLamports);
    if (
      aShares === 0n &&
      bShares === 0n &&
      aLockedLamports === 0n &&
      bLockedLamports === 0n
    ) {
      continue;
    }

    const marketState = (await clobProgram.account.marketState.fetch(
      entry.account.marketState,
    )) as {
      duelState: PublicKey;
      duelKey: readonly number[];
      status?: unknown;
      winner?: unknown;
    };
    const duelState = (await fightProgram.account.duelState.fetch(
      marketState.duelState,
    )) as {
      status?: unknown;
      pendingWinner?: unknown;
      pendingDuelEndTs?: unknown;
      pendingProposedAt?: unknown;
      betOpenTs?: unknown;
      betCloseTs?: unknown;
      duelStartTs?: unknown;
      duelEndTs?: unknown;
      metadataUri?: unknown;
    };
    const pendingProposedAt = Number(duelState.pendingProposedAt ?? 0);
    const finalizableAt =
      pendingProposedAt > 0
        ? pendingProposedAt + (disputeWindowSecs > 0 ? disputeWindowSecs : 3600)
        : null;

    const duelKeyHex = Buffer.from(marketState.duelKey).toString("hex");
    fixtures.push({
      userBalanceAddress: entry.publicKey,
      duelKey: [...marketState.duelKey],
      duelKeyHex,
      duelId: canonicalDuelIdFromMetadata(duelState.metadataUri, duelKeyHex),
      duelState: marketState.duelState,
      marketState: entry.account.marketState,
      marketStatus: enumName(marketState.status),
      marketWinner: enumName(marketState.winner),
      duelStatus: enumName(duelState.status),
      pendingWinner: enumName(duelState.pendingWinner),
      pendingDuelEndTs: Number(duelState.pendingDuelEndTs ?? 0),
      pendingProposedAt,
      finalizableAt,
      betOpenTs: Number(duelState.betOpenTs ?? 0),
      betCloseTs: Number(duelState.betCloseTs ?? 0),
      duelStartTs: Number(duelState.duelStartTs ?? 0),
      duelEndTs: Number(duelState.duelEndTs ?? 0),
      aShares,
      bShares,
      aLockedLamports,
      bLockedLamports,
    });
  }

  fixtures.sort((left, right) => {
    const leftTs = left.pendingProposedAt || left.betCloseTs || 0;
    const rightTs = right.pendingProposedAt || right.betCloseTs || 0;
    return leftTs - rightTs;
  });
  return fixtures;
}

async function fetchSolanaTraderFixtureByAddress(
  connection: Connection,
  state: E2eState,
  userBalanceAddress: PublicKey,
): Promise<SolanaTraderFixture | null> {
  const trader = new PublicKey(state.solanaTraderPublicKey || "");
  const clobProgram = createReadonlyClobProgram(connection, state);
  const fightProgram = createReadonlyFightProgram(connection, state);
  const oracleConfigAccount = (await fightProgram.account.oracleConfig.fetch(
    deriveOracleConfigPda(fightProgram.programId),
  )) as {
    disputeWindowSecs?: unknown;
  };
  const disputeWindowSecs = Number(
    bnLikeToBigInt(oracleConfigAccount.disputeWindowSecs),
  );
  const userBalanceAccount =
    (await clobProgram.account.userBalance.fetchNullable(
      userBalanceAddress,
    )) as
      | (UserBalanceAccount & {
          user: PublicKey;
          marketState: PublicKey;
        })
      | null;
  if (userBalanceAccount == null || !userBalanceAccount.user.equals(trader)) {
    return null;
  }

  const marketState = (await clobProgram.account.marketState.fetch(
    userBalanceAccount.marketState,
  )) as {
    duelState: PublicKey;
    duelKey: readonly number[];
    status?: unknown;
    winner?: unknown;
  };
  const duelState = (await fightProgram.account.duelState.fetch(
    marketState.duelState,
  )) as {
    status?: unknown;
    pendingWinner?: unknown;
    pendingDuelEndTs?: unknown;
    pendingProposedAt?: unknown;
    betOpenTs?: unknown;
    betCloseTs?: unknown;
    duelStartTs?: unknown;
    duelEndTs?: unknown;
    metadataUri?: unknown;
  };
  const pendingProposedAt = Number(duelState.pendingProposedAt ?? 0);
  const finalizableAt =
    pendingProposedAt > 0
      ? pendingProposedAt + (disputeWindowSecs > 0 ? disputeWindowSecs : 3600)
      : null;

  const duelKeyHex = Buffer.from(marketState.duelKey).toString("hex");
  return {
    userBalanceAddress,
    duelKey: [...marketState.duelKey],
    duelKeyHex,
    duelId: canonicalDuelIdFromMetadata(duelState.metadataUri, duelKeyHex),
    duelState: marketState.duelState,
    marketState: userBalanceAccount.marketState,
    marketStatus: enumName(marketState.status),
    marketWinner: enumName(marketState.winner),
    duelStatus: enumName(duelState.status),
    pendingWinner: enumName(duelState.pendingWinner),
    pendingDuelEndTs: Number(duelState.pendingDuelEndTs ?? 0),
    pendingProposedAt,
    finalizableAt,
    betOpenTs: Number(duelState.betOpenTs ?? 0),
    betCloseTs: Number(duelState.betCloseTs ?? 0),
    duelStartTs: Number(duelState.duelStartTs ?? 0),
    duelEndTs: Number(duelState.duelEndTs ?? 0),
    aShares: bnLikeToBigInt(userBalanceAccount.aShares),
    bShares: bnLikeToBigInt(userBalanceAccount.bShares),
    aLockedLamports: bnLikeToBigInt(userBalanceAccount.aLockedLamports),
    bLockedLamports: bnLikeToBigInt(userBalanceAccount.bLockedLamports),
  };
}

async function fetchPinnedSolanaFixture(
  connection: Connection,
  state: E2eState,
  userBalanceAddress: PublicKey,
): Promise<SolanaTraderFixture | null> {
  if (
    !state.currentDuelId ||
    !state.currentDuelKeyHex ||
    !state.clobMarketState ||
    !state.clobDuelState
  ) {
    return null;
  }
  const clobProgram = createReadonlyClobProgram(connection, state);
  const fightProgram = createReadonlyFightProgram(connection, state);
  const oracleConfigAccount = (await fightProgram.account.oracleConfig.fetch(
    deriveOracleConfigPda(fightProgram.programId),
  )) as {
    disputeWindowSecs?: unknown;
  };
  const disputeWindowSecs = Number(
    bnLikeToBigInt(oracleConfigAccount.disputeWindowSecs),
  );
  const marketStateAddress = new PublicKey(state.clobMarketState);
  const duelStateAddress = new PublicKey(state.clobDuelState);
  const marketState = (await clobProgram.account.marketState.fetch(
    marketStateAddress,
  )) as {
    duelState: PublicKey;
    duelKey: readonly number[];
    status?: unknown;
    winner?: unknown;
  };
  const duelState = (await fightProgram.account.duelState.fetch(
    duelStateAddress,
  )) as {
    status?: unknown;
    pendingWinner?: unknown;
    pendingDuelEndTs?: unknown;
    pendingProposedAt?: unknown;
    betOpenTs?: unknown;
    betCloseTs?: unknown;
    duelStartTs?: unknown;
    duelEndTs?: unknown;
  };
  const userBalanceAccount =
    (await clobProgram.account.userBalance.fetchNullable(
      userBalanceAddress,
    )) as UserBalanceAccount | null;
  const pendingProposedAt = Number(duelState.pendingProposedAt ?? 0);
  const finalizableAt =
    pendingProposedAt > 0
      ? pendingProposedAt + (disputeWindowSecs > 0 ? disputeWindowSecs : 3600)
      : null;

  return {
    userBalanceAddress,
    duelKey: [...marketState.duelKey],
    duelKeyHex: Buffer.from(marketState.duelKey).toString("hex"),
    duelId: state.currentDuelId,
    duelState: duelStateAddress,
    marketState: marketStateAddress,
    marketStatus: enumName(marketState.status),
    marketWinner: enumName(marketState.winner),
    duelStatus: enumName(duelState.status),
    pendingWinner: enumName(duelState.pendingWinner),
    pendingDuelEndTs: Number(duelState.pendingDuelEndTs ?? 0),
    pendingProposedAt,
    finalizableAt,
    betOpenTs: Number(duelState.betOpenTs ?? 0),
    betCloseTs: Number(duelState.betCloseTs ?? 0),
    duelStartTs: Number(duelState.duelStartTs ?? 0),
    duelEndTs: Number(duelState.duelEndTs ?? 0),
    aShares: bnLikeToBigInt(userBalanceAccount?.aShares),
    bShares: bnLikeToBigInt(userBalanceAccount?.bShares),
    aLockedLamports: bnLikeToBigInt(userBalanceAccount?.aLockedLamports),
    bLockedLamports: bnLikeToBigInt(userBalanceAccount?.bLockedLamports),
  };
}

async function findRecentSuccessfulSignatureByLog(
  connection: Connection,
  address: PublicKey,
  logSubstring: string,
): Promise<string | null> {
  const signatures = await connection.getSignaturesForAddress(
    address,
    { limit: 20 },
    "confirmed",
  );
  let fallback: string | null = null;
  for (const entry of signatures) {
    if (entry.err != null) {
      continue;
    }
    fallback ??= entry.signature;
    const tx = await connection.getParsedTransaction(entry.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    if (logs.some((log) => log.includes(logSubstring))) {
      return entry.signature;
    }
  }
  return fallback;
}

async function getWalletLamportDeltaFromSignature(
  connection: Connection,
  signature: string,
  wallet: PublicKey,
): Promise<bigint | null> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (tx?.meta == null) {
    return null;
  }
  const accountKeys = tx.transaction.message.accountKeys.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if ("pubkey" in entry) {
      const pubkey = entry.pubkey;
      return typeof pubkey === "string" ? pubkey : pubkey.toBase58();
    }
    return entry.toBase58();
  });
  const walletBase58 = wallet.toBase58();
  const accountIndex = accountKeys.findIndex((entry) => entry === walletBase58);
  if (accountIndex === -1) {
    return null;
  }
  return (
    BigInt(tx.meta.postBalances[accountIndex] ?? 0) -
    BigInt(tx.meta.preBalances[accountIndex] ?? 0)
  );
}

async function getTransactionFeeFromSignature(
  connection: Connection,
  signature: string,
): Promise<bigint | null> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta == null ? null : BigInt(tx.meta.fee);
}

test.describe("market flows", () => {
  test.setTimeout(600_000);

  test("schema-v4 sporting clock is identical across stream, oracle, market, and trade gate", async ({
    page,
    request,
  }) => {
    test.skip(
      E2E_DUEL_SOURCE !== "synthetic_publish",
      "the deterministic local commitment proof uses the synthetic Solana fixture",
    );
    const state = loadState();
    const duelId = state.currentDuelId || "";
    const duelKeyHex = state.currentDuelKeyHex || "";
    const betOpenTime = state.currentBetOpenTimeMs;
    const betCloseTime = state.currentBetCloseTimeMs;
    const fightStartTime = state.currentFightStartTimeMs;
    if (
      !duelId ||
      !/^[0-9a-f]{64}$/.test(duelKeyHex) ||
      !Number.isSafeInteger(betOpenTime) ||
      !Number.isSafeInteger(betCloseTime) ||
      !Number.isSafeInteger(fightStartTime)
    ) {
      throw new Error("local schema-v4 commitment state is incomplete");
    }

    const expected = buildSyntheticDuelCommitment({
      cycleId: E2E_INITIAL_CYCLE_ID,
      duelId,
      duelKeyHex,
      betOpenTs: Number(betOpenTime) / 1_000,
      betCloseTs: Number(betCloseTime) / 1_000,
      duelStartTs: Number(fightStartTime) / 1_000,
    });
    const stream = await fetchJson<StreamingStateResponse>(
      request,
      "/api/streaming/state",
    );
    expect(stream.cycle).toMatchObject({
      cycleId: E2E_INITIAL_CYCLE_ID,
      duelId,
      duelKeyHex,
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: expected.competitiveSnapshotDigest,
      betOpenTime,
      betCloseTime,
      fightStartTime,
      competitiveSnapshot: {
        snapshotVersion: 4,
        timing: expected.competitiveSnapshot.timing,
      },
    });

    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const fightProgram = createReadonlyFightProgram(connection, state);
    const duelStateAddress = new PublicKey(state.clobDuelState || "");
    const duelState = (await fightProgram.account.duelState.fetch(
      duelStateAddress,
    )) as DuelStateAccountSnapshot;
    expect(Number(duelState.competitiveSnapshotVersion)).toBe(4);
    expect(
      Buffer.from(duelState.competitiveSnapshotDigest ?? []).toString("hex"),
    ).toBe(expected.competitiveSnapshotDigest);
    expect(bnLikeToBigInt(duelState.betOpenTs)).toBe(
      BigInt(Number(betOpenTime) / 1_000),
    );
    expect(bnLikeToBigInt(duelState.betCloseTs)).toBe(
      BigInt(Number(betCloseTime) / 1_000),
    );
    expect(bnLikeToBigInt(duelState.duelStartTs)).toBe(
      BigInt(Number(fightStartTime) / 1_000),
    );

    const clobProgram = createReadonlyClobProgram(connection, state);
    const market = (await clobProgram.account.marketState.fetch(
      new PublicKey(state.clobMarketState || ""),
    )) as { duelState?: PublicKey; status?: unknown };
    expect(market.duelState?.toBase58()).toBe(duelStateAddress.toBase58());
    expect(enumName(market.status)).toBe("open");

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: state.clobMarketState || "",
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    await expect(page.locator(".hm-root")).toHaveAttribute(
      "data-market-competitive-disclosure",
      "verified",
      { timeout: 60_000 },
    );
    await expect(page.locator(".hm-root")).toHaveAttribute(
      "data-market-can-place-bet",
      "true",
      { timeout: 60_000 },
    );
  });

  test("solana lifecycle shell and claim CTA follow the normalized lifecycle API", async ({
    page,
  }) => {
    const state = loadState();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const duelKeyHex = state.currentDuelKeyHex || "";
    const duelId = state.currentDuelId || "";
    const marketState = new PublicKey(state.clobMarketState || "");
    const userBalanceAddress = new PublicKey(state.clobUserBalance || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    let lifecycleStatus = "OPEN";
    let lifecycleWinner = "NONE";

    await page.route(
      "**/api/arena/prediction-markets/active",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            buildMockSolanaPredictionMarketsResponse(
              state,
              lifecycleStatus,
              lifecycleWinner,
            ),
          ),
        });
      },
    );

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);

    await seedClobLiquidity(connection, state, SIDE_ASK);
    await page.getByTestId("refresh-market").click();

    const submitButton = page.getByTestId("prediction-submit");
    const claimButton = page.getByTestId("solana-clob-claim-payout");

    await expect(page.getByTestId("market-status")).toContainText(/open/i, {
      timeout: 30_000,
    });
    await expect(submitButton).toBeEnabled({ timeout: 30_000 });
    await expect(claimButton).toHaveCount(0);

    lifecycleStatus = "LOCKED";
    await page.getByTestId("refresh-market").click();
    await expect(page.getByTestId("market-status")).toContainText(/locked/i, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("solana-clob-panel").first()).toContainText(
      "Betting locked.",
      { timeout: 15_000 },
    );
    await expect(submitButton).toHaveCount(0);
    await expect(claimButton).toHaveCount(0);

    lifecycleStatus = "OPEN";
    await page.getByTestId("refresh-market").click();
    await expect(page.getByTestId("market-status")).toContainText(/open/i, {
      timeout: 15_000,
    });
    await expect(submitButton).toBeEnabled({ timeout: 15_000 });

    await page.getByTestId("prediction-amount-input").fill("999999999");
    await page.getByTestId("prediction-select-yes").click();
    const orderQuote = page.getByTestId("solana-order-quote");
    await expect(orderQuote).toContainText("Order details before signature");
    await expect(orderQuote).toContainText("Maximum locked collateral");
    await expect(orderQuote).toContainText("Execution fees");
    await expect(orderQuote).toContainText(
      "matched collateral and escrowed execution fees are refundable through claim",
    );
    await expect(orderQuote).toContainText(
      "Cancellation or reclaim separately returns unmatched collateral",
    );
    await expect(orderQuote).toContainText("Maximum wallet funding required");
    await expect(orderQuote).toContainText(
      "Wallet balance cannot cover the worst-case funding requirement",
    );
    await expect(submitButton).toBeDisabled({ timeout: 30_000 });

    await page
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await expect(orderQuote).not.toContainText(
      "Wallet balance cannot cover the worst-case funding requirement",
      { timeout: 30_000 },
    );
    await expect(submitButton).toBeEnabled({ timeout: 30_000 });

    await submitButton.click();
    const rejectedConfirmation = page.getByRole("dialog", {
      name: /confirm sol order/i,
    });
    await expect(rejectedConfirmation).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      window.sessionStorage.setItem(
        "hyperbet.e2e.reject-next-wallet-signature",
        "1",
      );
    });
    await rejectedConfirmation
      .getByRole("button", { name: /confirm and sign/i })
      .click();
    const rejectedFeedback = page.getByTestId(
      "solana-order-transaction-feedback",
    );
    await expect(rejectedFeedback).toContainText(
      "Your wallet declined the signature",
      { timeout: 30_000 },
    );
    await expect(
      page.getByTestId("solana-order-transaction-signature"),
    ).toHaveCount(0);
    await expect(submitButton).toBeDisabled();
    await rejectedFeedback
      .getByRole("button", { name: /review latest quote/i })
      .click();
    await expect(rejectedFeedback).toHaveCount(0, { timeout: 30_000 });
    await expect(submitButton).toBeEnabled({ timeout: 30_000 });

    const beforeBalance = (await clobProgram.account.userBalance.fetchNullable(
      userBalanceAddress,
    )) as UserBalanceAccount | null;
    const beforeYes = bnLikeToBigInt(beforeBalance?.aShares);
    let forwardedSignature = "";
    let interceptedSendCount = 0;
    const interruptSubmittedResponse = async (route: Route) => {
      const payload = route.request().postDataJSON() as {
        method?: unknown;
      } | null;
      if (payload?.method !== "sendTransaction") {
        await route.continue();
        return;
      }

      interceptedSendCount += 1;
      if (interceptedSendCount === 1) {
        const upstream = await route.fetch();
        const upstreamPayload = (await upstream.json()) as {
          result?: unknown;
        };
        forwardedSignature =
          typeof upstreamPayload.result === "string"
            ? upstreamPayload.result
            : "";
        if (!forwardedSignature) {
          throw new Error(
            "Fault-injected browser submission did not return a signature",
          );
        }
        await confirmSignatureByPolling(connection, forwardedSignature);
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "E2E response interrupted after send" }),
      });
    };
    await page.route("**/__solana/rpc", interruptSubmittedResponse);
    try {
      await submitButton.click();
      const confirmation = page.getByRole("dialog", {
        name: /confirm sol order/i,
      });
      await expect(confirmation).toBeVisible({ timeout: 15_000 });
      await confirmation
        .getByRole("button", { name: /confirm and sign/i })
        .click();

      const ambiguousFeedback = page.getByTestId(
        "solana-order-transaction-feedback",
      );
      await expect(ambiguousFeedback).toContainText(
        "network response was interrupted",
        { timeout: 30_000 },
      );
      await expect
        .poll(() => forwardedSignature, {
          timeout: 30_000,
          intervals: [100, 250, 500],
        })
        .toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
      await expect(
        page.getByTestId("solana-order-transaction-signature"),
      ).toHaveText(forwardedSignature);
      expect(interceptedSendCount).toBe(2);
      await expect(submitButton).toBeDisabled();

      await ambiguousFeedback
        .getByRole("button", { name: /check transaction status/i })
        .click();
      await expect(ambiguousFeedback).toContainText(
        "Order confirmed on-chain",
        {
          timeout: 60_000,
        },
      );
      await expect(ambiguousFeedback).toHaveAttribute(
        "data-state",
        "confirmed",
      );
      await expect(submitButton).toBeEnabled({ timeout: 60_000 });
    } finally {
      await page.unroute("**/__solana/rpc", interruptSubmittedResponse);
    }

    await expect
      .poll(async () => {
        const balance = (await clobProgram.account.userBalance.fetchNullable(
          userBalanceAddress,
        )) as UserBalanceAccount | null;
        return Number(bnLikeToBigInt(balance?.aShares) - beforeYes);
      })
      .toBeGreaterThan(0);

    lifecycleStatus = "RESOLVED";
    lifecycleWinner = "A";
    await page.getByTestId("refresh-market").click();
    await expect(page.getByTestId("market-status")).toContainText(/resolved/i, {
      timeout: 15_000,
    });
    await expect(claimButton).toBeEnabled({ timeout: 15_000 });
    await expect(claimButton).toContainText(/claim/i);
  });

  test("a cancelled-only bettor recovers exact empty-balance rent after the market closes", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      E2E_DUEL_SOURCE === "real_hyperia",
      "empty-balance rent recovery remains a synthetic Solana browser lane for now",
    );
    test.setTimeout(360_000);

    const state = loadState();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const {
      duelKey,
      duelKeyHex,
      duelId,
      duelState,
      marketState,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    } = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-empty-balance-rent",
      {
        betCloseOffsetSeconds: 120,
        duelStartOffsetSeconds: 120,
      },
    );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );
    const restingOrder = await placeE2eTraderRestingOrder(connection, state, {
      marketState,
      duelState,
      side: SIDE_BID,
      price: 1,
      amount: 50_000_000n,
    });
    const orderRentLamports = BigInt(
      await connection.getBalance(restingOrder.orderAddress, "confirmed"),
    );
    expect(orderRentLamports).toBeGreaterThan(0n);

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    await page.getByTestId("refresh-market").click();

    const expectedCollateralLamports = 50_000n;
    const cancelSignature = await confirmSolanaManagedOrder(page, {
      orderId: restingOrder.orderId,
      action: "CANCEL",
      outcomeText: "YES 0.1%",
      remainingText: "0.05",
      refundText: `${formatSolLamports(expectedCollateralLamports, 9)} SOL`,
      rentText: `${formatSolLamports(orderRentLamports, 9)} SOL`,
      grossCreditText: `${formatSolLamports(expectedCollateralLamports + orderRentLamports, 9)} SOL`,
    });
    await expect
      .poll(
        async () => {
          const [walletDelta, transactionFee] = await Promise.all([
            getWalletLamportDeltaFromSignature(
              connection,
              cancelSignature,
              trader,
            ),
            getTransactionFeeFromSignature(connection, cancelSignature),
          ]);
          return walletDelta == null || transactionFee == null
            ? null
            : (walletDelta + transactionFee).toString();
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe((expectedCollateralLamports + orderRentLamports).toString());

    const emptyBalance = (await clobProgram.account.userBalance.fetch(
      userBalanceAddress,
    )) as UserBalanceAccount;
    expect({
      aShares: bnLikeToBigInt(emptyBalance.aShares),
      bShares: bnLikeToBigInt(emptyBalance.bShares),
      aLockedLamports: bnLikeToBigInt(emptyBalance.aLockedLamports),
      bLockedLamports: bnLikeToBigInt(emptyBalance.bLockedLamports),
      tradeTreasuryFeeLamports: bnLikeToBigInt(
        emptyBalance.tradeTreasuryFeeLamports,
      ),
      tradeMarketMakerFeeLamports: bnLikeToBigInt(
        emptyBalance.tradeMarketMakerFeeLamports,
      ),
    }).toEqual({
      aShares: 0n,
      bShares: 0n,
      aLockedLamports: 0n,
      bLockedLamports: 0n,
      tradeTreasuryFeeLamports: 0n,
      tradeMarketMakerFeeLamports: 0n,
    });
    const balanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    expect(balanceRentLamports).toBeGreaterThan(0n);
    await page.getByTestId("refresh-market").click();
    await expect(
      page.getByTestId("solana-clob-recover-balance-rent"),
      "open markets must never expose balance closure while an order could still require that PDA",
    ).toHaveCount(0);

    await cancelDuel(
      fightProgram as never,
      authority,
      duelKey,
      canonicalDuelMetadata(duelId, duelKeyHex, "cancelled"),
    );
    await syncMarketFromDuel(
      writableClobProgram as never,
      marketState,
      duelState,
    );
    await publishSolanaCycleState(request, {
      cycleId: `gate10-solana-${duelId}`,
      duelId,
      duelKeyHex,
      betOpenTs,
      betCloseTs,
      duelStartTs,
      phase: "RESOLUTION",
      winner: "NONE",
      duelEndTs: await currentChainUnixTimestamp(connection),
      cancellationReason: COMPETITIVE_SNAPSHOT_RECOVERY_WINDOW_ELAPSED_REASON,
    });
    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          return (
            findPredictionMarket(predictionMarkets, "solana")
              ?.lifecycleStatus ?? "missing"
          );
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("CANCELLED");

    await page.getByTestId("refresh-market").click();
    const recoverRentButton = page.getByTestId(
      "solana-clob-recover-balance-rent",
    );
    await expect(recoverRentButton).toBeEnabled({ timeout: 30_000 });
    await expect(recoverRentButton).toContainText(/recover rent/i);
    expect(
      await recoverRentButton.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    await recoverRentButton.click();
    const recoverySignature = await expectSolanaSettlementReceipt(
      page,
      /account-rent recovery confirmed on-chain/i,
    );
    await expect
      .poll(
        async () => {
          const [walletDelta, transactionFee] = await Promise.all([
            getWalletLamportDeltaFromSignature(
              connection,
              recoverySignature,
              trader,
            ),
            getTransactionFeeFromSignature(connection, recoverySignature),
          ]);
          return walletDelta == null || transactionFee == null
            ? null
            : (walletDelta + transactionFee).toString();
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(balanceRentLamports.toString());
    expect(
      await clobProgram.account.userBalance.fetchNullable(userBalanceAddress),
    ).toBeNull();

    await testInfo.attach("solana-empty-balance-rent-evidence", {
      body: Buffer.from(
        JSON.stringify(
          {
            duelId,
            duelKeyHex,
            marketState: marketState.toBase58(),
            cancelSignature,
            recoverySignature,
            orderRentLamports: orderRentLamports.toString(),
            balanceRentLamports: balanceRentLamports.toString(),
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  });

  test("natural Hyperia combat drives public stream truth through SOL settlement and claim", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      E2E_DUEL_SOURCE !== "real_hyperia" || !REQUIRE_NATURAL_HYPERIA_TERMINAL,
      "the natural-terminal qualification requires the persisted real Hyperia source and its explicit acceptance mode",
    );
    test.setTimeout(600_000);

    const state = loadState();
    const control = loadControl();
    let preparationEvidence: Full3DPreparationEvidence | null = null;
    if (E2E_HYPERIA_RUNTIME === "full_3d") {
      expect(control.services.hyperia?.runtime).toBe("full_3d");
      expect(control.services.hyperia?.combatRole).toBe(HYPERIA_COMBAT_ROLE);
      expect(control.services.hyperia?.terminalExpectation).toBe(
        HYPERIA_TERMINAL_EXPECTATION,
      );
      expect(
        path.isAbsolute(
          control.services.hyperia?.rendererStatusPath?.trim() || "",
        ),
      ).toBe(true);
      expect(
        path.isAbsolute(
          control.services.hyperia?.captureStatusPath?.trim() || "",
        ),
      ).toBe(true);
      preparationEvidence = readFull3DPreparationEvidence(control);
      const preparationFrame = fs.readFileSync(
        preparationEvidence.hls.framePath,
      );
      expect({
        schemaVersion: preparationEvidence.schemaVersion,
        publicPhase: preparationEvidence.publicState.cycle?.phase,
        publicPreparationStatus:
          preparationEvidence.publicState.preparation?.status,
        privateStatus: preparationEvidence.privateAuthority.status,
        rendererPhase: preparationEvidence.rendererStatus.rendererHealth?.phase,
        rendererReady: preparationEvidence.rendererStatus.rendererHealth?.ready,
        frameDimensions: `${preparationEvidence.hls.width}x${preparationEvidence.hls.height}`,
        frameSha256: createHash("sha256")
          .update(preparationFrame)
          .digest("hex"),
        expectedFrameSha256: preparationEvidence.hls.frameSha256,
      }).toEqual({
        schemaVersion: 1,
        publicPhase: "IDLE",
        publicPreparationStatus: expect.stringMatching(/^(preparing|ready)$/),
        privateStatus: "ready",
        rendererPhase: "IDLE",
        rendererReady: true,
        frameDimensions: "1280x720",
        frameSha256: preparationEvidence.hls.frameSha256,
        expectedFrameSha256: preparationEvidence.hls.frameSha256,
      });
      expect(preparationEvidence.preparationCoverage.shots).toHaveLength(2);
      expect(
        preparationEvidence.preparationCoverage.shots.map((shot) => shot.slot),
      ).toEqual(["agent1", "agent2"]);
      for (const shot of preparationEvidence.preparationCoverage.shots) {
        const framing =
          shot.rendererStatus.rendererHealth?.diagnostics?.sceneReadiness;
        const directedFrame = fs.readFileSync(shot.frame.path);
        const expectedAgentId =
          shot.slot === "agent1"
            ? preparationEvidence.privateAuthority.agent1Id
            : preparationEvidence.privateAuthority.agent2Id;
        const isPairShot = framing?.preparationPairShotActive === true;
        if (isPairShot) {
          expect([
            preparationEvidence.privateAuthority.agent1Id,
            preparationEvidence.privateAuthority.agent2Id,
          ]).toContain(shot.publicState.cameraTarget);
          expect(["agent1", "agent2"]).toContain(framing?.cameraTargetSlot);
        } else {
          expect(shot.publicState.cameraTarget).toBe(expectedAgentId);
          expect(framing?.cameraTargetSlot).toBe(shot.slot);
        }
        expect({
          phase: shot.publicState.cycle?.phase,
          preparationStatus: shot.publicState.preparation?.status,
          rendererReady: shot.rendererStatus.rendererHealth?.ready,
          rendererPhase: shot.rendererStatus.rendererHealth?.phase,
          expectedAgentCount: framing?.expectedAgentCount,
          loadedExpectedAgentCount: framing?.loadedExpectedAgentCount,
          renderedAgentCount: framing?.renderedAgentCount,
          targetMatches: framing?.cameraTargetMatchesExpected,
          preparationActive: framing?.preparationActive,
          preparationShotActive: framing?.preparationShotActive,
          targetFullyFramed: framing?.fullyFramedAgentSlots?.includes(
            shot.slot,
          ),
          targetUnobstructed: framing?.unobstructedVisibleAgentSlots?.includes(
            shot.slot,
          ),
          croppedBodies: framing?.croppedVisibleAgentBodyCount,
          frameSource: shot.frame.source,
          frameDimensions: `${shot.frame.width}x${shot.frame.height}`,
          frameSha256: createHash("sha256").update(directedFrame).digest("hex"),
          expectedFrameSha256: shot.frame.sha256,
        }).toEqual({
          phase: "IDLE",
          preparationStatus: expect.stringMatching(/^(preparing|ready)$/),
          rendererReady: true,
          rendererPhase: "IDLE",
          expectedAgentCount: 2,
          loadedExpectedAgentCount: 2,
          renderedAgentCount: 2,
          targetMatches: true,
          preparationActive: true,
          preparationShotActive: true,
          targetFullyFramed: true,
          targetUnobstructed: true,
          croppedBodies: 0,
          frameSource: "capture_browser",
          frameDimensions: "1280x720",
          frameSha256: shot.frame.sha256,
          expectedFrameSha256: shot.frame.sha256,
        });
        expect(framing?.minimumVisibleAgentBodyNdcSpan).toBeGreaterThanOrEqual(
          0.55,
        );
        expect(framing?.maximumVisibleAgentBodyNdcSpan).toBeLessThanOrEqual(
          0.75,
        );
        if (framing?.preparationPairShotActive) {
          expect(framing.visibleAgentFramingCount).toBe(2);
          expect(framing.unobstructedVisibleAgentSlots).toEqual([
            "agent1",
            "agent2",
          ]);
          expect(framing.occludedVisibleAgentBodyCount).toBe(0);
          expect(framing.missingVisibleAgentLineOfSightCount).toBe(0);
          expect(
            framing.minimumVisibleAgentHorizontalNdcSeparation,
          ).toBeGreaterThanOrEqual(0.24);
        } else {
          expect(framing?.visibleAgentFramingCount).toBe(1);
          expect(
            framing?.minimumVisibleAgentHorizontalNdcSeparation,
          ).toBeNull();
        }
        await testInfo.attach(
          `natural-hyperia-3d-public-preparation-${shot.slot}`,
          {
            path: shot.frame.path,
            contentType: "image/png",
          },
        );
      }
      expect({
        bankOpenCount: preparationEvidence.privateAuthority.bankOpenCount,
        planOperationCount:
          preparationEvidence.privateAuthority.planOperationCount,
      }).toEqual({ bankOpenCount: 2, planOperationCount: 2 });
      const ordinaryPreparation = preparationEvidence.ordinaryPreparation;
      expect({
        schemaVersion: ordinaryPreparation.schemaVersion,
        status: ordinaryPreparation.status,
        multiStyle: ordinaryPreparation.multiStyle,
        availableCombatRoles: ordinaryPreparation.availableCombatRoles,
        agentCount: ordinaryPreparation.agents.length,
        gatheringOperations: ordinaryPreparation.totals.gatheringOperations,
        processingOperations: ordinaryPreparation.totals.processingOperations,
        ordinaryBankOperations:
          ordinaryPreparation.totals.ordinaryBankOperations,
        processDeathRecoveryCovered:
          ordinaryPreparation.processDeathRecoveryCovered,
        ordinaryAutonomySelectionCovered:
          ordinaryPreparation.ordinaryAutonomySelectionCovered,
        liveWorldNavigationCovered:
          ordinaryPreparation.liveWorldNavigationCovered,
        livePreparationPresentationCovered:
          ordinaryPreparation.livePreparationPresentationCovered,
        realPostgresqlCustodyCovered:
          ordinaryPreparation.realPostgresqlCustodyCovered,
        fullTopologySeedContractCovered:
          ordinaryPreparation.fullTopologySeedContractCovered,
        ownedMultiStylePreparationCovered:
          ordinaryPreparation.ownedMultiStylePreparationCovered,
        ordinaryForgingQuestCovered:
          ordinaryPreparation.ordinaryForgingQuestCovered,
        workerDatabaseSessionsDrained:
          ordinaryPreparation.workerDatabaseSessionsDrained,
        scriptedCustodyBridgeCovered:
          ordinaryPreparation.scriptedCustodyBridgeCovered,
      }).toEqual({
        schemaVersion: 3,
        status: "passed",
        multiStyle: HYPERIA_MULTI_STYLE,
        availableCombatRoles: HYPERIA_MULTI_STYLE
          ? ["melee", "ranged", "mage"]
          : [HYPERIA_COMBAT_ROLE],
        agentCount: 2,
        gatheringOperations: expect.any(Number),
        processingOperations: expect.any(Number),
        ordinaryBankOperations: 2,
        processDeathRecoveryCovered: true,
        ordinaryAutonomySelectionCovered: true,
        liveWorldNavigationCovered: true,
        livePreparationPresentationCovered: true,
        realPostgresqlCustodyCovered: true,
        fullTopologySeedContractCovered: true,
        ownedMultiStylePreparationCovered: HYPERIA_MULTI_STYLE,
        ordinaryForgingQuestCovered: HYPERIA_MULTI_STYLE,
        workerDatabaseSessionsDrained: true,
        scriptedCustodyBridgeCovered: false,
      });
      expect(
        ordinaryPreparation.workerDatabaseSessionDrainElapsedMs,
      ).toBeGreaterThanOrEqual(0);
      expect(
        ordinaryPreparation.workerDatabaseSessionDrainElapsedMs,
      ).toBeLessThanOrEqual(30_000);
      expect(ordinaryPreparation.remainingWorkerDatabaseSessionPids).toEqual(
        [],
      );
      expect(
        ordinaryPreparation.totals.gatheringOperations,
      ).toBeGreaterThanOrEqual(8);
      expect(
        ordinaryPreparation.totals.processingOperations,
      ).toBeGreaterThanOrEqual(8);
      expect(
        [...ordinaryPreparation.agents.map((agent) => agent.agentId)].sort(),
      ).toEqual(
        [
          preparationEvidence.privateAuthority.agent1Id,
          preparationEvidence.privateAuthority.agent2Id,
        ].sort(),
      );
      const frozenContestants =
        preparationEvidence.frozenBettingSource.competitiveSnapshot.contestants;
      expect(HYPERIA_COMBAT_ROLE).toMatch(/^(melee|ranged|mage)$/);
      const maxFightDurationMs =
        preparationEvidence.frozenBettingSource.competitiveSnapshot.timing
          ?.maxFightDurationMs;
      const combatFixture = resolveHyperiaCombatFixture(
        HYPERIA_COMBAT_ROLE as HyperiaCombatRole,
        maxFightDurationMs ?? Number.NaN,
      );
      for (const agent of ordinaryPreparation.agents) {
        expect(agent.cookedFood).toBeGreaterThanOrEqual(4);
        expect(agent.toolCount).toBe(1);
        expect(agent.gatheringOperations).toBeGreaterThanOrEqual(4);
        expect(agent.processingOperations).toBeGreaterThanOrEqual(4);
        expect(agent.ordinaryBankOperations).toBe(1);
        expect(agent.progressionStarts).toBe(agent.progressionTerminals);
        const contestant = frozenContestants.find(
          (candidate) => candidate.agentId === agent.agentId,
        );
        expect(contestant).toBeDefined();
        expect(contestant!.initialCombatStyle).toBe(HYPERIA_COMBAT_ROLE);
        expect(contestant!.availableCombatStyles).toContain(
          HYPERIA_COMBAT_ROLE,
        );
        expect(
          contestant!.equipment.find((item) => item.slot === "weapon"),
        ).toMatchObject({ itemId: combatFixture.weaponId, quantity: 1 });
        expect(contestant!.selectedSpell).toBe(combatFixture.selectedSpell);
        const ammunition = contestant!.equipment.find(
          (item) => item.slot === "arrows",
        );
        if (combatFixture.ammunition === null) {
          expect(ammunition).toBeUndefined();
        } else {
          expect(ammunition).toMatchObject(combatFixture.ammunition);
        }
        for (const supply of combatFixture.inventorySupplies) {
          expect(
            contestant!.inventory
              .filter((item) => item.itemId === supply.itemId)
              .reduce((total, item) => total + item.quantity, 0),
          ).toBe(supply.quantity);
        }
        const planOperation =
          preparationEvidence.privateAuthority.planOperations.find(
            (operation) => operation.agentId === agent.agentId,
          );
        expect(planOperation).toBeDefined();
        const frozenFood = contestant!.inventory
          .filter((item) => item.itemId === HYPERIA_PREPARATION_FOOD.itemId)
          .reduce((total, item) => total + item.quantity, 0);
        const bankedFood = planOperation!.committedBank
          .filter((item) => item.itemId === HYPERIA_PREPARATION_FOOD.itemId)
          .reduce((total, item) => total + item.quantity, 0);
        expect(frozenFood).toBe(
          Math.min(
            agent.cookedFood,
            resolveHyperiaFullHealthFoodReserve(
              contestant!.maxHp,
              HYPERIA_PREPARATION_FOOD.healAmount,
            ),
          ),
        );
        expect(frozenFood + bankedFood).toBe(agent.cookedFood);
        expect(
          contestant!.inventory.filter((item) =>
            [
              "lobster",
              "raw_shrimp",
              "burnt_shrimp",
              "small_fishing_net",
            ].includes(item.itemId),
          ),
        ).toEqual([]);
        // The live-world report is a quiescent point-in-time proof, not the
        // duel selection boundary. Persisted agents intentionally resume
        // ordinary play while the renderer/stream topology starts, so an
        // authoritative skill may advance before the later digest-backed
        // competitive snapshot is frozen. Require monotonic carry-forward;
        // the frozenAt/readyAt and announcement digest assertions below prove
        // the actual betting boundary remains immutable.
        expect(
          contestant!.skillLevels.find((skill) => skill.skill === "fishing")
            ?.level,
        ).toBeGreaterThanOrEqual(agent.fishingLevel);
        expect(
          contestant!.skillLevels.find((skill) => skill.skill === "cooking")
            ?.level,
        ).toBeGreaterThanOrEqual(agent.cookingLevel);
        expect(contestant!.preparation.planningSource).toBe("deterministic");
      }
      expect(ordinaryPreparation.liveWorldReports).toHaveLength(2);
      for (const [
        index,
        report,
      ] of ordinaryPreparation.liveWorldReports.entries()) {
        expect(path.isAbsolute(report.path)).toBe(true);
        const reportBytes = fs.readFileSync(report.path);
        expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(
          report.sha256,
        );
        expect({
          status: report.preparationVerticalSlice.status,
          exactFinalCustodyAndXp:
            report.preparationVerticalSlice.exactFinalCustodyAndXp,
          quiescent: report.preparationVerticalSlice.quiescent,
          diagonalStep: report.preparationVerticalSlice.movement?.diagonalStep,
          forcedBurnObserved:
            report.preparationVerticalSlice.cooking?.forcedBurnObserved,
          processingRejections:
            report.preparationVerticalSlice.presentation?.processingRejections,
        }).toEqual({
          status: "passed",
          exactFinalCustodyAndXp: true,
          quiescent: true,
          diagonalStep: true,
          forcedBurnObserved: true,
          processingRejections: 0,
        });
        await testInfo.attach(
          `natural-hyperia-ordinary-preparation-live-world-${index + 1}`,
          { path: report.path, contentType: "application/json" },
        );
      }
      for (const agentId of [
        preparationEvidence.privateAuthority.agent1Id,
        preparationEvidence.privateAuthority.agent2Id,
      ]) {
        const activities = preparationEvidence.privateAuthority.activityRows
          .filter((row) => row.agentId === agentId)
          .map((row) => row.activity);
        expect(activities).toContain("planning");
        expect(activities).toContain("provisioning");
      }
      expect([
        preparationEvidence.privateAuthority.agent1Id,
        preparationEvidence.privateAuthority.agent2Id,
      ]).toContain(preparationEvidence.publicState.cameraTarget);
      expect(
        JSON.stringify(preparationEvidence.publicState.preparation),
      ).not.toContain(preparationEvidence.privateAuthority.preparationId);
      await testInfo.attach("natural-hyperia-3d-public-preparation-evidence", {
        path: control.services.hyperia!.preparationEvidencePath!,
        contentType: "application/json",
      });
      await testInfo.attach(
        "natural-hyperia-3d-public-preparation-hls-decoded-frame",
        {
          path: preparationEvidence.hls.framePath,
          contentType: "image/png",
        },
      );
    }
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const duelId = state.currentDuelId || "";
    const duelKeyHex = state.currentDuelKeyHex || "";
    const duelState = new PublicKey(state.clobDuelState || "");
    const marketState = new PublicKey(state.clobMarketState || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );
    let hlsPlaybackEvidence: {
      source: string;
      videoWidth: number;
      videoHeight: number;
      firstCurrentTime: number;
      secondCurrentTime: number;
      firstTotalVideoFrames: number;
      secondTotalVideoFrames: number;
    } | null = null;
    let postTerminalPresentationEvidence: {
      mode: "same_cycle_resolution" | "advanced_cycle_with_historical_claim";
      pinnedDuelId: string;
      presentedStreamDuelId: string;
      historicalActivityCount: number;
      marketCanPlaceBet: boolean;
      playbackAdvanceSeconds: number | null;
      playbackFrameAdvance: number | null;
    };
    let terminalVisualEvidence: {
      capturedAt: number;
      videoWidth: number;
      videoHeight: number;
      videoCurrentTime: number;
      totalVideoFrames: number;
      streamScreenshot: string;
      streamScreenshotSha256: string;
      pageScreenshot: string;
      pageScreenshotSha256: string;
    } | null = null;

    const announced = await fetchHyperiaStreamingState(request, control);
    expect({
      type: announced.type,
      duelId: announced.cycle?.duelId,
      duelKeyHex: announced.cycle?.duelKeyHex,
      phase: announced.cycle?.phase,
      digest: announced.cycle?.competitiveSnapshotDigest,
    }).toEqual({
      type: "STREAMING_STATE_UPDATE",
      duelId,
      duelKeyHex,
      phase: "ANNOUNCEMENT",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const snapshotDigest = announced.cycle?.competitiveSnapshotDigest || "";
    const agent1Id = announced.cycle?.agent1?.id || "";
    const agent2Id = announced.cycle?.agent2?.id || "";
    const agent1Name = announced.cycle?.agent1?.name?.trim() || "";
    const agent2Name = announced.cycle?.agent2?.name?.trim() || "";
    const cycleId = announced.cycle?.cycleId || "";
    expect(agent1Id).not.toBe("");
    expect(agent2Id).not.toBe("");
    expect(agent1Id).not.toBe(agent2Id);
    expect(agent1Name).not.toBe("");
    expect(agent2Name).not.toBe("");
    expect(cycleId).not.toBe("");
    const actionObservationsBySequence = new Map<
      number,
      HyperiaDuelActionObservation
    >();
    const capturedVisualRoles = new Set<"melee" | "ranged" | "mage">();
    const roleSwitchVisualEvidence: Array<{
      sequence: number;
      observedAt: number;
      capturedAt: number;
      actorId: string;
      actorName: string;
      fromRole: "melee" | "ranged" | "mage";
      toRole: "melee" | "ranged" | "mage";
      postSwitchCombatSequence: number;
      postSwitchCombatAction: "engagement" | "damage";
      feedText: string;
      videoWidth: number;
      videoHeight: number;
      videoCurrentTime: number;
      totalVideoFrames: number;
      streamScreenshot: string;
      streamScreenshotSha256: string;
      pageScreenshot: string;
      pageScreenshotSha256: string;
    }> = [];
    const captureActionObservations = (state: HyperiaStreamingState): void => {
      for (const observation of state.cycle?.actionObservations ?? []) {
        expect({
          schemaVersion: observation.schemaVersion,
          phase: observation.phase,
          cycleId: observation.cycleId,
          duelId: observation.duelId,
          actorKnown: [agent1Id, agent2Id].includes(observation.actorId),
          opponentKnown: [agent1Id, agent2Id].includes(observation.opponentId),
          selfTargeted: observation.actorId === observation.opponentId,
          sequence: observation.sequence,
          tick: observation.tick,
          observedAt: observation.observedAt,
        }).toEqual({
          schemaVersion: 1,
          phase: "FIGHTING",
          cycleId,
          duelId,
          actorKnown: true,
          opponentKnown: true,
          selfTargeted: false,
          sequence: expect.any(Number),
          tick: expect.any(Number),
          observedAt: expect.any(Number),
        });
        expect(Number.isSafeInteger(observation.sequence)).toBe(true);
        expect(observation.sequence).toBeGreaterThan(0);
        expect(Number.isSafeInteger(observation.tick)).toBe(true);
        expect(observation.tick).toBeGreaterThan(0);
        expect(Number.isSafeInteger(observation.observedAt)).toBe(true);
        expect(observation.observedAt).toBeGreaterThan(0);
        const prior = actionObservationsBySequence.get(observation.sequence);
        if (prior) {
          expect(observation).toEqual(prior);
        } else {
          actionObservationsBySequence.set(observation.sequence, observation);
        }
      }
    };
    const captureRoleSwitchVisualEvidence = async (
      state: HyperiaStreamingState,
    ): Promise<void> => {
      if (!HYPERIA_MULTI_STYLE || E2E_HYPERIA_RUNTIME !== "full_3d") return;
      const observations = [...(state.cycle?.actionObservations ?? [])].sort(
        (left, right) => left.sequence - right.sequence,
      );
      const candidate = observations
        .filter(
          (observation) =>
            observation.action === "role_switch" &&
            observation.outcome === "committed" &&
            /^(melee|ranged|mage)$/.test(observation.value) &&
            !capturedVisualRoles.has(
              observation.value as "melee" | "ranged" | "mage",
            ),
        )
        .map((roleSwitch) => ({
          roleSwitch,
          postSwitchCombat: observations.find(
            (observation) =>
              observation.actorId === roleSwitch.actorId &&
              observation.sequence > roleSwitch.sequence &&
              observation.combatRole === roleSwitch.value &&
              ((observation.action === "engagement" &&
                observation.outcome === "accepted") ||
                (observation.action === "damage" &&
                  observation.outcome === "committed" &&
                  (observation.amount ?? 0) > 0)),
          ),
        }))
        .find(({ postSwitchCombat }) => postSwitchCombat !== undefined);
      if (!candidate?.postSwitchCombat) return;

      const observation = candidate.roleSwitch;
      const postSwitchCombat = candidate.postSwitchCombat;

      const toRole = observation.value as "melee" | "ranged" | "mage";
      const actorName =
        observation.actorId === agent1Id ? agent1Name : agent2Name;
      const feedText = `${actorName} switches to ${toRole}.`;
      const actionFeed = page.getByTestId("spectator-combat-action-feed");
      await expect(actionFeed).toContainText(feedText, { timeout: 15_000 });

      // The decision feed and HLS are both public delayed surfaces. Give the
      // next decoded video frame enough time to carry the committed equipment
      // state, then retain both the clean stream pixels and their surrounding
      // spectator context for direct product review.
      await page.waitForTimeout(1_250);
      await expect(actionFeed).toContainText(feedText, { timeout: 5_000 });
      const video = page.locator("video[data-stream-source]").first();
      await expect(video).toBeVisible();
      const playback = await video.evaluate((element: HTMLVideoElement) => ({
        videoWidth: element.videoWidth,
        videoHeight: element.videoHeight,
        currentTime: element.currentTime,
        totalVideoFrames:
          typeof element.getVideoPlaybackQuality === "function"
            ? element.getVideoPlaybackQuality().totalVideoFrames
            : 0,
      }));
      expect(playback.videoWidth).toBe(1280);
      expect(playback.videoHeight).toBe(720);
      expect(playback.currentTime).toBeGreaterThan(0);
      expect(playback.totalVideoFrames).toBeGreaterThan(0);

      const prefix = `natural-hyperia-role-switch-${toRole}-seq-${observation.sequence}`;
      const streamScreenshotPath = testInfo.outputPath(`${prefix}-stream.png`);
      const pageScreenshotPath = testInfo.outputPath(`${prefix}-page.png`);
      const nativeStreamFrame = await video.evaluate(
        (element: HTMLVideoElement) => {
          const canvas = document.createElement("canvas");
          canvas.width = element.videoWidth;
          canvas.height = element.videoHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("2D canvas context is unavailable");
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png");
        },
      );
      expect(nativeStreamFrame).toMatch(/^data:image\/png;base64,/);
      const nativeStreamFrameBytes = Buffer.from(
        nativeStreamFrame.replace(/^data:image\/png;base64,/, ""),
        "base64",
      );
      expect(nativeStreamFrameBytes.length).toBeGreaterThan(1_000);
      fs.writeFileSync(streamScreenshotPath, nativeStreamFrameBytes, {
        flag: "wx",
        mode: 0o600,
      });
      await page.screenshot({
        path: pageScreenshotPath,
        fullPage: true,
        animations: "disabled",
        style: '[data-testid="e2e-debug-panel"] { display: none !important; }',
      });
      fs.chmodSync(streamScreenshotPath, 0o600);
      fs.chmodSync(pageScreenshotPath, 0o600);
      const streamScreenshotSha256 = createHash("sha256")
        .update(fs.readFileSync(streamScreenshotPath))
        .digest("hex");
      const pageScreenshotSha256 = createHash("sha256")
        .update(fs.readFileSync(pageScreenshotPath))
        .digest("hex");
      await testInfo.attach(`${prefix}-stream`, {
        path: streamScreenshotPath,
        contentType: "image/png",
      });
      await testInfo.attach(`${prefix}-page`, {
        path: pageScreenshotPath,
        contentType: "image/png",
      });
      capturedVisualRoles.add(toRole);
      roleSwitchVisualEvidence.push({
        sequence: observation.sequence,
        observedAt: observation.observedAt,
        capturedAt: Date.now(),
        actorId: observation.actorId,
        actorName,
        fromRole: observation.combatRole,
        toRole,
        postSwitchCombatSequence: postSwitchCombat.sequence,
        postSwitchCombatAction: postSwitchCombat.action as
          "engagement" | "damage",
        feedText,
        videoWidth: playback.videoWidth,
        videoHeight: playback.videoHeight,
        videoCurrentTime: playback.currentTime,
        totalVideoFrames: playback.totalVideoFrames,
        streamScreenshot: path.basename(streamScreenshotPath),
        streamScreenshotSha256,
        pageScreenshot: path.basename(pageScreenshotPath),
        pageScreenshotSha256,
      });
    };
    captureActionObservations(announced);
    const committedTiming =
      preparationEvidence?.frozenBettingSource.competitiveSnapshot.timing ??
      null;
    if (EXPECT_EXACT_HYPERIA_TIMEOUT || EXPECT_SHORT_HYPERIA_KILL) {
      expect(committedTiming).toMatchObject({
        contractVersion: 2,
        timeoutPolicy: "hp_percentage_then_damage_then_draw_v1",
        fightingDurationMs: 150_000,
        endWarningDurationMs: 10_000,
        maxFightDurationMs: 160_000,
        fightStartTime: expect.any(Number),
        fightDeadline: expect.any(Number),
      });
      expect(committedTiming!.fightDeadline).toBe(
        committedTiming!.fightStartTime! + committedTiming!.maxFightDurationMs!,
      );
    }
    if (preparationEvidence) {
      const frozenBettingSource = preparationEvidence.frozenBettingSource;
      expect({
        duelId: frozenBettingSource.duelId,
        duelKey: frozenBettingSource.duelKey,
        digest: frozenBettingSource.competitiveSnapshotDigest,
        preparationId: frozenBettingSource.competitiveSnapshot.preparationId,
        persisted: frozenBettingSource.competitiveSnapshot.persisted,
        diagnostic: frozenBettingSource.competitiveSnapshot.diagnostic,
        frozenAt: frozenBettingSource.competitiveSnapshot.frozenAt,
        contestantIds: frozenBettingSource.competitiveSnapshot.contestants.map(
          (contestant) => contestant.agentId,
        ),
        announcedAgentIds: [agent1Id, agent2Id],
      }).toEqual({
        duelId,
        duelKey: duelKeyHex,
        digest: snapshotDigest,
        preparationId: preparationEvidence.privateAuthority.preparationId,
        persisted: true,
        diagnostic: false,
        frozenAt: expect.any(Number),
        contestantIds: [
          preparationEvidence.privateAuthority.agent1Id,
          preparationEvidence.privateAuthority.agent2Id,
        ],
        announcedAgentIds: [
          preparationEvidence.privateAuthority.agent1Id,
          preparationEvidence.privateAuthority.agent2Id,
        ],
      });
      expect(
        frozenBettingSource.competitiveSnapshot.frozenAt,
      ).toBeGreaterThanOrEqual(
        Math.max(
          preparationEvidence.privateAuthority.agent1ReadyAt,
          preparationEvidence.privateAuthority.agent2ReadyAt,
        ),
      );
    }

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        { timeout: 60_000, intervals: [500, 1_000, 2_000] },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: "OPEN",
      });

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    const clobPanel = page.getByTestId("solana-clob-panel").first();

    if (E2E_HYPERIA_RUNTIME === "full_3d") {
      const video = page.locator("video[data-stream-source]").first();
      await expect
        .poll(
          () =>
            video.evaluate((element: HTMLVideoElement) => ({
              readyState: element.readyState,
              paused: element.paused,
              videoWidth: element.videoWidth,
              videoHeight: element.videoHeight,
              currentTime: element.currentTime,
            })),
          { timeout: 30_000, intervals: [250, 500, 1_000] },
        )
        .toMatchObject({
          readyState: expect.any(Number),
          paused: false,
          videoWidth: 1280,
          videoHeight: 720,
          currentTime: expect.any(Number),
        });
      const samplePlayback = () =>
        video.evaluate((element: HTMLVideoElement) => ({
          source: element.dataset.streamSource || "",
          videoWidth: element.videoWidth,
          videoHeight: element.videoHeight,
          currentTime: element.currentTime,
          totalVideoFrames:
            typeof element.getVideoPlaybackQuality === "function"
              ? element.getVideoPlaybackQuality().totalVideoFrames
              : 0,
        }));
      const firstPlayback = await samplePlayback();
      await page.waitForTimeout(2_500);
      const secondPlayback = await samplePlayback();
      expect(firstPlayback.source).toMatch(/\/live\/stream\.m3u8$/);
      expect(firstPlayback.currentTime).toBeGreaterThan(0);
      expect(
        secondPlayback.currentTime - firstPlayback.currentTime,
      ).toBeGreaterThan(1);
      expect(secondPlayback.totalVideoFrames).toBeGreaterThan(
        firstPlayback.totalVideoFrames,
      );
      hlsPlaybackEvidence = {
        source: firstPlayback.source,
        videoWidth: firstPlayback.videoWidth,
        videoHeight: firstPlayback.videoHeight,
        firstCurrentTime: firstPlayback.currentTime,
        secondCurrentTime: secondPlayback.currentTime,
        firstTotalVideoFrames: firstPlayback.totalVideoFrames,
        secondTotalVideoFrames: secondPlayback.totalVideoFrames,
      };
    }

    const buyMatchedOutcome = async (
      outcome: "yes" | "no",
      liquiditySide: number,
      shareField: "aShares" | "bShares",
    ): Promise<void> => {
      const before = (await clobProgram.account.userBalance.fetchNullable(
        userBalanceAddress,
      )) as UserBalanceAccount | null;
      const beforeShares = bnLikeToBigInt(before?.[shareField]);
      await seedClobLiquidity(connection, state, liquiditySide, {
        marketState,
        duelState,
      });
      await page.getByTestId("refresh-market").click();
      await openSolanaBuyOrderEntry(page, clobPanel);
      await clobPanel
        .getByTestId("prediction-amount-input")
        .fill(SOLANA_PREDICTION_AMOUNT);
      await selectSolanaPredictionSide(clobPanel, outcome);
      const priceInput = clobPanel.getByTestId("solana-clob-price-input");
      if (await priceInput.isVisible().catch(() => false)) {
        await priceInput.fill(String(ORDER_PRICE));
      }
      const submit = clobPanel
        .getByRole("button", { name: new RegExp(`buy ${outcome}`, "i") })
        .first();
      await expect(submit).toBeEnabled({ timeout: 30_000 });
      await submit.click();
      await confirmSolanaOrder(page);
      await expect
        .poll(
          async () => {
            const status = await readText(page, "solana-clob-status");
            if (/Order failed:/i.test(status)) throw new Error(status);
            const balance =
              (await clobProgram.account.userBalance.fetchNullable(
                userBalanceAddress,
              )) as UserBalanceAccount | null;
            return bnLikeToBigInt(balance?.[shareField]).toString();
          },
          { timeout: 120_000, intervals: [500, 1_000, 2_000, 5_000] },
        )
        .toBe((beforeShares + 50_000_000n).toString());
    };

    await buyMatchedOutcome("yes", SIDE_ASK, "aShares");
    await buyMatchedOutcome("no", SIDE_BID, "bShares");
    const fundedBalance = (await clobProgram.account.userBalance.fetch(
      userBalanceAddress,
    )) as UserBalanceAccount;
    expect({
      aShares: bnLikeToBigInt(fundedBalance.aShares),
      bShares: bnLikeToBigInt(fundedBalance.bShares),
      aLockedLamports: bnLikeToBigInt(fundedBalance.aLockedLamports),
      bLockedLamports: bnLikeToBigInt(fundedBalance.bLockedLamports),
    }).toEqual({
      aShares: 50_000_000n,
      bShares: 50_000_000n,
      aLockedLamports: 25_000_000n,
      bLockedLamports: 25_000_000n,
    });

    const phaseTimeline: Array<{
      phase: string;
      phaseVersion: number | null;
      observedAt: number;
    }> = [
      {
        phase: announced.cycle?.phase || "missing",
        phaseVersion: announced.cycle?.phaseVersion ?? null,
        observedAt: Date.now(),
      },
    ];
    let terminal: HyperiaStreamingState | null = null;
    const naturalTerminalDeadline = Date.now() + 360_000;
    while (Date.now() < naturalTerminalDeadline) {
      const current = await fetchHyperiaStreamingState(request, control);
      const cycle = current.cycle;
      if (
        cycle?.duelId !== duelId ||
        cycle.duelKeyHex !== duelKeyHex ||
        cycle.competitiveSnapshotDigest !== snapshotDigest
      ) {
        throw new Error(
          `public stream identity drifted during natural combat: ${JSON.stringify(cycle)}`,
        );
      }
      captureActionObservations(current);
      const phase = cycle.phase || "missing";
      if (phase === "FIGHTING") {
        await captureRoleSwitchVisualEvidence(current);
      }
      if (phaseTimeline.at(-1)?.phase !== phase) {
        phaseTimeline.push({
          phase,
          phaseVersion: cycle.phaseVersion ?? null,
          observedAt: Date.now(),
        });
      }
      if (phase === "RESOLUTION") {
        terminal = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!terminal?.cycle) {
      throw new Error(
        `natural Hyperia terminal was not observed: ${JSON.stringify(phaseTimeline)}`,
      );
    }
    expect(phaseTimeline.map((entry) => entry.phase)).toEqual([
      "ANNOUNCEMENT",
      "COUNTDOWN",
      "FIGHTING",
      "RESOLUTION",
    ]);
    const terminalCycle = terminal.cycle;
    const fightDurationMs =
      committedTiming &&
      Number.isSafeInteger(committedTiming.fightStartTime) &&
      Number.isSafeInteger(terminalCycle.duelEndTime)
        ? terminalCycle.duelEndTime! - committedTiming.fightStartTime!
        : null;
    captureActionObservations(terminal);
    const actionObservations = [...actionObservationsBySequence.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    expect(actionObservations.length).toBeGreaterThan(0);
    expect(actionObservations[0]?.sequence).toBe(1);
    for (let index = 1; index < actionObservations.length; index += 1) {
      expect(actionObservations[index]!.sequence).toBe(
        actionObservations[index - 1]!.sequence + 1,
      );
    }
    const combatActionAgents = [agent1Id, agent2Id].map((agentId) => {
      const observations = actionObservations.filter(
        (observation) => observation.actorId === agentId,
      );
      const committedRoleSwitches = observations.filter(
        (observation) =>
          observation.action === "role_switch" &&
          observation.outcome === "committed",
      );
      const committedDamage = observations.filter(
        (observation) =>
          observation.action === "damage" &&
          observation.outcome === "committed" &&
          (observation.amount ?? 0) > 0,
      );
      const acceptedEngagements = observations.filter(
        (observation) =>
          observation.action === "engagement" &&
          observation.outcome === "accepted",
      );
      const plannedPrayer = preparationEvidence
        ? (preparationEvidence.frozenBettingSource.competitiveSnapshot.contestants.find(
            (contestant) => contestant.agentId === agentId,
          )?.preparation.tacticalStrategy.prayer ?? null)
        : undefined;
      const prayerObservations = observations.filter(
        (observation) => observation.action === "prayer",
      );
      const executedCombatRoles = [
        ...new Set(
          [...acceptedEngagements, ...committedDamage].map(
            (observation) => observation.combatRole,
          ),
        ),
      ].sort();
      const damagedCombatRoles = [
        ...new Set(
          committedDamage.map((observation) => observation.combatRole),
        ),
      ].sort();
      const roleSwitchesWithPostSwitchDamage = committedRoleSwitches.filter(
        (roleSwitch) =>
          actionObservations.some(
            (observation) =>
              observation.actorId === agentId &&
              observation.sequence > roleSwitch.sequence &&
              observation.combatRole === roleSwitch.value &&
              observation.action === "damage" &&
              observation.outcome === "committed" &&
              (observation.amount ?? 0) > 0,
          ),
      ).length;
      const roleSwitchesWithPostSwitchCombat = committedRoleSwitches.filter(
        (roleSwitch) =>
          actionObservations.some(
            (observation) =>
              observation.actorId === agentId &&
              observation.sequence > roleSwitch.sequence &&
              observation.combatRole === roleSwitch.value &&
              ((observation.action === "engagement" &&
                observation.outcome === "accepted") ||
                (observation.action === "damage" &&
                  observation.outcome === "committed" &&
                  (observation.amount ?? 0) > 0)),
          ),
      ).length;
      return {
        agentId,
        observations: observations.length,
        committedRoleSwitches: committedRoleSwitches.length,
        roleSwitchTargets: committedRoleSwitches.map(
          (observation) => observation.value,
        ),
        rejectedOrErroredRoleSwitches: observations.filter(
          (observation) =>
            observation.action === "role_switch" &&
            (observation.outcome === "rejected" ||
              observation.outcome === "error"),
        ).length,
        acceptedEngagements: acceptedEngagements.length,
        committedDamageHits: committedDamage.length,
        committedDamageTotal: committedDamage.reduce(
          (total, observation) => total + (observation.amount ?? 0),
          0,
        ),
        plannedPrayer,
        committedPrayerActions: prayerObservations.filter(
          (observation) => observation.outcome === "committed",
        ).length,
        rejectedOrErroredPrayerActions: prayerObservations.filter(
          (observation) =>
            observation.outcome === "rejected" ||
            observation.outcome === "error",
        ).length,
        unplannedOpeningPrayerActions:
          plannedPrayer === null
            ? prayerObservations.filter((observation) => observation.tick <= 2)
                .length
            : 0,
        damagedCombatRoles,
        executedCombatRoles,
        roleSwitchesWithPostSwitchDamage,
        roleSwitchesWithPostSwitchCombat,
      };
    });
    const finalCombatAIs = await fetchHyperiaCombatAIDiagnostics(
      request,
      control,
    );
    const combatAIDiagnosticsEvidence: HyperiaCombatAIDiagnosticsEvidence = {
      schemaVersion: 1,
      diagnosticScope: "operator_private",
      trigger: "terminal_snapshot",
      capturedAtMs: Date.now(),
      cycleId,
      duelId,
      duelKeyHex,
      competitiveSnapshotDigest: snapshotDigest,
      combatAIs: finalCombatAIs,
    };
    const hasPrayerFailure = finalCombatAIs.some(
      (diagnostic) => diagnostic.prayerToggleRejects > 0,
    );
    const combatAIDiagnosticsFileName = hasPrayerFailure
      ? "natural-hyperia-combat-ai-prayer-failure.json"
      : "natural-hyperia-combat-ai-final.json";
    const combatAIDiagnosticsPath = testInfo.outputPath(
      combatAIDiagnosticsFileName,
    );
    const combatAIDiagnosticsBytes = Buffer.from(
      `${JSON.stringify(combatAIDiagnosticsEvidence, null, 2)}\n`,
    );
    const combatAIDiagnosticsSha256 = createHash("sha256")
      .update(combatAIDiagnosticsBytes)
      .digest("hex");
    fs.writeFileSync(combatAIDiagnosticsPath, combatAIDiagnosticsBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await testInfo.attach("natural-hyperia-combat-ai-final", {
      path: combatAIDiagnosticsPath,
      contentType: "application/json",
    });
    const combatActionEvidence = {
      schemaVersion: 1,
      capturedAtMs: Date.now(),
      cycleId,
      duelId,
      duelKeyHex,
      snapshotDigest,
      contiguousSequence: true,
      firstSequence: actionObservations[0]!.sequence,
      lastSequence: actionObservations.at(-1)!.sequence,
      observations: actionObservations,
      agents: combatActionAgents,
      operatorPrivateCombatAIDiagnostics: {
        fileName: combatAIDiagnosticsFileName,
        sha256: combatAIDiagnosticsSha256,
      },
    };
    const combatActionEvidenceBytes = Buffer.from(
      `${JSON.stringify(combatActionEvidence, null, 2)}\n`,
    );
    const combatActionEvidenceSha256 = createHash("sha256")
      .update(combatActionEvidenceBytes)
      .digest("hex");
    const combatActionEvidencePath = testInfo.outputPath(
      "natural-hyperia-combat-actions.json",
    );
    fs.writeFileSync(combatActionEvidencePath, combatActionEvidenceBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await testInfo.attach("natural-hyperia-combat-actions", {
      path: combatActionEvidencePath,
      contentType: "application/json",
    });
    expect(
      finalCombatAIs
        .map((diagnostic) => ({
          characterId: diagnostic.characterId,
          cycleId: diagnostic.cycleId,
          duelId: diagnostic.duelId,
          prayerToggleRejects: diagnostic.prayerToggleRejects,
          lastPrayerToggleFailureReason:
            diagnostic.lastPrayerToggleFailureReason,
        }))
        .sort((left, right) =>
          left.characterId.localeCompare(right.characterId),
        ),
    ).toEqual(
      [agent1Id, agent2Id].sort().map((characterId) => ({
        characterId,
        cycleId,
        duelId,
        prayerToggleRejects: 0,
        lastPrayerToggleFailureReason: null,
      })),
    );
    expect(
      combatActionAgents.map((agent) => ({
        agentId: agent.agentId,
        rejectedOrErroredPrayerActions: agent.rejectedOrErroredPrayerActions,
      })),
    ).toEqual([
      { agentId: agent1Id, rejectedOrErroredPrayerActions: 0 },
      { agentId: agent2Id, rejectedOrErroredPrayerActions: 0 },
    ]);
    if (preparationEvidence) {
      expect(
        combatActionAgents.map((agent) => ({
          agentId: agent.agentId,
          plannedPrayer: agent.plannedPrayer,
          unplannedOpeningPrayerActions: agent.unplannedOpeningPrayerActions,
        })),
      ).toEqual([
        {
          agentId: agent1Id,
          plannedPrayer:
            preparationEvidence.frozenBettingSource.competitiveSnapshot.contestants.find(
              (contestant) => contestant.agentId === agent1Id,
            )?.preparation.tacticalStrategy.prayer ?? null,
          unplannedOpeningPrayerActions: 0,
        },
        {
          agentId: agent2Id,
          plannedPrayer:
            preparationEvidence.frozenBettingSource.competitiveSnapshot.contestants.find(
              (contestant) => contestant.agentId === agent2Id,
            )?.preparation.tacticalStrategy.prayer ?? null,
          unplannedOpeningPrayerActions: 0,
        },
      ]);
    }
    let roleSwitchVisualEvidenceSha256: string | null = null;
    if (HYPERIA_MULTI_STYLE && E2E_HYPERIA_RUNTIME === "full_3d") {
      const roleSwitchVisualEvidenceBytes = Buffer.from(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            capturedAtMs: Date.now(),
            cycleId,
            duelId,
            duelKeyHex,
            snapshotDigest,
            roles: [...capturedVisualRoles].sort(),
            samples: roleSwitchVisualEvidence,
          },
          null,
          2,
        )}\n`,
      );
      roleSwitchVisualEvidenceSha256 = createHash("sha256")
        .update(roleSwitchVisualEvidenceBytes)
        .digest("hex");
      const roleSwitchVisualEvidencePath = testInfo.outputPath(
        "natural-hyperia-role-switch-visual-evidence.json",
      );
      fs.writeFileSync(
        roleSwitchVisualEvidencePath,
        roleSwitchVisualEvidenceBytes,
        { flag: "wx", mode: 0o600 },
      );
      await testInfo.attach("natural-hyperia-role-switch-visual-evidence", {
        path: roleSwitchVisualEvidencePath,
        contentType: "application/json",
      });
      expect([...capturedVisualRoles].sort()).toEqual([
        "mage",
        "melee",
        "ranged",
      ]);
      expect(roleSwitchVisualEvidence).toHaveLength(3);
    }
    if (HYPERIA_MULTI_STYLE) {
      const frozenContestants =
        preparationEvidence?.frozenBettingSource.competitiveSnapshot
          .contestants ?? [];
      for (const agent of combatActionAgents) {
        const frozen = frozenContestants.find(
          (contestant) => contestant.agentId === agent.agentId,
        );
        expect(frozen).toBeDefined();
        expect(agent.committedRoleSwitches).toBeGreaterThan(0);
        expect(agent.rejectedOrErroredRoleSwitches).toBe(0);
        expect(agent.acceptedEngagements).toBeGreaterThan(0);
        expect(agent.committedDamageHits).toBeGreaterThan(0);
        expect(agent.executedCombatRoles.length).toBeGreaterThanOrEqual(2);
        expect(agent.roleSwitchesWithPostSwitchCombat).toBeGreaterThan(0);
        for (const targetRole of agent.roleSwitchTargets) {
          expect(targetRole).toMatch(/^(melee|ranged|mage)$/);
          expect(frozen!.availableCombatStyles).toContain(targetRole);
        }
        for (const roleSwitch of actionObservations.filter(
          (observation) =>
            observation.actorId === agent.agentId &&
            observation.action === "role_switch" &&
            observation.outcome === "committed",
        )) {
          expect(roleSwitch.value).not.toBe(roleSwitch.combatRole);
        }
      }
      expect(
        new Set(
          combatActionAgents.flatMap((agent) => agent.executedCombatRoles),
        ).size,
      ).toBe(3);
    }
    const winnerSide =
      terminalCycle.winnerId === agent1Id
        ? "a"
        : terminalCycle.winnerId === agent2Id
          ? "b"
          : null;
    expect(winnerSide).not.toBeNull();
    const winnerName = winnerSide === "a" ? agent1Name : agent2Name;
    const terminalReasonLabel =
      terminalCycle.winReason === "hp_advantage"
        ? "Health advantage at the time limit"
        : terminalCycle.winReason === "damage_advantage"
          ? "Damage advantage at the time limit"
          : "Knockout";
    expect({
      outcome: terminalCycle.outcome,
      winReason: terminalCycle.winReason,
      winnerName: terminalCycle.winnerName,
      seed: terminalCycle.seed,
      replayHash: terminalCycle.replayHash,
      duelEndTime: terminalCycle.duelEndTime,
    }).toEqual({
      outcome: "win",
      winReason: EXPECT_EXACT_HYPERIA_TIMEOUT
        ? expect.stringMatching(/^(hp_advantage|damage_advantage)$/)
        : "kill",
      winnerName,
      seed: expect.stringMatching(/^[0-9]{1,20}$/),
      replayHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      duelEndTime: EXPECT_EXACT_HYPERIA_TIMEOUT
        ? committedTiming!.fightDeadline
        : expect.any(Number),
    });
    if (EXPECT_EXACT_HYPERIA_TIMEOUT) {
      const terminalObservedAfterDeadlineMs =
        Date.now() - committedTiming!.fightDeadline!;
      expect(terminalObservedAfterDeadlineMs).toBeGreaterThanOrEqual(0);
      expect(terminalObservedAfterDeadlineMs).toBeLessThan(10_000);
    }
    if (EXPECT_SHORT_HYPERIA_KILL) {
      expect(fightDurationMs).not.toBeNull();
      expect(fightDurationMs!).toBeGreaterThan(0);
      expect(fightDurationMs!).toBeLessThanOrEqual(
        SHORT_HYPERIA_KILL_MAX_DURATION_MS,
      );
      expect(terminalCycle.duelEndTime).toBeLessThan(
        committedTiming!.fightDeadline!,
      );
    }

    let rendererEvidence: HyperiaRendererStatus | null = null;
    if (E2E_HYPERIA_RUNTIME === "full_3d") {
      await expect
        .poll(
          () => {
            const status = readHyperiaRendererStatus(control);
            const rendererHealth = status?.rendererHealth;
            const scene = rendererHealth?.diagnostics?.sceneReadiness;
            const browserAudio = status?.browserAudioCaptureHealth;
            const captureHealth = status?.captureHealth;
            const requiredEquipment = scene?.equipmentRequiredCount;
            const emittedFrames = captureHealth?.emittedFrames ?? 0;
            const repeatedFrames = captureHealth?.repeatedFrames ?? 0;
            return {
              source: status?.source ?? null,
              rendererReady: rendererHealth?.ready ?? false,
              degradedReason:
                rendererHealth && "degradedReason" in rendererHealth
                  ? rendererHealth.degradedReason
                  : "missing",
              rendererPhase: rendererHealth?.phase ?? null,
              sceneReady: scene?.ready ?? false,
              sceneCycleId: scene?.cycleId ?? null,
              scenePhase: scene?.phase ?? null,
              equipmentComplete:
                Number.isSafeInteger(requiredEquipment) &&
                (requiredEquipment ?? 0) > 0 &&
                scene?.equipmentReadyCount === requiredEquipment,
              requiredPlayers: scene?.equipmentRequiredPlayerCount ?? null,
              expectedPlayers: scene?.equipmentExpectedPlayerCount ?? null,
              attachmentMismatches:
                scene?.equipmentAttachmentMismatchCount ?? null,
              damagePresentationAvailable:
                scene?.damagePresentationAvailable ?? false,
              activeDamageSplatCount: scene?.activeDamageSplatCount ?? null,
              ffmpegRunning: status?.stats?.ffmpegRunning ?? false,
              audioSource: status?.stats?.audioSource ?? null,
              audioHealthy: status?.stats?.audioHealthy ?? false,
              audioDroppedChunks: status?.stats?.audioDroppedChunks ?? null,
              bridgeAudioTrimmedChunks:
                status?.stats?.audioTrimmedChunks ?? null,
              browserAudioContextState: browserAudio?.contextState ?? null,
              browserAudioSourceContextState:
                browserAudio?.sourceContextState ?? null,
              browserAudioTrackState: browserAudio?.trackState ?? null,
              browserAudioSampleRate: browserAudio?.sampleRate ?? null,
              browserAudioChannels: browserAudio?.channels ?? null,
              browserAudioHasContent:
                (browserAudio?.chunks ?? 0) > 0 &&
                (browserAudio?.contentChunks ?? 0) > 0,
              browserAudioDroppedChunks: browserAudio?.droppedChunks ?? null,
              browserAudioPendingWrites: browserAudio?.pendingWrites ?? null,
              captureFrameCadenceHealthy:
                (captureHealth?.targetFps ?? 0) > 0 &&
                captureHealth?.measuredFps === captureHealth?.targetFps &&
                (captureHealth?.sourceFrames ?? 0) > 0 &&
                emittedFrames > 0 &&
                repeatedFrames / emittedFrames <= 0.05 &&
                captureHealth?.rejectedFrames === 0 &&
                captureHealth?.skippedFrames === 0,
            };
          },
          { timeout: 15_000, intervals: [100, 250, 500, 1_000] },
        )
        .toEqual({
          source: "external-rtmp-bridge",
          rendererReady: true,
          degradedReason: null,
          rendererPhase: "RESOLUTION",
          sceneReady: true,
          sceneCycleId: terminalCycle.cycleId,
          scenePhase: "RESOLUTION",
          equipmentComplete: true,
          requiredPlayers: 2,
          expectedPlayers: 2,
          attachmentMismatches: 0,
          damagePresentationAvailable: true,
          activeDamageSplatCount: 0,
          ffmpegRunning: true,
          audioSource: "browser",
          audioHealthy: true,
          audioDroppedChunks: 0,
          bridgeAudioTrimmedChunks: 0,
          browserAudioContextState: "running",
          browserAudioSourceContextState: "running",
          browserAudioTrackState: "live",
          browserAudioSampleRate: 48_000,
          browserAudioChannels: 2,
          browserAudioHasContent: true,
          browserAudioDroppedChunks: 0,
          browserAudioPendingWrites: 0,
          captureFrameCadenceHealthy: true,
        });
      rendererEvidence = readHyperiaRendererStatus(control);
      expect(rendererEvidence?.stats?.bytesReceived ?? 0).toBeGreaterThan(0);
      expect(rendererEvidence?.stats?.audioChunks ?? 0).toBeGreaterThan(0);
      expect(rendererEvidence?.stats?.droppedFrames ?? 0).toBe(0);
      const emittedFrames = rendererEvidence?.captureHealth?.emittedFrames ?? 0;
      const repeatedFrames =
        rendererEvidence?.captureHealth?.repeatedFrames ?? 0;
      expect(rendererEvidence?.captureHealth).toMatchObject({
        targetFps: 30,
        measuredFps: 30,
        rejectedFrames: 0,
        skippedFrames: 0,
      });
      expect(
        rendererEvidence?.captureHealth?.sourceFrames ?? 0,
      ).toBeGreaterThan(0);
      expect(emittedFrames).toBeGreaterThan(0);
      expect(repeatedFrames / emittedFrames).toBeLessThanOrEqual(0.05);

      await expect(
        page.getByTestId("spectator-terminal-outcome"),
      ).toContainText(`${winnerName} wins — ${terminalReasonLabel}.`, {
        timeout: 30_000,
      });
      await expect(
        page
          .getByTestId("solana-clob-panel")
          .getByText("Duel complete. On-chain settlement is pending.", {
            exact: true,
          }),
      ).toBeVisible({ timeout: 30_000 });
      const terminalDuelActivity = settlementEntriesForDuel(page, duelId);
      await expect(terminalDuelActivity).toHaveCount(2, { timeout: 30_000 });
      await expect(
        terminalDuelActivity.filter({ hasText: "Settlement pending" }),
      ).toHaveCount(2);
      await expect(
        terminalDuelActivity.getByRole("button", {
          name: /recover order rent/i,
        }),
      ).toHaveCount(0);
      await expect(
        terminalDuelActivity.getByRole("button", {
          name: /clear position/i,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Awaiting result", { exact: true }),
      ).toHaveCount(0);
      const terminalVideo = page.locator("video[data-stream-source]").first();
      await expect(terminalVideo).toBeVisible();
      const terminalPlayback = await terminalVideo.evaluate(
        (element: HTMLVideoElement) => ({
          videoWidth: element.videoWidth,
          videoHeight: element.videoHeight,
          currentTime: element.currentTime,
          totalVideoFrames:
            typeof element.getVideoPlaybackQuality === "function"
              ? element.getVideoPlaybackQuality().totalVideoFrames
              : 0,
        }),
      );
      expect(terminalPlayback.videoWidth).toBe(1280);
      expect(terminalPlayback.videoHeight).toBe(720);
      expect(terminalPlayback.currentTime).toBeGreaterThan(0);
      expect(terminalPlayback.totalVideoFrames).toBeGreaterThan(0);
      const terminalStreamDataUrl = await terminalVideo.evaluate(
        (element: HTMLVideoElement) => {
          const canvas = document.createElement("canvas");
          canvas.width = element.videoWidth;
          canvas.height = element.videoHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("2D canvas context is unavailable");
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png");
        },
      );
      expect(terminalStreamDataUrl).toMatch(/^data:image\/png;base64,/);
      const terminalStreamBytes = Buffer.from(
        terminalStreamDataUrl.replace(/^data:image\/png;base64,/, ""),
        "base64",
      );
      expect(terminalStreamBytes.length).toBeGreaterThan(1_000);
      const terminalStreamPath = testInfo.outputPath(
        "natural-hyperia-3d-terminal-stream.png",
      );
      const terminalPagePath = testInfo.outputPath(
        "natural-hyperia-3d-terminal-page.png",
      );
      fs.writeFileSync(terminalStreamPath, terminalStreamBytes, {
        flag: "wx",
        mode: 0o600,
      });
      await page.screenshot({
        path: terminalPagePath,
        fullPage: true,
        animations: "disabled",
        style: '[data-testid="e2e-debug-panel"] { display: none !important; }',
      });
      fs.chmodSync(terminalStreamPath, 0o600);
      fs.chmodSync(terminalPagePath, 0o600);
      terminalVisualEvidence = {
        capturedAt: Date.now(),
        videoWidth: terminalPlayback.videoWidth,
        videoHeight: terminalPlayback.videoHeight,
        videoCurrentTime: terminalPlayback.currentTime,
        totalVideoFrames: terminalPlayback.totalVideoFrames,
        streamScreenshot: path.basename(terminalStreamPath),
        streamScreenshotSha256: createHash("sha256")
          .update(fs.readFileSync(terminalStreamPath))
          .digest("hex"),
        pageScreenshot: path.basename(terminalPagePath),
        pageScreenshotSha256: createHash("sha256")
          .update(fs.readFileSync(terminalPagePath))
          .digest("hex"),
      };
      await testInfo.attach("natural-hyperia-3d-terminal-stream", {
        path: terminalStreamPath,
        contentType: "image/png",
      });
      await testInfo.attach("natural-hyperia-3d-terminal-ui", {
        path: terminalPagePath,
        contentType: "image/png",
      });
    }

    await expect
      .poll(
        async () => {
          const fixtures = await listSolanaTraderFixtures(connection, state);
          const fixture =
            fixtures.find((entry) => entry.marketState.equals(marketState)) ??
            null;
          return `${fixture?.duelStatus ?? "missing"}:${fixture?.pendingWinner ?? "missing"}`;
        },
        { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] },
      )
      .toBe(`proposed:${winnerSide}`);

    await expect
      .poll(
        async () => {
          const fixtures = await listSolanaTraderFixtures(connection, state);
          const fixture =
            fixtures.find((entry) => entry.marketState.equals(marketState)) ??
            null;
          return `${fixture?.duelStatus ?? "missing"}:${fixture?.marketStatus ?? "missing"}:${fixture?.marketWinner ?? "missing"}`;
        },
        { timeout: 150_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(`resolved:resolved:${winnerSide}`);

    await expect
      .poll(
        async () => {
          const payload = await fetchBotHealth(request);
          const market = payload.health?.markets.find(
            (entry) => entry.marketRef === marketState.toBase58(),
          );
          return `${market?.lifecycleStatus ?? "missing"}:${market?.winner ?? "missing"}`;
        },
        { timeout: 60_000, intervals: [500, 1_000, 2_000, 5_000] },
      )
      .toBe(`RESOLVED:${winnerSide === "a" ? "A" : "B"}`);

    const market = (await clobProgram.account.marketState.fetch(
      marketState,
    )) as { winningsMarketMakerFeeBpsSnapshot?: unknown };
    const winningShares =
      winnerSide === "a"
        ? bnLikeToBigInt(fundedBalance.aShares)
        : bnLikeToBigInt(fundedBalance.bShares);
    const winningsFeeBps = bnLikeToBigInt(
      market.winningsMarketMakerFeeBpsSnapshot,
    );
    const expectedPayoutLamports =
      winningShares - (winningShares * winningsFeeBps) / 10_000n;
    const userBalanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    const beforeClaimWalletLamports = BigInt(
      await connection.getBalance(trader, "confirmed"),
    );

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
      debug: false,
    });
    await selectChain(page, "solana");
    await ensureWalletConnected(page);
    const productRoot = page.locator(".hm-root").first();
    await expect
      .poll(
        async () =>
          (await productRoot.getAttribute("data-stream-duel-id")) ?? "",
        { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] },
      )
      .not.toBe("");
    const presentedStreamDuelId =
      (await productRoot.getAttribute("data-stream-duel-id")) ?? "";
    const streamAdvancedToNextCycle = presentedStreamDuelId !== duelId;
    if (E2E_HYPERIA_RUNTIME === "full_3d") {
      expect(streamAdvancedToNextCycle).toBe(true);
    }

    const exactDuelActivity = settlementEntriesForDuel(page, duelId);
    if (streamAdvancedToNextCycle) {
      await expect(productRoot).toHaveAttribute(
        "data-market-can-place-bet",
        "false",
      );
      await expect(page.getByTestId("spectator-terminal-outcome")).toHaveCount(
        0,
      );
      await expect(page.getByTestId("duels-bottom-panel-news")).toContainText(
        "Matchup locked — fighters are preparing in the arena.",
      );
      await expect(exactDuelActivity).toHaveCount(2, { timeout: 60_000 });
      await expect(
        exactDuelActivity.filter({ hasText: "Winnings ready to claim" }),
      ).toHaveCount(1);
      await expect(
        exactDuelActivity.filter({ hasText: "Resolved · no payout" }),
      ).toHaveCount(1);

      let playbackAdvanceSeconds: number | null = null;
      let playbackFrameAdvance: number | null = null;
      if (E2E_HYPERIA_RUNTIME === "full_3d") {
        const video = page.locator("video[data-stream-source]").first();
        const samplePlayback = () =>
          video.evaluate((element: HTMLVideoElement) => ({
            currentTime: element.currentTime,
            totalVideoFrames:
              typeof element.getVideoPlaybackQuality === "function"
                ? element.getVideoPlaybackQuality().totalVideoFrames
                : 0,
          }));
        const before = await samplePlayback();
        await page.waitForTimeout(2_500);
        const after = await samplePlayback();
        playbackAdvanceSeconds = after.currentTime - before.currentTime;
        playbackFrameAdvance = after.totalVideoFrames - before.totalVideoFrames;
        expect(playbackAdvanceSeconds).toBeGreaterThan(1);
        expect(playbackFrameAdvance).toBeGreaterThan(0);
      }
      postTerminalPresentationEvidence = {
        mode: "advanced_cycle_with_historical_claim",
        pinnedDuelId: duelId,
        presentedStreamDuelId,
        historicalActivityCount: await exactDuelActivity.count(),
        marketCanPlaceBet:
          (await productRoot.getAttribute("data-market-can-place-bet")) ===
          "true",
        playbackAdvanceSeconds,
        playbackFrameAdvance,
      };
      await testInfo.attach("natural-hyperia-sol-rollover-claim-ready", {
        body: await page.screenshot({
          fullPage: true,
          animations: "disabled",
        }),
        contentType: "image/png",
      });
    } else {
      await expect(page.getByTestId("duels-bottom-panel-news")).toContainText(
        `${winnerName} wins the round.`,
        { timeout: 60_000 },
      );
      await expect(
        page.getByTestId("spectator-terminal-outcome"),
      ).toContainText(`${winnerName} wins — ${terminalReasonLabel}.`);
      postTerminalPresentationEvidence = {
        mode: "same_cycle_resolution",
        pinnedDuelId: duelId,
        presentedStreamDuelId,
        historicalActivityCount: await exactDuelActivity.count(),
        marketCanPlaceBet:
          (await productRoot.getAttribute("data-market-can-place-bet")) ===
          "true",
        playbackAdvanceSeconds: null,
        playbackFrameAdvance: null,
      };
    }
    await expect(
      page.getByTestId("solana-clob-settlement-action"),
    ).toContainText("Claim winnings", { timeout: 60_000 });
    const claimButton = page
      .getByRole("button", { name: /claim winnings/i })
      .first();
    await expect(claimButton).toBeEnabled({ timeout: 30_000 });
    await claimButton.click();
    const claimSignature = await expectSolanaSettlementReceipt(
      page,
      /claim confirmed on-chain/i,
    );
    const [claimWalletDelta, claimTransactionFee] = await Promise.all([
      getWalletLamportDeltaFromSignature(connection, claimSignature, trader),
      getTransactionFeeFromSignature(connection, claimSignature),
    ]);
    expect(claimWalletDelta).not.toBeNull();
    expect(claimTransactionFee).not.toBeNull();
    expect((claimWalletDelta ?? 0n) + (claimTransactionFee ?? 0n)).toBe(
      expectedPayoutLamports + userBalanceRentLamports,
    );
    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.bShares)}`;
        },
        { timeout: 60_000, intervals: [500, 1_000, 2_000, 5_000] },
      )
      .toBe("0:0");
    const afterClaimWalletLamports = BigInt(
      await connection.getBalance(trader, "confirmed"),
    );
    expect(afterClaimWalletLamports).toBeGreaterThan(beforeClaimWalletLamports);

    const terminalEvidence = {
      duelId,
      duelKeyHex,
      snapshotDigest,
      agent1Id,
      agent1Name,
      agent2Id,
      agent2Name,
      winnerId: terminalCycle.winnerId,
      winnerName,
      winnerSide,
      outcome: terminalCycle.outcome,
      winReason: terminalCycle.winReason,
      terminalExpectation: HYPERIA_TERMINAL_EXPECTATION,
      fightDurationMs,
      shortFightMaximumMs: EXPECT_SHORT_HYPERIA_KILL
        ? SHORT_HYPERIA_KILL_MAX_DURATION_MS
        : null,
      committedTiming,
      seed: terminalCycle.seed,
      replayHash: terminalCycle.replayHash,
      phaseTimeline,
      marketState: marketState.toBase58(),
      duelState: duelState.toBase58(),
      claimSignature,
      claimWalletDelta: claimWalletDelta?.toString() ?? null,
      claimTransactionFee: claimTransactionFee?.toString() ?? null,
      expectedPayoutLamports: expectedPayoutLamports.toString(),
      userBalanceRentLamports: userBalanceRentLamports.toString(),
      hyperiaRuntime: E2E_HYPERIA_RUNTIME,
      hlsPlaybackEvidence,
      rendererEvidence,
      terminalVisualEvidence,
      postTerminalPresentationEvidence,
      combatActionEvidence: {
        sha256: combatActionEvidenceSha256,
        observations: actionObservations.length,
        firstSequence: actionObservations[0]!.sequence,
        lastSequence: actionObservations.at(-1)!.sequence,
        agents: combatActionAgents,
      },
      roleSwitchVisualEvidence:
        roleSwitchVisualEvidenceSha256 === null
          ? null
          : {
              sha256: roleSwitchVisualEvidenceSha256,
              roles: [...capturedVisualRoles].sort(),
              samples: roleSwitchVisualEvidence,
            },
    };
    const terminalEvidencePath = testInfo.outputPath(
      "natural-hyperia-sol-terminal.json",
    );
    fs.writeFileSync(
      terminalEvidencePath,
      `${JSON.stringify(terminalEvidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await testInfo.attach("natural-hyperia-sol-terminal", {
      path: terminalEvidencePath,
      contentType: "application/json",
    });
    await testInfo.attach("natural-hyperia-sol-terminal-ui", {
      body: await page.screenshot({ fullPage: true, animations: "disabled" }),
      contentType: "image/png",
    });
  });

  test("solana predictions place YES and NO orders and stage a proposed winner claim", async ({
    page,
    request,
  }, testInfo) => {
    const state = loadState();
    const control = loadControl();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const {
      duelKey,
      duelKeyHex,
      duelId,
      duelState,
      marketState,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    } = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-resolve-claim",
      {
        betCloseOffsetSeconds: 120,
        duelStartOffsetSeconds: 120,
      },
    );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: "OPEN",
      });

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    const clobPanel = page.getByTestId("solana-clob-panel").first();

    await expect(page.getByTestId("current-match-id")).toContainText(duelId, {
      timeout: 60_000,
    });

    await seedClobLiquidity(connection, state, SIDE_ASK, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();

    await openSolanaBuyOrderEntry(page, clobPanel);
    await clobPanel
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await selectSolanaPredictionSide(clobPanel, "yes");
    const orderQuote = clobPanel.getByTestId("solana-order-quote");
    await expect(orderQuote).toContainText("Order details before signature");
    await expect(orderQuote).toContainText("Maximum locked collateral");
    await expect(orderQuote).toContainText("Execution fees");
    await expect(orderQuote).toContainText(
      "matched collateral and escrowed execution fees are refundable through claim",
    );
    await expect(orderQuote).toContainText(
      "Cancellation or reclaim separately returns unmatched collateral",
    );
    await expect(orderQuote).toContainText("Maximum wallet funding required");
    const buyYesButton = clobPanel
      .getByRole("button", { name: /buy yes/i })
      .first();
    await expect(buyYesButton).toBeEnabled({ timeout: 30_000 });
    const visibilityFaultId = `finalized-place-order-visibility-${duelId}`;
    armFinalizedTransactionVisibilityGap(control, {
      faultId: visibilityFaultId,
      requiredAccount: marketState,
      requiredProgramId: new PublicKey(duelMarketProgramId),
    });
    await buyYesButton.click();
    const trackingEvidence = await confirmSolanaOrder(page);
    expect(trackingEvidence.terminalStatus).toBe(200);
    expect(
      trackingEvidence.attempts.some((attempt) => attempt.startsWith("425:")),
    ).toBe(true);
    await expect
      .poll(
        () => {
          const observed = readSolanaRpcFaultControl(control);
          return {
            faultId: observed?.faultId ?? null,
            mode: observed?.mode ?? null,
            state: observed?.state ?? null,
            signature: observed?.signature ?? null,
            hiddenLookupCount:
              observed?.mode === "hide_get_transaction_after_forward"
                ? (observed.hiddenLookupCount ?? null)
                : null,
            requestedCommitment:
              observed?.mode === "hide_get_transaction_after_forward"
                ? (observed.requestedCommitment ?? null)
                : null,
            requestedLane:
              observed?.mode === "hide_get_transaction_after_forward"
                ? (observed.requestedLane ?? null)
                : null,
          };
        },
        { timeout: 30_000, intervals: [100, 250, 500, 1_000] },
      )
      .toEqual({
        faultId: visibilityFaultId,
        mode: "hide_get_transaction_after_forward",
        state: "released",
        signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/),
        hiddenLookupCount: 1,
        requestedCommitment: "finalized",
        requestedLane: "verifier",
      });
    const releasedVisibilityFault = readSolanaRpcFaultControl(control);
    if (
      releasedVisibilityFault?.mode !== "hide_get_transaction_after_forward" ||
      releasedVisibilityFault.state !== "released" ||
      !releasedVisibilityFault.signature
    ) {
      throw new Error("Finalized transaction visibility fault did not release");
    }
    const [visibleSignatureStatus] = (
      await connection.getSignatureStatuses(
        [releasedVisibilityFault.signature],
        { searchTransactionHistory: true },
      )
    ).value;
    expect(visibleSignatureStatus).toMatchObject({
      err: null,
      confirmationStatus: "finalized",
    });
    const visibleTransaction = await connection.getTransaction(
      releasedVisibilityFault.signature,
      { commitment: "finalized", maxSupportedTransactionVersion: 0 },
    );
    expect(visibleTransaction).not.toBeNull();
    expect(visibleTransaction?.meta?.err).toBeNull();
    const visibilityEvidence = {
      schemaVersion: 1,
      duelId,
      duelKeyHex,
      marketState: marketState.toBase58(),
      fault: releasedVisibilityFault,
      tracking: trackingEvidence,
      finalizedStatus: {
        err: visibleSignatureStatus?.err ?? null,
        confirmationStatus: visibleSignatureStatus?.confirmationStatus ?? null,
      },
      visibleTransaction: {
        slot: visibleTransaction?.slot ?? null,
        err: visibleTransaction?.meta?.err ?? null,
      },
    };
    const visibilityEvidencePath = testInfo.outputPath(
      "solana-finalized-transaction-visibility-recovery.json",
    );
    fs.writeFileSync(
      visibilityEvidencePath,
      `${JSON.stringify(visibilityEvidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await testInfo.attach("solana-finalized-transaction-visibility-recovery", {
      path: visibilityEvidencePath,
      contentType: "application/json",
    });

    const yesStatus = await page
      .getByTestId("solana-clob-status")
      .textContent()
      .catch(() => "");
    if ((yesStatus || "").includes("Order failed:")) {
      throw new Error((yesStatus || "").trim());
    }

    try {
      await expect
        .poll(
          async () => {
            const currentStatus = await readText(page, "solana-clob-status");
            if (/Order failed:/i.test(currentStatus)) {
              throw new Error(currentStatus);
            }
            const balance =
              (await clobProgram.account.userBalance.fetchNullable(
                userBalanceAddress,
              )) as UserBalanceAccount | null;
            return Number(bnLikeToBigInt(balance?.aShares));
          },
          {
            timeout: 120_000,
            intervals: [1_000, 2_000, 5_000],
          },
        )
        .toBeGreaterThan(0);
    } catch (error) {
      const currentStatus = await readText(page, "solana-clob-status");
      const currentOrderError = await readText(
        page,
        "solana-clob-place-order-error",
      );
      const currentOrderDebug = await readText(
        page,
        "solana-clob-place-order-debug",
      );
      const currentOrderTx = await readText(page, "solana-clob-place-order-tx");
      const marketBalances = await loadMarketBalances(connection, state, {
        marketState,
      });
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `status=${currentStatus || "<empty>"}`,
          `orderError=${currentOrderError || "<empty>"}`,
          `orderDebug=${currentOrderDebug || "<empty>"}`,
          `orderTx=${currentOrderTx || "<empty>"}`,
          `marketBalances=${JSON.stringify(marketBalances)}`,
        ].join("\n"),
        { cause: error },
      );
    }

    await page.getByTestId("refresh-market").click();
    await openSolanaBuyOrderEntry(page, clobPanel);
    await selectSolanaPredictionSide(clobPanel, "no");
    const noPriceInput = clobPanel.getByTestId("solana-clob-price-input");
    if (await noPriceInput.isVisible().catch(() => false)) {
      await expect(noPriceInput).toHaveAccessibleName(
        "Selected-outcome limit probability (per mille)",
      );
      await expect(noPriceInput).toHaveAttribute("inputmode", "numeric");
      await expect(noPriceInput).toHaveAttribute("maxlength", "3");
      await expect(noPriceInput).toHaveAttribute("pattern", "[0-9]{1,3}");
      await expect(noPriceInput).toHaveAttribute("aria-invalid", "false");
      expect(
        await noPriceInput.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).minHeight),
        ),
      ).toBeGreaterThanOrEqual(44);
      await noPriceInput.fill("500");
    }
    const submitButton = clobPanel
      .getByRole("button", { name: /buy no/i })
      .first();
    await expect(submitButton).toContainText(/buy no/i, {
      timeout: 30_000,
    });
    const previousNoOrderTx = await readText(
      page,
      "solana-clob-place-order-tx",
    );
    const previousNoOrderDebug = await readText(
      page,
      "solana-clob-place-order-debug",
    );
    const beforeNoBalance =
      (await clobProgram.account.userBalance.fetchNullable(
        userBalanceAddress,
      )) as UserBalanceAccount | null;
    const beforeNoShares = bnLikeToBigInt(beforeNoBalance?.bShares);
    const beforeNoLockedLamports = bnLikeToBigInt(
      beforeNoBalance?.bLockedLamports,
    );
    const beforeNoMarket = (await clobProgram.account.marketState.fetch(
      marketState,
    )) as MarketStateAccount;
    const noOrderId = bnLikeToBigInt(beforeNoMarket.nextOrderId);
    const noOrderAddress = deriveOrderPda(
      clobProgram.programId,
      marketState,
      noOrderId,
    );
    await expect(submitButton).toBeEnabled({ timeout: 30_000 });
    await submitButton.click();
    await confirmSolanaOrder(page);

    const noStatus = await page
      .getByTestId("solana-clob-status")
      .textContent()
      .catch(() => "");
    if ((noStatus || "").includes("Order failed:")) {
      throw new Error((noStatus || "").trim());
    }

    try {
      const waitForNoOrderResult = async (): Promise<void> => {
        await expect
          .poll(
            async () => {
              const currentStatus = await readText(page, "solana-clob-status");
              if (/Order failed:/i.test(currentStatus)) {
                throw new Error(currentStatus);
              }
              const currentOrderTx = await readText(
                page,
                "solana-clob-place-order-tx",
              );
              if (
                currentOrderTx &&
                currentOrderTx !== previousNoOrderTx &&
                !currentOrderTx.endsWith("-")
              ) {
                return currentOrderTx;
              }
              const currentOrderDebug = await readText(
                page,
                "solana-clob-place-order-debug",
              );
              if (
                currentOrderDebug &&
                currentOrderDebug !== previousNoOrderDebug &&
                /failed /i.test(currentOrderDebug)
              ) {
                throw new Error(currentOrderDebug);
              }
              const currentNoBalance =
                (await clobProgram.account.userBalance.fetchNullable(
                  userBalanceAddress,
                )) as UserBalanceAccount | null;
              const currentNoShares = bnLikeToBigInt(currentNoBalance?.bShares);
              const currentNoLockedLamports = bnLikeToBigInt(
                currentNoBalance?.bLockedLamports,
              );
              if (
                currentNoShares > beforeNoShares ||
                currentNoLockedLamports > beforeNoLockedLamports
              ) {
                return `state:${currentNoShares}:${currentNoLockedLamports}`;
              }
              return "";
            },
            {
              timeout: 20_000,
              intervals: [1_000, 2_000, 5_000],
            },
          )
          .not.toBe("");
      };

      await waitForNoOrderResult();

      await expect
        .poll(
          async () => {
            const currentStatus = await readText(page, "solana-clob-status");
            if (/Order failed:/i.test(currentStatus)) {
              throw new Error(currentStatus);
            }
            const currentOrderTx = await readText(
              page,
              "solana-clob-place-order-tx",
            );
            if (
              currentOrderTx &&
              currentOrderTx !== previousNoOrderTx &&
              !currentOrderTx.endsWith("-")
            ) {
              return currentOrderTx;
            }
            const currentOrderDebug = await readText(
              page,
              "solana-clob-place-order-debug",
            );
            if (
              currentOrderDebug &&
              currentOrderDebug !== previousNoOrderDebug &&
              /failed /i.test(currentOrderDebug)
            ) {
              throw new Error(currentOrderDebug);
            }
            const currentNoBalance =
              (await clobProgram.account.userBalance.fetchNullable(
                userBalanceAddress,
              )) as UserBalanceAccount | null;
            const currentNoShares = bnLikeToBigInt(currentNoBalance?.bShares);
            const currentNoLockedLamports = bnLikeToBigInt(
              currentNoBalance?.bLockedLamports,
            );
            if (
              currentNoShares > beforeNoShares ||
              currentNoLockedLamports > beforeNoLockedLamports
            ) {
              return `state:${currentNoShares}:${currentNoLockedLamports}`;
            }
            return "";
          },
          {
            timeout: 120_000,
            intervals: [1_000, 2_000, 5_000],
          },
        )
        .not.toBe("");
    } catch (error) {
      const currentStatus = await readText(page, "solana-clob-status");
      const currentOrderError = await readText(
        page,
        "solana-clob-place-order-error",
      );
      const currentOrderDebug = await readText(
        page,
        "solana-clob-place-order-debug",
      );
      const currentOrderTx = await readText(page, "solana-clob-place-order-tx");
      const marketBalances = await loadMarketBalances(connection, state, {
        marketState,
      });
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `status=${currentStatus || "<empty>"}`,
          `orderError=${currentOrderError || "<empty>"}`,
          `orderDebug=${currentOrderDebug || "<empty>"}`,
          `orderTx=${currentOrderTx || "<empty>"}`,
          `marketBalances=${JSON.stringify(marketBalances)}`,
        ].join("\n"),
        { cause: error },
      );
    }

    const restingNoOrder = (await clobProgram.account.order.fetch(
      noOrderAddress,
    )) as OrderAccount;
    expect(bnLikeToBigInt(restingNoOrder.id)).toBe(noOrderId);
    expect((restingNoOrder.marketState as PublicKey).equals(marketState)).toBe(
      true,
    );
    expect(Number(restingNoOrder.side)).toBe(SIDE_ASK);
    expect(Number(restingNoOrder.price)).toBe(500);
    expect(bnLikeToBigInt(restingNoOrder.amount)).toBe(50_000_000n);
    expect(bnLikeToBigInt(restingNoOrder.filled)).toBe(0n);
    expect(restingNoOrder.active).toBe(true);
    const previousNoOrderId = bnLikeToBigInt(restingNoOrder.prevOrderId);
    expect(previousNoOrderId).toBeGreaterThan(0n);
    expect(bnLikeToBigInt(restingNoOrder.nextOrderId)).toBe(0n);
    const noPriceLevelAddress = derivePriceLevelPda(
      clobProgram.programId,
      marketState,
      SIDE_ASK,
      500,
    );
    const noPriceLevelBeforeCancel =
      (await clobProgram.account.priceLevel.fetch(
        noPriceLevelAddress,
      )) as PriceLevelAccount;
    const noPriceLevelOpenBeforeCancel = bnLikeToBigInt(
      noPriceLevelBeforeCancel.totalOpen,
    );
    expect(bnLikeToBigInt(noPriceLevelBeforeCancel.headOrderId)).toBe(
      previousNoOrderId,
    );
    expect(bnLikeToBigInt(noPriceLevelBeforeCancel.tailOrderId)).toBe(
      noOrderId,
    );
    const expectedCancelRefundLamports = 25_000_000n;
    const cancelledOrderRentLamports = BigInt(
      await connection.getBalance(noOrderAddress, "confirmed"),
    );
    expect(cancelledOrderRentLamports).toBeGreaterThan(0n);
    const expectedCancelWalletCreditLamports =
      expectedCancelRefundLamports + cancelledOrderRentLamports;

    await page.getByTestId("refresh-market").click();
    const managedOrderCard = page.getByTestId(
      `solana-managed-order-${noOrderId.toString()}`,
    );
    const cancelSignature = await confirmSolanaManagedOrder(page, {
      orderId: noOrderId,
      action: "CANCEL",
      outcomeText: "NO 50.0%",
      remainingText: "0.05",
      refundText: "0.025 SOL",
      rentText: `${formatSolLamports(cancelledOrderRentLamports, 9)} SOL`,
      grossCreditText: `${formatSolLamports(expectedCancelWalletCreditLamports, 9)} SOL`,
    });

    await expect
      .poll(
        async () => {
          const [walletDelta, transactionFee] = await Promise.all([
            getWalletLamportDeltaFromSignature(
              connection,
              cancelSignature,
              trader,
            ),
            getTransactionFeeFromSignature(connection, cancelSignature),
          ]);
          return walletDelta == null || transactionFee == null
            ? null
            : (walletDelta + transactionFee).toString();
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(expectedCancelWalletCreditLamports.toString());

    const cancelledNoOrder = (await clobProgram.account.order.fetchNullable(
      noOrderAddress,
    )) as OrderAccount | null;
    expect(cancelledNoOrder).toBeNull();
    const previousNoOrder = (await clobProgram.account.order.fetch(
      deriveOrderPda(clobProgram.programId, marketState, previousNoOrderId),
    )) as OrderAccount;
    expect(bnLikeToBigInt(previousNoOrder.nextOrderId)).toBe(0n);
    const noPriceLevel = (await clobProgram.account.priceLevel.fetch(
      noPriceLevelAddress,
    )) as PriceLevelAccount;
    expect(bnLikeToBigInt(noPriceLevel.totalOpen)).toBe(
      noPriceLevelOpenBeforeCancel - 50_000_000n,
    );
    expect(bnLikeToBigInt(noPriceLevel.headOrderId)).toBe(previousNoOrderId);
    expect(bnLikeToBigInt(noPriceLevel.tailOrderId)).toBe(previousNoOrderId);
    await expect(managedOrderCard).toHaveCount(0, { timeout: 30_000 });

    const filledOrderFixture = await placeE2eTraderRestingOrder(
      connection,
      state,
      {
        marketState,
        duelState,
        side: SIDE_ASK,
        price: ORDER_PRICE,
        amount: 50_000_000n,
      },
    );
    await seedClobLiquidity(connection, state, SIDE_BID, {
      marketState,
      duelState,
    });
    await expect
      .poll(
        async () => {
          const filledOrder = (await clobProgram.account.order.fetchNullable(
            filledOrderFixture.orderAddress,
          )) as OrderAccount | null;
          return filledOrder
            ? `${filledOrder.active}:${bnLikeToBigInt(filledOrder.filled)}:${bnLikeToBigInt(filledOrder.amount)}:${bnLikeToBigInt(filledOrder.prevOrderId)}:${bnLikeToBigInt(filledOrder.nextOrderId)}`
            : "missing";
        },
        { timeout: 60_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe("false:50000000:50000000:0:0");

    const filledOrderRentLamports = BigInt(
      await connection.getBalance(filledOrderFixture.orderAddress, "confirmed"),
    );
    expect(filledOrderRentLamports).toBeGreaterThan(0n);
    const [filledLevelBeforeCleanup, vaultBeforeFilledCleanup] =
      await Promise.all([
        connection.getAccountInfo(filledOrderFixture.priceLevel, "confirmed"),
        connection.getBalance(
          deriveClobVaultPda(clobProgram.programId, marketState),
          "confirmed",
        ),
      ]);
    expect(filledLevelBeforeCleanup).not.toBeNull();
    const filledLevelStateBeforeCleanup =
      (await clobProgram.account.priceLevel.fetch(
        filledOrderFixture.priceLevel,
      )) as PriceLevelAccount;
    expect(bnLikeToBigInt(filledLevelStateBeforeCleanup.totalOpen)).toBe(0n);
    expect(bnLikeToBigInt(filledLevelStateBeforeCleanup.headOrderId)).toBe(0n);
    expect(bnLikeToBigInt(filledLevelStateBeforeCleanup.tailOrderId)).toBe(0n);
    const balanceBeforeFilledCleanup =
      (await clobProgram.account.userBalance.fetch(
        userBalanceAddress,
      )) as UserBalanceAccount;

    await page.getByTestId("refresh-market").click();
    const filledOrderCard = page.getByTestId(
      `solana-managed-order-${filledOrderFixture.orderId.toString()}`,
    );
    const closeFilledSignature = await confirmSolanaManagedOrder(page, {
      orderId: filledOrderFixture.orderId,
      action: "CLOSE_FILLED",
      outcomeText: "NO 50.0%",
      remainingText: "0.05",
      rentText: `${formatSolLamports(filledOrderRentLamports, 9)} SOL`,
      grossCreditText: `${formatSolLamports(filledOrderRentLamports, 9)} SOL`,
    });
    await expect
      .poll(
        async () => {
          const [walletDelta, transactionFee] = await Promise.all([
            getWalletLamportDeltaFromSignature(
              connection,
              closeFilledSignature,
              trader,
            ),
            getTransactionFeeFromSignature(connection, closeFilledSignature),
          ]);
          return walletDelta == null || transactionFee == null
            ? null
            : (walletDelta + transactionFee).toString();
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(filledOrderRentLamports.toString());
    expect(
      await clobProgram.account.order.fetchNullable(
        filledOrderFixture.orderAddress,
      ),
    ).toBeNull();
    const [filledLevelAfterCleanup, vaultAfterFilledCleanup] =
      await Promise.all([
        connection.getAccountInfo(filledOrderFixture.priceLevel, "confirmed"),
        connection.getBalance(
          deriveClobVaultPda(clobProgram.programId, marketState),
          "confirmed",
        ),
      ]);
    expect(filledLevelAfterCleanup?.lamports).toBe(
      filledLevelBeforeCleanup?.lamports,
    );
    expect(
      Buffer.from(filledLevelAfterCleanup?.data ?? []).equals(
        Buffer.from(filledLevelBeforeCleanup?.data ?? []),
      ),
    ).toBe(true);
    expect(vaultAfterFilledCleanup).toBe(vaultBeforeFilledCleanup);
    const balanceAfterFilledCleanup =
      (await clobProgram.account.userBalance.fetch(
        userBalanceAddress,
      )) as UserBalanceAccount;
    expect({
      aShares: bnLikeToBigInt(balanceAfterFilledCleanup.aShares),
      bShares: bnLikeToBigInt(balanceAfterFilledCleanup.bShares),
      aLockedLamports: bnLikeToBigInt(
        balanceAfterFilledCleanup.aLockedLamports,
      ),
      bLockedLamports: bnLikeToBigInt(
        balanceAfterFilledCleanup.bLockedLamports,
      ),
    }).toEqual({
      aShares: bnLikeToBigInt(balanceBeforeFilledCleanup.aShares),
      bShares: bnLikeToBigInt(balanceBeforeFilledCleanup.bShares),
      aLockedLamports: bnLikeToBigInt(
        balanceBeforeFilledCleanup.aLockedLamports,
      ),
      bLockedLamports: bnLikeToBigInt(
        balanceBeforeFilledCleanup.bLockedLamports,
      ),
    });
    await expect(filledOrderCard).toHaveCount(0, { timeout: 30_000 });

    const resolutionNow = await waitForConfirmedSolanaTimestamp(
      connection,
      duelStartTs,
      120_000,
    );
    const competitiveCommitment = buildSyntheticDuelCommitment({
      cycleId: `gate10-solana-${duelId}`,
      duelId,
      duelKeyHex,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    });
    await upsertDuel(fightProgram as never, authority, duelKey, {
      status: duelStatusLocked(),
      betOpenTs,
      betCloseTs,
      duelStartTs,
      competitiveSnapshotVersion:
        competitiveCommitment.competitiveSnapshotVersion,
      competitiveSnapshotDigest:
        competitiveCommitment.competitiveSnapshotDigestBytes,
      participantAHash: competitiveCommitment.participantAHash,
      participantBHash: competitiveCommitment.participantBHash,
      metadataUri: canonicalDuelMetadata(duelId, duelKeyHex, "locked"),
    });
    await syncMarketFromDuel(
      writableClobProgram as never,
      marketState,
      duelState,
    );
    await proposeDuelResult(fightProgram as never, authority, duelKey, {
      winner: marketSideA(),
      duelEndTs: resolutionNow,
      metadataUri: canonicalDuelMetadata(duelId, duelKeyHex, "proposed"),
    });
    if (E2E_DUEL_SOURCE === "synthetic_publish") {
      await publishSolanaCycleState(request, {
        cycleId: `gate10-solana-${duelId}`,
        duelId,
        duelKeyHex,
        betOpenTs,
        betCloseTs,
        duelStartTs,
        phase: "RESOLUTION",
        winner: "A",
        duelEndTs: resolutionNow,
      });
    }

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return `${solanaMarket?.lifecycleStatus || "missing"}:${solanaMarket?.winner || "missing"}`;
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBe("PROPOSED:NONE");

    await page.getByTestId("refresh-market").click();
    await expect(page.getByTestId("solana-clob-status")).toContainText(
      /result proposed|dispute window open/i,
      {
        timeout: 30_000,
      },
    );
  });

  test("solana predictions finalize a matured proposal and claim winnings", async ({
    page,
    request,
  }, testInfo) => {
    const state = loadState();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const clobProgram = createReadonlyClobProgram(connection, state);
    let fixtures = await listSolanaTraderFixtures(connection, state);
    let now = await currentChainUnixTimestamp(connection);
    const preservedUserBalanceAddress = new PublicKey(
      state.clobUserBalance || "",
    );
    const preservedFixture = await fetchSolanaTraderFixtureByAddress(
      connection,
      state,
      preservedUserBalanceAddress,
    );
    const pinnedFixture = await fetchPinnedSolanaFixture(
      connection,
      state,
      preservedUserBalanceAddress,
    );
    let maturedFixture =
      fixtures.find(
        (fixture) =>
          fixture.duelStatus === "proposed" &&
          fixture.pendingWinner === "a" &&
          fixture.aShares > 0n &&
          fixture.finalizableAt != null &&
          fixture.finalizableAt <= now,
      ) ?? null;
    if (maturedFixture == null && REQUIRE_MATURED_SOLANA_WIN_CLAIM) {
      const pendingFixture =
        fixtures.find(
          (fixture) =>
            fixture.duelStatus === "proposed" &&
            fixture.pendingWinner === "a" &&
            fixture.aShares > 0n &&
            fixture.finalizableAt != null,
        ) ?? null;
      if (pendingFixture?.finalizableAt != null) {
        await waitForConfirmedSolanaTimestamp(
          connection,
          pendingFixture.finalizableAt,
          90_000,
        );
        fixtures = await listSolanaTraderFixtures(connection, state);
        now = await currentChainUnixTimestamp(connection);
        maturedFixture =
          fixtures.find(
            (fixture) =>
              fixture.duelStatus === "proposed" &&
              fixture.pendingWinner === "a" &&
              fixture.aShares > 0n &&
              fixture.finalizableAt != null &&
              fixture.finalizableAt <= now,
          ) ?? null;
      }
    }
    const claimedFixture = preservedFixture ?? pinnedFixture;
    const alreadyClaimedFixture =
      E2E_DUEL_SOURCE === "real_hyperia" &&
      maturedFixture == null &&
      claimedFixture != null &&
      claimedFixture.duelKeyHex === state.currentDuelKeyHex &&
      claimedFixture.marketState.toBase58() === state.clobMarketState &&
      claimedFixture.duelStatus === "resolved" &&
      claimedFixture.marketStatus === "resolved" &&
      claimedFixture.marketWinner === "a" &&
      claimedFixture.aShares === 0n &&
      claimedFixture.bShares === 0n &&
      claimedFixture.aLockedLamports === 0n &&
      claimedFixture.bLockedLamports === 0n;
    const activeFixture =
      maturedFixture ?? (alreadyClaimedFixture ? claimedFixture : null);

    if (activeFixture == null) {
      const pendingFixture =
        fixtures.find(
          (fixture) =>
            fixture.duelStatus === "proposed" &&
            fixture.pendingWinner === "a" &&
            fixture.aShares > 0n &&
            fixture.finalizableAt != null,
        ) ?? null;
      const pendingMessage =
        pendingFixture == null
          ? "No Solana proposed winner-claim fixture exists for the canary trader"
          : `No matured Solana winner-claim fixture yet; earliest finalizableAt=${pendingFixture.finalizableAt}`;
      test.skip(
        !REQUIRE_MATURED_SOLANA_WIN_CLAIM,
        `${pendingMessage}; rerun after maturity or set E2E_REQUIRE_MATURED_SOLANA_WIN_CLAIM=true to enforce the time-gated lane`,
      );
      throw new Error(pendingMessage);
    }

    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    let beforeWalletLamports = BigInt(
      await connection.getBalance(trader, "confirmed"),
    );
    let afterWalletLamports: bigint;
    let finalizeResultSig: string | null;
    let claimTx: string | null = null;
    let claimWalletLamportsDelta: bigint | null = null;
    let expectedClaimPayoutLamports: bigint | null = null;
    let reclaimedBalanceRentLamports: bigint | null = null;

    if (!alreadyClaimedFixture) {
      const claimMarket = (await clobProgram.account.marketState.fetch(
        activeFixture.marketState,
      )) as { winningsMarketMakerFeeBpsSnapshot?: unknown };
      const winningsFeeBps = bnLikeToBigInt(
        claimMarket.winningsMarketMakerFeeBpsSnapshot,
      );
      expectedClaimPayoutLamports =
        activeFixture.aShares -
        (activeFixture.aShares * winningsFeeBps) / 10_000n;
      reclaimedBalanceRentLamports = BigInt(
        await connection.getBalance(
          activeFixture.userBalanceAddress,
          "confirmed",
        ),
      );
      expect(expectedClaimPayoutLamports).toBeGreaterThan(0n);
      expect(reclaimedBalanceRentLamports).toBeGreaterThan(0n);
    }

    await gotoApp(page, {
      e2eSolanaDuelKey: activeFixture.duelKeyHex,
      e2eSolanaDuelId: activeFixture.duelId,
      e2eSolanaMarketRef: activeFixture.marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);

    if (alreadyClaimedFixture) {
      finalizeResultSig = await findRecentSuccessfulSignatureByLog(
        connection,
        activeFixture.duelState,
        "Instruction: FinalizeResult",
      );
      claimTx = await findRecentSuccessfulSignatureByLog(
        connection,
        activeFixture.userBalanceAddress,
        "Instruction: Claim",
      );
      if (claimTx != null) {
        claimWalletLamportsDelta = await getWalletLamportDeltaFromSignature(
          connection,
          claimTx,
          trader,
        );
        if (claimWalletLamportsDelta != null) {
          beforeWalletLamports -= claimWalletLamportsDelta;
        }
      }
    } else if (E2E_DUEL_SOURCE === "real_hyperia") {
      finalizeResultSig = await fightProgram.methods
        .finalizeResult(
          [...activeFixture.duelKey],
          canonicalDuelMetadata(
            activeFixture.duelId,
            activeFixture.duelKeyHex,
            "finalized",
          ),
        )
        .accountsPartial({
          finalizer: authority.publicKey,
          oracleConfig: deriveOracleConfigPda(fightProgram.programId),
          duelState: activeFixture.duelState,
        })
        .signers([authority])
        .rpc();
    } else {
      try {
        await finalizeDuelResult(
          fightProgram as never,
          authority,
          activeFixture.duelKey,
          canonicalDuelMetadata(
            activeFixture.duelId,
            activeFixture.duelKeyHex,
            "finalized",
          ),
        );
      } catch (error) {
        const racedDuel = (await fightProgram.account.duelState.fetch(
          activeFixture.duelState,
        )) as { status?: unknown };
        if (enumName(racedDuel.status) !== "resolved") {
          throw error;
        }
      }
      const finalizedDuel = (await fightProgram.account.duelState.fetch(
        activeFixture.duelState,
      )) as { status?: unknown; winner?: unknown };
      expect(enumName(finalizedDuel.status)).toBe("resolved");
      expect(enumName(finalizedDuel.winner)).toBe("a");
      finalizeResultSig = await findRecentSuccessfulSignatureByLog(
        connection,
        activeFixture.duelState,
        "Instruction: FinalizeResult",
      );
      expect(finalizeResultSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    }
    if (!alreadyClaimedFixture) {
      await syncMarketFromDuel(
        writableClobProgram as never,
        activeFixture.marketState,
        activeFixture.duelState,
      );
    }
    if (!alreadyClaimedFixture && E2E_DUEL_SOURCE === "synthetic_publish") {
      const authoritativeDuelEndTs =
        activeFixture.duelEndTs > 0
          ? activeFixture.duelEndTs
          : activeFixture.pendingDuelEndTs;
      await publishSolanaCycleState(request, {
        cycleId: `gate10-solana-${activeFixture.duelId}`,
        duelId: activeFixture.duelId,
        duelKeyHex: activeFixture.duelKeyHex,
        betOpenTs: activeFixture.betOpenTs,
        betCloseTs: activeFixture.betCloseTs,
        duelStartTs: activeFixture.duelStartTs,
        phase: "RESOLUTION",
        winner: "A",
        duelEndTs: authoritativeDuelEndTs,
      });
    }

    if (E2E_DUEL_SOURCE === "real_hyperia") {
      await expect
        .poll(
          async () => {
            const fixtures = await listSolanaTraderFixtures(connection, state);
            const resolvedFixture =
              fixtures.find((fixture) =>
                fixture.userBalanceAddress.equals(
                  activeFixture.userBalanceAddress,
                ),
              ) ?? null;
            if (resolvedFixture != null) {
              return `${resolvedFixture.marketStatus || "missing"}:${resolvedFixture.marketWinner || "missing"}`;
            }
            if (alreadyClaimedFixture) {
              const preservedResolvedFixture = await fetchPinnedSolanaFixture(
                connection,
                state,
                activeFixture.userBalanceAddress,
              );
              return `${preservedResolvedFixture?.marketStatus || "missing"}:${preservedResolvedFixture?.marketWinner || "missing"}`;
            }
            return "missing:missing";
          },
          {
            timeout: 60_000,
            intervals: [1_000, 2_000, 5_000],
          },
        )
        .toBe("resolved:a");
    } else {
      await expect
        .poll(
          async () => {
            const predictionMarkets = await fetchPredictionMarkets(request);
            const solanaMarket = findPredictionMarket(
              predictionMarkets,
              "solana",
            );
            return `${solanaMarket?.lifecycleStatus || "missing"}:${solanaMarket?.winner || "missing"}`;
          },
          {
            timeout: 60_000,
            intervals: [1_000, 2_000, 5_000],
          },
        )
        .toBe("RESOLVED:A");
    }

    await gotoApp(page, {
      e2eSolanaDuelKey: activeFixture.duelKeyHex,
      e2eSolanaDuelId: activeFixture.duelId,
      e2eSolanaMarketRef: activeFixture.marketState.toBase58(),
      debug: false,
    });
    await selectChain(page, "solana");
    await ensureWalletConnected(page);
    const publicWinnerLog = page.getByTestId("duels-bottom-panel-news");
    await expect(publicWinnerLog).toContainText("Agent A wins the round.", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("spectator-terminal-outcome")).toContainText(
      "Agent A wins — Knockout.",
    );
    await testInfo.attach("solana-winner-public-desktop", {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });

    const winningHistoryEntries = settlementEntriesForDuel(
      page,
      activeFixture.duelId,
    );
    let claimStartedAtMs: number | null = null;
    let claimToIndexedHistoryMs: number | null = null;
    if (!alreadyClaimedFixture) {
      await expect(
        page.getByTestId("solana-clob-settlement-action"),
      ).toContainText("Claim winnings", { timeout: 60_000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("mobile-watch-summary")).toContainText(
        "RESOLVED",
      );
      expect(
        await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })),
      ).toEqual({ clientWidth: 390, scrollWidth: 390 });
      const winnerReviewButton = page.locator(".hm-bet-fab");
      await expect(winnerReviewButton).toBeVisible();
      expect(
        await winnerReviewButton.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      ).toBeGreaterThanOrEqual(44);
      await winnerReviewButton.click();
      const mobileWinnerSheet = page.getByRole("dialog", {
        name: /trading controls/i,
      });
      await expect(mobileWinnerSheet).toBeVisible();
      await expect(mobileWinnerSheet).toContainText("RESOLVED");
      const claimButton = mobileWinnerSheet
        .getByRole("button", { name: /claim winnings/i })
        .first();
      await expect(claimButton).toBeVisible({ timeout: 30_000 });
      await expect(claimButton).toBeEnabled();
      expect(
        await claimButton.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      ).toBeGreaterThanOrEqual(44);
      await testInfo.attach("solana-winner-public-mobile", {
        body: await page.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      });

      claimStartedAtMs = Date.now();
      await claimButton.click();
      claimTx = await expectSolanaSettlementReceipt(
        page,
        /claim confirmed on-chain/i,
      );
      await expect(
        winningHistoryEntries.getByRole("button", {
          name: /claim winnings/i,
        }),
      ).toHaveCount(0, { timeout: 2_000 });
      await expect(mobileWinnerSheet).toContainText(
        "Settlement history is catching up",
      );
      await testInfo.attach("solana-winner-claim-indexing", {
        body: await page.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      });
      const [signatureWalletDelta, transactionFee] = await Promise.all([
        getWalletLamportDeltaFromSignature(connection, claimTx, trader),
        getTransactionFeeFromSignature(connection, claimTx),
      ]);
      expect(signatureWalletDelta).not.toBeNull();
      expect(transactionFee).not.toBeNull();
      expect((signatureWalletDelta ?? 0n) + (transactionFee ?? 0n)).toBe(
        (expectedClaimPayoutLamports ?? 0n) +
          (reclaimedBalanceRentLamports ?? 0n),
      );
      claimWalletLamportsDelta = signatureWalletDelta;
    }

    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            activeFixture.userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.bShares)}`;
        },
        {
          timeout: 120_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBe("0:0");

    if (alreadyClaimedFixture) {
      expect(claimWalletLamportsDelta ?? 0n).toBeGreaterThan(0n);
      afterWalletLamports =
        beforeWalletLamports + (claimWalletLamportsDelta ?? 0n);
    } else {
      afterWalletLamports = BigInt(
        await connection.getBalance(trader, "confirmed"),
      );
      claimWalletLamportsDelta = afterWalletLamports - beforeWalletLamports;
      expect(afterWalletLamports).toBeGreaterThan(beforeWalletLamports);
    }
    await expect(page.getByTestId("solana-clob-claim-payout")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("solana-clob-settlement-action")).toHaveCount(
      0,
      { timeout: 30_000 },
    );
    if (!alreadyClaimedFixture && claimTx) {
      const readWinnerSettlementHistory = async () => {
        const response = await fetchJson<{
          ledger?: { current?: boolean };
          entries?: Array<{
            duelId?: string;
            marketPda?: string;
            settlementState?: string;
            claimSignature?: string | null;
          }>;
        }>(
          request,
          `/api/arena/settlements/${encodeURIComponent(
            trader.toBase58(),
          )}?limit=100&offset=0`,
        );
        const exactEntries = (response.entries ?? []).filter(
          (entry) =>
            entry.duelId === activeFixture.duelId &&
            entry.marketPda === activeFixture.marketState.toBase58(),
        );
        return {
          ledgerCurrent: response.ledger?.current === true,
          hasPaidWinner: exactEntries.some(
            (entry) =>
              entry.settlementState === "PAID" &&
              entry.claimSignature === claimTx,
          ),
          hasClaimableWinner: exactEntries.some(
            (entry) => entry.settlementState === "PAYOUT_CLAIMABLE",
          ),
        };
      };
      await expect
        .poll(readWinnerSettlementHistory, {
          timeout: 90_000,
          intervals: [250, 500, 1_000, 2_000, 5_000],
        })
        .toEqual({
          ledgerCurrent: true,
          hasPaidWinner: true,
          hasClaimableWinner: false,
        });
      await expect
        .poll(
          async () => ({
            hasPaidWinner: (await winningHistoryEntries.allTextContents()).some(
              (value) => value.includes("Winnings paid"),
            ),
            claimButtons: await winningHistoryEntries
              .getByRole("button", { name: /claim winnings/i })
              .count(),
          }),
          { timeout: 15_000, intervals: [250, 500, 1_000, 2_000, 5_000] },
        )
        .toEqual({ hasPaidWinner: true, claimButtons: 0 });
      expect(claimStartedAtMs).not.toBeNull();
      claimToIndexedHistoryMs = Date.now() - (claimStartedAtMs ?? Date.now());
    }
    if (E2E_DUEL_SOURCE === "real_hyperia") {
      expect(finalizeResultSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(claimTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    }
    await testInfo.attach("solana-matured-claim-ui", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await testInfo.attach("solana-matured-claim-evidence", {
      body: Buffer.from(
        JSON.stringify(
          {
            duelId: activeFixture.duelId,
            duelKeyHex: activeFixture.duelKeyHex,
            marketState: activeFixture.marketState.toBase58(),
            duelState: activeFixture.duelState.toBase58(),
            finalizeResultSig,
            claimTx,
            beforeWalletLamports: beforeWalletLamports.toString(),
            afterWalletLamports: afterWalletLamports.toString(),
            claimWalletLamportsDelta:
              claimWalletLamportsDelta?.toString() ?? null,
            expectedClaimPayoutLamports:
              expectedClaimPayoutLamports?.toString() ?? null,
            reclaimedBalanceRentLamports:
              reclaimedBalanceRentLamports?.toString() ?? null,
            claimToIndexedHistoryMs,
            finalizableAt: activeFixture.finalizableAt,
            alreadyClaimedFixture,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  });

  test("solana resolved loser closes the stale balance and recovers exact rent", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      E2E_DUEL_SOURCE === "real_hyperia",
      "loser cleanup remains a synthetic Solana browser lane for now",
    );
    test.setTimeout(300_000);

    const state = loadState();
    const control = loadControl();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const {
      duelKey,
      duelKeyHex,
      duelId,
      duelState,
      marketState,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    } = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-loser-cleanup",
      {
        betCloseOffsetSeconds: 60,
        duelStartOffsetSeconds: 60,
      },
    );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return `${predictionMarkets.duel.duelKey}:${solanaMarket?.marketRef ?? "missing"}:${solanaMarket?.lifecycleStatus ?? "missing"}`;
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(`${duelKeyHex}:${marketState.toBase58()}:OPEN`);

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);

    await seedClobLiquidity(connection, state, SIDE_BID, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();
    const clobPanel = page.getByTestId("solana-clob-panel").first();
    await openSolanaBuyOrderEntry(page, clobPanel);
    await clobPanel
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await selectSolanaPredictionSide(clobPanel, "no");
    const noPriceInput = clobPanel.getByTestId("solana-clob-price-input");
    if (await noPriceInput.isVisible().catch(() => false)) {
      await noPriceInput.fill(String(ORDER_PRICE));
    }
    const buyNoButton = clobPanel
      .getByRole("button", { name: /buy no/i })
      .first();
    await expect(buyNoButton).toBeEnabled({ timeout: 30_000 });
    await buyNoButton.click();
    await confirmSolanaOrder(page);

    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.bShares)}:${bnLikeToBigInt(balance?.aLockedLamports)}:${bnLikeToBigInt(balance?.bLockedLamports)}`;
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("0:50000000:0:25000000");

    const balanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    expect(balanceRentLamports).toBeGreaterThan(0n);

    const resolutionNow = await waitForConfirmedSolanaTimestamp(
      connection,
      duelStartTs,
      120_000,
    );
    const competitiveCommitment = buildSyntheticDuelCommitment({
      cycleId: `gate10-solana-${duelId}`,
      duelId,
      duelKeyHex,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    });
    await upsertDuel(fightProgram as never, authority, duelKey, {
      status: duelStatusLocked(),
      betOpenTs,
      betCloseTs,
      duelStartTs,
      competitiveSnapshotVersion:
        competitiveCommitment.competitiveSnapshotVersion,
      competitiveSnapshotDigest:
        competitiveCommitment.competitiveSnapshotDigestBytes,
      participantAHash: competitiveCommitment.participantAHash,
      participantBHash: competitiveCommitment.participantBHash,
      metadataUri: canonicalDuelMetadata(duelId, duelKeyHex, "locked"),
    });
    await syncMarketFromDuel(
      writableClobProgram as never,
      marketState,
      duelState,
    );
    await proposeDuelResult(fightProgram as never, authority, duelKey, {
      winner: marketSideA(),
      duelEndTs: resolutionNow,
      metadataUri: canonicalDuelMetadata(duelId, duelKeyHex, "proposed"),
    });

    const proposedFixture = (
      await listSolanaTraderFixtures(connection, state)
    ).find((fixture) => fixture.marketState.equals(marketState));
    expect(proposedFixture?.finalizableAt).not.toBeNull();
    expect(proposedFixture?.finalizableAt).toBeDefined();
    await waitForConfirmedSolanaTimestamp(
      connection,
      proposedFixture?.finalizableAt ?? 0,
      90_000,
    );
    try {
      await finalizeDuelResult(
        fightProgram as never,
        authority,
        duelKey,
        canonicalDuelMetadata(duelId, duelKeyHex, "finalized"),
      );
    } catch (error) {
      const racedDuel = (await fightProgram.account.duelState.fetch(
        duelState,
      )) as { status?: unknown };
      if (enumName(racedDuel.status) !== "resolved") {
        throw error;
      }
    }
    const finalizedLosingDuel = (await fightProgram.account.duelState.fetch(
      duelState,
    )) as { status?: unknown; winner?: unknown };
    expect(enumName(finalizedLosingDuel.status)).toBe("resolved");
    expect(enumName(finalizedLosingDuel.winner)).toBe("a");
    await syncMarketFromDuel(
      writableClobProgram as never,
      marketState,
      duelState,
    );
    await publishSolanaCycleState(request, {
      cycleId: `gate10-solana-${duelId}`,
      duelId,
      duelKeyHex,
      betOpenTs,
      betCloseTs,
      duelStartTs,
      phase: "RESOLUTION",
      winner: "A",
      duelEndTs: await currentChainUnixTimestamp(connection),
    });

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return `${solanaMarket?.lifecycleStatus ?? "missing"}:${solanaMarket?.winner ?? "missing"}`;
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("RESOLVED:A");

    const rolloverMarket = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-post-loser-cleanup-rollover",
    );
    await gotoApp(page, {
      e2eSolanaDuelKey: rolloverMarket.duelKeyHex,
      e2eSolanaDuelId: rolloverMarket.duelId,
      e2eSolanaMarketRef: rolloverMarket.marketState.toBase58(),
      debug: false,
    });
    await selectChain(page, "solana");
    const rolloverExpandButton = page
      .locator('button[title="Expand panel"]')
      .first();
    if (await rolloverExpandButton.isVisible().catch(() => false)) {
      await rolloverExpandButton.click();
    }
    await ensureWalletConnected(page);
    const rolloverRoot = page.locator(".hm-root").first();
    await expect(rolloverRoot).toHaveAttribute(
      "data-stream-duel-id",
      rolloverMarket.duelId,
      { timeout: 60_000 },
    );
    await expect(rolloverRoot).toHaveAttribute(
      "data-market-duel-id",
      rolloverMarket.duelId,
    );
    await expect(rolloverRoot).toHaveAttribute(
      "data-market-can-place-bet",
      "true",
    );

    const historicalLosingActivity = settlementEntriesForDuel(page, duelId);
    await expect(historicalLosingActivity).toHaveCount(1, { timeout: 60_000 });
    await expect(historicalLosingActivity).toContainText(
      "Resolved · no payout",
    );
    await expect(
      historicalLosingActivity.getByRole("button", {
        name: /recover order rent/i,
      }),
    ).toHaveCount(0);
    const cleanupButton = historicalLosingActivity.getByRole("button", {
      name: /clear position/i,
    });
    await expect(cleanupButton).toBeEnabled({ timeout: 30_000 });
    await cleanupButton.click();
    const cleanupTx = await expectSolanaSettlementReceipt(
      page,
      /position cleanup confirmed on-chain/i,
    );
    const [cleanupWalletDelta, cleanupTransactionFee] = await Promise.all([
      getWalletLamportDeltaFromSignature(connection, cleanupTx, trader),
      getTransactionFeeFromSignature(connection, cleanupTx),
    ]);
    expect(cleanupWalletDelta).not.toBeNull();
    expect(cleanupTransactionFee).not.toBeNull();
    expect((cleanupWalletDelta ?? 0n) + (cleanupTransactionFee ?? 0n)).toBe(
      balanceRentLamports,
    );
    expect(
      await clobProgram.account.userBalance.fetchNullable(userBalanceAddress),
    ).toBeNull();
    await expect(page.getByTestId("solana-clob-claim-payout")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect
      .poll(
        async () =>
          page.evaluate(
            async ({ keeperOrigin, wallet, exactDuelId, exactCleanupTx }) => {
              const response = await fetch(
                `${keeperOrigin}/api/arena/settlements/${encodeURIComponent(wallet)}?limit=4&offset=0`,
                { cache: "no-store" },
              );
              if (!response.ok) {
                return {
                  status: response.status,
                  current: false,
                  terminalKind: null,
                  claimMatches: false,
                };
              }
              const body = (await response.json()) as {
                ledger?: { current?: unknown };
                entries?: Array<{
                  duelId?: unknown;
                  terminalKind?: unknown;
                  claimSignature?: unknown;
                }>;
              };
              const entry = body.entries?.find(
                (candidate) => candidate.duelId === exactDuelId,
              );
              return {
                status: response.status,
                current: body.ledger?.current === true,
                terminalKind: entry?.terminalKind ?? null,
                claimMatches: entry?.claimSignature === exactCleanupTx,
              };
            },
            {
              keeperOrigin: new URL(control.services.keeper.healthUrl).origin,
              wallet: trader.toBase58(),
              exactDuelId: duelId,
              exactCleanupTx: cleanupTx,
            },
          ),
        { timeout: 60_000, intervals: [500, 1_000, 2_000, 5_000] },
      )
      .toEqual({
        status: 200,
        current: true,
        terminalKind: "LOSER_CLEANUP",
        claimMatches: true,
      });
    await page.getByTestId("solana-settlement-refresh").click();
    await expect
      .poll(
        async () => ({
          cleanupButtons: await historicalLosingActivity
            .getByRole("button", { name: /clear position/i })
            .count(),
          positionClosed:
            (await historicalLosingActivity.textContent())?.includes(
              "Position closed · no payout",
            ) ?? false,
          rentButtons: await historicalLosingActivity
            .getByRole("button", { name: /recover order rent/i })
            .count(),
        }),
        { timeout: 30_000, intervals: [250, 500, 1_000, 2_000] },
      )
      .toEqual({
        cleanupButtons: 0,
        positionClosed: true,
        rentButtons: 1,
      });

    await testInfo.attach("solana-loser-cleanup-ui", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await testInfo.attach("solana-loser-cleanup-evidence", {
      body: Buffer.from(
        JSON.stringify(
          {
            duelId,
            duelKeyHex,
            marketState: marketState.toBase58(),
            duelState: duelState.toBase58(),
            cleanupTx,
            cleanupWalletDelta: cleanupWalletDelta?.toString() ?? null,
            cleanupTransactionFee: cleanupTransactionFee?.toString() ?? null,
            balanceRentLamports: balanceRentLamports.toString(),
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  });

  test("solana open prediction markets recover after keeper and proxy restarts", async ({
    page,
    request,
  }, testInfo) => {
    let browserRpcRequestCount = 0;
    const browserRpcMethods = new Map<string, number>();
    page.on("request", (browserRequest) => {
      try {
        if (new URL(browserRequest.url()).pathname === "/__solana/rpc") {
          browserRpcRequestCount += 1;
          const payload = browserRequest.postDataJSON() as
            { method?: unknown } | Array<{ method?: unknown }>;
          const entries = Array.isArray(payload) ? payload : [payload];
          for (const entry of entries) {
            const method =
              typeof entry?.method === "string" ? entry.method : "unknown";
            browserRpcMethods.set(
              method,
              (browserRpcMethods.get(method) ?? 0) + 1,
            );
          }
        }
      } catch {
        // Ignore non-URL browser-internal requests.
      }
    });
    const state = loadState();
    const control = loadControl();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const { duelId, duelKeyHex, duelState, marketState } =
      await createFreshSolanaOpenMarket(
        request,
        state,
        authority,
        fightProgram,
        writableClobProgram,
        "gate10-solana-restart",
        {
          betCloseOffsetSeconds: 90,
          duelStartOffsetSeconds: 150,
        },
      );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: "OPEN",
      });

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    await seedClobLiquidity(connection, state, SIDE_ASK, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();
    await page
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await page.getByTestId("prediction-select-yes").click();

    const beforeBalance = (await clobProgram.account.userBalance.fetchNullable(
      userBalanceAddress,
    )) as UserBalanceAccount | null;
    const beforeYes = bnLikeToBigInt(beforeBalance?.aShares);

    const restartSubmitButton = page.getByTestId("prediction-submit");
    await expect(restartSubmitButton).toBeEnabled({ timeout: 30_000 });
    await restartSubmitButton.click();
    await confirmSolanaOrder(page);

    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return Number(bnLikeToBigInt(balance?.aShares) - beforeYes);
        },
        {
          timeout: 120_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBeGreaterThan(0);

    runProcessControl(control, "restart", "keeperBot");
    await waitForKeeperBotHealth(request, "solana", marketState.toBase58());

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: "OPEN",
      });

    if (E2E_DUEL_SOURCE !== "real_hyperia") {
      runProcessControl(control, "restart", "solanaProxy");
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    await page.getByTestId("refresh-market").click();
    await expect(page.getByTestId("market-status")).toContainText(/open/i, {
      timeout: 60_000,
    });

    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return Number(bnLikeToBigInt(balance?.aShares) - beforeYes);
        },
        {
          timeout: 120_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBeGreaterThan(0);

    const browserRpcEvidence = {
      requestCount: browserRpcRequestCount,
      methodCounts: Object.fromEntries(
        [...browserRpcMethods].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };
    console.info(
      `[e2e] browser RPC evidence ${JSON.stringify(browserRpcEvidence)}`,
    );
    await testInfo.attach("browser-rpc-evidence", {
      body: Buffer.from(JSON.stringify(browserRpcEvidence, null, 2)),
      contentType: "application/json",
    });

    expect(
      browserRpcRequestCount,
      "the prediction-market panel must not enter a render-triggered RPC refresh loop",
    ).toBeLessThanOrEqual(250);
    for (const [method, budget] of [
      ["getGenesisHash", 15],
      ["getProgramAccounts", 70],
      ["getAccountInfo", 100],
    ] as const) {
      expect(
        browserRpcMethods.get(method) ?? 0,
        `${method} must remain within the restart-recovery browser RPC budget`,
      ).toBeLessThanOrEqual(budget);
    }
  });

  test("solana open prediction markets recover after Hyperia restarts and settle exactly", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      E2E_DUEL_SOURCE !== "real_hyperia",
      "Hyperia restart recovery is only meaningful in real-duel mode",
    );
    test.setTimeout(600_000);
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const state = loadState();
    const control = loadControl();
    const hyperiaControl = control.services.hyperia;
    if (!hyperiaControl) {
      throw new Error("real Hyperia process control is missing");
    }
    const launchPathEntries = control.launchPath.split(":");
    expect(launchPathEntries).not.toContain("");
    expect(launchPathEntries.every((entry) => path.isAbsolute(entry))).toBe(
      true,
    );
    const configuredNodePath =
      hyperiaControl.startCommand?.match(/^exec "([^"]+)" /)?.[1] ?? null;
    expect(configuredNodePath).toMatch(/\/node$/);
    const reuseGameBuilds =
      hyperiaControl.startCommand?.includes("--reuse-game-builds") ?? false;
    expect(reuseGameBuilds).toBe(process.env.E2E_SKIP_PREBUILD === "true");
    const resolvedLaunchNodePath =
      launchPathEntries
        .map((entry) => path.join(entry, "node"))
        .find((candidate) => fs.existsSync(candidate)) ?? null;
    expect(resolvedLaunchNodePath).not.toBeNull();
    expect(
      configuredNodePath && resolvedLaunchNodePath
        ? fs.realpathSync(resolvedLaunchNodePath) ===
            fs.realpathSync(configuredNodePath)
        : false,
    ).toBe(true);
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const { duelKeyHex, duelId, duelState, marketState } =
      await createFreshSolanaOpenMarket(
        request,
        state,
        authority,
        fightProgram,
        writableClobProgram,
        "gate10-solana-hyperia-restart",
        {
          betCloseOffsetSeconds: 90,
          duelStartOffsetSeconds: 150,
        },
      );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: "OPEN",
      });

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    await seedClobLiquidity(connection, state, SIDE_ASK, {
      marketState,
      duelState,
    });
    const clobPanel = page.getByTestId("solana-clob-panel").first();
    const browserOrders: Array<{
      outcome: "yes" | "no";
      signature: string;
      shareDelta: string;
    }> = [];
    const buyMatchedOutcome = async (
      outcome: "yes" | "no",
      liquiditySide: number,
      shareField: "aShares" | "bShares",
    ): Promise<void> => {
      const before = (await clobProgram.account.userBalance.fetchNullable(
        userBalanceAddress,
      )) as UserBalanceAccount | null;
      const beforeShares = bnLikeToBigInt(before?.[shareField]);
      await seedClobLiquidity(connection, state, liquiditySide, {
        marketState,
        duelState,
      });
      await page.getByTestId("refresh-market").click();
      await openSolanaBuyOrderEntry(page, clobPanel);
      await clobPanel
        .getByTestId("prediction-amount-input")
        .fill(SOLANA_PREDICTION_AMOUNT);
      await selectSolanaPredictionSide(clobPanel, outcome);
      const priceInput = clobPanel.getByTestId("solana-clob-price-input");
      if (await priceInput.isVisible().catch(() => false)) {
        await priceInput.fill(String(ORDER_PRICE));
      }
      const submit = clobPanel
        .getByRole("button", { name: new RegExp(`buy ${outcome}`, "i") })
        .first();
      await expect(submit).toBeEnabled({ timeout: 30_000 });
      await submit.click();
      await confirmSolanaOrder(page);
      const signature = (
        (await page
          .getByTestId("solana-order-transaction-signature")
          .first()
          .textContent()) ?? ""
      ).trim();
      expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
      await expect
        .poll(
          async () => {
            const balance =
              (await clobProgram.account.userBalance.fetchNullable(
                userBalanceAddress,
              )) as UserBalanceAccount | null;
            return bnLikeToBigInt(balance?.[shareField]).toString();
          },
          { timeout: 120_000, intervals: [500, 1_000, 2_000, 5_000] },
        )
        .toBe((beforeShares + 50_000_000n).toString());
      browserOrders.push({
        outcome,
        signature,
        shareDelta: "50000000",
      });
    };

    // Commit both sides before process loss. Recovery must preserve these exact
    // funds and settle them against the immutable duel; renderer requalification
    // is allowed to cross the already-committed betting close and never extends it.
    await buyMatchedOutcome("yes", SIDE_ASK, "aShares");
    await buyMatchedOutcome("no", SIDE_BID, "bShares");
    const fundedBalanceBeforeRestart =
      (await clobProgram.account.userBalance.fetch(
        userBalanceAddress,
      )) as UserBalanceAccount;
    expect({
      aShares: bnLikeToBigInt(fundedBalanceBeforeRestart.aShares),
      bShares: bnLikeToBigInt(fundedBalanceBeforeRestart.bShares),
      aLockedLamports: bnLikeToBigInt(
        fundedBalanceBeforeRestart.aLockedLamports,
      ),
      bLockedLamports: bnLikeToBigInt(
        fundedBalanceBeforeRestart.bLockedLamports,
      ),
    }).toEqual({
      aShares: 50_000_000n,
      bShares: 50_000_000n,
      aLockedLamports: 25_000_000n,
      bLockedLamports: 25_000_000n,
    });
    const exactMarketBeforeRestart =
      (await clobProgram.account.marketState.fetch(
        marketState,
      )) as MarketStateAccount & {
        status?: unknown;
      };
    expect(enumName(exactMarketBeforeRestart.status)).toBe("open");
    expect(runtimeErrors).toEqual([]);

    const sourceBefore = await fetchHyperiaAuthorityHealth(request, control);
    expect(sourceBefore).toMatchObject({
      ready: true,
      duelId,
      duelKeyHex,
      outcome: null,
      cancellationReason: null,
      competitiveSnapshotPersisted: true,
      competitiveSnapshotDiagnostic: false,
    });
    expect(sourceBefore.sourceEpoch).toEqual(expect.any(Number));
    expect(sourceBefore.snapshotDigest).toEqual(expect.any(String));
    const initialPid = readOwnedProcessId(
      hyperiaControl.pidFile,
      "initial Hyperia supervisor",
    );
    const initialProcessCommand = readProcessCommand(initialPid);
    expect(initialProcessCommand).toContain(configuredNodePath ?? "");
    expect(initialProcessCommand).toContain("scripts/duel-stack.mjs");
    expect(initialProcessCommand.includes("--reuse-game-builds")).toBe(
      reuseGameBuilds,
    );
    const controlSha256 = createHash("sha256")
      .update(fs.readFileSync(control.controlPath))
      .digest("hex");

    const restartStartedAtMs = Date.now();
    runProcessControl(control, "restart", "hyperia");

    await expect
      .poll(
        async () => {
          const response = await request.get(
            `${GAME_API_URL}/api/streaming/state`,
            { failOnStatusCode: false },
          );
          if (!response.ok()) {
            return { duelKey: null, duelId: null };
          }
          const streamState = (await response.json()) as {
            cycle?: {
              duelId?: string | number | null;
              duelKeyHex?: string | null;
            } | null;
          };
          return {
            duelKey: streamState.cycle?.duelKeyHex ?? null,
            duelId:
              streamState.cycle?.duelId != null
                ? String(streamState.cycle.duelId)
                : null,
          };
        },
        {
          timeout: 90_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        duelKey: duelKeyHex,
        duelId: state.currentDuelId ?? null,
      });
    const restartRecoveredMs = Date.now() - restartStartedAtMs;
    await expect
      .poll(
        async () => {
          try {
            const recovered = await fetchHyperiaAuthorityHealth(
              request,
              control,
            );
            return {
              status: "ready",
              duelId: recovered.duelId ?? null,
              duelKeyHex: recovered.duelKeyHex ?? null,
              snapshotDigest: recovered.snapshotDigest ?? null,
            };
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "Hyperia authority health returned HTTP 503"
            ) {
              return {
                status: "temporarily_unavailable",
                duelId: null,
                duelKeyHex: null,
                snapshotDigest: null,
              };
            }
            throw error;
          }
        },
        { timeout: 90_000, intervals: [250, 500, 1_000, 2_000, 5_000] },
      )
      .toEqual({
        status: "ready",
        duelId,
        duelKeyHex,
        snapshotDigest: sourceBefore.snapshotDigest,
      });
    const sourceAfter = await fetchHyperiaAuthorityHealth(request, control);
    expect(sourceAfter).toMatchObject({
      ready: true,
      duelId,
      duelKeyHex,
      snapshotDigest: sourceBefore.snapshotDigest,
      outcome: null,
      cancellationReason: null,
      competitiveSnapshotPersisted: true,
      competitiveSnapshotDiagnostic: false,
    });
    expect(sourceAfter.sourceEpoch).toEqual(expect.any(Number));
    expect(sourceAfter.sourceEpoch).not.toBe(sourceBefore.sourceEpoch);
    const restartedPid = readOwnedProcessId(
      hyperiaControl.pidFile,
      "restarted Hyperia supervisor",
    );
    expect(restartedPid).not.toBe(initialPid);
    const restartedProcessCommand = readProcessCommand(restartedPid);
    expect(restartedProcessCommand).toContain(configuredNodePath ?? "");
    expect(restartedProcessCommand).toContain("scripts/duel-stack.mjs");
    expect(restartedProcessCommand.includes("--reuse-game-builds")).toBe(
      reuseGameBuilds,
    );

    let rendererRestartEvidence: Record<string, unknown> | null = null;
    if (E2E_HYPERIA_RUNTIME === "full_3d") {
      await expect
        .poll(
          () => {
            const renderer = readHyperiaRendererStatus(control);
            return {
              source: renderer?.source ?? null,
              updatedAfterRestart:
                (renderer?.updatedAt ?? 0) >= restartStartedAtMs,
              ready: renderer?.rendererHealth?.ready ?? false,
              degradedReason:
                renderer?.rendererHealth &&
                "degradedReason" in renderer.rendererHealth
                  ? renderer.rendererHealth.degradedReason
                  : "missing",
            };
          },
          { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] },
        )
        .toEqual({
          source: "external-rtmp-bridge",
          updatedAfterRestart: true,
          ready: true,
          degradedReason: null,
        });
      const renderer = readHyperiaRendererStatus(control);
      rendererRestartEvidence = {
        source: renderer?.source ?? null,
        updatedAt: renderer?.updatedAt ?? null,
        phase: renderer?.rendererHealth?.phase ?? null,
        sceneCycleId:
          renderer?.rendererHealth?.diagnostics?.sceneReadiness?.cycleId ??
          null,
        equipmentAttachmentMismatchCount:
          renderer?.rendererHealth?.diagnostics?.sceneReadiness
            ?.equipmentAttachmentMismatchCount ?? null,
        ffmpegRunning: renderer?.stats?.ffmpegRunning ?? false,
        audioHealthy: renderer?.stats?.audioHealthy ?? false,
      };
    }

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: expect.stringMatching(/^(OPEN|LOCKED)$/),
      });

    await page.reload({ waitUntil: "domcontentloaded" });
    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    let hlsPlaybackEvidence: Record<string, unknown> | null = null;
    if (E2E_HYPERIA_RUNTIME === "full_3d") {
      const video = page.locator("video[data-stream-source]").first();
      const samplePlayback = () =>
        video.evaluate((element: HTMLVideoElement) => ({
          source: element.dataset.streamSource || "",
          readyState: element.readyState,
          paused: element.paused,
          videoWidth: element.videoWidth,
          videoHeight: element.videoHeight,
          currentTime: element.currentTime,
          totalVideoFrames:
            typeof element.getVideoPlaybackQuality === "function"
              ? element.getVideoPlaybackQuality().totalVideoFrames
              : 0,
        }));
      await expect
        .poll(samplePlayback, {
          timeout: 45_000,
          intervals: [250, 500, 1_000, 2_000],
        })
        .toMatchObject({
          readyState: expect.any(Number),
          paused: false,
          videoWidth: 1280,
          videoHeight: 720,
          currentTime: expect.any(Number),
        });
      const beforePlayback = await samplePlayback();
      await page.waitForTimeout(2_500);
      const afterPlayback = await samplePlayback();
      expect(beforePlayback.source).toMatch(/\/live\/stream\.m3u8$/);
      expect(beforePlayback.currentTime).toBeGreaterThan(0);
      expect(
        afterPlayback.currentTime - beforePlayback.currentTime,
      ).toBeGreaterThan(1);
      expect(afterPlayback.totalVideoFrames).toBeGreaterThan(
        beforePlayback.totalVideoFrames,
      );
      hlsPlaybackEvidence = { before: beforePlayback, after: afterPlayback };
    }
    const fundedBalanceAfterRestart =
      (await clobProgram.account.userBalance.fetch(
        userBalanceAddress,
      )) as UserBalanceAccount;
    expect({
      aShares: bnLikeToBigInt(fundedBalanceAfterRestart.aShares),
      bShares: bnLikeToBigInt(fundedBalanceAfterRestart.bShares),
      aLockedLamports: bnLikeToBigInt(
        fundedBalanceAfterRestart.aLockedLamports,
      ),
      bLockedLamports: bnLikeToBigInt(
        fundedBalanceAfterRestart.bLockedLamports,
      ),
    }).toEqual({
      aShares: 50_000_000n,
      bShares: 50_000_000n,
      aLockedLamports: 25_000_000n,
      bLockedLamports: 25_000_000n,
    });
    expect(runtimeErrors).toEqual([]);

    let terminal: HyperiaStreamingState | null = null;
    const terminalDeadline = Date.now() + 360_000;
    while (Date.now() < terminalDeadline) {
      const current = await fetchHyperiaStreamingState(request, control);
      const cycle = current.cycle;
      if (
        cycle?.duelId !== duelId ||
        cycle.duelKeyHex !== duelKeyHex ||
        cycle.competitiveSnapshotDigest !== sourceBefore.snapshotDigest
      ) {
        throw new Error(
          `public stream identity drifted after authority restart: ${JSON.stringify(cycle)}`,
        );
      }
      if (cycle.phase === "RESOLUTION") {
        terminal = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!terminal?.cycle) {
      throw new Error("recovered Hyperia duel did not reach RESOLUTION");
    }
    const terminalCycle = terminal.cycle;
    const winnerSide =
      terminalCycle.winnerId === terminalCycle.agent1?.id
        ? "a"
        : terminalCycle.winnerId === terminalCycle.agent2?.id
          ? "b"
          : null;
    if (winnerSide === null) {
      throw new Error("recovered Hyperia terminal winner is not a contestant");
    }
    expect({
      outcome: terminalCycle.outcome,
      winnerSide,
      replayHash: terminalCycle.replayHash,
    }).toEqual({
      outcome: "win",
      winnerSide: expect.stringMatching(/^(a|b)$/),
      replayHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    await expect
      .poll(
        async () => {
          const fixtures = await listSolanaTraderFixtures(connection, state);
          const fixture =
            fixtures.find((entry) => entry.marketState.equals(marketState)) ??
            null;
          return `${fixture?.duelStatus ?? "missing"}:${fixture?.marketStatus ?? "missing"}:${fixture?.marketWinner ?? "missing"}`;
        },
        { timeout: 150_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(`resolved:resolved:${winnerSide}`);

    const resolvedMarket = (await clobProgram.account.marketState.fetch(
      marketState,
    )) as MarketStateAccount & {
      status?: unknown;
      winningsMarketMakerFeeBpsSnapshot?: unknown;
    };
    expect(enumName(resolvedMarket.status)).toBe("resolved");
    const winningShares =
      winnerSide === "a"
        ? bnLikeToBigInt(fundedBalanceAfterRestart.aShares)
        : bnLikeToBigInt(fundedBalanceAfterRestart.bShares);
    const winningsFeeBps = bnLikeToBigInt(
      resolvedMarket.winningsMarketMakerFeeBpsSnapshot,
    );
    const expectedPayoutLamports =
      winningShares - (winningShares * winningsFeeBps) / 10_000n;
    const userBalanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    const beforeClaimWalletLamports = BigInt(
      await connection.getBalance(trader, "confirmed"),
    );

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
      debug: false,
    });
    await selectChain(page, "solana");
    await ensureWalletConnected(page);
    await expect(
      page.getByTestId("solana-clob-settlement-action"),
    ).toContainText("Claim winnings", { timeout: 60_000 });
    const claimButton = page
      .getByRole("button", { name: /claim winnings/i })
      .first();
    await expect(claimButton).toBeEnabled({ timeout: 30_000 });
    await claimButton.click();
    const claimSignature = await expectSolanaSettlementReceipt(
      page,
      /claim confirmed on-chain/i,
    );
    const [claimWalletDelta, claimTransactionFee] = await Promise.all([
      getWalletLamportDeltaFromSignature(connection, claimSignature, trader),
      getTransactionFeeFromSignature(connection, claimSignature),
    ]);
    expect(claimWalletDelta).not.toBeNull();
    expect(claimTransactionFee).not.toBeNull();
    expect((claimWalletDelta ?? 0n) + (claimTransactionFee ?? 0n)).toBe(
      expectedPayoutLamports + userBalanceRentLamports,
    );
    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.bShares)}`;
        },
        { timeout: 60_000, intervals: [500, 1_000, 2_000, 5_000] },
      )
      .toBe("0:0");
    const afterClaimWalletLamports = BigInt(
      await connection.getBalance(trader, "confirmed"),
    );
    expect(afterClaimWalletLamports).toBeGreaterThan(beforeClaimWalletLamports);

    let postTerminalHlsPlayback: Record<string, unknown> | null = null;
    if (E2E_HYPERIA_RUNTIME === "full_3d") {
      const video = page.locator("video[data-stream-source]").first();
      const samplePlayback = () =>
        video.evaluate((element: HTMLVideoElement) => ({
          source: element.dataset.streamSource || "",
          readyState: element.readyState,
          paused: element.paused,
          videoWidth: element.videoWidth,
          videoHeight: element.videoHeight,
          currentTime: element.currentTime,
          totalVideoFrames:
            typeof element.getVideoPlaybackQuality === "function"
              ? element.getVideoPlaybackQuality().totalVideoFrames
              : 0,
        }));
      await expect
        .poll(samplePlayback, {
          timeout: 45_000,
          intervals: [250, 500, 1_000, 2_000],
        })
        .toMatchObject({
          paused: false,
          videoWidth: 1280,
          videoHeight: 720,
        });
      const before = await samplePlayback();
      await page.waitForTimeout(2_500);
      const after = await samplePlayback();
      expect(before.source).toMatch(/\/live\/stream\.m3u8$/);
      expect(after.currentTime - before.currentTime).toBeGreaterThan(1);
      expect(after.totalVideoFrames).toBeGreaterThan(before.totalVideoFrames);
      postTerminalHlsPlayback = { before, after };
    }
    expect(runtimeErrors).toEqual([]);

    const evidence = {
      schemaVersion: 1,
      duelId,
      duelKeyHex,
      duelState: duelState.toBase58(),
      marketState: marketState.toBase58(),
      userBalance: userBalanceAddress.toBase58(),
      controlSha256,
      configuredNodePath,
      launchPathFirstEntry: launchPathEntries[0],
      resolvedLaunchNodePath,
      reuseGameBuilds,
      sourceBefore,
      sourceAfter,
      restartStartedAtMs,
      restartRecoveredMs,
      initialPid,
      restartedPid,
      initialProcessCommand,
      restartedProcessCommand,
      sameDuelRecovered: true,
      sameMarketRecovered: true,
      sourceEpochChanged: true,
      rendererRestartEvidence,
      hlsPlaybackEvidence,
      browserOrders,
      fundedBalance: {
        aShares: bnLikeToBigInt(fundedBalanceAfterRestart.aShares).toString(),
        bShares: bnLikeToBigInt(fundedBalanceAfterRestart.bShares).toString(),
        aLockedLamports: bnLikeToBigInt(
          fundedBalanceAfterRestart.aLockedLamports,
        ).toString(),
        bLockedLamports: bnLikeToBigInt(
          fundedBalanceAfterRestart.bLockedLamports,
        ).toString(),
      },
      marketStatusBeforeRestart: enumName(exactMarketBeforeRestart.status),
      terminalSettlement: {
        outcome: terminalCycle.outcome,
        winnerId: terminalCycle.winnerId,
        winnerSide,
        winReason: terminalCycle.winReason,
        replayHash: terminalCycle.replayHash,
        marketStatus: enumName(resolvedMarket.status),
        claimSignature,
        claimWalletDelta: claimWalletDelta?.toString() ?? null,
        claimTransactionFee: claimTransactionFee?.toString() ?? null,
        expectedPayoutLamports: expectedPayoutLamports.toString(),
        userBalanceRentLamports: userBalanceRentLamports.toString(),
        beforeClaimWalletLamports: beforeClaimWalletLamports.toString(),
        afterClaimWalletLamports: afterClaimWalletLamports.toString(),
      },
      postTerminalHlsPlayback,
      runtimeErrors,
    };
    const evidencePath = testInfo.outputPath(
      "solana-full3d-hyperia-restart-recovery.json",
    );
    const screenshotPath = testInfo.outputPath(
      "solana-full3d-hyperia-restart-recovery.png",
    );
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.writeFileSync(
      screenshotPath,
      await page.screenshot({ animations: "disabled", fullPage: true }),
      { flag: "wx", mode: 0o600 },
    );
    await testInfo.attach("solana-full3d-hyperia-restart-recovery", {
      path: evidencePath,
      contentType: "application/json",
    });
    await testInfo.attach("solana-full3d-hyperia-restart-recovery-screenshot", {
      path: screenshotPath,
      contentType: "image/png",
    });
  });

  test("graceful Hyperia shutdown cancels the exact active SOL market and refunds lamports", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      E2E_DUEL_SOURCE !== "real_hyperia",
      "graceful Hyperia shutdown requires the persisted real-duel source",
    );
    test.setTimeout(360_000);

    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));

    const state = loadState();
    const control = loadControl();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const { duelKeyHex, duelId, duelState, marketState } =
      await createFreshSolanaOpenMarket(
        request,
        state,
        authority,
        fightProgram,
        writableClobProgram,
        "gate10-solana-graceful-shutdown",
      );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);
    await seedClobLiquidity(connection, state, SIDE_ASK, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();
    const clobPanel = page.getByTestId("solana-clob-panel").first();
    await openSolanaBuyOrderEntry(page, clobPanel);
    await clobPanel
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await selectSolanaPredictionSide(clobPanel, "yes");
    const buyYesButton = clobPanel
      .getByRole("button", { name: /buy yes/i })
      .first();
    await expect(buyYesButton).toBeEnabled({ timeout: 30_000 });
    await buyYesButton.click();
    await confirmSolanaOrder(page);

    await expect
      .poll(
        async () => {
          const status = await readText(page, "solana-clob-status");
          if (/Order failed:/i.test(status)) throw new Error(status);
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.aLockedLamports)}`;
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("50000000:25000000");

    const refundableBalance = (await clobProgram.account.userBalance.fetch(
      userBalanceAddress,
    )) as UserBalanceAccount;
    const expectedRefundLamports =
      bnLikeToBigInt(refundableBalance.aLockedLamports) +
      bnLikeToBigInt(refundableBalance.bLockedLamports) +
      bnLikeToBigInt(refundableBalance.tradeTreasuryFeeLamports) +
      bnLikeToBigInt(refundableBalance.tradeMarketMakerFeeLamports);
    expect(expectedRefundLamports).toBeGreaterThan(25_000_000n);
    const userBalanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    expect(userBalanceRentLamports).toBeGreaterThan(0n);

    const sourceBefore = await fetchHyperiaAuthorityHealth(request, control);
    expect(sourceBefore).toMatchObject({
      ready: true,
      duelId,
      duelKeyHex,
      outcome: null,
      cancellationReason: null,
      competitiveSnapshotPersisted: true,
      competitiveSnapshotDiagnostic: false,
    });
    expect(sourceBefore.sourceEpoch).toEqual(expect.any(Number));
    expect(sourceBefore.snapshotDigest).toEqual(expect.any(String));

    const root = page.locator(".hm-root").first();
    await expect(root).toHaveAttribute("data-market-can-place-bet", "true", {
      timeout: 30_000,
    });
    await root.evaluate((element) => {
      const history = [
        {
          observedAtMs: Date.now(),
          value: element.dataset.marketCanPlaceBet ?? null,
        },
      ];
      const observer = new MutationObserver(() => {
        const value = element.dataset.marketCanPlaceBet ?? null;
        if (history.at(-1)?.value !== value) {
          history.push({ observedAtMs: Date.now(), value });
        }
      });
      observer.observe(element, {
        attributeFilter: ["data-market-can-place-bet"],
        attributes: true,
      });
      (
        window as typeof window & {
          __hyperbetShutdownTradeGateAudit?: {
            disconnect: () => void;
            history: typeof history;
          };
        }
      ).__hyperbetShutdownTradeGateAudit = {
        disconnect: () => observer.disconnect(),
        history,
      };
    });

    const shutdownStartedAtMs = Date.now();
    runProcessControl(control, "stop", "hyperia");
    await expect
      .poll(() => currentHyperiaAuthorityEpoch(control), {
        timeout: 10_000,
        intervals: [100, 250, 500],
      })
      .toBeNull();
    const shutdownEvidence = readHyperiaShutdownEvidence(control);
    expect(shutdownEvidence).toEqual({
      event: "shutdown-complete",
      sourceEpoch: sourceBefore.sourceEpoch,
      terminalFrameSeq: expect.any(Number),
      duelId,
      duelKeyHex,
      competitiveSnapshotDigest: sourceBefore.snapshotDigest,
      outcome: "cancelled",
      cancellationReason: "scheduler_shutdown",
      downstreamAcknowledged: true,
    });
    expect(shutdownEvidence.terminalFrameSeq).toBeGreaterThan(0);

    await expect(root).toHaveAttribute("data-market-can-place-bet", "false", {
      timeout: 30_000,
    });
    const tradeGateHistory = await page.evaluate(() => {
      const audit = (
        window as typeof window & {
          __hyperbetShutdownTradeGateAudit?: {
            disconnect: () => void;
            history: Array<{
              observedAtMs: number;
              value: string | null;
            }>;
          };
        }
      ).__hyperbetShutdownTradeGateAudit;
      if (!audit) throw new Error("shutdown trade-gate audit is missing");
      audit.disconnect();
      return audit.history;
    });
    expect(tradeGateHistory[0]?.value).toBe("true");
    const firstFailClosedObservation = tradeGateHistory.find(
      (entry) => entry.value === "false",
    );
    expect(firstFailClosedObservation).toBeDefined();
    const browserFailClosedMs =
      (firstFailClosedObservation?.observedAtMs ?? Number.POSITIVE_INFINITY) -
      shutdownStartedAtMs;
    expect(browserFailClosedMs).toBeLessThanOrEqual(10_000);

    await expect
      .poll(
        async () => {
          const [exactDuel, exactMarket] = await Promise.all([
            fightProgram.account.duelState.fetch(duelState),
            clobProgram.account.marketState.fetch(marketState),
          ]);
          return {
            duelStatus: enumName(
              (exactDuel as DuelStateAccountSnapshot).status,
            ),
            duelWinner: enumName(
              (exactDuel as DuelStateAccountSnapshot).winner,
            ),
            marketStatus: enumName(
              (exactMarket as MarketStateAccount & { status?: unknown }).status,
            ),
            marketWinner: enumName(
              (exactMarket as MarketStateAccount & { winner?: unknown }).winner,
            ),
          };
        },
        { timeout: 120_000, intervals: [500, 1_000, 2_000, 5_000] },
      )
      .toEqual({
        duelStatus: "cancelled",
        duelWinner: "none",
        marketStatus: "cancelled",
        marketWinner: "none",
      });
    const shutdownToCancellationMs = Date.now() - shutdownStartedAtMs;
    expect(await currentHyperiaAuthorityEpoch(control)).toBeNull();

    const cancelledDuel = (await fightProgram.account.duelState.fetch(
      duelState,
    )) as DuelStateAccountSnapshot;
    expect(
      parseDuelCancellationMetadata(String(cancelledDuel.metadataUri)),
    ).toEqual({
      duelId,
      duelKeyHex,
      outcome: "cancelled",
      reason: "scheduler_shutdown",
    });
    await expect
      .poll(
        async () => {
          const payload = await fetchBotHealth(request);
          const market = payload.health?.markets.find(
            (entry) => entry.marketRef === marketState.toBase58(),
          );
          return {
            running: payload.running,
            lifecycleStatus: market?.lifecycleStatus ?? null,
            activeRecovery:
              payload.health?.recovery
                .filter((entry) => entry.active)
                .map((entry) => entry.code)
                .sort() ?? [],
          };
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toEqual({
        running: EXPECT_KEEPER_BOT,
        lifecycleStatus: "CANCELLED",
        activeRecovery: [],
      });

    const settlementPath = `/api/arena/settlements/${encodeURIComponent(
      trader.toBase58(),
    )}?limit=100&offset=0`;
    const readExactSettlement = async () => {
      const settlement = await fetchJson<{
        ledger?: { current?: boolean };
        entries?: Array<{
          duelId?: string;
          marketPda?: string;
          marketStatus?: string;
          settlementState?: string;
          claimSignature?: string | null;
        }>;
      }>(request, settlementPath);
      const exactEntry = settlement.entries?.find(
        (entry) =>
          entry.duelId === duelId && entry.marketPda === marketState.toBase58(),
      );
      return {
        ledgerCurrent: settlement.ledger?.current ?? false,
        marketStatus: exactEntry?.marketStatus ?? null,
        settlementState: exactEntry?.settlementState ?? null,
        claimSignature: exactEntry?.claimSignature ?? null,
      };
    };
    await expect
      .poll(readExactSettlement, {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000, 5_000],
      })
      .toEqual({
        ledgerCurrent: true,
        marketStatus: "cancelled",
        settlementState: "REFUND_CLAIMABLE",
        claimSignature: null,
      });
    const shutdownToSettlementReconciliationMs =
      Date.now() - shutdownStartedAtMs;

    await gotoApp(page);
    await selectChain(page, "solana");
    await ensureWalletConnected(page);
    const postShutdownExpandButton = page
      .locator('button[title="Expand panel"]')
      .first();
    if (await postShutdownExpandButton.isVisible().catch(() => false)) {
      await postShutdownExpandButton.click();
    }
    const priorDuelActivity = settlementEntriesForDuel(page, duelId).first();
    await page.getByTestId("solana-settlement-refresh").click();
    await expect(priorDuelActivity).toContainText("Refund ready to claim", {
      timeout: 15_000,
    });
    const shutdownToVisibleRefundMs = Date.now() - shutdownStartedAtMs;
    const claimButton = priorDuelActivity.getByRole("button", {
      name: /claim refund/i,
    });
    await expect(claimButton).toBeEnabled({ timeout: 30_000 });
    const claimStartedAtMs = Date.now();
    await claimButton.click();
    const claimSignature = await expectSolanaSettlementReceipt(
      page,
      /refund confirmed on-chain/i,
    );
    const claimConfirmationMs = Date.now() - claimStartedAtMs;
    const [walletDelta, transactionFee] = await Promise.all([
      getWalletLamportDeltaFromSignature(connection, claimSignature, trader),
      getTransactionFeeFromSignature(connection, claimSignature),
    ]);
    expect(walletDelta).not.toBeNull();
    expect(transactionFee).not.toBeNull();
    expect((walletDelta ?? 0n) + (transactionFee ?? 0n)).toBe(
      expectedRefundLamports + userBalanceRentLamports,
    );
    expect(
      await clobProgram.account.userBalance.fetchNullable(userBalanceAddress),
    ).toBeNull();
    await expect
      .poll(readExactSettlement, {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000, 5_000],
      })
      .toEqual({
        ledgerCurrent: true,
        marketStatus: "cancelled",
        settlementState: "REFUNDED",
        claimSignature,
      });
    const claimToSettlementReconciliationMs = Date.now() - claimStartedAtMs;
    await page.getByTestId("solana-settlement-refresh").click();
    await expect(priorDuelActivity).toContainText("Refund paid", {
      timeout: 15_000,
    });
    await expect(claimButton).toBeHidden();
    const claimToVisiblePaidMs = Date.now() - claimStartedAtMs;
    expect(runtimeErrors).toEqual([]);

    const evidence = {
      schemaVersion: 2,
      duelId,
      duelKeyHex,
      duelState: duelState.toBase58(),
      marketState: marketState.toBase58(),
      sourceBefore,
      shutdownEvidence,
      shutdownStartedAtMs,
      browserFailClosedMs,
      tradeGateHistory,
      shutdownToCancellationMs,
      shutdownToSettlementReconciliationMs,
      shutdownToVisibleRefundMs,
      sourceRemainedStoppedThroughCancellation: true,
      expectedRefundLamports: expectedRefundLamports.toString(),
      userBalanceRentLamports: userBalanceRentLamports.toString(),
      claimSignature,
      claimConfirmationMs,
      claimToSettlementReconciliationMs,
      claimToVisiblePaidMs,
      walletDelta: walletDelta?.toString() ?? null,
      transactionFee: transactionFee?.toString() ?? null,
      userBalanceClosed: true,
      runtimeErrors,
    };
    const evidencePath = testInfo.outputPath(
      "solana-graceful-shutdown-refund.json",
    );
    const screenshotPath = testInfo.outputPath(
      "solana-graceful-shutdown-refund.png",
    );
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.writeFileSync(
      screenshotPath,
      await page.screenshot({ animations: "disabled", fullPage: true }),
      { flag: "wx", mode: 0o600 },
    );
    await testInfo.attach("solana-graceful-shutdown-refund", {
      path: evidencePath,
      contentType: "application/json",
    });
    await testInfo.attach("solana-graceful-shutdown-refund-screenshot", {
      path: screenshotPath,
      contentType: "image/png",
    });
  });

  test("exact Hyperia recovery-window cancellation drives keeper refund and clears claim state", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      E2E_DUEL_SOURCE === "real_hyperia",
      "cancel/refund remains a synthetic Solana browser lane for now",
    );
    const state = loadState();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const {
      duelKeyHex,
      duelId,
      duelState,
      marketState,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    } = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-cancel",
    );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: "OPEN",
      });

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);

    await seedClobLiquidity(connection, state, SIDE_ASK, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();
    const clobPanel = page.getByTestId("solana-clob-panel").first();
    await openSolanaBuyOrderEntry(page, clobPanel);
    await clobPanel
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await selectSolanaPredictionSide(clobPanel, "yes");
    const submitButton = clobPanel
      .getByRole("button", { name: /buy yes/i })
      .first();
    await expect(submitButton).toContainText(/buy yes/i, {
      timeout: 30_000,
    });
    await expect(submitButton).toBeEnabled({ timeout: 30_000 });
    await submitButton.click();
    await confirmSolanaOrder(page);

    const yesStatus = await page
      .getByTestId("solana-clob-status")
      .textContent()
      .catch(() => "");
    if ((yesStatus || "").includes("Order failed:")) {
      throw new Error((yesStatus || "").trim());
    }

    await expect
      .poll(
        async () => {
          const currentStatus = await readText(page, "solana-clob-status");
          if (/Order failed:/i.test(currentStatus)) {
            throw new Error(currentStatus);
          }
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return Number(bnLikeToBigInt(balance?.aShares));
        },
        {
          timeout: 120_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBeGreaterThan(0);

    await page.getByTestId("refresh-market").click();
    await expect(page.locator(".hm-root")).toHaveAttribute(
      "data-market-can-place-bet",
      "true",
      { timeout: 120_000 },
    );
    const terminalBuyTab = clobPanel.getByTestId("prediction-tab-buy");
    await expect(terminalBuyTab).toBeVisible({ timeout: 120_000 });
    await terminalBuyTab.click();
    await selectSolanaPredictionSide(clobPanel, "no");
    const terminalNoPriceInput = clobPanel.getByTestId(
      "solana-clob-price-input",
    );
    if (await terminalNoPriceInput.isVisible().catch(() => false)) {
      await terminalNoPriceInput.fill("500");
    }
    const terminalMarketBeforeOrder =
      (await clobProgram.account.marketState.fetch(
        marketState,
      )) as MarketStateAccount;
    const terminalOrderId = bnLikeToBigInt(
      terminalMarketBeforeOrder.nextOrderId,
    );
    const terminalOrderAddress = deriveOrderPda(
      clobProgram.programId,
      marketState,
      terminalOrderId,
    );
    const terminalNoSubmitButton = clobPanel
      .getByRole("button", { name: /buy no/i })
      .first();
    await expect(terminalNoSubmitButton).toBeEnabled({ timeout: 30_000 });
    await terminalNoSubmitButton.click();
    await confirmSolanaOrder(page);

    await expect
      .poll(
        async () => {
          const order = (await clobProgram.account.order.fetchNullable(
            terminalOrderAddress,
          )) as OrderAccount | null;
          return order?.active
            ? `${Number(order.side)}:${Number(order.price)}:${bnLikeToBigInt(order.amount)}:${bnLikeToBigInt(order.filled)}`
            : "missing";
        },
        { timeout: 60_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(`${SIDE_ASK}:500:50000000:0`);
    const terminalRestingOrder = (await clobProgram.account.order.fetch(
      terminalOrderAddress,
    )) as OrderAccount;
    const terminalPreviousOrderId = bnLikeToBigInt(
      terminalRestingOrder.prevOrderId,
    );
    expect(terminalPreviousOrderId).toBeGreaterThan(0n);
    expect(bnLikeToBigInt(terminalRestingOrder.nextOrderId)).toBe(0n);
    const terminalPriceLevelAddress = derivePriceLevelPda(
      clobProgram.programId,
      marketState,
      SIDE_ASK,
      500,
    );
    const terminalPriceLevelBeforeReclaim =
      (await clobProgram.account.priceLevel.fetch(
        terminalPriceLevelAddress,
      )) as PriceLevelAccount;
    const terminalPriceLevelOpenBeforeReclaim = bnLikeToBigInt(
      terminalPriceLevelBeforeReclaim.totalOpen,
    );
    expect(bnLikeToBigInt(terminalPriceLevelBeforeReclaim.tailOrderId)).toBe(
      terminalOrderId,
    );

    await publishSolanaCycleState(request, {
      cycleId: `gate10-solana-${duelId}`,
      duelId,
      duelKeyHex,
      betOpenTs,
      betCloseTs,
      duelStartTs,
      phase: "RESOLUTION",
      winner: "NONE",
      duelEndTs: await currentChainUnixTimestamp(connection),
      cancellationReason: COMPETITIVE_SNAPSHOT_RECOVERY_WINDOW_ELAPSED_REASON,
    });

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return solanaMarket?.lifecycleStatus || "missing";
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBe("CANCELLED");

    await expect
      .poll(
        async () => {
          const payload = await fetchBotHealth(request);
          const market = payload.health?.markets.find(
            (entry) => entry.marketRef === marketState.toBase58(),
          );
          return {
            running: payload.running,
            lifecycleStatus: market?.lifecycleStatus ?? null,
            activeRecovery:
              payload.health?.recovery
                .filter((entry) => entry.active)
                .map((entry) => entry.code)
                .sort() ?? [],
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toEqual({
        running: EXPECT_KEEPER_BOT,
        lifecycleStatus: "CANCELLED",
        activeRecovery: [],
      });

    const cancelledDuel = (await fightProgram.account.duelState.fetch(
      duelState,
    )) as DuelStateAccountSnapshot;
    expect(enumName(cancelledDuel.status)).toBe("cancelled");
    expect(
      parseDuelCancellationMetadata(String(cancelledDuel.metadataUri)),
    ).toEqual({
      duelId,
      duelKeyHex,
      outcome: "cancelled",
      reason: COMPETITIVE_SNAPSHOT_RECOVERY_WINDOW_ELAPSED_REASON,
    });
    const cancelledMarket = (await clobProgram.account.marketState.fetch(
      marketState,
    )) as MarketStateAccount & { status?: unknown; winner?: unknown };
    expect(enumName(cancelledMarket.status)).toBe("cancelled");
    expect(enumName(cancelledMarket.winner)).toBe("none");

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
      debug: false,
    });
    await selectChain(page, "solana");
    await ensureWalletConnected(page);
    const publicCancellationLog = page.getByTestId("duels-bottom-panel-news");
    await expect(publicCancellationLog).toContainText(
      "The round was cancelled. No winner was declared.",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("spectator-terminal-outcome")).toContainText(
      "No contest — no winner was declared.",
    );
    await expect(
      page.getByTestId("solana-clob-settlement-action"),
    ).toContainText("Claim refund", { timeout: 60_000 });
    await testInfo.attach("solana-cancelled-public-desktop", {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("mobile-watch-summary")).toContainText(
      "CANCELLED",
    );
    expect(
      await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    ).toEqual({ clientWidth: 390, scrollWidth: 390 });
    const refundReviewButton = page.locator(".hm-bet-fab");
    await expect(refundReviewButton).toBeVisible();
    expect(
      await refundReviewButton.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    await refundReviewButton.click();
    const mobileCancellationSheet = page.getByRole("dialog", {
      name: /trading controls/i,
    });
    await expect(mobileCancellationSheet).toBeVisible();
    await expect(mobileCancellationSheet).toContainText("CANCELLED");
    await expect(mobileCancellationSheet).toContainText("Claim refund");
    await testInfo.attach("solana-cancelled-public-mobile", {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(mobileCancellationSheet).toHaveCount(0);
    await expect(refundReviewButton).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 720 });

    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return {
            aShares: Number(bnLikeToBigInt(balance?.aShares)),
            bShares: Number(bnLikeToBigInt(balance?.bShares)),
            aLockedLamports: Number(bnLikeToBigInt(balance?.aLockedLamports)),
            bLockedLamports: Number(bnLikeToBigInt(balance?.bLockedLamports)),
          };
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toMatchObject({
        aShares: expect.any(Number),
        aLockedLamports: expect.any(Number),
      });
    const cancelledBalance =
      (await clobProgram.account.userBalance.fetchNullable(
        userBalanceAddress,
      )) as UserBalanceAccount | null;
    expect(
      bnLikeToBigInt(cancelledBalance?.aLockedLamports) > 0n,
      "cancelled Solana position should retain refundable locked lamports",
    ).toBeTruthy();

    const reclaimedOrderRentLamports = BigInt(
      await connection.getBalance(terminalOrderAddress, "confirmed"),
    );
    expect(reclaimedOrderRentLamports).toBeGreaterThan(0n);
    const expectedReclaimCollateralLamports = 25_000_000n;
    const expectedReclaimWalletCreditLamports =
      expectedReclaimCollateralLamports + reclaimedOrderRentLamports;

    const rolloverMarket = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-post-cancel-rollover",
    );
    await gotoApp(page, {
      e2eSolanaDuelKey: rolloverMarket.duelKeyHex,
      e2eSolanaDuelId: rolloverMarket.duelId,
      e2eSolanaMarketRef: rolloverMarket.marketState.toBase58(),
      debug: false,
    });
    await selectChain(page, "solana");
    const rolloverExpandButton = page
      .locator('button[title="Expand panel"]')
      .first();
    if (await rolloverExpandButton.isVisible().catch(() => false)) {
      await rolloverExpandButton.click();
    }
    await ensureWalletConnected(page);
    const rolloverRoot = page.locator(".hm-root").first();
    await expect(rolloverRoot).toHaveAttribute(
      "data-stream-duel-id",
      rolloverMarket.duelId,
      { timeout: 60_000 },
    );
    await expect(rolloverRoot).toHaveAttribute(
      "data-market-duel-id",
      rolloverMarket.duelId,
    );
    await expect(rolloverRoot).toHaveAttribute(
      "data-market-can-place-bet",
      "true",
    );
    await expect(page.getByTestId("spectator-terminal-outcome")).toHaveCount(0);
    await expect(
      page.getByText("Upcoming Match", { exact: true }).first(),
    ).toBeVisible();
    const terminalOrderHistory = settlementEntriesForDuel(page, duelId)
      .filter({ hasText: `Order #${terminalOrderId.toString()}` })
      .first();
    await expect(terminalOrderHistory).toContainText("Reclaim required", {
      timeout: 45_000,
    });
    const reclaimSignature = await confirmSolanaManagedOrder(page, {
      orderId: terminalOrderId,
      action: "RECLAIM",
      outcomeText: "NO 50.0%",
      remainingText: "0.05",
      refundText: "0.025 SOL",
      rentText: `${formatSolLamports(reclaimedOrderRentLamports, 9)} SOL`,
      grossCreditText: `${formatSolLamports(expectedReclaimWalletCreditLamports, 9)} SOL`,
      historyEntry: terminalOrderHistory,
      auditDismissal: true,
    });
    await expect
      .poll(
        async () => {
          const [walletDelta, transactionFee] = await Promise.all([
            getWalletLamportDeltaFromSignature(
              connection,
              reclaimSignature,
              trader,
            ),
            getTransactionFeeFromSignature(connection, reclaimSignature),
          ]);
          return walletDelta == null || transactionFee == null
            ? null
            : (walletDelta + transactionFee).toString();
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(expectedReclaimWalletCreditLamports.toString());

    const reclaimedOrder = (await clobProgram.account.order.fetchNullable(
      terminalOrderAddress,
    )) as OrderAccount | null;
    expect(reclaimedOrder).toBeNull();
    const terminalPreviousOrder = (await clobProgram.account.order.fetch(
      deriveOrderPda(
        clobProgram.programId,
        marketState,
        terminalPreviousOrderId,
      ),
    )) as OrderAccount;
    expect(bnLikeToBigInt(terminalPreviousOrder.nextOrderId)).toBe(0n);
    const terminalPriceLevelAfterReclaim =
      (await clobProgram.account.priceLevel.fetch(
        terminalPriceLevelAddress,
      )) as PriceLevelAccount;
    expect(bnLikeToBigInt(terminalPriceLevelAfterReclaim.totalOpen)).toBe(
      terminalPriceLevelOpenBeforeReclaim - 50_000_000n,
    );
    expect(bnLikeToBigInt(terminalPriceLevelAfterReclaim.headOrderId)).toBe(
      terminalPreviousOrderId,
    );
    expect(bnLikeToBigInt(terminalPriceLevelAfterReclaim.tailOrderId)).toBe(
      terminalPreviousOrderId,
    );
    const balanceAfterOrderReclaim =
      (await clobProgram.account.userBalance.fetchNullable(
        userBalanceAddress,
      )) as UserBalanceAccount | null;
    expect({
      aShares: bnLikeToBigInt(balanceAfterOrderReclaim?.aShares),
      bShares: bnLikeToBigInt(balanceAfterOrderReclaim?.bShares),
      aLockedLamports: bnLikeToBigInt(
        balanceAfterOrderReclaim?.aLockedLamports,
      ),
      bLockedLamports: bnLikeToBigInt(
        balanceAfterOrderReclaim?.bLockedLamports,
      ),
      tradeTreasuryFeeLamports: bnLikeToBigInt(
        balanceAfterOrderReclaim?.tradeTreasuryFeeLamports,
      ),
      tradeMarketMakerFeeLamports: bnLikeToBigInt(
        balanceAfterOrderReclaim?.tradeMarketMakerFeeLamports,
      ),
    }).toEqual({
      aShares: bnLikeToBigInt(cancelledBalance?.aShares),
      bShares: bnLikeToBigInt(cancelledBalance?.bShares),
      aLockedLamports: bnLikeToBigInt(cancelledBalance?.aLockedLamports),
      bLockedLamports: bnLikeToBigInt(cancelledBalance?.bLockedLamports),
      tradeTreasuryFeeLamports: bnLikeToBigInt(
        cancelledBalance?.tradeTreasuryFeeLamports,
      ),
      tradeMarketMakerFeeLamports: bnLikeToBigInt(
        cancelledBalance?.tradeMarketMakerFeeLamports,
      ),
    });
    const expectedMatchedRefundLamports =
      bnLikeToBigInt(balanceAfterOrderReclaim?.aLockedLamports) +
      bnLikeToBigInt(balanceAfterOrderReclaim?.bLockedLamports) +
      bnLikeToBigInt(balanceAfterOrderReclaim?.tradeTreasuryFeeLamports) +
      bnLikeToBigInt(balanceAfterOrderReclaim?.tradeMarketMakerFeeLamports);
    expect(expectedMatchedRefundLamports).toBeGreaterThan(0n);
    const reclaimedUserBalanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    expect(reclaimedUserBalanceRentLamports).toBeGreaterThan(0n);
    const matchedRefundHistory = settlementEntriesForDuel(page, duelId)
      .filter({ hasText: "Refund ready to claim" })
      .first();
    await expect(matchedRefundHistory).toBeVisible({ timeout: 30_000 });
    const claimButton = matchedRefundHistory.getByRole("button", {
      name: /claim refund/i,
    });
    await expect(claimButton).toBeEnabled({ timeout: 30_000 });
    await claimButton.click();
    const claimSignature = await expectSolanaSettlementReceipt(
      page,
      /refund confirmed on-chain/i,
    );
    await expect
      .poll(
        async () => {
          const [walletDelta, transactionFee] = await Promise.all([
            getWalletLamportDeltaFromSignature(
              connection,
              claimSignature,
              trader,
            ),
            getTransactionFeeFromSignature(connection, claimSignature),
          ]);
          return walletDelta == null || transactionFee == null
            ? null
            : (walletDelta + transactionFee).toString();
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(
        (
          expectedMatchedRefundLamports + reclaimedUserBalanceRentLamports
        ).toString(),
      );

    await expect
      .poll(
        async () => {
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.bShares)}`;
        },
        {
          timeout: 120_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBe("0:0");
    expect(
      await clobProgram.account.userBalance.fetchNullable(userBalanceAddress),
    ).toBeNull();
  });

  test("authoritative Hyperia draw refunds matched YES and NO exposure exactly", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      E2E_DUEL_SOURCE === "real_hyperia",
      "draw/refund remains a synthetic Solana browser lane for now",
    );
    test.setTimeout(300_000);

    const state = loadState();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const {
      duelKeyHex,
      duelId,
      duelState,
      marketState,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    } = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-draw-refund",
      {
        betCloseOffsetSeconds: 120,
        duelStartOffsetSeconds: 120,
      },
    );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return {
            duelKey: predictionMarkets.duel.duelKey,
            marketRef: solanaMarket?.marketRef ?? null,
            lifecycleStatus: solanaMarket?.lifecycleStatus ?? null,
          };
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toEqual({
        duelKey: duelKeyHex,
        marketRef: marketState.toBase58(),
        lifecycleStatus: "OPEN",
      });

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);

    const clobPanel = page.getByTestId("solana-clob-panel").first();
    await seedClobLiquidity(connection, state, SIDE_ASK, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();
    await openSolanaBuyOrderEntry(page, clobPanel);
    await clobPanel
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await selectSolanaPredictionSide(clobPanel, "yes");
    const buyYesButton = clobPanel
      .getByRole("button", { name: /buy yes/i })
      .first();
    await expect(buyYesButton).toBeEnabled({ timeout: 30_000 });
    await buyYesButton.click();
    await confirmSolanaOrder(page);

    await expect
      .poll(
        async () => {
          const status = await readText(page, "solana-clob-status");
          if (/Order failed:/i.test(status)) throw new Error(status);
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.aLockedLamports)}`;
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("50000000:25000000");

    await seedClobLiquidity(connection, state, SIDE_BID, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();
    await openSolanaBuyOrderEntry(page, clobPanel);
    await selectSolanaPredictionSide(clobPanel, "no");
    const noPriceInput = clobPanel.getByTestId("solana-clob-price-input");
    if (await noPriceInput.isVisible().catch(() => false)) {
      await noPriceInput.fill(String(ORDER_PRICE));
    }
    const buyNoButton = clobPanel
      .getByRole("button", { name: /buy no/i })
      .first();
    await expect(buyNoButton).toBeEnabled({ timeout: 30_000 });
    await buyNoButton.click();
    await confirmSolanaOrder(page);

    await expect
      .poll(
        async () => {
          const status = await readText(page, "solana-clob-status");
          if (/Order failed:/i.test(status)) throw new Error(status);
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return {
            aShares: bnLikeToBigInt(balance?.aShares).toString(),
            bShares: bnLikeToBigInt(balance?.bShares).toString(),
            aLockedLamports: bnLikeToBigInt(
              balance?.aLockedLamports,
            ).toString(),
            bLockedLamports: bnLikeToBigInt(
              balance?.bLockedLamports,
            ).toString(),
          };
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toEqual({
        aShares: "50000000",
        bShares: "50000000",
        aLockedLamports: "25000000",
        bLockedLamports: "25000000",
      });

    const refundableBalance = (await clobProgram.account.userBalance.fetch(
      userBalanceAddress,
    )) as UserBalanceAccount;
    const expectedRefundLamports =
      bnLikeToBigInt(refundableBalance.aLockedLamports) +
      bnLikeToBigInt(refundableBalance.bLockedLamports) +
      bnLikeToBigInt(refundableBalance.tradeTreasuryFeeLamports) +
      bnLikeToBigInt(refundableBalance.tradeMarketMakerFeeLamports);
    expect(expectedRefundLamports).toBeGreaterThan(50_000_000n);
    const userBalanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    expect(userBalanceRentLamports).toBeGreaterThan(0n);

    const drawCommitment = buildSyntheticDuelCommitment({
      cycleId: `gate10-solana-${duelId}`,
      duelId,
      duelKeyHex,
      betOpenTs,
      betCloseTs,
      duelStartTs,
      agent1: E2E_SOLANA_AGENT_A,
      agent2: E2E_SOLANA_AGENT_B,
    });
    const drawTiming = drawCommitment.competitiveSnapshot.timing;
    if (!drawTiming) {
      throw new Error("schema-v4 draw fixture is missing committed timing");
    }
    expect(drawTiming).toMatchObject({
      timeoutPolicy: "hp_percentage_then_damage_then_draw_v1",
      fightStartTime: duelStartTs * 1_000,
      fightDeadline: duelStartTs * 1_000 + drawTiming.maxFightDurationMs,
    });
    await expect
      .poll(() => Date.now(), {
        timeout: Math.max(
          30_000,
          drawTiming.fightDeadline - Date.now() + 5_000,
        ),
        intervals: [10, 25, 50, 100],
      })
      .toBeGreaterThanOrEqual(drawTiming.fightDeadline);
    const drawPublishedAfterDeadlineMs = Date.now() - drawTiming.fightDeadline;
    expect(drawPublishedAfterDeadlineMs).toBeGreaterThanOrEqual(0);
    expect(drawPublishedAfterDeadlineMs).toBeLessThan(5_000);

    await publishSolanaCycleState(request, {
      cycleId: `gate10-solana-${duelId}`,
      duelId,
      duelKeyHex,
      betOpenTs,
      betCloseTs,
      duelStartTs,
      phase: "RESOLUTION",
      winner: "NONE",
      outcome: "draw",
      duelEndTimeMs: drawTiming.fightDeadline,
    });

    const drawStream = await fetchJson<StreamingStateResponse>(
      request,
      "/api/streaming/state",
    );
    expect(drawStream.cycle).toMatchObject({
      duelId,
      duelKeyHex,
      outcome: "draw",
      winnerId: null,
      duelEndTime: drawTiming.fightDeadline,
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: drawCommitment.competitiveSnapshotDigest,
      competitiveSnapshot: {
        snapshotVersion: 4,
        timing: drawTiming,
      },
    });

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return `${solanaMarket?.lifecycleStatus ?? "missing"}:${solanaMarket?.winner ?? "missing"}`;
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("CANCELLED:NONE");

    await expect
      .poll(
        async () => {
          const payload = await fetchBotHealth(request);
          const market = payload.health?.markets.find(
            (entry) => entry.marketRef === marketState.toBase58(),
          );
          return {
            running: payload.running,
            lifecycleStatus: market?.lifecycleStatus ?? null,
            activeRecovery:
              payload.health?.recovery
                .filter((entry) => entry.active)
                .map((entry) => entry.code)
                .sort() ?? [],
          };
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toEqual({
        running: EXPECT_KEEPER_BOT,
        lifecycleStatus: "CANCELLED",
        activeRecovery: [],
      });

    const drawnDuel = (await fightProgram.account.duelState.fetch(
      duelState,
    )) as DuelStateAccountSnapshot;
    expect(enumName(drawnDuel.status)).toBe("cancelled");
    expect(enumName(drawnDuel.winner)).toBe("none");
    expect(
      parseDuelCancellationMetadata(String(drawnDuel.metadataUri)),
    ).toEqual({
      duelId,
      duelKeyHex,
      outcome: "draw",
      reason: "draw",
    });
    const drawnMarket = (await clobProgram.account.marketState.fetch(
      marketState,
    )) as MarketStateAccount & { status?: unknown; winner?: unknown };
    expect(enumName(drawnMarket.status)).toBe("cancelled");
    expect(enumName(drawnMarket.winner)).toBe("none");

    await page.getByTestId("refresh-market").click();
    const lifecycleDebug = page.getByTestId("solana-clob-lifecycle-debug");
    const walletDebug = page.getByTestId("solana-clob-wallet-debug");
    const claimButton = page.getByRole("button", { name: /claim/i }).first();
    await expect
      .poll(
        async () => ({
          lifecycle: (await lifecycleDebug.textContent()) ?? "",
          wallet: (await walletDebug.textContent()) ?? "",
          claimEnabled: await claimButton.isEnabled(),
        }),
        { timeout: 30_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toMatchObject({
        lifecycle: expect.stringMatching(/lifecycleStatus=CANCELLED/),
        wallet: expect.stringMatching(
          new RegExp(`refundableAmount=${expectedRefundLamports}`),
        ),
        claimEnabled: true,
      });

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
      debug: false,
    });
    await selectChain(page, "solana");
    await ensureWalletConnected(page);
    const publicDrawLog = page.getByTestId("duels-bottom-panel-news");
    await expect(publicDrawLog).toContainText(
      "The round ended in a draw. No winner was declared.",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("spectator-terminal-outcome")).toContainText(
      "Draw — no winner was declared.",
    );
    await expect(
      page.getByTestId("solana-clob-settlement-action"),
    ).toContainText("Claim refund", { timeout: 60_000 });
    await testInfo.attach("solana-draw-public-desktop", {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("mobile-watch-summary")).toContainText(
      "DRAW",
    );
    expect(
      await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    ).toEqual({ clientWidth: 390, scrollWidth: 390 });
    const drawRefundReviewButton = page.locator(".hm-bet-fab");
    await expect(drawRefundReviewButton).toBeVisible();
    expect(
      await drawRefundReviewButton.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    await drawRefundReviewButton.click();
    const mobileDrawSheet = page.getByRole("dialog", {
      name: /trading controls/i,
    });
    await expect(mobileDrawSheet).toBeVisible();
    await expect(mobileDrawSheet).toContainText("DRAW");
    const mobileClaimButton = mobileDrawSheet
      .getByRole("button", { name: /claim refund/i })
      .first();
    await expect(mobileClaimButton).toBeEnabled({ timeout: 30_000 });
    expect(
      await mobileClaimButton.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    await testInfo.attach("solana-draw-public-mobile", {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });

    const drawHistoryEntries = settlementEntriesForDuel(page, duelId);
    const claimStartedAtMs = Date.now();
    await mobileClaimButton.click();
    const claimSignature = await expectSolanaSettlementReceipt(
      page,
      /refund confirmed on-chain/i,
    );
    await expect(
      drawHistoryEntries.getByRole("button", { name: /claim refund/i }),
    ).toHaveCount(0, { timeout: 2_000 });
    await expect(mobileDrawSheet).toContainText(
      "Settlement history is catching up",
    );
    await testInfo.attach("solana-draw-refund-indexing", {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
    const [walletDelta, transactionFee] = await Promise.all([
      getWalletLamportDeltaFromSignature(connection, claimSignature, trader),
      getTransactionFeeFromSignature(connection, claimSignature),
    ]);
    expect(walletDelta).not.toBeNull();
    expect(transactionFee).not.toBeNull();
    expect((walletDelta ?? 0n) + (transactionFee ?? 0n)).toBe(
      expectedRefundLamports + userBalanceRentLamports,
    );
    expect(
      await clobProgram.account.userBalance.fetchNullable(userBalanceAddress),
    ).toBeNull();
    await expect(page.getByTestId("solana-clob-claim-payout")).toHaveCount(0, {
      timeout: 30_000,
    });

    const readDrawSettlementHistory = async () => {
      const response = await fetchJson<{
        ledger?: { current?: boolean };
        entries?: Array<{
          duelId?: string;
          marketPda?: string;
          settlementState?: string;
          claimSignature?: string | null;
        }>;
      }>(
        request,
        `/api/arena/settlements/${encodeURIComponent(
          trader.toBase58(),
        )}?limit=100&offset=0`,
      );
      const exactEntries = (response.entries ?? []).filter(
        (entry) =>
          entry.duelId === duelId && entry.marketPda === marketState.toBase58(),
      );
      return {
        ledgerCurrent: response.ledger?.current === true,
        count: exactEntries.length,
        allRefunded:
          exactEntries.length === 2 &&
          exactEntries.every(
            (entry) =>
              entry.settlementState === "REFUNDED" &&
              entry.claimSignature === claimSignature,
          ),
      };
    };
    await expect
      .poll(readDrawSettlementHistory, {
        timeout: 90_000,
        intervals: [250, 500, 1_000, 2_000, 5_000],
      })
      .toEqual({ ledgerCurrent: true, count: 2, allRefunded: true });
    const claimToIndexedHistoryMs = Date.now() - claimStartedAtMs;
    await expect
      .poll(
        async () => {
          const entryText = await drawHistoryEntries.allTextContents();
          return {
            count: entryText.length,
            allPaid:
              entryText.length > 0 &&
              entryText.every((value) => value.includes("Refund paid")),
            claimButtons: await drawHistoryEntries
              .getByRole("button", { name: /claim refund/i })
              .count(),
          };
        },
        { timeout: 15_000, intervals: [250, 500, 1_000, 2_000, 5_000] },
      )
      .toEqual({ count: 2, allPaid: true, claimButtons: 0 });
    await expect(mobileDrawSheet).toContainText("Refund paid");

    await testInfo.attach("solana-draw-refund-ui", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await testInfo.attach("solana-draw-refund-evidence", {
      body: Buffer.from(
        JSON.stringify(
          {
            duelId,
            duelKeyHex,
            duelState: duelState.toBase58(),
            marketState: marketState.toBase58(),
            outcome: "draw",
            fightStartTime: drawTiming.fightStartTime,
            fightDeadline: drawTiming.fightDeadline,
            drawPublishedAfterDeadlineMs,
            claimSignature,
            claimToIndexedHistoryMs,
            aSharesBeforeRefund: bnLikeToBigInt(
              refundableBalance.aShares,
            ).toString(),
            bSharesBeforeRefund: bnLikeToBigInt(
              refundableBalance.bShares,
            ).toString(),
            expectedRefundLamports: expectedRefundLamports.toString(),
            userBalanceRentLamports: userBalanceRentLamports.toString(),
            walletDelta: walletDelta?.toString() ?? null,
            transactionFee: transactionFee?.toString() ?? null,
            userBalanceClosed: true,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  });

  test("hard-killed keeper recovers a forwarded terminal cancellation and exact refund", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(360_000);

    const state = loadState();
    const control = loadControl();
    const connection = createConfirmedConnection(
      state.solanaRpcUrl || "http://127.0.0.1:8899",
      state.solanaWsUrl,
    );
    const trader = new PublicKey(state.solanaTraderPublicKey || "");
    const clobProgram = createReadonlyClobProgram(connection, state);
    const {
      authority,
      fightProgram,
      clobProgram: writableClobProgram,
    } = await createWritablePrograms(connection, state);
    const {
      duelKeyHex,
      duelId,
      duelState,
      marketState,
      betOpenTs,
      betCloseTs,
      duelStartTs,
    } = await createFreshSolanaOpenMarket(
      request,
      state,
      authority,
      fightProgram,
      writableClobProgram,
      "gate10-solana-terminal-rpc-crash",
    );
    const userBalanceAddress = deriveUserBalancePda(
      clobProgram.programId,
      marketState,
      trader,
    );

    await expect
      .poll(
        async () => {
          const predictionMarkets = await fetchPredictionMarkets(request);
          const solanaMarket = findPredictionMarket(
            predictionMarkets,
            "solana",
          );
          return `${predictionMarkets.duel.duelKey}:${solanaMarket?.marketRef ?? "missing"}:${solanaMarket?.lifecycleStatus ?? "missing"}`;
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(`${duelKeyHex}:${marketState.toBase58()}:OPEN`);

    await gotoApp(page, {
      e2eSolanaDuelKey: duelKeyHex,
      e2eSolanaDuelId: duelId,
      e2eSolanaMarketRef: marketState.toBase58(),
    });
    await selectChain(page, "solana");
    const expandButton = page.locator('button[title="Expand panel"]').first();
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await ensureWalletConnected(page);

    await seedClobLiquidity(connection, state, SIDE_ASK, {
      marketState,
      duelState,
    });
    await page.getByTestId("refresh-market").click();
    const clobPanel = page.getByTestId("solana-clob-panel").first();
    await openSolanaBuyOrderEntry(page, clobPanel);
    await clobPanel
      .getByTestId("prediction-amount-input")
      .fill(SOLANA_PREDICTION_AMOUNT);
    await selectSolanaPredictionSide(clobPanel, "yes");
    const buyYesButton = clobPanel
      .getByRole("button", { name: /buy yes/i })
      .first();
    await expect(buyYesButton).toBeEnabled({ timeout: 30_000 });
    await buyYesButton.click();
    await confirmSolanaOrder(page);

    await expect
      .poll(
        async () => {
          const status = await readText(page, "solana-clob-status");
          if (/Order failed:/i.test(status)) throw new Error(status);
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return `${bnLikeToBigInt(balance?.aShares)}:${bnLikeToBigInt(balance?.aLockedLamports)}`;
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("50000000:25000000");

    const refundableBalance = (await clobProgram.account.userBalance.fetch(
      userBalanceAddress,
    )) as UserBalanceAccount;
    const expectedRefundLamports =
      bnLikeToBigInt(refundableBalance.aLockedLamports) +
      bnLikeToBigInt(refundableBalance.bLockedLamports) +
      bnLikeToBigInt(refundableBalance.tradeTreasuryFeeLamports) +
      bnLikeToBigInt(refundableBalance.tradeMarketMakerFeeLamports);
    expect(expectedRefundLamports).toBeGreaterThan(25_000_000n);
    const userBalanceRentLamports = BigInt(
      await connection.getBalance(userBalanceAddress, "confirmed"),
    );
    expect(userBalanceRentLamports).toBeGreaterThan(0n);

    const isRealHyperia = E2E_DUEL_SOURCE === "real_hyperia";
    const expectedOutcome = isRealHyperia ? "cancelled" : "draw";
    const expectedReason = isRealHyperia
      ? COMPETITIVE_SNAPSHOT_RECOVERY_WINDOW_ELAPSED_REASON
      : "draw";
    const sourceBefore = isRealHyperia
      ? await fetchHyperiaAuthorityHealth(request, control)
      : null;
    if (sourceBefore) {
      expect(sourceBefore).toMatchObject({
        ready: true,
        duelId,
        duelKeyHex,
        competitiveSnapshotPersisted: true,
        competitiveSnapshotDiagnostic: false,
      });
      expect(sourceBefore.sourceEpoch).toEqual(expect.any(Number));
      expect(sourceBefore.snapshotDigest).toEqual(expect.any(String));
    }

    const faultId = `terminal-${expectedOutcome}-${duelId}`;
    armForwardedSolanaTransactionHold(control, {
      faultId,
      requiredAccount: duelState,
      requiredProgramId: fightProgram.programId,
    });
    let sourceAfter: HyperiaAuthorityHealth | null = null;
    if (isRealHyperia) {
      runProcessControl(control, "kill", "hyperia");
      await expect
        .poll(() => currentHyperiaAuthorityEpoch(control), {
          timeout: 10_000,
          intervals: [100, 250, 500],
        })
        .toBeNull();
      await expect
        .poll(() => Math.floor(Date.now() / 1_000), {
          timeout: Math.max(60_000, betCloseTs * 1_000 - Date.now() + 30_000),
          intervals: [250, 500, 1_000],
        })
        .toBeGreaterThanOrEqual(betCloseTs + 1);
      runProcessControl(control, "start", "hyperia");
      await expect
        .poll(
          async () => {
            const recovered = await fetchHyperiaAuthorityHealth(
              request,
              control,
            );
            return {
              sourceEpochChanged:
                recovered.sourceEpoch !== sourceBefore?.sourceEpoch,
              duelId: recovered.duelId,
              duelKeyHex: recovered.duelKeyHex,
              snapshotDigest: recovered.snapshotDigest,
              outcome: recovered.outcome,
              cancellationReason: recovered.cancellationReason,
            };
          },
          { timeout: 30_000, intervals: [250, 500, 1_000] },
        )
        .toEqual({
          sourceEpochChanged: true,
          duelId,
          duelKeyHex,
          snapshotDigest: sourceBefore?.snapshotDigest,
          outcome: expectedOutcome,
          cancellationReason: expectedReason,
        });
      sourceAfter = await fetchHyperiaAuthorityHealth(request, control);
      expect(sourceAfter).toMatchObject({
        ready: true,
        duelId,
        duelKeyHex,
        snapshotDigest: sourceBefore?.snapshotDigest,
        outcome: expectedOutcome,
        cancellationReason: expectedReason,
        competitiveSnapshotPersisted: true,
        competitiveSnapshotDiagnostic: false,
      });
      expect(sourceAfter.sourceEpoch).toEqual(expect.any(Number));
      expect(sourceAfter.sourceEpoch).not.toBe(sourceBefore?.sourceEpoch);
    } else {
      await publishSolanaCycleState(request, {
        cycleId: `gate10-solana-${duelId}`,
        duelId,
        duelKeyHex,
        betOpenTs,
        betCloseTs,
        duelStartTs,
        phase: "RESOLUTION",
        winner: "NONE",
        outcome: "draw",
        duelEndTs: await currentChainUnixTimestamp(connection),
      });
    }

    await expect
      .poll(
        () => {
          const observed = readSolanaRpcFaultControl(control);
          return {
            faultId: observed?.faultId ?? null,
            state: observed?.state ?? null,
            signature: observed?.signature ?? null,
          };
        },
        { timeout: 60_000, intervals: [100, 250, 500, 1_000] },
      )
      .toMatchObject({
        faultId,
        state: "observed",
        signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/),
      });
    const faultObservation = readSolanaRpcFaultControl(control);
    const forwardedCancellationSignature = faultObservation?.signature ?? "";
    expect(forwardedCancellationSignature).not.toBe("");

    runProcessControl(control, "restart", "keeperBot");
    await waitForKeeperBotHealth(request, "solana", null);

    await expect
      .poll(
        async () => {
          const status = (
            await connection.getSignatureStatuses(
              [forwardedCancellationSignature],
              { searchTransactionHistory: true },
            )
          ).value[0];
          return status
            ? {
                err: status.err,
                confirmationStatus: status.confirmationStatus,
              }
            : null;
        },
        { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] },
      )
      .toEqual({ err: null, confirmationStatus: "finalized" });
    const forwardedTransaction = await connection.getTransaction(
      forwardedCancellationSignature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    );
    expect(forwardedTransaction).not.toBeNull();
    expect(
      forwardedTransaction?.meta?.logMessages?.filter((message) =>
        message.includes("Instruction: CancelDuel"),
      ),
    ).toHaveLength(1);

    await expect
      .poll(
        async () => {
          const exactMarket = (await clobProgram.account.marketState.fetch(
            marketState,
          )) as MarketStateAccount & { status?: unknown; winner?: unknown };
          return `${enumName(exactMarket.status) ?? "missing"}:${enumName(exactMarket.winner) ?? "missing"}`;
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("cancelled:none");

    await expect
      .poll(
        async () => {
          const payload = await fetchBotHealth(request);
          const market = payload.health?.markets.find(
            (entry) => entry.marketRef === marketState.toBase58(),
          );
          return {
            running: payload.running,
            lifecycleStatus: market?.lifecycleStatus ?? null,
            activeRecovery:
              payload.health?.recovery
                .filter((entry) => entry.active)
                .map((entry) => entry.code)
                .sort() ?? [],
          };
        },
        { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toEqual({
        running: EXPECT_KEEPER_BOT,
        lifecycleStatus: "CANCELLED",
        activeRecovery: [],
      });

    const cancelledDuel = (await fightProgram.account.duelState.fetch(
      duelState,
    )) as DuelStateAccountSnapshot;
    expect(enumName(cancelledDuel.status)).toBe("cancelled");
    expect(enumName(cancelledDuel.winner)).toBe("none");
    expect(
      parseDuelCancellationMetadata(String(cancelledDuel.metadataUri)),
    ).toEqual({
      duelId,
      duelKeyHex,
      outcome: expectedOutcome,
      reason: expectedReason,
    });
    const drawnMarket = (await clobProgram.account.marketState.fetch(
      marketState,
    )) as MarketStateAccount & { status?: unknown; winner?: unknown };
    expect(enumName(drawnMarket.status)).toBe("cancelled");
    expect(enumName(drawnMarket.winner)).toBe("none");

    await gotoApp(page);
    await selectChain(page, "solana");
    await ensureWalletConnected(page);
    const postRolloverExpandButton = page
      .locator('button[title="Expand panel"]')
      .first();
    if (await postRolloverExpandButton.isVisible().catch(() => false)) {
      await postRolloverExpandButton.click();
    }
    const priorDuelActivity = settlementEntriesForDuel(page, duelId).first();
    await expect(priorDuelActivity).toContainText("Refund ready to claim", {
      timeout: 30_000,
    });
    const claimButton = priorDuelActivity.getByRole("button", {
      name: /claim refund/i,
    });
    await expect(claimButton).toBeEnabled({ timeout: 30_000 });
    await claimButton.click();
    const claimSignature = await expectSolanaSettlementReceipt(
      page,
      /refund confirmed on-chain/i,
    );
    const [walletDelta, transactionFee] = await Promise.all([
      getWalletLamportDeltaFromSignature(connection, claimSignature, trader),
      getTransactionFeeFromSignature(connection, claimSignature),
    ]);
    expect(walletDelta).not.toBeNull();
    expect(transactionFee).not.toBeNull();
    expect((walletDelta ?? 0n) + (transactionFee ?? 0n)).toBe(
      expectedRefundLamports + userBalanceRentLamports,
    );
    expect(
      await clobProgram.account.userBalance.fetchNullable(userBalanceAddress),
    ).toBeNull();

    await testInfo.attach("solana-terminal-authority-rpc-crash-refund-ui", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await testInfo.attach(
      "solana-terminal-authority-rpc-crash-refund-evidence",
      {
        body: Buffer.from(
          JSON.stringify(
            {
              faultId,
              duelSource: E2E_DUEL_SOURCE,
              expectedOutcome,
              expectedReason,
              sourceBefore,
              sourceAfter,
              forwardedCancellationSignature,
              forwardedAtMs: faultObservation?.observedAtMs ?? null,
              duelId,
              duelKeyHex,
              duelState: duelState.toBase58(),
              marketState: marketState.toBase58(),
              claimSignature,
              expectedRefundLamports: expectedRefundLamports.toString(),
              userBalanceRentLamports: userBalanceRentLamports.toString(),
              walletDelta: walletDelta?.toString() ?? null,
              transactionFee: transactionFee?.toString() ?? null,
              userBalanceClosed: true,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      },
    );
  });
});
