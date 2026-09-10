import { createHash } from "node:crypto";

import { type AccountInfo, PublicKey } from "@solana/web3.js";

import { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../account-schema";

export { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../account-schema";
export const ORACLE_CONFIG_V1_ACCOUNT_SIZE = 147;
export const ORACLE_CONFIG_V2_ACCOUNT_SIZE = 149;
export const ORACLE_CONFIG_SCHEMA_VERSION_OFFSET = 147;

const ORACLE_CONFIG_DISCRIMINATOR = createHash("sha256")
  .update("account:OracleConfig", "utf8")
  .digest()
  .subarray(0, 8);

export type FightOracleAccountSchemaState =
  | { status: "uninitialized"; schemaVersion: null }
  | { status: "current"; schemaVersion: number };

export function deriveFightOracleConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_config", "utf8")],
    programId,
  )[0];
}

export function evaluateFightOracleAccountSchema(input: {
  programId: PublicKey;
  oracleConfigAccount: AccountInfo<Buffer> | null;
}): FightOracleAccountSchemaState {
  const account = input.oracleConfigAccount;
  if (!account) {
    return { status: "uninitialized", schemaVersion: null };
  }
  if (!account.owner.equals(input.programId)) {
    throw new Error(
      "fight oracle config is not owned by the fight oracle program",
    );
  }
  if (account.executable) {
    throw new Error("fight oracle config must not be executable");
  }
  if (account.data.length === ORACLE_CONFIG_V1_ACCOUNT_SIZE) {
    throw new Error(
      "fight oracle config uses legacy account schema v1; refuse an in-place upgrade and select a fresh v2 program identity",
    );
  }
  if (account.data.length !== ORACLE_CONFIG_V2_ACCOUNT_SIZE) {
    throw new Error(
      `fight oracle config has unsupported byte length ${account.data.length}; expected ${ORACLE_CONFIG_V2_ACCOUNT_SIZE}`,
    );
  }
  if (
    !account.data
      .subarray(0, ORACLE_CONFIG_DISCRIMINATOR.length)
      .equals(ORACLE_CONFIG_DISCRIMINATOR)
  ) {
    throw new Error("fight oracle config discriminator is invalid");
  }
  const schemaVersion = account.data.readUInt16LE(
    ORACLE_CONFIG_SCHEMA_VERSION_OFFSET,
  );
  if (schemaVersion !== FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION) {
    throw new Error(
      `fight oracle config schema version ${schemaVersion} is unsupported; expected ${FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION}`,
    );
  }
  return { status: "current", schemaVersion };
}
