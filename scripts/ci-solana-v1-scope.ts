import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];
const prohibitedLegacyBrandPattern = new RegExp(
  ["hyper", "scape"].join(""),
  "i",
);

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function fail(message: string): void {
  failures.push(message);
}

function requireAbsent(
  relativePath: string,
  patterns: readonly RegExp[],
): void {
  const contents = read(relativePath);
  for (const pattern of patterns) {
    if (pattern.test(contents)) {
      fail(`${relativePath} still matches forbidden v1 pattern ${pattern}`);
    }
  }
}

const rootPackage = JSON.parse(read("package.json")) as {
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  packageManager?: string;
  workspaces?: string[];
};
const scripts = rootPackage.scripts ?? {};
const bunfig = read("bunfig.toml");
if (!/\[install\][\s\S]*?\bpeer\s*=\s*false\b/u.test(bunfig)) {
  fail("bunfig.toml must disable undeclared peer auto-installation");
}
const expectedLaunchWorkspaces = [
  "packages/hyperbet-solana",
  "packages/hyperbet-solana/app",
  "packages/hyperbet-solana/keeper",
  "packages/hyperbet-sdk",
  "packages/hyperbet-ui",
] as const;
if (
  JSON.stringify(rootPackage.workspaces) !==
  JSON.stringify(expectedLaunchWorkspaces)
) {
  fail(
    `root workspaces must be the exact SOL-only launch allowlist: ${expectedLaunchWorkspaces.join(", ")}`,
  );
}

