import { type Idl, BorshAccountsCoder } from "@coral-xyz/anchor";
import {
  type AccountInfo,
  type Connection,
  type ParsedTransactionWithMeta,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Database } from "bun:sqlite";

import { canonicalEvidenceJson } from "./bettingFeedEvidence";
import { exactBytes32Hex } from "./exactBytes32";
import {
  type FinalizedRecoveryBalanceObservation,
  type FinalizedRecoveryChainObservation,
  type FinalizedRecoveryCustodyObservation,
  type FinalizedRecoveryDeploymentExpectation,
  type FinalizedRecoveryDuelObservation,
  type FinalizedRecoveryMarketObservation,
  type FinalizedRecoveryOrderObservation,
  type FinalizedRecoveryRestoredBet,
  type FinalizedRecoveryRestoredDuel,
  type FinalizedRecoveryRestoredState,
  type FinalizedSolanaRecoveryReconciliation,
  verifyFinalizedSolanaRecoveryReconciliation,
} from "./finalizedSolanaRecoveryReconciliation";
import duelMarketIdl from "./idl/duel_market.json";
import fightOracleIdl from "./idl/fight_oracle.json";
import { inspectKeeperDatabaseSnapshot } from "./keeperBackup";
import {
  DUEL_WINNER_MARKET_KIND,
  duelKeyHexToBytes,
  findClobVaultPda,
  findDuelStatePda,
  findMarketPda,
  findOrderPda,
  findUserBalancePda,
} from "./launchCommon";
import {
  reconcileBetExecutionFromIndexedFacts,
  type BetExecutionBaseline,
  type IndexedLifecycleFact,
} from "./solanaBetReconciliation";
import {
  exactPrimarySolanaTransactionSignature,
  exactSolanaTransactionSignatures,
} from "./solanaBetAccounting";
import {
  exactSolanaPublicKeyAddress,
  exactTransactionSignerAddresses,
} from "./solanaInstructionAccounts";
import { toU64Like } from "./solanaSafeInteger";
import { digestFinalizedSolanaTransaction } from "./solanaTransactionDigest";
import {
  digestFailedFinalizedTransaction,
  digestLifecycleFacts,
  exactFinalizedTransactionMetaSucceeded,
  MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE,
  normalizeLifecycleFact,
  requireExactFinalizedTransactionBatch,
  type SolanaLifecycleFact,
} from "./solanaLifecycleIndexer";
import { fetchUpgradeableProgramIdentity } from "./solanaProgramIdentity";

const ORDER_MARKET_OFFSET = 8;
const USER_BALANCE_MARKET_OFFSET = 8 + 32;
const MAX_INDEXED_TRANSACTIONS = 100_000;
const MAX_RESTORED_BETS = 100_000;

type UnknownRecord = Record<string, unknown>;

type RestoredMetadata = {
  restoredReconciliationId: string;
  restoredReconciliationSha256: string;
  restoredReconciledStateSha256: string;
  materializationId: string;
  duels: FinalizedRecoveryRestoredDuel[];
};

export type CollectFinalizedSolanaRecoveryInput = RestoredMetadata & {
  connection: Connection;
  databasePath: string;
  expectation: FinalizedRecoveryDeploymentExpectation;
};

type IndexedTransactionRow = {
  programId: string;
  signature: string;
  slot: number;
  succeeded: number;
  transactionDigest: string;
  factsDigest: string;
};

type LifecycleFactRow = {
  programId: string;
  signature: string;
  slot: number;
  factIndex: number;
  payloadJson: string;
};

function fail(message: string): never {
  throw new Error(`finalized Solana recovery collector ${message}`);
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is invalid`);
  }
  return value as UnknownRecord;
}

function field(value: UnknownRecord, snake: string, camel: string): unknown {
  return value[snake] ?? value[camel];
}

function key(value: unknown, label: string): string {
  const result = exactSolanaPublicKeyAddress(value);
  if (!result) fail(`${label} is invalid`);
  return result;
}

function integer(value: unknown, label: string): bigint {
  const result = toU64Like(value);
  if (result === null) fail(`${label} is invalid`);
  return result;
}

function safeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    fail(`${label} exceeds safe range`);
  return Number(result);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} is invalid`);
  return value;
}

function bytesHex(value: unknown, label: string): string {
  const result = exactBytes32Hex(value);
  if (!result) fail(`${label} is invalid`);
  return result;
}

function enumVariant(value: unknown, label: string): string {
  const record = asRecord(value, label);
  const variants = Object.keys(record);
  if (variants.length !== 1) fail(`${label} is invalid`);
  const variant = variants[0]!;
  return `${variant.slice(0, 1).toLowerCase()}${variant.slice(1)}`;
}

function transactionAccountKeys(
  transaction: ParsedTransactionWithMeta,
): string[] {
  const transactionSignatures = exactSolanaTransactionSignatures(
    transaction.transaction.signatures,
  );
  if (
    !transactionSignatures ||
    !exactTransactionSignerAddresses(
      transaction.transaction.message.accountKeys,
      transactionSignatures.length,
    )
  ) {
    fail("transaction signer authority is invalid");
  }
  return transaction.transaction.message.accountKeys.map((account) => {
    if (account instanceof PublicKey) return account.toBase58();
    if ("pubkey" in account)
      return key(account.pubkey, "transaction account key");
    return key(account, "transaction account key");
  });
}

function accountDiscriminator(idl: unknown, accountName: string): string {
  const accounts = (
    idl as { accounts?: Array<{ name?: unknown; discriminator?: unknown }> }
  ).accounts;
  const entry = accounts?.find((account) => account.name === accountName);
  if (!entry || !Array.isArray(entry.discriminator)) {
    fail(`${accountName} discriminator is absent from the pinned IDL`);
  }
  const bytes = Uint8Array.from(entry.discriminator as number[]);
  if (bytes.length !== 8) fail(`${accountName} discriminator is invalid`);
  return bs58.encode(bytes);
}

