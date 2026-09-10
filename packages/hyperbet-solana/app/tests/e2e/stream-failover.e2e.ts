import { expect, test, type Page, type Response } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const HLS_FAILOVER_ENABLED = process.env.E2E_HLS_FAILOVER === "true";
const HLS_SOURCE_TOPOLOGY = process.env.E2E_HLS_SOURCE_TOPOLOGY ?? "";
const HLS_PRIMARY_URL = process.env.E2E_HLS_PRIMARY_URL ?? "";
const HLS_BACKUP_URL = process.env.E2E_HLS_BACKUP_URL ?? "";
const PROCESS_CONTROL_SCRIPT = process.env.E2E_PROCESS_CONTROL_SCRIPT ?? "";
const CONTROL_PATH = process.env.E2E_CONTROL_PATH ?? "";
const PRIMARY_ORIGIN_PID_FILE =
  process.env.E2E_HLS_PRIMARY_ORIGIN_PID_FILE ?? "";
const BACKUP_ORIGIN_PID_FILE = process.env.E2E_HLS_BACKUP_ORIGIN_PID_FILE ?? "";
const HLS_CONTENT_PARITY_PATH = process.env.E2E_HLS_CONTENT_PARITY_PATH ?? "";
const MAX_FAILOVER_RECOVERY_MS = 20_000;
const MAX_SOURCE_CLOCK_SKEW_MS = 5_000;
const PLAYBACK_SAMPLE_MS = 4_000;

function requiredProcessId(environmentKey: string): number {
  const processId = Number.parseInt(process.env[environmentKey] ?? "", 10);
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error(`${environmentKey} must identify a live fixture process`);
  }
  return processId;
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function runOriginProcessControl(
  action: "kill" | "start",
  service: "hlsBackupOrigin" | "hlsPrimaryOrigin",
): void {
  if (!PROCESS_CONTROL_SCRIPT || !CONTROL_PATH) {
    throw new Error("origin process-control configuration is missing");
  }
  execFileSync(
    "bash",
    [PROCESS_CONTROL_SCRIPT, action, CONTROL_PATH, service],
    { stdio: "inherit" },
  );
}

function readRequiredProcessIdFile(pidFile: string): number {
  if (!pidFile) throw new Error("origin PID file path is missing");
  const processId = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error(`origin PID file is invalid: ${pidFile}`);
  }
  return processId;
}

function readHlsContentParity(): HlsContentParity {
  if (!HLS_CONTENT_PARITY_PATH) {
    throw new Error("HLS content-parity evidence path is missing");
  }
  return JSON.parse(
    readFileSync(HLS_CONTENT_PARITY_PATH, "utf8"),
  ) as HlsContentParity;
}

type PlaybackObservation = {
  abrAuto: string | null;
  currentTime: number;
  droppedVideoFrames: number;
  marketCanPlaceBet: string | null;
  marketMode: string | null;
  networkFailureCount: string | null;
  paused: boolean;
  playbackDateMs: number | null;
  readyState: number;
  resolution: string | null;
  source: string | null;
  streamDuelId: string | null;
  streamDuelKey: string | null;
  streamSyncMode: string | null;
  totalVideoFrames: number;
  variantCount: string | null;
  videoHeight: number;
  videoWidth: number;
};

type PlaybackSample = {
  after: PlaybackObservation;
  before: PlaybackObservation;
  droppedFrameRatio: number;
  droppedFrames: number;
  mediaAdvanceSeconds: number;
  playbackDateAdvanceMs: number;
  sourceLabel: string;
  totalFrames: number;
};

type HlsResponseHeaderSample = {
  cacheControl: string | null;
  contentType: string | null;
  cors: string | null;
  fixtureOrigin: string | null;
  kind: "manifest" | "segment";
  origin: string;
  path: string;
  source: "backup" | "primary";
  status: number;
  timingAllowOrigin: string | null;
};

