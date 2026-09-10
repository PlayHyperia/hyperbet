import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOLANA_V1_DEPLOYMENTS } from "../deployments/v1";
import {
  evaluateProgramIdentityConvergence,
  type SolanaProgramIdentityObservation,
  type SolanaProgramIdentitySet,
} from "./program-identity-convergence";
import {
  readKeypairPubkey,
  resolveStageAProgramKeypairPath,
  resolveStageAProgramKeysDir,
  type StageAProgramBinaryName,
} from "./stage-a-identity";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const anchorRoot = path.join(packageRoot, "anchor");

const programs = [
  {
    binaryName: "fight_oracle",
    identityField: "fightOracleProgramId",
  },
  {
    binaryName: "duel_market",
    identityField: "duelMarketProgramId",
  },
] as const satisfies ReadonlyArray<{
  binaryName: StageAProgramBinaryName;
  identityField: keyof SolanaProgramIdentitySet;
}>;

function readDeclaredProgramId(
  binaryName: StageAProgramBinaryName,
): string | null {
  const source = readFileSync(
    path.join(anchorRoot, "programs", binaryName, "src", "lib.rs"),
    "utf8",
  );
  return source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)?.[1] ?? null;
}

function readIdlAddress(binaryName: StageAProgramBinaryName): string | null {
  const idl = JSON.parse(
    readFileSync(
      path.join(anchorRoot, "target", "idl", `${binaryName}.json`),
      "utf8",
    ),
  ) as { address?: unknown };
  return typeof idl.address === "string" ? idl.address : null;
}

function readProgramKeypairAddress(
  filepath: string,
  label: string,
  failures: string[],
): string | null {
  if (!existsSync(filepath)) {
    failures.push(`${label}: keypair file is missing`);
    return null;
  }
  if (!statSync(filepath).isFile()) {
    failures.push(`${label}: keypair path is not a regular file`);
    return null;
  }
  if ((statSync(filepath).mode & 0o077) !== 0) {
    failures.push(
      `${label}: keypair permissions must not grant group or world access`,
    );
  }
  try {
    return readKeypairPubkey(filepath);
  } catch {
    failures.push(`${label}: keypair file is invalid`);
    return null;
  }
}

function main(): void {
  const expected = {
    fightOracleProgramId:
      SOLANA_V1_DEPLOYMENTS.solana.localnet.fightOracleProgramId,
    duelMarketProgramId:
      SOLANA_V1_DEPLOYMENTS.solana.localnet.duelMarketProgramId,
  } satisfies SolanaProgramIdentitySet;
  const observations: SolanaProgramIdentityObservation[] = [];
  const failures: string[] = [];
  const manifestPath = path.join(
    resolveStageAProgramKeysDir(),
    "program-addresses.json",
  );
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
        programs?: Partial<Record<StageAProgramBinaryName, unknown>>;
      })
    : null;

  if (!manifest) failures.push("Stage-A program address manifest is missing");

  for (const cluster of [
    "localnet",
    "devnet",
    "testnet",
    "mainnet-beta",
  ] as const) {
    const deployment = SOLANA_V1_DEPLOYMENTS.solana[cluster];
    observations.push(
      {
        label: `${cluster} fight oracle deployment manifest`,
        program: "fightOracleProgramId",
        address: deployment.fightOracleProgramId,
      },
      {
        label: `${cluster} duel market deployment manifest`,
        program: "duelMarketProgramId",
        address: deployment.duelMarketProgramId,
      },
    );
  }

  for (const program of programs) {
    const durablePath = resolveStageAProgramKeypairPath(program.binaryName);
    const targetPath = path.join(
      anchorRoot,
      "target",
      "deploy",
      `${program.binaryName}-keypair.json`,
    );
    const manifestAddress = manifest?.programs?.[program.binaryName];
    observations.push(
      {
        label: `${program.binaryName} durable Stage-A keypair`,
        program: program.identityField,
        address: readProgramKeypairAddress(
          durablePath,
          `${program.binaryName} durable Stage-A keypair`,
          failures,
        ),
      },
      {
        label: `${program.binaryName} Anchor target keypair`,
        program: program.identityField,
        address: readProgramKeypairAddress(
          targetPath,
          `${program.binaryName} Anchor target keypair`,
          failures,
        ),
      },
      {
        label: `${program.binaryName} Stage-A address manifest`,
        program: program.identityField,
        address: typeof manifestAddress === "string" ? manifestAddress : null,
      },
      {
        label: `${program.binaryName} Rust declaration`,
        program: program.identityField,
        address: readDeclaredProgramId(program.binaryName),
      },
      {
        label: `${program.binaryName} canonical IDL`,
        program: program.identityField,
        address: readIdlAddress(program.binaryName),
      },
    );
  }

  failures.push(
    ...evaluateProgramIdentityConvergence({ expected, observations }),
  );
  if (failures.length > 0) {
    console.error("Stage-A Solana program identity verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "pass",
        fightOracleProgramId: expected.fightOracleProgramId,
        duelMarketProgramId: expected.duelMarketProgramId,
        verifiedObservationCount: observations.length,
        keypairPermissions: "owner-only",
      },
      null,
      2,
    ),
  );
}

main();
