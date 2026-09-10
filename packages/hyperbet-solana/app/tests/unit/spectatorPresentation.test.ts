import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  buildStreamReadinessDiagnostics,
  classifySpectatorTerminalOutcome,
  deriveSpectatorPresentationState,
  getSpectatorMatchupHeading,
  getSpectatorStatusCopy,
  getSpectatorTerminalMarketFallbackCopy,
  getStreamRecoveryDetail,
  getStreamRecoveryHeading,
  getStreamRecoveryMode,
  selectSpectatorDisplayPhase,
  selectSpectatorPresentationUpdate,
} from "../../src/spectator/presentation";
import type { StreamingStateUpdate } from "../../src/spectator/types";

const NOW_MS = 1_700_000_000_000;
const DUEL_KEY = "ab".repeat(32);

function makeState(
  overrides: Partial<StreamingStateUpdate> = {},
): StreamingStateUpdate {
  return {
    type: "STREAMING_STATE_UPDATE",
    emittedAt: NOW_MS - 8_000,
    seq: 42,
    cameraTarget: null,
    leaderboard: [],
    cycle: {
      cycleId: "cycle-42",
      phase: "FIGHTING",
      cycleStartTime: NOW_MS - 30_000,
      phaseStartTime: NOW_MS - 20_000,
      phaseEndTime: NOW_MS + 70_000,
      timeRemaining: 70_000,
      agent1: {
        id: "astra",
        name: "Astra",
        provider: "",
        model: "",
        hp: 40,
        maxHp: 50,
        combatLevel: 70,
        wins: 1,
        losses: 0,
        damageDealtThisFight: 10,
      },
      agent2: {
        id: "boros",
        name: "Boros",
        provider: "",
        model: "",
        hp: 35,
        maxHp: 50,
        combatLevel: 71,
        wins: 0,
        losses: 1,
        damageDealtThisFight: 15,
      },
      duelId: "duel-42",
      duelKeyHex: DUEL_KEY,
      countdown: null,
      winnerId: null,
      winnerName: null,
      winReason: null,
      cancellationReason: null,
      rendererHealth: {
        ready: true,
        degradedReason: null,
        updatedAt: NOW_MS - 250,
      },
    },
    ...overrides,
  };
}

function makeReadinessInput(
  overrides: Partial<
    Parameters<typeof buildStreamReadinessDiagnostics>[0]
  > = {},
): Parameters<typeof buildStreamReadinessDiagnostics>[0] {
  return {
    evaluatedNowMs: NOW_MS,
    recoveryMode: "hidden",
    hookRendererReady: true,
    currentPresentationRendererReady: true,
    currentConnected: true,
    presentationConnected: true,
    playbackReady: true,
    playbackDateMs: NOW_MS - 8_000,
    maxAgeMs: 15_000,
    uiSyncDelayMs: 8_000,
    currentState: makeState(),
    presentationState: makeState(),
    ...overrides,
  };
}

