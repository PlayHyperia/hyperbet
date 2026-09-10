import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { resolveUiLocale, type UiLocale } from "@hyperbet/ui/i18n";
import {
  emitHyperbetProductEvent,
  rememberBoundedProductEventKey,
} from "@hyperbet/ui/lib/productAnalytics";

import {
  DEFAULT_REFRESH_INTERVAL_MS,
  CONFIG,
  UI_SYNC_DELAY_MS,
  getFixedMatchId,
  getCluster,
  STREAM_URLS,
} from "./lib/config";
import { captureInviteCodeFromLocation } from "@hyperbet/ui/lib/invite";
import {
  normalizePredictionMarketDuelKeyHex,
  usePredictionMarketLifecycle,
} from "@hyperbet/ui/lib/solanaPredictionMarkets";
import {
  useAppConnection,
  useAppWallet,
  useAppWalletModal,
} from "./lib/appWalletContext";
import {
  deriveSolanaBettorShellState,
  getSolanaBettorShellMessage,
  hasRequiredSolanaLegalDocuments,
  isSolanaProgramDeploymentReady,
  retainSolanaMarketPanelSession,
  resolvePublicLegalDocumentUrls,
} from "./lib/solanaBettorShell";
import { useSolanaLaunchReadiness } from "./lib/useSolanaLaunchReadiness";
import {
  deriveStreamFailoverDecision,
  isAuthoritativeStreamPlaybackReady,
  isStreamPlaybackTransportReady,
  isStreamTransportPlaybackReady,
} from "./lib/streamFailover";
import { inspectSolanaClusterIdentity } from "./lib/solanaClusterIdentity";
import { resolveSolanaPollingPolicy } from "./lib/solanaPollingPolicy";
import { SolanaPointsDisplay } from "@hyperbet/ui/components/SolanaPointsDisplay";
import type { SolanaClobMarketSnapshot } from "@hyperbet/ui/components/SolanaClobPanel";
import { getDuelStateDecoder } from "./generated/fight-oracle/accounts";
import {
  FightOracleAccount,
  identifyFightOracleAccount,
  FIGHT_ORACLE_PROGRAM_ADDRESS,
} from "./generated/fight-oracle/programs";
import { FIGHT_ORACLE_PROGRAM_ID } from "./lib/programIds";
import { useStreamingState } from "./spectator/useStreamingState";
import { deriveSpectatorActionFeed } from "./spectator/actionFeed";
import { deriveSpectatorPreparation } from "./spectator/preparation";
import {
  formatCompetitiveDisclosureLabel,
  isCompetitiveDisclosureTradeReady,
  parseCompetitiveDisclosurePair,
} from "./spectator/competitiveDisclosure";
import {
  buildStreamReadinessDiagnostics,
  classifySpectatorTerminalOutcome,
  deriveSpectatorPresentationState,
  getSpectatorStatusCopy,
  getSpectatorTerminalMarketFallbackCopy,
  getSpectatorMatchupHeading,
  getStreamRecoveryDetail,
  getStreamRecoveryHeading,
  getStreamRecoveryMode,
  selectSpectatorDisplayPhase,
  selectSpectatorPresentationUpdate,
} from "./spectator/presentation";
import {
  getSpectatorBottomTabs,
  selectRovingTabFromKey,
  selectSpectatorTabFromKey,
  shouldShowBetActionIcon,
  type SpectatorBottomTab,
} from "./spectator/accessibility";
import { lockModalDocumentScroll } from "./spectator/modalAccessibility";
import type { LeaderboardEntry } from "./spectator/types";
import { useResizePanel, useIsMobile } from "@hyperbet/ui/lib/useResizePanel";
import { ResizeHandle } from "@hyperbet/ui/components/ResizeHandle";

// ── Shared UI utilities ──────────────────────────────────────────────────────
function formatAmount(v: number, locale: UiLocale = "en"): string {
  if (locale === "zh" || locale === "ko") {
    const yi = locale === "zh" ? "亿" : "억";
    const wan = locale === "zh" ? "万" : "만";
    if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}${yi}`;
    if (v >= 10_000) return `${(v / 10_000).toFixed(1)}${wan}`;
  } else {
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  }
  return String(v);
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function trapFocusWithin(
  event: ReactKeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !container) return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]") &&
      element.getClientRects().length > 0,
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    container.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function readSolanaE2eRuntimeOverride(): {
  duelKey: string | null;
  duelId: string | null;
  marketRef: string | null;
} {
  if (typeof window === "undefined") {
    return {
      duelKey: null,
      duelId: null,
      marketRef: null,
    };
  }

  const searchParams = new URLSearchParams(window.location.search);
  const duelKey = normalizePredictionMarketDuelKeyHex(
    searchParams.get("e2eSolanaDuelKey") ??
      searchParams.get("e2eDuelKey") ??
      window.localStorage.getItem("hyperbet.e2e.solanaDuelKey") ??
      "",
  );
  const duelId =
    searchParams.get("e2eSolanaDuelId") ??
    searchParams.get("e2eDuelId") ??
    window.localStorage.getItem("hyperbet.e2e.solanaDuelId") ??
    null;
  const marketRef =
    searchParams.get("e2eSolanaMarketRef") ??
    searchParams.get("e2eMarketRef") ??
    window.localStorage.getItem("hyperbet.e2e.solanaMarketRef") ??
    null;

  return {
    duelKey,
    duelId: duelId?.trim() || null,
    marketRef: marketRef?.trim() || null,
  };
}

function formatTimeAgo(ts: number, locale: UiLocale = "en"): string {
  const ago = Math.floor((Date.now() - ts) / 1000);
  if (ago < 0) {
    const nowMap: Record<string, string> = {
      zh: "刚刚",
      ko: "방금",
      pt: "agora",
      es: "ahora",
    };
    return nowMap[locale] ?? "just now";
  }
  const mins = Math.floor(ago / 60);
  if (locale === "zh") {
    if (mins > 0) return `${mins}分前`;
    return `${ago}秒前`;
  }
  if (locale === "ko") {
    if (mins > 0) return `${mins}분 전`;
    return `${ago}초 전`;
  }
  if (locale === "pt") {
    if (mins > 0) return `${mins}m atrás`;
    return `${ago}s atrás`;
  }
  if (locale === "es") {
    if (mins > 0) return `hace ${mins}m`;
    return `hace ${ago}s`;
  }
  if (mins > 0) return `${mins}m`;
  return `${ago}s`;
}

function getAppCopy(locale: UiLocale) {
  if (locale === "zh") {
    return {
      points: "积分",
      leaderboard: "排行榜",
      history: "历史",
      referral: "推荐",
      loadingLeaderboard: "正在加载排行榜",
      loadingHistory: "正在加载历史",
      loadingReferral: "正在加载推荐",
      loadingAgentStats: "正在加载代理数据",
      leaderboardAndStats: "排行榜与统计",
      unmuteStream: "开启声音",
      muteStream: "静音",
      source: "信源",
      waitingForStream: "等待直播流…",
      trades: "成交",
      orderBook: "订单簿",
      matchLog: "对局日志",
      agents: "智能体",
      positions: "仓位",
      pool: "资金池",
      side: "方向",
      agent: "智能体",
      price: "价格",
      amount: "数量",
      age: "时间",
      trader: "交易者",
      buy: "买入",
      sell: "卖出",
      bids: (name: string) => `买盘（${name}）`,
      asks: (name: string) => `卖盘（${name}）`,
      spread: (value: number) => `价差：${value}%`,
      rank: "排名",
      provider: "提供方",
      wins: "胜场",
      losses: "负场",
      winRate: "胜率",
      streak: "连胜",
      hp: "生命",
      wl: "胜负",
      dmg: "伤害",
      action: "动",
      thought: "思",
      result: "结果",
      winner: (name: string, reason: string | null | undefined) =>
        `${name} 获胜${reason ? `！${reason}` : "！"}`,
      noOpenPositions: "暂无未平仓仓位",
      tradingControls: "交易控件",
      closeTradingPanel: "关闭交易面板",
      openTradingPanel: "打开交易面板",
      placeBet: "下注",
      legalLead: "交易即表示你同意",
      terms: "条款",
      privacy: "隐私",
      round: (value: string) => `第 ${value} 回合`,
      live: "直播",
      stable: "稳定",
      synthetic: "合成",
      phaseLive: "直播",
      phaseStarting: (value: string | number | null) =>
        `即将开始 ${value ?? ""}`,
      phaseResolved: "已结算",
      phaseNextMatch: "下一场",
      phaseIdle: "空闲",
      bettingUnavailable: (cluster: string) =>
        `${cluster} 上的下注暂时不可用。请稍后重试并检查 Solana 连接。`,
      record: (wins: number, losses: number) => `${wins}胜-${losses}负`,
      streakValue: (value: number) => `${value}连胜`,
      level: (value: number) => ` · 等级 ${value}`,
      statusOpen: "开放",
      statusResolved: "已结算",
      statusPending: "待定",
    };
  }

  if (locale === "ko") {
    return {
      points: "포인트",
      leaderboard: "리더보드",
      history: "기록",
      referral: "추천",
      loadingLeaderboard: "리더보드 로딩 중",
      loadingHistory: "기록 로딩 중",
      loadingReferral: "추천 로딩 중",
      loadingAgentStats: "에이전트 통계 로딩 중",
      leaderboardAndStats: "리더보드 & 통계",
      unmuteStream: "소리 켜기",
      muteStream: "음소거",
      source: "소스",
      waitingForStream: "스트림 대기 중…",
      trades: "거래",
      orderBook: "호가창",
      matchLog: "경기 로그",
      agents: "에이전트",
      positions: "포지션",
      pool: "풀",
      side: "방향",
      agent: "에이전트",
      price: "가격",
      amount: "수량",
      age: "시간",
      trader: "트레이더",
      buy: "매수",
      sell: "매도",
      bids: (name: string) => `매수호가 (${name})`,
      asks: (name: string) => `매도호가 (${name})`,
      spread: (value: number) => `스프레드: ${value}%`,
      rank: "순위",
      provider: "제공자",
      wins: "승",
      losses: "패",
      winRate: "승률",
      streak: "연승",
      hp: "HP",
      wl: "승/패",
      dmg: "피해",
      action: "행동",
      thought: "생각",
      result: "결과",
      winner: (name: string, reason: string | null | undefined) =>
        `${name} 승리!${reason ? ` ${reason}` : ""}`,
      noOpenPositions: "미결 포지션 없음",
      tradingControls: "거래 컨트롤",
      closeTradingPanel: "거래 패널 닫기",
      openTradingPanel: "거래 패널 열기",
      placeBet: "베팅하기",
      legalLead: "거래 시 동의한 것으로 간주됩니다:",
      terms: "이용약관",
      privacy: "개인정보",
      round: (value: string) => `${value}라운드`,
      live: "라이브",
      stable: "안정",
      synthetic: "합성",
      phaseLive: "라이브",
      phaseStarting: (value: string | number | null) =>
        `시작 중 ${value ?? ""}`,
      phaseResolved: "정산 완료",
      phaseNextMatch: "다음 경기",
      phaseIdle: "대기",
      bettingUnavailable: (cluster: string) =>
        `${cluster}에서 베팅이 일시적으로 불가능합니다. 나중에 다시 시도하고 Solana 연결을 확인하세요.`,
      record: (wins: number, losses: number) => `${wins}승-${losses}패`,
      streakValue: (value: number) => `${value}연승`,
      level: (value: number) => ` · Lv.${value}`,
      statusOpen: "진행 중",
      statusResolved: "정산 완료",
      statusPending: "대기 중",
    };
  }

  if (locale === "pt") {
    return {
      points: "Pontos",
      leaderboard: "Ranking",
      history: "Histórico",
      referral: "Indicação",
      loadingLeaderboard: "Carregando ranking",
      loadingHistory: "Carregando histórico",
      loadingReferral: "Carregando indicação",
      loadingAgentStats: "Carregando estatísticas do agente",
      leaderboardAndStats: "Ranking & Estatísticas",
      unmuteStream: "Ativar som",
      muteStream: "Silenciar",
      source: "Fonte",
      waitingForStream: "Aguardando transmissão…",
      trades: "Negociações",
      orderBook: "Livro de Ordens",
      matchLog: "Log da Luta",
      agents: "Agentes",
      positions: "Posições",
      pool: "Pool",
      side: "Lado",
      agent: "Agente",
      price: "Preço",
      amount: "Quantidade",
      age: "Tempo",
      trader: "Trader",
      buy: "COMPRAR",
      sell: "VENDER",
      bids: (name: string) => `COMPRAS (${name})`,
      asks: (name: string) => `VENDAS (${name})`,
      spread: (value: number) => `Spread: ${value}%`,
      rank: "Posição",
      provider: "Provedor",
      wins: "Vitórias",
      losses: "Derrotas",
      winRate: "Taxa de Vitória",
      streak: "Sequência",
      hp: "HP",
      wl: "V/D",
      dmg: "Dano",
      action: "AÇÃO",
      thought: "PEN",
      result: "RESULTADO",
      winner: (name: string, reason: string | null | undefined) =>
        `${name} vence!${reason ? ` ${reason}` : ""}`,
      noOpenPositions: "Sem posições abertas",
      tradingControls: "Controles de negociação",
      closeTradingPanel: "Fechar painel de negociação",
      openTradingPanel: "Abrir painel de negociação",
      placeBet: "Apostar",
      legalLead: "Ao negociar, você concorda com nossos",
      terms: "Termos",
      privacy: "Privacidade",
      round: (value: string) => `Rodada #${value}`,
      live: "AO VIVO",
      stable: "ESTÁVEL",
      synthetic: "SINTÉTICO",
      phaseLive: "AO VIVO",
      phaseStarting: (value: string | number | null) =>
        `Iniciando ${value ?? ""}`,
      phaseResolved: "RESOLVIDO",
      phaseNextMatch: "PRÓXIMA PARTIDA",
      phaseIdle: "INATIVO",
      bettingUnavailable: (cluster: string) =>
        `Apostas temporariamente indisponíveis em ${cluster}. Tente novamente mais tarde e verifique a conexão Solana.`,
      record: (wins: number, losses: number) => `${wins}V-${losses}D`,
      streakValue: (value: number) => `${value}V`,
      level: (value: number) => ` · Nv.${value}`,
      statusOpen: "ABERTO",
      statusResolved: "RESOLVIDO",
      statusPending: "PENDENTE",
    };
  }

  if (locale === "es") {
    return {
      points: "Puntos",
      leaderboard: "Ranking",
      history: "Historial",
      referral: "Referido",
      loadingLeaderboard: "Cargando clasificación",
      loadingHistory: "Cargando historial",
      loadingReferral: "Cargando referidos",
      loadingAgentStats: "Cargando estadísticas del agente",
      leaderboardAndStats: "Ranking y Stats",
      unmuteStream: "Activar sonido",
      muteStream: "Silenciar",
      source: "Fuente",
      waitingForStream: "Esperando transmisión…",
      trades: "Trades",
      orderBook: "Libro de Órdenes",
      matchLog: "Registro de Pelea",
      agents: "Agentes",
      positions: "Posiciones",
      pool: "Pool",
      side: "Lado",
      agent: "Agente",
      price: "Precio",
      amount: "Cantidad",
      age: "Tiempo",
      trader: "Trader",
      buy: "COMPRAR",
      sell: "VENDER",
      bids: (name: string) => `COMPRAS (${name})`,
      asks: (name: string) => `VENTAS (${name})`,
      spread: (value: number) => `Spread: ${value}%`,
      rank: "Rango",
      provider: "Proveedor",
      wins: "Victorias",
      losses: "Derrotas",
      winRate: "Tasa de Victoria",
      streak: "Racha",
      hp: "HP",
      wl: "V/D",
      dmg: "Daño",
      action: "ACC",
      thought: "PEN",
      result: "RESULTADO",
      winner: (name: string, reason: string | null | undefined) =>
        `¡${name} gana!${reason ? ` ${reason}` : ""}`,
      noOpenPositions: "Sin posiciones abiertas",
      tradingControls: "Controles de operación",
      closeTradingPanel: "Cerrar panel de operaciones",
      openTradingPanel: "Abrir panel de operaciones",
      placeBet: "Apostar",
      legalLead: "Al operar, aceptas nuestros",
      terms: "Términos",
      privacy: "Privacidad",
      round: (value: string) => `Ronda #${value}`,
      live: "EN VIVO",
      stable: "ESTABLE",
      synthetic: "SINTÉTICO",
      phaseLive: "EN VIVO",
      phaseStarting: (value: string | number | null) =>
        `Iniciando ${value ?? ""}`,
      phaseResolved: "RESUELTO",
      phaseNextMatch: "SIGUIENTE PARTIDA",
      phaseIdle: "INACTIVO",
      bettingUnavailable: (cluster: string) =>
        `Las apuestas no están disponibles temporalmente en ${cluster}. Inténtalo más tarde y comprueba la conexión de Solana.`,
      record: (wins: number, losses: number) => `${wins}V-${losses}D`,
      streakValue: (value: number) => `${value}V`,
      level: (value: number) => ` · Nv.${value}`,
      statusOpen: "ABIERTO",
      statusResolved: "RESUELTO",
      statusPending: "PENDIENTE",
    };
  }

  return {
    points: "Points",
    leaderboard: "Leaderboard",
    history: "History",
    referral: "Referral",
    loadingLeaderboard: "Loading leaderboard",
    loadingHistory: "Loading history",
    loadingReferral: "Loading referral",
    loadingAgentStats: "Loading agent stats",
    leaderboardAndStats: "Leaderboard & Stats",
    unmuteStream: "Unmute stream",
    muteStream: "Mute stream",
    source: "Source",
    waitingForStream: "Waiting for stream…",
    trades: "Trades",
    orderBook: "Order Book",
    matchLog: "Match Log",
    agents: "Agents",
    positions: "Positions",
    pool: "Pool",
    side: "Side",
    agent: "Agent",
    price: "Price",
    amount: "Amount",
    age: "Age",
    trader: "Trader",
    buy: "BUY",
    sell: "SELL",
    bids: (name: string) => `BIDS (${name})`,
    asks: (name: string) => `ASKS (${name})`,
    spread: (value: number) => `Spread: ${value}%`,
    rank: "Rank",
    provider: "Provider",
    wins: "Wins",
    losses: "Losses",
    winRate: "Win Rate",
    streak: "Streak",
    hp: "HP",
    wl: "W/L",
    dmg: "Dmg",
    action: "ACT",
    thought: "THK",
    result: "RESULT",
    winner: (name: string, reason: string | null | undefined) =>
      `${name} wins!${reason ? ` ${reason}` : ""}`,
    noOpenPositions: "No open positions",
    tradingControls: "Trading controls",
    closeTradingPanel: "Close trading panel",
    openTradingPanel: "Open trading panel",
    placeBet: "Place Bet",
    legalLead: "By trading, you agree to our",
    terms: "Terms",
    privacy: "Privacy",
    round: (value: string) => `Round #${value}`,
    live: "LIVE",
    stable: "STABLE",
    synthetic: "SYNTHETIC",
    phaseLive: "LIVE",
    phaseStarting: (value: string | number | null) => `Starting ${value ?? ""}`,
    phaseResolved: "RESOLVED",
    phaseNextMatch: "NEXT MATCH",
    phaseIdle: "IDLE",
    bettingUnavailable: (cluster: string) =>
      `Betting is temporarily unavailable on ${cluster}. Please try again later and check the Solana connection.`,
    record: (wins: number, losses: number) => `${wins}W-${losses}L`,
    streakValue: (value: number) => `${value}W`,
    level: (value: number) => ` · Lv.${value}`,
    statusOpen: "OPEN",
    statusResolved: "RESOLVED",
    statusPending: "PENDING",
  };
}

