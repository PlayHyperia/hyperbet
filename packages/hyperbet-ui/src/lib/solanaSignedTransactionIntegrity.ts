import { ed25519 } from "@noble/curves/ed25519.js";

export type SolanaSignedTransactionIntegrityReason =
  | null
  | "invalid-input"
  | "message-mismatch"
  | "missing-signature"
  | "invalid-signature";

export type SolanaSignedTransactionIntegrity = {
  valid: boolean;
  reason: SolanaSignedTransactionIntegrityReason;
};

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/**
 * Proves that a wallet signed the exact transaction message the application
 * prepared. A wallet-returned message is never trusted merely because it has a
 * syntactically valid transaction signature.
 */
export function inspectSolanaSignedTransactionIntegrity(input: {
  expectedMessage: Uint8Array;
  signedMessage: Uint8Array;
  signature: Uint8Array | null;
  expectedSignerPublicKey: Uint8Array;
}): SolanaSignedTransactionIntegrity {
  if (
    input.expectedMessage.length === 0 ||
    input.signedMessage.length === 0 ||
    input.expectedSignerPublicKey.length !== 32
  ) {
    return { valid: false, reason: "invalid-input" };
  }
  if (!equalBytes(input.expectedMessage, input.signedMessage)) {
    return { valid: false, reason: "message-mismatch" };
  }
  if (input.signature === null) {
    return { valid: false, reason: "missing-signature" };
  }
  if (input.signature.length !== 64) {
    return { valid: false, reason: "invalid-signature" };
  }
  try {
    if (
      !ed25519.verify(
        input.signature,
        input.signedMessage,
        input.expectedSignerPublicKey,
      )
    ) {
      return { valid: false, reason: "invalid-signature" };
    }
  } catch {
    return { valid: false, reason: "invalid-signature" };
  }
  return { valid: true, reason: null };
}
