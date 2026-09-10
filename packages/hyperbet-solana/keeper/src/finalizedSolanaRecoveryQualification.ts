import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { canonicalEvidenceJson } from "./bettingFeedEvidence";
import {
  collectAndVerifyFinalizedSolanaRecovery,
  type CollectFinalizedSolanaRecoveryInput,
} from "./finalizedSolanaRecoveryCollector";
import {
  type FinalizedRecoveryDeploymentExpectation,
  type FinalizedRecoveryRestoredDuel,
  type FinalizedSolanaRecoveryReconciliation,
} from "./finalizedSolanaRecoveryReconciliation";
import {
  type HyperiaRestoredDuelFact,
  type RestoredDuelStateReconciliationManifest,
  type VerifyRestoredDuelStateReconciliationInput,
  verifyRestoredDuelStateReconciliationWithFacts,
} from "./restoredDuelStateReconciliation";

const MAX_EXPECTATION_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RELEASE_SHA = /^[0-9a-f]{40}$/u;

type UnknownRecord = Record<string, unknown>;

type BoundFile = {
  fileName: string;
  sha256: string;
  bytes: number;
};

export type FinalizedSolanaRecoveryExpectationFile = {
  schemaVersion: 1;
  createdAt: string;
  changeReference: string;
  verificationScope: "operator_supplied_finalized_solana_recovery_expectation";
  expectation: FinalizedRecoveryDeploymentExpectation;
  independentApprovalEvidenceRequired: true;
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
};

export type FinalizedSolanaRecoveryEvidence = {
  schemaVersion: 1;
  createdAt: string;
  reconciliationRunId: string;
  verificationScope: "finalized_solana_post_restore_bound_evidence_only";
  hyperbetReleaseSha: string;
  boundaryId: string;
  restored: {
    reconciliationId: string;
    reconciledStateSha256: string;
    materializationId: string;
    manifest: BoundFile;
  };
  chainExpectation: {
    createdAt: string;
    changeReference: string;
    file: BoundFile;
  };
  database: {
    schemaSha256: string;
    logicalDataSha256: string;
    tableCounts: Record<string, number>;
    unchangedAcrossDoubleFinalizedRead: true;
  };
  finalizedChain: {
    cluster: "devnet" | "mainnet-beta";
    genesisHash: string;
    finalizedStartSlot: number;
    finalizedEndSlot: number;
    minimumAvailableSlot: number;
    transactionCount: number;
    duelCount: number;
    marketCount: number;
    orderCount: number;
    balanceCount: number;
    custodyCount: number;
  };
  reconciliation: FinalizedSolanaRecoveryReconciliation;
  operatorSuppliedExpectationRequiresIndependentApproval: true;
  rpcProviderRetentionRequiresSeparateEvidence: true;
  databaseMutationAuthorized: false;
  chainMutationAuthorized: false;
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
};

type PriorVerification = {
  manifest: RestoredDuelStateReconciliationManifest;
  duels: HyperiaRestoredDuelFact[];
};

type QualificationDependencies = {
  verifyPrior?: (
    input: VerifyRestoredDuelStateReconciliationInput,
  ) => Promise<PriorVerification>;
  collect?: typeof collectAndVerifyFinalizedSolanaRecovery;
};

type QualificationPaths = {
  chainExpectationPath: string;
  expectedChainExpectationSha256: string;
  expectedRestoredReconciliationSha256: string;
  finalizedEvidencePath: string;
};

export type CreateFinalizedSolanaRecoveryQualificationInput =
  VerifyRestoredDuelStateReconciliationInput &
    QualificationPaths &
    QualificationDependencies & {
      connection: Connection;
      now?: () => Date;
      createId?: () => string;
    };

export type VerifyFinalizedSolanaRecoveryQualificationInput =
  VerifyRestoredDuelStateReconciliationInput &
    QualificationPaths &
    QualificationDependencies & {
      connection: Connection;
    };

function fail(message: string): never {
  throw new Error(`finalized Solana recovery qualification ${message}`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(value).toISOString() === value
  );
}

