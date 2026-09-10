export type SolanaOrderQuoteNoticeKind =
  "input" | "loading" | "status" | "error";

type SolanaOrderQuoteNoticeProps = {
  kind: SolanaOrderQuoteNoticeKind;
  message: string;
};

export function SolanaOrderQuoteNotice({
  kind,
  message,
}: SolanaOrderQuoteNoticeProps) {
  const isInputSummary = kind === "input";
  const isError = kind === "error";
  const isLoading = kind === "loading";
  const role = isInputSummary ? undefined : isError ? "alert" : "status";

  return (
    <span
      data-testid="solana-order-quote-notice"
      data-kind={kind}
      role={role}
      aria-live={role ? (isError ? "assertive" : "polite") : undefined}
      aria-atomic={role ? "true" : undefined}
      aria-busy={isLoading ? "true" : undefined}
      style={{
        color:
          isInputSummary || isError
            ? "#fca5a5"
            : kind === "status"
              ? "#fde68a"
              : "#bfdbfe",
        lineHeight: 1.45,
      }}
    >
      {message}
    </span>
  );
}