function decodeAccount(
  coder: BorshAccountsCoder,
  accountName: string,
  account: AccountInfo<Buffer>,
  owner: PublicKey,
): UnknownRecord {
  if (!account.owner.equals(owner) || account.executable) {
    fail(`${accountName} has an invalid owner or executable flag`);
  }
  try {
    return asRecord(coder.decode(accountName, account.data), accountName);
  } catch {
    fail(`${accountName} failed pinned-IDL decoding`);
  }
}

function lifecycleDisposition(input: {
  facts: IndexedLifecycleFact[];
  marketPda: string;
  orderId: string;
  wallet: string;
}): {
  order: FinalizedRecoveryRestoredBet["terminalOrderDisposition"];
  balance: FinalizedRecoveryRestoredBet["terminalBalanceDisposition"];
} {
  let order: FinalizedRecoveryRestoredBet["terminalOrderDisposition"] = "none";
  let balance: FinalizedRecoveryRestoredBet["terminalBalanceDisposition"] =
    "none";
  const setOrder = (next: typeof order) => {
    if (order !== "none" && order !== next)
      fail("order has conflicting lifecycle dispositions");
    order = next;
  };
  const setBalance = (next: typeof balance) => {
    if (balance !== "none" && balance !== next)
      fail("balance has conflicting lifecycle dispositions");
    balance = next;
  };
  for (const { fact } of input.facts) {
    if (fact.marketPda !== input.marketPda) continue;
    if (fact.orderId === input.orderId) {
      if (fact.kind === "ORDER_CANCELLED") setOrder("cancelled");
      else if (fact.kind === "RESTING_ORDER_RECLAIMED") setOrder("reclaimed");
      else if (fact.kind === "FILLED_ORDER_CLOSED") setOrder("filled_closed");
    }
    if (fact.wallet === input.wallet) {
      if (fact.kind === "CLAIM_PAYOUT") setBalance("claimed");
      else if (fact.kind === "CANCELLATION_REFUND") setBalance("refunded");
      else if (fact.kind === "LOSING_BALANCE_CLOSED")
        setBalance("losing_closed");
      else if (fact.kind === "EMPTY_USER_BALANCE_CLOSED")
        setBalance("empty_closed");
    }
  }
  return { order, balance };
}

