import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditKeeperRuntimeEnvironmentPair,
  normalizeRailwayVariablePayload,
  type KeeperDeployment,
} from "./ci-keeper-runtime-env-solana-v1-policy";

function readArgument(argumentsList: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = argumentsList.find((argument) => argument.startsWith(prefix));
  if (!value?.slice(prefix.length).trim()) {
    throw new Error(`missing required argument --${name}=<value>`);
  }
  return value.slice(prefix.length).trim();
}

function readRailwayEnvironment(filePath: string): Record<string, string> {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    throw new Error("unable to parse Railway variable JSON");
  }
  return normalizeRailwayVariablePayload(payload);
}

export type KeeperRuntimeEnvironmentFileAuditResult = {
  deployment: KeeperDeployment;
  errors: string[];
};

export function auditKeeperRuntimeEnvironmentFiles(
  argumentsList: readonly string[],
): KeeperRuntimeEnvironmentFileAuditResult {
  const deploymentValue = readArgument(argumentsList, "deployment");
  if (deploymentValue !== "staging" && deploymentValue !== "production") {
    throw new Error("deployment must be staging or production");
  }
  const deployment = deploymentValue as KeeperDeployment;
  const service = readRailwayEnvironment(
    readArgument(argumentsList, "service-env-file"),
  );
  const duelBot = readRailwayEnvironment(
    readArgument(argumentsList, "duel-bot-env-file"),
  );
  const errors = auditKeeperRuntimeEnvironmentPair({
    deployment,
    service,
    duelBot,
  });
  return { deployment, errors };
}

function isMainModule(): boolean {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

if (isMainModule()) {
  try {
    const result = auditKeeperRuntimeEnvironmentFiles(process.argv.slice(2));
    if (result.errors.length > 0) {
      console.error(
        `SOL-only protected keeper runtime environment audit failed (${result.errors.length} findings)`,
      );
      for (const error of result.errors) console.error(`error: ${error}`);
      process.exitCode = 1;
    } else {
      console.log(
        JSON.stringify({
          ok: true,
          deployment: result.deployment,
          serviceRole: "service",
          duelBotRole: "duel-bot",
          inspectedValuesPrinted: false,
        }),
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "runtime audit failed",
    );
    process.exitCode = 1;
  }
}
