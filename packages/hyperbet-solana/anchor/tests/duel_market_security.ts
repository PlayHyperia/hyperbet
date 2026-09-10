import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import * as assert from "assert";

import {
  SIDE_ASK,
  SIDE_BID,
  airdrop,
  createOpenMarketFixture,
  deriveOrderPda,
  derivePriceLevelPda,
  deriveMarketStatePda,
  deriveUserBalancePda,
  claimClobWinnings,
  duelStatusBettingOpen,
  duelStatusLocked,
  ensureClobConfig,
  ensureOracleReady,
  hasProgramError,
  initializeCanonicalMarket,
  placeClobOrder,
  proposeDuelResult,
  syncMarketFromDuel,
  uniqueDuelKey,
  cancelDuel,
  challengeDuelResult,
  upsertDuel,
  waitForChainUnixTimestamp,
  writableAccount,
  cancelClobOrder,
  closeEmptyClobPriceLevel,
  closeFilledClobOrder,
} from "./clob-test-helpers";
import { configureAnchorTests } from "./test-anchor";
import { FightOracle } from "../target/types/fight_oracle";
import { DuelMarket } from "../target/types/duel_market";

const DISPUTE_WINDOW_SECS = 3600;

describe("duel_market security regressions", () => {
  const provider = configureAnchorTests();
  anchor.setProvider(provider);

  const fightProgram = anchor.workspace.FightOracle as Program<FightOracle>;
  const clobProgram = anchor.workspace.DuelMarket as Program<DuelMarket>;
  const authority = (provider.wallet as anchor.Wallet & { payer: Keypair })
    .payer;

  async function confirmedWalletDelta(
    signature: string,
    wallet: anchor.web3.PublicKey,
  ): Promise<{ delta: bigint; feePaidByWallet: bigint }> {
    const transaction = await provider.connection.getParsedTransaction(
      signature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    );
    assert.ok(transaction?.meta, `missing confirmed transaction ${signature}`);
    const walletAddress = wallet.toBase58();
    const accountIndex = transaction.transaction.message.accountKeys.findIndex(
      (entry) => entry.pubkey.toBase58() === walletAddress,
    );
    assert.ok(
      accountIndex >= 0,
      `wallet ${walletAddress} missing from transaction`,
    );
    return {
      delta:
        BigInt(transaction.meta.postBalances[accountIndex]) -
        BigInt(transaction.meta.preBalances[accountIndex]),
      feePaidByWallet: accountIndex === 0 ? BigInt(transaction.meta.fee) : 0n,
    };
  }

  before(async () => {
    await ensureOracleReady(
      fightProgram,
      authority,
      authority.publicKey,
      authority.publicKey,
      authority.publicKey,
      DISPUTE_WINDOW_SECS,
    );
  });

  it("rejects unauthorized canonical market initialization", async () => {
    const outsider = Keypair.generate();
    await airdrop(provider.connection, outsider.publicKey, 3);

    await ensureOracleReady(fightProgram, authority, authority.publicKey);
    const config = await ensureClobConfig(clobProgram, authority);
    const duelKey = uniqueDuelKey("unauthorized-market-init");
    const now = Math.floor(Date.now() / 1000);
    const duelState = await upsertDuel(fightProgram, authority, duelKey, {
      status: duelStatusBettingOpen(),
      betOpenTs: now - 10,
      betCloseTs: now + 300,
      duelStartTs: now + 360,
      metadataUri: "https://hyperia.gg/tests/security/unauthorized",
    });

    try {
      await initializeCanonicalMarket(
        clobProgram,
        outsider,
        duelState,
        duelKey,
        config,
      );
      assert.fail("unauthorized market initialization succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "UnauthorizedMarketOperator"),
        `expected UnauthorizedMarketOperator, got ${String(error)}`,
      );
    }

    const marketState = deriveMarketStatePda(clobProgram.programId, duelState);
    assert.strictEqual(
      await clobProgram.account.marketState.fetchNullable(marketState),
      null,
    );
  });

  it("rejects new orders after the oracle betting window closes", async () => {
    const trader = Keypair.generate();
    await airdrop(provider.connection, trader.publicKey, 3);

    const now = Math.floor(Date.now() / 1000);
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("betting-window-closed"),
        betOpenTs: now - 120,
        betCloseTs: now - 5,
        duelStartTs: now - 1,
        metadataUri: "https://hyperia.gg/tests/security/closed-window",
      },
    );

    try {
      await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: trader,
        orderId: 1,
        side: SIDE_BID,
        price: 500,
        amount: 1000,
      });
      assert.fail("post-close order placement succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "BettingClosed"),
        `expected BettingClosed, got ${String(error)}`,
      );
    }
  });

  it("rejects duel windows that close immediately or start before betting closes", async () => {
    await ensureOracleReady(fightProgram, authority, authority.publicKey);
    const now = Math.floor(Date.now() / 1000);

    try {
      await upsertDuel(
        fightProgram,
        authority,
        uniqueDuelKey("instant-close"),
        {
          status: duelStatusBettingOpen(),
          betOpenTs: now,
          betCloseTs: now,
          duelStartTs: now + 60,
          metadataUri: "https://hyperia.gg/tests/security/instant-close",
        },
      );
      assert.fail("zero-length betting window was accepted");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidBetWindow"),
        `expected InvalidBetWindow, got ${String(error)}`,
      );
    }

    try {
      await upsertDuel(
        fightProgram,
        authority,
        uniqueDuelKey("duel-before-close"),
        {
          status: duelStatusBettingOpen(),
          betOpenTs: now,
          betCloseTs: now + 120,
          duelStartTs: now + 60,
          metadataUri: "https://hyperia.gg/tests/security/duel-before-close",
        },
      );
      assert.fail("duel start before bet close was accepted");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidLifecycleTransition"),
        `expected InvalidLifecycleTransition, got ${String(error)}`,
      );
    }
  });

  it("rejects maker balances from a different market", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const marketOne = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("balance-market-one") },
    );
    const marketTwo = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("balance-market-two") },
    );

    const makerAsk = await placeClobOrder(clobProgram, {
      marketState: marketOne.marketState,
      duelState: marketOne.duelState,
      config: marketOne.config,
      treasury: marketOne.treasury,
      marketMaker: marketOne.marketMaker,
      vault: marketOne.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    const foreignBalance = await placeClobOrder(clobProgram, {
      marketState: marketTwo.marketState,
      duelState: marketTwo.duelState,
      config: marketTwo.config,
      treasury: marketTwo.treasury,
      marketMaker: marketTwo.marketMaker,
      vault: marketTwo.vault,
      user: maker,
      orderId: 1,
      side: SIDE_BID,
      price: 500,
      amount: 1000,
    });

    try {
      await placeClobOrder(clobProgram, {
        marketState: marketOne.marketState,
        duelState: marketOne.duelState,
        config: marketOne.config,
        treasury: marketOne.treasury,
        marketMaker: marketOne.marketMaker,
        vault: marketOne.vault,
        user: taker,
        orderId: 2,
        side: SIDE_BID,
        price: 600,
        amount: 1000,
        remainingAccounts: [
          writableAccount(makerAsk.restingLevel),
          writableAccount(makerAsk.order),
          writableAccount(foreignBalance.userBalance),
        ],
      });
      assert.fail("cross-market maker balance poisoning succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidRemainingAccount"),
        `expected InvalidRemainingAccount, got ${String(error)}`,
      );
    }
  });

  it("rejects a deterministic malformed match-account matrix without custody drift", async () => {
    const distractor = Keypair.generate();
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, distractor.publicKey, 5),
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 8),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("malformed-match-account-matrix") },
    );
    const distractorBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: distractor,
      orderId: 1,
      side: SIDE_BID,
      price: 400,
      amount: 1000,
    });
    const makerAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    const rejectedOrder = deriveOrderPda(
      clobProgram.programId,
      market.marketState,
      3,
    );
    const rejectedBalance = deriveUserBalancePda(
      clobProgram.programId,
      market.marketState,
      taker.publicKey,
    );
    const rejectedLevel = derivePriceLevelPda(
      clobProgram.programId,
      market.marketState,
      SIDE_BID,
      600,
    );
    const vaultBefore = await provider.connection.getBalance(market.vault);
    const marketBefore = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    const levelBefore = await clobProgram.account.priceLevel.fetch(
      makerAsk.restingLevel,
    );
    const orderBefore = await clobProgram.account.order.fetch(makerAsk.order);
    const makerBalanceBefore = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    const distractorBalanceBefore = await clobProgram.account.userBalance.fetch(
      distractorBid.userBalance,
    );

    const assertNoCustodyOrBookDrift = async (): Promise<void> => {
      const [
        marketAfter,
        levelAfter,
        orderAfter,
        makerBalanceAfter,
        distractorBalanceAfter,
        vaultAfter,
      ] = await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.priceLevel.fetch(makerAsk.restingLevel),
        clobProgram.account.order.fetch(makerAsk.order),
        clobProgram.account.userBalance.fetch(makerAsk.userBalance),
        clobProgram.account.userBalance.fetch(distractorBid.userBalance),
        provider.connection.getBalance(market.vault),
      ]);

      assert.strictEqual(
        marketAfter.nextOrderId.toString(),
        marketBefore.nextOrderId.toString(),
      );
      assert.strictEqual(marketAfter.bestBid, marketBefore.bestBid);
      assert.strictEqual(marketAfter.bestAsk, marketBefore.bestAsk);
      assert.strictEqual(
        marketAfter.accruedTradeTreasuryFeeLamports.toString(),
        marketBefore.accruedTradeTreasuryFeeLamports.toString(),
      );
      assert.strictEqual(
        marketAfter.accruedTradeMarketMakerFeeLamports.toString(),
        marketBefore.accruedTradeMarketMakerFeeLamports.toString(),
      );
      assert.strictEqual(
        levelAfter.headOrderId.toString(),
        levelBefore.headOrderId.toString(),
      );
      assert.strictEqual(
        levelAfter.tailOrderId.toString(),
        levelBefore.tailOrderId.toString(),
      );
      assert.strictEqual(
        levelAfter.totalOpen.toString(),
        levelBefore.totalOpen.toString(),
      );
      assert.strictEqual(
        orderAfter.filled.toString(),
        orderBefore.filled.toString(),
      );
      assert.strictEqual(orderAfter.active, orderBefore.active);
      assert.strictEqual(
        makerBalanceAfter.aShares.toString(),
        makerBalanceBefore.aShares.toString(),
      );
      assert.strictEqual(
        makerBalanceAfter.bShares.toString(),
        makerBalanceBefore.bShares.toString(),
      );
      assert.strictEqual(
        distractorBalanceAfter.aShares.toString(),
        distractorBalanceBefore.aShares.toString(),
      );
      assert.strictEqual(
        distractorBalanceAfter.bShares.toString(),
        distractorBalanceBefore.bShares.toString(),
      );
      assert.strictEqual(vaultAfter, vaultBefore);
      assert.strictEqual(
        await clobProgram.account.order.fetchNullable(rejectedOrder),
        null,
      );
      assert.strictEqual(
        await clobProgram.account.userBalance.fetchNullable(rejectedBalance),
        null,
      );
      assert.strictEqual(
        await clobProgram.account.priceLevel.fetchNullable(rejectedLevel),
        null,
      );
    };

    const vectors: Array<{
      name: string;
      expectedError: string;
      remainingAccounts: anchor.web3.AccountMeta[];
    }> = [
      {
        name: "missing level",
        expectedError: "MissingMatchAccounts",
        remainingAccounts: [],
      },
      {
        name: "order in level position",
        expectedError: "InvalidRemainingAccount",
        remainingAccounts: [writableAccount(makerAsk.order)],
      },
      {
        name: "missing order",
        expectedError: "MissingMatchAccounts",
        remainingAccounts: [writableAccount(makerAsk.restingLevel)],
      },
      {
        name: "market in order position",
        expectedError: "InvalidRemainingAccount",
        remainingAccounts: [
          writableAccount(makerAsk.restingLevel),
          writableAccount(market.marketState),
        ],
      },
      {
        name: "missing maker balance",
        expectedError: "MissingMatchAccounts",
        remainingAccounts: [
          writableAccount(makerAsk.restingLevel),
          writableAccount(makerAsk.order),
        ],
      },
      {
        name: "market in maker-balance position",
        expectedError: "InvalidRemainingAccount",
        remainingAccounts: [
          writableAccount(makerAsk.restingLevel),
          writableAccount(makerAsk.order),
          writableAccount(market.marketState),
        ],
      },
      {
        name: "system account in maker-balance position",
        expectedError: "InvalidRemainingAccount",
        remainingAccounts: [
          writableAccount(makerAsk.restingLevel),
          writableAccount(makerAsk.order),
          writableAccount(taker.publicKey),
        ],
      },
      {
        name: "same-market wrong-user maker balance",
        expectedError: "InvalidRemainingAccount",
        remainingAccounts: [
          writableAccount(makerAsk.restingLevel),
          writableAccount(makerAsk.order),
          writableAccount(distractorBid.userBalance),
        ],
      },
      {
        name: "correct accounts in the wrong order",
        expectedError: "InvalidRemainingAccount",
        remainingAccounts: [
          writableAccount(makerAsk.order),
          writableAccount(makerAsk.restingLevel),
          writableAccount(makerAsk.userBalance),
        ],
      },
    ];

    for (const vector of vectors) {
      try {
        await placeClobOrder(clobProgram, {
          marketState: market.marketState,
          duelState: market.duelState,
          config: market.config,
          treasury: market.treasury,
          marketMaker: market.marketMaker,
          vault: market.vault,
          user: taker,
          orderId: 3,
          side: SIDE_BID,
          price: 600,
          amount: 1000,
          remainingAccounts: vector.remainingAccounts,
        });
        assert.fail(`accepted malformed match graph: ${vector.name}`);
      } catch (error: unknown) {
        assert.ok(
          hasProgramError(error, vector.expectedError),
          `expected ${vector.expectedError} for ${vector.name}, got ${String(error)}`,
        );
      }
      await assertNoCustodyOrBookDrift();
    }
  });

  it("increments next_order_id even when the taker order is fully matched", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("next-order-id") },
    );

    const makerAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    const takerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 2,
      side: SIDE_BID,
      price: 600,
      amount: 1000,
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });

    const updatedMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(updatedMarket.nextOrderId.toString(), "3");

    const makerOrder = await clobProgram.account.order.fetch(makerAsk.order);
    assert.strictEqual(makerOrder.id.toString(), "1");
    assert.strictEqual(makerOrder.amount.toString(), "1000");
    assert.strictEqual(makerOrder.filled.toString(), "1000");
    assert.strictEqual(makerOrder.active, false);

    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(takerBid.order),
      null,
    );
  });

  it("returns fully filled Order PDA rent only to its maker after terminal state", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    const outsider = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
      airdrop(provider.connection, outsider.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("filled-order-close") },
    );

    const makerAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    const takerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 2,
      side: SIDE_BID,
      price: 600,
      amount: 1000,
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });

    const orderRent = BigInt(
      await provider.connection.getBalance(makerAsk.order),
    );
    const priceLevelRent = BigInt(
      await provider.connection.getBalance(makerAsk.restingLevel),
    );
    assert.ok(orderRent > 0n);
    assert.ok(priceLevelRent > 0n);
    const filledOrderBeforeCleanup = await clobProgram.account.order.fetch(
      makerAsk.order,
    );
    const emptyLevelBeforeCleanup = await clobProgram.account.priceLevel.fetch(
      makerAsk.restingLevel,
    );
    assert.strictEqual(filledOrderBeforeCleanup.active, false);
    assert.strictEqual(
      filledOrderBeforeCleanup.filled.toString(),
      filledOrderBeforeCleanup.amount.toString(),
    );
    assert.strictEqual(filledOrderBeforeCleanup.prevOrderId.toString(), "0");
    assert.strictEqual(filledOrderBeforeCleanup.nextOrderId.toString(), "0");
    assert.strictEqual(filledOrderBeforeCleanup.continuationPending, false);
    assert.ok(emptyLevelBeforeCleanup.rentRecipient.equals(maker.publicKey));
    assert.strictEqual(emptyLevelBeforeCleanup.headOrderId.toString(), "0");
    assert.strictEqual(emptyLevelBeforeCleanup.tailOrderId.toString(), "0");
    assert.strictEqual(emptyLevelBeforeCleanup.totalOpen.toString(), "0");

    try {
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: outsider,
        orderId: 1,
      });
      assert.fail("non-maker closed a fully filled order");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NotOrderMaker"),
        `expected NotOrderMaker, got ${String(error)}`,
      );
    }
    assert.notStrictEqual(
      await clobProgram.account.order.fetchNullable(makerAsk.order),
      null,
    );

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    const terminalMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.ok("cancelled" in terminalMarket.status);

    const closeResult = await closeFilledClobOrder(clobProgram, {
      marketState: market.marketState,
      user: maker,
      orderId: 1,
    });

    const makerOrder = await clobProgram.account.order.fetchNullable(
      makerAsk.order,
    );
    const takerOrder = await clobProgram.account.order.fetchNullable(
      takerBid.order,
    );
    assert.strictEqual(makerOrder, null);
    assert.strictEqual(takerOrder, null);

    const walletAccounting = await confirmedWalletDelta(
      closeResult.signature,
      maker.publicKey,
    );
    assert.strictEqual(
      walletAccounting.delta + walletAccounting.feePaidByWallet,
      orderRent,
    );

    const levelCloseResult = await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_ASK,
      price: 600,
      rentRecipient: maker.publicKey,
      closer: outsider,
    });
    const levelRecipientAccounting = await confirmedWalletDelta(
      levelCloseResult.signature,
      maker.publicKey,
    );
    const levelCloserAccounting = await confirmedWalletDelta(
      levelCloseResult.signature,
      outsider.publicKey,
    );
    assert.strictEqual(levelRecipientAccounting.delta, priceLevelRent);
    assert.strictEqual(levelRecipientAccounting.feePaidByWallet, 0n);
    assert.strictEqual(
      levelCloserAccounting.delta + levelCloserAccounting.feePaidByWallet,
      0n,
    );
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(makerAsk.restingLevel),
      null,
    );

    try {
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: maker,
        orderId: 1,
      });
      assert.fail("closed an already closed filled order twice");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "AccountNotInitialized") ||
          hasProgramError(error, "AccountOwnedByWrongProgram"),
        `expected a closed-account error, got ${String(error)}`,
      );
    }
  });

  it("rejects filled-order cleanup while the order is still active", async () => {
    const maker = Keypair.generate();
    await airdrop(provider.connection, maker.publicKey, 5);
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("active-order-close-rejected") },
    );
    const restingOrder = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    try {
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: maker,
        orderId: 1,
      });
      assert.fail("active order cleanup succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "OrderStillActive"),
        `expected OrderStillActive, got ${String(error)}`,
      );
    }

    const orderAfterFailure = await clobProgram.account.order.fetch(
      restingOrder.order,
    );
    assert.strictEqual(orderAfterFailure.active, true);
    assert.strictEqual(orderAfterFailure.filled.toString(), "0");
  });

  it("rejects order mutation and claims during non-open lifecycle states", async () => {
    const maker = Keypair.generate();
    const now = Math.floor(Date.now() / 1000);
    // Market/config initialization performs several finalized transactions.
    // Keep enough wall-clock headroom for a loaded validator so the setup
    // order is deterministically open before this test advances to Locked.
    const betCloseTs = now + 30;
    await airdrop(provider.connection, maker.publicKey, 5);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("guardrail-non-open-mutations"),
        betOpenTs: now - 120,
        betCloseTs,
        duelStartTs: betCloseTs,
      },
    );

    const makerAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    await waitForChainUnixTimestamp(
      provider.connection,
      betCloseTs + 1,
      45_000,
    );
    await upsertDuel(fightProgram, authority, market.duelKey, {
      status: duelStatusLocked(),
      betOpenTs: now - 120,
      betCloseTs,
      duelStartTs: betCloseTs,
      metadataUri: "https://hyperia.gg/tests/security/non-open-mutations",
    });
    await ensureOracleReady(
      fightProgram,
      authority,
      authority.publicKey,
      authority.publicKey,
      authority.publicKey,
      3600,
    );
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    try {
      await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
        orderId: 2,
        side: SIDE_BID,
        price: 550,
        amount: 1000,
      });
      assert.fail("lock-state order placement succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotOpen"),
        `expected MarketNotOpen, got ${String(error)}`,
      );
    }

    try {
      await cancelClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        vault: market.vault,
        user: maker,
        orderId: 1,
        side: SIDE_ASK,
        price: 600,
      });
      assert.fail("lock-state cancellation succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotOpen"),
        `expected MarketNotOpen, got ${String(error)}`,
      );
    }
    assert.strictEqual(
      (await clobProgram.account.order.fetch(makerAsk.order)).active,
      true,
    );

    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    await proposeDuelResult(fightProgram, authority, market.duelKey, {
      winner: { a: {} },
      duelEndTs: Math.floor(Date.now() / 1000),
      seed: 42,
      metadataUri: "https://hyperia.gg/tests/security/proposed",
    });
    await challengeDuelResult(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    try {
      await cancelClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        vault: market.vault,
        user: maker,
        orderId: 1,
        side: SIDE_ASK,
        price: 600,
      });
      assert.fail("challenged-state cancellation succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotOpen"),
        `expected MarketNotOpen, got ${String(error)}`,
      );
    }
    assert.strictEqual(
      (await clobProgram.account.order.fetch(makerAsk.order)).active,
      true,
    );

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
      });
      assert.fail("preterminal claim succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotResolved"),
        `expected MarketNotResolved, got ${String(error)}`,
      );
    }
  });

  it("locks non-finalized claims to terminal states and refunds cancelled matches", async () => {
    const maker = Keypair.generate();
    await airdrop(provider.connection, maker.publicKey, 5);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("guardrail-cancelled-claim"),
        metadataUri: "https://hyperia.gg/tests/security/cancelled-claim",
      },
    );

    const makerAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_BID,
      price: 600,
      amount: 1000,
    });

    const taker = Keypair.generate();
    await airdrop(provider.connection, taker.publicKey, 5);
    const takerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    const makerBalance = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    assert.strictEqual(makerBalance.aShares.toString(), "1000");
    assert.strictEqual(makerBalance.aLockedLamports.toString(), "600");

    await claimClobWinnings(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
    });

    await claimClobWinnings(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
    });

    const [makerBalanceAfter, takerBalanceAfter] = await Promise.all([
      provider.connection.getAccountInfo(makerAsk.userBalance),
      provider.connection.getAccountInfo(takerBid.userBalance),
    ]);
    assert.strictEqual(makerBalanceAfter, null);
    assert.strictEqual(takerBalanceAfter, null);
  });
});
