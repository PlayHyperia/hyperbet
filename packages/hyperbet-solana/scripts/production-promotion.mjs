export const SOL_PRODUCTION_CONFIRMATION = "DEPLOY_SOL_PRODUCTION";

const fullCommitSha = /^[0-9a-f]{40}$/u;

export function evaluateSolProductionPromotion({
  environment,
  confirmation,
  expectedCommitSha,
  ref,
  actualCommitSha,
}) {
  const checks = [];
  const supportedEnvironment = ["preview", "staging", "production"].includes(
    environment,
  );
  checks.push({
    ok: supportedEnvironment,
    message: "deployment environment is preview, staging, or production",
  });

  if (environment !== "production") {
    return {
      ok: supportedEnvironment,
      environment,
      production: false,
      checks,
    };
  }

  checks.push(
    {
      ok: confirmation === SOL_PRODUCTION_CONFIRMATION,
      message: `production confirmation is exactly ${SOL_PRODUCTION_CONFIRMATION}`,
    },
    {
      ok: ref === "refs/heads/main",
      message: "production source ref is refs/heads/main",
    },
    {
      ok: fullCommitSha.test(expectedCommitSha),
      message: "requested production commit is a full lowercase SHA",
    },
    {
      ok: fullCommitSha.test(actualCommitSha),
      message: "checked-out production commit is a full lowercase SHA",
    },
    {
      ok:
        fullCommitSha.test(expectedCommitSha) &&
        expectedCommitSha === actualCommitSha,
      message: "requested production commit matches the checked-out commit",
    },
  );

  return {
    ok: checks.every((check) => check.ok),
    environment,
    production: true,
    commitSha: fullCommitSha.test(actualCommitSha) ? actualCommitSha : null,
    checks,
  };
}