const lockfileWorkspacePaths = Array.from(
  new Set(
    Array.from(
      read("bun.lock").matchAll(/workspace:(packages\/[^"\s,\]]+)/g),
      (match) => match[1],
    ),
  ),
).sort();
if (
  JSON.stringify(lockfileWorkspacePaths) !==
  JSON.stringify([...expectedLaunchWorkspaces].sort())
) {
  fail(
    `bun.lock workspace graph is not the exact SOL-only launch allowlist: ${lockfileWorkspacePaths.join(", ")}`,
  );
}
const bunVersion = rootPackage.packageManager?.match(/^bun@(.+)$/)?.[1];
if (!bunVersion) {
  fail("root packageManager must pin an exact Bun version");
} else {
  for (const [runtimePath, expectedPin] of [
    [".github/actions/setup-hyperbet/action.yml", `default: \"${bunVersion}\"`],
    [
      "packages/hyperbet-solana/keeper/Dockerfile",
      `FROM oven/bun:${bunVersion}`,
    ],
  ] as const) {
    if (!read(runtimePath).includes(expectedPin)) {
      fail(`${runtimePath} is not pinned to Bun ${bunVersion}`);
    }
  }
}
const rustVersion = "1.93.1";
const setupHyperbetActionPath = ".github/actions/setup-hyperbet/action.yml";
const setupHyperbetAction = read(setupHyperbetActionPath);
for (const requiredToolchainControl of [
  'if [[ "${RUNNER_OS:-}" != "Linux" ]]',
  'if [[ "${RUNNER_ARCH:-}" != "X64" ]]',
  'if [[ "${ImageOS:-}" != "ubuntu24" ]]',
  "${ImageVersion:-}",
  `default: "${rustVersion}"`,
  'default: "a2e21dda295b18dd09ac06542834c5e9b1b2dc84"',
  'default: "1ebbe58158d089a2a40b5e35ebead5a10db9090d"',
  "toolchain: ${{ inputs.rust-version }}",
  "no-cache: true",
  'token: ""',
  "rustc --version",
  "cargo --version",
  "solana_bin --version",
  "--proto '=https'",
  "--proto-redir '=https'",
  "--max-filesize 1048576",
  "target: x86_64-unknown-linux-gnu",
  "--git https://github.com/otter-sec/anchor",
  '--rev "$EXPECTED_ANCHOR_REVISION"',
  '--version "=${EXPECTED_CARGO_AUDIT_VERSION}"',
] as const) {
  if (!setupHyperbetAction.includes(requiredToolchainControl)) {
    fail(`${setupHyperbetActionPath} is missing ${requiredToolchainControl}`);
  }
}
for (const forbiddenExecutableCacheControl of [
  "~/.cargo/bin",
  "path: ~/.local/share/solana",
  "Cache Solana CLI",
  'sh -c "$(curl',
  "--tag",
] as const) {
  if (setupHyperbetAction.includes(forbiddenExecutableCacheControl)) {
    fail(
      `${setupHyperbetActionPath} must not cache executable toolchain state: ${forbiddenExecutableCacheControl}`,
    );
  }
}
const forbiddenRootScript = /(^|:)(?:bsc|avax|base|evm)(?::|$)/i;
const forbiddenRootTarget =
  /packages\/hyperbet-(?:bsc|avax|evm)|--(?:chain|target)=(?:bsc|avax|base|evm)|ci-gate-(?:amm|base|perps)/i;

for (const [name, command] of Object.entries(scripts)) {
  if (forbiddenRootScript.test(name) || forbiddenRootTarget.test(command)) {
    fail(`root script ${name} is outside the SOL-only v1 command surface`);
  }
}

if (
  scripts["ci:env"] !== "node --import tsx scripts/ci-env-audit-solana-v1.ts"
) {
  fail("root environment audit is not pinned to the SOL-only v1 entrypoint");
}
if (
  !scripts["ci:scope:solana"]?.includes(
    "bun test scripts/ci-env-audit-solana-v1-policy.test.ts scripts/ci-keeper-runtime-env-solana-v1-policy.test.ts scripts/ci-solana-mainnet-program-verification-policy.test.ts && node --test scripts/ci-github-actions-policy.test.mjs scripts/ci-solana-devnet-funding-policy.test.mjs scripts/ci-solana-keeper-deploy-target.test.mjs scripts/ci-solana-railway-config.test.mjs scripts/solana-deployment-evidence.test.mjs scripts/verify-solana-keeper-deployment.test.mjs scripts/ci-solana-pages-deployment-output.test.mjs scripts/ci-solana-pages-deploy-target.test.mjs scripts/solana-pages-build-identity.test.mjs scripts/solana-pages-bundle-manifest.test.mjs scripts/verify-solana-pages-deployment.test.mjs scripts/resolve-pages-deployment-url-with-scoped-auth.test.mjs scripts/run-railway-with-scoped-auth.test.mjs scripts/run-wrangler-with-scoped-auth.test.mjs scripts/ci-env-audit-solana-v1.test.mjs && node scripts/ci-github-actions-policy.mjs && node scripts/ci-solana-railway-config.mjs",
  )
) {
  fail(
    "SOL-only scope must execute the tracked and protected-runtime environment policy tests",
  );
}
if (scripts.typecheck !== "bun run typecheck:solana") {
  fail("root typecheck must delegate to the SOL-only workspace graph");
}
if (scripts.test !== "bun run test:launch:solana") {
  fail("root test must delegate to the SOL-only launch workspace graph");
}
if (
  scripts["test:launch:solana"] !==
  "turbo run test --filter=hyperbet-solana-app --filter=hyperbet-solana-keeper --filter=@hyperbet/sdk --filter=@hyperbet/ui && bun run --cwd packages/hyperbet-solana/anchor test"
) {
  fail("SOL-only test graph is not pinned to launch workspaces");
}
if (scripts.lint !== "bun run lint:solana") {
  fail("root lint must delegate to the SOL-only workspace graph");
}
if (
  scripts["lint:solana"] !==
  "turbo run lint --filter=hyperbet-solana-app... --filter=hyperbet-solana-keeper --filter=@hyperbet/sdk && bun run ci:scenarios:solana:policy"
) {
  fail("SOL-only lint graph is not pinned to launch workspaces");
}
if (
  scripts["typecheck:solana"] !==
  "turbo run typecheck --filter=hyperbet-solana-app... --filter=hyperbet-solana-keeper --filter=@hyperbet/sdk && (cd packages/hyperbet-solana/anchor && ./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json) && tsc --noEmit -p packages/simulation-dashboard/tsconfig.solana.json"
) {
  fail("SOL-only typecheck graph is not pinned to launch workspaces");
}
if (
  scripts["ci:scenarios:solana:policy"] !==
  "tsc --noEmit -p packages/simulation-dashboard/tsconfig.solana.json && bun test packages/simulation-dashboard/src/solana-scenario-catalog.test.ts packages/simulation-dashboard/src/backends/solana/normalize.test.ts"
) {
  fail(
    "Solana scenario policy command is not pinned to the direct proof graph",
  );
}
const expectedHighSeverityAudit =
  "node --test scripts/check-high-severity-audit.test.mjs && node scripts/check-high-severity-audit.mjs";
if (scripts["ci:security:high"] !== expectedHighSeverityAudit) {
  fail("high-severity dependency audit is not pinned to the reviewed policy");
}
if (!scripts["ci:scope:solana"]?.includes("bun run ci:security:high")) {
  fail("SOL-only scope gate does not enforce the high-severity audit");
}
const anchorPackage = JSON.parse(
  read("packages/hyperbet-solana/anchor/package.json"),
) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
if (
  anchorPackage.scripts?.typecheck !== "tsc --noEmit -p tsconfig.tests.json"
) {
  fail("Anchor typecheck is not pinned to the launch-test TypeScript graph");
}
if (!anchorPackage.devDependencies?.["@types/node"]) {
  fail("Anchor launch-test typecheck does not declare Node.js types");
}
const anchorTestTsconfig = read(
  "packages/hyperbet-solana/anchor/tsconfig.tests.json",
);
for (const requiredAnchorTypecheckControl of [
  '"include": ["tests/**/*.ts"]',
  '"tests/market_maker_bot_smoke.ts"',
] as const) {
  if (!anchorTestTsconfig.includes(requiredAnchorTypecheckControl)) {
    fail(
      `Anchor launch-test typecheck is missing ${requiredAnchorTypecheckControl}`,
    );
  }
}
for (const retiredOperatorScript of [
  "pm:soak",
  "pm:soak:harness",
  "ci:gate:soak:contract",
]) {
  if (scripts[retiredOperatorScript]) {
    fail(
      `root still exposes retired operator command ${retiredOperatorScript}`,
    );
  }
}
for (const rootDeveloperEntrypoint of [
  "scripts/run-local-demo.ts",
  "scripts/dev-bootstrap.ts",
  "scripts/dev-doctor.ts",
  "scripts/ci-install-verified.sh",
  ".github/actions/setup-hyperbet/action.yml",
]) {
  requireAbsent(rootDeveloperEntrypoint, [
    /packages\/hyperbet-(?:bsc|avax|evm)/i,
    /\b(?:AVAX|Avalanche|BSC|Base Sepolia|EVM|anvil|forge|foundry)\b/i,
  ]);
}
if (!read("scripts/run-local-demo.ts").includes('target !== "solana"')) {
  fail("local demo dispatcher does not fail closed to Solana");
}

if (
  scripts["ci:gate:registry:launch"] !==
  "node --import tsx scripts/ci-gate-solana-v1-registry.ts && bun test packages/hyperbet-solana/tests/deployments.test.ts packages/hyperbet-solana/scripts/verify-mainnet-program-registry.test.ts packages/hyperbet-solana/tests/duel-market-artifacts.test.ts packages/hyperbet-solana/tests/build-workspace-policy.test.ts"
) {
  fail("launch registry/artifact gate is not the dedicated Solana v1 gate");
}

const keeperPackage = JSON.parse(
  read("packages/hyperbet-solana/keeper/package.json"),
) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};
if (keeperPackage.scripts?.["duel-bot"] !== "bun --bun src/duelBot.ts") {
  fail("keeper duel-bot command is not pinned to the launch-only entrypoint");
}
if (
  keeperPackage.scripts?.typecheck !==
  "bunx tsc --noEmit -p tsconfig.launch.json"
) {
  fail("keeper typecheck is not pinned to the launch-only TypeScript graph");
}
if (
  keeperPackage.scripts?.lint !== "bunx tsc --noEmit -p tsconfig.launch.json"
) {
  fail("keeper lint is not pinned to the launch-only TypeScript graph");
}
if (keeperPackage.scripts?.test !== "bun run test:launch") {
  fail("keeper default test is not pinned to the launch suite");
}
if (
  Object.values(keeperPackage.scripts ?? {}).some((command) =>
    /src\/bot\.ts/.test(command),
  )
) {
  fail("keeper package still exposes the retired mixed bot");
}
if (
  keeperPackage.scripts?.["terminal-ops"] !== "bun --bun src/terminalOps.ts"
) {
  fail("keeper terminal recovery command is not pinned to the audited CLI");
}
if (keeperPackage.dependencies?.["@hyperbet/mm-core"]) {
  fail("SOL keeper runtime still depends on the shared multi-chain MM core");
}
const launchTestCommand = keeperPackage.scripts?.["test:launch"] ?? "";
const launchTestTokens = launchTestCommand.trim().split(/\s+/u);
if (
  launchTestTokens[0] !== "bun" ||
  launchTestTokens[1] !== "test" ||
  launchTestTokens.length < 3
) {
  fail("keeper launch suite must be one explicit Bun test-file allowlist");
}
const launchTestPaths = launchTestTokens.slice(2);
if (new Set(launchTestPaths).size !== launchTestPaths.length) {
  fail("keeper launch suite contains duplicate test paths");
}
for (const launchTestPath of launchTestPaths) {
  if (
    !/^src\/[A-Za-z0-9.-]+\.test\.ts$/u.test(launchTestPath) ||
    !existsSync(join(root, "packages/hyperbet-solana/keeper", launchTestPath))
  ) {
    fail(
      "keeper launch suite test is missing or noncanonical: " + launchTestPath,
    );
  }
}
for (const requiredLaunchTest of [
  "src/finalizedSolanaRecoveryQualification.test.ts",
  "src/finalizedSolanaRecoveryReconciliation.test.ts",
  "src/launchHealth.test.ts",
  "src/keeperRecoveryMaterialization.test.ts",
  "src/keeperRecoverySet.test.ts",
  "src/managedLiquidityRiskPolicy.test.ts",
  "src/operatorAlertDispatcher.test.ts",
  "src/operatorAlertProbe.test.ts",
  "src/operatorAlertStateBackup.test.ts",
  "src/operatorAlertStateStore.test.ts",
  "src/serviceOperatorReadiness.integration.test.ts",
  "src/solanaMarketMakerPolicy.test.ts",
  "src/solanaProxyRailPolicy.test.ts",
  "src/solanaRpcProxyPolicy.test.ts",
  "src/streamStateCandidatePolicy.test.ts",
]) {
  if (!launchTestCommand.includes(requiredLaunchTest)) {
    fail(`keeper launch suite is missing ${requiredLaunchTest}`);
  }
}
const streamStateCandidatePolicySource = read(
  "packages/hyperbet-solana/keeper/src/streamStateCandidatePolicy.ts",
);
const streamStateCandidatePolicyTestSource = read(
  "packages/hyperbet-solana/keeper/src/streamStateCandidatePolicy.test.ts",
);
if (
  !streamStateCandidatePolicySource.includes(
    "Number.isSafeInteger(state.emittedAt)",
  ) ||
  streamStateCandidatePolicySource.includes(
    "Number.isFinite(state.emittedAt)",
  ) ||
  !streamStateCandidatePolicyTestSource.includes(
    "rejects sequence, timestamp, and malformed cursor regressions",
  ) ||
  !streamStateCandidatePolicyTestSource.includes(
    "permits a sequence reset only after outage and newer authority time",
  ) ||
  !streamStateCandidatePolicyTestSource.includes(
    "preserves an accepted producer cursor exactly and rejects invalid authority",
  ) ||
  !streamStateCandidatePolicyTestSource.includes(
    "Number.MAX_SAFE_INTEGER + 1",
  ) ||
  !streamStateCandidatePolicyTestSource.includes("resolveAcceptedStreamCursor")
) {
  fail("keeper stream-state cursor lacks exact launch authority coverage");
}
const duelKeeperPath = "packages/hyperbet-solana/keeper/src/duelBot.ts";
const duelKeeperSource = read(duelKeeperPath);
if (
  !/\.placeOrder\([\s\S]*?ORDER_BEHAVIOR_POST_ONLY,\s*\)/.test(duelKeeperSource)
) {
  fail(
    `${duelKeeperPath} must submit managed liquidity as post-only so it cannot become taker flow`,
  );
}
if (/\.placeOrder\([\s\S]*?ORDER_BEHAVIOR_GTC,\s*\)/.test(duelKeeperSource)) {
  fail(
    `${duelKeeperPath} still submits managed liquidity as crossing-capable GTC`,
  );
}
if (
  !duelKeeperSource.includes("classifyManagedLiquiditySubmissionError(error)")
) {
  fail(
    `${duelKeeperPath} does not bound expected post-only/order-sequence races for next-cycle replanning`,
  );
}
for (const requiredNonLocalRiskControl of [
  "resolveClusterManagedLiquidityRiskPolicy({",
  "SOLANA_LAUNCH_MARKET_MAKER_RISK_APPROVED",
  "MARKET_MAKER_MIN_QUOTE_SOL",
  "MARKET_MAKER_MAX_INVENTORY_SOL_PER_SIDE",
  "MARKET_MAKER_MAX_NET_EXPOSURE_SOL",
  "MARKET_MAKER_MAX_GROSS_EXPOSURE_SOL",
  "MARKET_MAKER_MAX_SIDE_IMBALANCE_BPS",
  "MARKET_MAKER_MAX_DRAWDOWN_BPS",
] as const) {
  if (!duelKeeperSource.includes(requiredNonLocalRiskControl)) {
    fail(
      `${duelKeeperPath} is missing explicit non-local liquidity risk control ${requiredNonLocalRiskControl}`,
    );
  }
}
if (
  duelKeeperSource.includes(
    "const approvedManagedLiquidityRiskPolicy = isMainnetBot",
  ) ||
  duelKeeperSource.includes("const isMainnetBot =")
) {
  fail(
    `${duelKeeperPath} restores mainnet-only liquidity policy and leaves staging on local defaults`,
  );
}
const duelMarketAnchorTestPath =
  "packages/hyperbet-solana/anchor/tests/duel_market.anchor.ts";
const duelMarketAnchorTestSource = read(duelMarketAnchorTestPath);
const generatedStateMachineCorpusPath =
  "packages/hyperbet-solana/anchor/tests/fixtures/duel-market-generated-corpus.json";
const generatedStateMachineCorpusSource = read(generatedStateMachineCorpusPath);
const generalizedStateMachineTestPath =
  "packages/hyperbet-solana/anchor/tests/duel_market_generalized.anchor.ts";
const generalizedStateMachineTestSource = read(generalizedStateMachineTestPath);
const generalizedStateMachineCorpusPath =
  "packages/hyperbet-solana/anchor/tests/fixtures/duel-market-generalized-corpus.json";
const generalizedStateMachineCorpusSource = read(
  generalizedStateMachineCorpusPath,
);
const multiPriceContinuationTestPath =
  "packages/hyperbet-solana/anchor/tests/duel_market_continuation.anchor.ts";
const multiPriceContinuationTestSource = read(multiPriceContinuationTestPath);
const clobTestHelpersPath =
  "packages/hyperbet-solana/anchor/tests/clob-test-helpers.ts";
const clobTestHelpersSource = read(clobTestHelpersPath);
const generatedStateMachineReplaySource = read(
  "packages/hyperbet-solana/anchor/tests/generated-state-machine-replay.ts",
);
const generatedStateMachinePromotionSource = read(
  "packages/hyperbet-solana/anchor/scripts/promote-generated-state-machine-failure.ts",
);
for (const requiredLiabilityProof of [
  "conserves aggregate multi-user liabilities through a paused resolved market",
  "allows cancellation sync and complete refunds while globally paused",
  "conserves liabilities across simultaneous A-win, B-win, and cancelled markets",
  "the new canonical head retains its matched-out predecessor until unlink",
  "staleHeadOrder.prevOrderId.toString()",
] as const) {
  if (!duelMarketAnchorTestSource.includes(requiredLiabilityProof)) {
    fail(
      `${duelMarketAnchorTestPath} is missing launch liability proof ${requiredLiabilityProof}`,
    );
  }
}
const duelMarketSecurityTestPath =
  "packages/hyperbet-solana/anchor/tests/duel_market_security.ts";
const duelMarketSecurityTestSource = read(duelMarketSecurityTestPath);
for (const requiredAccountGraphProof of [
  "rejects a deterministic malformed match-account matrix without custody drift",
  "same-market wrong-user maker balance",
  "correct accounts in the wrong order",
] as const) {
  if (!duelMarketSecurityTestSource.includes(requiredAccountGraphProof)) {
    fail(
      `${duelMarketSecurityTestPath} is missing account-graph proof ${requiredAccountGraphProof}`,
    );
  }
}
const terminalProcessRecoveryTestPath =
  "packages/hyperbet-solana/keeper/src/terminalProcessRecovery.test.ts";
const terminalProcessRecoveryTestSource = read(terminalProcessRecoveryTestPath);
for (const requiredProcessRecoveryProof of [
  "recovers one exact terminal operation and feed checkpoint after SIGKILL",
  "recovers a simultaneous terminal batch exactly once after SIGKILL",
  "PROCESSING: 4",
  "SUCCEEDED: 4",
] as const) {
  if (
    !terminalProcessRecoveryTestSource.includes(requiredProcessRecoveryProof)
  ) {
    fail(
      `${terminalProcessRecoveryTestPath} is missing process-recovery proof ${requiredProcessRecoveryProof}`,
    );
  }
}
const terminalCrashWorkerFixturePath =
  "packages/hyperbet-solana/keeper/src/terminalCrashWorker.fixture.ts";
const terminalCrashWorkerFixtureSource = read(terminalCrashWorkerFixturePath);
for (const requiredCrashWorkerControl of [
  "expectedClaimCount",
  "claimed.length !== expectedClaimCount",
  "canonical Hyperia recovery-window-elapsed events",
] as const) {
  if (!terminalCrashWorkerFixtureSource.includes(requiredCrashWorkerControl)) {
    fail(
      `${terminalCrashWorkerFixturePath} is missing crash-worker control ${requiredCrashWorkerControl}`,
    );
  }
}

const solanaPackage = JSON.parse(
  read("packages/hyperbet-solana/package.json"),
) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};
if (
  solanaPackage.scripts?.["keeper:duel"] !== "bun run --cwd keeper duel-bot"
) {
  fail("Solana package does not expose the dedicated duel keeper");
}
for (const [scriptName, expectedCommand] of Object.entries({
  "deploy:preflight:devnet":
    "bun run scripts/preflight-contract-deploy.ts --cluster devnet",
  "deploy:preflight:testnet":
    "bun run scripts/preflight-contract-deploy.ts --target testnet",
  "deploy:preflight:mainnet":
    "bun run scripts/preflight-contract-deploy.ts --target mainnet",
  "deploy:init:devnet":
    "node --import tsx scripts/init-pm-config.ts --cluster devnet",
  "deploy:init:testnet":
    "node --import tsx scripts/init-pm-config.ts --cluster testnet",
  "deploy:init:mainnet":
    "node --import tsx scripts/init-pm-config.ts --cluster mainnet-beta --freeze",
  "verify:deployment:devnet":
    "node --import tsx scripts/verify-deployment.ts --cluster devnet",
  "verify:deployment:testnet":
    "node --import tsx scripts/verify-deployment.ts --cluster testnet",
  "verify:deployment:mainnet":
    "node --import tsx scripts/verify-deployment.ts --cluster mainnet-beta",
})) {
  if (solanaPackage.scripts?.[scriptName] !== expectedCommand) {
    fail(`${scriptName} is not pinned to the SOL-only deployment command`);
  }
}
if (solanaPackage.dependencies?.["@hyperbet/chain-registry"]) {
  fail(
    "Solana launch package still depends on the shared multi-chain registry",
  );
}
if (solanaPackage.dependencies?.["@hyperbet/mm-core"]) {
  fail("Solana launch package still depends on the shared multi-chain MM core");
}

const sharedUiPackage = JSON.parse(
  read("packages/hyperbet-ui/package.json"),
) as {
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
};
for (const retiredDependency of [
  "@hyperbet/chain-registry",
  "@rainbow-me/rainbowkit",
  "@jup-ag/api",
  "@solana/spl-token",
  "@solana/wallet-adapter-base",
  "@solana/wallet-adapter-phantom",
  "@solana/wallet-adapter-react",
  "@solana/wallet-adapter-react-ui",
  "@solana/wallet-adapter-wallets",
  "@tanstack/react-query",
  "lightweight-charts",
  "sonner",
  "viem",
  "wagmi",
]) {
  if (sharedUiPackage.dependencies?.[retiredDependency]) {
    fail(`shared SOL UI still depends on ${retiredDependency}`);
  }
}
for (const exportPath of Object.keys(sharedUiPackage.exports ?? {})) {
  if (
    /(?:evm|chain(?:context|config|selector)|gold|perps|walletlink|wagmi|jupiter|birdeye|theme)/i.test(
      exportPath,
    ) ||
    /components\/(?:ModelsMarketView|PointsDisplay|ReferralPanel)$/i.test(
      exportPath,
    )
  ) {
    fail(`shared SOL UI still exposes retired entrypoint ${exportPath}`);
  }
}

const sharedUiSourcePaths = (
  readdirSync(join(root, "packages/hyperbet-ui/src"), {
    recursive: true,
  }) as string[]
)
  .filter((entry) => /\.(?:ts|tsx|json)$/.test(entry))
  .map((entry) => join("packages/hyperbet-ui/src", entry));
for (const relativePath of sharedUiSourcePaths) {
  requireAbsent(relativePath, [
    /@hyperbet\/chain-registry/,
    /@rainbow-me\/rainbowkit/,
    /@solana\/wallet-adapter/,
    /\b(?:AVAX|Avalanche|BSC|EVM|perps|amm)\b/i,
    /gold[_-]?(?:token|mint|clob|perps|amm|amount|balance)/i,
    /wallet[_ -]?link/i,
    /staking[_ -]?daily/i,
  ]);
}

const typescriptSdkPackage = JSON.parse(
  read("packages/hyperbet-sdk/package.json"),
) as { dependencies?: Record<string, string>; description?: string };
for (const retiredDependency of [
  "ethers",
  "viem",
  "wagmi",
  "@hyperbet/chain-registry",
]) {
  if (typescriptSdkPackage.dependencies?.[retiredDependency]) {
    fail(`TypeScript SOL SDK still depends on ${retiredDependency}`);
  }
}
const pythonSdkManifest = read("packages/hyperbet-sdk-py/pyproject.toml");
for (const retiredDependencyPattern of [
  /^web3\s*=/im,
  /^eth-account\s*=/im,
  /^eth-typing\s*=/im,
]) {
  if (retiredDependencyPattern.test(pythonSdkManifest)) {
    fail(
      `Python SOL SDK still declares retired dependency ${retiredDependencyPattern}`,
    );
  }
}

const sdkSourcePaths = [
  "packages/hyperbet-sdk/README.md",
  "packages/hyperbet-sdk/package.json",
  "packages/hyperbet-sdk/tsup.config.ts",
  "packages/hyperbet-sdk-py/README.md",
  "packages/hyperbet-sdk-py/pyproject.toml",
  ...(
    readdirSync(join(root, "packages/hyperbet-sdk/src"), {
      recursive: true,
    }) as string[]
  )
    .filter((entry) => /\.(?:ts|tsx|json)$/.test(entry))
    .map((entry) => join("packages/hyperbet-sdk/src", entry)),
  ...(
    readdirSync(join(root, "packages/hyperbet-sdk/tests"), {
      recursive: true,
    }) as string[]
  )
    .filter((entry) => /\.(?:ts|tsx|json)$/.test(entry))
    .map((entry) => join("packages/hyperbet-sdk/tests", entry)),
  ...(
    readdirSync(join(root, "packages/hyperbet-sdk-py/hyperbet_sdk"), {
      recursive: true,
    }) as string[]
  )
    .filter((entry) => /\.(?:py|json)$/.test(entry))
    .map((entry) => join("packages/hyperbet-sdk-py/hyperbet_sdk", entry)),
  ...(
    readdirSync(join(root, "packages/hyperbet-sdk-py/tests"), {
      recursive: true,
    }) as string[]
  )
    .filter((entry) => /\.(?:py|json)$/.test(entry))
    .map((entry) => join("packages/hyperbet-sdk-py/tests", entry)),
];
for (const relativePath of sdkSourcePaths) {
  requireAbsent(relativePath, [
    /\b(?:AVAX|Avalanche|BSC|Base Sepolia|EVM)\b/i,
    /(?:from|import)\s+["']?web3\b/i,
    /\bethers\b/i,
    /DuelOutcomeOracle|GoldClob|gold[_-]?(?:token|mint|clob|perps|amm)/i,
    /@hyperbet\/chain-registry/,
  ]);
}
for (const [sdkTypePath, requiredConstant] of [
  ["packages/hyperbet-sdk/src/types.ts", "MARKET_KIND_DUEL_WINNER = 1"],
  [
    "packages/hyperbet-sdk-py/hyperbet_sdk/types.py",
    "MARKET_KIND_DUEL_WINNER = 1",
  ],
] as const) {
  if (!read(sdkTypePath).includes(requiredConstant)) {
    fail(`${sdkTypePath} does not use the canonical duel-winner market kind`);
  }
}

const solanaReadmePath = "packages/hyperbet-solana/README.md";
const solanaReadme = read(solanaReadmePath);
for (const requiredLaunchBoundary of [
  "deployments/solana-v1.json",
  "native-SOL",
  "outside the launch closure",
]) {
  if (!solanaReadme.includes(requiredLaunchBoundary)) {
    fail(
      `${solanaReadmePath} does not document launch boundary ${requiredLaunchBoundary}`,
    );
  }
}
requireAbsent(solanaReadmePath, [
  /@hyperbet\/chain-registry/,
  /packages\/hyperbet-chain-registry/,
  /user-facing[^\n]*(?:perps|models)/i,
  /internal[^\n]*AMM[^\n]*(?:engine|surface)/i,
  /full-product/i,
]);

const launchDocumentationPaths = [
  "README.md",
  solanaReadmePath,
  ...(readdirSync(join(root, "docs"), { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join("docs", entry)),
];
for (const documentationPath of launchDocumentationPaths) {
  requireAbsent(documentationPath, [
    /\bGOLD\b/i,
    /gold[_-]?(?:mint|clob|perps|amm)/i,
    /\b(?:AVAX|Avalanche|BSC|Base Sepolia|EVM)\b/i,
    /\b(?:perps|amm)\b/i,
  ]);
}

const expectedPrograms = new Set(["fight_oracle", "duel_market"]);
const requiredNeutralMarketPaths = [
  "packages/hyperbet-solana/anchor/programs/duel_market/src/lib.rs",
  "packages/hyperbet-solana/anchor/target/idl/duel_market.json",
  "packages/hyperbet-solana/anchor/target/types/duel_market.ts",
  "packages/hyperbet-solana/app/src/generated/duel-market/programs/duelMarket.ts",
  "packages/hyperbet-solana/app/src/idl/duel_market.json",
  "packages/hyperbet-solana/keeper/src/idl/duel_market.json",
  "packages/hyperbet-ui/src/idl/duel_market.json",
  "packages/hyperbet-sdk/src/solana/idl/duel_market.json",
  "packages/hyperbet-sdk-py/hyperbet_sdk/solana/idl/duel_market.json",
] as const;
for (const relativePath of requiredNeutralMarketPaths) {
  if (!existsSync(join(root, relativePath))) {
    fail(`missing neutral duel-market artifact ${relativePath}`);
  }
}

for (const retiredPath of [
  "packages/hyperbet-solana/anchor/programs/gold_clob_market",
  "packages/hyperbet-solana/anchor/programs/gold_perps_market",
  "packages/hyperbet-solana/anchor/programs/lvr_amm",
  "packages/hyperbet-solana/anchor/target/idl/gold_clob_market.json",
  "packages/hyperbet-solana/anchor/target/idl/gold_perps_market.json",
  "packages/hyperbet-solana/anchor/target/idl/lvr_amm.json",
  "packages/hyperbet-solana/anchor/target/types/gold_clob_market.ts",
  "packages/hyperbet-solana/anchor/target/types/gold_perps_market.ts",
  "packages/hyperbet-solana/anchor/target/types/lvr_amm.ts",
  "packages/hyperbet-solana/app/src/generated/gold-clob-market",
  "packages/hyperbet-solana/app/src/generated/gold-perps-market",
  "packages/hyperbet-solana/generated/ts",
  "packages/hyperbet-solana/anchor/scripts/simulate-hyperia-localnet.ts",
  "packages/hyperbet-solana/.env.example",
  "packages/hyperbet-solana/app/src/idl/gold_clob_market.json",
  "packages/hyperbet-solana/app/src/idl/gold_perps_market.json",
  "packages/hyperbet-solana/app/src/idl/lvr_amm.json",
  "packages/hyperbet-solana/keeper/src/idl/gold_clob_market.json",
  "packages/hyperbet-solana/keeper/src/idl/gold_perps_market.json",
  "packages/hyperbet-solana/keeper/src/idl/lvr_amm.json",
  "packages/hyperbet-solana/keeper/src/bot.ts",
  "packages/hyperbet-solana/keeper/src/common.ts",
  "packages/hyperbet-solana/keeper/src/staged-proof-solana.ts",
  "packages/hyperbet-solana/keeper/src/legacyAnalyticsDb.ts",
  "packages/hyperbet-solana/keeper/src/modelMarkets.ts",
  "packages/hyperbet-solana/keeper/src/perpsMath.ts",
  "packages/hyperbet-ui/src/idl/gold_clob_market.json",
  "packages/hyperbet-ui/src/idl/gold_perps_market.json",
  "packages/hyperbet-ui/src/idl/lvr_amm.json",
  "packages/hyperbet-ui/src/createAppRoot.tsx",
  "packages/hyperbet-ui/src/createEvmAppRoot.tsx",
  "packages/hyperbet-ui/src/components/EvmBettingPanel.tsx",
  "packages/hyperbet-ui/src/components/EvmModelsMarketView.tsx",
  "packages/hyperbet-ui/src/components/ModelsMarketView.tsx",
  "packages/hyperbet-ui/src/components/PointsDisplay.tsx",
  "packages/hyperbet-ui/src/components/ReferralPanel.tsx",
  "packages/hyperbet-ui/src/components/WalletLinkCard.tsx",
  "packages/hyperbet-ui/src/lib/ChainContext.tsx",
  "packages/hyperbet-ui/src/lib/chainConfig.ts",
  "packages/hyperbet-ui/src/lib/config.ts",
  "packages/hyperbet-ui/src/lib/evmClient.ts",
  "packages/hyperbet-ui/src/lib/goldClobAbi.ts",
  "packages/hyperbet-ui/src/lib/jupiter.ts",
  "packages/hyperbet-ui/src/lib/modelMarkets.ts",
  "packages/hyperbet-ui/src/lib/predictionMarkets.ts",
  "packages/hyperbet-ui/src/lib/wagmiConfig.ts",
  "packages/hyperbet-sdk/src/solana/idl/gold_clob_market.json",
  "packages/hyperbet-sdk-py/hyperbet_sdk/solana/idl/gold_clob_market.json",
  "packages/hyperbet-sdk/src/evm",
  "packages/hyperbet-sdk/tests/evm.test.ts",
  "packages/hyperbet-sdk-py/hyperbet_sdk/evm",
  "packages/hyperbet-sdk-py/tests/test_evm.py",
]) {
  if (existsSync(join(root, retiredPath))) {
    fail(`retired Solana market path still exists: ${retiredPath}`);
  }
}

const retiredSolanaMarketNamePatterns = [
  /gold_clob/i,
  /gold-clob/i,
  /GOLD_CLOB/,
  /GoldClob|goldClob/,
] as const;
for (const relativePath of [
  "packages/hyperbet-solana/README.md",
  "packages/hyperbet-solana/package.json",
  "packages/hyperbet-solana/anchor/Cargo.toml",
  "packages/hyperbet-solana/anchor/Anchor.toml",
  "packages/hyperbet-solana/anchor/package.json",
  "packages/hyperbet-solana/anchor/programs/duel_market/src/lib.rs",
  "packages/hyperbet-solana/anchor/scripts/build-workspace.sh",
  "packages/hyperbet-solana/anchor/scripts/deploy-programs.sh",
  "packages/hyperbet-solana/anchor/scripts/run-localnet-tests.sh",
  "packages/hyperbet-solana/anchor/scripts/run-hyperia-simulation.mjs",
  "packages/hyperbet-solana/scripts/preflight-contract-deploy.ts",
  "packages/hyperbet-solana/scripts/init-pm-config.ts",
  "packages/hyperbet-solana/scripts/verify-deployment.ts",
  "packages/hyperbet-solana/scripts/stage-a-identity.ts",
  "packages/hyperbet-solana/scripts/sync-anchor-artifacts.mjs",
  "packages/hyperbet-solana/keeper/src/launchCommon.ts",
  "packages/hyperbet-ui/src/lib/programs.ts",
  "packages/hyperbet-ui/src/components/SolanaClobPanel.tsx",
  ".github/workflows/deploy-testnet-v3.yml",
  "scripts/ci-gate-solana-build.ts",
]) {
  requireAbsent(relativePath, retiredSolanaMarketNamePatterns);
}

const duelMarketIdl = JSON.parse(
  read("packages/hyperbet-solana/anchor/target/idl/duel_market.json"),
) as { metadata?: { name?: unknown } };
if (duelMarketIdl.metadata?.name !== "duel_market") {
  fail("duel_market IDL does not expose the neutral program name");
}
const cargoWorkspace = read("packages/hyperbet-solana/anchor/Cargo.toml");
const cargoMembers = Array.from(
  cargoWorkspace.matchAll(/"programs\/([a-z0-9_]+)"/g),
  (match) => match[1],
);
if (
  cargoMembers.length !== expectedPrograms.size ||
  cargoMembers.some((program) => !expectedPrograms.has(program))
) {
  fail(`Anchor Cargo workspace is not duel-only: ${cargoMembers.join(", ")}`);
}

const anchorConfig = read("packages/hyperbet-solana/anchor/Anchor.toml");
const workspaceLine =
  anchorConfig.match(/members\s*=\s*\[([^\]]+)\]/)?.[1] ?? "";
const anchorMembers = Array.from(
  workspaceLine.matchAll(/"programs\/([a-z0-9_]+)"/g),
  (match) => match[1],
);
if (
  anchorMembers.length !== expectedPrograms.size ||
  anchorMembers.some((program) => !expectedPrograms.has(program))
) {
  fail(`Anchor.toml workspace is not duel-only: ${anchorMembers.join(", ")}`);
}
requireAbsent("packages/hyperbet-solana/anchor/Anchor.toml", [
  /gold[_-]?(?:clob|perps|amm)/i,
  /lvr_amm/i,
]);

const excludedProgramPatterns = [
  /gold_perps_market/i,
  /lvr_amm/i,
  /PROGRAM_PERPS/,
  /PROGRAM_LVR/,
  /tests\/gold_perps/i,
] as const;

for (const relativePath of [
  "packages/hyperbet-solana/package.json",
  "packages/hyperbet-solana/anchor/package.json",
  "packages/hyperbet-solana/anchor/scripts/build-workspace.sh",
  "packages/hyperbet-solana/anchor/scripts/deploy-programs.sh",
  "packages/hyperbet-solana/anchor/scripts/run-localnet-tests.sh",
  "packages/hyperbet-solana/scripts/preflight-contract-deploy.ts",
  "packages/hyperbet-solana/scripts/init-pm-config.ts",
  "packages/hyperbet-solana/scripts/verify-deployment.ts",
  "packages/hyperbet-solana/scripts/solana-deployment-identity.ts",
  "packages/hyperbet-solana/scripts/stage-a-identity.ts",
  "packages/hyperbet-solana/scripts/sync-anchor-artifacts.mjs",
  "scripts/ci-gate-solana-build.ts",
]) {
  requireAbsent(relativePath, excludedProgramPatterns);
}
requireAbsent(
  "packages/hyperbet-solana/anchor/scripts/run-hyperia-simulation.mjs",
  [
    /BETTING_SOLANA_SIM_MODE/,
    /simulate-hyperia-localnet/,
    /(?:^|\W)spl(?:\W|$)/i,
  ],
);

const deployScriptPath =
  "packages/hyperbet-solana/anchor/scripts/deploy-programs.sh";
const deployScript = read(deployScriptPath);
for (const requiredDeploymentGate of [
  "preflight-contract-deploy.ts",
  "--require-deployed",
  "running read-only program identity preflight",
  "mandatory post-deploy program identity verification",
]) {
  if (!deployScript.includes(requiredDeploymentGate)) {
    fail(
      `${deployScriptPath} is missing deployment identity gate ${requiredDeploymentGate}`,
    );
  }
}

const deploymentPreflightPath =
  "packages/hyperbet-solana/scripts/preflight-contract-deploy.ts";
const deploymentPreflight = read(deploymentPreflightPath);
for (const requiredIdentityControl of [
  "resolveSolanaV1Deployment",
  "fetchSolanaProgramDeploymentIdentity",
  "SOLANA_EXPECTED_UPGRADE_AUTHORITY",
  'required: cluster === "mainnet-beta"',
]) {
  if (!deploymentPreflight.includes(requiredIdentityControl)) {
    fail(
      `${deploymentPreflightPath} is missing identity control ${requiredIdentityControl}`,
    );
  }
}

for (const [configurationPath, requiredConfigurationControls] of [
  [
    "packages/hyperbet-solana/scripts/init-pm-config.ts",
    [
      "resolveSolanaV1Deployment",
      "resolveSolanaDuelLaunchConfig",
      "SOLANA_LAUNCH_CONFIG_FREEZE_APPROVED",
      "fetchSolanaProgramDeploymentIdentity",
    ],
  ],
  [
    "packages/hyperbet-solana/scripts/verify-deployment.ts",
    [
      "resolveSolanaV1Deployment",
      "resolveSolanaDuelLaunchConfig",
      "fetchSolanaProgramDeploymentIdentity",
      "configFrozen === true",
    ],
  ],
  [
    "packages/hyperbet-solana/keeper/src/duelBot.ts",
    ["resolveClusterLaunchFeePolicy", "SOLANA_LAUNCH_FEE_POLICY_APPROVED"],
  ],
] as const) {
  const configurationSource = read(configurationPath);
  for (const requiredControl of requiredConfigurationControls) {
    if (!configurationSource.includes(requiredControl)) {
      fail(
        `${configurationPath} is missing launch configuration control ${requiredControl}`,
      );
    }
  }
}

const deploymentWorkflowPath = ".github/workflows/deploy-testnet-v3.yml";
requireAbsent(deploymentWorkflowPath, [
  /packages\/(?:evm-contracts|hyperbet-(?:evm|bsc|avax))/i,
  /\b(?:AVAX|Avalanche|BSC|Base Sepolia)\b/i,
  /\b(?:perps|amm)\b/i,
  /(?:GOLD_TOKEN|MUSD_TOKEN|MARGIN_TOKEN)/i,
]);
const deploymentWorkflow = read(deploymentWorkflowPath);
for (const requiredWorkflowControl of [
  "DEPLOY_SOLANA_DUEL_V1_DEVNET",
  "environment: solana-devnet",
  "ci:gate:registry:launch",
  "ci:scope:solana",
  "--require-deployed",
  "Prove SOL-only launch closure before exposing authorities",
  "umask 077",
  "mktemp -d",
  "Cleanup Solana deployment identities",
  "if: always()",
  'find "${identity_parent}" -depth -mindepth 1 -delete',
]) {
  if (!deploymentWorkflow.includes(requiredWorkflowControl)) {
    fail(
      `${deploymentWorkflowPath} is missing SOL-only workflow control ${requiredWorkflowControl}`,
    );
  }
}
const deploymentClosureIndex = deploymentWorkflow.indexOf(
  "Prove SOL-only launch closure before exposing authorities",
);
const deploymentAuthorityIndex = deploymentWorkflow.indexOf(
  "secrets.TESTNET_SOLANA_DEPLOYER_KEYPAIR",
);
const deploymentMutationIndex = deploymentWorkflow.indexOf(
  "Deploy the two Solana duel programs to devnet",
);
const deploymentCleanupIndex = deploymentWorkflow.indexOf(
  "Cleanup Solana deployment identities",
);
const deploymentUploadIndex = deploymentWorkflow.indexOf(
  "Upload Solana deployment evidence",
);
if (
  deploymentClosureIndex < 0 ||
  deploymentClosureIndex > deploymentAuthorityIndex ||
  deploymentAuthorityIndex > deploymentMutationIndex ||
  deploymentMutationIndex > deploymentCleanupIndex ||
  deploymentCleanupIndex > deploymentUploadIndex
) {
  fail(
    `${deploymentWorkflowPath} must validate before authority exposure, mutate only afterward, and clean identities before evidence upload`,
  );
}
for (const keypairSecretName of [
  "TESTNET_SOLANA_DEPLOYER_KEYPAIR",
  "TESTNET_SOLANA_FIGHT_ORACLE_PROGRAM_KEYPAIR",
  "TESTNET_SOLANA_DUEL_MARKET_PROGRAM_KEYPAIR",
] as const) {
  const secretReferenceCount = Array.from(
    deploymentWorkflow.matchAll(
      new RegExp(
        String.raw`\$\{\{\s*secrets\.${keypairSecretName}\s*\}\}`,
        "g",
      ),
    ),
  ).length;
  if (secretReferenceCount !== 1) {
    fail(
      `${deploymentWorkflowPath} must expose ${keypairSecretName} only to the identity-preparation step`,
    );
  }
}

const workflowDirectory = join(root, ".github/workflows");
const expectedLaunchWorkflows = new Set([
  "ci.yml",
  "deploy-solana-keeper.yml",
  "deploy-solana-pages.yml",
  "deploy-testnet-v3.yml",
  "fund-stage-a-wallets.yml",
]);
const actualLaunchWorkflows = readdirSync(workflowDirectory).filter(
  (entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"),
);
for (const workflowName of actualLaunchWorkflows) {
  if (!expectedLaunchWorkflows.has(workflowName)) {
    fail(
      `unexpected workflow remains callable in SOL-only v1: ${workflowName}`,
    );
  }
}
for (const workflowName of expectedLaunchWorkflows) {
  if (!actualLaunchWorkflows.includes(workflowName)) {
    fail(`missing required SOL-only workflow: ${workflowName}`);
  }
}

const reviewedRunnerLine = "    runs-on: ubuntu-24.04";
let reviewedRunnerSelections = 0;
for (const workflowName of expectedLaunchWorkflows) {
  const workflowPath = `.github/workflows/${workflowName}`;
  const runnerLines = read(workflowPath)
    .split(/\r?\n/u)
    .filter((line) => /^\s*(?:runs-on|"runs-on"|'runs-on')\s*:/u.test(line));
  for (const runnerLine of runnerLines) {
    if (runnerLine !== reviewedRunnerLine) {
      fail(
        `${workflowPath} must use only the exact reviewed GitHub-hosted runner ubuntu-24.04`,
      );
    }
  }
  reviewedRunnerSelections += runnerLines.length;
}
if (reviewedRunnerSelections !== 9) {
  fail(
    `expected exactly 9 reviewed ubuntu-24.04 workflow jobs, received ${reviewedRunnerSelections}`,
  );
}

const approvedLocalTypeScriptCommand =
  "./node_modules/.bin/tsc --noEmit --project packages/hyperbet-solana/keeper/tsconfig.launch.json";
let localTypeScriptSelections = 0;
for (const workflowName of expectedLaunchWorkflows) {
  const workflowPath = `.github/workflows/${workflowName}`;
  const workflowSource = read(workflowPath);
  if (
    /(?:^|\s)(?:bunx|npx|pnpm\s+dlx|yarn\s+dlx)(?:\s|$)/u.test(workflowSource)
  ) {
    fail(`${workflowPath} must not invoke a package auto-resolver`);
  }
  localTypeScriptSelections += workflowSource
    .split(/\r?\n/u)
    .filter((line) => line.trim() === approvedLocalTypeScriptCommand).length;
}
if (localTypeScriptSelections !== 1) {
  fail(
    `expected one exact lockfile-installed TypeScript invocation, received ${localTypeScriptSelections}`,
  );
}
if (rootPackage.devDependencies?.typescript !== "5.9.3") {
  fail("root TypeScript must remain pinned to exact version 5.9.3");
}

const pythonCiWorkflowPath = ".github/workflows/ci.yml";
const pythonCiWorkflowSource = read(pythonCiWorkflowPath);
for (const requiredPythonSdkControl of [
  'python-version: "3.12.14"',
  "architecture: x64",
  "check-latest: false",
  "token: ${{ github.token }}",
  'EXPECTED_PYTHON_VERSION: "3.12.14"',
  "steps.setup-python-sdk.outputs.python-version",
  "steps.setup-python-sdk.outputs.python-path",
  "platform.python_implementation()",
  'struct.calcsize("P") * 8',
  'EXPECTED_POETRY_VERSION: "1.8.5"',
  "--disable-pip-version-check",
  "--no-cache-dir",
  '"poetry==${EXPECTED_POETRY_VERSION}"',
  "python -m pip check",
  "python -m pip freeze --all | LC_ALL=C sort",
  "poetry install --no-interaction --sync",
] as const) {
  if (!pythonCiWorkflowSource.includes(requiredPythonSdkControl)) {
    fail(`${pythonCiWorkflowPath} is missing ${requiredPythonSdkControl}`);
  }
}
for (const forbiddenPythonSdkControl of [
  'python-version: "3.12"',
  "cache: pip",
  "cache-dependency-path:",
  "python -m pip install poetry==",
] as const) {
  if (pythonCiWorkflowSource.includes(forbiddenPythonSdkControl)) {
    fail(
      `${pythonCiWorkflowPath} must not contain ${forbiddenPythonSdkControl}`,
    );
  }
}

const githubActionsPolicyPath = "scripts/ci-github-actions-policy.mjs";
const githubActionsPolicy = read(githubActionsPolicyPath);
for (const requiredActionPolicyControl of [
  "EXPECTED_WORKFLOW_FILES",
  "EXPECTED_COMPOSITE_ACTION_FILES",
  "EXPECTED_ACTION_SOURCE_FILES",
  "APPROVED_EXTERNAL_ACTIONS",
  "APPROVED_LOCAL_ACTIONS",
  "APPROVED_GITHUB_HOSTED_RUNNER",
  "EXPECTED_GITHUB_HOSTED_RUNNER_SELECTIONS",
  "APPROVED_LOCAL_TYPESCRIPT_COMMAND",
  "PACKAGE_AUTO_EXECUTOR_PATTERN",
  "ubuntu-24.04",
  "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "ece7cb06caefa5fff74198d8649806c4678c61a1",
  "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "0c5077e51419868618aeaa5fe8019c62421857d6",
  "668228422ae6a00e4ad889ee87cd7109ec5666a7",
  "6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772",
  "FULL_LOWERCASE_SHA_PATTERN",
  "persist-credentials: false",
  "checkoutCredentialPersistenceDisabled",
  "setupBunCredentialIsolation",
  "setupPythonToolchainSelections",
  "exactRustToolchainSelections",
  "executableCachesDisabled",
  "setupHyperbetInputContracts",
  "fixedLinuxRunnerSelections",
  "localTypeScriptSelections",
  "pythonSdkRuntimeChecks",
  "a2e21dda295b18dd09ac06542834c5e9b1b2dc84",
  "1ebbe58158d089a2a40b5e35ebead5a10db9090d",
  "auditGitHubActionWorkflows",
] as const) {
  if (!githubActionsPolicy.includes(requiredActionPolicyControl)) {
    fail(
      `${githubActionsPolicyPath} is missing ${requiredActionPolicyControl}`,
    );
  }
}

for (const workflowPath of [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-solana-pages.yml",
  ".github/workflows/fund-stage-a-wallets.yml",
]) {
  requireAbsent(workflowPath, [
    /packages\/(?:evm-contracts|hyperbet-(?:evm|bsc|avax))/i,
    /(?:^|[_:/-])(?:AVAX|Avalanche|BSC|Base Sepolia|EVM)(?:[_:/-]|$)/im,
    /(?:GOLD_TOKEN|GOLD_CLOB|GOLD_AMM|GOLD_PERPS|MUSD_TOKEN|PERPS_MARGIN)/i,
    /(?:ci:gate|deploy|keeper|pages):(?:amm|perps|evm|bsc|avax)/i,
  ]);
}

const fundingWorkflowPath = ".github/workflows/fund-stage-a-wallets.yml";
const fundingWorkflow = read(fundingWorkflowPath);
for (const requiredFundingControl of [
  "Validate every recipient before exposing the funding signer",
  "scripts/ci-solana-devnet-funding-policy.mjs",
  "Fund the prevalidated recipient plan",
  "SOLANA_DEVNET_FUNDING_PLAN",
  "umask 077",
  'mktemp "${RUNNER_TEMP}/hyperbet-devnet-funding-plan.XXXXXX"',
  'mktemp -d "${RUNNER_TEMP}/hyperbet-devnet-funder.XXXXXX"',
  "cleanup_funding_material",
  "trap cleanup_funding_material EXIT",
  'find "${wallet_root}" -depth -mindepth 1 -delete',
  "jq -r '.recipients[] | [.address, .amountSol] | @tsv'",
  'solana balance "${address}" --url devnet >/dev/null',
] as const) {
  if (!fundingWorkflow.includes(requiredFundingControl)) {
    fail(`${fundingWorkflowPath} is missing ${requiredFundingControl}`);
  }
}
const fundingValidationIndex = fundingWorkflow.indexOf(
  "Validate every recipient before exposing the funding signer",
);
const fundingSignerIndex = fundingWorkflow.indexOf(
  "secrets.TESTNET_SOLANA_DEPLOYER_KEYPAIR",
);
const fundingMutationIndex = fundingWorkflow.indexOf("solana transfer");
if (
  fundingValidationIndex < 0 ||
  fundingValidationIndex > fundingSignerIndex ||
  fundingSignerIndex > fundingMutationIndex
) {
  fail(
    `${fundingWorkflowPath} must validate every recipient before signer exposure or transfer`,
  );
}
const fundingSignerReferenceCount = Array.from(
  fundingWorkflow.matchAll(
    /\$\{\{\s*secrets\.TESTNET_SOLANA_DEPLOYER_KEYPAIR\s*\}\}/g,
  ),
).length;
if (fundingSignerReferenceCount !== 1) {
  fail(
    `${fundingWorkflowPath} must expose the funding signer to exactly one step`,
  );
}
for (const forbiddenFundingControl of [
  'rm -f "$wallet_file"',
  "IFS=',' read -r -a targets <<<\"$RECIPIENTS\"",
] as const) {
  if (fundingWorkflow.includes(forbiddenFundingControl)) {
    fail(`${fundingWorkflowPath} retains ${forbiddenFundingControl}`);
  }
}
const fundingPolicyPath = "scripts/ci-solana-devnet-funding-policy.mjs";
const fundingPolicy = read(fundingPolicyPath);
for (const requiredFundingPolicyControl of [
  "const MAX_RECIPIENTS = 12",
  "10n * LAMPORTS_PER_SOL",
  "decodedBase58Length(address) !== 32",
  "seenAddresses.has(address)",
  'cluster: "devnet"',
  'asset: "SOL"',
  'atomicUnit: "lamports"',
] as const) {
  if (!fundingPolicy.includes(requiredFundingPolicyControl)) {
    fail(
      `${fundingPolicyPath} is missing exact funding control ${requiredFundingPolicyControl}`,
    );
  }
}

const ciWorkflowPath = ".github/workflows/ci.yml";
const ciWorkflow = read(ciWorkflowPath);
for (const requiredCiControl of [
  "browser-keeper-e2e:",
  "ci:gate:e2e:solana",
  'install-cargo-audit: "true"',
  "audit:strict",
  "playwright install --with-deps chromium",
  "sudo apt-get install -y ffmpeg",
  "include-hidden-files: true",
  "retention-days: 30",
]) {
  if (!ciWorkflow.includes(requiredCiControl)) {
    fail(`${ciWorkflowPath} is missing ${requiredCiControl}`);
  }
}

const e2eGatePath = "scripts/ci-gate-e2e.ts";
const e2eGate = read(e2eGatePath);
for (const requiredE2eControl of [
  'E2E_PLAYWRIGHT_RETRIES: "0"',
  "E2E_CONTROL_ARTIFACT_PATH",
  "collectHarnessArtifacts",
]) {
  if (!e2eGate.includes(requiredE2eControl)) {
    fail(`${e2eGatePath} is missing ${requiredE2eControl}`);
  }
}

const pagesWorkflowPath = ".github/workflows/deploy-solana-pages.yml";
const pagesWorkflow = read(pagesWorkflowPath);
for (const requiredPagesControl of [
  "ci-env-audit-solana-v1.ts --target=pages:solana",
  "VITE_USE_GAME_RPC_PROXY",
  "VITE_STREAM_SOURCES",
  "VITE_TRANSACTIONS_ENABLED",
  "scripts/ci-solana-pages-deploy-target.mjs",
  'node scripts/ci-solana-pages-deploy-target.mjs >> "$GITHUB_ENV"',
  "scripts/resolve-pages-deployment-url-with-scoped-auth.sh",
  "scripts/verify-solana-pages-deployment.mjs",
  "node scripts/verify-solana-pages-deployment.mjs --local-only",
  "DEPLOYED_URL: ${{ steps.deployment_url.outputs.deployed_url }}",
  "HYPERBET_SOLANA_STAGING_STREAM_SOURCES",
  "bun run ci:scope:solana",
  "Verify production promotion request",
  "production_confirmation",
  "production_commit_sha",
  "DEPLOY_SOL_PRODUCTION",
  'WRANGLER_CLI_VERSION: "4.72.0"',
  "Install pinned Wrangler CLI before exposing credentials",
  'npm install --global "wrangler@${WRANGLER_CLI_VERSION}"',
  'test "${installed_wrangler_version}" = "${WRANGLER_CLI_VERSION}"',
  "scripts/run-wrangler-with-scoped-auth.sh",
  "cancel-in-progress: false",
  '--output="${RUNNER_TEMP}/hyperbet-solana-pages-deployment-evidence.json"',
  "Upload Pages deployment evidence",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "hyperbet-solana-pages-deployment-evidence.json",
  "retention-days: 30",
  "compression-level: 0",
]) {
  if (!pagesWorkflow.includes(requiredPagesControl)) {
    fail(`${pagesWorkflowPath} is missing ${requiredPagesControl}`);
  }
}
if (pagesWorkflow.includes("cancel-in-progress: true")) {
  fail(`${pagesWorkflowPath} permits cancellation during a Pages release`);
}
const pagesVerifyIndex = pagesWorkflow.indexOf(
  "- name: Verify production build metadata",
);
const pagesEvidenceUploadIndex = pagesWorkflow.indexOf(
  "- name: Upload Pages deployment evidence",
);
if (
  pagesVerifyIndex < 0 ||
  pagesVerifyIndex > pagesEvidenceUploadIndex ||
  !pagesWorkflow.includes("steps.verify_deployment.outcome == 'success'") ||
  Array.from(
    pagesWorkflow.matchAll(
      /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g,
    ),
  ).length !== 1
) {
  fail(
    `${pagesWorkflowPath} must upload exactly one successful post-verification certificate`,
  );
}
for (const forbiddenPagesTargetInterpolation of [
  'pages_project_name="${{',
  'pages_expected_url="${{',
  'api_url="${{',
  'ws_url="${{',
  'deployed_url="${{ steps.deployment_url.outputs.deployed_url }}"',
  'echo "deployed_url=${deployed_url}" >> "${GITHUB_OUTPUT}"',
  'curl -fsSL "${DEPLOYED_URL}/build-info.json"',
  "custom domain build-info.json",
] as const) {
  if (pagesWorkflow.includes(forbiddenPagesTargetInterpolation)) {
    fail(
      `${pagesWorkflowPath} interpolates an unvalidated deployment target into shell`,
    );
  }
}
const pagesDeploymentTargetResolverPath =
  "scripts/ci-solana-pages-deploy-target.mjs";
const pagesDeploymentTargetResolver = read(pagesDeploymentTargetResolverPath);
for (const requiredPagesTargetControl of [
  "CONTROL_CHARACTER",
  "validateAccountId",
  "validateProjectName",
  "validateRootHttpsUrl",
  "validateWebSocketUrl",
  "validateStreamSources",
  "resolveSolanaPagesBuildIdentity",
  "PAGES_BUILD_IDENTITY_SHA256",
  "Pages deployment target output has unexpected keys",
] as const) {
  if (!pagesDeploymentTargetResolver.includes(requiredPagesTargetControl)) {
    fail(
      `${pagesDeploymentTargetResolverPath} is missing ${requiredPagesTargetControl}`,
    );
  }
}
const pagesBuildIdentityPath = "scripts/solana-pages-build-identity.mjs";
const pagesBuildIdentity = read(pagesBuildIdentityPath);
for (const requiredPagesBuildIdentityControl of [
  "SOLANA_PAGES_BUILD_IDENTITY_SCHEMA_VERSION",
  "canonicalConfiguration",
  "configSha256: sha256(JSON.stringify(canonicalConfiguration))",
  "Pages target authority is inconsistent",
  "VITE_USE_GAME_RPC_PROXY must be true",
] as const) {
  if (!pagesBuildIdentity.includes(requiredPagesBuildIdentityControl)) {
    fail(
      `${pagesBuildIdentityPath} is missing ${requiredPagesBuildIdentityControl}`,
    );
  }
}
const pagesBuildConfigPath = "packages/hyperbet-solana/app/vite.config.ts";
const pagesBuildConfig = read(pagesBuildConfigPath);
for (const requiredPagesBuildControl of [
  "resolveSolanaPagesBuildIdentity",
  "PAGES_BUILD_IDENTITY_SHA256",
  "Pages deployment identity does not match inputs",
  "Vite mode does not match Pages deployment rail",
  "resolveSolanaPagesBundleManifest",
  'flag: "wx"',
  "fs.renameSync(temporaryPath, buildInfoPath)",
  "schemaVersion: 2",
] as const) {
  if (!pagesBuildConfig.includes(requiredPagesBuildControl)) {
    fail(`${pagesBuildConfigPath} is missing ${requiredPagesBuildControl}`);
  }
}
const pagesBundleManifestPath = "scripts/solana-pages-bundle-manifest.mjs";
const pagesBundleManifest = read(pagesBundleManifestPath);
for (const requiredPagesManifestControl of [
  "MAX_ARTIFACTS",
  "MAX_ARTIFACT_BYTES",
  "MAX_BUNDLE_BYTES",
  "must not contain a symbolic link",
  'if (fileName === "build-info.json") continue',
  "artifact changed during inspection",
  "manifestSha256: sha256(JSON.stringify(artifacts))",
] as const) {
  if (!pagesBundleManifest.includes(requiredPagesManifestControl)) {
    fail(
      `${pagesBundleManifestPath} is missing ${requiredPagesManifestControl}`,
    );
  }
}
const pagesDeploymentVerifierPath =
  "scripts/verify-solana-pages-deployment.mjs";
const pagesDeploymentVerifier = read(pagesDeploymentVerifierPath);
for (const requiredPagesVerifierControl of [
  "MAX_BUILD_INFO_BYTES",
  "parseSolanaPagesBuildInfo",
  "verifyLocalSolanaPagesBuild",
  "hasExactKeys",
  'redirect: "error"',
  'cache: "no-store"',
  "AbortSignal.timeout(10_000)",
  "Pages build-info does not match the built artifact",
  "bytes.byteLength !== declaredBytes",
  "expectedOrigin === deploymentOrigin",
  "bundleManifestSha256",
  "buildSolanaDeploymentEvidence",
  "writeSolanaDeploymentEvidence",
] as const) {
  if (!pagesDeploymentVerifier.includes(requiredPagesVerifierControl)) {
    fail(
      `${pagesDeploymentVerifierPath} is missing ${requiredPagesVerifierControl}`,
    );
  }
}
const pagesDeploymentOutputResolverPath =
  "scripts/ci-solana-pages-deployment-output.mjs";
const pagesDeploymentOutputResolver = read(pagesDeploymentOutputResolverPath);
for (const requiredPagesOutputControl of [
  "MAX_PROVIDER_OUTPUT_BYTES",
  "MAX_DEPLOYMENT_ROWS",
  "validateExpectedIdentity",
  "validateDeploymentUrl",
  "hostname.endsWith(`.${projectHostname}`)",
  "matchingRows.map",
  "Pages deployment output has unexpected keys or values",
] as const) {
  if (!pagesDeploymentOutputResolver.includes(requiredPagesOutputControl)) {
    fail(
      `${pagesDeploymentOutputResolverPath} is missing ${requiredPagesOutputControl}`,
    );
  }
}
const pagesDeploymentOutputRunnerPath =
  "scripts/resolve-pages-deployment-url-with-scoped-auth.sh";
const pagesDeploymentOutputRunner = read(pagesDeploymentOutputRunnerPath);
for (const requiredPagesOutputRunnerControl of [
  "GITHUB_OUTPUT must name an existing regular non-symlink file",
  "unset GITHUB_OUTPUT",
  'mktemp "${runner_temp%/}/hyperbet-pages-deployments.XXXXXX.json"',
  'mktemp "${runner_temp%/}/hyperbet-pages-deployment-output.XXXXXX"',
  "trap cleanup_pages_deployment_output EXIT",
  "unset CLOUDFLARE_API_TOKEN CLOUDFLARE_WRANGLER_CONFIG_B64",
  'EXPECTED_COMMIT_SHA="${commit_sha}"',
  'EXPECTED_PAGES_ENVIRONMENT="${pages_environment}"',
  'EXPECTED_PAGES_BRANCH="${pages_branch}"',
  'EXPECTED_PAGES_PROJECT_NAME="${pages_project_name}"',
  'node "${script_dir}/ci-solana-pages-deployment-output.mjs"',
  'cat "${deployment_output}" >>"${github_output}"',
] as const) {
  if (!pagesDeploymentOutputRunner.includes(requiredPagesOutputRunnerControl)) {
    fail(
      `${pagesDeploymentOutputRunnerPath} is missing ${requiredPagesOutputRunnerControl}`,
    );
  }
}
if (/^\s*push:/mu.test(pagesWorkflow)) {
  fail(`${pagesWorkflowPath} must not automatically promote production`);
}
for (const forbiddenCloudflareCredentialPersistence of [
  'echo "CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}" >> "${GITHUB_ENV}"',
  'mkdir -p "${HOME}/.wrangler/config"',
  "npx wrangler@",
] as const) {
  if (pagesWorkflow.includes(forbiddenCloudflareCredentialPersistence)) {
    fail(
      `${pagesWorkflowPath} exposes or installs Cloudflare credentials through ${forbiddenCloudflareCredentialPersistence}`,
    );
  }
}
const wranglerInstallIndex = pagesWorkflow.indexOf(
  "Install pinned Wrangler CLI before exposing credentials",
);
const firstCloudflareCredentialIndex = pagesWorkflow.indexOf(
  "secrets.CLOUDFLARE_API_TOKEN",
);
if (
  wranglerInstallIndex < 0 ||
  firstCloudflareCredentialIndex < wranglerInstallIndex
) {
  fail(
    `${pagesWorkflowPath} exposes Cloudflare credentials before the pinned CLI is installed`,
  );
}
for (const [credentialName, expectedReferences] of [
  ["CLOUDFLARE_API_TOKEN", 2],
  ["CLOUDFLARE_WRANGLER_CONFIG_B64", 2],
] as const) {
  const credentialReferences = Array.from(
    pagesWorkflow.matchAll(
      new RegExp(String.raw`\$\{\{\s*secrets\.${credentialName}\s*\}\}`, "g"),
    ),
  ).length;
  if (credentialReferences !== expectedReferences) {
    fail(
      `${pagesWorkflowPath} must scope ${credentialName} to exactly the deploy and deployment-list steps`,
    );
  }
  if (
    pagesWorkflow
      .split("\n")
      .some(
        (line) => line.includes(credentialName) && line.includes("GITHUB_ENV"),
      )
  ) {
    fail(
      `${pagesWorkflowPath} must not persist ${credentialName} in GITHUB_ENV`,
    );
  }
}
const scopedWranglerInvocationCount = Array.from(
  `${pagesWorkflow}\n${pagesDeploymentOutputRunner}`.matchAll(
    /\/run-wrangler-with-scoped-auth\.sh/g,
  ),
).length;
if (scopedWranglerInvocationCount !== 2) {
  fail(
    `${pagesWorkflowPath} must run exactly the deploy and deployment-list commands through scoped Wrangler auth`,
  );
}
const wranglerAuthRunnerPath = "scripts/run-wrangler-with-scoped-auth.sh";
const wranglerAuthRunner = read(wranglerAuthRunnerPath);
for (const requiredWranglerAuthControl of [
  "Exactly one Cloudflare credential source must be configured",
  "umask 077",
  "mktemp -d",
  "trap cleanup_wrangler_auth EXIT",
  'export HOME="${auth_home}"',
  'export XDG_CONFIG_HOME="${auth_home}/.config"',
  "chmod 600",
  "unset CLOUDFLARE_WRANGLER_CONFIG_B64",
  'grep -R -F -q -- "${cloudflare_api_token}"',
  'find "${auth_home}" -depth -mindepth 1 -delete',
] as const) {
  if (!wranglerAuthRunner.includes(requiredWranglerAuthControl)) {
    fail(
      `${wranglerAuthRunnerPath} is missing scoped credential control ${requiredWranglerAuthControl}`,
    );
  }
}

const keeperWorkflowPath = ".github/workflows/deploy-solana-keeper.yml";
requireAbsent(keeperWorkflowPath, [
  /packages\/(?:market-maker-bot|hyperbet-mm-core|hyperbet-chain-registry)/i,
  /(?:ENABLE_MARKET_MAKER|ENABLE_KEEPER_BOT)/i,
  /(?:GOLD_TOKEN|GOLD_CLOB|GOLD_AMM|GOLD_PERPS|MUSD_TOKEN|PERPS_MARGIN)/i,
]);
const keeperWorkflow = read(keeperWorkflowPath);
for (const requiredKeeperControl of [
  "ci-env-audit-solana-v1.ts --target=keeper:solana",
  "test:launch",
  "node scripts/ci-solana-railway-config.mjs",
  "bun run ci:scope:solana",
  "node scripts/verify-solana-keeper-deployment.mjs",
  "Verify production promotion request",
  "production_confirmation",
  "production_commit_sha",
  "DEPLOY_SOL_PRODUCTION",
  "RAILWAY_DUEL_BOT_SERVICE_ID",
  "Deploy dedicated duel bot",
  "scripts/ci-solana-keeper-deploy-target.mjs",
  'node scripts/ci-solana-keeper-deploy-target.mjs >> "$GITHUB_ENV"',
  "REQUESTED_ENVIRONMENT: ${{ inputs.environment }}",
  "Link and audit protected Railway service environments",
  "railway link",
  '--project "${RAILWAY_PROJECT_ID}"',
  "../../../scripts/run-railway-with-scoped-auth.sh",
  'RAILWAY_CLI_VERSION: "5.45.0"',
  'bun add -g "@railway/cli@${RAILWAY_CLI_VERSION}"',
  'test "$(railway --version)" = "railway ${RAILWAY_CLI_VERSION}"',
  "railway variable list",
  "../../../scripts/ci-keeper-runtime-env-solana-v1.ts",
  '--service-env-file="${service_env_file}"',
  '--duel-bot-env-file="${duel_bot_env_file}"',
  "mktemp -d",
  "trap cleanup_runtime_env EXIT",
  '--release-sha="$GITHUB_SHA"',
  "DEPLOY_FIGHT_ORACLE_PROGRAM_ID",
  "DEPLOY_DUEL_MARKET_PROGRAM_ID",
  "cancel-in-progress: false",
  '--output="${RUNNER_TEMP}/hyperbet-solana-keeper-deployment-evidence.json"',
  "Upload keeper deployment evidence",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "hyperbet-solana-keeper-deployment-evidence.json",
  "retention-days: 30",
  "compression-level: 0",
]) {
  if (!keeperWorkflow.includes(requiredKeeperControl)) {
    fail(`${keeperWorkflowPath} is missing ${requiredKeeperControl}`);
  }
}
if (keeperWorkflow.includes("--detach")) {
  fail(`${keeperWorkflowPath} must wait for health-gated Railway deployments`);
}
const healthGatedRailwayDeployCount = Array.from(
  keeperWorkflow.matchAll(/^\s+--ci \\$/gmu),
).length;
if (healthGatedRailwayDeployCount !== 2) {
  fail(
    `${keeperWorkflowPath} must execute exactly two health-gated Railway deploys`,
  );
}
const duelBotDeployIndex = keeperWorkflow.indexOf(
  "- name: Deploy dedicated duel bot",
);
const keeperDeployIndex = keeperWorkflow.indexOf("- name: Deploy keeper");
const keeperVerifyIndex = keeperWorkflow.indexOf(
  "- name: Verify keeper endpoints",
);
const keeperEvidenceUploadIndex = keeperWorkflow.indexOf(
  "- name: Upload keeper deployment evidence",
);
if (
  duelBotDeployIndex < 0 ||
  duelBotDeployIndex > keeperDeployIndex ||
  keeperDeployIndex > keeperVerifyIndex ||
  keeperVerifyIndex > keeperEvidenceUploadIndex ||
  !keeperWorkflow.includes("steps.verify_deployment.outcome == 'success'") ||
  Array.from(
    keeperWorkflow.matchAll(
      /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g,
    ),
  ).length !== 1
) {
  fail(
    `${keeperWorkflowPath} must deploy bot/API, verify, and upload exactly one successful certificate in order`,
  );
}
const scopedRailwayInvocationCount = Array.from(
  keeperWorkflow.matchAll(/scripts\/run-railway-with-scoped-auth\.sh/g),
).length;
if (scopedRailwayInvocationCount !== 3) {
  fail(
    `${keeperWorkflowPath} must run the protected audit and two deploy commands through scoped Railway auth`,
  );
}
const railwaySecretReferenceCount = Array.from(
  keeperWorkflow.matchAll(/\$\{\{\s*secrets\.RAILWAY_TOKEN\s*\}\}/g),
).length;
if (railwaySecretReferenceCount !== 3) {
  fail(
    `${keeperWorkflowPath} must expose RAILWAY_TOKEN only to the protected audit and two deploy steps`,
  );
}
for (const forbiddenRailwayCredentialPersistence of [
  "${HOME}/.railway/config.json",
  '"token": "${RAILWAY_TOKEN}"',
] as const) {
  if (keeperWorkflow.includes(forbiddenRailwayCredentialPersistence)) {
    fail(
      `${keeperWorkflowPath} persists Railway credentials through ${forbiddenRailwayCredentialPersistence}`,
    );
  }
}
for (const forbiddenUnvalidatedDeploymentInterpolation of [
  'keeper_url="${{',
  'railway_project_id="${{',
  'railway_environment_id="${{',
  'railway_service_id="${{',
  'railway_duel_bot_service_id="${{',
] as const) {
  if (keeperWorkflow.includes(forbiddenUnvalidatedDeploymentInterpolation)) {
    fail(
      `${keeperWorkflowPath} interpolates an unvalidated deployment target into shell`,
    );
  }
}
if (/^\s*push:/mu.test(keeperWorkflow)) {
  fail(`${keeperWorkflowPath} must not automatically promote production`);
}
const keeperDeploymentTargetResolverPath =
  "scripts/ci-solana-keeper-deploy-target.mjs";
const keeperDeploymentTargetResolver = read(keeperDeploymentTargetResolverPath);
for (const requiredTargetResolverControl of [
  "CONTROL_CHARACTER",
  "validateRailwayId",
  "validateKeeperUrl",
  "keeper and duel-bot Railway services must be distinct",
  "serializeKeeperDeploymentTarget",
  "deployment target output has unexpected keys",
  "DEPLOY_FIGHT_ORACLE_PROGRAM_ID",
  "DEPLOY_DUEL_MARKET_PROGRAM_ID",
] as const) {
  if (!keeperDeploymentTargetResolver.includes(requiredTargetResolverControl)) {
    fail(
      `${keeperDeploymentTargetResolverPath} is missing ${requiredTargetResolverControl}`,
    );
  }
}
const keeperDeploymentVerifierPath =
  "scripts/verify-solana-keeper-deployment.mjs";
const keeperDeploymentVerifier = read(keeperDeploymentVerifierPath);
for (const requiredKeeperVerifierControl of [
  'redirect: "error"',
  "AbortSignal.timeout(10_000)",
  "MAX_JSON_BYTES",
  'source !== "manifest"',
  "resolveExpectedKeeperReleaseSha",
  '"duel-bot"',
  "fightOracleProgramId",
  "duelMarketProgramId",
  "operatorReadiness.ready !== true",
  "value.parsers.solana.snapshot.fightOracleProgram",
  'value.bot.transport.source !== "remote"',
  "RETIRED_PATHS",
  "buildSolanaDeploymentEvidence",
  "writeSolanaDeploymentEvidence",
] as const) {
  if (!keeperDeploymentVerifier.includes(requiredKeeperVerifierControl)) {
    fail(
      `${keeperDeploymentVerifierPath} is missing ${requiredKeeperVerifierControl}`,
    );
  }
}
const deploymentEvidencePath = "scripts/solana-deployment-evidence.mjs";
const deploymentEvidence = read(deploymentEvidencePath);
for (const requiredDeploymentEvidenceControl of [
  "parseSolanaDeploymentEvidence",
  "resolveDeploymentEvidenceWorkflow",
  "buildSolanaDeploymentEvidence",
  "writeSolanaDeploymentEvidence",
  'classification: "deployment_endpoint_verification_only"',
  "productionActivationAuthorized: false",
  "payloadSha256",
  "constants.O_EXCL",
  "constants.O_NOFOLLOW",
  "fchmodSync(descriptor, 0o600)",
  "linkSync(temporaryPath, resolvedOutput)",
] as const) {
  if (!deploymentEvidence.includes(requiredDeploymentEvidenceControl)) {
    fail(
      `${deploymentEvidencePath} is missing ${requiredDeploymentEvidenceControl}`,
    );
  }
}
for (const [deploymentEvidenceDocument, requiredControls] of [
  [
    "docs/hyperbet-production-deploy.md",
    [
      "Deployment verification certificates",
      "productionActivationAuthorized: false",
      "GitHub artifact ID/digest",
      "30-day workflow retention is transport",
    ],
  ],
  [
    "docs/release/launch-ops-evidence-index.md",
    [
      "GitHub artifact IDs/digests",
      "bounded transport window",
      "productionActivationAuthorized: false",
    ],
  ],
  [
    "docs/release/release-memo-template.md",
    [
      "Pages deployment certificate SHA-256",
      "Keeper deployment certificate SHA-256",
      "Expiring workflow storage is not the release archive",
    ],
  ],
] as const) {
  const document = read(deploymentEvidenceDocument);
  for (const control of requiredControls) {
    if (!document.includes(control)) {
      fail(`${deploymentEvidenceDocument} is missing ${control}`);
    }
  }
}
const railwayAuthRunnerPath = "scripts/run-railway-with-scoped-auth.sh";
const railwayAuthRunner = read(railwayAuthRunnerPath);
for (const requiredRailwayAuthControl of [
  "RAILWAY_TOKEN must be configured",
  "RAILWAY_TOKEN is malformed",
  "umask 077",
  "mktemp -d",
  "Refusing pre-existing Railway context",
  'export HOME="${auth_home}"',
  'export XDG_CONFIG_HOME="${auth_home}/.config"',
  "unset RAILWAY_TOKEN",
  "grep -r -F -q",
  "Railway persisted the Railway token to disk",
  "cleanup_railway_auth",
] as const) {
  if (!railwayAuthRunner.includes(requiredRailwayAuthControl)) {
    fail(`${railwayAuthRunnerPath} is missing ${requiredRailwayAuthControl}`);
  }
}

const solanaEnvironmentAuditPath = "scripts/ci-env-audit-solana-v1.ts";
requireAbsent(solanaEnvironmentAuditPath, [
  /@hyperbet\/chain-registry/,
  /packages\/(?:evm-contracts|hyperbet-(?:evm|bsc|avax))/i,
]);
const solanaEnvironmentAudit = read(solanaEnvironmentAuditPath);
for (const requiredEnvironmentControl of [
  "unsupported SOL-only audit target",
  "FORBIDDEN_NON_SOLANA_ENV",
  "findTrackedEnvPolicyErrors",
  "VITE_USE_GAME_RPC_PROXY",
  "SOLANA_RPC_URL",
]) {
  if (!solanaEnvironmentAudit.includes(requiredEnvironmentControl)) {
    fail(
      `${solanaEnvironmentAuditPath} is missing ${requiredEnvironmentControl}`,
    );
  }
}
const solanaEnvironmentPolicyPath = "scripts/ci-env-audit-solana-v1-policy.ts";
requireAbsent(solanaEnvironmentPolicyPath, [
  /@hyperbet\/chain-registry/,
  /packages\/(?:evm-contracts|hyperbet-(?:evm|bsc|avax))/i,
]);
const solanaEnvironmentPolicy = read(solanaEnvironmentPolicyPath);
for (const requiredTrackedEnvironmentControl of [
  "TRACKED_SENSITIVE_ENV_KEYS",
  "GENERIC_SENSITIVE_ENV_KEY",
  "BET_SYNC_SOURCE_BEARER_TOKEN",
  "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL",
  "HYPERBET_OPERATOR_ALERT_BEARER_TOKEN",
  "VITE_HEADLESS_WALLET_SECRET_KEY",
  "VITE_HEADLESS_WALLETS",
  "BIRDEYE_API_KEY",
  "BOT_KEYPAIR",
  "ORACLE_AUTHORITY_KEYPAIR",
  "findTrackedEnvPolicyErrors",
] as const) {
  if (!solanaEnvironmentPolicy.includes(requiredTrackedEnvironmentControl)) {
    fail(
      `${solanaEnvironmentPolicyPath} is missing ${requiredTrackedEnvironmentControl}`,
    );
  }
}
const keeperRuntimeEnvironmentPolicyPath =
  "scripts/ci-keeper-runtime-env-solana-v1-policy.ts";
requireAbsent(keeperRuntimeEnvironmentPolicyPath, [
  /@hyperbet\/chain-registry/,
  /packages\/(?:evm-contracts|hyperbet-(?:evm|bsc|avax))/i,
]);
const keeperRuntimeEnvironmentPolicy = read(keeperRuntimeEnvironmentPolicyPath);
for (const requiredRuntimeEnvironmentControl of [
  "auditKeeperRuntimeEnvironmentPair",
  "normalizeRailwayVariablePayload",
  "COMMON_MATCHING_ENV_KEYS",
  "SIGNER_SECRET_ENV_KEYS",
  "SERVICE_ONLY_SECRET_ENV_KEYS",
  "PROHIBITED_DEPLOYED_ENV_KEYS",
  "FIGHT_ORACLE_PROGRAM_ID",
  "DUEL_MARKET_PROGRAM_ID",
  "KEEPER_BOT_HEALTH_BEARER_TOKEN",
  "BET_SYNC_SOURCE_BEARER_TOKEN",
  "SOLANA_LIFECYCLE_INDEX_START_SLOT",
  "SOLANA_LAUNCH_FEE_POLICY_APPROVED",
  "SOLANA_LAUNCH_MARKET_MAKER_RISK_APPROVED",
  "resolveOperatorAlertConfig",
  "resolveKeeperRoleRefs",
  "validateKeeperRoleSeparation",
  "validateKeeperFeeTreasurySeparation",
] as const) {
  if (
    !keeperRuntimeEnvironmentPolicy.includes(requiredRuntimeEnvironmentControl)
  ) {
    fail(
      `${keeperRuntimeEnvironmentPolicyPath} is missing ${requiredRuntimeEnvironmentControl}`,
    );
  }
}
const keeperRuntimeEnvironmentCliPath =
  "scripts/ci-keeper-runtime-env-solana-v1.ts";
for (const requiredRuntimeEnvironmentCliControl of [
  "auditKeeperRuntimeEnvironmentFiles",
  "service-env-file",
  "duel-bot-env-file",
  "inspectedValuesPrinted",
] as const) {
  if (
    !read(keeperRuntimeEnvironmentCliPath).includes(
      requiredRuntimeEnvironmentCliControl,
    )
  ) {
    fail(
      `${keeperRuntimeEnvironmentCliPath} is missing ${requiredRuntimeEnvironmentCliControl}`,
    );
  }
}

const stagedWorkspacePath = "scripts/stage-deploy-workspace.ts";
requireAbsent(stagedWorkspacePath, [
  /packages\/(?:market-maker-bot|hyperbet-mm-core|hyperbet-chain-registry|hyperbet-(?:evm|bsc|avax))/i,
  /keeper:(?:evm|bsc|avax)/i,
]);
if (
  !read(stagedWorkspacePath).includes("unsupported SOL-only deployment target")
) {
  fail("deployment workspace staging does not reject non-Solana targets");
}
for (const requiredStagingControl of [
  "runtimeEntrypoints",
  "ts.preProcessFile",
  "permittedSharedRuntimeFiles",
  "account-schema.ts",
  "workspace-runtime-src",
  "--release-sha=",
  "full-lowercase-commit-sha",
] as const) {
  if (!read(stagedWorkspacePath).includes(requiredStagingControl)) {
    fail(`deployment workspace staging is missing ${requiredStagingControl}`);
  }
}

const launchRunbookPaths = [
  "docs/runbooks/README.md",
  "docs/runbooks/quote-disablement-and-safe-restart.md",
  "docs/runbooks/chain-outage-or-rpc-degradation.md",
  "docs/runbooks/claim-backlog-drainage.md",
  "docs/runbooks/backup-restore-and-release-rollback.md",
  "docs/runbooks/cold-authority-pause-and-cancel.md",
  "docs/runbooks/stream-delivery-failover.md",
  "docs/runbooks/alert-routing-and-escalation.md",
  "docs/runbooks/stale-oracle-or-stale-stream.md",
] as const;
for (const runbookPath of launchRunbookPaths) {
  requireAbsent(runbookPath, [
    /packages\/market-maker-bot/i,
    /MM_DATABASE_URL/i,
    /verify:chains/i,
    /packages\/simulation-dashboard/i,
    /\b(?:affected|unaffected) chains?\b/i,
    /\bchain set\b/i,
  ]);
}
for (const [runbookPath, requiredControls] of [
  [
    "docs/runbooks/quote-disablement-and-safe-restart.md",
    ["terminal-ops feed-status", "terminal-ops list", "verify:deployment:"],
  ],
  [
    "docs/runbooks/chain-outage-or-rpc-degradation.md",
    ["expected genesis hash", "ambiguous transaction", "duel bot"],
  ],
  [
    "docs/runbooks/claim-backlog-drainage.md",
    [
      "wallet-signed Solana transactions",
      "Never auto-resubmit",
      "terminal-ops list",
    ],
  ],
  [
    "docs/runbooks/stream-delivery-failover.md",
    [
      "pm:stream:failover:verify",
      "VITE_TRANSACTIONS_ENABLED=false",
      "program-date",
      "mode-0600",
    ],
  ],
  [
    "docs/runbooks/alert-routing-and-escalation.md",
    [
      "HYPERIA_EXTERNAL_VALUE_ENABLED=true",
      "stream:alert:probe",
      "STREAMING_RUNTIME_ALERT_TEST",
      "webhook_http_acceptance_only",
      "onCallAcknowledgementRequired: true",
      "mode-0600",
    ],
  ],
  [
    "docs/runbooks/backup-restore-and-release-rollback.md",
    [
      "keeper-backup create",
      "keeper-backup verify",
      "operator-alert-state-backup create",
      "operator-alert-state-backup verify",
      "operator-alert-state-backup restore",
      "keeper-recovery-set create",
      "keeper-recovery-set verify",
      "keeper-recovery-set materialize",
      "keeper-recovery-set verify-materialized",
      "platform-recovery-set create",
      "platform-recovery-set verify",
      "platform-recovery-rehearsal create",
      "platform-recovery-rehearsal verify",
      "restored-duel-state-reconciliation create",
      "restored-duel-state-reconciliation verify",
      "file_pair_binding_only",
      "cross_repository_file_binding_only",
      "cross_repository_restore_evidence_binding_only",
      "cross_repository_restored_duel_state_and_application_read_projection",
      "quiescentBoundaryWitnessRequired=true",
      "isolated_restore_materialization_only",
      "activationRequiresSeparateApproval=true",
      "db:backup-recovery create",
      "db:backup-recovery verify-restored",
      "db:restore-recovery-evidence create",
      "db:restore-recovery-evidence verify",
      "db:restored-duel-application-readiness",
      "--hyperia-application-readiness",
      "productionCutoverAuthorized=false",
      "canonical chain state",
      "Never test a restore over the only production database",
    ],
  ],
  [
    "docs/runbooks/cold-authority-pause-and-cancel.md",
    [
      "market-pause",
      "cancel-duel",
      "oracle-pause",
      "broadcastAuthorized: false",
      "Never blind-resubmit an ambiguous",
    ],
  ],
] as const) {
  const runbook = read(runbookPath);
  for (const control of requiredControls) {
    if (!runbook.includes(control)) {
      fail(`${runbookPath} is missing SOL-only operator control ${control}`);
    }
  }
}

const hlsFailoverVerifierPath = "scripts/verify-hls-failover-readiness.ts";
requireAbsent(hlsFailoverVerifierPath, [
  /packages\/(?:market-maker-bot|hyperbet-(?:evm|bsc|avax))/i,
  /\b(?:gold|avax|avalanche)\b/i,
]);
const hlsFailoverVerifier = read(hlsFailoverVerifierPath);
for (const requiredHlsControl of [
  "MAX_MANIFEST_BYTES",
  "EXT-X-PROGRAM-DATE-TIME",
  "max-program-date-lag-ms",
  "max-rendition-program-date-skew-ms",
  "minimum-variant-count",
  "MAX_HLS_VARIANTS",
  "browser-origin",
  "max-manifest-cache-seconds",
  "timing-allow-origin",
  "access-control-allow-origin",
  "redactStreamUrl",
  'flag: "wx"',
  "mode: 0o600",
] as const) {
  if (!hlsFailoverVerifier.includes(requiredHlsControl)) {
    fail(`HLS failover verifier is missing ${requiredHlsControl}`);
  }
}
const rootPackageScripts = JSON.parse(read("package.json")) as {
  scripts?: Record<string, string>;
};
if (
  rootPackageScripts.scripts?.["pm:stream:failover:verify"] !==
  "node --import tsx scripts/verify-hls-failover-readiness.ts"
) {
  fail("root scripts do not expose the canonical HLS failover verifier");
}
if (
  !rootPackageScripts.scripts?.["ci:scope:solana"]?.includes(
    "verify-hls-failover-readiness.test.ts",
  )
) {
  fail(
    "SOL scope gate does not execute the HLS failover verifier policy tests",
  );
}

const keeperBackupPath = "packages/hyperbet-solana/keeper/src/keeperBackup.ts";
requireAbsent(keeperBackupPath, [
  /packages\/(?:market-maker-bot|hyperbet-(?:evm|bsc|avax))/i,
  /\b(?:gold|avax|avalanche)\b/i,
]);
const keeperBackup = read(keeperBackupPath);
for (const requiredBackupControl of [
  "REQUIRED_LAUNCH_TABLES",
  "PRAGMA integrity_check",
  "PRAGMA foreign_key_check",
  "PRAGMA data_version",
  "VACUUM INTO ?1",
  'flag: "wx"',
  "mode: 0o600",
] as const) {
  if (!keeperBackup.includes(requiredBackupControl)) {
    fail(`keeper backup is missing ${requiredBackupControl}`);
  }
}
if (
  keeperPackage.scripts?.["keeper-backup"] !==
  "bun --bun src/keeperBackupCli.ts"
) {
  fail("keeper package does not expose the canonical backup CLI");
}
if (!keeperPackage.scripts?.["test:launch"]?.includes("keeperBackup.test.ts")) {
  fail("keeper launch suite does not execute the backup policy tests");
}
if (
  !rootPackageScripts.scripts?.["ci:scope:solana"]?.includes(
    "keeperBackup.test.ts",
  )
) {
  fail("SOL scope gate does not execute keeper backup policy tests");
}

const emergencyPlanPath =
  "packages/hyperbet-solana/scripts/emergency-instruction-plan.ts";
requireAbsent(emergencyPlanPath, [
  /sendAndConfirm|sendRawTransaction|sendTransaction/u,
  /fromSecretKey|privateKey|secretKey/u,
  /packages\/(?:market-maker-bot|hyperbet-(?:evm|bsc|avax))/i,
  /\b(?:gold|avax|avalanche)\b/i,
]);
const emergencyPlan = read(emergencyPlanPath);
for (const requiredEmergencyControl of [
  '"market-pause"',
  '"oracle-pause"',
  '"cancel-duel"',
  "broadcastAuthorized: false",
  "requiresIndependentReadback: true",
  "requiresSimulation: true",
  'flag: "wx"',
  "mode: 0o600",
] as const) {
  if (!emergencyPlan.includes(requiredEmergencyControl)) {
    fail(`emergency instruction plan is missing ${requiredEmergencyControl}`);
  }
}
if (
  !read("packages/hyperbet-solana/package.json").includes(
    '"emergency:plan": "node --import tsx scripts/emergency-instruction-plan-cli.ts"',
  )
) {
  fail("Solana package does not expose the unsigned emergency-plan CLI");
}
const deploymentVerifier = read(
  "packages/hyperbet-solana/scripts/verify-deployment.ts",
);
for (const requiredPauseReadback of [
  "resolveDeploymentPauseExpectation",
  "pauseStateFailures",
  "observedPauseState",
] as const) {
  if (!deploymentVerifier.includes(requiredPauseReadback)) {
    fail(`deployment verifier is missing ${requiredPauseReadback}`);
  }
}
if (
  !rootPackageScripts.scripts?.["ci:scope:solana"]?.includes(
    "emergency-instruction-plan.test.ts",
  ) ||
  !rootPackageScripts.scripts?.["ci:scope:solana"]?.includes(
    "deployment-pause-expectation.test.ts",
  )
) {
  fail("SOL scope gate does not execute emergency pause policy tests");
}

const keeperStartPath = "packages/hyperbet-solana/keeper/start.sh";
requireAbsent(keeperStartPath, [
  /market-maker/i,
  /ENABLE_MARKET_MAKER/i,
  /src\/bot\.ts/,
]);
const keeperStart = read(keeperStartPath);
for (const requiredRuntimeRoleControl of [
  "HYPERBET_RUNTIME_ROLE",
  "src/service.ts",
  "src/duelBot.ts --no-once",
] as const) {
  if (!keeperStart.includes(requiredRuntimeRoleControl)) {
    fail(`${keeperStartPath} is missing ${requiredRuntimeRoleControl}`);
  }
}
const keeperDockerfilePath = "packages/hyperbet-solana/keeper/Dockerfile";
const keeperDockerfile = read(keeperDockerfilePath);
if (
  !keeperDockerfile.includes(
    "COPY workspace-runtime-src ./packages/hyperbet-solana/keeper/src",
  )
) {
  fail(`${keeperDockerfilePath} does not copy the pruned runtime closure`);
}
if (
  !keeperDockerfile.includes(
    "bun install --frozen-lockfile --production --ignore-scripts",
  )
) {
  fail(
    `${keeperDockerfilePath} must retain the frozen production-only lifecycle-free install`,
  );
}
for (const requiredNonRootControl of [
  "chmod -R a=rX /app/packages",
  "KEEPER_DB_PATH=/app/data/keeper.sqlite",
  "KEEPER_BOT_HEALTH_FILE=/app/data/status/keeper-bot-health.json",
  "KEEPER_STREAM_STATE_FILE=/app/data/status/stream-state.json",
  "HYPERBET_OPERATOR_ALERT_STATE_FILE=/app/data/status/operator-alert-state.json",
  "USER bun",
] as const) {
  if (!keeperDockerfile.includes(requiredNonRootControl)) {
    fail(
      `${keeperDockerfilePath} is missing non-root runtime control ${requiredNonRootControl}`,
    );
  }
}
const keeperDockerIgnorePath = "packages/hyperbet-solana/keeper/.dockerignore";
if (!read(keeperDockerIgnorePath).includes("src/*.test.ts")) {
  fail(`${keeperDockerIgnorePath} does not exclude test sources`);
}
const railwayConfigPolicyPath = "scripts/ci-solana-railway-config.mjs";
const railwayConfigPolicy = read(railwayConfigPolicyPath);
for (const requiredRailwayConfigControl of [
  "EXPECTED_SOLANA_RAILWAY_CONFIGS",
  "hasExactKeys",
  'builder: "DOCKERFILE"',
  'healthcheckPath: "/ready"',
  "healthcheckTimeout: 180",
  'restartPolicyType: "ON_FAILURE"',
  "restartPolicyMaxRetries: 5",
  "numReplicas: 1",
] as const) {
  if (!railwayConfigPolicy.includes(requiredRailwayConfigControl)) {
    fail(
      `${railwayConfigPolicyPath} is missing ${requiredRailwayConfigControl}`,
    );
  }
}
for (const railwayConfigPath of [
  "packages/hyperbet-solana/railway.json",
  "packages/hyperbet-solana/keeper/railway.json",
]) {
  const railwayConfig = JSON.parse(read(railwayConfigPath)) as {
    deploy?: { healthcheckPath?: unknown };
  };
  if (railwayConfig.deploy?.healthcheckPath !== "/ready") {
    fail(`${railwayConfigPath} does not use fail-closed /ready health checks`);
  }
}

const appPath = "packages/hyperbet-solana/app/src/App.tsx";
requireAbsent(appPath, [
  /ModelsMarketView/,
  /surface-mode-models/,
  /MODELS MARKET/,
  prohibitedLegacyBrandPattern,
  />\s*GOLD\s*</,
  /@hyperbet\/ui\/components\/PointsDisplay/,
  /@hyperbet\/ui\/components\/ReferralPanel/,
  /@hyperbet\/chain-registry/,
  /\b(?:AVAX|Avalanche|BSC|Base Sepolia|EVM)\b/i,
  /<select\b[^>]*(?:chain|network)|(?:chain|network)[^<]{0,120}<select\b/i,
]);
const appSource = read(appPath);
for (const requiredSolanaSurfaceControl of [
  "signMessage={wallet.signMessage}",
  'usePredictionMarketLifecycle("solana")',
  "inspectSolanaClusterIdentity(connection, getCluster())",
  "Boolean(oracleInfo?.executable)",
  "Boolean(marketInfo?.executable)",
  "programsChecked: programDeployment.checked",
  "programsReady",
  "keeperChecked: launchReadiness.checked",
  "keeperReady: launchReadiness.ready",
  "marketSnapshot: solanaClobSnapshot",
  "shellCanPlaceBet: bettorShell.canPlaceBet",
  "tradingEnabled={canPlaceBetWithDisclosure}",
] as const) {
  if (!appSource.includes(requiredSolanaSurfaceControl)) {
    fail(
      `${appPath} is missing SOL-only public betting control ${requiredSolanaSurfaceControl}`,
    );
  }
}
const solanaReferralPanelPath =
  "packages/hyperbet-ui/src/components/SolanaReferralPanel.tsx";
const solanaReferralPanelSource = read(solanaReferralPanelPath);
for (const requiredWalletProofControl of [
  "SOLANA_CLUSTER",
  "createSolanaWalletActionProof",
  'action: "invite-register"',
  'action: "invite-redeem"',
  "signMessage",
] as const) {
  if (!solanaReferralPanelSource.includes(requiredWalletProofControl)) {
    fail(
      `${solanaReferralPanelPath} is missing SOL wallet-proof control ${requiredWalletProofControl}`,
    );
  }
}
for (const requiredSpectatorAnalyticsEvent of [
  'emitHyperbetProductEvent("stream_start"',
  'emitHyperbetProductEvent("market_view"',
  'emitHyperbetProductEvent("market_lock"',
  'emitHyperbetProductEvent("result"',
  'emitHyperbetProductEvent("cancellation"',
] as const) {
  if (!appSource.includes(requiredSpectatorAnalyticsEvent)) {
    fail(
      `${appPath} is missing product funnel event ${requiredSpectatorAnalyticsEvent}`,
    );
  }
}

const appRootPath = "packages/hyperbet-solana/app/src/AppRoot.tsx";
const appRootSource = read(appRootPath);
for (const requiredDeferredRuntimeControl of [
  'import("./TransactionWalletRoot")',
  '<Suspense fallback={<div className="app-root" aria-busy="true" />}>',
  "<SpectatorAppWalletProvider>",
] as const) {
  if (!appRootSource.includes(requiredDeferredRuntimeControl)) {
    fail(
      `${appRootPath} is missing deferred runtime control ${requiredDeferredRuntimeControl}`,
    );
  }
}
const appViteConfigPath = "packages/hyperbet-solana/app/vite.config.ts";
if (
  !read(appViteConfigPath).includes('name: "enforce-solana-app-bundle-budget"')
) {
  fail(`${appViteConfigPath} does not enforce the production bundle budget`);
}
const bundleBudgetPath = "packages/hyperbet-solana/app/build/bundleBudget.ts";
const bundleBudgetSource = read(bundleBudgetPath);
for (const requiredBudgetControl of [
  "mainEntry: { rawBytes: 900_000, gzipBytes: 270_000 }",
  "streamPlayer: { rawBytes: 800_000, gzipBytes: 250_000 }",
  "solanaMarket: { rawBytes: 340_000, gzipBytes: 90_000 }",
  "deferredChart: { rawBytes: 375_000, gzipBytes: 110_000 }",
  "staticRasterBytes: 350_000",
  "totalBytes: 3_800_000",
  "TransactionWalletRoot-",
] as const) {
  if (!bundleBudgetSource.includes(requiredBudgetControl)) {
    fail(
      `${bundleBudgetPath} is missing production budget control ${requiredBudgetControl}`,
    );
  }
}

const solanaRuntimeFiles = [
  "packages/hyperbet-solana/app/index.html",
  "packages/hyperbet-solana/app/src/lib/config.ts",
  "packages/hyperbet-solana/app/src/lib/programIds.ts",
  "packages/hyperbet-solana/app/src/lib/runtimeUrls.ts",
  "packages/hyperbet-solana/deployments/solana-v1.json",
  "packages/hyperbet-solana/deployments/v1.ts",
  "packages/hyperbet-ui/src/lib/solanaConfig.ts",
  "packages/hyperbet-ui/src/lib/solanaLifecycle.ts",
  "packages/hyperbet-ui/src/lib/solanaPredictionMarkets.ts",
  "packages/hyperbet-ui/src/lib/solanaPredictionMarketTracking.ts",
  "packages/hyperbet-ui/src/lib/productAnalytics.ts",
  "packages/hyperbet-ui/src/lib/solanaSettlementAction.ts",
  "packages/hyperbet-ui/src/lib/solanaSettlementHistory.ts",
  "packages/hyperbet-ui/src/components/SolanaPointsDisplay.tsx",
  "packages/hyperbet-ui/src/components/SolanaReferralPanel.tsx",
  "packages/hyperbet-ui/src/components/SolanaSettlementHistory.tsx",
] as const;
const forbiddenSolanaRuntimePatterns = [
  /\bGOLD\b/i,
  /goldMint/i,
  /goldAmount/i,
  /gold-betting-keeper/i,
  /\b(?:BSC|AVAX|Avalanche|Base Sepolia)\b/i,
  /\b(?:perps|amm|models market)\b/i,
  /@hyperbet\/chain-registry/,
] as const;
for (const relativePath of solanaRuntimeFiles) {
  requireAbsent(relativePath, forbiddenSolanaRuntimePatterns);
}

const keeperLaunchSources = [
  "packages/hyperbet-solana/keeper/src/service.ts",
  "packages/hyperbet-solana/keeper/src/db.ts",
  "packages/hyperbet-solana/keeper/src/launchCommon.ts",
  "packages/hyperbet-solana/keeper/src/launchHealth.ts",
  "packages/hyperbet-solana/keeper/src/marketRecovery.ts",
  "packages/hyperbet-solana/keeper/src/duelBot.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidence.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceCli.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceCollector.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceVerifyCli.ts",
  "packages/hyperbet-solana/keeper/src/duelTerminalPolicy.ts",
  "packages/hyperbet-solana/keeper/src/feedConfig.ts",
  "packages/hyperbet-solana/keeper/src/feePolicy.ts",
  "packages/hyperbet-solana/keeper/src/game-client.ts",
  "packages/hyperbet-solana/keeper/src/bettingFeedEvidence.ts",
  "packages/hyperbet-solana/keeper/src/keeperRoles.ts",
  "packages/hyperbet-solana/keeper/src/nativeAmount.ts",
  "packages/hyperbet-solana/keeper/src/readiness.ts",
  "packages/hyperbet-solana/keeper/src/resolve.ts",
  "packages/hyperbet-solana/keeper/src/solanaBetAccounting.ts",
  "packages/hyperbet-solana/keeper/src/solanaBetReconciliation.ts",
  "packages/hyperbet-solana/keeper/src/solanaTerminalSettlement.ts",
  "packages/hyperbet-solana/keeper/src/solanaLifecycleIndexer.ts",
  "packages/hyperbet-solana/keeper/src/solanaProgramIdentity.ts",
  "packages/hyperbet-solana/keeper/src/solanaLifecycle.ts",
  "packages/hyperbet-solana/keeper/src/solanaMarketMakerPolicy.ts",
  "packages/hyperbet-solana/keeper/src/solanaRpcProxyPolicy.ts",
  "packages/hyperbet-solana/keeper/src/solanaWallet.ts",
  "packages/hyperbet-solana/keeper/src/terminalLedger.ts",
  "packages/hyperbet-solana/keeper/src/terminalOps.ts",
] as const;
const forbiddenKeeperLaunchPatterns = [
  /@hyperbet\/(?:chain-registry|mm-core)/,
  /\/api\/perps/,
  /points\/multiplier/,
  /arena\/wallet-link/,
  /proxy\/birdeye/,
  /\bgoldAmount\b/i,
  /\bsourceAmount\b/,
  /wallet_gold_state/i,
  /referral_fees/i,
  /staking_points/i,
  /wallet_canonical/i,
  /identity_members/i,
  /\bpointsScope\b/,
  /\bidentityWalletCount\b/,
  /url\.searchParams\.get\(["']scope["']\)/,
  /\b(?:BSC|AVAX|Avalanche|Base Sepolia)\b/i,
] as const;
for (const relativePath of keeperLaunchSources) {
  requireAbsent(relativePath, forbiddenKeeperLaunchPatterns);
}

requireAbsent("packages/hyperbet-solana/keeper/src/duelBot.ts", [
  /from\s+["']\.\/common["']/,
  /\b(?:perps|model.?market|trueskill|agent.?rating)\b/i,
  /\b(?:GOLD|AVAX|Avalanche|BSC|Base Sepolia)\b/i,
  /seed-gold|market-mint|legacyAnalyticsDb/i,
  prohibitedLegacyBrandPattern,
  /\b(?:BOT_KEYPAIR|ORACLE_AUTHORITY_KEYPAIR)\b/,
]);
requireAbsent("packages/hyperbet-solana/keeper/src/resolve.ts", [
  /from\s+["']\.\/common["']/,
  /\b(?:BOT_KEYPAIR|ORACLE_AUTHORITY_KEYPAIR)\b/,
]);
requireAbsent("packages/hyperbet-solana/keeper/src/game-client.ts", [
  /\/api\/streaming\/state/,
  /STREAMING_STATE_UPDATE/,
]);
const gameClientSource = read(
  "packages/hyperbet-solana/keeper/src/game-client.ts",
);
if (!gameClientSource.includes("payload.schemaVersion !== 3")) {
  fail("duel keeper game client does not require betting-feed schema v3");
}
if (!gameClientSource.includes("/api/internal/bet-sync/state")) {
  fail(
    "duel keeper game client is not pinned to the authenticated betting feed",
  );
}
for (const requiredContinuityToken of [
  "payload.sourceEpoch",
  "payload.seq",
  "/api/internal/bet-sync/events",
  "BettingFeedContinuityError",
  "saveBettingFeedCheckpoint",
]) {
  if (!gameClientSource.includes(requiredContinuityToken)) {
    fail(
      `duel keeper game client is missing feed-continuity control ${requiredContinuityToken}`,
    );
  }
}
const gameClientTestSource = read(
  "packages/hyperbet-solana/keeper/src/game-client.test.ts",
);
for (const requiredShutdownTimelineProof of [
  'payload.phase === "ANNOUNCEMENT" || payload.phase === "COUNTDOWN"',
  'payload.outcome === "cancelled"',
  "accepts the immutable fight start published during announcement",
  "accepts a pre-fight cancellation before the immutable future fight start",
  'cancellationReason: "scheduler_shutdown"',
] as const) {
  if (
    !gameClientSource.includes(requiredShutdownTimelineProof) &&
    !gameClientTestSource.includes(requiredShutdownTimelineProof)
  ) {
    fail(
      `duel keeper is missing graceful-shutdown timeline proof ${requiredShutdownTimelineProof}`,
    );
  }
}
const marketRecoverySource = read(
  "packages/hyperbet-solana/keeper/src/marketRecovery.ts",
);
const managedOrderClosureSource = read(
  "packages/hyperbet-solana/keeper/src/managedOrderClosure.ts",
);
const managedOrderClosureTestSource = read(
  "packages/hyperbet-solana/keeper/src/managedOrderClosure.test.ts",
);
for (const requiredRecoveryToken of [
  "safeAccountInteger",
  "exactBytes32Hex as bytes32Hex",
  "findDuelStatePda",
  "findMarketPda",
  "findOrderPda",
  "allowedMarketAuthorities",
  "expectedFees",
  "type ManagedOrderClosurePlan",
  "type ManagedOrderClosurePriceLevel",
  'from "./managedOrderClosure"',
  "missing canonical duelId metadata",
  "invalid-managed-order",
]) {
  if (!marketRecoverySource.includes(requiredRecoveryToken)) {
    fail(
      `duel keeper market recovery is missing validation ${requiredRecoveryToken}`,
    );
  }
}
if (
  marketRecoverySource.includes("value.map(Number)") ||
  marketRecoverySource.includes("function asSafeInteger(") ||
  marketRecoverySource.includes("function bytes32Hex(")
) {
  fail("duel keeper market recovery restored coercive account decoding");
}
for (const requiredClosureToken of [
  "planManagedOrderClosure",
  "resolveManagedOrderClosurePriceLevel",
  "orderBehavior",
  "remainingAmount",
  "priceLevelHeadOrderId",
  "priceLevelTailOrderId",
  "priceLevelTotalOpen",
  "effectivePreviousOrderId",
  "resting order has invalid adjacent book links",
  "single-order price level does not conserve its remainder",
  "multi-order price level does not conserve its remainder",
  "resting order price level is missing or inconsistent",
  "managed order and price level must use exact 1,000-unit lots",
] as const) {
  if (!managedOrderClosureSource.includes(requiredClosureToken)) {
    fail(
      `duel keeper managed-order closure is missing validation ${requiredClosureToken}`,
    );
  }
}
if (managedOrderClosureSource.includes("FIFO order-id monotonicity")) {
  fail("duel keeper market recovery restored invalid queue/order-ID coupling");
}
for (const requiredNonmonotonicRecoveryProof of [
  "preserves reciprocal queue order independently of global order IDs",
  "normalizes any distinct stale predecessor from the canonical head",
  "previousOrderId: 54",
  "priceLevelTailOrderId: 52",
  "requires exact single-order and strict multi-order total conservation",
  "recovers only a continuation-pending order when its price level is absent",
  "rejects every noncanonical managed-order or price-level lot",
] as const) {
  if (
    !managedOrderClosureTestSource.includes(requiredNonmonotonicRecoveryProof)
  ) {
    fail(
      `duel keeper market recovery is missing nonmonotonic queue proof ${requiredNonmonotonicRecoveryProof}`,
    );
  }
}
requireAbsent("packages/hyperbet-solana/keeper/.env.example", [
  /\b(?:GOLD|AVAX|Avalanche|BSC|Base Sepolia)\b/i,
  /PERPS_|BIRDEYE_|MARKET_MINT|ENABLE_KEEPER_BOT/i,
  /\b(?:BOT_KEYPAIR|ORACLE_AUTHORITY_KEYPAIR)\b/,
]);
requireAbsent("packages/hyperbet-solana/app/.env.example", [
  /\b(?:GOLD|AVAX|Avalanche|BSC|Base Sepolia)\b/i,
  /PERPS_|GOLD_MINT|USDC_MINT/i,
  /packages\/market-maker-bot/i,
  /(?:^|[= ])\/(?:Users|home)\//im,
]);
for (const requiredStreamExample of [
  "VITE_STREAM_URL=",
  "VITE_STREAM_SOURCES=",
  "VITE_STREAM_FALLBACK_URL=",
] as const) {
  if (
    !read("packages/hyperbet-solana/app/.env.example").includes(
      requiredStreamExample,
    )
  ) {
    fail(`Solana app env example is missing ${requiredStreamExample}`);
  }
}

const solanaAppPackage = JSON.parse(
  read("packages/hyperbet-solana/app/package.json"),
) as { scripts?: Record<string, string> };
if (solanaAppPackage.scripts?.test !== "bun test tests/unit") {
  fail("Solana app default test is not pinned to its unit suite");
}
if (solanaAppPackage.scripts?.preview !== "vite preview") {
  fail("Solana app compiled preview command is not pinned to Vite preview");
}
if (solanaAppPackage.scripts?.["test:e2e:mainnet"]) {
  fail("Solana app still exposes a public mainnet browser-write harness");
}
for (const requiredReadOnlyCommand of ["test:e2e:devnet", "test:e2e:testnet"]) {
  if (
    !solanaAppPackage.scripts?.[requiredReadOnlyCommand]?.includes(
      "scripts/run-e2e-public.sh",
    )
  ) {
    fail(`Solana app is missing ${requiredReadOnlyCommand}`);
  }
}
if (
  solanaAppPackage.scripts?.["test:e2e:performance:local"] !==
  "bun run test:e2e:performance:desktop:local && bun run test:e2e:performance:mobile:local"
) {
  fail("Solana app is missing its aggregate local performance command");
}
for (const [command, profile] of [
  ["test:e2e:performance:desktop:local", "desktop_720p"],
  ["test:e2e:performance:mobile:local", "mobile_360p"],
] as const) {
  const value = solanaAppPackage.scripts?.[command] ?? "";
  if (
    !value.includes("E2E_APP_RUNTIME=production_preview") ||
    !value.includes(`E2E_PERFORMANCE_PROFILE=${profile}`)
  ) {
    fail(`Solana app is missing its compiled ${profile} performance command`);
  }
}
for (const [command, requiredControls] of [
  [
    "test:e2e:adaptive:local",
    [
      "E2E_APP_RUNTIME=production_preview",
      "E2E_HLS_ADAPTIVE=true",
      "adaptive HLS delivery",
    ],
  ],
  [
    "test:e2e:failover:local",
    [
      "E2E_APP_RUNTIME=production_preview",
      "E2E_HLS_ADAPTIVE=true",
      "E2E_HLS_FAILOVER=true",
      "HLS source failover",
    ],
  ],
] as const) {
  const value = solanaAppPackage.scripts?.[command] ?? "";
  for (const control of requiredControls) {
    if (!value.includes(control)) {
      fail(`Solana app ${command} is missing ${control}`);
    }
  }
}
const gracefulShutdownCommand =
  solanaAppPackage.scripts?.["test:e2e:graceful-shutdown:local"] ?? "";
for (const requiredControl of [
  "E2E_DUEL_SOURCE=real_hyperia",
  "E2E_APP_RUNTIME=development",
  "E2E_SKIP_PREBUILD=true",
  "graceful Hyperia shutdown cancels the exact active SOL market",
] as const) {
  if (!gracefulShutdownCommand.includes(requiredControl)) {
    fail(`Solana app graceful shutdown command is missing ${requiredControl}`);
  }
}

const launchHarnessPaths = [
  "packages/hyperbet-solana/app/scripts/run-local-demo.sh",
  "packages/hyperbet-solana/app/scripts/run-e2e-local.sh",
  "packages/hyperbet-solana/app/scripts/e2e-hls-origin.mjs",
  "packages/hyperbet-solana/app/scripts/run-e2e-public.sh",
  "packages/hyperbet-solana/app/tests/e2e/setup-localnet.ts",
  "packages/hyperbet-solana/app/tests/e2e/setup-public.ts",
  "packages/hyperbet-solana/app/tests/e2e/seed-api-local.ts",
  "packages/hyperbet-solana/app/tests/e2e/market-flows.e2e.ts",
  "packages/hyperbet-solana/app/tests/e2e/production-performance.e2e.ts",
  "packages/hyperbet-solana/app/tests/e2e/productionPerformancePolicy.ts",
  "packages/hyperbet-solana/app/tests/e2e/adaptive-delivery.e2e.ts",
  "packages/hyperbet-solana/app/tests/e2e/stream-failover.e2e.ts",
] as const;
for (const relativePath of launchHarnessPaths) {
  requireAbsent(relativePath, [
    /\bGOLD\b/i,
    /gold[_-]?(?:mint|clob|perps|amm)/i,
    /E2E_SOLANA_V1_ONLY/,
    /ORACLE_AUTHORITY_KEYPAIR/,
    /ENABLE_KEEPER_BOT/,
    /packages\/hyperbet-(?:bsc|avax|evm)/i,
    /\b(?:AVAX|Avalanche|BSC|Base Sepolia)\b/i,
  ]);
}
const solanaMarketFlowsE2eSource = read(
  "packages/hyperbet-solana/app/tests/e2e/market-flows.e2e.ts",
);
for (const requiredEmptyBalanceBrowserProof of [
  "a cancelled-only bettor recovers exact empty-balance rent after the market closes",
  "open markets must never expose balance closure",
  "account-rent recovery confirmed on-chain",
  "balanceRentLamports",
] as const) {
  if (!solanaMarketFlowsE2eSource.includes(requiredEmptyBalanceBrowserProof)) {
    fail(
      `Solana browser harness is missing empty-balance rent proof ${requiredEmptyBalanceBrowserProof}`,
    );
  }
}
if (
  existsSync(
    join(root, "packages/hyperbet-solana/app/tests/e2e/setup-api-local.ts"),
  )
) {
  fail("retired token analytics E2E seed remains callable");
}

const localHarness = read(
  "packages/hyperbet-solana/app/scripts/run-e2e-local.sh",
);
for (const requiredLocalProgram of ["fight_oracle.so", "duel_market.so"]) {
  if (!localHarness.includes(requiredLocalProgram)) {
    fail(`local E2E harness does not deploy ${requiredLocalProgram}`);
  }
}
for (const requiredLocalHarnessControl of [
  "SOLANA_ACTIVE_RELEASE_BIN",
  "E2E_CARGO_TARGET_DIR",
  "hyperbet-solana-e2e-cargo.",
  "cleanup_cargo_target",
  "E2E_APP_RUNTIME",
  "production_preview",
  "E2E_PERFORMANCE_PROFILE",
  "desktop_720p",
  "mobile_360p",
  "HLS_VIDEO_BITRATE_KBPS=4500",
  "HLS_VIDEO_BITRATE_KBPS=900",
  "E2E_HLS_ADAPTIVE",
  "E2E_HLS_FAILOVER",
  "HLS_BACKUP_PID_FILE",
  "HLS_PRIMARY_ORIGIN_PID_FILE",
  "HLS_BACKUP_ORIGIN_PID_FILE",
  "independent dual-encoder, dual-origin HLS fixture is ready",
  "verify_independent_hls_content_parity",
  'HLS_CONTENT_PARITY_PATH="$HLS_ROOT/source-content-parity.json"',
  '-hls_segment_options "mpegts_service_id=${transport_service_id}"',
  "VITE_STREAM_SOURCES",
  'VITE_STREAM_SOURCES="$HLS_PRIMARY_URL,$HLS_BACKUP_URL"',
  'E2E_HLS_SOURCE_TOPOLOGY="${E2E_HLS_SOURCE_TOPOLOGY:-independent-encoders-origins}"',
  'E2E_HLS_PRIMARY_ENCODER_PID="$HLS_PID"',
  'E2E_HLS_BACKUP_ENCODER_PID="$HLS_BACKUP_PID"',
  'E2E_HLS_PRIMARY_ORIGIN_PID="$HLS_PRIMARY_ORIGIN_PID"',
  'E2E_HLS_BACKUP_ORIGIN_PID="$HLS_BACKUP_ORIGIN_PID"',
  'E2E_HLS_PRIMARY_ORIGIN_PID_FILE="$HLS_PRIMARY_ORIGIN_PID_FILE"',
  'E2E_HLS_BACKUP_ORIGIN_PID_FILE="$HLS_BACKUP_ORIGIN_PID_FILE"',
  'E2E_HLS_CONTENT_PARITY_PATH="$HLS_CONTENT_PARITY_PATH"',
  'E2E_PROCESS_CONTROL_SCRIPT="$REPO_ROOT/scripts/e2e-process-control.sh"',
  '--arg launchPath "$PATH"',
  "launchPath: $launchPath",
  'pidStrategy: (if $hyperiaRuntime == "full_3d" then "root" else "listener" end)',
  'AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_URL "$GAME_API_URL/api/keeper/bot-health"',
  'AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_TIMEOUT_MS "15000"',
  "-c:a aac",
  "exec env",
  '"$VITE_BIN" build --mode production',
  '"$VITE_BIN" preview --mode production',
] as const) {
  if (!localHarness.includes(requiredLocalHarnessControl)) {
    fail(
      `local E2E harness is missing host-safe build control ${requiredLocalHarnessControl}`,
    );
  }
}
const localHlsOrigin = read(
  "packages/hyperbet-solana/app/scripts/e2e-hls-origin.mjs",
);
for (const requiredOriginControl of [
  'response.setHeader("X-Hyperbet-E2E-HLS-Origin", label)',
  '"Content-Length, Content-Range, X-Hyperbet-E2E-HLS-Origin"',
  "const prefix = `/live/${label}/`",
  'server.listen(port, "127.0.0.1"',
  'response.setHeader("Timing-Allow-Origin", "*")',
  'response.setHeader("Cache-Control", "public, max-age=31536000, immutable")',
] as const) {
  if (!localHlsOrigin.includes(requiredOriginControl)) {
    fail(
      `independent local HLS origin is missing delivery control ${requiredOriginControl}`,
    );
  }
}
const e2eProcessControl = read("scripts/e2e-process-control.sh");
for (const requiredRuntimeProcessControl of [
  `launch_path="$(jq -r '.launchPath // empty' "$CONTROL_PATH")"`,
  "control launchPath must be a non-empty colon-delimited path without empty entries",
  "control launchPath entries must be absolute",
  "service pidStrategy must be root or listener",
  'if [[ "$pid_strategy" == "listener" ]]',
  '/usr/bin/nohup /usr/bin/env PATH="$launch_path" /bin/bash -c',
] as const) {
  if (!e2eProcessControl.includes(requiredRuntimeProcessControl)) {
    fail(
      `E2E process control is missing deterministic runtime identity ${requiredRuntimeProcessControl}`,
    );
  }
}
for (const forbiddenRuntimeProcessControl of [
  "bash -lc",
  "/Users/mac/.bun/bin",
] as const) {
  if (e2eProcessControl.includes(forbiddenRuntimeProcessControl)) {
    fail(
      `E2E process control contains host-dependent runtime launch ${forbiddenRuntimeProcessControl}`,
    );
  }
}
for (const requiredOriginProcessControl of [
  "hlsPrimaryOrigin|hlsBackupOrigin",
  "wait_for_hls_origin",
  'grep -qi "^x-hyperbet-e2e-hls-origin: ${expected_label}$"',
  'start_shell_service "HLS origin env file"',
] as const) {
  if (!e2eProcessControl.includes(requiredOriginProcessControl)) {
    fail(
      `E2E process control is missing HLS origin lifecycle proof ${requiredOriginProcessControl}`,
    );
  }
}
for (const requiredGracefulShutdownProof of [
  "graceful Hyperia shutdown cancels the exact active SOL market and refunds lamports",
  'runProcessControl(control, "stop", "hyperia")',
  'event: "shutdown-complete"',
  'cancellationReason: "scheduler_shutdown"',
  "downstreamAcknowledged: true",
  'data-market-can-place-bet", "false"',
  "sourceRemainedStoppedThroughCancellation: true",
  'settlementState: "REFUND_CLAIMABLE"',
  'settlementState: "REFUNDED"',
  'toContainText("Refund paid"',
  "expectedRefundLamports + userBalanceRentLamports",
  "userBalanceClosed: true",
] as const) {
  if (!solanaMarketFlowsE2eSource.includes(requiredGracefulShutdownProof)) {
    fail(
      `Solana browser harness is missing graceful-shutdown proof ${requiredGracefulShutdownProof}`,
    );
  }
}
for (const requiredHyperiaRestartProof of [
  "solana open prediction markets recover after Hyperia restarts",
  'runProcessControl(control, "restart", "hyperia")',
  'expect(reuseGameBuilds).toBe(process.env.E2E_SKIP_PREBUILD === "true")',
  'restartedProcessCommand.includes("--reuse-game-builds")',
  "sourceAfter.sourceEpoch).not.toBe(sourceBefore.sourceEpoch)",
  'status: "temporarily_unavailable"',
  'error.message === "Hyperia authority health returned HTTP 503"',
  "snapshotDigest: sourceBefore.snapshotDigest",
  "const initialPid = readOwnedProcessId(",
  '"initial Hyperia supervisor"',
  "const restartedPid = readOwnedProcessId(",
  '"restarted Hyperia supervisor"',
  'initialProcessCommand).toContain("scripts/duel-stack.mjs")',
  'restartedProcessCommand).toContain("scripts/duel-stack.mjs")',
  "const resolvedLaunchNodePath =",
  "fs.realpathSync(resolvedLaunchNodePath)",
  "fs.realpathSync(configuredNodePath)",
  "updatedAfterRestart",
  'source: "external-rtmp-bridge"',
  "afterPlayback.currentTime - beforePlayback.currentTime",
  "afterPlayback.totalVideoFrames",
  "sameDuelRecovered: true",
  "sameMarketRecovered: true",
  "sourceEpochChanged: true",
  'expect(enumName(exactMarketBeforeRestart.status)).toBe("open")',
  "marketStatusBeforeRestart: enumName(exactMarketBeforeRestart.status)",
  "resolvedLaunchNodePath",
  "solana-full3d-hyperia-restart-recovery.json",
  "solana-full3d-hyperia-restart-recovery.png",
] as const) {
  if (!solanaMarketFlowsE2eSource.includes(requiredHyperiaRestartProof)) {
    fail(
      `Solana browser harness is missing full-3D Hyperia restart proof ${requiredHyperiaRestartProof}`,
    );
  }
}
const streamFailoverE2ePath =
  "packages/hyperbet-solana/app/tests/e2e/stream-failover.e2e.ts";
const streamFailoverE2eSource = read(streamFailoverE2ePath);
for (const requiredFailoverProof of [
  "MAX_FAILOVER_RECOVERY_MS = 20_000",
  '"**/live/primary/**"',
  'runOriginProcessControl("kill", "hlsPrimaryOrigin")',
  'runOriginProcessControl("start", "hlsPrimaryOrigin")',
  'runOriginProcessControl("kill", "hlsBackupOrigin")',
  "encoderRemainedAlive: true",
  "replacementPid: restartedPrimaryOriginPid",
  "requireActualOriginProcessDeath: true",
  'streamSyncMode === "program-date-time"',
  'marketCanPlaceBet === "false"',
  'variantCount === "2"',
  "transientPrimaryFailuresRemaining = 2",
  "maximumToleratedTransientFailures: 2",
  "transientPrimaryRecovery.networkFailureCounts",
  'transientPrimaryRecovery.sourceLabels).toEqual(["Source 1/2"]',
  "page.unroute(primaryFaultPattern, transientPrimaryHandler)",
  "navigationMarkerPreserved: true",
  "fingerprintHlsSource",
  "sourceTopology: HLS_SOURCE_TOPOLOGY",
  "independentEncoderCount: 2",
  "independentOriginCount: 2",
  "sourceFingerprints.primary.segmentSha256",
  "readHlsContentParity",
  "sourceContentParity.independentTransportBytes",
  "sourceContentParity.decodedVideoEquivalent",
  "sourceContentParity.decodedAudioEquivalent",
  "new Set(Object.values(sourceProcesses)).size).toBe(4)",
  "processIsAlive(processId)",
  "verifiedAliveAtStart: true",
  "MAX_SOURCE_CLOCK_SKEW_MS",
  "manifest?.fixtureOrigin).toBe(source)",
  "manifest?.origin).toBe(sourceFingerprints[source].origin)",
  "expect(runtimeErrors",
] as const) {
  if (!streamFailoverE2eSource.includes(requiredFailoverProof)) {
    fail(
      `${streamFailoverE2ePath} is missing physical failover proof ${requiredFailoverProof}`,
    );
  }
}
const streamPlayerPath = "packages/hyperbet-ui/src/components/StreamPlayer.tsx";
const streamPlayerSource = read(streamPlayerPath);
for (const requiredPlayerPolicy of [
  "HLS_NETWORK_FAILURE_LIMIT = 3",
  "shouldFailOverAfterHlsNetworkFailures",
  "abrEwmaSlowLive: 4",
  "abrBandWidthUpFactor: 0.85",
] as const) {
  if (!streamPlayerSource.includes(requiredPlayerPolicy)) {
    fail(
      `${streamPlayerPath} is missing live delivery policy ${requiredPlayerPolicy}`,
    );
  }
}
const solanaAppViteConfig = read("packages/hyperbet-solana/app/vite.config.ts");
if (!solanaAppViteConfig.includes('"Timing-Allow-Origin", "*"')) {
  fail("Solana app HLS delivery does not expose browser resource timing");
}
if (
  !read("packages/hyperbet-solana/app/index.html").includes(
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  ) ||
  !existsSync(join(root, "packages/hyperbet-solana/app/public/favicon.svg"))
) {
  fail("Solana app production shell is missing its explicit favicon asset");
}
const productionPerformancePolicySource = read(
  "packages/hyperbet-solana/app/tests/e2e/productionPerformancePolicy.ts",
);
for (const requiredPerformanceBudget of [
  "lcpMs: 4_000",
  "firstDecodedFrameMs: 8_000",
  "maxInteractionMs: 350",
  "minimumPresentedFps: 24",
  "maximumDroppedFrameRatio: 0.01",
  "jsHeapUsedBytes: 192 * 1024 * 1024",
  "maxLongTaskMs: 250",
  "horizontalOverflowPx: 0",
  "nonMediaTransferredBytes: 2 * 1024 * 1024",
  "mediaTransferredBytes: 10 * 1024 * 1024",
] as const) {
  if (!productionPerformancePolicySource.includes(requiredPerformanceBudget)) {
    fail(
      `production browser performance policy is missing ${requiredPerformanceBudget}`,
    );
  }
}
const productionPerformanceE2eSource = read(
  "packages/hyperbet-solana/app/tests/e2e/production-performance.e2e.ts",
);
for (const requiredPerformanceMeasurement of [
  '"largest-contentful-paint"',
  '"longtask"',
  '"Network.emulateNetworkConditions"',
  '"Emulation.setCPUThrottlingRate"',
  '"Performance.getMetrics"',
  "getVideoPlaybackQuality",
  "requestVideoFrameCallback",
  "lcpObserverSupported",
  "longTaskObserverSupported",
  '"Browser.getVersion"',
  "E2E_PERFORMANCE_ARTIFACT_DIR",
  "document.documentElement.scrollWidth",
  "fullPage: true",
  "desktop_720p",
  "mobile_360p",
  "evaluateProductionBrowserPerformance",
] as const) {
  if (
    !productionPerformanceE2eSource.includes(requiredPerformanceMeasurement)
  ) {
    fail(
      `production browser performance E2E is missing ${requiredPerformanceMeasurement}`,
    );
  }
}
const localDemoHarness = read(
  "packages/hyperbet-solana/app/scripts/run-local-demo.sh",
);
for (const requiredLocalDemoControl of [
  "SOLANA_ACTIVE_RELEASE_BIN",
  "LOCAL_DEMO_CARGO_TARGET_DIR",
  "hyperbet-solana-local-demo-cargo.",
  "cleanup_cargo_target",
] as const) {
  if (!localDemoHarness.includes(requiredLocalDemoControl)) {
    fail(
      `local demo harness is missing host-safe build control ${requiredLocalDemoControl}`,
    );
  }
}
const syntheticDuelFixtureSource = read(
  "packages/hyperbet-solana/app/tests/e2e/syntheticDuelFixture.ts",
);
for (const requiredSyntheticCommitmentControl of [
  "buildSyntheticDuelCommitment",
  "buildSyntheticRendererHealth",
  "competitiveSnapshotDigestBytes",
  "participantAHash",
  "participantBHash",
] as const) {
  if (
    !syntheticDuelFixtureSource.includes(requiredSyntheticCommitmentControl)
  ) {
    fail(
      `synthetic duel fixture is missing immutable commitment control ${requiredSyntheticCommitmentControl}`,
    );
  }
}
const solanaPollingPolicySource = read(
  "packages/hyperbet-solana/app/src/lib/solanaPollingPolicy.ts",
);
for (const requiredPollingControl of [
  "programVerificationIntervalMs",
  "matchDiscoveryIntervalMs",
  "MINIMUM_MATCH_DISCOVERY_INTERVAL_MS",
  "programVerificationMaxAgeMs - 1_000",
] as const) {
  if (!solanaPollingPolicySource.includes(requiredPollingControl)) {
    fail(`Solana browser polling policy is missing ${requiredPollingControl}`);
  }
}
const publicHarness = read(
  "packages/hyperbet-solana/app/scripts/run-e2e-public.sh",
);
for (const requiredReadOnlyControl of [
  "validating live Solana state without chain writes",
  "app-tabs-and-apis.e2e.ts",
  "devnet|testnet",
]) {
  if (!publicHarness.includes(requiredReadOnlyControl)) {
    fail(`public E2E harness is missing ${requiredReadOnlyControl}`);
  }
}
requireAbsent("packages/hyperbet-solana/app/scripts/run-e2e-public.sh", [
  /setup-api-local/,
  /seed-api-local/,
  /start-hyperia-duel-service/,
  /keeper:service/,
  /mainnet-beta/,
]);

const appFacingAcceptance = read(
  "packages/hyperbet-solana/app/tests/e2e/app-tabs-and-apis.e2e.ts",
);
for (const retiredRoute of [
  "/api/perps/markets",
  "/api/models/markets",
  "/api/proxy/evm/rpc",
]) {
  if (!appFacingAcceptance.includes(retiredRoute)) {
    fail(`app acceptance does not prove ${retiredRoute} is inaccessible`);
  }
}
if (!appFacingAcceptance.includes("must stay inaccessible")) {
  fail("app acceptance does not assert disabled-route 404 behavior");
}

requireAbsent("packages/hyperbet-solana/keeper/src/service.ts", [
  /src\/bot\.ts/,
  /Bun\.spawn/,
  /loadPerps/i,
  /modelMarketId/i,
  /saveReferralFees/i,
  /saveWalletGoldState/i,
  /legacyAnalyticsDb/i,
  /from\s+["']\.\/keeperBot["']/i,
  prohibitedLegacyBrandPattern,
  /\b(?:BOT_KEYPAIR|ORACLE_AUTHORITY_KEYPAIR)\b/,
  /readKeypair/,
]);

const duelBotSource = read("packages/hyperbet-solana/keeper/src/duelBot.ts");
const accountIntegerSource = read(
  "packages/hyperbet-solana/keeper/src/accountInteger.ts",
);
const accountIntegerTestSource = read(
  "packages/hyperbet-solana/keeper/src/accountInteger.test.ts",
);
for (const requiredAccountIntegerControl of [
  "safeAccountInteger",
  "requireSafeAccountInteger",
  "accountU64",
  "requireAccountU64",
  "Number.isSafeInteger",
  "Number.MIN_SAFE_INTEGER",
  "Number.MAX_SAFE_INTEGER",
  "MAX_U64",
  "invalid safe-integer bounds",
] as const) {
  if (!accountIntegerSource.includes(requiredAccountIntegerControl)) {
    fail(
      `duel keeper account decoding is missing fail-closed control ${requiredAccountIntegerControl}`,
    );
  }
}
for (const requiredAccountIntegerProof of [
  "accepts the complete JavaScript safe-integer boundary exactly",
  "rejects every lossy, fractional, non-finite, or noncanonical value",
  "enforces custody-specific inclusive bounds",
  "decodes the complete unsigned 64-bit custody boundary without loss",
  "rejects lossy, signed, overflowing, or noncanonical u64 values",
] as const) {
  if (!accountIntegerTestSource.includes(requiredAccountIntegerProof)) {
    fail(
      `duel keeper account decoding is missing boundary proof ${requiredAccountIntegerProof}`,
    );
  }
}
for (const requiredCustodyDecode of [
  "managed order id",
  "managed order amount",
  "managed order filled amount",
  "managed order behavior",
  "managed previous order id",
  "managed next order id",
  "managed price-level head order id",
  "managed price-level tail order id",
  "market next order id",
  "resting price-level tail order id",
  "market-maker A-share exposure",
  "market-maker B-share exposure",
  "A-side locked lamports",
  "B-side locked lamports",
  "accrued treasury-fee lamports",
  "accrued market-maker-fee lamports",
  "managed order lot-size drift",
  "managed order price drift",
  "managed continuation order retained fills",
] as const) {
  if (!duelBotSource.includes(requiredCustodyDecode)) {
    fail(
      `duel keeper is missing fail-closed account decoding for ${requiredCustodyDecode}`,
    );
  }
}
for (const forbiddenLossyAccountDecode of [
  "function asNum(",
  "safeAccountInteger(value) ?? fallback",
  "function asAccountBigInt(",
] as const) {
  if (duelBotSource.includes(forbiddenLossyAccountDecode)) {
    fail(
      `duel keeper restored lossy or fallback account decoding ${forbiddenLossyAccountDecode}`,
    );
  }
}
for (const requiredRecoveryControl of [
  "discoverDuelMarketRecovery",
  "fightProgram.account.duelState.all()",
  "marketProgram.account.marketState.all()",
  "ORDER_MAKER_MEMCMP_OFFSET",
  "ORDER_ACTIVE_MEMCMP_OFFSET",
  "reclaimRestingOrder",
  "recoveredManagedOrders",
  "on-chain-market-recovery",
  "programIdentityCheckIntervalMs",
  "withdrawResolvedTradeFees",
  "accruedTradeTreasuryFeeLamports",
  "accruedTradeMarketMakerFeeLamports",
  "resolveManagedOrderClosurePriceLevel",
  "priceLevel: decodedPriceLevel",
  "closeEmptyUserBalance",
]) {
  if (!duelBotSource.includes(requiredRecoveryControl)) {
    fail(
      `duel keeper is missing on-chain recovery control ${requiredRecoveryControl}`,
    );
  }
}
if (
  !read(
    "packages/hyperbet-solana/keeper/src/solanaMarketMakerPolicy.ts",
  ).includes('"close-empty-balance"')
) {
  fail(
    "duel keeper does not classify an empty managed balance for rent cleanup",
  );
}
const keeperServiceSource = read(
  "packages/hyperbet-solana/keeper/src/service.ts",
);
for (const requiredAccountingControl of [
  "verifyPlaceOrderAccounting",
  "classifySignatureFinality",
  "isCanonicalSolanaTransactionSignature",
  "marketAccount.tradeTreasuryFeeBpsSnapshot",
  "marketAccount.tradeMarketMakerFeeBpsSnapshot",
  "tradeFeeEscrowEvents",
  "claimSettled",
  "resolvedTradeFeesWithdrawn",
  "transaction.meta.innerInstructions",
  "rewardEligibleLamports",
  "REQUIRE_ONCHAIN_BET_VERIFICATION",
  "getSignatureStatuses",
  'commitment: "finalized"',
  'status: "pending-verification"',
  "resolveExternalBetVerificationFailure",
  'authorization.verificationCode === "transaction-not-found"',
  "transactionVisibilityPending ? 425 : 503",
  "syncFinalizedMarketLifecycleIndex",
  "getMinimumLedgerSlot",
  "commitSolanaIndexedTransaction",
  "parseFinalizedMarketLifecycleTransaction",
  "TAKER_EXECUTION",
  "reconcileSolanaBetLifecycleAccounting",
  "/api/arena/settlements/",
  "loadSolanaWalletBetHistory",
  "settlementLedgerStatus",
  "resolveCurrentSolanaLifecycleAuthority",
  "lifecycleAuthority.lifecycleStatus",
  "lifecycleAuthority.winner",
  "lifecycleAuthority.syncedAt",
  "currentDuelAccountExists",
  "currentMarketAccountExists",
  "marketId: derivedCurrentMarketPda",
  "programId: DUEL_MARKET_PROGRAM_ID.toBase58()",
  "txRef: null",
]) {
  if (!keeperServiceSource.includes(requiredAccountingControl)) {
    fail(
      `keeper service is missing authoritative bet accounting control ${requiredAccountingControl}`,
    );
  }
}
const externalBetVerificationPolicySource = read(
  "packages/hyperbet-solana/keeper/src/externalBetVerificationPolicy.ts",
);
for (const requiredVisibilityControl of [
  "RETRYABLE_FINALIZED_VISIBILITY_FAILURES",
  '"transaction-not-found"',
  '"transaction-query-failed"',
  '"market-account-query-failed"',
  '"indexed-market-query-failed"',
  '"duel-id-query-failed"',
  'input.finality === "pending"',
  "RETRYABLE_FINALIZED_VISIBILITY_FAILURES.has(input.code)",
] as const) {
  if (
    !externalBetVerificationPolicySource.includes(requiredVisibilityControl)
  ) {
    fail(
      `external bet verification policy is missing finalized visibility control ${requiredVisibilityControl}`,
    );
  }
}
const solanaTrackingSource = read(
  "packages/hyperbet-ui/src/lib/solanaPredictionMarketTracking.ts",
);
for (const requiredFinalityRetryControl of [
  "MAX_FINALIZATION_ATTEMPTS",
  "response.status === 425",
  "response.status === 503",
]) {
  if (!solanaTrackingSource.includes(requiredFinalityRetryControl)) {
    fail(
      `Solana tracking client is missing finality retry control ${requiredFinalityRetryControl}`,
    );
  }
}
const solanaRpcProxySource = read(
  "packages/hyperbet-solana/app/scripts/solana-rpc-proxy.mjs",
);
for (const requiredFinalizedVisibilityFaultControl of [
  '"hide_get_transaction_after_forward"',
  "isVerifierLaneRequest(requestUrl)",
  'options.commitment !== "finalized"',
  "hiddenLookupCount: 1",
  'requestedLane: "verifier"',
] as const) {
  if (!solanaRpcProxySource.includes(requiredFinalizedVisibilityFaultControl)) {
    fail(
      `Solana RPC proxy is missing finalized-visibility fault control ${requiredFinalizedVisibilityFaultControl}`,
    );
  }
}
const solanaE2eRunnerSource = read(
  "packages/hyperbet-solana/app/scripts/run-e2e-local.sh",
);
for (const requiredVerifierLaneControl of [
  'SOLANA_VERIFIER_PROXY_URL="${SOLANA_PROXY_URL}/verifier"',
  'SOLANA_RPC_URL "$SOLANA_VERIFIER_PROXY_URL"',
  'SOLANA_RPC_URL="$SOLANA_VERIFIER_PROXY_URL"',
] as const) {
  if (!solanaE2eRunnerSource.includes(requiredVerifierLaneControl)) {
    fail(
      `Solana E2E runner is missing dedicated verifier-lane control ${requiredVerifierLaneControl}`,
    );
  }
}
for (const requiredVisibilityRetryProof of [
  "armFinalizedTransactionVisibilityGap",
  "trackingEvidence.attempts.some",
  'attempt.startsWith("425:")',
  "hiddenLookupCount: 1",
  'requestedCommitment: "finalized"',
  'requestedLane: "verifier"',
] as const) {
  if (!solanaMarketFlowsE2eSource.includes(requiredVisibilityRetryProof)) {
    fail(
      `Solana browser harness is missing finalized-visibility retry proof ${requiredVisibilityRetryProof}`,
    );
  }
}
const solanaAppConfigSource = read(
  "packages/hyperbet-solana/app/src/lib/config.ts",
);
for (const requiredRuntimeUrlControl of [
  "buildSolanaRpcProxyUrl",
  "window.location.origin",
]) {
  if (!solanaAppConfigSource.includes(requiredRuntimeUrlControl)) {
    fail(`Solana app config is missing ${requiredRuntimeUrlControl}`);
  }
}
const sharedStreamingStateSourcePath =
  "packages/hyperbet-ui/src/spectator/useStreamingState.ts";
const sharedStreamingStateSource = read(sharedStreamingStateSourcePath);
if (
  !sharedStreamingStateSource.includes("new URL(sseUrl, sseBaseUrl)") ||
  !sharedStreamingStateSource.includes("window.location.origin")
) {
  fail(`${sharedStreamingStateSourcePath} does not support same-origin SSE`);
}
const appStreamingStateSourcePath =
  "packages/hyperbet-solana/app/src/spectator/useStreamingState.ts";
const appStreamingStateSource = read(appStreamingStateSourcePath);
if (
  !appStreamingStateSource.includes("useSharedStreamingState") ||
  !appStreamingStateSource.includes("apiUrl: CONFIG.gameApiUrl")
) {
  fail(
    `${appStreamingStateSourcePath} does not delegate its runtime API base to the same-origin-capable shared SSE client`,
  );
}
const solanaClobPanelSource = read(
  "packages/hyperbet-ui/src/components/SolanaClobPanel.tsx",
);
const solanaSettlementHistorySource = read(
  "packages/hyperbet-ui/src/components/SolanaSettlementHistory.tsx",
);
const solanaOrderManagementSource = read(
  "packages/hyperbet-ui/src/lib/solanaOrderManagement.ts",
);
const solanaOrderManagementTestSource = read(
  "packages/hyperbet-ui/tests/solanaOrderManagement.test.ts",
);
for (const requiredCanonicalHeadControl of [
  "normalizeSolanaManagedOrderPlanForPriceLevel",
  "Order contains an invalid linked-list reference",
  "Single-order price level does not conserve the selected remainder",
  "Multi-order price level does not conserve the selected remainder",
  "Managed order is not a resting GTC or post-only order",
  "resolveSolanaManagedPriceLevelForClosure",
  "Order amounts must use exact 1,000-unit lots",
  "Price-level total must use exact 1,000-unit lots",
  "Continuation-pending order cannot retain a filled amount",
] as const) {
  if (!solanaOrderManagementSource.includes(requiredCanonicalHeadControl)) {
    fail(
      `Solana managed-order planning is missing canonical-head control ${requiredCanonicalHeadControl}`,
    );
  }
}
for (const invalidOrderIdCoupling of [
  "FIFO order-ID monotonicity",
  "Canonical head contains an invalid stale predecessor",
] as const) {
  if (solanaOrderManagementSource.includes(invalidOrderIdCoupling)) {
    fail(
      `Solana managed-order planning restored invalid queue/order-ID coupling ${invalidOrderIdCoupling}`,
    );
  }
}
for (const requiredNonmonotonicOrderProof of [
  "plans and validates queue links independently of global order IDs",
  "normalizes a newer stale predecessor from an older canonical head",
  "adjacentOrderIds: [9n, 5n]",
  "enforces exact single-order and strict multi-order conservation",
  "rejects nonresting, exhausted, or self-linked adjacent orders",
  "reconstructs only a missing continuation level for atomic closure",
  "rejects noncanonical IDs, order/fill lots, and imprecise remainder states",
] as const) {
  if (
    !solanaOrderManagementTestSource.includes(requiredNonmonotonicOrderProof)
  ) {
    fail(
      `Solana managed-order planning is missing nonmonotonic queue proof ${requiredNonmonotonicOrderProof}`,
    );
  }
}
if (
  !solanaClobPanelSource.includes(
    "normalizeSolanaManagedOrderPlanForPriceLevel({",
  )
) {
  fail(
    "Solana bettor order management does not normalize canonical-head links",
  );
}
if (
  !solanaClobPanelSource.includes("resolveSolanaManagedPriceLevelForClosure({")
) {
  fail(
    "Solana bettor order management does not recover an absent continuation level",
  );
}
for (const requiredEmptyBalanceConsumerControl of [
  "shouldCloseEmptySolanaUserBalance",
  ".closeEmptyUserBalance()",
  'claimKind: "EMPTY_BALANCE_RENT"',
  "balanceRentUnavailable",
] as const) {
  if (
    !solanaOrderManagementSource.includes(
      requiredEmptyBalanceConsumerControl,
    ) &&
    !solanaClobPanelSource.includes(requiredEmptyBalanceConsumerControl)
  ) {
    fail(
      `Solana bettor order management is missing empty-balance cleanup control ${requiredEmptyBalanceConsumerControl}`,
    );
  }
}
for (const requiredHistoricalRentControl of [
  "onRequestBalanceCleanup",
  'entry.orderState === "RELEASED"',
  'entry.settlementState === "NO_ENTITLEMENT"',
  "solana-balance-rent-action-",
] as const) {
  if (!solanaSettlementHistorySource.includes(requiredHistoricalRentControl)) {
    fail(
      `Solana history is missing terminal balance-rent control ${requiredHistoricalRentControl}`,
    );
  }
}
for (const requiredHistoricalSettlementControl of [
  'data-testid="solana-settlement-refresh"',
  "onRequestSettlement={handleHistoricalSettlement}",
  "requestedMarketState.equals(canonicalMarketState)",
  "`${walletAddress}:wallet`",
] as const) {
  if (
    !solanaSettlementHistorySource.includes(
      requiredHistoricalSettlementControl,
    ) &&
    !solanaClobPanelSource.includes(requiredHistoricalSettlementControl) &&
    !read("packages/hyperbet-ui/src/lib/solanaTransactionFeedback.ts").includes(
      requiredHistoricalSettlementControl,
    )
  ) {
    fail(
      `Solana offline settlement path is missing ${requiredHistoricalSettlementControl}`,
    );
  }
}
requireAbsent("packages/hyperbet-ui/src/components/SolanaClobPanel.tsx", [
  prohibitedLegacyBrandPattern,
  /feeBps:\s*0\b/,
]);
for (const requiredTransactionAnalyticsEvent of [
  'emitHyperbetProductEvent("bet_attempt"',
  'emitHyperbetProductEvent("bet_success"',
  'emitHyperbetProductEvent("bet_failure"',
  'emitHyperbetProductEvent("refund_attempt"',
  'emitHyperbetProductEvent("refund_success"',
  'emitHyperbetProductEvent("refund_failure"',
  'emitHyperbetProductEvent("claim_attempt"',
  'emitHyperbetProductEvent("claim_success"',
  'emitHyperbetProductEvent("claim_failure"',
] as const) {
  if (!solanaClobPanelSource.includes(requiredTransactionAnalyticsEvent)) {
    fail(
      `Solana CLOB panel is missing product funnel event ${requiredTransactionAnalyticsEvent}`,
    );
  }
}
const productAnalyticsPath = "packages/hyperbet-ui/src/lib/productAnalytics.ts";
requireAbsent(productAnalyticsPath, [
  /\b(?:wallet|address|signature|duelKey|duelId|marketRef)\b/i,
  /\bfetch\s*\(/,
  /sendBeacon/,
]);
for (const requiredLoserCleanupControl of [
  "resolveSolanaSettlementInstruction",
  ".closeLosingBalance()",
  "clearingPositionContext",
]) {
  if (!solanaClobPanelSource.includes(requiredLoserCleanupControl)) {
    fail(
      `Solana CLOB panel is missing loser cleanup control ${requiredLoserCleanupControl}`,
    );
  }
}
if (solanaClobPanelSource.includes('claimKind !== "LOSER_CLEANUP"')) {
  fail("Solana CLOB panel still suppresses the supported loser cleanup action");
}
for (const requiredOrderQuoteControl of [
  "buildSolanaOrderQuote",
  "parseSolAmountToLamports",
  "tradeTreasuryFeeBpsSnapshot",
  "tradeMarketMakerFeeBpsSnapshot",
  "winningsMarketMakerFeeBpsSnapshot",
  "accountRentReserveLamports",
  "estimatedNetworkFeeLamports",
  "getFeeForMessage",
  "verifyVaultRentExempt",
  "tradeTreasuryFeeLamports",
  "tradeMarketMakerFeeLamports",
  "activeMarket.treasury",
  "activeMarket.marketMaker",
  "orderSubmissionReady",
  "MAX_MATCHES_PER_TX = 50",
]) {
  if (!solanaClobPanelSource.includes(requiredOrderQuoteControl)) {
    fail(
      `Solana CLOB panel is missing pre-signature quote control ${requiredOrderQuoteControl}`,
    );
  }
}
const solanaOrderQuoteSource = read(
  "packages/hyperbet-ui/src/lib/solanaOrderQuote.ts",
);
for (const requiredOrderQuoteInvariant of [
  "SOL amount must use at most 6 decimal places",
  "Combined trade fee exceeds the program cap",
  "fullFillWinningsFeeLamports",
  "refundableExecutionFeeLamports",
  "selfTradePrevented",
  "continuationRequired",
  "outcomePriceToMarketPrice",
]) {
  if (!solanaOrderQuoteSource.includes(requiredOrderQuoteInvariant)) {
    fail(
      `Solana order quote is missing invariant ${requiredOrderQuoteInvariant}`,
    );
  }
}
requireAbsent("packages/hyperbet-ui/src/lib/solanaOrderQuote.ts", [
  /nonRefundableExecutionFeeLamports/,
]);
const marketProgramSource = read(
  "packages/hyperbet-solana/anchor/programs/duel_market/src/lib.rs",
);
const oracleProgramSource = read(
  "packages/hyperbet-solana/anchor/programs/fight_oracle/src/lib.rs",
);
const oracleProgramTestBoundary = oracleProgramSource.indexOf("\n#[cfg(test)]");
if (oracleProgramTestBoundary === -1) {
  fail("Fight oracle source is missing its host-test boundary");
}
const oracleProgramRuntimeSource = oracleProgramSource.slice(
  0,
  oracleProgramTestBoundary,
);
for (const requiredOracleInitializationControl of [
  "validate_uninitialized_oracle_config(oracle_config)?",
  "fn validate_uninitialized_oracle_config(",
  "let is_initialized = classify_duel_initialization(duel_state)?",
  "fn classify_duel_initialization(",
  "duel_state.account_schema_version == ACCOUNT_SCHEMA_VERSION",
  "duel_state.account_schema_version == 0",
  "duel_state.competitive_snapshot_digest == [0_u8; 32]",
] as const) {
  if (
    !oracleProgramRuntimeSource.includes(requiredOracleInitializationControl)
  ) {
    fail(
      `Fight oracle initialization is missing ${requiredOracleInitializationControl}`,
    );
  }
}
for (const requiredOracleProposalIdentityControl of [
  "fn validate_pending_proposal_identity(",
  "fn validate_proposal_record_identity(",
  "fn validate_replay_hash(",
  "replay_hash != [0_u8; 32]",
  "duel_state.pending_result_hash == expected_result_hash",
  "proposal_id_for(",
  "proposal_record.proposed_at == duel_state.pending_proposed_at",
] as const) {
  if (
    !oracleProgramRuntimeSource.includes(requiredOracleProposalIdentityControl)
  ) {
    fail(
      `Fight oracle proposal identity is missing ${requiredOracleProposalIdentityControl}`,
    );
  }
}
const pendingProposalValidationSites =
  oracleProgramRuntimeSource.match(/validate_pending_proposal_identity\(/g)
    ?.length ?? 0;
const proposalRecordValidationSites =
  oracleProgramRuntimeSource.match(/validate_proposal_record_identity\(/g)
    ?.length ?? 0;
if (
  pendingProposalValidationSites !== 4 ||
  proposalRecordValidationSites !== 4
) {
  fail(
    `Fight oracle proposal identity must cover proposal, challenge, reproposal, and finalization; found ${pendingProposalValidationSites} pending and ${proposalRecordValidationSites} record sites`,
  );
}
const replayHashValidationSites =
  oracleProgramRuntimeSource.match(/validate_replay_hash\(/g)?.length ?? 0;
if (replayHashValidationSites !== 4) {
  fail(
    `Fight oracle must reject missing replay identity at proposal, reproposal, and pending validation plus the validator definition; found ${replayHashValidationSites}`,
  );
}
if (
  oracleProgramRuntimeSource.includes(
    "let is_initialized = duel_state.bump != 0",
  )
) {
  fail(
    "Fight oracle restored the invalid nonzero-bump initialization sentinel",
  );
}
if (
  !oracleProgramSource.includes(
    "zero_bump_v2_duel_remains_initialized_and_partial_zero_state_rejects",
  )
) {
  fail("Fight oracle is missing the zero-bump initialization proof");
}
if (
  !oracleProgramSource.includes(
    "oracle_config_initialization_rejects_every_partial_field",
  )
) {
  fail("Fight oracle is missing the partial config initialization proof");
}
if (
  !oracleProgramSource.includes(
    "pending_proposal_identity_rejects_every_terminal_commitment_drift",
  )
) {
  fail("Fight oracle is missing the pending-proposal identity proof");
}
const resultHashSource = read(
  "packages/hyperbet-solana/keeper/src/resultHash.ts",
);
const resultHashTestSource = read(
  "packages/hyperbet-solana/keeper/src/resultHash.test.ts",
);
const terminalLedgerSource = read(
  "packages/hyperbet-solana/keeper/src/terminalLedger.ts",
);
const terminalLedgerTestSource = read(
  "packages/hyperbet-solana/keeper/src/terminalLedger.test.ts",
);
for (const [source, control] of [
  [resultHashSource, 'nonzeroHashBytes(replayHashHex, "replay hash")'],
  [
    resultHashSource,
    "nonzeroHashBytes(\n          competitiveSnapshotDigestHex",
  ],
  [terminalLedgerSource, 'replayHash === "0".repeat(64)'],
  [resultHashTestSource, 'replayHash: "00".repeat(32)'],
  [
    terminalLedgerTestSource,
    "rejects an absent all-zero winning replay commitment",
  ],
] as const) {
  if (!source.includes(control)) {
    fail(`SOL replay commitment is missing ${control}`);
  }
}
const marketProgramTestBoundary = marketProgramSource.indexOf("\n#[cfg(test)]");
if (marketProgramTestBoundary < 0) {
  fail("Solana market program is missing its host-test boundary");
}
const marketProgramRuntimeSource = marketProgramSource.slice(
  0,
  marketProgramTestBoundary,
);
const fixedAccountCardinalitySites =
  marketProgramRuntimeSource.match(
    /validate_fixed_account_cardinality\(ctx\.remaining_accounts\.len\(\)\)\?;/g,
  )?.length ?? 0;
if (
  fixedAccountCardinalitySites !== 15 ||
  !marketProgramRuntimeSource.includes(
    "fn validate_fixed_account_cardinality(remaining_account_count: usize)",
  ) ||
  !marketProgramSource.includes(
    "fixed_account_instructions_reject_every_remaining_account",
  )
) {
  fail(
    `Duel-market fixed-account cardinality must cover all 15 fixed-account execution paths; found ${fixedAccountCardinalitySites}`,
  );
}
for (const requiredOnChainCleanupControl of [
  "pub fn close_losing_balance",
  "validate_losing_balance_cleanup",
  "WinningBalanceCannotBeClosed",
  "LosingBalanceClosed",
  ".user_balance",
  ".close(ctx.accounts.user.to_account_info())",
]) {
  if (!marketProgramSource.includes(requiredOnChainCleanupControl)) {
    fail(
      `Solana market program is missing loser cleanup control ${requiredOnChainCleanupControl}`,
    );
  }
}
for (const requiredEmptyBalanceControl of [
  "pub fn close_empty_user_balance",
  "validate_empty_user_balance",
  "UserBalanceNotEmpty",
  "EmptyUserBalanceClosed",
  "empty_user_balance_cleanup_rejects_every_single_custody_field",
] as const) {
  if (!marketProgramSource.includes(requiredEmptyBalanceControl)) {
    fail(
      `Solana market program is missing empty user-balance cleanup control ${requiredEmptyBalanceControl}`,
    );
  }
}
for (const requiredFeeEscrowControl of [
  "escrow_trade_fees",
  "trade_treasury_fee_lamports",
  "trade_market_maker_fee_lamports",
  "accrued_trade_treasury_fee_lamports",
  "accrued_trade_market_maker_fee_lamports",
  "pub fn withdraw_resolved_trade_fees",
  "ResolvedTradeFeesWithdrawn",
  "TradeFeesEscrowed",
  "ClaimSettled",
  "FeeEscrowInvariantViolation",
]) {
  if (!marketProgramSource.includes(requiredFeeEscrowControl)) {
    fail(
      `Solana market program is missing cancellation-safe fee escrow control ${requiredFeeEscrowControl}`,
    );
  }
}
for (const requiredFeeCapControl of [
  "let combined_trade_fee_bps = u32::from(trade_treasury_fee_bps)",
  ".checked_add(u32::from(trade_market_maker_fee_bps))",
  "fee_config_rejects_u16_overflow_vectors_and_excess_winnings_fee",
] as const) {
  if (!marketProgramSource.includes(requiredFeeCapControl)) {
    fail(
      `Solana market program is missing overflow-safe fee-cap control ${requiredFeeCapControl}`,
    );
  }
}
for (const requiredMonetaryProperty of [
  "quote_cost_conserves_collateral_across_the_full_price_grid",
  "quote_cost_rejects_zero_cost_and_precision_boundaries",
  "quote_cost_conserves_the_largest_valid_u64_lot",
  "bps_fee_matches_floor_math_and_conserves_every_safe_payout",
  "bps_fee_supports_the_full_u64_amount_domain",
] as const) {
  if (!marketProgramSource.includes(requiredMonetaryProperty)) {
    fail(
      `Solana market program is missing monetary property proof ${requiredMonetaryProperty}`,
    );
  }
}
const matchOutcomeConservationSites =
  marketProgramRuntimeSource.match(/validate_match_outcome_conservation\(/g)
    ?.length ?? 0;
if (matchOutcomeConservationSites !== 3) {
  fail(
    `Solana market program must validate taker collateral after placement and continuation plus the validator definition; found ${matchOutcomeConservationSites}`,
  );
}
for (const requiredMatchOutcomeControl of [
  "outcome.remaining_amount <= input_amount",
  "outcome.remaining_amount % 1000 == 0",
  "outcome.executed_cost == 0 && outcome.total_improvement == 0",
  "accounted_cost == initial_cost",
  "MatchStopReason::SelfTradePrevented",
] as const) {
  if (!marketProgramRuntimeSource.includes(requiredMatchOutcomeControl)) {
    fail(
      `Solana match outcome is missing collateral control ${requiredMatchOutcomeControl}`,
    );
  }
}
for (const requiredMatchOutcomeProof of [
  "match_outcome_conserves_taker_collateral_across_full_price_grid",
  "match_outcome_rejects_every_collateral_or_stop_state_mutation",
  "assert_eq!(verified, 999_000)",
] as const) {
  if (!marketProgramSource.includes(requiredMatchOutcomeProof)) {
    fail(
      `Solana match outcome is missing collateral proof ${requiredMatchOutcomeProof}`,
    );
  }
}
for (const requiredTerminalIdentityControl of [
  "validate_market_identity(",
  "Pubkey::find_program_address(",
  "market_bump == expected_bump",
  "vault_bump == expected_vault_bump",
  "validate_duel_sync_identity(",
  "market_duel_key == duel_key",
  "fight_oracle::DUEL_SEED",
  "duel_bump == expected_duel_bump",
  "account_schema_version == fight_oracle::ACCOUNT_SCHEMA_VERSION",
  "duel_winner == MarketSide::A || duel_winner == MarketSide::B",
  "market_state.winner = if duel_state.status == OracleDuelStatus::Resolved",
  "validate_user_balance_identity(user_balance, market_key, ctx.accounts.user.key())?",
  "validate_fee_recipient_not_vault(",
  "validate_market_fee_configuration(",
  "if trade_treasury_fee_bps > 0",
  "if trade_market_maker_fee_bps > 0 || winnings_market_maker_fee_bps > 0",
  "if treasury_fee_lamports > 0",
  "if market_maker_fee_lamports > 0",
] as const) {
  if (!marketProgramRuntimeSource.includes(requiredTerminalIdentityControl)) {
    fail(
      `Solana terminal identity is missing ${requiredTerminalIdentityControl}`,
    );
  }
}
for (const requiredTerminalIdentityProof of [
  "market_sync_requires_the_canonical_market_pda_kind_and_bump",
  "positive_fee_configuration_rejects_the_market_vault_recipient",
  "terminal_identity_and_fee_recipient_boundaries_fail_closed",
  "duel_sync_requires_exact_identity_and_canonical_terminal_winner",
] as const) {
  if (!marketProgramSource.includes(requiredTerminalIdentityProof)) {
    fail(
      `Solana terminal identity proof is missing ${requiredTerminalIdentityProof}`,
    );
  }
}
const initializeMarketRuntimeStart = marketProgramRuntimeSource.indexOf(
  "pub fn initialize_market(",
);
const initializeMarketRuntimeEnd = marketProgramRuntimeSource.indexOf(
  "pub fn sync_market_from_duel(",
  initializeMarketRuntimeStart,
);
const escrowTradeFeesRuntimeStart = marketProgramRuntimeSource.indexOf(
  "fn escrow_trade_fees<",
);
const escrowTradeFeesRuntimeEnd = marketProgramRuntimeSource.indexOf(
  "fn validate_match_outcome_conservation(",
  escrowTradeFeesRuntimeStart,
);
if (
  initializeMarketRuntimeStart === -1 ||
  initializeMarketRuntimeEnd === -1 ||
  !marketProgramRuntimeSource
    .slice(initializeMarketRuntimeStart, initializeMarketRuntimeEnd)
    .includes("validate_market_fee_configuration(")
) {
  fail("Solana market creation does not reject an unpayable fee snapshot");
}
if (
  escrowTradeFeesRuntimeStart === -1 ||
  escrowTradeFeesRuntimeEnd === -1 ||
  !marketProgramRuntimeSource
    .slice(escrowTradeFeesRuntimeStart, escrowTradeFeesRuntimeEnd)
    .includes("validate_market_fee_configuration(")
) {
  fail("Solana fee escrow does not revalidate its snapshotted destinations");
}
const claimAccountsStart = marketProgramSource.indexOf(
  "pub struct Claim<'info>",
);
const claimAccountsEnd = marketProgramSource.indexOf(
  "pub struct CloseLosingBalance<'info>",
  claimAccountsStart + 1,
);
if (claimAccountsStart < 0 || claimAccountsEnd <= claimAccountsStart) {
  fail("Solana claim account graph could not be isolated");
}
const claimAccountsSource = marketProgramSource.slice(
  Math.max(0, claimAccountsStart),
  Math.max(0, claimAccountsEnd),
);
for (const requiredClaimIdentityConstraint of [
  "constraint = user_balance.user == user.key() @ ErrorCode::InvalidUserBalance",
  "constraint = user_balance.market_state == market_state.key() @ ErrorCode::InvalidUserBalance",
] as const) {
  if (!claimAccountsSource.includes(requiredClaimIdentityConstraint)) {
    fail(
      `Solana claim account graph is missing ${requiredClaimIdentityConstraint}`,
    );
  }
}
for (const requiredBookLinkControl of [
  "validate_unlink_graph",
  "validate_linked_order",
  "unlink_graph_accepts_reciprocal_head_middle_and_tail_links",
  "unlink_graph_accepts_a_lazily_normalized_canonical_head",
  "unlink_graph_generated_single_mutation_matrix_rejects_every_fault",
  "unlink_graph_rejects_nonreciprocal_or_wrong_level_neighbors",
  "unlink_graph_rejects_boundary_and_active_state_corruption",
  "unlinking_canonical_head",
] as const) {
  if (!marketProgramSource.includes(requiredBookLinkControl)) {
    fail(
      `Solana market program is missing reciprocal book-link control ${requiredBookLinkControl}`,
    );
  }
}
for (const requiredMatchBookInvariant of [
  "MatchLevelState",
  "validate_match_level_state(&level)?",
  "has_open && has_head && has_tail",
  "validate_match_head(&level, &maker_order)?",
  "validate_match_balance(",
  "derive_balance_key",
  "level.total_open == remaining",
  "level.total_open > remaining",
] as const) {
  if (!marketProgramRuntimeSource.includes(requiredMatchBookInvariant)) {
    fail(
      `Solana market matcher is missing fail-closed book invariant ${requiredMatchBookInvariant}`,
    );
  }
}
const executeMatchesStart = marketProgramRuntimeSource.indexOf(
  "fn execute_matches<'info>(",
);
const executeMatchesEnd = marketProgramRuntimeSource.indexOf(
  "fn derive_order_key(",
  executeMatchesStart,
);
if (executeMatchesStart < 0 || executeMatchesEnd <= executeMatchesStart) {
  fail("Solana market matcher runtime boundary could not be isolated");
} else {
  const executeMatchesSource = marketProgramRuntimeSource.slice(
    executeMatchesStart,
    executeMatchesEnd,
  );
  if (executeMatchesSource.includes("level.total_open == 0 ||")) {
    fail(
      "Solana market matcher restored destructive partial-empty level healing",
    );
  }
  if (
    !executeMatchesSource.includes("maker_balance_info.key()") ||
    !executeMatchesSource.includes("MatchLevelState::Empty")
  ) {
    fail(
      "Solana market matcher does not bind the exact maker balance and exact-empty healing path",
    );
  }
}
for (const requiredMatchBookProof of [
  "match_level_state_accepts_only_exact_empty_or_exact_active_shapes",
  "match_head_requires_exact_single_or_multi_order_conservation",
  "match_head_generated_mutations_reject_every_orphaning_shape",
  "match_balance_requires_the_exact_maker_pda_and_identity",
] as const) {
  if (!marketProgramSource.includes(requiredMatchBookProof)) {
    fail(
      `Solana market matcher is missing book-invariant proof ${requiredMatchBookProof}`,
    );
  }
}
const userBalancePreparationSites =
  marketProgramRuntimeSource.match(/prepare_user_balance\(/g)?.length ?? 0;
if (userBalancePreparationSites !== 2) {
  fail(
    `Solana market program must prepare user balance at placement plus the helper definition; found ${userBalancePreparationSites}`,
  );
}
for (const requiredInitializationControl of [
  "validate_uninitialized_market_config(config)?",
  "fn validate_uninitialized_market_config(",
  "user_balance.user == Pubkey::default()",
  "user_balance.market_state == Pubkey::default()",
  "user_balance.trade_market_maker_fee_lamports == 0",
  "level.rent_recipient == Pubkey::default()",
  "level.head_order_id == 0",
  "level.tail_order_id == 0",
  "level.total_open == 0",
  "validate_match_level_state(level)?",
] as const) {
  if (!marketProgramRuntimeSource.includes(requiredInitializationControl)) {
    fail(
      `Solana account initialization is missing fail-closed control ${requiredInitializationControl}`,
    );
  }
}
const placeOrderStart = marketProgramRuntimeSource.indexOf(
  "pub fn place_order<'info>(",
);
const placeOrderEnd = marketProgramRuntimeSource.indexOf(
  "pub fn continue_order<'info>(",
  placeOrderStart,
);
if (placeOrderStart < 0 || placeOrderEnd <= placeOrderStart) {
  fail("Solana place-order runtime boundary could not be isolated");
} else {
  const placeOrderSource = marketProgramRuntimeSource.slice(
    placeOrderStart,
    placeOrderEnd,
  );
  if (
    !placeOrderSource.includes("prepare_user_balance(") ||
    placeOrderSource.includes("user_balance.user =") ||
    placeOrderSource.includes("user_balance.market_state =")
  ) {
    fail(
      "Solana place-order restored destructive user-balance identity overwrite",
    );
  }
}
for (const requiredInitializationProof of [
  "market_config_initialization_rejects_every_partial_field",
  "price_level_initialization_rejects_partial_identity_or_book_state",
  "user_balance_initialization_rejects_partial_identity_or_custody",
] as const) {
  if (!marketProgramSource.includes(requiredInitializationProof)) {
    fail(
      `Solana account initialization is missing host proof ${requiredInitializationProof}`,
    );
  }
}
const continuationPendingValidationSites =
  marketProgramRuntimeSource.match(/validate_continuation_pending_order\(/g)
    ?.length ?? 0;
if (continuationPendingValidationSites !== 4) {
  fail(
    `Solana market program must validate pending orders at continuation, cancellation, and reclaim plus the validator definition; found ${continuationPendingValidationSites}`,
  );
}
for (const requiredCanonicalLotControl of [
  "fn validate_continuation_pending_order(order: &Order, market_key: Pubkey)",
  "order.amount > 0 && order.amount % 1000 == 0 && order.filled == 0",
  "level.total_open % 1000 == 0",
  "order.amount % 1000 == 0 && order.filled % 1000 == 0",
] as const) {
  if (!marketProgramRuntimeSource.includes(requiredCanonicalLotControl)) {
    fail(
      `Solana order state is missing canonical lot/identity control ${requiredCanonicalLotControl}`,
    );
  }
}
const optionalPendingLevelCloseSites =
  marketProgramRuntimeSource.match(/close_pending_price_level_if_present\(/g)
    ?.length ?? 0;
if (optionalPendingLevelCloseSites !== 2) {
  fail(
    `Solana market program must handle an optional pending-order level at cancellation and reclaim; found ${optionalPendingLevelCloseSites}`,
  );
}
for (const [instructionName, nextInstructionName] of [
  ["pub fn cancel_order<'info>(", "pub fn close_filled_order("],
  ["pub fn reclaim_resting_order<'info>(", "pub fn claim("],
] as const) {
  const instructionStart = marketProgramRuntimeSource.indexOf(instructionName);
  const instructionEnd = marketProgramRuntimeSource.indexOf(
    nextInstructionName,
    instructionStart,
  );
  const instructionSource = marketProgramRuntimeSource.slice(
    instructionStart,
    instructionEnd,
  );
  const finalVaultTransfer = instructionSource.lastIndexOf(
    "transfer_from_vault(",
  );
  const pendingLevelClose = instructionSource.indexOf(
    "close_pending_price_level_if_present(",
  );
  if (
    instructionStart < 0 ||
    instructionEnd <= instructionStart ||
    finalVaultTransfer < 0 ||
    pendingLevelClose <= finalVaultTransfer
  ) {
    fail(
      `Solana ${instructionName} must close an optional pending level only after its final collateral CPI`,
    );
  }
}
for (const requiredOptionalPendingLevelControl of [
  "fn load_existing_price_level(",
  "fn close_pending_price_level_if_present<'info>(",
  "level_info.owner == &system_program::ID",
  "level_info.lamports() == 0",
  "level_info.data_is_empty()",
  "level_info.data_len() == 8 + PriceLevel::INIT_SPACE",
  "level.bump == bump",
  "level_info.key() != recipient_info.key()",
  "pub price_level: UncheckedAccount<'info>",
] as const) {
  if (
    !marketProgramRuntimeSource.includes(requiredOptionalPendingLevelControl)
  ) {
    fail(
      `Solana pending-order closure is missing optional-level control ${requiredOptionalPendingLevelControl}`,
    );
  }
}
for (const [accountName, nextAccountName] of [
  ["pub struct CancelOrder<'info>", "pub struct CloseFilledOrder<'info>"],
  ["pub struct ReclaimRestingOrder<'info>", "pub struct Claim<'info>"],
] as const) {
  const accountStart = marketProgramRuntimeSource.indexOf(accountName);
  const accountEnd = marketProgramRuntimeSource.indexOf(
    nextAccountName,
    accountStart,
  );
  if (accountStart < 0 || accountEnd <= accountStart) {
    fail(`Solana optional-level account boundary is missing ${accountName}`);
    continue;
  }
  const accountSource = marketProgramRuntimeSource.slice(
    accountStart,
    accountEnd,
  );
  if (
    !accountSource.includes("pub price_level: UncheckedAccount<'info>") ||
    !accountSource.includes("seeds = [LEVEL_SEED") ||
    !accountSource.includes("bump,") ||
    accountSource.includes("init_if_needed") ||
    accountSource.includes("payer = user")
  ) {
    fail(
      `Solana ${accountName} must accept the exact absent PDA without recreating it or charging temporary rent`,
    );
  }
}
for (const requiredUnlinkConservationControl of [
  "validate_unlink_conservation(price_level, order, remaining)?",
  "let resulting_level_state = validate_match_level_state(price_level)?",
  "resulting_level_state == MatchLevelState::Empty",
  "price_level.total_open == remaining",
  "price_level.total_open > remaining",
  "order.amount > order.filled",
  "order.prev_order_id != order.id && order.next_order_id != order.id",
  "replacement_tail_after_unlink(unlinking_canonical_head, order.prev_order_id)",
] as const) {
  if (!marketProgramRuntimeSource.includes(requiredUnlinkConservationControl)) {
    fail(
      `Solana order unlink is missing conservation control ${requiredUnlinkConservationControl}`,
    );
  }
}
const unlinkOrderStart = marketProgramRuntimeSource.indexOf("fn unlink_order(");
const unlinkOrderEnd = marketProgramRuntimeSource.indexOf(
  "fn validate_unlink_graph(",
  unlinkOrderStart,
);
if (unlinkOrderStart < 0 || unlinkOrderEnd <= unlinkOrderStart) {
  fail("Solana order-unlink runtime boundary could not be isolated");
} else {
  const unlinkOrderSource = marketProgramRuntimeSource.slice(
    unlinkOrderStart,
    unlinkOrderEnd,
  );
  if (unlinkOrderSource.includes("price_level.tail_order_id = 0")) {
    fail("Solana order unlink restored destructive tail zeroing");
  }
}
for (const requiredUnlinkConservationProof of [
  "unlink_conservation_accepts_only_exact_single_or_multi_remainders",
  "unlink_conservation_generated_mutations_reject_every_orphaning_shape",
  "continuation_pending_orders_must_be_live_unlinked_gtc_remainders",
  "linked_orders_reject_nonresting_zero_remainder_or_self_links",
  "optional_pending_price_level_absence_never_requires_rent",
  "optional_price_level_manual_persistence_and_close_conserve_lamports",
  "last_canonical_head_unlink_discards_only_its_stale_predecessor",
] as const) {
  if (!marketProgramSource.includes(requiredUnlinkConservationProof)) {
    fail(
      `Solana order unlink is missing conservation proof ${requiredUnlinkConservationProof}`,
    );
  }
}
const runtimeAppendTailValidationSites =
  marketProgramRuntimeSource.match(/validate_append_tail\(/g)?.length ?? 0;
if (runtimeAppendTailValidationSites !== 5) {
  fail(
    `Solana market program must validate all four resting-tail append paths plus the validator definition; found ${runtimeAppendTailValidationSites}`,
  );
}
for (const requiredAppendTailInvariant of [
  "tail.id == price_level.tail_order_id",
  "tail.id != new_order_id",
  "tail.next_order_id == 0",
  "tail.amount > tail.filled",
] as const) {
  if (!marketProgramRuntimeSource.includes(requiredAppendTailInvariant)) {
    fail(
      `Solana market program is missing append-tail invariant ${requiredAppendTailInvariant}`,
    );
  }
}
for (const invalidQueueIdAssumption of [
  "order.prev_order_id < order.id",
  "order.next_order_id > order.id",
] as const) {
  if (marketProgramRuntimeSource.includes(invalidQueueIdAssumption)) {
    fail(
      `Solana market program restored invalid queue/order-ID coupling ${invalidQueueIdAssumption}`,
    );
  }
}
for (const requiredBookBoundaryProperty of [
  "price_bitmap_round_trips_every_valid_price_on_both_sides",
  "price_bitmap_generated_mutations_match_independent_boundaries",
  "crossing_predicate_matches_the_full_valid_price_grid",
  "continued_order_can_append_and_unlink_after_newer_order_ids",
  "unlink_graph_accepts_generated_nonmonotonic_queue_ids",
  "append_tail_rejects_inconsistent_or_cyclic_book_state",
] as const) {
  if (!marketProgramSource.includes(requiredBookBoundaryProperty)) {
    fail(
      `Solana market program is missing price-boundary property proof ${requiredBookBoundaryProperty}`,
    );
  }
}
if (
  !duelMarketAnchorTestSource.includes(
    "rejects combined fee-cap overflow vectors without mutating config",
  )
) {
  fail("Anchor launch tests are missing the on-chain fee-cap overflow proof");
}
for (const requiredGeneratedInstructionProof of [
  "returns unmatched user-balance rent after matching stops without allowing active-book poisoning",
  "conserves custody and FIFO links through a seeded multi-instruction state machine",
  "conserves custody while traversing multiple prices across GTC, IOC, and post-only behavior",
  "conserves a generated mixed-price GTC/IOC/post-only lifecycle",
  "generated mixed-behavior vault liability drift",
  "generated terminal refunds did not restore the vault baseline",
  "boundaryMutationCases",
  "multi-price boundary mutation did not roll back atomically",
  "three matched ask liabilities, improved bid fills, one resting bid, and both fee escrows must reconcile",
  "wrong-boundary account rejection must roll back every custody and account mutation",
  "IOC must retain only the 250-lamport fill plus two 2-lamport fees while refunding its remainder and improvement",
  "terminal refunds must restore the exact native-vault baseline",
  "generated state machine failed for",
  'trace=${actionTrace.join(" -> ")}',
  "generated sequence never cancelled the head",
  "generated sequence never cancelled a middle order",
  "generated sequence never cancelled the tail",
  "expectedVaultLiability",
  "generated final cleanup",
] as const) {
  if (!duelMarketAnchorTestSource.includes(requiredGeneratedInstructionProof)) {
    fail(
      `Anchor launch tests are missing generated instruction proof ${requiredGeneratedInstructionProof}`,
    );
  }
}
const generatedStateMachineCorpus = JSON.parse(
  generatedStateMachineCorpusSource,
) as {
  schemaVersion?: unknown;
  randomWordCount?: unknown;
  cases?: Array<Record<string, unknown>>;
};
if (
  generatedStateMachineCorpus.schemaVersion !== 1 ||
  generatedStateMachineCorpus.randomWordCount !== 256 ||
  !Array.isArray(generatedStateMachineCorpus.cases)
) {
  fail(`${generatedStateMachineCorpusPath} is not the canonical v1 corpus`);
}
const requiredGeneratedSeeds = new Map([
  ["hype", "0x48595045"],
  ["sol1", "0x534f4c31"],
  ["golden-ratio", "0x3c6ef373"],
  ["orbit", "0x4f524249"],
  ["order-book", "0x424f4f4b"],
  ["matching-tick", "0x5449434b"],
]);
for (const [id, seed] of requiredGeneratedSeeds) {
  const entry = generatedStateMachineCorpus.cases.find(
    (candidate) => candidate.id === id,
  );
  if (
    entry?.kind !== "seed" ||
    entry.seed !== seed ||
    entry.openActionCount !== 32 ||
    entry.enforceCoverage !== true
  ) {
    fail(
      `${generatedStateMachineCorpusPath} is missing canonical seed ${id}=${seed}`,
    );
  }
}
for (const requiredGeneralizedProof of [
  "conserves arbitrary mixed-price GTC/IOC/post-only ordering",
  "generalized vault liability drift",
  "generalized crossing post-only order succeeded",
  "generalized sequence never crossed multiple price levels",
  "generalized terminal cleanup did not restore the vault baseline",
  "Automatic generalized-sequence reduction",
  "delta-reduces an injected failure through real generalized mixed-price transactions without mutating its corpus",
  "duel-market-generalized-corpus.json",
] as const) {
  if (!generalizedStateMachineTestSource.includes(requiredGeneralizedProof)) {
    fail(
      `${generalizedStateMachineTestPath} is missing ${requiredGeneralizedProof}`,
    );
  }
}
const generalizedStateMachineCorpus = JSON.parse(
  generalizedStateMachineCorpusSource,
) as {
  schemaVersion?: unknown;
  randomWordCount?: unknown;
  cases?: Array<Record<string, unknown>>;
};
if (
  generalizedStateMachineCorpus.schemaVersion !== 1 ||
  generalizedStateMachineCorpus.randomWordCount !== 256 ||
  !Array.isArray(generalizedStateMachineCorpus.cases)
) {
  fail(`${generalizedStateMachineCorpusPath} is not the canonical v1 corpus`);
}
const requiredGeneralizedSeeds = new Map([
  ["hype-mixed", "0x48595045"],
  ["golden-ratio-mixed", "0x3c6ef373"],
  ["order-book-mixed", "0x424f4f4b"],
  ["matching-tick-mixed", "0x5449434b"],
]);
for (const [id, seed] of requiredGeneralizedSeeds) {
  const entry = generalizedStateMachineCorpus.cases.find(
    (candidate) => candidate.id === id,
  );
  if (
    entry?.kind !== "seed" ||
    entry.seed !== seed ||
    entry.openActionCount !== 32 ||
    entry.enforceCoverage !== true
  ) {
    fail(
      `${generalizedStateMachineCorpusPath} is missing canonical seed ${id}=${seed}`,
    );
  }
}
for (const requiredContinuationProof of [
  "continues atomically across three prices after the 50-match bound and closes every liability",
  "malformed multi-price continuation did not roll back atomically",
  "continued fills, 5,000-unit resting remainder, and floor fees must reconcile exactly",
  "terminal multi-price continuation refunds did not restore the vault baseline",
  "continues twice across 105 makers before preserving same-side FIFO append and cleanup",
  "first 50 of 105 fills must reconcile exact maker, taker, and fee liabilities",
  "second 50-fill continuation must preserve the exact pending remainder liability",
  "third continuation, canonical same-side head, and cumulative floor fees must reconcile exactly",
  "same-price follower append must retain exact FIFO and vault liability",
  "repeated continuation and same-side FIFO refunds did not restore the vault baseline",
  "A pre-existing bid at 800 cannot coexist with asks at or below 800",
  "reclaims an older continued order appended behind a newer resting order",
  "interleaved continuation must retain exact matched, resting, and fee liabilities",
  "nonmonotonic queue IDs did not reclaim and refund every lamport",
  "reclaims a continuation-pending order after its empty price-level PDA is closed",
  "the pending order's unused same-side level must be genuinely absent",
  "reclaim must not recreate or require temporary rent for an absent level",
  "missing-level recovery and cancellation must return every vault lamport",
  "59_700n",
  "59_524n",
  "124_260n",
  "110_780n",
  "109_840n",
  "111_440n",
  "58_212n",
] as const) {
  if (!multiPriceContinuationTestSource.includes(requiredContinuationProof)) {
    fail(
      `${multiPriceContinuationTestPath} is missing ${requiredContinuationProof}`,
    );
  }
}
for (const requiredContinuationTransportProof of [
  "export async function continueClobOrder",
  "sendVersionedTransactionWithLookupTable",
  "uniqueAccountCount > 32 || instruction.keys.length > 64",
] as const) {
  if (!clobTestHelpersSource.includes(requiredContinuationTransportProof)) {
    fail(
      `${clobTestHelpersPath} is missing ${requiredContinuationTransportProof}`,
    );
  }
}
for (const requiredShrinkControl of [
  "delta-reduces an injected failure through real generated market transactions without mutating the corpus",
  "HYPERBET_GENERATED_SHRINK_ON_FAILURE",
  "HYPERBET_GENERATED_SHRINK_MAX_ATTEMPTS",
  "HYPERBET_GENERATED_SHRINK_TIME_BUDGET_MS",
  "assumeOriginalReproduces: true",
  "promote:generated-state-machine",
] as const) {
  const combinedGeneratedSources = `${duelMarketAnchorTestSource}\n${read(
    "packages/hyperbet-solana/anchor/package.json",
  )}`;
  if (!combinedGeneratedSources.includes(requiredShrinkControl)) {
    fail(`generated state-machine harness is missing ${requiredShrinkControl}`);
  }
}
for (const requiredReplayControl of [
  "stableFailureFingerprint",
  "shrinkFailingSequence",
  "minimumItems",
  "assumeOriginalReproduces",
  "parseGeneratedFailureArtifact",
  "promoteGeneratedFailure",
] as const) {
  if (!generatedStateMachineReplaySource.includes(requiredReplayControl)) {
    fail(`generated replay library is missing ${requiredReplayControl}`);
  }
}
for (const requiredPromotionControl of [
  "parseGeneratedFailureArtifact",
  "promoteGeneratedFailure",
  'flag: "wx"',
  "fs.renameSync",
] as const) {
  if (
    !generatedStateMachinePromotionSource.includes(requiredPromotionControl)
  ) {
    fail(`generated replay promotion is missing ${requiredPromotionControl}`);
  }
}
const solanaBuildSource = read(
  "packages/hyperbet-solana/anchor/scripts/build-workspace.sh",
);
for (const requiredBuildIntegrityControl of [
  "refusing to reuse stale deploy binaries",
  "HYPERBET_SOLANA_ALLOW_IDL_ONLY",
  'ANCHOR_CLI_VERSION="0.32.1"',
  "host-only fallback is disabled",
  "explicit canonical IDL-only mode enabled",
  'anchor build --no-idl -- --tools-version "${TOOLS_VERSION}" -- --locked',
  "cargo_build_sbf=warn",
  "audit-sbf-build-log.ts",
]) {
  if (!solanaBuildSource.includes(requiredBuildIntegrityControl)) {
    fail(
      `Solana program build is missing integrity control ${requiredBuildIntegrityControl}`,
    );
  }
}
if (
  existsSync(
    join(
      root,
      "packages/hyperbet-solana/anchor/scripts/generate-anchor-types.mjs",
    ),
  )
) {
  fail("Solana build still exposes a non-Anchor TypeScript IDL generator");
}
for (const forbiddenBuildFallback of [
  /generate_idl\s*\(/,
  /__anchor_private_print_idl_/,
]) {
  if (forbiddenBuildFallback.test(solanaBuildSource)) {
    fail(
      `Solana program build still contains unsafe host IDL fallback ${forbiddenBuildFallback}`,
    );
  }
}
if (
  !existsSync(
    join(root, "packages/hyperbet-solana/tests/build-workspace-policy.test.ts"),
  )
) {
  fail("Solana build fail-closed policy test is missing");
}
if (
  !existsSync(
    join(
      root,
      "packages/hyperbet-solana/anchor/scripts/audit-sbf-build-log.ts",
    ),
  )
) {
  fail("Solana SBF warning classifier is missing");
}
const solanaLocalnetTestSource = read(
  "packages/hyperbet-solana/anchor/scripts/run-localnet-tests.sh",
);
for (const requiredLocalnetHarnessControl of [
  "SOLANA_ACTIVE_RELEASE_BIN",
  "TS_MOCHA_COMMAND",
  'bunx "ts-mocha@10.0.0"',
  'bash "$ROOT_DIR/scripts/build-workspace.sh"',
]) {
  if (!solanaLocalnetTestSource.includes(requiredLocalnetHarnessControl)) {
    fail(
      `Solana localnet test harness is missing tool resolution ${requiredLocalnetHarnessControl}`,
    );
  }
}
if (/^\s*anchor build/m.test(solanaLocalnetTestSource)) {
  fail("Solana localnet harness bypasses the canonical pinned build script");
}
const scenarioGateSource = read("scripts/ci-gate-scenarios.ts");
for (const requiredScenarioIntegrityControl of [
  "unsupported SOL-only scenario argument",
  "Always rebuild before a Solana scenario run",
  "stale .so",
  "runSolanaProofScenario",
  "startSolanaValidator",
  '"duel_market.so"',
]) {
  if (!scenarioGateSource.includes(requiredScenarioIntegrityControl)) {
    fail(
      `Solana scenario gate is missing integrity control ${requiredScenarioIntegrityControl}`,
    );
  }
}
for (const solanaGatePath of [
  "scripts/ci-gate-scenarios.ts",
  "scripts/ci-gate-e2e.ts",
]) {
  requireAbsent(solanaGatePath, [
    /packages\/(?:evm-contracts|hyperbet-(?:bsc|avax|evm))/i,
    /\b(?:AVAX|Avalanche|BSC|Base Sepolia|EVM|anvil|foundry)\b/i,
    /gold[_-]?(?:mint|clob|perps|amm)/i,
    /E2E_SOLANA_V1_ONLY/,
    /simulation-dashboard\/src\/scenario-catalog\.ts/,
  ]);
}
const solanaProofScenarioSource = read(
  "packages/simulation-dashboard/src/backends/solana/proof-scenarios.ts",
);
for (const requiredCleanupProof of [
  "WinningBalanceCannotBeClosed",
  "winnerCleanupRejected",
  "repeatCleanupRejected",
  "innerSystemTransfers === 0",
  "vaultAfter === losingCleanupRecord.vaultBefore",
  "Loser cleanup transaction unexpectedly included the vault",
]) {
  if (!solanaProofScenarioSource.includes(requiredCleanupProof)) {
    fail(
      `Solana validator proof is missing loser cleanup assertion ${requiredCleanupProof}`,
    );
  }
}
for (const directScenarioPath of [
  "packages/simulation-dashboard/src/backends/solana/normalize.ts",
  "packages/simulation-dashboard/src/backends/solana/proof-scenarios.ts",
  "packages/simulation-dashboard/src/backends/solana/types.ts",
  "packages/simulation-dashboard/src/scenario-evaluator.ts",
  "packages/simulation-dashboard/src/solana-scenario-catalog.ts",
  "packages/simulation-dashboard/src/solana-scenario-types.ts",
]) {
  requireAbsent(directScenarioPath, [
    /@hyperbet\/mm-core/,
    /(?:^|[/_-])(?:evm|avax|bsc|anvil)(?:[/_.-]|$)/im,
  ]);
}
const betAccountingSource = read(
  "packages/hyperbet-solana/keeper/src/solanaBetAccounting.ts",
);
for (const requiredAccountingInvariant of [
  "exactPrimarySolanaTransactionSignature",
  "exactSolanaTransactionSignatures",
  "exactly one order-placed event",
  "hasOnlyAllowedNativeTransferEdges",
  "unexplained native transfer",
  "trade-fee escrow event does not match executed fill value",
  "GTC order released units without self-trade evidence",
  "rewardEligibleLamports",
]) {
  if (!betAccountingSource.includes(requiredAccountingInvariant)) {
    fail(
      `keeper bet accounting is missing invariant ${requiredAccountingInvariant}`,
    );
  }
}
if (
  Array.from(
    keeperServiceSource.matchAll(
      /!hasOnlyAllowedNativeTransferEdges\(instruction\.transfers,/g,
    ),
  ).length !== 2
) {
  fail(
    "Solana lifecycle index must apply exact native-transfer edges to execution and order-release facts",
  );
}
const betAccountingTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaBetAccounting.test.ts",
);
if (
  !betAccountingTestSource.includes(
    "binds finalized transaction identity to the first canonical signature",
  )
) {
  fail("finalized SOL transaction primary-signature proof is missing");
}
for (const primarySignatureConsumerPath of [
  "packages/hyperbet-solana/keeper/src/service.ts",
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryCollector.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceCollector.ts",
] as const) {
  const primarySignatureConsumerSource = read(primarySignatureConsumerPath);
  if (
    !primarySignatureConsumerSource.includes(
      "exactPrimarySolanaTransactionSignature",
    ) ||
    primarySignatureConsumerSource.includes("signatures.includes(") ||
    primarySignatureConsumerSource.includes("transaction.signatures[0]")
  ) {
    fail(
      `${primarySignatureConsumerPath} does not bind finalized evidence to the exact primary signature`,
    );
  }
}
if (
  !betAccountingTestSource.includes('["attacker", wallet, 1n]') ||
  !betAccountingTestSource.includes(').toThrow("unexplained native transfer")')
) {
  fail("keeper bet accounting lacks foreign-source transfer rejection proof");
}
const betReconciliationSource = read(
  "packages/hyperbet-solana/keeper/src/solanaBetReconciliation.ts",
);
for (const requiredReconciliationControl of [
  "reconcileBetExecutionFromIndexedFacts",
  "indexed order units violate conservation",
  "indexed initial execution contradicts immutable place-order accounting",
  "rewardEligible",
  "pointsForLamports",
]) {
  if (!betReconciliationSource.includes(requiredReconciliationControl)) {
    fail(
      `Solana bet reconciliation is missing ${requiredReconciliationControl}`,
    );
  }
}
const terminalSettlementSource = read(
  "packages/hyperbet-solana/keeper/src/solanaTerminalSettlement.ts",
);
for (const requiredTerminalSettlementControl of [
  "reconcileWalletMarketTerminalSettlements",
  "allocateFeeByLargestRemainder",
  "wallet-market terminal settlement does not conserve",
  "terminal settlement match is missing taker execution",
  "grossEntitlementLamports",
  "order.lockedLamports + order.tradeFeeLamports",
  "cancellation refund trade-fee attribution does not conserve",
]) {
  if (!terminalSettlementSource.includes(requiredTerminalSettlementControl)) {
    fail(
      `Solana terminal settlement is missing ${requiredTerminalSettlementControl}`,
    );
  }
}
const terminalSettlementTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaTerminalSettlement.test.ts",
);
if (
  !terminalSettlementTestSource.includes(
    "allocates a valid zero-payout claim across every winning entitlement",
  ) ||
  !terminalSettlementTestSource.includes('payoutLamports: "0"') ||
  !terminalSettlementTestSource.includes('feeLamports: "6000"')
) {
  fail("Solana terminal settlement lacks zero-payout allocation proof");
}
const terminalSettlementSchemaSource = read(
  "packages/hyperbet-solana/keeper/src/terminalSettlementSchema.ts",
);
for (const requiredTerminalSettlementSchemaControl of [
  "ensureZeroPayoutTerminalSettlementSchema",
  "payout_lamports INTEGER NOT NULL CHECK (payout_lamports >= 0)",
  "BEGIN IMMEDIATE",
  "ALTER TABLE ${MIGRATION_TABLE} RENAME TO ${TABLE}",
  "Solana terminal settlement payout constraint is unsupported",
]) {
  if (
    !terminalSettlementSchemaSource.includes(
      requiredTerminalSettlementSchemaControl,
    )
  ) {
    fail(
      `Solana terminal settlement schema is missing ${requiredTerminalSettlementSchemaControl}`,
    );
  }
}
const terminalSettlementSchemaTestSource = read(
  "packages/hyperbet-solana/keeper/src/terminalSettlementSchema.test.ts",
);
for (const requiredTerminalSettlementSchemaProof of [
  "preserves legacy rows and admits exact zero-payout claims",
  "ensureZeroPayoutTerminalSettlementSchema(db);",
  'wallet: "zero-payout", payout: 0, fee: 100',
  "fails closed on an unknown payout constraint",
]) {
  if (
    !terminalSettlementSchemaTestSource.includes(
      requiredTerminalSettlementSchemaProof,
    )
  ) {
    fail(
      `Solana terminal settlement schema proof is missing ${requiredTerminalSettlementSchemaProof}`,
    );
  }
}
const terminalSettlementDatabaseSource = read(
  "packages/hyperbet-solana/keeper/src/db.ts",
);
if (
  !terminalSettlementDatabaseSource.includes(
    "ensureZeroPayoutTerminalSettlementSchema(db);",
  ) ||
  terminalSettlementDatabaseSource.includes(
    "payout_lamports INTEGER NOT NULL CHECK (payout_lamports > 0)",
  )
) {
  fail("keeper database does not activate the zero-payout settlement schema");
}
for (const requiredFeeRecipientAliasControl of [
  "treasuryFeeLamports > 0n && treasury === vault",
  "marketMakerFeeLamports > 0n && marketMaker === vault",
] as const) {
  if (!keeperServiceSource.includes(requiredFeeRecipientAliasControl)) {
    fail(
      `Solana fee-withdrawal indexing is missing ${requiredFeeRecipientAliasControl}`,
    );
  }
}
const settlementHistorySource = read(
  "packages/hyperbet-ui/src/lib/solanaSettlementHistory.ts",
);
for (const requiredSettlementHistoryControl of [
  "parseSolanaSettlementHistoryResponse",
  "matched + resting + released !== orderAmount",
  "executed + tradeFee !== rewardEligible",
  "terminalPayout + terminalFee !== terminalGross",
  "response.schemaVersion !== 2",
  'response.asset !== "SOL"',
  "canonicalCluster(response.cluster)",
  "canonicalPublicKey(response.programId)",
  "parsed.cluster !== cluster",
  "parsed.programId !== programId",
  "SETTLEMENT_HISTORY_MAX_FRESHNESS_MS",
  "settlementHistoryResponseIsFresh",
  "page.ledger.lastIndexedAt !== first.ledger.lastIndexedAt",
  "page.updatedAt - first.updatedAt > POLL_INTERVAL_MS",
  "ledger.current",
]) {
  if (!settlementHistorySource.includes(requiredSettlementHistoryControl)) {
    fail(
      `Solana settlement history client is missing ${requiredSettlementHistoryControl}`,
    );
  }
}
const predictionMarketsSource = read(
  "packages/hyperbet-ui/src/lib/solanaPredictionMarkets.ts",
);
for (const requiredPredictionMarketControl of [
  "PREDICTION_MARKETS_MAX_FRESHNESS_MS",
  "PREDICTION_MARKETS_STREAM_MAX_FRESHNESS_MS",
  "predictionMarketsResponseIsFresh",
  "predictionMarketLifecycleIsCoherent",
  "markets.length > 1",
  "market.marketId === market.marketRef",
  "isCanonicalPredictionMarketPublicKey",
  "resolvedWithWinner",
  "market.syncedAt >= oldestAcceptedAt",
  "market.syncedAt <= updatedAt",
  "response.duel.syncedAt",
  "const requestRevision = ++requestRevisionRef.current",
  "requestRevision !== requestRevisionRef.current",
  "setData(null)",
  "activePollController.abort()",
]) {
  if (!predictionMarketsSource.includes(requiredPredictionMarketControl)) {
    fail(
      `Solana prediction-market client is missing ${requiredPredictionMarketControl}`,
    );
  }
}
const dbSource = read("packages/hyperbet-solana/keeper/src/db.ts");
for (const requiredSettlementLedgerControl of [
  "loadSolanaWalletBetHistory",
  "orderStateForHistory",
  "settlementStateForHistory",
  "bet_deployment_identities",
  "deployment.cluster = ?",
  "deployment.program_id = ?",
  "persisted Solana bet history accounting is invalid",
  "persisted Solana terminal history does not conserve",
]) {
  if (!dbSource.includes(requiredSettlementLedgerControl)) {
    fail(
      `Solana settlement ledger is missing ${requiredSettlementLedgerControl}`,
    );
  }
}
const legacyDatabasePolicySource = read(
  "packages/hyperbet-solana/keeper/src/legacyDatabasePolicy.ts",
);
for (const requiredLegacyDatabaseControl of [
  "KEEPER_LAUNCH_SCHEMA_VERSION = 2",
  '"bet_deployment_identities"',
  "unbound-deployment-bets:",
  "invalid-deployment-identities:",
  "keeper database contains a different bound Solana deployment",
  "input.programId",
]) {
  if (!legacyDatabasePolicySource.includes(requiredLegacyDatabaseControl)) {
    fail(
      `keeper legacy database policy is missing ${requiredLegacyDatabaseControl}`,
    );
  }
}
const keeperDatabaseAuditCliSource = read(
  "packages/hyperbet-solana/keeper/src/keeperDatabaseAuditCli.ts",
);
for (const requiredDatabaseAuditControl of [
  'requireArg("program-id")',
  "sameKeeperDatabaseInspection",
  "verifyKeeperBackup",
]) {
  if (!keeperDatabaseAuditCliSource.includes(requiredDatabaseAuditControl)) {
    fail(
      `keeper database migration CLI is missing ${requiredDatabaseAuditControl}`,
    );
  }
}
const lifecycleIndexerSource = read(
  "packages/hyperbet-solana/keeper/src/solanaLifecycleIndexer.ts",
);
for (const requiredLifecycleIndexerControl of [
  "collectFinalizedSignatureBackfill",
  "exactPlainDataRecord",
  "MAX_FINALIZED_SIGNATURE_HISTORY_ENTRIES",
  "MAX_FINALIZED_SIGNATURE_PAGE_SIZE",
  "MAX_FINALIZED_SIGNATURE_PAGES",
  "MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE",
  "exactDenseDataArray",
  "Object.getOwnPropertyDescriptor(value, String(index))",
  "exactFinalizedSignatureSucceeded",
  "exactFinalizedTransactionMetaSucceeded",
  "Object.getOwnPropertyDescriptor(value, field)",
  '!("value" in descriptor)',
  "hasExactSuccessfulFinalizedTransactionMeta",
  "digestFailedFinalizedTransaction",
  "requireExactFinalizedBlockTimeParity",
  "requireExactFinalizedTransactionBatch",
  "minimumAvailableSlot",
  "checkpointSignature",
  'values.confirmationStatus !== "finalized"',
  "lastNormalizedSignature = entry.signature",
  "exactDenseDataArray(\n      await input.fetchPage",
  "newestFirst.reverse()",
  "resolveClusterLifecycleIndexStartSlot",
  "unitsReleasedByVaultRefund",
  "verifyClaimLifecycleAccounting",
  "verifyLosingBalanceCleanupAccounting",
  "must be a positive integer",
  "exceeds the on-chain u64 domain",
  "LOSING_BALANCE_CLOSED",
  "EMPTY_USER_BALANCE_CLOSED",
  "RESOLVED_TRADE_FEES_WITHDRAWN",
]) {
  if (!lifecycleIndexerSource.includes(requiredLifecycleIndexerControl)) {
    fail(
      `Solana lifecycle index is missing ${requiredLifecycleIndexerControl}`,
    );
  }
}
const lifecycleIndexerTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaLifecycleIndexer.test.ts",
);
if (
  !lifecycleIndexerTestSource.includes(
    "rejects zero order identities in every lifecycle position",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "rejects lifecycle integers outside the on-chain u64 domain",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "entry(2, 102, { confirmationStatus: null })",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "requires exact nullable block-time parity across finalized RPC views",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "entry(2, 102, { blockTime: undefined })",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "classifies finalized success only from exact RPC error states",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "requires one ordered finalized transaction response per canonical request",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "exactFinalizedTransactionMetaSucceeded({})",
  ) ||
  !lifecycleIndexerTestSource.includes("const arrayMeta") ||
  !lifecycleIndexerTestSource.includes("const dateMeta") ||
  !lifecycleIndexerTestSource.includes("accessorReads") ||
  !lifecycleIndexerTestSource.includes(
    "requires signature-history entries to be plain data without executing accessors",
  ) ||
  !lifecycleIndexerTestSource.includes("const arrayEntry") ||
  !lifecycleIndexerTestSource.includes("const accessorEntry") ||
  !lifecycleIndexerTestSource.includes(
    "paginates from the normalized signature without rereading provider objects",
  ) ||
  !lifecycleIndexerTestSource.includes("rawSignatureReads") ||
  !lifecycleIndexerTestSource.includes(
    "copies signature pages from dense data without executing position accessors",
  ) ||
  !lifecycleIndexerTestSource.includes("pagePositionReads") ||
  !lifecycleIndexerTestSource.includes("MAX_FINALIZED_SIGNATURE_PAGES + 1") ||
  !lifecycleIndexerTestSource.includes(
    "MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE + 1",
  ) ||
  !lifecycleIndexerTestSource.includes(
    "copies finalized transaction batches from dense data without executing accessors",
  ) ||
  !lifecycleIndexerTestSource.includes("const divergentResponse") ||
  !lifecycleIndexerTestSource.includes("const accessorResponse") ||
  !lifecycleIndexerTestSource.includes("Number.MAX_SAFE_INTEGER") ||
  !lifecycleIndexerTestSource.includes("digestFailedFinalizedTransaction") ||
  lifecycleIndexerSource.includes("entry.err == null") ||
  lifecycleIndexerSource.includes("last.signature") ||
  lifecycleIndexerSource.includes("const page = await input.fetchPage") ||
  lifecycleIndexerSource.includes("return input.transactions as T[]")
) {
  fail("Solana lifecycle index does not prove canonical u64 identities");
}
const keeperDatabaseSource = read("packages/hyperbet-solana/keeper/src/db.ts");
const keeperDatabaseTestSource = read(
  "packages/hyperbet-solana/keeper/src/db.test.ts",
);
if (
  keeperDatabaseSource.includes(
    "new Set(input.instructionNames).size !== input.instructionNames.length",
  ) ||
  !keeperDatabaseTestSource.includes(
    "persists ordered duplicate instruction names without weakening exact replay",
  )
) {
  fail("Solana lifecycle storage does not preserve batched instruction names");
}
const safeIntegerSource = read(
  "packages/hyperbet-solana/keeper/src/solanaSafeInteger.ts",
);
const exactBytes32Source = read(
  "packages/hyperbet-solana/keeper/src/exactBytes32.ts",
);
const exactBytes32TestSource = read(
  "packages/hyperbet-solana/keeper/src/exactBytes32.test.ts",
);
const instructionAccountsSource = read(
  "packages/hyperbet-solana/keeper/src/solanaInstructionAccounts.ts",
);
const instructionAccountsTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaInstructionAccounts.test.ts",
);
const innerInstructionsSource = read(
  "packages/hyperbet-solana/keeper/src/solanaInnerInstructions.ts",
);
const innerInstructionsTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaInnerInstructions.test.ts",
);
const nativeTransferSource = read(
  "packages/hyperbet-solana/keeper/src/solanaNativeTransfer.ts",
);
const nativeTransferTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaNativeTransfer.test.ts",
);
for (const requiredNativeTransferControl of [
  "decodeExactNativeTransferInstruction",
  'record.program !== "system"',
  "SystemProgram.programId.toBase58()",
  "exactSolanaPublicKeyAddress(info.source)",
  "toU64Like(info.lamports)",
  "lamports <= 0n",
] as const) {
  if (!nativeTransferSource.includes(requiredNativeTransferControl)) {
    fail(
      `SOL native-transfer decoding is missing ${requiredNativeTransferControl}`,
    );
  }
}
for (const requiredNativeTransferProof of [
  "accepts only a canonical positive System Program transfer",
  "distinguishes valid nontransfer instructions from invalid evidence",
  "rejects non-system lookalikes and malformed or hostile transfers",
] as const) {
  if (!nativeTransferTestSource.includes(requiredNativeTransferProof)) {
    fail(`SOL native-transfer proof is missing ${requiredNativeTransferProof}`);
  }
}
for (const requiredInnerInstructionControl of [
  "exactInnerInstructionGroups",
  "exactTransactionInstructionSequence",
  "Number.isSafeInteger(index)",
  "groups.has(index as number)",
  "groups.set(index as number, [...instructions])",
  "index >= topLevelInstructions.length",
] as const) {
  if (!innerInstructionsSource.includes(requiredInnerInstructionControl)) {
    fail(
      `SOL inner-instruction decoding is missing ${requiredInnerInstructionControl}`,
    );
  }
}
for (const requiredInnerInstructionProof of [
  "preserves every instruction position under one unique numeric index",
  "rejects duplicate, malformed, coercible, and hostile groups",
  "interleaves each unique inner group after its owning instruction",
] as const) {
  if (!innerInstructionsTestSource.includes(requiredInnerInstructionProof)) {
    fail(
      `SOL inner-instruction proof is missing ${requiredInnerInstructionProof}`,
    );
  }
}
for (const requiredInstructionAccountControl of [
  "exactInstructionAccountAddresses",
  "exactSolanaPublicKeyAddress",
  "exactTransactionSignerAddresses",
  "new PublicKey(address).toBase58() === address",
  "if (!address) return null",
  'typeof signer !== "boolean"',
  "signer !== index < (expectedSignerCount as number)",
]) {
  if (!instructionAccountsSource.includes(requiredInstructionAccountControl)) {
    fail(
      `SOL instruction-account decoding is missing ${requiredInstructionAccountControl}`,
    );
  }
}
for (const requiredInstructionAccountProof of [
  "preserves every canonical address, duplicate, and position",
  "rejects one malformed position instead of shifting later accounts",
  "accepts only canonical account keys with exact boolean signer authority",
  "requires signers to be the exact signature-count prefix",
  "rejects malformed signer metadata instead of treating truthy values as signatures",
]) {
  if (
    !instructionAccountsTestSource.includes(requiredInstructionAccountProof)
  ) {
    fail(
      `SOL instruction-account proof is missing ${requiredInstructionAccountProof}`,
    );
  }
}
for (const requiredBytes32Control of [
  "exactBytes32",
  "exactBytes32Hex",
  'typeof entry !== "number"',
  "entry < 0",
  "entry > 255",
]) {
  if (!exactBytes32Source.includes(requiredBytes32Control)) {
    fail(`SOL bytes32 decoding is missing ${requiredBytes32Control}`);
  }
}
for (const requiredBytes32Proof of [
  "accepts exact byte arrays without changing their identity",
  "rejects coercible, fractional, out-of-range, malformed, and hostile arrays",
]) {
  if (!exactBytes32TestSource.includes(requiredBytes32Proof)) {
    fail(`SOL bytes32 proof is missing ${requiredBytes32Proof}`);
  }
}
const safeIntegerTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaSafeInteger.test.ts",
);
for (const requiredSafeIntegerControl of [
  "toSafeIntegerLike",
  "toU64Like",
  "Number.isSafeInteger",
  "MIN_SAFE_INTEGER_BIGINT",
  "MAX_SAFE_INTEGER_BIGINT",
  "CANONICAL_INTEGER",
  "CANONICAL_U64",
  "U64_MAX",
]) {
  if (!safeIntegerSource.includes(requiredSafeIntegerControl)) {
    fail(
      `SOL finalized-evidence integer decoding is missing ${requiredSafeIntegerControl}`,
    );
  }
}
for (const requiredSafeIntegerProof of [
  "accepts exact safe integer representations",
  "rejects lossy, noncanonical, fallback, and hostile values",
  "accepts the exact canonical u64 evidence domain",
  "rejects out-of-domain, noncanonical, and hostile u64 evidence",
]) {
  if (!safeIntegerTestSource.includes(requiredSafeIntegerProof)) {
    fail(
      `SOL finalized-evidence integer proof is missing ${requiredSafeIntegerProof}`,
    );
  }
}
if (
  !keeperServiceSource.includes("toSafeIntegerLike as toNumberLike") ||
  !keeperServiceSource.includes("toU64Like as toBigIntLike") ||
  keeperServiceSource.includes("function toBigIntLike(value: unknown)") ||
  keeperServiceSource.includes(
    "instructionNames: [...new Set(instructions.map((item) => item.name))]",
  ) ||
  !keeperServiceSource.includes(
    "instructionNames: instructions.map((item) => item.name)",
  )
) {
  fail(
    "SOL finalized parsing does not preserve strict integers and ordered instruction evidence",
  );
}
const lifecycleMarketIdentityStrictSource = read(
  "packages/hyperbet-solana/keeper/src/solanaLifecycleMarketIdentity.ts",
);
const resolveSource = read("packages/hyperbet-solana/keeper/src/resolve.ts");
if (
  !keeperServiceSource.includes(
    'exactBytes32Hex as bytes32Hex } from "./exactBytes32"',
  ) ||
  !lifecycleMarketIdentityStrictSource.includes(
    'exactBytes32 } from "./exactBytes32"',
  ) ||
  !resolveSource.includes('exactBytes32Hex } from "./exactBytes32"') ||
  keeperServiceSource.includes("value.map(Number)") ||
  resolveSource.includes("Buffer.from(value as ArrayLike<number>)")
) {
  fail("SOL identity consumers do not share exact bytes32 decoding");
}
if (
  !keeperServiceSource.includes(
    "exactInstructionAccountAddresses as extractInstructionAccounts",
  ) ||
  !keeperServiceSource.includes("exactTransactionSignerAddresses") ||
  !keeperServiceSource.includes("exactSolanaTransactionSignatures") ||
  !keeperServiceSource.includes('"transaction-signature-mismatch"') ||
  !keeperServiceSource.includes("transactionSignatures.length") ||
  !keeperServiceSource.includes("exactInnerInstructionGroups") ||
  Array.from(
    keeperServiceSource.matchAll(/decodeExactNativeTransferInstruction/g),
  ).length !== 3 ||
  !keeperServiceSource.includes(
    "lifecycle index contains malformed market accounts",
  ) ||
  !keeperServiceSource.includes("return exactSolanaPublicKeyAddress(value)") ||
  keeperServiceSource.includes("new PublicKey(value.trim()).toBase58()") ||
  keeperServiceSource.includes(
    ".filter((account): account is string => Boolean(account))",
  ) ||
  keeperServiceSource.includes("key.signer &&") ||
  keeperServiceSource.includes("innerInstructions?.find") ||
  keeperServiceSource.includes("parsedRecord.info.lamports") ||
  keeperServiceSource.includes("record.info.lamports")
) {
  fail("SOL instruction consumers do not preserve exact account positions");
}
for (const forbiddenSignatureRepair of [
  "const signature = txSignature.trim()",
  "txSignature: txSignature.trim()",
  "txSignature.trim(),",
] as const) {
  if (keeperServiceSource.includes(forbiddenSignatureRepair)) {
    fail(
      `SOL external-bet verification repairs transaction identity with ${forbiddenSignatureRepair}`,
    );
  }
}
const lifecycleMarketIdentitySource = read(
  "packages/hyperbet-solana/keeper/src/solanaLifecycleMarketIdentity.ts",
);
for (const requiredLifecycleMarketIdentityControl of [
  "requireCanonicalLifecycleMarketIdentity",
  "requireCanonicalMarketCreationIdentity",
  "marketKind !== DUEL_WINNER_MARKET_KIND",
  "canonicalDuelState.equals(storedDuelState)",
  "canonicalMarket.equals(marketRef)",
]) {
  if (
    !lifecycleMarketIdentitySource.includes(
      requiredLifecycleMarketIdentityControl,
    )
  ) {
    fail(
      `finalized lifecycle market identity is missing ${requiredLifecycleMarketIdentityControl}`,
    );
  }
}
const lifecycleMarketIdentityTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaLifecycleMarketIdentity.test.ts",
);
for (const requiredLifecycleMarketIdentityProof of [
  "binds the exact duel key, oracle PDA, launch kind, and market PDA",
  "binds one signed launch creation instruction to its exact event and accounts",
  "rejects every creation argument, event, account, signer, or transfer drift",
  "rejects a self-consistent nonlaunch market kind",
  "rejects a self-consistent market around the wrong oracle account",
]) {
  if (
    !lifecycleMarketIdentityTestSource.includes(
      requiredLifecycleMarketIdentityProof,
    )
  ) {
    fail(
      `finalized lifecycle market identity proof is missing ${requiredLifecycleMarketIdentityProof}`,
    );
  }
}
if (
  !keeperServiceSource.includes(
    "const identity = requireCanonicalLifecycleMarketIdentity({",
  ) ||
  !keeperServiceSource.includes(
    "const identity = requireCanonicalMarketCreationIdentity({",
  ) ||
  !keeperServiceSource.includes(
    "initializeMarket requires one canonical marketCreated event",
  )
) {
  fail(
    "finalized lifecycle parser does not enforce canonical market creation identity",
  );
}
const lifecycleInstructionIdentitySource = read(
  "packages/hyperbet-solana/keeper/src/solanaLifecycleInstructionIdentity.ts",
);
for (const requiredLifecycleInstructionControl of [
  "requireCanonicalInstructionAccountCardinality",
  "requireClassifiedMarketEvents",
  "requireClassifiedMarketInstructions",
  "requireUniqueLifecycleExecutionIdentities",
  "requireExactMarketSyncCoverage",
  "requireExactLifecycleEventCoverage",
  "requireOwnedLifecycleExecutionEvents",
  "MARKET_SYNCING_INSTRUCTIONS",
  "REQUIRED_EVENT_BY_INSTRUCTION",
  "EXECUTION_EVENT_NAMES",
  "CLASSIFIED_MARKET_INSTRUCTIONS",
  "CLASSIFIED_MARKET_EVENTS",
  "ACCOUNT_CARDINALITY_BY_INSTRUCTION",
  "optionalPriceLevelCloseOwners",
  'instruction.name !== "placeOrder"',
  'instruction.name !== "continueOrder"',
  "seen.has(identity)",
  "finalized lifecycle execution identity is ambiguous",
]) {
  if (
    !lifecycleInstructionIdentitySource.includes(
      requiredLifecycleInstructionControl,
    )
  ) {
    fail(
      `finalized lifecycle instruction identity is missing ${requiredLifecycleInstructionControl}`,
    );
  }
}
const lifecycleInstructionIdentityTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaLifecycleInstructionIdentity.test.ts",
);
for (const requiredLifecycleInstructionProof of [
  "accepts exact fixed graphs and intentional matching accounts",
  "rejects missing fixed accounts and inert extras on nonmatching instructions",
  "classifies the complete current market-program event surface",
  "rejects new, misspelled, or noncanonical event names",
  "classifies the complete current market-program instruction surface",
  "rejects new, misspelled, or noncanonical instruction names",
  "requires one event for every sync-emitting instruction per market",
  "rejects missing, extra, wrong-market, or malformed sync coverage",
  "requires one canonical event for every event-emitting instruction",
  "rejects missing, extra, wrong-market, or malformed mandatory events",
  "allows at most one optional price-level close per cancellation or reclaim",
  "binds every match, self-trade, and fee event to one execution identity",
  "rejects stray or malformed optional execution events",
  "rejects place plus continuation for one market order",
  "rejects two continuations for one market order",
  "rejects missing, zero, or negative execution identity fields",
]) {
  if (
    !lifecycleInstructionIdentityTestSource.includes(
      requiredLifecycleInstructionProof,
    )
  ) {
    fail(
      `finalized lifecycle instruction identity proof is missing ${requiredLifecycleInstructionProof}`,
    );
  }
}
if (
  !keeperServiceSource.includes(
    "requireCanonicalInstructionAccountCardinality(",
  ) ||
  !keeperServiceSource.includes("requireClassifiedMarketEvents(") ||
  !keeperServiceSource.includes("requireClassifiedMarketInstructions(") ||
  !keeperServiceSource.includes("requireUniqueLifecycleExecutionIdentities(") ||
  !keeperServiceSource.includes("requireExactMarketSyncCoverage({") ||
  !keeperServiceSource.includes("requireExactLifecycleEventCoverage({") ||
  !keeperServiceSource.includes("requireOwnedLifecycleExecutionEvents({") ||
  !keeperServiceSource.includes(
    "syncMarketFromDuel account graph is noncanonical",
  ) ||
  !keeperServiceSource.includes('event.name === "priceLevelClosed"') ||
  !keeperServiceSource.includes(
    "instruction.accounts[3] === expectedPriceLevel",
  ) ||
  !keeperServiceSource.includes("instruction.accounts[5] === rentRecipient") ||
  !keeperServiceSource.includes("rentRecipient === closer")
) {
  fail(
    "finalized lifecycle parser does not reject ambiguous executions or incomplete event coverage",
  );
}
const programLogAttributionSource = read(
  "packages/hyperbet-solana/keeper/src/solanaProgramLogAttribution.ts",
);
for (const requiredProgramLogAttributionControl of [
  "extractAttributedProgramDataLogs",
  "invocationStack",
  "program log evidence is truncated",
  "program data log has no active invocation",
  "program invocation log stack is incomplete",
]) {
  if (
    !programLogAttributionSource.includes(requiredProgramLogAttributionControl)
  ) {
    fail(
      `finalized program-log attribution is missing ${requiredProgramLogAttributionControl}`,
    );
  }
}
const programLogAttributionTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaProgramLogAttribution.test.ts",
);
const programEventsSource = read(
  "packages/hyperbet-solana/keeper/src/solanaProgramEvents.ts",
);
const programEventsTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaProgramEvents.test.ts",
);
const transactionDigestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaTransactionDigest.ts",
);
const transactionDigestTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaTransactionDigest.test.ts",
);
for (const requiredTransactionDigestControl of [
  "digestFinalizedSolanaTransaction",
  "value.toString(10)",
  "value.toBase58()",
  'Buffer.from(value).toString("base64")',
  "digestEvidence(normalizeFinalizedSolanaRpcValue(value))",
] as const) {
  if (!transactionDigestSource.includes(requiredTransactionDigestControl)) {
    fail(
      `finalized transaction digest is missing ${requiredTransactionDigestControl}`,
    );
  }
}
for (const requiredTransactionDigestProof of [
  "is stable across provider object-key order without changing arrays",
  "fails closed on cyclic and hostile RPC evidence",
] as const) {
  if (!transactionDigestTestSource.includes(requiredTransactionDigestProof)) {
    fail(
      `finalized transaction digest proof is missing ${requiredTransactionDigestProof}`,
    );
  }
}
for (const requiredProgramEventControl of [
  "decodeExactProgramDataEvents",
  "program data log did not decode",
  "program data log decoded to an invalid event",
  "events.push({",
] as const) {
  if (!programEventsSource.includes(requiredProgramEventControl)) {
    fail(
      `finalized program-event decoding is missing ${requiredProgramEventControl}`,
    );
  }
}
for (const requiredProgramEventProof of [
  "preserves every decoded event, duplicate, and log position",
  "rejects undecodable, malformed, coercible, and hostile event logs",
] as const) {
  if (!programEventsTestSource.includes(requiredProgramEventProof)) {
    fail(
      `finalized program-event proof is missing ${requiredProgramEventProof}`,
    );
  }
}
for (const requiredProgramLogAttributionProof of [
  "keeps only data emitted while the market program owns the log stack",
  "counts direct and CPI invocations so callers can reject hidden execution",
  "unwinds failed invocations without attributing their data",
  "fails closed on malformed, incomplete, or truncated log stacks",
]) {
  if (
    !programLogAttributionTestSource.includes(
      requiredProgramLogAttributionProof,
    )
  ) {
    fail(
      `finalized program-log attribution proof is missing ${requiredProgramLogAttributionProof}`,
    );
  }
}
if (
  !keeperServiceSource.includes("extractAttributedProgramDataLogs(") ||
  !keeperServiceSource.includes(
    "attributedProgramLogs.invocationCount !== instructions.length",
  ) ||
  !keeperServiceSource.includes(
    "attributedProgramLogs.invocationCount !== 1",
  ) ||
  Array.from(keeperServiceSource.matchAll(/decodeExactProgramDataEvents/g))
    .length !== 3 ||
  !keeperServiceSource.includes("directBetEventNames") ||
  !keeperServiceSource.includes("marketSyncEventCount !== 1") ||
  keeperServiceSource.includes("if (!decodedEvent) continue") ||
  keeperServiceSource.includes("if (decoded)")
) {
  fail(
    "SOL accounting consumers do not require exact attributed market-program execution",
  );
}
for (const transactionDigestConsumerPath of [
  "packages/hyperbet-solana/keeper/src/service.ts",
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryCollector.ts",
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceCollector.ts",
] as const) {
  const transactionDigestConsumerSource = read(transactionDigestConsumerPath);
  if (
    !transactionDigestConsumerSource.includes(
      "digestFinalizedSolanaTransaction",
    )
  ) {
    fail(
      `${transactionDigestConsumerPath} does not use the canonical finalized transaction digest`,
    );
  }
}
if (
  keeperServiceSource.includes("digestFinalizedTransactionEvidence") ||
  keeperServiceSource.includes("JSON.stringify(transaction, (_key, value)")
) {
  fail("SOL lifecycle storage still hashes provider object insertion order");
}
const strictFinalizedRecoveryCollectorSource = read(
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryCollector.ts",
);
if (
  !strictFinalizedRecoveryCollectorSource.includes("exactBytes32Hex") ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "exactSolanaPublicKeyAddress",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes("toU64Like") ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "exactSolanaTransactionSignatures",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "exactTransactionSignerAddresses",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "exactFinalizedTransactionMetaSucceeded",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "digestFailedFinalizedTransaction",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "requireExactFinalizedTransactionBatch",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE",
  ) ||
  strictFinalizedRecoveryCollectorSource.includes(
    "const TRANSACTION_BATCH_SIZE",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "transactionSignatures.length",
  ) ||
  !strictFinalizedRecoveryCollectorSource.includes(
    "row.succeeded !== 0 && row.succeeded !== 1",
  ) ||
  strictFinalizedRecoveryCollectorSource.includes(
    "new PublicKey(value).toBase58()",
  ) ||
  strictFinalizedRecoveryCollectorSource.includes(
    "Buffer.from(value as ArrayLike<number>)",
  ) ||
  strictFinalizedRecoveryCollectorSource.includes(
    "!/^(0|[1-9][0-9]*)$/u.test(normalized!)",
  ) ||
  strictFinalizedRecoveryCollectorSource.includes("transaction.meta.err")
) {
  fail("finalized SOL recovery still uses coercive identity/value decoders");
}
const strictDisputeCollectorSource = read(
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceCollector.ts",
);
if (
  !strictDisputeCollectorSource.includes("exactBytes32Hex") ||
  !strictDisputeCollectorSource.includes("exactSolanaPublicKeyAddress") ||
  !strictDisputeCollectorSource.includes("toU64Like") ||
  !strictDisputeCollectorSource.includes(
    "exactTransactionInstructionSequence",
  ) ||
  !strictDisputeCollectorSource.includes("exactSolanaTransactionSignatures") ||
  !strictDisputeCollectorSource.includes("exactTransactionSignerAddresses") ||
  !strictDisputeCollectorSource.includes("collectFinalizedSignatureBackfill") ||
  !strictDisputeCollectorSource.includes(
    "requireExactFinalizedBlockTimeParity",
  ) ||
  !strictDisputeCollectorSource.includes(
    "hasExactSuccessfulFinalizedTransactionMeta",
  ) ||
  !strictDisputeCollectorSource.includes(
    "requireExactFinalizedTransactionBatch",
  ) ||
  !strictDisputeCollectorSource.includes(
    "MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE",
  ) ||
  strictDisputeCollectorSource.includes("const TRANSACTION_BATCH_SIZE") ||
  !strictDisputeCollectorSource.includes(
    "previous.succeeded !== reference.succeeded",
  ) ||
  !strictDisputeCollectorSource.includes("const successfulReferences") ||
  !strictDisputeCollectorSource.includes(
    "MAX_FINALIZED_SIGNATURE_HISTORY_ENTRIES",
  ) ||
  !strictDisputeCollectorSource.includes("MAX_FINALIZED_SIGNATURE_PAGE_SIZE") ||
  !strictDisputeCollectorSource.includes("MAX_FINALIZED_SIGNATURE_PAGES") ||
  strictDisputeCollectorSource.includes("const MAX_SIGNATURES_PER_ACCOUNT") ||
  strictDisputeCollectorSource.includes(
    "Buffer.from(value as ArrayLike<number>)",
  ) ||
  strictDisputeCollectorSource.includes("new PublicKey(value).toBase58()") ||
  strictDisputeCollectorSource.includes(
    "!/^(0|[1-9][0-9]*)$/.test(normalized)",
  ) ||
  strictDisputeCollectorSource.includes("innerInstructions?.flatMap") ||
  strictDisputeCollectorSource.includes("for (;;)") ||
  strictDisputeCollectorSource.includes("entry.confirmationStatus &&") ||
  strictDisputeCollectorSource.includes("reference.blockTime !== null &&") ||
  strictDisputeCollectorSource.includes("transaction.meta.err")
) {
  fail("duel dispute evidence still uses divergent transaction decoders");
}
const strictDisputeCollectorTestSource = read(
  "packages/hyperbet-solana/keeper/src/duelDisputeEvidenceCollector.test.ts",
);
if (
  !strictDisputeCollectorTestSource.includes(
    "requires cross-account finalized success parity before transaction fetch",
  ) ||
  !strictDisputeCollectorTestSource.includes("transactionFetches")
) {
  fail("duel dispute evidence does not prove cross-account status parity");
}
const claimAccountingSource = read(
  "packages/hyperbet-solana/keeper/src/solanaClaimAccounting.ts",
);
for (const requiredClaimAccountingControl of [
  "allocateFeeByLargestRemainder",
  "validateClaimLifecycleFact",
  "input.payoutLamports + input.feeLamports <= 0n",
  "input.eventPayoutLamports + input.eventWinningsFeeLamports <= 0n",
  "input.vault === input.marketMaker",
  "transfer.source !== input.vault",
  "input.payoutLamports <= 0n",
  "const expectedFee = (gross * BigInt(input.winningsFeeBps)) / 10_000n",
  "transferredToWallet !==",
  "transferredToMarketMaker !== input.eventWinningsFeeLamports",
]) {
  if (!claimAccountingSource.includes(requiredClaimAccountingControl)) {
    fail(`SOL claim accounting is missing ${requiredClaimAccountingControl}`);
  }
}
const claimAccountingTestSource = read(
  "packages/hyperbet-solana/keeper/src/solanaClaimAccounting.test.ts",
);
for (const requiredClaimAccountingProof of [
  "matches the complete on-chain fee domain including zero payout",
  "expect(verified).toBe(50_005)",
  "conserves distinct and aliased zero-payout transfer evidence",
  "allocates a full-fee claim without inventing residual payout",
  "rejects missing, redirected, zero, and contradictory transfers",
  '{ source: "attacker", destination: WALLET, lamports: 1n }',
]) {
  if (!claimAccountingTestSource.includes(requiredClaimAccountingProof)) {
    fail(
      `SOL claim accounting proof is missing ${requiredClaimAccountingProof}`,
    );
  }
}
if (
  !keeperServiceSource.includes(
    "lifecycleIndexStartSlot: resolveClusterLifecycleIndexStartSlot({",
  ) ||
  keeperServiceSource.includes("required: SERVICE_IS_MAINNET")
) {
  fail(
    "Solana lifecycle service is not bound to the cluster-aware replay boundary",
  );
}
if (!keeperServiceSource.includes('event.name === "emptyUserBalanceClosed"')) {
  fail(
    "Solana lifecycle service does not validate empty-balance cleanup events",
  );
}
const keeperFeePolicySource = read(
  "packages/hyperbet-solana/keeper/src/feePolicy.ts",
);
if (
  !keeperFeePolicySource.includes(
    "return resolveApprovedLaunchFeePolicy(input)",
  ) ||
  keeperFeePolicySource.includes(
    'if (cluster === "mainnet" || cluster === "mainnet-beta")',
  )
) {
  fail(
    "Solana keeper fee policy does not require one approved envelope on every non-local rail",
  );
}
const keeperFeedConfigSource = read(
  "packages/hyperbet-solana/keeper/src/feedConfig.ts",
);
if (
  !keeperFeedConfigSource.includes('if (cluster !== "localnet")') ||
  !keeperFeedConfigSource.includes(
    "BET_SYNC_SOURCE_BEARER_TOKEN is required on every non-local launch rail",
  ) ||
  !duelKeeperSource.includes("bearerToken: duelFeedConfig.bearerToken")
) {
  fail(
    "Solana keeper is not bound to one authenticated HTTPS duel feed on every non-local rail",
  );
}
const keeperSolanaProxyRailSource = read(
  "packages/hyperbet-solana/keeper/src/solanaProxyRailPolicy.ts",
);
for (const requiredProxyRailControl of [
  "A deployed Solana proxy must not target localnet",
  "skipPreflight: false",
  "skipPreflight: true",
  "maxRetries: 5",
  "maxRetries: 0",
]) {
  if (!keeperSolanaProxyRailSource.includes(requiredProxyRailControl)) {
    fail(`Solana proxy rail is missing ${requiredProxyRailControl}`);
  }
}
if (
  !keeperServiceSource.includes("resolveSolanaProxyRail({") ||
  keeperServiceSource.includes("HTTP_POLICY.deployment && !SERVICE_IS_MAINNET")
) {
  fail(
    "Solana service does not support the production-shaped staging proxy rail",
  );
}
const programIdentitySource = read(
  "packages/hyperbet-solana/keeper/src/solanaProgramIdentity.ts",
);
for (const requiredProgramIdentityControl of [
  "BPF_LOADER_UPGRADEABLE_PROGRAM_ID",
  "programAccount.executable",
  "canonicalProgramDataAddress",
  "programDataAccount.owner.equals",
  "expectedUpgradeAuthority",
  '"finalized"',
]) {
  if (!programIdentitySource.includes(requiredProgramIdentityControl)) {
    fail(
      `Solana launch program identity gate is missing ${requiredProgramIdentityControl}`,
    );
  }
}
for (const launchRuntimeSource of [duelBotSource, keeperServiceSource]) {
  if (!launchRuntimeSource.includes("fetchUpgradeableProgramIdentity")) {
    fail("a Solana launch runtime is missing the program identity gate");
  }
  if (
    !launchRuntimeSource.includes("resolveClusterExpectedUpgradeAuthority({")
  ) {
    fail(
      "a Solana launch runtime permits a non-local program authority without an explicit expectation",
    );
  }
}
for (const requiredRole of [
  "keeperFeePayerKeypair",
  "oracleReporterKeypair",
  "oracleFinalizerKeypair",
  "oracleChallengerWallet",
  "clobMarketOperatorKeypair",
  "marketMakerKeypair",
]) {
  if (!duelBotSource.includes(requiredRole)) {
    fail(`dedicated duel keeper is missing explicit ${requiredRole} wiring`);
  }
}
for (const requiredSignerBinding of [
  ".signers([oracleReporterKeypair])",
  ".signers([oracleFinalizerKeypair])",
  ".signers([clobMarketOperatorKeypair])",
  ".signers([marketMakerKeypair])",
]) {
  if (!duelBotSource.includes(requiredSignerBinding)) {
    fail(
      `dedicated duel keeper is missing transaction signer binding ${requiredSignerBinding}`,
    );
  }
}

const serviceSource = read("packages/hyperbet-solana/keeper/src/service.ts");
if (
  !serviceSource.includes("requireExactFinalizedBlockTimeParity") ||
  !serviceSource.includes("hasExactSuccessfulFinalizedTransactionMeta") ||
  !serviceSource.includes("digestFailedFinalizedTransaction") ||
  !serviceSource.includes("MAX_FINALIZED_SIGNATURE_PAGE_SIZE") ||
  !serviceSource.includes("MAX_FINALIZED_SIGNATURE_PAGES") ||
  !serviceSource.includes("MAX_SOLANA_LIFECYCLE_INDEX_TRANSACTIONS_PER_RUN") ||
  !serviceSource.includes(
    'readBoundedEnvInteger(\n  "SOLANA_LIFECYCLE_INDEX_BATCH_SIZE"',
  ) ||
  !serviceSource.includes(
    'readBoundedEnvInteger(\n  "SOLANA_LIFECYCLE_INDEX_MAX_PAGES"',
  ) ||
  serviceSource.includes("transaction.blockTime ?? reference.blockTime") ||
  serviceSource.includes("reference.blockTime !== null &&") ||
  serviceSource.includes(".update(`failed:${reference.signature}`)") ||
  serviceSource.includes("transaction.meta.err")
) {
  fail("Solana lifecycle service permits finalized block-time drift");
}
for (const requiredReadinessControl of [
  "createReadOnlyLaunchPrograms",
  "evaluateKeeperReadiness",
  "resolveStreamStateSourceConfig",
  "canAcceptStreamStatePublish",
  "STREAM_STATE_PUBLISH_ENABLED",
  'url.pathname === "/health"',
  'url.pathname === "/ready"',
  "checkDatabaseHealth",
  "resolveKeeperBotHealthSourceConfig",
  'supervision: "dedicated-service"',
  "KEEPER_RELEASE_IDENTITY",
  "assertServiceRuntimeIsolation",
  "resolveOperatorAlertConfig",
  "loadOperatorAlertDurableState",
  "persistOperatorAlertDurableState",
  "OperatorAlertDispatcher",
  "operatorAlertDispatcher.deliveryStatus",
  "operatorAlertMonitorInFlight",
  "normalizeServiceSolanaCluster",
  "schemaVersion: 2",
  "syncedAt: streamLastUpdatedAt",
  "cluster: SERVICE_SOLANA_CLUSTER",
  "programId: DUEL_MARKET_PROGRAM_ID.toBase58()",
]) {
  if (!serviceSource.includes(requiredReadinessControl)) {
    fail(
      `Solana service is missing launch readiness control ${requiredReadinessControl}`,
    );
  }
}
const operatorAlertSource = read(
  "packages/hyperbet-solana/keeper/src/operatorAlertDispatcher.ts",
);
for (const requiredAlertControl of [
  "FEDERATED_OPERATOR_ALERT_CODES",
  "production HYPERBET_OPERATOR_ALERT_WEBHOOK_URL must use https:",
  'const routeRequired = input.production && cluster !== "localnet"',
  "incidentFingerprint",
  '"idempotency-key"',
  "parseOperatorAlertDurableState",
  "resolvedAlerts",
  "consecutiveFailures",
  'failureCode = "http-status"',
] as const) {
  if (!operatorAlertSource.includes(requiredAlertControl)) {
    fail(`SOL operator alerts are missing ${requiredAlertControl}`);
  }
}
const operatorAlertProbeSource = read(
  "packages/hyperbet-solana/keeper/src/operatorAlertProbe.ts",
);
for (const requiredProbeControl of [
  "HYPERBET_OPERATOR_ALERT_TEST_APPROVED=true",
  'deliveryScope: "webhook_http_acceptance_only"',
  'redirect: "error"',
  "providerAcknowledgementRequired: true",
  "controlledFiringRecoveryRequired: true",
  'open(temporaryPath, "wx", 0o600)',
  "link(temporaryPath, resolvedOutputPath)",
] as const) {
  if (!operatorAlertProbeSource.includes(requiredProbeControl)) {
    fail(`SOL operator alert probe is missing ${requiredProbeControl}`);
  }
}
const operatorAlertStateSource = read(
  "packages/hyperbet-solana/keeper/src/operatorAlertStateStore.ts",
);
for (const requiredStateControl of [
  "MAX_STATE_BYTES",
  "parseOperatorAlertDurableState",
  'openSync(temporaryPath, "wx", 0o600)',
  "fsyncSync(fileDescriptor)",
  "renameSync(temporaryPath, resolvedPath)",
] as const) {
  if (!operatorAlertStateSource.includes(requiredStateControl)) {
    fail(`SOL operator alert state is missing ${requiredStateControl}`);
  }
}
const operatorAlertStateBackupSource = read(
  "packages/hyperbet-solana/keeper/src/operatorAlertStateBackup.ts",
);
for (const requiredBackupControl of [
  "constants.O_NOFOLLOW",
  "beforeSourceRecheck",
  "fsyncParent",
  "linkSync(stagedBackupPath, backupPath)",
  "operator alert state changed while the backup was being created",
  "verifyOperatorAlertStateBackup",
  "restoreOperatorAlertStateBackup",
] as const) {
  if (!operatorAlertStateBackupSource.includes(requiredBackupControl)) {
    fail(`SOL operator alert state backup is missing ${requiredBackupControl}`);
  }
}
const keeperRecoverySetSource = read(
  "packages/hyperbet-solana/keeper/src/keeperRecoverySet.ts",
);
for (const requiredRecoverySetControl of [
  "constants.O_NOFOLLOW",
  'verificationScope: "file_pair_binding_only"',
  "quiescentBoundaryWitnessRequired: true",
  "componentCreatedAtSkewMs",
  "bindFile(paths.keeperBackupPath",
  "verifyKeeperBackup",
  "verifyOperatorAlertStateBackup",
] as const) {
  if (!keeperRecoverySetSource.includes(requiredRecoverySetControl)) {
    fail(`SOL keeper recovery set is missing ${requiredRecoverySetControl}`);
  }
}
const keeperRecoveryMaterializationSource = read(
  "packages/hyperbet-solana/keeper/src/keeperRecoveryMaterialization.ts",
);
for (const requiredMaterializationControl of [
  "constants.O_NOFOLLOW",
  'verificationScope: "isolated_restore_materialization_only"',
  "activationRequiresSeparateApproval: true",
  "copyPrivateFile",
  "inspectKeeperDatabaseSnapshot",
  "loadOperatorAlertDurableState",
  "requireExactEntries",
  "renameSync(stagingPath, activePath)",
] as const) {
  if (
    !keeperRecoveryMaterializationSource.includes(
      requiredMaterializationControl,
    )
  ) {
    fail(
      `SOL keeper recovery materialization is missing ${requiredMaterializationControl}`,
    );
  }
}
const hyperiaPostgresBackupArtifactSource = read(
  "packages/hyperbet-solana/keeper/src/hyperiaPostgresBackupArtifact.ts",
);
for (const requiredHyperiaArtifactControl of [
  "constants.O_NOFOLLOW",
  "HYPERIA_POSTGRES_RECOVERY_TABLES",
  "sourceMigrationJournalSha256",
  "pg_restore",
  "published backup layout is invalid",
] as const) {
  if (
    !hyperiaPostgresBackupArtifactSource.includes(
      requiredHyperiaArtifactControl,
    )
  ) {
    fail(
      `SOL Hyperia PostgreSQL artifact verifier is missing ${requiredHyperiaArtifactControl}`,
    );
  }
}
const platformRecoverySetSource = read(
  "packages/hyperbet-solana/keeper/src/platformRecoverySet.ts",
);
for (const requiredPlatformRecoveryControl of [
  "constants.O_NOFOLLOW",
  'verificationScope: "cross_repository_file_binding_only"',
  "quiescentBoundaryWitnessRequired: true",
  "activationRequiresSeparateApproval: true",
  "verifyKeeperRecoverySet",
  "verifyHyperiaPostgresBackupArtifact",
  "componentCreatedAtSkewMs",
] as const) {
  if (!platformRecoverySetSource.includes(requiredPlatformRecoveryControl)) {
    fail(
      `SOL platform recovery set is missing ${requiredPlatformRecoveryControl}`,
    );
  }
}
const hyperiaRestoreEvidenceArtifactSource = read(
  "packages/hyperbet-solana/keeper/src/hyperiaPostgresRestoreEvidenceArtifact.ts",
);
for (const requiredRestoreEvidenceControl of [
  "constants.O_NOFOLLOW",
  "recoveryTableSha256s",
  "isolated_postgres_restore_evidence_only",
  "productionCutoverAuthorized",
  "expectedRestoredStateSha256",
] as const) {
  if (
    !hyperiaRestoreEvidenceArtifactSource.includes(
      requiredRestoreEvidenceControl,
    )
  ) {
    fail(
      `SOL Hyperia restore-evidence verifier is missing ${requiredRestoreEvidenceControl}`,
    );
  }
}
const platformRecoveryRehearsalSource = read(
  "packages/hyperbet-solana/keeper/src/platformRecoveryRehearsal.ts",
);
for (const requiredRehearsalControl of [
  "constants.O_NOFOLLOW",
  'verificationScope: "cross_repository_restore_evidence_binding_only"',
  "quiescentBoundaryWitnessRequired: true",
  "activationRequiresSeparateApproval: true",
  "productionCutoverAuthorized: false",
  "restoredStateReverificationRequiredAtActivation: true",
  "verifyPlatformRecoverySet",
  "verifyMaterializedKeeperRecoverySet",
  "verifyHyperiaPostgresRestoreEvidenceArtifact",
] as const) {
  if (!platformRecoveryRehearsalSource.includes(requiredRehearsalControl)) {
    fail(
      `SOL platform recovery rehearsal is missing ${requiredRehearsalControl}`,
    );
  }
}
const restoredDuelReconciliationSource = read(
  "packages/hyperbet-solana/keeper/src/restoredDuelStateReconciliation.ts",
);
for (const requiredReconciliationControl of [
  "constants.O_NOFOLLOW",
  'verificationScope: "cross_repository_restored_duel_state_and_application_read_projection"',
  "activationRequiresSeparateApproval: true",
  "productionCutoverAuthorized: false",
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "restored Hyperia duel state changed during cross-store reconciliation",
  "restored terminal truth does not match",
  "terminal operation conflicts",
  "readApplicationReadiness",
  "projectedCompetitiveDuelCount",
  "projectedCompetitiveDuels",
  "digestEvidence(projectedCompetitiveDuels)",
  "application projected duel does not match the reconciled restored state",
  "hyperiaApplicationReadiness",
  "verifyPlatformRecoveryRehearsal",
] as const) {
  if (
    !restoredDuelReconciliationSource.includes(requiredReconciliationControl)
  ) {
    fail(
      `SOL restored duel reconciliation is missing ${requiredReconciliationControl}`,
    );
  }
}
const platformRecoveryQualificationSource = read(
  "packages/hyperbet-solana/keeper/scripts/test-platform-recovery-set.ts",
);
for (const requiredQualificationControl of [
  "SELECT current_database()",
  'import { closeDb } from "./src/db.ts"; closeDb();',
  "new TerminalLedger(databasePath)",
  "restoredServerStartupCompatible",
  "restoredServerSourceEpochAdvancedExactlyOnce",
  '"storage", "streaming_scheduler_leases"',
  'restoredServerNodeVersion: "v22.23.2"',
  "restoredHyperbetServiceStartupCompatible",
  "restoredHyperbetServiceLogicalStatePreserved",
  "restoredHyperbetServiceAlertStatePreserved",
  "restoredHyperbetServiceTransactionAuthorityAbsent",
  "restoredHyperbetServiceExternalNetworkDisabled",
  "restoredHyperbetServiceWritePublishCode",
  "sameKeeperDatabaseInspection",
] as const) {
  if (
    !platformRecoveryQualificationSource.includes(requiredQualificationControl)
  ) {
    fail(
      `SOL platform recovery qualification is missing ${requiredQualificationControl}`,
    );
  }
}
const finalizedRecoveryReconciliationSource = read(
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryReconciliation.ts",
);
for (const requiredFinalizedRecoveryControl of [
  'verificationScope: "finalized_solana_post_restore_read_only_reconciliation"',
  "database changed while finalized state was read",
  "deriveProgramDataAddress",
  "lifecycle checkpoint is not recoverable from finalized history",
  "digestFailedFinalizedTransaction",
  'typeof transaction.succeeded !== "boolean"',
  "observed.succeeded !== transaction.succeeded",
  "placement transaction is not exactly bound",
  "indexedPlacement.succeeded !== true",
  "observedPlacement.succeeded !== true",
  "custody omits restored active-order collateral",
  "vault is undercollateralized",
  "databaseMutationAuthorized: false",
  "chainMutationAuthorized: false",
  "activationRequiresSeparateApproval: true",
] as const) {
  if (
    !finalizedRecoveryReconciliationSource.includes(
      requiredFinalizedRecoveryControl,
    )
  ) {
    fail(
      `SOL finalized recovery reconciliation is missing ${requiredFinalizedRecoveryControl}`,
    );
  }
}
const finalizedRecoveryReconciliationTestSource = read(
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryReconciliation.test.ts",
);
for (const requiredFinalizedRecoveryProof of [
  "recovers a finalized failed indexed transaction without weakening a successful placement",
  'hash("forged-failed")',
  "restoredPlacement.succeeded = false",
  "observedPlacement.succeeded = false",
  'toThrow("placement transaction is not exactly bound")',
] as const) {
  if (
    !finalizedRecoveryReconciliationTestSource.includes(
      requiredFinalizedRecoveryProof,
    )
  ) {
    fail(
      `SOL finalized recovery proof is missing ${requiredFinalizedRecoveryProof}`,
    );
  }
}
const finalizedRecoveryCollectorSource = read(
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryCollector.ts",
);
for (const requiredFinalizedCollectorControl of [
  'database.run("PRAGMA query_only = ON")',
  "inspectKeeperDatabaseSnapshot",
  "getAccountInfoAndContext",
  "getProgramAccounts",
  "withContext: true",
  "getParsedTransactions",
  "sumActiveOrderCollateral",
  "stableChainProjection(firstChain)",
  "stableChainProjection(secondChain)",
] as const) {
  if (
    !finalizedRecoveryCollectorSource.includes(
      requiredFinalizedCollectorControl,
    )
  ) {
    fail(
      `SOL finalized recovery collector is missing ${requiredFinalizedCollectorControl}`,
    );
  }
}
const finalizedRecoveryBoundQualificationSource = read(
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryQualification.ts",
);
for (const requiredBoundQualificationControl of [
  'verificationScope: "finalized_solana_post_restore_bound_evidence_only"',
  "verifyRestoredDuelStateReconciliationWithFacts",
  "chain expectation cluster does not match the bound recovery set",
  "prior recovery truth changed during finalized reconciliation",
  "bound input changed during finalized reconciliation",
  "operatorSuppliedExpectationRequiresIndependentApproval: true",
  "rpcProviderRetentionRequiresSeparateEvidence: true",
  "stableEvidenceProjection",
  "databaseMutationAuthorized: false",
  "chainMutationAuthorized: false",
  "productionCutoverAuthorized: false",
] as const) {
  if (
    !finalizedRecoveryBoundQualificationSource.includes(
      requiredBoundQualificationControl,
    )
  ) {
    fail(
      `SOL bound finalized recovery qualification is missing ${requiredBoundQualificationControl}`,
    );
  }
}
const finalizedRecoveryBoundQualificationCliSource = read(
  "packages/hyperbet-solana/keeper/src/finalizedSolanaRecoveryQualificationCli.ts",
);
for (const requiredBoundQualificationCliControl of [
  "--rpc-url-env must name a dedicated HYPERBET_ variable",
  "--rpc-timeout-ms must be between 1000 and 120000",
  'commitment: "finalized"',
  "AbortSignal.any",
  "sanitizeErrorMessage",
  "[redacted RPC endpoint]",
] as const) {
  if (
    !finalizedRecoveryBoundQualificationCliSource.includes(
      requiredBoundQualificationCliControl,
    )
  ) {
    fail(
      `SOL finalized recovery operator CLI is missing ${requiredBoundQualificationCliControl}`,
    );
  }
}
const finalizedRecoveryQualificationSource = read(
  "packages/hyperbet-solana/keeper/scripts/test-finalized-solana-recovery.ts",
);
for (const requiredFinalizedQualificationControl of [
  '"--upgradeable-program"',
  "currentSbfProgramsUsed: true",
  "actualProductionCollectorUsed: true",
  "unchangedAcrossDoubleFinalizedRead",
  "externalNetworkUsed: false",
  "realValueUsed: false",
  "productionCutoverAuthorized: false",
] as const) {
  if (
    !finalizedRecoveryQualificationSource.includes(
      requiredFinalizedQualificationControl,
    )
  ) {
    fail(
      `SOL finalized recovery qualification is missing ${requiredFinalizedQualificationControl}`,
    );
  }
}
if (
  keeperPackage.scripts?.["finalized-solana-recovery"] !==
  "bun --bun src/finalizedSolanaRecoveryQualificationCli.ts"
) {
  fail(
    "finalized Solana recovery operator command is not pinned to its audited CLI",
  );
}
if (
  keeperPackage.scripts?.["test:finalized-solana-recovery"] !==
  "bun --bun scripts/test-finalized-solana-recovery.ts"
) {
  fail(
    "finalized Solana recovery qualification is not pinned to its owned-local entrypoint",
  );
}
if (
  keeperPackage.scripts?.["operator-alert-probe"] !==
  "bun --bun src/operatorAlertProbeCli.ts"
) {
  fail("keeper operator alert probe is not pinned to the audited CLI");
}
if (
  keeperPackage.scripts?.["operator-alert-state-backup"] !==
  "bun --bun src/operatorAlertStateBackupCli.ts"
) {
  fail("keeper operator alert state backup is not pinned to the audited CLI");
}
if (
  keeperPackage.scripts?.["keeper-recovery-set"] !==
  "bun --bun src/keeperRecoverySetCli.ts"
) {
  fail("keeper recovery set is not pinned to the audited CLI");
}
if (
  keeperPackage.scripts?.["platform-recovery-set"] !==
  "bun --bun src/platformRecoverySetCli.ts"
) {
  fail("platform recovery set is not pinned to the audited CLI");
}
if (
  keeperPackage.scripts?.["platform-recovery-rehearsal"] !==
  "bun --bun src/platformRecoveryRehearsalCli.ts"
) {
  fail("platform recovery rehearsal is not pinned to the audited CLI");
}
if (
  keeperPackage.scripts?.["restored-duel-state-reconciliation"] !==
  "bun --bun src/restoredDuelStateReconciliationCli.ts"
) {
  fail("restored duel reconciliation is not pinned to the audited CLI");
}
const keeperEnvironmentExample = read(
  "packages/hyperbet-solana/keeper/.env.example",
);
for (const requiredAlertVariable of [
  "HYPERBET_OPERATOR_ALERT_WEBHOOK_URL",
  "HYPERBET_OPERATOR_ALERT_BEARER_TOKEN",
  "HYPERBET_OPERATOR_ALERT_ROUTE_ID",
  "HYPERBET_OPERATOR_ALERT_MONITOR_MS",
  "HYPERBET_OPERATOR_ALERT_REMINDER_MS",
  "HYPERBET_OPERATOR_ALERT_RETRY_MS",
  "HYPERBET_OPERATOR_ALERT_TIMEOUT_MS",
  "HYPERBET_OPERATOR_ALERT_STATE_FILE",
  "HYPERBET_OPERATOR_ALERT_TEST_APPROVED",
] as const) {
  if (!keeperEnvironmentExample.includes(requiredAlertVariable)) {
    fail(`keeper environment example is missing ${requiredAlertVariable}`);
  }
}
for (const requiredDedicatedBotControl of [
  "startDuelBotHealthServer",
  "DUEL_BOT_HEALTH_SERVER_ENABLED",
  "BOT_RELEASE_IDENTITY.commitSha",
  "assertDuelBotRuntimeRole",
  "isProtectedKeeperRuntimeEnvironment",
] as const) {
  if (!duelBotSource.includes(requiredDedicatedBotControl)) {
    fail(`dedicated duel keeper is missing ${requiredDedicatedBotControl}`);
  }
}
if (duelBotSource.includes('process.env.NODE_ENV === "production"')) {
  fail("dedicated duel keeper leaves NODE_ENV=staging on local-only controls");
}
const keeperEntrypointSource = read("packages/hyperbet-solana/keeper/start.sh");
if (
  !keeperEntrypointSource.includes("production|staging)") ||
  keeperEntrypointSource.indexOf(
    "HYPERBET_RUNTIME_ROLE is required in production and staging",
  ) > keeperEntrypointSource.indexOf("export HYPERBET_RUNTIME_ROLE=")
) {
  fail(
    "keeper entrypoint defaults the runtime role before protected validation",
  );
}
requireAbsent("packages/hyperbet-solana/keeper/src/db.ts", [
  /\bperps\b/i,
  /model market/i,
  /agent_ratings/i,
]);

if (
  existsSync(
    join(
      root,
      "packages/hyperbet-solana/app/src/components/ModelsMarketView.tsx",
    ),
  )
) {
  fail("Solana app still contains its Models/perps route component");
}

const distAssets = join(root, "packages/hyperbet-solana/app/dist/assets");
if (existsSync(distAssets)) {
  const assetNames = readdirSync(distAssets);
  const excludedChunk = assetNames.find((name) =>
    /modelsmarket|perps/i.test(name),
  );
  if (excludedChunk) {
    fail(`Solana production bundle contains excluded chunk ${excludedChunk}`);
  }

  const forbiddenBundlePatterns = [
    /RainbowKit/i,
    /\bwagmi\b/i,
    /Avalanche/i,
    /\bAVAX\b/,
    /Binance Smart Chain/i,
    /Base Sepolia/i,
    /Models Market/i,
    /Gold Perps/i,
    /\bGOLD\b/,
    /gold-betting-keeper/i,
    /["']image-size["']/i,
    /metro-transform-worker/i,
    /@react-native\/community-cli-plugin/i,
  ] as const;
  for (const name of assetNames.filter((entry) => entry.endsWith(".js"))) {
    const contents = readFileSync(join(distAssets, name), "utf8");
    if (forbiddenBundlePatterns.some((pattern) => pattern.test(contents))) {
      fail(
        `Solana production bundle ${name} contains excluded chain/token content`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("SOL-only v1 scope gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "SOL-only v1 scope gate passed: root commands, two-program graph, runtime sources, and production bundle are duel-only.",
);
