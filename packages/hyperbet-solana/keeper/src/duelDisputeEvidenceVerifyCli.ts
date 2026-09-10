import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { verifyDuelDisputeEvidenceArtifact } from "./duelDisputeEvidenceCollector";
import { sanitizeErrorMessage } from "./launchCommon";

const argv = await yargs(hideBin(process.argv))
  .strict()
  .option("input", {
    type: "string",
    demandOption: true,
    description: "Canonical duel dispute evidence JSON artifact",
  })
  .option("artifact-sha256", {
    type: "string",
    description: "Expected SHA-256 of the exact artifact bytes",
  })
  .option("package-digest", {
    type: "string",
    description: "Expected self-verifying package digest",
  })
  .option("duel-id", {
    type: "string",
    description: "Expected exact duel ID",
  })
  .option("duel-key", {
    type: "string",
    description: "Expected exact 32-byte duel key as lowercase hex",
  })
  .option("cluster", {
    choices: ["localnet", "devnet", "testnet", "mainnet-beta"] as const,
    description: "Expected package cluster",
  })
  .option("require-release-eligible", {
    type: "boolean",
    default: false,
    description: "Reject diagnostic/non-release packages",
  })
  .check((value) => {
    if (!String(value.input ?? "").trim()) {
      throw new Error("--input cannot be empty");
    }
    return true;
  })
  .parseAsync();

try {
  const result = verifyDuelDisputeEvidenceArtifact({
    inputPath: argv.input,
    expectedArtifactSha256: argv.artifactSha256,
    expectedPackageDigest: argv.packageDigest,
    expectedDuelId: argv.duelId,
    expectedDuelKey: argv.duelKey,
    expectedCluster: argv.cluster,
    requireReleaseEligible: argv.requireReleaseEligible,
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, error: sanitizeErrorMessage(error) }),
  );
  process.exitCode = 1;
}
