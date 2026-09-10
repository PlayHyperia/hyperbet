#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const styles = fs.readFileSync(
  path.resolve(appRoot, "../../hyperbet-ui/src/styles.css"),
  "utf8",
);
const captureInput = process.env.HYPERBET_HEADER_CAPTURE_DIR?.trim();
const captureDirectory = captureInput
  ? path.resolve(appRoot, captureInput)
  : null;
if (captureDirectory) fs.mkdirSync(captureDirectory, { recursive: true });

const matchup = "Persisted Chaos Alpha vs Persisted Chaos Beta";
const viewports = [
  { name: "desktop-1280", width: 1280, mobile: false },
  { name: "compact-1100", width: 1100, mobile: false },
  { name: "tablet-1024", width: 1024, mobile: false },
  { name: "narrow-desktop-800", width: 800, mobile: false },
  { name: "mobile-768", width: 768, mobile: true },
  { name: "mobile-390", width: 390, mobile: true },
];

function desktopMarkup() {
  return `
    <main class="hm-root">
      <header class="hm-header" role="banner">
        <div class="hm-header-left">
          <div class="hm-logo">
            <span class="hm-logo-text">HYPERBET</span>
            <span class="hm-logo-context">HYPERIA DUEL ARENA</span>
          </div>
          <div class="hm-market-info">
            <span class="hm-market-name" title="${matchup}" aria-label="Current matchup: ${matchup}">${matchup}</span>
          </div>
        </div>
        <div class="hm-header-right">
          <span class="hm-live-state"><span class="hm-live-state-dot hm-live-state-dot--connected"></span>Connected</span>
          <span class="hm-local-test-state">Local test</span>
          <span class="hm-header-points-fixture">★ 2</span>
          <button class="dock-collapse-btn" type="button">Stats</button>
          <button class="hm-wallet-btn hm-wallet-btn--linked" type="button">SOL HJge...tWfQ</button>
        </div>
      </header>
    </main>`;
}

function mobileMarkup() {
  return `
    <main class="hm-root">
      <header class="hm-header" role="banner">
        <div class="hm-header-mob-row1">
          <div class="hm-logo"><span class="hm-logo-text hm-logo-text--stacked">HYPERBET</span><span class="hm-logo-context">HYPERIA DUEL ARENA</span></div>
          <div class="hm-header-mob-controls"><button class="hm-header-mob-icon-btn">Stats</button><button class="hm-header-mob-wallet-btn hm-header-mob-wallet-btn--linked">◎ HJge…</button></div>
        </div>
      </header>
      <div class="hm-mob-phase-strip"><span class="hm-phase-badge hm-phase-badge--resolution">Result</span><span class="hm-mob-phase-strip-meta" title="${matchup}" aria-label="Current matchup: ${matchup}">${matchup}</span></div>
    </main>`;
}

const browser = await chromium.launch({ headless: true });
const failures = [];
let assertions = 0;

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: 220 },
    });
    await page.setContent(`<!doctype html><html><head><style>
      * { box-sizing: border-box; }
      html, body { width: 100%; min-height: 100%; margin: 0; overflow-x: hidden; background: #0a0a0a; }
      ${styles}
      .hm-header-points-fixture { display:flex;align-items:center;min-height:36px;padding:0 10px;border:1px solid var(--hm-border);white-space:nowrap; }
    </style></head><body>${viewport.mobile ? mobileMarkup() : desktopMarkup()}</body></html>`);

    const selector = viewport.mobile
      ? ".hm-mob-phase-strip-meta"
      : ".hm-market-name";
    const geometry = await page.evaluate(
      ({ selector, matchup, mobile }) => {
        const target = document.querySelector(selector);
        const header = document.querySelector(".hm-header");
        const left = document.querySelector(".hm-header-left");
        const right = document.querySelector(".hm-header-right");
        const logoText = document.querySelector(".hm-logo-text");
        const logoContext = document.querySelector(".hm-logo-context");
        const rect = (element) => {
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return {
            left: value.left,
            right: value.right,
            top: value.top,
            bottom: value.bottom,
          };
        };
        const hasClippedText = (element) => {
          if (!element) return true;
          const elementRect = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          return (
            element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1 ||
            Array.from(range.getClientRects()).some(
              (textRect) =>
                textRect.left < elementRect.left - 1 ||
                textRect.right > elementRect.right + 1 ||
                textRect.top < elementRect.top - 1 ||
                textRect.bottom > elementRect.bottom + 1,
            )
          );
        };
        return {
          text: target?.textContent?.trim() ?? null,
          title: target?.getAttribute("title") ?? null,
          ariaLabel: target?.getAttribute("aria-label") ?? null,
          clipped: hasClippedText(target),
          target: rect(target),
          header: rect(header),
          left: rect(left),
          right: rect(right),
          logoTextDisplay: logoText ? getComputedStyle(logoText).display : null,
          logoContextDisplay: logoContext
            ? getComputedStyle(logoContext).display
            : null,
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          mobile,
          matchup,
        };
      },
      { selector, matchup, mobile: viewport.mobile },
    );

    for (const [field, actual, expected] of [
      ["text", geometry.text, matchup],
      ["title", geometry.title, matchup],
      ["aria-label", geometry.ariaLabel, `Current matchup: ${matchup}`],
    ]) {
      assertions++;
      if (actual !== expected) {
        failures.push({ viewport: viewport.name, field, actual, expected });
      }
    }
    assertions++;
    if (geometry.clipped) {
      failures.push({ viewport: viewport.name, reason: "matchup_clipped" });
    }
    assertions++;
    if (geometry.scrollWidth > geometry.viewportWidth) {
      failures.push({
        viewport: viewport.name,
        reason: "horizontal_overflow",
        actual: geometry.scrollWidth,
        expectedMaximum: geometry.viewportWidth,
      });
    }

    if (!viewport.mobile) {
      assertions += 2;
      if (
        !geometry.left ||
        !geometry.right ||
        geometry.left.right > geometry.right.left + 1
      ) {
        failures.push({
          viewport: viewport.name,
          reason: "header_groups_overlap",
          left: geometry.left,
          right: geometry.right,
        });
      }
      const logoShouldBeHidden = viewport.width <= 1100;
      if (
        (geometry.logoTextDisplay === "none") !== logoShouldBeHidden ||
        (geometry.logoContextDisplay === "none") !== logoShouldBeHidden
      ) {
        failures.push({
          viewport: viewport.name,
          reason: "compact_brand_visibility_mismatch",
          logoTextDisplay: geometry.logoTextDisplay,
          logoContextDisplay: geometry.logoContextDisplay,
          logoShouldBeHidden,
        });
      }
    }

    if (captureDirectory) {
      await page.screenshot({
        path: path.join(captureDirectory, `${viewport.name}.png`),
        fullPage: true,
      });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, assertions, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    viewports: viewports.length,
    assertions,
    capturedScreenshots: captureDirectory ? viewports.length : 0,
  }),
);
