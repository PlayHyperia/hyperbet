import "./setup";

import { act, useState } from "react";
import { afterEach, describe, expect, it } from "bun:test";

import {
  getStreamingReconnectDelayMs,
  isStreamingRendererHealthReady,
  selectStreamingStateForPlayback,
  useStreamingState,
} from "../src/spectator/useStreamingState";
import type { StreamingStateUpdate } from "../src/spectator/types";
import { render } from "./render";

type StreamingHookResult = ReturnType<typeof useStreamingState>;

const originalFetch = globalThis.fetch;
function createFetchMock(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
}

const originalEventSource = window.EventSource;
let latestResult: StreamingHookResult | null = null;
let setPlaybackDate: ((value: number) => void) | null = null;
let setConnectionOptions:
  ((value: { apiUrl: string; disabled: boolean }) => void) | null = null;

function makeState(seq: number): StreamingStateUpdate {
  return {
    type: "STREAMING_STATE_UPDATE",
    seq,
    emittedAt: Date.now(),
    cameraTarget: "agent-a",
    leaderboard: [],
    cycle: {
      cycleId: "cycle-a",
      phase: "FIGHTING",
      cycleStartTime: Date.now() - 10_000,
      phaseStartTime: Date.now() - 5_000,
      phaseEndTime: Date.now() + 60_000,
      timeRemaining: 60_000,
      agent1: null,
      agent2: null,
      duelId: "duel-a",
      duelKeyHex: "ab".repeat(32),
      countdown: null,
      winnerId: null,
      winnerName: null,
      winReason: null,
      rendererHealth: {
        ready: true,
        degradedReason: null,
        updatedAt: Date.now(),
      },
    },
  };
}

function authorityFrame(
  seq: number,
  emittedAt: number,
  ready = true,
  healthUpdatedAt = emittedAt,
): StreamingStateUpdate {
  const state = makeState(seq);
  return {
    ...state,
    preparation: null,
    emittedAt,
    cycle: {
      ...state.cycle,
      rendererHealth: {
        ready,
        degradedReason: ready ? null : "capture_process_exited",
        updatedAt: healthUpdatedAt,
      },
    },
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<
    string,
    Array<(event: MessageEvent<string>) => void>
  >();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, state: StreamingStateUpdate, eventId: number) {
    const event = new MessageEvent<string>(type, {
      data: JSON.stringify(state),
      lastEventId: String(eventId),
    });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail() {
    this.onerror?.();
  }

  close() {
    this.closed = true;
  }
}

function Probe() {
  latestResult = useStreamingState({
    apiUrl: "http://127.0.0.1:5555",
    uiSyncDelayMs: 25,
    fallbackPollIntervalMs: 1_000,
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 5,
    reconnectJitterRatio: 0,
    sseFrameTimeoutMs: 500,
  });
  return null;
}

function PlaybackSynchronizedProbe() {
  const [playbackDateMs, setDate] = useState(500);
  setPlaybackDate = setDate;
  latestResult = useStreamingState({
    apiUrl: "http://127.0.0.1:5555",
    uiSyncDelayMs: 10_000,
    presentationTimeMs: playbackDateMs,
    playbackPresentationLagMs: 0,
    fallbackPollIntervalMs: 1_000,
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 5,
    reconnectJitterRatio: 0,
    sseFrameTimeoutMs: 500,
  });
  return null;
}

function ConnectionOptionsProbe() {
  const [options, setOptions] = useState({
    apiUrl: "http://127.0.0.1:5555",
    disabled: false,
  });
  setConnectionOptions = setOptions;
  latestResult = useStreamingState({
    ...options,
    uiSyncDelayMs: 25,
    fallbackPollIntervalMs: 1_000,
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 5,
    reconnectJitterRatio: 0,
    sseFrameTimeoutMs: 500,
  });
  return null;
}

async function waitMs(durationMs: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.EventSource = originalEventSource;
  FakeEventSource.instances = [];
  latestResult = null;
  setPlaybackDate = null;
  setConnectionOptions = null;
});

