import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AccountInfo, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  deriveProgramDataAddress,
  resolveClusterExpectedUpgradeAuthority,
  resolveExpectedUpgradeAuthority,
  verifyUpgradeableProgramIdentity,
} from "./solanaProgramIdentity";

function key(byte: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, byte));
}

function account(
  data: Buffer,
  options: { executable?: boolean; owner?: PublicKey } = {},
): AccountInfo<Buffer> {
  return {
    data,
    executable: options.executable ?? false,
    lamports: 1,
    owner: options.owner ?? BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    rentEpoch: 0,
  };
}

function programAccount(programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  deriveProgramDataAddress(programId).toBuffer().copy(data, 4);
  return account(data, { executable: true });
}

function programDataAccount(authority: PublicKey | null): AccountInfo<Buffer> {
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(42n, 4);
  if (authority) {
    data.writeUInt8(1, 12);
    authority.toBuffer().copy(data, 13);
  }
  return account(data);
}

describe("Solana launch program identity", () => {
  test("verifies executable loader ownership, canonical ProgramData, and authority", () => {
    const programId = key(1);
    const authority = key(2);
    const result = verifyUpgradeableProgramIdentity({
      label: "fight oracle",
      programId,
      programAccount: programAccount(programId),
      programDataAccount: programDataAccount(authority),
      expectedUpgradeAuthority: authority,
    });
    expect(result.programDataAddress).toEqual(
      deriveProgramDataAddress(programId),
    );
    expect(result.upgradeAuthority).toEqual(authority);
    expect(result.deployedSlot).toBe(42n);
  });

  test("supports an explicitly immutable launch program", () => {
    const programId = key(3);
    expect(
      verifyUpgradeableProgramIdentity({
        label: "duel market",
        programId,
        programAccount: programAccount(programId),
        programDataAccount: programDataAccount(null),
        expectedUpgradeAuthority: null,
      }).upgradeAuthority,
    ).toBeNull();
  });

  test("rejects absent, non-executable, and wrong-loader program accounts", () => {
    const programId = key(4);
    const dataAccount = programDataAccount(key(5));
    expect(() =>
      verifyUpgradeableProgramIdentity({
        label: "duel market",
        programId,
        programAccount: null,
        programDataAccount: dataAccount,
        expectedUpgradeAuthority: undefined,
      }),
    ).toThrow("is absent");
    expect(() =>
      verifyUpgradeableProgramIdentity({
        label: "duel market",
        programId,
        programAccount: account(programAccount(programId).data),
        programDataAccount: dataAccount,
        expectedUpgradeAuthority: undefined,
      }),
    ).toThrow("is not executable");
    expect(() =>
      verifyUpgradeableProgramIdentity({
        label: "duel market",
        programId,
        programAccount: account(programAccount(programId).data, {
          executable: true,
          owner: SystemProgram.programId,
        }),
        programDataAccount: dataAccount,
        expectedUpgradeAuthority: undefined,
      }),
    ).toThrow("not owned by the upgradeable loader");
  });

  test("rejects non-canonical ProgramData and authority drift", () => {
    const programId = key(6);
    const wrongProgramAccount = programAccount(programId);
    key(7).toBuffer().copy(wrongProgramAccount.data, 4);
    expect(() =>
      verifyUpgradeableProgramIdentity({
        label: "fight oracle",
        programId,
        programAccount: wrongProgramAccount,
        programDataAccount: programDataAccount(key(8)),
        expectedUpgradeAuthority: undefined,
      }),
    ).toThrow("non-canonical ProgramData");
    expect(() =>
      verifyUpgradeableProgramIdentity({
        label: "fight oracle",
        programId,
        programAccount: programAccount(programId),
        programDataAccount: programDataAccount(key(8)),
        expectedUpgradeAuthority: key(9),
      }),
    ).toThrow("does not match");
  });

  test("requires an explicit authority policy when requested and rejects the zero key", () => {
    expect(() =>
      resolveExpectedUpgradeAuthority({
        value: undefined,
        required: true,
        label: "fight oracle",
      }),
    ).toThrow("required for this launch rail");
    expect(
      resolveExpectedUpgradeAuthority({
        value: "immutable",
        required: true,
        label: "fight oracle",
      }),
    ).toBeNull();
    expect(() =>
      resolveExpectedUpgradeAuthority({
        value: PublicKey.default.toBase58(),
        required: true,
        label: "fight oracle",
      }),
    ).toThrow("cannot be zero");
  });

  test("permits an unchecked authority only on exact localnet", () => {
    expect(
      resolveClusterExpectedUpgradeAuthority({
        cluster: " localnet ",
        value: undefined,
        label: "fight oracle",
      }),
    ).toBeUndefined();

    const authority = key(11);
    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(() =>
        resolveClusterExpectedUpgradeAuthority({
          cluster,
          value: undefined,
          label: "fight oracle",
        }),
      ).toThrow("required for this launch rail");
      expect(
        resolveClusterExpectedUpgradeAuthority({
          cluster,
          value: authority.toBase58(),
          label: "fight oracle",
        }),
      ).toEqual(authority);
      expect(
        resolveClusterExpectedUpgradeAuthority({
          cluster,
          value: "immutable",
          label: "fight oracle",
        }),
      ).toBeNull();
    }
  });

  test("rejects unknown program-identity rails", () => {
    expect(() =>
      resolveClusterExpectedUpgradeAuthority({
        cluster: "solana",
        value: key(12).toBase58(),
        label: "fight oracle",
      }),
    ).toThrow("Unsupported Solana program-identity cluster");
  });

  test("wires both runtime programs through the cluster-aware authority policy", () => {
    for (const relativePath of ["./duelBot.ts", "./service.ts"]) {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );
      expect(
        source.match(/resolveClusterExpectedUpgradeAuthority\(\{/g),
      ).toHaveLength(2);
    }
  });
});
