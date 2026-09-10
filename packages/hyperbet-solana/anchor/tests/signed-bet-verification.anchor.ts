import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SIDE_ASK,
  SIDE_BID,
  airdrop,
  createOpenMarketFixture,
  placeClobOrder,
  uniqueDuelKey,
  writableAccount,
} from "./clob-test-helpers";
import { configureAnchorTests } from "./test-anchor";
import { FightOracle } from "../target/types/fight_oracle";
import { DuelMarket } from "../target/types/duel_market";

const HTTP_TIMEOUT_MS = 30_000;
const FINALITY_TIMEOUT_MS = 90_000;
const keeperRoot = path.resolve(process.cwd(), "../keeper");

type JsonResponse = {
  status: number;
  body: Record<string, unknown>;
};

type ServiceFixture = {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  diagnostics: () => string;
  tempRoot: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForFinalizedSignature(
  connection: anchor.web3.Connection,
  signature: string,
  expectedSucceeded: boolean,
): Promise<void> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  let lastStatus = "not-found";
  while (Date.now() < deadline) {
    const [status] = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value;
    lastStatus = JSON.stringify(status);
    if (status?.confirmationStatus === "finalized") {
      assert.equal(
        status.err === null,
        expectedSucceeded,
        `unexpected finalized outcome for ${signature}: ${lastStatus}`,
      );
      return;
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for finalized signature ${signature}; last=${lastStatus}`,
  );
}

async function stopKeeperService(service: ServiceFixture): Promise<void> {
  if (service.child.exitCode === null) {
    service.child.kill("SIGTERM");
    await Promise.race([once(service.child, "exit"), sleep(5_000)]);
  }
  if (service.child.exitCode === null) {
    service.child.kill("SIGKILL");
    await once(service.child, "exit");
  }
  rmSync(service.tempRoot, { recursive: true, force: true });
}

async function startKeeperService(
  connection: anchor.web3.Connection,
): Promise<ServiceFixture> {
  const port = await reserveLoopbackPort();
  const tempRoot = mkdtempSync(path.join(tmpdir(), "hyperbet-signed-bet-"));
  const output: string[] = [];
  const child = spawn("bun", ["--bun", "src/service.ts"], {
    cwd: keeperRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HYPERBET_RUNTIME_ROLE: "service",
      SOLANA_CLUSTER: "localnet",
      CLUSTER: "localnet",
      SOLANA_RPC_URL: connection.rpcEndpoint,
      PORT: String(port),
      KEEPER_DB_PATH: path.join(tempRoot, "keeper.sqlite"),
      KEEPER_BOT_HEALTH_FILE: path.join(tempRoot, "bot-health.json"),
      KEEPER_STREAM_STATE_FILE: path.join(tempRoot, "stream-state.json"),
      CONTRACT_POLL_MS: "5000",
      STREAM_STATE_SOURCE_EVENTS_ENABLED: "false",
      DISABLE_RATE_LIMIT: "true",
      ARENA_EXTERNAL_BET_WRITE_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const appendOutput = (chunk: Buffer): void => {
    output.push(chunk.toString("utf8"));
    const joined = output.join("");
    if (joined.length > 40_000) {
      output.splice(0, output.length, joined.slice(-40_000));
    }
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  const fixture: ServiceFixture = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    diagnostics: () => output.join(""),
    tempRoot,
  };
  try {
    const deadline = Date.now() + HTTP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `keeper service exited during startup (${child.exitCode})\n${output.join("")}`,
        );
      }
      try {
        const response = await fetch(fixture.baseUrl, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          await response.body?.cancel();
          return fixture;
        }
      } catch {
        // The process has not bound its loopback socket yet.
      }
      await sleep(100);
    }
    throw new Error(`keeper service did not become ready\n${output.join("")}`);
  } catch (error) {
    await stopKeeperService(fixture);
    throw error;
  }
}

async function postBet(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}/api/arena/bet/record-external`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function postFinalizedBet(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<JsonResponse> {
  const deadline = Date.now() + HTTP_TIMEOUT_MS;
  let response: JsonResponse | null = null;
  while (Date.now() < deadline) {
    response = await postBet(baseUrl, payload);
    if (response.status !== 425 && response.status !== 503) return response;
    await sleep(250);
  }
  throw new Error(
    `keeper did not finish finalized verification: ${JSON.stringify(response)}`,
  );
}

async function waitForReconciledSettlementHistory(
  baseUrl: string,
  wallet: string,
  diagnostics: () => string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + HTTP_TIMEOUT_MS;
  let lastBody: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/api/arena/settlements/${encodeURIComponent(wallet)}?limit=10&offset=0`,
      { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
    lastBody = (await response.json()) as Record<string, unknown>;
    const ledger = lastBody.ledger as { current?: unknown } | undefined;
    const entries = Array.isArray(lastBody.entries) ? lastBody.entries : [];
    if (
      response.status === 200 &&
      ledger?.current === true &&
      lastBody.total === 2 &&
      entries.length === 2 &&
      entries.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as { reconciledAt?: unknown }).reconciledAt ===
            "number",
      )
    ) {
      return lastBody;
    }
    await sleep(100);
  }
  throw new Error(
    `settlement history did not reconcile: ${JSON.stringify(lastBody)}\n${diagnostics()}`,
  );
}

function assertHistoryEntry(
  entry: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): void {
  assert.ok(entry, "expected reconciled settlement-history entry");
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(
      entry[field],
      value,
      `unexpected settlement-history field ${field}`,
    );
  }
  assert.equal(
    typeof entry.reconciledAt,
    "number",
    "settlement-history entry must expose reconciliation time",
  );
}

async function sendFinalizedFailedTransfer(
  connection: anchor.web3.Connection,
): Promise<string> {
  const signer = Keypair.generate();
  await airdrop(connection, signer.publicKey, 0.01);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: LAMPORTS_PER_SOL,
    }),
  );
  transaction.sign(signer);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { skipPreflight: true, maxRetries: 3 },
  );
  await waitForFinalizedSignature(connection, signature, false);
  return signature;
}

describe("finalized signed bettor transaction verification", () => {
  const provider = configureAnchorTests();
  anchor.setProvider(provider);
  const fightProgram = anchor.workspace.FightOracle as Program<FightOracle>;
  const clobProgram = anchor.workspace.DuelMarket as Program<DuelMarket>;
  const authority = (provider.wallet as anchor.Wallet & { payer: Keypair })
    .payer;
  let service: ServiceFixture | null = null;

  afterEach(async () => {
    if (service) {
      await stopKeeperService(service);
      service = null;
    }
  });

  it("accepts only the finalized canonical place-order evidence supplied by the bettor", async () => {
    const bettor = Keypair.generate();
    const wrongWallet = Keypair.generate();
    const matchedMaker = Keypair.generate();
    await Promise.all([
      airdrop(provider.connection, bettor.publicKey, 2),
      airdrop(provider.connection, wrongWallet.publicKey, 1),
      airdrop(provider.connection, matchedMaker.publicKey, 2),
    ]);

    const primaryDuelId = "signed-bet-primary";
    const primaryDuelKey = uniqueDuelKey(primaryDuelId);
    const foreignDuelId = "signed-bet-foreign";
    const foreignDuelKey = uniqueDuelKey(foreignDuelId);
    const matchedDuelId = "signed-bet-matched";
    const matchedDuelKey = uniqueDuelKey(matchedDuelId);
    const metadataUri = (duelId: string, duelKey: readonly number[]) =>
      JSON.stringify({
        duelId,
        duelKeyHex: Buffer.from(duelKey).toString("hex"),
      });

    const primaryMarket = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: primaryDuelKey,
        metadataUri: metadataUri(primaryDuelId, primaryDuelKey),
      },
    );
    const foreignMarket = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: foreignDuelKey,
        metadataUri: metadataUri(foreignDuelId, foreignDuelKey),
      },
    );
    const matchedMarket = await createOpenMarketFixture(
      fightProgram,
      clobProgram,
      authority,
      {
        duelKey: matchedDuelKey,
        metadataUri: metadataUri(matchedDuelId, matchedDuelKey),
      },
    );
    const primaryOrder = await placeClobOrder(clobProgram, {
      marketState: primaryMarket.marketState,
      duelState: primaryMarket.duelState,
      config: primaryMarket.config,
      treasury: primaryMarket.treasury,
      marketMaker: primaryMarket.marketMaker,
      vault: primaryMarket.vault,
      user: bettor,
      orderId: 1,
      side: SIDE_BID,
      price: 600,
      amount: 100_000,
    });
    const foreignOrder = await placeClobOrder(clobProgram, {
      marketState: foreignMarket.marketState,
      duelState: foreignMarket.duelState,
      config: foreignMarket.config,
      treasury: foreignMarket.treasury,
      marketMaker: foreignMarket.marketMaker,
      vault: foreignMarket.vault,
      user: bettor,
      orderId: 1,
      side: SIDE_BID,
      price: 500,
      amount: 100_000,
    });
    const makerAsk = await placeClobOrder(clobProgram, {
      marketState: matchedMarket.marketState,
      duelState: matchedMarket.duelState,
      config: matchedMarket.config,
      treasury: matchedMarket.treasury,
      marketMaker: matchedMarket.marketMaker,
      vault: matchedMarket.vault,
      user: matchedMaker,
      orderId: 1,
      side: SIDE_ASK,
      price: 500,
      amount: 100_000,
    });
    const matchedOrder = await placeClobOrder(clobProgram, {
      marketState: matchedMarket.marketState,
      duelState: matchedMarket.duelState,
      config: matchedMarket.config,
      treasury: matchedMarket.treasury,
      marketMaker: matchedMarket.marketMaker,
      vault: matchedMarket.vault,
      user: bettor,
      orderId: 2,
      side: SIDE_BID,
      price: 600,
      amount: 100_000,
      remainingAccounts: [
        writableAccount(makerAsk.restingLevel),
        writableAccount(makerAsk.order),
        writableAccount(makerAsk.userBalance),
      ],
    });
    const unrelatedSignature = await (
      clobProgram.provider as anchor.AnchorProvider
    ).sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: bettor.publicKey,
          toPubkey: wrongWallet.publicKey,
          lamports: 1,
        }),
      ),
      [bettor],
    );
    const failedSignature = await sendFinalizedFailedTransfer(
      provider.connection,
    );

    await Promise.all([
      waitForFinalizedSignature(
        provider.connection,
        primaryOrder.signature,
        true,
      ),
      waitForFinalizedSignature(
        provider.connection,
        foreignOrder.signature,
        true,
      ),
      waitForFinalizedSignature(
        provider.connection,
        matchedOrder.signature,
        true,
      ),
      waitForFinalizedSignature(provider.connection, unrelatedSignature, true),
    ]);

    service = await startKeeperService(provider.connection);
    const healthResponse = await fetch(`${service.baseUrl}/health`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const healthBody = (await healthResponse.json()) as Record<string, unknown>;
    assert.equal(healthResponse.status, 503);
    assert.deepEqual(healthBody.correlationIds, []);
    const canonicalPayload = {
      bettorWallet: bettor.publicKey.toBase58(),
      txSignature: primaryOrder.signature,
      marketPda: primaryMarket.marketState.toBase58(),
      duelKey: Buffer.from(primaryMarket.duelKey).toString("hex"),
      duelId: primaryDuelId,
    };

    const incompleteDuelIdentity = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      duelId: null,
    });
    assert.equal(
      incompleteDuelIdentity.status,
      400,
      JSON.stringify(incompleteDuelIdentity.body),
    );

    const wrongSigner = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      bettorWallet: wrongWallet.publicKey.toBase58(),
    });
    assert.equal(wrongSigner.status, 401, JSON.stringify(wrongSigner.body));
    assert.equal(
      wrongSigner.body.verificationCode,
      "wallet-signature-mismatch",
    );

    const crossMarketReplay = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      txSignature: foreignOrder.signature,
    });
    assert.equal(
      crossMarketReplay.status,
      401,
      JSON.stringify(crossMarketReplay.body),
    );
    assert.equal(
      crossMarketReplay.body.verificationCode,
      "market-pda-identity",
    );

    const wrongDuel = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      duelKey: "ff".repeat(32),
    });
    assert.equal(wrongDuel.status, 401, JSON.stringify(wrongDuel.body));
    assert.equal(wrongDuel.body.verificationCode, "market-pda-identity");

    const wrongDuelId = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      duelId: "signed-bet-wrong-duel-id",
    });
    assert.equal(wrongDuelId.status, 401, JSON.stringify(wrongDuelId.body));
    assert.equal(wrongDuelId.body.verificationCode, "duel-id-identity");

    const unrelated = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      txSignature: unrelatedSignature,
    });
    assert.equal(unrelated.status, 401, JSON.stringify(unrelated.body));
    assert.equal(unrelated.body.verificationCode, "market-instruction-count");

    const failed = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      txSignature: failedSignature,
    });
    assert.equal(failed.status, 401, JSON.stringify(failed.body));
    assert.equal(failed.body.verificationCode, undefined);

    const malformed = await postBet(service.baseUrl, {
      ...canonicalPayload,
      txSignature: "not-a-canonical-solana-signature",
    });
    assert.equal(malformed.status, 401, JSON.stringify(malformed.body));

    const matchedVerified = await postFinalizedBet(service.baseUrl, {
      bettorWallet: bettor.publicKey.toBase58(),
      txSignature: matchedOrder.signature,
      marketPda: matchedMarket.marketState.toBase58(),
      duelKey: Buffer.from(matchedMarket.duelKey).toString("hex"),
      duelId: matchedDuelId,
      sourceAmountLamports: "1",
      feeAmountLamports: "0",
      feeBps: 0,
    });
    assert.equal(
      matchedVerified.status,
      200,
      `${JSON.stringify(matchedVerified.body)}\n${service.diagnostics()}`,
    );
    assert.equal(matchedVerified.body.ok, true);
    assert.deepEqual(matchedVerified.body.execution, {
      orderId: "2",
      side: SIDE_BID,
      limitPrice: 600,
      orderBehavior: 0,
      orderAmountUnits: "100000",
      matchedAmountUnits: "100000",
      restingAmountUnits: "0",
      releasedAmountUnits: "0",
      collateralLamports: "50000",
      executedCostLamports: "50000",
      tradeTreasuryFeeLamports: "500",
      tradeMarketMakerFeeLamports: "500",
      feeAmountLamports: "1000",
      sourceAmountLamports: "51000",
      rewardEligibleLamports: "51000",
    });

    const verified = await postFinalizedBet(service.baseUrl, {
      ...canonicalPayload,
      sourceAmountLamports: "999999999999999999",
      feeAmountLamports: "999999999999999999",
      feeBps: 10_000,
    });
    assert.equal(
      verified.status,
      200,
      `${JSON.stringify(verified.body)}\n${service.diagnostics()}`,
    );
    assert.equal(verified.body.ok, true);
    assert.deepEqual(verified.body.execution, {
      orderId: "1",
      side: SIDE_BID,
      limitPrice: 600,
      orderBehavior: 0,
      orderAmountUnits: "100000",
      matchedAmountUnits: "0",
      restingAmountUnits: "100000",
      releasedAmountUnits: "0",
      collateralLamports: "60000",
      executedCostLamports: "0",
      tradeTreasuryFeeLamports: "0",
      tradeMarketMakerFeeLamports: "0",
      feeAmountLamports: "0",
      sourceAmountLamports: "60000",
      rewardEligibleLamports: "0",
    });

    const duplicate = await postFinalizedBet(service.baseUrl, canonicalPayload);
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.ok, true);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.pointsAwarded, 0);

    const history = await waitForReconciledSettlementHistory(
      service.baseUrl,
      bettor.publicKey.toBase58(),
      service.diagnostics,
    );
    assert.equal(history.schemaVersion, 2);
    assert.equal(history.chain, "SOLANA");
    assert.equal(history.asset, "SOL");
    assert.equal(history.decimals, 9);
    assert.equal(history.cluster, "localnet");
    assert.equal(history.programId, clobProgram.programId.toBase58());
    const entries = history.entries as Array<Record<string, unknown>>;
    const restingHistory = entries.find(
      (entry) => entry.marketPda === primaryMarket.marketState.toBase58(),
    );
    const matchedHistory = entries.find(
      (entry) => entry.marketPda === matchedMarket.marketState.toBase58(),
    );
    assertHistoryEntry(restingHistory, {
      wallet: bettor.publicKey.toBase58(),
      marketPda: primaryMarket.marketState.toBase58(),
      duelKey: Buffer.from(primaryMarket.duelKey).toString("hex"),
      duelId: primaryDuelId,
      placeSignature: primaryOrder.signature,
      orderId: "1",
      side: SIDE_BID,
      limitPrice: 600,
      orderAmountUnits: "100000",
      matchedAmountUnits: "0",
      restingAmountUnits: "100000",
      releasedAmountUnits: "0",
      sourceAmountLamports: "60000",
      collateralLamports: "60000",
      executedCostLamports: "0",
      tradeFeeLamports: "0",
      orderRefundLamports: "0",
      rewardEligibleLamports: "0",
      orderState: "OPEN",
      settlementState: "NOT_READY",
      claimSignature: null,
      terminalGrossLamports: "0",
      terminalPayoutLamports: "0",
      terminalFeeLamports: "0",
      settledAt: null,
    });
    assertHistoryEntry(matchedHistory, {
      wallet: bettor.publicKey.toBase58(),
      marketPda: matchedMarket.marketState.toBase58(),
      duelKey: Buffer.from(matchedMarket.duelKey).toString("hex"),
      duelId: matchedDuelId,
      placeSignature: matchedOrder.signature,
      orderId: "2",
      side: SIDE_BID,
      limitPrice: 600,
      orderAmountUnits: "100000",
      matchedAmountUnits: "100000",
      restingAmountUnits: "0",
      releasedAmountUnits: "0",
      sourceAmountLamports: "51000",
      collateralLamports: "50000",
      executedCostLamports: "50000",
      tradeFeeLamports: "1000",
      orderRefundLamports: "10000",
      rewardEligibleLamports: "51000",
      orderState: "FILLED",
      settlementState: "NOT_READY",
      claimSignature: null,
      terminalGrossLamports: "0",
      terminalPayoutLamports: "0",
      terminalFeeLamports: "0",
      settledAt: null,
    });
  });
});
