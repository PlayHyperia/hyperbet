import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  parseSolanaPagesBuildInfo,
  verifyLocalSolanaPagesBuild,
  verifySolanaPagesDeployment,
} from "./verify-solana-pages-deployment.mjs";
import { resolveSolanaPagesBundleManifest } from "./solana-pages-bundle-manifest.mjs";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const configSha = "a".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildInfo(overrides = {}) {
  return {
    schemaVersion: 2,
    app: "hyperbet-solana",
    mode: "mainnet-beta",
    commitHash: commitSha,
    builtAt: "2026-08-28T12:00:00.000Z",
    deploymentIdentity: {
      schemaVersion: 1,
      target: "production",
      cluster: "mainnet-beta",
      transactionsEnabled: false,
      useGameRpcProxy: true,
      configSha256: configSha,
    },
    bundle: {
      schemaVersion: 1,
      artifactCount: 9,
      manifestSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

const expectations = {
  commitSha,
  target: "production",
  cluster: "mainnet-beta",
  configSha256: configSha,
};

function response(raw, options = {}) {
  return new Response(raw, {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json; charset=utf-8",
      ...(options.contentLength
        ? { "content-length": String(options.contentLength) }
        : {}),
    },
  });
}

describe("Solana Pages deployed-build verification", () => {
  it("parses only the exact schema-v2 SOL deployment identity", () => {
    assert.deepEqual(
      parseSolanaPagesBuildInfo(JSON.stringify(buildInfo()), expectations),
      buildInfo(),
    );
  });

  it("rejects identity, authority, bundle, time, and schema drift", () => {
    for (const value of [
      buildInfo({ app: "other" }),
      buildInfo({ mode: "devnet" }),
      buildInfo({ commitHash: "f".repeat(40) }),
      buildInfo({ builtAt: "not-a-time" }),
      buildInfo({ extra: true }),
      buildInfo({
        deploymentIdentity: {
          ...buildInfo().deploymentIdentity,
          target: "staging",
        },
      }),
      buildInfo({
        deploymentIdentity: {
          ...buildInfo().deploymentIdentity,
          transactionsEnabled: true,
        },
      }),
      buildInfo({
        deploymentIdentity: {
          ...buildInfo().deploymentIdentity,
          configSha256: "c".repeat(64),
        },
      }),
      buildInfo({
        bundle: { ...buildInfo().bundle, artifactCount: 0 },
      }),
      buildInfo({
        bundle: { ...buildInfo().bundle, manifestSha256: "invalid" },
      }),
    ]) {
      assert.throws(() =>
        parseSolanaPagesBuildInfo(JSON.stringify(value), expectations),
      );
    }
  });

  it("independently recomputes the complete local bundle before deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "hyperbet-pages-local-proof-"));
    try {
      mkdirSync(join(root, "assets"));
      writeFileSync(join(root, "index.html"), "<main>release</main>\n");
      writeFileSync(join(root, "assets", "app.js"), "release();\n");
      const bundle = resolveSolanaPagesBundleManifest(root);
      const referenceRaw = JSON.stringify(buildInfo({ bundle }));
      assert.deepEqual(
        verifyLocalSolanaPagesBuild({
          referenceRaw,
          expectations,
          bundleRoot: root,
        }),
        {
          buildInfoSha256: sha256(referenceRaw),
          bundleManifestSha256: bundle.manifestSha256,
          artifactCount: 2,
        },
      );
      writeFileSync(join(root, "assets", "app.js"), "mutated();\n");
      assert.throws(
        () =>
          verifyLocalSolanaPagesBuild({
            referenceRaw,
            expectations,
            bundleRoot: root,
          }),
        /does not match/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries stale content and verifies both deployment and custom origins", async () => {
    const referenceRaw = `${JSON.stringify(buildInfo(), null, 2)}\n`;
    const staleRaw = `${JSON.stringify(
      buildInfo({ builtAt: "2026-08-28T11:59:00.000Z" }),
      null,
      2,
    )}\n`;
    const calls = [];
    let deploymentAttempt = 0;
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      if (url.startsWith("https://c2f6b611.")) {
        deploymentAttempt += 1;
        return response(deploymentAttempt === 1 ? staleRaw : referenceRaw);
      }
      return response(referenceRaw);
    };
    const result = await verifySolanaPagesDeployment({
      deploymentUrl: "https://c2f6b611.hyperia-betting.pages.dev",
      expectedUrl: "https://hyperbet.win",
      referenceRaw,
      expectations,
      attempts: 3,
      delayMs: 1,
      fetchImpl,
      sleep: async () => {},
    });
    assert.deepEqual(result, {
      verifiedOrigins: 2,
      buildInfoSha256: sha256(referenceRaw),
      bundleManifestSha256: "b".repeat(64),
    });
    assert.equal(calls.length, 3);
  });

  it("does not fetch the same deployment origin twice", async () => {
    const referenceRaw = JSON.stringify(buildInfo());
    let calls = 0;
    const result = await verifySolanaPagesDeployment({
      deploymentUrl: "https://hyperia-betting.pages.dev",
      expectedUrl: "https://hyperia-betting.pages.dev/",
      referenceRaw,
      expectations,
      attempts: 1,
      delayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return response(referenceRaw);
      },
      sleep: async () => {},
    });
    assert.equal(result.verifiedOrigins, 1);
    assert.equal(calls, 1);
  });

  it("fails closed on redirects, response type/size, stale custom domain, and HTTP errors", async () => {
    const referenceRaw = JSON.stringify(buildInfo());
    for (const fetchImpl of [
      async () => ({
        ok: true,
        status: 200,
        redirected: true,
        headers: new Headers({ "content-type": "application/json" }),
        arrayBuffer: async () => new TextEncoder().encode(referenceRaw).buffer,
      }),
      async () => response(referenceRaw, { contentType: "text/html" }),
      async () =>
        response(referenceRaw, {
          contentLength: 65_537,
        }),
      async () => response(referenceRaw, { contentLength: 1 }),
      async () => response("unavailable", { status: 503 }),
    ]) {
      await assert.rejects(() =>
        verifySolanaPagesDeployment({
          deploymentUrl: "https://hyperia-betting.pages.dev",
          expectedUrl: "https://hyperia-betting.pages.dev",
          referenceRaw,
          expectations,
          attempts: 1,
          delayMs: 0,
          fetchImpl,
          sleep: async () => {},
        }),
      );
    }

    await assert.rejects(() =>
      verifySolanaPagesDeployment({
        deploymentUrl: "https://c2f6b611.hyperia-betting.pages.dev",
        expectedUrl: "https://hyperbet.win",
        referenceRaw,
        expectations,
        attempts: 2,
        delayMs: 0,
        fetchImpl: async (url) =>
          response(
            url.startsWith("https://c2f6b611.")
              ? referenceRaw
              : JSON.stringify(
                  buildInfo({ builtAt: "2026-08-28T11:00:00.000Z" }),
                ),
          ),
        sleep: async () => {},
      }),
    );
  });

  it("rejects unsafe origins and invalid retry policy before fetching", async () => {
    const referenceRaw = JSON.stringify(buildInfo());
    let fetched = false;
    for (const overrides of [
      { deploymentUrl: "http://hyperia-betting.pages.dev" },
      { expectedUrl: "https://user:secret@hyperbet.win" },
      { deploymentUrl: "https://hyperia-betting.pages.dev/path" },
      { attempts: 0 },
      { delayMs: -1 },
    ]) {
      await assert.rejects(() =>
        verifySolanaPagesDeployment({
          deploymentUrl: "https://hyperia-betting.pages.dev",
          expectedUrl: "https://hyperbet.win",
          referenceRaw,
          expectations,
          attempts: 1,
          delayMs: 0,
          fetchImpl: async () => {
            fetched = true;
            return response(referenceRaw);
          },
          sleep: async () => {},
          ...overrides,
        }),
      );
    }
    assert.equal(fetched, false);
  });
});
