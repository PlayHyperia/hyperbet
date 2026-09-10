import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import {
  copyIntoArtifacts,
  resolveArtifactRoot,
  rootDir,
  runCommand,
} from "./ci-lib";

for (const argument of process.argv.slice(2)) {
  if (argument !== "--chain=solana") {
    throw new Error(`unsupported SOL-only E2E argument ${argument}`);
  }
}

const artifactRoot = resolveArtifactRoot("e2e-solana");
const appRoot = path.join(rootDir, "packages/hyperbet-solana/app");
const anchorRoot = path.join(rootDir, "packages/hyperbet-solana/anchor");
const statePath = path.join(appRoot, "tests/e2e/state.json");
const testResultsPath = path.join(appRoot, "test-results");
const keeperStatusRoot = path.join(
  rootDir,
  "packages/hyperbet-solana/keeper/.status",
);
const bootstrapKeypairPath = path.join(
  "/tmp",
  "hyperbet-solana-bootstrap-keypair.json",
);
const buildLogPath = path.join("/tmp", "hyperbet-solana-e2e-build.log");
const marketFlowGrep =
  "solana predictions place YES and NO orders and stage a proposed winner claim|solana predictions finalize a matured proposal and claim winnings|solana resolved loser closes the stale balance and recovers exact rent|solana open prediction markets recover after keeper and proxy restarts|exact Hyperia recovery-window cancellation drives keeper refund and clears claim state";
const harnessFiles = [
  ".e2e-app.log",
  ".e2e-validator.log",
  ".e2e-solana-proxy.log",
  ".e2e-keeper.log",
  ".e2e-duel-bot.log",
  ".e2e-bet-sync-feed.log",
  ".e2e-hls.log",
  ".e2e-hyperia.log",
  ".e2e-keeper.sqlite",
] as const;

function collectHarnessArtifacts(label: string): void {
  copyIntoArtifacts(artifactRoot, statePath, path.join(label, "state.json"));
  copyIntoArtifacts(
    artifactRoot,
    testResultsPath,
    path.join(label, "test-results"),
  );
  copyIntoArtifacts(
    artifactRoot,
    path.join(keeperStatusRoot, "keeper-bot-health.json"),
    path.join(label, "status/keeper-bot-health.json"),
  );
  copyIntoArtifacts(
    artifactRoot,
    path.join(keeperStatusRoot, "stream-state.json"),
    path.join(label, "status/stream-state.json"),
  );
  for (const fileName of harnessFiles) {
    copyIntoArtifacts(
      artifactRoot,
      path.join(appRoot, fileName),
      path.join(label, "runtime", fileName),
    );
  }
}

async function runHarness(
  label: string,
  testFile: string,
  grep: string,
  harnessEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const laneArtifactRoot = path.join(artifactRoot, label);
  rmSync(laneArtifactRoot, { recursive: true, force: true });
  mkdirSync(laneArtifactRoot, { recursive: true });
  try {
    await runCommand(
      "bash",
      ["scripts/run-e2e-local.sh", testFile, "--grep", grep],
      {
        cwd: appRoot,
        env: {
          ...harnessEnv,
          E2E_CONTROL_ARTIFACT_PATH: path.join(
            laneArtifactRoot,
            "control.json",
          ),
        },
        stdoutFile: path.join(artifactRoot, `${label}.out.log`),
        stderrFile: path.join(artifactRoot, `${label}.err.log`),
      },
    );
  } finally {
    collectHarnessArtifacts(label);
  }
}

async function ensureBootstrapWallet(): Promise<void> {
  if (existsSync(bootstrapKeypairPath)) return;
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

async function runGate(): Promise<void> {
  await ensureBootstrapWallet();
  const harnessEnv: NodeJS.ProcessEnv = {
    E2E_SOLANA_BOOTSTRAP_KEYPAIR: bootstrapKeypairPath,
    SOLANA_BOOTSTRAP_KEYPAIR: bootstrapKeypairPath,
    ANCHOR_WALLET: bootstrapKeypairPath,
    E2E_REQUIRE_MATURED_SOLANA_WIN_CLAIM: "true",
    E2E_SOLANA_ORACLE_DISPUTE_WINDOW_SECS: "60",
    E2E_PLAYWRIGHT_RETRIES: "0",
    E2E_SKIP_PREBUILD: "true",
    PW_HEADLESS: process.env.PW_HEADLESS ?? "1",
    PW_WEBGPU_ARGS: process.env.PW_WEBGPU_ARGS ?? "--enable-unsafe-webgpu",
    E2E_APP_PORT: "4281",
    E2E_GAME_API_PORT: "5655",
    E2E_SOLANA_RPC_PORT: "19899",
    E2E_SOLANA_PROXY_PORT: "21899",
  };
  if (process.platform === "darwin") {
    harnessEnv.PW_BROWSER_CHANNEL = process.env.PW_BROWSER_CHANNEL ?? "chrome";
  }

  await runCommand("bun", ["run", "--cwd", anchorRoot, "build"], {
    env: harnessEnv,
    stdoutFile: buildLogPath,
    stderrFile: buildLogPath,
  });

  await runHarness(
    "market-flows",
    "tests/e2e/market-flows.e2e.ts",
    marketFlowGrep,
    harnessEnv,
  );

  await runHarness(
    "api-smoke",
    "tests/e2e/app-tabs-and-apis.e2e.ts",
    "keeper backend exposes all app-facing data endpoints",
    harnessEnv,
  );
}

function collectArtifacts(): void {
  copyIntoArtifacts(artifactRoot, buildLogPath, "prebuild/anchor-build.log");
}

try {
  await runGate();
} finally {
  collectArtifacts();
}
