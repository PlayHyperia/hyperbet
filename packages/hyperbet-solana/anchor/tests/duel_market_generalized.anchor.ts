import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ORDER_BEHAVIOR_GTC,
  ORDER_BEHAVIOR_IOC,
  ORDER_BEHAVIOR_POST_ONLY,
  SIDE_ASK,
  SIDE_BID,
  airdrop,
  cancelClobOrder,
  cancelDuel,
  claimClobWinnings,
  closeEmptyClobPriceLevel,
  closeEmptyClobUserBalance,
  closeFilledClobOrder,
  createOpenMarketFixture,
  deriveOrderPda,
  derivePriceLevelPda,
  deriveUserBalancePda,
  hasProgramError,
  placeClobOrder,
  reclaimClobOrder,
  syncMarketFromDuel,
  uniqueDuelKey,
  writableAccount,
} from "./clob-test-helpers";
import {
  GeneratedRandomTape,
  parseGeneratedCorpus,
  parseGeneratedFailureArtifact,
  promoteGeneratedFailure,
  randomWordsForCase,
  shrinkFailingSequence,
  stableFailureFingerprint,
} from "./generated-state-machine-replay";
import { configureAnchorTests } from "./test-anchor";
import { DuelMarket } from "../target/types/duel_market";
import { FightOracle } from "../target/types/fight_oracle";

const generalizedCorpusJson: unknown = JSON.parse(
  readFileSync("tests/fixtures/duel-market-generalized-corpus.json", "utf8"),
);

configureAnchorTests();

const GENERALIZED_PRICES = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const TRADE_FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;

type Side = 1 | 2;
type OrderBehavior = 0 | 1 | 2;

type ModelOrder = {
  id: number;
  makerIndex: number;
  side: Side;
  price: number;
  amount: bigint;
  filled: bigint;
  previousOrderId: number;
  nextOrderId: number;
  active: boolean;
  orderBehavior: OrderBehavior;
};

type ModelLevel = {
  side: Side;
  price: number;
  rentRecipientIndex: number;
  queue: number[];
};

type ModelBalance = {
  open: boolean;
  aShares: bigint;
  bShares: bigint;
  aLockedLamports: bigint;
  bLockedLamports: bigint;
  tradeTreasuryFeeLamports: bigint;
  tradeMarketMakerFeeLamports: bigint;
};

type MatchStep = {
  orderId: number;
  fill: bigint;
  makerRemainingBefore: bigint;
};

type Coverage = {
  attemptedPlacements: number;
  successfulPlacements: number;
  cancellations: number;
  gtcPlacements: number;
  iocPlacements: number;
  postOnlyAccepted: number;
  postOnlyRejected: number;
  fills: number;
  partialFills: number;
  multiFillTransactions: number;
  crossedPriceLevels: number;
  maxCrossedPriceLevels: number;
  iocRefunds: number;
  distinctPrices: Set<number>;
  peakActivePriceLevels: number;
  reclaims: number;
  claims: number;
  emptyBalanceClosures: number;
  filledOrderClosures: number;
  priceLevelClosures: number;
};

class GeneralizedStateMachineExecutionError extends Error {
  readonly failureFingerprint: string;
  readonly actionTrace: string[];
  readonly randomWordsConsumed: number;

  constructor(
    caseId: string,
    sourceSeed: string,
    randomWordsConsumed: number,
    actionTrace: readonly string[],
    cause: unknown,
  ) {
    const causeText =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    super(
      `generalized generated state machine failed for ${caseId} seed=${sourceSeed} word=${randomWordsConsumed}; trace=${actionTrace.join(" -> ")}\n${causeText}`,
    );
    this.name = "GeneralizedStateMachineExecutionError";
    this.failureFingerprint = stableFailureFingerprint(cause);
    this.actionTrace = [...actionTrace];
    this.randomWordsConsumed = randomWordsConsumed;
  }
}

const positiveShrinkSetting = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
};

const replayOpenActionCount = (
  error: GeneralizedStateMachineExecutionError | null,
  fallback: number,
): number => {
  const tracedOpenActions =
    error?.actionTrace.filter(
      (action) =>
        action.startsWith("place:") ||
        action.startsWith("post-only-reject:") ||
        action.startsWith("cancel:"),
    ).length ?? 0;
  return Math.max(1, Math.min(fallback, tracedOpenActions || fallback));
};

const isCoverageAdmissionFailure = (fingerprint: string): boolean =>
  /insufficient generalized|generalized sequence never|generalized terminal path had no/.test(
    fingerprint,
  );

