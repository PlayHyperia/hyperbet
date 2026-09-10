import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const EXPECTED_COMPONENTS = [
  "AgentStats",
  "FightOverlay",
  "OrderBook",
  "PointsHistory",
  "PointsLeaderboard",
  "PredictionMarketPanel",
  "RecentTrades",
  "ResizeHandle",
  "SolanaClobPanel",
  "SolanaLimitPriceField",
  "SolanaManagedOrderConfirmationDialog",
  "SolanaManagedOrders",
  "SolanaOrderQuoteNotice",
  "SolanaPointsDisplay",
  "SolanaReferralPanel",
  "SolanaSettlementActionCard",
  "SolanaSettlementHistory",
  "SolanaTransactionFeedbackCard",
  "StreamPlayer",
];

// Full-app frame stories were intentionally removed when the client roots were
// deduplicated. Keep this explicit so a new frame fixture cannot silently skip
// visual capture.
const EXPECTED_FRAMES = [];

const baseUrl =
  process.env.STORYBOOK_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:6006";
const outputDir = path.resolve(process.cwd(), "storybook-artifacts");

function readPngSize(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Screenshot is not a PNG");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

console.log("loading story index");
const indexResponse = await fetch(`${baseUrl}/index.json`);
if (!indexResponse.ok) {
  throw new Error(`Failed to load Storybook index (${indexResponse.status})`);
}

const index = await indexResponse.json();

function filterStories(prefix) {
  return Object.values(index.entries)
    .filter(
      (entry) => entry.type === "story" && entry.title.startsWith(`${prefix}/`),
    )
    .sort((left, right) => left.title.localeCompare(right.title));
}

const componentStories = filterStories("Components");
const frameStories = filterStories("Frames");

const renderedComponents = [
  ...new Set(
    componentStories.map((entry) => entry.title.replace("Components/", "")),
  ),
];
const renderedFrames = [
  ...new Set(frameStories.map((entry) => entry.title.replace("Frames/", ""))),
];

if (
  JSON.stringify(renderedComponents) !== JSON.stringify(EXPECTED_COMPONENTS)
) {
  throw new Error(
    `Component story coverage mismatch.\nexpected: ${EXPECTED_COMPONENTS.join(", ")}\nactual: ${renderedComponents.join(", ")}`,
  );
}

if (JSON.stringify(renderedFrames) !== JSON.stringify(EXPECTED_FRAMES)) {
  throw new Error(
    `Frame story coverage mismatch.\nexpected: ${EXPECTED_FRAMES.join(", ")}\nactual: ${renderedFrames.join(", ")}`,
  );
}

const allStories = [...componentStories, ...frameStories];

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

console.log("launching browser");
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});

const desktopProfile = {
  label: "desktop",
  suffix: "",
  viewport: { width: 1440, height: 1200 },
  reducedMotion: "no-preference",
  enforceNoHorizontalOverflow: false,
};
const mobileReducedMotionProfile = {
  label: "mobile + reduced motion",
  suffix: "-mobile-reduced-motion",
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
  enforceNoHorizontalOverflow: true,
};

