import { describe, expect, test } from "bun:test";

import {
  SOLANA_APP_BUNDLE_BUDGETS,
  evaluateBundleFiles,
  type BundleBudgets,
  type BundleFile,
} from "../../build/bundleBudget";

function fixtureFiles(main = Buffer.from("main")): BundleFile[] {
  return [
    {
      relativePath: "index.html",
      content: Buffer.from(
        '<script type="module" crossorigin src="/assets/index-fixture.js"></script>',
      ),
    },
    { relativePath: "assets/index-fixture.js", content: main },
    {
      relativePath: "assets/StreamPlayer-a.js",
      content: Buffer.from("stream"),
    },
    {
      relativePath: "assets/SolanaClobPanel-a.js",
      content: Buffer.from("market"),
    },
    { relativePath: "assets/LineChart-a.js", content: Buffer.from("chart") },
    {
      relativePath: "assets/TransactionWalletRoot-a.js",
      content: Buffer.from("wallet"),
    },
  ];
}

function tinyBudgets(overrides: Partial<BundleBudgets> = {}): BundleBudgets {
  return {
    deferredChart: { rawBytes: 100, gzipBytes: 100 },
    mainEntry: { rawBytes: 100, gzipBytes: 100 },
    solanaMarket: { rawBytes: 100, gzipBytes: 100 },
    staticRasterBytes: 100,
    streamPlayer: { rawBytes: 100, gzipBytes: 100 },
    totalBytes: 1_000,
    ...overrides,
  };
}

describe("production bundle budget", () => {
  test("pins the approved interim launch ceilings", () => {
    expect(SOLANA_APP_BUNDLE_BUDGETS).toEqual({
      deferredChart: { rawBytes: 375_000, gzipBytes: 110_000 },
      mainEntry: { rawBytes: 900_000, gzipBytes: 270_000 },
      solanaMarket: { rawBytes: 340_000, gzipBytes: 90_000 },
      staticRasterBytes: 350_000,
      streamPlayer: { rawBytes: 800_000, gzipBytes: 250_000 },
      totalBytes: 3_800_000,
    });
  });

  test("measures the HTML-selected entry and every required deferred chunk", () => {
    const report = evaluateBundleFiles(fixtureFiles(), tinyBudgets());
    expect(report.mainEntry.relativePath).toBe("assets/index-fixture.js");
    expect(report.streamPlayer.relativePath).toBe("assets/StreamPlayer-a.js");
    expect(report.solanaMarket.relativePath).toBe(
      "assets/SolanaClobPanel-a.js",
    );
    expect(report.deferredChart.relativePath).toBe("assets/LineChart-a.js");
    expect(report.transactionWallet.relativePath).toBe(
      "assets/TransactionWalletRoot-a.js",
    );
  });

  test("fails when the main entry exceeds its raw ceiling", () => {
    expect(() =>
      evaluateBundleFiles(fixtureFiles(Buffer.alloc(101, 1)), tinyBudgets()),
    ).toThrow("main entry assets/index-fixture.js is 101 B raw; limit 100 B");
  });

  test("fails when a required lazy boundary disappears", () => {
    expect(() =>
      evaluateBundleFiles(
        fixtureFiles().filter(
          (file) => !file.relativePath.includes("StreamPlayer"),
        ),
        tinyBudgets(),
      ),
    ).toThrow("expected exactly one deferred stream-player chunk; found 0");
  });

  test("rejects production source maps and oversized static rasters", () => {
    expect(() =>
      evaluateBundleFiles(
        [
          ...fixtureFiles(),
          { relativePath: "assets/index.js.map", content: Buffer.from("map") },
        ],
        tinyBudgets(),
      ),
    ).toThrow("production output contains 1 source map(s)");

    expect(() =>
      evaluateBundleFiles(
        [
          ...fixtureFiles(),
          { relativePath: "assets/loader.avif", content: Buffer.alloc(101) },
        ],
        tinyBudgets(),
      ),
    ).toThrow(
      "static raster assets/loader.avif is 101 B; per-file limit 100 B",
    );
  });
});