function _getPhaseLabel(
  phase: string,
  countdown: string | number | null,
  copy: ReturnType<typeof getAppCopy>,
): string {
  if (phase === "FIGHTING") return copy.phaseLive;
  if (phase === "COUNTDOWN") return copy.phaseStarting(countdown);
  if (phase === "RESOLUTION") return copy.phaseResolved;
  if (phase === "ANNOUNCEMENT") return copy.phaseNextMatch;
  return copy.phaseIdle;
}

function _getMarketStatusLabel(
  rawStatus: string | null | undefined,
  copy: ReturnType<typeof getAppCopy>,
): string {
  const normalized = rawStatus?.trim().toLowerCase();
  if (!normalized) return copy.statusPending;
  if (normalized === "open") return copy.statusOpen;
  if (normalized === "resolved") return copy.statusResolved;
  if (normalized === "pending" || normalized === "unavailable") {
    return copy.statusPending;
  }
  return rawStatus ?? copy.statusPending;
}

function truncateAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatItemLabel(itemId: string): string {
  return itemId
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatWinReason(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason.trim().toLowerCase()) {
    case "kill":
      return "Knockout";
    case "hp_advantage":
      return "Health advantage at the time limit";
    case "damage_advantage":
      return "Damage advantage at the time limit";
    case "forfeit":
      return "Forfeit";
    case "timeout":
      return "Time limit reached";
    default:
      return null;
  }
}

function formatAgentWinRate(wins: number, losses: number): string {
  const decidedDuels = Math.max(0, wins) + Math.max(0, losses);
  const percent =
    decidedDuels > 0 ? (Math.max(0, wins) / decidedDuels) * 100 : 0;
  return `${percent.toFixed(1)}%`;
}

type BetSide = "YES" | "NO";

type DiscoveredMatch = {
  matchId: number;
  status: "open" | "resolved" | "unknown";
  openTs: number;
  closeTs: number;
  resolvedTs: number | null;
  winner: BetSide | null;
  agent1Name: string | null;
  agent2Name: string | null;
};

type DuelMetadata = {
  duelId?: number;
  matchId?: number;
  agent1?: string;
  agent2?: string;
};

type ProgramDeploymentState = {
  checked: boolean;
  cluster: boolean;
  oracle: boolean;
  market: boolean;
  verifiedAtMs: number | null;
};

const EMPTY_SOLANA_CLOB_SNAPSHOT: SolanaClobMarketSnapshot = {
  duelKeyHex: null,
  marketRef: null,
  competitiveSnapshotVersion: null,
  competitiveSnapshotDigest: null,
  tradingReady: false,
  matchLabel: "-",
  marketStatus: "PENDING",
  yesProbabilityPercent: null,
  yesPool: 0n,
  noPool: 0n,
  bids: [],
  asks: [],
  recentTrades: [],
  chartData: [],
};
const BETTOR_STREAM_MAX_AGE_MS = 15_000;
const PROGRAM_DEPLOYMENT_MAX_AGE_MS = 15_000;
type PointsDrawerTab = "leaderboard" | "history" | "referral";
const SOLANA_POLLING_POLICY = resolveSolanaPollingPolicy({
  configuredRefreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
  programVerificationMaxAgeMs: PROGRAM_DEPLOYMENT_MAX_AGE_MS,
});

