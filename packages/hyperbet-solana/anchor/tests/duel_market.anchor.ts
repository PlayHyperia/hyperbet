import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import * as assert from "assert";
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
  claimClobWinningsWithSignature,
  closeEmptyClobPriceLevel,
  closeEmptyClobUserBalance,
  closeFilledClobOrder,
  closeLosingClobBalance,
  continueClobOrder,
  createOpenMarketFixture,
  duelStatusBettingOpen,
  duelStatusLocked,
  deriveOrderPda,
  derivePriceLevelPda,
  deriveUserBalancePda,
  ensureClobConfig,
  ensureOracleReady,
  finalizeDuelResult,
  hasProgramError,
  initializeCanonicalMarket,
  placeClobOrder,
  proposeDuelResult,
  reclaimClobOrder,
  syncMarketFromDuel,
  uniqueDuelKey,
  upsertDuel,
  withdrawResolvedClobTradeFees,
  writableAccount,
  sleep,
} from "./clob-test-helpers";
import { configureAnchorTests } from "./test-anchor";
import {
  GENERATED_REPLAY_TERMINAL_PADDING_WORDS,
  GeneratedRandomTape,
  formatUint32Seed,
  parseGeneratedCorpus,
  parseGeneratedFailureArtifact,
  parseUint32Seed,
  promoteGeneratedFailure,
  randomWordsForCase,
  shrinkFailingSequence,
  stableFailureFingerprint,
} from "./generated-state-machine-replay";
import { FightOracle } from "../target/types/fight_oracle";
import { DuelMarket } from "../target/types/duel_market";

const generatedCorpusJson: unknown = JSON.parse(
  readFileSync("tests/fixtures/duel-market-generated-corpus.json", "utf8"),
);

