import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import BN from "bn.js";
import type { DuelMarket } from "../../anchor/target/types/duel_market";
import type { FightOracle } from "../../anchor/target/types/fight_oracle";
import { canonicalEvidenceJson } from "../src/bettingFeedEvidence";
import { digestParsedTransaction } from "../src/duelDisputeEvidenceCollector";
import { collectAndVerifyFinalizedSolanaRecovery } from "../src/finalizedSolanaRecoveryCollector";
import {
  DUEL_WINNER_MARKET_KIND,
  findClobVaultPda,
  findDuelStatePda,
  findMarketConfigPda,
  findMarketPda,
  findOracleConfigPda,
  findOrderPda,
  findPriceLevelPda,
  findUserBalancePda,
} from "../src/launchCommon";
import { deriveProgramDataAddress } from "../src/solanaProgramIdentity";
import { TerminalLedger } from "../src/terminalLedger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keeperRoot = path.resolve(__dirname, "..");
const anchorRoot = path.resolve(keeperRoot, "../anchor");
const repositoryRoot = path.resolve(anchorRoot, "../../..");
const validatorExecutable =
  process.env.HYPERBET_SOLANA_TEST_VALIDATOR?.trim() ||
  "/Users/lucid/.local/share/solana/install/releases/2.3.0/solana-release/bin/solana-test-validator";
const fightBinary = path.join(anchorRoot, "target/deploy/fight_oracle.so");
const marketBinary = path.join(anchorRoot, "target/deploy/duel_market.so");
const fightIdlPath = path.join(anchorRoot, "target/idl/fight_oracle.json");
const marketIdlPath = path.join(anchorRoot, "target/idl/duel_market.json");
const FIGHT_PROGRAM_ID = new PublicKey(
  "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
);
const MARKET_PROGRAM_ID = new PublicKey(
  "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
);
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath: string): string {
  return sha256(readFileSync(filePath));
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_LOG_BYTES ? next : next.slice(-MAX_LOG_BYTES);
}

async function bindablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function rpcPortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const first = await bindablePort();
    if (first >= 65_534) continue;
    const secondFree = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port: first + 1 }, () => {
        server.close(() => resolve(true));
      });
    });
    if (secondFree) return first;
  }
  throw new Error("failed to reserve a local validator RPC port pair");
}

function writeKeypair(filePath: string, keypair: Keypair): void {
  writeFileSync(
    filePath,
    `${JSON.stringify(Array.from(keypair.secretKey))}\n`,
    {
      mode: 0o600,
      flag: "wx",
    },
  );
}

