import { useEffect, useState, type CSSProperties } from "react";
import {
  getLocaleTag,
  resolveUiLocale,
  type UiLocale,
} from "@hyperbet/ui/i18n";

import { SOLANA_CLUSTER } from "../lib/solanaConfig";
import {
  HYPERBET_MARKET_REFRESH_EVENT,
  parseHyperbetConfirmedSettlementRefresh,
  type HyperbetConfirmedSettlementRefresh,
} from "../lib/marketRefresh";
import { buildSolanaExplorerTransactionUrl } from "../lib/solanaTransactionFeedback";
import {
  type SolanaBetOrderState,
  type SolanaBetSettlementState,
  type SolanaSettlementHistoryEntry,
  useSolanaSettlementHistory,
} from "../lib/solanaSettlementHistory";

export interface SolanaSettlementHistoryProps {
  programId: string;
  walletAddress: string | null;
  marketPda?: string | null;
  agent1Name: string;
  agent2Name: string;
  onRequestSettlement?: (request: SolanaSettlementRequest) => void;
  onRequestBalanceCleanup?: (request: SolanaBalanceCleanupRequest) => void;
  onRequestOrderManagement?: (
    request: SolanaHistoricalOrderRequest,
    trigger: HTMLButtonElement,
  ) => void;
  settlingBetId?: string | null;
  recoveringBalanceMarketPda?: string | null;
  preparingOrderBetId?: string | null;
  transactionsBlocked?: boolean;
  compact?: boolean;
  locale?: UiLocale;
}

export type SolanaSettlementRequest = Pick<
  SolanaSettlementHistoryEntry,
  "betId" | "marketPda" | "duelKey" | "duelId" | "settlementState"
>;

export type SolanaHistoricalOrderRequest = Pick<
  SolanaSettlementHistoryEntry,
  "betId" | "marketPda" | "duelKey" | "duelId" | "orderId" | "orderState"
>;

export type SolanaBalanceCleanupRequest = Pick<
  SolanaSettlementHistoryEntry,
  "betId" | "marketPda" | "duelKey" | "duelId"
>;

