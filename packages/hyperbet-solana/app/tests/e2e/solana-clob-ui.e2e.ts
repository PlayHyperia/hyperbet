import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import BN from "bn.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request as BrowserRequest,
  type Route,
} from "@playwright/test";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  ORDER_BEHAVIOR_GTC,
  SIDE_ASK,
  currentChainUnixTimestamp,
  deriveClobVaultPda,
  deriveDuelStatePda,
  deriveMarketStatePda,
  deriveOrderPda,
  derivePriceLevelPda,
  deriveUserBalancePda,
  duelStatusBettingOpen,
  ensureOracleReady,
  initializeCanonicalMarket,
  syncMarketFromDuel,
  uniqueDuelKey,
  upsertDuel,
} from "../../../anchor/tests/clob-test-helpers";
import { createPollingProvider } from "../../../anchor/tests/test-anchor";
import type { DuelMarket } from "../../../anchor/target/types/duel_market";
import type { FightOracle } from "../../../anchor/target/types/fight_oracle";
import {
  buildSyntheticDuelCommitment,
  buildSyntheticPublicAgent,
  buildSyntheticRendererHealth,
} from "./syntheticDuelFixture";
import {
  assertWagerAuthorityTrackingEvidence,
  CAPTURE_WAGER_AUTHORITY_BOUNDARIES,
  WAGER_AUTHORITY_BOUNDARIES,
  captureWagerAuthorityTestTitle,
  wagerAuthorityTestTitle,
  isCaptureViewerAuthorityRevoked,
} from "./wagerAuthorityEvidence";
import { buildWagerAuthorityFixtureUpdate } from "./wagerAuthorityFixture";
import {
  assertCaptureFaultEvidence,
  assertCaptureRecovery,
  killOwnedCaptureWorker,
  readOwnedCaptureSnapshot,
  type CaptureHarnessControl,
  type CaptureRuntimeSnapshot,
} from "./wagerAuthorityCapture";

type E2eState = {
  solanaRpcUrl?: string;
  solanaWsUrl?: string;
  placeBetAmount?: string;
  bootstrapWalletPath?: string;
  clobConfig?: string;
  clobTreasury?: string;
  clobMarketMaker?: string;
  clobDuelState?: string;
  clobMarketState?: string;
  currentDuelId?: string;
  currentDuelKeyHex?: string;
  currentBetOpenTimeMs?: number;
  currentBetCloseTimeMs?: number;
  currentFightStartTimeMs?: number;
  currentDuelSource?: "synthetic_publish" | "real_hyperia";
  solanaTraderPublicKey?: string;
};

type HarnessControl = {
  controlPath: string;
  services: { hyperia?: CaptureHarnessControl };
};

type UserBalanceAccount = {
  aShares?: unknown;
  bShares?: unknown;
};

type MarketStateAccount = {
  nextOrderId?: unknown;
  bestAsk?: unknown;
};

type PriceLevelAccount = {
  totalOpen?: unknown;
};

type AccountNamespaceFetcher = {
  fetch: (pubkey: PublicKey) => Promise<Record<string, unknown>>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const processControlScriptPath = path.resolve(
  __dirname,
  "../../../../../scripts/e2e-process-control.sh",
);
const controlPath = path.resolve(__dirname, "./control.json");
const anchorIdlDir = path.resolve(__dirname, "../../../anchor/target/idl");
const duelMarketIdl = JSON.parse(
  fs.readFileSync(path.join(anchorIdlDir, "duel_market.json"), "utf8"),
) as DuelMarket;
const fightOracleIdl = JSON.parse(
  fs.readFileSync(path.join(anchorIdlDir, "fight_oracle.json"), "utf8"),
) as FightOracle;
const GAME_API_URL = (process.env.E2E_GAME_API_URL || "http://127.0.0.1:5555")
  .trim()
  .replace(/\/$/, "");
const E2E_ARENA_WRITE_KEY =
  process.env.E2E_ARENA_WRITE_KEY?.trim() ||
  process.env.ARENA_EXTERNAL_BET_WRITE_KEY?.trim() ||
  process.env.VITE_ARENA_WRITE_KEY?.trim() ||
  "";
const E2E_DUEL_SOURCE =
  process.env.E2E_DUEL_SOURCE?.trim().toLowerCase() || "synthetic_publish";
const PREPARED_LIVE_DUEL_MIN_OPEN_WINDOW_MS = 60_000;
const SEEDED_ASK_LIQUIDITY_LAMPORTS = "100000000";
const MIN_ASK_LIQUIDITY_MAKER_LAMPORTS = 100_000_000n;
const MIN_BOOTSTRAP_AUTHORITY_LAMPORTS = 50_000_000n;
const SOLANA_LAMPORT_TOP_UP_CUSHION = 5_000_000n;
const ASK_LIQUIDITY_MAKER_SEED = Uint8Array.from([
  14, 22, 189, 71, 203, 44, 97, 156, 18, 240, 85, 132, 53, 199, 4, 220, 91, 11,
  144, 201, 32, 77, 165, 118, 246, 17, 63, 154, 208, 39, 121, 6,
]);

async function loadState(): Promise<E2eState> {
  const statePath = path.resolve(__dirname, "./state.json");
  const raw = await fsp.readFile(statePath, "utf8");
  return JSON.parse(raw) as E2eState;
}

async function loadControl(): Promise<HarnessControl> {
  const raw = await fsp.readFile(controlPath, "utf8");
  return JSON.parse(raw) as HarnessControl;
}

function runProcessControl(
  control: HarnessControl,
  action: "restart",
  service: "hyperia" | "hyperiaClient",
): void {
  execFileSync(
    "bash",
    [processControlScriptPath, action, control.controlPath, service],
    {
      stdio: "inherit",
    },
  );
}

function bnLikeToBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  return 0n;
}

type SignableTx = Transaction | VersionedTransaction;
type AnchorLikeWallet = Wallet & { payer: Keypair };

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

async function readText(page: Page, testId: string): Promise<string> {
  const locator = page.getByTestId(testId).first();
  const count = await locator.count().catch(() => 0);
  if (count === 0) return "";
  return ((await locator.textContent().catch(() => "")) || "").trim();
}

async function confirmSolanaOrder(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /confirm sol order/i });
  const openConfirmation = async (): Promise<void> => {
    const submitButton = page.getByTestId("prediction-submit");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(submitButton).toBeEnabled({ timeout: 30_000 });
      await submitButton.click();
      if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
        return;
      }
      const status = await readText(page, "solana-clob-status");
      if (/Order failed:/i.test(status)) throw new Error(status);
    }
    throw new Error(
      "The actionable order control did not open its pre-signature review",
    );
  };
  await openConfirmation();
  await expect(dialog).toContainText("Maximum wallet funding required");
  let confirmButton = dialog.getByRole("button", {
    name: /confirm and sign/i,
  });
  if (!(await confirmButton.isEnabled().catch(() => false))) {
    await dialog.getByRole("button", { name: /back to edit/i }).click();
    await openConfirmation();
    confirmButton = dialog.getByRole("button", { name: /confirm and sign/i });
  }
  await expect(confirmButton).toBeEnabled({ timeout: 30_000 });
  await confirmButton.click();
  await expect(dialog).toHaveCount(0, { timeout: 45_000 });
}

async function submitSolanaOrderWithBoundedQuoteReview(
  page: Page,
): Promise<void> {
  const waitForSubmissionBoundary = async (): Promise<{
    error: string | null;
    signature: string | null;
  }> => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const currentStatus = await readText(page, "solana-clob-status");
      if (/Order failed:/i.test(currentStatus)) {
        return { error: currentStatus, signature: null };
      }
      const signature = await readText(
        page,
        "solana-order-transaction-signature",
      );
      if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
        return { error: null, signature };
      }
      await page.waitForTimeout(250);
    }
    throw new Error(
      "Timed out waiting for a signed order or pre-sign rejection",
    );
  };

  await confirmSolanaOrder(page);

  const firstAttempt = await waitForSubmissionBoundary();
  if (!firstAttempt.error) return;
  if (!/order book or fee terms changed/i.test(firstAttempt.error)) {
    throw new Error(firstAttempt.error);
  }

  const feedback = page.getByTestId("solana-order-transaction-feedback");
  await expect(feedback).toHaveAttribute("data-state", "error");
  await expect(
    feedback.getByTestId("solana-order-transaction-signature"),
    "a stale quote must be rejected before a transaction is signed or sent",
  ).toHaveCount(0);

  await feedback.getByRole("button", { name: /review latest quote/i }).click();
  await expect(feedback).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("prediction-submit")).toBeEnabled({
    timeout: 60_000,
  });
  await confirmSolanaOrder(page);

  const retryAttempt = await waitForSubmissionBoundary();
  if (retryAttempt.error) {
    throw new Error(retryAttempt.error);
  }
}

