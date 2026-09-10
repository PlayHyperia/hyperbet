import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { resolveSolanaProxyRail } from "./solanaProxyRailPolicy";

describe("Solana public proxy rail policy", () => {
  test("uses the explicit public RPC for preflighted staging submission", () => {
    for (const cluster of ["devnet", "testnet"]) {
      expect(
        resolveSolanaProxyRail({
          deployment: true,
          cluster,
          rpcUrl: `https://rpc.${cluster}.example/path?token=private`,
          mainnetSenderUrl: null,
        }),
      ).toEqual({
        rpcUrl: `https://rpc.${cluster}.example/path?token=private`,
        sender: {
          url: `https://rpc.${cluster}.example/path?token=private`,
          skipPreflight: false,
          maxRetries: 5,
        },
      });
    }
  });

  test("requires a distinct fast sender for a deployed mainnet rail", () => {
    expect(() =>
      resolveSolanaProxyRail({
        deployment: true,
        cluster: "mainnet-beta",
        rpcUrl: "https://rpc.mainnet.example",
        mainnetSenderUrl: null,
      }),
    ).toThrow("Helius Sender URL is required");
    expect(
      resolveSolanaProxyRail({
        deployment: true,
        cluster: "mainnet",
        rpcUrl: "https://rpc.mainnet.example",
        mainnetSenderUrl: "https://sender.example/fast?api-key=private",
      }),
    ).toEqual({
      rpcUrl: "https://rpc.mainnet.example/",
      sender: {
        url: "https://sender.example/fast?api-key=private",
        skipPreflight: true,
        maxRetries: 0,
      },
    });
  });

  test("rejects deployed localnet and incomplete deployment rails", () => {
    expect(() =>
      resolveSolanaProxyRail({
        deployment: true,
        cluster: "localnet",
        rpcUrl: "http://127.0.0.1:8899",
        mainnetSenderUrl: null,
      }),
    ).toThrow("must not target localnet");
    expect(() =>
      resolveSolanaProxyRail({
        deployment: true,
        cluster: "devnet",
        rpcUrl: undefined,
        mainnetSenderUrl: null,
      }),
    ).toThrow("SOLANA_RPC_URL is required");
  });

  test("permits only loopback HTTP for an optional local diagnostic rail", () => {
    expect(
      resolveSolanaProxyRail({
        deployment: false,
        cluster: "localnet",
        rpcUrl: "http://localhost:8899",
        mainnetSenderUrl: null,
      }),
    ).toEqual({
      rpcUrl: "http://localhost:8899/",
      sender: {
        url: "http://localhost:8899/",
        skipPreflight: false,
        maxRetries: 5,
      },
    });
    expect(() =>
      resolveSolanaProxyRail({
        deployment: false,
        cluster: "devnet",
        rpcUrl: "http://rpc.example",
        mainnetSenderUrl: null,
      }),
    ).toThrow("must use HTTPS");
  });

  test("rejects unknown rails and URL credentials or fragments", () => {
    expect(() =>
      resolveSolanaProxyRail({
        deployment: false,
        cluster: "solana",
        rpcUrl: undefined,
        mainnetSenderUrl: null,
      }),
    ).toThrow("Unsupported Solana proxy cluster");
    for (const rpcUrl of [
      "https://user:secret@rpc.example",
      "https://rpc.example#secret",
      "file:///rpc",
    ]) {
      expect(() =>
        resolveSolanaProxyRail({
          deployment: true,
          cluster: "devnet",
          rpcUrl,
          mainnetSenderUrl: null,
        }),
      ).toThrow("without credentials or a fragment");
    }
  });

  test("binds both service proxy handlers to the resolved rail", () => {
    const source = readFileSync(
      new URL("./service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("resolveSolanaProxyRail({");
    expect(source).toContain("const sender = SOLANA_PROXY_RAIL.sender");
    expect(source).toContain("skipPreflight: sender.skipPreflight");
    expect(source).not.toContain(
      "HTTP_POLICY.deployment && !SERVICE_IS_MAINNET",
    );
  });
});