function getCopy(locale: UiLocale) {
  const english = {
    title: "Your duel activity",
    connect: "Connect your wallet to see orders and settlement.",
    loading: "Loading verified activity…",
    unavailable: "Activity is temporarily unavailable.",
    empty: "No orders for this duel yet.",
    current: "Verified",
    stale: "Updating",
    staleHelp:
      "Settlement history is catching up. Amounts below are not presented as final yet.",
    refresh: "Refresh",
    loadMore: (remaining: number) => `Show more activity (${remaining})`,
    loadingMore: "Loading more activity…",
    order: "Order",
    matched: "Matched",
    fees: "Trade fees",
    returned: "Returned",
    payout: "Paid out",
    claimable: "Gross claim",
    reclaim: "Still resting",
    placedTx: "Order tx",
    claimTx: "Claim tx",
    cleanupTx: "Cleanup tx",
    supportRef: "Support ref",
    claimWinnings: "Claim winnings",
    claimRefund: "Claim refund",
    clearPosition: "Clear position",
    settlementSubmitting: "Preparing claim…",
    cleanupSubmitting: "Preparing cleanup…",
    manageOrder: "Manage open order",
    reclaimOrder: "Reclaim resting order",
    recoverOrderRent: "Recover order rent",
    recoverBalanceRent: "Recover account rent",
    recoveringBalanceRent: "Checking account rent…",
    preparingOrder: "Checking order…",
    yes: "YES",
    no: "NO",
    duel: "Duel",
    checking: "Checking settlement",
    orderStates: {
      PENDING_INDEX: "Confirming order",
      OPEN: "Open",
      PARTIALLY_FILLED: "Partially filled",
      FILLED: "Filled",
      CLOSED_PARTIAL: "Partially filled · closed",
      RELEASED: "Returned · no fill",
      RECLAIM_REQUIRED: "Reclaim required",
    } satisfies Record<SolanaBetOrderState, string>,
    settlementStates: {
      NOT_READY: "Not settled",
      AWAITING_RESULT: "Settlement pending",
      PAYOUT_CLAIMABLE: "Winnings ready to claim",
      REFUND_CLAIMABLE: "Refund ready to claim",
      PAID: "Winnings paid",
      REFUNDED: "Refund paid",
      LOST: "Resolved · no payout",
      NO_ENTITLEMENT: "No matched settlement",
    } satisfies Record<SolanaBetSettlementState, string>,
  };
  if (locale === "zh") {
    return {
      ...english,
      title: "你的对局记录",
      connect: "连接钱包以查看订单与结算。",
      loading: "正在加载已验证记录…",
      unavailable: "记录暂时不可用。",
      empty: "本局暂无订单。",
      current: "已验证",
      stale: "更新中",
      staleHelp: "结算记录正在同步，以下金额暂不作为最终结果显示。",
      refresh: "刷新",
      loadMore: (remaining: number) => `查看更多记录（${remaining}）`,
      loadingMore: "正在加载更多记录…",
      order: "订单",
      matched: "已成交",
      fees: "交易费",
      returned: "已退回",
      payout: "已领取",
      claimable: "可领取总额",
      reclaim: "仍在挂单",
      placedTx: "订单交易",
      claimTx: "领取交易",
      cleanupTx: "清理交易",
      supportRef: "支持编号",
      claimWinnings: "领取奖金",
      claimRefund: "领取退款",
      clearPosition: "清理仓位",
      settlementSubmitting: "正在准备领取…",
      cleanupSubmitting: "正在准备清理…",
      manageOrder: "管理挂单",
      reclaimOrder: "收回挂单",
      recoverOrderRent: "取回订单租金",
      recoverBalanceRent: "取回账户租金",
      recoveringBalanceRent: "正在核对账户租金…",
      preparingOrder: "正在核对订单…",
      yes: "是",
      no: "否",
      duel: "对局",
      checking: "正在核对结算",
      orderStates: {
        PENDING_INDEX: "正在确认订单",
        OPEN: "挂单中",
        PARTIALLY_FILLED: "部分成交",
        FILLED: "已成交",
        CLOSED_PARTIAL: "部分成交 · 已关闭",
        RELEASED: "已退回 · 未成交",
        RECLAIM_REQUIRED: "需要收回挂单",
      },
      settlementStates: {
        NOT_READY: "尚未结算",
        AWAITING_RESULT: "结算处理中",
        PAYOUT_CLAIMABLE: "奖金可领取",
        REFUND_CLAIMABLE: "退款可领取",
        PAID: "奖金已领取",
        REFUNDED: "退款已领取",
        LOST: "已结算 · 无奖金",
        NO_ENTITLEMENT: "无已成交结算",
      },
    };
  }
  return english;
}