type HlsSourceFingerprint = {
  fixtureOrigin: string | null;
  latestProgramDateTimeMs: number;
  masterUrl: string;
  mediaPlaylistUrl: string;
  origin: string;
  segmentByteLength: number;
  segmentSha256: string;
  segmentUrl: string;
  source: "backup" | "primary";
};

type HlsContentParity = {
  backupEncodedSha256: string;
  decodedAudioEquivalent: boolean;
  decodedAudioSha256: string;
  decodedVideoEquivalent: boolean;
  decodedVideoSha256: string;
  independentTransportBytes: boolean;
  primaryEncodedSha256: string;
  schemaVersion: number;
  segmentName: string;
};

function sourceFromUrl(url: string): "backup" | "primary" | null {
  if (url.includes("/live/primary/")) return "primary";
  if (url.includes("/live/backup/")) return "backup";
  return null;
}

async function fingerprintHlsSource(
  page: Page,
  masterUrl: string,
  source: "backup" | "primary",
): Promise<HlsSourceFingerprint> {
  return page.evaluate(
    async ({ expectedSource, playlistUrl }) => {
      const fetchRequired = async (url: string) => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(
            `HLS fingerprint request failed: ${response.status} ${url}`,
          );
        }
        const fixtureOrigin = response.headers.get("x-hyperbet-e2e-hls-origin");
        if (fixtureOrigin !== expectedSource) {
          throw new Error(
            `HLS origin identity mismatch: expected ${expectedSource}, received ${fixtureOrigin ?? "missing"}`,
          );
        }
        return { fixtureOrigin, response };
      };

      const master = await fetchRequired(playlistUrl);
      const masterText = await master.response.text();
      const renditionPath = masterText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#"));
      if (!renditionPath) {
        throw new Error(`HLS master has no rendition: ${playlistUrl}`);
      }
      const mediaPlaylistUrl = new URL(renditionPath, playlistUrl).href;
      const media = await fetchRequired(mediaPlaylistUrl);
      const mediaText = await media.response.text();
      let currentProgramDateTimeMs: number | null = null;
      const segments: Array<{ programDateTimeMs: number; url: string }> = [];
      for (const rawLine of mediaText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
          const parsed = Date.parse(
            line.slice("#EXT-X-PROGRAM-DATE-TIME:".length),
          );
          currentProgramDateTimeMs = Number.isFinite(parsed) ? parsed : null;
        } else if (line && !line.startsWith("#")) {
          if (currentProgramDateTimeMs === null) {
            throw new Error(
              `HLS segment is missing program-date-time: ${mediaPlaylistUrl}`,
            );
          }
          segments.push({
            programDateTimeMs: currentProgramDateTimeMs,
            url: new URL(line, mediaPlaylistUrl).href,
          });
          currentProgramDateTimeMs = null;
        }
      }
      const latestSegment = segments.at(-1);
      if (!latestSegment) {
        throw new Error(
          `HLS media playlist has no segments: ${mediaPlaylistUrl}`,
        );
      }
      const segment = await fetchRequired(latestSegment.url);
      const segmentBytes = await segment.response.arrayBuffer();
      if (segmentBytes.byteLength <= 0) {
        throw new Error(`HLS segment is empty: ${latestSegment.url}`);
      }
      const digest = await crypto.subtle.digest("SHA-256", segmentBytes);
      const segmentSha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        fixtureOrigin: segment.fixtureOrigin,
        latestProgramDateTimeMs: latestSegment.programDateTimeMs,
        masterUrl: playlistUrl,
        mediaPlaylistUrl,
        origin: new URL(playlistUrl).origin,
        segmentByteLength: segmentBytes.byteLength,
        segmentSha256,
        segmentUrl: latestSegment.url,
        source: expectedSource,
      };
    },
    { expectedSource: source, playlistUrl: masterUrl },
  );
}

