#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ACTIVE_SOL_MANIFESTS } from "./check-sol-dependency-policy.mjs";

const REVIEWED_OPTIONAL_TOOLING_FINDINGS = new Set([
  "image-size:GHSA-5p2g-fcmc-qvqq",
  "image-size:GHSA-w3rx-r6r6-pgpr",
]);
const HIGH_SEVERITIES = new Set(["high", "critical"]);
const REQUIRED_OPTIONAL_PATH_MARKERS = [
  "image-size@",
  "metro@",
  "react-native@",
  "@solana-mobile/wallet-standard-mobile@",
  "@solana/connector@",
];
const PATCHED_TOML_VERSION = "4.2.0";

export function validatePatchedTomlGraph({
  rootManifest,
  anchorManifest,
  rootLock,
  anchorLock,
}) {
  const violations = [];
  if (rootManifest?.overrides?.toml !== PATCHED_TOML_VERSION) {
    violations.push("root manifest does not pin patched toml 4.2.0");
  }
  if (anchorManifest?.overrides?.toml !== PATCHED_TOML_VERSION) {
    violations.push("Anchor manifest does not pin patched toml 4.2.0");
  }
  for (const [label, lock] of [
    ["root", rootLock],
    ["Anchor", anchorLock],
  ]) {
    if (
      typeof lock !== "string" ||
      !lock.includes('"toml": "4.2.0"') ||
      !lock.includes('"toml": ["toml@4.2.0"')
    ) {
      violations.push(`${label} lock does not resolve patched toml 4.2.0`);
    }
  }
  return violations;
}

export function classifyHighSeverityFindings(auditReport) {
  const reviewed = [];
  const blocking = [];

  for (const [packageName, advisories] of Object.entries(auditReport)) {
    if (!Array.isArray(advisories)) continue;
    for (const advisory of advisories) {
      if (!HIGH_SEVERITIES.has(advisory?.severity)) continue;
      const ghsaId =
        typeof advisory?.url === "string"
          ? advisory.url.match(/(GHSA-[a-z0-9-]+)$/iu)?.[1]
          : null;
      const finding = {
        packageName,
        ghsaId,
        severity: advisory?.severity ?? null,
        title: advisory?.title ?? null,
      };
      const policyKey = ghsaId ? `${packageName}:${ghsaId}` : null;
      if (policyKey && REVIEWED_OPTIONAL_TOOLING_FINDINGS.has(policyKey)) {
        reviewed.push(finding);
      } else {
        blocking.push(finding);
      }
    }
  }

  return { reviewed, blocking };
}

export function validateOptionalImageToolingPath(output) {
  return REQUIRED_OPTIONAL_PATH_MARKERS.filter(
    (marker) => !output.includes(marker),
  );
}

function assertImageSizeIsNotDirect(rootDir) {
  for (const relativePath of ACTIVE_SOL_MANIFESTS) {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(rootDir, relativePath), "utf8"),
    );
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "overrides",
    ]) {
      if (manifest[section]?.["image-size"] !== undefined) {
        throw new Error(
          `${relativePath} must not directly declare or override image-size`,
        );
      }
    }
  }
}

function parseAuditJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("bun audit did not return a JSON report");
  }
  return JSON.parse(output.slice(start, end + 1));
}

function run() {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  assertImageSizeIsNotDirect(rootDir);
  const anchorDir = path.join(rootDir, "packages", "hyperbet-solana", "anchor");
  const tomlViolations = validatePatchedTomlGraph({
    rootManifest: JSON.parse(
      fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
    ),
    anchorManifest: JSON.parse(
      fs.readFileSync(path.join(anchorDir, "package.json"), "utf8"),
    ),
    rootLock: fs.readFileSync(path.join(rootDir, "bun.lock"), "utf8"),
    anchorLock: fs.readFileSync(path.join(anchorDir, "bun.lock"), "utf8"),
  });
  if (tomlViolations.length > 0) {
    throw new Error(`patched TOML policy failed: ${tomlViolations.join("; ")}`);
  }

  const audit = spawnSync("bun", ["audit", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (audit.error) throw audit.error;

  let report;
  try {
    report = parseAuditJson(`${audit.stdout ?? ""}${audit.stderr ?? ""}`);
  } catch (error) {
    throw new Error(
      `unable to parse bun audit output (status=${String(audit.status)}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const findings = classifyHighSeverityFindings(report);
  if (findings.blocking.length > 0) {
    throw new Error(
      `unreviewed high/critical dependency findings: ${JSON.stringify(findings.blocking)}`,
    );
  }

  if (findings.reviewed.length > 0) {
    const why = spawnSync("bun", ["pm", "why", "image-size"], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (why.error) throw why.error;
    if (why.status !== 0) {
      throw new Error(
        `unable to prove the reviewed image-size dependency path (status=${String(why.status)})`,
      );
    }
    const missingMarkers = validateOptionalImageToolingPath(
      `${why.stdout ?? ""}${why.stderr ?? ""}`,
    );
    if (missingMarkers.length > 0) {
      throw new Error(
        `reviewed image-size dependency escaped its optional ConnectorKit mobile/Metro path; missing ${missingMarkers.join(", ")}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      blockingHighOrCritical: 0,
      reviewedOptionalTooling: findings.reviewed.map(
        ({ packageName, ghsaId }) => `${packageName}:${ghsaId}`,
      ),
    }),
  );
}

function isMainModule() {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

if (isMainModule()) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
