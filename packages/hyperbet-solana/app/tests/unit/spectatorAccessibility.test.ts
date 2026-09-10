import { describe, expect, test } from "bun:test";

import {
  READ_ONLY_SPECTATOR_BOTTOM_TABS,
  SPECTATOR_BOTTOM_TABS,
  getSpectatorBottomTabs,
  selectRovingTabFromKey,
  selectSpectatorTabFromKey,
  shouldShowBetActionIcon,
} from "../../src/spectator/accessibility";

describe("spectator keyboard navigation", () => {
  test("moves through the tab rail with wrapping arrow navigation", () => {
    expect(selectSpectatorTabFromKey("news", "ArrowRight")).toBe("trades");
    expect(selectSpectatorTabFromKey("news", "ArrowLeft")).toBe("holders");
    expect(selectSpectatorTabFromKey("positions", "ArrowRight")).toBe(
      "holders",
    );
    expect(selectSpectatorTabFromKey("holders", "ArrowLeft")).toBe("positions");
  });

  test("supports Home and End without intercepting unrelated keys", () => {
    expect(selectSpectatorTabFromKey("trades", "Home")).toBe(
      SPECTATOR_BOTTOM_TABS[0],
    );
    expect(selectSpectatorTabFromKey("trades", "End")).toBe(
      SPECTATOR_BOTTOM_TABS[SPECTATOR_BOTTOM_TABS.length - 1],
    );
    expect(selectSpectatorTabFromKey("trades", "Enter")).toBeNull();
    expect(selectSpectatorTabFromKey("trades", "Tab")).toBeNull();
  });

  test("removes unavailable trading tabs from read-only spectator mode", () => {
    expect(getSpectatorBottomTabs(false)).toEqual([
      "holders",
      "news",
      "topTraders",
    ]);
    expect(getSpectatorBottomTabs(false)).toBe(READ_ONLY_SPECTATOR_BOTTOM_TABS);
    expect(getSpectatorBottomTabs(true)).toBe(SPECTATOR_BOTTOM_TABS);
  });

  test("keeps keyboard navigation inside the tabs that are actually rendered", () => {
    expect(
      selectSpectatorTabFromKey(
        "news",
        "ArrowRight",
        READ_ONLY_SPECTATOR_BOTTOM_TABS,
      ),
    ).toBe("topTraders");
    expect(
      selectSpectatorTabFromKey(
        "holders",
        "ArrowLeft",
        READ_ONLY_SPECTATOR_BOTTOM_TABS,
      ),
    ).toBe("topTraders");
    expect(
      selectSpectatorTabFromKey(
        "topTraders",
        "ArrowRight",
        READ_ONLY_SPECTATOR_BOTTOM_TABS,
      ),
    ).toBe("holders");
    expect(
      selectSpectatorTabFromKey(
        "news",
        "Home",
        READ_ONLY_SPECTATOR_BOTTOM_TABS,
      ),
    ).toBe("holders");
    expect(
      selectSpectatorTabFromKey("news", "End", READ_ONLY_SPECTATOR_BOTTOM_TABS),
    ).toBe("topTraders");
    expect(
      selectSpectatorTabFromKey(
        "trades",
        "ArrowRight",
        READ_ONLY_SPECTATOR_BOTTOM_TABS,
      ),
    ).toBeNull();
  });

  test("provides the same roving keyboard contract to other tab surfaces", () => {
    const tabs = ["leaderboard", "history", "referral"] as const;
    expect(selectRovingTabFromKey("leaderboard", "ArrowLeft", tabs)).toBe(
      "referral",
    );
    expect(selectRovingTabFromKey("leaderboard", "ArrowRight", tabs)).toBe(
      "history",
    );
    expect(selectRovingTabFromKey("history", "Home", tabs)).toBe("leaderboard");
    expect(selectRovingTabFromKey("history", "End", tabs)).toBe("referral");
    expect(selectRovingTabFromKey("history", "Tab", tabs)).toBeNull();
  });

  test("shows an add-bet icon only when placing a bet is actually available", () => {
    expect(
      shouldShowBetActionIcon({
        transactionsEnabled: true,
        canPlaceBet: true,
      }),
    ).toBe(true);
    expect(
      shouldShowBetActionIcon({
        transactionsEnabled: true,
        canPlaceBet: false,
      }),
    ).toBe(false);
    expect(
      shouldShowBetActionIcon({
        transactionsEnabled: false,
        canPlaceBet: true,
      }),
    ).toBe(false);
  });
});
