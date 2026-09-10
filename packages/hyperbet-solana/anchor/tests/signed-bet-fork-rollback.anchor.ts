import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ORDER_BEHAVIOR_GTC,
  SIDE_BID,
  airdrop,
  createOpenMarketFixture,
  deriveOrderPda,
  derivePriceLevelPda,
  deriveUserBalancePda,
  uniqueDuelKey,
} from "./clob-test-helpers";
import { configureAnchorTests } from "./test-anchor";
import { FightOracle } from "../target/types/fight_oracle";
import { DuelMarket } from "../target/types/duel_market";

const PROCESS_TIMEOUT_MS = 30_000;
const CONFIRMED_FORK_TIMEOUT_MS = 10_000;
const anchorRoot = process.cwd();
const keeperRoot = path.resolve(anchorRoot, "../keeper");

type CapturedProcess = {
  child: ChildProcessWithoutNullStreams;
  diagnostics: () => string;
};

type ValidatorFixture = CapturedProcess & {
  connection: Connection;
  rpcUrl: string;
};

type KeeperFixture = CapturedProcess & {
  baseUrl: string;
};

type BetResponse = {
  status: number;
  body: Record<string, unknown>;
};

type KeeperStatus = {
  readiness?: { ready?: unknown };
  stats?: { trackedBets?: unknown };
  parsers?: {
    solana?: {
      lastSuccessAt?: unknown;
      lastError?: unknown;
      snapshot?: Record<string, unknown> | null;
    };
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureProcess(
  child: ChildProcessWithoutNullStreams,
): CapturedProcess {
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-60_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, diagnostics: () => output };
}

async function stopProcess(process: CapturedProcess): Promise<void> {
  const isRunning = () =>
    process.child.exitCode === null && process.child.signalCode === null;
  if (isRunning()) {
    const exited = once(process.child, "exit");
    process.child.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000)]);
  }
  if (isRunning()) {
    const exited = once(process.child, "exit");
    process.child.kill("SIGKILL");
    await exited;
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reserveValidatorPorts(): Promise<{
  rpcPort: number;
  faucetPort: number;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rpcServer = createServer();
    const wsServer = createServer();
    const faucetServer = createServer();
    rpcServer.unref();
    wsServer.unref();
    faucetServer.unref();
    try {
      await listen(rpcServer, 0);
      const rpcAddress = rpcServer.address();
      assert.ok(rpcAddress && typeof rpcAddress === "object");
      if (rpcAddress.port >= 65_534) continue;
      await listen(wsServer, rpcAddress.port + 1);
      await listen(faucetServer, 0);
      const faucetAddress = faucetServer.address();
      assert.ok(faucetAddress && typeof faucetAddress === "object");
      return {
        rpcPort: rpcAddress.port,
        faucetPort: faucetAddress.port,
      };
    } catch {
      // Retry until a consecutive RPC/WebSocket pair is available.
    } finally {
      if (rpcServer.listening) await close(rpcServer);
      if (wsServer.listening) await close(wsServer);
      if (faucetServer.listening) await close(faucetServer);
    }
  }
  throw new Error("unable to reserve validator ports");
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();
  await listen(server, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await close(server);
  return port;
}

async function waitForRpc(rpcUrl: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getHealth",
        }),
        signal: AbortSignal.timeout(1_000),
      });
      const payload = (await response.json()) as { result?: unknown };
      if (payload.result === "ok") return;
    } catch {
      // The replacement validator has not bound its socket yet.
    }
    await sleep(100);
  }
  throw new Error(`validator RPC did not become healthy at ${rpcUrl}`);
}

async function waitForProgram(
  connection: Connection,
  programId: PublicKey,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const account = await connection.getAccountInfo(programId, "confirmed");
    if (account?.executable) return;
    await sleep(100);
  }
  throw new Error(`program ${programId.toBase58()} did not become executable`);
}

