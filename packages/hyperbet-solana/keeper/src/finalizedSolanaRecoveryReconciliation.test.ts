import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

import {
  DUEL_WINNER_MARKET_KIND,
  findClobVaultPda,
  findDuelStatePda,
  findMarketConfigPda,
  findMarketPda,
  findOracleConfigPda,
  findOrderPda,
  findUserBalancePda,
} from "./launchCommon";
import {
  type FinalizedRecoveryChainObservation,
  type FinalizedRecoveryDeploymentExpectation,
  type FinalizedRecoveryRestoredState,
  verifyFinalizedSolanaRecoveryReconciliation,
} from "./finalizedSolanaRecoveryReconciliation";
import { deriveProgramDataAddress } from "./solanaProgramIdentity";

const FIGHT = new PublicKey("FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu");
const MARKET = new PublicKey("7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG");

function key(byte: number): string {
  return new PublicKey(Buffer.alloc(32, byte)).toBase58();
}

function signature(byte: number): string {
  return bs58.encode(Buffer.alloc(64, byte));
}

function hash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function fixture(): {
  expectation: FinalizedRecoveryDeploymentExpectation;
  restored: FinalizedRecoveryRestoredState;
  chain: FinalizedRecoveryChainObservation;
} {
  const upgradeAuthority = key(10);
  const configAuthority = key(11);
  const reporter = key(12);
  const finalizer = key(13);
  const challenger = key(14);
  const marketOperator = key(15);
  const treasury = key(16);
  const marketMaker = key(17);
  const wallet = key(18);
  const duelKey = hash("duel-key");
  const duelState = findDuelStatePda(FIGHT, Buffer.from(duelKey, "hex"));
  const market = findMarketPda(MARKET, duelState, DUEL_WINNER_MARKET_KIND);
  const vault = findClobVaultPda(MARKET, market);
  const order = findOrderPda(MARKET, market, 1n);
  const balance = findUserBalancePda(MARKET, market, new PublicKey(wallet));
  const placementSignature = signature(19);
  const transactionDigest = hash("placement-transaction");
  const snapshotDigest = hash("competitive-snapshot");
  const replayHash = hash("replay");
  const database = {
    integrityCheck: "ok" as const,
    foreignKeyViolations: 0 as const,
    schemaSha256: hash("schema"),
    logicalDataSha256: hash("logical-data"),
    tableCounts: {
      bets: 1,
      bet_executions: 1,
      solana_indexer_checkpoints: 1,
      solana_indexed_transactions: 1,
      solana_lifecycle_facts: 2,
    },
  };
  return {
    expectation: {
      cluster: "devnet",
      genesisHash: key(20),
      fightOracleProgramId: FIGHT.toBase58(),
      duelMarketProgramId: MARKET.toBase58(),
      expectedUpgradeAuthority: upgradeAuthority,
      configAuthority,
      reporter,
      finalizer,
      challenger,
      marketOperator,
      treasury,
      marketMaker,
      disputeWindowSecs: 60,
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 100,
      oraclePaused: false,
      orderPlacementPaused: false,
      marketCreationPaused: false,
    },
    restored: {
      restoredReconciliationId: "11111111-1111-4111-8111-111111111111",
      restoredReconciliationSha256: hash("restored-reconciliation"),
      restoredReconciledStateSha256: hash("restored-state"),
      materializationId: "22222222-2222-4222-8222-222222222222",
      databaseBefore: database,
      databaseAfter: structuredClone(database),
      duels: [
        {
          duelId: "duel-1",
          duelKey,
          participantAId: "agent-a",
          participantBId: "agent-b",
          competitiveSnapshotVersion: 3,
          competitiveSnapshotDigest: snapshotDigest,
          terminalOutcome: "win",
          terminalWinnerSide: "A",
          terminalSeed: "42",
          terminalReplayHash: replayHash,
        },
      ],
      bets: [
        {
          betId: "bet-1",
          duelId: "duel-1",
          duelKey,
          marketPda: market.toBase58(),
          wallet,
          placementSignature,
          orderId: "1",
          side: 1,
          limitPrice: 500,
          orderBehavior: 0,
          orderAmountUnits: "1000",
          currentMatchedAmountUnits: "1000",
          currentRestingAmountUnits: "0",
          currentReleasedAmountUnits: "0",
          terminalOrderDisposition: "none",
          terminalBalanceDisposition: "none",
        },
      ],
      indexedTransactions: [
        {
          programId: MARKET.toBase58(),
          signature: placementSignature,
          slot: 50,
          succeeded: true,
          transactionDigest,
        },
      ],
      indexerCheckpoints: [
        {
          programId: MARKET.toBase58(),
          startSlot: 10,
          signature: placementSignature,
          slot: 50,
        },
      ],
    },
    chain: {
      cluster: "devnet",
      genesisHash: key(20),
      minimumAvailableSlot: 1,
      finalizedStartSlot: 100,
      finalizedEndSlot: 101,
      fightOracleProgram: {
        programId: FIGHT.toBase58(),
        programDataAddress: deriveProgramDataAddress(FIGHT).toBase58(),
        upgradeAuthority,
        deployedSlot: "2",
      },
      duelMarketProgram: {
        programId: MARKET.toBase58(),
        programDataAddress: deriveProgramDataAddress(MARKET).toBase58(),
        upgradeAuthority,
        deployedSlot: "2",
      },
      oracleConfig: {
        address: findOracleConfigPda(FIGHT).toBase58(),
        authority: configAuthority,
        reporter,
        finalizer,
        challenger,
        disputeWindowSecs: 60,
        paused: false,
        configFrozen: true,
        accountSchemaVersion: 2,
      },
      marketConfig: {
        address: findMarketConfigPda(MARKET).toBase58(),
        authority: configAuthority,
        marketOperator,
        treasury,
        marketMaker,
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 100,
        orderPlacementPaused: false,
        marketCreationPaused: false,
        configFrozen: true,
      },
      transactions: [
        {
          signature: placementSignature,
          slot: 50,
          succeeded: true,
          confirmationStatus: "finalized",
          transactionDigest,
          accountKeys: [
            wallet,
            market.toBase58(),
            order.toBase58(),
            balance.toBase58(),
          ],
        },
      ],
      duels: [
        {
          duelId: "duel-1",
          duelKey,
          address: duelState.toBase58(),
          observedSlot: 100,
          status: "resolved",
          winner: "a",
          participantAHash: hash("agent-a"),
          participantBHash: hash("agent-b"),
          competitiveSnapshotVersion: 3,
          competitiveSnapshotDigest: snapshotDigest,
          seed: "42",
          replayHash,
        },
      ],
      markets: [
        {
          duelId: "duel-1",
          duelKey,
          address: market.toBase58(),
          duelStateAddress: duelState.toBase58(),
          vaultAddress: vault.toBase58(),
          observedSlot: 100,
          marketKind: 1,
          status: "resolved",
          winner: "a",
          authority: marketOperator,
          treasury,
          marketMaker,
          tradeTreasuryFeeBpsSnapshot: 100,
          tradeMarketMakerFeeBpsSnapshot: 100,
          winningsMarketMakerFeeBpsSnapshot: 100,
          nextOrderId: "2",
          accruedTradeTreasuryFeeLamports: "10",
          accruedTradeMarketMakerFeeLamports: "10",
        },
      ],
      orders: [
        {
          betId: "bet-1",
          address: order.toBase58(),
          observedSlot: 100,
          exists: true,
          marketPda: market.toBase58(),
          orderId: "1",
          maker: wallet,
          side: 1,
          price: 500,
          orderBehavior: 0,
          amountUnits: "1000",
          filledUnits: "1000",
          active: false,
          continuationPending: false,
        },
      ],
      balances: [
        {
          wallet,
          marketPda: market.toBase58(),
          address: balance.toBase58(),
          observedSlot: 100,
          exists: true,
        },
      ],
      custody: [
        {
          marketPda: market.toBase58(),
          vaultAddress: vault.toBase58(),
          observedSlot: 100,
          vaultBalanceLamports: "1520",
          vaultRentExemptMinimumLamports: "0",
          userBalanceCount: 1,
          activeOrderCount: 1,
          activeOrderCollateralLamports: "500",
          totalAShares: "1000",
          totalBShares: "0",
          totalALockedLamports: "500",
          totalBLockedLamports: "0",
          totalTradeTreasuryFeeLamports: "10",
          totalTradeMarketMakerFeeLamports: "10",
        },
      ],
    },
  };
}