function readPlayback(page: Page): Promise<PlaybackObservation> {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    const root = document.querySelector<HTMLElement>(".hm-root");
    if (!(video instanceof HTMLVideoElement) || !root) {
      throw new Error("spectator video or application root is missing");
    }
    const quality = video.getVideoPlaybackQuality();
    const playbackDateValue = Number(video.dataset.streamPlaybackDateMs);
    return {
      abrAuto: video.dataset.streamAbrAuto ?? null,
      currentTime: video.currentTime,
      droppedVideoFrames: quality.droppedVideoFrames,
      marketCanPlaceBet: root.dataset.marketCanPlaceBet ?? null,
      marketMode: root.dataset.marketMode ?? null,
      networkFailureCount: video.dataset.streamNetworkFailureCount ?? null,
      paused: video.paused,
      playbackDateMs: Number.isFinite(playbackDateValue)
        ? playbackDateValue
        : null,
      readyState: video.readyState,
      resolution: video.dataset.streamCurrentResolution ?? null,
      source: video.dataset.streamSource ?? null,
      streamDuelId: root.dataset.streamDuelId ?? null,
      streamDuelKey: root.dataset.streamDuelKey ?? null,
      streamSyncMode: root.dataset.streamSyncMode ?? null,
      totalVideoFrames: quality.totalVideoFrames,
      variantCount: video.dataset.streamVariantCount ?? null,
      videoHeight: video.videoHeight,
      videoWidth: video.videoWidth,
    };
  });
}

async function waitForHealthySource(page: Page, sourcePath: string) {
  await expect
    .poll(
      async () => {
        const observation = await readPlayback(page);
        return Boolean(
          observation.abrAuto === "true" &&
          observation.currentTime > 0 &&
          observation.marketCanPlaceBet === "false" &&
          observation.paused === false &&
          observation.playbackDateMs !== null &&
          observation.readyState >= 2 &&
          observation.resolution !== null &&
          observation.source?.includes(sourcePath) &&
          observation.streamDuelId &&
          observation.streamDuelKey &&
          observation.streamSyncMode === "program-date-time" &&
          observation.variantCount === "2" &&
          observation.videoHeight > 0 &&
          observation.videoWidth > 0,
        );
      },
      { timeout: MAX_FAILOVER_RECOVERY_MS, intervals: [100, 250, 500] },
    )
    .toBe(true);
  return readPlayback(page);
}

async function sampleAdvancingPlayback(
  page: Page,
  sourcePath: string,
  sourceLabel: string,
): Promise<PlaybackSample> {
  const before = await waitForHealthySource(page, sourcePath);
  await page.waitForTimeout(PLAYBACK_SAMPLE_MS);
  const after = await readPlayback(page);
  const totalFrames = Math.max(
    0,
    after.totalVideoFrames - before.totalVideoFrames,
  );
  const droppedFrames = Math.max(
    0,
    after.droppedVideoFrames - before.droppedVideoFrames,
  );
  const droppedFrameRatio =
    totalFrames > 0 ? droppedFrames / totalFrames : Number.NaN;
  const sample = {
    after,
    before,
    droppedFrameRatio,
    droppedFrames,
    mediaAdvanceSeconds: after.currentTime - before.currentTime,
    playbackDateAdvanceMs:
      (after.playbackDateMs ?? 0) - (before.playbackDateMs ?? 0),
    sourceLabel,
    totalFrames,
  };

  expect(after.source, JSON.stringify(sample, null, 2)).toContain(sourcePath);
  expect(after.streamDuelId).toBe(before.streamDuelId);
  expect(after.streamDuelKey).toBe(before.streamDuelKey);
  expect(after.streamSyncMode).toBe("program-date-time");
  expect(after.marketCanPlaceBet).toBe("false");
  expect(sample.mediaAdvanceSeconds).toBeGreaterThan(2.5);
  expect(sample.playbackDateAdvanceMs).toBeGreaterThan(2_500);
  expect(totalFrames).toBeGreaterThan(60);
  expect(Number.isFinite(droppedFrameRatio)).toBe(true);
  expect(droppedFrameRatio).toBeLessThanOrEqual(0.01);
  return sample;
}

