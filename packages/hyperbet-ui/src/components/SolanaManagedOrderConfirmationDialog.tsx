import { forwardRef, type CSSProperties } from "react";
import { resolveUiLocale, type UiLocale } from "@hyperbet/ui/i18n";

import { formatSolLamports } from "../lib/solanaOrderQuote";
import type { SolanaManagedOrderPlan } from "../lib/solanaOrderManagement";

export interface SolanaManagedOrderConfirmationDialogProps {
  order: SolanaManagedOrderPlan;
  submitting?: boolean;
  compact?: boolean;
  locale?: UiLocale;
  onBack: () => void;
  onConfirm: () => void;
}

function getCopy(locale: UiLocale) {
  if (locale === "zh") {
    return {
      cancelTitle: "确认取消订单",
      reclaimTitle: "确认收回挂单",
      closeFilledTitle: "确认取回已成交订单租金",
      cancelHelp:
        "取消仅适用于仍开放的市场。签名前会再次核对订单与完整相邻挂单链。",
      reclaimHelp:
        "收回仅适用于已锁定或终止的市场。签名前会再次核对订单与完整相邻挂单链。",
      closeFilledHelp:
        "仅可关闭已完全成交、已从订单簿移除且属于当前钱包的订单账户。此操作不会移动抵押或共享价格档租金。",
      orderId: "订单编号",
      probability: "所选结果限价概率",
      remaining: "未成交份额",
      filledShares: "已成交份额",
      collateralReturn: "未成交抵押返还",
      orderRentReturn: "订单账户租金返还",
      grossCredit: "网络费前钱包入账",
      terms:
        "该订单账户租金仅返还原始挂单者；共享价格档账户租金不包含在内，网络费另行扣除。已成交部分与已收取费用不会撤销。若订单、市场状态、租金或相邻挂单发生变化，本次操作将停止并要求重新核对。",
      back: "返回订单",
      confirmCancel: "确认取消并签名",
      confirmReclaim: "确认收回并签名",
      confirmCloseFilled: "确认取回租金并签名",
      processing: "处理中…",
    };
  }
  return {
    cancelTitle: "Confirm order cancellation",
    reclaimTitle: "Confirm resting-order reclaim",
    closeFilledTitle: "Confirm filled-order rent recovery",
    cancelHelp:
      "Cancellation is valid only while the market is open. The order and complete linked-book accounts are rechecked before signature.",
    reclaimHelp:
      "Reclaim is valid only after the market locks or terminates. The order and complete linked-book accounts are rechecked before signature.",
    closeFilledHelp:
      "Only a fully filled, unlinked Order account owned by this wallet can close. This action cannot move collateral or shared PriceLevel rent.",
    orderId: "Order ID",
    probability: "Selected outcome limit probability",
    remaining: "Unmatched shares",
    filledShares: "Filled shares",
    collateralReturn: "Unmatched collateral return",
    orderRentReturn: "Order-account rent returned",
    grossCredit: "Wallet credit before network fee",
    terms:
      "This Order account's rent returns only to its original maker; shared PriceLevel rent is excluded and the network fee is deducted separately. Executed fills and charged fees are not reversed. If the order, market status, rent, or linked book changes, this action stops for fresh review.",
    back: "Back to orders",
    confirmCancel: "Confirm cancellation and sign",
    confirmReclaim: "Confirm reclaim and sign",
    confirmCloseFilled: "Confirm rent recovery and sign",
    processing: "Processing…",
  };
}

function actionButtonStyle(disabled: boolean): CSSProperties {
  return {
    minHeight: 44,
    padding: "9px 12px",
    borderRadius: "var(--hm-radius)",
    border: "1px solid rgba(96,165,250,0.48)",
    background: "rgba(30,64,175,0.82)",
    color: "#f8fafc",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.58 : 1,
    fontSize: 11,
    fontWeight: 800,
  };
}

export const SolanaManagedOrderConfirmationDialog = forwardRef<
  HTMLDivElement,
  SolanaManagedOrderConfirmationDialogProps
