import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

function readHexToken(name: string): string {
  const match = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`Missing color token --${name}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) {
    throw new Error(`Invalid six-digit hex color: ${hex}`);
  }
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Hyperbet accessibility styles", () => {
  test("keeps complete matchup identities responsive instead of imposing a fixed header cap", () => {
    const marketName =
      styles.match(/\.hm-market-name\s*\{([^}]*)\}/)?.[1] ?? "";
    const mobileMatchup =
      styles.match(/\.hm-mob-phase-strip-meta\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(marketName).toContain("max-width: none");
    expect(marketName).toContain("min-width: 0");
    expect(marketName).not.toContain("280px");
    expect(styles).toContain(".hm-header-left .hm-logo-text");
    expect(mobileMatchup).toContain("white-space: normal");
    expect(mobileMatchup).toContain("overflow-wrap: anywhere");
  });

  test("keeps keyboard focus visible across the spectator shell", () => {
    expect(styles).toContain(".hm-root *:focus-visible");
    expect(styles).toContain("outline: 2px solid var(--hm-accent-gold)");
    expect(styles).toContain("outline-offset: 2px");
  });

  test("provides a non-layout hidden label for native data tables", () => {
    const rule = styles.match(/\.hm-sr-only\s*\{([^}]*)\}/)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("width: 1px");
    expect(rule).toContain("height: 1px");
    expect(rule).toContain("clip: rect(0, 0, 0, 0)");
    expect(rule).toContain("white-space: nowrap");
  });

  test("suppresses nonessential motion when reduced motion is requested", () => {
    const reducedMotionStart = styles.indexOf(
      "@media (prefers-reduced-motion: reduce)",
    );
    expect(reducedMotionStart).toBeGreaterThan(-1);
    const reducedMotionStyles = styles.slice(reducedMotionStart);
    expect(reducedMotionStyles).toContain(".hm-root *::before");
    expect(reducedMotionStyles).toContain(
      "animation-duration: 0.001ms !important",
    );
    expect(reducedMotionStyles).toContain(
      "animation-iteration-count: 1 !important",
    );
    expect(reducedMotionStyles).toContain(
      "transition-duration: 0.001ms !important",
    );
  });

  test("keeps core text and state colors at WCAG AA contrast", () => {
    const pairs = [
      ["hm-text", "hm-bg"],
      ["hm-text-dim", "hm-bg"],
      ["hm-text-muted", "hm-bg"],
      ["hm-text", "hm-surface"],
      ["hm-text-dim", "hm-surface"],
      ["hm-text-muted", "hm-surface"],
      ["hm-text-muted", "hm-surface-raised"],
      ["hm-accent-gold", "hm-bg"],
      ["hm-accent-green", "hm-surface"],
      ["hm-accent-red", "hm-surface"],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(
        contrastRatio(readHexToken(foreground), readHexToken(background)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("keeps the mobile match drawer close action touch-sized", () => {
    const closeRule = styles.match(/\.hm-sidebar-close\s*\{([^}]*)\}/)?.[1];
    expect(closeRule).toBeDefined();
    expect(closeRule).toContain("min-width: 44px");
    expect(closeRule).toContain("height: 44px");
    expect(closeRule).toContain("padding: 0 10px");
    expect(styles).toContain(
      "bottom: calc(20px + env(safe-area-inset-bottom))",
    );
  });

  test("does not shrink primary phone navigation below a 44px touch target", () => {
    const iconRule = styles.match(
      /\.hm-header-mob-icon-btn\s*\{([^}]*)\}/,
    )?.[1];
    const walletRule = styles.match(
      /\.hm-header-mob-wallet-btn\s*\{([^}]*)\}/,
    )?.[1];
    const phoneStart = styles.indexOf("@media (max-width: 480px)");
    const phoneStyles = styles.slice(phoneStart);

    expect(iconRule).toContain("min-height: 44px");
    expect(iconRule).toContain("height: 44px");
    expect(walletRule).toContain("min-height: 44px");
    expect(walletRule).toContain("height: 44px");
    expect(phoneStyles).toContain(".hm-header-mob-row1");
    expect(phoneStyles).toContain("height: 52px");
    expect(phoneStyles).not.toMatch(
      /\.hm-header-mob-(?:icon|wallet)-btn\s*\{[^}]*height:\s*28px/s,
    );
    expect(phoneStyles).not.toMatch(
      /\.hm-bottom-tab\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(phoneStyles).toMatch(/\.hm-bottom-tab\s*\{[^}]*min-height:\s*44px/s);
  });

  test("keeps the leaderboard modal viewport-bound, scrollable, and touch-sized", () => {
    const overlayRule = styles.match(
      /\.hm-points-drawer-overlay\s*\{([^}]*)\}/,
    )?.[1];
    const dialogRule = styles.match(
      /\.hm-points-drawer-dialog\s*\{([^}]*)\}/,
    )?.[1];
    const closeRule = styles.match(
      /\.hm-points-drawer-close\s*\{([^}]*)\}/,
    )?.[1];
    expect(overlayRule).toContain("position: fixed");
    expect(overlayRule).toContain("inset: 0");
    expect(dialogRule).toContain("max-height: calc(100dvh - 32px)");
    expect(dialogRule).toContain("overflow-x: hidden");
    expect(dialogRule).toContain("overflow-y: auto");
    expect(dialogRule).toContain("overscroll-behavior: contain");
    expect(closeRule).toContain("min-width: 56px");
    expect(closeRule).toContain("min-height: 44px");
    expect(closeRule).toContain("height: 44px");
  });

  test("keeps complete agent details reachable and stacks cards on phones", () => {
    const cardRule = styles.match(/\.hm-agent-card\s*\{([^}]*)\}/)?.[1];
    expect(cardRule).toBeDefined();
    expect(cardRule).toContain("overflow-y: auto");

    const agentSectionStart = styles.indexOf(
      "/* ── Agents tab: mobile compact ── */",
    );
    const matchLogSectionStart = styles.indexOf(
      "/* ================================================================\n   MATCH LOG",
      agentSectionStart,
    );
    expect(agentSectionStart).toBeGreaterThan(-1);
    expect(matchLogSectionStart).toBeGreaterThan(agentSectionStart);
    const agentResponsiveStyles = styles.slice(
      agentSectionStart,
      matchLogSectionStart,
    );
    expect(agentResponsiveStyles).toContain(
      "grid-template-columns: minmax(0, 1fr)",
    );
    expect(agentResponsiveStyles).toContain(".hm-agent-meta");
    expect(agentResponsiveStyles).toContain("display: block");
    expect(agentResponsiveStyles).toContain("flex-wrap: wrap");
    expect(agentResponsiveStyles).toContain("overflow-x: visible");
  });
});
