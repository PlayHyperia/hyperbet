import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScript = fileURLToPath(
  new URL("./check-legacy-branding.mjs", import.meta.url),
);
const prohibitedTerm = ["hyper", "scape"].join("");

function run(repo, command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function createRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "hyperbet-branding-gate-"));
  mkdirSync(path.join(repo, "scripts"));
  copyFileSync(
    sourceScript,
    path.join(repo, "scripts/check-legacy-branding.mjs"),
  );
  assert.equal(run(repo, "git", ["init", "-q"]).status, 0);
  writeFileSync(path.join(repo, "README.md"), "Hyperia launch\n");
  assert.equal(run(repo, "git", ["add", "."]).status, 0);
  return repo;
}

function runGate(repo) {
  return run(repo, process.execPath, ["scripts/check-legacy-branding.mjs"]);
}

test("branding gate accepts one clean indexed release candidate", () => {
  const repo = createRepo();
  try {
    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"trackedIndexContentScan":true/u);
    assert.match(result.stdout, /"releaseCandidatePathScan":true/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branding gate checks modified and untracked binary content", () => {
  const repo = createRepo();
  try {
    writeFileSync(path.join(repo, "README.md"), `${prohibitedTerm}\n`);
    const modified = runGate(repo);
    assert.equal(modified.status, 1);
    assert.match(modified.stderr, /README\.md/u);

    writeFileSync(path.join(repo, "README.md"), "Hyperia launch\n");
    writeFileSync(
      path.join(repo, "untracked.bin"),
      Buffer.from([0, ...Buffer.from(prohibitedTerm), 0]),
    );
    const untracked = runGate(repo);
    assert.equal(untracked.status, 1);
    assert.match(untracked.stderr, /untracked\.bin/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branding gate checks release-candidate paths without traversing ignored trees", () => {
  const repo = createRepo();
  try {
    writeFileSync(
      path.join(repo, `${prohibitedTerm}.txt`),
      "neutral content\n",
    );
    const violatingPath = runGate(repo);
    assert.equal(violatingPath.status, 1);
    assert.match(
      violatingPath.stderr,
      new RegExp(`${prohibitedTerm}\\.txt`, "u"),
    );

    rmSync(path.join(repo, `${prohibitedTerm}.txt`));
    mkdirSync(path.join(repo, "node_modules 2"));
    writeFileSync(
      path.join(repo, "node_modules 2/ignored.txt"),
      `${prohibitedTerm}\n`,
    );
    const ignored = runGate(repo);
    assert.equal(ignored.status, 0, ignored.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branding gate does not resurrect an indexed file deleted from the candidate", () => {
  const repo = createRepo();
  try {
    const deletedPath = path.join(repo, "deleted.txt");
    writeFileSync(deletedPath, `${prohibitedTerm}\n`);
    assert.equal(run(repo, "git", ["add", "deleted.txt"]).status, 0);
    rmSync(deletedPath);

    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
