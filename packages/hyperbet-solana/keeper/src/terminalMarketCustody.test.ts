import { describe, expect, test } from "bun:test";
import {
  reconcileTerminalMarketCustody,
  releaseResolvedTradeFeesFailClosed,
} from "./terminalMarketCustody";

describe("resolved trade-fee custody", () => {
  test("does not submit when no escrow remains", async () => {
    let submissions = 0;
    const result = await releaseResolvedTradeFeesFailClosed({
      readEscrow: async () => ({
        treasuryLamports: 0n,
        marketMakerLamports: 0n,
      }),
      submitRelease: async () => {
        submissions += 1;
      },
    });

    expect(result).toEqual({
      attempted: false,
      before: { treasuryLamports: 0n, marketMakerLamports: 0n },
    });
    expect(submissions).toBe(0);
  });

  test("accepts a successful release only after escrow is zero", async () => {
    let released = false;
    const result = await releaseResolvedTradeFeesFailClosed({
      readEscrow: async () =>
        released
          ? { treasuryLamports: 0n, marketMakerLamports: 0n }
          : { treasuryLamports: 12n, marketMakerLamports: 6n },
      submitRelease: async () => {
        released = true;
      },
    });

    expect(result).toEqual({
      attempted: true,
      before: { treasuryLamports: 12n, marketMakerLamports: 6n },
    });
  });

  test("accepts an ambiguous race only when escrow is already zero", async () => {
    let released = false;
    const result = await releaseResolvedTradeFeesFailClosed({
      readEscrow: async () =>
        released
          ? { treasuryLamports: 0n, marketMakerLamports: 0n }
          : { treasuryLamports: 12n, marketMakerLamports: 6n },
      submitRelease: async () => {
        released = true;
        throw new Error("NothingToWithdraw");
      },
    });

    expect(result.attempted).toBe(true);
  });

  test("does not trust a release error while escrow remains", async () => {
    const failure = new Error("NothingToWithdraw");
    await expect(
      releaseResolvedTradeFeesFailClosed({
        readEscrow: async () => ({
          treasuryLamports: 12n,
          marketMakerLamports: 6n,
        }),
        submitRelease: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  test("fails closed when nominal success leaves escrow outstanding", async () => {
    await expect(
      releaseResolvedTradeFeesFailClosed({
        readEscrow: async () => ({
          treasuryLamports: 12n,
          marketMakerLamports: 6n,
        }),
        submitRelease: async () => undefined,
      }),
    ).rejects.toThrow(
      "Resolved trade-fee release completed, but on-chain escrow remains outstanding",
    );
  });

  test("rejects impossible negative escrow", async () => {
    await expect(
      releaseResolvedTradeFeesFailClosed({
        readEscrow: async () => ({
          treasuryLamports: -1n,
          marketMakerLamports: 0n,
        }),
        submitRelease: async () => undefined,
      }),
    ).rejects.toThrow("Resolved trade-fee escrow cannot be negative");
  });
});

describe("terminal market custody reconciliation", () => {
  test("settles balance, releases fees, then captures resolved health", async () => {
    const events: string[] = [];
    await reconcileTerminalMarketCustody({
      lifecycleStatus: "RESOLVED",
      settleMarketMakerBalance: async () => {
        events.push("balance");
      },
      releaseResolvedTradeFees: async () => {
        events.push("fees");
      },
      captureSettledHealth: async () => {
        events.push("health");
      },
    });
    expect(events).toEqual(["balance", "fees", "health"]);
  });

  test("settles cancellation balance without withdrawing refundable fees", async () => {
    const events: string[] = [];
    await reconcileTerminalMarketCustody({
      lifecycleStatus: "CANCELLED",
      settleMarketMakerBalance: async () => {
        events.push("balance");
      },
      releaseResolvedTradeFees: async () => {
        events.push("fees");
      },
      captureSettledHealth: async () => {
        events.push("health");
      },
    });
    expect(events).toEqual(["balance", "health"]);
  });

  test("never captures settled health after custody cleanup fails", async () => {
    const events: string[] = [];
    const failure = new Error("fee release unavailable");
    await expect(
      reconcileTerminalMarketCustody({
        lifecycleStatus: "RESOLVED",
        settleMarketMakerBalance: async () => {
          events.push("balance");
        },
        releaseResolvedTradeFees: async () => {
          events.push("fees");
          throw failure;
        },
        captureSettledHealth: async () => {
          events.push("health");
        },
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual(["balance", "fees"]);
  });

  test("does not release fees or capture health when balance settlement fails", async () => {
    const events: string[] = [];
    const failure = new Error("market-maker claim unavailable");
    await expect(
      reconcileTerminalMarketCustody({
        lifecycleStatus: "RESOLVED",
        settleMarketMakerBalance: async () => {
          events.push("balance");
          throw failure;
        },
        releaseResolvedTradeFees: async () => {
          events.push("fees");
        },
        captureSettledHealth: async () => {
          events.push("health");
        },
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual(["balance"]);
  });
});