function exactText(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const result = exactText(value, label, 64);
  if (!SHA256.test(result)) fail(`${label} is invalid`);
  return result;
}

function publicKey(value: unknown, label: string): string {
  const result = exactText(value, label, 44);
  try {
    if (new PublicKey(result).toBase58() !== result) throw new Error("drift");
  } catch {
    fail(`${label} is invalid`);
  }
  return result;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} is invalid`);
  }
  return Number(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPrivateFile(
  filePath: string,
  label: string,
  maximumBytes: number,
) {
  const absolute = path.resolve(filePath);
  const stats = lstatSync(absolute);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size <= 0 ||
    stats.size > maximumBytes
  ) {
    fail(`${label} must be a bounded mode-0600 regular file`);
  }
  return { absolute, stats };
}

function bindPrivateFile(
  filePath: string,
  label: string,
  maximumBytes: number,
  expectedSha256?: string,
): BoundFile {
  const { absolute, stats } = assertPrivateFile(filePath, label, maximumBytes);
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size
    ) {
      fail(`${label} changed while opened`);
    }
    const bytes = readFileSync(descriptor);
    const final = fstatSync(descriptor);
    if (
      bytes.byteLength !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      fail(`${label} changed while read`);
    }
    const fileSha256 = sha256(bytes);
    if (
      expectedSha256 &&
      fileSha256 !== digest(expectedSha256, `${label} digest`)
    ) {
      fail(`${label} digest does not match the independently supplied value`);
    }
    return {
      fileName: path.basename(absolute),
      sha256: fileSha256,
      bytes: bytes.byteLength,
    };
  } finally {
    closeSync(descriptor);
  }
}

function readPrivateJson(
  filePath: string,
  label: string,
  maximumBytes: number,
): unknown {
  const { absolute, stats } = assertPrivateFile(filePath, label, maximumBytes);
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size
    ) {
      fail(`${label} changed while opened`);
    }
    const bytes = readFileSync(descriptor);
    const final = fstatSync(descriptor);
    if (
      bytes.byteLength !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      fail(`${label} changed while read`);
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`${label} is not valid JSON`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseExpectation(
  value: unknown,
): FinalizedSolanaRecoveryExpectationFile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "changeReference",
      "verificationScope",
      "expectation",
      "independentApprovalEvidenceRequired",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
    ]) ||
    value.schemaVersion !== 1 ||
    !isIsoTimestamp(value.createdAt) ||
    value.verificationScope !==
      "operator_supplied_finalized_solana_recovery_expectation" ||
    value.independentApprovalEvidenceRequired !== true ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false ||
    !isRecord(value.expectation) ||
    !hasExactKeys(value.expectation, [
      "cluster",
      "genesisHash",
      "fightOracleProgramId",
      "duelMarketProgramId",
      "expectedUpgradeAuthority",
      "configAuthority",
      "reporter",
      "finalizer",
      "challenger",
      "marketOperator",
      "treasury",
      "marketMaker",
      "disputeWindowSecs",
      "tradeTreasuryFeeBps",
      "tradeMarketMakerFeeBps",
      "winningsMarketMakerFeeBps",
      "oraclePaused",
      "orderPlacementPaused",
      "marketCreationPaused",
    ])
  ) {
    fail("chain expectation schema is invalid");
  }
  exactText(value.changeReference, "chain expectation change reference", 128);
  const expectation = value.expectation;
  if (
    expectation.cluster !== "devnet" &&
    expectation.cluster !== "mainnet-beta"
  ) {
    fail("chain expectation cluster is invalid");
  }
  const programIds = [
    publicKey(expectation.fightOracleProgramId, "fight oracle program ID"),
    publicKey(expectation.duelMarketProgramId, "duel market program ID"),
  ];
  if (programIds[0] === programIds[1])
    fail("chain program IDs are not distinct");
  publicKey(expectation.genesisHash, "genesis hash");
  if (expectation.expectedUpgradeAuthority !== null) {
    publicKey(expectation.expectedUpgradeAuthority, "upgrade authority");
  }
  const roles = [
    publicKey(expectation.configAuthority, "config authority"),
    publicKey(expectation.reporter, "reporter"),
    publicKey(expectation.finalizer, "finalizer"),
    publicKey(expectation.challenger, "challenger"),
    publicKey(expectation.marketOperator, "market operator"),
    publicKey(expectation.treasury, "treasury"),
    publicKey(expectation.marketMaker, "market maker"),
  ];
  if (new Set(roles).size !== roles.length)
    fail("chain roles are not distinct");
  safeInteger(expectation.disputeWindowSecs, "dispute window", 60);
  const treasuryFee = safeInteger(
    expectation.tradeTreasuryFeeBps,
    "treasury fee",
  );
  const marketMakerFee = safeInteger(
    expectation.tradeMarketMakerFeeBps,
    "market-maker fee",
  );
  safeInteger(expectation.winningsMarketMakerFeeBps, "winnings fee");
  if (
    treasuryFee < 1 ||
    treasuryFee > 10_000 ||
    marketMakerFee > 10_000 ||
    treasuryFee + marketMakerFee > 10_000 ||
    Number(expectation.winningsMarketMakerFeeBps) > 10_000
  ) {
    fail("chain expectation fee policy is invalid");
  }
  for (const [label, flag] of [
    ["oracle pause", expectation.oraclePaused],
    ["order-placement pause", expectation.orderPlacementPaused],
    ["market-creation pause", expectation.marketCreationPaused],
  ] as const) {
    if (typeof flag !== "boolean") fail(`${label} expectation is invalid`);
  }
  return value as FinalizedSolanaRecoveryExpectationFile;
}

function terminalWinnerSide(duel: HyperiaRestoredDuelFact): "A" | "B" | null {
  if (duel.terminalOutcome !== "win") return null;
  if (duel.terminalWinnerId === duel.agent1Id) return "A";
  if (duel.terminalWinnerId === duel.agent2Id) return "B";
  fail(`restored duel ${duel.duelId} winner is not a participant`);
}

function mapRestoredDuels(
  duels: readonly HyperiaRestoredDuelFact[],
): FinalizedRecoveryRestoredDuel[] {
  const identities = new Set<string>();
  return duels.map((duel) => {
    if (identities.has(duel.duelId)) {
      fail(`restored duel ${duel.duelId} is duplicated`);
    }
    identities.add(duel.duelId);
    return {
      duelId: duel.duelId,
      duelKey: duel.duelKey,
      participantAId: duel.agent1Id,
      participantBId: duel.agent2Id,
      competitiveSnapshotVersion: duel.snapshotVersion,
      competitiveSnapshotDigest: duel.snapshotDigest,
      terminalOutcome: duel.terminalOutcome,
      terminalWinnerSide: terminalWinnerSide(duel),
      terminalSeed: duel.terminalSeed,
      terminalReplayHash: duel.terminalReplayHash,
    };
  });
}

function sameBoundFile(left: BoundFile, right: BoundFile): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

async function collectBoundState(
  input:
    | CreateFinalizedSolanaRecoveryQualificationInput
    | VerifyFinalizedSolanaRecoveryQualificationInput,
) {
  const expectationSha256 = digest(
    input.expectedChainExpectationSha256,
    "expected chain expectation digest",
  );
  const reconciliationSha256 = digest(
    input.expectedRestoredReconciliationSha256,
    "expected restored reconciliation digest",
  );
  const expectationFile = bindPrivateFile(
    input.chainExpectationPath,
    "chain expectation",
    MAX_EXPECTATION_BYTES,
    expectationSha256,
  );
  const restoredManifestFile = bindPrivateFile(
    input.reconciliationManifestPath,
    "restored reconciliation manifest",
    MAX_MANIFEST_BYTES,
    reconciliationSha256,
  );
  const expectation = parseExpectation(
    readPrivateJson(
      input.chainExpectationPath,
      "chain expectation",
      MAX_EXPECTATION_BYTES,
    ),
  );
  const verifyPrior =
    input.verifyPrior ?? verifyRestoredDuelStateReconciliationWithFacts;
  const collect = input.collect ?? collectAndVerifyFinalizedSolanaRecovery;
  const before = await verifyPrior(input);
  if (expectation.expectation.cluster !== input.expectedCluster) {
    fail("chain expectation cluster does not match the bound recovery set");
  }
  const collectorInput: CollectFinalizedSolanaRecoveryInput = {
    connection: input.connection,
    databasePath: path.join(
      path.resolve(input.materializedRootPath),
      "keeper.sqlite",
    ),
    expectation: expectation.expectation,
    restoredReconciliationId: before.manifest.reconciliationId,
    restoredReconciliationSha256: restoredManifestFile.sha256,
    restoredReconciledStateSha256: before.manifest.reconciledStateSha256,
    materializationId: before.manifest.hyperbet.materializationId,
    duels: mapRestoredDuels(before.duels),
  };
  const collected = await collect(collectorInput);
  const after = await verifyPrior(input);
  if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after)) {
    fail("prior recovery truth changed during finalized reconciliation");
  }
  const finalExpectationFile = bindPrivateFile(
    input.chainExpectationPath,
    "chain expectation",
    MAX_EXPECTATION_BYTES,
    expectationSha256,
  );
  const finalRestoredManifestFile = bindPrivateFile(
    input.reconciliationManifestPath,
    "restored reconciliation manifest",
    MAX_MANIFEST_BYTES,
    reconciliationSha256,
  );
  if (
    !sameBoundFile(expectationFile, finalExpectationFile) ||
    !sameBoundFile(restoredManifestFile, finalRestoredManifestFile)
  ) {
    fail("bound input changed during finalized reconciliation");
  }
  return {
    expectation,
    expectationFile,
    restoredManifestFile,
    prior: before,
    collected,
  };
}

function buildEvidence(
  input: {
    createdAt: string;
    reconciliationRunId: string;
    hyperbetReleaseSha: string;
  },
  state: Awaited<ReturnType<typeof collectBoundState>>,
): FinalizedSolanaRecoveryEvidence {
  const { chain, reconciliation, restored } = state.collected;
  return {
    schemaVersion: 1,
    createdAt: input.createdAt,
    reconciliationRunId: input.reconciliationRunId,
    verificationScope: "finalized_solana_post_restore_bound_evidence_only",
    hyperbetReleaseSha: input.hyperbetReleaseSha,
    boundaryId: state.prior.manifest.boundaryId,
    restored: {
      reconciliationId: state.prior.manifest.reconciliationId,
      reconciledStateSha256: state.prior.manifest.reconciledStateSha256,
      materializationId: state.prior.manifest.hyperbet.materializationId,
      manifest: state.restoredManifestFile,
    },
    chainExpectation: {
      createdAt: state.expectation.createdAt,
      changeReference: state.expectation.changeReference,
      file: state.expectationFile,
    },
    database: {
      schemaSha256: restored.databaseAfter.schemaSha256,
      logicalDataSha256: restored.databaseAfter.logicalDataSha256,
      tableCounts: restored.databaseAfter.tableCounts,
      unchangedAcrossDoubleFinalizedRead: true,
    },
    finalizedChain: {
      cluster: chain.cluster,
      genesisHash: chain.genesisHash,
      finalizedStartSlot: chain.finalizedStartSlot,
      finalizedEndSlot: chain.finalizedEndSlot,
      minimumAvailableSlot: chain.minimumAvailableSlot,
      transactionCount: chain.transactions.length,
      duelCount: chain.duels.length,
      marketCount: chain.markets.length,
      orderCount: chain.orders.length,
      balanceCount: chain.balances.length,
      custodyCount: chain.custody.length,
    },
    reconciliation,
    operatorSuppliedExpectationRequiresIndependentApproval: true,
    rpcProviderRetentionRequiresSeparateEvidence: true,
    databaseMutationAuthorized: false,
    chainMutationAuthorized: false,
    activationRequiresSeparateApproval: true,
    productionCutoverAuthorized: false,
  };
}

function isBoundFile(value: unknown): value is BoundFile {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["fileName", "sha256", "bytes"]) &&
    typeof value.fileName === "string" &&
    value.fileName.length > 0 &&
    value.fileName.length <= 255 &&
    path.basename(value.fileName) === value.fileName &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) > 0
  );
}

function parseEvidence(value: unknown): FinalizedSolanaRecoveryEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "reconciliationRunId",
      "verificationScope",
      "hyperbetReleaseSha",
      "boundaryId",
      "restored",
      "chainExpectation",
      "database",
      "finalizedChain",
      "reconciliation",
      "operatorSuppliedExpectationRequiresIndependentApproval",
      "rpcProviderRetentionRequiresSeparateEvidence",
      "databaseMutationAuthorized",
      "chainMutationAuthorized",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
    ]) ||
    value.schemaVersion !== 1 ||
    !isIsoTimestamp(value.createdAt) ||
    typeof value.reconciliationRunId !== "string" ||
    !UUID_V4.test(value.reconciliationRunId) ||
    value.verificationScope !==
      "finalized_solana_post_restore_bound_evidence_only" ||
    typeof value.hyperbetReleaseSha !== "string" ||
    !RELEASE_SHA.test(value.hyperbetReleaseSha) ||
    typeof value.boundaryId !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{7,63}$/u.test(value.boundaryId) ||
    !isRecord(value.restored) ||
    !isRecord(value.chainExpectation) ||
    !isRecord(value.database) ||
    !isRecord(value.finalizedChain) ||
    !isRecord(value.reconciliation) ||
    !hasExactKeys(value.restored, [
      "reconciliationId",
      "reconciledStateSha256",
      "materializationId",
      "manifest",
    ]) ||
    !hasExactKeys(value.chainExpectation, [
      "createdAt",
      "changeReference",
      "file",
    ]) ||
    !hasExactKeys(value.database, [
      "schemaSha256",
      "logicalDataSha256",
      "tableCounts",
      "unchangedAcrossDoubleFinalizedRead",
    ]) ||
    !hasExactKeys(value.finalizedChain, [
      "cluster",
      "genesisHash",
      "finalizedStartSlot",
      "finalizedEndSlot",
      "minimumAvailableSlot",
      "transactionCount",
      "duelCount",
      "marketCount",
      "orderCount",
      "balanceCount",
      "custodyCount",
    ]) ||
    !hasExactKeys(value.reconciliation, [
      "schemaVersion",
      "verificationScope",
      "cluster",
      "genesisHash",
      "restoredReconciliationId",
      "materializationId",
      "databaseLogicalDataSha256",
      "finalizedStartSlot",
      "finalizedEndSlot",
      "minimumAvailableSlot",
      "duelCount",
      "betCount",
      "indexedTransactionCount",
      "checkpointCount",
      "marketCount",
      "custodyExcessLamportsByMarket",
      "reconciledStateSha256",
      "databaseMutationAuthorized",
      "chainMutationAuthorized",
      "productionCutoverAuthorized",
      "activationRequiresSeparateApproval",
    ]) ||
    typeof value.restored.reconciliationId !== "string" ||
    !UUID_V4.test(value.restored.reconciliationId) ||
    typeof value.restored.materializationId !== "string" ||
    !UUID_V4.test(value.restored.materializationId) ||
    typeof value.restored.reconciledStateSha256 !== "string" ||
    !SHA256.test(value.restored.reconciledStateSha256) ||
    !isBoundFile(value.restored.manifest) ||
    !isIsoTimestamp(value.chainExpectation.createdAt) ||
    typeof value.chainExpectation.changeReference !== "string" ||
    value.chainExpectation.changeReference.length === 0 ||
    value.chainExpectation.changeReference.length > 128 ||
    !isBoundFile(value.chainExpectation.file) ||
    typeof value.database.schemaSha256 !== "string" ||
    !SHA256.test(value.database.schemaSha256) ||
    typeof value.database.logicalDataSha256 !== "string" ||
    !SHA256.test(value.database.logicalDataSha256) ||
    !isRecord(value.database.tableCounts) ||
    value.database.unchangedAcrossDoubleFinalizedRead !== true ||
    (value.finalizedChain.cluster !== "devnet" &&
      value.finalizedChain.cluster !== "mainnet-beta") ||
    value.reconciliation.schemaVersion !== 1 ||
    value.reconciliation.verificationScope !==
      "finalized_solana_post_restore_read_only_reconciliation" ||
    value.reconciliation.databaseMutationAuthorized !== false ||
    value.reconciliation.chainMutationAuthorized !== false ||
    value.reconciliation.activationRequiresSeparateApproval !== true ||
    value.reconciliation.productionCutoverAuthorized !== false ||
    !isRecord(value.reconciliation.custodyExcessLamportsByMarket) ||
    value.operatorSuppliedExpectationRequiresIndependentApproval !== true ||
    value.rpcProviderRetentionRequiresSeparateEvidence !== true ||
    value.databaseMutationAuthorized !== false ||
    value.chainMutationAuthorized !== false ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false
  ) {
    fail("evidence schema is invalid");
  }
  publicKey(value.finalizedChain.genesisHash, "evidence genesis hash");
  digest(
    value.reconciliation.databaseLogicalDataSha256,
    "evidence reconciliation database digest",
  );
  digest(
    value.reconciliation.reconciledStateSha256,
    "evidence reconciliation state digest",
  );
  if (
    value.reconciliation.cluster !== value.finalizedChain.cluster ||
    value.reconciliation.genesisHash !== value.finalizedChain.genesisHash ||
    value.reconciliation.restoredReconciliationId !==
      value.restored.reconciliationId ||
    value.reconciliation.materializationId !==
      value.restored.materializationId ||
    value.reconciliation.databaseLogicalDataSha256 !==
      value.database.logicalDataSha256 ||
    value.reconciliation.finalizedStartSlot !==
      value.finalizedChain.finalizedStartSlot ||
    value.reconciliation.finalizedEndSlot !==
      value.finalizedChain.finalizedEndSlot ||
    value.reconciliation.minimumAvailableSlot !==
      value.finalizedChain.minimumAvailableSlot ||
    value.reconciliation.duelCount !== value.finalizedChain.duelCount ||
    value.reconciliation.marketCount !== value.finalizedChain.marketCount ||
    value.reconciliation.indexedTransactionCount !==
      value.finalizedChain.transactionCount ||
    value.reconciliation.betCount !== value.finalizedChain.orderCount ||
    value.finalizedChain.custodyCount !== value.finalizedChain.marketCount ||
    Object.values(value.database.tableCounts).some(
      (count) => !Number.isSafeInteger(count) || Number(count) < 0,
    ) ||
    Object.values(value.reconciliation.custodyExcessLamportsByMarket).some(
      (excess) =>
        typeof excess !== "string" || !/^(0|[1-9][0-9]*)$/u.test(excess),
    )
  ) {
    fail("evidence counts or custody values are invalid");
  }
  for (const [label, slot] of [
    ["evidence finalized start slot", value.finalizedChain.finalizedStartSlot],
    ["evidence finalized end slot", value.finalizedChain.finalizedEndSlot],
    [
      "evidence minimum available slot",
      value.finalizedChain.minimumAvailableSlot,
    ],
    [
      "reconciliation finalized start slot",
      value.reconciliation.finalizedStartSlot,
    ],
    [
      "reconciliation finalized end slot",
      value.reconciliation.finalizedEndSlot,
    ],
    [
      "reconciliation minimum available slot",
      value.reconciliation.minimumAvailableSlot,
    ],
    ["evidence transaction count", value.finalizedChain.transactionCount],
    ["evidence duel count", value.finalizedChain.duelCount],
    ["evidence market count", value.finalizedChain.marketCount],
    ["evidence order count", value.finalizedChain.orderCount],
    ["evidence balance count", value.finalizedChain.balanceCount],
    ["evidence custody count", value.finalizedChain.custodyCount],
    ["reconciliation duel count", value.reconciliation.duelCount],
    ["reconciliation bet count", value.reconciliation.betCount],
    [
      "reconciliation indexed transaction count",
      value.reconciliation.indexedTransactionCount,
    ],
    ["reconciliation checkpoint count", value.reconciliation.checkpointCount],
    ["reconciliation market count", value.reconciliation.marketCount],
  ] as const) {
    safeInteger(slot, label);
  }
  return value as FinalizedSolanaRecoveryEvidence;
}

function stableEvidenceProjection(
  evidence: FinalizedSolanaRecoveryEvidence,
): unknown {
  return {
    ...evidence,
    finalizedChain: {
      ...evidence.finalizedChain,
      finalizedStartSlot: 0,
      finalizedEndSlot: 0,
      minimumAvailableSlot: 0,
    },
    reconciliation: {
      ...evidence.reconciliation,
      finalizedStartSlot: 0,
      finalizedEndSlot: 0,
      minimumAvailableSlot: 0,
    },
  };
}

function resolveNewEvidence(filePath: string): string {
  const absolute = path.resolve(filePath);
  if (path.basename(absolute) !== "finalized-solana-recovery-evidence.json") {
    fail("evidence filename is invalid");
  }
  if (existsSync(absolute)) fail("evidence already exists");
  const parent = lstatSync(path.dirname(absolute));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
    fail("evidence parent must be mode-0700");
  }
  return absolute;
}

function fsyncParent(filePath: string): void {
  const descriptor = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeEvidence(
  filePath: string,
  evidence: FinalizedSolanaRecoveryEvidence,
): void {
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    chmodSync(filePath, 0o600);
    fsyncSync(descriptor);
  } catch (error) {
    if (created) {
      try {
        unlinkSync(filePath);
        fsyncParent(filePath);
      } catch {
        // Preserve the original write failure; operators must inspect any residue.
      }
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fsyncParent(filePath);
}

export async function createFinalizedSolanaRecoveryQualification(
  input: CreateFinalizedSolanaRecoveryQualificationInput,
): Promise<FinalizedSolanaRecoveryEvidence> {
  const evidencePath = resolveNewEvidence(input.finalizedEvidencePath);
  if (!RELEASE_SHA.test(input.expectedHyperbetReleaseSha)) {
    fail("Hyperbet release SHA is invalid");
  }
  const state = await collectBoundState(input);
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const reconciliationRunId = (input.createId ?? randomUUID)();
  if (!isIsoTimestamp(createdAt) || !UUID_V4.test(reconciliationRunId)) {
    fail("evidence identity is invalid");
  }
  const evidence = buildEvidence(
    {
      createdAt,
      reconciliationRunId,
      hyperbetReleaseSha: input.expectedHyperbetReleaseSha,
    },
    state,
  );
  writeEvidence(evidencePath, evidence);
  try {
    return await verifyFinalizedSolanaRecoveryQualification(input);
  } catch (error) {
    unlinkSync(evidencePath);
    fsyncParent(evidencePath);
    throw error;
  }
}

export async function verifyFinalizedSolanaRecoveryQualification(
  input: VerifyFinalizedSolanaRecoveryQualificationInput,
): Promise<FinalizedSolanaRecoveryEvidence> {
  if (!RELEASE_SHA.test(input.expectedHyperbetReleaseSha)) {
    fail("Hyperbet release SHA is invalid");
  }
  const evidence = parseEvidence(
    readPrivateJson(
      input.finalizedEvidencePath,
      "finalized recovery evidence",
      MAX_EVIDENCE_BYTES,
    ),
  );
  const state = await collectBoundState(input);
  const expected = buildEvidence(
    {
      createdAt: evidence.createdAt,
      reconciliationRunId: evidence.reconciliationRunId,
      hyperbetReleaseSha: input.expectedHyperbetReleaseSha,
    },
    state,
  );
  if (
    expected.finalizedChain.finalizedEndSlot <
      evidence.finalizedChain.finalizedEndSlot ||
    canonicalEvidenceJson(stableEvidenceProjection(evidence)) !==
      canonicalEvidenceJson(stableEvidenceProjection(expected))
  ) {
    fail("evidence no longer matches the restored database or finalized chain");
  }
  return evidence;
}