function normalizeTimestamp(value: number): number {
  if (value > 1_000_000_000_000) return Math.floor(value / 1000);
  return Math.floor(value);
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function enumIs(value: unknown, variant: string): boolean {
  if (!value || typeof value !== "object") return false;
  const key = Object.keys(value as Record<string, unknown>)[0];
  return key === variant;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toString" in value) {
    const parsed = Number((value as { toString: () => string }).toString());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function sideFromEnum(value: unknown): BetSide | null {
  if (enumIs(value, "yes")) return "YES";
  if (enumIs(value, "no")) return "NO";
  return null;
}

function solDisplay(amount: unknown): string {
  const raw = asNumber(amount, 0);
  return (raw / LAMPORTS_PER_SOL).toFixed(6);
}
const SolanaClobPanel = lazy(() =>
  import("./components/SolanaClobPanel").then((module) => ({
    default: module.SolanaClobPanel,
  })),
);
const StreamPlayer = lazy(() =>
  import("@hyperbet/ui/components/StreamPlayer").then((module) => ({
    default: module.StreamPlayer,
  })),
);
const OddsHistoryChart = lazy(() =>
  import("./components/OddsHistoryChart").then((module) => ({
    default: module.OddsHistoryChart,
  })),
);
const PointsLeaderboard = lazy(() =>
  import("@hyperbet/ui/components/PointsLeaderboard").then((module) => ({
    default: module.PointsLeaderboard,
  })),
);
const PointsHistory = lazy(() =>
  import("@hyperbet/ui/components/PointsHistory").then((module) => ({
    default: module.PointsHistory,
  })),
);
const SolanaReferralPanel = lazy(() =>
  import("@hyperbet/ui/components/SolanaReferralPanel").then((module) => ({
    default: module.SolanaReferralPanel,
  })),
);
function PanelFallback({
  label,
  minHeight = 220,
}: {
  label: string;
  minHeight?: number;
}) {
  return (
    <div
      style={{
        minHeight,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.03)",
        color: "rgba(255,255,255,0.58)",
        textTransform: "uppercase",
        letterSpacing: 1,
        fontSize: 12,
      }}
    >
      {label}
    </div>
  );
}

function StreamPlayerFallback() {
  return (
    <div
      className="hm-game-placeholder"
      role="status"
      aria-live="polite"
      data-testid="stream-player-loading"
    >
      <div className="hm-game-bg" />
      <span className="hm-game-waiting">
        Loading secure live stream&hellip;
      </span>
    </div>
  );
}

export function App() {
  const locale = resolveUiLocale();
  const copy = getAppCopy(locale);
  const { connection } = useAppConnection();
  const wallet = useAppWallet();
  const { setVisible: setSolModalVisible } = useAppWalletModal();
  const isE2eMode = import.meta.env.MODE === "e2e";
  const isE2eDebugMode =
    isE2eMode && new URLSearchParams(window.location.search).has("debug");
  const isLocalTestCluster = getCluster() === "localnet";
  const transactionsEnabled = CONFIG.transactionsEnabled;
  const solanaWalletAddress = transactionsEnabled
    ? (wallet.publicKey?.toBase58() ?? null)
    : null;
  const shouldPollChainData = transactionsEnabled;
  const pointsWalletAddress = solanaWalletAddress;

  const [status, setStatus] = useState<string>("");
  const [currentMatch, setCurrentMatch] = useState<DiscoveredMatch | null>(
    null,
  );
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [programVerificationNonce, setProgramVerificationNonce] = useState(0);
  const [, setClockRevision] = useState(0);
  // The interval expires idle authority, but incoming stream frames can render
  // between ticks. Evaluate them against this render's precise wall clock.
  const nowMs = Date.now();
  const nowTs = Math.floor(nowMs / 1_000);
  const [programDeployment, setProgramDeployment] =
    useState<ProgramDeploymentState>({
      checked: false,
      cluster: false,
      oracle: false,
      market: false,
      verifiedAtMs: null,
    });
  const [solanaClobSnapshot, setSolanaClobSnapshot] =
    useState<SolanaClobMarketSnapshot>(EMPTY_SOLANA_CLOB_SNAPSHOT);
  const [streamSourceIndex, setStreamSourceIndex] = useState(0);
  const [showPointsDrawer, setShowPointsDrawer] = useState(false);
  const pointsDrawerRef = useRef<HTMLDivElement | null>(null);
  const pointsDrawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const rpcUnavailableStatus =
    "Market data is temporarily unavailable. Please try again shortly.";

  // ── Resizable panels ─────────────────────────────────────────────────────
  // Track mobile breakpoint — inline resize styles must NOT apply on mobile
  // because they override CSS media-query layout (sidebar fixed sheet, etc.)
  const isMobile = useIsMobile(768);

  // Sidebar width (right column)
  const { size: sidebarWidthPx, startDrag: startSidebarDrag } = useResizePanel({
    initial: 344,
    min: 300,
    max: 520,
    storageKey: "hyperia-duel-sidebar-v2",
  });
  // Bottom panel height
  const { size: bottomHeightPx, startDrag: startBottomDrag } = useResizePanel({
    initial: 200,
    min: 140,
    max: 360,
    storageKey: "hyperia-duel-bottom-v2",
  });
  const [pointsDrawerTab, setPointsDrawerTab] =
    useState<PointsDrawerTab>("leaderboard");
  const pointsDrawerTabRefs = useRef<
    Partial<Record<PointsDrawerTab, HTMLButtonElement | null>>
  >({});
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const bettingDockInnerRef = useRef<HTMLDivElement | null>(null);
  const productAnalyticsKeysRef = useRef(new Set<string>());
  const streamAnalyticsReadyRef = useRef(false);
  const [streamPlaybackDateMs, setStreamPlaybackDateMs] = useState<
    number | null
  >(null);

  const {
    state: streamingState,
    isConnected: streamingConnected,
    currentState: currentStreamingState,
    isCurrentConnected: currentStreamingConnected,
    isRendererReady,
  } = useStreamingState({ presentationTimeMs: streamPlaybackDateMs });
  const launchReadiness = useSolanaLaunchReadiness({
    enabled: transactionsEnabled,
  });
  const rawLiveCycle = streamingState?.cycle ?? null;
  const lastPresentableMatchRef = useRef<NonNullable<
    typeof streamingState
  > | null>(null);
  const { duel: lifecycleDuel, market: lifecycleMarket } =
    usePredictionMarketLifecycle("solana");
  const runtimeE2eOverride = useMemo(
    () =>
      isE2eMode
        ? readSolanaE2eRuntimeOverride()
        : {
            duelKey: null,
            duelId: null,
            marketRef: null,
          },
    [isE2eMode],
  );
  const streamSources = STREAM_URLS;
  const activeStreamUrl = streamSources[streamSourceIndex] ?? "";
  const [streamPlaybackReady, setStreamPlaybackReady] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const failedStreamSourceIndexesRef = useRef<number[]>([]);
  const streamRecoveryTimerRef = useRef<number | null>(null);
  const legalDocumentUrls = useMemo(
    () =>
      resolvePublicLegalDocumentUrls(
        {
          termsUrl: import.meta.env.VITE_TERMS_URL,
          privacyUrl: import.meta.env.VITE_PRIVACY_URL,
        },
        window.location.origin,
      ),
    [],
  );

  const switchToBackupStream = useCallback(() => {
    setStreamPlaybackReady(false);
    if (streamRecoveryTimerRef.current !== null) return;
    const decision = deriveStreamFailoverDecision({
      currentSourceIndex: streamSourceIndex,
      failedSourceIndexes: failedStreamSourceIndexesRef.current,
      sourceCount: streamSources.length,
    });
    failedStreamSourceIndexesRef.current = decision.failedSourceIndexes;
    if (!decision.exhausted) {
      setStreamSourceIndex(decision.nextSourceIndex);
      return;
    }
    if (streamSources.length === 0) return;
    streamRecoveryTimerRef.current = window.setTimeout(() => {
      streamRecoveryTimerRef.current = null;
      failedStreamSourceIndexesRef.current = [];
      setStreamSourceIndex(decision.nextSourceIndex);
      setStreamAttempt((current) => current + 1);
    }, 5_000);
  }, [streamSourceIndex, streamSources.length]);

  const cycleStreamSource = useCallback(() => {
    setStreamPlaybackReady(false);
    if (streamRecoveryTimerRef.current !== null) {
      window.clearTimeout(streamRecoveryTimerRef.current);
      streamRecoveryTimerRef.current = null;
    }
    failedStreamSourceIndexesRef.current = [];
    setStreamAttempt((current) => current + 1);
    setStreamSourceIndex((current) =>
      streamSources.length > 1 ? (current + 1) % streamSources.length : current,
    );
  }, [streamSources.length]);

  const handleStreamReady = useCallback(() => {
    if (streamRecoveryTimerRef.current !== null) {
      window.clearTimeout(streamRecoveryTimerRef.current);
      streamRecoveryTimerRef.current = null;
    }
    failedStreamSourceIndexesRef.current = [];
    setStreamPlaybackReady(true);
  }, []);

  const handleStreamUnavailable = useCallback(() => {
    setStreamPlaybackDateMs(null);
    setStreamPlaybackReady(false);
    switchToBackupStream();
  }, [switchToBackupStream]);

  const handleStreamPlaybackDateChange = useCallback(
    (playbackDateMs: number | null) => {
      setStreamPlaybackDateMs(playbackDateMs);
    },
    [],
  );

  useEffect(() => {
    if (streamSourceIndex < streamSources.length) return;
    failedStreamSourceIndexesRef.current = [];
    setStreamSourceIndex(0);
  }, [streamSourceIndex, streamSources.length]);

  useEffect(
    () => () => {
      if (streamRecoveryTimerRef.current !== null) {
        window.clearTimeout(streamRecoveryTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    captureInviteCodeFromLocation();
  }, []);

  const openPointsDrawer = useCallback(() => {
    pointsDrawerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setShowPointsDrawer(true);
  }, []);

  const closePointsDrawer = useCallback(() => {
    setShowPointsDrawer(false);
    window.requestAnimationFrame(() =>
      pointsDrawerReturnFocusRef.current?.focus(),
    );
  }, []);

  useEffect(() => {
    if (!showPointsDrawer) return;
    window.requestAnimationFrame(() => {
      pointsDrawerRef.current
        ?.querySelector<HTMLElement>('[data-testid="points-drawer-close"]')
        ?.focus();
    });
  }, [showPointsDrawer]);

  useEffect(() => {
    const appRoot = appRootRef.current;
    if (!appRoot) return;

    if (isE2eDebugMode) {
      appRoot.style.setProperty("--betting-dock-height", "0px");
      return;
    }

    const dockInner = bettingDockInnerRef.current;
    if (!dockInner) return;

    const updateDockHeight = () => {
      const nextHeight = Math.ceil(dockInner.getBoundingClientRect().height);
      appRoot.style.setProperty("--betting-dock-height", `${nextHeight}px`);
    };

    updateDockHeight();

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updateDockHeight())
        : null;
    resizeObserver?.observe(dockInner);
    window.addEventListener("resize", updateDockHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateDockHeight);
    };
  }, [isE2eDebugMode]);

  const fixedMatchId = getFixedMatchId();

  const programsReady = isSolanaProgramDeploymentReady({
    snapshot: programDeployment,
    nowMs,
    maxAgeMs: PROGRAM_DEPLOYMENT_MAX_AGE_MS,
  });

  const missingProgramMessage = useMemo(() => {
    if (!programDeployment.cluster) {
      return `The Solana RPC network does not match ${getCluster()}. Trading is disabled.`;
    }
    if (getCluster() === "localnet" && programsReady) return "";
    if (
      programDeployment.oracle &&
      programDeployment.market &&
      !programsReady
    ) {
      return "Solana program verification is delayed. Trading remains paused while the app retries.";
    }
    if (programDeployment.oracle && programDeployment.market) return "";
    return `Betting is temporarily unavailable on ${getCluster()}. Please try again later.`;
  }, [
    programDeployment.cluster,
    programDeployment.oracle,
    programDeployment.market,
    programsReady,
  ]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setClockRevision((revision) => revision + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!shouldPollChainData) return;
    const id = window.setInterval(() => {
      setProgramVerificationNonce((value) => value + 1);
    }, SOLANA_POLLING_POLICY.programVerificationIntervalMs);
    return () => window.clearInterval(id);
  }, [shouldPollChainData]);

  useEffect(() => {
    if (!shouldPollChainData) {
      setProgramDeployment({
        checked: true,
        cluster: true,
        oracle: true,
        market: true,
        verifiedAtMs: Date.now(),
      });
      return;
    }
    if (
      !connection ||
      typeof (connection as { getAccountInfo?: unknown }).getAccountInfo !==
        "function"
    ) {
      setProgramDeployment({
        checked: true,
        cluster: false,
        oracle: false,
        market: false,
        verifiedAtMs: null,
      });
      setStatus(rpcUnavailableStatus);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const [clusterIdentity, oracleInfo, marketInfo] = await Promise.all([
          inspectSolanaClusterIdentity(connection, getCluster()),
          connection.getAccountInfo(
            new PublicKey(
              CONFIG.fightOracleProgramId || FIGHT_ORACLE_PROGRAM_ADDRESS,
            ),
            "confirmed",
          ),
          connection.getAccountInfo(
            new PublicKey(CONFIG.duelMarketProgramId),
            "confirmed",
          ),
        ]);
        if (cancelled) return;
        setProgramDeployment({
          checked: true,
          cluster: clusterIdentity.matches,
          oracle: Boolean(oracleInfo?.executable),
          market: Boolean(marketInfo?.executable),
          verifiedAtMs: Date.now(),
        });
      } catch {
        if (cancelled) return;
        setProgramDeployment({
          checked: true,
          cluster: false,
          oracle: false,
          market: false,
          verifiedAtMs: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    connection,
    programVerificationNonce,
    rpcUnavailableStatus,
    shouldPollChainData,
  ]);

  useEffect(() => {
    if (!programDeployment.checked) return;
    if (programsReady) return;
    setStatus(missingProgramMessage);
  }, [programDeployment.checked, programsReady, missingProgramMessage]);

  useEffect(() => {
    if (!shouldPollChainData) return;
    const id = window.setInterval(() => {
      setRefreshNonce((value) => value + 1);
    }, SOLANA_POLLING_POLICY.matchDiscoveryIntervalMs);
    return () => clearInterval(id);
  }, [shouldPollChainData]);

  useEffect(() => {
    if (!shouldPollChainData) return;
    if (
      !connection ||
      typeof (connection as { getProgramAccounts?: unknown })
        .getProgramAccounts !== "function"
    ) {
      setStatus(rpcUnavailableStatus);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const allDuelAccounts = await connection.getProgramAccounts(
          FIGHT_ORACLE_PROGRAM_ID,
          "confirmed",
        );
        const matches = allDuelAccounts
          .filter((entry) => {
            try {
              return (
                identifyFightOracleAccount(entry.account.data) ===
                FightOracleAccount.DuelState
              );
            } catch {
              return false;
            }
          })
          .map<DiscoveredMatch>((entry) => {
            const account = getDuelStateDecoder().decode(entry.account.data);
            const status =
              enumIs(account.status, "bettingOpen") ||
              enumIs(account.status, "locked")
                ? "open"
                : enumIs(account.status, "resolved")
                  ? "resolved"
                  : "unknown";

            const openTs = normalizeTimestamp(asNumber(account.betOpenTs, 0));
            const closeTs = normalizeTimestamp(asNumber(account.betCloseTs, 0));
            const resolvedTs = account.duelEndTs
              ? normalizeTimestamp(asNumber(account.duelEndTs))
              : null;

            const metadataUri =
              (account.metadataUri as string | undefined) ?? "";
            let agent1Name: string | null = null;
            let agent2Name: string | null = null;
            let matchId = 0;
            try {
              if (metadataUri.startsWith("{")) {
                const meta = JSON.parse(metadataUri) as DuelMetadata;
                agent1Name = meta.agent1?.trim() || null;
                agent2Name = meta.agent2?.trim() || null;
                matchId = Number(meta.duelId ?? meta.matchId ?? 0);
              }
            } catch {
              // Ignore malformed inline metadata and fall back to defaults.
            }

            return {
              matchId,
              status,
              openTs,
              closeTs,
              resolvedTs,
              winner: sideFromEnum(account.winner),
              agent1Name,
              agent2Name,
            };
          })
          .sort(
            (a: DiscoveredMatch, b: DiscoveredMatch) =>
              b.openTs - a.openTs ||
              b.matchId - a.matchId ||
              b.closeTs - a.closeTs,
          );

        let nextCurrent: DiscoveredMatch | null = null;
        const openMatches = matches
          .filter((value) => value.status === "open")
          .sort(
            (a, b) =>
              b.openTs - a.openTs ||
              b.matchId - a.matchId ||
              b.closeTs - a.closeTs,
          );

        if (fixedMatchId) {
          nextCurrent =
            matches.find((value) => value.matchId === fixedMatchId) ?? null;
        }

        if (!nextCurrent) {
          nextCurrent = openMatches[0] ?? matches[0] ?? null;
        }

        if (cancelled) return;

        // Delay UI state application to synchronize with public stream latency
        window.setTimeout(() => {
          if (cancelled) return;
          setCurrentMatch(nextCurrent);
          setStatus("");
        }, UI_SYNC_DELAY_MS);
      } catch {
        if (!cancelled) {
          setStatus(
            "Market data is temporarily unavailable. Retrying shortly.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    shouldPollChainData,
    connection,
    refreshNonce,
    fixedMatchId,
    UI_SYNC_DELAY_MS,
    rpcUnavailableStatus,
  ]);

  const handleRefresh = () => {
    setRefreshNonce((value) => value + 1);
    setProgramVerificationNonce((value) => value + 1);
    window.dispatchEvent(new CustomEvent("hyperbet:market-refresh"));
  };

  const handleSolanaClobSnapshot = useCallback(
    (snapshot: SolanaClobMarketSnapshot) => {
      setSolanaClobSnapshot(snapshot);
    },
    [],
  );

  const activeLifecycleMarket =
    runtimeE2eOverride.duelKey &&
    normalizePredictionMarketDuelKeyHex(lifecycleMarket?.duelKey ?? null) !==
      runtimeE2eOverride.duelKey
      ? null
      : lifecycleMarket;
  const activeLifecycleDuel =
    runtimeE2eOverride.duelKey &&
    normalizePredictionMarketDuelKeyHex(lifecycleDuel?.duelKey ?? null) !==
      runtimeE2eOverride.duelKey
      ? null
      : lifecycleDuel;
  const streamPlaybackTransportReady = isStreamPlaybackTransportReady({
    telemetryConnected: streamingConnected,
    playbackReady: streamPlaybackReady,
    playbackDateMs: streamPlaybackDateMs,
  });
  const currentStreamAuthorityReady = isStreamTransportPlaybackReady({
    telemetryConnected: currentStreamingConnected,
    playbackReady: streamPlaybackReady,
    playbackDateMs: streamPlaybackDateMs,
    rendererReady: isRendererReady,
  });
  // Current wall-clock authority is the wagering boundary. A timeline frame
  // that is valid for delayed viewing must never reopen a stale market.
  const currentAuthorityPresentation = deriveSpectatorPresentationState({
    state: currentStreamingState,
    streamConnected: currentStreamAuthorityReady,
    nowMs,
    streamMaxAgeMs: BETTOR_STREAM_MAX_AGE_MS,
    uiSyncDelayMs: UI_SYNC_DELAY_MS,
  });
  const publicStreamConnected = isAuthoritativeStreamPlaybackReady({
    telemetryConnected: currentStreamingConnected,
    playbackReady: streamPlaybackReady,
    playbackDateMs: streamPlaybackDateMs,
    rendererReady: isRendererReady,
    presentationReady: currentAuthorityPresentation.hasFreshCycle,
  });
  const bettorShell = deriveSolanaBettorShellState({
    programsChecked: programDeployment.checked,
    programsReady,
    walletConnected: pointsWalletAddress !== null,
    legalDocumentsReady: hasRequiredSolanaLegalDocuments({
      isLocalTestCluster,
      legalDocumentUrls,
    }),
    keeperChecked: launchReadiness.checked,
    keeperReady: launchReadiness.ready,
    nowMs,
    streamMaxAgeMs: BETTOR_STREAM_MAX_AGE_MS,
    streamConnected: publicStreamConnected,
    hasReceivedStreamState: currentStreamingState !== null,
    streamCycle: currentStreamingState?.cycle
      ? {
          cycleId: currentStreamingState.cycle.cycleId,
          phase: currentStreamingState.cycle.phase,
          emittedAt: currentStreamingState.emittedAt,
          duelId:
            runtimeE2eOverride.duelId ?? currentStreamingState.cycle.duelId,
          duelKeyHex:
            runtimeE2eOverride.duelKey ??
            currentStreamingState.cycle.duelKeyHex ??
            null,
          agent1Name: currentStreamingState.cycle.agent1?.name,
          agent2Name: currentStreamingState.cycle.agent2?.name,
        }
      : null,
    lifecycleDuel: activeLifecycleDuel,
    lifecycleMarket: activeLifecycleMarket,
    marketSnapshot: solanaClobSnapshot,
  });
  // Spectator authority is evaluated at the HLS program-date playhead. The
  // latest capture can already be between rounds (or recovering) while the
  // viewer is still watching a renderer-verified terminal frame. Preserve the
  // result for that bounded handoff; transaction controls above remain tied to
  // current wall-clock authority.
  const playbackAuthorityNowMs = streamPlaybackDateMs ?? nowMs;
  const playbackPresentation = deriveSpectatorPresentationState({
    state: streamingState,
    streamConnected: streamPlaybackTransportReady,
    nowMs: playbackAuthorityNowMs,
    streamMaxAgeMs: BETTOR_STREAM_MAX_AGE_MS,
    uiSyncDelayMs: UI_SYNC_DELAY_MS,
  });
  if (playbackPresentation.hasMatchup && streamingState) {
    lastPresentableMatchRef.current = streamingState;
  }
  const spectatorStreamingState = selectSpectatorPresentationUpdate(
    streamingState,
    lastPresentableMatchRef.current,
    streamPlaybackTransportReady,
  );
  const spectatorPresentation = deriveSpectatorPresentationState({
    state: spectatorStreamingState,
    streamConnected: streamPlaybackTransportReady,
    nowMs: playbackAuthorityNowMs,
    streamMaxAgeMs: BETTOR_STREAM_MAX_AGE_MS,
    uiSyncDelayMs: UI_SYNC_DELAY_MS,
  });
  const streamRecoveryInput = {
    playbackReady: streamPlaybackReady,
    telemetryConnected: streamingConnected,
    rendererReady:
      isRendererReady && currentAuthorityPresentation.rendererReady,
    hasStreamState: streamingState !== null,
    presentationReady: spectatorPresentation.hasFreshCycle,
  };
  const streamRecoveryHeading = getStreamRecoveryHeading(streamRecoveryInput);
  const streamRecoveryMode = getStreamRecoveryMode(streamRecoveryInput);
  const streamRecoveryDetail = getStreamRecoveryDetail(streamRecoveryMode);
  const streamReadinessDiagnostics = buildStreamReadinessDiagnostics({
    evaluatedNowMs: nowMs,
    recoveryMode: streamRecoveryMode,
    hookRendererReady: isRendererReady,
    currentPresentationRendererReady:
      currentAuthorityPresentation.rendererReady,
    currentConnected: currentStreamingConnected,
    presentationConnected: streamingConnected,
    playbackReady: streamPlaybackReady,
    playbackDateMs: streamPlaybackDateMs,
    maxAgeMs: BETTOR_STREAM_MAX_AGE_MS,
    uiSyncDelayMs: UI_SYNC_DELAY_MS,
    currentState: currentStreamingState,
    presentationState: spectatorStreamingState,
  });
  const liveCycle = spectatorStreamingState?.cycle ?? rawLiveCycle;
  const competitiveDisclosure = liveCycle
    ? parseCompetitiveDisclosurePair({
        phase: liveCycle.phase,
        competitiveSnapshotVersion: liveCycle.competitiveSnapshotVersion,
        agent1: liveCycle.agent1,
        agent2: liveCycle.agent2,
      })
    : null;
  const canPlaceBetWithDisclosure = isCompetitiveDisclosureTradeReady({
    shellCanPlaceBet: bettorShell.canPlaceBet,
    phase: liveCycle?.phase,
    disclosure: competitiveDisclosure,
    currentCycle: currentStreamingState?.cycle ?? null,
    displayCycle: liveCycle,
    marketAuthority: {
      duelId: bettorShell.authoritativeDuelId,
      duelKeyHex: bettorShell.authoritativeDuelKey,
    },
    onChainCommitment: {
      duelKeyHex: solanaClobSnapshot.duelKeyHex,
      competitiveSnapshotVersion: solanaClobSnapshot.competitiveSnapshotVersion,
      competitiveSnapshotDigest: solanaClobSnapshot.competitiveSnapshotDigest,
    },
  });
  const spectatorPreparation =
    spectatorPresentation.hasPreparation &&
    spectatorStreamingState?.preparation &&
    liveCycle?.agent1 &&
    liveCycle.agent2
      ? deriveSpectatorPreparation(spectatorStreamingState.preparation, [
          { id: liveCycle.agent1.id, name: liveCycle.agent1.name },
          { id: liveCycle.agent2.id, name: liveCycle.agent2.name },
        ])
      : null;
  const hasVisibleContestants =
    spectatorPresentation.hasMatchup || spectatorPreparation !== null;
  const yesPot = bettorShell.showMarketData
    ? asNumber(solanaClobSnapshot.yesPool, 0)
    : 0;
  const noPot = bettorShell.showMarketData
    ? asNumber(solanaClobSnapshot.noPool, 0)
    : 0;
  const yesSharePercent = bettorShell.showMarketData
    ? solanaClobSnapshot.yesProbabilityPercent
    : null;
  const noSharePercent =
    yesSharePercent === null ? null : 100 - yesSharePercent;
  const effYesPot = yesPot;
  const effNoPot = noPot;
  const effYesPercent = yesSharePercent;
  const effNoPercent = noSharePercent;
  const effChartData = bettorShell.showMarketData
    ? solanaClobSnapshot.chartData
    : [];
  const showOddsChart = bettorShell.showMarketData && effChartData.length > 1;
  const effBids = bettorShell.showMarketData ? solanaClobSnapshot.bids : [];
  const effAsks = bettorShell.showMarketData ? solanaClobSnapshot.asks : [];
  const effRecentTrades = bettorShell.showMarketData
    ? solanaClobSnapshot.recentTrades
    : [];
  const effAgent1Name = hasVisibleContestants
    ? (liveCycle?.agent1?.name ?? "—")
    : (bettorShell.agent1Name ?? "—");
  const effAgent2Name = hasVisibleContestants
    ? (liveCycle?.agent2?.name ?? "—")
    : (bettorShell.agent2Name ?? "—");
  const marketAgent1Name = bettorShell.showMarketData
    ? (bettorShell.agent1Name ?? "—")
    : effAgent1Name;
  const marketAgent2Name = bettorShell.showMarketData
    ? (bettorShell.agent2Name ?? "—")
    : effAgent2Name;
  const spectatorStatus = getSpectatorStatusCopy({
    phase: liveCycle?.phase,
    winnerName: liveCycle?.winnerName,
    winReason: liveCycle?.winReason,
    cancellationReason: liveCycle?.cancellationReason,
    hasFreshCycle: spectatorPresentation.hasFreshCycle,
    activityLabel: spectatorPresentation.activityLabel,
  });
  const spectatorTerminalOutcome = classifySpectatorTerminalOutcome({
    phase: liveCycle?.phase,
    winnerName: liveCycle?.winnerName,
    winReason: liveCycle?.winReason,
    cancellationReason: liveCycle?.cancellationReason,
  });
  const terminalMarketFallback = getSpectatorTerminalMarketFallbackCopy(
    spectatorTerminalOutcome,
  );
  const effStatus = spectatorPreparation
    ? spectatorPreparation.status === "ready"
      ? "Both agents have locked their duel plans and loadouts."
      : "Live preparation — agents are building their strategies and supplies."
    : spectatorStatus;
  const effStatusColor = (() => {
    if (
      /failed|error|unavailable|interrupted|required|not found/i.test(effStatus)
    )
      return "#fda4af";
    if (/open|available|complete|resolved|created|linked/i.test(effStatus))
      return "#86efac";
    return "rgba(255,255,255,0.78)";
  })();
  const hasLiveAuthority = spectatorPresentation.hasFreshCycle;
  const liveAgent1 = hasVisibleContestants ? (liveCycle?.agent1 ?? null) : null;
  const liveAgent2 = hasVisibleContestants ? (liveCycle?.agent2 ?? null) : null;
  const hasAgentTelemetry = liveAgent1 !== null && liveAgent2 !== null;

  // Every visible combat field comes from the same HLS-program-date-aligned
  // frame. Mixing in separately delayed context polling makes HP, damage, and
  // equipment contradict the rendered fight even when the cycle IDs match.
  const effA1 = {
    id: liveAgent1?.id ?? "agent1",
    name: effAgent1Name,
    hp: liveAgent1?.hp ?? 0,
    maxHp: liveAgent1?.maxHp ?? 0,
    wins: liveAgent1?.wins ?? 0,
    losses: liveAgent1?.losses ?? 0,
    rank: 1,
    combatLevel: liveAgent1?.combatLevel ?? 0,
    provider: liveAgent1?.provider ?? "",
    model: liveAgent1?.model ?? "",
    damageDealtThisFight: liveAgent1?.damageDealtThisFight ?? 0,
    headToHeadWins: 0,
    headToHeadLosses: 0,
    equipment: liveAgent1?.equipment ?? {},
    inventory: liveAgent1?.inventory ?? [],
    monologues: [] as {
      id: string;
      type: string;
      content: string;
      timestamp: number;
    }[],
  };
  const effA2 = {
    id: liveAgent2?.id ?? "agent2",
    name: effAgent2Name,
    hp: liveAgent2?.hp ?? 0,
    maxHp: liveAgent2?.maxHp ?? 0,
    wins: liveAgent2?.wins ?? 0,
    losses: liveAgent2?.losses ?? 0,
    rank: 2,
    combatLevel: liveAgent2?.combatLevel ?? 0,
    provider: liveAgent2?.provider ?? "",
    model: liveAgent2?.model ?? "",
    damageDealtThisFight: liveAgent2?.damageDealtThisFight ?? 0,
    headToHeadWins: 0,
    headToHeadLosses: 0,
    equipment: liveAgent2?.equipment ?? {},
    inventory: liveAgent2?.inventory ?? [],
    monologues: [] as {
      id: string;
      type: string;
      content: string;
      timestamp: number;
    }[],
  };
  const spectatorActionFeed = deriveSpectatorActionFeed(
    liveCycle?.actionObservations,
    {
      cycleId: liveCycle?.cycleId,
      duelId: liveCycle?.duelId,
      agents: [
        { id: effA1.id, name: effA1.name },
        { id: effA2.id, name: effA2.name },
      ],
    },
  );
  const hasSpectatorLogDetail =
    spectatorTerminalOutcome !== null ||
    spectatorPreparation !== null ||
    spectatorActionFeed.length > 0 ||
    effA1.monologues.length > 0 ||
    effA2.monologues.length > 0;
  const livePhase = hasLiveAuthority ? (liveCycle?.phase ?? null) : null;
  const effCycle = {
    cycleId: hasLiveAuthority ? (liveCycle?.cycleId ?? "") : "",
    phase: selectSpectatorDisplayPhase(livePhase, hasLiveAuthority),
    countdown: hasLiveAuthority ? (liveCycle?.countdown ?? null) : null,
    winnerName: hasLiveAuthority ? (liveCycle?.winnerName ?? null) : null,
    winReason: hasLiveAuthority ? (liveCycle?.winReason ?? null) : null,
    cancellationReason: hasLiveAuthority
      ? (liveCycle?.cancellationReason ?? null)
      : null,
    timeRemaining: hasLiveAuthority ? (liveCycle?.timeRemaining ?? 0) : 0,
  };
  const effLeaderboard: LeaderboardEntry[] = publicStreamConnected
    ? (streamingState?.leaderboard ?? [])
    : [];
  const effTotalPool = effYesPot + effNoPot;
  const effPhaseLabel = (() => {
    const p = effCycle.phase;
    if (spectatorPreparation) {
      return spectatorPreparation.status === "ready" ? "READY" : "PREPARING";
    }
    if (spectatorPresentation.activityLabel === "LIVE") return "LIVE";
    if (p === "COUNTDOWN") return `Starting ${effCycle.countdown ?? ""}`;
    if (p === "RESOLUTION" || p === "RESOLVED" || p === "CANCELLED") {
      if (spectatorTerminalOutcome === "draw") return "DRAW";
      if (spectatorTerminalOutcome === "cancelled") return "CANCELLED";
      return "RESOLVED";
    }
    if (["LOCKED", "PROPOSED", "CHALLENGED"].includes(p)) return "LOCKED";
    if (p === "ANNOUNCEMENT") return "NEXT MATCH";
    return spectatorPresentation.activityLabel;
  })();
  const marketStatusText = _getMarketStatusLabel(
    bettorShell.canOpenMarketPanel
      ? (activeLifecycleMarket?.lifecycleStatus ??
          solanaClobSnapshot.marketStatus)
      : null,
    copy,
  );
  const countdownText = formatCountdown(
    currentMatch ? Math.max(0, currentMatch.closeTs - nowTs) : 0,
  );
  // Sidebar bet state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const sidebarFabRef = useRef<HTMLButtonElement | null>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement | null>(null);
  const [retainMarketPanelSession, setRetainMarketPanelSession] =
    useState(false);
  const [_hmSide, _setHmSide] = useState<BetSide>("YES");
  const [hmBottomTab, setHmBottomTab] = useState<SpectatorBottomTab>("news");
  const bottomTabRefs = useRef<
    Partial<Record<SpectatorBottomTab, HTMLButtonElement | null>>
  >({});
  const [hmMuted, setHmMuted] = useState(true);
  const matchupLabel = hasVisibleContestants
    ? `${effA1.name} vs ${effA2.name}`
    : hasLiveAuthority
      ? "Between rounds"
      : "Waiting for matchup";
  const phaseTimeRemaining =
    effCycle.timeRemaining > 0
      ? formatCountdown(Math.ceil(effCycle.timeRemaining / 1_000))
      : null;
  const marketNotice = transactionsEnabled
    ? bettorShell.canPlaceBet && !competitiveDisclosure
      ? "Betting is paused until both committed strategies and frozen loadouts are verified."
      : getSolanaBettorShellMessage(bettorShell.reason)
    : isLocalTestCluster
      ? "Real-money betting is disabled in this local preview."
      : "Betting is not available in this release.";
  const matchupHeading = spectatorPreparation
    ? "Agent Preparation"
    : getSpectatorMatchupHeading({
        phase: effCycle.phase,
        hasMatchup: spectatorPresentation.hasMatchup,
        hasLiveAuthority,
      });
  const bottomTabLabels: Readonly<Record<SpectatorBottomTab, string>> = {
    holders: copy.agents,
    news: copy.matchLog,
    trades: copy.trades,
    orders: copy.orderBook,
    topTraders: copy.leaderboard,
    positions: copy.positions,
  };
  const bottomTabKeys = getSpectatorBottomTabs(transactionsEnabled);
  const bottomTabs: ReadonlyArray<readonly [SpectatorBottomTab, string]> =
    bottomTabKeys.map((key) => [key, bottomTabLabels[key]]);
  const pointsDrawerTabs: ReadonlyArray<
    Readonly<{ key: PointsDrawerTab; label: string }>
  > = [
    { key: "leaderboard", label: copy.leaderboard },
    ...(transactionsEnabled
      ? [
          { key: "history" as const, label: copy.history },
          { key: "referral" as const, label: copy.referral },
        ]
      : []),
  ];

  useEffect(() => {
    setRetainMarketPanelSession((current) =>
      retainSolanaMarketPanelSession({
        retained: current,
        canAccessMarketPanel: bettorShell.canAccessMarketPanel,
      }),
    );
  }, [bettorShell.canAccessMarketPanel]);
  const openSidebar = useCallback(() => setIsSidebarOpen(true), []);
  const closeSidebar = useCallback(() => {
    setIsSidebarOpen(false);
    window.requestAnimationFrame(() => sidebarFabRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isMobile || !isSidebarOpen) return;
    window.requestAnimationFrame(() => sidebarCloseRef.current?.focus());
  }, [isMobile, isSidebarOpen]);

  const handleSidebarKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!isMobile || !isSidebarOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSidebar();
        return;
      }
      trapFocusWithin(event, sidebarRef.current);
    },
    [closeSidebar, isMobile, isSidebarOpen],
  );

  useEffect(() => {
    if (!showPointsDrawer && !(isMobile && isSidebarOpen)) return undefined;
    return lockModalDocumentScroll(document);
  }, [isMobile, isSidebarOpen, showPointsDrawer]);

  const handleBottomTabKeyDown = useCallback(
    (
      event: ReactKeyboardEvent<HTMLButtonElement>,
      current: SpectatorBottomTab,
    ) => {
      const next = selectSpectatorTabFromKey(current, event.key, bottomTabKeys);
      if (!next) return;
      event.preventDefault();
      setHmBottomTab(next);
      bottomTabRefs.current[next]?.focus();
    },
    [bottomTabKeys],
  );
  const handlePointsDrawerTabKeyDown = useCallback(
    (
      event: ReactKeyboardEvent<HTMLButtonElement>,
      current: PointsDrawerTab,
    ) => {
      const next = selectRovingTabFromKey(
        current,
        event.key,
        pointsDrawerTabs.map((tab) => tab.key),
      );
      if (!next) return;
      event.preventDefault();
      setPointsDrawerTab(next);
      pointsDrawerTabRefs.current[next]?.focus();
    },
    [pointsDrawerTabs],
  );
  const shouldRenderMarketPanel =
    bettorShell.canAccessMarketPanel || retainMarketPanelSession;
  const shouldRenderInteractiveMarket =
    transactionsEnabled && shouldRenderMarketPanel;

  useEffect(() => {
    if (publicStreamConnected && !streamAnalyticsReadyRef.current) {
      emitHyperbetProductEvent("stream_start", {
        source: "hls",
        surface: "spectator",
      });
    }
    streamAnalyticsReadyRef.current = publicStreamConnected;
  }, [publicStreamConnected]);

  useEffect(() => {
    const duelKey = normalizePredictionMarketDuelKeyHex(
      activeLifecycleMarket?.duelKey ?? null,
    );
    const marketIsVisible =
      bettorShell.canAccessMarketPanel && (!isMobile || isSidebarOpen);
    if (!duelKey || !marketIsVisible) return;
    if (
      !rememberBoundedProductEventKey(
        productAnalyticsKeysRef.current,
        `market_view:${duelKey}`,
      )
    ) {
      return;
    }
    emitHyperbetProductEvent("market_view", {
      mode: bettorShell.mode,
      phase: effCycle.phase,
    });
  }, [
    activeLifecycleMarket?.duelKey,
    bettorShell.canAccessMarketPanel,
    bettorShell.mode,
    effCycle.phase,
    isMobile,
    isSidebarOpen,
  ]);

  useEffect(() => {
    const duelKey = normalizePredictionMarketDuelKeyHex(
      activeLifecycleMarket?.duelKey ?? null,
    );
    const lifecycleStatus = activeLifecycleMarket?.lifecycleStatus ?? null;
    if (!activeLifecycleMarket || !duelKey || !lifecycleStatus) return;

    if (
      ["LOCKED", "PROPOSED", "CHALLENGED", "RESOLVED", "CANCELLED"].includes(
        lifecycleStatus,
      ) &&
      rememberBoundedProductEventKey(
        productAnalyticsKeysRef.current,
        `market_lock:${duelKey}`,
      )
    ) {
      emitHyperbetProductEvent("market_lock", { phase: effCycle.phase });
    }

    if (
      lifecycleStatus === "RESOLVED" &&
      rememberBoundedProductEventKey(
        productAnalyticsKeysRef.current,
        `result:${duelKey}`,
      )
    ) {
      const winner = activeLifecycleMarket.winner;
      emitHyperbetProductEvent("result", {
        winner: winner === "A" || winner === "B" ? winner : "UNKNOWN",
      });
    }

    if (
      lifecycleStatus === "CANCELLED" &&
      rememberBoundedProductEventKey(
        productAnalyticsKeysRef.current,
        `cancellation:${duelKey}`,
      )
    ) {
      emitHyperbetProductEvent("cancellation", { outcome: "cancelled" });
    }
  }, [
    activeLifecycleMarket?.duelKey,
    activeLifecycleMarket?.lifecycleStatus,
    activeLifecycleMarket?.winner,
    effCycle.phase,
  ]);

  return (
    <div
      className="hm-root"
      ref={appRootRef}
      data-stream-readiness={JSON.stringify(streamReadinessDiagnostics)}
      data-stream-sync-mode={
        streamPlaybackDateMs === null ? "fixed-delay" : "program-date-time"
      }
      data-stream-playback-date-ms={streamPlaybackDateMs ?? undefined}
      data-stream-state-emitted-at={streamingState?.emittedAt ?? undefined}
      data-stream-cycle-id={
        spectatorPresentation.hasMatchup
          ? (liveCycle?.cycleId ?? undefined)
          : undefined
      }
      data-stream-duel-id={
        spectatorPresentation.hasMatchup
          ? (liveCycle?.duelId ?? undefined)
          : undefined
      }
      data-stream-duel-key={
        spectatorPresentation.hasMatchup
          ? (liveCycle?.duelKeyHex ?? undefined)
          : undefined
      }
      data-market-duel-id={bettorShell.authoritativeDuelId ?? undefined}
      data-market-duel-key={bettorShell.authoritativeDuelKey ?? undefined}
      data-market-mode={bettorShell.mode}
      data-market-reason={bettorShell.reason}
      data-market-can-place-bet={canPlaceBetWithDisclosure ? "true" : "false"}
      data-market-competitive-disclosure={
        competitiveDisclosure ? "verified" : "unverified"
      }
      data-stream-sync-skew-ms={
        streamPlaybackDateMs !== null &&
        typeof streamingState?.emittedAt === "number"
          ? streamPlaybackDateMs - streamingState.emittedAt
          : undefined
      }
    >
      {/* Points / Leaderboard / Referral Drawer */}
      {showPointsDrawer && (
        <div
          className="hm-points-drawer-overlay"
          data-testid="points-drawer-overlay"
          style={{
            background: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            zIndex: 100,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
          }}
          onClick={closePointsDrawer}
        >
          <div
            className="hm-points-drawer-dialog"
            id="points-drawer-dialog"
            data-testid="points-drawer"
            ref={pointsDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="points-drawer-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closePointsDrawer();
                return;
              }
              trapFocusWithin(event, pointsDrawerRef.current);
            }}
            style={{
              background:
                "linear-gradient(180deg, rgba(20,22,30,0.95) 0%, rgba(14,16,24,0.98) 100%)",
              backdropFilter: "blur(32px) saturate(1.4)",
              WebkitBackdropFilter: "blur(32px) saturate(1.4)",
              padding: 24,
              borderRadius: 2,
              border: "1px solid rgba(229,184,74,0.2)",
              width: "min(440px, calc(100vw - 32px))",
              boxShadow:
                "0 24px 64px rgba(0,0,0,0.6), inset 0 1px 0 rgba(229,184,74,0.08), 0 0 0 1px rgba(0,0,0,0.5)",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Glass highlight */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: "30%",
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%)",
                pointerEvents: "none",
                borderRadius: "2px 2px 0 0",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 24,
                right: 24,
                height: 1,
                background:
                  "linear-gradient(90deg, transparent, rgba(242,208,138,0.3), transparent)",
                pointerEvents: "none",
              }}
            />

            {/* Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
                position: "relative",
                zIndex: 1,
              }}
            >
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 900,
                  fontFamily: "'Teko', sans-serif",
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: "#f2d08a",
                  textShadow: "0 0 8px rgba(242,208,138,0.3)",
                }}
              >
                <span id="points-drawer-title">
                  {transactionsEnabled
                    ? `${copy.points} · ${copy.leaderboard}`
                    : copy.leaderboard}
                </span>
              </div>
              <button
                className="hm-points-drawer-close"
                type="button"
                data-testid="points-drawer-close"
                aria-label="Close leaderboard"
                onClick={closePointsDrawer}
                style={{
                  background: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--hm-stone-mid)",
                  borderRadius: 2,
                  color: "rgba(255,255,255,0.4)",
                  cursor: "pointer",
                  fontSize: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.15s ease",
                  flexShrink: 0,
                }}
              >
                Close
              </button>
            </div>

            {/* Tab Buttons */}
            <div
              role="tablist"
              aria-label={copy.leaderboardAndStats}
              style={{
                display: "flex",
                gap: 4,
                marginBottom: 16,
                position: "relative",
                zIndex: 1,
              }}
            >
              {pointsDrawerTabs.map((tab) => {
                const isActive = pointsDrawerTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    id={`points-drawer-tab-${tab.key}`}
                    ref={(element) => {
                      pointsDrawerTabRefs.current[tab.key] = element;
                    }}
                    type="button"
                    role="tab"
                    data-testid={`points-drawer-tab-${tab.key}`}
                    aria-selected={isActive}
                    aria-controls={`points-drawer-panel-${tab.key}`}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() =>
                      startTransition(() => setPointsDrawerTab(tab.key))
                    }
                    onKeyDown={(event) =>
                      handlePointsDrawerTabKeyDown(event, tab.key)
                    }
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      borderRadius: 8,
                      border: isActive
                        ? "1px solid rgba(242,208,138,0.35)"
                        : "1px solid rgba(255,255,255,0.08)",
                      background: isActive
                        ? "rgba(242,208,138,0.12)"
                        : "rgba(255,255,255,0.03)",
                      color: isActive ? "#f2d08a" : "rgba(255,255,255,0.5)",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      textTransform: "uppercase",
                      letterSpacing: 1,
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Non-compact points summary */}
            {transactionsEnabled ? (
              <div
                style={{ marginBottom: 16, position: "relative", zIndex: 1 }}
              >
                <SolanaPointsDisplay walletAddress={pointsWalletAddress} />
              </div>
            ) : null}

            {/* Tab Content */}
            <div
              id={`points-drawer-panel-${pointsDrawerTab}`}
              data-testid={`points-drawer-panel-${pointsDrawerTab}`}
              role="tabpanel"
              aria-labelledby={`points-drawer-tab-${pointsDrawerTab}`}
              tabIndex={0}
              style={{
                position: "relative",
                zIndex: 1,
              }}
            >
              {pointsDrawerTab === "leaderboard" &&
                (transactionsEnabled ? (
                  <Suspense
                    fallback={<PanelFallback label={copy.loadingLeaderboard} />}
                  >
                    <PointsLeaderboard />
                  </Suspense>
                ) : effLeaderboard.length > 0 ? (
                  <div className="hm-trades-table-wrap">
                    <table className="hm-trades-table">
                      <caption className="hm-sr-only">
                        {copy.leaderboard}
                      </caption>
                      <thead>
                        <tr>
                          <th>Rank</th>
                          <th>Agent</th>
                          <th>Record</th>
                          <th>Win rate</th>
                          <th>Streak</th>
                        </tr>
                      </thead>
                      <tbody>
                        {effLeaderboard.map((entry) => (
                          <tr key={`drawer-${entry.name}`}>
                            <td className="hm-td-mono">#{entry.rank}</td>
                            <td>
                              <strong>{entry.name}</strong>
                            </td>
                            <td className="hm-td-mono">
                              {entry.wins}W–{entry.losses}L
                            </td>
                            <td className="hm-td-mono">
                              {formatAgentWinRate(entry.wins, entry.losses)}
                            </td>
                            <td className="hm-td-mono">
                              {entry.currentStreak > 0
                                ? `${entry.currentStreak}W`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <PanelFallback
                    label="No completed duels yet"
                    minHeight={140}
                  />
                ))}
              {transactionsEnabled && pointsDrawerTab === "history" && (
                <Suspense
                  fallback={<PanelFallback label={copy.loadingHistory} />}
                >
                  <PointsHistory walletAddress={pointsWalletAddress} />
                </Suspense>
              )}
              {transactionsEnabled && pointsDrawerTab === "referral" && (
                <Suspense
                  fallback={<PanelFallback label={copy.loadingReferral} />}
                >
                  <SolanaReferralPanel
                    solanaWallet={solanaWalletAddress}
                    signMessage={wallet.signMessage}
                    locale={locale}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      )}

      {/* We hide the verbose E2E slop by default unless a specific debug param is present. */}
      {isE2eDebugMode ? (
        <div
          data-testid="e2e-debug-panel"
          style={{
            margin: "12px",
            padding: "12px",
            borderRadius: "10px",
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            position: "relative",
            zIndex: 10,
          }}
        >
          <h1 style={{ margin: 0, fontSize: "18px" }}>
            Ultra Simple Fight Bet
          </h1>
          <div
            style={{ display: "flex", alignItems: "center", gap: "8px" }}
            data-testid="e2e-chain-picker"
          >
            <span>Chain: SOLANA</span>
          </div>
          <div data-testid="e2e-active-chain">solana</div>
          <div data-testid="current-match-id">
            Current match: {solanaClobSnapshot.matchLabel}
          </div>
          <div data-testid="market-status">Market: {marketStatusText}</div>
          <div data-testid="pool-totals">
            YES pool: {solDisplay(yesPot)} SOL | NO pool: {solDisplay(noPot)}{" "}
            SOL
          </div>
          <div data-testid="countdown">{countdownText}</div>
          <div data-testid="status">{status}</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              data-testid="refresh-market"
              type="button"
              onClick={handleRefresh}
            >
              Refresh
            </button>
          </div>
        </div>
      ) : null}

      {/* ── HM LAYOUT ──────────────────────────────────────────────────── */}

      {/* Header */}
      <header className="hm-header" role="banner">
        {isMobile ? (
          /* ── Mobile header: 2 compact rows ─────────────────────────────── */
          <>
            {/* Row 1: Brand + quick controls */}
            <div className="hm-header-mob-row1">
              <div className="hm-logo">
                <span className="hm-logo-text hm-logo-text--stacked">
                  HYPERBET
                </span>
                <span className="hm-logo-context">HYPERIA DUEL ARENA</span>
              </div>
              <div className="hm-header-mob-controls">
                <button
                  type="button"
                  className="hm-header-mob-icon-btn"
                  title={copy.leaderboard}
                  data-testid="points-drawer-open"
                  aria-haspopup="dialog"
                  aria-controls="points-drawer-dialog"
                  aria-expanded={showPointsDrawer}
                  onClick={openPointsDrawer}
                >
                  Stats
                </button>
                {/* SOL wallet */}
                {!transactionsEnabled ? (
                  <span
                    className="hm-header-mob-wallet-btn"
                    aria-label="Read-only spectator mode"
                  >
                    Preview
                  </span>
                ) : !wallet.connected ? (
                  <button
                    type="button"
                    className="hm-header-mob-wallet-btn"
                    onClick={() => setSolModalVisible(true)}
                  >
                    Connect SOL
                  </button>
                ) : (
                  <button
                    type="button"
                    className="hm-header-mob-wallet-btn hm-header-mob-wallet-btn--linked"
                    onClick={() => wallet.disconnect()}
                  >
                    ◎{" "}
                    {wallet.publicKey
                      ? wallet.publicKey.toBase58().slice(0, 4) + "…"
                      : "SOL"}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          /* ── Desktop header: original layout ───────────────────────────── */
          <>
            <div className="hm-header-left">
              <div className="hm-logo">
                <span className="hm-logo-text">HYPERBET</span>
                <span className="hm-logo-context">HYPERIA DUEL ARENA</span>
              </div>

              <div className="hm-market-info">
                <span
                  className="hm-market-name"
                  title={matchupLabel}
                  aria-label={`Current matchup: ${matchupLabel}`}
                >
                  {matchupLabel}
                </span>
              </div>
            </div>

            <div className="hm-header-right">
              <span className="hm-live-state">
                <span
                  className={`hm-live-state-dot${streamingConnected ? " hm-live-state-dot--connected" : ""}`}
                  aria-hidden="true"
                />
                {spectatorPresentation.activityLabel}
              </span>
              {isLocalTestCluster ? (
                <span
                  className="hm-local-test-state"
                  aria-label="Local Solana test environment"
                >
                  Local test
                </span>
              ) : null}
              {transactionsEnabled ? (
                <SolanaPointsDisplay
                  walletAddress={pointsWalletAddress}
                  compact
                />
              ) : null}
              <button
                type="button"
                className="dock-collapse-btn"
                title={copy.leaderboardAndStats}
                data-testid="points-drawer-open"
                aria-haspopup="dialog"
                aria-controls="points-drawer-dialog"
                aria-expanded={showPointsDrawer}
                onClick={openPointsDrawer}
              >
                Stats
              </button>
              {!transactionsEnabled ? (
                <span
                  className="hm-wallet-btn"
                  aria-label="Read-only spectator mode"
                >
                  Preview
                </span>
              ) : !wallet.connected ? (
                <button
                  type="button"
                  className="hm-wallet-btn"
                  onClick={() => setSolModalVisible(true)}
                >
                  Add SOL Wallet
                </button>
              ) : (
                <button
                  type="button"
                  className="hm-wallet-btn hm-wallet-btn--linked"
                  onClick={() => wallet.disconnect()}
                >
                  SOL{" "}
                  {wallet.publicKey
                    ? `${wallet.publicKey.toBase58().slice(0, 4)}...${wallet.publicKey.toBase58().slice(-4)}`
                    : ""}
                </button>
              )}
            </div>
          </>
        )}
      </header>

      <>
        {/* Main Content */}
        <div className="hm-main">
          <div className="hm-content">
            <div
              className={`hm-viewport-row${showOddsChart ? " hm-viewport-row--market" : " hm-viewport-row--spectator"}`}
            >
              {/* Phase status strip — only rendered on mobile, sits above the video */}
              {isMobile && (
                <div className="hm-mob-phase-strip">
                  <span
                    className={`hm-phase-badge hm-phase-badge--${effCycle.phase.toLowerCase()}`}
                  >
                    {effPhaseLabel}
                  </span>
                  <span
                    className="hm-mob-phase-strip-meta"
                    title={matchupLabel}
                    aria-label={`Current matchup: ${matchupLabel}`}
                  >
                    {matchupLabel}
                  </span>
                </div>
              )}

              {/* Game Viewport */}
              <div className="hm-game-viewport">
                {activeStreamUrl ? (
                  <>
                    <Suspense fallback={<StreamPlayerFallback />}>
                      <StreamPlayer
                        key={`${activeStreamUrl}:${streamAttempt}`}
                        streamUrl={activeStreamUrl}
                        muted={hmMuted}
                        autoPlay={true}
                        onStreamUnavailable={handleStreamUnavailable}
                        onStreamReady={handleStreamReady}
                        onPlaybackDateChange={handleStreamPlaybackDateChange}
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                        }}
                      />
                    </Suspense>
                    {streamRecoveryHeading && (
                      <div
                        className={`hm-stream-recovery hm-stream-recovery--${streamRecoveryMode}`}
                        role="status"
                        aria-live="polite"
                      >
                        <span className="hm-stream-recovery-pulse" />
                        <strong>{streamRecoveryHeading}</strong>
                        <small>{streamRecoveryDetail}</small>
                      </div>
                    )}
                    <div className="hm-stream-controls">
                      <button
                        className="hm-stream-mute-btn"
                        onClick={() => setHmMuted((m) => !m)}
                        type="button"
                        aria-label={
                          hmMuted ? copy.unmuteStream : copy.muteStream
                        }
                      >
                        {hmMuted ? (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="23" y1="9" x2="17" y2="15" />
                            <line x1="17" y1="9" x2="23" y2="15" />
                          </svg>
                        ) : (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                          </svg>
                        )}
                      </button>
                      {streamSources.length > 1 && (
                        <button
                          className="hm-stream-source-btn"
                          onClick={cycleStreamSource}
                          type="button"
                        >
                          Source {streamSourceIndex + 1}/{streamSources.length}
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="hm-game-placeholder">
                    <div className="hm-game-bg" />
                    <span className="hm-game-waiting">
                      Waiting for stream&hellip;
                    </span>
                  </div>
                )}
              </div>

              {/* Odds history only earns primary space once real data exists. */}
              {showOddsChart && (
                <div className="hm-chart-panel">
                  <div className="hm-chart-price-label">
                    <span className="hm-chart-price-current">
                      {effYesPercent === null
                        ? "—"
                        : `${effYesPercent.toFixed(1)}%`}
                    </span>
                  </div>
                  <div className="hm-chart-container">
                    <Suspense
                      fallback={
                        <PanelFallback
                          label="Loading odds history"
                          minHeight={180}
                        />
                      }
                    >
                      <OddsHistoryChart data={effChartData} />
                    </Suspense>
                  </div>
                </div>
              )}
            </div>

            <ResizeHandle
              direction="v"
              onMouseDown={(e) => startBottomDrag(e, "y", true)}
            />

            {/* Bottom Panel */}
            <div
              className="hm-bottom-panel"
              style={isMobile ? undefined : { height: bottomHeightPx }}
            >
              <nav
                className="hm-bottom-tabs"
                role="tablist"
                aria-label="Duel information"
              >
                {bottomTabs.map(([key, label]) => (
                  <button
                    key={key}
                    id={`duel-tab-${key}`}
                    ref={(element) => {
                      bottomTabRefs.current[key] = element;
                    }}
                    role="tab"
                    data-testid={`duels-bottom-tab-${key}`}
                    aria-selected={hmBottomTab === key}
                    aria-controls={`duel-panel-${key}`}
                    tabIndex={hmBottomTab === key ? 0 : -1}
                    className={`hm-bottom-tab ${hmBottomTab === key ? "hm-bottom-tab--active" : ""}`}
                    onClick={() => setHmBottomTab(key)}
                    onKeyDown={(event) => handleBottomTabKeyDown(event, key)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </nav>

              {hmBottomTab === "trades" && (
                <div
                  className="hm-trades-panel"
                  role="tabpanel"
                  id="duel-panel-trades"
                  aria-labelledby="duel-tab-trades"
                  data-testid="duels-bottom-panel-trades"
                >
                  <div className="hm-trades-summary">
                    <span>
                      {copy.pool}{" "}
                      <strong>
                        {bettorShell.showMarketData
                          ? `${solDisplay(effTotalPool)} SOL`
                          : "—"}
                      </strong>
                    </span>
                    <span>
                      {marketAgent1Name}{" "}
                      <strong>
                        {effYesPercent === null ? "—" : `${effYesPercent}%`}
                      </strong>
                    </span>
                    <span>
                      {marketAgent2Name}{" "}
                      <strong>
                        {effNoPercent === null ? "—" : `${effNoPercent}%`}
                      </strong>
                    </span>
                    <span>
                      Trades{" "}
                      <strong>
                        {bettorShell.showMarketData
                          ? effRecentTrades.length
                          : "—"}
                      </strong>
                    </span>
                  </div>
                  <div className="hm-trades-table-wrap">
                    <table className="hm-trades-table">
                      <caption className="hm-sr-only">{copy.trades}</caption>
                      <thead>
                        <tr>
                          <th>{copy.side}</th>
                          <th>{copy.agent}</th>
                          <th>{copy.price}</th>
                          <th>{copy.amount}</th>
                          <th>{copy.age}</th>
                          <th>{copy.trader}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {effRecentTrades.map((trade, i) => (
                          <tr key={trade.id ?? i}>
                            <td>
                              <span
                                className={`hm-type-label ${trade.side === "YES" ? "hm-type-label--buy" : "hm-type-label--sell"}`}
                              >
                                {trade.side === "YES" ? "BUY" : "SELL"}
                              </span>
                            </td>
                            <td>
                              <span className="hm-outcome-badge">
                                {trade.side === "YES"
                                  ? marketAgent1Name
                                  : marketAgent2Name}
                              </span>
                            </td>
                            <td className="hm-td-mono">
                              {(trade.price ?? 0).toFixed(2)}
                            </td>
                            <td className="hm-td-mono">
                              {formatAmount(trade.amount ?? 0)}
                            </td>
                            <td className="hm-td-dim">
                              {formatTimeAgo(trade.time ?? Date.now())}
                            </td>
                            <td className="hm-td-trader">
                              <span className="hm-trader-addr">
                                {truncateAddr(trade.trader ?? "")}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {hmBottomTab === "orders" && (
                <div
                  className="hm-trades-panel"
                  role="tabpanel"
                  id="duel-panel-orders"
                  aria-labelledby="duel-tab-orders"
                  data-testid="duels-bottom-panel-orders"
                >
                  <div className="hm-orderbook">
                    <div className="hm-ob-side hm-ob-side--bids">
                      <div className="hm-ob-header">
                        BIDS ({marketAgent1Name})
                      </div>
                      {effBids.map((level, i) => (
                        <div
                          key={`bid-${i}`}
                          className="hm-ob-row hm-ob-row--bid"
                        >
                          <span className="hm-ob-price">
                            {level.price.toFixed(2)}
                          </span>
                          <span className="hm-ob-amount">
                            {formatAmount(level.amount)}
                          </span>
                          <div
                            className="hm-ob-depth"
                            style={{
                              width: `${Math.min(100, (level.amount / (effTotalPool || 1)) * 100)}%`,
                            }}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="hm-ob-spread">
                      <span>
                        Spread:{" "}
                        {effYesPercent === null || effNoPercent === null
                          ? "—"
                          : `${Math.abs(effYesPercent - effNoPercent)}%`}
                      </span>
                    </div>
                    <div className="hm-ob-side hm-ob-side--asks">
                      <div className="hm-ob-header">
                        ASKS ({marketAgent2Name})
                      </div>
                      {effAsks.map((level, i) => (
                        <div
                          key={`ask-${i}`}
                          className="hm-ob-row hm-ob-row--ask"
                        >
                          <span className="hm-ob-price">
                            {level.price.toFixed(2)}
                          </span>
                          <span className="hm-ob-amount">
                            {formatAmount(level.amount)}
                          </span>
                          <div
                            className="hm-ob-depth hm-ob-depth--ask"
                            style={{
                              width: `${Math.min(100, (level.amount / (effTotalPool || 1)) * 100)}%`,
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {hmBottomTab === "topTraders" && (
                <div
                  className="hm-trades-panel"
                  role="tabpanel"
                  id="duel-panel-topTraders"
                  aria-labelledby="duel-tab-topTraders"
                  data-testid="duels-bottom-panel-topTraders"
                >
                  <div className="hm-trades-table-wrap">
                    <table className="hm-trades-table">
                      <caption className="hm-sr-only">
                        {copy.leaderboard}
                      </caption>
                      <thead>
                        <tr>
                          <th>Rank</th>
                          <th>Agent</th>
                          <th>Wins</th>
                          <th>Losses</th>
                          <th>Win Rate</th>
                          <th>Streak</th>
                        </tr>
                      </thead>
                      <tbody>
                        {effLeaderboard.map((entry) => (
                          <tr key={entry.name}>
                            <td className="hm-td-mono">#{entry.rank}</td>
                            <td>
                              <strong>{entry.name}</strong>
                            </td>
                            <td
                              className="hm-td-mono"
                              style={{ color: "#22c55e" }}
                            >
                              {entry.wins}
                            </td>
                            <td
                              className="hm-td-mono"
                              style={{ color: "#ef4444" }}
                            >
                              {entry.losses}
                            </td>
                            <td className="hm-td-mono">
                              {formatAgentWinRate(entry.wins, entry.losses)}
                            </td>
                            <td className="hm-td-mono">
                              {entry.currentStreak > 0
                                ? `${entry.currentStreak}W`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {hmBottomTab === "holders" && (
                <div
                  className="hm-trades-panel"
                  role="tabpanel"
                  id="duel-panel-holders"
                  aria-labelledby="duel-tab-holders"
                  data-testid="duels-bottom-panel-holders"
                >
                  {hasAgentTelemetry ? (
                    <div className="hm-agents-detail">
                      {[effA1, effA2].map((agent) => {
                        const hpPct =
                          agent.maxHp > 0
                            ? Math.max(
                                0,
                                Math.min(100, (agent.hp / agent.maxHp) * 100),
                              )
                            : 0;
                        const hpColor =
                          agent.hp < 25
                            ? "#ef4444"
                            : agent.hp < 60
                              ? "#f59e0b"
                              : "#22c55e";
                        return (
                          <div key={agent.id} className="hm-agent-card">
                            <div className="hm-agent-card-header">
                              <strong>{agent.name}</strong>
                              <span className="hm-agent-meta">
                                {agent.combatLevel
                                  ? `Combat Lv. ${agent.combatLevel}`
                                  : "Combat profile"}
                              </span>
                            </div>
                            {/* HP bar — always visible, quick health read */}
                            <div className="hm-agent-hp-bar-wrap">
                              <div
                                className="hm-agent-hp-bar"
                                style={{
                                  width: `${hpPct}%`,
                                  background: hpColor,
                                }}
                              />
                            </div>
                            <div className="hm-agent-stats-grid">
                              <div className="hm-agent-stat">
                                <span className="hm-agent-stat-label">HP</span>
                                <span
                                  className={`hm-agent-stat-value ${agent.hp < 30 ? "hm-stat-value--negative" : "hm-stat-value--positive"}`}
                                >
                                  {agent.hp}/{agent.maxHp}
                                </span>
                              </div>
                              <div className="hm-agent-stat">
                                <span className="hm-agent-stat-label">W/L</span>
                                <span className="hm-agent-stat-value">
                                  {agent.wins}W-{agent.losses}L
                                </span>
                              </div>
                              <div className="hm-agent-stat">
                                <span className="hm-agent-stat-label">Dmg</span>
                                <span className="hm-agent-stat-value">
                                  {agent.damageDealtThisFight}
                                </span>
                              </div>
                            </div>
                            {agent.inventory.length > 0 && (
                              <div className="hm-agent-loadout">
                                <span className="hm-agent-loadout-label">
                                  Loadout
                                </span>
                                <div className="hm-agent-loadout-items">
                                  {agent.inventory
                                    .filter(
                                      (
                                        item,
                                      ): item is NonNullable<typeof item> =>
                                        Boolean(item?.itemId),
                                    )
                                    .slice(0, 5)
                                    .map((item) => (
                                      <span
                                        className="hm-agent-loadout-item"
                                        key={`${agent.id}-${item.slot}-${item.itemId}`}
                                      >
                                        {formatItemLabel(item.itemId)}
                                        {item.quantity > 1
                                          ? ` ×${item.quantity}`
                                          : ""}
                                      </span>
                                    ))}
                                </div>
                              </div>
                            )}
                            {agent.monologues &&
                              agent.monologues.length > 0 && (
                                <div className="hm-agent-monologues">
                                  {agent.monologues
                                    .slice(0, isMobile ? 1 : 3)
                                    .map((m) => (
                                      <div
                                        key={m.id}
                                        className={`hm-monologue hm-monologue--${m.type}`}
                                      >
                                        <span className="hm-monologue-type">
                                          {m.type === "action" ? "ACT" : "THK"}
                                        </span>
                                        <span>{m.content}</span>
                                      </div>
                                    ))}
                                </div>
                              )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <PanelFallback
                      label="Agent telemetry unavailable"
                      minHeight={160}
                    />
                  )}
                </div>
              )}

              {hmBottomTab === "news" && (
                <div
                  className="hm-trades-panel"
                  role="tabpanel"
                  id="duel-panel-news"
                  aria-labelledby="duel-tab-news"
                  data-testid="duels-bottom-panel-news"
                >
                  <div className="hm-match-log">
                    <div className="hm-log-entry">
                      <span className="hm-log-phase">{effPhaseLabel}</span>
                      <span
                        className="hm-log-text"
                        style={{ color: effStatusColor }}
                      >
                        {effStatus}
                      </span>
                    </div>
                    {spectatorTerminalOutcome === "winner" &&
                      effCycle.winnerName && (
                        <div
                          className="hm-log-entry hm-log-entry--winner"
                          data-testid="spectator-terminal-outcome"
                        >
                          <span className="hm-log-phase">RESULT</span>
                          <span className="hm-log-text">
                            {effCycle.winnerName} wins
                            {formatWinReason(effCycle.winReason)
                              ? ` — ${formatWinReason(effCycle.winReason)}.`
                              : "."}
                          </span>
                        </div>
                      )}
                    {spectatorTerminalOutcome === "draw" && (
                      <div
                        className="hm-log-entry hm-log-entry--winner"
                        data-testid="spectator-terminal-outcome"
                      >
                        <span className="hm-log-phase">RESULT</span>
                        <span className="hm-log-text">
                          Draw — no winner was declared.
                        </span>
                      </div>
                    )}
                    {spectatorTerminalOutcome === "cancelled" && (
                      <div
                        className="hm-log-entry hm-log-entry--winner"
                        data-testid="spectator-terminal-outcome"
                      >
                        <span className="hm-log-phase">RESULT</span>
                        <span className="hm-log-text">
                          No contest — no winner was declared.
                        </span>
                      </div>
                    )}
                    {spectatorPreparation && (
                      <section
                        className="hm-preparation-feed"
                        aria-label="Live agent preparation"
                        data-testid="spectator-preparation-feed"
                      >
                        <div className="hm-preparation-feed-heading">
                          <span>LIVE PREPARATION</span>
                          <strong>
                            {spectatorPreparation.status === "ready"
                              ? "Both duel plans are locked"
                              : "Agents are earning their edge"}
                          </strong>
                        </div>
                        <div className="hm-preparation-agents">
                          {spectatorPreparation.agents.map((agent, index) => (
                            <article
                              className={`hm-preparation-agent${agent.ready ? " hm-preparation-agent--ready" : ""}`}
                              key={`${agent.name}-${index}`}
                            >
                              <div className="hm-preparation-agent-heading">
                                <strong>{agent.name}</strong>
                                <span>{agent.modeLabel}</span>
                              </div>
                              <p>{agent.currentLabel}</p>
                              {agent.trail.length > 0 && (
                                <ol
                                  className="hm-preparation-trail"
                                  aria-label={`${agent.name} preparation path`}
                                >
                                  {agent.trail.map((step, stepIndex) => (
                                    <li
                                      className={
                                        stepIndex === agent.trail.length - 1
                                          ? "hm-preparation-step hm-preparation-step--current"
                                          : "hm-preparation-step"
                                      }
                                      key={`${step.activity}-${stepIndex}`}
                                    >
                                      {step.label}
                                    </li>
                                  ))}
                                </ol>
                              )}
                            </article>
                          ))}
                        </div>
                      </section>
                    )}
                    {spectatorActionFeed.length > 0 && (
                      <ol
                        className="hm-combat-feed"
                        aria-label="Agent combat decisions"
                        data-testid="spectator-combat-action-feed"
                      >
                        {spectatorActionFeed.map((entry) => (
                          <li
                            className={`hm-log-entry hm-log-entry--${entry.tone}`}
                            key={entry.id}
                          >
                            <span
                              className={`hm-log-phase hm-log-phase--${entry.tone}`}
                            >
                              {entry.badge}
                            </span>
                            <span className="hm-log-text">{entry.text}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {[...effA1.monologues, ...effA2.monologues]
                      .sort((a, b) => b.timestamp - a.timestamp)
                      .slice(0, 10)
                      .map((m) => (
                        <div key={m.id} className="hm-log-entry">
                          <span className="hm-log-phase">
                            {m.type.toUpperCase()}
                          </span>
                          <span className="hm-log-text">{m.content}</span>
                        </div>
                      ))}
                    {!hasSpectatorLogDetail && (
                      <div
                        className="hm-match-log-empty"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        data-testid="spectator-match-log-empty"
                      >
                        <strong>Waiting for verified activity</strong>
                        <span>
                          Verified preparation and combat decisions appear here
                          when available.
                        </span>
                      </div>
                    )}
                  </div>
                  <section
                    className="hm-mobile-watch-summary"
                    aria-label="Live duel summary"
                    data-testid="mobile-watch-summary"
                  >
                    <div className="hm-mobile-watch-summary-heading">
                      <span>
                        {hasLiveAuthority ? "Watching now" : "Stream status"}
                      </span>
                      <strong>{matchupLabel}</strong>
                    </div>
                    <dl>
                      <div>
                        <dt>Arena</dt>
                        <dd>
                          {effPhaseLabel}
                          {phaseTimeRemaining ? ` · ${phaseTimeRemaining}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>Market</dt>
                        <dd>
                          {transactionsEnabled
                            ? bettorShell.actionLabel
                            : "Local preview"}
                        </dd>
                      </div>
                    </dl>
                    <p>{marketNotice}</p>
                  </section>
                </div>
              )}

              {hmBottomTab === "positions" && (
                <div
                  className="hm-empty-tab"
                  role="tabpanel"
                  id="duel-panel-positions"
                  aria-labelledby="duel-tab-positions"
                  data-testid="duels-bottom-panel-positions"
                >
                  <p>No open positions</p>
                </div>
              )}
            </div>
          </div>

          <ResizeHandle
            direction="h"
            onMouseDown={(e) => startSidebarDrag(e, "x", true)}
          />

          {/* ── RIGHT SIDEBAR: Real betting or mock controls ──────────────── */}
          <aside
            id="betting-panel"
            ref={sidebarRef}
            className={`hm-sidebar${isSidebarOpen ? " hm-sidebar--open" : ""}`}
            role={isMobile && isSidebarOpen ? "dialog" : undefined}
            aria-modal={isMobile && isSidebarOpen ? true : undefined}
            aria-hidden={isMobile && !isSidebarOpen ? true : undefined}
            inert={isMobile && !isSidebarOpen ? true : undefined}
            aria-label={
              transactionsEnabled ? copy.tradingControls : "Live match details"
            }
            tabIndex={isMobile ? -1 : undefined}
            onKeyDown={handleSidebarKeyDown}
            style={
              isMobile
                ? undefined
                : { width: sidebarWidthPx, minWidth: sidebarWidthPx }
            }
          >
            {/* Agent matchup header — close button lives here so it never floats over agent names */}
            <div className="hm-matchup-header">
              <span className="hm-matchup-label">{matchupHeading}</span>
              <div className="hm-matchup-header-right">
                <span
                  className={`hm-phase-badge hm-phase-badge--${effCycle.phase.toLowerCase()} hm-phase-badge--sm`}
                >
                  {effPhaseLabel}
                </span>
                <button
                  className="hm-sidebar-close"
                  ref={sidebarCloseRef}
                  type="button"
                  aria-label="Close trading panel"
                  onClick={closeSidebar}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Market type tabs + betting panels */}
            <div className="hm-market-panel-wrap">
              {liveCycle?.phase === "ANNOUNCEMENT" &&
              spectatorPresentation.hasMatchup ? (
                competitiveDisclosure ? (
                  <section
                    className="hm-competitive-disclosure"
                    aria-label="Verified committed strategies and frozen loadouts"
                    data-testid="competitive-disclosure"
                    data-snapshot-version={
                      competitiveDisclosure.snapshotVersion
                    }
                  >
                    <div className="hm-competitive-disclosure-heading">
                      <div>
                        <span>Before you bet</span>
                        <strong>Committed fight plans</strong>
                      </div>
                      <span className="hm-competitive-disclosure-verified">
                        Verified
                      </span>
                    </div>
                    <div className="hm-competitive-disclosure-grid">
                      {competitiveDisclosure.agents.map((agent) => (
                        <article
                          className="hm-competitive-agent"
                          key={agent.id}
                          aria-label={`${agent.name} committed strategy and frozen loadouts`}
                        >
                          <details className="hm-competitive-agent-details">
                            <summary
                              className="hm-competitive-agent-summary"
                              data-testid={`competitive-agent-summary-${agent.id}`}
                            >
                              <div className="hm-competitive-agent-heading">
                                <strong>{agent.name}</strong>
                                <span title={`Snapshot ${agent.fingerprint}`}>
                                  {agent.fingerprint.slice(0, 8).toUpperCase()}
                                </span>
                              </div>
                              <div className="hm-competitive-strategy-primary">
                                <strong>
                                  {formatCompetitiveDisclosureLabel(
                                    agent.strategy.approach,
                                  )}
                                </strong>
                                <span>
                                  {formatCompetitiveDisclosureLabel(
                                    agent.strategy.tacticalMacro,
                                  )}
                                </span>
                              </div>
                              <div className="hm-competitive-agent-at-a-glance">
                                <span>
                                  {formatCompetitiveDisclosureLabel(
                                    agent.loadouts[0].role,
                                  )}
                                </span>
                                <strong>
                                  {formatCompetitiveDisclosureLabel(
                                    agent.loadouts[0].weapon,
                                  )}
                                </strong>
                                <span
                                  className="hm-competitive-agent-toggle"
                                  aria-hidden="true"
                                >
                                  <span className="hm-competitive-agent-toggle-collapsed">
                                    View plan
                                  </span>
                                  <span className="hm-competitive-agent-toggle-expanded">
                                    Hide plan
                                  </span>
                                </span>
                              </div>
                            </summary>
                            <div className="hm-competitive-agent-expanded">
                              <div className="hm-competitive-strategy-facts">
                                <span>
                                  {formatCompetitiveDisclosureLabel(
                                    agent.strategy.attackStyle,
                                  )}{" "}
                                  attacks
                                </span>
                                <span>
                                  {agent.strategy.preferredCombatRole
                                    ? `Prefers ${formatCompetitiveDisclosureLabel(agent.strategy.preferredCombatRole)}`
                                    : "Adapts between roles"}
                                </span>
                                <span>
                                  {agent.strategy.prayer
                                    ? formatCompetitiveDisclosureLabel(
                                        agent.strategy.prayer,
                                      )
                                    : "No Prayer plan"}
                                </span>
                                <span>
                                  Recover {agent.strategy.foodThreshold}% ·
                                  Defend {agent.strategy.switchDefensiveAt}%
                                </span>
                              </div>
                              <div className="hm-competitive-loadouts">
                                {agent.loadouts.map((loadout) => (
                                  <div key={`${agent.id}-${loadout.role}`}>
                                    <strong>
                                      {formatCompetitiveDisclosureLabel(
                                        loadout.role,
                                      )}
                                    </strong>
                                    <span>
                                      {[
                                        loadout.weapon,
                                        loadout.ammunition,
                                        loadout.spell,
                                        loadout.shield,
                                        loadout.armorCount > 0
                                          ? `${loadout.armorCount} armor`
                                          : null,
                                      ]
                                        .filter(
                                          (value): value is string =>
                                            typeof value === "string",
                                        )
                                        .map(formatCompetitiveDisclosureLabel)
                                        .join(" · ")}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <span className="hm-competitive-strategy-source">
                                {agent.strategy.source === "model"
                                  ? "Agent-planned"
                                  : agent.strategy.source === "deterministic"
                                    ? "Rules fallback"
                                    : "Local test"}
                              </span>
                            </div>
                          </details>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : (
                  <div
                    className="hm-competitive-disclosure-pending"
                    role="status"
                    data-testid="competitive-disclosure-pending"
                  >
                    <strong>Verifying committed fight plans</strong>
                    <span>
                      Betting stays paused until both frozen disclosures match
                      the live duel snapshot.
                    </span>
                  </div>
                )
              ) : null}
              <div className="hm-market-panel-body">
                {shouldRenderInteractiveMarket ? (
                  <Suspense
                    fallback={
                      <PanelFallback
                        label="Loading Solana market"
                        minHeight={360}
                      />
                    }
                  >
                    <SolanaClobPanel
                      agent1Name={bettorShell.agent1Name ?? "—"}
                      agent2Name={bettorShell.agent2Name ?? "—"}
                      compact={true}
                      tradingEnabled={canPlaceBetWithDisclosure}
                      tradingUnavailableMessage={marketNotice}
                      onMarketSnapshot={handleSolanaClobSnapshot}
                    />
                  </Suspense>
                ) : (
                  <div className="hm-spectator-rail">
                    <div className="hm-spectator-fighters">
                      {!hasLiveAuthority ? (
                        <div className="hm-spectator-unavailable" role="status">
                          <strong>Match details unavailable</strong>
                          <span>{spectatorStatus}</span>
                        </div>
                      ) : (
                        [effA1, effA2].map((agent, index) => {
                          const hpPercent =
                            agent.maxHp > 0
                              ? Math.max(
                                  0,
                                  Math.min(100, (agent.hp / agent.maxHp) * 100),
                                )
                              : 0;
                          const equippedItemIds = Object.values(
                            agent.equipment ?? {},
                          ).filter(
                            (itemId): itemId is string =>
                              typeof itemId === "string" && itemId.length > 0,
                          );
                          const railLoadoutItemIds = [
                            ...equippedItemIds,
                            ...agent.inventory.flatMap((item) =>
                              item?.itemId ? [item.itemId] : [],
                            ),
                          ]
                            .filter(
                              (itemId, itemIndex, items) =>
                                items.indexOf(itemId) === itemIndex,
                            )
                            .slice(0, 4);
                          return (
                            <section
                              className="hm-spectator-fighter"
                              key={agent.id}
                            >
                              <div className="hm-spectator-fighter-heading">
                                <span>Agent {index + 1}</span>
                                <strong>{agent.name}</strong>
                              </div>
                              <div className="hm-spectator-hp-row">
                                <div className="hm-spectator-hp-track">
                                  <span
                                    style={{ width: `${hpPercent}%` }}
                                    className="hm-spectator-hp-fill"
                                  />
                                </div>
                                <span>
                                  {agent.hp}/{agent.maxHp}
                                </span>
                              </div>
                              <div className="hm-spectator-fighter-meta">
                                <span>
                                  {agent.combatLevel
                                    ? `Combat ${agent.combatLevel}`
                                    : "Combat profile"}
                                </span>
                                <span>
                                  {agent.wins}W–{agent.losses}L
                                </span>
                                <span>{agent.damageDealtThisFight} damage</span>
                              </div>
                              {railLoadoutItemIds.length > 0 && (
                                <div className="hm-spectator-loadout">
                                  {railLoadoutItemIds.map((itemId) => (
                                    <span key={`${agent.id}-rail-${itemId}`}>
                                      {formatItemLabel(itemId)}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </section>
                          );
                        })
                      )}
                    </div>
                    <div className="hm-spectator-cycle">
                      <span className="hm-spectator-cycle-label">
                        Fight status
                      </span>
                      <strong>{effPhaseLabel}</strong>
                      {phaseTimeRemaining && (
                        <span className="hm-spectator-cycle-time">
                          {phaseTimeRemaining}
                        </span>
                      )}
                    </div>
                    <div className="hm-market-notice" role="status">
                      <strong>
                        {terminalMarketFallback?.heading ??
                          (transactionsEnabled
                            ? "Betting unavailable"
                            : isLocalTestCluster
                              ? "Local preview"
                              : "Spectator mode")}
                      </strong>
                      <span>
                        {terminalMarketFallback?.detail ?? marketNotice}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {legalDocumentUrls ? (
              <p className="hm-legal-text">
                By trading, you agree to our{" "}
                <a href={legalDocumentUrls.termsUrl}>Terms</a> &amp;{" "}
                <a href={legalDocumentUrls.privacyUrl}>Privacy</a>
              </p>
            ) : null}
          </aside>
        </div>

        {/* Mobile FAB — opens the sidebar sheet */}
        {!isSidebarOpen && (
          <button
            ref={sidebarFabRef}
            className="hm-bet-fab"
            type="button"
            onClick={openSidebar}
            aria-haspopup="dialog"
            aria-controls="betting-panel"
            aria-expanded={isSidebarOpen}
            aria-label={
              transactionsEnabled
                ? bettorShell.actionLabel
                : "View match details"
            }
            disabled={transactionsEnabled && !bettorShell.canAccessMarketPanel}
          >
            {shouldShowBetActionIcon({
              transactionsEnabled,
              canPlaceBet: canPlaceBetWithDisclosure,
            }) && (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            )}
            {transactionsEnabled ? bettorShell.actionLabel : "Match"}
          </button>
        )}

        {/* Backdrop — close sidebar when tapping outside */}
        {isSidebarOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 48,
              background: "rgba(0,0,0,0.5)",
              backdropFilter: "blur(2px)",
            }}
            onClick={closeSidebar}
            aria-hidden="true"
          />
        )}
      </>
    </div>
  );
}
