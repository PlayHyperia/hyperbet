import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parseMediaSnapshot,
  parseMasterVariants,
  parseStreamSources,
  probeHlsFailoverReadiness,
  redactStreamUrl,
  resolveMediaPlaylistUrl,
  writeEvidence,
} from "./verify-hls-failover-readiness";

function media(sequence: number, date: string, segment: string): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
    `#EXT-X-PROGRAM-DATE-TIME:${date}`,
    "#EXTINF:2.000,",
    segment,
  ].join("\n");
}

test("validates and redacts reviewed stream sources", () => {
  const [source] = parseStreamSources(
    "https://user.invalid/live.m3u8?Policy=private-token",
  );
  assert.equal(source?.displayUrl, "https://user.invalid/live.m3u8");
  assert.equal(source?.sourceId.length, 64);
  assert.equal(
    redactStreamUrl(new URL("https://cdn.invalid/path/live.m3u8?secret=yes")),
    "https://cdn.invalid/path/live.m3u8",
  );

  for (const invalid of [
    "",
    "http://user.invalid/live.m3u8",
    "https://name:secret@user.invalid/live.m3u8",
    "https://user.invalid/channel",
    "https://user.invalid/a.m3u8,https://user.invalid/a.m3u8",
    "https://user.invalid/a.m3u8?token=one,https://user.invalid/a.m3u8?token=two",
    "https://a.invalid/a.m3u8,https://b.invalid/b.m3u8,https://c.invalid/c.m3u8,https://d.invalid/d.m3u8",
  ]) {
    assert.throws(() => parseStreamSources(invalid));
  }
});

test("parses timestamped media and resolves an HTTPS master variant", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,FRAME-RATE=30,CODECS="avc1.42e01e,mp4a.40.2"',
    "video/low.m3u8?token=private",
  ].join("\n");
  assert.deepEqual(
    parseMasterVariants(
      new URL("https://cdn.invalid/master/live.m3u8?token=private"),
      master,
    )?.map(({ url: _url, ...variant }) => variant),
    [
      {
        index: 0,
        mediaPlaylist: "https://cdn.invalid/master/video/low.m3u8",
        bandwidth: 800000,
        averageBandwidth: 700000,
        width: 640,
        height: 360,
        frameRate: 30,
      },
    ],
  );
  assert.equal(
    resolveMediaPlaylistUrl(
      new URL("https://cdn.invalid/master/live.m3u8?token=private"),
      master,
    )?.href,
    "https://cdn.invalid/master/video/low.m3u8?token=private",
  );
  const snapshot = parseMediaSnapshot(
    media(8, "2026-08-14T12:00:00.000Z", "segment-private.ts?token=secret"),
  );
  assert.equal(snapshot.mediaSequence, 8);
  assert.equal(snapshot.latestProgramDate, "2026-08-14T12:00:00.000Z");
  assert.equal(snapshot.latestSegmentId.length, 64);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret/u);
});

test("rejects malformed, duplicate, unsafe, and excessive master variants", () => {
  const masterUrl = new URL("https://cdn.invalid/live/master.m3u8");
  for (const invalid of [
    ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=800000", "low.m3u8"],
    ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=0,RESOLUTION=640x360", "low.m3u8"],
    [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "http://cdn.invalid/low.m3u8",
    ],
    [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "low.m3u8?token=one",
      "#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720",
      "low.m3u8?token=two",
    ],
    [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "low.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360",
      "high.m3u8",
    ],
    [
      "#EXTM3U",
      ...Array.from({ length: 9 }, (_, index) => [
        `#EXT-X-STREAM-INF:BANDWIDTH=${800000 + index},RESOLUTION=${640 + index}x${360 + index}`,
        `v${index}.m3u8`,
      ]).flat(),
    ],
  ]) {
    assert.throws(() => parseMasterVariants(masterUrl, invalid.join("\n")));
  }
});

