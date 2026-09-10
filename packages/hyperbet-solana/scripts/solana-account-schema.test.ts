import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { type AccountInfo, PublicKey } from "@solana/web3.js";

import {
  deriveFightOracleConfigPda,
  evaluateFightOracleAccountSchema,
  FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
  ORACLE_CONFIG_SCHEMA_VERSION_OFFSET,
  ORACLE_CONFIG_V1_ACCOUNT_SIZE,
  ORACLE_CONFIG_V2_ACCOUNT_SIZE,
} from "./solana-account-schema";

const programId = new PublicKey("FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu");
const oracleConfigDiscriminator = createHash("sha256")
  .update("account:OracleConfig", "utf8")
  .digest()
  .subarray(0, 8);

function account(
  data: Buffer,
  overrides: Partial<AccountInfo<Buffer>> = {},
): AccountInfo<Buffer> {
  return {
    data,
    executable: false,
    lamports: 1,
    owner: programId,
    rentEpoch: 0,
    ...overrides,
  };
}

function currentData(
  schemaVersion = FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
): Buffer {
  const data = Buffer.alloc(ORACLE_CONFIG_V2_ACCOUNT_SIZE);
  oracleConfigDiscriminator.copy(data, 0);
  data.writeUInt16LE(schemaVersion, ORACLE_CONFIG_SCHEMA_VERSION_OFFSET);
  return data;
}

describe("fight-oracle account schema preflight", () => {
  test("allows a virgin program identity and an exact initialized v2 config", () => {
    expect(
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: null,
      }),
    ).toEqual({ status: "uninitialized", schemaVersion: null });
    expect(
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: account(currentData()),
      }),
    ).toEqual({
      status: "current",
      schemaVersion: FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
    });
  });

  test("derives the canonical oracle config address", () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle_config", "utf8")],
      programId,
    );
    expect(deriveFightOracleConfigPda(programId).equals(expected)).toBe(true);
  });

  test("rejects the exact legacy v1 layout before an unsafe upgrade", () => {
    const data = Buffer.alloc(ORACLE_CONFIG_V1_ACCOUNT_SIZE);
    oracleConfigDiscriminator.copy(data, 0);
    expect(() =>
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: account(data),
      }),
    ).toThrow("legacy account schema v1");
  });

  test("rejects wrong owner, executable, discriminator, size, and version", () => {
    expect(() =>
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: account(currentData(), {
          owner: PublicKey.default,
        }),
      }),
    ).toThrow("not owned");
    expect(() =>
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: account(currentData(), { executable: true }),
      }),
    ).toThrow("must not be executable");
    expect(() =>
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: account(Buffer.alloc(148)),
      }),
    ).toThrow("unsupported byte length 148");
    expect(() =>
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: account(
          Buffer.alloc(ORACLE_CONFIG_V2_ACCOUNT_SIZE),
        ),
      }),
    ).toThrow("discriminator is invalid");
    expect(() =>
      evaluateFightOracleAccountSchema({
        programId,
        oracleConfigAccount: account(currentData(1)),
      }),
    ).toThrow("schema version 1 is unsupported");
  });
});
