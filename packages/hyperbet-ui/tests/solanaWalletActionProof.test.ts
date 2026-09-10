import { describe, expect, test } from "bun:test";

import {
  buildSolanaWalletActionMessage,
  createSolanaWalletActionProof,
} from "../src/lib/solanaWalletActionProof";

const wallet = "11111111111111111111111111111111";
const issuedAtMs = 1_800_000_000_000;

describe("Solana wallet action proof client", () => {
  test("matches the server's exact human-readable contract", () => {
    expect(
      buildSolanaWalletActionMessage({
        action: "invite-redeem",
        cluster: "mainnet-beta",
        wallet,
        inviteCode: "HS12AB34CD",
        issuedAtMs,
      }),
    ).toBe(
      [
        "Hyperbet Wallet Authorization",
        "Version: 1",
        "Action: invite-redeem",
        "Cluster: mainnet-beta",
        `Wallet: ${wallet}`,
        "Invite Code: HS12AB34CD",
        `Issued At (ms): ${issuedAtMs}`,
        "Statement: Authorize this Hyperbet points action. This cannot submit a transaction or move SOL.",
      ].join("\n"),
    );
  });

  test("signs the exact bytes and emits a canonical Ed25519 signature", async () => {
    let signedMessage = "";
    const proof = await createSolanaWalletActionProof({
      action: "invite-register",
      cluster: "localnet",
      wallet,
      inviteCode: null,
      issuedAtMs,
      signMessage: async (message) => {
        signedMessage = new TextDecoder().decode(message);
        return new Uint8Array(64).fill(7);
      },
    });
    expect(signedMessage).toContain("Action: invite-register");
    expect(signedMessage).toContain("Invite Code: none");
    expect(proof).toEqual({
      issuedAtMs,
      signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(7))),
    });
  });

  test("rejects ambiguous inputs and invalid signature lengths", async () => {
    expect(() =>
      buildSolanaWalletActionMessage({
        action: "invite-redeem",
        cluster: "mainnet-beta",
        wallet,
        inviteCode: "invalid code",
        issuedAtMs,
      }),
    ).toThrow(/Invalid Solana wallet action/u);
    await expect(
      createSolanaWalletActionProof({
        action: "invite-register",
        cluster: "localnet",
        wallet,
        inviteCode: null,
        issuedAtMs,
        signMessage: async () => new Uint8Array(63),
      }),
    ).rejects.toThrow(/invalid message signature/u);
  });
});
