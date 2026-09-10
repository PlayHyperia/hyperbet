import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import assert from "node:assert/strict";

import {
  ORDER_BEHAVIOR_GTC,
  SIDE_ASK,
  SIDE_BID,
  airdrop,
  cancelDuel,
  claimClobWinnings,
  closeEmptyClobPriceLevel,
  closeEmptyClobUserBalance,
  closeFilledClobOrder,
  continueClobOrder,
  createOpenMarketFixture,
  hasProgramError,
  placeClobOrder,
  reclaimClobOrder,
  syncMarketFromDuel,
  uniqueDuelKey,
  writableAccount,
} from "./clob-test-helpers";
import { configureAnchorTests } from "./test-anchor";
import { DuelMarket } from "../target/types/duel_market";
import { FightOracle } from "../target/types/fight_oracle";

configureAnchorTests();

describe("duel_market multi-price continuation limit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const fightProgram = anchor.workspace.FightOracle as Program<FightOracle>;
  const clobProgram = anchor.workspace.DuelMarket as Program<DuelMarket>;
  const authority = (provider.wallet as anchor.Wallet & { payer: Keypair })
    .payer;

  it("continues atomically across three prices after the 50-match bound and closes every liability", async () => {
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
      {
        duelKey: uniqueDuelKey("multi-price-continuation-limit"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = BigInt(
      await provider.connection.getBalance(market.vault),
    );
    const makerOrders: Array<{
      id: number;
      price: number;
      order: anchor.web3.PublicKey;
      restingLevel: anchor.web3.PublicKey;
      userBalance: anchor.web3.PublicKey;
    }> = [];
    const lastOrderAtPrice = new Map<number, anchor.web3.PublicKey>();
    const askPrices = [
      ...Array.from({ length: 20 }, () => 250),
      ...Array.from({ length: 20 }, () => 500),
      ...Array.from({ length: 15 }, () => 750),
    ];

    for (let orderId = 1; orderId <= askPrices.length; orderId += 1) {
      const price = askPrices[orderId - 1]!;
      const previousAtPrice = lastOrderAtPrice.get(price);
      const placed = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
        orderId,
        side: SIDE_ASK,
        price,
        amount: 1_000,
        orderBehavior: ORDER_BEHAVIOR_GTC,
        remainingAccounts: previousAtPrice
          ? [writableAccount(previousAtPrice)]
          : [],
      });
      makerOrders.push({ id: orderId, price, ...placed });
      lastOrderAtPrice.set(price, placed.order);
    }

    const initialMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(initialMarket.nextOrderId.toString(), "56");
    assert.strictEqual(Number(initialMarket.bestAsk), 250);
    assert.strictEqual(Number(initialMarket.bestBid), 0);
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      28_750n,
      "three maker levels must escrow exactly 15,000 + 10,000 + 3,750 lamports",
    );

    const firstFiftyMatchAccounts = makerOrders
      .slice(0, 50)
      .flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]);
    const takerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 56,
      side: SIDE_BID,
      price: 800,
      amount: 60_000,
      orderBehavior: ORDER_BEHAVIOR_GTC,
      remainingAccounts: firstFiftyMatchAccounts,
    });

    const [afterFirstMarket, pendingOrder, makerBalance, takerBalance] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerBid.order),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerBid.userBalance),
      ]);
    assert.strictEqual(afterFirstMarket.nextOrderId.toString(), "57");
    assert.strictEqual(Number(afterFirstMarket.bestAsk), 750);
    assert.strictEqual(Number(afterFirstMarket.bestBid), 0);
    assert.strictEqual(
      afterFirstMarket.accruedTradeTreasuryFeeLamports.toString(),
      "225",
    );
    assert.strictEqual(
      afterFirstMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "225",
    );
    assert.strictEqual(pendingOrder.active, true);
    assert.strictEqual(pendingOrder.continuationPending, true);
    assert.strictEqual(pendingOrder.amount.toString(), "10000");
    assert.strictEqual(pendingOrder.filled.toString(), "0");
    assert.strictEqual(Number(pendingOrder.side), SIDE_BID);
    assert.strictEqual(Number(pendingOrder.price), 800);
    assert.strictEqual(makerBalance.bShares.toString(), "50000");
    assert.strictEqual(makerBalance.bLockedLamports.toString(), "27500");
    assert.strictEqual(takerBalance.aShares.toString(), "50000");
    assert.strictEqual(takerBalance.aLockedLamports.toString(), "22500");
    assert.strictEqual(takerBalance.tradeTreasuryFeeLamports.toString(), "225");
    assert.strictEqual(
      takerBalance.tradeMarketMakerFeeLamports.toString(),
      "225",
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      59_700n,
      "first 50 fills must retain maker collateral, exact execution collateral, pending remainder, and two fee escrows",
    );

    const remainingOrders = makerOrders.slice(50);
    const normalizeAccount = (value: unknown): unknown => {
      if (value instanceof anchor.BN) return value.toString();
      if (value instanceof anchor.web3.PublicKey) return value.toBase58();
      if (Array.isArray(value)) return value.map(normalizeAccount);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(
            ([key, item]) => [key, normalizeAccount(item)],
          ),
        );
      }
      return value;
    };
    const captureContinuationState = async (): Promise<unknown> => {
      const [
        marketState,
        pending,
        level250,
        level500,
        level750,
        makerState,
        takerState,
        vaultLamports,
        liveOrders,
      ] = await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerBid.order),
        clobProgram.account.priceLevel.fetch(makerOrders[0]!.restingLevel),
        clobProgram.account.priceLevel.fetch(makerOrders[20]!.restingLevel),
        clobProgram.account.priceLevel.fetch(makerOrders[40]!.restingLevel),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerBid.userBalance),
        provider.connection.getBalance(market.vault),
        clobProgram.account.order.fetchMultiple(
          remainingOrders.map((entry) => entry.order),
        ),
      ]);
      return normalizeAccount({
        marketState,
        pending,
        level250,
        level500,
        level750,
        makerState,
        takerState,
        vaultLamports,
        liveOrders,
      });
    };

    const beforeMalformedContinuation = await captureContinuationState();
    try {
      await continueClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
        orderId: 56,
        side: SIDE_BID,
        price: 800,
        remainingAccounts: [
          writableAccount(makerOrders[20]!.restingLevel),
          writableAccount(remainingOrders[0]!.order),
          writableAccount(remainingOrders[0]!.userBalance),
        ],
      });
      assert.fail("non-boundary continuation account graph succeeded");
    } catch (error) {
      assert.ok(
        hasProgramError(error, "InvalidRemainingAccount"),
        `expected InvalidRemainingAccount, got ${String(error)}`,
      );
    }
    assert.deepStrictEqual(
      await captureContinuationState(),
      beforeMalformedContinuation,
      "malformed multi-price continuation did not roll back atomically",
    );

    const finalMatchAccounts = remainingOrders.flatMap((entry) => [
      writableAccount(entry.restingLevel),
      writableAccount(entry.order),
      writableAccount(entry.userBalance),
    ]);
    await continueClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 56,
      side: SIDE_BID,
      price: 800,
      remainingAccounts: finalMatchAccounts,
    });

    const [finalOpenMarket, restingBid, makerAfter, takerAfter] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerBid.order),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerBid.userBalance),
      ]);
    assert.strictEqual(Number(finalOpenMarket.bestAsk), 1_000);
    assert.strictEqual(Number(finalOpenMarket.bestBid), 800);
    assert.strictEqual(
      finalOpenMarket.accruedTradeTreasuryFeeLamports.toString(),
      "262",
    );
    assert.strictEqual(
      finalOpenMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "262",
    );
    assert.strictEqual(restingBid.active, true);
    assert.strictEqual(restingBid.continuationPending, false);
    assert.strictEqual(restingBid.amount.toString(), "5000");
    assert.strictEqual(restingBid.filled.toString(), "0");
    assert.strictEqual(makerAfter.bShares.toString(), "55000");
    assert.strictEqual(makerAfter.bLockedLamports.toString(), "28750");
    assert.strictEqual(takerAfter.aShares.toString(), "55000");
    assert.strictEqual(takerAfter.aLockedLamports.toString(), "26250");
    assert.strictEqual(takerAfter.tradeTreasuryFeeLamports.toString(), "262");
    assert.strictEqual(
      takerAfter.tradeMarketMakerFeeLamports.toString(),
      "262",
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      59_524n,
      "continued fills, 5,000-unit resting remainder, and floor fees must reconcile exactly",
    );

    for (const entry of makerOrders) {
      const filled = await clobProgram.account.order.fetch(entry.order);
      assert.strictEqual(filled.active, false);
      assert.strictEqual(filled.continuationPending, false);
      assert.strictEqual(filled.amount.toString(), "1000");
      assert.strictEqual(filled.filled.toString(), "1000");
      assert.strictEqual(filled.prevOrderId.toString(), "0");
      assert.strictEqual(filled.nextOrderId.toString(), "0");
    }

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: taker,
      orderId: 56,
      side: SIDE_BID,
      price: 800,
    });
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(takerBid.order),
      null,
    );

    for (const user of [maker, taker]) {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user,
      });
    }
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)),
      vaultBaseline,
      "terminal multi-price continuation refunds did not restore the vault baseline",
    );

    for (const entry of makerOrders) {
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: maker,
        orderId: entry.id,
      });
      assert.strictEqual(
        await clobProgram.account.order.fetchNullable(entry.order),
        null,
      );
    }
    for (const [side, price, rentRecipient, priceLevel] of [
      [SIDE_ASK, 250, maker, makerOrders[0]!.restingLevel],
      [SIDE_ASK, 500, maker, makerOrders[20]!.restingLevel],
      [SIDE_ASK, 750, maker, makerOrders[40]!.restingLevel],
      [SIDE_BID, 800, taker, takerBid.restingLevel],
    ] as const) {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side,
        price,
        rentRecipient: rentRecipient.publicKey,
        closer: authority,
      });
      assert.strictEqual(
        await clobProgram.account.priceLevel.fetchNullable(priceLevel),
        null,
      );
    }

    const terminalMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.deepStrictEqual(terminalMarket.status, { cancelled: {} });
    assert.strictEqual(Number(terminalMarket.bestBid), 0);
    assert.strictEqual(Number(terminalMarket.bestAsk), 1_000);
    assert.strictEqual(
      terminalMarket.accruedTradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      terminalMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "0",
    );
  });

  it("reclaims a continuation-pending order after its empty price-level PDA is closed", async () => {
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
      {
        duelKey: uniqueDuelKey("missing-pending-price-level-reclaim"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = BigInt(
      await provider.connection.getBalance(market.vault),
    );
    const makerOrders: Array<{
      id: number;
      order: anchor.web3.PublicKey;
      restingLevel: anchor.web3.PublicKey;
      userBalance: anchor.web3.PublicKey;
    }> = [];

    for (let orderId = 1; orderId <= 51; orderId += 1) {
      const previous = makerOrders.at(-1);
      const placed = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
        orderId,
        side: SIDE_ASK,
        price: 500,
        amount: 1_000,
        remainingAccounts: previous ? [writableAccount(previous.order)] : [],
      });
      makerOrders.push({ id: orderId, ...placed });
    }

    const pendingBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 52,
      side: SIDE_BID,
      price: 500,
      amount: 51_000,
      remainingAccounts: makerOrders
        .slice(0, 50)
        .flatMap((entry) => [
          writableAccount(entry.restingLevel),
          writableAccount(entry.order),
          writableAccount(entry.userBalance),
        ]),
    });
    const [pendingOrder, emptyBidLevel, remainingAsk] = await Promise.all([
      clobProgram.account.order.fetch(pendingBid.order),
      clobProgram.account.priceLevel.fetch(pendingBid.restingLevel),
      clobProgram.account.order.fetch(makerOrders[50]!.order),
    ]);
    assert.strictEqual(pendingOrder.active, true);
    assert.strictEqual(pendingOrder.continuationPending, true);
    assert.strictEqual(pendingOrder.amount.toString(), "1000");
    assert.strictEqual(pendingOrder.filled.toString(), "0");
    assert.strictEqual(pendingOrder.prevOrderId.toString(), "0");
    assert.strictEqual(pendingOrder.nextOrderId.toString(), "0");
    assert.strictEqual(emptyBidLevel.headOrderId.toString(), "0");
    assert.strictEqual(emptyBidLevel.tailOrderId.toString(), "0");
    assert.strictEqual(emptyBidLevel.totalOpen.toString(), "0");
    assert.strictEqual(remainingAsk.active, true);
    assert.strictEqual(remainingAsk.filled.toString(), "0");
    assert.strictEqual(remainingAsk.amount.toString(), "1000");

    await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_BID,
      price: 500,
      rentRecipient: taker.publicKey,
      closer: authority,
    });
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(
        pendingBid.restingLevel,
      ),
      null,
      "the pending order's unused same-side level must be genuinely absent",
    );

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: taker,
      orderId: 52,
      side: SIDE_BID,
      price: 500,
    });
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: maker,
      orderId: 51,
      side: SIDE_ASK,
      price: 500,
    });
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(pendingBid.order),
      null,
      "the pending order must close after exact collateral recovery",
    );
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(
        pendingBid.restingLevel,
      ),
      null,
      "reclaim must not recreate or require temporary rent for an absent level",
    );

    for (const user of [maker, taker]) {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user,
      });
    }
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)),
      vaultBaseline,
      "missing-level recovery and cancellation must return every vault lamport",
    );

    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(makerOrders[50]!.order),
      null,
      "the unmatched canonical ask head must close after reclaim",
    );

    for (const entry of makerOrders.slice(0, 50)) {
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: maker,
        orderId: entry.id,
      });
    }
    await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_ASK,
      price: 500,
      rentRecipient: maker.publicKey,
      closer: authority,
    });

    const terminalMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.deepStrictEqual(terminalMarket.status, { cancelled: {} });
    assert.strictEqual(Number(terminalMarket.bestBid), 0);
    assert.strictEqual(Number(terminalMarket.bestAsk), 1_000);
    assert.strictEqual(
      terminalMarket.accruedTradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      terminalMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "0",
    );
  });

  it("reclaims an older continued order appended behind a newer resting order", async () => {
    const maker = Keypair.generate();
    const originalTaker = Keypair.generate();
    const sweepTaker = Keypair.generate();
    const newerMaker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, originalTaker.publicKey, 5),
      airdrop(provider.connection, sweepTaker.publicKey, 5),
      airdrop(provider.connection, newerMaker.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("older-continuation-after-newer-tail"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = BigInt(
      await provider.connection.getBalance(market.vault),
    );
    const makerOrders: Array<{
      id: number;
      order: anchor.web3.PublicKey;
      restingLevel: anchor.web3.PublicKey;
      userBalance: anchor.web3.PublicKey;
    }> = [];

    for (let orderId = 1; orderId <= 51; orderId += 1) {
      const previous = makerOrders.at(-1);
      const placed = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
        orderId,
        side: SIDE_ASK,
        price: 600,
        amount: 1_000,
        remainingAccounts: previous ? [writableAccount(previous.order)] : [],
      });
      makerOrders.push({ id: orderId, ...placed });
    }

    const originalBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: originalTaker,
      orderId: 52,
      side: SIDE_BID,
      price: 600,
      amount: 60_000,
      remainingAccounts: makerOrders
        .slice(0, 50)
        .flatMap((entry) => [
          writableAccount(entry.restingLevel),
          writableAccount(entry.order),
          writableAccount(entry.userBalance),
        ]),
    });
    const pending = await clobProgram.account.order.fetch(originalBid.order);
    assert.strictEqual(pending.continuationPending, true);
    assert.strictEqual(pending.amount.toString(), "10000");
    assert.strictEqual(pending.id.toString(), "52");

    await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: sweepTaker,
      orderId: 53,
      side: SIDE_BID,
      price: 600,
      amount: 1_000,
      remainingAccounts: [
        writableAccount(makerOrders[50]!.restingLevel),
        writableAccount(makerOrders[50]!.order),
        writableAccount(makerOrders[50]!.userBalance),
      ],
    });

    const newerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: newerMaker,
      orderId: 54,
      side: SIDE_BID,
      price: 600,
      amount: 1_000,
    });

    await continueClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: originalTaker,
      orderId: 52,
      side: SIDE_BID,
      price: 600,
      remainingAccounts: [writableAccount(newerBid.order)],
    });

    const [newerHead, olderTail, bidLevel] = await Promise.all([
      clobProgram.account.order.fetch(newerBid.order),
      clobProgram.account.order.fetch(originalBid.order),
      clobProgram.account.priceLevel.fetch(newerBid.restingLevel),
    ]);
    assert.strictEqual(newerHead.id.toString(), "54");
    assert.strictEqual(newerHead.prevOrderId.toString(), "0");
    assert.strictEqual(newerHead.nextOrderId.toString(), "52");
    assert.strictEqual(olderTail.id.toString(), "52");
    assert.strictEqual(olderTail.prevOrderId.toString(), "54");
    assert.strictEqual(olderTail.nextOrderId.toString(), "0");
    assert.strictEqual(bidLevel.headOrderId.toString(), "54");
    assert.strictEqual(bidLevel.tailOrderId.toString(), "52");
    assert.strictEqual(bidLevel.totalOpen.toString(), "11000");
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      58_212n,
      "interleaved continuation must retain exact matched, resting, and fee liabilities",
    );

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: originalTaker,
      orderId: 52,
      side: SIDE_BID,
      price: 600,
      remainingAccounts: [writableAccount(newerBid.order)],
    });

    const [normalizedHead, normalizedLevel] = await Promise.all([
      clobProgram.account.order.fetch(newerBid.order),
      clobProgram.account.priceLevel.fetch(newerBid.restingLevel),
    ]);
    assert.strictEqual(normalizedHead.nextOrderId.toString(), "0");
    assert.strictEqual(normalizedLevel.headOrderId.toString(), "54");
    assert.strictEqual(normalizedLevel.tailOrderId.toString(), "54");
    assert.strictEqual(normalizedLevel.totalOpen.toString(), "1000");

    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: newerMaker,
      orderId: 54,
      side: SIDE_BID,
      price: 600,
    });

    for (const user of [maker, originalTaker, sweepTaker]) {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user,
      });
    }
    await closeEmptyClobUserBalance(clobProgram, {
      marketState: market.marketState,
      user: newerMaker,
    });

    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)),
      vaultBaseline,
      "nonmonotonic queue IDs did not reclaim and refund every lamport",
    );

    for (const entry of makerOrders) {
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: maker,
        orderId: entry.id,
      });
    }
    await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_ASK,
      price: 600,
      rentRecipient: maker.publicKey,
      closer: authority,
    });
    try {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_BID,
        price: 600,
        rentRecipient: newerMaker.publicKey,
        closer: authority,
      });
      assert.fail("newer order payer reclaimed the first payer's level rent");
    } catch (error) {
      assert.ok(
        hasProgramError(error, "InvalidPriceLevelRentRecipient"),
        `expected InvalidPriceLevelRentRecipient, got ${String(error)}`,
      );
    }
    assert.notStrictEqual(
      await clobProgram.account.priceLevel.fetchNullable(newerBid.restingLevel),
      null,
      "wrong-recipient close attempt must preserve the shared price level",
    );
    await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_BID,
      price: 600,
      rentRecipient: originalTaker.publicKey,
      closer: authority,
    });
  });

  it("continues twice across 105 makers before preserving same-side FIFO append and cleanup", async () => {
    const maker = Keypair.generate();
    const follower = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, follower.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("repeated-continuation-fifo-append"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = BigInt(
      await provider.connection.getBalance(market.vault),
    );

    const makerOrders: Array<{
      id: number;
      price: number;
      order: anchor.web3.PublicKey;
      restingLevel: anchor.web3.PublicKey;
      userBalance: anchor.web3.PublicKey;
    }> = [];
    const lastOrderAtPrice = new Map<number, anchor.web3.PublicKey>();
    const askPrices = [
      ...Array.from({ length: 35 }, () => 200),
      ...Array.from({ length: 35 }, () => 400),
      ...Array.from({ length: 35 }, () => 600),
    ];

    for (let offset = 0; offset < askPrices.length; offset += 1) {
      const orderId = offset + 1;
      const price = askPrices[offset]!;
      const previousAtPrice = lastOrderAtPrice.get(price);
      const placed = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
        orderId,
        side: SIDE_ASK,
        price,
        amount: 1_000,
        remainingAccounts: previousAtPrice
          ? [writableAccount(previousAtPrice)]
          : [],
      });
      makerOrders.push({ id: orderId, price, ...placed });
      lastOrderAtPrice.set(price, placed.order);
    }

    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      63_000n,
      "105 asks must escrow exactly 63,000 lamports",
    );

    const takerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 106,
      side: SIDE_BID,
      price: 800,
      amount: 110_000,
      remainingAccounts: makerOrders
        .slice(0, 50)
        .flatMap((entry) => [
          writableAccount(entry.restingLevel),
          writableAccount(entry.order),
          writableAccount(entry.userBalance),
        ]),
    });

    const [
      afterFirstMarket,
      afterFirstOrder,
      afterFirstMaker,
      afterFirstTaker,
    ] = await Promise.all([
      clobProgram.account.marketState.fetch(market.marketState),
      clobProgram.account.order.fetch(takerBid.order),
      clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
      clobProgram.account.userBalance.fetch(takerBid.userBalance),
    ]);
    assert.strictEqual(afterFirstMarket.nextOrderId.toString(), "107");
    assert.strictEqual(Number(afterFirstMarket.bestAsk), 400);
    assert.strictEqual(Number(afterFirstMarket.bestBid), 0);
    assert.strictEqual(afterFirstOrder.continuationPending, true);
    assert.strictEqual(afterFirstOrder.amount.toString(), "60000");
    assert.strictEqual(afterFirstMaker.bShares.toString(), "50000");
    assert.strictEqual(afterFirstMaker.bLockedLamports.toString(), "37000");
    assert.strictEqual(afterFirstTaker.aShares.toString(), "50000");
    assert.strictEqual(afterFirstTaker.aLockedLamports.toString(), "13000");
    assert.strictEqual(
      afterFirstMarket.accruedTradeTreasuryFeeLamports.toString(),
      "130",
    );
    assert.strictEqual(
      afterFirstMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "130",
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      124_260n,
      "first 50 of 105 fills must reconcile exact maker, taker, and fee liabilities",
    );

    await continueClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 106,
      side: SIDE_BID,
      price: 800,
      remainingAccounts: makerOrders
        .slice(50, 100)
        .flatMap((entry) => [
          writableAccount(entry.restingLevel),
          writableAccount(entry.order),
          writableAccount(entry.userBalance),
        ]),
    });

    const [
      afterSecondMarket,
      afterSecondOrder,
      afterSecondMaker,
      afterSecondTaker,
    ] = await Promise.all([
      clobProgram.account.marketState.fetch(market.marketState),
      clobProgram.account.order.fetch(takerBid.order),
      clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
      clobProgram.account.userBalance.fetch(takerBid.userBalance),
    ]);
    assert.strictEqual(Number(afterSecondMarket.bestAsk), 600);
    assert.strictEqual(Number(afterSecondMarket.bestBid), 0);
    assert.strictEqual(afterSecondOrder.continuationPending, true);
    assert.strictEqual(afterSecondOrder.amount.toString(), "10000");
    assert.strictEqual(afterSecondMaker.bShares.toString(), "100000");
    assert.strictEqual(afterSecondMaker.bLockedLamports.toString(), "61000");
    assert.strictEqual(afterSecondTaker.aShares.toString(), "100000");
    assert.strictEqual(afterSecondTaker.aLockedLamports.toString(), "39000");
    assert.strictEqual(
      afterSecondMarket.accruedTradeTreasuryFeeLamports.toString(),
      "390",
    );
    assert.strictEqual(
      afterSecondMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "390",
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      110_780n,
      "second 50-fill continuation must preserve the exact pending remainder liability",
    );

    await continueClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 106,
      side: SIDE_BID,
      price: 800,
      remainingAccounts: [
        ...makerOrders
          .slice(100)
          .flatMap((entry) => [
            writableAccount(entry.restingLevel),
            writableAccount(entry.order),
            writableAccount(entry.userBalance),
          ]),
      ],
    });

    const [finalMarket, finalOrder, bidLevel, finalMaker, finalTaker] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerBid.order),
        clobProgram.account.priceLevel.fetch(takerBid.restingLevel),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerBid.userBalance),
      ]);
    assert.strictEqual(Number(finalMarket.bestAsk), 1_000);
    assert.strictEqual(Number(finalMarket.bestBid), 800);
    assert.strictEqual(finalOrder.continuationPending, false);
    assert.strictEqual(finalOrder.amount.toString(), "5000");
    assert.strictEqual(finalOrder.prevOrderId.toString(), "0");
    assert.strictEqual(finalOrder.nextOrderId.toString(), "0");
    assert.strictEqual(bidLevel.headOrderId.toString(), "106");
    assert.strictEqual(bidLevel.tailOrderId.toString(), "106");
    assert.strictEqual(bidLevel.totalOpen.toString(), "5000");
    assert.strictEqual(finalMaker.bShares.toString(), "105000");
    assert.strictEqual(finalMaker.bLockedLamports.toString(), "63000");
    assert.strictEqual(finalTaker.aShares.toString(), "105000");
    assert.strictEqual(finalTaker.aLockedLamports.toString(), "42000");
    assert.strictEqual(
      finalMarket.accruedTradeTreasuryFeeLamports.toString(),
      "420",
    );
    assert.strictEqual(
      finalMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "420",
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      109_840n,
      "third continuation, canonical same-side head, and cumulative floor fees must reconcile exactly",
    );

    // A pre-existing bid at 800 cannot coexist with asks at or below 800 in a
    // canonical uncrossed book: one side must match instead of resting. The
    // reachable FIFO boundary is therefore continuation-as-head followed by a
    // same-price order appending behind it.
    const followerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: follower,
      orderId: 107,
      side: SIDE_BID,
      price: 800,
      amount: 2_000,
      remainingAccounts: [writableAccount(takerBid.order)],
    });
    const [continuedHead, appendedTail, appendedLevel] = await Promise.all([
      clobProgram.account.order.fetch(takerBid.order),
      clobProgram.account.order.fetch(followerBid.order),
      clobProgram.account.priceLevel.fetch(takerBid.restingLevel),
    ]);
    assert.strictEqual(continuedHead.prevOrderId.toString(), "0");
    assert.strictEqual(continuedHead.nextOrderId.toString(), "107");
    assert.strictEqual(appendedTail.prevOrderId.toString(), "106");
    assert.strictEqual(appendedTail.nextOrderId.toString(), "0");
    assert.strictEqual(appendedLevel.headOrderId.toString(), "106");
    assert.strictEqual(appendedLevel.tailOrderId.toString(), "107");
    assert.strictEqual(appendedLevel.totalOpen.toString(), "7000");
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      111_440n,
      "same-price follower append must retain exact FIFO and vault liability",
    );

    for (const entry of makerOrders) {
      const filled = await clobProgram.account.order.fetch(entry.order);
      assert.strictEqual(filled.active, false);
      assert.strictEqual(filled.continuationPending, false);
      assert.strictEqual(filled.filled.toString(), "1000");
      assert.strictEqual(filled.prevOrderId.toString(), "0");
      assert.strictEqual(filled.nextOrderId.toString(), "0");
    }

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: taker,
      orderId: 106,
      side: SIDE_BID,
      price: 800,
      remainingAccounts: [writableAccount(followerBid.order)],
    });
    const normalizedRestingBid = await clobProgram.account.order.fetch(
      followerBid.order,
    );
    assert.strictEqual(normalizedRestingBid.prevOrderId.toString(), "0");
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: follower,
      orderId: 107,
      side: SIDE_BID,
      price: 800,
    });
    await closeEmptyClobUserBalance(clobProgram, {
      marketState: market.marketState,
      user: follower,
    });
    for (const user of [maker, taker]) {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user,
      });
    }
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)),
      vaultBaseline,
      "repeated continuation and same-side FIFO refunds did not restore the vault baseline",
    );

    for (const entry of makerOrders) {
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: maker,
        orderId: entry.id,
      });
    }
    for (const [side, price, rentRecipient, priceLevel] of [
      [SIDE_ASK, 200, maker, makerOrders[0]!.restingLevel],
      [SIDE_ASK, 400, maker, makerOrders[35]!.restingLevel],
      [SIDE_ASK, 600, maker, makerOrders[70]!.restingLevel],
      [SIDE_BID, 800, taker, takerBid.restingLevel],
    ] as const) {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side,
        price,
        rentRecipient: rentRecipient.publicKey,
        closer: authority,
      });
      assert.strictEqual(
        await clobProgram.account.priceLevel.fetchNullable(priceLevel),
        null,
      );
    }

    const terminalMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.deepStrictEqual(terminalMarket.status, { cancelled: {} });
    assert.strictEqual(Number(terminalMarket.bestBid), 0);
    assert.strictEqual(Number(terminalMarket.bestAsk), 1_000);
    assert.strictEqual(
      terminalMarket.accruedTradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      terminalMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "0",
    );
  });
});
