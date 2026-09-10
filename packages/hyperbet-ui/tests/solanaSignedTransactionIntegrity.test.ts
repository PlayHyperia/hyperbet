import { describe, expect, test } from "bun:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";

import { inspectSolanaSignedTransactionIntegrity } from "../src/lib/solanaSignedTransactionIntegrity";

function signedFixture() {
  const signer = Keypair.generate();
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 123,
    }),
  );
  const expectedMessage = transaction.serializeMessage();
  transaction.partialSign(signer);
  return { expectedMessage, signer, transaction };
}

describe("Solana signed transaction integrity", () => {
  test("accepts the exact reviewed message signed by the expected wallet", () => {
    const { expectedMessage, signer, transaction } = signedFixture();

    expect(
      inspectSolanaSignedTransactionIntegrity({
        expectedMessage,
        signedMessage: transaction.serializeMessage(),
        signature: transaction.signature,
        expectedSignerPublicKey: signer.publicKey.toBytes(),
      }),
    ).toEqual({ valid: true, reason: null });
  });

  test("rejects a wallet-returned message change before submission", () => {
    const { expectedMessage, signer, transaction } = signedFixture();
    const changedMessage = Uint8Array.from(transaction.serializeMessage());
    changedMessage[changedMessage.length - 1] ^= 1;

    expect(
      inspectSolanaSignedTransactionIntegrity({
        expectedMessage,
        signedMessage: changedMessage,
        signature: transaction.signature,
        expectedSignerPublicKey: signer.publicKey.toBytes(),
      }),
    ).toEqual({ valid: false, reason: "message-mismatch" });
  });

  test("rejects a missing, malformed, corrupted, or wrong-wallet signature", () => {
    const { expectedMessage, signer, transaction } = signedFixture();
    const signedMessage = transaction.serializeMessage();
    const corruptedSignature = Uint8Array.from(transaction.signature!);
    corruptedSignature[0] ^= 1;

    for (const entry of [
      {
        signature: null,
        expectedSignerPublicKey: signer.publicKey.toBytes(),
        reason: "missing-signature",
      },
      {
        signature: new Uint8Array(63),
        expectedSignerPublicKey: signer.publicKey.toBytes(),
        reason: "invalid-signature",
      },
      {
        signature: corruptedSignature,
        expectedSignerPublicKey: signer.publicKey.toBytes(),
        reason: "invalid-signature",
      },
      {
        signature: transaction.signature,
        expectedSignerPublicKey: Keypair.generate().publicKey.toBytes(),
        reason: "invalid-signature",
      },
    ] as const) {
      expect(
        inspectSolanaSignedTransactionIntegrity({
          expectedMessage,
          signedMessage,
          signature: entry.signature,
          expectedSignerPublicKey: entry.expectedSignerPublicKey,
        }),
      ).toEqual({ valid: false, reason: entry.reason });
    }
  });
});
