import http from "node:http";

import { normalizeBettingFeedCycle } from "../../keeper/src/game-client.ts";
import { normalizeFightStartTime } from "./e2e-bet-sync-timeline.ts";

const port = Number(process.env.E2E_BET_SYNC_FEED_PORT || 5656);
const streamStateUrl = (
  process.env.E2E_STREAM_STATE_URL ||
  "http://127.0.0.1:5655/api/streaming/state"
).trim();
const streamEventsUrl = (
  process.env.E2E_STREAM_EVENTS_URL ||
  new URL("/api/streaming/state/events", streamStateUrl).toString()
).trim();
const history = new Map();
let latestState = null;
let stopping = false;
const canonicalWinReasons = new Set([
  "kill",
  "forfeit",
  "hp_advantage",
  "damage_advantage",
  "draw",
]);
const strategyApproaches = new Set([
  "aggressive",
  "defensive",
  "balanced",
  "outlast",
]);
const strategyMacros = new Set([
  "pressure",
  "hold_range",
  "kite",
  "orbit",
  "defensive_reset",
  "finish",
]);
const strategyAttackStyles = new Set([
  "accurate",
  "aggressive",
  "controlled",
  "defensive",
]);
const strategyPrayers = new Set([
  "superhuman_strength",
  "rock_skin",
  "hawk_eye",
  "mystic_lore",
]);
const strategyRoles = new Set(["melee", "ranged", "mage"]);
const strategySources = new Set(["model", "deterministic", "diagnostic"]);
const safePolicyVersion = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function toNullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toNullableInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function normalizeStrategySummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "approach",
      "tacticalMacro",
      "attackStyle",
      "prayer",
      "preferredCombatRole",
      "foodThreshold",
      "switchDefensiveAt",
      "source",
      "policyVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    !strategyApproaches.has(value.approach) ||
    !strategyMacros.has(value.tacticalMacro) ||
    !strategyAttackStyles.has(value.attackStyle) ||
    !(value.prayer === null || strategyPrayers.has(value.prayer)) ||
    !(
      value.preferredCombatRole === null ||
      strategyRoles.has(value.preferredCombatRole)
    ) ||
    !Number.isSafeInteger(value.foodThreshold) ||
    value.foodThreshold < 20 ||
    value.foodThreshold > 60 ||
    !Number.isSafeInteger(value.switchDefensiveAt) ||
    value.switchDefensiveAt < 20 ||
    value.switchDefensiveAt > 40 ||
    !strategySources.has(value.source) ||
    typeof value.policyVersion !== "string" ||
    !safePolicyVersion.test(value.policyVersion)
  ) {
    return null;
  }
  return { ...value };
}

function strategySummaryFromContestant(contestant) {
  const preparation = contestant?.preparation;
  const tacticalStrategy = preparation?.tacticalStrategy;
  if (!preparation || !tacticalStrategy) return null;
  return normalizeStrategySummary({
    schemaVersion: 1,
    approach: tacticalStrategy.approach,
    tacticalMacro: tacticalStrategy.tacticalMacro,
    attackStyle: tacticalStrategy.attackStyle,
    prayer: tacticalStrategy.prayer,
    preferredCombatRole: tacticalStrategy.preferredCombatRole,
    foodThreshold: tacticalStrategy.foodThreshold,
    switchDefensiveAt: tacticalStrategy.switchDefensiveAt,
    source: preparation.planningSource,
    policyVersion: preparation.planningPolicyVersion,
  });
}

function normalizeAgent(value, contestant) {
  if (!value || typeof value !== "object") return null;
  const id = toNullableString(value.id);
  const name = toNullableString(value.name);
  const provider = toNullableString(value.provider);
  const model = toNullableString(value.model);
  const integerFields = [
    "hp",
    "maxHp",
    "combatLevel",
    "wins",
    "losses",
    "damageDealtThisFight",
    "rank",
    "headToHeadWins",
    "headToHeadLosses",
  ];
  if (
    !id ||
    !name ||
    !provider ||
    !model ||
    integerFields.some(
      (field) =>
        !Number.isSafeInteger(value[field]) || Number(value[field]) < 0,
    ) ||
    value.maxHp < 1 ||
    value.combatLevel < 1 ||
    value.hp > value.maxHp
  ) {
    return null;
  }
  const strategySummary = Object.prototype.hasOwnProperty.call(
    value,
    "strategySummary",
  )
    ? normalizeStrategySummary(value.strategySummary)
    : strategySummaryFromContestant(contestant);
  if (!strategySummary) return null;
  return {
    id,
    name,
    provider,
    model,
    hp: value.hp,
    maxHp: value.maxHp,
    combatLevel: value.combatLevel,
    wins: value.wins,
    losses: value.losses,
    damageDealtThisFight: value.damageDealtThisFight,
    rank: value.rank,
    headToHeadWins: value.headToHeadWins,
    headToHeadLosses: value.headToHeadLosses,
    strategySummary,
  };
}