describe("streaming state recovery", () => {
  for (const malformed of [
    "absent",
    "null",
    "missing-timestamp",
    "nan-timestamp",
    "future-timestamp",
    "fractional-timestamp",
    "positive-missing-timestamp",
    "positive-nan-timestamp",
    "positive-future-timestamp",
    "positive-fractional-timestamp",
    "contradictory-ready",
    "missing-reason",
    "invalid-ready",
  ] as const) {
    it(`retains canonical health freshness through ${malformed} current authority`, () => {
      window.EventSource =
        FakeEventSource as unknown as typeof window.EventSource;
      const rendered = render(<Probe />);
      const source = FakeEventSource.instances[0]!;
      const at = Date.now() - 1_000;
      act(() => source.emit("state", authorityFrame(20, at), 20));
      const next = authorityFrame(21, at + 10, false);
      const healthCases: Record<typeof malformed, unknown> = {
        absent: undefined,
        null: null,
        "missing-timestamp": {
          ready: false,
          degradedReason: "capture_process_exited",
        },
        "nan-timestamp": {
          ready: false,
          degradedReason: "capture_process_exited",
          updatedAt: NaN,
        },
        "future-timestamp": {
          ready: false,
          degradedReason: "capture_process_exited",
          updatedAt: Date.now() + 60_000,
        },
        "fractional-timestamp": {
          ready: false,
          degradedReason: "capture_process_exited",
          updatedAt: 0.5,
        },
        "positive-missing-timestamp": { ready: true, degradedReason: null },
        "positive-nan-timestamp": {
          ready: true,
          degradedReason: null,
          updatedAt: NaN,
        },
        "positive-future-timestamp": {
          ready: true,
          degradedReason: null,
          updatedAt: Date.now() + 60_000,
        },
        "positive-fractional-timestamp": {
          ready: true,
          degradedReason: null,
          updatedAt: 0.5,
        },
        "contradictory-ready": {
          ready: true,
          degradedReason: "capture_process_exited",
          updatedAt: at + 1,
        },
        "missing-reason": { ready: true, updatedAt: at + 1 },
        "invalid-ready": {
          ready: "false",
          degradedReason: "capture_process_exited",
          updatedAt: at + 1,
        },
      };
      next.cycle.rendererHealth = healthCases[
        malformed
      ] as typeof next.cycle.rendererHealth;
      act(() => source.emit("state", next, 21));
      expect(latestResult?.currentState?.seq).toBe(21);
      expect(latestResult?.isRendererReady).toBe(false);
      act(() =>
        source.emit("state", authorityFrame(22, at + 20, true, at - 1), 22),
      );
      expect(latestResult?.currentState?.seq).toBe(21);
      expect(latestResult?.isRendererReady).toBe(false);
      const floor = [
        "contradictory-ready",
        "missing-reason",
        "invalid-ready",
      ].includes(malformed)
        ? at + 1
        : at;
      act(() =>
        source.emit("state", authorityFrame(23, at + 30, true, floor), 23),
      );
      expect(latestResult?.isRendererReady).toBe(false);
      act(() =>
        source.emit("state", authorityFrame(24, at + 40, true, floor + 1), 24),
      );
      expect(latestResult?.isRendererReady).toBe(true);
      rendered.unmount();
    });
  }

  it("retains the last canonical health floor through malformed authority and a restarted source epoch", async () => {
    globalThis.fetch = createFetchMock(
      async () => new Response("unavailable", { status: 503 }),
    );
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    act(() => source.emit("state", authorityFrame(100, at), 100));
    const malformed = authorityFrame(101, at + 10, false);
    malformed.cycle.rendererHealth = null;
    act(() => source.emit("state", malformed, 101));
    act(() => source.fail());
    await waitMs(20);
    const replacement = FakeEventSource.instances.at(-1)!;
    act(() =>
      replacement.emit("reset", authorityFrame(1, at + 20, true, at - 1), 1),
    );
    expect(latestResult?.currentState?.seq).toBe(101);
    expect(latestResult?.isRendererReady).toBe(false);
    act(() =>
      replacement.emit("reset", authorityFrame(1, at + 20, true, at), 1),
    );
    expect(latestResult?.isRendererReady).toBe(false);
    act(() =>
      replacement.emit("state", authorityFrame(2, at + 30, true, at + 1), 2),
    );
    expect(latestResult?.currentState?.seq).toBe(2);
    expect(latestResult?.isRendererReady).toBe(true);
    rendered.unmount();
  });

  it("revokes on a newer same-duel timeline without granting replay wagering authority", () => {
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<PlaybackSynchronizedProbe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    const current = authorityFrame(10, at);
    const negative = authorityFrame(11, at + 1, false);
    negative.cycle.phase = "RESOLUTION";
    act(() => source.emit("state", current, 10));
    expect(latestResult?.isRendererReady).toBe(true);
    act(() => {
      source.emit("timeline", negative, 11);
      setPlaybackDate?.(at + 1);
    });
    expect(latestResult?.isRendererReady).toBe(false);
    expect(latestResult?.isCurrentConnected).toBe(true);
    expect(latestResult?.currentState).toEqual(current);
    expect(latestResult?.currentState?.cycle.phase).toBe("FIGHTING");
    expect(latestResult?.state?.cycle.phase).toBe("RESOLUTION");

    act(() => source.emit("timeline", authorityFrame(12, at + 2), 12));
    expect(latestResult?.isRendererReady).toBe(false);
    expect(latestResult?.currentState).toEqual(current);
    // Duplicate/reset frames and a new cursor with old health cannot clear it.
    act(() => source.emit("state", current, 10));
    act(() => source.emit("reset", authorityFrame(11, at + 1), 11));
    expect(latestResult?.isRendererReady).toBe(false);
    act(() =>
      source.emit("state", authorityFrame(13, at + 3, true, at + 1), 13),
    );
    expect(latestResult?.isRendererReady).toBe(false);
    act(() => source.emit("state", authorityFrame(14, at + 4), 14));
    expect(latestResult?.isRendererReady).toBe(true);
    rendered.unmount();
  });

  it("ignores old, cross-duel, partial-identity and regressed-health timeline negatives", () => {
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    const current = authorityFrame(20, at);
    act(() => source.emit("state", current, 20));
    const candidates = [
      authorityFrame(19, at - 1, false),
      authorityFrame(21, at - 1, false),
      authorityFrame(19, at + 1, false),
      authorityFrame(21, at + 1, false, at - 1),
      ...[
        { cycleId: "old-cycle" },
        { duelId: "other-duel" },
        { duelKeyHex: "cd".repeat(32) },
        { duelId: null },
        { duelKeyHex: null },
      ].map((identity) => {
        const next = authorityFrame(21, at + 1, false);
        return { ...next, cycle: { ...next.cycle, ...identity } };
      }),
    ];
    for (const next of candidates) {
      act(() => source.emit("timeline", next, next.seq!));
      expect(latestResult?.isRendererReady).toBe(true);
      expect(latestResult?.currentState).toEqual(current);
    }
    rendered.unmount();
  });

  it("requires canonical safe integer state and negative health timestamps", () => {
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    const current = authorityFrame(20, at);
    act(() => source.emit("state", current, 20));
    for (const invalid of [
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      undefined,
    ]) {
      for (const field of ["seq", "emittedAt"] as const) {
        const candidate = {
          ...authorityFrame(21, at + 1, false),
          [field]: invalid,
        };
        act(() => source.emit("timeline", candidate, 21));
        expect(latestResult?.isRendererReady).toBe(true);
        act(() => source.emit("state", candidate, 21));
        expect(latestResult?.currentState).toEqual(current);
      }
    }
    for (const updatedAt of [
      0,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Date.now() + 60_000,
    ]) {
      act(() =>
        source.emit(
          "timeline",
          authorityFrame(21, at + 1, false, updatedAt),
          21,
        ),
      );
      expect(latestResult?.isRendererReady).toBe(true);
      expect(
        isStreamingRendererHealthReady({
          ready: true,
          degradedReason: null,
          updatedAt,
        }),
      ).toBe(false);
    }
    act(() =>
      source.emit("state", authorityFrame(22, Date.now() + 60_000), 22),
    );
    expect(latestResult?.currentState).toEqual(current);
    act(() =>
      source.emit(
        "timeline",
        authorityFrame(22, Date.now() + 60_000, false),
        22,
      ),
    );
    expect(latestResult?.isRendererReady).toBe(true);
    rendered.unmount();
  });

  it("never rolls current authority backward and resets a cursor only after disconnect", async () => {
    globalThis.fetch = createFetchMock(
      async () => new Response("unavailable", { status: 503 }),
    );
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    const current = authorityFrame(100, at);
    act(() => source.emit("state", current, 100));
    const conflicting = {
      ...current,
      cycle: {
        ...current.cycle,
        phase: "RESOLUTION" as const,
        rendererHealth: {
          ready: false,
          degradedReason: "capture_process_exited",
          updatedAt: at + 1,
        },
      },
    };
    act(() => source.emit("state", conflicting, 100));
    act(() => source.emit("reset", conflicting, 100));
    expect(latestResult?.currentState).toEqual(current);
    expect(latestResult?.isRendererReady).toBe(true);
    for (const event of ["state", "reset"]) {
      for (const next of [
        authorityFrame(99, at + 1),
        authorityFrame(101, at - 1),
      ]) {
        act(() => source.emit(event, next, next.seq!));
        expect(latestResult?.currentState).toEqual(current);
      }
    }
    act(() => source.fail());
    await waitMs(20);
    const replacement = FakeEventSource.instances.at(-1)!;
    act(() => replacement.emit("reset", authorityFrame(1, at), 1));
    expect(latestResult?.isCurrentConnected).toBe(false);
    expect(latestResult?.currentState).toEqual(current);
    act(() => replacement.emit("reset", authorityFrame(1, at + 1), 1));
    expect(latestResult?.isRendererReady).toBe(true);
    expect(latestResult?.currentState?.seq).toBe(1);
    act(() => replacement.emit("state", authorityFrame(200, at), 200));
    expect(latestResult?.currentState?.seq).toBe(1);
    act(() => replacement.fail());
    await waitMs(20);
    expect(FakeEventSource.instances.at(-1)?.url).toContain("since=1");
    rendered.unmount();
  });

  it("preserves the negative watermark across unavailable, reset and producer epochs", async () => {
    globalThis.fetch = createFetchMock(
      async () => new Response("unavailable", { status: 503 }),
    );
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    act(() => source.emit("state", authorityFrame(100, at), 100));
    act(() => source.emit("timeline", authorityFrame(101, at + 1, false), 101));
    act(() => source.fail());
    await waitMs(20);
    const replacement = FakeEventSource.instances.at(-1)!;
    // Replayed negative old-producer sequence must not pin the new epoch's
    // sequence floor before its first authoritative reset arrives.
    act(() =>
      replacement.emit("timeline", authorityFrame(101, at + 1, false), 101),
    );
    act(() => replacement.emit("reset", authorityFrame(1, at + 1), 1));
    expect(latestResult?.isRendererReady).toBe(false);
    act(() => replacement.emit("timeline", authorityFrame(2, at + 2), 2));
    expect(latestResult?.isRendererReady).toBe(false);
    act(() =>
      replacement.emit("reset", authorityFrame(3, at + 3, true, at + 1), 3),
    );
    expect(latestResult?.isRendererReady).toBe(false);
    act(() => replacement.emit("state", authorityFrame(4, at + 4), 4));
    expect(latestResult?.isRendererReady).toBe(true);
    // A negative in the new epoch is not blocked by the prior high sequence.
    act(() =>
      replacement.emit("timeline", authorityFrame(5, at + 5, false), 5),
    );
    expect(latestResult?.isRendererReady).toBe(false);
    act(() => replacement.emit("state", authorityFrame(6, at + 6), 6));
    expect(latestResult?.isRendererReady).toBe(true);
    rendered.unmount();
  });

  it("rejects an in-flight REST response overtaken by timeline revocation", async () => {
    let resolvePoll!: (response: Response) => void;
    globalThis.fetch = createFetchMock(
      () =>
        new Promise<Response>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    act(() => source.emit("state", authorityFrame(10, at), 10));
    act(() => source.emit("unavailable", authorityFrame(10, at), 10));
    act(() => source.emit("state", authorityFrame(11, at + 1), 11));
    act(() => source.emit("timeline", authorityFrame(12, at + 2, false), 12));
    await act(async () => {
      resolvePoll(Response.json(authorityFrame(11, at + 1)));
    });
    expect(latestResult?.isRendererReady).toBe(false);
    expect(latestResult?.currentState?.seq).toBe(11);
    act(() => source.emit("state", authorityFrame(13, at + 3), 13));
    expect(latestResult?.isRendererReady).toBe(true);
    rendered.unmount();
  });

  it("ignores completed polls and source callbacks from an obsolete connection or unmount", async () => {
    let resolvePoll!: (response: Response) => void;
    globalThis.fetch = createFetchMock(
      () =>
        new Promise<Response>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    act(() => source.emit("state", authorityFrame(10, at), 10));
    act(() => source.emit("unavailable", authorityFrame(10, at), 10));
    const obsoletePoll = resolvePoll;
    act(() => source.fail());
    await waitMs(20);
    const replacement = FakeEventSource.instances.at(-1)!;
    act(() => replacement.emit("reset", authorityFrame(1, at + 1), 1));
    await act(async () => {
      obsoletePoll(Response.json(authorityFrame(999, at + 100)));
    });
    expect(latestResult?.currentState?.seq).toBe(1);
    act(() => source.emit("state", authorityFrame(1_000, at + 101), 1_000));
    expect(latestResult?.currentState?.seq).toBe(1);
    act(() => replacement.emit("unavailable", authorityFrame(1, at + 1), 1));
    const afterUnmountPoll = resolvePoll;
    rendered.unmount();
    const before = latestResult;
    await act(async () => {
      afterUnmountPoll(Response.json(authorityFrame(2, at + 2)));
    });
    act(() => replacement.emit("state", authorityFrame(3, at + 3), 3));
    expect(latestResult).toBe(before);
  });

  for (const failure of ["transport", "http", "json"] as const) {
    it(`ignores a late ${failure} poll failure after newer same-connection SSE authority`, async () => {
      let resolvePoll!: (response: Response) => void;
      let rejectPoll!: (error: Error) => void;
      globalThis.fetch = createFetchMock(
        () =>
          new Promise<Response>((resolve, reject) => {
            resolvePoll = resolve;
            rejectPoll = reject;
          }),
      );
      window.EventSource =
        FakeEventSource as unknown as typeof window.EventSource;
      const rendered = render(<Probe />);
      const source = FakeEventSource.instances[0]!;
      const at = Date.now() - 1_000;
      act(() => source.emit("state", authorityFrame(10, at), 10));
      act(() => source.emit("unavailable", authorityFrame(10, at), 10));
      act(() => source.emit("reset", authorityFrame(11, at + 1), 11));
      await act(async () => {
        if (failure === "transport")
          rejectPoll(new Error("old request failed"));
        else
          resolvePoll(
            new Response(failure === "json" ? "not-json" : "unavailable", {
              status: failure === "http" ? 503 : 200,
            }),
          );
      });
      expect(latestResult?.currentState?.seq).toBe(11);
      expect(latestResult?.isCurrentConnected).toBe(true);
      expect(latestResult?.isRendererReady).toBe(true);
      rendered.unmount();
    });
  }

  for (const event of ["state", "reset", "poll"] as const) {
    it(`requires newer health after negative current ${event} authority`, async () => {
      const at = Date.now() - 1_000;
      globalThis.fetch = createFetchMock(async () =>
        Response.json(authorityFrame(11, at + 1, false)),
      );
      window.EventSource =
        FakeEventSource as unknown as typeof window.EventSource;
      const rendered = render(<Probe />);
      const source = FakeEventSource.instances[0]!;
      act(() => source.emit("state", authorityFrame(10, at), 10));
      if (event === "poll") {
        await act(async () =>
          source.emit("unavailable", authorityFrame(10, at), 10),
        );
      } else
        act(() => source.emit(event, authorityFrame(11, at + 1, false), 11));
      expect(latestResult?.isRendererReady).toBe(false);
      expect(latestResult?.currentState?.seq).toBe(11);
      act(() =>
        source.emit("state", authorityFrame(12, at + 2, true, at + 1), 12),
      );
      expect(latestResult?.isRendererReady).toBe(false);
      act(() => source.emit("state", authorityFrame(13, at + 3), 13));
      expect(latestResult?.isRendererReady).toBe(true);
      rendered.unmount();
    });
  }

  it("ignores prior-duel replay after current authority rolls to a new duel", () => {
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    act(() => source.emit("state", authorityFrame(10, at), 10));
    const nextDuel = authorityFrame(11, at + 1);
    nextDuel.cycle = {
      ...nextDuel.cycle,
      cycleId: "cycle-b",
      duelId: "duel-b",
      duelKeyHex: "cd".repeat(32),
    };
    act(() => source.emit("state", nextDuel, 11));
    act(() => source.emit("timeline", authorityFrame(12, at + 2, false), 12));
    expect(latestResult?.currentState).toEqual(nextDuel);
    expect(latestResult?.isRendererReady).toBe(true);
    rendered.unmount();
  });

  it("keeps missing optional duel identity presentation-only", () => {
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<PlaybackSynchronizedProbe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    const current = authorityFrame(10, at);
    delete current.cycle.duelId;
    delete current.cycle.duelKeyHex;
    act(() => source.emit("state", current, 10));
    const negative = authorityFrame(11, at + 1, false);
    delete negative.cycle.duelId;
    delete negative.cycle.duelKeyHex;
    act(() => {
      source.emit("timeline", negative, 11);
      setPlaybackDate?.(at + 1);
    });
    expect(latestResult?.isRendererReady).toBe(true);
    expect(latestResult?.currentState).toEqual(current);
    expect(latestResult?.state?.seq).toBe(11);
    rendered.unmount();
  });

  it("preserves revocation through source URL changes and disabled teardown while rejecting old callbacks", async () => {
    let resolvePoll!: (response: Response) => void;
    let rejectPoll!: (error: Error) => void;
    globalThis.fetch = createFetchMock(
      () =>
        new Promise<Response>((resolve, reject) => {
          resolvePoll = resolve;
          rejectPoll = reject;
        }),
    );
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;
    const rendered = render(<ConnectionOptionsProbe />);
    const source = FakeEventSource.instances[0]!;
    const at = Date.now() - 1_000;
    act(() => source.emit("state", authorityFrame(10, at), 10));
    act(() => source.emit("timeline", authorityFrame(11, at + 1, false), 11));
    act(() => source.emit("unavailable", authorityFrame(10, at), 10));
    const oldPoll = resolvePoll;
    act(() =>
      setConnectionOptions?.({
        apiUrl: "http://127.0.0.1:5556",
        disabled: false,
      }),
    );
    const replacement = FakeEventSource.instances.at(-1)!;
    expect(source.closed).toBe(true);
    expect(replacement.url).toContain("127.0.0.1:5556");
    await act(async () =>
      oldPoll(Response.json(authorityFrame(999, at + 100))),
    );
    act(() => source.emit("state", authorityFrame(999, at + 100), 999));
    act(() => replacement.emit("reset", authorityFrame(1, at + 1), 1));
    expect(latestResult?.isRendererReady).toBe(false);
    act(() => replacement.emit("state", authorityFrame(2, at + 2), 2));
    expect(latestResult?.isRendererReady).toBe(true);
    act(() => replacement.emit("unavailable", authorityFrame(2, at + 2), 2));
    const disabledPoll = rejectPoll;
    act(() =>
      setConnectionOptions?.({
        apiUrl: "http://127.0.0.1:5556",
        disabled: true,
      }),
    );
    expect(replacement.closed).toBe(true);
    act(() => replacement.emit("state", authorityFrame(999, at + 100), 999));
    expect(latestResult?.isCurrentConnected).toBe(false);
    expect(latestResult?.currentState?.seq).toBe(2);
    act(() =>
      setConnectionOptions?.({
        apiUrl: "http://127.0.0.1:5556",
        disabled: false,
      }),
    );
    act(() =>
      FakeEventSource.instances
        .at(-1)!
        .emit("reset", authorityFrame(3, at + 3), 3),
    );
    await act(async () => disabledPoll(new Error("obsolete disabled request")));
    expect(latestResult?.isRendererReady).toBe(true);
    expect(latestResult?.currentState?.seq).toBe(3);
    rendered.unmount();
  });

  it("selects the newest telemetry frame at the HLS program date", () => {
    const state1 = { ...makeState(1), emittedAt: 1_000 };
    const state2 = { ...makeState(2), emittedAt: 2_000 };
    const sameTimeNewerSeq = { ...makeState(3), emittedAt: 2_000 };
    const future = { ...makeState(4), emittedAt: 3_000 };

    expect(
      selectStreamingStateForPlayback(
        [future, state1, state2, sameTimeNewerSeq],
        2_100,
        0,
      )?.seq,
    ).toBe(3);
    expect(
      selectStreamingStateForPlayback([state1, state2], 2_250, 250)?.seq,
    ).toBe(2);
    expect(selectStreamingStateForPlayback([state1, state2], 2_200)?.seq).toBe(
      1,
    );
    expect(selectStreamingStateForPlayback([state1, state2], 2_250)?.seq).toBe(
      2,
    );
    expect(selectStreamingStateForPlayback([state1], 1_249, 250)).toBe(null);
    expect(selectStreamingStateForPlayback([state1], Number.NaN)).toBe(null);
  });

  it("holds future telemetry until playback reaches it and can follow a restarted timeline backward", async () => {
    globalThis.fetch = createFetchMock(async () => {
      throw new Error("offline");
    });
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;

    const rendered = render(<PlaybackSynchronizedProbe />);
    const source = FakeEventSource.instances[0];
    const state1 = { ...makeState(1), emittedAt: 1_000 };
    const state2 = { ...makeState(2), emittedAt: 2_000 };
    act(() => {
      source?.emit("state", state1, 1);
      source?.emit("state", state2, 2);
    });
    expect(latestResult?.state).toBe(null);
    expect(latestResult?.isConnected).toBe(false);
    expect(latestResult?.currentState?.seq).toBe(2);
    expect(latestResult?.isCurrentConnected).toBe(true);

    act(() => setPlaybackDate?.(1_100));
    expect(latestResult?.state?.seq).toBe(1);
    expect(latestResult?.isConnected).toBe(true);

    act(() => setPlaybackDate?.(2_100));
    expect(latestResult?.state?.seq).toBe(2);

    act(() => setPlaybackDate?.(1_100));
    expect(latestResult?.state?.seq).toBe(1);
    rendered.unmount();
  });

  it("uses timeline frames for presentation without restoring stale renderer authority", async () => {
    globalThis.fetch = createFetchMock(async () => {
      throw new Error("offline");
    });
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;

    const rendered = render(<PlaybackSynchronizedProbe />);
    const source = FakeEventSource.instances[0];
    const unavailable = {
      ...makeState(10),
      emittedAt: 2_000,
      cycle: {
        ...makeState(10).cycle,
        rendererHealth: {
          ready: false,
          degradedReason: "capture_starting",
          updatedAt: Date.now(),
        },
      },
    };
    const presentation = { ...makeState(11), emittedAt: 1_000 };

    act(() => {
      source?.emit("state", unavailable, 10);
      source?.emit("timeline", presentation, 11);
      setPlaybackDate?.(1_100);
    });

    expect(latestResult?.state?.seq).toBe(11);
    expect(latestResult?.isConnected).toBe(true);
    expect(latestResult?.currentState?.seq).toBe(10);
    expect(latestResult?.isCurrentConnected).toBe(true);
    expect(latestResult?.isRendererReady).toBe(false);
    rendered.unmount();
  });

  it("preserves the category-only preparation summary across SSE normalization", () => {
    globalThis.fetch = createFetchMock(async () => {
      throw new Error("offline");
    });
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;

    const rendered = render(<PlaybackSynchronizedProbe />);
    const source = FakeEventSource.instances[0];
    const preparation = {
      schemaVersion: 2,
      status: "preparing",
      selectedAt: 100,
      expiresAt: 10_000,
      agent1: {
        id: "agent-a",
        ready: false,
        activity: "gathering",
        mode: "working",
        activityTrail: ["planning", "gathering"],
      },
      agent2: {
        id: "agent-b",
        ready: false,
        activity: "training",
        mode: "traveling",
        activityTrail: ["training"],
      },
    };
    act(() => {
      source?.emit(
        "state",
        { ...makeState(12), emittedAt: 400, preparation },
        12,
      );
    });

    expect(latestResult?.state?.preparation).toEqual(preparation);
    rendered.unmount();
  });

  it("bounds exponential reconnect delay with symmetric jitter", () => {
    expect(getStreamingReconnectDelayMs(0, 1_000, 15_000, 0, 0)).toBe(1_000);
    expect(getStreamingReconnectDelayMs(4, 1_000, 15_000, 0, 1)).toBe(15_000);
    expect(getStreamingReconnectDelayMs(1, 1_000, 15_000, 0.2, 0)).toBe(1_600);
    expect(getStreamingReconnectDelayMs(1, 1_000, 15_000, 0.2, 1)).toBe(2_400);
  });

  it("accepts only fresh, explicitly healthy renderer authority", () => {
    expect(
      isStreamingRendererHealthReady(
        { ready: true, degradedReason: null, updatedAt: 9_500 },
        10_000,
        1_000,
      ),
    ).toBe(true);
    expect(
      isStreamingRendererHealthReady(
        {
          ready: false,
          degradedReason: "camera_target_unresolved",
          updatedAt: 10_000,
        },
        10_000,
        1_000,
      ),
    ).toBe(false);
    expect(
      isStreamingRendererHealthReady(
        { ready: true, degradedReason: null, updatedAt: 8_999 },
        10_000,
        1_000,
      ),
    ).toBe(false);
    expect(isStreamingRendererHealthReady(null, 10_000, 1_000)).toBe(false);
  });

  it("invalidates delayed stale telemetry and resumes SSE from the last event without a reload", async () => {
    globalThis.fetch = createFetchMock(async () => {
      throw new Error("offline");
    });
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;

    const rendered = render(<Probe />);
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => {
      FakeEventSource.instances[0]?.emit("state", makeState(7), 7);
      FakeEventSource.instances[0]?.fail();
    });
    await waitMs(40);

    expect(latestResult?.state).toBe(null);
    expect(latestResult?.isConnected).toBe(false);
    expect(latestResult?.isCurrentConnected).toBe(false);
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);

    const replacement = FakeEventSource.instances.at(-1);
    expect(replacement?.url).toContain("since=7");
    act(() => {
      replacement?.emit("state", makeState(8), 8);
    });
    await waitMs(35);

    expect(latestResult?.state?.seq).toBe(8);
    expect(latestResult?.isConnected).toBe(true);
    expect(latestResult?.currentState?.seq).toBe(8);
    expect(latestResult?.isCurrentConnected).toBe(true);
    expect(latestResult?.isRendererReady).toBe(true);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    rendered.unmount();
  });

  it("stays fail closed after an upstream-unavailable signal while cached polling is rejected", async () => {
    let pollAttempts = 0;
    globalThis.fetch = createFetchMock(async () => {
      pollAttempts += 1;
      return new Response(
        JSON.stringify({
          error: "Live stream authority is temporarily unavailable",
          retryable: true,
        }),
        { status: 503 },
      );
    });
    window.EventSource =
      FakeEventSource as unknown as typeof window.EventSource;

    const rendered = render(<Probe />);
    const source = FakeEventSource.instances[0];
    act(() => source?.emit("state", makeState(11), 11));
    await waitMs(35);
    expect(latestResult?.isConnected).toBe(true);

    act(() => source?.emit("unavailable", makeState(11), 11));
    await waitMs(35);

    expect(pollAttempts).toBeGreaterThan(0);
    expect(latestResult?.state?.seq).toBe(11);
    expect(latestResult?.isConnected).toBe(false);
    expect(latestResult?.isCurrentConnected).toBe(false);
    expect(latestResult?.isRendererReady).toBe(false);
    rendered.unmount();
  });
});
