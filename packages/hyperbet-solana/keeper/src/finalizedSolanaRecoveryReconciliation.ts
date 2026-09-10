import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import { FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION } from "../../account-schema";
import { canonicalEvidenceJson, digestEvidence } from "./bettingFeedEvidence";
import {
  DUEL_WINNER_MARKET_KIND,
  duelKeyHexToBytes,
  findClobVaultPda,
  findDuelStatePda,
  findMarketConfigPda,
  findMarketPda,
  findOracleConfigPda,
  findOrderPda,
  findUserBalancePda,
} from "./launchCommon";
import { isCanonicalSolanaTransactionSignature } from "./solanaBetAccounting";
import { digestFailedFinalizedTransaction } from "./solanaLifecycleIndexer";
import { deriveProgramDataAddress } from "./solanaProgramIdentity";

const SHA256 = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;

export type FinalizedRecoveryCluster = "devnet" | "mainnet-beta";
export type FinalizedOracleStatus =
  | "scheduled"
  | "bettingOpen"
  | "locked"
  | "proposed"
  | "challenged"
  | "resolved"
  | "cancelled";
export type FinalizedMarketStatus =
  "open" | "locked" | "resolved" | "cancelled";
export type FinalizedWinner = "none" | "a" | "b";

export type FinalizedRecoveryDatabaseInspection = {
  integrityCheck: "ok";
  foreignKeyViolations: 0;
  schemaSha256: string;
  logicalDataSha256: string;
  tableCounts: Record<string, number>;
};

export type FinalizedRecoveryDeploymentExpectation = {
  cluster: FinalizedRecoveryCluster;
  genesisHash: string;
  fightOracleProgramId: string;
  duelMarketProgramId: string;
  expectedUpgradeAuthority: string | null;
  configAuthority: string;
  reporter: string;
  finalizer: string;
  challenger: string;
  marketOperator: string;
  treasury: string;
  marketMaker: string;
  disputeWindowSecs: number;
  tradeTreasuryFeeBps: number;
  tradeMarketMakerFeeBps: number;
  winningsMarketMakerFeeBps: number;
  oraclePaused: boolean;
  orderPlacementPaused: boolean;
  marketCreationPaused: boolean;
};

export type FinalizedRecoveryRestoredDuel = {
  duelId: string;
  duelKey: string;
  participantAId: string;
  participantBId: string;
  competitiveSnapshotVersion: number;
  competitiveSnapshotDigest: string;
  terminalOutcome: "win" | "draw" | "cancelled" | null;
  terminalWinnerSide: "A" | "B" | null;
  terminalSeed: string | null;
  terminalReplayHash: string | null;
};

export type FinalizedRecoveryRestoredBet = {
  betId: string;
  duelId: string;
  duelKey: string;
  marketPda: string;
  wallet: string;
  placementSignature: string;
  orderId: string;
  side: 1 | 2;
  limitPrice: number;
  orderBehavior: 0 | 1 | 2;
  orderAmountUnits: string;
  currentMatchedAmountUnits: string;
  currentRestingAmountUnits: string;
  currentReleasedAmountUnits: string;
  terminalOrderDisposition:
    "none" | "cancelled" | "reclaimed" | "filled_closed";
  terminalBalanceDisposition:
    "none" | "claimed" | "refunded" | "losing_closed" | "empty_closed";
};

export type FinalizedRecoveryIndexedTransaction = {
  programId: string;
  signature: string;
  slot: number;
  succeeded: boolean;
  transactionDigest: string;
};

export type FinalizedRecoveryIndexerCheckpoint = {
  programId: string;
  startSlot: number;
  signature: string;
  slot: number;
};

export type FinalizedRecoveryRestoredState = {
  restoredReconciliationId: string;
  restoredReconciliationSha256: string;
  restoredReconciledStateSha256: string;
  materializationId: string;
  databaseBefore: FinalizedRecoveryDatabaseInspection;
  databaseAfter: FinalizedRecoveryDatabaseInspection;
  duels: FinalizedRecoveryRestoredDuel[];
  bets: FinalizedRecoveryRestoredBet[];
  indexedTransactions: FinalizedRecoveryIndexedTransaction[];
  indexerCheckpoints: FinalizedRecoveryIndexerCheckpoint[];
};

export type FinalizedRecoveryProgramObservation = {
  programId: string;
  programDataAddress: string;
  upgradeAuthority: string | null;
  deployedSlot: string;
};

export type FinalizedRecoveryOracleConfigObservation = {
  address: string;
  authority: string;
  reporter: string;
  finalizer: string;
  challenger: string;
  disputeWindowSecs: number;
  paused: boolean;
  configFrozen: boolean;
  accountSchemaVersion: number;
};

export type FinalizedRecoveryMarketConfigObservation = {
  address: string;
  authority: string;
  marketOperator: string;
  treasury: string;
  marketMaker: string;
  tradeTreasuryFeeBps: number;
  tradeMarketMakerFeeBps: number;
  winningsMarketMakerFeeBps: number;
  orderPlacementPaused: boolean;
  marketCreationPaused: boolean;
  configFrozen: boolean;
};

