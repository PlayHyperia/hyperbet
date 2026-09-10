import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

export type BundleFile = {
  content: Buffer;
  relativePath: string;
};

type ChunkBudget = {
  gzipBytes: number;
  rawBytes: number;
};

export type BundleBudgets = {
  deferredChart: ChunkBudget;
  mainEntry: ChunkBudget;
  solanaMarket: ChunkBudget;
  staticRasterBytes: number;
  streamPlayer: ChunkBudget;
  totalBytes: number;
};

export const SOLANA_APP_BUNDLE_BUDGETS: BundleBudgets = {
  deferredChart: { rawBytes: 375_000, gzipBytes: 110_000 },
  mainEntry: { rawBytes: 900_000, gzipBytes: 270_000 },
  solanaMarket: { rawBytes: 340_000, gzipBytes: 90_000 },
  staticRasterBytes: 350_000,
  streamPlayer: { rawBytes: 800_000, gzipBytes: 250_000 },
  totalBytes: 3_800_000,
};

type ChunkMeasurement = {
  gzipBytes: number;
  rawBytes: number;
  relativePath: string;
};

export type BundleBudgetReport = {
  deferredChart: ChunkMeasurement;
  mainEntry: ChunkMeasurement;
  solanaMarket: ChunkMeasurement;
  streamPlayer: ChunkMeasurement;
  totalBytes: number;
  transactionWallet: ChunkMeasurement;
};

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} B`;
}

function measure(file: BundleFile): ChunkMeasurement {
  return {
    gzipBytes: gzipSync(file.content, { level: 9 }).byteLength,
    rawBytes: file.content.byteLength,
    relativePath: file.relativePath,
  };
}

function requireSingleFile(
  files: readonly BundleFile[],
  label: string,
  matcher: (relativePath: string) => boolean,
): BundleFile {
  const matches = files.filter((file) => matcher(file.relativePath));
  if (matches.length !== 1) {
    throw new Error(
      `[bundle-budget] expected exactly one ${label}; found ${matches.length}`,
    );
  }
  return matches[0];
}

function findMainEntry(files: readonly BundleFile[]): BundleFile {
  const index = requireSingleFile(
    files,
    "index.html",
    (relativePath) => relativePath === "index.html",
  );
  const html = index.content.toString("utf8");
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
  const entrySources = scriptTags.flatMap((tag) => {
    if (!/\btype=["']module["']/i.test(tag)) return [];
    const source = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    return source ? [source] : [];
  });
  if (entrySources.length !== 1) {
    throw new Error(
      `[bundle-budget] expected exactly one module entry in index.html; found ${entrySources.length}`,
    );
  }

  const normalizedSource = entrySources[0]
    .replace(/[?#].*$/, "")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
  return requireSingleFile(
    files,
    "compiled main entry",
    (relativePath) => relativePath === normalizedSource,
  );
}

function assertChunkBudget(
  label: string,
  measurement: ChunkMeasurement,
  budget: ChunkBudget,
  errors: string[],
): void {
  if (measurement.rawBytes > budget.rawBytes) {
    errors.push(
      `${label} ${measurement.relativePath} is ${formatBytes(measurement.rawBytes)} raw; limit ${formatBytes(budget.rawBytes)}`,
    );
  }
  if (measurement.gzipBytes > budget.gzipBytes) {
    errors.push(
      `${label} ${measurement.relativePath} is ${formatBytes(measurement.gzipBytes)} gzip; limit ${formatBytes(budget.gzipBytes)}`,
    );
  }
}

export function evaluateBundleFiles(
  files: readonly BundleFile[],
  budgets: BundleBudgets = SOLANA_APP_BUNDLE_BUDGETS,
): BundleBudgetReport {
  const normalizedFiles = files.map((file) => ({
    ...file,
    relativePath: file.relativePath.split(path.sep).join("/"),
  }));
  const sourceMaps = normalizedFiles.filter((file) =>
    file.relativePath.endsWith(".map"),
  );
  if (sourceMaps.length > 0) {
    throw new Error(
      `[bundle-budget] production output contains ${sourceMaps.length} source map(s)`,
    );
  }

  const mainEntry = measure(findMainEntry(normalizedFiles));
  const streamPlayer = measure(
    requireSingleFile(
      normalizedFiles,
      "deferred stream-player chunk",
      (relativePath) => /^assets\/StreamPlayer-[^/]+\.js$/.test(relativePath),
    ),
  );
  const solanaMarket = measure(
    requireSingleFile(
      normalizedFiles,
      "deferred SOL market chunk",
      (relativePath) =>
        /^assets\/SolanaClobPanel-[^/]+\.js$/.test(relativePath),
    ),
  );
  const deferredChart = measure(
    requireSingleFile(
      normalizedFiles,
      "deferred chart dependency chunk",
      (relativePath) => /^assets\/LineChart-[^/]+\.js$/.test(relativePath),
    ),
  );
  const transactionWallet = measure(
    requireSingleFile(
      normalizedFiles,
      "deferred transaction-wallet chunk",
      (relativePath) =>
        /^assets\/TransactionWalletRoot-[^/]+\.js$/.test(relativePath),
    ),
  );
  const totalBytes = normalizedFiles.reduce(
    (total, file) => total + file.content.byteLength,
    0,
  );
  const errors: string[] = [];

  if (totalBytes > budgets.totalBytes) {
    errors.push(
      `total output is ${formatBytes(totalBytes)}; limit ${formatBytes(budgets.totalBytes)}`,
    );
  }
  for (const file of normalizedFiles) {
    if (!/\.(?:avif|jpe?g|png|webp)$/i.test(file.relativePath)) continue;
    if (file.content.byteLength > budgets.staticRasterBytes) {
      errors.push(
        `static raster ${file.relativePath} is ${formatBytes(file.content.byteLength)}; per-file limit ${formatBytes(budgets.staticRasterBytes)}`,
      );
    }
  }
  assertChunkBudget("main entry", mainEntry, budgets.mainEntry, errors);
  assertChunkBudget(
    "stream player",
    streamPlayer,
    budgets.streamPlayer,
    errors,
  );
  assertChunkBudget("SOL market", solanaMarket, budgets.solanaMarket, errors);
  assertChunkBudget(
    "deferred chart",
    deferredChart,
    budgets.deferredChart,
    errors,
  );

  if (errors.length > 0) {
    throw new Error(`[bundle-budget] ${errors.join("\n[bundle-budget] ")}`);
  }

  return {
    deferredChart,
    mainEntry,
    solanaMarket,
    streamPlayer,
    totalBytes,
    transactionWallet,
  };
}

function readBundleDirectory(root: string, current = root): BundleFile[] {
  const files: BundleFile[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...readBundleDirectory(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      content: fs.readFileSync(absolutePath),
      relativePath: path.relative(root, absolutePath),
    });
  }
  return files;
}

export function verifyBundleDirectory(root: string): BundleBudgetReport {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`[bundle-budget] output directory does not exist: ${root}`);
  }
  return evaluateBundleFiles(readBundleDirectory(root));
}

export function formatBundleBudgetReport(report: BundleBudgetReport): string {
  const chunk = (measurement: ChunkMeasurement) =>
    `${formatBytes(measurement.rawBytes)} / ${formatBytes(measurement.gzipBytes)} gzip`;
  return [
    `[bundle-budget] passed: total ${formatBytes(report.totalBytes)}`,
    `main ${chunk(report.mainEntry)}`,
    `stream ${chunk(report.streamPlayer)}`,
    `market ${chunk(report.solanaMarket)}`,
    `chart ${chunk(report.deferredChart)}`,
    `wallet deferred ${chunk(report.transactionWallet)}`,
  ].join("; ");
}
