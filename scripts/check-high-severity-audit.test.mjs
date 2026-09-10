import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyHighSeverityFindings,
  validatePatchedTomlGraph,
  validateOptionalImageToolingPath,
} from "./check-high-severity-audit.mjs";

const patchedTomlGraph = {
  rootManifest: { overrides: { toml: "4.2.0" } },
  anchorManifest: { overrides: { toml: "4.2.0" } },
  rootLock: '"overrides": { "toml": "4.2.0" }, "toml": ["toml@4.2.0", "", {}]',
  anchorLock:
    '"overrides": { "toml": "4.2.0" }, "toml": ["toml@4.2.0", "", {}]',
};

test("security policy pins the patched TOML parser in both install graphs", () => {
  assert.deepEqual(validatePatchedTomlGraph(patchedTomlGraph), []);

  for (const mutation of [
    { rootManifest: { overrides: { toml: "3.0.0" } } },
    { anchorManifest: { overrides: {} } },
    { rootLock: '"toml": ["toml@3.0.0", "", {}]' },
    { anchorLock: "" },
  ]) {
    assert.equal(
      validatePatchedTomlGraph({ ...patchedTomlGraph, ...mutation }).length,
      1,
    );
  }
});

test("security audit policy accepts only the reviewed optional image tooling findings", () => {
  const result = classifyHighSeverityFindings({
    "image-size": [
      {
        severity: "high",
        url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
      },
      {
        severity: "high",
        url: "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
      },
    ],
    unrelated: [{ severity: "moderate", url: "https://example.invalid" }],
  });
  assert.equal(result.reviewed.length, 2);
  assert.deepEqual(result.blocking, []);
});

test("security audit policy rejects a new high finding or an allowlisted ID on another package", () => {
  const result = classifyHighSeverityFindings({
    unexpected: [
      {
        severity: "critical",
        url: "https://github.com/advisories/GHSA-new1-new2-new3",
      },
      {
        severity: "high",
        url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
      },
    ],
  });
  assert.equal(result.reviewed.length, 0);
  assert.equal(result.blocking.length, 2);
});

test("reviewed image tooling must remain inside the ConnectorKit mobile and Metro path", () => {
  const validPath = [
    "image-size@1.2.1",
    "metro@0.87.0",
    "react-native@0.87.0",
    "@solana-mobile/wallet-standard-mobile@0.5.3",
    "@solana/connector@0.2.6",
  ].join("\n");
  assert.deepEqual(validateOptionalImageToolingPath(validPath), []);
  assert.deepEqual(validateOptionalImageToolingPath("image-size@1.2.1"), [
    "metro@",
    "react-native@",
    "@solana-mobile/wallet-standard-mobile@",
    "@solana/connector@",
  ]);
});
