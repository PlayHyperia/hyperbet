import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import * as assert from "assert";

import {
  SIDE_ASK,
  SIDE_BID,
  airdrop,
  cancelDuel,
  claimClobWinnings,
  createOpenMarketFixture,
  duelStatusLocked,
  duelStatusScheduled,
  ensureOracleReady,
  hasProgramError,
  hashLabel,
  marketSideA,
  placeClobOrder,
  challengeDuelResult,
  finalizeDuelResult,
  proposeDuelResult,
  syncMarketFromDuel,
  uniqueDuelKey,
  upsertDuel,
  waitForChainUnixTimestamp,
  writableAccount,
} from "./clob-test-helpers";
import { configureAnchorTests } from "./test-anchor";
import { FightOracle } from "../target/types/fight_oracle";
import { DuelMarket } from "../target/types/duel_market";

const LOCALNET_ORDER_SETUP_HEADROOM_SECONDS = 30;
const LOCALNET_CHAIN_TIME_WAIT_TIMEOUT_MS =
  (LOCALNET_ORDER_SETUP_HEADROOM_SECONDS + 15) * 1_000;

describe("hyperbet-solana", () => {
  const provider = configureAnchorTests();
  anchor.setProvider(provider);

  const fightProgram = anchor.workspace.FightOracle as Program<FightOracle>;
  const clobProgram = anchor.workspace.DuelMarket as Program<DuelMarket>;
  const authority = (provider.wallet as anchor.Wallet & { payer: Keypair })
    .payer;

  it("refuses to pay out before the oracle resolves the duel", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);

    await ensureOracleReady(
      fightProgram,
      authority,
      authority.publicKey,
      authority.publicKey,
      authority.publicKey,
      60,
    );

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("unresolved-claim") },
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
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.fail("claim succeeded before oracle resolution");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotResolved"),
        `expected MarketNotResolved, got ${String(error)}`,
      );
    }
  });

  it("mirrors duel lifecycle updates and pays the resolved winner from the oracle result", async () => {
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
    const now = Math.floor(Date.now() / 1000);
    const betOpenTs = now - 120;
    const betCloseTs = now + LOCALNET_ORDER_SETUP_HEADROOM_SECONDS;
    const duelStartTs = betCloseTs;

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("resolved-claim"),
        treasury: treasury.publicKey,
        marketMaker: marketMaker.publicKey,
        betOpenTs,
        betCloseTs,
        duelStartTs,
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
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });
    await waitForChainUnixTimestamp(
      provider.connection,
      betCloseTs + 1,
      LOCALNET_CHAIN_TIME_WAIT_TIMEOUT_MS,
    );
    await upsertDuel(fightProgram, authority, market.duelKey, {
      status: duelStatusLocked(),
      betOpenTs,
      betCloseTs,
      duelStartTs,
      metadataUri: "https://hyperia.gg/tests/demo/locked",
    });
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    let marketState = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.deepStrictEqual(marketState.status, { locked: {} });

    await proposeDuelResult(fightProgram, authority, market.duelKey, {
      winner: marketSideA(),
      duelEndTs: betCloseTs,
      seed: 777,
      metadataUri: "https://hyperia.gg/tests/demo/resolved",
    });
    await finalizeDuelResult(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    marketState = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.deepStrictEqual(marketState.status, { resolved: {} });
    assert.deepStrictEqual(marketState.winner, { a: {} });

    const marketMakerBefore = await provider.connection.getBalance(
      marketMaker.publicKey,
    );
    const userBalance = await claimClobWinnings(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
    });

    const takerBalance = await provider.connection.getAccountInfo(userBalance);
    assert.strictEqual(takerBalance, null);

    const marketMakerAfter = await provider.connection.getBalance(
      marketMaker.publicKey,
    );
    assert.strictEqual(marketMakerAfter - marketMakerBefore, 20);
  });

  it("refunds cancelled markets based on exact collateral and fee escrow", async () => {
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
      { duelKey: uniqueDuelKey("cancelled-refund") },
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

    await cancelDuel(
      fightProgram,
      authority,
      market.duelKey,
      "https://hyperia.gg/tests/demo/cancelled",
    );
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    const takerStateBeforeClaim = await clobProgram.account.userBalance.fetch(
      takerBid.userBalance,
    );
    assert.strictEqual(takerStateBeforeClaim.aShares.toString(), "1000");
    assert.strictEqual(takerStateBeforeClaim.bShares.toString(), "0");
    assert.strictEqual(takerStateBeforeClaim.aLockedLamports.toString(), "600");
    assert.strictEqual(
      takerStateBeforeClaim.tradeTreasuryFeeLamports.toString(),
      "6",
    );
    assert.strictEqual(
      takerStateBeforeClaim.tradeMarketMakerFeeLamports.toString(),
      "6",
    );
    const vaultBalanceBeforeClaim = await provider.connection.getBalance(
      market.vault,
    );

    const userBalance = await claimClobWinnings(clobProgram, {
      marketState: market.marketState,
      duelState: market.duelState,
      config: market.config,
      marketMaker: market.marketMaker,
      vault: market.vault,
      user: taker,
    });
    const vaultBalanceAfterClaim = await provider.connection.getBalance(
      market.vault,
    );
    const takerState = await provider.connection.getAccountInfo(userBalance);
    assert.strictEqual(takerState, null);
    assert.strictEqual(
      vaultBalanceBeforeClaim - vaultBalanceAfterClaim,
      Number(takerStateBeforeClaim.aLockedLamports.toString()) +
        Number(takerStateBeforeClaim.tradeTreasuryFeeLamports.toString()) +
        Number(takerStateBeforeClaim.tradeMarketMakerFeeLamports.toString()),
    );
  });

  it("keeps disputed proposals fail-closed and rejects settlement", async () => {
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, maker.publicKey, 5),
      airdrop(provider.connection, taker.publicKey, 5),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const betOpenTs = now - 120;
    const betCloseTs = now + LOCALNET_ORDER_SETUP_HEADROOM_SECONDS;
    const duelStartTs = betCloseTs;

    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: uniqueDuelKey("disputed-claim"),
        betOpenTs,
        betCloseTs,
        duelStartTs,
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
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });
    await waitForChainUnixTimestamp(
      provider.connection,
      betCloseTs + 1,
      LOCALNET_CHAIN_TIME_WAIT_TIMEOUT_MS,
    );
    await upsertDuel(fightProgram, authority, market.duelKey, {
      status: duelStatusLocked(),
      betOpenTs,
      betCloseTs,
      duelStartTs,
    });

    await proposeDuelResult(fightProgram, authority, market.duelKey, {
      winner: marketSideA(),
      duelEndTs: betCloseTs,
    });
    await challengeDuelResult(fightProgram, authority, market.duelKey);
    await syncMarketFromDuel(clobProgram, market.marketState, market.duelState);

    const marketState = await clobProgram.account.marketState.fetch(
      market.marketState,
    );
    assert.deepStrictEqual(marketState.status, { locked: {} });

    try {
      await finalizeDuelResult(fightProgram, authority, market.duelKey);
      assert.fail("finalization after challenge should fail");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NotProposed"),
        `expected NotProposed, got ${String(error)}`,
      );
    }

    try {
      await claimClobWinnings(clobProgram, {
        marketState: market.marketState,
        duelState: market.duelState,
        config: market.config,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: taker,
      });
      assert.fail("claim succeeded while proposal was challenged");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotResolved"),
        `expected MarketNotResolved, got ${String(error)}`,
      );
    }

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
        price: 550,
        amount: 1000,
      });
      assert.fail("order placement succeeded while market was challenged");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "MarketNotOpen"),
        `expected MarketNotOpen, got ${String(error)}`,
      );
    }

    await ensureOracleReady(fightProgram, authority, authority.publicKey);
  });

  it("rejects unauthorized finalization", async () => {
    const outsider = Keypair.generate();
    await airdrop(provider.connection, outsider.publicKey, 2);

    const duelKey = uniqueDuelKey("unauthorized-finalize");
    const now = Math.floor(Date.now() / 1000);
    await upsertDuel(fightProgram, authority, duelKey, {
      status: duelStatusLocked(),
      betOpenTs: now - 120,
      betCloseTs: now - 10,
      duelStartTs: now - 5,
    });
    await proposeDuelResult(fightProgram, authority, duelKey, {
      winner: marketSideA(),
      duelEndTs: now,
    });

    try {
      await finalizeDuelResult(fightProgram, outsider, duelKey);
      assert.fail("outsider finalization should fail");
    } catch (error: unknown) {
      assert.ok(hasProgramError(error, "Unauthorized"));
    }
  });

  it("rejects finalization before a result has been proposed", async () => {
    const duelKey = uniqueDuelKey("finalize-before-propose");
    const now = Math.floor(Date.now() / 1000);

    await upsertDuel(fightProgram, authority, duelKey, {
      status: duelStatusLocked(),
      betOpenTs: now - 120,
      betCloseTs: now - 10,
      duelStartTs: now - 5,
    });

    try {
      await finalizeDuelResult(fightProgram, authority, duelKey);
      assert.fail("finalization before propose should fail");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "NotProposed"),
        `expected NotProposed, got ${String(error)}`,
      );
    }
  });

  it("rejects finalization while the dispute window is still active", async () => {
    await ensureOracleReady(
      fightProgram,
      authority,
      authority.publicKey,
      authority.publicKey,
      authority.publicKey,
      120,
    );

    const duelKey = uniqueDuelKey("finalize-dispute-window");
    const now = Math.floor(Date.now() / 1000);
    await upsertDuel(fightProgram, authority, duelKey, {
      status: duelStatusLocked(),
      betOpenTs: now - 120,
      betCloseTs: now - 10,
      duelStartTs: now - 5,
    });
    await proposeDuelResult(fightProgram, authority, duelKey, {
      winner: marketSideA(),
      duelEndTs: now,
    });

    try {
      await finalizeDuelResult(
        fightProgram,
        authority,
        duelKey,
        "https://hyperia.gg/duels/final",
        { skipDisputeWindowWait: true },
      );
      assert.fail("finalization during dispute window should fail");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "DisputeWindowActive"),
        `expected DisputeWindowActive, got ${String(error)}`,
      );
    }

    await ensureOracleReady(fightProgram, authority, authority.publicKey);
  });

  it("rejects challenges after the dispute window expires and allows finalization", async () => {
    await ensureOracleReady(
      fightProgram,
      authority,
      authority.publicKey,
      authority.publicKey,
      authority.publicKey,
      60,
    );

    const duelKey = uniqueDuelKey("late-challenge-window");
    const now = Math.floor(Date.now() / 1000);
    await upsertDuel(fightProgram, authority, duelKey, {
      status: duelStatusLocked(),
      betOpenTs: now - 120,
      betCloseTs: now - 10,
      duelStartTs: now - 5,
    });
    await proposeDuelResult(fightProgram, authority, duelKey, {
      winner: marketSideA(),
      duelEndTs: now,
    });

    await new Promise((resolve) => setTimeout(resolve, 61_500));

    try {
      await challengeDuelResult(fightProgram, authority, duelKey);
      assert.fail("late challenge should fail");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "ChallengeWindowExpired"),
        `expected ChallengeWindowExpired, got ${String(error)}`,
      );
    }

    await finalizeDuelResult(fightProgram, authority, duelKey);
    await ensureOracleReady(fightProgram, authority, authority.publicKey);
  });

  it("rejects lifecycle regression after a duel is locked", async () => {
    const duelKey = uniqueDuelKey("locked-regression");
    const now = Math.floor(Date.now() / 1000);

    await upsertDuel(fightProgram, authority, duelKey, {
      participantAHash: hashLabel("agent-a"),
      participantBHash: hashLabel("agent-b"),
      status: duelStatusLocked(),
      betOpenTs: now - 120,
      betCloseTs: now - 10,
      duelStartTs: now - 5,
      metadataUri: "https://hyperia.gg/tests/demo/locked",
    });

    try {
      await upsertDuel(fightProgram, authority, duelKey, {
        participantAHash: hashLabel("agent-a"),
        participantBHash: hashLabel("agent-b"),
        status: duelStatusScheduled(),
        betOpenTs: now - 60,
        betCloseTs: now + 60,
        duelStartTs: now + 120,
        metadataUri: "https://hyperia.gg/tests/demo/regressed",
      });
      assert.fail("lifecycle regression succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "InvalidLifecycleTransition"),
        `expected InvalidLifecycleTransition, got ${String(error)}`,
      );
    }
  });

  it("rejects repeated cancellation after a duel is already cancelled", async () => {
    const market = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      { duelKey: uniqueDuelKey("cancelled-twice") },
    );

    await cancelDuel(
      fightProgram,
      authority,
      market.duelKey,
      "https://hyperia.gg/tests/demo/cancelled-once",
    );

    try {
      await cancelDuel(
        fightProgram,
        authority,
        market.duelKey,
        "https://hyperia.gg/tests/demo/cancelled-twice",
      );
      assert.fail("repeated cancellation succeeded");
    } catch (error: unknown) {
      assert.ok(
        hasProgramError(error, "DuelAlreadyFinalized"),
        `expected DuelAlreadyFinalized, got ${String(error)}`,
      );
    }
  });
});
