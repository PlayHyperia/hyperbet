import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  APPROVED_GITHUB_HOSTED_RUNNER,
  APPROVED_EXTERNAL_ACTIONS,
  APPROVED_LOCAL_TYPESCRIPT_COMMAND,
  APPROVED_LOCAL_ACTIONS,
  auditGitHubActionWorkflows,
  auditWorkflowSource,
  auditWorkflowSources,
  EXPECTED_ACTION_SOURCE_FILES,
  EXPECTED_COMPOSITE_ACTION_FILES,
  EXPECTED_GITHUB_HOSTED_RUNNER_SELECTIONS,
  EXPECTED_WORKFLOW_FILES,
} from "./ci-github-actions-policy.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = fileURLToPath(
  new URL("./ci-github-actions-policy.mjs", import.meta.url),
);
const setupHyperbetActionPath = path.join(
  rootDir,
  ".github/actions/setup-hyperbet/action.yml",
);
const expectedSolanaVersion = "2.3.0";
const expectedSolanaRevision = "a2e21dda295b18dd09ac06542834c5e9b1b2dc84";

function loadCurrentSources() {
  return Object.fromEntries(
    EXPECTED_ACTION_SOURCE_FILES.map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
    ]),
  );
}

function replaceOnce(sources, before, after) {
  const mutated = { ...sources };
  const entry = Object.entries(mutated).find(([, source]) =>
    source.includes(before),
  );
  assert.ok(entry, `fixture is missing ${before}`);
  mutated[entry[0]] = entry[1].replace(before, after);
  return mutated;
}

function assertRejected(sources, pattern) {
  const result = auditWorkflowSources(sources);
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), pattern);
}

function extractCompositeRunStep(source, stepName) {
  const lines = source.split(/\r?\n/u);
  const stepLine = `    - name: ${stepName}`;
  const stepIndex = lines.indexOf(stepLine);
  assert.notEqual(stepIndex, -1, `missing composite step ${stepName}`);

  let runIndex = -1;
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("    - name: ")) break;
    if (lines[index] === "      run: |") {
      runIndex = index;
      break;
    }
  }
  assert.notEqual(runIndex, -1, `missing run block for ${stepName}`);

  const scriptLines = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.startsWith("        ")) break;
    scriptLines.push(line.startsWith("        ") ? line.slice(8) : "");
  }
  assert.ok(scriptLines.length > 0, `empty run block for ${stepName}`);
  return scriptLines.join("\n");
}

function extractWorkflowRunStep(source, stepName) {
  const lines = source.split(/\r?\n/u);
  const stepLine = `      - name: ${stepName}`;
  const stepIndex = lines.indexOf(stepLine);
  assert.notEqual(stepIndex, -1, `missing workflow step ${stepName}`);

  let runIndex = -1;
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("      - name: ")) break;
    if (lines[index] === "        run: |") {
      runIndex = index;
      break;
    }
  }
  assert.notEqual(runIndex, -1, `missing run block for ${stepName}`);

  const scriptLines = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.startsWith("          ")) break;
    scriptLines.push(line.startsWith("          ") ? line.slice(10) : "");
  }
  assert.ok(scriptLines.length > 0, `empty run block for ${stepName}`);
  return scriptLines.join("\n");
}

