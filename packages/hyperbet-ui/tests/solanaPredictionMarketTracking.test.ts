import "./setup";
import { afterEach, describe, expect, it } from "bun:test";
import {
  predictionMarketTrackingRetryDelayMs,
  recordSolanaPredictionMarketTrade,
} from "../src/lib/solanaPredictionMarketTracking";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("Solana prediction market tracking", () => {
  const canonicalIdentity = {
    marketRef: "market-1",
    duelKey: "ab".repeat(32),
    duelId: "duel-1",
  };

  it("uses bounded backoff when Retry-After is absent or unreadable", () => {
    expect(
      predictionMarketTrackingRetryDelayMs(
        new Response(null, { status: 425 }),
        0,
      ),
    ).toBe(500);
    expect(
      predictionMarketTrackingRetryDelayMs(
        new Response(null, {
          status: 425,
          headers: { "retry-after": "" },
        }),
        1,
      ),
    ).toBe(1_000);
    expect(
      predictionMarketTrackingRetryDelayMs(
        new Response(null, {
          status: 425,
          headers: { "retry-after": "not-a-number" },
        }),
        2,
      ),
    ).toBe(2_000);
    expect(
      predictionMarketTrackingRetryDelayMs(
        new Response(null, {
          status: 425,
          headers: { "retry-after": "1" },
        }),
        20,
      ),
    ).toBe(1_000);
  });

  it("submits exact native lamports without legacy token or float amounts", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const recorded = await recordSolanaPredictionMarketTrade({
      bettorWallet: "wallet-1",
      sourceAmountLamports: 9_007_199_254_740_993n,
      feeBps: 25,
      txSignature: "signature-1",
      ...canonicalIdentity,
    });

    expect(recorded).toBe(true);
    expect(body).toMatchObject({
      chainKey: "solana",
      chain: "SOLANA",
      sourceAsset: "SOL",
      sourceAmountLamports: "9007199254740993",
      feeBps: 25,
    });
    expect(body).not.toHaveProperty("sourceAmount");
  });

  it("retries bounded pending-finality and RPC-unavailable responses", async () => {
    const statuses = [425, 503, 200];
    let attempts = 0;
    globalThis.fetch = (async (_input, _init) => {
      const status = statuses[attempts++] ?? 500;
      return new Response(null, {
        status,
        headers: { "retry-after": "0" },
      });
    }) as typeof fetch;

    const recorded = await recordSolanaPredictionMarketTrade({
      bettorWallet: "wallet-1",
      sourceAmountLamports: 1n,
      feeBps: 0,
      txSignature: "signature-1",
      ...canonicalIdentity,
    });

    expect(recorded).toBe(true);
    expect(attempts).toBe(3);
  });

  it("keeps tracking beyond the former thirty-attempt ceiling while the finality deadline remains", async () => {
    let attempts = 0;
    globalThis.fetch = (async (_input, _init) => {
      attempts += 1;
      return new Response(null, {
        status: attempts <= 35 ? 425 : 200,
        headers: { "retry-after": "0" },
      });
    }) as typeof fetch;

    const recorded = await recordSolanaPredictionMarketTrade({
      bettorWallet: "wallet-1",
      sourceAmountLamports: 1n,
      feeBps: 0,
      txSignature: "signature-1",
      ...canonicalIdentity,
    });

    expect(recorded).toBe(true);
    expect(attempts).toBe(36);
  });

  it("does not retry a rejected finalized transaction", async () => {
    let attempts = 0;
    globalThis.fetch = (async (_input, _init) => {
      attempts += 1;
      return new Response(null, { status: 401 });
    }) as typeof fetch;

    const recorded = await recordSolanaPredictionMarketTrade({
      bettorWallet: "wallet-1",
      sourceAmountLamports: 1n,
      feeBps: 0,
      txSignature: "signature-1",
      ...canonicalIdentity,
    });

    expect(recorded).toBe(false);
    expect(attempts).toBe(1);
  });

  it("fails before network access when the finalized order identity is incomplete or malformed", async () => {
    let attempts = 0;
    globalThis.fetch = (async (_input, _init) => {
      attempts += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const common = {
      bettorWallet: "wallet-1",
      sourceAmountLamports: 1n,
      feeBps: 0,
      txSignature: "signature-1",
    };
    const invalidIdentities = [
      { ...canonicalIdentity, marketRef: " " },
      { ...canonicalIdentity, duelKey: "ab".repeat(31) },
      { ...canonicalIdentity, duelKey: "zz".repeat(32) },
      { ...canonicalIdentity, duelId: " " },
      { ...canonicalIdentity, duelId: "d".repeat(257) },
    ];

    for (const identity of invalidIdentities) {
      expect(
        await recordSolanaPredictionMarketTrade({ ...common, ...identity }),
      ).toBe(false);
    }
    expect(attempts).toBe(0);
  });
});
