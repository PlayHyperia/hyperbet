import { useId, useState, type ReactNode, type Ref } from "react";
import { getUiCopy, resolveUiLocale, type UiLocale } from "@hyperbet/ui/i18n";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { OrderBook, type OrderLevel } from "./OrderBook";
import { RecentTrades, type Trade } from "./RecentTrades";

type BetSide = "YES" | "NO";

export interface ChartDataPoint {
  time: number;
  pct: number;
}

interface PredictionMarketPanelProps {
  yesPercent: number | null;
  noPercent: number | null;
  yesPool: string | number;
  noPool: string | number;
  side: BetSide;
  setSide: (side: BetSide) => void;
  amountInput: string;
  setAmountInput: (val: string) => void;
  amountLabel?: string;
  amountHelpText?: string;
  amountError?: string | null;
  onPlaceBet: (trigger: HTMLButtonElement) => void;
  submitButtonRef?: Ref<HTMLButtonElement>;
  isWalletReady: boolean;
  programsReady: boolean;
  isSubmitting?: boolean;
  agent1Name: string;
  agent2Name: string;
  supportsSell?: boolean;
  chartData?: ChartDataPoint[];
  bids?: OrderLevel[];
  asks?: OrderLevel[];
  recentTrades?: Trade[];
  assetPriceUsd?: number | null;
  children?: ReactNode;
  pointsDisplay?: ReactNode;
  currencySymbol?: string;
  locale?: UiLocale;
  marketAssetSymbol?: string;
  onViewAgent1?: () => void;
  onViewAgent2?: () => void;
  compactHeader?: ReactNode;
  readOnly?: boolean;
  readOnlyMessage?: string;
  /** Sidebar compact mode: single-column layout, hides chart/orderbook/trades columns. */
  compact?: boolean;
}

