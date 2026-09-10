import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_MANIFEST_BYTES = 512 * 1024;
const DEFAULT_INTERVAL_MS = 6_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FUTURE_PROGRAM_DATE_MS = 5_000;
const DEFAULT_MAX_RENDITION_PROGRAM_DATE_SKEW_MS = 2_500;
const MAX_HLS_VARIANTS = 8;
const MAX_VARIANT_BANDWIDTH_BPS = 100_000_000;
const MAX_VARIANT_WIDTH = 7_680;
const MAX_VARIANT_HEIGHT = 4_320;

export type StreamSource = {
  index: number;
  url: URL;
  sourceId: string;
  displayUrl: string;
};

export type MediaSnapshot = {
  mediaSequence: number;
  latestProgramDateMs: number;
  latestProgramDate: string;
  segmentIds: string[];
  latestSegmentId: string;
};

export type HlsVariant = {
  index: number;
  url: URL;
  mediaPlaylist: string;
  bandwidth: number | null;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
};

type RenditionProbeEvidence = {
  index: number;
  mediaPlaylist: string;
  bandwidth: number | null;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  delivery: ManifestDeliveryEvidence | null;
  deliveryPassedBoth: boolean;
  first: MediaSnapshot;
  second: MediaSnapshot;
  sequenceAdvanced: boolean;
  programDateAdvanced: boolean;
  programDateFresh: boolean;
  programDateLagMs: number;
  newSegmentObserved: boolean;
  ok: boolean;
};

type ManifestDeliveryEvidence = {
  contentType: string;
  contentTypeValid: boolean;
  corsAllowed: boolean;
  timingAllowed: boolean;
  cacheControlPresent: boolean;
  cacheLifetimeSeconds: number | null;
  cacheFreshnessBounded: boolean;
  ok: boolean;
};

export type StreamProbeEvidence = {
  schemaVersion: 2;
  generatedAt: string;
  ok: boolean;
  intervalMs: number;
  maxProgramDateLagMs: number;
  maxRenditionProgramDateSkewMs: number;
  minimumVariantCount: number;
  browserOrigin: string | null;
  maxManifestCacheSeconds: number | null;
  deliveryPolicyEnforced: boolean;
  sources: Array<{
    index: number;
    sourceId: string;
    source: string;
    manifestType: "media" | "master";
    rootDelivery: ManifestDeliveryEvidence | null;
    rootDeliveryPassedBoth: boolean;
    variantCount: number;
    minimumVariantCountMet: boolean;
    renditionProgramDateSkewMs: number;
    renditionsAligned: boolean;
    renditions: RenditionProbeEvidence[];
    ok: boolean;
  }>;
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "arrayBuffer" | "headers" | "ok" | "status">>;

type ProbeOptions = {
  fetchImpl?: FetchLike;
  intervalMs?: number;
  timeoutMs?: number;
  maxProgramDateLagMs: number;
  maxRenditionProgramDateSkewMs?: number;
  minimumVariantCount?: number;
  browserOrigin?: string;
  maxManifestCacheSeconds?: number;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function redactStreamUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function redactManifestReference(value: string): string {
  return value.split(/[?#]/u, 1)[0] ?? "";
}

export function parseStreamSources(raw: string): StreamSource[] {
  const entries = raw
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length < 1 || entries.length > 3) {
    throw new Error("expected one to three reviewed HLS stream sources");
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error("stream sources must be unique");
  }

  const sources = entries.map((entry, index) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`stream source ${index + 1} must be an absolute URL`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`stream source ${index + 1} must use https:`);
    }
    if (url.username || url.password) {
      throw new Error(
        `stream source ${index + 1} must not contain credentials`,
      );
    }
    if (!/\.m3u8$/iu.test(url.pathname)) {
      throw new Error(`stream source ${index + 1} must be an HLS .m3u8 URL`);
    }
    return {
      index,
      url,
      sourceId: sha256(redactStreamUrl(url)),
      displayUrl: redactStreamUrl(url),
    };
  });
  if (
    new Set(sources.map((source) => source.displayUrl)).size !== sources.length
  ) {
    throw new Error("stream sources must have unique origins and paths");
  }
  return sources;
}

