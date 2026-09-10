import {
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

import { PublicKey } from "@solana/web3.js";

export type SolanaWalletAction = "invite-register" | "invite-redeem";

export type SolanaWalletActionMessageInput = {
  action: SolanaWalletAction;
  cluster: string;
  wallet: string;
  inviteCode: string | null;
  issuedAtMs: number;
};

export type SolanaWalletActionProofInput = SolanaWalletActionMessageInput & {
  signature: string;
};

export type SolanaWalletActionProofResult =
  | { ok: true; message: string }
  | {
      ok: false;
      reason:
        "invalid-input" | "invalid-signature" | "expired" | "future-issued";
    };

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_PROOF_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const VALID_CLUSTERS = new Set([
  "localnet",
  "devnet",
  "testnet",
  "mainnet-beta",
]);
const VALID_INVITE_CODE = /^[A-Z0-9_-]{1,32}$/u;

function canonicalWallet(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const canonical = new PublicKey(value).toBase58();
    return canonical === value ? canonical : null;
  } catch {
    return null;
  }
}

function isValidMessageInput(input: SolanaWalletActionMessageInput): boolean {
  if (!VALID_CLUSTERS.has(input.cluster)) return false;
  if (!canonicalWallet(input.wallet)) return false;
  if (!Number.isSafeInteger(input.issuedAtMs) || input.issuedAtMs <= 0) {
    return false;
  }
  if (input.action === "invite-register") return input.inviteCode === null;
  return (
    typeof input.inviteCode === "string" &&
    VALID_INVITE_CODE.test(input.inviteCode)
  );
}

export function buildSolanaWalletActionMessage(
  input: SolanaWalletActionMessageInput,
): string {
  if (!isValidMessageInput(input)) {
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

function readCanonicalSignature(value: string): Buffer | null {
  if (
    !value ||
    value !== value.trim() ||
    value.length !== 88 ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64) return null;
  const canonical = Buffer.from(decoded.toString("base64"));
  const received = Buffer.from(value);
  return canonical.length === received.length &&
    timingSafeEqual(canonical, received)
    ? decoded
    : null;
}

export function verifySolanaWalletActionProof(
  input: SolanaWalletActionProofInput,
  nowMs = Date.now(),
): SolanaWalletActionProofResult {
  if (!isValidMessageInput(input) || !Number.isSafeInteger(nowMs)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (input.issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: "future-issued" };
  }
  if (nowMs - input.issuedAtMs > MAX_PROOF_AGE_MS) {
    return { ok: false, reason: "expired" };
  }

  const signature = readCanonicalSignature(input.signature);
  if (!signature) return { ok: false, reason: "invalid-signature" };

  const message = buildSolanaWalletActionMessage(input);
  try {
    const walletBytes = new PublicKey(input.wallet).toBuffer();
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, walletBytes]),
      format: "der",
      type: "spki",
    });
    if (
      !verifySignature(null, Buffer.from(message, "utf8"), publicKey, signature)
    ) {
      return { ok: false, reason: "invalid-signature" };
    }
  } catch {
    return { ok: false, reason: "invalid-signature" };
  }

  return { ok: true, message };
}
