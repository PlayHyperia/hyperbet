import { expect, test } from "@playwright/test";

const IS_READ_ONLY_PRODUCTION_PREVIEW =
  process.env.E2E_APP_RUNTIME === "production_preview" &&
  process.env.E2E_PRODUCTION_TRANSACTIONS === "false";

test.describe("production spectator transaction authority", () => {
  test.skip(
    !IS_READ_ONLY_PRODUCTION_PREVIEW,
    "requires the fail-closed production preview rail",
  );

  test("keeps the public production bundle read-only without an embedded wallet", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const app = page.locator(".hm-root");
    await expect(app).toBeVisible();
    await expect(app).toHaveAttribute("data-market-can-place-bet", "false");

    const matchDetails = page.getByRole("complementary", {
      name: "Live match details",
    });
    await expect(matchDetails).toBeVisible();
    await expect(matchDetails).toContainText(
      "Real-money betting is disabled in this local preview.",
    );

    await expect(page.getByRole("button", { name: /^SOL\s+/i })).toHaveCount(0);
    await expect(page.getByRole("spinbutton")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /buy yes/i })).toHaveCount(0);
    await expect(page.getByText("E2E Trader", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("dialog", {
        name: /connect a wallet on solana to continue/i,
      }),
    ).toHaveCount(0);
  });
});
