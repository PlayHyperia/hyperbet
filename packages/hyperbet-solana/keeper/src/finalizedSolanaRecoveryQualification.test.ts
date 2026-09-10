import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import {
  collectAndVerifyFinalizedSolanaRecovery,
  type CollectFinalizedSolanaRecoveryInput,
} from "./finalizedSolanaRecoveryCollector";
import {
  createFinalizedSolanaRecoveryQualification,
  type CreateFinalizedSolanaRecoveryQualificationInput,
  type FinalizedSolanaRecoveryExpectationFile,
  verifyFinalizedSolanaRecoveryQualification,
} from "./finalizedSolanaRecoveryQualification";
import { runFinalizedSolanaRecoveryQualificationCli } from "./finalizedSolanaRecoveryQualificationCli";
import type { FinalizedSolanaRecoveryReconciliation } from "./finalizedSolanaRecoveryReconciliation";
import type {
  HyperiaRestoredDuelFact,
  RestoredDuelStateReconciliationManifest,
} from "./restoredDuelStateReconciliation";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function key(byte: number): string {
  return new PublicKey(Buffer.alloc(32, byte)).toBase58();
}

function privateRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "finalized-recovery-proof-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writePrivateJson(filePath: string, value: unknown): string {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
  chmodSync(filePath, 0o600);
  return sha256(bytes);
}

function expectation(): FinalizedSolanaRecoveryExpectationFile {
  return {
    schemaVersion: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    changeReference: "release-change-1234",
    verificationScope:
      "operator_supplied_finalized_solana_recovery_expectation",
    expectation: {
      cluster: "devnet",
      genesisHash: key(1),
      fightOracleProgramId: key(2),
      duelMarketProgramId: key(3),
      expectedUpgradeAuthority: key(4),
      configAuthority: key(5),
      reporter: key(6),
      finalizer: key(7),
      challenger: key(8),
      marketOperator: key(9),
      treasury: key(10),
      marketMaker: key(11),
      disputeWindowSecs: 60,
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 100,
      oraclePaused: false,
      orderPlacementPaused: false,
      marketCreationPaused: false,
    },
    independentApprovalEvidenceRequired: true,
    activationRequiresSeparateApproval: true,
    productionCutoverAuthorized: false,
  };
}

function prior(): {
  manifest: RestoredDuelStateReconciliationManifest;
  duels: HyperiaRestoredDuelFact[];
} {
  const duel: HyperiaRestoredDuelFact = {
    preparationId: "prep-1",
    cycleId: "cycle-1",
    duelId: "duel-1",
    duelKey: sha256("duel-key"),
    snapshotVersion: 3,
    snapshotDigest: sha256("snapshot"),
    snapshot: {},
    frozenAt: 1,
    lifecycleStatus: "terminal",
    agent1Id: "agent-a",
    agent2Id: "agent-b",
    terminalOutcome: "win",
    terminalWinnerId: "agent-a",
    terminalWinReason: "kill",
    terminalCancellationReason: null,
    terminalSeed: "42",
    terminalReplayHash: sha256("replay"),
    terminalAt: 2,
  };
  const manifest = {
    reconciliationId: "11111111-1111-4111-8111-111111111111",
    boundaryId: "boundary-1234",
    reconciledStateSha256: sha256("restored-state"),
    hyperbet: {
      materializationId: "22222222-2222-4222-8222-222222222222",
    },
  } as RestoredDuelStateReconciliationManifest;
  return { manifest, duels: [duel] };
}

