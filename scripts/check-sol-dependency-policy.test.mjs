import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_SOL_WORKSPACES,
  auditManifest,
  auditWorkspaceGraph,
} from "./check-sol-dependency-policy.mjs";

test("dependency policy accepts exact external and workspace versions", () => {
  const result = auditManifest("package.json", {
    dependencies: {
      exact: "1.2.3",
      prerelease: "1.2.3-rc.1",
      workspace: "workspace:*",
    },
  });
  assert.equal(result.checkedDependencies, 3);
  assert.deepEqual(result.violations, []);
});

test("dependency policy rejects every floating or external source form", () => {
  const result = auditManifest("package.json", {
    dependencies: {
      caret: "^1.2.3",
      tilde: "~1.2.3",
      latest: "latest",
      wildcard: "*",
      range: ">=1.2.3",
      npmAlias: "npm:other@1.2.3",
      git: "github:owner/repo",
      url: "https://example.invalid/package.tgz",
      file: "file:../package",
      floatingWorkspace: "workspace:^",
    },
  });
  assert.equal(result.checkedDependencies, 10);
  assert.equal(result.violations.length, 10);
});

test("dependency policy checks all install-affecting dependency sections", () => {
  const result = auditManifest("package.json", {
    dependencies: { runtime: "1.0.0" },
    devDependencies: { development: "2.0.0" },
    peerDependencies: { peer: "^3.0.0" },
    optionalDependencies: { optional: "latest" },
    overrides: { transitive: "~4.0.0" },
  });
  assert.equal(result.checkedDependencies, 5);
  assert.deepEqual(
    result.violations.map(({ section }) => section),
    ["peerDependencies", "optionalDependencies", "overrides"],
  );
});

test("workspace policy accepts only the SOL launch graph", () => {
  const lockfile = ACTIVE_SOL_WORKSPACES.map(
    (workspace) => `"workspace:${workspace}"`,
  ).join("\n");
  const result = auditWorkspaceGraph(
    { workspaces: [...ACTIVE_SOL_WORKSPACES] },
    lockfile,
  );
  assert.deepEqual(result.violations, []);
});

test("workspace policy rejects wildcards and any extra lockfile workspace", () => {
  const lockfile = [
    ...ACTIVE_SOL_WORKSPACES.map((workspace) => `"workspace:${workspace}"`),
    '"workspace:packages/unsupported-chain"',
  ].join("\n");
  const result = auditWorkspaceGraph({ workspaces: ["packages/*"] }, lockfile);
  assert.deepEqual(
    result.violations.map(({ file }) => file),
    ["package.json", "bun.lock"],
  );
});

test("workspace policy rejects a stale lockfile missing a launch workspace", () => {
  const lockfile = ACTIVE_SOL_WORKSPACES.slice(1)
    .map((workspace) => `"workspace:${workspace}"`)
    .join("\n");
  const result = auditWorkspaceGraph(
    { workspaces: [...ACTIVE_SOL_WORKSPACES] },
    lockfile,
  );
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, "bun.lock");
});
