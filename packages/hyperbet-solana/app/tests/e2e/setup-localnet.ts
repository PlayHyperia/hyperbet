import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  ConfirmOptions,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  Connection,
} from "@solana/web3.js";

import fightOracleIdl from "../../../anchor/target/idl/fight_oracle.json";
import duelMarketIdl from "../../../anchor/target/idl/duel_market.json";
import {
  createOpenMarketFixture,
  deriveOracleConfigPda,
  deriveUserBalancePda,
  uniqueDuelKey,
} from "../../../anchor/tests/clob-test-helpers";
import {
  normalizeBettingFeedCycle,
  type StreamingCycle,
} from "../../../keeper/src/game-client";
import { buildDuelLifecycleMetadata } from "../../../keeper/src/duelTerminalPolicy";
import { resolveLocalnetDuelTiming } from "./localnetDuelTiming";
import {
  buildSyntheticDuelCommitment,
  E2E_AGENT_A_IDENTITY,
  E2E_AGENT_B_IDENTITY,
  E2E_INITIAL_CYCLE_ID,
  syntheticParticipantHash,
} from "./syntheticDuelFixture";

type SignableTx = Transaction | VersionedTransaction;
type AnchorLikeWallet = Wallet & { payer: Keypair };
type IdlWithAddress = Idl & {
  address?: string;
  metadata?: {
    address?: string;
  };
};

function resolveIdlAddress(idl: IdlWithAddress, label: string): string {
  const address = idl.address || idl.metadata?.address || "";
  if (!address) {
    throw new Error(`Missing program address in ${label} IDL`);
  }
  return address;
}

const E2E_TRADER_SEED = Uint8Array.from([
  88, 41, 190, 12, 77, 164, 231, 5, 199, 118, 43, 91, 16, 220, 58, 147, 9, 175,
  63, 204, 132, 54, 241, 28, 115, 67, 154, 210, 36, 143, 80, 11,
]);

async function loadBootstrapAuthority(): Promise<{
  keypair: Keypair;
  keypairPath: string;
}> {
  const candidates = [
    process.env.E2E_SOLANA_BOOTSTRAP_KEYPAIR,
    path.join(
      process.env.HOME ?? "",
      ".config/solana/hyperia-keys/deployer.json",
    ),
    path.join(process.env.HOME ?? "", ".config/solana/id.json"),
  ].filter((value): value is string => Boolean(value?.trim()));

  let keypairPath: string | null = null;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      keypairPath = candidate;
      break;
    } catch {
      // Try the next configured wallet path.
    }
  }

  if (!keypairPath) {
    throw new Error(
      `Could not find a bootstrap Solana keypair. Checked: ${candidates.join(", ")}`,
    );
  }

  const secret = JSON.parse(await fs.readFile(keypairPath, "utf8")) as number[];
  return {
    keypair: Keypair.fromSecretKey(Uint8Array.from(secret)),
    keypairPath,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function realHyperiaMinimumOpenWindowMs(): number {
  const raw =
    process.env.E2E_REAL_HYPERIA_MIN_OPEN_WINDOW_MS?.trim() || "600000";
  const value = Number.parseInt(raw, 10);
  if (
    !/^[1-9][0-9]*$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 60_000
  ) {
    throw new Error(
      "E2E_REAL_HYPERIA_MIN_OPEN_WINDOW_MS must be an integer >= 60000",
    );
  }
  return value;
}

async function getChainUnixTimestamp(
  connection: Connection,
  fallbackUnixSeconds: number,
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const slot = await connection.getSlot("confirmed");
      const blockTime = await connection.getBlockTime(slot);
      if (
        typeof blockTime === "number" &&
        Number.isFinite(blockTime) &&
        blockTime > 0
      ) {
        return blockTime;
      }
    } catch {
      // Fall through to the retry sleep and use the host clock as a last resort.
    }
    await sleep(500);
  }
  return fallbackUnixSeconds;
}

