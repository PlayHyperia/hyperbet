export const keeperSignerSecretEnvironmentNames = [
  "KEEPER_FEE_PAYER_KEYPAIR",
  "ORACLE_REPORTER_KEYPAIR",
  "ORACLE_FINALIZER_KEYPAIR",
  "CLOB_MARKET_OPERATOR_KEYPAIR",
  "MARKET_MAKER_KEYPAIR",
  "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
  "CLOB_CONFIG_AUTHORITY_KEYPAIR",
] as const;

export function isProtectedKeeperRuntimeEnvironment(
  nodeEnv: string | undefined,
): boolean {
  const normalized = nodeEnv?.trim().toLowerCase();
  return normalized === "production" || normalized === "staging";
}

export function assertServiceRuntimeIsolation(input: {
  production: boolean;
  runtimeRole: string | undefined;
  environment: Record<string, string | undefined>;
}): void {
  if (!input.production) return;
  if (input.runtimeRole !== "service") {
    throw new Error("deployed API requires HYPERBET_RUNTIME_ROLE=service");
  }
  const exposedSecrets = keeperSignerSecretEnvironmentNames.filter((name) =>
    Boolean(input.environment[name]?.trim()),
  );
  if (exposedSecrets.length > 0) {
    throw new Error(
      `deployed API must not receive signer secrets: ${exposedSecrets.join(", ")}`,
    );
  }
}

export function assertDuelBotRuntimeRole(input: {
  production: boolean;
  runtimeRole: string | undefined;
}): void {
  if (input.production && input.runtimeRole !== "duel-bot") {
    throw new Error(
      "deployed duel bot requires HYPERBET_RUNTIME_ROLE=duel-bot",
    );
  }
}