test("proves every source advances without retaining signed URLs", async () => {
  const sources = parseStreamSources(
    "https://one.invalid/live.m3u8?token=one,https://two.invalid/live.m3u8?token=two",
  );
  const calls = new Map<string, number>();
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    const key = url.hostname;
    const call = (calls.get(key) ?? 0) + 1;
    calls.set(key, call);
    const sequence = call === 1 ? 40 : 41;
    return new Response(
      media(
        sequence,
        `2026-08-14T12:00:${call === 1 ? "00" : "02"}.000Z`,
        `segment-${sequence}.ts?token=${key}`,
      ),
      { status: 200 },
    );
  };

  const evidence = await probeHlsFailoverReadiness(sources, {
    fetchImpl,
    intervalMs: 0,
    timeoutMs: 1_000,
    maxProgramDateLagMs: 60_000,
    wait: async () => {},
    now: () => new Date("2026-08-14T12:01:00.000Z"),
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.sources.length, 2);
  assert.ok(
    evidence.sources.every(
      (source) =>
        source.ok &&
        source.variantCount === 1 &&
        source.renditionsAligned &&
        source.renditions[0]?.sequenceAdvanced &&
        source.renditions[0]?.programDateAdvanced &&
        source.renditions[0]?.newSegmentObserved,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /token=|one.invalid\/live.*\?/u,
  );
});

test("proves every master rendition and tolerates rotated query credentials", async () => {
  const sources = parseStreamSources(
    "https://master.invalid/live.m3u8?token=master",
  );
  let masterCalls = 0;
  const mediaCalls = new Map<string, number>();
  const evidence = await probeHlsFailoverReadiness(sources, {
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/live.m3u8") {
        masterCalls += 1;
        return new Response(
          [
            "#EXTM3U",
            "#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,FRAME-RATE=30",
            `low.m3u8?token=rotated-${masterCalls}`,
            "#EXT-X-STREAM-INF:BANDWIDTH=4800000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1280x720,FRAME-RATE=30",
            `high.m3u8?token=rotated-${masterCalls}`,
          ].join("\n"),
          { status: 200 },
        );
      }
      const mediaCall = (mediaCalls.get(url.pathname) ?? 0) + 1;
      mediaCalls.set(url.pathname, mediaCall);
      return new Response(
        media(
          70 + mediaCall,
          `2026-08-14T12:00:${mediaCall === 1 ? "10" : "12"}.000Z`,
          `${url.pathname}-segment-${70 + mediaCall}.ts?token=rotated-${mediaCall}`,
        ),
        { status: 200 },
      );
    },
    intervalMs: 0,
    timeoutMs: 1_000,
    maxProgramDateLagMs: 60_000,
    maxRenditionProgramDateSkewMs: 0,
    minimumVariantCount: 2,
    wait: async () => {},
    now: () => new Date("2026-08-14T12:00:13.000Z"),
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.sources[0]?.manifestType, "master");
  assert.equal(evidence.sources[0]?.variantCount, 2);
  assert.equal(evidence.sources[0]?.renditions.length, 2);
  assert.deepEqual(
    evidence.sources[0]?.renditions.map((rendition) => ({
      mediaPlaylist: rendition.mediaPlaylist,
      resolution: `${rendition.width}x${rendition.height}`,
      ok: rendition.ok,
    })),
    [
      {
        mediaPlaylist: "https://master.invalid/low.m3u8",
        resolution: "640x360",
        ok: true,
      },
      {
        mediaPlaylist: "https://master.invalid/high.m3u8",
        resolution: "1280x720",
        ok: true,
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(evidence), /rotated|token=/u);
});

test("fails a master when any advertised rendition is stagnant", async () => {
  const calls = new Map<string, number>();
  const evidence = await probeHlsFailoverReadiness(
    parseStreamSources("https://master.invalid/live.m3u8"),
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/live.m3u8") {
          return new Response(
            [
              "#EXTM3U",
              "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
              "low.m3u8",
              "#EXT-X-STREAM-INF:BANDWIDTH=4800000,RESOLUTION=1280x720",
              "high.m3u8",
            ].join("\n"),
            { status: 200 },
          );
        }
        const call = (calls.get(url.pathname) ?? 0) + 1;
        calls.set(url.pathname, call);
        const advances = url.pathname === "/low.m3u8";
        const sequence = advances ? 30 + call : 80;
        const seconds = advances && call === 2 ? "12" : "10";
        return new Response(
          media(
            sequence,
            `2026-08-14T12:00:${seconds}.000Z`,
            `${url.pathname}-${sequence}.ts`,
          ),
          { status: 200 },
        );
      },
      intervalMs: 0,
      timeoutMs: 1_000,
      maxProgramDateLagMs: 60_000,
      maxRenditionProgramDateSkewMs: 2_500,
      minimumVariantCount: 2,
      wait: async () => {},
      now: () => new Date("2026-08-14T12:00:13.000Z"),
    },
  );
  assert.equal(evidence.ok, false);
  assert.equal(evidence.sources[0]?.renditions[0]?.ok, true);
  assert.equal(evidence.sources[0]?.renditions[1]?.ok, false);
});