function formatAtomic(value: string, decimals = 9, precision = 4): string {
  const atomic = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const remainder = atomic % scale;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder
    .toString()
    .padStart(decimals, "0")
    .slice(0, precision)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function restingCollateral(entry: SolanaSettlementHistoryEntry): string {
  const component = BigInt(
    entry.side === 1 ? entry.limitPrice : 1_000 - entry.limitPrice,
  );
  return ((BigInt(entry.restingAmountUnits) * component) / 1_000n).toString();
}

function compactDuelIdentity(
  duelId: string | null,
  label: string,
): string | null {
  const normalized = duelId?.trim();
  if (!normalized) return null;
  if (normalized.length <= 18) return `${label} ${normalized}`;
  const visibleId = normalized.startsWith("streaming-")
    ? normalized.slice("streaming-".length)
    : normalized;
  const visibleLabel = normalized.startsWith("streaming-") ? "" : `${label} `;
  return `${visibleLabel}${visibleId.slice(0, 6)}…${visibleId.slice(-4)}`;
}

function statusTone(entry: SolanaSettlementHistoryEntry): CSSProperties {
  if (
    ["PAID", "REFUNDED"].includes(entry.settlementState) ||
    entry.terminalKind === "LOSER_CLEANUP"
  ) {
    return { color: "#a7f3d0", borderColor: "rgba(52,211,153,0.3)" };
  }
  if (
    ["PAYOUT_CLAIMABLE", "REFUND_CLAIMABLE"].includes(entry.settlementState) ||
    (entry.settlementState === "LOST" && entry.terminalKind === null)
  ) {
    return { color: "#fde68a", borderColor: "rgba(251,191,36,0.34)" };
  }
  if (entry.orderState === "RECLAIM_REQUIRED") {
    return { color: "#fdba74", borderColor: "rgba(251,146,60,0.34)" };
  }
  return { color: "#cbd5e1", borderColor: "rgba(148,163,184,0.24)" };
}

function metricRows(
  entry: SolanaSettlementHistoryEntry,
  copy: ReturnType<typeof getCopy>,
): Array<{ label: string; value: string }> {
  const rows = [
    {
      label: copy.matched,
      value: `${formatAtomic(entry.matchedAmountUnits)} shares`,
    },
  ];
  if (BigInt(entry.tradeFeeLamports) > 0n) {
    rows.push({
      label: copy.fees,
      value: `${formatAtomic(entry.tradeFeeLamports)} SOL`,
    });
  }
  if (BigInt(entry.orderRefundLamports) > 0n) {
    rows.push({
      label: copy.returned,
      value: `${formatAtomic(entry.orderRefundLamports)} SOL`,
    });
  }
  if (BigInt(entry.terminalPayoutLamports) > 0n) {
    rows.push({
      label: copy.payout,
      value: `${formatAtomic(entry.terminalPayoutLamports)} SOL`,
    });
  } else if (entry.settlementState === "PAYOUT_CLAIMABLE") {
    rows.push({
      label: copy.claimable,
      value: `${formatAtomic(entry.matchedAmountUnits)} SOL`,
    });
  } else if (entry.settlementState === "REFUND_CLAIMABLE") {
    rows.push({
      label: copy.claimable,
      value: `${formatAtomic(entry.rewardEligibleLamports)} SOL`,
    });
  }
  if (entry.orderState === "RECLAIM_REQUIRED") {
    rows.push({
      label: copy.reclaim,
      value: `${formatAtomic(restingCollateral(entry))} SOL`,
    });
  }
  return rows;
}

export function SolanaSettlementHistory({
  programId,
  walletAddress,
  marketPda,
  agent1Name,
  agent2Name,
  onRequestSettlement,
  onRequestBalanceCleanup,
  onRequestOrderManagement,
  settlingBetId = null,
  recoveringBalanceMarketPda = null,
  preparingOrderBetId = null,
  transactionsBlocked = false,
  compact = false,
  locale,
}: SolanaSettlementHistoryProps) {
  const resolvedLocale = resolveUiLocale(locale);
  const copy = getCopy(resolvedLocale);
  const { history, loading, loadingMore, hasMore, error, refresh, loadMore } =
    useSolanaSettlementHistory({
      cluster: SOLANA_CLUSTER,
      programId,
      wallet: walletAddress,
      marketPda,
      limit: compact ? 2 : 4,
    });
  const [pendingSettlement, setPendingSettlement] =
    useState<HyperbetConfirmedSettlementRefresh | null>(null);

  useEffect(() => {
    setPendingSettlement(null);
  }, [programId, walletAddress]);

  useEffect(() => {
    if (!walletAddress) return undefined;
    const handleMarketRefresh = (event: Event) => {
      const confirmedSettlement =
        parseHyperbetConfirmedSettlementRefresh(event);
      if (confirmedSettlement?.wallet === walletAddress) {
        setPendingSettlement(confirmedSettlement);
      }
      refresh();
    };
    window.addEventListener(HYPERBET_MARKET_REFRESH_EVENT, handleMarketRefresh);
    return () =>
      window.removeEventListener(
        HYPERBET_MARKET_REFRESH_EVENT,
        handleMarketRefresh,
      );
  }, [refresh, walletAddress]);

  useEffect(() => {
    if (!history || !pendingSettlement) return;
    const matchingEntries = history.entries.filter(
      (entry) => entry.marketPda === pendingSettlement.marketPda,
    );
    const hasConfirmedEntry = matchingEntries.some((entry) => {
      if (entry.claimSignature !== pendingSettlement.signature) return false;
      return pendingSettlement.kind === "CLEANUP"
        ? entry.terminalKind === "LOSER_CLEANUP"
        : entry.settlementState === "PAID" ||
            entry.settlementState === "REFUNDED";
    });
    const hasClaimableEntry = matchingEntries.some(
      (entry) =>
        entry.settlementState === "PAYOUT_CLAIMABLE" ||
        entry.settlementState === "REFUND_CLAIMABLE" ||
        (pendingSettlement.kind === "CLEANUP" &&
          entry.settlementState === "LOST" &&
          entry.terminalKind === null),
    );
    if (hasConfirmedEntry && !hasClaimableEntry) {
      setPendingSettlement(null);
    }
  }, [history, pendingSettlement]);

  const hasPendingVisibleSettlement = Boolean(
    pendingSettlement &&
    pendingSettlement.wallet === walletAddress &&
    history?.entries.some(
      (entry) =>
        entry.marketPda === pendingSettlement.marketPda &&
        (entry.settlementState === "PAYOUT_CLAIMABLE" ||
          entry.settlementState === "REFUND_CLAIMABLE" ||
          (pendingSettlement.kind === "CLEANUP" &&
            entry.settlementState === "LOST" &&
            entry.terminalKind === null)),
    ),
  );
  const ledgerCurrent =
    history?.ledger.current === true && !hasPendingVisibleSettlement;
  const balanceCleanupEntryByMarket = new Map<string, string>();
  const settlementEntryByMarket = new Map<string, string>();
  if (history && ledgerCurrent) {
    for (const entry of history.entries) {
      if (
        entry.duelKey !== null &&
        (entry.settlementState === "PAYOUT_CLAIMABLE" ||
          entry.settlementState === "REFUND_CLAIMABLE") &&
        !settlementEntryByMarket.has(entry.marketPda)
      ) {
        settlementEntryByMarket.set(entry.marketPda, entry.betId);
      }
    }
    for (const entry of history.entries) {
      if (
        entry.duelKey !== null &&
        entry.settlementState === "LOST" &&
        entry.terminalKind === null &&
        entry.claimSignature === null &&
        !settlementEntryByMarket.has(entry.marketPda)
      ) {
        settlementEntryByMarket.set(entry.marketPda, entry.betId);
      }
    }
    for (const entry of history.entries) {
      if (
        entry.duelKey !== null &&
        entry.orderState === "RELEASED" &&
        entry.settlementState === "NO_ENTITLEMENT" &&
        typeof entry.marketStatus === "string" &&
        ["locked", "resolved", "cancelled"].includes(
          entry.marketStatus.trim().toLowerCase(),
        ) &&
        !balanceCleanupEntryByMarket.has(entry.marketPda)
      ) {
        balanceCleanupEntryByMarket.set(entry.marketPda, entry.betId);
      }
    }
  }

  return (
    <section
      data-testid="solana-settlement-history"
      style={{
        display: "grid",
        gap: 9,
        padding: "12px",
        border: "1px solid rgba(148,163,184,0.16)",
        borderRadius: "var(--hm-radius)",
        background: "rgba(2,6,23,0.28)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong
            style={{
              color: "#f8fafc",
              fontSize: 11,
              letterSpacing: 0.35,
            }}
          >
            {copy.title}
          </strong>
          {history ? (
            <span
              data-testid="solana-settlement-ledger-status"
              style={{
                padding: "2px 6px",
                borderRadius: 999,
                border: `1px solid ${
                  ledgerCurrent
                    ? "rgba(52,211,153,0.26)"
                    : "rgba(251,191,36,0.28)"
                }`,
                color: ledgerCurrent ? "#a7f3d0" : "#fde68a",
                fontSize: 8,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              {ledgerCurrent ? copy.current : copy.stale}
            </span>
          ) : null}
        </div>
        {walletAddress ? (
          <button
            type="button"
            data-testid="solana-settlement-refresh"
            onClick={refresh}
            aria-label={copy.refresh}
            style={{
              minWidth: 44,
              minHeight: 44,
              border: 0,
              background: "transparent",
              color: "rgba(226,232,240,0.62)",
              cursor: "pointer",
              fontSize: 10,
              padding: "7px 8px",
            }}
          >
            {copy.refresh}
          </button>
        ) : null}
      </div>

      {!walletAddress ? (
        <span style={messageStyle}>{copy.connect}</span>
      ) : loading && !history ? (
        <span style={messageStyle}>{copy.loading}</span>
      ) : error && !history ? (
        <span role="alert" style={{ ...messageStyle, color: "#fecaca" }}>
          {copy.unavailable}
        </span>
      ) : history && history.entries.length === 0 ? (
        <span style={messageStyle}>{copy.empty}</span>
      ) : null}

      {history && !ledgerCurrent ? (
        <div
          role="status"
          style={{
            padding: "8px 9px",
            borderRadius: 8,
            border: "1px solid rgba(251,191,36,0.22)",
            background: "rgba(120,53,15,0.12)",
            color: "#fde68a",
            fontSize: 10,
            lineHeight: 1.45,
          }}
        >
          {copy.staleHelp}
        </div>
      ) : null}

      {error && history ? (
        <span role="alert" style={{ ...messageStyle, color: "#fecaca" }}>
          {copy.unavailable}
        </span>
      ) : null}

      {history?.entries.map((entry) => {
        const placementUrl = buildSolanaExplorerTransactionUrl(
          entry.placeSignature,
          SOLANA_CLUSTER,
        );
        const claimUrl = entry.claimSignature
          ? buildSolanaExplorerTransactionUrl(
              entry.claimSignature,
              SOLANA_CLUSTER,
            )
          : null;
        const settlementLabel =
          entry.terminalKind === "LOSER_CLEANUP"
            ? resolvedLocale === "zh"
              ? "仓位已清理 · 无奖金"
              : "Position closed · no payout"
            : copy.settlementStates[entry.settlementState];
        const requestableSettlement =
          ledgerCurrent &&
          entry.duelKey !== null &&
          settlementEntryByMarket.get(entry.marketPda) === entry.betId
            ? ({
                betId: entry.betId,
                marketPda: entry.marketPda,
                duelKey: entry.duelKey,
                duelId: entry.duelId,
                settlementState: entry.settlementState,
              } satisfies SolanaSettlementRequest)
            : null;
        const requestableOrder =
          ledgerCurrent &&
          entry.duelKey !== null &&
          ["OPEN", "PARTIALLY_FILLED", "FILLED", "RECLAIM_REQUIRED"].includes(
            entry.orderState,
          ) &&
          (entry.orderState !== "FILLED" || entry.terminalKind !== null)
            ? ({
                betId: entry.betId,
                marketPda: entry.marketPda,
                duelKey: entry.duelKey,
                duelId: entry.duelId,
                orderId: entry.orderId,
                orderState: entry.orderState,
              } satisfies SolanaHistoricalOrderRequest)
            : null;
        const requestableBalanceCleanup =
          balanceCleanupEntryByMarket.get(entry.marketPda) === entry.betId
            ? ({
                betId: entry.betId,
                marketPda: entry.marketPda,
                duelKey: entry.duelKey!,
                duelId: entry.duelId,
              } satisfies SolanaBalanceCleanupRequest)
            : null;
        const settlementButtonLabel =
          entry.settlementState === "LOST"
            ? copy.clearPosition
            : entry.settlementState === "REFUND_CLAIMABLE"
              ? copy.claimRefund
              : copy.claimWinnings;
        const orderButtonLabel =
          entry.orderState === "RECLAIM_REQUIRED"
            ? copy.reclaimOrder
            : entry.orderState === "FILLED"
              ? copy.recoverOrderRent
              : copy.manageOrder;
        const stateLabel = ledgerCurrent
          ? entry.orderState === "RECLAIM_REQUIRED"
            ? copy.orderStates.RECLAIM_REQUIRED
            : entry.settlementState === "NOT_READY"
              ? copy.orderStates[entry.orderState]
              : settlementLabel
          : copy.checking;
        const selectedAgent = marketPda
          ? entry.side === 1
            ? agent1Name
            : agent2Name
          : null;
        const entryIdentity =
          selectedAgent ?? compactDuelIdentity(entry.duelId, copy.duel);
        return (
          <article
            key={entry.betId}
            data-testid="solana-settlement-entry"
            style={{
              display: "grid",
              gap: 8,
              padding: compact ? "9px" : "10px",
              borderRadius: 9,
              border: "1px solid rgba(148,163,184,0.14)",
              background: "rgba(15,23,42,0.44)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span
                  title={entry.duelId ?? undefined}
                  data-testid={`solana-settlement-identity-${entry.betId}`}
                  style={{
                    color: "#f8fafc",
                    fontSize: 11,
                    fontWeight: 750,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.side === 1 ? copy.yes : copy.no}
                  {entryIdentity ? ` · ${entryIdentity}` : null}
                </span>
                <span style={{ color: "rgba(148,163,184,0.72)", fontSize: 9 }}>
                  {copy.order} #{entry.orderId} ·{" "}
                  {new Intl.DateTimeFormat(getLocaleTag(resolvedLocale), {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(entry.recordedAt)}
                </span>
                {entry.correlationId ? (
                  <span
                    title={entry.correlationId}
                    data-testid={`solana-settlement-correlation-${entry.betId}`}
                    style={{
                      color: "rgba(148,163,184,0.62)",
                      fontSize: 8,
                      fontFamily: "var(--hm-font-mono)",
                    }}
                  >
                    {copy.supportRef} · {entry.correlationId.slice(0, 12)}
                  </span>
                ) : null}
              </div>
              <span
                style={{
                  flexShrink: 0,
                  border: "1px solid",
                  borderRadius: 999,
                  padding: "3px 7px",
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: 0.3,
                  ...statusTone(entry),
                }}
              >
                {stateLabel}
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: compact
                  ? "repeat(2, minmax(0, 1fr))"
                  : "repeat(auto-fit, minmax(90px, 1fr))",
                gap: 6,
              }}
            >
              {metricRows(entry, copy).map((metric) => (
                <div key={metric.label} style={{ display: "grid", gap: 1 }}>
                  <span
                    style={{ color: "rgba(148,163,184,0.72)", fontSize: 8 }}
                  >
                    {metric.label}
                  </span>
                  <span
                    style={{
                      color: "#e2e8f0",
                      fontSize: 10,
                      fontFamily: "var(--hm-font-mono)",
                    }}
                  >
                    {metric.value}
                  </span>
                </div>
              ))}
            </div>

            {requestableSettlement && onRequestSettlement ? (
              <button
                type="button"
                data-testid={`solana-settlement-action-${entry.betId}`}
                disabled={settlingBetId !== null || transactionsBlocked}
                onClick={() => onRequestSettlement(requestableSettlement)}
                style={{
                  minHeight: 44,
                  padding: "7px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(52,211,153,0.34)",
                  background: "rgba(16,92,53,0.18)",
                  color: "#d1fae5",
                  cursor:
                    settlingBetId === null && !transactionsBlocked
                      ? "pointer"
                      : "not-allowed",
                  fontSize: 10,
                  fontWeight: 800,
                }}
              >
                {settlingBetId === entry.betId
                  ? entry.settlementState === "LOST"
                    ? copy.cleanupSubmitting
                    : copy.settlementSubmitting
                  : settlementButtonLabel}
              </button>
            ) : null}

            {requestableBalanceCleanup && onRequestBalanceCleanup ? (
              <button
                type="button"
                data-testid={`solana-balance-rent-action-${entry.betId}`}
                disabled={
                  recoveringBalanceMarketPda !== null ||
                  settlingBetId !== null ||
                  transactionsBlocked
                }
                onClick={() =>
                  onRequestBalanceCleanup(requestableBalanceCleanup)
                }
                style={{
                  minHeight: 44,
                  padding: "7px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(52,211,153,0.34)",
                  background: "rgba(16,92,53,0.18)",
                  color: "#d1fae5",
                  cursor:
                    recoveringBalanceMarketPda === null &&
                    settlingBetId === null &&
                    !transactionsBlocked
                      ? "pointer"
                      : "wait",
                  fontSize: 10,
                  fontWeight: 800,
                }}
              >
                {recoveringBalanceMarketPda === entry.marketPda
                  ? copy.recoveringBalanceRent
                  : copy.recoverBalanceRent}
              </button>
            ) : null}

            {requestableOrder && onRequestOrderManagement ? (
              <button
                type="button"
                data-testid={`solana-order-history-action-${entry.betId}`}
                disabled={
                  preparingOrderBetId !== null ||
                  settlingBetId !== null ||
                  transactionsBlocked
                }
                onClick={(event) =>
                  onRequestOrderManagement(
                    requestableOrder,
                    event.currentTarget,
                  )
                }
                style={{
                  minHeight: 44,
                  padding: "7px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(96,165,250,0.34)",
                  background: "rgba(30,64,175,0.18)",
                  color: "#dbeafe",
                  cursor:
                    preparingOrderBetId === null &&
                    settlingBetId === null &&
                    !transactionsBlocked
                      ? "pointer"
                      : "wait",
                  fontSize: 10,
                  fontWeight: 800,
                }}
              >
                {preparingOrderBetId === entry.betId
                  ? copy.preparingOrder
                  : orderButtonLabel}
              </button>
            ) : null}

            {placementUrl || claimUrl ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {placementUrl ? (
                  <a
                    href={placementUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={linkStyle}
                  >
                    {copy.placedTx} ↗
                  </a>
                ) : null}
                {claimUrl ? (
                  <a
                    href={claimUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={linkStyle}
                  >
                    {entry.terminalKind === "LOSER_CLEANUP"
                      ? copy.cleanupTx
                      : copy.claimTx}{" "}
                    ↗
                  </a>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}

      {history && hasMore ? (
        <button
          type="button"
          data-testid="solana-settlement-load-more"
          disabled={loadingMore}
          onClick={loadMore}
          style={{
            minHeight: 44,
            padding: "7px 10px",
            borderRadius: 8,
            border: "1px solid rgba(148,163,184,0.24)",
            background: "rgba(15,23,42,0.5)",
            color: "#cbd5e1",
            cursor: loadingMore ? "wait" : "pointer",
            opacity: loadingMore ? 0.62 : 1,
            fontSize: 10,
            fontWeight: 750,
          }}
        >
          {loadingMore
            ? copy.loadingMore
            : copy.loadMore(history.total - history.entries.length)}
        </button>
      ) : null}
    </section>
  );
}

const messageStyle: CSSProperties = {
  color: "rgba(203,213,225,0.68)",
  fontSize: 10,
  lineHeight: 1.5,
};

const linkStyle: CSSProperties = {
  color: "rgba(147,197,253,0.82)",
  fontSize: 9,
  textDecoration: "none",
};
