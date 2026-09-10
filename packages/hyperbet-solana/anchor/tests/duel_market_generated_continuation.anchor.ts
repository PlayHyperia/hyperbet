import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ORDER_BEHAVIOR_GTC,
  ORDER_BEHAVIOR_IOC,
  SIDE_ASK,
  SIDE_BID,
  airdrop,
  cancelDuel,
  claimClobWinnings,
  closeEmptyClobPriceLevel,
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

interface PlannedOrder {
  price: number;
  amount: number;
}

interface MakerOrder extends PlannedOrder {
  id: number;
  order: PublicKey;
  restingLevel: PublicKey;
  userBalance: PublicKey;
}

const FORWARD_PLAN_SEED = 0x434f4e54;
const FORWARD_PLAN_HASH =
  "88e395c0bb44a7b104ffe59ecc91dd9e1914ef713569ceffd7b1e631a73e88cd";
const REVERSE_PLAN_SEED = 0x52455652;
const REVERSE_PLAN_HASH =
  "0b3e93bf38b5d303957335e546269af27b60ea10cac2a57639567b50d448cadc";
const PRICES = [125, 250, 375, 500, 625, 750] as const;
const AMOUNTS = [1_000, 2_000, 3_000] as const;

function buildInterleavedPlan(seed: number): PlannedOrder[] {
  let state = seed;
  const nextWord = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const plan = Array.from({ length: 60 }, (_, index) => ({
    price: PRICES[index % PRICES.length]!,
    amount: AMOUNTS[nextWord() % AMOUNTS.length]!,
  }));
  for (let index = plan.length - 1; index > 0; index -= 1) {
    const swapIndex = nextWord() % (index + 1);
    [plan[index], plan[swapIndex]] = [plan[swapIndex]!, plan[index]!];
  }
  return plan;
}

function sumAmount(orders: readonly MakerOrder[]): bigint {
  return orders.reduce((total, order) => total + BigInt(order.amount), 0n);
}

function sumExecutionCost(orders: readonly MakerOrder[]): bigint {
  return orders.reduce(
    (total, order) =>
      total + (BigInt(order.amount) * BigInt(order.price)) / 1_000n,
    0n,
  );
}

function sumMakerCollateral(orders: readonly MakerOrder[]): bigint {
  return orders.reduce(
    (total, order) =>
      total + (BigInt(order.amount) * BigInt(1_000 - order.price)) / 1_000n,
    0n,
  );
}

function sumSideCollateral(
  orders: readonly MakerOrder[],
  side: number,
): bigint {
  return orders.reduce(
    (total, order) =>
      total +
      (BigInt(order.amount) *
        BigInt(side === SIDE_BID ? order.price : 1_000 - order.price)) /
        1_000n,
    0n,
  );
}