describe("duel_market generalized mixed-price generated state machine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const fightProgram = anchor.workspace.FightOracle as Program<FightOracle>;
  const clobProgram = anchor.workspace.DuelMarket as Program<DuelMarket>;
  const authority = (provider.wallet as anchor.Wallet & { payer: Keypair })
    .payer;
  const generalizedCorpus = parseGeneratedCorpus(generalizedCorpusJson);

  for (const generatedCase of generalizedCorpus.cases) {
    const sourceSeed =
      generatedCase.kind === "seed"
        ? generatedCase.seed
        : generatedCase.sourceSeed;

    const executeGeneralizedStateMachine = async (
      randomWords: readonly number[],
      enforceCoverage: boolean,
      options: { injectFailureAfterOpenStep?: number } = {},
    ): Promise<void> => {
      const actionTrace: string[] = [];
      const randomTape = new GeneratedRandomTape(randomWords);

      try {
        const participants = Array.from({ length: 12 }, () =>
          Keypair.generate(),
        );
        await Promise.all(
          participants.map((participant) =>
            airdrop(provider.connection, participant.publicKey, 3),
          ),
        );
        const market = await createOpenMarketFixture(
          fightProgram,
          clobProgram,
          authority,
          {
            duelKey: uniqueDuelKey(
              `generalized-mixed-state-${generatedCase.id}`,
            ),
            tradeTreasuryFeeBps: Number(TRADE_FEE_BPS),
            tradeMarketMakerFeeBps: Number(TRADE_FEE_BPS),
            winningsMarketMakerFeeBps: 200,
          },
        );
        const vaultBaseline = BigInt(
          await provider.connection.getBalance(market.vault),
        );
        const orders = new Map<number, ModelOrder>();
        const levels = new Map<string, ModelLevel>();
        const touchedLevels = new Map<string, { side: Side; price: number }>();
        const balances = new Map<number, ModelBalance>();
        let nextOrderId = 1;
        let accruedTreasuryFees = 0n;
        let accruedMarketMakerFees = 0n;
        const coverage: Coverage = {
          attemptedPlacements: 0,
          successfulPlacements: 0,
          cancellations: 0,
          gtcPlacements: 0,
          iocPlacements: 0,
          postOnlyAccepted: 0,
          postOnlyRejected: 0,
          fills: 0,
          partialFills: 0,
          multiFillTransactions: 0,
          crossedPriceLevels: 0,
          maxCrossedPriceLevels: 0,
          iocRefunds: 0,
          distinctPrices: new Set<number>(),
          peakActivePriceLevels: 0,
          reclaims: 0,
          claims: 0,
          emptyBalanceClosures: 0,
          filledOrderClosures: 0,
          priceLevelClosures: 0,
        };

        const random = (limit: number): number => randomTape.take(limit);
        const levelKey = (side: Side, price: number): string =>
          `${side}:${price}`;
        const oppositeSide = (side: Side): Side =>
          side === SIDE_BID ? SIDE_ASK : SIDE_BID;
        const quote = (side: Side, price: number, amount: bigint): bigint =>
          (amount * BigInt(side === SIDE_BID ? price : 1_000 - price)) / 1_000n;
        const tradeFee = (executedCost: bigint): bigint =>
          (executedCost * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        const remainingFor = (order: ModelOrder): bigint =>
          order.amount - order.filled;
        const activeOrders = (): ModelOrder[] =>
          [...orders.values()].filter((order) => order.active);
        const activePrices = (side: Side): number[] =>
          [...levels.values()]
            .filter((level) => level.side === side && level.queue.length > 0)
            .map((level) => level.price)
            .sort((left, right) => left - right);
        const priceCrosses = (
          side: Side,
          limitPrice: number,
          opposingPrice: number,
        ): boolean =>
          side === SIDE_BID
            ? limitPrice >= opposingPrice
            : limitPrice <= opposingPrice;
        const balanceFor = (participantIndex: number): ModelBalance => {
          const existing = balances.get(participantIndex);
          if (existing) return existing;
          const created: ModelBalance = {
            open: true,
            aShares: 0n,
            bShares: 0n,
            aLockedLamports: 0n,
            bLockedLamports: 0n,
            tradeTreasuryFeeLamports: 0n,
            tradeMarketMakerFeeLamports: 0n,
          };
          balances.set(participantIndex, created);
          return created;
        };
        const expectedVaultLiability = (): bigint => {
          const resting = [...orders.values()].reduce(
            (sum, order) =>
              sum +
              (order.active
                ? quote(order.side, order.price, remainingFor(order))
                : 0n),
            0n,
          );
          const matchedAndFees = [...balances.values()].reduce(
            (sum, balance) =>
              sum +
              (balance.open
                ? balance.aLockedLamports +
                  balance.bLockedLamports +
                  balance.tradeTreasuryFeeLamports +
                  balance.tradeMarketMakerFeeLamports
                : 0n),
            0n,
          );
          return resting + matchedAndFees;
        };
        const bitmapPrices = (bitmap: readonly anchor.BN[]): number[] => {
          const prices: number[] = [];
          for (let price = 1; price < 1_000; price += 1) {
            const word = BigInt(bitmap[Math.floor(price / 64)]!.toString());
            if ((word & (1n << BigInt(price % 64))) !== 0n) {
              prices.push(price);
            }
          }
          return prices;
        };
        const generatedLabel = (label: string): string =>
          `case=${generatedCase.id} seed=${sourceSeed} word=${randomTape.consumed} ${label}; trace=${actionTrace.join(" -> ")}`;
        const maybeInjectFailure = (step: number): void => {
          if (options.injectFailureAfterOpenStep === step) {
            throw new Error(
              `injected generalized shrink proof at open step ${step}`,
            );
          }
        };

        const applyFill = (
          makerOrder: ModelOrder,
          takerIndex: number,
          takerSide: Side,
          fill: bigint,
        ): void => {
          const makerBalance = balanceFor(makerOrder.makerIndex);
          const takerBalance = balanceFor(takerIndex);
          const makerLocked = quote(makerOrder.side, makerOrder.price, fill);
          const takerLocked = quote(takerSide, makerOrder.price, fill);
          if (makerOrder.side === SIDE_BID) {
            makerBalance.aShares += fill;
            makerBalance.aLockedLamports += makerLocked;
            takerBalance.bShares += fill;
            takerBalance.bLockedLamports += takerLocked;
          } else {
            makerBalance.bShares += fill;
            makerBalance.bLockedLamports += makerLocked;
            takerBalance.aShares += fill;
            takerBalance.aLockedLamports += takerLocked;
          }
        };

        const assertModel = async (
          expectedStatus: "open" | "cancelled",
          label: string,
        ): Promise<void> => {
          const [marketState, vaultLamports] = await Promise.all([
            clobProgram.account.marketState.fetch(market.marketState),
            provider.connection.getBalance(market.vault),
          ]);
          const expectedBids = activePrices(SIDE_BID);
          const expectedAsks = activePrices(SIDE_ASK);
          assert.deepStrictEqual(
            marketState.status,
            { [expectedStatus]: {} },
            `${label}: lifecycle drift`,
          );
          assert.strictEqual(
            marketState.nextOrderId.toString(),
            String(nextOrderId),
            `${label}: next order ID drift`,
          );
          assert.deepStrictEqual(
            bitmapPrices(marketState.bidBitmap),
            expectedBids,
            `${label}: bid bitmap drift`,
          );
          assert.deepStrictEqual(
            bitmapPrices(marketState.askBitmap),
            expectedAsks,
            `${label}: ask bitmap drift`,
          );
          assert.strictEqual(
            Number(marketState.bestBid),
            expectedBids.at(-1) ?? 0,
            `${label}: best bid drift`,
          );
          assert.strictEqual(
            Number(marketState.bestAsk),
            expectedAsks[0] ?? 1_000,
            `${label}: best ask drift`,
          );
          assert.strictEqual(
            marketState.accruedTradeTreasuryFeeLamports.toString(),
            accruedTreasuryFees.toString(),
            `${label}: treasury fee escrow drift`,
          );
          assert.strictEqual(
            marketState.accruedTradeMarketMakerFeeLamports.toString(),
            accruedMarketMakerFees.toString(),
            `${label}: market-maker fee escrow drift`,
          );
          assert.strictEqual(
            BigInt(vaultLamports) - vaultBaseline,
            expectedVaultLiability(),
            `${label}: generalized vault liability drift`,
          );

          const touchedLevelEntries = [...touchedLevels.values()];
          const chainLevels =
            touchedLevelEntries.length === 0
              ? []
              : await clobProgram.account.priceLevel.fetchMultiple(
                  touchedLevelEntries.map(({ side, price }) =>
                    derivePriceLevelPda(
                      clobProgram.programId,
                      market.marketState,
                      side,
                      price,
                    ),
                  ),
                );
          chainLevels.forEach((chainLevel, index) => {
            const touched = touchedLevelEntries[index]!;
            const expected = levels.get(levelKey(touched.side, touched.price));
            if (!expected) {
              assert.strictEqual(
                chainLevel,
                null,
                `${label}: transient/closed level ${touched.side}:${touched.price} still exists`,
              );
              return;
            }
            assert.ok(
              chainLevel,
              `${label}: level ${touched.side}:${touched.price} disappeared`,
            );
            assert.ok(
              (chainLevel.marketState as anchor.web3.PublicKey).equals(
                market.marketState,
              ),
              `${label}: level market drift`,
            );
            assert.strictEqual(Number(chainLevel.side), expected.side);
            assert.strictEqual(Number(chainLevel.price), expected.price);
            assert.ok(
              (chainLevel.rentRecipient as anchor.web3.PublicKey).equals(
                participants[expected.rentRecipientIndex]!.publicKey,
              ),
              `${label}: level rent recipient drift`,
            );
            assert.strictEqual(
              chainLevel.headOrderId.toString(),
              String(expected.queue[0] ?? 0),
              `${label}: level head drift`,
            );
            assert.strictEqual(
              chainLevel.tailOrderId.toString(),
              String(expected.queue.at(-1) ?? 0),
              `${label}: level tail drift`,
            );
            const expectedTotal = expected.queue.reduce(
              (sum, orderId) => sum + remainingFor(orders.get(orderId)!),
              0n,
            );
            assert.strictEqual(
              chainLevel.totalOpen.toString(),
              expectedTotal.toString(),
              `${label}: level total drift`,
            );
          });

          const orderPdas = Array.from(
            { length: nextOrderId - 1 },
            (_, index) =>
              deriveOrderPda(
                clobProgram.programId,
                market.marketState,
                index + 1,
              ),
          );
          const chainOrders =
            orderPdas.length === 0
              ? []
              : await clobProgram.account.order.fetchMultiple(orderPdas);
          chainOrders.forEach((chainOrder, index) => {
            const orderId = index + 1;
            const expected = orders.get(orderId);
            if (!expected) {
              assert.strictEqual(
                chainOrder,
                null,
                `${label}: transient/closed order ${orderId} still exists`,
              );
              return;
            }
            assert.ok(chainOrder, `${label}: order ${orderId} disappeared`);
            assert.ok(
              (chainOrder.marketState as anchor.web3.PublicKey).equals(
                market.marketState,
              ),
              `${label}: order market drift`,
            );
            assert.strictEqual(chainOrder.id.toString(), String(expected.id));
            assert.ok(
              (chainOrder.maker as anchor.web3.PublicKey).equals(
                participants[expected.makerIndex]!.publicKey,
              ),
              `${label}: order maker drift`,
            );
            assert.strictEqual(Number(chainOrder.side), expected.side);
            assert.strictEqual(Number(chainOrder.price), expected.price);
            assert.strictEqual(
              chainOrder.amount.toString(),
              expected.amount.toString(),
            );
            assert.strictEqual(
              chainOrder.filled.toString(),
              expected.filled.toString(),
            );
            assert.strictEqual(
              chainOrder.prevOrderId.toString(),
              String(expected.previousOrderId),
              `${label}: order ${orderId} previous link drift`,
            );
            assert.strictEqual(
              chainOrder.nextOrderId.toString(),
              String(expected.nextOrderId),
              `${label}: order ${orderId} next link drift`,
            );
            assert.strictEqual(chainOrder.active, expected.active);
            assert.strictEqual(
              Number(chainOrder.orderBehavior),
              expected.orderBehavior,
            );
            assert.strictEqual(chainOrder.continuationPending, false);
          });

          const balancePdas = participants.map((participant) =>
            deriveUserBalancePda(
              clobProgram.programId,
              market.marketState,
              participant.publicKey,
            ),
          );
          const chainBalances =
            await clobProgram.account.userBalance.fetchMultiple(balancePdas);
          chainBalances.forEach((chainBalance, participantIndex) => {
            const expected = balances.get(participantIndex);
            if (!expected || !expected.open) {
              assert.strictEqual(
                chainBalance,
                null,
                `${label}: closed balance ${participantIndex} still exists`,
              );
              return;
            }
            assert.ok(
              chainBalance,
              `${label}: balance ${participantIndex} disappeared`,
            );
            assert.ok(
              (chainBalance.marketState as anchor.web3.PublicKey).equals(
                market.marketState,
              ),
              `${label}: balance market drift`,
            );
            assert.ok(
              (chainBalance.user as anchor.web3.PublicKey).equals(
                participants[participantIndex]!.publicKey,
              ),
              `${label}: balance user drift`,
            );
            for (const field of [
              "aShares",
              "bShares",
              "aLockedLamports",
              "bLockedLamports",
              "tradeTreasuryFeeLamports",
              "tradeMarketMakerFeeLamports",
            ] as const) {
              assert.strictEqual(
                chainBalance[field].toString(),
                expected[field].toString(),
                `${label}: balance ${participantIndex} ${field} drift`,
              );
            }
          });
        };

        const cancelOrReclaimRemainingAccounts = (
          level: ModelLevel,
          queueIndex: number,
        ): anchor.web3.AccountMeta[] => {
          const selected = orders.get(level.queue[queueIndex]!)!;
          const previousOrderId =
            queueIndex === 0 ? 0 : selected.previousOrderId;
          const nextOrderId = selected.nextOrderId;
          return [previousOrderId, nextOrderId]
            .filter((orderId) => orderId !== 0)
            .map((orderId) =>
              writableAccount(
                deriveOrderPda(
                  clobProgram.programId,
                  market.marketState,
                  orderId,
                ),
              ),
            );
        };

        const removeActiveOrder = (
          level: ModelLevel,
          queueIndex: number,
        ): ModelOrder => {
          const selectedId = level.queue[queueIndex]!;
          const selected = orders.get(selectedId)!;
          const previousOrderId =
            queueIndex === 0 ? 0 : selected.previousOrderId;
          const nextOrderId = selected.nextOrderId;
          if (previousOrderId !== 0) {
            orders.get(previousOrderId)!.nextOrderId = nextOrderId;
          }
          if (nextOrderId !== 0) {
            orders.get(nextOrderId)!.previousOrderId = previousOrderId;
          }
          level.queue.splice(queueIndex, 1);
          orders.delete(selectedId);
          return selected;
        };

        for (let step = 0; step < generatedCase.openActionCount; step += 1) {
          const cancellableOrders = activeOrders();
          if (cancellableOrders.length > 1 && random(100) < 20) {
            const selected =
              cancellableOrders[random(cancellableOrders.length)]!;
            const level = levels.get(levelKey(selected.side, selected.price))!;
            const queueIndex = level.queue.indexOf(selected.id);
            assert.notStrictEqual(queueIndex, -1);
            actionTrace.push(
              `cancel:${selected.id}:${selected.side}:${selected.price}:${queueIndex}`,
            );
            await cancelClobOrder(clobProgram, {
              marketState: market.marketState,
              duelState: market.duelState,
              vault: market.vault,
              user: participants[selected.makerIndex]!,
              orderId: selected.id,
              side: selected.side,
              price: selected.price,
              remainingAccounts: cancelOrReclaimRemainingAccounts(
                level,
                queueIndex,
              ),
            });
            removeActiveOrder(level, queueIndex);
            coverage.cancellations += 1;
            await assertModel(
              "open",
              generatedLabel(`generalized cancel ${step}`),
            );
            maybeInjectFailure(step);
            continue;
          }

          const behaviorRoll = random(100);
          const orderBehavior: OrderBehavior =
            behaviorRoll < 20
              ? ORDER_BEHAVIOR_IOC
              : behaviorRoll < 40
                ? ORDER_BEHAVIOR_POST_ONLY
                : ORDER_BEHAVIOR_GTC;
          const side: Side = random(2) === 0 ? SIDE_BID : SIDE_ASK;
          const priceIndex = random(GENERALIZED_PRICES.length);
          const price = GENERALIZED_PRICES[priceIndex]!;
          const amountLots = random(5) + 1;
          const amount = BigInt(amountLots * 1_000);
          const orderId = nextOrderId;
          const opposingSide = oppositeSide(side);
          const crossingPrices = activePrices(opposingSide)
            .filter((opposingPrice) => priceCrosses(side, price, opposingPrice))
            .sort((left, right) =>
              side === SIDE_BID ? left - right : right - left,
            );
          const wouldCross = crossingPrices.length > 0;
          const matchSteps: MatchStep[] = [];
          const crossedPriceSet = new Set<number>();
          let remaining = amount;
          let executedCost = 0n;
          for (const crossingPrice of crossingPrices) {
            const level = levels.get(levelKey(opposingSide, crossingPrice))!;
            for (const makerOrderId of level.queue) {
              if (remaining === 0n) break;
              const makerOrder = orders.get(makerOrderId)!;
              const makerRemaining = remainingFor(makerOrder);
              const fill =
                remaining < makerRemaining ? remaining : makerRemaining;
              matchSteps.push({
                orderId: makerOrderId,
                fill,
                makerRemainingBefore: makerRemaining,
              });
              crossedPriceSet.add(crossingPrice);
              remaining -= fill;
              executedCost += quote(side, crossingPrice, fill);
            }
            if (remaining === 0n) break;
          }
          const crossedMakerIndices = new Set(
            matchSteps.map(
              ({ orderId: makerOrderId }) =>
                orders.get(makerOrderId)!.makerIndex,
            ),
          );
          const makerStart =
            (step + priceIndex + amountLots) % participants.length;
          let makerIndex = makerStart;
          while (crossedMakerIndices.has(makerIndex)) {
            makerIndex = (makerIndex + 1) % participants.length;
            assert.notStrictEqual(
              makerIndex,
              makerStart,
              "all generalized participants are opposing makers",
            );
          }
          const user = participants[makerIndex]!;
          const touchedKey = levelKey(side, price);
          touchedLevels.set(touchedKey, { side, price });
          coverage.attemptedPlacements += 1;
          coverage.distinctPrices.add(price);

          if (orderBehavior === ORDER_BEHAVIOR_POST_ONLY && wouldCross) {
            actionTrace.push(
              `post-only-reject:${orderId}:${side}:${price}:${amount}`,
            );
            const hadBalance = balances.has(makerIndex);
            const hadLevel = levels.has(touchedKey);
            try {
              await placeClobOrder(clobProgram, {
                marketState: market.marketState,
                duelState: market.duelState,
                config: market.config,
                treasury: market.treasury,
                marketMaker: market.marketMaker,
                vault: market.vault,
                user,
                orderId,
                side,
                price,
                amount,
                orderBehavior,
              });
              assert.fail("generalized crossing post-only order succeeded");
            } catch (error) {
              assert.ok(
                hasProgramError(error, "PostOnlyWouldCross"),
                `expected PostOnlyWouldCross, got ${String(error)}`,
              );
            }
            const [wouldBeOrder, wouldBeBalance, wouldBeLevel] =
              await Promise.all([
                clobProgram.account.order.fetchNullable(
                  deriveOrderPda(
                    clobProgram.programId,
                    market.marketState,
                    orderId,
                  ),
                ),
                hadBalance
                  ? Promise.resolve(null)
                  : clobProgram.account.userBalance.fetchNullable(
                      deriveUserBalancePda(
                        clobProgram.programId,
                        market.marketState,
                        user.publicKey,
                      ),
                    ),
                hadLevel
                  ? Promise.resolve(null)
                  : clobProgram.account.priceLevel.fetchNullable(
                      derivePriceLevelPda(
                        clobProgram.programId,
                        market.marketState,
                        side,
                        price,
                      ),
                    ),
              ]);
            assert.strictEqual(wouldBeOrder, null);
            if (!hadBalance) assert.strictEqual(wouldBeBalance, null);
            if (!hadLevel) assert.strictEqual(wouldBeLevel, null);
            coverage.postOnlyRejected += 1;
            await assertModel(
              "open",
              generatedLabel(`generalized post-only rollback ${step}`),
            );
            maybeInjectFailure(step);
            continue;
          }

          const shouldRest =
            remaining > 0n && orderBehavior !== ORDER_BEHAVIOR_IOC;
          const sameSideLevel = levels.get(touchedKey);
          const tailOrderId = sameSideLevel?.queue.at(-1) ?? 0;
          const remainingAccounts = matchSteps.flatMap(
            ({ orderId: makerOrderId }) => {
              const makerOrder = orders.get(makerOrderId)!;
              return [
                writableAccount(
                  derivePriceLevelPda(
                    clobProgram.programId,
                    market.marketState,
                    makerOrder.side,
                    makerOrder.price,
                  ),
                ),
                writableAccount(
                  deriveOrderPda(
                    clobProgram.programId,
                    market.marketState,
                    makerOrder.id,
                  ),
                ),
                writableAccount(
                  deriveUserBalancePda(
                    clobProgram.programId,
                    market.marketState,
                    participants[makerOrder.makerIndex]!.publicKey,
                  ),
                ),
              ];
            },
          );
          if (shouldRest && tailOrderId !== 0) {
            remainingAccounts.push(
              writableAccount(
                deriveOrderPda(
                  clobProgram.programId,
                  market.marketState,
                  tailOrderId,
                ),
              ),
            );
          }

          actionTrace.push(
            `place:${orderId}:${side}:${price}:${amount}:${orderBehavior}:${makerIndex}:${matchSteps.length}:${remaining}`,
          );
          await placeClobOrder(clobProgram, {
            marketState: market.marketState,
            duelState: market.duelState,
            config: market.config,
            treasury: market.treasury,
            marketMaker: market.marketMaker,
            vault: market.vault,
            user,
            orderId,
            side,
            price,
            amount,
            orderBehavior,
            remainingAccounts,
          });
          nextOrderId += 1;
          balanceFor(makerIndex);
          coverage.successfulPlacements += 1;
          if (orderBehavior === ORDER_BEHAVIOR_GTC) {
            coverage.gtcPlacements += 1;
          } else if (orderBehavior === ORDER_BEHAVIOR_IOC) {
            coverage.iocPlacements += 1;
            if (remaining > 0n) coverage.iocRefunds += 1;
          } else {
            coverage.postOnlyAccepted += 1;
          }
          coverage.fills += matchSteps.length;
          coverage.partialFills += matchSteps.filter(
            ({ fill, makerRemainingBefore }) => fill < makerRemainingBefore,
          ).length;
          if (matchSteps.length > 1) coverage.multiFillTransactions += 1;
          coverage.crossedPriceLevels += crossedPriceSet.size;
          coverage.maxCrossedPriceLevels = Math.max(
            coverage.maxCrossedPriceLevels,
            crossedPriceSet.size,
          );

          for (const matchStep of matchSteps) {
            const makerOrder = orders.get(matchStep.orderId)!;
            const makerLevel = levels.get(
              levelKey(makerOrder.side, makerOrder.price),
            )!;
            assert.strictEqual(makerLevel.queue[0], makerOrder.id);
            makerOrder.filled += matchStep.fill;
            applyFill(makerOrder, makerIndex, side, matchStep.fill);
            if (makerOrder.filled === makerOrder.amount) {
              makerLevel.queue.shift();
              makerOrder.active = false;
              makerOrder.previousOrderId = 0;
              makerOrder.nextOrderId = 0;
            }
          }
          if (executedCost > 0n) {
            const fee = tradeFee(executedCost);
            const takerBalance = balanceFor(makerIndex);
            takerBalance.tradeTreasuryFeeLamports += fee;
            takerBalance.tradeMarketMakerFeeLamports += fee;
            accruedTreasuryFees += fee;
            accruedMarketMakerFees += fee;
          }
          if (shouldRest) {
            let restingLevel = levels.get(touchedKey);
            if (!restingLevel) {
              restingLevel = {
                side,
                price,
                rentRecipientIndex: makerIndex,
                queue: [],
              };
              levels.set(touchedKey, restingLevel);
            }
            const previousOrderId = restingLevel.queue.at(-1) ?? 0;
            if (previousOrderId !== 0) {
              orders.get(previousOrderId)!.nextOrderId = orderId;
            }
            orders.set(orderId, {
              id: orderId,
              makerIndex,
              side,
              price,
              amount: remaining,
              filled: 0n,
              previousOrderId,
              nextOrderId: 0,
              active: true,
              orderBehavior,
            });
            restingLevel.queue.push(orderId);
          }
          coverage.peakActivePriceLevels = Math.max(
            coverage.peakActivePriceLevels,
            [...levels.values()].filter((level) => level.queue.length > 0)
              .length,
          );
          await assertModel(
            "open",
            generatedLabel(`generalized place ${step}`),
          );
          maybeInjectFailure(step);
        }

        if (enforceCoverage) {
          assert.ok(
            coverage.successfulPlacements >= 21,
            "insufficient generalized successful placements",
          );
          assert.ok(
            coverage.cancellations >= 3,
            "insufficient generalized cancellations",
          );
          assert.ok(
            coverage.gtcPlacements >= 9,
            "insufficient generalized GTC placements",
          );
          assert.ok(
            coverage.iocPlacements >= 3,
            "insufficient generalized IOC placements",
          );
          assert.ok(
            coverage.postOnlyAccepted >= 3,
            "insufficient generalized accepted post-only placements",
          );
          assert.ok(
            coverage.postOnlyRejected >= 1,
            "generalized sequence never rejected a crossing post-only order",
          );
          assert.ok(coverage.fills >= 7, "insufficient generalized fills");
          assert.ok(
            coverage.partialFills >= 2,
            "insufficient generalized partial fills",
          );
          assert.ok(
            coverage.multiFillTransactions >= 1,
            "generalized sequence never crossed multiple maker orders",
          );
          assert.ok(
            coverage.maxCrossedPriceLevels >= 2,
            "generalized sequence never crossed multiple price levels",
          );
          assert.ok(
            coverage.iocRefunds >= 2,
            "insufficient generalized IOC remainder refunds",
          );
          assert.ok(
            coverage.distinctPrices.size >= 7,
            "insufficient generalized price discovery",
          );
          assert.ok(
            coverage.peakActivePriceLevels >= 3,
            "insufficient generalized simultaneous price levels",
          );
        }

        actionTrace.push("cancel-duel");
        await cancelDuel(fightProgram, authority, market.duelKey);
        actionTrace.push("sync-cancelled-market");
        await syncMarketFromDuel(
          clobProgram,
          market.marketState,
          market.duelState,
        );
        await assertModel(
          "cancelled",
          generatedLabel("generalized cancellation"),
        );

        while (activeOrders().length > 0) {
          const candidates = activeOrders();
          const selected = candidates[random(candidates.length)]!;
          const level = levels.get(levelKey(selected.side, selected.price))!;
          const queueIndex = level.queue.indexOf(selected.id);
          assert.notStrictEqual(queueIndex, -1);
          actionTrace.push(
            `reclaim:${selected.id}:${selected.side}:${selected.price}:${queueIndex}`,
          );
          await reclaimClobOrder(clobProgram, {
            marketState: market.marketState,
            duelState: market.duelState,
            vault: market.vault,
            user: participants[selected.makerIndex]!,
            orderId: selected.id,
            side: selected.side,
            price: selected.price,
            remainingAccounts: cancelOrReclaimRemainingAccounts(
              level,
              queueIndex,
            ),
          });
          removeActiveOrder(level, queueIndex);
          coverage.reclaims += 1;
          await assertModel(
            "cancelled",
            generatedLabel(`generalized reclaim ${selected.id}`),
          );
        }

        for (const [participantIndex, balance] of balances) {
          const custody =
            balance.aLockedLamports +
            balance.bLockedLamports +
            balance.tradeTreasuryFeeLamports +
            balance.tradeMarketMakerFeeLamports;
          if (custody > 0n) {
            actionTrace.push(`claim:${participantIndex}:${custody}`);
            await claimClobWinnings(clobProgram, {
              marketState: market.marketState,
              duelState: market.duelState,
              config: market.config,
              marketMaker: market.marketMaker,
              vault: market.vault,
              user: participants[participantIndex]!,
            });
            accruedTreasuryFees -= balance.tradeTreasuryFeeLamports;
            accruedMarketMakerFees -= balance.tradeMarketMakerFeeLamports;
            coverage.claims += 1;
          } else {
            actionTrace.push(`close-empty-balance:${participantIndex}`);
            await closeEmptyClobUserBalance(clobProgram, {
              marketState: market.marketState,
              user: participants[participantIndex]!,
            });
            coverage.emptyBalanceClosures += 1;
          }
          balance.open = false;
          balance.aShares = 0n;
          balance.bShares = 0n;
          balance.aLockedLamports = 0n;
          balance.bLockedLamports = 0n;
          balance.tradeTreasuryFeeLamports = 0n;
          balance.tradeMarketMakerFeeLamports = 0n;
          await assertModel(
            "cancelled",
            generatedLabel(`generalized balance cleanup ${participantIndex}`),
          );
        }

        for (const [orderId, order] of [...orders]) {
          assert.strictEqual(order.active, false);
          assert.strictEqual(order.filled, order.amount);
          actionTrace.push(`close-filled-order:${orderId}`);
          await closeFilledClobOrder(clobProgram, {
            marketState: market.marketState,
            user: participants[order.makerIndex]!,
            orderId,
          });
          orders.delete(orderId);
          coverage.filledOrderClosures += 1;
        }
        for (const [key, level] of [...levels]) {
          assert.strictEqual(level.queue.length, 0);
          actionTrace.push(`close-empty-level:${level.side}:${level.price}`);
          await closeEmptyClobPriceLevel(clobProgram, {
            marketState: market.marketState,
            side: level.side,
            price: level.price,
            rentRecipient: participants[level.rentRecipientIndex]!.publicKey,
            closer: authority,
          });
          levels.delete(key);
          coverage.priceLevelClosures += 1;
        }
        actionTrace.push("assert-final-cleanup");
        await assertModel(
          "cancelled",
          generatedLabel("generalized final cleanup"),
        );
        assert.strictEqual(
          BigInt(await provider.connection.getBalance(market.vault)),
          vaultBaseline,
          "generalized terminal cleanup did not restore the vault baseline",
        );
        if (enforceCoverage) {
          assert.ok(
            coverage.reclaims > 0,
            "generalized terminal path had no reclaims",
          );
          assert.ok(
            coverage.claims > 0,
            "generalized terminal path had no claims",
          );
          assert.ok(
            coverage.emptyBalanceClosures > 0,
            "generalized terminal path had no empty balance closure",
          );
          assert.ok(
            coverage.filledOrderClosures > 0,
            "generalized terminal path had no filled order closure",
          );
          assert.ok(
            coverage.priceLevelClosures >= 3,
            "insufficient generalized price-level cleanup",
          );
          process.stdout.write(
            `[generalized-state-coverage] case=${generatedCase.id} seed=${sourceSeed} ${JSON.stringify({ ...coverage, distinctPrices: coverage.distinctPrices.size })}\n`,
          );
        }
      } catch (error) {
        throw new GeneralizedStateMachineExecutionError(
          generatedCase.id,
          sourceSeed,
          randomTape.consumed,
          actionTrace,
          error,
        );
      }
    };

    it(`conserves arbitrary mixed-price GTC/IOC/post-only ordering (${generatedCase.id}=${sourceSeed})`, async () => {
      const originalRandomWords = randomWordsForCase(
        generatedCase,
        generalizedCorpus.randomWordCount,
      );
      try {
        await executeGeneralizedStateMachine(
          originalRandomWords,
          generatedCase.enforceCoverage,
        );
      } catch (error) {
        if (process.env.HYPERBET_GENERATED_SHRINK_ON_FAILURE === "0") {
          throw error;
        }
        const failureFingerprint = stableFailureFingerprint(error);
        if (isCoverageAdmissionFailure(failureFingerprint)) {
          throw error;
        }
        const shrink = await shrinkFailingSequence(
          originalRandomWords,
          async (candidate) => {
            try {
              await executeGeneralizedStateMachine(candidate, false);
              return false;
            } catch (candidateError) {
              return (
                stableFailureFingerprint(candidateError) === failureFingerprint
              );
            }
          },
          {
            maxAttempts: positiveShrinkSetting(
              "HYPERBET_GENERATED_SHRINK_MAX_ATTEMPTS",
              8,
            ),
            deadlineMs:
              Date.now() +
              positiveShrinkSetting(
                "HYPERBET_GENERATED_SHRINK_TIME_BUDGET_MS",
                300_000,
              ),
            minimumItems: 1,
            assumeOriginalReproduces: true,
          },
        );
        let reducedFailure: GeneralizedStateMachineExecutionError | null = null;
        try {
          await executeGeneralizedStateMachine(shrink.items, false);
        } catch (candidateError) {
          if (
            candidateError instanceof GeneralizedStateMachineExecutionError &&
            stableFailureFingerprint(candidateError) === failureFingerprint
          ) {
            reducedFailure = candidateError;
          } else {
            throw candidateError;
          }
        }
        if (!reducedFailure) {
          throw new Error(
            `minimized generalized sequence no longer reproduces ${failureFingerprint}`,
          );
        }
        const artifact = parseGeneratedFailureArtifact({
          schemaVersion: 1,
          caseId: generatedCase.id,
          sourceSeed,
          failureFingerprint,
          originalRandomWordCount: originalRandomWords.length,
          reducedRandomWords: shrink.items,
          openActionCount: replayOpenActionCount(
            reducedFailure,
            generatedCase.openActionCount,
          ),
          actionTrace: reducedFailure.actionTrace,
        });
        const originalMessage =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        throw new Error(
          `${originalMessage}\nAutomatic generalized-sequence reduction: ${shrink.items.length}/${originalRandomWords.length} words after ${shrink.attempts} attempts (budgetExhausted=${shrink.budgetExhausted}). Save the following JSON and run bun run promote:generated-state-machine --artifact=<path> --corpus=tests/fixtures/duel-market-generalized-corpus.json --id=<canonical-id>.\n${JSON.stringify(artifact, null, 2)}`,
        );
      }
    });

    if (generatedCase.id === "hype-mixed") {
      it("delta-reduces an injected failure through real generalized mixed-price transactions without mutating its corpus", async () => {
        const originalRandomWords = randomWordsForCase(
          generatedCase,
          generalizedCorpus.randomWordCount,
        );
        const corpusBefore = JSON.stringify(generalizedCorpus);
        let originalFailure: unknown;
        try {
          await executeGeneralizedStateMachine(originalRandomWords, false, {
            injectFailureAfterOpenStep: 5,
          });
          assert.fail("injected generalized failure did not fire");
        } catch (error) {
          originalFailure = error;
        }
        assert.ok(
          originalFailure instanceof GeneralizedStateMachineExecutionError,
        );
        const failureFingerprint = stableFailureFingerprint(originalFailure);
        assert.match(
          failureFingerprint,
          /injected generalized shrink proof at open step 5/,
        );

        const shrink = await shrinkFailingSequence(
          originalRandomWords,
          async (candidate) => {
            try {
              await executeGeneralizedStateMachine(candidate, false, {
                injectFailureAfterOpenStep: 5,
              });
              return false;
            } catch (candidateError) {
              return (
                stableFailureFingerprint(candidateError) === failureFingerprint
              );
            }
          },
          {
            maxAttempts: 8,
            deadlineMs: Date.now() + 300_000,
            minimumItems: 1,
            assumeOriginalReproduces: true,
          },
        );
        let reducedFailure: GeneralizedStateMachineExecutionError | null = null;
        try {
          await executeGeneralizedStateMachine(shrink.items, false, {
            injectFailureAfterOpenStep: 5,
          });
        } catch (candidateError) {
          if (
            candidateError instanceof GeneralizedStateMachineExecutionError &&
            stableFailureFingerprint(candidateError) === failureFingerprint
          ) {
            reducedFailure = candidateError;
          } else {
            throw candidateError;
          }
        }
        assert.ok(
          reducedFailure,
          "minimized generalized shrink proof no longer reproduced the injected failure",
        );
        assert.ok(
          shrink.items.length < originalRandomWords.length,
          "generalized live shrink proof did not reduce the random tape",
        );
        process.stdout.write(
          `[generalized-shrinker-proof] words=${originalRandomWords.length}->${shrink.items.length} attempts=${shrink.attempts} budgetExhausted=${shrink.budgetExhausted}\n`,
        );
        const artifact = parseGeneratedFailureArtifact({
          schemaVersion: 1,
          caseId: generatedCase.id,
          sourceSeed,
          failureFingerprint,
          originalRandomWordCount: originalRandomWords.length,
          reducedRandomWords: shrink.items,
          openActionCount: replayOpenActionCount(
            reducedFailure,
            generatedCase.openActionCount,
          ),
          actionTrace: reducedFailure.actionTrace,
        });
        const promoted = promoteGeneratedFailure(
          generalizedCorpus,
          artifact,
          "injected-generalized-shrink-proof",
        );
        assert.strictEqual(
          promoted.cases.length,
          generalizedCorpus.cases.length + 1,
        );
        assert.strictEqual(JSON.stringify(generalizedCorpus), corpusBefore);
      });
    }
  }
});
