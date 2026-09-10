import BN from "bn.js";
import { type Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { FightOracle } from "./idl/fight_oracle";

import { exactBytes32Hex } from "./exactBytes32";
import {
  createLaunchPrograms,
  duelKeyHexToBytes,
  enumIs,
  FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION,
  findDuelStatePda,
  findOracleConfigPda,
  findProposalRecordPda,
  readKeypair,
} from "./launchCommon";
import {
  resolveKeeperRoleRefs,
  validateKeeperRoleSeparation,
} from "./keeperRoles";
import { buildResultHash } from "./resultHash";

function positiveU32(value: unknown, label: string): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "bigint") {
    parsed = Number(value);
  } else if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    parsed = (value as { toNumber: () => number }).toNumber();
  } else {
    parsed = Number.NaN;
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 0xffff_ffff) {
    throw new Error(`${label} is not a positive unsigned 32-bit integer`);
  }
  return parsed;
}

function bytes32Hex(value: unknown, label: string): string {
  const hex = exactBytes32Hex(value);
  if (!hex) {
    throw new Error(`${label} is not a 32-byte value`);
  }
  if (/^0{64}$/.test(hex)) {
    throw new Error(`${label} cannot be zero`);
  }
  return hex;
}

const args = await yargs(hideBin(process.argv))
  .option("duel-key", {
    type: "string",
    demandOption: true,
    describe: "Canonical 32-byte duel key hex string",
  })
  .option("winner", {
    type: "string",
    choices: ["a", "b"],
    demandOption: true,
    describe: "Authoritative winner side",
  })
  .option("seed", {
    type: "string",
    demandOption: true,
    describe: "Authoritative duel seed as an unsigned integer string",
  })
  .option("replay-hash", {
    type: "string",
    demandOption: true,
    describe: "Authoritative 32-byte replay hash hex string",
  })
  .option("metadata", {
    type: "string",
    default: "",
    describe: "Optional metadata uri/json payload",
  })
  .strict()
  .parse();

const cluster =
  process.env.SOLANA_CLUSTER || process.env.CLUSTER || "mainnet-beta";
const roleRefs = resolveKeeperRoleRefs(process.env);
const feePayer = readKeypair(roleRefs.feePayerKeypair);
const reporter = readKeypair(roleRefs.oracleReporterKeypair);
const finalizer = readKeypair(roleRefs.oracleFinalizerKeypair);
const marketOperator = readKeypair(roleRefs.clobMarketOperatorKeypair);
const marketMaker = readKeypair(roleRefs.marketMakerKeypair);
const challenger = new PublicKey(roleRefs.oracleChallengerWallet);
const oracleConfigAuthority = roleRefs.oracleConfigAuthorityKeypair
  ? readKeypair(roleRefs.oracleConfigAuthorityKeypair)
  : null;
const clobConfigAuthority = roleRefs.clobConfigAuthorityKeypair
  ? readKeypair(roleRefs.clobConfigAuthorityKeypair)
  : null;
validateKeeperRoleSeparation(cluster, {
  feePayer: feePayer.publicKey,
  oracleReporter: reporter.publicKey,
  oracleFinalizer: finalizer.publicKey,
  oracleChallenger: challenger,
  clobMarketOperator: marketOperator.publicKey,
  marketMaker: marketMaker.publicKey,
  oracleConfigAuthority: oracleConfigAuthority?.publicKey ?? null,
  clobConfigAuthority: clobConfigAuthority?.publicKey ?? null,
});
const { connection, fightOracle } = createLaunchPrograms(feePayer);
const oracleProgram: Program<FightOracle> = fightOracle;
const oracleAccounts = oracleProgram.account as Record<
  string,
  { fetch: (pubkey: unknown) => Promise<Record<string, unknown>> }
>;

const duelKey = duelKeyHexToBytes(args["duel-key"]);
const duelPda = findDuelStatePda(fightOracle.programId, duelKey);
const oracleConfigPda = findOracleConfigPda(fightOracle.programId);