function loadKeypairFromPath(filepath: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(filepath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadBootstrapAuthority(state: E2eState): Keypair {
  const walletPath = state.bootstrapWalletPath?.trim() || "";
  if (!walletPath) throw new Error("Missing bootstrapWalletPath in e2e state");
  return loadKeypairFromPath(walletPath);
}

function seededAskLiquidityMaker(): Keypair {
  return Keypair.fromSeed(ASK_LIQUIDITY_MAKER_SEED);
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return httpUrl.replace(/^https:\/\//, "wss://");
  }
  if (httpUrl.startsWith("http://")) {
    return httpUrl.replace(/^http:\/\//, "ws://");
  }
  return httpUrl;
}

function resolveSolanaRpcWsUrl(rpcUrl: string, stateWsUrl?: string): string {
  return (
    stateWsUrl?.trim() ||
    process.env.SOLANA_ALCHEMY_WS_URL?.trim() ||
    process.env.ALCHEMY_SOLANA_WS_URL?.trim() ||
    process.env.SOLANA_RPC_WS_URL?.trim() ||
    process.env.SOLANA_WS_URL?.trim() ||
    process.env.ANCHOR_WS_URL?.trim() ||
    deriveWsUrl(rpcUrl)
  );
}

function createConfirmedConnection(
  rpcUrl: string,
  stateWsUrl?: string,
): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: resolveSolanaRpcWsUrl(rpcUrl, stateWsUrl),
  });
}

async function ensureBootstrapAuthorityLamportBuffer(
  connection: Connection,
  state: E2eState,
  minimumLamports = MIN_BOOTSTRAP_AUTHORITY_LAMPORTS,
): Promise<void> {
  const authority = loadBootstrapAuthority(state);
  const authorityBalance = BigInt(
    await connection.getBalance(authority.publicKey, "confirmed"),
  );
  if (authorityBalance >= minimumLamports) {
    return;
  }

  const candidateEntries: Array<{
    signer: Keypair;
    reserveLamports: bigint;
  }> = [];
  const canaryPath = process.env.SOLANA_CANARY_KEYPAIR?.trim() || "";
  if (canaryPath && canaryPath !== state.bootstrapWalletPath?.trim()) {
    candidateEntries.push({
      signer: loadKeypairFromPath(canaryPath),
      reserveLamports: 250_000_000n,
    });
  }
  candidateEntries.push({
    signer: seededAskLiquidityMaker(),
    reserveLamports: 100_000_000n,
  });

  let currentBalance = authorityBalance;
  for (const candidate of candidateEntries) {
    if (currentBalance >= minimumLamports) {
      break;
    }
    if (candidate.signer.publicKey.equals(authority.publicKey)) {
      continue;
    }
    const candidateBalance = BigInt(
      await connection.getBalance(candidate.signer.publicKey, "confirmed"),
    );
    const transferableLamports =
      candidateBalance > candidate.reserveLamports
        ? candidateBalance - candidate.reserveLamports
        : 0n;
    if (transferableLamports <= 0n) {
      continue;
    }
    const requiredLamports = minimumLamports - currentBalance;
    const transferLamports =
      transferableLamports < requiredLamports
        ? transferableLamports
        : requiredLamports;
    const provider = createPollingProvider(
      connection,
      toWallet(candidate.signer),
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: candidate.signer.publicKey,
          toPubkey: authority.publicKey,
          lamports: Number(transferLamports),
        }),
      ),
      [],
    );
    currentBalance = BigInt(
      await connection.getBalance(authority.publicKey, "confirmed"),
    );
  }

  if (currentBalance < minimumLamports) {
    throw new Error(
      `Bootstrap authority underfunded: authority=${authority.publicKey.toBase58()} balance=${currentBalance.toString()} minimum=${minimumLamports.toString()}`,
    );
  }
}

async function seedAskLiquidity(
  connection: Connection,
  state: E2eState,
  market?: {
    marketState: PublicKey;
    duelState: PublicKey;
    vault: PublicKey;
  },
): Promise<void> {
  const maker = seededAskLiquidityMaker();
  const makerTargetLamports =
    MIN_ASK_LIQUIDITY_MAKER_LAMPORTS + SOLANA_LAMPORT_TOP_UP_CUSHION;
  const makerBalance = BigInt(
    await connection.getBalance(maker.publicKey, "confirmed"),
  );
  if (makerBalance < makerTargetLamports) {
    const authority = loadBootstrapAuthority(state);
    const fundAmount = makerTargetLamports - makerBalance;
    await ensureBootstrapAuthorityLamportBuffer(
      connection,
      state,
      MIN_BOOTSTRAP_AUTHORITY_LAMPORTS + fundAmount,
    );
    const authorityProvider = createPollingProvider(
      connection,
      toWallet(authority),
    );
    await authorityProvider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: maker.publicKey,
          lamports: Number(fundAmount),
        }),
      ),
      [],
    );
  }
  const provider = createPollingProvider(connection, toWallet(maker));
  const clobProgram = new Program<DuelMarket>(duelMarketIdl, provider);
  const marketState = market?.marketState ?? new PublicKey("");
  const duelState = market?.duelState ?? new PublicKey("");
  const vault =
    market?.vault ?? deriveClobVaultPda(clobProgram.programId, marketState);
  const clobAccounts = clobProgram.account as Record<
    string,
    AccountNamespaceFetcher
  >;
  const seedPrice = 500;
  const seedLevel = derivePriceLevelPda(
    clobProgram.programId,
    marketState,
    SIDE_ASK,
    seedPrice,
  );
  const hasExecutableSeedLiquidity = async (): Promise<boolean> => {
    const existingLevel = (await clobProgram.account.priceLevel.fetchNullable(
      seedLevel,
    )) as PriceLevelAccount | null;
    return bnLikeToBigInt(existingLevel?.totalOpen) > 0n;
  };

  // The live keeper can advance nextOrderId while this browser fixture is
  // preparing its independent, executable 500-per-mille ask. A different
  // best ask does not satisfy this test because the UI order may not cross it.
  // Retry only the bounded account-allocation race and verify the exact level.
  const maxPlacementAttempts = 8;
  for (let attempt = 0; attempt < maxPlacementAttempts; attempt += 1) {
    if (await hasExecutableSeedLiquidity()) return;

    const marketAccount = (await clobAccounts.marketState.fetch(
      marketState,
    )) as MarketStateAccount;
    const nextOrderId = bnLikeToBigInt(marketAccount.nextOrderId);
    if (nextOrderId <= 0n) {
      throw new Error("Missing next order id for seeded CLOB market");
    }

    try {
      await clobProgram.methods
        .placeOrder(
          new BN(nextOrderId.toString()),
          SIDE_ASK,
          seedPrice,
          new BN(SEEDED_ASK_LIQUIDITY_LAMPORTS),
          ORDER_BEHAVIOR_GTC,
        )
        .accountsPartial({
          marketState,
          duelState,
          userBalance: deriveUserBalancePda(
            clobProgram.programId,
            marketState,
            maker.publicKey,
          ),
          newOrder: deriveOrderPda(
            clobProgram.programId,
            marketState,
            nextOrderId,
          ),
          restingLevel: seedLevel,
          config: new PublicKey(state.clobConfig || ""),
          treasury: new PublicKey(state.clobTreasury || ""),
          marketMaker: new PublicKey(state.clobMarketMaker || ""),
          vault,
          user: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === maxPlacementAttempts - 1 ||
        !/already in use|custom program error: 0x0|"Custom":0/i.test(message)
      ) {
        throw error;
      }
      await sleepMs(250 * (attempt + 1));
      continue;
    }

    if (await hasExecutableSeedLiquidity()) return;
  }

  throw new Error("Failed to seed executable 500-per-mille ask liquidity");
}

async function loadMarketBalances(
  connection: Connection,
  state: E2eState,
  overrides?: {
    marketState?: PublicKey;
  },
): Promise<
  Array<{
    pubkey: string;
    user: string;
    aShares: string;
    bShares: string;
  }>
