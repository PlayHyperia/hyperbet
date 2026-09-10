import { resolveUiLocale, type UiLocale } from "@hyperbet/ui/i18n";

import { formatSolLamports } from "../lib/solanaOrderQuote";
import type { SolanaManagedOrderPlan } from "../lib/solanaOrderManagement";

export interface SolanaManagedOrdersProps {
  orders: readonly SolanaManagedOrderPlan[];
  submittingOrderId?: bigint | null;
  disabled?: boolean;
  locale?: UiLocale;
  onRequestAction: (
    order: SolanaManagedOrderPlan,
    trigger: HTMLButtonElement,
  ) => void;
}

function getCopy(locale: UiLocale) {
  if (locale === "zh") {
    return {
      title: "你的订单",
      order: "订单",
      remaining: "未成交份额",
      filledShares: "已成交份额",
      collateralReturn: "未成交抵押返还",
      orderRentReturn: "订单账户租金返还",
      grossCredit: "预计钱包入账",
      cancel: "取消订单",
      reclaim: "收回挂单",
      closeFilled: "取回已成交订单租金",
      processing: "处理中…",
      partiallyFilled: "部分成交",
      resting: "挂单中",
      filledCleanup: "已全部成交 · 可取回租金",
      disclosure:
        "未成交抵押与该订单账户租金会返还原始挂单者；已成交部分与已收取费用不会撤销。共享价格档账户租金不包含在内，网络费另行扣除。",
      side: { YES: "是", NO: "否" },
    };
  }
  return {
    title: "Your orders",
    order: "Order",
    remaining: "Unmatched shares",
    filledShares: "Filled shares",
    collateralReturn: "Unmatched collateral",
    orderRentReturn: "Order-account rent",
    grossCredit: "Wallet credit before fee",
    cancel: "Cancel order",
    reclaim: "Reclaim resting order",
    closeFilled: "Recover filled-order rent",
    processing: "Processing…",
    partiallyFilled: "Partially filled",
    resting: "Resting",
    filledCleanup: "Fully filled · rent ready",
    disclosure:
      "Unmatched collateral and this Order account's rent return to the original maker. Executed fills and charged fees are not reversed; shared PriceLevel rent is excluded and the network fee is deducted separately.",
    side: { YES: "YES", NO: "NO" },
  };
}

export function SolanaManagedOrders({
  orders,
  submittingOrderId = null,
  disabled = false,
  locale,
  onRequestAction,
}: SolanaManagedOrdersProps) {
  if (orders.length === 0) return null;
  const copy = getCopy(resolveUiLocale(locale));

  return (
    <section
      data-testid="solana-managed-orders"
      style={{
        display: "grid",
        gap: 9,
        padding: 12,
        border: "1px solid rgba(96,165,250,0.22)",
        borderRadius: "var(--hm-radius)",
        background: "rgba(15,23,42,0.38)",
      }}
    >
      <strong
        style={{
          color: "#f8fafc",
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {copy.title}
      </strong>

      <div style={{ display: "grid", gap: 8 }}>
        {orders.map((order) => {
          const isSubmitting = submittingOrderId === order.orderId;
          const isFilledCleanup = order.action === "CLOSE_FILLED";
          const actionLabel =
            order.action === "CANCEL"
              ? copy.cancel
              : order.action === "RECLAIM"
                ? copy.reclaim
                : copy.closeFilled;
          return (
            <article
              key={order.orderId.toString()}
              data-testid={`solana-managed-order-${order.orderId.toString()}`}
              style={{
                display: "grid",
                gap: 8,
                padding: 10,
                border: "1px solid rgba(148,163,184,0.2)",
                borderRadius: "var(--hm-radius)",
                background: "rgba(2,6,23,0.28)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ color: "#e2e8f0", fontSize: 11 }}>
                  {copy.order} #{order.orderId.toString()} ·{" "}
                  <strong
                    style={{
                      color:
                        order.outcomeSide === "YES" ? "#93c5fd" : "#c4b5fd",
                    }}
                  >
                    {copy.side[order.outcomeSide]}
                  </strong>{" "}
                  {(order.outcomePriceMillis / 10).toFixed(1)}%
                </span>
                <span
                  style={{
                    color: "rgba(255,255,255,0.58)",
                    fontSize: 10,
                  }}
                >
                  {isFilledCleanup
                    ? copy.filledCleanup
                    : order.filledUnits > 0n
                      ? copy.partiallyFilled
                      : copy.resting}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    display: "grid",
                    gap: 2,
                    color: "rgba(255,255,255,0.55)",
                    fontSize: 9,
                    lineHeight: 1.4,
                  }}
                >
                  {isFilledCleanup ? copy.filledShares : copy.remaining}
                  <strong style={{ color: "#f8fafc", fontSize: 11 }}>
                    {formatSolLamports(
                      isFilledCleanup
                        ? order.filledUnits
                        : order.remainingUnits,
                    )}
                  </strong>
                </span>
                {!isFilledCleanup ? (
                  <span
                    style={{
                      display: "grid",
                      gap: 2,
                      color: "rgba(255,255,255,0.55)",
                      fontSize: 9,
                      lineHeight: 1.4,
                    }}
                  >
                    {copy.collateralReturn}
                    <strong style={{ color: "#a7f3d0", fontSize: 11 }}>
                      {formatSolLamports(order.refundableCollateralLamports)}{" "}
                      SOL
                    </strong>
                  </span>
                ) : null}
                <span
                  style={{
                    display: "grid",
                    gap: 2,
                    color: "rgba(255,255,255,0.55)",
                    fontSize: 9,
                    lineHeight: 1.4,
                  }}
                >
                  {copy.orderRentReturn}
                  <strong style={{ color: "#bfdbfe", fontSize: 11 }}>
                    {formatSolLamports(
                      order.returnedOrderAccountRentLamports,
                      9,
                    )}{" "}
                    SOL
                  </strong>
                </span>
                <span
                  style={{
                    display: "grid",
                    gap: 2,
                    color: "rgba(255,255,255,0.55)",
                    fontSize: 9,
                    lineHeight: 1.4,
                  }}
                >
                  {copy.grossCredit}
                  <strong style={{ color: "#f8fafc", fontSize: 11 }}>
                    {formatSolLamports(order.grossWalletCreditLamports, 9)} SOL
                  </strong>
                </span>
              </div>

              <button
                type="button"
                data-testid={`solana-managed-order-action-${order.orderId.toString()}`}
                disabled={disabled || submittingOrderId !== null}
                onClick={(event) => onRequestAction(order, event.currentTarget)}
                aria-label={`${actionLabel} #${order.orderId.toString()}`}
                style={{
                  minHeight: 44,
                  padding: "8px 11px",
                  borderRadius: "var(--hm-radius)",
                  border: "1px solid rgba(96,165,250,0.38)",
                  background: "rgba(30,64,175,0.34)",
                  color: "#dbeafe",
                  cursor:
                    disabled || submittingOrderId !== null
                      ? "not-allowed"
                      : "pointer",
                  opacity: disabled || submittingOrderId !== null ? 0.58 : 1,
                  fontSize: 11,
                  fontWeight: 800,
                }}
              >
                {isSubmitting ? copy.processing : actionLabel}
              </button>
            </article>
          );
        })}
      </div>

      <span
        style={{
          color: "rgba(255,255,255,0.56)",
          fontSize: 10,
          lineHeight: 1.5,
        }}
      >
        {copy.disclosure}
      </span>
    </section>
  );
}
