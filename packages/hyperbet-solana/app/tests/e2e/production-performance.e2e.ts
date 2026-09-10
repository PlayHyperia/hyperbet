import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  evaluateProductionBrowserPerformance,
  PRODUCTION_BROWSER_PERFORMANCE_BUDGET,
  type ProductionBrowserPerformanceMetrics,
} from "./productionPerformancePolicy";

const E2E_APP_RUNTIME = process.env.E2E_APP_RUNTIME?.trim() || "development";
const E2E_PERFORMANCE_PROFILE =
  process.env.E2E_PERFORMANCE_PROFILE?.trim() || "desktop_720p";
const E2E_PERFORMANCE_ARTIFACT_DIR =
  process.env.E2E_PERFORMANCE_ARTIFACT_DIR?.trim() || "";
const PLAYBACK_SAMPLE_MS = 10_000;

const PERFORMANCE_PROFILES = {
  desktop_720p: {
    cpuThrottlingRate: 2,
    latencyMs: 100,
    downloadBitsPerSecond: 10_000_000,
    uploadBitsPerSecond: 1_000_000,
    connectionType: "wifi",
    videoWidth: 1_280,
    videoHeight: 720,
    videoBitrateKbps: 4_500,
    audioBitrateKbps: 128,
  },
  mobile_360p: {
    cpuThrottlingRate: 4,
    latencyMs: 150,
    downloadBitsPerSecond: 1_600_000,
    uploadBitsPerSecond: 750_000,
    connectionType: "cellular3g",
    videoWidth: 640,
    videoHeight: 360,
    videoBitrateKbps: 900,
    audioBitrateKbps: 128,
  },
} as const;

if (!(E2E_PERFORMANCE_PROFILE in PERFORMANCE_PROFILES)) {
  throw new Error(
    `unsupported E2E_PERFORMANCE_PROFILE=${E2E_PERFORMANCE_PROFILE}`,
  );
}

const performanceProfile =
  PERFORMANCE_PROFILES[
    E2E_PERFORMANCE_PROFILE as keyof typeof PERFORMANCE_PROFILES
  ];

type BrowserPerformanceState = {
  lcpObserverSupported: boolean;
  longTaskObserverSupported: boolean;
  lcpMs: number;
  longTasks: number[];
};

type CdpMetric = { name: string; value: number };

function metricValue(metrics: CdpMetric[], name: string): number {
  return metrics.find((metric) => metric.name === name)?.value ?? Number.NaN;
}

async function measureTabInteraction(
  page: Page,
  name: string,
): Promise<number> {
  const startedAt = await page.evaluate(() => performance.now());
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const completedAt = await page.evaluate(() => performance.now());
  return completedAt - startedAt;
}

