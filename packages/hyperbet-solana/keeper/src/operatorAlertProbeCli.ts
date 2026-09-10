import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  probeOperatorAlertRoute,
  writeOperatorAlertProbeEvidence,
} from "./operatorAlertProbe";

export async function runOperatorAlertProbeCli(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown>> {
  const { values } = parseArgs({
    args: argv,
    options: {
      environment: { type: "string" },
      "release-sha": { type: "string" },
      output: { type: "string" },
      "timeout-ms": { type: "string", default: "2000" },
    },
    strict: true,
  });
  if (!values.environment || !values["release-sha"] || !values.output) {
    throw new Error(
      "usage: operator-alert-probe --environment=<staging|production> --release-sha=<full-sha> --output=<evidence.json>",
    );
  }
  if (!/^\d+$/u.test(values["timeout-ms"])) {
    throw new Error("--timeout-ms must be a base-10 integer");
  }

  const evidence = await probeOperatorAlertRoute({
    approved:
      environment.HYPERBET_OPERATOR_ALERT_TEST_APPROVED?.trim() === "true",
    webhookUrl: environment.HYPERBET_OPERATOR_ALERT_WEBHOOK_URL?.trim() ?? "",
    bearerToken:
      environment.HYPERBET_OPERATOR_ALERT_BEARER_TOKEN?.trim() || undefined,
    routeId: environment.HYPERBET_OPERATOR_ALERT_ROUTE_ID?.trim() ?? "",
    environment: values.environment,
    releaseSha: values["release-sha"],
    timeoutMs: Number.parseInt(values["timeout-ms"], 10),
  });
  const evidencePath = await writeOperatorAlertProbeEvidence(
    values.output,
    evidence,
  );
  return {
    ok: true,
    evidencePath,
    routeId: evidence.routeId,
    probeId: evidence.probeId,
    webhookAccepted: evidence.webhookAccepted,
    providerAcknowledgementRequired: evidence.providerAcknowledgementRequired,
    controlledFiringRecoveryRequired: evidence.controlledFiringRecoveryRequired,
  };
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    process.stdout.write(
      `${JSON.stringify(
        await runOperatorAlertProbeCli(process.argv.slice(2), process.env),
      )}\n`,
    );
  } catch (error) {
    console.error(
      `operator alert probe failed: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
    process.exitCode = 1;
  }
}
