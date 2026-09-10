import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { useCallback, useEffect, useState } from "react";

import { GAME_API_URL, type SolanaCluster } from "./solanaConfig";
import { buildDuelCorrelationId, isDuelCorrelationId } from "./duelCorrelation";

export type SolanaBetOrderState =
  | "PENDING_INDEX"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CLOSED_PARTIAL"
  | "RELEASED"
  | "RECLAIM_REQUIRED";

export type SolanaBetSettlementState =
  | "NOT_READY"
  | "AWAITING_RESULT"
  | "PAYOUT_CLAIMABLE"
  | "REFUND_CLAIMABLE"
  | "PAID"
  | "REFUNDED"
  | "LOST"
  | "NO_ENTITLEMENT";

export type SolanaTerminalSettlementKind =
  "CLAIM_PAYOUT" | "CANCELLATION_REFUND" | "LOSER_CLEANUP";

export type SolanaSettlementHistoryEntry = {
  betId: string;
  wallet: string;
  marketPda: string;
  duelKey: string | null;
  duelId: string | null;
  correlationId: string | null;
  placeSignature: string;
  recordedAt: number;
  orderId: string;
  side: 1 | 2;
  limitPrice: number;
  orderAmountUnits: string;
  matchedAmountUnits: string;
  restingAmountUnits: string;
  releasedAmountUnits: string;
  sourceAmountLamports: string;
  collateralLamports: string;
  executedCostLamports: string;
  tradeFeeLamports: string;
  orderRefundLamports: string;
  rewardEligibleLamports: string;
  marketStatus: "open" | "locked" | "resolved" | "cancelled" | null;
  winner: "none" | "a" | "b" | null;
  orderState: SolanaBetOrderState;
  settlementState: SolanaBetSettlementState;
  terminalKind: SolanaTerminalSettlementKind | null;
  terminalStatus: "resolved" | "cancelled" | null;
  terminalWinner: "none" | "a" | "b" | null;
  claimSignature: string | null;
  terminalGrossLamports: string;
  terminalPayoutLamports: string;
  terminalFeeLamports: string;
  reconciledAt: number | null;
  settledAt: number | null;
};

export type SolanaSettlementLedgerStatus = {
  current: boolean;
  lastIndexedAt: number | null;
  degradedReason: string | null;
};

export type SolanaSettlementHistoryResponse = {
  schemaVersion: 2;
  chain: "SOLANA";
  asset: "SOL";
  decimals: 9;
  cluster: SolanaCluster;
  programId: string;
  wallet: string;
  entries: SolanaSettlementHistoryEntry[];
  total: number;
  limit: number;
  offset: number;
  ledger: SolanaSettlementLedgerStatus;
  updatedAt: number;
};

const ORDER_STATES = new Set<SolanaBetOrderState>([
  "PENDING_INDEX",
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CLOSED_PARTIAL",
  "RELEASED",
  "RECLAIM_REQUIRED",
]);
const SETTLEMENT_STATES = new Set<SolanaBetSettlementState>([
  "NOT_READY",
  "AWAITING_RESULT",
  "PAYOUT_CLAIMABLE",
  "REFUND_CLAIMABLE",
  "PAID",
  "REFUNDED",
  "LOST",
  "NO_ENTITLEMENT",
]);
const MARKET_STATES = new Set(["open", "locked", "resolved", "cancelled"]);
const WINNERS = new Set(["none", "a", "b"]);
const TERMINAL_KINDS = new Set<SolanaTerminalSettlementKind>([
  "CLAIM_PAYOUT",
  "CANCELLATION_REFUND",
  "LOSER_CLEANUP",
]);
const TERMINAL_MARKET_STATES = new Set(["resolved", "cancelled"]);
const POLL_INTERVAL_MS = 5_000;
const SETTLEMENT_HISTORY_MAX_FRESHNESS_MS = 30_000;
const U64_MAX = 18_446_744_073_709_551_615n;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value
    ? value
    : null;
}

