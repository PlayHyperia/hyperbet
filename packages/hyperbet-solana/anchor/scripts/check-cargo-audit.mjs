import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const REVIEWED_INFORMATIONAL_WARNINGS = Object.freeze([
  {
    kind: "unmaintained",
    advisoryId: "RUSTSEC-2025-0141",
    packageName: "bincode",
    packageVersion: "1.3.3",
    active: true,
  },
  {
    kind: "unmaintained",
    advisoryId: "RUSTSEC-2026-0247",
    packageName: "bitmaps",
    packageVersion: "2.1.0",
    active: false,
  },
  {
    kind: "unmaintained",
    advisoryId: "RUSTSEC-2026-0248",
    packageName: "im",
    packageVersion: "15.1.0",
    active: false,
  },
  {
    kind: "unmaintained",
    advisoryId: "RUSTSEC-2026-0251",
    packageName: "sized-chunks",
    packageVersion: "0.6.5",
    active: false,
  },
  {
    kind: "unsound",
    advisoryId: "RUSTSEC-2023-0126",
    packageName: "im",
    packageVersion: "15.1.0",
    active: false,
  },
  {
    kind: "unsound",
    advisoryId: "RUSTSEC-2026-0186",
    packageName: "memmap2",
    packageVersion: "0.5.10",
    active: false,
  },
  {
    kind: "unsound",
    advisoryId: "RUSTSEC-2026-0255",
    packageName: "sized-chunks",
    packageVersion: "0.6.5",
    active: false,
  },
]);

function warningIdentity(warning) {
  return [
    warning.kind,
    warning.advisoryId,
    warning.packageName,
    warning.packageVersion,
  ].join(":");
}

export function activePackageCoordinates(metadata) {
  const packageById = new Map(
    (metadata.packages ?? []).map((entry) => [entry.id, entry]),
  );
  const active = new Set();
  for (const node of metadata.resolve?.nodes ?? []) {
    const packageEntry = packageById.get(node.id);
    if (packageEntry) {
      active.add(`${packageEntry.name}@${packageEntry.version}`);
    }
  }
  return active;
}

export function evaluateCargoAuditReport(report, metadata) {
  const violations = [];
  const reviewedWarnings = [];
  const activeCoordinates = activePackageCoordinates(metadata);

  if (!(Number(report.database?.["advisory-count"]) > 0)) {
    violations.push("cargo-audit report has no advisory database identity");
  }
  if (!(Number(report.lockfile?.["dependency-count"]) > 0)) {
    violations.push(
      "cargo-audit report has no audited lockfile dependency count",
    );
  }

  for (const vulnerability of report.vulnerabilities?.list ?? []) {
    const advisoryId = vulnerability.advisory?.id ?? "unknown-advisory";
    const packageName = vulnerability.package?.name ?? "unknown-package";
    const packageVersion = vulnerability.package?.version ?? "unknown-version";
    violations.push(
      `vulnerability ${advisoryId} affects ${packageName}@${packageVersion}`,
    );
  }

  const seenWarnings = new Set();
  for (const [kind, entries] of Object.entries(report.warnings ?? {})) {
    for (const entry of entries ?? []) {
      const warning = {
        kind,
        advisoryId: entry.advisory?.id ?? null,
        packageName: entry.package?.name ?? null,
        packageVersion: entry.package?.version ?? null,
      };
      const identity = warningIdentity(warning);
      if (seenWarnings.has(identity)) {
        violations.push(`duplicate cargo-audit warning ${identity}`);
        continue;
      }
      seenWarnings.add(identity);

      const reviewed = REVIEWED_INFORMATIONAL_WARNINGS.find(
        (candidate) => warningIdentity(candidate) === identity,
      );
      if (!reviewed) {
        violations.push(`unreviewed cargo-audit warning ${identity}`);
        continue;
      }

      const coordinate = `${warning.packageName}@${warning.packageVersion}`;
      const isActive = activeCoordinates.has(coordinate);
      if (isActive !== reviewed.active) {
        violations.push(
          `reviewed warning ${identity} expected active=${reviewed.active} but active=${isActive}`,
        );
        continue;
      }
      reviewedWarnings.push(`${identity}:active=${isActive}`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    reviewedWarnings: reviewedWarnings.sort(),
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} JSON at ${filePath}`, {
      cause: error,
    });
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const [reportPath, metadataPath, rawAuditStatus] = argv;
  if (!reportPath || !metadataPath || rawAuditStatus == null) {
    throw new Error(
      "usage: check-cargo-audit.mjs <audit.json> <metadata.json> <audit-status>",
    );
  }
  const auditStatus = Number(rawAuditStatus);
  if (!Number.isInteger(auditStatus) || auditStatus < 0 || auditStatus > 1) {
    throw new Error(
      `cargo audit exited unexpectedly with status ${rawAuditStatus}`,
    );
  }

  const result = evaluateCargoAuditReport(
    readJson(reportPath, "cargo-audit report"),
    readJson(metadataPath, "cargo metadata"),
  );
  if (!result.ok) {
    for (const violation of result.violations) {
      console.error(`[anchor-audit] ${violation}`);
    }
    process.exitCode = 1;
    return result;
  }

  console.log(JSON.stringify(result));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
