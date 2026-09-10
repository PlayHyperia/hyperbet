import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditSbfBuildLog,
  type LaunchProgram,
} from "../anchor/scripts/audit-sbf-build-log";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const buildScriptPath = path.join(
  packageRoot,
  "anchor",
  "scripts",
  "build-workspace.sh",
);

const commonUndefinedSymbols = [
  "abort",
  "sol_log_",
  "sol_memcpy_",
  "sol_log_data",
  "sol_invoke_signed_rust",
  "sol_get_clock_sysvar",
  "sol_get_rent_sysvar",
  "sol_memset_",
  "sol_try_find_program_address",
  "sol_create_program_address",
  "sol_log_pubkey",
  "sol_sha256",
];

function classifiedWarningLog(
  program: LaunchProgram,
  extraSymbols: string[] = [],
) {
  const symbols = [
    ...commonUndefinedSymbols,
    ...(program === "fight_oracle" ? ["sol_keccak256"] : []),
    ...extraSymbols,
  ];
  return [
    `[2026-08-05T00:00:00Z WARN  cargo_build_sbf] Package '${program}' has two crate types defined: cdylib and lib. This setting precludes link-time optimizations (LTO). Use cdylib for programs to be deployed and rlib for packages to be imported by other programs as libraries.`,
    `[2026-08-05T00:00:01Z WARN  cargo_build_sbf::post_processing] The following functions are undefined and not known syscalls ${JSON.stringify(symbols)}.`,
    "[2026-08-05T00:00:01Z WARN  cargo_build_sbf::post_processing]          Calling them will trigger a run-time error.",
  ].join("\n");
}

type FakeToolchainOptions = {
  anchorVersion?: string;
  hasBuildSbf?: boolean;
};

function runWithFakeToolchain(
  options: FakeToolchainOptions,
  extraEnv: Record<string, string> = {},
) {
  const fakeBin = mkdtempSync(path.join(tmpdir(), "hyperbet-solana-build-"));
  const buildMarker = path.join(fakeBin, "unexpected-build-invocation");
  const cargoPath = path.join(fakeBin, "cargo");
  writeFileSync(
    cargoPath,
    `#!/bin/sh
if [ "$1" = "--list" ]; then
  ${options.hasBuildSbf ? 'printf "    build-sbf\n"' : ":"}
  exit 0
fi
printf "%s\\n" "$*" >> "${buildMarker}"
exit 97
`,
  );
  chmodSync(cargoPath, 0o755);

  if (options.anchorVersion) {
    const anchorPath = path.join(fakeBin, "anchor");
    writeFileSync(
      anchorPath,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "anchor-cli ${options.anchorVersion}\\n"
  exit 0
fi
printf "%s\\n" "$*" >> "${buildMarker}"
exit 98
`,
    );
    chmodSync(anchorPath, 0o755);
  }

  try {
    const result = Bun.spawnSync({
      cmd: ["/bin/bash", buildScriptPath],
      cwd: path.join(packageRoot, "anchor"),
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        ...extraEnv,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    return {
      status: result.exitCode,
      buildWasInvoked: existsSync(buildMarker),
    };
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
  }
}

describe("Solana workspace build policy", () => {
  test("contains no host-generated fallback IDL implementation", () => {
    const source = readFileSync(buildScriptPath, "utf8");
    expect(source).not.toMatch(/generate_idl\s*\(/);
    expect(source).not.toContain("__anchor_private_print_idl_");
    expect(source).not.toContain("generate-anchor-types.mjs");
    expect(source).toContain('ANCHOR_CLI_VERSION="0.32.1"');
    const lockedBuildCommand =
      'anchor build --no-idl -- --tools-version "${TOOLS_VERSION}" -- --locked';
    expect(source.split(lockedBuildCommand).length - 1).toBe(2);
    expect(source).toContain('cd "${ROOT_DIR}"');
    expect(source).toContain(
      "Anchor CLI ${ANCHOR_CLI_VERSION} is required for canonical artifact generation",
    );
    expect(source).toContain("Anchor CLI version mismatch");
    expect(source).toContain(
      "cargo-build-sbf is required for binaries-only mode",
    );
  });

  test("keeps the validator harness on the canonical pinned build path", () => {
    const localnetHarness = readFileSync(
      path.join(packageRoot, "anchor", "scripts", "run-localnet-tests.sh"),
      "utf8",
    );
    expect(localnetHarness).toContain(
      'bash "$ROOT_DIR/scripts/build-workspace.sh"',
    );
    expect(localnetHarness).not.toMatch(/^\s*anchor build/m);
    expect(localnetHarness).toContain("tests/duel_market.anchor.ts::each");
    expect(localnetHarness).toContain("--dry-run");
    expect(localnetHarness).toContain(".tests[].fullTitle");
    expect(localnetHarness).toContain("--fail-zero");
    expect(localnetHarness).toContain("mocha_args+=(--bail)");
    expect(localnetHarness).toContain(
      "expanded $test_target into $isolated_count fresh-validator tests",
    );

    const forkRollbackHarness = readFileSync(
      path.join(packageRoot, "anchor", "scripts", "run-fork-rollback-test.sh"),
      "utf8",
    );
    expect(forkRollbackHarness).toContain(
      'TS_MOCHA_COMMAND=(bunx "ts-mocha@10.0.0")',
    );
    expect(forkRollbackHarness).toContain("--fail-zero");
    expect(forkRollbackHarness).toContain("--bail");
  });

  test("fails before work when canonical IDL generation has no Anchor CLI", () => {
    const result = runWithFakeToolchain(
      { hasBuildSbf: false },
      { HYPERBET_SOLANA_ALLOW_IDL_ONLY: "1" },
    );
    expect(result.status).not.toBe(0);
    expect(result.buildWasInvoked).toBe(false);
  });

  test("rejects a mismatched Anchor CLI before generating artifacts", () => {
    const result = runWithFakeToolchain(
      { anchorVersion: "9.9.9", hasBuildSbf: false },
      { HYPERBET_SOLANA_ALLOW_IDL_ONLY: "1" },
    );
    expect(result.status).not.toBe(0);
    expect(result.buildWasInvoked).toBe(false);
  });

  test("never treats IDL-only permission as permission to skip SBF binaries", () => {
    const result = runWithFakeToolchain(
      { hasBuildSbf: false },
      {
        HYPERBET_SOLANA_ALLOW_IDL_ONLY: "1",
        HYPERBET_SOLANA_BUILD_BINARIES_ONLY: "1",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.buildWasInvoked).toBe(false);
  });

  test("accepts only the exact warning set classified for each launch program", () => {
    const log = [
      classifiedWarningLog("fight_oracle"),
      classifiedWarningLog("duel_market"),
    ].join("\n");
    expect(auditSbfBuildLog(log, ["fight_oracle", "duel_market"])).toEqual([]);
  });

  test("rejects any newly undefined symbol", () => {
    const failures = auditSbfBuildLog(
      classifiedWarningLog("duel_market", ["sol_unclassified_syscall"]),
      ["duel_market"],
    );
    expect(failures.join("\n")).toContain(
      "unexpected undefined-symbol warning",
    );
    expect(failures.join("\n")).toContain("sol_unclassified_syscall");
  });

  test("rejects every unclassified compiler or SBF warning", () => {
    const failures = auditSbfBuildLog(
      `${classifiedWarningLog("fight_oracle")}\nwarning: unsafe optimization drift`,
      ["fight_oracle"],
    );
    expect(failures.join("\n")).toContain("unclassified SBF warning");
    expect(failures.join("\n")).toContain("unsafe optimization drift");
  });
});