export type FinalizedRecoveryTransactionObservation = {
  signature: string;
  slot: number;
  succeeded: boolean;
  confirmationStatus: "finalized";
  transactionDigest: string;
  accountKeys: string[];
};

export type FinalizedRecoveryDuelObservation = {
  duelId: string;
  duelKey: string;
  address: string;
  observedSlot: number;
  status: FinalizedOracleStatus;
  winner: FinalizedWinner;
  participantAHash: string;
  participantBHash: string;
  competitiveSnapshotVersion: number;
  competitiveSnapshotDigest: string;
  seed: string;
  replayHash: string;
};

export type FinalizedRecoveryMarketObservation = {
  duelId: string;
  duelKey: string;
  address: string;
  duelStateAddress: string;
  vaultAddress: string;
  observedSlot: number;
  marketKind: 1;
  status: FinalizedMarketStatus;
  winner: FinalizedWinner;
  authority: string;
  treasury: string;
  marketMaker: string;
  tradeTreasuryFeeBpsSnapshot: number;
  tradeMarketMakerFeeBpsSnapshot: number;
  winningsMarketMakerFeeBpsSnapshot: number;
  nextOrderId: string;
  accruedTradeTreasuryFeeLamports: string;
  accruedTradeMarketMakerFeeLamports: string;
};

export type FinalizedRecoveryOrderObservation = {
  betId: string;
  address: string;
  observedSlot: number;
  exists: boolean;
  marketPda: string | null;
  orderId: string | null;
  maker: string | null;
  side: 1 | 2 | null;
  price: number | null;
  orderBehavior: 0 | 1 | 2 | null;
  amountUnits: string | null;
  filledUnits: string | null;
  active: boolean | null;
  continuationPending: boolean | null;
};

export type FinalizedRecoveryBalanceObservation = {
  wallet: string;
  marketPda: string;
  address: string;
  observedSlot: number;
  exists: boolean;
};

export type FinalizedRecoveryCustodyObservation = {
  marketPda: string;
  vaultAddress: string;
  observedSlot: number;
  vaultBalanceLamports: string;
  vaultRentExemptMinimumLamports: string;
  userBalanceCount: number;
  activeOrderCount: number;
  activeOrderCollateralLamports: string;
  totalAShares: string;
  totalBShares: string;
  totalALockedLamports: string;
  totalBLockedLamports: string;
  totalTradeTreasuryFeeLamports: string;
  totalTradeMarketMakerFeeLamports: string;
};

export type FinalizedRecoveryChainObservation = {
  cluster: FinalizedRecoveryCluster;
  genesisHash: string;
  minimumAvailableSlot: number;
  finalizedStartSlot: number;
  finalizedEndSlot: number;
  fightOracleProgram: FinalizedRecoveryProgramObservation;
  duelMarketProgram: FinalizedRecoveryProgramObservation;
  oracleConfig: FinalizedRecoveryOracleConfigObservation;
  marketConfig: FinalizedRecoveryMarketConfigObservation;
  transactions: FinalizedRecoveryTransactionObservation[];
  duels: FinalizedRecoveryDuelObservation[];
  markets: FinalizedRecoveryMarketObservation[];
  orders: FinalizedRecoveryOrderObservation[];
  balances: FinalizedRecoveryBalanceObservation[];
  custody: FinalizedRecoveryCustodyObservation[];
};

export type FinalizedSolanaRecoveryReconciliation = {
  schemaVersion: 1;
  verificationScope: "finalized_solana_post_restore_read_only_reconciliation";
  cluster: FinalizedRecoveryCluster;
  genesisHash: string;
  restoredReconciliationId: string;
  materializationId: string;
  databaseLogicalDataSha256: string;
  finalizedStartSlot: number;
  finalizedEndSlot: number;
  minimumAvailableSlot: number;
  duelCount: number;
  betCount: number;
  indexedTransactionCount: number;
  checkpointCount: number;
  marketCount: number;
  custodyExcessLamportsByMarket: Record<string, string>;
  reconciledStateSha256: string;
  databaseMutationAuthorized: false;
  chainMutationAuthorized: false;
  productionCutoverAuthorized: false;
  activationRequiresSeparateApproval: true;
};

function fail(message: string): never {
  throw new Error(`finalized Solana recovery reconciliation ${message}`);
}

function text(value: unknown, label: string, max = 256): string {
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
  const result = text(value, label, 64);
  if (!SHA256.test(result)) fail(`${label} is invalid`);
  return result;
}

function publicKey(value: unknown, label: string): string {
  const result = text(value, label, 44);
  try {
    if (new PublicKey(result).toBase58() !== result) throw new Error("drift");
  } catch {
    fail(`${label} is invalid`);
  }
  return result;
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !UINT.test(value)) {
    fail(`${label} is invalid`);
  }
  return BigInt(value);
}

function slot(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(`${label} is invalid`);
  }
  return Number(value);
}

function bps(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > 10_000
  ) {
    fail(`${label} is invalid`);
  }
  return Number(value);
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) fail(`${label} contains duplicate ${identity}`);
    result.set(identity, value);
  }
  return result;
}

function participantHash(participantId: string): string {
  return createHash("sha256").update(participantId).digest("hex");
}

