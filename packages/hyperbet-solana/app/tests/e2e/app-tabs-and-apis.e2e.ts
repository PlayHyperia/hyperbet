import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

type E2eState = {
  solanaTraderPublicKey?: string;
  currentDuelId?: string;
  currentDuelKeyHex?: string;
  currentPhase?: string;
  currentDuelSource?: "synthetic_publish" | "real_hyperia";
  clobMarketState?: string;
};

type StreamingStateResponse = {
  cycle: {
    agent1: { name: string } | null;
    agent2: { name: string } | null;
    phase: string;
  };
  leaderboard: Array<{ rank: number; name: string }>;
};

type PointsResponse = {
  totalPoints: number;
  invitedWalletCount: number;
  referredBy: { wallet: string; code: string } | null;
};

type InviteResponse = {
  inviteCode: string | null;
  inviteRegistrationRequired: boolean;
};

type PredictionMarketsResponse = {
  duel: {
    duelKey: string | null;
    duelId: string | null;
    phase: string | null;
    winner: string;
    betCloseTime: number | null;
  };
  markets: Array<{
    chainKey: string;
    duelKey: string | null;
    duelId: string | null;
    marketId: string | null;
    marketRef: string | null;
    lifecycleStatus: string;
    winner: string;
    betCloseTime: number | null;
    contractAddress: string | null;
    programId: string | null;
    txRef: string | null;
    syncedAt: number | null;
    metadata?: {
      proposalId?: string | null;
      challengeWindowEndsAt?: number | null;
      finalizedAt?: number | null;
      cancellationReason?: string | null;
    };
  }>;
  updatedAt: number | null;
};

type KeeperBotHealthResponse = {
  ok: boolean;
  running: boolean;
  health: {
    chainKey: string;
    updatedAtMs: number;
    running: boolean;
    recovery: string[];
    markets: Array<{
      lifecycleStatus: string;
      marketRef: string | null;
    }>;
  } | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.resolve(__dirname, "./state.json");
const GAME_API_URL = (process.env.E2E_GAME_API_URL || "http://127.0.0.1:5555")
  .trim()
  .replace(/\/$/, "");
const EXPECT_KEEPER_BOT =
  (process.env.E2E_EXPECT_KEEPER_BOT?.trim().toLowerCase() ?? "true") !==
  "false";

function loadState(): E2eState {
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as E2eState;
}

async function fetchJson<T>(
  request: APIRequestContext,
  pathname: string,
): Promise<T> {
  const response = await request.get(`${GAME_API_URL}${pathname}`);
  expect(response.ok(), `GET ${pathname} should succeed`).toBeTruthy();
  return (await response.json()) as T;
}

async function gotoApp(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/?debug=1", { waitUntil: "domcontentloaded" });
    try {
      await expect
        .poll(
          async () => {
            const bodyText = (
              (await page
                .locator("body")
                .textContent()
                .catch(() => "")) || ""
            )
              .trim()
              .toUpperCase();
            if (
              bodyText.includes("HYPERIA DUEL ARENA") ||
              bodyText.includes("ULTRA SIMPLE FIGHT BET")
            ) {
              return bodyText;
            }
            return "";
          },
          {
            timeout: 20_000,
            intervals: [500, 1_000, 2_000, 5_000],
          },
        )
        .not.toBe("");
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.goto("about:blank");
    }
  }
}

async function ensureWalletConnected(page: Page): Promise<void> {
  const hasConnectedSolanaWallet = async (): Promise<boolean> => {
    const desktopWalletChip = page
      .getByRole("button", { name: /^SOL\s+[A-Za-z0-9].*/i })
      .first();
    if (await desktopWalletChip.isVisible().catch(() => false)) return true;

    const mobileWalletChip = page
      .getByRole("button", { name: /^◎\s*[A-Za-z0-9].*/i })
      .first();
    if (await mobileWalletChip.isVisible().catch(() => false)) return true;

    return false;
  };

  const selectHeadlessWallet = async (): Promise<boolean> => {
    const walletOption = page
      .getByRole("button", { name: /E2E Trader/i })
      .first();
    if (!(await walletOption.isVisible().catch(() => false))) return false;
    await walletOption.click();
    await expect(
      page.getByRole("dialog", {
        name: /Connect a wallet on Solana to continue/i,
      }),
    )
      .toBeHidden({ timeout: 30_000 })
      .catch(() => undefined);
    return true;
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await hasConnectedSolanaWallet()) return;

    if (await selectHeadlessWallet()) {
      await page.waitForTimeout(1_500);
      continue;
    }

    const connectButton = page
      .getByRole("button", {
        name: /connect wallet|select wallet|connect|add sol wallet|connect sol/i,
      })
      .first();
    if (await connectButton.isVisible().catch(() => false)) {
      await connectButton.click();
    }
    await selectHeadlessWallet();
    await page.waitForTimeout(1_500);
  }

  await expect.poll(hasConnectedSolanaWallet, { timeout: 60_000 }).toBe(true);
}