function collectRestoredState(input: {
  databasePath: string;
  expectation: FinalizedRecoveryDeploymentExpectation;
  metadata: RestoredMetadata;
}): Omit<FinalizedRecoveryRestoredState, "databaseBefore" | "databaseAfter"> {
  const database = new Database(input.databasePath, {
    readonly: true,
    strict: true,
  });
  try {
    database.run("PRAGMA query_only = ON");
    const cluster = input.expectation.cluster;
    const programId = input.expectation.duelMarketProgramId;
    const factRows = database
      .query(
        `SELECT facts.program_id AS programId,
                facts.signature,
                transactions.slot,
                facts.fact_index AS factIndex,
                facts.payload_json AS payloadJson
           FROM solana_lifecycle_facts AS facts
           JOIN solana_indexed_transactions AS transactions
             ON transactions.cluster = facts.cluster
            AND transactions.program_id = facts.program_id
            AND transactions.signature = facts.signature
          WHERE facts.cluster = ? AND facts.program_id = ?
          ORDER BY transactions.slot, facts.signature, facts.fact_index`,
      )
      .all(cluster, programId) as LifecycleFactRow[];
    const facts: IndexedLifecycleFact[] = factRows.map((row) => ({
      signature: row.signature,
      factIndex: row.factIndex,
      fact: normalizeLifecycleFact(
        JSON.parse(row.payloadJson) as SolanaLifecycleFact,
      ),
    }));
    const factsBySignature = new Map<string, SolanaLifecycleFact[]>();
    for (const item of facts) {
      const values = factsBySignature.get(item.signature) ?? [];
      if (item.factIndex !== values.length)
        fail("indexed fact sequence is incomplete");
      values.push(item.fact);
      factsBySignature.set(item.signature, values);
    }

    const indexedRows = database
      .query(
        `SELECT program_id AS programId, signature, slot, succeeded,
                transaction_digest AS transactionDigest,
                facts_digest AS factsDigest
           FROM solana_indexed_transactions
          WHERE cluster = ?
          ORDER BY program_id, slot, signature`,
      )
      .all(cluster) as IndexedTransactionRow[];
    if (indexedRows.length > MAX_INDEXED_TRANSACTIONS) {
      fail("indexed transaction count exceeds the safety bound");
    }
    const indexedTransactions = indexedRows.map((row) => {
      if (row.succeeded !== 0 && row.succeeded !== 1) {
        fail(`indexed transaction ${row.signature} success flag is invalid`);
      }
      const transactionFacts = factsBySignature.get(row.signature) ?? [];
      if (row.factsDigest !== digestLifecycleFacts(transactionFacts)) {
        fail(`indexed transaction ${row.signature} facts digest drifted`);
      }
      return {
        programId: row.programId,
        signature: row.signature,
        slot: row.slot,
        succeeded: row.succeeded === 1,
        transactionDigest: row.transactionDigest,
      };
    });

    const checkpoints = database
      .query(
        `SELECT program_id AS programId, start_slot AS startSlot,
                signature, slot
           FROM solana_indexer_checkpoints
          WHERE cluster = ?
          ORDER BY program_id`,
      )
      .all(cluster) as Array<{
      programId: string;
      startSlot: number;
      signature: string;
      slot: number;
    }>;
    const betRows = database
      .query(
        `SELECT bets.id AS betId,
                bets.duel_id AS duelId,
                bets.duel_key AS duelKey,
                bets.market_pda AS marketPda,
                bets.bettor_wallet AS wallet,
                bets.tx_signature AS placementSignature,
                executions.order_id AS orderId,
                executions.side,
                executions.limit_price AS limitPrice,
                executions.order_behavior AS orderBehavior,
                executions.order_amount_units AS orderAmountUnits,
                executions.matched_amount_units AS initialMatchedAmountUnits,
                executions.resting_amount_units AS initialRestingAmountUnits,
                executions.released_amount_units AS initialReleasedAmountUnits,
                CAST(executions.collateral_lamports AS TEXT) AS initialCollateralLamports,
                CAST(executions.executed_cost_lamports AS TEXT) AS initialExecutedCostLamports,
                CAST(executions.trade_treasury_fee_lamports +
                     executions.trade_market_maker_fee_lamports AS TEXT) AS initialTradeFeeLamports,
                CAST(executions.reward_eligible_lamports AS TEXT) AS initialRewardEligibleLamports,
                lifecycle.matched_amount_units AS reconciledMatchedAmountUnits,
                lifecycle.resting_amount_units AS reconciledRestingAmountUnits,
                lifecycle.released_amount_units AS reconciledReleasedAmountUnits
           FROM bets
           JOIN bet_executions AS executions ON executions.bet_id = bets.id
      LEFT JOIN bet_lifecycle_accounting AS lifecycle ON lifecycle.bet_id = bets.id
          WHERE UPPER(bets.chain) = 'SOLANA' AND UPPER(bets.source_asset) = 'SOL'
          ORDER BY bets.recorded_at, bets.id`,
      )
      .all() as Array<Record<string, unknown>>;
    if (betRows.length > MAX_RESTORED_BETS)
      fail("restored bet count exceeds the safety bound");
    const bets = betRows.map((row): FinalizedRecoveryRestoredBet => {
      const baseline: BetExecutionBaseline = {
        betId: String(row.betId),
        txSignature: String(row.placementSignature),
        marketPda: String(row.marketPda),
        wallet: String(row.wallet),
        orderId: String(row.orderId),
        side: Number(row.side) as 1 | 2,
        limitPrice: Number(row.limitPrice),
        orderAmountUnits: String(row.orderAmountUnits),
        initialMatchedAmountUnits: String(row.initialMatchedAmountUnits),
        initialRestingAmountUnits: String(row.initialRestingAmountUnits),
        initialReleasedAmountUnits: String(row.initialReleasedAmountUnits),
        initialCollateralLamports: String(row.initialCollateralLamports),
        initialExecutedCostLamports: String(row.initialExecutedCostLamports),
        initialTradeFeeLamports: String(row.initialTradeFeeLamports),
        initialRewardEligibleLamports: String(
          row.initialRewardEligibleLamports,
        ),
      };
      const placementIndexed = facts.some(
        ({ signature, fact }) =>
          signature === baseline.txSignature &&
          fact.kind === "ORDER_PLACED" &&
          fact.marketPda === baseline.marketPda &&
          fact.orderId === baseline.orderId,
      );
      if (!placementIndexed)
        fail(`recorded bet ${baseline.betId} has no indexed placement`);
      const reconciled = reconcileBetExecutionFromIndexedFacts({
        baseline,
        facts,
      });
      const currentMatched =
        row.reconciledMatchedAmountUnits === null
          ? baseline.initialMatchedAmountUnits
          : String(row.reconciledMatchedAmountUnits);
      const currentResting =
        row.reconciledRestingAmountUnits === null
          ? baseline.initialRestingAmountUnits
          : String(row.reconciledRestingAmountUnits);
      const currentReleased =
        row.reconciledReleasedAmountUnits === null
          ? baseline.initialReleasedAmountUnits
          : String(row.reconciledReleasedAmountUnits);
      if (
        currentMatched !== reconciled.matchedAmountUnits ||
        currentResting !== reconciled.restingAmountUnits ||
        currentReleased !== reconciled.releasedAmountUnits
      ) {
        fail(`recorded bet ${baseline.betId} lifecycle accounting is stale`);
      }
      const disposition = lifecycleDisposition({
        facts,
        marketPda: baseline.marketPda,
        orderId: baseline.orderId,
        wallet: baseline.wallet,
      });
      return {
        betId: baseline.betId,
        duelId: String(row.duelId),
        duelKey: String(row.duelKey),
        marketPda: baseline.marketPda,
        wallet: baseline.wallet,
        placementSignature: baseline.txSignature,
        orderId: baseline.orderId,
        side: baseline.side,
        limitPrice: baseline.limitPrice,
        orderBehavior: Number(row.orderBehavior) as 0 | 1 | 2,
        orderAmountUnits: baseline.orderAmountUnits,
        currentMatchedAmountUnits: currentMatched,
        currentRestingAmountUnits: currentResting,
        currentReleasedAmountUnits: currentReleased,
        terminalOrderDisposition: disposition.order,
        terminalBalanceDisposition: disposition.balance,
      };
    });
    return {
      ...input.metadata,
      bets,
      indexedTransactions,
      indexerCheckpoints: checkpoints,
    };
  } finally {
    database.close(false);
  }
}

async function fetchAccount(input: {
  connection: Connection;
  address: PublicKey;
  owner: PublicKey;
  minimumContextSlot: number;
  label: string;
  nullable?: boolean;
}): Promise<{ slot: number; account: AccountInfo<Buffer> | null }> {
  const response = await input.connection.getAccountInfoAndContext(
    input.address,
    { commitment: "finalized", minContextSlot: input.minimumContextSlot },
  );
  if (!response.value) {
    if (input.nullable) return { slot: response.context.slot, account: null };
    fail(`${input.label} account ${input.address.toBase58()} is absent`);
  }
  if (!response.value.owner.equals(input.owner) || response.value.executable) {
    fail(`${input.label} account has an invalid owner or executable flag`);
  }
  return { slot: response.context.slot, account: response.value };
}

