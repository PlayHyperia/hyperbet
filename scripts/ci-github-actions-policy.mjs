#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_DIRECTORY = ".github/workflows";
const COMPOSITE_ACTION_DIRECTORY = ".github/actions";
const PYTHON_SDK_WORKFLOW_PATH = ".github/workflows/ci.yml";
const SETUP_HYPERBET_ACTION_PATH = ".github/actions/setup-hyperbet/action.yml";

export const EXPECTED_WORKFLOW_FILES = Object.freeze([
  "ci.yml",
  "deploy-solana-keeper.yml",
  "deploy-solana-pages.yml",
  "deploy-testnet-v3.yml",
  "fund-stage-a-wallets.yml",
]);

export const EXPECTED_COMPOSITE_ACTION_FILES = Object.freeze([
  SETUP_HYPERBET_ACTION_PATH,
]);

export const EXPECTED_ACTION_SOURCE_FILES = Object.freeze([
  ...EXPECTED_WORKFLOW_FILES.map((name) => `${WORKFLOW_DIRECTORY}/${name}`),
  ...EXPECTED_COMPOSITE_ACTION_FILES,
]);

export const APPROVED_EXTERNAL_ACTIONS = Object.freeze({
  "actions/checkout": Object.freeze({
    sha: "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    version: "v6.0.2",
    expectedCount: 9,
  }),
  "actions/setup-python": Object.freeze({
    sha: "ece7cb06caefa5fff74198d8649806c4678c61a1",
    version: "v6.3.0",
    expectedCount: 1,
  }),
  "actions/upload-artifact": Object.freeze({
    sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1",
    expectedCount: 6,
  }),
  "oven-sh/setup-bun": Object.freeze({
    sha: "0c5077e51419868618aeaa5fe8019c62421857d6",
    version: "v2.2.0",
    expectedCount: 1,
  }),
  "actions/cache": Object.freeze({
    sha: "668228422ae6a00e4ad889ee87cd7109ec5666a7",
    version: "v5.0.4",
    expectedCount: 2,
  }),
  "dtolnay/rust-toolchain": Object.freeze({
    sha: "6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772",
    version: "v1",
    expectedCount: 1,
  }),
});

export const APPROVED_LOCAL_ACTIONS = Object.freeze({
  "./.github/actions/setup-hyperbet": Object.freeze({ expectedCount: 9 }),
});

export const APPROVED_GITHUB_HOSTED_RUNNER = "ubuntu-24.04";
export const EXPECTED_GITHUB_HOSTED_RUNNER_SELECTIONS = 9;
export const APPROVED_LOCAL_TYPESCRIPT_COMMAND =
  "./node_modules/.bin/tsc --noEmit --project packages/hyperbet-solana/keeper/tsconfig.launch.json";

const USES_KEY_PATTERN = /^\s*(?:-\s*)?(?:uses|"uses"|'uses')\s*:/u;
const CANONICAL_USES_PATTERN =
  /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S(?:.*\S)?))?\s*$/u;
const RUNS_ON_KEY_PATTERN = /^\s*(?:runs-on|"runs-on"|'runs-on')\s*:/u;
const PACKAGE_AUTO_EXECUTOR_PATTERN =
  /(?:^|\s)(?:bunx|npx|pnpm\s+dlx|yarn\s+dlx)(?:\s|$)/u;
