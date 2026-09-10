import { describe, expect, test } from "bun:test";
import bs58 from "bs58";

import { SolanaTransactionExpiredError } from "../src/lib/solanaRpc";
import {
  buildSolanaTransactionContextKey,
  buildSolanaExplorerTransactionUrl,
  classifySolanaTransactionError,
  isSolanaMarketLoadedForDuel,
  SolanaTransactionFlowError,
} from "../src/lib/solanaTransactionFeedback";

function flowError(
  stage: "preparing" | "signing" | "sending" | "confirming",
  cause: Error,
  signature: string | null = null,
): SolanaTransactionFlowError {
  return new SolanaTransactionFlowError({
    message: `${stage} failed`,
    stage,
    signature,
    cause,
  });
}

const key = (seed: number) => bs58.encode(new Uint8Array(32).fill(seed));
const WALLET = key(1);
const MARKET_ONE = key(2);
const MARKET_TWO = key(3);
const DUEL_ONE = "aa".repeat(32);
const DUEL_TWO = "bb".repeat(32);

describe("Solana transaction feedback", () => {
  const deployment = {
    cluster: "devnet" as const,
    rpcEndpoint: "https://rpc.example.test",
    fightOracleProgramId: key(8),
    duelMarketProgramId: key(9),
  };

  test("binds feedback to canonical duel identity before a replacement market loads", () => {
    const previous = buildSolanaTransactionContextKey({
      ...deployment,
      walletAddress: WALLET,
      duelKeyHex: DUEL_ONE.toUpperCase(),
      advertisedMarketAddress: MARKET_ONE,
      loadedMarketAddress: MARKET_ONE,
    });
    const replacement = buildSolanaTransactionContextKey({
      ...deployment,
      walletAddress: WALLET,
      duelKeyHex: DUEL_TWO.toUpperCase(),
      advertisedMarketAddress: MARKET_ONE,
      loadedMarketAddress: MARKET_ONE,
    });

    expect(JSON.parse(previous!)).toEqual([
      "hyperbet-solana-transaction-context-v2",
      "devnet",
      "https://rpc.example.test",
      key(8),
      key(9),
      WALLET,
      "duel",
      DUEL_ONE,
      MARKET_ONE,
      MARKET_ONE,
    ]);
    expect(replacement).not.toBe(previous);
  });

  test("falls back to market and wallet identities when no live duel is available", () => {
    expect(
      buildSolanaTransactionContextKey({
        ...deployment,
        walletAddress: WALLET,
        duelKeyHex: null,
        advertisedMarketAddress: MARKET_ONE,
        loadedMarketAddress: null,
      }),
    ).toBe(
      JSON.stringify([
        "hyperbet-solana-transaction-context-v2",
        "devnet",
        "https://rpc.example.test",
        key(8),
        key(9),
        WALLET,
        "market",
        null,
        MARKET_ONE,
        null,
      ]),
    );
    expect(
      buildSolanaTransactionContextKey({
        ...deployment,
        walletAddress: WALLET,
        duelKeyHex: null,
        advertisedMarketAddress: null,
        loadedMarketAddress: null,
      }),
    ).toBe(
      JSON.stringify([
        "hyperbet-solana-transaction-context-v2",
        "devnet",
        "https://rpc.example.test",
        key(8),
        key(9),
        WALLET,
        "wallet",
        null,
        null,
        null,
      ]),
    );
    expect(
      buildSolanaTransactionContextKey({
        ...deployment,
        walletAddress: null,
        duelKeyHex: DUEL_ONE,
        advertisedMarketAddress: MARKET_ONE,
        loadedMarketAddress: MARKET_ONE,
      }),
    ).toBeNull();
  });

  test("binds feedback to the exact deployment and market even for the same duel", () => {
    const current = buildSolanaTransactionContextKey({
      ...deployment,
      walletAddress: WALLET,
      duelKeyHex: DUEL_ONE,
      advertisedMarketAddress: MARKET_ONE,
      loadedMarketAddress: MARKET_ONE,
    });

    for (const changed of [
      { ...deployment, rpcEndpoint: "https://replacement-rpc.example.test" },
      { ...deployment, fightOracleProgramId: key(10) },
      { ...deployment, duelMarketProgramId: key(11) },
      { ...deployment, cluster: "testnet" as const },
    ]) {
      expect(
        buildSolanaTransactionContextKey({
          ...changed,
          walletAddress: WALLET,
          duelKeyHex: DUEL_ONE,
          advertisedMarketAddress: MARKET_ONE,
          loadedMarketAddress: MARKET_ONE,
        }),
      ).not.toBe(current);
    }
    for (const marketIdentity of [
      {
        advertisedMarketAddress: MARKET_TWO,
        loadedMarketAddress: MARKET_ONE,
      },
      {
        advertisedMarketAddress: MARKET_ONE,
        loadedMarketAddress: MARKET_TWO,
      },
    ]) {
      expect(
        buildSolanaTransactionContextKey({
          ...deployment,
          ...marketIdentity,
          walletAddress: WALLET,
          duelKeyHex: DUEL_ONE,
        }),
      ).not.toBe(current);
    }
  });

  test("does not establish a transaction context without complete deployment identity", () => {
    for (const missing of [
      { ...deployment, rpcEndpoint: "" },
      { ...deployment, fightOracleProgramId: "" },
      { ...deployment, duelMarketProgramId: "" },
    ]) {
      expect(
        buildSolanaTransactionContextKey({
          ...missing,
          walletAddress: WALLET,
          duelKeyHex: DUEL_ONE,
          advertisedMarketAddress: MARKET_ONE,
          loadedMarketAddress: MARKET_ONE,
        }),
      ).toBeNull();
    }
  });

  test("rejects malformed runtime identities instead of creating a partial context", () => {
    for (const malformed of [
      { ...deployment, rpcEndpoint: " ftp://rpc.example.test" },
      { ...deployment, rpcEndpoint: "https://user:secret@rpc.example.test" },
      { ...deployment, rpcEndpoint: "https://rpc.example.test/#fragment" },
      { ...deployment, fightOracleProgramId: "not-a-public-key" },
      { ...deployment, duelMarketProgramId: `${key(9)} ` },
      { ...deployment, cluster: "mainnet" as never },
    ]) {
      expect(
        buildSolanaTransactionContextKey({
          ...malformed,
          walletAddress: WALLET,
          duelKeyHex: DUEL_ONE,
          advertisedMarketAddress: MARKET_ONE,
          loadedMarketAddress: MARKET_ONE,
        }),
      ).toBeNull();
    }

    for (const malformedIdentity of [
      { walletAddress: `${WALLET} ` },
      { duelKeyHex: "aa11" },
      { advertisedMarketAddress: "not-a-public-key" },
      { loadedMarketAddress: `${MARKET_ONE} ` },
    ]) {
      expect(
        buildSolanaTransactionContextKey({
          ...deployment,
          walletAddress: WALLET,
          duelKeyHex: DUEL_ONE,
          advertisedMarketAddress: MARKET_ONE,
          loadedMarketAddress: MARKET_ONE,
          ...malformedIdentity,
        }),
      ).toBeNull();
    }
  });

  test("fails closed while the market snapshot belongs to a prior duel", () => {
    expect(
      isSolanaMarketLoadedForDuel({
        loadedDuelKeyHex: "AA11",
        currentDuelKeyHex: "aa11",
      }),
    ).toBe(true);
    expect(
      isSolanaMarketLoadedForDuel({
        loadedDuelKeyHex: "aa11",
        currentDuelKeyHex: "bb22",
      }),
    ).toBe(false);
    expect(
      isSolanaMarketLoadedForDuel({
        loadedDuelKeyHex: "aa11",
        currentDuelKeyHex: null,
      }),
    ).toBe(false);
  });

  test("classifies a pre-signature order-book change as a safe quote refresh", () => {
    const result = classifySolanaTransactionError(
      flowError(
        "preparing",
        new Error("Order book changed; review the refreshed quote"),
      ),
    );
    expect(result.kind).toBe("QUOTE_STALE");
    expect(result.stage).toBe("preparing");
    expect(result.signature).toBeNull();
    expect(result.retryMode).toBe("REVIEW_AND_RETRY");

    expect(
      classifySolanaTransactionError(
        flowError(
          "preparing",
          new Error("Market configuration changed; review the refreshed quote"),
        ),
      ).kind,
    ).toBe("QUOTE_STALE");
  });

  test("classifies user rejection as safe to review and retry", () => {
    const result = classifySolanaTransactionError(
      flowError("signing", new Error("User rejected the request")),
    );
    expect(result.kind).toBe("USER_REJECTED");
    expect(result.stage).toBe("signing");
    expect(result.signature).toBeNull();
    expect(result.retryMode).toBe("REVIEW_AND_RETRY");
  });

  test("blocks retry when a wallet changes or incorrectly signs the transaction", () => {
    for (const message of [
      "Wallet transaction integrity check failed: message-mismatch",
      "Wallet returned a transaction without a signature",
    ]) {
      expect(
        classifySolanaTransactionError(
          flowError("signing", new Error(message)),
        ),
      ).toMatchObject({
        kind: "WALLET_INTEGRITY_FAILED",
        stage: "signing",
        signature: null,
        retryMode: "BLOCKED",
      });
    }
  });

  test("requires status inspection when an RPC error follows submission", () => {
    const result = classifySolanaTransactionError(
      flowError(
        "confirming",
        new Error("RPC service unavailable"),
        "sig-known",
      ),
    );
    expect(result.kind).toBe("RPC_UNAVAILABLE");
    expect(result.signature).toBe("sig-known");
    expect(result.retryMode).toBe("CHECK_STATUS_FIRST");
  });

  test("never presents an expired submitted transaction as a blind retry", () => {
    const result = classifySolanaTransactionError(
      flowError(
        "confirming",
        new SolanaTransactionExpiredError("block height exceeded"),
        "sig-expired",
      ),
    );
    expect(result.kind).toBe("EXPIRED");
    expect(result.retryMode).toBe("CHECK_STATUS_FIRST");
    expect(result.detail).toBe("block height exceeded");
  });

  test("distinguishes funding, simulation, and finalized program failures", () => {
    expect(
      classifySolanaTransactionError(
        flowError("sending", new Error("insufficient funds for fee")),
      ),
    ).toMatchObject({
      kind: "INSUFFICIENT_FUNDS",
      retryMode: "REVIEW_AND_RETRY",
    });
    expect(
      classifySolanaTransactionError(
        flowError("sending", new Error("Transaction simulation failed")),
      ),
    ).toMatchObject({
      kind: "SIMULATION_FAILED",
      retryMode: "REVIEW_AND_RETRY",
    });
    expect(
      classifySolanaTransactionError(
        flowError(
          "confirming",
          new Error("Transaction failed: InstructionError"),
        ),
      ),
    ).toMatchObject({ kind: "ONCHAIN_FAILED", retryMode: "BLOCKED" });
  });

  test("builds cluster-correct explorer links and omits localnet", () => {
    expect(buildSolanaExplorerTransactionUrl("sig/one", "mainnet-beta")).toBe(
      "https://explorer.solana.com/tx/sig%2Fone",
    );
    expect(buildSolanaExplorerTransactionUrl("sig", "devnet")).toBe(
      "https://explorer.solana.com/tx/sig?cluster=devnet",
    );
    expect(buildSolanaExplorerTransactionUrl("sig", "localnet")).toBeNull();
    expect(buildSolanaExplorerTransactionUrl(" ", "mainnet-beta")).toBeNull();
  });
});
