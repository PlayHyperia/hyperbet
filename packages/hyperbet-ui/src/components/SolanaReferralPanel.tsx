import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getLocaleTag,
  resolveUiLocale,
  type UiLocale,
} from "@hyperbet/ui/i18n";
import {
  buildArenaWriteHeaders,
  GAME_API_URL,
  SOLANA_CLUSTER,
} from "../lib/solanaConfig";
import { createSolanaWalletActionProof } from "../lib/solanaWalletActionProof";

type PointsSnapshot = {
  totalPoints: number;
  referred: boolean;
};

type InviteSummary = {
  inviteCode: string | null;
  invitedWalletCount: number;
  activeReferralCount: number;
  pendingSignupBonuses: number;
  totalReferralWinPoints: number;
};

function shortWallet(value: string): string {
  return value.length <= 14
    ? value
    : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function extractInviteCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.includes(":")) return trimmed;
  try {
    return new URL(trimmed).searchParams.get("invite")?.trim() ?? "";
  } catch {
    return "";
  }
}

function buildInviteLink(inviteCode: string): string {
  if (typeof window === "undefined") {
    return `?invite=${encodeURIComponent(inviteCode)}`;
  }
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("invite", inviteCode);
  return url.toString();
}

function initialInviteCode(): string {
  if (typeof window === "undefined") return "";
  return (
    new URLSearchParams(window.location.search).get("invite")?.trim() ?? ""
  ).toUpperCase();
}

function getCopy(locale: UiLocale) {
  if (locale === "zh") {
    return {
      title: "邀请",
      connect: "连接 Solana 钱包以加载邀请数据。",
      unavailable: "邀请数据暂不可用",
      points: "积分",
      referrals: "邀请",
      pending: (count: number) => `${count} 待确认`,
      winBonus: (value: number) =>
        `邀请胜场积分 +${value.toLocaleString(getLocaleTag(locale))}`,
      copy: "复制链接",
      copied: "邀请链接已复制",
      copyFailed: "复制邀请链接失败",
      placeholder: "输入邀请码或邀请链接",
      redeem: "兑换",
      redeeming: "正在兑换...",
      redeemFailed: "邀请码兑换失败",
      redeemed: "邀请码已兑换",
      alreadyRedeemed: "该邀请码已兑换",
      create: "创建邀请码",
      creating: "正在创建...",
      created: "邀请码已创建",
      walletProofUnavailable: "此钱包不支持安全消息签名。",
      referralActive: "邀请关系已启用",
    };
  }
  return {
    title: "Referral",
    connect: "Connect a Solana wallet to load referral data.",
    unavailable: "Referral data unavailable",
    points: "Points",
    referrals: "Referrals",
    pending: (count: number) => `${count} pending`,
    winBonus: (value: number) =>
      `Referral win points +${value.toLocaleString(getLocaleTag(locale))}`,
    copy: "Copy Link",
    copied: "Invite link copied",
    copyFailed: "Failed to copy invite link",
    placeholder: "Invite code or link",
    redeem: "Redeem",
    redeeming: "Redeeming...",
    redeemFailed: "Invite redemption failed",
    redeemed: "Invite code redeemed",
    alreadyRedeemed: "Invite code already redeemed",
    create: "Create Code",
    creating: "Creating...",
    created: "Invite code created",
    walletProofUnavailable:
      "This wallet does not support secure message signing.",
    referralActive: "Referral active",
  };
}

