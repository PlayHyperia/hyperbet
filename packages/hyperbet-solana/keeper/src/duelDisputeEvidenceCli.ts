import path from "node:path";

import { Connection, PublicKey } from "@solana/web3.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  collectDuelBuildEvidence,
  collectDuelDisputeEvidence,
  writeDuelDisputeEvidenceArtifact,
} from "./duelDisputeEvidenceCollector";
import {
  DUEL_MARKET_PROGRAM_ID,
  FIGHT_ORACLE_PROGRAM_ID,
  getRpcUrl,
  sanitizeErrorMessage,
} from "./launchCommon";

const keeperRoot = path.resolve(import.meta.dir, "..");
const defaultHyperbetRoot = path.resolve(keeperRoot, "../../..");
const defaultHyperiaRoot = path.resolve(
  defaultHyperbetRoot,
  "../hyperia-implementation",
);
const defaultAnchorRoot = path.join(
  defaultHyperbetRoot,
  "packages/hyperbet-solana/anchor",
);

const argv = await yargs(hideBin(process.argv))
  .strict()
  .option("db-path", {
    type: "string",
    demandOption: true,
    description: "Terminal ledger SQLite path retained by the duel bot",
  })
  .option("duel-id", {
    type: "string",
    demandOption: true,
    description: "Exact completed duel ID to package",
  })
  .option("output", {
    type: "string",
    demandOption: true,
    description: "Destination for the canonical mode-0600 JSON package",
  })
  .option("rpc-url", {
    type: "string",
    default: getRpcUrl(),
    description: "Solana RPC URL (never written to the evidence package)",
  })
  .option("cluster", {
    choices: ["localnet", "devnet", "testnet", "mainnet-beta"] as const,
    default: "localnet" as const,
  })
  .option("fight-program-id", {
    type: "string",
    default: FIGHT_ORACLE_PROGRAM_ID.toBase58(),
  })
  .option("market-program-id", {
    type: "string",
    default: DUEL_MARKET_PROGRAM_ID.toBase58(),
  })
  .option("hyperia-root", { type: "string", default: defaultHyperiaRoot })
  .option("hyperbet-root", { type: "string", default: defaultHyperbetRoot })
  .option("hyperbet-source-revision", {
    type: "string",
    description:
      "Explicit source revision for a materialized non-Git runtime tree",
  })
  .option("hyperbet-working-tree-dirty", {
    type: "boolean",
    description:
      "Explicit conservative dirty-state label for a materialized runtime tree",
  })
  .option("fight-program-binary", {
    type: "string",
    default: path.join(defaultAnchorRoot, "target/deploy/fight_oracle.so"),
  })
  .option("market-program-binary", {
    type: "string",
    default: path.join(defaultAnchorRoot, "target/deploy/duel_market.so"),
  })
  .option("fight-program-idl", {
    type: "string",
    default: path.join(defaultAnchorRoot, "target/idl/fight_oracle.json"),
  })
  .option("market-program-idl", {
    type: "string",
    default: path.join(defaultAnchorRoot, "target/idl/duel_market.json"),
  })
  .option("external-value", { type: "boolean", default: false })
  .option("production-equivalent-infrastructure", {
    type: "boolean",
    default: false,
  })
  .option("release-eligible", { type: "boolean", default: false })
  .check((value) => {
    if (!String(value.duelId ?? "").trim()) {
      throw new Error("--duel-id cannot be empty");
    }
    if (!String(value.dbPath ?? "").trim()) {
      throw new Error("--db-path cannot be empty");
    }
    if (!String(value.output ?? "").trim()) {
      throw new Error("--output cannot be empty");
    }
    if (
      (value.hyperbetSourceRevision !== undefined) !==
      (value.hyperbetWorkingTreeDirty !== undefined)
    ) {
      throw new Error(
        "--hyperbet-source-revision and --hyperbet-working-tree-dirty must be supplied together",
      );
    }
    return true;
  })
  .parseAsync();

try {
  const fightProgramId = new PublicKey(argv.fightProgramId);
  const marketProgramId = new PublicKey(argv.marketProgramId);
  const hyperiaRoot = path.resolve(argv.hyperiaRoot);
  const hyperbetRoot = path.resolve(argv.hyperbetRoot);
  const buildEvidence = collectDuelBuildEvidence({
    hyperiaRoot,
    hyperbetRoot,
    hyperbetSourceRevision: argv.hyperbetSourceRevision,
    hyperbetWorkingTreeDirty: argv.hyperbetWorkingTreeDirty,
    fightProgramId,
    marketProgramId,
    fightProgramBinary: path.resolve(argv.fightProgramBinary),
    marketProgramBinary: path.resolve(argv.marketProgramBinary),
    fightProgramIdl: path.resolve(argv.fightProgramIdl),
    marketProgramIdl: path.resolve(argv.marketProgramIdl),
  });
  const evidence = await collectDuelDisputeEvidence({
    connection: new Connection(argv.rpcUrl, "finalized"),
    dbPath: path.resolve(argv.dbPath),
    duelId: argv.duelId.trim(),
    classification: {
      chain: "solana",
      cluster: argv.cluster,
      externalValue: argv.externalValue,
      productionEquivalentInfrastructure:
        argv.productionEquivalentInfrastructure,
      releaseEligible: argv.releaseEligible,
    },
    buildEvidence,
    fightProgramId,
    marketProgramId,
  });
  const result = writeDuelDisputeEvidenceArtifact({
    outputPath: argv.output,
    evidence,
  });
  console.log(
    JSON.stringify({
      ok: true,
      duelId: evidence.identity.duelId,
      duelKey: evidence.identity.duelKey,
      classification: evidence.classification,
      transactionCount: evidence.transactions.length,
      ...result,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, error: sanitizeErrorMessage(error) }),
  );
  process.exitCode = 1;
}