async function selectChain(_page: Page, _chain: "solana"): Promise<void> {
  // Solana is the only supported runtime for this package.
}

test.describe("app tabs and api coverage", () => {
  test("keeper backend exposes all app-facing data endpoints", async ({
    request,
  }) => {
    const state = loadState();
    const wallet = state.solanaTraderPublicKey || "";

    const status = await fetchJson<{ service: string }>(request, "/status");
    expect(status.service).toBe("hyperbet-solana-backend");

    const expectedPhase = state.currentPhase || "ANNOUNCEMENT";
    const streamState = await fetchJson<StreamingStateResponse>(
      request,
      "/api/streaming/state",
    );
    expect(streamState.cycle.phase).toBe(expectedPhase);
    expect(streamState.cycle.agent1?.name).toBeTruthy();
    expect(streamState.leaderboard.length).toBeGreaterThan(0);

    const duelContext = await fetchJson<StreamingStateResponse>(
      request,
      "/api/streaming/duel-context",
    );
    expect(duelContext.cycle.agent1?.name).toBe(streamState.cycle.agent1?.name);

    const predictionMarkets = await fetchJson<PredictionMarketsResponse>(
      request,
      "/api/arena/prediction-markets/active",
    );
    expect(predictionMarkets.duel.phase).toBe(streamState.cycle.phase);
    expect(predictionMarkets.duel.duelId).toBe(state.currentDuelId || null);
    expect(predictionMarkets.duel.duelKey).toBe(
      state.currentDuelKeyHex || null,
    );
    const solanaMarket = predictionMarkets.markets.find(
      (market) => market.chainKey === "solana",
    );
    expect(solanaMarket).toBeTruthy();
    expect(solanaMarket?.marketRef).toBe(state.clobMarketState || null);
    expect([
      "OPEN",
      "LOCKED",
      "PROPOSED",
      "CHALLENGED",
      "RESOLVED",
      "CANCELLED",
      "PENDING",
      "UNKNOWN",
    ]).toContain(solanaMarket?.lifecycleStatus);
    expect(
      solanaMarket?.metadata?.proposalId == null ||
        typeof solanaMarket.metadata.proposalId === "string",
    ).toBe(true);
    expect(
      solanaMarket?.metadata?.challengeWindowEndsAt == null ||
        typeof solanaMarket.metadata.challengeWindowEndsAt === "number",
    ).toBe(true);
    expect(
      solanaMarket?.metadata?.finalizedAt == null ||
        typeof solanaMarket.metadata.finalizedAt === "number",
    ).toBe(true);
    expect(
      solanaMarket?.metadata?.cancellationReason == null ||
        typeof solanaMarket.metadata.cancellationReason === "string",
    ).toBe(true);

    await expect
      .poll(async () => {
        const response = await request.get(
          `${GAME_API_URL}/api/keeper/bot-health`,
        );
        const botHealth = (await response.json()) as KeeperBotHealthResponse;
        return {
          running: botHealth.running,
          chainKey: botHealth.health?.chainKey ?? null,
          updated: Number(botHealth.health?.updatedAtMs ?? 0) > 0,
          hasMarket: Boolean(
            botHealth.health?.markets.some(
              (market) =>
                market.marketRef === state.clobMarketState &&
                market.lifecycleStatus === "OPEN",
            ),
          ),
          recovery: Array.isArray(botHealth.health?.recovery),
        };
      })
      .toEqual({
        running: EXPECT_KEEPER_BOT,
        chainKey: "solana",
        updated: true,
        hasMarket: true,
        recovery: true,
      });

    const points = await fetchJson<PointsResponse>(
      request,
      `/api/arena/points/${encodeURIComponent(wallet)}?scope=wallet`,
    );
    expect(points.totalPoints).toBeGreaterThanOrEqual(0);
    expect(points.invitedWalletCount).toBeGreaterThanOrEqual(0);

    const invite = await fetchJson<InviteResponse>(
      request,
      `/api/arena/invite/${encodeURIComponent(wallet)}?platform=solana`,
    );
    expect(invite.inviteCode).toBeNull();
    expect(invite.inviteRegistrationRequired).toBe(true);

    for (const retiredPath of [
      "/api/perps/markets",
      "/api/models/markets",
      "/api/proxy/evm/rpc",
    ]) {
      const response = await request.get(`${GAME_API_URL}${retiredPath}`);
      expect(response.status(), `${retiredPath} must stay inaccessible`).toBe(
        404,
      );
    }
  });

  test("every duels tab and points drawer tab renders live data", async ({
    page,
    request,
  }) => {
    const state = loadState();
    const wallet = state.solanaTraderPublicKey || "";
    const streamState = await fetchJson<StreamingStateResponse>(
      request,
      "/api/streaming/state",
    );

    const points = await fetchJson<PointsResponse>(
      request,
      `/api/arena/points/${encodeURIComponent(wallet)}?scope=wallet`,
    );
    const invite = await fetchJson<InviteResponse>(
      request,
      `/api/arena/invite/${encodeURIComponent(wallet)}?platform=solana`,
    );

    await gotoApp(page);
    await selectChain(page, "solana");
    await ensureWalletConnected(page);

    await page.getByTestId("duels-bottom-tab-trades").click();
    await expect(page.getByTestId("duels-bottom-panel-trades")).toBeVisible();

    await page.getByTestId("duels-bottom-tab-orders").click();
    await expect(page.getByTestId("duels-bottom-panel-orders")).toBeVisible();
    await expect(page.getByTestId("duels-bottom-panel-orders")).toContainText(
      "BIDS",
    );

    await page.getByTestId("duels-bottom-tab-positions").click();
    await expect(
      page.getByTestId("duels-bottom-panel-positions"),
    ).toBeVisible();
    await expect(
      page.getByTestId("duels-bottom-panel-positions"),
    ).toContainText("No open positions");

    await page.getByTestId("duels-bottom-tab-news").click();
    await expect(page.getByTestId("duels-bottom-panel-news")).toBeVisible();
    await expect(page.getByTestId("duels-bottom-panel-news")).toContainText(
      /next match|betting open|watching now/i,
    );

    await page.getByTestId("duels-bottom-tab-holders").click();
    await expect(page.getByTestId("duels-bottom-panel-holders")).toBeVisible();
    await expect(page.getByTestId("duels-bottom-panel-holders")).toContainText(
      streamState.cycle.agent1?.name || "",
    );
    await expect(page.getByTestId("duels-bottom-panel-holders")).toContainText(
      streamState.cycle.agent2?.name || "",
    );

    await page.getByTestId("duels-bottom-tab-topTraders").click();
    await expect(
      page.getByTestId("duels-bottom-panel-topTraders"),
    ).toBeVisible();
    await expect(
      page.getByTestId("duels-bottom-panel-topTraders"),
    ).toContainText(streamState.leaderboard[0]?.name || "");
    await expect(
      page.getByRole("table", { name: "Leaderboard" }),
    ).toBeVisible();

    await page
      .locator('[data-testid="points-drawer-open"]:visible')
      .first()
      .click();
    await expect(page.getByTestId("points-drawer")).toBeVisible();
    await expect(page.getByTestId("points-drawer-overlay")).toHaveCSS(
      "position",
      "fixed",
    );
    await expect(page.getByTestId("points-drawer")).toHaveCSS(
      "overflow-y",
      "auto",
    );
    await expect(
      page.getByRole("tablist", {
        name: "Leaderboard & Stats",
      }),
    ).toBeVisible();
    await expect(
      page.getByTestId("points-drawer-tab-leaderboard"),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      await page
        .getByTestId("points-drawer-close")
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      "hidden",
    );

    await expect(page.getByTestId("points-display-total").last()).toContainText(
      points.totalPoints.toLocaleString(),
    );

    await expect(
      page.getByTestId("points-drawer-panel-leaderboard"),
    ).toBeVisible();

    await page.getByTestId("points-drawer-tab-leaderboard").press("ArrowRight");
    await expect(page.getByTestId("points-drawer-panel-history")).toBeVisible();
    await expect(page.getByTestId("points-drawer-tab-history")).toBeFocused();
    await page.getByTestId("points-drawer-tab-history").press("End");
    await expect(
      page.getByTestId("points-drawer-panel-referral"),
    ).toBeVisible();
    await expect(page.getByTestId("points-drawer-tab-referral")).toBeFocused();
    expect(invite.inviteCode).toBeNull();
    expect(invite.inviteRegistrationRequired).toBe(true);
    const inviteCode = page.getByTestId("referral-panel-invite-code");
    const createInvite = page.getByTestId("referral-panel-create-button");
    await expect(inviteCode).toHaveText("-");
    await expect(createInvite).toBeEnabled();
    expect(
      await createInvite.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(44);
    await createInvite.click();
    await expect(page.getByTestId("referral-panel-status")).toHaveText(
      "Invite code created",
    );
    await expect(inviteCode).toHaveText(/^HS[A-F0-9]{8}$/u);
    const createdInviteCode = (await inviteCode.textContent())?.trim() ?? "";
    const persistedInvite = await fetchJson<InviteResponse>(
      request,
      `/api/arena/invite/${encodeURIComponent(wallet)}?platform=solana`,
    );
    expect(persistedInvite).toMatchObject({
      inviteCode: createdInviteCode,
      inviteRegistrationRequired: false,
    });
    await expect(createInvite).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy Link" })).toBeVisible();
    await expect(page.getByTestId("referral-panel-redeem-input")).toBeVisible();
    await expect(
      page.getByTestId("referral-panel-redeem-button"),
    ).toBeDisabled();
    await expect(page.getByTestId("referral-panel-redeem-input")).toHaveValue(
      "",
    );
    await expect(page.getByTestId("referral-panel-link-wallets")).toHaveCount(
      0,
    );

    await page.getByTestId("points-drawer-close").click();
    await expect(page.getByTestId("points-drawer")).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });
});