const FULL_LOWERCASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function createCounts() {
  return {
    external: Object.fromEntries(
      Object.keys(APPROVED_EXTERNAL_ACTIONS).map((action) => [action, 0]),
    ),
    local: Object.fromEntries(
      Object.keys(APPROVED_LOCAL_ACTIONS).map((action) => [action, 0]),
    ),
  };
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function auditCheckoutCredentialIsolation(
  relativePath,
  lines,
  usesLineIndex,
  violations,
) {
  const usesIndent = indentation(lines[usesLineIndex]);
  const stepBoundaryIndent = Math.max(0, usesIndent - 2);
  const block = [];
  for (
    let lineIndex = usesLineIndex + 1;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    const line = lines[lineIndex];
    if (line.trim() && indentation(line) <= stepBoundaryIndent) break;
    block.push({ line, lineIndex });
  }

  const withLines = block.filter(
    ({ line }) =>
      indentation(line) === usesIndent && /^\s*with:\s*$/u.test(line),
  );
  const persistenceLines = block.filter(({ line }) =>
    /^\s*(?:persist-credentials|"persist-credentials"|'persist-credentials')\s*:/u.test(
      line,
    ),
  );
  const credentialOverrideLines = block.filter(
    ({ line }) =>
      indentation(line) === usesIndent + 2 &&
      /^\s*(?:token|"token"|'token'|ssh-key|"ssh-key"|'ssh-key')\s*:/u.test(
        line,
      ),
  );
  const expectedPersistenceLine = `${" ".repeat(usesIndent + 2)}persist-credentials: false`;
  const location = `${relativePath}:${usesLineIndex + 1}`;

  if (withLines.length !== 1) {
    violations.push(
      `${location} checkout must contain exactly one canonical with: block`,
    );
  }
  if (
    persistenceLines.length !== 1 ||
    persistenceLines[0].line !== expectedPersistenceLine
  ) {
    violations.push(
      `${location} checkout must set exactly one literal persist-credentials: false input`,
    );
  }
  for (const { lineIndex } of credentialOverrideLines) {
    violations.push(
      `${relativePath}:${lineIndex + 1} checkout must not receive a token or SSH private key override`,
    );
  }

  return (
    withLines.length === 1 &&
    persistenceLines.length === 1 &&
    persistenceLines[0].line === expectedPersistenceLine &&
    credentialOverrideLines.length === 0
  );
}

function auditExactActionInputs(
  relativePath,
  lines,
  usesLineIndex,
  action,
  expectedInputs,
  violations,
) {
  const usesIndent = indentation(lines[usesLineIndex]);
  const stepBoundaryIndent = Math.max(0, usesIndent - 2);
  const block = [];
  for (
    let lineIndex = usesLineIndex + 1;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    const line = lines[lineIndex];
    if (line.trim() && indentation(line) <= stepBoundaryIndent) break;
    block.push({ line, lineIndex });
  }

  const withEntries = block.filter(
    ({ line }) =>
      indentation(line) === usesIndent && /^\s*with:\s*$/u.test(line),
  );
  const location = `${relativePath}:${usesLineIndex + 1}`;
  if (withEntries.length !== 1) {
    violations.push(
      `${location} ${action} must contain exactly one canonical with: block`,
    );
    return false;
  }

  const withIndex = block.indexOf(withEntries[0]);
  const actualInputs = [];
  for (let index = withIndex + 1; index < block.length; index += 1) {
    const { line } = block[index];
    if (!line.trim()) continue;
    const lineIndent = indentation(line);
    if (lineIndent <= usesIndent) break;
    actualInputs.push(line);
  }

  const expectedLines = expectedInputs.map(
    (input) => `${" ".repeat(usesIndent + 2)}${input}`,
  );
  if (JSON.stringify(actualInputs) !== JSON.stringify(expectedLines)) {
    violations.push(
      `${location} ${action} inputs must equal ${expectedInputs.join(", ")}`,
    );
    return false;
  }
  return true;
}

function auditSetupHyperbetCallInputs(
  relativePath,
  lines,
  usesLineIndex,
  violations,
) {
  const usesIndent = indentation(lines[usesLineIndex]);
  const stepBoundaryIndent = Math.max(0, usesIndent - 2);
  const block = [];
  for (
    let lineIndex = usesLineIndex + 1;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    const line = lines[lineIndex];
    if (line.trim() && indentation(line) <= stepBoundaryIndent) break;
    block.push({ line, lineIndex });
  }

  const withEntries = block.filter(
    ({ line }) =>
      indentation(line) === usesIndent && /^\s*with:\s*$/u.test(line),
  );
  const location = `${relativePath}:${usesLineIndex + 1}`;
  if (withEntries.length > 1) {
    violations.push(
      `${location} setup-hyperbet must contain at most one canonical with: block`,
    );
    return false;
  }
  if (withEntries.length === 0) return true;

  const allowedInputPattern = new RegExp(
    `^ {${usesIndent + 2}}(install-rust|install-solana|install-anchor|install-cargo-audit): "true"$`,
    "u",
  );
  const withIndex = block.indexOf(withEntries[0]);
  const seenInputs = new Set();
  let ok = true;
  for (let index = withIndex + 1; index < block.length; index += 1) {
    const { line, lineIndex } = block[index];
    if (!line.trim()) continue;
    if (indentation(line) <= usesIndent) break;
    const match = line.match(allowedInputPattern);
    if (!match || seenInputs.has(match[1])) {
      violations.push(
        `${relativePath}:${lineIndex + 1} setup-hyperbet accepts only unique literal-true install capability inputs; toolchain version/revision overrides are forbidden`,
      );
      ok = false;
      continue;
    }
    seenInputs.add(match[1]);
  }
  return ok;
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function auditSetupHyperbetCompositeAction(relativePath, source, violations) {
  if (relativePath !== SETUP_HYPERBET_ACTION_PATH) return false;
  const requiredFragments = [
    "    - name: Verify GitHub-hosted runner generation",
    'if [[ "${RUNNER_OS:-}" != "Linux" ]]; then',
    'if [[ "${RUNNER_ARCH:-}" != "X64" ]]; then',
    'if [[ "${ImageOS:-}" != "ubuntu24" ]]; then',
    'if [[ ! "${ImageVersion:-}" =~ ^[0-9]{8}\\.[0-9]+\\.[0-9]+$ ]]; then',
    "printf 'GitHub-hosted runner image: %s (%s/%s)\\n'",
    '  rust-version:\n    description: Rust toolchain version to install\n    required: false\n    default: "1.93.1"',
    '  solana-revision:\n    description: Signed Agave release commit expected after installation\n    required: false\n    default: "a2e21dda295b18dd09ac06542834c5e9b1b2dc84"',
    '  anchor-revision:\n    description: Signed Anchor release commit to build\n    required: false\n    default: "1ebbe58158d089a2a40b5e35ebead5a10db9090d"',
    "EXPECTED_BUN_VERSION: ${{ inputs.bun-version }}",
    'installed_version="$(bun --version)"',
    'if [[ "$installed_version" != "$EXPECTED_BUN_VERSION" ]]; then',
    "EXPECTED_RUST_VERSION: ${{ inputs.rust-version }}",
    "rustc_version=\"$(rustc --version | awk '{print $2}')\"",
    "cargo_version=\"$(cargo --version | awk '{print $2}')\"",
    'if [[ "$rustc_version" != "$EXPECTED_RUST_VERSION" ]]; then',
    'if [[ "$cargo_version" != "$EXPECTED_RUST_VERSION" ]]; then',
    "        path: |\n          ~/.cargo/registry\n          ~/.cargo/git\n        key: ${{ runner.os }}-rust-${{ inputs.rust-version }}-cargo-${{ inputs.anchor-version }}-audit-${{ inputs.cargo-audit-version }}",
    "EXPECTED_SOLANA_REVISION: ${{ inputs.solana-revision }}",
    "EXPECTED_SOLANA_VERSION: ${{ inputs.solana-version }}",
    "--proto '=https'",
    "--proto-redir '=https'",
    "--tlsv1.2",
    "--max-filesize 1048576",
    '"https://release.anza.xyz/v${EXPECTED_SOLANA_VERSION}/install"',
    'solana_bin="${HOME}/.local/share/solana/install/active_release/bin/solana"',
    "installed_version=\"$($solana_bin --version | awk '{print $2}')\"",
    'if [[ "$installed_version" != "$EXPECTED_SOLANA_VERSION" ]]; then',
    "target: x86_64-unknown-linux-gnu",
    "EXPECTED_ANCHOR_REVISION: ${{ inputs.anchor-revision }}",
    "EXPECTED_ANCHOR_VERSION: ${{ inputs.anchor-version }}",
    "--git https://github.com/otter-sec/anchor",
    '--rev "$EXPECTED_ANCHOR_REVISION"',
    'if [[ "$installed_version" != "$EXPECTED_ANCHOR_VERSION" ]]; then',
    "EXPECTED_CARGO_AUDIT_VERSION: ${{ inputs.cargo-audit-version }}",
    '--version "=${EXPECTED_CARGO_AUDIT_VERSION}"',
  ];
  const forbiddenFragments = [
    [
      "          ~/.cargo/bin",
      "must not restore executable toolchain state from workflow caches",
    ],
    [
      "        path: ~/.local/share/solana",
      "must not restore executable toolchain state from workflow caches",
    ],
    [
      "    - name: Cache Solana CLI",
      "must not restore executable toolchain state from workflow caches",
    ],
    [
      "command -v solana",
      "must not trust an unrelated runner-global Solana executable",
    ],
    ['sh -c "$(curl', "must not execute a streamed remote installer"],
    ["--tag", "must not select mutable Git tags"],
  ];
  const initialViolationCount = violations.length;

  for (const fragment of requiredFragments) {
    if (countOccurrences(source, fragment) !== 1) {
      violations.push(
        `${relativePath} must contain exactly one reviewed toolchain control: ${fragment.split("\n")[0]}`,
      );
    }
  }
  for (const [fragment, reason] of forbiddenFragments) {
    if (source.includes(fragment)) {
      violations.push(`${relativePath} ${reason}: ${fragment.trim()}`);
    }
  }
  if (countOccurrences(source, "        restore-keys:") !== 1) {
    violations.push(
      `${relativePath} must retain only the reviewed Bun package-store restore key`,
    );
  }

  const lines = source.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!/^\s*run:\s*\|\s*$/u.test(line)) continue;
    const runIndent = indentation(line);
    for (
      let scriptLineIndex = lineIndex + 1;
      scriptLineIndex < lines.length;
      scriptLineIndex += 1
    ) {
      const scriptLine = lines[scriptLineIndex];
      if (scriptLine.trim() && indentation(scriptLine) <= runIndent) break;
      if (scriptLine.includes("${{ inputs.")) {
        violations.push(
          `${relativePath}:${scriptLineIndex + 1} composite run scripts must receive inputs through step env rather than expression interpolation`,
        );
      }
    }
  }

  return violations.length === initialViolationCount;
}