test("fails advancing renditions whose program-date edges are misaligned", async () => {
  const calls = new Map<string, number>();
  const evidence = await probeHlsFailoverReadiness(
    parseStreamSources("https://master.invalid/live.m3u8"),
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/live.m3u8") {
          return new Response(
            [
              "#EXTM3U",
              "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
              "low.m3u8",
              "#EXT-X-STREAM-INF:BANDWIDTH=4800000,RESOLUTION=1280x720",
              "high.m3u8",
            ].join("\n"),
            { status: 200 },
          );
        }
        const call = (calls.get(url.pathname) ?? 0) + 1;
        calls.set(url.pathname, call);
        const baseSeconds = url.pathname === "/low.m3u8" ? 10 : 6;
        const seconds = baseSeconds + (call - 1) * 2;
        return new Response(
          media(
            50 + call,
            `2026-08-14T12:00:${String(seconds).padStart(2, "0")}.000Z`,
            `${url.pathname}-${call}.ts`,
          ),
          { status: 200 },
        );
      },
      intervalMs: 0,
      timeoutMs: 1_000,
      maxProgramDateLagMs: 60_000,
      maxRenditionProgramDateSkewMs: 1_000,
      minimumVariantCount: 2,
      wait: async () => {},
      now: () => new Date("2026-08-14T12:00:13.000Z"),
    },
  );
  assert.equal(
    evidence.sources[0]?.renditions.every((item) => item.ok),
    true,
  );
  assert.equal(evidence.sources[0]?.renditionProgramDateSkewMs, 4_000);
  assert.equal(evidence.sources[0]?.renditionsAligned, false);
  assert.equal(evidence.ok, false);
});

test("enforces the approved minimum rendition count", async () => {
  let call = 0;
  const evidence = await probeHlsFailoverReadiness(
    parseStreamSources("https://stream.invalid/live.m3u8"),
    {
      fetchImpl: async () => {
        call += 1;
        return new Response(
          media(
            90 + call,
            `2026-08-14T12:00:${call === 1 ? "10" : "12"}.000Z`,
            `segment-${call}.ts`,
          ),
          { status: 200 },
        );
      },
      intervalMs: 0,
      timeoutMs: 1_000,
      maxProgramDateLagMs: 60_000,
      minimumVariantCount: 2,
      wait: async () => {},
      now: () => new Date("2026-08-14T12:00:13.000Z"),
    },
  );
  assert.equal(evidence.sources[0]?.minimumVariantCountMet, false);
  assert.equal(evidence.ok, false);
});