function captureHlsHeaders(
  response: Response,
  samples: HlsResponseHeaderSample[],
): Promise<void> {
  return (async () => {
    const source = sourceFromUrl(response.url());
    if (!source || response.status() >= 400) return;
    const path = new URL(response.url()).pathname;
    const kind = path.endsWith(".m3u8") ? "manifest" : "segment";
    if (kind === "segment" && !/\.(?:m4s|mp4|ts)$/.test(path)) return;
    if (
      samples.some((sample) => sample.source === source && sample.kind === kind)
    ) {
      return;
    }
    const headers = await response.allHeaders();
    samples.push({
      cacheControl: headers["cache-control"] ?? null,
      contentType: headers["content-type"] ?? null,
      cors: headers["access-control-allow-origin"] ?? null,
      fixtureOrigin: headers["x-hyperbet-e2e-hls-origin"] ?? null,
      kind,
      origin: new URL(response.url()).origin,
      path,
      source,
      status: response.status(),
      timingAllowOrigin: headers["timing-allow-origin"] ?? null,
    });
  })();
}

test("HLS source failover preserves live spectator playback and authority", async ({
  page,
}, testInfo) => {
  test.skip(
    !HLS_FAILOVER_ENABLED,
    "source failover requires the explicit dual-source HLS fixture",
  );
  test.setTimeout(180_000);

  const runtimeErrors: string[] = [];
  const expectedTransportFailures: Array<{
    errorText: string | null;
    path: string;
  }> = [];
  const expectedResourceConsoleErrors: Array<{
    location: string;
    text: string;
  }> = [];
  const hlsResponseHeaders: HlsResponseHeaderSample[] = [];
  const hlsHeaderTasks: Promise<void>[] = [];

  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const source = sourceFromUrl(request.url());
    if (source) {
      expectedTransportFailures.push({
        errorText: request.failure()?.errorText ?? null,
        path: new URL(request.url()).pathname,
      });
      return;
    }
    runtimeErrors.push(
      `${request.failure()?.errorText ?? "request failed"} ${request.url()}`,
    );
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    if (
      message.text().startsWith("Failed to load resource:") &&
      sourceFromUrl(location)
    ) {
      expectedResourceConsoleErrors.push({
        location: new URL(location).pathname,
        text: message.text(),
      });
      return;
    }
    runtimeErrors.push(
      `${message.text()}${location ? ` (${location})` : " (unknown resource)"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      runtimeErrors.push(`${response.status()} ${response.url()}`);
    }
    if (sourceFromUrl(response.url())) {
      hlsHeaderTasks.push(captureHlsHeaders(response, hlsResponseHeaders));
    }
  });

  await page.goto("/?stream-failover-audit=1", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/favicon.svg",
  );
  expect(
    await page.evaluate(async () => {
      const response = await fetch("/favicon.svg", { cache: "no-store" });
      return {
        contentType: response.headers.get("content-type"),
        status: response.status,
      };
    }),
  ).toEqual({ contentType: "image/svg+xml", status: 200 });
  expect(HLS_SOURCE_TOPOLOGY).toBe("independent-encoders-origins");
  const sourceProcesses = {
    backupEncoderPid: requiredProcessId("E2E_HLS_BACKUP_ENCODER_PID"),
    backupOriginPid: requiredProcessId("E2E_HLS_BACKUP_ORIGIN_PID"),
    primaryEncoderPid: requiredProcessId("E2E_HLS_PRIMARY_ENCODER_PID"),
    primaryOriginPid: requiredProcessId("E2E_HLS_PRIMARY_ORIGIN_PID"),
  };
  expect(new Set(Object.values(sourceProcesses)).size).toBe(4);
  for (const processId of Object.values(sourceProcesses)) {
    expect(
      processIsAlive(processId),
      `fixture process ${processId} is live`,
    ).toBe(true);
  }
  const sourceContentParity = readHlsContentParity();
  expect(sourceContentParity.schemaVersion).toBe(1);
  expect(sourceContentParity.segmentName).toMatch(/^segment-\d{6}\.ts$/);
  expect(sourceContentParity.independentTransportBytes).toBe(true);
  expect(sourceContentParity.primaryEncodedSha256).not.toBe(
    sourceContentParity.backupEncodedSha256,
  );
  expect(sourceContentParity.decodedVideoEquivalent).toBe(true);
  expect(sourceContentParity.decodedAudioEquivalent).toBe(true);
  expect(sourceContentParity.decodedVideoSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(sourceContentParity.decodedAudioSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(HLS_PRIMARY_URL).toContain("/live/primary/master.m3u8");
  expect(HLS_BACKUP_URL).toContain("/live/backup/master.m3u8");
  expect(new URL(HLS_PRIMARY_URL).origin).not.toBe(
    new URL(HLS_BACKUP_URL).origin,
  );
  const sourceFingerprints = {
    primary: await fingerprintHlsSource(page, HLS_PRIMARY_URL, "primary"),
    backup: await fingerprintHlsSource(page, HLS_BACKUP_URL, "backup"),
  };
  const sourceClockSkewMs = Math.abs(
    sourceFingerprints.primary.latestProgramDateTimeMs -
      sourceFingerprints.backup.latestProgramDateTimeMs,
  );
  expect(sourceFingerprints.primary.origin).not.toBe(
    sourceFingerprints.backup.origin,
  );
  expect(sourceFingerprints.primary.fixtureOrigin).toBe("primary");
  expect(sourceFingerprints.backup.fixtureOrigin).toBe("backup");
  expect(sourceFingerprints.primary.segmentByteLength).toBeGreaterThan(0);
  expect(sourceFingerprints.backup.segmentByteLength).toBeGreaterThan(0);
  expect(sourceFingerprints.primary.segmentSha256).not.toBe(
    sourceFingerprints.backup.segmentSha256,
  );
  expect(sourceClockSkewMs).toBeLessThanOrEqual(MAX_SOURCE_CLOCK_SKEW_MS);
  const navigationMarker = await page.evaluate(() => {
    const marker = crypto.randomUUID();
    (
      window as typeof window & { __hyperbetHlsFailoverMarker?: string }
    ).__hyperbetHlsFailoverMarker = marker;
    return marker;
  });
  const sourceButton = page.getByRole("button", { name: /^Source \d\/2$/ });
  await expect(sourceButton).toHaveText("Source 1/2");

  const primaryInitial = await sampleAdvancingPlayback(
    page,
    "/live/primary/",
    "primary-initial",
  );
  const authoritativeDuel = {
    id: primaryInitial.after.streamDuelId,
    key: primaryInitial.after.streamDuelKey,
  };

  const primaryFaultPattern = "**/live/primary/**";
  await sourceButton.evaluate((button) => {
    const video = document.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error(
        "spectator video is missing before transient fault audit",
      );
    }
    const audit = {
      networkFailureCounts: [
        video.dataset.streamNetworkFailureCount ?? null,
      ] as Array<string | null>,
      sourceLabels: [button.textContent?.trim() ?? ""],
    };
    const appendDistinct = <T>(values: T[], value: T) => {
      if (values.at(-1) !== value) values.push(value);
    };
    const sourceObserver = new MutationObserver(() => {
      appendDistinct(audit.sourceLabels, button.textContent?.trim() ?? "");
    });
    sourceObserver.observe(button, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    const networkObserver = new MutationObserver(() => {
      appendDistinct(
        audit.networkFailureCounts,
        video.dataset.streamNetworkFailureCount ?? null,
      );
    });
    networkObserver.observe(video, {
      attributeFilter: ["data-stream-network-failure-count"],
      attributes: true,
    });
    (
      window as typeof window & {
        __hyperbetTransientFailureAudit?: {
          audit: typeof audit;
          disconnect: () => void;
        };
      }
    ).__hyperbetTransientFailureAudit = {
      audit,
      disconnect: () => {
        sourceObserver.disconnect();
        networkObserver.disconnect();
      },
    };
  });

  const transientPrimaryBefore = await readPlayback(page);
  const transientPrimaryFailurePaths: string[] = [];
  let transientPrimaryFailuresRemaining = 2;
  const transientPrimaryHandler: Parameters<Page["route"]>[1] = (route) => {
    if (transientPrimaryFailuresRemaining <= 0) return route.continue();
    transientPrimaryFailuresRemaining -= 1;
    transientPrimaryFailurePaths.push(new URL(route.request().url()).pathname);
    return route.abort("connectionfailed");
  };
  await page.route(primaryFaultPattern, transientPrimaryHandler);
  await expect
    .poll(() => transientPrimaryFailuresRemaining, {
      message: "two transient primary HLS faults must be injected",
      timeout: 10_000,
    })
    .toBe(0);
  await expect
    .poll(async () => (await readPlayback(page)).networkFailureCount, {
      message: "a successful primary delivery must reset the fault counter",
      timeout: 10_000,
    })
    .toBeNull();
  await page.waitForTimeout(PLAYBACK_SAMPLE_MS);
  const transientPrimaryAfter = await readPlayback(page);
  const transientAudit = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __hyperbetTransientFailureAudit?: {
          audit: {
            networkFailureCounts: Array<string | null>;
            sourceLabels: string[];
          };
          disconnect: () => void;
        };
      }
    ).__hyperbetTransientFailureAudit;
    if (!state) throw new Error("transient failure audit state is missing");
    state.disconnect();
    return state.audit;
  });
  const transientPrimaryRecovery = {
    after: transientPrimaryAfter,
    before: transientPrimaryBefore,
    injectedFailurePaths: transientPrimaryFailurePaths,
    injectedFailures: 2,
    mediaAdvanceSeconds:
      transientPrimaryAfter.currentTime - transientPrimaryBefore.currentTime,
    networkFailureCounts: transientAudit.networkFailureCounts,
    sourceLabels: transientAudit.sourceLabels,
  };
  await expect(sourceButton).toHaveText("Source 1/2");
  expect(transientPrimaryRecovery.injectedFailurePaths).toHaveLength(2);
  expect(transientPrimaryRecovery.networkFailureCounts).toContain("1");
  expect(transientPrimaryRecovery.networkFailureCounts).toContain("2");
  expect(transientPrimaryRecovery.networkFailureCounts.at(-1)).toBeNull();
  expect(transientPrimaryRecovery.sourceLabels).toEqual(["Source 1/2"]);
  expect(transientPrimaryAfter.source).toContain("/live/primary/");
  expect(transientPrimaryAfter.networkFailureCount).toBeNull();
  expect(transientPrimaryAfter.streamDuelId).toBe(authoritativeDuel.id);
  expect(transientPrimaryAfter.streamDuelKey).toBe(authoritativeDuel.key);
  expect(transientPrimaryRecovery.mediaAdvanceSeconds).toBeGreaterThan(3);
  await page.unroute(primaryFaultPattern, transientPrimaryHandler);

  const primaryFaultStartedAt = Date.now();
  runOriginProcessControl("kill", "hlsPrimaryOrigin");
  const primaryOriginStoppedMs = Date.now() - primaryFaultStartedAt;
  await expect
    .poll(() => processIsAlive(sourceProcesses.primaryOriginPid), {
      message: "the original primary origin process must exit",
      timeout: 5_000,
    })
    .toBe(false);
  expect(processIsAlive(sourceProcesses.primaryEncoderPid)).toBe(true);
  await expect(sourceButton).toHaveText("Source 2/2", {
    timeout: MAX_FAILOVER_RECOVERY_MS,
  });
  const primaryToBackupSourceSelectionMs = Date.now() - primaryFaultStartedAt;
  const backupReady = await waitForHealthySource(page, "/live/backup/");
  const primaryToBackupRecoveryMs = Date.now() - primaryFaultStartedAt;
  const backup = await sampleAdvancingPlayback(page, "/live/backup/", "backup");
  expect(primaryToBackupRecoveryMs).toBeLessThanOrEqual(
    MAX_FAILOVER_RECOVERY_MS,
  );
  expect(backupReady.streamDuelId).toBe(authoritativeDuel.id);
  expect(backupReady.streamDuelKey).toBe(authoritativeDuel.key);
  expect(backup.after.streamDuelId).toBe(authoritativeDuel.id);
  expect(backup.after.streamDuelKey).toBe(authoritativeDuel.key);

  const primaryOriginRestartStartedAt = Date.now();
  runOriginProcessControl("start", "hlsPrimaryOrigin");
  const primaryOriginRestartReadyMs =
    Date.now() - primaryOriginRestartStartedAt;
  const restartedPrimaryOriginPid = readRequiredProcessIdFile(
    PRIMARY_ORIGIN_PID_FILE,
  );
  expect(restartedPrimaryOriginPid).not.toBe(sourceProcesses.primaryOriginPid);
  expect(processIsAlive(restartedPrimaryOriginPid)).toBe(true);
  expect(processIsAlive(sourceProcesses.primaryEncoderPid)).toBe(true);
  const restartedPrimaryFingerprint = await fingerprintHlsSource(
    page,
    HLS_PRIMARY_URL,
    "primary",
  );
  expect(restartedPrimaryFingerprint.origin).toBe(
    sourceFingerprints.primary.origin,
  );

  const backupFaultStartedAt = Date.now();
  runOriginProcessControl("kill", "hlsBackupOrigin");
  const backupOriginStoppedMs = Date.now() - backupFaultStartedAt;
  expect(existsSync(BACKUP_ORIGIN_PID_FILE)).toBe(false);
  await expect
    .poll(() => processIsAlive(sourceProcesses.backupOriginPid), {
      message: "the original backup origin process must exit",
      timeout: 5_000,
    })
    .toBe(false);
  expect(processIsAlive(sourceProcesses.backupEncoderPid)).toBe(true);
  await expect(sourceButton).toHaveText("Source 1/2", {
    timeout: MAX_FAILOVER_RECOVERY_MS,
  });
  const backupToPrimarySourceSelectionMs = Date.now() - backupFaultStartedAt;
  const primaryReady = await waitForHealthySource(page, "/live/primary/");
  const backupToPrimaryRecoveryMs = Date.now() - backupFaultStartedAt;
  const primaryRecovered = await sampleAdvancingPlayback(
    page,
    "/live/primary/",
    "primary-recovered",
  );
  expect(backupToPrimaryRecoveryMs).toBeLessThanOrEqual(
    MAX_FAILOVER_RECOVERY_MS,
  );
  expect(primaryReady.streamDuelId).toBe(authoritativeDuel.id);
  expect(primaryReady.streamDuelKey).toBe(authoritativeDuel.key);
  expect(primaryRecovered.after.streamDuelId).toBe(authoritativeDuel.id);
  expect(primaryRecovered.after.streamDuelKey).toBe(authoritativeDuel.key);
  expect(processIsAlive(restartedPrimaryOriginPid)).toBe(true);
  expect(processIsAlive(sourceProcesses.primaryEncoderPid)).toBe(true);
  expect(processIsAlive(sourceProcesses.backupEncoderPid)).toBe(true);
  const originProcessFaults = {
    backupOrigin: {
      encoderRemainedAlive: true,
      originalPid: sourceProcesses.backupOriginPid,
      stoppedMs: backupOriginStoppedMs,
    },
    primaryOrigin: {
      encoderRemainedAlive: true,
      originalPid: sourceProcesses.primaryOriginPid,
      replacementPid: restartedPrimaryOriginPid,
      restartReadyMs: primaryOriginRestartReadyMs,
      restartedFingerprint: restartedPrimaryFingerprint,
      stoppedMs: primaryOriginStoppedMs,
    },
  };

  expect(
    await page.evaluate(() => ({
      marker: (
        window as typeof window & { __hyperbetHlsFailoverMarker?: string }
      ).__hyperbetHlsFailoverMarker,
      navigationCount: performance.getEntriesByType("navigation").length,
    })),
  ).toEqual({ marker: navigationMarker, navigationCount: 1 });
  expect(await page.getByRole("button", { name: /place bet/i }).count()).toBe(
    0,
  );

  await Promise.all(hlsHeaderTasks);
  for (const source of ["primary", "backup"] as const) {
    const manifest = hlsResponseHeaders.find(
      (sample) => sample.source === source && sample.kind === "manifest",
    );
    const segment = hlsResponseHeaders.find(
      (sample) => sample.source === source && sample.kind === "segment",
    );
    expect(
      manifest,
      `${source} manifest headers were not observed`,
    ).toBeDefined();
    expect(
      segment,
      `${source} segment headers were not observed`,
    ).toBeDefined();
    expect(manifest?.contentType).toContain("application/vnd.apple.mpegurl");
    expect(manifest?.fixtureOrigin).toBe(source);
    expect(manifest?.origin).toBe(sourceFingerprints[source].origin);
    expect(manifest?.cors).toBe("*");
    expect(manifest?.timingAllowOrigin).toBe("*");
    expect(manifest?.cacheControl).toMatch(/no-store|no-cache/);
    expect(segment?.contentType).toMatch(/^video\//);
    expect(segment?.fixtureOrigin).toBe(source);
    expect(segment?.origin).toBe(sourceFingerprints[source].origin);
    expect(segment?.cors).toBe("*");
    expect(segment?.timingAllowOrigin).toBe("*");
    expect(segment?.cacheControl).toMatch(/immutable/);
  }

  const primaryFailures = expectedTransportFailures.filter((failure) =>
    failure.path.includes("/live/primary/"),
  );
  const backupFailures = expectedTransportFailures.filter((failure) =>
    failure.path.includes("/live/backup/"),
  );
  expect(primaryFailures.length).toBeGreaterThan(0);
  expect(backupFailures.length).toBeGreaterThan(0);

  const evidence = {
    schemaVersion: 3,
    policy: {
      adaptiveVariantCount: 2,
      independentEncoderCount: 2,
      independentOriginCount: 2,
      maxDroppedFrameRatio: 0.01,
      maxFailoverRecoveryMs: MAX_FAILOVER_RECOVERY_MS,
      maxSourceClockSkewMs: MAX_SOURCE_CLOCK_SKEW_MS,
      maximumToleratedTransientFailures: 2,
      minimumMediaAdvanceSeconds: 2.5,
      playbackSampleMs: PLAYBACK_SAMPLE_MS,
      requireProgramDateTime: true,
      requireActualOriginProcessDeath: true,
      requireReadOnlyTransactionAuthority: true,
    },
    authoritativeDuel,
    backup,
    backupToPrimaryRecoveryMs,
    backupToPrimarySourceSelectionMs,
    expectedResourceConsoleErrors,
    expectedTransportFailures,
    hlsResponseHeaders,
    navigationMarkerPreserved: true,
    originProcessFaults,
    primaryInitial,
    primaryRecovered,
    primaryToBackupRecoveryMs,
    primaryToBackupSourceSelectionMs,
    runtimeErrors,
    sourceClockSkewMs,
    sourceContentParity,
    sourceFingerprints,
    sourceProcesses: { ...sourceProcesses, verifiedAliveAtStart: true },
    sourceTopology: HLS_SOURCE_TOPOLOGY,
    transientPrimaryRecovery,
  };
  const evidencePath = testInfo.outputPath("hls-source-failover.json");
  const screenshotPath = testInfo.outputPath("hls-source-failover.png");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    screenshotPath,
    await page.screenshot({ animations: "disabled", fullPage: true }),
    { flag: "wx", mode: 0o600 },
  );
  await testInfo.attach("hls-source-failover", {
    path: evidencePath,
    contentType: "application/json",
  });
  await testInfo.attach("hls-source-failover-screenshot", {
    path: screenshotPath,
    contentType: "image/png",
  });

  expect(runtimeErrors, JSON.stringify(evidence, null, 2)).toEqual([]);
  await page.unrouteAll({ behavior: "wait" });
  await page.close({ runBeforeUnload: false });
});