function toBetSyncState(streamState) {
  const cycle =
    streamState?.cycle && typeof streamState.cycle === "object"
      ? streamState.cycle
      : {};
  const seq = Number(streamState?.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("streaming state did not include a valid sequence");
  }
  const winnerId = toNullableString(cycle.winnerId);
  const sourceWinReason =
    toNullableString(cycle.winReason)?.toLowerCase() ?? null;
  const duelId =
    cycle.duelId == null ? null : toNullableString(String(cycle.duelId));
  const phase = duelId ? toNullableString(cycle.phase) : null;
  const cancelled = sourceWinReason?.includes("cancel") ?? false;
  const winReason =
    !cancelled && sourceWinReason && canonicalWinReasons.has(sourceWinReason)
      ? sourceWinReason
      : null;
  const emittedAt = toNullableInteger(streamState.emittedAt) ?? Date.now();
  const contestants = Array.isArray(cycle.competitiveSnapshot?.contestants)
    ? cycle.competitiveSnapshot.contestants
    : [];
  const agent1 = duelId
    ? normalizeAgent(
        cycle.agent1,
        contestants.find(
          (contestant) => contestant?.agentId === cycle.agent1?.id,
        ),
      )
    : null;
  const agent2 = duelId
    ? normalizeAgent(
        cycle.agent2,
        contestants.find(
          (contestant) => contestant?.agentId === cycle.agent2?.id,
        ),
      )
    : null;
  const explicitOutcome = ["win", "draw", "cancelled"].includes(cycle.outcome)
    ? cycle.outcome
    : null;
  const outcome =
    explicitOutcome ??
    (cancelled
      ? "cancelled"
      : phase === "RESOLUTION" && winnerId
        ? "win"
        : null);
  const requestedFightStartTime = toNullableInteger(cycle.fightStartTime);
  const duelEndTime = toNullableInteger(cycle.duelEndTime);
  const fightStartTime = normalizeFightStartTime({
    phase,
    scheduledFightStartTime: requestedFightStartTime,
    duelEndTime,
    emittedAt,
  });
  const state = {
    schemaVersion: 3,
    sourceEpoch: 1,
    seq,
    emittedAt,
    phaseVersion: seq,
    duelId,
    duelKey: toNullableString(cycle.duelKeyHex),
    competitiveSnapshotVersion: duelId
      ? toNullableInteger(cycle.competitiveSnapshotVersion)
      : null,
    competitiveSnapshotDigest: duelId
      ? toNullableString(cycle.competitiveSnapshotDigest)
      : null,
    competitiveSnapshot:
      duelId && cycle.competitiveSnapshot ? cycle.competitiveSnapshot : null,
    phase,
    betOpenTime: toNullableInteger(cycle.betOpenTime),
    betCloseTime: toNullableInteger(cycle.betCloseTime),
    fightStartTime,
    duelEndTime,
    winnerId,
    outcome,
    cancellationReason:
      outcome === "draw"
        ? "draw"
        : outcome === "cancelled"
          ? (toNullableString(cycle.cancellationReason) ?? sourceWinReason)
          : null,
    winReason,
    seed: toNullableString(cycle.seed),
    replayHash: toNullableString(cycle.replayHash),
    agent1,
    agent2,
    arenaPositions: duelId
      ? (cycle.arenaPositions ?? {
          agent1: [-1, 0, 0],
          agent2: [1, 0, 0],
        })
      : null,
    winnerName:
      winnerId === agent1?.id
        ? agent1.name
        : winnerId === agent2?.id
          ? agent2.name
          : null,
    rendererHealth: {
      ready: true,
      degradedReason: null,
      updatedAt: emittedAt,
    },
  };
  if (!normalizeBettingFeedCycle(state)) {
    throw new Error(
      `translated invalid schema-v3 frame: ${JSON.stringify(state)}`,
    );
  }
  if (latestState && seq < latestState.seq) {
    return latestState;
  }
  history.set(seq, state);
  latestState = state;
  while (history.size > 256) {
    history.delete(Math.min(...history.keys()));
  }
  return state;
}

async function currentState() {
  if (latestState) return latestState;
  const response = await fetch(streamStateUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`streaming state returned HTTP ${response.status}`);
  }
  return toBetSyncState(await response.json());
}

async function consumeStreamEvents() {
  while (!stopping) {
    try {
      const response = await fetch(streamEventsUrl, { cache: "no-store" });
      if (!response.ok || !response.body) {
        throw new Error(`stream events returned HTTP ${response.status}`);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder
          .decode(chunk, { stream: true })
          .replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          if (!frame.trim() || frame.startsWith(":")) continue;
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          toBetSyncState(JSON.parse(data));
        }
      }
    } catch (error) {
      if (!stopping) {
        console.error(
          `[e2e-bet-sync] stream subscription failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (
      request.method === "GET" &&
      url.pathname === "/api/internal/bet-sync/state"
    ) {
      sendJson(response, 200, await currentState());
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/internal/bet-sync/events"
    ) {
      const latest = await currentState();
      const since = Number(url.searchParams.get("since") || 0);
      const events = [...history.values()]
        .filter((entry) => entry.seq > since && entry.seq <= latest.seq)
        .sort((left, right) => left.seq - right.seq);
      response.writeHead(200, {
        "cache-control": "no-store",
        connection: "close",
        "content-type": "text/event-stream; charset=utf-8",
      });
      for (const event of events) {
        response.write(
          `id: ${event.seq}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      response.end();
      return;
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, 503, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[e2e-bet-sync] listening on http://127.0.0.1:${port}`);
  void consumeStreamEvents();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    server.close(() => process.exit(0));
  });
}
