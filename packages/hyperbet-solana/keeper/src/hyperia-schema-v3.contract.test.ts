import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  GameClient,
  normalizeBettingFeedCycle,
  normalizeLifecycleEvent,
  type BettingFeedStateUpdate,
} from "./game-client";
import { classifyDuelTerminal } from "./duelTerminalPolicy";
import { parseStreamingOperatorMetrics as parseHyperbetStreamingOperatorMetrics } from "./streamOperatorHealth";

type ExpectedTerminalDisposition =
  | { action: "settle"; winnerSide: "A" | "B" }
  | { action: "cancel"; outcome: "draw" | "cancelled"; reason: string }
  | null;

type HyperiaContractPayload = BettingFeedStateUpdate &
  Record<string, unknown> & {
    sourceEpoch: number;
    seq: number;
    duelId: string | null;
    duelKey: string | null;
    phase: string | null;
    winnerId: string | null;
    outcome: "win" | "draw" | "cancelled" | null;
    cancellationReason: string | null;
    winReason:
      "kill" | "forfeit" | "hp_advantage" | "damage_advantage" | "draw" | null;
    seed: string | null;
    replayHash: string | null;
  };

type HyperiaContractCase = {
  name: string;
  expected: {
    callbacks: Array<"start" | "lock" | "end">;
    terminalDisposition: ExpectedTerminalDisposition;
  };
  payload: HyperiaContractPayload;
};

type HyperiaContractFixture = {
  contract: string;
  schemaVersion: number;
  producer: string;
  cases: HyperiaContractCase[];
};

const originalFetch = globalThis.fetch;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const hyperbetRepository = resolve(sourceDirectory, "../../../..");
const hyperiaRepository =
  process.env.HYPERIA_REPOSITORY_DIR?.trim() ||
  resolve(hyperbetRepository, "../hyperia-implementation");
const fixturePath = resolve(
  hyperiaRepository,
  "packages/server/tests/fixtures/hyperbet/betting-feed-schema-v3.json",
);

if (!existsSync(fixturePath)) {
  throw new Error(
    `Hyperia schema-v3 contract fixture is required at ${fixturePath}. Set HYPERIA_REPOSITORY_DIR to the Hyperia checkout when the repositories are not siblings.`,
  );
}

const fixture = JSON.parse(
  readFileSync(fixturePath, "utf8"),
) as HyperiaContractFixture;

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function mutateSnapshot(
  payload: HyperiaContractPayload,
  mutate: (snapshot: Record<string, unknown>) => void,
): BettingFeedStateUpdate {
  const corrupted = structuredClone(payload);
  const snapshot = corrupted.competitiveSnapshot as Record<string, unknown>;
  mutate(snapshot);
  corrupted.competitiveSnapshotDigest = createHash("sha256")
    .update(canonicalJson(snapshot))
    .digest("hex");
  return corrupted;
}

function terminalDisposition(contractCase: HyperiaContractCase) {
  const normalized = normalizeBettingFeedCycle(contractCase.payload);
  if (!normalized) return null;
  const event = normalizeLifecycleEvent(normalized);
  if (!event || !contractCase.expected.terminalDisposition) return null;
  return classifyDuelTerminal({
    outcome: event.outcome,
    cancellationReason: event.cancellationReason,
    winnerId: event.winnerId,
    agent1Id: event.agent1?.id ?? null,
    agent2Id: event.agent2?.id ?? null,
  });
}

