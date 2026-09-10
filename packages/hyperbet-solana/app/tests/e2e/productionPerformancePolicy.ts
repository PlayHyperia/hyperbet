export interface ProductionBrowserPerformanceMetrics {
  lcpObserverSupported: boolean;
  longTaskObserverSupported: boolean;
  lcpMs: number;
  firstDecodedFrameMs: number;
  maxInteractionMs: number;
  presentedFps: number;
  qualityPresentedFps: number;
  droppedFrameRatio: number;
  jsHeapUsedBytes: number;
  maxLongTaskMs: number;
  totalLongTaskMs: number;
  taskUtilization: number;
  scriptUtilization: number;
  layoutUtilization: number;
  horizontalOverflowPx: number;
  nonMediaTransferredBytes: number;
  mediaTransferredBytes: number;
}

export const PRODUCTION_BROWSER_PERFORMANCE_BUDGET = Object.freeze({
  lcpMs: 4_000,
  firstDecodedFrameMs: 8_000,
  maxInteractionMs: 350,
  minimumPresentedFps: 24,
  maximumDroppedFrameRatio: 0.01,
  jsHeapUsedBytes: 192 * 1024 * 1024,
  maxLongTaskMs: 250,
  totalLongTaskMs: 1_500,
  taskUtilization: 0.8,
  scriptUtilization: 0.5,
  layoutUtilization: 0.25,
  horizontalOverflowPx: 0,
  nonMediaTransferredBytes: 2 * 1024 * 1024,
  mediaTransferredBytes: 10 * 1024 * 1024,
});

function boundedMetric(
  failures: string[],
  name: keyof ProductionBrowserPerformanceMetrics,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    failures.push(`${name}=${value} must be within ${minimum}..${maximum}`);
  }
}

export function evaluateProductionBrowserPerformance(
  metrics: ProductionBrowserPerformanceMetrics,
): string[] {
  const failures: string[] = [];
  if (!metrics.lcpObserverSupported) {
    failures.push("largest-contentful-paint observer is unavailable");
  }
  if (!metrics.longTaskObserverSupported) {
    failures.push("longtask observer is unavailable");
  }
  boundedMetric(
    failures,
    "lcpMs",
    metrics.lcpMs,
    Number.EPSILON,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.lcpMs,
  );
  boundedMetric(
    failures,
    "firstDecodedFrameMs",
    metrics.firstDecodedFrameMs,
    Number.EPSILON,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.firstDecodedFrameMs,
  );
  boundedMetric(
    failures,
    "maxInteractionMs",
    metrics.maxInteractionMs,
    Number.EPSILON,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.maxInteractionMs,
  );
  if (
    !Number.isFinite(metrics.presentedFps) ||
    metrics.presentedFps <
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps
  ) {
    failures.push(
      `presentedFps=${metrics.presentedFps} is below ${PRODUCTION_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps}`,
    );
  }
  if (
    !Number.isFinite(metrics.qualityPresentedFps) ||
    metrics.qualityPresentedFps <
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps
  ) {
    failures.push(
      `qualityPresentedFps=${metrics.qualityPresentedFps} is below ${PRODUCTION_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps}`,
    );
  }
  boundedMetric(
    failures,
    "droppedFrameRatio",
    metrics.droppedFrameRatio,
    0,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.maximumDroppedFrameRatio,
  );
  boundedMetric(
    failures,
    "jsHeapUsedBytes",
    metrics.jsHeapUsedBytes,
    Number.EPSILON,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.jsHeapUsedBytes,
  );
  boundedMetric(
    failures,
    "maxLongTaskMs",
    metrics.maxLongTaskMs,
    0,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.maxLongTaskMs,
  );
  boundedMetric(
    failures,
    "totalLongTaskMs",
    metrics.totalLongTaskMs,
    0,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.totalLongTaskMs,
  );
  boundedMetric(
    failures,
    "taskUtilization",
    metrics.taskUtilization,
    0,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.taskUtilization,
  );
  boundedMetric(
    failures,
    "scriptUtilization",
    metrics.scriptUtilization,
    0,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.scriptUtilization,
  );
  boundedMetric(
    failures,
    "layoutUtilization",
    metrics.layoutUtilization,
    0,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.layoutUtilization,
  );
  boundedMetric(
    failures,
    "horizontalOverflowPx",
    metrics.horizontalOverflowPx,
    0,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.horizontalOverflowPx,
  );
  boundedMetric(
    failures,
    "nonMediaTransferredBytes",
    metrics.nonMediaTransferredBytes,
    Number.EPSILON,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.nonMediaTransferredBytes,
  );
  boundedMetric(
    failures,
    "mediaTransferredBytes",
    metrics.mediaTransferredBytes,
    Number.EPSILON,
    PRODUCTION_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes,
  );
  return failures;
}
