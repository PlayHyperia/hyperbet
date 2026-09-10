import { describe, expect, test } from "bun:test";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  decodeSenderTransaction,
  isWhitelistedSenderTransaction,
} from "./solanaSenderProxyPolicy";

const payer = Keypair.generate();
const hyperbetProgram = Keypair.generate().publicKey;
const hyperbetPrograms = new Set([hyperbetProgram.toBase58()]);
const recentBlockhash = Keypair.generate().publicKey.toBase58();

function encodedTransaction(
  instructions: ConstructorParameters<typeof TransactionInstruction>[0][],
): string {
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash,
  });
  for (const instruction of instructions) {
    transaction.add(new TransactionInstruction(instruction));
  }
  transaction.sign(payer);
  return transaction.serialize().toString("base64");
}

describe("Solana Sender proxy transaction policy", () => {
  test("accepts the app's compute-budget, tip, and Hyperbet instruction shape", () => {
    const recipient = Keypair.generate().publicKey;
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: 1,
      }),
      new TransactionInstruction({
        programId: hyperbetProgram,
        keys: [],
        data: Buffer.from([1]),
      }),
    );
    transaction.sign(payer);

    expect(
      isWhitelistedSenderTransaction(
        decodeSenderTransaction(transaction.serialize().toString("base64")),
        hyperbetPrograms,
      ),
    ).toBe(true);
  });

  test("rejects transactions without a Hyperbet instruction", () => {
    const encoded = encodedTransaction([
      {
        programId: SystemProgram.programId,
        keys: [],
        data: Buffer.alloc(0),
      },
    ]);
    expect(
      isWhitelistedSenderTransaction(
        decodeSenderTransaction(encoded),
        hyperbetPrograms,
      ),
    ).toBe(false);
  });

  test("rejects an unrelated top-level program even when Hyperbet is present", () => {
    const encoded = encodedTransaction([
      {
        programId: hyperbetProgram,
        keys: [],
        data: Buffer.from([1]),
      },
      {
        programId: Keypair.generate().publicKey,
        keys: [],
        data: Buffer.from([2]),
      },
    ]);
    expect(
      isWhitelistedSenderTransaction(
        decodeSenderTransaction(encoded),
        hyperbetPrograms,
      ),
    ).toBe(false);
  });
});
