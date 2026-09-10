import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildSolanaDeploymentEvidence,
  parseSolanaDeploymentEvidence,
  resolveDeploymentEvidenceWorkflow,
  writeSolanaDeploymentEvidence,
} from "./solana-deployment-evidence.mjs";

const RELEASE = Object.freeze({
  commitSha: "a".repeat(40),
  target: "staging",
  cluster: "devnet",
});
const WORKFLOW = Object.freeze({
  repository: "hyperia/hyperbet",
  runId: "123456789",
  runAttempt: "2",
});
const VERIFIED_AT = "2026-08-28T12:34:56.789Z";
const temporaryRoots = [];

function keeperEvidence() {
  return buildSolanaDeploymentEvidence({
    surface: "keeper",
    expectations: {
      ...RELEASE,
      fightOracleProgramId: "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
      duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
    },
    result: {
      origin: "https://staging-api.hyperbet.win",
      releaseSha: RELEASE.commitSha,
      cluster: RELEASE.cluster,
      verifiedEndpoints: 9,
    },
    workflow: WORKFLOW,
    verifiedAt: VERIFIED_AT,
  });
}

function pagesEvidence() {
  return buildSolanaDeploymentEvidence({
    surface: "pages",
    expectations: { ...RELEASE, configSha256: "b".repeat(64) },
    result: {
      verifiedOrigins: 2,
      buildInfoSha256: "c".repeat(64),
      bundleManifestSha256: "d".repeat(64),
    },
    workflow: WORKFLOW,
    verifiedAt: VERIFIED_AT,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("SOL deployment verification evidence", () => {
  it("builds exact hash-bound keeper and Pages certificates", () => {
    const keeper = keeperEvidence();
    assert.equal(keeper.evidenceType, "solana_keeper_deployment_verification");
    assert.equal(keeper.verification.verifiedEndpoints, 9);
    assert.equal(keeper.productionActivationAuthorized, false);
    assert.equal(parseSolanaDeploymentEvidence(keeper), keeper);

    const pages = pagesEvidence();
    assert.equal(pages.evidenceType, "solana_pages_deployment_verification");
    assert.equal(pages.verification.verifiedOrigins, 2);
    assert.equal(parseSolanaDeploymentEvidence(pages), pages);
  });

  it("rejects release, workflow, verification, activation, and digest drift", () => {
    const base = keeperEvidence();
    for (const mutation of [
      { ...base, productionActivationAuthorized: true },
      { ...base, verifiedAt: "2026-08-28" },
      { ...base, release: { ...base.release, cluster: "mainnet-beta" } },
      { ...base, workflow: { ...base.workflow, runId: "0" } },
      {
        ...base,
        verification: { ...base.verification, verifiedEndpoints: 8 },
      },
      {
        ...base,
        verification: {
          ...base.verification,
          fightOracleProgramId: "1".repeat(32),
        },
      },
      { ...base, payloadSha256: "0".repeat(64) },
      { ...base, unexpected: true },
    ]) {
      assert.throws(() => parseSolanaDeploymentEvidence(mutation));
    }
    assert.throws(
      () =>
        buildSolanaDeploymentEvidence({
          surface: "keeper",
          expectations: {
            ...RELEASE,
            fightOracleProgramId: "1".repeat(32),
            duelMarketProgramId: "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
          },
          result: {
            origin: "https://staging-api.hyperbet.win",
            releaseSha: RELEASE.commitSha,
            cluster: RELEASE.cluster,
            verifiedEndpoints: 9,
          },
          workflow: WORKFLOW,
          verifiedAt: VERIFIED_AT,
        }),
      /verification is invalid/,
    );
  });

  it("binds only a canonical GitHub workflow identity", () => {
    assert.deepEqual(
      resolveDeploymentEvidenceWorkflow({
        GITHUB_REPOSITORY: WORKFLOW.repository,
        GITHUB_RUN_ID: WORKFLOW.runId,
        GITHUB_RUN_ATTEMPT: WORKFLOW.runAttempt,
      }),
      WORKFLOW,
    );
    for (const environment of [
      {
        GITHUB_REPOSITORY: "missing-owner",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
      },
      {
        GITHUB_REPOSITORY: WORKFLOW.repository,
        GITHUB_RUN_ID: "1\n2",
        GITHUB_RUN_ATTEMPT: "1",
      },
      {
        GITHUB_REPOSITORY: WORKFLOW.repository,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "0",
      },
    ]) {
      assert.throws(() => resolveDeploymentEvidenceWorkflow(environment));
    }
  });

  it("publishes one owner-only immutable certificate and refuses replacement", () => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "hyperbet-deployment-evidence-")),
    );
    temporaryRoots.push(root);
    const output = path.join(root, "keeper.json");
    const result = writeSolanaDeploymentEvidence(output, keeperEvidence());
    assert.match(result.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(result.bytes, lstatSync(output).size);
    assert.equal(lstatSync(output).mode & 0o777, 0o600);
    assert.deepEqual(
      parseSolanaDeploymentEvidence(JSON.parse(readFileSync(output, "utf8"))),
      keeperEvidence(),
    );
    assert.throws(
      () => writeSolanaDeploymentEvidence(output, keeperEvidence()),
      /could not be published/,
    );
    assert.equal(lstatSync(output).mode & 0o777, 0o600);
  });

  it("rejects relative outputs, symlink parents, and non-private publication", () => {
    assert.throws(
      () => writeSolanaDeploymentEvidence("relative.json", pagesEvidence()),
      /output path is invalid/,
    );
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "hyperbet-deployment-parent-")),
    );
    temporaryRoots.push(root);
    const actualParent = path.join(root, "actual");
    const linkedParent = path.join(root, "linked");
    chmodSync(root, 0o700);
    symlinkSync(root, linkedParent);
    assert.throws(
      () =>
        writeSolanaDeploymentEvidence(
          path.join(linkedParent, "pages.json"),
          pagesEvidence(),
        ),
      /output parent is invalid/,
    );
    assert.equal(path.isAbsolute(actualParent), true);
  });
});
