import { SystemProgram } from "@solana/web3.js";

import { exactSolanaPublicKeyAddress } from "./solanaInstructionAccounts";
import { toU64Like } from "./solanaSafeInteger";

export type ExactNativeTransfer = {
  source: string;
  destination: string;
  lamports: bigint;
};

export type ExactNativeTransferInstruction =
  | { kind: "irrelevant" }
  | { kind: "invalid" }
  | { kind: "transfer"; transfer: ExactNativeTransfer };

export function decodeExactNativeTransferInstruction(
  value: unknown,
): ExactNativeTransferInstruction {
  try {
    if (typeof value !== "object" || value === null) {
      return { kind: "invalid" };
    }
    const record = value as {
      program?: unknown;
      programId?: unknown;
      parsed?: unknown;
    };
    const programId = exactSolanaPublicKeyAddress(record.programId);
    if (!programId) return { kind: "invalid" };
    if (!("parsed" in record)) {
      return programId === SystemProgram.programId.toBase58()
        ? { kind: "invalid" }
        : { kind: "irrelevant" };
    }
    if (typeof record.parsed !== "object" || record.parsed === null) {
      return { kind: "invalid" };
    }
    const parsed = record.parsed as {
      type?: unknown;
      info?: unknown;
    };
    if (parsed.type !== "transfer") return { kind: "irrelevant" };
    if (
      record.program !== "system" ||
      programId !== SystemProgram.programId.toBase58() ||
      typeof parsed.info !== "object" ||
      parsed.info === null ||
      Array.isArray(parsed.info)
    ) {
      return { kind: "invalid" };
    }
    const info = parsed.info as {
      source?: unknown;
      destination?: unknown;
      lamports?: unknown;
    };
    const source = exactSolanaPublicKeyAddress(info.source);
    const destination = exactSolanaPublicKeyAddress(info.destination);
    const lamports = toU64Like(info.lamports);
    if (!source || !destination || lamports === null || lamports <= 0n) {
      return { kind: "invalid" };
    }
    return {
      kind: "transfer",
      transfer: { source, destination, lamports },
    };
  } catch {
    return { kind: "invalid" };
  }
}