function decodeOracleConfig(decoded: UnknownRecord, address: PublicKey) {
  return {
    address: address.toBase58(),
    authority: key(
      field(decoded, "authority", "authority"),
      "oracle authority",
    ),
    reporter: key(field(decoded, "reporter", "reporter"), "oracle reporter"),
    finalizer: key(
      field(decoded, "finalizer", "finalizer"),
      "oracle finalizer",
    ),
    challenger: key(
      field(decoded, "challenger", "challenger"),
      "oracle challenger",
    ),
    disputeWindowSecs: safeInteger(
      field(decoded, "dispute_window_secs", "disputeWindowSecs"),
      "oracle dispute window",
    ),
    paused: boolean(field(decoded, "paused", "paused"), "oracle pause state"),
    configFrozen: boolean(
      field(decoded, "config_frozen", "configFrozen"),
      "oracle config freeze state",
    ),
    accountSchemaVersion: safeInteger(
      field(decoded, "account_schema_version", "accountSchemaVersion"),
      "oracle account schema version",
    ),
  };
}

function decodeMarketConfig(decoded: UnknownRecord, address: PublicKey) {
  return {
    address: address.toBase58(),
    authority: key(
      field(decoded, "authority", "authority"),
      "market authority",
    ),
    marketOperator: key(
      field(decoded, "market_operator", "marketOperator"),
      "market operator",
    ),
    treasury: key(field(decoded, "treasury", "treasury"), "treasury"),
    marketMaker: key(
      field(decoded, "market_maker", "marketMaker"),
      "market maker",
    ),
    tradeTreasuryFeeBps: safeInteger(
      field(decoded, "trade_treasury_fee_bps", "tradeTreasuryFeeBps"),
      "trade treasury fee",
    ),
    tradeMarketMakerFeeBps: safeInteger(
      field(decoded, "trade_market_maker_fee_bps", "tradeMarketMakerFeeBps"),
      "trade market-maker fee",
    ),
    winningsMarketMakerFeeBps: safeInteger(
      field(
        decoded,
        "winnings_market_maker_fee_bps",
        "winningsMarketMakerFeeBps",
      ),
      "winnings market-maker fee",
    ),
    orderPlacementPaused: boolean(
      field(decoded, "order_placement_paused", "orderPlacementPaused"),
      "order-placement pause state",
    ),
    marketCreationPaused: boolean(
      field(decoded, "market_creation_paused", "marketCreationPaused"),
      "market-creation pause state",
    ),
    configFrozen: boolean(
      field(decoded, "config_frozen", "configFrozen"),
      "market config freeze state",
    ),
  };
}

function decodeDuel(input: {
  duel: FinalizedRecoveryRestoredDuel;
  address: PublicKey;
  slot: number;
  decoded: UnknownRecord;
}): FinalizedRecoveryDuelObservation {
  const status = enumVariant(
    field(input.decoded, "status", "status"),
    "duel status",
  );
  const winner = enumVariant(
    field(input.decoded, "winner", "winner"),
    "duel winner",
  );
  return {
    duelId: input.duel.duelId,
    duelKey: bytesHex(field(input.decoded, "duel_key", "duelKey"), "duel key"),
    address: input.address.toBase58(),
    observedSlot: input.slot,
    status: status as FinalizedRecoveryDuelObservation["status"],
    winner: winner as FinalizedRecoveryDuelObservation["winner"],
    participantAHash: bytesHex(
      field(input.decoded, "participant_a_hash", "participantAHash"),
      "participant A hash",
    ),
    participantBHash: bytesHex(
      field(input.decoded, "participant_b_hash", "participantBHash"),
      "participant B hash",
    ),
    competitiveSnapshotVersion: safeInteger(
      field(
        input.decoded,
        "competitive_snapshot_version",
        "competitiveSnapshotVersion",
      ),
      "competitive snapshot version",
    ),
    competitiveSnapshotDigest: bytesHex(
      field(
        input.decoded,
        "competitive_snapshot_digest",
        "competitiveSnapshotDigest",
      ),
      "competitive snapshot digest",
    ),
    seed: integer(field(input.decoded, "seed", "seed"), "duel seed").toString(),
    replayHash: bytesHex(
      field(input.decoded, "replay_hash", "replayHash"),
      "duel replay hash",
    ),
  };
}

