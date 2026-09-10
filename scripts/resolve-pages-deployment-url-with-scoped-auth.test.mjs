import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL(
    "./resolve-pages-deployment-url-with-scoped-auth.sh",
    import.meta.url,
  ),
);
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const token = "test-cloudflare-token-never-print";

function runFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "hyperbet-pages-output-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner-temp");
  const outputPath = join(root, "github-output");
  const argsPath = join(root, "wrangler-args");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(outputPath, "", { mode: 0o600 });
  const fakeWrangler = join(bin, "wrangler");
  writeFileSync(
    fakeWrangler,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"\${WRANGLER_ARGS_FILE}"
if [ "\${WRANGLER_PERSIST_TOKEN:-false}" = "true" ]; then
  mkdir -p "\${HOME}/.config"
  printf '%s' "\${CLOUDFLARE_API_TOKEN}" >"\${HOME}/.config/persisted-token"
fi
printf '%s' "\${WRANGLER_STDOUT:-}"
exit "\${WRANGLER_EXIT_CODE:-0}"
`,
    { mode: 0o700 },
  );
  chmodSync(fakeWrangler, 0o700);

  const expectedJson = JSON.stringify([
    {
      Environment: "production",
      Branch: "main",
      Source: commitSha.slice(0, 7),
      Deployment: "https://c2f6b611.hyperia-betting.pages.dev",
    },
  ]);
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputPath,
      GITHUB_SHA: commitSha,
      DEPLOY_TARGET: "production",
      PAGES_PROJECT_NAME: "hyperia-betting",
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_WRANGLER_CONFIG_B64: "",
      WRANGLER_ARGS_FILE: argsPath,
      WRANGLER_STDOUT: expectedJson,
      ...options.env,
    },
  });
  return {
    root,
    runnerTemp,
    outputPath,
    argsPath,
    result,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ownedTemporaryEntries(runnerTemp) {
  return readdirSync(runnerTemp).filter(
    (name) =>
      name.startsWith("hyperbet-pages-deployments.") ||
      name.startsWith("hyperbet-pages-deployment-output.") ||
      name.startsWith("hyperbet-wrangler-auth."),
  );
}

describe("scoped Pages deployment URL resolution", () => {
  it("writes one validated output and removes every private temporary path", () => {
    const fixture = runFixture();
    try {
      assert.equal(fixture.result.status, 0, fixture.result.stderr);
      assert.equal(fixture.result.stdout, "");
      assert.equal(fixture.result.stderr, "");
      assert.equal(
        readFileSync(fixture.outputPath, "utf8"),
        "deployed_url=https://c2f6b611.hyperia-betting.pages.dev\n",
      );
      assert.deepEqual(readFileSync(fixture.argsPath, "utf8").split("\n"), [
        "pages",
        "deployment",
        "list",
        "--project-name",
        "hyperia-betting",
        "--environment",
        "production",
        "--json",
        "",
      ]);
      assert.deepEqual(ownedTemporaryEntries(fixture.runnerTemp), []);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves Wrangler failure and leaves GitHub output untouched", () => {
    const fixture = runFixture({
      env: { WRANGLER_EXIT_CODE: "42", WRANGLER_STDOUT: "" },
    });
    try {
      assert.equal(fixture.result.status, 42);
      assert.equal(readFileSync(fixture.outputPath, "utf8"), "");
      assert.deepEqual(ownedTemporaryEntries(fixture.runnerTemp), []);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects malformed provider output without leaking it or the token", () => {
    const fixture = runFixture({
      env: {
        WRANGLER_STDOUT: JSON.stringify([
          {
            Environment: "production",
            Branch: "main",
            Source: commitSha.slice(0, 7),
            Deployment:
              "https://safe.hyperia-betting.pages.dev\nTOKEN=provider-secret",
          },
        ]),
      },
    });
    try {
      assert.notEqual(fixture.result.status, 0);
      assert.equal(readFileSync(fixture.outputPath, "utf8"), "");
      assert.equal(fixture.result.stderr.includes("provider-secret"), false);
      assert.equal(fixture.result.stderr.includes(token), false);
      assert.deepEqual(ownedTemporaryEntries(fixture.runnerTemp), []);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects credential persistence before parsing provider output", () => {
    const fixture = runFixture({
      env: { WRANGLER_PERSIST_TOKEN: "true" },
    });
    try {
      assert.notEqual(fixture.result.status, 0);
      assert.equal(readFileSync(fixture.outputPath, "utf8"), "");
      assert.match(fixture.result.stderr, /persisted the Cloudflare API token/);
      assert.equal(fixture.result.stderr.includes(token), false);
      assert.deepEqual(ownedTemporaryEntries(fixture.runnerTemp), []);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an unsafe GitHub output path before invoking Wrangler", () => {
    const fixture = runFixture();
    try {
      const target = join(fixture.root, "redirect-target");
      writeFileSync(target, "", { mode: 0o600 });
      rmSync(fixture.outputPath);
      rmSync(fixture.argsPath, { force: true });
      symlinkSync(target, fixture.outputPath);
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(fixture.root, "bin")}:${process.env.PATH}`,
          RUNNER_TEMP: fixture.runnerTemp,
          GITHUB_OUTPUT: fixture.outputPath,
          GITHUB_SHA: commitSha,
          DEPLOY_TARGET: "production",
          PAGES_PROJECT_NAME: "hyperia-betting",
          CLOUDFLARE_API_TOKEN: token,
          CLOUDFLARE_WRANGLER_CONFIG_B64: "",
          WRANGLER_ARGS_FILE: fixture.argsPath,
        },
      });
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(target, "utf8"), "");
      assert.equal(existsSync(fixture.argsPath), false);
    } finally {
      fixture.cleanup();
    }
  });
});