export function PredictionMarketPanel({
  yesPercent,
  noPercent,
  yesPool,
  noPool,
  side,
  setSide,
  amountInput,
  setAmountInput,
  amountLabel,
  amountHelpText,
  amountError = null,
  onPlaceBet,
  submitButtonRef,
  isWalletReady,
  programsReady,
  isSubmitting = false,
  agent1Name,
  agent2Name,
  supportsSell = false,
  chartData = [],
  bids = [],
  asks = [],
  recentTrades = [],
  assetPriceUsd = null,
  children,
  pointsDisplay,
  currencySymbol = "SOL",
  locale,
  marketAssetSymbol = currencySymbol,
  onViewAgent1,
  onViewAgent2,
  compactHeader,
  readOnly = false,
  readOnlyMessage = "Spectator mode · transaction controls disabled",
  compact = false,
}: PredictionMarketPanelProps) {
  const amountInputId = useId();
  const amountHelpId = useId();
  const amountErrorId = useId();
  const amountDescriptionIds = [
    amountHelpText ? amountHelpId : null,
    amountError ? amountErrorId : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  const resolvedLocale = resolveUiLocale(locale);
  const copy = getUiCopy(resolvedLocale);
  const [activeTab, setActiveTab] = useState<"buy" | "sell">("buy");

  const yesSelected = side === "YES";
  const noSelected = side === "NO";
  const canBet = !readOnly && isWalletReady && programsReady && !isSubmitting;
  const sellSupported = supportsSell;
  const selectedAccent = side === "YES" ? "var(--hm-buy)" : "var(--hm-sell)";
  const selectedGlow =
    side === "YES"
      ? "var(--hm-buy-glow-soft, rgba(34,197,94,0.24))"
      : "var(--hm-sell-glow-soft, rgba(232,65,66,0.24))";
  const selectedCardBg =
    side === "YES"
      ? "linear-gradient(180deg, var(--hm-buy-soft, rgba(34,197,94,0.18)) 0%, var(--hm-buy-soft-fade, rgba(34,197,94,0.05)) 100%)"
      : "linear-gradient(180deg, var(--hm-sell-soft, rgba(232,65,66,0.18)) 0%, var(--hm-sell-soft-fade, rgba(232,65,66,0.05)) 100%)";
  const yesPercentLabel = yesPercent === null ? "—" : `${yesPercent}%`;
  const noPercentLabel = noPercent === null ? "—" : `${noPercent}%`;

  // Compact mode colour tokens (hm-* theme)
  const C_YES_ACTIVE_BG = compact
    ? "linear-gradient(180deg, var(--hm-buy-soft, rgba(34,197,94,0.22)) 0%, var(--hm-buy-soft-fade, rgba(34,197,94,0.06)) 100%)"
    : "linear-gradient(180deg, var(--hm-buy-soft, rgba(34,197,94,0.22)) 0%, var(--hm-buy-soft-fade, rgba(34,197,94,0.06)) 100%)";
  const C_YES_ACTIVE_BORDER = compact
    ? "1px solid var(--hm-buy-border, rgba(34,197,94,0.4))"
    : "1px solid var(--hm-buy-border, rgba(34,197,94,0.4))";
  const C_YES_ACTIVE_SHADOW = compact
    ? "0 4px 20px var(--hm-buy-glow-soft, rgba(34,197,94,0.2)), inset 0 1px 0 rgba(255,255,255,0.18)"
    : "0 4px 20px var(--hm-buy-glow-soft, rgba(34,197,94,0.2)), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 16px var(--hm-buy-glow-subtle, rgba(34,197,94,0.08))";
  const C_YES_TEXT = "var(--hm-buy)";
  const C_YES_GLOW = "var(--hm-buy-glow-strong, rgba(34,197,94,0.6))";
  const C_YES_BAR = compact
    ? "linear-gradient(90deg, var(--hm-buy-soft, rgba(34,197,94,0.2)), var(--hm-buy), var(--hm-buy-soft, rgba(34,197,94,0.2)))"
    : "linear-gradient(90deg, var(--hm-buy-soft, rgba(34,197,94,0.2)), var(--hm-buy), var(--hm-buy-soft, rgba(34,197,94,0.2)))";
  const C_YES_BAR_SHADOW = compact
    ? "0 0 8px var(--hm-buy-glow-strong, rgba(34,197,94,0.5))"
    : "0 0 8px var(--hm-buy-glow-strong, rgba(34,197,94,0.5))";
  const numericYesPool =
    typeof yesPool === "number"
      ? yesPool
      : Number.parseFloat(String(yesPool).replace(/[^\d.-]+/g, "")) || 0;
  const numericNoPool =
    typeof noPool === "number"
      ? noPool
      : Number.parseFloat(String(noPool).replace(/[^\d.-]+/g, "")) || 0;

  return (
    <>
      {/* Layout: 4-column wide OR single-column compact sidebar */}
      <div className={compact ? "pm-compact" : "pm-grid"}>
        {/* ========== COL 1: Betting Controls ========== */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: compact ? 8 : 10,
            padding: compact ? "12px 12px 14px" : 0,
            borderRadius: compact ? 14 : 0,
            background: compact
              ? "var(--hm-panel-shell-bg, linear-gradient(180deg, rgba(16,18,24,0.96) 0%, rgba(11,12,16,0.98) 100%))"
              : "transparent",
            border: compact
              ? "1px solid var(--hm-panel-shell-border, rgba(255,255,255,0.08))"
              : "none",
            boxShadow: compact
              ? "0 18px 40px var(--hm-panel-shell-shadow, rgba(0,0,0,0.34)), inset 0 1px 0 rgba(255,255,255,0.05)"
              : "none",
          }}
        >
          {compact && compactHeader ? <div>{compactHeader}</div> : null}

          {/* Agent buttons side by side */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: compact ? 6 : 8,
            }}
          >
            {/* Agent 1 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button
                type="button"
                aria-pressed={yesSelected}
                disabled={readOnly}
                onClick={() => setSide("YES")}
                data-testid="prediction-select-yes"
                className="gm-btn gm-btn-agent1"
                style={{
                  position: "relative",
                  padding: compact ? "10px 10px 12px" : "8px 10px",
                  borderRadius: compact ? 14 : 10,
                  border: yesSelected
                    ? C_YES_ACTIVE_BORDER
                    : "1px solid var(--hm-panel-card-border, rgba(255,255,255,0.1))",
                  color: "#fff",
                  cursor: readOnly ? "not-allowed" : "pointer",
                  textAlign: "center",
                  transition: "all 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
                  overflow: "hidden",
                  background: yesSelected
                    ? C_YES_ACTIVE_BG
                    : "var(--hm-panel-card-bg, linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%))",
                  boxShadow: yesSelected
                    ? C_YES_ACTIVE_SHADOW
                    : "inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 8px var(--hm-panel-card-shadow, rgba(0,0,0,0.2))",
                  backdropFilter: "blur(16px)",
                  WebkitBackdropFilter: "blur(16px)",
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 900,
                    letterSpacing: 1.5,
                    textTransform: "uppercase",
                    fontFamily: "var(--hm-font-display)",
                    color: yesSelected
                      ? C_YES_TEXT
                      : "var(--hm-text-dim, rgba(255,255,255,0.5))",
                    textShadow: yesSelected ? `0 0 10px ${C_YES_GLOW}` : "none",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {agent1Name}
                </div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 900,
                    color: yesSelected
                      ? "var(--hm-text, #fff)"
                      : "var(--hm-text-muted, rgba(255,255,255,0.25))",
                    fontFamily: "var(--hm-font-display)",
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1,
                    marginTop: 1,
                    textShadow: yesSelected
                      ? "0 2px 8px rgba(0,0,0,0.5)"
                      : "none",
                  }}
                >
                  {yesPercentLabel}
                </div>
                {compact ? (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 9,
                      fontWeight: 700,
                      color: yesSelected
                        ? "var(--hm-text, rgba(255,255,255,0.8))"
                        : "var(--hm-text-muted, rgba(255,255,255,0.42))",
                      fontFamily: "var(--hm-font-mono)",
                      letterSpacing: 0.2,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {yesPool}
                  </div>
                ) : null}
                {yesSelected && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: 2,
                      background: C_YES_BAR,
                      boxShadow: C_YES_BAR_SHADOW,
                    }}
                  />
                )}
              </button>
              {onViewAgent1 ? (
                <button
                  onClick={onViewAgent1}
                  className="gm-btn-sm gm-btn-sm-yes"
                  style={{
                    padding: "5px 4px",
                    borderRadius: 8,
                    border:
                      "1px solid var(--hm-buy-soft, rgba(34,197,94,0.15))",
                    cursor: "pointer",
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: 1.5,
                    textTransform: "uppercase",
                    transition: "all 0.15s ease",
                    fontFamily: "var(--hm-font-display)",
                    background:
                      "linear-gradient(180deg, var(--hm-buy-soft-faint, rgba(34,197,94,0.06)) 0%, rgba(34,197,94,0.02) 100%)",
                    color: "var(--hm-buy)",
                    boxShadow:
                      "inset 0 1px 0 var(--hm-buy-soft-faint, rgba(34,197,94,0.06)), 0 2px 4px rgba(0,0,0,0.15)",
                    backdropFilter: "blur(12px)",
                    WebkitBackdropFilter: "blur(12px)",
                  }}
                >
                  {copy.stats}
                </button>
              ) : null}
            </div>

            {/* Agent 2 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button
                type="button"
                aria-pressed={noSelected}
                disabled={readOnly}
                onClick={() => setSide("NO")}
                data-testid="prediction-select-no"
                className="gm-btn gm-btn-agent2"
                style={{
                  position: "relative",
                  padding: compact ? "10px 10px 12px" : "8px 10px",
                  borderRadius: compact ? 14 : 10,
                  border: noSelected
                    ? "1px solid var(--hm-sell-border, rgba(232,65,66,0.4))"
                    : "1px solid var(--hm-panel-card-border, rgba(255,255,255,0.1))",
                  color: "#fff",
                  cursor: readOnly ? "not-allowed" : "pointer",
                  textAlign: "center",
                  transition: "all 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
                  overflow: "hidden",
                  background: noSelected
                    ? "linear-gradient(180deg, var(--hm-sell-soft, rgba(232,65,66,0.22)) 0%, var(--hm-sell-soft-fade, rgba(232,65,66,0.06)) 100%)"
                    : "var(--hm-panel-card-bg, linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%))",
                  boxShadow: noSelected
                    ? "0 4px 20px var(--hm-sell-glow-soft, rgba(232,65,66,0.2)), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 16px var(--hm-sell-glow-subtle, rgba(232,65,66,0.08))"
                    : "inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 8px var(--hm-panel-card-shadow, rgba(0,0,0,0.2))",
                  backdropFilter: "blur(16px)",
                  WebkitBackdropFilter: "blur(16px)",
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 900,
                    letterSpacing: 1.5,
                    textTransform: "uppercase",
                    fontFamily: "var(--hm-font-display)",
                    color: noSelected
                      ? "var(--hm-sell)"
                      : "var(--hm-text-dim, rgba(255,255,255,0.5))",
                    textShadow: noSelected
                      ? "0 0 10px var(--hm-sell-glow-strong, rgba(232,65,66,0.6))"
                      : "none",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {agent2Name}
                </div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 900,
                    color: noSelected
                      ? "var(--hm-text, #fff)"
                      : "var(--hm-text-muted, rgba(255,255,255,0.25))",
                    fontFamily: "var(--hm-font-display)",
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1,
                    marginTop: 1,
                    textShadow: noSelected
                      ? "0 2px 8px rgba(0,0,0,0.5)"
                      : "none",
                  }}
                >
                  {noPercentLabel}
                </div>
                {compact ? (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 9,
                      fontWeight: 700,
                      color: noSelected
                        ? "var(--hm-text, rgba(255,255,255,0.8))"
                        : "var(--hm-text-muted, rgba(255,255,255,0.42))",
                      fontFamily: "var(--hm-font-mono)",
                      letterSpacing: 0.2,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {noPool}
                  </div>
                ) : null}
                {noSelected && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: 2,
                      background:
                        "linear-gradient(90deg, var(--hm-sell-soft, rgba(232,65,66,0.2)), var(--hm-sell), var(--hm-sell-soft, rgba(232,65,66,0.2)))",
                      boxShadow:
                        "0 0 8px var(--hm-sell-glow-strong, rgba(232,65,66,0.5))",
                    }}
                  />
                )}
              </button>
              {onViewAgent2 ? (
                <button
                  onClick={onViewAgent2}
                  className="gm-btn-sm gm-btn-sm-no"
                  style={{
                    padding: "5px 4px",
                    borderRadius: 8,
                    border:
                      "1px solid var(--hm-sell-soft, rgba(232,65,66,0.15))",
                    cursor: "pointer",
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: 1.5,
                    textTransform: "uppercase",
                    transition: "all 0.15s ease",
                    fontFamily: "var(--hm-font-display)",
                    background:
                      "linear-gradient(180deg, var(--hm-sell-soft-faint, rgba(232,65,66,0.06)) 0%, rgba(232,65,66,0.02) 100%)",
                    color: "var(--hm-sell)",
                    boxShadow:
                      "inset 0 1px 0 var(--hm-sell-soft-faint, rgba(232,65,66,0.06)), 0 2px 4px rgba(0,0,0,0.15)",
                    backdropFilter: "blur(12px)",
                    WebkitBackdropFilter: "blur(12px)",
                  }}
                >
                  {copy.stats}
                </button>
              ) : null}
            </div>
          </div>

          {/* Divider */}
          <div
            style={{
              height: 1,
              background:
                "linear-gradient(90deg, transparent, var(--hm-border-subtle, rgba(255,255,255,0.08)), transparent)",
            }}
          />

          {pointsDisplay && (
            <div style={{ marginBottom: 4 }}>{pointsDisplay}</div>
          )}

          {readOnly ? (
            <div
              role="status"
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(242,208,138,0.22)",
                background: "rgba(242,208,138,0.07)",
                color: "rgba(242,208,138,0.86)",
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: 1,
                lineHeight: 1.5,
                textAlign: "center",
                textTransform: "uppercase",
              }}
            >
              {readOnlyMessage}
            </div>
          ) : null}

          {/* Buy / Sell Toggle */}
          {!readOnly ? (
            <div
              style={{
                display: "flex",
                gap: compact ? 6 : 4,
                background: compact
                  ? "var(--hm-segmented-bg, rgba(255,255,255,0.03))"
                  : "var(--hm-segmented-bg-strong, rgba(0,0,0,0.25))",
                borderRadius: compact ? 14 : 12,
                padding: compact ? 4 : 3,
                border: compact
                  ? "1px solid var(--hm-border-subtle, rgba(255,255,255,0.06))"
                  : "1px solid var(--hm-border-subtle, rgba(255,255,255,0.08))",
                boxShadow: compact
                  ? "inset 0 1px 0 rgba(255,255,255,0.04)"
                  : "inset 0 2px 6px rgba(0,0,0,0.3), inset 0 0 0 0.5px rgba(255,255,255,0.04)",
                backdropFilter: compact ? "none" : "blur(12px)",
                WebkitBackdropFilter: compact ? "none" : "blur(12px)",
              }}
            >
              <button
                onClick={() => setActiveTab("buy")}
                data-testid="prediction-tab-buy"
                className="gm-tab-btn"
                style={{
                  flex: 1,
                  padding: "8px 4px",
                  borderRadius: 9,
                  border: "none",
                  cursor: "pointer",
                  fontWeight: 900,
                  fontSize: compact ? 12 : 13,
                  letterSpacing: compact ? 1.2 : 2,
                  textTransform: "uppercase",
                  transition: "all 0.15s ease",
                  fontFamily: "var(--hm-font-display)",
                  background:
                    activeTab === "buy"
                      ? compact
                        ? "linear-gradient(180deg, var(--hm-buy) 0%, var(--hm-buy-strong, #15803d) 100%)"
                        : "linear-gradient(180deg, var(--hm-buy) 0%, var(--hm-buy-strong, #15803d) 100%)"
                      : "transparent",
                  color:
                    activeTab === "buy"
                      ? "var(--hm-tab-active-text, #fff)"
                      : "var(--hm-text-muted, rgba(255,255,255,0.35))",
                  boxShadow:
                    activeTab === "buy"
                      ? compact
                        ? "0 2px 8px rgba(34,197,94,0.35), inset 0 1px 0 rgba(255,255,255,0.25)"
                        : "0 2px 12px var(--hm-buy-glow-soft, rgba(34,197,94,0.4)), inset 0 1px 0 rgba(255,255,255,0.3)"
                      : "none",
                }}
              >
                {copy.buy}
              </button>
              <button
                onClick={() => sellSupported && setActiveTab("sell")}
                data-testid="prediction-tab-sell"
                className="gm-tab-btn"
                disabled={!sellSupported}
                style={{
                  flex: 1,
                  padding: "8px 4px",
                  borderRadius: 9,
                  border: "none",
                  cursor: sellSupported ? "pointer" : "not-allowed",
                  fontWeight: 900,
                  fontSize: compact ? 12 : 13,
                  letterSpacing: compact ? 1.2 : 2,
                  textTransform: "uppercase",
                  transition: "all 0.15s ease",
                  fontFamily: "var(--hm-font-display)",
                  background:
                    activeTab === "sell"
                      ? "linear-gradient(180deg, var(--hm-sell) 0%, var(--hm-sell-strong, #b91c1c) 100%)"
                      : "transparent",
                  color: !sellSupported
                    ? "var(--hm-text-muted, rgba(255,255,255,0.2))"
                    : activeTab === "sell"
                      ? "var(--hm-tab-active-text, #fff)"
                      : "var(--hm-text-muted, rgba(255,255,255,0.35))",
                  boxShadow:
                    activeTab === "sell"
                      ? "0 2px 12px var(--hm-sell-glow-soft, rgba(232,65,66,0.4)), inset 0 1px 0 rgba(255,255,255,0.2)"
                      : "none",
                }}
              >
                {copy.sell}
              </button>
            </div>
          ) : null}

          {/* Amount + Submit */}
          {!readOnly &&
            (activeTab === "buy" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: compact ? 7 : 8,
                  flex: 1,
                }}
              >
                <div>
                  <label
                    htmlFor={amountInputId}
                    style={
                      compact
                        ? {
                            display: "block",
                            marginBottom: 5,
                            fontSize: 9,
                            fontWeight: 800,
                            letterSpacing: 0.9,
                            textTransform: "uppercase",
                            color:
                              "var(--hm-text-muted, rgba(255,255,255,0.48))",
                            fontFamily: "var(--hm-font-display)",
                          }
                        : {
                            position: "absolute",
                            width: 1,
                            height: 1,
                            padding: 0,
                            margin: -1,
                            overflow: "hidden",
                            clip: "rect(0, 0, 0, 0)",
                            whiteSpace: "nowrap",
                            border: 0,
                          }
                    }
                  >
                    {amountLabel ?? copy.betAmountLabel(currencySymbol)}
                  </label>
                  <div style={{ position: "relative" }}>
                    <input
                      id={amountInputId}
                      name="orderAmountSol"
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-describedby={amountDescriptionIds || undefined}
                      aria-invalid={amountError ? "true" : "false"}
                      aria-errormessage={
                        amountError ? amountErrorId : undefined
                      }
                      data-testid="prediction-amount-input"
                      placeholder="0.00"
                      value={amountInput}
                      onChange={(event) => setAmountInput(event.target.value)}
                      className="gm-amount-input"
                      style={{
                        width: "100%",
                        minHeight: 44,
                        padding: compact
                          ? "8px 52px 8px 11px"
                          : "9px 44px 9px 12px",
                        borderRadius: 10,
                        border: amountError
                          ? "1px solid rgba(248,113,113,0.68)"
                          : "1px solid var(--hm-chip-border, rgba(232,65,66,0.18))",
                        color: "var(--hm-accent-gold)",
                        boxSizing: "border-box",
                        fontSize: compact ? 14 : 15,
                        fontWeight: 900,
                        fontFamily: "var(--hm-font-mono)",
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: compact ? 0.4 : 1,
                        background: "var(--hm-chip-bg-strong, rgba(0,0,0,0.3))",
                        boxShadow:
                          "inset 0 2px 8px rgba(0,0,0,0.24), inset 0 0 0 0.5px var(--hm-chip-highlight, rgba(232,65,66,0.06)), 0 1px 0 rgba(255,255,255,0.04)",
                        backdropFilter: "blur(12px)",
                        WebkitBackdropFilter: "blur(12px)",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        right: compact ? 11 : 12,
                        top: "50%",
                        transform: "translateY(-50%)",
                        display: "inline-flex",
                        alignItems: "center",
                        height: "100%",
                        fontSize: compact ? 10 : 9,
                        fontWeight: 900,
                        color: "var(--hm-text-muted, rgba(232,65,66,0.45))",
                        fontFamily: "var(--hm-font-display)",
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: compact ? 1 : 1.5,
                      }}
                    >
                      {currencySymbol}
                    </div>
                  </div>
                  {amountHelpText ? (
                    <span
                      id={amountHelpId}
                      style={{
                        display: "block",
                        marginTop: 5,
                        color: "var(--hm-text-muted, rgba(255,255,255,0.48))",
                        fontFamily: "var(--hm-font-body)",
                        fontSize: 10,
                        lineHeight: 1.4,
                      }}
                    >
                      {amountHelpText}
                    </span>
                  ) : null}
                  {amountError ? (
                    <span
                      id={amountErrorId}
                      role="alert"
                      style={{
                        display: "block",
                        marginTop: 5,
                        color: "#fca5a5",
                        fontFamily: "var(--hm-font-body)",
                        fontSize: 10,
                        lineHeight: 1.4,
                      }}
                    >
                      {amountError}
                    </span>
                  ) : null}
                </div>
                <button
                  ref={submitButtonRef}
                  disabled={!canBet}
                  onClick={(event) => onPlaceBet(event.currentTarget)}
                  data-testid="prediction-submit"
                  className="gm-btn-submit"
                  style={{
                    width: "100%",
                    minHeight: 44,
                    padding: compact ? "10px 10px" : "10px 6px",
                    borderRadius: compact ? 12 : 10,
                    border: canBet
                      ? `1px solid ${compact ? selectedAccent : "var(--hm-chip-border, rgba(232,65,66,0.5))"}`
                      : "1px solid var(--hm-border-subtle, rgba(255,255,255,0.08))",
                    fontWeight: 900,
                    fontSize: compact ? 13 : 14,
                    letterSpacing: compact ? 1.8 : 3,
                    textTransform: "uppercase",
                    cursor: canBet ? "pointer" : "not-allowed",
                    transition: "all 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
                    fontFamily: "var(--hm-font-display)",
                    background: canBet
                      ? compact
                        ? selectedCardBg
                        : "linear-gradient(180deg, var(--hm-cta-bg-from, #f05252) 0%, var(--hm-cta-bg-mid, #E84142) 50%, var(--hm-cta-bg-to, #b91c1c) 100%)"
                      : "var(--hm-panel-card-bg, linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%))",
                    color: canBet
                      ? compact
                        ? "var(--hm-cta-text, #ffffff)"
                        : "var(--hm-cta-text, #ffffff)"
                      : "var(--hm-text-muted, rgba(255,255,255,0.15))",
                    boxShadow: canBet
                      ? compact
                        ? `0 10px 28px ${selectedGlow}, inset 0 1px 0 rgba(255,255,255,0.12)`
                        : "0 4px 24px var(--hm-chip-shadow, rgba(232,65,66,0.2)), inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.1)"
                      : "inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 4px rgba(0,0,0,0.15)",
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  {canBet && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "40%",
                        height: "100%",
                        background:
                          "linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent)",
                        animation: "shimmerSweep 2.5s ease-in-out infinite",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  <span style={{ position: "relative", zIndex: 1 }}>
                    {isWalletReady
                      ? `${copy.actionLabel(activeTab)} ${side}`
                      : copy.connectWallet}
                  </span>
                </button>
              </div>
            ) : (
              <div
                style={{
                  padding: 12,
                  borderRadius: 12,
                  flex: 1,
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.15)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                }}
              >
                {sellSupported ? (
                  <button
                    disabled
                    style={{
                      width: "100%",
                      padding: "10px",
                      borderRadius: 8,
                      border: "none",
                      fontWeight: 700,
                      fontSize: 11,
                      cursor: "not-allowed",
                      textTransform: "uppercase",
                      letterSpacing: 1,
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
                      color: "rgba(255,255,255,0.2)",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                    }}
                  >
                    {copy.noSellAction}
                  </button>
                ) : (
                  <button
                    disabled
                    style={{
                      width: "100%",
                      padding: "10px",
                      borderRadius: 8,
                      border: "none",
                      fontWeight: 700,
                      fontSize: 11,
                      cursor: "not-allowed",
                      textTransform: "uppercase",
                      letterSpacing: 1,
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
                      color: "rgba(255,255,255,0.2)",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                    }}
                  >
                    {copy.locked}
                  </button>
                )}
              </div>
            ))}
          {children ? (
            <div
              style={{
                display: "grid",
                gap: 8,
                marginTop: 8,
              }}
            >
              {children}
            </div>
          ) : null}
        </div>

        {/* ========== COL 2-4: Chart / Order Book / Trades — hidden in compact sidebar mode ========== */}
        {!compact && (
          <>
            <div
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 12,
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                position: "relative",
                overflow: "hidden",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 20px rgba(0,0,0,0.15)",
              }}
            >
              {/* Glass highlight overlay */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: "40%",
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%)",
                  pointerEvents: "none",
                  zIndex: 0,
                  borderRadius: "12px 12px 0 0",
                }}
              />
              {/* Subtle Scanline Overlay */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background:
                    "linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.04) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.015), rgba(0, 255, 0, 0.005), rgba(0, 0, 255, 0.015))",
                  backgroundSize: "100% 2px, 3px 100%",
                  pointerEvents: "none",
                  zIndex: 10,
                }}
              />

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-end",
                  marginBottom: 6,
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  paddingBottom: 4,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    letterSpacing: 2,
                    textTransform: "uppercase",
                    color: "rgba(255,255,255,0.4)",
                    fontFamily: "var(--hm-font-display)",
                  }}
                >
                  {
                    copy.predictionMarket &&
                      false /* Hidden — chart is self-evident */
                  }
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ textAlign: "right" }}>
                    <div
                      style={{
                        fontSize: 8,
                        fontWeight: 900,
                        color: "var(--hm-buy)",
                        letterSpacing: 1,
                        textShadow:
                          "0 0 8px var(--hm-buy-glow-strong, rgba(34,197,94,0.6))",
                      }}
                    >
                      {agent1Name.toUpperCase()}
                    </div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 900,
                        color: "#fff",
                        fontFamily: "var(--hm-font-mono)",
                      }}
                    >
                      {yesPercentLabel}
                    </div>
                  </div>
                  <div
                    style={{
                      width: 1,
                      height: 16,
                      background: "rgba(255,255,255,0.1)",
                    }}
                  />
                  <div style={{ textAlign: "right" }}>
                    <div
                      style={{
                        fontSize: 8,
                        fontWeight: 900,
                        color: "var(--hm-sell)",
                        letterSpacing: 1,
                        textShadow:
                          "0 0 8px var(--hm-sell-glow-strong, rgba(232,65,66,0.6))",
                      }}
                    >
                      {agent2Name.toUpperCase()}
                    </div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 900,
                        color: "#fff",
                        fontFamily: "var(--hm-font-mono)",
                      }}
                    >
                      {noPercentLabel}
                    </div>
                  </div>
                </div>
              </div>
              {/* Probability tug-of-war bar */}
              <div
                style={{
                  height: 3,
                  borderRadius: 2,
                  display: "flex",
                  overflow: "hidden",
                  marginBottom: 6,
                  background: "var(--hm-chip-bg-strong, rgba(0,0,0,0.3))",
                  border:
                    "1px solid var(--hm-border-subtle, rgba(255,255,255,0.05))",
                }}
              >
                <div
                  style={{
                    width: `${yesPercent ?? 0}%`,
                    height: "100%",
                    background:
                      "linear-gradient(90deg, var(--hm-buy), var(--hm-buy-glow-soft, rgba(34,197,94,0.6)))",
                    boxShadow:
                      "0 0 8px var(--hm-buy-glow-soft, rgba(34,197,94,0.4))",
                    transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
                    borderRadius: "2px 0 0 2px",
                  }}
                />
                <div
                  style={{
                    width: `${noPercent ?? 0}%`,
                    height: "100%",
                    background:
                      "linear-gradient(90deg, var(--hm-sell-glow-soft, rgba(232,65,66,0.6)), var(--hm-sell))",
                    boxShadow:
                      "0 0 8px var(--hm-sell-glow-soft, rgba(232,65,66,0.4))",
                    transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
                    borderRadius: "0 2px 2px 0",
                  }}
                />
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  position: "relative",
                  zIndex: 1,
                }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <defs>
                      <filter
                        id="glow"
                        x="-20%"
                        y="-20%"
                        width="140%"
                        height="140%"
                      >
                        <feGaussianBlur stdDeviation="3" result="blur" />
                        <feComposite
                          in="SourceGraphic"
                          in2="blur"
                          operator="over"
                        />
                      </filter>
                    </defs>
                    <XAxis dataKey="time" hide />
                    <YAxis domain={[0, 100]} hide />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div
                              style={{
                                background: "rgba(10,12,18,0.7)",
                                backdropFilter: "blur(20px)",
                                WebkitBackdropFilter: "blur(20px)",
                                padding: "6px 12px",
                                borderRadius: 8,
                                border:
                                  "1px solid var(--hm-chip-border, rgba(232,65,66,0.3))",
                                fontSize: 13,
                                fontFamily: "var(--hm-font-mono)",
                                fontWeight: 900,
                                color: "#fff",
                                boxShadow:
                                  "0 4px 20px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)",
                              }}
                            >
                              <span style={{ color: "var(--hm-accent-gold)" }}>
                                {payload[0].value}%
                              </span>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    {chartData.length > 0 ? (
                      <ReferenceLine
                        y={50}
                        stroke="rgba(255,255,255,0.1)"
                        strokeDasharray="4 4"
                      />
                    ) : null}
                    <Line
                      type="monotone"
                      dataKey="pct"
                      stroke="var(--hm-buy)"
                      strokeWidth={3}
                      dot={false}
                      isAnimationActive={true}
                      filter="url(#glow)"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* COL 3: Order Book */}
            <div
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 12,
                padding: "6px 10px 8px",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 20px rgba(0,0,0,0.15)",
                color: "#fff",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontFamily: "var(--hm-font-body)",
                overflow: "hidden",
                minHeight: 0,
              }}
            >
              <OrderBook
                yesPot={numericYesPool}
                noPot={numericNoPool}
                totalPot={numericYesPool + numericNoPool}
                assetPriceUsd={assetPriceUsd}
                locale={resolvedLocale}
                assetSymbol={marketAssetSymbol}
                bids={bids}
                asks={asks}
                midPrice={yesPercent === null ? null : yesPercent / 100}
              />
            </div>

            {/* COL 4: Recent Trades */}
            <div
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 12,
                padding: "6px 10px 8px",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 20px rgba(0,0,0,0.15)",
                color: "#fff",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontFamily: "var(--hm-font-body)",
                overflow: "hidden",
                minHeight: 0,
              }}
            >
              <RecentTrades
                yesPot={numericYesPool}
                noPot={numericNoPool}
                totalPot={numericYesPool + numericNoPool}
                assetPriceUsd={assetPriceUsd}
                locale={resolvedLocale}
                assetSymbol={marketAssetSymbol}
                trades={recentTrades}
              />
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes statusPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
        .gm-btn { transform: translateY(0); }
        .gm-btn:hover { transform: translateY(-1px); filter: brightness(1.15); }
        .gm-btn:active { transform: translateY(1px); filter: brightness(0.95); }
        .gm-btn-agent1:hover {
          box-shadow: 0 6px 28px rgba(0,255,204,0.25), inset 0 1px 0 rgba(255,255,255,0.15), 0 1px 0 rgba(0,0,0,0.6) !important;
          border-color: rgba(0,255,204,0.5) !important;
        }
        .gm-btn-agent2:hover {
          box-shadow: 0 6px 28px rgba(255,13,60,0.25), inset 0 1px 0 rgba(255,255,255,0.15), 0 1px 0 rgba(0,0,0,0.6) !important;
          border-color: rgba(255,13,60,0.5) !important;
        }
        .gm-btn-sm { transform: translateY(0); }
        .gm-btn-sm:hover { transform: translateY(-1px); filter: brightness(1.3); }
        .gm-btn-sm:active { transform: translateY(1px); }
        .gm-btn-sm-yes:hover {
          box-shadow: 0 4px 16px rgba(0,255,204,0.2), inset 0 1px 0 rgba(0,255,204,0.15) !important;
          border-color: rgba(0,255,204,0.5) !important;
        }
        .gm-btn-sm-no:hover {
          box-shadow: 0 4px 16px rgba(255,13,60,0.2), inset 0 1px 0 rgba(255,13,60,0.15) !important;
          border-color: rgba(255,13,60,0.5) !important;
        }
        .gm-tab-btn:hover { filter: brightness(1.1); }
        .gm-amount-input:focus {
          border-color: rgba(229,184,74,0.6) !important;
          box-shadow: inset 0 2px 6px rgba(0,0,0,0.6), 0 0 10px rgba(229,184,74,0.12) !important;
          outline: none;
        }
        .gm-btn-submit { transform: translateY(0); }
        .gm-btn-submit:not(:disabled):hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 24px rgba(229,184,74,0.35), inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -2px 0 rgba(0,0,0,0.25) !important;
          filter: brightness(1.08);
        }
        .gm-btn-submit:not(:disabled):active {
          transform: translateY(1px);
          box-shadow: inset 0 2px 6px rgba(0,0,0,0.4) !important;
          filter: brightness(0.95);
        }

        /* ═══ COMPACT / HYPERIA SIDEBAR THEME ═══════════════════════════ */
        /* Square corners everywhere */
        .pm-compact * { border-radius: 2px !important; }
        .pm-compact { font-variant-numeric: tabular-nums; }

        /* Full-width fluid layout so compact mode never overflows sidebar */
        .pm-compact { width: 100%; box-sizing: border-box; }
        .pm-compact > div { width: 100%; min-width: 0; box-sizing: border-box; }

        /* Agent selector buttons — chunky stone panels, fluid */
        .pm-compact .gm-btn {
          border-radius: 2px !important;
          padding: 8px 6px !important;
          border-width: 1px !important;
          font-family: var(--hm-font-display, 'Geist Sans', system-ui, sans-serif) !important;
          min-width: 0;
          overflow: hidden;
        }
        .pm-compact .gm-btn > div:first-child {
          font-size: 9px !important;
          letter-spacing: 0.12em !important;
        }
        .pm-compact .gm-btn > div:nth-child(2) {
          font-size: 18px !important;
        }
        .pm-compact .gm-btn-agent1:hover {
          box-shadow: 0 0 12px rgba(34,197,94,0.3), inset 0 1px 0 rgba(255,255,255,0.1) !important;
          border-color: rgba(34,197,94,0.5) !important;
        }
        .pm-compact .gm-btn-agent2:hover {
          box-shadow: 0 0 12px rgba(239,68,68,0.3), inset 0 1px 0 rgba(255,255,255,0.1) !important;
          border-color: rgba(239,68,68,0.5) !important;
        }

        /* STATS mini-buttons — hidden in compact mode, replaced by odds in agent button */
        .pm-compact .gm-btn-sm { display: none !important; }

        /* BUY/SELL toggle container — flat stone bar */
        .pm-compact .gm-tab-btn {
          border-radius: 2px !important;
          font-family: var(--hm-font-display, 'Geist Sans', system-ui, sans-serif) !important;
          font-size: 10px !important;
          letter-spacing: 0.08em !important;
          font-weight: 800 !important;
          min-height: 36px;
        }
        .pm-compact .gm-tab-btn:hover { filter: brightness(1.15); }

        /* Amount input — sharp corners, thicker border, prevent iOS zoom */
        .pm-compact .gm-amount-input {
          border-radius: 2px !important;
          border: 1px solid rgba(229,184,74,0.25) !important;
          font-family: var(--hm-font-mono, 'Geist Mono', monospace) !important;
          background: rgba(0,0,0,0.4) !important;
          font-size: 14px !important;
          width: 100% !important;
          box-sizing: border-box !important;
        }
        .pm-compact .gm-amount-input:focus {
          border-color: rgba(229,184,74,0.55) !important;
          box-shadow: 0 0 0 2px rgba(229,184,74,0.1), inset 0 2px 4px rgba(0,0,0,0.5) !important;
        }

        /* Submit button — matches the warm accent theme, touch-friendly */
        .pm-compact .gm-btn-submit {
          border-radius: 2px !important;
          font-family: var(--hm-font-display, 'Geist Sans', system-ui, sans-serif) !important;
          font-size: 11px !important;
          letter-spacing: 0.06em !important;
          font-weight: 800 !important;
          height: 40px !important;
          min-height: 40px !important;
          text-shadow: 0 1px 0 rgba(255,255,255,0.2) !important;
          width: 100% !important;
          touch-action: manipulation;
        }
        .pm-compact .gm-btn-submit:not(:disabled):hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(229,184,74,0.4), inset 0 1px 0 rgba(255,255,255,0.45) !important;
        }

        /* Divider lines */
        .pm-compact > div > div[style*="height: 1"] {
          background: linear-gradient(90deg, transparent, rgba(229,184,74,0.12), transparent) !important;
        }

        /* Touch action on agent buttons */
        .pm-compact .gm-btn,
        .pm-compact .gm-tab-btn {
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }

        /* ── Responsive: make wide grid stack on smaller screens ── */
        @media (max-width: 768px) {
          .pm-grid {
            grid-template-columns: 1fr 1fr !important;
          }
        }
        @media (max-width: 480px) {
          .pm-grid {
            grid-template-columns: 1fr !important;
          }
          .pm-grid > div:nth-child(n+2) {
            display: none !important;
          }
        }
      `}</style>
    </>
  );
}