function manifestLines(manifest: string): string[] {
  const normalized = manifest.replace(/^\uFEFF/u, "").trim();
  if (!normalized.startsWith("#EXTM3U")) {
    throw new Error("response is not an HLS manifest");
  }
  return normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseAttributeList(value: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/gu;
  for (const match of value.matchAll(pattern)) {
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined || attributes.has(key)) {
      throw new Error("master playlist contains invalid duplicate attributes");
    }
    attributes.set(
      key,
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue,
    );
  }
  return attributes;
}

function parseBoundedIntegerAttribute(
  attributes: Map<string, string>,
  name: string,
  maximum: number,
  required: boolean,
): number | null {
  const raw = attributes.get(name);
  if (raw === undefined && !required) return null;
  if (!raw || !/^\d+$/u.test(raw)) {
    throw new Error(`master playlist has invalid ${name}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`master playlist has out-of-range ${name}`);
  }
  return parsed;
}

function nextManifestUri(lines: string[], tagIndex: number): string {
  for (let candidate = tagIndex + 1; candidate < lines.length; candidate += 1) {
    const value = lines[candidate];
    if (value && !value.startsWith("#")) return value;
  }
  return "";
}

export function parseMasterVariants(
  manifestUrl: URL,
  manifest: string,
): HlsVariant[] | null {
  const lines = manifestLines(manifest);
  if (lines.some((line) => line.startsWith("#EXTINF:"))) return null;

  const variants: HlsVariant[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.startsWith("#EXT-X-STREAM-INF:")) continue;
    if (variants.length >= MAX_HLS_VARIANTS) {
      throw new Error(`master playlist exceeds ${MAX_HLS_VARIANTS} variants`);
    }
    const attributes = parseAttributeList(
      line.slice("#EXT-X-STREAM-INF:".length),
    );
    const bandwidth = parseBoundedIntegerAttribute(
      attributes,
      "BANDWIDTH",
      MAX_VARIANT_BANDWIDTH_BPS,
      true,
    ) as number;
    const averageBandwidth = parseBoundedIntegerAttribute(
      attributes,
      "AVERAGE-BANDWIDTH",
      MAX_VARIANT_BANDWIDTH_BPS,
      false,
    );
    const resolution = attributes.get("RESOLUTION") ?? "";
    const resolutionMatch = /^(\d+)x(\d+)$/u.exec(resolution);
    if (!resolutionMatch) {
      throw new Error("master playlist variant requires a valid RESOLUTION");
    }
    const width = Number(resolutionMatch[1]);
    const height = Number(resolutionMatch[2]);
    if (
      !Number.isSafeInteger(width) ||
      width < 1 ||
      width > MAX_VARIANT_WIDTH ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      height > MAX_VARIANT_HEIGHT
    ) {
      throw new Error("master playlist has out-of-range RESOLUTION");
    }
    const frameRateRaw = attributes.get("FRAME-RATE");
    const frameRate =
      frameRateRaw === undefined ? null : Number.parseFloat(frameRateRaw);
    if (
      frameRate !== null &&
      (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 240)
    ) {
      throw new Error("master playlist has invalid FRAME-RATE");
    }
    const value = nextManifestUri(lines, index);
    if (!value) throw new Error("master playlist variant is missing its URI");
    const resolved = new URL(value, manifestUrl);
    if (resolved.protocol !== "https:") {
      throw new Error("media playlist must use https:");
    }
    if (resolved.username || resolved.password) {
      throw new Error("media playlist must not contain credentials");
    }
    if (!/\.m3u8$/iu.test(resolved.pathname)) {
      throw new Error("media playlist must be an HLS .m3u8 URL");
    }
    variants.push({
      index: variants.length,
      url: resolved,
      mediaPlaylist: redactStreamUrl(resolved),
      bandwidth,
      averageBandwidth,
      width,
      height,
      frameRate,
    });
  }
  if (variants.length < 1) {
    throw new Error("manifest contains neither media segments nor a variant");
  }
  const mediaPlaylists = variants.map((variant) => variant.mediaPlaylist);
  if (new Set(mediaPlaylists).size !== mediaPlaylists.length) {
    throw new Error("master playlist contains duplicate media playlists");
  }
  const resolutions = variants.map(
    (variant) => `${variant.width}x${variant.height}`,
  );
  if (new Set(resolutions).size !== resolutions.length) {
    throw new Error("master playlist contains duplicate resolutions");
  }
  return variants;
}

export function resolveMediaPlaylistUrl(
  manifestUrl: URL,
  manifest: string,
): URL | null {
  return parseMasterVariants(manifestUrl, manifest)?.[0]?.url ?? null;
}

export function parseMediaSnapshot(manifest: string): MediaSnapshot {
  const lines = manifestLines(manifest);
  const mediaSequenceLine = lines.find((line) =>
    line.startsWith("#EXT-X-MEDIA-SEQUENCE:"),
  );
  if (!mediaSequenceLine) {
    throw new Error("media playlist is missing EXT-X-MEDIA-SEQUENCE");
  }
  const mediaSequence = Number.parseInt(
    mediaSequenceLine.split(":")[1] ?? "",
    10,
  );
  if (!Number.isSafeInteger(mediaSequence) || mediaSequence < 0) {
    throw new Error("media playlist has an invalid media sequence");
  }

  const programDates = lines
    .filter((line) => line.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))
    .map((line) => Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length)));
  if (
    programDates.length < 1 ||
    programDates.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("media playlist requires valid EXT-X-PROGRAM-DATE-TIME");
  }

  const segmentUris: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.startsWith("#EXTINF:")) continue;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const value = lines[candidate];
      if (!value || value.startsWith("#")) continue;
      segmentUris.push(value);
      break;
    }
  }
  if (segmentUris.length < 1) {
    throw new Error("media playlist contains no complete media segment");
  }

  const latestProgramDateMs = Math.max(...programDates);
  const segmentIds = segmentUris.map((value) =>
    sha256(redactManifestReference(value)),
  );
  return {
    mediaSequence,
    latestProgramDateMs,
    latestProgramDate: new Date(latestProgramDateMs).toISOString(),
    segmentIds,
    latestSegmentId: segmentIds.at(-1) as string,
  };
}

type DeliveryPolicyConfig = {
  browserOrigin: string;
  maxManifestCacheSeconds: number;
};

function inspectManifestDelivery(
  headers: Headers,
  policy: DeliveryPolicyConfig,
): ManifestDeliveryEvidence {
  const contentType =
    (headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  const contentTypeValid = new Set([
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
  ]).has(contentType);

  const allowOrigin = (headers.get("access-control-allow-origin") ?? "").trim();
  const corsAllowed =
    allowOrigin === "*" || allowOrigin === policy.browserOrigin;
  const timingOrigins = (headers.get("timing-allow-origin") ?? "")
    .split(/[\s,]+/u)
    .filter(Boolean);
  const timingAllowed =
    timingOrigins.includes("*") || timingOrigins.includes(policy.browserOrigin);

  const cacheControl = (headers.get("cache-control") ?? "").trim();
  const cacheDirectives = cacheControl
    .toLowerCase()
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean);
  const requiresRevalidation = cacheDirectives.some(
    (directive) => directive === "no-store" || directive === "no-cache",
  );
  const numericLifetimes = cacheDirectives.flatMap((directive) => {
    const match = /^(?:s-maxage|max-age)=(\d+)$/u.exec(directive);
    if (!match) return [];
    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) ? [parsed] : [];
  });
  const cacheLifetimeSeconds = requiresRevalidation
    ? 0
    : numericLifetimes.length > 0
      ? Math.max(...numericLifetimes)
      : null;
  const cacheControlPresent = cacheControl.length > 0;
  const cacheFreshnessBounded =
    cacheControlPresent &&
    !cacheDirectives.includes("immutable") &&
    cacheLifetimeSeconds !== null &&
    cacheLifetimeSeconds <= policy.maxManifestCacheSeconds;
  return {
    contentType,
    contentTypeValid,
    corsAllowed,
    timingAllowed,
    cacheControlPresent,
    cacheLifetimeSeconds,
    cacheFreshnessBounded,
    ok:
      contentTypeValid && corsAllowed && timingAllowed && cacheFreshnessBounded,
  };
}

async function fetchManifest(
  url: URL,
  fetchImpl: FetchLike,
  timeoutMs: number,
  deliveryPolicy: DeliveryPolicyConfig | null,
): Promise<{
  manifest: string;
  delivery: ManifestDeliveryEvidence | null;
}> {
  const response = await fetchImpl(url, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/vnd.apple.mpegurl, application/x-mpegURL" },
  });
  if (!response.ok)
    throw new Error(`manifest request returned HTTP ${response.status}`);

  const declaredLength = Number.parseInt(
    response.headers.get("content-length") ?? "0",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
    throw new Error("manifest exceeds the maximum allowed size");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("manifest exceeds the maximum allowed size");
  }
  return {
    manifest: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    delivery: deliveryPolicy
      ? inspectManifestDelivery(response.headers, deliveryPolicy)
      : null,
  };
}

type SourceObservation = {
  manifestType: "media" | "master";
  rootDelivery: ManifestDeliveryEvidence | null;
  renditions: Array<
    HlsVariant & {
      delivery: ManifestDeliveryEvidence | null;
      snapshot: MediaSnapshot;
    }
  >;
};

async function fetchSourceObservation(
  sourceUrl: URL,
  fetchImpl: FetchLike,
  timeoutMs: number,
  deliveryPolicy: DeliveryPolicyConfig | null,
): Promise<SourceObservation> {
  const initial = await fetchManifest(
    sourceUrl,
    fetchImpl,
    timeoutMs,
    deliveryPolicy,
  );
  const variants = parseMasterVariants(sourceUrl, initial.manifest);
  if (!variants) {
    return {
      manifestType: "media",
      rootDelivery: initial.delivery,
      renditions: [
        {
          index: 0,
          url: sourceUrl,
          mediaPlaylist: redactStreamUrl(sourceUrl),
          bandwidth: null,
          averageBandwidth: null,
          width: null,
          height: null,
          frameRate: null,
          delivery: initial.delivery,
          snapshot: parseMediaSnapshot(initial.manifest),
        },
      ],
    };
  }
  return {
    manifestType: "master",
    rootDelivery: initial.delivery,
    renditions: await Promise.all(
      variants.map(async (variant) => {
        const media = await fetchManifest(
          variant.url,
          fetchImpl,
          timeoutMs,
          deliveryPolicy,
        );
        return {
          ...variant,
          delivery: media.delivery,
          snapshot: parseMediaSnapshot(media.manifest),
        };
      }),
    ),
  };
}

export async function probeHlsFailoverReadiness(
  sources: StreamSource[],
  options: ProbeOptions,
): Promise<StreamProbeEvidence> {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { maxProgramDateLagMs } = options;
  const maxRenditionProgramDateSkewMs =
    options.maxRenditionProgramDateSkewMs ??
    DEFAULT_MAX_RENDITION_PROGRAM_DATE_SKEW_MS;
  const minimumVariantCount = options.minimumVariantCount ?? 1;
  const rawBrowserOrigin = options.browserOrigin?.trim() ?? "";
  const rawMaxManifestCacheSeconds = options.maxManifestCacheSeconds;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());

  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0 ||
    intervalMs > 60_000
  ) {
    throw new Error("interval must be an integer between 0 and 60000 ms");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 60_000
  ) {
    throw new Error("timeout must be an integer between 1000 and 60000 ms");
  }
  if (
    !Number.isSafeInteger(maxProgramDateLagMs) ||
    maxProgramDateLagMs < 1_000 ||
    maxProgramDateLagMs > 300_000
  ) {
    throw new Error(
      "maximum program-date lag must be an integer between 1000 and 300000 ms",
    );
  }
  if (
    !Number.isSafeInteger(maxRenditionProgramDateSkewMs) ||
    maxRenditionProgramDateSkewMs < 0 ||
    maxRenditionProgramDateSkewMs > 30_000
  ) {
    throw new Error(
      "maximum rendition program-date skew must be an integer between 0 and 30000 ms",
    );
  }
  if (
    !Number.isSafeInteger(minimumVariantCount) ||
    minimumVariantCount < 1 ||
    minimumVariantCount > MAX_HLS_VARIANTS
  ) {
    throw new Error(
      `minimum variant count must be an integer between 1 and ${MAX_HLS_VARIANTS}`,
    );
  }
  if (
    rawBrowserOrigin.length > 0 !==
    (rawMaxManifestCacheSeconds !== undefined)
  ) {
    throw new Error(
      "browser origin and maximum manifest cache seconds must be configured together",
    );
  }
  let deliveryPolicy: DeliveryPolicyConfig | null = null;
  if (rawBrowserOrigin) {
    const browserUrl = new URL(rawBrowserOrigin);
    if (
      browserUrl.protocol !== "https:" ||
      browserUrl.username ||
      browserUrl.password ||
      browserUrl.origin !== rawBrowserOrigin
    ) {
      throw new Error(
        "browser origin must be an exact credential-free https origin",
      );
    }
    if (
      !Number.isSafeInteger(rawMaxManifestCacheSeconds) ||
      (rawMaxManifestCacheSeconds as number) < 0 ||
      (rawMaxManifestCacheSeconds as number) > 60
    ) {
      throw new Error(
        "maximum manifest cache seconds must be an integer between 0 and 60",
      );
    }
    deliveryPolicy = {
      browserOrigin: browserUrl.origin,
      maxManifestCacheSeconds: rawMaxManifestCacheSeconds as number,
    };
  }

  const firstObservations = await Promise.all(
    sources.map((source) =>
      fetchSourceObservation(source.url, fetchImpl, timeoutMs, deliveryPolicy),
    ),
  );
  await wait(intervalMs);
  const secondObservations = await Promise.all(
    sources.map((source) =>
      fetchSourceObservation(source.url, fetchImpl, timeoutMs, deliveryPolicy),
    ),
  );
  const observedNowMs = now().getTime();
  const results = sources.map((source, sourceIndex) => {
    const first = firstObservations[sourceIndex];
    const second = secondObservations[sourceIndex];
    if (!first || !second || first.manifestType !== second.manifestType) {
      throw new Error(
        `stream source ${source.index + 1} changed manifest type`,
      );
    }
    if (first.renditions.length !== second.renditions.length) {
      throw new Error(
        `stream source ${source.index + 1} changed variant count`,
      );
    }
    const renditions = first.renditions.map((firstRendition, index) => {
      const secondRendition = second.renditions[index];
      if (
        !secondRendition ||
        firstRendition.mediaPlaylist !== secondRendition.mediaPlaylist ||
        firstRendition.bandwidth !== secondRendition.bandwidth ||
        firstRendition.averageBandwidth !== secondRendition.averageBandwidth ||
        firstRendition.width !== secondRendition.width ||
        firstRendition.height !== secondRendition.height ||
        firstRendition.frameRate !== secondRendition.frameRate
      ) {
        throw new Error(
          `stream source ${source.index + 1} changed rendition ${index + 1}`,
        );
      }
      const sequenceAdvanced =
        secondRendition.snapshot.mediaSequence >
        firstRendition.snapshot.mediaSequence;
      const programDateAdvanced =
        secondRendition.snapshot.latestProgramDateMs >
        firstRendition.snapshot.latestProgramDateMs;
      const programDateLagMs =
        observedNowMs - secondRendition.snapshot.latestProgramDateMs;
      const programDateFresh =
        programDateLagMs >= -MAX_FUTURE_PROGRAM_DATE_MS &&
        programDateLagMs <= maxProgramDateLagMs;
      const firstSegments = new Set(firstRendition.snapshot.segmentIds);
      const newSegmentObserved = secondRendition.snapshot.segmentIds.some(
        (segmentId) => !firstSegments.has(segmentId),
      );
      const ok =
        sequenceAdvanced &&
        programDateAdvanced &&
        programDateFresh &&
        newSegmentObserved &&
        (deliveryPolicy === null ||
          (firstRendition.delivery?.ok === true &&
            secondRendition.delivery?.ok === true));
      return {
        index,
        mediaPlaylist: firstRendition.mediaPlaylist,
        bandwidth: firstRendition.bandwidth,
        averageBandwidth: firstRendition.averageBandwidth,
        width: firstRendition.width,
        height: firstRendition.height,
        frameRate: firstRendition.frameRate,
        delivery: secondRendition.delivery,
        deliveryPassedBoth:
          deliveryPolicy === null ||
          (firstRendition.delivery?.ok === true &&
            secondRendition.delivery?.ok === true),
        first: firstRendition.snapshot,
        second: secondRendition.snapshot,
        sequenceAdvanced,
        programDateAdvanced,
        programDateFresh,
        programDateLagMs,
        newSegmentObserved,
        ok,
      };
    });
    const secondProgramDates = renditions.map(
      (rendition) => rendition.second.latestProgramDateMs,
    );
    const renditionProgramDateSkewMs =
      Math.max(...secondProgramDates) - Math.min(...secondProgramDates);
    const renditionsAligned =
      renditionProgramDateSkewMs <= maxRenditionProgramDateSkewMs;
    const minimumVariantCountMet =
      first.renditions.length >= minimumVariantCount;
    const rootDeliveryPassedBoth =
      deliveryPolicy === null ||
      (first.rootDelivery?.ok === true && second.rootDelivery?.ok === true);
    return {
      index: source.index,
      sourceId: source.sourceId,
      source: source.displayUrl,
      manifestType: first.manifestType,
      rootDelivery: second.rootDelivery,
      rootDeliveryPassedBoth,
      variantCount: first.renditions.length,
      minimumVariantCountMet,
      renditionProgramDateSkewMs,
      renditionsAligned,
      renditions,
      ok:
        rootDeliveryPassedBoth &&
        minimumVariantCountMet &&
        renditionsAligned &&
        renditions.every((rendition) => rendition.ok),
    };
  });

  return {
    schemaVersion: 2,
    generatedAt: now().toISOString(),
    ok: results.every((result) => result.ok),
    intervalMs,
    maxProgramDateLagMs,
    maxRenditionProgramDateSkewMs,
    minimumVariantCount,
    browserOrigin: deliveryPolicy?.browserOrigin ?? null,
    maxManifestCacheSeconds: deliveryPolicy?.maxManifestCacheSeconds ?? null,
    deliveryPolicyEnforced: deliveryPolicy !== null,
    sources: results,
  };
}

function parsePositiveIntegerArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}

function parseRequiredIntegerArg(name: string): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) throw new Error(`missing required --${name}=<integer>`);
  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}

function parseRequiredStringArg(name: string): string {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) throw new Error(`missing required --${name}=<value>`);
  const value = raw.slice(name.length + 3).trim();
  if (!value) throw new Error(`${name} must not be empty`);
  return value;
}

function sanitizeError(error: unknown, sources: StreamSource[]): string {
  let message =
    error instanceof Error ? error.message : "unknown stream probe failure";
  for (const source of sources) {
    message = message.replaceAll(source.url.href, source.displayUrl);
  }
  return message.replaceAll(/https:\/\/[^\s"']+/giu, (value) => {
    try {
      return redactStreamUrl(new URL(value));
    } catch {
      return "[redacted-url]";
    }
  });
}

export function writeEvidence(
  outputPath: string,
  evidence: StreamProbeEvidence,
): void {
  const absolutePath = path.resolve(outputPath);
  writeFileSync(absolutePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(absolutePath, 0o600);
  console.log(`wrote HLS failover evidence: ${absolutePath}`);
}

async function main(): Promise<void> {
  const rawSources =
    process.env.HYPERBET_SOLANA_STREAM_SOURCES?.trim() ||
    process.env.VITE_STREAM_SOURCES?.trim() ||
    "";
  let sources: StreamSource[] = [];
  try {
    sources = parseStreamSources(rawSources);
    const evidence = await probeHlsFailoverReadiness(sources, {
      intervalMs: parsePositiveIntegerArg("interval-ms", DEFAULT_INTERVAL_MS),
      timeoutMs: parsePositiveIntegerArg("timeout-ms", DEFAULT_TIMEOUT_MS),
      maxProgramDateLagMs: parseRequiredIntegerArg("max-program-date-lag-ms"),
      maxRenditionProgramDateSkewMs: parseRequiredIntegerArg(
        "max-rendition-program-date-skew-ms",
      ),
      minimumVariantCount: parseRequiredIntegerArg("minimum-variant-count"),
      browserOrigin: parseRequiredStringArg("browser-origin"),
      maxManifestCacheSeconds: parseRequiredIntegerArg(
        "max-manifest-cache-seconds",
      ),
    });
    const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
    if (outputArg) {
      writeEvidence(outputArg.slice("--output=".length), evidence);
    } else {
      console.log(JSON.stringify(evidence, null, 2));
    }
    if (!evidence.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      `HLS failover readiness failed: ${sanitizeError(error, sources)}`,
    );
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) await main();