function auditPythonSdkWorkflow(relativePath, source, violations) {
  if (relativePath !== PYTHON_SDK_WORKFLOW_PATH) return false;
  const requiredFragments = [
    ["        id: setup-python-sdk", 1],
    ["      - name: Verify exact Python SDK toolchain", 1],
    ['          EXPECTED_PYTHON_VERSION: "3.12.14"', 2],
    [
      "installed_version=\"$(python -c 'import platform; print(platform.python_version())')\"",
      1,
    ],
    [
      "implementation=\"$(python -c 'import platform; print(platform.python_implementation())')\"",
      1,
    ],
    [
      'pointer_bits="$(python -c \'import struct; print(struct.calcsize("P") * 8)\')"',
      1,
    ],
    ["python -m pip --version", 1],
    ["SETUP_PYTHON_PATH: ${{ steps.setup-python-sdk.outputs.python-path }}", 1],
    [
      "SETUP_PYTHON_VERSION: ${{ steps.setup-python-sdk.outputs.python-version }}",
      1,
    ],
    ["setup-python output does not identify the active Python executable", 1],
    ['          EXPECTED_POETRY_VERSION: "1.8.5"', 1],
    ["--disable-pip-version-check", 1],
    ["--no-cache-dir", 1],
    ['"poetry==${EXPECTED_POETRY_VERSION}"', 1],
    [
      "installed_version=\"$(poetry --version | awk '{print $3}' | tr -d ')')\"",
      1,
    ],
    ["python -m pip check", 1],
    ["python -m pip freeze --all | LC_ALL=C sort", 1],
    ["poetry install --no-interaction --sync", 1],
    [
      "sdk_python_version=\"$(poetry run python -c 'import platform; print(platform.python_version())')\"",
      1,
    ],
  ];
  const forbiddenFragments = [
    "cache: pip",
    "cache-dependency-path:",
    "python -m pip install poetry==",
    "poetry install --no-interaction\n",
  ];
  const initialViolationCount = violations.length;

  for (const [fragment, expectedCount] of requiredFragments) {
    if (countOccurrences(source, fragment) !== expectedCount) {
      violations.push(
        `${relativePath} must contain exactly ${expectedCount} reviewed Python SDK control(s): ${fragment.split("\n")[0]}`,
      );
    }
  }
  for (const fragment of forbiddenFragments) {
    if (source.includes(fragment)) {
      violations.push(
        `${relativePath} must not contain unreviewed Python package execution or cache state: ${fragment.trim()}`,
      );
    }
  }

  return violations.length === initialViolationCount;
}

