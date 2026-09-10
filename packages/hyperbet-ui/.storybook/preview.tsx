import type { Preview } from "@storybook/react";
import React, { useEffect } from "react";
import { Buffer } from "buffer";
import { setStoredUiLocale, type UiLocale } from "../src/i18n";
import { buildDuelCorrelationId } from "../src/lib/duelCorrelation";
import { SOLANA_CLUSTER } from "../src/lib/solanaConfig";
import "../src/styles.css";

const STORY_TIME = Date.now();
const STORYBOOK_WALLET = "9YQ6U3b1i3Qxb38nSxrdbidKdvUSsfx8bVsgcuyo6edS";
const STORYBOOK_PROGRAM = "11111111111111111111111111111111";
const STORYBOOK_MARKET = "8F6eg5uCpfJDmzmB3gJF7bhHZtiLfT7i59D1R6B3CdMZ";
const STORYBOOK_DUEL_KEY =
  "1f1e1d1c1b1a19181716151413121110f1e2d3c4b5a697887766554433221100";
const STORYBOOK_DUEL_ID = "streaming-e354197c-6db9-43af-90d6-9ae5d9898485";
const STORYBOOK_SIGNATURE =
  "5Vj9v5x5u3P5TtBczYvHh8sjv3wjfNXrjAq9LPG3GJ3c2P7n4qg3pU4y6k4cX1m7hQ9u8F6a5D2s1W3e7R9t8K2";

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

