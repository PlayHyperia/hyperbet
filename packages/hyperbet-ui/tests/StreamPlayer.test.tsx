import "./setup";

import { describe, expect, it, mock } from "bun:test";
import { act } from "react";

import {
  HLS_LIVE_ABR_POLICY,
  HLS_NETWORK_FAILURE_LIMIT,
  inspectHlsManifest,
  isHlsStreamUrl,
  isExpectedNonFatalHlsRecovery,
  resolveStreamPlaybackMode,
  resolveHlsBufferStallRecoveryState,
  shouldFailOverAfterHlsNetworkFailures,
  shouldMarkStreamUnavailable,
  StreamPlayer,
} from "../src/components/StreamPlayer";
import { render } from "./render";

describe("StreamPlayer lifecycle", () => {
  it("keeps responsive live recovery behind a measured bandwidth reserve", () => {
    expect(HLS_LIVE_ABR_POLICY).toEqual({
      abrEwmaSlowLive: 4,
      abrBandWidthUpFactor: 0.85,
    });
  });

  it("prefers hls.js over advertised native HLS support", () => {
    expect(resolveStreamPlaybackMode(true, "probably")).toBe("hls.js");
    expect(resolveStreamPlaybackMode(false, "maybe")).toBe("native");
    expect(resolveStreamPlaybackMode(false, "")).toBe("unsupported");
  });

  it("classifies hls.js self-healing buffer events separately from actionable HLS errors", () => {
    expect(isExpectedNonFatalHlsRecovery(false, "bufferSeekOverHole")).toBe(
      true,
    );
    expect(isExpectedNonFatalHlsRecovery(false, "bufferStalledError")).toBe(
      true,
    );
    expect(isExpectedNonFatalHlsRecovery(false, "bufferNudgeOnStall")).toBe(
      true,
    );
    expect(isExpectedNonFatalHlsRecovery(true, "bufferSeekOverHole")).toBe(
      false,
    );
    expect(isExpectedNonFatalHlsRecovery(false, "fragLoadError")).toBe(false);
  });

  it("escalates a buffer underrun only after bounded recovery fails", () => {
    expect(resolveHlsBufferStallRecoveryState(1_000, 12, 4_999, 12)).toBe(
      "pending",
    );
    expect(resolveHlsBufferStallRecoveryState(1_000, 12, 2_000, 12.05)).toBe(
      "recovered",
    );
    expect(resolveHlsBufferStallRecoveryState(1_000, 12, 5_000, 12)).toBe(
      "escalate",
    );
  });

  it("recognizes HLS URLs and applies a bounded failure threshold", () => {
    expect(isHlsStreamUrl("https://stream.test/live/arena.m3u8?token=x")).toBe(
      true,
    );
    expect(isHlsStreamUrl("https://stream.test/embed/arena")).toBe(false);
    expect(shouldMarkStreamUnavailable(2, 3)).toBe(false);
    expect(shouldMarkStreamUnavailable(3, 3)).toBe(true);
  });

  it("fails over after bounded consecutive HLS network failures", () => {
    expect(HLS_NETWORK_FAILURE_LIMIT).toBe(3);
    expect(shouldFailOverAfterHlsNetworkFailures(1)).toBe(false);
    expect(shouldFailOverAfterHlsNetworkFailures(2)).toBe(false);
    expect(shouldFailOverAfterHlsNetworkFailures(3)).toBe(true);
    expect(shouldFailOverAfterHlsNetworkFailures(Number.NaN)).toBe(false);
  });

  it("distinguishes live media playlists from valid adaptive masters", () => {
    expect(
      inspectHlsManifest(
        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n#EXT-X-PROGRAM-DATE-TIME:2026-08-25T12:00:00Z\nsegment?id=1\n",
      ),
    ).toEqual({ kind: "media", variantUris: [] });
    expect(
      inspectHlsManifest(
        [
          "#EXTM3U",
          "#EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=640x360",
          "360p/index.m3u8",
          "#EXT-X-STREAM-INF:BANDWIDTH=4700000,RESOLUTION=1280x720",
          "720p/index.m3u8?token=signed",
        ].join("\n"),
      ),
    ).toEqual({
      kind: "master",
      variantUris: ["360p/index.m3u8", "720p/index.m3u8?token=signed"],
    });
  });

  it("rejects malformed or non-playable HLS manifests", () => {
    expect(inspectHlsManifest("not a playlist").kind).toBe("invalid");
    expect(inspectHlsManifest("#EXTM3U\n#EXT-X-VERSION:6").kind).toBe(
      "invalid",
    );
    expect(
      inspectHlsManifest(
        "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=640x360\n360p.m3u8",
      ).kind,
    ).toBe("invalid");
    expect(
      inspectHlsManifest(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=950000\n#missing-uri",
      ).kind,
    ).toBe("invalid");
  });

  it("accepts an adaptive master only after a live child rendition responds", async () => {
    const originalFetch = globalThis.fetch;
    const originalCanPlayType = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "canPlayType",
    );
    const originalPlay = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "play",
    );
    const onStreamUnavailable = mock(() => {});
    const requestedUrls: string[] = [];
    globalThis.fetch = mock(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("360p/index.m3u8")) {
        return new Response("#EXTM3U\n#EXTINF:2,\nsegment-1.ts\n", {
          status: 200,
        });
      }
      return new Response(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=640x360\n360p/index.m3u8\n",
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: async () => undefined,
    });

    try {
      const rendered = render(
        <StreamPlayer
          streamUrl="https://video.example/live/master.m3u8"
          onStreamUnavailable={onStreamUnavailable}
          unavailableAfterManifestFailures={1}
        />,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(requestedUrls).toHaveLength(2);
      expect(requestedUrls[1]).toBe(
        "https://video.example/live/360p/index.m3u8",
      );
      expect(onStreamUnavailable).not.toHaveBeenCalled();
      rendered.unmount();
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, descriptor] of [
        ["canPlayType", originalCanPlayType],
        ["play", originalPlay],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(
            window.HTMLMediaElement.prototype,
            name,
            descriptor,
          );
        } else {
          delete (
            window.HTMLMediaElement.prototype as unknown as Record<
              string,
              unknown
            >
          )[name];
        }
      }
    }
  });

  it("does not attach a stale manifest probe after effect cleanup", async () => {
    const originalFetch = globalThis.fetch;
    const originalCanPlayType = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "canPlayType",
    );
    const originalPlay = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "play",
    );
    const originalWarn = console.warn;

    let resolveManifest!: (response: Response) => void;
    const manifestPromise = new Promise<Response>((resolve) => {
      resolveManifest = resolve;
    });
    const play = mock(async () => undefined);
    const warn = mock(() => {});
    const onStreamReady = mock(() => {});
    const onStreamUnavailable = mock(() => {});

    globalThis.fetch = mock(
      () => manifestPromise,
    ) as unknown as typeof globalThis.fetch;
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: play,
    });
    console.warn = warn;

    try {
      const rendered = render(
        <StreamPlayer
          streamUrl="http://127.0.0.1/live/stream.m3u8"
          onStreamReady={onStreamReady}
          onStreamUnavailable={onStreamUnavailable}
        />,
      );
      const video = rendered.container.querySelector("video");
      if (!video) throw new Error("StreamPlayer did not render a video");
      expect(video.dataset.streamSource).toBe(
        "http://127.0.0.1/live/stream.m3u8",
      );

      rendered.unmount();
      await act(async () => {
        resolveManifest(
          new Response("#EXTM3U\n#EXTINF:1,\nsegment-1.ts\n", {
            status: 200,
          }),
        );
        await manifestPromise;
        await Promise.resolve();
      });

      expect(video.getAttribute("src")).toBe(null);
      expect(play).not.toHaveBeenCalled();
      expect(onStreamReady).not.toHaveBeenCalled();
      expect(onStreamUnavailable).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      if (originalCanPlayType) {
        Object.defineProperty(
          window.HTMLMediaElement.prototype,
          "canPlayType",
          originalCanPlayType,
        );
      }
      if (originalPlay) {
        Object.defineProperty(
          window.HTMLMediaElement.prototype,
          "play",
          originalPlay,
        );
      }
    }
  });

  it("marks a persistently missing HLS manifest unavailable without repeated notifications", async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const onStreamUnavailable = mock(() => {});
    const warn = mock(() => {});
    globalThis.fetch = mock(
      async () => new Response("", { status: 503 }),
    ) as unknown as typeof fetch;
    console.warn = warn;

    try {
      const rendered = render(
        <StreamPlayer
          streamUrl="http://127.0.0.1/live/stream.m3u8"
          onStreamUnavailable={onStreamUnavailable}
          unavailableAfterManifestFailures={1}
          manifestRetryDelayMs={5}
        />,
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
      });

      expect(onStreamUnavailable).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
      rendered.unmount();
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });

  it("does not report ready until media time actually advances", async () => {
    const originalFetch = globalThis.fetch;
    const originalCanPlayType = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "canPlayType",
    );
    const originalPlay = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "play",
    );
    const originalGetStartDate = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "getStartDate",
    );
    const onStreamReady = mock(() => {});
    const onPlaybackDateChange = mock(() => {});
    globalThis.fetch = mock(
      async () =>
        new Response("#EXTM3U\n#EXTINF:1,\nsegment-1.ts\n", { status: 200 }),
    ) as unknown as typeof fetch;
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: async () => undefined,
    });
    Object.defineProperty(window.HTMLMediaElement.prototype, "getStartDate", {
      configurable: true,
      value: () => new Date(1_800_000_000_000),
    });

    try {
      const rendered = render(
        <StreamPlayer
          streamUrl="http://127.0.0.1/live/stream.m3u8"
          onStreamReady={onStreamReady}
          onPlaybackDateChange={onPlaybackDateChange}
        />,
      );
      const video = rendered.container.querySelector("video");
      if (!video) throw new Error("StreamPlayer did not render a video");
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => video.dispatchEvent(new Event("loadedmetadata")));
      expect(onStreamReady).not.toHaveBeenCalled();

      video.currentTime = 0.25;
      act(() => video.dispatchEvent(new Event("timeupdate")));
      expect(onStreamReady).toHaveBeenCalledTimes(1);
      expect(onPlaybackDateChange).toHaveBeenCalledWith(1_800_000_000_250);
      rendered.unmount();
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, descriptor] of [
        ["canPlayType", originalCanPlayType],
        ["play", originalPlay],
        ["getStartDate", originalGetStartDate],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(
            window.HTMLMediaElement.prototype,
            name,
            descriptor,
          );
        } else {
          delete (
            window.HTMLMediaElement.prototype as unknown as Record<
              string,
              unknown
            >
          )[name];
        }
      }
    }
  });
});
