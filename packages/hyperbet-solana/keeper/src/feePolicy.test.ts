import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import {
  MAX_LAUNCH_TRADE_FEE_BPS,
  MAX_LAUNCH_WINNINGS_FEE_BPS,
  resolveApprovedLaunchFeePolicy,
  resolveClusterLaunchFeePolicy,
  resolveLaunchFeePolicy,
} from "./feePolicy";

const duelBotSource = fs.readFileSync(
  new URL("./duelBot.ts", import.meta.url),
  "utf8",
);
const feePolicySource = fs.readFileSync(
  new URL("./feePolicy.ts", import.meta.url),
  "utf8",
);

describe("SOL launch fee policy", () => {
  test("keeps the legacy values inside the local diagnostic rail", () => {
    expect(resolveLaunchFeePolicy({})).toEqual({
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 200,
    });
  });

  test("requires an approved explicit fee envelope on every staging cluster", () => {
    for (const cluster of ["devnet", "testnet"]) {
      expect(() =>
        resolveClusterLaunchFeePolicy({
          cluster,
          approval: undefined,
          tradeTreasuryFeeBps: "100",
          tradeMarketMakerFeeBps: "0",
          winningsMarketMakerFeeBps: "0",
        }),
      ).toThrow("must be exactly 'true'");
      expect(() =>
        resolveClusterLaunchFeePolicy({
          cluster,
          approval: "true",
          tradeTreasuryFeeBps: "100",
          tradeMarketMakerFeeBps: undefined,
          winningsMarketMakerFeeBps: "0",
        }),
      ).toThrow(
        "TRADE_MARKET_MAKER_FEE_BPS must be explicitly configured on every non-local launch rail",
      );
      expect(
        resolveClusterLaunchFeePolicy({
          cluster,
          approval: "true",
          tradeTreasuryFeeBps: "100",
          tradeMarketMakerFeeBps: "0",
          winningsMarketMakerFeeBps: "0",
        }),
      ).toEqual({
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 0,
        winningsMarketMakerFeeBps: 0,
      });
    }
  });

  test("allows defaults only on exact localnet and rejects unknown clusters", () => {
    expect(
      resolveClusterLaunchFeePolicy({
        cluster: "localnet",
        approval: undefined,
        tradeTreasuryFeeBps: undefined,
        tradeMarketMakerFeeBps: undefined,
        winningsMarketMakerFeeBps: undefined,
      }),
    ).toEqual({
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 200,
    });
    expect(() =>
      resolveClusterLaunchFeePolicy({
        cluster: "customnet",
        approval: undefined,
        tradeTreasuryFeeBps: "100",
        tradeMarketMakerFeeBps: "0",
        winningsMarketMakerFeeBps: "0",
      }),
    ).toThrow("Unsupported Solana fee-policy cluster 'customnet'");
  });

  test("accepts the fairness guardrails at their boundaries", () => {
    expect(
      resolveLaunchFeePolicy({
        tradeTreasuryFeeBps: 1,
        tradeMarketMakerFeeBps: MAX_LAUNCH_TRADE_FEE_BPS - 1,
        winningsMarketMakerFeeBps: MAX_LAUNCH_WINNINGS_FEE_BPS,
      }),
    ).toEqual({
      tradeTreasuryFeeBps: 1,
      tradeMarketMakerFeeBps: MAX_LAUNCH_TRADE_FEE_BPS - 1,
      winningsMarketMakerFeeBps: MAX_LAUNCH_WINNINGS_FEE_BPS,
    });
  });

  test.each([
    [{ tradeTreasuryFeeBps: 0 }, "greater than zero"],
    [{ tradeTreasuryFeeBps: -1 }, "non-negative integer"],
    [{ tradeTreasuryFeeBps: 1.5 }, "non-negative integer"],
    [
      {
        tradeTreasuryFeeBps: MAX_LAUNCH_TRADE_FEE_BPS,
        tradeMarketMakerFeeBps: 1,
      },
      "Combined trade fees",
    ],
    [
      { winningsMarketMakerFeeBps: MAX_LAUNCH_WINNINGS_FEE_BPS + 1 },
      "Winnings fees",
    ],
  ])("rejects unsafe policy %#", (input, message) => {
    expect(() => resolveLaunchFeePolicy(input)).toThrow(message);
  });

  test("requires explicit approved fee values for a non-local launch rail", () => {
    expect(() =>
      resolveApprovedLaunchFeePolicy({
        approval: undefined,
        tradeTreasuryFeeBps: "100",
        tradeMarketMakerFeeBps: "0",
        winningsMarketMakerFeeBps: "0",
      }),
    ).toThrow("must be exactly 'true'");
    expect(() =>
      resolveApprovedLaunchFeePolicy({
        approval: "true",
        tradeTreasuryFeeBps: "100",
        tradeMarketMakerFeeBps: undefined,
        winningsMarketMakerFeeBps: "0",
      }),
    ).toThrow("TRADE_MARKET_MAKER_FEE_BPS must be explicitly configured");
    expect(
      resolveApprovedLaunchFeePolicy({
        approval: "true",
        tradeTreasuryFeeBps: "100",
        tradeMarketMakerFeeBps: "0",
        winningsMarketMakerFeeBps: "0",
      }),
    ).toEqual({
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 0,
      winningsMarketMakerFeeBps: 0,
    });
    expect(() =>
      resolveClusterLaunchFeePolicy({
        cluster: "mainnet-beta",
        approval: undefined,
        tradeTreasuryFeeBps: "100",
        tradeMarketMakerFeeBps: "0",
        winningsMarketMakerFeeBps: "0",
      }),
    ).toThrow("must be exactly 'true'");
  });

  test("wires the keeper through cluster-aware policy without hidden CLI defaults", () => {
    expect(duelBotSource).toContain("resolveClusterLaunchFeePolicy({");
    expect(duelBotSource).toContain("resolveOracleDisputeWindowSeconds({");
    expect(duelBotSource).not.toContain(
      "Number(process.env.TRADE_TREASURY_FEE_BPS || 100)",
    );
    expect(duelBotSource).not.toContain(
      "Number(process.env.TRADE_MARKET_MAKER_FEE_BPS || 100)",
    );
    expect(duelBotSource).not.toContain(
      "Number(process.env.WINNINGS_MARKET_MAKER_FEE_BPS || 200)",
    );
    expect(feePolicySource).not.toContain(
      'if (cluster === "mainnet" || cluster === "mainnet-beta")',
    );
  });
});
