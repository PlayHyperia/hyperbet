import { normalizePredictionMarketDuelKeyHex } from "@hyperbet/ui/lib/solanaPredictionMarkets";

export type SolanaBettorShellMode =
  | "loading"
  | "unavailable"
  | "watching"
  | "tradeable"
  | "locked"
  | "settlement"
  | "refund";

export type SolanaBettorShellReason =
  | "checking-programs"
  | "programs-unavailable"
  | "waiting-lifecycle"
  | "stream-disconnected"
  | "stream-stale"
  | "stream-identity-mismatch"
  | "checking-keeper"
  | "keeper-unavailable"
  | "legal-documents-unavailable"
  | "verifying-market"
  | "market-open"
  | "market-locked"
  | "duel-complete-settlement-pending"
  | "duel-cancelled-settlement-pending"
  | "result-proposed"
  | "result-challenged"
  | "settlement-available"
  | "refund-review";

export interface SolanaBettorShellInput {
  programsChecked: boolean;
  programsReady: boolean;
  walletConnected: boolean;
  legalDocumentsReady: boolean;
  keeperChecked: boolean;
  keeperReady: boolean;
  nowMs: number;
  streamMaxAgeMs: number;
  streamConnected: boolean;
  hasReceivedStreamState: boolean;
  streamCycle: {
    cycleId?: string | null;
    phase?: string | null;
    emittedAt?: number | null;
    duelId?: string | null;
    duelKeyHex?: string | null;
    agent1Name?: string | null;
    agent2Name?: string | null;
  } | null;
  lifecycleDuel: {
    duelId?: string | null;
    duelKey?: string | null;
    agent1Name?: string | null;
    agent2Name?: string | null;
  } | null;
  lifecycleMarket: {
    duelId?: string | null;
    duelKey?: string | null;
    marketRef?: string | null;
    lifecycleStatus?: string | null;
  } | null;
  marketSnapshot: {
    duelKeyHex?: string | null;
    marketRef?: string | null;
    marketStatus?: string | null;
    tradingReady?: boolean | null;
  } | null;
}

export interface SolanaBettorShellState {
  mode: SolanaBettorShellMode;
  reason: SolanaBettorShellReason;
  authoritativeDuelKey: string | null;
  authoritativeDuelId: string | null;
  agent1Name: string | null;
  agent2Name: string | null;
  hasMatchup: boolean;
  canOpenMarketPanel: boolean;
  canAccessMarketPanel: boolean;
  canPlaceBet: boolean;
  showMarketData: boolean;
  activityLabel: "LIVE" | "CONNECTED" | "RECONNECTING" | "UNAVAILABLE";
  actionLabel:
    | "Place Bet"
    | "View Market"
    | "View Settlement"
    | "Review Refund"
    | "View Activity"
    | "Betting unavailable";
}

/**
 * Once the interactive market has mounted, keep it mounted for the lifetime of
 * the page. Authority/readiness changes still fail closed through
 * `canPlaceBet`, but retaining the component preserves submitted transaction
 * receipts, recovery actions, and managed-order state through brief feed or
 * keeper interruptions.
 */
export function retainSolanaMarketPanelSession(input: {
  retained: boolean;
  canAccessMarketPanel: boolean;
}): boolean {
  return input.retained || input.canAccessMarketPanel;
}

export type SolanaProgramDeploymentSnapshot = {
  checked: boolean;
  cluster: boolean;
  oracle: boolean;
  market: boolean;
  verifiedAtMs: number | null;
};

