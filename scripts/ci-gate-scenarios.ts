import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  SCENARIO_PRESETS,
  type ScenarioPreset,
} from "../packages/simulation-dashboard/src/solana-scenario-catalog.ts";
import { normalizeSolanaProofOutcome } from "../packages/simulation-dashboard/src/backends/solana/normalize.ts";
import { runSolanaProofScenario } from "../packages/simulation-dashboard/src/backends/solana/proof-scenarios.ts";
import { SolanaProgramRuntime } from "../packages/simulation-dashboard/src/backends/solana/program-runtime.ts";
import { startSolanaValidator } from "../packages/simulation-dashboard/src/backends/solana/validator.ts";
import {
  resolveArtifactRoot,
  rootDir,
  runCommand,
  writeJsonArtifact,
} from "./ci-lib";

type ScenarioExecution = {
  mode: "canonical" | "matrix";
  scenarioId: string;
  seed: string;
  artifactName: string;
};

const artifactRoot = resolveArtifactRoot("solana-exploit-gate");
const bootstrapKeypairPath = path.join(
  artifactRoot,
  "solana-bootstrap-keypair.json",
);
const solanaAnchorRoot = path.join(rootDir, "packages/hyperbet-solana/anchor");
const solanaDeployRoot = path.join(solanaAnchorRoot, "target", "deploy");
const requiredSolanaDeployArtifacts = [
  "fight_oracle.so",
  "duel_market.so",
] as const;
const canonicalScenarioIds = [
  "solana-stale-resolution-window",
  "solana-lock-race-attempt",
  "solana-cancel-replace-griefing",
  "solana-inventory-poisoning",
  "solana-claim-refund-abuse",
  "solana-cross-market-validation-abuse",
] as const;
const matrixScenarioIds = [
  "solana-lock-race-attempt",
  "solana-inventory-poisoning",
  "solana-cross-market-validation-abuse",
] as const;

function validateArgs(): void {
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith("--scenario=")) continue;
    if (argument !== "--target=solana") {
      throw new Error(`unsupported SOL-only scenario argument ${argument}`);
    }
  }
}

function parseScenarioFilter(): string | null {
  const value =
    process.argv
      .slice(2)
      .find((argument) => argument.startsWith("--scenario="))
      ?.slice("--scenario=".length)
      .trim() ?? "";
  return value.length > 0 ? value : null;
}

function getScenarioPreset(scenarioId: string): ScenarioPreset {
  const preset =
    SCENARIO_PRESETS.find(
      (candidate) =>
        candidate.id === scenarioId && candidate.chainKey === "solana",
    ) ?? null;
  if (!preset) {
    throw new Error(`unknown Solana scenario preset ${scenarioId}`);
  }
  return preset;
}

function sanitizeArtifactName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

function buildScenarioExecutions(
  scenarioIds: readonly string[],
  mode: ScenarioExecution["mode"],
): ScenarioExecution[] {
  return scenarioIds.flatMap((scenarioId) => {
    const preset = getScenarioPreset(scenarioId);
    const seeds =
      mode === "canonical"
        ? [preset.canonicalSeed]
        : [preset.canonicalSeed, ...preset.matrixSeeds];
    return seeds.map((seed, index) => ({
      mode,
      scenarioId,
      seed,
      artifactName:
        mode === "canonical"
          ? `${scenarioId}-canonical`
          : `${scenarioId}-matrix-${index + 1}`,
    }));
  });
}

async function ensureBootstrapWallet(): Promise<void> {
  if (!existsSync(bootstrapKeypairPath)) {
    mkdirSync(path.dirname(bootstrapKeypairPath), { recursive: true });
    await runCommand(
      "solana-keygen",
      [
        "new",
        "--no-bip39-passphrase",
        "--silent",
        "--force",
        "-o",
        bootstrapKeypairPath,
      ],
      {
        stdoutFile: path.join(artifactRoot, "solana-keygen.out.log"),
        stderrFile: path.join(artifactRoot, "solana-keygen.err.log"),
      },
    );
  }

  process.env.ANCHOR_WALLET = bootstrapKeypairPath;
  process.env.E2E_SOLANA_BOOTSTRAP_KEYPAIR = bootstrapKeypairPath;
  process.env.SOLANA_BOOTSTRAP_KEYPAIR = bootstrapKeypairPath;
}

