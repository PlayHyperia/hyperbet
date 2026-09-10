#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prohibitedTerms = [
  ["hyper", "scape"].join(""),
  ["rune", "scape"].join(""),
  ["OS", "RS"].join(""),
];
const ignoredDirectories = new Set([
  ".anchor",
  ".ci-artifacts",
  ".git",
  ".ruff_cache",
  ".turbo",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "storybook-artifacts",
  "storybook-static",
  "target",
  "test-results",
  "vendor",
  "workspace-packages",
]);

function isIgnoredDirectory(name) {
  return ignoredDirectories.has(name) || /^node_modules [0-9]+$/u.test(name);
}

function isIgnoredPath(relativePath) {
  return relativePath
    .split(/[\\/]/u)
    .some(
      (segment) => isIgnoredDirectory(segment) || segment.startsWith(".e2e-"),
    );
}

function containsProhibitedTerm(value) {
  const normalized = value.toLowerCase();
  return prohibitedTerms.some((term) =>
    normalized.includes(term.toLowerCase()),
  );
}

function runGitPathList(args) {
  const result = spawnSync("git", ["ls-files", "-z", ...args], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `branding path inventory failed: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !isIgnoredPath(entry));
}

function scanWorkingTreePaths(paths) {
  if (paths.length === 0) return [];
  const args = ["-a", "-l", "-i"];
  for (const term of prohibitedTerms) {
    args.push("-e", term);
  }
  args.push("--", ...paths);
  const result = spawnSync("rg", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`branding overlay scan failed: ${result.stderr.trim()}`);
  }
  return result.status === 0
    ? result.stdout.split(/\r?\n/u).filter(Boolean)
    : [];
}

const trackedPaths = runGitPathList(["--cached"]);
const deletedPaths = new Set(runGitPathList(["--deleted"]));
const modifiedPaths = runGitPathList(["--modified"]).filter(
  (entry) => !deletedPaths.has(entry),
);
const untrackedPaths = runGitPathList(["--others", "--exclude-standard"]);
const overlayPaths = [...new Set([...modifiedPaths, ...untrackedPaths])];
const overlayPathSet = new Set(overlayPaths);
const currentPaths = [
  ...new Set([
    ...trackedPaths.filter((entry) => !deletedPaths.has(entry)),
    ...untrackedPaths,
  ]),
];

const indexArgs = ["grep", "--cached", "-a", "-l", "-i"];
for (const term of prohibitedTerms) {
  indexArgs.push("-e", term);
}
indexArgs.push("--", ".");

const indexContentScan = spawnSync("git", indexArgs, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (indexContentScan.error) throw indexContentScan.error;
if (indexContentScan.status !== 0 && indexContentScan.status !== 1) {
  throw new Error(
    `branding index scan failed: ${indexContentScan.stderr.trim()}`,
  );
}

const indexViolations =
  indexContentScan.status === 0
    ? indexContentScan.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .filter(
          (entry) =>
            !isIgnoredPath(entry) &&
            !deletedPaths.has(entry) &&
            !overlayPathSet.has(entry),
        )
    : [];
const contentViolations = [
  ...new Set([...indexViolations, ...scanWorkingTreePaths(overlayPaths)]),
].sort();
const pathViolations = currentPaths
  .filter((entry) => containsProhibitedTerm(entry))
  .sort();

if (contentViolations.length > 0 || pathViolations.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        contentViolations,
        pathViolations,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    prohibitedTerms: prohibitedTerms.length,
    trackedIndexContentScan: true,
    modifiedAndUntrackedBinaryContentScan: true,
    releaseCandidatePathScan: true,
  }),
);