export function isSolanaProgramDeploymentReady(input: {
  snapshot: SolanaProgramDeploymentSnapshot;
  nowMs: number;
  maxAgeMs: number;
}): boolean {
  const { snapshot, nowMs, maxAgeMs } = input;
  if (
    !snapshot.checked ||
    !snapshot.cluster ||
    !snapshot.oracle ||
    !snapshot.market ||
    snapshot.verifiedAtMs === null ||
    !Number.isFinite(snapshot.verifiedAtMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0
  ) {
    return false;
  }
  const ageMs = nowMs - snapshot.verifiedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

export function getSolanaBettorShellMessage(
  reason: SolanaBettorShellReason,
): string {
  switch (reason) {
    case "checking-programs":
      return "Checking Solana market availability…";
    case "programs-unavailable":
      return "Betting is temporarily unavailable.";
    case "waiting-lifecycle":
      return "Waiting for a verified Solana market.";
    case "stream-disconnected":
      return "Live market connection interrupted. Betting is paused.";
    case "stream-stale":
      return "Live market updates are delayed. Betting is paused.";
    case "stream-identity-mismatch":
      return "Verifying the current duel. Betting is paused.";
    case "checking-keeper":
      return "Checking Solana market services…";
    case "keeper-unavailable":
      return "Solana market services are temporarily unavailable.";
    case "legal-documents-unavailable":
      return "Betting is temporarily unavailable.";
    case "verifying-market":
      return "Verifying the Solana market…";
    case "market-open":
      return "Betting open.";
    case "market-locked":
      return "Betting locked.";
    case "duel-complete-settlement-pending":
      return "Duel complete. On-chain settlement is pending.";
    case "duel-cancelled-settlement-pending":
      return "Duel cancelled. On-chain settlement is pending.";
    case "result-proposed":
      return "Result proposed. Dispute window open.";
    case "result-challenged":
      return "Result challenged. Resolution pending.";
    case "settlement-available":
      return "Settlement available.";
    case "refund-review":
      return "Review refund status.";
  }
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  );
}

export function normalizePublicLegalDocumentUrl(
  value: string | null | undefined,
  pageOrigin: string,
): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (!normalized.startsWith("/") && !/^https?:\/\//i.test(normalized)) {
    return null;
  }
  try {
    const url = new URL(normalized, pageOrigin);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && isLocalHostname(url.hostname)) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function resolvePublicLegalDocumentUrls(
  input: {
    termsUrl?: string | null;
    privacyUrl?: string | null;
  },
  pageOrigin: string,
): { termsUrl: string; privacyUrl: string } | null {
  const termsUrl = normalizePublicLegalDocumentUrl(input.termsUrl, pageOrigin);
  const privacyUrl = normalizePublicLegalDocumentUrl(
    input.privacyUrl,
    pageOrigin,
  );
  return termsUrl && privacyUrl ? { termsUrl, privacyUrl } : null;
}

export function hasRequiredSolanaLegalDocuments(input: {
  isLocalTestCluster: boolean;
  legalDocumentUrls: { termsUrl: string; privacyUrl: string } | null;
}): boolean {
  // Localnet uses disposable test funds and cannot create a real-money
  // transaction. Public clusters remain fail-closed until both legal
  // documents resolve to accepted URLs.
  return input.isLocalTestCluster || input.legalDocumentUrls !== null;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeLifecycleStatus(value: string | null | undefined): string {
  return normalizeText(value)?.toUpperCase() ?? "UNKNOWN";
}

function normalizeMarketStatus(value: string | null | undefined): string {
  return normalizeText(value)?.toLowerCase() ?? "unavailable";
}

function isTerminalOrLocked(status: string): boolean {
  return ["LOCKED", "PROPOSED", "CHALLENGED", "RESOLVED", "CANCELLED"].includes(
    status,
  );
}

export function deriveSolanaBettorShellState(
  input: SolanaBettorShellInput,
): SolanaBettorShellState {
  const lifecycleDuelKey = normalizePredictionMarketDuelKeyHex(
    input.lifecycleDuel?.duelKey,
  );
  const lifecycleMarketKey = normalizePredictionMarketDuelKeyHex(
    input.lifecycleMarket?.duelKey,
  );
  const lifecycleDuelId = normalizeText(input.lifecycleDuel?.duelId);
  const lifecycleMarketDuelId = normalizeText(input.lifecycleMarket?.duelId);
  const lifecycleIdentityMatches =
    lifecycleDuelKey !== null &&
    lifecycleDuelKey === lifecycleMarketKey &&
    lifecycleDuelId !== null &&
    lifecycleDuelId === lifecycleMarketDuelId;
  const authoritativeDuelKey = lifecycleIdentityMatches
    ? lifecycleMarketKey
    : null;
  const authoritativeDuelId = lifecycleIdentityMatches
    ? lifecycleMarketDuelId
    : null;

  const streamDuelKey = normalizePredictionMarketDuelKeyHex(
    input.streamCycle?.duelKeyHex,
  );
  const streamDuelId = normalizeText(input.streamCycle?.duelId);
  const streamCycleId = normalizeText(input.streamCycle?.cycleId);
  const streamAgent1Name = normalizeText(input.streamCycle?.agent1Name);
  const streamAgent2Name = normalizeText(input.streamCycle?.agent2Name);
  const emittedAt = input.streamCycle?.emittedAt;
  const streamAgeMs =
    typeof emittedAt === "number" && Number.isFinite(emittedAt) && emittedAt > 0
      ? Math.max(0, input.nowMs - emittedAt)
      : null;
  const streamFrameFresh =
    streamAgeMs !== null &&
    Number.isFinite(input.streamMaxAgeMs) &&
    input.streamMaxAgeMs > 0 &&
    streamAgeMs <= input.streamMaxAgeMs;
  const streamHasCanonicalIdentity =
    input.streamConnected &&
    streamFrameFresh &&
    streamCycleId !== null &&
    streamCycleId !== "cycle-0" &&
    streamDuelKey !== null &&
    streamDuelId !== null &&
    streamAgent1Name !== null &&
    streamAgent2Name !== null;
  const streamMatchesLifecycle =
    streamHasCanonicalIdentity &&
    lifecycleIdentityMatches &&
    streamDuelKey === authoritativeDuelKey &&
    streamDuelId === authoritativeDuelId;
  const phase = normalizeText(input.streamCycle?.phase)?.toUpperCase();

  const lifecycleAgent1Name = normalizeText(input.lifecycleDuel?.agent1Name);
  const lifecycleAgent2Name = normalizeText(input.lifecycleDuel?.agent2Name);
  const lifecycleHasNames =
    lifecycleAgent1Name !== null && lifecycleAgent2Name !== null;
  const lifecycleStatus = normalizeLifecycleStatus(
    input.lifecycleMarket?.lifecycleStatus,
  );
  const lifecycleAllowsHistoricalAccess =
    lifecycleIdentityMatches && isTerminalOrLocked(lifecycleStatus);
  const canUseLiveMatchup = streamMatchesLifecycle;
  const canUseLifecycleMatchup =
    lifecycleAllowsHistoricalAccess && lifecycleHasNames;
  const agent1Name = canUseLiveMatchup
    ? streamAgent1Name
    : canUseLifecycleMatchup
      ? lifecycleAgent1Name
      : null;
  const agent2Name = canUseLiveMatchup
    ? streamAgent2Name
    : canUseLifecycleMatchup
      ? lifecycleAgent2Name
      : null;
  const hasMatchup = agent1Name !== null && agent2Name !== null;

  const openMarketHasAuthority =
    lifecycleStatus === "OPEN" && streamMatchesLifecycle;
  const canOpenMarketPanel =
    input.programsReady &&
    lifecycleIdentityMatches &&
    ((openMarketHasAuthority &&
      input.keeperReady &&
      input.legalDocumentsReady) ||
      lifecycleAllowsHistoricalAccess);
  const canAccessMarketPanel =
    canOpenMarketPanel || (input.programsReady && input.walletConnected);
  const snapshotDuelKey = normalizePredictionMarketDuelKeyHex(
    input.marketSnapshot?.duelKeyHex,
  );
  const lifecycleMarketRef = normalizeText(input.lifecycleMarket?.marketRef);
  const snapshotMarketRef = normalizeText(input.marketSnapshot?.marketRef);
  const snapshotMarketStatus = normalizeMarketStatus(
    input.marketSnapshot?.marketStatus,
  );
  const snapshotMatches =
    canOpenMarketPanel &&
    snapshotDuelKey !== null &&
    snapshotDuelKey === authoritativeDuelKey &&
    lifecycleMarketRef !== null &&
    snapshotMarketRef === lifecycleMarketRef &&
    ["open", "locked", "resolved", "cancelled"].includes(snapshotMarketStatus);
  const canPlaceBet =
    openMarketHasAuthority &&
    input.programsReady &&
    snapshotMatches &&
    input.marketSnapshot?.tradingReady === true &&
    snapshotMarketStatus === "open";

  let mode: SolanaBettorShellMode = "unavailable";
  let reason: SolanaBettorShellReason = "waiting-lifecycle";
  let actionLabel: SolanaBettorShellState["actionLabel"] =
    "Betting unavailable";

  if (!input.programsChecked) {
    mode = "loading";
    reason = "checking-programs";
  } else if (!input.programsReady) {
    reason = "programs-unavailable";
  } else if (!lifecycleIdentityMatches) {
    reason = "waiting-lifecycle";
  } else if (lifecycleStatus === "OPEN" && !input.streamConnected) {
    reason = "stream-disconnected";
  } else if (lifecycleStatus === "OPEN" && !streamFrameFresh) {
    reason = "stream-stale";
  } else if (lifecycleStatus === "OPEN" && !streamMatchesLifecycle) {
    reason = "stream-identity-mismatch";
  } else if (lifecycleStatus === "OPEN" && !input.keeperChecked) {
    mode = "loading";
    reason = "checking-keeper";
  } else if (lifecycleStatus === "OPEN" && !input.keeperReady) {
    reason = "keeper-unavailable";
  } else if (lifecycleStatus === "OPEN" && !input.legalDocumentsReady) {
    reason = "legal-documents-unavailable";
  } else if (lifecycleStatus === "OPEN" && !canPlaceBet) {
    mode = "watching";
    reason = "verifying-market";
    actionLabel = "View Market";
  } else if (lifecycleStatus === "OPEN") {
    mode = "tradeable";
    reason = "market-open";
    actionLabel = "Place Bet";
  } else if (
    lifecycleStatus === "LOCKED" &&
    streamMatchesLifecycle &&
    phase === "RESOLUTION"
  ) {
    mode = "locked";
    reason = "duel-complete-settlement-pending";
    actionLabel = "View Market";
  } else if (
    lifecycleStatus === "LOCKED" &&
    streamMatchesLifecycle &&
    phase === "CANCELLED"
  ) {
    mode = "locked";
    reason = "duel-cancelled-settlement-pending";
    actionLabel = "View Market";
  } else if (lifecycleStatus === "LOCKED") {
    mode = "locked";
    reason = "market-locked";
    actionLabel = "View Market";
  } else if (lifecycleStatus === "PROPOSED") {
    mode = "locked";
    reason = "result-proposed";
    actionLabel = "View Market";
  } else if (lifecycleStatus === "CHALLENGED") {
    mode = "locked";
    reason = "result-challenged";
    actionLabel = "View Market";
  } else if (lifecycleStatus === "RESOLVED") {
    mode = "settlement";
    reason = "settlement-available";
    actionLabel = "View Settlement";
  } else if (lifecycleStatus === "CANCELLED") {
    mode = "refund";
    reason = "refund-review";
    actionLabel = "Review Refund";
  }

  if (
    actionLabel === "Betting unavailable" &&
    canAccessMarketPanel &&
    (!lifecycleIdentityMatches || lifecycleStatus === "UNKNOWN")
  ) {
    mode = "watching";
    actionLabel = "View Activity";
  }

  const activityLabel =
    streamMatchesLifecycle && phase === "FIGHTING"
      ? "LIVE"
      : streamMatchesLifecycle
        ? "CONNECTED"
        : input.hasReceivedStreamState &&
            (!input.streamConnected || !streamFrameFresh)
          ? "RECONNECTING"
          : "UNAVAILABLE";

  return {
    mode,
    reason,
    authoritativeDuelKey,
    authoritativeDuelId,
    agent1Name,
    agent2Name,
    hasMatchup,
    canOpenMarketPanel,
    canAccessMarketPanel,
    canPlaceBet,
    showMarketData: snapshotMatches,
    activityLabel,
    actionLabel,
  };
}
