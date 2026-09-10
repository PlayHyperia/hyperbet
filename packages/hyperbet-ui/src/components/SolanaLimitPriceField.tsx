import { useId } from "react";

export interface SolanaLimitPriceFieldProps {
  value: string;
  label: string;
  helpText: string;
  errorMessage?: string | null;
  onChange: (value: string) => void;
}

export function SolanaLimitPriceField({
  value,
  label,
  helpText,
  errorMessage = null,
  onChange,
}: SolanaLimitPriceFieldProps) {
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const describedBy = errorMessage ? `${helpId} ${errorId}` : helpId;

  return (
    <div
      data-testid="solana-limit-price-field"
      style={{
        marginTop: 12,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 92px",
        alignItems: "center",
        gap: "6px 10px",
        color: "#d4d4d8",
        fontFamily: "var(--hm-font-body)",
        fontSize: 12,
      }}
    >
      <label htmlFor={inputId} style={{ lineHeight: 1.4 }}>
        {label}
      </label>
      <input
        id={inputId}
        name="limitProbabilityMillis"
        type="text"
        data-testid="solana-clob-price-input"
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
        inputMode="numeric"
        enterKeyHint="done"
        autoComplete="off"
        spellCheck={false}
        maxLength={3}
        pattern="[0-9]{1,3}"
        aria-describedby={describedBy}
        aria-invalid={errorMessage ? "true" : "false"}
        aria-errormessage={errorMessage ? errorId : undefined}
        style={{
          width: 92,
          minHeight: 44,
          boxSizing: "border-box",
          padding: "8px 10px",
          borderRadius: 8,
          border: errorMessage
            ? "1px solid rgba(248,113,113,0.68)"
            : "1px solid rgba(255,255,255,0.14)",
          background: "rgba(17,24,39,0.65)",
          color: "#f4f4f5",
          fontFamily: "var(--hm-font-mono)",
          fontVariantNumeric: "tabular-nums",
        }}
      />
      <span
        id={helpId}
        style={{
          gridColumn: "1 / -1",
          color: "rgba(255,255,255,0.52)",
          lineHeight: 1.4,
        }}
      >
        {helpText}
      </span>
      {errorMessage ? (
        <span
          id={errorId}
          role="alert"
          style={{
            gridColumn: "1 / -1",
            color: "#fca5a5",
            lineHeight: 1.4,
          }}
        >
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
