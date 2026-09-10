import "./setup";
import { act } from "react";
import { afterEach, describe, expect, it } from "bun:test";

import { SolanaPointsDisplay } from "../src/components/SolanaPointsDisplay";
import { SolanaReferralPanel } from "../src/components/SolanaReferralPanel";
import { PointsHistory } from "../src/components/PointsHistory";
import { PointsLeaderboard } from "../src/components/PointsLeaderboard";
import { getByTestId, render } from "./render";

const originalFetch = globalThis.fetch;

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL("http://localhost/");
});

describe("Solana launch rewards UI", () => {
  it("renders non-cash points without token balances or multipliers", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/rank/")) {
        return Response.json({ rank: 7 });
      }
      return Response.json({
        totalPoints: 1250,
        selfPoints: 100,
        winPoints: 1000,
        referralPoints: 150,
      });
    }) as typeof fetch;

    const { container } = render(
      <SolanaPointsDisplay walletAddress="wallet-1" />,
    );
    await flushEffects();

    expect(container.textContent).toContain("1,250");
    expect(container.textContent).toContain("Rank #7");
    expect(container.textContent).toContain("100/1000/150");
    expect(container.textContent).not.toContain("multiplier");
  });

  it("keeps referrals Solana-only and does not display cash fee sharing", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/api/arena/invite/")) {
        return Response.json({
          inviteCode: "SOL123",
          invitedWalletCount: 3,
          activeReferralCount: 2,
          pendingSignupBonuses: 1,
          totalReferralWinPoints: 25,
        });
      }
      return Response.json({ totalPoints: 500, referredBy: null });
    }) as typeof fetch;

    const { container } = render(
      <SolanaReferralPanel solanaWallet="solana-wallet-1" />,
    );
    await flushEffects();

    expect(container.textContent).toContain("SOL123");
    expect(
      container.querySelector('[data-testid="referral-panel-invite-code"]')
        ?.textContent,
    ).toBe("SOL123");
    expect(container.textContent).toContain("Referrals: 2/3");
    expect(container.textContent).not.toContain("Fee Share");
    expect(container.textContent).not.toContain("Link Wallets");
  });

  it("creates and redeems invite codes only after an exact wallet signature", async () => {
    const wallet = "11111111111111111111111111111111";
    let inviteCode: string | null = null;
    const signedMessages: string[] = [];
    const postedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        postedBodies.push(body);
        if (url.endsWith("/api/arena/invite/register")) {
          inviteCode = "HS12AB34CD";
          return Response.json({ wallet, inviteCode });
        }
        return Response.json({
          result: { alreadyRedeemed: false, signupBonus: 50 },
        });
      }
      if (url.includes("/api/arena/invite/")) {
        return Response.json({
          inviteCode,
          invitedWalletCount: 0,
          activeReferralCount: 0,
          pendingSignupBonuses: 0,
          totalReferralWinPoints: 0,
        });
      }
      return Response.json({ totalPoints: 0, referred: false });
    }) as typeof fetch;

    const signMessage = async (message: Uint8Array) => {
      signedMessages.push(new TextDecoder().decode(message));
      return new Uint8Array(64).fill(9);
    };
    const firstRender = render(
      <SolanaReferralPanel solanaWallet={wallet} signMessage={signMessage} />,
    );
    let container = firstRender.container;
    await flushEffects();

    await act(async () => {
      getByTestId(container, "referral-panel-create-button").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushEffects();
    expect(
      getByTestId(container, "referral-panel-invite-code").textContent,
    ).toBe("HS12AB34CD");
    expect(getByTestId(container, "referral-panel-status").textContent).toBe(
      "Invite code created",
    );

    firstRender.unmount();
    (
      window as unknown as { happyDOM: { setURL: (url: string) => void } }
    ).happyDOM.setURL("http://localhost/?invite=HS12AB34CD");
    const secondRender = render(
      <SolanaReferralPanel solanaWallet={wallet} signMessage={signMessage} />,
    );
    container = secondRender.container;
    await flushEffects();

    const redeemInput = getByTestId(
      container,
      "referral-panel-redeem-input",
    ) as HTMLInputElement;
    expect(redeemInput.disabled).toBe(false);
    expect(redeemInput.value).toBe("HS12AB34CD");
    await flushEffects();
    const redeemButton = getByTestId(
      container,
      "referral-panel-redeem-button",
    ) as HTMLButtonElement;
    expect(redeemButton.disabled).toBe(false);
    await act(async () => {
      redeemButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushEffects();

    expect(signedMessages).toHaveLength(2);
    expect(signedMessages[0]).toContain("Action: invite-register");
    expect(signedMessages[0]).toContain("Invite Code: none");
    expect(signedMessages[1]).toContain("Action: invite-redeem");
    expect(signedMessages[1]).toContain("Invite Code: HS12AB34CD");
    expect(postedBodies).toHaveLength(2);
    expect(getByTestId(container, "referral-panel-status").textContent).toBe(
      "Invite code redeemed",
    );
    for (const body of postedBodies) {
      expect(body.wallet).toBe(wallet);
      expect(body.issuedAtMs).toEqual(expect.any(Number));
      expect(body.signature).toEqual(
        expect.stringMatching(/^[A-Za-z0-9+/]{86}==$/u),
      );
    }
  });

  it("renders every points event emitted by the SOL launch ledger", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        entries: [
          {
            id: 1,
            eventType: "BET_FILL",
            status: "CONFIRMED",
            totalPoints: 40,
            referenceType: "BET",
            referenceId: "bet-1",
            relatedWallet: null,
            createdAt: Date.now(),
          },
          {
            id: 2,
            eventType: "REFERRAL_FILL",
            status: "CONFIRMED",
            totalPoints: 4,
            referenceType: "BET",
            referenceId: "bet-1",
            relatedWallet: "referral-wallet",
            createdAt: Date.now(),
          },
        ],
        total: 2,
      })) as unknown as typeof fetch;

    const { container } = render(
      <PointsHistory walletAddress="solana-wallet-1" locale="en" />,
    );
    await flushEffects();

    expect(container.textContent).toContain("Bet Filled");
    expect(container.textContent).toContain("Referral Fill");
    const filterValues = Array.from(
      container.querySelectorAll<HTMLSelectElement>(
        '[data-testid="points-history-filter"] option',
      ),
    ).map((option) => option.value);
    expect(filterValues).toEqual([
      "",
      "BET_PLACED",
      "BET_FILL",
      "REFERRAL_WIN",
      "REFERRAL_FILL",
      "SIGNUP_REFERRER",
      "SIGNUP_REFEREE",
    ]);
    expect(
      container
        .querySelector('[data-testid="points-history-filter"]')
        ?.getAttribute("aria-label"),
    ).toBe("History event filter");
    expect(
      container.querySelector('[role="list"]')?.getAttribute("aria-label"),
    ).toBe("History");
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(container.textContent).not.toContain("Staking");
    expect(container.textContent).not.toContain("Wallet Link");
  });

  it("requests a wallet-only leaderboard without legacy identity scope", async () => {
    const requestUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestUrls.push(String(input));
      return Response.json({
        leaderboard: [
          { rank: 1, wallet: "solana-wallet-1", totalPoints: 1250 },
        ],
      });
    }) as typeof fetch;

    const { container } = render(<PointsLeaderboard locale="en" />);
    await flushEffects();

    expect(requestUrls).toHaveLength(1);
    const requestUrl = new URL(requestUrls[0]!, "http://localhost");
    expect(requestUrl.searchParams.get("scope")).toBeNull();
    expect(requestUrl.searchParams.get("window")).toBe("alltime");
    expect(container.textContent).toContain("1,250");
    expect(
      container.querySelector('[role="table"]')?.getAttribute("aria-label"),
    ).toBe("Leaderboard");
    expect(container.querySelectorAll('[role="rowgroup"]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(
      container
        .querySelector('[data-testid="points-leaderboard-window-alltime"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid^="points-leaderboard-scope-"]'),
    ).toBeNull();
  });
});
