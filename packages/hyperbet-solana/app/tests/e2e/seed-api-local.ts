import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSyntheticDuelCommitment,
  buildSyntheticPublicAgent,
  buildSyntheticRendererHealth,
  E2E_AGENT_A_IDENTITY,
  E2E_AGENT_B_IDENTITY,
  E2E_INITIAL_CYCLE_ID,
} from "./syntheticDuelFixture";

type E2eState = {
  solanaTraderPublicKey?: string;
  currentDuelId?: string;
  currentDuelKeyHex?: string;
  currentBetOpenTimeMs?: number;
  currentBetCloseTimeMs?: number;
  currentFightStartTimeMs?: number;
  currentDuelSource?: "synthetic_publish" | "real_hyperia";
};

async function readState(): Promise<E2eState> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const statePath = path.resolve(__dirname, "./state.json");
  return JSON.parse(await fs.readFile(statePath, "utf8")) as E2eState;
}

function requireString(value: string | undefined, label: string): string {
  const trimmed = value?.trim() || "";
  if (!trimmed) throw new Error(`Missing ${label} in e2e state`);
  return trimmed;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const writeKey =
    process.env.E2E_ARENA_WRITE_KEY?.trim() ||
    process.env.ARENA_EXTERNAL_BET_WRITE_KEY?.trim() ||
    process.env.VITE_ARENA_WRITE_KEY?.trim() ||
    "";
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(writeKey ? { "x-arena-write-key": writeKey } : {}),
      ...(init?.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return JSON.parse(body) as T;
}

async function main(): Promise<void> {
  const state = await readState();
  const gameApiUrl = (process.env.E2E_GAME_API_URL || "http://127.0.0.1:5555")
    .trim()
    .replace(/\/$/, "");
  const primaryWallet = requireString(
    state.solanaTraderPublicKey,
    "solanaTraderPublicKey",
  );
  const agentCharacterId = E2E_AGENT_A_IDENTITY.id;
  const currentDuelId = requireString(state.currentDuelId, "currentDuelId");
  const currentDuelKeyHex = requireString(
    state.currentDuelKeyHex,
    "currentDuelKeyHex",
  );
  const duelSource =
    process.env.E2E_DUEL_SOURCE?.trim().toLowerCase() ||
    state.currentDuelSource ||
    "synthetic_publish";
  const agentName = E2E_AGENT_A_IDENTITY.name;
  const now = Date.now();
  const betOpenTime = state.currentBetOpenTimeMs ?? now - 15_000;
  const betCloseTime = state.currentBetCloseTimeMs ?? now + 300_000;
  const fightStartTime = state.currentFightStartTimeMs ?? now + 360_000;
  const competitiveSnapshot = buildSyntheticDuelCommitment({
    cycleId: E2E_INITIAL_CYCLE_ID,
    duelId: currentDuelId,
    duelKeyHex: currentDuelKeyHex,
    betOpenTs: Math.floor(betOpenTime / 1_000),
    betCloseTs: Math.floor(betCloseTime / 1_000),
    duelStartTs: Math.floor(fightStartTime / 1_000),
  });

  const publishedState =
    duelSource === "real_hyperia"
      ? null
      : await requestJson<{ seq: number }>(
          `${gameApiUrl}/api/streaming/state/publish`,
          {
            method: "POST",
            body: JSON.stringify({
              cycle: {
                cycleId: E2E_INITIAL_CYCLE_ID,
                duelId: currentDuelId,
                duelKeyHex: currentDuelKeyHex,
                phase: "ANNOUNCEMENT",
                cycleStartTime: now - 90_000,
                phaseStartTime: now - 15_000,
                phaseEndTime: now + 300_000,
                betOpenTime,
                betCloseTime,
                fightStartTime,
                duelEndTime: null,
                competitiveSnapshotVersion:
                  competitiveSnapshot.competitiveSnapshotVersion,
                competitiveSnapshotDigest:
                  competitiveSnapshot.competitiveSnapshotDigest,
                competitiveSnapshot: competitiveSnapshot.competitiveSnapshot,
                countdown: 300,
                timeRemaining: 300_000,
                winnerId: null,
                winnerName: null,
                winReason: null,
                agent1: buildSyntheticPublicAgent(
                  {
                    id: agentCharacterId,
                    name: agentName,
                    provider: "Hyperia",
                    model: "alpha-local",
                    hp: 80,
                    maxHp: 100,
                    combatLevel: 88,
                    wins: 12,
                    losses: 4,
                    damageDealtThisFight: 148,
                    rank: 1,
                    headToHeadWins: 3,
                    headToHeadLosses: 2,
                    inventory: [
                      { slot: 0, itemId: "dragon_scimitar", quantity: 1 },
                      { slot: 1, itemId: "shark", quantity: 2 },
                    ],
                    monologues: [
                      {
                        id: "mono-alpha-1",
                        type: "thought",
                        content:
                          "Pressure the midpoint and deny the comeback window.",
                        timestamp: now - 12_000,
                      },
                      {
                        id: "mono-alpha-2",
                        type: "action",
                        content: "Heavy swing lands cleanly on the left flank.",
                        timestamp: now - 7_000,
                      },
                    ],
                  },
                  competitiveSnapshot.competitiveSnapshot,
                  "agent1",
                ),
                agent2: buildSyntheticPublicAgent(
                  {
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
                    inventory: [
                      { slot: 0, itemId: "abyssal_whip", quantity: 1 },
                      { slot: 1, itemId: "anglerfish", quantity: 1 },
                    ],
                    monologues: [
                      {
                        id: "mono-beta-1",
                        type: "thought",
                        content:
                          "Need one clean punish to get back into price discovery.",
                        timestamp: now - 10_000,
                      },
                      {
                        id: "mono-beta-2",
                        type: "action",
                        content:
                          "Retreating toward the pillar to reset the exchange.",
                        timestamp: now - 4_000,
                      },
                    ],
                  },
                  competitiveSnapshot.competitiveSnapshot,
                  "agent2",
                ),
                arenaPositions: {
                  agent1: [-1, 0, 0],
                  agent2: [1, 0, 0],
                },
                rendererHealth: buildSyntheticRendererHealth(now),
              },
              leaderboard: [
                {
                  rank: 1,
                  name: agentName,
                  provider: "Hyperia",
                  model: "alpha-local",
                  wins: 12,
                  losses: 4,
                  winRate: 75,
                  currentStreak: 4,
                },
                {
                  rank: 2,
                  name: "Agent B",
                  provider: "OpenRouter",
                  model: "beta-local",
                  wins: 10,
                  losses: 5,
                  winRate: 66.7,
                  currentStreak: 2,
                },
                {
                  rank: 3,
                  name: "Gamma Spec",
                  provider: "Anthropic",
                  model: "gamma-local",
                  wins: 7,
                  losses: 8,
                  winRate: 46.7,
                  currentStreak: 1,
                },
              ],
              cameraTarget: null,
            }),
          },
        );

  console.log(
    JSON.stringify(
      {
        gameApiUrl,
        primaryWallet,
        publishedSeq: publishedState?.seq ?? null,
        duelSource,
      },
      null,
      2,
    ),
  );
}

void main();