async function ensureSolanaDeployArtifacts(): Promise<void> {
  // Always rebuild before a Solana scenario run. Existence alone can select a
  // stale .so from an older source revision and produce false launch evidence.
  const buildLogPath = path.join(artifactRoot, "solana-anchor-build.log");
  await runCommand("bun", ["run", "--cwd", solanaAnchorRoot, "build"], {
    stdoutFile: buildLogPath,
    stderrFile: buildLogPath,
  });

  const missingArtifacts = requiredSolanaDeployArtifacts.filter(
    (artifact) => !existsSync(path.join(solanaDeployRoot, artifact)),
  );
  if (missingArtifacts.length > 0) {
    throw new Error(
      `Solana deploy artifacts still missing after build: ${missingArtifacts.join(", ")}`,
    );
  }
}

async function runScenario(execution: ScenarioExecution): Promise<void> {
  const preset = getScenarioPreset(execution.scenarioId);
  const scenarioArtifactRoot = path.join(
    artifactRoot,
    "scenarios",
    sanitizeArtifactName(execution.artifactName),
  );
  mkdirSync(scenarioArtifactRoot, { recursive: true });
  writeJsonArtifact(scenarioArtifactRoot, "request.json", execution);

  const stages: Array<{ at: number; stage: string }> = [];
  const logs: string[] = [];
  const validator = await startSolanaValidator();
  try {
    const runtime = await SolanaProgramRuntime.create(validator);
    const outcome = await runSolanaProofScenario(runtime, {
      preset,
      seed: execution.seed,
      winner: preset.defaultWinner,
      attackUnauthorizedReporter: false,
      onStage: (stage) => stages.push({ at: Date.now(), stage }),
      onLog: (message) => logs.push(message),
    });
    const { result, state } = normalizeSolanaProofOutcome(outcome);
    const record = {
      scenarioId: execution.scenarioId,
      seed: execution.seed,
      mode: execution.mode,
      status: result.passed ? "succeeded" : "failed",
      stages,
      logs,
      result,
      state,
    };
    writeJsonArtifact(scenarioArtifactRoot, "result.json", record);
    if (!result.passed) {
      throw new Error(
        `scenario ${execution.scenarioId} (${execution.seed}) failed`,
      );
    }
  } catch (error) {
    writeJsonArtifact(scenarioArtifactRoot, "failure.json", {
      scenarioId: execution.scenarioId,
      seed: execution.seed,
      mode: execution.mode,
      stages,
      logs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await validator.stop();
  }
}

validateArgs();
const scenarioFilter = parseScenarioFilter();
await ensureBootstrapWallet();
await ensureSolanaDeployArtifacts();

const selectedCanonical = scenarioFilter
  ? canonicalScenarioIds.filter((scenarioId) => scenarioId === scenarioFilter)
  : canonicalScenarioIds;
const selectedMatrix = scenarioFilter
  ? matrixScenarioIds.filter((scenarioId) => scenarioId === scenarioFilter)
  : matrixScenarioIds;
if (
  scenarioFilter &&
  selectedCanonical.length === 0 &&
  selectedMatrix.length === 0
) {
  throw new Error(`unknown Solana scenario filter ${scenarioFilter}`);
}

const executions = [
  ...buildScenarioExecutions(selectedCanonical, "canonical"),
  ...buildScenarioExecutions(selectedMatrix, "matrix"),
];
writeJsonArtifact(artifactRoot, "executions.json", executions);

for (const execution of executions) {
  await runScenario(execution);
}

// Solana web3 keeps a reconnectable RPC websocket handle after the validator
// is intentionally stopped. Every scenario and artifact is complete here, so
// terminate the CI process instead of allowing that client handle to linger.
process.exit(0);