function assertDatabaseStable(input: FinalizedRecoveryRestoredState): void {
  const before = input.databaseBefore;
  const after = input.databaseAfter;
  if (
    before.integrityCheck !== "ok" ||
    after.integrityCheck !== "ok" ||
    before.foreignKeyViolations !== 0 ||
    after.foreignKeyViolations !== 0 ||
    !SHA256.test(before.schemaSha256) ||
    !SHA256.test(before.logicalDataSha256) ||
    canonicalEvidenceJson(before) !== canonicalEvidenceJson(after)
  ) {
    fail("database changed while finalized state was read");
  }
}

function assertProgram(input: {
  label: string;
  expectedProgramId: string;
  expectedUpgradeAuthority: string | null;
  observation: FinalizedRecoveryProgramObservation;
  finalizedSlot: number;
}): void {
  const programId = publicKey(
    input.expectedProgramId,
    `${input.label} program ID`,
  );
  const observationProgramId = publicKey(
    input.observation.programId,
    `${input.label} observed program ID`,
  );
  const expectedProgramData = deriveProgramDataAddress(
    new PublicKey(programId),
  ).toBase58();
  const deployedSlot = uint(
    input.observation.deployedSlot,
    `${input.label} deployed slot`,
  );
  const observedAuthority =
    input.observation.upgradeAuthority === null
      ? null
      : publicKey(
          input.observation.upgradeAuthority,
          `${input.label} upgrade authority`,
        );
  const expectedAuthority =
    input.expectedUpgradeAuthority === null
      ? null
      : publicKey(
          input.expectedUpgradeAuthority,
          `${input.label} expected upgrade authority`,
        );
  if (
    observationProgramId !== programId ||
    publicKey(
      input.observation.programDataAddress,
      `${input.label} ProgramData`,
    ) !== expectedProgramData ||
    observedAuthority !== expectedAuthority ||
    deployedSlot > BigInt(input.finalizedSlot)
  ) {
    fail(`${input.label} deployment identity drifted`);
  }
}

function expectedTerminalState(duel: FinalizedRecoveryRestoredDuel): {
  oracleStatus: FinalizedOracleStatus | null;
  marketStatus: FinalizedMarketStatus | null;
  winner: FinalizedWinner;
} {
  if (duel.terminalOutcome === "win") {
    if (duel.terminalWinnerSide !== "A" && duel.terminalWinnerSide !== "B") {
      fail(`duel ${duel.duelId} winning side is absent`);
    }
    return {
      oracleStatus: "resolved",
      marketStatus: "resolved",
      winner: duel.terminalWinnerSide.toLowerCase() as "a" | "b",
    };
  }
  if (duel.terminalOutcome === "draw" || duel.terminalOutcome === "cancelled") {
    if (duel.terminalWinnerSide !== null) {
      fail(`duel ${duel.duelId} cancellation has a winner`);
    }
    return {
      oracleStatus: "cancelled",
      marketStatus: "cancelled",
      winner: "none",
    };
  }
  if (
    duel.terminalWinnerSide !== null ||
    duel.terminalSeed !== null ||
    duel.terminalReplayHash !== null
  ) {
    fail(`duel ${duel.duelId} nonterminal state contains terminal values`);
  }
  return { oracleStatus: null, marketStatus: null, winner: "none" };
}

function marketStatusForOracle(
  status: FinalizedOracleStatus,
): FinalizedMarketStatus {
  if (status === "bettingOpen") return "open";
  if (status === "resolved") return "resolved";
  if (status === "cancelled") return "cancelled";
  return "locked";
}

function assertObservationSlot(
  observedSlot: number,
  startSlot: number,
  endSlot: number,
  label: string,
): void {
  const observed = slot(observedSlot, label);
  if (observed < startSlot || observed > endSlot) {
    fail(`${label} is outside the finalized observation window`);
  }
}

function stableChainStateProjection(
  chain: FinalizedRecoveryChainObservation,
): unknown {
  const stripObservationSlot = <T extends { observedSlot: number }>(
    value: T,
  ) => {
    const { observedSlot: _observedSlot, ...state } = value;
    return state;
  };
  return {
    ...chain,
    minimumAvailableSlot: 0,
    finalizedStartSlot: 0,
    finalizedEndSlot: 0,
    duels: chain.duels.map(stripObservationSlot),
    markets: chain.markets.map(stripObservationSlot),
    orders: chain.orders.map(stripObservationSlot),
    balances: chain.balances.map(stripObservationSlot),
    custody: chain.custody.map(stripObservationSlot),
  };
}

