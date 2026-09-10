import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const canonicalIdlPath = path.join(
  packageRoot,
  "anchor",
  "target",
  "idl",
  "duel_market.json",
);
const canonicalFightOracleIdlPath = path.join(
  packageRoot,
  "anchor",
  "target",
  "idl",
  "fight_oracle.json",
);
const canonicalTypePaths = {
  duelMarket: path.join(
    packageRoot,
    "anchor",
    "target",
    "types",
    "duel_market.ts",
  ),
  fightOracle: path.join(
    packageRoot,
    "anchor",
    "target",
    "types",
    "fight_oracle.ts",
  ),
} as const;
const expectedProgramIds = {
  duelMarket: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
  fightOracle: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
} as const;

const downstreamIdlPaths = [
  path.join(packageRoot, "app", "src", "idl", "duel_market.json"),
  path.join(packageRoot, "keeper", "src", "idl", "duel_market.json"),
  path.join(
    repositoryRoot,
    "packages",
    "hyperbet-ui",
    "src",
    "idl",
    "duel_market.json",
  ),
  path.join(
    repositoryRoot,
    "packages",
    "market-maker-bot",
    "src",
    "idl",
    "duel_market.json",
  ),
  path.join(
    repositoryRoot,
    "packages",
    "hyperbet-sdk",
    "src",
    "solana",
    "idl",
    "duel_market.json",
  ),
  path.join(
    repositoryRoot,
    "packages",
    "hyperbet-sdk-py",
    "hyperbet_sdk",
    "solana",
    "idl",
    "duel_market.json",
  ),
] as const;

const downstreamFightOracleIdlPaths = [
  path.join(packageRoot, "app", "src", "idl", "fight_oracle.json"),
  path.join(packageRoot, "keeper", "src", "idl", "fight_oracle.json"),
  path.join(
    repositoryRoot,
    "packages",
    "hyperbet-ui",
    "src",
    "idl",
    "fight_oracle.json",
  ),
  path.join(
    repositoryRoot,
    "packages",
    "hyperbet-sdk",
    "src",
    "solana",
    "idl",
    "fight_oracle.json",
  ),
  path.join(
    repositoryRoot,
    "packages",
    "hyperbet-sdk-py",
    "hyperbet_sdk",
    "solana",
    "idl",
    "fight_oracle.json",
  ),
] as const;

const downstreamTypePaths = {
  duelMarket: [
    path.join(packageRoot, "app", "src", "idl", "duel_market.ts"),
    path.join(packageRoot, "keeper", "src", "idl", "duel_market.ts"),
    path.join(
      repositoryRoot,
      "packages",
      "hyperbet-ui",
      "src",
      "idl",
      "duel_market.ts",
    ),
  ],
  fightOracle: [
    path.join(packageRoot, "app", "src", "idl", "fight_oracle.ts"),
    path.join(packageRoot, "keeper", "src", "idl", "fight_oracle.ts"),
    path.join(
      repositoryRoot,
      "packages",
      "hyperbet-ui",
      "src",
      "idl",
      "fight_oracle.ts",
    ),
  ],
} as const;

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(entryPath);
      return entry.isFile() ? [entryPath] : [];
    })
    .sort();
}

