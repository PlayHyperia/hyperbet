import type { SolanaTransactionRecovery } from "../lib/solanaTransactionFeedback";
import {
  buildSolanaExplorerTransactionUrl,
  type SolanaTransactionStage,
} from "../lib/solanaTransactionFeedback";

export type SolanaTransactionFeedbackState =
  | { status: "idle"; signature: null; recovery: null; warning: null }
  | {
      status: SolanaTransactionStage | "confirmed";
      signature: string | null;
      recovery: null;
      warning: string | null;
    }
  | {
      status: "error";
      signature: string | null;
      recovery: SolanaTransactionRecovery;
      warning: string | null;
    };

export const IDLE_SOLANA_TRANSACTION_FEEDBACK: SolanaTransactionFeedbackState =
  {
    status: "idle",
    signature: null,
    recovery: null,
    warning: null,
  };

type SolanaTransactionFeedbackCardProps = {
  feedback: SolanaTransactionFeedbackState;
  message: string | null;
  cluster: string;
  testId: string;
  signatureTestId: string;
  signatureLabel: string;
  detailsLabel: string;
  receiptLabel: string;
  reviewLabel: string;
  checkStatusLabel: string;
  onReview: () => void;
};

export function SolanaTransactionFeedbackCard({
  feedback,
  message,
  cluster,
  testId,
  signatureTestId,
  signatureLabel,
  detailsLabel,
  receiptLabel,
  reviewLabel,
  checkStatusLabel,
  onReview,
}: SolanaTransactionFeedbackCardProps) {
  if (feedback.status === "idle" || !message) return null;

  const isError = feedback.status === "error";
  const isConfirmed = feedback.status === "confirmed";
  const isBusy = !isError && !isConfirmed;
  const explorerUrl = feedback.signature
    ? buildSolanaExplorerTransactionUrl(feedback.signature, cluster)
    : null;
  const requiresStatusCheck =
    isError &&
    feedback.signature !== null &&
    feedback.recovery.retryMode === "CHECK_STATUS_FIRST";
  const signatureProof = feedback.signature ? (
    <div style={{ display: "grid", gap: 3 }}>
      <span
        style={{
          color: "rgba(255,255,255,0.7)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
        }}
      >
        {signatureLabel}
      </span>
      <code
        data-testid={signatureTestId}
        style={{
          color: "rgba(255,255,255,0.72)",
          fontSize: 10,
          lineHeight: 1.5,
          overflowWrap: "anywhere",
          userSelect: "all",
        }}
      >
        {feedback.signature}
      </code>
    </div>
  ) : null;
  const tone = isError
    ? {
        border: "rgba(248,113,113,0.42)",
        background: "rgba(127,29,29,0.16)",
        foreground: "#fecaca",
        marker: "!",
      }
    : isConfirmed
      ? {
          border: "rgba(52,211,153,0.4)",
          background: "rgba(6,78,59,0.16)",
          foreground: "#a7f3d0",
          marker: "✓",
        }
      : {
          border: "rgba(96,165,250,0.4)",
          background: "rgba(30,64,175,0.14)",
          foreground: "#bfdbfe",
          marker: "…",
        };

  return (
    <section
      data-testid={testId}
      data-state={feedback.status}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      aria-busy={isBusy ? "true" : undefined}
      style={{
        display: "grid",
        gap: 9,
        padding: 12,
        borderRadius: "var(--hm-radius)",
        border: `1px solid ${tone.border}`,
        background: tone.background,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "20px minmax(0, 1fr)",
          alignItems: "start",
          gap: 7,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "grid",
            placeItems: "center",
            width: 18,
            height: 18,
            border: `1px solid ${tone.border}`,
            borderRadius: "50%",
            color: tone.foreground,
            fontSize: 11,
            fontWeight: 800,
            lineHeight: 1,
          }}
        >
          {tone.marker}
        </span>
        <strong
          style={{
            color: tone.foreground,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {message}
        </strong>
      </div>

      {isConfirmed && signatureProof ? (
        <details data-testid={`${testId}-details`}>
          <summary
            style={{
              display: "list-item",
              minHeight: 44,
              color: "#bfdbfe",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 700,
              lineHeight: "44px",
            }}
          >
            {detailsLabel}
          </summary>
          <div style={{ display: "grid", gap: 4, paddingBottom: 4 }}>
            {signatureProof}
            {explorerUrl ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`${receiptLabel}: ${signatureLabel}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  minHeight: 44,
                  color: "#bfdbfe",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {receiptLabel}
              </a>
            ) : null}
          </div>
        </details>
      ) : (
        signatureProof
      )}

      {feedback.warning ? (
        <span
          data-testid={`${testId}-warning`}
          style={{ color: "#fde68a", fontSize: 11, lineHeight: 1.55 }}
        >
          {feedback.warning}
        </span>
      ) : null}

      {(!isConfirmed && explorerUrl) || isError ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`${receiptLabel}: ${signatureLabel}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                padding: "6px 2px",
                color: "#bfdbfe",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {receiptLabel}
            </a>
          ) : null}
          {isError ? (
            <button
              type="button"
              onClick={onReview}
              data-testid={`${testId}-action`}
              style={{
                minHeight: 44,
                padding: "7px 10px",
                borderRadius: "var(--hm-radius)",
                border: "1px solid rgba(148,163,184,0.42)",
                background: "rgba(15,23,42,0.82)",
                color: "#f8fafc",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {requiresStatusCheck ? checkStatusLabel : reviewLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
