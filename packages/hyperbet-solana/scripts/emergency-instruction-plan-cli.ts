import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEmergencyInstructionPlan,
  parseEmergencyAction,
  parseEmergencyCluster,
  writeEmergencyInstructionPlan,
} from "./emergency-instruction-plan";

function requireArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  if (!value || !value.slice(prefix.length).trim()) {
    throw new Error(`missing required --${name}=<value>`);
  }
  return value.slice(prefix.length).trim();
}

function optionalArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function main(): void {
  const plan = buildEmergencyInstructionPlan({
    action: parseEmergencyAction(requireArg("action")),
    cluster: parseEmergencyCluster(requireArg("cluster")),
    releaseSha: requireArg("release-sha"),
    expectedSigner: requireArg("expected-signer"),
    duelKey: optionalArg("duel-key"),
    metadataUri: optionalArg("metadata-uri"),
  });
  const outputPath = requireArg("output");
  writeEmergencyInstructionPlan(outputPath, plan);
  console.log(
    JSON.stringify({
      ok: true,
      action: plan.action,
      cluster: plan.cluster,
      programId: plan.programId,
      instructionDataSha256: plan.instructionDataSha256,
      outputFileName: path.basename(outputPath),
      broadcastAuthorized: plan.broadcastAuthorized,
    }),
  );
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(
      `emergency instruction plan failed: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
    process.exitCode = 1;
  }
}