function canonicalPublicKey(value: unknown): string | null {
  const normalized = nonEmptyString(value);
  if (!normalized) return null;
  try {
    return new PublicKey(normalized).toBase58() === normalized
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function canonicalCluster(value: unknown): SolanaCluster | null {
  return value === "localnet" ||
    value === "devnet" ||
    value === "testnet" ||
    value === "mainnet-beta"
    ? value
    : null;
}

function canonicalTransactionSignature(value: unknown): string | null {
  const normalized = nonEmptyString(value);
  if (!normalized) return null;
  try {
    const decoded = bs58.decode(normalized);
    return decoded.length === 64 && bs58.encode(decoded) === normalized
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null {
  return value === null ? null : nonEmptyString(value);
}

function unsignedString(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 20 ||
    BigInt(value) > U64_MAX
  ) {
    return null;
  }
  return value;
}

function safeInteger(value: unknown, minimum = 0): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum
    ? Number(value)
    : null;
}

function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = safeInteger(value);
  return parsed === null ? undefined : parsed;
}

function quoteCostLamports(
  side: 1 | 2,
  price: number,
  amount: bigint,
): bigint | null {
  const numerator = amount * BigInt(side === 1 ? price : 1_000 - price);
  return numerator % 1_000n === 0n ? numerator / 1_000n : null;
}

function expectedOrderState(input: {
  indexed: boolean;
  marketStatus: SolanaSettlementHistoryEntry["marketStatus"];
  orderAmount: bigint;
  matched: bigint;
  resting: bigint;
  released: bigint;
}): SolanaBetOrderState | null {
  if (!input.indexed) return "PENDING_INDEX";
  if (
    input.resting > 0n &&
    input.marketStatus !== null &&
    input.marketStatus !== "open"
  ) {
    return "RECLAIM_REQUIRED";
  }
  if (input.resting > 0n) {
    return input.matched > 0n ? "PARTIALLY_FILLED" : "OPEN";
  }
  if (input.matched === input.orderAmount) return "FILLED";
  if (input.matched > 0n) return "CLOSED_PARTIAL";
  if (input.released === input.orderAmount) return "RELEASED";
  return null;
}

function marketLifecycleIsValid(
  marketStatus: SolanaSettlementHistoryEntry["marketStatus"],
  winner: SolanaSettlementHistoryEntry["winner"],
): boolean {
  if (marketStatus === null) return winner === null;
  if (marketStatus === "resolved") return winner === "a" || winner === "b";
  return winner === "none";
}

function expectedSettlementState(input: {
  terminalKind: SolanaTerminalSettlementKind | null;
  terminalStatus: "resolved" | "cancelled" | null;
  terminalWinner: SolanaSettlementHistoryEntry["winner"];
  claimSignature: string | null;
  settledAt: number | null;
  terminalGross: bigint;
  terminalPayout: bigint;
  terminalFee: bigint;
  marketStatus: SolanaSettlementHistoryEntry["marketStatus"];
  winner: SolanaSettlementHistoryEntry["winner"];
  side: 1 | 2;
  matched: bigint;
  executedCost: bigint;
  rewardEligible: bigint;
}): SolanaBetSettlementState | null {
  if (input.terminalKind !== null) {
    if (
      input.terminalStatus === null ||
      input.terminalWinner === null ||
      input.claimSignature === null ||
      input.settledAt === null ||
      input.terminalGross !== input.terminalPayout + input.terminalFee ||
      (input.marketStatus !== null &&
        (input.marketStatus !== input.terminalStatus ||
          input.winner !== input.terminalWinner))
    ) {
      return null;
    }
    if (input.terminalKind === "CLAIM_PAYOUT") {
      const won =
        (input.terminalWinner === "a" && input.side === 1) ||
        (input.terminalWinner === "b" && input.side === 2);
      if (
        input.terminalStatus !== "resolved" ||
        (input.terminalWinner !== "a" && input.terminalWinner !== "b") ||
        input.terminalGross !== (won ? input.matched : 0n)
      ) {
        return null;
      }
      return input.terminalGross > 0n ? "PAID" : "LOST";
    }
    if (input.terminalKind === "LOSER_CLEANUP") {
      const lost =
        (input.terminalWinner === "a" && input.side === 2) ||
        (input.terminalWinner === "b" && input.side === 1);
      if (
        input.terminalStatus !== "resolved" ||
        (input.terminalWinner !== "a" && input.terminalWinner !== "b") ||
        !lost ||
        input.matched <= 0n ||
        input.terminalGross !== 0n ||
        input.terminalPayout !== 0n ||
        input.terminalFee !== 0n
      ) {
        return null;
      }
      return "LOST";
    }
    if (
      input.terminalStatus !== "cancelled" ||
      input.terminalWinner !== "none" ||
      input.terminalGross !== input.rewardEligible
    ) {
      return null;
    }
    return "REFUNDED";
  }
  if (
    input.terminalStatus !== null ||
    input.terminalWinner !== null ||
    input.claimSignature !== null ||
    input.settledAt !== null ||
    input.terminalGross !== 0n ||
    input.terminalPayout !== 0n ||
    input.terminalFee !== 0n
  ) {
    return null;
  }
  if (input.marketStatus === "resolved") {
    if (input.matched === 0n) return "NO_ENTITLEMENT";
    const won =
      (input.winner === "a" && input.side === 1) ||
      (input.winner === "b" && input.side === 2);
    return won ? "PAYOUT_CLAIMABLE" : "LOST";
  }
  if (input.marketStatus === "cancelled") {
    return input.executedCost > 0n ? "REFUND_CLAIMABLE" : "NO_ENTITLEMENT";
  }
  if (input.marketStatus === "locked" && input.matched > 0n) {
    return "AWAITING_RESULT";
  }
  return "NOT_READY";
}

function parseEntry(value: unknown): SolanaSettlementHistoryEntry | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const strings = {
    betId: nonEmptyString(entry.betId),
    wallet: canonicalPublicKey(entry.wallet),
    marketPda: canonicalPublicKey(entry.marketPda),
    placeSignature: canonicalTransactionSignature(entry.placeSignature),
    orderId: unsignedString(entry.orderId),
    orderAmountUnits: unsignedString(entry.orderAmountUnits),
    matchedAmountUnits: unsignedString(entry.matchedAmountUnits),
    restingAmountUnits: unsignedString(entry.restingAmountUnits),
    releasedAmountUnits: unsignedString(entry.releasedAmountUnits),
    sourceAmountLamports: unsignedString(entry.sourceAmountLamports),
    collateralLamports: unsignedString(entry.collateralLamports),
    executedCostLamports: unsignedString(entry.executedCostLamports),
    tradeFeeLamports: unsignedString(entry.tradeFeeLamports),
    orderRefundLamports: unsignedString(entry.orderRefundLamports),
    rewardEligibleLamports: unsignedString(entry.rewardEligibleLamports),
    terminalGrossLamports: unsignedString(entry.terminalGrossLamports),
    terminalPayoutLamports: unsignedString(entry.terminalPayoutLamports),
    terminalFeeLamports: unsignedString(entry.terminalFeeLamports),
  };
  if (Object.values(strings).some((item) => item === null)) return null;
  const side = entry.side === 1 || entry.side === 2 ? entry.side : null;
  const limitPrice = safeInteger(entry.limitPrice, 1);
  const recordedAt = safeInteger(entry.recordedAt);
  const reconciledAt = optionalTimestamp(entry.reconciledAt);
  const settledAt = optionalTimestamp(entry.settledAt);
  const orderState = ORDER_STATES.has(entry.orderState as SolanaBetOrderState)
    ? (entry.orderState as SolanaBetOrderState)
    : null;
  const settlementState = SETTLEMENT_STATES.has(
    entry.settlementState as SolanaBetSettlementState,
  )
    ? (entry.settlementState as SolanaBetSettlementState)
    : null;
  const marketStatus =
    entry.marketStatus === null
      ? null
      : MARKET_STATES.has(String(entry.marketStatus))
        ? (entry.marketStatus as SolanaSettlementHistoryEntry["marketStatus"])
        : undefined;
  const winner =
    entry.winner === null
      ? null
      : WINNERS.has(String(entry.winner))
        ? (entry.winner as SolanaSettlementHistoryEntry["winner"])
        : undefined;
  const terminalKind =
    entry.terminalKind === null
      ? null
      : TERMINAL_KINDS.has(entry.terminalKind as SolanaTerminalSettlementKind)
        ? (entry.terminalKind as SolanaTerminalSettlementKind)
        : undefined;
  const terminalStatus =
    entry.terminalStatus === null
      ? null
      : TERMINAL_MARKET_STATES.has(String(entry.terminalStatus))
        ? (entry.terminalStatus as "resolved" | "cancelled")
        : undefined;
  const terminalWinner =
    entry.terminalWinner === null
      ? null
      : WINNERS.has(String(entry.terminalWinner))
        ? (entry.terminalWinner as SolanaSettlementHistoryEntry["winner"])
        : undefined;
  const claimSignature =
    entry.claimSignature === null
      ? null
      : canonicalTransactionSignature(entry.claimSignature);
  const duelKey = optionalString(entry.duelKey);
  const duelId = optionalString(entry.duelId);
  const correlationId = optionalString(entry.correlationId);
  let expectedCorrelationId: string | null = null;
  if (duelKey !== null && duelId !== null) {
    try {
      expectedCorrelationId = buildDuelCorrelationId({ duelId, duelKey });
    } catch {
      return null;
    }
  }
  if (
    side === null ||
    limitPrice === null ||
    limitPrice >= 1_000 ||
    recordedAt === null ||
    reconciledAt === undefined ||
    settledAt === undefined ||
    !orderState ||
    !settlementState ||
    marketStatus === undefined ||
    winner === undefined ||
    terminalKind === undefined ||
    terminalStatus === undefined ||
    terminalWinner === undefined ||
    (entry.claimSignature !== null && claimSignature === null) ||
    (entry.duelKey !== null && duelKey === null) ||
    (entry.duelId !== null && duelId === null) ||
    (entry.correlationId !== null && correlationId === null) ||
    (duelKey === null) !== (duelId === null) ||
    (correlationId === null) !== (duelId === null) ||
    (correlationId !== null && !isDuelCorrelationId(correlationId)) ||
    correlationId !== expectedCorrelationId
  ) {
    return null;
  }
  const orderAmount = BigInt(strings.orderAmountUnits!);
  const matched = BigInt(strings.matchedAmountUnits!);
  const resting = BigInt(strings.restingAmountUnits!);
  const released = BigInt(strings.releasedAmountUnits!);
  const sourceAmount = BigInt(strings.sourceAmountLamports!);
  const collateral = BigInt(strings.collateralLamports!);
  const executed = BigInt(strings.executedCostLamports!);
  const tradeFee = BigInt(strings.tradeFeeLamports!);
  const rewardEligible = BigInt(strings.rewardEligibleLamports!);
  const terminalGross = BigInt(strings.terminalGrossLamports!);
  const terminalPayout = BigInt(strings.terminalPayoutLamports!);
  const terminalFee = BigInt(strings.terminalFeeLamports!);
  const signedLimitCost = quoteCostLamports(side, limitPrice, orderAmount);
  const derivedOrderState = expectedOrderState({
    indexed: reconciledAt !== null,
    marketStatus,
    orderAmount,
    matched,
    resting,
    released,
  });
  const derivedSettlementState = expectedSettlementState({
    terminalKind,
    terminalStatus,
    terminalWinner,
    claimSignature,
    settledAt,
    terminalGross,
    terminalPayout,
    terminalFee,
    marketStatus,
    winner,
    side,
    matched,
    executedCost: executed,
    rewardEligible,
  });
  if (
    orderAmount <= 0n ||
    matched + resting + released !== orderAmount ||
    signedLimitCost === null ||
    signedLimitCost <= 0n ||
    collateral > signedLimitCost ||
    sourceAmount !== collateral + tradeFee ||
    executed + tradeFee !== rewardEligible ||
    terminalPayout + terminalFee !== terminalGross ||
    !marketLifecycleIsValid(marketStatus, winner) ||
    derivedOrderState === null ||
    orderState !== derivedOrderState ||
    derivedSettlementState === null ||
    settlementState !== derivedSettlementState ||
    (reconciledAt === null &&
      BigInt(strings.orderRefundLamports!) !== signedLimitCost - collateral)
  ) {
    return null;
  }
  return {
    ...(strings as Record<keyof typeof strings, string>),
    duelKey,
    duelId,
    correlationId,
    recordedAt,
    side,
    limitPrice,
    marketStatus,
    winner,
    orderState,
    settlementState,
    terminalKind,
    terminalStatus,
    terminalWinner,
    claimSignature,
    reconciledAt,
    settledAt,
  };
}

