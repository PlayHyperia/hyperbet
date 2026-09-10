import { describe, expect, test } from "bun:test";

import {
  evaluateProductionBrowserPerformance,
  PRODUCTION_BROWSER_PERFORMANCE_BUDGET,
  type ProductionBrowserPerformanceMetrics,
} from "../e2e/productionPerformancePolicy";

function passingMetrics(): ProductionBrowserPerformanceMetrics {
  return {
    lcpObserverSupported: true,
    longTaskObserverSupported: true,
    lcpMs: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.lcpMs,
    firstDecodedFrameMs:
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.firstDecodedFrameMs,
    maxInteractionMs: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.maxInteractionMs,
    presentedFps: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps,
    qualityPresentedFps:
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps,
    droppedFrameRatio:
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.maximumDroppedFrameRatio,
    jsHeapUsedBytes: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.jsHeapUsedBytes,
    maxLongTaskMs: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.maxLongTaskMs,
    totalLongTaskMs: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.totalLongTaskMs,
    taskUtilization: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.taskUtilization,
    scriptUtilization: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.scriptUtilization,
    layoutUtilization: PRODUCTION_BROWSER_PERFORMANCE_BUDGET.layoutUtilization,
    horizontalOverflowPx:
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.horizontalOverflowPx,
    nonMediaTransferredBytes:
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.nonMediaTransferredBytes,
    mediaTransferredBytes:
      PRODUCTION_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes,
  };
}

describe("production browser performance policy", () => {
  test("accepts every interim launch budget at its exact boundary", () => {
    expect(evaluateProductionBrowserPerformance(passingMetrics())).toEqual([]);
  });

  test("reports every slow, dropped, memory-heavy, or malformed observation", () => {
    const metrics = passingMetrics();
    const failures = evaluateProductionBrowserPerformance({
      ...metrics,
      lcpObserverSupported: false,
      longTaskObserverSupported: false,
      lcpMs: metrics.lcpMs + 1,
      firstDecodedFrameMs: Number.NaN,
      maxInteractionMs: metrics.maxInteractionMs + 1,
      presentedFps: metrics.presentedFps - 0.01,
      qualityPresentedFps: metrics.qualityPresentedFps - 0.01,
      droppedFrameRatio: metrics.droppedFrameRatio + 0.001,
      jsHeapUsedBytes: metrics.jsHeapUsedBytes + 1,
      maxLongTaskMs: metrics.maxLongTaskMs + 1,
      totalLongTaskMs: metrics.totalLongTaskMs + 1,
      taskUtilization: metrics.taskUtilization + 0.01,
      scriptUtilization: metrics.scriptUtilization + 0.01,
      layoutUtilization: metrics.layoutUtilization + 0.01,
      horizontalOverflowPx: metrics.horizontalOverflowPx + 1,
      nonMediaTransferredBytes: metrics.nonMediaTransferredBytes + 1,
      mediaTransferredBytes: metrics.mediaTransferredBytes + 1,
    });

    expect(failures).toHaveLength(17);
    expect(failures.join("\n")).toContain("lcpMs");
    expect(failures.join("\n")).toContain("presentedFps");
    expect(failures.join("\n")).toContain("nonMediaTransferredBytes");
    expect(failures.join("\n")).toContain("mediaTransferredBytes");
    expect(failures.join("\n")).toContain("horizontalOverflowPx");
  });

  test("fails closed when required positive observations are missing", () => {
    const metrics = passingMetrics();
    const failures = evaluateProductionBrowserPerformance({
      ...metrics,
      lcpMs: 0,
      firstDecodedFrameMs: 0,
      maxInteractionMs: 0,
      jsHeapUsedBytes: 0,
      nonMediaTransferredBytes: 0,
      mediaTransferredBytes: 0,
    });

    expect(failures).toHaveLength(6);
  });
});