describe("finalized Solana post-restore reconciliation", () => {
  test("binds restored SOL records to finalized deployment, accounts, history, and custody", () => {
    const input = fixture();
    const result = verifyFinalizedSolanaRecoveryReconciliation(input);
    expect(result).toMatchObject({
      schemaVersion: 1,
      cluster: "devnet",
      duelCount: 1,
      betCount: 1,
      indexedTransactionCount: 1,
      checkpointCount: 1,
      marketCount: 1,
      databaseMutationAuthorized: false,
      chainMutationAuthorized: false,
      productionCutoverAuthorized: false,
      activationRequiresSeparateApproval: true,
    });
    expect(result.custodyExcessLamportsByMarket).toEqual({
      [input.restored.bets[0]!.marketPda]: "0",
    });
    expect(result.reconciledStateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("recovers a finalized failed indexed transaction without weakening a successful placement", () => {
    const input = fixture();
    const failedSignature = signature(40);
    const failedTransactionDigest = createHash("sha256")
      .update(`failed:${failedSignature}`)
      .digest("hex");
    input.restored.databaseBefore.tableCounts.solana_indexed_transactions = 2;
    input.restored.databaseAfter.tableCounts.solana_indexed_transactions = 2;
    input.restored.indexedTransactions.push({
      programId: MARKET.toBase58(),
      signature: failedSignature,
      slot: 51,
      succeeded: false,
      transactionDigest: failedTransactionDigest,
    });
    input.restored.indexerCheckpoints[0] = {
      programId: MARKET.toBase58(),
      startSlot: 10,
      signature: failedSignature,
      slot: 51,
    };
    input.chain.transactions.push({
      signature: failedSignature,
      slot: 51,
      succeeded: false,
      confirmationStatus: "finalized",
      transactionDigest: failedTransactionDigest,
      accountKeys: [MARKET.toBase58()],
    });

    expect(verifyFinalizedSolanaRecoveryReconciliation(input)).toMatchObject({
      indexedTransactionCount: 2,
      checkpointCount: 1,
    });

    const forgedFailedDigest = structuredClone(input);
    forgedFailedDigest.restored.indexedTransactions[1]!.transactionDigest =
      hash("forged-failed");
    forgedFailedDigest.chain.transactions[1]!.transactionDigest =
      hash("forged-failed");
    expect(() =>
      verifyFinalizedSolanaRecoveryReconciliation(forgedFailedDigest),
    ).toThrow("drifted from finalized history");

    const failedPlacement = structuredClone(input);
    const restoredPlacement = failedPlacement.restored.indexedTransactions[0]!;
    const observedPlacement = failedPlacement.chain.transactions[0]!;
    const failedPlacementDigest = createHash("sha256")
      .update(`failed:${restoredPlacement.signature}`)
      .digest("hex");
    restoredPlacement.succeeded = false;
    restoredPlacement.transactionDigest = failedPlacementDigest;
    observedPlacement.succeeded = false;
    observedPlacement.transactionDigest = failedPlacementDigest;
    expect(() =>
      verifyFinalizedSolanaRecoveryReconciliation(failedPlacement),
    ).toThrow("placement transaction is not exactly bound");
  });

  test("keeps the semantic reconciliation digest stable as finalized observation slots advance", () => {
    const first = verifyFinalizedSolanaRecoveryReconciliation(fixture());
    const laterInput = fixture();
    laterInput.chain.minimumAvailableSlot = 2;
    laterInput.chain.finalizedStartSlot = 105;
    laterInput.chain.finalizedEndSlot = 106;
    for (const duel of laterInput.chain.duels) duel.observedSlot = 105;
    for (const market of laterInput.chain.markets) market.observedSlot = 105;
    for (const order of laterInput.chain.orders) order.observedSlot = 105;
    for (const balance of laterInput.chain.balances) balance.observedSlot = 105;
    for (const custody of laterInput.chain.custody) custody.observedSlot = 105;

    const later = verifyFinalizedSolanaRecoveryReconciliation(laterInput);
    expect(later.reconciledStateSha256).toBe(first.reconciledStateSha256);
    expect(later.finalizedStartSlot).toBe(105);
    expect(later.finalizedEndSlot).toBe(106);
  });

  test.each([
    [
      "cluster identity",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.genesisHash = key(30)),
      "cluster or genesis identity drifted",
    ],
    [
      "program identity",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.duelMarketProgram.upgradeAuthority = key(31)),
      "deployment identity drifted",
    ],
    [
      "frozen config",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.marketConfig.configFrozen = false),
      "market configuration drifted",
    ],
    [
      "fee config",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.marketConfig.tradeTreasuryFeeBps = 101),
      "market configuration drifted",
    ],
    [
      "database mutation",
      (value: ReturnType<typeof fixture>) =>
        (value.restored.databaseAfter.tableCounts.bets = 2),
      "database changed",
    ],
    [
      "pruned checkpoint",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.minimumAvailableSlot = 11),
      "checkpoint is not recoverable",
    ],
    [
      "checkpoint slot",
      (value: ReturnType<typeof fixture>) =>
        (value.restored.indexerCheckpoints[0]!.slot = 51),
      "checkpoint is not bound",
    ],
    [
      "transaction finality",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.transactions[0]!.succeeded = false),
      "drifted from finalized history",
    ],
    [
      "transaction digest",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.transactions[0]!.transactionDigest = hash("other")),
      "drifted from finalized history",
    ],
    [
      "placement accounts",
      (value: ReturnType<typeof fixture>) =>
        value.chain.transactions[0]!.accountKeys.pop(),
      "placement transaction is not exactly bound",
    ],
    [
      "duel snapshot",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.duels[0]!.competitiveSnapshotDigest = hash("other")),
      "oracle competitive snapshot drifted",
    ],
    [
      "market winner",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.markets[0]!.winner = "b"),
      "market state drifted",
    ],
    [
      "order state",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.orders[0]!.maker = key(32)),
      "order state drifted",
    ],
    [
      "continuation state",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.orders[0]!.continuationPending = true),
      "order state drifted",
    ],
    [
      "market order sequence",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.markets[0]!.nextOrderId = "1"),
      "outside the canonical market sequence",
    ],
    [
      "unexpected balance",
      (value: ReturnType<typeof fixture>) =>
        value.chain.balances.push({
          ...value.chain.balances[0]!,
          wallet: key(33),
        }),
      "balance observation cardinality",
    ],
    [
      "observation window",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.orders[0]!.observedSlot = 99),
      "outside the finalized observation window",
    ],
    [
      "fee escrow",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.custody[0]!.totalTradeTreasuryFeeLamports = "9"),
      "custody accounting drifted",
    ],
    [
      "active-order escrow",
      (value: ReturnType<typeof fixture>) => {
        value.restored.bets[0]!.currentMatchedAmountUnits = "0";
        value.restored.bets[0]!.currentRestingAmountUnits = "1000";
        value.chain.orders[0]!.filledUnits = "0";
        value.chain.orders[0]!.active = true;
        value.chain.custody[0]!.activeOrderCollateralLamports = "499";
      },
      "omits restored active-order collateral",
    ],
    [
      "undercollateralization",
      (value: ReturnType<typeof fixture>) =>
        (value.chain.custody[0]!.vaultBalanceLamports = "1519"),
      "vault is undercollateralized",
    ],
  ])("rejects %s drift", (_label, mutate, message) => {
    const input = fixture();
    mutate(input);
    expect(() => verifyFinalizedSolanaRecoveryReconciliation(input)).toThrow(
      message,
    );
  });

  test("accepts an absent order and balance only with terminal lifecycle disposition", () => {
    const input = fixture();
    input.chain.orders[0] = {
      betId: "bet-1",
      address: input.chain.orders[0]!.address,
      observedSlot: 100,
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
    };
    input.restored.bets[0]!.terminalOrderDisposition = "filled_closed";
    input.chain.balances[0]!.exists = false;
    input.restored.bets[0]!.terminalBalanceDisposition = "claimed";
    expect(verifyFinalizedSolanaRecoveryReconciliation(input).betCount).toBe(1);

    input.restored.bets[0]!.terminalOrderDisposition = "none";
    expect(() => verifyFinalizedSolanaRecoveryReconciliation(input)).toThrow(
      "closed order lacks finalized disposition",
    );
  });

  test("maps draws and cancellations to fee-free cancelled market state", () => {
    const input = fixture();
    const duel = input.restored.duels[0]!;
    duel.terminalOutcome = "draw";
    duel.terminalWinnerSide = null;
    duel.terminalSeed = null;
    duel.terminalReplayHash = null;
    input.chain.duels[0]!.status = "cancelled";
    input.chain.duels[0]!.winner = "none";
    input.chain.duels[0]!.seed = "0";
    input.chain.duels[0]!.replayHash = hash("zero-replay");
    input.chain.markets[0]!.status = "cancelled";
    input.chain.markets[0]!.winner = "none";
    input.chain.custody[0]!.vaultBalanceLamports = "1020";
    expect(verifyFinalizedSolanaRecoveryReconciliation(input).duelCount).toBe(
      1,
    );
  });
});
