import { GAME_API_URL, buildArenaWriteHeaders } from "./solanaConfig";
import { getStoredInviteCode } from "./invite";

export interface RecordSolanaPredictionMarketTradeInput {
  bettorWallet: string;
  sourceAmountLamports: bigint;
  feeBps: number;
  txSignature: string;
  marketRef: string;
  duelKey: string;
  duelId: string;
}

function sanitizeNumber(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

// The keeper asks pending-finality callers to retry once per second. Keep the
// attempt ceiling above the wall-clock deadline so that the deadline, rather
// than an accidentally shorter request count, governs normal finalization.
// The separate ceiling still bounds a malformed zero-delay response loop.
const MAX_FINALIZATION_ATTEMPTS = 128;
const MAX_FINALIZATION_WAIT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5_000;

export function predictionMarketTrackingRetryDelayMs(
  response: Pick<Response, "headers">,
  attempt: number,
): number {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter === null ? NaN : Number(retryAfter);
  if (
    retryAfter !== null &&
    retryAfter.trim() !== "" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.min(MAX_RETRY_DELAY_MS, retryAfterSeconds * 1_000);
  }
  return Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function recordSolanaPredictionMarketTrade(
  input: RecordSolanaPredictionMarketTradeInput,
): Promise<boolean> {
  const marketRef = input.marketRef.trim();
  const duelKey = input.duelKey.trim().toLowerCase();
  const duelId = input.duelId.trim();
  if (
    !input.bettorWallet.trim() ||
    !input.txSignature.trim() ||
    !marketRef ||
    !/^[0-9a-f]{64}$/.test(duelKey) ||
    !duelId ||
    duelId.length > 256
  ) {
    return false;
  }

  const signature = input.txSignature.trim();
  const sourceAmountLamports =
    input.sourceAmountLamports > 0n ? input.sourceAmountLamports : 0n;
  const payload = {
    chainKey: "solana",
    chain: "SOLANA",
    bettorWallet: input.bettorWallet.trim(),
    sourceAsset: "SOL",
    sourceAmountLamports: sourceAmountLamports.toString(),
    feeBps: sanitizeNumber(input.feeBps),
    txSignature: signature,
    marketPda: marketRef,
    marketRef,
    duelKey,
    duelId,
    inviteCode: getStoredInviteCode(),
    externalBetRef: `solana:${signature}`,
  };
  const deadline = Date.now() + MAX_FINALIZATION_WAIT_MS;

  for (let attempt = 0; attempt < MAX_FINALIZATION_ATTEMPTS; attempt += 1) {
    if (attempt > 0 && Date.now() >= deadline) return false;
    try {
      const response = await fetch(
        `${GAME_API_URL.replace(/\/$/, "")}/api/arena/bet/record-external`,
        {
          method: "POST",
          headers: buildArenaWriteHeaders(),
          body: JSON.stringify(payload),
        },
      );
      if (response.ok) return true;
      const retryable = response.status === 425 || response.status === 503;
      if (!retryable || attempt === MAX_FINALIZATION_ATTEMPTS - 1) {
        return false;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await wait(
        Math.min(
          predictionMarketTrackingRetryDelayMs(response, attempt),
          remainingMs,
        ),
      );
    } catch (error) {
      if (attempt === MAX_FINALIZATION_ATTEMPTS - 1) {
        console.warn("[solana-market-tracking] failed to record trade", error);
        return false;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await wait(
        Math.min(Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt), remainingMs),
      );
    }
  }

  return false;
}