describe("duel_market (native SOL settlement)", () => {
  const provider = configureAnchorTests();
  anchor.setProvider(provider);

  const fightProgram = anchor.workspace.FightOracle as Program<FightOracle>;
  const clobProgram = anchor.workspace.DuelMarket as Program<DuelMarket>;
  const authority = (provider.wallet as anchor.Wallet & { payer: Keypair })
    .payer;
  const generatedCorpus = parseGeneratedCorpus(generatedCorpusJson);

  async function lockFixtureMarket(
    market: {
      duelKey: number[];
      duelState: anchor.web3.PublicKey;
      marketState: anchor.web3.PublicKey;
    },
    metadataUri: string,
  ): Promise<void> {
    const duelStateAccount = await fightProgram.account.duelState.fetch(
      market.duelState,
    );
    const betCloseTs = Number(duelStateAccount.betCloseTs);
    const waitMs = Math.max(
      0,
      (betCloseTs - Math.floor(Date.now() / 1000) + 1) * 1_000,
    );
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    await upsertDuel(fightProgram, authority, market.duelKey, {
      status: duelStatusLocked(),
      betOpenTs: Number(duelStateAccount.betOpenTs),
      betCloseTs,
      duelStartTs: Number(duelStateAccount.duelStartTs),
      metadataUri,
    });
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
  }

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

  async function setMarketPaused(
    config: anchor.web3.PublicKey,
    orderPlacementPaused: boolean,
    marketCreationPaused: boolean,
  ): Promise<void> {
    await clobProgram.methods
      .setMarketPaused(orderPlacementPaused, marketCreationPaused)
      .accountsPartial({
        authority: authority.publicKey,
        config,
      })
      .signers([authority])
      .rpc();
  }

  it("rejects combined fee-cap overflow vectors without mutating config", async () => {
    const config = await ensureClobConfig(clobProgram, authority);
    const before = await clobProgram.account.marketConfig.fetch(config);
    const invalidFeeVectors = [
      [65_535, 1, Number(before.winningsMarketMakerFeeBps)],
      [65_535, 65_535, Number(before.winningsMarketMakerFeeBps)],
      [6000, 5000, Number(before.winningsMarketMakerFeeBps)],
      [
        Number(before.tradeTreasuryFeeBps),
        Number(before.tradeMarketMakerFeeBps),
        10001,
      ],
    ] as const;

    for (const [
      treasuryFeeBps,
      marketMakerFeeBps,
      winningsFeeBps,
    ] of invalidFeeVectors) {
      try {
        await clobProgram.methods
          .updateConfig(
            authority.publicKey,
            before.marketOperator,
            before.treasury,
            before.marketMaker,
            treasuryFeeBps,
            marketMakerFeeBps,
            winningsFeeBps,
          )
          .accountsPartial({
            authority: authority.publicKey,
            config,
          })
          .signers([authority])
          .rpc();
        assert.fail(
          `invalid fee vector ${treasuryFeeBps}/${marketMakerFeeBps}/${winningsFeeBps} was accepted`,
        );
      } catch (error: unknown) {
        assert.ok(
          hasProgramError(error, "FeeTooHigh"),
          `expected FeeTooHigh for ${treasuryFeeBps}/${marketMakerFeeBps}/${winningsFeeBps}, got ${String(error)}`,
        );
      }
    }

    const after = await clobProgram.account.marketConfig.fetch(config);
    assert.ok(after.marketOperator.equals(before.marketOperator));
    assert.ok(after.treasury.equals(before.treasury));
    assert.ok(after.marketMaker.equals(before.marketMaker));
    assert.strictEqual(after.tradeTreasuryFeeBps, before.tradeTreasuryFeeBps);
    assert.strictEqual(
      after.tradeMarketMakerFeeBps,
      before.tradeMarketMakerFeeBps,
    );
    assert.strictEqual(
      after.winningsMarketMakerFeeBps,
      before.winningsMarketMakerFeeBps,
    );
  });

  it("initializes one deterministic duel market and rejects duplicate init", async () => {
    await ensureOracleReady(fightProgram, authority, authority.publicKey);
    const config = await ensureClobConfig(clobProgram, authority);

    const duelKey = uniqueDuelKey("deterministic-market");
    const now = Math.floor(Date.now() / 1000);
    const duelState = await upsertDuel(fightProgram, authority, duelKey, {
      status: duelStatusBettingOpen(),
      betOpenTs: now - 15,
      betCloseTs: now + 600,
      duelStartTs: now + 660,
      metadataUri: "https://hyperia.gg/tests/clob/init",
    });
    const market = await initializeCanonicalMarket(
      clobProgram,
      authority,
      duelState,
      duelKey,
      config,
    );

    const marketState = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.ok(marketState.duelState.equals(duelState));
    assert.deepStrictEqual([...marketState.duelKey], duelKey);
    assert.deepStrictEqual(marketState.status, { open: {} });
    assert.strictEqual(marketState.marketKind, 1);
    assert.strictEqual(marketState.nextOrderId.toString(), "1");
    assert.strictEqual(marketState.bestBid, 0);
    assert.strictEqual(marketState.bestAsk, 1000);

    try {
      await initializeCanonicalMarket(
        clobProgram,
        authority,
        duelState,
        duelKey,
        config,
      );
      assert.fail("duplicate canonical market initialization succeeded");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(
        message.includes("already in use") ||
          message.includes("already initialized"),
        `expected duplicate PDA initialization failure, got ${message}`,
      );
    }
  });

  it("charges trade fees only on executed taker size and enforces FIFO at a shared price level", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const makerOne = Keypair.generate();
    const makerTwo = Keypair.generate();
    const taker = Keypair.generate();

    await Promise.all([
      airdrop(provider.connection, treasury.publicKey, 2),
      airdrop(provider.connection, marketMaker.publicKey, 2),
      airdrop(provider.connection, makerOne.publicKey, 5),
      airdrop(provider.connection, makerTwo.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("fifo-market"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
      },
    );
    const treasuryBefore = await provider.connection.getBalance(
      treasury.publicKey,
    );
    const marketMakerBefore = await provider.connection.getBalance(
      marketMaker.publicKey,
    );

    const firstAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: makerOne,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    const secondAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: makerTwo,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
      remainingAccounts: [writableAccount(firstAsk.order)],
    });

    const takerBid = await placeClobOrder(clobProgram, {
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
      remainingAccounts: [
        writableAccount(firstAsk.restingLevel),
        writableAccount(firstAsk.order),
        writableAccount(firstAsk.userBalance),
      ],
    });

    const priceLevel = await clobProgram.account.priceLevel.fetch(
      firstAsk.restingLevel,
    );
    const makerOneOrder = await clobProgram.account.order.fetch(firstAsk.order);
    const makerTwoOrder = await clobProgram.account.order.fetch(
      secondAsk.order,
    );
    const makerOneBalance = await clobProgram.account.userBalance.fetch(
      firstAsk.userBalance,
    );
    const makerTwoBalance = await clobProgram.account.userBalance.fetch(
      secondAsk.userBalance,
    );
    const takerBalance = await clobProgram.account.userBalance.fetch(
      takerBid.userBalance,
    );

    assert.strictEqual(priceLevel.headOrderId.toString(), "2");
    assert.strictEqual(priceLevel.tailOrderId.toString(), "2");
    assert.strictEqual(priceLevel.totalOpen.toString(), "1000");
    assert.ok(priceLevel.rentRecipient.equals(makerOne.publicKey));
    assert.strictEqual(makerOneOrder.filled.toString(), "1000");
    assert.strictEqual(makerOneOrder.active, false);
    assert.strictEqual(makerTwoOrder.filled.toString(), "0");
    assert.strictEqual(makerTwoOrder.active, true);
    assert.strictEqual(
      makerTwoOrder.prevOrderId.toString(),
      "1",
      "the new canonical head retains its matched-out predecessor until unlink",
    );
    assert.strictEqual(makerOneBalance.bShares.toString(), "1000");
    assert.strictEqual(makerTwoBalance.bShares.toString(), "0");
    assert.strictEqual(takerBalance.aShares.toString(), "1000");
    assert.strictEqual(
      makerOneBalance.tradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      makerOneBalance.tradeMarketMakerFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      makerTwoBalance.tradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      makerTwoBalance.tradeMarketMakerFeeLamports.toString(),
      "0",
    );

    const treasuryAfter = await provider.connection.getBalance(
      treasury.publicKey,
    );
    const marketMakerAfter = await provider.connection.getBalance(
      marketMaker.publicKey,
    );
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);
    assert.strictEqual(takerBalance.tradeTreasuryFeeLamports.toString(), "6");
    assert.strictEqual(
      takerBalance.tradeMarketMakerFeeLamports.toString(),
      "6",
    );
    const feeEscrow = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(
      feeEscrow.accruedTradeTreasuryFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      feeEscrow.accruedTradeMarketMakerFeeLamports.toString(),
      "6",
    );

    const secondOrderRent = BigInt(
      await provider.connection.getBalance(secondAsk.order),
    );
    const vaultBeforeHeadCancel = await provider.connection.getBalance(
      market.vault,
    );
    const cancelResult = await cancelClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: makerTwo,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
    });
    const [cancelledHead, emptyLevel, vaultAfterHeadCancel] = await Promise.all(
      [
        clobProgram.account.order.fetchNullable(secondAsk.order),
        clobProgram.account.priceLevel.fetch(secondAsk.restingLevel),
        provider.connection.getBalance(market.vault),
      ],
    );
    assert.strictEqual(cancelledHead, null);
    assert.strictEqual(emptyLevel.headOrderId.toString(), "0");
    assert.strictEqual(emptyLevel.tailOrderId.toString(), "0");
    assert.strictEqual(emptyLevel.totalOpen.toString(), "0");
    assert.strictEqual(vaultBeforeHeadCancel - vaultAfterHeadCancel, 400);
    const cancelAccounting = await confirmedWalletDelta(
      cancelResult.signature,
      makerTwo.publicKey,
    );
    assert.strictEqual(
      cancelAccounting.delta + cancelAccounting.feePaidByWallet,
      400n + secondOrderRent,
    );
  });

  it("returns unmatched user-balance rent after matching stops without allowing active-book poisoning", async () => {
    const maker = Keypair.generate();
    await airdrop(provider.connection, maker.publicKey, 5);

    const closeSoon = Math.floor(Date.now() / 1000) + 30;
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("empty-user-balance-rent"),
        betOpenTs: closeSoon - 30,
        betCloseTs: closeSoon,
        duelStartTs: closeSoon + 1,
      },
    );
    const resting = await placeClobOrder(clobProgram, {
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
    const balanceRent = BigInt(
      await provider.connection.getBalance(resting.userBalance),
    );
    assert.ok(balanceRent > 0n);

    try {
      await closeEmptyClobUserBalance(clobProgram, {
        marketState: market.marketState,
        user: maker,
      });
      assert.fail("closed a maker balance while its order could still match");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketStillOpen"),
        `expected MarketStillOpen, got ${String(error)}`,
      );
    }
    assert.notStrictEqual(
      await clobProgram.account.userBalance.fetchNullable(resting.userBalance),
      null,
    );

    await lockFixtureMarket(
      market,
      "https://hyperia.gg/duels/empty-user-balance-rent-locked",
    );
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
    });
    const closeResult = await closeEmptyClobUserBalance(clobProgram, {
      marketState: market.marketState,
      user: maker,
    });
    const closeAccounting = await confirmedWalletDelta(
      closeResult.signature,
      maker.publicKey,
    );
    assert.strictEqual(
      closeAccounting.delta + closeAccounting.feePaidByWallet,
      balanceRent,
    );
    assert.strictEqual(
      await clobProgram.account.userBalance.fetchNullable(resting.userBalance),
      null,
    );
    await closeEmptyClobPriceLevel(clobProgram, {
      marketState: market.marketState,
      side: SIDE_ASK,
      price: 600,
      rentRecipient: maker.publicKey,
      closer: maker,
    });
  });

  it("validates the generated replay corpus and deterministic random tape", () => {
    assert.deepStrictEqual(
      generatedCorpus.cases.map((entry) => entry.id),
      ["hype", "sol1", "golden-ratio", "orbit", "order-book", "matching-tick"],
    );
    assert.deepStrictEqual(
      generatedCorpus.cases.map((entry) =>
        entry.kind === "seed" ? entry.seed : entry.sourceSeed,
      ),
      [
        "0x48595045",
        "0x534f4c31",
        "0x3c6ef373",
        "0x4f524249",
        "0x424f4f4b",
        "0x5449434b",
      ],
    );
    const firstCase = generatedCorpus.cases[0]!;
    const words = randomWordsForCase(
      firstCase,
      generatedCorpus.randomWordCount,
    );
    assert.strictEqual(words.length, 256);
    const tape = new GeneratedRandomTape(words);
    let state = parseUint32Seed("0x48595045");
    for (const limit of [100, 9, 2, 6, 3, 17]) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      assert.strictEqual(tape.take(limit), state % limit);
    }
    assert.strictEqual(tape.consumed, 6);
    assert.strictEqual(formatUint32Seed(state).length, 10);
  });

  it("delta-reduces a deterministic failure while preserving its fingerprint", async () => {
    const required = new Set([3, 7]);
    const result = await shrinkFailingSequence(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (candidate) =>
        [...required].every((value) => candidate.includes(value)),
      { maxAttempts: 32 },
    );
    assert.deepStrictEqual(result.items, [3, 7]);
    assert.ok(result.attempts > 1);
    assert.strictEqual(result.budgetExhausted, false);

    const first = Object.assign(
      new Error("account 9xQeWvG816bUx9EPjHmaT23yvVMqYcFQqQfZz4wCEVw failed"),
      {
        errorCode: { code: "InvalidRemainingAccount" },
      },
    );
    const second = Object.assign(
      new Error("account 7YttLkHDoNj9wyDur5XxuHiA1w1iLuS5qzhAG8BiYJ9E failed"),
      {
        errorCode: { code: "InvalidRemainingAccount" },
      },
    );
    assert.strictEqual(
      stableFailureFingerprint(first),
      stableFailureFingerprint(second),
    );
    assert.notStrictEqual(
      stableFailureFingerprint(first),
      stableFailureFingerprint(new Error("different invariant")),
    );
  });

  it("promotes a minimized failure into one canonical replay case", () => {
    const artifact = parseGeneratedFailureArtifact({
      schemaVersion: 1,
      caseId: "hype",
      sourceSeed: "0x48595045",
      failureFingerprint: "AssertionError|none|vault liability drift",
      originalRandomWordCount: 256,
      reducedRandomWords: [1, 2, 3, 5, 8],
      openActionCount: 9,
      actionTrace: ["place:1", "cancel:1"],
    });
    const promoted = promoteGeneratedFailure(
      generatedCorpus,
      artifact,
      "vault-liability-regression",
    );
    assert.strictEqual(promoted.cases.length, generatedCorpus.cases.length + 1);
    const replay = promoted.cases.at(-1)!;
    assert.strictEqual(replay.kind, "replay");
    assert.strictEqual(replay.enforceCoverage, false);
    assert.deepStrictEqual(
      randomWordsForCase(replay, generatedCorpus.randomWordCount).slice(0, 5),
      [1, 2, 3, 5, 8],
    );
    assert.strictEqual(
      randomWordsForCase(replay, generatedCorpus.randomWordCount).length,
      5 + GENERATED_REPLAY_TERMINAL_PADDING_WORDS,
    );
    assert.throws(
      () =>
        promoteGeneratedFailure(
          promoted,
          artifact,
          "vault-liability-regression-copy",
        ),
      /already promoted/,
    );
  });

  class GeneratedStateMachineExecutionError extends Error {
    readonly failureFingerprint: string;
    readonly actionTrace: string[];
    readonly randomWordsConsumed: number;

    constructor(
      generatedCaseId: string,
      generatedSeed: string,
      randomWordsConsumed: number,
      actionTrace: readonly string[],
      cause: unknown,
    ) {
      const causeText =
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
      super(
        `generated state machine failed for ${generatedCaseId} seed=${generatedSeed} word=${randomWordsConsumed}; trace=${actionTrace.join(" -> ")}\n${causeText}`,
      );
      this.name = "GeneratedStateMachineExecutionError";
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
    error: GeneratedStateMachineExecutionError | null,
    fallback: number,
  ): number => {
    const tracedOpenActions =
      error?.actionTrace.filter(
        (action) => action.startsWith("place:") || action.startsWith("cancel:"),
      ).length ?? 0;
    return Math.max(1, Math.min(fallback, tracedOpenActions || fallback));
  };

  for (const generatedCase of generatedCorpus.cases) {
    const generatedSeed =
      generatedCase.kind === "seed"
        ? generatedCase.seed
        : generatedCase.sourceSeed;
    const executeGeneratedStateMachine = async (
      randomWords: readonly number[],
      enforceCoverage: boolean,
      options: { injectFailureAfterOpenStep?: number } = {},
    ): Promise<void> => {
      type ModelOrder = {
        id: number;
        makerIndex: number;
        side: 1 | 2;
        amount: bigint;
        filled: bigint;
        previousOrderId: number;
        nextOrderId: number;
        active: boolean;
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

      const actionTrace: string[] = [];
      const randomTape = new GeneratedRandomTape(randomWords);
      try {
        const makers = Array.from({ length: 7 }, () => Keypair.generate());
        await Promise.all(
          makers.map((maker) =>
            airdrop(provider.connection, maker.publicKey, 5),
          ),
        );
        const closeSoon = Math.floor(Date.now() / 1000) + 45;
        const market = await createOpenMarketFixture(
          fightProgram,
          clobProgram,
          authority,
          {
            duelKey: uniqueDuelKey(
              `generated-state-machine-${generatedCase.id}`,
            ),
            betOpenTs: closeSoon - 30,
            betCloseTs: closeSoon,
            duelStartTs: closeSoon + 1,
          },
        );
        const vaultBaseline = BigInt(
          await provider.connection.getBalance(market.vault),
        );
        const orders = new Map<number, ModelOrder>();
        const balances = new Map<number, ModelBalance>();
        const queue: number[] = [];
        let nextOrderId = 1;
        let accruedTreasuryFees = 0n;
        let accruedMarketMakerFees = 0n;
        const coverage = {
          placements: 0,
          cancellations: 0,
          headCancellations: 0,
          middleCancellations: 0,
          tailCancellations: 0,
          fills: 0,
          partialFills: 0,
          multiFillTransactions: 0,
          sideFlips: 0,
          reclaims: 0,
          claims: 0,
          emptyBalanceClosures: 0,
        };

        const random = (limit: number): number => {
          return randomTape.take(limit);
        };
        const generatedLabel = (label: string): string =>
          `case=${generatedCase.id} seed=${generatedSeed} word=${randomTape.consumed} ${label}; trace=${actionTrace.join(" -> ")}`;
        const maybeInjectFailure = (step: number): void => {
          if (options.injectFailureAfterOpenStep === step) {
            throw new Error(
              `injected generated shrink proof at open step ${step}`,
            );
          }
        };
        const oppositeSide = (side: 1 | 2): 1 | 2 =>
          side === SIDE_BID ? SIDE_ASK : SIDE_BID;
        const quote = (side: 1 | 2, amount: bigint): bigint =>
          (amount * BigInt(side === SIDE_BID ? 600 : 400)) / 1_000n;
        const emptyBalance = (): ModelBalance => ({
          open: true,
          aShares: 0n,
          bShares: 0n,
          aLockedLamports: 0n,
          bLockedLamports: 0n,
          tradeTreasuryFeeLamports: 0n,
          tradeMarketMakerFeeLamports: 0n,
        });
        const balanceFor = (makerIndex: number): ModelBalance => {
          const existing = balances.get(makerIndex);
          if (existing) return existing;
          const created = emptyBalance();
          balances.set(makerIndex, created);
          return created;
        };
        const remainingFor = (order: ModelOrder): bigint =>
          order.amount - order.filled;
        const activeSide = (): 1 | 2 | null => {
          const headId = queue[0];
          return headId === undefined ? null : orders.get(headId)!.side;
        };
        const applyFill = (
          makerOrder: ModelOrder,
          takerIndex: number,
          takerSide: 1 | 2,
          amount: bigint,
        ): bigint => {
          const makerBalance = balanceFor(makerOrder.makerIndex);
          const takerBalance = balanceFor(takerIndex);
          const makerLocked = quote(makerOrder.side, amount);
          const takerLocked = quote(takerSide, amount);
          if (makerOrder.side === SIDE_BID) {
            makerBalance.aShares += amount;
            makerBalance.aLockedLamports += makerLocked;
            takerBalance.bShares += amount;
            takerBalance.bLockedLamports += takerLocked;
          } else {
            makerBalance.bShares += amount;
            makerBalance.bLockedLamports += makerLocked;
            takerBalance.aShares += amount;
            takerBalance.aLockedLamports += takerLocked;
          }
          return takerLocked;
        };
        const expectedVaultLiability = (): bigint => {
          const resting = [...orders.values()].reduce(
            (sum, order) =>
              sum +
              (order.active ? quote(order.side, remainingFor(order)) : 0n),
            0n,
          );
          const balancesLiability = [...balances.values()].reduce(
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
          return resting + balancesLiability;
        };

        const assertModel = async (
          expectedStatus: "open" | "locked" | "cancelled",
          label: string,
        ): Promise<void> => {
          const [marketState, vaultLamports, bidLevel, askLevel] =
            await Promise.all([
              clobProgram.account.marketState.fetch(market.marketState),
              provider.connection.getBalance(market.vault),
              clobProgram.account.priceLevel.fetchNullable(
                derivePriceLevelPda(
                  clobProgram.programId,
                  market.marketState,
                  SIDE_BID,
                  600,
                ),
              ),
              clobProgram.account.priceLevel.fetchNullable(
                derivePriceLevelPda(
                  clobProgram.programId,
                  market.marketState,
                  SIDE_ASK,
                  600,
                ),
              ),
            ]);
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
          assert.strictEqual(
            marketState.bestBid,
            activeSide() === SIDE_BID ? 600 : 0,
            `${label}: best bid drift`,
          );
          assert.strictEqual(
            marketState.bestAsk,
            activeSide() === SIDE_ASK ? 600 : 1000,
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
            `${label}: vault liability drift`,
          );

          for (const [side, level] of [
            [SIDE_BID, bidLevel],
            [SIDE_ASK, askLevel],
          ] as const) {
            const sideQueue = queue.filter(
              (orderId) => orders.get(orderId)!.side === side,
            );
            if (!level) {
              assert.strictEqual(
                sideQueue.length,
                0,
                `${label}: active side ${side} has no price level`,
              );
              continue;
            }
            const expectedTotal = sideQueue.reduce(
              (sum, orderId) => sum + remainingFor(orders.get(orderId)!),
              0n,
            );
            assert.ok(
              (level.marketState as anchor.web3.PublicKey).equals(
                market.marketState,
              ),
              `${label}: price-level market drift`,
            );
            assert.strictEqual(
              Number(level.side),
              side,
              `${label}: side drift`,
            );
            assert.strictEqual(
              Number(level.price),
              600,
              `${label}: price drift`,
            );
            assert.strictEqual(
              level.headOrderId.toString(),
              String(sideQueue[0] ?? 0),
              `${label}: level head drift`,
            );
            assert.strictEqual(
              level.tailOrderId.toString(),
              String(sideQueue[sideQueue.length - 1] ?? 0),
              `${label}: level tail drift`,
            );
            assert.strictEqual(
              level.totalOpen.toString(),
              expectedTotal.toString(),
              `${label}: level total drift`,
            );
          }

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
            await clobProgram.account.order.fetchMultiple(orderPdas);
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
            assert.strictEqual(chainOrder.id.toString(), String(expected.id));
            assert.strictEqual(Number(chainOrder.side), expected.side);
            assert.strictEqual(Number(chainOrder.price), 600);
            assert.ok(
              (chainOrder.maker as anchor.web3.PublicKey).equals(
                makers[expected.makerIndex]!.publicKey,
              ),
            );
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
            );
            assert.strictEqual(
              chainOrder.nextOrderId.toString(),
              String(expected.nextOrderId),
            );
            assert.strictEqual(chainOrder.active, expected.active);
            assert.strictEqual(chainOrder.continuationPending, false);
          });

          const balancePdas = makers.map((maker) =>
            deriveUserBalancePda(
              clobProgram.programId,
              market.marketState,
              maker.publicKey,
            ),
          );
          const chainBalances =
            await clobProgram.account.userBalance.fetchMultiple(balancePdas);
          chainBalances.forEach((chainBalance, makerIndex) => {
            const expected = balances.get(makerIndex);
            if (!expected || !expected.open) {
              assert.strictEqual(
                chainBalance,
                null,
                `${label}: closed balance ${makerIndex} still exists`,
              );
              return;
            }
            assert.ok(
              chainBalance,
              `${label}: balance ${makerIndex} disappeared`,
            );
            assert.ok(
              (chainBalance.user as anchor.web3.PublicKey).equals(
                makers[makerIndex]!.publicKey,
              ),
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
                `${label}: balance ${makerIndex} ${field} drift`,
              );
            }
          });
        };

        const cancelQueueIndex = async (queueIndex: number): Promise<void> => {
          const selectedId = queue[queueIndex]!;
          const selected = orders.get(selectedId)!;
          const previousId = queueIndex === 0 ? 0 : queue[queueIndex - 1]!;
          const nextId = queue[queueIndex + 1] ?? 0;
          const remainingAccounts = [previousId, nextId]
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
          await cancelClobOrder(clobProgram, {
            marketState: market.marketState,
            duelState: market.duelState,
            vault: market.vault,
            user: makers[selected.makerIndex]!,
            orderId: selected.id,
            side: selected.side,
            price: 600,
            remainingAccounts,
          });
          if (queueIndex === 0) coverage.headCancellations += 1;
          else if (queueIndex === queue.length - 1)
            coverage.tailCancellations += 1;
          else coverage.middleCancellations += 1;
          if (previousId !== 0) orders.get(previousId)!.nextOrderId = nextId;
          if (nextId !== 0) orders.get(nextId)!.previousOrderId = previousId;
          queue.splice(queueIndex, 1);
          orders.delete(selectedId);
          coverage.cancellations += 1;
        };

        for (let step = 0; step < generatedCase.openActionCount; step += 1) {
          if (queue.length > 1 && random(100) < 25) {
            const queueIndex = random(queue.length);
            actionTrace.push(`cancel:${queue[queueIndex]}`);
            await cancelQueueIndex(queueIndex);
            await assertModel(
              "open",
              generatedLabel(`generated cancel ${step}`),
            );
            maybeInjectFailure(step);
            continue;
          }

          const currentSide = activeSide();
          const side =
            currentSide === null
              ? random(2) === 0
                ? SIDE_BID
                : SIDE_ASK
              : random(100) < 52
                ? currentSide
                : oppositeSide(currentSide);
          let makerIndex = random(makers.length - 1);
          if (
            currentSide !== null &&
            side !== currentSide &&
            makerIndex === orders.get(queue[0]!)!.makerIndex
          ) {
            makerIndex = (makerIndex + 1) % (makers.length - 1);
          }
          const amount = BigInt((random(3) + 1) * 1_000);
          const orderId = nextOrderId;
          nextOrderId += 1;
          balanceFor(makerIndex);
          let remaining = amount;
          let executedCost = 0n;
          let fillCount = 0;
          let selfTradePrevented = false;
          const remainingAccounts: anchor.web3.AccountMeta[] = [];

          while (remaining > 0n && queue.length > 0 && activeSide() !== side) {
            const makerOrder = orders.get(queue[0]!)!;
            remainingAccounts.push(
              writableAccount(
                derivePriceLevelPda(
                  clobProgram.programId,
                  market.marketState,
                  makerOrder.side,
                  600,
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
                  makers[makerOrder.makerIndex]!.publicKey,
                ),
              ),
            );
            if (makerOrder.makerIndex === makerIndex) {
              selfTradePrevented = true;
              break;
            }
            const makerRemaining = remainingFor(makerOrder);
            const fill =
              remaining < makerRemaining ? remaining : makerRemaining;
            makerOrder.filled += fill;
            remaining -= fill;
            executedCost += applyFill(makerOrder, makerIndex, side, fill);
            fillCount += 1;
            coverage.fills += 1;
            if (fill < makerRemaining) coverage.partialFills += 1;
            if (makerOrder.filled === makerOrder.amount) {
              makerOrder.active = false;
              makerOrder.previousOrderId = 0;
              makerOrder.nextOrderId = 0;
              queue.shift();
            }
          }
          if (fillCount > 1) coverage.multiFillTransactions += 1;
          if (executedCost > 0n) {
            const treasuryFee = executedCost / 100n;
            const marketMakerFee = executedCost / 100n;
            const takerBalance = balanceFor(makerIndex);
            takerBalance.tradeTreasuryFeeLamports += treasuryFee;
            takerBalance.tradeMarketMakerFeeLamports += marketMakerFee;
            accruedTreasuryFees += treasuryFee;
            accruedMarketMakerFees += marketMakerFee;
          }
          if (remaining > 0n && !selfTradePrevented) {
            const previousOrderId = queue[queue.length - 1] ?? 0;
            if (previousOrderId !== 0) {
              remainingAccounts.push(
                writableAccount(
                  deriveOrderPda(
                    clobProgram.programId,
                    market.marketState,
                    previousOrderId,
                  ),
                ),
              );
              orders.get(previousOrderId)!.nextOrderId = orderId;
            }
            orders.set(orderId, {
              id: orderId,
              makerIndex,
              side,
              amount: remaining,
              filled: 0n,
              previousOrderId,
              nextOrderId: 0,
              active: true,
            });
            if (
              currentSide !== null &&
              currentSide !== side &&
              queue.length === 0
            ) {
              coverage.sideFlips += 1;
            }
            queue.push(orderId);
          }

          actionTrace.push(
            `place:${orderId}:${side}:${makerIndex}:${amount}:${fillCount}:${remaining}:${selfTradePrevented ? 1 : 0}`,
          );
          await placeClobOrder(clobProgram, {
            marketState: market.marketState,
            duelState: market.duelState,
            config: market.config,
            treasury: market.treasury,
            marketMaker: market.marketMaker,
            vault: market.vault,
            user: makers[makerIndex]!,
            orderId,
            side,
            price: 600,
            amount,
            remainingAccounts,
          });
          coverage.placements += 1;
          await assertModel("open", generatedLabel(`generated place ${step}`));
          maybeInjectFailure(step);
        }

        const cleanupOnlyMakerIndex = makers.length - 1;
        const cleanupOnlySide = activeSide() ?? SIDE_ASK;
        const cleanupOnlyOrderId = nextOrderId;
        nextOrderId += 1;
        balanceFor(cleanupOnlyMakerIndex);
        const cleanupOnlyPreviousId = queue[queue.length - 1] ?? 0;
        const cleanupOnlyRemainingAccounts =
          cleanupOnlyPreviousId === 0
            ? []
            : [
                writableAccount(
                  deriveOrderPda(
                    clobProgram.programId,
                    market.marketState,
                    cleanupOnlyPreviousId,
                  ),
                ),
              ];
        if (cleanupOnlyPreviousId !== 0) {
          orders.get(cleanupOnlyPreviousId)!.nextOrderId = cleanupOnlyOrderId;
        }
        orders.set(cleanupOnlyOrderId, {
          id: cleanupOnlyOrderId,
          makerIndex: cleanupOnlyMakerIndex,
          side: cleanupOnlySide,
          amount: 1_000n,
          filled: 0n,
          previousOrderId: cleanupOnlyPreviousId,
          nextOrderId: 0,
          active: true,
        });
        queue.push(cleanupOnlyOrderId);
        actionTrace.push(
          `cleanup-place:${cleanupOnlyOrderId}:${cleanupOnlySide}:${cleanupOnlyMakerIndex}`,
        );
        await placeClobOrder(clobProgram, {
          marketState: market.marketState,
          duelState: market.duelState,
          config: market.config,
          treasury: market.treasury,
          marketMaker: market.marketMaker,
          vault: market.vault,
          user: makers[cleanupOnlyMakerIndex]!,
          orderId: cleanupOnlyOrderId,
          side: cleanupOnlySide,
          price: 600,
          amount: 1_000,
          remainingAccounts: cleanupOnlyRemainingAccounts,
        });
        coverage.placements += 1;
        await assertModel(
          "open",
          generatedLabel("generated cleanup-only placement"),
        );

        if (enforceCoverage) {
          assert.ok(
            coverage.placements >= 20,
            "insufficient generated placements",
          );
          assert.ok(
            coverage.cancellations >= 3,
            "insufficient generated cancellations",
          );
          assert.ok(coverage.fills >= 8, "insufficient generated fills");
          assert.ok(
            coverage.partialFills >= 2,
            "insufficient generated partial fills",
          );
          assert.ok(
            coverage.multiFillTransactions >= 1,
            "generated sequence never crossed multiple maker orders",
          );
          assert.ok(
            coverage.sideFlips >= 1,
            "generated book never flipped sides",
          );
          assert.ok(
            coverage.headCancellations >= 1,
            "generated sequence never cancelled the head",
          );
          assert.ok(
            coverage.middleCancellations >= 1,
            "generated sequence never cancelled a middle order",
          );
          assert.ok(
            coverage.tailCancellations >= 1,
            "generated sequence never cancelled the tail",
          );
        }

        actionTrace.push("lock");
        await lockFixtureMarket(
          market,
          "https://hyperia.gg/duels/generated-state-machine-locked",
        );
        await assertModel("locked", generatedLabel("generated lock"));

        while (queue.length > 0) {
          const queueIndex = random(queue.length);
          const selectedId = queue[queueIndex]!;
          const selected = orders.get(selectedId)!;
          const previousId = queueIndex === 0 ? 0 : queue[queueIndex - 1]!;
          const nextId = queue[queueIndex + 1] ?? 0;
          actionTrace.push(`reclaim:${selectedId}`);
          await reclaimClobOrder(clobProgram, {
            marketState: market.marketState,
            duelState: market.duelState,
            vault: market.vault,
            user: makers[selected.makerIndex]!,
            orderId: selected.id,
            side: selected.side,
            price: 600,
            remainingAccounts: [previousId, nextId]
              .filter((orderId) => orderId !== 0)
              .map((orderId) =>
                writableAccount(
                  deriveOrderPda(
                    clobProgram.programId,
                    market.marketState,
                    orderId,
                  ),
                ),
              ),
          });
          if (previousId !== 0) orders.get(previousId)!.nextOrderId = nextId;
          if (nextId !== 0) orders.get(nextId)!.previousOrderId = previousId;
          queue.splice(queueIndex, 1);
          orders.delete(selectedId);
          coverage.reclaims += 1;
          await assertModel(
            "locked",
            generatedLabel(`generated reclaim ${selectedId}`),
          );
        }

        actionTrace.push("cancel-duel");
        await cancelDuel(fightProgram, authority, market.duelKey);
        actionTrace.push("sync-terminal-market");
        await syncMarketFromDuel(
          clobProgram,
          market.marketState,
          market.duelState,
        );
        await assertModel(
          "cancelled",
          generatedLabel("generated cancellation"),
        );

        for (const [makerIndex, balance] of balances) {
          const custody =
            balance.aLockedLamports +
            balance.bLockedLamports +
            balance.tradeTreasuryFeeLamports +
            balance.tradeMarketMakerFeeLamports;
          if (custody > 0n) {
            actionTrace.push(`claim:${makerIndex}:${custody}`);
            await claimClobWinnings(clobProgram, {
              marketState: market.marketState,
              duelState: market.duelState,
              config: market.config,
              marketMaker: market.marketMaker,
              vault: market.vault,
              user: makers[makerIndex]!,
            });
            accruedTreasuryFees -= balance.tradeTreasuryFeeLamports;
            accruedMarketMakerFees -= balance.tradeMarketMakerFeeLamports;
            coverage.claims += 1;
          } else {
            actionTrace.push(`close-empty-balance:${makerIndex}`);
            await closeEmptyClobUserBalance(clobProgram, {
              marketState: market.marketState,
              user: makers[makerIndex]!,
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
            generatedLabel(`generated balance cleanup ${makerIndex}`),
          );
        }

        for (const [orderId, order] of [...orders]) {
          assert.strictEqual(order.active, false);
          actionTrace.push(`close-filled-order:${orderId}`);
          await closeFilledClobOrder(clobProgram, {
            marketState: market.marketState,
            user: makers[order.makerIndex]!,
            orderId,
          });
          orders.delete(orderId);
        }
        for (const side of [SIDE_BID, SIDE_ASK] as const) {
          const level = await clobProgram.account.priceLevel.fetchNullable(
            derivePriceLevelPda(
              clobProgram.programId,
              market.marketState,
              side,
              600,
            ),
          );
          if (level) {
            actionTrace.push(`close-empty-level:${side}`);
            await closeEmptyClobPriceLevel(clobProgram, {
              marketState: market.marketState,
              side,
              price: 600,
              rentRecipient: level.rentRecipient as anchor.web3.PublicKey,
              closer: authority,
            });
          }
        }
        actionTrace.push("assert-final-cleanup");
        await assertModel(
          "cancelled",
          generatedLabel("generated final cleanup"),
        );
        assert.strictEqual(
          await provider.connection.getBalance(market.vault),
          Number(vaultBaseline),
        );
        if (enforceCoverage) {
          assert.ok(
            coverage.reclaims > 0,
            "generated terminal path had no reclaims",
          );
          assert.ok(
            coverage.claims > 0,
            "generated terminal path had no claims",
          );
          assert.ok(
            coverage.emptyBalanceClosures > 0,
            "generated terminal path had no empty balance cleanup",
          );
        }
      } catch (error) {
        throw new GeneratedStateMachineExecutionError(
          generatedCase.id,
          generatedSeed,
          randomTape.consumed,
          actionTrace,
          error,
        );
      }
    };

    it(`conserves custody and FIFO links through a seeded multi-instruction state machine (${generatedCase.id}=${generatedSeed})`, async () => {
      const originalRandomWords = randomWordsForCase(
        generatedCase,
        generatedCorpus.randomWordCount,
      );
      try {
        await executeGeneratedStateMachine(
          originalRandomWords,
          generatedCase.enforceCoverage,
        );
      } catch (error) {
        if (process.env.HYPERBET_GENERATED_SHRINK_ON_FAILURE === "0") {
          throw error;
        }
        const failureFingerprint = stableFailureFingerprint(error);
        const maxAttempts = positiveShrinkSetting(
          "HYPERBET_GENERATED_SHRINK_MAX_ATTEMPTS",
          8,
        );
        const timeBudgetMs = positiveShrinkSetting(
          "HYPERBET_GENERATED_SHRINK_TIME_BUDGET_MS",
          300_000,
        );
        const shrink = await shrinkFailingSequence(
          originalRandomWords,
          async (candidate) => {
            try {
              await executeGeneratedStateMachine(candidate, false);
              return false;
            } catch (candidateError) {
              return (
                stableFailureFingerprint(candidateError) === failureFingerprint
              );
            }
          },
          {
            maxAttempts,
            deadlineMs: Date.now() + timeBudgetMs,
            minimumItems: 1,
            assumeOriginalReproduces: true,
          },
        );
        let reducedFailure: GeneratedStateMachineExecutionError | null = null;
        try {
          await executeGeneratedStateMachine(shrink.items, false);
        } catch (candidateError) {
          if (
            candidateError instanceof GeneratedStateMachineExecutionError &&
            stableFailureFingerprint(candidateError) === failureFingerprint
          ) {
            reducedFailure = candidateError;
          } else {
            throw new Error(
              `minimized generated sequence did not preserve ${failureFingerprint}: ${String(candidateError)}`,
            );
          }
        }
        if (!reducedFailure) {
          throw new Error(
            `minimized generated sequence no longer reproduces ${failureFingerprint}`,
          );
        }
        const artifact = parseGeneratedFailureArtifact({
          schemaVersion: 1,
          caseId: generatedCase.id,
          sourceSeed: generatedSeed,
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
          `${originalMessage}\nAutomatic generated-sequence reduction: ${shrink.items.length}/${originalRandomWords.length} words after ${shrink.attempts} attempts (budgetExhausted=${shrink.budgetExhausted}). Save the following JSON and run bun run promote:generated-state-machine --artifact=<path> --id=<canonical-id>.\n${JSON.stringify(artifact, null, 2)}`,
        );
      }
    });

    if (generatedCase.id === "hype") {
      it("delta-reduces an injected failure through real generated market transactions without mutating the corpus", async () => {
        const originalRandomWords = randomWordsForCase(
          generatedCase,
          generatedCorpus.randomWordCount,
        );
        const corpusBefore = JSON.stringify(generatedCorpus);
        let originalFailure: unknown;
        try {
          await executeGeneratedStateMachine(originalRandomWords, false, {
            injectFailureAfterOpenStep: 5,
          });
          assert.fail("injected generated failure did not fire");
        } catch (error) {
          originalFailure = error;
        }
        assert.ok(
          originalFailure instanceof GeneratedStateMachineExecutionError,
        );
        const failureFingerprint = stableFailureFingerprint(originalFailure);
        assert.match(
          failureFingerprint,
          /injected generated shrink proof at open step 5/,
        );

        const shrink = await shrinkFailingSequence(
          originalRandomWords,
          async (candidate) => {
            try {
              await executeGeneratedStateMachine(candidate, false, {
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
        let reducedFailure: GeneratedStateMachineExecutionError | null = null;
        try {
          await executeGeneratedStateMachine(shrink.items, false, {
            injectFailureAfterOpenStep: 5,
          });
        } catch (candidateError) {
          if (
            candidateError instanceof GeneratedStateMachineExecutionError &&
            stableFailureFingerprint(candidateError) === failureFingerprint
          ) {
            reducedFailure = candidateError;
          } else {
            throw candidateError;
          }
        }
        assert.ok(
          reducedFailure,
          "minimized live shrink proof no longer reproduced the injected failure",
        );
        assert.ok(
          shrink.items.length < originalRandomWords.length,
          "live shrink proof did not reduce the random tape",
        );
        process.stdout.write(
          `[generated-shrinker-proof] words=${originalRandomWords.length}->${shrink.items.length} attempts=${shrink.attempts} budgetExhausted=${shrink.budgetExhausted}\n`,
        );
        const artifact = parseGeneratedFailureArtifact({
          schemaVersion: 1,
          caseId: generatedCase.id,
          sourceSeed: generatedSeed,
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
          generatedCorpus,
          artifact,
          "injected-live-shrink-proof",
        );
        assert.strictEqual(
          promoted.cases.length,
          generatedCorpus.cases.length + 1,
        );
        assert.strictEqual(JSON.stringify(generatedCorpus), corpusBefore);
      });
    }
  }

  for (const generatedCase of generatedCorpus.cases) {
    if (generatedCase.kind !== "seed") continue;
    const planTape = new GeneratedRandomTape(
      randomWordsForCase(generatedCase, generatedCorpus.randomWordCount),
    );
    const askPrices = [
      100 + planTape.take(150),
      350 + planTape.take(150),
      600 + planTape.take(150),
    ];
    const askAmounts = [
      (planTape.take(3) + 1) * 1_000,
      (planTape.take(3) + 1) * 1_000,
      (planTape.take(3) + 1) * 1_000,
    ];
    const sweepPrice = 800 + planTape.take(75);
    const postOnlyAskPrice = sweepPrice + 50 + planTape.take(50);
    const finalBidPrice =
      postOnlyAskPrice + 1 + planTape.take(999 - postOnlyAskPrice);
    const planLabel = `${generatedCase.id}=${generatedCase.seed}`;

    it(`conserves a generated mixed-price GTC/IOC/post-only lifecycle (${planLabel})`, async () => {
      const askMakers = Array.from({ length: 3 }, () => Keypair.generate());
      const sweepingBidder = Keypair.generate();
      const postOnlyMaker = Keypair.generate();
      const iocSeller = Keypair.generate();
      const finalBidder = Keypair.generate();
      const blockedPostOnlyMaker = Keypair.generate();
      const participants = [
        ...askMakers,
        sweepingBidder,
        postOnlyMaker,
        iocSeller,
        finalBidder,
        blockedPostOnlyMaker,
      ];
      await Promise.all(
        participants.map((participant) =>
          airdrop(provider.connection, participant.publicKey, 5),
        ),
      );
      const market = await createOpenMarketFixture(
        fightProgram,
        clobProgram,
        authority,
        {
          duelKey: uniqueDuelKey(
            `generated-mixed-price-behavior-${generatedCase.id}`,
          ),
          tradeTreasuryFeeBps: 100,
          tradeMarketMakerFeeBps: 100,
          winningsMarketMakerFeeBps: 200,
        },
      );
      const vaultBaseline = BigInt(
        await provider.connection.getBalance(market.vault),
      );
      const quote = (side: 1 | 2, price: number, amount: number): bigint =>
        (BigInt(amount) * BigInt(side === SIDE_BID ? price : 1_000 - price)) /
        1_000n;
      const fee = (executedCost: bigint): bigint => executedCost / 100n;
      const fetchBalance = (user: Keypair) =>
        clobProgram.account.userBalance.fetch(
          deriveUserBalancePda(
            clobProgram.programId,
            market.marketState,
            user.publicKey,
          ),
        );
      const bitmapPrices = (bitmap: readonly anchor.BN[]): number[] => {
        const prices: number[] = [];
        for (let price = 1; price < 1_000; price += 1) {
          const word = BigInt(bitmap[Math.floor(price / 64)]!.toString());
          if ((word & (1n << BigInt(price % 64))) !== 0n) prices.push(price);
        }
        return prices;
      };
      const assertBook = async (
        expectedBids: number[],
        expectedAsks: number[],
      ): Promise<void> => {
        const state = await clobProgram.account.marketState.fetch(
          market.marketState,
        );
        assert.deepStrictEqual(
          bitmapPrices(state.bidBitmap),
          expectedBids,
          `${planLabel}: bid bitmap drift`,
        );
        assert.deepStrictEqual(
          bitmapPrices(state.askBitmap),
          expectedAsks,
          `${planLabel}: ask bitmap drift`,
        );
        assert.strictEqual(
          Number(state.bestBid),
          expectedBids.at(-1) ?? 0,
          `${planLabel}: best bid drift`,
        );
        assert.strictEqual(
          Number(state.bestAsk),
          expectedAsks[0] ?? 1_000,
          `${planLabel}: best ask drift`,
        );
      };

      assert.ok(askPrices[0]! < askPrices[1]!);
      assert.ok(askPrices[1]! < askPrices[2]!);
      assert.ok(askPrices[2]! < sweepPrice);
      assert.ok(sweepPrice < postOnlyAskPrice);
      assert.ok(postOnlyAskPrice < finalBidPrice);
      assert.ok(finalBidPrice < 1_000);

      const askOrders = [];
      for (let index = 0; index < askMakers.length; index += 1) {
        askOrders.push(
          await placeClobOrder(clobProgram, {
            marketState: market.marketState,
            duelState: market.duelState,
            config: market.config,
            treasury: market.treasury,
            marketMaker: market.marketMaker,
            vault: market.vault,
            user: askMakers[index]!,
            orderId: index + 1,
            side: SIDE_ASK,
            price: askPrices[index]!,
            amount: askAmounts[index]!,
            orderBehavior: ORDER_BEHAVIOR_GTC,
          }),
        );
      }
      await assertBook([], askPrices);

      const totalAskAmount = askAmounts.reduce(
        (sum, amount) => sum + amount,
        0,
      );
      const executedSweepCost = askPrices.reduce(
        (sum, price, index) => sum + quote(SIDE_BID, price, askAmounts[index]!),
        0n,
      );
      const initialAskLiability = askPrices.reduce(
        (sum, price, index) => sum + quote(SIDE_ASK, price, askAmounts[index]!),
        0n,
      );
      const sweepFee = fee(executedSweepCost);
      const sweepingBid = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: sweepingBidder,
        orderId: 4,
        side: SIDE_BID,
        price: sweepPrice,
        amount: totalAskAmount + 1_000,
        orderBehavior: ORDER_BEHAVIOR_GTC,
        remainingAccounts: askOrders.flatMap((order) => [
          writableAccount(order.restingLevel),
          writableAccount(order.order),
          writableAccount(order.userBalance),
        ]),
      });
      await assertBook([sweepPrice], []);
      const [sweepingBalance, sweptMarket] = await Promise.all([
        fetchBalance(sweepingBidder),
        clobProgram.account.marketState.fetch(market.marketState),
      ]);
      assert.strictEqual(
        sweepingBalance.aShares.toString(),
        String(totalAskAmount),
      );
      assert.strictEqual(
        sweepingBalance.aLockedLamports.toString(),
        executedSweepCost.toString(),
      );
      assert.strictEqual(
        sweepingBalance.tradeTreasuryFeeLamports.toString(),
        sweepFee.toString(),
      );
      assert.strictEqual(
        sweepingBalance.tradeMarketMakerFeeLamports.toString(),
        sweepFee.toString(),
      );
      assert.strictEqual(
        sweptMarket.accruedTradeTreasuryFeeLamports.toString(),
        sweepFee.toString(),
      );
      assert.strictEqual(
        sweptMarket.accruedTradeMarketMakerFeeLamports.toString(),
        sweepFee.toString(),
      );
      assert.strictEqual(
        BigInt(await provider.connection.getBalance(market.vault)) -
          vaultBaseline,
        initialAskLiability +
          executedSweepCost +
          BigInt(sweepPrice) +
          sweepFee * 2n,
        `${planLabel}: generated sweep custody drift`,
      );

      const postOnlyAsk = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: postOnlyMaker,
        orderId: 5,
        side: SIDE_ASK,
        price: postOnlyAskPrice,
        amount: 1_000,
        orderBehavior: ORDER_BEHAVIOR_POST_ONLY,
      });
      await assertBook([sweepPrice], [postOnlyAskPrice]);

      const beforeBlockedPostOnly = await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        provider.connection.getBalance(market.vault),
      ]);
      try {
        await placeClobOrder(clobProgram, {
          marketState: market.marketState,
          duelState: market.duelState,
          config: market.config,
          treasury: market.treasury,
          marketMaker: market.marketMaker,
          vault: market.vault,
          user: blockedPostOnlyMaker,
          orderId: 6,
          side: SIDE_ASK,
          price: sweepPrice,
          amount: 1_000,
          orderBehavior: ORDER_BEHAVIOR_POST_ONLY,
        });
        assert.fail(
          `${planLabel}: crossing generated post-only order succeeded`,
        );
      } catch (error) {
        assert.ok(
          hasProgramError(error, "PostOnlyWouldCross"),
          `${planLabel}: expected PostOnlyWouldCross, got ${String(error)}`,
        );
      }
      const [afterBlockedPostOnly, blockedOrder, blockedBalance] =
        await Promise.all([
          clobProgram.account.marketState.fetch(market.marketState),
          clobProgram.account.order.fetchNullable(
            deriveOrderPda(clobProgram.programId, market.marketState, 6),
          ),
          clobProgram.account.userBalance.fetchNullable(
            deriveUserBalancePda(
              clobProgram.programId,
              market.marketState,
              blockedPostOnlyMaker.publicKey,
            ),
          ),
        ]);
      assert.strictEqual(
        afterBlockedPostOnly.nextOrderId.toString(),
        beforeBlockedPostOnly[0].nextOrderId.toString(),
      );
      assert.strictEqual(
        await provider.connection.getBalance(market.vault),
        beforeBlockedPostOnly[1],
      );
      assert.strictEqual(blockedOrder, null);
      assert.strictEqual(blockedBalance, null);

      const iocPrice = sweepPrice - 100;
      const iocExecutedCost = BigInt(1_000 - sweepPrice);
      const iocFee = fee(iocExecutedCost);
      const iocAsk = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: iocSeller,
        orderId: 6,
        side: SIDE_ASK,
        price: iocPrice,
        amount: 2_000,
        orderBehavior: ORDER_BEHAVIOR_IOC,
        remainingAccounts: [
          writableAccount(sweepingBid.restingLevel),
          writableAccount(sweepingBid.order),
          writableAccount(sweepingBid.userBalance),
        ],
      });
      assert.strictEqual(
        await clobProgram.account.order.fetchNullable(iocAsk.order),
        null,
      );
      await assertBook([], [postOnlyAskPrice]);
      const [sweeperAfterIoc, iocBalance] = await Promise.all([
        fetchBalance(sweepingBidder),
        fetchBalance(iocSeller),
      ]);
      assert.strictEqual(
        sweeperAfterIoc.aShares.toString(),
        String(totalAskAmount + 1_000),
      );
      assert.strictEqual(
        sweeperAfterIoc.aLockedLamports.toString(),
        (executedSweepCost + BigInt(sweepPrice)).toString(),
      );
      assert.strictEqual(iocBalance.bShares.toString(), "1000");
      assert.strictEqual(
        iocBalance.bLockedLamports.toString(),
        iocExecutedCost.toString(),
      );
      assert.strictEqual(
        iocBalance.tradeTreasuryFeeLamports.toString(),
        iocFee.toString(),
      );
      assert.strictEqual(
        iocBalance.tradeMarketMakerFeeLamports.toString(),
        iocFee.toString(),
      );

      const finalExecutedCost = BigInt(postOnlyAskPrice);
      const finalFee = fee(finalExecutedCost);
      const finalBid = await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: finalBidder,
        orderId: 7,
        side: SIDE_BID,
        price: finalBidPrice,
        amount: 2_000,
        orderBehavior: ORDER_BEHAVIOR_GTC,
        remainingAccounts: [
          writableAccount(postOnlyAsk.restingLevel),
          writableAccount(postOnlyAsk.order),
          writableAccount(postOnlyAsk.userBalance),
        ],
      });
      await assertBook([finalBidPrice], []);
      const [finalBidBalance, finalMarket] = await Promise.all([
        fetchBalance(finalBidder),
        clobProgram.account.marketState.fetch(market.marketState),
      ]);
      assert.strictEqual(finalBidBalance.aShares.toString(), "1000");
      assert.strictEqual(
        finalBidBalance.aLockedLamports.toString(),
        finalExecutedCost.toString(),
      );
      assert.strictEqual(
        finalBidBalance.tradeTreasuryFeeLamports.toString(),
        finalFee.toString(),
      );
      assert.strictEqual(
        finalBidBalance.tradeMarketMakerFeeLamports.toString(),
        finalFee.toString(),
      );
      const totalFees = sweepFee + iocFee + finalFee;
      assert.strictEqual(
        finalMarket.accruedTradeTreasuryFeeLamports.toString(),
        totalFees.toString(),
      );
      assert.strictEqual(
        finalMarket.accruedTradeMarketMakerFeeLamports.toString(),
        totalFees.toString(),
      );
      const expectedFinalLiability =
        initialAskLiability +
        executedSweepCost +
        BigInt(sweepPrice) +
        BigInt(1_000 - postOnlyAskPrice) +
        iocExecutedCost +
        finalExecutedCost +
        BigInt(finalBidPrice) +
        totalFees * 2n;
      assert.strictEqual(
        BigInt(await provider.connection.getBalance(market.vault)) -
          vaultBaseline,
        expectedFinalLiability,
        `${planLabel}: generated mixed-behavior vault liability drift`,
      );

      await cancelDuel(fightProgram, authority, market.duelKey);
      await syncMarketFromDuel(
        clobProgram,
        market.marketState,
        market.duelState,
      );
      await reclaimClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        vault: market.vault,
        user: finalBidder,
        orderId: 7,
        side: SIDE_BID,
        price: finalBidPrice,
      });
      assert.strictEqual(
        await clobProgram.account.order.fetchNullable(finalBid.order),
        null,
      );
      await assertBook([], []);

      for (const participant of [
        ...askMakers,
        sweepingBidder,
        postOnlyMaker,
        iocSeller,
        finalBidder,
      ]) {
        await claimClobWinnings(clobProgram, {
          marketState: market.marketState,
          duelState: market.duelState,
          config: market.config,
          marketMaker: market.marketMaker,
          vault: market.vault,
          user: participant,
        });
        assert.strictEqual(
          await clobProgram.account.userBalance.fetchNullable(
            deriveUserBalancePda(
              clobProgram.programId,
              market.marketState,
              participant.publicKey,
            ),
          ),
          null,
        );
      }
      assert.strictEqual(
        BigInt(await provider.connection.getBalance(market.vault)),
        vaultBaseline,
        `${planLabel}: generated terminal refunds did not restore the vault baseline`,
      );

      for (const [orderId, maker] of [
        [1, askMakers[0]!],
        [2, askMakers[1]!],
        [3, askMakers[2]!],
        [4, sweepingBidder],
        [5, postOnlyMaker],
      ] as const) {
        await closeFilledClobOrder(clobProgram, {
          marketState: market.marketState,
          user: maker,
          orderId,
        });
        assert.strictEqual(
          await clobProgram.account.order.fetchNullable(
            deriveOrderPda(clobProgram.programId, market.marketState, orderId),
          ),
          null,
        );
      }
      for (const [side, price, rentRecipient] of [
        [SIDE_ASK, askPrices[0]!, askMakers[0]!],
        [SIDE_ASK, askPrices[1]!, askMakers[1]!],
        [SIDE_ASK, askPrices[2]!, askMakers[2]!],
        [SIDE_BID, sweepPrice, sweepingBidder],
        [SIDE_ASK, postOnlyAskPrice, postOnlyMaker],
        [SIDE_BID, finalBidPrice, finalBidder],
      ] as const) {
        await closeEmptyClobPriceLevel(clobProgram, {
          marketState: market.marketState,
          side,
          price,
          rentRecipient: rentRecipient.publicKey,
          closer: authority,
        });
        assert.strictEqual(
          await clobProgram.account.priceLevel.fetchNullable(
            derivePriceLevelPda(
              clobProgram.programId,
              market.marketState,
              side,
              price,
            ),
          ),
          null,
        );
      }
    });
  }

  it("conserves custody while traversing multiple prices across GTC, IOC, and post-only behavior", async () => {
    const askMaker250 = Keypair.generate();
    const askMaker400 = Keypair.generate();
    const askMaker700 = Keypair.generate();
    const sweepingBidder = Keypair.generate();
    const postOnlyMaker = Keypair.generate();
    const iocSeller = Keypair.generate();
    const finalBidder = Keypair.generate();
    const blockedPostOnlyMaker = Keypair.generate();
    const participants = [
      askMaker250,
      askMaker400,
      askMaker700,
      sweepingBidder,
      postOnlyMaker,
      iocSeller,
      finalBidder,
      blockedPostOnlyMaker,
    ];
    await Promise.all(
      participants.map((participant) =>
        airdrop(provider.connection, participant.publicKey, 5),
      ),
    );

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("multi-price-mixed-behavior"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
      },
    );
    const vaultBaseline = await provider.connection.getBalance(market.vault);

    const bitmapPrices = (bitmap: readonly anchor.BN[]): number[] => {
      const prices: number[] = [];
      for (let price = 1; price < 1000; price += 1) {
        const word = BigInt(bitmap[Math.floor(price / 64)]!.toString());
        if ((word & (1n << BigInt(price % 64))) !== 0n) prices.push(price);
      }
      return prices;
    };
    const assertBook = async (
      expectedBidPrices: number[],
      expectedAskPrices: number[],
      expectedBestBid: number,
      expectedBestAsk: number,
    ): Promise<void> => {
      const state = await clobProgram.account.marketState.fetch(
        market.marketState,
      );
      assert.deepStrictEqual(bitmapPrices(state.bidBitmap), expectedBidPrices);
      assert.deepStrictEqual(bitmapPrices(state.askBitmap), expectedAskPrices);
      assert.strictEqual(Number(state.bestBid), expectedBestBid);
      assert.strictEqual(Number(state.bestAsk), expectedBestAsk);
    };
    const assertLevel = async (
      side: number,
      price: number,
      head: number,
      tail: number,
      totalOpen: number,
    ): Promise<void> => {
      const level = await clobProgram.account.priceLevel.fetch(
        derivePriceLevelPda(
          clobProgram.programId,
          market.marketState,
          side,
          price,
        ),
      );
      assert.strictEqual(Number(level.side), side);
      assert.strictEqual(Number(level.price), price);
      assert.strictEqual(Number(level.headOrderId), head);
      assert.strictEqual(Number(level.tailOrderId), tail);
      assert.strictEqual(Number(level.totalOpen), totalOpen);
    };
    const fetchBalance = (user: Keypair) =>
      clobProgram.account.userBalance.fetch(
        deriveUserBalancePda(
          clobProgram.programId,
          market.marketState,
          user.publicKey,
        ),
      );

    const ask250 = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: askMaker250,
      orderId: 1,
      side: SIDE_ASK,
      price: 250,
      amount: 1_000,
    });
    const ask400 = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: askMaker400,
      orderId: 2,
      side: SIDE_ASK,
      price: 400,
      amount: 2_000,
    });
    const ask700 = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: askMaker700,
      orderId: 3,
      side: SIDE_ASK,
      price: 700,
      amount: 1_000,
    });
    await assertBook([], [250, 400, 700], 0, 250);
    await assertLevel(SIDE_ASK, 250, 1, 1, 1_000);
    await assertLevel(SIDE_ASK, 400, 2, 2, 2_000);
    await assertLevel(SIDE_ASK, 700, 3, 3, 1_000);
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) - vaultBaseline,
      2_250,
    );

    const captureBoundaryRollbackState = async () => {
      const [state, vaultLamports, levels, orders, balances] =
        await Promise.all([
          clobProgram.account.marketState.fetch(market.marketState),
          provider.connection.getBalance(market.vault),
          Promise.all(
            [250, 400, 700].map(async (price) => {
              const level = await clobProgram.account.priceLevel.fetch(
                derivePriceLevelPda(
                  clobProgram.programId,
                  market.marketState,
                  SIDE_ASK,
                  price,
                ),
              );
              return {
                price: Number(level.price),
                side: Number(level.side),
                headOrderId: level.headOrderId.toString(),
                tailOrderId: level.tailOrderId.toString(),
                totalOpen: level.totalOpen.toString(),
                rentRecipient: (
                  level.rentRecipient as anchor.web3.PublicKey
                ).toBase58(),
              };
            }),
          ),
          Promise.all(
            [1, 2, 3].map(async (orderId) => {
              const order = await clobProgram.account.order.fetch(
                deriveOrderPda(
                  clobProgram.programId,
                  market.marketState,
                  orderId,
                ),
              );
              return {
                id: order.id.toString(),
                side: Number(order.side),
                price: Number(order.price),
                maker: (order.maker as anchor.web3.PublicKey).toBase58(),
                amount: order.amount.toString(),
                filled: order.filled.toString(),
                previousOrderId: order.prevOrderId.toString(),
                nextOrderId: order.nextOrderId.toString(),
                active: order.active,
                continuationPending: order.continuationPending,
              };
            }),
          ),
          Promise.all(
            [askMaker250, askMaker400, askMaker700].map(async (maker) => {
              const balance = await fetchBalance(maker);
              return {
                user: (balance.user as anchor.web3.PublicKey).toBase58(),
                aShares: balance.aShares.toString(),
                bShares: balance.bShares.toString(),
                aLockedLamports: balance.aLockedLamports.toString(),
                bLockedLamports: balance.bLockedLamports.toString(),
                tradeTreasuryFeeLamports:
                  balance.tradeTreasuryFeeLamports.toString(),
                tradeMarketMakerFeeLamports:
                  balance.tradeMarketMakerFeeLamports.toString(),
              };
            }),
          ),
        ]);
      return {
        market: {
          nextOrderId: state.nextOrderId.toString(),
          bestBid: Number(state.bestBid),
          bestAsk: Number(state.bestAsk),
          bidBitmap: state.bidBitmap.map((word) => word.toString()),
          askBitmap: state.askBitmap.map((word) => word.toString()),
          accruedTradeTreasuryFeeLamports:
            state.accruedTradeTreasuryFeeLamports.toString(),
          accruedTradeMarketMakerFeeLamports:
            state.accruedTradeMarketMakerFeeLamports.toString(),
        },
        vaultLamports,
        levels,
        orders,
        balances,
      };
    };
    const firstMatch = [
      writableAccount(ask250.restingLevel),
      writableAccount(ask250.order),
      writableAccount(ask250.userBalance),
    ];
    const secondMatch = [
      writableAccount(ask400.restingLevel),
      writableAccount(ask400.order),
      writableAccount(ask400.userBalance),
    ];
    const boundaryMutationCases: Array<{
      label: string;
      expectedCodes: string[];
      remainingAccounts: anchor.web3.AccountMeta[];
    }> = [
      {
        label: "starts from a non-boundary level",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: secondMatch,
      },
      {
        label: "uses another level's order at the best level",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: [
          writableAccount(ask250.restingLevel),
          writableAccount(ask400.order),
          writableAccount(ask400.userBalance),
        ],
      },
      {
        label: "uses another maker balance for the best order",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: [
          writableAccount(ask250.restingLevel),
          writableAccount(ask250.order),
          writableAccount(ask400.userBalance),
        ],
      },
      {
        label: "reorders the best level and head order",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: [
          writableAccount(ask250.order),
          writableAccount(ask250.restingLevel),
          writableAccount(ask250.userBalance),
        ],
      },
      {
        label: "omits the best maker balance",
        expectedCodes: ["MissingMatchAccounts"],
        remainingAccounts: [
          writableAccount(ask250.restingLevel),
          writableAccount(ask250.order),
        ],
      },
      {
        label: "duplicates the best order in the balance slot",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: [
          writableAccount(ask250.restingLevel),
          writableAccount(ask250.order),
          writableAccount(ask250.order),
        ],
      },
      {
        label: "jumps over the second boundary after one valid fill",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: [
          ...firstMatch,
          writableAccount(ask700.restingLevel),
          writableAccount(ask700.order),
          writableAccount(ask700.userBalance),
        ],
      },
      {
        label: "uses the third order at the second boundary",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: [
          ...firstMatch,
          writableAccount(ask400.restingLevel),
          writableAccount(ask700.order),
          writableAccount(ask700.userBalance),
        ],
      },
      {
        label: "uses the third maker balance at the second boundary",
        expectedCodes: ["InvalidRemainingAccount"],
        remainingAccounts: [
          ...firstMatch,
          writableAccount(ask400.restingLevel),
          writableAccount(ask400.order),
          writableAccount(ask700.userBalance),
        ],
      },
    ];
    const boundaryRollbackBaseline = await captureBoundaryRollbackState();
    for (const mutation of boundaryMutationCases) {
      try {
        await placeClobOrder(clobProgram, {
          marketState: market.marketState,
          duelState: market.duelState,
          config: market.config,
          treasury: market.treasury,
          marketMaker: market.marketMaker,
          vault: market.vault,
          user: sweepingBidder,
          orderId: 4,
          side: SIDE_BID,
          price: 750,
          amount: 5_000,
          orderBehavior: ORDER_BEHAVIOR_GTC,
          remainingAccounts: mutation.remainingAccounts,
        });
        assert.fail(`boundary mutation succeeded: ${mutation.label}`);
      } catch (error) {
        assert.ok(
          mutation.expectedCodes.some((code) => hasProgramError(error, code)),
          `${mutation.label}: expected ${mutation.expectedCodes.join(" or ")}, got ${String(error)}`,
        );
      }
      const [afterMutation, wouldBeOrder, wouldBeBalance] = await Promise.all([
        captureBoundaryRollbackState(),
        clobProgram.account.order.fetchNullable(
          deriveOrderPda(clobProgram.programId, market.marketState, 4),
        ),
        clobProgram.account.userBalance.fetchNullable(
          deriveUserBalancePda(
            clobProgram.programId,
            market.marketState,
            sweepingBidder.publicKey,
          ),
        ),
      ]);
      assert.deepStrictEqual(
        afterMutation,
        boundaryRollbackBaseline,
        `${mutation.label}: multi-price boundary mutation did not roll back atomically`,
      );
      assert.strictEqual(wouldBeOrder, null);
      assert.strictEqual(wouldBeBalance, null);
    }
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) - vaultBaseline,
      2_250,
      "wrong-boundary account rejection must roll back every custody and account mutation",
    );
    await assertBook([], [250, 400, 700], 0, 250);

    const sweepingBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: sweepingBidder,
      orderId: 4,
      side: SIDE_BID,
      price: 750,
      amount: 5_000,
      orderBehavior: ORDER_BEHAVIOR_GTC,
      remainingAccounts: [ask250, ask400, ask700].flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]),
    });
    await assertBook([750], [], 750, 1000);
    await assertLevel(SIDE_ASK, 250, 0, 0, 0);
    await assertLevel(SIDE_ASK, 400, 0, 0, 0);
    await assertLevel(SIDE_ASK, 700, 0, 0, 0);
    await assertLevel(SIDE_BID, 750, 4, 4, 1_000);
    const [sweepingBalance, sweptMarket, sweepingOrder] = await Promise.all([
      fetchBalance(sweepingBidder),
      clobProgram.account.marketState.fetch(market.marketState),
      clobProgram.account.order.fetch(sweepingBid.order),
    ]);
    assert.strictEqual(sweepingBalance.aShares.toString(), "4000");
    assert.strictEqual(sweepingBalance.aLockedLamports.toString(), "1750");
    assert.strictEqual(
      sweepingBalance.tradeTreasuryFeeLamports.toString(),
      "17",
    );
    assert.strictEqual(
      sweepingBalance.tradeMarketMakerFeeLamports.toString(),
      "17",
    );
    assert.strictEqual(sweepingOrder.amount.toString(), "1000");
    assert.strictEqual(sweepingOrder.filled.toString(), "0");
    assert.strictEqual(sweepingOrder.active, true);
    assert.strictEqual(
      sweptMarket.accruedTradeTreasuryFeeLamports.toString(),
      "17",
    );
    assert.strictEqual(
      sweptMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "17",
    );
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) - vaultBaseline,
      4_784,
      "three matched ask liabilities, improved bid fills, one resting bid, and both fee escrows must reconcile",
    );

    const postOnlyAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: postOnlyMaker,
      orderId: 5,
      side: SIDE_ASK,
      price: 800,
      amount: 1_000,
      orderBehavior: ORDER_BEHAVIOR_POST_ONLY,
    });
    await assertBook([750], [800], 750, 800);
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) - vaultBaseline,
      4_984,
    );

    const beforeRejectedPostOnly = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    const vaultBeforeRejectedPostOnly = await provider.connection.getBalance(
      market.vault,
    );
    try {
      await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: blockedPostOnlyMaker,
        orderId: 6,
        side: SIDE_ASK,
        price: 700,
        amount: 1_000,
        orderBehavior: ORDER_BEHAVIOR_POST_ONLY,
      });
      assert.fail("crossing post-only order succeeded");
    } catch (error) {
      assert.ok(
        hasProgramError(error, "PostOnlyWouldCross"),
        `expected PostOnlyWouldCross, got ${String(error)}`,
      );
    }
    const [afterRejectedPostOnly, blockedOrder, blockedBalance] =
      await Promise.all([
        clobProgram.account.marketState.fetch(market.marketState),
        clobProgram.account.order.fetchNullable(
          deriveOrderPda(clobProgram.programId, market.marketState, 6),
        ),
        clobProgram.account.userBalance.fetchNullable(
          deriveUserBalancePda(
            clobProgram.programId,
            market.marketState,
            blockedPostOnlyMaker.publicKey,
          ),
        ),
      ]);
    assert.strictEqual(
      afterRejectedPostOnly.nextOrderId.toString(),
      beforeRejectedPostOnly.nextOrderId.toString(),
    );
    assert.strictEqual(blockedOrder, null);
    assert.strictEqual(blockedBalance, null);
    assert.strictEqual(
      await provider.connection.getBalance(market.vault),
      vaultBeforeRejectedPostOnly,
    );

    const iocAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: iocSeller,
      orderId: 6,
      side: SIDE_ASK,
      price: 700,
      amount: 2_000,
      orderBehavior: ORDER_BEHAVIOR_IOC,
      remainingAccounts: [
        writableAccount(sweepingBid.restingLevel),
        writableAccount(sweepingBid.order),
        writableAccount(sweepingBid.userBalance),
      ],
    });
    await assertBook([], [800], 0, 800);
    await assertLevel(SIDE_BID, 750, 0, 0, 0);
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(iocAsk.order),
      null,
    );
    const [sweepingAfterIoc, iocBalance, afterIocMarket] = await Promise.all([
      fetchBalance(sweepingBidder),
      fetchBalance(iocSeller),
      clobProgram.account.marketState.fetch(market.marketState),
    ]);
    assert.strictEqual(sweepingAfterIoc.aShares.toString(), "5000");
    assert.strictEqual(sweepingAfterIoc.aLockedLamports.toString(), "2500");
    assert.strictEqual(iocBalance.bShares.toString(), "1000");
    assert.strictEqual(iocBalance.bLockedLamports.toString(), "250");
    assert.strictEqual(iocBalance.tradeTreasuryFeeLamports.toString(), "2");
    assert.strictEqual(iocBalance.tradeMarketMakerFeeLamports.toString(), "2");
    assert.strictEqual(
      afterIocMarket.accruedTradeTreasuryFeeLamports.toString(),
      "19",
    );
    assert.strictEqual(
      afterIocMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "19",
    );
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) - vaultBaseline,
      5_238,
      "IOC must retain only the 250-lamport fill plus two 2-lamport fees while refunding its remainder and improvement",
    );

    const finalBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: finalBidder,
      orderId: 7,
      side: SIDE_BID,
      price: 850,
      amount: 2_000,
      orderBehavior: ORDER_BEHAVIOR_GTC,
      remainingAccounts: [
        writableAccount(postOnlyAsk.restingLevel),
        writableAccount(postOnlyAsk.order),
        writableAccount(postOnlyAsk.userBalance),
      ],
    });
    await assertBook([850], [], 850, 1000);
    await assertLevel(SIDE_ASK, 800, 0, 0, 0);
    await assertLevel(SIDE_BID, 850, 7, 7, 1_000);
    const [finalBidBalance, finalMarket] = await Promise.all([
      fetchBalance(finalBidder),
      clobProgram.account.marketState.fetch(market.marketState),
    ]);
    assert.strictEqual(finalBidBalance.aShares.toString(), "1000");
    assert.strictEqual(finalBidBalance.aLockedLamports.toString(), "800");
    assert.strictEqual(
      finalBidBalance.tradeTreasuryFeeLamports.toString(),
      "8",
    );
    assert.strictEqual(
      finalBidBalance.tradeMarketMakerFeeLamports.toString(),
      "8",
    );
    assert.strictEqual(
      finalMarket.accruedTradeTreasuryFeeLamports.toString(),
      "27",
    );
    assert.strictEqual(
      finalMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "27",
    );
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) - vaultBaseline,
      6_904,
      "all matched custody, one 850-lamport remainder, and 54 fee lamports must reconcile",
    );

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);
    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: finalBidder,
      orderId: 7,
      side: SIDE_BID,
      price: 850,
    });
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(finalBid.order),
      null,
      "terminal reclaim must return the resting order rent atomically",
    );
    await assertBook([], [], 0, 1000);
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) - vaultBaseline,
      6_054,
    );

    for (const participant of [
      askMaker250,
      askMaker400,
      askMaker700,
      sweepingBidder,
      postOnlyMaker,
      iocSeller,
      finalBidder,
    ]) {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: participant,
      });
      assert.strictEqual(
        await clobProgram.account.userBalance.fetchNullable(
          deriveUserBalancePda(
            clobProgram.programId,
            market.marketState,
            participant.publicKey,
          ),
        ),
        null,
      );
    }
    assert.strictEqual(
      await provider.connection.getBalance(market.vault),
      vaultBaseline,
      "terminal refunds must restore the exact native-vault baseline",
    );

    for (const [orderId, maker] of [
      [1, askMaker250],
      [2, askMaker400],
      [3, askMaker700],
      [4, sweepingBidder],
      [5, postOnlyMaker],
    ] as const) {
      assert.ok(
        await clobProgram.account.order.fetchNullable(
          deriveOrderPda(clobProgram.programId, market.marketState, orderId),
        ),
        `expected terminal order ${orderId} to remain available for maker-rent cleanup`,
      );
      await closeFilledClobOrder(clobProgram, {
        marketState: market.marketState,
        user: maker,
        orderId,
      });
      assert.strictEqual(
        await clobProgram.account.order.fetchNullable(
          deriveOrderPda(clobProgram.programId, market.marketState, orderId),
        ),
        null,
      );
    }
    for (const [side, price, rentRecipient] of [
      [SIDE_ASK, 250, askMaker250],
      [SIDE_ASK, 400, askMaker400],
      [SIDE_ASK, 700, askMaker700],
      [SIDE_BID, 750, sweepingBidder],
      [SIDE_ASK, 800, postOnlyMaker],
      [SIDE_BID, 850, finalBidder],
    ] as const) {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side,
        price,
        rentRecipient: rentRecipient.publicKey,
        closer: authority,
      });
      assert.strictEqual(
        await clobProgram.account.priceLevel.fetchNullable(
          derivePriceLevelPda(
            clobProgram.programId,
            market.marketState,
            side,
            price,
          ),
        ),
        null,
      );
    }
  });

  it("returns an empty shared PriceLevel only to its immutable first payer under concurrent cleanup", async () => {
    const firstPayer = Keypair.generate();
    const middleMaker = Keypair.generate();
    const laterMaker = Keypair.generate();
    const closerOne = Keypair.generate();
    const closerTwo = Keypair.generate();
    const wrongRecipient = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, firstPayer.publicKey, 5),
      airdrop(provider.connection, middleMaker.publicKey, 5),
      airdrop(provider.connection, laterMaker.publicKey, 5),
      airdrop(provider.connection, closerOne.publicKey, 2),
      airdrop(provider.connection, closerTwo.publicKey, 2),
      airdrop(provider.connection, wrongRecipient.publicKey, 2),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("price-level-first-payer") },
    );
    const firstOrder = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: firstPayer,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });
    const priceLevelRent = BigInt(
      await provider.connection.getBalance(firstOrder.restingLevel),
    );
    assert.ok(priceLevelRent > 0n);

    const middleOrder = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: middleMaker,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
      remainingAccounts: [writableAccount(firstOrder.order)],
    });
    const laterOrder = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: laterMaker,
      orderId: 3,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
      remainingAccounts: [writableAccount(middleOrder.order)],
    });
    const reusedLevel = await clobProgram.account.priceLevel.fetch(
      firstOrder.restingLevel,
    );
    assert.ok(reusedLevel.rentRecipient.equals(firstPayer.publicKey));
    assert.strictEqual(reusedLevel.headOrderId.toString(), "1");
    assert.strictEqual(reusedLevel.tailOrderId.toString(), "3");
    assert.strictEqual(reusedLevel.totalOpen.toString(), "3000");

    try {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_ASK,
        price: 600,
        rentRecipient: firstPayer.publicKey,
        closer: closerOne,
      });
      assert.fail("closed a nonempty shared price level");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "PriceLevelNotEmpty"),
        `expected PriceLevelNotEmpty, got ${String(error)}`,
      );
    }

    await cancelClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: middleMaker,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
      remainingAccounts: [
        writableAccount(firstOrder.order),
        writableAccount(laterOrder.order),
      ],
    });
    const [levelAfterMiddleCancel, firstAfterMiddle, tailAfterMiddle] =
      await Promise.all([
        clobProgram.account.priceLevel.fetch(firstOrder.restingLevel),
        clobProgram.account.order.fetch(firstOrder.order),
        clobProgram.account.order.fetch(laterOrder.order),
      ]);
    assert.ok(
      levelAfterMiddleCancel.rentRecipient.equals(firstPayer.publicKey),
    );
    assert.strictEqual(levelAfterMiddleCancel.headOrderId.toString(), "1");
    assert.strictEqual(levelAfterMiddleCancel.tailOrderId.toString(), "3");
    assert.strictEqual(levelAfterMiddleCancel.totalOpen.toString(), "2000");
    assert.strictEqual(firstAfterMiddle.nextOrderId.toString(), "3");
    assert.strictEqual(tailAfterMiddle.prevOrderId.toString(), "1");

    await cancelClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: firstPayer,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      remainingAccounts: [writableAccount(laterOrder.order)],
    });
    const levelAfterHeadCancel = await clobProgram.account.priceLevel.fetch(
      firstOrder.restingLevel,
    );
    assert.ok(levelAfterHeadCancel.rentRecipient.equals(firstPayer.publicKey));
    assert.strictEqual(levelAfterHeadCancel.headOrderId.toString(), "3");
    assert.strictEqual(levelAfterHeadCancel.tailOrderId.toString(), "3");
    assert.strictEqual(levelAfterHeadCancel.totalOpen.toString(), "1000");

    await cancelClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: laterMaker,
      orderId: 3,
      side: SIDE_ASK,
      price: 600,
    });
    const emptyLevel = await clobProgram.account.priceLevel.fetch(
      firstOrder.restingLevel,
    );
    assert.ok(emptyLevel.rentRecipient.equals(firstPayer.publicKey));
    assert.strictEqual(emptyLevel.headOrderId.toString(), "0");
    assert.strictEqual(emptyLevel.tailOrderId.toString(), "0");
    assert.strictEqual(emptyLevel.totalOpen.toString(), "0");
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(firstOrder.restingLevel)),
      priceLevelRent,
    );

    const unrelatedIoc = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: laterMaker,
      orderId: 4,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
      orderBehavior: ORDER_BEHAVIOR_IOC,
    });
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(unrelatedIoc.order),
      null,
    );
    const levelAfterUnrelatedReuse = await clobProgram.account.priceLevel.fetch(
      firstOrder.restingLevel,
    );
    assert.ok(
      levelAfterUnrelatedReuse.rentRecipient.equals(firstPayer.publicKey),
    );
    assert.strictEqual(levelAfterUnrelatedReuse.headOrderId.toString(), "0");
    assert.strictEqual(levelAfterUnrelatedReuse.tailOrderId.toString(), "0");
    assert.strictEqual(levelAfterUnrelatedReuse.totalOpen.toString(), "0");
    assert.strictEqual(
      BigInt(await provider.connection.getBalance(firstOrder.restingLevel)),
      priceLevelRent,
    );

    try {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_ASK,
        price: 600,
        rentRecipient: wrongRecipient.publicKey,
        closer: closerOne,
      });
      assert.fail("redirected shared price-level rent");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidPriceLevelRentRecipient"),
        `expected InvalidPriceLevelRentRecipient, got ${String(error)}`,
      );
    }
    assert.notStrictEqual(
      await clobProgram.account.priceLevel.fetchNullable(
        firstOrder.restingLevel,
      ),
      null,
    );

    const concurrentCleanup = await Promise.allSettled([
      closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_ASK,
        price: 600,
        rentRecipient: firstPayer.publicKey,
        closer: closerOne,
      }),
      closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_ASK,
        price: 600,
        rentRecipient: firstPayer.publicKey,
        closer: closerTwo,
      }),
    ]);
    const fulfilled = concurrentCleanup.filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        priceLevel: anchor.web3.PublicKey;
        signature: string;
      }> => result.status === "fulfilled",
    );
    const rejected = concurrentCleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);

    const successfulCloser =
      concurrentCleanup[0].status === "fulfilled" ? closerOne : closerTwo;
    const recipientAccounting = await confirmedWalletDelta(
      fulfilled[0].value.signature,
      firstPayer.publicKey,
    );
    const closerAccounting = await confirmedWalletDelta(
      fulfilled[0].value.signature,
      successfulCloser.publicKey,
    );
    assert.strictEqual(recipientAccounting.delta, priceLevelRent);
    assert.strictEqual(recipientAccounting.feePaidByWallet, 0n);
    assert.strictEqual(
      closerAccounting.delta + closerAccounting.feePaidByWallet,
      0n,
    );
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(
        firstOrder.restingLevel,
      ),
      null,
    );

    try {
      await closeEmptyClobPriceLevel(clobProgram, {
        marketState: market.marketState,
        side: SIDE_ASK,
        price: 600,
        rentRecipient: firstPayer.publicKey,
        closer: closerOne,
      });
      assert.fail("closed a shared price level twice");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "AccountNotInitialized") ||
          hasProgramError(error, "AccountOwnedByWrongProgram"),
        `expected a closed-account error, got ${String(error)}`,
      );
    }
  });

  it("prevents direct self-crosses with cancel-taker telemetry", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const selfTrader = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, treasury.publicKey, 2),
      airdrop(provider.connection, marketMaker.publicKey, 2),
      airdrop(provider.connection, selfTrader.publicKey, 8),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("self-cross-direct"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
      },
    );

    const [treasuryBefore, marketMakerBefore] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
    ]);

    const ask = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: selfTrader,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    const bid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: selfTrader,
      orderId: 2,
      side: SIDE_BID,
      price: 600,
      amount: 1000,
      remainingAccounts: [
        writableAccount(ask.restingLevel),
        writableAccount(ask.order),
        writableAccount(ask.userBalance),
      ],
    });

    const tx = await provider.connection.getTransaction(bid.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logText = (tx?.meta?.logMessages ?? []).join("\n");
    assert.ok(
      logText.includes("policy=cancel-taker prevented=true"),
      `expected self-trade detection log, got logs: ${logText}`,
    );

    const priceLevel = await clobProgram.account.priceLevel.fetch(
      ask.restingLevel,
    );
    const makerOrder = await clobProgram.account.order.fetch(ask.order);
    const balance = await clobProgram.account.userBalance.fetch(
      ask.userBalance,
    );
    assert.strictEqual(priceLevel.totalOpen.toString(), "1000");
    assert.strictEqual(makerOrder.filled.toString(), "0");
    assert.strictEqual(makerOrder.active, true);
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(bid.order),
      null,
    );
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(bid.restingLevel),
      null,
    );
    assert.strictEqual(balance.aShares.toString(), "0");
    assert.strictEqual(balance.bShares.toString(), "0");
    const [treasuryAfter, marketMakerAfter] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
    ]);
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);
  });

  it("cancels the taker remainder when a later self-cross candidate appears", async () => {
    const selfTrader = Keypair.generate();
    const externalMaker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, selfTrader.publicKey, 8),
      airdrop(provider.connection, externalMaker.publicKey, 8),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("self-cross-partial") },
    );

    const externalAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: externalMaker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 4000,
    });

    const selfAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: selfTrader,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
      amount: 7000,
      remainingAccounts: [writableAccount(externalAsk.order)],
    });

    const bid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: selfTrader,
      orderId: 3,
      side: SIDE_BID,
      price: 600,
      amount: 8000,
      remainingAccounts: [
        writableAccount(externalAsk.restingLevel),
        writableAccount(externalAsk.order),
        writableAccount(externalAsk.userBalance),
        writableAccount(externalAsk.restingLevel),
        writableAccount(selfAsk.order),
        writableAccount(selfAsk.userBalance),
      ],
    });

    const tx = await provider.connection.getTransaction(bid.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const selfTradeLogCount = (tx?.meta?.logMessages ?? []).filter((line) =>
      line.includes("policy=cancel-taker prevented=true"),
    ).length;
    assert.strictEqual(selfTradeLogCount, 1);

    const externalOrderState = await clobProgram.account.order.fetch(
      externalAsk.order,
    );
    const selfOrderState = await clobProgram.account.order.fetch(selfAsk.order);
    const takerBalance = await clobProgram.account.userBalance.fetch(
      bid.userBalance,
    );
    assert.strictEqual(externalOrderState.filled.toString(), "4000");
    assert.strictEqual(externalOrderState.active, false);
    assert.strictEqual(selfOrderState.filled.toString(), "0");
    assert.strictEqual(selfOrderState.active, true);
    assert.strictEqual(takerBalance.aShares.toString(), "4000");
  });

  it("keeps mixed-user fills free of self-trade policy logs", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 8),
      airdrop(provider.connection, taker.publicKey, 8),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("self-cross-mixed") },
    );

    const ask = await placeClobOrder(clobProgram, {
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
      amount: 5000,
    });

    const bid = await placeClobOrder(clobProgram, {
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
      amount: 5000,
      remainingAccounts: [
        writableAccount(ask.restingLevel),
        writableAccount(ask.order),
        writableAccount(ask.userBalance),
      ],
    });

    const tx = await provider.connection.getTransaction(bid.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const hasSelfTradeLog = (tx?.meta?.logMessages ?? []).some((line) =>
      line.includes("policy=cancel-taker prevented=true"),
    );
    assert.strictEqual(hasSelfTradeLog, false);
  });

  it("rejects unsupported order behaviors", async () => {
    const trader = Keypair.generate();
    await airdrop(provider.connection, trader.publicKey, 5);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("invalid-order-behavior") },
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
        orderBehavior: 99,
      });
      assert.fail("invalid order behavior was accepted");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidOrderBehavior"),
        `expected InvalidOrderBehavior, got ${String(error)}`,
      );
    }
  });

  it("rejects post-only orders that would cross without charging taker fees", async () => {
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
      { duelKey: uniqueDuelKey("post-only-cross") },
    );

    const makerOrder = await placeClobOrder(clobProgram, {
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
    const rejectedOrder = deriveOrderPda(
      clobProgram.programId,
      market.marketState,
      2,
    );
    const rejectedUserBalance = deriveUserBalancePda(
      clobProgram.programId,
      market.marketState,
      taker.publicKey,
    );

    try {
      await placeClobOrder(clobProgram, {
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
        orderBehavior: ORDER_BEHAVIOR_POST_ONLY,
      });
      assert.fail("crossing post-only order was accepted");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "PostOnlyWouldCross"),
        `expected PostOnlyWouldCross, got ${String(error)}`,
      );
    }

    const marketState = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(marketState.nextOrderId.toString(), "2");
    assert.strictEqual(
      marketState.accruedTradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      marketState.accruedTradeMarketMakerFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(rejectedOrder),
      null,
    );
    assert.strictEqual(
      await clobProgram.account.userBalance.fetchNullable(rejectedUserBalance),
      null,
    );
    const makerBalance = await clobProgram.account.userBalance.fetch(
      makerOrder.userBalance,
    );
    assert.strictEqual(makerBalance.tradeTreasuryFeeLamports.toString(), "0");
    assert.strictEqual(
      makerBalance.tradeMarketMakerFeeLamports.toString(),
      "0",
    );
  });

  it("refunds unmatched IOC remainder instead of resting it", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const trader = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, treasury.publicKey, 2),
      airdrop(provider.connection, marketMaker.publicKey, 2),
      airdrop(provider.connection, trader.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("ioc-remainder"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
      },
    );

    const [treasuryBefore, marketMakerBefore] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
    ]);

    const bid = await placeClobOrder(clobProgram, {
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
      orderBehavior: ORDER_BEHAVIOR_IOC,
    });

    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(bid.order),
      null,
    );
    assert.strictEqual(
      await clobProgram.account.priceLevel.fetchNullable(bid.restingLevel),
      null,
    );
    const marketState = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(marketState.bestBid, 0);
    assert.strictEqual(marketState.bestAsk, 1000);
    const [treasuryAfter, marketMakerAfter] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
    ]);
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);
  });

  it("charges fees only on the filled size when a partial GTC remainder is later cancelled", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, treasury.publicKey, 2),
      airdrop(provider.connection, marketMaker.publicKey, 2),
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("partial-fill-cancel-fees"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
      },
    );

    const [treasuryBefore, marketMakerBefore] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
    ]);

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
      amount: 2000,
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });

    let treasuryAfter = await provider.connection.getBalance(
      treasury.publicKey,
    );
    let marketMakerAfter = await provider.connection.getBalance(
      marketMaker.publicKey,
    );
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);

    const cancelledOrderRent = BigInt(
      await provider.connection.getBalance(takerBid.order),
    );
    assert.ok(cancelledOrderRent > 0n);
    const cancelResult = await cancelClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: taker,
      orderId: 2,
      side: SIDE_BID,
      price: 600,
    });

    const takerOrderAfterCancel = await clobProgram.account.order.fetchNullable(
      takerBid.order,
    );
    assert.strictEqual(takerOrderAfterCancel, null);
    const cancelWalletAccounting = await confirmedWalletDelta(
      cancelResult.signature,
      taker.publicKey,
    );
    assert.strictEqual(
      cancelWalletAccounting.delta + cancelWalletAccounting.feePaidByWallet,
      600n + cancelledOrderRent,
    );
    treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    marketMakerAfter = await provider.connection.getBalance(
      marketMaker.publicKey,
    );
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);
  });

  it("requires explicit continuation when a GTC order exhausts the match bound", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, treasury.publicKey, 2),
      airdrop(provider.connection, marketMaker.publicKey, 2),
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("gtc-continuation"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
      },
    );

    const makerOrders: Array<{
      order: anchor.web3.PublicKey;
      restingLevel: anchor.web3.PublicKey;
      userBalance: anchor.web3.PublicKey;
    }> = [];

    for (let orderId = 1; orderId <= 55; orderId += 1) {
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
        amount: 1000,
        remainingAccounts:
          orderId > 1
            ? [writableAccount(makerOrders[makerOrders.length - 1]!.order)]
            : [],
      });
      makerOrders.push(placed);
    }

    const initialMatchAccounts = makerOrders
      .slice(0, 50)
      .flatMap((entry) => [
        writableAccount(entry.restingLevel),
        writableAccount(entry.order),
        writableAccount(entry.userBalance),
      ]);
    const [treasuryBefore, marketMakerBefore] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
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
      price: 600,
      amount: 55_000,
      orderBehavior: ORDER_BEHAVIOR_GTC,
      remainingAccounts: initialMatchAccounts,
    });

    const pendingOrder = await clobProgram.account.order.fetch(takerBid.order);
    assert.strictEqual(pendingOrder.active, true);
    assert.strictEqual(pendingOrder.continuationPending, true);
    assert.strictEqual(pendingOrder.amount.toString(), "5000");
    let treasuryAfter = await provider.connection.getBalance(
      treasury.publicKey,
    );
    let marketMakerAfter = await provider.connection.getBalance(
      marketMaker.publicKey,
    );
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);

    const continuationAccounts = makerOrders
      .slice(50)
      .flatMap((entry) => [
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
      price: 600,
      remainingAccounts: continuationAccounts,
    });

    assert.strictEqual(
      await clobProgram.account.order.fetchNullable(takerBid.order),
      null,
    );
    const takerBalance = await clobProgram.account.userBalance.fetch(
      takerBid.userBalance,
    );
    assert.strictEqual(takerBalance.aShares.toString(), "55000");
    treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    marketMakerAfter = await provider.connection.getBalance(
      marketMaker.publicKey,
    );
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);
    assert.strictEqual(takerBalance.tradeTreasuryFeeLamports.toString(), "330");
    assert.strictEqual(
      takerBalance.tradeMarketMakerFeeLamports.toString(),
      "330",
    );
  });

  it("reclaims continuation-pending remainder after the market locks", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    // This setup intentionally submits 56 sequential validator transactions.
    // Leave enough headroom for a loaded CI runner so the fixture reaches the
    // continuation state before the betting deadline; lockFixtureMarket still
    // proves the real time boundary before reclaiming the remainder.
    const closeSoon = Math.floor(Date.now() / 1000) + 180;
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("continuation-reclaim"),
        betOpenTs: closeSoon - 30,
        betCloseTs: closeSoon,
        duelStartTs: closeSoon + 1,
      },
    );

    const makerOrders: Array<{
      order: anchor.web3.PublicKey;
      restingLevel: anchor.web3.PublicKey;
      userBalance: anchor.web3.PublicKey;
    }> = [];

    for (let orderId = 1; orderId <= 55; orderId += 1) {
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
        amount: 1000,
        remainingAccounts:
          orderId > 1
            ? [writableAccount(makerOrders[makerOrders.length - 1]!.order)]
            : [],
      });
      makerOrders.push(placed);
    }

    const initialMatchAccounts = makerOrders
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
      price: 600,
      amount: 55_000,
      orderBehavior: ORDER_BEHAVIOR_GTC,
      remainingAccounts: initialMatchAccounts,
    });

    const pendingOrderBefore = await clobProgram.account.order.fetch(
      takerBid.order,
    );
    assert.strictEqual(pendingOrderBefore.continuationPending, true);
    const [pendingOrderRent, pendingLevelRent] = await Promise.all([
      provider.connection.getBalance(takerBid.order),
      provider.connection.getBalance(takerBid.restingLevel),
    ]);
    assert.ok(pendingOrderRent > 0);
    assert.ok(pendingLevelRent > 0);
    await lockFixtureMarket(
      market,
      "https://hyperia.gg/duels/continuation-reclaim",
    );

    const vaultBeforeReclaim = await provider.connection.getBalance(
      market.vault,
    );
    const reclaimResult = await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: taker,
      orderId: 56,
      side: SIDE_BID,
      price: 600,
    });

    const [
      pendingOrderAfterReclaim,
      pendingLevelAfterReclaim,
      takerBalance,
      vaultAfterReclaim,
      reclaimWalletAccounting,
    ] = await Promise.all([
      clobProgram.account.order.fetchNullable(takerBid.order),
      clobProgram.account.priceLevel.fetchNullable(takerBid.restingLevel),
      clobProgram.account.userBalance.fetch(takerBid.userBalance),
      provider.connection.getBalance(market.vault),
      confirmedWalletDelta(reclaimResult.signature, taker.publicKey),
    ]);
    assert.strictEqual(pendingOrderAfterReclaim, null);
    assert.strictEqual(pendingLevelAfterReclaim, null);
    assert.strictEqual(takerBalance.aShares.toString(), "50000");
    assert.strictEqual(takerBalance.aLockedLamports.toString(), "30000");
    assert.strictEqual(vaultBeforeReclaim - vaultAfterReclaim, 3_000);
    assert.strictEqual(
      reclaimWalletAccounting.delta + reclaimWalletAccounting.feePaidByWallet,
      BigInt(3_000 + pendingOrderRent + pendingLevelRent),
    );
  });

  it("rejects non-FIFO tail updates when the wrong order account is supplied", async () => {
    const makerOne = Keypair.generate();
    const makerTwo = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, makerOne.publicKey, 5),
      airdrop(provider.connection, makerTwo.publicKey, 5),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("bad-tail") },
    );

    const firstAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: makerOne,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });

    try {
      await placeClobOrder(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: makerTwo,
        orderId: 2,
        side: SIDE_ASK,
        price: 600,
        amount: 1000,
        remainingAccounts: [writableAccount(market.marketState)],
      });
      assert.fail("invalid tail order account was accepted");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidRemainingAccount"),
        `expected InvalidRemainingAccount, got ${String(error)}`,
      );
    }

    const firstOrder = await clobProgram.account.order.fetch(firstAsk.order);
    assert.strictEqual(firstOrder.nextOrderId.toString(), "0");
  });

  it("uses immutable fee snapshots and releases escrow only after resolution", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    const submitter = Keypair.generate();
    const wrongTreasury = Keypair.generate();

    await Promise.all([
      airdrop(provider.connection, treasury.publicKey, 2),
      airdrop(provider.connection, marketMaker.publicKey, 2),
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
      airdrop(provider.connection, submitter.publicKey, 2),
      airdrop(provider.connection, wrongTreasury.publicKey, 2),
    ]);

    const closeSoon = Math.floor(Date.now() / 1000) + 30;
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("fee-snapshot-claim"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
        betOpenTs: closeSoon - 30,
        betCloseTs: closeSoon,
        duelStartTs: closeSoon + 1,
      },
    );
    const vaultBaselineLamports = await provider.connection.getBalance(
      market.vault,
    );

    const marketStateBefore = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(
      marketStateBefore.winningsMarketMakerFeeBpsSnapshot,
      200,
    );

    await clobProgram.methods
      .updateConfig(
        authority.publicKey,
        authority.publicKey,
        authority.publicKey,
        market.marketMaker,
        100,
        100,
        5000,
      )
      .accountsPartial({
        authority: authority.publicKey,
        config: market.config,
      })
      .signers([authority])
      .rpc();

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
    const vaultAfterMatchLamports = await provider.connection.getBalance(
      market.vault,
    );
    assert.strictEqual(
      vaultAfterMatchLamports - vaultBaselineLamports,
      1_012,
      "vault must hold 1,000 matched collateral plus 12 escrowed taker-fee lamports",
    );

    const [treasuryBefore, mmBefore] = await Promise.all([
      provider.connection.getBalance(market.treasury),
      provider.connection.getBalance(market.marketMaker),
    ]);

    try {
      await withdrawResolvedClobTradeFees(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        submitter,
      });
      assert.fail("open-market fee escrow was withdrawable");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotResolved"),
        `expected MarketNotResolved, got ${String(error)}`,
      );
    }

    await lockFixtureMarket(
      market,
      "https://hyperia.gg/duels/locked-fee-snapshot",
    );
    const proposalNow = Math.floor(Date.now() / 1000);
    await proposeDuelResult(fightProgram, authority, market.duelKey, {
      winner: { a: {} },
      duelEndTs: proposalNow,
      metadataUri: "https://hyperia.gg/duels/resolved-fee-snapshot",
    });
    await sleep(61_000);
    await finalizeDuelResult(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    try {
      await withdrawResolvedClobTradeFees(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        treasury: wrongTreasury.publicKey,
        marketMaker: market.marketMaker,
        vault: market.vault,
        submitter,
      });
      assert.fail("resolved fee escrow accepted a redirected treasury");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidFeeAccount") ||
          String(error).includes("ConstraintAddress"),
        `expected InvalidFeeAccount, got ${String(error)}`,
      );
    }

    await withdrawResolvedClobTradeFees(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      submitter,
    });
    const [treasuryAfterWithdrawal, mmAfterWithdrawal] = await Promise.all([
      provider.connection.getBalance(market.treasury),
      provider.connection.getBalance(market.marketMaker),
    ]);
    assert.strictEqual(treasuryAfterWithdrawal - treasuryBefore, 6);
    assert.strictEqual(mmAfterWithdrawal - mmBefore, 6);
    const withdrawnMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(
      withdrawnMarket.accruedTradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      withdrawnMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "0",
    );

    try {
      await withdrawResolvedClobTradeFees(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        submitter,
      });
      assert.fail("resolved fee escrow was withdrawable twice");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NothingToWithdraw"),
        `expected NothingToWithdraw, got ${String(error)}`,
      );
    }

    await claimClobWinnings(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
    });

    const takerBalanceAfter = await provider.connection.getAccountInfo(
      takerBid.userBalance,
    );
    assert.strictEqual(takerBalanceAfter, null);

    const mmAfter = await provider.connection.getBalance(market.marketMaker);
    assert.strictEqual(mmAfter - mmBefore, 26);
    await closeLosingClobBalance(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      user: maker,
    });
    assert.strictEqual(
      await provider.connection.getBalance(market.vault),
      vaultBaselineLamports,
      "resolved payouts, winnings fee, and execution-fee withdrawal must return the vault to its baseline",
    );

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.fail("duplicate winning claim succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NothingToClaim") ||
          hasProgramError(error, "AccountNotInitialized"),
        `expected NothingToClaim or AccountNotInitialized, got ${String(error)}`,
      );
    }
    assert.strictEqual(
      await provider.connection.getBalance(market.vault),
      vaultBaselineLamports,
      "duplicate claim rejection must not change vault custody",
    );
  });

  it("refunds matched stake and escrowed execution fees when a duel is cancelled", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    const submitter = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, treasury.publicKey, 2),
      airdrop(provider.connection, marketMaker.publicKey, 2),
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
      airdrop(provider.connection, submitter.publicKey, 2),
    ]);

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("cancelled-refund"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
      },
    );
    const vaultBaselineLamports = await provider.connection.getBalance(
      market.vault,
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

    const makerBalanceBefore = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    const takerBalanceBefore = await clobProgram.account.userBalance.fetch(
      takerBid.userBalance,
    );
    assert.strictEqual(makerBalanceBefore.bLockedLamports.toString(), "400");
    assert.strictEqual(takerBalanceBefore.aLockedLamports.toString(), "600");
    assert.strictEqual(
      makerBalanceBefore.tradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      makerBalanceBefore.tradeMarketMakerFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      takerBalanceBefore.tradeTreasuryFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      takerBalanceBefore.tradeMarketMakerFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) -
        vaultBaselineLamports,
      1_012,
      "cancelled-market vault must hold exact matched collateral and escrowed execution fees",
    );
    const escrowBeforeCancellation =
      await clobProgram.account.marketState.fetch(market.marketState);
    assert.strictEqual(
      escrowBeforeCancellation.accruedTradeTreasuryFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      escrowBeforeCancellation.accruedTradeMarketMakerFeeLamports.toString(),
      "6",
    );

    const [treasuryBefore, marketMakerBefore] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
    ]);

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    const cancelledMarket = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.deepStrictEqual(cancelledMarket.status, { cancelled: {} });

    try {
      await withdrawResolvedClobTradeFees(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        submitter,
      });
      assert.fail("cancelled-market fee escrow was withdrawable");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotResolved"),
        `expected MarketNotResolved, got ${String(error)}`,
      );
    }

    const makerBalanceRent = BigInt(
      await provider.connection.getBalance(makerAsk.userBalance),
    );
    const takerBalanceRent = BigInt(
      await provider.connection.getBalance(takerBid.userBalance),
    );

    const makerClaim = await claimClobWinningsWithSignature(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
    });
    const makerClaimDelta = await confirmedWalletDelta(
      makerClaim.signature,
      maker.publicKey,
    );
    assert.strictEqual(
      makerClaimDelta.delta + makerClaimDelta.feePaidByWallet,
      400n + makerBalanceRent,
    );
    const escrowAfterMakerRefund = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(
      escrowAfterMakerRefund.accruedTradeTreasuryFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      escrowAfterMakerRefund.accruedTradeMarketMakerFeeLamports.toString(),
      "6",
    );

    const takerClaim = await claimClobWinningsWithSignature(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
    });
    const takerClaimDelta = await confirmedWalletDelta(
      takerClaim.signature,
      taker.publicKey,
    );
    assert.strictEqual(
      takerClaimDelta.delta + takerClaimDelta.feePaidByWallet,
      612n + takerBalanceRent,
    );

    const [makerBalanceAfter, takerBalanceAfter] = await Promise.all([
      provider.connection.getAccountInfo(makerAsk.userBalance),
      provider.connection.getAccountInfo(takerBid.userBalance),
    ]);
    assert.strictEqual(makerBalanceAfter, null);
    assert.strictEqual(takerBalanceAfter, null);
    const escrowAfterRefunds = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.strictEqual(
      escrowAfterRefunds.accruedTradeTreasuryFeeLamports.toString(),
      "0",
    );
    assert.strictEqual(
      escrowAfterRefunds.accruedTradeMarketMakerFeeLamports.toString(),
      "0",
    );
    const [treasuryAfter, marketMakerAfter] = await Promise.all([
      provider.connection.getBalance(treasury.publicKey),
      provider.connection.getBalance(marketMaker.publicKey),
    ]);
    assert.strictEqual(treasuryAfter - treasuryBefore, 0);
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 0);
    assert.strictEqual(
      await provider.connection.getBalance(market.vault),
      vaultBaselineLamports,
      "all cancelled-market collateral and execution fees must return to users",
    );

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.fail("duplicate cancelled-market refund succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NothingToClaim") ||
          hasProgramError(error, "AccountNotInitialized"),
        `expected NothingToClaim or AccountNotInitialized, got ${String(error)}`,
      );
    }
    assert.strictEqual(
      await provider.connection.getBalance(market.vault),
      vaultBaselineLamports,
      "duplicate refund rejection must not change vault custody",
    );
  });

  it("conserves aggregate multi-user liabilities through a paused resolved market", async () => {
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const makerOne = Keypair.generate();
    const makerTwo = Keypair.generate();
    const takerOne = Keypair.generate();
    const takerTwo = Keypair.generate();
    const blockedBettor = Keypair.generate();
    const submitter = Keypair.generate();
    await Promise.all(
      [
        treasury,
        marketMaker,
        makerOne,
        makerTwo,
        takerOne,
        takerTwo,
        blockedBettor,
        submitter,
      ].map((wallet) => airdrop(provider.connection, wallet.publicKey, 5)),
    );

    const closeSoon = Math.floor(Date.now() / 1000) + 30;
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("aggregate-paused-resolution"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
        winningsMarketMakerFeeBps: 200,
        betOpenTs: closeSoon - 30,
        betCloseTs: closeSoon,
        duelStartTs: closeSoon + 1,
      },
    );
    const vaultBaselineLamports = await provider.connection.getBalance(
      market.vault,
    );

    const makerOneAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: makerOne,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 2000,
    });
    const makerTwoAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: makerTwo,
      orderId: 2,
      side: SIDE_ASK,
      price: 650,
      amount: 1000,
    });
    const takerOneBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: takerOne,
      orderId: 3,
      side: SIDE_BID,
      price: 650,
      amount: 2000,
      remainingAccounts: [
        writableAccount(makerOneAsk.restingLevel),
        writableAccount(makerOneAsk.order),
        writableAccount(makerOneAsk.userBalance),
      ],
    });
    const takerTwoBid = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: takerTwo,
      orderId: 4,
      side: SIDE_BID,
      price: 650,
      amount: 1000,
      remainingAccounts: [
        writableAccount(makerTwoAsk.restingLevel),
        writableAccount(makerTwoAsk.order),
        writableAccount(makerTwoAsk.userBalance),
      ],
    });

    const [
      makerOneBalance,
      makerTwoBalance,
      takerOneBalance,
      takerTwoBalance,
      matchedMarket,
    ] = await Promise.all([
      clobProgram.account.userBalance.fetch(makerOneAsk.userBalance),
      clobProgram.account.userBalance.fetch(makerTwoAsk.userBalance),
      clobProgram.account.userBalance.fetch(takerOneBid.userBalance),
      clobProgram.account.userBalance.fetch(takerTwoBid.userBalance),
      clobProgram.account.marketState.fetch(market.marketState),
    ]);
    assert.strictEqual(makerOneBalance.bShares.toString(), "2000");
    assert.strictEqual(makerOneBalance.bLockedLamports.toString(), "800");
    assert.strictEqual(makerTwoBalance.bShares.toString(), "1000");
    assert.strictEqual(makerTwoBalance.bLockedLamports.toString(), "350");
    assert.strictEqual(takerOneBalance.aShares.toString(), "2000");
    assert.strictEqual(takerOneBalance.aLockedLamports.toString(), "1200");
    assert.strictEqual(
      takerOneBalance.tradeTreasuryFeeLamports.toString(),
      "12",
    );
    assert.strictEqual(
      takerOneBalance.tradeMarketMakerFeeLamports.toString(),
      "12",
    );
    assert.strictEqual(takerTwoBalance.aShares.toString(), "1000");
    assert.strictEqual(takerTwoBalance.aLockedLamports.toString(), "650");
    assert.strictEqual(
      takerTwoBalance.tradeTreasuryFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      takerTwoBalance.tradeMarketMakerFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      matchedMarket.accruedTradeTreasuryFeeLamports.toString(),
      "18",
    );
    assert.strictEqual(
      matchedMarket.accruedTradeMarketMakerFeeLamports.toString(),
      "18",
    );
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) -
        vaultBaselineLamports,
      3_036,
      "vault must equal all four users' 3,000-lamport collateral liability plus 36 escrowed fee lamports",
    );

    await setMarketPaused(market.config, true, true);
    try {
      const pausedConfig = await clobProgram.account.marketConfig.fetch(
        market.config,
      );
      assert.strictEqual(pausedConfig.orderPlacementPaused, true);
      assert.strictEqual(pausedConfig.marketCreationPaused, true);

      const sequenceBeforeRejectedOrder = Number(matchedMarket.nextOrderId);
      const vaultBeforeRejectedOrder = await provider.connection.getBalance(
        market.vault,
      );
      try {
        await placeClobOrder(clobProgram, {
          marketState: market.marketState,
          duelState: market.duelState,
          config: market.config,
          treasury: market.treasury,
          marketMaker: market.marketMaker,
          vault: market.vault,
          user: blockedBettor,
          orderId: sequenceBeforeRejectedOrder,
          side: SIDE_ASK,
          price: 700,
          amount: 1000,
        });
        assert.fail("paused order placement succeeded");
      } catch (error: unknown) {
        assert.ok(
          hasProgramError(error, "OrderPlacementPaused"),
          `expected OrderPlacementPaused, got ${String(error)}`,
        );
      }
      const rejectedOrder = deriveOrderPda(
        clobProgram.programId,
        market.marketState,
        sequenceBeforeRejectedOrder,
      );
      const rejectedBalance = deriveUserBalancePda(
        clobProgram.programId,
        market.marketState,
        blockedBettor.publicKey,
      );
      const [marketAfterRejectedOrder, rejectedOrderInfo, rejectedBalanceInfo] =
        await Promise.all([
          clobProgram.account.marketState.fetch(market.marketState),
          provider.connection.getAccountInfo(rejectedOrder),
          provider.connection.getAccountInfo(rejectedBalance),
        ]);
      assert.strictEqual(
        Number(marketAfterRejectedOrder.nextOrderId),
        sequenceBeforeRejectedOrder,
      );
      assert.strictEqual(rejectedOrderInfo, null);
      assert.strictEqual(rejectedBalanceInfo, null);
      assert.strictEqual(
        await provider.connection.getBalance(market.vault),
        vaultBeforeRejectedOrder,
      );

      const blockedDuelKey = uniqueDuelKey("paused-market-creation");
      const blockedNow = Math.floor(Date.now() / 1000);
      const blockedDuelState = await upsertDuel(
        fightProgram,
        authority,
        blockedDuelKey,
        {
          status: duelStatusBettingOpen(),
          betOpenTs: blockedNow - 10,
          betCloseTs: blockedNow + 600,
          duelStartTs: blockedNow + 660,
          metadataUri: "https://hyperia.gg/tests/clob/paused-creation",
        },
      );
      try {
        await initializeCanonicalMarket(
          clobProgram,
          authority,
          blockedDuelState,
          blockedDuelKey,
          market.config,
        );
        assert.fail("paused market creation succeeded");
      } catch (error: unknown) {
        assert.ok(
          hasProgramError(error, "MarketCreationPaused"),
          `expected MarketCreationPaused, got ${String(error)}`,
        );
      }

      await lockFixtureMarket(
        market,
        "https://hyperia.gg/duels/aggregate-paused-locked",
      );
      await proposeDuelResult(fightProgram, authority, market.duelKey, {
        winner: { a: {} },
        duelEndTs: Math.floor(Date.now() / 1000),
        metadataUri: "https://hyperia.gg/duels/aggregate-paused-resolved",
      });
      await sleep(61_000);
      await finalizeDuelResult(fightProgram, authority, market.duelKey);
      await syncMarketFromDuel(
        clobProgram,
        market.marketState,
        market.duelState,
      );
      const resolvedMarket = await clobProgram.account.marketState.fetch(
        market.marketState,
      );
      assert.deepStrictEqual(resolvedMarket.status, { resolved: {} });
      assert.deepStrictEqual(resolvedMarket.winner, { a: {} });
      assert.strictEqual(
        (await provider.connection.getBalance(market.vault)) -
          vaultBaselineLamports,
        3_036,
        "pause must not alter terminal collateral or fee liabilities",
      );

      const [treasuryBefore, marketMakerBefore] = await Promise.all([
        provider.connection.getBalance(market.treasury),
        provider.connection.getBalance(market.marketMaker),
      ]);
      await withdrawResolvedClobTradeFees(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        submitter,
      });
      assert.strictEqual(
        (await provider.connection.getBalance(market.vault)) -
          vaultBaselineLamports,
        3_000,
        "resolved execution-fee release must leave exactly matched collateral",
      );

      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: takerOne,
      });
      assert.strictEqual(
        (await provider.connection.getBalance(market.vault)) -
          vaultBaselineLamports,
        1_000,
        "first winning claim must release exactly its 2,000-share gross liability",
      );
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: takerTwo,
      });
      assert.strictEqual(
        await provider.connection.getBalance(market.vault),
        vaultBaselineLamports,
        "all winning gross liabilities must return the vault to its baseline",
      );

      await closeLosingClobBalance(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        user: makerOne,
      });
      await closeLosingClobBalance(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        user: makerTwo,
      });
      const userBalancesAfterCleanup = await Promise.all(
        [makerOne, makerTwo, takerOne, takerTwo].map((wallet) =>
          provider.connection.getAccountInfo(
            deriveUserBalancePda(
              clobProgram.programId,
              market.marketState,
              wallet.publicKey,
            ),
          ),
        ),
      );
      assert.deepStrictEqual(userBalancesAfterCleanup, [
        null,
        null,
        null,
        null,
      ]);
      assert.strictEqual(
        await provider.connection.getBalance(market.vault),
        vaultBaselineLamports,
      );
      const [treasuryAfter, marketMakerAfter] = await Promise.all([
        provider.connection.getBalance(market.treasury),
        provider.connection.getBalance(market.marketMaker),
      ]);
      assert.strictEqual(treasuryAfter - treasuryBefore, 18);
      assert.strictEqual(
        marketMakerAfter - marketMakerBefore,
        78,
        "market maker must receive 18 execution-fee plus 60 winnings-fee lamports",
      );
    } finally {
      await setMarketPaused(market.config, false, false);
    }
  });

  it("allows cancellation sync and complete refunds while globally paused", async () => {
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
        duelKey: uniqueDuelKey("paused-cancellation-refund"),
        tradeTreasuryFeeBps: 100,
        tradeMarketMakerFeeBps: 100,
      },
    );
    const vaultBaselineLamports = await provider.connection.getBalance(
      market.vault,
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
    assert.strictEqual(
      (await provider.connection.getBalance(market.vault)) -
        vaultBaselineLamports,
      1_012,
    );

    await setMarketPaused(market.config, true, true);
    try {
      await cancelDuel(fightProgram, authority, market.duelKey);
      await syncMarketFromDuel(
        clobProgram,
        market.marketState,
        market.duelState,
      );
      const cancelledMarket = await clobProgram.account.marketState.fetch(
        market.marketState,
      );
      assert.deepStrictEqual(cancelledMarket.status, { cancelled: {} });

      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
      });
      assert.strictEqual(
        (await provider.connection.getBalance(market.vault)) -
          vaultBaselineLamports,
        612,
      );
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.strictEqual(
        await provider.connection.getBalance(market.vault),
        vaultBaselineLamports,
      );
      const [makerAfter, takerAfter] = await Promise.all([
        provider.connection.getAccountInfo(makerAsk.userBalance),
        provider.connection.getAccountInfo(takerBid.userBalance),
      ]);
      assert.strictEqual(makerAfter, null);
      assert.strictEqual(takerAfter, null);
    } finally {
      await setMarketPaused(market.config, false, false);
    }
  });

  it("conserves liabilities across simultaneous A-win, B-win, and cancelled markets", async () => {
    type MarketFixture = Awaited<ReturnType<typeof createOpenMarketFixture>>;
    type MatchedPair = {
      maker: Keypair;
      taker: Keypair;
      makerBalance: anchor.web3.PublicKey;
      takerBalance: anchor.web3.PublicKey;
      makerSide: number;
      amount: number;
      takerExecutionCost: number;
      treasuryFee: number;
      marketMakerFee: number;
    };
    type MarketScenario = {
      fixture: MarketFixture;
      baselineLamports: number;
      pairs: MatchedPair[];
      collateralLamports: number;
      treasuryFeesLamports: number;
      marketMakerFeesLamports: number;
    };

    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const submitter = Keypair.generate();
    const participants = Array.from({ length: 12 }, () => Keypair.generate());
    await Promise.all(
      [treasury, marketMaker, submitter, ...participants].map((wallet) =>
        airdrop(provider.connection, wallet.publicKey, 5),
      ),
    );

    const tradeTreasuryFeeBps = 100;
    const tradeMarketMakerFeeBps = 100;
    const winningsMarketMakerFeeBps = 200;
    const closeSoon = Math.floor(Date.now() / 1000) + 45;
    const fixtureOptions = {
      treasury: treasury.publicKey,
      marketMaker: marketMaker.publicKey,
      tradeTreasuryFeeBps,
      tradeMarketMakerFeeBps,
      winningsMarketMakerFeeBps,
      betOpenTs: closeSoon - 30,
      betCloseTs: closeSoon,
      duelStartTs: closeSoon + 1,
    } as const;
    const resolvedA = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        ...fixtureOptions,
        duelKey: uniqueDuelKey("matrix-resolved-a"),
      },
    );
    const resolvedB = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        ...fixtureOptions,
        duelKey: uniqueDuelKey("matrix-resolved-b"),
      },
    );
    const cancelled = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        ...fixtureOptions,
        duelKey: uniqueDuelKey("matrix-cancelled"),
      },
    );

    const quoteCost = (side: number, price: number, amount: number): number => {
      const priceComponent = side === SIDE_BID ? price : 1000 - price;
      const numerator = amount * priceComponent;
      assert.strictEqual(numerator % 1000, 0);
      return numerator / 1000;
    };
    const feeFor = (amount: number, bps: number): number =>
      Math.floor((amount * bps) / 10_000);

    const placeMatchedPair = async (
      fixture: MarketFixture,
      maker: Keypair,
      taker: Keypair,
      makerSide: number,
      price: number,
      amount: number,
      makerOrderId: number,
    ): Promise<MatchedPair> => {
      const takerSide = makerSide === SIDE_BID ? SIDE_ASK : SIDE_BID;
      const makerOrder = await placeClobOrder(clobProgram, {
        marketState: fixture.marketState,
        duelState: fixture.duelState,
        config: fixture.config,
        treasury: fixture.treasury,
        marketMaker: fixture.marketMaker,
        vault: fixture.vault,
        user: maker,
        orderId: makerOrderId,
        side: makerSide,
        price,
        amount,
      });
      const takerOrder = await placeClobOrder(clobProgram, {
        marketState: fixture.marketState,
        duelState: fixture.duelState,
        config: fixture.config,
        treasury: fixture.treasury,
        marketMaker: fixture.marketMaker,
        vault: fixture.vault,
        user: taker,
        orderId: makerOrderId + 1,
        side: takerSide,
        price,
        amount,
        remainingAccounts: [
          writableAccount(makerOrder.restingLevel),
          writableAccount(makerOrder.order),
          writableAccount(makerOrder.userBalance),
        ],
      });

      const makerCost = quoteCost(makerSide, price, amount);
      const takerExecutionCost = quoteCost(takerSide, price, amount);
      assert.strictEqual(
        makerCost + takerExecutionCost,
        amount,
        "opposing matched collateral must conserve to one lamport per share",
      );
      const treasuryFee = feeFor(takerExecutionCost, tradeTreasuryFeeBps);
      const marketMakerFee = feeFor(takerExecutionCost, tradeMarketMakerFeeBps);
      const [makerBalance, takerBalance] = await Promise.all([
        clobProgram.account.userBalance.fetch(makerOrder.userBalance),
        clobProgram.account.userBalance.fetch(takerOrder.userBalance),
      ]);
      const makerShares =
        makerSide === SIDE_BID ? makerBalance.aShares : makerBalance.bShares;
      const makerLocked =
        makerSide === SIDE_BID
          ? makerBalance.aLockedLamports
          : makerBalance.bLockedLamports;
      const takerShares =
        takerSide === SIDE_BID ? takerBalance.aShares : takerBalance.bShares;
      const takerLocked =
        takerSide === SIDE_BID
          ? takerBalance.aLockedLamports
          : takerBalance.bLockedLamports;
      assert.strictEqual(makerShares.toString(), String(amount));
      assert.strictEqual(makerLocked.toString(), String(makerCost));
      assert.strictEqual(takerShares.toString(), String(amount));
      assert.strictEqual(takerLocked.toString(), String(takerExecutionCost));
      assert.strictEqual(makerBalance.tradeTreasuryFeeLamports.toString(), "0");
      assert.strictEqual(
        makerBalance.tradeMarketMakerFeeLamports.toString(),
        "0",
      );
      assert.strictEqual(
        takerBalance.tradeTreasuryFeeLamports.toString(),
        String(treasuryFee),
      );
      assert.strictEqual(
        takerBalance.tradeMarketMakerFeeLamports.toString(),
        String(marketMakerFee),
      );

      return {
        maker,
        taker,
        makerBalance: makerOrder.userBalance,
        takerBalance: takerOrder.userBalance,
        makerSide,
        amount,
        takerExecutionCost,
        treasuryFee,
        marketMakerFee,
      };
    };

    const buildScenario = async (
      fixture: MarketFixture,
      pairSpecs: readonly {
        maker: Keypair;
        taker: Keypair;
        makerSide: number;
        price: number;
        amount: number;
      }[],
    ): Promise<MarketScenario> => {
      const baselineLamports = await provider.connection.getBalance(
        fixture.vault,
      );
      const pairs: MatchedPair[] = [];
      for (const [index, pairSpec] of pairSpecs.entries()) {
        pairs.push(
          await placeMatchedPair(
            fixture,
            pairSpec.maker,
            pairSpec.taker,
            pairSpec.makerSide,
            pairSpec.price,
            pairSpec.amount,
            index * 2 + 1,
          ),
        );
      }
      const collateralLamports = pairs.reduce(
        (sum, pair) => sum + pair.amount,
        0,
      );
      const treasuryFeesLamports = pairs.reduce(
        (sum, pair) => sum + pair.treasuryFee,
        0,
      );
      const marketMakerFeesLamports = pairs.reduce(
        (sum, pair) => sum + pair.marketMakerFee,
        0,
      );
      assert.strictEqual(
        (await provider.connection.getBalance(fixture.vault)) -
          baselineLamports,
        collateralLamports + treasuryFeesLamports + marketMakerFeesLamports,
      );
      const marketState = await clobProgram.account.marketState.fetch(
        fixture.marketState,
      );
      assert.strictEqual(
        marketState.accruedTradeTreasuryFeeLamports.toString(),
        String(treasuryFeesLamports),
      );
      assert.strictEqual(
        marketState.accruedTradeMarketMakerFeeLamports.toString(),
        String(marketMakerFeesLamports),
      );
      return {
        fixture,
        baselineLamports,
        pairs,
        collateralLamports,
        treasuryFeesLamports,
        marketMakerFeesLamports,
      };
    };

    const [scenarioA, scenarioB, scenarioCancelled] = await Promise.all([
      buildScenario(resolvedA, [
        {
          maker: participants[0],
          taker: participants[1],
          makerSide: SIDE_ASK,
          price: 250,
          amount: 2000,
        },
        {
          maker: participants[2],
          taker: participants[3],
          makerSide: SIDE_ASK,
          price: 700,
          amount: 3000,
        },
      ]),
      buildScenario(resolvedB, [
        {
          maker: participants[4],
          taker: participants[5],
          makerSide: SIDE_BID,
          price: 300,
          amount: 2000,
        },
        {
          maker: participants[6],
          taker: participants[7],
          makerSide: SIDE_BID,
          price: 800,
          amount: 1000,
        },
      ]),
      buildScenario(cancelled, [
        {
          maker: participants[8],
          taker: participants[9],
          makerSide: SIDE_ASK,
          price: 450,
          amount: 1000,
        },
        {
          maker: participants[10],
          taker: participants[11],
          makerSide: SIDE_ASK,
          price: 900,
          amount: 2000,
        },
      ]),
    ]);
    assert.strictEqual(scenarioA.collateralLamports, 5_000);
    assert.strictEqual(scenarioA.treasuryFeesLamports, 26);
    assert.strictEqual(scenarioA.marketMakerFeesLamports, 26);
    assert.strictEqual(scenarioB.collateralLamports, 3_000);
    assert.strictEqual(scenarioB.treasuryFeesLamports, 16);
    assert.strictEqual(scenarioB.marketMakerFeesLamports, 16);
    assert.strictEqual(scenarioCancelled.collateralLamports, 3_000);
    assert.strictEqual(scenarioCancelled.treasuryFeesLamports, 22);
    assert.strictEqual(scenarioCancelled.marketMakerFeesLamports, 22);

    const settleResolvedScenario = async (
      scenario: MarketScenario,
      winner: "a" | "b",
    ): Promise<number> => {
      const winnerSide = winner === "a" ? SIDE_BID : SIDE_ASK;
      await withdrawResolvedClobTradeFees(clobProgram, {
        marketState: scenario.fixture.marketState,
        duelState: scenario.fixture.duelState,
        treasury: scenario.fixture.treasury,
        marketMaker: scenario.fixture.marketMaker,
        vault: scenario.fixture.vault,
        submitter,
      });
      assert.strictEqual(
        (await provider.connection.getBalance(scenario.fixture.vault)) -
          scenario.baselineLamports,
        scenario.collateralLamports,
      );
      let winningsFeesLamports = 0;
      let remainingLiabilityLamports = scenario.collateralLamports;
      for (const pair of scenario.pairs) {
        const makerWon = pair.makerSide === winnerSide;
        const winnerWallet = makerWon ? pair.maker : pair.taker;
        const loserWallet = makerWon ? pair.taker : pair.maker;
        winningsFeesLamports += feeFor(pair.amount, winningsMarketMakerFeeBps);
        await claimClobWinnings(clobProgram, {
          marketState: scenario.fixture.marketState,
          duelState: scenario.fixture.duelState,
          config: scenario.fixture.config,
          marketMaker: scenario.fixture.marketMaker,
          vault: scenario.fixture.vault,
          user: winnerWallet,
        });
        remainingLiabilityLamports -= pair.amount;
        assert.strictEqual(
          (await provider.connection.getBalance(scenario.fixture.vault)) -
            scenario.baselineLamports,
          remainingLiabilityLamports,
        );
        await closeLosingClobBalance(clobProgram, {
          marketState: scenario.fixture.marketState,
          duelState: scenario.fixture.duelState,
          user: loserWallet,
        });
      }
      const balanceAccounts = await Promise.all(
        scenario.pairs.flatMap((pair) =>
          [pair.makerBalance, pair.takerBalance].map((balance) =>
            provider.connection.getAccountInfo(balance),
          ),
        ),
      );
      assert.ok(balanceAccounts.every((account) => account === null));
      assert.strictEqual(
        await provider.connection.getBalance(scenario.fixture.vault),
        scenario.baselineLamports,
      );
      return winningsFeesLamports;
    };

    await setMarketPaused(resolvedA.config, true, true);
    try {
      const pausedConfig = await clobProgram.account.marketConfig.fetch(
        resolvedA.config,
      );
      assert.strictEqual(pausedConfig.orderPlacementPaused, true);
      assert.strictEqual(pausedConfig.marketCreationPaused, true);
      await cancelDuel(
        fightProgram,
        authority,
        scenarioCancelled.fixture.duelKey,
      );
      await syncMarketFromDuel(
        clobProgram,
        scenarioCancelled.fixture.marketState,
        scenarioCancelled.fixture.duelState,
      );
      await Promise.all([
        lockFixtureMarket(
          scenarioA.fixture,
          "https://hyperia.gg/duels/matrix-resolved-a-locked",
        ),
        lockFixtureMarket(
          scenarioB.fixture,
          "https://hyperia.gg/duels/matrix-resolved-b-locked",
        ),
      ]);
      const terminalTs = Math.floor(Date.now() / 1000);
      await Promise.all([
        proposeDuelResult(fightProgram, authority, scenarioA.fixture.duelKey, {
          winner: { a: {} },
          duelEndTs: terminalTs,
          metadataUri: "https://hyperia.gg/duels/matrix-resolved-a",
        }),
        proposeDuelResult(fightProgram, authority, scenarioB.fixture.duelKey, {
          winner: { b: {} },
          duelEndTs: terminalTs,
          metadataUri: "https://hyperia.gg/duels/matrix-resolved-b",
        }),
      ]);
      await sleep(61_000);
      await Promise.all([
        finalizeDuelResult(fightProgram, authority, scenarioA.fixture.duelKey),
        finalizeDuelResult(fightProgram, authority, scenarioB.fixture.duelKey),
      ]);
      await Promise.all([
        syncMarketFromDuel(
          clobProgram,
          scenarioA.fixture.marketState,
          scenarioA.fixture.duelState,
        ),
        syncMarketFromDuel(
          clobProgram,
          scenarioB.fixture.marketState,
          scenarioB.fixture.duelState,
        ),
      ]);
      const [stateA, stateB, stateCancelled] = await Promise.all([
        clobProgram.account.marketState.fetch(scenarioA.fixture.marketState),
        clobProgram.account.marketState.fetch(scenarioB.fixture.marketState),
        clobProgram.account.marketState.fetch(
          scenarioCancelled.fixture.marketState,
        ),
      ]);
      assert.deepStrictEqual(stateA.status, { resolved: {} });
      assert.deepStrictEqual(stateA.winner, { a: {} });
      assert.deepStrictEqual(stateB.status, { resolved: {} });
      assert.deepStrictEqual(stateB.winner, { b: {} });
      assert.deepStrictEqual(stateCancelled.status, { cancelled: {} });

      const [treasuryBefore, marketMakerBefore] = await Promise.all([
        provider.connection.getBalance(treasury.publicKey),
        provider.connection.getBalance(marketMaker.publicKey),
      ]);
      const winningsFeesA = await settleResolvedScenario(scenarioA, "a");
      const winningsFeesB = await settleResolvedScenario(scenarioB, "b");
      assert.strictEqual(winningsFeesA, 100);
      assert.strictEqual(winningsFeesB, 60);

      for (const pair of scenarioCancelled.pairs) {
        await claimClobWinnings(clobProgram, {
          marketState: scenarioCancelled.fixture.marketState,
          duelState: scenarioCancelled.fixture.duelState,
          config: scenarioCancelled.fixture.config,
          marketMaker: scenarioCancelled.fixture.marketMaker,
          vault: scenarioCancelled.fixture.vault,
          user: pair.maker,
        });
        await claimClobWinnings(clobProgram, {
          marketState: scenarioCancelled.fixture.marketState,
          duelState: scenarioCancelled.fixture.duelState,
          config: scenarioCancelled.fixture.config,
          marketMaker: scenarioCancelled.fixture.marketMaker,
          vault: scenarioCancelled.fixture.vault,
          user: pair.taker,
        });
      }
      assert.strictEqual(
        await provider.connection.getBalance(scenarioCancelled.fixture.vault),
        scenarioCancelled.baselineLamports,
      );
      const cancelledBalanceAccounts = await Promise.all(
        scenarioCancelled.pairs.flatMap((pair) =>
          [pair.makerBalance, pair.takerBalance].map((balance) =>
            provider.connection.getAccountInfo(balance),
          ),
        ),
      );
      assert.ok(cancelledBalanceAccounts.every((account) => account === null));
      const cancelledStateAfterRefunds =
        await clobProgram.account.marketState.fetch(
          scenarioCancelled.fixture.marketState,
        );
      assert.strictEqual(
        cancelledStateAfterRefunds.accruedTradeTreasuryFeeLamports.toString(),
        "0",
      );
      assert.strictEqual(
        cancelledStateAfterRefunds.accruedTradeMarketMakerFeeLamports.toString(),
        "0",
      );

      const [treasuryAfter, marketMakerAfter] = await Promise.all([
        provider.connection.getBalance(treasury.publicKey),
        provider.connection.getBalance(marketMaker.publicKey),
      ]);
      assert.strictEqual(
        treasuryAfter - treasuryBefore,
        scenarioA.treasuryFeesLamports + scenarioB.treasuryFeesLamports,
      );
      assert.strictEqual(
        marketMakerAfter - marketMakerBefore,
        scenarioA.marketMakerFeesLamports +
          scenarioB.marketMakerFeesLamports +
          winningsFeesA +
          winningsFeesB,
      );
      assert.strictEqual(treasuryAfter - treasuryBefore, 42);
      assert.strictEqual(marketMakerAfter - marketMakerBefore, 202);
    } finally {
      await setMarketPaused(resolvedA.config, false, false);
    }
    const resumedConfig = await clobProgram.account.marketConfig.fetch(
      resolvedA.config,
    );
    assert.strictEqual(resumedConfig.orderPlacementPaused, false);
    assert.strictEqual(resumedConfig.marketCreationPaused, false);
  });

  it("reclaims unmatched resting collateral after the market locks", async () => {
    const firstMaker = Keypair.generate();
    const remainingMaker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, firstMaker.publicKey, 5),
      airdrop(provider.connection, remainingMaker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const closeSoon = Math.floor(Date.now() / 1000) + 30;
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("reclaim-unmatched-lock"),
        betOpenTs: closeSoon - 30,
        betCloseTs: closeSoon,
        duelStartTs: closeSoon + 1,
      },
    );

    const firstAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: firstMaker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
    });
    const remainingAsk = await placeClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      treasury: market.treasury,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: remainingMaker,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
      amount: 1000,
      remainingAccounts: [writableAccount(firstAsk.order)],
    });
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
      remainingAccounts: [
        writableAccount(firstAsk.restingLevel),
        writableAccount(firstAsk.order),
        writableAccount(firstAsk.userBalance),
      ],
    });
    const [staleHeadOrder, staleHeadLevel] = await Promise.all([
      clobProgram.account.order.fetch(remainingAsk.order),
      clobProgram.account.priceLevel.fetch(remainingAsk.restingLevel),
    ]);
    assert.strictEqual(staleHeadOrder.prevOrderId.toString(), "1");
    assert.strictEqual(staleHeadLevel.headOrderId.toString(), "2");
    assert.strictEqual(staleHeadLevel.tailOrderId.toString(), "2");

    const vaultBeforeReclaim = await provider.connection.getBalance(
      market.vault,
    );
    await lockFixtureMarket(market, "https://hyperia.gg/duels/reclaim-locked");

    const reclaimedOrderRent = BigInt(
      await provider.connection.getBalance(remainingAsk.order),
    );
    assert.ok(reclaimedOrderRent > 0n);
    const reclaimResult = await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: remainingMaker,
      orderId: 2,
      side: SIDE_ASK,
      price: 600,
    });

    const vaultAfterReclaim = await provider.connection.getBalance(
      market.vault,
    );
    const orderAfterReclaim = await clobProgram.account.order.fetchNullable(
      remainingAsk.order,
    );
    const levelAfterReclaim = await clobProgram.account.priceLevel.fetch(
      remainingAsk.restingLevel,
    );
    const makerBalance = await clobProgram.account.userBalance.fetch(
      remainingAsk.userBalance,
    );
    assert.strictEqual(vaultBeforeReclaim - vaultAfterReclaim, 400);
    assert.strictEqual(orderAfterReclaim, null);
    const reclaimWalletAccounting = await confirmedWalletDelta(
      reclaimResult.signature,
      remainingMaker.publicKey,
    );
    assert.strictEqual(
      reclaimWalletAccounting.delta + reclaimWalletAccounting.feePaidByWallet,
      400n + reclaimedOrderRent,
    );
    assert.strictEqual(levelAfterReclaim.totalOpen.toString(), "0");
    assert.strictEqual(levelAfterReclaim.headOrderId.toString(), "0");
    assert.strictEqual(levelAfterReclaim.tailOrderId.toString(), "0");
    assert.ok(levelAfterReclaim.rentRecipient.equals(firstMaker.publicKey));
    assert.strictEqual(makerBalance.aShares.toString(), "0");
    assert.strictEqual(makerBalance.bShares.toString(), "0");
    assert.strictEqual(makerBalance.aLockedLamports.toString(), "0");
    assert.strictEqual(makerBalance.bLockedLamports.toString(), "0");
  });

  it("reclaims cancelled-market remainder without disturbing later claim/refund state", async () => {
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
      { duelKey: uniqueDuelKey("reclaim-cancelled-remainder") },
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
      amount: 2000,
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

    await cancelDuel(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    const vaultBeforeReclaim = await provider.connection.getBalance(
      market.vault,
    );
    const makerBeforeReclaim = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    assert.strictEqual(makerBeforeReclaim.bShares.toString(), "1000");
    assert.strictEqual(makerBeforeReclaim.bLockedLamports.toString(), "400");

    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
    });

    const vaultAfterReclaim = await provider.connection.getBalance(
      market.vault,
    );
    const makerAfterReclaim = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    const makerOrderAfterReclaim =
      await clobProgram.account.order.fetchNullable(makerAsk.order);
    const makerLevelAfterReclaim = await clobProgram.account.priceLevel.fetch(
      makerAsk.restingLevel,
    );
    assert.strictEqual(vaultBeforeReclaim - vaultAfterReclaim, 400);
    assert.strictEqual(makerAfterReclaim.bShares.toString(), "1000");
    assert.strictEqual(makerAfterReclaim.bLockedLamports.toString(), "400");
    assert.strictEqual(makerOrderAfterReclaim, null);
    assert.strictEqual(makerLevelAfterReclaim.totalOpen.toString(), "0");
    assert.strictEqual(makerLevelAfterReclaim.headOrderId.toString(), "0");
    assert.strictEqual(makerLevelAfterReclaim.tailOrderId.toString(), "0");
    assert.ok(makerLevelAfterReclaim.rentRecipient.equals(maker.publicKey));

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

    const [makerAfterClaim, takerAfterClaim] = await Promise.all([
      provider.connection.getAccountInfo(makerAsk.userBalance),
      provider.connection.getAccountInfo(takerBid.userBalance),
    ]);
    assert.strictEqual(makerAfterClaim, null);
    assert.strictEqual(takerAfterClaim, null);
  });

  it("reclaims resolved-market remainder while preserving matched winner claims", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const closeSoon = Math.floor(Date.now() / 1000) + 30;
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("reclaim-resolved-remainder"),
        betOpenTs: closeSoon - 30,
        betCloseTs: closeSoon,
        duelStartTs: closeSoon + 1,
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
      amount: 2000,
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

    await lockFixtureMarket(
      market,
      "https://hyperia.gg/duels/reclaim-resolved",
    );
    const proposalNow = Math.floor(Date.now() / 1000);
    await proposeDuelResult(fightProgram, authority, market.duelKey, {
      winner: { b: {} },
      duelEndTs: proposalNow,
      metadataUri: "https://hyperia.gg/duels/reclaim-resolved-proposed",
    });
    await sleep(61_000);
    await finalizeDuelResult(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    await reclaimClobOrder(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      vault: market.vault,
      user: maker,
      orderId: 1,
      side: SIDE_ASK,
      price: 600,
    });
    await claimClobWinnings(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: maker,
    });

    const makerAfterClaim = await provider.connection.getAccountInfo(
      makerAsk.userBalance,
    );
    const makerOrderAfterReclaim =
      await clobProgram.account.order.fetchNullable(makerAsk.order);
    assert.strictEqual(makerOrderAfterReclaim, null);
    assert.strictEqual(makerAfterClaim, null);

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.fail("losing taker claim succeeded after maker reclaim");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NothingToClaim") ||
          hasProgramError(error, "AccountNotInitialized"),
        `expected NothingToClaim or AccountNotInitialized, got ${String(error)}`,
      );
    }

    const takerAfterClaim = await clobProgram.account.userBalance.fetch(
      takerBid.userBalance,
    );
    assert.strictEqual(takerAfterClaim.aShares.toString(), "1000");
    assert.strictEqual(takerAfterClaim.aLockedLamports.toString(), "600");
  });

  it("pays winning claim with market-maker fee and clears winner and loser state", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    const closeSoon = Math.floor(Date.now() / 1000) + 30;
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("resolved-state-clear"),
        betOpenTs: closeSoon - 30,
        betCloseTs: closeSoon,
        duelStartTs: closeSoon + 1,
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

    await lockFixtureMarket(market, "https://hyperia.gg/duels/resolved-state");
    const proposalNow = Math.floor(Date.now() / 1000);

    await proposeDuelResult(fightProgram, authority, market.duelKey, {
      winner: { a: {} },
      duelEndTs: proposalNow,
      metadataUri: "https://hyperia.gg/duels/resolved-state-proposed",
    });
    await sleep(61_000);
    await finalizeDuelResult(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    const losingPositionBefore = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    try {
      await closeLosingClobBalance(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        user: taker,
      });
      assert.fail("winning balance was closed as a loss");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "WinningBalanceCannotBeClosed"),
        `expected WinningBalanceCannotBeClosed, got ${String(error)}`,
      );
    }

    await claimClobWinnings(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
    });

    const winningPositionAfter = await provider.connection.getAccountInfo(
      takerBid.userBalance,
    );
    assert.strictEqual(winningPositionAfter, null);

    const losingPositionAfter = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    assert.strictEqual(
      losingPositionAfter.aShares.toString(),
      losingPositionBefore.aShares.toString(),
    );
    assert.strictEqual(
      losingPositionAfter.bShares.toString(),
      losingPositionBefore.bShares.toString(),
    );
    assert.strictEqual(
      losingPositionAfter.aLockedLamports.toString(),
      losingPositionBefore.aLockedLamports.toString(),
    );
    assert.strictEqual(
      losingPositionAfter.bLockedLamports.toString(),
      losingPositionBefore.bLockedLamports.toString(),
    );
    assert.ok(
      !(
        losingPositionAfter.aShares.toString() === "0" &&
        losingPositionAfter.bShares.toString() === "0"
      ),
      "loser still holding position should remain non-zero",
    );

    await closeLosingClobBalance(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      user: maker,
    });
    const losingPositionAfterCleanup = await provider.connection.getAccountInfo(
      makerAsk.userBalance,
    );
    assert.strictEqual(losingPositionAfterCleanup, null);

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.fail("winner repeat claim succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NothingToClaim") ||
          hasProgramError(error, "AccountNotInitialized"),
        `expected NothingToClaim or AccountNotInitialized, got ${String(error)}`,
      );
    }

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: maker,
      });
      assert.fail("loser claim succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "AccountNotInitialized"),
        `expected AccountNotInitialized, got ${String(error)}`,
      );
    }
  });

  it("rejects claim before resolution and preserves lockup", async () => {
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
      { duelKey: uniqueDuelKey("unsettled-claim") },
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

    const makerAskBalanceBefore = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    const takerBidBalanceBefore = await clobProgram.account.userBalance.fetch(
      takerBid.userBalance,
    );

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.fail("claim succeeded before settlement");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotResolved"),
        `expected MarketNotResolved, got ${String(error)}`,
      );
    }

    const takerBidPositionAfter = await clobProgram.account.userBalance.fetch(
      takerBid.userBalance,
    );
    const makerAskPositionAfter = await clobProgram.account.userBalance.fetch(
      makerAsk.userBalance,
    );
    assert.strictEqual(
      takerBidPositionAfter.aShares.toString(),
      takerBidBalanceBefore.aShares.toString(),
    );
    assert.strictEqual(
      takerBidPositionAfter.aLockedLamports.toString(),
      takerBidBalanceBefore.aLockedLamports.toString(),
    );
    assert.strictEqual(
      takerBidPositionAfter.bShares.toString(),
      takerBidBalanceBefore.bShares.toString(),
    );
    assert.strictEqual(
      takerBidPositionAfter.bLockedLamports.toString(),
      takerBidBalanceBefore.bLockedLamports.toString(),
    );
    assert.strictEqual(
      makerAskPositionAfter.bShares.toString(),
      makerAskBalanceBefore.bShares.toString(),
    );
    assert.strictEqual(
      makerAskPositionAfter.bLockedLamports.toString(),
      makerAskBalanceBefore.bLockedLamports.toString(),
    );
    assert.strictEqual(
      makerAskPositionAfter.aShares.toString(),
      makerAskBalanceBefore.aShares.toString(),
    );
    assert.strictEqual(
      makerAskPositionAfter.aLockedLamports.toString(),
      makerAskBalanceBefore.aLockedLamports.toString(),
    );
  });
});