function toWallet(keypair: Keypair): AnchorLikeWallet {
  const sign = <T extends SignableTx>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([keypair]);
    else tx.partialSign(keypair);
    return tx;
  };

  return {
    payer: keypair,
    publicKey: keypair.publicKey,
    signTransaction: async <T extends SignableTx>(tx: T): Promise<T> =>
      sign(tx),
    signAllTransactions: async <T extends SignableTx[]>(txs: T): Promise<T> => {
      txs.forEach((tx) => sign(tx));
      return txs;
    },
  };
}

async function airdrop(
  connection: Connection,
  recipient: PublicKey,
  lamports: number,
): Promise<void> {
  let lastError: unknown = new Error("Airdrop did not settle");
  const initialBalance = await connection.getBalance(recipient, "confirmed");
  const expectedFloor = initialBalance + lamports;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const signature = await connection.requestAirdrop(recipient, lamports);

      const startedAt = Date.now();
      while (Date.now() - startedAt < 20_000) {
        const balance = await connection.getBalance(recipient, "confirmed");
        if (balance >= expectedFloor) return;

        const statuses = await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = statuses.value[0];
        if (status?.err) {
          throw new Error(
            `Airdrop failed for signature ${signature}: ${JSON.stringify(status.err)}`,
          );
        }
        await sleep(600);
      }

      throw new Error(`Airdrop signature ${signature} did not settle in time`);
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function ensureBalance(
  connection: Connection,
  recipient: PublicKey,
  minimumLamports: number,
): Promise<void> {
  let balance = await connection.getBalance(recipient, "confirmed");
  while (balance < minimumLamports) {
    const missingLamports = minimumLamports - balance;
    await airdrop(
      connection,
      recipient,
      Math.min(missingLamports, 10 * LAMPORTS_PER_SOL),
    );
    balance = await connection.getBalance(recipient, "confirmed");
  }
}

async function ensureTransferredBalance(
  connection: Connection,
  provider: AnchorProvider,
  recipient: PublicKey,
  minimumLamports: number,
): Promise<void> {
  const balance = await connection.getBalance(recipient, "confirmed");
  if (balance >= minimumLamports) return;

  const transferLamports = minimumLamports - balance;
  const transferTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: recipient,
      lamports: transferLamports,
    }),
  );
  await provider.sendAndConfirm(transferTx);
}

async function waitForSignatureConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs = 120_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = statuses.value[0];
      if (status?.err) {
        throw new Error(
          `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return;
      }
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
    }
    await sleep(500);
  }
  throw new Error(
    `Transaction ${signature} was not confirmed within ${timeoutMs}ms`,
  );
}

async function reliableSendAndConfirm(
  provider: AnchorProvider,
  connection: Connection,
  tx: SignableTx,
  signers?: Signer[],
  opts?: ConfirmOptions,
): Promise<string> {
  const resolvedOpts = opts ?? provider.opts;
  const preflightCommitment =
    resolvedOpts.preflightCommitment ?? resolvedOpts.commitment ?? "confirmed";

  if (tx instanceof VersionedTransaction) {
    if (signers && signers.length > 0) {
      tx.sign(signers);
    }
  } else {
    tx.feePayer = tx.feePayer ?? provider.wallet.publicKey;
    const latestBlockhash =
      await connection.getLatestBlockhash(preflightCommitment);
    tx.recentBlockhash = latestBlockhash.blockhash;
    if (signers && signers.length > 0) {
      for (const signer of signers) {
        tx.partialSign(signer);
      }
    }
  }

  const signedTx = await provider.wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: resolvedOpts.skipPreflight,
    maxRetries: resolvedOpts.maxRetries,
    preflightCommitment,
  });
  await waitForSignatureConfirmation(connection, signature);
  return signature;
}

function attachReliableSendAndConfirm(
  provider: AnchorProvider,
  connection: Connection,
): void {
  provider.sendAndConfirm = (async (tx, signers, opts) => {
    return reliableSendAndConfirm(provider, connection, tx, signers, opts);
  }) as AnchorProvider["sendAndConfirm"];
}

function participantHash(agent: StreamingCycle["agent1"]): number[] {
  const identity = agent?.id?.trim() || agent?.name?.trim() || "unknown";
  return Array.from(createHash("sha256").update(identity).digest());
}

async function loadRealHyperiaCycle(): Promise<StreamingCycle> {
  const sourceUrl = process.env.E2E_HYPERIA_BET_SYNC_STATE_URL?.trim() || "";
  const bearerToken =
    process.env.E2E_HYPERIA_BET_SYNC_BEARER_TOKEN?.trim() || "";
  if (!sourceUrl) {
    throw new Error(
      "E2E_HYPERIA_BET_SYNC_STATE_URL is required for real_hyperia mode",
    );
  }
  if (!bearerToken) {
    throw new Error(
      "E2E_HYPERIA_BET_SYNC_BEARER_TOKEN is required for real_hyperia mode",
    );
  }
  const minimumOpenWindowMs = realHyperiaMinimumOpenWindowMs();

  const deadline = Date.now() + 120_000;
  let lastFailure = "source did not return a cycle";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(sourceUrl, {
        cache: "no-store",
        headers: { authorization: `Bearer ${bearerToken}` },
      });
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const normalized = normalizeBettingFeedCycle(await response.json());
        if (!normalized) {
          lastFailure = "invalid schema-v3 betting frame";
        } else if (normalized.phase !== "ANNOUNCEMENT") {
          lastFailure = `phase ${normalized.phase}`;
        } else if (
          normalized.competitiveSnapshot?.persisted !== true ||
          normalized.competitiveSnapshot.diagnostic !== false
        ) {
          lastFailure =
            "competitive snapshot is not persisted production truth";
        } else if (
          normalized.betCloseTime === null ||
          normalized.betCloseTime - Date.now() < minimumOpenWindowMs
        ) {
          lastFailure = `betting window has less than ${minimumOpenWindowMs} ms remaining`;
        } else {
          return normalized;
        }
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Real Hyperia cycle did not become ready: ${lastFailure}`);
}

