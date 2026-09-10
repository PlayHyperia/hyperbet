import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  canAcceptStreamStatePublish,
  resolveDuelFeedConfig,
  resolveLocalDiagnosticDuelFeed,
  resolveStreamStateSourceConfig,
} from "./feedConfig";

describe("authoritative duel feed configuration", () => {
  test("requires authenticated HTTPS on every non-local launch rail", () => {
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(() =>
        resolveDuelFeedConfig({
          cluster,
          gameUrl: "http://game.example",
          bearerToken: "secret",
        }),
      ).toThrow("HTTPS");
      expect(() =>
        resolveDuelFeedConfig({
          cluster,
          gameUrl: "https://game.example",
        }),
      ).toThrow("BET_SYNC_SOURCE_BEARER_TOKEN");
    }
  });

  test("normalizes a valid authenticated non-local feed", () => {
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(
        resolveDuelFeedConfig({
          cluster,
          gameUrl: "https://game.example/",
          bearerToken: "  secret  ",
        }),
      ).toEqual({
        gameUrl: "https://game.example",
        bearerToken: "secret",
      });
    }
  });

  test("allows loopback HTTP for local validation", () => {
    expect(
      resolveDuelFeedConfig({
        cluster: "localnet",
        gameUrl: "http://127.0.0.1:5555",
      }).gameUrl,
    ).toBe("http://127.0.0.1:5555");
  });

  test("rejects invalid URLs and embedded credentials", () => {
    expect(() =>
      resolveDuelFeedConfig({ cluster: "devnet", gameUrl: "not-a-url" }),
    ).toThrow("absolute URL");
    expect(() =>
      resolveDuelFeedConfig({
        cluster: "devnet",
        gameUrl: "https://user:password@game.example",
      }),
    ).toThrow("embedded credentials");
    expect(() =>
      resolveDuelFeedConfig({
        cluster: "solana",
        gameUrl: "https://game.example",
        bearerToken: "secret",
      }),
    ).toThrow("Unsupported Solana duel-feed cluster");
  });

  test("passes the validated feed credential into the live game client", () => {
    const source = readFileSync(
      new URL("./duelBot.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("bearerToken: duelFeedConfig.bearerToken");
  });
});

describe("local diagnostic transaction feed boundary", () => {
  const valid = {
    requested: true,
    cluster: "localnet",
    gameUrl: "http://127.0.0.1:5555",
    rpcUrl: "http://localhost:18899",
  };

  test("requires an explicit flag and two loopback localnet endpoints", () => {
    expect(resolveLocalDiagnosticDuelFeed(valid)).toBe(true);
    expect(
      resolveLocalDiagnosticDuelFeed({
        ...valid,
        requested: false,
        cluster: "mainnet-beta",
        gameUrl: "https://game.example",
        rpcUrl: "https://rpc.example",
      }),
    ).toBe(false);

    for (const override of [
      { cluster: "devnet" },
      { gameUrl: "https://game.example" },
      { rpcUrl: "https://api.mainnet-beta.solana.com" },
      { gameUrl: "file:///tmp/feed" },
    ]) {
      expect(() =>
        resolveLocalDiagnosticDuelFeed({ ...valid, ...override }),
      ).toThrow("HYPERBET_LOCAL_DIAGNOSTIC_FEED requires");
    }
  });
});

describe("canonical spectator stream source configuration", () => {
  test("requires one exact HTTPS Hyperia state source in production", () => {
    expect(() => resolveStreamStateSourceConfig({ production: true })).toThrow(
      "required in production",
    );
    expect(() =>
      resolveStreamStateSourceConfig({
        production: true,
        sourceUrl: "http://game.example/api/streaming/state",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      resolveStreamStateSourceConfig({
        production: true,
        sourceUrl: "https://game.example/api/internal/bet-sync/state",
      }),
    ).toThrow("exactly /api/streaming/state");
  });

  test("normalizes the canonical production source and bearer token", () => {
    expect(
      resolveStreamStateSourceConfig({
        production: true,
        sourceUrl: " https://game.example/api/streaming/state ",
        bearerToken: " source-secret ",
      }),
    ).toEqual({
      sourceUrl: "https://game.example/api/streaming/state",
      bearerToken: "source-secret",
    });
  });

  test("rejects credentials, query strings, fragments, and unsafe protocols", () => {
    for (const sourceUrl of [
      "https://user:password@game.example/api/streaming/state",
      "https://game.example/api/streaming/state?source=other",
      "https://game.example/api/streaming/state#stale",
      "file:///api/streaming/state",
    ]) {
      expect(() =>
        resolveStreamStateSourceConfig({
          production: false,
          sourceUrl,
        }),
      ).toThrow();
    }
  });

  test("allows source-less local fixtures but never a competing publisher", () => {
    expect(resolveStreamStateSourceConfig({ production: false })).toEqual({
      sourceUrl: "",
      bearerToken: "",
    });
    expect(
      canAcceptStreamStatePublish({
        production: false,
        sourceConfigured: false,
      }),
    ).toBe(true);
    expect(
      canAcceptStreamStatePublish({
        production: false,
        sourceConfigured: true,
      }),
    ).toBe(false);
    expect(
      canAcceptStreamStatePublish({
        production: true,
        sourceConfigured: false,
      }),
    ).toBe(false);
  });
});
