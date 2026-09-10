import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "run-railway-with-scoped-auth.sh",
);
const ownedDirectories = [];

function makeOwnedDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  ownedDirectories.push(directory);
  return directory;
}

function runScoped({ runnerTemp, invocationDirectory, token, command }) {
  const result = spawnSync("bash", [scriptPath, "bash", "-c", command], {
    cwd: invocationDirectory,
    env: {
      PATH: process.env.PATH ?? "",
      RUNNER_TEMP: runnerTemp,
      RAILWAY_TOKEN: token ?? "",
      RAILWAY_OBSERVATION_PATH: join(runnerTemp, "observation.txt"),
      EXPECTED_RAILWAY_TOKEN: token ?? "",
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

describe("scoped Railway authentication", () => {
  test("exposes the token only inside a private HOME and removes CLI context", () => {
    const runnerTemp = makeOwnedDirectory("railway-token-test-");
    const invocationDirectory = makeOwnedDirectory("railway-work-test-");
    const token = "test-railway-project-token";
    const result = runScoped({
      runnerTemp,
      invocationDirectory,
      token,
      command:
        'test "$RAILWAY_TOKEN" = "$EXPECTED_RAILWAY_TOKEN"; test "$XDG_CONFIG_HOME" = "$HOME/.config"; test "$XDG_DATA_HOME" = "$HOME/.local/share"; test "$XDG_STATE_HOME" = "$HOME/.local/state"; test "$XDG_CACHE_HOME" = "$HOME/.cache"; mkdir .railway; printf "%s" "project metadata only" > .railway/config.json; printf "%s" "$HOME" > "$RAILWAY_OBSERVATION_PATH"',
    });

    assert.equal(result.status, 0);
    const privateHome = readFileSync(
      join(runnerTemp, "observation.txt"),
      "utf8",
    );
    assert.equal(
      privateHome.startsWith(`${runnerTemp}/hyperbet-railway-auth.`),
      true,
    );
    assert.equal(existsSync(privateHome), false);
    assert.equal(existsSync(join(invocationDirectory, ".railway")), false);
    assert.doesNotMatch(result.stderr, new RegExp(token));
  });

  test("propagates command failure after cleaning every owned path", () => {
    const runnerTemp = makeOwnedDirectory("railway-failure-test-");
    const invocationDirectory = makeOwnedDirectory("railway-failure-work-");
    const result = runScoped({
      runnerTemp,
      invocationDirectory,
      token: "test-railway-token",
      command:
        'mkdir .railway; printf "%s" "$HOME" > "$RAILWAY_OBSERVATION_PATH"; exit 23',
    });

    assert.equal(result.status, 23);
    assert.equal(
      existsSync(readFileSync(join(runnerTemp, "observation.txt"), "utf8")),
      false,
    );
    assert.equal(existsSync(join(invocationDirectory, ".railway")), false);
  });

  test("fails closed and redacts a token persisted under the private home", () => {
    const runnerTemp = makeOwnedDirectory("railway-home-persistence-test-");
    const invocationDirectory = makeOwnedDirectory(
      "railway-home-persistence-work-",
    );
    const token = "test-home-persisted-token";
    const result = runScoped({
      runnerTemp,
      invocationDirectory,
      token,
      command:
        'printf "%s" "$HOME" > "$RAILWAY_OBSERVATION_PATH"; printf "%s" "$RAILWAY_TOKEN" > "$HOME/persisted-token"',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /persisted the Railway token/);
    assert.doesNotMatch(result.stderr, new RegExp(token));
    assert.equal(
      existsSync(readFileSync(join(runnerTemp, "observation.txt"), "utf8")),
      false,
    );
  });

  test("fails closed and removes a token persisted in local Railway context", () => {
    const runnerTemp = makeOwnedDirectory("railway-context-persistence-test-");
    const invocationDirectory = makeOwnedDirectory(
      "railway-context-persistence-work-",
    );
    const token = "test-context-persisted-token";
    const result = runScoped({
      runnerTemp,
      invocationDirectory,
      token,
      command:
        'mkdir .railway; printf "%s" "$RAILWAY_TOKEN" > .railway/config.json',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /persisted the Railway token/);
    assert.doesNotMatch(result.stderr, new RegExp(token));
    assert.equal(existsSync(join(invocationDirectory, ".railway")), false);
  });

  test("lets an audit command remove the token before invoking repository code", () => {
    const runnerTemp = makeOwnedDirectory("railway-unset-test-");
    const invocationDirectory = makeOwnedDirectory("railway-unset-work-");
    const result = runScoped({
      runnerTemp,
      invocationDirectory,
      token: "test-railway-token",
      command:
        'test -n "$RAILWAY_TOKEN"; unset RAILWAY_TOKEN; test -z "${RAILWAY_TOKEN:-}"; bash -c \'test -z "${RAILWAY_TOKEN:-}"\'',
    });

    assert.equal(result.status, 0);
  });

  test("rejects missing or malformed inputs before running a command", () => {
    const runnerTemp = makeOwnedDirectory("railway-input-test-");
    const invocationDirectory = makeOwnedDirectory("railway-input-work-");
    const missing = runScoped({
      runnerTemp,
      invocationDirectory,
      token: "",
      command: "exit 0",
    });
    const multiline = runScoped({
      runnerTemp,
      invocationDirectory,
      token: "line-one\nline-two",
      command: "exit 0",
    });
    const relativeRunnerTemp = spawnSync(
      "bash",
      [scriptPath, "bash", "-c", "exit 0"],
      {
        cwd: invocationDirectory,
        env: {
          PATH: process.env.PATH ?? "",
          RUNNER_TEMP: "relative-runner-temp",
          RAILWAY_TOKEN: "test-token",
        },
        encoding: "utf8",
      },
    );

    assert.equal(missing.status, 78);
    assert.equal(multiline.status, 78);
    assert.equal(relativeRunnerTemp.status, 78);
    assert.match(missing.stderr, /RAILWAY_TOKEN must be configured/);
    assert.match(multiline.stderr, /RAILWAY_TOKEN is malformed/);
    assert.match(relativeRunnerTemp.stderr, /RUNNER_TEMP must name/);
  });

  test("refuses a pre-existing local Railway context without deleting it", () => {
    const runnerTemp = makeOwnedDirectory("railway-context-guard-test-");
    const invocationDirectory = makeOwnedDirectory(
      "railway-context-guard-work-",
    );
    const contextDirectory = join(invocationDirectory, ".railway");
    mkdirSync(contextDirectory);
    const result = runScoped({
      runnerTemp,
      invocationDirectory,
      token: "test-token",
      command: "exit 0",
    });

    assert.equal(result.status, 78);
    assert.match(result.stderr, /Refusing pre-existing Railway context/);
    assert.equal(existsSync(contextDirectory), true);
  });
});
