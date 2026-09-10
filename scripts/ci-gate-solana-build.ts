import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  copyIntoArtifacts,
  resolveArtifactRoot,
  rootDir,
  runCommand,
} from "./ci-lib";

const artifactRoot = resolveArtifactRoot("solana-program-build-gate");
const anchorRoot = path.join(rootDir, "packages/hyperbet-solana/anchor");
const buildLogPath = path.join(artifactRoot, "anchor-build.log");
const deployRoot = path.join(anchorRoot, "target", "deploy");
const deployArtifacts = ["fight_oracle.so", "duel_market.so"];
const trackedArtifactPaths = [
  "packages/hyperbet-solana/anchor/target/idl",
  "packages/hyperbet-solana/app/src/idl",
  "packages/hyperbet-solana/keeper/src/idl",
  "packages/hyperbet-ui/src/idl",
  "packages/market-maker-bot/src/idl",
  "packages/hyperbet-sdk/src/solana/idl",
  "packages/hyperbet-sdk-py/hyperbet_sdk/solana/idl",
];

type ArtifactFingerprint = Map<string, string>;

function collectFiles(absolutePath: string): string[] {
  const metadata = lstatSync(absolutePath);
  if (metadata.isFile()) return [absolutePath];
  if (!metadata.isDirectory()) {
    throw new Error(`unsupported generated artifact path: ${absolutePath}`);
  }
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) =>
    collectFiles(path.join(absolutePath, entry.name)),
  );
}

function fingerprintArtifacts(paths: readonly string[]): ArtifactFingerprint {
  const fingerprint: ArtifactFingerprint = new Map();
  for (const relativeRoot of paths) {
    for (const absoluteFile of collectFiles(path.join(rootDir, relativeRoot))) {
      const relativeFile = path.relative(rootDir, absoluteFile);
      fingerprint.set(
        relativeFile,
        createHash("sha256").update(readFileSync(absoluteFile)).digest("hex"),
      );
    }
  }
  return fingerprint;
}

function describeFingerprintDrift(
  before: ArtifactFingerprint,
  after: ArtifactFingerprint,
): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files]
    .sort((left, right) => left.localeCompare(right))
    .filter((file) => before.get(file) !== after.get(file))
    .map((file) => {
      if (!before.has(file)) return `added ${file}`;
      if (!after.has(file)) return `removed ${file}`;
      return `changed ${file}`;
    });
}

const artifactFingerprintBefore = fingerprintArtifacts(trackedArtifactPaths);

try {
  await runCommand("bun", ["run", "--cwd", anchorRoot, "build"], {
    stdoutFile: buildLogPath,
    stderrFile: buildLogPath,
  });

  const artifactDrift = describeFingerprintDrift(
    artifactFingerprintBefore,
    fingerprintArtifacts(trackedArtifactPaths),
  );
  if (artifactDrift.length > 0) {
    throw new Error(
      [
        "Solana build changed canonical generated artifacts.",
        "Regenerate and review the artifacts, then rerun the gate from that stable state.",
        ...artifactDrift,
      ].join("\n"),
    );
  }
} finally {
  copyIntoArtifacts(artifactRoot, buildLogPath, "anchor-build.log");
  for (const artifact of deployArtifacts) {
    copyIntoArtifacts(
      artifactRoot,
      path.join(deployRoot, artifact),
      path.join("deploy", artifact),
    );
  }
}
