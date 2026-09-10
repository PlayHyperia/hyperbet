import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import {
  buildSolanaWalletActionMessage,
  verifySolanaWalletActionProof,
  type SolanaWalletActionMessageInput,
} from "./solanaWalletActionProof";

const nowMs = 1_800_000_000_000;
const keyPair = generateKeyPairSync("ed25519");
const publicKeyDer = keyPair.publicKey.export({
  format: "der",
  type: "spki",
});
const wallet = new PublicKey(publicKeyDer.subarray(-32)).toBase58();

function proof(input: SolanaWalletActionMessageInput) {
  const message = buildSolanaWalletActionMessage(input);
  return {
    ...input,
    signature: sign(null, Buffer.from(message), keyPair.privateKey).toString(
      "base64",
    ),
  };
}

describe("Solana wallet action proof", () => {
  test("uses one exact human-readable authorization contract", () => {
    expect(
      buildSolanaWalletActionMessage({
        action: "invite-redeem",
        cluster: "mainnet-beta",
        wallet,
        inviteCode: "HS12AB34CD",
        issuedAtMs: nowMs,
      }),
    ).toBe(
      [
        "Hyperbet Wallet Authorization",
        "Version: 1",
        "Action: invite-redeem",
        "Cluster: mainnet-beta",
        `Wallet: ${wallet}`,
        "Invite Code: HS12AB34CD",
        `Issued At (ms): ${nowMs}`,
        "Statement: Authorize this Hyperbet points action. This cannot submit a transaction or move SOL.",
      ].join("\n"),
    );
  });

  test("accepts valid register and redeem signatures", () => {
    for (const input of [
      {
        action: "invite-register" as const,
        cluster: "localnet",
        wallet,
        inviteCode: null,
        issuedAtMs: nowMs,
      },
      {
        action: "invite-redeem" as const,
        cluster: "mainnet-beta",
        wallet,
        inviteCode: "HS12AB34CD",
        issuedAtMs: nowMs,
      },
    ]) {
      expect(verifySolanaWalletActionProof(proof(input), nowMs).ok).toBe(true);
    }
  });

  test("rejects tampering, stale/future proofs, and noncanonical signatures", () => {
    const valid = proof({
      action: "invite-redeem",
      cluster: "mainnet-beta",
      wallet,
      inviteCode: "HS12AB34CD",
      issuedAtMs: nowMs,
    });
    expect(
      verifySolanaWalletActionProof(
        { ...valid, inviteCode: "HSFFFFFFFF" },
        nowMs,
      ),
    ).toEqual({ ok: false, reason: "invalid-signature" });
    expect(
      verifySolanaWalletActionProof(valid, nowMs + 5 * 60_000 + 1),
    ).toEqual({ ok: false, reason: "expired" });
    expect(verifySolanaWalletActionProof(valid, nowMs - 30_001)).toEqual({
      ok: false,
      reason: "future-issued",
    });
    expect(
      verifySolanaWalletActionProof(
        { ...valid, signature: ` ${valid.signature}` },
        nowMs,
      ),
    ).toEqual({ ok: false, reason: "invalid-signature" });
    expect(() =>
      buildSolanaWalletActionMessage({
        ...valid,
        inviteCode: "invalid code",
      }),
    ).toThrow(/Invalid Solana wallet action/u);
  });
});
