import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getLocaleTag,
  resolveUiLocale,
  type UiLocale,
} from "@hyperbet/ui/i18n";
import { GAME_API_URL } from "../lib/solanaConfig";

interface HistoryEntry {
  id: number;
  eventType: string;
  status: string;
  totalPoints: number;
  referenceType: string | null;
  referenceId: string | null;
  relatedWallet: string | null;
  createdAt: number;
}

interface HistoryResponse {
  entries: HistoryEntry[];
  total: number;
}

function getEventLabels(
  locale: UiLocale,
): Record<string, { label: string; icon: string }> {
  if (locale === "zh") {
    return {
      BET_PLACED: { label: "已下注", icon: "🎲" },
      BET_FILL: { label: "下注成交", icon: "⚔️" },
      REFERRAL_WIN: { label: "邀请奖励", icon: "👥" },
      REFERRAL_FILL: { label: "邀请成交奖励", icon: "🤝" },
      SIGNUP_REFERRER: { label: "邀请注册奖励", icon: "🎁" },
      SIGNUP_REFEREE: { label: "注册奖励", icon: "🎉" },
    };
  }

  return {
    BET_PLACED: { label: "Bet Placed", icon: "🎲" },
    BET_FILL: { label: "Bet Filled", icon: "⚔️" },
    REFERRAL_WIN: { label: "Referral Win", icon: "👥" },
    REFERRAL_FILL: { label: "Referral Fill", icon: "🤝" },
    SIGNUP_REFERRER: { label: "Signup Bonus (Referrer)", icon: "🎁" },
    SIGNUP_REFEREE: { label: "Signup Bonus", icon: "🎉" },
  };
}

function getEventFilters(locale: UiLocale) {
  return locale === "zh"
    ? [
        { value: "", label: "全部事件" },
        { value: "BET_PLACED", label: "下注" },
        { value: "BET_FILL", label: "成交" },
        { value: "REFERRAL_WIN", label: "邀请奖励" },
        { value: "REFERRAL_FILL", label: "邀请成交" },
        { value: "SIGNUP_REFERRER", label: "邀请注册" },
        { value: "SIGNUP_REFEREE", label: "注册" },
      ]
    : [
        { value: "", label: "All Events" },
        { value: "BET_PLACED", label: "Bets Placed" },
        { value: "BET_FILL", label: "Bets Filled" },
        { value: "REFERRAL_WIN", label: "Referral Wins" },
        { value: "REFERRAL_FILL", label: "Referral Fills" },
        { value: "SIGNUP_REFERRER", label: "Referral Signups" },
        { value: "SIGNUP_REFEREE", label: "Signup Bonuses" },
      ];
}

function getHistoryCopy(locale: UiLocale) {
  return locale === "zh"
    ? {
        history: "历史记录",
        connectWallet: "连接钱包以查看历史记录。",
        loading: "加载中...",
        noActivity: "暂无活动。",
        unavailable: (status: number) => `历史记录不可用（${status}）`,
        failedToLoad: "历史记录加载失败",
        prev: "上一页",
        next: "下一页",
        page: (page: number, totalPages: number, total: number) =>
          `第 ${page} / ${totalPages} 页，共 ${total.toLocaleString(getLocaleTag(locale))} 条`,
        pts: "积分",
        eventFilter: "历史事件筛选",
      }
    : {
        history: "History",
        connectWallet: "Connect a wallet to view history.",
        loading: "Loading...",
        noActivity: "No activity yet.",
        unavailable: (status: number) => `History unavailable (${status})`,
        failedToLoad: "Failed to load history",
        prev: "Prev",
        next: "Next",
        page: (page: number, totalPages: number, total: number) =>
          `Page ${page} of ${totalPages} (${total.toLocaleString(getLocaleTag(locale))} total)`,
        pts: "pts",
        eventFilter: "History event filter",
      };
}

function formatTimestamp(ms: number, locale: UiLocale): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;

  if (locale === "zh") {
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
    return d.toLocaleDateString(getLocaleTag(locale), {
      month: "short",
      day: "numeric",
    });
  }

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(getLocaleTag(locale), {
    month: "short",
    day: "numeric",
  });
}

function formatEntryStatus(status: string, locale: UiLocale): string {
  const normalized = status.trim().toUpperCase();
  if (locale === "zh") {
    if (normalized === "CONFIRMED") return "已确认";
    if (normalized === "PENDING") return "处理中";
    if (normalized === "FAILED") return "失败";
  }
  return normalized;
}

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

