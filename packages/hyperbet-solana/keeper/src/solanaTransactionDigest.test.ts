import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";

import { digestFinalizedSolanaTransaction } from "./solanaTransactionDigest";

describe("finalized SOL transaction evidence digest", () => {
  test("is stable across provider object-key order without changing arrays", () => {
    const key = Keypair.generate().publicKey;
    const left = {
      slot: 42,
      transaction: {
        signatures: ["primary", "secondary"],
        message: {
          accountKeys: [{ pubkey: key, signer: true }],
          bytes: new Uint8Array([1, 2, 3]),
        },
      },
      amount: 123n,
    };
    const reordered = {
      amount: 123n,
      transaction: {
        message: {
          bytes: new Uint8Array([1, 2, 3]),
          accountKeys: [{ signer: true, pubkey: key }],
        },
        signatures: ["primary", "secondary"],
      },
      slot: 42,
    };
    expect(digestFinalizedSolanaTransaction(left)).toBe(
      digestFinalizedSolanaTransaction(reordered),
    );
    expect(
      digestFinalizedSolanaTransaction({
        ...left,
        transaction: {
          ...left.transaction,
          signatures: ["secondary", "primary"],
        },
      }),
    ).not.toBe(digestFinalizedSolanaTransaction(left));
  });

  test("fails closed on cyclic and hostile RPC evidence", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => digestFinalizedSolanaTransaction(cyclic)).toThrow();
    expect(() =>
      digestFinalizedSolanaTransaction({
        get slot() {
          throw new Error("hostile transaction");
        },
      }),
    ).toThrow();
  });
});