export function auditWorkflowSource(relativePath, source) {
  const counts = createCounts();
  const violations = [];
  let actionInvocations = 0;
  let checkoutCredentialPersistenceDisabled = 0;
  let setupBunCredentialIsolation = 0;
  let setupPythonToolchainSelections = 0;
  let exactRustToolchainSelections = 0;
  let executableCachesDisabled = 0;
  let setupHyperbetInputContracts = 0;
  let fixedLinuxRunnerSelections = 0;
  let localTypeScriptSelections = 0;
  let pythonSdkRuntimeChecks = 0;

  if (typeof source !== "string" || source.includes("\0")) {
    return {
      ok: false,
      actionInvocations,
      checkoutCredentialPersistenceDisabled,
      setupBunCredentialIsolation,
      setupPythonToolchainSelections,
      exactRustToolchainSelections,
      executableCachesDisabled,
      setupHyperbetInputContracts,
      fixedLinuxRunnerSelections,
      localTypeScriptSelections,
      pythonSdkRuntimeChecks,
      counts,
      violations: [`${relativePath} must be valid non-NUL workflow text`],
    };
  }

  const lines = source.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (PACKAGE_AUTO_EXECUTOR_PATTERN.test(line)) {
      violations.push(
        `${relativePath}:${lineIndex + 1} workflow source must not invoke a package auto-resolver; use an exact dependency installed from the reviewed lockfile`,
      );
    }
    if (line.trim() === APPROVED_LOCAL_TYPESCRIPT_COMMAND) {
      localTypeScriptSelections += 1;
    }
    if (RUNS_ON_KEY_PATTERN.test(line)) {
      if (line === `    runs-on: ${APPROVED_GITHUB_HOSTED_RUNNER}`) {
        fixedLinuxRunnerSelections += 1;
      } else {
        violations.push(
          `${relativePath}:${lineIndex + 1} must select the exact reviewed GitHub-hosted runner ${APPROVED_GITHUB_HOSTED_RUNNER}`,
        );
      }
    }
    if (!USES_KEY_PATTERN.test(line)) continue;
    const location = `${relativePath}:${lineIndex + 1}`;
    const match = line.match(CANONICAL_USES_PATTERN);
    if (!match) {
      violations.push(
        `${location} must use one canonical unquoted uses: reference on one line`,
      );
      continue;
    }

    actionInvocations += 1;
    const reference = match[1];
    const versionComment = match[2];
    const approvedLocal = APPROVED_LOCAL_ACTIONS[reference];
    if (approvedLocal) {
      counts.local[reference] += 1;
      if (versionComment !== undefined) {
        violations.push(
          `${location} local action references must not carry an external version comment`,
        );
      }
      if (
        reference === "./.github/actions/setup-hyperbet" &&
        auditSetupHyperbetCallInputs(relativePath, lines, lineIndex, violations)
      ) {
        setupHyperbetInputContracts += 1;
      }
      continue;
    }

    if (reference.startsWith(".")) {
      violations.push(
        `${location} local action ${reference} is not the exact approved repository action path`,
      );
      continue;
    }

    const separatorIndex = reference.lastIndexOf("@");
    if (separatorIndex <= 0 || separatorIndex === reference.length - 1) {
      violations.push(
        `${location} external action ${reference} must be action@40-character-lowercase-SHA`,
      );
      continue;
    }

    const action = reference.slice(0, separatorIndex);
    const revision = reference.slice(separatorIndex + 1);
    const approved = APPROVED_EXTERNAL_ACTIONS[action];
    if (!approved) {
      violations.push(`${location} external action ${action} is not approved`);
      continue;
    }

    counts.external[action] += 1;
    if (
      !FULL_LOWERCASE_SHA_PATTERN.test(revision) ||
      revision !== approved.sha
    ) {
      violations.push(
        `${location} ${action} must use reviewed commit ${approved.sha}`,
      );
    }
    if (versionComment !== approved.version) {
      violations.push(
        `${location} ${action} must carry exact review label # ${approved.version}`,
      );
    }
    if (
      action === "actions/checkout" &&
      auditCheckoutCredentialIsolation(
        relativePath,
        lines,
        lineIndex,
        violations,
      )
    ) {
      checkoutCredentialPersistenceDisabled += 1;
    }
    if (
      action === "oven-sh/setup-bun" &&
      auditExactActionInputs(
        relativePath,
        lines,
        lineIndex,
        action,
        [
          "bun-version: ${{ inputs.bun-version }}",
          "no-cache: true",
          'token: ""',
        ],
        violations,
      )
    ) {
      setupBunCredentialIsolation += 1;
    }
    if (
      action === "actions/setup-python" &&
      auditExactActionInputs(
        relativePath,
        lines,
        lineIndex,
        action,
        [
          'python-version: "3.12.14"',
          "architecture: x64",
          "check-latest: false",
          "token: ${{ github.token }}",
        ],
        violations,
      )
    ) {
      setupPythonToolchainSelections += 1;
    }
    if (
      action === "dtolnay/rust-toolchain" &&
      auditExactActionInputs(
        relativePath,
        lines,
        lineIndex,
        action,
        ["toolchain: ${{ inputs.rust-version }}"],
        violations,
      )
    ) {
      exactRustToolchainSelections += 1;
    }
  }

  if (auditSetupHyperbetCompositeAction(relativePath, source, violations)) {
    executableCachesDisabled = 1;
  }
  if (auditPythonSdkWorkflow(relativePath, source, violations)) {
    pythonSdkRuntimeChecks = 1;
  }

  return {
    ok: violations.length === 0,
    actionInvocations,
    checkoutCredentialPersistenceDisabled,
    setupBunCredentialIsolation,
    setupPythonToolchainSelections,
    exactRustToolchainSelections,
    executableCachesDisabled,
    setupHyperbetInputContracts,
    fixedLinuxRunnerSelections,
    localTypeScriptSelections,
    pythonSdkRuntimeChecks,
    counts,
    violations,
  };
}