export function parseSolanaSettlementHistoryResponse(
  payload: unknown,
): SolanaSettlementHistoryResponse | null {
  const response = asRecord(payload);
  const ledger = asRecord(response?.ledger);
  if (
    !response ||
    !ledger ||
    response.schemaVersion !== 2 ||
    response.chain !== "SOLANA" ||
    response.asset !== "SOL" ||
    response.decimals !== 9 ||
    !Array.isArray(response.entries)
  ) {
    return null;
  }
  const cluster = canonicalCluster(response.cluster);
  const programId = canonicalPublicKey(response.programId);
  const wallet = canonicalPublicKey(response.wallet);
  const total = safeInteger(response.total);
  const limit = safeInteger(response.limit, 1);
  const offset = safeInteger(response.offset);
  const updatedAt = safeInteger(response.updatedAt);
  const lastIndexedAt = optionalTimestamp(ledger.lastIndexedAt);
  const degradedReason = optionalString(ledger.degradedReason);
  const entries = response.entries.map(parseEntry);
  const validEntries = entries.filter(
    (entry): entry is SolanaSettlementHistoryEntry => entry !== null,
  );
  const uniqueBetIds = new Set(validEntries.map((entry) => entry.betId));
  if (
    !cluster ||
    !programId ||
    !wallet ||
    typeof ledger.current !== "boolean" ||
    total === null ||
    limit === null ||
    limit > 100 ||
    offset === null ||
    updatedAt === null ||
    lastIndexedAt === undefined ||
    (ledger.degradedReason !== null && degradedReason === null) ||
    (ledger.current === true
      ? lastIndexedAt === null || degradedReason !== null
      : degradedReason === null) ||
    (lastIndexedAt !== null && lastIndexedAt > updatedAt) ||
    entries.some((entry) => entry === null) ||
    validEntries.some((entry) => entry.wallet !== wallet) ||
    uniqueBetIds.size !== validEntries.length ||
    entries.length > limit ||
    total < entries.length ||
    (entries.length > 0 && offset + entries.length > total) ||
    validEntries.some(
      (entry) =>
        entry.recordedAt > updatedAt ||
        (entry.reconciledAt !== null &&
          (entry.reconciledAt < entry.recordedAt ||
            entry.reconciledAt > updatedAt)) ||
        (entry.settledAt !== null &&
          (entry.settledAt < entry.recordedAt ||
            entry.settledAt > updatedAt ||
            (entry.reconciledAt !== null &&
              entry.settledAt < entry.reconciledAt))),
    )
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    chain: "SOLANA",
    asset: "SOL",
    decimals: 9,
    cluster,
    programId,
    wallet,
    entries: validEntries,
    total,
    limit,
    offset,
    ledger: {
      current: ledger.current === true,
      lastIndexedAt,
      degradedReason,
    },
    updatedAt,
  };
}