describe("neutral Solana duel-market artifacts", () => {
  test("keeps every downstream IDL byte-identical to the Anchor artifact", () => {
    const canonical = readFileSync(canonicalIdlPath);
    for (const downstreamPath of downstreamIdlPaths) {
      expect(readFileSync(downstreamPath).equals(canonical)).toBe(true);
    }
  });

  test("keeps every downstream fight-oracle IDL byte-identical", () => {
    const canonical = readFileSync(canonicalFightOracleIdlPath);
    for (const downstreamPath of downstreamFightOracleIdlPaths) {
      expect(readFileSync(downstreamPath).equals(canonical)).toBe(true);
    }
  });

  test("keeps every downstream generated TypeScript IDL byte-identical", () => {
    for (const programName of ["duelMarket", "fightOracle"] as const) {
      const canonical = readFileSync(canonicalTypePaths[programName]);
      for (const downstreamPath of downstreamTypePaths[programName]) {
        expect(readFileSync(downstreamPath).equals(canonical)).toBe(true);
      }
    }
  });

  test("keeps generated clients free of trailing whitespace", () => {
    const generatedFiles = listFiles(
      path.join(packageRoot, "app", "src", "generated"),
    ).filter((filepath) => filepath.endsWith(".ts"));
    expect(generatedFiles.length).toBeGreaterThan(0);
    for (const filepath of generatedFiles) {
      expect(readFileSync(filepath, "utf8")).not.toMatch(/[ \t]+\r?$/m);
    }
  });

  test("publishes permanent proposal history in the oracle ABI", () => {
    const idl = JSON.parse(
      readFileSync(canonicalFightOracleIdlPath, "utf8"),
    ) as {
      address?: unknown;
      metadata?: { name?: unknown };
      instructions?: Array<{
        name?: unknown;
        accounts?: Array<{ name?: unknown }>;
        args?: Array<{ name?: unknown }>;
      }>;
      accounts?: Array<{ name?: unknown }>;
      types?: Array<{
        name?: unknown;
        type?: { fields?: Array<{ name?: unknown }> };
      }>;
      errors?: Array<{ name?: unknown }>;
    };
    expect(idl.address).toBe(expectedProgramIds.fightOracle);
    expect(idl.metadata?.name).toBe("fight_oracle");
    expect(idl.instructions?.length).toBe(10);
    expect(idl.accounts?.map((account) => account.name)).toContain(
      "ProposalRecord",
    );
    expect(idl.accounts?.length).toBe(3);
    expect(idl.types?.length).toBe(10);
    expect(idl.errors?.length).toBe(35);
    expect(idl.errors?.map((error) => error.name)).toContain("ConfigNotFrozen");
    expect(idl.errors?.map((error) => error.name)).toEqual(
      expect.arrayContaining([
        "InvalidCompetitiveSnapshot",
        "CompetitiveSnapshotImmutable",
        "ResultHashMismatch",
        "UnsupportedAccountSchema",
      ]),
    );
    expect(
      idl.instructions
        ?.find((instruction) => instruction.name === "upsert_duel")
        ?.args?.map((arg) => arg.name),
    ).toEqual([
      "duel_key",
      "participant_a_hash",
      "participant_b_hash",
      "competitive_snapshot_version",
      "competitive_snapshot_digest",
      "bet_open_ts",
      "bet_close_ts",
      "duel_start_ts",
      "metadata_uri",
      "status",
    ]);
    const duelStateFields = idl.types
      ?.find((type) => type.name === "DuelState")
      ?.type?.fields?.map((field) => field.name);
    expect(duelStateFields?.slice(-3)).toEqual([
      "competitive_snapshot_version",
      "competitive_snapshot_digest",
      "account_schema_version",
    ]);
    expect(
      idl.types
        ?.find((type) => type.name === "OracleConfig")
        ?.type?.fields?.map((field) => field.name)
        .slice(-2),
    ).toEqual(["bump", "account_schema_version"]);

    const accountsFor = (instructionName: string) =>
      idl.instructions
        ?.find((instruction) => instruction.name === instructionName)
        ?.accounts?.map((account) => account.name);
    expect(accountsFor("propose_result")).toEqual([
      "reporter",
      "oracle_config",
      "duel_state",
      "proposal_record",
      "system_program",
    ]);
    expect(accountsFor("repropose_result")).toEqual([
      "reporter",
      "oracle_config",
      "duel_state",
      "proposal_record",
      "system_program",
    ]);
    expect(accountsFor("challenge_result")).toEqual([
      "challenger",
      "oracle_config",
      "duel_state",
      "proposal_record",
    ]);
  });

  test("publishes only the neutral program identity", () => {
    const idl = JSON.parse(readFileSync(canonicalIdlPath, "utf8")) as {
      address?: unknown;
      metadata?: { name?: unknown };
      instructions?: unknown[];
      accounts?: unknown[];
      types?: unknown[];
      errors?: unknown[];
    };
    expect(idl.metadata?.name).toBe("duel_market");
    expect(idl.address).toBe(expectedProgramIds.duelMarket);
    expect(idl.instructions?.length).toBe(16);
    expect(idl.accounts?.length).toBe(6);
    expect(idl.types?.length).toBe(23);
    expect(idl.errors?.length).toBe(54);
    expect(readFileSync(canonicalIdlPath, "utf8")).not.toMatch(
      /gold[_-]?clob/i,
    );
  });
});