function collected(input: CollectFinalizedSolanaRecoveryInput, slot = 100) {
  const database = {
    integrityCheck: "ok" as const,
    foreignKeyViolations: 0 as const,
    schemaSha256: sha256("schema"),
    logicalDataSha256: sha256("database"),
    tableCounts: { bets: 1, solana_indexed_transactions: 1 },
  };
  const reconciliation: FinalizedSolanaRecoveryReconciliation = {
    schemaVersion: 1,
    verificationScope: "finalized_solana_post_restore_read_only_reconciliation",
    cluster: input.expectation.cluster,
    genesisHash: input.expectation.genesisHash,
    restoredReconciliationId: input.restoredReconciliationId,
    materializationId: input.materializationId,
    databaseLogicalDataSha256: database.logicalDataSha256,
    finalizedStartSlot: slot,
    finalizedEndSlot: slot + 1,
    minimumAvailableSlot: 1,
    duelCount: 1,
    betCount: 1,
    indexedTransactionCount: 1,
    checkpointCount: 1,
    marketCount: 1,
    custodyExcessLamportsByMarket: { [key(12)]: "0" },
    reconciledStateSha256: sha256("finalized-state"),
    databaseMutationAuthorized: false,
    chainMutationAuthorized: false,
    productionCutoverAuthorized: false,
    activationRequiresSeparateApproval: true,
  };
  return {
    restored: {
      restoredReconciliationId: input.restoredReconciliationId,
      restoredReconciliationSha256: input.restoredReconciliationSha256,
      restoredReconciledStateSha256: input.restoredReconciledStateSha256,
      materializationId: input.materializationId,
      databaseBefore: database,
      databaseAfter: structuredClone(database),
      duels: input.duels,
      bets: [{}],
      indexedTransactions: [{}],
      indexerCheckpoints: [{}],
    },
    chain: {
      cluster: input.expectation.cluster,
      genesisHash: input.expectation.genesisHash,
      finalizedStartSlot: slot,
      finalizedEndSlot: slot + 1,
      minimumAvailableSlot: 1,
      transactions: [{}],
      duels: [{}],
      markets: [{}],
      orders: [{}],
      balances: [{}],
      custody: [{}],
    },
    reconciliation,
  } as Awaited<ReturnType<typeof collectAndVerifyFinalizedSolanaRecovery>>;
}

function fixture() {
  const root = privateRoot();
  const expectationPath = path.join(
    root,
    "finalized-solana-recovery-expectation.json",
  );
  const expectationSha256 = writePrivateJson(expectationPath, expectation());
  const reconciliationManifestPath = path.join(
    root,
    "restored-duel-state-reconciliation.json",
  );
  const reconciliationSha256 = writePrivateJson(reconciliationManifestPath, {
    fixture: "manifest",
  });
  const finalizedEvidencePath = path.join(
    root,
    "finalized-solana-recovery-evidence.json",
  );
  const priorState = prior();
  let slot = 100;
  const input = {
    expectedHyperbetReleaseSha: "a".repeat(40),
    expectedCluster: "devnet",
    materializedRootPath: root,
    reconciliationManifestPath,
    chainExpectationPath: expectationPath,
    expectedChainExpectationSha256: expectationSha256,
    expectedRestoredReconciliationSha256: reconciliationSha256,
    finalizedEvidencePath,
    connection: {} as Connection,
    verifyPrior: async () => structuredClone(priorState),
    collect: async (collectorInput: CollectFinalizedSolanaRecoveryInput) =>
      collected(collectorInput, slot),
    now: () => new Date("2026-08-26T01:00:00.000Z"),
    createId: () => "33333333-3333-4333-8333-333333333333",
  } as CreateFinalizedSolanaRecoveryQualificationInput;
  return {
    root,
    input,
    priorState,
    expectationPath,
    finalizedEvidencePath,
    advanceSlots: () => {
      slot += 10;
    },
  };
}

