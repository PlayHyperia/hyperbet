import { PublicKey } from "@solana/web3.js";

export type SolanaProgramIdentitySet = {
  fightOracleProgramId: string;
  duelMarketProgramId: string;
};

export type SolanaProgramIdentityObservation = {
  label: string;
  program: keyof SolanaProgramIdentitySet;
  address: string | null;
};

export function evaluateProgramIdentityConvergence(input: {
  expected: SolanaProgramIdentitySet;
  observations: readonly SolanaProgramIdentityObservation[];
}): string[] {
  const failures: string[] = [];

  for (const [name, address] of Object.entries(input.expected) as Array<
    [keyof SolanaProgramIdentitySet, string]
  >) {
    try {
      const parsed = new PublicKey(address);
      if (parsed.equals(PublicKey.default)) {
        failures.push(`${name}: expected identity is the default public key`);
      }
    } catch {
      failures.push(`${name}: expected identity is not a valid public key`);
    }
  }

  if (
    input.expected.fightOracleProgramId === input.expected.duelMarketProgramId
  ) {
    failures.push("fight oracle and duel market identities must differ");
  }

  for (const observation of input.observations) {
    const expected = input.expected[observation.program];
    if (observation.address !== expected) {
      failures.push(
        `${observation.label}: expected ${expected}; found ${observation.address ?? "missing"}`,
      );
    }
  }

  return failures;
}