export function mergeSolanaSettlementHistoryPages(
  pages: SolanaSettlementHistoryResponse[],
  requestedCount: number,
): SolanaSettlementHistoryResponse | null {
  const first = pages[0];
  if (
    !first ||
    first.offset !== 0 ||
    !Number.isSafeInteger(requestedCount) ||
    requestedCount < 1
  ) {
    return null;
  }
  const entries: SolanaSettlementHistoryEntry[] = [];
  const betIds = new Set<string>();
  let expectedOffset = 0;
  let previousUpdatedAt = first.updatedAt;
  for (const [index, page] of pages.entries()) {
    if (
      page.wallet !== first.wallet ||
      page.total !== first.total ||
      page.offset !== expectedOffset ||
      page.schemaVersion !== first.schemaVersion ||
      page.chain !== first.chain ||
      page.asset !== first.asset ||
      page.decimals !== first.decimals ||
      page.cluster !== first.cluster ||
      page.programId !== first.programId ||
      page.ledger.current !== first.ledger.current ||
      page.ledger.lastIndexedAt !== first.ledger.lastIndexedAt ||
      page.ledger.degradedReason !== first.ledger.degradedReason ||
      page.updatedAt < previousUpdatedAt ||
      page.updatedAt - first.updatedAt > POLL_INTERVAL_MS ||
      (index < pages.length - 1 && page.entries.length === 0)
    ) {
      return null;
    }
    for (const entry of page.entries) {
      if (betIds.has(entry.betId)) return null;
      betIds.add(entry.betId);
      entries.push(entry);
    }
    expectedOffset += page.entries.length;
    previousUpdatedAt = page.updatedAt;
  }
  if (entries.length > requestedCount || entries.length > first.total) {
    return null;
  }
  return {
    ...first,
    entries,
    limit: requestedCount,
    offset: 0,
  };
}