describe("bound finalized Solana recovery qualification", () => {
  test("creates owner-only no-cutover evidence and independently re-verifies it", async () => {
    const value = fixture();
    const evidence = await createFinalizedSolanaRecoveryQualification(
      value.input,
    );
    expect(evidence).toMatchObject({
      verificationScope: "finalized_solana_post_restore_bound_evidence_only",
      boundaryId: "boundary-1234",
      databaseMutationAuthorized: false,
      chainMutationAuthorized: false,
      activationRequiresSeparateApproval: true,
      productionCutoverAuthorized: false,
    });
    expect(statSync(value.finalizedEvidencePath).mode & 0o777).toBe(0o600);
    expect(evidence.restored.manifest.sha256).toBe(
      value.input.expectedRestoredReconciliationSha256,
    );
    expect(evidence.chainExpectation.file.sha256).toBe(
      value.input.expectedChainExpectationSha256,
    );

    value.advanceSlots();
    expect(
      (await verifyFinalizedSolanaRecoveryQualification(value.input))
        .reconciliationRunId,
    ).toBe(evidence.reconciliationRunId);
  });

  test("rejects input digest drift, prior-state races, and semantic chain drift", async () => {
    const wrongDigest = fixture();
    wrongDigest.input.expectedChainExpectationSha256 = sha256("wrong");
    await expect(
      createFinalizedSolanaRecoveryQualification(wrongDigest.input),
    ).rejects.toThrow("digest does not match");

    const wrongCluster = fixture();
    const otherExpectation = expectation();
    otherExpectation.expectation.cluster = "mainnet-beta";
    const otherBytes = `${JSON.stringify(otherExpectation, null, 2)}\n`;
    writeFileSync(wrongCluster.expectationPath, otherBytes, { mode: 0o600 });
    chmodSync(wrongCluster.expectationPath, 0o600);
    wrongCluster.input.expectedChainExpectationSha256 = sha256(otherBytes);
    await expect(
      createFinalizedSolanaRecoveryQualification(wrongCluster.input),
    ).rejects.toThrow("cluster does not match");

    const raced = fixture();
    let priorReads = 0;
    raced.input.verifyPrior = async () => {
      priorReads += 1;
      const state = structuredClone(raced.priorState);
      if (priorReads % 2 === 0) state.duels[0]!.terminalSeed = "43";
      return state;
    };
    await expect(
      createFinalizedSolanaRecoveryQualification(raced.input),
    ).rejects.toThrow("prior recovery truth changed");

    const drifted = fixture();
    await createFinalizedSolanaRecoveryQualification(drifted.input);
    drifted.input.collect = async (collectorInput) => {
      const result = collected(collectorInput, 110);
      result.reconciliation.reconciledStateSha256 = sha256("changed");
      return result;
    };
    await expect(
      verifyFinalizedSolanaRecoveryQualification(drifted.input),
    ).rejects.toThrow("no longer matches");
  });

  test("refuses permissive inputs, overwrite, and evidence mutation", async () => {
    const permissive = fixture();
    chmodSync(permissive.expectationPath, 0o644);
    await expect(
      createFinalizedSolanaRecoveryQualification(permissive.input),
    ).rejects.toThrow("mode-0600");

    const duplicate = fixture();
    await createFinalizedSolanaRecoveryQualification(duplicate.input);
    await expect(
      createFinalizedSolanaRecoveryQualification(duplicate.input),
    ).rejects.toThrow("already exists");

    const tampered = JSON.parse(
      readFileSync(duplicate.finalizedEvidencePath, "utf8"),
    ) as Record<string, unknown>;
    tampered.productionCutoverAuthorized = true;
    writeFileSync(
      duplicate.finalizedEvidencePath,
      `${JSON.stringify(tampered, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(duplicate.finalizedEvidencePath, 0o600);
    await expect(
      verifyFinalizedSolanaRecoveryQualification(duplicate.input),
    ).rejects.toThrow("evidence schema is invalid");
  });

  test("requires an exact CLI argument set and a dedicated safe RPC environment", async () => {
    await expect(
      runFinalizedSolanaRecoveryQualificationCli([
        "bun",
        "finalizedSolanaRecoveryQualificationCli.ts",
        "create",
      ]),
    ).rejects.toThrow("argument set is incomplete");

    const names = [
      "keeper-backup",
      "keeper-evidence",
      "operator-alert-backup",
      "operator-alert-evidence",
      "keeper-recovery-set-manifest",
      "hyperia-backup",
      "hyperia-evidence",
      "hyperia-migrations-directory",
      "platform-manifest",
      "hyperia-restore-evidence",
      "hyperia-application-readiness",
      "materialized-root",
      "rehearsal-manifest",
      "reconciliation-manifest",
      "hyperia-release-sha",
      "hyperia-database",
      "hyperbet-release-sha",
      "cluster",
      "operator-alert-route-id",
      "boundary-id",
      "tool-timeout-ms",
      "query-timeout-ms",
      "pg-restore-executable",
      "psql-executable",
      "chain-expectation",
      "chain-expectation-sha256",
      "restored-reconciliation-sha256",
      "rpc-url-env",
      "rpc-timeout-ms",
      "finalized-evidence",
    ];
    const args = [
      "bun",
      "finalizedSolanaRecoveryQualificationCli.ts",
      "create",
      ...names.map((name) =>
        name === "rpc-url-env"
          ? `--${name}=HYPERBET_RECOVERY_RPC_URL`
          : name === "rpc-timeout-ms"
            ? `--${name}=30000`
            : `--${name}=fixture`,
      ),
    ];
    process.env.HYPERBET_RECOVERY_RPC_URL = "http://public.example.test";
    try {
      await expect(
        runFinalizedSolanaRecoveryQualificationCli(args),
      ).rejects.toThrow("must use HTTPS");
      await expect(
        runFinalizedSolanaRecoveryQualificationCli([
          ...args,
          "--cluster=devnet",
        ]),
      ).rejects.toThrow("unknown or duplicate argument");

      process.env.HYPERBET_RECOVERY_RPC_URL = "https://rpc.example.test";
      await expect(
        runFinalizedSolanaRecoveryQualificationCli(
          args.map((argument) =>
            argument === "--rpc-timeout-ms=30000"
              ? "--rpc-timeout-ms=999"
              : argument,
          ),
        ),
      ).rejects.toThrow("between 1000 and 120000");
    } finally {
      delete process.env.HYPERBET_RECOVERY_RPC_URL;
    }
  });
});