test("enforces browser delivery and bounded live-manifest cache headers", async () => {
  const goodHeaders = {
    "access-control-allow-origin": "https://app.invalid",
    "cache-control": "public, max-age=2, must-revalidate",
    "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
    "timing-allow-origin": "https://app.invalid",
  };
  const run = async (headers: HeadersInit) => {
    let call = 0;
    return probeHlsFailoverReadiness(
      parseStreamSources("https://stream.invalid/live.m3u8"),
      {
        fetchImpl: async () => {
          call += 1;
          return new Response(
            media(
              100 + call,
              `2026-08-14T12:00:${call === 1 ? "10" : "12"}.000Z`,
              `segment-${call}.ts`,
            ),
            { headers, status: 200 },
          );
        },
        intervalMs: 0,
        timeoutMs: 1_000,
        maxProgramDateLagMs: 60_000,
        browserOrigin: "https://app.invalid",
        maxManifestCacheSeconds: 2,
        wait: async () => {},
        now: () => new Date("2026-08-14T12:00:13.000Z"),
      },
    );
  };

  const accepted = await run(goodHeaders);
  assert.equal(accepted.deliveryPolicyEnforced, true);
  assert.equal(accepted.sources[0]?.rootDeliveryPassedBoth, true);
  assert.equal(accepted.sources[0]?.rootDelivery?.cacheLifetimeSeconds, 2);
  assert.equal(accepted.sources[0]?.renditions[0]?.deliveryPassedBoth, true);
  assert.equal(accepted.ok, true);

  for (const headers of [
    { ...goodHeaders, "content-type": "text/plain" },
    { ...goodHeaders, "access-control-allow-origin": "https://other.invalid" },
    { ...goodHeaders, "timing-allow-origin": "" },
    { ...goodHeaders, "cache-control": "public, max-age=3" },
    { ...goodHeaders, "cache-control": "public, max-age=1, immutable" },
  ]) {
    const rejected = await run(headers);
    assert.equal(rejected.sources[0]?.rootDeliveryPassedBoth, false);
    assert.equal(rejected.ok, false);
  }

  await assert.rejects(() =>
    probeHlsFailoverReadiness(
      parseStreamSources("https://stream.invalid/live.m3u8"),
      {
        fetchImpl: async () => new Response("", { status: 200 }),
        maxProgramDateLagMs: 60_000,
        browserOrigin: "https://app.invalid/path",
        maxManifestCacheSeconds: 2,
      },
    ),
  );
});

test("fails when one master rendition violates browser delivery policy", async () => {
  const calls = new Map<string, number>();
  const goodHeaders = {
    "access-control-allow-origin": "*",
    "cache-control": "no-cache",
    "content-type": "application/vnd.apple.mpegurl",
    "timing-allow-origin": "*",
  };
  const evidence = await probeHlsFailoverReadiness(
    parseStreamSources("https://master.invalid/live.m3u8"),
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/live.m3u8") {
          return new Response(
            [
              "#EXTM3U",
              "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
              "low.m3u8",
              "#EXT-X-STREAM-INF:BANDWIDTH=4800000,RESOLUTION=1280x720",
              "high.m3u8",
            ].join("\n"),
            { headers: goodHeaders, status: 200 },
          );
        }
        const call = (calls.get(url.pathname) ?? 0) + 1;
        calls.set(url.pathname, call);
        return new Response(
          media(
            120 + call,
            `2026-08-14T12:00:${call === 1 ? "10" : "12"}.000Z`,
            `${url.pathname}-${call}.ts`,
          ),
          {
            headers:
              url.pathname === "/high.m3u8"
                ? { ...goodHeaders, "timing-allow-origin": "" }
                : goodHeaders,
            status: 200,
          },
        );
      },
      intervalMs: 0,
      timeoutMs: 1_000,
      maxProgramDateLagMs: 60_000,
      maxRenditionProgramDateSkewMs: 0,
      minimumVariantCount: 2,
      browserOrigin: "https://app.invalid",
      maxManifestCacheSeconds: 2,
      wait: async () => {},
      now: () => new Date("2026-08-14T12:00:13.000Z"),
    },
  );
  assert.equal(evidence.sources[0]?.rootDeliveryPassedBoth, true);
  assert.equal(evidence.sources[0]?.renditions[0]?.deliveryPassedBoth, true);
  assert.equal(evidence.sources[0]?.renditions[1]?.deliveryPassedBoth, false);
  assert.equal(evidence.ok, false);
});