function decodeMarket(input: {
  duel: FinalizedRecoveryRestoredDuel;
  address: PublicKey;
  duelAddress: PublicKey;
  vaultAddress: PublicKey;
  slot: number;
  decoded: UnknownRecord;
}): FinalizedRecoveryMarketObservation {
  return {
    duelId: input.duel.duelId,
    duelKey: bytesHex(
      field(input.decoded, "duel_key", "duelKey"),
      "market duel key",
    ),
    address: input.address.toBase58(),
    duelStateAddress: key(
      field(input.decoded, "duel_state", "duelState"),
      "market duel state",
    ),
    vaultAddress: input.vaultAddress.toBase58(),
    observedSlot: input.slot,
    marketKind: safeInteger(
      field(input.decoded, "market_kind", "marketKind"),
      "market kind",
    ) as 1,
    status: enumVariant(
      field(input.decoded, "status", "status"),
      "market status",
    ) as FinalizedRecoveryMarketObservation["status"],
    winner: enumVariant(
      field(input.decoded, "winner", "winner"),
      "market winner",
    ) as FinalizedRecoveryMarketObservation["winner"],
    authority: key(
      field(input.decoded, "authority", "authority"),
      "market authority",
    ),
    treasury: key(
      field(input.decoded, "treasury", "treasury"),
      "market treasury",
    ),
    marketMaker: key(
      field(input.decoded, "market_maker", "marketMaker"),
      "market maker",
    ),
    tradeTreasuryFeeBpsSnapshot: safeInteger(
      field(
        input.decoded,
        "trade_treasury_fee_bps_snapshot",
        "tradeTreasuryFeeBpsSnapshot",
      ),
      "market treasury fee snapshot",
    ),
    tradeMarketMakerFeeBpsSnapshot: safeInteger(
      field(
        input.decoded,
        "trade_market_maker_fee_bps_snapshot",
        "tradeMarketMakerFeeBpsSnapshot",
      ),
      "market-maker trade fee snapshot",
    ),
    winningsMarketMakerFeeBpsSnapshot: safeInteger(
      field(
        input.decoded,
        "winnings_market_maker_fee_bps_snapshot",
        "winningsMarketMakerFeeBpsSnapshot",
      ),
      "market-maker winnings fee snapshot",
    ),
    nextOrderId: integer(
      field(input.decoded, "next_order_id", "nextOrderId"),
      "next order ID",
    ).toString(),
    accruedTradeTreasuryFeeLamports: integer(
      field(
        input.decoded,
        "accrued_trade_treasury_fee_lamports",
        "accruedTradeTreasuryFeeLamports",
      ),
      "accrued treasury fee",
    ).toString(),
    accruedTradeMarketMakerFeeLamports: integer(
      field(
        input.decoded,
        "accrued_trade_market_maker_fee_lamports",
        "accruedTradeMarketMakerFeeLamports",
      ),
      "accrued market-maker fee",
    ).toString(),
  };
}

async function collectIndexedTransactions(input: {
  connection: Connection;
  indexed: FinalizedRecoveryRestoredState["indexedTransactions"];
}): Promise<FinalizedRecoveryChainObservation["transactions"]> {
  const observations: FinalizedRecoveryChainObservation["transactions"] = [];
  for (
    let offset = 0;
    offset < input.indexed.length;
    offset += MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE
  ) {
    const batch = input.indexed.slice(
      offset,
      offset + MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE,
    );
    const requestedSignatures = batch.map(({ signature }) => signature);
    const transactions =
      requireExactFinalizedTransactionBatch<ParsedTransactionWithMeta | null>({
        requestedSignatures,
        transactions: await input.connection.getParsedTransactions(
          requestedSignatures,
          { commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ),
      });
    for (let index = 0; index < batch.length; index += 1) {
      const expected = batch[index]!;
      const transaction = transactions[index];
      if (
        !transaction ||
        exactPrimarySolanaTransactionSignature(
          transaction.transaction.signatures,
        ) !== expected.signature
      ) {
        fail(`finalized transaction ${expected.signature} is absent or failed`);
      }
      let succeeded: boolean;
      try {
        succeeded = exactFinalizedTransactionMetaSucceeded(transaction.meta);
      } catch {
        fail(
          `finalized transaction ${expected.signature} has invalid execution metadata`,
        );
      }
      if (succeeded !== expected.succeeded) {
        fail(
          `finalized transaction ${expected.signature} success status drifted`,
        );
      }
      observations.push({
        signature: expected.signature,
        slot: transaction.slot,
        succeeded,
        confirmationStatus: "finalized",
        transactionDigest: succeeded
          ? digestFinalizedSolanaTransaction(transaction)
          : digestFailedFinalizedTransaction(expected.signature),
        accountKeys: transactionAccountKeys(transaction),
      });
    }
  }
  return observations;
}

async function collectMarketBalances(input: {
  connection: Connection;
  programId: PublicKey;
  marketPda: PublicKey;
  minimumContextSlot: number;
  coder: BorshAccountsCoder;
}): Promise<{ slot: number; decoded: UnknownRecord[] }> {
  const response = await input.connection.getProgramAccounts(input.programId, {
    commitment: "finalized",
    minContextSlot: input.minimumContextSlot,
    withContext: true,
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: accountDiscriminator(duelMarketIdl, "UserBalance"),
        },
      },
      {
        memcmp: {
          offset: USER_BALANCE_MARKET_OFFSET,
          bytes: input.marketPda.toBase58(),
        },
      },
    ],
  });
  const contextual = response as unknown as {
    context: { slot: number };
    value: Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>;
  };
  return {
    slot: contextual.context.slot,
    decoded: contextual.value.map(({ account }) =>
      decodeAccount(input.coder, "UserBalance", account, input.programId),
    ),
  };
}

async function collectMarketOrders(input: {
  connection: Connection;
  programId: PublicKey;
  marketPda: PublicKey;
  minimumContextSlot: number;
  coder: BorshAccountsCoder;
}): Promise<{ slot: number; decoded: UnknownRecord[] }> {
  const response = await input.connection.getProgramAccounts(input.programId, {
    commitment: "finalized",
    minContextSlot: input.minimumContextSlot,
    withContext: true,
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: accountDiscriminator(duelMarketIdl, "Order"),
        },
      },
      {
        memcmp: {
          offset: ORDER_MARKET_OFFSET,
          bytes: input.marketPda.toBase58(),
        },
      },
    ],
  });
  const contextual = response as unknown as {
    context: { slot: number };
    value: Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>;
  };
  return {
    slot: contextual.context.slot,
    decoded: contextual.value.map(({ account }) =>
      decodeAccount(input.coder, "Order", account, input.programId),
    ),
  };
}

