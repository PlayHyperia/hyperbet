import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const ADAPTIVE_HLS_ENABLED = process.env.E2E_HLS_ADAPTIVE === "true";

type PlaybackObservation = {
  currentTime: number;
  droppedVideoFrames: number;
  totalVideoFrames: number;
  variantCount: string | null;
  abrMode: string | null;
  abrAuto: string | null;
  level: string | null;
  bitrate: string | null;
  resolution: string | null;
  bandwidthEstimate: string | null;
  nextAutoLevel: string | null;
  videoWidth: number;
  videoHeight: number;
};

type TimedPlaybackObservation = PlaybackObservation & {
  observedAfterRecoveryMs: number;
};

test("adaptive HLS delivery switches down under constraint and recovers", async ({
  context,
  page,
}, testInfo) => {
  test.skip(
    !ADAPTIVE_HLS_ENABLED,
    "adaptive delivery requires the explicit two-rendition HLS fixture",
  );
  test.setTimeout(180_000);

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      runtimeErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      runtimeErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const setNetwork = async (downloadBitsPerSecond: number) =>
    cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 100,
      downloadThroughput: downloadBitsPerSecond / 8,
      uploadThroughput: 1_000_000 / 8,
      connectionType: "wifi",
    });
  await setNetwork(10_000_000);

  await page.goto("/?adaptive-delivery-audit=1", {
    waitUntil: "domcontentloaded",
  });
  const video = page.locator("video").first();
  await expect(video).toBeAttached({ timeout: 20_000 });

  const readPlayback = () =>
    video.evaluate((element: HTMLVideoElement): PlaybackObservation => {
      const quality = element.getVideoPlaybackQuality();
      return {
        currentTime: element.currentTime,
        droppedVideoFrames: quality.droppedVideoFrames,
        totalVideoFrames: quality.totalVideoFrames,
        variantCount: element.dataset.streamVariantCount ?? null,
        abrMode: element.dataset.streamAbrMode ?? null,
        abrAuto: element.dataset.streamAbrAuto ?? null,
        level: element.dataset.streamCurrentLevel ?? null,
        bitrate: element.dataset.streamCurrentBitrate ?? null,
        resolution: element.dataset.streamCurrentResolution ?? null,
        bandwidthEstimate: element.dataset.streamBandwidthEstimate ?? null,
        nextAutoLevel: element.dataset.streamNextAutoLevel ?? null,
        videoWidth: element.videoWidth,
        videoHeight: element.videoHeight,
      };
    });

  await expect
    .poll(readPlayback, {
      timeout: 30_000,
      intervals: [100, 250, 500],
    })
    .toMatchObject({
      abrAuto: "true",
      abrMode: "automatic",
      resolution: "1280x720",
      variantCount: "2",
      videoHeight: 720,
      videoWidth: 1280,
    });
  const highBefore = await readPlayback();

  await setNetwork(1_600_000);
  await expect
    .poll(readPlayback, {
      timeout: 45_000,
      intervals: [250, 500, 1_000],
    })
    .toMatchObject({
      abrAuto: "true",
      abrMode: "automatic",
      resolution: "640x360",
      variantCount: "2",
      videoHeight: 360,
      videoWidth: 640,
    });
  const constrainedBefore = await readPlayback();
  await page.waitForTimeout(6_000);
  const constrainedAfter = await readPlayback();
  expect(
    constrainedAfter.currentTime - constrainedBefore.currentTime,
  ).toBeGreaterThan(4);
  await testInfo.attach("adaptive-hls-constrained", {
    body: Buffer.from(
      JSON.stringify(
        { highBefore, constrainedBefore, constrainedAfter },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });

  await setNetwork(10_000_000);
  const recoveryStartedAt = Date.now();
  const recoveryTimeline: TimedPlaybackObservation[] = [];
  let recoveredHigh = false;
  while (Date.now() - recoveryStartedAt < 45_000) {
    const observation = await readPlayback();
    recoveryTimeline.push({
      ...observation,
      observedAfterRecoveryMs: Date.now() - recoveryStartedAt,
    });
    if (
      observation.abrAuto === "true" &&
      observation.abrMode === "automatic" &&
      observation.resolution === "1280x720" &&
      observation.variantCount === "2" &&
      observation.videoHeight === 720 &&
      observation.videoWidth === 1280
    ) {
      recoveredHigh = true;
      break;
    }
    await page.waitForTimeout(1_000);
  }
  const recoveryDiagnostics = {
    schemaVersion: 1,
    highBefore,
    constrainedBefore,
    constrainedAfter,
    recoveredHigh,
    recoveryTimeline,
    runtimeErrors,
  };
  const recoveryDiagnosticsPath = testInfo.outputPath(
    "adaptive-hls-recovery-diagnostics.json",
  );
  await writeFile(
    recoveryDiagnosticsPath,
    `${JSON.stringify(recoveryDiagnostics, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await testInfo.attach("adaptive-hls-recovery-diagnostics", {
    path: recoveryDiagnosticsPath,
    contentType: "application/json",
  });
  expect(recoveredHigh, JSON.stringify(recoveryDiagnostics, null, 2)).toBe(
    true,
  );
  const recovered = await readPlayback();
  expect(recovered.currentTime).toBeGreaterThan(constrainedAfter.currentTime);

  const totalFrames = Math.max(
    0,
    recovered.totalVideoFrames - highBefore.totalVideoFrames,
  );
  const droppedFrames = Math.max(
    0,
    recovered.droppedVideoFrames - highBefore.droppedVideoFrames,
  );
  const droppedFrameRatio =
    totalFrames > 0 ? droppedFrames / totalFrames : Number.NaN;
  const evidence = {
    schemaVersion: 1,
    highBefore,
    constrainedBefore,
    constrainedAfter,
    recovered,
    totalFrames,
    droppedFrames,
    droppedFrameRatio,
    runtimeErrors,
  };
  const evidencePath = testInfo.outputPath("adaptive-hls-delivery.json");
  const screenshotPath = testInfo.outputPath("adaptive-hls-delivery.png");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    screenshotPath,
    await page.screenshot({ animations: "disabled", fullPage: true }),
    { flag: "wx", mode: 0o600 },
  );
  await testInfo.attach("adaptive-hls-delivery", {
    path: evidencePath,
    contentType: "application/json",
  });
  await testInfo.attach("adaptive-hls-delivery-screenshot", {
    path: screenshotPath,
    contentType: "image/png",
  });

  expect(Number.isFinite(droppedFrameRatio)).toBe(true);
  expect(droppedFrameRatio).toBeLessThanOrEqual(0.01);
  expect(runtimeErrors, JSON.stringify(evidence, null, 2)).toEqual([]);
});