async function main(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const appDir = path.resolve(__dirname, "../..");
  const statePath = path.resolve(__dirname, "./state.json");
  const envPath = path.resolve(appDir, ".env.e2e");
  const solanaRpcUrl =
    process.env.E2E_SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const solanaWsUrl = process.env.E2E_SOLANA_WS_URL || "ws://127.0.0.1:8900";
  const browserSolanaRpcUrl =
    process.env.E2E_BROWSER_SOLANA_RPC_URL || solanaRpcUrl;
  const browserSolanaWsUrl =
    process.env.E2E_BROWSER_SOLANA_WS_URL || solanaWsUrl;
  const clobProgramId = resolveIdlAddress(
    duelMarketIdl as unknown as IdlWithAddress,
    "duel_market",
  );
  const connection = new Connection(solanaRpcUrl, {
    commitment: "confirmed",
    wsEndpoint: solanaWsUrl,
    confirmTransactionInitialTimeout: 120_000,
  });
  const bootstrapAuthority = await loadBootstrapAuthority();
  const authority = bootstrapAuthority.keypair;
  const trader = Keypair.fromSeed(E2E_TRADER_SEED);
  const provider = new AnchorProvider(connection, toWallet(authority), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  attachReliableSendAndConfirm(provider, connection);

  const fightProgram = new Program(fightOracleIdl as Idl, provider);
  const clobProgram = new Program(duelMarketIdl as Idl, provider);

  await ensureBalance(connection, authority.publicKey, 30 * LAMPORTS_PER_SOL);
  await ensureTransferredBalance(
    connection,
    provider,
    trader.publicKey,
    10 * LAMPORTS_PER_SOL,
  );

  const hostNow = Math.floor(Date.now() / 1000);
  const now = await getChainUnixTimestamp(connection, hostNow);
  const duelSource =
    process.env.E2E_DUEL_SOURCE?.trim().toLowerCase() || "synthetic_publish";
  if (duelSource !== "synthetic_publish" && duelSource !== "real_hyperia") {
    throw new Error(`Unsupported E2E_DUEL_SOURCE: ${duelSource}`);
  }
  const realCycle =
    duelSource === "real_hyperia" ? await loadRealHyperiaCycle() : null;
  const currentDuelId =
    realCycle?.duelId ?? String(Math.max(Date.now(), now * 1000));
  const parsedMatchId = Number.parseInt(currentDuelId || "", 10);
  const currentMatchId = Number.isSafeInteger(parsedMatchId)
    ? parsedMatchId
    : Math.max(Date.now(), now * 1000);
  const currentDuelKey = realCycle?.duelKeyHex
    ? Array.from(Buffer.from(realCycle.duelKeyHex, "hex"))
    : uniqueDuelKey(
        `e2e-current-duel:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      );
  const currentDuelKeyHex = Buffer.from(currentDuelKey).toString("hex");
  const { betOpenTs, betCloseTs, duelStartTs } = resolveLocalnetDuelTiming(
    now,
    realCycle,
  );
  const syntheticCommitment = realCycle
    ? null
    : buildSyntheticDuelCommitment({
        cycleId: E2E_INITIAL_CYCLE_ID,
        duelId: currentDuelId,
        duelKeyHex: currentDuelKeyHex,
        betOpenTs,
        betCloseTs,
        duelStartTs,
      });
  const competitiveSnapshotVersion =
    realCycle?.competitiveSnapshotVersion ??
    syntheticCommitment?.competitiveSnapshotVersion;
  const competitiveSnapshotDigest =
    realCycle?.competitiveSnapshotDigest ??
    syntheticCommitment?.competitiveSnapshotDigest;
  if (
    !Number.isSafeInteger(competitiveSnapshotVersion) ||
    Number(competitiveSnapshotVersion) <= 0 ||
    !competitiveSnapshotDigest ||
    !/^[0-9a-f]{64}$/.test(competitiveSnapshotDigest)
  ) {
    throw new Error("Prepared duel is missing a canonical snapshot commitment");
  }
  const currentDuelMetadata = buildDuelLifecycleMetadata({
    duelId: currentDuelId,
    duelKey: currentDuelKeyHex,
    snapshotVersion: Number(competitiveSnapshotVersion),
    snapshotDigest: competitiveSnapshotDigest,
  });
  const currentMarket = await createOpenMarketFixture(
    fightProgram as never,
    clobProgram as never,
    authority,
    {
      duelKey: currentDuelKey,
      betOpenTs,
      // Use validator time, not host wall clock, or the local chain can reject
      // orders as already closed while the UI still thinks the market is open.
      betCloseTs,
      duelStartTs,
      participantAHash: realCycle
        ? participantHash(realCycle.agent1)
        : (syntheticCommitment?.participantAHash ??
          syntheticParticipantHash(E2E_AGENT_A_IDENTITY.id)),
      participantBHash: realCycle
        ? participantHash(realCycle.agent2)
        : (syntheticCommitment?.participantBHash ??
          syntheticParticipantHash(E2E_AGENT_B_IDENTITY.id)),
      competitiveSnapshotVersion: Number(competitiveSnapshotVersion),
      competitiveSnapshotDigest: Array.from(
        Buffer.from(competitiveSnapshotDigest, "hex"),
      ),
      metadataUri: currentDuelMetadata,
    },
  );

  const oracleConfigPda = deriveOracleConfigPda(fightProgram.programId);
  const oracleConfig =
    await fightProgram.account.oracleConfig.fetch(oracleConfigPda);
  if (!oracleConfig.configFrozen) {
    await fightProgram.methods
      .freezeOracleConfig()
      .accountsPartial({
        authority: authority.publicKey,
        oracleConfig: oracleConfigPda,
      })
      .signers([authority])
      .rpc();
  }

  const marketConfig = await clobProgram.account.marketConfig.fetch(
    currentMarket.config,
  );
  if (!marketConfig.configFrozen) {
    await clobProgram.methods
      .freezeConfig()
      .accountsPartial({
        authority: authority.publicKey,
        config: currentMarket.config,
      })
      .signers([authority])
      .rpc();
  }

  const [frozenOracleConfig, frozenMarketConfig] = await Promise.all([
    fightProgram.account.oracleConfig.fetch(oracleConfigPda),
    clobProgram.account.marketConfig.fetch(currentMarket.config),
  ]);
  if (!frozenOracleConfig.configFrozen || !frozenMarketConfig.configFrozen) {
    throw new Error(
      "Local Solana launch configuration did not converge to permanent freeze",
    );
  }

  const clobUserBalancePda = deriveUserBalancePda(
    clobProgram.programId,
    currentMarket.marketState,
    trader.publicKey,
  );

  const envBody = [
    "VITE_SOLANA_CLUSTER=localnet",
    "VITE_TRANSACTIONS_ENABLED=true",
    `VITE_SOLANA_RPC_URL=${browserSolanaRpcUrl}`,
    `VITE_SOLANA_WS_URL=${browserSolanaWsUrl}`,
    "VITE_USE_LOCAL_SOLANA_RPC_PROXY=true",
    `VITE_FIGHT_ORACLE_PROGRAM_ID=${fightProgram.programId.toBase58()}`,
    `VITE_DUEL_MARKET_PROGRAM_ID=${clobProgramId}`,
    `VITE_ACTIVE_MATCH_ID=${currentMatchId}`,
    "VITE_BET_WINDOW_SECONDS=300",
    "VITE_NEW_ROUND_BET_WINDOW_SECONDS=300",
    "VITE_AUTO_SEED_DELAY_SECONDS=10",
    "VITE_BET_FEE_BPS=200",
    "VITE_REFRESH_INTERVAL_MS=1500",
    "VITE_ENABLE_AUTO_SEED=false",
    "VITE_E2E_FORCE_WINNER=YES",
    `VITE_BINARY_MARKET_MAKER_WALLET=${authority.publicKey.toBase58()}`,
    `VITE_BINARY_TRADE_TREASURY_WALLET=${authority.publicKey.toBase58()}`,
    `VITE_BINARY_TRADE_MARKET_MAKER_WALLET=${authority.publicKey.toBase58()}`,
    `VITE_HEADLESS_WALLET_SECRET_KEY=${Array.from(trader.secretKey).join(",")}`,
    "VITE_HEADLESS_WALLET_NAME=E2E Trader",
    "VITE_HEADLESS_WALLET_AUTO_CONNECT=true",
  ].join("\n");

  await fs.writeFile(envPath, `${envBody}\n`, "utf8");
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        mode: "localnet",
        cluster: "localnet",
        solanaRpcUrl,
        authority: authority.publicKey.toBase58(),
        bootstrapWalletPath: bootstrapAuthority.keypairPath,
        solanaTraderPublicKey: trader.publicKey.toBase58(),
        currentMatchId,
        currentDuelId,
        currentDuelKeyHex,
        currentBetOpenTimeMs: betOpenTs * 1_000,
        currentBetCloseTimeMs: betCloseTs * 1_000,
        currentFightStartTimeMs: duelStartTs * 1_000,
        currentPhase: realCycle?.phase ?? "ANNOUNCEMENT",
        currentDuelSource: duelSource,
        clobConfig: currentMarket.config.toBase58(),
        clobMarketState: currentMarket.marketState.toBase58(),
        clobDuelState: currentMarket.duelState.toBase58(),
        clobTreasury: currentMarket.treasury.toBase58(),
        clobMarketMaker: currentMarket.marketMaker.toBase58(),
        clobVault: currentMarket.vault.toBase58(),
        clobUserBalance: clobUserBalancePda.toBase58(),
        expectedSeedSuccess: true,
        canStartNewRound: true,
        placeBetPayAsset: "SOL",
        placeBetAmount: "1",
        placeBetSide: "YES",
        currentBetWindowSeconds: betCloseTs - betOpenTs,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        envPath,
        statePath,
        authority: authority.publicKey.toBase58(),
        trader: trader.publicKey.toBase58(),
        browserSolanaRpcUrl,
        browserSolanaWsUrl,
        currentMatchId,
        currentDuelKeyHex,
        clobMarketState: currentMarket.marketState.toBase58(),
        clobUserBalance: clobUserBalancePda.toBase58(),
      },
      null,
      2,
    ),
  );
}

void main();
