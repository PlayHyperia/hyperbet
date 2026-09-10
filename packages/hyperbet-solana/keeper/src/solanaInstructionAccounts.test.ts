import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";

import {
  exactInstructionAccountAddresses,
  exactSolanaPublicKeyAddress,
  exactTransactionSignerAddresses,
} from "./solanaInstructionAccounts";

describe("finalized SOL instruction account positions", () => {
  test("preserves every canonical address, duplicate, and position", () => {
    const first = Keypair.generate().publicKey;
    const second = Keypair.generate().publicKey;
    expect(
      exactInstructionAccountAddresses([
        first.toBase58(),
        { pubkey: second.toBase58() },
        { pubkey: first },
        second,
        first.toBase58(),
      ]),
    ).toEqual([
      first.toBase58(),
      second.toBase58(),
      first.toBase58(),
      second.toBase58(),
      first.toBase58(),
    ]);
  });

  test("rejects one malformed position instead of shifting later accounts", () => {
    const canonical = Keypair.generate().publicKey.toBase58();
    for (const malformed of [
      null,
      undefined,
      "",
      ` ${canonical}`,
      "not-base58",
      {},
      { pubkey: null },
      { pubkey: "not-base58" },
      { toBase58: () => "not-base58" },
      {
        toBase58: () => {
          throw new Error("hostile address");
        },
      },
      new Proxy(
        {},
        {
          has: () => {
            throw new Error("hostile account");
          },
        },
      ),
    ]) {
      expect(
        exactInstructionAccountAddresses([canonical, malformed, canonical]),
      ).toBeNull();
    }
    expect(exactInstructionAccountAddresses(null)).toBeNull();
    expect(exactInstructionAccountAddresses({ 0: canonical })).toBeNull();
    expect(exactSolanaPublicKeyAddress(canonical)).toBe(canonical);
    expect(exactSolanaPublicKeyAddress(` ${canonical}`)).toBeNull();
  });

  test("accepts only canonical account keys with exact boolean signer authority", () => {
    const signer = Keypair.generate().publicKey.toBase58();
    const nonsigner = Keypair.generate().publicKey;
    expect(
      exactTransactionSignerAddresses(
        [
          { pubkey: signer, signer: true, writable: true },
          { pubkey: nonsigner, signer: false, writable: false },
        ],
        1,
      ),
    ).toEqual([signer]);
  });

  test("requires signers to be the exact signature-count prefix", () => {
    const first = Keypair.generate().publicKey.toBase58();
    const second = Keypair.generate().publicKey.toBase58();
    const entries = [
      { pubkey: first, signer: true },
      { pubkey: second, signer: false },
    ];
    expect(exactTransactionSignerAddresses(entries, 1)).toEqual([first]);
    expect(exactTransactionSignerAddresses(entries, 0)).toBeNull();
    expect(exactTransactionSignerAddresses(entries, 2)).toBeNull();
    expect(
      exactTransactionSignerAddresses(
        [
          { pubkey: first, signer: false },
          { pubkey: second, signer: true },
        ],
        1,
      ),
    ).toBeNull();
    expect(exactTransactionSignerAddresses(entries, -1)).toBeNull();
    expect(exactTransactionSignerAddresses(entries, 1.5)).toBeNull();
  });

  test("rejects malformed signer metadata instead of treating truthy values as signatures", () => {
    const signer = Keypair.generate().publicKey.toBase58();
    for (const malformedSigner of ["true", "false", 1, 0, null, undefined]) {
      expect(
        exactTransactionSignerAddresses(
          [{ pubkey: signer, signer: malformedSigner }],
          1,
        ),
      ).toBeNull();
    }
    for (const malformedAccount of [
      null,
      signer,
      { signer: true },
      { pubkey: ` ${signer}`, signer: true },
      {
        get signer() {
          throw new Error("hostile signer flag");
        },
        pubkey: signer,
      },
      {
        get pubkey() {
          throw new Error("hostile account key");
        },
        signer: true,
      },
    ]) {
      expect(exactTransactionSignerAddresses([malformedAccount], 1)).toBeNull();
    }
    expect(exactTransactionSignerAddresses(null, 1)).toBeNull();
    expect(exactTransactionSignerAddresses({ 0: signer }, 1)).toBeNull();
  });
});
