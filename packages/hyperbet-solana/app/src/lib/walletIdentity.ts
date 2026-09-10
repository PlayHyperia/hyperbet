import type { Address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";

export type SolanaWalletSessionIdentity = {
  address: Address;
  publicKey: PublicKey;
};

/**
 * Accept a wallet session only when both identity representations are exact,
 * canonical, and refer to the same Solana public key.
 */
export function deriveSolanaWalletSessionIdentity(input: {
  address: unknown;
  publicKey: unknown;
}): SolanaWalletSessionIdentity | null {
  if (
    typeof input.address !== "string" ||
    input.address.length === 0 ||
    input.address.trim() !== input.address
  ) {
    return null;
  }

  if (
    !(input.publicKey instanceof PublicKey) &&
    !(input.publicKey instanceof Uint8Array)
  ) {
    return null;
  }

  try {
    const addressPublicKey = new PublicKey(input.address);
    const sessionPublicKey =
      input.publicKey instanceof PublicKey
        ? input.publicKey
        : new PublicKey(input.publicKey);
    if (
      addressPublicKey.toBase58() !== input.address ||
      !addressPublicKey.equals(sessionPublicKey)
    ) {
      return null;
    }

    return {
      address: input.address as Address,
      publicKey: sessionPublicKey,
    };
  } catch {
    return null;
  }
}
