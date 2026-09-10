const transactionSignature = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/u;

export type RecoveredSignatureStatus = {
  err: unknown | null;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
};

export function extractRecoverableTransactionSignature(
  error: unknown,
): string | null {
  const message = error instanceof Error ? error.message : "";
  const candidate = message.match(
    /\bsignature\s+([1-9A-HJ-NP-Za-km-z]{32,88})\b/iu,
  )?.[1];
  return candidate && transactionSignature.test(candidate) ? candidate : null;
}

export function classifyRecoveredSignatureStatus(
  status: RecoveredSignatureStatus | null,
): "pending" | "confirmed" | "failed" {
  if (!status) return "pending";
  if (status.err !== null) return "failed";
  return status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
    ? "confirmed"
    : "pending";
}

export async function waitForConfirmedTransactionSignature(input: {
  timeoutMs: number;
  getStatus: () => Promise<RecoveredSignatureStatus | null>;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<boolean> {
  const {
    timeoutMs,
    getStatus,
    pollIntervalMs = 2_000,
    now = Date.now,
    sleep = (delayMs) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  } = input;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("transaction recovery timeout must be positive");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("transaction recovery poll interval must be positive");
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    const disposition = classifyRecoveredSignatureStatus(await getStatus());
    if (disposition === "confirmed") return true;
    if (disposition === "failed") return false;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}