function installBrowserMocks() {
  if (typeof window === "undefined") return;
  const storyWindow = window as typeof window & {
    __hyperbetStoryFetch?: boolean;
    Buffer?: typeof Buffer;
  };
  if (!storyWindow.__hyperbetStoryFetch) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const url = new URL(requestUrl, window.location.origin);

        if (url.pathname === "/api/arena/points/leaderboard") {
          return jsonResponse({
            leaderboard: [
              { rank: 1, wallet: STORYBOOK_WALLET, totalPoints: 48_120 },
              {
                rank: 2,
                wallet: "6F6ePKprCddjcLm9uAwXpi4eCV7H7fLS1c1zFqaHkJn4",
                totalPoints: 35_300,
              },
            ],
          });
        }

        if (url.pathname.startsWith("/api/arena/points/history/")) {
          return jsonResponse({
            total: 2,
            entries: [
              {
                id: 101,
                eventType: "BET_FILL",
                status: "CONFIRMED",
                totalPoints: 750,
                referenceType: "BET",
                referenceId: "duel-17",
                relatedWallet: null,
                createdAt: STORY_TIME - 3_600_000,
              },
              {
                id: 102,
                eventType: "REFERRAL_FILL",
                status: "CONFIRMED",
                totalPoints: 75,
                referenceType: "BET",
                referenceId: "duel-17",
                relatedWallet: "6F6ePKprCddjcLm9uAwXpi4eCV7H7fLS1c1zFqaHkJn4",
                createdAt: STORY_TIME - 86_400_000,
              },
            ],
          });
        }

        if (url.pathname.startsWith("/api/arena/points/rank/")) {
          return jsonResponse({
            wallet: STORYBOOK_WALLET,
            rank: 1,
            totalPoints: 48_120,
          });
        }

        if (url.pathname.startsWith("/api/arena/points/")) {
          return jsonResponse({
            wallet: STORYBOOK_WALLET,
            totalPoints: 48_120,
            selfPoints: 40_000,
            winPoints: 5_000,
            referralPoints: 3_120,
            invitedWalletCount: 2,
            referredBy: null,
          });
        }

        if (url.pathname === "/api/arena/invite/redeem") {
          return jsonResponse({
            result: { signupBonus: 50, alreadyRedeemed: false },
          });
        }

        if (url.pathname.startsWith("/api/arena/invite/")) {
          return jsonResponse({
            wallet: STORYBOOK_WALLET,
            platformView: "solana",
            inviteCode: "SOLARENA",
            invitedWalletCount: 2,
            invitedWallets: [],
            invitedWalletsTruncated: false,
            pointsFromReferrals: 3_120,
            referredByWallet: null,
            referredByCode: null,
            activeReferralCount: 2,
            pendingSignupBonuses: 0,
            totalReferralWinPoints: 3_120,
          });
        }

        if (url.pathname === "/api/arena/prediction-markets/active") {
          return jsonResponse({
            duel: {
              duelKey:
                "1f1e1d1c1b1a19181716151413121110f1e2d3c4b5a697887766554433221100",
              duelId: "duel-42",
              phase: "ANNOUNCEMENT",
              winner: "NONE",
              betCloseTime: STORY_TIME + 300_000,
              agent1Name: "StormWarden",
              agent2Name: "JadePhoenix",
            },
            markets: [],
            updatedAt: STORY_TIME,
          });
        }

        if (url.pathname.startsWith("/api/arena/settlements/")) {
          const now = Date.now();
          const limit = Number(url.searchParams.get("limit") ?? 4);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          return jsonResponse({
            schemaVersion: 2,
            chain: "SOLANA",
            asset: "SOL",
            decimals: 9,
            cluster: SOLANA_CLUSTER,
            programId: STORYBOOK_PROGRAM,
            wallet: STORYBOOK_WALLET,
            ledger: {
              current: true,
              lastIndexedAt: now - 100,
              degradedReason: null,
            },
            entries: [
              {
                betId: "storybook-bet-1",
                wallet: STORYBOOK_WALLET,
                marketPda: STORYBOOK_MARKET,
                duelKey: STORYBOOK_DUEL_KEY,
                duelId: STORYBOOK_DUEL_ID,
                correlationId: buildDuelCorrelationId({
                  duelId: STORYBOOK_DUEL_ID,
                  duelKey: STORYBOOK_DUEL_KEY,
                }),
                placeSignature: STORYBOOK_SIGNATURE,
                recordedAt: now - 60_000,
                orderId: "7",
                side: 1,
                limitPrice: 600,
                orderAmountUnits: "1000000000",
                matchedAmountUnits: "1000000000",
                restingAmountUnits: "0",
                releasedAmountUnits: "0",
                sourceAmountLamports: "620000000",
                collateralLamports: "600000000",
                executedCostLamports: "600000000",
                tradeFeeLamports: "20000000",
                orderRefundLamports: "0",
                rewardEligibleLamports: "620000000",
                marketStatus: "resolved",
                winner: "a",
                orderState: "FILLED",
                settlementState: "PAYOUT_CLAIMABLE",
                terminalKind: null,
                terminalStatus: null,
                terminalWinner: null,
                claimSignature: null,
                terminalGrossLamports: "0",
                terminalPayoutLamports: "0",
                terminalFeeLamports: "0",
                reconciledAt: now - 50,
                settledAt: null,
              },
            ],
            total: 1,
            limit,
            offset,
            updatedAt: now,
          });
        }

        if (url.pathname.startsWith("/game-assets/manifests/items/")) {
          return jsonResponse([]);
        }

        return nativeFetch(input, init);
      },
      nativeFetch,
    ) as typeof window.fetch;
    storyWindow.__hyperbetStoryFetch = true;
  }

  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (!navigator.clipboard) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => undefined },
      configurable: true,
    });
  }

  const mediaPrototype = HTMLMediaElement.prototype as HTMLMediaElement & {
    __storybookPatched?: boolean;
  };
  if (!mediaPrototype.__storybookPatched) {
    mediaPrototype.play = async () => undefined;
    mediaPrototype.pause = () => undefined;
    mediaPrototype.load = () => undefined;
    mediaPrototype.__storybookPatched = true;
  }

  storyWindow.Buffer ??= Buffer;
  (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer ??=
    Buffer;
}

installBrowserMocks();

function StoryFrame({
  children,
  locale,
}: {
  children: React.ReactNode;
  locale: UiLocale;
}) {
  useEffect(() => {
    setStoredUiLocale(locale);
    document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
  }, [locale]);

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 24,
        background:
          "radial-gradient(circle at top, rgba(153,69,255,0.14), transparent 32%), linear-gradient(180deg, #16181f 0%, #0d1016 100%)",
        color: "#fff",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: "^on[A-Z].*" },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
    layout: "fullscreen",
  },
  globalTypes: {
    locale: {
      name: "Locale",
      defaultValue: "en",
      toolbar: {
        icon: "globe",
        items: [
          { value: "en", title: "English" },
          { value: "zh", title: "Chinese" },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => (
      <StoryFrame
        locale={
          (context.parameters.locale as UiLocale | undefined) ??
          (context.globals.locale as UiLocale)
        }
      >
        <Story />
      </StoryFrame>
    ),
  ],
};

export default preview;