function sumBalances(decoded: UnknownRecord[], marketPda: PublicKey) {
  let totalAShares = 0n;
  let totalBShares = 0n;
  let totalALockedLamports = 0n;
  let totalBLockedLamports = 0n;
  let totalTradeTreasuryFeeLamports = 0n;
  let totalTradeMarketMakerFeeLamports = 0n;
  const users = new Set<string>();
  for (const balance of decoded) {
    if (
      key(field(balance, "market_state", "marketState"), "balance market") !==
      marketPda.toBase58()
    ) {
      fail("filtered user balance references a different market");
    }
    const user = key(field(balance, "user", "user"), "balance user");
    if (users.has(user)) fail("market contains duplicate user balances");
    users.add(user);
    totalAShares += integer(field(balance, "a_shares", "aShares"), "A shares");
    totalBShares += integer(field(balance, "b_shares", "bShares"), "B shares");
    totalALockedLamports += integer(
      field(balance, "a_locked_lamports", "aLockedLamports"),
      "A locked lamports",
    );
    totalBLockedLamports += integer(
      field(balance, "b_locked_lamports", "bLockedLamports"),
      "B locked lamports",
    );
    totalTradeTreasuryFeeLamports += integer(
      field(balance, "trade_treasury_fee_lamports", "tradeTreasuryFeeLamports"),
      "balance treasury fee",
    );
    totalTradeMarketMakerFeeLamports += integer(
      field(
        balance,
        "trade_market_maker_fee_lamports",
        "tradeMarketMakerFeeLamports",
      ),
      "balance market-maker fee",
    );
  }
  return {
    users,
    totalAShares,
    totalBShares,
    totalALockedLamports,
    totalBLockedLamports,
    totalTradeTreasuryFeeLamports,
    totalTradeMarketMakerFeeLamports,
  };
}

function sumActiveOrderCollateral(
  decoded: UnknownRecord[],
  marketPda: PublicKey,
): { activeOrderCount: number; activeOrderCollateralLamports: bigint } {
  const orderIds = new Set<string>();
  let activeOrderCount = 0;
  let activeOrderCollateralLamports = 0n;
  for (const order of decoded) {
    if (
      key(field(order, "market_state", "marketState"), "order market") !==
      marketPda.toBase58()
    ) {
      fail("filtered order references a different market");
    }
    const orderId = integer(field(order, "id", "id"), "order ID").toString();
    if (orderIds.has(orderId)) fail("market contains duplicate order IDs");
    orderIds.add(orderId);
    const amount = integer(field(order, "amount", "amount"), "order amount");
    const filled = integer(field(order, "filled", "filled"), "order filled");
    if (filled > amount) fail("order filled amount exceeds its signed amount");
    if (!boolean(field(order, "active", "active"), "order active state")) {
      continue;
    }
    const side = safeInteger(field(order, "side", "side"), "order side");
    const price = safeInteger(field(order, "price", "price"), "order price");
    const remaining = amount - filled;
    if (
      (side !== 1 && side !== 2) ||
      price <= 0 ||
      price >= 1_000 ||
      remaining <= 0n ||
      remaining % 1_000n !== 0n
    ) {
      fail("active order has invalid remaining quote accounting");
    }
    const priceComponent = BigInt(side === 1 ? price : 1_000 - price);
    const numerator = remaining * priceComponent;
    if (numerator % 1_000n !== 0n) {
      fail("active order collateral is not exactly representable");
    }
    activeOrderCount += 1;
    activeOrderCollateralLamports += numerator / 1_000n;
  }
  return { activeOrderCount, activeOrderCollateralLamports };
}

