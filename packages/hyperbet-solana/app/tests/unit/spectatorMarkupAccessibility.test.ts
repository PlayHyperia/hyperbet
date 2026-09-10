import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const appSource = readFileSync(
  new URL("../../src/App.tsx", import.meta.url),
  "utf8",
);

describe("spectator markup accessibility policy", () => {
  test("keeps the exact matchup identity available in desktop and mobile presentation", () => {
    expect(appSource.match(/title=\{matchupLabel\}/gu)).toHaveLength(2);
    expect(
      appSource.match(/aria-label=\{`Current matchup: \$\{matchupLabel\}`\}/gu),
    ).toHaveLength(2);
  });

  test("keeps static data tables native and explicitly named", () => {
    expect(appSource).not.toContain('role="grid"');
    expect(appSource.match(/<caption className="hm-sr-only">/gu)).toHaveLength(
      3,
    );
  });

  test("keeps the points modes connected by one semantic tab contract", () => {
    expect(appSource).toContain('role="tablist"');
    expect(appSource).toContain('role="tab"');
    expect(appSource).toContain('role="tabpanel"');
    expect(appSource).toContain("aria-selected={isActive}");
    expect(appSource).toContain("handlePointsDrawerTabKeyDown(event, tab.key)");
    expect(appSource).not.toContain('maxHeight: "calc(100vh - 320px)"');
  });

  test("labels an idle match log instead of presenting an unexplained void", () => {
    expect(appSource).toContain("const hasSpectatorLogDetail =");
    expect(appSource).toContain("spectatorActionFeed.length > 0");
    expect(appSource).toContain("!hasSpectatorLogDetail && (");
    expect(appSource).toContain('className="hm-match-log-empty"');
    expect(appSource).toContain('role="status"');
    expect(appSource).toContain("Waiting for verified activity");
    expect(appSource).toContain(
      "Verified preparation and combat decisions appear here",
    );
  });
});