describe("spectator presentation authority", () => {
  test("samples authority time on every render while keeping the display countdown in seconds", () => {
    const appSource = readFileSync(
      new URL("../../src/App.tsx", import.meta.url),
      "utf8",
    );
    expect(appSource.includes("const nowMs = Date.now();")).toBe(true);
    expect(appSource.includes("const nowTs = Math.floor(nowMs / 1_000);")).toBe(
      true,
    );
    expect(appSource.includes("nowMs: nowTs * 1_000")).toBe(false);
    expect(appSource.includes("streamPlaybackDateMs ?? nowTs * 1_000")).toBe(
      false,
    );
    expect(
      appSource.includes("setClockRevision((revision) => revision + 1)"),
    ).toBe(true);
    expect(
      appSource.includes(
        "data-stream-readiness={JSON.stringify(streamReadinessDiagnostics)}",
      ),
    ).toBe(true);
  });

  test("fresh same-second and between-tick frames do not acquire a false future-health outage", () => {
    const lastIntervalAt = NOW_MS + 125;
    for (const observedAt of [NOW_MS + 392, NOW_MS + 999, NOW_MS + 1_124]) {
      const healthUpdatedAt = observedAt - 50;
      const current = makeState({
        emittedAt: observedAt - 25,
        cycle: {
          ...makeState().cycle,
          rendererHealth: {
            ready: true,
            degradedReason: null,
            updatedAt: healthUpdatedAt,
          },
        },
      });
      const present = (nowMs: number) =>
        deriveSpectatorPresentationState({
          state: current,
          streamConnected: true,
          nowMs,
          streamMaxAgeMs: 15_000,
          uiSyncDelayMs: 0,
        });
      const fresh = present(observedAt);
      expect(fresh.rendererReady).toBe(true);
      expect(fresh.hasFreshCycle).toBe(true);
      expect(
        getStreamRecoveryHeading({
          playbackReady: true,
          telemetryConnected: true,
          rendererReady: fresh.rendererReady,
          presentationReady: fresh.hasFreshCycle,
          hasStreamState: true,
        }),
      ).toBeNull();
      // Both a rounded clock and even an unrounded clock cached at the last
      // interval tick reject these genuinely fresh inter-tick observations.
      expect(
        present(Math.floor(observedAt / 1_000) * 1_000).rendererReady,
      ).toBe(healthUpdatedAt <= Math.floor(observedAt / 1_000) * 1_000);
      expect(present(lastIntervalAt).rendererReady).toBe(false);
    }
  });

  test("a precise render clock still rejects future, expired and malformed renderer health", () => {
    const nowMs = NOW_MS + 392;
    for (const updatedAt of [
      nowMs + 1,
      nowMs - 15_001,
      Number.NaN,
      nowMs - 0.5,
      null,
    ]) {
      const presentation = deriveSpectatorPresentationState({
        state: makeState({
          emittedAt: nowMs - 25,
          cycle: {
            ...makeState().cycle,
            rendererHealth: { ready: true, degradedReason: null, updatedAt },
          },
        }),
        streamConnected: true,
        nowMs,
        streamMaxAgeMs: 15_000,
        uiSyncDelayMs: 0,
      });
      expect(presentation.rendererReady).toBe(false);
      expect(presentation.hasFreshCycle).toBe(false);
    }
  });

  test("projects distinct current and displayed authority without hiding a hook disagreement", () => {
    const currentState = makeState({ seq: 51, emittedAt: NOW_MS - 25 });
    const presentationState = makeState({
      seq: 42,
      cycle: { ...makeState().cycle, phase: "RESOLUTION" },
    });
    const diagnostic = buildStreamReadinessDiagnostics(
      makeReadinessInput({
        recoveryMode: "blocking",
        hookRendererReady: false,
        currentState,
        presentationState,
      }),
    );
    expect(diagnostic).toEqual({
      schemaVersion: 1,
      evaluatedNowMs: NOW_MS,
      recoveryMode: "blocking",
      hookRendererReady: false,
      currentPresentationRendererReady: true,
      currentConnected: true,
      presentationConnected: true,
      playbackReady: true,
      playbackDateMs: NOW_MS - 8_000,
      maxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
      current: {
        seq: 51,
        emittedAt: NOW_MS - 25,
        cycleId: "cycle-42",
        duelId: "duel-42",
        duelKeyHex: DUEL_KEY,
        phase: "FIGHTING",
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: NOW_MS - 250,
        },
      },
      presentation: {
        seq: 42,
        emittedAt: NOW_MS - 8_000,
        cycleId: "cycle-42",
        duelId: "duel-42",
        duelKeyHex: DUEL_KEY,
        phase: "RESOLUTION",
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: NOW_MS - 250,
        },
      },
    });
    expect(currentState.cycle.phase).toBe("FIGHTING");
    expect(presentationState.cycle.phase).toBe("RESOLUTION");
  });

  test("keeps future diagnostic timestamps visible and missing or malformed values distinct", () => {
    const currentState = makeState({
      seq: Number.NaN,
      emittedAt: NOW_MS + 1,
      cycle: {
        ...makeState().cycle,
        duelId: undefined,
        duelKeyHex: null,
        rendererHealth: {
          ready: false,
          degradedReason: "capture_process_exited",
          updatedAt: NOW_MS + 2,
        },
      },
    });
    const diagnostic = buildStreamReadinessDiagnostics(
      makeReadinessInput({
        currentState,
        presentationState: null,
        playbackDateMs: null,
      }),
    );
    expect(diagnostic.presentation).toBeNull();
    expect(diagnostic.playbackDateMs).toBeNull();
    expect(
      buildStreamReadinessDiagnostics(
        makeReadinessInput({
          playbackDateMs: NOW_MS - 8_000.25,
        }),
      ).playbackDateMs,
    ).toBe(NOW_MS - 8_000.25);
    expect(diagnostic.current).toMatchObject({
      seq: null,
      emittedAt: NOW_MS + 1,
      duelId: null,
      duelKeyHex: null,
      rendererHealth: {
        ready: false,
        degradedReason: "capture_process_exited",
        updatedAt: NOW_MS + 2,
      },
    });
    for (const malformed of [
      Number.NaN,
      Infinity,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const invalid = buildStreamReadinessDiagnostics(
        makeReadinessInput({
          currentState: makeState({
            seq: malformed,
            emittedAt: malformed,
            cycle: {
              ...makeState().cycle,
              rendererHealth: {
                ready: true,
                degradedReason: null,
                updatedAt: malformed,
              },
            },
          }),
        }),
      );
      expect(invalid.current?.seq).toBeNull();
      expect(invalid.current?.emittedAt).toBeNull();
      expect(invalid.current?.rendererHealth?.updatedAt).toBeNull();
    }
    expect(
      buildStreamReadinessDiagnostics(
        makeReadinessInput({
          currentState: makeState({
            cycle: { ...makeState().cycle, rendererHealth: null },
          }),
        }),
      ).current?.rendererHealth,
    ).toBeNull();
  });

  test("bounds diagnostic serialization and excludes non-whitelisted state fields", () => {
    const privateMarker = "PRIVATE_STATE_MUST_NOT_BE_PROJECTED";
    const longText = "\u0000".repeat(10_000);
    const stateWithExtras = {
      ...makeState(),
      sourceEpoch: privateMarker,
      frameSeq: privateMarker,
      privateAuthority: privateMarker,
      preparation: { privateMarker },
      cycle: {
        ...makeState().cycle,
        cycleId: longText,
        duelId: longText,
        duelKeyHex: longText,
        rendererHealth: {
          ready: false,
          degradedReason: longText,
          updatedAt: NOW_MS,
          privateMarker,
        },
      },
    };
    const diagnostic = buildStreamReadinessDiagnostics(
      makeReadinessInput({
        currentState: stateWithExtras,
        presentationState: stateWithExtras,
      }),
    );
    const serialized = JSON.stringify(diagnostic);
    expect(serialized.length).toBeLessThan(8_192);
    expect(serialized.includes(privateMarker)).toBe(false);
    expect(Object.keys(diagnostic.current ?? {})).toEqual([
      "seq",
      "emittedAt",
      "cycleId",
      "duelId",
      "duelKeyHex",
      "phase",
      "rendererHealth",
    ]);
    expect(diagnostic.current?.cycleId?.length).toBe(128);
    expect(diagnostic.current?.duelId?.length).toBe(128);
    expect(diagnostic.current?.duelKeyHex?.length).toBe(64);
    expect(diagnostic.current?.rendererHealth?.degradedReason?.length).toBe(
      128,
    );
    expect(stateWithExtras.cycle.cycleId.length).toBe(10_000);
  });

  test("projects bounded phase-handoff inputs without granting authority from healthy delayed diagnostics", () => {
    const derivation = {
      schemaVersion: 1 as const,
      evaluatedAtMs: NOW_MS,
      canonicalCycleId: "cycle-a",
      canonicalPhase: "COUNTDOWN",
      externalSnapshotPresent: true,
      externalSnapshotUpdatedAt: NOW_MS - 1,
      rendererPresent: true,
      rendererReady: true,
      rendererPhase: "ANNOUNCEMENT",
      rendererDegradedReason: null,
      rendererUpdatedAt: NOW_MS - 2,
      scenePresent: true,
      sceneReady: true,
      sceneCycleId: "cycle-a",
      scenePhase: "ANNOUNCEMENT",
      captureClientConnected: true,
      captureFfmpegRunning: true,
    };
    const state = makeState();
    state.cycle.rendererHealth = {
      ready: false,
      degradedReason: "renderer_phase_mismatch",
      updatedAt: NOW_MS,
      derivation,
    };
    const input = makeReadinessInput({
      currentState: state,
      presentationState: state,
    });
    const projected = buildStreamReadinessDiagnostics(input);
    expect(projected.current?.rendererHealth?.derivation).toEqual(derivation);
    expect(projected.presentation?.rendererHealth?.derivation).toEqual(
      derivation,
    );
    expect(
      deriveSpectatorPresentationState({
        state,
        streamConnected: true,
        nowMs: NOW_MS,
        streamMaxAgeMs: 15_000,
        uiSyncDelayMs: 8_000,
      }).rendererReady,
    ).toBe(false);
    Object.assign(state.cycle.rendererHealth, {
      derivation: {
        ...derivation,
        rendererUpdatedAt: NOW_MS + 10_000,
        sceneCycleId: "x".repeat(129),
        rendererPhase: "https://private.invalid",
        rendererDegradedReason: "PRIVATE ERROR BODY",
        externalSnapshotUpdatedAt: Number.NaN,
        privateAuthority: "NOT_PUBLIC",
      },
    });
    const bounded = buildStreamReadinessDiagnostics(input);
    expect(bounded.current?.rendererHealth?.derivation).toMatchObject({
      rendererUpdatedAt: NOW_MS + 10_000,
      sceneCycleId: null,
      rendererPhase: null,
      rendererDegradedReason: null,
      externalSnapshotUpdatedAt: null,
    });
    expect(
      Object.keys(bounded.current?.rendererHealth?.derivation ?? {}),
    ).toHaveLength(17);
    expect(JSON.stringify(bounded)).not.toContain("NOT_PUBLIC");
    expect(JSON.stringify(bounded).length).toBeLessThan(8_192);
    Object.assign(state.cycle.rendererHealth, {
      derivation: { schemaVersion: 2 },
    });
    expect(
      buildStreamReadinessDiagnostics(input).current?.rendererHealth
        ?.derivation,
    ).toBeNull();
  });

  test("keeps delayed stream telemetry visible inside the synchronization budget", () => {
    const state = deriveSpectatorPresentationState({
      state: makeState(),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });

    expect(state.hasFreshCycle).toBe(true);
    expect(state.hasMatchup).toBe(true);
    expect(state.activityLabel).toBe("LIVE");
  });

  test("evaluates delayed spectator authority at the HLS program date instead of wall time", () => {
    const delayedResolution = makeState({
      emittedAt: NOW_MS - 30_000,
      cycle: {
        ...makeState().cycle,
        phase: "RESOLUTION",
        winnerId: "astra",
        winnerName: "Astra",
        winReason: "kill",
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: NOW_MS - 30_100,
        },
      },
    });

    const wallClockAuthority = deriveSpectatorPresentationState({
      state: delayedResolution,
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 4_000,
    });
    const playbackAuthority = deriveSpectatorPresentationState({
      state: delayedResolution,
      streamConnected: true,
      nowMs: NOW_MS - 29_900,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 4_000,
    });

    expect(wallClockAuthority).toMatchObject({
      hasFreshCycle: false,
      hasMatchup: false,
      activityLabel: "RECONNECTING",
    });
    expect(playbackAuthority).toMatchObject({
      rendererReady: true,
      hasFreshCycle: true,
      hasMatchup: true,
      activityLabel: "CONNECTED",
    });
  });

  test("does not depend on a newer market lifecycle during rollover", () => {
    const state = deriveSpectatorPresentationState({
      state: makeState({
        cycle: {
          ...makeState().cycle,
          phase: "RESOLUTION",
          winnerId: "boros",
          winnerName: "Boros",
          winReason: "hp_advantage",
        },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });

    expect(state.hasMatchup).toBe(true);
    expect(state.activityLabel).toBe("CONNECTED");
  });

  test("rejects stale, synthetic, or identity-free cycles", () => {
    const stale = deriveSpectatorPresentationState({
      state: makeState({ emittedAt: NOW_MS - 23_001 }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });
    const synthetic = deriveSpectatorPresentationState({
      state: makeState({
        cycle: { ...makeState().cycle, cycleId: "cycle-0" },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });
    const identityFree = deriveSpectatorPresentationState({
      state: makeState({
        cycle: { ...makeState().cycle, duelKeyHex: null },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });

    expect(stale.activityLabel).toBe("RECONNECTING");
    expect(stale.hasMatchup).toBe(false);
    expect(synthetic.hasFreshCycle).toBe(false);
    expect(identityFree.hasFreshCycle).toBe(true);
    expect(identityFree.hasMatchup).toBe(false);
  });

  test("fails closed when renderer or camera authority is missing, degraded, or stale", () => {
    const missing = deriveSpectatorPresentationState({
      state: makeState({
        cycle: { ...makeState().cycle, rendererHealth: null },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });
    const degraded = deriveSpectatorPresentationState({
      state: makeState({
        cycle: {
          ...makeState().cycle,
          rendererHealth: {
            ready: false,
            degradedReason: "camera_target_unresolved",
            updatedAt: NOW_MS,
          },
        },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });
    const stale = deriveSpectatorPresentationState({
      state: makeState({
        cycle: {
          ...makeState().cycle,
          rendererHealth: {
            ready: true,
            degradedReason: null,
            updatedAt: NOW_MS - 23_001,
          },
        },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });

    expect(missing).toMatchObject({
      hasFreshCycle: false,
      hasMatchup: false,
      activityLabel: "RECONNECTING",
    });
    expect(degraded).toMatchObject({
      hasFreshCycle: false,
      hasMatchup: false,
      activityLabel: "RECONNECTING",
    });
    expect(stale).toMatchObject({
      hasFreshCycle: false,
      hasMatchup: false,
      activityLabel: "RECONNECTING",
    });
  });

  test("does not describe a healthy synthetic waiting cycle as reconnecting", () => {
    const state = deriveSpectatorPresentationState({
      state: makeState({
        cycle: { ...makeState().cycle, cycleId: "cycle-0" },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });

    expect(state).toMatchObject({
      hasFreshCycle: false,
      hasMatchup: false,
      activityLabel: "UNAVAILABLE",
    });
  });

  test("accepts exact IDLE preparation authority and does not replace it with the prior result", () => {
    const current = makeState({
      preparation: {
        schemaVersion: 2,
        status: "preparing",
        selectedAt: NOW_MS - 10_000,
        expiresAt: NOW_MS + 50_000,
        agent1: {
          id: "astra",
          ready: false,
          activity: "gathering",
          mode: "traveling",
          activityTrail: ["planning", "gathering"],
        },
        agent2: {
          id: "boros",
          ready: false,
          activity: "training",
          mode: "working",
          activityTrail: ["training"],
        },
      },
      cycle: {
        ...makeState().cycle,
        cycleId: "cycle-0",
        phase: "IDLE",
        duelId: null,
        duelKeyHex: null,
      },
    });
    const presentation = deriveSpectatorPresentationState({
      state: current,
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });
    const priorResult = makeState({
      cycle: { ...makeState().cycle, phase: "RESOLUTION" },
    });

    expect(presentation).toMatchObject({
      hasFreshCycle: true,
      hasMatchup: false,
      hasPreparation: true,
      activityLabel: "CONNECTED",
    });
    expect(selectSpectatorPresentationUpdate(current, priorResult, true)).toBe(
      current,
    );
  });

  test("accepts preparation authority before the scheduler assigns a cycle ID", () => {
    const presentation = deriveSpectatorPresentationState({
      state: makeState({
        preparation: {
          schemaVersion: 2,
          status: "ready",
          selectedAt: NOW_MS - 10_000,
          expiresAt: NOW_MS + 50_000,
          agent1: {
            id: "astra",
            ready: true,
            activity: "gathering",
            mode: "working",
            activityTrail: ["planning", "gathering"],
          },
          agent2: {
            id: "boros",
            ready: true,
            activity: "training",
            mode: "working",
            activityTrail: ["training"],
          },
        },
        cycle: {
          ...makeState().cycle,
          cycleId: "",
          phase: "IDLE",
          duelId: null,
          duelKeyHex: null,
        },
      }),
      streamConnected: true,
      nowMs: NOW_MS,
      streamMaxAgeMs: 15_000,
      uiSyncDelayMs: 8_000,
    });

    expect(presentation).toMatchObject({
      hasFreshCycle: true,
      hasMatchup: false,
      hasPreparation: true,
      activityLabel: "CONNECTED",
    });
  });

  test("never presents a retained market phase as live stream authority", () => {
    expect(selectSpectatorDisplayPhase("FIGHTING", false)).toBe("UNAVAILABLE");
    expect(selectSpectatorDisplayPhase("LOCKED", false)).toBe("UNAVAILABLE");
    expect(selectSpectatorDisplayPhase("FIGHTING", true)).toBe("FIGHTING");
    expect(selectSpectatorDisplayPhase(null, true)).toBe("UNAVAILABLE");
  });

  test("does not describe stale combat telemetry as live during recovery", () => {
    expect(
      getSpectatorStatusCopy({
        phase: "FIGHTING",
        winnerName: null,
        hasFreshCycle: false,
        activityLabel: "RECONNECTING",
      }),
    ).toBe("Reconnecting to verified live arena telemetry.");
    expect(
      getSpectatorStatusCopy({
        phase: "FIGHTING",
        winnerName: null,
        hasFreshCycle: true,
        activityLabel: "LIVE",
      }),
    ).toBe("Round in progress — live combat telemetry is updating.");
  });

  test("distinguishes winner, draw, and cancellation without exposing raw reasons", () => {
    expect(
      classifySpectatorTerminalOutcome({
        phase: "RESOLUTION",
        winnerName: "Astra",
        winReason: "kill",
        cancellationReason: null,
      }),
    ).toBe("winner");
    expect(
      classifySpectatorTerminalOutcome({
        phase: "RESOLUTION",
        winnerName: null,
        winReason: "draw",
        cancellationReason: "draw",
      }),
    ).toBe("draw");
    expect(
      classifySpectatorTerminalOutcome({
        phase: "RESOLUTION",
        winnerName: null,
        winReason: null,
        cancellationReason: "competitive_snapshot_recovery_window_elapsed",
      }),
    ).toBe("cancelled");
    expect(
      classifySpectatorTerminalOutcome({
        phase: "RESOLUTION",
        winnerName: "Astra",
        winReason: "draw",
        cancellationReason: "draw",
      }),
    ).toBe("unknown");
    expect(
      classifySpectatorTerminalOutcome({
        phase: "FIGHTING",
        winnerName: null,
        winReason: null,
        cancellationReason: null,
      }),
    ).toBe(null);

    expect(
      getSpectatorStatusCopy({
        phase: "RESOLUTION",
        winnerName: null,
        winReason: "draw",
        cancellationReason: "draw",
        hasFreshCycle: true,
        activityLabel: "CONNECTED",
      }),
    ).toBe("The round ended in a draw. No winner was declared.");
    expect(
      getSpectatorStatusCopy({
        phase: "RESOLUTION",
        winnerName: null,
        winReason: null,
        cancellationReason: "competitive_snapshot_recovery_window_elapsed",
        hasFreshCycle: true,
        activityLabel: "CONNECTED",
      }),
    ).toBe("The round was cancelled. No winner was declared.");
  });

  test("keeps terminal market hydration copy outcome-specific", () => {
    expect(getSpectatorTerminalMarketFallbackCopy("winner")).toEqual({
      heading: "Settlement status updating",
      detail: "Verifying the on-chain result and settlement state.",
    });
    expect(getSpectatorTerminalMarketFallbackCopy("draw")).toEqual({
      heading: "Refund status updating",
      detail: "Verifying the on-chain refund and account state.",
    });
    expect(getSpectatorTerminalMarketFallbackCopy("cancelled")).toEqual({
      heading: "Refund status updating",
      detail: "Verifying the on-chain refund and account state.",
    });
    expect(getSpectatorTerminalMarketFallbackCopy("unknown")).toEqual({
      heading: "Result status updating",
      detail: "Verifying the on-chain result before showing account actions.",
    });
    expect(getSpectatorTerminalMarketFallbackCopy(null)).toBeNull();
  });

  test("uses one phase-correct matchup heading across the spectator rail", () => {
    expect(
      getSpectatorMatchupHeading({
        phase: "ANNOUNCEMENT",
        hasMatchup: true,
        hasLiveAuthority: true,
      }),
    ).toBe("Upcoming Match");
    expect(
      getSpectatorMatchupHeading({
        phase: "COUNTDOWN",
        hasMatchup: true,
        hasLiveAuthority: true,
      }),
    ).toBe("Fight Starting");
    expect(
      getSpectatorMatchupHeading({
        phase: "FIGHTING",
        hasMatchup: true,
        hasLiveAuthority: true,
      }),
    ).toBe("Current Match");
    expect(
      getSpectatorMatchupHeading({
        phase: "RESOLUTION",
        hasMatchup: true,
        hasLiveAuthority: true,
      }),
    ).toBe("Match Result");
    expect(
      getSpectatorMatchupHeading({
        phase: "IDLE",
        hasMatchup: false,
        hasLiveAuthority: true,
      }),
    ).toBe("Between rounds");
    expect(
      getSpectatorMatchupHeading({
        phase: null,
        hasMatchup: false,
        hasLiveAuthority: false,
      }),
    ).toBe("Waiting for stream");
  });

  test("explains every incomplete public-stream authority state", () => {
    expect(
      getStreamRecoveryHeading({
        playbackReady: false,
        telemetryConnected: false,
        rendererReady: false,
        hasStreamState: false,
        presentationReady: false,
      }),
    ).toBe("Connecting to the live arena");
    expect(
      getStreamRecoveryHeading({
        playbackReady: true,
        telemetryConnected: false,
        rendererReady: true,
        hasStreamState: true,
        presentationReady: false,
      }),
    ).toBe("Live match data temporarily unavailable");
    expect(
      getStreamRecoveryHeading({
        playbackReady: true,
        telemetryConnected: true,
        rendererReady: false,
        hasStreamState: true,
        presentationReady: false,
      }),
    ).toBe("Live arena view temporarily unavailable");
    expect(
      getStreamRecoveryHeading({
        playbackReady: true,
        telemetryConnected: true,
        rendererReady: true,
        hasStreamState: true,
        presentationReady: false,
      }),
    ).toBe("Live match data temporarily unavailable");
    expect(
      getStreamRecoveryHeading({
        playbackReady: true,
        telemetryConnected: true,
        rendererReady: true,
        hasStreamState: true,
        presentationReady: true,
      }),
    ).toBe(null);
  });

  test("only blocks the arena view when playback or renderer authority is unavailable", () => {
    expect(
      getStreamRecoveryMode({
        playbackReady: false,
        telemetryConnected: false,
        rendererReady: false,
        hasStreamState: false,
        presentationReady: false,
      }),
    ).toBe("blocking");
    expect(
      getStreamRecoveryMode({
        playbackReady: true,
        telemetryConnected: true,
        rendererReady: false,
        hasStreamState: true,
        presentationReady: false,
      }),
    ).toBe("blocking");
    expect(
      getStreamRecoveryMode({
        playbackReady: true,
        telemetryConnected: false,
        rendererReady: true,
        hasStreamState: true,
        presentationReady: false,
      }),
    ).toBe("advisory");
    expect(
      getStreamRecoveryMode({
        playbackReady: true,
        telemetryConnected: true,
        rendererReady: true,
        hasStreamState: true,
        presentationReady: true,
      }),
    ).toBe("hidden");
  });

  test("explains advisory and blocking recovery without implying betting is available", () => {
    expect(getStreamRecoveryDetail("advisory")).toContain(
      "market actions remain paused",
    );
    expect(getStreamRecoveryDetail("blocking")).toContain("stay unavailable");
  });

  test("holds the completed matchup across the short between-round idle frame", () => {
    const completed = makeState({
      cycle: {
        ...makeState().cycle,
        phase: "RESOLUTION",
        winnerId: "astra",
        winnerName: "Astra",
        winReason: "kill",
      },
    });
    const idle = makeState({
      seq: 43,
      cycle: {
        ...makeState().cycle,
        cycleId: "cycle-0",
        phase: "IDLE",
        agent1: null,
        agent2: null,
        duelId: null,
        duelKeyHex: null,
      },
    });

    expect(selectSpectatorPresentationUpdate(idle, completed, true)).toBe(
      completed,
    );
    expect(selectSpectatorPresentationUpdate(idle, completed, false)).toBe(
      idle,
    );
  });

  test("never bridges an idle frame with a missed nonterminal phase", () => {
    const fighting = makeState();
    const idle = makeState({
      seq: 43,
      cycle: {
        ...makeState().cycle,
        cycleId: "cycle-0",
        phase: "IDLE",
        agent1: null,
        agent2: null,
        duelId: null,
        duelKeyHex: null,
      },
    });

    expect(selectSpectatorPresentationUpdate(idle, fighting, true)).toBe(idle);
  });
});
