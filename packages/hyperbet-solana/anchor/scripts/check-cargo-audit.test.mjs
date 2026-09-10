import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEWED_INFORMATIONAL_WARNINGS,
  activePackageCoordinates,
  evaluateCargoAuditReport,
} from "./check-cargo-audit.mjs";

function metadataWithActive(active) {
  return {
    packages: active.map(({ name, version }, index) => ({
      id: `${name} ${version} (${index})`,
      name,
      version,
    })),
    resolve: {
      nodes: active.map(({ name, version }, index) => ({
        id: `${name} ${version} (${index})`,
      })),
    },
  };
}

function warningEntry(rule) {
  return {
    advisory: { id: rule.advisoryId, title: "reviewed" },
    package: { name: rule.packageName, version: rule.packageVersion },
  };
}

function reviewedReport() {
  const warnings = {};
  for (const rule of REVIEWED_INFORMATIONAL_WARNINGS) {
    (warnings[rule.kind] ??= []).push(warningEntry(rule));
  }
  return {
    database: { "advisory-count": 1 },
    lockfile: { "dependency-count": 1 },
    vulnerabilities: { list: [] },
    warnings,
  };
}

const expectedActive = [{ name: "bincode", version: "1.3.3" }];

test("accepts only the exact reviewed warning identities and reachability", () => {
  const result = evaluateCargoAuditReport(
    reviewedReport(),
    metadataWithActive(expectedActive),
  );
  assert.equal(result.ok, true);
  assert.equal(
    result.reviewedWarnings.length,
    REVIEWED_INFORMATIONAL_WARNINGS.length,
  );
});

test("rejects every vulnerability even when its package is inactive", () => {
  const report = reviewedReport();
  report.vulnerabilities.list.push({
    advisory: { id: "RUSTSEC-2099-0001" },
    package: { name: "inactive-package", version: "1.0.0" },
  });
  const result = evaluateCargoAuditReport(
    report,
    metadataWithActive(expectedActive),
  );
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /RUSTSEC-2099-0001/);
});

test("rejects a new warning or reviewed-version drift", () => {
  const report = reviewedReport();
  report.warnings.unsound.push({
    advisory: { id: "RUSTSEC-2099-0002" },
    package: { name: "new-package", version: "2.0.0" },
  });
  report.warnings.unmaintained[0].package.version = "1.3.4";
  const result = evaluateCargoAuditReport(
    report,
    metadataWithActive(expectedActive),
  );
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /unreviewed cargo-audit warning/);
});

test("rejects active/inactive reachability drift", () => {
  const report = reviewedReport();
  const result = evaluateCargoAuditReport(
    report,
    metadataWithActive([
      { name: "bitmaps", version: "2.1.0" },
      { name: "im", version: "15.1.0" },
      { name: "sized-chunks", version: "0.6.5" },
      { name: "memmap2", version: "0.5.10" },
    ]),
  );
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /expected active=/);
});

test("requires real advisory-database and lockfile identities", () => {
  const report = reviewedReport();
  report.database["advisory-count"] = 0;
  report.lockfile["dependency-count"] = 0;
  const result = evaluateCargoAuditReport(
    report,
    metadataWithActive(expectedActive),
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2);
});

test("derives active package coordinates only from resolved nodes", () => {
  const metadata = metadataWithActive(expectedActive);
  metadata.packages.push({
    id: "inactive 1.0.0",
    name: "inactive",
    version: "1.0.0",
  });
  assert.deepEqual([...activePackageCoordinates(metadata)].sort(), [
    "bincode@1.3.3",
  ]);
});
