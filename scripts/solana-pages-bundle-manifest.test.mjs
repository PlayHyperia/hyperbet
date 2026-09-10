import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveSolanaPagesBundleManifest } from "./solana-pages-bundle-manifest.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hyperbet-pages-bundle-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<main>Hyperbet</main>\n");
  writeFileSync(join(root, "assets", "app.js"), "console.log('ok');\n");
  writeFileSync(
    join(root, "_headers"),
    "/build-info.json\n  Cache-Control: no-store\n",
  );
  writeFileSync(join(root, "build-info.json"), "ignored-current-identity\n");
  return root;
}

describe("Solana Pages complete bundle manifest", () => {
  it("binds every recursively emitted file except build-info itself", () => {
    const root = fixture();
    try {
      const manifest = resolveSolanaPagesBundleManifest(root);
      assert.deepEqual(Object.keys(manifest), [
        "schemaVersion",
        "artifactCount",
        "manifestSha256",
      ]);
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.artifactCount, 3);
      assert.match(manifest.manifestSha256, /^[0-9a-f]{64}$/);
      writeFileSync(join(root, "build-info.json"), "new-identity\n");
      assert.deepEqual(resolveSolanaPagesBundleManifest(root), manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changes for path, byte, addition, and deletion drift", () => {
    const root = fixture();
    try {
      const baseline = resolveSolanaPagesBundleManifest(root);
      writeFileSync(
        join(root, "assets", "app.js"),
        "console.log('changed');\n",
      );
      assert.notEqual(
        resolveSolanaPagesBundleManifest(root).manifestSha256,
        baseline.manifestSha256,
      );
      writeFileSync(join(root, "assets", "extra.css"), "body{}\n");
      assert.equal(resolveSolanaPagesBundleManifest(root).artifactCount, 4);
      rmSync(join(root, "index.html"));
      assert.equal(resolveSolanaPagesBundleManifest(root).artifactCount, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks without following them", () => {
    const root = fixture();
    try {
      symlinkSync(join(root, "index.html"), join(root, "assets", "linked.js"));
      assert.throws(
        () => resolveSolanaPagesBundleManifest(root),
        /symbolic link/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, non-directory, empty, and build-info-only roots", () => {
    const root = fixture();
    try {
      assert.throws(() =>
        resolveSolanaPagesBundleManifest(join(root, "missing")),
      );
      assert.throws(() =>
        resolveSolanaPagesBundleManifest(join(root, "index.html")),
      );
      const empty = join(root, "empty");
      mkdirSync(empty);
      assert.throws(() => resolveSolanaPagesBundleManifest(empty));
      writeFileSync(join(empty, "build-info.json"), "identity-only\n");
      assert.throws(() => resolveSolanaPagesBundleManifest(empty));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