async function startValidator(input: {
  rpcPort: number;
  faucetPort: number;
  ledgerPath: string;
  walletPath: string;
  mintAuthority: PublicKey;
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
}): Promise<ValidatorFixture> {
  const rpcUrl = `http://127.0.0.1:${input.rpcPort}`;
  const child = spawn(
    "solana-test-validator",
    [
      "--reset",
      "--quiet",
      "--rpc-port",
      String(input.rpcPort),
      "--faucet-port",
      String(input.faucetPort),
      "--mint",
      input.mintAuthority.toBase58(),
      "--ledger",
      input.ledgerPath,
      "--upgradeable-program",
      input.fightProgramId.toBase58(),
      path.join(anchorRoot, "target/deploy/fight_oracle.so"),
      input.walletPath,
      "--upgradeable-program",
      input.marketProgramId.toBase58(),
      path.join(anchorRoot, "target/deploy/duel_market.so"),
      input.walletPath,
    ],
    { cwd: anchorRoot, stdio: ["pipe", "pipe", "pipe"] },
  );
  const captured = captureProcess(child);
  try {
    await waitForRpc(rpcUrl);
    const connection = new Connection(rpcUrl, "confirmed");
    for (const programId of [input.fightProgramId, input.marketProgramId]) {
      await waitForProgram(connection, programId);
    }
    return { ...captured, connection, rpcUrl };
  } catch (error) {
    await stopProcess(captured);
    throw new Error(`${String(error)}\n${captured.diagnostics()}`);
  }
}

async function startKeeper(input: {
  rpcUrl: string;
  port: number;
  tempRoot: string;
}): Promise<KeeperFixture> {
  const child = spawn("bun", ["--bun", "src/service.ts"], {
    cwd: keeperRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HYPERBET_RUNTIME_ROLE: "service",
      SOLANA_CLUSTER: "localnet",
      CLUSTER: "localnet",
      SOLANA_RPC_URL: input.rpcUrl,
      PORT: String(input.port),
      KEEPER_DB_PATH: path.join(input.tempRoot, "keeper.sqlite"),
      KEEPER_BOT_HEALTH_FILE: path.join(input.tempRoot, "bot-health.json"),
      KEEPER_STREAM_STATE_FILE: path.join(input.tempRoot, "stream-state.json"),
      SOLANA_LIFECYCLE_INDEX_START_SLOT: "0",
      CONTRACT_POLL_MS: "5000",
      STREAM_STATE_SOURCE_EVENTS_ENABLED: "false",
      DISABLE_RATE_LIMIT: "true",
      ARENA_EXTERNAL_BET_WRITE_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const captured = captureProcess(child);
  const keeper = {
    ...captured,
    baseUrl: `http://127.0.0.1:${input.port}`,
  };
  try {
    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`keeper exited with code ${child.exitCode}`);
      }
      try {
        const response = await fetch(keeper.baseUrl, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          await response.body?.cancel();
          return keeper;
        }
      } catch {
        // The keeper has not bound its socket yet.
      }
      await sleep(100);
    }
    throw new Error("keeper did not become ready");
  } catch (error) {
    await stopProcess(captured);
    throw new Error(`${String(error)}\n${captured.diagnostics()}`);
  }
}