test("production spectator performance stays inside launch budgets", async ({
  context,
  page,
}, testInfo) => {
  test.skip(
    E2E_APP_RUNTIME !== "production_preview",
    "production performance requires the compiled preview runtime",
  );
  test.setTimeout(180_000);

  await page.addInitScript(() => {
    const state: BrowserPerformanceState = {
      lcpObserverSupported: false,
      longTaskObserverSupported: false,
      lcpMs: 0,
      longTasks: [],
    };
    Object.defineProperty(window, "__hyperbetPerformance", {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.lcpMs = Math.max(state.lcpMs, entry.startTime);
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
      state.lcpObserverSupported = true;
    } catch {
      // A missing observer remains lcpMs=0 and fails closed below.
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push(entry.duration);
        }
      }).observe({ type: "longtask", buffered: true });
      state.longTaskObserverSupported = true;
    } catch {
      // A missing observer produces no measurements and is reported in evidence.
    }
  });

  const cdp = await context.newCDPSession(page);
  const browserVersion = await cdp.send("Browser.getVersion");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: performanceProfile.latencyMs,
    downloadThroughput: performanceProfile.downloadBitsPerSecond / 8,
    uploadThroughput: performanceProfile.uploadBitsPerSecond / 8,
    connectionType: performanceProfile.connectionType,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: performanceProfile.cpuThrottlingRate,
  });
  await cdp.send("Performance.enable");

  await page.goto("/?performance-audit=1", {
    waitUntil: "domcontentloaded",
  });

  const video = page.locator("video").first();
  await expect(video).toBeAttached({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        video.evaluate((element: HTMLVideoElement) => ({
          currentTime: element.currentTime,
          readyState: element.readyState,
          videoHeight: element.videoHeight,
          videoWidth: element.videoWidth,
        })),
      { timeout: 20_000, intervals: [100, 250, 500] },
    )
    .toMatchObject({
      readyState: expect.any(Number),
      videoHeight: performanceProfile.videoHeight,
      videoWidth: performanceProfile.videoWidth,
    });
  await expect
    .poll(
      () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
      {
        timeout: 20_000,
        intervals: [100, 250, 500],
      },
    )
    .toBeGreaterThan(0);
  const firstDecodedFrameMs = await page.evaluate(() => performance.now());

  await expect(page.getByText(/HYPERIA DUEL ARENA/i)).toBeVisible();
  const interactionDurations = [
    await measureTabInteraction(page, "Agents"),
    await measureTabInteraction(page, "Trades"),
    await measureTabInteraction(page, "Match Log"),
  ];

  const videoBefore = await video.evaluate((element: HTMLVideoElement) => {
    const quality = element.getVideoPlaybackQuality();
    return {
      currentTime: element.currentTime,
      droppedVideoFrames: quality.droppedVideoFrames,
      totalVideoFrames: quality.totalVideoFrames,
    };
  });
  const cdpBefore = (await cdp.send("Performance.getMetrics")) as {
    metrics: CdpMetric[];
  };
  const frameSample = await video.evaluate(
    (element: HTMLVideoElement, durationMs) =>
      new Promise<{
        elapsedMs: number;
        frameCallbacksSupported: boolean;
        mediaAdvanceSeconds: number;
        presentedFrames: number;
      }>((resolve) => {
        const startedAt = performance.now();
        const startedMediaTime = element.currentTime;
        if (typeof element.requestVideoFrameCallback !== "function") {
          window.setTimeout(
            () =>
              resolve({
                elapsedMs: performance.now() - startedAt,
                frameCallbacksSupported: false,
                mediaAdvanceSeconds: element.currentTime - startedMediaTime,
                presentedFrames: 0,
              }),
            durationMs,
          );
          return;
        }

        let callbackHandle = 0;
        let presentedFrames = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (typeof element.cancelVideoFrameCallback === "function") {
            element.cancelVideoFrameCallback(callbackHandle);
          }
          resolve({
            elapsedMs: performance.now() - startedAt,
            frameCallbacksSupported: true,
            mediaAdvanceSeconds: element.currentTime - startedMediaTime,
            presentedFrames,
          });
        };
        const onFrame = () => {
          if (settled) return;
          presentedFrames += 1;
          callbackHandle = element.requestVideoFrameCallback(onFrame);
        };
        callbackHandle = element.requestVideoFrameCallback(onFrame);
        window.setTimeout(finish, durationMs);
      }),
    PLAYBACK_SAMPLE_MS,
  );
  const cdpAfter = (await cdp.send("Performance.getMetrics")) as {
    metrics: CdpMetric[];
  };
  const videoAfter = await video.evaluate((element: HTMLVideoElement) => {
    const quality = element.getVideoPlaybackQuality();
    return {
      currentTime: element.currentTime,
      droppedVideoFrames: quality.droppedVideoFrames,
      totalVideoFrames: quality.totalVideoFrames,
    };
  });

  const browserState = await page.evaluate(
    () =>
      (window as unknown as { __hyperbetPerformance: BrowserPerformanceState })
        .__hyperbetPerformance,
  );
  const transferredBytes = await page.evaluate(() =>
    performance.getEntriesByType("resource").reduce(
      (total, entry) => {
        const resource = entry as PerformanceResourceTiming;
        const isMedia = new URL(resource.name, window.location.href).pathname
          .split("/")
          .includes("live");
        if (isMedia) {
          total.media += resource.transferSize;
        } else {
          total.nonMedia += resource.transferSize;
        }
        return total;
      },
      { media: 0, nonMedia: 0 },
    ),
  );
  const clientEnvironment = await page.evaluate(() => {
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    );
    return {
      devicePixelRatio: window.devicePixelRatio,
      documentWidth,
      hardwareConcurrency: navigator.hardwareConcurrency,
      horizontalOverflowPx: Math.max(0, documentWidth - window.innerWidth),
      screenHeight: window.screen.height,
      screenWidth: window.screen.width,
      userAgent: navigator.userAgent,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  const sampleDurationSeconds = Math.max(1, frameSample.elapsedMs) / 1_000;
  const totalVideoFrames = Math.max(
    0,
    videoAfter.totalVideoFrames - videoBefore.totalVideoFrames,
  );
  const droppedFrames = Math.max(
    0,
    videoAfter.droppedVideoFrames - videoBefore.droppedVideoFrames,
  );
  const qualityPresentedFrames = Math.max(0, totalVideoFrames - droppedFrames);
  const cdpDelta = (name: string) =>
    Math.max(
      0,
      metricValue(cdpAfter.metrics, name) -
        metricValue(cdpBefore.metrics, name),
    );
  const metrics: ProductionBrowserPerformanceMetrics = {
    lcpObserverSupported: browserState.lcpObserverSupported,
    longTaskObserverSupported: browserState.longTaskObserverSupported,
    lcpMs: browserState.lcpMs,
    firstDecodedFrameMs,
    maxInteractionMs: Math.max(...interactionDurations),
    presentedFps: frameSample.frameCallbacksSupported
      ? frameSample.presentedFrames / sampleDurationSeconds
      : Number.NaN,
    qualityPresentedFps: qualityPresentedFrames / sampleDurationSeconds,
    droppedFrameRatio:
      totalVideoFrames > 0 ? droppedFrames / totalVideoFrames : Number.NaN,
    jsHeapUsedBytes: metricValue(cdpAfter.metrics, "JSHeapUsedSize"),
    maxLongTaskMs: Math.max(0, ...browserState.longTasks),
    totalLongTaskMs: browserState.longTasks.reduce(
      (total, duration) => total + duration,
      0,
    ),
    taskUtilization: cdpDelta("TaskDuration") / sampleDurationSeconds,
    scriptUtilization: cdpDelta("ScriptDuration") / sampleDurationSeconds,
    layoutUtilization:
      (cdpDelta("LayoutDuration") + cdpDelta("RecalcStyleDuration")) /
      sampleDurationSeconds,
    horizontalOverflowPx: clientEnvironment.horizontalOverflowPx,
    nonMediaTransferredBytes: transferredBytes.nonMedia,
    mediaTransferredBytes: transferredBytes.media,
  };
  const violations = evaluateProductionBrowserPerformance(metrics);
  const evidence = {
    schemaVersion: 2,
    runtime: E2E_APP_RUNTIME,
    profile: E2E_PERFORMANCE_PROFILE,
    browser: browserVersion,
    host: { arch: process.arch, platform: process.platform },
    emulation: {
      cpuThrottlingRate: performanceProfile.cpuThrottlingRate,
      latencyMs: performanceProfile.latencyMs,
      downloadBitsPerSecond: performanceProfile.downloadBitsPerSecond,
      uploadBitsPerSecond: performanceProfile.uploadBitsPerSecond,
      connectionType: performanceProfile.connectionType,
    },
    source: {
      audioBitrateKbps: performanceProfile.audioBitrateKbps,
      videoBitrateKbps: performanceProfile.videoBitrateKbps,
      videoHeight: performanceProfile.videoHeight,
      videoWidth: performanceProfile.videoWidth,
    },
    viewport: page.viewportSize(),
    clientEnvironment,
    playback: {
      sampleDurationMs: frameSample.elapsedMs,
      mediaAdvanceSeconds: frameSample.mediaAdvanceSeconds,
      totalVideoFrames,
      qualityPresentedFrames,
      requestVideoFrameCallbackFrames: frameSample.presentedFrames,
      requestVideoFrameCallbackSupported: frameSample.frameCallbacksSupported,
      droppedFrames,
    },
    interactionDurations,
    longTaskCount: browserState.longTasks.length,
    metrics,
    budgets: PRODUCTION_BROWSER_PERFORMANCE_BUDGET,
    verdict: {
      passed: violations.length === 0,
      violations,
    },
  };
  const screenshot = await page.screenshot({
    animations: "disabled",
    fullPage: true,
  });
  console.log(`[e2e] production performance ${JSON.stringify(evidence)}`);
  await testInfo.attach("production-browser-performance", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json",
  });
  await testInfo.attach("production-browser-performance-screenshot", {
    body: screenshot,
    contentType: "image/png",
  });
  if (E2E_PERFORMANCE_ARTIFACT_DIR) {
    const artifactDirectory = path.resolve(E2E_PERFORMANCE_ARTIFACT_DIR);
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(
      path.join(artifactDirectory, `${E2E_PERFORMANCE_PROFILE}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(artifactDirectory, `${E2E_PERFORMANCE_PROFILE}.png`),
      screenshot,
    );
  }

  expect(violations, JSON.stringify(evidence, null, 2)).toEqual([]);
});
