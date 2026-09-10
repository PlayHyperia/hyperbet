import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolvePagesDeploymentOutput,
  serializePagesDeploymentOutput,
} from "./ci-solana-pages-deployment-output.mjs";

const scriptPath = fileURLToPath(
  new URL("./ci-solana-pages-deployment-output.mjs", import.meta.url),
);
const commitSha = "0123456789abcdef0123456789abcdef01234567";

function productionInput(overrides = {}) {
  return {
    expectedCommitSha: commitSha,
    expectedEnvironment: "production",
    expectedBranch: "main",
    expectedProjectName: "hyperia-betting",
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    Id: "c2f6b611-1fc1-4aa6-8ce4-53aa4b73f42e",
    Environment: "production",
    Branch: "main",
    Source: commitSha.slice(0, 7),
    Deployment: "https://c2f6b611.hyperia-betting.pages.dev",
    Status: "Success",
    ...overrides,
  };
}

describe("Solana Pages deployment-list output resolver", () => {
  it("selects the first provider-ordered exact deployment", () => {
    const result = resolvePagesDeploymentOutput({
      rawJson: JSON.stringify([
        deployment(),
        deployment({
          Id: "82ef8fd8-dc3a-427c-a615-4ab188044534",
          Deployment: "https://82ef8fd8.hyperia-betting.pages.dev",
        }),
      ]),
      ...productionInput(),
    });
    assert.deepEqual(result, {
      deployed_url: "https://c2f6b611.hyperia-betting.pages.dev",
    });
  });

  it("ignores nonmatching source, environment, and branch rows", () => {
    const result = resolvePagesDeploymentOutput({
      rawJson: JSON.stringify([
        deployment({ Source: "fffffff" }),
        deployment({ Environment: "preview" }),
        deployment({ Branch: "release" }),
        deployment(),
      ]),
      ...productionInput(),
    });
    assert.equal(
      result.deployed_url,
      "https://c2f6b611.hyperia-betting.pages.dev",
    );
  });

  it("accepts the exact staging preview rail and project", () => {
    const result = resolvePagesDeploymentOutput({
      rawJson: JSON.stringify([
        deployment({
          Environment: "preview",
          Branch: "staging",
          Deployment: "https://c2f6b611.hyperia-betting-staging.pages.dev",
        }),
      ]),
      expectedCommitSha: commitSha,
      expectedEnvironment: "preview",
      expectedBranch: "staging",
      expectedProjectName: "hyperia-betting-staging",
    });
    assert.equal(
      result.deployed_url,
      "https://c2f6b611.hyperia-betting-staging.pages.dev",
    );
  });

  it("rejects malformed, oversized, empty, and unmatched provider output", () => {
    for (const rawJson of [
      "not-json",
      "{}",
      "[]",
      " ".repeat(1_048_577),
      JSON.stringify(Array.from({ length: 101 }, () => deployment())),
      JSON.stringify([deployment({ Source: "fffffff" })]),
    ]) {
      assert.throws(() =>
        resolvePagesDeploymentOutput({
          rawJson,
          ...productionInput(),
        }),
      );
    }
  });

  it("rejects invalid expected identity before inspecting output", () => {
    for (const overrides of [
      { expectedCommitSha: "0123456" },
      { expectedEnvironment: "staging" },
      { expectedBranch: "main\nPATH=/tmp/bin" },
      { expectedProjectName: "Unsafe Project" },
    ]) {
      assert.throws(() =>
        resolvePagesDeploymentOutput({
          rawJson: JSON.stringify([deployment()]),
          ...productionInput(overrides),
        }),
      );
    }
  });

  it("rejects unsafe exact-match URLs and validates every exact match", () => {
    for (const unsafeDeployment of [
      "http://c2f6b611.hyperia-betting.pages.dev",
      "https://user:secret@c2f6b611.hyperia-betting.pages.dev",
      "https://c2f6b611.attacker.example",
      "https://c2f6b611.hyperia-betting.pages.dev/path",
      "https://c2f6b611.hyperia-betting.pages.dev/?token=secret",
      "https://c2f6b611.hyperia-betting.pages.dev/#fragment",
      "https://c2f6b611.hyperia-betting.pages.dev\nDEPLOYED_URL=https://attacker.example",
    ]) {
      assert.throws(() =>
        resolvePagesDeploymentOutput({
          rawJson: JSON.stringify([
            deployment(),
            deployment({ Deployment: unsafeDeployment }),
          ]),
          ...productionInput(),
        }),
      );
    }
  });

  it("serializes one safe GitHub output and emits no partial CLI output", () => {
    const resolved = resolvePagesDeploymentOutput({
      rawJson: JSON.stringify([deployment()]),
      ...productionInput(),
    });
    assert.equal(
      serializePagesDeploymentOutput(resolved),
      "deployed_url=https://c2f6b611.hyperia-betting.pages.dev\n",
    );

    const validCli = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      input: JSON.stringify([deployment()]),
      env: {
        ...process.env,
        EXPECTED_COMMIT_SHA: commitSha,
        EXPECTED_PAGES_ENVIRONMENT: "production",
        EXPECTED_PAGES_BRANCH: "main",
        EXPECTED_PAGES_PROJECT_NAME: "hyperia-betting",
      },
    });
    assert.equal(validCli.status, 0);
    assert.equal(validCli.stderr, "");
    assert.equal(validCli.stdout, serializePagesDeploymentOutput(resolved));

    const invalidCli = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      input: JSON.stringify([
        deployment({
          Deployment:
            "https://safe.hyperia-betting.pages.dev\nTOKEN=secret-value",
        }),
      ]),
      env: {
        ...process.env,
        EXPECTED_COMMIT_SHA: commitSha,
        EXPECTED_PAGES_ENVIRONMENT: "production",
        EXPECTED_PAGES_BRANCH: "main",
        EXPECTED_PAGES_PROJECT_NAME: "hyperia-betting",
      },
    });
    assert.notEqual(invalidCli.status, 0);
    assert.equal(invalidCli.stdout, "");
    assert.match(
      invalidCli.stderr,
      /Pages deployment output resolution failed/,
    );
    assert.equal(invalidCli.stderr.includes("TOKEN"), false);
    assert.equal(invalidCli.stderr.includes("secret-value"), false);
  });
});