export function auditWorkflowSources(sources) {
  const violations = [];
  const counts = createCounts();
  let actionInvocations = 0;
  let checkoutCredentialPersistenceDisabled = 0;
  let setupBunCredentialIsolation = 0;
  let setupPythonToolchainSelections = 0;
  let exactRustToolchainSelections = 0;
  let executableCachesDisabled = 0;
  let setupHyperbetInputContracts = 0;
  let fixedLinuxRunnerSelections = 0;
  let localTypeScriptSelections = 0;
  let pythonSdkRuntimeChecks = 0;
  const actualActionSourceFiles = sorted(Object.keys(sources));
  const expectedActionSourceFiles = sorted(EXPECTED_ACTION_SOURCE_FILES);

  if (
    JSON.stringify(actualActionSourceFiles) !==
    JSON.stringify(expectedActionSourceFiles)
  ) {
    violations.push(
      `action source file set must equal ${expectedActionSourceFiles.join(", ")}; received ${actualActionSourceFiles.join(", ") || "none"}`,
    );
  }

  for (const relativePath of actualActionSourceFiles) {
    const result = auditWorkflowSource(relativePath, sources[relativePath]);
    actionInvocations += result.actionInvocations;
    checkoutCredentialPersistenceDisabled +=
      result.checkoutCredentialPersistenceDisabled;
    setupBunCredentialIsolation += result.setupBunCredentialIsolation;
    setupPythonToolchainSelections += result.setupPythonToolchainSelections;
    exactRustToolchainSelections += result.exactRustToolchainSelections;
    executableCachesDisabled += result.executableCachesDisabled;
    setupHyperbetInputContracts += result.setupHyperbetInputContracts;
    fixedLinuxRunnerSelections += result.fixedLinuxRunnerSelections;
    localTypeScriptSelections += result.localTypeScriptSelections;
    pythonSdkRuntimeChecks += result.pythonSdkRuntimeChecks;
    violations.push(...result.violations);
    for (const [action, count] of Object.entries(result.counts.external)) {
      counts.external[action] += count;
    }
    for (const [action, count] of Object.entries(result.counts.local)) {
      counts.local[action] += count;
    }
  }

  for (const [action, approval] of Object.entries(APPROVED_EXTERNAL_ACTIONS)) {
    if (counts.external[action] !== approval.expectedCount) {
      violations.push(
        `${action} must appear exactly ${approval.expectedCount} times; received ${counts.external[action]}`,
      );
    }
  }
  for (const [action, approval] of Object.entries(APPROVED_LOCAL_ACTIONS)) {
    if (counts.local[action] !== approval.expectedCount) {
      violations.push(
        `${action} must appear exactly ${approval.expectedCount} times; received ${counts.local[action]}`,
      );
    }
  }
  if (
    checkoutCredentialPersistenceDisabled !==
    APPROVED_EXTERNAL_ACTIONS["actions/checkout"].expectedCount
  ) {
    violations.push(
      `every checkout must disable credential persistence; received ${checkoutCredentialPersistenceDisabled} protected checkouts`,
    );
  }
  if (
    setupBunCredentialIsolation !==
    APPROVED_EXTERNAL_ACTIONS["oven-sh/setup-bun"].expectedCount
  ) {
    violations.push(
      `every setup-bun invocation must disable its executable cache and receive no GitHub token; received ${setupBunCredentialIsolation} protected invocations`,
    );
  }
  if (
    setupPythonToolchainSelections !==
    APPROVED_EXTERNAL_ACTIONS["actions/setup-python"].expectedCount
  ) {
    violations.push(
      `every setup-python invocation must select exact CPython 3.12.14 x64, disable latest-version resolution and package caching, and receive only the step-scoped GitHub token; received ${setupPythonToolchainSelections} protected invocations`,
    );
  }
  if (
    exactRustToolchainSelections !==
    APPROVED_EXTERNAL_ACTIONS["dtolnay/rust-toolchain"].expectedCount
  ) {
    violations.push(
      `every Rust setup must select the exact reviewed input; received ${exactRustToolchainSelections} protected invocations`,
    );
  }
  if (executableCachesDisabled !== EXPECTED_COMPOSITE_ACTION_FILES.length) {
    violations.push(
      `every composite action must prohibit executable toolchain caches; received ${executableCachesDisabled} protected actions`,
    );
  }
  if (
    setupHyperbetInputContracts !==
    APPROVED_LOCAL_ACTIONS["./.github/actions/setup-hyperbet"].expectedCount
  ) {
    violations.push(
      `every setup-hyperbet caller must inherit the reviewed toolchain versions and revisions; received ${setupHyperbetInputContracts} protected invocations`,
    );
  }
  if (fixedLinuxRunnerSelections !== EXPECTED_GITHUB_HOSTED_RUNNER_SELECTIONS) {
    violations.push(
      `every workflow job must select the exact reviewed GitHub-hosted runner ${APPROVED_GITHUB_HOSTED_RUNNER}; received ${fixedLinuxRunnerSelections} protected jobs`,
    );
  }
  if (localTypeScriptSelections !== 1) {
    violations.push(
      `the launch typecheck must invoke the exact reviewed lockfile-installed TypeScript binary once; received ${localTypeScriptSelections} protected invocations`,
    );
  }
  if (pythonSdkRuntimeChecks !== 1) {
    violations.push(
      `the Python SDK workflow must retain its exact runtime, cache, Poetry, and synchronized-lock controls; received ${pythonSdkRuntimeChecks} protected workflows`,
    );
  }

  const checkedWorkflows = actualActionSourceFiles.filter((relativePath) =>
    relativePath.startsWith(`${WORKFLOW_DIRECTORY}/`),
  ).length;
  const checkedCompositeActions = actualActionSourceFiles.filter(
    (relativePath) => relativePath.startsWith(`${COMPOSITE_ACTION_DIRECTORY}/`),
  ).length;

  return {
    ok: violations.length === 0,
    checkedWorkflows,
    checkedCompositeActions,
    actionInvocations,
    checkoutCredentialPersistenceDisabled,
    setupBunCredentialIsolation,
    setupPythonToolchainSelections,
    exactRustToolchainSelections,
    executableCachesDisabled,
    setupHyperbetInputContracts,
    fixedLinuxRunnerSelections,
    localTypeScriptSelections,
    pythonSdkRuntimeChecks,
    counts,
    violations,
  };
}