describe("duel_market generated continuation boundary", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const fightProgram = anchor.workspace.FightOracle as Program<FightOracle>;
  const clobProgram = anchor.workspace.DuelMarket as Program<DuelMarket>;
  const authority = (provider.wallet as anchor.Wallet & { payer: Keypair })
    .payer;

  async function setMarketPaused(
    config: PublicKey,
    orderPlacementPaused: boolean,
  ): Promise<void> {
    await clobProgram.methods
      .setMarketPaused(orderPlacementPaused, false)
      .accountsPartial({
        authority: authority.publicKey,
        config,
      })
      .signers([authority])
      .rpc();
  }

  it("derives the 50-fill account graph from an interleaved six-price book and closes every liability", async () => {
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
        duelKey: uniqueDuelKey("generated-interleaved-continuation"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = BigInt(
      await provider.connection.getBalance(market.vault),
    );

    const plan = buildInterleavedPlan(FORWARD_PLAN_SEED);
    assert.strictEqual(
      createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      FORWARD_PLAN_HASH,
      "generated continuation plan drifted",
    );

    const makerOrders: MakerOrder[] = [];
    const lastOrderAtPrice = new Map<number, PublicKey>();
    const priceLevelAtPrice = new Map<number, PublicKey>();
    for (let offset = 0; offset < plan.length; offset += 1) {
      const orderId = offset + 1;
      const planned = plan[offset]!;
      const previousAtPrice = lastOrderAtPrice.get(planned.price);
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
        price: planned.price,
        amount: planned.amount,
        orderBehavior: ORDER_BEHAVIOR_GTC,
        remainingAccounts: previousAtPrice
          ? [writableAccount(previousAtPrice)]
          : [],
      });
      makerOrders.push({ id: orderId, ...planned, ...placed });
      lastOrderAtPrice.set(planned.price, placed.order);
      priceLevelAtPrice.set(planned.price, placed.restingLevel);
    }

    const canonicalOrders = [...makerOrders].sort(
      (left, right) => left.price - right.price || left.id - right.id,
    );
    const firstPass = canonicalOrders.slice(0, 50);
    const secondPass = canonicalOrders.slice(50);
    const allAmount = sumAmount(canonicalOrders);
    const firstAmount = sumAmount(firstPass);
    const secondAmount = sumAmount(secondPass);
    const allExecutionCost = sumExecutionCost(canonicalOrders);
    const firstExecutionCost = sumExecutionCost(firstPass);
    const secondExecutionCost = sumExecutionCost(secondPass);
    const makerCollateral = sumMakerCollateral(canonicalOrders);
    const firstMakerCollateral = sumMakerCollateral(firstPass);
    const secondMakerCollateral = sumMakerCollateral(secondPass);
    assert.deepStrictEqual(
      {
        allAmount,
        allExecutionCost,
        firstAmount,
        firstExecutionCost,
        firstMakerCollateral,
        makerCollateral,
        secondAmount,
        secondExecutionCost,
        secondMakerCollateral,
      },
      {
        allAmount: 127_000n,
        allExecutionCost: 56_875n,
        firstAmount: 106_000n,
        firstExecutionCost: 41_125n,
        firstMakerCollateral: 64_875n,
        makerCollateral: 70_125n,
        secondAmount: 21_000n,
        secondExecutionCost: 15_750n,
        secondMakerCollateral: 5_250n,
      },
      "generated canonical book totals drifted",
    );

    const initialMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(initialMarket.nextOrderId.toString(), "61");
    assert.strictEqual(Number(initialMarket.bestAsk), 125);
    assert.strictEqual(Number(initialMarket.bestBid), 0);
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      makerCollateral,
    );

    const takerPrice = 900;
    const restingRemainder = 4_000n;
    const takerBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 61,
      side: SIDE_BID,
      price: takerPrice,
      amount: Number(allAmount + restingRemainder),
      orderBehavior: ORDER_BEHAVIOR_GTC,
      remainingAccounts: firstPass.flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]),
    });

    const firstFee = firstExecutionCost / 100n;
    const pendingAmount = secondAmount + restingRemainder;
    const [afterFirstMarket, pendingOrder, makerAfterFirst, takerAfterFirst] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerBid.order),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerBid.userBalance),
      ]);
    assert.strictEqual(afterFirstMarket.nextOrderId.toString(), "62");
    assert.strictEqual(Number(afterFirstMarket.bestAsk), 750);
    assert.strictEqual(Number(afterFirstMarket.bestBid), 0);
    assert.strictEqual(pendingOrder.continuationPending, true);
    assert.strictEqual(
      pendingOrder.amount.toString(),
      pendingAmount.toString(),
    );
    assert.strictEqual(
      makerAfterFirst.bShares.toString(),
      firstAmount.toString(),
    );
    assert.strictEqual(
      makerAfterFirst.bLockedLamports.toString(),
      firstMakerCollateral.toString(),
    );
    assert.strictEqual(
      takerAfterFirst.aShares.toString(),
      firstAmount.toString(),
    );
    assert.strictEqual(
      takerAfterFirst.aLockedLamports.toString(),
      firstExecutionCost.toString(),
    );
    assert.strictEqual(
      afterFirstMarket.accruedTradeTreasuryFeeLamports.toString(),
      firstFee.toString(),
    );
    assert.strictEqual(
      afterFirstMarket.accruedTradeMarketMakerFeeLamports.toString(),
      firstFee.toString(),
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      makerCollateral +
        firstExecutionCost +
        (pendingAmount * BigInt(takerPrice)) / 1_000n +
        firstFee * 2n,
      "first generated pass must retain exact filled, pending, and fee liabilities",
    );

    const pausedContinuationSnapshot = {
      vault: await provider.connection.getBalance(market.vault),
      nextOrderId: afterFirstMarket.nextOrderId.toString(),
      bestBid: Number(afterFirstMarket.bestBid),
      bestAsk: Number(afterFirstMarket.bestAsk),
      treasuryFee: afterFirstMarket.accruedTradeTreasuryFeeLamports.toString(),
      marketMakerFee:
        afterFirstMarket.accruedTradeMarketMakerFeeLamports.toString(),
      orderFilled: pendingOrder.filled.toString(),
      orderAmount: pendingOrder.amount.toString(),
      continuationPending: pendingOrder.continuationPending,
      makerShares: makerAfterFirst.bShares.toString(),
      makerLocked: makerAfterFirst.bLockedLamports.toString(),
      takerShares: takerAfterFirst.aShares.toString(),
      takerLocked: takerAfterFirst.aLockedLamports.toString(),
    };

    await setMarketPaused(market.config, true);
    try {
      let pausedContinuationError: unknown;
      try {
        await continueClobOrder(clobProgram, {
          marketState: market.marketState,
          duelState: market.duelState,
          config: market.config,
          treasury: market.treasury,
          marketMaker: market.marketMaker,
          vault: market.vault,
          user: taker,
          orderId: 61,
          side: SIDE_BID,
          price: takerPrice,
          remainingAccounts: secondPass.flatMap((entry) => [
            writableAccount(entry.restingLevel),
            writableAccount(entry.order),
            writableAccount(entry.userBalance),
          ]),
        });
      } catch (error: unknown) {
        pausedContinuationError = error;
      }
      assert.ok(
        pausedContinuationError &&
          hasProgramError(pausedContinuationError, "OrderPlacementPaused"),
        `expected OrderPlacementPaused, got ${String(pausedContinuationError)}`,
      );

      const [pausedMarket, pausedOrder, pausedMaker, pausedTaker, pausedVault] =
        await Promise.all([
          clobProgram.account.marketState.fetch(market.marketState),
          clobProgram.account.order.fetch(takerBid.order),
          clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
          clobProgram.account.userBalance.fetch(takerBid.userBalance),
          provider.connection.getBalance(market.vault),
        ]);
      assert.deepStrictEqual(
        {
          vault: pausedVault,
          nextOrderId: pausedMarket.nextOrderId.toString(),
          bestBid: Number(pausedMarket.bestBid),
          bestAsk: Number(pausedMarket.bestAsk),
          treasuryFee: pausedMarket.accruedTradeTreasuryFeeLamports.toString(),
          marketMakerFee:
            pausedMarket.accruedTradeMarketMakerFeeLamports.toString(),
          orderFilled: pausedOrder.filled.toString(),
          orderAmount: pausedOrder.amount.toString(),
          continuationPending: pausedOrder.continuationPending,
          makerShares: pausedMaker.bShares.toString(),
          makerLocked: pausedMaker.bLockedLamports.toString(),
          takerShares: pausedTaker.aShares.toString(),
          takerLocked: pausedTaker.aLockedLamports.toString(),
        },
        pausedContinuationSnapshot,
        "a rejected paused continuation must leave every market and custody field unchanged",
      );
    } finally {
      await setMarketPaused(market.config, false);
    }

    await continueClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 61,
      side: SIDE_BID,
      price: takerPrice,
      remainingAccounts: secondPass.flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]),
    });

    const secondFee = secondExecutionCost / 100n;
    const totalFee = firstFee + secondFee;
    const restingCollateral = (restingRemainder * BigInt(takerPrice)) / 1_000n;
    const [finalMarket, restingBid, bidLevel, makerAfter, takerAfter] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerBid.order),
        clobProgram.account.priceLevel.fetch(takerBid.restingLevel),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerBid.userBalance),
      ]);
    assert.strictEqual(Number(finalMarket.bestAsk), 1_000);
    assert.strictEqual(Number(finalMarket.bestBid), takerPrice);
    assert.strictEqual(restingBid.continuationPending, false);
    assert.strictEqual(
      restingBid.amount.toString(),
      restingRemainder.toString(),
    );
    assert.strictEqual(restingBid.prevOrderId.toString(), "0");
    assert.strictEqual(restingBid.nextOrderId.toString(), "0");
    assert.strictEqual(bidLevel.headOrderId.toString(), "61");
    assert.strictEqual(bidLevel.tailOrderId.toString(), "61");
    assert.strictEqual(
      bidLevel.totalOpen.toString(),
      restingRemainder.toString(),
    );
    assert.strictEqual(makerAfter.bShares.toString(), allAmount.toString());
    assert.strictEqual(
      makerAfter.bLockedLamports.toString(),
      makerCollateral.toString(),
    );
    assert.strictEqual(takerAfter.aShares.toString(), allAmount.toString());
    assert.strictEqual(
      takerAfter.aLockedLamports.toString(),
      allExecutionCost.toString(),
    );
    assert.strictEqual(
      finalMarket.accruedTradeTreasuryFeeLamports.toString(),
      totalFee.toString(),
    );
    assert.strictEqual(
      finalMarket.accruedTradeMarketMakerFeeLamports.toString(),
      totalFee.toString(),
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      makerCollateral + allExecutionCost + restingCollateral + totalFee * 2n,
      "generated continuation must reconcile every terminal-open liability",
    );

    for (const entry of canonicalOrders) {
      const filled = await clobProgram.account.order.fetch(entry.order);
      assert.strictEqual(filled.active, false);
      assert.strictEqual(filled.continuationPending, false);
      assert.strictEqual(filled.filled.toString(), entry.amount.toString());
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
      orderId: 61,
      side: SIDE_BID,
      price: takerPrice,
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
      "generated continuation cancellation did not restore the vault baseline",
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
    for (const price of PRICES) {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_ASK,
        price,
        rentRecipient: maker.publicKey,
        closer: authority,
      });
      assert.strictEqual(
        await clobProgram.account.priceLevel.fetchNullable(
          priceLevelAtPrice.get(price)!,
        ),
        null,
      );
    }
    await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_BID,
      price: takerPrice,
      rentRecipient: taker.publicKey,
      closer: authority,
    });
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(takerBid.restingLevel),
      null,
    );
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

  it("derives the reverse 50-fill graph for interleaved bids and an ask continuation", async () => {
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
        duelKey: uniqueDuelKey("generated-reverse-continuation"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = BigInt(
      await provider.connection.getBalance(market.vault),
    );
    const plan = buildInterleavedPlan(REVERSE_PLAN_SEED);
    assert.strictEqual(
      createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      REVERSE_PLAN_HASH,
      "reverse generated continuation plan drifted",
    );

    const makerOrders: MakerOrder[] = [];
    const lastOrderAtPrice = new Map<number, PublicKey>();
    const priceLevelAtPrice = new Map<number, PublicKey>();
    for (let offset = 0; offset < plan.length; offset += 1) {
      const orderId = offset + 1;
      const planned = plan[offset]!;
      const previousAtPrice = lastOrderAtPrice.get(planned.price);
      const placed = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
        orderId,
        side: SIDE_BID,
        price: planned.price,
        amount: planned.amount,
        orderBehavior: ORDER_BEHAVIOR_GTC,
        remainingAccounts: previousAtPrice
          ? [writableAccount(previousAtPrice)]
          : [],
      });
      makerOrders.push({ id: orderId, ...planned, ...placed });
      lastOrderAtPrice.set(planned.price, placed.order);
      priceLevelAtPrice.set(planned.price, placed.restingLevel);
    }

    const canonicalOrders = [...makerOrders].sort(
      (left, right) => right.price - left.price || left.id - right.id,
    );
    const firstPass = canonicalOrders.slice(0, 50);
    const secondPass = canonicalOrders.slice(50);
    const allAmount = sumAmount(canonicalOrders);
    const firstAmount = sumAmount(firstPass);
    const secondAmount = sumAmount(secondPass);
    const makerCollateral = sumSideCollateral(canonicalOrders, SIDE_BID);
    const firstMakerCollateral = sumSideCollateral(firstPass, SIDE_BID);
    const secondMakerCollateral = sumSideCollateral(secondPass, SIDE_BID);
    const allExecutionCost = sumSideCollateral(canonicalOrders, SIDE_ASK);
    const firstExecutionCost = sumSideCollateral(firstPass, SIDE_ASK);
    const secondExecutionCost = sumSideCollateral(secondPass, SIDE_ASK);
    assert.deepStrictEqual(
      {
        allAmount,
        allExecutionCost,
        firstAmount,
        firstExecutionCost,
        firstMakerCollateral,
        makerCollateral,
        secondAmount,
        secondExecutionCost,
        secondMakerCollateral,
      },
      {
        allAmount: 121_000n,
        allExecutionCost: 67_750n,
        firstAmount: 101_000n,
        firstExecutionCost: 50_250n,
        firstMakerCollateral: 50_750n,
        makerCollateral: 53_250n,
        secondAmount: 20_000n,
        secondExecutionCost: 17_500n,
        secondMakerCollateral: 2_500n,
      },
      "reverse generated canonical book totals drifted",
    );

    const initialMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(initialMarket.nextOrderId.toString(), "61");
    assert.strictEqual(Number(initialMarket.bestBid), 750);
    assert.strictEqual(Number(initialMarket.bestAsk), 1_000);
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      makerCollateral,
    );

    const takerPrice = 100;
    const restingRemainder = 4_000n;
    const takerAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 61,
      side: SIDE_ASK,
      price: takerPrice,
      amount: Number(allAmount + restingRemainder),
      orderBehavior: ORDER_BEHAVIOR_GTC,
      remainingAccounts: firstPass.flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]),
    });

    const firstFee = firstExecutionCost / 100n;
    const pendingAmount = secondAmount + restingRemainder;
    const pendingCollateral =
      (pendingAmount * BigInt(1_000 - takerPrice)) / 1_000n;
    const [afterFirstMarket, pendingOrder, makerAfterFirst, takerAfterFirst] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerAsk.order),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerAsk.userBalance),
      ]);
    assert.strictEqual(afterFirstMarket.nextOrderId.toString(), "62");
    assert.strictEqual(Number(afterFirstMarket.bestBid), 125);
    assert.strictEqual(Number(afterFirstMarket.bestAsk), 1_000);
    assert.strictEqual(pendingOrder.continuationPending, true);
    assert.strictEqual(
      pendingOrder.amount.toString(),
      pendingAmount.toString(),
    );
    assert.strictEqual(
      makerAfterFirst.aShares.toString(),
      firstAmount.toString(),
    );
    assert.strictEqual(
      makerAfterFirst.aLockedLamports.toString(),
      firstMakerCollateral.toString(),
    );
    assert.strictEqual(
      takerAfterFirst.bShares.toString(),
      firstAmount.toString(),
    );
    assert.strictEqual(
      takerAfterFirst.bLockedLamports.toString(),
      firstExecutionCost.toString(),
    );
    assert.strictEqual(
      afterFirstMarket.accruedTradeTreasuryFeeLamports.toString(),
      firstFee.toString(),
    );
    assert.strictEqual(
      afterFirstMarket.accruedTradeMarketMakerFeeLamports.toString(),
      firstFee.toString(),
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      makerCollateral + firstExecutionCost + pendingCollateral + firstFee * 2n,
      "reverse first pass must retain exact filled, pending, and fee liabilities",
    );

    await continueClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 61,
      side: SIDE_ASK,
      price: takerPrice,
      remainingAccounts: secondPass.flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]),
    });

    const secondFee = secondExecutionCost / 100n;
    const totalFee = firstFee + secondFee;
    const restingCollateral =
      (restingRemainder * BigInt(1_000 - takerPrice)) / 1_000n;
    const [finalMarket, restingAsk, askLevel, makerAfter, takerAfter] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetch(takerAsk.order),
        clobProgram.account.priceLevel.fetch(takerAsk.restingLevel),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerAsk.userBalance),
      ]);
    assert.strictEqual(Number(finalMarket.bestBid), 0);
    assert.strictEqual(Number(finalMarket.bestAsk), takerPrice);
    assert.strictEqual(restingAsk.continuationPending, false);
    assert.strictEqual(
      restingAsk.amount.toString(),
      restingRemainder.toString(),
    );
    assert.strictEqual(restingAsk.prevOrderId.toString(), "0");
    assert.strictEqual(restingAsk.nextOrderId.toString(), "0");
    assert.strictEqual(askLevel.headOrderId.toString(), "61");
    assert.strictEqual(askLevel.tailOrderId.toString(), "61");
    assert.strictEqual(
      askLevel.totalOpen.toString(),
      restingRemainder.toString(),
    );
    assert.strictEqual(makerAfter.aShares.toString(), allAmount.toString());
    assert.strictEqual(
      makerAfter.aLockedLamports.toString(),
      makerCollateral.toString(),
    );
    assert.strictEqual(takerAfter.bShares.toString(), allAmount.toString());
    assert.strictEqual(
      takerAfter.bLockedLamports.toString(),
      allExecutionCost.toString(),
    );
    assert.strictEqual(
      finalMarket.accruedTradeTreasuryFeeLamports.toString(),
      totalFee.toString(),
    );
    assert.strictEqual(
      finalMarket.accruedTradeMarketMakerFeeLamports.toString(),
      totalFee.toString(),
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      makerCollateral + allExecutionCost + restingCollateral + totalFee * 2n,
      "reverse continuation must reconcile every terminal-open liability",
    );

    for (const entry of canonicalOrders) {
      const filled = await clobProgram.account.order.fetch(entry.order);
      assert.strictEqual(filled.active, false);
      assert.strictEqual(filled.continuationPending, false);
      assert.strictEqual(filled.filled.toString(), entry.amount.toString());
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
      orderId: 61,
      side: SIDE_ASK,
      price: takerPrice,
    });
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(takerAsk.order),
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
      "reverse generated cancellation did not restore the vault baseline",
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
    for (const price of PRICES) {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_BID,
        price,
        rentRecipient: maker.publicKey,
        closer: authority,
      });
      assert.strictEqual(
        await clobProgram.account.priceLevel.fetchNullable(
          priceLevelAtPrice.get(price)!,
        ),
        null,
      );
    }
    await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_ASK,
      price: takerPrice,
      rentRecipient: taker.publicKey,
      closer: authority,
    });
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(takerAsk.restingLevel),
      null,
    );
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

  it("closes and refunds an IOC remainder at the 50-fill boundary without creating continuation state", async () => {
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
        duelKey: uniqueDuelKey("generated-ioc-boundary"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = BigInt(
      await provider.connection.getBalance(market.vault),
    );
    const plan = buildInterleavedPlan(FORWARD_PLAN_SEED);
    assert.strictEqual(
      createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      FORWARD_PLAN_HASH,
    );

    const makerOrders: MakerOrder[] = [];
    const lastOrderAtPrice = new Map<number, PublicKey>();
    const priceLevelAtPrice = new Map<number, PublicKey>();
    for (let offset = 0; offset < plan.length; offset += 1) {
      const orderId = offset + 1;
      const planned = plan[offset]!;
      const previousAtPrice = lastOrderAtPrice.get(planned.price);
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
        price: planned.price,
        amount: planned.amount,
        orderBehavior: ORDER_BEHAVIOR_GTC,
        remainingAccounts: previousAtPrice
          ? [writableAccount(previousAtPrice)]
          : [],
      });
      makerOrders.push({ id: orderId, ...planned, ...placed });
      lastOrderAtPrice.set(planned.price, placed.order);
      priceLevelAtPrice.set(planned.price, placed.restingLevel);
    }

    const canonicalOrders = [...makerOrders].sort(
      (left, right) => left.price - right.price || left.id - right.id,
    );
    const firstPass = canonicalOrders.slice(0, 50);
    const stillResting = canonicalOrders.slice(50);
    const firstAmount = sumAmount(firstPass);
    const stillRestingAmount = sumAmount(stillResting);
    const firstExecutionCost = sumSideCollateral(firstPass, SIDE_BID);
    const firstMakerCollateral = sumSideCollateral(firstPass, SIDE_ASK);
    const allMakerCollateral = sumSideCollateral(canonicalOrders, SIDE_ASK);
    assert.deepStrictEqual(
      {
        allMakerCollateral,
        firstAmount,
        firstExecutionCost,
        firstMakerCollateral,
        stillRestingAmount,
      },
      {
        allMakerCollateral: 70_125n,
        firstAmount: 106_000n,
        firstExecutionCost: 41_125n,
        firstMakerCollateral: 64_875n,
        stillRestingAmount: 21_000n,
      },
    );

    const takerPrice = 900;
    const requestedAmount = sumAmount(canonicalOrders) + 4_000n;
    const takerIoc = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
      orderId: 61,
      side: SIDE_BID,
      price: takerPrice,
      amount: Number(requestedAmount),
      orderBehavior: ORDER_BEHAVIOR_IOC,
      remainingAccounts: firstPass.flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]),
    });

    const firstFee = firstExecutionCost / 100n;
    const [afterIocMarket, makerAfterIoc, takerAfterIoc, remainingLevel] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.userBalance.fetch(makerOrders[0]!.userBalance),
        clobProgram.account.userBalance.fetch(takerIoc.userBalance),
        clobProgram.account.priceLevel.fetch(
          priceLevelAtPrice.get(stillResting[0]!.price)!,
        ),
      ]);
    assert.strictEqual(afterIocMarket.nextOrderId.toString(), "62");
    assert.strictEqual(Number(afterIocMarket.bestAsk), 750);
    assert.strictEqual(Number(afterIocMarket.bestBid), 0);
    assert.strictEqual(
      afterIocMarket.accruedTradeTreasuryFeeLamports.toString(),
      firstFee.toString(),
    );
    assert.strictEqual(
      afterIocMarket.accruedTradeMarketMakerFeeLamports.toString(),
      firstFee.toString(),
    );
    assert.strictEqual(
      makerAfterIoc.bShares.toString(),
      firstAmount.toString(),
    );
    assert.strictEqual(
      makerAfterIoc.bLockedLamports.toString(),
      firstMakerCollateral.toString(),
    );
    assert.strictEqual(
      takerAfterIoc.aShares.toString(),
      firstAmount.toString(),
    );
    assert.strictEqual(
      takerAfterIoc.aLockedLamports.toString(),
      firstExecutionCost.toString(),
    );
    assert.strictEqual(
      remainingLevel.headOrderId.toString(),
      stillResting[0]!.id.toString(),
    );
    assert.strictEqual(
      remainingLevel.tailOrderId.toString(),
      stillResting.at(-1)!.id.toString(),
    );
    assert.strictEqual(
      remainingLevel.totalOpen.toString(),
      stillRestingAmount.toString(),
    );
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(takerIoc.order),
      null,
      "IOC must close its order PDA instead of persisting continuation",
    );
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(takerIoc.restingLevel),
      null,
      "IOC must return its unused resting-level rent immediately",
    );
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(market.vault)) -
        vaultBaseline,
      allMakerCollateral + firstExecutionCost + firstFee * 2n,
      "IOC must refund its complete unmatched limit collateral at the boundary",
    );

    for (const entry of firstPass) {
      const filled = await clobProgram.account.order.fetch(entry.order);
      assert.strictEqual(filled.active, false);
      assert.strictEqual(filled.continuationPending, false);
      assert.strictEqual(filled.filled.toString(), entry.amount.toString());
    }
    for (const entry of stillResting) {
      const resting = await clobProgram.account.order.fetch(entry.order);
      assert.strictEqual(resting.active, true);
      assert.strictEqual(resting.continuationPending, false);
      assert.strictEqual(resting.filled.toString(), "0");
    }

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    for (let index = 0; index < stillResting.length; index += 1) {
      const entry = stillResting[index]!;
      const next = stillResting[index + 1];
      await reclaimClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        vault: market.vault,
        user: maker,
        orderId: entry.id,
        side: SIDE_ASK,
        price: entry.price,
        remainingAccounts: next ? [writableAccount(next.order)] : [],
      });
      assert.strictEqual(
        await clobProgram.account.order.fetchNullable(entry.order),
        null,
        "terminal reclaim must return order rent and close the maker PDA",
      );
      if (next) {
        const normalizedNext = await clobProgram.account.order.fetch(
          next.order,
        );
        assert.strictEqual(normalizedNext.prevOrderId.toString(), "0");
      }
    }
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
      "IOC boundary cancellation did not restore the vault baseline",
    );

    for (const entry of firstPass) {
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
    for (const price of PRICES) {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_ASK,
        price,
        rentRecipient: maker.publicKey,
        closer: authority,
      });
      assert.strictEqual(
        await clobProgram.account.priceLevel.fetchNullable(
          priceLevelAtPrice.get(price)!,
        ),
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
