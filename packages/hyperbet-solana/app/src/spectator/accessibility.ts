export const SPECTATOR_BOTTOM_TABS = [
  "holders",
  "news",
  "trades",
  "orders",
  "topTraders",
  "positions",
] as const;

export type SpectatorBottomTab = (typeof SPECTATOR_BOTTOM_TABS)[number];

export const READ_ONLY_SPECTATOR_BOTTOM_TABS = [
  "holders",
  "news",
  "topTraders",
] as const satisfies readonly SpectatorBottomTab[];

export function getSpectatorBottomTabs(
  transactionsEnabled: boolean,
): readonly SpectatorBottomTab[] {
  return transactionsEnabled
    ? SPECTATOR_BOTTOM_TABS
    : READ_ONLY_SPECTATOR_BOTTOM_TABS;
}

export function shouldShowBetActionIcon(input: {
  transactionsEnabled: boolean;
  canPlaceBet: boolean;
}): boolean {
  return input.transactionsEnabled && input.canPlaceBet;
}

export function selectRovingTabFromKey<T extends string>(
  current: T,
  key: string,
  tabs: readonly T[],
): T | null {
  const currentIndex = tabs.indexOf(current);
  if (currentIndex < 0) return null;

  if (key === "Home") return tabs[0] ?? null;
  if (key === "End") return tabs[tabs.length - 1] ?? null;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;

  const delta = key === "ArrowRight" ? 1 : -1;
  const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
  return tabs[nextIndex] ?? null;
}

export function selectSpectatorTabFromKey(
  current: SpectatorBottomTab,
  key: string,
  tabs: readonly SpectatorBottomTab[] = SPECTATOR_BOTTOM_TABS,
): SpectatorBottomTab | null {
  return selectRovingTabFromKey(current, key, tabs);
}