export function PointsHistory({
  walletAddress,
  locale,
}: {
  walletAddress: string | null;
  locale?: UiLocale;
}) {
  const resolvedLocale = resolveUiLocale(locale);
  const copy = useMemo(() => getHistoryCopy(resolvedLocale), [resolvedLocale]);
  const eventLabels = useMemo(
    () => getEventLabels(resolvedLocale),
    [resolvedLocale],
  );
  const eventFilters = useMemo(
    () => getEventFilters(resolvedLocale),
    [resolvedLocale],
  );
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [eventFilter, setEventFilter] = useState("");
  const pageSize = 15;

  const fetchHistory = useCallback(async () => {
    if (!walletAddress) {
      setEntries([]);
      setTotal(0);
      setError(null);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      if (eventFilter) params.set("eventType", eventFilter);

      const response = await fetch(
        `${GAME_API_URL}/api/arena/points/history/${walletAddress}?${params}`,
        { cache: "no-store" },
      );

      if (response.ok) {
        const data = (await response.json()) as HistoryResponse;
        setEntries(data.entries ?? []);
        setTotal(data.total ?? 0);
      } else {
        setEntries([]);
        setTotal(0);
        setError(copy.unavailable(response.status));
      }
    } catch {
      setEntries([]);
      setTotal(0);
      setError(copy.failedToLoad);
    } finally {
      setLoading(false);
    }
  }, [copy, eventFilter, page, walletAddress]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    setPage(0);
  }, [eventFilter]);

  if (!walletAddress) {
    return (
      <div
        data-testid="points-history-placeholder"
        role="status"
        style={{
          padding: "16px",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.02)",
          fontSize: 12,
          color: "rgba(255,255,255,0.5)",
        }}
      >
        {copy.connectWallet}
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div
      data-testid="points-history"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        color: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 1.5,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          {copy.history}
        </h2>

        <select
          data-testid="points-history-filter"
          aria-label={copy.eventFilter}
          value={eventFilter}
          onChange={(event) => setEventFilter(event.target.value)}
          style={{
            padding: "5px 8px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.4)",
            color: "rgba(255,255,255,0.7)",
            fontSize: 11,
            cursor: "pointer",
            outline: "none",
          }}
        >
          {eventFilters.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
      </div>

      {loading && entries.length === 0 && (
        <div
          role="status"
          style={{
            fontSize: 12,
            color: "rgba(255,255,255,0.3)",
            padding: 16,
            textAlign: "center",
          }}
        >
          {copy.loading}
        </div>
      )}

      {!loading && entries.length === 0 && (
        <div
          role={error ? "alert" : "status"}
          style={{
            fontSize: 12,
            color: error ? "#fca5a5" : "rgba(255,255,255,0.3)",
            padding: 24,
            textAlign: "center",
            background: "rgba(0,0,0,0.2)",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          {error ?? copy.noActivity}
        </div>
      )}

      {entries.length > 0 && (
        <div
          style={{
            background: "rgba(0,0,0,0.3)",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.06)",
            overflow: "hidden",
          }}
        >
          <div role="list" aria-label={copy.history}>
            {entries.map((entry) => {
              const meta = eventLabels[entry.eventType] ?? {
                label: entry.eventType,
                icon: "•",
              };
              const isPositive = entry.totalPoints > 0;

              return (
                <div
                  role="listitem"
                  key={entry.id}
                  data-testid={`points-history-row-${entry.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 14px",
                    gap: 10,
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background =
                      "rgba(255,255,255,0.03)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ fontSize: 16, width: 24, textAlign: "center" }}
                  >
                    {meta.icon}
                  </span>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "rgba(255,255,255,0.85)",
                      }}
                    >
                      {meta.label}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "rgba(255,255,255,0.35)",
                        display: "flex",
                        gap: 6,
                      }}
                    >
                      <span>
                        {formatTimestamp(entry.createdAt, resolvedLocale)}
                      </span>
                      {entry.relatedWallet ? (
                        <span>
                          &middot; {truncateWallet(entry.relatedWallet)}
                        </span>
                      ) : null}
                      {entry.status !== "CONFIRMED" ? (
                        <span
                          style={{
                            color:
                              entry.status === "PENDING"
                                ? "#facc15"
                                : "#fca5a5",
                          }}
                        >
                          &middot;{" "}
                          {formatEntryStatus(entry.status, resolvedLocale)}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: isPositive ? "#4ade80" : "#fca5a5",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isPositive ? "+" : ""}
                    {entry.totalPoints.toLocaleString(
                      getLocaleTag(resolvedLocale),
                    )}{" "}
                    {copy.pts}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 14px",
              borderTop: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              style={{
                minHeight: 44,
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.1)",
                background:
                  page === 0 ? "transparent" : "rgba(255,255,255,0.05)",
                color:
                  page === 0
                    ? "rgba(255,255,255,0.2)"
                    : "rgba(255,255,255,0.6)",
                cursor: page === 0 ? "not-allowed" : "pointer",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {copy.prev}
            </button>
            <span
              role="status"
              aria-live="polite"
              style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}
            >
              {copy.page(page + 1, totalPages, total)}
            </span>
            <button
              type="button"
              onClick={() => setPage((current) => current + 1)}
              disabled={page + 1 >= totalPages}
              style={{
                minHeight: 44,
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.1)",
                background:
                  page + 1 >= totalPages
                    ? "transparent"
                    : "rgba(255,255,255,0.05)",
                color:
                  page + 1 >= totalPages
                    ? "rgba(255,255,255,0.2)"
                    : "rgba(255,255,255,0.6)",
                cursor: page + 1 >= totalPages ? "not-allowed" : "pointer",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {copy.next}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
