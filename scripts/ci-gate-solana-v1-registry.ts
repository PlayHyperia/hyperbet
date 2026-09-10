import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SOLANA_V1_DEPLOYMENTS,
  type SolanaV1Cluster,
} from "../packages/hyperbet-solana/deployments/v1";

const expectedClusters: SolanaV1Cluster[] = [
  "localnet",
  "devnet",
  "testnet",
  "mainnet-beta",
];
const expectedFields = [
  "cluster",
  "duelMarketProgramId",
  "fightOracleProgramId",
];
const expectedManifestFields = ["realValueProgramVerification", "solana"];
const expectedVerificationFields = ["evidenceSha256", "status"];
const failures: string[] = [];
const canonical = SOLANA_V1_DEPLOYMENTS.solana.localnet;
const sha256 = /^[0-9a-f]{64}$/u;
const zeroPublicKey = "11111111111111111111111111111111";
const base58Alphabet =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58ByteLength(value: string): number {
  if (value.length < 32 || value.length > 44) return -1;
  const bytes = [0];
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) return -1;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }
  return (
    bytes.length +
    leadingZeroes -
    (bytes.length === 1 && bytes[0] === 0 ? 1 : 0)
  );
}

const actualManifestFields = Object.keys(SOLANA_V1_DEPLOYMENTS).sort();
if (actualManifestFields.join(",") !== expectedManifestFields.join(",")) {
  failures.push(
    `manifest: expected only ${expectedManifestFields.join(", ")}; found ${actualManifestFields.join(", ")}`,
  );
}
const verification = SOLANA_V1_DEPLOYMENTS.realValueProgramVerification;
const actualVerificationFields = Object.keys(verification ?? {}).sort();
if (
  actualVerificationFields.join(",") !== expectedVerificationFields.join(",")
) {
  failures.push(
    `real-value program verification: expected only ${expectedVerificationFields.join(", ")}; found ${actualVerificationFields.join(", ")}`,
  );
} else if (verification.status === "unverified") {
  if (verification.evidenceSha256 !== null) {
    failures.push(
      "real-value program verification: unverified status must not advertise evidence",
    );
  }
} else if (verification.status === "verified") {
  if (!sha256.test(verification.evidenceSha256)) {
    failures.push(
      "real-value program verification: verified status requires one lowercase SHA-256 evidence digest",
    );
  }
} else {
  failures.push(
    "real-value program verification: status must be unverified or verified",
  );
}

function readText(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function readDeclaredProgramId(relativePath: string): string | null {
  return (
    readText(relativePath).match(
      /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/,
    )?.[1] ?? null
  );
}

function readIdlAddress(relativePath: string): string | null {
  const parsed = JSON.parse(readText(relativePath)) as { address?: unknown };
  return typeof parsed.address === "string" ? parsed.address : null;
}

for (const cluster of expectedClusters) {
  const deployment = SOLANA_V1_DEPLOYMENTS.solana[cluster];
  if (!deployment) {
    failures.push(`${cluster}: deployment is missing`);
    continue;
  }

  const actualFields = Object.keys(deployment).sort();
  if (actualFields.join(",") !== expectedFields.join(",")) {
    failures.push(
      `${cluster}: expected only ${expectedFields.join(", ")}; found ${actualFields.join(", ")}`,
    );
  }
  if (deployment.cluster !== cluster) {
    failures.push(`${cluster}: embedded cluster is ${deployment.cluster}`);
  }

  for (const [name, value] of [
    ["fightOracleProgramId", deployment.fightOracleProgramId],
    ["duelMarketProgramId", deployment.duelMarketProgramId],
  ] as const) {
    if (base58ByteLength(value) !== 32) {
      failures.push(`${cluster}: ${name} is not a valid Solana public key`);
    } else if (value === zeroPublicKey) {
      failures.push(`${cluster}: ${name} is the default public key`);
    }
  }
  if (deployment.fightOracleProgramId === deployment.duelMarketProgramId) {
    failures.push(`${cluster}: oracle and duel market program IDs must differ`);
  }
  if (deployment.fightOracleProgramId !== canonical.fightOracleProgramId) {
    failures.push(`${cluster}: fight oracle identity differs from localnet`);
  }
  if (deployment.duelMarketProgramId !== canonical.duelMarketProgramId) {
    failures.push(`${cluster}: duel market identity differs from localnet`);
  }
}

const unexpectedClusters = Object.keys(SOLANA_V1_DEPLOYMENTS.solana).filter(
  (cluster) => !expectedClusters.includes(cluster as SolanaV1Cluster),
);
if (unexpectedClusters.length > 0) {
  failures.push(`unexpected clusters: ${unexpectedClusters.join(", ")}`);
}

const sourceIdentities = [
  {
    label: "fight oracle Rust declaration",
    expected: canonical.fightOracleProgramId,
    actual: readDeclaredProgramId(
      "packages/hyperbet-solana/anchor/programs/fight_oracle/src/lib.rs",
    ),
  },
  {
    label: "duel market Rust declaration",
    expected: canonical.duelMarketProgramId,
    actual: readDeclaredProgramId(
      "packages/hyperbet-solana/anchor/programs/duel_market/src/lib.rs",
    ),
  },
  {
    label: "fight oracle canonical IDL",
    expected: canonical.fightOracleProgramId,
    actual: readIdlAddress(
      "packages/hyperbet-solana/anchor/target/idl/fight_oracle.json",
    ),
  },
  {
    label: "duel market canonical IDL",
    expected: canonical.duelMarketProgramId,
    actual: readIdlAddress(
      "packages/hyperbet-solana/anchor/target/idl/duel_market.json",
    ),
  },
] as const;

for (const source of sourceIdentities) {
  if (source.actual !== source.expected) {
    failures.push(
      `${source.label}: expected ${source.expected}; found ${source.actual ?? "missing"}`,
    );
  }
}

const anchorToml = readText("packages/hyperbet-solana/anchor/Anchor.toml");
for (const cluster of ["localnet", "devnet", "testnet", "mainnet"] as const) {
  const section = anchorToml.match(
    new RegExp(`\\[programs\\.${cluster}\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  )?.[1];
  if (!section) {
    failures.push(`Anchor.toml: missing [programs.${cluster}]`);
    continue;
  }
  for (const [name, expected] of [
    ["fight_oracle", canonical.fightOracleProgramId],
    ["duel_market", canonical.duelMarketProgramId],
  ] as const) {
    const actual = section.match(
      new RegExp(`^${name}\\s*=\\s*"([1-9A-HJ-NP-Za-km-z]+)"`, "m"),
    )?.[1];
    if (actual !== expected) {
      failures.push(
        `Anchor.toml [programs.${cluster}] ${name}: expected ${expected}; found ${actual ?? "missing"}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Solana v1 deployment registry gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Solana v1 deployment registry gate passed: four clusters share one two-program identity set; Rust, Anchor, and canonical IDLs match; no token or non-duel fields; mainnet program verification is explicitly ${verification.status}.`,
);