export function auditGitHubActionWorkflows(rootDir) {
  const workflowDirectory = path.resolve(rootDir, WORKFLOW_DIRECTORY);
  const compositeActionDirectory = path.resolve(
    rootDir,
    COMPOSITE_ACTION_DIRECTORY,
  );
  const discoveryViolations = [];
  const sources = {};
  let entries = [];

  try {
    const directoryStat = fs.lstatSync(workflowDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      discoveryViolations.push(
        `${WORKFLOW_DIRECTORY} must be a real repository directory`,
      );
    } else {
      entries = fs.readdirSync(workflowDirectory, { withFileTypes: true });
    }
  } catch (error) {
    discoveryViolations.push(
      `${WORKFLOW_DIRECTORY} could not be inspected: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  for (const entry of entries) {
    const relativePath = `${WORKFLOW_DIRECTORY}/${entry.name}`;
    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml"))
    ) {
      discoveryViolations.push(
        `${relativePath} is not an approved regular workflow file`,
      );
      continue;
    }
    try {
      sources[relativePath] = fs.readFileSync(
        path.join(workflowDirectory, entry.name),
        "utf8",
      );
    } catch (error) {
      discoveryViolations.push(
        `${relativePath} could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  function discoverCompositeFiles(absoluteDirectory, relativeDirectory) {
    let compositeEntries = [];
    try {
      const directoryStat = fs.lstatSync(absoluteDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        discoveryViolations.push(
          `${relativeDirectory} must be a real repository directory`,
        );
        return;
      }
      compositeEntries = fs.readdirSync(absoluteDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      discoveryViolations.push(
        `${relativeDirectory} could not be inspected: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return;
    }

    for (const entry of compositeEntries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        discoveryViolations.push(`${relativePath} must not be a symbolic link`);
      } else if (entry.isDirectory()) {
        discoverCompositeFiles(absolutePath, relativePath);
      } else if (entry.isFile()) {
        try {
          sources[relativePath] = fs.readFileSync(absolutePath, "utf8");
        } catch (error) {
          discoveryViolations.push(
            `${relativePath} could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      } else {
        discoveryViolations.push(
          `${relativePath} must be a regular repository file or directory`,
        );
      }
    }
  }

  discoverCompositeFiles(compositeActionDirectory, COMPOSITE_ACTION_DIRECTORY);

  const result = auditWorkflowSources(sources);
  const violations = [...discoveryViolations, ...result.violations];
  return { ...result, ok: violations.length === 0, violations };
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = auditGitHubActionWorkflows(rootDir);
  const writer = result.ok ? console.log : console.error;
  writer(JSON.stringify(result, null, result.ok ? 0 : 2));
  if (!result.ok) process.exitCode = 1;
}