test("fails readiness when a timestamped playlist is stagnant", async () => {
  const sources = parseStreamSources("https://stream.invalid/live.m3u8");
  const frozen = media(50, "2026-08-14T12:00:00.000Z", "segment-50.ts");
  const evidence = await probeHlsFailoverReadiness(sources, {
    fetchImpl: async () => new Response(frozen, { status: 200 }),
    intervalMs: 0,
    timeoutMs: 1_000,
    maxProgramDateLagMs: 60_000,
    wait: async () => {},
    now: () => new Date("2026-08-14T12:00:10.000Z"),
  });
  assert.equal(evidence.ok, false);
  const rendition = evidence.sources[0]?.renditions[0];
  assert.deepEqual(
    {
      sequenceAdvanced: rendition?.sequenceAdvanced,
      programDateAdvanced: rendition?.programDateAdvanced,
      newSegmentObserved: rendition?.newSegmentObserved,
    },
    {
      sequenceAdvanced: false,
      programDateAdvanced: false,
      newSegmentObserved: false,
    },
  );
});

test("rejects an advancing stream whose program date is stale or implausibly future", async () => {
  for (const dates of [
    ["2026-08-14T10:00:00.000Z", "2026-08-14T10:00:02.000Z"],
    ["2026-08-14T12:01:00.000Z", "2026-08-14T12:01:02.000Z"],
  ]) {
    let call = 0;
    const evidence = await probeHlsFailoverReadiness(
      parseStreamSources("https://stream.invalid/live.m3u8"),
      {
        fetchImpl: async () => {
          const index = call;
          call += 1;
          return new Response(
            media(90 + index, dates[index] as string, `segment-${index}.ts`),
            { status: 200 },
          );
        },
        intervalMs: 0,
        timeoutMs: 1_000,
        maxProgramDateLagMs: 60_000,
        wait: async () => {},
        now: () => new Date("2026-08-14T12:00:00.000Z"),
      },
    );
    const rendition = evidence.sources[0]?.renditions[0];
    assert.equal(rendition?.sequenceAdvanced, true);
    assert.equal(rendition?.programDateAdvanced, true);
    assert.equal(rendition?.newSegmentObserved, true);
    assert.equal(rendition?.programDateFresh, false);
    assert.equal(evidence.ok, false);
  }
});

test("writes private evidence exactly once", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperbet-hls-evidence-"));
  const outputPath = path.join(directory, "evidence.json");
  try {
    writeEvidence(outputPath, {
      schemaVersion: 2,
      generatedAt: "2026-08-14T12:00:00.000Z",
      ok: true,
      intervalMs: 6_000,
      maxProgramDateLagMs: 30_000,
      maxRenditionProgramDateSkewMs: 2_500,
      minimumVariantCount: 2,
      browserOrigin: null,
      maxManifestCacheSeconds: null,
      deliveryPolicyEnforced: false,
      sources: [],
    });
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).ok, true);
    assert.throws(
      () =>
        writeEvidence(outputPath, {
          schemaVersion: 2,
          generatedAt: "2026-08-14T12:01:00.000Z",
          ok: false,
          intervalMs: 6_000,
          maxProgramDateLagMs: 30_000,
          maxRenditionProgramDateSkewMs: 2_500,
          minimumVariantCount: 2,
          browserOrigin: null,
          maxManifestCacheSeconds: null,
          deliveryPolicyEnforced: false,
          sources: [],
        }),
      /EEXIST/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