async function postBet(
  keeper: KeeperFixture,
  payload: Record<string, unknown>,
): Promise<BetResponse> {
  const response = await fetch(
    `${keeper.baseUrl}/api/arena/bet/record-external`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function waitForRolledBackResponse(
  keeper: KeeperFixture,
  payload: Record<string, unknown>,
): Promise<BetResponse> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let lastResponse: BetResponse | null = null;
  while (Date.now() < deadline) {
    try {
      lastResponse = await postBet(keeper, payload);
      assert.notEqual(
        lastResponse.status,
        200,
        `rolled-back signature was accepted: ${JSON.stringify(lastResponse.body)}`,
      );
      if (lastResponse.status === 425) return lastResponse;
    } catch {
      // The keeper/RPC connection can be transiently unavailable after reset.
    }
    await sleep(250);
  }
  throw new Error(
    `keeper did not settle into pending rollback state: ${JSON.stringify(lastResponse)}`,
  );
}

async function trackedBetCount(keeper: KeeperFixture): Promise<number> {
  const body = await readKeeperStatus(keeper);
  assert.equal(typeof body.stats?.trackedBets, "number");
  return body.stats!.trackedBets as number;
}

async function readKeeperStatus(keeper: KeeperFixture): Promise<KeeperStatus> {
  const response = await fetch(`${keeper.baseUrl}/status`, {
    signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as KeeperStatus;
}

async function waitForFinalizedIndexCheckpoint(
  keeper: KeeperFixture,
): Promise<string> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let lastStatus: KeeperStatus | null = null;
  while (Date.now() < deadline) {
    lastStatus = await readKeeperStatus(keeper);
    const parser = lastStatus.parsers?.solana;
    const checkpoint = parser?.snapshot?.lifecycleIndexCheckpointSignature;
    if (
      typeof parser?.lastSuccessAt === "number" &&
      parser.lastError === null &&
      typeof checkpoint === "string" &&
      checkpoint.length > 0
    ) {
      return checkpoint;
    }
    await sleep(100);
  }
  throw new Error(
    `keeper did not establish a finalized index checkpoint: ${JSON.stringify(lastStatus)}`,
  );
}

async function waitForCheckpointRollbackFailure(
  keeper: KeeperFixture,
  checkpoint: string,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let lastStatus: KeeperStatus | null = null;
  while (Date.now() < deadline) {
    lastStatus = await readKeeperStatus(keeper);
    const parser = lastStatus.parsers?.solana;
    const error = parser?.lastError;
    const visibleCheckpoint =
      parser?.snapshot?.lifecycleIndexCheckpointSignature;
    if (
      lastStatus.readiness?.ready === false &&
      typeof error === "string" &&
      /checkpoint|finalized history/i.test(error) &&
      (visibleCheckpoint === checkpoint || visibleCheckpoint === undefined)
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `keeper did not fail closed on rolled-back checkpoint ${checkpoint}: ${JSON.stringify(lastStatus)}`,
  );
}

async function waitForConfirmedFork(
  connection: Connection,
  signature: string,
): Promise<void> {
  const deadline = Date.now() + CONFIRMED_FORK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [status] = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value;
    assert.equal(status?.err ?? null, null);
    if (status?.confirmationStatus === "finalized") {
      throw new Error("fork transaction finalized before rollback injection");
    }
    if (status?.confirmationStatus === "confirmed") return;
    await sleep(25);
  }
  throw new Error("fork transaction did not reach confirmed status");
}

describe("signed bettor pre-finality fork rollback", () => {
  const walletPath = process.env.ANCHOR_WALLET;
  assert.ok(walletPath, "ANCHOR_WALLET is required");
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8")) as number[]),
  );
  const fightIdl = JSON.parse(
    readFileSync(path.join(anchorRoot, "target/idl/fight_oracle.json"), "utf8"),
  ) as anchor.Idl;
  const marketIdl = JSON.parse(
    readFileSync(path.join(anchorRoot, "target/idl/duel_market.json"), "utf8"),
  ) as anchor.Idl;
  const fightProgramId = new PublicKey(fightIdl.address);
  const marketProgramId = new PublicKey(marketIdl.address);
  const tempRoot = mkdtempSync(path.join(tmpdir(), "hyperbet-fork-rollback-"));
  let validator: ValidatorFixture | null = null;
  let keeper: KeeperFixture | null = null;

  afterEach(async () => {
    if (keeper) await stopProcess(keeper);
    if (validator) await stopProcess(validator);
    keeper = null;
    validator = null;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("never records or rewards an order discarded with its confirmed fork", async () => {
    const ports = await reserveValidatorPorts();
    const keeperPort = await reserveLoopbackPort();
    const validatorConfig = {
      ...ports,
      ledgerPath: path.join(tempRoot, "validator-ledger"),
      walletPath,
      mintAuthority: authority.publicKey,
      fightProgramId,
      marketProgramId,
    };
    validator = await startValidator(validatorConfig);
    process.env.ANCHOR_PROVIDER_URL = validator.rpcUrl;
    const provider = configureAnchorTests();
    const fightProgram = new Program<FightOracle>(
      fightIdl as FightOracle,
      provider,
    );
    const marketProgram = new Program<DuelMarket>(
      marketIdl as DuelMarket,
      provider,
    );
    const bettor = Keypair.generate();
    await airdrop(provider.connection, bettor.publicKey, 2);
    const duelId = "signed-bet-fork-rollback";
    const duelKey = uniqueDuelKey(duelId);
    const market = await createOpenMarketFixture(
      fightProgram,
      marketProgram,
      authority,
      {
        duelKey,
        metadataUri: JSON.stringify({
          duelId,
          duelKeyHex: Buffer.from(duelKey).toString("hex"),
        }),
      },
    );
    keeper = await startKeeper({
      rpcUrl: validator.rpcUrl,
      port: keeperPort,
      tempRoot,
    });
    const finalizedCheckpoint = await waitForFinalizedIndexCheckpoint(keeper);

    const orderId = 1;
    const price = 600;
    const amount = 100_000;
    const order = deriveOrderPda(
      marketProgram.programId,
      market.marketState,
      orderId,
    );
    const instruction = await marketProgram.methods
      .placeOrder(
        new BN(orderId),
        SIDE_BID,
        price,
        new BN(amount),
        ORDER_BEHAVIOR_GTC,
      )
      .accountsPartial({
        marketState: market.marketState,
        duelState: market.duelState,
        userBalance: deriveUserBalancePda(
          marketProgram.programId,
          market.marketState,
          bettor.publicKey,
        ),
        newOrder: order,
        restingLevel: derivePriceLevelPda(
          marketProgram.programId,
          market.marketState,
          SIDE_BID,
          price,
        ),
        config: market.config,
        treasury: market.treasury,
        marketMaker: market.marketMaker,
        vault: market.vault,
        user: bettor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const { blockhash } =
      await provider.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: authority.publicKey,
      recentBlockhash: blockhash,
    }).add(instruction);
    transaction.sign(authority, bettor);
    const signature = await provider.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 0,
      },
    );
    await waitForConfirmedFork(provider.connection, signature);
    const confirmedTransaction = await provider.connection.getTransaction(
      signature,
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    );
    assert.equal(confirmedTransaction?.meta?.err, null);
    assert.ok(await provider.connection.getAccountInfo(order, "confirmed"));

    const payload = {
      bettorWallet: bettor.publicKey.toBase58(),
      txSignature: signature,
      marketPda: market.marketState.toBase58(),
      duelKey: Buffer.from(market.duelKey).toString("hex"),
      duelId,
    };
    const beforeRollback = await postBet(keeper, payload);
    assert.equal(
      beforeRollback.status,
      425,
      `${JSON.stringify(beforeRollback.body)}\n${keeper.diagnostics()}`,
    );
    assert.equal(beforeRollback.body.retryable, true);
    assert.equal(beforeRollback.body.verificationCode, "transaction-not-found");
    assert.equal(await trackedBetCount(keeper), 0);

    await stopProcess(validator);
    validator = null;
    validator = await startValidator(validatorConfig);
    const [rolledBackStatus] = (
      await validator.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value;
    assert.equal(rolledBackStatus, null);
    assert.equal(
      await validator.connection.getAccountInfo(
        market.marketState,
        "confirmed",
      ),
      null,
    );
    assert.equal(
      await validator.connection.getAccountInfo(order, "confirmed"),
      null,
    );

    const afterRollback = await waitForRolledBackResponse(keeper, payload);
    assert.equal(afterRollback.body.retryable, true);
    assert.equal(afterRollback.body.verificationCode, "transaction-not-found");
    assert.equal(await trackedBetCount(keeper), 0);
    await waitForCheckpointRollbackFailure(keeper, finalizedCheckpoint);

    await stopProcess(keeper);
    keeper = null;
    keeper = await startKeeper({
      rpcUrl: validator.rpcUrl,
      port: keeperPort,
      tempRoot,
    });
    assert.equal(await trackedBetCount(keeper), 0);
    await waitForCheckpointRollbackFailure(keeper, finalizedCheckpoint);
    const afterKeeperRestart = await waitForRolledBackResponse(keeper, payload);
    assert.equal(
      afterKeeperRestart.body.verificationCode,
      "transaction-not-found",
    );
    assert.equal(await trackedBetCount(keeper), 0);
  });
});