async function collectChainObservation(input: {
  connection: Connection;
  expectation: FinalizedRecoveryDeploymentExpectation;
  restored: Omit<
    FinalizedRecoveryRestoredState,
    "databaseBefore" | "databaseAfter"
  >;
}): Promise<FinalizedRecoveryChainObservation> {
  const connection = input.connection;
  const fightProgramId = new PublicKey(input.expectation.fightOracleProgramId);
  const marketProgramId = new PublicKey(input.expectation.duelMarketProgramId);
  const expectedAuthority =
    input.expectation.expectedUpgradeAuthority === null
      ? null
      : new PublicKey(input.expectation.expectedUpgradeAuthority);
  const finalizedStartSlot = await connection.getSlot("finalized");
  const [genesisHash, minimumAvailableSlot, fightIdentity, marketIdentity] =
    await Promise.all([
      connection.getGenesisHash(),
      connection.getMinimumLedgerSlot(),
      fetchUpgradeableProgramIdentity({
        connection,
        label: "fight oracle",
        programId: fightProgramId,
        expectedUpgradeAuthority: expectedAuthority,
      }),
      fetchUpgradeableProgramIdentity({
        connection,
        label: "duel market",
        programId: marketProgramId,
        expectedUpgradeAuthority: expectedAuthority,
      }),
    ]);
  const fightCoder = new BorshAccountsCoder(fightOracleIdl as Idl);
  const marketCoder = new BorshAccountsCoder(duelMarketIdl as Idl);
  const oracleConfigAddress = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_config")],
    fightProgramId,
  )[0];
  const marketConfigAddress = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    marketProgramId,
  )[0];
  const [oracleConfigAccount, marketConfigAccount, transactions] =
    await Promise.all([
      fetchAccount({
        connection,
        address: oracleConfigAddress,
        owner: fightProgramId,
        minimumContextSlot: finalizedStartSlot,
        label: "oracle config",
      }),
      fetchAccount({
        connection,
        address: marketConfigAddress,
        owner: marketProgramId,
        minimumContextSlot: finalizedStartSlot,
        label: "market config",
      }),
      collectIndexedTransactions({
        connection,
        indexed: input.restored.indexedTransactions,
      }),
    ]);
  const duels: FinalizedRecoveryDuelObservation[] = [];
  const markets: FinalizedRecoveryMarketObservation[] = [];
  const custody: FinalizedRecoveryCustodyObservation[] = [];
  const allMarketBalances = new Map<
    string,
    { slot: number; users: Set<string> }
  >();
  for (const duel of input.restored.duels) {
    const duelState = findDuelStatePda(
      fightProgramId,
      duelKeyHexToBytes(duel.duelKey),
    );
    const marketState = findMarketPda(
      marketProgramId,
      duelState,
      DUEL_WINNER_MARKET_KIND,
    );
    const vault = findClobVaultPda(marketProgramId, marketState);
    const [
      duelAccount,
      marketAccount,
      balances,
      marketOrders,
      vaultBalance,
      rent,
    ] = await Promise.all([
      fetchAccount({
        connection,
        address: duelState,
        owner: fightProgramId,
        minimumContextSlot: finalizedStartSlot,
        label: `duel ${duel.duelId}`,
      }),
      fetchAccount({
        connection,
        address: marketState,
        owner: marketProgramId,
        minimumContextSlot: finalizedStartSlot,
        label: `market ${duel.duelId}`,
      }),
      collectMarketBalances({
        connection,
        programId: marketProgramId,
        marketPda: marketState,
        minimumContextSlot: finalizedStartSlot,
        coder: marketCoder,
      }),
      collectMarketOrders({
        connection,
        programId: marketProgramId,
        marketPda: marketState,
        minimumContextSlot: finalizedStartSlot,
        coder: marketCoder,
      }),
      connection.getBalanceAndContext(vault, {
        commitment: "finalized",
        minContextSlot: finalizedStartSlot,
      }),
      connection.getMinimumBalanceForRentExemption(0, "finalized"),
    ]);
    const decodedDuel = decodeAccount(
      fightCoder,
      "DuelState",
      duelAccount.account!,
      fightProgramId,
    );
    const decodedMarket = decodeAccount(
      marketCoder,
      "MarketState",
      marketAccount.account!,
      marketProgramId,
    );
    duels.push(
      decodeDuel({
        duel,
        address: duelState,
        slot: duelAccount.slot,
        decoded: decodedDuel,
      }),
    );
    markets.push(
      decodeMarket({
        duel,
        address: marketState,
        duelAddress: duelState,
        vaultAddress: vault,
        slot: marketAccount.slot,
        decoded: decodedMarket,
      }),
    );
    const totals = sumBalances(balances.decoded, marketState);
    const orderTotals = sumActiveOrderCollateral(
      marketOrders.decoded,
      marketState,
    );
    allMarketBalances.set(marketState.toBase58(), {
      slot: balances.slot,
      users: totals.users,
    });
    custody.push({
      marketPda: marketState.toBase58(),
      vaultAddress: vault.toBase58(),
      observedSlot: Math.min(
        balances.slot,
        marketOrders.slot,
        vaultBalance.context.slot,
      ),
      vaultBalanceLamports: String(vaultBalance.value),
      vaultRentExemptMinimumLamports: String(rent),
      userBalanceCount: totals.users.size,
      activeOrderCount: orderTotals.activeOrderCount,
      activeOrderCollateralLamports:
        orderTotals.activeOrderCollateralLamports.toString(),
      totalAShares: totals.totalAShares.toString(),
      totalBShares: totals.totalBShares.toString(),
      totalALockedLamports: totals.totalALockedLamports.toString(),
      totalBLockedLamports: totals.totalBLockedLamports.toString(),
      totalTradeTreasuryFeeLamports:
        totals.totalTradeTreasuryFeeLamports.toString(),
      totalTradeMarketMakerFeeLamports:
        totals.totalTradeMarketMakerFeeLamports.toString(),
    });
  }

  const orders: FinalizedRecoveryOrderObservation[] = [];
  const balances: FinalizedRecoveryBalanceObservation[] = [];
  const balanceKeys = new Set<string>();
  for (const bet of input.restored.bets) {
    const marketPda = new PublicKey(bet.marketPda);
    const wallet = new PublicKey(bet.wallet);
    const orderAddress = findOrderPda(
      marketProgramId,
      marketPda,
      BigInt(bet.orderId),
    );
    const balanceAddress = findUserBalancePda(
      marketProgramId,
      marketPda,
      wallet,
    );
    const [orderAccount, balanceAccount] = await Promise.all([
      fetchAccount({
        connection,
        address: orderAddress,
        owner: marketProgramId,
        minimumContextSlot: finalizedStartSlot,
        label: `order ${bet.betId}`,
        nullable: true,
      }),
      fetchAccount({
        connection,
        address: balanceAddress,
        owner: marketProgramId,
        minimumContextSlot: finalizedStartSlot,
        label: `balance ${bet.betId}`,
        nullable: true,
      }),
    ]);
    if (!orderAccount.account) {
      orders.push({
        betId: bet.betId,
        address: orderAddress.toBase58(),
        observedSlot: orderAccount.slot,
        exists: false,
        marketPda: null,
        orderId: null,
        maker: null,
        side: null,
        price: null,
        orderBehavior: null,
        amountUnits: null,
        filledUnits: null,
        active: null,
        continuationPending: null,
      });
    } else {
      const decoded = decodeAccount(
        marketCoder,
        "Order",
        orderAccount.account,
        marketProgramId,
      );
      orders.push({
        betId: bet.betId,
        address: orderAddress.toBase58(),
        observedSlot: orderAccount.slot,
        exists: true,
        marketPda: key(
          field(decoded, "market_state", "marketState"),
          "order market",
        ),
        orderId: integer(field(decoded, "id", "id"), "order ID").toString(),
        maker: key(field(decoded, "maker", "maker"), "order maker"),
        side: safeInteger(field(decoded, "side", "side"), "order side") as
          1 | 2,
        price: safeInteger(field(decoded, "price", "price"), "order price"),
        orderBehavior: safeInteger(
          field(decoded, "order_behavior", "orderBehavior"),
          "order behavior",
        ) as 0 | 1 | 2,
        amountUnits: integer(
          field(decoded, "amount", "amount"),
          "order amount",
        ).toString(),
        filledUnits: integer(
          field(decoded, "filled", "filled"),
          "order filled",
        ).toString(),
        active: boolean(
          field(decoded, "active", "active"),
          "order active state",
        ),
        continuationPending: boolean(
          field(decoded, "continuation_pending", "continuationPending"),
          "order continuation state",
        ),
      });
    }
    const balanceIdentity = `${bet.marketPda}:${bet.wallet}`;
    if (!balanceKeys.has(balanceIdentity)) {
      balanceKeys.add(balanceIdentity);
      const enumerated = allMarketBalances.get(bet.marketPda);
      const exists = balanceAccount.account !== null;
      if (!enumerated || exists !== enumerated.users.has(bet.wallet)) {
        fail(`balance enumeration drifted for ${balanceIdentity}`);
      }
      if (balanceAccount.account) {
        const decoded = decodeAccount(
          marketCoder,
          "UserBalance",
          balanceAccount.account,
          marketProgramId,
        );
        if (
          key(field(decoded, "user", "user"), "balance user") !== bet.wallet ||
          key(
            field(decoded, "market_state", "marketState"),
            "balance market",
          ) !== bet.marketPda
        ) {
          fail(`balance identity drifted for ${balanceIdentity}`);
        }
      }
      balances.push({
        wallet: bet.wallet,
        marketPda: bet.marketPda,
        address: balanceAddress.toBase58(),
        observedSlot: balanceAccount.slot,
        exists,
      });
    }
  }
  const finalizedEndSlot = await connection.getSlot("finalized");
  return {
    cluster: input.expectation.cluster,
    genesisHash,
    minimumAvailableSlot,
    finalizedStartSlot,
    finalizedEndSlot,
    fightOracleProgram: {
      programId: fightIdentity.programId.toBase58(),
      programDataAddress: fightIdentity.programDataAddress.toBase58(),
      upgradeAuthority: fightIdentity.upgradeAuthority?.toBase58() ?? null,
      deployedSlot: fightIdentity.deployedSlot.toString(),
    },
    duelMarketProgram: {
      programId: marketIdentity.programId.toBase58(),
      programDataAddress: marketIdentity.programDataAddress.toBase58(),
      upgradeAuthority: marketIdentity.upgradeAuthority?.toBase58() ?? null,
      deployedSlot: marketIdentity.deployedSlot.toString(),
    },
    oracleConfig: decodeOracleConfig(
      decodeAccount(
        fightCoder,
        "OracleConfig",
        oracleConfigAccount.account!,
        fightProgramId,
      ),
      oracleConfigAddress,
    ),
    marketConfig: decodeMarketConfig(
      decodeAccount(
        marketCoder,
        "MarketConfig",
        marketConfigAccount.account!,
        marketProgramId,
      ),
      marketConfigAddress,
    ),
    transactions,
    duels,
    markets,
    orders,
    balances,
    custody,
  };
}

