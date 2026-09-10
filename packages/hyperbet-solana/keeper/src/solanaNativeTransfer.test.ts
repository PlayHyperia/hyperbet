import { describe, expect, test } from "bun:test";
import { Keypair, SystemProgram } from "@solana/web3.js";

import { decodeExactNativeTransferInstruction } from "./solanaNativeTransfer";

describe("finalized SOL native-transfer decoding", () => {
  test("accepts only a canonical positive System Program transfer", () => {
    const source = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    expect(
      decodeExactNativeTransferInstruction({
        program: "system",
        programId: SystemProgram.programId,
        parsed: {
          type: "transfer",
          info: { source, destination, lamports: "123" },
        },
      }),
    ).toEqual({
      kind: "transfer",
      transfer: { source, destination, lamports: 123n },
    });
  });

  test("distinguishes valid nontransfer instructions from invalid evidence", () => {
    const otherProgram = Keypair.generate().publicKey.toBase58();
    expect(
      decodeExactNativeTransferInstruction({
        program: "system",
        programId: SystemProgram.programId,
        parsed: { type: "createAccount", info: {} },
      }),
    ).toEqual({ kind: "irrelevant" });
    expect(
      decodeExactNativeTransferInstruction({
        programId: otherProgram,
        accounts: [],
        data: "instruction-data",
      }),
    ).toEqual({ kind: "irrelevant" });
  });

  test("rejects non-system lookalikes and malformed or hostile transfers", () => {
    const source = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    const transfer = {
      program: "system",
      programId: SystemProgram.programId.toBase58(),
      parsed: {
        type: "transfer",
        info: { source, destination, lamports: 1 },
      },
    };
    for (const malformed of [
      null,
      {},
      { ...transfer, program: "spl-token" },
      { ...transfer, programId: Keypair.generate().publicKey.toBase58() },
      { ...transfer, programId: ` ${SystemProgram.programId.toBase58()}` },
      { ...transfer, parsed: null },
      { ...transfer, parsed: { type: "transfer", info: null } },
      {
        ...transfer,
        parsed: {
          type: "transfer",
          info: { source: ` ${source}`, destination, lamports: 1 },
        },
      },
      {
        ...transfer,
        parsed: {
          type: "transfer",
          info: { source, destination, lamports: 0 },
        },
      },
      {
        ...transfer,
        parsed: {
          type: "transfer",
          info: { source, destination, lamports: "01" },
        },
      },
      { programId: SystemProgram.programId, accounts: [], data: "hidden" },
      {
        ...transfer,
        get parsed() {
          throw new Error("hostile parsed instruction");
        },
      },
    ]) {
      expect(decodeExactNativeTransferInstruction(malformed)).toEqual({
        kind: "invalid",
      });
    }
  });
});