export function SolanaReferralPanel({
  solanaWallet,
  signMessage,
  locale,
}: {
  solanaWallet: string | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  locale?: UiLocale;
}) {
  const resolvedLocale = resolveUiLocale(locale);
  const copy = useMemo(() => getCopy(resolvedLocale), [resolvedLocale]);
  const [points, setPoints] = useState<PointsSnapshot | null>(null);
  const [invite, setInvite] = useState<InviteSummary | null>(null);
  const [redeemCode, setRedeemCode] = useState(initialInviteCode);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!solanaWallet) {
      setPoints(null);
      setInvite(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [pointsResponse, inviteResponse] = await Promise.all([
        fetch(`${GAME_API_URL}/api/arena/points/${solanaWallet}?scope=wallet`, {
          cache: "no-store",
        }),
        fetch(
          `${GAME_API_URL}/api/arena/invite/${solanaWallet}?platform=solana`,
          { cache: "no-store" },
        ),
      ]);
      if (!pointsResponse.ok || !inviteResponse.ok) {
        throw new Error("referral data unavailable");
      }
      setPoints((await pointsResponse.json()) as PointsSnapshot);
      setInvite((await inviteResponse.json()) as InviteSummary);
      setStatus("");
    } catch {
      setPoints(null);
      setInvite(null);
      setStatus(copy.unavailable);
    } finally {
      setLoading(false);
    }
  }, [copy.unavailable, solanaWallet]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const redeem = useCallback(async () => {
    if (!solanaWallet) return;
    if (!signMessage) {
      setStatus(copy.walletProofUnavailable);
      return;
    }
    const inviteCode = extractInviteCode(redeemCode).toUpperCase();
    if (!inviteCode) return;
    setBusy(true);
    setStatus(copy.redeeming);
    try {
      const proof = await createSolanaWalletActionProof({
        action: "invite-redeem",
        cluster: SOLANA_CLUSTER,
        wallet: solanaWallet,
        inviteCode,
        signMessage,
      });
      const response = await fetch(`${GAME_API_URL}/api/arena/invite/redeem`, {
        method: "POST",
        headers: buildArenaWriteHeaders(),
        body: JSON.stringify({ wallet: solanaWallet, inviteCode, ...proof }),
      });
      const payload = (await response.json()) as {
        error?: string;
        result?: { alreadyRedeemed?: boolean };
      };
      if (!response.ok) throw new Error(payload.error || copy.redeemFailed);
      const completionStatus = payload.result?.alreadyRedeemed
        ? copy.alreadyRedeemed
        : copy.redeemed;
      setRedeemCode("");
      await refresh();
      setStatus(completionStatus);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : copy.redeemFailed);
    } finally {
      setBusy(false);
    }
  }, [copy, redeemCode, refresh, signMessage, solanaWallet]);

  const createInviteCode = useCallback(async () => {
    if (!solanaWallet) return;
    if (!signMessage) {
      setStatus(copy.walletProofUnavailable);
      return;
    }
    setBusy(true);
    setStatus(copy.creating);
    try {
      const proof = await createSolanaWalletActionProof({
        action: "invite-register",
        cluster: SOLANA_CLUSTER,
        wallet: solanaWallet,
        inviteCode: null,
        signMessage,
      });
      const response = await fetch(
        `${GAME_API_URL}/api/arena/invite/register`,
        {
          method: "POST",
          headers: buildArenaWriteHeaders(),
          body: JSON.stringify({ wallet: solanaWallet, ...proof }),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        inviteCode?: string;
      };
      if (!response.ok || !payload.inviteCode) {
        throw new Error(payload.error || copy.unavailable);
      }
      await refresh();
      setStatus(copy.created);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : copy.unavailable);
    } finally {
      setBusy(false);
    }
  }, [copy, refresh, signMessage, solanaWallet]);

  const copyLink = useCallback(async () => {
    if (!invite?.inviteCode) return;
    try {
      await navigator.clipboard.writeText(buildInviteLink(invite.inviteCode));
      setStatus(copy.copied);
    } catch {
      setStatus(copy.copyFailed);
    }
  }, [copy, invite?.inviteCode]);

  return (
    <div
      data-testid="referral-panel"
      style={{
        display: "grid",
        gap: 10,
        padding: 14,
        borderRadius: 12,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: 12,
          textTransform: "uppercase",
          opacity: 0.65,
        }}
      >
        {copy.title}
      </h2>
      {!solanaWallet ? (
        <div style={{ fontSize: 12, opacity: 0.65 }}>{copy.connect}</div>
      ) : (
        <>
          <div style={{ fontSize: 11, opacity: 0.65 }}>
            {shortWallet(solanaWallet)}
          </div>
          {points?.referred ? (
            <div
              data-testid="referral-panel-referred-by"
              style={{ color: "#4ade80", fontSize: 11 }}
            >
              {copy.referralActive}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
            <span>
              {copy.points}: {points?.totalPoints ?? 0}
            </span>
            <span>
              {copy.referrals}: {invite?.activeReferralCount ?? 0}/
              {invite?.invitedWalletCount ?? 0}
            </span>
          </div>
          {(invite?.pendingSignupBonuses ?? 0) > 0 ? (
            <div style={{ fontSize: 11, opacity: 0.65 }}>
              {copy.pending(invite?.pendingSignupBonuses ?? 0)}
            </div>
          ) : null}
          {(invite?.totalReferralWinPoints ?? 0) > 0 ? (
            <div style={{ fontSize: 11, opacity: 0.65 }}>
              {copy.winBonus(invite?.totalReferralWinPoints ?? 0)}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <code
              data-testid="referral-panel-invite-code"
              style={{ flex: 1, padding: "8px 10px", background: "#090909" }}
            >
              {invite?.inviteCode ?? "-"}
            </code>
            {invite?.inviteCode ? (
              <button
                type="button"
                onClick={() => void copyLink()}
                style={{ minHeight: 44 }}
              >
                {copy.copy}
              </button>
            ) : (
              <button
                type="button"
                data-testid="referral-panel-create-button"
                onClick={() => void createInviteCode()}
                disabled={!invite || !signMessage || busy}
                style={{ minHeight: 44 }}
              >
                {busy ? copy.creating : copy.create}
              </button>
            )}
          </div>
          {!signMessage ? (
            <div style={{ fontSize: 11, color: "#fbbf24" }}>
              {copy.walletProofUnavailable}
            </div>
          ) : null}
        </>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          data-testid="referral-panel-redeem-input"
          aria-label={copy.placeholder}
          value={redeemCode}
          onChange={(event) => setRedeemCode(event.target.value)}
          placeholder={copy.placeholder}
          disabled={!solanaWallet || busy}
          style={{ flex: 1, minHeight: 44, padding: "10px 12px" }}
        />
        <button
          type="button"
          data-testid="referral-panel-redeem-button"
          onClick={() => void redeem()}
          disabled={!solanaWallet || !signMessage || busy || !redeemCode.trim()}
          style={{ minHeight: 44 }}
        >
          {copy.redeem}
        </button>
      </div>
      {loading ? <div style={{ fontSize: 11, opacity: 0.6 }}>...</div> : null}
      {status ? (
        <div
          data-testid="referral-panel-status"
          role="status"
          style={{ fontSize: 11 }}
        >
          {status}
        </div>
      ) : null}
    </div>
  );
}