function createPythonToolchainFixture() {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyperbet-python-toolchain-"),
  );
  const binDir = path.join(fixtureRoot, "bin");
  const pythonPath = path.join(binDir, "python");
  const poetryPath = path.join(binDir, "poetry");
  const callLog = path.join(fixtureRoot, "calls.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(callLog, "", { mode: 0o600 });
  fs.writeFileSync(
    pythonPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf \'python:%s\\n\' "$*" >> "$FAKE_CALL_LOG"',
      'if [[ "${1:-}" == "-c" ]]; then',
      '  case "${2:-}" in',
      "    *platform.python_version*) printf '%s\\n' \"${FAKE_PYTHON_VERSION:-3.12.14}\" ;;",
      "    *platform.python_implementation*) printf '%s\\n' \"${FAKE_PYTHON_IMPLEMENTATION:-CPython}\" ;;",
      "    *struct.calcsize*) printf '%s\\n' \"${FAKE_POINTER_BITS:-64}\" ;;",
      "    *SETUP_PYTHON_PATH*) printf '%s\\n' \"$SETUP_PYTHON_PATH\" ;;",
      "    *sys.executable*) printf '%s\\n' \"$FAKE_PYTHON_PATH\" ;;",
      "    *) echo 'unexpected Python fixture expression' >&2; exit 91 ;;",
      "  esac",
      'elif [[ "${1:-}" == "-m" && "${2:-}" == "pip" ]]; then',
      '  case "${3:-}" in',
      "    --version) printf '%s\\n' 'pip 25.2 (fixture)' ;;",
      '    install) exit "${FAKE_PIP_INSTALL_STATUS:-0}" ;;',
      '    check) exit "${FAKE_PIP_CHECK_STATUS:-0}" ;;',
      "    freeze) printf '%s\\n' 'poetry==1.8.5' 'poetry-core==1.9.1' ;;",
      "    *) echo 'unexpected pip fixture command' >&2; exit 92 ;;",
      "  esac",
      "else",
      "  echo 'unexpected Python fixture command' >&2",
      "  exit 93",
      "fi",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    poetryPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf \'poetry:%s\\n\' "$*" >> "$FAKE_CALL_LOG"',
      'if [[ "${1:-}" == "--version" ]]; then',
      "  printf 'Poetry (version %s)\\n' \"${FAKE_POETRY_VERSION:-1.8.5}\"",
      "  exit 0",
      "fi",
      "echo 'unexpected Poetry fixture command' >&2",
      "exit 94",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { binDir, callLog, fixtureRoot, poetryPath, pythonPath };
}

function runPythonWorkflowStep(stepName, fixture, overrides = {}) {
  const source = fs.readFileSync(
    path.join(rootDir, ".github/workflows/ci.yml"),
    "utf8",
  );
  const script = extractWorkflowRunStep(source, stepName);
  return spawnSync("/bin/bash", ["-c", script], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      PATH: `${fixture.binDir}:/usr/bin:/bin`,
      EXPECTED_POETRY_VERSION: "1.8.5",
      EXPECTED_PYTHON_VERSION: "3.12.14",
      FAKE_CALL_LOG: fixture.callLog,
      FAKE_PYTHON_PATH: fixture.pythonPath,
      SETUP_PYTHON_PATH: fixture.pythonPath,
      SETUP_PYTHON_VERSION: "3.12.14",
      ...overrides,
    },
  });
}

function createInstalledSolanaFixture() {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyperbet-solana-setup-"),
  );
  const home = path.join(fixtureRoot, "home");
  const runnerTemp = path.join(fixtureRoot, "runner-temp");
  const guardBin = path.join(fixtureRoot, "guard-bin");
  const activeRelease = path.join(
    home,
    ".local/share/solana/install/active_release",
  );
  const solanaBin = path.join(activeRelease, "bin/solana");
  const versionManifest = path.join(activeRelease, "version.yml");
  const githubPath = path.join(fixtureRoot, "github-path");

  fs.mkdirSync(path.dirname(solanaBin), { recursive: true });
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.mkdirSync(guardBin, { recursive: true });
  fs.writeFileSync(
    solanaBin,
    `#!/usr/bin/env bash\nprintf '%s\\n' 'solana-cli ${expectedSolanaVersion} (fixture)'\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    versionManifest,
    `channel: v${expectedSolanaVersion}\ncommit: ${expectedSolanaRevision}\ntarget: x86_64-unknown-linux-gnu\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(guardBin, "curl"),
    "#!/usr/bin/env bash\necho 'network installer must not run in this fixture' >&2\nexit 97\n",
    { mode: 0o700 },
  );
  fs.writeFileSync(githubPath, "", { mode: 0o600 });

  return {
    activeRelease,
    fixtureRoot,
    githubPath,
    guardBin,
    home,
    runnerTemp,
    solanaBin,
    versionManifest,
  };
}

function runSolanaSetup(fixture, overrides = {}) {
  const source = fs.readFileSync(setupHyperbetActionPath, "utf8");
  const script = extractCompositeRunStep(source, "Setup Solana CLI");
  return spawnSync("/bin/bash", ["-c", script], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      PATH: `${fixture.guardBin}:/usr/bin:/bin`,
      HOME: fixture.home,
      RUNNER_ARCH: "X64",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: fixture.runnerTemp,
      GITHUB_PATH: fixture.githubPath,
      EXPECTED_SOLANA_REVISION: expectedSolanaRevision,
      EXPECTED_SOLANA_VERSION: expectedSolanaVersion,
      ...overrides,
    },
  });
}

function runRunnerGenerationCheck(overrides = {}) {
  const source = fs.readFileSync(setupHyperbetActionPath, "utf8");
  const script = extractCompositeRunStep(
    source,
    "Verify GitHub-hosted runner generation",
  );
  return spawnSync("/bin/bash", ["-c", script], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      ImageOS: "ubuntu24",
      ImageVersion: "20260825.1.0",
      RUNNER_ARCH: "X64",
      RUNNER_OS: "Linux",
      ...overrides,
    },
  });
}

