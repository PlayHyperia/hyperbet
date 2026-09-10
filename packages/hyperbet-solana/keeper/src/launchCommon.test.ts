import { afterEach, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  DUEL_WINNER_MARKET_KIND,
  duelKeyHexToBytes,
  enumIs,
  FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
  findClobVaultPda,
  findDuelStatePda,
  findMarketPda,
  findOrderPda,
  findPriceLevelPda,
  findProposalRecordPda,
  findUserBalancePda,
  getRpcWsUrl,
  ORDER_BEHAVIOR_POST_ONLY,
  requireEnv,
  sanitizeErrorMessage,
  SIDE_BID,
} from "./launchCommon";

const TEST_ENV = "HYPERIA_LAUNCH_COMMON_TEST_VALUE";

afterEach(() => {
  delete process.env[TEST_ENV];
  delete process.env.SOLANA_RPC_WS_URL;
  delete process.env.SOLANA_WS_URL;
});

describe("launch-only Solana helpers", () => {
  test("keeps keeper order behavior aligned with the deployed program ABI", () => {
    expect(ORDER_BEHAVIOR_POST_ONLY).toBe(2);
  });

  test("re-exports the exact fight-oracle account schema contract", () => {
    expect(FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION).toBe(2);
  });

  test("validates and decodes canonical 32-byte duel keys", () => {
    const value = "ab".repeat(32);
    expect(Buffer.from(duelKeyHexToBytes(value)).toString("hex")).toBe(value);
    expect(() => duelKeyHexToBytes("ab")).toThrow("32-byte hex string");
  });

  test("derives the canonical duel and CLOB account graph", () => {
    const oracleProgram = Keypair.generate().publicKey;
    const marketProgram = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const duelKey = duelKeyHexToBytes("01".repeat(32));
    const duel = findDuelStatePda(oracleProgram, duelKey);
    const market = findMarketPda(marketProgram, duel, DUEL_WINNER_MARKET_KIND);

    expect(duel.toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), Buffer.from(duelKey)],
        oracleProgram,
      )[0].toBase58(),
    );
    expect(market.toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          duel.toBuffer(),
          Uint8Array.of(DUEL_WINNER_MARKET_KIND),
        ],
        marketProgram,
      )[0].toBase58(),
    );
    const resultHash = Uint8Array.from({ length: 32 }, (_, index) => index);
    const replayHash = Uint8Array.from(
      { length: 32 },
      (_, index) => 255 - index,
    );
    expect(
      findProposalRecordPda(
        oracleProgram,
        duelKey,
        resultHash,
        replayHash,
      ).toBase58(),
    ).toBe(
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("proposal"),
          Buffer.from(duelKey),
          Buffer.from(resultHash),
          Buffer.from(replayHash),
        ],
        oracleProgram,
      )[0].toBase58(),
    );
    expect(findClobVaultPda(marketProgram, market)).toBeInstanceOf(PublicKey);
    expect(findUserBalancePda(marketProgram, market, owner)).toBeInstanceOf(
      PublicKey,
    );
    expect(findOrderPda(marketProgram, market, 2n ** 63n)).toBeInstanceOf(
      PublicKey,
    );
    expect(
      findPriceLevelPda(marketProgram, market, SIDE_BID, 500),
    ).toBeInstanceOf(PublicKey);
  });

  test("recognizes Anchor enum variants without accepting malformed values", () => {
    expect(enumIs({ bettingOpen: {} }, "bettingOpen")).toBe(true);
    expect(enumIs({ locked: {} }, "bettingOpen")).toBe(false);
    expect(enumIs(null, "bettingOpen")).toBe(false);
  });

  test("fails closed on missing required environment and trims present values", () => {
    expect(() => requireEnv(TEST_ENV)).toThrow(
      `Missing environment variable: ${TEST_ENV}`,
    );
    process.env[TEST_ENV] = "  configured  ";
    expect(requireEnv(TEST_ENV)).toBe("configured");
  });

  test("redacts keyed RPC URLs from errors", () => {
    expect(
      sanitizeErrorMessage(
        new Error("RPC https://example.test/?api-key=top-secret&x=1 failed"),
      ),
    ).toBe("RPC https://example.test/?api-key=***&x=1 failed");
    expect(
      sanitizeErrorMessage(
        new Error(
          "RPC https://example.test/?token=url-secret&x=1 failed; Authorization: Bearer header-secret; credential=inline-secret",
        ),
      ),
    ).toBe(
      "RPC https://example.test/?token=***&x=1 failed; Authorization: Bearer ***; credential=***",
    );
  });

  test("uses an explicit RPC websocket endpoint without inventing one", () => {
    expect(getRpcWsUrl()).toBeUndefined();
    process.env.SOLANA_WS_URL = "  ws://fallback.test:8900  ";
    expect(getRpcWsUrl()).toBe("ws://fallback.test:8900");
    process.env.SOLANA_RPC_WS_URL = "  ws://preferred.test:9900  ";
    expect(getRpcWsUrl()).toBe("ws://preferred.test:9900");
  });
});