> {
  const walletPath = state.bootstrapWalletPath?.trim() || "";
  if (!walletPath) return [];
  const authority = loadBootstrapAuthority(state);
  const provider = new AnchorProvider(connection, toWallet(authority), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const clobProgram = new Program<DuelMarket>(duelMarketIdl, provider);
  const marketState = overrides?.marketState ?? new PublicKey("");
  const balances = await clobProgram.account.userBalance.all();
  return balances
    .filter((entry) => entry.account.marketState.equals(marketState))
    .map((entry) => ({
      pubkey: entry.publicKey.toBase58(),
      user: entry.account.user.toBase58(),
      aShares: bnLikeToBigInt(entry.account.aShares).toString(),
      bShares: bnLikeToBigInt(entry.account.bShares).toString(),
    }));
}

function createReadonlyClobProgram(
  connection: Connection,
  state: E2eState,
): Program<DuelMarket> {
  const authority = loadBootstrapAuthority(state);
  const provider = new AnchorProvider(connection, toWallet(authority), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new Program<DuelMarket>(duelMarketIdl, provider);
}

async function fetchJson<T>(
  request: APIRequestContext,
  pathname: string,
): Promise<T> {
  const response = await request.get(`${GAME_API_URL}${pathname}`);
  expect(response.ok(), `GET ${pathname} should succeed`).toBeTruthy();
  return (await response.json()) as T;
}

async function postJson<T>(
  request: APIRequestContext,
  pathname: string,
  body: unknown,
): Promise<T> {
  const response = await request.post(`${GAME_API_URL}${pathname}`, {
    data: body,
    headers: E2E_ARENA_WRITE_KEY
      ? { "x-arena-write-key": E2E_ARENA_WRITE_KEY }
      : undefined,
  });
  expect(response.ok(), `POST ${pathname} should succeed`).toBeTruthy();
  return (await response.json()) as T;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePreparedSolanaDuelKey(
  duelKeyHex: string | undefined,
): string {
  const normalized = duelKeyHex?.trim().replace(/^0x/i, "").toLowerCase() || "";
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Missing or invalid currentDuelKeyHex in Solana e2e state`);
  }
  return normalized;
}

async function waitForPreparedSolanaOpenMarket(
  request: APIRequestContext,
  state: E2eState,
  connection: Connection,
): Promise<{
  duelId: string;
  duelKeyHex: string;
  duelState: PublicKey;
  marketState: PublicKey;
  vault: PublicKey;
}> {
  const duelId = (state.currentDuelId || "").trim();
  if (!duelId) {
    throw new Error("Missing currentDuelId in Solana e2e state");
  }
  const duelKeyHex = normalizePreparedSolanaDuelKey(state.currentDuelKeyHex);
  const duelState = new PublicKey(state.clobDuelState || "");
  const marketState = new PublicKey(state.clobMarketState || "");
  const deadline = Date.now() + 180_000;
  let lastError = `prepared solana duel ${duelId} is not active yet`;

  while (Date.now() < deadline) {
    try {
      const predictionMarkets = await fetchJson<{
        duel: {
          duelId: string | null;
          duelKey: string | null;
          betCloseTime: number | null;
        };
        markets: Array<{
          chainKey: string;
          marketRef: string | null;
          lifecycleStatus: string;
        }>;
      }>(request, "/api/arena/prediction-markets/active");
      const solanaMarket =
        predictionMarkets.markets.find(
          (market) => market.chainKey === "solana",
        ) ?? null;
      if (!solanaMarket) {
        lastError =
          "active Solana market is missing from prediction-markets API";
        await sleepMs(1_000);
        continue;
      }
      if ((predictionMarkets.duel.duelId || "").trim() !== duelId) {
        lastError = `prepared Solana duel drifted to ${predictionMarkets.duel.duelId || "missing duel id"}`;
        await sleepMs(1_000);
        continue;
      }
      if (
        (predictionMarkets.duel.duelKey || "").trim().toLowerCase() !==
        duelKeyHex
      ) {
        lastError = `prepared Solana duel key drifted to ${predictionMarkets.duel.duelKey || "missing duel key"}`;
        await sleepMs(1_000);
        continue;
      }
      if ((solanaMarket.marketRef || "").trim() !== marketState.toBase58()) {
        lastError = `prepared Solana market drifted to ${solanaMarket.marketRef || "missing market ref"}`;
        await sleepMs(1_000);
        continue;
      }
      if (solanaMarket.lifecycleStatus !== "OPEN") {
        lastError = `prepared Solana market ${duelId} is ${solanaMarket.lifecycleStatus || "missing lifecycle"}`;
        await sleepMs(1_000);
        continue;
      }
      const betCloseTimeMs =
        typeof predictionMarkets.duel.betCloseTime === "number"
          ? predictionMarkets.duel.betCloseTime
          : (state.currentBetCloseTimeMs ?? null);
      if (
        betCloseTimeMs != null &&
        betCloseTimeMs - Date.now() < PREPARED_LIVE_DUEL_MIN_OPEN_WINDOW_MS
      ) {
        lastError = `prepared Solana duel ${duelId} has less than ${PREPARED_LIVE_DUEL_MIN_OPEN_WINDOW_MS}ms left in the betting window`;
        await sleepMs(1_000);
        continue;
      }
      return {
        duelId,
        duelKeyHex,
        duelState,
        marketState,
        vault: deriveClobVaultPda(
          createReadonlyClobProgram(connection, state).programId,
          marketState,
        ),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleepMs(1_000);
    }
  }

  throw new Error(
    `Timed out waiting for the prepared live Solana duel on the keeper API: ${lastError}`,
  );
}

async function retireWagerAuthorityFixtureMarket(
  request: APIRequestContext,
  state: E2eState,
  connection: Connection,
): Promise<void> {
  const rpc = new URL(connection.rpcEndpoint);
  if (
    E2E_DUEL_SOURCE !== "synthetic_publish" ||
    rpc.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname)
  ) {
    throw new Error(
      "Fixture rollover is restricted to the synthetic local validator",
    );
  }
  const stream = await fetchJson<{
    seq: number;
    cycle: {
      duelId: string;
      duelKeyHex: string;
      phase: string;
      competitiveSnapshotDigest: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>(request, "/api/streaming/state");
  const key = stream.cycle.duelKeyHex;
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  const clob = createReadonlyClobProgram(connection, state);
  const oracle = new Program<FightOracle>(fightOracleIdl, clob.provider);
  const duelState = deriveDuelStatePda(
    oracle.programId,
    Array.from(Buffer.from(key, "hex")),
  );
  const marketState = deriveMarketStatePda(clob.programId, duelState);
  const duel = await oracle.account.duelState.fetch(duelState);
  expect(Buffer.from(duel.competitiveSnapshotDigest).toString("hex")).toBe(
    stream.cycle.competitiveSnapshotDigest,
  );
  expect(Object.keys(duel.status)).toEqual(["bettingOpen"]);
  expect(stream.cycle.phase).toBe("ANNOUNCEMENT");
  const now = Date.now();
  const published = await postJson<{ ok: boolean; seq: number }>(
    request,
    "/api/streaming/state/publish",
    buildWagerAuthorityFixtureUpdate(
      stream,
      {
        phase: "RESOLUTION",
        phaseStartTime: now,
        phaseEndTime: now + 5_000,
        duelEndTime: (await currentChainUnixTimestamp(connection)) * 1_000,
        countdown: 0,
        timeRemaining: 0,
        winnerId: null,
        winnerName: null,
        winReason: null,
        outcome: "cancelled",
        cancellationReason: "fixture_cancelled",
        seed: null,
        replayHash: null,
        rendererHealth: buildSyntheticRendererHealth(now),
      },
      now,
    ),
  );
  expect(published.ok).toBe(true);
  expect(published.seq).toBeGreaterThan(stream.seq);
  await expect
    .poll(
      async () => {
        const [chainDuel, chainMarket, healthResponse] = await Promise.all([
          oracle.account.duelState.fetch(duelState),
          clob.account.marketState.fetch(marketState),
          request.get(`${GAME_API_URL}/api/keeper/bot-health`),
        ]);
        const health = (await healthResponse.json()) as {
          health?: {
            markets: Array<{ marketRef: string; lifecycleStatus: string }>;
            recovery: Array<{ code: string; active: boolean }>;
          };
        };
        return {
          oracle: Object.keys(chainDuel.status),
          market: Object.keys(chainMarket.status),
          keeper: health.health?.markets.find(
            (entry) => entry.marketRef === marketState.toBase58(),
          )?.lifecycleStatus,
          recovery: health.health?.recovery
            .filter((entry) => entry.active)
            .map((entry) => entry.code),
        };
      },
      { timeout: 90_000 },
    )
    .toEqual({
      oracle: ["cancelled"],
      market: ["cancelled"],
      keeper: "CANCELLED",
      recovery: [],
    });
}

async function createFreshSolanaOpenMarket(
  request: APIRequestContext,
  state: E2eState,
  connection: Connection,
): Promise<{
  duelId: string;
  duelKeyHex: string;
  duelState: PublicKey;
  marketState: PublicKey;
  vault: PublicKey;
}> {
  if (E2E_DUEL_SOURCE === "real_hyperia") {
    return waitForPreparedSolanaOpenMarket(request, state, connection);
  }
  await ensureBootstrapAuthorityLamportBuffer(connection, state);
  const authority = loadBootstrapAuthority(state);
  const provider = createPollingProvider(connection, toWallet(authority));
  const fightProgram = new Program<FightOracle>(fightOracleIdl, provider);
  const clobProgram = new Program<DuelMarket>(duelMarketIdl, provider);
  const duelKey = uniqueDuelKey("solana-clob-ui");
  const duelKeyHex = Buffer.from(duelKey).toString("hex");
  const duelId = `${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const betOpenTs = now - 60;
  const betCloseTs = now + 600;
  const duelStartTs = now + 660;
  const cycleId = `solana-clob-ui-${duelId}`;
  const baseAgent1 = {
    id: "solana-ui-agent-a",
    name: "Agent A",
    provider: "Hyperia",
    model: "alpha-local",
    hp: 80,
    maxHp: 100,
    combatLevel: 88,
    wins: 12,
    losses: 4,
    damageDealtThisFight: 148,
    rank: 1,
    headToHeadWins: 3,
    headToHeadLosses: 2,
    inventory: [],
    monologues: [],
  };
  const baseAgent2 = {
    id: "solana-ui-agent-b",
    name: "Agent B",
    provider: "OpenRouter",
    model: "beta-local",
    hp: 76,
    maxHp: 100,
    combatLevel: 84,
    wins: 10,
    losses: 5,
    damageDealtThisFight: 131,
    rank: 2,
    headToHeadWins: 2,
    headToHeadLosses: 3,
    inventory: [],
    monologues: [],
  };
  const competitiveSnapshot = buildSyntheticDuelCommitment({
    cycleId,
    duelId,
    duelKeyHex,
    betOpenTs,
    betCloseTs,
    duelStartTs,
    agent1: baseAgent1,
    agent2: baseAgent2,
  });
  const agent1 = buildSyntheticPublicAgent(
    baseAgent1,
    competitiveSnapshot.competitiveSnapshot,
    "agent1",
  );
  const agent2 = buildSyntheticPublicAgent(
    baseAgent2,
    competitiveSnapshot.competitiveSnapshot,
    "agent2",
  );

  await ensureOracleReady(
    fightProgram as never,
    authority,
    authority.publicKey,
    authority.publicKey,
    authority.publicKey,
    60,
  );
  const duelState = await upsertDuel(
    fightProgram as never,
    authority,
    duelKey,
    {
      status: duelStatusBettingOpen(),
      betOpenTs,
      betCloseTs,
      duelStartTs,
      participantAHash: competitiveSnapshot.participantAHash,
      participantBHash: competitiveSnapshot.participantBHash,
      competitiveSnapshotVersion:
        competitiveSnapshot.competitiveSnapshotVersion,
      competitiveSnapshotDigest:
        competitiveSnapshot.competitiveSnapshotDigestBytes,
      metadataUri: JSON.stringify({
        duelId,
        duelKeyHex,
        lifecycleEvent: "open",
        source: "hyperia-e2e",
      }),
    },
  );
  const derivedMarketState = deriveMarketStatePda(
    clobProgram.programId,
    duelState,
  );
  let marketState = derivedMarketState;
  let vault = deriveClobVaultPda(clobProgram.programId, marketState);
  try {
    ({ marketState, vault } = await initializeCanonicalMarket(
      clobProgram as never,
      authority,
      duelState,
      duelKey,
      new PublicKey(state.clobConfig || ""),
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already in use/i.test(message)) throw error;
  }

  await syncMarketFromDuel(clobProgram as never, marketState, duelState);

  if (E2E_DUEL_SOURCE !== "synthetic_publish") {
    throw new Error(
      `solana-clob-ui synthetic publish requires synthetic_publish duel source, got ${E2E_DUEL_SOURCE}`,
    );
  }
  const publishedAtMs = Date.now();
  await postJson<{ ok: boolean; seq: number }>(
    request,
    "/api/streaming/state/publish",
    {
      cycle: {
        cycleId,
        phase: "ANNOUNCEMENT",
        duelId,
        duelKeyHex,
        cycleStartTime: publishedAtMs - 90_000,
        phaseStartTime: publishedAtMs - 5_000,
        phaseEndTime: betCloseTs * 1000,
        betOpenTime: betOpenTs * 1000,
        betCloseTime: betCloseTs * 1000,
        fightStartTime: duelStartTs * 1000,
        duelEndTime: null,
        competitiveSnapshotVersion:
          competitiveSnapshot.competitiveSnapshotVersion,
        competitiveSnapshotDigest:
          competitiveSnapshot.competitiveSnapshotDigest,
        competitiveSnapshot: competitiveSnapshot.competitiveSnapshot,
        countdown: Math.max(0, betCloseTs - now),
        timeRemaining: Math.max(0, betCloseTs - now) * 1000,
        winnerId: null,
        winnerName: null,
        winReason: null,
        seed: null,
        replayHash: null,
        agent1,
        agent2,
        arenaPositions: {
          agent1: [-1, 0, 0],
          agent2: [1, 0, 0],
        },
        rendererHealth: buildSyntheticRendererHealth(publishedAtMs),
      },
      leaderboard: [],
      cameraTarget: null,
    },
  );

  return {
    duelId,
    duelKeyHex,
    duelState,
    marketState,
    vault,
  };
}

async function gotoApp(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/?debug=1", { waitUntil: "domcontentloaded" });
    try {
      await expect
        .poll(
          async () => {
            const bodyText = (
              (await page
                .locator("body")
                .textContent()
                .catch(() => "")) || ""
            )
              .trim()
              .toUpperCase();
            if (
              bodyText.includes("HYPERIA DUEL ARENA") ||
              bodyText.includes("ULTRA SIMPLE FIGHT BET")
            ) {
              return bodyText;
            }
            return "";
          },
          {
            timeout: 20_000,
            intervals: [500, 1_000, 2_000, 5_000],
          },
        )
        .not.toBe("");
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.goto("about:blank");
    }
  }
}

async function ensureWalletConnected(page: Page): Promise<void> {
  const hasConnectedSolanaWallet = async (): Promise<boolean> => {
    const desktopWalletChip = page
      .getByRole("button", { name: /^SOL\s+[A-Za-z0-9].*/i })
      .first();
    if (await desktopWalletChip.isVisible().catch(() => false)) return true;

    const mobileWalletChip = page
      .getByRole("button", { name: /^◎\s*[A-Za-z0-9].*/i })
      .first();
    if (await mobileWalletChip.isVisible().catch(() => false)) return true;

    return false;
  };

  const selectHeadlessWallet = async (): Promise<boolean> => {
    const walletOption = page
      .getByRole("button", { name: /E2E Trader/i })
      .first();
    if (!(await walletOption.isVisible().catch(() => false))) return false;
    await walletOption.click();
    await expect(
      page.getByRole("dialog", {
        name: /Connect a wallet on Solana to continue/i,
      }),
    )
      .toBeHidden({ timeout: 30_000 })
      .catch(() => undefined);
    return true;
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await hasConnectedSolanaWallet()) return;

    if (await selectHeadlessWallet()) {
      await page.waitForTimeout(2_000);
      continue;
    }

    const connectButton = page
      .getByRole("button", {
        name: /connect wallet|select wallet|connect|add sol wallet|connect sol/i,
      })
      .first();
    if (await connectButton.isVisible().catch(() => false)) {
      await connectButton.click();
    }
    await selectHeadlessWallet();
    await page.waitForTimeout(2_000);
  }

  await expect.poll(hasConnectedSolanaWallet, { timeout: 60_000 }).toBe(true);
}

test("prediction market loads the current duel and mints YES shares on-chain", async ({
  page,
  request,
}) => {
  test.setTimeout(900_000);
  const state = await loadState();
  const connection = createConfirmedConnection(
    state.solanaRpcUrl || "http://127.0.0.1:8899",
    state.solanaWsUrl,
  );
  const clobProgram = createReadonlyClobProgram(connection, state);
  const authority = loadBootstrapAuthority(state);
  const trader = new PublicKey(
    state.solanaTraderPublicKey || authority.publicKey.toBase58(),
  );
  const freshMarket = await waitForPreparedSolanaOpenMarket(
    request,
    state,
    connection,
  );
  const userBalanceAddress = deriveUserBalancePda(
    clobProgram.programId,
    freshMarket.marketState,
    trader,
  );

  await gotoApp(page);
  await ensureWalletConnected(page);
  await page.getByTestId("refresh-market").click();

  const competitiveDisclosure = page.getByTestId("competitive-disclosure");
  await expect(competitiveDisclosure).toBeVisible({ timeout: 60_000 });
  await expect(competitiveDisclosure.locator("article")).toHaveCount(2);
  const competitivePlanDetails = competitiveDisclosure.locator("details");
  await expect(competitivePlanDetails).toHaveCount(2);
  await expect(competitivePlanDetails.first()).not.toHaveAttribute("open", "");
  await competitivePlanDetails.first().locator("summary").click();
  await expect(competitivePlanDetails.first()).toHaveAttribute("open", "");
  await expect(competitivePlanDetails.first()).toContainText(
    /Aggressive attacks/i,
  );
  await competitivePlanDetails.first().locator("summary").click();
  await expect(competitivePlanDetails.first()).not.toHaveAttribute("open", "");

  // Make the exact market transaction-ready before opening the independent
  // public-layout page. Visibility alone is not enough for the confirmation
  // audit: the second page must prove its own live quote and funding gate.
  await seedAskLiquidity(connection, state, freshMarket);
  await page.getByTestId("refresh-market").click();

  // The diagnostic query intentionally prepends an E2E status panel. Check
  // initial-fold usability on a second page using the actual public layout.
  const productionView = await page.context().newPage();
  try {
    const productionViewQuery = new URLSearchParams({
      e2eSolanaDuelKey: freshMarket.duelKeyHex,
      e2eSolanaDuelId: freshMarket.duelId,
      e2eSolanaMarketRef: freshMarket.marketState.toBase58(),
    });
    await productionView.goto(`/?${productionViewQuery.toString()}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureWalletConnected(productionView);
    const productionRoot = productionView.locator(".hm-root");
    await expect(productionRoot).toHaveAttribute(
      "data-market-duel-id",
      freshMarket.duelId,
      { timeout: 60_000 },
    );
    await expect(productionRoot).toHaveAttribute(
      "data-market-duel-key",
      freshMarket.duelKeyHex,
      { timeout: 60_000 },
    );
    await expect(productionRoot).toHaveAttribute(
      "data-market-reason",
      "market-open",
      { timeout: 60_000 },
    );
    await expect(productionRoot).toHaveAttribute(
      "data-market-can-place-bet",
      "true",
      { timeout: 60_000 },
    );
    await expect(
      productionView.getByTestId("competitive-disclosure"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      productionView.getByTestId("prediction-amount-input"),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      productionView.getByTestId("prediction-submit"),
    ).toBeInViewport({ ratio: 1 });
    await productionView.setViewportSize({ width: 390, height: 844 });
    const openTradingPanel = productionView.locator(".hm-bet-fab");
    await expect(openTradingPanel).toBeVisible({ timeout: 60_000 });
    expect(
      await openTradingPanel.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    await openTradingPanel.click();
    await expect(
      productionView.getByRole("dialog", { name: "Trading controls" }),
    ).toBeVisible();
    await expect(
      productionView.getByTestId("competitive-disclosure"),
    ).toBeVisible();
    await expect(
      productionView.getByTestId("prediction-amount-input"),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      productionView.getByTestId("prediction-submit"),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await productionView.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      await productionView
        .getByRole("button", { name: "Close trading panel" })
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    const mobileSubmit = productionView.getByTestId("prediction-submit");
    await expect(mobileSubmit).toBeEnabled({ timeout: 60_000 });
    await mobileSubmit.click();
    const mobileConfirmation = productionView.getByRole("dialog", {
      name: /confirm sol order/i,
    });
    await expect(mobileConfirmation).toBeVisible({ timeout: 15_000 });
    await expect(mobileConfirmation).toContainText("Buy Agent A (YES)");
    await expect(mobileConfirmation).toContainText(
      /Maximum gross payout\s*1 SOL/i,
    );
    const mobileBack = mobileConfirmation.getByRole("button", {
      name: /back to edit/i,
    });
    const mobileConfirm = mobileConfirmation.getByRole("button", {
      name: /confirm and sign/i,
    });
    await expect(mobileBack).toBeFocused();
    await expect(mobileBack).toBeInViewport({ ratio: 1 });
    await expect(mobileConfirm).toBeInViewport({ ratio: 1 });
    expect(
      await mobileBack.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    expect(
      await mobileConfirm.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    await productionView.keyboard.press("Escape");
    await expect(mobileConfirmation).toHaveCount(0);
    await expect(
      productionView.getByRole("dialog", { name: "Trading controls" }),
    ).toBeVisible();
    await expect(mobileSubmit).toBeFocused();
  } finally {
    await productionView.close();
  }
  await expect(page.locator(".hm-root")).toHaveAttribute(
    "data-market-competitive-disclosure",
    "verified",
  );

  await expect(page.getByTestId("current-match-id")).toContainText(
    freshMarket.duelId,
    {
      timeout: 60_000,
    },
  );
  await expect
    .poll(() => readText(page, "solana-clob-match"), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toContain(freshMarket.marketState.toBase58());
  await expect(page.getByTestId("market-status")).not.toContainText("Waiting", {
    timeout: 60_000,
  });

  await page.getByTestId("refresh-market").click();

  await expect(page.getByTestId("solana-order-quote")).toContainText(
    /Visible immediate fill\s*0\.1 SOL/i,
    { timeout: 60_000 },
  );

  await expect
    .poll(
      async () => await page.getByTestId("prediction-submit").isDisabled(),
      {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toBe(false);
  await expect
    .poll(() => readText(page, "market-status"), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe("Market: OPEN");
  await expect
    .poll(() => readText(page, "solana-clob-status"), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toMatch(/betting open|market open/i);

  await page.getByTestId("prediction-select-yes").click();
  await page
    .getByTestId("prediction-amount-input")
    .fill(state.placeBetAmount ?? "1");
  await submitSolanaOrderWithBoundedQuoteReview(page);

  const immediateStatus = await page
    .getByTestId("solana-clob-status")
    .textContent()
    .catch(() => "");
  if ((immediateStatus || "").includes("Order failed:")) {
    throw new Error((immediateStatus || "").trim());
  }

  try {
    await expect
      .poll(
        async () => {
          const currentStatus = await readText(page, "solana-clob-status");
          if (/Order failed:/i.test(currentStatus)) {
            throw new Error(currentStatus);
          }
          const balance = (await clobProgram.account.userBalance.fetchNullable(
            userBalanceAddress,
          )) as UserBalanceAccount | null;
          return Number(bnLikeToBigInt(balance?.aShares));
        },
        {
          timeout: 120_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBeGreaterThan(0);
  } catch (error) {
    const currentStatus = await readText(page, "solana-clob-status");
    const marketBalances = await loadMarketBalances(connection, state, {
      marketState: freshMarket.marketState,
    });
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `status=${currentStatus || "<empty>"}`,
        `marketBalances=${JSON.stringify(marketBalances)}`,
      ].join("\n"),
      { cause: error },
    );
  }
});

const authorityScenarios = [
  ...WAGER_AUTHORITY_BOUNDARIES.map((boundary) => ({
    boundary,
    realCapture: false,
  })),
  ...CAPTURE_WAGER_AUTHORITY_BOUNDARIES.map((boundary) => ({
    boundary,
    realCapture: true,
  })),
];
for (const { boundary, realCapture } of authorityScenarios) {
  test(
    realCapture
      ? captureWagerAuthorityTestTitle(boundary)
      : wagerAuthorityTestTitle(boundary),
    async ({ page, request }, testInfo) => {
      test.skip(
        E2E_DUEL_SOURCE !==
          (realCapture ? "real_hyperia" : "synthetic_publish") ||
          (realCapture && process.env.E2E_HYPERIA_RUNTIME !== "full_3d") ||
          process.env.E2E_APP_RUNTIME !== "production_preview" ||
          process.env.E2E_PRODUCTION_TRANSACTIONS !== "true",
        "Requires the explicit production-built local-validator transaction fixture",
      );
      test.setTimeout(realCapture ? 600_000 : 240_000);
      const captureControl = realCapture
        ? (await loadControl()).services.hyperia
        : undefined;
      if (realCapture && !captureControl)
        throw new Error("Owned full-3D capture control is missing");
      const state = await loadState();
      const rpcUrl = new URL(state.solanaRpcUrl || "");
      expect(rpcUrl.protocol).toBe("http:");
      expect(["127.0.0.1", "localhost", "[::1]"]).toContain(rpcUrl.hostname);
      expect(rpcUrl.username + rpcUrl.password).toBe("");
      const connection = createConfirmedConnection(
        rpcUrl.href,
        state.solanaWsUrl,
      );
      const genesis = await connection.getGenesisHash();
      const trader = new PublicKey(state.solanaTraderPublicKey || "");
      const clobProgram = createReadonlyClobProgram(connection, state);
      expect(clobProgram.programId.toBase58()).toBe(duelMarketIdl.address);
      expect(
        (await connection.getAccountInfo(clobProgram.programId))?.executable,
      ).toBe(true);
      if (!realCapture) {
        await test.step("retire the prior fixture through the canonical keeper lifecycle", () =>
          retireWagerAuthorityFixtureMarket(request, state, connection));
      }
      const market = await createFreshSolanaOpenMarket(
        request,
        state,
        connection,
      );
      await seedAskLiquidity(connection, state, market);
      const balanceAddress = deriveUserBalancePda(
        clobProgram.programId,
        market.marketState,
        trader,
      );
      const initialBalance =
        await clobProgram.account.userBalance.fetchNullable(balanceAddress);
      const initialAShares = bnLikeToBigInt(initialBalance?.aShares);
      if (!realCapture) expect(initialAShares).toBe(0n);
      await expect
        .poll(
          async () => {
            const response = await request.get(`${GAME_API_URL}/ready`);
            const payload = (await response.json()) as {
              readiness?: { ready: boolean; reasons: string[] };
            };
            return {
              status: response.status(),
              ready: payload.readiness?.ready,
              reasons: payload.readiness?.reasons,
            };
          },
          { timeout: 60_000 },
        )
        .toEqual({ status: 200, ready: true, reasons: [] });
      await expect
        .poll(async () => {
          const active = await fetchJson<{
            duel: { duelId: string; duelKey: string };
            markets: Array<{
              chainKey: string;
              marketRef: string;
              lifecycleStatus: string;
            }>;
          }>(request, "/api/arena/prediction-markets/active");
          const solana = active.markets.find(
            (entry) => entry.chainKey === "solana",
          );
          return {
            duel: active.duel.duelId,
            key: active.duel.duelKey,
            market: solana?.marketRef,
            status: solana?.lifecycleStatus,
          };
        })
        .toEqual({
          duel: market.duelId,
          key: market.duelKeyHex,
          market: market.marketState.toBase58(),
          status: "OPEN",
        });
      const root = page.locator(".hm-root");
      const dialog = page.getByRole("dialog", { name: /confirm sol order/i });
      const feedback = page.getByTestId("solana-order-transaction-feedback");
      const requestCountKey = "hyperbet.e2e.wallet-signature-requests";
      const pendingKey = "hyperbet.e2e.pending-wallet-signature";
      const runtimeErrors: string[] = [];
      let sends = 0;
      let records = 0;
      let successfulRecords = 0;
      const trackingAttempts: Array<{
        payload: unknown;
        status: number | null;
      }> = [];
      const trackingByRequest = new Map<
        BrowserRequest,
        (typeof trackingAttempts)[number]
      >();
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("request", (browserRequest) => {
        const pathname = new URL(browserRequest.url()).pathname;
        if (
          browserRequest.method() === "POST" &&
          pathname === "/__solana/rpc"
        ) {
          const payload = browserRequest.postDataJSON() as { method?: string };
          if (payload.method === "sendTransaction") sends += 1;
        }
        if (
          browserRequest.method() === "POST" &&
          pathname.endsWith("/record-external")
        ) {
          records += 1;
          const attempt = {
            payload: browserRequest.postDataJSON() as unknown,
            status: null,
          };
          trackingAttempts.push(attempt);
          trackingByRequest.set(browserRequest, attempt);
        }
      });
      page.on("response", (response) => {
        const attempt = trackingByRequest.get(response.request());
        if (attempt) attempt.status = response.status();
        if (
          new URL(response.url()).pathname.endsWith("/record-external") &&
          response.status() === 200
        ) {
          successfulRecords += 1;
        }
      });
      const readWalletRequests = () =>
        page.evaluate(
          (key) => Number(window.sessionStorage.getItem(key) ?? "0"),
          requestCountKey,
        );
      const readWalletChain = async () => ({
        lamports: await connection.getBalance(trader, "finalized"),
        signatures: (
          await connection.getSignaturesForAddress(
            trader,
            { limit: 100 },
            "finalized",
          )
        ).map((entry) => entry.signature),
      });
      const query = new URLSearchParams({
        e2eSolanaDuelKey: market.duelKeyHex,
        e2eSolanaDuelId: market.duelId,
        e2eSolanaMarketRef: market.marketState.toBase58(),
      });
      await page.goto(`/?${query}`, { waitUntil: "domcontentloaded" });
      await ensureWalletConnected(page);
      const navigationIdentity = await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        navigations: performance.getEntriesByType("navigation").length,
      }));
      const assertRecovered = async () => {
        await expect(root).toHaveAttribute(
          "data-market-duel-id",
          market.duelId,
        );
        await expect(root).toHaveAttribute(
          "data-market-duel-key",
          market.duelKeyHex,
        );
        await expect(root).toHaveAttribute(
          "data-stream-duel-id",
          market.duelId,
        );
        await expect(root).toHaveAttribute(
          "data-stream-duel-key",
          market.duelKeyHex,
        );
        await expect(root).toHaveAttribute("data-market-can-place-bet", "true");
        await expect(root).toHaveAttribute(
          "data-market-competitive-disclosure",
          "verified",
        );
        expect(
          await page.evaluate(() => ({
            timeOrigin: performance.timeOrigin,
            navigations: performance.getEntriesByType("navigation").length,
          })),
        ).toEqual(navigationIdentity);
      };
      await assertRecovered();
      const video = page.locator("video").first();
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => ({
            width: element.videoWidth,
            ready: element.readyState >= 2,
          })),
        )
        .toMatchObject({ width: 1280, ready: true });
      await page.getByTestId("prediction-amount-input").fill("0.05");
      await page.getByTestId("prediction-select-yes").click();
      const submit = page.getByTestId("prediction-submit");
      await expect(submit).toBeEnabled();
      const authorityState = await fetchJson<{
        seq: number;
        cycle: {
          duelId: string;
          duelKeyHex: string;
          betCloseTime: number;
          competitiveSnapshotDigest: string;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      }>(request, "/api/streaming/state");
      expect(authorityState.cycle.duelId).toBe(market.duelId);
      expect(authorityState.cycle.duelKeyHex).toBe(market.duelKeyHex);
      expect(authorityState.cycle.betCloseTime - Date.now()).toBeGreaterThan(
        60_000,
      );
      expect(authorityState.cycle.competitiveSnapshotDigest).toMatch(
        /^[a-f0-9]{64}$/,
      );
      const oracleProgram = new Program<FightOracle>(
        fightOracleIdl,
        clobProgram.provider,
      );
      const chainDuel = (await oracleProgram.account.duelState.fetch(
        market.duelState,
      )) as {
        competitiveSnapshotVersion: number;
        competitiveSnapshotDigest: number[];
      };
      expect(Number(chainDuel.competitiveSnapshotVersion)).toBe(4);
      expect(authorityState.cycle.competitiveSnapshotVersion).toBe(4);
      expect(
        Buffer.from(chainDuel.competitiveSnapshotDigest).toString("hex"),
      ).toBe(authorityState.cycle.competitiveSnapshotDigest);
      let publishedSequence = authorityState.seq;
      const publishAvailability = async (ready: boolean) => {
        if (realCapture)
          throw new Error(
            "Real capture evidence cannot publish synthetic health",
          );
        expect(authorityState.cycle.betCloseTime - Date.now()).toBeGreaterThan(
          30_000,
        );
        const now = Date.now();
        const published = await postJson<{ ok: boolean; seq: number }>(
          request,
          "/api/streaming/state/publish",
          buildWagerAuthorityFixtureUpdate(
            authorityState,
            {
              rendererHealth: {
                updatedAt: now,
                ready,
                degradedReason: ready ? null : "camera_target_unresolved",
              },
            },
            now,
          ),
        );
        expect(published.ok).toBe(true);
        expect(published.seq).toBeGreaterThan(publishedSequence);
        publishedSequence = published.seq;
      };
      const beforeChain = await readWalletChain();
      const captureBefore = captureControl
        ? await readOwnedCaptureSnapshot(
            captureControl,
            process.env.E2E_HLS_PRIMARY_URL || "",
          )
        : null;
      let captureFault: {
        killedAt: number;
        apiFailClosedAt: number;
        browserFailClosedAt: number;
        before: CaptureRuntimeSnapshot;
        after: CaptureRuntimeSnapshot | null;
      } | null = null;
      const beforeRequests = await readWalletRequests();
      expect(sends).toBe(0);
      expect(records).toBe(0);
      await submit.click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /confirm and sign/i }),
      ).toBeEnabled();
      let rpcHeld = false;
      let rpcHandlerStarted = false;
      let rpcHandlerFailure: unknown = null;
      let forwardedSignature: string | null = null;
      let releaseRpc = () => {};
      const rpcRelease = new Promise<void>((resolve) => {
        releaseRpc = resolve;
      });
      let completeHeldRpc = () => {};
      const heldRpcCompleted = new Promise<void>((resolve) => {
        completeHeldRpc = resolve;
      });
      const holdRpc = async (route: Route) => {
        const payload = route.request().postDataJSON() as { method?: string };
        if (
          !rpcHandlerStarted &&
          boundary === "before-wallet" &&
          payload.method === "getLatestBlockhash"
        ) {
          rpcHandlerStarted = true;
          rpcHeld = true;
          try {
            await rpcRelease;
            await route.continue();
          } catch (error) {
            rpcHandlerFailure = error;
            throw error;
          } finally {
            completeHeldRpc();
          }
        } else if (
          !rpcHandlerStarted &&
          boundary === "broadcast" &&
          payload.method === "sendTransaction"
        ) {
          // Ownership begins before upstream I/O, including failed or timed-out
          // fetches that never reach the deliberately held-response boundary.
          rpcHandlerStarted = true;
          try {
            const upstream = await route.fetch({ timeout: 5_000 });
            const result = (await upstream.json()) as {
              result?: string;
              error?: unknown;
            };
            expect(result.error).toBeUndefined();
            expect(result.result).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
            forwardedSignature = result.result ?? null;
            rpcHeld = true;
            await rpcRelease;
            await route.fulfill({ response: upstream });
          } catch (error) {
            rpcHandlerFailure = error;
            throw error;
          } finally {
            completeHeldRpc();
          }
        } else {
          await route.continue();
        }
      };
      await page.route("**/__solana/rpc", holdRpc);
      const screenshots: string[] = [];
      const apiAuthorityAtLoss: Array<{
        duelId: string;
        duelKeyHex: string;
        competitiveSnapshotDigest: string;
        rendererHealth: {
          ready: false;
          degradedReason: string;
          updatedAt: number;
        };
      }> = [];
      const apiLossObservations: Array<{
        at: number;
        endpoint: number;
        status: number | null;
        error: string | null;
        seq: number | null;
        emittedAt: number | null;
        duelId: string | null;
        duelKeyHex: string | null;
        competitiveSnapshotDigest: string | null;
        ready: boolean | null;
        degradedReason: string | null;
        updatedAt: number | null;
      }> = [];
      let viewerAuthorityAtLoss: Record<string, string | number | null> | null =
        null;
      const viewerLossObservations: Array<
        Record<string, string | number | null>
      > = [];
      let primaryFailure: unknown;
      let primaryFailed = false;
      const cleanupFailures: unknown[] = [];
      try {
        if (boundary === "wallet") {
          await page.evaluate(() =>
            window.sessionStorage.setItem(
              "hyperbet.e2e.pause-next-wallet-signature",
              "1",
            ),
          );
        }
        if (boundary !== "review") {
          await dialog
            .getByRole("button", { name: /confirm and sign/i })
            .click();
          if (boundary === "wallet") {
            await expect
              .poll(() =>
                page.evaluate(
                  (key) => window.sessionStorage.getItem(key),
                  pendingKey,
                ),
              )
              .not.toBeNull();
          } else {
            await expect.poll(() => rpcHeld).toBe(true);
          }
        }
        if (captureControl && captureBefore) {
          const killedAt = await killOwnedCaptureWorker(
            captureControl,
            captureBefore,
          );
          captureFault = {
            killedAt,
            apiFailClosedAt: 0,
            browserFailClosedAt: 0,
            before: captureBefore,
            after: null,
          };
          const observeApiLoss = async () => {
            await expect
              .poll(
                async () => {
                  const states = await Promise.all(
                    [
                      captureControl.streamStateUrl,
                      `${GAME_API_URL}/api/streaming/state`,
                    ].map(async (url, endpoint) => {
                      const observation: (typeof apiLossObservations)[number] =
                        {
                          at: Date.now(),
                          endpoint,
                          status: null,
                          error: null,
                          seq: null,
                          emittedAt: null,
                          duelId: null,
                          duelKeyHex: null,
                          competitiveSnapshotDigest: null,
                          ready: null,
                          degradedReason: null,
                          updatedAt: null,
                        };
                      let stage = "transport";
                      try {
                        const remainingMs = killedAt + 5_000 - Date.now();
                        if (remainingMs <= 0) {
                          observation.error = "deadline_elapsed";
                          return false;
                        }
                        const response = await request.get(url, {
                          timeout: Math.min(2_000, remainingMs),
                        });
                        observation.status = response.status();
                        stage = "json";
                        const payload = (await response.json()) as {
                          seq?: number;
                          emittedAt?: number;
                          cycle?: {
                            duelId?: string;
                            duelKeyHex?: string;
                            competitiveSnapshotDigest?: string;
                            rendererHealth?: {
                              ready?: boolean;
                              degradedReason?: string;
                              updatedAt?: number;
                            };
                          };
                        };
                        const cycle = payload.cycle;
                        const health = cycle?.rendererHealth;
                        Object.assign(observation, {
                          seq: payload.seq ?? null,
                          emittedAt: payload.emittedAt ?? null,
                          duelId: cycle?.duelId ?? null,
                          duelKeyHex: cycle?.duelKeyHex ?? null,
                          competitiveSnapshotDigest:
                            cycle?.competitiveSnapshotDigest ?? null,
                          ready: health?.ready ?? null,
                          degradedReason: health?.degradedReason ?? null,
                          updatedAt: health?.updatedAt ?? null,
                        });
                        if (response.status() !== 200) return false;
                        if (
                          cycle?.duelId === market.duelId &&
                          cycle.duelKeyHex === market.duelKeyHex &&
                          cycle.competitiveSnapshotDigest ===
                            authorityState.cycle.competitiveSnapshotDigest &&
                          health?.ready === false &&
                          health.degradedReason?.startsWith("capture_") ===
                            true &&
                          Number(health.updatedAt) >= killedAt
                        )
                          return {
                            duelId: cycle.duelId,
                            duelKeyHex: cycle.duelKeyHex,
                            competitiveSnapshotDigest:
                              cycle.competitiveSnapshotDigest,
                            rendererHealth: {
                              ready: false as const,
                              degradedReason: health.degradedReason!,
                              updatedAt: health.updatedAt!,
                            },
                          };
                        return false;
                      } catch (error) {
                        // Error classes identify transport/JSON failures without
                        // retaining response bodies or potentially sensitive URLs.
                        observation.error =
                          `${stage}:${error instanceof Error ? error.name : "unknown"}`.slice(
                            0,
                            128,
                          );
                        return false;
                      } finally {
                        observation.at = Date.now();
                        apiLossObservations.push(observation);
                        if (apiLossObservations.length > 100)
                          apiLossObservations.shift();
                      }
                    }),
                  );
                  if (states.every((entry) => entry !== false)) {
                    apiAuthorityAtLoss.splice(
                      0,
                      apiAuthorityAtLoss.length,
                      ...states,
                    );
                    return true;
                  }
                  return false;
                },
                { timeout: 5_000, intervals: [50, 100, 200] },
              )
              .toBe(true);
            return Date.now();
          };
          const observeBrowserLoss = async () => {
            await expect
              .poll(
                async () => {
                  // Read one DOM state: sequential locator reads can straddle a
                  // health transition and fabricate a contradictory snapshot.
                  const observation = await root.evaluate((element) => {
                    const document = element.ownerDocument;
                    const buttons = Array.from(
                      document.querySelectorAll(
                        '[data-testid="prediction-submit"]',
                      ),
                    );
                    return {
                      observedAt: Date.now(),
                      marketDuelId: element.getAttribute("data-market-duel-id"),
                      marketDuelKey: element.getAttribute(
                        "data-market-duel-key",
                      ),
                      streamDuelId: element.getAttribute("data-stream-duel-id"),
                      streamDuelKey: element.getAttribute(
                        "data-stream-duel-key",
                      ),
                      canPlaceBet: element.getAttribute(
                        "data-market-can-place-bet",
                      ),
                      dialogCount: document.querySelectorAll(
                        '[role="dialog"][aria-labelledby="solana-order-confirmation-title"]',
                      ).length,
                      submitPresent: buttons.length,
                      submitDisabled: buttons.filter(
                        (button) =>
                          button instanceof HTMLButtonElement &&
                          button.disabled,
                      ).length,
                    };
                  });
                  viewerLossObservations.push(observation);
                  if (viewerLossObservations.length > 100)
                    viewerLossObservations.shift();
                  const { observedAt: _observedAt, ...snapshot } = observation;
                  const revoked = isCaptureViewerAuthorityRevoked(snapshot, {
                    duelId: market.duelId,
                    duelKey: market.duelKeyHex,
                  });
                  if (revoked) viewerAuthorityAtLoss = snapshot;
                  return revoked;
                },
                { timeout: 5_000, intervals: [50, 100, 200] },
              )
              .toBe(true);
            return Date.now();
          };
          const fault = captureFault;
          const lossResults = await Promise.allSettled([
            observeApiLoss().then((at) => {
              fault.apiFailClosedAt = at;
            }),
            observeBrowserLoss().then((at) => {
              fault.browserFailClosedAt = at;
            }),
          ]);
          for (const result of lossResults)
            if (result.status === "rejected") throw result.reason;
          expect(captureFault.apiFailClosedAt - killedAt).toBeLessThanOrEqual(
            5_000,
          );
          expect(
            captureFault.browserFailClosedAt - killedAt,
          ).toBeLessThanOrEqual(5_000);
        } else {
          await publishAvailability(false);
          await expect(root).toHaveAttribute(
            "data-market-can-place-bet",
            "false",
          );
        }
        await expect(dialog).toHaveCount(0);
        expect(await submit.isEnabled().catch(() => false)).toBe(false);
        const unavailableScreenshot = testInfo.outputPath(
          `authority-${boundary}-unavailable.png`,
        );
        await page.screenshot({ path: unavailableScreenshot, fullPage: true });
        screenshots.push(unavailableScreenshot);
        if (boundary === "broadcast") {
          await expect(
            page.getByTestId("solana-order-transaction-signature"),
          ).toHaveText(forwardedSignature!);
          expect(sends).toBe(1);
        } else {
          expect(sends).toBe(0);
          expect(records).toBe(0);
          expect(await readWalletChain()).toEqual(beforeChain);
        }
        if (captureControl && captureFault) {
          const fault = captureFault;
          await expect
            .poll(
              async () => {
                try {
                  const after = await readOwnedCaptureSnapshot(
                    captureControl,
                    process.env.E2E_HLS_PRIMARY_URL || "",
                  );
                  assertCaptureRecovery(fault.before, after);
                  fault.after = after;
                  return "ready";
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
              },
              { timeout: 90_000, intervals: [250, 500, 1_000] },
            )
            .toBe("ready");
          assertCaptureFaultEvidence(captureFault);
        } else {
          await publishAvailability(true);
        }
        await assertRecovered();
        if (realCapture) {
          const decodedAtRecovery = await video.evaluate(
            (element: HTMLVideoElement) => element.currentTime,
          );
          await expect
            .poll(
              () =>
                video.evaluate(
                  (element: HTMLVideoElement) => element.currentTime,
                ),
              { timeout: 20_000 },
            )
            .toBeGreaterThan(decodedAtRecovery + 1);
        }
        await expect(dialog).toHaveCount(0);
        await page.waitForTimeout(1_000);
        expect(await readWalletRequests()).toBe(
          beforeRequests +
            (boundary === "wallet" || boundary === "broadcast" ? 1 : 0),
        );
        expect(sends).toBe(boundary === "broadcast" ? 1 : 0);
        if (boundary === "wallet") {
          await page.evaluate((key) => {
            const requestId = window.sessionStorage.getItem(key);
            if (!requestId)
              throw new Error("Paused wallet request disappeared");
            window.dispatchEvent(
              new CustomEvent("hyperbet:e2e:release-wallet-signature", {
                detail: requestId,
              }),
            );
          }, pendingKey);
        }
        releaseRpc();
        if (boundary === "before-wallet" || boundary === "wallet") {
          await expect(feedback).toHaveAttribute("data-state", "error");
          await expect(feedback).toContainText(
            /order book or fee terms changed/i,
          );
          await expect(
            page.getByTestId("solana-order-transaction-signature"),
          ).toHaveCount(0);
          expect(sends).toBe(0);
          expect(records).toBe(0);
          expect(await readWalletChain()).toEqual(beforeChain);
          await feedback
            .getByRole("button", { name: /review latest quote/i })
            .click();
          await expect(feedback).toHaveCount(0);
        }
        if (boundary !== "broadcast") {
          await expect(dialog).toHaveCount(0);
          await expect(submit).toBeEnabled();
          await confirmSolanaOrder(page);
        }
        await expect(feedback).toHaveAttribute("data-state", "confirmed", {
          timeout: 60_000,
        });
        const signature = await readText(
          page,
          "solana-order-transaction-signature",
        );
        expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
        if (forwardedSignature) expect(signature).toBe(forwardedSignature);
        await expect.poll(() => successfulRecords, { timeout: 60_000 }).toBe(1);
        await expect
          .poll(
            async () =>
              (await connection.getSignatureStatuses([signature])).value[0]
                ?.confirmationStatus,
            { timeout: 60_000 },
          )
          .toBe("finalized");
        const afterChain = await readWalletChain();
        const finalizedTransaction = await connection.getParsedTransaction(
          signature,
          {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          },
        );
        expect(finalizedTransaction).not.toBeNull();
        const transactionMeta = finalizedTransaction?.meta;
        if (!finalizedTransaction || !transactionMeta)
          throw new Error("Finalized transaction metadata is missing");
        expect(transactionMeta.err).toBeNull();
        const keys = finalizedTransaction.transaction.message.accountKeys;
        expect(keys[0]?.pubkey.toBase58()).toBe(trader.toBase58());
        expect(keys[0]?.signer).toBe(true);
        expect(keys.map((entry) => entry.pubkey.toBase58())).toEqual(
          expect.arrayContaining([
            market.marketState.toBase58(),
            market.vault.toBase58(),
            clobProgram.programId.toBase58(),
          ]),
        );
        expect(
          finalizedTransaction.transaction.message.instructions.some(
            (instruction) =>
              instruction.programId.equals(clobProgram.programId),
          ),
        ).toBe(true);
        const sumLamports = (balances: number[]) =>
          balances.reduce((total, value) => total + BigInt(value), 0n);
        expect(
          sumLamports(transactionMeta.preBalances) -
            sumLamports(transactionMeta.postBalances),
        ).toBe(BigInt(transactionMeta.fee));
        expect(
          BigInt(transactionMeta.preBalances[0]) -
            BigInt(transactionMeta.postBalances[0]),
        ).toBe(BigInt(beforeChain.lamports) - BigInt(afterChain.lamports));
        expect(
          afterChain.signatures.filter(
            (entry) => !beforeChain.signatures.includes(entry),
          ),
        ).toEqual([signature]);
        expect(afterChain.lamports).toBeLessThan(beforeChain.lamports);
        expect(sends).toBe(1);
        assertWagerAuthorityTrackingEvidence({
          records,
          successfulRecords,
          trackingAttempts,
          signature,
          wallet: trader.toBase58(),
          market: market.marketState.toBase58(),
          duelId: market.duelId,
          duelKey: market.duelKeyHex,
        });
        expect(await readWalletRequests()).toBe(
          beforeRequests + (boundary === "wallet" ? 2 : 1),
        );
        expect(await connection.getGenesisHash()).toBe(genesis);
        await assertRecovered();
        const balance = (await clobProgram.account.userBalance.fetch(
          balanceAddress,
        )) as UserBalanceAccount;
        expect(bnLikeToBigInt(balance.aShares) - initialAShares).toBe(
          50_000_000n,
        );
        const confirmedScreenshot = testInfo.outputPath(
          `authority-${boundary}-confirmed.png`,
        );
        await page.screenshot({ path: confirmedScreenshot, fullPage: true });
        screenshots.push(confirmedScreenshot);
        expect(runtimeErrors).toEqual([]);
        await testInfo.attach("wager-authority-evidence", {
          contentType: "application/json",
          body: JSON.stringify(
            {
              schemaVersion: 2,
              boundary,
              source: realCapture ? "real_hyperia" : "synthetic_publish",
              externalValue: false,
              runtime: "production_preview_e2e_mode",
              realRendererFault: false,
              realCaptureFault: realCapture,
              captureFault,
              authorityAtLoss: realCapture
                ? { apis: apiAuthorityAtLoss, viewer: viewerAuthorityAtLoss }
                : null,
              realWalletSigning: true,
              genesis,
              wallet: trader.toBase58(),
              duelId: market.duelId,
              duelKey: market.duelKeyHex,
              market: market.marketState.toBase58(),
              competitiveSnapshotDigest:
                authorityState.cycle.competitiveSnapshotDigest,
              signature,
              beforeChain,
              afterChain,
              sends,
              records,
              successfulRecords,
              trackingAttempts,
              walletRequests: (await readWalletRequests()) - beforeRequests,
              feeLamports: transactionMeta.fee,
              walletDebitLamports: beforeChain.lamports - afterChain.lamports,
              finalizedAccountConservation: true,
              initialAShares: initialAShares.toString(),
              finalAShares: bnLikeToBigInt(balance.aShares).toString(),
              screenshots,
              navigationIdentity,
            },
            null,
            2,
          ),
        });
      } catch (error) {
        primaryFailed = true;
        primaryFailure = error;
      } finally {
        const cleanupStep = async (
          label: string,
          operation: () => Promise<unknown>,
          timeoutMs = 5_000,
        ): Promise<void> => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              operation(),
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(`${label} timed out after ${timeoutMs}ms`),
                    ),
                  timeoutMs,
                );
              }),
            ]);
          } catch (error) {
            cleanupFailures.push(new Error(label, { cause: error }));
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
        };
        await cleanupStep("Retain capture fault diagnostics", async () => {
          if (realCapture)
            await testInfo.attach("capture-fault-attempt-diagnostics", {
              contentType: "application/json",
              body: JSON.stringify({
                schemaVersion: 1,
                boundary,
                qualified: false,
                captureFault,
                expectedAuthority: {
                  duelId: market.duelId,
                  duelKeyHex: market.duelKeyHex,
                  competitiveSnapshotDigest:
                    authorityState.cycle.competitiveSnapshotDigest,
                },
                apiLossObservations,
                viewerAuthorityAtLoss,
                viewerLossObservations,
                sends,
                records,
                forwardedSignature,
                rpcHandlerStarted,
                rpcHeld,
              }),
            });
        });
        // Evidence I/O must never bypass cancellation of an unsigned wallet
        // request, release of owned RPC holds, or removal of their route.
        await cleanupStep("Cancel pending wallet approval", async () => {
          await page.evaluate(() => {
            window.sessionStorage.setItem(
              "hyperbet.e2e.reject-next-wallet-signature",
              "1",
            );
            window.sessionStorage.removeItem(
              "hyperbet.e2e.pause-next-wallet-signature",
            );
            const requestId = window.sessionStorage.getItem(
              "hyperbet.e2e.pending-wallet-signature",
            );
            if (requestId)
              window.dispatchEvent(
                new CustomEvent("hyperbet:e2e:cancel-wallet-signature", {
                  detail: requestId,
                }),
              );
          });
        });
        releaseRpc();
        await cleanupStep(
          "Complete the owned RPC handler",
          async () => {
            if (rpcHandlerStarted) await heldRpcCompleted;
            if (rpcHandlerFailure !== null) throw rpcHandlerFailure;
          },
          10_000,
        );
        await cleanupStep("Restore synthetic availability", async () => {
          if (!realCapture) await publishAvailability(true);
        });
        await cleanupStep("Remove the owned RPC route", () =>
          page.unroute("**/__solana/rpc", holdRpc),
        );
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          primaryFailed
            ? [primaryFailure, ...cleanupFailures]
            : cleanupFailures,
          "Wager authority cleanup failed",
        );
      }
      if (primaryFailed) throw primaryFailure;
    },
  );
}

test("prediction market rebinds the same live duel after Hyperia restarts", async ({
  page,
  request,
}) => {
  test.setTimeout(900_000);
  test.skip(
    E2E_DUEL_SOURCE !== "real_hyperia",
    "Hyperia restart recovery is only meaningful in real-duel mode",
  );
  const state = await loadState();
  const control = await loadControl();
  const connection = createConfirmedConnection(
    state.solanaRpcUrl || "http://127.0.0.1:8899",
    state.solanaWsUrl,
  );
  const clobProgram = createReadonlyClobProgram(connection, state);
  const authority = loadBootstrapAuthority(state);
  const trader = new PublicKey(
    state.solanaTraderPublicKey || authority.publicKey.toBase58(),
  );
  const freshMarket = await createFreshSolanaOpenMarket(
    request,
    state,
    connection,
  );
  const userBalanceAddress = deriveUserBalancePda(
    clobProgram.programId,
    freshMarket.marketState,
    trader,
  );

  await gotoApp(page);
  await ensureWalletConnected(page);
  await page.getByTestId("refresh-market").click();
  await expect(page.getByTestId("current-match-id")).toContainText(
    freshMarket.duelId,
    {
      timeout: 60_000,
    },
  );
  await expect
    .poll(() => readText(page, "solana-clob-match"), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toContain(freshMarket.marketState.toBase58());

  await seedAskLiquidity(connection, state, freshMarket);
  runProcessControl(control, "restart", "hyperia");

  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${GAME_API_URL}/api/streaming/state`,
        );
        if (!response.ok()) {
          return { duelId: "", duelKeyHex: "" };
        }
        const payload = (await response.json()) as {
          cycle?: {
            duelId?: string | number | null;
            duelKeyHex?: string | null;
          } | null;
        };
        return {
          duelId:
            payload.cycle?.duelId != null ? String(payload.cycle.duelId) : "",
          duelKeyHex: payload.cycle?.duelKeyHex ?? "",
        };
      },
      {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toEqual({
      duelId: freshMarket.duelId,
      duelKeyHex: state.currentDuelKeyHex ?? "",
    });

  await page.reload({ waitUntil: "domcontentloaded" });
  await gotoApp(page);
  await ensureWalletConnected(page);
  await page.getByTestId("refresh-market").click();
  await expect(page.getByTestId("current-match-id")).toContainText(
    freshMarket.duelId,
    {
      timeout: 60_000,
    },
  );
  await expect
    .poll(() => readText(page, "solana-clob-match"), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toContain(freshMarket.marketState.toBase58());

  const beforeBalance = (await clobProgram.account.userBalance.fetchNullable(
    userBalanceAddress,
  )) as UserBalanceAccount | null;
  const beforeYes = bnLikeToBigInt(beforeBalance?.aShares);
  const previousOrderTx = await readText(page, "solana-clob-place-order-tx");

  await page.getByTestId("prediction-select-yes").click();
  await page
    .getByTestId("prediction-amount-input")
    .fill(state.placeBetAmount ?? "1");
  await submitSolanaOrderWithBoundedQuoteReview(page);

  await expect
    .poll(
      async () => {
        const currentTx = await readText(page, "solana-clob-place-order-tx");
        const balance = (await clobProgram.account.userBalance.fetchNullable(
          userBalanceAddress,
        )) as UserBalanceAccount | null;
        return {
          tx: currentTx,
          aShares: Number(bnLikeToBigInt(balance?.aShares) - beforeYes),
        };
      },
      {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toEqual(
      expect.objectContaining({
        tx: expect.not.stringMatching(`^${previousOrderTx}$`),
        aShares: expect.any(Number),
      }),
    );
  await expect
    .poll(
      async () => {
        const balance = (await clobProgram.account.userBalance.fetchNullable(
          userBalanceAddress,
        )) as UserBalanceAccount | null;
        return Number(bnLikeToBigInt(balance?.aShares) - beforeYes);
      },
      {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toBeGreaterThan(0);
});