function configureSolanaDownloadFixture(fixture, mode) {
  fs.rmSync(fixture.activeRelease, { recursive: true, force: true });
  const payloadByMode = {
    success: `cat > "$output" <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
active_release="\${HOME}/.local/share/solana/install/active_release"
mkdir -p "$active_release/bin"
cat > "$active_release/bin/solana" <<SOLANA
#!/usr/bin/env bash
printf '%s\\n' 'solana-cli \${EXPECTED_SOLANA_VERSION} (fixture)'
SOLANA
chmod 0700 "$active_release/bin/solana"
printf 'channel: v%s\\ncommit: %s\\ntarget: x86_64-unknown-linux-gnu\\n' \\
  "$EXPECTED_SOLANA_VERSION" \\
  "$EXPECTED_SOLANA_REVISION" > "$active_release/version.yml"
chmod 0600 "$active_release/version.yml"
INSTALLER`,
    empty: `: > "$output"`,
    oversized: `head -c 1048577 /dev/zero > "$output"`,
    failing: `printf '%s\\n' '#!/usr/bin/env bash' 'exit 41' > "$output"`,
  };
  const payload = payloadByMode[mode];
  assert.ok(payload, `unknown fake installer mode ${mode}`);
  fs.writeFileSync(
    path.join(fixture.guardBin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ne 16 || "$1" != "--proto" || "$2" != "=https" || "$3" != "--proto-redir" || "$4" != "=https" || "$5" != "--tlsv1.2" || "$6" != "--fail" || "$7" != "--location" || "$8" != "--silent" || "$9" != "--show-error" || "\${10}" != "--max-time" || "\${11}" != "120" || "\${12}" != "--max-filesize" || "\${13}" != "1048576" || "\${14}" != "--output" || "\${16}" != "https://release.anza.xyz/v\${EXPECTED_SOLANA_VERSION}/install" ]]; then
  echo "unexpected curl contract" >&2
  exit 96
fi
output="\${15}"
${payload}
`,
    { mode: 0o700 },
  );
}

describe("GitHub Actions workflow supply-chain policy", () => {
  it("accepts the exact committed workflow and action allowlist", () => {
    assert.deepEqual(auditGitHubActionWorkflows(rootDir), {
      ok: true,
      checkedWorkflows: 5,
      checkedCompositeActions: 1,
      actionInvocations: 29,
      checkoutCredentialPersistenceDisabled: 9,
      setupBunCredentialIsolation: 1,
      setupPythonToolchainSelections: 1,
      exactRustToolchainSelections: 1,
      executableCachesDisabled: 1,
      setupHyperbetInputContracts: 9,
      fixedLinuxRunnerSelections: 9,
      localTypeScriptSelections: 1,
      pythonSdkRuntimeChecks: 1,
      counts: {
        external: {
          "actions/checkout": 9,
          "actions/setup-python": 1,
          "actions/upload-artifact": 6,
          "oven-sh/setup-bun": 1,
          "actions/cache": 2,
          "dtolnay/rust-toolchain": 1,
        },
        local: { "./.github/actions/setup-hyperbet": 9 },
      },
      violations: [],
    });
  });

  it("rejects floating or unreviewed actions hidden inside the composite action", () => {
    const sources = loadCurrentSources();
    for (const [action, approval] of [
      ["oven-sh/setup-bun", APPROVED_EXTERNAL_ACTIONS["oven-sh/setup-bun"]],
      ["actions/cache", APPROVED_EXTERNAL_ACTIONS["actions/cache"]],
      [
        "dtolnay/rust-toolchain",
        APPROVED_EXTERNAL_ACTIONS["dtolnay/rust-toolchain"],
      ],
    ]) {
      assertRejected(
        replaceOnce(
          sources,
          `${action}@${approval.sha}`,
          `${action}@${approval.version}`,
        ),
        new RegExp(
          `${action.replace("/", "\\/")} must use reviewed commit`,
          "u",
        ),
      );
    }
  });

  it("withholds the workflow token from setup-bun and pins exact toolchain inputs", () => {
    const sources = loadCurrentSources();
    for (const [before, after, pattern] of [
      [
        '        token: ""',
        "        token: ${{ github.token }}",
        /setup-bun inputs must equal/u,
      ],
      [
        "        no-cache: true",
        "        no-cache: false",
        /setup-bun inputs must equal/u,
      ],
      [
        "        toolchain: ${{ inputs.rust-version }}",
        "        toolchain: stable",
        /rust-toolchain inputs must equal/u,
      ],
      [
        '    default: "1.93.1"',
        '    default: "stable"',
        /reviewed toolchain control/u,
      ],
    ]) {
      assertRejected(replaceOnce(sources, before, after), pattern);
    }
  });

  it("pins the exact Python SDK action inputs and explicit token boundary", () => {
    const sources = loadCurrentSources();
    for (const [before, after] of [
      [
        '          python-version: "3.12.14"',
        '          python-version: "3.12"',
      ],
      ["          architecture: x64", "          architecture: arm64"],
      ["          check-latest: false", "          check-latest: true"],
      ["          token: ${{ github.token }}", '          token: ""'],
      [
        "          check-latest: false",
        "          check-latest: false\n          cache: pip",
      ],
    ]) {
      assertRejected(
        replaceOnce(sources, before, after),
        /actions\/setup-python inputs must equal/u,
      );
    }
  });

  it("requires exact Python and Poetry runtime checks without package caching", () => {
    const sources = loadCurrentSources();
    for (const [before, after] of [
      ["            --no-cache-dir", "            --cache-dir .cache/pip"],
      [
        "          poetry install --no-interaction --sync",
        "          poetry install --no-interaction",
      ],
      ["          python -m pip check", "          true"],
      [
        '          EXPECTED_POETRY_VERSION: "1.8.5"',
        '          EXPECTED_POETRY_VERSION: "latest"',
      ],
    ]) {
      assertRejected(
        replaceOnce(sources, before, after),
        /reviewed Python SDK control|unreviewed Python package execution or cache state/u,
      );
    }
  });

  it("executes the exact Python SDK runtime identity boundary", () => {
    const fixture = createPythonToolchainFixture();
    try {
      const result = runPythonWorkflowStep(
        "Verify exact Python SDK toolchain",
        fixture,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(
        result.stdout,
        /Python SDK runtime: 3\.12\.14 \(CPython\/64\)/u,
      );
      assert.match(result.stdout, /pip 25\.2 \(fixture\)/u);
    } finally {
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on Python action output, runtime, architecture, and path drift", () => {
    for (const [name, overrides, pattern] of [
      [
        "runtime version",
        { FAKE_PYTHON_VERSION: "3.12.13" },
        /Expected Python 3\.12\.14, received 3\.12\.13/u,
      ],
      [
        "action output version",
        { SETUP_PYTHON_VERSION: "3.12.13" },
        /Expected Python 3\.12\.14/u,
      ],
      [
        "implementation",
        { FAKE_PYTHON_IMPLEMENTATION: "PyPy" },
        /must be 64-bit CPython/u,
      ],
      ["pointer width", { FAKE_POINTER_BITS: "32" }, /must be 64-bit CPython/u],
      [
        "action output path",
        { SETUP_PYTHON_PATH: "/tmp/not-the-active-python" },
        /does not identify the active Python executable/u,
      ],
    ]) {
      const fixture = createPythonToolchainFixture();
      try {
        const result = runPythonWorkflowStep(
          "Verify exact Python SDK toolchain",
          fixture,
          overrides,
        );
        assert.notEqual(result.status, 0, name);
        assert.match(result.stderr, pattern, name);
      } finally {
        fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      }
    }
  });

  it("executes Poetry installation without cache and records its checked graph", () => {
    const fixture = createPythonToolchainFixture();
    try {
      const result = runPythonWorkflowStep("Install pinned Poetry", fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /poetry==1\.8\.5/u);
      assert.match(result.stdout, /poetry-core==1\.9\.1/u);
      assert.equal(
        fs.readFileSync(fixture.callLog, "utf8"),
        [
          "python:-m pip install --disable-pip-version-check --no-cache-dir poetry==1.8.5",
          "poetry:--version",
          "python:-m pip check",
          "python:-m pip freeze --all",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on Poetry install, version, and dependency-check failure", () => {
    for (const [name, overrides, expectedStatus, pattern] of [
      ["pip install", { FAKE_PIP_INSTALL_STATUS: "41" }, 41, null],
      [
        "Poetry version",
        { FAKE_POETRY_VERSION: "1.8.4" },
        1,
        /Expected Poetry 1\.8\.5, received 1\.8\.4/u,
      ],
      ["pip check", { FAKE_PIP_CHECK_STATUS: "42" }, 42, null],
    ]) {
      const fixture = createPythonToolchainFixture();
      try {
        const result = runPythonWorkflowStep(
          "Install pinned Poetry",
          fixture,
          overrides,
        );
        assert.equal(result.status, expectedStatus, name);
        if (pattern) assert.match(result.stderr, pattern, name);
      } finally {
        fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects executable caches and missing post-install version verification", () => {
    const sources = loadCurrentSources();
    assertRejected(
      replaceOnce(
        sources,
        "          ~/.cargo/registry",
        "          ~/.cargo/bin\n          ~/.cargo/registry",
      ),
      /must not restore executable toolchain state/u,
    );
    assertRejected(
      replaceOnce(
        sources,
        'installed_version="$(bun --version)"',
        'installed_version="unverified"',
      ),
      /reviewed toolchain control/u,
    );
    assertRejected(
      replaceOnce(
        sources,
        "installed_version=\"$($solana_bin --version | awk '{print $2}')\"",
        'installed_version="${{ inputs.solana-version }}"',
      ),
      /reviewed toolchain control/u,
    );
  });

  it("rejects workflow-level toolchain overrides and ambiguous local-action inputs", () => {
    const sources = loadCurrentSources();
    for (const replacement of [
      '          install-solana: "true"\n          solana-version: "9.9.9"',
      '          install-solana: "${{ true }}"',
      '          install-solana: "true"\n          install-solana: "true"',
    ]) {
      assertRejected(
        replaceOnce(sources, '          install-solana: "true"', replacement),
        /toolchain version\/revision overrides are forbidden/u,
      );
    }
  });

  it("binds installer revisions, targets, transport, and exact package versions", () => {
    const sources = loadCurrentSources();
    for (const [before, after, pattern] of [
      [
        '    default: "a2e21dda295b18dd09ac06542834c5e9b1b2dc84"',
        '    default: "0"',
        /reviewed toolchain control/u,
      ],
      [
        '    default: "1ebbe58158d089a2a40b5e35ebead5a10db9090d"',
        '    default: "v0.32.1"',
        /reviewed toolchain control/u,
      ],
      [
        '--rev "$EXPECTED_ANCHOR_REVISION"',
        '--tag "v${EXPECTED_ANCHOR_VERSION}"',
        /reviewed toolchain control|must not select mutable Git tags/u,
      ],
      [
        "            --tlsv1.2",
        "            --tlsv1.0",
        /reviewed toolchain control/u,
      ],
      [
        "target: x86_64-unknown-linux-gnu",
        "target: aarch64-unknown-linux-gnu",
        /reviewed toolchain control/u,
      ],
      [
        '--version "=${EXPECTED_CARGO_AUDIT_VERSION}"',
        '--version "${EXPECTED_CARGO_AUDIT_VERSION}"',
        /reviewed toolchain control/u,
      ],
    ]) {
      assertRejected(replaceOnce(sources, before, after), pattern);
    }
  });

  it("rejects direct composite-input interpolation into shell source", () => {
    const sources = loadCurrentSources();
    assertRejected(
      replaceOnce(
        sources,
        'if [[ "$installed_version" != "$EXPECTED_BUN_VERSION" ]]; then',
        'if [[ "$installed_version" != "${{ inputs.bun-version }}" ]]; then',
      ),
      /must receive inputs through step env/u,
    );
  });

  it("pins every workflow job to the reviewed Ubuntu generation", () => {
    const sources = loadCurrentSources();
    const reviewedLine = `    runs-on: ${APPROVED_GITHUB_HOSTED_RUNNER}`;
    assert.equal(EXPECTED_GITHUB_HOSTED_RUNNER_SELECTIONS, 9);
    for (const replacement of [
      "    runs-on: ubuntu-latest",
      "    runs-on: ${{ matrix.runner }}",
      `    "runs-on": ${APPROVED_GITHUB_HOSTED_RUNNER}`,
    ]) {
      assertRejected(
        replaceOnce(sources, reviewedLine, replacement),
        /must select the exact reviewed GitHub-hosted runner ubuntu-24\.04/u,
      );
    }
    assertRejected(
      replaceOnce(sources, `${reviewedLine}\n`, ""),
      /received 8 protected jobs/u,
    );
    assertRejected(
      replaceOnce(
        sources,
        'if [[ "${ImageOS:-}" != "ubuntu24" ]]; then',
        'if [[ "${ImageOS:-}" != "ubuntu22" ]]; then',
      ),
      /reviewed toolchain control/u,
    );
  });

  it("executes and records the exact hosted-runner generation boundary", () => {
    const result = runRunnerGenerationCheck();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "GitHub-hosted runner image: 20260825.1.0 (Linux/X64)\n",
    );
  });

  it("fails closed on hosted-runner OS, architecture, and image drift", () => {
    for (const [name, overrides, pattern] of [
      [
        "runner OS",
        { RUNNER_OS: "Windows" },
        /reviewed workflow runner must be Linux X64/u,
      ],
      [
        "runner architecture",
        { RUNNER_ARCH: "ARM64" },
        /reviewed workflow runner must be Linux X64/u,
      ],
      [
        "image generation",
        { ImageOS: "ubuntu26" },
        /must resolve to the Ubuntu 24 image generation/u,
      ],
      [
        "missing image version",
        { ImageVersion: "" },
        /image version is missing or malformed/u,
      ],
      [
        "malformed image version",
        { ImageVersion: "20260825 latest" },
        /image version is missing or malformed/u,
      ],
    ]) {
      const result = runRunnerGenerationCheck(overrides);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, pattern, name);
      assert.equal(result.stdout, "", name);
    }
  });

  it("uses only the lockfile-installed TypeScript binary in workflow source", () => {
    const sources = loadCurrentSources();
    for (const replacement of [
      "bunx tsc --noEmit --project packages/hyperbet-solana/keeper/tsconfig.launch.json",
      "npx tsc --noEmit --project packages/hyperbet-solana/keeper/tsconfig.launch.json",
      "pnpm dlx typescript tsc --noEmit --project packages/hyperbet-solana/keeper/tsconfig.launch.json",
      "yarn dlx typescript tsc --noEmit --project packages/hyperbet-solana/keeper/tsconfig.launch.json",
    ]) {
      assertRejected(
        replaceOnce(sources, APPROVED_LOCAL_TYPESCRIPT_COMMAND, replacement),
        /must not invoke a package auto-resolver/u,
      );
    }
    assertRejected(
      replaceOnce(sources, APPROVED_LOCAL_TYPESCRIPT_COMMAND, "tsc --noEmit"),
      /received 0 protected invocations/u,
    );
  });

  it("executes the exact installed Solana identity boundary without network access", () => {
    const fixture = createInstalledSolanaFixture();
    try {
      const result = runSolanaSetup(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(
        fs.readFileSync(fixture.githubPath, "utf8"),
        `${path.join(fixture.activeRelease, "bin")}\n`,
      );
    } finally {
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("executes the bounded Solana installer contract and removes its temporary file", () => {
    const fixture = createInstalledSolanaFixture();
    try {
      configureSolanaDownloadFixture(fixture, "success");
      const result = runSolanaSetup(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(
        fs.readFileSync(fixture.githubPath, "utf8"),
        `${path.join(fixture.activeRelease, "bin")}\n`,
      );
      assert.deepEqual(fs.readdirSync(fixture.runnerTemp), []);
    } finally {
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid installer payloads and cleans them after failure", () => {
    for (const [mode, pattern] of [
      ["empty", /installer size is outside the reviewed bound/u],
      ["oversized", /installer size is outside the reviewed bound/u],
      ["failing", /(?:^|\n)$/u],
    ]) {
      const fixture = createInstalledSolanaFixture();
      try {
        configureSolanaDownloadFixture(fixture, mode);
        const result = runSolanaSetup(fixture);
        assert.notEqual(result.status, 0, mode);
        assert.match(result.stderr, pattern, mode);
        assert.deepEqual(fs.readdirSync(fixture.runnerTemp), [], mode);
        assert.equal(fs.readFileSync(fixture.githubPath, "utf8"), "", mode);
      } finally {
        fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      }
    }
  });

  it("fails closed on Solana version, manifest, runner, and path drift", () => {
    const cases = [
      {
        name: "malformed version",
        prepare() {},
        overrides: { EXPECTED_SOLANA_VERSION: "v2.3.0" },
        pattern: /Solana version must be an exact semantic version/u,
      },
      {
        name: "uppercase revision",
        prepare() {},
        overrides: {
          EXPECTED_SOLANA_REVISION: expectedSolanaRevision.toUpperCase(),
        },
        pattern: /Solana revision must be a full lowercase commit/u,
      },
      {
        name: "unsupported runner architecture",
        prepare() {},
        overrides: { RUNNER_ARCH: "ARM64" },
        pattern: /supports only Linux X64 runners/u,
      },
      {
        name: "wrong installed version",
        prepare(fixture) {
          fs.writeFileSync(
            fixture.solanaBin,
            "#!/usr/bin/env bash\nprintf '%s\\n' 'solana-cli 2.3.1 (fixture)'\n",
            { mode: 0o700 },
          );
        },
        overrides: {},
        pattern: /Expected Solana 2\.3\.0, received 2\.3\.1/u,
      },
      {
        name: "wrong release commit",
        prepare(fixture) {
          fs.writeFileSync(
            fixture.versionManifest,
            `channel: v${expectedSolanaVersion}\ncommit: ${"0".repeat(40)}\ntarget: x86_64-unknown-linux-gnu\n`,
          );
        },
        overrides: {},
        pattern: /release manifest does not match/u,
      },
      {
        name: "wrong release target",
        prepare(fixture) {
          fs.writeFileSync(
            fixture.versionManifest,
            `channel: v${expectedSolanaVersion}\ncommit: ${expectedSolanaRevision}\ntarget: aarch64-unknown-linux-gnu\n`,
          );
        },
        overrides: {},
        pattern: /release manifest does not match/u,
      },
      {
        name: "symbolic-link release manifest",
        prepare(fixture) {
          const realManifest = path.join(
            fixture.fixtureRoot,
            "real-version.yml",
          );
          fs.renameSync(fixture.versionManifest, realManifest);
          fs.symlinkSync(realManifest, fixture.versionManifest);
        },
        overrides: {},
        pattern: /release manifest is missing or unsafe/u,
      },
      {
        name: "symbolic-link runner temp",
        prepare(fixture) {
          const realRunnerTemp = path.join(fixture.fixtureRoot, "real-temp");
          fs.renameSync(fixture.runnerTemp, realRunnerTemp);
          fs.symlinkSync(realRunnerTemp, fixture.runnerTemp);
        },
        overrides: {},
        pattern:
          /RUNNER_TEMP must be an existing absolute non-symlink directory/u,
      },
    ];

    for (const testCase of cases) {
      const fixture = createInstalledSolanaFixture();
      try {
        testCase.prepare(fixture);
        const result = runSolanaSetup(fixture, testCase.overrides);
        assert.notEqual(result.status, 0, testCase.name);
        assert.match(result.stderr, testCase.pattern, testCase.name);
        assert.equal(
          fs.readFileSync(fixture.githubPath, "utf8"),
          "",
          testCase.name,
        );
      } finally {
        fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects tags, branches, short or uppercase SHAs, and unreviewed commits", () => {
    const sources = loadCurrentSources();
    const checkout = APPROVED_EXTERNAL_ACTIONS["actions/checkout"];
    const reference = `actions/checkout@${checkout.sha}`;
    for (const revision of [
      checkout.version,
      "main",
      checkout.sha.slice(0, 7),
      checkout.sha.toUpperCase(),
      "0".repeat(40),
    ]) {
      assertRejected(
        replaceOnce(sources, reference, `actions/checkout@${revision}`),
        /actions\/checkout must use reviewed commit/u,
      );
    }
  });

  it("requires every checkout to opt out of credential persistence", () => {
    const sources = loadCurrentSources();
    for (const replacement of [
      "persist-credentials: true",
      "persist-credentials: ${{ false }}",
      '"persist-credentials": false',
    ]) {
      assertRejected(
        replaceOnce(sources, "persist-credentials: false", replacement),
        /must set exactly one literal persist-credentials: false input/u,
      );
    }

    assertRejected(
      replaceOnce(sources, "          persist-credentials: false\n", ""),
      /must set exactly one literal persist-credentials: false input/u,
    );
    assertRejected(
      replaceOnce(
        sources,
        "          persist-credentials: false\n",
        "          persist-credentials: false\n          token: ${{ github.token }}\n",
      ),
      /must not receive a token or SSH private key override/u,
    );
    assertRejected(
      replaceOnce(
        sources,
        "          persist-credentials: false\n",
        "          persist-credentials: false\n          persist-credentials: false\n",
      ),
      /must set exactly one literal persist-credentials: false input/u,
    );
  });

  it("rejects unapproved external actions and misleading review labels", () => {
    const sources = loadCurrentSources();
    const upload = APPROVED_EXTERNAL_ACTIONS["actions/upload-artifact"];
    const approvedLine = `actions/upload-artifact@${upload.sha} # ${upload.version}`;
    assertRejected(
      replaceOnce(
        sources,
        approvedLine,
        `untrusted/upload-artifact@${upload.sha} # ${upload.version}`,
      ),
      /external action untrusted\/upload-artifact is not approved/u,
    );
    assertRejected(
      replaceOnce(
        sources,
        approvedLine,
        `actions/upload-artifact@${upload.sha}`,
      ),
      /must carry exact review label/u,
    );
    assertRejected(
      replaceOnce(
        sources,
        approvedLine,
        `actions/upload-artifact@${upload.sha} # v999.0.0`,
      ),
      /must carry exact review label/u,
    );
  });

  it("rejects local path drift, traversal, revisions, and comments", () => {
    const approvedLocal = Object.keys(APPROVED_LOCAL_ACTIONS)[0];
    for (const reference of [
      "../outside/action",
      "./.github/actions/other",
      `${approvedLocal}@main`,
    ]) {
      const result = auditWorkflowSource(
        "fixture.yml",
        `steps:\n  - uses: ${reference}\n`,
      );
      assert.equal(result.ok, false, reference);
      assert.match(
        result.violations.join("\n"),
        /not the exact approved repository action path/u,
      );
    }
    const commented = auditWorkflowSource(
      "fixture.yml",
      `steps:\n  - uses: ${approvedLocal} # local\n`,
    );
    assert.equal(commented.ok, false);
    assert.match(
      commented.violations.join("\n"),
      /must not carry an external version comment/u,
    );
  });

  it("rejects ambiguous syntax, NUL input, missing workflows, and count drift", () => {
    const quoted = auditWorkflowSource(
      "fixture.yml",
      `steps:\n  - "uses": actions/checkout@${APPROVED_EXTERNAL_ACTIONS["actions/checkout"].sha}\n`,
    );
    assert.equal(quoted.ok, false);
    assert.match(quoted.violations.join("\n"), /canonical unquoted uses/u);

    const nul = auditWorkflowSource("fixture.yml", "uses:\0bad");
    assert.equal(nul.ok, false);
    assert.match(nul.violations.join("\n"), /non-NUL workflow text/u);

    const sources = loadCurrentSources();
    const missing = { ...sources };
    delete missing[`${".github/workflows"}/${EXPECTED_WORKFLOW_FILES[0]}`];
    assertRejected(missing, /action source file set must equal/u);

    assertRejected(
      { ...sources, "unexpected.yml": "name: unexpected\n" },
      /action source file set must equal/u,
    );

    const missingComposite = { ...sources };
    delete missingComposite[EXPECTED_COMPOSITE_ACTION_FILES[0]];
    assertRejected(missingComposite, /action source file set must equal/u);

    const checkout = APPROVED_EXTERNAL_ACTIONS["actions/checkout"];
    assertRejected(
      replaceOnce(
        sources,
        `        uses: actions/checkout@${checkout.sha} # ${checkout.version}\n`,
        "",
      ),
      /actions\/checkout must appear exactly 9 times/u,
    );
  });

  it("rejects unreviewed composite files and symbolic-link action sources", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hyperbet-action-policy-"),
    );
    try {
      for (const relativePath of EXPECTED_ACTION_SOURCE_FILES) {
        const destination = path.join(fixtureRoot, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(rootDir, relativePath), destination);
      }

      const unexpected = path.join(
        fixtureRoot,
        ".github/actions/setup-hyperbet/rogue.yml",
      );
      fs.writeFileSync(unexpected, "name: rogue\nruns:\n  using: composite\n");
      let result = auditGitHubActionWorkflows(fixtureRoot);
      assert.equal(result.ok, false);
      assert.match(
        result.violations.join("\n"),
        /action source file set must equal/u,
      );

      fs.rmSync(unexpected);
      const linked = path.join(
        fixtureRoot,
        ".github/actions/setup-hyperbet/linked.yml",
      );
      fs.symlinkSync("action.yml", linked);
      result = auditGitHubActionWorkflows(fixtureRoot);
      assert.equal(result.ok, false);
      assert.match(
        result.violations.join("\n"),
        /linked\.yml must not be a symbolic link/u,
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("passes as a dependency-free CLI over the current repository", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      checkedWorkflows: 5,
      checkedCompositeActions: 1,
      actionInvocations: 29,
      checkoutCredentialPersistenceDisabled: 9,
      setupBunCredentialIsolation: 1,
      setupPythonToolchainSelections: 1,
      exactRustToolchainSelections: 1,
      executableCachesDisabled: 1,
      setupHyperbetInputContracts: 9,
      fixedLinuxRunnerSelections: 9,
      localTypeScriptSelections: 1,
      pythonSdkRuntimeChecks: 1,
      counts: {
        external: {
          "actions/checkout": 9,
          "actions/setup-python": 1,
          "actions/upload-artifact": 6,
          "oven-sh/setup-bun": 1,
          "actions/cache": 2,
          "dtolnay/rust-toolchain": 1,
        },
        local: { "./.github/actions/setup-hyperbet": 9 },
      },
      violations: [],
    });
  });
});
