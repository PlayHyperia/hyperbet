import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "keeper-operations-"));
const runtime = join(directory, "runtime");
const run = (script) => spawnSync(process.execPath, [
  new URL(`../${script}`, import.meta.url).pathname, runtime,
], { encoding: "utf8" });
try {
  assert.equal(run("prepare-runtime.mjs").status, 0);
  assert.equal(run("prepare-operations.mjs").status, 0);
  const generated = readFileSync(join(runtime, "operations.ts"), "utf8");
  assert.equal([...generated.matchAll(/^function (?:load|save|delete)[A-Za-z]+\(/gm)].length, 20);
  const repeated = run("prepare-operations.mjs");
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /EEXIST/);
  assert.equal(readFileSync(join(runtime, "operations.ts"), "utf8"), generated);
  appendFileSync(join(runtime, "keeper/src/db.ts"), "\n// changed source\n");
  const changed = run("prepare-operations.mjs");
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /does not match the pinned runtime/);
  assert.equal(readFileSync(join(runtime, "operations.ts"), "utf8"), generated);
  console.log("Operation build: complete source, no overwrite, and modified-source rejection passed");
} finally { rmSync(directory, { recursive: true, force: true }); }
