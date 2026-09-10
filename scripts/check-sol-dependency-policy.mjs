#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACTIVE_SOL_MANIFESTS = Object.freeze([
  "package.json",
  "packages/hyperbet-solana/package.json",
  "packages/hyperbet-solana/anchor/package.json",
  "packages/hyperbet-solana/app/package.json",
  "packages/hyperbet-solana/keeper/package.json",
  "packages/hyperbet-sdk/package.json",
  "packages/hyperbet-ui/package.json",
]);
export const ACTIVE_SOL_WORKSPACES = Object.freeze([
  "packages/hyperbet-solana",
  "packages/hyperbet-solana/app",
  "packages/hyperbet-solana/keeper",
  "packages/hyperbet-sdk",
  "packages/hyperbet-ui",
]);

const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
]);
const EXACT_SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_WORKSPACE = "workspace:*";
const EXPECTED_PACKAGE_MANAGER = "bun@1.3.6";

export function auditWorkspaceGraph(rootManifest, lockfile) {
  const violations = [];
  if (
    JSON.stringify(rootManifest.workspaces) !==
    JSON.stringify(ACTIVE_SOL_WORKSPACES)
  ) {
    violations.push({
      file: "package.json",
      section: "workspaces",
      dependency: null,
      specifier: rootManifest.workspaces ?? null,
      reason: `workspaces must be the exact SOL-only launch allowlist: ${ACTIVE_SOL_WORKSPACES.join(", ")}`,
    });
  }

  const lockfileWorkspacePaths = Array.from(
    new Set(
      Array.from(
        lockfile.matchAll(/workspace:(packages\/[^"\s,\]]+)/gu),
        (match) => match[1],
      ),
    ),
  ).sort();
  const expectedLockfileWorkspacePaths = [...ACTIVE_SOL_WORKSPACES].sort();
  if (
    JSON.stringify(lockfileWorkspacePaths) !==
    JSON.stringify(expectedLockfileWorkspacePaths)
  ) {
    violations.push({
      file: "bun.lock",
      section: "workspaces",
      dependency: null,
      specifier: lockfileWorkspacePaths,
      reason: `lockfile workspace graph must contain only: ${expectedLockfileWorkspacePaths.join(", ")}`,
    });
  }

  return { violations };
}

export function auditManifest(relativePath, manifest) {
  const violations = [];
  let checkedDependencies = 0;

  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (
      dependencies === null ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      violations.push({
        file: relativePath,
        section,
        dependency: null,
        specifier: null,
        reason: "dependency section must be an object",
      });
      continue;
    }

    for (const [dependency, specifier] of Object.entries(dependencies)) {
      checkedDependencies += 1;
      if (typeof specifier !== "string") {
        violations.push({
          file: relativePath,
          section,
          dependency,
          specifier,
          reason: "dependency specifier must be a string",
        });
        continue;
      }
      if (specifier === EXACT_WORKSPACE) continue;
      if (!EXACT_SEMVER.test(specifier)) {
        violations.push({
          file: relativePath,
          section,
          dependency,
          specifier,
          reason: "external dependency must use an exact semver",
        });
      }
    }
  }

  return { checkedDependencies, violations };
}

export function auditSolDependencyPolicy(rootDir) {
  const violations = [];
  let checkedDependencies = 0;

  for (const relativePath of ACTIVE_SOL_MANIFESTS) {
    const absolutePath = path.resolve(rootDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      violations.push({
        file: relativePath,
        section: null,
        dependency: null,
        specifier: null,
        reason: "active SOL manifest is missing",
      });
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    } catch (error) {
      violations.push({
        file: relativePath,
        section: null,
        dependency: null,
        specifier: null,
        reason: `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const result = auditManifest(relativePath, manifest);
    checkedDependencies += result.checkedDependencies;
    violations.push(...result.violations);

    if (
      relativePath === "package.json" &&
      manifest.packageManager !== EXPECTED_PACKAGE_MANAGER
    ) {
      violations.push({
        file: relativePath,
        section: "packageManager",
        dependency: "bun",
        specifier: manifest.packageManager ?? null,
        reason: `package manager must be ${EXPECTED_PACKAGE_MANAGER}`,
      });
    }
    if (relativePath === "package.json") {
      const lockfilePath = path.resolve(rootDir, "bun.lock");
      if (!fs.existsSync(lockfilePath)) {
        violations.push({
          file: "bun.lock",
          section: "workspaces",
          dependency: null,
          specifier: null,
          reason: "lockfile is missing",
        });
      } else {
        violations.push(
          ...auditWorkspaceGraph(
            manifest,
            fs.readFileSync(lockfilePath, "utf8"),
          ).violations,
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    checkedManifests: ACTIVE_SOL_MANIFESTS.length,
    checkedDependencies,
    violations,
  };
}

function isMainModule() {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

if (isMainModule()) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = auditSolDependencyPolicy(rootDir);
  const writer = result.ok ? console.log : console.error;
  writer(JSON.stringify(result, null, result.ok ? 0 : 2));
  if (!result.ok) process.exitCode = 1;
}