function stableChainProjection(
  chain: FinalizedRecoveryChainObservation,
): unknown {
  const stripSlot = <T extends { observedSlot: number }>(value: T) => {
    const { observedSlot: _observedSlot, ...rest } = value;
    return rest;
  };
  return {
    ...chain,
    minimumAvailableSlot: 0,
    finalizedStartSlot: 0,
    finalizedEndSlot: 0,
    duels: chain.duels.map(stripSlot),
    markets: chain.markets.map(stripSlot),
    orders: chain.orders.map(stripSlot),
    balances: chain.balances.map(stripSlot),
    custody: chain.custody.map(stripSlot),
  };
}

export async function collectAndVerifyFinalizedSolanaRecovery(
  input: CollectFinalizedSolanaRecoveryInput,
): Promise<{
  restored: FinalizedRecoveryRestoredState;
  chain: FinalizedRecoveryChainObservation;
  reconciliation: FinalizedSolanaRecoveryReconciliation;
}> {
  const databaseBefore = inspectKeeperDatabaseSnapshot(input.databasePath);
  const restoredCore = collectRestoredState({
    databasePath: input.databasePath,
    expectation: input.expectation,
    metadata: {
      restoredReconciliationId: input.restoredReconciliationId,
      restoredReconciliationSha256: input.restoredReconciliationSha256,
      restoredReconciledStateSha256: input.restoredReconciledStateSha256,
      materializationId: input.materializationId,
      duels: input.duels,
    },
  });
  const firstChain = await collectChainObservation({
    connection: input.connection,
    expectation: input.expectation,
    restored: restoredCore,
  });
  const secondChain = await collectChainObservation({
    connection: input.connection,
    expectation: input.expectation,
    restored: restoredCore,
  });
  if (
    canonicalEvidenceJson(stableChainProjection(firstChain)) !==
    canonicalEvidenceJson(stableChainProjection(secondChain))
  ) {
    fail("finalized chain state changed across the bounded double read");
  }
  const databaseAfter = inspectKeeperDatabaseSnapshot(input.databasePath);
  const restored: FinalizedRecoveryRestoredState = {
    ...restoredCore,
    databaseBefore,
    databaseAfter,
  };
  return {
    restored,
    chain: secondChain,
    reconciliation: verifyFinalizedSolanaRecoveryReconciliation({
      expectation: input.expectation,
      restored,
      chain: secondChain,
    }),
  };
}
