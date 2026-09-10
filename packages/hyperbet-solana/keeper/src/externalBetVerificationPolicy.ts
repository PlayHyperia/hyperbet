export type ExternalBetVerificationFailureCode =
  | "context-unavailable"
  | "request-identity-invalid"
  | "expected-identity-invalid"
  | "expected-identity-missing"
  | "transaction-not-found"
  | "transaction-meta-missing"
  | "transaction-failed"
  | "transaction-signature-mismatch"
  | "indexed-evidence-invalid"
  | "indexed-transaction-shape"
  | "indexed-order-identity"
  | "indexed-market-query-failed"
  | "indexed-market-identity"
  | "indexed-accounting-invalid"
  | "wallet-signature-mismatch"
  | "market-instruction-count"
  | "place-order-data-invalid"
  | "instruction-account-graph"
  | "market-account-identity"
  | "market-pda-identity"
  | "market-fee-snapshot"
  | "event-market-invalid"
  | "order-placed-event-invalid"
  | "order-matched-event-invalid"
  | "self-trade-event-invalid"
  | "fee-event-invalid"
  | "inner-instructions-missing"
  | "transfer-event-invalid"
  | "transaction-query-failed"
  | "market-account-query-failed"
  | "duel-id-query-failed"
  | "duel-id-identity"
  | "event-decode-failed"
  | "accounting-failed";

const RETRYABLE_FINALIZED_VISIBILITY_FAILURES =
  new Set<ExternalBetVerificationFailureCode>([
    "transaction-not-found",
    "transaction-query-failed",
    "market-account-query-failed",
    "indexed-market-query-failed",
    "duel-id-query-failed",
  ]);

/**
 * A finalized signature can become visible before its parsed transaction or
 * dependent accounts reach the verifier's RPC/index view. Those visibility
 * races are retryable; semantic identity or accounting failures remain final.
 */
export function resolveExternalBetVerificationFailure(input: {
  finality: "pending" | "finalized";
  code: ExternalBetVerificationFailureCode;
}): "retry" | "reject" {
  if (input.finality === "pending") return "retry";
  return RETRYABLE_FINALIZED_VISIBILITY_FAILURES.has(input.code)
    ? "retry"
    : "reject";
}
