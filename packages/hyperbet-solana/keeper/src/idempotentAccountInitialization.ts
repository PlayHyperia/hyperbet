export type IdempotentAccountInitializationOptions = {
  isInitialized: () => Promise<boolean>;
  submit: () => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (context: {
    attempt: number;
    maxAttempts: number;
    error: unknown;
  }) => void;
};

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * Retries only deterministic account initialization. On-chain state is the
 * sole success signal after every submission: this keeps a late-confirmed
 * first attempt from becoming a duplicate mutation, rejects misleading error
 * text, and fails closed if a nominally successful submission creates nothing.
 */
export async function ensureIdempotentAccountInitialized({
  isInitialized,
  submit,
  maxAttempts = 2,
  retryDelayMs = 1_000,
  sleep = defaultSleep,
  onRetry,
}: IdempotentAccountInitializationOptions): Promise<void> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("retryDelayMs must be a non-negative number");
  }

  if (await isInitialized()) return;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let submissionError: unknown = null;
    try {
      await submit();
    } catch (error) {
      submissionError = error;
    }

    if (await isInitialized()) return;

    const failure =
      submissionError ??
      new Error(
        "Account initialization submission completed, but the deterministic account is unavailable",
      );
    if (attempt >= maxAttempts) throw failure;

    onRetry?.({ attempt, maxAttempts, error: failure });
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }
}