describe("Hyperia schema-v3 producer/Hyperbet consumer contract", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("loads a unique, current production-producer fixture matrix", () => {
    expect(fixture).toMatchObject({
      contract: "hyperia-betting-feed",
      schemaVersion: 3,
      producer:
        "packages/server/src/routes/streaming-betting-feed.ts#buildBettingFeedPayload",
    });
    expect(fixture.cases.length).toBe(17);
    expect(new Set(fixture.cases.map(({ name }) => name)).size).toBe(
      fixture.cases.length,
    );
    expect(
      fixture.cases.filter(
        ({ expected }) => expected.terminalDisposition?.action === "settle",
      ),
    ).toHaveLength(2);
    expect(
      fixture.cases.filter(
        ({ expected }) => expected.terminalDisposition?.action === "cancel",
      ),
    ).toHaveLength(11);
    expect(
      fixture.cases.find(
        ({ name }) =>
          name === "cancel-competitive-snapshot-recovery-window-elapsed",
      ),
    ).toMatchObject({
      expected: {
        callbacks: ["end"],
        terminalDisposition: {
          action: "cancel",
          outcome: "cancelled",
          reason: "competitive_snapshot_recovery_window_elapsed",
        },
      },
      payload: {
        phase: "ANNOUNCEMENT",
        arenaPositions: null,
        winnerId: null,
        outcome: "cancelled",
        cancellationReason: "competitive_snapshot_recovery_window_elapsed",
        seed: null,
        replayHash: null,
      },
    });
    const activeCases = fixture.cases.filter(
      ({ payload }) => payload.duelId !== null,
    );
    expect(activeCases).toHaveLength(16);
    for (const contractCase of activeCases) {
      expect(
        contractCase.payload.competitiveSnapshotVersion,
        contractCase.name,
      ).toBe(4);
      const snapshot = contractCase.payload.competitiveSnapshot as Record<
        string,
        unknown
      >;
      const timing = snapshot.timing as Record<string, unknown>;
      expect(snapshot.snapshotVersion, contractCase.name).toBe(4);
      expect(timing.contractVersion, contractCase.name).toBe(2);
      expect(timing.timeoutPolicy, contractCase.name).toBe(
        "hp_percentage_then_damage_then_draw_v1",
      );
      for (const field of [
        "countdownDurationMs",
        "fightingDurationMs",
        "endWarningDurationMs",
        "maxFightDurationMs",
        "fightStartTime",
        "fightDeadline",
      ]) {
        expect(Number.isSafeInteger(timing[field]), contractCase.name).toBe(
          true,
        );
      }
      expect(timing.maxFightDurationMs, contractCase.name).toBe(
        Number(timing.fightingDurationMs) + Number(timing.endWarningDurationMs),
      );
      expect(timing.fightStartTime, contractCase.name).toBe(
        Number(contractCase.payload.betCloseTime) +
          Number(timing.countdownDurationMs),
      );
      expect(timing.fightDeadline, contractCase.name).toBe(
        Number(timing.fightStartTime) + Number(timing.maxFightDurationMs),
      );
    }
  });

  test("keeps the numeric streaming-operations producer and consumer contracts aligned", async () => {
    const producerModulePath = resolve(
      hyperiaRepository,
      "packages/server/src/routes/streaming-operator-metrics.ts",
    );
    if (!existsSync(producerModulePath)) {
      throw new Error(
        `Hyperia streaming-operator producer is required at ${producerModulePath}`,
      );
    }
    const producer = (await import(pathToFileURL(producerModulePath).href)) as {
      buildStreamingOperatorMetrics(input: {
        nowMs: number;
        health: {
          ready: boolean;
          emittedAt: number;
          checks: Record<
            | "schedulerAuthority"
            | "bettingFeed"
            | "renderer"
            | "captureClient"
            | "encoder"
            | "audio"
            | "rtmpDelivery"
            | "keeper"
            | "projectileCostCustody",
            { ready: boolean; reason: string | null; observedAt: number | null }
          >;
        };
        rendererPerformance: {
          overall: {
            frames: number;
            frameIntervalMs: { average: number; p95: number };
            frameWorkMs: { p95: number };
          };
          longFrames: unknown[];
        } | null;
        captureHealth: {
          targetFps: number;
          measuredFps: number | null;
        } | null;
        encoderFps: number | null;
        droppedFrames: number;
      }): unknown;
      parseStreamingOperatorMetrics(value: unknown): unknown;
    };
    const observedAtMs = 10_000;
    const checks = Object.fromEntries(
      [
        "schedulerAuthority",
        "bettingFeed",
        "renderer",
        "captureClient",
        "encoder",
        "audio",
        "rtmpDelivery",
        "keeper",
        "projectileCostCustody",
      ].map((name, index) => [
        name,
        {
          ready: true,
          reason: null,
          observedAt: observedAtMs - 100 - index,
        },
      ]),
    ) as Record<
      | "schedulerAuthority"
      | "bettingFeed"
      | "renderer"
      | "captureClient"
      | "encoder"
      | "audio"
      | "rtmpDelivery"
      | "keeper"
      | "projectileCostCustody",
      { ready: boolean; reason: string | null; observedAt: number | null }
    >;
    const metrics = producer.buildStreamingOperatorMetrics({
      nowMs: observedAtMs,
      health: { ready: true, emittedAt: observedAtMs, checks },
      rendererPerformance: {
        overall: {
          frames: 600,
          frameIntervalMs: { average: 16.667, p95: 18 },
          frameWorkMs: { p95: 7 },
        },
        longFrames: [],
      },
      captureHealth: { targetFps: 30, measuredFps: 29.97 },
      encoderFps: 29.9,
      droppedFrames: 0,
    });

    expect(parseHyperbetStreamingOperatorMetrics(metrics)).toEqual(
      producer.parseStreamingOperatorMetrics(metrics),
    );
    const corrupted = structuredClone(metrics) as {
      frames: { rendererLongFrameCount: number; rendererSamples: number };
    };
    corrupted.frames.rendererLongFrameCount =
      corrupted.frames.rendererSamples + 1;
    expect(parseHyperbetStreamingOperatorMetrics(corrupted)).toBeNull();
    expect(producer.parseStreamingOperatorMetrics(corrupted)).toBeNull();
  }, 60_000);

  test("parses every actual Hyperia frame without losing canonical identity or terminal semantics", () => {
    for (const contractCase of fixture.cases) {
      const normalized = normalizeBettingFeedCycle(contractCase.payload);
      expect(normalized, contractCase.name).not.toBeNull();
      if (!normalized) continue;

      expect(normalized.sourceEpoch, contractCase.name).toBe(
        contractCase.payload.sourceEpoch,
      );
      expect(normalized.seq, contractCase.name).toBe(contractCase.payload.seq);
      expect(normalized.duelId, contractCase.name).toBe(
        contractCase.payload.duelId,
      );
      expect(normalized.duelKeyHex, contractCase.name).toBe(
        contractCase.payload.duelKey,
      );
      expect(normalized.phase, contractCase.name).toBe(
        contractCase.payload.phase ?? "IDLE",
      );
      expect(normalized.outcome, contractCase.name).toBe(
        contractCase.payload.outcome,
      );
      expect(normalized.cancellationReason, contractCase.name).toBe(
        contractCase.payload.cancellationReason,
      );
      expect(normalized.winReason, contractCase.name).toBe(
        contractCase.payload.winReason,
      );
      expect(normalized.winnerId, contractCase.name).toBe(
        contractCase.payload.winnerId,
      );
      expect(normalized.seed, contractCase.name).toBe(
        contractCase.payload.seed,
      );
      expect(normalized.replayHash, contractCase.name).toBe(
        contractCase.payload.replayHash,
      );

      const lifecycleEvent = normalizeLifecycleEvent(normalized);
      expect(Boolean(lifecycleEvent), contractCase.name).toBe(
        contractCase.payload.duelId !== null,
      );

      const expectedDisposition = contractCase.expected.terminalDisposition;
      if (expectedDisposition?.action === "settle") {
        expect(terminalDisposition(contractCase), contractCase.name).toEqual({
          action: "settle",
          winnerSide: expectedDisposition.winnerSide,
          compatibilityMode: "canonical",
        });
      } else if (expectedDisposition?.action === "cancel") {
        expect(terminalDisposition(contractCase), contractCase.name).toEqual(
          expectedDisposition,
        );
      } else {
        expect(terminalDisposition(contractCase), contractCase.name).toBeNull();
      }
    }
  });

  test("drives the real GameClient callbacks from every actual producer fixture", async () => {
    for (const contractCase of fixture.cases) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(contractCase.payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      const callbacks: Array<"start" | "lock" | "end"> = [];
      const client = new GameClient("https://hyperia.contract.test");
      client.onDuelStart(() => {
        callbacks.push("start");
      });
      client.onBettingLocked(() => {
        callbacks.push("lock");
      });
      client.onDuelEnd(() => {
        callbacks.push("end");
      });

      await (client as unknown as { poll(): Promise<void> }).poll();
      client.disconnect();

      expect(callbacks, contractCase.name).toEqual(
        contractCase.expected.callbacks,
      );
    }
  });

  test("does not emit terminal settlement for a resolution frame without an authoritative outcome", async () => {
    const win = fixture.cases.find(({ name }) => name === "win-agent-a-kill");
    expect(win).toBeDefined();
    if (!win) return;

    const incompleteResolution: HyperiaContractPayload = {
      ...win.payload,
      duelEndTime: null,
      winnerId: null,
      winnerName: null,
      outcome: null,
      cancellationReason: null,
      winReason: null,
      seed: null,
      replayHash: null,
    };
    expect(normalizeBettingFeedCycle(incompleteResolution)).not.toBeNull();

    globalThis.fetch = (async () =>
      new Response(JSON.stringify(incompleteResolution), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const callbacks: Array<"start" | "lock" | "end"> = [];
    const client = new GameClient("https://hyperia.contract.test");
    client.onDuelStart(() => {
      callbacks.push("start");
    });
    client.onBettingLocked(() => {
      callbacks.push("lock");
    });
    client.onDuelEnd(() => {
      callbacks.push("end");
    });

    await (client as unknown as { poll(): Promise<void> }).poll();
    client.disconnect();

    expect(callbacks).toEqual(["start", "lock"]);
  });

  test("fails closed when canonical producer invariants are corrupted", () => {
    const announcement = fixture.cases.find(
      ({ name }) => name === "announcement",
    );
    const win = fixture.cases.find(({ name }) => name === "win-agent-a-kill");
    const draw = fixture.cases.find(({ name }) => name === "draw");
    const cancelled = fixture.cases.find(
      ({ name }) => name === "cancel-combat-engagement-failed",
    );
    expect(announcement).toBeDefined();
    expect(win).toBeDefined();
    expect(draw).toBeDefined();
    expect(cancelled).toBeDefined();
    if (!announcement || !win || !draw || !cancelled) return;

    const corruptions: BettingFeedStateUpdate[] = [
      { ...announcement.payload, duelKey: "ab" },
      { ...announcement.payload, duelId: null },
      { ...announcement.payload, phase: "SETTLING" },
      { ...announcement.payload, betOpenTime: -1 },
      { ...announcement.payload, outcome: "loss" as "win" },
      {
        ...announcement.payload,
        agent1: { ...announcement.payload.agent1!, id: "" },
      },
      { ...announcement.payload, replayHash: "not-a-hash" },
      { ...win.payload, winnerId: null },
      { ...win.payload, phase: "FIGHTING" },
      { ...win.payload, winReason: "draw" },
      { ...win.payload, seed: null },
      { ...draw.payload, winnerId: "agent-a" },
      { ...draw.payload, cancellationReason: "cancelled" },
      { ...cancelled.payload, winReason: "kill" },
      { ...cancelled.payload, replayHash: "ab".repeat(32) },
      {
        ...cancelled.payload,
        cancellationReason: "not safe for a public feed",
      },
      { ...win.payload, winnerId: "not-a-contestant", winnerName: "Unknown" },
      { ...win.payload, seed: "18446744073709551616" },
      {
        ...win.payload,
        fightStartTime: Number(win.payload.betCloseTime) - 1,
      },
      {
        ...win.payload,
        duelEndTime: Number(win.payload.fightStartTime) - 1,
      },
      {
        ...win.payload,
        duelEndTime: Number(win.payload.emittedAt) + 1,
      },
      {
        ...announcement.payload,
        agent1: {
          ...(announcement.payload.agent1 as Record<string, unknown>),
          walletSecret: "must-not-be-accepted",
        } as never,
      },
      {
        ...announcement.payload,
        agent1: {
          ...(announcement.payload.agent1 as Record<string, unknown>),
          strategySummary: null,
        } as never,
      },
      {
        ...announcement.payload,
        agent1: {
          ...(announcement.payload.agent1 as Record<string, unknown>),
          strategySummary: {
            ...((announcement.payload.agent1 as Record<string, unknown>)
              .strategySummary as Record<string, unknown>),
            tacticalMacro: "kite",
          },
        } as never,
      },
      {
        ...announcement.payload,
        agent1: {
          ...(announcement.payload.agent1 as Record<string, unknown>),
          strategySummary: {
            ...((announcement.payload.agent1 as Record<string, unknown>)
              .strategySummary as Record<string, unknown>),
            reasoning: "private model rationale",
          },
        } as never,
      },
      {
        ...announcement.payload,
        privateBankSnapshot: [],
      } as BettingFeedStateUpdate,
      mutateSnapshot(announcement.payload, (snapshot) => {
        snapshot.privateBankSnapshot = [];
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        snapshot.combatPolicyVersion = "unknown-policy";
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const timing = snapshot.timing as Record<string, unknown>;
        timing.timeoutPolicy = "unknown-timeout-policy";
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const timing = snapshot.timing as Record<string, unknown>;
        timing.contractVersion = 3;
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const timing = snapshot.timing as Record<string, unknown>;
        timing.maxFightDurationMs = Number(timing.maxFightDurationMs) + 1;
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const timing = snapshot.timing as Record<string, unknown>;
        timing.fightStartTime = Number(timing.fightStartTime) + 1;
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const timing = snapshot.timing as Record<string, unknown>;
        timing.fightDeadline = Number(timing.fightDeadline) + 1;
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        delete snapshot.timing;
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const contestants = snapshot.contestants as Array<
          Record<string, unknown>
        >;
        const preparation = contestants[0]!.preparation as Record<
          string,
          unknown
        >;
        preparation.model = "different-model";
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const contestants = snapshot.contestants as Array<
          Record<string, unknown>
        >;
        const preparation = contestants[0]!.preparation as Record<
          string,
          unknown
        >;
        const strategy = preparation.tacticalStrategy as Record<
          string,
          unknown
        >;
        strategy.tacticalMacro = "teleport";
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const contestants = snapshot.contestants as Array<
          Record<string, unknown>
        >;
        const preparation = contestants[0]!.preparation as Record<
          string,
          unknown
        >;
        const strategy = preparation.tacticalStrategy as Record<
          string,
          unknown
        >;
        strategy.itemId = "private_bank_item";
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const contestants = snapshot.contestants as Array<
          Record<string, unknown>
        >;
        const preparation = contestants[0]!.preparation as Record<
          string,
          unknown
        >;
        const strategy = preparation.tacticalStrategy as Record<
          string,
          unknown
        >;
        strategy.foodThreshold = 100;
      }),
      mutateSnapshot(announcement.payload, (snapshot) => {
        const contestants = snapshot.contestants as Array<
          Record<string, unknown>
        >;
        const preparation = contestants[0]!.preparation as Record<
          string,
          unknown
        >;
        const strategy = preparation.tacticalStrategy as Record<
          string,
          unknown
        >;
        strategy.reasoning = "Hidden\u202e direction";
      }),
    ];

    for (const corrupted of corruptions) {
      expect(normalizeBettingFeedCycle(corrupted)).toBeNull();
    }
  });
});
