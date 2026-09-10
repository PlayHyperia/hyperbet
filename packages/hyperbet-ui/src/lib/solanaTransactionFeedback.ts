import { PublicKey } from "@solana/web3.js";

import type { SolanaCluster } from "./solanaConfig";
import { isSolanaTransactionExpiredError } from "./solanaRpc";

export type SolanaTransactionStage =
  "preparing" | "signing" | "sending" | "confirming";

export type SolanaTransactionErrorKind =
  | "QUOTE_STALE"
  | "USER_REJECTED"
  | "WALLET_INTEGRITY_FAILED"
  | "WALLET_DISCONNECTED"
  | "INSUFFICIENT_FUNDS"
  | "EXPIRED"
  | "RPC_UNAVAILABLE"
  | "SIMULATION_FAILED"
  | "ONCHAIN_FAILED"
  | "UNKNOWN";

export type SolanaTransactionRetryMode =
  "REVIEW_AND_RETRY" | "CHECK_STATUS_FIRST" | "BLOCKED";

export class SolanaTransactionFlowError extends Error {
  readonly stage: SolanaTransactionStage;
  readonly signature: string | null;

  constructor(input: {
    message: string;
    stage: SolanaTransactionStage;
    signature?: string | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "SolanaTransactionFlowError";
    this.stage = input.stage;
    this.signature = input.signature ?? null;
  }
}

export type SolanaTransactionRecovery = {
  kind: SolanaTransactionErrorKind;
  stage: SolanaTransactionStage;
  signature: string | null;
  retryMode: SolanaTransactionRetryMode;
  detail: string;
};

const SOLANA_TRANSACTION_CONTEXT_VERSION =
  "hyperbet-solana-transaction-context-v2";
const SOLANA_TRANSACTION_CLUSTERS = new Set<string>([
  "localnet",
  "devnet",
  "testnet",
  "mainnet-beta",
]);

function canonicalTransactionContextString(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : null;
}

function canonicalTransactionContextPublicKey(value: unknown): string | null {
  const normalized = canonicalTransactionContextString(value);
  if (!normalized) return null;
  try {
    return new PublicKey(normalized).toBase58() === normalized
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function canonicalTransactionContextRpcEndpoint(value: unknown): string | null {
  const normalized = canonicalTransactionContextString(value);
  if (!normalized) return null;
  try {
    const rpcUrl = new URL(normalized);
    if (
      (rpcUrl.protocol !== "http:" && rpcUrl.protocol !== "https:") ||
      rpcUrl.username ||
      rpcUrl.password ||
      rpcUrl.hash
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export function buildSolanaTransactionContextKey(input: {
  cluster: SolanaCluster;
  rpcEndpoint: string;
  fightOracleProgramId: string;
  duelMarketProgramId: string;
  walletAddress: string | null | undefined;
  duelKeyHex: string | null | undefined;
  advertisedMarketAddress: string | null | undefined;
  loadedMarketAddress: string | null | undefined;
}): string | null {
  if (!SOLANA_TRANSACTION_CLUSTERS.has(input.cluster)) return null;
  const rpcEndpoint = canonicalTransactionContextRpcEndpoint(input.rpcEndpoint);
  if (!rpcEndpoint) return null;
  const fightOracleProgramId = canonicalTransactionContextPublicKey(
    input.fightOracleProgramId,
  );
  const duelMarketProgramId = canonicalTransactionContextPublicKey(
    input.duelMarketProgramId,
  );
  const walletAddress = canonicalTransactionContextPublicKey(
    input.walletAddress,
  );
  if (!fightOracleProgramId || !duelMarketProgramId || !walletAddress) {
    return null;
  }

  const duelKeyHex =
    input.duelKeyHex === null || input.duelKeyHex === undefined
      ? null
      : typeof input.duelKeyHex === "string" &&
          /^[0-9a-fA-F]{64}$/.test(input.duelKeyHex)
        ? input.duelKeyHex.toLowerCase()
        : null;
  if (input.duelKeyHex != null && duelKeyHex === null) return null;
  const advertisedMarketAddress =
    input.advertisedMarketAddress === null ||
    input.advertisedMarketAddress === undefined
      ? null
      : canonicalTransactionContextPublicKey(input.advertisedMarketAddress);
  if (
    input.advertisedMarketAddress != null &&
    advertisedMarketAddress === null
  ) {
    return null;
  }
  const loadedMarketAddress =
    input.loadedMarketAddress === null ||
    input.loadedMarketAddress === undefined
      ? null
      : canonicalTransactionContextPublicKey(input.loadedMarketAddress);
  if (input.loadedMarketAddress != null && loadedMarketAddress === null) {
    return null;
  }

  return JSON.stringify([
    SOLANA_TRANSACTION_CONTEXT_VERSION,
    input.cluster,
    rpcEndpoint,
    fightOracleProgramId,
    duelMarketProgramId,
    walletAddress,
    duelKeyHex
      ? "duel"
      : advertisedMarketAddress || loadedMarketAddress
        ? "market"
        : "wallet",
    duelKeyHex,
    advertisedMarketAddress,
    loadedMarketAddress,
  ]);
}

export function isSolanaMarketLoadedForDuel(input: {
  loadedDuelKeyHex: string | null | undefined;
  currentDuelKeyHex: string | null | undefined;
}): boolean {
  const loadedDuelKeyHex = input.loadedDuelKeyHex?.trim().toLowerCase() ?? "";
  const currentDuelKeyHex = input.currentDuelKeyHex?.trim().toLowerCase() ?? "";
  return Boolean(
    loadedDuelKeyHex &&
    currentDuelKeyHex &&
    loadedDuelKeyHex === currentDuelKeyHex,
  );
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current instanceof Error ? current.cause : null;
  }
  return chain;
}

function errorDetail(error: unknown): string {
  const messages = errorChain(error)
    .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return messages[messages.length - 1] ?? "Unknown transaction error";
}

export function classifySolanaTransactionError(
  error: unknown,
): SolanaTransactionRecovery {
  const flowError = errorChain(error).find(
    (entry): entry is SolanaTransactionFlowError =>
      entry instanceof SolanaTransactionFlowError,
  );
  const stage = flowError?.stage ?? "preparing";
  const signature = flowError?.signature ?? null;
  const detail = errorDetail(error);
  const searchable = errorChain(error)
    .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
    .join("\n");

  if (isSolanaTransactionExpiredError(error)) {
    return {
      kind: "EXPIRED",
      stage,
      signature,
      retryMode: signature ? "CHECK_STATUS_FIRST" : "REVIEW_AND_RETRY",
      detail,
    };
  }
  if (
    stage === "preparing" &&
    !signature &&
    /(?:order book|market (?:fee snapshots?|configuration|identity)|quote).*(?:changed|stale)|(?:changed|stale).*quote/i.test(
      searchable,
    )
  ) {
    return {
      kind: "QUOTE_STALE",
      stage,
      signature,
      retryMode: "REVIEW_AND_RETRY",
      detail,
    };
  }
  if (
    /wallet transaction integrity|wallet returned a transaction without a signature/i.test(
      searchable,
    )
  ) {
    return {
      kind: "WALLET_INTEGRITY_FAILED",
      stage,
      signature,
      retryMode: "BLOCKED",
      detail,
    };
  }
  if (
    /user rejected|rejected the request|request rejected|declined|cancelled by user|canceled by user|code.?4001/i.test(
      searchable,
    )
  ) {
    return {
      kind: "USER_REJECTED",
      stage,
      signature,
      retryMode: signature ? "CHECK_STATUS_FIRST" : "REVIEW_AND_RETRY",
      detail,
    };
  }
  if (
    /wallet.*disconnect|not connected|wallet not found|missing.*wallet|public key.*missing/i.test(
      searchable,
    )
  ) {
    return {
      kind: "WALLET_DISCONNECTED",
      stage,
      signature,
      retryMode: signature ? "CHECK_STATUS_FIRST" : "REVIEW_AND_RETRY",
      detail,
    };
  }
  if (
    /insufficient funds|insufficient lamports|attempt to debit|account.*balance|0x1\b/i.test(
      searchable,
    )
  ) {
    return {
      kind: "INSUFFICIENT_FUNDS",
      stage,
      signature,
      retryMode: signature ? "CHECK_STATUS_FIRST" : "REVIEW_AND_RETRY",
      detail,
    };
  }
  if (
    /simulation failed|simulate transaction|preflight failure|transaction simulation/i.test(
      searchable,
    )
  ) {
    return {
      kind: "SIMULATION_FAILED",
      stage,
      signature,
      retryMode: signature ? "CHECK_STATUS_FIRST" : "REVIEW_AND_RETRY",
      detail,
    };
  }
  if (
    /transaction failed|instruction error|custom program error/i.test(
      searchable,
    )
  ) {
    return {
      kind: "ONCHAIN_FAILED",
      stage,
      signature,
      retryMode: "BLOCKED",
      detail,
    };
  }
  if (
    /fetch failed|failed to fetch|network error|http 429|http 5\d\d|rpc|timeout|timed out|socket|econn|service unavailable/i.test(
      searchable,
    )
  ) {
    return {
      kind: "RPC_UNAVAILABLE",
      stage,
      signature,
      retryMode:
        signature || stage === "sending" || stage === "confirming"
          ? "CHECK_STATUS_FIRST"
          : "REVIEW_AND_RETRY",
      detail,
    };
  }
  return {
    kind: "UNKNOWN",
    stage,
    signature,
    retryMode:
      signature || stage === "sending" || stage === "confirming"
        ? "CHECK_STATUS_FIRST"
        : "BLOCKED",
    detail,
  };
}

export function buildSolanaExplorerTransactionUrl(
  signature: string,
  cluster: string,
): string | null {
  const normalizedSignature = signature.trim();
  const normalizedCluster = cluster.trim().toLowerCase();
  if (!normalizedSignature || normalizedCluster === "localnet") return null;
  const query =
    normalizedCluster === "mainnet-beta"
      ? ""
      : `?cluster=${encodeURIComponent(normalizedCluster)}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(normalizedSignature)}${query}`;
}