async function waitForRpc(
  rpcUrl: string,
  connection: Connection,
  child: ChildProcess,
  spawnFailure: () => Error | null,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const failure = spawnFailure();
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `local validator exited early with ${
          child.exitCode !== null
            ? `code ${child.exitCode}`
            : `signal ${child.signalCode}`
        }`,
      );
    }
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
      if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
      const body = (await response.json()) as { result?: unknown };
      if (body.result !== "ok") throw new Error("RPC health is not ok");
      await connection.getVersion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(250);
    }
  }
  throw new Error(
    `local validator did not become ready: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

async function waitForFinalized(
  connection: Connection,
  signature: string,
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) throw new Error(`transaction ${signature} failed`);
    if (status?.confirmationStatus === "finalized") return;
    await Bun.sleep(250);
  }
  throw new Error(`transaction ${signature} did not finalize`);
}

async function airdrop(
  connection: Connection,
  recipient: PublicKey,
  sol = 5,
): Promise<void> {
  const signature = await connection.requestAirdrop(
    recipient,
    sol * 1_000_000_000,
  );
  await waitForFinalized(connection, signature);
}

async function initializeOracle(input: {
  program: Program<FightOracle>;
  authority: Keypair;
  reporter: PublicKey;
  finalizer: PublicKey;
  challenger: PublicKey;
}): Promise<PublicKey> {
  const oracleConfig = findOracleConfigPda(input.program.programId);
  await input.program.methods
    .initializeOracle(
      input.reporter,
      input.finalizer,
      input.challenger,
      new BN(60),
    )
    .accountsPartial({
      authority: input.authority.publicKey,
      oracleConfig,
      program: input.program.programId,
      programData: deriveProgramDataAddress(input.program.programId),
      systemProgram: SystemProgram.programId,
    })
    .signers([input.authority])
    .rpc();
  const freezeSignature = await input.program.methods
    .freezeOracleConfig()
    .accountsPartial({
      authority: input.authority.publicKey,
      oracleConfig,
    })
    .signers([input.authority])
    .rpc();
  await waitForFinalized(input.program.provider.connection, freezeSignature);
  return oracleConfig;
}

async function initializeMarketConfig(input: {
  program: Program<DuelMarket>;
  authority: Keypair;
  marketOperator: PublicKey;
  treasury: PublicKey;
  marketMaker: PublicKey;
}): Promise<PublicKey> {
  const config = findMarketConfigPda(input.program.programId);
  await input.program.methods
    .initializeConfig(
      input.marketOperator,
      input.treasury,
      input.marketMaker,
      100,
      100,
      100,
    )
    .accountsPartial({
      authority: input.authority.publicKey,
      config,
      program: input.program.programId,
      programData: deriveProgramDataAddress(input.program.programId),
      systemProgram: SystemProgram.programId,
    })
    .signers([input.authority])
    .rpc();
  const freezeSignature = await input.program.methods
    .freezeConfig()
    .accountsPartial({ authority: input.authority.publicKey, config })
    .signers([input.authority])
    .rpc();
  await waitForFinalized(input.program.provider.connection, freezeSignature);
  return config;
}

async function initializeOpenDuel(input: {
  program: Program<FightOracle>;
  reporter: Keypair;
  duelKey: number[];
  participantAHash: number[];
  participantBHash: number[];
  snapshotDigest: number[];
  now: number;
}): Promise<PublicKey> {
  const duelState = findDuelStatePda(
    input.program.programId,
    Uint8Array.from(input.duelKey),
  );
  await input.program.methods
    .upsertDuel(
      input.duelKey,
      input.participantAHash,
      input.participantBHash,
      3,
      input.snapshotDigest,
      new BN(input.now - 60),
      new BN(input.now + 3_600),
      new BN(input.now + 3_660),
      "https://hyperia.gg/duels/owned-local-recovery",
      { bettingOpen: {} },
    )
    .accountsPartial({
      reporter: input.reporter.publicKey,
      oracleConfig: findOracleConfigPda(input.program.programId),
      duelState,
      systemProgram: SystemProgram.programId,
    })
    .signers([input.reporter])
    .rpc();
  return duelState;
}

async function initializeMarket(input: {
  program: Program<DuelMarket>;
  operator: Keypair;
  config: PublicKey;
  duelState: PublicKey;
  duelKey: number[];
}): Promise<{ marketState: PublicKey; vault: PublicKey }> {
  const marketState = findMarketPda(
    input.program.programId,
    input.duelState,
    DUEL_WINNER_MARKET_KIND,
  );
  const vault = findClobVaultPda(input.program.programId, marketState);
  await input.program.methods
    .initializeMarket(input.duelKey, DUEL_WINNER_MARKET_KIND)
    .accountsPartial({
      operator: input.operator.publicKey,
      config: input.config,
      duelState: input.duelState,
      marketState,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([input.operator])
    .rpc();
  return { marketState, vault };
}

async function ensureVaultRentExempt(input: {
  provider: AnchorProvider;
  funder: Keypair;
  vault: PublicKey;
}): Promise<void> {
  const minimum =
    await input.provider.connection.getMinimumBalanceForRentExemption(0);
  const current = await input.provider.connection.getBalance(input.vault);
  if (current >= minimum) return;
  await input.provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: input.funder.publicKey,
        toPubkey: input.vault,
        lamports: minimum - current,
      }),
    ),
    [input.funder],
  );
}

async function placeRestingOrder(input: {
  program: Program<DuelMarket>;
  marketState: PublicKey;
  duelState: PublicKey;
  config: PublicKey;
  treasury: PublicKey;
  marketMaker: PublicKey;
  vault: PublicKey;
  user: Keypair;
}): Promise<{
  userBalance: PublicKey;
  order: PublicKey;
  signature: string;
}> {
  const userBalance = findUserBalancePda(
    input.program.programId,
    input.marketState,
    input.user.publicKey,
  );
  const order = findOrderPda(input.program.programId, input.marketState, 1n);
  const restingLevel = findPriceLevelPda(
    input.program.programId,
    input.marketState,
    1,
    500,
  );
  const signature = await input.program.methods
    .placeOrder(new BN(1), 1, 500, new BN(1_000), 0)
    .accountsPartial({
      marketState: input.marketState,
      duelState: input.duelState,
      userBalance,
      newOrder: order,
      restingLevel,
      config: input.config,
      treasury: input.treasury,
      marketMaker: input.marketMaker,
      vault: input.vault,
      user: input.user.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([input.user])
    .rpc();
  return { userBalance, order, signature };
}

async function stopValidator(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  child.kill("SIGTERM");
  return await new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function requireOutputPath(arguments_: readonly string[]): string | null {
  const outputs = arguments_.filter((argument) =>
    argument.startsWith("--out="),
  );
  const unknown = arguments_
    .slice(2)
    .filter((argument) => !argument.startsWith("--out="));
  if (outputs.length > 1 || unknown.length > 0) {
    throw new Error(
      "usage: test-finalized-solana-recovery [--out=<private-json-path>]",
    );
  }
  if (outputs.length === 0) return null;
  const value = outputs[0]!.slice("--out=".length).trim();
  if (!value) throw new Error("--out requires a path");
  const absolute = path.resolve(value);
  if (existsSync(absolute)) throw new Error("output evidence already exists");
  const parent = lstatSync(path.dirname(absolute));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
    throw new Error("output evidence parent must be mode 0700");
  }
  return absolute;
}

function writeEvidence(filePath: string, evidence: unknown): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    chmodSync(filePath, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  const parent = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

async function main(): Promise<void> {
  const outputPath = requireOutputPath(process.argv);
  for (const filePath of [validatorExecutable, fightBinary, marketBinary]) {
    if (!existsSync(filePath))
      throw new Error(
        `required local qualification file is absent: ${path.basename(filePath)}`,
      );
  }
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "hyperbet-finalized-recovery-"),
  );
  chmodSync(temporaryRoot, 0o700);
  const ledgerPath = path.join(temporaryRoot, "ledger");
  const databasePath = path.join(temporaryRoot, "keeper.sqlite");
  const authorityPath = path.join(temporaryRoot, "upgrade-authority.json");
  const authority = Keypair.generate();
  writeKeypair(authorityPath, authority);
  const rpcPort = await rpcPortPair();
  let faucetPort = await bindablePort();
  while (faucetPort === rpcPort || faucetPort === rpcPort + 1) {
    faucetPort = await bindablePort();
  }
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  let stdout = "";
  let stderr = "";
  const validator = spawn(
    validatorExecutable,
    [
      "--ledger",
      ledgerPath,
      "--reset",
      "--quiet",
      "--rpc-port",
      String(rpcPort),
      "--faucet-port",
      String(faucetPort),
      "--mint",
      authority.publicKey.toBase58(),
      "--upgradeable-program",
      FIGHT_PROGRAM_ID.toBase58(),
      fightBinary,
      authorityPath,
      "--upgradeable-program",
      MARKET_PROGRAM_ID.toBase58(),
      marketBinary,
      authorityPath,
    ],
    { cwd: anchorRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  validator.stdout?.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  validator.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  let validatorSpawnFailure: Error | null = null;
  validator.once("error", (error) => {
    validatorSpawnFailure = error;
  });
  let dbModule: typeof import("../src/db") | null = null;
  try {
    const connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      wsEndpoint: `ws://127.0.0.1:${rpcPort + 1}`,
    });
    await waitForRpc(
      rpcUrl,
      connection,
      validator,
      () => validatorSpawnFailure,
    );
    const provider = new AnchorProvider(connection, new Wallet(authority), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const fightIdl = JSON.parse(readFileSync(fightIdlPath, "utf8")) as Idl;
    const marketIdl = JSON.parse(readFileSync(marketIdlPath, "utf8")) as Idl;
    const fightProgram = new Program<FightOracle>(
      fightIdl as FightOracle,
      provider,
    );
    const marketProgram = new Program<DuelMarket>(
      marketIdl as DuelMarket,
      provider,
    );
    if (
      !fightProgram.programId.equals(FIGHT_PROGRAM_ID) ||
      !marketProgram.programId.equals(MARKET_PROGRAM_ID)
    ) {
      throw new Error("pinned IDL program identity drifted");
    }
    const reporter = Keypair.generate();
    const finalizer = Keypair.generate();
    const challenger = Keypair.generate();
    const marketOperator = Keypair.generate();
    const treasury = Keypair.generate();
    const marketMaker = Keypair.generate();
    const user = Keypair.generate();
    await Promise.all(
      [
        authority.publicKey,
        reporter.publicKey,
        finalizer.publicKey,
        challenger.publicKey,
        marketOperator.publicKey,
        user.publicKey,
      ].map((recipient) => airdrop(connection, recipient, 5)),
    );
    await initializeOracle({
      program: fightProgram,
      authority,
      reporter: reporter.publicKey,
      finalizer: finalizer.publicKey,
      challenger: challenger.publicKey,
    });
    const marketConfig = await initializeMarketConfig({
      program: marketProgram,
      authority,
      marketOperator: marketOperator.publicKey,
      treasury: treasury.publicKey,
      marketMaker: marketMaker.publicKey,
    });

    const duelId = "owned-local-finalized-recovery-duel";
    const duelKey = Array.from(createHash("sha256").update(duelId).digest());
    const snapshotDigest = Array.from(
      createHash("sha256").update("owned-local-competitive-snapshot").digest(),
    );
    const participantAId = "owned-local-agent-a";
    const participantBId = "owned-local-agent-b";
    const now = Math.floor(Date.now() / 1_000);
    const duelState = await initializeOpenDuel({
      program: fightProgram,
      reporter,
      duelKey,
      participantAHash: Array.from(
        createHash("sha256").update(participantAId).digest(),
      ),
      participantBHash: Array.from(
        createHash("sha256").update(participantBId).digest(),
      ),
      snapshotDigest,
      now,
    });
    const { marketState, vault } = await initializeMarket({
      program: marketProgram,
      operator: marketOperator,
      config: marketConfig,
      duelState,
      duelKey,
    });
    await ensureVaultRentExempt({ provider, funder: authority, vault });
    const placed = await placeRestingOrder({
      program: marketProgram,
      marketState,
      duelState,
      config: marketConfig,
      treasury: treasury.publicKey,
      marketMaker: marketMaker.publicKey,
      vault,
      user,
    });
    await waitForFinalized(connection, placed.signature);
    const parsed = await connection.getParsedTransaction(placed.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed || !parsed.meta || parsed.meta.err) {
      throw new Error("owned-local placement finalized transaction is absent");
    }

    process.env.KEEPER_DB_PATH = databasePath;
    const loadedDb = await import(`../src/db.ts?qualification=${randomUUID()}`);
    dbModule = loadedDb;
    const terminalLedger = new TerminalLedger(databasePath);
    terminalLedger.close();
    const betId = "owned-local-bet-1";
    const recordedAt = Date.now();
    if (
      !loadedDb.saveBet(
        {
          id: betId,
          cluster: "devnet",
          programId: marketProgram.programId.toBase58(),
          bettorWallet: user.publicKey.toBase58(),
          chain: "SOLANA",
          sourceAsset: "SOL",
          sourceAmountLamports: "500",
          feeAmountLamports: "0",
          feeBps: 0,
          txSignature: placed.signature,
          marketPda: marketState.toBase58(),
          duelKey: Buffer.from(duelKey).toString("hex"),
          duelId,
          inviteCode: null,
          externalBetRef: `owned-local:${placed.signature}`,
          recordedAt,
        },
        {
          orderId: "1",
          side: 1,
          limitPrice: 500,
          orderBehavior: 0,
          orderAmountUnits: "1000",
          matchedAmountUnits: "0",
          restingAmountUnits: "1000",
          releasedAmountUnits: "0",
          collateralLamports: "500",
          executedCostLamports: "0",
          tradeTreasuryFeeLamports: "0",
          tradeMarketMakerFeeLamports: "0",
          rewardEligibleLamports: "0",
          verifiedAt: recordedAt,
        },
      )
    ) {
      throw new Error("owned-local bet fixture was not inserted exactly once");
    }
    const startSlot = parsed.slot;
    loadedDb.commitSolanaIndexedTransaction({
      cluster: "devnet",
      programId: MARKET_PROGRAM_ID.toBase58(),
      startSlot,
      signature: placed.signature,
      slot: parsed.slot,
      blockTime: parsed.blockTime ?? null,
      succeeded: true,
      instructionNames: ["placeOrder"],
      transactionDigest: digestParsedTransaction(
        parsed as ParsedTransactionWithMeta,
      ),
      facts: [
        {
          kind: "ORDER_PLACED",
          marketPda: marketState.toBase58(),
          orderId: "1",
          wallet: user.publicKey.toBase58(),
          side: 1,
          price: 500,
          orderBehavior: 0,
          amountUnits: "1000",
        },
      ],
      indexedAt: recordedAt,
    });
    const lifecycle = loadedDb.reconcileSolanaBetLifecycleAccounting({
      cluster: "devnet",
      programId: MARKET_PROGRAM_ID.toBase58(),
      throughSlot: parsed.slot,
      throughSignature: placed.signature,
      reconciledAt: recordedAt,
    });
    if (
      lifecycle.reconciledBets !== 1 ||
      lifecycle.pendingBets !== 0 ||
      lifecycle.changes.length !== 0
    ) {
      throw new Error("owned-local lifecycle reconciliation was not exact");
    }

    const genesisHash = await connection.getGenesisHash();
    const expectation = {
      cluster: "devnet" as const,
      genesisHash,
      fightOracleProgramId: FIGHT_PROGRAM_ID.toBase58(),
      duelMarketProgramId: MARKET_PROGRAM_ID.toBase58(),
      expectedUpgradeAuthority: authority.publicKey.toBase58(),
      configAuthority: authority.publicKey.toBase58(),
      reporter: reporter.publicKey.toBase58(),
      finalizer: finalizer.publicKey.toBase58(),
      challenger: challenger.publicKey.toBase58(),
      marketOperator: marketOperator.publicKey.toBase58(),
      treasury: treasury.publicKey.toBase58(),
      marketMaker: marketMaker.publicKey.toBase58(),
      disputeWindowSecs: 60,
      tradeTreasuryFeeBps: 100,
      tradeMarketMakerFeeBps: 100,
      winningsMarketMakerFeeBps: 100,
      oraclePaused: false,
      orderPlacementPaused: false,
      marketCreationPaused: false,
    };
    const result = await collectAndVerifyFinalizedSolanaRecovery({
      connection,
      databasePath,
      expectation,
      restoredReconciliationId: "33333333-3333-4333-8333-333333333333",
      restoredReconciliationSha256: sha256(
        "owned-local-restored-reconciliation",
      ),
      restoredReconciledStateSha256: sha256("owned-local-restored-state"),
      materializationId: "44444444-4444-4444-8444-444444444444",
      duels: [
        {
          duelId,
          duelKey: Buffer.from(duelKey).toString("hex"),
          participantAId,
          participantBId,
          competitiveSnapshotVersion: 3,
          competitiveSnapshotDigest:
            Buffer.from(snapshotDigest).toString("hex"),
          terminalOutcome: null,
          terminalWinnerSide: null,
          terminalSeed: null,
          terminalReplayHash: null,
        },
      ],
    });
    const artifact = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      qualificationId: randomUUID(),
      qualificationScope:
        "owned_local_validator_current_sbf_finalized_post_restore_reconciliation",
      repositoryReleaseSha: Bun.spawnSync({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
        .stdout.toString()
        .trim(),
      runtime: {
        bun: Bun.version,
        validator: Bun.spawnSync({
          cmd: [validatorExecutable, "--version"],
          stdout: "pipe",
          stderr: "pipe",
        })
          .stdout.toString()
          .trim(),
      },
      programs: {
        fightOracle: {
          programId: FIGHT_PROGRAM_ID.toBase58(),
          binarySha256: sha256File(fightBinary),
        },
        duelMarket: {
          programId: MARKET_PROGRAM_ID.toBase58(),
          binarySha256: sha256File(marketBinary),
        },
      },
      restoredDatabase: {
        schemaSha256: result.restored.databaseAfter.schemaSha256,
        logicalDataSha256: result.restored.databaseAfter.logicalDataSha256,
        tableCounts: result.restored.databaseAfter.tableCounts,
        unchangedAcrossDoubleFinalizedRead:
          canonicalEvidenceJson(result.restored.databaseBefore) ===
          canonicalEvidenceJson(result.restored.databaseAfter),
      },
      finalizedChain: {
        genesisHash: result.chain.genesisHash,
        finalizedStartSlot: result.chain.finalizedStartSlot,
        finalizedEndSlot: result.chain.finalizedEndSlot,
        minimumAvailableSlot: result.chain.minimumAvailableSlot,
        transactionCount: result.chain.transactions.length,
        duelCount: result.chain.duels.length,
        marketCount: result.chain.markets.length,
        orderCount: result.chain.orders.length,
        balanceCount: result.chain.balances.length,
        custodyCount: result.chain.custody.length,
      },
      reconciliation: result.reconciliation,
      actualProductionCollectorUsed: true,
      currentSbfProgramsUsed: true,
      ownedLocalValidatorOnly: true,
      externalNetworkUsed: false,
      realValueUsed: false,
      databaseMutationAuthorizedDuringVerification: false,
      chainMutationAuthorizedDuringVerification: false,
      activationRequiresSeparateApproval: true,
      productionCutoverAuthorized: false,
    };
    if (outputPath) writeEvidence(outputPath, artifact);
    console.log(JSON.stringify(artifact));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "unknown qualification failure"}\nvalidator stdout:\n${stdout}\nvalidator stderr:\n${stderr}`,
    );
  } finally {
    dbModule?.closeDb();
    const validatorExitCode = await stopValidator(validator);
    if (validatorExitCode !== 0 && validatorExitCode !== null) {
      stderr = appendBounded(
        stderr,
        Buffer.from(`\nvalidator exit code: ${validatorExitCode}\n`),
      );
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
