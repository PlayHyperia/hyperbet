import { useId, type CSSProperties } from "react";

export type SolanaSettlementActionKind =
  "winnings" | "refund" | "cleanup" | "rent";

type SolanaSettlementActionCardProps = {
  kind: SolanaSettlementActionKind;
  eyebrow: string;
  title: string;
  helpText: string;
  amountLabel?: string;
  amountText?: string | null;
  buttonLabel: string;
  processingLabel: string;
  isProcessing: boolean;
  disabled?: boolean;
  onAction: () => void;
  testId?: string;
  actionTestId?: string;
};

type SettlementActionTone = {
  accent: string;
  accentSoft: string;
  border: string;
  background: string;
  buttonBackground: string;
  buttonBorder: string;
  buttonForeground: string;
  marker: string;
};

const TONES: Record<SolanaSettlementActionKind, SettlementActionTone> = {
  winnings: {
    accent: "#6ee7b7",
    accentSoft: "rgba(110,231,183,0.14)",
    border: "rgba(52,211,153,0.38)",
    background:
      "linear-gradient(145deg, rgba(6,78,59,0.3) 0%, rgba(6,44,35,0.18) 58%, rgba(12,18,26,0.78) 100%)",
    buttonBackground:
      "linear-gradient(180deg, rgba(16,185,129,0.95), rgba(5,150,105,0.92))",
    buttonBorder: "rgba(167,243,208,0.5)",
    buttonForeground: "#031b13",
    marker: "✓",
  },
  refund: {
    accent: "#67e8f9",
    accentSoft: "rgba(103,232,249,0.13)",
    border: "rgba(34,211,238,0.36)",
    background:
      "linear-gradient(145deg, rgba(14,116,144,0.28) 0%, rgba(8,51,68,0.2) 58%, rgba(12,18,26,0.78) 100%)",
    buttonBackground:
      "linear-gradient(180deg, rgba(34,211,238,0.94), rgba(6,182,212,0.9))",
    buttonBorder: "rgba(165,243,252,0.5)",
    buttonForeground: "#052027",
    marker: "↩",
  },
  cleanup: {
    accent: "#fbbf24",
    accentSoft: "rgba(251,191,36,0.13)",
    border: "rgba(245,158,11,0.38)",
    background:
      "linear-gradient(145deg, rgba(120,53,15,0.28) 0%, rgba(69,34,12,0.2) 58%, rgba(12,18,26,0.78) 100%)",
    buttonBackground:
      "linear-gradient(180deg, rgba(245,158,11,0.95), rgba(217,119,6,0.92))",
    buttonBorder: "rgba(253,230,138,0.5)",
    buttonForeground: "#251404",
    marker: "×",
  },
  rent: {
    accent: "#c4b5fd",
    accentSoft: "rgba(196,181,253,0.13)",
    border: "rgba(167,139,250,0.38)",
    background:
      "linear-gradient(145deg, rgba(76,29,149,0.25) 0%, rgba(46,25,82,0.2) 58%, rgba(12,18,26,0.78) 100%)",
    buttonBackground:
      "linear-gradient(180deg, rgba(167,139,250,0.96), rgba(139,92,246,0.92))",
    buttonBorder: "rgba(221,214,254,0.5)",
    buttonForeground: "#180b35",
    marker: "◎",
  },
};

export function SolanaSettlementActionCard({
  kind,
  eyebrow,
  title,
  helpText,
  amountLabel,
  amountText,
  buttonLabel,
  processingLabel,
  isProcessing,
  disabled = false,
  onAction,
  testId = "solana-settlement-action",
  actionTestId,
}: SolanaSettlementActionCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  const tone = TONES[kind];
  const actionDisabled = disabled || isProcessing;

  return (
    <section
      data-testid={testId}
      data-kind={kind}
      data-state={isProcessing ? "processing" : "ready"}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={isProcessing ? "true" : undefined}
      style={{
        position: "relative",
        display: "grid",
        gap: 14,
        padding: 15,
        borderRadius: "calc(var(--hm-radius, 8px) + 2px)",
        border: `1px solid ${tone.border}`,
        background: tone.background,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 30px rgba(0,0,0,0.2)",
      }}
    >
      <div
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "30px minmax(0, 1fr)",
          alignItems: "start",
          gap: 10,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            borderRadius: 9,
            border: `1px solid ${tone.border}`,
            background: tone.accentSoft,
            color: tone.accent,
            fontFamily: "var(--hm-font-display)",
            fontSize: 14,
            fontWeight: 900,
            lineHeight: 1,
          }}
        >
          {tone.marker}
        </span>

        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <span
            style={{
              color: tone.accent,
              fontFamily: "var(--hm-font-display)",
              fontSize: 9,
              fontWeight: 850,
              letterSpacing: "0.12em",
              lineHeight: 1.3,
              textTransform: "uppercase",
            }}
          >
            {eyebrow}
          </span>
          <strong
            id={titleId}
            style={{
              minWidth: 0,
              color: "var(--hm-text, #f8fafc)",
              fontFamily: "var(--hm-font-display)",
              fontSize: 14,
              fontWeight: 760,
              lineHeight: 1.35,
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </strong>
        </div>
      </div>

      {amountText ? (
        <div
          data-testid={`${testId}-amount`}
          style={{
            position: "relative",
            display: "grid",
            gap: 3,
            padding: "10px 12px",
            borderRadius: "var(--hm-radius, 8px)",
            border: `1px solid ${tone.border}`,
            background: "rgba(2,8,15,0.35)",
          }}
        >
          {amountLabel ? (
            <span
              style={{
                color: "rgba(226,232,240,0.62)",
                fontSize: 9,
                fontWeight: 760,
                letterSpacing: "0.08em",
                lineHeight: 1.4,
                textTransform: "uppercase",
              }}
            >
              {amountLabel}
            </span>
          ) : null}
          <strong
            style={{
              color: tone.accent,
              fontFamily: "var(--hm-font-mono)",
              fontSize: 17,
              fontVariantNumeric: "tabular-nums",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              lineHeight: 1.25,
              overflowWrap: "anywhere",
            }}
          >
            {amountText}
          </strong>
        </div>
      ) : null}

      <p
        id={descriptionId}
        style={{
          position: "relative",
          minWidth: 0,
          margin: 0,
          color: "var(--hm-panel-subtle-text, rgba(226,232,240,0.62))",
          fontSize: 11,
          lineHeight: 1.55,
          overflowWrap: "anywhere",
        }}
      >
        {helpText}
      </p>

      <button
        data-testid={actionTestId}
        type="button"
        aria-live="polite"
        aria-atomic="true"
        disabled={actionDisabled}
        onClick={onAction}
        style={
          {
            position: "relative",
            width: "100%",
            minHeight: 44,
            padding: "10px 14px",
            borderRadius: "var(--hm-radius, 8px)",
            border: `1px solid ${tone.buttonBorder}`,
            background: tone.buttonBackground,
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.25), 0 8px 18px rgba(0,0,0,0.2)",
            color: tone.buttonForeground,
            cursor: actionDisabled ? "not-allowed" : "pointer",
            fontFamily: "var(--hm-font-display)",
            fontSize: 12,
            fontWeight: 850,
            letterSpacing: "0.02em",
            lineHeight: 1.3,
            opacity: actionDisabled ? 0.58 : 1,
            transition:
              "filter 150ms ease, opacity 150ms ease, transform 150ms ease",
          } satisfies CSSProperties
        }
      >
        {isProcessing ? processingLabel : buttonLabel}
      </button>
    </section>
  );
}
