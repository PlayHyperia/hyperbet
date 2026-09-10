import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "run-wrangler-with-scoped-auth.sh",
);
const ownedDirectories = [];

function makeOwnedDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  ownedDirectories.push(directory);
  return directory;
}

function runScoped(runnerTemp, credentials, command) {
  const result = spawnSync("bash", [scriptPath, "bash", "-c", command], {
    env: {
      PATH: process.env.PATH ?? "",
      RUNNER_TEMP: runnerTemp,
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_WRANGLER_CONFIG_B64: "",
      ...credentials,
    },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return result;
}

afterEach(() => {
  for (const directory of ownedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("scoped Wrangler authentication", () => {
  test("exposes an API token only to the command and removes its private home", () => {
    const runnerTemp = makeOwnedDirectory("wrangler-token-test-");
    const observationPath = join(runnerTemp, "observation.txt");
    const token = "test-cloudflare-api-token";
    const result = runScoped(
      runnerTemp,
      {
        CLOUDFLARE_API_TOKEN: token,
        WRANGLER_OBSERVATION_PATH: observationPath,
        EXPECTED_CLOUDFLARE_API_TOKEN: token,
      },
      'test "$CLOUDFLARE_API_TOKEN" = "$EXPECTED_CLOUDFLARE_API_TOKEN" && test -z "${CLOUDFLARE_WRANGLER_CONFIG_B64:-}" && printf "%s" "$HOME" > "$WRANGLER_OBSERVATION_PATH"',
    );

    assert.equal(result.status, 0);
    const privateHome = readFileSync(observationPath, "utf8");
    assert.equal(
      privateHome.startsWith(`${runnerTemp}/hyperbet-wrangler-auth.`),
      true,
    );
    assert.equal(existsSync(privateHome), false);
    assert.doesNotMatch(result.stderr, new RegExp(token));
  });

  test("decodes a legacy config with mode 0600 and removes it after use", () => {
    const runnerTemp = makeOwnedDirectory("wrangler-config-test-");
    const observationPath = join(runnerTemp, "observation.txt");
    const config = '[default]\napi_token = "test-config-token"\n';
    const result = runScoped(
      runnerTemp,
      {
        CLOUDFLARE_WRANGLER_CONFIG_B64: Buffer.from(config).toString("base64"),
        EXPECTED_WRANGLER_CONFIG: config,
        WRANGLER_OBSERVATION_PATH: observationPath,
      },
      'config_path="$HOME/.wrangler/config/default.toml"; test -s "$config_path"; test "$(cat "$config_path")" = "$(printf "%s" "$EXPECTED_WRANGLER_CONFIG")"; config_mode="$(stat -f "%Lp" "$config_path" 2>/dev/null || stat -c "%a" "$config_path")"; test "$config_mode" = "600"; test -z "${CLOUDFLARE_WRANGLER_CONFIG_B64:-}"; printf "%s" "$HOME" > "$WRANGLER_OBSERVATION_PATH"',
    );

    assert.equal(result.status, 0);
    const privateHome = readFileSync(observationPath, "utf8");
    assert.equal(existsSync(privateHome), false);
    assert.doesNotMatch(result.stderr, /test-config-token/);
  });

  test("rejects missing or ambiguous credential sources", () => {
    const runnerTemp = makeOwnedDirectory("wrangler-source-test-");
    const missing = runScoped(runnerTemp, {}, "exit 0");
    const ambiguous = runScoped(
      runnerTemp,
      {
        CLOUDFLARE_API_TOKEN: "test-token",
        CLOUDFLARE_WRANGLER_CONFIG_B64:
          Buffer.from("test-config").toString("base64"),
      },
      "exit 0",
    );

    assert.equal(missing.status, 78);
    assert.equal(ambiguous.status, 78);
    assert.match(missing.stderr, /Exactly one Cloudflare credential source/);
    assert.match(ambiguous.stderr, /Exactly one Cloudflare credential source/);
    assert.doesNotMatch(ambiguous.stderr, /test-token/);
  });

  test("propagates command failure and still removes the private home", () => {
    const runnerTemp = makeOwnedDirectory("wrangler-failure-test-");
    const observationPath = join(runnerTemp, "observation.txt");
    const result = runScoped(
      runnerTemp,
      {
        CLOUDFLARE_API_TOKEN: "test-token",
        WRANGLER_OBSERVATION_PATH: observationPath,
      },
      'printf "%s" "$HOME" > "$WRANGLER_OBSERVATION_PATH"; exit 23',
    );

    assert.equal(result.status, 23);
    assert.equal(existsSync(readFileSync(observationPath, "utf8")), false);
  });

  test("fails closed if the command persists the API token", () => {
    const runnerTemp = makeOwnedDirectory("wrangler-persistence-test-");
    const observationPath = join(runnerTemp, "observation.txt");
    const token = "test-persisted-token";
    const result = runScoped(
      runnerTemp,
      {
        CLOUDFLARE_API_TOKEN: token,
        WRANGLER_OBSERVATION_PATH: observationPath,
      },
      'printf "%s" "$HOME" > "$WRANGLER_OBSERVATION_PATH"; printf "%s" "$CLOUDFLARE_API_TOKEN" > "$HOME/persisted-token"',
    );

    assert.equal(result.status, 1);
    assert.equal(existsSync(readFileSync(observationPath, "utf8")), false);
    assert.match(result.stderr, /persisted the Cloudflare API token/);
    assert.doesNotMatch(result.stderr, new RegExp(token));
  });

  test("rejects an invalid RUNNER_TEMP before creating credentials", () => {
    const result = spawnSync("bash", [scriptPath, "bash", "-c", "exit 0"], {
      env: {
        PATH: process.env.PATH ?? "",
        RUNNER_TEMP: "relative-runner-temp",
        CLOUDFLARE_API_TOKEN: "test-token",
        CLOUDFLARE_WRANGLER_CONFIG_B64: "",
      },
      encoding: "utf8",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 78);
    assert.match(
      result.stderr,
      /RUNNER_TEMP must name an existing private temporary directory/,
    );
  });
});
