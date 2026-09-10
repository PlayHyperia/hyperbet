import "./setup";
import { afterEach, describe, expect, it } from "bun:test";

import {
  normalizeSolanaPredictionMarketDuelKeyHex,
  normalizeSolanaPredictionMarketLifecycleRecord,
} from "../src/lib/solanaLifecycle";
import {
  fetchActivePredictionMarkets,
  parsePredictionMarketsResponse,
} from "../src/lib/solanaPredictionMarkets";

const originalFetch = globalThis.fetch;
const MARKET_PUBLIC_KEY = "11111111111111111111111111111111";
const PROGRAM_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Solana-only prediction market lifecycle", () => {
  it("normalizes Solana CLOB records and canonical duel keys", () => {
    const duelKey = "ab".repeat(32);
    const record = normalizeSolanaPredictionMarketLifecycleRecord({
      chainKey: "SOL",
      marketType: "clob",
      duelKey: `0x${duelKey.toUpperCase()}`,
      duelId: "duel-1",
      marketId: "market-1",
      marketRef: "market-pda",
      lifecycleStatus: "OPEN",
      winner: "NONE",
      betCloseTime: 123,
      programId: "program-id",
      syncedAt: 456,
    });

    expect(record).toMatchObject({
      chainKey: "solana",
      marketType: "clob",
      duelKey,
      lifecycleStatus: "OPEN",
      winner: "NONE",
    });
    expect(
      normalizeSolanaPredictionMarketDuelKeyHex(duelKey, { prefix: true }),
    ).toBe(`0x${duelKey}`);
  });

  it("fails closed for non-Solana chains and excluded market types", () => {
    expect(
      normalizeSolanaPredictionMarketLifecycleRecord({
        chainKey: "unsupported",
        lifecycleStatus: "OPEN",
      }),
    ).toBeNull();
    expect(
      normalizeSolanaPredictionMarketLifecycleRecord({
        chainKey: "solana",
        marketType: "unsupported-market",
        lifecycleStatus: "OPEN",
      }),
    ).toBeNull();
  });

  it("filters excluded records from keeper lifecycle responses", () => {
    const duelKey = "cd".repeat(32);
    const parsed = parsePredictionMarketsResponse({
      duel: {
        duelKey,
        duelId: "duel-2",
        phase: "ANNOUNCEMENT",
        winner: "NONE",
        betCloseTime: 999,
        syncedAt: 2,
      },
      markets: [
        {
          chainKey: "solana",
          marketType: "clob",
          duelKey,
          duelId: "duel-2",
          marketId: MARKET_PUBLIC_KEY,
          marketRef: MARKET_PUBLIC_KEY,
          lifecycleStatus: "OPEN",
          winner: "NONE",
          betCloseTime: 999,
          programId: PROGRAM_PUBLIC_KEY,
          syncedAt: 1,
        },
        {
          chainKey: "unsupported",
          marketType: "clob",
          duelKey,
          lifecycleStatus: "OPEN",
        },
        {
          chainKey: "solana",
          marketType: "unsupported-market",
          duelKey,
          lifecycleStatus: "OPEN",
        },
      ],
      updatedAt: 2,
    });

    expect(parsed?.markets).toHaveLength(1);
    expect(parsed?.markets[0]?.marketRef).toBe(MARKET_PUBLIC_KEY);
  });

  it("rejects duplicate and cross-identity Solana lifecycle authority", () => {
    const duelKey = "de".repeat(32);
    const valid = {
      chainKey: "solana",
      marketType: "clob",
      duelKey,
      duelId: "duel-coherent",
      marketId: MARKET_PUBLIC_KEY,
      marketRef: MARKET_PUBLIC_KEY,
      lifecycleStatus: "OPEN",
      winner: "NONE",
      betCloseTime: 2_000,
      contractAddress: null,
      programId: PROGRAM_PUBLIC_KEY,
      syncedAt: 1_000,
    } as const;
    const response = {
      duel: {
        duelKey,
        duelId: "duel-coherent",
        phase: "ANNOUNCEMENT",
        winner: "NONE",
        betCloseTime: 2_000,
        syncedAt: 1_000,
      },
      markets: [valid],
      updatedAt: 1_000,
    };

    expect(parsePredictionMarketsResponse(response)).not.toBeNull();
    expect(
      parsePredictionMarketsResponse({ ...response, markets: [valid, valid] }),
    ).toBeNull();
    for (const payload of [
      { ...valid, duelKey: "ac".repeat(32) },
      { ...valid, duelId: "duel-other" },
      { ...valid, marketId: PROGRAM_PUBLIC_KEY },
      { ...valid, marketRef: "not-a-public-key" },
      { ...valid, programId: "not-a-public-key" },
      { ...valid, contractAddress: MARKET_PUBLIC_KEY },
      { ...valid, winner: "A" },
      { ...valid, duelId: null },
    ]) {
      expect(
        parsePredictionMarketsResponse({ ...response, markets: [payload] }),
      ).toBeNull();
    }
  });

  it("requires an exact winner only for a resolved lifecycle", () => {
    const duelKey = "ad".repeat(32);
    const market = {
      chainKey: "solana",
      marketType: "clob",
      duelKey,
      duelId: "duel-resolved",
      marketId: MARKET_PUBLIC_KEY,
      marketRef: MARKET_PUBLIC_KEY,
      lifecycleStatus: "RESOLVED",
      winner: "A",
      betCloseTime: 2_000,
      contractAddress: null,
      programId: PROGRAM_PUBLIC_KEY,
      syncedAt: 1_000,
    } as const;
    const response = {
      duel: {
        duelKey,
        duelId: "duel-resolved",
        phase: "RESOLUTION",
        winner: "A",
        betCloseTime: 2_000,
        syncedAt: 1_000,
      },
      markets: [market],
      updatedAt: 1_000,
    };

    expect(parsePredictionMarketsResponse(response)).not.toBeNull();
    expect(
      parsePredictionMarketsResponse({
        ...response,
        duel: { ...response.duel, winner: "NONE" },
        markets: [{ ...market, winner: "NONE" }],
      }),
    ).toBeNull();
    expect(
      parsePredictionMarketsResponse({
        ...response,
        duel: { ...response.duel, winner: "A" },
        markets: [{ ...market, lifecycleStatus: "OPEN" }],
      }),
    ).toBeNull();
  });

  it("preserves provisional duel outcomes while financial winner state remains unresolved", () => {
    const duelKey = "fa".repeat(32);
    const market = {
      chainKey: "solana",
      marketType: "clob",
      duelKey,
      duelId: "duel-provisional",
      marketId: MARKET_PUBLIC_KEY,
      marketRef: MARKET_PUBLIC_KEY,
      lifecycleStatus: "PROPOSED",
      winner: "NONE",
      betCloseTime: 2_000,
      contractAddress: null,
      programId: PROGRAM_PUBLIC_KEY,
      syncedAt: 1_000,
    } as const;
    const response = {
      duel: {
        duelKey,
        duelId: "duel-provisional",
        phase: "RESOLUTION",
        winner: "A",
        betCloseTime: 2_000,
        syncedAt: 1_000,
      },
      markets: [market],
      updatedAt: 1_000,
    };

    for (const lifecycleStatus of [
      "LOCKED",
      "PROPOSED",
      "CHALLENGED",
    ] as const) {
      expect(
        parsePredictionMarketsResponse({
          ...response,
          markets: [{ ...market, lifecycleStatus }],
        }),
      ).not.toBeNull();
    }
    expect(
      parsePredictionMarketsResponse({
        ...response,
        markets: [{ ...market, winner: "A" }],
      }),
    ).toBeNull();
  });

  it("rejects replayed, future-dated, and stale active lifecycle authority", async () => {
    const now = Date.now();
    const response = (input: {
      updatedAt: number;
      syncedAt: number | null;
      duelSyncedAt?: number;
      lifecycleStatus?: "OPEN" | "PENDING";
    }) => ({
      duel: {
        duelKey: "ef".repeat(32),
        duelId: "duel-freshness",
        phase: "ANNOUNCEMENT",
        winner: "NONE",
        betCloseTime: now + 60_000,
        syncedAt: input.duelSyncedAt ?? input.updatedAt,
      },
      markets: [
        {
          chainKey: "solana",
          marketType: "clob",
          duelKey: "ef".repeat(32),
          duelId: "duel-freshness",
          marketId: MARKET_PUBLIC_KEY,
          marketRef: MARKET_PUBLIC_KEY,
          lifecycleStatus: input.lifecycleStatus ?? "OPEN",
          winner: "NONE",
          betCloseTime: now + 60_000,
          programId: PROGRAM_PUBLIC_KEY,
          syncedAt: input.syncedAt,
        },
      ],
      updatedAt: input.updatedAt,
    });

    for (const payload of [
      response({ updatedAt: now - 30_001, syncedAt: now - 30_100 }),
      response({ updatedAt: now + 31_000, syncedAt: now }),
      response({ updatedAt: now, syncedAt: now - 30_001 }),
      response({
        updatedAt: now,
        syncedAt: now,
        duelSyncedAt: now - 15_001,
      }),
      response({ updatedAt: now, syncedAt: null }),
    ]) {
      globalThis.fetch = (async (_input: RequestInfo | URL) =>
        Response.json(payload)) as typeof fetch;
      await expect(fetchActivePredictionMarkets()).rejects.toThrow(
        "prediction markets response was invalid",
      );
    }

    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json(
        response({
          updatedAt: Date.now(),
          syncedAt: null,
          lifecycleStatus: "PENDING",
        }),
      )) as typeof fetch;
    await expect(fetchActivePredictionMarkets()).resolves.toMatchObject({
      markets: [{ lifecycleStatus: "PENDING", syncedAt: null }],
    });
  });
});
