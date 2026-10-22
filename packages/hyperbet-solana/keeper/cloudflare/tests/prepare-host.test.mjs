import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "keeper-host-"));
const source = join(directory, "source"), output = join(directory, "host");
const run = (name, ...args) => spawnSync(process.execPath, [new URL(`../${name}`, import.meta.url).pathname, ...args], { encoding: "utf8" });
try {
  assert.equal(run("prepare-runtime.mjs", source).status, 0);
  assert.equal(run("prepare-host.mjs", source, output).status, 0);
  const manifest = JSON.parse(readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8"));
  for (const file of manifest.files) {
    const target = file.path === "keeper/src/db.ts" ? "keeper/src/db-native.ts" : file.path;
    assert.deepEqual(readFileSync(join(output, target)), readFileSync(join(source, file.path)), file.path);
  }
  const provenance = JSON.parse(readFileSync(join(output, "host-provenance.json"), "utf8"));
  for (const file of provenance.files) {
    assert.equal(createHash("sha256").update(readFileSync(join(output, file.path))).digest("hex"), file.sha256);
  }
  assert.match(run("prepare-host.mjs", source, output).stderr, /already exists/);
  appendFileSync(join(source, "keeper/src/service.ts"), "\n// modified runtime\n");
  assert.match(run("prepare-host.mjs", source, join(directory, "modified")).stderr, /hash mismatch/);
  console.log("Host build: pinned runtime preservation, complete provenance, overwrite and source-drift rejection passed");
} finally { rmSync(directory, { recursive: true, force: true }); }
