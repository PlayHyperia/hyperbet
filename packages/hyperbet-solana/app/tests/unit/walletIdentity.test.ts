import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";

import { deriveSolanaWalletSessionIdentity } from "../../src/lib/walletIdentity";

describe("Solana wallet session identity", () => {
  test("accepts one canonical address/public-key pair", () => {
    const keypair = Keypair.generate();
    const identity = deriveSolanaWalletSessionIdentity({
      address: keypair.publicKey.toBase58(),
      publicKey: keypair.publicKey.toBytes(),
    });

    expect(identity?.address).toBe(keypair.publicKey.toBase58());
    expect(identity?.publicKey.equals(keypair.publicKey)).toBe(true);
  });

  test("accepts an already decoded PublicKey", () => {
    const keypair = Keypair.generate();
    expect(
      deriveSolanaWalletSessionIdentity({
        address: keypair.publicKey.toBase58(),
        publicKey: keypair.publicKey,
      })?.publicKey.equals(keypair.publicKey),
    ).toBe(true);
  });

  test("rejects mismatched, malformed, and padded identities", () => {
    const first = Keypair.generate();
    const second = Keypair.generate();

    for (const input of [
      {
        address: first.publicKey.toBase58(),
        publicKey: second.publicKey.toBytes(),
      },
      { address: "not-an-address", publicKey: new Uint8Array(32) },
      {
        address: ` ${first.publicKey.toBase58()}`,
        publicKey: first.publicKey.toBytes(),
      },
      { address: first.publicKey.toBase58(), publicKey: "not-bytes" },
      { address: null, publicKey: first.publicKey.toBytes() },
    ]) {
      expect(deriveSolanaWalletSessionIdentity(input)).toBeNull();
    }
  });
});