for (const entry of allStories) {
  const profiles = [
    "Components/SolanaManagedOrderConfirmationDialog",
    "Components/SolanaManagedOrders",
    "Components/SolanaSettlementHistory",
    "Components/SolanaTransactionFeedbackCard",
  ].includes(entry.title)
    ? [desktopProfile, mobileReducedMotionProfile]
    : [desktopProfile];

  for (const profile of profiles) {
    const page = await browser.newPage({
      viewport: profile.viewport,
      reducedMotion: profile.reducedMotion,
    });
    const storyErrors = [];
    const handleConsole = (message) => {
      if (message.type() === "error") {
        const location = message.location();
        const source = location.url ? ` (${location.url})` : "";
        storyErrors.push(`${message.text()}${source}`);
      }
    };
    const handlePageError = (error) => {
      storyErrors.push(error.message);
    };
    const handleResponse = (response) => {
      if (response.status() >= 400) {
        storyErrors.push(`${response.status()} ${response.url()}`);
      }
    };
    page.on("console", handleConsole);
    page.on("pageerror", handlePageError);
    page.on("response", handleResponse);

    const url = `${baseUrl}/iframe.html?id=${entry.id}&viewMode=story`;
    process.stdout.write(`capturing ${entry.title} (${profile.label}) ... `);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(400);
    const root = page.locator("#storybook-root > *").first();
    await root.waitFor({
      state: "visible",
      timeout: 15_000,
    });
    const box = await root.boundingBox();
    if (!box || box.width < 120 || box.height < 120) {
      throw new Error(
        `Story rendered too small to verify: ${entry.title} (${profile.label})`,
      );
    }

    const bodyText = (await page.locator("body").innerText()).trim();
    if (/No Preview|ReferenceError|TypeError|Failed to fetch/i.test(bodyText)) {
      throw new Error(
        `Story failed to render cleanly: ${entry.title} (${profile.label})`,
      );
    }

    if (entry.title === "Components/SolanaClobPanel") {
      if (!bodyText.includes("0.482") || !bodyText.includes("0.518")) {
        throw new Error(
          "Solana CLOB fixture did not render both sides of the order book",
        );
      }
      if (/Checking network fees|正在核对网络费/i.test(bodyText)) {
        throw new Error(
          "Disconnected Solana CLOB fixture is stuck in wallet-funding checks",
        );
      }
    }

    if (
      entry.title === "Components/SolanaSettlementHistory" &&
      entry.name === "Connected Claimable"
    ) {
      if (
        !bodyText.includes("YES · e35419…8485") ||
        !bodyText.includes("Winnings ready to claim") ||
        !bodyText.includes("Claim winnings") ||
        bodyText.includes("Activity is temporarily unavailable")
      ) {
        throw new Error(
          `Connected settlement-history fixture did not render verified claimable activity (${profile.label})`,
        );
      }
      const identity = page.locator(
        '[data-testid="solana-settlement-identity-storybook-bet-1"]',
      );
      if (
        (await identity.getAttribute("title")) !==
        "streaming-e354197c-6db9-43af-90d6-9ae5d9898485"
      ) {
        throw new Error(
          `Connected settlement-history fixture lost its exact duel identity (${profile.label})`,
        );
      }
      const history = page.getByTestId("solana-settlement-history");
      const historyAccessibilityTree = await history.ariaSnapshot();
      for (const controlName of [
        "Refresh",
        "Claim winnings",
        "Recover order rent",
      ]) {
        if (!historyAccessibilityTree.includes(`button "${controlName}"`)) {
          throw new Error(
            `Connected settlement-history fixture lost the ${controlName} accessibility control (${profile.label})\n${historyAccessibilityTree}`,
          );
        }
      }
      const refresh = history.getByRole("button", { name: "Refresh" });
      const claim = history.getByRole("button", { name: "Claim winnings" });
      const recoverRent = history.getByRole("button", {
        name: "Recover order rent",
      });
      await refresh.focus();
      await page.keyboard.press("Tab");
      if (!(await claim.evaluate((node) => node === document.activeElement))) {
        throw new Error(
          `Claim action did not follow refresh in keyboard order (${profile.label})`,
        );
      }
      await page.keyboard.press("Tab");
      if (
        !(await recoverRent.evaluate((node) => node === document.activeElement))
      ) {
        throw new Error(
          `Order-rent recovery did not follow claim in keyboard order (${profile.label})`,
        );
      }
      for (const control of [refresh, claim, recoverRent]) {
        const box = await control.boundingBox();
        if (!box || box.height < 44) {
          throw new Error(
            `Settlement-history control is below the 44px touch target (${profile.label})`,
          );
        }
      }
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
    }

    if (profile.enforceNoHorizontalOverflow) {
      const layout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        bodyWidth: document.body.scrollWidth,
        documentWidth: document.documentElement.scrollWidth,
      }));
      if (
        layout.bodyWidth > layout.viewportWidth + 1 ||
        layout.documentWidth > layout.viewportWidth + 1
      ) {
        throw new Error(
          `Horizontal overflow in ${entry.title} (${profile.label}): viewport=${layout.viewportWidth}, body=${layout.bodyWidth}, document=${layout.documentWidth}`,
        );
      }
    }

    if (entry.title === "Components/SolanaTransactionFeedbackCard") {
      const feedback = page.locator(
        '[data-testid="storybook-transaction-feedback"]',
      );
      const state = await feedback.getAttribute("data-state");
      const expectedRole = state === "error" ? "alert" : "status";
      if ((await feedback.getAttribute("role")) !== expectedRole) {
        throw new Error(
          `Incorrect live-region role for ${entry.name} (${profile.label})`,
        );
      }
      const accessibilityTree = await feedback.ariaSnapshot();
      if (!accessibilityTree.startsWith(`- ${expectedRole}`)) {
        throw new Error(
          `Feedback is missing from the accessibility tree for ${entry.name} (${profile.label})\n${accessibilityTree}`,
        );
      }
      const reviewButtons = await feedback.getByRole("button").count();
      if (
        (state === "error" && reviewButtons !== 1) ||
        (state !== "error" && reviewButtons !== 0)
      ) {
        throw new Error(
          `Unexpected recovery-action count for ${entry.name} (${profile.label}): ${reviewButtons}`,
        );
      }
      const details = feedback.getByTestId(
        "storybook-transaction-feedback-details",
      );
      if (state === "confirmed") {
        if ((await details.count()) !== 1) {
          throw new Error(
            `Confirmed transaction proof disclosure is missing (${profile.label})`,
          );
        }
        const summary = details.locator("summary");
        if (
          !accessibilityTree.includes("group: Transaction proof") ||
          (await details.getAttribute("open")) !== null
        ) {
          throw new Error(
            `Confirmed transaction proof is not an accessible collapsed disclosure (${profile.label})\n${accessibilityTree}`,
          );
        }
        await summary.focus();
        if (
          !(await summary.evaluate((node) => node === document.activeElement))
        ) {
          throw new Error(
            `Transaction proof disclosure could not receive keyboard focus (${profile.label})`,
          );
        }
        await page.keyboard.press("Enter");
        if (
          (await details.getAttribute("open")) === null ||
          !(await feedback
            .getByTestId("storybook-transaction-signature")
            .isVisible()) ||
          !(await feedback
            .getByRole("link", { name: /View transaction/ })
            .isVisible())
        ) {
          throw new Error(
            `Keyboard activation did not reveal complete transaction proof (${profile.label})`,
          );
        }
        await page.keyboard.press("Enter");
        if ((await details.getAttribute("open")) !== null) {
          throw new Error(
            `Second keyboard activation did not collapse transaction proof (${profile.label})`,
          );
        }
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        });
      } else if ((await details.count()) !== 0) {
        throw new Error(
          `Non-confirmed transaction unexpectedly hid proof in a disclosure (${profile.label})`,
        );
      }

      const contrastResults = await feedback.evaluate((card) => {
        function parseColor(value) {
          const match = value.match(
            /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/,
          );
          if (!match) throw new Error(`Unsupported browser color: ${value}`);
          return {
            r: Number(match[1]),
            g: Number(match[2]),
            b: Number(match[3]),
            a: match[4] == null ? 1 : Number(match[4]),
          };
        }

        function composite(foreground, background) {
          const alpha = foreground.a + background.a * (1 - foreground.a);
          if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
          return {
            r:
              (foreground.r * foreground.a +
                background.r * background.a * (1 - foreground.a)) /
              alpha,
            g:
              (foreground.g * foreground.a +
                background.g * background.a * (1 - foreground.a)) /
              alpha,
            b:
              (foreground.b * foreground.a +
                background.b * background.a * (1 - foreground.a)) /
              alpha,
            a: alpha,
          };
        }

        function effectiveBackground(element) {
          const ancestors = [];
          let current = element;
          while (current instanceof Element) {
            ancestors.push(current);
            current = current.parentElement;
          }
          let background = { r: 255, g: 255, b: 255, a: 1 };
          for (const ancestor of ancestors.reverse()) {
            background = composite(
              parseColor(getComputedStyle(ancestor).backgroundColor),
              background,
            );
          }
          return background;
        }

        function luminance(color) {
          const channels = [color.r, color.g, color.b].map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return (
            0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
          );
        }

        return Array.from(
          card.querySelectorAll(
            "strong, code, a, button, [data-testid$='-warning']",
          ),
        ).map((element) => {
          const background = effectiveBackground(element);
          const foreground = composite(
            parseColor(getComputedStyle(element).color),
            background,
          );
          const lighter = Math.max(
            luminance(foreground),
            luminance(background),
          );
          const darker = Math.min(luminance(foreground), luminance(background));
          return {
            element: element.tagName.toLowerCase(),
            text: element.textContent?.trim().slice(0, 60) ?? "",
            ratio: (lighter + 0.05) / (darker + 0.05),
          };
        });
      });
      const contrastFailures = contrastResults.filter(
        (result) => result.ratio < 4.5,
      );
      if (contrastFailures.length > 0) {
        throw new Error(
          `WCAG text contrast failure for ${entry.name} (${profile.label}): ${JSON.stringify(contrastFailures)}`,
        );
      }
    }

    const safeTitle = entry.title.replace(/^(Components|Frames)\//, "");
    const safeName = entry.name.toLowerCase().replace(/\s+/g, "-");
    const screenshotPath = path.join(
      outputDir,
      `${safeTitle}-${safeName}${profile.suffix}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshotBuffer = await fs.readFile(screenshotPath);
    const { width, height } = readPngSize(screenshotBuffer);
    if (width < profile.viewport.width || height < profile.viewport.height) {
      throw new Error(
        `Screenshot dimensions too small for ${entry.title} (${profile.label}): ${width}x${height}`,
      );
    }
    if (storyErrors.length > 0) {
      throw new Error(
        `Story emitted console/page errors: ${entry.title} (${profile.label})\n${storyErrors.join("\n")}`,
      );
    }

    await page.close();
    process.stdout.write("ok\n");
  }
}

await browser.close();