export function verifyFinalizedSolanaRecoveryReconciliation(input: {
  expectation: FinalizedRecoveryDeploymentExpectation;
  restored: FinalizedRecoveryRestoredState;
  chain: FinalizedRecoveryChainObservation;
}): FinalizedSolanaRecoveryReconciliation {
  const { expectation, restored, chain } = input;
  assertDatabaseStable(restored);
  digest(
    restored.restoredReconciliationSha256,
    "restored reconciliation digest",
  );
  digest(restored.restoredReconciledStateSha256, "restored state digest");
  text(restored.restoredReconciliationId, "restored reconciliation ID");
  text(restored.materializationId, "materialization ID");

  const genesisHash = publicKey(
    expectation.genesisHash,
    "expected genesis hash",
  );
  if (
    chain.cluster !== expectation.cluster ||
    publicKey(chain.genesisHash, "observed genesis hash") !== genesisHash
  ) {
    fail("cluster or genesis identity drifted");
  }
  const minimumAvailableSlot = slot(
    chain.minimumAvailableSlot,
    "minimum available slot",
  );
  const finalizedStartSlot = slot(
    chain.finalizedStartSlot,
    "finalized start slot",
  );
  const finalizedEndSlot = slot(chain.finalizedEndSlot, "finalized end slot");
  if (finalizedEndSlot < finalizedStartSlot) {
    fail("finalized observation slot regressed");
  }

  const fightOracleProgramId = publicKey(
    expectation.fightOracleProgramId,
    "fight oracle program ID",
  );
  const duelMarketProgramId = publicKey(
    expectation.duelMarketProgramId,
    "duel market program ID",
  );
  if (fightOracleProgramId === duelMarketProgramId) {
    fail("program identities are not distinct");
  }
  assertProgram({
    label: "fight oracle",
    expectedProgramId: fightOracleProgramId,
    expectedUpgradeAuthority: expectation.expectedUpgradeAuthority,
    observation: chain.fightOracleProgram,
    finalizedSlot: finalizedEndSlot,
  });
  assertProgram({
    label: "duel market",
    expectedProgramId: duelMarketProgramId,
    expectedUpgradeAuthority: expectation.expectedUpgradeAuthority,
    observation: chain.duelMarketProgram,
    finalizedSlot: finalizedEndSlot,
  });

  const configAuthority = publicKey(
    expectation.configAuthority,
    "config authority",
  );
  const reporter = publicKey(expectation.reporter, "reporter");
  const finalizer = publicKey(expectation.finalizer, "finalizer");
  const challenger = publicKey(expectation.challenger, "challenger");
  const marketOperator = publicKey(
    expectation.marketOperator,
    "market operator",
  );
  const treasury = publicKey(expectation.treasury, "treasury");
  const marketMaker = publicKey(expectation.marketMaker, "market maker");
  const roles = [
    configAuthority,
    reporter,
    finalizer,
    challenger,
    marketOperator,
    treasury,
    marketMaker,
  ];
  if (new Set(roles).size !== roles.length)
    fail("launch roles are not distinct");
  if (
    !Number.isSafeInteger(expectation.disputeWindowSecs) ||
    expectation.disputeWindowSecs < 60
  ) {
    fail("dispute window is invalid");
  }
  const treasuryFeeBps = bps(
    expectation.tradeTreasuryFeeBps,
    "treasury trade fee",
  );
  const marketMakerFeeBps = bps(
    expectation.tradeMarketMakerFeeBps,
    "market-maker trade fee",
  );
  const winningsFeeBps = bps(
    expectation.winningsMarketMakerFeeBps,
    "market-maker winnings fee",
  );
  if (treasuryFeeBps < 1 || treasuryFeeBps + marketMakerFeeBps > 10_000) {
    fail("fee policy is invalid");
  }

  const expectedOracleConfig = findOracleConfigPda(
    new PublicKey(fightOracleProgramId),
  ).toBase58();
  const expectedMarketConfig = findMarketConfigPda(
    new PublicKey(duelMarketProgramId),
  ).toBase58();
  const oracleConfig = chain.oracleConfig;
  const marketConfig = chain.marketConfig;
  if (
    publicKey(oracleConfig.address, "oracle config address") !==
      expectedOracleConfig ||
    publicKey(oracleConfig.authority, "oracle authority") !== configAuthority ||
    publicKey(oracleConfig.reporter, "oracle reporter") !== reporter ||
    publicKey(oracleConfig.finalizer, "oracle finalizer") !== finalizer ||
    publicKey(oracleConfig.challenger, "oracle challenger") !== challenger ||
    oracleConfig.disputeWindowSecs !== expectation.disputeWindowSecs ||
    oracleConfig.paused !== expectation.oraclePaused ||
    oracleConfig.configFrozen !== true ||
    oracleConfig.accountSchemaVersion !== FIGHT_ORACLE_ACCOUNT_SCHEMA_VERSION
  ) {
    fail("oracle configuration drifted");
  }
  if (
    publicKey(marketConfig.address, "market config address") !==
      expectedMarketConfig ||
    publicKey(marketConfig.authority, "market config authority") !==
      configAuthority ||
    publicKey(marketConfig.marketOperator, "configured market operator") !==
      marketOperator ||
    publicKey(marketConfig.treasury, "configured treasury") !== treasury ||
    publicKey(marketConfig.marketMaker, "configured market maker") !==
      marketMaker ||
    marketConfig.tradeTreasuryFeeBps !== treasuryFeeBps ||
    marketConfig.tradeMarketMakerFeeBps !== marketMakerFeeBps ||
    marketConfig.winningsMarketMakerFeeBps !== winningsFeeBps ||
    marketConfig.orderPlacementPaused !== expectation.orderPlacementPaused ||
    marketConfig.marketCreationPaused !== expectation.marketCreationPaused ||
    marketConfig.configFrozen !== true
  ) {
    fail("market configuration drifted");
  }

  const duels = uniqueMap(
    restored.duels,
    (value) => text(value.duelId, "duel ID"),
    "restored duels",
  );
  const bets = uniqueMap(
    restored.bets,
    (value) => text(value.betId, "bet ID"),
    "restored bets",
  );
  const indexed = uniqueMap(
    restored.indexedTransactions,
    (value) =>
      `${publicKey(value.programId, "indexed program ID")}:${value.signature}`,
    "indexed transactions",
  );
  const checkpoints = uniqueMap(
    restored.indexerCheckpoints,
    (value) => publicKey(value.programId, "checkpoint program ID"),
    "indexer checkpoints",
  );
  const observedTransactions = uniqueMap(
    chain.transactions,
    (value) => value.signature,
    "chain transactions",
  );
  const observedDuels = uniqueMap(
    chain.duels,
    (value) => value.duelId,
    "chain duels",
  );
  const observedMarkets = uniqueMap(
    chain.markets,
    (value) => value.duelId,
    "chain markets",
  );
  const observedOrders = uniqueMap(
    chain.orders,
    (value) => value.betId,
    "chain orders",
  );
  const observedBalances = uniqueMap(
    chain.balances,
    (value) => `${value.marketPda}:${value.wallet}`,
    "chain balances",
  );
  const observedCustody = uniqueMap(
    chain.custody,
    (value) => value.marketPda,
    "chain custody",
  );
  if (
    observedTransactions.size !== indexed.size ||
    observedDuels.size !== duels.size ||
    observedMarkets.size !== duels.size ||
    observedOrders.size !== bets.size ||
    observedCustody.size !== duels.size
  ) {
    fail("chain observation cardinality does not exactly match restored state");
  }
  const expectedBalanceKeys = new Set(
    restored.bets.map(
      (bet) =>
        `${publicKey(bet.marketPda, `bet ${bet.betId} market`)}:${publicKey(
          bet.wallet,
          `bet ${bet.betId} wallet`,
        )}`,
    ),
  );
  if (
    observedBalances.size !== expectedBalanceKeys.size ||
    [...observedBalances.keys()].some(
      (identity) => !expectedBalanceKeys.has(identity),
    )
  ) {
    fail("chain balance observation cardinality does not match restored bets");
  }

  if (bets.size > 0 && !checkpoints.has(duelMarketProgramId)) {
    fail("duel-market lifecycle checkpoint is absent");
  }
  for (const checkpoint of checkpoints.values()) {
    const programId = publicKey(checkpoint.programId, "checkpoint program ID");
    if (programId !== duelMarketProgramId) {
      fail("unexpected lifecycle checkpoint program");
    }
    const start = slot(checkpoint.startSlot, "checkpoint start slot");
    const through = slot(checkpoint.slot, "checkpoint slot");
    if (
      start < minimumAvailableSlot ||
      through < start ||
      through > finalizedEndSlot ||
      !isCanonicalSolanaTransactionSignature(checkpoint.signature)
    ) {
      fail("lifecycle checkpoint is not recoverable from finalized history");
    }
    const transaction = indexed.get(`${programId}:${checkpoint.signature}`);
    const observed = observedTransactions.get(checkpoint.signature);
    if (
      !transaction ||
      !observed ||
      transaction.slot !== through ||
      observed.slot !== through
    ) {
      fail("lifecycle checkpoint is not bound to indexed finalized evidence");
    }
  }

  for (const transaction of indexed.values()) {
    const programId = publicKey(transaction.programId, "indexed program ID");
    if (programId !== duelMarketProgramId) fail("unexpected indexed program");
    if (!isCanonicalSolanaTransactionSignature(transaction.signature)) {
      fail("indexed transaction signature is invalid");
    }
    const transactionSlot = slot(transaction.slot, "indexed transaction slot");
    const observed = observedTransactions.get(transaction.signature);
    if (typeof transaction.succeeded !== "boolean") {
      fail(`indexed transaction ${transaction.signature} status is invalid`);
    }
    const expectedDigest = transaction.succeeded
      ? transaction.transactionDigest
      : digestFailedFinalizedTransaction(transaction.signature);
    if (
      !SHA256.test(transaction.transactionDigest) ||
      transaction.transactionDigest !== expectedDigest ||
      !observed ||
      observed.confirmationStatus !== "finalized" ||
      observed.succeeded !== transaction.succeeded ||
      observed.slot !== transactionSlot ||
      observed.slot < minimumAvailableSlot ||
      observed.slot > finalizedEndSlot ||
      observed.transactionDigest !== expectedDigest ||
      new Set(observed.accountKeys).size !== observed.accountKeys.length ||
      observed.accountKeys.some(
        (key) => publicKey(key, "transaction account key") !== key,
      )
    ) {
      fail(
        `indexed transaction ${transaction.signature} drifted from finalized history`,
      );
    }
  }

  const marketPdas = new Set<string>();
  for (const duel of duels.values()) {
    const duelKey = digest(duel.duelKey, `duel ${duel.duelId} key`);
    digest(
      duel.competitiveSnapshotDigest,
      `duel ${duel.duelId} snapshot digest`,
    );
    text(duel.participantAId, `duel ${duel.duelId} participant A`);
    text(duel.participantBId, `duel ${duel.duelId} participant B`);
    if (
      duel.participantAId === duel.participantBId ||
      !Number.isSafeInteger(duel.competitiveSnapshotVersion) ||
      duel.competitiveSnapshotVersion < 1
    ) {
      fail(`duel ${duel.duelId} restored identity is invalid`);
    }
    const duelAddress = findDuelStatePda(
      new PublicKey(fightOracleProgramId),
      duelKeyHexToBytes(duelKey),
    ).toBase58();
    const marketAddress = findMarketPda(
      new PublicKey(duelMarketProgramId),
      new PublicKey(duelAddress),
      DUEL_WINNER_MARKET_KIND,
    ).toBase58();
    const vaultAddress = findClobVaultPda(
      new PublicKey(duelMarketProgramId),
      new PublicKey(marketAddress),
    ).toBase58();
    marketPdas.add(marketAddress);
    const observedDuel = observedDuels.get(duel.duelId);
    const observedMarket = observedMarkets.get(duel.duelId);
    if (!observedDuel || !observedMarket)
      fail(`duel ${duel.duelId} chain state is absent`);
    assertObservationSlot(
      observedDuel.observedSlot,
      finalizedStartSlot,
      finalizedEndSlot,
      `duel ${duel.duelId} observation slot`,
    );
    assertObservationSlot(
      observedMarket.observedSlot,
      finalizedStartSlot,
      finalizedEndSlot,
      `market ${duel.duelId} observation slot`,
    );
    const expectedTerminal = expectedTerminalState(duel);
    const oracleIsAllowedNonterminal =
      expectedTerminal.oracleStatus === null &&
      ["scheduled", "bettingOpen", "locked", "proposed", "challenged"].includes(
        observedDuel.status,
      );
    if (
      observedDuel.duelKey !== duelKey ||
      publicKey(observedDuel.address, "duel address") !== duelAddress
    ) {
      fail(`duel ${duel.duelId} oracle identity drifted`);
    }
    if (
      observedDuel.participantAHash !== participantHash(duel.participantAId) ||
      observedDuel.participantBHash !== participantHash(duel.participantBId)
    ) {
      fail(`duel ${duel.duelId} oracle participants drifted`);
    }
    if (
      observedDuel.competitiveSnapshotVersion !==
        duel.competitiveSnapshotVersion ||
      observedDuel.competitiveSnapshotDigest !== duel.competitiveSnapshotDigest
    ) {
      fail(`duel ${duel.duelId} oracle competitive snapshot drifted`);
    }
    if (
      (!oracleIsAllowedNonterminal &&
        observedDuel.status !== expectedTerminal.oracleStatus) ||
      observedDuel.winner !== expectedTerminal.winner
    ) {
      fail(
        `duel ${duel.duelId} oracle lifecycle drifted (observed ${observedDuel.status}/${observedDuel.winner})`,
      );
    }
    if (duel.terminalOutcome === "win") {
      if (
        uint(observedDuel.seed, `duel ${duel.duelId} seed`).toString() !==
          duel.terminalSeed ||
        observedDuel.replayHash !== duel.terminalReplayHash
      ) {
        fail(`duel ${duel.duelId} terminal proof drifted`);
      }
    }
    const expectedMarketStatus =
      expectedTerminal.marketStatus ??
      marketStatusForOracle(observedDuel.status);
    if (
      observedMarket.duelKey !== duelKey ||
      publicKey(observedMarket.address, "market address") !== marketAddress ||
      publicKey(observedMarket.duelStateAddress, "market duel address") !==
        duelAddress ||
      publicKey(observedMarket.vaultAddress, "market vault address") !==
        vaultAddress ||
      observedMarket.marketKind !== DUEL_WINNER_MARKET_KIND ||
      observedMarket.status !== expectedMarketStatus ||
      observedMarket.winner !== expectedTerminal.winner ||
      publicKey(observedMarket.authority, "market authority") !==
        marketOperator ||
      publicKey(observedMarket.treasury, "market treasury") !== treasury ||
      publicKey(observedMarket.marketMaker, "market maker") !== marketMaker ||
      observedMarket.tradeTreasuryFeeBpsSnapshot !== treasuryFeeBps ||
      observedMarket.tradeMarketMakerFeeBpsSnapshot !== marketMakerFeeBps ||
      observedMarket.winningsMarketMakerFeeBpsSnapshot !== winningsFeeBps
    ) {
      fail(`duel ${duel.duelId} market state drifted`);
    }
  }

  const restoredActiveOrderCountByMarket = new Map<string, number>();
  const restoredActiveOrderCollateralByMarket = new Map<string, bigint>();
  for (const bet of bets.values()) {
    const duel = duels.get(bet.duelId);
    if (!duel || bet.duelKey !== duel.duelKey)
      fail(`bet ${bet.betId} duel identity drifted`);
    const wallet = publicKey(bet.wallet, `bet ${bet.betId} wallet`);
    const marketPda = publicKey(bet.marketPda, `bet ${bet.betId} market`);
    if (!marketPdas.has(marketPda))
      fail(`bet ${bet.betId} references an unknown market`);
    if (!isCanonicalSolanaTransactionSignature(bet.placementSignature)) {
      fail(`bet ${bet.betId} placement signature is invalid`);
    }
    const orderId = uint(bet.orderId, `bet ${bet.betId} order ID`);
    const amount = uint(bet.orderAmountUnits, `bet ${bet.betId} amount`);
    const matched = uint(
      bet.currentMatchedAmountUnits,
      `bet ${bet.betId} matched amount`,
    );
    const resting = uint(
      bet.currentRestingAmountUnits,
      `bet ${bet.betId} resting amount`,
    );
    const released = uint(
      bet.currentReleasedAmountUnits,
      `bet ${bet.betId} released amount`,
    );
    if (
      orderId === 0n ||
      amount === 0n ||
      amount % 1_000n !== 0n ||
      matched + resting + released !== amount ||
      !Number.isSafeInteger(bet.limitPrice) ||
      bet.limitPrice <= 0 ||
      bet.limitPrice >= 1_000 ||
      ![0, 1, 2].includes(bet.orderBehavior)
    ) {
      fail(`bet ${bet.betId} accounting is invalid`);
    }
    const indexedPlacement = indexed.get(
      `${duelMarketProgramId}:${bet.placementSignature}`,
    );
    const observedPlacement = observedTransactions.get(bet.placementSignature);
    const orderAddress = findOrderPda(
      new PublicKey(duelMarketProgramId),
      new PublicKey(marketPda),
      orderId,
    ).toBase58();
    const balanceAddress = findUserBalancePda(
      new PublicKey(duelMarketProgramId),
      new PublicKey(marketPda),
      new PublicKey(wallet),
    ).toBase58();
    if (
      !indexedPlacement ||
      !observedPlacement ||
      indexedPlacement.succeeded !== true ||
      observedPlacement.succeeded !== true ||
      !observedPlacement.accountKeys.includes(marketPda) ||
      !observedPlacement.accountKeys.includes(wallet) ||
      !observedPlacement.accountKeys.includes(orderAddress) ||
      !observedPlacement.accountKeys.includes(balanceAddress)
    ) {
      fail(`bet ${bet.betId} placement transaction is not exactly bound`);
    }
    const restoredMarket = [...observedMarkets.values()].find(
      (market) => market.address === marketPda,
    );
    if (
      !restoredMarket ||
      uint(restoredMarket.nextOrderId, `market ${marketPda} next order ID`) <=
        orderId
    ) {
      fail(
        `bet ${bet.betId} order ID is outside the canonical market sequence`,
      );
    }
    const order = observedOrders.get(bet.betId);
    if (!order || publicKey(order.address, "order address") !== orderAddress) {
      fail(`bet ${bet.betId} order observation is absent`);
    }
    assertObservationSlot(
      order.observedSlot,
      finalizedStartSlot,
      finalizedEndSlot,
      `bet ${bet.betId} order observation slot`,
    );
    if (order.exists) {
      if (
        order.marketPda !== marketPda ||
        order.orderId !== orderId.toString() ||
        order.maker !== wallet ||
        order.side !== bet.side ||
        order.price !== bet.limitPrice ||
        order.orderBehavior !== bet.orderBehavior ||
        order.amountUnits !== amount.toString() ||
        order.filledUnits === null ||
        uint(order.filledUnits, `bet ${bet.betId} filled amount`) > amount ||
        order.active === null ||
        order.continuationPending === null ||
        order.continuationPending ||
        (order.active &&
          amount - uint(order.filledUnits, `bet ${bet.betId} filled amount`) !==
            resting) ||
        (!order.active && resting !== 0n)
      ) {
        fail(`bet ${bet.betId} order state drifted`);
      }
      if (order.active) {
        const remaining =
          amount - uint(order.filledUnits!, `bet ${bet.betId} filled amount`);
        const priceComponent = BigInt(
          bet.side === 1 ? bet.limitPrice : 1_000 - bet.limitPrice,
        );
        const numerator = remaining * priceComponent;
        if (numerator % 1_000n !== 0n) {
          fail(`bet ${bet.betId} active collateral is inexact`);
        }
        restoredActiveOrderCountByMarket.set(
          marketPda,
          (restoredActiveOrderCountByMarket.get(marketPda) ?? 0) + 1,
        );
        restoredActiveOrderCollateralByMarket.set(
          marketPda,
          (restoredActiveOrderCollateralByMarket.get(marketPda) ?? 0n) +
            numerator / 1_000n,
        );
      }
    } else if (resting !== 0n || bet.terminalOrderDisposition === "none") {
      fail(`bet ${bet.betId} closed order lacks finalized disposition`);
    } else if (
      order.marketPda !== null ||
      order.orderId !== null ||
      order.maker !== null ||
      order.side !== null ||
      order.price !== null ||
      order.orderBehavior !== null ||
      order.amountUnits !== null ||
      order.filledUnits !== null ||
      order.active !== null ||
      order.continuationPending !== null
    ) {
      fail(`bet ${bet.betId} absent order contains state`);
    }

    const balance = observedBalances.get(`${marketPda}:${wallet}`);
    if (
      !balance ||
      publicKey(balance.address, "balance address") !== balanceAddress
    ) {
      fail(`bet ${bet.betId} user balance observation is absent`);
    }
    assertObservationSlot(
      balance.observedSlot,
      finalizedStartSlot,
      finalizedEndSlot,
      `bet ${bet.betId} balance observation slot`,
    );
    if (
      !balance.exists &&
      bet.terminalBalanceDisposition === "none" &&
      (matched !== 0n || resting !== 0n)
    ) {
      fail(`bet ${bet.betId} absent balance lacks finalized disposition`);
    }
  }

  const custodyExcessLamportsByMarket: Record<string, string> = {};
  for (const duel of duels.values()) {
    const market = observedMarkets.get(duel.duelId)!;
    const custody = observedCustody.get(market.address);
    if (!custody)
      fail(`market ${market.address} custody observation is absent`);
    assertObservationSlot(
      custody.observedSlot,
      finalizedStartSlot,
      finalizedEndSlot,
      `market ${market.address} custody observation slot`,
    );
    const vault = uint(custody.vaultBalanceLamports, "vault balance");
    const rent = uint(
      custody.vaultRentExemptMinimumLamports,
      "vault rent reserve",
    );
    const aShares = uint(custody.totalAShares, "total A shares");
    const bShares = uint(custody.totalBShares, "total B shares");
    const aLocked = uint(
      custody.totalALockedLamports,
      "total A locked lamports",
    );
    const bLocked = uint(
      custody.totalBLockedLamports,
      "total B locked lamports",
    );
    const treasuryFees = uint(
      custody.totalTradeTreasuryFeeLamports,
      "total treasury fees",
    );
    const marketMakerFees = uint(
      custody.totalTradeMarketMakerFeeLamports,
      "total market-maker fees",
    );
    const activeOrderCollateral = uint(
      custody.activeOrderCollateralLamports,
      "active order collateral",
    );
    const accruedTreasury = uint(
      market.accruedTradeTreasuryFeeLamports,
      "accrued treasury fees",
    );
    const accruedMarketMaker = uint(
      market.accruedTradeMarketMakerFeeLamports,
      "accrued market-maker fees",
    );
    if (
      publicKey(custody.marketPda, "custody market") !== market.address ||
      publicKey(custody.vaultAddress, "custody vault") !==
        market.vaultAddress ||
      !Number.isSafeInteger(custody.userBalanceCount) ||
      custody.userBalanceCount < 0 ||
      !Number.isSafeInteger(custody.activeOrderCount) ||
      custody.activeOrderCount < 0 ||
      (custody.activeOrderCount === 0) !== (activeOrderCollateral === 0n) ||
      treasuryFees !== accruedTreasury ||
      marketMakerFees !== accruedMarketMaker ||
      vault < rent
    ) {
      fail(`market ${market.address} custody accounting drifted`);
    }
    if (
      custody.activeOrderCount <
        (restoredActiveOrderCountByMarket.get(market.address) ?? 0) ||
      activeOrderCollateral <
        (restoredActiveOrderCollateralByMarket.get(market.address) ?? 0n)
    ) {
      fail(
        `market ${market.address} custody omits restored active-order collateral`,
      );
    }
    const outstanding =
      market.status === "resolved"
        ? activeOrderCollateral +
          (market.winner === "a" ? aShares : bShares) +
          accruedTreasury +
          accruedMarketMaker
        : activeOrderCollateral +
          aLocked +
          bLocked +
          treasuryFees +
          marketMakerFees;
    const usableVault = vault - rent;
    if (usableVault < outstanding)
      fail(`market ${market.address} vault is undercollateralized`);
    custodyExcessLamportsByMarket[market.address] = (
      usableVault - outstanding
    ).toString();
  }

  const stateForDigest = {
    expectation,
    restored: {
      restoredReconciliationId: restored.restoredReconciliationId,
      restoredReconciliationSha256: restored.restoredReconciliationSha256,
      restoredReconciledStateSha256: restored.restoredReconciledStateSha256,
      materializationId: restored.materializationId,
      database: restored.databaseAfter,
      duels: restored.duels,
      bets: restored.bets,
      indexedTransactions: restored.indexedTransactions,
      indexerCheckpoints: restored.indexerCheckpoints,
    },
    chain: stableChainStateProjection(chain),
    custodyExcessLamportsByMarket,
  };
  return {
    schemaVersion: 1,
    verificationScope: "finalized_solana_post_restore_read_only_reconciliation",
    cluster: expectation.cluster,
    genesisHash,
    restoredReconciliationId: restored.restoredReconciliationId,
    materializationId: restored.materializationId,
    databaseLogicalDataSha256: restored.databaseAfter.logicalDataSha256,
    finalizedStartSlot,
    finalizedEndSlot,
    minimumAvailableSlot,
    duelCount: duels.size,
    betCount: bets.size,
    indexedTransactionCount: indexed.size,
    checkpointCount: checkpoints.size,
    marketCount: observedMarkets.size,
    custodyExcessLamportsByMarket,
    reconciledStateSha256: digestEvidence(stateForDigest),
    databaseMutationAuthorized: false,
    chainMutationAuthorized: false,
    productionCutoverAuthorized: false,
    activationRequiresSeparateApproval: true,
  };
}