>(function SolanaManagedOrderConfirmationDialog(
  { order, submitting = false, compact = false, locale, onBack, onConfirm },
  ref,
) {
  const copy = getCopy(resolveUiLocale(locale));
  const isCancellation = order.action === "CANCEL";
  const isFilledCleanup = order.action === "CLOSE_FILLED";
  const rows = [
    { label: copy.orderId, value: `#${order.orderId.toString()}` },
    {
      label: copy.probability,
      value: `${order.outcomeSide} ${(order.outcomePriceMillis / 10).toFixed(1)}%`,
    },
    isFilledCleanup
      ? {
          label: copy.filledShares,
          value: formatSolLamports(order.filledUnits),
        }
      : {
          label: copy.remaining,
          value: formatSolLamports(order.remainingUnits),
        },
    ...(isFilledCleanup
      ? []
      : [
          {
            label: copy.collateralReturn,
            value: `${formatSolLamports(order.refundableCollateralLamports)} SOL`,
          },
        ]),
    {
      label: copy.orderRentReturn,
      value: `${formatSolLamports(order.returnedOrderAccountRentLamports, 9)} SOL`,
    },
    {
      label: copy.grossCredit,
      value: `${formatSolLamports(order.grossWalletCreditLamports, 9)} SOL`,
    },
  ];

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="solana-managed-order-confirmation-title"
      aria-describedby="solana-managed-order-confirmation-help"
      data-testid="solana-managed-order-confirmation"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !submitting) {
          event.preventDefault();
          event.stopPropagation();
          onBack();
        }
      }}
      style={{
        width: "min(100%, 460px)",
        maxHeight: "min(calc(100dvh - 32px), 720px)",
        overflowY: "auto",
        overscrollBehavior: "contain",
        boxSizing: "border-box",
        display: "grid",
        gap: 14,
        padding: compact ? 16 : 20,
        borderRadius: 14,
        border: "1px solid rgba(96,165,250,0.34)",
        background:
          "linear-gradient(180deg, rgba(15,23,42,0.99), rgba(3,7,18,0.99))",
        boxShadow: "0 28px 80px rgba(0,0,0,0.58)",
        color: "var(--hm-text, #f8fafc)",
        fontFamily: "var(--hm-font-body)",
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <h2
          id="solana-managed-order-confirmation-title"
          style={{ margin: 0, fontSize: 18, lineHeight: 1.25 }}
        >
          {isCancellation
            ? copy.cancelTitle
            : isFilledCleanup
              ? copy.closeFilledTitle
              : copy.reclaimTitle}
        </h2>
        <p
          id="solana-managed-order-confirmation-help"
          style={{
            margin: 0,
            color: "rgba(255,255,255,0.62)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {isCancellation
            ? copy.cancelHelp
            : isFilledCleanup
              ? copy.closeFilledHelp
              : copy.reclaimHelp}
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          padding: 12,
          borderRadius: 10,
          border: "1px solid rgba(96,165,250,0.22)",
          background: "rgba(30,64,175,0.08)",
        }}
      >
        {rows.map((row) => (
          <div
            key={row.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 14,
              fontSize: 12,
            }}
          >
            <span style={{ color: "rgba(255,255,255,0.54)" }}>{row.label}</span>
            <span
              style={{
                textAlign: "right",
                fontFamily: "var(--hm-font-mono)",
                overflowWrap: "anywhere",
              }}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>

      <p
        style={{
          margin: 0,
          color: "rgba(255,255,255,0.62)",
          fontSize: 11,
          lineHeight: 1.55,
        }}
      >
        {copy.terms}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.45fr)",
          gap: 10,
        }}
      >
        <button
          type="button"
          autoFocus
          data-testid="solana-managed-order-confirmation-back"
          disabled={submitting}
          onClick={onBack}
          style={{
            ...actionButtonStyle(submitting),
            border: "1px solid rgba(148,163,184,0.26)",
            background: "rgba(30,41,59,0.78)",
          }}
        >
          {copy.back}
        </button>
        <button
          type="button"
          data-testid="solana-managed-order-confirmation-submit"
          disabled={submitting}
          onClick={onConfirm}
          style={actionButtonStyle(submitting)}
        >
          {submitting
            ? copy.processing
            : isCancellation
              ? copy.confirmCancel
              : isFilledCleanup
                ? copy.confirmCloseFilled
                : copy.confirmReclaim}
        </button>
      </div>
    </div>
  );
});