const duelState = await oracleAccounts["duelState"].fetch(duelPda);
const oracleConfig =
  await oracleAccounts["oracleConfig"].fetch(oracleConfigPda);
for (const [value, label] of [
  [oracleConfig.accountSchemaVersion, "oracle config"],
  [duelState.accountSchemaVersion, "duel state"],
] as const) {
  if (
    positiveU32(value, `${label} account schema version`) !==
    FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION
  ) {
    throw new Error(
      `${label} uses an unsupported account schema; expected v${FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION}`,
    );
  }
}
const confirmedSlot = await connection.getSlot("confirmed");
const confirmedChainTs = await connection.getBlockTime(confirmedSlot);
if (!Number.isSafeInteger(confirmedChainTs) || Number(confirmedChainTs) <= 0) {
  throw new Error(
    "Confirmed Solana block time is unavailable; refusing to resolve",
  );
}
const nowTs = Number(confirmedChainTs);

let proposeResultSig: string | null = null;
let finalizeResultSig: string | null = null;

if (!enumIs(duelState.status, "resolved")) {
  if (enumIs(duelState.status, "challenged")) {
    throw new Error("Duel result is challenged; refusing to finalize");
  }
  if (nowTs < Number(duelState.betCloseTs)) {
    throw new Error("Bet window still open; refusing to resolve early");
  }
  if (nowTs < Number(duelState.duelStartTs)) {
    throw new Error("Duel has not started; refusing to fabricate an end time");
  }

  const replayHashHex = args["replay-hash"].trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(replayHashHex)) {
    throw new Error("replay-hash must be a 32-byte hex string");
  }

  if (enumIs(duelState.status, "locked")) {
    const replayHash = Array.from(Buffer.from(replayHashHex, "hex"));
    const competitiveSnapshotVersion = positiveU32(
      duelState.competitiveSnapshotVersion,
      "on-chain competitive snapshot version",
    );
    const competitiveSnapshotDigest = bytes32Hex(
      duelState.competitiveSnapshotDigest,
      "on-chain competitive snapshot digest",
    );
    const resultHash = buildResultHash(
      args["duel-key"],
      args.winner === "a" ? "A" : "B",
      args.seed,
      replayHashHex,
      competitiveSnapshotVersion,
      competitiveSnapshotDigest,
    );
    const proposalRecord = findProposalRecordPda(
      oracleProgram.programId,
      duelKey,
      resultHash,
      replayHash,
    );

    proposeResultSig = await oracleProgram.methods
      .proposeResult(
        Array.from(duelKey),
        args.winner === "a" ? { a: {} } : { b: {} },
        new BN(args.seed),
        replayHash,
        resultHash,
        new BN(nowTs),
        args.metadata,
      )
      .accounts({
        reporter: reporter.publicKey,
        oracleConfig: oracleConfigPda,
        duelState: duelPda,
        proposalRecord,
        systemProgram: SystemProgram.programId,
      } as never)
      .signers([reporter])
      .rpc();
  }

  const refreshedDuelState = await oracleAccounts["duelState"].fetch(duelPda);
  if (enumIs(refreshedDuelState.status, "challenged")) {
    throw new Error("Duel result is challenged; refusing to finalize");
  }

  if (enumIs(refreshedDuelState.status, "proposed")) {
    const finalizableAt =
      Number(refreshedDuelState.pendingProposedAt) +
      Number(oracleConfig.disputeWindowSecs);
    if (nowTs >= finalizableAt) {
      finalizeResultSig = await oracleProgram.methods
        .finalizeResult(Array.from(duelKey), args.metadata)
        .accounts({
          finalizer: finalizer.publicKey,
          oracleConfig: oracleConfigPda,
          duelState: duelPda,
        } as never)
        .signers([finalizer])
        .rpc();
    }
  }
}

console.log(
  JSON.stringify(
    {
      duel: duelPda.toBase58(),
      proposeResultSig,
      finalizeResultSig,
    },
    null,
    2,
  ),
);
