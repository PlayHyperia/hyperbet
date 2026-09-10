import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as anchor from "@coral-xyz/anchor";

function expandHome(filePath: string): string {
  if (!filePath.startsWith("~/")) return filePath;
  return path.join(os.homedir(), filePath.slice(2));
}

function resolveAnchorWalletPath(): string {
  const candidates = [
    process.env.ANCHOR_WALLET,
    "~/.config/solana/hyperia-keys/deployer.json",
    "~/.config/solana/id.json",
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => expandHome(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.join(os.homedir(), ".config/solana/id.json");
}

const DEFAULT_COMMITMENT: anchor.web3.Commitment = "confirmed";
const CONFIRM_TIMEOUT_MS = 120_000;
const RPC_CALL_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRpcCallTimeout<T>(
  operation: string,
  promise: Promise<T>,
  timeoutMs = RPC_CALL_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(`${operation} did not return within ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function resolveAnchorWsUrl(providerUrl: string): string {
  if (process.env.ANCHOR_WS_URL) {
    return process.env.ANCHOR_WS_URL;
  }

  const parsed = new URL(providerUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.port = String(Number(parsed.port || "8899") + 1);
  return parsed.toString();
}

export async function getLatestBlockhashWithRetries(
  connection: anchor.web3.Connection,
  commitment: anchor.web3.Commitment = DEFAULT_COMMITMENT,
  maxAttempts = 16,
): Promise<anchor.web3.BlockhashWithExpiryBlockHeight> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withRpcCallTimeout(
        "getLatestBlockhash",
        connection.getLatestBlockhash(commitment),
      );
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(Math.min(2_000, 250 * attempt));
      }
    }
  }

  throw new Error(
    `failed to fetch latest blockhash after ${maxAttempts} attempts: ${String(lastError)}`,
  );
}

export async function confirmSignatureByPolling(
  connection: anchor.web3.Connection,
  signature: string,
  lastValidBlockHeight?: number,
  timeoutMs = CONFIRM_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastRpcError: unknown = null;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount += 1;
    try {
      const statuses = await withRpcCallTimeout(
        "getSignatureStatuses",
        connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        }),
      );
      const status = statuses.value[0];

      if (status?.err) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        );
      }

      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      ) {
        return;
      }

      if (lastValidBlockHeight && pollCount % 8 === 0) {
        const currentBlockHeight = await withRpcCallTimeout(
          "getBlockHeight",
          connection.getBlockHeight(DEFAULT_COMMITMENT),
        );
        if (currentBlockHeight > lastValidBlockHeight) {
          throw new Error(
            `transaction ${signature} expired at block height ${lastValidBlockHeight}`,
          );
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes(`transaction ${signature} failed`) ||
          error.message.includes("expired at block height"))
      ) {
        throw error;
      }
      lastRpcError = error;
    }

    await sleep(250);
  }

  const reason =
    lastRpcError instanceof Error ? ` (${lastRpcError.message})` : "";
  throw new Error(
    `timed out waiting for confirmation for ${signature}${reason}`,
  );
}

function cloneTransaction(
  transaction: anchor.web3.Transaction,
): anchor.web3.Transaction {
  const clone = new anchor.web3.Transaction();
  clone.instructions = [...transaction.instructions];
  clone.feePayer = transaction.feePayer;
  clone.nonceInfo = transaction.nonceInfo;
  clone.minNonceContextSlot = transaction.minNonceContextSlot;
  return clone;
}

async function sendAndConfirmWithPolling(
  provider: anchor.AnchorProvider,
  transaction: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = [],
  options?: anchor.web3.ConfirmOptions,
): Promise<string> {
  const opts = {
    ...provider.opts,
    ...options,
  };
  const commitment =
    opts.preflightCommitment || opts.commitment || DEFAULT_COMMITMENT;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const tx = cloneTransaction(transaction);
      tx.feePayer = tx.feePayer ?? provider.wallet.publicKey;

      const { blockhash, lastValidBlockHeight } =
        await getLatestBlockhashWithRetries(provider.connection, commitment);
      tx.recentBlockhash = blockhash;

      if (signers.length > 0) {
        tx.partialSign(...signers);
      }

      const signedTx = await provider.wallet.signTransaction(tx);
      const signature = await withRpcCallTimeout(
        "sendRawTransaction",
        provider.connection.sendRawTransaction(signedTx.serialize(), {
          maxRetries: 8,
          preflightCommitment: commitment,
          skipPreflight: opts.skipPreflight ?? false,
        }),
      );

      await confirmSignatureByPolling(
        provider.connection,
        signature,
        lastValidBlockHeight,
      );
      return signature;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(250 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function uniquePubkeys(
  pubkeys: anchor.web3.PublicKey[],
): anchor.web3.PublicKey[] {
  const seen = new Set<string>();
  const unique: anchor.web3.PublicKey[] = [];
  for (const pubkey of pubkeys) {
    const key = pubkey.toBase58();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(pubkey);
  }
  return unique;
}

function chunkPubkeys(
  pubkeys: anchor.web3.PublicKey[],
  size: number,
): anchor.web3.PublicKey[][] {
  const chunks: anchor.web3.PublicKey[][] = [];
  for (let index = 0; index < pubkeys.length; index += size) {
    chunks.push(pubkeys.slice(index, index + size));
  }
  return chunks;
}

export async function sendVersionedTransactionWithLookupTable(
  provider: anchor.AnchorProvider,
  instructions: anchor.web3.TransactionInstruction[],
  signers: anchor.web3.Signer[] = [],
  options?: anchor.web3.ConfirmOptions,
): Promise<string> {
  const wallet = provider.wallet as anchor.Wallet & {
    payer?: anchor.web3.Keypair;
  };
  if (!wallet.payer) {
    throw new Error(
      "Anchor wallet does not expose a payer for v0 transactions",
    );
  }

  const lookupTableAddresses = uniquePubkeys(
    instructions.flatMap((instruction) =>
      instruction.keys
        .filter((accountMeta) => !accountMeta.isSigner)
        .map((accountMeta) => accountMeta.pubkey),
    ),
  ).filter((pubkey) => !pubkey.equals(wallet.publicKey));

  const recentSlot = await withRpcCallTimeout(
    "getSlot for lookup-table creation",
    provider.connection.getSlot(DEFAULT_COMMITMENT),
  );
  let lastLookupMutationSlot = recentSlot;
  const [createLookupTableIx, lookupTableAddress] =
    anchor.web3.AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      recentSlot,
    });
  await sendAndConfirmWithPolling(
    provider,
    new anchor.web3.Transaction().add(createLookupTableIx),
    [],
    options,
  );

  for (const addressChunk of chunkPubkeys(lookupTableAddresses, 20)) {
    if (addressChunk.length === 0) {
      continue;
    }
    await sendAndConfirmWithPolling(
      provider,
      new anchor.web3.Transaction().add(
        anchor.web3.AddressLookupTableProgram.extendLookupTable({
          payer: wallet.publicKey,
          authority: wallet.publicKey,
          lookupTable: lookupTableAddress,
          addresses: addressChunk,
        }),
      ),
      [],
      options,
    );
    lastLookupMutationSlot = await withRpcCallTimeout(
      "getSlot after lookup-table extension",
      provider.connection.getSlot(DEFAULT_COMMITMENT),
    );
  }

  // Newly extended lookup table entries only become usable in a later bank slot.
  const waitForSlot = async (minimumSlotExclusive: number): Promise<void> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const currentSlot = await withRpcCallTimeout(
        "getSlot while activating lookup table",
        provider.connection.getSlot(DEFAULT_COMMITMENT),
      );
      if (currentSlot > minimumSlotExclusive) {
        return;
      }
      await sleep(250);
    }
    throw new Error(
      `lookup table ${lookupTableAddress.toBase58()} did not advance past slot ${minimumSlotExclusive}`,
    );
  };
  await waitForSlot(lastLookupMutationSlot);

  const lookupTableAccount = (
    await withRpcCallTimeout(
      "getAddressLookupTable",
      provider.connection.getAddressLookupTable(lookupTableAddress),
    )
  ).value;
  if (!lookupTableAccount) {
    throw new Error(
      `Failed to fetch lookup table account ${lookupTableAddress.toBase58()}`,
    );
  }

  const opts = {
    ...provider.opts,
    ...options,
  };
  const commitment =
    opts.preflightCommitment || opts.commitment || DEFAULT_COMMITMENT;
  const versionedInstructions = [
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    }),
    ...instructions,
  ];
  const allSigners = [wallet.payer, ...signers].filter(
    (signer, index, collection) =>
      collection.findIndex((candidate) =>
        candidate.publicKey.equals(signer.publicKey),
      ) === index,
  );
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const { blockhash, lastValidBlockHeight } =
        await getLatestBlockhashWithRetries(provider.connection, commitment);
      const message = new anchor.web3.TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: versionedInstructions,
      }).compileToV0Message([lookupTableAccount]);
      const transaction = new anchor.web3.VersionedTransaction(message);
      transaction.sign(allSigners);

      const signature = await withRpcCallTimeout(
        "sendRawTransaction for lookup-table transaction",
        provider.connection.sendRawTransaction(transaction.serialize(), {
          maxRetries: 32,
          preflightCommitment: commitment,
          skipPreflight: opts.skipPreflight ?? false,
        }),
      );
      await confirmSignatureByPolling(
        provider.connection,
        signature,
        lastValidBlockHeight,
      );
      return signature;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(250 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function sendVersionedTransactionWithPolling(
  provider: anchor.AnchorProvider,
  transaction: anchor.web3.VersionedTransaction,
  signers: anchor.web3.Signer[] = [],
  options?: anchor.web3.ConfirmOptions,
): Promise<string> {
  const opts = {
    ...provider.opts,
    ...options,
  };
  const commitment =
    opts.preflightCommitment || opts.commitment || DEFAULT_COMMITMENT;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      if (signers.length > 0) {
        transaction.sign(signers);
      }
      const signedTx = await provider.wallet.signTransaction(transaction);
      const signature = await withRpcCallTimeout(
        "sendRawVersionedTransaction",
        provider.connection.sendRawTransaction(signedTx.serialize(), {
          maxRetries: 8,
          preflightCommitment: commitment,
          skipPreflight: opts.skipPreflight ?? false,
        }),
      );
      await confirmSignatureByPolling(provider.connection, signature);
      return signature;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(250 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function createPollingProvider(
  connection: anchor.web3.Connection,
  wallet: ConstructorParameters<typeof anchor.AnchorProvider>[1],
  options?: Partial<anchor.AnchorProvider["opts"]>,
): anchor.AnchorProvider {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: DEFAULT_COMMITMENT,
    preflightCommitment: DEFAULT_COMMITMENT,
    ...(options ?? {}),
  });
  provider.sendAndConfirm = async (tx, signers, overrideOptions) => {
    if (tx instanceof anchor.web3.VersionedTransaction) {
      return sendVersionedTransactionWithPolling(
        provider,
        tx,
        signers ?? [],
        overrideOptions,
      );
    }
    return sendAndConfirmWithPolling(
      provider,
      tx,
      signers ?? [],
      overrideOptions,
    );
  };
  return provider;
}

export function configureAnchorTests(): anchor.AnchorProvider {
  process.env.ANCHOR_WALLET = resolveAnchorWalletPath();
  const providerUrl =
    process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  process.env.ANCHOR_PROVIDER_URL = providerUrl;
  process.env.ANCHOR_WS_URL = resolveAnchorWsUrl(providerUrl);

  const envProvider = anchor.AnchorProvider.env();
  const connection = new anchor.web3.Connection(providerUrl, {
    commitment: DEFAULT_COMMITMENT,
    confirmTransactionInitialTimeout: CONFIRM_TIMEOUT_MS,
    wsEndpoint: process.env.ANCHOR_WS_URL,
  });
  const provider = createPollingProvider(connection, envProvider.wallet, {
    ...envProvider.opts,
  });
  anchor.setProvider(provider);
  return provider;
}