function settlementHistoryResponseIsFresh(
  response: SolanaSettlementHistoryResponse,
  observedAt: number,
): boolean {
  const lastIndexedAt = response.ledger.lastIndexedAt;
  return (
    Math.abs(response.updatedAt - observedAt) <=
      SETTLEMENT_HISTORY_MAX_FRESHNESS_MS &&
    (!response.ledger.current ||
      (lastIndexedAt !== null &&
        lastIndexedAt >= observedAt - SETTLEMENT_HISTORY_MAX_FRESHNESS_MS))
  );
}

export async function fetchSolanaSettlementHistory(input: {
  cluster: SolanaCluster;
  programId: string;
  wallet: string;
  marketPda?: string | null;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<SolanaSettlementHistoryResponse> {
  const base = GAME_API_URL.replace(/\/$/, "");
  const cluster = canonicalCluster(input.cluster);
  const programId = canonicalPublicKey(input.programId);
  const wallet = canonicalPublicKey(input.wallet);
  const marketPda =
    input.marketPda === undefined || input.marketPda === null
      ? null
      : canonicalPublicKey(input.marketPda);
  const limit = input.limit ?? 5;
  const offset = input.offset ?? 0;
  if (
    cluster === null ||
    programId === null ||
    wallet === null ||
    (input.marketPda !== undefined &&
      input.marketPda !== null &&
      marketPda === null)
  ) {
    throw new Error("settlement history identity was invalid");
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10_000
  ) {
    throw new Error("settlement history pagination was invalid");
  }
  const params = new URLSearchParams();
  if (marketPda) params.set("marketPda", marketPda);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const endpoint = `${base}/api/arena/settlements/${encodeURIComponent(
    wallet,
  )}?${params.toString()}`;
  const response = await fetch(endpoint, {
    cache: "no-store",
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`settlement history request failed (${response.status})`);
  }
  const parsed = parseSolanaSettlementHistoryResponse(await response.json());
  if (
    !parsed ||
    !settlementHistoryResponseIsFresh(parsed, Date.now()) ||
    parsed.cluster !== cluster ||
    parsed.programId !== programId ||
    parsed.wallet !== wallet ||
    parsed.limit !== limit ||
    parsed.offset !== offset ||
    (marketPda !== null &&
      parsed.entries.some((entry) => entry.marketPda !== marketPda))
  ) {
    throw new Error("settlement history response was invalid");
  }
  return parsed;
}

export function useSolanaSettlementHistory(input: {
  cluster: SolanaCluster;
  programId: string;
  wallet: string | null;
  marketPda?: string | null;
  limit?: number;
}): {
  history: SolanaSettlementHistoryResponse | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  refresh: () => void;
  loadMore: () => void;
} {
  const pageSize = Math.min(100, Math.max(1, input.limit ?? 5));
  const requestKey = `${input.cluster}:${input.programId}:${input.wallet ?? ""}:${input.marketPda ?? ""}:${pageSize}`;
  const [historyState, setHistoryState] = useState<{
    key: string;
    history: SolanaSettlementHistoryResponse;
  } | null>(null);
  const history =
    historyState?.key === requestKey ? historyState.history : null;
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [requestedCountState, setRequestedCountState] = useState({
    key: requestKey,
    count: pageSize,
  });
  const requestedCount =
    requestedCountState.key === requestKey
      ? requestedCountState.count
      : pageSize;
  const refresh = useCallback(
    () => setRefreshVersion((value) => value + 1),
    [],
  );
  const loadMore = useCallback(() => {
    setRequestedCountState((current) => ({
      key: requestKey,
      count:
        current.key === requestKey ? current.count + pageSize : pageSize * 2,
    }));
  }, [pageSize, requestKey]);

  useEffect(() => {
    if (!input.wallet) {
      setHistoryState(null);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      return undefined;
    }
    let active = true;
    let controller: AbortController | null = null;
    let firstPoll = true;
    const poll = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      if (firstPoll) {
        setLoading(true);
        setLoadingMore(true);
      }
      try {
        const pages: SolanaSettlementHistoryResponse[] = [];
        let offset = 0;
        while (offset < requestedCount) {
          const next = await fetchSolanaSettlementHistory({
            cluster: input.cluster,
            programId: input.programId,
            wallet: input.wallet!,
            marketPda: input.marketPda,
            limit: Math.min(100, requestedCount - offset),
            offset,
            signal: requestController.signal,
          });
          pages.push(next);
          offset += next.entries.length;
          if (next.entries.length === 0 || offset >= next.total) break;
        }
        if (!active) return;
        const merged = mergeSolanaSettlementHistoryPages(pages, requestedCount);
        if (!merged) {
          throw new Error("Settlement history pages were contradictory");
        }
        setHistoryState({
          key: requestKey,
          history: merged,
        });
        setError(null);
      } catch (caught) {
        if (!active || requestController.signal.aborted) return;
        setHistoryState((current) =>
          current?.key === requestKey
            ? {
                ...current,
                history: {
                  ...current.history,
                  ledger: {
                    ...current.history.ledger,
                    current: false,
                    degradedReason:
                      "Settlement history requires fresh verification",
                  },
                },
              }
            : current,
        );
        setError(
          caught instanceof Error
            ? caught.message
            : "Settlement history failed",
        );
      } finally {
        if (active && firstPoll) {
          setLoading(false);
          setLoadingMore(false);
        }
        firstPoll = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [
    input.cluster,
    input.marketPda,
    input.programId,
    input.wallet,
    refreshVersion,
    requestKey,
    requestedCount,
  ]);

  return {
    history,
    loading,
    loadingMore,
    hasMore: history !== null && history.entries.length < history.total,
    error,
    refresh,
    loadMore,
  };
}
