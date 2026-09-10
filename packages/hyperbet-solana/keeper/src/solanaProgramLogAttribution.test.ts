import { describe, expect, test } from "bun:test";

import { extractAttributedProgramDataLogs } from "./solanaProgramLogAttribution";

const MARKET_PROGRAM = "11111111111111111111111111111111";
const OTHER_PROGRAM = "ComputeBudget111111111111111111111111111111";

describe("finalized SOL program-log attribution", () => {
  test("keeps only data emitted while the market program owns the log stack", () => {
    const evidence = extractAttributedProgramDataLogs(
      [
        `Program ${MARKET_PROGRAM} invoke [1]`,
        "Program data: market-before-cpi",
        `Program ${OTHER_PROGRAM} invoke [2]`,
        "Program data: nested-spoof",
        `Program ${OTHER_PROGRAM} success`,
        "Program data: market-after-cpi",
        `Program ${MARKET_PROGRAM} success`,
        `Program ${OTHER_PROGRAM} invoke [1]`,
        "Program data: sibling-spoof",
        `Program ${OTHER_PROGRAM} success`,
      ],
      MARKET_PROGRAM,
    );

    expect(evidence).toEqual({
      programData: ["market-before-cpi", "market-after-cpi"],
      invocationCount: 1,
    });
  });

  test("counts direct and CPI invocations so callers can reject hidden execution", () => {
    const evidence = extractAttributedProgramDataLogs(
      [
        `Program ${MARKET_PROGRAM} invoke [1]`,
        `Program ${MARKET_PROGRAM} success`,
        `Program ${OTHER_PROGRAM} invoke [1]`,
        `Program ${MARKET_PROGRAM} invoke [2]`,
        "Program data: cpi-market-event",
        `Program ${MARKET_PROGRAM} success`,
        `Program ${OTHER_PROGRAM} success`,
      ],
      MARKET_PROGRAM,
    );

    expect(evidence.invocationCount).toBe(2);
    expect(evidence.programData).toEqual(["cpi-market-event"]);
  });

  test("unwinds failed invocations without attributing their data", () => {
    expect(
      extractAttributedProgramDataLogs(
        [
          `Program ${MARKET_PROGRAM} invoke [1]`,
          `Program ${OTHER_PROGRAM} invoke [2]`,
          "Program data: failed-cpi-spoof",
          `Program ${OTHER_PROGRAM} failed: custom program error: 0x1`,
          "Program data: market-recovery",
          `Program ${MARKET_PROGRAM} success`,
        ],
        MARKET_PROGRAM,
      ),
    ).toEqual({ programData: ["market-recovery"], invocationCount: 1 });
  });

  test("fails closed on malformed, incomplete, or truncated log stacks", () => {
    const malformedLogs = [
      ["Program data: orphan"],
      [`Program ${MARKET_PROGRAM} invoke [2]`],
      [
        `Program ${MARKET_PROGRAM} invoke [1]`,
        `Program ${OTHER_PROGRAM} success`,
      ],
      [`Program ${MARKET_PROGRAM} invoke [1]`],
      [`Program ${MARKET_PROGRAM} invoke [1]`, "Program log: Log truncated"],
    ];

    for (const logs of malformedLogs) {
      expect(() =>
        extractAttributedProgramDataLogs(logs, MARKET_PROGRAM),
      ).toThrow();
    }
    expect(() => extractAttributedProgramDataLogs([], "not-base58")).toThrow(
      "target is invalid",
    );
  });
});
