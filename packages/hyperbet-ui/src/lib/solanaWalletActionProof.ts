import { PublicKey } from "@solana/web3.js";

import type { SolanaCluster } from "./solanaConfig";

export type SolanaWalletAction = "invite-register" | "invite-redeem";

export type SolanaWalletActionMessageInput = {
  action: SolanaWalletAction;
  cluster: SolanaCluster;
  wallet: string;
  inviteCode: string | null;
  issuedAtMs: number;
};

export type SolanaWalletActionProof = {
  issuedAtMs: number;
  signature: string;
};

const VALID_INVITE_CODE = /^[A-Z0-9_-]{1,32}$/u;

function isCanonicalWallet(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

export function buildSolanaWalletActionMessage(
  input: SolanaWalletActionMessageInput,
): string {
  if (
    !isCanonicalWallet(input.wallet) ||
    !Number.isSafeInteger(input.issuedAtMs) ||
    input.issuedAtMs <= 0 ||
    (input.action === "invite-register"
      ? input.inviteCode !== null
      : typeof input.inviteCode !== "string" ||
        !VALID_INVITE_CODE.test(input.inviteCode))
  ) {
    throw new Error("Invalid Solana wallet action message input");
  }
  return [
    "Hyperbet Wallet Authorization",
    "Version: 1",
    `Action: ${input.action}`,
    `Cluster: ${input.cluster}`,
    `Wallet: ${input.wallet}`,
    `Invite Code: ${input.inviteCode ?? "none"}`,
    `Issued At (ms): ${input.issuedAtMs}`,
    "Statement: Authorize this Hyperbet points action. This cannot submit a transaction or move SOL.",
  ].join("\n");
}

function signatureToBase64(signature: Uint8Array): string {
  if (signature.length !== 64) {
    throw new Error("Wallet returned an invalid message signature");
  }
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function createSolanaWalletActionProof(input: {
  action: SolanaWalletAction;
  cluster: SolanaCluster;
  wallet: string;
  inviteCode: string | null;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  issuedAtMs?: number;
}): Promise<SolanaWalletActionProof> {
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const message = buildSolanaWalletActionMessage({
    action: input.action,
    cluster: input.cluster,
    wallet: input.wallet,
    inviteCode: input.inviteCode,
    issuedAtMs,
  });
  const signature = await input.signMessage(new TextEncoder().encode(message));
  return { issuedAtMs, signature: signatureToBase64(signature) };
}
