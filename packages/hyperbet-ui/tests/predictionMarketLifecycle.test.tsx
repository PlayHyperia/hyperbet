import "./setup";

import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { usePredictionMarketLifecycle } from "../src/lib/solanaPredictionMarkets";

const originalFetch = globalThis.fetch;
const MARKET_PUBLIC_KEY = "11111111111111111111111111111111";
const PROGRAM_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function payload(duelId: string, ageMs = 0) {
  const updatedAt = Date.now() - ageMs;
  return {
    duel: {
      duelKey: "ab".repeat(32),
      duelId,
      phase: "ANNOUNCEMENT",
      winner: "NONE",
      betCloseTime: updatedAt + 60_000,
      syncedAt: updatedAt,
    },
    markets: [
      {
        chainKey: "solana",
        marketType: "clob",
        duelKey: "ab".repeat(32),
        duelId,
        marketId: MARKET_PUBLIC_KEY,
        marketRef: MARKET_PUBLIC_KEY,
        lifecycleStatus: "OPEN",
        winner: "NONE",
        betCloseTime: updatedAt + 60_000,
        programId: PROGRAM_PUBLIC_KEY,
        syncedAt: updatedAt,
      },
    ],
    updatedAt,
  };
}

function LifecycleHarness({ pollIntervalMs = 60_000 }) {
  const lifecycle = usePredictionMarketLifecycle("solana", {
    pollIntervalMs,
  });
  return (
    <div>
      <span data-testid="duel-id">{lifecycle.market?.duelId ?? "none"}</span>
      <span data-testid="error">{lifecycle.error ?? "none"}</span>
      <button type="button" onClick={() => void lifecycle.refresh()}>
        Refresh
      </button>
    </div>
  );
}

async function waitForText(testId: string, expected: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (
      container?.querySelector(`[data-testid="${testId}"]`)?.textContent ===
      expected
    ) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  expect(
    container?.querySelector(`[data-testid="${testId}"]`)?.textContent,
  ).toBe(expected);
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

describe("active SOL lifecycle polling", () => {
  it("revokes retained lifecycle authority when a later response is stale", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      calls += 1;
      return Response.json(
        calls === 1 ? payload("duel-live") : payload("duel-replayed", 30_001),
      );
    }) as typeof fetch;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<LifecycleHarness />));
    await waitForText("duel-id", "duel-live");

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("button")?.click();
    });
    await waitForText("duel-id", "none");
    await waitForText("error", "prediction markets response was invalid");
  });

  it("never lets an older overlapping request overwrite newer authority", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    let calls = 0;
    globalThis.fetch = ((_input: RequestInfo | URL) => {
      calls += 1;
      return calls === 1 ? first : second;
    }) as typeof fetch;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<LifecycleHarness />));
    expect(calls).toBe(1);

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("button")?.click();
    });
    expect(calls).toBe(2);

    await act(async () => {
      resolveSecond(Response.json(payload("duel-new")));
      await second;
    });
    await waitForText("duel-id", "duel-new");

    await act(async () => {
      resolveFirst(Response.json(payload("duel-old")));
      await first;
    });
    await waitForText("duel-id", "duel-new");
  });
});
